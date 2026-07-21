import assert from "node:assert/strict";
import test from "node:test";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const localEnv = {
  MODEL_PROVIDER: "mock",
  RAG_MODEL_PROVIDER: "mock",
  RAG_DRY_RUN: "1",
  OCG_ENGINE_ENABLED: "0",
};

test("production fast path rechecks continuous immunity after paying discard cost", async () => {
  const answer = await answerRagRulingQuestion({
    question: "我方额外卡组有「测试冰剑融合龙」。对方场上存在的卡只有表侧表示的「吞食圣痕之龙」1只，双方墓地没有卡。我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西亚」作为Cost丢弃来发动其效果吗，后续怎么处理？",
    cards: [{
      id: "source-fusion",
      name: "阿不思的落胤",
      aliases: ["阿不思的落胤"],
      effectText: "这张卡召唤・特殊召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材进行融合召唤。不可将自己场上其他的怪兽作为融合素材。",
    }, {
      id: "discarded-archetype-card",
      name: "教导的圣女 艾克莉西亚",
      aliases: ["教导的圣女 艾克莉西亚"],
      effectText: "“艾克利西亚”怪兽。",
    }, {
      id: "continuous-immunity-carrier",
      name: "吞喰圣痕之龙",
      aliases: ["吞喰圣痕之龙"],
      cardType: "fusion",
      effectText: "只要自己或对方的场上或墓地存在“艾克利西亚”怪兽，此卡不受此卡以外的效果影响。",
    }, {
      id: "fusion-target",
      name: "测试冰剑融合龙",
      aliases: ["测试冰剑融合龙"],
      effectText: "“阿不思的落胤”＋融合・同步・超量・连接怪兽",
    }],
    records: [],
    qaRecords: [],
    env: localEnv,
    dryRun: true,
  });

  assert.match(answer.shortAnswer, /^可以发动/u, JSON.stringify(answer.debug.semanticStateTransition));
  assert.match(answer.shortAnswer, /不会进行任何效果处理/u);
  assert.match(answer.shortAnswer, /不进行融合召唤/u);
  assert.ok(answer.resolvedCards.some((card) => card.name === "吞喰圣痕之龙"));
  assert.deepEqual(answer.debug.unresolvedMentions, []);
  assert.equal(answer.debug.deterministicDecision, "state_transition");
  assert.equal(answer.debug.modelUsed, "deterministic-ruling-reasoner");
  assert.equal(answer.debug.timingsMs.finalModel, 0);
});

test("complete deterministic preflight skips both auxiliary extraction models", async () => {
  let cardNameModelCalls = 0;
  let ruleQueryModelCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: "我方额外卡组有「测试冰剑融合龙」。对方场上只有表侧表示的「测试抗性龙」。我方召唤「测试融合术士」时，可以将「圣女代价卡」作为Cost丢弃来发动其效果吗，后续怎么处理？",
    cards: [{
      id: "preflight-source",
      name: "测试融合术士",
      effectText: "这张卡召唤・特殊召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材进行融合召唤。不可将自己场上其他的怪兽作为融合素材。",
    }, {
      id: "preflight-cost",
      name: "圣女代价卡",
      effectText: "“圣女”怪兽。",
    }, {
      id: "preflight-protected",
      name: "测试抗性龙",
      cardType: "fusion",
      effectText: "只要自己或对方的场上或墓地存在“圣女”怪兽，此卡不受此卡以外的效果影响。",
    }, {
      id: "preflight-target",
      name: "测试冰剑融合龙",
      cardType: "fusion",
      effectText: "“测试融合术士”＋融合・同步・超量・连接怪兽",
    }],
    records: [],
    qaRecords: [],
    env: localEnv,
    dryRun: true,
    cardModelInvoker: async () => {
      cardNameModelCalls += 1;
      return JSON.stringify({ cardNames: [] });
    },
    ruleModelInvoker: async () => {
      ruleQueryModelCalls += 1;
      return JSON.stringify({ ruleQueries: [] });
    },
  });

  assert.equal(cardNameModelCalls, 0);
  assert.equal(ruleQueryModelCalls, 0);
  assert.equal(answer.debug.cardNameModelUsed, "none");
  assert.equal(answer.debug.ruleQueryModelUsed, "none");
  assert.equal(answer.debug.timingsMs.auxiliaryExtractionModels, 0);
  assert.equal(answer.debug.deterministicDecision, "state_transition");
});

