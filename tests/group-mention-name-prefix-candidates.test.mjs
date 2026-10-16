import test from 'node:test';
import assert from 'node:assert/strict';
import {findCatalogNamePrefixCandidates} from '../backend/ragCardExtractor.mjs';
import {startCardNameExtraction} from '../backend/ragRulingPipeline.mjs';
import {clearBaigeSearchCache} from '../backend/baigeCardProvider.mjs';
import {loadPreparedRagCardData} from '../backend/ragEvidenceRetriever.mjs';

// Fixtures check mechanical catalog listing and routing only. Selections are
// scripted; they do not show which card a real model selects.
const env = {RAG_CARD_MODEL_PROVIDER: 'bai', BAI_CARD_ENABLED: 'true', BAI_CARD_API_KEY: 'fixture',
  RAG_LIVE_OFFICIAL_QA: 'false', API_BUDGET_MODE: 'off'};
const catalog = [
  {id: '970001', cid: 970001, name: '匿名－前缀 甲', enName: 'Anon Prefix Alpha', cardType: 'monster',
    aliases: ['匿名－前缀 甲', '匿名前缀 阿尔法'], effectText: '甲的卡文。'},
  {id: '970002', cid: 970002, name: '另一张卡', enName: 'Another Card', cardType: 'spell', effectText: '乙的卡文。'},
  {id: '970003', cid: 970003, name: '含有匿名前缀的卡', enName: 'Infix Card', cardType: 'trap', effectText: '丙的卡文。'},
];

const setsOf = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('候选集：') + '候选集：'.length));

async function run({question, extraction, cards = catalog, choose = () => null}) {
  clearBaigeSearchCache();
  const tasks = [], requests = [];
  const result = await startCardNameExtraction({question, cards, env,
    cardModelInvoker: async request => {
      tasks.push(request);
      if (request.task === 'card_name_extraction') return extraction;
      return {selections: setsOf(request.prompt).map(set => ({mentionId: set.mentionId,
        candidateId: set.candidates.find(candidate => candidate.cid === choose(set.surface))?.candidateId ?? null}))};
    },
    fetchImpl: async url => {
      requests.push(String(url));
      return new Response(JSON.stringify({result: [], next: 0}), {headers: {'content-type': 'application/json'}});
    }});
  return {result, tasks: tasks.map(task => task.task), prompts: tasks.map(task => task.prompt), requests};
}

const another = {name: '另一张卡', enName: 'Another Card', originalText: '另一张卡', confidence: 'high'};
const prefixQuestion = '对方场上有匿名前缀，另一张卡能把它作为对象吗？';

test('catalog name-prefix listing reads stored record names and proposes nothing when broad or empty', () => {
  assert.deepEqual(findCatalogNamePrefixCandidates(catalog, '匿名前缀'), ['970001']);
  assert.deepEqual(findCatalogNamePrefixCandidates(catalog, '匿名前缀 阿尔法'), ['970001']);
  assert.deepEqual(findCatalogNamePrefixCandidates(catalog, '前缀'), []);
  assert.deepEqual(findCatalogNamePrefixCandidates(catalog, ''), []);
  const broad = Array.from({length: 7}, (_, i) => ({id: `97010${i}`, name: `宽泛系列·${i}号`}));
  assert.deepEqual(findCatalogNamePrefixCandidates(broad, '宽泛系列'), []);
  assert.equal(findCatalogNamePrefixCandidates(broad.slice(0, 6), '宽泛系列').length, 6);
});

test('an unreferenced group surface reaches the one selection call and binds only through it', async () => {
  const {result, tasks, prompts} = await run({question: prefixQuestion,
    extraction: {cardNames: [another], groupMentions: ['匿名前缀'], describedCards: []},
    choose: surface => surface === '匿名前缀' ? '970001' : null});
  assert.deepEqual(tasks, ['card_name_extraction', 'card_identity_selection']);
  const offered = setsOf(prompts[1]).find(set => set.surface === '匿名前缀');
  assert.ok(offered.candidates.some(candidate => candidate.cid === '970001'));
  assert.deepEqual(result.cardResolution.resolvedCards.map(card => [card.id, card.input, card.resolutionSource]), [
    ['970002', '另一张卡', 'model_canonical_exact'],
    ['970001', '匿名前缀', 'model_candidate_selection'],
  ]);
  assert.equal(result.cardResolution.resolvedCards[1].effectText, '甲的卡文。');
  assert.deepEqual(result.cardResolution.unresolvedMentions, []);
  assert.equal(result.candidateConfirmation.modelCallCount, 1);
});

