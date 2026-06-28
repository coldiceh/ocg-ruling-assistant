import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffRulingSnapshot, normalizeEvidenceRecord } from "../backend/rulingDiffState.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const meta = await readJson(join(dataDir, "snapshot-meta.json"), {});
const rulings = await readJson(join(dataDir, "rulings.json"), { records: [] });
const rules = await readJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] });
const previous = await readJson(join(dataDir, "evidence-index.json"), { records: [] });
const now = new Date().toISOString();
const raw = [...(rulings.records || []), ...(rules.records || []).filter((item) => item.recordType === "rule-doc")];
const current = raw.map((item) => normalizeEvidenceRecord({
  ...item,
  stableId: item.id,
  status: hasEvidenceText(item) ? "current" : "parse_failed",
  sourceId: item.recordType === "rule-doc" ? "ocg-rule" : "ygoresources",
  sourceRevision: meta.sourceRevision || "",
}, { now, sourceRevision: meta.sourceRevision || "" }));
const result = diffRulingSnapshot({
  previousEvidence: previous.records || [], currentEvidence: current,
  sourceRevision: meta.sourceRevision || "", now,
  syncSucceeded: meta.sourceFreshness !== "unknown",
});
const report = { ...result.report, sourceFreshness: meta.sourceFreshness || result.report.sourceFreshness };
await writeCompactJson(join(dataDir, "evidence-index.json"), { schemaVersion: 1, generatedAt: now, sourceRevision: meta.sourceRevision || "", records: result.records });
await writeCompactJson(join(dataDir, "ruling-sync-state.json"), {
  schemaVersion: 1,
  ...report,
  versions: result.records.map(({ evidenceId, stableId, status, textHash, sourceRevision, firstSeenAt, lastSeenAt, fetchedAt }) => ({ evidenceId, stableId, status, textHash, sourceRevision, firstSeenAt, lastSeenAt, fetchedAt })),
});
await writeJson(join(dataDir, "ruling-diff-report.json"), { schemaVersion: 1, ...report });
await writeJson(join(dataDir, "snapshot-meta.json"), {
  ...meta,
  previousSourceRevision: meta.previousSourceRevision ?? null,
  sourceFreshness: report.sourceFreshness,
  lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt || meta.generatedAt || now,
  lastFailedSyncAt: meta.lastFailedSyncAt || null,
  syncFailureCount: Number(meta.syncFailureCount || 0),
  newItems: result.report.newItems,
  changedItems: result.report.changedItems,
  removedItems: result.report.removedItems,
});
console.log(JSON.stringify(report, null, 2));

function hasEvidenceText(item) { return Boolean(item.text || item.conclusion || item.answer); }
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function writeCompactJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value)}\n`, "utf8"); }
