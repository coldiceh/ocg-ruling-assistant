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
const exactFixture = JSON.parse(await readFile(
  new URL("./fixtures/official-qa-exact-retrieval.json", import.meta.url),
  "utf8",
));
const cardsById = new Map(fixture.cards.map((card) => [card.id, card]));

test("ordinary retrieval supplies only the expected high-relevance Q&A and safely misses zero-signal cases", () => {
  for (const item of fixture.cases) {
    const retrieval = retrieveOfficialQaSemanticCandidates({
      question: item.question,
      records: fixture.records,
      resolvedCards: item.resolvedCardIds.map((id) => cardsById.get(id)),
    });
    assert.deepEqual(
      retrieval.candidates.map((candidate) => candidate.qaId),
      item.expectedCandidate === false ? [] : [item.qaId],
      `${item.id} did not retrieve one unique expected candidate: ${JSON.stringify(retrieval)}`,
    );
  }
});

test("semantic direct accepts eligible positive forms and has zero false positives on hard negatives", async () => {
  const expectedByQuestion = new Map(fixture.cases.map((item) => [item.question, item.expectedEquivalent]));
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const item of fixture.cases) {
    const result = await runOfficialQaSemanticDirectExperiment({
      userQuestion: item.question,
      records: fixture.records,
      resolvedCards: item.resolvedCardIds.map((id) => cardsById.get(id)),
      verifier: async (input) => {
        assert.deepEqual(Object.keys(input).sort(), ["canonicalCards", "officialQuestion", "userQuestion"]);
        const equivalent = expectedByQuestion.get(input.userQuestion) === true;
        return {
          equivalent,
          userEntailsOfficial: equivalent,
          officialEntailsUser: equivalent,
          decisiveDifferences: equivalent ? [] : ["测试夹具中的决定性条件发生变化"],
          unresolvedReferences: [],
          uncertain: false,
        };
      },
    });
    if (item.expectedEquivalent && item.expectedCandidate !== false
        && result.route !== "official_qa_semantic_direct") falseNegatives += 1;
    if (!item.expectedEquivalent && result.route === "official_qa_semantic_direct") falsePositives += 1;
    assert.equal(result.qaId || item.qaId, item.qaId);
    if (item.expectedEquivalent && item.expectedCandidate !== false) {
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
        decisiveDifferences: [],
        unresolvedReferences: [],
        uncertain: false,
      });
    },
  });
  await verifier({
    userQuestion: fixture.cases[0].question,
    officialQuestion,
    canonicalCards: [{
      id: "12950",
      userFacingName: "灰流丽",
      officialJapaneseName: "灰流うらら",
      effectText: "CARD_EFFECT_MUST_NOT_REACH_VERIFIER",
      aliases: ["ALIAS_MUST_NOT_REACH_VERIFIER"],
    }],
  });
  assert.equal(invocation.model, "gpt-5.6-sol");
  assert.equal(invocation.reasoningEffort, "low");
  assert.equal(invocation.task, "official_qa_semantic_equivalence");
  assert.match(invocation.prompt, /<user_question>/u);
  assert.match(invocation.prompt, /<official_question>/u);
  assert.match(invocation.prompt, /<canonical_card_identities>/u);
  assert.match(invocation.prompt, /"id":"12950"/u);
  assert.doesNotMatch(invocation.prompt, /CARD_EFFECT_MUST_NOT_REACH_VERIFIER|ALIAS_MUST_NOT_REACH_VERIFIER/u);
  assert.doesNotMatch(invocation.prompt, new RegExp(escapeRegExp(officialAnswer.slice(0, 24)), "u"));
});

test("any uncertainty, unresolved reference, difference, malformed result or verifier failure falls back", async () => {
  const base = {
    userQuestion: fixture.cases[0].question,
    records: fixture.records,
    resolvedCards: fixture.cases[0].resolvedCardIds.map((id) => cardsById.get(id)),
  };
  for (const verdict of [
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, decisiveDifferences: ["区域不明"], unresolvedReferences: [], uncertain: false },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, decisiveDifferences: [], unresolvedReferences: ["那张卡"], uncertain: false },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, decisiveDifferences: [], unresolvedReferences: [], uncertain: true },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: false, decisiveDifferences: [], unresolvedReferences: [], uncertain: false },
    { equivalent: "yes", userEntailsOfficial: true, officialEntailsUser: true, decisiveDifferences: [], unresolvedReferences: [], uncertain: false },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, differences: [], unresolvedReferences: [], uncertain: false },
    { equivalent: true, userEntailsOfficial: true, officialEntailsUser: true, decisiveDifferences: [], differences: [], unresolvedReferences: [], uncertain: false },
  ]) {
    const result = await runOfficialQaSemanticDirectExperiment({ ...base, verifier: async () => verdict });
    assert.equal(result.route, "ordinary_rag");
  }
  const failed = await runOfficialQaSemanticDirectExperiment({
    ...base,
    verifier: async () => { throw new Error("upstream unavailable"); },
  });
  assert.equal(failed.route, "ordinary_rag");
  const retrievalFailed = await runOfficialQaSemanticDirectExperiment({
    ...base,
    verifier: async () => { throw new Error("must not run"); },
    candidateRetriever: async () => { throw new Error("retrieval unavailable"); },
  });
  assert.equal(retrievalFailed.route, "ordinary_rag");
  assert.equal(retrievalFailed.reason, "candidate_retrieval_failed");
});

