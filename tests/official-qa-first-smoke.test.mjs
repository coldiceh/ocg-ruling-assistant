import assert from "node:assert/strict";
import test from "node:test";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

const freshMeta = { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() };

function qa({ id = "qa-first-1", question, answer }) {
  return { id, recordType: "qa", question, answer, text: `${question}\n${answer}`, evidenceStatus: "current", sourceType: "official_qa" };
}

test("exact official QA bypasses template and activation processing", async () => {
  let modelCalled = false;
  const question = "只有发动中的通常陷阱时，这个效果能发动吗？";
  const answer = await answerRulingQuestionFast({
    question,
    snapshot: { cards: [], records: [qa({ question, answer: "可以发动。" })], snapshotMeta: freshMeta },
    chainLinks: [{ id: "C1", sourceCardId: "900401", effectNo: "1" }],
    modelInvoker: async () => { modelCalled = true; return null; },
  });
  assert.equal(answer.answerRoute, "official_qa_exact_match");
  assert.match(answer.shortAnswer, /可以发动/u);
  assert.equal(modelCalled, false);
  assert.equal(answer.ruleTrace.some((item) => item.step === "template_loaded"), false);
});

test("near-exact official QA bypasses a missing template", async () => {
  const name = "S：Pリトルナイト";
  const recordQuestion = `「${name}」のコントロールが移った場合、誰が効果を発動できますか？`;
  const answer = await answerRulingQuestionFast({
    question: `${name}的控制权在连锁处理后转移，谁可以发动效果？`,
    snapshot: { cards: [{ id: "999002", name, aliases: [name], effectText: "控制权发生变化。" }], records: [qa({ question: recordQuestion, answer: "その時点のコントローラーが発動できます。" })], snapshotMeta: freshMeta },
    chainLinks: [{ id: "C1", sourceCardId: "999002", effectNo: "1" }],
  });
  assert.equal(answer.answerRoute, "official_qa_near_case_match");
  assert.equal(answer.confirmationLevel, "conditional_official_case");
  assert.equal(answer.ruleTrace.some((item) => item.step === "template_loaded"), false);
});

test("template Fast Judge runs when no official QA matches", async () => {
  const name = "特殊胜利检查前伤害模板一";
  const answer = await answerRulingQuestionFast({
    question: `「${name}」处理时给予多少伤害？`,
    snapshot: { cards: [{ id: "900501", name, aliases: [name], effectText: "给予对方800伤害。" }], records: [], snapshotMeta: freshMeta },
    chainLinks: [{ id: "C1", sourceCardId: "900501", effectNo: "1" }],
    gameState: { phase: "end_phase", lp: { opponent: 2500 } },
  });
  assert.equal(answer.answerRoute, "rule_engine_answer");
  assert.equal(answer.status, "resolved");
  assert.ok(answer.ruleTrace.some((item) => item.step === "template_loaded" && item.result === "loaded"));
});

test("missing template falls back to a conditional answer before insufficient", async () => {
  const name = "未注册测试卡";
  const answer = await answerRulingQuestionFast({
    question: `「${name}」效果处理时，如果对象离场要怎么处理？`,
    snapshot: { cards: [{ id: "999001", name, aliases: [name], effectText: "以1只怪兽为对象发动。" }], records: [], snapshotMeta: freshMeta },
    chainLinks: [{ id: "C1", sourceCardId: "999001", effectNo: "1" }],
  });
  assert.equal(answer.answerRoute, "conditional_branch_answer");
  assert.ok(answer.conditionalBranches.length >= 2);
  assert.equal(answer.resolutionSteps.length, 0);
});

test("router returns insufficient only after all earlier routes fail", async () => {
  const answer = await answerRulingQuestionFast({
    question: "完全未知且没有实体、资料或条件的问题",
    snapshot: { cards: [], records: [], snapshotMeta: freshMeta },
  });
  assert.equal(answer.answerRoute, "insufficient");
  assert.equal(answer.status, "insufficient");
  assert.equal(answer.evidenceGrade, "insufficient");
});
