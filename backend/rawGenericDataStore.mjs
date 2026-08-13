import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeOfficialResponses } from "./officialResponses.mjs";
import {
  bindTrustedRagDataRevision,
  createRagDataSourceDescriptor,
  RAG_DATA_REVISION_MANIFEST_FILE,
  validateRagDataRevisionManifest,
} from "./ragDataRevisionManifest.mjs";
import { isRagRuntimeBundleRequired, RagDataUnavailableError } from "./ragDataAvailability.mjs";
import { normalizeRagSourceData } from "./ragRawDataNormalizer.mjs";
import { loadRawGenericRuntimeBundle } from "./rawGenericRuntimeBundle.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const dataCache = new Map();
const trustedSyncedRecordProvenance = new WeakMap();

const TRUSTED_RUNTIME_BUNDLE_PROVENANCE = "verified_runtime_bundle";
const TRUSTED_RAW_SYNC_PROVENANCE = "validated_synced_json";

/**
 * Data-only loader for the public raw-generic path.
 *
 * This module intentionally has no dependency on the legacy evidence retriever,
 * card extractor, question-type classifiers or ruling reasoners. The production
 * bundle remains useful as a byte-verified storage format; raw JSON is a local
 * development fallback only.
 */
export async function loadRawGenericData(dataDir = defaultDataDir, {
  requireRuntimeBundle = isRagRuntimeBundleRequired(),
} = {}) {
  const key = `${requireRuntimeBundle ? "bundle-required" : "raw-fallback-allowed"}:${dataDir}`;
  if (dataCache.has(key)) return await dataCache.get(key);
  const pending = (async () => {
    const runtimeBundle = await loadRawGenericRuntimeBundle({ dataDir });
    if (runtimeBundle.ok) {
      return markTrustedSyncedSnapshot(
        runtimeBundle.data,
        TRUSTED_RUNTIME_BUNDLE_PROVENANCE,
      );
    }
    if (requireRuntimeBundle) {
      throw unavailableDataError("runtime_bundle_required", {
        bundleReason: runtimeBundle.reason,
        bundleReasons: runtimeBundle.reasons,
      });
    }
    return await loadRawJsonSnapshot(dataDir);
  })();
  dataCache.set(key, pending);
  try {
    const data = await pending;
    dataCache.set(key, data);
    return data;
  } catch (error) {
    if (dataCache.get(key) === pending) dataCache.delete(key);
    throw error;
  }
}

/**
 * Build/check-only entry point. It is deliberately unable to consult an
 * existing runtime bundle, so generated artifacts can never certify
 * themselves after one of the synchronized JSON sources changes.
 */
export async function loadRawGenericSourceData(dataDir = defaultDataDir) {
  return await loadRawJsonSnapshot(dataDir, { requireExistingManifest: false });
}

export { normalizeRagSourceData as normalizeRawGenericInjectedData };

/**
 * The verified runtime bundle already contains the canonical normalized
 * snapshot. This identity-preserving wrapper avoids rebuilding ~125k records
 * on every production request while keeping the public pipeline independent
 * from the legacy retriever.
 */
export function useRawGenericDataSnapshot(data = {}) {
  if (!data || typeof data !== "object") {
    return normalizeRagSourceData();
  }
  return {
    cards: Array.isArray(data.cards) ? data.cards : [],
    records: Array.isArray(data.records) ? data.records : [],
    qaRecords: Array.isArray(data.qaRecords) ? data.qaRecords : [],
  };
}

/**
 * An in-memory trust label for records loaded from verified synchronized data.
 * It is intentionally not a serializable field, so injected records cannot
 * manufacture provenance by setting `official`, `sourceTier` or `provenance`.
 */
export function getTrustedRawGenericRecordProvenance(record) {
  if (!record || typeof record !== "object") return "";
  return trustedSyncedRecordProvenance.get(record) || "";
}

/** Propagate verified source provenance to a derived retrieval record. */
export function inheritTrustedRawGenericRecordProvenance(sourceRecord, derivedRecord) {
  if (!derivedRecord || typeof derivedRecord !== "object") return derivedRecord;
  const provenance = getTrustedRawGenericRecordProvenance(sourceRecord);
  if (provenance) trustedSyncedRecordProvenance.set(derivedRecord, provenance);
  return derivedRecord;
}

