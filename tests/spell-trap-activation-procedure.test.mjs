import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATION_KINDS,
  ACTIVATION_RESPONSE_PREDICATES,
  createEffectActivationEvent,
  evaluateActivationResponsePredicate,
  executeSpellTrapCardActivationProcedure,
} from "../backend/spellTrapActivationProcedure.mjs";

const handOrPublicDiscardedZoneResponse = Object.freeze({
  type: ACTIVATION_RESPONSE_PREDICATES.CARD_EFFECT_ACTIVATED_FROM_ZONE,
  zones: ["HAND", "GRAVEYARD", "BANISHED"],
  actorRelation: "OPPONENT",
});

function handTrapScenario({
  instanceId = "fictional-trap-a#1",
  definitionId = "fictional-trap-a",
  effectId = "fictional-trap-a:effect-1",
  name = "虚构陷阱甲",
} = {}) {
  return {
    gameState: {
      cards: [{
        instanceId,
        definitionId,
        objectEpoch: 1,
        name,
        cardType: "trap",
        controller: "self",
        owner: "self",
        zone: "hand",
        faceUp: false,
      }],
      fieldStateCompleteByPlayer: { self: true },
    },
    declaration: {
      sourceInstanceId: instanceId,
      player: "self",
      effectId,
      chainLinkId: "C1",
      fieldEmpty: true,
      fromHandPermission: {
        status: "CONFIRMED",
        requiresControllerFieldEmpty: true,
      },
    },
  };
}

function structuralProjection(result) {
  return {
    status: result.status,
    code: result.code,
    sourceZone: result.gameState.cards[0].zone,
    sourceFaceUp: result.gameState.cards[0].faceUp,
    activationKind: result.activationEvent.activationKind,
    originZoneAtDeclaration: result.activationEvent.originZoneAtDeclaration,
    activationZone: result.activationEvent.activationZone,
    sourceCardType: result.activationEvent.sourceCardType,
    cardActivationIncludesEffectActivation:
      result.activationEvent.cardActivationIncludesEffectActivation,
    trace: result.trace.map((item) => ({
      type: item.type,
      fromZone: item.fromZone,
      toZone: item.toZone,
      causeKind: item.causeKind,
      byCardEffect: item.byCardEffect,
      activationKind: item.activationKind,
      originZoneAtDeclaration: item.originZoneAtDeclaration,
      activationZone: item.activationZone,
    })),
  };
}

test("hand Spell/Trap Card activation places the card on the field before freezing its activation event", () => {
  const input = handTrapScenario();
  const result = executeSpellTrapCardActivationProcedure(input);

  assert.equal(result.status, "ACTIVATED", JSON.stringify(result));
  assert.equal(result.gameState.cards[0].zone, "SPELL_TRAP_ZONE");
  assert.equal(result.gameState.cards[0].faceUp, true);
  assert.equal(input.gameState.cards[0].zone, "hand", "input state must not be mutated");
  assert.equal(result.trace[0].causeKind, "RULE_PROCEDURE");
  assert.equal(result.trace[0].byCardEffect, false);
  assert.equal(result.activationEvent.originZoneAtDeclaration, "HAND");
  assert.equal(result.activationEvent.activationZone, "SPELL_TRAP_ZONE");
  assert.equal(result.activationEvent.activationKind, ACTIVATION_KINDS.CARD_ACTIVATION);
  assert.equal(result.activationEvent.cardActivationIncludesEffectActivation, true);
  assert.equal(Object.isFrozen(result.activationEvent), true);
  assert.equal(Object.isFrozen(result.activationEvent.sourceCardIdentity), true);

  const response = evaluateActivationResponsePredicate({
    activationEvent: result.activationEvent,
    predicate: handOrPublicDiscardedZoneResponse,
    responderPlayer: "opponent",
  });
  assert.deepEqual(response, {
    status: "DECIDED",
    matches: false,
    reason: "ACTIVATION_ZONE_DID_NOT_MATCH",
    comparedActivationZone: "SPELL_TRAP_ZONE",
    acceptedActivationZones: ["HAND", "GRAVEYARD", "BANISHED"],
    originZoneAtDeclaration: "HAND",
    originZoneIgnoredForResponse: true,
  });
});

test("renaming every fictional card identity cannot change the activation procedure verdict", () => {
  const first = executeSpellTrapCardActivationProcedure(handTrapScenario());
  const renamed = executeSpellTrapCardActivationProcedure(handTrapScenario({
    instanceId: "renamed-omega#77",
    definitionId: "renamed-omega",
    effectId: "renamed-omega:effect-z",
    name: "完全改名后的虚构陷阱",
  }));

  assert.deepEqual(structuralProjection(renamed), structuralProjection(first));
  const firstResponse = evaluateActivationResponsePredicate({
    activationEvent: first.activationEvent,
    predicate: handOrPublicDiscardedZoneResponse,
    responderPlayer: "opponent",
  });
  const renamedResponse = evaluateActivationResponsePredicate({
    activationEvent: renamed.activationEvent,
    predicate: handOrPublicDiscardedZoneResponse,
    responderPlayer: "opponent",
  });
  assert.deepEqual(renamedResponse, firstResponse);
});

