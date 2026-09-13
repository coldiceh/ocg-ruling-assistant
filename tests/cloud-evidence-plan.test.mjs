import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeCloudEvidencePlan,generateCloudEvidencePlan} from '../backend/cloudEvidencePlan.mjs';
import {retrieveRagEvidence} from '../backend/ragEvidenceRetriever.mjs';
import {answerRagRulingQuestion} from '../backend/ragRulingPipeline.mjs';
import {computeRagDataRevision} from '../backend/ragDataRevisionManifest.mjs';
import {buildSafeCandidates} from '../scripts/lib/manual-capture-evidence-selection.mjs';
import {writeCloudEvidenceCorpus} from '../scripts/build-cloud-evidence-assets.mjs';
import {createCloudRequestBudget,CLOUD_BUDGET_RESERVE,CLOUD_BUDGET_SETTLE,runCloudBudgetedQuestion} from '../backend/cloudRequestBudget.mjs';
import {callCardNameExtractionModel,callDeepSeekJsonTask,createPublicAnswerModelEnv} from '../backend/ragModelClient.mjs';

function relayTextResponse(text, model) {
  return new Response([
    `data: ${JSON.stringify({model,choices:[{index:0,finish_reason:'stop',delta:{content:text}}],
      usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}})}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), {status:200,headers:{'content-type':'text/event-stream'}});
}

test('all model information needs survive normalization, with exact duplicate removal only',()=>{
  const rows=Array.from({length:18},(_,i)=>({need:`condition ${i}`,query:`query ${i}`}));
  const result=normalizeCloudEvidencePlan({informationNeeds:[...rows,rows[0]]});
  assert.deepEqual(result.informationNeeds,rows.map(r=>r.need));
  assert.deepEqual(result.queryTexts,rows.map(r=>r.query));
  assert.deepEqual(normalizeCloudEvidencePlan([' full need ']),{informationNeeds:['full need'],queryTexts:[]});
  assert.throws(()=>normalizeCloudEvidencePlan({informationNeeds:[{}]}),/missing_need/);
});

test('planning receives only raw question and confirmed card texts and preserves DeepSeek usage',async()=>{
  let request;
  const result=await generateCloudEvidencePlan({question:'player question',cardTexts:[{text:'complete text'}],
    invokeTask:async value=>{request=value;return {informationNeeds:[{need:'condition',query:'query'}],
      usage:{prompt_tokens:8,completion_tokens:9},requestedModel:'configured-deepseek-model',providerUsed:'deepseek'};}});
  assert.equal(request.modelName,undefined);
  assert.equal(request.thinkingMode,'disabled');
  assert.equal(request.maxTokens,4096);
  assert.equal(request.prompt.split('\n').at(-1),JSON.stringify({question:'player question',cardTexts:[{text:'complete text'}]}));
  assert.deepEqual(result.telemetry.tokenUsage,{prompt_tokens:8,completion_tokens:9});
});

test('cloud public auxiliary configuration defaults to DeepSeek and keeps explicit Relay rollback without changing final selection',()=>{
  const source={RAG_CARD_MODEL_TIMEOUT_MS:'12000',RAG_CARD_MODEL_MAX_OUTPUT_TOKENS:'800',RAG_MAX_PROMPT_CHARS:'36000'};
  const baseline=createPublicAnswerModelEnv(source,'official-astra-low');
  const cloud=createPublicAnswerModelEnv({...source,RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1'},'official-astra-low');
  const rollback=createPublicAnswerModelEnv({...source,RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',
    CLOUD_EVIDENCE_AUXILIARY_PROVIDER:'relay'},'official-astra-low');
  assert.equal(baseline.RELAY_CARD_MODEL,'gpt-5.6-sol');
  assert.equal(baseline.RAG_CARD_MODEL_TIMEOUT_MS,'12000');
  assert.equal(cloud.RAG_CARD_MODEL_PROVIDER,'deepseek');
  assert.equal(cloud.CLOUD_EVIDENCE_PLAN_PROVIDER,'deepseek');
  assert.equal(cloud.RAG_CARD_MODEL_TIMEOUT_MS,'60000');
  assert.equal(cloud.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS,source.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS);
  assert.equal(cloud.RAG_MAX_PROMPT_CHARS,source.RAG_MAX_PROMPT_CHARS);
  assert.equal(cloud.MODEL_PROVIDER,'openai');
  assert.equal(cloud.RAG_MODEL,'gpt-6-astra');
  assert.equal(rollback.RAG_CARD_MODEL_PROVIDER,'relay');
  assert.equal(rollback.CLOUD_EVIDENCE_PLAN_PROVIDER,'relay');
  assert.equal(rollback.MODEL_PROVIDER,'openai');
});

test('DeepSeek JSON task uses the configured transport, disabled thinking, JSON mode, usage, and CNY budget',async()=>{
  const requests=[];
  const env={DEEPSEEK_API_KEY:'synthetic-deepseek-key',DEEPSEEK_BASE_URL:'https://deepseek.example.test/v1',
    DEEPSEEK_CARD_MODEL:'configured-deepseek-model',API_DAILY_BUDGET_CNY:'10'};
  const result=await callDeepSeekJsonTask({prompt:'original retrieval prompt',maxTokens:4096,env,
    fetchImpl:async(url,options)=>{
      requests.push({url:String(url),headers:options.headers,body:JSON.parse(options.body)});
      return Response.json({id:'ds-json-1',model:'configured-deepseek-model',
        choices:[{finish_reason:'stop',message:{content:'wrapper\n```json\n{"informationNeeds":[{"need":"n","query":"q"}]}\n```'}}],
        usage:{prompt_tokens:1000,completion_tokens:500,total_tokens:1500}});
    }});
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://deepseek.example.test/v1/chat/completions');
  assert.deepEqual(requests[0].body,{
    model:'configured-deepseek-model',messages:[{role:'user',content:'original retrieval prompt'}],stream:false,
    response_format:{type:'json_object'},thinking:{type:'disabled'},temperature:0,max_tokens:4096,
  });
  assert.deepEqual(result.usage,{prompt_tokens:1000,completion_tokens:500,total_tokens:1500,
    reasoning_tokens:0,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:1000,cache_write_tokens:0});
  assert.equal(result.providerUsed,'deepseek');
  assert.equal(result.costCurrency,'CNY');
  assert.equal(result.estimatedCostCny>0,true);
  assert.equal(result.budgetStatus.bucket.provider,'deepseek');
});

test('explicit cloud Relay rollback reserves and settles card extraction and planning exactly once each',async()=>{
  const commands=[];
  const env=createPublicAnswerModelEnv({RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',
    CLOUD_EVIDENCE_AUXILIARY_PROVIDER:'relay',RELAY_API_KEY:'rollback-key',
    RELAY_BASE_URL:'https://relay.example.test/v1',RELAY_PRICING_MULTIPLIER:'0.27',
    RELAY_SITE_DOLLAR_CNY:'1'},'official-astra-low');
  const budget=createCloudRequestBudget({env:{...env,CLOUD_BUDGET_RUN_ID:'rollback-test',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5'},
    command:async args=>{commands.push(args);return [args[1]===CLOUD_BUDGET_RESERVE?'reserved':'settled'];}});
  let transportCalls=0;
  const fetchImpl=async(_url,options)=>{
    transportCalls+=1;
    const prompt=JSON.parse(options.body).messages.map(message=>message.content).join('\n');
    return relayTextResponse(prompt.includes('你只负责补充游戏王OCG资料检索线索')
      ? JSON.stringify({informationNeeds:[{need:'need',query:'query'}]})
      : JSON.stringify({cardNames:[]}), 'gpt-6-astra');
  };
  const result=await runCloudBudgetedQuestion({env,budget},async()=>{
    await callCardNameExtractionModel({userQuery:'rollback question',dataRevision:'rollback-v1',env,fetchImpl});
    await generateCloudEvidencePlan({question:'rollback question',cardTexts:[{text:'complete text'}],env,fetchImpl});
    return {answer:'done'};
  });
  assert.equal(transportCalls,2);
  assert.equal(commands.filter(command=>command[1]===CLOUD_BUDGET_RESERVE).length,2);
  assert.equal(commands.filter(command=>command[1]===CLOUD_BUDGET_SETTLE).length,2);
  assert.deepEqual(result.debug.cloudCosts.calls.map(call=>call.provider),['relay','relay']);
});

test('production prepared evidence seam runs after identity preparation and skips old query planning',async()=>{
  let prepared;
  const result=await retrieveRagEvidence({userQuery:'plain question',cards:[],records:[],qaRecords:[],
    cardResolution:{resolvedCards:[],unresolvedMentions:[],ambiguousMentions:[]},
    fetchImpl:async()=>{throw new Error('unexpected network');},
    ruleSearchQueryProvider:async()=>{throw new Error('old planner must not run');},
    preparedEvidenceProvider:async input=>{prepared=input;return {...input,testMarker:true};}});
  assert.equal(result.testMarker,true);
  assert.deepEqual(prepared.cardResolution.resolvedCards,[]);
  assert.deepEqual(prepared.cardTexts,[]);
  assert.deepEqual(prepared.officialQaRelated,[]);
});

for (const deploymentEnv of ['preview','production']) {
test(`cloud production path preserves the complete wire prompt and captures it only in preview (${deploymentEnv})`,async(context)=>{
  const assetDir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-pipeline-path-'));
  context.after(()=>fs.rmSync(assetDir,{recursive:true,force:true}));
  const card={id:'integration-card',name:'整合测试龙',cnName:'整合测试龙',jaName:'統合テストドラゴン',
    enName:'Integration Test Dragon',aliases:['整合测试龙'],cardType:'monster',
    pendulumEffectText:'①：另一个区域的完整原文。',
    effectText:'①：自己主要阶段可以发动。抽1张卡。',sourceUrl:'https://example.test/card/integration'};
  const data={cards:[card],records:[],qaRecords:[]};
  const dataRevision=computeRagDataRevision(data);
  const body='完整资料正文。'.repeat(2700);
  const candidates=buildSafeCandidates({officialQaRecords:[{
    id:'integration-reference',recordType:'qa',official:true,
    question:'整合测试龙发动后的公开参考问题',text:body,
  }],cardResolution:{resolvedCards:[],unresolvedMentions:[],ambiguousMentions:[]},dataRevision});
  const corpusMetadata=await writeCloudEvidenceCorpus({outputDir:assetDir,dataRevision,candidates});
  fs.writeFileSync(path.join(assetDir,'corpus-manifest.json'),JSON.stringify(corpusMetadata));
  const question=`「整合测试龙」发动以后怎样处理？（${deploymentEnv}）`;
  const calls=[];
  const cloudBudgetCommands=[];
  const wireConfigs=[];
  let planInput,finalPrompt;
  const answer=await answerRagRulingQuestion({question,...data,
    cloudBudget:createCloudRequestBudget({env:{CLOUD_BUDGET_RUN_ID:'integration-test',
      CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5',
      RELAY_PRICING_MULTIPLIER:'0.27',RELAY_SITE_DOLLAR_CNY:'1'},
      command:async args=>{
        cloudBudgetCommands.push(args);
        return [args[1]===CLOUD_BUDGET_RESERVE?'reserved':'settled'];
      }}),
    env:createPublicAnswerModelEnv({VERCEL:'1',VERCEL_ENV:deploymentEnv,RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',CLOUD_EVIDENCE_ASSET_DIR:assetDir,
      CLOUD_EVIDENCE_DENSE:'false',CLOUD_EVIDENCE_RERANK:'false',RAG_MAX_PROMPT_CHARS:'8000',
      RAG_LIVE_OFFICIAL_QA:'false',RAG_MODEL_PROVIDER:'relay',
      RAG_MODEL:'gpt-6-astra',DEEPSEEK_API_KEY:'synthetic-deepseek-key',
      DEEPSEEK_BASE_URL:'https://deepseek.example.test',DEEPSEEK_CARD_MODEL:'configured-deepseek-model',
      OCG_FINAL_OPENAI_API_KEY:'synthetic-official-key',
      PUBLIC_OPENAI_BUDGET_RUN_ID:'integration-official',PUBLIC_OPENAI_BUDGET_LIMIT_USD:'5',
      PUBLIC_OPENAI_BUDGET_INITIAL_USD:'0.6054225',
      UPSTASH_BUDGET_KV_REST_API_URL:'https://budget.example.test',
      UPSTASH_BUDGET_KV_REST_API_TOKEN:'synthetic-budget-token',
      API_CHATGPT_DAILY_BUDGET_USD:'10',API_BUDGET_TIMEZONE:'UTC'},'official-astra-low'),
    fetchImpl:async(url,options)=>{
      if(String(url)==='https://budget.example.test') {
        const command=JSON.parse(options.body);
        if (command[0] === 'EVAL'
            && [CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE].includes(command[1])) {
          return Response.json({result:[command[1]===CLOUD_BUDGET_RESERVE?'reserved':'settled']});
        }
        throw new Error('cloud pipeline must not use the legacy public Relay budget gate');
      }
      assert.ok([
        'https://deepseek.example.test/chat/completions',
        'https://api.openai.com/v1/chat/completions',
      ].includes(String(url)));
      const request=JSON.parse(options.body);
      wireConfigs.push({model:request.model,thinking:request.thinking?.type,
        responseFormat:request.response_format?.type,maxTokens:request.max_tokens??request.max_completion_tokens});
      const prompt=request.messages.map(message=>message.content).join('\n');
      if(prompt.includes('你负责游戏王问题的提及抽取')){
        calls.push('card');return Response.json({model:request.model,choices:[{finish_reason:'stop',message:{content:
          JSON.stringify({cardNames:[{name:card.name,originalText:card.name,mentionType:'card'}],groupMentions:[]})}}],
          usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}});
      }
      if(prompt.includes('你只负责补充游戏王OCG资料检索线索')){
        calls.push('plan');planInput=JSON.parse(prompt.split('\n').at(-1));
        return Response.json({model:request.model,choices:[{finish_reason:'stop',message:{content:
          JSON.stringify({informationNeeds:[{need:'整合测试龙的发动处理',query:'統合テストドラゴンの処理'}]})}}],
          usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}});
      }
      calls.push('final');finalPrompt=prompt;
      assert.equal(String(url),'https://api.openai.com/v1/chat/completions');
      assert.equal(request.model,'gpt-6-astra');
      return relayTextResponse('这是模拟远端返回的完整裁定正文。',request.model);
    }});
  assert.deepEqual(calls,['card','plan','final']);
  const cloudReservations=cloudBudgetCommands
    .filter(command=>command[1]===CLOUD_BUDGET_RESERVE)
    .map(command=>JSON.parse(command[11]));
  assert.deepEqual(cloudReservations.map(ticket=>[ticket.provider,ticket.model,ticket.status,ticket.pricingBasis]),[
    ['deepseek','configured-deepseek-model','reserved','busy_rate_estimate'],
    ['deepseek','deepseek-flash','reserved','busy_rate_estimate'],
  ]);
  assert.equal(cloudBudgetCommands.filter(command=>command[1]===CLOUD_BUDGET_SETTLE).length,2);
  assert.deepEqual(wireConfigs.slice(0,2),[
    {model:'configured-deepseek-model',thinking:'disabled',responseFormat:'json_object',maxTokens:800},
    {model:'deepseek-flash',thinking:'disabled',responseFormat:'json_object',maxTokens:4096},
  ]);
  assert.equal(planInput.question,question);
  assert.ok(planInput.cardTexts.some(item=>item.cardIds.includes(card.id)));
  assert.ok(JSON.stringify(planInput.cardTexts).includes(card.effectText));
  assert.equal(planInput.cardTexts.find(item=>item.cardIds.includes(card.id)).text,
    card.effectText);
  assert.equal(planInput.cardTexts.find(item=>item.cardIds.includes(card.id)).pendulumEffectText,
    card.pendulumEffectText);
  const finalPayload=JSON.parse(finalPrompt.split('\n').at(-1));
  assert.equal(finalPayload.resolvedCards.find(item=>item.id===card.id).pendulumEffectText,card.pendulumEffectText);
  assert.ok(finalPrompt.includes(body));
  assert.ok(finalPrompt.length>8000&&finalPrompt.length<=36000);
  assert.equal(answer.mode,'cloud_evidence_v1');
  assert.equal(answer.shortAnswer,'这是模拟远端返回的完整裁定正文。');
  assert.ok(answer.resolvedCards.some(item=>item.id===card.id));
  assert.equal(answer.debug.cloudEvidence.selectedCount,1);
  assert.equal(answer.debug.cloudCosts.calls.length,2);
  assert.equal(answer.debug.cloudCosts.calls.every(call=>call.provider==='deepseek'&&call.status==='usage_settled'),true);
  assert.equal(answer.debug.cloudCosts.actualCny,0.000096);
  assert.equal(answer.debug.cloudCosts.theoreticalUsd,0);
  if(deploymentEnv==='preview') {
    assert.equal(answer.debug.cloudEvidenceCapture?.actualPrompt,finalPrompt);
    assert.deepEqual(answer.debug.cloudEvidenceCapture.informationNeeds,['整合测试龙的发动处理']);
    assert.deepEqual(answer.debug.cloudEvidenceCapture.queryTexts,['統合テストドラゴンの処理']);
  } else {
    assert.equal(Object.hasOwn(answer.debug,'cloudEvidenceCapture'),false);
  }
});
}

test('cloud dry run stops before any plan or model transport without fabricating a plan',async()=>{
  for(const input of [{dryRun:true},{envDryRun:'true'},{envDryRun:'1'},{envDryRun:'yes'},{envDryRun:'on'}]){
    let calls=0;
    await assert.rejects(answerRagRulingQuestion({question:'执行模式回归',cards:[],records:[],qaRecords:[],
      dryRun:input.dryRun,env:{RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',RAG_DRY_RUN:input.envDryRun},
      fetchImpl:async()=>{calls++;throw new Error('unexpected external transport');}}),
    error=>error.code==='cloud_evidence_dry_run_not_supported');
    assert.equal(calls,0);
  }
});

test('cloud budget wrapper preserves an unmatched exact lookup as null for the real public service',async()=>{
  const cloudBudget=createCloudRequestBudget({env:{CLOUD_BUDGET_RUN_ID:'exact-test',CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5',RELAY_PRICING_MULTIPLIER:'0.27',RELAY_SITE_DOLLAR_CNY:'1'},
    command:async()=>{throw new Error('unexpected budget write');}});
  const answer=await answerRagRulingQuestion({question:'synthetic unmatched question',cards:[],records:[],qaRecords:[],
    officialQaExactOnly:true,env:{RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',RAG_LIVE_OFFICIAL_QA:'false'},cloudBudget,
    fetchImpl:async()=>{throw new Error('unexpected transport');}});
  assert.equal(answer,null);
});
