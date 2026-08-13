import {
  getTrustedRawGenericRecordProvenance,
  inheritTrustedRawGenericRecordProvenance,
  loadRawGenericData,
  normalizeRawGenericInjectedData,
  useRawGenericDataSnapshot,
} from "./rawGenericDataStore.mjs";
import { searchCards as searchBaigeCards } from "./baigeCardProvider.mjs";
import {
  isRawGenericCorpusBoundCard,
  rawGenericCorpusCardId,
} from "./rawGenericCardIdentity.mjs";

const INACTIVE_STATUSES = new Set([
  "removed",
  "superseded",
  "conflict",
  "parse_failed",
]);

const OFFICIAL_QA_TYPES = new Set(["qa", "official-database"]);
const FAQ_TYPES = new Set(["card-faq"]);
const PROVISIONAL_TYPES = new Set([
  "official-response-screenshot",
  "official_response_screenshot",
]);
const corpusIndexCache = new WeakMap();
const recordFeatureCache = new WeakMap();

/**
 * Finish generic identity resolution before downstream query generation.
 * External lookup is restricted to literal user surfaces left unresolved by
 * the local catalogue; model-proposed names remain unverified hypotheses.
 */
export async function resolveRawGenericCardIdentities({
  cardResolution = {},
  cards = [],
  env = {},
  fetchImpl = globalThis.fetch,
  maxCards = readPositiveNumber(env.RAG_MAX_CARDS, 6),
} = {}) {
  const effectiveMaxCards = Math.max(1, Number(maxCards) || 1);
  const modelIdentityPartition = partitionModelIdentityHypotheses(cardResolution);
  const identityResolutionInput = {
    ...cardResolution,
    resolvedCards: modelIdentityPartition.verifiedCards,
    unresolvedMentions: cleanMentions([
      ...(cardResolution.unresolvedMentions || []),
      ...modelIdentityPartition.hypothesisMentions,
    ]),
  };
  const initiallyResolvedCards = canonicalizeResolvedCards(
    identityResolutionInput.resolvedCards || [],
    cards || [],
  );
  const providedTexts = normalizeProvidedTexts(
    cardResolution.userProvidedCardTexts || [],
    effectiveMaxCards,
  );
  const externalIdentity = await resolveExternalCardIdentities({
    mentions: externalIdentityMentions(identityResolutionInput, providedTexts),
    canonicalCards: cards || [],
    fetchImpl,
    env,
    maxResolved: Math.max(0, effectiveMaxCards - initiallyResolvedCards.length),
    maxSearches: readPositiveNumber(env.RAG_BAIGE_MAX_IDENTITY_SEARCHES, effectiveMaxCards),
    providerResultLimit: effectiveMaxCards,
  });
  const resolvedCards = dedupeResolvedCards([
    ...initiallyResolvedCards,
    ...externalIdentity.resolvedCards,
  ]);
  const externallyResolvedKeys = new Set(externalIdentity.resolvedCards
    .map((card) => normalizeCardKey(card.input))
    .filter(Boolean));
  const externallyAmbiguousKeys = new Set(externalIdentity.ambiguousMentions
    .map((mention) => normalizeCardKey(mention.input))
    .filter(Boolean));
  const unresolvedMentions = cleanMentions(identityResolutionInput.unresolvedMentions)
    .filter((mention) => !externallyResolvedKeys.has(normalizeCardKey(mention.input)))
    .filter((mention) => !externallyAmbiguousKeys.has(normalizeCardKey(mention.input)));
  const ambiguousMentions = cleanMentions([
    ...externalIdentity.ambiguousMentions,
    ...cleanMentions(identityResolutionInput.ambiguousMentions)
      .filter((mention) => !externallyResolvedKeys.has(normalizeCardKey(mention.input))),
  ]);
  const warnings = [...externalIdentity.warnings];
  if (resolvedCards.length > effectiveMaxCards) {
    warnings.push(`raw_generic_cards_limited:${resolvedCards.length}->${effectiveMaxCards}`);
  }
  return {
    cardResolution: {
      ...identityResolutionInput,
      resolvedCards: resolvedCards.slice(0, effectiveMaxCards),
      unresolvedMentions,
      ambiguousMentions,
      omittedResolvedCards: [
        ...(cardResolution.omittedResolvedCards || []),
        ...resolvedCards.slice(effectiveMaxCards),
      ],
      userProvidedCardTexts: providedTexts,
      modelCardNameCandidates: Array.isArray(cardResolution.modelCardNameCandidates)
        ? cardResolution.modelCardNameCandidates
        : [],
    },
    baigeResolvedCards: externalIdentity.resolvedCards,
    baigeAmbiguousMentions: externalIdentity.ambiguousMentions,
    warnings: unique(warnings),
    debug: {
      baigeSearchCount: externalIdentity.searchCount,
      baigeCacheHitCount: externalIdentity.cacheHitCount,
      baigeWarnings: externalIdentity.providerWarnings,
    },
  };
}

/**
 * Retrieve source records using identity and lexical evidence only.
 *
 * This intentionally does not classify the question or interpret any game
 * mechanism.  In particular, model-supplied query reasons, question types,
 * player roles, scenario premises, retrieval signals and semantic analogies
 * are neither read nor copied into the returned evidence.
 */
