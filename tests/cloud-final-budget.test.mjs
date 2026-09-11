import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const sourceRoot = path.resolve(process.env.CLOUD_BUDGET_TEST_SOURCE || '.');
const budgetModule = await import(pathToFileURL(path.join(sourceRoot, 'backend/cloudRequestBudget.mjs')));
const ragModule = await import(pathToFileURL(path.join(sourceRoot, 'backend/ragModelClient.mjs')));
const {createCloudRequestBudget, getCloudEvidenceBudgetStatus} = budgetModule;
const {getRagBudgetStatus, resetRagBudget, capPublicChatGptBudget} = ragModule;

const python = process.env.CLOUD_BUDGET_LUA_PYTHON;
const enabled = Boolean(python);
const now = new Date('2026-09-10T16:00:00.000Z');
const baseEnv = {
  RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1', CLOUD_BUDGET_PERIOD: 'daily',
  CLOUD_BUDGET_RUN_ID: 'lua-budget-test', CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '10',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '1', API_BUDGET_TIMEZONE: 'Asia/Shanghai',
  RELAY_PRICING_MULTIPLIER: '1', RELAY_SITE_DOLLAR_CNY: '1',
  UPSTASH_REDIS_REST_URL: 'https://synthetic.invalid', UPSTASH_REDIS_REST_TOKEN: 'test',
};
const body = {model: 'gpt-6-astra', messages: [{role: 'user', content: 'synthetic'}], max_completion_tokens: 1000};

function luaRedis() {
  if (!enabled) return null;
  const child = spawn(python, ['tests/helpers/cloud-budget-lua.py'], {stdio: ['pipe', 'pipe', 'inherit']});
  const lines = createInterface({input: child.stdout});
  const pending = [];
  lines.on('line', line => pending.shift()?.(JSON.parse(line)));
  const fail = error => { while (pending.length) pending.shift()({error: String(error)}); };
  child.on('error', fail);
  child.on('exit', code => { if (code !== 0) fail(`Lua helper exited with ${code}`); });
  const request = args => new Promise((resolve, reject) => {
    pending.push(reply => reply.error ? reject(new Error(reply.error)) : resolve(reply.result));
    child.stdin.write(`${JSON.stringify({args})}\n`);
  });
  const commands = [];
  const command = async args => {commands.push(args);return request(args);};
  const fetchImpl = async (_url, options) => new Response(JSON.stringify({result: await command(JSON.parse(options.body))}));
  return {command, fetchImpl, request, commands, close: () => child.kill()};
}

function budget(redis, env = baseEnv, at = now) {
  return createCloudRequestBudget({env, now: at, command: redis.command});
}

async function withRedis(fn) {
  if (!enabled) return fn(null);
  const redis = luaRedis();
  try { return await fn(redis); } finally { redis.close(); }
}

test('Lua-backed final reserve/settle uses independent relay and b.ai pools', {skip: !enabled}, async () => withRedis(async redis => {
  const controller = budget(redis);
  await controller.relay({body, invoke: async () => ({model: body.model, usage: {prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050}})});
  const afterRelay = await getCloudEvidenceBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now});
  await controller.bai({body, invoke: async () => ({model: body.model, usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}})});
  const status = await getCloudEvidenceBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now});
  assert.equal(afterRelay.relayPool.spentUsd, status.relayPool.spentUsd);
  assert.equal(status.relayPool.spentUsd, 0.0125);
  assert.equal(status.baiPool.spentUsd, 0.00035);
  assert.equal(status.relayPool.accountedUsd, 0.0125);
  assert.equal(status.baiPool.accountedUsd, 0.00035);
  assert.equal(status.legacyCloudAccountedUsd, 0);
}));

test('b.ai missing usage remains reserved and reset keeps unknown charges', {skip: !enabled}, async () => withRedis(async redis => {
  const controller = budget(redis);
  await controller.bai({body, invoke: async () => ({model: body.model})});
  const before = await getCloudEvidenceBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now});
  assert.equal(before.baiPool.reservedUsd > 0, true);
  await resetRagBudget({env: baseEnv, fetchImpl: redis.fetchImpl, now});
  const after = await getCloudEvidenceBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now});
  assert.equal(after.baiPool.reservedUsd, before.baiPool.reservedUsd);
}));

