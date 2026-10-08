import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudRequestBudget } from '../backend/cloudRequestBudget.mjs';

const env = { CLOUD_BUDGET_RUN_ID: 'synthetic-deadline', CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '0',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '1', UPSTASH_BUDGET_KV_REST_API_URL: 'https://budget.invalid',
  UPSTASH_BUDGET_KV_REST_API_TOKEN: 'synthetic-token' };
const body = { model: 'gpt-6-luna', input: 'Synthetic source.', questions: [{ type: 'choice',
  name: 'source', instructions: 'Choose source.', choices: [{ value: 'A' }, { value: 'UNKNOWN' }] }] };

for (const trigger of ['store timeout', 'parent cancellation']) {
  test(`a parent signal preserves the five-second store deadline and ${trigger}`, async t => {
    const parent = new AbortController(), deadline = new AbortController();
    const durations = [];
    t.mock.method(AbortSignal, 'timeout', milliseconds => { durations.push(milliseconds); return deadline.signal; });
    let requestSignal, providerCalls = 0;
    const budget = createCloudRequestBudget({ env, fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        if (requestSignal.aborted) reject(requestSignal.reason);
        else requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      });
    } });
    const result = budget.decisions({ body, signal: parent.signal,
      invoke: async () => { providerCalls += 1; throw new Error('must not dispatch'); } });
    const settled = result.then(value => ({ value }), error => ({ error }));
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(durations, [5000]);
      assert.notEqual(requestSignal, parent.signal);
      const reason = new Error(`synthetic ${trigger}`);
      (trigger === 'store timeout' ? deadline : parent).abort(reason);
      assert.equal((await settled).error, reason);
      assert.equal(providerCalls, 0);
      assert.equal(trigger === 'store timeout' ? parent.signal.aborted : deadline.signal.aborted, false);
    } finally {
      parent.abort(new Error('test cleanup'));
      await settled;
    }
  });
}
