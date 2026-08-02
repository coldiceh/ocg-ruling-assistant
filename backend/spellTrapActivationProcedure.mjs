export const ACTIVATION_EVENT_SCHEMA_VERSION = "ocg-activation-event/v1";

export const ACTIVATION_KINDS = Object.freeze({
  CARD_ACTIVATION: "CARD_ACTIVATION",
  EFFECT_ACTIVATION: "EFFECT_ACTIVATION",
});

export const ACTIVATION_RESPONSE_PREDICATES = Object.freeze({
  CARD_EFFECT_ACTIVATED_FROM_ZONE: "CARD_EFFECT_ACTIVATED_FROM_ZONE",
});

const FIELD_ZONES = new Set([
  "MONSTER_ZONE",
  "SPELL_TRAP_ZONE",
  "FIELD_ZONE",
  "PENDULUM_ZONE",
]);
const SPELL_TRAP_CARD_TYPES = new Set(["SPELL", "TRAP"]);
const ACTIVATION_EVENT_KINDS = new Set(Object.values(ACTIVATION_KINDS));

/**
 * Performs only the rule procedure for activating a Spell/Trap Card.
 *
 * A Spell/Trap Card activated from the hand is first placed face-up in the
 * Spell & Trap Zone by a rule procedure (not by a card effect). Only after
 * that placement is its immutable activation event created. Consequently,
 * originZoneAtDeclaration can be HAND while activationZone is
 * SPELL_TRAP_ZONE.
 *
 * The function consumes structured facts only. Missing permission, source
 * zone, controller, card type, or a required field-empty fact returns typed
 * UNKNOWN rather than guessing.
 */
