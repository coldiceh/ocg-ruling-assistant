import {
  connectorDependsOnPreviousSuccess,
  normalizeEffectActivationStages,
  normalizePrimitiveSequence,
} from "./effectPrimitives.mjs";

export function resolvePrimitiveSequence(sequence = [], gameState = {}, options = {}) {
  let state = canonicalizeZoneState(gameState);
  const items = normalizePrimitiveSequence(sequence);
  const steps = [];
  const failedParts = [];
  const continuedParts = [];
  const stateChanges = [];
  const outcomes = [];
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
    previousSucceeded = execution.connectorSucceeded !== false;
    continuedParts.push(partDescriptor(item, "applied"));
    stateChanges.push(...execution.stateChanges.map((change) => ({ primitiveId: item.id, primitive: primitive.type, ...change })));
    outcomes.push(...(execution.outcomes || []).map((outcome) => ({ primitiveId: item.id, primitive: primitive.type, ...outcome })));
    steps.push({
      id: item.id,
      primitive: primitive.type,
      connector: item.connector,
      status: "applied",
      reason: execution.connectorSucceeded === false ? "operation_not_performed" : "applied",
      stateChanges: execution.stateChanges,
      outcomes: execution.outcomes || [],
    });
    ruleTrace.push(trace(item, "primitive_applied", "applied"));

    if (typeof options.afterStep === "function") {
      const afterStep = options.afterStep({
        gameState: clone(state),
        item: clone(item),
        execution: clone(execution),
      }) || {};
      if (afterStep.gameState) state = afterStep.gameState;
      if (Array.isArray(afterStep.trace)) {
        ruleTrace.push(...afterStep.trace.map((entry) => ({
          step: "after_primitive",
          primitiveId: item.id,
          primitive: primitive.type,
          ...entry,
        })));
      }
      if (afterStep.complete === false || afterStep.fixedPointReached === false) {
        insufficient = true;
        previousSucceeded = false;
        stopRemaining = true;
        const reason = afterStep.reason || "after_primitive_state_not_stable";
        failedParts.push(partDescriptor(item, reason));
        ruleTrace.push(trace(item, "after_primitive_stabilization_failed", "insufficient", { reason }));
      }
    }
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
    outcomes,
    ruleTrace,
    gameState: state,
  };
}

export function prepareEffectChain({ gameState = {}, chainLinks = [], continuousEffects = [] } = {}) {
  let state = canonicalizeZoneState(gameState);
  const preparedLinks = [];
  const activationResults = [];
  const trace = [];
  const stateSnapshots = [];
  let firstStabilization = null;
  const ordered = [...(chainLinks || [])].sort((left, right) => chainOrder(left) - chainOrder(right));

  for (const rawLink of ordered) {
    const link = clone(rawLink);
    const beforeActivation = stabilizeContinuousEffects(state, continuousEffects);
    if (!firstStabilization) firstStabilization = beforeActivation;
    state = beforeActivation.gameState;
    trace.push(...beforeActivation.trace.map((item) => ({ ...item, beforeChainActivation: link.id })));
    stateSnapshots.push({ stage: "before_chain_activation", chainLink: link.id, gameState: clone(state) });
    if (!beforeActivation.fixedPointReached) {
      return incompleteChainPreparation({
        state,
        preparedLinks,
        activationResults,
        trace,
        stateSnapshots,
        firstStabilization,
        reason: beforeActivation.reason || "continuous_effects_not_converged",
        failedLink: link,
      });
    }

    const activationCheck = inspectActivationLegality(link, state);
    if (activationCheck.status !== "legal") {
      activationResults.push({
        id: link.id,
        order: chainOrder(link),
        status: activationCheck.status,
        reason: activationCheck.reason,
      });
      trace.push({
        phase: "activation_check",
        chainLink: link.id,
        status: activationCheck.status,
        reason: activationCheck.reason,
      });
      return incompleteChainPreparation({
        state,
        preparedLinks,
        activationResults,
        trace,
        stateSnapshots,
        firstStabilization,
        reason: activationCheck.reason,
        failedLink: link,
      });
    }

    const source = activationCheck.source;
    const preparedLink = {
      ...link,
      activationSnapshot: {
        sourceInstanceId: source ? cardInstanceId(source) : String(link.sourceInstanceId || ""),
        sourceDefinitionId: source ? cardDefinitionId(source) : String(link.sourceDefinitionId || link.sourceCardId || ""),
        sourceCardId: source ? cardDefinitionId(source) : String(link.sourceCardId || ""),
        sourceCardName: source?.name || link.sourceCardName || "unknown",
        sourceController: source?.controller || "unknown",
        sourceZone: source?.zone || "unknown",
        sourcePosition: source?.position || "unknown",
        sourceFaceUp: source?.faceUp ?? null,
        sourceUnaffectedByMonsterEffects: Boolean(source?.unaffectedByMonsterEffects),
        ...(link.activationSnapshot || {}),
      },
    };
    trace.push({
      phase: "activation_check",
      chainLink: link.id,
      status: "legal",
      activationSnapshot: clone(preparedLink.activationSnapshot),
    });

    let activationFailed = null;
    const stageResults = [];
    for (const stage of normalizeEffectActivationStages(link)) {
      const stageResult = resolvePrimitiveSequence(
        stage.sequence,
        activationPrimitiveState(state, preparedLink),
        { afterStep: stabilizeAfterPrimitive(continuousEffects) },
      );
      stageResults.push({ stage: stage.stage, result: stageResult });
      trace.push({
        phase: stage.stage,
        chainLink: link.id,
        status: stageResult.resolutionStatus,
        primitiveSteps: stageResult.steps,
      });
      if (stageResult.gameState) state = stripResolutionContext(stageResult.gameState);
      if (stageResult.resolutionStatus !== "resolved") {
        activationFailed = {
          status: stageResult.resolutionStatus === "insufficient" ? "insufficient" : "illegal",
          reason: `${stage.stage}_${stageResult.resolutionStatus}`,
        };
        break;
      }
    }
    if (activationFailed) {
      activationResults.push({
        id: link.id,
        order: chainOrder(link),
        ...activationFailed,
        activationSnapshot: clone(preparedLink.activationSnapshot),
        stageResults,
      });
      return incompleteChainPreparation({
        state,
        preparedLinks,
        activationResults,
        trace,
        stateSnapshots,
        firstStabilization,
        reason: activationFailed.reason,
        failedLink: link,
      });
    }

    const afterActivation = stabilizeContinuousEffects(state, continuousEffects);
    state = afterActivation.gameState;
    trace.push(...afterActivation.trace.map((item) => ({ ...item, afterChainActivation: link.id })));
    stateSnapshots.push({ stage: "after_chain_activation", chainLink: link.id, gameState: clone(state) });
    if (!afterActivation.fixedPointReached) {
      return incompleteChainPreparation({
        state,
        preparedLinks,
        activationResults,
        trace,
        stateSnapshots,
        firstStabilization,
        reason: afterActivation.reason || "continuous_effects_not_converged",
        failedLink: link,
      });
    }

    preparedLinks.push(preparedLink);
    activationResults.push({
      id: link.id,
      order: chainOrder(link),
      status: "activated",
      reason: "activation_complete",
      activationSnapshot: clone(preparedLink.activationSnapshot),
      stageResults,
    });
  }

  return {
    complete: true,
    reason: "activation_sequence_complete",
    gameState: state,
    chainLinks: preparedLinks,
    activationResults,
    trace,
    stateSnapshots,
    stabilization: firstStabilization || stabilizeContinuousEffects(state, continuousEffects),
  };
}

