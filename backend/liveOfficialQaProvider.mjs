const DEFAULT_BASE_URL = "https://db.ygoresources.com";
const DEFAULT_TIMEOUT_MS = 1800;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const NON_RACE_PROPERTIES = new Set([
  "effect",
  "normal",
  "flip",
  "union",
  "fusion",
  "pendulum",
  "xyz",
  "synchro",
  "tuner",
  "link",
  "spirit",
  "ritual",
  "gemini",
  "toon",
  "special summon monster",
]);

const cacheByFetchImpl = new WeakMap();

export async function retrieveLiveOfficialQa({
  resolvedCards = [],
  candidateQaIds = [],
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxCandidates = 8,
} = {}) {
  const cards = dedupeCardsById(resolvedCards).slice(0, 6);
  const preferredCandidateQaIds = uniqueNumericIds(candidateQaIds);
  if ((!cards.length && !preferredCandidateQaIds.length) || typeof fetchImpl !== "function") {
    return emptyResult("live_qa_requires_resolved_cards_or_local_candidates");
  }

  const warnings = [];
  const [cardPayloadResults, propertyMetadataResult] = await Promise.all([
    Promise.all(cards.map(async (card) => {
      try {
        const payload = await fetchJsonResilient(fetchImpl, `${baseUrl}/data/card/${encodeURIComponent(card.id)}`, {
          timeoutMs,
          cacheTtlMs,
        });
        return { card, payload };
      } catch (error) {
        warnings.push(`live_card_qa_index_failed:${card.id}:${errorCode(error)}`);
        return null;
      }
    })),
    cards.length
      ? fetchJsonResilient(fetchImpl, `${baseUrl}/data/meta/mprop`, { timeoutMs, cacheTtlMs })
        .catch((error) => {
          warnings.push(`live_monster_property_metadata_failed:${errorCode(error)}`);
          return [];
        })
      : Promise.resolve([]),
  ]);
  const cardPayloads = cardPayloadResults.filter(Boolean);
  if (cards.length && !cardPayloads.length && !preferredCandidateQaIds.length) {
    return { ...emptyResult("live_card_qa_index_incomplete"), warnings };
  }
  const allCardIndexesAvailable = cardPayloads.length === cards.length;
  if (!allCardIndexesAvailable) warnings.push("live_card_qa_index_partial");

  const propertyMetadata = propertyMetadataResult;
  const cardMetadata = cardPayloads.map(({ card, payload }) => normalizeCardMetadata(card, payload, propertyMetadata));
  const indexedSelection = selectRelevantQaIds(cardPayloads.map(({ card, payload }) => ({
    cardId: card.id,
    qaIds: collectQaIds(payload?.qaIndex),
  })), maxCandidates);
  indexedSelection.uniqueExactCardIntersection = allCardIndexesAvailable && indexedSelection.uniqueExactCardIntersection;
  const qaSelection = {
    ...indexedSelection,
    ids: uniqueNumericIds([...indexedSelection.ids, ...preferredCandidateQaIds])
      .slice(0, positiveInteger(maxCandidates, 8)),
    candidateQaIds: preferredCandidateQaIds,
  };
  qaSelection.uniqueExactQaId = qaSelection.uniqueExactCardIntersection
    ? qaSelection.uniqueExactQaId : null;
  if (!qaSelection.ids.length) {
    return {
      records: [],
      cardMetadata,
      warnings: [...warnings, "live_shared_qa_not_found"],
      debug: qaSelection,
    };
  }

  const cardNameById = new Map(cards.map((card) => [String(card.id), displayCardName(card)]));
  const fetchedRecords = (await Promise.all(qaSelection.ids.map(async (qaId) => {
    try {
      const payload = await fetchJsonResilient(fetchImpl, `${baseUrl}/data/qa/${encodeURIComponent(qaId)}`, {
        timeoutMs,
        cacheTtlMs,
      });
      return normalizeQaRecord(qaId, payload, cardNameById, qaSelection);
    } catch (error) {
      warnings.push(`live_qa_fetch_failed:${qaId}:${errorCode(error)}`);
      return null;
    }
  }))).filter(Boolean);
  const fetchedRecordIds = new Set(fetchedRecords.map((record) => String(record.sourceId || "")));
  const candidatePoolComplete = allCardIndexesAvailable
    && indexedSelection.candidatePoolSize <= positiveInteger(maxCandidates, 8)
    && indexedSelection.ids.every((id) => fetchedRecordIds.has(String(id)));
  const records = fetchedRecords.map((record) => ({
    ...record,
    retrievalContext: {
      ...(record.retrievalContext || {}),
      candidatePoolComplete,
      fetchedCandidateCount: fetchedRecords.length,
      selectedCandidateCount: qaSelection.ids.length,
      allCardIndexesAvailable,
    },
  }));

  return {
    records,
    cardMetadata,
    warnings,
    debug: {
      ...qaSelection,
      fetchedQaCount: records.length,
      cardCount: cards.length,
      availableCardIndexCount: cardPayloads.length,
    },
  };
}

