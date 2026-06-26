export function statusLabelForSubAnswer(item = {}) {
  if (item.officialAnswer?.status === "confirmed" || item.status === "confirmed") return "已确认";
  if (item.provisionalAnswer) return "未确认处理方式";
  if (item.conditionalAnswer) return "条件不足";
  if (item.likelyAnswer && item.likelyAnswer.status !== "not_available") return "可能处理（未确认）";
  if (item.status === "inferred") return "可能处理（未确认）";
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
  const likelyAnswerText = item.likelyAnswer && item.likelyAnswer.status !== "not_available"
    ? formatLikelyAnswerText(item.likelyAnswer)
    : null;
  return {
    statusLabel,
    verdictText: formatDisplayVerdict(item.verdict),
    officialStatusLabel: item.officialAnswer?.status === "confirmed" ? "官方确认：已确认" : "官方确认：暂无直接裁定",
    reason: item.displayReason || publicReasonForSubAnswer(item),
    evidenceIds: item.evidenceIds || [],
    conditionalBranches,
    clarificationQuestion: item.clarification?.question || item.conditionalAnswer?.clarificationQuestion || null,
    provisionalText,
    likelyAnswerText,
    riskFlags: item.likelyAnswer?.riskFlags || [],
    debugTraceDefaultCollapsed: true,
  };
}

export function formatLikelyAnswerText(likelyAnswer = {}) {
  const verdict = likelyAnswer.verdict && likelyAnswer.verdict !== "unknown"
    ? `倾向：${formatDisplayVerdict(likelyAnswer.verdict)}。`
    : "";
  const structured = [
    likelyAnswer.issueSummary ? `问题核心：${likelyAnswer.issueSummary}` : "",
    likelyAnswer.possibleHandling ? `未确认分析：${likelyAnswer.possibleHandling}` : "",
    likelyAnswer.whyNotConfirmed ? `为什么不能确认：${likelyAnswer.whyNotConfirmed}` : "",
    likelyAnswer.neededEvidence ? `需要确认：${likelyAnswer.neededEvidence}` : "",
  ].filter(Boolean);
  const body = structured.length ? structured.join(" ") : likelyAnswer.reasoning || "只能给出未确认处理参考。";
  return `${verdict}${body} ${likelyAnswer.disclaimer || "未确认裁定，不能替代官方 Q&A"}`.trim();
}

export function publicReasonForSubAnswer(item = {}) {
  if (item.displayReason) return item.displayReason;
  if (item.cardResolutionIssue) return "卡名没有 exact match，不能自动套用较短候选卡。";
  if (item.provisionalAnswer) return "官方数据库暂无直接裁定；存在事务局回答截图，需要后续复核。";
  if (item.conditionalAnswer) return "已找到相关 FAQ，但当前问题缺少必要状态，无法确定适用哪个分支。";
  if ((item.unresolvedDependencies || []).length) return "该问题依赖另一个子问题的结果，当前不能确认。";
  const reason = String(item.reason || item.reasoning || "");
  if (/conflicting_direct_evidence|conflicting_similar_evidence|冲突/u.test(reason)) return "候选资料结论冲突，不能确认。";
  if (/condition_branch_missing_state|condition_branch_ambiguous/u.test(reason)) return "已找到条件分支证据，但当前场景不足以选择唯一分支。";
  if (/no_direct_evidence|similar_evidence|evidence_mentions_action_but_not_asked_result|no_explicit_polarity/u.test(reason)) return "找到的资料与本题相关，但没有直接回答当前问题。";
  if (/card_text_only/u.test(reason)) return "目前只有卡片文本，没有直接 Q&A。";
  if (/rejected_evidence_only|matcher_rejected_all|different_question|question_type_mismatch/u.test(reason)) return "候选资料回答的是不同问题或场景不一致。";
  if (/parse_failed|formal_query_parse_failed/u.test(reason)) return "形式化解析失败，需要补充卡名、效果编号或问题类型。";
  if (/parser_warning/u.test(reason)) return "形式化解析存在不确定项，不能确认裁定。";
  if (item.status === "confirmed") return "已有 direct evidence 且 verdict 明确。";
  if (item.status === "inferred") return "只有相似证据，不能作为官方确认。";
  return "暂时不能确认，需要官方 Q&A 或补充场景。";
}
