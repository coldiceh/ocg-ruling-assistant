import test from "node:test";
import assert from "node:assert/strict";

import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

// The pipeline only prepares the judge material (engineRepro/officialQaJudge.mjs sends the call):
// the official Q&A among the evidence the final model is given, question fields only, card names
// written into the placeholders from the loaded card data.
const qa = (n, extra = {}) => ({ id: `ygoresources-qa-${n}`, recordType: "qa", title: `「<<7>>」の効果${n}は？`,
  rawQuestion: `「<<7>>」の効果${n}は？`, conclusion: `SECRET-CONCLUSION-${n}`, ...extra });
const item = (handle, record) => ({ id: handle, recordType: record.recordType, title: record.title, text: JSON.stringify(record) });
const visible = [item("h-qa-1", qa(1)), item("h-faq", { id: "card-faq-7-1", recordType: "card-faq", title: "FAQ",
  question: "", conclusion: "SECRET-FAQ" }), { id: "rule-unit-1", type: "related", text: "SECRET-RULE" }];
const hidden = item("h-qa-2", qa(2));   // in the evidence, but not in allowedEvidenceIds
const packing = { prompt: "EXACT_PROVIDER_PROMPT", promptChars: 21, warnings: [], promptTruncated: false,
  modelEvidence: { rawRelatedEvidence: [...visible, hidden] }, allowedEvidenceIds: visible.map((entry) => entry.id) };
const evidence = { cardTexts: [], userProvidedCardTexts: [], officialQaDirectCandidates: [], officialQaRelated: [],
  provisionalOfficialResponses: [], faqRelated: [], rawRelatedEvidence: packing.modelEvidence.rawRelatedEvidence,
  rulebookCandidates: [], retrievedCards: [], debug: {} };
const cards = [{ id: "7", cnName: "测试卡", jaName: "テストカード", effectText: "测试卡的效果", aliases: [] }];

function run(extra = {}) {
  return answerRagRulingQuestion({
    question: "Synthetic integration question", cards, records: [], qaRecords: [],
    preloadedAssets: { geminiAssets: Promise.resolve({}), geminiIndexes: Promise.resolve({}) },
    cardModelInvoker: async () => JSON.stringify({ cardNames: [], groupMentions: [] }),
    geminiEvidenceProvider: { retrieve: async (input) => ({ evidence: { ...evidence, cardResolution: input.cardResolution },
      packing, telemetry: { providerUsed: "gemini" } }) },
    cloudBudget: { snapshot: () => ({ calls: [] }) },
    env: { RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1", GEMINI_RULE_QA_ENABLED: "true", RAG_LIVE_OFFICIAL_QA: "false" },
    fetchImpl: async () => { throw new Error("unexpected transport"); },
    ...extra,
  });
}

test("prepared continuation carries judge material for the prompt-visible official Q&A only", async () => {
  let observed = 0;
  const prepared = await run({ prepareForContinuation: true, onEvidencePrepared: () => { observed += 1; } });
  assert.equal(prepared.status, "evidence_prepared");
  const input = prepared.continuation.officialQaJudgeInput;
  assert.equal(input.userQuery, "Synthetic integration question");
  assert.deepEqual(input.candidates, [{ id: "ygoresources-qa-1", title: "「テストカード／测试卡」の効果1は？",
    rawQuestion: "「テストカード／测试卡」の効果1は？", handle: "h-qa-1", displayTitle: "「测试卡」の効果1は？" }]);
  assert.ok(!JSON.stringify(input).includes("SECRET"));
  assert.equal(prepared.continuation.promptBundle.prompt, packing.prompt, "the final prompt is unchanged");
  assert.ok(!prepared.continuation.promptBundle.prompt.includes("测试卡"));
  assert.equal(observed, 0, "the two-request shape starts the judge in its finalize request, not here");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(prepared.continuation)));
});

test("single request: the observer gets the same material before the final model call; its failure changes nothing", async () => {
  const order = [];
  let material = null;
  const answer = await run({
    onEvidencePrepared: ({ officialQaJudgeInput }) => { order.push("observer"); material = officialQaJudgeInput; },
    modelInvoker: async () => { order.push("final model"); return "mechanical final answer fixture"; },
  });
  assert.deepEqual(order, ["observer", "final model"]);
  assert.deepEqual(material.candidates.map((candidate) => candidate.id), ["ygoresources-qa-1"]);
  assert.ok(!JSON.stringify(answer).includes("officialQaJudgeInput"), "the answer object does not carry the material");
  const unaffected = await run({
    onEvidencePrepared: () => { throw new Error("observer failure"); },
    modelInvoker: async () => "mechanical final answer fixture",
  });
  assert.equal(unaffected.shortAnswer, answer.shortAnswer);
});

test("no official Q&A among the prompt-visible evidence: no material", async () => {
  const original = packing.allowedEvidenceIds;
  packing.allowedEvidenceIds = ["rule-unit-1", "h-faq"];
  try {
    const prepared = await run({ prepareForContinuation: true });
    assert.equal(Object.hasOwn(prepared.continuation, "officialQaJudgeInput"), false);
  } finally {
    packing.allowedEvidenceIds = original;
  }
});
