import assert from "node:assert/strict";
import test from "node:test";

import {
  TRIGGER_PRIORITY_TIERS,
  analyzeSimultaneousTriggerScenario,
  buildSimultaneousTriggerChain,
  movementEventIsFaceUpBanishByCardEffect,
} from "../backend/simultaneousTriggerChain.mjs";
import { compileRuleScenario } from "../backend/ruleScenarioCompiler.mjs";

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

test("ordinary public mandatory and optional triggers are ordered by turn-player priority", () => {
  const plan = buildSimultaneousTriggerChain({
    turnPlayer: "self",
    events: [{ id: "shared-event", type: "destroyed", triggerWindowId: "window-1" }],
    candidates: [
      { id: "self-mandatory", controller: "self", sourceZone: "monster_zone", faceUp: true, mandatory: true, triggerEventTypes: ["destroyed"] },
      { id: "opponent-mandatory", controller: "opponent", sourceZone: "monster_zone", faceUp: true, mandatory: true, triggerEventTypes: ["destroyed"] },
      { id: "self-optional", controller: "self", sourceZone: "monster_zone", faceUp: true, optional: true, triggerEventTypes: ["destroyed"] },
      { id: "opponent-optional", controller: "opponent", sourceZone: "spell_trap_zone", faceUp: true, optional: true, triggerEventTypes: ["destroyed"] },
    ],
    publicTriggerSelections: ["self-optional", "opponent-optional"],
  });

  assert.equal(plan.status, "resolved", JSON.stringify(plan));
  assert.deepEqual(plan.chainLinks.map((item) => item.candidateId), [
    "self-mandatory",
    "opponent-mandatory",
    "self-optional",
    "opponent-optional",
  ]);
});

test("multiple public triggers in the same priority tier require a player order witness", () => {
  const input = {
    turnPlayer: "self",
    events: [{ id: "shared-event", type: "destroyed", triggerWindowId: "window-1" }],
    candidates: [
      { id: "mandatory-a", controller: "self", sourceZone: "monster_zone", faceUp: true, mandatory: true, triggerEventTypes: ["destroyed"] },
      { id: "mandatory-b", controller: "self", sourceZone: "graveyard", mandatory: true, triggerEventTypes: ["destroyed"] },
    ],
  };
  const unknown = buildSimultaneousTriggerChain(input);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.verdict, "UNKNOWN");
  assert.equal(unknown.reason, "same_tier_public_trigger_order_witness_required");
  assert.deepEqual(unknown.ambiguousPublicOrderTierGroups[0].candidateIds, [
    "mandatory-a",
    "mandatory-b",
  ]);

  const ordered = buildSimultaneousTriggerChain({
    ...input,
    publicTriggerOrder: ["mandatory-b", "mandatory-a"],
  });
  assert.equal(ordered.status, "resolved", JSON.stringify(ordered));
  assert.deepEqual(ordered.chainLinks.map((item) => item.candidateId), [
    "mandatory-b",
    "mandatory-a",
  ]);
});

test("events from different trigger windows are never merged into one chain", () => {
  const plan = buildSimultaneousTriggerChain({
    turnPlayer: "self",
    events: [
      { id: "destroyed-first", type: "destroyed", triggerWindowId: "window-1" },
      { id: "summoned-later", type: "special_summoned", triggerWindowId: "window-2" },
    ],
    candidates: [
      { id: "destroy-trigger", controller: "self", sourceZone: "graveyard", mandatory: true, triggerEventTypes: ["destroyed"] },
      { id: "summon-trigger", controller: "self", sourceZone: "monster_zone", faceUp: true, mandatory: true, triggerEventTypes: ["special_summoned"] },
    ],
  });

  assert.equal(plan.status, "unknown");
  assert.equal(plan.verdict, "UNKNOWN");
  assert.equal(plan.reason, "different_trigger_windows_require_separate_chains");
  assert.deepEqual(plan.chainLinks, []);
  assert.deepEqual(plan.triggerWindowResolution.matchedTriggerWindowIds, ["window-1", "window-2"]);
});

test("generic card-text discovery handles public mandatory plus optional triggers conservatively", () => {
  const cardTexts = [
    {
      id: "mandatory-card",
      title: "测试必发卡",
      cards: ["测试必发卡"],
      cardType: "monster",
      controller: "opponent",
      text: "①：这张卡被破坏的场合发动。从牌组抽1张。",
    },
    {
      id: "optional-card",
      title: "测试选发卡",
      cards: ["测试选发卡"],
      cardType: "monster",
      controller: "self",
      text: "①：这张卡被破坏的场合可以发动。从牌组抽1张。",
    },
  ];
  const movementEvents = [
    { id: "destroy-a", type: "destroyed", subjectDefinitionId: "mandatory-card", actualToZone: "graveyard", triggerWindowId: "same-window" },
    { id: "destroy-b", type: "destroyed", subjectDefinitionId: "optional-card", actualToZone: "graveyard", triggerWindowId: "same-window" },
  ];
  const result = analyzeSimultaneousTriggerScenario({
    userQuery: "「测试必发卡」和「测试选发卡」在同一时点被破坏，另开连锁时如何排列？",
    cardTexts,
    movementEvents,
    turnPlayer: "self",
    branchWitness: {
      publicTriggerSelections: ["public-trigger:optional-card:effect-①"],
    },
  });

  assert.equal(result.recognized, true, JSON.stringify(result));
  assert.equal(result.mode, "generic_public_triggers");
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.deepEqual(result.plan.chainLinks.map((item) => item.candidateId), [
    "public-trigger:mandatory-card:effect-①",
    "public-trigger:optional-card:effect-①",
  ]);
  const compiled = compileRuleScenario({
    userQuery: "「测试必发卡」和「测试选发卡」在同一时点被破坏，另开连锁时如何排列？",
    cardTexts,
    movementEvents,
    branchWitness: {
      publicTriggerSelections: ["public-trigger:optional-card:effect-①"],
    },
  });
  assert.equal(compiled.simultaneousTriggerChain.mode, "generic_public_triggers");
  assert.equal(compiled.simultaneousPublicPrivateTriggers, false);

  const missingController = analyzeSimultaneousTriggerScenario({
    userQuery: "「测试必发卡」和「测试选发卡」在同一时点被破坏，另开连锁时如何排列？",
    cardTexts: cardTexts.map(({ controller, ...card }) => card),
    movementEvents: movementEvents.map(({ controller, ...event }) => event),
    turnPlayer: "self",
    branchWitness: {
      publicTriggerSelections: ["public-trigger:optional-card:effect-①"],
    },
  });
  assert.equal(missingController.status, "unknown");
  assert.equal(missingController.complete, false);
  assert.ok(missingController.unresolved.some((item) => item.missing?.includes("controller")));
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