export function selectRelevantQaIds(cardQaEntries = [], maxCandidates = 8) {
  const safeLimit = positiveInteger(maxCandidates, 8);
  const entries = (cardQaEntries || [])
    .map((entry) => ({
      cardId: String(entry.cardId || ""),
      qaIds: uniqueNumericIds(entry.qaIds),
    }))
    .filter((entry) => entry.cardId && entry.qaIds.length);
  if (!entries.length) return { ids: [], strategy: "no_card_qa_indexes", candidatePoolSize: 0 };
  if (entries.length === 1) {
    const ids = entries[0].qaIds;
    if (ids.length > safeLimit) {
      return {
        ids: [],
        strategy: "single_card_qa_index_too_large",
        candidatePoolSize: ids.length,
        uniqueExactCardIntersection: false,
        uniqueExactQaId: null,
        resolvedCardIds: [entries[0].cardId],
        supportingCardIdsByQaId: {},
      };
    }
    return {
      ids,
      strategy: "bounded_single_card_qa_index",
      candidatePoolSize: ids.length,
      uniqueExactCardIntersection: ids.length === 1,
      uniqueExactQaId: ids.length === 1 ? String(ids[0]) : null,
      resolvedCardIds: [entries[0].cardId],
      supportingCardIdsByQaId: Object.fromEntries(ids.map((id) => [String(id), [entries[0].cardId]])),
    };
  }

  const counts = new Map();
  const supportingCardIds = new Map();
  const firstSeen = new Map();
  let cursor = 0;
  for (const entry of entries) {
    for (const qaId of entry.qaIds) {
      counts.set(qaId, (counts.get(qaId) || 0) + 1);
      if (!supportingCardIds.has(qaId)) supportingCardIds.set(qaId, []);
      supportingCardIds.get(qaId).push(entry.cardId);
      if (!firstSeen.has(qaId)) firstSeen.set(qaId, cursor++);
    }
  }
  const allCardMatches = [...counts.entries()]
    .filter(([, count]) => count === entries.length)
    .sort((left, right) => firstSeen.get(left[0]) - firstSeen.get(right[0]));
  const sharedMatches = (allCardMatches.length ? allCardMatches : [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || firstSeen.get(left[0]) - firstSeen.get(right[0])));
  const selectedMatches = sharedMatches.slice(0, safeLimit);
  return {
    ids: selectedMatches.map(([id]) => id),
    strategy: allCardMatches.length ? "all_resolved_card_intersection" : "highest_shared_card_coverage",
    candidatePoolSize: sharedMatches.length,
    uniqueExactCardIntersection: allCardMatches.length === 1,
    uniqueExactQaId: allCardMatches.length === 1 ? String(allCardMatches[0][0]) : null,
    resolvedCardIds: entries.map((entry) => entry.cardId),
    supportingCardIdsByQaId: Object.fromEntries(selectedMatches.map(([id]) => [
      String(id),
      [...(supportingCardIds.get(id) || [])],
    ])),
  };
}

