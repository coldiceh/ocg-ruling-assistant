import assert from "node:assert/strict";
import test from "node:test";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

const failureQuestion = `自己场上的「霸王眷龙 凶饿毒」以自己场上的「跳神影精-朱诺白化精」发动其①效果：『1回合1次，以这张卡以外的自己或对方的场上·墓地1只怪兽为对象才能发动。这张卡直到结束阶段得到和那只怪兽的原本的卡名·效果相同的卡名·效果。这个回合，自己怪兽向守备表示怪兽攻击的场合，给与对方为攻击力超过那个守备力的数值的战斗伤害。』这个回合，自己场上的「混绝狱神 比托利姆」攻击时会造成贯穿伤害吗？③：场上的这张卡不受「狱神」怪兽以外的怪兽的效果影响。`;

test("fast judge returns a short validated rule judgment", async () => {
  const answer = await answerRulingQuestionFast({
    question: "测试龙获得贯穿效果后攻击守备怪兽，会造成贯穿战斗伤害吗？",
    mode: "duel",
    snapshot: { cards: [{ id: "1", name: "测试龙", aliases: ["测试龙"], cardType: "monster", effectText: "①：这张卡获得贯穿战斗伤害效果。" }], records: [] },
    modelInvoker: async () => ({
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "测试龙获得贯穿效果后，攻击守备怪兽会按攻击力超过守备力的数值造成战斗伤害。",
      judgeReasoning: [{ text: "测试龙的卡片文本明确涉及获得效果与贯穿战斗伤害。", basis: ["card_text"], refs: ["1"] }],
      requiredFacts: [], assumptions: [], possibleCounterCases: [], confidence: "medium",
    }),
  });
  assert.equal(answer.answerType, "rule_judgment");
  assert.equal(answer.shortAnswer.length <= 120, true);
  assert.equal(answer.pipeline, "fast_judge");
});

test("real failure case never emits off-topic chains", async () => {
  const answer = await answerRulingQuestionFast({ question: failureQuestion, mode: "analysis", debug: true, snapshot: { cards: [], records: [] } });
  const text = JSON.stringify(answer);
  for (const forbidden of ["素材叠放", "超量素材", "No.41", "青眼白龙", "守备表示攻击仍可继续", "攻击怪兽转守后战斗停止"]) assert.ok(!text.includes(forbidden), forbidden);
  const ids = answer.debug.issueFrames.primaryIssueFrames.map((item) => item.id);
  for (const expected of ["copy_or_gain_effect", "piercing_battle_damage", "unaffected_by_effect", "continuous_effect_application"]) assert.ok(ids.includes(expected), expected);
  assert.ok(["needs_clarification", "cannot_answer_safely"].includes(answer.answerType));
});

test("direct official evidence wins before the model and remains official", async () => {
  let modelCalled = false;
  const answer = await answerRulingQuestionFast({
    question: "对方在我的主要阶段发动过怪兽效果后，我能否发动三战之才？",
    snapshot: {
      cards: [{ id: "15296", name: "三战之才", aliases: ["三战之才"], cardType: "spell", effectText: "对方在自己主要阶段发动过怪兽效果的场合才能发动。" }],
      records: [{ id: "card-faq-15296-1", recordType: "card-faq", title: "三战之才 FAQ 1", cards: ["三战之才"], cardIds: ["15296"], text: "这个回合的自己主要阶段对方发动怪兽效果且发动没有被无效的场合，这张卡可以发动。" }],
    },
    modelInvoker: async () => { modelCalled = true; return null; },
  });
  assert.equal(answer.answerType, "direct_official");
  assert.equal(answer.verdict, "can_activate");
  assert.equal(modelCalled, false);
  assert.deepEqual(answer.sourceSummary.officialQaRefs, ["card-faq-15296-1"]);
});

test("timeout never displays an unvalidated model conclusion", async () => {
  const answer = await answerRulingQuestionFast({
    question: "测试龙获得贯穿效果后会造成贯穿伤害吗？",
    maxLatencyMs: 250,
    snapshot: { cards: [{ id: "1", name: "测试龙", aliases: ["测试龙"], cardType: "monster", effectText: "获得贯穿效果。" }], records: [] },
    modelInvoker: async () => new Promise(() => {}),
  });
  assert.equal(answer.answerType, "needs_clarification");
  assert.equal(answer.verdict, "unknown");
  assert.equal(answer.pending, true);
});

test("missing pendulum section blocks model judgment", async () => {
  let modelCalled = false;
  const answer = await answerRulingQuestionFast({
    question: "测试灵摆怪兽的灵摆效果是否适用？",
    snapshot: { cards: [{ id: "9", name: "测试灵摆怪兽", aliases: ["测试灵摆怪兽"], cardType: "Pendulum Monster", isPendulum: true, monsterEffectText: "①：抽1张。" }], records: [] },
    modelInvoker: async () => { modelCalled = true; return null; },
  });
  assert.equal(answer.answerType, "needs_clarification");
  assert.equal(modelCalled, false);
  assert.ok(answer.requiredFacts.some((item) => item.includes("灵摆效果")));
});
