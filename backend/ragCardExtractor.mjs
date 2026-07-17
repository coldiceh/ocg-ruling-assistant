const QUOTED_MENTION_PATTERNS = Object.freeze([
  /「([^」]{2,80})」/gu,
  /『([^』]{2,80})』/gu,
  /《([^》]{2,80})》/gu,
  /【([^】]{2,80})】/gu,
  /\[([^\]\r\n]{2,80})\]/gu,
  /（([^）]{2,80})）/gu,
  /\(([^)\r\n]{2,80})\)/gu,
  /“([^”]{2,80})”/gu,
  /"([^"\r\n]{2,80})"/gu,
  /'([^'\r\n]{2,80})'/gu,
]);

const EFFECT_LINE_PATTERN = /^(?:效果\s*[：:]|[①②③④⑤⑥⑦⑧⑨⑩]\s*[：:]?|\(?[1-9]\d{0,1}\)?\s*[：:.．])/u;
const CARD_TEXT_BOUNDARY_PATTERN = /^(?:问题|问|Q|Ｑ|场景|请问|此时|那么|如果|假设)\s*[：:]/iu;
const NON_CARD_HEADING_NAMES = new Set(["效果", "问题", "问", "q", "场景", "请问", "补充", "答案"]);

export function extractRagCards(userQuery, { cards = [], maxCards = 6, modelCardNameCandidates = [] } = {}) {
  const query = String(userQuery || "");
  const normalizedQuery = normalizeCardKey(query);
  const aliasIndex = buildAliasIndex(cards);
  const userProvidedCardTexts = extractUserProvidedCardTextBlocks(query);
  const modelMentions = normalizeModelCardNameCandidates(modelCardNameCandidates);
  const exactMentionSeeds = [
    ...buildModelMentionSeeds(modelMentions),
    ...extractQuotedMentions(query).map((input) => ({ input, reason: "quoted_mention_not_found", source: "quoted_mention" })),
    ...userProvidedCardTexts.map((item) => ({ input: item.name, reason: "user_provided_text_name_not_found", source: "user_provided_text" })),
  ];
  const unquotedMentionSeeds = extractUnquotedCardMentionCandidates(query)
    .map((input) => ({ input, reason: "unquoted_candidate_not_found", source: "unquoted_heuristic" }));
  const resolved = [];
  const unresolvedMentions = [];
  const ambiguousMentions = [];
  const seenCards = new Set();
  const seenMentionKeys = new Set();

  for (const seed of exactMentionSeeds) {
    const mention = seed.input;
    const mentionKey = normalizeCardKey(mention);
    if (!mentionKey || seenMentionKeys.has(mentionKey)) continue;
    seenMentionKeys.add(mentionKey);
    const candidates = aliasIndex.get(mentionKey) || [];
    if (candidates.length === 1) {
      addResolved(resolved, seenCards, candidates[0], mention, confidenceForMentionSeed(seed, 0.98));
    } else if (candidates.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(mention, candidates));
    } else if (looksLikeCardMention(mention)) {
      unresolvedMentions.push(buildUnresolvedMention(seed));
    }
  }

  for (const seed of unquotedMentionSeeds) {
    const mention = seed.input;
    const mentionKey = normalizeCardKey(mention);
    if (!mentionKey || seenMentionKeys.has(mentionKey)) continue;
    seenMentionKeys.add(mentionKey);
    const candidates = aliasIndex.get(mentionKey) || [];
    if (candidates.length === 1) {
      addResolved(resolved, seenCards, candidates[0], mention, 0.92);
    } else if (candidates.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(mention, candidates));
    } else if (looksLikeCardMention(mention)) {
      unresolvedMentions.push(buildUnresolvedMention(seed));
    }
  }

  const aliasHits = [];
  for (const [aliasKey, candidates] of aliasIndex.entries()) {
    // Two-character aliases are too ambiguous for passive substring scanning
    // (for example, the card "融合" inside the gameplay term "融合怪").
    // Explicit model/quoted/unquoted candidates above can still resolve them.
    if (aliasKey.length < 3 || !normalizedQuery.includes(aliasKey)) continue;
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
    unresolvedMentions: dedupeMentionObjects(unresolvedMentions),
    ambiguousMentions: dedupeBy(ambiguousMentions, (item) => normalizeCardKey(item.input)),
    userProvidedCardTexts,
    modelCardNameCandidates: modelMentions,
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
    .replace(/導/gu, "导")
    .replace(/白き/gu, "白")
    .replace(/埃克利西/gu, "艾克莉西")
    .replace(/艾克利西/gu, "艾克莉西")
    .replace(/埃克莉西/gu, "艾克莉西")
    .replace(/莉西娅/gu, "莉西亚")
    .replace(/[の之的]/gu, "")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[：:・·･．.－—–_\-\s]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}]/gu, "")
    .trim();
}

