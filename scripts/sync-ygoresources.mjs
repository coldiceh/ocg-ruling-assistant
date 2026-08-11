import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCardAliasIndex, buildQaIndex } from "../backend/dataIndex.mjs";
import { normalizeCardMetadata } from "../backend/liveOfficialQaProvider.mjs";
import {
  detectTranslationPlaceholder,
  formatRulingDataQualityIssue,
  quarantineRulingData,
  selectUsableLocalizedRulingText,
} from "../backend/rulingDataQuality.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
const baseUrl = process.env.YGORESOURCES_BASE_URL || "https://db.ygoresources.com";
const maxRecentQa = Number(process.env.MAX_RECENT_QA || 120);
const maxCardQaPerCard = Number(process.env.MAX_CARD_QA_PER_CARD || 80);
const maxQaTotal = Number(process.env.MAX_QA_TOTAL || 3000);
const maxCards = Number(process.env.MAX_CARDS || 0);
const fetchConcurrency = Number(process.env.FETCH_CONCURRENCY || 8);
const fetchRetryCount = Math.max(1, Number(process.env.FETCH_RETRY_COUNT || 3));
const syncAllReleasedCards = process.env.SYNC_ALL_RELEASED_CARDS !== "false";
const syncOnlyReleasedCards = process.env.SYNC_ONLY_RELEASED_CARDS !== "false";
const defaultIndexLanguages = (process.env.CARD_INDEX_LANGUAGES || "en,ja")
  .split(",")
  .map((language) => language.trim())
  .filter(Boolean);
const freshnessDays = Number(process.env.FRESHNESS_DAYS || 7);
const userAgent = "ocg-ruling-assistant/0.1 (+https://github.com/)";

const warnings = [];
const sourceSyncWarnings = [];
const sourceRetirementWarnings = [];
const aliasWarnings = [];
const parseFailedWarnings = [];
const contentQualityWarnings = [];
let observedSourceRevision = null;
let qaSyncSelectionStats = {};

