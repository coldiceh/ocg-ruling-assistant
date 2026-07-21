import assert from "node:assert/strict";
import test from "node:test";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";
import {
  evaluateFusionOperation,
  resolveEffectChain,
  resolvePrimitiveSequence,
  stabilizeContinuousEffects,
} from "../backend/effectResolutionEngine.mjs";

function defenseNegation(sourceInstanceId = "carrier#1") {
  return {
    id: "force-defense-and-negate",
    sourceInstanceId,
    sourceCardId: sourceInstanceId,
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
      sourceSelector: {
        zoneAtActivation: "monster_zone",
        faceUpAtActivation: true,
        positionAtActivation: "defense",
      },
    }],
  };
}

test("chain links are activated sequentially and later snapshots see activation-stage state changes", () => {
  const result = resolveEffectChain({
    gameState: {
      cards: [
        { instanceId: "carrier#1", definitionId: "carrier", name: "约束兽", controller: "opponent", zone: "monster_zone", faceUp: true, position: "attack" },
        { instanceId: "switch#1", definitionId: "switch", name: "转向魔法", controller: "self", zone: "spell_trap_zone", faceUp: true, position: "none" },
        { instanceId: "source#1", definitionId: "source", name: "后续术士", controller: "self", zone: "monster_zone", faceUp: true, position: "attack" },
      ],
    },
    chainLinks: [
      {
        id: "C1",
        order: 1,
        sourceInstanceId: "switch#1",
        sourceDefinitionId: "switch",
        sourceExpectedZone: "spell_trap_zone",
        sourceCardName: "转向魔法",
        effectCategory: "spell",
        targets: [{ instanceId: "carrier#1", expectedZone: "monster_zone" }],
        activationSequence: [createEffectPrimitive("set_position", {
          targetInstanceId: "carrier#1",
          targetExpectedZone: "monster_zone",
          position: "defense",
        })],
        sequence: [],
      },
      {
        id: "C2",
        order: 2,
        sourceInstanceId: "source#1",
        sourceDefinitionId: "source",
        sourceExpectedZone: "monster_zone",
        sourceCardName: "后续术士",
        effectCategory: "monster",
        sequence: [],
      },
    ],
    continuousEffects: [defenseNegation()],
  });

  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.preparedChainLinks.find((link) => link.id === "C2").activationSnapshot.sourcePosition, "defense");
  assert.equal(result.linkResults.find((link) => link.id === "C2").status, "negated");
  assert.equal(result.activationResults.find((link) => link.id === "C1").stageResults[0].stage, "apply_activation_action");
});

test("continuous-effect cycles stop deterministic simulation", () => {
  const common = {
    activeWhen: { zone: "monster_zone", faceUp: true },
    effectCategory: "monster",
  };
  const result = resolveEffectChain({
    gameState: {
      cards: [
        { instanceId: "a#1", definitionId: "a", name: "甲", zone: "monster_zone", faceUp: true, position: "attack" },
        { instanceId: "b#1", definitionId: "b", name: "乙", zone: "monster_zone", faceUp: true, position: "attack" },
      ],
    },
    chainLinks: [{
      id: "C1",
      order: 1,
      sourceInstanceId: "a#1",
      sourceExpectedZone: "monster_zone",
      sourceCardName: "甲",
      effectCategory: "monster",
      sequence: [],
    }],
    continuousEffects: [
      {
        ...common,
        id: "force-attack",
        sourceInstanceId: "a#1",
        constraints: [{ type: "set_position", selector: { instanceId: "b#1" }, position: "attack" }],
      },
      {
        ...common,
        id: "force-defense",
        sourceInstanceId: "a#1",
        constraints: [{ type: "set_position", selector: { instanceId: "b#1" }, position: "defense" }],
      },
    ],
  });

  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "continuous_effect_cycle");
  assert.equal(result.linkResults.length, 0);
});

test("an unspecified summon position stays an explicit choice instead of defaulting to attack", () => {
  const result = resolvePrimitiveSequence(
    [createEffectPrimitive("special_summon_source", {
      sourceInstanceId: "source#1",
      sourceExpectedZone: "hand",
    })],
    {
      cards: [{ instanceId: "source#1", definitionId: "source", name: "选择兽", zone: "hand", faceUp: false, position: "none" }],
      resolutionContext: { source: { instanceId: "source#1", expectedZone: "hand", availableAtResolution: true } },
    },
  );
  const source = result.gameState.cards[0];

  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(source.position, "unknown");
  assert.deepEqual(source.positionChoices, ["attack", "defense"]);
});

