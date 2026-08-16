import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  answerRagRulingQuestion,
  shouldEnableOfficialQaSemanticDirect,
} from "../backend/ragRulingPipeline.mjs";

const fixture = JSON.parse(await readFile(new URL(
  "./fixtures/official-qa-semantic-direct-experiment.json",
  import.meta.url,
), "utf8"));

test("semantic direct is Preview-only even when explicitly enabled", () => {
  assert.equal(shouldEnableOfficialQaSemanticDirect({ VERCEL_ENV: "preview" }), true);
  assert.equal(shouldEnableOfficialQaSemanticDirect({
    VERCEL_ENV: "production",
    OFFICIAL_QA_SEMANTIC_DIRECT_ENABLED: "true",
  }), false);
  assert.equal(shouldEnableOfficialQaSemanticDirect({}), false);
});

test("Preview semantic direct returns the untouched official answer without the final ruling model", async () => {
  const item = fixture.cases.find((candidate) => candidate.id === "12403-faithful");
  const record = fixture.records.find((candidate) => candidate.sourceId === item.qaId);
  let semanticCalls = 0;
  let finalCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: item.question,
    cards: fixture.cards,
    records: [],
    qaRecords: fixture.records,
    env: {
      VERCEL_ENV: "preview",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
    },
    semanticModelInvoker: async ({ prompt, task, reasoningEffort }) => {
      semanticCalls += 1;
      assert.equal(task, "official_qa_semantic_equivalence");
      assert.equal(reasoningEffort, "low");
      assert.doesNotMatch(prompt, new RegExp(escapeRegExp(record.answer), "u"));
      return JSON.stringify({
        equivalent: true,
        userEntailsOfficial: true,
        officialEntailsUser: true,
        differences: [],
        unresolvedReferences: [],
        uncertain: false,
      });
    },
    modelInvoker: async () => {
      finalCalls += 1;
      throw new Error("final ruling model must not run after semantic direct");
    },
  });
  assert.equal(semanticCalls, 1);
  assert.equal(finalCalls, 0);
  assert.equal(answer.debug.route, "official_qa_semantic_direct");
  assert.equal(answer.officialQaId, item.qaId);
  assert.equal(answer.officialAnswerJapanese, record.answer);
  assert.equal(answer.shortAnswer, record.answer);
  assert.equal(answer.debug.modelCalls, 1);
  assert.equal(answer.debug.reasoningEffort, "low");
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