export function resolveEffectChain({ gameState = {}, chainLinks = [], continuousEffects = [] } = {}) {
  const prepared = prepareEffectChain({ gameState, chainLinks, continuousEffects });
  let state = prepared.gameState;
  if (!prepared.complete) {
    return {
      preparedChainLinks: prepared.chainLinks,
      activationResults: prepared.activationResults || [],
      linkResults: [],
      trace: prepared.trace || [],
      stateSnapshots: prepared.stateSnapshots || [],
      finalGameState: state,
      complete: false,
      incompleteReason: prepared.reason,
    };
  }
  const ordered = [...prepared.chainLinks].sort((left, right) => chainOrder(right) - chainOrder(left));
  const linkResults = [];
  const trace = [...(prepared.trace || [])];
  const stateSnapshots = [
    ...(prepared.stateSnapshots || []),
    { stage: "before_chain_resolution", gameState: clone(state) },
  ];
  let incompleteReason = "";

  for (const link of ordered) {
    const beforeResolution = stabilizeContinuousEffects(state, continuousEffects);
    state = beforeResolution.gameState;
    trace.push(...beforeResolution.trace.map((item) => ({ ...item, beforeChainResolution: link.id })));
    if (!beforeResolution.fixedPointReached) {
      incompleteReason = beforeResolution.reason || "continuous_effects_not_converged";
      break;
    }

    const negation = findResolutionNegation(link, state, continuousEffects);
    if (negation.indeterminate) {
      incompleteReason = negation.reason || "continuous_negation_scope_unknown";
      trace.push({
        phase: "resolve_chain_link",
        chainLink: link.id,
        status: "insufficient",
        reason: incompleteReason,
      });
      break;
    }
    if (negation.effect) {
      linkResults.push({
        id: link.id,
        order: chainOrder(link),
        sourceCardId: link.sourceCardId,
        sourceCardName: link.sourceCardName,
        status: "negated",
        reason: "continuous_resolution_modifier",
        activationSnapshot: clone(link.activationSnapshot),
        negatedBy: negation.effect.sourceInstanceId || negation.effect.sourceCardId,
        primitiveResult: null,
      });
      trace.push({
        phase: "resolve_chain_link",
        chainLink: link.id,
        status: "negated",
        sourceCardId: link.sourceCardId,
        sourceCardName: link.sourceCardName,
        activationSnapshot: clone(link.activationSnapshot),
        continuousEffectId: negation.effect.id,
        continuousSourceCardId: negation.effect.sourceInstanceId || negation.effect.sourceCardId,
      });
    } else {
      const source = findCard(state, link.sourceCardId, link.sourceCardName, link.sourceInstanceId);
      const targetRefs = (link.targets || []).map((target) => ({
        id: target.id || target.cardId || target.name,
        instanceId: target.instanceId || target.cardInstanceId,
        cardId: target.cardId || target.id,
        definitionId: target.definitionId || target.cardDefinitionId || target.cardId,
        name: target.name,
        expectedZone: target.expectedZone,
        validAtResolution: target.validAtResolution,
      }));
      const primitiveResult = resolvePrimitiveSequence(
        link.sequence || [],
        {
          ...state,
          resolutionContext: {
            source: {
              instanceId: link.sourceInstanceId,
              cardId: link.sourceCardId,
              definitionId: link.sourceDefinitionId || link.sourceCardId,
              name: link.sourceCardName,
              expectedZone: source?.zone || link.sourceExpectedZone || "unknown",
              availableAtResolution: Boolean(source),
            },
            targets: targetRefs,
          },
        },
        { afterStep: stabilizeAfterPrimitive(continuousEffects) },
      );
      state = stripResolutionContext(primitiveResult.gameState || state);
      linkResults.push({
        id: link.id,
        order: chainOrder(link),
        sourceCardId: link.sourceCardId,
        sourceCardName: link.sourceCardName,
        status: primitiveResult.resolutionStatus,
        reason: primitiveResult.resolutionStatus,
        activationSnapshot: clone(link.activationSnapshot),
        primitiveResult,
      });
      trace.push({
        phase: "resolve_chain_link",
        chainLink: link.id,
        status: primitiveResult.resolutionStatus,
        sourceCardId: link.sourceCardId,
        sourceCardName: link.sourceCardName,
        activationSnapshot: clone(link.activationSnapshot),
        primitiveSteps: primitiveResult.steps,
      });
    }

    const stabilized = stabilizeContinuousEffects(state, continuousEffects);
    state = stabilized.gameState;
    trace.push(...stabilized.trace.map((item) => ({ ...item, afterChainLink: link.id })));
    stateSnapshots.push({ stage: "after_chain_link", chainLink: link.id, gameState: clone(state) });
    if (!stabilized.fixedPointReached) {
      incompleteReason = stabilized.reason || "continuous_effects_not_converged";
      break;
    }
  }

  return {
    preparedChainLinks: prepared.chainLinks,
    activationResults: prepared.activationResults || [],
    linkResults,
    trace,
    stateSnapshots,
    finalGameState: state,
    complete: !incompleteReason
      && linkResults.length === prepared.chainLinks.length
      && linkResults.every((item) => item.status !== "insufficient"),
    ...(incompleteReason ? { incompleteReason } : {}),
  };
}

