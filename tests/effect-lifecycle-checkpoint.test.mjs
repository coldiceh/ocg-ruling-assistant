import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import {
  advanceEffectInstanceLifecycles,
  createBoundLingeringEffectInstance,
} from "../backend/effectInstanceLifecycle.mjs";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";
import { resolveEffectChain } from "../backend/effectResolutionEngine.mjs";

test("a summon-bound restriction expires on control change and does not reactivate after control returns", () => {
  const normalized = normalizeCardText({
    id: "generic-summoner",
    name: "测试召唤者",
    cardType: "monster",
    effectText: "①：此卡因效果被送至墓地的情况下可以发动。从牌组将1只“测试”怪兽特殊召唤。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组仅可特殊召唤“测试”怪兽。",
  });
  const operations = normalized.effects[0].resolution.map((step) => step.operation);
  const lingering = operations.find((operation) => operation.type === "create_lingering_restriction");
  assert.equal(lingering.expiration.mode, "irreversible_on_first_condition_failure");
  assert.equal(lingering.expiration.reactivates, false);
  assert.equal(lingering.restriction.allowedArchetype, "测试");

  const state = {
    cards: [{
      instanceId: "summoned#1",
      name: "以该效果特殊召唤的怪兽",
      controller: "self",
      owner: "self",
      zone: "monster_zone",
      faceUp: true,
    }],
    effectInstances: [createBoundLingeringEffectInstance({
      id: "effect#1",
      boundInstanceIds: ["summoned#1"],
      controller: "self",
      restriction: lingering.restriction,
    })],
  };
  state.cards[0].controller = "opponent";
  const changed = advanceEffectInstanceLifecycles(state, {
    timing: "after_control_change",
    cause: "control_changed",
  });
  assert.equal(changed.complete, true);
  assert.equal(changed.gameState.effectInstances[0].status, "expired");

  changed.gameState.cards[0].controller = "self";
  const returned = advanceEffectInstanceLifecycles(changed.gameState, {
    timing: "after_control_return",
    cause: "control_returned",
  });
  assert.equal(returned.complete, true);
  assert.equal(returned.gameState.effectInstances[0].status, "expired");
  assert.ok(returned.trace.some((entry) => entry.result === "remains_expired"));
});

function fieldLimitEffect() {
  return {
    id: "generic-race-limit@limit#1",
    sourceCardId: "limit#1",
    sourceInstanceId: "limit#1",
    activeWhen: { zone: "spell_trap_zone", faceUp: true },
    fieldRestrictions: [{
      type: "max_face_up_monsters_per_race_per_player",
      maxCount: 1,
    }],
  };
}

function orderedSummonThenDestroy(targetId) {
  return resolveEffectChain({
    gameState: {
      cards: [
        { instanceId: "source#1", name: "发动源", controller: "self", owner: "self", zone: "monster_zone", faceUp: true, race: "机械族" },
        { instanceId: "limit#1", name: "种族限制", controller: "opponent", owner: "opponent", zone: "spell_trap_zone", faceUp: true },
        { instanceId: "other#1", name: "其他卡", controller: "opponent", owner: "opponent", zone: "spell_trap_zone", faceUp: true },
        { instanceId: "summoned-a#1", name: "召唤怪兽A", controller: "self", owner: "self", zone: "deck", faceUp: false, race: "战士族" },
        { instanceId: "summoned-b#1", name: "召唤怪兽B", controller: "self", owner: "self", zone: "graveyard", faceUp: false, race: "战士族" },
      ],
    },
    chainLinks: [{
      id: "C1",
      order: 1,
      sourceCardId: "source#1",
      sourceInstanceId: "source#1",
      sourceCardName: "发动源",
      effectCategory: "monster",
      targets: [{ instanceId: targetId, cardId: targetId, expectedZone: "spell_trap_zone" }],
      sequence: [
        createEffectPrimitive("special_summon_cards", {
          cardInstanceIds: ["summoned-a#1", "summoned-b#1"],
          controller: "self",
        }),
        {
          connector: "THEN",
          primitive: createEffectPrimitive("destroy_target", {
            targetInstanceId: targetId,
            targetExpectedZone: "spell_trap_zone",
            optional: true,
          }),
        },
      ],
    }],
    continuousEffects: [fieldLimitEffect()],
  });
}

test("field-count cleanup waits until summon-then-destroy finishes, matching FAQ 24189 timing", () => {
  const destroysLimit = orderedSummonThenDestroy("limit#1");
  assert.equal(destroysLimit.complete, true);
  assert.equal(destroysLimit.finalGameState.cards.find((card) => card.instanceId === "limit#1").zone, "graveyard");
  assert.equal(destroysLimit.finalGameState.cards.find((card) => card.instanceId === "summoned-a#1").zone, "monster_zone");
  assert.equal(destroysLimit.finalGameState.cards.find((card) => card.instanceId === "summoned-b#1").zone, "monster_zone");
  const destroyedCheckpoint = destroysLimit.linkResults[0].afterResolutionCheckpoint;
  assert.equal(destroyedCheckpoint.adjustments.length, 0);
  assert.ok(destroyedCheckpoint.trace.some((entry) => entry.event === "field_restriction_inactive"));

  const leavesLimit = orderedSummonThenDestroy("other#1");
  assert.equal(leavesLimit.complete, true);
  const pending = leavesLimit.linkResults[0].afterResolutionCheckpoint.adjustments[0];
  assert.equal(pending.status, "choice_required");
  assert.equal(pending.timing, "after_effect_resolution_checkpoint");
  assert.equal(pending.sendCount, 1);
  assert.deepEqual(new Set(pending.candidateInstanceIds), new Set(["summoned-a#1", "summoned-b#1"]));
  assert.ok(leavesLimit.linkResults[0].primitiveResult.steps.every((step) => step.status === "applied"));
});
