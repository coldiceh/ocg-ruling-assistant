import test from "node:test";
import assert from "node:assert/strict";

import { answerRagRulingQuestion, finalizePreparedRagRulingQuestion, selectedPromptEvidenceRefs } from "../backend/ragRulingPipeline.mjs";

// The web page shows the evidence when preparation ends (publicPreparedAnswerService evidencePreview)
// and the final answer's usedEvidence once the final model has written. Both are the prompt-visible
// evidence of the same prepared prompt bundle, so the early list is exactly the answer's list.
const record = (id, extra = {}) => ({ id, recordType: "rule-doc", title: `规则 ${id}`, sourceUrl: `https://example.invalid/${id}`,
  text: `正文 ${id}`, ...extra });
const visible = [record("rule-a"), record("faq-b", { recordType: "card-faq", title: "FAQ b", conclusion: "回答 b", text: undefined })];
const hidden = record("rule-hidden", { text: "NOT-GIVEN-TO-THE-FINAL-MODEL" });
const packing = { prompt: "EXACT_PROVIDER_PROMPT", promptChars: 21, warnings: [], promptTruncated: false,
  modelEvidence: { rawRelatedEvidence: [visible[0], hidden], faqRelated: [visible[1]] },
  allowedEvidenceIds: ["faq-b", "rule-a"] };
const evidence = { cardTexts: [], userProvidedCardTexts: [], officialQaDirectCandidates: [], officialQaRelated: [],
  provisionalOfficialResponses: [], faqRelated: [visible[1]], rawRelatedEvidence: [visible[0], hidden],
  rulebookCandidates: [], retrievedCards: [], debug: {} };
const env = { RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1", GEMINI_RULE_QA_ENABLED: "true", RAG_LIVE_OFFICIAL_QA: "false" };

test("the evidence listed after preparation is exactly the final answer's usedEvidence", async () => {
  let finalModelCalls = 0;
  const prepared = await answerRagRulingQuestion({
    question: "Synthetic evidence preview question", cards: [], records: [], qaRecords: [], prepareForContinuation: true,
    preloadedAssets: { geminiAssets: Promise.resolve({}), geminiIndexes: Promise.resolve({}) },
    cardModelInvoker: async () => JSON.stringify({ cardNames: [], groupMentions: [] }),
    geminiEvidenceProvider: { retrieve: async (input) => ({ evidence: { ...evidence, cardResolution: input.cardResolution },
      packing, telemetry: { providerUsed: "gemini" } }) },
    modelInvoker: async () => { finalModelCalls += 1; return "must not run during preparation"; },
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    env,
    fetchImpl: async () => { throw new Error("unexpected transport"); },
  });
  assert.equal(prepared.status, "evidence_prepared");
  assert.equal(finalModelCalls, 0);
  const bundle = prepared.continuation.promptBundle;
  const preview = selectedPromptEvidenceRefs(bundle.modelEvidence, bundle.allowedEvidenceIds);
  assert.deepEqual(preview.map((item) => item.id), ["faq-b", "rule-a"], "allowed order");
  assert.ok(!JSON.stringify(preview).includes("NOT-GIVEN-TO-THE-FINAL-MODEL"));

  const final = await finalizePreparedRagRulingQuestion({
    continuation: JSON.parse(JSON.stringify(prepared.continuation)),   // as stored between the two requests
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    env,
    modelInvoker: async () => { finalModelCalls += 1; return "mechanical final answer fixture"; },
  });
  assert.equal(finalModelCalls, 1);
  assert.deepEqual(final.usedEvidence, preview);
});