export function stabilizeContinuousEffects(gameState = {}, continuousEffects = []) {
  let state = canonicalizeZoneState(gameState);
  const trace = [];
  let iterations = 0;
  const ambiguousSource = (continuousEffects || []).find((effect) => (
    findCardCandidates(state, effect.sourceCardId || effect.sourceDefinitionId, effect.sourceCardName, effect.sourceInstanceId).length > 1
  ));
  if (ambiguousSource) {
    return {
      gameState: state,
      iterations,
      fixedPointReached: false,
      reason: "continuous_effect_source_instance_ambiguous",
      trace,
    };
  }
  const unresolvedSourceChoice = (continuousEffects || []).find((effect) => {
    if (!effect.activeWhen?.position) return false;
    const source = findCard(state, effect.sourceCardId || effect.sourceDefinitionId, effect.sourceCardName, effect.sourceInstanceId);
    if (!source || normalize(source.position) !== "unknown") return false;
    const choices = new Set((source.positionChoices || []).map(normalize).filter(Boolean));
    return choices.size > 1 && choices.has(normalize(effect.activeWhen.position));
  });
  if (unresolvedSourceChoice) {
    return {
      gameState: state,
      iterations,
      fixedPointReached: false,
      reason: "continuous_effect_source_position_choice_unresolved",
      trace,
    };
  }
  const seenStates = new Set();
  const maxIterations = Math.min(64, Math.max(8, (state.cards?.length || 1) * Math.max(1, continuousEffects?.length || 1) * 2));
  while (iterations < maxIterations) {
    const signature = continuousStateSignature(state);
    if (seenStates.has(signature)) {
      return {
        gameState: state,
        iterations,
        fixedPointReached: false,
        reason: "continuous_effect_cycle",
        trace,
      };
    }
    seenStates.add(signature);
    const indeterminateEffect = (continuousEffects || []).find((effect) => (
      continuousEffectActive(effect, state) === null
    ));
    if (indeterminateEffect) {
      return {
        gameState: state,
        iterations,
        fixedPointReached: false,
        reason: "continuous_effect_applicability_unknown",
        trace,
      };
    }
    const indeterminateRecipient = (continuousEffects || []).find((effect) => (
      continuousEffectActive(effect, state) === true
      && continuousEffectRecipientSelectionUnknown(effect, state)
    ));
    if (indeterminateRecipient) {
      return {
        gameState: state,
        iterations,
        fixedPointReached: false,
        reason: "continuous_effect_recipient_selector_unknown",
        trace,
      };
    }
    let changed = false;
    iterations += 1;
    const modifierDerivation = deriveContinuousModifiers(state, continuousEffects);
    if (modifierDerivation.changed) {
      changed = true;
      trace.push(...modifierDerivation.trace);
    }
    for (const effect of continuousEffects || []) {
      if (continuousEffectActive(effect, state) !== true) continue;
      for (const constraint of effect.constraints || []) {
        if (continuousEffectActive(effect, state) !== true) break;
        if (constraint.type !== "set_position") continue;
        for (const card of state.cards || []) {
          if (continuousEffectActive(effect, state) !== true) break;
          if (!matchesCardSelector(card, constraint.selector || {})) continue;
          if (!cardCanReceiveContinuousEffect(card, effect)) continue;
          if (constraint.position === "defense" && card.canChangeToDefense === false) continue;
          if (card.position === constraint.position) continue;
          const before = card.position || "unknown";
          card.position = constraint.position;
          card.positionChoices = [constraint.position];
          changed = true;
          trace.push({
            phase: "stabilize_continuous_effects",
            iteration: iterations,
            continuousEffectId: effect.id,
            sourceCardId: effect.sourceCardId,
            cardId: cardId(card),
            operation: "set_position",
            before,
            after: constraint.position,
          });
        }
      }
    }
    if (!changed) {
      state.stabilizationIterations = iterations;
      return { gameState: state, iterations, fixedPointReached: true, reason: "fixed_point", trace };
    }
  }
  state.stabilizationIterations = iterations;
  return { gameState: state, iterations, fixedPointReached: false, reason: "continuous_effect_iteration_limit", trace };
}

function findResolutionNegation(link, state, continuousEffects) {
  for (const effect of continuousEffects || []) {
    const active = continuousEffectActive(effect, state);
    if (active === null) return { indeterminate: true, reason: "continuous_effect_applicability_unknown" };
    if (active !== true) continue;
    for (const modifier of effect.resolutionModifiers || []) {
      if (modifier.type !== "negate_activated_effect") continue;
      if (modifier.effectCategory && modifier.effectCategory !== link.effectCategory) continue;
      const selector = modifier.sourceSelector || legacyActivationSelector(modifier);
      const selectorResult = matchesActivationSourceSelector(link.activationSnapshot || {}, selector);
      if (selectorResult === false) continue;
      if (selectorResult === null) {
        return { indeterminate: true, reason: "continuous_negation_source_selector_unknown" };
      }
      if (effect.effectCategory === "monster" && link.activationSnapshot?.sourceUnaffectedByMonsterEffects) continue;
      return { effect, indeterminate: false };
    }
  }
  return { effect: null, indeterminate: false };
}

function continuousEffectActive(effect, state) {
  const source = findCard(state, effect.sourceCardId, effect.sourceCardName, effect.sourceInstanceId);
  if (!source) return false;
  const activeWhen = effect.activeWhen || {};
  if (activeWhen.zone) {
    if (!source.zone || normalize(source.zone) === "unknown") return null;
    if (normalize(source.zone) !== normalize(activeWhen.zone)) return false;
  }
  if (typeof activeWhen.faceUp === "boolean") {
    if (typeof source.faceUp !== "boolean") return null;
    if (source.faceUp !== activeWhen.faceUp) return false;
  }
  if (activeWhen.position) {
    if (!source.position || normalize(source.position) === "unknown") return null;
    if (normalize(source.position) !== normalize(activeWhen.position)) return false;
  }
  for (const condition of effect.stateConditions || []) {
    if (condition.type !== "exists") return null;
    const matchStates = (state.cards || []).map((card) => matchesCardSelectorTriState(card, condition.selector || {}));
    const count = matchStates.filter((result) => result === true).length;
    const unknownCount = matchStates.filter((result) => result === null).length;
    const minimum = Number.isInteger(condition.minCount) ? condition.minCount : 1;
    const maximum = Number.isInteger(condition.maxCount) ? condition.maxCount : Infinity;
    if (count > maximum) return false;
    if (count + unknownCount < minimum) return false;
    if (unknownCount && (count < minimum || count + unknownCount > maximum)) return null;
    if (count < minimum) return false;
  }
  return true;
}

function continuousEffectRecipientSelectionUnknown(effect, state) {
  const selectors = [
    ...(effect.constraints || []).map((constraint) => constraint.selector || {}),
    ...(effect.grantedModifiers || [])
      .filter((grant) => grant.recipient !== "source")
      .map((grant) => grant.selector || {}),
  ];
  return selectors.some((selector) => (
    (state.cards || []).some((card) => matchesCardSelectorTriState(card, selector) === null)
  ));
}

function matchesCardSelector(card, selector) {
  return matchesCardSelectorTriState(card, selector) === true;
}

