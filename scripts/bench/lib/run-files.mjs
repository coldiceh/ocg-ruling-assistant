// File layout of one comparison run directory:
//   manifest.json            configuration, env snapshots, code/data versions, sessions
//   checkpoint.json          job states, cumulative cost, stop reason (rewritten atomically)
//   ledger.jsonl             every budget-ledger reservation/settlement (append-only)
//   network-unattributed.jsonl  requests made outside a job (asset preload etc.)
//   results/<job>.json       one file per question × arm × repeat
//   results/<job>.events.json   raw evidence-generation requests/responses of that job
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const RESULT_SCHEMA_VERSION = 1;

export function jobKey({ qid, arm, repeat }) {
  return `${qid}__${arm}__r${repeat}`;
}

export function resultPath(runDir, key) {
  return path.join(runDir, "results", `${key}.json`);
}

export function eventsPath(runDir, key) {
  return path.join(runDir, "results", `${key}.events.json`);
}

let temporarySequence = 0;

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  temporarySequence += 1;
  const temporary = `${file}.${process.pid}.${temporarySequence}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readJsonIfExists(file) {
  return existsSync(file) ? readJson(file) : null;
}

export async function loadRun(runDir) {
  const manifest = await readJson(path.join(runDir, "manifest.json"));
  const checkpoint = await readJsonIfExists(path.join(runDir, "checkpoint.json"));
  const resultsDir = path.join(runDir, "results");
  const results = [];
  if (existsSync(resultsDir)) {
    const names = (await readdir(resultsDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".events.json"))
      .sort();
    for (const name of names) results.push(await readJson(path.join(resultsDir, name)));
  }
  return { manifest, checkpoint, results };
}
