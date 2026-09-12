import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readQueryAuditRequestContext, queryAuditAnswerPatch } from '../backend/publicQueryAudit.mjs';
import { createPublicAnswerHandler } from '../api/answer.js';
import { appendQueryAudit, listQueryAudits, updateQueryAudit } from '../backend/queryAuditStore.mjs';
import { classifyPublicRequestChannel } from '../backend/publicAnswerPresentation.mjs';

const WEB_BODY = Object.freeze({ question: 'Synthetic source question', mode: 'rag',
  rulingModelProfile: 'official-astra-low', rulingVersion: 'latest' });

test('query audit derives request channel from the existing request contract', () => {
  for (const [body, expected] of [
    [WEB_BODY, 'web'],
    [{ action: 'prepare', ...WEB_BODY }, 'web'],
    [{ question: 'Synthetic source question' }, 'external_api'],
    [JSON.stringify({ question: 'Synthetic source question' }), 'external_api'],
    [{ question: 'Synthetic source question', requestChannel: 'web' }, 'unknown'],
    [{ ...WEB_BODY, requestChannel: 'external_api' }, 'unknown'],
    [null, 'unknown'],
  ]) {
    const context = readQueryAuditRequestContext({ body }, {});
    assert.equal(context.requestChannel, expected);
    assert.equal(context.ip, null);
  }
});

