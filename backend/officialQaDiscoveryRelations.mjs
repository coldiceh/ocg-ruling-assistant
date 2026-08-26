import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { projectOfficialQaQuestion } from "./officialQaQuestionProjection.mjs";
import { getTrustedRagDataRevision } from "./ragDataRevisionManifest.mjs";

const discoveryCardIdsByRecord = new WeakMap();
const discoveryStatusByData = new WeakMap();
const unavailableStatus = Object.freeze({
  available: false,
  reason: "discovery_relations_not_bound",
  sourceRevision: "",
  trustedDataRevision: "",
  boundQaCount: 0,
  boundRelationCount: 0,
  missingBodyCount: 0,
  missingBodyQaIds: Object.freeze([]),
  staleBodyCount: 0,
  staleBodyQaIds: Object.freeze([]),
  retiredBodyCount: 0,
  retiredBodyQaIds: Object.freeze([]),
});
const blockedStatuses = new Set(["removed", "superseded", "conflict", "parse_failed"]);

/**
 * Bind card-to-Q&A discovery relations without mutating the authenticated RAG
 * bundle. These relations are deliberately weak: callers may use them only to
 * recall and rank related official Q&A records, never to establish the card
 * identities stated by an official question.
 */
export async function bindOfficialQaDiscoveryRelations({
  dataDir,
  data,
  requireTrustedData = false,
} = {}) {
  if (!data || typeof data !== "object") return unavailableStatus;
  const allRecords = [...(data.records || []), ...(data.qaRecords || [])];
  for (const record of allRecords) {
    if (record && typeof record === "object") discoveryCardIdsByRecord.delete(record);
  }

  const resolvedDataDir = String(dataDir || "").trim();
  if (!resolvedDataDir) {
    return bindStatus(data, {
      available: false,
      reason: "qa_discovery_data_directory_missing",
    });
  }
  const trustedDataRevision = getTrustedRagDataRevision(data);
  if (requireTrustedData && !trustedDataRevision) {
    return bindStatus(data, {
      available: false,
      reason: "qa_discovery_rag_data_revision_untrusted",
    });
  }

  const [discoveryResult, metadataResult] = await Promise.all([
    readJson(join(resolvedDataDir, "qa-discovery-index.json")),
    readJson(join(resolvedDataDir, "snapshot-meta.json")),
  ]);
  if (!discoveryResult.ok || !metadataResult.ok) {
    return bindStatus(data, {
      available: false,
      reason: !discoveryResult.ok
        ? "qa_discovery_index_unavailable"
        : "snapshot_metadata_unavailable",
    });
  }

  const discovery = discoveryResult.value;
  const metadata = metadataResult.value;
  const discoveryRevision = String(discovery?.sourceRevision || "");
  const metadataRevision = String(metadata?.sourceRevision || "");
  const discoveryGeneratedAt = String(discovery?.generatedAt || "");
  const metadataGeneratedAt = String(metadata?.generatedAt || "");
  const discoveryQaCount = Number(discovery?.qaCount);
  const metadataQaCount = Number(metadata?.qaDiscoveryQaCount);
  const discoveryCardCount = Number(discovery?.cardCount);
  const metadataCardCount = Number(metadata?.qaDiscoveryCardCount);
  const hasStaleState = Object.prototype.hasOwnProperty.call(metadata || {}, "qaDetailStaleIds");
  const hasRetiredState = Object.prototype.hasOwnProperty.call(metadata || {}, "retiredQaIds");
  const stateArraysAreValid = (!hasStaleState && !hasRetiredState)
    || (
      hasStaleState
      && hasRetiredState
      && isValidNumericIdArray(metadata.qaDetailStaleIds)
      && isValidNumericIdArray(metadata.retiredQaIds)
    );
  const staleQaIds = new Set(
    (Array.isArray(metadata?.qaDetailStaleIds) ? metadata.qaDetailStaleIds : [])
      .map(normalizeNumericId)
      .filter(Boolean),
  );
  const retiredQaIds = new Set(
    (Array.isArray(metadata?.retiredQaIds) ? metadata.retiredQaIds : [])
      .map(normalizeNumericId)
      .filter(Boolean),
  );
  const discoverySummary = summarizeDiscoveryRecords(discovery?.records);
  const stateSetsAreDisjoint = [...staleQaIds].every((qaId) => !retiredQaIds.has(qaId));
  if (
    Number(discovery?.schemaVersion) !== 1
    || Number(metadata?.schemaVersion) !== 1
    || discovery?.complete !== true
    || metadata?.qaDiscoveryComplete !== true
    || !discoveryRevision
    || discoveryRevision !== metadataRevision
    || !discoveryGeneratedAt
    || discoveryGeneratedAt !== metadataGeneratedAt
    || !Number.isSafeInteger(discoveryQaCount)
    || discoveryQaCount !== metadataQaCount
    || !Number.isSafeInteger(discoveryCardCount)
    || discoveryCardCount !== metadataCardCount
    || !discoverySummary.valid
    || discoverySummary.cardCount !== discoveryCardCount
    || discoverySummary.qaCount !== discoveryQaCount
    || !stateArraysAreValid
    || !stateSetsAreDisjoint
  ) {
    return bindStatus(data, {
      available: false,
      reason: discovery?.complete !== true || metadata?.qaDiscoveryComplete !== true
        ? "qa_discovery_index_incomplete"
        : discoveryRevision !== metadataRevision
          ? "qa_discovery_revision_mismatch"
          : "qa_discovery_snapshot_metadata_mismatch",
      sourceRevision: discoveryRevision,
      trustedDataRevision,
    });
  }

  const currentRecordsByQaId = new Map();
  for (const record of allRecords) {
    const qaId = officialQaId(record);
    if (
      !qaId
      || staleQaIds.has(qaId)
      || retiredQaIds.has(qaId)
      || !hasCompleteCurrentOfficialQaBody(record)
    ) continue;
    const records = currentRecordsByQaId.get(qaId) || [];
    records.push(record);
    currentRecordsByQaId.set(qaId, records);
  }

  const cardIdsByRecord = new Map();
  const discoveredQaIds = new Set();
  const boundQaIds = new Set();
  const missingBodyQaIds = new Set();
  const staleBodyQaIds = new Set();
  const retiredBodyQaIds = new Set();
  for (const item of discovery.records) {
    const cardId = normalizeNumericId(item?.cardId);
    if (!cardId || !Array.isArray(item?.qaIds)) continue;
    for (const rawQaId of item.qaIds) {
      const qaId = normalizeNumericId(rawQaId);
      if (!qaId) continue;
      discoveredQaIds.add(qaId);
      if (staleQaIds.has(qaId)) {
        staleBodyQaIds.add(qaId);
        continue;
      }
      if (retiredQaIds.has(qaId)) {
        retiredBodyQaIds.add(qaId);
        continue;
      }
      const records = currentRecordsByQaId.get(qaId) || [];
      if (!records.length) {
        missingBodyQaIds.add(qaId);
        continue;
      }
      for (const record of records) {
        const ids = cardIdsByRecord.get(record) || new Set();
        ids.add(cardId);
        cardIdsByRecord.set(record, ids);
        boundQaIds.add(qaId);
      }
    }
  }

  let boundRelationCount = 0;
  for (const [record, ids] of cardIdsByRecord) {
    const frozenIds = Object.freeze([...ids].sort(compareNumericStrings));
    discoveryCardIdsByRecord.set(record, frozenIds);
    boundRelationCount += frozenIds.length;
  }
  const missing = [...missingBodyQaIds].sort(compareNumericStrings);
  const stale = [...staleBodyQaIds].sort(compareNumericStrings);
  const retired = [...retiredBodyQaIds].sort(compareNumericStrings);
  return bindStatus(data, {
    available: true,
    reason: stale.length
      ? "qa_discovery_bodies_stale"
      : retired.length
        ? "qa_discovery_bodies_retired"
      : missing.length
        ? "qa_discovery_bodies_partially_unavailable"
        : "",
    sourceRevision: discoveryRevision,
    trustedDataRevision,
    discoveredQaCount: discoveredQaIds.size,
    boundQaCount: boundQaIds.size,
    boundRelationCount,
    missingBodyCount: missing.length,
    missingBodyQaIds: missing.slice(0, 20),
    staleBodyCount: stale.length,
    staleBodyQaIds: stale.slice(0, 20),
    retiredBodyCount: retired.length,
    retiredBodyQaIds: retired.slice(0, 20),
  });
}

