import { canonicalizeNumberedCardPrefixes, extractNumberedCardIdentities } from "./numberedCardIdentity.mjs";
import {
  RAG_CARD_ALIAS_RUNTIME_INDEX_ABI,
  RAG_CARD_ALIAS_RUNTIME_INDEX_KIND,
  RAG_CARD_ALIAS_RUNTIME_INDEX_SCHEMA_VERSION,
} from "./ragCardAliasRuntimeContract.mjs";

const EMPTY_CARD_LIST = Object.freeze([]);
const MAX_CONTEXTUAL_SHORT_MENTION_LENGTH = 4;
const DISTINCTIVE_CJK_FRAGMENT_MIN_LENGTH = 4;
const DISTINCTIVE_FRAGMENT_MAX_LENGTH = 12;

/**
 * Compile the storage-only alias artifact used by the legacy runtime cache.
 *
 * This module deliberately knows only card identities and name surfaces. It
 * does not parse questions, duel state or ruling semantics, so build/check
 * tooling can produce the existing v1 artifact without importing the legacy
 * card extractor or any handwritten ruling component.
 */
export function compileRagCardAliasRuntimeIndex(cards = []) {
  const sourceCards = Array.isArray(cards) ? cards : EMPTY_CARD_LIST;
  const indexes = buildAliasIndexes(sourceCards);
  const cardOrdinals = new Map();
  for (let ordinal = 0; ordinal < sourceCards.length; ordinal += 1) {
    if (!cardOrdinals.has(sourceCards[ordinal])) cardOrdinals.set(sourceCards[ordinal], ordinal);
  }

  const serializeCandidates = (candidates) => candidates.map((candidate) => {
    const cardOrdinal = cardOrdinals.get(candidate.card);
    if (!Number.isSafeInteger(cardOrdinal)) {
      throw new TypeError("card alias index candidate is not owned by the supplied cards array");
    }
    return {
      cardOrdinal,
      matchedAlias: candidate.matchedAlias,
      matchedAliasKind: candidate.matchedAliasKind,
    };
  });
  const serializeCandidateMap = (index) => [...index.entries()].map(([key, candidates]) => [
    key,
    serializeCandidates(candidates),
  ]);

  return {
    schemaVersion: RAG_CARD_ALIAS_RUNTIME_INDEX_SCHEMA_VERSION,
    kind: RAG_CARD_ALIAS_RUNTIME_INDEX_KIND,
    compilerAbi: RAG_CARD_ALIAS_RUNTIME_INDEX_ABI,
    cardCount: sourceCards.length,
    cardIdentities: sourceCards.map(cardIdentity),
    primary: serializeCandidateMap(indexes.primary),
    aliasKeysByLength: [...indexes.aliasKeysByLength.entries()].map(([length, keys]) => [length, [...keys]]),
    numberedIdentityIndex: serializeCandidateMap(indexes.numberedIdentityIndex),
    shortMentionIndex: serializeCandidateMap(indexes.shortMentionIndex),
    distinctiveFragmentIndex: serializeCandidateMap(indexes.distinctiveFragmentIndex),
  };
}