test("a position choice controlling a continuous effect is indeterminate until the choice is supplied", () => {
  const result = stabilizeContinuousEffects({
    cards: [{
      instanceId: "carrier#1",
      definitionId: "carrier",
      name: "选择结界兽",
      zone: "monster_zone",
      faceUp: true,
      position: "unknown",
      positionChoices: ["attack", "defense"],
    }],
  }, [defenseNegation()]);

  assert.equal(result.fixedPointReached, false);
  assert.equal(result.reason, "continuous_effect_source_position_choice_unresolved");
});

test("an unknown field in a continuous-effect existence condition fails closed", () => {
  const result = stabilizeContinuousEffects({
    cards: [{
      instanceId: "carrier#1",
      definitionId: "carrier",
      name: "条件结界兽",
      zone: "monster_zone",
      faceUp: true,
      position: "attack",
    }, {
      instanceId: "possible-key#1",
      definitionId: "key",
      name: "区域未定钥匙",
      zone: "unknown",
      controller: "self",
    }],
  }, [{
    id: "conditional-immunity",
    sourceInstanceId: "carrier#1",
    activeWhen: { zone: "monster_zone", faceUp: true },
    stateConditions: [{
      type: "exists",
      selector: { definitionIds: ["key"], zones: ["monster_zone", "graveyard"] },
      minCount: 1,
    }],
    grantedModifiers: [{
      type: "unaffected_by_other_effects",
      recipient: "source",
    }],
  }]);

  assert.equal(result.fixedPointReached, false);
  assert.equal(result.reason, "continuous_effect_applicability_unknown");
});

test("an unknown continuous-effect recipient is not silently treated as ineligible", () => {
  const result = stabilizeContinuousEffects({
    cards: [{
      instanceId: "carrier#1",
      definitionId: "carrier",
      name: "全场结界兽",
      zone: "monster_zone",
      faceUp: true,
      position: "attack",
    }, {
      instanceId: "unknown-zone#1",
      definitionId: "unknown-zone",
      name: "区域未定卡",
      zone: "unknown",
      faceUp: true,
    }],
  }, [{
    id: "force-defense",
    sourceInstanceId: "carrier#1",
    activeWhen: { zone: "monster_zone", faceUp: true },
    constraints: [{
      type: "set_position",
      selector: { zone: "monster_zone", faceUp: true, cardKind: "monster" },
      position: "defense",
    }],
  }]);

  assert.equal(result.fixedPointReached, false);
  assert.equal(result.reason, "continuous_effect_recipient_selector_unknown");
});

test("unsupported continuous-effect conditions stay indeterminate", () => {
  const result = stabilizeContinuousEffects({
    cards: [{
      instanceId: "carrier#1",
      definitionId: "carrier",
      name: "未知条件兽",
      zone: "monster_zone",
      faceUp: true,
      position: "attack",
    }],
  }, [{
    id: "unsupported-condition",
    sourceInstanceId: "carrier#1",
    activeWhen: { zone: "monster_zone", faceUp: true },
    stateConditions: [{ type: "not_yet_compiled" }],
  }]);

  assert.equal(result.fixedPointReached, false);
  assert.equal(result.reason, "continuous_effect_applicability_unknown");
});

test("discard updates the canonical card zone and both compatibility views", () => {
  const cost = {
    instanceId: "cost#1",
    definitionId: "cost",
    name: "代价卡",
    owner: "self",
    controller: "self",
    zone: "hand",
    faceUp: false,
    position: "none",
  };
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { player: "self", amount: 1, cardIds: ["cost#1"] }),
  ], {
    cards: [cost],
    hands: { self: [cost] },
    graveyards: { self: [] },
  });

  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(result.gameState.cards.filter((card) => card.instanceId === "cost#1").length, 1);
  assert.equal(result.gameState.cards.find((card) => card.instanceId === "cost#1").zone, "graveyard");
  assert.deepEqual(result.gameState.hands.self.map((card) => card.instanceId), []);
  assert.deepEqual(result.gameState.graveyards.self.map((card) => card.instanceId), ["cost#1"]);
});

