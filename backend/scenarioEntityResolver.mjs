// Resolve discourse-level references without attaching any rule meaning to a
// particular card.  Callers still have to prove the relevant action and card
// semantics; this module only binds a surface/reference to one known entity.

export function resolveOrdinalEntityReferences({ query = "", entities = [], actionPattern = null } = {}) {
  const text = String(query || "").normalize("NFKC");
  const mentions = collectEntityMentions(text, entities);
  const resolvedIds = new Set();
  const ambiguousReferences = [];
  for (const match of text.matchAll(/(?:上述|以上|前述)?\s*(前者|后者|後者)/gu)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const clause = localClause(text, index, match[0].length, 32, 32);
    if (actionPattern && !actionPattern.test(clause)) continue;
    const binding = bindOrdinalReference(mentions, index, match[1]);
    if (binding.status === "bound") resolvedIds.add(binding.entityId);
    else ambiguousReferences.push({ surface: match[0], index, reason: binding.reason });
  }
  return {
    entityIds: [...resolvedIds],
    ambiguous: ambiguousReferences.length > 0,
    ambiguousReferences,
  };
}

export function resolveUniqueEntityFragment(fragment, entities = [], context = {}) {
  const needle = normalizeIdentity(stripQuotes(fragment));
  if (!needle || isGenericEntityFragment(needle)) {
    return { status: "unresolved", entityIds: [], reason: "generic_or_too_short_fragment" };
  }
  const candidates = uniqueEntities(entities);
  const exactMatches = candidates.filter((entity) => entitySurfaces(entity).some((surface) => (
    normalizeIdentity(surface) === needle
  )));
  if (exactMatches.length === 1) {
    return { status: "bound", entityIds: [entityId(exactMatches[0])], entity: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return { status: "ambiguous", entityIds: exactMatches.map(entityId) };
  }

  const matches = candidates.filter((entity) => entitySurfaces(entity).some((surface) => {
    const haystack = normalizeIdentity(surface);
    return haystack.includes(needle) || needle.includes(haystack);
  }));
  if (matches.length === 1 && (
    isHighSignalFragment(needle)
    || entityWasIntroducedBeforeReference(matches[0], needle, context)
  )) {
    return { status: "bound", entityIds: [entityId(matches[0])], entity: matches[0] };
  }
  return {
    status: matches.length > 1 ? "ambiguous" : "unresolved",
    entityIds: matches.map(entityId),
    ...(matches.length === 1 ? { reason: "partial_fragment_not_grounded_by_prior_full_mention" } : {}),
  };
}

export function collectEntityMentions(query = "", entities = []) {
  const text = String(query || "").normalize("NFKC");
  const lower = text.toLowerCase();
  const raw = [];
  for (const entity of uniqueEntities(entities)) {
    for (const surface of entitySurfaces(entity).sort((left, right) => right.length - left.length)) {
      const candidate = surface.normalize("NFKC");
      if (candidate.length < 2) continue;
      const needle = candidate.toLowerCase();
      let cursor = 0;
      while (cursor <= lower.length - needle.length) {
        const index = lower.indexOf(needle, cursor);
        if (index < 0) break;
        raw.push({ entityId: entityId(entity), entity, surface: candidate, index, end: index + candidate.length });
        cursor = Math.max(index + candidate.length, index + 1);
      }
    }
  }
  // A translated alias may be contained in a longer alias at the same range.
  // Keep one mention per entity/range, preferring the longest exact surface.
  const deduped = new Map();
  for (const mention of raw) {
    const key = `${mention.entityId}:${mention.index}`;
    const previous = deduped.get(key);
    if (!previous || mention.surface.length > previous.surface.length) deduped.set(key, mention);
  }
  return [...deduped.values()].sort((left, right) => left.index - right.index || right.surface.length - left.surface.length);
}

function bindOrdinalReference(mentions, referenceIndex, ordinal) {
  const lowerBound = Math.max(0, referenceIndex - 240);
  const preceding = mentions.filter((mention) => mention.end <= referenceIndex && mention.index >= lowerBound);
  const orderedDistinct = [];
  for (const mention of preceding) {
    if (!orderedDistinct.some((item) => item.entityId === mention.entityId)) orderedDistinct.push(mention);
  }
  // “前者/后者” is only deterministic when the discourse has introduced one
  // pair.  Three or more candidates deliberately fail closed.
  if (orderedDistinct.length !== 2) {
    return { status: "ambiguous", reason: `ordinal_reference_candidate_count_${orderedDistinct.length}` };
  }
  return {
    status: "bound",
    entityId: ordinal === "前者" ? orderedDistinct[0].entityId : orderedDistinct[1].entityId,
  };
}

function localClause(text, index, length, beforeLength, afterLength) {
  const before = text.slice(Math.max(0, index - beforeLength), index);
  const after = text.slice(index + length, index + length + afterLength);
  return `${before}${text.slice(index, index + length)}${after}`;
}

function uniqueEntities(entities) {
  const map = new Map();
  for (const entity of entities || []) {
    const id = entityId(entity);
    if (id && !map.has(id)) map.set(id, entity);
  }
  return [...map.values()];
}

function entitySurfaces(entity) {
  return [...new Set([
    ...(entity?.names || []),
    ...(entity?.aliases || []),
    entity?.input,
    entity?.matchedQuery,
    entity?.name,
    entity?.cnName,
    entity?.jaName,
    entity?.jpName,
    entity?.enName,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function entityId(entity) {
  return String(entity?.id || entity?.definitionId || entity?.cardId || "");
}

function stripQuotes(value) {
  return String(value || "").trim().replace(/^[\p{Pi}\p{Pf}'"]+|[\p{Pi}\p{Pf}'"]+$/gu, "").trim();
}

function normalizeIdentity(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isGenericEntityFragment(value) {
  const length = [...String(value || "")].length;
  if (length < 2) return true;
  return /^(?:这张卡|這張卡|该卡|該卡|此卡|那张卡|那張卡|卡片?|怪兽|怪獸|怪物|手牌|手卡|手札|墓地|场上|場上|额外卡组|額外卡組|额外牌组|額外牌組|效果|魔法|陷阱|龙|龍|圣|聖|族怪兽|族怪獸|[\p{Script=Han}]{1,8}族(?:怪兽|怪獸|怪物)?)$/u.test(value);
}

function isHighSignalFragment(value) {
  const codePoints = [...String(value || "")];
  if (codePoints.length >= 4) return true;
  return codePoints.length >= 3 && /[0-9]/u.test(value);
}

function entityWasIntroducedBeforeReference(entity, needle, context = {}) {
  const query = String(context?.query || "").normalize("NFKC");
  if (!query) return false;
  const requestedIndex = Number(context?.referenceIndex);
  const referenceIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0
    ? Math.min(requestedIndex, query.length)
    : -1;
  if (referenceIndex < 0) return false;
  const prefix = normalizeIdentity(query.slice(0, referenceIndex));
  return entitySurfaces(entity).some((surface) => {
    const normalizedSurface = normalizeIdentity(surface);
    return normalizedSurface.length > needle.length
      && normalizedSurface.includes(needle)
      && prefix.includes(normalizedSurface);
  });
}
