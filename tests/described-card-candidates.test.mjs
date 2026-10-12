import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDescribedCards, findDescribedCardCandidates } from '../backend/ragDescribedCardCandidates.mjs';
import { buildCardNameExtractionPrompt, parseCardNameExtractionOutput } from '../backend/ragModelClient.mjs';
import { startCardNameExtraction } from '../backend/ragRulingPipeline.mjs';
import { clearBaigeSearchCache } from '../backend/baigeCardProvider.mjs';
import { loadPreparedRagCardData } from '../backend/ragEvidenceRetriever.mjs';

// Fixtures check mechanical catalog matching and routing only; they do not
// show that a real model reports the right series or kind.
const catalog = [
  { id: '990001', cid: 990001, name: '匿名工匠·小巷', enName: 'Anoncraft Bystreet', cardType: 'spell', property: 'continuous', effectText: '永续魔法卡文。' },
  { id: '990002', cid: 990002, name: '匿名工匠·夜行', enName: 'Anoncraft Walpurgis', cardType: 'spell', property: 'field', effectText: '场地魔法卡文。' },
  { id: '990003', cid: 990003, name: '匿名工匠·书匠', enName: 'Anoncraft Marka', cardType: 'monster', properties: ['Spellcaster', 'Effect'], effectText: '怪兽卡文。' },
  { id: '990004', cid: 990004, name: '别的场地', enName: 'Anoncrafty Field', cardType: 'spell', property: 'field', effectText: '另一张场地。' },
];

test('described cards keep only complete entries with a listed kind', () => {
  assert.deepEqual(normalizeDescribedCards([
    { originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' },
    { originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' },
    { originalText: '', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' },
    { originalText: '某卡', archetypeEnName: '', cardKind: 'field_spell' },
    { originalText: '某卡', archetypeEnName: 'Anoncraft', cardKind: 'favourite_card' },
    'not an object',
  ]), [{ originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }]);
});

test('catalog matching uses whole series words and stored card kind only', () => {
  assert.deepEqual(findDescribedCardCandidates(catalog, { archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }), ['990002']);
  assert.deepEqual(findDescribedCardCandidates(catalog, { archetypeEnName: 'anoncraft', cardKind: 'continuous_spell' }), ['990001']);
  assert.deepEqual(findDescribedCardCandidates(catalog, { archetypeEnName: 'Anoncraft', cardKind: 'monster' }), ['990003']);
  assert.deepEqual(findDescribedCardCandidates(catalog, { archetypeEnName: 'Anon', cardKind: 'field_spell' }), []);
  assert.deepEqual(findDescribedCardCandidates(catalog, { archetypeEnName: 'Anoncraft', cardKind: 'counter_trap' }), []);
});

test('a broad description above the candidate limit proposes nothing', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `99010${i}`, enName: `Anoncraft Field ${i}`, cardType: 'spell', property: 'field' }));
  assert.deepEqual(findDescribedCardCandidates(many, { archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }), []);
  assert.equal(findDescribedCardCandidates(many.slice(0, 6), { archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }).length, 6);
});

test('the extraction prompt asks for series and kind without a card name, and the parser keeps them', () => {
  const prompt = buildCardNameExtractionPrompt('测试问题', { typed: true });
  const line = prompt.split('\n').find(item => item.startsWith('describedCards'));
  assert.ok(line);
  assert.match(line, /这里不填具体卡名/u);
  assert.match(line, /field_spell/u);
  const parsed = parseCardNameExtractionOutput({ cardNames: [], groupMentions: ['匿名系列场地'],
    describedCards: [{ originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }] });
  assert.equal(parsed.typedMentionSetProvided, true);
  assert.deepEqual(parsed.describedCards, [{ originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }]);
  assert.deepEqual(parseCardNameExtractionOutput({ cardNames: [], groupMentions: [] }).describedCards, []);
});

test('a described card reaches confirmation as a proposal and binds only through selection', async () => {
  clearBaigeSearchCache();
  const tasks = [];
  const env = { RAG_CARD_MODEL_PROVIDER: 'bai', BAI_CARD_ENABLED: 'true', BAI_CARD_API_KEY: 'fixture',
    RAG_LIVE_OFFICIAL_QA: 'false', API_BUDGET_MODE: 'off' };
  const result = await startCardNameExtraction({ question: '我贴匿名系列场地被无效了，手里第二张还能贴吗？', cards: catalog, env,
    cardModelInvoker: async request => {
      tasks.push(request.task);
      if (request.task === 'card_name_extraction') return { cardNames: [], groupMentions: ['匿名系列场地'],
        describedCards: [{ originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }] };
      const sets = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('候选集：') + '候选集：'.length));
      const field = sets[0].candidates.find(candidate => candidate.cid === '990002');
      assert.ok(field, 'the described field spell must be offered');
      assert.equal(field.typeLine, 'spell/field');
      return { selections: [{ mentionId: sets[0].mentionId, candidateId: field.candidateId }] };
    },
    fetchImpl: async () => new Response(JSON.stringify({ result: [], next: 0 }), { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(tasks, ['card_name_extraction', 'card_identity_selection']);
  assert.deepEqual(result.cardResolution.resolvedCards.map(card => [card.id, card.input, card.resolutionSource]),
    [['990002', '匿名系列场地', 'model_candidate_selection']]);
  assert.deepEqual(result.cardResolution.unresolvedMentions, []);
});

test('a declined described card stays pending instead of binding its only catalog match', async () => {
  clearBaigeSearchCache();
  const env = { RAG_CARD_MODEL_PROVIDER: 'bai', BAI_CARD_ENABLED: 'true', BAI_CARD_API_KEY: 'fixture',
    RAG_LIVE_OFFICIAL_QA: 'false', API_BUDGET_MODE: 'off' };
  const result = await startCardNameExtraction({ question: '匿名系列场地怎么处理？', cards: catalog, env,
    cardModelInvoker: async request => request.task === 'card_name_extraction'
      ? { cardNames: [], groupMentions: ['匿名系列场地'],
        describedCards: [{ originalText: '匿名系列场地', archetypeEnName: 'Anoncraft', cardKind: 'field_spell' }] }
      : { selections: [{ mentionId: 'M1', candidateId: null }] },
    fetchImpl: async () => new Response(JSON.stringify({ result: [], next: 0 }), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.cardResolution.resolvedCards.length, 0);
  const pending = result.cardResolution.unresolvedMentions.find(mention => mention.input === '匿名系列场地');
  assert.deepEqual(pending.proposedCardIds, ['990002']);
  assert.equal(pending.reason, 'model_described_card');
});

test('the real catalog has exactly one Witchcrafter field spell', async () => {
  const { cards } = await loadPreparedRagCardData();
  assert.deepEqual(findDescribedCardCandidates(cards, { archetypeEnName: 'Witchcrafter', cardKind: 'field_spell' }), ['23168']);
});
