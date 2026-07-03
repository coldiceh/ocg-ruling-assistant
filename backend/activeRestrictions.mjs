export const RESTRICTION_TYPES = Object.freeze([
  "cannot_activate",
  "cannot_target",
  "cannot_apply",
]);

/**
 * Matches a structured candidate effect against one active restriction.
 * Unknown facts never match positively: callers must keep them as assumptions
 * or return insufficient information instead of guessing.
 */
export function matchesRestriction(effect = {}, state = {}, restriction = {}) {
  if (!restriction || restriction.active === false) return false;
  if (!RESTRICTION_TYPES.includes(restriction.restrictionType)) return false;
  if (!isDurationActive(restriction.duration, state)) return false;

  const appliesTo = restriction.appliesTo || {};
  return Object.entries(appliesTo).every(([field, expected]) => {
    if (expected === undefined || expected === null || expected === "any") return true;
    if (field.endsWith("Not")) {
      const actual = readEffectFact(effect, field.slice(0, -3));
      return isKnown(actual) && !matchesValue(actual, expected);
    }
    const actual = readEffectFact(effect, field);
    return isKnown(actual) && matchesValue(actual, expected);
  });
}

export function findMatchingRestrictions(effect = {}, state = {}) {
  return (state.activeRestrictions || []).filter((restriction) =>
    matchesRestriction(effect, state, restriction)
  );
}

function readEffectFact(effect, field) {
  if (Object.prototype.hasOwnProperty.call(effect, field)) return effect[field];
  if (Object.prototype.hasOwnProperty.call(effect.card || {}, field)) return effect.card[field];
  return effect.metadata?.[field];
}

function isDurationActive(duration, state) {
  if (!duration || duration === "while_source_active" || duration === "continuous") return true;
  if (duration === "this_turn") return state.turnEnded !== true;
  if (duration === "until_end_phase") return state.phase !== "AFTER_END_PHASE";
  if (typeof duration === "object" && duration.expiresAt) {
    return String(state.timing || state.phase || "") !== String(duration.expiresAt);
  }
  return true;
}

function matchesValue(actual, expected) {
  if (typeof expected === "string" && expected.includes("|")) {
    return expected.split("|").map((item) => item.trim()).some((item) => item === "any" || matchesValue(actual, item));
  }
  if (Array.isArray(expected)) return expected.some((item) => matchesValue(actual, item));
  if (Array.isArray(actual)) return actual.some((item) => matchesValue(item, expected));
  return normalize(actual) === normalize(expected);
}

function isKnown(value) {
  return value !== undefined && value !== null && value !== "" && value !== "unknown";
}

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}
