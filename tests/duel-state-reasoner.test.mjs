import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  analyzeDuelStateTransition,
  compileResolvedCardPrograms,
} from "../backend/duelStateReasoner.mjs";
import { resolveEffectChain } from "../backend/effectResolutionEngine.mjs";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData } from "../backend/ragEvidenceRetriever.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

function positionContinuousEffect(sourceCardId = "carrier") {
  return {
    id: "continuous-position-negation",
    sourceCardId,
    effectCategory: "monster",
    activeWhen: { zone: "monster_zone", faceUp: true, position: "defense" },
    constraints: [{
      type: "set_position",
      selector: { zone: "monster_zone", faceUp: true },
      position: "defense",
    }],
    resolutionModifiers: [{
      type: "negate_activated_effect",
      effectCategory: "monster",
      sourcePositionAtActivation: "defense",
    }],
  };
}

function returnLowestLink() {
  return {
    id: "C1",
    order: 1,
    sourceCardId: "source",
    sourceCardName: "回转术士",
    effectCategory: "monster",
    sequence: [createEffectPrimitive("return_lowest_defense_monster_to_hand")],
  };
}

test("generic chain engine keeps an activation snapshot after the source returns to hand", () => {
  const gameState = {
    cards: [
      { cardId: "carrier", name: "沉睡结界兽", controller: "opponent", zone: "monster_zone", faceUp: true, position: "defense", defense: 2000 },
      { cardId: "source", name: "回转术士", controller: "self", zone: "monster_zone", faceUp: true, position: "attack", defense: 500 },
      { cardId: "swap", name: "换位龙", controller: "self", zone: "hand", faceUp: false, position: "none", defense: 2500 },
    ],
  };
  const chainLinks = [
    returnLowestLink(),
    {
      id: "C2",
      order: 2,
      sourceCardId: "swap",
      sourceCardName: "换位龙",
      effectCategory: "monster",
      targets: [{ cardId: "source", name: "回转术士", expectedZone: "monster_zone", validAtResolution: true }],
      sequence: [
        createEffectPrimitive("return_target_to_hand", { targetId: "source", targetExpectedZone: "monster_zone" }),
        { connector: "THEN", primitive: createEffectPrimitive("special_summon_source", { sourceCardId: "swap", sourceExpectedZone: "hand" }) },
      ],
    },
  ];

  const result = resolveEffectChain({
    gameState,
    chainLinks,
    continuousEffects: [positionContinuousEffect()],
  });

  assert.equal(result.preparedChainLinks.find((link) => link.id === "C1").activationSnapshot.sourcePosition, "defense");
  assert.equal(result.linkResults.find((link) => link.id === "C2").status, "resolved");
  assert.equal(result.linkResults.find((link) => link.id === "C1").status, "negated");
  assert.equal(result.finalGameState.cards.find((card) => card.cardId === "source").zone, "hand");
  assert.equal(result.finalGameState.cards.find((card) => card.cardId === "swap").position, "defense");
});

test("generic chain engine rechecks the continuous carrier before each link resolves", () => {
  const gameState = {
    cards: [
      { cardId: "carrier", name: "沉睡结界兽", controller: "opponent", zone: "monster_zone", faceUp: true, position: "defense", defense: 2000 },
      { cardId: "source", name: "回转术士", controller: "self", zone: "monster_zone", faceUp: true, position: "attack", defense: 500 },
      { cardId: "switcher", name: "转向术士", controller: "self", zone: "monster_zone", faceUp: true, position: "attack", defense: 1500 },
    ],
  };
  const chainLinks = [
    returnLowestLink(),
    {
      id: "C2",
      order: 2,
      sourceCardId: "switcher",
      sourceCardName: "转向术士",
      effectCategory: "spell",
      targets: [{ cardId: "carrier", name: "沉睡结界兽", expectedZone: "monster_zone", validAtResolution: true }],
      sequence: [createEffectPrimitive("set_position", { targetId: "carrier", targetExpectedZone: "monster_zone", position: "attack" })],
    },
  ];

  const result = resolveEffectChain({
    gameState,
    chainLinks,
    continuousEffects: [positionContinuousEffect()],
  });

  assert.equal(result.preparedChainLinks.find((link) => link.id === "C1").activationSnapshot.sourcePosition, "defense");
  assert.equal(result.linkResults.find((link) => link.id === "C1").status, "resolved");
  assert.equal(result.finalGameState.cards.find((card) => card.cardId === "carrier").position, "attack");
});

test("an unaffected source is not force-changed and its attack-position activation is not negated", () => {
  const gameState = {
    cards: [
      { cardId: "carrier", name: "沉睡结界兽", controller: "opponent", zone: "monster_zone", faceUp: true, position: "defense", defense: 2000 },
      { cardId: "source", name: "免疫术士", controller: "self", zone: "monster_zone", faceUp: true, position: "attack", defense: 500, unaffectedByMonsterEffects: true },
    ],
  };

  const result = resolveEffectChain({
    gameState,
    chainLinks: [returnLowestLink()],
    continuousEffects: [positionContinuousEffect()],
  });

  assert.equal(result.preparedChainLinks[0].activationSnapshot.sourcePosition, "attack");
  assert.equal(result.linkResults[0].status, "resolved");
});

test("fictional cards with the same card-text semantics use the same compiled simulation", () => {
  const resolvedCards = [
    {
      id: "fictional-carrier",
      input: "沉睡结界兽",
      name: "沉睡结界兽",
      cardType: "monster",
      effectText: "只要此卡以守备表示存在于怪兽区域，场上的表侧表示怪兽变为守备表示，守备表示怪兽发动的效果无效化。",
    },
    {
      id: "fictional-source",
      input: "回转术士",
      name: "回转术士",
      cardType: "monster",
      effectText: "自己・对手回合可以发动。将场上的1只守备力最低的怪兽放回手牌。",
    },
    {
      id: "fictional-swap",
      input: "换位龙",
      name: "换位龙",
      cardType: "monster",
      effectText: "以自己场上的1只怪兽为对象可以发动。将该怪兽放回手牌，从手牌将此卡特殊召唤。",
    },
  ];
  const question = "对方场上的「沉睡结界兽」守备表示存在。我方C1发动场上攻击表示的「回转术士」效果，C2从手牌发动「换位龙」替换，连锁逆算时C1还会弹回守备力最高的怪兽吗？";

  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.activation, "assumed_legal");
  assert.equal(result.resolution, "negated");
  assert.match(result.shortAnswer, /按题设已满足展示等发动手续，C1可以发动/u);
  assert.match(result.shortAnswer, /C2/u);
  assert.match(result.shortAnswer, /被无效/u);
  assert.match(result.shortAnswer, /不进行这个连锁项的效果处理/u);
  assert.doesNotMatch(result.shortAnswer, /不会把怪兽返回手牌/u);
  assert.match(result.shortAnswer, /守备力最低/u);
  const prepared = result.program.preparedChainLinks.find((link) => link.id === "C1");
  assert.equal(result.program.identityModel, "definition_id_and_instance_id_separated");
  assert.equal(prepared.activationPremise, "declared_legal");
  assert.equal(prepared.sourceDefinitionId, "fictional-source");
  assert.equal(prepared.sourceInstanceId, "fictional-source#1");
  assert.notEqual(prepared.sourceDefinitionId, prepared.sourceInstanceId);
  assert.equal(prepared.activationSnapshot.sourcePosition, "defense");
});

