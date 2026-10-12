import test from 'node:test';
import assert from 'node:assert/strict';
import {startCardNameExtraction, answerRagRulingQuestion} from '../backend/ragRulingPipeline.mjs';
import {clearBaigeSearchCache} from '../backend/baigeCardProvider.mjs';
import {loadPreparedRagCardData, retrieveRagEvidence} from '../backend/ragEvidenceRetriever.mjs';

const env={RAG_CARD_MODEL_PROVIDER:'bai',BAI_CARD_ENABLED:'true',BAI_CARD_API_KEY:'fixture',
  RAG_LIVE_OFFICIAL_QA:'false',API_BUDGET_MODE:'off'};
const cards=[{id:'980001',cid:980001,name:'匿名确认甲',enName:'Anonymous Confirm A',effectText:'完整卡文甲。'},
  {id:'980002',cid:980002,name:'匿名确认乙',enName:'Anonymous Confirm B',effectText:'完整卡文乙。'}];
const pending=(input='匿名简称')=>({name:input,enName:'',originalText:input});
async function run({mentions=[pending()],select='C1',catalog=cards,query='匿名简称的效果怎么处理？',results=[]}={}) {
  clearBaigeSearchCache();
  const tasks=[],requests=[];
  const result=await startCardNameExtraction({question:query,cards:catalog,env,
    cardModelInvoker:async request=>{
      tasks.push(request);
      return request.task==='card_name_extraction'
        ? {cardNames:mentions,groupMentions:['场地']}
        : {selections:[{mentionId:'M1',candidateId:select}]};
    },fetchImpl:async url=>{
      requests.push(String(url));
      return new Response(JSON.stringify({result:results,next:0}),{headers:{'content-type':'application/json'}});
    }});
  return {result,tasks,requests};
}

test('unconfirmed model mention reaches one Luna selection after bounded candidate lookup',async()=>{
  const {result,tasks,requests}=await run();
  assert.deepEqual(tasks.map(item=>item.task),['card_name_extraction','card_identity_selection']);
  assert.equal(tasks[1].provider,'bai');
  assert.equal(tasks[1].modelName,'gpt-6-luna');
  assert.equal(tasks[1].reasoningEffort,'low');
  assert.match(tasks[1].prompt,/匿名简称的效果怎么处理/u);
  assert.equal(requests.length,1);
  assert.equal(result.cardResolution.resolvedCards[0].id,'980001');
  assert.equal(result.cardResolution.resolvedCards[0].input,'匿名简称');
  assert.equal(result.cardResolution.resolvedCards[0].effectText,cards[0].effectText);
  assert.equal(result.cardResolution.resolvedCards[0].resolutionSource,'model_candidate_selection');
  assert.equal(result.candidateConfirmation.modelCallCount,1);
  assert.ok(result.timingsMs.candidateConfirmation>=0);
});

