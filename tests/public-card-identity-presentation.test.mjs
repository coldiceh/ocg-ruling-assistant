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
  assert.equal(publicAnswer.shortAnswer, result.shortAnswer);
});

test('final answer with no pending identities preserves the original answer text', async () => {
  const result = await finalize({ resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] });
  assert.equal(result.shortAnswer, '原有模型回答。');
});
