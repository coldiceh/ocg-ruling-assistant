/**
 * A lingering effect created by an already-resolved activated effect is an
 * effect instance, not a continuous effect of the card that activated it.
 *
 * In particular, text such as “while the monster Special Summoned by this
 * effect is face-up on your field” creates a one-way lifetime:
 *   active -> expired
 * Once the bound monster stops satisfying the condition, the same effect
 * instance does not become active again when the card later returns.
 */
export function createBoundLingeringEffectInstance({
  id,
  sourceEffectId = "",
  boundInstanceIds = [],
  controller = "self",
  zone = "monster_zone",
  faceUp = true,
  match = "any",
  restriction = {},
  createdAt = "effect_resolution",
} = {}) {
  const ids = unique(boundInstanceIds);
  if (!ids.length) throw new TypeError("bound lingering effect requires at least one bound card instance");
  return {
    id: String(id || `${sourceEffectId || "effect"}:lingering`),
    sourceEffectId: String(sourceEffectId || ""),
    kind: "bound_lingering_restriction",
    status: "active",
    createdAt,
    binding: {
      instanceIds: ids,
      condition: {
        type: "bound_card_in_controller_zone",
        controller: String(controller || "self"),
        zone: String(zone || "monster_zone"),
        faceUp: typeof faceUp === "boolean" ? faceUp : null,
        match: match === "all" ? "all" : "any",
      },
    },
    expiration: {
      mode: "irreversible_on_first_condition_failure",
      reactivates: false,
    },
    restriction: clone(restriction),
  };
}

export function advanceEffectInstanceLifecycles(gameState = {}, {
  timing = "state_update",
  cause = "state_changed",
} = {}) {
  const state = clone(gameState);
  if (!Array.isArray(state.effectInstances)) state.effectInstances = [];
  const trace = [];

  for (const effect of state.effectInstances) {
    if (effect?.kind !== "bound_lingering_restriction") continue;
    if (effect.status === "expired") {
      trace.push({
        phase: "effect_instance_lifecycle",
        effectInstanceId: effect.id,
        before: "expired",
        after: "expired",
        result: "remains_expired",
        timing,
        cause,
      });
      continue;
    }

    const applicability = evaluateBoundCondition(effect, state);
    if (applicability === null) {
      return {
        gameState: state,
        complete: false,
        reason: "bound_effect_lifecycle_state_unknown",
        trace,
      };
    }
    if (applicability) {
      effect.status = "active";
      trace.push({
        phase: "effect_instance_lifecycle",
        effectInstanceId: effect.id,
        before: "active",
        after: "active",
        result: "condition_still_met",
        timing,
        cause,
      });
      continue;
    }

    const before = effect.status || "active";
    effect.status = "expired";
    effect.expiredAt = timing;
    effect.expiredBy = cause;
    trace.push({
      phase: "effect_instance_lifecycle",
      effectInstanceId: effect.id,
      before,
      after: "expired",
      result: "condition_failed_irreversibly",
      timing,
      cause,
    });
  }

  return { gameState: state, complete: true, reason: "effect_instances_stable", trace };
}

export function activeLingeringRestrictions(gameState = {}) {
  return (gameState.effectInstances || [])
    .filter((effect) => effect?.kind === "bound_lingering_restriction" && effect.status === "active")
    .map((effect) => ({
      effectInstanceId: effect.id,
      sourceEffectId: effect.sourceEffectId,
      ...clone(effect.restriction || {}),
    }));
}

function evaluateBoundCondition(effect, state) {
  const condition = effect.binding?.condition || {};
  const ids = unique(effect.binding?.instanceIds || []);
  if (!ids.length) return null;
  const matches = [];
  for (const id of ids) {
    const card = (state.cards || []).find((candidate) => cardInstanceId(candidate) === id);
    if (!card) {
      matches.push(false);
      continue;
    }
    if (!known(card.zone) || !known(card.controller)) return null;
    if (typeof condition.faceUp === "boolean" && typeof card.faceUp !== "boolean") return null;
    matches.push(
      normalize(card.zone) === normalize(condition.zone)
      && normalize(card.controller) === normalize(condition.controller)
      && (typeof condition.faceUp !== "boolean" || card.faceUp === condition.faceUp),
    );
  }
  return condition.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

function cardInstanceId(card) {
  return String(
    card?.instanceId
    || card?.cardInstanceId
    || card?.entityId
    || card?.uid
    || card?.cardId
    || card?.id
    || card?.name
    || "unknown",
  );
}

function known(value) {
  const text = normalize(value);
  return Boolean(text && text !== "unknown");
}

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