async function main() {
  await mkdir(dataDir, { recursive: true });
  const tracked = await readJsonFile(join(dataDir, "tracked-cards.json"), { cards: [] });
  const previousMeta = await readJsonFile(join(dataDir, "snapshot-meta.json"), {});
  const previousCards = await readJsonFile(join(dataDir, "cards.json"), { records: [] });
  const previousRulings = await readJsonFile(join(dataDir, "rulings.json"), { records: [] });
  const previousQaDiscovery = await readJsonFile(join(dataDir, "qa-discovery-index.json"), { records: [] });

  const trackedCards = tracked.cards || [];
  const languages = new Set([...defaultIndexLanguages, ...trackedCards.map((card) => card.language || "en")]);
  const nameIndexes = await loadNameIndexes(languages);
  const cardTargets = buildCardTargets(trackedCards, nameIndexes);
  const monsterPropertyMetadata = await loadMonsterPropertyMetadata();
  const cardPayloads = await loadCards(cardTargets, nameIndexes, monsterPropertyMetadata);
  quarantineConflictingTrackedAliases(cardPayloads);
  // A MAX_CARDS run is intentionally partial even when the global
  // SYNC_ALL_RELEASED_CARDS switch remains enabled.  Never let such a bounded
  // development run replace the complete card-to-QA discovery relation.
  const cardSnapshotAuthoritative = isCompleteCardSnapshotRun({
    syncAllReleasedCards,
    maxCards,
    sourceWarningCount: sourceSyncWarnings.length,
  });
  const currentQaDiscovery = buildCardQaDiscoveryIndex(cardPayloads);
  const qaDiscoveryRecords = mergeCardQaDiscoveryIndex(
    previousQaDiscovery.records || [],
    currentQaDiscovery,
    { authoritative: cardSnapshotAuthoritative },
  );
  const manifest = await loadManifest(previousMeta.sourceRevision);
  let cards = cardPayloads.map(({ record }) => record);
  const rulingSync = await loadRulings(cards, cardPayloads, manifest.changedQaIds, {
    qaDiscoveryRecords,
    detailCursor: previousMeta.qaDetailCursor,
  });
  let rulings = rulingSync.records;
  if (!cardSnapshotAuthoritative) {
    cards = mergeCardRecords(previousCards.records || [], cards);
  }
  rulings = mergeRulingsCumulatively(previousRulings.records || [], rulings, {
    removedQaIds: rulingSync.removedQaIds,
    authoritativeRecordTypes: cardSnapshotAuthoritative ? ["card-text", "card-faq"] : [],
  });
  const qaDetailSnapshotAuthoritative = isAuthoritativeQaDetailSnapshot({
    maxQaTotal,
    cardSnapshotAuthoritative,
    sourceWarningCount: sourceSyncWarnings.length,
    detailSnapshotComplete: rulingSync.detailSnapshotComplete,
  });
  rulings = retainBoundedQaDetails(rulings, {
    selectedQaIds: rulingSync.selectedQaIds,
    limit: maxQaTotal,
    authoritative: qaDetailSnapshotAuthoritative,
  });
  const rulingQuarantine = quarantineRulingData(rulings, previousRulings.records || []);
  for (const issue of rulingQuarantine.issues) {
    addContentQualityWarning(formatRulingDataQualityIssue(issue));
  }
  if (rulingQuarantine.retainedPreviousIds.length) {
    addContentQualityWarning(
      `Retained ${rulingQuarantine.retainedPreviousIds.length} previous healthy ruling record(s) in place of invalid synchronized content`,
    );
  }
  if (rulingQuarantine.droppedIds.length) {
    addContentQualityWarning(
      `Quarantined ${rulingQuarantine.droppedIds.length} ruling record(s) because no previous healthy value was available`,
    );
  }
  rulings = rulingQuarantine.records;
  const cardAliasIndex = buildCardAliasIndex(cards);
  const qaIndex = buildQaIndex(rulings, cards);

  const generatedAt = new Date().toISOString();
  const sourceFreshness = sourceSyncWarnings.length ? "stale" : "fresh";
  const dataQualityWarnings = [...aliasWarnings, ...parseFailedWarnings, ...contentQualityWarnings];
  await writeJson(join(dataDir, "cards.json"), {
    schemaVersion: 1,
    generatedAt,
    records: cards,
  });
  await writeJson(join(dataDir, "cards-lite.json"), {
    schemaVersion: 1,
    generatedAt,
    records: cards.map((card) => ({
      id: card.id,
      name: card.name,
      cnName: card.cnName,
      jaName: card.jaName,
      enName: card.enName,
      aliases: card.aliases,
      released: card.released,
      type: card.type,
      cardType: card.cardType,
      race: card.race,
      attribute: card.attribute,
      attack: card.attack,
      defense: card.defense,
      atk: card.atk,
      def: card.def,
      level: card.level,
      rank: card.rank,
      link: card.link,
      linkRating: card.linkRating,
      linkArrows: card.linkArrows,
      propertyIds: card.propertyIds,
      properties: card.properties,
      monsterPropertyIds: card.monsterPropertyIds,
      monsterProperties: card.monsterProperties,
    })),
  });
  await writeJson(join(dataDir, "rulings.json"), {
    schemaVersion: 1,
    generatedAt,
    records: rulings,
  });
  await writeJson(join(dataDir, "card-alias-index.json"), {
    schemaVersion: 1,
    generatedAt,
    records: cardAliasIndex,
  });
  await writeJson(join(dataDir, "qa-index.json"), {
    schemaVersion: 1,
    generatedAt,
    records: qaIndex,
  });
  const discoveredQaIds = collectDiscoveredQaIds(qaDiscoveryRecords);
  await writeJson(join(dataDir, "qa-discovery-index.json"), {
    schemaVersion: 1,
    generatedAt,
    sourceRevision: observedSourceRevision || manifest.revision || previousMeta.sourceRevision || null,
    complete: cardSnapshotAuthoritative,
    cardCount: qaDiscoveryRecords.length,
    linkedCardCount: qaDiscoveryRecords.filter((record) => record.qaIds.length > 0).length,
    qaCount: discoveredQaIds.length,
    relationCount: qaDiscoveryRecords.reduce((sum, record) => sum + record.qaIds.length, 0),
    records: qaDiscoveryRecords,
  });
  await writeJson(join(dataDir, "snapshot-meta.json"), {
    schemaVersion: 1,
    status: warnings.length ? "synced-with-warnings" : "synced",
    generatedAt,
    freshnessDays,
    sourceFreshness,
    previousSourceRevision: previousMeta.sourceRevision || null,
    sourceRevision: observedSourceRevision || manifest.revision || previousMeta.sourceRevision || null,
    lastSuccessfulSyncAt: sourceSyncWarnings.length ? (previousMeta.lastSuccessfulSyncAt || previousMeta.generatedAt || null) : generatedAt,
    lastFailedSyncAt: sourceSyncWarnings.length ? generatedAt : (previousMeta.lastFailedSyncAt || null),
    syncFailureCount: sourceSyncWarnings.length ? Number(previousMeta.syncFailureCount || 0) + 1 : 0,
    aliasWarnings,
    parseFailedWarnings,
    contentQualityWarnings,
    dataQualityWarnings,
    aliasWarningCount: aliasWarnings.length,
    parseFailedCount: parseFailedWarnings.length,
    contentQualityWarningCount: contentQualityWarnings.length,
    dataQualityWarningCount: dataQualityWarnings.length,
    newItems: Number(previousMeta.newItems || 0),
    changedItems: Number(previousMeta.changedItems || 0),
    removedItems: Number(previousMeta.removedItems || 0),
    qaDetailCursor: rulingSync.nextDetailCursor,
    qaDiscoveryCardCount: qaDiscoveryRecords.length,
    qaDiscoveryQaCount: discoveredQaIds.length,
    qaDiscoveryComplete: cardSnapshotAuthoritative,
    sources: [
      {
        id: "official-card-database",
        name: "Yu-Gi-Oh! OCG Card Database",
        url: "https://www.db.yugioh-card.com/yugiohdb/",
        role: "最终权威资料来源；涉及裁定变更时以官方数据库和事务局确认优先。",
      },
      {
        id: "ygoresources",
        name: "YGOResources DB",
        url: baseUrl,
        role: "结构化卡片与 Q&A 数据来源，用于生成 GitHub Pages 可读取的静态快照。",
      },
    ],
    warnings,
    sourceSyncWarnings,
    sourceRetirementWarnings,
    sourceRetirementWarningCount: sourceRetirementWarnings.length,
    aliasWarnings,
    parseFailedWarnings,
    dataQualityWarnings,
    changedPaths: manifest.changedPaths,
  });

  await writeJson(join(dataDir, "sync-report.json"), {
    generatedAt,
    cardCount: cards.length,
    rulingCount: rulings.length,
    cardAliasCount: cardAliasIndex.length,
    qaIndexCount: qaIndex.length,
    syncAllReleasedCards,
    syncOnlyReleasedCards,
    maxCards,
    maxQaTotal,
    qaSyncSelection: qaSyncSelectionStats,
    qaDiscoveryCardCount: qaDiscoveryRecords.length,
    qaDiscoveryQaCount: discoveredQaIds.length,
    qaDiscoveryRelationCount: qaDiscoveryRecords.reduce((sum, record) => sum + record.qaIds.length, 0),
    qaDiscoveryComplete: cardSnapshotAuthoritative,
    qaDetailSnapshotAuthoritative,
    warnings,
    sourceRetirementWarnings,
    dataQualityWarnings,
    changedPaths: manifest.changedPaths,
  });

  console.log(`Synced ${cards.length} cards, ${cardAliasIndex.length} aliases, ${rulings.length} ruling records, and ${qaIndex.length} Q&A index entries.`);
  if (warnings.length) console.warn(warnings.join("\n"));
}

