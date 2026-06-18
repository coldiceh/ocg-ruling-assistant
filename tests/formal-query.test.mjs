import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFormalRulingQuery,
  splitSubQuestions,
  validateFormalRulingQuery,
} from "../backend/formalQuery.mjs";
import { parseFormalRulingQuery } from "../backend/openai.mjs";

const cardCandidates = [
  {
    name: "测试卡A",
    aliases: ["卡A"],
  },
];

test("normalizes unknown fields and validates the schema", () => {
  const query = normalizeFormalRulingQuery({
    originalText: "测试卡A能否发动？",
    cards: [{ name: "测试卡A", role: "invalid", controller: "invalid", zone: "invalid" }],
    scenario: {},
    subQuestions: [],
  });

  assert.equal(query.cards[0].role, "question_card");
  assert.equal(query.cards[0].controller, "unknown");
  assert.equal(query.cards[0].zone, "unknown");
  assert.equal(query.scenario.chainState, "unknown");
  assert.equal(query.subQuestions[0].type, "activation_condition");
  assert.deepEqual(validateFormalRulingQuery(query), { valid: true, errors: [] });
});

test("splits multiple natural-language questions and assigns a type to each", () => {
  const query = normalizeFormalRulingQuery({
    originalText: "测试卡A的①效果能否发动？处理时那张卡会不会回卡组？",
    cards: cardCandidates,
    scenario: {},
    subQuestions: [],
  });

  const subQuestions = splitSubQuestions(query);
  assert.equal(subQuestions.length, 2);
  assert.deepEqual(query.subQuestions.map((item) => item.type), ["activation_condition", "return_to_deck"]);
  assert.ok(query.subQuestions.every((item) => item.id && item.type !== "unknown"));
});

test("AI parser fallback returns JSON data and never writes a ruling conclusion", async () => {
  const query = await parseFormalRulingQuery("测试卡A的①效果能否发动？", cardCandidates, {});

  assert.equal(query.subQuestions[0].type, "activation_condition");
  assert.equal(query.subQuestions[0].card, "测试卡A");
  assert.doesNotMatch(query.subQuestions[0].askedResult, /^(可以|不可以|能|不能)$/u);
  assert.equal(validateFormalRulingQuery(query).valid, true);
});

