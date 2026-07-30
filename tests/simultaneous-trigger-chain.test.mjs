import assert from "node:assert/strict";
import test from "node:test";

import {
  TRIGGER_PRIORITY_TIERS,
  analyzeSimultaneousTriggerScenario,
  buildSimultaneousTriggerChain,
  movementEventIsFaceUpBanishByCardEffect,
} from "../backend/simultaneousTriggerChain.mjs";
import { analyzeDeterministicOperationLegality } from "../backend/operationLegalityAnalyzer.mjs";

test("a summon-procedure move replaced by a card effect is still an effect-caused face-up banish", () => {
  const replaced = {
    id: "move-source",
    type: "card_banished",
    actualToZone: "banished",
    faceUpAfter: true,
    causeKind: "summon_procedure",
    replacementEffectId: "self-leave-field-replacement",
    replacementSourceKind: "card_effect",
    provenance: ["summon_procedure", "destination_replacement_card_effect"],
  };
  const procedureOnly = {
    id: "move-source-without-effect",
    actualToZone: "banished",
    faceUpAfter: true,
    causeKind: "summon_procedure",
    provenance: ["summon_procedure"],
  };

  assert.equal(movementEventIsFaceUpBanishByCardEffect(replaced), true);
  assert.equal(movementEventIsFaceUpBanishByCardEffect(procedureOnly), false);
});

test("public optional trigger is declared before private hand trigger and creates an opponent response window", () => {
  const events = [
    {
      id: "summon-success",
      type: "special_summoned",
      subjectDefinitionId: "extra-trigger",
      triggerWindowId: "post-special-summon",
    },
    {
      id: "effect-banish",
      type: "card_banished",
      actualToZone: "banished",
      faceUpAfter: true,
      effectiveCause: "card_effect",
      triggerWindowId: "post-special-summon",
    },
  ];
  const candidates = [
    {
      id: "field-trigger",
      name: "公开区域诱发",
      controller: "self",
      sourceZone: "monster_zone",
      faceUp: true,
      optional: true,
      triggerEventTypes: ["special_summoned"],
      subjectDefinitionId: "extra-trigger",
    },
    {
      id: "hand-trigger",
      name: "非公开手牌诱发",
      controller: "self",
      sourceZone: "hand",
      handPublic: false,
      optional: true,
      triggerEventTypes: ["face_up_banished_by_card_effect"],
    },
  ];

  const initial = buildSimultaneousTriggerChain({
    candidates,
    events,
    triggerWindowId: "post-special-summon",
    turnPlayer: "self",
    publicTriggerSelections: ["field-trigger"],
  });

  assert.equal(initial.chainLinks.length, 1);
  assert.equal(initial.chainLinks[0].candidateId, "field-trigger");
  assert.equal(initial.chainLinks[0].tier, TRIGGER_PRIORITY_TIERS.TURN_PLAYER_OPTIONAL_PUBLIC);
  assert.equal(initial.priorityPlayer, "opponent");
  assert.equal(initial.requiresResponseConfirmation, true);
  assert.deepEqual(initial.pendingPriorityTriggers.map((item) => item.id), ["hand-trigger"]);
  assert.ok(initial.transcript.some((item) => (
    item.type === "offer_response"
    && item.player === "opponent"
    && item.afterChainLink === "C1"
  )));

  const opponentPasses = buildSimultaneousTriggerChain({
    candidates,
    events,
    triggerWindowId: "post-special-summon",
    turnPlayer: "self",
    publicTriggerSelections: ["field-trigger"],
    responseActions: [
      { player: "opponent", type: "pass" },
      { player: "self", type: "activate", candidateId: "hand-trigger" },
    ],
  });

  assert.deepEqual(
    opponentPasses.chainLinks.map((item) => [item.id, item.candidateId]),
    [["C1", "field-trigger"], ["C2", "hand-trigger"]],
  );
  assert.ok(opponentPasses.transcript.some((item) => (
    item.type === "pass" && item.player === "opponent"
  )));
  assert.equal(opponentPasses.priorityPlayer, "opponent");
});

test("a trigger activating from hand stays in the response tier even if the hand is revealed", () => {
  const plan = buildSimultaneousTriggerChain({
    turnPlayer: "self",
    candidates: [
      {
        id: "field-trigger",
        controller: "self",
        sourceZone: "monster_zone",
        faceUp: true,
        optional: true,
      },
      {
        id: "public-hand-trigger",
        controller: "self",
        sourceZone: "hand",
        handPublic: true,
        optional: true,
      },
    ],
    publicTriggerSelections: ["field-trigger"],
  });

  assert.deepEqual(plan.chainLinks.map((item) => item.candidateId), [
    "field-trigger",
  ]);
  assert.deepEqual(plan.pendingPriorityTriggers.map((item) => item.id), [
    "public-hand-trigger",
  ]);
  assert.equal(plan.priorityPlayer, "opponent");
});

