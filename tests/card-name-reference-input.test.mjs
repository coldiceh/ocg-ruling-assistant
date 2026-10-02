import test from 'node:test';
import assert from 'node:assert/strict';
import { answerRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';

test('typed extraction receives local card names as references without overriding its classification', async () => {
  const cards = [
    { id: 'reference-a', name: '合成参考甲', cnName: '合成参考甲', jaName: '参照甲',
      enName: 'Reference A', aliases: ['合成参考甲', '甲的别称'], effectText: '①：发动后将「只在卡文中引用」加入手卡。BODY_NOT_FOR_EXTRACTION_A' },
    { id: 'reference-b', name: '合成参考乙', cnName: '合成参考乙', jaName: '参照乙',
      enName: 'Reference B', aliases: ['合成参考乙'], effectText: 'BODY_NOT_FOR_EXTRACTION_B' },
    { id: 'text-reference', name: '只在卡文中引用', effectText: 'BODY_NOT_FOR_EXTRACTION_C' },
  ];
  let extractionPrompt;
  let observedResolution;
  let modelCalls = 0;
  await answerRagRulingQuestion({
    question: '合成参考甲与合成参考乙如何处理？', cards, records: [], qaRecords: [],
    prepareForContinuation: true,
    env: { RAG_CARD_MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'synthetic',
      RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1', GEMINI_RULE_QA_ENABLED: 'true' },
    cardModelInvoker: async ({ prompt }) => {
      modelCalls++;
      extractionPrompt = prompt;
      return JSON.stringify({ cardNames: [{ name: '合成参考甲', originalText: '合成参考甲' }],
        groupMentions: ['合成参考乙'] });
    },
    geminiEvidenceProvider: { async retrieve({ cardResolution }) {
      observedResolution = cardResolution;
      return { evidence: { cardTexts: [], cardResolution },
        packing: { prompt: 'fixture', promptChars: 7, modelEvidence: {}, allowedEvidenceIds: [], warnings: [] },
        telemetry: {} };
    } },
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    fetchImpl: async () => { throw Error('unexpected network'); },
  });
  // Inspect the actual extraction input, not a separately constructed prompt.
  const referenceLine = extractionPrompt.split('\n').find(line => line.startsWith('[{"input":'));
  assert.ok(referenceLine, 'local name references must reach the typed extraction request');
  assert.deepEqual(JSON.parse(referenceLine), cards.slice(0, 2).map(card => ({
    input: card.name, name: card.name, cnName: card.cnName, jaName: card.jaName,
    enName: card.enName, aliases: card.aliases,
  })));
  assert.equal(extractionPrompt.includes('BODY_NOT_FOR_EXTRACTION'), false);
  assert.equal(modelCalls, 1);
  assert.deepEqual(observedResolution.resolvedCards.map(card => card.id), ['reference-a']);
});
