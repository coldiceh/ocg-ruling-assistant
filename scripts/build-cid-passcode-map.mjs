#!/usr/bin/env node
// Rebuild data/engine-repro/cid-passcode-map.json (CID -> passcode for the engine reproduction) against
// an engine build's card pool. Rules: scripts/lib/cid-passcode-map.mjs. Run it after the deployed engine's
// card pool changes (ocg-sim-core build/versions.json) or when data/cards.json gains cards.
//
//   curl -fsSL -o cards.zip https://ygocdb.com/api/v0/cards.zip && unzip -o cards.zip cards.json -d ygocdb
//   (yaml-yugi: cards.json of DawnbrandBots/yaml-yugi branch aggregate)
//   node scripts/build-cid-passcode-map.mjs --ygocdb ygocdb/cards.json --yaml-yugi yaml-yugi/cards.json \
//        --engine-out PATH_TO_OCG_SIM_CORE/build/out [--ygocdb-fetched YYYY-MM-DD] [--yaml-yugi-commit SHA]
//
// --engine-out is the engine build output (db/cards.cdb and manifest.json). Reads data/cards.json.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { buildCidPasscodeMap } from "./lib/cid-passcode-map.mjs";

const HERE = resolve(new URL(".", import.meta.url).pathname, "..");
const { values: args } = parseArgs({ options: {
  ygocdb: { type: "string" }, "yaml-yugi": { type: "string" }, "engine-out": { type: "string" },
  "ygocdb-fetched": { type: "string", default: new Date().toISOString().slice(0, 10) },
  "yaml-yugi-commit": { type: "string", default: "420833b8f5b5d0903f457213a566447f79b4ae10" },
  cards: { type: "string", default: join(HERE, "data", "cards.json") },
  out: { type: "string", default: join(HERE, "data", "engine-repro", "cid-passcode-map.json") },
} });
for (const name of ["ygocdb", "yaml-yugi", "engine-out"]) {
  if (!args[name]) throw new Error(`--${name} is required`);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const ygocdbRaw = readFileSync(args.ygocdb);
const yamlRaw = readFileSync(args["yaml-yugi"]);
const cards = JSON.parse(readFileSync(args.cards, "utf8"));
const records = Array.isArray(cards) ? cards : cards.records;

const db = new DatabaseSync(join(args["engine-out"], "db", "cards.cdb"), { readOnly: true });
const engineCards = new Map(db.prepare(`select d.id as code, d.alias as alias, t.name as name, d.type as type, d.atk as atk,
    d.def as def, d.level as level, d.race as race, d.attribute as attribute from datas d join texts t on t.id = d.id`)
  .all().map((row) => [Number(row.code), { alias: Number(row.alias) || 0, name: row.name,
    data: Object.fromEntries(["type", "atk", "def", "level", "race", "attribute"].map((key) => [key, Number(row[key])])) }]));
db.close();
const manifest = JSON.parse(readFileSync(join(args["engine-out"], "manifest.json"), "utf8"));
const pins = ["core", "scripts", "scripts_888", "prerelease", "database"].filter((key) => manifest[key])
  .map((key) => `${key} ${manifest[key].slice(0, 7)}`).join(" ");

const built = buildCidPasscodeMap({ cids: records.map((r) => r.id), ygocdb: JSON.parse(ygocdbRaw),
  yamlYugi: JSON.parse(yamlRaw), engineCards });
const out = {
  schema: "ocg-repro-cid-passcode/v1",
  sources: {
    ygocdb: { url: "https://ygocdb.com/api/v0/cards.zip", fetched: args["ygocdb-fetched"], cards_json_sha256: sha256(ygocdbRaw) },
    yaml_yugi: { repo: "DawnbrandBots/yaml-yugi", commit: args["yaml-yugi-commit"], file: "cards.json", sha256: sha256(yamlRaw) },
  },
  checked_against: `ocg-sim-core card pool (${pins})`,
  counts: built.counts,
  unmapped: built.unmapped,
  by_name: built.by_name,
  map: built.map,
};
// same layout as the first version of the file (Python json.dumps defaults: one line, ", " and ": ")
const pyJson = (v) => (Array.isArray(v) ? `[${v.map(pyJson).join(", ")}]`
  : v && typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(", ")}}`
    : JSON.stringify(v));
writeFileSync(args.out, pyJson(out));
console.log(JSON.stringify({ out: args.out, checked_against: out.checked_against, counts: out.counts }, null, 1));