export function executeSpellTrapCardActivationProcedure({
  gameState = {},
  declaration = {},
} = {}) {
  const initialState = clone(gameState);
  const cards = Array.isArray(initialState.cards) ? initialState.cards : null;
  if (!cards) return unknown("CARD_STATE_UNKNOWN", initialState);

  const sourceInstanceId = nonEmpty(declaration.sourceInstanceId);
  if (!sourceInstanceId) return unknown("SOURCE_INSTANCE_ID_UNKNOWN", initialState);
  const candidates = cards.filter((card) => instanceId(card) === sourceInstanceId);
  if (candidates.length !== 1) {
    return unknown(
      candidates.length ? "SOURCE_INSTANCE_AMBIGUOUS" : "SOURCE_INSTANCE_MISSING",
      initialState,
    );
  }

  const source = candidates[0];
  const player = nonEmpty(declaration.player);
  if (!player) return unknown("ACTIVATING_PLAYER_UNKNOWN", initialState);
  const controller = nonEmpty(source.controller);
  if (!controller) return unknown("SOURCE_CONTROLLER_UNKNOWN", initialState);
  if (controller !== player) return illegal("SOURCE_NOT_CONTROLLED_BY_ACTIVATING_PLAYER", initialState);

  const sourceCardType = normalizeCardType(source.cardType || declaration.sourceCardType);
  if (!sourceCardType) return unknown("SOURCE_CARD_TYPE_UNKNOWN", initialState);
  if (!SPELL_TRAP_CARD_TYPES.has(sourceCardType)) {
    return illegal("SOURCE_IS_NOT_SPELL_OR_TRAP_CARD", initialState);
  }

  const originZoneAtDeclaration = normalizeZone(source.zone);
  if (!originZoneAtDeclaration) return unknown("SOURCE_ZONE_UNKNOWN", initialState);
  const trace = [];

  if (originZoneAtDeclaration === "HAND") {
    const permission = normalizeFromHandPermission(declaration.fromHandPermission);
    if (permission.status === "UNKNOWN") {
      return unknown("FROM_HAND_ACTIVATION_PERMISSION_UNKNOWN", initialState);
    }
    if (permission.status === "DENIED") {
      return illegal("FROM_HAND_ACTIVATION_NOT_PERMITTED", initialState);
    }

    let confirmedControllerFieldEmpty = null;
    if (permission.requiresControllerFieldEmpty) {
      const fieldEmpty = determineControllerFieldEmpty({
        state: initialState,
        player,
        explicitValue: declaration.fieldEmpty ?? permission.fieldEmpty,
        sourceInstanceId,
      });
      if (fieldEmpty.status === "UNKNOWN") return unknown(fieldEmpty.code, initialState);
      if (fieldEmpty.status === "CONTRADICTED") return unknown(fieldEmpty.code, initialState);
      if (!fieldEmpty.value) return illegal("CONTROLLER_FIELD_NOT_EMPTY", initialState);
      confirmedControllerFieldEmpty = true;
    }

    const capacity = determineSpellTrapZoneCapacity({
      state: initialState,
      player,
      explicitValue: declaration.spellTrapZoneHasCapacity,
      fieldEmpty: confirmedControllerFieldEmpty
        ?? declaration.fieldEmpty
        ?? permission.fieldEmpty,
    });
    if (capacity.status === "UNKNOWN") return unknown(capacity.code, initialState);
    if (!capacity.value) return illegal("SPELL_TRAP_ZONE_HAS_NO_CAPACITY", initialState);

    source.zone = "SPELL_TRAP_ZONE";
    source.faceUp = true;
    source.set = false;
    trace.push({
      type: "PLACE_FOR_SPELL_TRAP_CARD_ACTIVATION",
      sourceInstanceId,
      fromZone: "HAND",
      toZone: "SPELL_TRAP_ZONE",
      causeKind: "RULE_PROCEDURE",
      byCardEffect: false,
    });
  } else if (originZoneAtDeclaration === "SPELL_TRAP_ZONE") {
    const faceUp = knownBoolean(source.faceUp)
      ? source.faceUp
      : knownBoolean(source.set)
        ? !source.set
        : null;
    if (faceUp === null) return unknown("SET_OR_FACE_UP_STATE_UNKNOWN", initialState);
    if (faceUp) return illegal("FACE_UP_CARD_IS_NOT_BEING_CARD_ACTIVATED", initialState);
    source.faceUp = true;
    source.set = false;
    trace.push({
      type: "FLIP_FOR_SPELL_TRAP_CARD_ACTIVATION",
      sourceInstanceId,
      fromZone: "SPELL_TRAP_ZONE",
      toZone: "SPELL_TRAP_ZONE",
      causeKind: "RULE_PROCEDURE",
      byCardEffect: false,
    });
  } else {
    return illegal("CARD_ACTIVATION_ORIGIN_ZONE_UNSUPPORTED", initialState);
  }

  const activationEvent = createFrozenActivationEvent({
    eventId: declaration.eventId,
    activationId: declaration.activationId,
    chainLinkId: declaration.chainLinkId,
    activationKind: ACTIVATION_KINDS.CARD_ACTIVATION,
    originZoneAtDeclaration,
    activationZone: "SPELL_TRAP_ZONE",
    sourceCardType,
    player,
    sourceInstanceId,
    sourceDefinitionId: definitionId(source),
    sourceObjectEpoch: source.objectEpoch,
    effectId: declaration.effectId,
    cardActivationIncludesEffectActivation: true,
  });
  trace.push({
    type: "ACTIVATION_EVENT_CREATED",
    eventId: activationEvent.eventId,
    activationKind: activationEvent.activationKind,
    originZoneAtDeclaration,
    activationZone: activationEvent.activationZone,
  });

  return {
    status: "ACTIVATED",
    code: "SPELL_TRAP_CARD_ACTIVATION_EVENT_CREATED",
    gameState: initialState,
    activationEvent,
    trace,
  };
}

/**
 * Creates an activation event for an already classified effect activation.
 * This is intentionally separate from Spell/Trap Card activation: a monster
 * effect activated in the hand remains a HAND activation event.
 */
export function createEffectActivationEvent({
  eventId,
  activationId,
  chainLinkId,
  activationZone,
  originZoneAtDeclaration = activationZone,
  sourceCardType,
  player,
  sourceInstanceId,
  sourceDefinitionId,
  sourceObjectEpoch,
  effectId,
} = {}) {
  const zone = normalizeZone(activationZone);
  if (!zone) throw new TypeError("effect activation requires a known activationZone");
  if (!nonEmpty(player)) throw new TypeError("effect activation requires player");
  if (!nonEmpty(sourceInstanceId)) throw new TypeError("effect activation requires sourceInstanceId");
  return createFrozenActivationEvent({
    eventId,
    activationId,
    chainLinkId,
    activationKind: ACTIVATION_KINDS.EFFECT_ACTIVATION,
    originZoneAtDeclaration: normalizeZone(originZoneAtDeclaration) || zone,
    activationZone: zone,
    sourceCardType: normalizeCardType(sourceCardType) || "UNKNOWN",
    player,
    sourceInstanceId,
    sourceDefinitionId,
    sourceObjectEpoch,
    effectId,
    cardActivationIncludesEffectActivation: false,
  });
}

