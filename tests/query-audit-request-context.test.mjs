import assert from 'node:assert/strict';
import test from 'node:test';
import { readQueryAuditRequestContext, queryAuditAnswerPatch } from '../backend/publicQueryAudit.mjs';
import { createPublicAnswerHandler } from '../api/answer.js';

test('query audit accepts only platform IP or the direct socket and never payload IP', () => {
  const request = { headers: { 'x-forwarded-for': '203.0.113.3', 'x-vercel-forwarded-for': '2001:db8::5' },
    socket: { remoteAddress: '127.0.0.1' }, body: { ip: '198.51.100.20' } };
  assert.deepEqual(readQueryAuditRequestContext(request, {VERCEL:'1'}), {ip:'2001:db8::5',ipSource:'vercel'});
  assert.deepEqual(readQueryAuditRequestContext(request, {}), {ip:'127.0.0.1',ipSource:'socket'});
  assert.deepEqual(readQueryAuditRequestContext({ headers: {'x-forwarded-for':'203.0.113.3, 10.0.0.1'} }, {VERCEL:'1'}), {ip:null,ipSource:'unavailable'});
  assert.deepEqual(readQueryAuditRequestContext({ body:request.body }, {}), {ip:null,ipSource:'unavailable'});
});

test('HTTP prepare passes private context separately and does not serialize it in the public result', async () => {
  let input;
  const handler = createPublicAnswerHandler({ env: {VERCEL:'1'}, createStore:()=>({}),
    prepare: async options => { input = options; return {preparationId:'a'.repeat(64),progress:{totalMs:0},evidencePackage:{text:'fixture'}}; },
  });
  const response = {setHeader(){}, status(n){this.statusCode=n;return this;},json(value){this.payload=value;return this;},end(){}};
  await handler({method:'POST',headers:{'x-vercel-forwarded-for':'203.0.113.9'},body:{action:'prepare',question:'fixture',ip:'198.51.100.20'}},response);
  assert.equal(response.statusCode,200);
  assert.deepEqual(input.requestContext,{ip:'203.0.113.9',ipSource:'vercel'});
  assert.equal(JSON.stringify(response.payload).includes('203.0.113.9'),false);
  assert.equal(JSON.stringify(response.payload).includes('198.51.100.20'),false);
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