function buildAliasIndexes(cards) {
  const primary = new Map();
  const canonicalPrefixIndex = buildCanonicalPrefixIndex(cards);
  const numberedIdentityIndex = new Map();
  const shortMentionIndex = new Map();
  const distinctiveFragmentIndex = new Map();

  for (const card of cards) {
    const aliases = cardAliases(card);
    const canonicalAliasKeys = new Set(canonicalCardAliases(card).map(normalizeCardKey));
    const seenNumberedKeys = new Set();
    const seenShortKeys = new Set();
    for (const alias of aliases) {
      const key = normalizeCardKey(alias);
      if (!key) continue;
      const item = {
        card,
        matchedAlias: alias,
        matchedAliasKind: canonicalAliasKeys.has(key) ? "canonical_name" : "supplemental_alias",
      };
      append(primary, key, item);

      for (const identity of extractNumberedCardIdentities(alias)) {
        const identityKey = numberedIdentityKey(identity);
        if (seenNumberedKeys.has(identityKey)) continue;
        seenNumberedKeys.add(identityKey);
        append(numberedIdentityIndex, identityKey, item);
      }

      for (const shortKey of shortMentionKeysForAlias(alias)) {
        if (seenShortKeys.has(shortKey)) continue;
        seenShortKeys.add(shortKey);
        append(shortMentionIndex, shortKey, item);
      }

      for (const fragmentKey of distinctiveFragments(alias)) {
        append(distinctiveFragmentIndex, fragmentKey, item);
      }
    }
  }

  for (const [key, candidates] of primary.entries()) {
    const deduped = dedupeBy(candidates, (candidate) => cardIdentity(candidate.card));
    const exactCanonical = deduped.filter((candidate) => candidate.matchedAliasKind === "canonical_name");
    if (exactCanonical.length) {
      primary.set(key, exactCanonical);
      continue;
    }
    const canonicalPrefixCandidates = canonicalPrefixIndex.get(key) || [];
    const supplementalBelongsToPrefixCard = deduped.some((candidate) => (
      canonicalPrefixCandidates.some((prefixCandidate) => (
        cardIdentity(prefixCandidate.card) === cardIdentity(candidate.card)
      ))
    ));
    primary.set(
      key,
      canonicalPrefixCandidates.length && !supplementalBelongsToPrefixCard
        ? canonicalPrefixCandidates
        : deduped,
    );
  }
  for (const [key, candidates] of numberedIdentityIndex.entries()) {
    numberedIdentityIndex.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  for (const [key, candidates] of shortMentionIndex.entries()) {
    const deduped = dedupeBy(candidates, (candidate) => cardIdentity(candidate.card));
    const exactCanonical = deduped.filter((candidate) => candidate.matchedAliasKind === "canonical_name");
    const canonicalPrefixCandidates = canonicalPrefixIndex.get(key) || [];
    const supplementalBelongsToPrefixCard = deduped.some((candidate) => (
      canonicalPrefixCandidates.some((prefixCandidate) => (
        cardIdentity(prefixCandidate.card) === cardIdentity(candidate.card)
      ))
    ));
    shortMentionIndex.set(
      key,
      exactCanonical.length
        ? exactCanonical
        : canonicalPrefixCandidates.length && !supplementalBelongsToPrefixCard
          ? canonicalPrefixCandidates
          : deduped,
    );
  }
  for (const [key, candidates] of distinctiveFragmentIndex.entries()) {
    distinctiveFragmentIndex.set(key, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }

  const aliasKeysByLength = new Map();
  for (const key of primary.keys()) {
    const keys = aliasKeysByLength.get(key.length) || [];
    keys.push(key);
    aliasKeysByLength.set(key.length, keys);
  }
  return {
    primary,
    aliasKeysByLength,
    numberedIdentityIndex,
    shortMentionIndex,
    distinctiveFragmentIndex,
  };
}

function buildCanonicalPrefixIndex(cards) {
  const index = new Map();
  for (const card of cards) {
    for (const alias of canonicalCardAliases(card)) {
      const key = normalizeCardKey(alias);
      if (key.length < 4) continue;
      for (let length = 3; length < key.length; length += 1) {
        append(index, key.slice(0, length), {
          card,
          matchedAlias: key.slice(0, length),
          matchedAliasKind: "canonical_name_prefix",
        });
      }
    }
  }
  for (const [prefix, candidates] of index.entries()) {
    index.set(prefix, dedupeBy(candidates, (candidate) => cardIdentity(candidate.card)));
  }
  return index;
}

function canonicalCardAliases(card = {}) {
  return dedupeBy([
    card.name,
    card.cnName,
    card.jaName,
    card.enName,
  ].filter(Boolean), normalizeCardKey);
}

function cardAliases(card = {}) {
  const baseAliases = [
    card.name,
    card.cnName,
    card.jaName,
    card.enName,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
  ].filter(Boolean);
  return dedupeBy([
    ...baseAliases,
    ...deriveCrossLocaleSeriesAliases(baseAliases),
  ], normalizeCardKey);
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
  const tokens = String(value || "")
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const fragments = [];
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

function normalizeCardKey(value) {
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

function numberedIdentityKey(identity) {
  return `${identity?.family || ""}:${Number(identity?.number || 0)}`;
}

function cardIdentity(card = {}) {
  return String(card.id || card.cardId || normalizeCardKey(card.name || card.cnName || card.jaName || card.enName || ""));
}

function append(index, key, value) {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}