async function loadNameIndexes(languages) {
  const indexes = new Map();

  for (const language of languages) {
    try {
      const payload = await fetchJson(`/data/idx/card/name/${language}`);
      indexes.set(language, collectNameIndex(payload));
    } catch (error) {
      addSourceWarning(`Name index ${language} failed: ${formatError(error)}`);
      indexes.set(language, new Map());
    }
  }

  return indexes;
}

function buildCardTargets(trackedCards, nameIndexes) {
  const targets = new Map();

  if (syncAllReleasedCards) {
    for (const index of nameIndexes.values()) {
      for (const id of index.values()) {
        mergeTarget(targets, { id: String(id), aliases: [] });
      }
    }
  }

  for (const item of trackedCards) {
    const id = item.id || resolveCardId(item, nameIndexes);
    if (!id) {
      addAliasWarning(`Card not resolved: ${item.lookupName || item.name || JSON.stringify(item)}`);
      continue;
    }
    mergeTarget(targets, { ...item, id: String(id) });
  }

  const result = [...targets.values()];
  return maxCards > 0 ? result.slice(0, maxCards) : result;
}

function mergeTarget(targets, item) {
  const id = String(item.id);
  const existing = targets.get(id);
  if (!existing) {
    targets.set(id, { ...item, id, aliases: item.aliases || [] });
    return;
  }

  existing.lookupName = existing.lookupName || item.lookupName;
  existing.name = existing.name || item.name;
  existing.language = existing.language || item.language;
  existing.aliases = [...new Set([...(existing.aliases || []), ...(item.aliases || [])])];
}

async function loadMonsterPropertyMetadata() {
  try {
    const payload = await fetchJson("/data/meta/mprop");
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    addSourceWarning(`Monster property metadata failed: ${formatError(error)}`);
    return [];
  }
}

async function loadCards(cards, nameIndexes, monsterPropertyMetadata = []) {
  const results = await mapLimit(cards, fetchConcurrency, async (item) => {
    const id = item.id || resolveCardId(item, nameIndexes);
    if (!id) {
      addAliasWarning(`Card not resolved: ${item.lookupName || item.name || JSON.stringify(item)}`);
      return null;
    }

    try {
      const payload = await fetchJson(`/data/card/${id}`);
      const record = normalizeCard(payload, item, id, monsterPropertyMetadata);
      if (syncOnlyReleasedCards && !record.released) return null;
      return { record, payload, tracked: item };
    } catch (error) {
      addSourceWarning(`Card ${item.lookupName || id} failed: ${formatError(error)}`);
      return null;
    }
  });

  return dedupeBy(results.filter(Boolean), (entry) => String(entry.record.id || entry.record.name));
}

async function loadRulings(cards, cardPayloads, changedQaIds = [], {
  qaDiscoveryRecords = [],
  detailCursor = 0,
} = {}) {
  const records = [];
  const removedQaIds = [];
  records.push(...buildCardTextRecords(cardPayloads));
  records.push(...buildFaqRecords(cardPayloads));
  let recentQaIds = [];
  try {
    const payload = await fetchJson("/data/meta/recent/ja/qa");
    recentQaIds = collectQaIds(payload).slice(0, maxRecentQa);
  } catch (error) {
    addSourceWarning(`Recent Q&A failed: ${formatError(error)}`);
  }

  const qaLimit = Math.min(maxQaTotal, Math.max(maxRecentQa, cards.length * maxCardQaPerCard));
  const selection = selectQaIdsForSync({
    changedQaIds,
    recentQaIds,
    cardQaIds: rankCardQaIds(cardPayloads, maxCardQaPerCard),
    coverageQaIds: buildFairQaCoverageOrder(qaDiscoveryRecords),
    cursor: detailCursor,
    limit: qaLimit,
  });
  qaSyncSelectionStats = {
    selectedCount: selection.selectedCount,
    discoveredCount: selection.discoveredCount,
    truncatedCount: selection.truncatedCount,
    changedSelectedCount: selection.changedSelectedCount,
    recentSelectedCount: selection.recentSelectedCount,
    hotSelectedCount: selection.hotSelectedCount,
    coverageSelectedCount: selection.coverageSelectedCount,
    detailCursor: selection.cursor,
    nextDetailCursor: selection.nextCursor,
  };
  let detailSnapshotComplete = true;
  for (const id of selection.ids) {
    try {
      const payload = await fetchJson(`/data/qa/${id}`);
      const record = normalizeQa(payload, id, cards);
      if (record) records.push(record);
      else detailSnapshotComplete = false;
    } catch (error) {
      const failure = classifyRemoteItemFetchFailure(error);
      if (failure.kind === "removed") {
        removedQaIds.push(String(id));
        addSourceRetirementWarning(`Q&A ${id} was removed upstream (${failure.status})`);
      } else {
        detailSnapshotComplete = false;
        addSourceWarning(`Q&A ${id} failed: ${formatError(error)}`);
      }
    }
  }

  return {
    records,
    removedQaIds,
    selectedQaIds: selection.ids,
    nextDetailCursor: selection.nextCursor,
    detailSnapshotComplete,
  };
}

