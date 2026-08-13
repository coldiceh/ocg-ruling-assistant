import {
  canonicalLegacyLuaSha256,
  validateLegacyLuaSemanticPacket,
} from "./legacyLuaSemanticPacket.mjs";

export const LEGACY_LUA_PROMPT_MODULE_VERSION =
  "ocg-assistant-legacy-lua-prompt-module/v2";
export const LEGACY_LUA_PROMPT_PAYLOAD_SCHEMA =
  "ocg-assistant-legacy-lua-prompt-hints/v2";

const DEFAULT_MAX_BYTES = 8 * 1024;
const MAX_EFFECT_HINTS = 12;
const MAX_CHECKS_PER_EFFECT = 8;
const MAX_LIST_ITEMS = 32;
const MAX_EXPRESSION_NODES = 64;
const MAX_EXPRESSION_DEPTH = 10;

const PHASES = new Map([
  ["CONDITION", "CONDITION"],
  ["COST", "COST"],
  ["TARGET", "TARGET"],
  ["OPERATION", "RESOLUTION"],
  ["RESOLUTION", "RESOLUTION"],
]);

// These are the versioned compiler operations currently understood well
// enough to be useful as neutral reminders. Unknown operations are omitted;
// accepting a string merely because it looks like an enum would silently turn
// future compiler output into model instructions.
const ATOMIC_OPERATIONS = new Set([
  "DESTROY",
  "RETURN_TO_HAND",
  "SPECIAL_SUMMON",
]);

const PREDICATE_APIS = new Set([
  "Card.IsAbleToHand",
  "Card.IsCanBeSpecialSummoned",
]);

const SELECTOR_APIS = new Set([
  "Duel.IsExistingMatchingCard",
]);

const API_HINTS = new Set([
  ...PREDICATE_APIS,
  ...SELECTOR_APIS,
  "Card.IsLocation",
  "Card.IsPosition",
  "Card.IsType",
  "Card.IsAttribute",
  "Card.IsCode",
  "Card.IsFaceup",
  "Card.IsRelateToChain",
  "Duel.BreakEffect",
  "Duel.Destroy",
  "Duel.GetLocationCount",
  "Duel.GetLocationCountFromEx",
  "Duel.GetMatchingGroup",
  "Duel.IsPlayerCanSpecialSummon",
  "Duel.SendtoHand",
  "Duel.SetOperationInfo",
  "Duel.SpecialSummon",
  "Effect.GetLabel",
  "Effect.IsActiveType",
  "Effect.SetLabel",
  "Group.GetCount",
]);

// Expression nodes are conditions, not execution steps. Keep mutating Duel
// APIs out of this narrower set even though their names may be useful in the
// top-level operation summary.
const EXPRESSION_APIS = new Set([
  ...PREDICATE_APIS,
  ...SELECTOR_APIS,
  "Card.IsLocation",
  "Card.IsPosition",
  "Card.IsType",
  "Card.IsAttribute",
  "Card.IsCode",
  "Card.IsFaceup",
  "Duel.GetLocationCount",
  "Duel.GetLocationCountFromEx",
  "Duel.IsPlayerCanSpecialSummon",
  "Effect.IsActiveType",
  "Internal.SameDefinitionAsSource",
]);

const DEPENDENCIES = new Set([
  "CARD_CAN_RETURN_TO_HAND",
  "CHECK_CARD_SUMMON_ELIGIBILITY",
  "CHECK_CARD_STATUS",
  "CHECK_DESTINATION_LEGALITY",
  "CHECK_EFFECT_RESTRICTION",
  "CHECK_PLAYER_RESTRICTION",
  "CHECK_REPLACEMENT_EFFECT",
  "CHECK_REQUIRED_MINIMUM",
  "CHECK_ZONE_CAPACITY",
  "ENUMERATE_CANDIDATES",
]);

