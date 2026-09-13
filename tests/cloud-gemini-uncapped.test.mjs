import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Keep this test aligned with cloud-final-budget.test.mjs: EVAL is executed by
// the production Lua source through the tiny persistent Redis adapter.
const sourceRoot = path.resolve(process.env.CLOUD_BUDGET_TEST_SOURCE || '.');
const budgetModule = await import(pathToFileURL(path.join(sourceRoot, 'backend/cloudRequestBudget.mjs')));
const ragModule = await import(pathToFileURL(path.join(sourceRoot, 'backend/ragModelClient.mjs')));
const { createCloudRequestBudget, getCloudEvidenceBudgetStatus } = budgetModule;
const { getRagBudgetStatus } = ragModule;

const python = process.env.CLOUD_BUDGET_LUA_PYTHON;
const enabled = Boolean(python);
const now = new Date('2026-09-10T16:00:00.000Z');
const baseEnv = {
  RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1',
  CLOUD_BUDGET_PERIOD: 'daily',
  CLOUD_BUDGET_RUN_ID: 'gemini-uncapped-test',
  CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '10',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.002',
  API_BUDGET_TIMEZONE: 'Asia/Shanghai',
  API_DAILY_BUDGET_CNY: '10',
  UPSTASH_REDIS_REST_URL: 'https://synthetic.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'test',
  RELAY_PRICING_MULTIPLIER: '1',
  RELAY_SITE_DOLLAR_CNY: '1',
};
const geminiBody = {
  contents: [{ parts: [{ text: 'synthetic rules question' }] }],
  generationConfig: { maxOutputTokens: 2_000 },
};
const geminiResponse = {
  modelVersion: 'gemini-3.8-flash',
  usageMetadata: {
    promptTokenCount: 1,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 1_999,
    thoughtsTokenCount: 0,
    totalTokenCount: 2_000,
  },
};

function luaRedis() {
  if (!enabled) return null;
  const child = spawn(python, ['tests/helpers/cloud-budget-lua.py'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  const fail = (error) => {
    while (pending.length) pending.shift()({ error: String(error) });
  };
  lines.on('line', (line) => pending.shift()?.(JSON.parse(line)));
  child.on('error', fail);
  child.on('exit', (code) => {
    if (code !== 0) fail(`Lua helper exited with ${code}`);
  });
  const request = (args) => new Promise((resolve, reject) => {
    pending.push((reply) => reply.error ? reject(new Error(reply.error)) : resolve(reply.result));
    child.stdin.write(`${JSON.stringify({ args })}\n`);
  });
  const commands = [];
  const command = async (args) => {
    commands.push(args);
    return request(args);
  };
  const fetchImpl = async (_url, options) => new Response(JSON.stringify({
    result: await command(JSON.parse(options.body)),
  }));
  return { command, fetchImpl, request, commands, close: () => child.kill() };
}

function budget(redis, env = baseEnv, at = now) {
  return createCloudRequestBudget({ env, now: at, command: redis.command });
}

async function withRedis(fn) {
  if (!enabled) return fn(null);
  const redis = luaRedis();
  try {
    return await fn(redis);
  } finally {
    redis.close();
  }
}

function cloudKey(env = baseEnv, at = now) {
  return `ruling-cloud-budget:v1:${env.CLOUD_BUDGET_RUN_ID}:2026-09-11`;
}

function ticket(provider, status, theoreticalNano, extra = {}) {
  return JSON.stringify({
    provider,
    status,
    theoreticalNano,
    actualNano: 0,
    startedAtUtc: now.toISOString(),
    ...extra,
  });
}

test('public daily Gemini can settle above the shared theoretical amount', { skip: !enabled }, async () => withRedis(async (redis) => {
  const env = { ...baseEnv, CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.002' };
  const result = await budget(redis, env).gemini({
    operation: 'generate_content',
    model: 'gemini-3.8-flash',
    body: geminiBody,
    invoke: async () => geminiResponse,
  });
  assert.equal(result, geminiResponse);
  const status = await getCloudEvidenceBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  assert.ok(status.geminiPool.spentUsd > status.geminiPool.theoreticalLimitUsd);
  assert.equal(status.geminiPool.reservedUsd, 0);
}));

test('public daily old settled Gemini charges do not block DeepSeek preparation', { skip: !enabled }, async () => withRedis(async (redis) => {
  const env = { ...baseEnv, CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.002' };
  const key = cloudKey(env);
  await redis.request(['HSET', key,
    'actualNano', '0',
    'theoreticalNano', '7500000000',
    'old-gemini', ticket('gemini', 'usage_settled', 7500000000),
  ]);
  let invoked = false;
  await budget(redis, env).deepseek({
    body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'auxiliary' }], max_tokens: 1 },
    invoke: async () => {
      invoked = true;
      return { model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    },
  });
  assert.equal(invoked, true);
  const fields = await redis.request(['HGETALL', key]);
  assert.equal(fields.includes('old-gemini'), true);
}));

test('public daily unknown Gemini reservation does not block DeepSeek preparation', { skip: !enabled }, async () => withRedis(async (redis) => {
  const env = { ...baseEnv, CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.002' };
  const key = cloudKey(env);
  const old = ticket('gemini', 'reserved', 7500000000);
  await redis.request(['HSET', key,
    'actualNano', '0',
    'theoreticalNano', '7500000000',
    'unknown-gemini', old,
  ]);
  await budget(redis, env).deepseek({
    body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'auxiliary' }], max_tokens: 1 },
    invoke: async () => ({ model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }),
  });
  const fields = await redis.request(['HGETALL', key]);
  assert.equal(fields.includes('unknown-gemini'), true);
  assert.equal(JSON.parse(fields[fields.indexOf('unknown-gemini') + 1]).status, 'reserved');
}));

