import test from 'node:test';
import assert from 'node:assert/strict';
import { getRagBudgetStatus } from '../backend/ragModelClient.mjs';

const env = {
  RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1', CLOUD_BUDGET_PERIOD: 'daily',
  CLOUD_BUDGET_RUN_ID: 'production_test', CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '10',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '10',
  API_BUDGET_TIMEZONE: 'Asia/Shanghai', API_DAILY_BUDGET_CNY: '10',
  UPSTASH_REDIS_REST_URL: 'https://budget.example.test', UPSTASH_REDIS_REST_TOKEN: 'synthetic',
};

function storage(entries = []) {
  const commands = [];
  return { commands, fetchImpl: async (_url, options) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    const result = command[0] === 'HGETALL' ? entries
      : command[0] === 'GET' ? null
      : command[0] === 'EVAL' && command[3].endsWith(':final_ruling:relay:usd') ? '0.25' : '0';
    return new Response(JSON.stringify({ result }));
  } };
}

test('public daily budget reads actual SiliconFlow tickets and keeps ChatGPT theoretical USD separate', async () => {
  const redis = storage([
    'actualNano', '400000000', 'theoreticalNano', '250000000',
    'sf-settled', JSON.stringify({provider:'siliconflow',status:'usage_settled',actualNano:12000000}),
    'sf-pending', JSON.stringify({provider:'siliconflow',status:'reserved',actualNano:1000000}),
    'relay', JSON.stringify({provider:'relay',status:'usage_settled',actualNano:300000000,theoreticalNano:250000000}),
  ]);
  const status = await getRagBudgetStatus({ env, now:new Date('2026-09-08T16:00:01Z'), fetchImpl:redis.fetchImpl });
  const evidence = status.buckets.find(item => item.id === 'evidence_preparation:siliconflow');
  assert.ok(evidence, 'the retired DeepSeek preparation bucket must be replaced');
  assert.equal(evidence.label, 'Qwen3 资料检索（硅基流动）');
  assert.equal(evidence.spentTodayCny, 0.013);
  assert.equal(evidence.dailyBudgetCny, 10);
  assert.equal(evidence.reservedTodayCny, 0.001);
  assert.equal(status.buckets.some(item => item.id === 'evidence_preparation:deepseek'), false);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:relay').spentTodayUsd, 0.25);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:relay').dailyBudgetUsd, 10);
  assert.match(status.buckets.find(item => item.id === 'final_ruling:relay').label,/共享/);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:deepseek').dailyBudgetCny, 10);
  assert.deepEqual(redis.commands.filter(command => command[0] === 'HGETALL'),
    [['HGETALL', 'ruling-cloud-budget:v1:production_test:2026-09-09']]);
});

test('a new calendar day shows zero from its own empty ledger without resetting history', async () => {
  const redis = storage();
  const status = await getRagBudgetStatus({ env, now:new Date('2026-09-09T16:00:01Z'), fetchImpl:redis.fetchImpl });
  const evidence = status.buckets.find(item => item.id === 'evidence_preparation:siliconflow');
  assert.equal(evidence?.spentTodayCny, 0);
  assert.equal(evidence?.dailyBudgetCny, 10);
  assert.deepEqual(redis.commands.filter(command => command[0] === 'HGETALL'),
    [['HGETALL', 'ruling-cloud-budget:v1:production_test:2026-09-10']]);
  assert.equal(redis.commands.some(command => command[0] === 'DEL'), false);
});
