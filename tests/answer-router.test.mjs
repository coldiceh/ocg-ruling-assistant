import assert from "node:assert/strict";
import test from "node:test";
import { buildConditionalBranchAnswer } from "../backend/conditionalAnswerBuilder.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

const emptySnapshot = { cards: [], records: [], snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() } };

test("fast_judge_failure_does_not_imply_unable", async () => {
  const answer = await answerRulingQuestionFast({
    question: "测试卡的效果处理时，如果对象离场要怎么处理？",
    snapshot: { ...emptySnapshot, cards: [{ id: "1", name: "测试卡", aliases: ["测试卡"], effectText: "以场上1只怪兽为对象发动。" }] },
    modelInvoker: async () => null,
  });
  assert.equal(answer.answerRoute, "conditional_branch_answer");
  assert.notEqual(answer.answerType, "cannot_answer_safely");
});

test("card_parse_failure_tries_raw_official_qa_search", async () => {
  const question = "「不存在于卡表的别称」能发动吗？";
  const answer = await answerRulingQuestionFast({
    question,
    snapshot: { ...emptySnapshot, records: [{ id: "qa-raw", recordType: "qa", question, answer: "可以发动。", text: `${question} 可以发动。`, status: "current" }] },
  });
  assert.equal(answer.answerRoute, "official_qa_exact_match");
});

test("missing_subphase_returns_conditional_not_unable", () => {
  const answer = buildConditionalBranchAnswer({
    question: "这个效果能在伤害步骤发动吗？",
    damageStepAnalysis: { isDamageStep: true, subphase: "unknown_damage_step_timing" },
  });
  assert.equal(answer.answerRoute, "conditional_branch_answer");
  assert.ok(answer.conditionalBranches.length >= 2);
});

test("related_official_case_returns_conditional_not_unable", () => {
  const answer = buildConditionalBranchAnswer({ question: "类似场景如何处理？", officialMatches: { near: [{ id: "qa-near" }] } });
  assert.equal(answer.answerRoute, "conditional_branch_answer");
  assert.notEqual(answer.answerType, "cannot_answer_safely");
});

test("unable_only_when_no_entities_no_evidence_no_conditions", () => {
  const answer = buildConditionalBranchAnswer({ question: "完全未知问题", contextPack: {}, officialMatches: {} });
  assert.equal(answer, null);
});

test("summon response window uses deterministic rule routing", async () => {
  const answer = await answerRulingQuestionFast({
    question: "七音服灵摆召唤成功时点对方不能发动尼比鲁，之后会不会再给对方补发时点，还是进入开放游戏状态由回合玩家进行1速行动？",
    snapshot: emptySnapshot,
  });
  assert.equal(answer.answerRoute, "rule_engine_answer");
  assert.match(answer.shortAnswer, /开放游戏状态/u);
  assert.match(answer.shortAnswer, /回合玩家/u);
  assert.notEqual(answer.confirmationLevel, "official_confirmed");
});

test("copied targeting effect selects its target at activation", async () => {
  const answer = await answerRulingQuestionFast({
    question: "事务回滚复制无限泡影这种需要取对象的效果时，可以复制吗，对象是在发动时还是处理时选择？",
    snapshot: emptySnapshot,
  });
  assert.equal(answer.verdict, "copied_effect_selects_target_on_activation");
  assert.match(answer.shortAnswer, /发动时选择/u);
});

test("continuous self-destruction does not interrupt current resolution", async () => {
  const answer = await answerRulingQuestionFast({
    question: "彼岸怪兽受拒否神保护时，交织绵羊效果处理过程中墓地变化，自坏永续效果会插入并打断当前处理吗？",
    snapshot: emptySnapshot,
  });
  assert.equal(answer.verdict, "continuous_effect_checked_after_current_resolution");
  assert.match(answer.shortAnswer, /先完成当前效果处理/u);
});

test("card activation permission does not waive numbered effect conditions", async () => {
  const answer = await answerRulingQuestionFast({
    question: "虚空之黑魔导师允许从手卡进行血肉之代偿的卡的发动，是否也能在对方准备阶段同时发动①②效果？",
    snapshot: emptySnapshot,
  });
  assert.equal(answer.verdict, "card_activation_does_not_imply_numbered_effect_activation");
  assert.match(answer.shortAnswer, /不等于/u);
  assert.match(answer.shortAnswer, /发动条件和时点/u);
});
