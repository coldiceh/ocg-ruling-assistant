import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchCards } from "./baigeCardProvider.mjs";
import { createLocalCardDataProvider } from "./cardDataProvider.mjs";
import { normalizeCardKey } from "./ragCardExtractor.mjs";
import { searchOfficialQaEvidence } from "./officialQaMatcher.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const dataCache = new Map();

export async function retrieveRagEvidence({
  userQuery,
  cardResolution = {},
  dataDir = defaultDataDir,
  cards,
  records,
  qaRecords,
  ruleSearchQueries = [],
  maxPerBucket = 5,
  env = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const limits = readRetrievalLimits(env, maxPerBucket);
  const data = cards || records || qaRecords
    ? normalizeInjectedData({ cards, records, qaRecords })
    : await loadRagData(dataDir);
  const cardProvider = createLocalCardDataProvider(data);
  const resolvedCards = cardResolution.resolvedCards || [];
  const providedTexts = normalizeUserProvidedCardTexts(cardResolution.userProvidedCardTexts || [], limits);
  const normalizedRuleQueries = normalizeRuleSearchQueries(ruleSearchQueries, limits);
  const retrievalWarnings = [];
  const baigeDebug = { searchCount: 0, cacheHitCount: 0, warnings: [], ambiguousMentions: [] };
  const fuzzyCards = resolveUnresolvedMentionCards(cardResolution.unresolvedMentions || [], cardProvider, limits, retrievalWarnings);
  const providedNameKeys = new Set(providedTexts.map((item) => normalizeCardKey(item.name)).filter(Boolean));
  const unresolvedForBaige = (cardResolution.unresolvedMentions || [])
    .filter((mention) => !providedNameKeys.has(normalizeCardKey(mention.input)));
  const [enrichedLocalCards, baigeResolvedCards] = await Promise.all([
    enrichCardsWithBaige(dedupeCards([...resolvedCards, ...fuzzyCards]), { fetchImpl, env, limits, warnings: retrievalWarnings, debug: baigeDebug }),
    resolveUnresolvedMentionCardsWithBaige(unresolvedForBaige, { fetchImpl, env, limits, warnings: retrievalWarnings, debug: baigeDebug }),
  ]);
  const retrievalCards = dedupeCards([...enrichedLocalCards, ...baigeResolvedCards]).slice(0, limits.maxCards);
  const mentionQueries = [
    ...(cardResolution.unresolvedMentions || []).map((item) => item.input),
    ...providedTexts.map((item) => item.name),
    ...normalizedRuleQueries.map((item) => item.query),
  ].filter(Boolean);
  if (fuzzyCards.length) retrievalWarnings.push(`unresolved_mentions_fuzzy_matched:${fuzzyCards.map((card) => card.name).join(",")}`);
  if (baigeResolvedCards.length) retrievalWarnings.push(`unresolved_mentions_baige_matched:${baigeResolvedCards.map((card) => card.name).join(",")}`);
  if (providedTexts.length) retrievalWarnings.push("user_provided_text_not_official");
  if (normalizedRuleQueries.length) retrievalWarnings.push(`rule_search_queries_used:${normalizedRuleQueries.length}`);
  const allEvidenceRecords = [...data.records, ...data.qaRecords];

  const cardTexts = retrievalCards
    .map((card) => findCardRecord(card, data.cards) || cardProvider.getCardProfile(card.id || card.cardId) || card)
    .filter(Boolean)
    .map((card) => cardTextEvidence(card, limits.maxCardTextChars, retrievalWarnings));

  const officialMatches = searchOfficialQaEvidence({
    question: userQuery,
    records: data.qaRecords,
    resolvedCards: retrievalCards,
    limit: Math.max(20, limits.maxOfficialQa * 4),
  });
  const officialQaDirectCandidates = officialMatches.exact
    .map((match) => evidenceFromOfficialMatch(match, "official_qa", limits.maxEvidenceTextChars, retrievalWarnings))
    .slice(0, limits.maxOfficialQa);
  const directIds = new Set(officialQaDirectCandidates.map((item) => item.id));

  const officialQaRelatedSource = [
    ...officialMatches.near,
    ...officialMatches.related,
    ...rankRecords({
      userQuery,
      records: data.qaRecords.filter((record) => record.recordType === "qa"),
      resolvedCards: retrievalCards,
      mentionQueries,
      ruleSearchQueries: normalizedRuleQueries,
      allowNoCardMatch: normalizedRuleQueries.length > 0,
    }),
  ];
  if (officialQaRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`official_related_limited:${officialQaRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const officialQaRelated = officialQaRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((item) => item.record
      ? evidenceFromOfficialMatch(item, "related", limits.maxEvidenceTextChars, retrievalWarnings)
      : evidenceFromRecord(item, "related", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));

  const faqRelatedSource = rankRecords({
    userQuery,
    records: allEvidenceRecords.filter((record) => record.recordType === "card-faq"),
    resolvedCards: retrievalCards,
    mentionQueries,
    ruleSearchQueries: normalizedRuleQueries,
    allowNoCardMatch: normalizedRuleQueries.length > 0,
  });
  if (faqRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`faq_related_limited:${faqRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const faqRelated = faqRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => evidenceFromRecord(record, "faq", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));

  const rawRelatedSource = rankRecords({
    userQuery,
    records: allEvidenceRecords.filter((record) => !["card-faq", "card-text"].includes(record.recordType)),
    resolvedCards: retrievalCards,
    mentionQueries,
    ruleSearchQueries: normalizedRuleQueries,
    allowNoCardMatch: true,
  });
  if (rawRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`raw_related_limited:${rawRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const rawRelatedEvidence = rawRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => evidenceFromRecord(record, record.recordType === "qa" ? "related" : "related", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));

  if (!resolvedCards.length) retrievalWarnings.push("card_name_not_resolved_raw_query_fallback_used");
  if (!cardTexts.length && retrievalCards.length) retrievalWarnings.push("resolved_card_text_not_found");
  if (!officialQaDirectCandidates.length) retrievalWarnings.push("official_direct_qa_not_found");

  return {
    cardTexts: dedupeEvidence(cardTexts),
    userProvidedCardTexts: dedupeEvidence(providedTexts.map((item, index) => userProvidedTextEvidence(item, index, limits.maxCardTextChars, retrievalWarnings))),
    officialQaDirectCandidates: dedupeEvidence(officialQaDirectCandidates),
    officialQaRelated: dedupeEvidence(officialQaRelated),
    faqRelated: dedupeEvidence(faqRelated),
    rawRelatedEvidence: dedupeEvidence(rawRelatedEvidence),
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
      ruleSearchQueryCount: normalizedRuleQueries.length,
      ruleSearchQueries: normalizedRuleQueries,
      baigeSearchCount: baigeDebug.searchCount,
      baigeCacheHitCount: baigeDebug.cacheHitCount,
      baigeWarnings: baigeDebug.warnings,
    },
  };
}

export async function loadRagData(dataDir = defaultDataDir) {
  const key = dataDir;
  if (dataCache.has(key)) return dataCache.get(key);
  const [cardsPayload, rulingsPayload, qaPayload, evidencePayload] = await Promise.all([
    readJson(join(dataDir, "cards.json"), { records: [] }),
    readJson(join(dataDir, "rulings.json"), { records: [] }),
    readJson(join(dataDir, "qa-index.json"), { records: [] }),
    readJson(join(dataDir, "evidence-index.json"), { records: [] }),
  ]);
  const data = normalizeInjectedData({
    cards: cardsPayload.records || cardsPayload.cards || [],
    records: [
      ...(rulingsPayload.records || []),
      ...(evidencePayload.records || []),
    ],
    qaRecords: qaPayload.records || [],
  });
  dataCache.set(key, data);
  return data;
}

export function evidenceBucketsToList(evidence = {}) {
  return [
    ...(evidence.cardTexts || []),
    ...(evidence.userProvidedCardTexts || []),
    ...(evidence.officialQaDirectCandidates || []),
    ...(evidence.officialQaRelated || []),
    ...(evidence.faqRelated || []),
    ...(evidence.rawRelatedEvidence || []),
  ];
}

function normalizeInjectedData({ cards = [], records = [], qaRecords = [] }) {
  const normalizedCards = (Array.isArray(cards) ? cards : []).map(normalizeCard).filter((card) => card.name);
  const normalizedRecords = (Array.isArray(records) ? records : []).map(normalizeRecord).filter((record) => record.id && record.text);
  const normalizedQaRecords = (Array.isArray(qaRecords) ? qaRecords : []).map(normalizeRecord).filter((record) => record.id && record.text);
  return { cards: normalizedCards, records: normalizedRecords, qaRecords: normalizedQaRecords };
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
  const cardIds = [record.cardId, ...(record.cardIds || [])].map((item) => String(item || "")).filter(Boolean);
  const cards = [record.cardName, ...(record.cards || []), ...(record.cardNames || [])].filter(Boolean);
  const text = [
    record.title,
    record.question,
    record.answer,
    record.conclusion,
    record.text,
    record.officialText,
  ].filter(Boolean).join("\n").trim();
  return {
    ...record,
    id,
    recordType: record.recordType || inferRecordType(record, id),
    title: record.title || record.question || id,
    question: record.question || "",
    answer: record.answer || record.conclusion || "",
    text,
    cardIds,
    cards,
    sourceUrl: record.sourceUrl || record.officialUrl || "",
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
  return {
    id: `card-text-${card.id || normalizeCardKey(card.name)}`,
    type: isBaige ? "baige_card_text" : "card_text",
    title: `${card.name} 的卡片文本`,
    cardIds: [card.id || card.cardId].filter(Boolean).map(String),
    cards: [card.name].filter(Boolean),
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: card.sourceUrl || "",
    source: isBaige ? "baige" : card.source || "",
    official: false,
    isDirect: false,
  };
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
    cards: record.cards || record.cardNames || [],
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: record.sourceUrl || record.officialUrl || "",
    isDirect: false,
  };
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
  return (records || [])
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
    .map((item) => item.record);
}

function scoreRecord(record, { queryTerms, ruleTerms, rulePhrases, queryKey, resolvedIds, resolvedNames, unresolvedNames, allowNoCardMatch }) {
  const text = `${record.title || ""}\n${record.text || ""}`;
  const textKey = normalizeCardKey(text);
  const cardIdMatch = (record.cardIds || []).some((id) => resolvedIds.has(normalizeId(id)));
  const cardNameMatch = (record.cards || []).some((name) => resolvedNames.has(normalizeCardKey(name))) || [...resolvedNames].some((name) => name.length >= 3 && textKey.includes(name));
  const unresolvedNameMatch = [...unresolvedNames].some((name) => name.length >= 3 && textKey.includes(name));
  const cardScore = cardIdMatch ? 5 : cardNameMatch ? 4 : unresolvedNameMatch ? 2 : 0;
  if (!allowNoCardMatch && resolvedIds.size + resolvedNames.size > 0 && !cardScore) return 0;
  let score = cardScore;
  for (const term of queryTerms) {
    if (textKey.includes(term)) score += 1;
  }
  for (const term of ruleTerms || []) {
    if (textKey.includes(term)) score += 2;
  }
  for (const phrase of rulePhrases || []) {
    if (phrase.length >= 4 && textKey.includes(phrase.slice(0, Math.min(phrase.length, 80)))) score += 4;
  }
  if (queryKey.length >= 8 && textKey.includes(queryKey.slice(0, Math.min(queryKey.length, 80)))) score += 5;
  if (record.recordType === "qa") score += 0.5;
  if (record.recordType === "card-faq") score += 0.4;
  return score;
}

function normalizeRuleSearchQueries(items, limits = {}) {
  const max = readPositiveNumber(limits.maxRuleSearchQueries || limits.maxRelatedEvidence, 8);
  const source = Array.isArray(items) ? items : [];
  return dedupeBy(source
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
    .filter((item) => item.query && /[A-Za-z\u3040-\u30ff\u3400-\u9fff0-9]/u.test(item.query))
    .slice(0, max), (item) => normalizeCardKey(item.query));
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

function resolveUnresolvedMentionCards(unresolvedMentions, cardProvider, limits, warnings) {
  const result = [];
  const minConfidence = readPositiveDecimal(limits.localFuzzyMinConfidence, 0.74);
  for (const mention of unresolvedMentions || []) {
    if (result.length >= limits.maxCards) break;
    const matches = cardProvider.searchCardByName(mention.input, 2);
    if (!matches.length) continue;
    const best = matches[0];
    if (best.confidence < minConfidence) {
      warnings.push(`unresolved_mention_fuzzy_low_confidence:${mention.input}->${best.name}:${best.confidence}`);
      continue;
    }
    warnings.push(`unresolved_mention_fuzzy_match:${mention.input}->${best.name}`);
    result.push({
      ...best,
      input: mention.input,
      confidence: Math.min(best.confidence, 0.7),
    });
  }
  return dedupeCards(result);
}

async function resolveUnresolvedMentionCardsWithBaige(unresolvedMentions, { fetchImpl, env, limits, warnings, debug }) {
  const result = [];
  const minConfidence = readPositiveDecimal(env.RAG_BAIGE_MIN_CONFIDENCE, 0.72);
  for (const mention of unresolvedMentions || []) {
    if (result.length >= limits.maxCards) break;
    const searchResult = await searchBaige(mention.input, { fetchImpl, env, limits, debug });
    warnings.push(...searchResult.warnings);
    const candidates = searchResult.results || [];
    if (!candidates.length) {
      warnings.push(`baige_no_result:${mention.input}`);
      continue;
    }
    const best = candidates[0];
    const confident = Number(best.confidence || 0) >= minConfidence;
    if (!confident) {
      debug.ambiguousMentions.push({
        input: mention.input,
        candidateCards: candidates.slice(0, 3).map((card) => ({
          id: card.id || card.cardId || "",
          name: card.name || card.cnName || card.jpName || card.enName || "",
          source: "baige",
          confidence: card.confidence || 0,
        })),
      });
      warnings.push(`baige_ambiguous:${mention.input}`);
      continue;
    }
    warnings.push(`baige_match:${mention.input}->${best.name}`);
    result.push(toRagCard(best, mention.input, Number(best.confidence || 0)));
  }
  return dedupeCards(result);
}

async function enrichCardsWithBaige(cards, { fetchImpl, env, limits, warnings, debug }) {
  const result = [];
  for (const card of cards || []) {
    if (result.length >= limits.maxCards) break;
    if (hasUsableCardText(card) && (card.id || card.cardId) && card.sourceUrl) {
      result.push(card);
      continue;
    }
    const query = card.name || card.cnName || card.jaName || card.enName || card.input;
    if (!query) {
      result.push(card);
      continue;
    }
    const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug });
    warnings.push(...searchResult.warnings);
    const best = (searchResult.results || [])[0];
    if (!best || Number(best.confidence || 0) < 0.72) {
      result.push(card);
      continue;
    }
    result.push(mergeCard(card, toRagCard(best, card.input || query, Number(best.confidence || 0))));
  }
  return result;
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
    name: card.name || card.cnName || card.jpName || card.enName || String(input || ""),
    cnName: card.cnName || "",
    jaName: card.jaName || card.jpName || "",
    jpName: card.jpName || card.jaName || "",
    enName: card.enName || "",
    cardType: card.cardType || card.type || "",
    effectText: card.effectText || card.text || "",
    text: card.text || card.effectText || "",
    source: "baige",
    sourceLabel: "百鸽",
    sourceUrl: card.sourceUrl || "",
    imageUrl: card.imageUrl || "",
    imageCandidates: card.imageCandidates || [],
    official: false,
    aliases: card.aliases || [card.name, card.cnName, card.jpName, card.enName].filter(Boolean),
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
    name: localCard.name || baigeCard.name,
    cnName: localCard.cnName || baigeCard.cnName,
    jaName: localCard.jaName || baigeCard.jaName,
    jpName: localCard.jpName || baigeCard.jpName,
    enName: localCard.enName || baigeCard.enName,
    cardType: localCard.cardType || baigeCard.cardType,
    effectText: localCard.effectText || baigeCard.effectText,
    text: localCard.text || localCard.effectText || baigeCard.text,
    source: localCard.source || baigeCard.source,
    sourceLabel: localCard.sourceLabel || baigeCard.sourceLabel,
    sourceUrl: localCard.sourceUrl || baigeCard.sourceUrl,
    imageUrl: localCard.imageUrl || baigeCard.imageUrl,
    imageCandidates: [...new Set([...(localCard.imageCandidates || []), ...(baigeCard.imageCandidates || [])])],
    aliases: [...new Set([...(localCard.aliases || []), ...(baigeCard.aliases || [])])],
    official: false,
    confidence: Math.max(Number(localCard.confidence || 0), Number(baigeCard.confidence || 0)),
  };
}

function hasUsableCardText(card) {
  return Boolean(String(card.effectText || card.text || "").trim());
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
  return dedupeBy(items.filter((item) => item.id && item.text), (item) => `${item.type}:${item.id}`);
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
    maxRelatedEvidence: readPositiveNumber(env.RAG_MAX_RELATED_EVIDENCE, Math.max(8, maxPerBucket)),
    maxCardTextChars: readPositiveNumber(env.RAG_MAX_CARD_TEXT_CHARS, 2500),
    maxEvidenceTextChars: readPositiveNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 1600),
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

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