export function classifyRemoteItemFetchFailure(error = {}) {
  const status = Number(error?.status);
  if (status === 404 || status === 410) {
    return { kind: "removed", fatal: false, status };
  }
  return {
    kind: "source_failure",
    fatal: true,
    status: Number.isFinite(status) ? status : null,
  };
}

async function loadManifest(previousRevision) {
  if (!previousRevision) return { revision: observedSourceRevision, changedPaths: [], changedQaIds: [] };

  try {
    const payload = await fetchJson(`/manifest/${previousRevision}`);
    return parseManifestPayload(payload, { revision: observedSourceRevision });
  } catch (error) {
    addSourceWarning(`Manifest check failed: ${formatError(error)}`);
    return { revision: previousRevision, changedPaths: [], changedQaIds: [] };
  }
}

export function parseManifestPayload(payload = {}, { revision = null } = {}) {
  const safePayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const changedPaths = [];
  const directPaths = Array.isArray(safePayload.changed)
    ? safePayload.changed
    : Array.isArray(safePayload.paths)
      ? safePayload.paths
      : [];
  changedPaths.push(...directPaths.map(String));
  const data = safePayload.data && typeof safePayload.data === "object" && !Array.isArray(safePayload.data)
    ? safePayload.data
    : {};
  for (const [kind, entries] of Object.entries(data)) {
    if (Array.isArray(entries)) {
      for (const id of entries) changedPaths.push(`/data/${kind}/${id}`);
      continue;
    }
    for (const id of Object.keys(entries || {})) changedPaths.push(`/data/${kind}/${id}`);
  }
  const uniquePaths = [...new Set(changedPaths.filter(Boolean))];
  return {
    revision: normalizeRevision(revision || safePayload.revision || safePayload.latestRevision || safePayload.currentRevision),
    changedPaths: uniquePaths,
    changedQaIds: uniquePaths
      .map((path) => String(path).match(/\/data\/qa\/(\d+)/u)?.[1])
      .filter(Boolean),
  };
}

export function rankCardQaIds(cardPayloads = [], perCardLimit = Infinity) {
  const counts = new Map();
  const firstSeen = new Map();
  let cursor = 0;
  for (const entry of cardPayloads || []) {
    const ids = collectQaIds(entry?.payload?.qaIndex || []).slice(0, perCardLimit);
    for (const id of ids) {
      counts.set(id, (counts.get(id) || 0) + 1);
      if (!firstSeen.has(id)) firstSeen.set(id, cursor++);
    }
  }
  return [...counts.keys()].sort((left, right) => (
    counts.get(right) - counts.get(left) || firstSeen.get(left) - firstSeen.get(right)
  ));
}

export function isCompleteCardSnapshotRun({
  syncAllReleasedCards = false,
  maxCards = 0,
  sourceWarningCount = 0,
} = {}) {
  return syncAllReleasedCards === true
    && Number(maxCards) <= 0
    && Number(sourceWarningCount) === 0;
}

export function isAuthoritativeQaDetailSnapshot({
  maxQaTotal = 0,
  cardSnapshotAuthoritative = false,
  sourceWarningCount = 0,
  detailSnapshotComplete = false,
} = {}) {
  return Number(maxQaTotal) > 0
    && cardSnapshotAuthoritative === true
    && Number(sourceWarningCount) === 0
    && detailSnapshotComplete === true;
}

export function buildCardQaDiscoveryIndex(cardPayloads = []) {
  const records = [];
  for (const entry of cardPayloads || []) {
    const cardId = String(entry?.record?.id || entry?.tracked?.id || "").trim();
    if (!/^\d+$/u.test(cardId)) continue;
    records.push({
      cardId,
      qaIds: collectQaIds(entry?.payload?.qaIndex || []).sort(compareNumericIds),
    });
  }
  return normalizeCardQaDiscoveryRecords(records);
}

export function mergeCardQaDiscoveryIndex(previousRecords = [], currentRecords = [], {
  authoritative = false,
} = {}) {
  if (authoritative) return normalizeCardQaDiscoveryRecords(currentRecords);
  const byCardId = new Map(normalizeCardQaDiscoveryRecords(previousRecords).map((record) => [record.cardId, record]));
  for (const record of normalizeCardQaDiscoveryRecords(currentRecords)) byCardId.set(record.cardId, record);
  return [...byCardId.values()].sort((left, right) => compareNumericIds(left.cardId, right.cardId));
}