test("a real hand monster-effect activation remains a HAND event and matches a hand-zone response", () => {
  const event = createEffectActivationEvent({
    activationZone: "HAND",
    sourceCardType: "MONSTER",
    player: "self",
    sourceInstanceId: "fictional-hand-monster#1",
    sourceDefinitionId: "fictional-hand-monster",
    effectId: "fictional-hand-monster:effect-1",
    chainLinkId: "C1",
  });
  const response = evaluateActivationResponsePredicate({
    activationEvent: event,
    predicate: handOrPublicDiscardedZoneResponse,
    responderPlayer: "opponent",
  });

  assert.equal(event.activationKind, ACTIVATION_KINDS.EFFECT_ACTIVATION);
  assert.equal(event.activationZone, "HAND");
  assert.equal(response.status, "DECIDED");
  assert.equal(response.matches, true);
  assert.equal(response.comparedActivationZone, "HAND");
});

test("both a Set Trap and a Trap activated from hand create SPELL_TRAP_ZONE activation events", () => {
  const fromHand = executeSpellTrapCardActivationProcedure(handTrapScenario());
  const fromSet = executeSpellTrapCardActivationProcedure({
    gameState: {
      cards: [{
        instanceId: "fictional-set-trap#1",
        definitionId: "fictional-set-trap",
        cardType: "TRAP",
        controller: "self",
        owner: "self",
        zone: "SPELL_TRAP_ZONE",
        faceUp: false,
        set: true,
      }],
    },
    declaration: {
      sourceInstanceId: "fictional-set-trap#1",
      player: "self",
      effectId: "fictional-set-trap:effect-1",
      chainLinkId: "C1",
    },
  });

  assert.equal(fromSet.status, "ACTIVATED", JSON.stringify(fromSet));
  assert.equal(fromSet.activationEvent.originZoneAtDeclaration, "SPELL_TRAP_ZONE");
  for (const result of [fromHand, fromSet]) {
    assert.equal(result.activationEvent.activationZone, "SPELL_TRAP_ZONE");
    const response = evaluateActivationResponsePredicate({
      activationEvent: result.activationEvent,
      predicate: handOrPublicDiscardedZoneResponse,
      responderPlayer: "opponent",
    });
    assert.equal(response.matches, false);
  }
});

test("known non-empty field makes a field-empty from-hand permission illegal", () => {
  const input = handTrapScenario();
  input.gameState.cards.push({
    instanceId: "fictional-field-card#1",
    definitionId: "fictional-field-card",
    cardType: "MONSTER",
    controller: "self",
    owner: "self",
    zone: "MONSTER_ZONE",
    faceUp: true,
  });
  input.declaration.fieldEmpty = false;

  const result = executeSpellTrapCardActivationProcedure(input);
  assert.equal(result.status, "ILLEGAL");
  assert.equal(result.code, "CONTROLLER_FIELD_NOT_EMPTY");
  assert.equal(result.activationEvent, null);
});

test("a complete empty field snapshot also proves placement capacity without a redundant flag", () => {
  const scenario = handTrapScenario();
  delete scenario.declaration.fieldEmpty;
  scenario.gameState.fieldStateCompleteByPlayer = { self: true };

  const result = executeSpellTrapCardActivationProcedure(scenario);

  assert.equal(result.status, "ACTIVATED");
  assert.equal(result.activationEvent.activationZone, "SPELL_TRAP_ZONE");
});

test("missing hand permission, source zone, or required field completeness fails closed", () => {
  const permissionMissing = handTrapScenario();
  delete permissionMissing.declaration.fromHandPermission;
  assert.deepEqual(
    pickFailure(executeSpellTrapCardActivationProcedure(permissionMissing)),
    { status: "UNKNOWN", code: "FROM_HAND_ACTIVATION_PERMISSION_UNKNOWN" },
  );

  const zoneMissing = handTrapScenario();
  zoneMissing.gameState.cards[0].zone = "unknown";
  assert.deepEqual(
    pickFailure(executeSpellTrapCardActivationProcedure(zoneMissing)),
    { status: "UNKNOWN", code: "SOURCE_ZONE_UNKNOWN" },
  );

  const fieldStateMissing = handTrapScenario();
  delete fieldStateMissing.declaration.fieldEmpty;
  delete fieldStateMissing.gameState.fieldStateCompleteByPlayer;
  assert.deepEqual(
    pickFailure(executeSpellTrapCardActivationProcedure(fieldStateMissing)),
    { status: "UNKNOWN", code: "CONTROLLER_FIELD_EMPTY_STATE_UNKNOWN" },
  );
});

test("response evaluation fails closed instead of falling back to declaration origin", () => {
  const malformed = {
    activationKind: "CARD_ACTIVATION",
    originZoneAtDeclaration: "HAND",
    activationZone: "unknown",
    player: "self",
  };
  const result = evaluateActivationResponsePredicate({
    activationEvent: malformed,
    predicate: handOrPublicDiscardedZoneResponse,
    responderPlayer: "opponent",
  });
  assert.deepEqual(result, {
    status: "UNKNOWN",
    matches: null,
    reason: "ACTIVATION_ZONE_UNKNOWN",
  });
});

function pickFailure(result) {
  return { status: result.status, code: result.code };
}
