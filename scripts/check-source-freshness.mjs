import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashOcgRuleRecords } from "./sync-ocg-rule.mjs";

export function checkSourceFreshness({
  snapshotMeta = {},
  ocgCorpus = {},
  evidenceIndex = {},
  now = Date.now(),
  maxAgeHours = 36,
} = {}) {
  const errors = [];
  const ygoAt = parseTimestamp(snapshotMeta.lastSuccessfulSyncAt || snapshotMeta.generatedAt);
  const ocgAt = parseTimestamp(ocgCorpus.generatedAt);
  const evidenceAt = parseTimestamp(evidenceIndex.generatedAt);
  const ocgRecords = Array.isArray(ocgCorpus.records) ? ocgCorpus.records : [];
  const evidenceRecords = Array.isArray(evidenceIndex.records) ? evidenceIndex.records : [];
  const declaredOcgCount = Number(ocgCorpus.sync?.recordCount);
  const actualOcgHash = hashOcgRuleRecords(ocgRecords);

  if (snapshotMeta.sourceFreshness !== "fresh") errors.push("ygoresources_source_not_fresh");
  validateAge("ygoresources", ygoAt, now, maxAgeHours, errors);
  if (ocgCorpus.sync?.status !== "complete") errors.push("ocg_rule_sync_not_complete");
  validateAge("ocg_rule", ocgAt, now, maxAgeHours, errors);
  if (!Number.isFinite(declaredOcgCount) || declaredOcgCount !== ocgRecords.length) errors.push("ocg_rule_record_count_mismatch");
  if (!ocgCorpus.sync?.contentHash || ocgCorpus.sync.contentHash !== actualOcgHash) errors.push("ocg_rule_content_hash_mismatch");
  if (!evidenceRecords.length) errors.push("evidence_index_empty");
  if (!evidenceAt) errors.push("evidence_index_timestamp_invalid");
  const newestSourceAt = Math.max(ygoAt || 0, ocgAt || 0);
  if (evidenceAt && newestSourceAt && evidenceAt < newestSourceAt) errors.push("evidence_index_older_than_source");

  return {
    ok: errors.length === 0,
    errors,
    diagnostics: {
      maxAgeHours,
      ygoresourcesAt: formatTimestamp(ygoAt),
      ocgRuleAt: formatTimestamp(ocgAt),
      evidenceIndexAt: formatTimestamp(evidenceAt),
      ocgRuleRecordCount: ocgRecords.length,
      ocgRuleContentHash: actualOcgHash,
      evidenceCount: evidenceRecords.length,
    },
  };
}

function validateAge(label, timestamp, now, maxAgeHours, errors) {
  if (!timestamp) { errors.push(`${label}_timestamp_invalid`); return; }
  const ageHours = (Number(now) - timestamp) / 3_600_000;
  if (ageHours < -1) errors.push(`${label}_timestamp_in_future`);
  if (ageHours > maxAgeHours) errors.push(`${label}_stale:${ageHours.toFixed(1)}h`);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatTimestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

async function main() {
  const dataDir = join(process.cwd(), "data");
  const [snapshotMeta, ocgCorpus, evidenceIndex] = await Promise.all([
    readJson(join(dataDir, "snapshot-meta.json")),
    readJson(join(dataDir, "ocg-rule-corpus.json")),
    readJson(join(dataDir, "evidence-index.json")),
  ]);
  const maxAgeHours = Number(process.env.SOURCE_MAX_AGE_HOURS || 36);
  const result = checkSourceFreshness({ snapshotMeta, ocgCorpus, evidenceIndex, maxAgeHours });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) throw new Error(`Source freshness check failed: ${result.errors.join(", ")}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