export function collectDiscoveredQaIds(discoveryRecords = []) {
  return uniqueIds((discoveryRecords || []).flatMap((record) => record?.qaIds || [])).sort(compareNumericIds);
}

export function buildFairQaCoverageOrder(discoveryRecords = []) {
  const records = normalizeCardQaDiscoveryRecords(discoveryRecords).filter((record) => record.qaIds.length > 0);
  const ordered = [];
  const seen = new Set();
  let active = records.map((record) => ({ qaIds: record.qaIds, depth: 0 }));
  while (active.length) {
    const next = [];
    for (const state of active) {
      const id = state.qaIds[state.depth];
      if (id && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
      if (state.depth + 1 < state.qaIds.length) {
        next.push({ qaIds: state.qaIds, depth: state.depth + 1 });
      }
    }
    active = next;
  }
  return ordered;
}

export function selectQaIdsForSync({
  changedQaIds = [],
  recentQaIds = [],
  cardQaIds = [],
  coverageQaIds = cardQaIds,
  cursor = 0,
  limit = Infinity,
} = {}) {
  const changed = uniqueIds(changedQaIds);
  const recent = uniqueIds(recentQaIds);
  const hot = uniqueIds(cardQaIds);
  const coverage = uniqueIds(coverageQaIds);
  const discovered = uniqueIds([...changed, ...recent, ...hot, ...coverage]);
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : discovered.length;
  const ids = uniqueIds([...changed, ...recent]).slice(0, safeLimit);
  const selected = new Set(ids);
  const safeCursor = normalizeCircularCursor(cursor, coverage.length);
  let nextCursor = safeCursor;
  let coverageSelectedCount = 0;
  let hotSelectedCount = 0;

  const available = Math.max(0, safeLimit - ids.length);
  const minimumCoverageSlots = coverage.length && available
    ? Math.max(1, Math.floor(available / 2))
    : 0;
  if (minimumCoverageSlots) {
    const result = takeCircularQaIds(coverage, nextCursor, minimumCoverageSlots, selected);
    ids.push(...result.ids);
    result.ids.forEach((id) => selected.add(id));
    coverageSelectedCount += result.ids.length;
    nextCursor = result.nextCursor;
  }

  for (const id of hot) {
    if (ids.length >= safeLimit) break;
    if (selected.has(id)) continue;
    ids.push(id);
    selected.add(id);
    hotSelectedCount += 1;
  }

  if (ids.length < safeLimit && coverage.length) {
    const result = takeCircularQaIds(coverage, nextCursor, safeLimit - ids.length, selected);
    ids.push(...result.ids);
    result.ids.forEach((id) => selected.add(id));
    coverageSelectedCount += result.ids.length;
    nextCursor = result.nextCursor;
  }

  return {
    ids,
    selectedCount: ids.length,
    discoveredCount: discovered.length,
    truncatedCount: Math.max(0, discovered.length - ids.length),
    changedSelectedCount: changed.filter((id) => selected.has(id)).length,
    recentSelectedCount: recent.filter((id) => selected.has(id)).length,
    hotSelectedCount,
    coverageSelectedCount,
    cursor: safeCursor,
    nextCursor,
  };
}

function normalizeCardQaDiscoveryRecords(records = []) {
  const byCardId = new Map();
  for (const record of records || []) {
    const cardId = String(record?.cardId || "").trim();
    if (!/^\d+$/u.test(cardId)) continue;
    byCardId.set(cardId, {
      cardId,
      qaIds: uniqueIds(record?.qaIds || []).sort(compareNumericIds),
    });
  }
  return [...byCardId.values()].sort((left, right) => compareNumericIds(left.cardId, right.cardId));
}

function takeCircularQaIds(ids, cursor, count, alreadySelected) {
  if (!ids.length || count <= 0) return { ids: [], nextCursor: normalizeCircularCursor(cursor, ids.length) };
  const selected = [];
  let nextCursor = normalizeCircularCursor(cursor, ids.length);
  let visited = 0;
  while (visited < ids.length && selected.length < count) {
    const id = ids[nextCursor];
    nextCursor = (nextCursor + 1) % ids.length;
    visited += 1;
    if (alreadySelected.has(id)) continue;
    selected.push(id);
  }
  return { ids: selected, nextCursor };
}

function normalizeCircularCursor(value, length) {
  if (!length) return 0;
  const numeric = Number(value);
  const integer = Number.isFinite(numeric) ? Math.floor(numeric) : 0;
  return ((integer % length) + length) % length;
}

function compareNumericIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right));
}

function resolveCardId(item, indexes) {
  const language = item.language || "en";
  const index = indexes.get(language) || new Map();
  return index.get(normalizeKey(item.lookupName || item.name || ""));
}

