const aliasCatalogCache = new WeakMap();
const QUOTED_SURFACE_PATTERNS = Object.freeze([
  /「([^」\r\n]{2,120})」/gu,
  /『([^』\r\n]{2,120})』/gu,
  /《([^》\r\n]{2,120})》/gu,
  /【([^】\r\n]{2,120})】/gu,
  /“([^”\r\n]{2,120})”/gu,
  /"([^"\r\n]{2,120})"/gu,
  /'([^'\r\n]{2,120})'/gu,
]);

/**
 * Resolve card identities without interpreting the duel state or ruling topic.
 *
 * The resolver uses only explicit identifiers and card-name surfaces. It does
 * not inspect the surrounding play description to choose a card.
 */
export function resolveRawGenericCards({
  userQuery = "",
  cards = [],
  maxCards = 6,
  modelCardNameCandidates = [],
} = {}) {
  const query = String(userQuery || "");
  const cardLimit = positiveInteger(maxCards, 6);
  const sourceCards = Array.isArray(cards) ? cards : [];
  const catalog = buildAliasCatalog(sourceCards);
  const userProvidedCardTexts = extractUserProvidedCardTextBlocks(query);
  const identityQuery = maskProvidedCardTextBodies(query, userProvidedCardTexts);
  const normalizedQuery = normalizeCardKey(identityQuery);
  const normalizedModelCandidates = normalizeModelCandidates(modelCardNameCandidates);
  const mentions = [
    ...collectExplicitIdMentions(identityQuery, catalog),
    ...collectQuotedMentions(identityQuery),
    ...collectModelMentions(normalizedModelCandidates, normalizedQuery),
    ...collectLongestAliasMentions(normalizedQuery, catalog),
  ];

  const resolvedByIdentity = new Map();
  const ambiguousMentions = [];
  const unresolvedMentions = [];
  for (const mention of mentions) {
    const resolution = resolveMention(mention, catalog);
    if (resolution.status === "resolved") {
      const identity = cardIdentity(resolution.card);
      if (!resolvedByIdentity.has(identity)) {
        resolvedByIdentity.set(identity, toResolvedCard(resolution.card, mention, resolution));
      }
      continue;
    }
    if (resolution.status === "ambiguous") {
      ambiguousMentions.push({
        input: mention.surface,
        source: mention.source,
        candidateCards: resolution.cards.slice(0, 8).map((card) => ({
          id: String(card.id || card.cardId || ""),
          name: primaryCardName(card),
        })),
      });
      continue;
    }
    if (mention.explicit) {
      unresolvedMentions.push({
        input: mention.surface,
        source: mention.source,
        reason: "card_identity_not_uniquely_verified",
      });
    }
  }

  const allResolved = [...resolvedByIdentity.values()];
  const visibleResolved = allResolved.slice(0, cardLimit);
  const omittedResolvedCards = allResolved.slice(cardLimit).map((card) => ({
    input: card.input || card.name,
    reason: "resolved_card_limit_exceeded",
    source: "card_limit",
    resolvedCardId: String(card.id || card.cardId || ""),
    resolvedCardName: card.name,
  }));

  return {
    resolvedCards: visibleResolved,
    unresolvedMentions: dedupeMentions(unresolvedMentions),
    ambiguousMentions: dedupeMentions(ambiguousMentions),
    omittedResolvedCards,
    userProvidedCardTexts,
    modelCardNameCandidates: normalizedModelCandidates,
    warnings: omittedResolvedCards.length
      ? [`resolved_card_limit_exceeded:${allResolved.length}->${cardLimit}`]
      : [],
    debug: {
      localExactCount: allResolved.length,
      externalLookupCount: 0,
    },
  };
}

function buildAliasCatalog(cards) {
  if (cards && typeof cards === "object") {
    const cached = aliasCatalogCache.get(cards);
    if (cached) return cached;
  }
  const aliases = new Map();
  const ids = new Map();
  for (const card of cards) {
    for (const alias of cardAliases(card)) {
      const key = normalizeCardKey(alias);
      if (!key) continue;
      appendUniqueCard(aliases, key, card);
    }
    for (const value of cardIdentityNumbers(card)) {
      appendUniqueCard(ids, value, card);
    }
  }
  const aliasEntries = [...aliases.entries()]
    .filter(([key]) => isScannableAliasKey(key))
    .map(([key, candidates]) => ({ key, candidates }))
    .sort((left, right) => right.key.length - left.key.length || left.key.localeCompare(right.key));
  const catalog = { aliases, ids, aliasEntries };
  if (cards && typeof cards === "object") aliasCatalogCache.set(cards, catalog);
  return catalog;
}

