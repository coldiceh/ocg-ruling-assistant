import { buildRuleDerivedAnswer, validateRuleDerivedAnswer } from "./ruleDerivedAnswer.mjs";

export async function generateRuleDerivedAnswer(input = {}, options = {}) {
  const fallback = buildRuleDerivedAnswer(input);
  if (typeof options.model !== "function") {
    return { answer: fallback, provider: "deterministic", warnings: fallback ? [] : ["rule_derived_not_available"] };
  }

  try {
    const raw = await options.model(buildRuleDerivedModelPrompt(input));
    const parsed = parseModelValue(raw);
    const validation = validateRuleDerivedAnswer(parsed);
    if (!validation.valid) {
      return { answer: fallback, provider: "deterministic", warnings: ["model_rule_derived_invalid", ...validation.errors] };
    }
    return { answer: sanitizeModelAnswer(parsed), provider: options.provider || "model", warnings: [] };
  } catch (error) {
    return {
      answer: fallback,
      provider: "deterministic",
      warnings: [`model_rule_derived_failed:${String(error?.message || error)}`],
    };
  }
}

export function buildRuleDerivedModelPrompt(input = {}) {
  return {
    task: "Generate only a ruleDerivedAnswer object. Do not modify officialAnswer, finalStatus, verdict evidence, or confirmation status.",
    constraints: [
      "status must be rule_derived",
      "never claim official confirmation without officialAnswer.confirmed",
      "use only supplied card text, rule primitives, timeline, and evidence summaries",
      "include at least two concrete reasoning steps",
    ],
    officialAnswer: input.officialAnswer || null,
    formalQuery: input.formalQuery || null,
    ruleConcepts: input.ruleConcepts || input.ruleConceptAnalysis?.concepts || [],
    cardTexts: input.cardTexts || [],
    eventTimeline: input.eventTimeline || null,
    similarEvidence: input.similarEvidence || [],
    rejectedEvidence: input.rejectedEvidence || [],
  };
}

function parseModelValue(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  return JSON.parse(text);
}

function sanitizeModelAnswer(answer) {
  return {
    status: "rule_derived",
    confidence: answer.confidence,
    verdict: answer.verdict,
    shortAnswer: answer.shortAnswer,
    reasoningSteps: answer.reasoningSteps.map((step) => ({
      step: step.step,
      ruleBasis: step.ruleBasis,
      explanation: step.explanation,
      relatedCards: Array.isArray(step.relatedCards) ? step.relatedCards : [],
      sourceRefs: Array.isArray(step.sourceRefs) ? step.sourceRefs : [],
    })),
    assumptions: Array.isArray(answer.assumptions) ? answer.assumptions : [],
    counterEvidenceChecked: Boolean(answer.counterEvidenceChecked),
    counterEvidenceFound: Boolean(answer.counterEvidenceFound),
    riskFlags: Array.isArray(answer.riskFlags) ? answer.riskFlags : [],
    concepts: Array.isArray(answer.concepts) ? answer.concepts : [],
    sourceBasis: Array.isArray(answer.sourceBasis) ? answer.sourceBasis : [],
    displayLabel: "规则推导结论",
    notice: "未找到完全同场景的直接 Q&A。如存在相反裁定，应以官方数据库或事务局回答为准。",
  };
}
