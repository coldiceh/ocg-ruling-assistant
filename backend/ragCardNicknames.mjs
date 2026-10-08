import { extractRagCards, normalizeCardKey } from './ragCardExtractor.mjs';

const referenceBindings = new WeakMap();
const resolvedBindings = new WeakMap();
const primaryNames = card => [card.name, card.cnName, card.jaName, card.jpName, card.enName]
  .filter(value => typeof value === 'string' && value.trim());
const cardId = card => String(card?.id || card?.cardId || '');
const surfaceKey = value => String(value || '').normalize('NFKC').toLowerCase();
const identitySignature = card => JSON.stringify([cardId(card), String(card?.cardId || ''),
  card?.input, ...primaryNames(card)]);
const sourceSignature = card => JSON.stringify([cardId(card), ...primaryNames(card)]);

function indexedCards(cards) {
  const byId = new Map();
  for (const card of cards || []) {
    const id = cardId(card);
    if (!id) continue;
    byId.set(id, byId.has(id) ? null : card);
  }
  return byId;
}

function queryProjection(query) {
  let text = '';
  const ranges = [];
  for (let start = 0; start < query.length;) {
    const character = String.fromCodePoint(query.codePointAt(start));
    const end = start + character.length, normalized = surfaceKey(character);
    text += normalized;
    for (let i = 0; i < normalized.length; i++) ranges.push({ start, end });
    start = end;
  }
  return alias => {
    const needle = surfaceKey(alias), matches = [];
    if (!needle) return matches;
    let cursor = 0;
    while (cursor <= text.length - needle.length) {
      const at = text.indexOf(needle, cursor);
      if (at < 0) break;
      cursor = at + 1;
      // Latin abbreviations must not match inside a longer Latin word/code.
      if (/[a-z0-9_]$/u.test(needle) && /[a-z0-9_]/u.test(text[at + needle.length] || '')) continue;
      if (/^[a-z0-9_]/u.test(needle) && /[a-z0-9_]/u.test(text[at - 1] || '')) continue;
      const start = ranges[at]?.start, end = ranges[at + needle.length - 1]?.end;
      if (start === undefined || end === undefined) continue;
      const input = query.slice(start, end);
      if (surfaceKey(input) === needle) matches.push({ start, end, input });
    }
    return matches;
  };
}

// These are candidate references, never a list of cards admitted as mentions.
// Dataset identity is bound to the actual supplied canonical card records.
export function buildCardNicknameReferences(query, cards = [], dataset = {}) {
  const text = String(query || ''), locate = queryProjection(text), byId = indexedCards(cards);
  const sources = new Map((dataset.sources || []).map(source => [String(source.id || ''), source]));
  const hits = [];
  for (const entry of dataset.entries || []) {
    const alias = String(entry.alias || '').trim(), card = byId.get(String(entry.cardId || ''));
    const source = sources.get(String(entry.sourceId || ''));
    if (!alias || !card || !primaryNames(card).length || !source?.url) continue;
    for (const span of locate(alias)) hits.push({ ...span, alias, card, source });
  }
  if (!hits.length) return [];
  // A nickname inside a longer complete card name does not establish a second
  // mention. Independent occurrences of that nickname remain available.
  const canonicalSpans = (cards || []).flatMap(card => primaryNames(card).flatMap(name => {
    const spans = locate(name);
    if (!spans.length) return [];
    if (!hits.some(hit => surfaceKey(name).includes(surfaceKey(hit.input)) && name.length > hit.input.length)) return [];
    return spans;
  }));
  const visible = hits.filter(hit => ![...hits, ...canonicalSpans].some(other =>
    other.start <= hit.start && other.end >= hit.end
      && (other.start < hit.start || other.end > hit.end)));
  const references = new Map();
  for (const hit of visible) {
    const key = JSON.stringify([hit.input, cardId(hit.card)]);
    let reference = references.get(key);
    if (!reference) {
      reference = { input: hit.input, name: hit.card.name || '', cnName: hit.card.cnName || '',
        jaName: hit.card.jaName || hit.card.jpName || '', enName: hit.card.enName || '',
        aliases: [...(hit.card.aliases || [])], referenceType: 'source_bound_nickname',
        cardId: cardId(hit.card), nicknames: [], sources: [] };
      references.set(key, reference);
    }
    if (!reference.nicknames.includes(hit.alias)) reference.nicknames.push(hit.alias);
    if (!reference.sources.some(source => source.id === String(hit.source.id))) {
      reference.sources.push({ id: String(hit.source.id), url: String(hit.source.url),
        revision: hit.source.revision ?? null, license: hit.source.license ?? null });
    }
  }
  for (const reference of references.values()) {
    referenceBindings.set(reference, { card: byId.get(reference.cardId), query: text,
      canonicalSignature: sourceSignature(byId.get(reference.cardId)), serialized: JSON.stringify(reference) });
  }
  return [...references.values()];
}

