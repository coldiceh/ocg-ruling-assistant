import test from 'node:test';
import assert from 'node:assert/strict';
import { rankReadingCandidates, mapRankedUnits, admitWholeReadingUnits as rrf,
  READING_SCHEDULER_CONTRACT, READING_SCHEDULER_PRIORITY_CONTRACT } from '../backend/evidenceReadingRrfScheduler.mjs';

const lane = (keys, { needId = 'original', variant = needId, kind = 'rule', channel = 'lexical' } = {}) => ({
  needId, queryVariantId: variant, sourceKind: kind, channel,
  hits: keys.map((unitKey, sourceRank) => ({ unitKey, sourceRank, mappingOrdinal: 0 })),
});
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const measure = offered => 10 + offered.reduce((sum, bundle) => sum + bundle.entries.reduce((n, e) => n + e.size, 0), 0);
const materializer = (sizes = {}) => key => ({ unitKey: key, title: key, sourceKind: 'rule',
  entries: [{ id: key, size: sizes[key] || 10, text: `whole:${key}` }] });
const keys = result => result.offered.map(x => x.unitKey);
const run = (scheduler, options) => scheduler({ materialize: materializer(), measure, maxChars: 1000, ...options });

test('mapping remains round robin over parent mappings with identity deduplication', () => {
  assert.deepEqual(mapRankedUnits(['a', 'b'], x => x === 'a' ? ['x', 'y'] : ['z', 'x']), [
    { unitKey: 'x', sourceRank: 0, mappingOrdinal: 0 },
    { unitKey: 'z', sourceRank: 1, mappingOrdinal: 0 },
    { unitKey: 'y', sourceRank: 0, mappingOrdinal: 1 },
  ]);
});

for (const [name, scheduler] of [['rrf', rrf]]) {
  test(`${name}: finite original and one-level references are preserved, inputs untouched`, () => {
    const lanes = freeze([lane(['a', 'a', 'd']), lane(['d', 'e'], { needId: 'n1' })]);
    const before = JSON.stringify(lanes), called = [];
    const refs = key => { called.push(key); return ({
      a: [{ refKey: 'r1', targetReadingUnitKeys: ['b', 'a', 'b'] }],
      b: [{ refKey: 'r2', targetReadingUnitKeys: ['must-not-expand'] }],
    })[key] || []; };
    const result = run(scheduler, { lanes, getReferences: refs });
    assert.deepEqual(new Set(keys(result)), new Set(['a', 'b', 'd', 'e']));
    assert.equal(keys(result).length, 4);
    assert.deepEqual(new Set(called), new Set(['a', 'd', 'e']));
    assert.equal(called.length, 3);
    assert.equal(JSON.stringify(lanes), before);
    assert.equal(result.offeredIds.length, new Set(result.offeredIds).size);
    assert.equal(result.omittedCount, 0);
    assert.ok(result.visits <= 12);
    assert.ok(result.offered.find(x => x.unitKey === 'b').hits.some(x => x.depth === 1 && x.fromUnitKey === 'a'));
  });

  test(`${name}: oversized first candidate does not stop scanning or partially admit`, () => {
    const result = run(scheduler, { lanes: [lane(['large', 'small', 'tail'])],
      materialize: materializer({ large: 1000, small: 20, tail: 30 }), maxChars: 65 });
    assert.deepEqual(new Set(keys(result)), new Set(['small', 'tail']));
    assert.equal(result.measuredChars, 60);
    assert.equal(result.omitted.length, 1);
    assert.equal(result.omitted[0].unitKey, 'large');
    assert.equal(result.omitted[0].reason, 'reading_capacity');
  });

  test(`${name}: shared entry identity deduplicates and required contexts stay whole`, () => {
    const materialize = key => ({ unitKey: key, entries: freeze([
      { id: key, size: 20, text: `whole:${key}` }, { id: 'shared-context', size: 20, text: 'whole context' },
    ]) });
    const result = run(scheduler, { lanes: [lane(['a', 'b'])], materialize, maxChars: 70 });
    assert.equal(result.offered.length, 2);
    assert.deepEqual(new Set(result.offeredIds), new Set(['a', 'b', 'shared-context']));
    assert.equal(result.measuredChars, 70);
    const tight = run(scheduler, { lanes: [lane(['a'])], materialize, maxChars: 49 });
    assert.equal(tight.offered.length, 0);
    assert.equal(tight.omittedCount, 1);
  });

  test(`${name}: entry cap cannot split a bundle; later independent unit can fit`, () => {
    const materialize = key => ({ unitKey: key, entries: key === 'pair'
      ? [{ id: 'p', size: 5 }, { id: 'q', size: 5 }] : [{ id: key, size: 5 }] });
    const result = run(scheduler, { lanes: [lane(['pair', 'single'])], materialize, maxEntries: 1 });
    assert.deepEqual(keys(result), ['single']);
    assert.equal(result.omitted[0].reason, 'selection_choice_capacity');
  });

  test(`${name}: priority order is retained, duplicate identities are not reoffered`, () => {
    const result = run(scheduler, { lanes: [lane(['a', 'b'])],
      priorityLanes: [lane(['b', 'p'], { needId: 'priority', channel: 'toc' })] });
    assert.deepEqual(keys(result).slice(0, 2), ['b', 'p']);
    assert.equal(keys(result).filter(x => x === 'b').length, 1);
    assert.equal(result.offered[0].admittedBy, 'toc');
  });

  test(`${name}: omissionLimit and cancellation remain effective`, () => {
    const result = run(scheduler, { lanes: [lane(['a', 'b', 'c'])], maxChars: 10, omissionLimit: 1 });
    assert.equal(result.omittedCount, 3);
    assert.equal(result.unread.length, 1);
    assert.equal(result.measuredChars, 10);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    assert.throws(() => run(scheduler, { lanes: [lane(['a'])], signal: controller.signal }), /cancelled/);
  });
}