test('a declined group surface returns to the extractor classification instead of staying pending', async () => {
  const {result, tasks} = await run({question: prefixQuestion,
    extraction: {cardNames: [another], groupMentions: ['匿名前缀'], describedCards: []}});
  assert.deepEqual(tasks, ['card_name_extraction', 'card_identity_selection']);
  assert.deepEqual(result.cardResolution.resolvedCards.map(card => card.id), ['970002']);
  assert.deepEqual(result.cardResolution.unresolvedMentions, []);
  assert.deepEqual(result.cardResolution.ambiguousMentions, []);
  assert.deepEqual(result.cardNameModel.groupMentions, ['匿名前缀']);
});

test('a group surface the extractor saw a catalog reference for keeps its classification', async () => {
  const {result, tasks, prompts} = await run({question: '匿名－前缀 甲和另一张卡怎么处理？',
    extraction: {cardNames: [another], groupMentions: ['匿名－前缀 甲'], describedCards: []},
    choose: () => '970001'});
  assert.match(prompts[0], /"input":"匿名[-－]前缀 甲"/u, 'the surface must have been shown as a reference');
  assert.deepEqual(tasks, ['card_name_extraction']);
  assert.deepEqual(result.cardResolution.resolvedCards.map(card => card.id), ['970002']);
});

test('broad, absent or nested group surfaces add no selection work', async () => {
  const broad = [...catalog, ...Array.from({length: 7}, (_, i) => ({id: `97020${i}`, cid: 970200 + i,
    name: `宽泛系列·${i}号`, effectText: `宽泛卡文${i}`}))];
  for (const [question, groupMentions] of [
    ['宽泛系列怪兽被另一张卡作为对象怎么办？', ['宽泛系列']],
    ['另一张卡怎么处理？', ['匿名前缀']],
    ['另一张卡怎么处理？', ['另一张']],
  ]) {
    const {result, tasks, requests} = await run({question, cards: broad,
      extraction: {cardNames: [another], groupMentions, describedCards: []}, choose: () => '970001'});
    assert.deepEqual(tasks, ['card_name_extraction'], question);
    assert.equal(requests.length, 0, question);
    assert.deepEqual(result.cardResolution.resolvedCards.map(card => card.id), ['970002'], question);
    assert.deepEqual(result.cardResolution.unresolvedMentions, [], question);
  }
});

// Reported 2026-10-16: two names written without their suffix were answered
// with "missing card text"; the extractor can file such surfaces as groups.
test('real catalog: suffix-less group surfaces are offered with their catalog owners', async () => {
  const {cards} = await loadPreparedRagCardData();
  assert.deepEqual(findCatalogNamePrefixCandidates(cards, '对极英雄'), ['11310']);
  assert.deepEqual(findCatalogNamePrefixCandidates(cards, '超越召唤兽'), ['22982']);
  assert.deepEqual(findCatalogNamePrefixCandidates(cards, '元素英雄'), []);
  assert.deepEqual(findCatalogNamePrefixCandidates(cards, '召唤兽'), []);
  const expected = {'对极英雄': '11310', '超越召唤兽': '22982'};
  const {result, tasks, prompts, requests} = await run({cards,
    question: '对方场上有对极英雄和毁灭凤凰人，我可以用超融合把这两只怪融合成超越召唤兽吗？',
    extraction: {cardNames: [
      {name: '命运－英雄 毁灭不死鸟魔侠', enName: 'Destiny HERO - Destroyer Phoenix Enforcer', originalText: '毁灭凤凰人'},
      {name: '超融合', enName: 'Super Polymerization', originalText: '超融合'},
    ], groupMentions: ['对极英雄', '超越召唤兽'], describedCards: []},
    choose: surface => expected[surface] ?? null});
  assert.deepEqual(tasks, ['card_name_extraction', 'card_identity_selection']);
  assert.ok(requests.length <= 2);
  assert.deepEqual(setsOf(prompts[1]).map(set => set.surface), ['对极英雄', '超越召唤兽']);
  assert.deepEqual(result.cardResolution.resolvedCards.map(card => [String(card.id), card.input]).sort(), [
    ['11310', '对极英雄'], ['16524', '毁灭凤凰人'], ['22982', '超越召唤兽'], ['7445', '超融合'],
  ]);
  assert.deepEqual(result.cardResolution.unresolvedMentions, []);
});
