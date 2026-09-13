import assert from 'node:assert/strict';
import test from 'node:test';
import { clearBaigeSearchCache } from '../backend/baigeCardProvider.mjs';
import { retrieveRagEvidence } from '../backend/ragEvidenceRetriever.mjs';
import { answerRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';

const first = { id: 10000001, cid: 99001, cn_name: '测试候选☆甲', text: {types:'[怪兽|效果] 兽/光\n[★1] 100/100', desc:'甲的完整原始卡文。\n第二段。'}, data:{type:33,atk:100,def:100,level:1,race:16384,attribute:4} };
const second = { ...first, id:10000002, cid:99002, cn_name:'测试候选★甲奖励', text:{...first.text,desc:'乙的完整原始卡文。'} };
const surface = '测试候选甲';
const localCards = [{id:'99001',passcode:'10000001',cid:99001,name:'本地译名甲',aliases:['本地译名甲'],effectText:first.text.desc}];
async function retrieve({selector,raw=[first,second],input=surface}={}) {
  clearBaigeSearchCache();
  return retrieveRagEvidence({userQuery:`${input}的处理如何？`,cardResolution:{resolvedCards:[],unresolvedMentions:[{input,source:'model_card_name_extractor',reason:'model_candidate_not_found',searchTexts:[]}],ambiguousMentions:[]},cards:localCards,records:[],qaRecords:[],identityOnly:true,
    cardIdentitySelectionProvider:selector,
    fetchImpl:async()=>new Response(JSON.stringify({result:raw,next:0}),{headers:{'content-type':'application/json'}}),env:{BAIGE_CACHE_TTL_MS:'1'}});
}

test('pending provider candidates reach one model selection and selected stable identity retains canonical body', async()=>{
  let calls=0;
  const result=await retrieve({selector:async({candidateSets})=>{
    calls++;
    assert.equal(candidateSets.length,1);
    assert.equal(candidateSets[0].surface,surface);
    assert.equal(candidateSets[0].candidates.length,2);
    const candidate=candidateSets[0].candidates.find(row=>String(row.cid)==='99001');
    assert.equal(candidate.effectText,first.text.desc);
    return [{mentionId:candidateSets[0].mentionId,candidateId:candidate.candidateId}];
  }});
  assert.equal(calls,1);
  assert.equal(result.cardResolution.resolvedCards.length,1);
  const card=result.cardResolution.resolvedCards[0];
  assert.equal(card.id,'99001');
  assert.equal(card.passcode,'10000001');
  assert.equal(card.effectText,first.text.desc);
  assert.equal(card.input,surface);
  assert.equal(card.identityVerificationSource,'model_candidate_selection');
  assert.deepEqual(result.cardResolution.unresolvedMentions,[]);
  assert.deepEqual(result.cardResolution.ambiguousMentions,[]);
});

test('model null selection leaves pending candidate identities intact',async()=>{
  const result=await retrieve({selector:async({candidateSets})=>[{mentionId:candidateSets[0].mentionId,candidateId:null}]});
  assert.equal(result.cardResolution.resolvedCards.length,0);
  assert.equal(result.cardResolution.unresolvedMentions[0].input,surface);
});

test('unknown candidate reference never materializes a card',async()=>{
  const result=await retrieve({selector:async({candidateSets})=>[{mentionId:candidateSets[0].mentionId,candidateId:'C999'}]});
  assert.equal(result.cardResolution.resolvedCards.length,0);
});

test('exact provider identity needs no candidate-selection model',async()=>{
  let calls=0;
  const result=await retrieve({input:first.cn_name,selector:async()=>{calls++;return [];}});
  assert.equal(calls,0);
  assert.equal(result.cardResolution.resolvedCards[0].id,'99001');
});

test('empty provider result needs no candidate-selection model',async()=>{
  let calls=0;
  const result=await retrieve({raw:[],selector:async()=>{calls++;return [];}});
  assert.equal(calls,0);
  assert.equal(result.cardResolution.resolvedCards.length,0);
});

test('production pipeline selects the pending identity before Gemini packs the same confirmed card',async()=>{
  clearBaigeSearchCache();
  const tasks=[];
  let packedCard;
  const prepared=await answerRagRulingQuestion({
    question:`${surface}的处理如何？`,cards:localCards,records:[],qaRecords:[],prepareForContinuation:true,
    cardModelInvoker:async({task})=>{
      tasks.push(task);
      return task==='card_name_extraction'
        ? JSON.stringify({cardNames:[{name:surface,originalText:surface,confidence:'high'}],groupMentions:[]})
        : JSON.stringify({selections:[{mentionId:'M1',candidateId:'C1'}]});
    },
    geminiEvidenceProvider:{async retrieve(input){
      packedCard=input.cardResolution.resolvedCards[0];
      assert.equal(packedCard?.id,'99001');
      assert.equal(packedCard.effectText,first.text.desc);
      assert.deepEqual(input.cardResolution.unresolvedMentions,[]);
      const evidence={...input.retrievedEvidence};
      const packing=input.packEvidence(evidence);
      return {evidence,packing};
    }},
    cloudBudget:{snapshot:()=>({calls:[]})},
    env:{RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',GEMINI_RULE_QA_ENABLED:'true',RAG_LIVE_OFFICIAL_QA:'false'},
    fetchImpl:async()=>new Response(JSON.stringify({result:[first,second],next:0}),{headers:{'content-type':'application/json'}}),
  });
  assert.deepEqual(tasks,['card_name_extraction','card_identity_selection']);
  assert.equal(prepared.status,'evidence_prepared');
  assert.equal(prepared.continuation.cardResolution.resolvedCards[0].id,packedCard.id);
});
