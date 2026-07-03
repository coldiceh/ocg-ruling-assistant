import { validateActivation } from "./activationLegalityGate.mjs";
import { resolvePrimitiveSequence } from "./effectResolutionEngine.mjs";

export function validateChainActivations({ chainLinks = [], gameState = {} } = {}) {
  const ruleTrace = [];
  const validatedLinks = [];
  const blockers = [];
  for (const link of [...chainLinks].sort((a, b) => chainOrder(a) - chainOrder(b))) {
    if (link.templateStatus === "loaded") {
      ruleTrace.push({ step: "template_loaded", chainLink: link.id, result: "loaded", templateId: link.effectTemplateId });
    } else if (link.templateStatus === "missing") {
      ruleTrace.push({ step: "template_loaded", chainLink: link.id, result: "missing", templateLookup: link.templateLookup || null });
    }
    const validation = validateActivation(link.candidateEffect || link.effect || {}, gameState);
    if (!validation.canActivate) {
      blockers.push(...validation.blockers);
      ruleTrace.push({ step: "validate_activation", chainLink: link.id || `C${validatedLinks.length + 1}`, result: "blocked", blocker: validation.blockers[0]?.code || "activation.illegal_chain_link" });
      return { status: "illegal_question", verdict: "cannot_activate", canResolve: false, invalidChainLink: link.id || null, validatedLinks, blockers, assumptions: validation.assumptions, ruleTrace, resolutionTrace: [] };
    }
    validatedLinks.push(link);
    ruleTrace.push({ step: "validate_activation", chainLink: link.id || `C${validatedLinks.length}`, result: "allowed" });
    ruleTrace.push({ step: "activation_validated", chainLink: link.id || `C${validatedLinks.length}`, result: "allowed" });
  }
  return { status: "valid_chain", verdict: "activation_legal", canResolve: true, invalidChainLink: null, validatedLinks, blockers: [], assumptions: [], ruleTrace, resolutionTrace: [] };
}

export function simulateResolutionTrace({ chainLinks = [], gameState = {} } = {}) {
  const trace = [];
  const linkResults = [];
  let state = clone(gameState);
  const ordered = [...chainLinks].sort((a, b) => chainOrder(b) - chainOrder(a));
  for (const link of ordered) {
    const effect = link.effect || link.candidateEffect || {};
    const primitiveSequence = link.primitiveSequence || effect.primitiveSequence || [];
    if (primitiveSequence.length) {
      state.resolutionContext = {
        ...(state.resolutionContext || {}),
        source: link.source || effect.source || state.resolutionContext?.source || null,
        targets: link.targets || effect.targets || state.resolutionContext?.targets || [],
      };
      trace.push({ step: "primitive_resolution_started", chainLink: link.id, result: "started", templateId: link.effectTemplateId || null });
      const primitiveResult = resolvePrimitiveSequence(primitiveSequence, state);
      state = primitiveResult.gameState;
      if (["resolved", "partially_resolved"].includes(primitiveResult.resolutionStatus) && (link.createsRestrictions || []).length) {
        if (!Array.isArray(state.activeRestrictions)) state.activeRestrictions = [];
        const created = (link.createsRestrictions || []).map((restriction) => ({
          ...clone(restriction),
          sourceCard: restriction.sourceCard || link.sourceCardName || link.source?.name || link.sourceCardId || "unknown",
          sourceCardId: restriction.sourceCardId || link.sourceCardId || link.source?.cardId || "",
          effectNo: restriction.effectNo || link.effectNo || "unknown",
          generatedFromTemplate: link.effectTemplateId || null,
        }));
        state.activeRestrictions.push(...created);
        primitiveResult.stateChanges.push({ type: "create_active_restrictions", restrictions: created });
        primitiveResult.ruleTrace.push({ step: "resolve_primitive", event: "active_restrictions_created", result: "applied", count: created.length });
      }
      linkResults.push({ chainLink: link.id, ...primitiveResult });
      trace.push(...primitiveResult.ruleTrace.map((item) => ({ chainLink: link.id, ...item })));
      trace.push({ step: "primitive_resolution_finished", chainLink: link.id, result: primitiveResult.resolutionStatus, templateId: link.effectTemplateId || null });
      continue;
    }
    if (effect.sourceAvailableAtResolution === false) {
      trace.push({ step: "resolve_chain_link", chainLink: link.id, event: "source_unavailable", result: effect.requiresSourceAtResolution ? "cannot_apply" : "continues_without_source" });
      if (effect.requiresSourceAtResolution) continue;
    }
    if (effect.targetAvailableAtResolution === false) {
      const hasNonTargetPart = (effect.nonTargetOperations || []).length > 0;
      trace.push({ step: "resolve_chain_link", chainLink: link.id, event: "target_lost", result: hasNonTargetPart ? "partial_resolution" : "targeted_part_not_applied", continuedOperations: hasNonTargetPart ? effect.nonTargetOperations : [] });
      if (!hasNonTargetPart) continue;
    }
    trace.push({ step: "resolve_chain_link", chainLink: link.id, event: "effect_resolution", result: "resolved" });
  }
  const statuses = linkResults.map((item) => item.resolutionStatus);
  const status = statuses.includes("insufficient")
    ? "insufficient"
    : statuses.length > 0 && statuses.every((item) => item === "failed")
      ? "failed"
      : statuses.includes("failed") || statuses.includes("partially_resolved")
      ? "partially_resolved"
      : "resolved";
  return { status, gameState: state, ruleTrace: trace, linkResults };
}

export function runSafeChainPipeline({ chainLinks = [], gameState = {} } = {}) {
  const validation = validateChainActivations({ chainLinks, gameState });
  if (!validation.canResolve) return validation;
  const missingTemplates = validation.validatedLinks.filter((link) => link.templateStatus === "missing"
    && !(link.primitiveSequence || link.effect?.primitiveSequence || []).length);
  if (missingTemplates.length) {
    return {
      ...validation,
      status: "insufficient",
      verdict: "insufficient",
      canResolve: false,
      missingTemplates: missingTemplates.map((link) => ({ chainLink: link.id, ...(link.templateLookup || {}) })),
      ruleTrace: [...validation.ruleTrace, ...missingTemplates.map((link) => ({
        step: "primitive_resolution_started",
        chainLink: link.id,
        result: "insufficient",
        reason: "effect_template_missing",
      }))],
    };
  }
  const resolution = simulateResolutionTrace({ chainLinks: validation.validatedLinks, gameState });
  return {
    ...validation,
    status: resolution.status,
    verdict: resolution.status,
    resolutionTrace: resolution.ruleTrace,
    resolutionResults: resolution.linkResults,
    gameState: resolution.gameState,
    ruleTrace: [...validation.ruleTrace, ...resolution.ruleTrace],
  };
}

function chainOrder(link) {
  return Number(link.order ?? String(link.id || "").match(/\d+/u)?.[0] ?? 0);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
