import test from 'node:test';
import assert from 'node:assert/strict';
import {selectAvailablePublicProfile, withPublicGenerationInfo} from '../backend/publicGenerationInfo.mjs';
import {presentPublicAnswer, PUBLIC_REQUEST_CHANNELS} from '../backend/publicAnswerPresentation.mjs';
import {finalizePublicAnswer, preparePublicAnswer} from '../backend/publicPreparedAnswerService.mjs';

test('known exhausted official allowance chooses DeepSeek; unknown allowance does not', async () => {
  const env = {DEEPSEEK_API_KEY:'synthetic'};
  for (const remainingAmount of [0, null, 1]) {
    const selected = await selectAvailablePublicProfile('official-astra-low',env,{readOfficial:async()=>({remainingAmount})});
    assert.equal(selected.profile.provider,remainingAmount === 0 ? 'deepseek' : 'openai');
  }
});

test('answer receipt appends returned identity and actual thinking settings to the answer text',async()=>{
  const answer={shortAnswer:'Original answer\nunchanged',debug:{dryRun:false,providerUsed:'relay',returnedModel:'reported-model',generationConfig:{reasoningEffort:'high',thinkingMode:'enabled'}}};
  const result=await withPublicGenerationInfo(answer,{id:'profile',model:'requested',provider:'relay',label:'Selected label'},{},{readBudget:async()=>({buckets:[{id:'final_ruling:relay',currency:'USD',remainingToday:3,dailyBudget:10,label:'Shared relay allowance'}]})});
  assert.equal(result.shortAnswer,'Original answer\nunchanged\n\n实际最终模型：reported-model；实际推理强度：high');
  assert.equal(result.generation.model,'reported-model');
  assert.equal(result.generation.reasoningEffort,'high');
  assert.equal(result.generation.embeddedInAnswerText,true);
  assert.equal(result.generation.budget.remainingAmount,3);
  const failed=await withPublicGenerationInfo({...answer,debug:{...answer.debug,providerFailure:{code:'timeout'}}},{provider:'relay'},{},{readBudget:async()=>null});
  assert.equal(failed.shortAnswer,answer.shortAnswer);
  assert.equal(failed.generation.generated,false);
  assert.equal(failed.generation.model,null);
  assert.equal(failed.generation.embeddedInAnswerText,false);
  assert.equal(failed.generation.budget.remainingAmount,null);
});

test('answer receipt falls back to the profile that actually generated the answer',async()=>{
  const result=await withPublicGenerationInfo({shortAnswer:'Fallback answer',debug:{dryRun:false,providerUsed:'deepseek'}},
    {id:'actual-fallback-profile',model:'actual-fallback-model',provider:'deepseek',label:'Actual fallback',reasoningEffort:'none',thinkingMode:'disabled'},
    {},{readBudget:async()=>null,fallbackFrom:'official-astra-low'});
  assert.equal(result.generation.model,'actual-fallback-model');
  assert.equal(result.generation.reasoningEffort,'none');
  assert.equal(result.generation.fallbackFrom,'official-astra-low');
  assert.match(result.shortAnswer,/实际最终模型：actual-fallback-model；实际推理强度：none$/u);
});

test('answer receipt labels a disabled null-effort profile as no thinking',async()=>{
  const result=await withPublicGenerationInfo({shortAnswer:'No-thinking answer',debug:{dryRun:false,providerUsed:'deepseek',
    returnedModel:'deepseek-v4.1-flash',generationConfig:{reasoningEffort:null,thinkingMode:'disabled'}}},
  {model:'deepseek-v4.1-flash',provider:'deepseek',label:'DeepSeek',reasoningEffort:null,thinkingMode:'disabled'},
  {},{readBudget:async()=>null});
  assert.equal(result.generation.reasoningEffort,null);
  assert.equal(result.generation.thinkingMode,'disabled');
  assert.match(result.shortAnswer,/实际最终模型：deepseek-v4\.1-flash；实际推理强度：none（未开启思考）$/u);
});

