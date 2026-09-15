// Source identity, finite queue order and serialized size only. This scheduler
// makes no decision about relevance, completeness or ruling correctness.
export const READING_SCHEDULER_CONTRACT = 'need-variant-source-channel-whole-bundle-v1';
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
function nextFromNode(current, getReferences) {
  if (current.lane) return nextFromLane(current.lane, getReferences);
  const children = [...current.children.values()];
  for (let attempt = 0; attempt < children.length; attempt++) {
    const child = children[current.cursor++ % children.length];
    const candidate = nextFromNode(child, getReferences);
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

export function admitWholeReadingUnits({ lanes, materialize, measure, maxChars,
  getReferences = () => [], signal, omissionLimit = 24 }) {
  // Recreate all cursors for every assembly, including a smaller budget retry.
  const state = createReadingLanes(lanes);
  const offered = [], omitted = [], seen = new Set(), offeredIds = new Set();
  let visits = 0, measuredChars = measure([]), advanced;
  do {
    advanced = false;
    for (const need of state.needs.values()) {
      // A duplicate or an oversized item does not consume this need's single
      // successful admission opportunity. Every finite lane entry is visited once.
      while (true) {
        signal?.throwIfAborted();
        const hit = nextFromNode(need, getReferences);
        if (!hit) break;
        advanced = true; visits++;
        if (seen.has(hit.unitKey)) continue;
        seen.add(hit.unitKey);
        const bundle = materialize(hit.unitKey);
        if (!bundle || bundle.unitKey !== hit.unitKey || !Array.isArray(bundle.entries)) {
          throw new Error('evidence_reading_bundle_binding_invalid');
        }
        const entries = bundle.entries.filter(entry => !offeredIds.has(entry.id));
        const proposed = [...offered, { ...bundle, entries, hits: state.allHits.get(hit.unitKey) || [hit] }];
        const chars = measure(proposed);
        if (chars <= maxChars) {
          offered.push(proposed.at(-1));
          for (const entry of entries) offeredIds.add(entry.id);
          measuredChars = chars;
          break;
        }
        omitted.push({ unitKey: bundle.unitKey, title: bundle.title || '', sourceKind: bundle.sourceKind,
          size: measure([bundle]), reason: 'reading_capacity', hit });
      }
    }
  } while (advanced);
  return { offered, omitted, unread: omitted.slice(0, omissionLimit),
    omittedCount: omitted.length, offeredIds: [...offeredIds], visits, measuredChars,
    contract: READING_SCHEDULER_CONTRACT };
}
