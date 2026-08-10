import {
  canonicalizeNumberedCardPrefixes,
  extractNumberedCardIdentities,
  extractNumberedCardMentionCandidates,
  hasNumberedCardIdentityConflict,
} from "./numberedCardIdentity.mjs";
import { splitEffectTextBlocks } from "./cardEffectBlocks.mjs";

const EMPTY_CARD_LIST = Object.freeze([]);
const MIN_SINGLE_EDIT_CARD_KEY_LENGTH = 4;
const MAX_CONTEXTUAL_SHORT_MENTION_LENGTH = 4;
const aliasIndexCache = new WeakMap();
const aliasKeysByLengthCache = new WeakMap();
const cardAliasesCache = new WeakMap();
const supplementalCardIndexesCache = new WeakMap();
const cardSeriesKeysCache = new WeakMap();
const DISTINCTIVE_CJK_FRAGMENT_MIN_LENGTH = 4;
const DISTINCTIVE_FRAGMENT_MAX_LENGTH = 12;

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
  const cardLimit = normalizeMaxCards(maxCards);
  const cardNameScanQuery = maskNonCardQuotedExpressions(query);
  const normalizedQuery = normalizeCardKey(cardNameScanQuery);
  const queryNumberedIdentityKeys = new Set(extractNumberedCardIdentities(query).map(numberedIdentityKey));
  const aliasIndex = buildAliasIndex(cards);
  const userProvidedCardTexts = extractUserProvidedCardTextBlocks(query);
  const nonCardQuotedMentionKeys = new Set(
    collectQuotedMentionEntries(query)
      .filter((item) => item.role !== "card")
      .map((item) => normalizeCardKey(item.mention))
      .filter(Boolean),
  );
  const modelMentions = normalizeModelCardNameCandidates(modelCardNameCandidates)
    .filter((mention) => (
      !nonCardQuotedMentionKeys.has(normalizeCardKey(mention.name))
      && !nonCardQuotedMentionKeys.has(normalizeCardKey(mention.originalText))
      && [mention.originalText, mention.name].some((surface) => {
        const key = normalizeCardKey(surface);
        return key.length >= 2 && normalizedQuery.includes(key);
      })
    ));
  let exactMentionSeeds = [
    ...buildModelMentionSeeds(modelMentions),
    ...extractNumberedCardMentionCandidates(query).map((input) => ({ input, reason: "numbered_card_not_found", source: "numbered_card_identity" })),
    ...extractQuotedMentions(query).map((input) => ({ input, reason: "quoted_mention_not_found", source: "quoted_mention" })),
    ...userProvidedCardTexts.map((item) => ({ input: item.name, reason: "user_provided_text_name_not_found", source: "user_provided_text" })),
  ];
  let unquotedMentionSeeds = extractUnquotedCardMentionCandidates(cardNameScanQuery)
    .map((input) => ({ input, reason: "unquoted_candidate_not_found", source: "unquoted_heuristic" }));
  const distinctiveMentionSeeds = extractContextualDistinctiveMentionCandidates(cardNameScanQuery)
    .filter((input) => findUniqueDistinctiveFragmentCandidate(cards, input))
    .map((input) => ({
      input,
      reason: "contextual_distinctive_fragment_not_found",
      source: "contextual_distinctive_fragment",
    }));
  exactMentionSeeds.push(...distinctiveMentionSeeds);
  const queryAliasEntries = collectQueryAliasEntries(aliasIndex, normalizedQuery, queryNumberedIdentityKeys);
  const exactSpanSelection = buildExactMentionSpanSelection(
    cardNameScanQuery,
    queryAliasEntries,
    exactMentionSeeds,
  );
  exactMentionSeeds = markAndFilterMentionSeeds(exactMentionSeeds, exactSpanSelection);
  unquotedMentionSeeds = markAndFilterMentionSeeds(unquotedMentionSeeds, exactSpanSelection);
  const resolved = [];
  const unresolvedMentions = [];
  const ambiguousMentions = [];
  const seenCards = new Set();
  const seenMentionKeys = new Set();

  for (const identity of extractNumberedCardIdentities(query)) {
    const input = `${identity.family === "cno" ? "CNo." : "No."}${identity.number}`;
    const inputKey = normalizeCardKey(input);
    const candidates = findCardsByNumberedIdentity(cards, identity);
    const detailedSeeds = exactMentionSeeds.filter((seed) => (
      seed.source !== "model_card_name_extractor"
      && seed.source !== "contextual_distinctive_fragment"
      && extractNumberedCardIdentities(seed.input).some((candidate) => sameNumberedIdentity(candidate, identity))
      && numberedMentionRemainder(seed.input, identity)
    ));
    const bareIdentityPresent = queryHasBareNumberedOccurrence(query, detailedSeeds, identity);
    const compatible = candidates.filter((candidate) => (
      !detailedSeeds.length
      || detailedSeeds.some((seed) => numberedMentionCompatibleWithCard(seed.input, identity, candidate.card))
    ));

    if (compatible.length === 1) {
      const detailedSeed = detailedSeeds.find((seed) => numberedMentionCompatibleWithCard(seed.input, identity, compatible[0].card));
      const resolvedInput = detailedSeed?.input || input;
      addResolved(resolved, seenCards, compatible[0], resolvedInput, detailedSeed ? 0.97 : 0.99);
      seenMentionKeys.add(inputKey);
      if (detailedSeed) seenMentionKeys.add(normalizeCardKey(detailedSeed.input));
    } else if (bareIdentityPresent && candidates.length === 1) {
      addResolved(resolved, seenCards, candidates[0], input, 0.99);
      seenMentionKeys.add(inputKey);
    } else if (
      detailedSeeds.length
      && candidates.length === 1
      && detailedSeeds.some((seed) => plausibleNumberedLocalizedVariant(seed.input, identity, candidates[0].card))
    ) {
      const detailedSeed = detailedSeeds.find((seed) => plausibleNumberedLocalizedVariant(seed.input, identity, candidates[0].card));
      const resolvedCard = addResolved(
        resolved,
        seenCards,
        candidates[0],
        detailedSeed.input,
        0.9,
        "numbered_identity_unique_localized_variant",
      );
      if (resolvedCard) {
        resolvedCard.numberedIdentityNameMismatch = true;
        resolvedCard.numberedIdentityInput = detailedSeed.input;
        resolvedCard.numberedIdentityCanonicalName = resolvedCard.name;
      }
      seenMentionKeys.add(inputKey);
      seenMentionKeys.add(normalizeCardKey(detailedSeed.input));
    } else if (bareIdentityPresent && candidates.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(input, candidates));
      seenMentionKeys.add(inputKey);
    } else if (detailedSeeds.length && compatible.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(detailedSeeds[0].input, compatible));
      seenMentionKeys.add(normalizeCardKey(detailedSeeds[0].input));
    } else if (bareIdentityPresent && candidates.length === 0) {
      unresolvedMentions.push({
        input,
        reason: "numbered_card_not_found",
        source: "numbered_card_identity",
      });
      seenMentionKeys.add(inputKey);
    }
  }

  for (const seed of exactMentionSeeds) {
    const mention = seed.input;
    const mentionKey = normalizeCardKey(mention);
    if (!mentionKey || seenMentionKeys.has(mentionKey)) continue;
    seenMentionKeys.add(mentionKey);
    const candidates = aliasIndex.get(mentionKey) || [];
    const singleEditCandidate = candidates.length || seed.deferToNestedKnownSpan
      ? null
      : findUniqueSingleEditCandidate(aliasIndex, mention) || findUniqueNearEditCandidate(aliasIndex, mention);
    const distinctiveFragmentCandidate = candidates.length || singleEditCandidate || seed.deferToNestedKnownSpan
      ? null
      : findUniqueDistinctiveFragmentCandidate(cards, mention);
    if (candidates.length === 1) {
      addResolved(resolved, seenCards, candidates[0], mention, confidenceForMentionSeed(seed, 0.98));
    } else if (candidates.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(mention, candidates));
    } else if (singleEditCandidate) {
      addResolved(
        resolved,
        seenCards,
        singleEditCandidate,
        mention,
        confidenceForNearEditMention(seed, singleEditCandidate.nearEditDistance),
      );
    } else if (distinctiveFragmentCandidate) {
      addResolved(resolved, seenCards, distinctiveFragmentCandidate, mention, 0.91);
    } else if (looksLikeCardMention(mention) && !numberedMentionAlreadyResolved(mention, resolved)) {
      if (seed.source !== "contextual_distinctive_fragment") unresolvedMentions.push(buildUnresolvedMention(seed));
    }
  }

  for (const seed of unquotedMentionSeeds) {
    const mention = seed.input;
    const mentionKey = normalizeCardKey(mention);
    if (!mentionKey || seenMentionKeys.has(mentionKey)) continue;
    seenMentionKeys.add(mentionKey);
    const candidates = aliasIndex.get(mentionKey) || [];
    const singleEditCandidate = candidates.length || seed.deferToNestedKnownSpan
      ? null
      : findUniqueSingleEditCandidate(aliasIndex, mention) || findUniqueNearEditCandidate(aliasIndex, mention);
    if (candidates.length === 1) {
      addResolved(resolved, seenCards, candidates[0], mention, 0.92);
    } else if (candidates.length > 1) {
      ambiguousMentions.push(buildAmbiguousMention(mention, candidates));
    } else if (singleEditCandidate) {
      addResolved(
        resolved,
        seenCards,
        singleEditCandidate,
        mention,
        confidenceForNearEditMention(seed, singleEditCandidate.nearEditDistance),
      );
    } else if (looksLikeCardMention(mention) && !numberedMentionAlreadyResolved(mention, resolved)) {
      unresolvedMentions.push(buildUnresolvedMention(seed));
    }
  }

  const aliasHits = [];
  for (const [aliasKey, candidates] of queryAliasEntries) {
    // Two-character aliases are too ambiguous for passive substring scanning
    // (for example, the card "融合" inside the gameplay term "融合怪").
    // Explicit model/quoted/unquoted candidates above can still resolve them.
    if (aliasKey.length < 3) continue;
    if (exactSpanSelection.hasOccurrences(aliasKey) && !exactSpanSelection.hasSelectedOccurrence(aliasKey)) continue;
    const bestAlias = candidates[0]?.matchedAlias || "";
    if (!bestAlias || !buildMentionContexts(cardNameScanQuery, bestAlias, resolved).length) continue;
    aliasHits.push({ aliasKey, candidates, score: aliasKey.length + bestAlias.length / 100 });
  }
  aliasHits.sort((left, right) => right.score - left.score);

  for (const hit of aliasHits) {
    const eligibleCandidates = hit.candidates.filter((candidate) => (
      numberedAliasCompatibleWithExplicitMentions(query, candidate, exactMentionSeeds)
    ));
    if (eligibleCandidates.length === 1) {
      const matchedAlias = eligibleCandidates[0].matchedAlias;
      // `aliasHits` is collected before any of those hits are resolved.  A
      // shorter exact card name can therefore be present only as a substring
      // of a longer card name in the same source span (for example, X inside
      // XG).  Re-check the occurrence after longer hits have been added.  A
      // genuinely independent occurrence of the short name still has its own
      // context and remains eligible.
      if (!buildMentionContexts(cardNameScanQuery, matchedAlias, resolved).length) continue;
      addResolved(resolved, seenCards, eligibleCandidates[0], matchedAlias, confidenceForAlias(hit.aliasKey));
      continue;
    }
    const unresolved = eligibleCandidates.filter((candidate) => !seenCards.has(cardIdentity(candidate.card)));
    if (unresolved.length > 1) ambiguousMentions.push(buildAmbiguousMention(hit.candidates[0].matchedAlias, unresolved));
  }

  applyContextualExtraDeckMaterialResolution({
    query,
    cards: Array.isArray(cards) ? cards : EMPTY_CARD_LIST,
    resolved,
    seenCards,
    unresolvedMentions,
  });

  applyContextualShortMentionResolution({
    query,
    cards: Array.isArray(cards) ? cards : EMPTY_CARD_LIST,
    resolved,
    seenCards,
    unresolvedMentions,
    ambiguousMentions,
  });

  applyContextualNearEditResolution({
    aliasIndex,
    resolved,
    seenCards,
    unresolvedMentions,
    ambiguousMentions,
  });

  applyReferencedCardTextResolution({
    query,
    aliasIndex,
    resolved,
    seenCards,
    maxCards: cardLimit,
  });

  const visibleResolved = resolved.slice(0, cardLimit);
  const omittedResolved = resolved.slice(cardLimit);
  const cardLimitMentions = omittedResolved.map((card) => ({
    input: card.input || card.name,
    reason: "resolved_card_limit_exceeded",
    source: "card_limit",
    resolvedCardId: card.id,
    resolvedCardName: card.name,
  }));

  return {
    resolvedCards: visibleResolved,
    unresolvedMentions: dedupeMentionObjects(unresolvedMentions),
    ambiguousMentions: dedupeBy(ambiguousMentions, (item) => normalizeCardKey(item.input)),
    omittedResolvedCards: cardLimitMentions,
    userProvidedCardTexts,
    modelCardNameCandidates: modelMentions,
  };
}