export function getOfficialQaDiscoveryCardIds(record) {
  if (!record || typeof record !== "object") return [];
  return discoveryCardIdsByRecord.get(record) || [];
}

export function getOfficialQaDiscoveryRelationStatus(data) {
  if (!data || typeof data !== "object") return unavailableStatus;
  return discoveryStatusByData.get(data) || unavailableStatus;
}

function hasCompleteCurrentOfficialQaBody(record = {}) {
  if (!["qa", "official-database"].includes(String(record.recordType || ""))) return false;
  if (blockedStatuses.has(String(record.status || "").toLowerCase())) return false;
  const sourceName = String(record.sourceName || record.source || "").trim();
  const recordId = String(record.id || record.stableId || "").trim();
  if (sourceName !== "YGOResources DB" && !/^ygoresources-qa-\d+(?:@|$)/u.test(recordId)) return false;
  const projection = projectOfficialQaQuestion(record);
  return projection.principalSurfaces.length > 0 && Boolean(String(projection.answerText || "").trim());
}

function officialQaId(record = {}) {
  const sourceId = String(record.sourceRecordId || record.sourceId || "").trim();
  if (/^\d+$/u.test(sourceId)) return sourceId;
  return String(record.id || record.stableId || "").match(/(?:^|-)qa-(\d+)(?:@|$)/u)?.[1] || "";
}

