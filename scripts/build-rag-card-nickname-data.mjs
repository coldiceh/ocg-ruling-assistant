import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCardNicknameData, deriveCardNicknameBridges, validateCardNicknameData } from "./lib/ragCardNicknameData.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "data/card-nickname-sources");
const outputPath = resolve(root, "data/card-nicknames.v1.json");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
const allowed = new Set(["--check", "--private-report", "--baige-json"]);
for (let index = 0; index < args.length; index += 1) {
  if (!allowed.has(args[index])) throw new Error(`Unknown argument: ${args[index]}`);
  if (args[index] !== "--check") {
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value: ${args[index]}`);
    index += 1;
  }
}
const valueFor = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const cards = (await readJson(resolve(root, "data/cards.json"))).records;
const manifest = await readJson(resolve(dataDir, "sources.v1.json"));
const source = manifest.sources.find((entry) => entry.id === manifest.nicknameSourceId);
const nicknameBytes = await readFile(resolve(dataDir, "ocgbot-dcc1a184.nickname.json"));
if (sha256(nicknameBytes) !== source.sha256) throw new Error("Pinned nickname input hash mismatch");
for (const entry of manifest.sources) {
  const notice = await readFile(resolve(root, entry.licenseFile), "utf8");
  if (entry.license === "MIT" && !(notice.includes("MIT License") && notice.includes("Copyright") && notice.includes("Permission is hereby granted"))) {
    throw new Error(`Missing MIT attribution: ${entry.id}`);
  }
  if (!notice.trim()) throw new Error(`Empty source notice: ${entry.id}`);
}
const nicknameRecords = JSON.parse(nicknameBytes.toString("utf8"));
const frozenBridges = await readJson(resolve(dataDir, "identity-bridges.v1.json"));
const curated = await readJson(resolve(dataDir, "curated.v1.json"));
if (frozenBridges.schemaVersion !== 1 || curated.schemaVersion !== 1) throw new Error("Unsupported build-input schema");
const bridgeSource = manifest.sources.find((entry) => entry.id === frozenBridges.sourceId);
if (!bridgeSource || frozenBridges.sourceSha256 !== bridgeSource.sha256) throw new Error("Identity bridge source hash mismatch");
if (valueFor("--baige-json")) {
  const baigeBytes = await readFile(resolve(valueFor("--baige-json")));
  if (sha256(baigeBytes) !== bridgeSource.sha256) throw new Error("Pinned Baige input hash mismatch");
  const entries = deriveCardNicknameBridges({ cards, nicknameRecords, baigeRecords: Object.values(JSON.parse(baigeBytes.toString("utf8"))), sourceId: frozenBridges.sourceId });
  if (JSON.stringify(entries) !== JSON.stringify(frozenBridges.entries)) throw new Error("Frozen identity bridges differ from pinned Baige source");
}
const { data, report } = buildCardNicknameData({ cards, nicknameRecords, bridges: frozenBridges.entries,
  curatedEntries: curated.entries, sources: manifest.sources, nicknameSourceId: manifest.nicknameSourceId });
const serialized = `${JSON.stringify(data, null, 2)}\n`;
if (args.includes("--check")) {
  const existing = await readFile(outputPath, "utf8");
  validateCardNicknameData(JSON.parse(existing), cards);
  if (existing !== serialized) throw new Error("Nickname data is stale; rebuild it");
} else {
  await writeFile(outputPath, serialized, "utf8");
}
if (valueFor("--private-report")) {
  const path = resolve(valueFor("--private-report"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ status: args.includes("--check") ? "verified" : "built", revision: data.revision,
  ...report.counts, entryCount: report.entryCount, distinctAliasCount: report.distinctAliasCount, distinctCardCount: report.distinctCardCount }));