/**
 * Evaluates the generic response condition “a card effect was activated from
 * one of these zones”. The comparison is deliberately made against the
 * frozen activationZone, never originZoneAtDeclaration.
 */
export function evaluateActivationResponsePredicate({
  activationEvent,
  predicate = {},
  responderPlayer,
} = {}) {
  if (!activationEvent || typeof activationEvent !== "object") {
    return responseUnknown("ACTIVATION_EVENT_UNKNOWN");
  }
  if (predicate.type !== ACTIVATION_RESPONSE_PREDICATES.CARD_EFFECT_ACTIVATED_FROM_ZONE) {
    return responseUnknown("RESPONSE_PREDICATE_UNSUPPORTED");
  }
  const activationKind = nonEmpty(activationEvent.activationKind);
  if (!ACTIVATION_EVENT_KINDS.has(activationKind)) {
    return responseUnknown("ACTIVATION_KIND_UNKNOWN");
  }
  const activationZone = normalizeZone(activationEvent.activationZone);
  if (!activationZone) return responseUnknown("ACTIVATION_ZONE_UNKNOWN");
  const zones = unique((predicate.zones || []).map(normalizeZone).filter(Boolean));
  if (!zones.length) return responseUnknown("RESPONSE_ZONE_SCOPE_UNKNOWN");

  const actorRelation = nonEmpty(predicate.actorRelation || "ANY").toUpperCase();
  if (actorRelation === "OPPONENT") {
    const responder = nonEmpty(responderPlayer);
    const actor = nonEmpty(activationEvent.player);
    if (!responder || !actor) return responseUnknown("RESPONSE_PLAYER_RELATION_UNKNOWN");
    if (responder === actor) {
      return responseDecision(false, "ACTIVATING_PLAYER_IS_NOT_OPPONENT", activationEvent, zones);
    }
  } else if (!new Set(["ANY", "OPPONENT"]).has(actorRelation)) {
    return responseUnknown("RESPONSE_PLAYER_RELATION_UNSUPPORTED");
  }

  const matches = zones.includes(activationZone);
  return responseDecision(
    matches,
    matches ? "ACTIVATION_ZONE_MATCHED" : "ACTIVATION_ZONE_DID_NOT_MATCH",
    activationEvent,
    zones,
  );
}

function createFrozenActivationEvent(input) {
  const sourceInstanceId = nonEmpty(input.sourceInstanceId);
  const effectId = nonEmpty(input.effectId) || "CARD_ACTIVATION_EFFECT";
  const chainLinkId = nonEmpty(input.chainLinkId);
  const activationId = nonEmpty(input.activationId)
    || `activation:${chainLinkId || sourceInstanceId}:${effectId}`;
  const event = {
    schemaVersion: ACTIVATION_EVENT_SCHEMA_VERSION,
    eventId: nonEmpty(input.eventId) || `event:${activationId}`,
    activationId,
    chainLinkId: chainLinkId || null,
    activationKind: input.activationKind,
    cardActivationIncludesEffectActivation: input.cardActivationIncludesEffectActivation === true,
    originZoneAtDeclaration: normalizeZone(input.originZoneAtDeclaration),
    activationZone: normalizeZone(input.activationZone),
    sourceCardType: normalizeCardType(input.sourceCardType) || "UNKNOWN",
    player: nonEmpty(input.player),
    sourceCardIdentity: {
      instanceId: sourceInstanceId,
      definitionId: nonEmpty(input.sourceDefinitionId) || null,
      objectEpoch: input.sourceObjectEpoch ?? null,
    },
    sourceEffectIdentity: {
      effectId,
    },
  };
  return deepFreeze(event);
}

