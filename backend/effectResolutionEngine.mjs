import {
  connectorDependsOnPreviousSuccess,
  normalizePrimitiveSequence,
} from "./effectPrimitives.mjs";

export function resolvePrimitiveSequence(sequence = [], gameState = {}) {
  let state = clone(gameState);
  const items = normalizePrimitiveSequence(sequence);
  const steps = [];
  const failedParts = [];
  const continuedParts = [];
  const stateChanges = [];
  const ruleTrace = [];
  let previousSucceeded = true;
  let stopRemaining = false;
  let insufficient = false;

  for (const item of items) {
    const primitive = item.primitive;
    const dependsOnPrevious = primitive.dependsOnPreviousSuccess
      || connectorDependsOnPreviousSuccess(item.connector);

    if (stopRemaining || (dependsOnPrevious && !previousSucceeded)) {
      const reason = stopRemaining ? "previous_failure_stopped_remaining" : `connector_${item.connector.toLowerCase()}_requires_previous_success`;
      const step = skippedStep(item, reason);
      steps.push(step);
      failedParts.push(partDescriptor(item, reason));
      ruleTrace.push(trace(item, "dependent_part_skipped", "skipped", { reason, connector: item.connector }));
      previousSucceeded = false;
      continue;
    }

    const targetCheck = inspectRequiredTarget(primitive, state);
    const sourceCheck = inspectRequiredSource(primitive, state);
    emitIndependentContinuationTrace(item, targetCheck, sourceCheck, ruleTrace);

    const precondition = firstFailedPrecondition(targetCheck, sourceCheck);
    if (precondition) {
      const failed = handlePreconditionFailure(item, precondition, steps, failedParts, ruleTrace);
      previousSucceeded = false;
      if (failed.insufficient) {
        insufficient = true;
        stopRemaining = true;
      } else if (primitive.resultOnFailure === "stop_remaining") {
        stopRemaining = true;
      }
      continue;
    }

    const execution = executePrimitive(primitive, state);
    if (execution.status === "insufficient") {
      insufficient = true;
      previousSucceeded = false;
      failedParts.push(partDescriptor(item, execution.reason));
      steps.push({ id: item.id, primitive: primitive.type, connector: item.connector, status: "insufficient", reason: execution.reason, stateChanges: [] });
      ruleTrace.push(trace(item, "primitive_insufficient", "insufficient", { reason: execution.reason }));
      stopRemaining = true;
      continue;
    }
    if (execution.status === "failed" || execution.status === "skipped") {
      previousSucceeded = false;
      failedParts.push(partDescriptor(item, execution.reason));
      steps.push({ id: item.id, primitive: primitive.type, connector: item.connector, status: execution.status, reason: execution.reason, stateChanges: [] });
      ruleTrace.push(trace(item, "primitive_failed", execution.status, { reason: execution.reason }));
      if (primitive.resultOnFailure === "stop_remaining") stopRemaining = true;
      if (primitive.resultOnFailure === "insufficient") {
        insufficient = true;
        stopRemaining = true;
      }
      continue;
    }

    state = execution.gameState;
    previousSucceeded = true;
    continuedParts.push(partDescriptor(item, "applied"));
    stateChanges.push(...execution.stateChanges.map((change) => ({ primitiveId: item.id, primitive: primitive.type, ...change })));
    steps.push({ id: item.id, primitive: primitive.type, connector: item.connector, status: "applied", reason: "applied", stateChanges: execution.stateChanges });
    ruleTrace.push(trace(item, "primitive_applied", "applied"));
  }

  const appliedCount = steps.filter((step) => step.status === "applied").length;
  const failedCount = steps.length - appliedCount;
  const resolutionStatus = insufficient
    ? "insufficient"
    : failedCount === 0
      ? "resolved"
      : appliedCount > 0
        ? "partially_resolved"
        : "failed";

  return {
    resolutionStatus,
    verdict: resolutionStatus,
    steps,
    failedParts,
    continuedParts,
    stateChanges,
    ruleTrace,
    gameState: state,
  };
}

