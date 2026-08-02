import { analyzeRuleConcepts } from "./ruleConceptAnalyzer.mjs";
import { deriveRulePrimitiveResults } from "./rulePrimitives.mjs";

/**
 * Compatibility entry point retained for callers in the legacy evidence engine.
 *
 * Phrase-matched rule primitives are useful retrieval/planning hints, but they
 * are not an execution trace or a verified proof.  They therefore must never
 * manufacture a user-facing verdict when direct evidence is absent.
 */
export function buildRuleDerivedAnswer() {
  return null;
}

/**
 * Build non-authoritative mechanism checks for a later reasoner/model.  The
 * returned value deliberately contains no verdict, short answer, confidence,
 * or "official" status and is not attached to the public answer object.
 */
export function buildRuleAnalysisHints(input = {}) {
  const unresolvedCards = dedupeUnresolved(input.unresolvedCards || []);
  if (unresolvedCards.length) return null;

  const ruleConceptAnalysis = input.ruleConceptAnalysis || analyzeRuleConcepts({
    formalQuery: input.formalQuery || { originalText: input.originalQuestion || "" },
    resolvedCards: input.resolvedCards || [],
    unresolvedCards,
    cardTexts: input.cardTexts || [],
    similarEvidence: input.similarEvidence || [],
    rejectedEvidence: input.rejectedEvidence || [],
    eventTimeline: input.eventTimeline || null,
  });
  const primitiveResults = deriveRulePrimitiveResults({
    ...input,
    originalQuestion: input.originalQuestion || input.formalQuery?.originalText || "",
    ruleConceptAnalysis,
  });
  if (!primitiveResults.length) return null;

  const reasoningChecks = dedupeSteps(primitiveResults.flatMap(({ result }) => result.steps || []));
  if (!reasoningChecks.length) return null;

  return {
    status: "analysis_only",
    reasoningChecks,
    assumptions: unique(primitiveResults.flatMap(({ primitive }) => primitive.assumptions || [])),
    riskFlags: unique([
      ...(ruleConceptAnalysis.riskFlags || []),
      ...primitiveResults.flatMap(({ primitive }) => primitive.riskFlags || []),
    ]),
    concepts: unique([
      ...(ruleConceptAnalysis.concepts || []),
      ...primitiveResults.flatMap(({ primitive, result }) => [primitive.id, ...(result.concepts || [])]),
    ]),
    sourceBasis: unique(primitiveResults.flatMap(({ primitive }) => primitive.sourceBasis || [])),
  };
}

export function validateRuleDerivedAnswer(value) {
  if (value == null) return { valid: false, errors: ["unverified rule-derived verdicts are disabled"] };
  return {
    valid: false,
    errors: ["rule-derived verdicts require direct evidence or a verified formal proof"],
  };
}

function dedupeSteps(steps) {
  const seen = new Set();
  return steps.filter((item) => {
    const key = `${item?.step || ""}:${item?.explanation || ""}`;
    if (!item?.step || !item?.explanation || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeUnresolved(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item?.unresolvedCardName || item?.name || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
