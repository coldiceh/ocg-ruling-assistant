import { buildRuleAnalysisHints } from "./ruleDerivedAnswer.mjs";

export async function generateRuleDerivedAnswer(input = {}, options = {}) {
  void options;
  return {
    answer: null,
    analysisHints: buildRuleAnalysisHints(input),
    provider: "disabled",
    warnings: ["unverified_rule_derived_verdict_disabled"],
  };
}

export function buildRuleDerivedModelPrompt(input = {}) {
  return {
    task: "Identify mechanism checks for evidence preparation. Do not answer the ruling question.",
    constraints: [
      "do not output can/cannot, true/false, or a final handling conclusion",
      "use only supplied card text, rule primitives, timeline, and evidence summaries",
      "list missing facts and evidence requirements",
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