test('model null keeps pending through the production retriever without another selection or guessed identity',async()=>{
  const {result,tasks}=await run({select:null});
  assert.equal(result.cardResolution.resolvedCards.length,0);
  assert.equal(result.cardResolution.unresolvedMentions[0].input,'匿名简称');
  const prepared=await answerRagRulingQuestion({question:result.query,preloadedAssets:{data:result.data},env:{...env,
    RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',GEMINI_RULE_QA_ENABLED:'true'},
    preloadedCardNameExtraction:result,prepareForContinuation:true,
    cardModelInvoker:()=>{throw Error('must_reuse_preload');},fetchImpl:()=>{throw Error('must_not_search_again');},
    geminiEvidenceProvider:{async retrieve({cardResolution}){
      assert.equal(cardResolution.resolvedCards.length,0);
      assert.equal(cardResolution.unresolvedMentions[0].input,'匿名简称');
      return {evidence:{cardTexts:[],cardResolution},packing:{prompt:'fixture',promptChars:7,
        modelEvidence:{},allowedEvidenceIds:[],warnings:[]},telemetry:{}};
    }},cloudBudget:{snapshot:()=>({calls:[]})}});
  assert.equal(prepared.status,'evidence_prepared');
  assert.equal(tasks.length,2);
});

// 2026-10-12 规则变更: only a formal name the player typed is confirmed at once.
test('confirmed canonical identity and generic groups skip all candidate work',async()=>{
  const {result,tasks,requests}=await run({query:`${cards[0].name}的效果怎么处理？`,
    mentions:[{name:cards[0].name,enName:'',originalText:cards[0].name}]});
  assert.equal(tasks.length,1);
  assert.equal(requests.length,0);
  assert.equal(result.cardResolution.resolvedCards[0].id,'980001');
  assert.equal(result.candidateConfirmation.modelCallCount,0);
  assert.deepEqual(result.cardNameModel.groupMentions,['场地']);
});

// 2026-10-12 规则变更: four mentions share the one selection call; Baige still
// receives at most two requests, so later mentions use local candidates only.
test('four pending groups share one selection; unhandled fifth mention stays pending',async()=>{
  const catalog=Array.from({length:12},(_,i)=>({id:String(980100+i),cid:980100+i,name:`匿名测试卡${i}`}));
  const {result,tasks,requests}=await run({catalog,select:null,
    mentions:['简称甲','简称乙','简称丙','简称丁','简称戊'].map(input=>pending(input))});
  assert.equal(requests.length,2);
  assert.equal(tasks.length,2);
  assert.equal(result.candidateConfirmation.candidateSets.length,4);
  assert.ok(result.candidateConfirmation.candidateSets.every(set=>set.candidates.length<=6));
  assert.ok(result.candidateConfirmation.candidateSets.flatMap(set=>set.candidates).length<=24);
  assert.equal(result.cardResolution.unresolvedMentions.length,5);
});

test('a formal name proposed for an abbreviation joins the candidates instead of binding',async()=>{
  // Reported 2026-10-12: the extractor named the wrong catalog card for a short name.
  const {result,tasks}=await run({mentions:[{...pending(),name:cards[1].name,enName:cards[1].enName}],select:'C1'});
  assert.deepEqual(tasks.map(item=>item.task),['card_name_extraction','card_identity_selection']);
  const offered=result.candidateConfirmation.candidateSets[0].candidates.map(card=>card.cid);
  assert.ok(offered.includes('980002'),'the proposal must be offered to the selector');
  assert.equal(result.cardResolution.resolvedCards[0].id,offered[0]);
  assert.equal(result.cardResolution.resolvedCards[0].input,'匿名简称');
  assert.equal(result.cardResolution.resolvedCards[0].resolutionSource,'model_candidate_selection');
});

test('a proposal outside the surface search results is still offered within the per-mention cap',async()=>{
  const catalog=[...Array.from({length:8},(_,i)=>({id:String(980200+i),cid:980200+i,name:`匿名简称${i}`,effectText:`卡文${i}`})),
    {id:'980299',cid:980299,name:'毫不相干的正式名',effectText:'被提议的卡文'}];
  const {result}=await run({catalog,select:null,mentions:[{...pending(),name:'毫不相干的正式名'}],
    results:Array.from({length:4},(_,i)=>({cid:980210+i,cn_name:`百鸽候选${i}`,text:{desc:`百鸽卡文${i}`}}))});
  const offered=result.candidateConfirmation.candidateSets[0].candidates.map(card=>card.cid);
  assert.equal(offered.length,6);
  assert.ok(offered.includes('980299'));
  assert.equal(result.cardResolution.resolvedCards.length,0);
});

test('selector candidates show the catalog card kind',async()=>{
  const catalog=[{id:'980301',cid:980301,name:'匿名场地',cardType:'spell',property:'field',properties:['field'],effectText:'场地卡文'}];
  const {result}=await run({catalog,select:null,mentions:[{...pending(),name:'匿名场地'}]});
  assert.equal(result.candidateConfirmation.candidateSets[0].candidates[0].typeLine,'spell/field');
});

test('numbered Baige fallback cannot exceed the actual two-request question limit',async()=>{
  const {result,requests}=await run({mentions:[pending('No. 987'),pending('CNo. 988')],select:null});
  assert.equal(requests.length,2);
  assert.equal(result.candidateConfirmation.searchRequestCount,2);
});

test('empty catalogs and search results cannot trigger a candidate-selection call',async()=>{
  const {result,tasks}=await run({catalog:[]});
  assert.equal(tasks.length,1);
  assert.equal(result.cardResolution.unresolvedMentions.length,1);
  assert.equal(result.candidateConfirmation.modelCallCount,0);
});

test('real name index supplies a candidate without deciding a nickname identity',async()=>{
  const catalog=(await loadPreparedRagCardData()).cards;
  const {result,tasks}=await run({catalog,query:'死亡向导的效果怎么处理？',mentions:[pending('死亡向导')],select:null});
  assert.equal(tasks.length,2);
  assert.ok(result.candidateConfirmation.candidateSets[0].candidates.some(card=>String(card.cid)==='9702'));
  assert.equal(result.cardResolution.resolvedCards.length,0);
});

test('another confirmed card cannot erase a declined mention by substring or parenthetical matching',async()=>{
  const {result}=await run({mentions:[{name:cards[0].name,originalText:cards[0].name},pending('匿名确认'),pending('简称（匿名确认甲）')],select:null});
  const evidence=await retrieveRagEvidence({userQuery:result.query,cardResolution:result.cardResolution,cards,
    records:[],qaRecords:[],env,preparedEvidenceProvider:async value=>value,
    fetchImpl:()=>{throw Error('pending_owned_by_model_must_not_be_researched');}});
  assert.deepEqual(evidence.cardResolution.unresolvedMentions.map(mention=>mention.input),['匿名确认','简称（匿名确认甲）']);
});

test('local and external records are deduplicated by CID and capped at six per mention',async()=>{
  const catalog=Array.from({length:4},(_,i)=>({id:String(981100+i),cid:981100+i,name:`匿名本地卡${i}`}));
  const external=[{cid:981100,id:12300000,cn_name:'匿名本地卡0'},
    ...Array.from({length:3},(_,i)=>({cid:981200+i,id:12300001+i,cn_name:`匿名外部卡${i}`,text:{desc:'外部完整卡文。'}}))];
  const {result}=await run({catalog,results:external,select:null});
  const candidates=result.candidateConfirmation.candidateSets[0].candidates;
  assert.equal(candidates.length,6);
  assert.equal(new Set(candidates.map(card=>String(card.cid))).size,6);
  assert.equal(result.cardResolution.resolvedCards.length,0);
});

test('an invalidated preload still consumes the question confirmation allowance',async()=>{
  const {result,tasks,requests}=await run({select:null});
  const prepared=await answerRagRulingQuestion({question:result.query,cards,records:[],qaRecords:[],env:{...env,
    RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',GEMINI_RULE_QA_ENABLED:'true'},
    preloadedCardNameExtraction:result,prepareForContinuation:true,
    cardModelInvoker:async request=>{
      tasks.push(request);
      return request.task==='card_name_extraction'
        ? {cardNames:[pending()],groupMentions:[]}
        : {selections:[{mentionId:'M1',candidateId:null}]};
    },fetchImpl:async url=>{
      requests.push(String(url));
      return new Response(JSON.stringify({result:[],next:0}),{headers:{'content-type':'application/json'}});
    },geminiEvidenceProvider:{async retrieve({cardResolution}){
      assert.equal(cardResolution.resolvedCards.length,0);
      assert.equal(cardResolution.unresolvedMentions[0].input,'匿名简称');
      return {evidence:{cardTexts:[],cardResolution},packing:{prompt:'fixture',promptChars:7,
        modelEvidence:{},allowedEvidenceIds:[],warnings:[]},telemetry:{}};
    }},cloudBudget:{snapshot:()=>({calls:[]})}});
  assert.equal(prepared.status,'evidence_prepared');
  assert.deepEqual(tasks.map(request=>request.task),['card_name_extraction','card_identity_selection','card_name_extraction']);
  assert.equal(requests.length,1);
});
