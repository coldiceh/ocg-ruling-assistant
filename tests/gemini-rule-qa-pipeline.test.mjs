import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerRagRulingQuestion,
  finalizePreparedRagRulingQuestion,
} from '../backend/ragRulingPipeline.mjs';

test('Gemini rule and QA provider preserves its exact packing in the prepared continuation', async () => {
  const calls = [];
  const evidence = {
    cardTexts: [],
    userProvidedCardTexts: [],
    officialQaDirectCandidates: [],
    officialQaRelated: [],
    provisionalOfficialResponses: [],
    faqRelated: [],
    rawRelatedEvidence: [{ id: 'rule-unit-1', type: 'related', text: 'complete source body' }],
    rulebookCandidates: [],
    retrievedCards: [],
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    debug: { geminiRuleQa: { selectedRuleUnitIds: ['rule-unit-1'] } },
  };
  const packing = {
    prompt: 'EXACT_PROVIDER_PROMPT',
    promptChars: 21,
    modelEvidence: { rawRelatedEvidence: evidence.rawRelatedEvidence },
    allowedEvidenceIds: ['rule-unit-1'],
    warnings: [],
    promptTruncated: false,
  };
  const telemetry = {
    providerUsed: 'gemini',
    modelUsed: 'gemini-2.5-flash',
    tokenUsage: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
    informationNeeds: ['mechanical fixture'],
    generationProfileHash: 'frozen-profile-hash',
    generationContracts: { planning: { modelId: 'fixture' }, selection: { modelId: 'fixture' } },
    bundleRevision: 'frozen-bundle',
    timingsMs: { plan: 1, selection: 2 },
  };
  const prepared = await answerRagRulingQuestion({
    question: 'Synthetic integration question',
    cards: [],
    records: [],
    qaRecords: [],
    prepareForContinuation: true,
    nonCardElapsedBeforePipelineMs: 100,
    cardModelInvoker: async () => JSON.stringify({
      cardNames: [{ name: 'unbound model value' }],
      groupMentions: [],
    }),
    geminiEvidenceProvider: {
      async retrieve(input) {
        calls.push(input);
        return { evidence: { ...evidence, cardResolution: input.cardResolution }, packing, telemetry };
      },
    },
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    env: {
      RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1',
      GEMINI_RULE_QA_ENABLED: 'true',
      RAG_LIVE_OFFICIAL_QA: 'false',
    },
    fetchImpl: async () => { throw new Error('unexpected transport'); },
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].elapsedBeforeRetrievalMs >= 100);
  assert.equal(calls[0].userQuery, 'Synthetic integration question');
  assert.equal(typeof calls[0].packEvidence, 'function');
  assert.equal(
    calls[0].cardResolution.unresolvedMentions.some(
      (item) => item.reason === 'typed_card_mention_missing_original_text',
    ),
    true,
  );
  assert.equal(prepared.status, 'evidence_prepared');
  assert.equal(prepared.continuation.promptBundle.prompt, packing.prompt);
  assert.deepEqual(prepared.continuation.promptBundle, packing);
  assert.deepEqual(prepared.continuation.evidence.rawRelatedEvidence, evidence.rawRelatedEvidence);
  assert.deepEqual(
    prepared.continuation.cardResolution.unresolvedMentions,
    calls[0].cardResolution.unresolvedMentions,
  );
  assert.deepEqual(prepared.continuation.ruleQueryModel.tokenUsage, telemetry.tokenUsage);
  assert.deepEqual(prepared.continuation.ruleQueryModel.generationContracts, telemetry.generationContracts);
  assert.equal(prepared.continuation.ruleQueryModel.generationProfileHash, telemetry.generationProfileHash);
  assert.equal(prepared.continuation.ruleQueryModel.bundleRevision, telemetry.bundleRevision);
  assert.ok(prepared.continuation.timingsMs.nonCardPreparation >= 100);
  assert.equal(typeof prepared.continuation.evidence.debug.timingsMs.cardTextPreparation, 'number');
  assert.deepEqual(prepared.continuation.evidence.debug.geminiRuleQa, evidence.debug.geminiRuleQa);

  let finalPrompt;
  const final = await finalizePreparedRagRulingQuestion({
    continuation: JSON.parse(JSON.stringify(prepared.continuation)),
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    env: {
      RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1',
      GEMINI_RULE_QA_ENABLED: 'true',
    },
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return 'mechanical final answer fixture';
    },
  });
  assert.equal(finalPrompt, packing.prompt);
  assert.equal(final.usedEvidence.some((item) => item.id === 'rule-unit-1'), true);
  assert.equal(final.usedEvidence.find((item) => item.id === 'rule-unit-1').text, evidence.rawRelatedEvidence[0].text);
});

test('Gemini rule and QA provider fails mechanically before final generation without a packing', async () => {
  await assert.rejects(answerRagRulingQuestion({
    question: 'Synthetic invalid provider result',
    cards: [],
    records: [],
    qaRecords: [],
    prepareForContinuation: true,
    cardModelInvoker: async () => JSON.stringify({ cardNames: [], groupMentions: [] }),
    geminiEvidenceProvider: { retrieve: async () => ({ evidence: {} }) },
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    env: {
      RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1',
      GEMINI_RULE_QA_ENABLED: 'true',
      RAG_LIVE_OFFICIAL_QA: 'false',
    },
    fetchImpl: async () => { throw new Error('unexpected transport'); },
  }), { code: 'gemini_rule_qa_prepared_result_invalid' });
});
