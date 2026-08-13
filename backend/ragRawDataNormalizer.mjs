import { projectOfficialQaQuestion } from "./officialQaQuestionProjection.mjs";
import {
  isCanonicalNormalizedRagArray,
  registerCanonicalNormalizedRagData,
} from "./ragNormalizedDataRegistry.mjs";

const emptyDataArray = Object.freeze([]);
const normalizedCardArrayCache = new WeakMap();
const normalizedRecordArrayCache = new WeakMap();
const normalizedDataCache = new WeakMap();

/**
 * Canonical, data-only normalizer shared by the legacy retriever and the
 * raw-evidence pipeline.
 *
 * Its output contract intentionally remains byte-for-byte compatible with the
 * pre-existing legacy normalizer. Keep identity fields, array ordering,
 * duplicate aliases and source URL derivation unchanged: revision manifests
 * and runtime bundles are computed from this representation.
 */
export function normalizeRagSourceData({ cards = [], records = [], qaRecords = [] } = {}) {
  const sourceCards = Array.isArray(cards) ? cards : emptyDataArray;
  const sourceRecords = Array.isArray(records) ? records : emptyDataArray;
  const sourceQaRecords = Array.isArray(qaRecords) ? qaRecords : emptyDataArray;
  const cached = cachedNormalizedData(sourceCards, sourceRecords, sourceQaRecords);
  if (cached) return cached;

  const normalizedCards = normalizeDataArray(
    sourceCards,
    normalizedCardArrayCache,
    normalizeCard,
    (card) => card.name,
    "cards",
  );
  const normalizedRecords = normalizeDataArray(
    sourceRecords,
    normalizedRecordArrayCache,
    normalizeRecord,
    (record) => record.id && record.text,
    "records",
  );
  const normalizedQaRecords = normalizeDataArray(
    sourceQaRecords,
    normalizedRecordArrayCache,
    normalizeRecord,
    (record) => record.id && record.text,
    "qaRecords",
  );
  const canonical = cachedNormalizedData(normalizedCards, normalizedRecords, normalizedQaRecords);
  if (canonical) {
    cacheNormalizedData(sourceCards, sourceRecords, sourceQaRecords, canonical);
    return canonical;
  }

  const data = registerCanonicalNormalizedRagData({
    cards: normalizedCards,
    records: normalizedRecords,
    qaRecords: normalizedQaRecords,
  });
  cacheNormalizedData(sourceCards, sourceRecords, sourceQaRecords, data);
  cacheNormalizedData(normalizedCards, normalizedRecords, normalizedQaRecords, data);
  return data;
}

function normalizeDataArray(source, cache, normalizer, predicate, role) {
  const cached = cache.get(source);
  if (cached) return cached;
  if (isCanonicalNormalizedRagArray(source, role)) {
    cache.set(source, source);
    return source;
  }
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
  const questionProjection = projectOfficialQaQuestion(record);
  const structuredQaText = record.question && answer
    ? [
        record.question,
        record.rawDetailedQuestion && record.rawDetailedQuestion !== record.question
          ? record.rawDetailedQuestion
          : "",
        answer,
      ].filter(Boolean).join("\n").trim()
    : "";
  const text = structuredQaText || String(
    record.text || record.officialText || record.question || answer || record.title || "",
  ).trim();
  const cardIds = [...new Set([
    record.cardId,
    ...(record.cardIds || []),
    ...extractInlineCardIds(text),
  ].map((item) => String(item || "")).filter(Boolean))];
  const questionCardIds = [...new Set(questionProjection.principalCardIds
    .map((item) => String(item || ""))
    .filter(Boolean))];
  const cards = [
    record.cardName,
    ...(record.cards || []),
    ...(record.cardNames || []),
  ].filter(Boolean);
  return {
    ...record,
    id,
    recordType: record.recordType || inferRecordType(record, id),
    title: record.title || record.question || id,
    question: record.question || questionProjection.scenarioText || "",
    answer: record.answer || record.conclusion || questionProjection.answerText || "",
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

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}

function extractInlineCardIds(value) {
  return [...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)]
    .map((match) => match[1]);
}
