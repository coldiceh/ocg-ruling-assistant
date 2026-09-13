import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBaiModelCost } from '../backend/baiModelPricing.mjs';
import { createCloudRequestBudget, CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE } from '../backend/cloudRequestBudget.mjs';

const usage = {
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  total_tokens: 1_100_000,
  input_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 300_000 },
  output_tokens_details: { reasoning_tokens: 80_000 },
};

test('B.AI standard price cards use canonical model IDs and report estimates', () => {
  const astra = estimateBaiModelCost({ model: 'gpt-6-astra', usage });
  const glm = estimateBaiModelCost({ model: 'glm-5.3', usage });
  const deepseek = estimateBaiModelCost({ model: 'deepseek-v4.1-flash', usage,
    now: new Date('2026-09-14T05:00:00.000Z') });
  assert.equal(astra.model, 'gpt-6-astra');
  assert.equal(astra.inputCostUsd, 5);
  assert.equal(astra.cacheWriteCostUsd, 3.75);
  assert.equal(astra.cachedInputCostUsd, 0.2);
  assert.equal(astra.outputCostUsd, 5);
  assert.equal(astra.totalCostUsd, 13.95);
  assert.equal(glm.totalCostUsd, 1.616);
  assert.equal(deepseek.period, 'idle');
  assert.equal(deepseek.totalCostUsd, 0.1806);
  assert.equal(astra.provider, 'bai');
  assert.equal(astra.priceBasis, 'bai_standard_estimate');
  assert.equal(astra.actualCostKnown, false);
  assert.equal(astra.estimateOnly, true);
});

test('DeepSeek busy windows are half-open in Asia/Shanghai', () => {
  const at = (utc) => estimateBaiModelCost({ model: 'deepseek-v4.1-flash', usage: { input_tokens: 1 }, now: new Date(utc) });
  assert.equal(at('2026-09-14T00:59:59.000Z').period, 'idle'); // 08:59:59
  assert.equal(at('2026-09-14T01:00:00.000Z').period, 'busy'); // 09:00
  assert.equal(at('2026-09-14T03:00:00.000Z').period, 'busy'); // 11:00
  assert.equal(at('2026-09-14T03:59:59.000Z').period, 'busy');
  assert.equal(at('2026-09-14T04:00:00.000Z').period, 'idle'); // 12:00
  assert.equal(at('2026-09-14T05:59:59.000Z').period, 'idle'); // 13:59:59
  assert.equal(at('2026-09-14T06:00:00.000Z').period, 'busy'); // 14:00
  assert.equal(at('2026-09-14T10:00:00.000Z').period, 'idle'); // 18:00
  assert.equal(at('2026-09-13T01:00:00.000Z').period, 'idle'); // Sunday
});

test('cache input, cache write, and uncached input are mutually exclusive', () => {
  const result = estimateBaiModelCost({ model: 'glm-5.3', usage });
  assert.deepEqual(result.usageBuckets, {
    inputTokens: 1_000_000,
    uncachedInputTokens: 500_000,
    cacheWriteTokens: 300_000,
    cachedInputTokens: 200_000,
    outputTokens: 100_000,
    reasoningTokens: 80_000,
    totalTokens: 1_100_000,
  });
  assert.equal(result.usageBuckets.uncachedInputTokens
    + result.usageBuckets.cacheWriteTokens
    + result.usageBuckets.cachedInputTokens, result.usageBuckets.inputTokens);
  assert.equal(result.reasoningCostUsd, 0);
});

test('reservation uses cache-write price for all input and full output', () => {
  const actual = estimateBaiModelCost({ model: 'gpt-6-astra', usage, now: new Date('2026-09-14T01:00:00Z') });
  const reserved = estimateBaiModelCost({ model: 'gpt-6-astra', usage, now: new Date('2026-09-14T01:00:00Z'), reserve: true });
  assert.equal(reserved.inputCostUsd, 0);
  assert.equal(reserved.cachedInputCostUsd, 0);
  assert.equal(reserved.cacheWriteCostUsd, 12.5);
  assert.equal(reserved.outputCostUsd, actual.outputCostUsd);
  assert.equal(reserved.totalCostUsd, 17.5);
  assert.equal(reserved.billedUsage.cacheWriteTokens, usage.input_tokens);
});

test('DeepSeek reservation is fixed to busy price even during idle hours', () => {
  const result = estimateBaiModelCost({ model: 'deepseek-v4.1-flash', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    now: new Date('2026-09-14T05:00:00Z'), reserve: true });
  assert.equal(result.actualPeriod, 'idle');
  assert.equal(result.period, 'busy');
  assert.equal(result.totalCostUsd, 1.5);
});

test('B.AI budget stage is carried into the ticket and auxiliary calls stay out of final ruling', async () => {
  const calls = [];
  const env = {
    CLOUD_BUDGET_RUN_ID: 'bai-stage-test',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '1',
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '5',
    CLOUD_BUDGET_PERIOD: 'daily',
    API_BUDGET_TIMEZONE: 'Asia/Shanghai',
    RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1',
  };
  const budget = createCloudRequestBudget({
    env,
    now: new Date('2026-09-14T05:00:00.000Z'),
    command: async (command) => {
      calls.push(command);
      return [command[1] === CLOUD_BUDGET_RESERVE ? 'reserved' : 'settled'];
    },
  });
  await budget.bai({
    body: { model: 'glm-5.3', messages: [{ role: 'user', content: 'auxiliary' }], max_completion_tokens: 64 },
    stage: 'evidence_preparation',
    invoke: async () => ({ model: 'glm-5.3', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }),
  });
  assert.equal(calls.length, 2);
  const ticket = JSON.parse(calls[0][11]);
  assert.equal(ticket.provider, 'bai');
  assert.equal(ticket.stage, 'evidence_preparation');
  assert.equal(calls[0][3], 'ruling-cloud-budget:v1:bai-stage-test:2026-09-14');
  assert.equal(calls[1][1], CLOUD_BUDGET_SETTLE);
  assert.equal(budget.snapshot().calls[0].stage, 'evidence_preparation');
});