export async function retrieveRawGenericEvidence({
  userQuery = "",
  cardResolution = {},
  dataDir,
  cards,
  records,
  qaRecords,
  data: suppliedData,
  ruleSearchQueries = [],
  identityResolution: suppliedIdentityResolution,
  env = {},
  fetchImpl: _fetchImpl = globalThis.fetch,
} = {}) {
  const startedAt = Date.now();
  const timingsMs = {};
  let stageStartedAt = Date.now();
  const data = suppliedData && typeof suppliedData === "object"
    ? useRawGenericDataSnapshot(suppliedData)
    : cards || records || qaRecords
      ? normalizeRawGenericInjectedData({
        cards: cards || [],
        records: records || [],
        qaRecords: qaRecords || [],
      })
      : useRawGenericDataSnapshot(await loadRawGenericData(dataDir));
  timingsMs.data = elapsedMs(stageStartedAt);

  const limits = readLimits(env);
  const warnings = [];
  stageStartedAt = Date.now();
  const identityResolution = suppliedIdentityResolution || await resolveRawGenericCardIdentities({
    cardResolution,
    cards: data.cards || [],
    env,
    fetchImpl: _fetchImpl,
    maxCards: limits.maxCards,
  });
  warnings.push(...(identityResolution.warnings || []));
  const normalizedQueries = normalizeRuleQueries(
    ruleSearchQueries,
    limits.maxRuleSearchQueries,
  );
  const effectiveCardResolution = identityResolution.cardResolution;
  const effectiveResolvedCards = effectiveCardResolution.resolvedCards || [];
  const providedTexts = effectiveCardResolution.userProvidedCardTexts || [];
  timingsMs.identity = elapsedMs(stageStartedAt);

  stageStartedAt = Date.now();
  const corpusIndex = getCorpusIndex(data);
  const corpusBoundResolvedCards = effectiveResolvedCards.filter(isRawGenericCorpusBoundCard);
  const officialQaRecords = recordsForRanking(corpusIndex.officialQa, corpusIndex, corpusBoundResolvedCards);
  const faqRecords = recordsForRanking(corpusIndex.faq, corpusIndex, corpusBoundResolvedCards);
  const provisionalRecords = recordsForRanking(corpusIndex.provisional, corpusIndex, corpusBoundResolvedCards);
  // Community rule documents are intentionally global raw sources. They are
  // few in number and are selected by lexical overlap only; arbitrary related
  // records still require an exact card identity.
  const rawRecords = uniqueRecords([
    // Every local identity-scoped bucket shares the same fail-closed identity
    // boundary. An externally supplied card text is useful evidence by itself,
    // but an unbound external name must never unlock a local record merely by
    // colliding with one of that record's aliases.
    ...recordsForRanking(corpusIndex.rawIdentityScoped, corpusIndex, corpusBoundResolvedCards),
    ...corpusIndex.rawGlobal,
  ]);
  timingsMs.buckets = elapsedMs(stageStartedAt);

  stageStartedAt = Date.now();
  const officialRankingContext = buildRankingContext({
    userQuery,
    resolvedCards: corpusBoundResolvedCards,
    ruleSearchQueries: normalizedQueries,
    maxPassageChars: limits.maxEvidenceTextChars,
  });
  const rankingContext = buildRankingContext({
    userQuery,
    resolvedCards: effectiveResolvedCards,
    ruleSearchQueries: normalizedQueries,
    maxPassageChars: limits.maxEvidenceTextChars,
  });
  const rankedOfficialQa = rankRecords(officialQaRecords, officialRankingContext, corpusIndex);
  const rankedFaq = rankRecords(faqRecords, officialRankingContext, corpusIndex);
  const rankedProvisional = rankRecords(provisionalRecords, officialRankingContext, corpusIndex);
  const rankedRaw = rankRecords(rawRecords, rankingContext, corpusIndex);
  const directRecord = selectUniqueStrictDirectRecord({
    userQuery,
    cardResolution: effectiveCardResolution,
    rankedOfficialQa,
  });
  timingsMs.rank = elapsedMs(stageStartedAt);

  stageStartedAt = Date.now();
  const directKey = directRecord ? stableRecordKey(directRecord.record) : "";
  const officialQaDirectCandidates = directRecord
    ? [serializeEvidence(directRecord, {
        type: "official_qa",
        maxTextChars: limits.maxEvidenceTextChars,
        direct: true,
        resolvedCards: effectiveResolvedCards,
      })]
    : [];
  const officialQaRelated = rankedOfficialQa
    .filter((item) => !directKey || stableRecordKey(item.record) !== directKey)
    .slice(0, limits.maxOfficialQa)
    .map((item) => serializeEvidence(item, {
      type: "official_qa_related",
      maxTextChars: limits.maxEvidenceTextChars,
      resolvedCards: effectiveResolvedCards,
    }));
  const provisionalOfficialResponses = rankedProvisional
    .slice(0, limits.maxOfficialQa)
    .map((item) => serializeEvidence(item, {
      type: "provisional_official_response",
      maxTextChars: limits.maxEvidenceTextChars,
      resolvedCards: effectiveResolvedCards,
    }));
  const faqRelated = rankedFaq
    .slice(0, limits.maxRelatedEvidence)
    .map((item) => serializeEvidence(item, {
      type: "card_faq",
      maxTextChars: limits.maxEvidenceTextChars,
      resolvedCards: effectiveResolvedCards,
    }));
  const rawRelatedEvidence = rankedRaw
    .slice(0, limits.maxRelatedEvidence)
    .map((item) => serializeEvidence(item, {
      type: evidenceTypeForRawRecord(item.record),
      maxTextChars: limits.maxEvidenceTextChars,
      resolvedCards: effectiveResolvedCards,
      passageContext: rankingContext,
    }));
  const cardTexts = effectiveResolvedCards
    .map((card) => cardTextEvidence(card, limits.maxCardTextChars, warnings))
    .filter((item) => item.text);
  const userProvidedCardTexts = providedTexts
    .map((item, index) => userProvidedTextEvidence(
      item,
      index,
      limits.maxCardTextChars,
      warnings,
    ));
  timingsMs.serialize = elapsedMs(stageStartedAt);
  timingsMs.total = elapsedMs(startedAt);

  return {
    cardTexts,
    userProvidedCardTexts,
    officialQaDirectCandidates,
    officialQaRelated,
    provisionalOfficialResponses,
    faqRelated,
    rawRelatedEvidence,

    retrievedCards: effectiveResolvedCards,
    cardResolution: effectiveCardResolution,
    remainingUnresolvedMentions: effectiveCardResolution.unresolvedMentions,
    baigeResolvedCards: identityResolution.baigeResolvedCards || [],
    baigeAmbiguousMentions: identityResolution.baigeAmbiguousMentions || [],
    ruleSearchQueries: normalizedQueries,
    retrievalWarnings: warnings,

    debug: {
      baigeSearchCount: identityResolution.debug?.baigeSearchCount || 0,
      baigeCacheHitCount: identityResolution.debug?.baigeCacheHitCount || 0,
      baigeWarnings: identityResolution.debug?.baigeWarnings || [],
      timingsMs,
      rawGeneric: true,
      candidateCounts: {
        officialQa: rankedOfficialQa.length,
        faq: rankedFaq.length,
        provisionalOfficialResponses: rankedProvisional.length,
        rawRelated: rankedRaw.length,
      },
    },
  };
}

function buildRankingContext({ userQuery, resolvedCards, ruleSearchQueries, maxPassageChars }) {
  const userTokens = tokenize(userQuery);
  const modelQueries = ruleSearchQueries.map((item) => item.query);
  const modelQueryTokens = modelQueries.map(tokenize);
  const resolved = (resolvedCards || []).map((card) => ({
    id: rawGenericCorpusCardId(card),
    names: unique([
      card.name,
      card.cnName,
      card.jaName,
      card.jpName,
      card.enName,
      ...(card.aliases || []),
    ].map(normalizeCardKey).filter(Boolean)),
  }));
  return {
    userTokens,
    modelQueries,
    modelQueryTokens,
    resolved,
    maxPassageChars: Math.max(1, Number(maxPassageChars) || 1),
  };
}

function rankRecords(records, context, index) {
  return (records || [])
    .map((record) => scoreRecord(record, context, index))
    .filter((item) => item.identityMatchCount > 0 || item.lexicalScore > 0)
    .sort(compareRankedRecords);
}

function getCorpusIndex(data) {
  if (data && typeof data === "object") {
    const cached = corpusIndexCache.get(data);
    if (cached) return cached;
  }
  const all = selectCanonicalRecords([
    ...(data?.records || []),
    ...(data?.qaRecords || []),
  ]).filter((record) => isActiveRecord(record) && !isNonEvidenceTestRecord(record));
  const officialQa = [];
  const faq = [];
  const provisional = [];
  const rawIdentityScoped = [];
  const rawGlobal = [];
  const identityRecords = new Map();
  const identityByRecord = new WeakMap();
  const featureByRecord = new WeakMap();
  const resolveQuestionCardIds = createQuestionCardIdResolver(data?.cards || []);
  for (const record of all) {
    if (isOfficialQaRecord(record)) officialQa.push(record);
    else if (isFaqRecord(record)) faq.push(record);
    else if (isProvisionalRecord(record)) provisional.push(record);
    else if (String(record.recordType || "") !== "card-text") {
      if (isGlobalRuleDocument(record)) rawGlobal.push(record);
      else rawIdentityScoped.push(record);
    }
    const identity = recordIdentity(record, resolveQuestionCardIds);
    identityByRecord.set(record, identity);
    for (const id of identity.ids) addRecordIndex(identityRecords, `id:${id}`, record);
    for (const name of identity.names) addRecordIndex(identityRecords, `name:${name}`, record);
  }
  const index = Object.freeze({
    officialQa: Object.freeze(officialQa),
    faq: Object.freeze(faq),
    provisional: Object.freeze(provisional),
    rawIdentityScoped: Object.freeze(rawIdentityScoped),
    rawGlobal: Object.freeze(rawGlobal),
    identityRecords,
    identityByRecord,
    featureByRecord,
  });
  if (data && typeof data === "object") corpusIndexCache.set(data, index);
  return index;
}