const NON_SEMANTIC_UNKNOWN_REASON = "LEGACY_SOURCE_NON_AUTHORITATIVE";

const SYMBOLS = new Set([
  "LOCATION_DECK",
  "LOCATION_EXTRA",
  "LOCATION_GRAVE",
  "LOCATION_HAND",
  "LOCATION_MZONE",
  "LOCATION_ONFIELD",
  "LOCATION_REMOVED",
  "LOCATION_SZONE",
  "POS_FACEDOWN",
  "POS_FACEDOWN_DEFENSE",
  "POS_FACEUP",
  "POS_FACEUP_ATTACK",
  "POS_FACEUP_DEFENSE",
  "TYPE_EFFECT",
  "TYPE_FUSION",
  "TYPE_LINK",
  "TYPE_MONSTER",
  "TYPE_NORMAL",
  "TYPE_RITUAL",
  "TYPE_SPELL",
  "TYPE_SYNCHRO",
  "TYPE_TRAP",
  "TYPE_XYZ",
]);

const VARIABLE_ROLES = new Map([
  ["CARD", "CANDIDATE"],
  ["EFFECT", "EFFECT"],
  ["FILTER_CARD", "CANDIDATE"],
  ["RESPONDING_EFFECT", "RESPONDING_EFFECT"],
  ["SOURCE_CARD", "SOURCE_CARD"],
  ["TARGET", "TARGET"],
  ["TARGET_CARD", "TARGET"],
  ["PLAYER", "ACTIVATING_PLAYER"],
]);

const SUBJECT_ROLES = new Map([
  ["CARD", "CANDIDATE"],
  ["FILTER_CARD", "CANDIDATE"],
  ["SOURCE_CARD", "SOURCE_CARD"],
  ["TARGET", "TARGET"],
  ["TARGET_CARD", "TARGET"],
]);

const COMPARISON_OPERATORS = new Map([
  ["==", "EQUAL"],
  ["~=", "NOT_EQUAL"],
  [">", "GREATER_THAN"],
  [">=", "GREATER_THAN_OR_EQUAL"],
  ["<", "LESS_THAN"],
  ["<=", "LESS_THAN_OR_EQUAL"],
]);

const PROMPT_INSTRUCTIONS = [
  "以下 legacyLuaPromptHints 仅是从锁定 Lua 脚本静态提取的结构提醒，不是证据、裁定或执行结果。",
  "它只提示仍需核对的阶段、条件与操作；字段存在或缺失、minimumCount 和 API 名称都不能证明题面条件已经满足或未满足。",
  "coverage.complete=false 表示仍有无法安全理解的效果；unknownEffectCount 是这类效果数量。列表只可作正向核对提醒，严禁依据未列出的字段、效果或 API 推断某条件不存在、某效果不能处理，或据此支持任何肯定/否定裁定。",
  "必须用题面、卡文和可见规则资料独立判断；不得把本模块加入 usedEvidence。与卡文或官方资料冲突时，以卡文和官方资料为准。",
].join("\n");

/**
 * Builds an optional, strictly allowlisted prompt addon from an untruncated
 * audit packet. Complete candidates may be emitted as positive reminders even
 * when other candidates are explicitly TYPED_UNKNOWN; the resulting payload
 * declares incomplete coverage and forbids negative inference. The module is
 * disabled by default and never exposes analysis output,
 * source text, hashes, semantic identities, traces or candidate outcomes to the
 * model. Every failure degrades to the byte-identical no-addon baseline.
 */
