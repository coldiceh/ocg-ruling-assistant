import { readFile } from "node:fs/promises";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");
const [meta, index, diff] = await Promise.all([
  readJson(join(dataDir, "snapshot-meta.json"), {}), readJson(join(dataDir, "evidence-index.json"), { records: [] }), readJson(join(dataDir, "ruling-diff-report.json"), {}),
]);
const records = index.records || [];
console.log(JSON.stringify({
  generatedAt: meta.generatedAt || null,
  sourceRevision: meta.sourceRevision || null,
  sourceFreshness: meta.sourceFreshness || "unknown",
  lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt || null,
  lastFailedSyncAt: meta.lastFailedSyncAt || null,
  syncFailureCount: Number(meta.syncFailureCount || 0),
  evidenceCount: records.length,
  currentCount: records.filter((item) => item.status === "current").length,
  conflictCount: records.filter((item) => item.status === "conflict").length,
  staleSourceCount: meta.sourceFreshness === "fresh" ? 0 : 1,
  newItems: diff.newItems || 0,
  changedItems: diff.changedItems || 0,
  removedItems: diff.removedItems || 0,
}, null, 2));

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