export function extractUnquotedCardMentionCandidates(query) {
  const text = String(query || "").normalize("NFKC");
  const candidates = [];
  const patterns = [
    /(?:手卡|墓地|除外|场上|場上|自己场上|自己場上|对方场上|對方場上|我方场上|我方場上|对方的|對方的|我方的|自己的|发动了?|發動了?|适用|適用|选择|選擇|要将|要將|将|將|把|破坏|破壞|连锁|連鎖|c\d+\s*发动|c\d+\s*發動)\s*(?:的|上|中|存在的|表侧表示的|表側表示的|手卡的|场上的|場上的)?\s*([\p{L}\p{N}・·･．.\-－—–\s]{2,40}?)(?:的[①②③④⑤⑥⑦⑧⑨⑩]?(?:效果|效应|效應)|[①②③④⑤⑥⑦⑧⑨⑩]?效果|破坏|破壞|被破坏|被破壞|特殊召唤|特殊召喚|能|可以|吗|嗎|，|。|、|；|;|$)/giu,
    /([\p{L}\p{N}・·･．.\-－—–\s]{2,40}?)(?:的[①②③④⑤⑥⑦⑧⑨⑩]?(?:效果|效应|效應)|[①②③④⑤⑥⑦⑧⑨⑩]效果)/giu,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const candidate = cleanUnquotedMention(match[1]);
      if (candidate && hasCardNameSignal(candidate)) candidates.push(candidate);
    }
  }
  return dedupeBy(candidates, normalizeCardKey).slice(0, 12);
}

function cleanUnquotedMention(value) {
  let text = String(value || "")
    .replace(/\s+/gu, " ")
    .replace(/^[,，。；;、：:\s]+|[,，。；;、：:\s]+$/gu, "")
    .trim();
  text = trimGameplaySuffix(text);
  const leadingNoise = /^(?:了|双方|雙方|我方|对方|對方|自己|自分|只有|一只|一張|一张|怪兽|怪獸|的时候|時候|此时|此時|然后|然後|如果|假设|假設|此卡|这张卡|這張卡|这个|這個|那个|那個|手卡|墓地|除外|场上|場上|场上的|場上的|选择|選擇|适用|適用|发动|發動|要将|要將|将|將|把|想要|作为|作為|被破坏|被破壞|替代|代替|降低|提升|攻击力|攻擊力|守备力|守備力|可以|能否|是否|能|吗|嗎|的)+/u;
  const trailingNoise = /(?:的)?(?:效果|效应|效應|破坏|破壞|被破坏|被破壞|特殊召唤|特殊召喚|能|可以|吗|嗎|的时候|時候|此时|此時|选择|選擇|适用|適用|发动|發動|降低.*|提升.*|作为.*|作為.*)$/u;
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text.replace(leadingNoise, "").replace(trailingNoise, "").trim();
  }
  return text.length >= 2 && text.length <= 30 ? text : "";
}

