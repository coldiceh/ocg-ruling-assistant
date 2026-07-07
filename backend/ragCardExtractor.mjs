const QUOTED_MENTION_PATTERN = /[「『《“"]([^」』》”"]{2,80})[」』》”"]/gu;

export function extractRagCards(userQuery, { cards = [], maxCards = 6 } = {}) {
  const query = String(userQuery || "");
  const normalizedQuery = normalizeCardKey(query);
  const aliasIndex = buildAliasIndex(cards);
  const exactMentions = extractQuotedMentions(query);
  const resolved = [];
  const unresolvedMentions = [];
  const ambiguousMentions = [];
  const seenCards = new Set();

  for (const mention of exactMentions) {
    const candidates = aliasIndex.get(normalizeCardKey(mention)) || [];
    if (candidates.length === 1) {
      addResolved(resolved, seenCards, candidates[0], mention, 0.98);
    } else if (candidates.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(mention, candidates));
    } else if (looksLikeCardMention(mention)) {
      unresolvedMentions.push({ input: mention, reason: "quoted_mention_not_found" });
    }
  }

  const aliasHits = [];
  for (const [aliasKey, candidates] of aliasIndex.entries()) {
    if (aliasKey.length < 2 || !normalizedQuery.includes(aliasKey)) continue;
    const bestAlias = candidates[0]?.matchedAlias || "";
    aliasHits.push({ aliasKey, candidates, score: aliasKey.length + bestAlias.length / 100 });
  }
  aliasHits.sort((left, right) => right.score - left.score);

  for (const hit of aliasHits) {
    if (resolved.length >= maxCards) break;
    if (hit.candidates.length === 1) {
      addResolved(resolved, seenCards, hit.candidates[0], hit.candidates[0].matchedAlias, confidenceForAlias(hit.aliasKey));
      continue;
    }
    const unresolved = hit.candidates.filter((candidate) => !seenCards.has(cardIdentity(candidate.card)));
    if (unresolved.length > 1) ambiguousMentions.push(buildAmbiguousMention(hit.candidates[0].matchedAlias, unresolved));
  }

  return {
    resolvedCards: resolved.slice(0, maxCards),
    unresolvedMentions: dedupeBy(unresolvedMentions, (item) => normalizeCardKey(item.input)),
    ambiguousMentions: dedupeBy(ambiguousMentions, (item) => normalizeCardKey(item.input)),
  };
}

export function buildAliasIndex(cards = []) {
  const index = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    const aliases = cardAliases(card);
    for (const alias of aliases) {
      const key = normalizeCardKey(alias);
      if (!key) continue;
      const item = { card, matchedAlias: alias };
      const existing = index.get(key) || [];
      existing.push(item);
      index.set(key, existing);
    }
  }
  for (const [key, candidates] of index.entries()) {
    index.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  return index;
}

export function normalizeCardKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[：:・·･．.－—–_\-\s]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}]/gu, "")
    .trim();
}

function addResolved(resolved, seenCards, candidate, input, confidence) {
  const card = candidate.card || candidate;
  const key = cardIdentity(card);
  if (!key || seenCards.has(key)) return;
  seenCards.add(key);
  resolved.push({
    input: String(input || candidate.matchedAlias || card.name || ""),
    id: String(card.id || card.cardId || ""),
    cardId: String(card.id || card.cardId || ""),
    name: card.name || card.cnName || card.jaName || card.enName || String(input || ""),
    cnName: card.cnName || "",
    jaName: card.jaName || "",
    enName: card.enName || "",
    cardType: card.cardType || "",
    effectText: card.effectText || "",
    sourceUrl: card.sourceUrl || "",
    aliases: cardAliases(card),
    confidence,
  });
}

function extractQuotedMentions(query) {
  const result = [];
  for (const match of query.matchAll(QUOTED_MENTION_PATTERN)) {
    const mention = String(match[1] || "").trim();
    if (looksLikeCardMention(mention)) result.push(mention);
  }
  return [...new Set(result)];
}

function buildAmbiguousMention(input, candidates) {
  return {
    input,
    candidateCards: candidates.slice(0, 6).map(({ card, matchedAlias }) => ({
      id: String(card.id || card.cardId || ""),
      name: card.name || card.cnName || card.jaName || card.enName || matchedAlias,
      matchedAlias,
    })),
  };
}

function confidenceForAlias(aliasKey) {
  if (aliasKey.length >= 8) return 0.92;
  if (aliasKey.length >= 5) return 0.84;
  return 0.68;
}

function looksLikeCardMention(value) {
  const text = String(value || "").trim();
  return text.length >= 2 && /[A-Za-z\u3040-\u30ff\u3400-\u9fff0-9]/u.test(text);
}

function cardAliases(card = {}) {
  return [
    card.name,
    card.cnName,
    card.jaName,
    card.enName,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
  ].filter(Boolean);
}

function cardIdentity(card = {}) {
  return String(card.id || card.cardId || normalizeCardKey(card.name || card.cnName || card.jaName || card.enName || ""));
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}
