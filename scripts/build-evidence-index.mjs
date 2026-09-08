import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOptionalRagDataSourceJson, writeEvidenceIndexJson } from "../backend/ragDataSourceFile.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const state = await readJson(join(dataDir, "ruling-sync-state.json"), {});
const index = await readOptionalRagDataSourceJson(dataDir, "evidence-index.json", { records: [] });
const records = (index.records || []).filter((item) => item.stableId && item.textHash);
await writeEvidenceIndexJson(dataDir, { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceRevision: state.sourceRevision || index.sourceRevision || "", records });
const counts = Object.fromEntries(["current", "superseded", "removed", "parse_failed", "conflict"].map((status) => [status, records.filter((item) => item.status === status).length]));
console.log(JSON.stringify({ total: records.length, ...counts }, null, 2));

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