function inspectRequiredTarget(primitive, state) {
  const context = state.resolutionContext || {};
  const ref = primitive.target || findReference(context.targets, primitive.targetId || primitive.targetRef);
  const expectedZoneValue = primitive.targetExpectedZone || ref?.expectedZone;
  const expectedZone = normalize(expectedZoneValue) === "unknown" ? null : expectedZoneValue;
  const explicit = primitive.targetValidAtResolution ?? ref?.validAtResolution;
  if (explicit === false) return { required: primitive.requiresTargetStillValid, status: "unavailable", reason: "target_lost_at_resolution" };
  const card = findCard(state, primitive.targetId || ref?.cardId, primitive.targetName || ref?.name);
  if (!primitive.requiresTargetStillValid) {
    const contextLost = explicit === false || (card && expectedZone && normalize(card.zone) !== normalize(expectedZone));
    return { required: false, status: contextLost ? "unavailable" : "available", reason: contextLost ? "target_lost_at_resolution" : "not_required" };
  }
  if (explicit === true && !expectedZone) return { required: true, status: "available", card };
  if (!card) return { required: true, status: "unknown", reason: "target_state_unknown" };
  if (expectedZone && (!card.zone || normalize(card.zone) === "unknown")) {
    return { required: true, status: "unknown", reason: "target_zone_unknown", card };
  }
  if (expectedZone && normalize(card.zone) !== normalize(expectedZone)) {
    return { required: true, status: "unavailable", reason: "target_lost_at_resolution", card };
  }
  return { required: true, status: "available", card };
}

function inspectRequiredSource(primitive, state) {
  const context = state.resolutionContext || {};
  const ref = primitive.source || context.source || {};
  const expectedZoneValue = primitive.sourceExpectedZone || ref.expectedZone;
  const expectedZone = normalize(expectedZoneValue) === "unknown" ? null : expectedZoneValue;
  const explicit = primitive.sourceAvailableAtResolution ?? ref.availableAtResolution;
  if (explicit === false) return { required: primitive.requiresSourceAvailable, status: "unavailable", reason: "source_unavailable_at_resolution" };
  const card = findCard(state, primitive.sourceCardId || ref.cardId, primitive.sourceCardName || ref.name);
  if (!primitive.requiresSourceAvailable) {
    const contextUnavailable = explicit === false || (card && expectedZone && normalize(card.zone) !== normalize(expectedZone));
    return { required: false, status: contextUnavailable ? "unavailable" : "available", reason: contextUnavailable ? "source_unavailable_at_resolution" : "not_required" };
  }
  if (explicit === true && !expectedZone) return { required: true, status: "available", card };
  if (!card) return { required: true, status: "unknown", reason: "source_state_unknown" };
  if (expectedZone && (!card.zone || normalize(card.zone) === "unknown")) {
    return { required: true, status: "unknown", reason: "source_zone_unknown", card };
  }
  if (expectedZone && normalize(card.zone) !== normalize(expectedZone)) {
    return { required: true, status: "unavailable", reason: "source_unavailable_at_resolution", card };
  }
  return { required: true, status: "available", card };
}

function firstFailedPrecondition(target, source) {
  if (target.required && target.status !== "available") return { kind: "target", ...target };
  if (source.required && source.status !== "available") return { kind: "source", ...source };
  return null;
}

function handlePreconditionFailure(item, precondition, steps, failedParts, ruleTrace) {
  const primitive = item.primitive;
  const uncertain = precondition.status === "unknown" || primitive.resultOnFailure === "insufficient";
  const status = uncertain ? "insufficient" : "skipped";
  steps.push({ id: item.id, primitive: primitive.type, connector: item.connector, status, reason: precondition.reason, stateChanges: [] });
  failedParts.push(partDescriptor(item, precondition.reason));
  if (precondition.kind === "target") {
    ruleTrace.push(trace(item, "target_lost_at_resolution", precondition.status, { reason: precondition.reason }));
    ruleTrace.push(trace(item, "target_part_skipped", status, { reason: precondition.reason }));
  } else {
    ruleTrace.push(trace(item, "source_unavailable_at_resolution", precondition.status, { reason: precondition.reason }));
    ruleTrace.push(trace(item, "source_dependent_part_skipped", status, { reason: precondition.reason }));
  }
  return { insufficient: uncertain };
}

function emitIndependentContinuationTrace(item, target, source, ruleTrace) {
  if (!target.required && target.status === "unavailable") {
    ruleTrace.push(trace(item, "non_target_part_continued", "continued"));
  }
  if (!source.required && source.status === "unavailable") {
    ruleTrace.push(trace(item, "source_independent_part_continued", "continued"));
  }
}

