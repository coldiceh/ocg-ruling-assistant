import assert from "node:assert/strict";
import test from "node:test";

import {
  createDestinationReplacement,
  createEffectPrimitive,
} from "../backend/effectPrimitives.mjs";
import { resolveEffectChain } from "../backend/effectResolutionEngine.mjs";

const replacementEffectId = "rift-keeper-grave-replacement";

function destinationReplacementEffect() {
  return {
    id: replacementEffectId,
    sourceInstanceId: "rift-keeper#1",
    sourceDefinitionId: "rift-keeper",
    activeWhen: { zone: "monster_zone", faceUp: true },
    destinationReplacements: [createDestinationReplacement({
      id: "opponent-grave-to-rift",
      intendedToZone: "graveyard",
      replacementToZone: "banished",
      destinationPlayerRelation: "opponent_of_source_controller",
    })],
  };
}

function card(instanceId, definitionId, controller, zone, extra = {}) {
  return {
    instanceId,
    definitionId,
    name: definitionId,
    owner: controller,
    controller,
    zone,
    faceUp: zone === "monster_zone" || zone === "spell_trap_zone",
    position: zone === "monster_zone" ? "attack" : "none",
    ...extra,
  };
}

function discardFixture() {
  const cards = [
    card("convergence#1", "convergence", "self", "spell_trap_zone"),
    card("rift-keeper#1", "rift-keeper", "opponent", "monster_zone"),
    card("offering#1", "offering", "self", "hand", { faceUp: false }),
  ];
  return {
    gameState: {
      cards,
      hands: { self: [cards[2]], opponent: [] },
      graveyards: { self: [], opponent: [] },
      banished: { self: [], opponent: [] },
    },
    chainLinks: [{
      id: "C1",
      order: 1,
      sourceInstanceId: "convergence#1",
      sourceDefinitionId: "convergence",
      sourceExpectedZone: "spell_trap_zone",
      activationCostSequence: [createEffectPrimitive("discard_from_hand", {
        player: "self",
        amount: 1,
        cardIds: ["offering#1"],
      })],
      sequence: [],
    }],
    continuousEffects: [destinationReplacementEffect()],
  };
}

function fusionFixture({ includeCarrier = true, reverseCards = false } = {}) {
  const cards = [
    card("convergence#1", "convergence", "self", "spell_trap_zone"),
    card("rift-keeper#1", "rift-keeper", "opponent", "monster_zone"),
    card("ember#1", "ember-material", "self", "monster_zone"),
    card("foreign#1", "foreign-material", "opponent", "monster_zone"),
    card("result#1", "result", "self", "extra_deck", {
      faceUp: false,
      materialRecipe: {
        slots: includeCarrier
          ? [
            { id: "carrier", predicate: { definitionIds: ["rift-keeper"] } },
            { id: "ember", predicate: { definitionIds: ["ember-material"] } },
          ]
          : [
            { id: "ember", predicate: { definitionIds: ["ember-material"] } },
            { id: "foreign", predicate: { definitionIds: ["foreign-material"] } },
          ],
      },
    }),
  ];
  const fusion = createEffectPrimitive("fusion_summon", {
    sourceInstanceId: "convergence#1",
    sourceDefinitionId: "convergence",
    interaction: "non_affecting",
    materialPool: { zone: "monster_zone", controllers: ["self", "opponent"] },
    candidateInstanceIds: ["result#1"],
  });
  return {
    gameState: {
      cards: reverseCards ? [...cards].reverse() : cards,
      graveyards: { self: [], opponent: [] },
      banished: { self: [], opponent: [] },
    },
    chainLinks: [{
      id: "C1",
      order: 1,
      sourceInstanceId: "convergence#1",
      sourceDefinitionId: "convergence",
      sourceExpectedZone: "spell_trap_zone",
      activationPreconditions: [{ type: "operation_performable", primitive: fusion }],
      sequence: [fusion],
    }],
    continuousEffects: [destinationReplacementEffect()],
  };
}

function cardZone(result, instanceId) {
  return result.finalGameState.cards.find((item) => item.instanceId === instanceId)?.zone;
}

function fusionOutcome(result) {
  return result.linkResults[0].primitiveResult.outcomes.find((item) => item.type === "fusion_summon");
}

test("discard records intended and replacement destinations while the carrier remains active", () => {
  const result = resolveEffectChain(discardFixture());
  const costStage = result.activationResults[0].stageResults.find((item) => item.stage === "pay_activation_cost");
  const change = costStage.result.stateChanges.find((item) => item.type === "discard_from_hand");

  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(cardZone(result, "offering#1"), "banished");
  assert.equal(change.intendedToZone, "graveyard");
  assert.equal(change.actualToZone, "banished");
  assert.equal(change.moves[0].replacementEffectId, replacementEffectId);
  assert.deepEqual(result.finalGameState.graveyards.self, []);
});

test("a continuous replacement carrier leaving in the same material batch is suppressed for the whole batch", () => {
  const forward = resolveEffectChain(fusionFixture());
  const reversed = resolveEffectChain(fusionFixture({ reverseCards: true }));

  for (const result of [forward, reversed]) {
    const outcome = fusionOutcome(result);
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.equal(outcome.status, "performed");
    assert.equal(cardZone(result, "rift-keeper#1"), "graveyard");
    assert.equal(cardZone(result, "ember#1"), "graveyard");
    assert.equal(cardZone(result, "result#1"), "monster_zone");
    assert.deepEqual(outcome.materialMoves.map((move) => move.actualToZone), ["graveyard", "graveyard"]);
    assert.ok(outcome.suppressedDestinationReplacementEffectIds.includes(replacementEffectId));
  }

  const movementSignature = (result) => fusionOutcome(result).materialMoves
    .map((move) => [move.instanceId, move.actualToZone])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(movementSignature(forward), movementSignature(reversed));
});

test("a material can be redirected while the carrier stays active without preventing the Fusion Summon", () => {
  const result = resolveEffectChain(fusionFixture({ includeCarrier: false }));
  const outcome = fusionOutcome(result);
  const emberMove = outcome.materialMoves.find((move) => move.instanceId === "ember#1");
  const foreignMove = outcome.materialMoves.find((move) => move.instanceId === "foreign#1");

  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(outcome.status, "performed");
  assert.equal(cardZone(result, "rift-keeper#1"), "monster_zone");
  assert.equal(cardZone(result, "ember#1"), "banished");
  assert.equal(cardZone(result, "foreign#1"), "graveyard");
  assert.equal(cardZone(result, "result#1"), "monster_zone");
  assert.deepEqual([emberMove.intendedToZone, emberMove.actualToZone], ["graveyard", "banished"]);
  assert.equal(emberMove.replacementEffectId, replacementEffectId);
  assert.equal(foreignMove.actualToZone, "graveyard");
});
