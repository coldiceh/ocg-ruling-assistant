import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {extractRagCards} from '../backend/ragCardExtractor.mjs';
import {loadPreparedRagCardData, retrieveRagEvidence} from '../backend/ragEvidenceRetriever.mjs';
import {parseCardNameExtractionOutput, buildCardNameExtractionPrompt} from '../backend/ragModelClient.mjs';
import {applyCardNicknameResolution, buildCardNicknameReferences} from '../backend/ragCardNicknames.mjs';
import {loadCardNicknameData} from '../backend/ragCardNicknameData.mjs';
import {answerRagRulingQuestion} from '../backend/ragRulingPipeline.mjs';
import {confirmPendingCardCandidates} from '../backend/ragCardCandidateConfirmation.mjs';

const ocg = (await loadPreparedRagCardData()).cards;
const tcg = (await loadPreparedRagCardData(fileURLToPath(new URL('../data/tcg', import.meta.url)))).cards;
const mention = (originalText, name, canonicalNames) => ({originalText, name, confidence:'low',
  ...(canonicalNames ? {canonicalNames} : {})});
const extract = (input, candidate, options = {}) => extractRagCards(`${input}的效果如何处理？`, {
  cards:ocg, mentionSetSource:'typed_model', modelCardNameCandidates:[candidate], ...options,
});
// 2026-10-12 规则变更: a formal name the model supplies for other wording is a
// proposal for the confirmation step, not a binding. It binds at once only when
// the player's own wording is a catalog name of that card.
const assertProposal = (result, input, ids) => {
  assert.deepEqual(result.resolvedCards, []);
  const pending = [...result.unresolvedMentions, ...result.ambiguousMentions].find(item => item.input === input);
  assert.ok(pending, `${input} must stay pending`);
  assert.deepEqual([...pending.proposedCardIds].sort(), [...ids].sort());
};

for (const [input, name, id] of [
  ['密告', '神之密告', '22588'],
  ['神警', '神之警告', '9008'],
  ['增G', 'Maxx "C"', '9455'],
  ['死亡向导', '魔界发现世行死亡向导', '9702'],
]) {
  for (const mentionSetSource of ['typed_model','query_scan']) test(`${input}: a unique model canonical name is proposed, not bound (${mentionSetSource})`, () => {
    const result=extract(input, mention(input,name), {mentionSetSource});
    assertProposal(result, input, [id]);
    assert.equal(result.unresolvedMentions[0].reason,'model_canonical_name_unconfirmed');
  });
  test(`${input}: the formal name typed by the player binds the same card directly`, () => {
    const card=ocg.find(item=>item.id===id);
    const typed=card.cnName || card.name;
    const result=extract(typed, mention(typed,name));
    assert.deepEqual(result.resolvedCards.map(item=>item.id), [id]);
    assert.equal(result.resolvedCards[0].resolutionSource,'model_canonical_exact');
    assert.equal(result.resolvedCards[0].effectText,card.effectText);
    assert.deepEqual(result.unresolvedMentions,[]);
    assert.deepEqual(result.ambiguousMentions,[]);
  });
}

test('TCG Chinese mention bridges the exact OCG name by CID and emits only TCG card text', async () => {
  const result=extract('灰流丽',mention('灰流丽','灰流丽'),{cards:tcg,identityCards:ocg});
  assert.deepEqual(result.resolvedCards.map(card=>card.id),['12950']);
  const card=result.resolvedCards[0], canonical=tcg.find(card=>card.id==='12950');
  assert.equal(card.name,'Ash Blossom & Joyous Spring');
  assert.equal(card.input,'灰流丽');
  assert.equal(card.effectText,canonical.text);
  assert.equal(card.sourceUrl,canonical.sourceUrl);
  const evidence=await retrieveRagEvidence({userQuery:'灰流丽的效果如何处理？',
    cardResolution:result,cards:tcg,records:[],qaRecords:[],preparedEvidenceProvider:async evidence=>evidence,
    env:{RAG_RULE_SYSTEM:'TCG'},fetchImpl:()=>{throw new Error('offline_test_network_forbidden');}});
  assert.deepEqual(evidence.cardResolution.resolvedCards.map(card=>card.id),['12950']);
  assert.equal(evidence.cardTexts[0].text,canonical.text);
  assert.equal(evidence.cardTexts[0].ruleSystem,'TCG');
});