test("legacy container-only cards are imported into the canonical registry before moving", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { player: "self", amount: 1, cardIds: ["legacy#1"] }),
  ], {
    hands: { self: [{ instanceId: "legacy#1", definitionId: "legacy", name: "旧格式手牌" }] },
    graveyards: { self: [] },
  });

  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(result.gameState.cards.find((card) => card.instanceId === "legacy#1").zone, "graveyard");
  assert.equal(result.gameState.hands.self.length, 0);
  assert.deepEqual(result.gameState.graveyards.self.map((card) => card.instanceId), ["legacy#1"]);
});

test("draw preserves deck order while updating canonical zones and hand view", () => {
  const held = { instanceId: "held#1", definitionId: "held", owner: "self", controller: "self", zone: "hand" };
  const top = { instanceId: "deck#top", definitionId: "drawn", owner: "self", controller: "self", zone: "deck" };
  const bottom = { instanceId: "deck#bottom", definitionId: "remaining", owner: "self", controller: "self", zone: "deck" };
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("draw_cards", { player: "self", amount: 1 }),
  ], {
    cards: [held, top, bottom],
    hands: { self: [held] },
    decks: { self: [top, bottom] },
  });

  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(result.gameState.cards.find((card) => card.instanceId === "deck#top").zone, "hand");
  assert.equal(result.gameState.cards.find((card) => card.instanceId === "deck#bottom").zone, "deck");
  assert.deepEqual(result.gameState.decks.self.map((card) => card.instanceId), ["deck#bottom"]);
  assert.deepEqual(result.gameState.hands.self.map((card) => card.instanceId), ["held#1", "deck#top"]);
});

test("a private-zone move follows card ownership and does not leave a stale hand view", () => {
  const target = {
    instanceId: "owned#1",
    definitionId: "owned",
    owner: "self",
    controller: "opponent",
    zone: "monster_zone",
    onField: true,
    faceUp: true,
    position: "attack",
  };
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("return_target_to_hand", {
      targetInstanceId: "owned#1",
      targetExpectedZone: "monster_zone",
    }),
  ], {
    cards: [target],
    hands: { self: [], opponent: [] },
    resolutionContext: { targets: [{ instanceId: "owned#1", expectedZone: "monster_zone" }] },
  });

  const moved = result.gameState.cards.find((card) => card.instanceId === "owned#1");
  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(moved.zone, "hand");
  assert.equal(moved.controller, "self");
  assert.equal(moved.onField, false);
  assert.deepEqual(result.gameState.hands.self.map((card) => card.instanceId), ["owned#1"]);
  assert.equal(result.gameState.hands.opponent.length, 0);
});

test("same-definition copies move by instance id without changing their sibling", () => {
  const first = { instanceId: "copy#1", definitionId: "copy", owner: "self", controller: "self", zone: "hand" };
  const second = { instanceId: "copy#2", definitionId: "copy", owner: "self", controller: "self", zone: "hand" };
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { player: "self", amount: 1, cardIds: ["copy#2"] }),
  ], {
    cards: [first, second],
    hands: { self: [first, second] },
    graveyards: { self: [] },
  });

  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(result.gameState.cards.find((card) => card.instanceId === "copy#1").zone, "hand");
  assert.equal(result.gameState.cards.find((card) => card.instanceId === "copy#2").zone, "graveyard");
  assert.deepEqual(result.gameState.hands.self.map((card) => card.instanceId), ["copy#1"]);
  assert.deepEqual(result.gameState.graveyards.self.map((card) => card.instanceId), ["copy#2"]);
});