test("text-driven scenario inference stays card-name agnostic", () => {
  const userQuery = [
    "自己场上表侧表示存在「测试源怪兽」，手牌中有「测试手牌怪兽」。",
    "本回合自己已经发动过魔法卡的效果。",
    "是否可以将「测试源怪兽」除外，从额外卡组特殊召唤「测试额外怪兽」？",
    "如果可以特殊召唤，那么之后是否可以发动手牌中「测试手牌怪兽」的效果？",
  ].join("\n");
  const cardTexts = [
    {
      id: "source",
      title: "测试源怪兽",
      cards: ["测试源怪兽"],
      cardType: "monster",
      text: "③：表侧表示的此卡离开场上的情况下，将其除外。",
    },
    {
      id: "extra-trigger",
      title: "测试额外怪兽",
      cards: ["测试额外怪兽"],
      cardType: "fusion monster",
      text: "魔法卡的效果发动过的回合，将自己场上的怪兽1只除外的场合，可以从额外卡组特殊召唤。②：这张卡特殊召唤的场合可以发动。从牌组将1张卡加入手牌。",
    },
    {
      id: "hand-trigger",
      title: "测试手牌怪兽",
      cards: ["测试手牌怪兽"],
      cardType: "monster",
      text: "①：卡片的效果使怪兽被除外的场合可以发动。将此卡从手牌・墓地特殊召唤。",
    },
  ];

  const withoutExecutionEvidence = analyzeSimultaneousTriggerScenario({ userQuery, cardTexts });
  assert.equal(withoutExecutionEvidence.recognized, true, JSON.stringify(withoutExecutionEvidence));
  assert.equal(withoutExecutionEvidence.effectBanishConfirmed, false, JSON.stringify(withoutExecutionEvidence));
  assert.equal(withoutExecutionEvidence.complete, false, JSON.stringify(withoutExecutionEvidence));
  assert.equal(
    withoutExecutionEvidence.reason,
    "movement_events_required_for_trusted_trigger_analysis",
  );

  const result = analyzeSimultaneousTriggerScenario({
    userQuery,
    cardTexts,
    movementEvents: [
      {
        id: "special-summoned-extra-trigger",
        type: "special_summoned",
        subjectDefinitionId: "extra-trigger",
        faceUpAfter: true,
        triggerWindowId: "post_special_summon",
      },
      {
        id: "source-banished-by-replacement",
        type: "card_banished",
        subjectDefinitionId: "source",
        actualToZone: "banished",
        faceUpAfter: true,
        causeKind: "summon_procedure",
        replacementSourceKind: "card_effect",
        provenance: ["summon_procedure", "destination_replacement_card_effect"],
        triggerWindowId: "post_special_summon",
      },
    ],
    branchWitness: {
      publicTriggerSelections: ["public-special-summon-trigger:extra-trigger"],
      responseActions: [
        { player: "opponent", type: "pass" },
        {
          player: "self",
          type: "activate",
          candidateId: "private-effect-banish-trigger:hand-trigger",
        },
      ],
    },
  });

  assert.equal(result.effectBanishConfirmed, true, JSON.stringify(result));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.deepEqual(
    result.exampleAfterOpponentPass.chainLinks.map((item) => item.sourceZone),
    ["monster_zone", "hand"],
  );
  assert.match(result.conclusion, /选择发动公开区域.*交给对方.*对方不发动.*手牌连锁发动/u);
});

