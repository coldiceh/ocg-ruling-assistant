import assert from "node:assert/strict";
import test from "node:test";

import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const localEnv = {
  MODEL_PROVIDER: "mock",
  RAG_MODEL_PROVIDER: "mock",
  RAG_DRY_RUN: "1",
  OCG_ENGINE_ENABLED: "0",
};

const implementedCases = [{
  id: "procedure-banishing-creates-two-trigger-opportunities",
  question: "自己场上表侧表示存在「混沌黑魔术师」，手牌中有「深渊的相剑龙」。本回合自己已经发动过魔法卡的效果。是否可以将「混沌黑魔术师」除外，从额外卡组特殊召唤「毁灭的黑魔术师」？如果可以特殊召唤，之后可以发动哪些效果，连锁如何组成？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /^可以将.*除外.*特殊召唤/u);
    assert.match(answer.shortAnswer, /场上公开信息.*C1/u);
    assert.match(answer.shortAnswer, /对方.*不连锁.*手牌.*C2/u);
  },
}, {
  id: "albaz-cost-enables-opponent-immunity",
  question: "我方额外卡组只有「冰剑龙 幻冰龙」，手牌只有「教导的圣女 艾克莉西亚」和「阿不思的落胤」。对方场上只有表侧表示的「吞食圣痕之龙」，双方墓地都没有卡。我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西亚」作为COST丢弃来发动①效果吗？如果可以，效果如何处理？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /^可以发动/u);
    assert.match(answer.shortAnswer, /cost.*进入墓地/u);
    assert.match(answer.shortAnswer, /不受这次效果影响/u);
    assert.match(answer.shortAnswer, /不进行融合召唤/u);
  },
}, {
  id: "evenly-from-hand-is-field-card-activation",
  officialDirectPreferred: true,
  question: "对方场上通常召唤的「天下独步的大义贼（天下独歩の大義賊）」存在。自己场上没有卡，在战斗阶段结束时从手牌发动「颉颃胜负」。对方可以直接连锁发动「天下独步的大义贼（天下独歩の大義賊）」的①效果吗？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /(?:不能连锁发动|できません)/u);
    assert.match(answer.shortAnswer, /(?:魔法与陷阱区域|魔法・罠カード)/u);
    assert.match(answer.shortAnswer, /(?:最初来自手牌不会改写实际发动区域|手札からフィールドに置いて発動)/u);
  },
}, {
  id: "lotus-changes-yubel-effect-destruction-source",
  question: "我方场上表侧表示存在「尤贝尔之精灵」和「纳祭魔鬼莲」，对方场上表侧表示存在「尤贝尔」。对方结束阶段发动「尤贝尔」的③效果，我方连锁发动「纳祭魔鬼莲」②效果，把那个效果改为破坏场上1只「尤贝尔」怪兽；对方选择破坏自己的「尤贝尔」。这只「尤贝尔」是否算被自身③效果破坏，之后能否发动④效果？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /^不算被/u);
    assert.match(answer.shortAnswer, /自身的③效果原本的处理破坏/u);
    assert.match(answer.shortAnswer, /可以发动④效果/u);
  },
}, {
  id: "silver-hound-control-change-ends-lingering-restriction",
  question: "「月光银狗」的①效果适用后，以该效果特殊召唤的怪兽控制权转移给对方，之后又回到自己场上的场合，『自己不是「月光」怪兽不能从额外卡组特殊召唤』如何适用？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /控制权变更后.*立即不再适用/u);
    assert.match(answer.shortAnswer, /控制权归还.*不会恢复适用/u);
  },
}, {
  id: "zero-rivalry-sequential-resolution",
  question: "对方场上表侧表示存在「千查万别」，我方场上表侧表示存在「闪刀姬＝零露」。我方可以发动「闪刀姬＝零露」的②效果吗？效果处理时先做什么；如果最后破坏「千查万别」或破坏其他卡，场上的两只怪兽分别如何处理？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /^可以发动/u, JSON.stringify({
      resolvedCards: answer.resolvedCards,
      unresolvedMentions: answer.debug.unresolvedMentions,
      diagnostic: answer.debug.semanticStateTransitionDiagnostic,
    }));
    assert.match(answer.shortAnswer, /先把.*同时特殊召唤/u);
    assert.match(answer.shortAnswer, /之后才可以选择破坏/u);
    assert.match(answer.shortAnswer, /两只怪兽都正常留在场上/u);
    assert.match(answer.shortAnswer, /选择1只送去墓地/u);
  },
}, {
  id: "copied-effect-is-not-printed-name-reference",
  question: "自己场上有「霸王眷龙 凶饿猛毒」与「光之黄金柜」。该「霸王眷龙 凶饿猛毒」复制了「破坏龙 钢多拉G」的原本卡名和效果。此时它是否成为效果文本框内记载有「光之黄金柜」卡名的怪兽，并可据此发动要求该记载的卡？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /^不能仅凭复制/u);
    assert.match(answer.shortAnswer, /卡面原本的效果文本/u);
    assert.match(answer.shortAnswer, /复制不会改写卡面印刷文本/u);
    assert.match(answer.shortAnswer, /自身原本卡面没有/u);
  },
}, {
  id: "negated-effect-consumes-use-but-not-unresolved-restriction",
  question: "「破械式鬼シュマ」召唤后发动①效果，对方连锁发动「灰流丽」将其效果无效。这个回合还能再次发动「破械式鬼シュマ」①吗？『这个回合自己只能特殊召唤恶魔族怪兽』还会适用吗？",
  assertions(answer) {
    assert.match(answer.shortAnswer, /不能再次发动/u);
    assert.match(answer.shortAnswer, /(?:不进行.*特殊召唤|特殊召唤.*不进行)/u);
    assert.match(answer.shortAnswer, /(?:不进行.*破坏|破坏.*不进行)/u);
    assert.match(answer.shortAnswer, /限制.*不适用/u);
  },
}];

