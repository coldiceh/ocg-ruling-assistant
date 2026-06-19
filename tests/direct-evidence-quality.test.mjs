import assert from "node:assert/strict";
import test from "node:test";
import {
  answerEachSubQuestion,
  classifyQaForSubQuestion,
  retrieveEvidenceByFormalQuery,
} from "../backend/engine.mjs";
import { normalizeFormalRulingQuery, validateFormalRulingQuery } from "../backend/formalQuery.mjs";

test("A. a ruling about another effect after banishment is not direct", () => {
  const result = classifyQaForSubQuestion(temporaryBanishQuestion, qa({
    id: "qa-other-trigger",
    question: "A Toon monster was temporarily banished. Can another effect be activated because it was banished?",
    conclusion: "It can be activated, even if that monster has already returned.",
  }));

  assert.notEqual(result.match, "direct");
  assert.equal(result.answeredAskedResult, false);
  assert.ok(["different_question", "mentions_action_only"].includes(result.askedResultCoverage));
});

test("B. a ruling about changing battle position after return is not direct", () => {
  const result = classifyQaForSubQuestion(temporaryBanishQuestion, qa({
    id: "qa-position-after-return",
    question: "After the temporarily banished monster returns, can I change its battle position?",
    conclusion: "You can change that monster's battle position.",
  }));

  assert.notEqual(result.match, "direct");
  assert.equal(result.answeredAskedResult, false);
  assert.ok(["different_question", "mentions_action_only"].includes(result.askedResultCoverage));
});

test("C. an explicit graveyard activation answer is direct", () => {
  const subQuestion = {
    id: "q1",
    type: "activation_location",
    card: "测试卡",
    askedResult: "effect_activates_in_graveyard_or_field",
    sourceText: "测试卡的效果在哪里发动？",
  };
  const result = classifyQaForSubQuestion(subQuestion, qa({
    id: "qa-graveyard-location",
    question: "测试卡的效果在哪里发动？",
    conclusion: "这个效果在墓地发动。",
  }));

  assert.equal(result.match, "direct");
  assert.equal(result.answeredAskedResult, true);
  assert.equal(result.askedResultCoverage, "explicit");
});

test("D. an explicit cannot-activate answer is direct", () => {
  const subQuestion = {
    id: "q1",
    type: "activation_condition",
    card: "测试卡",
    askedResult: "can_activate",
    sourceText: "这个时候能发动测试卡的效果吗？",
  };
  const result = classifyQaForSubQuestion(subQuestion, qa({
    id: "qa-cannot-activate",
    question: "这个时候能发动测试卡的效果吗？",
    conclusion: "不能发动这个效果。",
  }));

  assert.equal(result.match, "direct");
  assert.equal(result.answeredAskedResult, true);
  assert.equal(result.askedResultCoverage, "explicit");
  assert.equal(result.extractedVerdict, "cannot");
});

test("E. conflicting direct candidates are downgraded and cannot confirm", () => {
  const subQuestion = {
    id: "q1",
    type: "activation_condition",
    card: "测试卡",
    askedResult: "can_activate",
    sourceText: "这个时候能发动测试卡的效果吗？",
  };
  const formalQuery = makeFormalQuery(subQuestion);
  const canQa = qa({
    id: "qa-can",
    question: subQuestion.sourceText,
    conclusion: "可以发动这个效果。",
  });
  const cannotQa = qa({
    id: "qa-cannot",
    question: subQuestion.sourceText,
    conclusion: "不能发动这个效果。",
  });
  const snapshot = { records: [canQa, cannotQa] };
  const evidence = retrieveEvidenceByFormalQuery(formalQuery, [card], snapshot);
  const bucket = evidence.bySubQuestion[0];

  assert.equal(bucket.rulingEvidence.length, 0, JSON.stringify({
    direct: bucket.rulingEvidence.map((item) => ({ id: item.evidenceId, reason: item.classificationReason })),
    similar: bucket.similarRulingEvidence.map((item) => ({ id: item.evidenceId, reason: item.classificationReason })),
    rejected: bucket.rejectedEvidence.map((item) => ({ id: item.evidenceId, reason: item.rejectedReason })),
  }));
  assert.equal(bucket.similarRulingEvidence.length, 2);
  assert.equal(bucket.retrievalTrace.downgradedDirectEvidence.length, 2);
  assert.ok(bucket.retrievalTrace.downgradedDirectEvidence.every((item) => item.reason === "conflicting_direct_evidence"));

  const [answer] = answerEachSubQuestion(
    formalQuery,
    evidence,
    snapshot,
    validateFormalRulingQuery(formalQuery)
  );
  assert.notEqual(answer.status, "confirmed");
  assert.match(answer.reason, /conflict/iu);
});

const temporaryBanishQuestion = {
  id: "q1",
  type: "temporary_banish",
  card: "测试卡",
  askedResult: "can_banish_that_monster",
  sourceText: "能用测试卡的效果暂时除外该怪兽吗？",
};

const card = {
  id: "test-card",
  cardId: "test-card",
  name: "测试卡",
  aliases: ["测试卡"],
};

function qa({ id, question, conclusion }) {
  return {
    id,
    recordType: "qa",
    title: `${id} ruling`,
    cards: ["测试卡"],
    cardIds: ["test-card"],
    question,
    conclusion,
    keywords: [],
    sources: [{ label: "fixture", detail: id }],
  };
}

function makeFormalQuery(subQuestion) {
  return normalizeFormalRulingQuery({
    originalText: subQuestion.sourceText,
    cards: [{ name: "测试卡", role: "question_card", controller: "unknown", zone: "unknown" }],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [subQuestion],
  });
}