export function normalizeCardMetadata(card, payload, propertyMetadata) {
  const localized = preferredCardLocale(payload?.cardData);
  const propertyIds = uniqueNumericIds(localized?.properties);
  const propertyLabels = propertyIds
    .map((id) => propertyMetadata?.[Number(id)]?.en || "")
    .filter(Boolean);
  const race = propertyLabels.find((label) => !NON_RACE_PROPERTIES.has(String(label).toLowerCase())) || "";
  const type = String(localized?.cardType || "").trim();
  const attack = optionalNumber(localized?.atk);
  const defense = optionalNumber(localized?.def);
  const level = optionalNumber(localized?.level);
  const rank = optionalNumber(localized?.rank);
  const link = optionalNumber(localized?.linkRating);
  const linkArrows = String(localized?.linkArrows || "").trim();
  return {
    id: String(card.id),
    ...(type ? { type, cardType: type } : {}),
    ...(race ? { race } : {}),
    ...(propertyIds.length ? { monsterPropertyIds: propertyIds } : {}),
    ...(propertyLabels.length ? { monsterProperties: propertyLabels } : {}),
    ...(propertyIds.length ? { propertyIds } : {}),
    ...(propertyLabels.length ? { properties: propertyLabels } : {}),
    ...(attack !== null ? { attack, atk: attack } : {}),
    ...(defense !== null ? { defense, def: defense } : {}),
    ...(level !== null ? { level } : {}),
    ...(rank !== null ? { rank } : {}),
    ...(link !== null ? { link, linkRating: link } : {}),
    ...(linkArrows ? { linkArrows } : {}),
    ...(localized?.attribute ? { attribute: localized.attribute } : {}),
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeQaRecord(qaId, payload, cardNameById, selection) {
  const localized = payload?.qaData?.ja || payload?.qaData?.en || firstObjectValue(payload?.qaData);
  if (!localized) return null;
  const cardIds = uniqueNumericIds(payload?.cards);
  const rawQuestion = localized.title || localized.question;
  const rawDetailedQuestion = localized.question || localized.title;
  const replaceCards = (value) => String(value || "").replace(/<<\s*(\d{1,10})\s*>>/gu, (_match, id) => (
    cardNameById.has(String(id)) ? cardNameById.get(String(id)) : `卡片#${id}`
  ));
  const question = replaceCards(localized.title || localized.question);
  const detailedQuestion = replaceCards(localized.question || localized.title);
  const answer = replaceCards(localized.answer);
  const title = replaceCards(localized.title || localized.question || `Official Q&A ${qaId}`);
  if (!question || !answer) return null;
  const supportingCardIds = selection.supportingCardIdsByQaId?.[String(qaId)] || [];
  return {
    id: `ygoresources-qa-${qaId}`,
    stableId: `ygoresources-qa-${qaId}`,
    sourceId: String(qaId),
    sourceRecordId: String(qaId),
    recordType: "qa",
    status: "confirmed",
    title,
    question,
    rawQuestion,
    rawDetailedQuestion,
    answer,
    conclusion: answer,
    text: [question, detailedQuestion !== question ? detailedQuestion : "", answer].filter(Boolean).join("\n"),
    cards: cardIds.map((id) => cardNameById.get(String(id)) || `卡片#${id}`),
    cardIds,
    questionCardIds: extractQuestionIdentityCardIds(rawQuestion, rawDetailedQuestion),
    source: "Konami Official Card Database via YGOResources",
    sourceUrl: `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?fid=${encodeURIComponent(qaId)}&ope=5&request_locale=ja`,
    mirrorUrl: `${DEFAULT_BASE_URL}/data/qa/${encodeURIComponent(qaId)}`,
    retrievalContext: {
      strategy: selection.strategy,
      candidatePoolSize: selection.candidatePoolSize,
      uniqueExactCardIntersection: selection.uniqueExactCardIntersection
        && String(selection.uniqueExactQaId || "") === String(qaId),
      resolvedCardIds: selection.resolvedCardIds,
      supportingCardIds,
    },
  };
}

function preferredCardLocale(cardData = {}) {
  return cardData.en || cardData.cn || cardData.ja || firstObjectValue(cardData) || {};
}

function firstObjectValue(value) {
  return Object.values(value || {}).find((item) => item && typeof item === "object") || null;
}

function collectQaIds(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item && typeof item === "object") return [item.id || item.qaId || item.qid];
    return [item];
  });
}

async function fetchJsonCached(fetchImpl, url, { timeoutMs, cacheTtlMs }) {
  let cache = cacheByFetchImpl.get(fetchImpl);
  if (!cache) {
    cache = new Map();
    cacheByFetchImpl.set(fetchImpl, cache);
  }
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`http_${response?.status || "unknown"}`);
    const value = await response.json();
    cache.set(url, { value, expiresAt: Date.now() + positiveInteger(cacheTtlMs, DEFAULT_CACHE_TTL_MS) });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function extractInlineCardIds(value) {
  return uniqueNumericIds([...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)].map((match) => match[1]));
}

function extractQuestionIdentityCardIds(rawTitle, rawDetailedQuestion) {
  const scenarioText = String(rawDetailedQuestion || "")
    .replace(/『[\s\S]*?』/gu, " ")
    .replace(/“[\s\S]*?”/gu, " ");
  return uniqueNumericIds([
    ...extractInlineCardIds(rawTitle),
    ...extractInlineCardIds(scenarioText),
  ]);
}

async function fetchJsonResilient(fetchImpl, url, options) {
  try {
    return await fetchJsonCached(fetchImpl, url, options);
  } catch {
    return fetchJsonCached(fetchImpl, url, options);
  }
}

function dedupeCardsById(cards) {
  const seen = new Set();
  return (cards || []).flatMap((card) => {
    const id = String(card.id || card.cardId || "").replace(/\D+/gu, "");
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ ...card, id }];
  });
}

function uniqueNumericIds(values) {
  return [...new Set((values || []).map((value) => String(value || "").replace(/\D+/gu, "")).filter(Boolean))];
}

function displayCardName(card = {}) {
  return String(card.cnName || card.name || card.jaName || card.enName || `卡片#${card.id}`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorCode(error) {
  return String(error?.name || error?.code || error?.message || "unknown").replace(/\s+/gu, "_").slice(0, 80);
}

function emptyResult(reason) {
  return { records: [], cardMetadata: [], warnings: [reason], debug: { strategy: reason, ids: [] } };
}
