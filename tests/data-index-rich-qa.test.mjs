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
  assert.equal(indexed.answer, "Condition A has one result; condition B has another.");
  assert.deepEqual(indexed.questionCardIds, ["100"]);
  assert.equal(indexed.sourceId, "900");
  assert.match(indexed.text, /Condition A has one result/u);
});

test("the QA index keeps a structured official answer separate from positive question wording", () => {
  const [indexed] = buildQaIndex([{
    id: "qa-negative-answer",
    recordType: "qa",
    title: "Activation question",
    question: "Can this operation be performed?",
    officialAnswer: "No, it cannot be performed.",
  }], []);

  assert.equal(indexed.answer, "No, it cannot be performed.");
});

test("a card's formal name maps to that card even when another card lists it as an alias", () => {
  const [indexed] = buildQaIndex([{
    id: "card-faq-200-1",
    recordType: "card-faq",
    title: "Formal Card FAQ",
    question: "Question about Formal Card?",
    cards: ["Formal Card"],
    cardIds: ["200"],
  }], [
    { id: "200", name: "Formal Card", cnName: "Formal Card" },
    // A community name source reuses the first card's formal name for a different card.
    { id: "300", name: "Other Card", aliases: ["Other Card", "Formal Card"] },
  ]);

  assert.deepEqual(indexed.cardIds, ["200"]);
});
