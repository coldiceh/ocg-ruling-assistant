import { normalizeCardKey } from "./ragCardExtractor.mjs";

export function createLocalCardDataProvider({ cards = [], records = [], qaRecords = [] } = {}) {
  const normalizedCards = (Array.isArray(cards) ? cards : []).map(normalizeProviderCard).filter((card) => card.name);
  const cardById = new Map(normalizedCards.map((card) => [normalizeId(card.id || card.cardId), card]).filter(([id]) => id));
  const allRecords = [...(Array.isArray(records) ? records : []), ...(Array.isArray(qaRecords) ? qaRecords : [])];

  return {
    searchCardByName(name, limit = 5) {
      return fuzzyFindCards(normalizedCards, name, limit);
    },
    getCardProfile(cardId) {
      return cardById.get(normalizeId(cardId)) || null;
    },
    getCardText(cardId) {
      const card = cardById.get(normalizeId(cardId));
      return card?.effectText || "";
    },
    getCardImage(cardId) {
      return buildCardImageCandidates(cardId);
    },
    getCardFaq(cardId, limit = 8) {
      const wantedId = normalizeId(cardId);
      if (!wantedId) return [];
      return allRecords
        .filter((record) => (record.cardIds || []).some((id) => normalizeId(id) === wantedId))
        .slice(0, limit);
    },
  };
}

export function buildCardImageCandidates(cardId) {
  const rawId = normalizeId(cardId);
  if (!rawId) return [];
  const normalizedId = rawId.padStart(8, "0");
  const compactId = normalizedId.replace(/^0+/u, "") || normalizedId;
  return [
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!thumb`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.webp!half`,
    `https://images.ygoprodeck.com/images/cards/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_cropped/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_small/${compactId}.jpg`,
  ];
}

function fuzzyFindCards(cards, name, limit) {
  const queryKey = normalizeCardKey(name);
  if (!queryKey) return [];
  return cards
    .map((card) => {
      const aliases = [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
      const best = aliases
        .map((alias) => ({ alias, score: scoreAlias(normalizeCardKey(alias), queryKey) }))
        .sort((left, right) => right.score - left.score || String(left.alias).localeCompare(String(right.alias), "zh-Hans-CN"))[0];
      return { ...card, matchedAlias: best?.alias || aliases[0] || card.name, confidence: best?.score || 0 };
    })
    .filter((card) => card.confidence >= 0.42)
    .sort((left, right) => right.confidence - left.confidence || String(left.name).localeCompare(String(right.name)))
    .slice(0, limit);
}

function scoreAlias(aliasKey, queryKey) {
  if (!aliasKey || !queryKey) return 0;
  if (aliasKey === queryKey) return 1;
  if (aliasKey.includes(queryKey)) return queryKey.length >= 4 ? 0.9 : 0.66;
  if (queryKey.includes(aliasKey)) return aliasKey.length >= 5 ? 0.82 : 0.5;
  const grams = tokenOverlap(aliasKey, queryKey);
  const dice = diceCoefficient(aliasKey, queryKey);
  return Math.max(grams, dice);
}

function tokenOverlap(aliasKey, queryKey) {
  const queryTerms = makeBigrams(queryKey);
  if (!queryTerms.length) return 0;
  const aliasTerms = new Set(makeBigrams(aliasKey));
  const hits = queryTerms.filter((term) => aliasTerms.has(term)).length;
  return hits / queryTerms.length;
}

function diceCoefficient(left, right) {
  const leftBigrams = makeBigrams(left);
  const rightBigrams = makeBigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) return 0;
  const counts = new Map();
  for (const gram of leftBigrams) counts.set(gram, (counts.get(gram) || 0) + 1);
  let intersection = 0;
  for (const gram of rightBigrams) {
    const count = counts.get(gram) || 0;
    if (!count) continue;
    counts.set(gram, count - 1);
    intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function makeBigrams(value) {
  const text = String(value || "");
  if (text.length < 2) return text ? [text] : [];
  const grams = [];
  for (let index = 0; index < text.length - 1; index += 1) grams.push(text.slice(index, index + 2));
  return grams;
}

function normalizeProviderCard(card = {}) {
  const id = String(card.id || card.cardId || card.passcode || "");
  return {
    ...card,
    id,
    cardId: String(card.cardId || card.id || card.passcode || ""),
    passcode: String(card.passcode || card.id || card.cardId || ""),
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: [
      card.name,
      card.cnName,
      card.jaName,
      card.enName,
      ...(Array.isArray(card.aliases) ? card.aliases : []),
    ].filter(Boolean),
    imageCandidates: buildCardImageCandidates(id),
  };
}

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}