function recordsForRanking(bucket, index, resolvedCards) {
  if (!(resolvedCards || []).length) return [];
  const allowed = new Set(bucket || []);
  const selected = new Set();
  for (const card of resolvedCards || []) {
    const id = rawGenericCorpusCardId(card);
    if (id) {
      for (const record of index.identityRecords.get(`id:${id}`) || []) {
        if (allowed.has(record)) selected.add(record);
      }
    }
    for (const name of cardNames(card)) {
      const key = normalizeCardKey(name);
      if (!key) continue;
      for (const record of index.identityRecords.get(`name:${key}`) || []) {
        if (allowed.has(record)) selected.add(record);
      }
    }
  }
  return [...selected];
}

function addRecordIndex(index, key, record) {
  if (!key || key.endsWith(":")) return;
  const records = index.get(key) || [];
  records.push(record);
  index.set(key, records);
}

function uniqueRecords(records) {
  const result = new Map();
  for (const record of records || []) result.set(stableRecordKey(record), record);
  return [...result.values()];
}

function scoreRecord(record, context, index) {
  const features = recordFeatures(record, index);
  const recordKey = features.key;
  const recordTokens = features.tokens;
  const identities = features.identity;
  let identityMatchCount = 0;
  const matchedResolvedIds = [];
  for (const resolved of context.resolved) {
    const idMatch = resolved.id && identities.ids.has(resolved.id);
    const declaredNameMatch = resolved.names.some((name) => identities.names.has(name));
    const literalNameMatch = resolved.names.some((name) => name.length >= 2 && recordKey.includes(name));
    if (!idMatch && !declaredNameMatch && !literalNameMatch) continue;
    identityMatchCount += 1;
    if (resolved.id) matchedResolvedIds.push(resolved.id);
  }
  const lexical = isGlobalRuleDocument(record)
    ? strongestLexicalDocumentMatch(globalRuleDocumentText(record), context)
    : lexicalPassageSignals(recordKey, context, recordTokens);
  return {
    record,
    statusRank: currentStatusRank(record.status),
    identityMatchCount,
    identityCoverage: context.resolved.length
      ? identityMatchCount / context.resolved.length
      : 0,
    matchedResolvedIds: unique(matchedResolvedIds),
    lexicalScore: lexical.score,
    userOverlap: lexical.userOverlap,
    authorityRank: sourceAuthorityRank(record),
    freshness: freshnessTimestamp(record),
    stableKey: stableRecordKey(record),
    identity: identities,
  };
}

function recordFeatures(record, index) {
  const cache = index?.featureByRecord || recordFeatureCache;
  if (record && typeof record === "object") {
    const cached = cache.get(record);
    if (cached) return cached;
  }
  const text = recordSearchText(record);
  const features = Object.freeze({
    key: normalizeCardKey(text),
    tokens: new Set(tokenize(text)),
    identity: index?.identityByRecord?.get(record) || recordIdentity(record),
  });
  if (record && typeof record === "object") cache.set(record, features);
  return features;
}

function compareRankedRecords(left, right) {
  return right.identityCoverage - left.identityCoverage
    || right.identityMatchCount - left.identityMatchCount
    || right.lexicalScore - left.lexicalScore
    || right.userOverlap - left.userOverlap
    || right.authorityRank - left.authorityRank
    || right.statusRank - left.statusRank
    || right.freshness - left.freshness
    || left.stableKey.localeCompare(right.stableKey);
}

