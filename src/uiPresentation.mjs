export function statusLabelForSubAnswer(item = {}) {
  if (item.provisionalAnswer) return "未确认处理方式";
  if (item.conditionalAnswer) return "条件不足";
  if (item.status === "confirmed") return "已确认";
  if (item.status === "inferred") return "相似依据";
  if (item.status === "parse_failed") return "解析失败";
  return "资料不足";
}

export function formatDisplayVerdict(verdict) {
  if (!verdict) return "unknown";
  if (typeof verdict === "object") return JSON.stringify(verdict);
  return String(verdict);
}

export function formatProvisionalVerdictText(verdict, fallback = "") {
  if (verdict && typeof verdict === "object") {
    const activation = verdict.activation === "can_activate" ? "可以发动" : "";
    const cost = verdict.cost === "can_pay_cost" ? "并支付 cost" : "";
    const resolution = verdict.resolution === "does_not_perform_fusion_material_processing"
      ? "但后续处理不进行"
      : "";
    const text = [activation + cost, resolution].filter(Boolean).join("，");
    if (text) return `${text}。`;
  }
  return String(fallback || "截图回答未确认，等待官方数据库收录。");
}

export function buildConditionalBranchLines(conditionalAnswer = {}) {
  return (conditionalAnswer.branches || []).map((branch) => ({
    label: branch.label || "如果满足该分支条件",
    text: branch.explanation || branch.verdict || "unknown",
    evidenceIds: branch.evidenceIds || [],
  }));
}

export function buildUserFacingSubAnswerSummary(item = {}) {
  const statusLabel = statusLabelForSubAnswer(item);
  const conditionalBranches = item.conditionalAnswer
    ? buildConditionalBranchLines(item.conditionalAnswer)
    : [];
  const provisionalText = item.provisionalAnswer
    ? formatProvisionalVerdictText(item.provisionalAnswer.verdict, item.provisionalAnswer.explanation)
    : null;
  return {
    statusLabel,
    verdictText: formatDisplayVerdict(item.verdict),
    reason: item.reason || item.reasoning || "",
    evidenceIds: item.evidenceIds || [],
    conditionalBranches,
    clarificationQuestion: item.conditionalAnswer?.clarificationQuestion || null,
    provisionalText,
    debugTraceDefaultCollapsed: true,
  };
}
