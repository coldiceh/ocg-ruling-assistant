// Reading-window length measurement policies. Both policies answer the same
// mechanical question ("how many UTF-16 code units does the selection request
// serialize to once these bundles are offered?"); neither inspects meaning.
//
// exact_every_candidate: every admission attempt serializes the whole proposed
// request. This is byte-exact but costs O(candidates x request length); on the
// production 224k window it is 1,300-2,400 whole-request serializations per
// question (3.7-7.0 s per question in the offline replay).
//
// additive_bound_v1: each bundle's standalone contribution is measured once and
// memoized; a proposed set is first bounded by the additive sum. Shared source
// headers, FAQ common fields and the repeated-line dictionary only shrink the
// serialized request, so the sum is an upper bound: anything under the window
// by the bound is admitted without serializing the whole request. Once the
// bound exceeds the window, the whole request is serialized only while the
// learned compaction gain (bound minus exact) could still let the candidate
// fit. The caller verifies the final window once exactly. In the ten-question
// offline replay this admitted the same number of bundles as the exact policy
// and differed by at most one swapped tail bundle, at 15-20x less CPU.
export const READING_MEASURE_CONTRACTS = Object.freeze({
  exact_every_candidate: 'exact-whole-request-per-candidate-v1',
  additive_bound_v1: 'additive-standalone-bound-learned-gain-v1',
});
export const DEFAULT_READING_MEASURE_POLICY = 'additive_bound_v1';

export function resolveReadingMeasurePolicy(value) {
  const policy = String(value || '').trim();
  if (!policy) return DEFAULT_READING_MEASURE_POLICY;
  if (!Object.hasOwn(READING_MEASURE_CONTRACTS, policy)) {
    throw new Error('evidence_reading_measure_policy_invalid');
  }
  return policy;
}

function bundleKey(bundle) {
  // A bundle's contribution depends on which of its entries are still unoffered,
  // so the memo key binds the unit identity to the exact entry identity list.
  return `${bundle.unitKey}\u0000${(bundle.entries || []).map(entry => entry.id).join('\u0001')}`;
}

export function createReadingMeasure({ exactMeasure, maxChars, policy = DEFAULT_READING_MEASURE_POLICY }) {
  if (typeof exactMeasure !== 'function') throw new TypeError('evidence_reading_measure_required');
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new TypeError('evidence_reading_measure_window_invalid');
  const resolved = resolveReadingMeasurePolicy(policy);
  const stats = { policy: resolved, contract: READING_MEASURE_CONTRACTS[resolved],
    wholeRequestMeasures: 0, standaloneMeasures: 0, boundedDecisions: 0, learnedGainChars: 0 };
  if (resolved === 'exact_every_candidate') {
    return { stats, measure(offered) { stats.wholeRequestMeasures++; return exactMeasure(offered); } };
  }
  const standalone = new Map();
  let fixed = null, gain = 0;
  const whole = offered => { stats.wholeRequestMeasures++; return exactMeasure(offered); };
  const standaloneOf = bundle => {
    const key = bundleKey(bundle);
    let size = standalone.get(key);
    if (size === undefined) {
      stats.standaloneMeasures++;
      size = exactMeasure([bundle]) - fixed;
      standalone.set(key, size);
    }
    return size;
  };
  return { stats, measure(offered) {
    if (fixed === null) fixed = whole([]);
    if (!offered.length) return fixed;
    let bound = fixed;
    for (const bundle of offered) bound += standaloneOf(bundle);
    if (bound <= maxChars) { stats.boundedDecisions++; return bound; }
    // The first overflow always serializes once so the compaction gain is
    // observed from a real request rather than assumed.
    if (gain === 0 || bound - gain <= maxChars) {
      const size = whole(offered);
      gain = Math.max(gain, bound - size);
      stats.learnedGainChars = gain;
      return size;
    }
    stats.boundedDecisions++;
    return bound;
  } };
}
