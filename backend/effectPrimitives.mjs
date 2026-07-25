export const EFFECT_PRIMITIVE_TYPES = Object.freeze([
  "target_valid_at_resolution",
  "source_available_at_resolution",
  "discard_from_hand",
  "send_field_monsters_to_graveyard",
  "summon_using_activation_cost_cards",
  "fusion_summon",
  "return_target_to_hand",
  "return_lowest_defense_monster_to_hand",
  "return_card_to_deck",
  "special_summon_source",
  "set_position",
  "place_target_as_continuous_trap",
  "apply_damage",
  "draw_cards",
  "destroy_target",
  "banish_target",
  "no_op_failed_part",
]);

export const RESOLUTION_CONNECTORS = Object.freeze([
  "THEN",
  "ALSO",
  "IF_YOU_DO",
  "AND_IF_YOU_DO",
  "SIMULTANEOUS",
  "INDEPENDENT",
]);

export const PRIMITIVE_FAILURE_RESULTS = Object.freeze([
  "skip_part",
  "stop_remaining",
  "insufficient",
]);

export const EFFECT_ACTIVATION_STAGE_TYPES = Object.freeze([
  "pay_activation_cost",
  "apply_activation_action",
]);

export const DESTINATION_REPLACEMENT_TYPES = Object.freeze(["replace_destination"]);

const defaultsByType = Object.freeze({
  target_valid_at_resolution: flags(true, false, false, false, "skip_part"),
  source_available_at_resolution: flags(false, true, false, false, "skip_part"),
  discard_from_hand: flags(false, false, false, false, "insufficient"),
  send_field_monsters_to_graveyard: flags(false, false, false, false, "insufficient"),
  summon_using_activation_cost_cards: flags(false, false, false, false, "insufficient"),
  fusion_summon: flags(false, false, false, false, "insufficient"),
  return_target_to_hand: flags(true, false, false, false, "skip_part"),
  return_lowest_defense_monster_to_hand: flags(false, false, false, false, "insufficient"),
  return_card_to_deck: flags(true, false, false, false, "skip_part"),
  special_summon_source: flags(false, true, false, false, "skip_part"),
  set_position: flags(true, false, false, false, "skip_part"),
  place_target_as_continuous_trap: flags(true, false, false, false, "skip_part"),
  apply_damage: flags(false, false, false, false, "insufficient"),
  draw_cards: flags(false, false, false, false, "insufficient"),
  destroy_target: flags(true, false, false, false, "skip_part"),
  banish_target: flags(true, false, false, false, "skip_part"),
  no_op_failed_part: flags(false, false, false, true, "skip_part"),
});

export function createEffectPrimitive(type, input = {}) {
  if (!EFFECT_PRIMITIVE_TYPES.includes(type)) throw new TypeError(`unknown effect primitive: ${type}`);
  const defaults = defaultsByType[type];
  const primitive = {
    type,
    requiresTargetStillValid: booleanOr(input.requiresTargetStillValid, defaults.requiresTargetStillValid),
    requiresSourceAvailable: booleanOr(input.requiresSourceAvailable, defaults.requiresSourceAvailable),
    dependsOnPreviousSuccess: booleanOr(input.dependsOnPreviousSuccess, defaults.dependsOnPreviousSuccess),
    optional: booleanOr(input.optional, defaults.optional),
    resultOnFailure: PRIMITIVE_FAILURE_RESULTS.includes(input.resultOnFailure)
      ? input.resultOnFailure
      : defaults.resultOnFailure,
  };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !Object.prototype.hasOwnProperty.call(primitive, key)) primitive[key] = clone(value);
  }
  if (input.connector && !RESOLUTION_CONNECTORS.includes(input.connector)) {
    throw new TypeError(`unknown resolution connector: ${input.connector}`);
  }
  return primitive;
}

export function createDestinationReplacement(input = {}) {
  const type = input.type || "replace_destination";
  if (!DESTINATION_REPLACEMENT_TYPES.includes(type)) {
    throw new TypeError(`unknown destination replacement: ${type}`);
  }
  const intendedToZone = input.intendedToZone || input.intendedZone;
  const replacementToZone = input.replacementToZone || input.actualToZone || input.replacementZone;
  if (!intendedToZone || !replacementToZone) {
    throw new TypeError("destination replacement requires intendedToZone and replacementToZone");
  }
  const replacement = {
    type,
    intendedToZone: String(intendedToZone),
    replacementToZone: String(replacementToZone),
    destinationPlayerRelation: input.destinationPlayerRelation || "any",
  };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !Object.prototype.hasOwnProperty.call(replacement, key)) replacement[key] = clone(value);
  }
  return replacement;
}

export function normalizeDestinationReplacements(effect = {}) {
  const replacements = Array.isArray(effect.destinationReplacements)
    ? effect.destinationReplacements
    : [];
  return replacements.map((replacement) => createDestinationReplacement(replacement));
}

export function normalizePrimitiveSequence(sequence = []) {
  if (!Array.isArray(sequence)) throw new TypeError("primitive sequence must be an array");
  return sequence.map((entry, index) => {
    const wrapper = entry?.primitive ? entry : { primitive: entry };
    const primitive = createEffectPrimitive(wrapper.primitive?.type, wrapper.primitive || {});
    const connector = index === 0
      ? "INDEPENDENT"
      : wrapper.connector || primitive.connector || "INDEPENDENT";
    if (!RESOLUTION_CONNECTORS.includes(connector)) throw new TypeError(`unknown resolution connector: ${connector}`);
    return {
      id: wrapper.id || primitive.id || `primitive_${index + 1}`,
      connector,
      primitive: { ...primitive, connector: undefined },
    };
  });
}

export function normalizeEffectActivationStages(link = {}) {
  const costSequence = firstArray(
    link.costSequence,
    link.activationCostSequence,
    link.activationCosts,
  );
  const actionSequence = firstArray(
    link.activationSequence,
    link.activationActionSequence,
    link.activationActions,
  );
  return [
    { stage: "pay_activation_cost", sequence: normalizePrimitiveSequence(costSequence) },
    { stage: "apply_activation_action", sequence: normalizePrimitiveSequence(actionSequence) },
  ].filter((item) => item.sequence.length);
}

export function connectorDependsOnPreviousSuccess(connector) {
  return ["THEN", "IF_YOU_DO", "AND_IF_YOU_DO"].includes(connector);
}

function flags(requiresTargetStillValid, requiresSourceAvailable, dependsOnPreviousSuccess, optional, resultOnFailure) {
  return { requiresTargetStillValid, requiresSourceAvailable, dependsOnPreviousSuccess, optional, resultOnFailure };
}

function booleanOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
