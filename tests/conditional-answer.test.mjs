import assert from "node:assert/strict";
import test from "node:test";
import { buildConditionalAnswer } from "../backend/conditionalAnswer.mjs";
import { answerQuestion, mergeModelAnswer } from "../backend/engine.mjs";

const missingStateAnswerPromise = answerQuestion(
  { question: "青眼暴君龙被战斗破坏的时候，这个效果是在墓地发动还是在场上发动？" },
  { useModel: false, onDemandSync: false }
);
const graveyardAnswerPromise = answerQuestion(
  { question: "青眼暴君龙被战斗破坏并送去墓地后，这个效果是在墓地发动还是在场上发动？" },
  { useModel: false, onDemandSync: false }
);
const banishedAnswerPromise = answerQuestion(
  { question: "青眼暴君龙被战斗破坏并被除外后，这个效果在哪里发动？" },
  { useModel: false, onDemandSync: false }
);

test("missing branch state generates a conditional answer", async () => {
  const answer = await missingStateAnswerPromise;
  const subAnswer = answer.subAnswers[0];
  assert.equal(subAnswer.status, "unknown");
  assert.equal(subAnswer.verdict, "unknown");
  assert.equal(subAnswer.conditionalAnswer?.kind, "conditional_answer");
  assert.equal(subAnswer.conditionalAnswer.status, "unknown");
});

test("conditional answer includes all extracted branches with evidence IDs", async () => {
  const answer = await missingStateAnswerPromise;
  const branches = answer.subAnswers[0].conditionalAnswer.branches;
  assert.equal(branches.length, 3);
  assert.deepEqual(branches.map((branch) => branch.verdict), [
    "activates_on_field",
    "activates_in_graveyard",
    "activates_while_banished",
  ]);
  assert.ok(branches.every((branch) => branch.evidenceIds.includes("card-faq-16842-3")));
});

test("conditional answer does not raise final status", async () => {
  const answer = await missingStateAnswerPromise;
  const subAnswer = answer.subAnswers[0];
  assert.equal(subAnswer.status, "unknown");
  assert.equal(subAnswer.verdict, "unknown");
  assert.equal(answer.parserDebug.evidenceTrace[0].finalStatus, "unknown");
  assert.equal(answer.parserDebug.evidenceTrace[0].finalVerdict, "unknown");
});

test("clarification question asks for monster zone, graveyard, or banished state", async () => {
  const answer = await missingStateAnswerPromise;
  const question = answer.subAnswers[0].conditionalAnswer.clarificationQuestion;
  assert.match(question, /怪兽区域/u);
  assert.match(question, /墓地/u);
  assert.match(question, /除外/u);
});

test("explicit graveyard state selects the graveyard branch without conditional answer", async () => {
  const answer = await graveyardAnswerPromise;
  const subAnswer = answer.subAnswers[0];
  assert.equal(subAnswer.status, "confirmed");
  assert.equal(subAnswer.verdict, "activates_in_graveyard");
  assert.equal(subAnswer.conditionalAnswer, undefined);
});

test("explicit banished state selects the banished branch without conditional answer", async () => {
  const answer = await banishedAnswerPromise;
  const subAnswer = answer.subAnswers[0];
  assert.equal(subAnswer.status, "confirmed");
  assert.equal(subAnswer.verdict, "activates_while_banished");
  assert.equal(subAnswer.conditionalAnswer, undefined);
});

test("conditional answer is not generated without condition branches", () => {
  const conditionalAnswer = buildConditionalAnswer({
    subQuestion: { id: "q1", card: "测试卡" },
    conditionBranches: [],
    branchSelectorResult: { status: "missing_state", missingConditions: ["graveyard"] },
  });
  assert.equal(conditionalAnswer, null);
});

test("model explanation cannot override conditional answer status or verdict", async () => {
  const answer = await missingStateAnswerPromise;
  const programAnswer = answer.subAnswers[0];
  const merged = mergeModelAnswer(
    {
      status: "confirmed",
      verdict: "activates_in_graveyard",
      evidenceIds: ["fake"],
      conditionalAnswer: { status: "confirmed", verdict: "activates_in_graveyard" },
      explanationText: "模型解释",
    },
    programAnswer
  );
  assert.equal(merged.status, "unknown");
  assert.equal(merged.verdict, "unknown");
  assert.equal(merged.conditionalAnswer.status, "unknown");
  assert.equal(merged.conditionalAnswer.kind, "conditional_answer");
  assert.ok(merged.warnings.includes("model_status_or_verdict_ignored"));
});