function collectExplicitIdMentions(query, catalog) {
  const result = [];
  const pattern = /(?:^|[^\p{L}\p{N}])(?:cid|passcode|card\s*id|database\s*id|卡片(?:编号|編號)|卡号|卡號|数据库\s*id|資料庫\s*id|id)\s*[:：#]?\s*(\d{1,10})(?!\d)/giu;
  for (const match of String(query || "").matchAll(pattern)) {
    const surface = String(match[1] || "");
    result.push({
      surface,
      key: normalizeIdentityNumber(surface),
      source: "explicit_card_id",
      matchMode: "id",
      explicit: true,
    });
  }
  const trimmed = String(query || "").trim();
  if (/^\d{1,10}$/u.test(trimmed) && catalog.ids.has(normalizeIdentityNumber(trimmed))) {
    result.push({
      surface: trimmed,
      key: normalizeIdentityNumber(trimmed),
      source: "standalone_card_id",
      matchMode: "id",
      explicit: true,
    });
  }
  return result;
}

function collectQuotedMentions(query) {
  const result = [];
  for (const pattern of QUOTED_SURFACE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(query || "").matchAll(pattern)) {
      const surface = String(match[1] || "").trim();
      const key = normalizeCardKey(surface);
      // Quotation marks do not prove that their contents are a card name.  A
      // quoted surface is useful as a lookup candidate, but an unknown quoted
      // phrase must not turn an otherwise valid question into an unresolved
      // card identity.
      if (key) result.push({ surface, key, source: "quoted_surface", explicit: false });
    }
  }
  return result;
}

function collectModelMentions(candidates, normalizedQuery) {
  const result = [];
  const identityClaimsBySurface = new Map();
  for (const candidate of candidates) {
    const originalKey = normalizeCardKey(candidate.originalText);
    const nameKey = normalizeCardKey(candidate.name);
    const surfaceKey = originalKey || nameKey;
    if (!normalizedQuery.includes(surfaceKey)) continue;
    const claims = identityClaimsBySurface.get(surfaceKey) || new Set();
    if (nameKey) claims.add(nameKey);
    identityClaimsBySurface.set(surfaceKey, claims);
    result.push({
      surface: candidate.originalText || candidate.name,
      key: surfaceKey,
      canonicalKey: nameKey,
      source: "model_surface",
      explicit: true,
      // A model cannot turn a short ordinary word into the exact same-named
      // card. It may only expose that surface to the catalogue's generic
      // unique-proper-fragment check below. Quoted names and numeric IDs use
      // their separate deterministic paths.
      allowExactAlias: isSafeUnquotedAliasKey(surfaceKey),
    });
  }
  return result.map((mention) => ({
    ...mention,
    conflictingModelClaims: (identityClaimsBySurface.get(mention.key)?.size || 0) > 1,
  }));
}

function collectLongestAliasMentions(normalizedQuery, catalog) {
  if (!normalizedQuery) return [];
  const candidates = [];
  for (const entry of catalog.aliasEntries) {
    // Unquoted prose is scanned conservatively. Two-character CJK card names
    // are often ordinary game terms (for example a summoning-method word), so
    // accepting them anywhere in a sentence creates false card identities.
    // Exact quoted/model candidates still support those short names.
    if (!isSafeUnquotedAliasKey(entry.key)) continue;
    let fromIndex = 0;
    while (fromIndex <= normalizedQuery.length - entry.key.length) {
      const start = normalizedQuery.indexOf(entry.key, fromIndex);
      if (start < 0) break;
      candidates.push({
        surface: entry.key,
        key: entry.key,
        source: "exact_alias_scan",
        explicit: false,
        start,
        end: start + entry.key.length,
      });
      fromIndex = start + Math.max(1, entry.key.length);
    }
  }
  candidates.sort((left, right) => (
    (right.end - right.start) - (left.end - left.start)
      || left.start - right.start
      || left.key.localeCompare(right.key)
  ));
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.start - right.start);
}