test("a declared single chain without a continuous effect is compiled without a hidden two-link gate", () => {
  const resolvedCards = [
    {
      id: "training-target",
      input: "训练兵",
      name: "训练兵",
      cardType: "monster",
      effectText: "通常怪兽。",
    },
    {
      id: "single-swap",
      input: "换位龙",
      name: "换位龙",
      cardType: "monster",
      effectText: "以自己场上的1只怪兽为对象可以发动。将该怪兽放回手牌，从手牌将此卡特殊召唤。",
    },
  ];
  const question = "我方场上有「训练兵」。我方C1从手牌发动「换位龙」的替换效果。";

  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.activation, "assumed_legal");
  assert.equal(result.resolution, "resolved");
  assert.match(result.shortAnswer, /按题设已满足展示等发动手续，C1可以发动/u);
  assert.equal(result.program.preparedChainLinks.length, 1);
  assert.equal(result.program.preparedChainLinks[0].activationPremise, "declared_legal");
  assert.deepEqual(result.program.cardPrograms.map((program) => program.definitionId).sort(), ["single-swap", "training-target"]);
});

test("a non-fusion activation-legality question is not silently converted into a declared-legal premise", () => {
  const resolvedCards = [
    {
      id: "training-target-legality",
      input: "训练兵",
      name: "训练兵",
      cardType: "monster",
      effectText: "通常怪兽。",
    },
    {
      id: "single-swap-legality",
      input: "换位龙",
      name: "换位龙",
      cardType: "monster",
      effectText: "以自己场上的1只怪兽为对象可以发动。将该怪兽放回手牌，从手牌将此卡特殊召唤。",
    },
  ];
  const result = analyzeDuelStateTransition({
    userQuery: "我方场上有「训练兵」，C1从手牌的「换位龙」效果是否可以发动？",
    resolvedCards,
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "activation_legality_not_compiled");
});

test("plain can-still-activate wording is treated as a legality question rather than a declared premise", () => {
  const resolvedCards = [
    {
      id: "training-target-still",
      input: "训练兵",
      name: "训练兵",
      cardType: "monster",
      effectText: "通常怪兽。",
    },
    {
      id: "single-swap-still",
      input: "换位龙",
      name: "换位龙",
      cardType: "monster",
      effectText: "以自己场上的1只怪兽为对象可以发动。将该怪兽放回手牌，从手牌将此卡特殊召唤。",
    },
  ];
  for (const wording of ["「换位龙」的效果还能发动吗？", "「换位龙」的效果发动吗？"]) {
    const result = analyzeDuelStateTransition({
      userQuery: `我方场上有「训练兵」，C1从手牌${wording}`,
      resolvedCards,
    });
    assert.equal(result.status, "not_applicable", JSON.stringify(result));
    assert.equal(result.reason, "activation_legality_not_compiled");
  }
});

test("a lowest-defense correction does not invent negation when the effect resolves", () => {
  const resolvedCards = [
    {
      id: "lowest-source-resolves",
      input: "回转术士",
      name: "回转术士",
      cardType: "monster",
      defense: 800,
      effectText: "自己・对手回合可以发动。将场上的1只守备力最低的怪兽放回手牌。",
    },
    {
      id: "lowest-target-resolves",
      input: "守备靶兽",
      name: "守备靶兽",
      cardType: "monster",
      defense: 1200,
      effectText: "通常怪兽。",
    },
  ];
  const result = analyzeDuelStateTransition({
    userQuery: "我方C1发动场上的「回转术士」效果。对方场上守备表示的「守备靶兽」存在，会弹走守备力最高的怪兽吗？",
    resolvedCards,
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.resolution, "resolved");
  assert.match(result.shortAnswer, /实际选择守备力最低/u);
  assert.doesNotMatch(result.shortAnswer, /本题该处理被无效|不会选择任何怪兽/u);
  assert.equal(result.program.stateInferences.some((item) => item.reason === "declared_legal_field_monster_activation"), true);
});

test("a position change is attributed to its own continuous source rather than the negator", () => {
  const resolvedCards = [
    {
      id: "position-carrier",
      input: "转守结界",
      name: "转守结界",
      cardType: "monster",
      effectText: "场上的表侧表示怪兽变为守备表示。",
    },
    {
      id: "negation-carrier",
      input: "无效结界",
      name: "无效结界",
      cardType: "monster",
      effectText: "只要此卡以守备表示存在于怪兽区域，守备表示怪兽发动的效果无效化。",
    },
    {
      id: "attribution-source",
      input: "回转术士",
      name: "回转术士",
      cardType: "monster",
      effectText: "自己・对手回合可以发动。将场上的1只守备力最低的怪兽放回手牌。",
    },
  ];
  const result = analyzeDuelStateTransition({
    userQuery: "对方场上表侧表示的「转守结界」和表侧守备表示的「无效结界」存在。我方C1发动场上攻击表示的「回转术士」效果。",
    resolvedCards,
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.resolution, "negated");
  assert.match(result.shortAnswer, /「转守结界」的持续效果先将「回转术士」/u);
  assert.match(result.shortAnswer, /满足「无效结界」持续效果的无效条件/u);
});

test("unsupported continuous-effect source categories fail closed instead of being placed in a monster zone", () => {
  const resolvedCards = [
    {
      id: "continuous-spell-unsupported",
      input: "转守永续魔法",
      name: "转守永续魔法",
      cardType: "永续魔法",
      effectText: "场上的表侧表示怪兽变为守备表示。",
    },
    {
      id: "spell-test-source",
      input: "回转术士",
      name: "回转术士",
      cardType: "monster",
      effectText: "自己・对手回合可以发动。将场上的1只守备力最低的怪兽放回手牌。",
    },
  ];
  const result = analyzeDuelStateTransition({
    userQuery: "对方场上表侧表示的「转守永续魔法」存在。我方C1发动场上攻击表示的「回转术士」效果。",
    resolvedCards,
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.reason, "effect_source_category_not_supported");
});

test("missing cardType is inferred as monster only from an explicit source-monster effect structure", () => {
  const [program] = compileResolvedCardPrograms([{
    id: "missing-type-summon-trigger",
    input: "语义融合者",
    name: "语义融合者",
    effectText: "这张卡召唤・特殊召唤的场合，舍弃1张手牌可以发动。将自己或对方场上的怪兽作为融合素材进行融合召唤。",
  }]);

  assert.equal(program.effectCategory, "monster");
  assert.equal(program.effectCategoryBasis, "effect_text_source_summon_trigger");
  assert.equal(program.activatedEffects[0].effectCategory, "monster");
  assert.equal(program.activatedEffects[0].compileIncompleteReason, undefined);
});

test("missing cardType with an otherwise ambiguous operation stays unsupported", () => {
  const [program] = compileResolvedCardPrograms([{
    id: "missing-type-ambiguous-operation",
    input: "无类型融合卡",
    name: "无类型融合卡",
    effectText: "舍弃1张手牌可以发动。将自己或对方场上的怪兽作为融合素材进行融合召唤。",
  }]);

  assert.equal(program.effectCategory, "unknown");
  assert.equal(program.effectCategoryBasis, "missing_card_type_without_monster_structure");
  assert.equal(program.activatedEffects[0].effectCategory, "unknown");
  assert.equal(
    program.activatedEffects[0].compileIncompleteReason,
    "effect_source_category_not_supported",
  );
});

test("another monster being summoned does not classify a missing-type continuous card as a monster", () => {
  const [program] = compileResolvedCardPrograms([{
    id: "missing-type-other-monster-trigger",
    input: "无类型结界",
    name: "无类型结界",
    effectText: "怪兽召唤的场合，场上的表侧表示怪兽变为守备表示。",
  }]);

  assert.equal(program.effectCategory, "unknown");
  assert.equal(program.effectCategoryBasis, "missing_card_type_without_monster_structure");
  assert.equal(program.continuousEffects[0].effectCategory, "unknown");
  assert.equal(
    program.continuousEffects[0].compileIncompleteReason,
    "effect_source_category_not_supported",
  );
});

test("program compilation consumes normalized card-text IR before legacy semantic patterns", () => {
  const programs = compileResolvedCardPrograms([{
    id: "ir-fusion-source",
    name: "测试合成术士",
    cardType: "monster",
    effectText: "①：把手牌中的1张卡丢弃可以发动。从额外卡组融合召唤1只怪兽。",
  }, {
    id: "ir-destination-carrier",
    name: "测试去向结界",
    cardType: "monster",
    effectText: "①：只要此卡存在于怪兽区域，对方的卡送去墓地的场合，不去墓地而除外。",
  }, {
    id: "legacy-fusion-source",
    name: "测试旧式合成",
    cardType: "spell",
    effectText: "将场上的怪兽作为融合素材进行融合召唤。",
  }]);
  const byId = (id) => programs.find((program) => program.definitionId === id);

  const fusion = byId("ir-fusion-source").activatedEffects
    .find((effect) => effect.actionTags.includes("fusion_summon"));
  assert.equal(fusion.semanticSources.fusionSummon, "card_text_ir");
  assert.equal(fusion.semanticSources.discardCost, "card_text_ir");
  assert.deepEqual(fusion.costSpec, {
    type: "discard_from_hand",
    amount: 1,
    player: "self",
  });

  const replacement = byId("ir-destination-carrier").continuousEffects
    .find((effect) => effect.destinationReplacements?.length);
  assert.equal(replacement.semanticSource, "card_text_ir");
  assert.equal(replacement.destinationReplacements[0].intendedToZone, "graveyard");
  assert.equal(replacement.destinationReplacements[0].replacementToZone, "banished");
  assert.equal(
    replacement.destinationReplacements[0].destinationPlayerRelation,
    "opponent_of_source_controller",
  );

  const legacyFusion = byId("legacy-fusion-source").activatedEffects
    .find((effect) => effect.actionTags.includes("fusion_summon"));
  assert.equal(legacyFusion.semanticSources.fusionSummon, "legacy_pattern");
  assert.equal(
    legacyFusion.compileIncompleteReason,
    "legacy_pattern_semantics_not_authoritative",
  );
});

test("program compilation consumes normalized mandatory outputs and grouped field limits", () => {
  const programs = compileResolvedCardPrograms([
    {
      id: "generic-rock-output",
      name: "测试双重降临",
      cardType: "monster",
      race: "岩石族",
      effectText: "①：在主要阶段可以发动。从手牌将此卡特殊召唤。然后，将1只“测试衍生物”（岩石族）特殊召唤至对手场上。",
    },
    {
      id: "generic-race-limit",
      name: "测试种族限制",
      cardType: "trap",
      effectText: "①：只要此卡存在于魔法与陷阱区域，双方场上各只可有1只同种族怪兽以表侧表示存在。",
    },
  ]);
  const summonEffect = programs.find((program) => program.definitionId === "generic-rock-output")
    .activatedEffects.find((effect) => effect.mandatorySpecialSummonOutputs?.length);
  const restrictionEffect = programs.find((program) => program.definitionId === "generic-race-limit")
    .continuousEffects.find((effect) => effect.fieldRestrictions?.length);

  assert.equal(summonEffect.semanticSource, "card_text_ir");
  assert.deepEqual(
    summonEffect.mandatorySpecialSummonOutputs.map((output) => [
      output.subject,
      output.playerRelation,
      output.race,
    ]),
    [
      ["effect_source", "same_as_source_controller", "岩石族"],
      ["generated_monster", "opponent_of_source_controller", "岩石族"],
    ],
  );
  assert.equal(restrictionEffect.semanticSource, "card_text_ir");
  assert.deepEqual(restrictionEffect.fieldRestrictions[0], {
    type: "max_face_up_monsters_per_race_per_player",
    maxCount: 1,
  });
});

test("a compiled bound-restriction lifecycle expires on control change and never reactivates", () => {
  const result = analyzeDuelStateTransition({
    userQuery: [
      "「架空月影兽」的①效果已经适用。",
      "以该效果特殊召唤的怪兽控制权变更后，限制还适用吗？",
      "之后控制权归还时会恢复吗？",
    ].join(""),
    resolvedCards: [{
      id: "fictional-bound-restriction-source",
      name: "架空月影兽",
      cardType: "monster",
      effectText: "①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「月影」怪兽。",
    }],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.activation, "already_resolved");
  assert.equal(result.resolution, "bound_lingering_restriction_lifecycle_resolved");
  assert.equal(result.reason, "bound_condition_failed_irreversibly");
  assert.deepEqual(
    result.debug.snapshots.map((snapshot) => [snapshot.event, snapshot.controller, snapshot.effectStatus]),
    [
      ["create_lingering_effect", "self", "active"],
      ["change_control", "opponent", "expired"],
      ["change_control", "self", "expired"],
    ],
  );
  assert.deepEqual(
    result.trace.filter((entry) => entry.phase === "effect_instance_lifecycle")
      .map((entry) => entry.result),
    ["condition_still_met", "condition_failed_irreversibly", "remains_expired"],
  );
  assert.match(result.shortAnswer, /立即不再适用/u);
  assert.match(result.shortAnswer, /不会恢复适用/u);
});

test("bound-restriction lifecycle compilation is invariant under complete card and archetype renaming", () => {
  const makeResult = ({ cardId, cardName, archetype }) => analyzeDuelStateTransition({
    userQuery: [
      `「${cardName}」的①效果已经适用。`,
      "以该效果特殊召唤的怪兽控制权变更后，限制还适用吗？",
      "之后控制权归还时会恢复吗？",
    ].join(""),
    resolvedCards: [{
      id: cardId,
      name: cardName,
      cardType: "monster",
      effectText: `①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「${archetype}」怪兽。`,
    }],
  });
  const first = makeResult({ cardId: "renamed-alpha", cardName: "折光航标", archetype: "棱镜" });
  const second = makeResult({ cardId: "renamed-beta", cardName: "雾海测距仪", archetype: "潮汐" });

  for (const result of [first, second]) {
    assert.equal(result.status, "resolved", JSON.stringify(result));
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.debug.snapshots.map((snapshot) => [snapshot.controller, snapshot.effectStatus]),
      [["self", "active"], ["opponent", "expired"], ["self", "expired"]],
    );
  }
});

test("the real summon-bound wording executes through the generic lifecycle compiler", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「月光银狗」的①效果适用后，这个效果特殊召唤的怪兽控制权变更的场合，『自己不是「月光」怪兽不能从额外卡组特殊召唤』还适用吗，之后控制权归还还会恢复适用吗？",
    resolvedCards: [{
      id: "21417",
      name: "月光银狗",
      cardType: "monster",
      effectText: "此卡名的①②效果1回合仅可各使用1次。\n①：此卡因效果被送至墓地的情况下可以发动。从牌组将“月光银狗”以外的1只“月光”怪兽特殊召唤。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组仅可特殊召唤“月光”怪兽。\n②：魔法・陷阱卡的效果在场上发动时，从自己墓地将此卡和1只“月光”融合怪兽除外可以发动。将该发动无效。",
    }],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.debug.snapshots.map((snapshot) => [snapshot.controller, snapshot.effectStatus]),
    [["self", "active"], ["opponent", "expired"], ["self", "expired"]],
  );
  assert.match(result.shortAnswer, /立即不再适用/u);
  assert.match(result.shortAnswer, /不会恢复适用/u);
});

test("an already-created numbered-effect output is enough to compile its exact control lifecycle question", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「月光银狗」①效果特殊召唤的怪兽控制权变更到对方场上的场合，『自己不是「月光」怪兽不能从额外卡组特殊召唤』还适用吗？之后那只怪兽的控制权归还时，这个限制会恢复适用吗？",
    resolvedCards: [{
      id: "21417",
      name: "月光银狗",
      cardType: "monster",
      effectText: "此卡名的①②效果1回合仅可各使用1次。\n①：此卡因效果被送至墓地的情况下可以发动。从牌组将“月光银狗”以外的1只“月光”怪兽特殊召唤。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组仅可特殊召唤“月光”怪兽。\n②：魔法・陷阱卡的效果在场上发动时，从自己墓地将此卡和1只“月光”融合怪兽除外可以发动。将该发动无效。",
    }],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.reason, "bound_condition_failed_irreversibly");
  assert.deepEqual(
    result.debug.snapshots.map((snapshot) => [snapshot.controller, snapshot.effectStatus]),
    [["self", "active"], ["opponent", "expired"], ["self", "expired"]],
  );
  assert.match(result.shortAnswer, /立即不再适用/u);
  assert.match(result.shortAnswer, /不会恢复适用/u);
});

