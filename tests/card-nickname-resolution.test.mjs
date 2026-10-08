import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractRagCards } from '../backend/ragCardExtractor.mjs';
import { retrieveRagEvidence } from '../backend/ragEvidenceRetriever.mjs';
import { buildCardNicknameReferences, applyCardNicknameResolution,
  hasSourceBoundNicknameIdentity } from '../backend/ragCardNicknames.mjs';

const realCards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url))).records
  .filter(card => ['16524', '23548'].includes(String(card.id)));
assert.equal(realCards.length, 2);
const blueCards = [
  { id: 'blue-a', name: '蓝色候选甲', cnName: '蓝色候选甲', aliases: [], effectText: 'BLUE_A_TEXT' },
  { id: 'blue-b', name: '蓝色候选乙', cnName: '蓝色候选乙', aliases: [], effectText: 'BLUE_B_TEXT' },
];
const cards = [...realCards, ...blueCards];
const dataset = {
  schemaVersion: 1,
  sources: [{ id: 'synthetic-test-map', url: 'https://example.invalid/nicknames', revision: 'fixture-v1', license: 'test-only' }],
  entries: [['毁灭凤凰人', '16524'], ['龟G', '23548'], ['小蓝', 'blue-a'], ['小蓝', 'blue-b']]
    .map(([alias, cardId]) => ({ alias, cardId, sourceId: 'synthetic-test-map' })),
};

function resolve(input, name = input, { question = `${input}的效果如何处理？`, sourceCards = cards,
  sourceDataset = dataset, extraCandidates = [] } = {}) {
  const references = buildCardNicknameReferences(question, sourceCards, sourceDataset);
  const raw = extractRagCards(question, { cards: sourceCards, mentionSetSource: 'typed_model',
    modelCardNameCandidates: [{ name, originalText: input, confidence: 'high' }, ...extraCandidates] });
  return { question, references, raw,
    result: applyCardNicknameResolution(raw, { query: question, cards: sourceCards, references }) };
}

test('references contain only bound names and actual query fragments, without card text', () => {
  const refs = buildCardNicknameReferences('毁灭凤凰人和龟Ｇ如何处理？', cards, dataset);
  assert.deepEqual(refs.map(ref => [ref.input, ref.cardId]), [['毁灭凤凰人', '16524'], ['龟Ｇ', '23548']]);
  assert(refs.every(ref => ref.sources[0].revision === 'fixture-v1'));
  assert(refs.every(ref => !Object.hasOwn(ref, 'effectText')));
  assert.equal(buildCardNicknameReferences('无昵称的问题', cards, dataset).length, 0);
  assert.equal(buildCardNicknameReferences('龟G', cards, { ...dataset, sources: [] }).length, 0);
  assert.equal(buildCardNicknameReferences('龟G', [], dataset).length, 0);
});

test('Latin nickname boundaries and longer literal mentions do not create substring identities', () => {
  assert.equal(buildCardNicknameReferences('龟GX的效果', cards, dataset).length, 0);
  const longer = { id: 'long-blue', name: '大型小蓝龙', aliases: [], effectText: 'LONG' };
  const sourceCards = [...cards, longer];
  assert.equal(buildCardNicknameReferences('大型小蓝龙的效果', sourceCards, dataset).length, 0);
  assert.equal(buildCardNicknameReferences('大型小蓝龙与小蓝', sourceCards, dataset).length, 2);
  const { result } = resolve('大型小蓝龙', '大型小蓝龙', { sourceCards });
  assert.deepEqual(result.resolvedCards.map(card => card.id), ['long-blue']);
});

for (const [id, input] of [['16524', '毁灭凤凰人'], ['23548', '龟G']]) {
  for (const output of ['surface', 'canonical']) test(`${input}: model ${output} name resolves its source-bound local card`, async () => {
    const canonical = cards.find(card => card.id === id);
    const { question, raw, result } = resolve(input, output === 'surface' ? input : canonical.cnName || canonical.name);
    assert.equal(raw.resolvedCards.length, 0, 'the existing extractor alone cannot resolve this nickname');
    assert.deepEqual(result.resolvedCards.map(card => card.id), [id]);
    const resolved = result.resolvedCards[0];
    assert.equal(resolved.input, input);
    assert.equal(resolved.effectText, canonical.effectText);
    assert.equal(resolved.aliases.includes(input), false, 'do not manufacture a canonical alias');
    assert.equal(resolved.identityVerificationStatus, undefined);
    assert.equal(hasSourceBoundNicknameIdentity(resolved, cards), true);
    let fetches = 0;
    const evidence = await retrieveRagEvidence({ userQuery: question, cardResolution: result,
      cards, records: [], qaRecords: [], env: { RAG_LIVE_OFFICIAL_QA: 'false' },
      preparedEvidenceProvider: async evidence => evidence,
      fetchImpl: async () => { fetches++; throw Error('nickname_test_network_forbidden'); } });
    assert.equal(fetches, 0);
    assert.equal(evidence.cardResolution.resolvedCards[0].id, id);
    assert.equal(evidence.cardResolution.unresolvedMentions.length, 0);
    assert.equal(evidence.cardTexts.length, 1);
    assert(evidence.cardTexts[0].text.includes(canonical.effectText));
  });
}

