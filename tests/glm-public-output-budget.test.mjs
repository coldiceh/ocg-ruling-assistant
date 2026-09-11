import test from 'node:test';
import assert from 'node:assert/strict';
import {callRagModel,createPublicAnswerModelEnv} from '../backend/ragModelClient.mjs';

async function invoke(effort, overrides={}, finish='stop') {
  let body;let calls=0;
  const env=createPublicAnswerModelEnv({GLM_API_KEY:'test',RAG_MAX_OUTPUT_TOKENS:'4096',
    RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',API_DAILY_BUDGET_CNY:'10',
    API_BUDGET_NAMESPACE:'glm-output-test',...overrides},`glm-5.3-${effort}`);
  const result=await callRagModel({prompt:'测试请求',env,outputMode:'plain_text',fetchImpl:async(url,options)=>{
    calls++;assert.equal(new URL(url).hostname,'open.bigmodel.cn');body=JSON.parse(options.body);
    return new Response(JSON.stringify({model:'glm-5.3',choices:[{finish_reason:finish,message:{content:finish==='stop'?'已完成测试正文。':'',reasoning_content:'private reasoning'}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,completion_tokens_details:{reasoning_tokens:10}}}),{status:200,headers:{'content-type':'application/json'}});
  }});
  return {body,result,calls};
}

for(const effort of ['low','high','max'])test(`GLM ${effort} keeps room for thinking and final answer despite legacy 4096`,async()=>{
  const {body,result,calls}=await invoke(effort);
  assert.equal(calls,1);assert.equal(body.model,'glm-5.3');assert.equal(body.reasoning_effort,effort);
  assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.max_tokens,65536);
  assert.equal(result.generationConfig.maxOutputTokens,65536);
  assert.equal(result.generationAttempts[0].maxOutputTokens,65536);
  assert.equal(result.answer.shortAnswer,'已完成测试正文。');
  assert.equal(JSON.stringify(result.generationAttempts).includes('private reasoning'),false);
});
test('GLM-specific cap takes precedence and the dedicated legacy thinking cap is retained',async()=>{
  assert.equal((await invoke('max',{GLM_THINKING_MAX_OUTPUT_TOKENS:'70000',RAG_FLASH_THINKING_MAX_OUTPUT_TOKENS:'80000'})).body.max_tokens,70000);
  assert.equal((await invoke('max',{RAG_FLASH_THINKING_MAX_OUTPUT_TOKENS:'80000'})).body.max_tokens,80000);
});
test('GLM reservation covers the configured output cap before any dispatch',async()=>{
  const {result,calls}=await invoke('max',{API_DAILY_BUDGET_CNY:'0.2',API_BUDGET_NAMESPACE:'glm-output-tight'});
  assert.equal(calls,0);assert.ok(result.warnings.includes('api_daily_budget_exceeded'));
  assert.equal(result.generationConfig.maxOutputTokens,65536);
});
test('GLM length keeps the existing failure and never retries or displays reasoning as an answer',async()=>{
  const {result,calls}=await invoke('max',{},'length');assert.equal(calls,1);
  assert.ok(result.answer.riskFlags.includes('model_plain_text_incomplete'));
  assert.equal(result.generationAttempts[0].finishReason,'length');
  assert.equal(result.generationAttempts[0].contentChars,0);
  assert.doesNotMatch(result.answer.shortAnswer,/private reasoning/);
});
