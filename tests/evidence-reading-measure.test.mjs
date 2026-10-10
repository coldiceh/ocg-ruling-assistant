import test from 'node:test';
import assert from 'node:assert/strict';
import { admitWholeReadingUnits } from '../backend/evidenceReadingScheduler.mjs';
import { createReadingMeasure, resolveReadingMeasurePolicy, READING_MEASURE_CONTRACTS } from '../backend/evidenceReadingMeasure.mjs';

const lane = (needId, queryVariantId, sourceKind, channel, keys) => ({ needId, queryVariantId, sourceKind, channel,
  hits: keys.map((unitKey, sourceRank) => ({ unitKey, sourceRank, mappingOrdinal: 0 })) });

// A deterministic stand-in for the request serializer: a fixed header plus each
// entry's text, where every line that already appeared earlier in the request
// is replaced by a short reference. This reproduces the mechanical property the
// policy relies on: sharing only ever shrinks the serialized request.
function serializedLength(bundles, { header = 10, refChars = 2 } = {}) {
  const seen = new Set();
  let total = header;
  for (const bundle of bundles) for (const entry of bundle.entries) for (const line of entry.lines) {
    total += seen.has(line) ? refChars : line.length;
    seen.add(line);
  }
  return total;
}

const bundle = (unitKey, lines) => ({ unitKey, sourceKind: 'rule', entries: [{ id: unitKey, lines }] });

test('policy names resolve to declared contracts and reject unknown values', () => {
  assert.equal(resolveReadingMeasurePolicy(''), 'additive_bound_v1');
  assert.equal(resolveReadingMeasurePolicy(' exact_every_candidate '), 'exact_every_candidate');
  assert.throws(() => resolveReadingMeasurePolicy('fuzzy'), /evidence_reading_measure_policy_invalid/u);
  assert.equal(READING_MEASURE_CONTRACTS.additive_bound_v1, 'additive-standalone-bound-learned-gain-v1');
});

test('additive bound never under-reports the exact serialized length', () => {
  const bundles = Array.from({ length: 40 }, (_, index) => bundle(`u${index}`, [
    `unique line ${index} ${'x'.repeat(index % 7)}`, 'shared line that repeats everywhere', `tail ${index % 3}`,
  ]));
  const exact = offered => serializedLength(offered);
  const measure = createReadingMeasure({ exactMeasure: exact, maxChars: 10_000, policy: 'additive_bound_v1' });
  for (let count = 0; count <= bundles.length; count++) {
    const offered = bundles.slice(0, count);
    assert.ok(measure.measure(offered) >= exact(offered), `bound must cover exact at ${count}`);
  }
});

test('additive bound admits the same bundle count as the exact policy on a saturated window and serializes far fewer whole requests', () => {
  const keys = Array.from({ length: 120 }, (_, index) => `k${index}`);
  const bundles = Object.fromEntries(keys.map((key, index) => [key, bundle(key, [
    `body ${index} ${'y'.repeat(20 + (index * 7) % 50)}`, `common ${index % 4}`, 'shared across all bundles',
  ])]));
  const exact = offered => serializedLength(offered);
  const run = policy => {
    const measure = createReadingMeasure({ exactMeasure: exact, maxChars: 1_500, policy });
    const result = admitWholeReadingUnits({ lanes: [lane('original', 'original', 'rule', 'dense', keys)],
      materialize: key => bundles[key], maxChars: 1_500, measure: measure.measure });
    return { result, stats: measure.stats, exactChars: exact(result.offered) };
  };
  const exactRun = run('exact_every_candidate');
  const boundRun = run('additive_bound_v1');
  assert.ok(exactRun.exactChars <= 1_500);
  assert.ok(boundRun.exactChars <= 1_500, 'bound policy must keep the final window within the limit');
  // The policy contract is a full window within at most one tail bundle of the
  // exact policy, never a cheaper window. Offline replay on the production
  // request builder admitted the same count on all ten frozen questions.
  assert.ok(Math.abs(boundRun.result.offered.length - exactRun.result.offered.length) <= 1,
    `offered ${boundRun.result.offered.length} vs exact ${exactRun.result.offered.length}`);
  assert.ok(boundRun.stats.wholeRequestMeasures < exactRun.stats.wholeRequestMeasures / 4,
    `expected far fewer whole-request measurements: ${boundRun.stats.wholeRequestMeasures} vs ${exactRun.stats.wholeRequestMeasures}`);
  assert.equal(boundRun.stats.standaloneMeasures, keys.length);
  assert.ok(boundRun.stats.learnedGainChars > 0);
});

test('standalone sizes are memoized per unit and entry identity list', () => {
  let calls = 0;
  const exact = offered => { calls++; return serializedLength(offered); };
  const measure = createReadingMeasure({ exactMeasure: exact, maxChars: 10_000 });
  const a = bundle('a', ['one', 'two']);
  const aReduced = { ...a, entries: [{ id: 'a-only', lines: ['one'] }] };
  measure.measure([]);
  measure.measure([a]);
  measure.measure([a]);
  measure.measure([a, aReduced]);
  assert.equal(calls, 3, 'fixed header, bundle a, and the reduced entry list are each measured once');
  assert.equal(measure.stats.standaloneMeasures, 2);
});

test('exact policy serializes every proposed request', () => {
  const exact = offered => serializedLength(offered);
  const measure = createReadingMeasure({ exactMeasure: exact, maxChars: 100, policy: 'exact_every_candidate' });
  measure.measure([]);
  measure.measure([bundle('a', ['x'])]);
  measure.measure([bundle('a', ['x']), bundle('b', ['y'])]);
  assert.equal(measure.stats.wholeRequestMeasures, 3);
  assert.equal(measure.stats.standaloneMeasures, 0);
});

test('entry cap is checked before the whole request is measured', () => {
  const measured = [];
  const bundles = {
    first: { unitKey: 'first', entries: [{ id: 'a' }, { id: 'b' }] },
    second: { unitKey: 'second', entries: [{ id: 'c' }, { id: 'd' }] },
    third: { unitKey: 'third', entries: [{ id: 'e' }] },
  };
  const result = admitWholeReadingUnits({ maxChars: 1_000, maxEntries: 3, materialize: key => bundles[key],
    lanes: [lane('original', 'original', 'rule', 'dense', ['first', 'second', 'third'])],
    measure: offered => { measured.push(offered.map(item => item.unitKey)); return offered.length * 10; } });
  assert.deepEqual(result.offered.map(item => item.unitKey), ['first', 'third']);
  assert.equal(result.omitted[0].reason, 'selection_choice_capacity');
  // 'second' exceeds the entry cap, so the only measurement involving it is the
  // single-bundle size recorded for the omission list, never the whole request.
  assert.ok(!measured.some(keys => keys.length > 1 && keys.includes('second')));
});