function selectUniqueStrictDirectRecord({ userQuery, cardResolution, rankedOfficialQa }) {
  if (!isIdentityComplete(cardResolution)) return null;
  const resolvedIds = unique((cardResolution.resolvedCards || [])
    .map(rawGenericCorpusCardId)
    .filter(Boolean))
    .sort();
  if (!resolvedIds.length || resolvedIds.length !== (cardResolution.resolvedCards || []).length) {
    return null;
  }
  const normalizedQuery = normalizeLiteralQuestion(userQuery);
  if (!normalizedQuery) return null;
  const candidates = rankedOfficialQa.filter((ranked) => {
    const { record } = ranked;
    if (!getTrustedRawGenericRecordProvenance(record)) return false;
    if (ranked.statusRank !== 3) return false;
    const question = String(record.question || record.rawQuestion || "").trim();
    if (!question || normalizeLiteralQuestion(question) !== normalizedQuery) return false;
    const questionIds = [...(ranked?.identity?.ids || [])].sort();
    return equalStringSets(questionIds, resolvedIds);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function serializeEvidence(item, {
  type,
  maxTextChars,
  direct = false,
  resolvedCards = [],
  passageContext = null,
}) {
  const record = item.record || {};
  const sourceText = isGlobalRuleDocument(record)
    ? globalRuleDocumentText(record)
    : fullRecordText(record);
  const text = isGlobalRuleDocument(record)
    ? selectLexicalDocumentPassages(sourceText, passageContext, maxTextChars)
    : truncate(sourceText, maxTextChars);
  // The prompt builder intentionally prefers `fullText`. For global rule
  // documents, expose only the bounded passage window so it cannot silently
  // replace the selected later passage with the beginning of the entire file.
  const fullText = isGlobalRuleDocument(record) ? text : sourceText;
  const questionCardIds = isOfficialQaRecord(record)
    ? [...(item.identity?.ids || strictQuestionCardIds(record))].sort()
    : strictQuestionCardIds(record);
  const trustedProvenance = getTrustedRawGenericRecordProvenance(record);
  const official = Boolean(trustedProvenance) && (
    isOfficialQaRecord(record) || isFaqRecord(record) || isProvisionalRecord(record)
  );
  const serialized = cleanObject({
    id: stableRecordKey(record),
    type,
    title: String(record.title || record.question || stableRecordKey(record)),
    // Preserve the question side separately so the final direct-authority
    // gate can independently verify literal normalized equality. Do not infer
    // this value from the answer or any scenario classifier metadata.
    question: isOfficialQaRecord(record)
      ? String(record.question || record.rawQuestion || "").trim()
      : "",
    text,
    fullText,
    sourceUrl: String(record.sourceUrl || record.officialUrl || ""),
    source: String(record.source || record.sourceId || ""),
    sourceName: String(record.sourceName || ""),
    sourceRecordId: String(record.sourceRecordId || record.sourceId || ""),
    docname: String(record.docname || ""),
    paragraphStart: finiteOrNull(record.paragraphStart),
    paragraphEnd: finiteOrNull(record.paragraphEnd),
    authority: official ? inferredAuthority(record) : String(record.authority || ""),
    official,
    status: String(record.status || "unknown"),
    updatedAt: String(record.updatedAt || record.lastModified || record.generatedAt || ""),
    cardIds: unique((record.cardIds || []).map(normalizeId).filter(Boolean)),
    questionCardIds,
    cards: unique([
      record.cardName,
      ...(record.cards || []),
      ...(record.cardNames || []),
    ].filter((value) => value !== undefined && value !== null)
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean)),
    retrievalScore: normalizedRetrievalScore(item),
    ...(direct ? {
      isDirect: true,
      matchLevel: "official_qa_exact",
    } : {
      isDirect: false,
    }),
  });
  return inheritTrustedRawGenericRecordProvenance(record, serialized);
}

function normalizedRetrievalScore(item) {
  const identity = Number(item.identityCoverage || 0);
  const lexical = Math.min(1, Number(item.lexicalScore || 0) / 8);
  return roundScore(Math.min(1, identity * 0.6 + lexical * 0.4));
}

function cardTextEvidence(card, maxTextChars, warnings) {
  const fullText = String(card.effectText || card.text || "");
  if (fullText.length > maxTextChars) {
    warnings.push(`card_text_truncated:${card.id || normalizeCardKey(card.name)}`);
  }
  const id = String(card.id || card.cardId || normalizeCardKey(card.name));
  const names = unique([
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(card.aliases || []),
  ].map(String).filter(Boolean));
  return cleanObject({
    id: `card-text-${id}`,
    type: "card_text",
    title: `${card.name || names[0] || id} 的卡片文本`,
    text: truncate(fullText, maxTextChars),
    fullText,
    sourceUrl: String(card.sourceUrl || ""),
    source: String(card.source || ""),
    official: false,
    cardIds: [String(card.id || card.cardId || "")].filter(Boolean),
    cards: names,
    name: String(card.name || ""),
    cnName: String(card.cnName || ""),
    jaName: String(card.jaName || card.jpName || ""),
    enName: String(card.enName || ""),
    aliases: Array.isArray(card.aliases) ? card.aliases : [],
    cardType: String(card.cardType || card.type || ""),
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: finiteOrNull(card.atk),
    def: finiteOrNull(card.def),
    level: finiteOrNull(card.level ?? card.rank ?? card.link),
    isDirect: false,
  });
}

function userProvidedTextEvidence(item, index, maxTextChars, warnings) {
  const fullText = String(item.text || "");
  const key = normalizeCardKey(item.name) || `card-${index + 1}`;
  if (fullText.length > maxTextChars) warnings.push(`user_provided_text_truncated:${key}`);
  return {
    id: `user-card-text-${key}`,
    type: "user_provided_text",
    title: `${item.name} 的用户提供文本`,
    text: truncate(fullText, maxTextChars),
    fullText,
    sourceUrl: "",
    source: "user_provided_text",
    official: false,
    cardIds: [],
    cards: [item.name],
    isDirect: false,
  };
}

function canonicalizeResolvedCards(resolvedCards, canonicalCards) {
  const byId = new Map();
  const byName = new Map();
  for (const card of canonicalCards || []) {
    const id = normalizeId(card.id || card.cardId);
    if (id) addIndexCandidate(byId, id, card);
    for (const name of cardNames(card)) addIndexCandidate(byName, normalizeCardKey(name), card);
  }
  const result = [];
  const seen = new Set();
  for (const card of resolvedCards || []) {
    const id = normalizeId(card.id || card.cardId);
    let candidates = id ? byId.get(id) || [] : [];
    if (!candidates.length) {
      const exactNameCandidates = new Set();
      for (const name of cardNames(card)) {
        for (const candidate of byName.get(normalizeCardKey(name)) || []) {
          exactNameCandidates.add(candidate);
        }
      }
      candidates = [...exactNameCandidates];
    }
    const canonical = candidates.length === 1 ? candidates[0] : null;
    const merged = canonical
      ? {
          ...card,
          ...canonical,
          input: card.input || canonical.input || "",
          matchedQuery: card.matchedQuery || canonical.matchedQuery || "",
          aliases: unique([...cardNames(card), ...cardNames(canonical)]),
        }
      : card;
    const key = normalizeId(merged.id || merged.cardId)
      || normalizeCardKey(merged.name || merged.cnName || merged.jaName || merged.enName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(merged);
  }
  return result;
}

function selectCanonicalRecords(records) {
  const selected = new Map();
  for (const record of records || []) {
    if (!record || typeof record !== "object") continue;
    const key = stableRecordKey(record);
    if (!key) continue;
    const previous = selected.get(key);
    if (!previous || compareRecordVersions(record, previous) < 0) selected.set(key, record);
  }
  return [...selected.values()];
}

function compareRecordVersions(left, right) {
  return currentStatusRank(right.status) - currentStatusRank(left.status)
    || sourceAuthorityRank(right) - sourceAuthorityRank(left)
    || freshnessTimestamp(right) - freshnessTimestamp(left)
    || recordSearchText(right).length - recordSearchText(left).length
    || stableRecordKey(left).localeCompare(stableRecordKey(right));
}

function isActiveRecord(record) {
  return !INACTIVE_STATUSES.has(String(record.status || "current").trim().toLowerCase());
}

function isNonEvidenceTestRecord(record) {
  return String(record.recordType || "").trim().toLowerCase() === "rule-test";
}

function isOfficialQaRecord(record) {
  return OFFICIAL_QA_TYPES.has(String(record.recordType || ""))
    && Boolean(String(record.question || "").trim())
    && Boolean(String(record.answer || record.conclusion || "").trim());
}

function isFaqRecord(record) {
  return FAQ_TYPES.has(String(record.recordType || ""));
}

function isProvisionalRecord(record) {
  return PROVISIONAL_TYPES.has(String(record.recordType || ""))
    || String(record.sourceType || "") === "official_response_screenshot";
}

function isOfficialSourceRecord(record) {
  return Boolean(getTrustedRawGenericRecordProvenance(record))
    && (isOfficialQaRecord(record) || isFaqRecord(record) || isProvisionalRecord(record));
}

function evidenceTypeForRawRecord(record) {
  return record.recordType === "rule-doc"
      || record.sourceId === "ocg-rule"
      || String(record.id || "").startsWith("ocg-rule:")
    ? "rulebook"
    : String(record.recordType || "related");
}

function isGlobalRuleDocument(record) {
  return record.recordType === "rule-doc"
    || record.sourceId === "ocg-rule"
    || String(record.id || "").startsWith("ocg-rule:");
}

function inferredAuthority(record) {
  if (!getTrustedRawGenericRecordProvenance(record)) return "";
  if (isOfficialQaRecord(record)) return "official_qa";
  if (isFaqRecord(record)) return "official_card_faq";
  if (isProvisionalRecord(record)) return "provisional_official_source";
  return "";
}

function sourceAuthorityRank(record) {
  if (getTrustedRawGenericRecordProvenance(record)
    && (isOfficialQaRecord(record) || isFaqRecord(record))) return 4;
  if (getTrustedRawGenericRecordProvenance(record) && isProvisionalRecord(record)) return 2;
  if (record.sourceUrl || record.docname) return 1;
  return 0;
}

function currentStatusRank(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "confirmed" || status === "current" || status === "active") return 3;
  if (status === "pending" || status === "provisional" || status === "unverified") return 1;
  if (INACTIVE_STATUSES.has(status)) return 0;
  // Unknown lifecycle values are never guessed to be current. They remain
  // available as low-priority context, but cannot become a direct ruling.
  return 0;
}

function freshnessTimestamp(record) {
  for (const value of [record.updatedAt, record.lastModified, record.generatedAt, record.publishedAt]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function recordIdentity(record, resolveQuestionCardIds = null) {
  if (isOfficialQaRecord(record)) {
    // A Q&A belongs only to the cards identified on its question side.  The
    // broad cardIds/text fields may also contain cards mentioned solely by the
    // answer and must never make that Q&A eligible for an unrelated query.
    return {
      ids: new Set(strictQuestionCardIds(record, resolveQuestionCardIds)),
      names: new Set(),
    };
  }
  if (isFaqRecord(record)) {
    // A card FAQ is attached to its owning card, so its declared cardIds and
    // declared owner names are the correct scope.  Its conclusion is not.
    return {
      ids: new Set(faqOwnerCardIds(record)),
      names: new Set(unique([
        record.cardName,
        ...(record.cards || []),
        ...(record.cardNames || []),
      ].map(normalizeCardKey).filter(Boolean))),
    };
  }
  const text = recordSearchText(record);
  return {
    ids: new Set(unique([
      record.cardId,
      ...(record.cardIds || []),
      ...extractInlineCardIds(text),
    ].map(normalizeId).filter(Boolean))),
    names: new Set(unique([
      record.cardName,
      ...(record.cards || []),
      ...(record.cardNames || []),
    ].map(normalizeCardKey).filter(Boolean))),
  };
}

function faqOwnerCardIds(record = {}) {
  const explicit = normalizeId(record.cardId);
  if (explicit) return [explicit];
  const sourceCid = String(record.sourceUrl || record.officialUrl || "")
    .match(/[?&]cid=(\d{1,10})(?:&|$)/u)?.[1];
  if (sourceCid) return [normalizeId(sourceCid)];
  const stableId = String(record.id || record.evidenceId || "")
    .match(/^card-faq-(\d{1,10})(?:-|$)/u)?.[1];
  if (stableId) return [normalizeId(stableId)];
  // Only an unambiguous single declared identity can be treated as ownership.
  // A normalized legacy record may also contain answer-side inline IDs.
  const declared = unique((record.cardIds || []).map(normalizeId).filter(Boolean));
  return declared.length === 1 ? declared : [];
}

function strictQuestionCardIds(record, resolveQuestionCardIds = null) {
  const questionSide = [
    record.question,
    record.rawQuestion,
    record.rawDetailedQuestion,
  ].filter(Boolean).join("\n");
  return unique([
    ...(record.questionCardIds || []),
    ...extractInlineCardIds(questionSide),
    ...(typeof resolveQuestionCardIds === "function"
      ? resolveQuestionCardIds(questionSide)
      : []),
  ].map(normalizeId).filter(Boolean)).sort();
}

function recordSearchText(record) {
  if (isOfficialQaRecord(record)) {
    // Synchronized keywords/cards may be derived from the complete Q&A,
    // including its answer. Rebuild relevance exclusively from source fields
    // that are explicitly on the question side.
    return [
      record.question,
      record.rawQuestion,
      record.rawDetailedQuestion,
    ].filter(Boolean).join("\n");
  }
  if (isFaqRecord(record)) {
    // A FAQ is scoped by its owning identity. Its conclusion and derived
    // keywords are evidence for the final model, never retrieval features.
    return [
      record.cardName,
      ...(record.cards || []),
      ...(record.cardNames || []),
    ].filter(Boolean).join("\n");
  }
  const questionSide = [
    record.title,
    record.question,
    record.rawQuestion,
    record.rawDetailedQuestion,
    record.scenario,
    ...(record.keywords || []),
  ];
  // Q&A relevance is strictly question-side.  Metadata name arrays can be
  // produced from an entire Q&A record and therefore may include a card that
  // appears only in the answer.  FAQ metadata, by contrast, names its owner.
  if (!isOfficialQaRecord(record)) {
    questionSide.push(
      record.cardName,
      ...(record.cards || []),
      ...(record.cardNames || []),
    );
  }
  // Q&A answers and FAQ conclusions are evidence for the final model, never
  // ranking features. Raw rule documents have no question/answer split, so
  // their source text itself is the searchable material.
  if (isGlobalRuleDocument(record)) questionSide.push(record.text, record.officialText);
  return questionSide.filter(Boolean).join("\n");
}

function fullRecordText(record) {
  const question = String(record.question || "").trim();
  const detailed = String(record.rawDetailedQuestion || "").trim();
  const answer = String(record.answer || record.conclusion || "").trim();
  if (question && answer) {
    return unique([question, detailed, answer]).join("\n").trim();
  }
  return String(record.text || record.officialText || question || answer || record.title || "").trim();
}

function globalRuleDocumentText(record) {
  // A global rule document has no question/answer split. Only its declared
  // source body is searchable; answer-like compatibility fields must never
  // become passage-ranking input.
  return String(record.text || record.officialText || record.title || "").trim();
}

function selectLexicalDocumentPassages(value, context, maxChars) {
  const text = String(value || "").trim();
  const limit = Math.max(1, Number(maxChars) || 1);
  if (text.length <= limit) return text;

  const passages = completeDocumentPassages(text, limit);
  if (!passages.length) return truncate(text, limit);
  const ranked = passages
    .map((passage, index) => ({
      index,
      score: lexicalPassageScore(passage, context),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const fittingAnchor = ranked.find(({ index }) => passages[index].length <= limit);
  if (!fittingAnchor) return truncate(text, limit);

  const selected = new Set([fittingAnchor.index]);
  const trySelect = (index) => {
    if (index < 0 || index >= passages.length || selected.has(index)) return;
    const candidate = new Set(selected);
    candidate.add(index);
    if (renderPassageSelection(passages, candidate).length <= limit) selected.add(index);
  };
  const trySelectContext = (anchorIndex, neighborIndex) => {
    if (neighborIndex < 0 || neighborIndex >= passages.length) return;
    const neighborHasLexicalMatch = lexicalPassageScore(passages[neighborIndex], context) > 0;
    const structurallyAttached = (
      neighborIndex === anchorIndex - 1 && isDocumentHeading(passages[neighborIndex])
    ) || (
      neighborIndex === anchorIndex + 1 && isDocumentHeading(passages[anchorIndex])
    );
    if (neighborHasLexicalMatch || structurallyAttached) trySelect(neighborIndex);
  };

  // Preserve immediate source context around the strongest lexical hit. This
  // commonly retains a section heading and its following explanation without
  // encoding any rule topic or expected conclusion.
  trySelectContext(fittingAnchor.index, fittingAnchor.index - 1);
  trySelectContext(fittingAnchor.index, fittingAnchor.index + 1);

  // If capacity remains, admit other independently matching passages and
  // their neighbors in deterministic lexical order.
  for (const candidate of ranked) {
    if (candidate.score <= 0) break;
    trySelect(candidate.index);
    if (!selected.has(candidate.index)) continue;
    trySelectContext(candidate.index, candidate.index - 1);
    trySelectContext(candidate.index, candidate.index + 1);
  }
  return truncate(renderPassageSelection(passages, selected), limit);
}

function isDocumentHeading(value) {
  const text = String(value || "").trim();
  return /¶\s*$/u.test(text) || /^#{1,6}\s+\S/u.test(text);
}

function completeDocumentPassages(value, maxChars) {
  const paragraphs = String(value || "")
    .split(/(?:\r?\n\s*){2,}/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const passages = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      passages.push(paragraph);
      continue;
    }
    // Preserve complete sentences when a source paragraph alone exceeds the
    // configured evidence budget. Only a punctuation-free overlong sentence
    // reaches the final bounded fallback in selectLexicalDocumentPassages.
    const sentences = paragraph.match(/[^。！？!?；;\r\n]+(?:[。！？!?；;]+|$)/gu) || [];
    passages.push(...sentences.map((item) => item.trim()).filter(Boolean));
  }
  return passages;
}

function lexicalPassageScore(passage, context = {}) {
  return lexicalPassageSignals(passage, context).score;
}

function lexicalPassageSignals(passage, context = {}, suppliedTokens = null) {
  const passageTokens = suppliedTokens || new Set(tokenize(passage));
  const userOverlap = overlapScore(context?.userTokens || [], passageTokens);
  const modelQueryOverlap = (context?.modelQueryTokens || []).reduce(
    (sum, tokens) => sum + overlapScore(tokens, passageTokens),
    0,
  );
  const passageKey = normalizeCardKey(passage);
  const literalQueryMatches = (context?.modelQueries || []).filter((query) => {
    const queryKey = normalizeCardKey(query);
    return queryKey.length >= 2 && passageKey.includes(queryKey);
  }).length;
  return {
    score: roundScore(userOverlap * 4 + modelQueryOverlap + literalQueryMatches * 0.5),
    userOverlap,
  };
}

function strongestLexicalDocumentMatch(value, context = {}) {
  const passages = completeDocumentPassages(value, context.maxPassageChars || 1);
  let strongest = { score: 0, userOverlap: 0 };
  for (const passage of passages) {
    const candidate = lexicalPassageSignals(passage, context);
    if (candidate.score > strongest.score
        || (candidate.score === strongest.score && candidate.userOverlap > strongest.userOverlap)) {
      strongest = candidate;
    }
  }
  return strongest;
}

function renderPassageSelection(passages, selected) {
  const omission = "\n\n[… omitted …]\n\n";
  const indices = [...selected].sort((left, right) => left - right);
  let rendered = "";
  let previous = null;
  for (const index of indices) {
    if (rendered) rendered += previous === index - 1 ? "\n\n" : omission;
    rendered += passages[index];
    previous = index;
  }
  return rendered;
}

function normalizeLiteralQuestion(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[，,。.!！?？;；:：、()（）\[\]{}]/gu, "")
    .trim();
}

function normalizeCardKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[雙]/gu, "双")
    .replace(/[來]/gu, "来")
    .replace(/[龍]/gu, "龙")
    .replace(/[薔]/gu, "蔷")
    .replace(/[蘇]/gu, "苏")
    .replace(/[場]/gu, "场")
    .replace(/[發]/gu, "发")
    .replace(/[動]/gu, "动")
    .replace(/[體]/gu, "体")
    .replace(/[從]/gu, "从")
    .replace(/[對]/gu, "对")
    .replace(/[選]/gu, "选")
    .replace(/[闕]/gu, "阙")
    .replace(/[歩]/gu, "步")
    .replace(/[義]/gu, "义")
    .replace(/[賊]/gu, "贼")
    .replace(/喰/gu, "食")
    .replace(/導/gu, "导")
    .replace(/[の之的]/gu, "")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[：:・·･．.－—–_\-\s]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}]/gu, "")
    .trim();
}