test('legacy b.ai is final, legacy relay is unclassified, auxiliary is excluded', {skip: !enabled}, async () => withRedis(async redis => {
  const dayKey = '2026-09-11';
  const cloudKey = `ruling-cloud-budget:v1:${baseEnv.CLOUD_BUDGET_RUN_ID}:${dayKey}`;
  const legacyKey = cloudKey;
  const ticket = (provider, theoreticalNano, extra = {}) => JSON.stringify({provider, status: 'usage_settled', theoreticalNano, actualNano: 0, startedAtUtc: now.toISOString(), ...extra});
  await redis.request(['HSET', legacyKey, 'old-bai', ticket('bai', 200000000), 'old-relay', ticket('relay', 300000000), 'aux', ticket('relay', 900000000, {stage: 'evidence_preparation'})]);
  await redis.request(['HSET', legacyKey, 'actualNano','0','theoreticalNano','1400000000']);
  const oldFields = await redis.request(['HGETALL', legacyKey]);
  const status = await getCloudEvidenceBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now: new Date(`${dayKey}T00:00:00Z`)});
  assert.equal(status.baiPool.spentUsd, 0.2);
  assert.equal(status.relayPool.legacyUnclassifiedUsd, 0.3);
  assert.equal(status.relayPool.spentUsd, 0);
  await budget(redis).bai({body, invoke:async () => ({model:body.model, usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})});
  await resetRagBudget({env:baseEnv,fetchImpl:redis.fetchImpl,now});
  assert.deepEqual(await redis.request(['HGETALL',legacyKey]),oldFields);
}));

test('cap blocks both final providers and reset only credits settled fees', {skip: !enabled}, async () => withRedis(async redis => {
  const env = baseEnv;
  const controller = budget(redis, env);
  let dispatches = 0;
  const invoke = async () => {dispatches++;return {model:body.model,usage:{prompt_tokens:1000,completion_tokens:50,total_tokens:1050}};};
  await controller.bai({body,invoke});
  const closed = await capPublicChatGptBudget({env, fetchImpl: redis.fetchImpl, now});
  for (const provider of ['relay','bai']) {
    const pool = closed.buckets.find(row => row.provider === provider);
    assert.equal(pool.manuallyClosed,true);
    assert.equal(pool.remainingTodayUsd,0);
    await assert.rejects(() => controller[provider]({body,invoke}), /cloud_budget_total_exceeded/);
  }
  assert.equal(dispatches,1);
  assert.equal(closed.buckets.find(row => row.provider === 'bai').spentTodayUsd,0.0125);
  const reset = await resetRagBudget({env, fetchImpl: redis.fetchImpl, now});
  assert.equal(reset.buckets.find(row => row.provider === 'bai').spentTodayUsd,0);
  await controller.bai({body,invoke});
  await controller.relay({body,invoke});
  assert.equal(dispatches,3);
}));

test('status is day-scoped and original cloud hash remains unchanged', {skip: !enabled}, async () => withRedis(async redis => {
  const oldKey = `ruling-cloud-budget:v1:${baseEnv.CLOUD_BUDGET_RUN_ID}:2026-09-10`;
  await redis.request(['HSET', oldKey, 'old', JSON.stringify({provider: 'deepseek', status: 'usage_settled', actualNano: 123, theoreticalNano: 0})]);
  const oldFields = await redis.request(['HGETALL',oldKey]);
  await budget(redis).bai({body,invoke:async () => ({model:body.model,usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})});
  const first = await getRagBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now});
  const next = await getRagBudgetStatus({env: baseEnv, fetchImpl: redis.fetchImpl, now: new Date('2026-09-11T16:00:00Z')});
  assert.equal(first.buckets.find(item => item.id === 'final_ruling:bai')?.spentTodayUsd, 0.00035);
  assert.equal(next.buckets.find(item => item.id === 'final_ruling:bai')?.spentTodayUsd, 0);
  assert.deepEqual(await redis.request(['HGETALL',oldKey]),oldFields);
}));

test('exhausting either provider does not consume the other provider allowance', {skip:!enabled}, async () => {
  for (const exhausted of ['relay','bai']) await withRedis(async redis => {
    const key = `ruling-cloud-budget:v1:${baseEnv.CLOUD_BUDGET_RUN_ID}:2026-09-11`;
    const old = ['actualNano','0','theoreticalNano','1000000000','paid',JSON.stringify({provider:exhausted,stage:'final_ruling',status:'usage_settled',theoreticalNano:1e9,actualNano:0})];
    await redis.request(['HSET',key,...old]);
    const controller = budget(redis);
    let calls=0;
    const invoke=async () => {calls++;return {model:body.model,usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};};
    await assert.rejects(controller[exhausted]({body,invoke}), /cloud_budget_total_exceeded/);
    await controller[exhausted === 'bai' ? 'relay' : 'bai']({body,invoke});
    assert.equal(calls,1);
    assert.deepEqual(await redis.request(['HGETALL',key]),old);
  });
});

test('replaying a reservation or settlement does not charge the ticket twice', {skip:!enabled}, async () => withRedis(async redis => {
  await budget(redis).bai({body,invoke:async () => ({model:body.model,usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})});
  const [reserve,settle] = redis.commands.filter(command => command[0] === 'EVAL');
  const key = settle[3];
  const fields = await redis.request(['HGETALL',key]);
  assert.equal((await redis.command(reserve))[0],'existing');
  assert.equal((await redis.command(settle))[0],'settled');
  assert.deepEqual(await redis.request(['HGETALL',key]),fields);
}));