test("a return to the original field does not require the noun 'control' to be repeated", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「折光航标」的①效果已经适用。以该效果特殊召唤的怪兽控制权转移给对方，之后又回到自己场上的场合，限制会恢复吗？",
    resolvedCards: [{
      id: "bound-implicit-return",
      name: "折光航标",
      cardType: "monster",
      effectText: "①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「棱镜」怪兽。",
    }],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.deepEqual(
    result.debug.snapshots.map((snapshot) => [snapshot.controller, snapshot.effectStatus]),
    [["self", "active"], ["opponent", "expired"], ["self", "expired"]],
  );
});

test("a completed numbered-effect output is an applied-state premise after complete renaming", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「雾海测距仪」①特殊召唤出的怪兽先被对方取得控制权，后来又回到我方场上。与该怪兽在我方场上存在相绑定的额外卡组特殊召唤限制会恢复吗？",
    resolvedCards: [{
      id: "bound-result-state-premise",
      name: "雾海测距仪",
      cardType: "monster",
      effectText: "①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「潮汐」怪兽。",
    }],
  });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /立即不再适用/u);
  assert.match(result.shortAnswer, /不会恢复适用/u);
});

test("bound-restriction lifecycle compiler fails closed without an already-applied premise", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「折光航标」以该效果特殊召唤的怪兽控制权变更后，限制还适用吗？之后控制权归还会恢复吗？",
    resolvedCards: [{
      id: "bound-premise-missing",
      name: "折光航标",
      cardType: "monster",
      effectText: "①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「棱镜」怪兽。",
    }],
  });

  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "bound_lingering_restriction_lifecycle_not_compiled");
});

