export function evaluateTimingMissBlocker(analysis) {
  if (!analysis || analysis.confirmationLevel === "official_confirmed") return { hasBlocker: false, kind: "none", analysis };
  if (analysis.reasonCode === "optional_when_trigger_missed_timing") return { hasBlocker: true, kind: "analysis_hint", analysis };
  if (["unknown_trigger_wording", "insufficient_event_sequence", "requires_segoc_analysis"].includes(analysis.reasonCode)) return { hasBlocker: true, kind: "insufficient_info", analysis };
  return { hasBlocker: false, kind: "none", analysis };
}

export function buildTimingMissBlockerAnswer(result) {
  if (!result?.hasBlocker) return null;
  const analysis = result.analysis;
  return {
    answerType: "needs_clarification",
    verdict: "insufficient_info",
    shortAnswer: "目前无法确定诱发措辞或事件先后，不能判断是否错过时点。",
    judgeReasoning: [{
      text: "必须先区分可选 when、可选 if 与强制诱发，并确认事件序列。",
      basis: ["rule_domain"],
      refs: analysis.evidenceIds || [],
    }],
    requiredFacts: analysis.missingInfo || [],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
    confirmationLevel: "insufficient_info",
    triggerTimingAnalysis: analysis,
  };
}