function trimGameplaySuffix(value) {
  const text = String(value || "").trim();
  const suffixPattern = /(?:一[张張只]|[0-9０-９]+[张張只]|里侧|裏側|表侧|表側|盖放|覆蓋|魔陷|魔法陷阱|发动|發動|处理|處理|检索|檢索|破坏|破壞|送墓|除外|回到|返回|回去|起跳)/u;
  const match = text.match(suffixPattern);
  return match && match.index && match.index >= 2 ? text.slice(0, match.index).trim() : text;
}

function hasCardNameSignal(value) {
  const text = String(value || "").trim();
  const key = normalizeCardKey(text);
  if (key.length < 2 || key.length > 28) return false;
  if (/^(?:效果|发动|特殊召唤|攻击力|守备力|怪兽|场上|手卡|墓地|破坏|选择|适用)$/u.test(key)) return false;
  return /[\u3400-\u9fff]/u.test(text)
    && /(龙|龍|神|王|魔|械|童子|蔷|薔|骑士|騎士|姬|兽|獸|花|园|園|多元|宇宙|电子|電子|融合|同步|超量|连接|連接|男爵|女|巫|陷阱|魔法|星|码|碼)/u.test(text);
}

function buildModelMentionSeeds(modelMentions) {
  return modelMentions
    .map((item) => {
      const name = String(item.name || "").trim();
      const originalText = String(item.originalText || "").trim();
      const primary = choosePrimaryModelMention(name, originalText);
      const searchTexts = dedupeBy([name, originalText].filter((value) => value && normalizeCardKey(value) !== normalizeCardKey(primary)), normalizeCardKey);
      return {
        input: primary,
        reason: "model_candidate_not_found",
        source: "model_card_name_extractor",
        confidence: item.confidence || "medium",
        searchTexts,
      };
    })
    .filter((item) => looksLikeCardMention(item.input));
}

function choosePrimaryModelMention(name, originalText) {
  if (!name) return originalText;
  if (!originalText) return name;
  const nameHasCjk = /[\u3040-\u30ff\u3400-\u9fff]/u.test(name);
  const originalHasCjk = /[\u3040-\u30ff\u3400-\u9fff]/u.test(originalText);
  if (originalHasCjk && !nameHasCjk) return originalText;
  return name;
}

function buildUnresolvedMention(seed) {
  return {
    input: String(seed.input || "").trim(),
    reason: seed.reason || "card_name_not_found",
    source: seed.source || "card_name_candidate",
    confidence: seed.confidence || undefined,
    searchTexts: dedupeBy(seed.searchTexts || [], normalizeCardKey),
  };
}

function confidenceForMentionSeed(seed, fallback) {
  if (seed.source !== "model_card_name_extractor") return fallback;
  if (seed.confidence === "high") return 0.95;
  if (seed.confidence === "low") return 0.78;
  return 0.88;
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
    /^（([^）]{2,80})）\s*(.*)$/u,
    /^\(([^)\r\n]{2,80})\)\s*(.*)$/u,
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

function normalizeModelCardNameCandidates(items) {
  return dedupeBy((Array.isArray(items) ? items : [])
    .map((item) => ({
      name: String(item?.name || item?.cardName || item || "").trim(),
      originalText: String(item?.originalText || item?.surface || item?.mention || item?.name || item || "").trim(),
      confidence: String(item?.confidence || "medium").toLowerCase(),
      source: "model_card_name_extractor",
    }))
    .filter((item) => looksLikeCardMention(item.name))
    .slice(0, 12), (item) => normalizeCardKey(item.name));
}

function dedupeMentionObjects(items) {
  const map = new Map();
  for (const item of items) {
    const key = normalizeCardKey(item.input);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...item,
        searchTexts: dedupeBy(item.searchTexts || [], normalizeCardKey),
      });
      continue;
    }
    existing.searchTexts = dedupeBy([...(existing.searchTexts || []), ...(item.searchTexts || [])], normalizeCardKey);
    existing.source = existing.source || item.source;
    existing.confidence = existing.confidence || item.confidence;
  }
  return [...map.values()];
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}
