import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildOfficialQaSemanticEquivalencePrompt,
  createOfficialQaSemanticEquivalenceVerifier,
  retrieveOfficialQaSemanticCandidates,
  runOfficialQaSemanticDirectExperiment,
} from "../backend/officialQaSemanticDirectExperiment.mjs";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/official-qa-semantic-direct-experiment.json", import.meta.url),
  "utf8",
));
const cardsById = new Map(fixture.cards.map((card) => [card.id, card]));

test("ordinary retrieval supplies exactly the expected high-relevance Q&A for all isolated cases", () => {
  for (const item of fixture.cases) {
    const retrieval = retrieveOfficialQaSemanticCandidates({
      question: item.question,
      records: fixture.records,
      resolvedCards: item.resolvedCardIds.map((id) => cardsById.get(id)),
    });
    assert.deepEqual(
      retrieval.candidates.map((candidate) => candidate.qaId),
      [item.qaId],
      `${item.id} did not retrieve one unique expected candidate`,
    );
  }
});

test("semantic direct accepts both positive forms and has zero false positives on hard negatives", async () => {
  const expectedByQuestion = new Map(fixture.cases.map((item) => [item.question, item.expectedEquivalent]));
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const item of fixture.cases) {
    const result = await runOfficialQaSemanticDirectExperiment({
      userQuestion: item.question,
      records: fixture.records,
      resolvedCards: item.resolvedCardIds.map((id) => cardsById.get(id)),
      verifier: async (input) => {
        assert.deepEqual(Object.keys(input).sort(), ["officialQuestion", "userQuestion"]);
        const equivalent = expectedByQuestion.get(input.userQuestion) === true;
        return {
          equivalent,
          userEntailsOfficial: equivalent,
          officialEntailsUser: equivalent,
          differences: equivalent ? [] : ["测试夹具中的决定性条件发生变化"],
          unresolvedReferences: [],
          uncertain: false,
        };
      },
    });
    if (item.expectedEquivalent && result.route !== "official_qa_semantic_direct") falseNegatives += 1;
    if (!item.expectedEquivalent && result.route === "official_qa_semantic_direct") falsePositives += 1;
    assert.equal(result.qaId || item.qaId, item.qaId);
    if (item.expectedEquivalent) {
      assert.equal(result.route, "official_qa_semantic_direct", item.id);
      assert.ok(result.officialAnswerJapanese);
      assert.equal(result.modelCalls, 1);
    } else {
      assert.equal(result.route, "ordinary_rag", item.id);
      assert.equal(result.officialAnswerJapanese, undefined);
    }
  }
  assert.equal(falsePositives, 0);
  assert.equal(falseNegatives, 0);
});

test("equivalence verifier prompt contains only the two questions as case data and uses Sol low", async () => {
  const officialQuestion = fixture.records[0].rawDetailedQuestion;
  const officialAnswer = fixture.records[0].answer;
  let invocation;
  const verifier = createOfficialQaSemanticEquivalenceVerifier({
    invoke: async (request) => {
      invocation = request;
      return JSON.stringify({
        equivalent: true,
        userEntailsOfficial: true,
        officialEntailsUser: true,
        differences: [],
        unresolvedReferences: [],
        uncertain: false,
      });
    },
  });
  await verifier({ userQuestion: fixture.cases[0].question, officialQuestion });
  assert.equal(invocation.model, "gpt-5.6-sol");
  assert.equal(invocation.reasoningEffort, "low");
  assert.equal(invocation.task, "official_qa_semantic_equivalence");
  assert.match(invocation.prompt, /<user_question>/u);
  assert.match(invocation.prompt, /<official_question>/u);
  assert.doesNotMatch(invocation.prompt, new RegExp(escapeRegExp(officialAnswer.slice(0, 24)), "u"));
});

test("any uncertainty, unresolved reference, difference, malformed result or verifier failure falls back", async () => {
  const base = {
    userQuestion: fixture.cases[0].question,
    records: fixture.records,
    resolvedCards: fixture.cases[0].resolvedCardIds.map((id) => cardsById.get(id)),
  };
  for (const verdict of [
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, differences: ["区域不明"], unresolvedReferences: [], uncertain: false },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, differences: [], unresolvedReferences: ["那张卡"], uncertain: false },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, differences: [], unresolvedReferences: [], uncertain: true },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: false, differences: [], unresolvedReferences: [], uncertain: false },
    { equivalent: "yes", userEntailsOfficial: true, officialEntailsUser: true, differences: [], unresolvedReferences: [], uncertain: false },
  ]) {
    const result = await runOfficialQaSemanticDirectExperiment({ ...base, verifier: async () => verdict });
    assert.equal(result.route, "ordinary_rag");
  }
  const failed = await runOfficialQaSemanticDirectExperiment({
    ...base,
    verifier: async () => { throw new Error("upstream unavailable"); },
  });
  assert.equal(failed.route, "ordinary_rag");
});

test("zero or multiple high-relevance candidates skip the verifier", async () => {
  let calls = 0;
  const verifier = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  for (const candidates of [[], [
    candidate("1"),
    candidate("2"),
  ]]) {
    const result = await runOfficialQaSemanticDirectExperiment({
      userQuestion: "测试问题",
      verifier,
      candidateRetriever: async () => ({ candidates }),
    });
    assert.equal(result.route, "ordinary_rag");
    assert.equal(result.modelCalls, 0);
  }
  assert.equal(calls, 0);
});

test("the semantic experiment is not imported by either production answer entry", async () => {
  const [pipeline, service] = await Promise.all([
    readFile(new URL("../backend/ragRulingPipeline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/publicAnswerService.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(pipeline, /officialQaSemanticDirectExperiment/u);
  assert.doesNotMatch(service, /officialQaSemanticDirectExperiment/u);
});

function candidate(qaId) {
  return {
    qaId,
    recordId: `qa-${qaId}`,
    sourceUrl: `https://example.test/qa/${qaId}`,
    officialQuestionJapanese: `公式質問${qaId}`,
    officialAnswerJapanese: `公式回答${qaId}`,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