test("a later chain activation observes a card discarded as an earlier activation cost", () => {
  const source = { instanceId: "source#1", definitionId: "source", controller: "self", zone: "monster_zone", faceUp: true };
  const cost = { instanceId: "cost#1", definitionId: "cost", owner: "self", controller: "self", zone: "hand" };
  const result = resolveEffectChain({
    gameState: {
      cards: [source, cost],
      hands: { self: [cost] },
      graveyards: { self: [] },
    },
    chainLinks: [
      {
        id: "C1",
        order: 1,
        sourceInstanceId: "source#1",
        sourceExpectedZone: "monster_zone",
        activationCostSequence: [createEffectPrimitive("discard_from_hand", {
          player: "self",
          amount: 1,
          cardIds: ["cost#1"],
        })],
        sequence: [],
      },
      {
        id: "C2",
        order: 2,
        sourceInstanceId: "cost#1",
        sourceExpectedZone: "graveyard",
        sequence: [],
      },
    ],
  });

  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.preparedChainLinks.find((link) => link.id === "C2").activationSnapshot.sourceZone, "graveyard");
  assert.equal(result.finalGameState.cards.find((card) => card.instanceId === "cost#1").zone, "graveyard");
  assert.equal(result.finalGameState.hands.self.length, 0);
  assert.deepEqual(result.finalGameState.graveyards.self.map((card) => card.instanceId), ["cost#1"]);
});

function conditionalFusionFixture({ includeAlternativeMaterial = false } = {}) {
  const cards = [
    {
      instanceId: "weaver#1",
      definitionId: "weaver",
      name: "织合术士",
      owner: "self",
      controller: "self",
      zone: "monster_zone",
      faceUp: true,
      position: "attack",
    },
    {
      instanceId: "saint#1",
      definitionId: "saint",
      name: "墓启圣女",
      owner: "self",
      controller: "self",
      zone: "hand",
      faceUp: false,
      position: "none",
    },
    {
      instanceId: "ward#1",
      definitionId: "ward",
      name: "护界融合龙",
      owner: "opponent",
      controller: "opponent",
      zone: "monster_zone",
      faceUp: true,
      position: "attack",
      summonKinds: ["fusion"],
    },
    {
      instanceId: "result#1",
      definitionId: "result",
      name: "终式融合龙",
      owner: "self",
      controller: "self",
      zone: "extra_deck",
      faceUp: false,
      position: "none",
      materialRecipe: {
        slots: [
          { id: "named-source", predicate: { definitionIds: ["weaver"] } },
          { id: "extra-kind", predicate: { summonKinds: ["fusion", "synchro", "xyz", "link"] } },
        ],
      },
    },
  ];
  if (includeAlternativeMaterial) {
    cards.push({
      instanceId: "alternative#1",
      definitionId: "alternative",
      name: "替代同步龙",
      owner: "opponent",
      controller: "opponent",
      zone: "monster_zone",
      faceUp: true,
      position: "attack",
      summonKinds: ["synchro"],
    });
  }

  const fusionPrimitive = createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "weaver#1",
    sourceDefinitionId: "weaver",
    sourceMustBeMaterial: true,
    excludeOtherOwnMonsters: true,
    effectCategory: "monster",
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["result#1"],
  });
  return {
    gameState: {
      cards,
      hands: { self: [cards.find((card) => card.instanceId === "saint#1")] },
      graveyards: { self: [] },
    },
    fusionPrimitive,
    chainLinks: [{
      id: "C1",
      order: 1,
      sourceInstanceId: "weaver#1",
      sourceDefinitionId: "weaver",
      sourceExpectedZone: "monster_zone",
      effectCategory: "monster",
      activationPreconditions: [{ type: "operation_performable", primitive: fusionPrimitive }],
      activationCostSequence: [createEffectPrimitive("discard_from_hand", {
        player: "self",
        amount: 1,
        cardIds: ["saint#1"],
      })],
      sequence: [fusionPrimitive],
    }],
    continuousEffects: [{
      id: "grave-enabled-immunity",
      sourceInstanceId: "ward#1",
      sourceDefinitionId: "ward",
      effectCategory: "monster",
      activeWhen: { zone: "monster_zone", faceUp: true },
      stateConditions: [{
        type: "exists",
        selector: {
          definitionIds: ["saint"],
          zones: ["monster_zone", "graveyard"],
          controllers: ["self", "opponent"],
        },
        minCount: 1,
      }],
      grantedModifiers: [{
        type: "unaffected_by_other_effects",
        recipient: "source",
        exceptEffectSource: "self",
      }],
    }],
  };
}