test("incomplete deterministic preflight preserves auxiliary extraction models", async () => {
  let cardNameModelCalls = 0;
  let ruleQueryModelCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: "「尚未收录的测试龙」的效果可以发动吗？",
    cards: [],
    records: [],
    qaRecords: [],
    env: localEnv,
    dryRun: true,
    fetchImpl: async () => new Response(JSON.stringify({ result: [], next: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    cardModelInvoker: async () => {
      cardNameModelCalls += 1;
      return JSON.stringify({ cardNames: [] });
    },
    ruleModelInvoker: async () => {
      ruleQueryModelCalls += 1;
      return JSON.stringify({ ruleQueries: [] });
    },
  });

  assert.equal(cardNameModelCalls, 1);
  assert.equal(ruleQueryModelCalls, 1);
  assert.notEqual(answer.debug.cardNameModelUsed, "none");
  assert.notEqual(answer.debug.ruleQueryModelUsed, "none");
  assert.equal(answer.debug.deterministicDecision, null);
});

test("exact Albaz question with production data includes activation and downstream resolution", async () => {
  const answer = await answerRagRulingQuestion({
    question: "我方的额外卡组有「冰剑龙 幻冰龙」，手牌只有「教导的圣女 艾克莉西娅」和「阿不思的落胤」各1张。\n\n对方场上存在的卡只有表侧表示的「吞食圣痕之龙」1只，双方墓地没有卡。\n\n我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西娅」作为Cost丢弃送去墓地，来发动「阿不思的落胤」的『①』效果吗",
    env: localEnv,
    dryRun: true,
  });

  assert.match(answer.shortAnswer, /^可以发动，但是不会进行任何效果处理/u, JSON.stringify(answer.debug.semanticStateTransition));
  assert.match(answer.shortAnswer, /因此不进行融合召唤/u);
  assert.equal(
    answer.debug.unresolvedMentions.some((mention) => mention.input === "冰剑龙 幻冰龙"),
    false,
  );
  assert.ok(answer.resolvedCards.some((card) => card.name === "教导之圣女 艾克利西亚"));
  assert.ok(answer.resolvedCards.some((card) => card.name === "阿尔白斯之落胤"));
  assert.ok(answer.resolvedCards.some((card) => card.name === "吞喰圣痕之龙"));
  assert.equal(answer.debug.deterministicDecision, "state_transition");
  assert.equal(answer.debug.semanticStateTransition.status, "resolved");
  assert.equal(answer.debug.semanticStateTransition.complete, true);
  assert.equal(
    answer.debug.semanticStateTransition.program.finalState.entities.find((entity) => entity.zone === "graveyard")?.name,
    "教导之圣女 艾克利西亚",
  );
  assert.equal(answer.debug.modelUsed, "deterministic-ruling-reasoner");
  assert.ok(answer.debug.timingsMs.finalModel <= 5);
});

test("deterministic fast path does not ignore an unresolved card in the described state", async () => {
  const answer = await answerRagRulingQuestion({
    question: [
      "我方额外卡组有「测试冰剑融合龙」，手牌有「测试代价卡」。",
      "对方场上有表侧表示的「测试抗性龙」和「未识别屏障」。",
      "我方召唤「测试融合术士」时，将「测试代价卡」作为Cost丢弃发动效果，后续怎么处理？",
    ].join(""),
    cards: [{
      id: "guarded-source",
      name: "测试融合术士",
      effectText: "这张卡召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材进行融合召唤。",
    }, {
      id: "guarded-cost",
      name: "测试代价卡",
      effectText: "测试系列怪兽。",
    }, {
      id: "guarded-material",
      name: "测试抗性龙",
      cardType: "fusion",
      effectText: "只要场上或墓地存在“测试系列”怪兽，此卡不受此卡以外的效果影响。",
    }, {
      id: "guarded-target",
      name: "测试冰剑融合龙",
      cardType: "fusion",
      effectText: "「测试融合术士」＋融合怪兽",
    }],
    records: [],
    qaRecords: [],
    env: localEnv,
    dryRun: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: [], next: 0 }),
    }),
  });

  assert.ok(answer.debug.unresolvedMentions.some((mention) => mention.input === "未识别屏障"));
  assert.equal(answer.debug.deterministicDecision, null);
  assert.notEqual(answer.debug.modelUsed, "deterministic-ruling-reasoner");
});