function tokenize(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase();
  const words = normalized
    .split(/[^\p{L}\p{N}①②③④⑤⑥⑦⑧⑨]+/u)
    .map(normalizeCardKey)
    .filter((item) => item.length >= 2);
  const grams = [];
  for (const word of words) {
    if (!/[\u3040-\u30ff\u3400-\u9fff]/u.test(word) || word.length < 3) continue;
    for (let index = 0; index < word.length - 1; index += 1) grams.push(word.slice(index, index + 2));
  }
  return unique([...words, ...grams]).slice(0, 160);
}

function overlapScore(queryTokens, recordTokens) {
  if (!queryTokens.length || !recordTokens.size) return 0;
  let matched = 0;
  for (const token of queryTokens) if (recordTokens.has(token)) matched += 1;
  return matched / queryTokens.length;
}

function normalizeRuleQueries(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const query = String(typeof item === "string" ? item : item?.query || "").trim();
    const key = normalizeCardKey(query);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    result.push({ query: query.slice(0, 240) });
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeProvidedTexts(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name || "").trim();
    const text = String(item?.text || "").trim();
    const key = normalizeCardKey(name);
    if (!key || !text || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, text, source: "user_provided_text", official: false });
    if (result.length >= limit) break;
  }
  return result;
}

function externalIdentityMentions(cardResolution, providedTexts) {
  const providedKeys = new Set((providedTexts || [])
    .map((item) => normalizeCardKey(item.name))
    .filter(Boolean));
  return cleanMentions([
    ...(cardResolution.unresolvedMentions || []),
    ...(cardResolution.ambiguousMentions || []),
  ]).filter((mention) => !providedKeys.has(normalizeCardKey(mention.input)));
}

