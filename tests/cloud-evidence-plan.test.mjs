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
import {createCloudRequestBudget,CLOUD_BUDGET_RESERVE} from '../backend/cloudRequestBudget.mjs';
import {createPublicAnswerModelEnv} from '../backend/ragModelClient.mjs';

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

test('planning receives only raw question and confirmed card texts and preserves usage',async()=>{
  let request;
  const result=await generateCloudEvidencePlan({question:'player question',cardTexts:[{text:'complete text'}],
    invokeTask:async value=>{request=value;return {informationNeeds:[{need:'condition',query:'query'}],
      usage:{prompt_tokens:8,completion_tokens:9},requestedModel:'gpt-6-astra'};}});
  assert.equal(request.modelName,'gpt-6-astra');
  assert.equal(request.reasoningEffort,'low');
  assert.equal(request.maxTokens,4096);
  assert.equal(request.prompt.split('\n').at(-1),JSON.stringify({question:'player question',cardTexts:[{text:'complete text'}]}));
  assert.deepEqual(result.telemetry.tokenUsage,{prompt_tokens:8,completion_tokens:9});
});

test('cloud public auxiliary configuration uses Astra low and 60 seconds without changing other routes',()=>{
  const source={RAG_CARD_MODEL_TIMEOUT_MS:'12000',RAG_CARD_MODEL_MAX_OUTPUT_TOKENS:'800',RAG_MAX_PROMPT_CHARS:'36000'};
  const baseline=createPublicAnswerModelEnv(source,'relay-gpt-6-astra-low');
  const cloud=createPublicAnswerModelEnv({...source,RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1'},'relay-gpt-6-astra-low');
  assert.equal(baseline.RELAY_CARD_MODEL,'gpt-5.6-sol');
  assert.equal(baseline.RAG_CARD_MODEL_TIMEOUT_MS,'12000');
  assert.equal(cloud.RELAY_CARD_MODEL,'gpt-6-astra');
  assert.equal(cloud.RAG_CARD_MODEL_REASONING_EFFORT,'low');
  assert.equal(cloud.RAG_CARD_MODEL_TIMEOUT_MS,'60000');
  assert.equal(cloud.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS,source.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS);
  assert.equal(cloud.RAG_MAX_PROMPT_CHARS,source.RAG_MAX_PROMPT_CHARS);
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
  const wireConfigs=[];
  let planInput,finalPrompt;
  const answer=await answerRagRulingQuestion({question,...data,
    cloudBudget:createCloudRequestBudget({env:{CLOUD_BUDGET_RUN_ID:'integration-test',
      CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5',
      RELAY_PRICING_MULTIPLIER:'0.27',RELAY_SITE_DOLLAR_CNY:'1'},
      command:async args=>[args[1]===CLOUD_BUDGET_RESERVE?'reserved':'settled']}),
    env:createPublicAnswerModelEnv({VERCEL_ENV:deploymentEnv,RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',CLOUD_EVIDENCE_ASSET_DIR:assetDir,
      CLOUD_EVIDENCE_DENSE:'false',CLOUD_EVIDENCE_RERANK:'false',RAG_MAX_PROMPT_CHARS:'8000',
      RAG_LIVE_OFFICIAL_QA:'false',RAG_CARD_MODEL_PROVIDER:'relay',RAG_MODEL_PROVIDER:'relay',
      RAG_MODEL:'gpt-6-astra',RELAY_API_KEY:'synthetic-key',RELAY_BASE_URL:'https://relay.example.test/v1',
      API_CHATGPT_DAILY_BUDGET_USD:'10',API_BUDGET_TIMEZONE:'UTC'},'relay-gpt-6-astra-low'),
    fetchImpl:async(url,options)=>{
      assert.equal(String(url),'https://relay.example.test/v1/chat/completions');
      const request=JSON.parse(options.body);
      wireConfigs.push({model:request.model,effort:request.reasoning_effort,maxTokens:request.max_completion_tokens});
      const prompt=request.messages.map(message=>message.content).join('\n');
      if(prompt.includes('提取所有可能的卡名候选')){
        calls.push('card');return relayTextResponse(JSON.stringify({cardNames:[card.name]}),request.model);
      }
      if(prompt.includes('生成资料检索计划，不回答裁定')){
        calls.push('plan');planInput=JSON.parse(prompt.split('\n').at(-1));
        return relayTextResponse(JSON.stringify({informationNeeds:[{need:'整合测试龙的发动处理',query:'統合テストドラゴンの処理'}]}),request.model);
      }
      calls.push('final');finalPrompt=prompt;
      assert.equal(request.model,'gpt-6-astra');
      return relayTextResponse('这是模拟远端返回的完整裁定正文。',request.model);
    }});
  assert.deepEqual(calls,['card','plan','final']);
  assert.deepEqual(wireConfigs.slice(0,2),[
    {model:'gpt-6-astra',effort:'low',maxTokens:800},
    {model:'gpt-6-astra',effort:'low',maxTokens:4096},
  ]);
  assert.equal(planInput.question,question);
  assert.ok(planInput.cardTexts.some(item=>item.cardIds.includes(card.id)));
  assert.ok(JSON.stringify(planInput.cardTexts).includes(card.effectText));
  assert.ok(finalPrompt.includes(body));
  assert.ok(finalPrompt.length>8000&&finalPrompt.length<=36000);
  assert.equal(answer.mode,'cloud_evidence_v1');
  assert.equal(answer.shortAnswer,'这是模拟远端返回的完整裁定正文。');
  assert.ok(answer.resolvedCards.some(item=>item.id===card.id));
  assert.equal(answer.debug.cloudEvidence.selectedCount,1);
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
