import assert from "node:assert/strict";
import test from "node:test";
import { buildQaIndex } from "../backend/dataIndex.mjs";

test("the QA index preserves heading, detailed scenario, identity and source fields", () => {
  const [indexed] = buildQaIndex([{
    id: "qa-generic",
    stableId: "qa-generic",
    recordType: "qa",
    title: "Short heading",
    question: "Short heading?",
    rawQuestion: "Short heading?",
    rawDetailedQuestion: "A detailed conditional scenario involving Example Card?",
    conclusion: "Condition A has one result; condition B has another.",
    cards: ["Example Card"],
    cardIds: ["100"],
    questionCardIds: ["100"],
    sourceId: "900",
    sourceUrl: "https://example.invalid/qa/900",
  }], [{ id: "100", name: "Example Card" }]);

  assert.equal(indexed.question, "Short heading?");
  assert.equal(indexed.rawDetailedQuestion, "A detailed conditional scenario involving Example Card?");
  assert.deepEqual(indexed.questionCardIds, ["100"]);
  assert.equal(indexed.sourceId, "900");
  assert.match(indexed.text, /Condition A has one result/u);
});