function matchesCardSelectorTriState(card, selector) {
  let unknown = false;
  const compare = (actual, expected, normalizer = String) => {
    if (expected === undefined || expected === null || expected === "") return true;
    if (actual === undefined || actual === null || actual === "" || normalize(actual) === "unknown") {
      unknown = true;
      return true;
    }
    return normalizer(actual) === normalizer(expected);
  };
  if (selector.instanceId && !compare(cardInstanceId(card), selector.instanceId, String)) return false;
  if (selector.definitionId && !compare(cardDefinitionId(card), selector.definitionId, String)) return false;
  if (selector.definitionIds?.length) {
    const definitionId = cardDefinitionId(card);
    if (!definitionId || normalize(definitionId) === "unknown") unknown = true;
    else if (!selector.definitionIds.map(String).includes(definitionId)) return false;
  }
  if (selector.cardId) {
    const definitionId = cardDefinitionId(card);
    const instanceId = cardInstanceId(card);
    const definitionUnknown = !definitionId || normalize(definitionId) === "unknown";
    const instanceUnknown = !instanceId || normalize(instanceId) === "unknown";
    const requested = String(selector.cardId);
    if (definitionId === requested || instanceId === requested) {
      // A known matching identity is sufficient.
    } else if (definitionUnknown || instanceUnknown) {
      unknown = true;
    } else {
      return false;
    }
  }
  if (selector.name && !compare(card.name, selector.name, normalize)) return false;
  if (selector.zone && !compare(card.zone, selector.zone, normalize)) return false;
  if (selector.zones?.length) {
    if (!card.zone || normalize(card.zone) === "unknown") unknown = true;
    else if (!selector.zones.map(normalize).includes(normalize(card.zone))) return false;
  }
  if (typeof selector.faceUp === "boolean") {
    if (typeof card.faceUp !== "boolean") unknown = true;
    else if (card.faceUp !== selector.faceUp) return false;
  }
  if (selector.controller && !compare(card.controller, selector.controller, String)) return false;
  if (selector.controllers?.length) {
    if (!card.controller || normalize(card.controller) === "unknown") unknown = true;
    else if (!selector.controllers.map(String).includes(String(card.controller))) return false;
  }
  if (selector.position && !compare(card.position, selector.position, normalize)) return false;
  if (selector.summonKinds?.length) {
    if (!Array.isArray(card.summonKinds) || !card.summonKinds.length) unknown = true;
    const cardKinds = new Set((card.summonKinds || []).map(normalize));
    if (cardKinds.size && !selector.summonKinds.some((kind) => cardKinds.has(normalize(kind)))) return false;
  }
  if (selector.cardKind === "monster") {
    const explicitKind = normalize(card.cardKind || card.kind || card.cardType || "");
    if (explicitKind) {
      if (/(?:spell|trap|魔法|陷阱|罠)/u.test(explicitKind)) return false;
      if (!/(?:monster|fusion|synchro|xyz|link|ritual|pendulum|normal|effect|怪兽|怪獸|モンスター|融合|同步|同调|超量|连接|連接|仪式|儀式)/u.test(explicitKind)) {
        unknown = true;
      }
    } else if (!card.zone || normalize(card.zone) === "unknown") {
      unknown = true;
    } else if (normalize(card.zone) === "monster_zone") {
      // A card occupying a Monster Zone is known to be a monster for selector purposes.
    } else if (normalize(card.zone) === "spell_trap_zone") {
      return false;
    } else {
      unknown = true;
    }
  }
  return unknown ? null : true;
}

function cardCanReceiveContinuousEffect(card, effect) {
  return cardCanReceiveEffect(card, effect);
}

function deriveContinuousModifiers(state, continuousEffects) {
  const nextByCard = new Map((state.cards || []).map((card) => [cardInstanceId(card), []]));
  const trace = [];
  for (const effect of continuousEffects || []) {
    if (continuousEffectActive(effect, state) !== true) continue;
    const source = findCard(state, effect.sourceCardId, effect.sourceCardName, effect.sourceInstanceId);
    if (!source) continue;
    for (const grant of effect.grantedModifiers || []) {
      const recipients = grant.recipient === "source"
        ? [source]
        : (state.cards || []).filter((card) => matchesCardSelector(card, grant.selector || {}));
      for (const recipient of recipients) {
        if (!cardCanReceiveEffect(recipient, effect)) continue;
        nextByCard.get(cardInstanceId(recipient))?.push({
          type: grant.type,
          continuousEffectId: effect.id,
          sourceInstanceId: cardInstanceId(source),
          sourceDefinitionId: cardDefinitionId(source),
          exceptEffectSource: grant.exceptEffectSource || "",
        });
      }
    }
  }

  let changed = false;
  for (const card of state.cards || []) {
    const before = modifierSignature(card.derivedModifiers);
    const next = nextByCard.get(cardInstanceId(card)) || [];
    const after = modifierSignature(next);
    if (before !== after) {
      changed = true;
      trace.push({
        phase: "stabilize_continuous_effects",
        operation: "derive_modifiers",
        cardId: cardInstanceId(card),
        before: card.derivedModifiers || [],
        after: next,
      });
    }
    card.derivedModifiers = next;
  }
  return { changed, trace };
}

function cardCanReceiveEffect(card, effect = {}) {
  if (effect.effectCategory === "monster" && card.unaffectedByMonsterEffects) return false;
  const effectSource = String(effect.sourceInstanceId || effect.sourceCardId || "");
  const blockedSources = new Set((card.unaffectedByEffectSources || []).map(String));
  if (blockedSources.has(effectSource)) return false;
  for (const modifier of card.derivedModifiers || []) {
    if (modifier.type !== "unaffected_by_other_effects") continue;
    const selfException = modifier.exceptEffectSource === "self"
      && effectSource
      && effectSource === cardInstanceId(card);
    if (!selfException) return false;
  }
  return true;
}

