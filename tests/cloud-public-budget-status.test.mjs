import test from 'node:test';
import assert from 'node:assert/strict';
import { getRagBudgetStatus } from '../backend/ragModelClient.mjs';
import { PUBLIC_FINAL_BUDGET_LUA } from '../backend/cloudFinalBudget.mjs';

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
    if (command[1] === PUBLIC_FINAL_BUDGET_LUA) return Response.json({result:[JSON.stringify({
      relay:{spent:entries.length ? 250000000 : 0,reserved:0,legacy:0,accounted:entries.length ? 250000000 : 0},
      bai:{spent:0,reserved:0,legacy:0,accounted:0},closed:false,
    })]});
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
    'relay', JSON.stringify({provider:'relay',stage:'final_ruling',status:'usage_settled',actualNano:300000000,theoreticalNano:250000000}),
  ]);
  const status = await getRagBudgetStatus({ env, now:new Date('2026-09-08T16:00:01Z'), fetchImpl:redis.fetchImpl });
  const evidence = status.buckets.find(item => item.id === 'evidence_preparation:deepseek');
  assert.ok(evidence, 'the selected DeepSeek preparation bucket must be present');
  assert.equal(evidence.label, 'DeepSeek 与硅基流动资料准备');
  assert.equal(evidence.spentTodayCny, 0.013);
  assert.equal(evidence.dailyBudgetCny, 10);
  assert.equal(evidence.reservedTodayCny, 0.001);
  assert.equal(status.buckets.some(item => item.id === 'evidence_preparation:siliconflow'), false);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:relay').spentTodayUsd, 0.25);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:relay').dailyBudgetUsd, 10);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:relay').label,'中转 GPT 最终裁定');
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:bai').spentTodayUsd,0);
  assert.equal(status.buckets.find(item => item.id === 'final_ruling:deepseek').dailyBudgetCny, 10);
  assert.deepEqual(redis.commands.filter(command => command[0] === 'HGETALL'),
    [['HGETALL', 'ruling-cloud-budget:v1:production_test:2026-09-09']]);
});

test('a new calendar day shows zero from its own empty ledger without resetting history', async () => {
  const redis = storage();
  const status = await getRagBudgetStatus({ env, now:new Date('2026-09-09T16:00:01Z'), fetchImpl:redis.fetchImpl });
  const evidence = status.buckets.find(item => item.id === 'evidence_preparation:deepseek');
  assert.equal(evidence?.spentTodayCny, 0);
  assert.equal(evidence?.dailyBudgetCny, 10);
  assert.deepEqual(redis.commands.filter(command => command[0] === 'HGETALL'),
    [['HGETALL', 'ruling-cloud-budget:v1:production_test:2026-09-10']]);
  assert.equal(redis.commands.some(command => command[0] === 'DEL'), false);
});