test("real snapshot placeholders are materialized and compact records use the complete projected body", () => {
  const semanticCase = fixture.cases.find((item) => item.id === "10072-faithful");
  const direct = retrieveOfficialQaSemanticCandidates({
    question: semanticCase.question,
    records: exactFixture.records,
    resolvedCards: semanticCase.resolvedCardIds.map((id) => cardsById.get(id)),
    cards: exactFixture.cards,
  });
  assert.deepEqual(
    direct.candidates.map((item) => item.qaId),
    ["10072"],
    JSON.stringify(direct),
  );
  assert.doesNotMatch(direct.candidates[0].officialQuestionJapanese, /<<\d+>>/u);
  assert.doesNotMatch(direct.candidates[0].officialAnswerJapanese, /<<\d+>>/u);
  assert.match(direct.candidates[0].officialQuestionJapanese, /人造人間－サイコ・ショッカー/u);

  const source = exactFixture.records.find((record) => record.sourceId === "12336");
  const compact = {
    ...source,
    rawDetailedQuestion: "",
    rawAnswer: "",
    text: `${source.rawDetailedQuestion}\n${source.title}\n${source.rawAnswer}`,
  };
  const compactCase = fixture.cases.find((item) => item.id === "12336-faithful");
  const projected = retrieveOfficialQaSemanticCandidates({
    question: compactCase.question,
    records: [compact],
    resolvedCards: compactCase.resolvedCardIds.map((id) => cardsById.get(id)),
    cards: exactFixture.cards,
  });
  assert.deepEqual(projected.candidates.map((item) => item.qaId), ["12336"]);
  assert.ok(projected.candidates[0].officialQuestionJapanese.length > compact.title.length);
  assert.doesNotMatch(projected.candidates[0].officialAnswerJapanese, /<<\d+>>/u);
});

test("incomplete bodies, conflicted current bodies and conflicted canonical identities fail closed", async () => {
  const source = exactFixture.records.find((record) => record.sourceId === "12336");
  const item = fixture.cases.find((candidate) => candidate.id === "12336-faithful");
  const incomplete = retrieveOfficialQaSemanticCandidates({
    question: item.question,
    records: [source],
    resolvedCards: item.resolvedCardIds.map((id) => cardsById.get(id)),
    cards: exactFixture.cards.filter((card) => card.id !== "18177"),
  });
  assert.deepEqual(incomplete.candidates, []);

  const currentConflict = retrieveOfficialQaSemanticCandidates({
    question: fixture.cases.find((candidate) => candidate.id === "10072-faithful").question,
    records: [
      exactFixture.records.find((record) => record.sourceId === "10072"),
      {
        ...exactFixture.records.find((record) => record.sourceId === "10072"),
        rawDetailedQuestion: "同一ID但不兼容的当前官方问题ですか？",
        rawAnswer: "同一ID但不兼容的当前官方回答です。",
      },
    ],
    resolvedCards: fixture.cases.find((candidate) => candidate.id === "10072-faithful")
      .resolvedCardIds.map((id) => cardsById.get(id)),
    cards: exactFixture.cards,
  });
  assert.deepEqual(currentConflict.candidates, []);

  let verifierCalls = 0;
  const same = candidate("77");
  const conflict = { ...same, officialAnswerJapanese: "不兼容回答" };
  const duplicateResult = await runOfficialQaSemanticDirectExperiment({
    userQuestion: "测试问题",
    resolvedCards: [{ id: "1", name: "测试卡", jaName: "テストカード" }],
    verifier: async () => { verifierCalls += 1; },
    candidateRetriever: async () => ({ candidates: [same, conflict, same] }),
  });
  assert.equal(duplicateResult.route, "ordinary_rag");

  const identityResult = await runOfficialQaSemanticDirectExperiment({
    userQuestion: "测试问题",
    resolvedCards: [
      { id: "1", name: "测试卡", jaName: "テストカード" },
      { id: "1", name: "另一张卡", jaName: "別カード" },
    ],
    verifier: async () => { verifierCalls += 1; },
    candidateRetriever: async () => ({ candidates: [same] }),
  });
  assert.equal(identityResult.route, "ordinary_rag");
  assert.equal(verifierCalls, 0);
});

test("candidate certification scans the complete high-relevance pool and never promotes related-only evidence", () => {
  const card = { id: "70001", name: "测试卡", jaName: "テストカード" };
  const question = "「测试卡」的①效果可以发动吗？";
  const records = Array.from({ length: 25 }, (_, index) => ({
    id: `ygoresources-qa-${80000 + index}`,
    sourceId: String(80000 + index),
    recordType: "qa",
    status: "current",
    cardIds: [card.id],
    rawDetailedQuestion: question,
    answer: `官方回答 ${index + 1}`,
  }));
  const completePool = retrieveOfficialQaSemanticCandidates({
    question,
    records,
    resolvedCards: [card],
    cards: [card],
  });
  assert.equal(completePool.candidates.length, 25);

  const relatedOnly = retrieveOfficialQaSemanticCandidates({
    question: "「测试卡」的攻击力是多少？",
    records: [records[0]],
    resolvedCards: [card],
    cards: [card],
  });
  assert.deepEqual(relatedOnly.candidates, []);
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
