import assert from "node:assert/strict";
import test from "node:test";
import { buildDamageStepBlockerAnswer, evaluateDamageStepBlocker } from "../backend/damageStepBlockers.mjs";
import { buildDamageStepAnalysis } from "../backend/damageStepRules.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

test("regex-classified damage-step category is only a non-authoritative hint", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害步骤中能发动吗？", effectText: "快速效果：可以发动。" });
  const result = evaluateDamageStepBlocker(analysis);
  const answer = buildDamageStepBlockerAnswer(result);
  assert.equal(result.hasBlocker, true);
  assert.equal(answer.verdict, "insufficient_info");
  assert.equal(answer.confirmationLevel, "insufficient_info");
});

test("a caller self-reporting structured proof cannot produce a damage-step verdict", () => {
  const analysis = { ...buildDamageStepAnalysis({ question: "伤害步骤中能发动吗？", effectText: "快速效果：可以发动。" }), structuredProof: true };
  const answer = buildDamageStepBlockerAnswer(evaluateDamageStepBlocker(analysis));
  assert.equal(answer.verdict, "insufficient_info");
  assert.equal(answer.confirmationLevel, "insufficient_info");
});

test("allowed damage-step category continues to later Fast Judge checks", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害步骤中能发动吗？", effectText: "那个发动无效并破坏。" });
  assert.equal(evaluateDamageStepBlocker(analysis).hasBlocker, false);
});

test("Fast Judge exposes raw damage-step classification only as insufficient information", async () => {
  let modelCalled = false;
  const answer = await answerRulingQuestionFast({
    question: "伤害步骤中，测试快速龙能发动这个快速效果吗？",
    snapshot: {
      cards: [{ id: "damage-1", name: "测试快速龙", aliases: ["测试快速龙"], cardType: "monster", effectText: "快速效果：可以发动。" }],
      records: [],
      snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
    },
    modelInvoker: async () => { modelCalled = true; return { answerType: "direct_official", verdict: "can_activate" }; },
  });
  assert.equal(modelCalled, false);
  assert.equal(answer.verdict, "insufficient_info");
  assert.notEqual(answer.confirmationLevel, "rule_derived");
  assert.notEqual(answer.confirmationLevel, "official_confirmed");
  assert.equal(answer.damageStepAnalysis.allowedInDamageStep, false);
  assert.notEqual(answer.statusChip, "OFFICIAL");
});
