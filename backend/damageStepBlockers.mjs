export function evaluateDamageStepBlocker(analysis) {
  if (!analysis?.isDamageStep || analysis.confirmationLevel === "official_confirmed" || analysis.allowedInDamageStep === true) {
    return { hasBlocker: false, kind: "none", analysis };
  }
  if (analysis.allowedInDamageStep === false) return { hasBlocker: true, kind: "activation_restricted", analysis };
  return { hasBlocker: true, kind: "insufficient_info", analysis };
}

export function buildDamageStepBlockerAnswer(result) {
  if (!result?.hasBlocker) return null;
  const analysis = result.analysis;
  const restricted = result.kind === "activation_restricted";
  return {
    answerType: restricted ? "rule_judgment" : "needs_clarification",
    verdict: restricted ? "activation_illegal_or_unsupported_in_damage_step" : "insufficient_info",
    shortAnswer: restricted
      ? "当前效果属于伤害步骤中通常不能发动的类别，且没有明确许可或官方直接裁定支持。"
      : "这个问题涉及伤害步骤，但目前缺少具体子阶段或效果类别，不能唯一裁定。",
    judgeReasoning: [{
      text: restricted
        ? "该效果没有明确的伤害步骤发动许可，不能仅凭普通快速效果性质推定可以发动。"
        : "伤害步骤的可发动范围会随具体子阶段和效果类别变化。",
      basis: ["rule_domain"],
      refs: analysis.evidenceIds || [],
    }],
    requiredFacts: analysis.missingInfo || [],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
    confirmationLevel: restricted ? "rule_derived" : "insufficient_info",
    damageStepAnalysis: analysis,
  };
}
