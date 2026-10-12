import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRagCards} from '../backend/ragCardExtractor.mjs';
import {loadPreparedRagCardData, retrieveRagEvidence} from '../backend/ragEvidenceRetriever.mjs';
import {parseCardNameExtractionOutput, buildCardNameExtractionPrompt} from '../backend/ragModelClient.mjs';
import {applyCardNicknameResolution, buildCardNicknameReferences} from '../backend/ragCardNicknames.mjs';
import {loadCardNicknameData} from '../backend/ragCardNicknameData.mjs';

const ocg = (await loadPreparedRagCardData()).cards;
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

test('different model language names that bind different cards remain ambiguous',()=>{
  const result=extract('一个称呼',mention('一个称呼','神之警告',['Solemn Accusation']));
  assert.deepEqual(result.resolvedCards,[]);
  assert.equal(result.ambiguousMentions[0].candidateCards.length,2);
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