function collectNameIndex(payload) {
  const index = new Map();

  function visit(value, possibleName = "") {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, possibleName);
      return;
    }

    if (typeof value !== "object") {
      if (possibleName && (typeof value === "string" || typeof value === "number")) {
        index.set(normalizeKey(possibleName), String(value));
      }
      return;
    }

    const name = value.name || value.cardName || value.label || value.en || value.ja || possibleName;
    const id = value.id || value.cardId || value.cid || value.passcode || value.konamiId;
    if (name && id) index.set(normalizeKey(name), String(id));

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" || typeof child === "number") {
        if (looksLikeCardName(key) && looksLikeId(child)) index.set(normalizeKey(key), String(child));
      } else {
        visit(child, looksLikeCardName(key) ? key : name);
      }
    }
  }

  visit(payload);
  return index;
}

export function normalizeCard(payload, tracked = {}, id, monsterPropertyMetadata = []) {
  const cardData = payload?.cardData || {};
  const cnName = cardData.cn?.name || tracked.aliases?.find((alias) => /[\u4e00-\u9fa5]/.test(alias));
  const jaName = cardData.ja?.name;
  const enName = cardData.en?.name || tracked.lookupName;
  const primaryName = cnName || jaName || enName || tracked.name || String(id);
  const aliases = [...new Set([primaryName, cnName, jaName, enName, tracked.lookupName, ...(tracked.aliases || [])].filter(Boolean))];
  const structuredMetadata = normalizeCardMetadata({ id }, payload, monsterPropertyMetadata);

  return {
    ...structuredMetadata,
    id: String(id),
    name: primaryName,
    cnName,
    jaName,
    enName,
    cardType: cardData.cn?.cardType || cardData.ja?.cardType || cardData.en?.cardType || structuredMetadata.cardType || "",
    effectText: cardData.cn?.effectText || cardData.ja?.effectText || cardData.en?.effectText || "",
    released: isReleased(cardData),
    aliases,
    sourceUrl: `${baseUrl}/data/card/${id}`,
    updatedAt: new Date().toISOString(),
  };
}

function isReleased(cardData) {
  const today = new Date();
  const dates = [];
  for (const locale of Object.values(cardData || {})) {
    for (const product of locale?.products || []) {
      const date = new Date(product.date);
      if (Number.isFinite(date.getTime())) dates.push(date);
    }
  }
  return !dates.length || dates.some((date) => date <= today);
}

function buildCardTextRecords(cardPayloads) {
  return cardPayloads
    .filter(({ record }) => record.effectText)
    .map(({ record }) => ({
      id: `card-text-${record.id}`,
      recordType: "card-text",
      title: `${record.name} 的效果文本`,
      status: "confirmed",
      cards: [record.name],
      cardIds: [record.id],
      keywords: extractKeywords(record.effectText),
      conclusion: record.effectText,
      steps: ["这是同步到的卡片效果文本。若问题涉及裁定处理，仍应继续核对相关 Q&A。"],
      questions: record.released ? [] : ["该卡可能尚未发售或同步来源缺少发售日期，裁定应按预览文本谨慎处理。"],
      sources: [
        {
          label: "YGOResources Card & FAQ data",
          detail: record.sourceUrl,
        },
      ],
      updatedAt: record.updatedAt,
    }));
}

function buildFaqRecords(cardPayloads) {
  const records = [];

  for (const { record, payload } of cardPayloads) {
    const entries = payload?.faqData?.entries || {};
    for (const [effectNo, blocks] of Object.entries(entries)) {
      const lines = [];
      for (const block of blocks || []) {
        const selected = selectUsableLocalizedRulingText(block, [], {
          localeOrder: ["cn", "zh-CN", "ja", "en"],
        });
        if (selected) lines.push(selected.text);
      }
      if (!lines.length) continue;

      records.push({
        id: `card-faq-${record.id}-${effectNo}`,
        recordType: "card-faq",
        title: `${record.name} FAQ ${effectNo}`,
        status: "confirmed",
        cards: [record.name],
        cardIds: [record.id],
        question: "",
        keywords: extractKeywords(lines.join("\n")),
        conclusion: lines.join("\n"),
        steps: ["按同步 FAQ 的说明处理。", "若对局条件与 FAQ 不同，继续查对应官方 Q&A。"],
        questions: [],
        sources: [
          {
            label: "YGOResources Card FAQ",
            detail: record.sourceUrl,
          },
        ],
        updatedAt: payload?.faqData?.meta?.ja?.date || payload?.faqData?.meta?.en?.date || record.updatedAt,
      });
    }
  }

  return records;
}

