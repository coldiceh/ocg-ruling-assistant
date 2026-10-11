import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizePreparedRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';
import { presentPublicAnswer, PUBLIC_REQUEST_CHANNELS } from '../backend/publicAnswerPresentation.mjs';

async function finalize(cardResolution) {
  const saved = structuredClone(cardResolution);
  let calls = 0;
  const result = await finalizePreparedRagRulingQuestion({
    continuation: {
      schemaVersion: 1,
      mode: 'cloud_evidence_v1',
      promptBundle: { prompt: 'Synthetic saved prompt', modelEvidence: {}, allowedEvidenceIds: [] },
      evidence: {},
      cardResolution,
    },
    env: { RAG_MODEL_PROVIDER: 'mock' },
    modelInvoker: async () => { calls++; return '原有模型回答。'; },
    fetchImpl: async () => { throw new Error('network is not allowed in this presentation test'); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(cardResolution, saved);
  return result;
}

test('final answer exposes every pending identity in ordinary API text without confirming candidates', async () => {
  const resolvedCards = [{ id: 'confirmed', name: '已确认测试卡' }];
  const result = await finalize({
    resolvedCards,
    unresolvedMentions: [{ input: '未收录名称' }, { input: '简称' }, { input: '未收录名称' }],
    ambiguousMentions: [
      { input: '简称', candidateCards: [{ id: 'a', name: '候选甲' }, { id: 'b', name: '候选乙' }] },
      { input: '简称', candidateCards: [{ id: 'b', name: '候选乙' }, { id: 'c', name: '候选丙' }] },
      { input: '单候选简称', candidateCards: [{ id: 'd', name: '唯一搜索候选' }] },
    ],
  });
  const lines = [
    '「未收录名称」尚未确认。请补充完整卡名、卡号或卡片原文。',
    '「简称」尚未确认。现有候选（未确认）：候选甲、候选乙、候选丙。请补充完整卡名、卡号或卡片原文。',
    '「单候选简称」尚未确认。现有候选（未确认）：唯一搜索候选。请补充完整卡名、卡号或卡片原文。',
  ];
  assert.equal(result.shortAnswer, `原有模型回答。\n\n卡片身份待确认：\n${lines.map(line => `- ${line}`).join('\n')}`);
  for (const line of lines) assert.ok(result.missingInfo.includes(line));
  assert.deepEqual(result.resolvedCards.map(card => card.id), ['confirmed']);
  const { debug, ...ordinaryAnswer } = result;
  const publicAnswer = presentPublicAnswer(ordinaryAnswer, { channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API, env: {} });
  assert.equal(publicAnswer.shortAnswer, `${result.shortAnswer}\n\n网页端体验完整内容：https://coldiceh.github.io/ocg-ruling-assistant/`);
});

test('final answer with no pending identities preserves the original answer text', async () => {
  const result = await finalize({ resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] });
  assert.equal(result.shortAnswer, '原有模型回答。');
});

test('final answer shows model interpretation and both catalog names without another model request', async () => {
  const result=await finalize({resolvedCards:[{id:'22588',input:'密告',name:'神之密告',cnName:'神之密告',
    enName:'Solemn Accusation',resolutionSource:'model_canonical_exact'}],unresolvedMentions:[],ambiguousMentions:[]});
  assert.equal(result.shortAnswer,'原有模型回答。\n\n本次按以下卡片理解：密告 → 神之密告（Solemn Accusation）。');
});

test('a card typed by one of its formal names is not restated, while an interpreted card in the same answer is', async () => {
  const result=await finalize({resolvedCards:[
    {id:'4842',input:'Monster Reborn',name:'死者苏生',cnName:'死者苏生',enName:'Monster Reborn',resolutionSource:'model_canonical_exact'},
    {id:'22588',input:'密告',name:'神之密告',cnName:'神之密告',enName:'Solemn Accusation',resolutionSource:'model_canonical_exact'},
  ],unresolvedMentions:[],ambiguousMentions:[]});
  assert.equal(result.shortAnswer,'原有模型回答。\n\n本次按以下卡片理解：密告 → 神之密告（Solemn Accusation）。');
  const exactOnly=await finalize({resolvedCards:[{id:'4842',input:'死者苏生',name:'死者苏生',cnName:'死者苏生',
    enName:'Monster Reborn',resolutionSource:'model_canonical_exact'}],unresolvedMentions:[],ambiguousMentions:[]});
  assert.equal(exactOnly.shortAnswer,'原有模型回答。');
});
