import { analyzeRuleConcepts } from "./ruleConceptAnalyzer.mjs";
import { deriveRulePrimitiveResults } from "./rulePrimitives.mjs";

export function buildRuleDerivedAnswer(input = {}) {
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

  const counterEvidence = findCounterEvidence(input.similarEvidence || [], input.rejectedEvidence || []);
  const reasoningSteps = dedupeSteps(primitiveResults.flatMap(({ result }) => result.steps || []));
  if (reasoningSteps.length < 2) return null;

  const assumptions = unique(primitiveResults.flatMap(({ primitive }) => primitive.assumptions || []));
  const riskFlags = unique([
    ...(ruleConceptAnalysis.riskFlags || []),
    ...primitiveResults.flatMap(({ primitive }) => primitive.riskFlags || []),
    ...(counterEvidence.length ? ["counter_evidence_found"] : []),
  ]);
  const concepts = unique([
    ...(ruleConceptAnalysis.concepts || []),
    ...primitiveResults.flatMap(({ primitive, result }) => [primitive.id, ...(result.concepts || [])]),
  ]);
  const shortAnswers = unique(primitiveResults.map(({ result }) => result.shortAnswer).filter(Boolean));
  const verdictHints = unique(primitiveResults.map(({ result }) => result.verdictHint).filter(Boolean));
  const confidence = deriveConfidence({ assumptions, riskFlags, counterEvidence, reasoningSteps });

  return {
    status: "rule_derived",
    confidence,
    verdict: verdictHints.length === 1 ? verdictHints[0] : { handling: verdictHints },
    shortAnswer: shortAnswers.join(" "),
    reasoningSteps,
    assumptions,
    counterEvidenceChecked: true,
    counterEvidenceFound: counterEvidence.length > 0,
    riskFlags,
    concepts,
    sourceBasis: unique(primitiveResults.flatMap(({ primitive }) => primitive.sourceBasis || [])),
    displayLabel: "规则推导结论",
    notice: "未找到完全同场景的直接 Q&A。如存在相反裁定，应以官方数据库或事务局回答为准。",
  };
}

export function validateRuleDerivedAnswer(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["ruleDerivedAnswer must be an object"] };
  if (value.status !== "rule_derived") errors.push("status must be rule_derived");
  if (!new Set(["high", "medium", "low"]).has(value.confidence)) errors.push("confidence must be high, medium, or low");
  if (!value.verdict) errors.push("verdict is required");
  if (!String(value.shortAnswer || "").trim()) errors.push("shortAnswer is required");
  if (!Array.isArray(value.reasoningSteps) || value.reasoningSteps.length < 2) errors.push("at least two reasoningSteps are required");
  for (const [index, step] of (value.reasoningSteps || []).entries()) {
    if (!String(step?.step || "").trim()) errors.push(`reasoningSteps[${index}].step is required`);
    if (!String(step?.ruleBasis || "").trim()) errors.push(`reasoningSteps[${index}].ruleBasis is required`);
    if (!String(step?.explanation || "").trim()) errors.push(`reasoningSteps[${index}].explanation is required`);
  }
  if (!Array.isArray(value.assumptions)) errors.push("assumptions must be an array");
  if (!Array.isArray(value.riskFlags)) errors.push("riskFlags must be an array");
  if (value.counterEvidenceChecked !== true && value.counterEvidenceChecked !== false) errors.push("counterEvidenceChecked must be boolean");
  if (value.counterEvidenceFound !== true && value.counterEvidenceFound !== false) errors.push("counterEvidenceFound must be boolean");
  if (/官方(?:直接)?(?:确认|裁定已确认)|officially confirmed/iu.test(`${value.displayLabel || ""} ${value.shortAnswer || ""}`)) {
    errors.push("ruleDerivedAnswer cannot claim official confirmation");
  }
  return { valid: errors.length === 0, errors };
}

function deriveConfidence({ assumptions, riskFlags, counterEvidence, reasoningSteps }) {
  if (counterEvidence.length || riskFlags.includes("conflicting_evidence")) return "low";
  if (assumptions.length || riskFlags.length) return "medium";
  return reasoningSteps.length >= 3 ? "high" : "medium";
}

function findCounterEvidence(similarEvidence, rejectedEvidence) {
  return [...similarEvidence, ...rejectedEvidence].filter((item) => {
    const reason = `${item.rejectedReason || item.reason || ""} ${item.classification || ""}`;
    return /conflict|冲突|contradiction|相反/iu.test(reason);
  });
}

function dedupeSteps(steps) {
  const seen = new Set();
  return steps.filter((item) => {
    const key = `${item.step}:${item.explanation}`;
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