export function normalizeQa(payload, id, cards) {
  const headingSelection = selectUsableLocalizedRulingText(
    payload?.qaData,
    ["title"],
  );
  const detailedQuestionSelection = selectUsableLocalizedRulingText(
    payload?.qaData,
    ["question", "q"],
  );
  const answerSelection = selectUsableLocalizedRulingText(
    payload?.qaData,
    ["answer", "a", "content"],
  );
  const fallbackHeading = firstText(payload, ["title"]);
  const fallbackDetailedQuestion = firstText(payload, ["question", "q"]);
  const fallbackAnswer = firstText(payload, ["answer", "a", "content"]);
  const rawDetailedQuestion = detailedQuestionSelection?.text
    || fallbackDetailedQuestion
    || headingSelection?.text
    || fallbackHeading;
  const rawQuestion = headingSelection?.text || fallbackHeading || rawDetailedQuestion;
  const question = rawQuestion;
  const answer = answerSelection?.text || fallbackAnswer;
  if (!rawDetailedQuestion || !answer) {
    addParseWarning(`Q&A ${id} skipped: question or answer not found`);
    return null;
  }

  const text = [
    question,
    rawDetailedQuestion !== question ? rawDetailedQuestion : "",
    answer,
  ].filter(Boolean).join("\n");
  const involvedCards = detectCards(text, cards);
  const sourceCardIds = uniqueIds(Array.isArray(payload?.cards) ? payload.cards : []);
  const title = truncate(question.replace(/\s+/g, " "), 90);
  return {
    id: `ygoresources-qa-${id}`,
    recordType: "qa",
    title,
    question,
    rawQuestion,
    rawDetailedQuestion,
    status: "confirmed",
    cards: involvedCards.map((card) => card.name),
    cardIds: uniqueIds([...sourceCardIds, ...involvedCards.map((card) => card.id)]),
    keywords: extractKeywords(text),
    conclusion: answer,
    steps: ["按同步 Q&A 的问答结论处理。", "若对局条件与问答不同，先回到官方数据库核对完整原文。"],
    questions: [],
    sources: [
      {
        label: "YGOResources Q&A",
        detail: `${baseUrl}/data/qa/${id}`,
      },
    ],
    sourceId: String(id),
    sourceName: "YGOResources DB",
    sourceUrl: `${baseUrl}/data/qa/${id}`,
    questionLocale: headingSelection?.locale || detailedQuestionSelection?.locale || "unknown",
    detailedQuestionLocale: detailedQuestionSelection?.locale || headingSelection?.locale || "unknown",
    answerLocale: answerSelection?.locale || "unknown",
    updatedAt: new Date().toISOString(),
  };
}

export function quarantineConflictingTrackedAliases(cardPayloads = [], onWarning = addAliasWarning) {
  const canonicalNamesByCardId = new Map((cardPayloads || []).map((entry) => [
    String(entry?.record?.id || ""),
    [...new Set([
      entry?.payload?.cardData?.cn?.name,
      entry?.payload?.cardData?.ja?.name,
      entry?.payload?.cardData?.en?.name,
      entry?.tracked?.lookupName,
      entry?.tracked?.name,
    ].map((value) => String(value || "").trim()).filter(Boolean))],
  ]));

  for (const entry of cardPayloads || []) {
    const targetId = String(entry?.record?.id || "");
    const trackedAliases = Array.isArray(entry?.tracked?.aliases) ? entry.tracked.aliases : [];
    for (const alias of trackedAliases) {
      const aliasKey = normalizeKey(alias);
      if (aliasKey.length < 3) continue;
      const matchingIds = [...canonicalNamesByCardId.entries()]
        .filter(([, names]) => names.some((name) => normalizeKey(name).includes(aliasKey)))
        .map(([cardId]) => cardId);
      if (matchingIds.length !== 1 || matchingIds[0] === targetId) continue;
      entry.record.aliases = (entry.record.aliases || []).filter(
        (candidate) => normalizeKey(candidate) !== aliasKey,
      );
      onWarning(
        `Tracked alias quarantined: ${alias} was assigned to card ${targetId} but uniquely matches canonical card ${matchingIds[0]}`,
      );
    }
  }
  return cardPayloads;
}

function collectQaIds(payload) {
  const ids = [];

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") {
      if (looksLikeId(value)) ids.push(String(value));
      return;
    }
    const id = value.id || value.qaId || value.qid;
    if (looksLikeId(id)) ids.push(String(id));
    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return [...new Set(ids)];
}

function collectLocalizedValues(payload, targetKeys) {
  const values = {};

  function visit(value, key = "") {
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      if (targetKeys.includes(childKey) && child && typeof child === "object") {
        for (const [locale, text] of Object.entries(child)) {
          if (typeof text === "string" && text.trim()) values[locale] = text.trim();
        }
      } else if (targetKeys.includes(key) && typeof child === "string") {
        values[childKey] = child.trim();
      } else {
        visit(child, childKey);
      }
    }
  }

  visit(payload);
  return values;
}

function firstText(payload, targetKeys) {
  const candidates = [];

  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (targetKeys.includes(key) && value.trim().length > 1) candidates.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        if (targetKeys.includes(childKey)) {
          if (typeof child === "string" && child.trim()) candidates.push(child.trim());
          if (child && typeof child === "object") {
            const localized = child["zh-CN"] || child.cn || child.ja || child.en || child.value || child.text;
            if (typeof localized === "string" && localized.trim()) candidates.push(localized.trim());
          }
        }
        visit(child, childKey);
      }
    }
  }

  visit(payload);
  return candidates
    .filter((candidate) => !detectTranslationPlaceholder(candidate))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function detectCards(text, cards) {
  const normalized = normalizeKey(text);
  return cards.filter((card) => (card.aliases || []).some((alias) => normalized.includes(normalizeKey(alias))));
}

function extractKeywords(text) {
  const keywords = [
    ["发动", "能否发动", "可以发动"],
    ["连锁", "C1", "C2"],
    ["控制权", "获得控制权"],
    ["战斗伤害", "伤害计算", "攻击"],
    ["代替破坏", "代破", "破坏"],
    ["魔法", "陷阱"],
  ];
  const result = [];
  for (const group of keywords) {
    if (group.some((keyword) => text.includes(keyword))) result.push(group[0]);
  }
  return result;
}