test("bound-restriction lifecycle compiler does not invent a later control return", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「折光航标」的①效果已经适用。以该效果特殊召唤的怪兽控制权变更后，限制还适用吗？",
    resolvedCards: [{
      id: "bound-no-return",
      name: "折光航标",
      cardType: "monster",
      effectText: "①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「棱镜」怪兽。",
    }],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.deepEqual(
    result.debug.snapshots.map((snapshot) => [snapshot.controller, snapshot.effectStatus]),
    [["self", "active"], ["opponent", "expired"]],
  );
  assert.doesNotMatch(result.shortAnswer, /归还|恢复/u);
});

test("changing the source card's control is not compiled as a bound-output lifecycle event", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "「折光航标」的①效果已经适用。之后「折光航标」自身的控制权变更，限制还适用吗？",
    resolvedCards: [{
      id: "bound-source-change-only",
      name: "折光航标",
      cardType: "monster",
      effectText: "①：可以发动。从卡组特殊召唤1只怪兽。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组只能特殊召唤「棱镜」怪兽。",
    }],
  });

  assert.equal(result.complete, false, JSON.stringify(result));
  assert.notEqual(result.reason, "bound_condition_failed_irreversibly");
});

test("an uncompiled summon-then-destroy checkpoint cannot claim activation or branch outcomes", () => {
  const result = analyzeDuelStateTransition({
    userQuery: [
      "对方场上表侧表示存在「架空种族限制」。",
      "我方可以发动「架空双体术」吗？",
      "特殊召唤后若破坏「架空种族限制」，两只怪兽会怎样处理？",
    ].join(""),
    resolvedCards: [{
      id: "fictional-ordered-summon-destroy",
      name: "架空双体术",
      cardType: "spell",
      effectText: "①：可以发动。从卡组将「架空战士甲」「架空战士乙」各1只特殊召唤。然后，可以将场上1张卡破坏。",
    }, {
      id: "fictional-field-count-limit",
      name: "架空种族限制",
      cardType: "trap",
      effectText: "①：只要此卡存在于魔法与陷阱区域，双方场上各只可有1只同种族怪兽以表侧表示存在。",
    }],
  });

  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.activation, "unknown");
  assert.equal(result.resolution, "unknown");
  assert.equal(result.reason, "ordered_summon_destroy_checkpoint_not_compiled");
  assert.equal(result.debug.compiled.complete, false);
  assert.deepEqual(result.trace, []);
  assert.doesNotMatch(result.shortAnswer, /可以发动|先特殊召唤两只|两只怪兽都留下/u);
});

test("generic symbolic fusion preserves its trace but is conditional rather than complete", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "当对方场上存在「墓地改道兽」时，自己仍然可以发动「融合术式」吗？如果发动时丢弃手牌，并将对方的「墓地改道兽」和自己场上的怪兽作为融合素材，卡片分别去哪里？",
    resolvedCards: [
      {
        id: "generic-fusion-spell",
        name: "融合术式",
        cardType: "spell",
        effectText: "①：舍弃1张手牌可以发动。以自己・对手场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
      },
      {
        id: "generic-replacement-monster",
        name: "墓地改道兽",
        cardType: "monster",
        effectText: "①：只要此卡存在于怪兽区域，对方的卡送去墓地的场合，不去墓地而除外。",
      },
    ],
  });

  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.conditional, true);
  assert.ok(result.authorityReasons.includes("synthetic_entity_or_material"));
  assert.equal(result.activation, "legal");
  assert.equal(result.activationAssumption, "valid_fusion_material_configuration");
  assert.equal(result.symbolicMaterialBranch, "replacement_carrier_used_as_material");
  const costMove = result.trace
    .find((step) => step.phase === "pay_activation_cost").proof[0].moves[0];
  assert.equal(costMove.intendedToZone, "graveyard");
  assert.equal(costMove.actualToZone, "banished");
  const fusionProof = result.trace
    .find((step) => step.phase === "resolve_effect_operation").proof;
  assert.deepEqual(fusionProof.materialMoves.map((move) => move.actualToZone), [
    "graveyard",
    "graveyard",
  ]);
  assert.equal(fusionProof.suppressedDestinationReplacementEffectIds.length, 1);
});