test('local HTTP adapter forwards its parsed-body channel when the request has no body property', async () => {
  const request = { socket: { remoteAddress: '127.0.0.1' } };
  for (const [body, expected] of [[WEB_BODY, 'web'], [{ question: 'Synthetic source question' }, 'external_api']]) {
    const requestChannel = classifyPublicRequestChannel(JSON.stringify(body));
    const context = readQueryAuditRequestContext(request, {}, requestChannel);
    assert.equal(context.requestChannel, expected);
    assert.equal(context.ip, '127.0.0.1');
    assert.equal(Object.hasOwn(request, 'body'), false);
  }
  // Both existing local response branches must pass the same classification
  // already produced from readBody; neither has request.body to classify again.
  const source = await readFile(new URL('../backend/server.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/readQueryAuditRequestContext\(request, process\.env, requestChannel\)/gu) || []).length, 2);
});

test('query audit preserves the recorded channel through append, answer update and list', async () => {
  const entries = [];
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-token' };
  const fetchImpl = async (_url, options) => {
    const [command, ...args] = JSON.parse(options.body);
    let result = 1;
    if (command === 'LPUSH') entries.unshift(JSON.parse(args[1]));
    if (command === 'LRANGE') result = entries.map(entry => JSON.stringify(entry));
    if (command === 'EVAL') {
      const entry = entries.find(item => item.id === args[3]);
      const patch = JSON.parse(args[4]);
      assert.equal(Object.hasOwn(patch, 'requestChannel'), false);
      Object.assign(entry, patch);
      result = JSON.stringify(entry);
    }
    return { ok: true, json: async () => ({ result }) };
  };
  for (const requestChannel of ['web', 'external_api', 'unknown']) {
    const appended = await appendQueryAudit({ question: 'Synthetic source question',
      requestContext: { requestChannel }, env, fetchImpl });
    assert.equal(entries[0].requestChannel, requestChannel);
    assert.equal(appended.entry.requestChannel, requestChannel);
    const updated = await updateQueryAudit({ id: appended.entry.id,
      patch: { status: 'completed', answer: 'Synthetic answer' }, env, fetchImpl });
    assert.equal(updated.entry.requestChannel, requestChannel);
    const listed = await listQueryAudits({ env, fetchImpl });
    assert.equal(listed.entries[0].requestChannel, requestChannel);
    assert.equal(listed.entries[0].answer, 'Synthetic answer');
  }
});

test('query audit reads saved channels without inferring missing legacy channels', async () => {
  const entries = [
    { id: 'legacy', createdAt: '2026-09-01T00:00:00.000Z', question: 'Synthetic legacy question',
      mode: 'rag', ip: '203.0.113.9', profileId: 'official-astra-low' },
    { id: 'unknown', createdAt: '2026-09-01T00:00:00.000Z', question: 'Synthetic unknown question',
      mode: 'rag', requestChannel: 'unknown' },
  ];
  const result = await listQueryAudits({
    env: { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-token' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: entries.map(entry => JSON.stringify(entry)) }) }),
  });
  assert.deepEqual(result.entries, entries);
  assert.equal(Object.hasOwn(result.entries[0], 'requestChannel'), false);
});

test('query audit accepts only platform IP or the direct socket and never payload IP', () => {
  const request = { headers: { 'x-forwarded-for': '203.0.113.3', 'x-vercel-forwarded-for': '2001:db8::5' },
    socket: { remoteAddress: '127.0.0.1' }, body: { ip: '198.51.100.20' } };
  assert.deepEqual(readQueryAuditRequestContext(request, {VERCEL:'1'}), {ip:'2001:db8::5',ipSource:'vercel',requestChannel:'unknown'});
  assert.deepEqual(readQueryAuditRequestContext(request, {}), {ip:'127.0.0.1',ipSource:'socket',requestChannel:'unknown'});
  assert.deepEqual(readQueryAuditRequestContext({ headers: {'x-forwarded-for':'203.0.113.3, 10.0.0.1'} }, {VERCEL:'1'}), {ip:null,ipSource:'unavailable',requestChannel:'unknown'});
  assert.deepEqual(readQueryAuditRequestContext({ body:request.body }, {}), {ip:null,ipSource:'unavailable',requestChannel:'unknown'});
});

test('HTTP prepare passes private context separately and does not serialize it in the public result', async () => {
  let input;
  const handler = createPublicAnswerHandler({ env: {VERCEL:'1'}, createStore:()=>({}),
    prepare: async options => { input = options; return {preparationId:'a'.repeat(64),progress:{totalMs:0},evidencePackage:{text:'fixture'}}; },
  });
  const response = {setHeader(){}, status(n){this.statusCode=n;return this;},json(value){this.payload=value;return this;},end(){}};
  for (const [body, requestChannel] of [
    [{ action: 'prepare', ...WEB_BODY }, 'web'],
    [{ action: 'prepare', question: 'fixture', ip: '198.51.100.20' }, 'unknown'],
  ]) {
    await handler({method:'POST',headers:{'x-vercel-forwarded-for':'203.0.113.9'},body},response);
    assert.equal(response.statusCode,200);
    assert.deepEqual(input.requestContext,{ip:'203.0.113.9',ipSource:'vercel',requestChannel});
    assert.equal(JSON.stringify(response.payload).includes('203.0.113.9'),false);
    assert.equal(JSON.stringify(response.payload).includes('198.51.100.20'),false);
    assert.equal(JSON.stringify(response.payload).includes('requestChannel'),false);
  }
});

test('non-generated answers omit unrecorded model fields and retain the exact answer body', () => {
  const answer = '  Full body\n<script>fixture</script>  ';
  const patch = queryAuditAnswerPatch({shortAnswer:answer},{status:'blocked'});
  assert.equal(patch.answer,answer);
  assert.equal(patch.status,'blocked');
  assert.equal(Object.hasOwn(patch,'model'),false);
  assert.equal(Object.hasOwn(patch,'reasoningEffort'),false);
});

test('query audit records explicit final output failures instead of completed', () => {
  const incomplete = queryAuditAnswerPatch({
    shortAnswer: '模型输出未完整结束，本次未生成裁定，请重试。',
    riskFlags: ['model_output_not_displayable', 'model_plain_text_incomplete'],
    debug: { generationAttempts: [{ finishReason: 'length' }] },
  });
  assert.equal(incomplete.status, 'failed');
  assert.equal(incomplete.errorCode, 'model_plain_text_incomplete');

  const empty = queryAuditAnswerPatch({
    shortAnswer: '',
    riskFlags: ['model_output_not_displayable', 'model_plain_text_empty'],
    debug: { generationAttempts: [{ finishReason: 'stop' }] },
  });
  assert.equal(empty.status, 'failed');
  assert.equal(empty.errorCode, 'model_plain_text_empty');

  const providerFailure = queryAuditAnswerPatch({
    shortAnswer: '模型服务本次响应超时，未生成裁定，请稍后重试。',
    riskFlags: ['model_output_not_displayable', 'model_provider_timeout'],
    debug: { providerFailure: { kind: 'timeout', code: 'model_provider_timeout' } },
  });
  assert.equal(providerFailure.status, 'failed');
  assert.equal(providerFailure.errorCode, 'model_output_not_displayable');
});

test('query audit preserves parser outcome and explicit statuses', () => {
  const length = queryAuditAnswerPatch({
    shortAnswer: 'partial body',
    riskFlags: ['model_plain_text_incomplete'],
    debug: { generationAttempts: [{ finishReason: 'length' }] },
  });
  assert.equal(length.status, 'failed');
  assert.equal(length.errorCode, 'model_plain_text_incomplete');

  const completed = queryAuditAnswerPatch({
    shortAnswer: '完整正文',
    debug: { generationAttempts: [{ finishReason: 'stop' }] },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(Object.hasOwn(completed, 'errorCode'), false);

  const blocked = queryAuditAnswerPatch({
    shortAnswer: '',
    riskFlags: ['model_plain_text_empty'],
  }, { status: 'blocked' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(Object.hasOwn(blocked, 'errorCode'), false);
});