function modifierSignature(modifiers = []) {
  return JSON.stringify((modifiers || []).map((modifier) => ({
    type: modifier.type,
    continuousEffectId: modifier.continuousEffectId,
    sourceInstanceId: modifier.sourceInstanceId,
    exceptEffectSource: modifier.exceptEffectSource,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function inspectActivationLegality(link, state) {
  if (link.activationLegal === false) {
    return { status: "illegal", reason: link.activationBlockReason || "activation_explicitly_illegal", source: null };
  }

  const hasSourceReference = Boolean(link.sourceInstanceId || link.sourceCardId || link.sourceDefinitionId || link.sourceCardName);
  const sourceRequired = link.requiresSourceAtActivation === true
    || (link.requiresSourceAtActivation !== false && hasSourceReference);
  const sourceMatches = findCardCandidates(
    state,
    link.sourceCardId || link.sourceDefinitionId,
    link.sourceCardName,
    link.sourceInstanceId,
  );
  if (sourceRequired && sourceMatches.length > 1) {
    return { status: "insufficient", reason: "activation_source_instance_ambiguous", source: null };
  }
  const source = sourceMatches[0] || null;
  if (sourceRequired && !source) {
    return { status: "insufficient", reason: "activation_source_state_unknown", source: null };
  }
  const sourceExpectedZone = link.activationSourceExpectedZone || link.sourceExpectedZone;
  if (source && sourceExpectedZone) {
    if (!source.zone || normalize(source.zone) === "unknown") {
      return { status: "insufficient", reason: "activation_source_zone_unknown", source };
    }
    if (normalize(source.zone) !== normalize(sourceExpectedZone)) {
      return { status: "illegal", reason: "activation_source_wrong_zone", source };
    }
  }

  for (const targetRef of link.targets || []) {
    if (targetRef.requiredAtActivation === false) continue;
    if (targetRef.validAtActivation === false) {
      return { status: "illegal", reason: "activation_target_explicitly_invalid", source };
    }
    const matches = findCardCandidates(
      state,
      targetRef.cardId || targetRef.definitionId || targetRef.id,
      targetRef.name,
      targetRef.instanceId || targetRef.cardInstanceId,
    );
    if (matches.length > 1) {
      return { status: "insufficient", reason: "activation_target_instance_ambiguous", source };
    }
    const target = matches[0] || null;
    if (!target) return { status: "insufficient", reason: "activation_target_state_unknown", source };
    const expectedZone = targetRef.activationExpectedZone || targetRef.expectedZone;
    if (expectedZone && normalize(target.zone) !== normalize(expectedZone)) {
      return { status: "illegal", reason: "activation_target_wrong_zone", source };
    }
  }

  for (const precondition of link.activationPreconditions || []) {
    if (precondition.status === "illegal" || precondition.satisfied === false) {
      return { status: "illegal", reason: precondition.reason || "activation_precondition_failed", source };
    }
    if (precondition.status === "unknown") {
      return { status: "insufficient", reason: precondition.reason || "activation_precondition_unknown", source };
    }
    if (precondition.type === "operation_performable") {
      const evaluation = evaluateFusionOperation(state, precondition.primitive || precondition.operation);
      if (evaluation.status === "unknown") {
        return { status: "insufficient", reason: evaluation.reason || "activation_operation_unknown", source, evaluation };
      }
      if (evaluation.status !== "performable") {
        return { status: "illegal", reason: evaluation.reason || "activation_operation_not_performable", source, evaluation };
      }
      continue;
    }
    if (!precondition.selector) continue;
    const count = (state.cards || []).filter((card) => matchesCardSelector(card, precondition.selector)).length;
    const minimum = Number.isInteger(precondition.minCount) ? precondition.minCount : 1;
    const maximum = Number.isInteger(precondition.maxCount) ? precondition.maxCount : Infinity;
    if (count < minimum || count > maximum) {
      const status = precondition.onMismatch === "illegal" ? "illegal" : "insufficient";
      return { status, reason: precondition.reason || "activation_precondition_card_count_mismatch", source };
    }
  }

  return { status: "legal", reason: "activation_preconditions_satisfied", source };
}

export function evaluateFusionOperation(gameState = {}, primitive = {}) {
  const state = canonicalizeZoneState(gameState);
  if (primitive?.type !== "fusion_summon") {
    return { status: "unknown", reason: "operation_not_fusion_summon" };
  }
  const source = findCard(
    state,
    primitive.sourceCardId || primitive.sourceDefinitionId,
    primitive.sourceCardName,
    primitive.sourceInstanceId,
  );
  if (!source) return { status: "unknown", reason: "fusion_effect_source_unknown" };
  const candidateIds = uniqueStrings(primitive.candidateInstanceIds || primitive.candidateIds || []);
  if (!candidateIds.length) return { status: "unknown", reason: "fusion_candidate_unknown" };
  const candidates = candidateIds
    .map((instanceId) => findCard(state, instanceId, "", instanceId))
    .filter(Boolean);
  if (candidates.length !== candidateIds.length) return { status: "unknown", reason: "fusion_candidate_state_unknown" };

  const poolSelector = primitive.materialPool || {};
  const poolZones = (poolSelector.zones?.length ? poolSelector.zones : [poolSelector.zone || "monster_zone"])
    .map(normalize);
  const poolControllers = (poolSelector.controllers || []).map(String);
  const poolMembership = (state.cards || []).map((card) => ({
    card,
    status: fusionMaterialPoolMembership(card, poolZones, poolControllers),
  }));
  let materialPool = poolMembership
    .filter((item) => item.status === true)
    .map((item) => item.card);
  let unknownMaterialPool = poolMembership
    .filter((item) => item.status === null)
    .map((item) => item.card);
  if (primitive.excludeOtherOwnMonsters) {
    const sourceController = normalize(source.controller);
    const classifyOwnMonsterRestriction = (card) => {
      if (cardInstanceId(card) === cardInstanceId(source)) return true;
      const controller = normalize(card.controller);
      if (!sourceController || sourceController === "unknown" || !controller || controller === "unknown") return null;
      return controller !== sourceController;
    };
    unknownMaterialPool = uniqueCards([
      ...unknownMaterialPool,
      ...materialPool.filter((card) => classifyOwnMonsterRestriction(card) === null),
    ]);
    materialPool = materialPool.filter((card) => classifyOwnMonsterRestriction(card) === true);
  }
  const excludedMaterials = [];
  const interaction = normalize(primitive.interaction || "effect_affecting");
  if (!["effect_affecting", "non_affecting"].includes(interaction)) {
    return { status: "unknown", reason: "fusion_material_interaction_unknown" };
  }
  if (interaction === "effect_affecting") {
    materialPool = materialPool.filter((card) => {
      if (cardCanReceiveEffect(card, {
        effectCategory: primitive.effectCategory || "monster",
        sourceInstanceId: cardInstanceId(source),
        sourceCardId: cardInstanceId(source),
      })) return true;
      excludedMaterials.push({
        instanceId: cardInstanceId(card),
        definitionId: cardDefinitionId(card),
        name: card.name,
        reason: "unaffected_by_resolving_effect",
      });
      return false;
    });
  }

  let sawUnknownRecipe = false;
  let sawUnknownAssignment = false;
  for (const candidate of candidates) {
    const slots = candidate.materialRecipe?.slots;
    if (!Array.isArray(slots) || slots.length < 2) {
      sawUnknownRecipe = true;
      continue;
    }
    const assignmentResult = assignDistinctMaterials(slots, materialPool, {
      requiredInstanceId: primitive.sourceMustBeMaterial ? cardInstanceId(source) : "",
    });
    if (assignmentResult.status === "unknown") {
      sawUnknownAssignment = true;
      continue;
    }
    if (assignmentResult.status !== "matched") continue;
    const assignment = assignmentResult.assignment;
    return {
      status: "performable",
      reason: "legal_material_assignment_found",
      candidateInstanceId: cardInstanceId(candidate),
      candidateDefinitionId: cardDefinitionId(candidate),
      assignment: assignment.map((item) => ({
        slotId: item.slot.id,
        instanceId: cardInstanceId(item.card),
        definitionId: cardDefinitionId(item.card),
        name: item.card.name,
      })),
      excludedMaterials,
      usableMaterials: materialPool.map((card) => cardInstanceId(card)),
    };
  }
  if (sawUnknownRecipe) return { status: "unknown", reason: "fusion_material_recipe_unknown", excludedMaterials };
  if (sawUnknownAssignment) return { status: "unknown", reason: "fusion_material_kind_unknown", excludedMaterials };
  if (unknownMaterialPool.length) {
    return {
      status: "unknown",
      reason: "fusion_material_pool_membership_unknown",
      excludedMaterials,
      unknownMaterialPool: unknownMaterialPool.map((card) => cardInstanceId(card)),
    };
  }
  return {
    status: "not_performable",
    reason: "no_legal_material_assignment",
    excludedMaterials,
    usableMaterials: materialPool.map((card) => cardInstanceId(card)),
  };
}

function fusionMaterialPoolMembership(card, poolZones, poolControllers) {
  const zone = normalize(card.zone);
  if (!zone || zone === "unknown") return null;
  if (!poolZones.includes(zone)) return false;
  if (!poolControllers.length) return true;
  const controller = normalize(card.controller);
  if (!controller || controller === "unknown") {
    const completeControllerDomain = new Set(poolControllers.map(normalize));
    return completeControllerDomain.has("self") && completeControllerDomain.has("opponent") ? true : null;
  }
  return poolControllers.map(normalize).includes(controller);
}

function uniqueCards(cards = []) {
  const byId = new Map();
  for (const card of cards) byId.set(cardInstanceId(card), card);
  return [...byId.values()];
}

function assignDistinctMaterials(
  slots,
  cards,
  options = {},
  slotIndex = 0,
  used = new Set(),
  assignment = [],
) {
  if (slotIndex >= slots.length) {
    if (options.requiredInstanceId
        && !assignment.some((item) => cardInstanceId(item.card) === options.requiredInstanceId)) {
      return { status: "no_match" };
    }
    return { status: "matched", assignment };
  }
  const slot = slots[slotIndex];
  let sawUnknownCompletion = false;
  for (const card of cards) {
    const instanceId = cardInstanceId(card);
    if (used.has(instanceId)) continue;
    const match = materialMatchesSlot(card, slot);
    if (match === false) continue;
    used.add(instanceId);
    const resolved = assignDistinctMaterials(
      slots,
      cards,
      options,
      slotIndex + 1,
      used,
      [...assignment, { slot, card }],
    );
    used.delete(instanceId);
    if (resolved.status === "matched" && match === true) return resolved;
    if (resolved.status === "matched" || resolved.status === "unknown") sawUnknownCompletion = true;
  }
  return sawUnknownCompletion ? { status: "unknown" } : { status: "no_match" };
}

function materialMatchesSlot(card, slot) {
  const predicate = slot?.predicate || {};
  if (predicate.definitionIds?.length) {
    const definitionId = cardDefinitionId(card);
    if (!definitionId || normalize(definitionId) === "unknown") return null;
    if (!predicate.definitionIds.map(String).includes(definitionId)) return false;
  }
  if (predicate.summonKinds?.length) {
    if (!Array.isArray(card.summonKinds) || !card.summonKinds.length) return null;
    const kinds = new Set(card.summonKinds.map(normalize));
    if (!predicate.summonKinds.some((kind) => kinds.has(normalize(kind)))) return false;
  }
  return Boolean(predicate.definitionIds?.length || predicate.summonKinds?.length);
}

function activationPrimitiveState(state, link) {
  const source = findCard(state, link.sourceCardId || link.sourceDefinitionId, link.sourceCardName, link.sourceInstanceId);
  return {
    ...state,
    resolutionContext: {
      source: {
        instanceId: source ? cardInstanceId(source) : link.sourceInstanceId,
        cardId: source ? cardDefinitionId(source) : link.sourceCardId,
        definitionId: source ? cardDefinitionId(source) : link.sourceDefinitionId || link.sourceCardId,
        name: source?.name || link.sourceCardName,
        expectedZone: source?.zone || link.sourceExpectedZone || "unknown",
        availableAtResolution: Boolean(source),
      },
      targets: (link.targets || []).map((target) => ({
        instanceId: target.instanceId || target.cardInstanceId,
        cardId: target.cardId || target.definitionId || target.id,
        definitionId: target.definitionId || target.cardId,
        name: target.name,
        expectedZone: target.activationExpectedZone || target.expectedZone,
        validAtResolution: target.validAtActivation ?? true,
      })),
    },
  };
}

function stripResolutionContext(state) {
  const next = clone(state);
  delete next.resolutionContext;
  return next;
}

function stabilizeAfterPrimitive(continuousEffects) {
  return ({ gameState }) => {
    const stabilized = stabilizeContinuousEffects(gameState, continuousEffects);
    return {
      gameState: stabilized.gameState,
      complete: stabilized.fixedPointReached,
      fixedPointReached: stabilized.fixedPointReached,
      reason: stabilized.reason,
      trace: stabilized.trace,
    };
  };
}

function incompleteChainPreparation({
  state,
  preparedLinks,
  activationResults,
  trace,
  stateSnapshots,
  firstStabilization,
  reason,
  failedLink,
}) {
  return {
    complete: false,
    reason,
    failedLink: failedLink ? { id: failedLink.id, order: chainOrder(failedLink) } : null,
    gameState: state,
    chainLinks: preparedLinks,
    activationResults,
    trace,
    stateSnapshots,
    stabilization: firstStabilization || {
      gameState: state,
      iterations: 0,
      fixedPointReached: false,
      reason,
      trace: [],
    },
  };
}

function legacyActivationSelector(modifier) {
  return {
    ...(modifier.sourcePositionAtActivation ? { positionAtActivation: modifier.sourcePositionAtActivation } : {}),
    ...(modifier.sourceZoneAtActivation ? { zoneAtActivation: modifier.sourceZoneAtActivation } : {}),
    ...(typeof modifier.sourceFaceUpAtActivation === "boolean"
      ? { faceUpAtActivation: modifier.sourceFaceUpAtActivation }
      : {}),
    ...(modifier.sourceController ? { controller: modifier.sourceController } : {}),
  };
}

function matchesActivationSourceSelector(snapshot, selector = {}) {
  const checks = [
    [selector.instanceId || selector.sourceInstanceId, snapshot.sourceInstanceId],
    [selector.definitionId || selector.sourceDefinitionId, snapshot.sourceDefinitionId || snapshot.sourceCardId],
    [selector.cardId, snapshot.sourceDefinitionId || snapshot.sourceCardId],
    [selector.name, snapshot.sourceCardName],
    [selector.controller, snapshot.sourceController],
    [selector.zoneAtActivation || selector.zone, snapshot.sourceZone],
    [selector.positionAtActivation || selector.position, snapshot.sourcePosition],
  ];
  let unknown = false;
  for (const [expected, actual] of checks) {
    if (expected === undefined || expected === null || expected === "") continue;
    if (actual === undefined || actual === null || actual === "" || normalize(actual) === "unknown") {
      unknown = true;
      continue;
    }
    if (normalize(actual) !== normalize(expected)) return false;
  }
  const expectedFaceUp = selector.faceUpAtActivation ?? selector.faceUp;
  if (typeof expectedFaceUp === "boolean") {
    if (typeof snapshot.sourceFaceUp !== "boolean") unknown = true;
    else if (snapshot.sourceFaceUp !== expectedFaceUp) return false;
  }
  return unknown ? null : true;
}

function continuousStateSignature(state) {
  const cards = (state.cards || []).map((card) => ({
    instanceId: cardInstanceId(card),
    definitionId: cardDefinitionId(card),
    controller: card.controller || "",
    zone: card.zone || "",
    faceUp: card.faceUp ?? null,
    position: card.position || "",
    positionChoices: Array.isArray(card.positionChoices) ? [...card.positionChoices].sort() : [],
    unaffectedByMonsterEffects: Boolean(card.unaffectedByMonsterEffects),
    derivedModifiers: modifierSignature(card.derivedModifiers),
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  return JSON.stringify(cards);
}

function inspectRequiredTarget(primitive, state) {
  const context = state.resolutionContext || {};
  const ref = primitive.target || findReference(context.targets, primitive.targetId || primitive.targetRef);
  const expectedZoneValue = primitive.targetExpectedZone || ref?.expectedZone;
  const expectedZone = normalize(expectedZoneValue) === "unknown" ? null : expectedZoneValue;
  const explicit = primitive.targetValidAtResolution ?? ref?.validAtResolution;
  if (explicit === false) return { required: primitive.requiresTargetStillValid, status: "unavailable", reason: "target_lost_at_resolution" };
  const card = findCard(
    state,
    primitive.targetId || primitive.targetDefinitionId || ref?.cardId || ref?.definitionId,
    primitive.targetName || ref?.name,
    primitive.targetInstanceId || ref?.instanceId,
  );
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
  const card = findCard(
    state,
    primitive.sourceCardId || primitive.sourceDefinitionId || ref.cardId || ref.definitionId,
    primitive.sourceCardName || ref.name,
    primitive.sourceInstanceId || ref.instanceId,
  );
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
  const target = findCard(
    state,
    primitive.targetId || primitive.targetDefinitionId || primitive.target?.cardId,
    primitive.targetName || primitive.target?.name,
    primitive.targetInstanceId || primitive.target?.instanceId,
  );
  const source = findCard(
    state,
    primitive.sourceCardId || primitive.sourceDefinitionId || primitive.source?.cardId || state.resolutionContext?.source?.cardId,
    primitive.sourceCardName || primitive.source?.name || state.resolutionContext?.source?.name,
    primitive.sourceInstanceId || primitive.source?.instanceId || state.resolutionContext?.source?.instanceId,
  );

  switch (primitive.type) {
    case "target_valid_at_resolution":
    case "source_available_at_resolution":
      return success(state, []);
    case "discard_from_hand": {
      const hand = orderedCardsInZone(state, "hand", player);
      if (!Number.isInteger(amount) || hand.length < amount) return insufficient("hand_contents_or_count_unknown");
      const selection = primitive.cardIds?.length
        ? selectCardsByIds(hand, primitive.cardIds, amount)
        : { complete: true, cards: hand.slice(0, amount) };
      if (!selection.complete || selection.cards.length < amount) {
        return insufficient(selection.reason || "specified_discard_cards_not_available");
      }
      transitionCards(state, selection.cards, "graveyard", { owner: player, controller: player });
      const discarded = selection.cards;
      return success(state, [{ type: "discard_from_hand", player, cardIds: discarded.map(cardId) }]);
    }
    case "fusion_summon": {
      const evaluation = evaluateFusionOperation(state, primitive);
      if (evaluation.status === "unknown") return insufficient(evaluation.reason || "fusion_operation_unknown");
      if (evaluation.status === "not_performable") {
        return success(state, [], [{
          type: "fusion_summon",
          status: "not_performed",
          reason: evaluation.reason,
          excludedMaterials: evaluation.excludedMaterials || [],
          usableMaterials: evaluation.usableMaterials || [],
        }], false);
      }
      const materialCards = evaluation.assignment
        .map((item) => findCard(state, item.instanceId, "", item.instanceId))
        .filter(Boolean);
      if (materialCards.length !== evaluation.assignment.length) return insufficient("fusion_material_state_changed");
      for (const material of materialCards) {
        transitionCards(state, [material], "graveyard", {
          owner: knownPlayer(material.owner) || knownPlayer(material.controller) || "self",
          controller: knownPlayer(material.owner) || knownPlayer(material.controller) || "self",
        });
      }
      const candidate = findCard(state, evaluation.candidateInstanceId, "", evaluation.candidateInstanceId);
      if (!candidate) return insufficient("fusion_candidate_state_changed");
      transitionCards(state, [candidate], "monster_zone", {
        controller: source?.controller || "self",
        summoned: true,
        summonMethod: "fusion",
        faceUp: true,
        position: primitive.position || "attack",
        positionChoices: [primitive.position || "attack"],
      });
      return success(state, [{
        type: "fusion_summon",
        cardId: cardInstanceId(candidate),
        materialInstanceIds: materialCards.map(cardInstanceId),
      }], [{
        type: "fusion_summon",
        status: "performed",
        candidateInstanceId: cardInstanceId(candidate),
        assignment: evaluation.assignment,
        excludedMaterials: evaluation.excludedMaterials || [],
        usableMaterials: evaluation.usableMaterials || [],
      }]);
    }
    case "return_target_to_hand":
      if (!target) return insufficient("target_state_unknown");
      return moveCard(state, target, "hand", "return_target_to_hand");
    case "return_lowest_defense_monster_to_hand": {
      const fieldMonsters = (state.cards || []).filter((card) => (
        normalize(card.zone) === "monster_zone"
        && card.faceUp !== false
        && card.canChangeToDefense !== false
      ));
      if (fieldMonsters.some((card) => !Number.isFinite(Number(card.defense ?? card.def)))) {
        return insufficient("defense_value_unknown");
      }
      const candidates = fieldMonsters.filter((card) => Number.isFinite(Number(card.defense ?? card.def)));
      if (!candidates.length) return insufficient("field_defense_values_unknown");
      const lowest = Math.min(...candidates.map((card) => Number(card.defense ?? card.def)));
      const tied = candidates.filter((card) => Number(card.defense ?? card.def) === lowest);
      const selected = target && tied.some((card) => cardId(card) === cardId(target)) ? target : tied.length === 1 ? tied[0] : null;
      if (!selected) return insufficient("lowest_defense_tie_choice_unknown");
      return moveCard(state, selected, "hand", "return_lowest_defense_monster_to_hand");
    }
    case "return_card_to_deck":
      if (!target) return insufficient("target_state_unknown");
      return moveCard(state, target, "deck", "return_card_to_deck");
    case "special_summon_source":
      if (!source) return insufficient("source_state_unknown");
      {
        const positionChoices = primitive.position
          ? [primitive.position]
          : Array.isArray(primitive.positionChoices) && primitive.positionChoices.length
            ? [...primitive.positionChoices]
            : source.canChangeToDefense === false
              ? ["attack"]
              : ["attack", "defense"];
        const position = positionChoices.length === 1 ? positionChoices[0] : "unknown";
      return moveCard(state, source, primitive.destinationZone || "monster_zone", "special_summon_source", {
        summoned: true,
        onField: true,
        faceUp: true,
          position,
          positionChoices,
      });
      }
    case "set_position":
      if (!target) return insufficient("target_state_unknown");
      if (primitive.position === "defense" && target.canChangeToDefense === false) {
        return { status: "skipped", reason: "card_cannot_change_to_defense", gameState: state, stateChanges: [] };
      }
      {
        const before = target.position || "unknown";
        target.position = primitive.position || target.position;
        target.positionChoices = target.position && target.position !== "unknown" ? [target.position] : [];
        return success(state, [{ type: "set_position", cardId: cardId(target), before, after: target.position }]);
      }
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
      const deckView = state.decks?.[player];
      const deck = orderedCardsInZone(state, "deck", player);
      if (!Array.isArray(deckView) || !Number.isInteger(amount) || deck.length < amount) {
        return insufficient("deck_or_hand_contents_unknown");
      }
      const drawn = deck.slice(0, amount);
      transitionCards(state, drawn, "hand", { owner: player, controller: player });
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
  transitionCards(state, [card], toZone, extra);
  return success(state, [{
    type,
    cardId: cardId(card),
    instanceId: cardInstanceId(card),
    definitionId: cardDefinitionId(card),
    fromZone,
    toZone,
  }]);
}

function transitionCards(state, cards, toZone, extra = {}) {
  for (const card of cards) {
    card.zone = toZone;
    if (isFieldZone(toZone)) {
      card.onField = true;
      card.faceUp = extra.faceUp ?? (toZone === "monster_zone" ? card.faceUp ?? true : true);
      if (toZone !== "monster_zone") card.position = "none";
    } else {
      card.onField = false;
      card.faceUp = false;
      card.position = "none";
    }
    if (zoneCollectionFor(toZone)) {
      const destinationPlayer = knownPlayer(extra.owner)
        || knownPlayer(card.owner)
        || knownPlayer(card.controller)
        || "self";
      card.owner = destinationPlayer;
      card.controller = knownPlayer(extra.controller) || destinationPlayer;
      ensureZoneView(state, toZone, destinationPlayer);
    }
    Object.assign(card, extra);
  }
  synchronizeKnownZoneViews(state);
}

function selectCardsByIds(cards, ids, max) {
  const remaining = [...cards];
  const selected = [];
  for (const requested of ids.map(String)) {
    if (selected.length >= max) break;
    let index = remaining.findIndex((card) => cardInstanceId(card) === requested);
    if (index < 0) {
      const definitionMatches = remaining
        .map((card, candidateIndex) => ({ card, candidateIndex }))
        .filter(({ card }) => cardDefinitionId(card) === requested);
      if (definitionMatches.length > 1) {
        return { complete: false, cards: [], reason: "specified_discard_card_instance_ambiguous" };
      }
      index = definitionMatches[0]?.candidateIndex ?? -1;
    }
    if (index >= 0) selected.push(...remaining.splice(index, 1));
  }
  return {
    complete: selected.length >= max,
    cards: selected,
    ...(selected.length >= max ? {} : { reason: "specified_discard_cards_not_available" }),
  };
}

const ZONE_COLLECTIONS = Object.freeze([
  { zone: "hand", property: "hands" },
  { zone: "graveyard", property: "graveyards" },
  { zone: "deck", property: "decks" },
]);

function canonicalizeZoneState(gameState) {
  const state = clone(gameState);
  if (!Array.isArray(state.cards)) state.cards = [];
  const cardsByInstance = new Map();
  for (const card of state.cards) {
    const instanceId = cardInstanceId(card);
    if (instanceId !== "unknown" && !cardsByInstance.has(instanceId)) cardsByInstance.set(instanceId, card);
  }

  for (const { zone, property } of ZONE_COLLECTIONS) {
    const collection = state[property];
    if (!collection || typeof collection !== "object") continue;
    for (const [player, entries] of Object.entries(collection)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const source = entry && typeof entry === "object"
          ? entry
          : { instanceId: String(entry), cardId: String(entry) };
        const instanceId = cardInstanceId(source);
        if (instanceId === "unknown") continue;
        let card = cardsByInstance.get(instanceId);
        if (!card) {
          card = {
            ...source,
            instanceId,
            owner: knownPlayer(source.owner) || player,
            controller: knownPlayer(source.controller) || player,
            zone,
          };
          state.cards.push(card);
          cardsByInstance.set(instanceId, card);
          continue;
        }
        if (!card.zone || normalize(card.zone) === "unknown") card.zone = zone;
        if (normalize(card.zone) === zone) {
          if (!knownPlayer(card.owner)) card.owner = player;
          if (!knownPlayer(card.controller)) card.controller = player;
        }
      }
    }
  }

  synchronizeKnownZoneViews(state);
  return state;
}

function orderedCardsInZone(state, zone, player) {
  const candidates = (state.cards || []).filter((card) => (
    normalize(card.zone) === normalize(zone)
    && zonePlayer(card) === String(player)
  ));
  const descriptor = zoneCollectionFor(zone);
  const view = descriptor ? state[descriptor.property]?.[player] : null;
  if (!Array.isArray(view)) return candidates;
  const byInstance = new Map(candidates.map((card) => [cardInstanceId(card), card]));
  const ordered = [];
  for (const entry of view) {
    const instanceId = cardInstanceId(entry);
    const card = byInstance.get(instanceId);
    if (!card) continue;
    ordered.push(card);
    byInstance.delete(instanceId);
  }
  ordered.push(...byInstance.values());
  return ordered;
}

function synchronizeKnownZoneViews(state) {
  if (!Array.isArray(state.cards)) return;
  for (const { zone, property } of ZONE_COLLECTIONS) {
    const collection = state[property];
    if (!collection || typeof collection !== "object") continue;
    const players = new Set(Object.keys(collection));
    for (const card of state.cards) {
      if (normalize(card.zone) === zone) players.add(zonePlayer(card));
    }
    for (const player of players) {
      const previous = Array.isArray(collection[player]) ? collection[player] : [];
      const candidates = state.cards.filter((card) => (
        normalize(card.zone) === zone && zonePlayer(card) === String(player)
      ));
      const byInstance = new Map(candidates.map((card) => [cardInstanceId(card), card]));
      const ordered = [];
      for (const entry of previous) {
        const instanceId = cardInstanceId(entry);
        const card = byInstance.get(instanceId);
        if (!card) continue;
        ordered.push(card);
        byInstance.delete(instanceId);
      }
      ordered.push(...byInstance.values());
      collection[player] = ordered.map((card) => clone(card));
    }
  }
}

function ensureZoneView(state, zone, player) {
  const descriptor = zoneCollectionFor(zone);
  if (!descriptor) return;
  if (!state[descriptor.property] || typeof state[descriptor.property] !== "object") {
    state[descriptor.property] = {};
  }
  if (!Array.isArray(state[descriptor.property][player])) state[descriptor.property][player] = [];
}

function zoneCollectionFor(zone) {
  return ZONE_COLLECTIONS.find((item) => item.zone === normalize(zone)) || null;
}

function zonePlayer(card) {
  return knownPlayer(card?.owner) || knownPlayer(card?.controller) || "self";
}

function knownPlayer(value) {
  const player = String(value || "").trim();
  return player && normalize(player) !== "unknown" ? player : "";
}

function isFieldZone(zone) {
  return ["monster_zone", "spell_trap_zone", "field_zone", "pendulum_zone"].includes(normalize(zone));
}

function findReference(refs, key) {
  if (!Array.isArray(refs)) return null;
  if (!key) return refs.length === 1 ? refs[0] : null;
  return refs.find((item) => [
    item.instanceId,
    item.id,
    item.cardId,
    item.definitionId,
    item.name,
  ].filter(Boolean).some((value) => String(value) === String(key))) || null;
}

function findCard(state, id, name, instanceId) {
  const matches = findCardCandidates(state, id, name, instanceId);
  return matches.length === 1 ? matches[0] : null;
}

function findCardCandidates(state, id, name, instanceId) {
  const cards = state.cards || [];
  if (instanceId) {
    return cards.filter((card) => cardInstanceId(card) === String(instanceId));
  }
  if (id) {
    const byInstance = cards.filter((card) => cardInstanceId(card) === String(id));
    if (byInstance.length === 1) return byInstance;
    const byDefinition = cards.filter((card) => cardDefinitionId(card) === String(id));
    if (byDefinition.length) return byDefinition;
  }
  if (name) {
    return cards.filter((card) => normalize(card.name) === normalize(name));
  }
  return [];
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

function success(gameState, stateChanges, outcomes = [], connectorSucceeded = true) {
  synchronizeKnownZoneViews(gameState);
  return { status: "applied", gameState, stateChanges, outcomes, connectorSucceeded };
}

function insufficient(reason) {
  return { status: "insufficient", reason, gameState: null, stateChanges: [] };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : NaN;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function cardId(card) {
  return cardInstanceId(card);
}

function cardInstanceId(card) {
  if (typeof card === "string" || typeof card === "number") return String(card);
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

function cardDefinitionId(card) {
  if (typeof card === "string" || typeof card === "number") return String(card);
  return String(
    card?.definitionId
    || card?.cardDefinitionId
    || card?.printedCardId
    || card?.cardId
    || card?.id
    || card?.name
    || "unknown",
  );
}

function chainOrder(link) {
  return Number(link?.order ?? String(link?.id || "").match(/\d+/u)?.[0] ?? 0);
}

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