test("an unspecified field card is not fabricated as face-up to enable its continuous effect", () => {
  const resolvedCards = [
    {
      id: "unknown-faceup-carrier",
      input: "未知结界兽",
      name: "未知结界兽",
      cardType: "monster",
      effectText: "只要此卡存在于怪兽区域，场上的表侧表示怪兽变为守备表示，守备表示怪兽发动的效果无效化。",
    },
    {
      id: "known-source",
      input: "回转术士",
      name: "回转术士",
      cardType: "monster",
      effectText: "自己・对手回合可以发动。将场上的1只守备力最低的怪兽放回手牌。",
    },
  ];
  const result = analyzeDuelStateTransition({
    userQuery: "对方场上有「未知结界兽」。我方C1发动场上攻击表示的「回转术士」效果。",
    resolvedCards,
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "compiled_chain_not_complete", JSON.stringify(result));
  assert.equal(result.debug.simulation.incompleteReason, "continuous_effect_applicability_unknown");
});

test("the compiler does not fabricate one operation by joining separate numbered effects", () => {
  const resolvedCards = [{
    id: "split-effect-definition",
    input: "分段术士",
    name: "分段术士",
    cardType: "monster",
    effectText: [
      "①：将场上的1只怪兽放回手牌。",
      "②：场上的1只守备力最低的怪兽攻击力下降500。",
    ].join("\n"),
  }];
  const result = analyzeDuelStateTransition({
    userQuery: "我方C1发动场上的「分段术士」效果。",
    resolvedCards,
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "declared_chain_link_not_compiled");
});

test("multiple same-definition instances reject an unbound chain source", () => {
  const resolvedCards = [{
    id: "ambiguous-source-definition",
    input: "回转术士",
    name: "回转术士",
    cardType: "monster",
    effectText: "自己・对手回合可以发动。将场上的1只守备力最低的怪兽放回手牌。",
  }];
  const question = "我方C1发动场上2只「回转术士」中的1只的效果，能弹回守备力最低的怪兽吗？";

  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "ambiguous_chain_source_instance");
  assert.deepEqual(result.debug.candidateInstanceIds, [
    "ambiguous-source-definition#1",
    "ambiguous-source-definition#2",
  ]);
});

const originalUserQuestions = [
  "当对手场上的no.41防守表示存在时，我c1发动场上vs狂魔博士的效果，c2手牌龙帝进行替换，连锁处理结算时，c1的博士效果还会生效弹走场上防御力最高的卡吗？",
  "当对手场上的【No.41 泥睡魔兽 睡梦貘】防守表示在场上存在。我方c1发动场上攻击表示的【VS狂魔博士】效果，C2从手牌发动【龙帝】替换效果，连锁逆算处理时，c1的博士效果还会生效弹走场上防御力最高的卡吗？",
];

test("a bare numbered-card identity resolves only within the exact numbered family", () => {
  const cards = [
    { id: "no41", name: "编号41 测试兽", jaName: "No.41 テスト", aliases: ["编号41 测试兽", "No.41 テスト"] },
    { id: "cno41", name: "混沌编号41 测试兽", jaName: "CNo.41 テスト", aliases: ["混沌编号41 测试兽", "CNo.41 テスト"] },
  ];

  const noResult = extractRagCards("对方场上的no.41防守表示存在。", { cards });
  const cnoResult = extractRagCards("对方场上的CNo.41防守表示存在。", { cards });

  assert.deepEqual(noResult.resolvedCards.map((card) => card.id), ["no41"]);
  assert.deepEqual(cnoResult.resolvedCards.map((card) => card.id), ["cno41"]);
});

test("a unique numbered identity merges a legacy localized subtitle and propagates it as an alias", () => {
  const legacyName = "No.41 泥睡魔兽 酣睡貘";
  const cards = [{
    id: "13163",
    name: "编号41 泥睡魔兽 貘熟梦",
    jaName: "No.41 泥睡魔獣バグースカ",
    enName: "Number 41: Bagooska the Terribly Tired Tapir",
    aliases: [
      "编号41 泥睡魔兽 貘熟梦",
      "No.41 泥睡魔獣バグースカ",
      "Number 41: Bagooska the Terribly Tired Tapir",
    ],
  }];

  const result = extractRagCards(`对方场上的「${legacyName}」以守备表示存在。`, { cards });

  assert.deepEqual(result.resolvedCards.map((card) => card.id), ["13163"]);
  assert.equal(result.resolvedCards[0].input, legacyName);
  assert.ok(result.resolvedCards[0].aliases.includes(legacyName));
  assert.deepEqual(result.unresolvedMentions, []);
});

test("a numbered subtitle cannot choose arbitrarily when one identity maps to multiple cards", () => {
  const cards = [
    { id: "no41-a", name: "编号41 甲龙", aliases: ["No.41 甲龙"] },
    { id: "no41-b", name: "编号41 乙龙", aliases: ["No.41 乙龙"] },
  ];

  const result = extractRagCards("对方场上的「No.41 旧译兽」以守备表示存在。", { cards });

  assert.deepEqual(result.resolvedCards, []);
  assert.ok(result.unresolvedMentions.length || result.ambiguousMentions.length);
});

test("both original user phrasings resolve all cards while the final model owns the verdict", async () => {
  const data = await loadRagData();
  for (const [questionIndex, question] of originalUserQuestions.entries()) {
    const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });
    const resolvedIds = new Set(cardResolution.resolvedCards.map((card) => card.id));
    assert.deepEqual(
      new Set(["13163", "18730", "18732"]),
      new Set([...resolvedIds].filter((id) => ["13163", "18730", "18732"].includes(id))),
      JSON.stringify(cardResolution),
    );
    assert.equal(cardResolution.unresolvedMentions.length, 0, JSON.stringify(cardResolution.unresolvedMentions));

    const direct = analyzeDuelStateTransition({
      userQuery: question,
      resolvedCards: cardResolution.resolvedCards,
    });
    assert.equal(direct.status, "resolved", JSON.stringify(direct));
    assert.equal(direct.activation, "assumed_legal");
    assert.equal(direct.activationBasis, "declared_legal");
    assert.equal(direct.resolution, "negated");
    assert.match(direct.shortAnswer, /按题设已满足展示等发动手续，C1可以发动/u);
    assert.match(direct.shortAnswer, /C2/u);
    assert.match(direct.shortAnswer, /被无效/u);
    assert.match(direct.shortAnswer, /不进行这个连锁项的效果处理/u);
    assert.doesNotMatch(direct.shortAnswer, /不会把怪兽返回手牌/u);
    const initialDoctor = direct.program.initialState.cards.find((card) => card.definitionId === "18730");
    assert.equal(initialDoctor.position, questionIndex === 0 ? "unknown" : "attack");
    assert.equal(
      direct.program.preparedChainLinks.find((link) => link.id === "C1").activationSnapshot.sourcePosition,
      "defense",
    );
    assert.equal(
      direct.program.preparedChainLinks.find((link) => link.id === "C2").activationSnapshot.sourceZone,
      "hand",
    );
    assert.deepEqual(
      direct.program.stateSnapshots.map((snapshot) => [snapshot.stage, snapshot.chainLink || ""]),
      [
        ["before_chain_activation", "C1"],
        ["after_chain_activation", "C1"],
        ["before_chain_activation", "C2"],
        ["after_chain_activation", "C2"],
        ["before_chain_resolution", ""],
        ["after_chain_link", "C2"],
        ["after_chain_link", "C1"],
      ],
    );
    assert.equal(
      direct.program.finalState.cards.find((card) => card.definitionId === "18730").zone,
      "hand",
    );
    assert.equal(
      direct.program.finalState.cards.find((card) => card.definitionId === "18732").position,
      "defense",
    );

    let finalPrompt = "";
    let finalModelCalls = 0;
    const answer = await answerRagRulingQuestion({
      question,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      dryRun: false,
      env: {
        RAG_PROVIDER: "mock",
        MODEL_PROVIDER: "mock",
        OCG_ENGINE_AUTO_SIMULATION: "false",
      },
      cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),
      ruleModelInvoker: async () => JSON.stringify({ queries: [] }),
      modelInvoker: async ({ prompt }) => {
        finalModelCalls += 1;
        finalPrompt = prompt;
        return JSON.stringify({
          answerLevel: "rule_analysis",
          shortAnswer: "按题设已经完成展示等发动手续，C1可以发动。C2处理后，C1发动源在守备表示，因此C1效果被无效，不进行这个连锁项的效果处理。",
          reasoning: [
            "题面已经把C1记载为发动完成，不能在处理阶段倒推为未发动。",
            "连锁逆算时先处理C2，再依据更新后的场面处理C1；此时持续无效效果适用。",
          ],
          usedCards: ["No.41 泥睡魔兽 酣睡貘", "VS 狂爱博士", "龙帝 瓦利乌斯"],
          usedEvidence: [],
          missingInfo: [],
          riskFlags: [],
          confidenceSelfEstimate: "high",
        });
      },
      fetchImpl: async () => new Response(JSON.stringify({ result: [], next: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const answerIds = new Set(answer.resolvedCards.map((card) => card.id));
    for (const id of ["13163", "18730", "18732"]) assert.equal(answerIds.has(id), true, id);
    assert.match(answer.shortAnswer, /可以发动/u);
    assert.match(answer.shortAnswer, /C2/u);
    assert.match(answer.shortAnswer, /被无效/u);
    assert.match(answer.shortAnswer, /不进行这个连锁项的效果处理/u);
    assert.doesNotMatch(answer.shortAnswer, /不会把怪兽返回手牌/u);
    assert.match(finalPrompt, /no\.41/iu);
    assert.match(finalPrompt, /vs狂魔博士|对击斗魂 狂恋博士/iu);
    assert.equal(finalModelCalls, 1);
    assert.equal(answer.debug.semanticStateTransition?.authoritative, false);
    assert.equal(answer.debug.semanticStateTransitionDiagnostic, null);
    assert.equal(answer.debug.deterministicDecision, null);
    assert.notEqual(answer.debug.modelUsed, "deterministic-ruling-reasoner");
  }
});

function fictionalFusionCase(tag, { includeAlternativeMaterial = false, targetHasRecipe = true } = {}) {
  const sourceName = "织合术士" + tag;
  const costName = "墓启圣女" + tag;
  const protectedName = "护界融合龙" + tag;
  const targetName = "终式融合龙" + tag;
  const alternativeName = "替代同步龙" + tag;
  const ids = {
    source: "source-" + tag,
    cost: "cost-" + tag,
    protected: "protected-" + tag,
    target: "target-" + tag,
    alternative: "alternative-" + tag,
  };
  const cards = [{
    id: ids.source,
    name: sourceName,
    aliases: [sourceName],
    cardType: "monster",
    effectText: "这张卡召唤・特殊召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材，将1只融合怪兽融合召唤。在此之际，不可将自己场上其他怪兽作为融合素材。",
  }, {
    id: ids.cost,
    name: costName,
    aliases: [costName],
    cardType: "monster",
    effectText: "通常怪兽。",
  }, {
    id: ids.protected,
    name: protectedName,
    aliases: [protectedName],
    cardType: "fusion",
    effectText: "只要自己或对方的场上或墓地存在“" + costName + "”怪兽，此卡不受此卡以外的效果影响。",
  }, {
    id: ids.target,
    name: targetName,
    aliases: [targetName],
    cardType: "fusion",
    effectText: targetHasRecipe
      ? "“" + sourceName + "”＋融合・同步・超量・连接怪兽"
      : "融合怪兽。",
  }];
  if (includeAlternativeMaterial) {
    cards.push({
      id: ids.alternative,
      name: alternativeName,
      aliases: [alternativeName],
      cardType: "synchro",
      effectText: "同步怪兽。",
    });
  }
  const opponentField = includeAlternativeMaterial
    ? "对方场上只有表侧表示的「" + protectedName + "」和「" + alternativeName + "」各1只。"
    : "对方场上只有表侧表示的「" + protectedName + "」1只。";
  return {
    ids,
    cards,
    question: [
      "我方额外卡组有「" + targetName + "」，手牌有「" + costName + "」和「" + sourceName + "」各1张。",
      opponentField,
      "双方墓地没有卡。我方召唤「" + sourceName + "」时，可以将「" + costName + "」作为Cost丢弃来发动「" + sourceName + "」的效果吗，后续怎么处理？",
    ].join(""),
  };
}

function fictionalFusionSignature(result, ids) {
  const initial = result.program.initialState.cards;
  const final = result.program.finalState.cards;
  const zone = (cards, definitionId) => cards.find((card) => card.definitionId === definitionId)?.zone;
  const modifiers = final
    .find((card) => card.definitionId === ids.protected)
    ?.derivedModifiers
    ?.map((modifier) => modifier.type) || [];
  return {
    status: result.status,
    complete: result.complete,
    activation: result.activation,
    resolution: result.resolution,
    phases: result.trace.map((step) => step.phase),
    initialZones: [
      zone(initial, ids.source),
      zone(initial, ids.cost),
      zone(initial, ids.protected),
      zone(initial, ids.target),
    ],
    finalZones: [
      zone(final, ids.source),
      zone(final, ids.cost),
      zone(final, ids.protected),
      zone(final, ids.target),
    ],
    protectedModifiers: modifiers,
  };
}

test("renaming every fictional card preserves the compiled cost, stabilization, and fusion outcome", () => {
  const first = fictionalFusionCase("甲");
  const second = fictionalFusionCase("乙");
  const firstResult = analyzeDuelStateTransition({ userQuery: first.question, resolvedCards: first.cards });
  const secondResult = analyzeDuelStateTransition({ userQuery: second.question, resolvedCards: second.cards });
  const firstSignature = fictionalFusionSignature(firstResult, first.ids);
  const secondSignature = fictionalFusionSignature(secondResult, second.ids);

  assert.deepEqual(secondSignature, firstSignature);
  assert.deepEqual(firstSignature, {
    status: "resolved",
    complete: true,
    activation: "legal",
    resolution: "not_performed",
    phases: ["activation_check", "pay_activation_cost", "stabilize_continuous_effects", "resolve_effect_operation"],
    initialZones: ["monster_zone", "hand", "monster_zone", "extra_deck"],
    finalZones: ["monster_zone", "graveyard", "monster_zone", "extra_deck"],
    protectedModifiers: ["unaffected_by_other_effects"],
  });
  assert.doesNotMatch(JSON.stringify([firstResult, secondResult]), /阿不思|艾克利西亚|吞(?:食|喰)圣痕|冰剑龙/u);
});

test("swapping the activating player preserves relative cost and material semantics", () => {
  const fixture = fictionalFusionCase("镜");
  const name = (id) => fixture.cards.find((card) => card.id === id).name;
  const question = [
    "对方额外卡组有「" + name(fixture.ids.target) + "」，对方手牌有「"
      + name(fixture.ids.cost) + "」和「" + name(fixture.ids.source) + "」各1张。",
    "我方场上只有表侧表示的「" + name(fixture.ids.protected) + "」1只，双方墓地没有卡。",
    "对方召唤「" + name(fixture.ids.source) + "」时，可以将「" + name(fixture.ids.cost)
      + "」作为Cost丢弃来发动「" + name(fixture.ids.source) + "」的效果吗，后续怎么处理？",
  ].join("");

  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards: fixture.cards });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "legal");
  assert.equal(result.resolution, "not_performed");
  const initial = result.program.initialState.cards;
  const final = result.program.finalState.cards;
  const card = (state, id) => state.find((item) => item.definitionId === id);
  assert.equal(card(initial, fixture.ids.source).controller, "opponent");
  assert.equal(card(initial, fixture.ids.cost).controller, "opponent");
  assert.equal(card(final, fixture.ids.cost).zone, "graveyard");
  assert.equal(card(final, fixture.ids.cost).controller, "opponent");
  assert.equal(card(final, fixture.ids.protected).zone, "monster_zone");
  assert.match(result.shortAnswer, /可以发动/u);
  assert.match(result.shortAnswer, /不进行融合召唤/u);
});

