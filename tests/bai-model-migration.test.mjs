import test from 'node:test';
import assert from 'node:assert/strict';
import {callRagModel, callCardNameExtractionModel, callBaiJsonTask, createPublicAnswerModelEnv} from '../backend/ragModelClient.mjs';

const source={BAI_API_KEY:'synthetic',RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',RAG_MAX_OUTPUT_TOKENS:'4096',CLOUD_EVIDENCE_AUXILIARY_PROVIDER:'deepseek'};
function stream(model, content='completed', finish='stop') {
  const chunks=[{model,choices:[{index:0,delta:{reasoning_content:'private reasoning',content},finish_reason:finish}]},{choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}];
  return new Response(chunks.map(x=>`data: ${JSON.stringify(x)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
for(const [id,model,effort,cap] of [
  ['bai-astra-low','gpt-6-astra','low',4096],
  ['deepseek-v4.1-flash-none','deepseek-v4.1-flash',null,4096],
  ...['low','high','max'].map(e=>[`deepseek-v4.1-flash-${e}`,'deepseek-v4.1-flash',e,e==='max'?131072:65536]),
  ...['low','high','max'].map(e=>[`glm-5.3-${e}`,'glm-5.3',e,65536]),
]) test(`${id} uses B.AI with its own model, effort and output envelope`,async()=>{
  const env=createPublicAnswerModelEnv(source,id);let body,calls=0;
  assert.equal(env.RAG_MODEL_PROVIDER,'bai');
  const result=await callRagModel({prompt:'synthetic request',env,outputMode:'plain_text',fetchImpl:async(url,options)=>{
    calls++;assert.equal(new URL(url).hostname,'api.b.ai');body=JSON.parse(options.body);return stream(model);
  }});
  assert.equal(calls,1);assert.equal(body.model,model);assert.equal(body.reasoning_effort??null,effort);
  assert.equal(body[model==='gpt-6-astra'?'max_completion_tokens':'max_tokens'],cap);
  if(model!=='gpt-6-astra') assert.deepEqual(body.thinking,{type:effort?'enabled':'disabled'});
  assert.equal(result.generationConfig.maxOutputTokens,cap);assert.equal(result.answer.shortAnswer,'completed');
  assert.equal(result.costBasis,'bai_standard_estimate');
  assert.equal(result.estimatedCostUsd<0.001,model!=='gpt-6-astra');
  assert.doesNotMatch(JSON.stringify(result.generationAttempts),/private reasoning/);
});
test('public card extraction moves to B.AI while retaining the typed DeepSeek prompt',async()=>{
  const env=createPublicAnswerModelEnv(source,'glm-5.3-max');let body,calls=0;
  assert.equal(env.RAG_CARD_MODEL_PROVIDER,'bai');
  const result=await callCardNameExtractionModel({userQuery:'synthetic query',env,fetchImpl:async(url,options)=>{
    calls++;assert.equal(new URL(url).hostname,'api.b.ai');body=JSON.parse(options.body);return stream('deepseek-v4.1-flash',JSON.stringify({cardNames:[],groupMentions:[]}));
  }});
  assert.equal(calls,1);assert.equal(body.model,'deepseek-v4.1-flash');assert.deepEqual(body.thinking,{type:'disabled'});
  assert.equal(body.reasoning_effort,undefined);assert.equal(body.temperature,0);assert.deepEqual(body.response_format,{type:'json_object'});
  assert.match(body.messages[0].content,/cardNames/);assert.match(body.messages[0].content,/groupMentions/);assert.equal(result.providerUsed,'bai');assert.equal(result.costCurrency,'USD');
});
test('B.AI JSON auxiliary task uses nonthinking DeepSeek with one request',async()=>{
  let calls=0;
  const result=await callBaiJsonTask({prompt:'Return JSON.',modelName:'deepseek-v4.1-flash',thinkingMode:'disabled',reasoningEffort:null,stage:'evidence_preparation',maxTokens:256,env:source,fetchImpl:async(url,options)=>{
    calls++;const body=JSON.parse(options.body);assert.equal(body.max_tokens,256);assert.deepEqual(body.thinking,{type:'disabled'});return stream(body.model,'{"scope":"in_scope"}');
  }});
  assert.equal(calls,1);assert.equal(result.scope,'in_scope');assert.equal(result.thinkingMode,'disabled');assert.ok(result.estimatedCostUsd<0.001);
});