function normalizeNumericId(value) {
  const id = String(value || "").trim();
  return /^\d+$/u.test(id) ? id : "";
}

function isValidNumericIdArray(value) {
  if (!Array.isArray(value)) return false;
  const normalized = value.map(normalizeNumericId);
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length;
}

function summarizeDiscoveryRecords(records) {
  if (!Array.isArray(records)) return { valid: false, cardCount: 0, qaCount: 0 };
  const cardIds = new Set();
  const qaIds = new Set();
  for (const record of records) {
    const cardId = normalizeNumericId(record?.cardId);
    if (!cardId || cardIds.has(cardId) || !isValidNumericIdArray(record?.qaIds)) {
      return { valid: false, cardCount: 0, qaCount: 0 };
    }
    cardIds.add(cardId);
    for (const qaId of record.qaIds) qaIds.add(normalizeNumericId(qaId));
  }
  return { valid: true, cardCount: cardIds.size, qaCount: qaIds.size };
}

function compareNumericStrings(left, right) {
  return Number(left) - Number(right) || left.localeCompare(right);
}

function bindStatus(data, value = {}) {
  const status = Object.freeze({
    available: value.available === true,
    reason: String(value.reason || ""),
    sourceRevision: String(value.sourceRevision || ""),
    trustedDataRevision: String(value.trustedDataRevision || ""),
    discoveredQaCount: Number(value.discoveredQaCount || 0),
    boundQaCount: Number(value.boundQaCount || 0),
    boundRelationCount: Number(value.boundRelationCount || 0),
    missingBodyCount: Number(value.missingBodyCount || 0),
    missingBodyQaIds: Object.freeze([...(value.missingBodyQaIds || [])]),
    staleBodyCount: Number(value.staleBodyCount || 0),
    staleBodyQaIds: Object.freeze([...(value.staleBodyQaIds || [])]),
    retiredBodyCount: Number(value.retiredBodyCount || 0),
    retiredBodyQaIds: Object.freeze([...(value.retiredBodyQaIds || [])]),
  });
  discoveryStatusByData.set(data, status);
  return status;
}

async function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, "utf8")) };
  } catch {
    return { ok: false, value: null };
  }
}