function resolveMention(mention, catalog) {
  if (mention.conflictingModelClaims) return { status: "ambiguous", cards: modelClaimCards(mention, catalog) };
  if (mention.matchMode === "id") return uniqueResolution(catalog.ids.get(mention.key), "exact_id");

  const surfaceCards = mention.allowExactAlias === false
    ? []
    : catalog.aliases.get(mention.key) || [];
  if (surfaceCards.length) return uniqueResolution(surfaceCards, "exact_alias");

  if (mention.source === "model_surface" && mention.canonicalKey && mention.allowExactAlias !== false) {
    const canonicalCards = catalog.aliases.get(mention.canonicalKey) || [];
    if (canonicalCards.length) return uniqueResolution(canonicalCards, "model_exact_canonical");
  }

  // A short form is accepted only when the current card catalog itself proves
  // that the normalized surface is a fragment of exactly one card identity.
  // This is deliberately not fuzzy matching: one catalogue change can turn a
  // formerly unique fragment into an ambiguity, which then fails closed.
  if (isScannableAliasKey(mention.key)) {
    const fragmentCards = [];
    for (const entry of catalog.aliasEntries) {
      if (mention.allowExactAlias === false && entry.key === mention.key) continue;
      if (!entry.key.includes(mention.key)) continue;
      fragmentCards.push(...entry.candidates);
    }
    const fragmentResolution = uniqueResolution(fragmentCards, "unique_alias_fragment");
    if (fragmentResolution.status !== "unresolved") return fragmentResolution;
  }

  return { status: "unresolved", cards: [] };
}

function uniqueResolution(cards = [], matchKind) {
  const uniqueCards = dedupeCards(cards);
  if (uniqueCards.length === 1) return { status: "resolved", card: uniqueCards[0], matchKind };
  if (uniqueCards.length > 1) return { status: "ambiguous", cards: uniqueCards };
  return { status: "unresolved", cards: [] };
}

function modelClaimCards(mention, catalog) {
  const result = [];
  for (const cards of catalog.aliases.values()) {
    for (const card of cards) {
      if (cardAliases(card).some((alias) => normalizeCardKey(alias) === mention.canonicalKey)) result.push(card);
    }
  }
  return dedupeCards(result);
}

function toResolvedCard(card, mention, resolution) {
  const name = primaryCardName(card);
  return {
    ...card,
    id: String(card.id || card.cardId || ""),
    cardId: String(card.cardId || card.id || ""),
    name,
    cnName: String(card.cnName || card.name || name),
    jaName: String(card.jaName || card.jpName || ""),
    jpName: String(card.jpName || card.jaName || ""),
    enName: String(card.enName || ""),
    aliases: cardAliases(card),
    input: mention.surface,
    matchedQuery: mention.surface,
    identityMatchKind: resolution.matchKind,
    resolutionSource: mention.source,
    confidence: 1,
  };
}

