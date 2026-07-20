import { readFile } from "node:fs/promises";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");
const [meta, index, diff, ocg] = await Promise.all([
  readJson(join(dataDir, "snapshot-meta.json"), {}), readJson(join(dataDir, "evidence-index.json"), { records: [] }), readJson(join(dataDir, "ruling-diff-report.json"), {}), readJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
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
  aliasWarningCount: Number(meta.aliasWarningCount || meta.aliasWarnings?.length || 0),
  parseFailedCount: records.filter((item) => item.status === "parse_failed").length + Number(meta.parseFailedCount || 0),
  dataQualityWarningCount: Number(meta.dataQualityWarningCount || meta.dataQualityWarnings?.length || 0),
  newItems: diff.newItems || 0,
  changedItems: diff.changedItems || 0,
  removedItems: diff.removedItems || 0,
  ocgRuleGeneratedAt: ocg.generatedAt || null,
  ocgRuleStatus: ocg.sync?.status || "unknown",
  ocgRuleRecordCount: ocg.records?.length || 0,
  ocgRuleDeclaredCount: Number(ocg.sync?.recordCount || 0),
  ocgRuleFailedCount: Number(ocg.sync?.failedCount || 0),
  ocgRuleSuccessRatio: Number(ocg.sync?.successRatio || 0),
  ocgRuleContentHash: ocg.sync?.contentHash || null,
}, null, 2));

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
