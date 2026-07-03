export const EVIDENCE_GRADES = Object.freeze([
  "official_direct", "official_derived", "rule_derived", "similar_only",
  "insufficient", "illegal_question", "needs_card_confirmation",
]);

export function evidenceGradeFor(answer = {}, context = {}) {
  if (answer.status === "needs_card_confirmation" || answer.verdict === "needs_card_confirmation") return "needs_card_confirmation";
  if (answer.status === "illegal_question" || answer.primaryVerdict === "original_chain_illegal") return "illegal_question";
  if (answer.evidenceGrade && EVIDENCE_GRADES.includes(answer.evidenceGrade)) return answer.evidenceGrade;
  if (answer.answerType === "direct_official" || answer.mode === "confirmed") return "official_direct";
  if (answer.answerType === "official_case_based") return "official_derived";
  if (answer.answerType === "rule_judgment" || answer.confirmationLevel === "rule_derived") return "rule_derived";
  if (answer.mode === "inferred" || context.hasSimilarEvidence) return "similar_only";
  return "insufficient";
}

export function statusForProgramVerdict(answer = {}) {
  if (answer.status === "needs_card_confirmation" || answer.verdict === "needs_card_confirmation") return "needs_card_confirmation";
  if (answer.status === "illegal_question" || answer.primaryVerdict === "original_chain_illegal") return "illegal_question";
  if (answer.verdict === "cannot_activate" || answer.primaryVerdict === "cannot_activate") return "cannot_activate";
  if (["resolved", "partially_resolved", "failed", "insufficient"].includes(answer.status)) return answer.status;
  if (answer.answerType === "direct_official") return "confirmed";
  if (answer.answerType === "official_case_based") return "official_derived";
  if (answer.answerType === "rule_judgment") return "rule_derived";
  if (["needs_clarification", "cannot_answer_safely"].includes(answer.answerType)) return "insufficient";
  return answer.status || answer.mode || "insufficient";
}

export function applyProgramVerdictPolicy(programResult = {}, explanationDraft = "") {
  const draft = String(explanationDraft || "").trim();
  const conflict = explanationConflictsWithProgram(draft, programResult);
  return {
    ...programResult,
    explanationDraft: conflict ? "" : draft,
    warnings: [...new Set([
      ...(programResult.warnings || []),
      ...(conflict ? ["model_explanation_conflict_rejected"] : []),
    ])],
  };
}

function explanationConflictsWithProgram(text, result) {
  if (!text) return false;
  const status = statusForProgramVerdict(result);
  const verdict = String(result.verdict || result.primaryVerdict || status);
  const activationRejected = ["cannot_activate", "illegal_question"].includes(status)
    || /cannot_activate|activation_illegal|original_chain_illegal/u.test(verdict);
  if (activationRejected && /(?:可以|能够|能)发动|can activate|activation (?:is )?(?:legal|allowed)/iu.test(text)) return true;
  if (["failed", "partially_resolved", "insufficient"].includes(status)
    && /全部(?:处理|执行)?成功|完整处理|fully resolved|all (?:parts )?succeeded|resolution succeeded/iu.test(text)) return true;
  if (status === "resolved" && /处理失败|没有处理|未处理|resolution failed|did not resolve/iu.test(text)) return true;
  return false;
}
