export function selectBranchForSubQuestion(subQuestion, evidenceBranches, gameState, derivedStateAtTiming = null) {
  const branches = Array.isArray(evidenceBranches?.branches) ? evidenceBranches.branches : Array.isArray(evidenceBranches) ? evidenceBranches : [];
  const baseEntity = findEntity(subQuestion?.card, gameState?.entities || []);
  const entity = applyTimelineState(baseEntity, derivedStateAtTiming);
  const contradictions = (gameState?.contradictions || []).filter((item) => !entity || String(item).includes(entity.name));
  if (contradictions.length) {
    return result(null, "contradiction", "unknown", [], contradictions, `contradiction:${contradictions.join(",")}`);
  }
  if (!branches.length) return result(null, "no_matching_branch", "unknown", [], [], "no_condition_branches");
  if (!entity) return result(null, "missing_state", "unknown", ["entity_state"], [], "missing_state:entity_state");

  const evaluated = branches.map((branch) => evaluateBranch(branch, entity, gameState?.timing || {}));
  const exact = evaluated.filter((item) => item.conflicts.length === 0 && item.missing.length === 0);
  const possible = evaluated.filter((item) => item.conflicts.length === 0);
  if (exact.length === 1 && possible.length === 1) {
    return result(exact[0].branch, "selected", exact[0].branch.verdict, [], [], `selected:${exact[0].branch.verdict}`);
  }
  if (exact.length > 1) {
    return result(null, "ambiguous", "unknown", [], [], `ambiguous:${exact.map((item) => item.branch.verdict).join(",")}`);
  }
  if (possible.length) {
    const missing = [...new Set(possible.flatMap((item) => item.missing))];
    const status = possible.length > 1 && missing.length === 0 ? "ambiguous" : "missing_state";
    return result(null, status, "unknown", missing, [], `${status}:${missing.join(",")}`);
  }
  const conflicts = [...new Set(evaluated.flatMap((item) => item.conflicts))];
  return result(null, "no_matching_branch", "unknown", [], conflicts, `no_matching_branch:${conflicts.join(",")}`);
}

function applyTimelineState(entity, derived) {
  if (!entity || !derived) return entity;
  const next = { ...entity };
  if (derived.battleDestroyedStatus === "destroyed") next.wasDestroyedByBattle = true;
  if (derived.battleDestroyedStatus === "not_destroyed") next.wasDestroyedByBattle = false;
  if (derived.zoneStatus === "in_graveyard") {
    next.currentZone = "graveyard";
    next.wasSentToGraveyard = true;
    next.wasBanished = false;
    next.remainsOnField = false;
  } else if (derived.zoneStatus === "banished") {
    next.currentZone = "banished";
    next.wasSentToGraveyard = false;
    next.wasBanished = true;
    next.remainsOnField = false;
  } else if (derived.zoneStatus === "on_field") {
    next.currentZone = "monster_zone";
    next.wasSentToGraveyard = false;
    next.wasBanished = false;
    next.remainsOnField = true;
  } else if (derived.zoneStatus === "pending_send_to_graveyard") {
    next.currentZone = "unknown";
    next.wasSentToGraveyard = null;
    next.wasBanished = null;
    next.remainsOnField = null;
  }
  return next;
}

function evaluateBranch(branch, entity, timing) {
  const missing = [];
  const conflicts = [];
  for (const condition of branch.normalizedConditions || []) {
    const value = conditionValue(condition, entity, timing);
    if (value === null) missing.push(condition);
    else if (value === false) conflicts.push(condition);
  }
  return { branch, missing, conflicts };
}

function conditionValue(condition, entity, timing) {
  if (condition === "not_destroyed_by_battle") return invert(entity.wasDestroyedByBattle);
  if (condition === "destroyed_by_battle") return entity.wasDestroyedByBattle;
  if (condition === "sent_to_graveyard") return entity.wasSentToGraveyard;
  if (condition === "banished") return entity.wasBanished;
  if (condition === "remains_on_field") return entity.remainsOnField;
  if (condition === "monster_zone") return zoneValue(entity.currentZone, "monster_zone");
  if (condition === "graveyard") return zoneValue(entity.currentZone, "graveyard");
  if (condition === "banished_zone") return zoneValue(entity.currentZone, "banished");
  if (condition === "timing_damage_step_end") return timing.isEndOfDamageStep ?? null;
  if (condition === "effect_negated" || condition === "unknown") return null;
  return null;
}

function zoneValue(currentZone, expected) {
  if (!currentZone || currentZone === "unknown") return null;
  return currentZone === expected;
}

function invert(value) {
  return value === null || value === undefined ? null : !value;
}

function findEntity(card, entities) {
  const wanted = normalize(card);
  if (!wanted || wanted === "unknown") return null;
  return entities.find((entity) => {
    const name = normalize(entity.name);
    return name === wanted || name.includes(wanted) || wanted.includes(name);
  }) || null;
}

function result(selectedBranch, status, verdict, missingConditions, conflictingConditions, reason) {
  return { selectedBranch, status, verdict, missingConditions, conflictingConditions, reason };
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