test('official English name binds TCG card directly',()=>{
  const result=extract('Goblindbergh',mention('Goblindbergh','Goblindbergh'),{cards:tcg,identityCards:ocg});
  assert.deepEqual(result.resolvedCards.map(card=>card.id),['9621']);
  assert.equal(result.resolvedCards[0].resolutionSource,'model_canonical_exact');
});

test('multilingual names survive model parsing and resolve one catalog identity',()=>{
  const parsed=parseCardNameExtractionOutput({cardNames:[mention('增G','增殖的G',['Maxx "C"','増殖するG'])],groupMentions:[]});
  assert.deepEqual(parsed.candidates[0].canonicalNames,['Maxx "C"','増殖するG']);
  const result=extract('增G',parsed.candidates[0]);
  assertProposal(result,'增G',['9455']);
});

// 2026-10-11 规则变更: originalText participates in the same mention's exact-name binding.
test('an exact originalText binds when the returned name is corrupted',()=>{
  const result=extract('灰流丽',mention('灰流丽','不存在的离线测试卡名称'));
  assert.deepEqual(result.resolvedCards.map(card=>card.id),['12950']);
  assert.deepEqual(result.unresolvedMentions,[]);
});

for (const field of ['enName','jaName','cnName']) test(`the ${field} field survives parsing and exact binding`,()=>{
  const card=ocg.find(card=>card.id==='9702');
  const parsed=parseCardNameExtractionOutput({cardNames:[{
    ...mention('死亡向导','损坏的名字'),[field]:card[field],
  }],groupMentions:[]});
  assert.equal(parsed.candidates[0][field],card[field]);
  const result=extract('死亡向导',parsed.candidates[0]);
  assertProposal(result,'死亡向导',['9702']);
});

test('same-identity fields deduplicate while different-identity fields stay ambiguous',()=>{
  const card=ocg.find(card=>card.id==='9702');
  const same=extract('死亡向导',{
    ...mention('死亡向导',card.name),enName:card.enName,jaName:card.jaName,cnName:card.cnName,
  });
  assertProposal(same,'死亡向导',['9702']);
  const different=extract('灰流丽',{
    ...mention('灰流丽','损坏的名字'),enName:card.enName,
  });
  assert.deepEqual(different.resolvedCards,[]);
  assert.deepEqual(different.ambiguousMentions[0].candidateCards.map(item=>item.id).sort(),['12950','9702']);
  assert.deepEqual([...different.ambiguousMentions[0].proposedCardIds].sort(),['12950','9702']);
});

test('unknown fields keep a mention unresolved without guessing a card',()=>{
  const result=extract('无法确认的简称',{
    ...mention('无法确认的简称','未知正式名'),enName:'Unidentified Official Name',
  });
  assert.deepEqual(result.resolvedCards,[]);
  assert.equal(result.unresolvedMentions[0].input,'无法确认的简称');
});

for (const typed of [true,false]) test(`the actual extraction JSON example contains multilingual fields (typed=${typed})`,()=>{
  const prompt=buildCardNameExtractionPrompt('测试问题',{typed});
  const example=prompt.split('\n').map(line=>{
    try{return JSON.parse(line.replace(/^只输出JSON：/u,'').split('。')[0]);}catch{return null;}
  }).find(item=>Array.isArray(item?.cardNames));
  assert.ok(example,'the prompt must include a parseable JSON example');
  for (const field of ['enName','jaName','cnName']) assert.equal(typeof example.cardNames[0][field],'string',field);
});