test("a discard cost changes the zone before continuous immunity and fusion resolution are re-evaluated", () => {
  const fixture = conditionalFusionFixture();
  assert.equal(evaluateFusionOperation(fixture.gameState, fixture.fusionPrimitive).status, "performable");

  const result = resolveEffectChain(fixture);
  const costStage = result.activationResults[0].stageResults.find((stage) => stage.stage === "pay_activation_cost");
  const outcome = result.linkResults[0].primitiveResult.outcomes.find((item) => item.type === "fusion_summon");

  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.activationResults[0].status, "activated");
  assert.equal(costStage.result.gameState.cards.find((card) => card.instanceId === "saint#1").zone, "graveyard");
  assert.equal(
    costStage.result.gameState.cards.find((card) => card.instanceId === "ward#1").derivedModifiers[0]?.type,
    "unaffected_by_other_effects",
  );
  assert.equal(outcome.status, "not_performed");
  assert.deepEqual(outcome.excludedMaterials.map((card) => card.instanceId), ["ward#1"]);
  assert.equal(result.finalGameState.cards.find((card) => card.instanceId === "result#1").zone, "extra_deck");
});

test("post-cost immunity excludes only that material when a second legal material can complete the recipe", () => {
  const fixture = conditionalFusionFixture({ includeAlternativeMaterial: true });
  const result = resolveEffectChain(fixture);
  const outcome = result.linkResults[0].primitiveResult.outcomes.find((item) => item.type === "fusion_summon");

  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(outcome.status, "performed");
  assert.deepEqual(outcome.assignment.map((item) => item.instanceId), ["weaver#1", "alternative#1"]);
  assert.equal(result.finalGameState.cards.find((card) => card.instanceId === "ward#1").zone, "monster_zone");
  assert.equal(result.finalGameState.cards.find((card) => card.instanceId === "weaver#1").zone, "graveyard");
  assert.equal(result.finalGameState.cards.find((card) => card.instanceId === "alternative#1").zone, "graveyard");
  assert.equal(result.finalGameState.cards.find((card) => card.instanceId === "result#1").zone, "monster_zone");
});

test("fusion evaluation fails closed when the target or its material recipe is unknown", () => {
  const fixture = conditionalFusionFixture();
  const missingTarget = evaluateFusionOperation(fixture.gameState, {
    ...fixture.fusionPrimitive,
    candidateInstanceIds: [],
  });
  const targetWithoutRecipeState = {
    ...fixture.gameState,
    cards: fixture.gameState.cards.map((card) => (
      card.instanceId === "result#1" ? { ...card, materialRecipe: undefined } : card
    )),
  };
  const missingRecipe = evaluateFusionOperation(targetWithoutRecipeState, fixture.fusionPrimitive);

  assert.deepEqual(missingTarget, { status: "unknown", reason: "fusion_candidate_unknown" });
  assert.equal(missingRecipe.status, "unknown");
  assert.equal(missingRecipe.reason, "fusion_material_recipe_unknown");
});

test("fusion evaluation stays unknown when a required material has no summon-kind metadata", () => {
  const gameState = {
    cards: [{
      instanceId: "known-source#1",
      definitionId: "known-source",
      controller: "self",
      zone: "monster_zone",
      faceUp: true,
    }, {
      instanceId: "unknown-kind#1",
      definitionId: "unknown-kind",
      controller: "opponent",
      zone: "monster_zone",
      faceUp: true,
    }, {
      instanceId: "kind-target#1",
      definitionId: "kind-target",
      controller: "self",
      zone: "extra_deck",
      materialRecipe: {
        slots: [
          { id: "named-source", predicate: { definitionIds: ["known-source"] } },
          { id: "fusion-kind", predicate: { summonKinds: ["fusion"] } },
        ],
      },
    }],
  };
  const result = evaluateFusionOperation(gameState, createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "known-source#1",
    sourceDefinitionId: "known-source",
    sourceMustBeMaterial: true,
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["kind-target#1"],
  }));

  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "fusion_material_kind_unknown");
});

test("fusion evaluation stays unknown when a possible material has an unknown zone", () => {
  const gameState = {
    cards: [{
      instanceId: "pool-source#1",
      definitionId: "pool-source",
      controller: "self",
      zone: "monster_zone",
      faceUp: true,
    }, {
      instanceId: "possible-material#1",
      definitionId: "possible-material",
      controller: "opponent",
      zone: "unknown",
      summonKinds: ["fusion"],
    }, {
      instanceId: "pool-target#1",
      definitionId: "pool-target",
      controller: "self",
      zone: "extra_deck",
      materialRecipe: {
        slots: [
          { id: "named-source", predicate: { definitionIds: ["pool-source"] } },
          { id: "fusion-kind", predicate: { summonKinds: ["fusion"] } },
        ],
      },
    }],
  };
  const result = evaluateFusionOperation(gameState, createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "pool-source#1",
    sourceDefinitionId: "pool-source",
    sourceMustBeMaterial: true,
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["pool-target#1"],
  }));

  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "fusion_material_pool_membership_unknown");
  assert.deepEqual(result.unknownMaterialPool, ["possible-material#1"]);
});