function partitionModelIdentityHypotheses(cardResolution) {
  const verifiedCards = [];
  const hypothesisMentions = [];
  for (const card of cardResolution?.resolvedCards || []) {
    const isUnverifiedModelExpansion = card?.resolutionSource === "model_surface"
      && card?.identityMatchKind === "model_exact_canonical";
    if (!isUnverifiedModelExpansion) {
      verifiedCards.push(card);
      continue;
    }
    const input = String(card.input || card.matchedQuery || "").trim();
    if (!input) continue;
    hypothesisMentions.push({
      input,
      source: "model_identity_hypothesis",
      reason: "model_canonical_expansion_requires_external_verification",
      candidateCards: [{
        id: String(card.id || card.cardId || ""),
        name: String(card.name || card.cnName || card.jaName || card.enName || ""),
      }],
    });
  }
  return { verifiedCards, hypothesisMentions };
}

async function resolveExternalCardIdentities({
  mentions,
  canonicalCards,
  fetchImpl,
  env,
  maxResolved,
  maxSearches,
  providerResultLimit,
}) {
  const result = {
    resolvedCards: [],
    ambiguousMentions: [],
    warnings: [],
    providerWarnings: [],
    searchCount: 0,
    cacheHitCount: 0,
  };
  if (!Number.isInteger(maxResolved) || maxResolved <= 0 || typeof fetchImpl !== "function") return result;

  const minConfidence = readDecimal(env.RAG_BAIGE_MIN_CONFIDENCE, 0.84, 0, 1);
  const minMargin = readDecimal(env.RAG_BAIGE_CONFIDENCE_MARGIN, 0.16, 0, 1);
  const boundedSearches = Math.max(1, Math.min(24, Number(maxSearches) || 1));
  for (const mention of (mentions || []).slice(0, boundedSearches)) {
    if (result.resolvedCards.length >= maxResolved) break;
    const input = String(mention?.input || "").trim();
    if (!input) continue;
    // Only the user's literal surface is allowed to initiate identity proof.
    // Model-proposed canonical expansions remain diagnostic hypotheses and can
    // never verify themselves by causing a lookup for the proposed answer.
    const response = await searchBaigeCards(input, {
      fetchImpl,
      env,
      limit: Math.max(3, Number(providerResultLimit) || 1),
    });
    result.searchCount += 1;
    if (response.cacheHit) result.cacheHitCount += 1;
    result.providerWarnings.push(...(response.warnings || []));
    result.warnings.push(...(response.warnings || []));

    const selection = selectExternalIdentityCandidate(response.results || [], input, {
      minConfidence,
      minMargin,
    }, canonicalCards);
    if (!selection.card) {
      if (selection.candidates.length) {
        result.ambiguousMentions.push({
          input,
          reason: selection.reason,
          source: "baige_identity_lookup",
          candidateCards: mergeCandidateSummaries(
            mention.candidateCards,
            selection.candidates.slice(0, 3).map(summarizeExternalCandidate),
          ),
        });
        result.warnings.push(`baige_identity_ambiguous:${normalizeCardKey(input)}`);
      }
      continue;
    }

    const externalCard = {
      ...selection.card,
      input,
      matchedQuery: input,
      resolutionSource: "baige_identity_lookup",
      externalIdentityComplete: true,
      externalIdentityResolution: selection.reason,
      aliases: unique([
        ...cardNames(selection.card),
        input,
      ]),
    };
    const canonical = canonicalizeExternalCardIdentity(externalCard, canonicalCards);
    if (hasLocalAmbiguity(mention)
        && !canonicalResolvesLocalAmbiguity(canonical, mention)) {
      result.ambiguousMentions.push({
        ...mention,
        input,
        reason: "external_identity_does_not_resolve_local_ambiguity",
        source: "baige_identity_lookup",
        candidateCards: mergeCandidateSummaries(
          mention.candidateCards,
          selection.candidates.map(summarizeExternalCandidate),
        ),
      });
      result.warnings.push(`baige_identity_ambiguous:${normalizeCardKey(input)}`);
      continue;
    }
    if (!String(canonical.effectText || canonical.text || "").trim()) {
      result.ambiguousMentions.push({
        input,
        reason: "external_identity_missing_card_text",
        source: "baige_identity_lookup",
        candidateCards: [summarizeExternalCandidate(selection.card)],
      });
      result.warnings.push(`baige_identity_missing_card_text:${normalizeCardKey(input)}`);
      continue;
    }
    result.resolvedCards.push(canonical);
    result.warnings.push(`baige_identity_resolved:${normalizeCardKey(input)}`);
  }
  result.resolvedCards = dedupeResolvedCards(result.resolvedCards).slice(0, maxResolved);
  result.ambiguousMentions = cleanMentions(result.ambiguousMentions);
  result.warnings = unique(result.warnings);
  result.providerWarnings = unique(result.providerWarnings);
  return result;
}