test('ambiguous nickname remains ambiguous until the model selects an exact canonical candidate name', () => {
  const unresolved = resolve('小蓝').result;
  assert.equal(unresolved.resolvedCards.length, 0);
  assert.deepEqual(unresolved.ambiguousMentions[0].candidateCards.map(card => card.id), ['blue-a', 'blue-b']);
  const selected = resolve('小蓝', '蓝色候选乙').result;
  assert.deepEqual(selected.resolvedCards.map(card => card.id), ['blue-b']);
  assert.equal(selected.ambiguousMentions.length, 0);
  const unrelated = resolve('小蓝', '完全无关卡名');
  assert.strictEqual(unrelated.result, unrelated.raw);
});

test('references never add cards that the typed model omitted or classified as a group', () => {
  const query = '毁灭凤凰人与小蓝', references = buildCardNicknameReferences(query, cards, dataset);
  const raw = extractRagCards(query, { cards, modelCardNameCandidates: [], mentionSetSource: 'typed_model' });
  assert.strictEqual(applyCardNicknameResolution(raw, { query, cards, references }), raw);
  const legacy = { ...raw, mentionSetSource: 'query_scan' };
  assert.strictEqual(applyCardNicknameResolution(legacy, { query, cards, references }), legacy);
});

test('canonical name or existing alias collisions remain explicit ambiguities', () => {
  for (const conflict of [{ id: 'collision', name: '龟G', aliases: [] },
    { id: 'collision', name: '另一张卡', aliases: ['龟G'] }]) {
    const sourceCards = [...cards, { ...conflict, effectText: 'COLLISION_TEXT' }];
    const result = resolve('龟G', cards.find(card => card.id === '23548').cnName, { sourceCards }).result;
    assert.equal(result.resolvedCards.length, 0);
    assert.deepEqual(result.ambiguousMentions[0].candidateCards.map(card => card.id).sort(), ['23548', 'collision']);
  }
});

test('serialized, forged, changed or stale references cannot authorize nickname resolution', () => {
  const query = '龟G的效果', references = buildCardNicknameReferences(query, cards, dataset);
  const raw = extractRagCards(query, { cards, mentionSetSource: 'typed_model',
    modelCardNameCandidates: [{ name: '龟G', originalText: '龟G' }] });
  for (const refs of [structuredClone(references), [{ ...references[0], cardId: '16524' }]]) {
    assert.strictEqual(applyCardNicknameResolution(raw, { query, cards, references: refs }), raw);
  }
  assert.strictEqual(applyCardNicknameResolution(raw, { query: '不同问题', cards, references }), raw);
  references[0].cardId = '16524';
  assert.strictEqual(applyCardNicknameResolution(raw, { query, cards, references }), raw);
});

test('resolution proof is non-serializable and detects identity or canonical-record changes', () => {
  const resolved = resolve('龟G').result.resolvedCards[0];
  assert.equal(hasSourceBoundNicknameIdentity({ ...resolved }, cards), false);
  assert.equal(hasSourceBoundNicknameIdentity(structuredClone(resolved), cards), false);
  assert.equal(hasSourceBoundNicknameIdentity(resolved, cards.filter(card => card.id !== '23548')), false);
  assert.equal(hasSourceBoundNicknameIdentity(resolved, cards.map(card => card.id === '23548'
    ? { ...card, name: 'changed' } : card)), false);
  resolved.input = '别的昵称';
  assert.equal(hasSourceBoundNicknameIdentity(resolved, cards), false);
});

test('proof survives the actual retrieval path before an otherwise required edit-distance check', async () => {
  const sourceCards = [{ id: '77701', name: '合成名称乙', aliases: ['合成名称乙'], effectText: 'SOURCED_LOCAL_BODY' }];
  const sourceDataset = { ...dataset, entries: [{ alias: '合成名称甲', cardId: '77701', sourceId: 'synthetic-test-map' }] };
  const { question, result } = resolve('合成名称甲', '合成名称乙', { sourceCards, sourceDataset });
  assert.equal(hasSourceBoundNicknameIdentity(result.resolvedCards[0], sourceCards), true);
  let fetches = 0;
  const evidence = await retrieveRagEvidence({ userQuery: question, cardResolution: result,
    cards: sourceCards, records: [], qaRecords: [], env: { RAG_LIVE_OFFICIAL_QA: 'false' },
    preparedEvidenceProvider: async evidence => evidence,
    fetchImpl: async () => { fetches++; throw Error('unexpected_identity_lookup'); } });
  assert.equal(fetches, 0, 'the WeakMap-bound object must reach the retriever identity guard');
  assert.equal(evidence.cardTexts.length, 1);
  assert(evidence.cardTexts[0].text.includes('SOURCED_LOCAL_BODY'));
});