test("fusion assignment backtracks until the mandatory source is included", () => {
  const gameState = {
    cards: [{
      instanceId: "helper-a#1",
      definitionId: "helper-a",
      controller: "opponent",
      zone: "monster_zone",
      summonKinds: ["fusion"],
    }, {
      instanceId: "helper-b#1",
      definitionId: "helper-b",
      controller: "opponent",
      zone: "monster_zone",
      summonKinds: ["fusion"],
    }, {
      instanceId: "mandatory-source#1",
      definitionId: "mandatory-source",
      controller: "self",
      zone: "monster_zone",
      summonKinds: ["fusion"],
    }, {
      instanceId: "backtrack-target#1",
      definitionId: "backtrack-target",
      controller: "self",
      zone: "extra_deck",
      materialRecipe: {
        slots: [
          { id: "first", predicate: { summonKinds: ["fusion"] } },
          { id: "second", predicate: { summonKinds: ["fusion"] } },
        ],
      },
    }],
  };
  const result = evaluateFusionOperation(gameState, createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "mandatory-source#1",
    sourceDefinitionId: "mandatory-source",
    sourceMustBeMaterial: true,
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["backtrack-target#1"],
  }));

  assert.equal(result.status, "performable");
  assert.ok(result.assignment.some((item) => item.instanceId === "mandatory-source#1"));
});

test("unknown material identity stays indeterminate instead of becoming a mismatch", () => {
  const gameState = {
    cards: [{
      instanceId: "identity-source#1",
      definitionId: "identity-source",
      controller: "self",
      zone: "monster_zone",
    }, {
      instanceId: "identity-unknown#1",
      controller: "opponent",
      zone: "monster_zone",
    }, {
      instanceId: "identity-target#1",
      definitionId: "identity-target",
      controller: "self",
      zone: "extra_deck",
      materialRecipe: {
        slots: [
          { id: "source", predicate: { definitionIds: ["identity-source"] } },
          { id: "named", predicate: { definitionIds: ["required-material"] } },
        ],
      },
    }],
  };
  const result = evaluateFusionOperation(gameState, createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "identity-source#1",
    sourceDefinitionId: "identity-source",
    sourceMustBeMaterial: true,
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["identity-target#1"],
  }));

  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "fusion_material_kind_unknown");
});

test("a non-affecting fusion operation does not exclude an unaffected material", () => {
  const gameState = {
    cards: [{
      instanceId: "non-affecting-source#1",
      definitionId: "non-affecting-source",
      controller: "self",
      zone: "monster_zone",
    }, {
      instanceId: "unaffected-material#1",
      definitionId: "unaffected-material",
      controller: "opponent",
      zone: "monster_zone",
      summonKinds: ["fusion"],
      derivedModifiers: [{
        type: "unaffected_by_other_effects",
        exceptEffectSource: "self",
        sourceCardId: "unaffected-material#1",
      }],
    }, {
      instanceId: "non-affecting-target#1",
      definitionId: "non-affecting-target",
      controller: "self",
      zone: "extra_deck",
      materialRecipe: {
        slots: [
          { id: "source", predicate: { definitionIds: ["non-affecting-source"] } },
          { id: "fusion", predicate: { summonKinds: ["fusion"] } },
        ],
      },
    }],
  };
  const result = evaluateFusionOperation(gameState, createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "non-affecting-source#1",
    sourceDefinitionId: "non-affecting-source",
    sourceMustBeMaterial: true,
    interaction: "non_affecting",
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["non-affecting-target#1"],
  }));

  assert.equal(result.status, "performable");
  assert.deepEqual(result.excludedMaterials, []);
  assert.ok(result.assignment.some((item) => item.instanceId === "unaffected-material#1"));
});