function selectExternalIdentityCandidate(candidates, input, { minConfidence, minMargin }, canonicalCards = []) {
  const byIdentity = new Map();
  for (const candidate of candidates || []) {
    if (!hasStableExternalIdentity(candidate)) continue;
    const key = externalIdentityKey(candidate);
    if (!key) continue;
    const previous = byIdentity.get(key);
    if (!previous || Number(candidate.confidence || 0) > Number(previous.confidence || 0)) {
      byIdentity.set(key, candidate);
    }
  }
  const uniqueCandidates = [...byIdentity.values()].sort((left, right) => (
    Number(right.confidence || 0) - Number(left.confidence || 0)
      || externalIdentityKey(left).localeCompare(externalIdentityKey(right))
  ));
  if (!uniqueCandidates.length) {
    const incomplete = (candidates || []).filter(Boolean);
    return {
      card: null,
      candidates: incomplete,
      reason: incomplete.length ? "external_identity_incomplete" : "external_identity_not_found",
    };
  }

  const inputKey = normalizeConservativeNameKey(input);
  const exactPrimary = uniqueCandidates.filter((candidate) => (
    externalPrimaryNames(candidate).some((name) => normalizeConservativeNameKey(name) === inputKey)
  ));
  if (new Set(exactPrimary.map(externalIdentityKey)).size === 1 && exactPrimary.length) {
    return { card: exactPrimary[0], candidates: uniqueCandidates, reason: "unique_exact_primary_name" };
  }
  if (exactPrimary.length > 1) {
    return { card: null, candidates: exactPrimary, reason: "conflicting_exact_primary_names" };
  }

  const best = uniqueCandidates[0];
  const bestConfidence = Number(best.confidence || 0);
  const stableLocalIdentity = hasUniqueStableLocalIdentityMatch(best, canonicalCards);
  if (uniqueCandidates.length === 1 && bestConfidence >= minConfidence && stableLocalIdentity) {
    return { card: best, candidates: uniqueCandidates, reason: "single_high_confidence_identity" };
  }
  const runnerUpConfidence = Number(uniqueCandidates[1]?.confidence || 0);
  if (bestConfidence >= minConfidence
      && bestConfidence - runnerUpConfidence >= minMargin
      && stableLocalIdentity) {
    return { card: best, candidates: uniqueCandidates, reason: "safe_confidence_margin" };
  }
  if (bestConfidence >= minConfidence && !stableLocalIdentity) {
    return {
      card: null,
      candidates: uniqueCandidates,
      reason: "fuzzy_identity_not_corroborated_by_local_catalog",
    };
  }
  return { card: null, candidates: uniqueCandidates, reason: "conflicting_external_identities" };
}

function hasUniqueStableLocalIdentityMatch(externalCard, canonicalCards) {
  const result = resolveStableLocalIdentity(externalCard, canonicalCards);
  return result.status === "matched" && result.namespace !== "name";
}

function normalizeConservativeNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[雙]/gu, "双")
    .replace(/[來]/gu, "来")
    .replace(/[龍]/gu, "龙")
    .replace(/[薔]/gu, "蔷")
    .replace(/[蘇]/gu, "苏")
    .replace(/[場]/gu, "场")
    .replace(/[發]/gu, "发")
    .replace(/[動]/gu, "动")
    .replace(/[體]/gu, "体")
    .replace(/[從]/gu, "从")
    .replace(/[對]/gu, "对")
    .replace(/[選]/gu, "选")
    .replace(/[闕]/gu, "阙")
    .replace(/[歩]/gu, "步")
    .replace(/[義]/gu, "义")
    .replace(/[賊]/gu, "贼")
    .replace(/喰/gu, "食")
    .replace(/導/gu, "导")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[：:・·･．.－—–_\-\s]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}]/gu, "")
    .trim();
}

function hasStableExternalIdentity(card) {
  return Boolean(
    externalIdentityKey(card)
      && externalPrimaryNames(card).length,
  );
}

function externalIdentityKey(card) {
  const cid = normalizeId(card?.cid);
  if (cid) return `cid:${cid}`;
  const passcode = normalizeId(card?.passcode || card?.password || (
    card?.source === "baige" || card?.provider === "baige"
      ? card?.id || card?.cardId
      : ""
  ));
  if (passcode) return `passcode:${passcode}`;
  const primary = externalPrimaryNames(card)
    .map(normalizeConservativeNameKey)
    .filter(Boolean)
    .sort()[0];
  return primary ? `name:${primary}` : "";
}

export function canonicalizeExternalCardIdentity(externalCard, canonicalCards) {
  const localIdentity = resolveStableLocalIdentity(externalCard, canonicalCards);
  // A matching name is useful diagnostic information, not a stable namespace.
  // Only a unique CID or passcode match may authorize access to local corpus
  // text, FAQ or Q&A records.
  if (localIdentity.status !== "matched" || localIdentity.namespace === "name") {
    return externalCard;
  }
  const localCard = localIdentity.card;
  const localCorpusId = normalizeId(localCard.id || localCard.cardId);
  const externalPasscode = normalizeId(
    externalCard?.passcode || externalCard?.password || externalCard?.id || externalCard?.cardId,
  );
  return {
    ...externalCard,
    ...localCard,
    // Keep the two namespaces explicit after canonicalization: `id/cardId`
    // address the local CID corpus, while `passcode` remains the printed card
    // password supplied by Baige (or by the local record when available).
    id: localCorpusId,
    cardId: localCorpusId,
    passcode: localCardPasscode(localCard) || externalPasscode,
    input: externalCard.input,
    matchedQuery: externalCard.matchedQuery,
    resolutionSource: externalCard.resolutionSource,
    externalIdentityComplete: true,
    externalIdentityResolution: externalCard.externalIdentityResolution,
    canonicalLocalIdentity: true,
    aliases: unique([...cardNames(externalCard), ...cardNames(localCard)]),
  };
}

export function resolveStableLocalIdentity(externalCard, canonicalCards) {
  const externalCid = normalizeId(externalCard?.cid);
  if (externalCid) {
    return uniqueLocalIdentityResult(
      (canonicalCards || []).filter((card) => localCardCid(card) === externalCid),
      "cid",
    );
  }

  const externalPasscode = normalizeId(
    externalCard?.passcode || externalCard?.password || externalCard?.id || externalCard?.cardId,
  );
  if (externalPasscode) {
    return uniqueLocalIdentityResult(
      (canonicalCards || []).filter((card) => localCardPasscode(card) === externalPasscode),
      "passcode",
    );
  }

  const externalNames = new Set(externalPrimaryNames(externalCard)
    .map(normalizeConservativeNameKey)
    .filter(Boolean));
  if (!externalNames.size) return { status: "absent", namespace: "name", card: null };
  return uniqueLocalIdentityResult(
    (canonicalCards || []).filter((card) => cardNames(card).some((name) => (
      externalNames.has(normalizeConservativeNameKey(name))
    ))),
    "name",
  );
}

function uniqueLocalIdentityResult(cards, namespace) {
  const candidates = uniqueObjects(cards);
  if (candidates.length === 1) return { status: "matched", namespace, card: candidates[0] };
  return {
    status: candidates.length ? "conflict" : "unmatched",
    namespace,
    card: null,
  };
}

function hasLocalAmbiguity(mention) {
  return Array.isArray(mention?.candidateCards) && mention.candidateCards.length > 0;
}

function canonicalResolvesLocalAmbiguity(card, mention) {
  if (card?.canonicalLocalIdentity !== true) return false;
  const localId = rawGenericCorpusCardId(card);
  if (!localId) return false;
  const allowedIds = new Set((mention.candidateCards || [])
    .map((candidate) => normalizeId(candidate?.id || candidate?.cardId))
    .filter(Boolean));
  return allowedIds.has(localId);
}

function mergeCandidateSummaries(left, right) {
  const merged = new Map();
  for (const candidate of [...(left || []), ...(right || [])]) {
    const id = String(candidate?.id || candidate?.cardId || "");
    const name = String(candidate?.name || candidate?.cnName || candidate?.jaName || candidate?.enName || "");
    const key = `${normalizeId(id)}:${normalizeConservativeNameKey(name)}`;
    if (key !== ":" && !merged.has(key)) merged.set(key, candidate);
  }
  return [...merged.values()].slice(0, 8);
}