test("a one-sided own-field material pool follows the effect controller after player swap", () => {
  const cards = [{
    id: "perspective-source",
    name: "镜界织术师",
    cardType: "monster",
    effectText: "这张卡召唤的场合可以发动。将包含此卡在内的自己场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
  }, {
    id: "perspective-own-material",
    name: "逆位同步兽",
    cardType: "synchro",
    effectText: "同步怪兽。",
  }, {
    id: "perspective-other-material",
    name: "顺位同步兽",
    cardType: "synchro",
    effectText: "同步怪兽。",
  }, {
    id: "perspective-target",
    name: "镜界终成体",
    cardType: "fusion",
    effectText: "「镜界织术师」＋同步怪兽",
  }];
  const question = [
    "对方额外卡组有「镜界终成体」。",
    "对方场上有表侧表示的「逆位同步兽」，我方场上有表侧表示的「顺位同步兽」。",
    "对方召唤「镜界织术师」时发动其效果，可以融合召唤「镜界终成体」吗？",
  ].join("");

  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards: cards });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.resolution, "performed");
  const final = result.program.finalState.cards;
  const zone = (id) => final.find((card) => card.definitionId === id)?.zone;
  assert.equal(zone("perspective-source"), "graveyard");
  assert.equal(zone("perspective-own-material"), "graveyard");
  assert.equal(zone("perspective-other-material"), "monster_zone");
  assert.equal(zone("perspective-target"), "monster_zone");
});