test('one vote per unit per lane and duplicate lane identities are rejected', () => {
  const one = rankReadingCandidates({ lanes: [lane(['a', 'a', 'b'])] });
  assert.equal(one.candidates.get('a').rawScore, 1 / 61);
  assert.equal(one.candidates.get('b').rawScore, 1 / 62);
  assert.throws(() => rankReadingCandidates({ lanes: [lane(['a']), lane(['b'])] }), /lane_duplicate/);
});

test('multi-lane RRF votes outrank single-lane hits with deterministic encounter-order ties', () => {
  const lanes = [lane(['z', 'shared', 'a']), lane(['b', 'shared', 'c'], { channel: 'dense' })];
  const result = run(rrf, { lanes });
  assert.deepEqual(keys(result), ['shared', 'z', 'b', 'a', 'c']);
  assert.equal(result.contract, READING_SCHEDULER_CONTRACT);
  assert.deepEqual(result.ranking, { arm: 'rrf', k: 60, candidateCount: 5,
    rankBasis: 'one-based-deduplicated-expanded-lane-position' });
});

test('rank counts deduplicated alternating source links, preserving their provenance', () => {
  const getReferences = key => key === 'a'
    ? [{ refKey: 'source-link', linkOrdinal: 3, targetReadingUnitKeys: ['b', 'b', 'c'] }] : [];
  const result = rankReadingCandidates({ lanes: [lane(['a', 'a', 'd'])], getReferences });
  assert.deepEqual(result.ranked.map(row => row.unitKey), ['a', 'b', 'c', 'd']);
  assert.equal(result.candidates.get('c').rawScore, 1 / 63);
  assert.deepEqual(result.candidates.get('c').hits[0], {
    needId: 'original', queryVariantId: 'original', sourceKind: 'rule', channel: 'lexical',
    unitKey: 'c', sourceRank: 0, mappingOrdinal: 0, depth: 1,
    refKey: 'source-link', linkOrdinal: 3, targetOrdinal: 2, fromUnitKey: 'a',
  });
});

test('priority-only candidates do not expand links and share the normal hard capacity', () => {
  const called = [];
  const result = run(rrf, { lanes: [lane(['a', 'b'])], maxChars: 30,
    priorityLanes: [lane(['p'], { needId: 'priority', channel: 'toc' })],
    getReferences: key => { called.push(key); return []; } });
  assert.deepEqual(keys(result), ['p', 'a']);
  assert.deepEqual(called, ['a', 'b']);
  assert.equal(result.omitted[0].unitKey, 'b');
  assert.equal(result.contract, READING_SCHEDULER_PRIORITY_CONTRACT);
});

test('invalid source identity and bundle binding fail before admission', () => {
  assert.throws(() => run(rrf, { lanes: [{ ...lane(['a']), hits: null }] }), /lane_identity_invalid/);
  assert.throws(() => run(rrf, { lanes: [lane([''])] }), /lane_identity_invalid/);
  assert.throws(() => run(rrf, { lanes: [lane(['a'])], materialize: () => ({ unitKey: 'other', entries: [] }) }), /bundle_binding_invalid/);
  assert.throws(() => run(rrf, { lanes: [lane(['a'])], priorityLanes: {} }), /priority_lanes_invalid/);
  assert.throws(() => run(rrf, { lanes: [lane(['a'])], priorityLanes: [lane(['p'])] }), /lane_duplicate/);
});
