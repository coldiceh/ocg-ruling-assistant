import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRequestBudget, runCloudBudgetedQuestion, CLOUD_BUDGET_RESERVE} from '../backend/cloudRequestBudget.mjs';
import { callRagModel, createPublicAnswerModelEnv } from '../backend/ragModelClient.mjs';

async function invoke(profile, overrides = {}, finish = 'stop') {
  let body;let calls = 0;
  const env = createPublicAnswerModelEnv({
    BAI_API_KEY:'test', RAG_MAX_OUTPUT_TOKENS:'4096',
    RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1', API_DAILY_BUDGET_CNY:'10',
    API_BUDGET_NAMESPACE:'deepseek-output-test', ...overrides,
  }, profile);
  const budget = outputBudget(env);
  const result = await runCloudBudgetedQuestion({env,budget},()=>callRagModel({ prompt:'测试请求', env, outputMode:'plain_text', fetchImpl:async(url,options)=>{
    calls++;assert.equal(new URL(url).hostname,'api.b.ai');body=JSON.parse(options.body);
    return ssePayload({model:'deepseek-v4.1-flash',choices:[{finish_reason:finish,message:{content:finish==='stop'?'已完成测试正文。':'',reasoning_content:'private reasoning'}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,completion_tokens_details:{reasoning_tokens:10}}});
  }}));
  return {body,result,calls};
}

for(const [effort,limit] of [['low',65536],['high',65536],['max',131072]]) {
  test(`public DeepSeek ${effort} reserves its reasoning envelope despite legacy generic 4096`, async()=>{
    const {body,result,calls}=await invoke(`deepseek-v4.1-flash-${effort}`);
    assert.equal(calls,1);assert.equal(body.max_tokens,limit);assert.equal(body.reasoning_effort,effort);
    assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.stream,true);
    assert.equal(result.generationConfig.maxOutputTokens,limit);
    assert.equal(result.generationAttempts[0].maxOutputTokens,limit);
    assert.equal(result.answer.shortAnswer,'已完成测试正文。');
    assert.equal(JSON.stringify(result.generationAttempts).includes('private reasoning'),false);
  });
}
test('thinking-specific server cap remains authoritative',async()=>{
  const {body}=await invoke('deepseek-v4.1-flash-max',{RAG_THINKING_MAX_OUTPUT_TOKENS:'90000',RAG_FLASH_THINKING_MAX_OUTPUT_TOKENS:'70000'});
  assert.equal(body.max_tokens,70000);
});
test('reservation uses the full max thinking cap before any provider dispatch',async()=>{
  const {result,calls}=await invoke('deepseek-v4.1-flash-max',{CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'0.1',API_BUDGET_NAMESPACE:'deepseek-output-tight'});
  assert.equal(calls,0);assert.ok(result.warnings.some(x=>x.includes('cloud_budget_total_exceeded')));
  assert.equal(result.generationConfig.maxOutputTokens,131072);
});
test('nonthinking and unrelated provider public caps stay unchanged',async()=>{
  assert.equal((await invoke('deepseek-v4.1-flash-none')).body.max_tokens,4096);
  const other=createPublicAnswerModelEnv({RAG_MAX_OUTPUT_TOKENS:'4096'},'relay-gpt-6-astra-high');assert.equal(other.RAG_MAX_OUTPUT_TOKENS,'4096');
});
test('length remains a failed generation and is never retried or filled with reasoning',async()=>{
  const {result,calls}=await invoke('deepseek-v4.1-flash-max',{},'length');
  assert.equal(calls,1);assert.equal(result.providerFailure.upstreamCode,'bai_stream_empty_content');
  assert.equal(result.generationAttempts[0].finishReason,'length');assert.equal(result.generationAttempts[0].contentChars,0);
  assert.doesNotMatch(result.answer.shortAnswer,/private reasoning/);
});

function outputBudget(env){
  return createCloudRequestBudget({env:{...env,CLOUD_BUDGET_RUN_ID:'synthetic-output-budget',CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',CLOUD_BUDGET_THEORETICAL_LIMIT_USD:env.CLOUD_BUDGET_THEORETICAL_LIMIT_USD||'5'},command:async command=>{
    if(command[1]!==CLOUD_BUDGET_RESERVE)return ['settled'];
    const ticket=JSON.parse(command[11]);assert.equal(ticket.provider,'bai');assert.equal(ticket.stage,'final_ruling');
    // Simulate the store decision using the actual production reservation;
    // separate Lua tests cover atomic reservation and the persistent pool.
    return [Number(command[6])<=Number(command[8])?'reserved':'blocked'];
  }});
}

function ssePayload(payload){
  const event={...payload,choices:payload.choices.map(c=>({index:0,finish_reason:c.finish_reason,delta:c.message}))};
  return new Response('data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
