import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createPublicAnswerHandler } from '../api/answer.js';
import { parsePublicAnswerPayload, publicAnswerHttpError } from '../backend/publicAnswerService.mjs';
import { finalizePublicAnswer } from '../backend/publicPreparedAnswerService.mjs';

const id = 'a'.repeat(64);
const res = () => Object.assign(new EventEmitter(), {
  headers: {}, statusCode: 0, writableEnded: false,
  setHeader(k,v) { this.headers[k.toLowerCase()] = v; },
  status(c) { this.statusCode = c; return this; },
  json(p) { this.payload = p; this.writableEnded = true; return this; },
  end() { this.writableEnded = true; },
});

test('new public questions reject all server-owned controls before any model work', () => {
  for (const action of [undefined, 'prepare']) {
    for (const key of ['env', 'provider', 'apiKey', 'baseURL', 'prompt', 'messages', 'privateMode', 'RAG_DRY_RUN', 'budget', 'requestChannel', 'admin']) {
      assert.throws(() => parsePublicAnswerPayload({question: 'sample', ...(action ? {action} : {}), [key]: 'injected'}), {code: 'unsupported_request_field'});
    }
  }
  assert.equal(parsePublicAnswerPayload({question:'sample'}).question, 'sample');
  assert.equal(parsePublicAnswerPayload({question:'sample', mode:'rag', rulingVersion:'latest', rulingModelProfile:'official-astra-low', answerLocale:'ja', evidenceSelector:'luna'}).evidenceSelector, 'luna');
});

test('all paid HTTP actions enforce rate limit before dispatch or opening a stream', async () => {
  for (const body of [{question:'sample'}, {action:'prepare',question:'sample'}, {action:'finalize',preparationId:id}, {action:'translate_source',sourceSnapshotId:id,sourceId:'s1',targetLocale:'en'}]) {
    let dispatched = 0; let limited = 0;
    const handler = createPublicAnswerHandler({ env: {},
      rateLimit: async ({action}) => { limited++; assert.equal(action, body.action); throw Object.assign(Error('limited'), {code:'public_request_rate_limited',statusCode:429,retryAfterSeconds:42}); },
      answer: async () => { dispatched++; }, prepare: async () => { dispatched++; },
      finalize: async () => { dispatched++; }, translate: async () => { dispatched++; },
      createStore: () => { dispatched++; return {}; },
    });
    const response = res();
    await handler({method:'POST',headers:{accept:'text/event-stream'},body}, response);
    assert.equal(response.statusCode,429);
    assert.equal(response.payload.code,'public_request_rate_limited');
    assert.equal(response.headers['retry-after'],'42');
    assert.equal(limited,1); assert.equal(dispatched,0);
  }
});

test('limiter failure stops ordinary public request; injected env is used by direct answer', async () => {
  let calls=0; const env = {marker:'server-only'};
  let denied=true;
  const handler=createPublicAnswerHandler({env,rateLimit:async () => {if(denied) throw Object.assign(Error('unavailable'),{code:'public_request_rate_limit_unavailable',statusCode:503});},
    answer:async (input) => { calls++; assert.equal(input.env,env); return {answer:{shortAnswer:'ok'}}; }});
  const request={method:'POST',headers:{},body:{question:'sample'}};
  const first=res(); await handler(request,first); assert.equal(first.statusCode,503); assert.equal(calls,0);
  denied=false; const second=res(); await handler(request,second); assert.equal(second.statusCode,200); assert.equal(calls,1);
});

test('saved preparations without explicit server scope approval cannot generate a ruling', async () => {
  for (const scope of [undefined,'uncertain','out_of_scope']) {
    let calls=0;
    await assert.rejects(finalizePublicAnswer({preparation:{requestDiagnostics:{scope:{scope}}},env:{},selectProfile:async()=>{calls++;}}),{code:'answer_preparation_scope_unverified'});
    assert.equal(calls,0);
  }
});

test('public HTTP mapping preserves temporary provider status without leaking provider body', () => {
  const mapped=publicAnswerHttpError(Object.assign(Error('temporary provider failure'),{code:'decisions_http_504',statusCode:504,decisionsFailure:{dispatchCount:2,upstreamHttpStatus:504}}));
  assert.equal(mapped.statusCode,504);
  assert.equal(mapped.payload.debug.decisionsFailure.dispatchCount,2);
});

test('translation and finalization cannot bypass an unreadable configured service lock', async () => {
  for (const body of [{action:'finalize',preparationId:id}, {action:'translate_source',sourceSnapshotId:id,sourceId:'s1',targetLocale:'en'}]) {
    for (const failure of ['returned','thrown']) {
      let paid=0; let claims=0;
      const handler=createPublicAnswerHandler({
        env:{UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'test'},
        rateLimit:async()=>({ok:true}),
        readRiskControl:async()=>{ if(failure==='thrown') throw Error('storage failure'); return {ok:false,active:false}; },
        createStore:()=>({claim:async()=>{claims++;return {};}}),
        finalize:async()=>{paid++;},translate:async()=>{paid++;},
      });
      const response=res(); await handler({method:'POST',headers:{},body},response);
      assert.equal(response.statusCode,503); assert.equal(paid,0); assert.equal(claims,0);
    }
  }
});
