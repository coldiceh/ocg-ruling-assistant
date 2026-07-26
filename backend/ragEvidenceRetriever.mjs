import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchCards } from "./baigeCardProvider.mjs";
import { createLocalCardDataProvider } from "./cardDataProvider.mjs";
import { normalizeCardKey } from "./ragCardExtractor.mjs";
import { searchOfficialQaEvidence } from "./officialQaMatcher.mjs";
import { normalizeOfficialResponses } from "./officialResponses.mjs";
import { isRulebookRecord, retrieveRulebookPassages } from "./rulebookPassageRetriever.mjs";
import { hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import { compileRuleScenario } from "./ruleScenarioCompiler.mjs";
import { retrieveLiveOfficialQa } from "./liveOfficialQaProvider.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const dataCache = new Map();
const emptyDataArray = Object.freeze([]);
const normalizedCardArrayCache = new WeakMap();
const normalizedRecordArrayCache = new WeakMap();
const normalizedDataCache = new WeakMap();
const evidenceRecordBucketsCache = new WeakMap();
const evidenceListCache = new WeakMap();
const retrievalRecordFeatureCache = new WeakMap();
const recordIdentityIndexCache = new WeakMap();
const canonicalCardIdentityIndexCache = new WeakMap();

export async function retrieveRagEvidence({
  userQuery,
  cardResolution = {},
  dataDir = defaultDataDir,
  cards,
  records,
  qaRecords,
  ruleSearchQueries = [],
  enableLiveOfficialQa = false,
  maxPerBucket = 5,
  env = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (enableLiveOfficialQa && !isDisabled(env.RAG_LIVE_OFFICIAL_QA)) {
    env = { ...env, RAG_LIVE_OFFICIAL_QA: "true" };
  }
  const retrievalStartedAt = Date.now();
  const timingsMs = {};
  let stageStartedAt = Date.now();
  const limits = readRetrievalLimits(env, maxPerBucket);
  const data = cards || records || qaRecords
    ? normalizeInjectedData({ cards, records, qaRecords })
    : await loadRagData(dataDir);
  timingsMs.data = Date.now() - stageStartedAt;
  stageStartedAt = Date.now();
  const cardProvider = createLocalCardDataProvider(data);
  const resolvedCards = cardResolution.resolvedCards || [];
  const providedTexts = normalizeUserProvidedCardTexts(cardResolution.userProvidedCardTexts || [], limits);
  let normalizedRuleQueries = normalizeRuleSearchQueries([
    ...(ruleSearchQueries || []),
    ...deriveRuleSearchQueries(userQuery),
  ], limits);
  const retrievalWarnings = [];
  const baigeDebug = { searchCount: 0, cacheHitCount: 0, warnings: [], ambiguousMentions: [] };
  const unresolvedMentions = cardResolution.unresolvedMentions || [];
  const parentheticalAliasKeys = collectParentheticalAliasMentionKeys(unresolvedMentions, resolvedCards);
  const unresolvedResolutionCandidates = unresolvedMentions
    .filter((mention) => !parentheticalAliasKeys.has(normalizeCardKey(mention?.input)));
  const fuzzyCards = resolveUnresolvedMentionCards(unresolvedResolutionCandidates, cardProvider, limits, retrievalWarnings);
  const providedNameKeys = new Set(providedTexts.map((item) => normalizeCardKey(item.name)).filter(Boolean));
  const unresolvedForBaige = unresolvedResolutionCandidates
    .filter((mention) => !providedNameKeys.has(normalizeCardKey(mention.input)));
  const [enrichedLocalCards, baigeResolvedCards] = await Promise.all([
    enrichCardsWithBaige(dedupeCards([...resolvedCards, ...fuzzyCards]), { fetchImpl, env, limits, warnings: retrievalWarnings, debug: baigeDebug }),
    resolveUnresolvedMentionCardsWithBaige(unresolvedForBaige, { fetchImpl, env, limits, warnings: retrievalWarnings, debug: baigeDebug }),
  ]);
  let retrievalCards = dedupeCards([...enrichedLocalCards, ...baigeResolvedCards]).slice(0, limits.maxCards);
  const qaIdentityCards = retrievalCards.filter((card) => card.resolutionSource !== "card_text_reference");
  if (qaIdentityCards.length !== retrievalCards.length) {
    retrievalWarnings.push(`qa_identity_excludes_card_text_references:${retrievalCards.length - qaIdentityCards.length}`);
  }
  const effectiveQaIdentityCards = canonicalizeQaIdentityCards(
    qaIdentityCards.length ? qaIdentityCards : retrievalCards,
    data.cards,
    retrievalWarnings,
  );
  timingsMs.cardResolution = Date.now() - stageStartedAt;
  const remainingUnresolvedMentions = unresolvedMentionsAfterRetrieval(unresolvedResolutionCandidates, retrievalCards);
  if (parentheticalAliasKeys.size) retrievalWarnings.push(`parenthetical_alias_mentions_collapsed:${parentheticalAliasKeys.size}`);
  if (fuzzyCards.length) retrievalWarnings.push(`unresolved_mentions_fuzzy_matched:${fuzzyCards.map((card) => card.name).join(",")}`);
  if (baigeResolvedCards.length) retrievalWarnings.push(`unresolved_mentions_baige_matched:${baigeResolvedCards.map((card) => card.name).join(",")}`);
  if (providedTexts.length) retrievalWarnings.push("user_provided_text_not_official");
  const recordBuckets = evidenceRecordBuckets(data);
  const allEvidenceRecords = recordBuckets.all;
  const scopedRecordBuckets = scopeRecordBuckets(
    recordBuckets,
    dedupeCards([...effectiveQaIdentityCards, ...retrievalCards]),
  );

  const cardTexts = retrievalCards
    .map((card) => mergeCanonicalCardEvidenceProfile(
      card,
      findCardRecord(card, data.cards) || cardProvider.getCardProfile(card.id || card.cardId),
    ))
    .filter(Boolean)
    .map((card) => cardTextEvidence(card, limits.maxCardTextChars, retrievalWarnings));
  const userProvidedCardTextEvidence = dedupeEvidence(providedTexts.map((item, index) => userProvidedTextEvidence(item, index, limits.maxCardTextChars, retrievalWarnings)));
  normalizedRuleQueries = mergeRuleSearchQueries(
    normalizedRuleQueries,
    deriveRuleSearchQueriesFromCardTexts(userQuery, cardTexts),
    limits,
  );
  if (normalizedRuleQueries.length) retrievalWarnings.push(`rule_search_queries_used:${normalizedRuleQueries.length}`);
  const mentionQueries = [
    ...remainingUnresolvedMentions.map((item) => item.input),
    ...providedTexts.map((item) => item.name),
    ...normalizedRuleQueries.map((item) => item.query),
  ].filter(Boolean);
  stageStartedAt = Date.now();
  const rulebookCandidates = retrieveRulebookPassages({
    records: allEvidenceRecords,
    userQuery,
    ruleSearchQueries: normalizedRuleQueries,
    maxPassages: limits.maxRulebookCandidates,
    maxPassageChars: limits.maxRulebookPassageChars,
  });
  timingsMs.rulebook = Date.now() - stageStartedAt;
  if (rulebookCandidates.length) retrievalWarnings.push(`rulebook_passages_retrieved:${rulebookCandidates.length}`);

  stageStartedAt = Date.now();
  const localOfficialMatches = searchOfficialQaEvidence({
    question: userQuery,
    records: scopedRecordBuckets.officialQa,
    resolvedCards: effectiveQaIdentityCards,
    limit: Math.max(20, limits.maxOfficialQa * 4),
  });
  const localCandidateQaIds = localOfficialMatches.all
    .map((match) => officialQaNumericId(match.record))
    .filter(Boolean)
    .slice(0, readPositiveNumber(env.RAG_LIVE_QA_MAX_CANDIDATES, 8));
  let liveOfficialQa = { records: [], cardMetadata: [], warnings: [], debug: {} };
  const liveQaEnabled = !isDisabled(env.RAG_LIVE_OFFICIAL_QA)
    && (!cards && !records && !qaRecords || isEnabled(env.RAG_LIVE_OFFICIAL_QA));
  if (
    !localOfficialMatches.exact.length
    && liveQaEnabled
    && (retrievalCards.length >= 1 || localCandidateQaIds.length)
  ) {
    liveOfficialQa = await retrieveLiveOfficialQa({
      resolvedCards: effectiveQaIdentityCards,
      candidateQaIds: localCandidateQaIds,
      fetchImpl,
      baseUrl: env.YGORESOURCES_BASE_URL || "https://db.ygoresources.com",
      timeoutMs: readPositiveNumber(env.RAG_LIVE_QA_TIMEOUT_MS, 1800),
      cacheTtlMs: readPositiveNumber(env.RAG_LIVE_QA_CACHE_TTL_MS, 10 * 60 * 1000),
      maxCandidates: readPositiveNumber(env.RAG_LIVE_QA_MAX_CANDIDATES, 8),
    });
    retrievalWarnings.push(...(liveOfficialQa.warnings || []));
    if (liveOfficialQa.records?.length) retrievalWarnings.push(`live_official_qa_retrieved:${liveOfficialQa.records.length}`);
    const metadataById = new Map((liveOfficialQa.cardMetadata || []).map((item) => [String(item.id), item]));
    retrievalCards = retrievalCards.map((card) => ({ ...card, ...(metadataById.get(String(card.id || card.cardId)) || {}) }));
  }
  const officialMatches = liveOfficialQa.records?.length
    ? searchOfficialQaEvidence({
      question: userQuery,
      // Prefer the freshly hydrated locale over a stale/local record with the
      // same stable id. Otherwise the Japanese live question is silently
      // discarded in favour of an older English-only snapshot.
      records: dedupeBy([...liveOfficialQa.records, ...scopedRecordBuckets.officialQa], stableRecordKey),
      resolvedCards: effectiveQaIdentityCards,
      limit: Math.max(20, limits.maxOfficialQa * 4),
    })
    : localOfficialMatches;
  timingsMs.officialQa = Date.now() - stageStartedAt;
  const officialQaDirectCandidates = officialMatches.exact
    .filter((match) => isOfficialQaRecord(match.record))
    .map((match) => evidenceFromOfficialMatch(match, "official_qa", limits.maxEvidenceTextChars, retrievalWarnings))
    .slice(0, limits.maxOfficialQa);
  const directIds = new Set(officialQaDirectCandidates.map((item) => item.id));

  stageStartedAt = Date.now();
  const officialQaRelatedSource = dedupeBy([
    ...officialMatches.near.filter((match) => isOfficialQaRecord(match.record) && isUsefulOfficialRelatedMatch(match)),
    ...officialMatches.related.filter((match) => isOfficialQaRecord(match.record) && isUsefulOfficialRelatedMatch(match)),
    ...rankRecords({
      userQuery,
      records: scopedRecordBuckets.qa,
      resolvedCards: retrievalCards,
      mentionQueries,
      ruleSearchQueries: normalizedRuleQueries,
      allowNoCardMatch: retrievalCards.length === 0 && normalizedRuleQueries.length > 0,
    }),
  ], (item) => stableRecordKey(item?.record || item));
  if (officialQaRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`official_related_limited:${officialQaRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const officialQaRelated = officialQaRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((item) => item.record
      ? evidenceFromOfficialMatch(item, "related", limits.maxEvidenceTextChars, retrievalWarnings)
      : evidenceFromRecord(item, "related", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));

  const provisionalOfficialResponseSource = rankRecords({
    userQuery,
    records: scopedRecordBuckets.provisionalOfficialResponses,
    resolvedCards: retrievalCards,
    mentionQueries,
    ruleSearchQueries: normalizedRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0,
  });
  const provisionalOfficialResponses = provisionalOfficialResponseSource
    .slice(0, limits.maxOfficialQa)
    .map((record) => evidenceFromRecord(record, "official_response_screenshot", limits.maxEvidenceTextChars, retrievalWarnings));
  if (provisionalOfficialResponses.length) {
    retrievalWarnings.push(`provisional_official_responses_retrieved:${provisionalOfficialResponses.length}`);
  }

  const faqRelatedSource = rankRecords({
    userQuery,
    records: scopedRecordBuckets.faq,
    resolvedCards: retrievalCards,
    mentionQueries,
    ruleSearchQueries: normalizedRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0 && normalizedRuleQueries.length > 0,
  });
  if (faqRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`faq_related_limited:${faqRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const faqRelated = faqRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => evidenceFromRecord(record, "faq", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));

  const rawRelatedSource = rankRecords({
    userQuery,
    records: scopedRecordBuckets.rawRelated,
    resolvedCards: retrievalCards,
    mentionQueries,
    ruleSearchQueries: normalizedRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0,
  });
  if (rawRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`raw_related_limited:${rawRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const rawRelatedEvidence = rawRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => evidenceFromRecord(record, evidenceTypeForRecord(record, "related"), limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));
  timingsMs.relatedEvidence = Date.now() - stageStartedAt;
  timingsMs.total = Date.now() - retrievalStartedAt;

  if (!retrievalCards.length) retrievalWarnings.push("card_name_not_resolved_raw_query_fallback_used");
  if (!cardTexts.length && retrievalCards.length) retrievalWarnings.push("resolved_card_text_not_found");
  if (!officialQaDirectCandidates.length) retrievalWarnings.push("official_direct_qa_not_found");

  return {
    cardTexts: dedupeEvidence(cardTexts),
    userProvidedCardTexts: userProvidedCardTextEvidence,
    officialQaDirectCandidates: dedupeEvidence(officialQaDirectCandidates),
    officialQaRelated: dedupeEvidence(officialQaRelated),
    provisionalOfficialResponses: dedupeEvidence(provisionalOfficialResponses),
    faqRelated: dedupeEvidence(faqRelated),
    rawRelatedEvidence: dedupeEvidence([...rulebookCandidates.slice(0, limits.maxRelatedEvidence), ...rawRelatedEvidence]),
    rulebookCandidates,
    retrievedCards: retrievalCards,
    remainingUnresolvedMentions,
    fuzzyResolvedCards: fuzzyCards,
    baigeResolvedCards,
    baigeAmbiguousMentions: baigeDebug.ambiguousMentions,
    ruleSearchQueries: normalizedRuleQueries,
    retrievalWarnings,
    debug: {
      searchPaths: officialMatches.searchPaths || [],
      recordCount: allEvidenceRecords.length,
      cardCount: data.cards.length,
      userProvidedCardTextCount: providedTexts.length,
      rulebookCandidateCount: rulebookCandidates.length,
      scopedRecordCounts: {
        officialQa: scopedRecordBuckets.officialQa.length,
        qa: scopedRecordBuckets.qa.length,
        provisionalOfficialResponses: scopedRecordBuckets.provisionalOfficialResponses.length,
        faq: scopedRecordBuckets.faq.length,
        rawRelated: scopedRecordBuckets.rawRelated.length,
      },
      timingsMs,
      ruleSearchQueryCount: normalizedRuleQueries.length,
      ruleSearchQueries: normalizedRuleQueries,
      baigeSearchCount: baigeDebug.searchCount,
      baigeCacheHitCount: baigeDebug.cacheHitCount,
      baigeWarnings: baigeDebug.warnings,
      liveOfficialQa: liveOfficialQa.debug || {},
    },
  };
}

function rulebookSourceIdentity(record = {}) {
  return String(record.stableId || record.sourceRecordId || record.id || record.evidenceId || "")
    .replace(/@[a-f0-9]{8,}$/iu, "");
}

export async function loadRagData(dataDir = defaultDataDir) {
  const key = dataDir;
  if (dataCache.has(key)) return dataCache.get(key);
  const [cardsPayload, rulingsPayload, qaPayload, evidencePayload, rulebookPayload, officialResponsesPayload] = await Promise.all([
    readJson(join(dataDir, "cards.json"), { records: [] }),
    readJson(join(dataDir, "rulings.json"), { records: [] }),
    readJson(join(dataDir, "qa-index.json"), { records: [] }),
    readJson(join(dataDir, "evidence-index.json"), { records: [] }),
    readJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
    readJson(join(dataDir, "official-responses.json"), { records: [] }),
  ]);
  const bundledRulebookRecords = rulebookPayload.records || [];
  const hasBundledRulebook = bundledRulebookRecords.length > 0;
  const evidenceRecords = (evidencePayload.records || []).filter((record) => (
    !hasBundledRulebook
    || (record.sourceId !== "ocg-rule" && !rulebookSourceIdentity(record).startsWith("ocg-rule:"))
  ));
  const data = normalizeInjectedData({
    cards: cardsPayload.records || cardsPayload.cards || [],
    records: [
      ...(rulingsPayload.records || []),
      ...bundledRulebookRecords,
      ...evidenceRecords,
      ...normalizeOfficialResponses(officialResponsesPayload),
    ],
    qaRecords: qaPayload.records || [],
  });
  dataCache.set(key, data);
  return data;
}

export function evidenceBucketsToList(evidence = {}) {
  if (evidence && typeof evidence === "object") {
    const cached = evidenceListCache.get(evidence);
    if (cached) return cached;
  }
  const records = [
    ...(evidence.cardTexts || []),
    ...(evidence.userProvidedCardTexts || []),
    ...(evidence.officialQaDirectCandidates || []),
    ...(evidence.officialQaRelated || []),
    ...(evidence.provisionalOfficialResponses || []),
    ...(evidence.faqRelated || []),
    ...(evidence.rawRelatedEvidence || []),
  ];
  if (evidence && typeof evidence === "object") evidenceListCache.set(evidence, records);
  return records;
}

export function normalizeInjectedData({ cards = [], records = [], qaRecords = [] } = {}) {
  const sourceCards = Array.isArray(cards) ? cards : emptyDataArray;
  const sourceRecords = Array.isArray(records) ? records : emptyDataArray;
  const sourceQaRecords = Array.isArray(qaRecords) ? qaRecords : emptyDataArray;
  const cached = cachedNormalizedData(sourceCards, sourceRecords, sourceQaRecords);
  if (cached) return cached;

  const normalizedCards = normalizeDataArray(sourceCards, normalizedCardArrayCache, normalizeCard, (card) => card.name);
  const normalizedRecords = normalizeDataArray(sourceRecords, normalizedRecordArrayCache, normalizeRecord, (record) => record.id && record.text);
  const normalizedQaRecords = normalizeDataArray(sourceQaRecords, normalizedRecordArrayCache, normalizeRecord, (record) => record.id && record.text);
  const canonical = cachedNormalizedData(normalizedCards, normalizedRecords, normalizedQaRecords);
  if (canonical) {
    cacheNormalizedData(sourceCards, sourceRecords, sourceQaRecords, canonical);
    return canonical;
  }

  const data = { cards: normalizedCards, records: normalizedRecords, qaRecords: normalizedQaRecords };
  cacheNormalizedData(sourceCards, sourceRecords, sourceQaRecords, data);
  cacheNormalizedData(normalizedCards, normalizedRecords, normalizedQaRecords, data);
  return data;
}

function normalizeDataArray(source, cache, normalizer, predicate) {
  const cached = cache.get(source);
  if (cached) return cached;
  const normalized = source.map(normalizer).filter(predicate);
  cache.set(source, normalized);
  cache.set(normalized, normalized);
  return normalized;
}

function cachedNormalizedData(cards, records, qaRecords) {
  return normalizedDataCache.get(records)?.get(cards)?.get(qaRecords) || null;
}

function cacheNormalizedData(cards, records, qaRecords, data) {
  let byCards = normalizedDataCache.get(records);
  if (!byCards) {
    byCards = new WeakMap();
    normalizedDataCache.set(records, byCards);
  }
  let byQaRecords = byCards.get(cards);
  if (!byQaRecords) {
    byQaRecords = new WeakMap();
    byCards.set(cards, byQaRecords);
  }
  byQaRecords.set(qaRecords, data);
}

function evidenceRecordBuckets(data) {
  const cached = evidenceRecordBucketsCache.get(data);
  if (cached) return cached;
  const all = [...data.records, ...data.qaRecords];
  const buckets = {
    all,
    officialQa: data.qaRecords.filter((record) => ["qa", "card-faq", "official-database"].includes(record.recordType)),
    qa: data.qaRecords.filter((record) => record.recordType === "qa"),
    provisionalOfficialResponses: all.filter(isProvisionalOfficialResponseRecord),
    faq: all.filter((record) => record.recordType === "card-faq"),
    rawRelated: all.filter((record) => !["card-faq", "card-text"].includes(record.recordType) && !isRulebookRecord(record) && !isProvisionalOfficialResponseRecord(record)),
  };
  evidenceRecordBucketsCache.set(data, buckets);
  return buckets;
}

function scopeRecordBuckets(buckets, resolvedCards) {
  return {
    officialQa: recordsForResolvedCards(buckets.officialQa, resolvedCards),
    qa: recordsForResolvedCards(buckets.qa, resolvedCards),
    provisionalOfficialResponses: recordsForResolvedCards(buckets.provisionalOfficialResponses, resolvedCards),
    faq: recordsForResolvedCards(buckets.faq, resolvedCards),
    rawRelated: recordsForResolvedCards(buckets.rawRelated, resolvedCards),
  };
}

function recordsForResolvedCards(records, resolvedCards) {
  const identities = cardIdentityKeys(resolvedCards);
  if (!identities.length || !(records || []).length) return records || [];
  const index = recordIdentityIndex(records);
  const matched = new Set();
  for (const identity of identities) {
    for (const record of index.get(identity) || []) matched.add(record);
  }
  return matched.size ? [...matched] : records;
}

function cardIdentityKeys(cards) {
  const keys = [];
  const seen = new Set();
  for (const card of cards || []) {
    const id = normalizeId(card.id || card.cardId);
    if (id && !seen.has("id:" + id)) {
      seen.add("id:" + id);
      keys.push("id:" + id);
    }
    for (const name of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(name);
      if (!key || seen.has("name:" + key)) continue;
      seen.add("name:" + key);
      keys.push("name:" + key);
    }
  }
  return keys;
}

function canonicalizeQaIdentityCards(cards, canonicalCards, warnings) {
  const index = canonicalCardIdentityIndex(canonicalCards);
  return (cards || []).map((card) => {
    const currentId = normalizeId(card.id || card.cardId);
    const direct = currentId ? index.byId.get(currentId) : null;
    if (direct) return mergeQaIdentityCard(card, direct);

    const candidates = new Set();
    for (const name of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(name);
      if (!key) continue;
      for (const candidate of index.byAlias.get(key) || []) candidates.add(candidate);
    }
    if (candidates.size !== 1) {
      if (candidates.size > 1) {
        warnings.push(`qa_identity_canonicalization_ambiguous:${card.name || card.input || currentId}`);
      }
      return card;
    }
    const canonical = [...candidates][0];
    const canonicalId = normalizeId(canonical.id || canonical.cardId);
    if (!canonicalId || canonicalId === currentId) return mergeQaIdentityCard(card, canonical);
    warnings.push(`qa_identity_canonicalized:${currentId || "name"}->${canonicalId}`);
    return {
      ...mergeQaIdentityCard(card, canonical),
      qaIdentityOriginalId: String(card.id || card.cardId || ""),
      id: canonicalId,
      cardId: canonicalId,
    };
  });
}

function canonicalCardIdentityIndex(cards) {
  const cached = canonicalCardIdentityIndexCache.get(cards);
  if (cached) return cached;
  const byId = new Map();
  const byAlias = new Map();
  for (const card of cards || []) {
    const id = normalizeId(card.id || card.cardId);
    if (id) byId.set(id, card);
    for (const name of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(name);
      if (!key) continue;
      const matches = byAlias.get(key) || [];
      matches.push(card);
      byAlias.set(key, matches);
    }
  }
  const index = { byId, byAlias };
  canonicalCardIdentityIndexCache.set(cards, index);
  return index;
}

function mergeQaIdentityCard(card, canonical) {
  return {
    ...card,
    aliases: [...new Set([
      ...(card.aliases || []),
      card.name,
      card.cnName,
      card.jaName,
      card.enName,
      ...(canonical.aliases || []),
      canonical.name,
      canonical.cnName,
      canonical.jaName,
      canonical.enName,
    ].filter(Boolean))],
  };
}

function recordIdentityIndex(records) {
  const cached = recordIdentityIndexCache.get(records);
  if (cached) return cached;
  const index = new Map();
  for (const record of records || []) {
    const keys = new Set([
      ...(record.cardIds || []).map((id) => "id:" + normalizeId(id)).filter((key) => key !== "id:"),
      ...(record.cards || []).map((name) => "name:" + normalizeCardKey(name)).filter((key) => key !== "name:"),
      ...extractInlineCardIds([
        record.question,
        record.title,
        record.text,
        record.answer,
        record.conclusion,
      ].filter(Boolean).join("\n")).map((id) => "id:" + normalizeId(id)),
    ]);
    const directId = normalizeId(record.cardId);
    if (directId) keys.add("id:" + directId);
    for (const key of keys) {
      const matches = index.get(key) || [];
      matches.push(record);
      index.set(key, matches);
    }
  }
  recordIdentityIndexCache.set(records, index);
  return index;
}

function normalizeCard(card = {}) {
  return {
    ...card,
    id: String(card.id || card.cardId || ""),
    cardId: String(card.cardId || card.id || ""),
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: [
      card.name,
      card.cnName,
      card.jaName,
      card.enName,
      ...(Array.isArray(card.aliases) ? card.aliases : []),
    ].filter(Boolean),
  };
}

function normalizeRecord(record = {}) {
  const id = String(record.id || record.evidenceId || record.stableId || record.sourceId || "");
  const answer = record.answer || record.conclusion || "";
  const structuredQaText = record.question && answer
    ? [record.question, answer].filter(Boolean).join("\n").trim()
    : "";
  const text = structuredQaText || String(record.text || record.officialText || record.question || answer || record.title || "").trim();
  const cardIds = [...new Set([
    record.cardId,
    ...(record.cardIds || []),
    ...extractInlineCardIds(text),
  ].map((item) => String(item || "")).filter(Boolean))];
  const questionCardIds = [...new Set([
    ...(record.questionCardIds || []),
    ...extractInlineCardIds([record.question, record.title].filter(Boolean).join("\n")),
  ].map((item) => String(item || "")).filter(Boolean))];
  const cards = [record.cardName, ...(record.cards || []), ...(record.cardNames || [])].filter(Boolean);
  return {
    ...record,
    id,
    recordType: record.recordType || inferRecordType(record, id),
    title: record.title || record.question || id,
    question: record.question || "",
    answer: record.answer || record.conclusion || "",
    text,
    cardIds,
    questionCardIds,
    cards,
    sourceUrl: evidenceSourceUrl({ ...record, cardIds }),
    status: record.status || "current",
  };
}

function inferRecordType(record, id) {
  if (String(id).startsWith("card-text-")) return "card-text";
  if (String(id).startsWith("card-faq-")) return "card-faq";
  if (record.question || String(id).includes("qa")) return "qa";
  return "related";
}

function findCardRecord(card, cards) {
  const wantedId = normalizeId(card.id || card.cardId);
  const wantedNames = new Set([card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].map(normalizeCardKey).filter(Boolean));
  return cards.find((item) => wantedId && normalizeId(item.id || item.cardId) === wantedId)
    || cards.find((item) => item.aliases.some((alias) => wantedNames.has(normalizeCardKey(alias))))
    || null;
}

function cardTextEvidence(card, maxTextChars, warnings) {
  const text = String(card.effectText || card.text || "");
  const truncated = text.length > maxTextChars;
  if (truncated) warnings.push(`card_text_truncated:${card.id || normalizeCardKey(card.name)}`);
  const isBaige = card.source === "baige" || card.provider === "baige";
  const identityNames = cardIdentityNames(card);
  return {
    id: `card-text-${card.id || normalizeCardKey(card.name)}`,
    type: isBaige ? "baige_card_text" : "card_text",
    title: `${card.name} 的卡片文本`,
    cardIds: [card.id || card.cardId].filter(Boolean).map(String),
    cards: identityNames,
    identityKeys: identityNames.map(normalizeCardKey).filter(Boolean),
    input: card.input || "",
    matchedQuery: card.matchedQuery || "",
    name: card.name || "",
    cnName: card.cnName || "",
    jaName: card.jaName || card.jpName || "",
    enName: card.enName || "",
    aliases: card.aliases || [],
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: card.sourceUrl || "",
    source: isBaige ? "baige" : card.source || "",
    cardType: card.cardType || card.type || "",
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? card.rank ?? card.link ?? null,
    official: false,
    isDirect: false,
  };
}

function mergeCanonicalCardEvidenceProfile(resolvedCard = {}, canonicalCard = null) {
  if (!canonicalCard) return resolvedCard;
  return {
    ...resolvedCard,
    ...canonicalCard,
    input: resolvedCard.input || canonicalCard.input || "",
    matchedQuery: resolvedCard.matchedQuery || canonicalCard.matchedQuery || "",
    aliases: cardIdentityNames(resolvedCard, canonicalCard),
    confidence: resolvedCard.confidence ?? canonicalCard.confidence,
  };
}

function cardIdentityNames(...cards) {
  const seen = new Set();
  const result = [];
  for (const card of cards.filter(Boolean)) {
    for (const value of [
      card.input,
      card.matchedQuery,
      card.name,
      card.cnName,
      card.jaName,
      card.jpName,
      card.enName,
      ...(card.aliases || []),
    ]) {
      const text = String(value || "").trim();
      const key = normalizeCardKey(text);
      if (!text || !key || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

function userProvidedTextEvidence(item, index, maxTextChars, warnings) {
  const text = String(item.text || "");
  const key = normalizeCardKey(item.name) || `card-${index + 1}`;
  const truncated = text.length > maxTextChars;
  if (truncated) warnings.push(`user_provided_text_truncated:${key}`);
  return {
    id: `user-card-text-${key}`,
    type: "user_provided_text",
    title: `${item.name} 的用户提供文本`,
    cardIds: [],
    cards: [item.name].filter(Boolean),
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: "",
    source: "user_provided_text",
    official: false,
    isDirect: false,
  };
}

function evidenceFromOfficialMatch(match, type, maxTextChars, warnings) {
  const record = match.record || {};
  return {
    ...evidenceFromRecord(record, type, maxTextChars, warnings),
    score: match.score,
    matchLevel: match.matchLevel,
    matchedBy: match.matchedBy || [],
    matchedQuestionCardIds: match.matchedQuestionCardIds || [],
    questionCardIdCoverage: Number(match.questionCardIdCoverage || 0),
    questionCardIdCount: Number(match.questionCardIdCount || 0),
    authoritativeSceneMatch: match.authoritativeSceneMatch === true,
    authoritativeSceneMatchReason: match.authoritativeSceneMatchReason || "",
    candidatePoolComplete: match.candidatePoolComplete === true,
    distinctiveSemanticHits: match.distinctiveSemanticHits || [],
    effectNumberCompatible: match.effectNumberCompatible !== false,
    sceneQualifiersCompatible: match.sceneQualifiersCompatible !== false,
    isDirect: match.matchLevel === "official_qa_exact",
  };
}

function evidenceFromRecord(record, type, maxTextChars = 1600, warnings = []) {
  const text = String(record.text || record.answer || record.conclusion || "");
  const truncated = text.length > maxTextChars;
  if (truncated) warnings.push(`${type}_text_truncated:${record.id || record.evidenceId || record.stableId}`);
  return {
    id: String(record.id || record.evidenceId || record.stableId || ""),
    type,
    recordType: record.recordType || "",
    title: record.title || record.question || String(record.id || "资料"),
    cardIds: record.cardIds || [],
    questionCardIds: record.questionCardIds || [],
    cards: record.cards || record.cardNames || [],
    question: record.question || "",
    rawQuestion: record.rawQuestion || "",
    rawDetailedQuestion: record.rawDetailedQuestion || "",
    answer: record.answer || record.conclusion || "",
    retrievalContext: record.retrievalContext || {},
    fullText: text,
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: record.sourceUrl || record.officialUrl || "",
    sourceType: record.sourceType || "",
    displayStatus: record.displayStatus || "",
    maxStatus: record.maxStatus || "",
    officialVerdict: record.officialVerdict ?? record.verdict ?? "unknown",
    officialText: record.officialText || "",
    explanation: record.explanation || "",
    scenario: record.scenario || record.question || "",
    isDirect: false,
  };
}

function evidenceSourceUrl(record = {}) {
  const cardId = (record.cardIds || []).map(normalizeId).find(Boolean);
  if (record.recordType === "card-faq" && cardId) {
    return `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=4&cid=${encodeURIComponent(cardId)}&request_locale=ja`;
  }
  const existing = record.sourceUrl || record.officialUrl || "";
  if (existing) return existing;
  const qaId = String(record.sourceId || record.id || "").match(/(?:ygoresources-qa-)?(\d{3,})$/u)?.[1];
  if (record.recordType === "qa" && qaId) {
    return `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=${encodeURIComponent(qaId)}&keyword=&tag=-1&request_locale=ja`;
  }
  return "";
}

function isOfficialQaRecord(record = {}) {
  return ["qa", "official-database"].includes(record.recordType);
}

function officialQaNumericId(record = {}) {
  const direct = String(record.sourceRecordId || record.sourceId || "").match(/^\d+$/u)?.[0];
  if (direct) return direct;
  return String(record.stableId || record.id || "").match(/(?:ygoresources-qa-|official-qa-)(\d+)$/u)?.[1] || "";
}

function isUsefulOfficialRelatedMatch(match = {}) {
  return match.cardMatch === true
    || match.matchLevel === "official_qa_exact"
    || (match.matchLevel === "official_qa_near" && Number(match.score || 0) >= 0.68)
    || Number(match.score || 0) >= 0.78;
}

function isProvisionalOfficialResponseRecord(record = {}) {
  return record.sourceType === "official_response_screenshot"
    || record.recordType === "official-response-screenshot";
}

function evidenceTypeForRecord(record = {}, fallback = "related") {
  const id = String(record.id || record.evidenceId || record.stableId || "");
  if (record.recordType === "rule-doc" || record.recordType === "rule-test" || record.sourceId === "ocg-rule" || id.startsWith("ocg-rule:")) {
    return "rulebook";
  }
  return fallback;
}

function rankRecords({ userQuery, records, resolvedCards, mentionQueries = [], ruleSearchQueries = [], allowNoCardMatch = false }) {
  const queryTerms = tokenize([userQuery, ...mentionQueries].join(" "));
  const ruleQueries = normalizeRuleSearchQueries(ruleSearchQueries, { maxRuleSearchQueries: 8 });
  const ruleTerms = tokenize(ruleQueries.map((item) => item.query).join(" "));
  const rulePhrases = ruleQueries.map((item) => normalizeCardKey(item.query)).filter(Boolean);
  const queryKey = normalizeCardKey(userQuery);
  const resolvedIds = new Set((resolvedCards || []).map((card) => normalizeId(card.id || card.cardId)).filter(Boolean));
  const resolvedNames = new Set((resolvedCards || []).flatMap((card) => [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]).map(normalizeCardKey).filter(Boolean));
  const unresolvedNames = new Set((mentionQueries || []).map(normalizeCardKey).filter(Boolean));
  const contextTerms = buildContextTerms({ userQuery, mentionQueries, ruleQueries, resolvedCards });
  const ranked = (records || [])
    .filter((record) => record.status !== "removed" && record.status !== "superseded")
    .map((record) => ({
      record,
      score: scoreRecord(record, {
        queryTerms,
        ruleTerms,
        rulePhrases,
        queryKey,
        resolvedIds,
        resolvedNames,
        unresolvedNames,
        allowNoCardMatch,
      }),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || String(left.record.id).localeCompare(String(right.record.id)))
    .map((item) => attachContextSnippet(item.record, contextTerms));
  return dedupeBy(ranked, stableRecordKey);
}

function scoreRecord(record, { queryTerms, ruleTerms, rulePhrases, queryKey, resolvedIds, resolvedNames, unresolvedNames, allowNoCardMatch }) {
  const text = `${record.title || ""}\n${record.text || ""}`;
  const { textKey, normalizedCardIds, normalizedCardNames } = retrievalRecordFeatures(record, text);
  const cardIdMatch = normalizedCardIds.some((id) => resolvedIds.has(id));
  const cardNameMatch = normalizedCardNames.some((name) => resolvedNames.has(name)) || [...resolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, text) && textKey.includes(name));
  const unresolvedNameMatch = [...unresolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, text) && textKey.includes(name));
  const cardScore = cardIdMatch ? 5 : cardNameMatch ? 4 : unresolvedNameMatch ? 2 : 0;
  if (!allowNoCardMatch && resolvedIds.size + resolvedNames.size > 0 && !cardScore) return 0;
  let score = cardScore;
  const lexicalHits = new Set();
  for (const term of queryTerms) {
    if (textKey.includes(term)) {
      score += 1;
      lexicalHits.add(term);
    }
  }
  for (const term of ruleTerms || []) {
    if (textKey.includes(term)) {
      score += 2;
      lexicalHits.add(term);
    }
  }
  let phraseMatched = false;
  for (const phrase of rulePhrases || []) {
    if (phrase.length >= 4 && textKey.includes(phrase.slice(0, Math.min(phrase.length, 80)))) {
      score += 4;
      phraseMatched = true;
    }
  }
  const fullQueryMatched = queryKey.length >= 8 && textKey.includes(queryKey.slice(0, Math.min(queryKey.length, 80)));
  if (fullQueryMatched) score += 5;
  if (!cardScore && !phraseMatched && !fullQueryMatched && lexicalHits.size < 3) return 0;
  if (score <= 0) return 0;
  if (record.recordType === "qa") score += 0.5;
  if (record.recordType === "card-faq") score += 0.4;
  return score;
}

function retrievalRecordFeatures(record = {}, preparedText) {
  if (record && typeof record === "object") {
    const cached = retrievalRecordFeatureCache.get(record);
    if (cached) return cached;
  }
  const text = preparedText ?? [record.title || "", record.text || ""].join("\n");
  const features = {
    textKey: normalizeCardKey(text),
    normalizedCardIds: (record.cardIds || []).map(normalizeId).filter(Boolean),
    normalizedCardNames: (record.cards || []).map(normalizeCardKey).filter(Boolean),
  };
  if (record && typeof record === "object") retrievalRecordFeatureCache.set(record, features);
  return features;
}

function normalizeRuleSearchQueries(items, limits = {}) {
  const max = readPositiveNumber(limits.maxRuleSearchQueries || limits.maxRelatedEvidence, 8);
  const source = Array.isArray(items) ? items : [];
  const normalized = source
    .map((item) => typeof item === "string"
      ? { query: item, reason: "", confidence: "medium", source: "rule_search_query" }
      : {
          query: String(item?.query || item?.searchQuery || item?.keyword || item?.topic || "").trim(),
          reason: String(item?.reason || "").trim(),
          confidence: item?.confidence || "medium",
          source: item?.source || "rule_search_query",
        })
    .map((item) => ({
      ...item,
      query: item.query.replace(/\s+/gu, " ").slice(0, 120),
      reason: item.reason.replace(/\s+/gu, " ").slice(0, 120),
    }))
    .filter((item) => item.query && /[A-Za-z\u3040-\u30ff\u3400-\u9fff0-9]/u.test(item.query));
  return dedupeBy(normalized, (item) => normalizeCardKey(item.query)).slice(0, max);
}

function deriveRuleSearchQueries(userQuery) {
  const query = buildGenericRuleQuery(userQuery);
  const generic = query ? [{
    query,
    reason: "从题目中的操作、时点、位置和连锁描述生成通用规则检索词。",
    confidence: "medium",
    source: "derived_rule_search_query",
  }] : [];
  return dedupeBy([
    ...deriveMechanismRuleQueries(userQuery),
    ...generic,
  ], (item) => normalizeCardKey(item.query));
}

function deriveRuleSearchQueriesFromCardTexts(userQuery, cardTexts = []) {
  const questionContext = buildGenericRuleQuery(userQuery).slice(0, 56);
  const perCardQueries = (cardTexts || []).map((item) => {
    const cardLabel = [...(item.cards || []), item.cardType].filter(Boolean).join(" ");
    return splitCardTextClauses(item.text)
      .filter((clause) => clause.length >= 4 && containsOperationLanguage(clause))
      .map((clause) => ({
        query: expandRetrievalVocabulary(`${questionContext} ${cardLabel} ${clause}`).slice(0, 120),
        reason: `根据${(item.cards || [item.title || "卡片"]).join("、")}的处理句检索对应规则。`,
        confidence: "medium",
        source: "card_text_derived_rule_search_query",
      }))
      .filter((entry) => entry.query)
      .slice(0, 4);
  });
  const interleaved = roundRobin(perCardQueries, 12);
  const combinedText = [userQuery, ...(cardTexts || []).map((item) => `${(item.cards || []).join(" ")} ${item.cardType || ""} ${item.text || ""}`)].join("\n");
  return dedupeBy([
    ...deriveScenarioMechanismRuleQueries(userQuery, cardTexts),
    ...deriveMechanismRuleQueries(combinedText),
    ...interleaved,
  ], (item) => normalizeCardKey(item.query)).slice(0, 12);
}

function deriveScenarioMechanismRuleQueries(userQuery, cardTexts) {
  const scenario = compileRuleScenario({ userQuery, cardTexts });
  const queries = [];
  const add = (query, reason) => queries.push({
    query: expandRetrievalVocabulary(query).slice(0, 120),
    reason,
    confidence: "high",
    source: "compiled_scenario_rule_search_query",
  });
  if (scenario.mandatoryFieldSpellTrapReturn && scenario.currentChainSpellTrap) {
    add("魔法陷阱卡 发动中 连锁途中 回到手卡 回到卡组", "卡文包含必做的场上魔法・陷阱返回处理，题目中的当前连锁卡是魔法・陷阱。 ");
    if (scenario.noOtherSpellTraps) {
      add("发动后的非永续魔法陷阱 除自身以外没有能适用的卡时不能发动", "场景角色表明当前发动卡是唯一可能候选，检索必做处理无可适用卡时的发动限制。 ");
    }
  }
  if (scenario.simultaneousDestructionReplacement) {
    add("同一时点 双方 代替破坏 回合玩家 先适用 非回合玩家 不在场 不适用", "从双方效果载体、同一破坏事件及代替破坏卡文推导适用顺序规则。 ");
    add("代替破坏 先适用 更新场面 重新检查 效果载体", "检索第一个代替处理改变场面后，第二个代替效果是否仍适用。 ");
  }
  return queries;
}

function deriveMechanismRuleQueries(value) {
  const text = String(value || "");
  const queries = [];
  const add = (query, reason) => queries.push({
    query: expandRetrievalVocabulary(query).slice(0, 120),
    reason,
    confidence: "high",
    source: "mechanism_rule_search_query",
  });
  if (/(?:连锁|連鎖|チェーン|\bC\d+\b|chain)/iu.test(text) && /(除外|送去墓地|送墓|离场|離場|不在|回到手|返回手|回到卡组|返回卡组|回去|位置)/u.test(text)) {
    add("已经发动的效果 连锁处理中 发动效果的卡离开原位置 效果处理", "检索发动源在连锁处理中改变位置后的处理规则。");
    add("效果处理 部分不能处理 后续处理 尽可能处理", "检索一项处理不能完成时其余处理是否继续。");
  }
  if (/(对象|對象|対象|target)/iu.test(text) && /(丢失|丟失|离场|離場|不在|除外|回到|返回|送去墓地|送墓)/u.test(text)) {
    add("效果处理时 对象不在原位置 对象丢失 其他处理 后续处理", "检索处理时对象不再存在时各项处理的适用范围。");
  }
  if (/(无效|無效|negate)/iu.test(text) && /(破坏|破壊|destroy)/iu.test(text)) {
    add("魔法陷阱 卡的发动无效 效果发动无效 场上的卡 破坏", "区分卡的发动与效果发动被无效后的场上状态。");
  }
  if (/(?:舍弃|丢弃|捨て|送去墓地|送墓|支付|支払|cost|コスト)/iu.test(text) && /(?:发动|發動|発動)/u.test(text)) {
    add("卡片效果发动 支付cost 顺序 支付后 状态立即变化", "检索发动时支付 cost 的顺序以及支付后卡片位置何时改变。");
    add("支付cost后 效果处理前 永续效果 适用条件重新判断", "检索 cost 改变场面后，连锁处理前持续适用效果是否开始或停止适用。");
  }
  if (/(?:代替破坏|破坏.{0,12}代替|破壊.{0,12}代わり|替代破坏)/u.test(text)
      && /(?:同时|同一时点|双方|多个|复数|複数|各自|都要|一起)/u.test(text)) {
    add("同一时点 多个不入连锁效果 适用顺序 回合玩家 非回合玩家", "检索多个不入连锁效果同时适用时的先后顺序。");
    add("同时适用 多个代替破坏效果 回合玩家先适用 重新判断", "检索双方代替破坏效果竞争时是否依次适用并重新判断场面。");
  }
  if (/(不受.{0,8}效果影响|不受效果|unaffected)/iu.test(text) && /(对象|對象|対象|target)/iu.test(text)) {
    add("不受其他卡的效果影响 可以成为效果对象 对象选择 效果适用", "分别检索对象选择限制与效果抗性。");
  }
  if (/(魔法|陷阱|罠)/u.test(text) && /(回到手|返回手|放回手|回到卡组|返回卡组|回去|戻)/u.test(text)) {
    add("魔法陷阱卡 发动中 连锁途中 回到手卡 回到卡组", "检索发动中魔法陷阱的位置移动限制。");
    if (/(没有其他|不存在其他|并无其他|无其他|只有.{0,24}(?:1|一)张|除.{0,20}以外没有|no other|none)/iu.test(text)) {
      add("发动后的非永续魔法陷阱 除自身以外没有能适用的卡时不能发动", "检索唯一候选受位置移动限制时，必做处理是否导致不能发动。");
    }
  }
  if (/(然后|那之后|之后|之後|并且|並且|再|仍然|尽可能|不能处理)/u.test(text)) {
    add("效果文本 连续处理 前一项不能处理 后续处理 是否进行", "检索多段效果的处理顺序和依赖关系。");
  }
  return dedupeBy(queries, (item) => normalizeCardKey(item.query));
}

function splitCardTextClauses(value) {
  return String(value || "")
    .replace(/(?=[①②③④⑤⑥⑦⑧⑨●])/gu, "\n")
    .split(/[。；;\n]+/u)
    .map((item) => item.replace(/^[①②③④⑤⑥⑦⑧⑨\d●]+[：:.、]?/u, "").trim())
    .filter(Boolean);
}

function roundRobin(groups, limit) {
  const result = [];
  const source = (groups || []).filter((group) => Array.isArray(group) && group.length);
  for (let index = 0; result.length < limit; index += 1) {
    let added = false;
    for (const group of source) {
      if (group[index]) {
        result.push(group[index]);
        added = true;
        if (result.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return result;
}

function mergeRuleSearchQueries(baseQueries, cardQueries, limits) {
  const max = readPositiveNumber(limits.maxRuleSearchQueries, 12);
  const base = normalizeRuleSearchQueries(baseQueries, { maxRuleSearchQueries: max });
  const card = normalizeRuleSearchQueries(cardQueries, { maxRuleSearchQueries: max });
  const cardQuota = Math.min(card.length, Math.max(3, Math.floor(max / 2)));
  const baseQuota = Math.max(0, max - cardQuota);
  return normalizeRuleSearchQueries([
    ...base.slice(0, baseQuota),
    ...card.slice(0, cardQuota),
    ...base.slice(baseQuota),
    ...card.slice(cardQuota),
  ], { maxRuleSearchQueries: max });
}

function buildGenericRuleQuery(value) {
  const withoutCardNames = String(value || "")
    .normalize("NFKC")
    .replace(/[「『《【\[].*?[」』》】\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalizeCardKey(withoutCardNames).length < 4) return "";
  return expandRetrievalVocabulary(withoutCardNames).slice(0, 120);
}

function containsOperationLanguage(value) {
  return /(发动|發動|発動|处理|處理|适用|適用|选择|選擇|对象|對象|支付|cost|连锁|連鎖|チェーン|召唤|召喚|破坏|破壊|除外|送去|送墓|回到|返回|回去|放回|戻|攻击|攻擊|攻撃|无效|無效|抽|加入手|特殊召唤|特殊召喚)/iu.test(String(value || ""));
}

function expandRetrievalVocabulary(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  const additions = [];
  if (/(发动|發動|発動)/u.test(text)) additions.push("发动 発動");
  if (/(连锁|連鎖|チェーン|chain)/iu.test(text)) additions.push("连锁 チェーン chain");
  if (/(处理|處理|适用|適用|解決|resolve)/iu.test(text)) additions.push("处理 適用 解決 resolve");
  if (/(手卡|手牌|手札|hand)/iu.test(text)) additions.push("手卡 手牌 手札 hand");
  if (/(回到|返回|回去|放回|弹回|彈回|戻|return)/iu.test(text)) additions.push("回到 返回 回去 戻 return");
  if (/(墓地|送墓|graveyard)/iu.test(text)) additions.push("墓地 送去墓地 graveyard");
  if (/(除外|banish)/iu.test(text)) additions.push("除外 banish");
  if (/(破坏|破壊|destroy)/iu.test(text)) additions.push("破坏 破壊 destroy");
  if (/(攻击|攻擊|攻撃|attack)/iu.test(text)) additions.push("攻击 攻撃 attack 战斗 バトル");
  if (/(次数|回数|多次|两次|兩次|[一二三四五六七八九十\d]+次|twice)/iu.test(text)) additions.push("次数 回数 多次 twice");
  return [...new Set([text, ...additions].filter(Boolean))].join(" ");
}

function buildContextTerms({ userQuery, mentionQueries = [], ruleQueries = [], resolvedCards = [] } = {}) {
  return [...new Set([
    ...String(userQuery || "").split(/[，,。.!！?？;；、\s]+/u),
    ...mentionQueries,
    ...ruleQueries.flatMap((item) => [item.query, item.reason]),
    ...(resolvedCards || []).flatMap((card) => [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]),
  ]
    .map((item) => String(item || "").trim())
    .filter((item) => normalizeCardKey(item).length >= 2))]
    .slice(0, 80);
}

function attachContextSnippet(record, terms = []) {
  const text = String(record?.text || "");
  const isRulebook = evidenceTypeForRecord(record, "") === "rulebook";
  if (!isRulebook && text.length <= 2200) return record;
  if (!isRulebook && !/^contents\s+menu/iu.test(text)) return record;
  const snippet = selectContextSnippet(text, terms, 2200);
  return snippet && snippet !== text ? { ...record, text: snippet, contextSnippet: true } : record;
}

function selectContextSnippet(text, terms = [], maxChars = 2200) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/u)
    .map((item) => item.trim())
    .filter((item) => item && !isNavigationParagraph(item));
  if (!paragraphs.length) return "";
  const normalizedTerms = terms.map(normalizeCardKey).filter((item) => item.length >= 2);
  let bestIndex = -1;
  let bestScore = 0;
  paragraphs.forEach((paragraph, index) => {
    const key = normalizeCardKey(paragraph);
    let score = 0;
    for (const term of normalizedTerms) {
      if (!term) continue;
      if (key.includes(term)) score += Math.min(8, Math.max(1, term.length / 2));
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  if (bestIndex < 0 || bestScore <= 0) return joinParagraphsToLimit(paragraphs, maxChars);

  const selected = [];
  for (let index = Math.max(0, bestIndex - 1); index < paragraphs.length; index += 1) {
    if (index > bestIndex + 10 && selected.join("\n\n").length > maxChars * 0.65) break;
    selected.push(paragraphs[index]);
    if (selected.join("\n\n").length >= maxChars) break;
  }
  const snippet = selected.join("\n\n");
  return snippet.length > maxChars ? `${snippet.slice(0, maxChars - 1)}…` : snippet;
}

function isNavigationParagraph(value) {
  const text = String(value || "").trim();
  if (/^(?:contents|menu|skip to content|toggle .*|expand|light mode|dark mode|auto light.*|hide navigation.*|hide table.*|back to top|view this page|ocg rule)$/iu.test(text)) return true;
  if (text.length < 120 && /(toggle|navigation sidebar|table of contents|规则修订|toggle navigation)/iu.test(text)) return true;
  return false;
}

function joinParagraphsToLimit(paragraphs, maxChars) {
  const selected = [];
  for (const paragraph of paragraphs) {
    selected.push(paragraph);
    if (selected.join("\n\n").length >= maxChars) break;
  }
  const text = selected.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function tokenize(value) {
  const base = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}①②③④⑤⑥⑦⑧⑨]+/u)
    .map(normalizeCardKey)
    .filter((item) => item.length >= 2)
    .slice(0, 30);
  const grams = [];
  for (const item of base) {
    if (/[\u3400-\u9fff]/u.test(item) && item.length > 4) {
      for (let index = 0; index < item.length - 1; index += 1) grams.push(item.slice(index, index + 2));
    }
  }
  return [...new Set([...base, ...grams])].slice(0, 60);
}

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}

function extractInlineCardIds(value) {
  return [...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)]
    .map((match) => match[1]);
}

function collectParentheticalAliasMentionKeys(unresolvedMentions, resolvedCards) {
  const reliableIdentityKeys = new Set();
  for (const card of resolvedCards || []) {
    const confidence = card?.confidence === undefined ? 1 : Number(card.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.9) continue;
    for (const value of [card.input, card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(value);
      if (key) reliableIdentityKeys.add(key);
    }
  }
  const coveredKeys = new Set();
  for (const mention of unresolvedMentions || []) {
    const input = String(mention?.input || "").trim();
    const match = input.match(/^(.+?)[（(]([^（）()]+)[）)]$/u);
    if (!match) continue;
    const innerKey = normalizeCardKey(match[2]);
    if (!innerKey || !reliableIdentityKeys.has(innerKey)) continue;
    coveredKeys.add(normalizeCardKey(input));
    coveredKeys.add(normalizeCardKey(match[1]));
  }
  return coveredKeys;
}

function resolveUnresolvedMentionCards(unresolvedMentions, cardProvider, limits, warnings) {
  const result = [];
  const minConfidence = readPositiveDecimal(limits.localFuzzyMinConfidence, 0.74);
  for (const mention of unresolvedMentions || []) {
    if (result.length >= limits.maxCards) break;
    for (const query of mentionSearchQueries(mention)) {
      const matches = cardProvider.searchCardByName(query, 2);
      if (!matches.length) continue;
      const best = matches[0];
      if (best.confidence < minConfidence) {
        warnings.push(`unresolved_mention_fuzzy_low_confidence:${query}->${best.name}:${best.confidence}`);
        continue;
      }
      warnings.push(`unresolved_mention_fuzzy_match:${query}->${best.name}`);
      result.push({
        ...best,
        input: mention.input,
        matchedQuery: query,
        confidence: Math.min(best.confidence, 0.7),
      });
      break;
    }
  }
  return dedupeCards(result);
}

async function resolveUnresolvedMentionCardsWithBaige(unresolvedMentions, { fetchImpl, env, limits, warnings, debug }) {
  const mentions = (unresolvedMentions || []).slice(0, limits.maxCards);
  const minConfidence = readPositiveDecimal(env.RAG_BAIGE_MIN_CONFIDENCE, 0.72);
  const result = await Promise.all(mentions.map(async (mention) => {
    let bestLowConfidence = null;
    let bestLowConfidenceCandidates = [];
    let bestLowConfidenceQuery = "";
    for (const query of mentionSearchQueries(mention)) {
      const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug });
      warnings.push(...searchResult.warnings);
      const candidates = searchResult.results || [];
      if (!candidates.length) {
        warnings.push(`baige_no_result:${query}`);
        continue;
      }
      const best = candidates[0];
      const confidence = Number(best.confidence || 0);
      if (confidence >= minConfidence) {
        warnings.push(`baige_match:${query}->${best.name}`);
        return {
          ...toRagCard(best, mention.input, confidence),
          matchedQuery: query,
        };
      }
      if (!bestLowConfidence || confidence > Number(bestLowConfidence.confidence || 0)) {
        bestLowConfidence = best;
        bestLowConfidenceCandidates = candidates.slice(0, 3);
        bestLowConfidenceQuery = query;
      }
    }
    if (bestLowConfidence) {
      debug.ambiguousMentions.push({
        input: mention.input,
        candidateCards: bestLowConfidenceCandidates.map((card) => ({
          id: card.id || card.cardId || "",
          name: card.name || card.cnName || card.jpName || card.enName || "",
          source: "baige",
          confidence: card.confidence || 0,
          matchedQuery: bestLowConfidenceQuery,
        })),
      });
      warnings.push(`baige_ambiguous:${mention.input}`);
    }
    return null;
  }));
  return dedupeCards(result.filter(Boolean)).slice(0, limits.maxCards);
}

function mentionSearchQueries(mention) {
  const queries = [
    mention?.input,
    ...(Array.isArray(mention?.searchTexts) ? mention.searchTexts : []),
    ...(Array.isArray(mention?.alternatives) ? mention.alternatives : []),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return dedupeBy(queries, normalizeCardKey).slice(0, 3);
}

async function enrichCardsWithBaige(cards, { fetchImpl, env, limits, warnings, debug }) {
  const sourceCards = (cards || []).slice(0, limits.maxCards);
  const result = await Promise.all(sourceCards.map(async (card) => {
    if (hasUsableCardText(card) && (card.id || card.cardId) && (!enginePasscodeRequired(env) || hasEnginePasscode(card))) {
      return card;
    }
    const query = card.name || card.cnName || card.jaName || card.enName || card.input;
    if (!query) {
      return card;
    }
    const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug });
    warnings.push(...searchResult.warnings);
    const best = (searchResult.results || [])[0];
    if (!best || Number(best.confidence || 0) < 0.72) {
      return card;
    }
    return mergeCard(card, toRagCard(best, card.input || query, Number(best.confidence || 0)));
  }));
  return result.filter(Boolean);
}

async function searchBaige(query, { fetchImpl, env, limits, debug }) {
  const result = await searchCards(query, { fetchImpl, env, limit: Math.max(3, limits.maxCards) });
  debug.searchCount += 1;
  if (result.cacheHit) debug.cacheHitCount += 1;
  debug.warnings.push(...(result.warnings || []));
  return result;
}

function toRagCard(card, input, confidence) {
  return {
    input,
    id: String(card.id || card.cardId || ""),
    cardId: String(card.cardId || card.id || ""),
    passcode: String(card.passcode || card.id || ""),
    cid: card.cid ?? null,
    name: card.name || card.cnName || card.jpName || card.enName || String(input || ""),
    cnName: card.cnName || "",
    jaName: card.jaName || card.jpName || "",
    jpName: card.jpName || card.jaName || "",
    enName: card.enName || "",
    cardType: card.cardType || card.type || "",
    type: card.type || card.cardType || "",
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? null,
    rank: card.rank ?? null,
    link: card.link ?? null,
    effectText: card.effectText || card.text || "",
    text: card.text || card.effectText || "",
    source: "baige",
    sourceLabel: "百鸽",
    sourceUrl: card.sourceUrl || "",
    imageUrl: card.imageUrl || "",
    imageCandidates: card.imageCandidates || [],
    official: false,
    aliases: card.aliases || [card.name, card.cnName, card.jpName, card.enName].filter(Boolean),
    raw: card.raw || card,
    confidence,
  };
}

function mergeCard(localCard, baigeCard) {
  return {
    ...baigeCard,
    ...localCard,
    id: localCard.id || baigeCard.id,
    cardId: localCard.cardId || baigeCard.cardId,
    passcode: localCard.passcode || baigeCard.passcode,
    cid: localCard.cid ?? baigeCard.cid ?? null,
    name: localCard.name || baigeCard.name,
    cnName: localCard.cnName || baigeCard.cnName,
    jaName: localCard.jaName || baigeCard.jaName,
    jpName: localCard.jpName || baigeCard.jpName,
    enName: localCard.enName || baigeCard.enName,
    cardType: localCard.cardType || baigeCard.cardType,
    type: localCard.type || baigeCard.type,
    attribute: hasValue(localCard.attribute) ? localCard.attribute : baigeCard.attribute,
    race: hasValue(localCard.race) ? localCard.race : baigeCard.race,
    atk: localCard.atk ?? baigeCard.atk,
    def: localCard.def ?? baigeCard.def,
    level: localCard.level ?? baigeCard.level,
    rank: localCard.rank ?? baigeCard.rank,
    link: localCard.link ?? baigeCard.link,
    effectText: localCard.effectText || baigeCard.effectText,
    text: localCard.text || localCard.effectText || baigeCard.text,
    source: localCard.source || baigeCard.source,
    sourceLabel: localCard.sourceLabel || baigeCard.sourceLabel,
    sourceUrl: localCard.sourceUrl || baigeCard.sourceUrl,
    imageUrl: localCard.imageUrl || baigeCard.imageUrl,
    imageCandidates: [...new Set([...(localCard.imageCandidates || []), ...(baigeCard.imageCandidates || [])])],
    aliases: [...new Set([...(localCard.aliases || []), ...(baigeCard.aliases || [])])],
    raw: localCard.raw || baigeCard.raw,
    official: false,
    confidence: Math.max(Number(localCard.confidence || 0), Number(baigeCard.confidence || 0)),
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function unresolvedMentionsAfterRetrieval(mentions, cards) {
  return (mentions || []).filter((mention) => !retrievedCardMatchesMention(mention, cards));
}

function retrievedCardMatchesMention(mention, cards) {
  const mentionKey = normalizeCardKey(mention?.input);
  if (!mentionKey) return false;
  return (cards || []).some((card) => {
    const identityText = [card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])].filter(Boolean).join(" ");
    if (hasNumberedCardIdentityConflict(mention?.input, identityText)) return false;
    const inputKey = normalizeCardKey(card.input || card.matchedQuery);
    if (inputKey && inputKey === mentionKey) return true;
    const names = [card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])]
      .map(normalizeCardKey)
      .filter(Boolean);
    return names.some((name) => name === mentionKey || (mentionKey.length >= 3 && (name.includes(mentionKey) || mentionKey.includes(name))));
  });
}

function hasUsableCardText(card) {
  return Boolean(String(card.effectText || card.text || "").trim());
}

function enginePasscodeRequired(env = {}) {
  const enabled = !/^(?:0|false|off|disabled|no)$/iu.test(String(env.RAG_AUTO_ENGINE_SIMULATION ?? "true").trim());
  return enabled && Boolean(String(env.OCG_ENGINE_URL || "").trim());
}

function hasEnginePasscode(card = {}) {
  return /^\d{8}$/u.test(String(card.passcode || card.password || "").trim());
}

function normalizeUserProvidedCardTexts(items, limits) {
  return dedupeBy((items || [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      text: String(item?.text || "").trim(),
      source: "user_provided_text",
      official: false,
    }))
    .filter((item) => item.name && item.text)
    .slice(0, limits.maxCards), (item) => normalizeCardKey(item.name));
}

function dedupeCards(cards) {
  return dedupeBy((cards || []).filter(Boolean), (card) => normalizeId(card.id || card.cardId) || normalizeCardKey(card.name || card.cnName || card.jaName || card.enName || card.input));
}

function dedupeEvidence(items) {
  return dedupeBy(items.filter((item) => item.id && item.text), (item) => `${item.type}:${stableRecordKey(item)}`);
}

function stableRecordKey(record = {}) {
  return String(record.id || record.evidenceId || record.stableId || "")
    .replace(/@[a-f0-9]{8,}(?=#|$)/iu, "");
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function readRetrievalLimits(env, maxPerBucket) {
  return {
    maxCards: readPositiveNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readPositiveNumber(env.RAG_MAX_OFFICIAL_QA, maxPerBucket),
    maxRelatedEvidence: readPositiveNumber(env.RAG_MAX_RELATED_EVIDENCE, Math.max(14, maxPerBucket)),
    maxRuleSearchQueries: readPositiveNumber(env.RAG_MAX_RULE_SEARCH_QUERIES, 16),
    maxRulebookCandidates: readPositiveNumber(env.RAG_MAX_RULEBOOK_CANDIDATES, 24),
    maxRulebookPassageChars: readPositiveNumber(env.RAG_MAX_RULEBOOK_PASSAGE_CHARS, 2200),
    maxCardTextChars: readPositiveNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readPositiveNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    localFuzzyMinConfidence: readPositiveDecimal(env.RAG_LOCAL_FUZZY_MIN_CONFIDENCE, 0.74),
  };
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function readPositiveDecimal(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isEnabled(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value || "").trim());
}

function isDisabled(value) {
  return /^(?:0|false|no|off)$/iu.test(String(value || "").trim());
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