async function loadRawJsonSnapshot(dataDir, { requireExistingManifest = true } = {}) {
  const fileSpecs = [
    ["cards.json", ["records", "cards"]],
    ["rulings.json", ["records"]],
    ["qa-index.json", ["records"]],
    ["evidence-index.json", ["records"]],
    ["ocg-rule-corpus.json", ["records"]],
    ["official-responses.json", ["records", "officialResponses"]],
  ];
  const sources = await Promise.all(fileSpecs.map(([name, keys]) => readRequiredJsonSource(dataDir, name, keys)));
  const [cardsSource, rulingsSource, qaSource, evidenceSource, rulebookSource, officialResponsesSource] = sources;
  const manifest = requireExistingManifest
    ? await readJson(join(dataDir, RAG_DATA_REVISION_MANIFEST_FILE), null)
    : null;
  const bundledRulebookRecords = rulebookSource.payload.records || [];
  const hasBundledRulebook = bundledRulebookRecords.length > 0;
  const evidenceRecords = (evidenceSource.payload.records || []).filter((record) => (
    !hasBundledRulebook
      || (record.sourceId !== "ocg-rule" && !rawRecordIdentity(record).startsWith("ocg-rule:"))
  ));
  const data = normalizeRagSourceData({
    cards: cardsSource.payload.records || cardsSource.payload.cards || [],
    records: [
      ...(rulingsSource.payload.records || []),
      ...bundledRulebookRecords,
      ...evidenceRecords,
      ...normalizeOfficialResponses(officialResponsesSource.payload),
    ],
    qaRecords: qaSource.payload.records || [],
  });
  if (!data.cards.length || !(data.records.length + data.qaRecords.length)) {
    throw unavailableDataError("raw_corpus_empty", {
      cards: data.cards.length,
      evidenceRecords: data.records.length + data.qaRecords.length,
    });
  }
  if (requireExistingManifest) {
    const validation = validateRagDataRevisionManifest(manifest, {
      data,
      sources: sources.map((source) => source.descriptor),
      // Runtime fallback and the offline compiler now share one neutral,
      // legacy-compatible normalizer. Source hashes are sufficient on this hot
      // path; the compiler/check command performs the full canonical check.
      verifyCanonicalCorpus: false,
    });
    if (!validation.ok) {
        throw unavailableDataError("raw_manifest_invalid", { reasons: validation.reasons });
    }
    bindTrustedRagDataRevision(data, validation);
  }
  return markTrustedSyncedSnapshot(data, TRUSTED_RAW_SYNC_PROVENANCE);
}

function markTrustedSyncedSnapshot(data, provenance) {
  for (const record of [
    ...(Array.isArray(data?.records) ? data.records : []),
    ...(Array.isArray(data?.qaRecords) ? data.qaRecords : []),
  ]) {
    if (record && typeof record === "object") {
      trustedSyncedRecordProvenance.set(record, provenance);
    }
  }
  return data;
}

async function readRequiredJsonSource(dataDir, name, arrayKeys) {
  const path = join(dataDir, name);
  let raw;
  try {
    raw = await readFile(path);
  } catch (error) {
    throw unavailableDataError("source_read_failed", { source: name, cause: error?.code || "read_failed" });
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw unavailableDataError("source_json_invalid", { source: name });
  }
  if (!payload || typeof payload !== "object" || !arrayKeys.some((key) => Array.isArray(payload[key]))) {
    throw unavailableDataError("source_shape_invalid", { source: name });
  }
  return { payload, descriptor: createRagDataSourceDescriptor(name, raw) };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function rawRecordIdentity(record = {}) {
  return String(record.stableId || record.sourceRecordId || record.id || record.evidenceId || "")
    .replace(/@[a-f0-9]{8,}$/iu, "");
}

function unavailableDataError(reason, details = {}) {
  return new RagDataUnavailableError({
    details: {
      phase: "raw_generic_data",
      reason,
      ...details,
    },
  });
}