test("an unknown effect-controller perspective fails closed instead of choosing a player's hand", () => {
  const fixture = fictionalFusionCase("雾");
  const name = (id) => fixture.cards.find((card) => card.id === id).name;
  const question = [
    "额外卡组有「" + name(fixture.ids.target) + "」，手牌有「" + name(fixture.ids.cost) + "」。",
    "场上只有表侧表示的「" + name(fixture.ids.protected) + "」，双方墓地没有卡。",
    "召唤「" + name(fixture.ids.source) + "」时，将「" + name(fixture.ids.cost)
      + "」作为Cost丢弃发动效果，后续怎么处理？",
  ].join("");

  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards: fixture.cards });
  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "activation_cost_controller_unknown");
});

test("the compiled simulation still performs fusion when immunity leaves a second legal material", () => {
  const fixture = fictionalFusionCase("丙", { includeAlternativeMaterial: true });
  const result = analyzeDuelStateTransition({ userQuery: fixture.question, resolvedCards: fixture.cards });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.activation, "legal");
  assert.equal(result.resolution, "performed");
  const finalCards = result.program.finalState.cards;
  const zone = (definitionId) => finalCards.find((card) => card.definitionId === definitionId)?.zone;
  assert.equal(zone(fixture.ids.protected), "monster_zone");
  assert.equal(zone(fixture.ids.source), "graveyard");
  assert.equal(zone(fixture.ids.alternative), "graveyard");
  assert.equal(zone(fixture.ids.target), "monster_zone");
  assert.match(result.shortAnswer, /进行融合召唤|融合召唤成功/u);
  assert.doesNotMatch(result.shortAnswer, /不进行融合召唤/u);
});

test("an explicitly requested fusion target cannot be replaced by another summonable candidate", () => {
  const cards = [{
    id: "goal-source",
    name: "起动术士",
    cardType: "monster",
    effectText: "这张卡召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材进行融合召唤。",
  }, {
    id: "goal-cost",
    name: "代价卡",
    cardType: "monster",
    effectText: "通常怪兽。",
  }, {
    id: "goal-fusion-material",
    name: "融合素材龙",
    cardType: "fusion",
    effectText: "融合怪兽。",
  }, {
    id: "goal-legal-target",
    name: "可行终龙",
    cardType: "fusion",
    effectText: "「起动术士」＋融合怪兽",
  }, {
    id: "goal-requested-target",
    name: "指定终龙",
    cardType: "fusion",
    effectText: "「起动术士」＋同步怪兽",
  }];
  const question = [
    "我方额外卡组有「可行终龙」和「指定终龙」，手牌有「代价卡」。",
    "对方场上有表侧表示的「融合素材龙」。",
    "我方召唤「起动术士」时，将「代价卡」作为Cost丢弃发动效果，可以融合召唤「指定终龙」吗？",
  ].join("");
  const result = analyzeDuelStateTransition({ userQuery: question, resolvedCards: cards });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  const candidateIds = result.debug.compiled.chainLinks[0].sequence[0].primitive.candidateInstanceIds;
  assert.deepEqual(candidateIds, ["goal-requested-target#1"]);
});

test("the compiler fails closed when the fusion target or material recipe is missing", () => {
  const withoutTarget = fictionalFusionCase("丁");
  withoutTarget.cards = withoutTarget.cards.filter((card) => card.id !== withoutTarget.ids.target);
  const withoutRecipe = fictionalFusionCase("戊", { targetHasRecipe: false });

  for (const fixture of [withoutTarget, withoutRecipe]) {
    const result = analyzeDuelStateTransition({ userQuery: fixture.question, resolvedCards: fixture.cards });
    assert.equal(result.status, "not_applicable", JSON.stringify(result));
    assert.equal(result.complete, false);
    assert.equal(result.reason, "fusion_candidate_or_material_recipe_unknown");
    assert.equal(result.trace.length, 0);
  }
});