async function fetchJson(path) {
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  let lastError = null;
  for (let attempt = 1; attempt <= fetchRetryCount; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": userAgent,
        },
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      const revision = normalizeRevision(response.headers.get("x-cache-revision"));
      if (revision && (!observedSourceRevision || Number(revision) > Number(observedSourceRevision))) {
        observedSourceRevision = revision;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const retryable = !Number.isFinite(Number(error?.status))
        || Number(error.status) === 429
        || Number(error.status) >= 500;
      if (!retryable || attempt === fetchRetryCount) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200 * attempt));
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

function normalizeRevision(value) {
  const text = String(value || "").trim();
  return /^\d+$/u.test(text) ? text : null;
}

function uniqueIds(values) {
  return [...new Set((values || []).map((value) => String(value || "")).filter((value) => /^\d+$/u.test(value)))];
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await writeFile(path, content, "utf8");
      return;
    } catch (error) {
      if (attempt === 5 || !["EPERM", "EBUSY", "UNKNOWN"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) map.set(getKey(item), item);
  return [...map.values()];
}

function mergeById(previous, current) {
  return dedupeBy([...(previous || []), ...(current || [])], (item) => String(item.id || item.name || ""));
}

function mergeCardRecords(previous, current) {
  const records = new Map(
    (previous || []).map((card) => [String(card.id || card.name || ""), card]),
  );
  for (const card of current || []) {
    const key = String(card.id || card.name || "");
    records.set(key, { ...(records.get(key) || {}), ...card });
  }
  return [...records.values()];
}

export function mergeRulingsCumulatively(previous, current, {
  removedQaIds = [],
  authoritativeRecordTypes = [],
} = {}) {
  const removed = new Set((removedQaIds || []).map((id) => String(id || "")).filter(Boolean));
  const authoritativeTypes = new Set(
    (authoritativeRecordTypes || []).map((value) => String(value || "").trim()).filter(Boolean),
  );
  const retainedPrevious = (previous || []).filter((record) => {
    if (authoritativeTypes.has(String(record?.recordType || ""))) return false;
    if (!removed.size || String(record?.recordType || "") !== "qa") return true;
    const sourceId = String(record?.sourceId || "").trim()
      || String(record?.id || "").match(/^ygoresources-qa-(\d+)$/u)?.[1]
      || "";
    return !removed.has(sourceId);
  });
  return mergeById(retainedPrevious, current);
}

export function retainBoundedQaDetails(records = [], {
  selectedQaIds = [],
  limit = Infinity,
  authoritative = false,
} = {}) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) >= 0
    ? Math.floor(Number(limit))
    : Infinity;
  if (!authoritative || safeLimit === Infinity || safeLimit <= 0) return records;
  const retainedSourceIds = new Set(uniqueIds(selectedQaIds).slice(0, safeLimit));
  return (records || []).filter((record) => {
    if (!isYgoresourcesQaRecord(record)) return true;
    return retainedSourceIds.has(qaSourceId(record));
  });
}

function isYgoresourcesQaRecord(record = {}) {
  return String(record?.recordType || "") === "qa"
    && (String(record?.sourceName || "") === "YGOResources DB"
      || /^ygoresources-qa-\d+$/u.test(String(record?.id || "")));
}

function qaSourceId(record = {}) {
  return String(record?.sourceId || "").trim()
    || String(record?.id || "").match(/^ygoresources-qa-(\d+)$/u)?.[1]
    || "";
}

function addSourceWarning(message) { sourceSyncWarnings.push(message); warnings.push(message); }
function addSourceRetirementWarning(message) { sourceRetirementWarnings.push(message); warnings.push(message); }
function addAliasWarning(message) { aliasWarnings.push(message); warnings.push(message); }
function addParseWarning(message) { parseFailedWarnings.push(message); warnings.push(message); }
function addContentQualityWarning(message) { contentQualityWarnings.push(message); warnings.push(message); }

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[－ー]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCardName(value) {
  const text = String(value || "");
  return text.length >= 2 && /[a-zA-Z\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function looksLikeId(value) {
  return /^[0-9]{3,12}$/.test(String(value || ""));
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch(async (error) => {
  console.error(error);
  const previous = await readJsonFile(join(dataDir, "snapshot-meta.json"), {});
  const failedAt = new Date().toISOString();
  const dataQualityWarnings = [...new Set([
    ...(previous.dataQualityWarnings || []),
    ...contentQualityWarnings,
  ])];
  await writeJson(join(dataDir, "snapshot-meta.json"), {
    ...previous,
    sourceFreshness: previous.lastSuccessfulSyncAt || previous.generatedAt ? "stale" : "unknown",
    lastFailedSyncAt: failedAt,
    syncFailureCount: Number(previous.syncFailureCount || 0) + 1,
    warnings: [...new Set([...(previous.warnings || []), `Sync failed: ${formatError(error)}`])],
    contentQualityWarnings: [...new Set([...(previous.contentQualityWarnings || []), ...contentQualityWarnings])],
    contentQualityWarningCount: new Set([...(previous.contentQualityWarnings || []), ...contentQualityWarnings]).size,
    dataQualityWarnings,
    dataQualityWarningCount: dataQualityWarnings.length,
  });
  process.exitCode = 1;
});
