// Source identity, finite queue order and serialized size only. This scheduler
// makes no decision about relevance, completeness or ruling correctness.
export const READING_SCHEDULER_CONTRACT = 'original-support-need-unseen-whole-bundle-v2';
// In effect only when a caller passes priorityLanes (RULE_TOC_ADMIT_ENABLED).
export const READING_SCHEDULER_PRIORITY_CONTRACT = 'priority-whole-unit-then-original-support-need-unseen-whole-bundle-v3';
export const DENSE_MAPPING_ORDER_CONTRACT = 'source-rank-mapping-ordinal-interleave-v1';

export function mapRankedUnits(results, mapResult, limit = 32) {
  const rows = results.map((result, sourceRank) => ({ sourceRank, keys: mapResult(result) || [] }));
  const found = [], seen = new Set();
  for (let mappingOrdinal = 0; rows.some(row => row.keys.length > mappingOrdinal); mappingOrdinal++) {
    for (const row of rows) {
      const unitKey = row.keys[mappingOrdinal];
      if (!unitKey || seen.has(unitKey)) continue;
      seen.add(unitKey);
      found.push({ unitKey, sourceRank: row.sourceRank, mappingOrdinal });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

function node() { return { children: new Map(), cursor: 0 }; }
function descend(parent, key) {
  if (!parent.children.has(key)) parent.children.set(key, node());
  return parent.children.get(key);
}
function nextFromNode(current, getReferences, seen, onVisit) {
  if (current.lane) {
    // Skip exact duplicate identities before yielding this lane's turn.
    // Otherwise a duplicate would advance every ancestor cursor and give a
    // different source/channel the reading opportunity owed to this lane.
    while (true) {
      const hit = nextFromLane(current.lane, getReferences);
      if (!hit) return null;
      onVisit();
      if (!seen.has(hit.unitKey)) return hit;
    }
  }
  const children = [...current.children.values()];
  for (let attempt = 0; attempt < children.length; attempt++) {
    const child = children[current.cursor++ % children.length];
    const candidate = nextFromNode(child, getReferences, seen, onVisit);
    if (candidate) return candidate;
  }
  return null;
}
function nextFromLane(lane, getReferences) {
  const hasOriginal = lane.position < lane.hits.length;
  const hasReference = lane.referencePosition < lane.references.length;
  if (!hasOriginal && !hasReference) return null;
  const useReference = hasReference && (!hasOriginal || lane.referenceTurn);
  lane.referenceTurn = !useReference;
  if (useReference) return lane.references[lane.referencePosition++];
  const hit = { ...lane.meta, ...lane.hits[lane.position++], depth: 0 };
  // Only original hits expand their explicit source links. The prebuilt release
  // resolves links; runtime never interprets a URL or fetches an external page.
  for (const ref of getReferences(hit.unitKey) || []) {
    for (const [targetOrdinal, unitKey] of (ref.targetReadingUnitKeys || []).entries()) {
      if (lane.seenReferences.has(unitKey)) continue;
      lane.seenReferences.add(unitKey);
      lane.references.push({ ...lane.meta, unitKey, sourceRank: hit.sourceRank,
        mappingOrdinal: hit.mappingOrdinal, depth: 1, refKey: ref.refKey,
        linkOrdinal: ref.linkOrdinal, targetOrdinal, fromUnitKey: hit.unitKey });
    }
  }
  return hit;
}

export function createReadingLanes(lanes) {
  const needs = new Map(), allHits = new Map();
  for (const lane of lanes) {
    const { needId, queryVariantId, sourceKind, channel } = lane;
    if (![needId, queryVariantId, sourceKind, channel].every(value => typeof value === 'string' && value)) {
      throw new Error('evidence_reading_lane_identity_invalid');
    }
    if (!needs.has(needId)) needs.set(needId, node());
    const leaf = descend(descend(descend(needs.get(needId), queryVariantId), sourceKind), channel);
    if (leaf.lane) throw new Error('evidence_reading_lane_duplicate');
    const meta = { needId, queryVariantId, sourceKind, channel };
    leaf.lane = { meta, hits: lane.hits, position: 0, references: [], referencePosition: 0,
      referenceTurn: false, seenReferences: new Set() };
    for (const hit of lane.hits) {
      if (!allHits.has(hit.unitKey)) allHits.set(hit.unitKey, []);
      allHits.get(hit.unitKey).push({ ...meta, ...hit, depth: 0 });
    }
  }
  return { needs, allHits };
}

// priorityLanes (optional): finite, already ordered lanes whose hits are each
// offered once, whole, before the rotation below starts. They are measured
// against the same maxChars/maxEntries and, when they do not fit, are recorded
// as omitted with the same reasons. They take no rotation turn and do not
// expand explicit links. Without priorityLanes the v2 assembly is unchanged.
export function admitWholeReadingUnits({ lanes, materialize, measure, maxChars,
  getReferences = () => [], signal, omissionLimit = 24, maxEntries = Infinity, priorityLanes }) {
  if (priorityLanes !== undefined && !Array.isArray(priorityLanes)) {
    throw new Error('evidence_reading_priority_lanes_invalid');
  }
  // Recreate all cursors for every assembly, including a smaller budget retry.
  const state = createReadingLanes(lanes);
  const offered = [], omitted = [], seen = new Set(), offeredIds = new Set();
  // The original question is one independent retrieval scope. Generated needs
  // and card-link lookups share the other scope, so adding more of them cannot
  // multiply their turns at the expense of the original question.
  const original = state.needs.get('original');
  const supporting = node();
  supporting.children = new Map([...state.needs].filter(([id]) => id !== 'original'));
  const turns = [original, supporting].filter(Boolean);
  let visits = 0, measuredChars = measure([]), advanced;
  function admit(hit, admittedBy) {
    const bundle = materialize(hit.unitKey);
    if (!bundle || bundle.unitKey !== hit.unitKey || !Array.isArray(bundle.entries)) {
      throw new Error('evidence_reading_bundle_binding_invalid');
    }
    const entries = bundle.entries.filter(entry => !offeredIds.has(entry.id));
    const proposed = [...offered, { ...bundle, entries, hits: state.allHits.get(hit.unitKey) || [hit],
      ...(admittedBy ? { admittedBy } : {}) }];
    // The entry cap is an exact count, so it is checked before the serialized
    // measurement; a bundle that cannot fit by count is never measured whole.
    const fitsEntries = offeredIds.size + entries.length <= maxEntries;
    const chars = fitsEntries ? measure(proposed) : null;
    if (fitsEntries && chars <= maxChars) {
      offered.push(proposed.at(-1));
      for (const entry of entries) offeredIds.add(entry.id);
      measuredChars = chars;
      return true;
    }
    omitted.push({ unitKey: bundle.unitKey, title: bundle.title || '', sourceKind: bundle.sourceKind,
      size: measure([bundle]), reason: fitsEntries ? 'reading_capacity' : 'selection_choice_capacity', hit });
    return false;
  }
  if (priorityLanes) {
    const priorityHits = [];
    for (const lane of priorityLanes) {
      const { needId, queryVariantId, sourceKind, channel } = lane || {};
      if (![needId, queryVariantId, sourceKind, channel].every(value => typeof value === 'string' && value)
        || !Array.isArray(lane.hits)) throw new Error('evidence_reading_lane_identity_invalid');
      if (state.needs.has(needId)) throw new Error('evidence_reading_lane_duplicate');
      for (const raw of lane.hits) {
        const hit = { needId, queryVariantId, sourceKind, channel, ...raw, depth: 0 };
        priorityHits.push(hit);
        if (!state.allHits.has(hit.unitKey)) state.allHits.set(hit.unitKey, []);
        state.allHits.get(hit.unitKey).push(hit);
      }
    }
    for (const hit of priorityHits) {
      signal?.throwIfAborted();
      visits++;
      if (seen.has(hit.unitKey)) continue;
      seen.add(hit.unitKey);
      admit(hit, hit.channel);
    }
  }
  do {
    advanced = false;
    for (const need of turns) {
      // A duplicate or an oversized item does not consume this need's single
      // successful admission opportunity. Every finite lane entry is visited once.
      while (true) {
        signal?.throwIfAborted();
        const hit = nextFromNode(need, getReferences, seen, () => {
          signal?.throwIfAborted();
          visits++;
        });
        if (!hit) break;
        advanced = true;
        if (seen.has(hit.unitKey)) continue;
        seen.add(hit.unitKey);
        if (admit(hit)) break;
      }
    }
  } while (advanced);
  return { offered, omitted, unread: omitted.slice(0, omissionLimit),
    omittedCount: omitted.length, offeredIds: [...offeredIds], visits, measuredChars,
    contract: priorityLanes ? READING_SCHEDULER_PRIORITY_CONTRACT : READING_SCHEDULER_CONTRACT };
}
