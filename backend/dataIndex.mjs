export function buildCardAliasIndex(cards) {
  const records = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const aliases = [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
    for (const alias of aliases) {
      records.push({
        alias,
        normalizedAlias: normalizeIndexKey(alias),
        cardId: String(card.id || card.cardId || ""),
        cardName: card.name,
        language: detectAliasLanguage(alias),
      });
    }
  }
  return dedupeBy(records, (record) => `${record.normalizedAlias}:${record.cardId}`);
}

export function buildQaIndex(rulings, cards) {
  const aliasToId = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    for (const alias of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean)) {
      aliasToId.set(normalizeIndexKey(alias), String(card.id || card.cardId || ""));
    }
  }
  return (Array.isArray(rulings) ? rulings : [])
    .filter((record) => ["qa", "card-faq", "official-database", "official-response"].includes(record.recordType))
    .map((record) => ({
      id: record.id,
      recordType: record.recordType,
      title: record.title || "",
      cards: record.cards || [],
      cardIds: [...new Set([
        ...(record.cardIds || []),
        ...(record.cards || []).map((name) => aliasToId.get(normalizeIndexKey(name))).filter(Boolean),
      ].map(String))],
      keywords: record.keywords || [],
      text: `${record.question || ""} ${record.title || ""} ${record.conclusion || ""}`.trim(),
    }));
}

export function normalizeIndexKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[－ー]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function detectAliasLanguage(value) {
  const text = String(value || "");
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[A-Za-z]/u.test(text) && !/[\u3400-\u9fff]/u.test(text)) return "en";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  return "unknown";
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) map.set(getKey(item), item);
  return [...map.values()];
}