export function buildLegacyLuaPromptModule({
  packet = null,
  resolvedCards = [],
  enabled = false,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (enabled !== true) return unavailableResult("DISABLED", "DISABLED");

  const byteLimit = normalizeByteLimit(maxBytes);
  if (byteLimit === null) {
    return unavailableResult("UNAVAILABLE", "INVALID_CONFIGURATION");
  }

  let validated;
  try {
    validated = validateLegacyLuaSemanticPacket(packet);
  } catch {
    return unavailableResult("UNAVAILABLE", packet ? "INVALID_PACKET" : "NO_PACKET");
  }

  const sourcePacketSha256 = validated.packetSha256;
  if (!isUntruncatedConsistentPacket(validated)) {
    return unavailableResult("UNAVAILABLE", "INCOMPLETE_PACKET", {
      sourcePacketSha256,
      omittedHintCount: Number(validated.truncation?.omittedCandidateCount || 0),
    });
  }
  const resourcesById = new Map(
    validated.resources.map((resource) => [resource.resourceId, resource]),
  );
  const cardBindings = bindResourcesToResolvedCards(
    validated.resources,
    resolvedCards,
  );
  if (!cardBindings) {
    return unavailableResult("UNAVAILABLE", "INCOMPLETE_CARD_BINDING", {
      sourcePacketSha256,
    });
  }
  const projectionState = {
    partial: false,
    omittedHintCount: 0,
  };
  const entries = [];
  const unknownByResource = new Map();

  for (const candidate of validated.effectCandidates) {
    const resource = resourcesById.get(candidate.resourceId);
    const card = cardBindings.get(candidate.resourceId);
    if (!resource || !card) {
      return unavailableResult("UNAVAILABLE", "INCOMPLETE_CARD_BINDING", {
        sourcePacketSha256,
      });
    }
    if (candidate.kind === "TYPED_UNKNOWN") {
      unknownByResource.set(
        candidate.resourceId,
        (unknownByResource.get(candidate.resourceId) || 0) + 1,
      );
      continue;
    }
    const plan = candidate?.semanticArtifact?.plan;
    if (
      candidate.kind !== "CANDIDATE"
      || candidate?.semanticArtifact?.kind !== "CANDIDATE"
      || !isPlainObject(plan)
      || !isCompleteKnownCandidate(candidate)
    ) {
      return unavailableResult("UNAVAILABLE", "INCOMPLETE_CANDIDATE", {
        sourcePacketSha256,
        omittedHintCount: projectionState.omittedHintCount + 1,
      });
    }
    const effect = projectEffectHint(plan, projectionState);
    if (!effect || projectionState.partial) {
      return unavailableResult("UNAVAILABLE", "INCOMPLETE_SAFE_PROJECTION", {
        sourcePacketSha256,
        omittedHintCount: Math.max(1, projectionState.omittedHintCount),
      });
    }
    entries.push({
      sortKey: `${card.cid}\u0000${candidate.semanticEffectIdentity}`,
      resourceId: candidate.resourceId,
      card,
      effect,
    });
  }

  entries.sort((left, right) => stableCompare(left.sortKey, right.sortKey));
  if (entries.length > MAX_EFFECT_HINTS) {
    return unavailableResult("UNAVAILABLE", "CAPACITY", {
      sourcePacketSha256,
      omittedHintCount: entries.length - MAX_EFFECT_HINTS,
    });
  }
  if (entries.length === 0) {
    return unavailableResult("UNAVAILABLE", "NO_SAFE_HINT", {
      sourcePacketSha256,
      omittedHintCount: projectionState.omittedHintCount,
    });
  }

  // A known candidate must still be projected in full. In contrast, a
  // TYPED_UNKNOWN candidate is never projected at all: it is represented only
  // by the explicit coverage count and the negative-inference prohibition.
  if (projectionState.partial) {
    return unavailableResult("UNAVAILABLE", "PARTIAL_COVERAGE", {
      sourcePacketSha256,
      omittedHintCount: projectionState.omittedHintCount,
    });
  }

  const unknownEffectCount = [...unknownByResource.values()]
    .reduce((sum, count) => sum + count, 0);
  const payload = buildModelPayload(entries, unknownByResource, cardBindings);
  const promptAddon = `${PROMPT_INSTRUCTIONS}\nlegacyLuaPromptHints:\n${JSON.stringify(payload)}`;
  if (Buffer.byteLength(promptAddon, "utf8") <= byteLimit) {
    return freezeResult({
      status: "READY",
      promptAddon,
      modelPayload: payload,
      audit: {
        moduleVersion: LEGACY_LUA_PROMPT_MODULE_VERSION,
        sourcePacketSha256,
        payloadSha256: canonicalLegacyLuaSha256(payload),
        includedHintCount: entries.length,
        omittedHintCount: unknownEffectCount,
        reasonCategory: unknownEffectCount > 0
          ? "AVAILABLE_PARTIAL_COVERAGE"
          : "AVAILABLE",
      },
    });
  }

  return unavailableResult("UNAVAILABLE", "CAPACITY", {
    sourcePacketSha256,
    omittedHintCount: projectionState.omittedHintCount,
  });
}

function isUntruncatedConsistentPacket(packet) {
  const includedByResource = new Map();
  for (const candidate of packet?.effectCandidates || []) {
    includedByResource.set(
      candidate.resourceId,
      (includedByResource.get(candidate.resourceId) || 0) + 1,
    );
  }
  return Array.isArray(packet?.resources)
    && packet.resources.length > 0
    && Array.isArray(packet.effectCandidates)
    && packet.effectCandidates.length > 0
    && Array.isArray(packet.unknownReasons)
    && unknownReasonsAreCovered(
      packet.unknownReasons,
      packet.effectCandidates.some((candidate) => candidate.kind === "TYPED_UNKNOWN"),
    )
    && Array.isArray(packet.omittedCandidates)
    && packet.omittedCandidates.length === 0
    && packet.truncation?.applied === false
    && packet.truncation?.budgetSatisfied === true
    && packet.truncation?.omittedCandidateCount === 0
    && packet.truncation?.includedCandidateCount === packet.truncation?.totalCandidateCount
    && packet.effectCandidates.length === packet.truncation?.totalCandidateCount
    && packet.resources.every((resource) => (
      (resource.status === "READY" || resource.status === "TYPED_UNKNOWN")
      && Array.isArray(resource.unknownReasons)
      && unknownReasonsAreCovered(
        resource.unknownReasons,
        packet.effectCandidates.some((candidate) => (
          candidate.resourceId === resource.resourceId
          && candidate.kind === "TYPED_UNKNOWN"
        )),
      )
      && Number.isSafeInteger(resource.candidateCount)
      && resource.candidateCount > 0
      && includedByResource.get(resource.resourceId) === resource.candidateCount
      && resourceHasCompleteBindingsForKnownCandidates(resource, packet.effectCandidates)
    ));
}

function resourceHasCompleteBindingsForKnownCandidates(resource, candidates) {
  const hasKnownCandidate = candidates.some((candidate) => (
    candidate.resourceId === resource.resourceId
    && candidate.kind === "CANDIDATE"
  ));
  if (!hasKnownCandidate) return true;
  return isPlainObject(resource.engineBinding)
    && isPlainObject(resource.registryBinding)
    && typeof resource.candidateSetSha256 === "string"
    && Object.values(resource.resourceBinding || {}).every((value) => value !== null);
}

function isCompleteKnownCandidate(candidate) {
  const artifactReasons = candidate?.semanticArtifact?.unknownReasons;
  const unresolvedSemantics = candidate?.semanticArtifact?.plan?.unresolvedSemantics;
  return hasOnlyNonSemanticBoundaryReasons(candidate.unknownReasons)
    && (artifactReasons === undefined
      || hasOnlyNonSemanticBoundaryReasons(artifactReasons))
    && (unresolvedSemantics === undefined
      || (Array.isArray(unresolvedSemantics) && unresolvedSemantics.length === 0));
}

function hasOnlyNonSemanticBoundaryReasons(reasons) {
  return Array.isArray(reasons)
    && reasons.every((reason) => reason?.code === NON_SEMANTIC_UNKNOWN_REASON);
}

function unknownReasonsAreCovered(reasons, hasTypedUnknownCandidate) {
  return hasOnlyNonSemanticBoundaryReasons(reasons)
    || hasTypedUnknownCandidate === true;
}

function projectEffectHint(plan, state) {
  if (
    !Array.isArray(plan.costAtomicOperations)
    || !Array.isArray(plan.atomicOperations)
    || !Array.isArray(plan.operationApis)
    || !Array.isArray(plan.requiredLegacyApis)
    || !Array.isArray(plan.activationLegalityChecks)
  ) {
    state.partial = true;
    return null;
  }
  const costOperations = projectEnumList(
    plan.costAtomicOperations,
    ATOMIC_OPERATIONS,
    state,
  );
  const resolutionOperations = projectEnumList(
    plan.atomicOperations,
    ATOMIC_OPERATIONS,
    state,
  );
  const apiCalls = projectEnumList([
    ...(Array.isArray(plan.operationApis) ? plan.operationApis : []),
    ...(Array.isArray(plan.requiredLegacyApis) ? plan.requiredLegacyApis : []),
  ], API_HINTS, state);
  const sourceChecks = plan.activationLegalityChecks;
  const activationChecks = [];
  for (const check of sourceChecks.slice(0, MAX_CHECKS_PER_EFFECT)) {
    const projected = projectActivationCheck(check, state);
    if (projected) activationChecks.push(projected);
    else omitHint(state);
  }
  if (sourceChecks.length > MAX_CHECKS_PER_EFFECT) {
    state.partial = true;
    state.omittedHintCount += sourceChecks.length - MAX_CHECKS_PER_EFFECT;
  }

  // An API name without an operation or a complete legality check is too
  // context-free to be a useful reminder. Do not let it create an addon by
  // itself.
  if (
    costOperations.length === 0
    && resolutionOperations.length === 0
    && activationChecks.length === 0
  ) return null;

  return compactObject({
    costOperations,
    resolutionOperations,
    apiCalls,
    activationChecks,
  });
}

function projectActivationCheck(check, state) {
  if (!isPlainObject(check)) return null;
  const phase = PHASES.get(String(check.callbackSlot || ""));
  const predicateApi = PREDICATE_APIS.has(check.predicateApi)
    ? check.predicateApi
    : null;
  const atomicOperation = ATOMIC_OPERATIONS.has(check.atomicOperation)
    ? check.atomicOperation
    : null;
  const minimumCount = check.requiredMinimum;
  if (
    !phase
    || !predicateApi
    || !atomicOperation
    || !Number.isSafeInteger(minimumCount)
    || minimumCount < 0
    || minimumCount > 99
  ) return null;

  let subjectRole;
  if (check.predicateSubject !== undefined && check.predicateSubject !== null) {
    subjectRole = projectSubjectRole(check.predicateSubject);
    if (!subjectRole) return null;
  }

  let selector;
  if (check.selector !== undefined && check.selector !== null) {
    selector = projectSelector(check.selector, minimumCount);
    if (!selector) return null;
  }

  const dependencies = projectEnumList(
    dependencyEntries(check.dependencyGraph),
    DEPENDENCIES,
    state,
  );
  return compactObject({
    phase,
    predicateApi,
    atomicOperation,
    minimumCount,
    dependencies,
    subjectRole,
    selector,
  });
}

function projectSelector(selector, expectedMinimum) {
  if (!isPlainObject(selector) || !SELECTOR_APIS.has(selector.api)) return null;
  if (Object.keys(selector).some((key) => !new Set([
    "api",
    "player",
    "controllerLocation",
    "opponentLocation",
    "requiredMinimum",
    "filter",
    "filterArguments",
    "exception",
  ]).has(key))) return null;
  if (
    selector.requiredMinimum !== undefined
    && selector.requiredMinimum !== expectedMinimum
  ) return null;

  const output = { selectorApi: selector.api };
  for (const [sourceKey, targetKey] of [
    ["player", "player"],
    ["controllerLocation", "controllerLocation"],
    ["opponentLocation", "opponentLocation"],
    ["exception", "exception"],
  ]) {
    if (selector[sourceKey] === undefined || selector[sourceKey] === null) continue;
    const projected = projectExpression(selector[sourceKey]);
    if (!projected) return null;
    output[targetKey] = projected;
  }

  if (selector.filter !== undefined && selector.filter !== null) {
    let filter = selector.filter;
    if (isPlainObject(filter) && filter.kind === "LAMBDA") {
      if (
        Object.keys(filter).some((key) => !new Set([
          "kind",
          "parameters",
          "body",
        ]).has(key))
        || !Array.isArray(filter.parameters)
        || filter.parameters.length === 0
        || filter.parameters.length > 8
      ) return null;
      const parameterRoles = filter.parameters.map((name) => (
        VARIABLE_ROLES.get(String(name || ""))
        || (/^FILTER_ARGUMENT_[1-8]$/u.test(String(name || ""))
          ? String(name)
          : null)
      ));
      if (parameterRoles.some((role) => role === null)) return null;
      output.filterParameterRoles = parameterRoles;
      filter = filter.body;
    }
    const projected = projectExpression(filter);
    if (!projected) return null;
    output.filterExpression = projected;
  }

  if (selector.filterArguments !== undefined) {
    if (
      !Array.isArray(selector.filterArguments)
      || selector.filterArguments.length > 8
    ) return null;
    const projected = selector.filterArguments.map(projectExpression);
    if (projected.some((item) => !item)) return null;
    if (projected.length > 0) output.filterArguments = projected;
  }

  return output;
}

function projectExpression(value) {
  const state = { nodes: 0 };
  const projected = projectExpressionNode(value, state, 0);
  return projected.ok ? projected.value : null;
}

function projectExpressionNode(value, state, depth) {
  if (
    !isPlainObject(value)
    || depth > MAX_EXPRESSION_DEPTH
    || state.nodes >= MAX_EXPRESSION_NODES
  ) return expressionFailure();
  state.nodes += 1;
  const kind = String(value.kind || "");

  if (kind === "VARIABLE") {
    const rawName = String(value.name || "");
    const role = VARIABLE_ROLES.get(rawName)
      || (/^FILTER_ARGUMENT_[1-8]$/u.test(rawName) ? rawName : null);
    return role
      ? expressionSuccess({ kind: "ROLE", value: role })
      : expressionFailure();
  }
  if (kind === "SYMBOL") {
    return SYMBOLS.has(value.name)
      ? expressionSuccess({ kind: "SYMBOL", value: value.name })
      : expressionFailure();
  }
  if (kind === "LITERAL") {
    const literal = value.value;
    if (literal === null || typeof literal === "boolean") {
      return expressionSuccess({ kind: "LITERAL", value: literal });
    }
    if (
      Number.isSafeInteger(literal)
      && literal >= -0x7fff_ffff
      && literal <= 0x7fff_ffff
    ) return expressionSuccess({ kind: "LITERAL", value: literal });
    return expressionFailure();
  }
  if (kind === "CALL") {
    if (!EXPRESSION_APIS.has(value.api) || !Array.isArray(value.arguments)
        || value.arguments.length > 8) return expressionFailure();
    const args = projectExpressionArray(value.arguments, state, depth + 1);
    return args
      ? expressionSuccess({ kind: "CALL", api: value.api, arguments: args })
      : expressionFailure();
  }
  if (kind === "NOT") {
    const argument = projectExpressionNode(value.argument, state, depth + 1);
    return argument.ok
      ? expressionSuccess({ kind: "NOT", argument: argument.value })
      : expressionFailure();
  }
  if (kind === "LUA_AND" || kind === "LUA_OR") {
    const terms = projectExpressionArray(
      [value.left, value.right],
      state,
      depth + 1,
    );
    return terms
      ? expressionSuccess({ kind: kind === "LUA_AND" ? "AND" : "OR", terms })
      : expressionFailure();
  }
  if (kind === "ALL" || kind === "ANY") {
    if (!Array.isArray(value.terms) || value.terms.length === 0
        || value.terms.length > 12) return expressionFailure();
    const terms = projectExpressionArray(value.terms, state, depth + 1);
    return terms
      ? expressionSuccess({ kind: kind === "ALL" ? "AND" : "OR", terms })
      : expressionFailure();
  }
  if (kind === "BITSET_UNION") {
    if (!Array.isArray(value.members) || value.members.length === 0
        || value.members.length > 12) return expressionFailure();
    const members = projectExpressionArray(value.members, state, depth + 1);
    return members
      ? expressionSuccess({ kind: "BITSET_UNION", members })
      : expressionFailure();
  }
  if (kind === "BINARY" || kind === "COMPARE") {
    const operator = COMPARISON_OPERATORS.get(value.operator);
    const operands = Array.isArray(value.operands)
      ? value.operands
      : [value.left, value.right];
    if (!operator || operands.length !== 2) return expressionFailure();
    const projected = projectExpressionArray(operands, state, depth + 1);
    return projected
      ? expressionSuccess({
          kind: "COMPARE",
          operator,
          left: projected[0],
          right: projected[1],
        })
      : expressionFailure();
  }
  return expressionFailure();
}

function projectExpressionArray(values, state, depth) {
  const result = [];
  for (const value of values) {
    const projected = projectExpressionNode(value, state, depth);
    if (!projected.ok) return null;
    result.push(projected.value);
  }
  return result;
}

function projectSubjectRole(subject) {
  if (!isPlainObject(subject) || subject.kind !== "VARIABLE") return null;
  return SUBJECT_ROLES.get(String(subject.name || "")) || null;
}

function dependencyEntries(graph) {
  if (Array.isArray(graph?.dependencies)) return graph.dependencies;
  return Array.isArray(graph?.nodes) ? graph.nodes : [];
}

function projectEnumList(values, allowlist, state) {
  if (!Array.isArray(values)) return [];
  const accepted = [];
  for (const value of values) {
    if (typeof value === "string" && allowlist.has(value)) accepted.push(value);
    else state.partial = true;
  }
  if (accepted.length > MAX_LIST_ITEMS) state.partial = true;
  return [...new Set(accepted)]
    .sort(stableCompare)
    .slice(0, MAX_LIST_ITEMS);
}

function bindResourcesToResolvedCards(resources, resolvedCards) {
  const normalizedCards = (Array.isArray(resolvedCards) ? resolvedCards : [])
    .map(normalizeResolvedCard)
    .filter(Boolean);
  if (
    normalizedCards.length !== (Array.isArray(resolvedCards) ? resolvedCards.length : 0)
    || normalizedCards.length !== resources.length
  ) return null;

  const result = new Map();
  const boundCardKeys = new Set();
  for (const resource of resources) {
    const identity = parseResourceIdentity(
      resource?.resourceBinding?.sourceDocumentId,
    );
    if (!identity) return null;
    const matches = normalizedCards.filter((card) => (
      card.cid === identity.cid
      && card.passcode === identity.passcode
    ));
    if (matches.length !== 1) return null;
    const cardKey = `${matches[0].cid}:${matches[0].passcode}`;
    if (boundCardKeys.has(cardKey)) return null;
    boundCardKeys.add(cardKey);
    result.set(resource.resourceId, matches[0]);
  }
  return result.size === resources.length && boundCardKeys.size === normalizedCards.length
    ? result
    : null;
}

function parseResourceIdentity(value) {
  const matches = [...String(value || "").matchAll(
    /(?:^|:)cid-([1-9]\d{0,9}):passcode-([1-9]\d{0,9})(?::|$)/gu,
  )].map((match) => ({
    cid: normalizePositiveInteger(match[1], null),
    passcode: normalizePositiveInteger(match[2], 0xffff_ffffn),
  })).filter((item) => item.cid && item.passcode);
  return matches.length === 1 ? matches[0] : null;
}

function normalizeResolvedCard(card) {
  if (!isPlainObject(card)) return null;
  const sourceCid = String(card.sourceUrl || card.ygoResourcesUrl || "")
    .match(/\/data\/card\/([1-9]\d{0,9})(?:$|[/?#])/u)?.[1];
  const cids = uniqueNormalizedNumbers([
    card.cid,
    sourceCid,
    card.id,
    card.cardId,
    card.raw?.cid,
  ], null);
  const passcodes = uniqueNormalizedNumbers([
    card.passcode,
    card.password,
    card.raw?.passcode,
    card.raw?.password,
  ], 0xffff_ffffn);
  if (cids.length !== 1 || passcodes.length !== 1) return null;
  return {
    cid: cids[0],
    passcode: passcodes[0],
  };
}

function uniqueNormalizedNumbers(values, maximum) {
  return [...new Set(values
    .map((value) => normalizePositiveInteger(value, maximum))
    .filter(Boolean))];
}

function normalizePositiveInteger(value, maximum) {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d+$/u.test(text)) return null;
  const numeric = BigInt(text);
  if (numeric <= 0n || (maximum !== null && numeric > maximum)) return null;
  return numeric.toString(10);
}

function buildModelPayload(entries, unknownByResource, cardBindings) {
  const byResource = new Map();
  for (const [resourceId, boundCard] of cardBindings) {
    byResource.set(resourceId, {
      // CID is canonical numeric data generated by the binding step. Card
      // names are intentionally not copied into this isolated addon: the
      // normal evidence prompt already names the card, while accepting an
      // arbitrary display string here would create a second injection path.
      cardRef: { cid: boundCard.cid },
      effects: [],
      coverage: {
        complete: (unknownByResource.get(resourceId) || 0) === 0,
        unknownEffectCount: unknownByResource.get(resourceId) || 0,
      },
    });
  }
  entries.forEach((entry) => {
    byResource.get(entry.resourceId).effects.push(entry.effect);
  });
  const cards = [...byResource.entries()]
    .sort(([, left], [, right]) => stableCompare(left.cardRef.cid, right.cardRef.cid))
    .map(([, card]) => card);
  const unknownEffectCount = [...unknownByResource.values()]
    .reduce((sum, count) => sum + count, 0);
  return {
    schemaVersion: LEGACY_LUA_PROMPT_PAYLOAD_SCHEMA,
    cards,
    coverage: {
      complete: unknownEffectCount === 0,
      knownEffectCount: entries.length,
      unknownEffectCount,
      negativeInferenceAllowed: false,
    },
  };
}

function unavailableResult(status, reasonCategory, {
  sourcePacketSha256 = null,
  omittedHintCount = 0,
} = {}) {
  return freezeResult({
    status,
    promptAddon: "",
    modelPayload: null,
    audit: {
      moduleVersion: LEGACY_LUA_PROMPT_MODULE_VERSION,
      sourcePacketSha256,
      payloadSha256: null,
      includedHintCount: 0,
      omittedHintCount,
      reasonCategory,
    },
  });
}

function omitHint(state) {
  state.partial = true;
  state.omittedHintCount += 1;
}

function normalizeByteLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    item !== undefined
    && item !== null
    && (!Array.isArray(item) || item.length > 0)
  )));
}

function expressionSuccess(value) {
  return { ok: true, value };
}

function expressionFailure() {
  return { ok: false, value: null };
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeResult(value) {
  return deepFreeze(value);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((item) => deepFreeze(item, seen));
  return Object.freeze(value);
}
