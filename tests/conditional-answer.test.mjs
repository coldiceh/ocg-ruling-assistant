import assert from "node:assert/strict";
import test from "node:test";
import { buildConditionalAnswer } from "../backend/conditionalAnswer.mjs";
import { mergeModelAnswer } from "../backend/engine.mjs";

const conditionBranches = [
  { id: "qa-fixture", normalizedConditions: ["monster_zone"], verdict: "activates_on_field", evidenceIds: ["qa-fixture"] },
  { id: "qa-fixture", normalizedConditions: ["graveyard"], verdict: "activates_in_graveyard", evidenceIds: ["qa-fixture"] },
  { id: "qa-fixture", normalizedConditions: ["banished"], verdict: "activates_while_banished", evidenceIds: ["qa-fixture"] },
];

function conditionalAnswer() {
  return buildConditionalAnswer({
    subQuestion: { id: "q1", card: "匿名测试怪兽" },
    conditionBranches,
    branchSelectorResult: { status: "missing_state", missingConditions: ["current_zone"] },
  });
}

test("missing branch state generates a non-authoritative conditional answer", () => {
  const answer = conditionalAnswer();
  assert.equal(answer.kind, "conditional_answer");
  assert.equal(answer.status, "unknown");
});

test("conditional answer includes every evidence-bound branch", () => {
  const branches = conditionalAnswer().branches;
  assert.deepEqual(branches.map((branch) => branch.verdict), [
    "activates_on_field",
    "activates_in_graveyard",
    "activates_while_banished",
  ]);
  assert.ok(branches.every((branch) => branch.evidenceIds.includes("qa-fixture")));
});

test("clarification asks for the unresolved zone without selecting one", () => {
  const question = conditionalAnswer().clarificationQuestion;
  assert.match(question, /怪兽区域/u);
  assert.match(question, /墓地/u);
  assert.match(question, /除外/u);
});

test("conditional answer is not generated without condition branches", () => {
  const answer = buildConditionalAnswer({
    subQuestion: { id: "q1", card: "匿名测试怪兽" },
    conditionBranches: [],
    branchSelectorResult: { status: "missing_state", missingConditions: ["graveyard"] },
  });
  assert.equal(answer, null);
});

test("model explanation cannot override a conditional answer status or verdict", () => {
  const programAnswer = {
    status: "unknown",
    verdict: "unknown",
    evidenceIds: ["qa-fixture"],
    warnings: [],
    conditionalAnswer: conditionalAnswer(),
  };
  const merged = mergeModelAnswer({
    status: "confirmed",
    verdict: "activates_in_graveyard",
    evidenceIds: ["fake"],
    conditionalAnswer: { status: "confirmed", verdict: "activates_in_graveyard" },
    explanationText: "模型解释",
  }, programAnswer);
  assert.equal(merged.status, "unknown");
  assert.equal(merged.verdict, "unknown");
  assert.equal(merged.conditionalAnswer.status, "unknown");
  assert.equal(merged.conditionalAnswer.kind, "conditional_answer");
  assert.ok(merged.warnings.includes("model_status_or_verdict_ignored"));
});