test("production fast path rejects mandatory return when only the activating trap exists", async () => {
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: [{
      id: "wind-monster",
      name: "绚岚之达象",
      aliases: ["绚岚之达象"],
      cardType: "monster",
      effectText: "风属性怪兽。",
    }, {
      id: "active-trap",
      name: "无限泡影",
      aliases: ["无限泡影"],
      cardType: "trap",
      effectText: "以场上1只怪兽为对象发动。那只怪兽的效果直到回合结束时无效。",
    }, {
      id: "mandatory-returner",
      name: "天雷之双风神 息那",
      aliases: ["天雷之双风神", "天雷之双风神 息那"],
      cardType: "monster",
      effectText: "自己场上存在风属性怪兽，且对手发动魔法・陷阱卡的效果时可以发动。从手牌将此卡特殊召唤。然后，将场上的魔法・陷阱卡全部放回手牌。",
    }],
    records: [{
      id: "rule-active-trap-return",
      recordType: "rule-doc",
      sourceId: "ocg-rule",
      type: "rulebook",
      title: "发动中卡片与必做处理",
      text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。除自身以外没有其他能适用返回处理的魔法・陷阱卡时，要求进行该必做处理的效果不能发动。",
    }],
    qaRecords: [],
    env: localEnv,
    dryRun: true,
  });

  assert.match(answer.shortAnswer, /^不能发动/u);
  assert.ok(answer.resolvedCards.some((card) => card.name === "绚岚之达象"));
  assert.deepEqual(answer.debug.unresolvedMentions, []);
  assert.equal(answer.debug.deterministicDecision, "operation_blocker");
  assert.equal(answer.debug.modelUsed, "deterministic-ruling-reasoner");
  assert.equal(answer.debug.timingsMs.finalModel, 0);
});

test("production fast path orders both players' destruction replacements before dependent summon", async () => {
  const answer = await answerRagRulingQuestion({
    question: "双方场上都只有一只怪兽的时候，对方发动了手卡「破械冥官·笔」的效果，要将场上的「破械焰魔天·阎摩」破坏，此时对方选择适用「破械焰魔天·阎摩」的效果想要破坏我方场上的「完美电子多元驱动蛇·神龙」，我方场上的「完美电子多元驱动蛇·神龙」可以作为被破坏的替代降低1000攻击力吗？如果适用降低1000攻击力，对方的「破械冥官·笔」还能特殊召唤吗？",
    cards: [{
      id: "23172",
      name: "破械冥官カムラ",
      aliases: ["破械冥官·笔", "破械冥官カムラ"],
      effectText: "①：自分フィールドのカードを３枚まで対象として発動できる。そのカードを破壊し、このカードを手札から特殊召喚する。その後、破壊したカードの元々の種類によって以下の効果をそれぞれ適用できる。",
    }, {
      id: "23173",
      name: "破械焔魔天ヤマ",
      aliases: ["破械焰魔天·阎摩", "破械焰魔天 阎摩", "破械焔魔天ヤマ"],
      effectText: "②：フィールドのこのカードが戦闘・効果で破壊される場合、代わりに自分か相手のフィールドの表側表示カード１枚を破壊できる。",
    }, {
      id: "22743",
      name: "パーフェクトロン・ハイドライブ・ドラゴン",
      aliases: ["完美电子多元驱动蛇·神龙", "パーフェクトロン・ハイドライブ・ドラゴン"],
      effectText: "③：攻撃力１０００以上のこのカードが戦闘・効果で破壊される場合、代わりにこのカードの攻撃力を１０００下げた数値にできる。",
    }],
    records: [{
      id: "rule-turn-player-replacement-first",
      recordType: "rule-doc",
      sourceId: "ocg-rule",
      type: "rulebook",
      title: "同一时点双方的代替破坏",
      text: "同1时点双方都要适用代替破坏的效果时，回合玩家的先适用，之后非回合玩家持有这类效果的卡已经不在场上存在的场合，不适用。",
    }],
    qaRecords: [],
    env: localEnv,
    dryRun: true,
  });

  assert.match(answer.shortAnswer, /降攻代替不再适用/u);
  assert.match(answer.shortAnswer, /原本选择的破坏对象没有被破坏/u);
  assert.match(answer.shortAnswer, /后续特殊召唤不处理/u);
  assert.doesNotMatch(answer.shortAnswer, /两次代替依次适用/u);
  assert.equal(answer.debug.deterministicDecision, "operation_sequence");
  assert.equal(answer.debug.modelUsed, "deterministic-ruling-reasoner");
  assert.equal(answer.debug.timingsMs.finalModel, 0);
});