function determineControllerFieldEmpty({
  state,
  player,
  explicitValue,
  sourceInstanceId,
}) {
  const fieldCards = (state.cards || []).filter((card) => (
    instanceId(card) !== sourceInstanceId
    && nonEmpty(card.controller) === player
    && FIELD_ZONES.has(normalizeZone(card.zone))
  ));
  if (fieldCards.length) {
    if (explicitValue === true) {
      return { status: "CONTRADICTED", code: "FIELD_EMPTY_FACT_CONTRADICTS_CARD_STATE" };
    }
    return { status: "KNOWN", value: false };
  }
  if (knownBoolean(explicitValue)) return { status: "KNOWN", value: explicitValue };
  if (fieldStateComplete(state, player)) return { status: "KNOWN", value: true };
  return { status: "UNKNOWN", code: "CONTROLLER_FIELD_EMPTY_STATE_UNKNOWN" };
}

function determineSpellTrapZoneCapacity({ state, player, explicitValue, fieldEmpty }) {
  if (knownBoolean(explicitValue)) return { status: "KNOWN", value: explicitValue };
  if (fieldEmpty === true) return { status: "KNOWN", value: true };
  const value = state.spellTrapZoneHasCapacityByPlayer?.[player];
  if (knownBoolean(value)) return { status: "KNOWN", value };
  return { status: "UNKNOWN", code: "SPELL_TRAP_ZONE_CAPACITY_UNKNOWN" };
}

function normalizeFromHandPermission(value) {
  if (!value || typeof value !== "object") return { status: "UNKNOWN" };
  const rawStatus = nonEmpty(value.status).toUpperCase();
  const status = rawStatus === "CONFIRMED" || value.allowed === true
    ? "CONFIRMED"
    : rawStatus === "DENIED" || value.allowed === false
      ? "DENIED"
      : "UNKNOWN";
  return {
    status,
    requiresControllerFieldEmpty: value.requiresControllerFieldEmpty === true,
    fieldEmpty: value.fieldEmpty,
  };
}

function fieldStateComplete(state, player) {
  return state.fieldStateCompleteByPlayer?.[player] === true
    || state.completeZonesByPlayer?.[player]?.field === true;
}

function responseDecision(matches, reason, event, zones) {
  return {
    status: "DECIDED",
    matches,
    reason,
    comparedActivationZone: normalizeZone(event.activationZone),
    acceptedActivationZones: zones,
    originZoneAtDeclaration: normalizeZone(event.originZoneAtDeclaration),
    originZoneIgnoredForResponse: true,
  };
}

function responseUnknown(code) {
  return { status: "UNKNOWN", matches: null, reason: code };
}

function unknown(code, state) {
  return { status: "UNKNOWN", code, gameState: state, activationEvent: null, trace: [] };
}

function illegal(code, state) {
  return { status: "ILLEGAL", code, gameState: state, activationEvent: null, trace: [] };
}

function instanceId(card) {
  return nonEmpty(card?.instanceId || card?.cardInstanceId || card?.entityId || card?.uid);
}

function definitionId(card) {
  return nonEmpty(card?.definitionId || card?.cardDefinitionId || card?.cardId || card?.id) || null;
}

function normalizeZone(value) {
  const normalized = nonEmpty(value).normalize("NFKC").replaceAll(/[-\s]+/gu, "_").toUpperCase();
  if (!normalized || normalized === "UNKNOWN") return "";
  const aliases = {
    HAND: "HAND",
    GRAVEYARD: "GRAVEYARD",
    GY: "GRAVEYARD",
    BANISHED: "BANISHED",
    MONSTER_ZONE: "MONSTER_ZONE",
    SPELL_TRAP_ZONE: "SPELL_TRAP_ZONE",
    SPELL_AND_TRAP_ZONE: "SPELL_TRAP_ZONE",
    FIELD_ZONE: "FIELD_ZONE",
    PENDULUM_ZONE: "PENDULUM_ZONE",
  };
  return aliases[normalized] || normalized;
}

function normalizeCardType(value) {
  const normalized = nonEmpty(value).normalize("NFKC").toUpperCase();
  if (!normalized || normalized === "UNKNOWN") return "";
  if (/TRAP|陷阱|罠/u.test(normalized)) return "TRAP";
  if (/SPELL|魔法/u.test(normalized)) return "SPELL";
  if (/MONSTER|怪兽|怪獸|モンスター/u.test(normalized)) return "MONSTER";
  return normalized;
}

function knownBoolean(value) {
  return typeof value === "boolean";
}

function nonEmpty(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values)];
}

function clone(value) {
  return structuredClone(value || {});
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
