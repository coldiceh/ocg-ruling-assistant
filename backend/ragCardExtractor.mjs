const QUOTED_MENTION_PATTERNS = Object.freeze([
  /「([^」]{2,80})」/gu,
  /『([^』]{2,80})』/gu,
  /《([^》]{2,80})》/gu,
  /【([^】]{2,80})】/gu,
  /\[([^\]\r\n]{2,80})\]/gu,
  /“([^”]{2,80})”/gu,
  /"([^"\r\n]{2,80})"/gu,
  /'([^'\r\n]{2,80})'/gu,
]);

const EFFECT_LINE_PATTERN = /^(?:效果\s*[：:]|[①②③④⑤⑥⑦⑧⑨⑩]\s*[：:]?|\(?[1-9]\d{0,1}\)?\s*[：:.．])/u;
const CARD_TEXT_BOUNDARY_PATTERN = /^(?:问题|问|Q|Ｑ|场景|请问|此时|那么|如果|假设)\s*[：:]/iu;
const NON_CARD_HEADING_NAMES = new Set(["效果", "问题", "问", "q", "场景", "请问", "补充", "答案"]);

export function extractRagCards(userQuery, { cards = [], maxCards = 6 } = {}) {
  const query = String(userQuery || "");
  const normalizedQuery = normalizeCardKey(query);
  const aliasIndex = buildAliasIndex(cards);
  const userProvidedCardTexts = extractUserProvidedCardTextBlocks(query);
  const exactMentions = [
    ...extractQuotedMentions(query),
    ...userProvidedCardTexts.map((item) => item.name),
  ];
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
    userProvidedCardTexts,
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
    .replace(/導/gu, "导")
    .replace(/白き/gu, "白")
    .replace(/[の之的]/gu, "")
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

export function extractQuotedMentions(query) {
  const result = [];
  const text = String(query || "");
  for (const pattern of QUOTED_MENTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const mention = String(match[1] || "").trim();
      if (looksLikeCardMention(mention)) result.push({ mention, index: match.index ?? text.indexOf(match[0]) });
    }
  }
  result.sort((left, right) => left.index - right.index);
  return dedupeBy(result, (item) => normalizeCardKey(item.mention)).map((item) => item.mention);
}

export function extractUserProvidedCardTextBlocks(query) {
  const lines = String(query || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseCardTextHeading(lines[index], lines[index + 1] || "");
    if (!heading) continue;

    const bodyLines = [];
    if (heading.inlineText) bodyLines.push(cleanEffectTextLine(heading.inlineText));

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = String(lines[cursor] || "").trim();
      if (!line) {
        if (bodyLines.length) break;
        continue;
      }
      if (bodyLines.length && parseCardTextHeading(line, lines[cursor + 1] || "")) break;
      if (isQuestionBoundary(line)) break;
      if (!bodyLines.length && !isEffectLine(line)) break;
      if (bodyLines.length && !isEffectLine(line) && looksLikeQuestionLine(line)) break;
      if (bodyLines.length && !isEffectLine(line) && parseColonHeading(line)) break;
      bodyLines.push(cleanEffectTextLine(line));
    }

    const text = bodyLines.join("\n").trim();
    if (!text || !looksLikeCardMention(heading.name)) continue;
    blocks.push({
      name: heading.name,
      text,
      source: "user_provided_text",
      official: false,
    });
  }

  return dedupeBy(blocks, (item) => `${normalizeCardKey(item.name)}:${normalizeCardKey(item.text).slice(0, 80)}`);
}

function parseCardTextHeading(line, nextLine) {
  const text = String(line || "").trim();
  if (!text) return null;

  const bracketHeading = parseBracketHeading(text);
  if (bracketHeading) {
    const inlineText = normalizeInlineEffectText(bracketHeading.rest);
    if (inlineText || isEffectLine(nextLine)) return { name: bracketHeading.name, inlineText };
  }

  const colonHeading = parseColonHeading(text);
  if (!colonHeading) return null;
  const inlineText = normalizeInlineEffectText(colonHeading.rest);
  if (inlineText || isEffectLine(nextLine)) return { name: colonHeading.name, inlineText };
  return null;
}

function parseBracketHeading(text) {
  const patterns = [
    /^【([^】]{2,80})】\s*(.*)$/u,
    /^《([^》]{2,80})》\s*(.*)$/u,
    /^「([^」]{2,80})」\s*(.*)$/u,
    /^『([^』]{2,80})』\s*(.*)$/u,
    /^\[([^\]\r\n]{2,80})\]\s*(.*)$/u,
    /^“([^”]{2,80})”\s*(.*)$/u,
    /^"([^"\r\n]{2,80})"\s*(.*)$/u,
    /^'([^'\r\n]{2,80})'\s*(.*)$/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const name = String(match[1] || "").trim();
    if (looksLikeCardMention(name)) return { name, rest: String(match[2] || "").trim() };
  }
  return null;
}

function parseColonHeading(text) {
  const match = String(text || "").trim().match(/^(.{2,40}?)[：:]\s*(.*)$/u);
  if (!match) return null;
  const name = String(match[1] || "").trim();
  const normalizedName = normalizeCardKey(name);
  if (!normalizedName || NON_CARD_HEADING_NAMES.has(normalizedName)) return null;
  if (!looksLikeCardMention(name)) return null;
  return { name, rest: String(match[2] || "").trim() };
}

function normalizeInlineEffectText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return isEffectLine(text) ? cleanEffectTextLine(text) : "";
}

function cleanEffectTextLine(line) {
  return String(line || "").trim();
}

function isEffectLine(line) {
  return EFFECT_LINE_PATTERN.test(String(line || "").trim());
}

function isQuestionBoundary(line) {
  return CARD_TEXT_BOUNDARY_PATTERN.test(String(line || "").trim());
}

function looksLikeQuestionLine(line) {
  return /[？?]\s*$/u.test(String(line || "").trim()) || /(能否|是否|可否|吗|如何处理)/u.test(String(line || ""));
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