test('run mode keeps the cumulative Gemini theoretical cap', { skip: !enabled }, async () => withRedis(async (redis) => {
  const env = {
    ...baseEnv,
    CLOUD_BUDGET_PERIOD: 'run',
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.002',
  };
  let invoked = false;
  await assert.rejects(() => budget(redis, env).gemini({
    operation: 'generate_content',
    model: 'gemini-3.8-flash',
    body: geminiBody,
    invoke: async () => {
      invoked = true;
      return geminiResponse;
    },
  }), /cloud_budget_total_exceeded/);
  assert.equal(invoked, false);
}));

test('public daily non-Gemini preparation still enforces its original CNY cap', { skip: !enabled }, async () => withRedis(async (redis) => {
  const env = { ...baseEnv, CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '0.00001' };
  let invoked = false;
  await assert.rejects(() => budget(redis, env).deepseek({
    body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'auxiliary' }], max_tokens: 10_000 },
    invoke: async () => {
      invoked = true;
      return { model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 10_000, total_tokens: 10_010 } };
    },
  }), /cloud_budget_total_exceeded/);
  assert.equal(invoked, false);
}));

test('status exposes an unlimited evidence-preparation Gemini bucket with usage and reservations', { skip: !enabled }, async () => withRedis(async (redis) => {
  const env = { ...baseEnv, CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.002' };
  const key = cloudKey(env);
  await redis.request(['HSET', key,
    'actualNano', '0',
    'theoreticalNano', '8500000000',
    'gemini-settled', ticket('gemini', 'usage_settled', 7500000000),
    'gemini-reserved', ticket('gemini', 'reserved', 1000000000),
  ]);
  const status = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  const bucket = status.buckets.find((item) => item.id === 'evidence_preparation:gemini');
  assert.ok(bucket);
  assert.equal(bucket.dailyBudget, null);
  assert.equal(bucket.dailyBudgetUsd, null);
  assert.equal(bucket.remainingToday, null);
  assert.equal(bucket.remainingTodayUsd, null);
  assert.equal(bucket.limitEnforced, false);
  assert.equal(bucket.spentTodayUsd, 7.5);
  assert.equal(bucket.reservedTodayUsd, 1);
}));