test('duplicate formal name across distinct identities remains ambiguous',()=>{
  const sample=ocg.find(card=>card.id==='22588');
  const cards=[sample,{...sample,id:'synthetic-collision',cardId:'synthetic-collision'}];
  const result=extract('密告',mention('密告','神之密告'),{cards});
  assert.deepEqual(result.resolvedCards,[]);
  assert.deepEqual(result.ambiguousMentions[0].candidateCards.map(card=>card.id).sort(),['22588','synthetic-collision']);
});

test('TCG availability cannot settle an ambiguous OCG identity',()=>{
  const original=ocg.find(card=>card.id==='12950');
  const identities=[original,{...original,id:'synthetic-ocg-only',cardId:'synthetic-ocg-only'}];
  const result=extract('中文称呼',mention('中文称呼','灰流丽'),{cards:tcg,identityCards:identities});
  assert.deepEqual(result.resolvedCards,[]);
  assert.equal(result.ambiguousMentions[0].candidateCards.length,2);
});

test('different model language names that bind different cards remain ambiguous',()=>{
  const result=extract('一个称呼',mention('一个称呼','神之警告',['Solemn Accusation']));
  assert.deepEqual(result.resolvedCards,[]);
  assert.equal(result.ambiguousMentions[0].candidateCards.length,2);
});

test('an OCG catalog identity absent from TCG remains unresolved without leaking OCG text',()=>{
  const tcgIds=new Set(tcg.map(card=>card.id));
  const card=ocg.find(card=>!tcgIds.has(card.id) && card.enName);
  assert.ok(card,'real snapshots must provide a catalog identity absent from TCG');
  const result=extract('原词',mention('原词',card.enName),{cards:tcg,identityCards:ocg});
  assert.deepEqual(result.resolvedCards,[]);
  assert.deepEqual(result.ambiguousMentions,[]);
  assert.equal(result.unresolvedMentions[0].input,'原词');
  assert.equal(result.unresolvedMentions[0].tcgAvailability,'not_collected');
  assert.equal(result.unresolvedMentions[0].reason,'tcg_card_not_collected');
});

test('source-bound 神宣 nickname keeps its existing resolution path',()=>{
  const query='神宣的效果如何处理？';
  const raw=extractRagCards(query,{cards:ocg,mentionSetSource:'typed_model',
    modelCardNameCandidates:[mention('神宣','神宣')]});
  const result=applyCardNicknameResolution(raw,{query,cards:ocg,
    references:buildCardNicknameReferences(query,ocg,loadCardNicknameData('OCG'))});
  assert.deepEqual(result.resolvedCards.map(card=>card.id),['4861']);
});

for (const mentionSetSource of ['typed_model','query_scan']) test(`model mentions do not union extra scan names (${mentionSetSource})`,()=>{
  const result=extractRagCards('密告与灰流丽的效果如何处理？',{cards:ocg,mentionSetSource,
    modelCardNameCandidates:[mention('密告','神之密告')]});
  assertProposal(result,'密告',['22588']);
  assert.ok(![...result.unresolvedMentions,...result.ambiguousMentions].some(item=>item.input==='灰流丽'));
});

test('a wrong formal name for an abbreviation stays a proposal instead of binding the wrong card',()=>{
  // Reported 2026-10-12: the extractor once named another catalog card for 密告.
  const wrong=ocg.find(card=>card.id==='5772');
  const result=extractRagCards('密告支1500炸了张场地 手里有第二张可以继续贴吗？',{cards:ocg,mentionSetSource:'typed_model',
    modelCardNameCandidates:[{...mention('密告支',wrong.cnName),enName:wrong.enName}]});
  assertProposal(result,'密告支',['5772']);
});