function localCardCid(card) {
  const explicit = normalizeId(card?.cid);
  if (explicit) return explicit;
  const sourceUrlCid = String(card?.sourceUrl || "")
    .match(/[?&]cid=(\d{1,7})(?:&|$)/u)?.[1];
  if (sourceUrlCid) return normalizeId(sourceUrlCid);
  // The normalized synchronized card corpus stores KONAMI database CIDs in
  // `id`; constrain the fallback to the CID-sized namespace. An eight-digit
  // Baige password must never match it through this branch.
  const id = normalizeId(card?.id || card?.cardId);
  return /^[1-9]\d{2,6}$/u.test(id) ? id : "";
}

function localCardPasscode(card) {
  return normalizeId(card?.passcode || card?.password);
}

function dedupeResolvedCards(cards) {
  const result = [];
  const seen = new Set();
  for (const card of cards || []) {
    const key = card?.canonicalLocalIdentity === true || card?.source !== "baige"
      ? `local:${normalizeId(card?.id || card?.cardId) || normalizeCardKey(card?.name)}`
      : externalIdentityKey(card);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(card);
  }
  return result;
}

function uniqueObjects(items) {
  return [...new Set(items)];
}

function externalPrimaryNames(card) {
  const explicit = Array.isArray(card?.providerPrimaryNames)
    ? card.providerPrimaryNames
    : [card?.cnName, card?.jaName, card?.jpName, card?.enName];
  return unique(explicit.map((value) => String(value || "").trim()).filter(Boolean));
}

function summarizeExternalCandidate(card) {
  return cleanObject({
    id: String(card?.id || card?.cardId || ""),
    cid: card?.cid ?? null,
    name: String(card?.name || card?.cnName || card?.jaName || card?.enName || ""),
    source: "baige",
    confidence: finiteOrNull(card?.confidence),
  });
}

function cleanMentions(items) {
  const result = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const input = String(item?.input || "").trim();
    const key = normalizeCardKey(input);
    if (!key) continue;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, item);
      continue;
    }
    const itemHasLocalCandidates = Array.isArray(item?.candidateCards)
      && item.candidateCards.length > 0;
    const preferred = itemHasLocalCandidates ? item : existing;
    const candidateCards = mergeCandidateSummaries(
      existing.candidateCards,
      item.candidateCards,
    );
    result.set(key, {
      ...existing,
      ...preferred,
      input: String(preferred.input || existing.input || input),
      ...(candidateCards.length ? { candidateCards } : {}),
    });
  }
  return [...result.values()];
}

function cardNames(card) {
  return unique([
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...(card?.aliases || []),
  ].map(String).filter(Boolean));
}

function createQuestionCardIdResolver(cards = []) {
  const aliases = new Map();
  for (const card of cards || []) {
    const id = normalizeId(card?.id || card?.cardId || card?.cid || card?.passcode);
    if (!id) continue;
    for (const name of cardNames(card)) {
      const key = normalizeCardKey(name);
      if (!key) continue;
      const ids = aliases.get(key) || new Set();
      ids.add(id);
      aliases.set(key, ids);
    }
  }
  const uniqueAliases = [...aliases.entries()]
    .filter(([key, ids]) => ids.size === 1 && isSafeQuestionAliasKey(key))
    .map(([key, ids]) => ({ key, id: [...ids][0] }))
    .sort((left, right) => right.key.length - left.key.length || left.key.localeCompare(right.key));
  const trie = buildAliasTrie(uniqueAliases);
  const fragmentAliasesByGram = buildFragmentAliasIndex(aliases);

  return (questionSide) => {
    const raw = String(questionSide || "");
    const key = normalizeCardKey(raw);
    if (!key) return [];
    const matches = [];
    for (let start = 0; start < key.length; start += 1) {
      let node = trie;
      for (let cursor = start; cursor < key.length; cursor += 1) {
        node = node.children.get(key[cursor]);
        if (!node) break;
        if (node.id) matches.push({ id: node.id, start, end: cursor + 1 });
      }
    }
    matches.sort((left, right) => (
      (right.end - right.start) - (left.end - left.start)
        || left.start - right.start
        || left.id.localeCompare(right.id)
    ));
    const selected = [];
    for (const match of matches) {
      if (selected.some((item) => match.start < item.end && match.end > item.start)) continue;
      selected.push(match);
    }

    // Quotation makes a two-character surface explicit. It is still accepted
    // only when the catalogue maps that exact surface (or unique fragment) to
    // exactly one identity.
    for (const surface of quotedSurfaces(raw)) {
      const surfaceKey = normalizeCardKey(surface);
      if (!surfaceKey || surfaceKey.length < 2) continue;
      const exact = aliases.get(surfaceKey);
      const candidateIds = exact?.size
        ? [...exact]
        : unique([...(fragmentAliasesByGram.get(surfaceKey.slice(0, 2)) || [])]
            .filter((alias) => alias.includes(surfaceKey))
            .flatMap((alias) => [...(aliases.get(alias) || [])]));
      if (candidateIds.length === 1) selected.push({ id: candidateIds[0], start: -1, end: -1 });
    }
    return unique(selected.map((item) => item.id)).sort();
  };
}

function isSafeQuestionAliasKey(key) {
  return key.length >= 4;
}

function buildAliasTrie(entries) {
  const root = { children: new Map(), id: "" };
  for (const entry of entries || []) {
    let node = root;
    for (const character of entry.key) {
      if (!node.children.has(character)) {
        node.children.set(character, { children: new Map(), id: "" });
      }
      node = node.children.get(character);
    }
    node.id = entry.id;
  }
  return root;
}

function buildFragmentAliasIndex(aliases) {
  const index = new Map();
  for (const alias of aliases.keys()) {
    if (alias.length < 2) continue;
    const grams = new Set();
    for (let offset = 0; offset < alias.length - 1; offset += 1) {
      grams.add(alias.slice(offset, offset + 2));
    }
    for (const gram of grams) {
      const values = index.get(gram) || [];
      values.push(alias);
      index.set(gram, values);
    }
  }
  return index;
}

function quotedSurfaces(value) {
  const result = [];
  for (const pattern of [
    /「([^」\r\n]{2,120})」/gu,
    /『([^』\r\n]{2,120})』/gu,
    /《([^》\r\n]{2,120})》/gu,
    /【([^】\r\n]{2,120})】/gu,
    /“([^”\r\n]{2,120})”/gu,
    /"([^"\r\n]{2,120})"/gu,
  ]) {
    for (const match of String(value || "").matchAll(pattern)) result.push(String(match[1] || ""));
  }
  return unique(result);
}

function addIndexCandidate(index, key, value) {
  if (!key) return;
  const candidates = index.get(key) || [];
  if (!candidates.includes(value)) candidates.push(value);
  index.set(key, candidates);
}

function isIdentityComplete(cardResolution) {
  return (cardResolution.resolvedCards || []).length > 0
    && !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length;
}

function equalStringSets(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function extractInlineCardIds(value) {
  return [...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)]
    .map((match) => match[1]);
}

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}

function stableRecordKey(record) {
  const explicit = String(
    record.id
      || record.evidenceId
      || record.stableId
      || record.sourceRecordId
      || "",
  ).replace(/@[a-f0-9]{8,}(?=#|$)/iu, "");
  if (explicit) return explicit;
  return [record.recordType, record.sourceUrl, record.title, record.question]
    .map((item) => normalizeCardKey(item))
    .filter(Boolean)
    .join(":")
    .slice(0, 480);
}

function readLimits(env) {
  return {
    maxCards: readPositiveNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readPositiveNumber(env.RAG_MAX_OFFICIAL_QA, 7),
    maxRelatedEvidence: readPositiveNumber(env.RAG_MAX_RELATED_EVIDENCE, 14),
    maxRuleSearchQueries: readPositiveNumber(env.RAG_MAX_RULE_SEARCH_QUERIES, 8),
    maxCardTextChars: readPositiveNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readPositiveNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
  };
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function readDecimal(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 1e6) / 1e6;
}

function cleanObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => (
    value !== "" && value !== null && value !== undefined
  )));
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function unique(values) {
  return [...new Set(values)];
}