test("current three-card wording produces the official public-C1 then hand-C2 sequence", () => {
  const userQuery = [
    "自己场上表侧表示存在「混沌的黑魔术师」，手牌中有「深渊的相剑龙」。本回合，自己已经发动过魔法卡的效果。",
    "是否可以将「混沌的黑魔术师」除外，从额外卡组特殊召唤「毁灭的黑魔术师」？",
    "如果可以特殊召唤，那么之后是否可以发动手牌中「深渊的相剑龙」的效果？",
  ].join("\n");
  const cardTexts = [{
    id: "5880",
    title: "混沌的黑魔术师",
    cards: ["混沌的黑魔术师", "混沌の黒魔術師"],
    cardType: "monster",
    text: "此卡名的①效果1回合仅可使用1次。①：此卡召唤・特殊召唤成功的回合的结束阶段，以自己墓地的1张魔法卡为对象可以发动。将该卡加入手牌。②：此卡战斗破坏对手怪兽的伤害计算后发动。将该对手怪兽除外。③：表侧表示的此卡离开场上的情况下，将其除外。",
  }, {
    id: "21610",
    title: "毁灭的黑魔术师",
    cards: ["毁灭的黑魔术师", "滅びの黒魔術師"],
    cardType: "monster",
    text: "“黑魔导”＋光・暗属性怪兽\n“毁灭的黑魔术师”1回合1次，仅可通过融合召唤及以下方法特殊召唤。\n●在发动了魔法卡的效果的回合，将自己场上的1只等级6以上的魔法师族・暗属性怪兽除外的情况下，可从额外牌组特殊召唤。\n①：此卡只要存在于场上・墓地，卡名视为“黑魔导”。\n②：此卡特殊召唤的情况下可以发动。从牌组将1只“黑魔导”或1张记载有该卡名的卡加入手牌。",
  }, {
    id: "18150",
    title: "深渊的相剑龙",
    cards: ["深渊的相剑龙", "深淵の相剣龍"],
    cardType: "monster",
    text: "此卡不可通常召唤，仅可以幻龙族怪兽的效果特殊召唤。此卡名的①②效果1回合仅可各使用1次。①：此卡存在于手牌・墓地，且有怪兽因卡的效果被除外的情况下可以发动。将此卡特殊召唤。以此效果特殊召唤的此卡从场上离开的情况下，将其除外。②：此卡特殊召唤成功的情况下，以场地区域的1张卡和对手场上・墓地的1只怪兽为对象可以发动。将该卡除外。",
  }];

  const movementEvents = [
    {
      id: "special-summoned-21610",
      type: "special_summoned",
      subjectDefinitionId: "21610",
      faceUpAfter: true,
      triggerWindowId: "post_special_summon",
    },
    {
      id: "5880-banished-by-replacement",
      type: "card_banished",
      subjectDefinitionId: "5880",
      actualToZone: "banished",
      faceUpAfter: true,
      causeKind: "summon_procedure",
      replacementSourceKind: "card_effect",
      provenance: ["summon_procedure", "destination_replacement_card_effect"],
      triggerWindowId: "post_special_summon",
    },
  ];
  const branchWitness = {
    publicTriggerSelections: ["public-special-summon-trigger:21610"],
    responseActions: [
      { player: "opponent", type: "pass" },
      {
        player: "self",
        type: "activate",
        candidateId: "private-effect-banish-trigger:18150",
      },
    ],
  };
  const scenarioWithoutExecutionEvidence = analyzeSimultaneousTriggerScenario({
    userQuery,
    cardTexts,
  });
  assert.equal(scenarioWithoutExecutionEvidence.recognized, true);
  assert.equal(scenarioWithoutExecutionEvidence.complete, false);
  assert.equal(scenarioWithoutExecutionEvidence.status, "unknown");

  const scenario = analyzeSimultaneousTriggerScenario({
    userQuery,
    cardTexts,
    movementEvents,
    branchWitness,
  });
  assert.equal(scenario.recognized, true, JSON.stringify(scenario));
  assert.equal(scenario.effectBanishConfirmed, true, JSON.stringify(scenario));
  assert.equal(scenario.complete, true, JSON.stringify(scenario));
  assert.deepEqual(
    scenario.exampleAfterOpponentPass.chainLinks.map((item) => item.name),
    ["毁灭的黑魔术师", "深渊的相剑龙"],
  );

  const ruleEvidence = [{
    id: "ocg-rule:c03/诱发类效果",
    type: "rulebook",
    title: "诱发类效果",
    sourceUrl: "https://ocg-rule.readthedocs.io/zh-cn/latest/c03/%E8%AF%B1%E5%8F%91%E7%B1%BB%E6%95%88%E6%9E%9C.html",
    text: [
      "3. 回合玩家的公开情报的选发的诱发类效果。",
      "从手卡发动的诱发效果，尽管是1速，顺序是7。",
      "当某一方玩家发动卡的效果时，优先权发生转移，该玩家必须把优先权转移给对方。",
    ].join("\n"),
  }];
  const withoutExecutionEvidence = analyzeDeterministicOperationLegality({
    userQuery,
    cardTexts,
    ruleEvidence,
  });
  const conditionalCheck = withoutExecutionEvidence.checks.find((item) => (
    item.operationId === "simultaneous-public-then-private-trigger-chain"
  ));
  assert.equal(conditionalCheck?.status, "conditional", JSON.stringify(withoutExecutionEvidence));
  assert.match(conditionalCheck.conclusion, /实际移动来源确认/u);

  const result = analyzeDeterministicOperationLegality({
    userQuery,
    cardTexts,
    ruleEvidence,
    movementEvents,
    branchWitness,
  });
  const check = result.checks.find((item) => (
    item.operationId === "simultaneous-public-then-private-trigger-chain"
  ));
  assert.equal(check?.status, "legal", JSON.stringify(result));
  assert.match(check.conclusion, /毁灭的黑魔术师.*连锁1.*对方.*深渊的相剑龙.*连锁2/u);
});