for (const fixture of implementedCases) {
  test(`strict semantic executor: ${fixture.id}`, async () => {
    const startedAt = performance.now();
    const answer = await answerRagRulingQuestion({
      question: fixture.question,
      env: localEnv,
      dryRun: true,
    });
    const elapsedMs = Math.round(performance.now() - startedAt);

    fixture.assertions(answer);
    const diagnostic = JSON.stringify({
      id: fixture.id,
      shortAnswer: answer.shortAnswer,
      diagnostic: answer.debug.semanticStateTransitionDiagnostic,
    });
    if (fixture.officialDirectPreferred) {
      assert.equal(answer.debug.deterministicDecision, null, diagnostic);
      assert.equal(answer.debug.semanticStateTransitionDiagnostic?.status, "resolved", diagnostic);
      assert.equal(answer.debug.semanticStateTransitionDiagnostic?.authoritative, true, diagnostic);
      assert.ok(answer.usedEvidence.some((item) => item.type === "official_qa"), diagnostic);
    } else {
      assert.equal(answer.debug.deterministicDecision, "state_transition", diagnostic);
      assert.equal(answer.debug.modelUsed, "trusted-semantic-state-executor");
      assert.equal(answer.debug.timingsMs.finalModel, 0);
      assert.ok(answer.riskFlags.includes("trusted_local_semantic_execution"));
      assert.ok(answer.riskFlags.includes("final_model_skipped"));
    }
    assert.equal(answer.debug.timingsMs.auxiliaryExtractionModels, 0);
    assert.deepEqual(answer.debug.unresolvedMentions, []);
    const elapsedBudgetMs = fixture.id === "procedure-banishing-creates-two-trigger-opportunities"
      ? 15_000
      : 3_000;
    assert.ok(elapsedMs < elapsedBudgetMs, `${fixture.id} took ${elapsedMs}ms (budget ${elapsedBudgetMs}ms)`);
  });
}