function normalizeModelCandidates(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = String(value?.name || value?.cardName || value || "").trim();
    const originalText = String(value?.originalText || value?.surface || value?.mention || name).trim();
    if (!name && !originalText) continue;
    const key = `${normalizeCardKey(originalText)}:${normalizeCardKey(name)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      name,
      originalText,
      confidence: String(value?.confidence || "medium").toLowerCase(),
      source: "model_card_name_extractor",
    });
  }
  return result.slice(0, 16);
}

function maskProvidedCardTextBodies(query, blocks) {
  let result = String(query || "");
  for (const block of blocks || []) {
    for (const line of String(block?.text || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
      result = result.split(line).join(" ".repeat(line.length));
    }
  }
  return result;
}

function extractUserProvidedCardTextBlocks(query) {
  const lines = String(query || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseProvidedTextHeading(lines[index]);
    if (!heading) continue;
    const body = [];
    if (heading.inlineText) body.push(heading.inlineText);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = String(lines[cursor] || "").trim();
      if (!line) break;
      if (/^(?:问题|問題|问|問|question|q)\s*[：:]/iu.test(line)) break;
      if (parseProvidedTextHeading(line)) break;
      if (!body.length && !looksLikeNumberedTextLine(line)) break;
      body.push(line);
    }
    const text = body.join("\n").trim();
    if (heading.name && text) {
      blocks.push({
        name: heading.name,
        text,
        source: "user_provided_text",
        official: false,
      });
    }
  }
  const deduped = new Map();
  for (const block of blocks) {
    const key = `${normalizeCardKey(block.name)}:${normalizeCardKey(block.text).slice(0, 120)}`;
    if (key && !deduped.has(key)) deduped.set(key, block);
  }
  return [...deduped.values()];
}

function parseProvidedTextHeading(value) {
  const text = String(value || "").trim();
  const bracketed = text.match(/^[【《「『\[（(“"']([^】》」』\]）)”"'\r\n]{2,80})[】》」』\]）)”"']\s*(.*)$/u);
  if (bracketed) {
    return {
      name: String(bracketed[1] || "").trim(),
      inlineText: looksLikeNumberedTextLine(bracketed[2]) ? String(bracketed[2]).trim() : "",
    };
  }
  const colon = text.match(/^([^：:\r\n]{2,80})[：:]\s*(.*)$/u);
  if (!colon || /^(?:问题|問題|问|問|question|q|答案|answer)$/iu.test(String(colon[1]).trim())) return null;
  return {
    name: String(colon[1] || "").trim(),
    inlineText: looksLikeNumberedTextLine(colon[2]) ? String(colon[2]).trim() : "",
  };
}

function looksLikeNumberedTextLine(value) {
  return /^(?:[①②③④⑤⑥⑦⑧⑨⑩]|\(?\d{1,2}\)?\s*[：:.．])/u.test(String(value || "").trim());
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
    .replace(/導/gu, "导")
    .replace(/[の之的]/gu, "")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[：:・·･．.－—–_\-\s]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}]/gu, "")
    .trim();
}

function cardAliases(card = {}) {
  const result = [];
  const seen = new Set();
  for (const value of [
    card.name,
    card.cnName,
    card.zhName,
    card.scName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
  ]) {
    const text = String(value || "").trim();
    const key = normalizeCardKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function cardIdentityNumbers(card = {}) {
  return [...new Set([
    card.id,
    card.cardId,
    card.passcode,
    card.cid,
  ].map(normalizeIdentityNumber).filter(Boolean))];
}

function normalizeIdentityNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,10}$/u.test(text)) return "";
  return text.replace(/^0+(?=\d)/u, "");
}

function isScannableAliasKey(key) {
  if (/^[a-z0-9]+$/u.test(key)) return key.length >= 3;
  return key.length >= 2;
}

function isSafeUnquotedAliasKey(key) {
  return isScannableAliasKey(key) && key.length >= 4;
}

function appendUniqueCard(index, key, card) {
  const values = index.get(key) || [];
  const identity = cardIdentity(card);
  if (!values.some((value) => cardIdentity(value) === identity)) values.push(card);
  index.set(key, values);
}

function dedupeCards(cards = []) {
  const result = new Map();
  for (const card of cards || []) result.set(cardIdentity(card), card);
  return [...result.values()];
}

function dedupeMentions(mentions = []) {
  const result = new Map();
  for (const mention of mentions) {
    const key = normalizeCardKey(mention.input);
    if (!key) continue;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, mention);
      continue;
    }
    const candidateCards = dedupeCardsByIdentity([
      ...(existing.candidateCards || []),
      ...(mention.candidateCards || []),
    ]);
    result.set(key, {
      ...existing,
      ...(candidateCards.length ? { candidateCards } : {}),
    });
  }
  return [...result.values()];
}

function dedupeCardsByIdentity(cards = []) {
  const result = new Map();
  for (const card of cards) {
    const key = String(card?.id || normalizeCardKey(card?.name));
    if (key && !result.has(key)) result.set(key, card);
  }
  return [...result.values()];
}

function cardIdentity(card = {}) {
  return String(card.id || card.cardId || card.passcode || card.cid || normalizeCardKey(primaryCardName(card)));
}

function primaryCardName(card = {}) {
  return String(card.name || card.cnName || card.jaName || card.jpName || card.enName || "");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