function executePrimitive(primitive, gameState) {
  const state = clone(gameState);
  const amount = positiveInteger(primitive.amount ?? primitive.count ?? 1);
  const player = primitive.player || "self";
  const target = findCard(state, primitive.targetId || primitive.target?.cardId, primitive.targetName || primitive.target?.name);
  const source = findCard(state, primitive.sourceCardId || primitive.source?.cardId || state.resolutionContext?.source?.cardId, primitive.sourceCardName || primitive.source?.name || state.resolutionContext?.source?.name);

  switch (primitive.type) {
    case "target_valid_at_resolution":
    case "source_available_at_resolution":
      return success(state, []);
    case "discard_from_hand": {
      const hand = state.hands?.[player];
      if (!Array.isArray(hand) || hand.length < amount) return insufficient("hand_contents_or_count_unknown");
      const discarded = primitive.cardIds?.length
        ? removeCardsByIds(hand, primitive.cardIds, amount)
        : hand.splice(0, amount);
      if (discarded.length < amount) return insufficient("specified_discard_cards_not_available");
      if (!state.graveyards) state.graveyards = {};
      if (!Array.isArray(state.graveyards[player])) state.graveyards[player] = [];
      state.graveyards[player].push(...discarded);
      return success(state, [{ type: "discard_from_hand", player, cardIds: discarded.map(cardId) }]);
    }
    case "return_card_to_deck":
      if (!target) return insufficient("target_state_unknown");
      return moveCard(state, target, "deck", "return_card_to_deck");
    case "special_summon_source":
      if (!source) return insufficient("source_state_unknown");
      return moveCard(state, source, primitive.destinationZone || "monster_zone", "special_summon_source", { summoned: true });
    case "place_target_as_continuous_trap":
      if (!target) return insufficient("target_state_unknown");
      return moveCard(state, target, "spell_trap_zone", "place_target_as_continuous_trap", { cardTypeOverride: "continuous_trap" });
    case "apply_damage": {
      if (!Number.isFinite(state.lp?.[player]) || !Number.isFinite(amount)) return insufficient("life_points_or_damage_amount_unknown");
      const before = state.lp[player];
      state.lp[player] = Math.max(0, before - amount);
      return success(state, [{ type: "apply_damage", player, before, after: state.lp[player], amount }]);
    }
    case "draw_cards": {
      const deck = state.decks?.[player];
      const hand = state.hands?.[player];
      if (!Array.isArray(deck) || !Array.isArray(hand) || deck.length < amount) return insufficient("deck_or_hand_contents_unknown");
      const drawn = deck.splice(0, amount);
      hand.push(...drawn);
      return success(state, [{ type: "draw_cards", player, cardIds: drawn.map(cardId), amount }]);
    }
    case "destroy_target":
      if (!target) return insufficient("target_state_unknown");
      return moveCard(state, target, "graveyard", "destroy_target", { destroyed: true });
    case "banish_target":
      if (!target) return insufficient("target_state_unknown");
      return moveCard(state, target, "banished", "banish_target", { banished: true });
    case "no_op_failed_part":
      return { status: "skipped", reason: primitive.reason || "declared_failed_part", gameState: state, stateChanges: [] };
    default:
      return insufficient("primitive_not_implemented");
  }
}

function moveCard(state, card, toZone, type, extra = {}) {
  const fromZone = card.zone || "unknown";
  card.zone = toZone;
  Object.assign(card, extra);
  return success(state, [{ type, cardId: cardId(card), fromZone, toZone }]);
}

function removeCardsByIds(hand, ids, max) {
  const wanted = new Set(ids.map(String));
  const removed = [];
  for (let index = hand.length - 1; index >= 0 && removed.length < max; index -= 1) {
    if (wanted.has(cardId(hand[index]))) removed.unshift(...hand.splice(index, 1));
  }
  return removed;
}

function findReference(refs, key) {
  if (!Array.isArray(refs)) return null;
  if (!key) return refs.length === 1 ? refs[0] : null;
  return refs.find((item) => String(item.id || item.cardId || item.name) === String(key)) || null;
}

function findCard(state, id, name) {
  return (state.cards || []).find((card) => (id && cardId(card) === String(id))
    || (name && normalize(card.name) === normalize(name))) || null;
}

function partDescriptor(item, reason) {
  return { id: item.id, primitive: item.primitive.type, connector: item.connector, reason };
}

function skippedStep(item, reason) {
  return { id: item.id, primitive: item.primitive.type, connector: item.connector, status: "skipped", reason, stateChanges: [] };
}

function trace(item, event, result, extra = {}) {
  return { step: "resolve_primitive", primitiveId: item.id, primitive: item.primitive.type, connector: item.connector, event, result, ...extra };
}

function success(gameState, stateChanges) {
  return { status: "applied", gameState, stateChanges };
}

function insufficient(reason) {
  return { status: "insufficient", reason, gameState: null, stateChanges: [] };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : NaN;
}

function cardId(card) {
  return String(card?.cardId || card?.id || card?.name || "unknown");
}

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