function boundReferences(query, cards, references) {
  const byId = indexedCards(cards);
  return (references || []).filter(reference => {
    const binding = referenceBindings.get(reference);
    return binding && binding.query === query && binding.serialized === JSON.stringify(reference)
      && byId.get(reference.cardId) === binding.card
      && sourceSignature(binding.card) === binding.canonicalSignature;
  });
}

// This non-serializable proof only exempts source-bound local resolutions from
// the unrelated fuzzy/edit-distance external-check path. It is not evidence
// of an external identity verification or model correctness.
export function hasSourceBoundNicknameIdentity(card, canonicalCards = []) {
  const binding = resolvedBindings.get(card);
  if (!binding || identitySignature(card) !== binding.resolvedSignature) return false;
  const canonical = indexedCards(canonicalCards).get(binding.cardId);
  return Boolean(canonical && sourceSignature(canonical) === binding.canonicalSignature);
}

export function applyCardNicknameResolution(resolution, { query, cards = [], references = [] } = {}) {
  if (resolution?.mentionSetSource !== 'typed_model') return resolution;
  const text = String(query || ''), refs = boundReferences(text, cards, references);
  if (!refs.length) return resolution;
  const selected = new Map();
  for (const mention of resolution.modelCardNameCandidates || []) {
    const input = String(mention.originalText || '');
    // Do not reinterpret a substring of a longer model-selected name.
    if (!input || !text.includes(input)) continue;
    const candidates = refs.filter(reference => reference.input === input);
    if (!candidates.length) continue;
    const nameKey = normalizeCardKey(mention.name);
    const canonicalMatches = candidates.filter(reference => primaryNames(referenceBindings.get(reference).card)
      .some(name => normalizeCardKey(name) === nameKey));
    const choices = canonicalMatches.length ? canonicalMatches
      : nameKey === normalizeCardKey(input) ? candidates : [];
    if (!choices.length) continue;
    const previous = selected.get(input) || new Map();
    for (const reference of choices) previous.set(reference.cardId, reference);
    selected.set(input, previous);
  }
  if (!selected.size) return resolution;
  let resolvedCards = [...(resolution.resolvedCards || [])];
  let unresolvedMentions = [...(resolution.unresolvedMentions || [])];
  let ambiguousMentions = [...(resolution.ambiguousMentions || [])];
  for (const [input, candidates] of selected) {
    resolvedCards = resolvedCards.filter(card => card.input !== input);
    unresolvedMentions = unresolvedMentions.filter(mention => mention.input !== input);
    ambiguousMentions = ambiguousMentions.filter(mention => mention.input !== input);
    const references = [...candidates.values()];
    const localExact = (cards || []).filter(card => [...primaryNames(card), ...(card.aliases || [])]
      .some(name => normalizeCardKey(name) === normalizeCardKey(input)));
    const conflicts = localExact.filter(card => !candidates.has(cardId(card)));
    if (references.length !== 1 || conflicts.length) {
      ambiguousMentions.push({ input, reason: 'source_bound_nickname_ambiguous', source: 'nickname_reference',
        candidateCards: [...references.map(reference => ({ id: reference.cardId,
          name: reference.cnName || reference.name, source: 'nickname_reference' })),
        ...conflicts.map(card => ({ id: cardId(card), name: card.cnName || card.name,
          source: 'canonical_local_name' }))] });
      continue;
    }
    const reference = references[0], canonical = referenceBindings.get(reference).card;
    const name = primaryNames(canonical)[0];
    const local = extractRagCards(name, { cards: [canonical], mentionSetSource: 'typed_model',
      modelCardNameCandidates: [{ name, originalText: name, confidence: 'high' }] }).resolvedCards[0];
    if (!local || cardId(local) !== reference.cardId) {
      unresolvedMentions.push({ input, reason: 'nickname_canonical_record_unresolved', source: 'nickname_reference' });
      continue;
    }
    const resolved = { ...local, input, resolutionSource: 'nickname_reference',
      nicknameReference: { cardId: reference.cardId, input,
        nicknames: [...reference.nicknames], sources: structuredClone(reference.sources) } };
    resolvedBindings.set(resolved, { cardId: reference.cardId,
      canonicalSignature: sourceSignature(canonical), resolvedSignature: identitySignature(resolved) });
    // Retain an independent full-name mention of the same card only once.
    // Prefer the selected nickname surface so pending mentions reconcile.
    resolvedCards = resolvedCards.filter(card => cardId(card) !== reference.cardId);
    resolvedCards.push(resolved);
  }
  return { ...resolution, resolvedCards, unresolvedMentions, ambiguousMentions };
}