export function buildAliasIndex(cards = []) {
  const sourceCards = Array.isArray(cards) ? cards : EMPTY_CARD_LIST;
  const cached = aliasIndexCache.get(sourceCards);
  if (cached) return cached;

  const index = new Map();
  const numberedIdentityIndex = new Map();
  const shortMentionIndex = new Map();
  const distinctiveFragmentIndex = new Map();
  for (const card of sourceCards) {
    const aliases = cardAliases(card);
    const seenNumberedKeys = new Set();
    const seenShortKeys = new Set();
    for (const alias of aliases) {
      const key = normalizeCardKey(alias);
      if (!key) continue;
      const item = { card, matchedAlias: alias };
      const existing = index.get(key) || [];
      existing.push(item);
      index.set(key, existing);

      for (const identity of extractNumberedCardIdentities(alias)) {
        const identityKey = numberedIdentityKey(identity);
        if (seenNumberedKeys.has(identityKey)) continue;
        seenNumberedKeys.add(identityKey);
        const identityCandidates = numberedIdentityIndex.get(identityKey) || [];
        identityCandidates.push(item);
        numberedIdentityIndex.set(identityKey, identityCandidates);
      }

      for (const shortKey of shortMentionKeysForAlias(alias)) {
        if (seenShortKeys.has(shortKey)) continue;
        seenShortKeys.add(shortKey);
        const shortCandidates = shortMentionIndex.get(shortKey) || [];
        shortCandidates.push(item);
        shortMentionIndex.set(shortKey, shortCandidates);
      }

      for (const fragmentKey of distinctiveFragments(alias)) {
        const fragmentCandidates = distinctiveFragmentIndex.get(fragmentKey) || [];
        fragmentCandidates.push(item);
        distinctiveFragmentIndex.set(fragmentKey, fragmentCandidates);
      }
    }
  }
  for (const [key, candidates] of index.entries()) {
    index.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  for (const [key, candidates] of numberedIdentityIndex.entries()) {
    numberedIdentityIndex.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  for (const [key, candidates] of shortMentionIndex.entries()) {
    shortMentionIndex.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  for (const [key, candidates] of distinctiveFragmentIndex.entries()) {
    distinctiveFragmentIndex.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  const keysByLength = new Map();
  for (const key of index.keys()) {
    const keys = keysByLength.get(key.length) || [];
    keys.push(key);
    keysByLength.set(key.length, keys);
  }
  aliasIndexCache.set(sourceCards, index);
  aliasKeysByLengthCache.set(index, keysByLength);
  supplementalCardIndexesCache.set(sourceCards, { numberedIdentityIndex, shortMentionIndex, distinctiveFragmentIndex });
  return index;
}

function collectQueryAliasEntries(aliasIndex, normalizedQuery, queryNumberedIdentityKeys) {
  const entries = [];
  for (const [aliasKey, candidates] of aliasIndex.entries()) {
    if (!aliasKey || !normalizedQuery.includes(aliasKey)) continue;
    const aliasNumberedIdentities = extractNumberedCardIdentities(aliasKey);
    if (aliasNumberedIdentities.length && !aliasNumberedIdentities.some((identity) => (
      queryNumberedIdentityKeys.has(numberedIdentityKey(identity))
    ))) continue;
    entries.push([aliasKey, candidates]);
  }
  return entries;
}

function buildExactMentionSpanSelection(query, queryAliasEntries, mentionSeeds) {
  const text = String(query || "").normalize("NFKC");
  const lowerText = text.toLowerCase();
  const stableAliasKeys = new Set((queryAliasEntries || [])
    .filter(([, candidates]) => (candidates || []).some((candidate) => cardIdentity(candidate.card)))
    .map(([aliasKey]) => aliasKey));
  const surfacesByKey = new Map();
  const addSurface = (value, stable) => {
    const surface = String(value || "").trim();
    const surfaceKey = exactSurfaceKey(surface);
    if (!surfaceKey) return;
    const existing = surfacesByKey.get(surfaceKey);
    if (existing) existing.stable ||= stable;
    else surfacesByKey.set(surfaceKey, { surface, stable });
  };
  for (const [, candidates] of queryAliasEntries || []) {
    for (const candidate of candidates || []) addSurface(candidate.matchedAlias, true);
  }
  for (const seed of mentionSeeds || []) {
    addSurface(seed.input, stableAliasKeys.has(normalizeCardKey(seed.input)));
  }
  const spansByRange = new Map();

  for (const { surface, stable } of surfacesByKey.values()) {
    const needle = String(surface || "").normalize("NFKC");
    const lowerNeedle = needle.toLowerCase();
    const mentionKey = normalizeCardKey(surface);
    if (!lowerNeedle || !mentionKey) continue;

    let cursor = 0;
    while (cursor <= lowerText.length - lowerNeedle.length) {
      const start = lowerText.indexOf(lowerNeedle, cursor);
      if (start < 0) break;
      const end = start + lowerNeedle.length;
      cursor = start + 1;
      const rangeKey = `${start}:${end}`;
      const span = spansByRange.get(rangeKey) || {
        start,
        end,
        mentionKeys: new Set(),
        stableMentionKeys: new Set(),
        surfaces: new Set(),
      };
      span.mentionKeys.add(mentionKey);
      if (stable) span.stableMentionKeys.add(mentionKey);
      span.surfaces.add(needle);
      spansByRange.set(rangeKey, span);
    }
  }

  const ranked = [...spansByRange.values()]
    .filter((span) => span.stableMentionKeys.size > 0)
    .sort((left, right) => (
      (right.end - right.start) - (left.end - left.start)
      || left.start - right.start
      || left.end - right.end
    ));
  const selected = [];
  for (const span of ranked) {
    if (selected.some((accepted) => spansOverlap(span, accepted))) continue;
    selected.push(span);
  }
  selected.sort((left, right) => left.start - right.start || right.end - left.end);

  const allByMentionKey = indexMentionSpansByKey(spansByRange.values());
  const selectedByMentionKey = indexMentionSpansByKey(selected);
  return {
    occurrences(value) {
      return allByMentionKey.get(normalizeCardKey(value)) || [];
    },
    selectedOccurrences(value) {
      return selectedByMentionKey.get(normalizeCardKey(value)) || [];
    },
    hasOccurrences(value) {
      return (allByMentionKey.get(normalizeCardKey(value)) || []).length > 0;
    },
    hasSelectedOccurrence(value) {
      return (selectedByMentionKey.get(normalizeCardKey(value)) || []).length > 0;
    },
    isStableMention(value) {
      return stableAliasKeys.has(normalizeCardKey(value));
    },
    hasNestedSelectedKnownSpan(value) {
      const occurrences = allByMentionKey.get(normalizeCardKey(value)) || [];
      return occurrences.some((occurrence) => selected.some((accepted) => (
        accepted.start >= occurrence.start
        && accepted.end <= occurrence.end
        && (accepted.start !== occurrence.start || accepted.end !== occurrence.end)
      )));
    },
    shouldDeferToNestedKnownSpan(value) {
      const occurrences = allByMentionKey.get(normalizeCardKey(value)) || [];
      return occurrences.some((occurrence) => selected.some((accepted) => {
        if (
          accepted.start < occurrence.start
          || accepted.end > occurrence.end
          || (accepted.start === occurrence.start && accepted.end === occurrence.end)
        ) return false;
        const before = text.slice(occurrence.start, accepted.start).trim();
        const after = text.slice(accepted.end, occurrence.end).trim();
        return !before && /^(?:(?:的|の)\s*)?(?:[①②③④⑤⑥⑦⑧⑨⑩1-9]\s*)?(?:效果|效应|效應|効果|effect)$/iu.test(after);
      }));
    },
  };
}

function markAndFilterMentionSeeds(seeds, exactSpanSelection) {
  return (seeds || []).map((seed) => {
    const queryExactSpans = exactSpanSelection.occurrences(seed.input);
    const selectedQueryExactSpans = exactSpanSelection.selectedOccurrences(seed.input);
    return {
      ...seed,
      queryExactSpans: queryExactSpans.map(toPublicMentionSpan),
      selectedQueryExactSpans: selectedQueryExactSpans.map(toPublicMentionSpan),
      exactSpanStableCandidate: exactSpanSelection.isStableMention(seed.input),
      hasNestedSelectedKnownSpan: exactSpanSelection.hasNestedSelectedKnownSpan(seed.input),
      deferToNestedKnownSpan: exactSpanSelection.shouldDeferToNestedKnownSpan(seed.input),
    };
  }).filter((seed) => (
    !seed.exactSpanStableCandidate
    || !seed.queryExactSpans.length
    || seed.selectedQueryExactSpans.length > 0
  ));
}

function exactSurfaceKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

function spansOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function indexMentionSpansByKey(spans) {
  const result = new Map();
  for (const span of spans || []) {
    for (const mentionKey of span.mentionKeys || []) {
      const items = result.get(mentionKey) || [];
      items.push(span);
      result.set(mentionKey, items);
    }
  }
  return result;
}

function toPublicMentionSpan(span) {
  return { start: span.start, end: span.end };
}

function applyContextualExtraDeckMaterialResolution({ query, cards, resolved, seenCards, unresolvedMentions }) {
  const resolvedMentionKeys = new Set();
  for (const mention of unresolvedMentions) {
    const parsed = splitLocalizedSeriesAlias(mention.input);
    const prefixKey = normalizeCardKey(parsed?.prefix);
    if (!parsed || prefixKey.length < 3) continue;
    const mentionIndex = String(query || "").indexOf(mention.input);
    const before = mentionIndex >= 0 ? String(query || "").slice(Math.max(0, mentionIndex - 36), mentionIndex) : "";
    if (!/(?:额外卡组|額外卡組|额外牌组|額外牌組|EX(?:tra)? Deck)/iu.test(before)) continue;
    const candidates = [];
    for (const card of cards) {
      const matchingAlias = uniqueCardAliases(card).find((alias) => {
        const candidate = splitLocalizedSeriesAlias(alias);
        return candidate && normalizeCardKey(candidate.prefix) === prefixKey;
      });
      if (matchingAlias && materialFormulaReferencesResolvedCard(card.effectText, resolved, card)) {
        candidates.push({ card, matchedAlias: matchingAlias });
      }
    }
    const uniqueCandidates = dedupeBy(candidates, (candidate) => cardIdentity(candidate.card));
    if (uniqueCandidates.length !== 1) continue;
    addResolved(resolved, seenCards, uniqueCandidates[0], mention.input, 0.88);
    resolvedMentionKeys.add(normalizeCardKey(mention.input));
  }
  if (!resolvedMentionKeys.size) return;
  const retained = unresolvedMentions.filter((item) => !resolvedMentionKeys.has(normalizeCardKey(item.input)));
  unresolvedMentions.splice(0, unresolvedMentions.length, ...retained);
}

function materialFormulaReferencesResolvedCard(effectText, resolvedCards, candidateCard) {
  const firstLine = String(effectText || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
  if (!firstLine.includes("＋") && !/\s\+\s/u.test(firstLine)) return false;
  const formulaKey = normalizeCardKey(firstLine);
  return (resolvedCards || []).some((resolvedCard) => (
    cardIdentity(resolvedCard) !== cardIdentity(candidateCard)
    && uniqueCardAliases(resolvedCard).some((alias) => {
      const aliasKey = normalizeCardKey(alias);
      return aliasKey.length >= 4 && formulaKey.includes(aliasKey);
    })
  ));
}

export function normalizeCardKey(value) {
  return canonicalizeNumberedCardPrefixes(value)
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

export function extractUnquotedCardMentionCandidates(query) {
  const text = String(query || "").normalize("NFKC");
  const candidates = [];
  const numberedEffectCarrierPattern = /(?:^|[，,。；;、！？!?\s])([\p{L}\p{N}・·･．.\-－—–\s]{2,30}?)(?=\s*(?:的\s*)?[①②③④⑤⑥⑦⑧⑨⑩1-9]\s*(?:效果|效应|效應))/giu;
  for (const match of text.matchAll(numberedEffectCarrierPattern)) {
    const candidate = cleanUnquotedMention(match[1]);
    if (candidate && hasContextualEffectCarrierSignal(candidate)) candidates.push(candidate);
  }

  const activeEffectCarrierPattern = /(?:^|[，,。；;、\s])(?:我方|对方|對方|自己|自分)\s*(?:场上|場上)?\s*(?:的)?\s*([\p{L}\p{N}・·･．.\-－—–\s]{2,30}?)(?:的\s*(?:[①②③④⑤⑥⑦⑧⑨⑩1-9]\s*)?(?:效果|效应|效應))?\s*(?:正在|正|仍然|仍|依然|还在|還在)?\s*(?:适用|適用|生效)(?:中|着|著)?(?=\s*(?:[，,。；;、]|而|并|並|但|时|時|的情况下|的情況下|$))/giu;
  for (const match of text.matchAll(activeEffectCarrierPattern)) {
    const candidate = cleanUnquotedMention(match[1]);
    if (candidate && hasContextualEffectCarrierSignal(candidate)) candidates.push(candidate);
  }

  const colloquialActivationSubjectPattern = /(?:^|[，,。；;、！？!?\s])([\p{L}\p{N}・·･．.\-－—–\s]{2,30}?)(?=\s*(?:还|還)?\s*(?:能|可以|可否|能否|是否)?\s*(?:发出来|發出來|发动|發動|起跳)(?:\s*(?:吗|嗎|么|嘛))?(?:[，,。；;！？!?]|$))/giu;
  for (const match of text.matchAll(colloquialActivationSubjectPattern)) {
    const candidate = cleanUnquotedMention(match[1]);
    if (candidate && hasColloquialActivationSubjectSignal(candidate)) candidates.push(candidate);
  }

  const patterns = [
    /(?:^|[，,。；;、\s])(?:c|cl|chain)\s*\d+\s*(?:再|先)?\s*(?:从|從|由)?\s*(?:我方|对方|對方|自己|自分)?\s*(?:手卡|手牌|墓地|除外区|除外區|除外|场上|場上|怪兽区|怪獸區|魔法陷阱区|魔法陷阱區)\s*(?:的)?\s*(?:发动|發動|使用|适用|適用)?\s*([\p{L}\p{N}・·･．.\-－—–\s]{2,30}?)(?=\s*(?:的\s*)?(?:(?:[①②③④⑤⑥⑦⑧⑨⑩]|[1-9])?\s*效果\s*)?(?:进行|進行|发动|發動|使用|适用|適用|替换|替換|交换|交換|特殊召唤|特殊召喚|回到|返回|放回|破坏|破壞|送去|送入|除外|作为|作為|处理|處理))/giu,
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

function extractContextualDistinctiveMentionCandidates(query) {
  const text = String(query || "").normalize("NFKC");
  const candidates = [];

  for (const match of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gu)) {
    const token = String(match[1] || "");
    if (!/[A-Za-z]/u.test(token) || !/\d/u.test(token)) continue;
    if (/^(?:(?:c|cl|chain|no|cno|sno)\d+)$/iu.test(token)) continue;
    candidates.push(token);
  }

  const actionPatterns = [
    /(?:发动|發動|使用|适用|適用)\s*([\p{L}\p{N}・·･．.\-－—–\s]{2,30}?)(?=\s*(?:(?:的)?[①②③④⑤⑥⑦⑧⑨⑩]?(?:效果|效应|效應))?\s*(?:吗|嗎|能否|是否|可否|，|。|；|;|$))/giu,
    /(?:场上|場上|怪兽区域|怪獸區域)\s*(?:有|存在)?\s*(?:一[个個张張只隻])?\s*([\p{L}\p{N}・·･．.\-－—–\s]{2,30}?)(?=\s*(?:，|。|导致|導致|使得|令|的效果|效果))/giu,
  ];
  for (const pattern of actionPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = cleanUnquotedMention(match[1]);
      if (candidate) candidates.push(candidate);
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
  const leadingNoise = /^(?:了|双方|雙方|我方|对方|對方|自己|自分|它的|他的|她的|其|那只|那張|那张|这只|這隻|这張|这张|只有|一只|一張|一张|怪兽|怪獸|的时候|時候|此时|此時|那之后|那之後|之后|之後|随后|隨後|接着|接著|接下来|接下來|其后|其後|此后|此後|然后|然後|如果|假设|假設|此卡|这张卡|這張卡|这个|這個|那个|那個|手卡|墓地|除外|场上|場上|场上的|場上的|选择|選擇|适用|適用|发动|發動|要将|要將|将|將|把|想要|作为|作為|被破坏|被破壞|替代|代替|降低|提升|攻击力|攻擊力|守备力|守備力|可以|能否|是否|能|吗|嗎|的)+/u;
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
  if (looksLikeGenericCardDescription(text)) return false;
  return /[\u3400-\u9fff]/u.test(text)
     && /(龙|龍|神|王|魔|械|童子|蔷|薔|骑士|騎士|姬|兽|獸|花|园|園|多元|宇宙|电子|電子|融合|同步|超量|连接|連接|男爵|女|巫|陷阱|魔法|星|码|碼)/u.test(text);
}

function looksLikeGenericCardDescription(value) {
  const text = String(value || "").normalize("NFKC").replace(/\s+/gu, "");
  const compact = text.replace(/[・·･]/gu, "");
  if (/^(?:(?:发动|發動|处理|處理|效果处理|效果處理|连锁|連鎖)?(?:前|后|後|时|時|中))?(?:(?:自己|我方|对方|對方|双方|雙方)的?)?(?:(?:场上|場上|墓地|手卡|手牌|卡组|卡組|牌组|牌組|除外区|除外區))?(?:没有|沒有|不存在|不再存在)(?:其他|其它|别的|別的|除此以外)?(?:表侧表示|表側表示|里侧表示|裏側表示)?(?:的)?(?:(?:通常|速攻|永续|永續|装备|裝備|场地|場地|反击|反擊|仪式|儀式|融合|同步|同调|同調|超量|连接|連接|灵摆|靈擺|效果)?(?:怪兽|怪獸|魔法|陷阱)(?:卡|牌)?|魔法陷阱卡?|魔陷|卡片)(?:存在)?$/u.test(compact)) {
    return true;
  }
  return /^(?:(?:已(?:经)?|曾(?:经)?|又|还|還|再)?(?:发动|發動|使用)?过|[0-9一二三四五六七八九十百]+(?:张|張|只|隻|枚|体|體))?(?:(?:通常|速攻|永续|永續|装备|裝備|场地|場地|反击|反擊|仪式|儀式|融合|同步|同调|同調|超量|连接|連接|灵摆|靈擺|效果|通常)?(?:怪兽|怪獸|魔法|陷阱)(?:卡|牌)?|魔法陷阱卡?|魔陷|卡片)(?:(?:从|從)?(?:手卡|手牌|场上|場上|卡组|卡組|牌组|牌組)?(?:特殊召唤|特殊召喚|送去墓地|送入墓地|加入手卡|加入手牌|破坏|破壞|除外|返回|放回))?$/u.test(text);
}

function hasContextualEffectCarrierSignal(value) {
  const text = String(value || "").trim();
  const key = normalizeCardKey(text);
  if (key.length < 2 || key.length > 28 || !/[\p{L}\p{N}]/u.test(text)) return false;
  if (/^(?:效果|效应|效應|卡片效果|怪兽效果|怪獸效果|魔法效果|陷阱效果|永续效果|永續效果|规则效果|規則效果|这个效果|這個效果|该效果|該效果|此效果|卡片|怪兽|怪獸|魔法|陷阱|永续|永續|规则|規則|限制|状态|狀態|攻击力|攻擊力|守备力|守備力)$/u.test(text)) return false;
  if (/^(?:(?:我方|对方|對方|自己|自分|双方|雙方|场上|場上|墓地|手卡|手牌|怪兽区|怪獸區|魔法陷阱区|魔法陷阱區|卡|怪兽|怪獸|效果|适用|適用|生效)的?)+$/u.test(text)) return false;
  if (/(?:召唤|召喚|特殊召唤|特殊召喚|攻击|攻擊|破坏|破壞|除外|送去墓地|加入手牌|抽卡|抽牌)(?:的)?(?:卡|怪兽|怪獸|效果)?$/u.test(text)) return false;
  if (/(?:攻击力|攻擊力|守备力|守備力|等级|等級|阶级|階級|数值|數值).*(?:上升|下降|改变|改變|效果)?$/u.test(text)) return false;
  return true;
}

function hasColloquialActivationSubjectSignal(value) {
  const text = String(value || "").trim();
  if (!hasContextualEffectCarrierSignal(text)) return false;
  // Interrogative noun phrases describe the requested result (for example
  // “which trigger effects can activate”), not an unquoted card name.
  if (/(?:有哪些|有何|有什么|哪些|何种|几种|幾種|几个|幾個|如何|怎样|怎樣)/u.test(text)) return false;
  if (/^(?:(?:那之后|那之後|之后|之後|随后|隨後|接着|接著|接下来|接下來|其后|其後|此后|此後|然后|然後)\s*)?(?:还|還)?(?:能|可以|可否|能否|是否)?$/u.test(text)) return false;
  if (/^(?:通常召唤|通常召喚|特殊召唤|特殊召喚|融合召唤|融合召喚|同步召唤|同步召喚|超量召唤|超量召喚|连接召唤|連接召喚|灵摆召唤|靈擺召喚|效果处理|效果處理|连锁|連鎖|攻击宣言|攻擊宣言)$/u.test(text)) return false;
  if (/(?:发出来|發出來|发动|發動|起跳)$/u.test(text)) return false;
  return true;
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
  // The model only proposes search expansions; it does not establish identity.
  // Keep the user's actual surface as the primary mention so a guessed expansion
  // cannot silently resolve a different locally indexed card.
  return originalText;
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

function confidenceForSingleEditMention(seed) {
  if (seed.source !== "model_card_name_extractor") return 0.94;
  if (seed.confidence === "low") return 0.86;
  return 0.92;
}

function confidenceForNearEditMention(seed, distance) {
  if (!Number.isFinite(Number(distance)) || Number(distance) <= 1) {
    return confidenceForSingleEditMention(seed);
  }
  if (seed.source === "model_card_name_extractor" && seed.confidence === "low") return 0.82;
  return 0.9;
}

function findUniqueSingleEditCandidate(aliasIndex, mention) {
  const mentionKey = normalizeCardKey(mention);
  if (mentionKey.length < MIN_SINGLE_EDIT_CARD_KEY_LENGTH) return null;
  const keysByLength = aliasKeysByLengthCache.get(aliasIndex) || buildAliasKeysByLength(aliasIndex);

  const seriesToken = extractMixedScriptSeriesToken(mention);
  if (seriesToken) {
    const seriesMatches = collectSingleEditCandidates(aliasIndex, keysByLength, mention, mentionKey, (candidate) => (
      extractMixedScriptSeriesToken(candidate.matchedAlias) === seriesToken
    ));
    if (seriesMatches.size) return seriesMatches.size === 1 ? seriesMatches.values().next().value : null;
  }

  const matchedCards = collectSingleEditCandidates(aliasIndex, keysByLength, mention, mentionKey);
  return matchedCards.size === 1 ? matchedCards.values().next().value : null;
}

function findUniqueNearEditCandidate(aliasIndex, mention) {
  const matchedCards = collectNearEditCandidates(aliasIndex, mention);
  return matchedCards.size === 1 ? matchedCards.values().next().value : null;
}

function collectNearEditCandidates(aliasIndex, mention, { allowContextualTwoEdit = false } = {}) {
  const mentionKey = normalizeCardKey(mention);
  const maximumDistance = mentionKey.length >= 8 || (allowContextualTwoEdit && mentionKey.length >= 5) ? 2 : 1;
  if (mentionKey.length < 3) return new Map();
  const keysByLength = aliasKeysByLengthCache.get(aliasIndex) || buildAliasKeysByLength(aliasIndex);
  const matchedCards = new Map();
  for (let length = mentionKey.length - maximumDistance; length <= mentionKey.length + maximumDistance; length += 1) {
    for (const aliasKey of keysByLength.get(length) || []) {
      const distance = boundedEditDistance(mentionKey, aliasKey, maximumDistance);
      if (distance > maximumDistance) continue;
      for (const candidate of aliasIndex.get(aliasKey) || []) {
        if (hasNumberedCardIdentityConflict(mention, candidate.matchedAlias)) continue;
        const identity = cardIdentity(candidate.card);
        const previous = matchedCards.get(identity);
        if (identity && (!previous || distance < previous.nearEditDistance)) {
          matchedCards.set(identity, { ...candidate, nearEditDistance: distance });
        }
      }
    }
  }
  return matchedCards;
}

function boundedEditDistance(left, right, limit) {
  const a = String(left || "");
  const b = String(right || "");
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      const value = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function collectSingleEditCandidates(aliasIndex, keysByLength, mention, mentionKey, candidateFilter = null) {
  const matchedCards = new Map();

  for (const length of [mentionKey.length - 1, mentionKey.length, mentionKey.length + 1]) {
    for (const aliasKey of keysByLength.get(length) || []) {
      if (!hasSingleEditDistance(mentionKey, aliasKey)) continue;
      for (const candidate of aliasIndex.get(aliasKey) || []) {
        if (candidateFilter && !candidateFilter(candidate)) continue;
        if (hasNumberedCardIdentityConflict(mention, candidate.matchedAlias)) continue;
        const identity = cardIdentity(candidate.card);
        if (!identity) continue;
        const previous = matchedCards.get(identity);
        if (!previous || normalizeCardKey(previous.matchedAlias).length < aliasKey.length) matchedCards.set(identity, candidate);
      }
    }
  }
  return matchedCards;
}

function findCardsByNumberedIdentity(cards, identity) {
  return getSupplementalCardIndexes(cards).numberedIdentityIndex.get(numberedIdentityKey(identity)) || [];
}

function numberedMentionAlreadyResolved(mention, resolvedCards) {
  const mentionIdentities = extractNumberedCardIdentities(mention);
  if (!mentionIdentities.length) return false;
  return (resolvedCards || []).some((card) => {
    const identities = uniqueCardAliases(card).flatMap(extractNumberedCardIdentities);
    return identities.some((identity) => mentionIdentities.some((mentionIdentity) => (
      sameNumberedIdentity(identity, mentionIdentity)
      && numberedMentionCompatibleWithCard(mention, mentionIdentity, card)
    )));
  });
}

function uniqueCardAliases(card = {}) {
  return dedupeBy([
    card.name,
    card.cnName,
    card.jaName,
    card.enName,
    ...(card.aliases || []),
  ].filter(Boolean), normalizeCardKey);
}

function getSupplementalCardIndexes(cards) {
  const sourceCards = Array.isArray(cards) ? cards : EMPTY_CARD_LIST;
  let cached = supplementalCardIndexesCache.get(sourceCards);
  if (cached) return cached;
  buildAliasIndex(sourceCards);
  cached = supplementalCardIndexesCache.get(sourceCards);
  return cached || {
    numberedIdentityIndex: new Map(),
    shortMentionIndex: new Map(),
    distinctiveFragmentIndex: new Map(),
  };
}

function numberedIdentityKey(identity) {
  return `${identity?.family || ""}:${Number(identity?.number || 0)}`;
}

function sameNumberedIdentity(left, right) {
  return left?.family === right?.family && Number(left?.number) === Number(right?.number);
}

function numberedMentionRemainder(value, identity) {
  const canonical = canonicalizeNumberedCardPrefixes(value).normalize("NFKC").toLowerCase();
  const family = identity?.family === "cno" ? "cno" : "no";
  const number = Number(identity?.number || 0);
  if (!number) return normalizeCardKey(canonical);
  const pattern = new RegExp(`(^|[^a-z0-9])${family}${number}(?!\\d)`, "iu");
  return normalizeCardKey(canonical.replace(pattern, "$1"));
}

function numberedMentionCompatibleWithCard(mention, identity, card) {
  const remainder = numberedMentionRemainder(mention, identity);
  if (!remainder) return true;

  return uniqueCardAliases(card)
    .filter((alias) => extractNumberedCardIdentities(alias).some((candidate) => sameNumberedIdentity(candidate, identity)))
    .map((alias) => numberedMentionRemainder(alias, identity))
    .filter(Boolean)
    .some((candidateRemainder) => compatibleNumberedNameRemainders(remainder, candidateRemainder));
}

function compatibleNumberedNameRemainders(mention, candidate) {
  if (mention === candidate) return true;
  const shorterLength = Math.min(mention.length, candidate.length);
  if (shorterLength >= 2 && candidate.includes(mention)) return true;
  if (hasSingleEditDistance(mention, candidate)) return true;

  let commonPrefixLength = 0;
  while (commonPrefixLength < shorterLength && mention[commonPrefixLength] === candidate[commonPrefixLength]) {
    commonPrefixLength += 1;
  }
  if (commonPrefixLength < 3 || commonPrefixLength / shorterLength < 0.5) return false;
  const mentionSuffix = mention.slice(commonPrefixLength);
  const candidateSuffix = candidate.slice(commonPrefixLength);
  if (!mentionSuffix) return true;
  if (!candidateSuffix) return false;
  const sharedSuffixCharacters = multisetCharacterIntersectionSize(mentionSuffix, candidateSuffix);
  const compactLocalizedVariant = commonPrefixLength >= 4
    && Math.max(mentionSuffix.length, candidateSuffix.length) <= 4
    && Math.abs(mentionSuffix.length - candidateSuffix.length) <= 1
    && sharedSuffixCharacters >= 1;
  if (compactLocalizedVariant) return true;
  return sharedSuffixCharacters >= Math.ceil(Math.min(mentionSuffix.length, candidateSuffix.length) / 2);
}

function plausibleNumberedLocalizedVariant(mention, identity, card) {
  const inputRemainder = numberedMentionRemainder(mention, identity);
  if (inputRemainder.length < 4) return false;
  return uniqueCardAliases(card)
    .filter((alias) => extractNumberedCardIdentities(alias).some((candidate) => sameNumberedIdentity(candidate, identity)))
    .map((alias) => numberedMentionRemainder(alias, identity))
    .filter((candidate) => candidate.length >= 4 && Math.abs(candidate.length - inputRemainder.length) <= 1)
    .some((candidate) => (
      multisetCharacterIntersectionSize(inputRemainder, candidate) / Math.min(inputRemainder.length, candidate.length) >= 0.65
    ));
}

function multisetCharacterIntersectionSize(left, right) {
  const counts = new Map();
  for (const character of String(left || "")) counts.set(character, (counts.get(character) || 0) + 1);
  let shared = 0;
  for (const character of String(right || "")) {
    const remaining = counts.get(character) || 0;
    if (!remaining) continue;
    counts.set(character, remaining - 1);
    shared += 1;
  }
  return shared;
}

function queryHasBareNumberedOccurrence(query, detailedSeeds, identity) {
  let residual = String(query || "");
  for (const seed of detailedSeeds || []) {
    const surface = String(seed?.input || "");
    if (!surface) continue;
    residual = residual.split(surface).join(" ");
  }
  return extractNumberedCardIdentities(residual).some((candidate) => sameNumberedIdentity(candidate, identity));
}

function numberedAliasCompatibleWithExplicitMentions(query, candidate, exactMentionSeeds) {
  const identities = dedupeBy(
    uniqueCardAliases(candidate?.card || candidate).flatMap(extractNumberedCardIdentities),
    numberedIdentityKey,
  );
  return identities.every((identity) => {
    const detailedSeeds = (exactMentionSeeds || []).filter((seed) => (
      seed.source !== "model_card_name_extractor"
      && seed.source !== "contextual_distinctive_fragment"
      && extractNumberedCardIdentities(seed.input).some((item) => sameNumberedIdentity(item, identity))
      && numberedMentionRemainder(seed.input, identity)
    ));
    if (!detailedSeeds.length) return true;
    if (detailedSeeds.some((seed) => numberedMentionCompatibleWithCard(seed.input, identity, candidate.card || candidate))) return true;
    return queryHasBareNumberedOccurrence(query, detailedSeeds, identity);
  });
}

function shortMentionKeysForAlias(alias) {
  const result = [];
  const segments = String(alias || "")
    .normalize("NFKC")
    .split(/[\s・·･．.\-－—–]+/u)
    .map(normalizeCardKey)
    .filter(Boolean);
  for (const segment of segments) {
    if (!/[\u3400-\u9fff]/u.test(segment)) continue;
    for (let length = 2; length <= Math.min(MAX_CONTEXTUAL_SHORT_MENTION_LENGTH, segment.length); length += 1) {
      result.push(segment.slice(0, length));
      result.push(segment.slice(-length));
    }
  }
  return dedupeBy(result, (item) => item);
}

function distinctiveFragments(value) {
  const text = String(value || "").normalize("NFKC");
  const fragments = [];
  const tokens = text
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const key = normalizeCardKey(token);
    if (!key || key.length > DISTINCTIVE_FRAGMENT_MAX_LENGTH) continue;
    if (
      key.length >= 3
      && /[a-z]/iu.test(key)
      && /\d/u.test(key)
      && !/^(?:(?:c|cl|chain|no|cno|sno)\d+)$/iu.test(key)
    ) {
      fragments.push(key);
      continue;
    }
    if (
      key.length >= DISTINCTIVE_CJK_FRAGMENT_MIN_LENGTH
      && /[\u3400-\u9fff]/u.test(key)
      && !/[a-z0-9]/iu.test(key)
    ) {
      fragments.push(key);
    }
  }
  return dedupeBy(fragments, (item) => item);
}

function findUniqueDistinctiveFragmentCandidate(cards, mention) {
  const fragments = distinctiveFragments(mention);
  if (!fragments.length) return null;
  const index = getSupplementalCardIndexes(cards).distinctiveFragmentIndex;
  const uniquelyMatched = [];

  for (const fragment of fragments) {
    const candidates = index.get(fragment) || [];
    if (candidates.length === 1) uniquelyMatched.push({ fragment, candidate: candidates[0] });
  }
  if (!uniquelyMatched.length) return null;

  const mixedScriptMatches = uniquelyMatched.filter(({ fragment }) => (
    /[a-z]/iu.test(fragment) && /\d/u.test(fragment)
  ));
  const preferred = mixedScriptMatches.length ? mixedScriptMatches : uniquelyMatched;
  const identities = new Set(preferred.map(({ candidate }) => cardIdentity(candidate.card)));
  return identities.size === 1 ? preferred[0].candidate : null;
}

function normalizeMaxCards(maxCards) {
  const parsed = Number.parseInt(maxCards, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 6;
}

function extractMixedScriptSeriesToken(value) {
  const text = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^[「『《【\[（(“"']+/u, "");
  const match = text.match(/^([A-Za-z][A-Za-z0-9_-]{1,11})\s*(?=[\u3040-\u30ff\u3400-\u9fff])/u);
  if (!match || /^(?:no|cno|sno)$/iu.test(match[1])) return "";
  return normalizeCardKey(match[1]);
}

function buildAliasKeysByLength(aliasIndex) {
  const keysByLength = new Map();
  for (const key of aliasIndex.keys()) {
    const keys = keysByLength.get(key.length) || [];
    keys.push(key);
    keysByLength.set(key.length, keys);
  }
  aliasKeysByLengthCache.set(aliasIndex, keysByLength);
  return keysByLength;
}

export function hasSingleEditDistance(left, right) {
  const leftKey = String(left || "");
  const rightKey = String(right || "");
  if (leftKey === rightKey || Math.abs(leftKey.length - rightKey.length) > 1) return false;
  if (Math.min(leftKey.length, rightKey.length) < MIN_SINGLE_EDIT_CARD_KEY_LENGTH) return false;

  if (leftKey.length === rightKey.length) {
    let differences = 0;
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] === rightKey[index]) continue;
      differences += 1;
      if (differences > 1) return false;
    }
    return differences === 1;
  }

  const shorter = leftKey.length < rightKey.length ? leftKey : rightKey;
  const longer = leftKey.length < rightKey.length ? rightKey : leftKey;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    longIndex += 1;
  }
  return true;
}

function applyContextualShortMentionResolution({ query, cards, resolved, seenCards, unresolvedMentions, ambiguousMentions }) {
  const pendingMentions = dedupeBy([
    ...unresolvedMentions,
    ...ambiguousMentions.map((item) => ({ input: item.input, source: "ambiguous_mention" })),
  ], (item) => normalizeCardKey(item.input));
  const resolvedMentionKeys = new Set();
  const contextualAmbiguities = new Map();

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const mention of pendingMentions) {
      const mentionKey = normalizeCardKey(mention.input);
      if (!mentionKey || resolvedMentionKeys.has(mentionKey) || mentionKey.length > MAX_CONTEXTUAL_SHORT_MENTION_LENGTH) continue;
      const candidates = findContextualShortMentionCandidates(cards, mention.input);
      if (!candidates.length) continue;

      const selected = chooseContextualShortMentionCandidate(query, mention.input, candidates, resolved);
      if (selected) {
        addResolved(resolved, seenCards, selected, mention.input, 0.9);
        resolvedMentionKeys.add(mentionKey);
        contextualAmbiguities.delete(mentionKey);
        madeProgress = true;
        continue;
      }
      if (candidates.length > 1) contextualAmbiguities.set(mentionKey, buildAmbiguousMention(mention.input, candidates));
    }
  }

  const retainedUnresolved = unresolvedMentions.filter((item) => {
    const key = normalizeCardKey(item.input);
    return !resolvedMentionKeys.has(key) && !contextualAmbiguities.has(key);
  });
  unresolvedMentions.splice(0, unresolvedMentions.length, ...retainedUnresolved);

  const retainedAmbiguous = ambiguousMentions.filter((item) => {
    const key = normalizeCardKey(item.input);
    return !resolvedMentionKeys.has(key) && !contextualAmbiguities.has(key);
  });
  ambiguousMentions.splice(0, ambiguousMentions.length, ...retainedAmbiguous, ...contextualAmbiguities.values());
}

function applyContextualNearEditResolution({
  aliasIndex,
  resolved,
  seenCards,
  unresolvedMentions,
  ambiguousMentions,
}) {
  if (!resolved.length || !unresolvedMentions.length) return;
  const resolvedMentionKeys = new Set();
  for (const mention of unresolvedMentions) {
    const candidates = [...collectNearEditCandidates(aliasIndex, mention.input, { allowContextualTwoEdit: true }).values()];
    if (!candidates.length) continue;
    const linked = candidates.filter((candidate) => cardTextLinksToResolvedIdentity(candidate.card, resolved));
    const identities = new Set(linked.map((candidate) => cardIdentity(candidate.card)).filter(Boolean));
    if (identities.size !== 1) continue;
    const selected = linked.find((candidate) => cardIdentity(candidate.card) === identities.values().next().value);
    addResolved(resolved, seenCards, selected, mention.input, confidenceForNearEditMention(mention, selected.nearEditDistance));
    resolvedMentionKeys.add(normalizeCardKey(mention.input));
  }
  if (!resolvedMentionKeys.size) return;
  const retainedUnresolved = unresolvedMentions.filter((item) => !resolvedMentionKeys.has(normalizeCardKey(item.input)));
  unresolvedMentions.splice(0, unresolvedMentions.length, ...retainedUnresolved);
  const retainedAmbiguous = ambiguousMentions.filter((item) => !resolvedMentionKeys.has(normalizeCardKey(item.input)));
  ambiguousMentions.splice(0, ambiguousMentions.length, ...retainedAmbiguous);
}

function cardTextLinksToResolvedIdentity(candidateCard, resolvedCards) {
  const candidateText = normalizeCardKey(candidateCard?.effectText || "");
  if (!candidateText) return false;
  return resolvedCards.some((resolvedCard) => uniqueCardAliases(resolvedCard).some((alias) => {
    const aliasKey = normalizeCardKey(alias);
    return aliasKey.length >= 3 && candidateText.includes(aliasKey);
  }));
}

function findContextualShortMentionCandidates(cards, mention) {
  const mentionKey = normalizeCardKey(mention);
  if (!mentionKey || mentionKey.length > MAX_CONTEXTUAL_SHORT_MENTION_LENGTH || !/[\u3400-\u9fff]/u.test(String(mention || ""))) return [];
  return getSupplementalCardIndexes(cards).shortMentionIndex.get(mentionKey) || [];
}

function chooseContextualShortMentionCandidate(query, mention, candidates, resolvedCards) {
  const resolvedSeriesKeys = new Set(resolvedCards.flatMap(cardSeriesKeys));
  if (!resolvedSeriesKeys.size) return null;
  const contexts = buildMentionContexts(query, mention, resolvedCards);
  if (!contexts.length) return null;
  const selections = contexts
    .map((context) => selectContextualCandidateForOccurrence(candidates, context, resolvedSeriesKeys));
  if (selections.some((selection) => !selection)) return null;

  const selectedCardIds = new Set(selections.map((selection) => cardIdentity(selection.candidate.card)));
  if (selectedCardIds.size !== 1) return null;
  return selections.sort((left, right) => right.score - left.score)[0].candidate;
}

function selectContextualCandidateForOccurrence(candidates, context, resolvedSeriesKeys) {
  const scored = candidates
    .map((candidate) => scoreContextualShortMentionCandidate(candidate, context, resolvedSeriesKeys))
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best?.sharesSeries || best.strongSignals < 2 || best.score < 8) return null;
  if (runnerUp && best.score - runnerUp.score < 3) return null;
  return best;
}

function scoreContextualShortMentionCandidate(candidate, context, resolvedSeriesKeys) {
  const card = candidate.card || {};
  const effectText = String(card.effectText || "").normalize("NFKC");
  const candidateSeriesKeys = cardSeriesKeys(card);
  const sharesSeries = candidateSeriesKeys.some((key) => resolvedSeriesKeys.has(key));
  let score = sharesSeries ? 5 : 0;
  let strongSignals = sharesSeries ? 1 : 0;

  const mentionedType = inferMentionedCardType(context.nearby);
  if (mentionedType) {
    if (String(card.cardType || "").toLowerCase() === mentionedType) {
      score += 3;
      strongSignals += 1;
    } else {
      score -= 4;
    }
  }

  const semanticMatch = scoreEffectBlocksForMentionContext(effectText, context);
  score += semanticMatch.score;
  strongSignals += semanticMatch.strongSignals;
  return { candidate, score, strongSignals, sharesSeries };
}

function scoreEffectBlocksForMentionContext(effectText, context) {
  const blocks = splitEffectTextBlocks(effectText).map((block) => block.text).filter(Boolean);
  const candidates = blocks.length ? blocks : [String(effectText || "")];
  const mentionedZone = inferMentionedZone(context.before);
  const actionRequested = mentionedActionRequested(context.after);
  const scored = candidates.map((blockText) => ({
    zoneMatches: !mentionedZone || effectSupportsZone(blockText, mentionedZone),
    action: scoreMentionedAction(context.after, blockText),
  }));

  if (mentionedZone && actionRequested) {
    const coherent = scored
      .filter((item) => item.zoneMatches && item.action.strongSignals > 0)
      .sort((left, right) => right.action.score - left.action.score)[0];
    return coherent
      ? { score: 3 + coherent.action.score, strongSignals: 2 }
      : { score: -3, strongSignals: 0 };
  }
  if (mentionedZone) {
    return scored.some((item) => item.zoneMatches)
      ? { score: 3, strongSignals: 1 }
      : { score: -1, strongSignals: 0 };
  }
  if (actionRequested) {
    const best = scored.sort((left, right) => right.action.score - left.action.score)[0]?.action;
    return best || { score: 0, strongSignals: 0 };
  }
  return { score: 0, strongSignals: 0 };
}

function mentionedActionRequested(value) {
  return /(?:替换|替換|交换|交換|换下|換下|弹回|彈回|弹走|彈走|回手|返回手牌|放回手牌|特殊召唤|特殊召喚|特召|破坏|破壞|无效|無效|除外|抽卡|抽牌)/u
    .test(String(value || ""));
}

function cardSeriesKeys(card) {
  if (card && typeof card === "object") {
    const cached = cardSeriesKeysCache.get(card);
    if (cached) return cached;
  }
  const aliases = cardAliases(card);
  const asciiSeries = aliases.map(splitAsciiSeriesAlias).filter(Boolean);
  const localizedSeries = aliases.map(splitLocalizedSeriesAlias).filter(Boolean);
  if (!asciiSeries.length && !localizedSeries.length) return [];
  const result = dedupeBy([
    ...asciiSeries.map((item) => item.prefix),
    ...localizedSeries.map((item) => item.prefix),
  ], normalizeCardKey).map(normalizeCardKey);
  if (card && typeof card === "object") cardSeriesKeysCache.set(card, result);
  return result;
}

function buildMentionContexts(query, mention, resolvedCards) {
  const text = String(query || "").normalize("NFKC");
  const needle = String(mention || "").normalize("NFKC");
  if (!needle) return [];

  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const contexts = [];
  let cursor = 0;
  while (cursor <= lowerText.length - lowerNeedle.length) {
    const index = lowerText.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    const end = index + needle.length;
    cursor = Math.max(end, index + 1);
    if (occurrenceInsideLongerMention(text, index, end, needle, resolvedCards)) continue;

    const bounds = mentionClauseBounds(text, index, end);
    const before = text.slice(Math.max(bounds.start, index - 48), index);
    const after = text.slice(end, Math.min(bounds.end, end + 48));
    contexts.push({ before, after, nearby: `${before}${needle}${after}`, index, end });
  }
  return contexts;
}

function occurrenceInsideLongerMention(text, index, end, needle, resolvedCards) {
  const lowerText = text.toLowerCase();
  for (const card of resolvedCards || []) {
    for (const alias of uniqueCardAliases(card)) {
      const normalizedAlias = String(alias || "").normalize("NFKC");
      if (normalizedAlias.length <= needle.length) continue;
      const lowerAlias = normalizedAlias.toLowerCase();
      let aliasCursor = 0;
      while (aliasCursor <= lowerText.length - lowerAlias.length) {
        const aliasIndex = lowerText.indexOf(lowerAlias, aliasCursor);
        if (aliasIndex < 0) break;
        const aliasEnd = aliasIndex + normalizedAlias.length;
        if (aliasIndex <= index && aliasEnd >= end) return true;
        aliasCursor = Math.max(aliasEnd, aliasIndex + 1);
      }
    }
  }
  return false;
}

function mentionClauseBounds(text, mentionStart, mentionEnd) {
  let start = 0;
  for (let index = mentionStart - 1; index >= 0; index -= 1) {
    if (!/[，,。；;、！？!?\r\n]/u.test(text[index])) continue;
    start = index + 1;
    break;
  }

  let end = text.length;
  for (let index = mentionEnd; index < text.length; index += 1) {
    if (!/[，,。；;、！？!?\r\n]/u.test(text[index])) continue;
    end = index;
    break;
  }

  const clause = text.slice(start, end);
  const chainPattern = /(?:^|[^a-z0-9])((?:c|cl|chain)\s*\d+)/giu;
  for (const match of clause.matchAll(chainPattern)) {
    const markerOffset = (match.index || 0) + String(match[0] || "").indexOf(match[1]);
    const markerIndex = start + markerOffset;
    if (markerIndex <= mentionStart) start = Math.max(start, markerIndex);
    else if (markerIndex >= mentionEnd) {
      end = Math.min(end, markerIndex);
      break;
    }
  }
  return { start, end };
}

function inferMentionedCardType(text) {
  const value = String(text || "");
  if (/(?:陷阱卡?|魔陷)/u.test(value)) return "trap";
  if (/魔法卡/u.test(value)) return "spell";
  if (/怪兽卡|怪獸卡/u.test(value)) return "monster";
  return "";
}

function inferMentionedZone(beforeMention) {
  const tail = String(beforeMention || "").slice(-24);
  const signals = [
    { zone: "hand", pattern: /(?:手牌|手卡|手札)/gu },
    { zone: "graveyard", pattern: /墓地/gu },
    { zone: "banished", pattern: /(?:除外区|除外區|除外)/gu },
    { zone: "field", pattern: /(?:场上|場上|怪兽区|怪獸區|魔法陷阱区|魔法陷阱區)/gu },
  ];
  let latest = { zone: "", index: -1 };
  for (const signal of signals) {
    for (const match of tail.matchAll(signal.pattern)) {
      if ((match.index ?? -1) > latest.index) latest = { zone: signal.zone, index: match.index ?? -1 };
    }
  }
  return latest.zone;
}

function effectSupportsZone(effectText, zone) {
  const text = String(effectText || "");
  if (zone === "hand") return /(?:手牌|手卡|手札).{0,24}(?:发动|發動|特殊召唤|特殊召喚)|(?:发动|發動|特殊召唤|特殊召喚).{0,24}(?:手牌|手卡|手札)/su.test(text);
  if (zone === "graveyard") return /墓地.{0,24}(?:发动|發動|特殊召唤|特殊召喚|除外|加入手牌)/su.test(text);
  if (zone === "banished") return /除外.{0,24}(?:发动|發動|特殊召唤|特殊召喚|返回|回到|放回)/su.test(text);
  if (zone === "field") return /(?:场上|場上|怪兽区域|怪獸區域|魔法与陷阱区域|魔法與陷阱區域).{0,24}(?:发动|發動|可以|存在)/su.test(text);
  return false;
}

function scoreMentionedAction(afterMention, effectText) {
  const context = String(afterMention || "").slice(0, 36);
  const effect = String(effectText || "");
  const returnsToHand = /(?:放回|返回|回到).{0,8}(?:手牌|手卡|手札)|(?:手牌|手卡|手札).{0,8}(?:放回|返回|回到)/su.test(effect);
  const specialSummons = /特殊召唤|特殊召喚/su.test(effect);

  if (/(?:替换|替換|交换|交換|换下|換下)/u.test(context)) {
    return returnsToHand && specialSummons ? { score: 4, strongSignals: 1 } : { score: 0, strongSignals: 0 };
  }

  const directActions = [
    { query: /(?:弹回|彈回|弹走|彈走|回手|返回手牌|放回手牌)/u, effect: /(?:放回|返回|回到).{0,8}(?:手牌|手卡|手札)/su },
    { query: /(?:特殊召唤|特殊召喚|特召)/u, effect: /特殊召唤|特殊召喚/su },
    { query: /(?:破坏|破壞)/u, effect: /破坏|破壞/su },
    { query: /(?:无效|無效)/u, effect: /无效|無效/su },
    { query: /除外/u, effect: /除外/su },
    { query: /(?:抽卡|抽牌|抽\s*\d+\s*张)/u, effect: /抽.{0,4}(?:张卡|張卡|牌)/su },
  ];
  for (const action of directActions) {
    if (action.query.test(context) && action.effect.test(effect)) return { score: 3, strongSignals: 1 };
  }
  return { score: 0, strongSignals: 0 };
}

function addResolved(resolved, seenCards, candidate, input, confidence, resolutionSource = "query") {
  const card = candidate.card || candidate;
  const key = cardIdentity(card);
  if (!key || seenCards.has(key)) return null;
  seenCards.add(key);
  const attack = normalizedCardNumber(card.attack ?? card.atk);
  const defense = normalizedCardNumber(card.defense ?? card.def);
  const level = normalizedCardNumber(card.level);
  const rank = normalizedCardNumber(card.rank);
  const link = normalizedCardNumber(card.link ?? card.linkRating);
  const resolvedCard = {
    input: String(input || candidate.matchedAlias || card.name || ""),
    id: String(card.id || card.cardId || ""),
    cardId: String(card.id || card.cardId || ""),
    passcode: String(card.passcode || card.password || ""),
    name: card.name || card.cnName || card.jaName || card.enName || String(input || ""),
    cnName: card.cnName || "",
    jaName: card.jaName || "",
    enName: card.enName || "",
    type: card.type || card.cardType || "",
    cardType: card.cardType || card.type || "",
    race: card.race || "",
    attribute: card.attribute || "",
    ...(attack !== null ? { attack, atk: attack } : {}),
    ...(defense !== null ? { defense, def: defense } : {}),
    ...(level !== null ? { level } : {}),
    ...(rank !== null ? { rank } : {}),
    ...(link !== null ? { link, linkRating: link } : {}),
    ...(card.linkArrows ? { linkArrows: String(card.linkArrows) } : {}),
    ...(Array.isArray(card.propertyIds) ? { propertyIds: [...card.propertyIds] } : {}),
    ...(Array.isArray(card.properties) ? { properties: [...card.properties] } : {}),
    ...(Array.isArray(card.monsterPropertyIds) ? { monsterPropertyIds: [...card.monsterPropertyIds] } : {}),
    ...(Array.isArray(card.monsterProperties) ? { monsterProperties: [...card.monsterProperties] } : {}),
    effectText: card.effectText || "",
    sourceUrl: card.sourceUrl || "",
    ...(card.formalDefinitionId ? { formalDefinitionId: String(card.formalDefinitionId) } : {}),
    ...(card.formalDefinitionSnapshotId
      ? { formalDefinitionSnapshotId: String(card.formalDefinitionSnapshotId) }
      : {}),
    ...(card.formalDefinitionContentSha256
      ? { formalDefinitionContentSha256: String(card.formalDefinitionContentSha256) }
      : {}),
    ...(card.formalSnapshotId ? { formalSnapshotId: String(card.formalSnapshotId) } : {}),
    ...(card.formalContentSha256 ? { formalContentSha256: String(card.formalContentSha256) } : {}),
    ...(Array.isArray(card.formalEffects) ? { formalEffects: structuredClone(card.formalEffects) } : {}),
    ...(card.formal && typeof card.formal === "object" ? { formal: structuredClone(card.formal) } : {}),
    aliases: resolvedCardAliases(card, input),
    confidence,
    resolutionSource,
  };
  resolved.push(resolvedCard);
  return resolvedCard;
}

function normalizedCardNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolvedCardAliases(card, input) {
  const aliases = cardAliases(card);
  const mention = String(input || "").trim();
  const identities = extractNumberedCardIdentities(mention);
  if (!mention || identities.length !== 1) return aliases;
  const identity = identities[0];
  if (numberedMentionRemainder(mention, identity).length < 2) return aliases;
  const cardHasIdentity = aliases.some((alias) => (
    extractNumberedCardIdentities(alias).some((candidate) => sameNumberedIdentity(candidate, identity))
  ));
  return cardHasIdentity ? dedupeBy([...aliases, mention], normalizeCardKey) : aliases;
}

function applyReferencedCardTextResolution({ query, aliasIndex, resolved, seenCards, maxCards }) {
  if (!/(?:发动|發動|発動|处理|處理|処理|结算|結算|適用|适用|resolve|activate)/iu.test(String(query || ""))) return;

  // A question often names only the card whose effect is being judged, while the
  // governing dependency is an exact card name inside that card's own text.
  // Resolve one hop only, and only globally unique exact aliases; this expands
  // explicit card-text dependencies without turning archetype names into cards.
  const sourceCards = resolved.slice();
  for (const sourceCard of sourceCards) {
    const blocks = splitEffectTextBlocks(sourceCard.effectText);
    const effectBlocks = blocks.some((block) => block.kind === "effect")
      ? blocks.filter((block) => block.kind === "effect")
      : blocks;
    for (const block of effectBlocks) {
      for (const mention of extractQuotedMentions(block.text)) {
        const candidates = aliasIndex.get(normalizeCardKey(mention)) || [];
        if (candidates.length !== 1) continue;
        addResolved(resolved, seenCards, candidates[0], mention, 0.86, "card_text_reference");
        if (resolved.length >= maxCards) return;
      }
    }
  }
}

export function extractQuotedMentions(query) {
  return dedupeBy(
    collectQuotedMentionEntries(query).filter((item) => item.role === "card"),
    (item) => normalizeCardKey(item.mention),
  ).map((item) => item.mention);
}

function collectQuotedMentionEntries(query) {
  const result = [];
  const text = String(query || "");
  for (const pattern of QUOTED_MENTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const mention = String(match[1] || "").trim();
      if (!looksLikeCardMention(mention)) continue;
      const index = match.index ?? text.indexOf(match[0]);
      const end = index + String(match[0] || "").length;
      result.push({
        mention,
        index,
        end,
        role: classifyQuotedMentionRole(text, mention, index, end),
      });
    }
  }
  result.sort((left, right) => left.index - right.index);
  const effectClauseContainers = result.filter((item) => item.role === "effect_clause");
  for (const item of result) {
    if (item.role !== "card") continue;
    if (effectClauseContainers.some((container) => (
      container !== item
      && container.index < item.index
      && container.end > item.end
    ))) {
      item.role = "nested_effect_expression";
    }
  }
  return result;
}

function classifyQuotedMentionRole(text, mention, index, end) {
  const prefix = String(text || "").slice(Math.max(0, index - 32), index).normalize("NFKC");
  const suffix = String(text || "").slice(end, end + 48).normalize("NFKC");

  // Quotation marks are also used to define the meaning of a term in the
  // question itself. Requiring both a metalinguistic prefix and an
  // interpretation suffix prevents those terms from becoming fake card-name
  // failures without weakening unresolved handling for actual quoted cards.
  if (/(?:本题|本問|本问|问题中|問題中|这里|這裡|此处|此處)(?:所说|所說|所谓|所謂|的)?\s*$/u.test(prefix)
      && /^\s*(?:按|应按|應按|是指|指的是|表示|意味着|意味著|定义为|定義為|理解为|理解為)/u.test(suffix)) {
    return "metalinguistic_term";
  }

  if (/^\s*(?:として扱|として使用|としてカード名を扱|视为|視為|被视为|被視為)/iu.test(suffix)) {
    return "dynamic_card_name";
  }

  if (/^\s*(?:と名のついた|という名の|名のついた|カード名に.{0,12}(?:含む|含まれる|記された)|(?:融合|儀式|シンクロ|エクシーズ|リンク|ペンデュラム|通常|効果|チューナー|同调|同步|融合|仪式|儀式|连接|連接|超量)?\s*(?:モンスター|カード))/iu.test(suffix)) {
    return "card_series";
  }

  if (looksLikeQuotedEffectClause(mention)) return "effect_clause";
  return "card";
}

function looksLikeQuotedEffectClause(mention) {
  const text = String(mention || "").normalize("NFKC").trim();
  if (text.length < 8) return false;
  const hasResolutionTerm = /(?:处理|處理|処理|结算|結算|解決|resolv(?:e|ed|ing)|process(?:ed|ing)?)/iu.test(text);
  const hasResolutionMetaGrammar = /(?:不能|无法|無法|不再|不进行|不進行|为止|為止|对象|對象|対象|丢失|丟失|离场|離場|不适用|不適用|继续|繼續|できない|行えない|行わない|ところまで|存在しない|離れた|失われた|cannot|can't|unable|no\s+longer|as\s+far\s+as\s+possible|target)/iu.test(text);
  // Players often quote competing rule interpretations rather than card
  // names, for example “process as far as possible” or “the target is gone,
  // do not resolve”.  Treat only propositions that contain both a resolution
  // term and meta-resolution grammar as non-card clauses; ordinary long card
  // names such as “不能停止的机械巨龙” remain card mentions.
  if (hasResolutionTerm && hasResolutionMetaGrammar) return true;
  const hasReferencedObject = /(?:(?:その|この|あの|対象の|選んだ|選択した|该|該|此|这|這|那)(?:カード|怪獣|モンスター|発動|効果)|(?:その|この|该|該|此|这|這|那)(?:発動|效果|効果))/u.test(text);
  const hasEffectOperation = /(?:発動|发动|發動|適用|适用|無効|无效|戻す|返回|放回|破壊|破坏|除外|墓地へ送|送去墓地|手札に加|加入手牌|召喚|召唤|特殊召喚|特殊召唤)/u.test(text);
  if (!hasEffectOperation) return false;

  const hasRuleSubject = /(?:自分|自己|我方|对方|對方|双方|雙方|プレイヤー|玩家|このカード|そのカード|此卡|这张卡|這張卡|该卡|該卡|这个效果|這個效果|その効果)/u.test(text);
  const hasRestrictionGrammar = /(?:しか.{0,24}(?:できない|行えない)|できない|できる|なければならない|してはならない|不能|不可以|不可|不得|只能|仅能|僅能|必须|必須|可以|能否|不会|不會|不受)/u.test(text);
  const hasTurnFrame = /(?:この|その|自分の|相手の)?ターン|(?:这个|這個|本|此|那个|那個|自己|对方|對方)回合/u.test(text);
  const hasCompletedActionGrammar = /(?:已(?:经)?|曾(?:经)?|已经|已經).{0,20}(?:发动|發動|使用).{0,6}过/u.test(text);
  const hasEffectInstructionGrammar = /(?:从|從|自).{0,20}(?:卡组|卡組|牌组|牌組|手牌|手卡|墓地|除外).{0,28}(?:召喚|召唤|特殊召喚|特殊召唤|加入手牌|墓地へ送|送去墓地|除外|返回|放回)/u.test(text);
  return (hasReferencedObject && hasEffectOperation)
    || (hasRuleSubject && hasRestrictionGrammar)
    || (hasTurnFrame && (hasRestrictionGrammar || hasCompletedActionGrammar))
    || hasCompletedActionGrammar
    || hasEffectInstructionGrammar;
}

function maskNonCardQuotedExpressions(query) {
  const text = String(query || "");
  const chars = text.split("");
  for (const entry of collectQuotedMentionEntries(text)) {
    if (entry.role === "card") continue;
    for (let index = entry.index; index < entry.end; index += 1) chars[index] = " ";
  }
  return chars.join("");
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
  if (card && typeof card === "object") {
    const cached = cardAliasesCache.get(card);
    if (cached) return cached;
  }

  const baseAliases = [
    card.name,
    card.cnName,
    card.jaName,
    card.enName,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
  ].filter(Boolean);
  const aliases = dedupeBy([
    ...baseAliases,
    ...deriveCrossLocaleSeriesAliases(baseAliases),
  ], normalizeCardKey);
  if (card && typeof card === "object") cardAliasesCache.set(card, aliases);
  return aliases;
}

function deriveCrossLocaleSeriesAliases(aliases) {
  const asciiEntries = aliases.map(splitAsciiSeriesAlias).filter(Boolean);
  const localizedEntries = aliases.map(splitLocalizedSeriesAlias).filter(Boolean);
  const asciiPrefixes = dedupeBy(asciiEntries.map((item) => item.prefix), normalizeCardKey);
  const localizedPrefixes = dedupeBy(localizedEntries.map((item) => item.prefix), normalizeCardKey);
  if (asciiPrefixes.length !== 1 || localizedPrefixes.length !== 1) return [];
  const localizedSuffixes = dedupeBy(localizedEntries.map((item) => item.suffix), normalizeCardKey);

  const derived = [];
  for (const suffix of localizedSuffixes) {
    derived.push(`${asciiPrefixes[0]} ${suffix}`, `${asciiPrefixes[0]}${suffix}`);
  }
  return dedupeBy(derived, normalizeCardKey);
}

function splitAsciiSeriesAlias(value) {
  const text = String(value || "").normalize("NFKC").trim();
  const match = text.match(/^([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)[\s・·･．.\-－—–]+(.{2,})$/u);
  if (!match) return null;
  const letters = match[1].replace(/[^A-Za-z]/gu, "");
  if (letters.length < 2 || letters !== letters.toUpperCase() || /^(?:no|cno|sno)$/iu.test(match[1])) return null;
  return { prefix: match[1], suffix: match[2].trim() };
}

function splitLocalizedSeriesAlias(value) {
  const text = String(value || "").normalize("NFKC").trim();
  const match = text.match(/^([\u3400-\u9fff]{2,12})[\s・·･．.\-－—–]+(.{2,})$/u);
  if (!match || !/[\u3040-\u30ff\u3400-\u9fff]/u.test(match[2])) return null;
  return { prefix: match[1], suffix: match[2].trim() };
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