test('TCG production extraction bridges a Chinese canonical name in one extraction request',async()=>{
  const tasks=[];
  let observed;
  const prepared=await answerRagRulingQuestion({question:'灰流丽的效果如何处理？',ruleSystem:'TCG',
    cards:tcg,records:[],qaRecords:[],prepareForContinuation:true,
    env:{RAG_CARD_MODEL_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'synthetic',
      RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1',GEMINI_RULE_QA_ENABLED:'true'},
    cardModelInvoker:async request=>{
      tasks.push(request.task);
      assert.match(request.prompt,/当前规则体系：TCG/u);
      return {cardNames:[mention('灰流丽','灰流丽')],groupMentions:[]};
    },
    geminiEvidenceProvider:{async retrieve({cardResolution}){
      observed=cardResolution;
      return {evidence:{cardTexts:[],cardResolution},packing:{prompt:'fixture',promptChars:7,
        modelEvidence:{},allowedEvidenceIds:[],warnings:[]},telemetry:{}};
    }},cloudBudget:{snapshot:()=>({calls:[]})},
    fetchImpl:()=>{throw new Error('offline_test_network_forbidden');},
  });
  assert.deepEqual(tasks,['card_name_extraction']);
  assert.deepEqual(observed.resolvedCards.map(card=>card.id),['12950']);
  assert.equal(observed.resolvedCards[0].effectText,tcg.find(card=>card.id==='12950').text);
  assert.equal(observed.resolvedCards[0].ruleSystem,'TCG');
  assert.equal(prepared.status,'evidence_prepared');
});

test('TCG candidate confirmation borrows OCG names while candidate and selected bodies use only target text',async()=>{
  const query='死亡向导的效果怎么处理？';
  const result=await confirmPendingCardCandidates({userQuery:query,cards:tcg,identityCards:ocg,
    cardResolution:{resolvedCards:[],unresolvedMentions:[{input:'死亡向导'}],ambiguousMentions:[]},
    env:{RAG_RULE_SYSTEM:'TCG',BAI_CARD_API_KEY:'fixture',API_BUDGET_MODE:'off'},
    fetchImpl:async()=>new Response(JSON.stringify({result:[],next:0}),{headers:{'content-type':'application/json'}}),
    modelInvoker:async request=>{
      assert.equal(request.modelName,'gpt-6-luna');
      return {selections:[{mentionId:'M1',candidateId:'C1'}]};
    }});
  for(const candidate of result.candidateConfirmation.candidateSets[0].candidates) {
    const target=tcg.find(card=>String(card.id)===String(candidate.cid));
    assert.equal(candidate.effectText,target?.text||'');
  }
  const card=result.cardResolution.resolvedCards[0],target=tcg.find(card=>card.id==='9702');
  assert.equal(card.id,'9702');
  assert.equal(card.ruleSystem,'TCG');
  assert.equal(card.effectText,target.text);
  assert.equal(card.sourceUrl,target.sourceUrl);
});

test('a selected identity absent from the TCG catalog stays pending with no OCG candidate body',async()=>{
  const absent=ocg.find(card=>!tcg.some(target=>target.id===card.id));
  assert.ok(absent);
  const result=await confirmPendingCardCandidates({userQuery:'这个简称是哪张卡？',cards:[],identityCards:[absent],
    cardResolution:{resolvedCards:[],unresolvedMentions:[{input:'匿名桥接输入'}],ambiguousMentions:[]},
    env:{RAG_RULE_SYSTEM:'TCG',BAI_CARD_API_KEY:'fixture',API_BUDGET_MODE:'off'},
    fetchImpl:async()=>new Response(JSON.stringify({result:[],next:0}),{headers:{'content-type':'application/json'}}),
    modelInvoker:async()=>({selections:[{mentionId:'M1',candidateId:'C1'}]})});
  assert.equal(result.candidateConfirmation.candidateSets[0].candidates[0].effectText,'');
  assert.deepEqual(result.cardResolution.resolvedCards,[]);
  assert.equal(result.cardResolution.unresolvedMentions[0].input,'匿名桥接输入');
});
