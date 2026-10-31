// Rank source identities by their retrieval positions; no semantic decisions.
import { createReadingLanes } from './evidenceReadingScheduler.mjs';
export { createReadingLanes, mapRankedUnits, DENSE_MAPPING_ORDER_CONTRACT } from './evidenceReadingScheduler.mjs';

export const READING_SCHEDULER_CONTRACT = 'rrf-whole-bundle-v1';
export const READING_SCHEDULER_PRIORITY_CONTRACT = 'priority-rrf-whole-bundle-v1';
export const RRF_K = 60;

function expandedLane(lane, getReferences, signal) {
  const { needId, queryVariantId, sourceKind, channel } = lane;
  const meta = { needId, queryVariantId, sourceKind, channel };
  const references = [], seenReferences = new Set(), seen = new Set(), rows = [];
  let position = 0, referencePosition = 0, referenceTurn = false;
  while (position < lane.hits.length || referencePosition < references.length) {
    signal?.throwIfAborted();
    const useReference = referencePosition < references.length
      && (position >= lane.hits.length || referenceTurn);
    referenceTurn = !useReference;
    let hit;
    if (useReference) hit = references[referencePosition++];
    else {
      hit = { ...meta, ...lane.hits[position++], depth: 0 };
      // Only original hits expand their already-resolved explicit links.
      for (const ref of getReferences(hit.unitKey) || []) {
        for (const [targetOrdinal, unitKey] of (ref.targetReadingUnitKeys || []).entries()) {
          if (seenReferences.has(unitKey)) continue;
          seenReferences.add(unitKey);
          references.push({ ...meta, unitKey, sourceRank: hit.sourceRank,
            mappingOrdinal: hit.mappingOrdinal, depth: 1, refKey: ref.refKey,
            linkOrdinal: ref.linkOrdinal, targetOrdinal, fromUnitKey: hit.unitKey });
        }
      }
    }
    if (!seen.has(hit.unitKey)) {
      seen.add(hit.unitKey);
      rows.push({ hit, rank: rows.length + 1 });
    }
  }
  return rows;
}

export function rankReadingCandidates({ lanes, getReferences = () => [], signal }) {
  for (const lane of lanes) {
    if (!Array.isArray(lane?.hits)
      || lane.hits.some(hit => typeof hit?.unitKey !== 'string' || !hit.unitKey)) {
      throw new Error('evidence_reading_lane_identity_invalid');
    }
  }
  const validation = createReadingLanes(lanes), candidates = new Map(), referencesCache = new Map();
  const refs = key => {
    if (!referencesCache.has(key)) referencesCache.set(key, getReferences(key) || []);
    return referencesCache.get(key);
  };
  for (const lane of lanes) for (const { hit, rank } of expandedLane(lane, refs, signal)) {
    let entry = candidates.get(hit.unitKey);
    if (!entry) {
      entry = { unitKey: hit.unitKey, ordinal: candidates.size, hits: [], rawScore: 0 };
      candidates.set(hit.unitKey, entry);
    }
    entry.hits.push(hit);
    // One contribution per identity in each deduplicated, expanded lane.
    entry.rawScore += 1 / (RRF_K + rank);
  }
  const ranked = [...candidates.values()].sort((a, b) => b.rawScore - a.rawScore
    || a.ordinal - b.ordinal || a.unitKey.localeCompare(b.unitKey));
  return { ranked, candidates, originalNeeds: validation.needs };
}

export function admitWholeReadingUnits({ lanes, materialize, measure, maxChars,
  getReferences = () => [], signal, omissionLimit = 24, maxEntries = Infinity, priorityLanes }) {
  if (priorityLanes !== undefined && !Array.isArray(priorityLanes)) {
    throw new Error('evidence_reading_priority_lanes_invalid');
  }
  const state = rankReadingCandidates({ lanes, getReferences, signal });
  const offered = [], omitted = [], seen = new Set(), offeredIds = new Set();
  let visits = 0, measuredChars = measure([]);
  function attempt(hit, admittedBy) {
    signal?.throwIfAborted();
    visits++;
    if (seen.has(hit.unitKey)) return;
    const bundle = materialize(hit.unitKey);
    if (!bundle || bundle.unitKey !== hit.unitKey || !Array.isArray(bundle.entries)) {
      throw new Error('evidence_reading_bundle_binding_invalid');
    }
    const entries = bundle.entries.filter(entry => !offeredIds.has(entry.id));
    const proposed = [...offered, { ...bundle, entries, hits: state.candidates.get(hit.unitKey)?.hits || [hit],
      ...(admittedBy ? { admittedBy } : {}) }];
    const fitsEntries = offeredIds.size + entries.length <= maxEntries;
    const chars = fitsEntries ? measure(proposed) : null;
    seen.add(hit.unitKey);
    if (fitsEntries && chars <= maxChars) {
      offered.push(proposed.at(-1));
      for (const entry of entries) offeredIds.add(entry.id);
      measuredChars = chars;
      return;
    }
    omitted.push({ unitKey: bundle.unitKey, title: bundle.title || '', sourceKind: bundle.sourceKind,
      size: measure([bundle]), reason: fitsEntries ? 'reading_capacity' : 'selection_choice_capacity', hit });
  }
  // Caller priority lanes keep their finite order and do not expand references.
  if (priorityLanes) {
    for (const lane of priorityLanes) {
      const { needId, queryVariantId, sourceKind, channel } = lane || {};
      if (![needId, queryVariantId, sourceKind, channel].every(value => typeof value === 'string' && value)
        || !Array.isArray(lane.hits)) throw new Error('evidence_reading_lane_identity_invalid');
      if (state.originalNeeds.has(needId)) throw new Error('evidence_reading_lane_duplicate');
      for (const raw of lane.hits) {
        const hit = { needId, queryVariantId, sourceKind, channel, ...raw, depth: 0 };
        const existing = state.candidates.get(hit.unitKey);
        if (existing) existing.hits.push(hit);
        attempt(hit, channel);
      }
    }
  }
  for (const row of state.ranked) if (!seen.has(row.unitKey)) attempt(row.hits[0], 'rrf');
  return { offered, omitted, unread: omitted.slice(0, omissionLimit), omittedCount: omitted.length,
    offeredIds: [...offeredIds], visits, measuredChars,
    contract: priorityLanes ? READING_SCHEDULER_PRIORITY_CONTRACT : READING_SCHEDULER_CONTRACT,
    ranking: { arm: 'rrf', k: RRF_K, candidateCount: state.ranked.length,
      rankBasis: 'one-based-deduplicated-expanded-lane-position' } };
}