test("the compiler does not invent an omitted card zone from its effect type", () => {
  const fixture = fictionalFusionCase("区");
  fixture.question = [
    "「" + fixture.cards.find((card) => card.id === fixture.ids.protected).name + "」存在，但题目没有说明其所在区域。",
    "我方额外卡组有「" + fixture.cards.find((card) => card.id === fixture.ids.target).name + "」。",
    "我方手牌有「" + fixture.cards.find((card) => card.id === fixture.ids.cost).name + "」。",
    "我方召唤「" + fixture.cards.find((card) => card.id === fixture.ids.source).name + "」时，将「"
      + fixture.cards.find((card) => card.id === fixture.ids.cost).name + "」作为Cost丢弃发动效果。",
  ].join("");
  const result = analyzeDuelStateTransition({
    userQuery: fixture.question,
    resolvedCards: fixture.cards,
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "compiled_chain_not_complete");
  assert.equal(result.debug.simulation.incompleteReason, "continuous_effect_applicability_unknown");
});

test("a summon trigger is bound to the activating instance rather than any summon in the question", () => {
  const fixture = fictionalFusionCase("时");
  const name = (id) => fixture.cards.find((card) => card.id === id).name;
  fixture.question = [
    "我方额外卡组有「" + name(fixture.ids.target) + "」，手牌有「" + name(fixture.ids.cost) + "」。",
    "对方场上只有表侧表示的「" + name(fixture.ids.protected) + "」。",
    "「" + name(fixture.ids.source) + "」已在我方场上。",
    "之后我方召唤「旁观者」，打算将「" + name(fixture.ids.cost) + "」作为Cost发动「"
      + name(fixture.ids.source) + "」的效果。",
  ].join("");
  const result = analyzeDuelStateTransition({
    userQuery: fixture.question,
    resolvedCards: fixture.cards,
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "compiled_chain_not_complete", JSON.stringify(result));
  assert.equal(result.debug.simulation.incompleteReason, "summon_event_not_established");
});

test("printed material formulas classify summon kinds without mistaking Synchro, Link, or arithmetic text for Fusion", () => {
  const programs = compileResolvedCardPrograms([
    { id: "material-a", name: "素材甲", effectText: "通常怪兽。" },
    {
      id: "three-slot-fusion",
      name: "三材合成体",
      effectText: "“素材甲”＋“素材乙”＋效果怪兽",
    },
    {
      id: "synchro-formula",
      name: "无类型同步体",
      effectText: "1只调整＋调整以外的怪兽1只以上",
    },
    {
      id: "english-link-formula",
      name: "Untyped Link Body",
      effectText: "2+ Effect Monsters",
    },
    {
      id: "ordinary-plus-text",
      name: "算术术士",
      effectText: "此卡的攻击力变成原本攻击力 + 500。",
    },
    {
      id: "explicit-synchro",
      name: "明确同步体",
      cardType: "Synchro",
      effectText: "“素材甲”＋融合怪兽",
    },
  ]);
  const byId = (id) => programs.find((program) => program.definitionId === id);

  assert.deepEqual(byId("three-slot-fusion").summonKinds, ["fusion"]);
  assert.deepEqual(byId("synchro-formula").summonKinds, ["synchro"]);
  assert.equal(byId("synchro-formula").summonKinds.includes("fusion"), false);
  assert.deepEqual(byId("english-link-formula").summonKinds, []);
  assert.equal(byId("english-link-formula").materialRecipeRaw, null);
  assert.deepEqual(byId("ordinary-plus-text").summonKinds, []);
  assert.equal(byId("ordinary-plus-text").materialRecipeRaw, null);
  assert.deepEqual(byId("explicit-synchro").summonKinds, ["synchro"]);
  assert.equal(byId("explicit-synchro").materialRecipe, undefined);
});

function runNo41ColdStart(question) {
  const moduleUrl = pathToFileURL(resolve("backend/ragRulingPipeline.mjs")).href;
  const encodedQuestion = Buffer.from(question, "utf8").toString("base64");
  const script = [
    "const { answerRagRulingQuestion } = await import(" + JSON.stringify(moduleUrl) + ");",
    "const question = Buffer.from(" + JSON.stringify(encodedQuestion) + ", 'base64').toString('utf8');",
    "const answer = await answerRagRulingQuestion({",
    "  question, dryRun: false,",
    "  env: { RAG_PROVIDER: 'mock', RAG_MODEL_PROVIDER: 'mock', MODEL_PROVIDER: 'mock', OCG_ENGINE_ENABLED: '0', OCG_ENGINE_AUTO_SIMULATION: 'false' },",
    "  cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),",
    "  ruleModelInvoker: async () => JSON.stringify({ queries: [] }),",
    "  modelInvoker: async () => JSON.stringify({ answerLevel: 'rule_analysis', shortAnswer: '按题设已经完成展示等发动手续，C1可以发动。C2处理后，C1效果被无效，不进行这个连锁项的效果处理。', reasoning: ['先处理C2，再按更新后的场面处理C1。'], usedCards: [], usedEvidence: [], missingInfo: [], riskFlags: [], confidenceSelfEstimate: 'high' }),",
    "  fetchImpl: async (url) => {",
    "    const search = new URL(String(url)).searchParams.get('search') || '';",
    "    const result = /(?:vs.*狂魔博士|VS Dr\\.マッドラヴ|Vanquish Soul Dr\\. Mad Love)/iu.test(search) ? [{ cid: 18730, id: 29280200, cn_name: '征服斗魂 狂爱博士', sc_name: 'VS狂魔博士', jp_name: 'VS Dr.マッドラヴ', en_name: 'Vanquish Soul Dr. Mad Love', text: { desc: '测试身份夹具；正文仍取本地稳定 CID 记录。' } }] : [];",
    "    return new Response(JSON.stringify({ result, next: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });",
    "  },",
    "});",
    "const transition = answer.debug.semanticStateTransition;",
    "process.stdout.write(JSON.stringify({",
    "  ids: answer.resolvedCards.map((item) => item.id),",
    "  unresolved: answer.debug.unresolvedMentions,",
    "  decision: answer.debug.deterministicDecision,",
    "  modelUsed: answer.debug.modelUsed,",
    "  shortAnswer: answer.shortAnswer,",
    "  transition,",
    "}));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim().split(/\r?\n/u).at(-1));
}

test("the original No.41 wording resolves cards in a cold process and delegates the verdict", () => {
  const result = runNo41ColdStart(originalUserQuestions[0]);

  for (const id of ["13163", "18730", "18732"]) assert.equal(result.ids.includes(id), true, id);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.decision, null);
  assert.notEqual(result.modelUsed, "deterministic-ruling-reasoner");
  assert.equal(result.transition?.authoritative, false);
  assert.equal(result.transition?.authorityReason, "diagnostic_only_requires_final_model");
  assert.match(result.shortAnswer, /C1可以发动/u);
  assert.match(result.shortAnswer, /C2/u);
  assert.match(result.shortAnswer, /被无效/u);
  assert.match(result.shortAnswer, /不进行这个连锁项的效果处理/u);
  assert.doesNotMatch(result.shortAnswer, /不会把怪兽返回手牌/u);
});

test("generic post-cost simulation keeps its arithmetic trace but is conditional with synthetic materials", () => {
  const modifierId = "fictional-level-modifier";
  const sourceId = "fictional-post-cost-source";
  const result = analyzeDuelStateTransition({
    userQuery: "对方场上有一个「架空等级载体」，导致我方场上的3+3变成了5+5。假如我方额外只有6星同调而没有10星同调，可以发动「架空双召术」吗？",
    resolvedCards: [{
      id: modifierId,
      name: "架空等级载体",
      cardType: "synchro monster",
      effectText: "协调＋同步怪兽1只以上\n①：对手场上的怪兽的等级上升2。",
    }, {
      id: sourceId,
      name: "架空双召术",
      cardType: "spell",
      effectText: "①：将自己场上表侧表示的协调和协调以外的怪兽各1只送至墓地可以发动。从额外牌组将以下怪兽各1只特殊召唤。\n●能够以墓地的该2只怪兽作为素材同步召唤的同步怪兽\n●能够以墓地的该2只怪兽作为素材融合召唤的融合怪兽",
    }],
  });

  assert.equal(result.status, "unknown", JSON.stringify(result.debug));
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.conditional, true);
  assert.ok(result.authorityReasons.includes("synthetic_entity_or_material"));
  assert.equal(result.activation, "legal");
  assert.equal(result.sourceDefinitionId, sourceId);
  assert.match(result.shortAnswer, /3\+3（合计6）/u);
  assert.match(result.shortAnswer, /没有10星同步怪兽不影响/u);
  const prepared = result.program.preparedChainLinks[0];
  assert.equal(prepared.sourceDefinitionId, sourceId);
  assert.equal(prepared.activationCostReceipt.cardInstanceIds.length, 2);
  const beforeActivation = result.program.stateSnapshots
    .find((snapshot) => snapshot.stage === "before_chain_activation");
  assert.deepEqual(
    beforeActivation.gameState.cards
      .filter((card) => card.roles?.length)
      .map((card) => card.currentValues.level),
    [5, 5],
  );
  assert.deepEqual(
    result.program.finalState.cards
      .filter((card) => card.roles?.length)
      .map((card) => [card.zone, card.currentValues.level]),
    [["graveyard", 3], ["graveyard", 3]],
  );
});
