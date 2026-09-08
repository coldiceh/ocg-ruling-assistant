import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { answerRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';
import { capturePublicRulingEvidence } from '../backend/adminPublicEvidenceCapture.mjs';
import { answerPublicRulingQuestion } from '../backend/publicAnswerService.mjs';

test('server evidence capture stops before the final call and preserves its exact prompt', async () => {
  const options = {
    question: '【示例卡】\n①：可以发动。抽1张卡。\n这个效果如何处理？',
    cards: [], records: [], qaRecords: [],
    env: { RAG_MODEL_PROVIDER: 'mock', RAG_AUTO_ENGINE_SIMULATION: 'false' },
    fetchImpl: async () => { throw new Error('unexpected external request'); },
  };
  let normalPrompt;
  await answerRagRulingQuestion({ ...options, modelInvoker: async ({prompt}) => {
    normalPrompt = prompt;
    return '示例回答';
  }});
  let finalCalls = 0;
  const captured = await answerRagRulingQuestion({ ...options,
    captureEvidenceOnly: true,
    modelInvoker: async () => { finalCalls += 1; return 'must not run'; },
  });
  assert.equal(finalCalls, 0);
  assert.equal(captured.status, 'evidence_captured');
  assert.equal(captured.capture.promptBundle.prompt, normalPrompt);
  assert.equal(captured.capture.finalPromptSha256,
    createHash('sha256').update(normalPrompt).digest('hex'));
  assert.equal(captured.debug.timingsMs.finalModel, 0);
});

test('admin capture uses the public profile, omits private audit, and keeps an independent run budget', async () => {
  let received;
  const budget = { snapshot: () => ({calls: []}) };
  let budgetEnv;
  const result = await capturePublicRulingEvidence({
    payload: {question: 'example', rulingModelProfile: 'relay-gpt-6-astra-low',
      captureEvidenceOnly: false, env: {RAG_EVIDENCE_PIPELINE: 'wrong'},
      frozenCardResolution: {invalid: true},
      budget: {runId: 'test-run', actualLimitCny: 1, theoreticalLimitUsd: 1}},
    env: {RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1', RELAY_API_KEY: 'test',
      RELAY_BASE_URL: 'https://example.test/v1', CLOUD_BUDGET_PERIOD: 'daily'},
    createBudget: ({env}) => {budgetEnv = env; return budget;},
    answerPublic: async options => {
      assert.equal(await options.appendAudit({question: 'private'}), null);
      return answerPublicRulingQuestion({...options, answerOfficialExact: async () => null});
    },
    answerRuling: async options => {received = options; return {status:'evidence_captured'};},
  });
  assert.equal(result.answer.status, 'evidence_captured');
  assert.equal(received.captureEvidenceOnly, true);
  assert.equal(received.cloudBudget, budget);
  assert.equal(received.env.RELAY_CARD_MODEL, 'gpt-6-astra');
  assert.equal(received.env.RAG_CARD_MODEL_TIMEOUT_MS, '60000');
  assert.equal(received.env.RAG_REASONING_EFFORT, 'low');
  assert.equal(received.frozenCardResolution, undefined);
  assert.equal(budgetEnv.CLOUD_BUDGET_PERIOD, 'run');
  assert.equal(budgetEnv.CLOUD_BUDGET_RUN_ID, 'admin-capture-test-run');
  assert.equal(budgetEnv.CLOUD_BUDGET_ACTUAL_LIMIT_CNY, 1);
});

test('public payload cannot enable capture or replace the server dependencies', async () => {
  let received;
  await answerPublicRulingQuestion({
    payload: {question:'example', captureEvidenceOnly:true, cloudBudget:{fake:true}},
    env:{RELAY_API_KEY:'test',RELAY_BASE_URL:'https://example.test/v1',
      PUBLIC_RULING_MODEL_PROFILE:'relay-gpt-6-astra-low'},
    appendAudit:async()=>null, answerOfficialExact:async()=>null,
    answerRuling:async options=>{received=options;return {};},
  });
  assert.equal(received.captureEvidenceOnly, undefined);
  assert.equal(received.cloudBudget, undefined);
});
