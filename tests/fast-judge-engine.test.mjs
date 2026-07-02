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
      confirmationLevel: "confirmed",
      verdict: "damage_occurs",
      shortAnswer: "测试龙获得贯穿效果后，攻击守备怪兽会按攻击力超过守备力的数值造成战斗伤害。",
      judgeReasoning: [{ text: "测试龙的卡片文本明确涉及获得效果与贯穿战斗伤害。", basis: ["card_text"], refs: ["1"] }],
      requiredFacts: [], assumptions: [], possibleCounterCases: [], confidence: "medium",
    }),
  });
  assert.equal(answer.answerType, "rule_judgment");
  assert.equal(answer.shortAnswer.length <= 120, true);
  assert.equal(answer.pipeline, "fast_judge");
  assert.equal(answer.confirmationLevel, "rule_derived");
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
      snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
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

test("Fast Judge reports rule-era checks", async () => {
  const answer = await answerRulingQuestionFast({
    question: "测试卡会造成贯穿战斗伤害吗？",
    snapshot: { cards: [{ id: "1", name: "测试卡", aliases: ["测试卡"], cardType: "monster", effectText: "给予贯穿战斗伤害。" }], records: [], snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() } },
    modelInvoker: async (input) => ({
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "测试卡攻击守备怪兽时会按文本造成贯穿战斗伤害。",
      judgeReasoning: [{ text: "测试卡文本明确记载贯穿战斗伤害。", basis: ["card_text"], refs: [input.context.relevantCardSections[0].cardId] }],
      confidence: "medium",
    }),
  });
  assert.equal(answer.ruleEraChecked, true);
  assert.equal(answer.staleRisk, "none");
  assert.equal(answer.statusChip, "RULE-JUDGED");
});

test("user-provided full card text can support judgment but never OFFICIAL", async () => {
  const answer = await answerRulingQuestionFast({
    question: "新卡「测试新龙」的完整效果是：『①：这张卡攻击守备表示怪兽的场合，给予攻击力超过守备力数值的贯穿战斗伤害。』它会造成贯穿伤害吗？",
    snapshot: { cards: [], records: [] },
    modelInvoker: async (input) => ({
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "测试新龙按你提供的完整文本，会按攻击力超过守备力的数值造成贯穿战斗伤害，但该文本尚未由数据库校验。",
      judgeReasoning: [{ text: "测试新龙的用户提供文本明确记载攻击力超过守备力时造成贯穿战斗伤害。", basis: ["card_text"], refs: [input.context.relevantCardSections[0].cardId] }],
      confidence: "low",
    }),
  });
  assert.equal(answer.answerType, "rule_judgment");
  assert.notEqual(answer.statusChip, "OFFICIAL");
  assert.equal(answer.staleRisk, "possible");
  assert.equal(answer.unresolvedCardPrompts.length, 1);
});

test("stale official evidence cannot be the only direct official basis", async () => {
  const answer = await answerRulingQuestionFast({
    question: "测试怪兽召唤成功时，能否以优先权发动起动效果？",
    snapshot: {
      cards: [{ id: "7", name: "测试怪兽", aliases: ["测试怪兽"], cardType: "monster", effectText: "主要阶段可以发动这个起动效果。" }],
      records: [{ id: "old-qa", recordType: "qa", title: "旧优先权问答", cards: ["测试怪兽"], cardIds: ["7"], text: "召唤成功时可以优先发动起动效果。", sourceType: "official_qa", format: "ocg", ruleEra: "pre_2011_ignition_priority", staleRisk: "none" }],
    },
  });
  assert.notEqual(answer.answerType, "direct_official");
  assert.equal(answer.statusChip, "OUTDATED-RISK");
  assert.equal(answer.staleRisk, "high");
});

test("illegal target premise returns a primary ruling and a hypothetical chain branch", async () => {
  const question = "在我方的结束阶段，我方场上有1只没有素材的【混沌No.88 机关傀儡-灾厄狮子】，对方基本分2500。对方c1发动【雷破】以灾厄狮子为对象，我方c2发动【隐居者的猛毒药】给与对方800伤害。请问在猛毒药的效果处理后会立刻胜利吗，c1的雷破还会处理吗？";
  const answer = await answerRulingQuestionFast({
    question,
    snapshot: {
      cards: [
        { id: "11016", name: "混沌编号88 机关傀偶－灾厄之狮", aliases: ["混沌No.88 机关傀儡-灾厄狮子"], cardType: "monster", effectText: "在自己的结束阶段，对手的LP为２０００以下，且此卡没有超量素材的情况下，自己获得决斗胜利。双方不可将场上的此卡作为效果的对象。" },
        { id: "5607", name: "隐居者的猛毒药", aliases: ["隐居者的猛毒药"], cardType: "spell", effectText: "给予对方800伤害。" },
      ], records: [], snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
    },
    modelInvoker: async () => { throw new Error("blocker answer must not call the model"); },
  });
  assert.equal(answer.primaryVerdict, "original_chain_illegal");
  assert.equal(answer.normalRuling.verdict, "activation_illegal");
  assert.equal(answer.normalRuling.confirmationLevel, "rule_derived");
  assert.equal(answer.hypotheticalBranch.verdict, "immediate_special_win");
  assert.equal(answer.hypotheticalBranch.confirmationLevel, "conditional");
  assert.match(answer.resolutionSteps[0].action, /2500.*1700/u);
  assert.match(answer.resolutionSteps.at(-1).action, /C1不再处理/u);
  assert.equal(answer.resolutionSteps.at(-1).status, "not_processed");
  assert.equal(answer.resolutionSteps.at(-1).reason, "duel_already_ended");
  assert.equal(answer.afterResolutionCheckpoints[0].terminalVerdict.type, "special_win");
  assert.notEqual(answer.answerType, "direct_official");
});

test("an activated normal trap cannot satisfy the mandatory return handling", async () => {
  const answer = await answerRulingQuestionFast({
    question: "对方场上有『绚岚之达维』，我方以达维为对象发动『无限泡影』，这个时候场上没有其他魔陷，对方能不能发动『天雷之双风神』的效果？",
    snapshot: {
      cards: [
        { id: "13631", name: "无限泡影", aliases: ["无限泡影"], cardType: "trap", effectText: "以对手场上的1只表侧表示怪兽为对象可以发动。" },
        { id: "22130", name: "天雷之双风神 息那", aliases: ["天雷之双风神"], cardType: "monster", effectText: "对手发动魔法・陷阱效果时可以发动。将场上的魔法・陷阱卡全部放回手牌。" },
      ], records: [], snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
    },
  });
  assert.equal(answer.primaryVerdict, "cannot_activate");
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.ok(answer.blockers.some((item) => item.id === "no_applicable_card_for_mandatory_return_effect"));
  assert.notEqual(answer.answerType, "direct_official");
});