test('external API notice remains before the exact generated footer',async()=>{
  const generated=await withPublicGenerationInfo({shortAnswer:'API answer',debug:{dryRun:false,providerUsed:'relay',
    returnedModel:'reported-model',generationConfig:{reasoningEffort:'high',thinkingMode:'enabled'}}},
  {model:'requested-model',provider:'relay',label:'Relay',reasoningEffort:'low',thinkingMode:'enabled'},
  {},{readBudget:async()=>null});
  const shown=presentPublicAnswer(generated,{channel:PUBLIC_REQUEST_CHANNELS.EXTERNAL_API,
    env:{EXTERNAL_API_TEST_NOTICE:'External test notice'}});
  assert.equal(shown.shortAnswer,'API answer\n\nExternal test notice\n\n实际最终模型：reported-model；实际推理强度：high');
});

test('prepare exports exactly the saved prompt and does not generate an answer',async()=>{
  const prompt='Full prompt\n汉字\n"sources"'; let stored;
  const result=await preparePublicAnswer({payload:{},env:{},progress:{complete:()=>({totalMs:0})},store:{create:async value=>{stored=value;return 'preparation';}},answerPublic:async()=>({answer:{status:'evidence_prepared',continuation:{promptBundle:{prompt}},rulingVersion:'latest'},latency:{profileId:'official-astra-low'}})});
  assert.equal(result.evidencePackage.text,prompt);
  assert.equal(result.evidencePackage.text,stored.continuation.promptBundle.prompt);
  assert.equal(result.answer,undefined);
});

test('CNY models without an individual cap report the existing shared allowance',async()=>{
  const answer={debug:{dryRun:false,providerUsed:'glm',returnedModel:'glm-5.3',generationConfig:{reasoningEffort:'low',thinkingMode:'enabled'}}};
  const result=await withPublicGenerationInfo(answer,{provider:'glm',model:'glm-5.3',label:'GLM'},{},{readBudget:async()=>({dailyBudgetCny:10,remainingTodayCny:9.2,buckets:[{id:'final_ruling:glm',currency:'CNY',dailyBudget:null,remainingToday:null,label:'GLM'}]})});
  assert.equal(result.generation.budget.dailyBudgetAmount,10);
  assert.equal(result.generation.budget.remainingAmount,9.2);
  assert.match(result.generation.budget.sharedPoolLabel,/共享总额/);
});

test('only a rejected official reservation switches once, reusing the same saved prompt',async()=>{
  const preparation={profileId:'official-astra-low',pipeline:'rag_baseline',continuation:{promptBundle:{prompt:'Frozen input'}},rulingVersion:'latest',startedAt:0};
  const env={DEEPSEEK_API_KEY:'synthetic',OCG_FINAL_OPENAI_API_KEY:'synthetic',PUBLIC_OPENAI_BUDGET_RUN_ID:'test',PUBLIC_OPENAI_BUDGET_LIMIT_USD:'5',PUBLIC_OPENAI_BUDGET_INITIAL_USD:'0',UPSTASH_REDIS_REST_URL:'https://unused.invalid',UPSTASH_REDIS_REST_TOKEN:'synthetic'};
  const selectProfile=async()=>({profile:{id:'official-astra-low',provider:'openai'}});
  const calls=[];
  const result=await finalizePublicAnswer({preparation,env,selectProfile,finalize:async input=>{
    calls.push(input); if(calls.length===1) throw Object.assign(new Error('budget rejected'),{code:'official_daily_budget_exceeded'});
    return {shortAnswer:'DeepSeek original answer'};
  },addGeneration:async(answer,profile,_env,options)=>({...answer,generation:{provider:profile.provider,...options}})});
  assert.equal(calls.length,2);
  assert.equal(calls[0].continuation,calls[1].continuation);
  assert.equal(calls[1].env.RAG_MODEL_PROVIDER,'deepseek');
  assert.equal(result.generation,undefined);
  assert.equal(result.answer.generation.fallbackFrom,'official-astra-low');
  let failures=0;
  await assert.rejects(finalizePublicAnswer({preparation,env,selectProfile,finalize:async()=>{failures++;throw Object.assign(new Error('transport uncertain'),{code:'openai_stream_timeout'});}}),/transport uncertain/);
  assert.equal(failures,1);
});
