export function evaluateTimingMissBlocker(analysis) {
  if (!analysis || analysis.confirmationLevel === "official_confirmed") return { hasBlocker: false, kind: "none", analysis };
  if (analysis.reasonCode === "optional_when_trigger_missed_timing") return { hasBlocker: true, kind: "missed_timing", analysis };
  if (["unknown_trigger_wording", "insufficient_event_sequence", "requires_segoc_analysis"].includes(analysis.reasonCode)) return { hasBlocker: true, kind: "insufficient_info", analysis };
  return { hasBlocker: false, kind: "none", analysis };
}

export function buildTimingMissBlockerAnswer(result) {
  if (!result?.hasBlocker) return null;
  const analysis = result.analysis;
  const missed = result.kind === "missed_timing";
  return {
    answerType: missed ? "rule_judgment" : "needs_clarification",
    verdict: missed ? "cannot_activate" : "insufficient_info",
    shortAnswer: missed
      ? "该效果属于“当……时，可以……”的可选诱发，诱发事件不是最后发生的事件，因此错过时点，不能发动。"
      : "目前无法确定诱发措辞或事件先后，不能判断是否错过时点。",
    judgeReasoning: [{
      text: missed
        ? "可选的“当……时”诱发需要检查诱发事件是否是最后发生的事件。"
        : "必须先区分可选 when、可选 if 与强制诱发，并确认事件序列。",
      basis: ["rule_domain"],
      refs: analysis.evidenceIds || [],
    }],
    requiredFacts: analysis.missingInfo || [],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
    confirmationLevel: missed ? "rule_derived" : analysis.confirmationLevel,
    triggerTimingAnalysis: analysis,
  };
}
