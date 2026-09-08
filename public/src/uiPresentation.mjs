export function statusLabelForSubAnswer(item = {}) {
  if (item.officialAnswer?.status === "confirmed" || item.status === "confirmed") return "官方直接裁定";
  if (item.ruleDerivedAnswer?.status === "rule_derived") return "规则推导结论";
  if (item.provisionalAnswer) return "事务局回答参考";
  if (item.conditionalAnswer) return "条件不足";
  if (item.cardResolutionIssue || item.clarification?.question?.includes("哪张卡")) return "卡名需要确认";
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
  const likelyAnswerText = item.likelyAnswer && item.likelyAnswer.status !== "not_available" && !item.cardResolutionIssue
    ? formatLikelyAnswerText(item.likelyAnswer, item)
    : null;
  const ruleDerivedAnswerText = item.ruleDerivedAnswer?.status === "rule_derived"
    ? formatRuleDerivedAnswerText(item.ruleDerivedAnswer)
    : null;
  return {
    statusLabel,
    verdictText: formatDisplayVerdict(item.verdict),
    officialStatusLabel: item.officialAnswer?.status === "confirmed" ? "官方直接裁定：已确认" : "官方直接裁定：未检索到完全同场景条目",
    reason: item.displayReason || publicReasonForSubAnswer(item),
    evidenceIds: item.evidenceIds || [],
    conditionalBranches,
    clarificationQuestion: item.clarification?.question || item.conditionalAnswer?.clarificationQuestion || fallbackClarificationForSubAnswer(item),
    provisionalText,
    ruleDerivedAnswerText,
    likelyAnswerText,
    riskFlags: item.ruleDerivedAnswer?.riskFlags || item.likelyAnswer?.riskFlags || [],
    debugTraceDefaultCollapsed: true,
  };
}

export function formatRuleDerivedAnswerText(answer = {}) {
  const steps = (answer.reasoningSteps || [])
    .map((item, index) => `${index + 1}. ${item.explanation}`)
    .join(" ");
  const assumptions = (answer.assumptions || []).length
    ? `前提：${answer.assumptions.join("；")}。`
    : "";
  return [
    answer.shortAnswer,
    steps,
    assumptions,
    answer.notice || "未找到完全同场景的直接 Q&A。如存在相反裁定，应以官方数据库或事务局回答为准。",
  ].filter(Boolean).join(" ").trim();
}

export function formatLikelyAnswerText(likelyAnswer = {}, context = {}) {
  const verdict = likelyAnswer.verdict && likelyAnswer.verdict !== "unknown"
    ? `倾向：${formatDisplayVerdict(likelyAnswer.verdict)}。`
    : "";
  const structured = [
    likelyAnswer.issueSummary ? `问题核心：${likelyAnswer.issueSummary}` : "",
    likelyAnswer.possibleHandling ? `未确认分析：${likelyAnswer.possibleHandling}` : "",
    likelyAnswer.whyNotConfirmed ? `为什么不能确认：${likelyAnswer.whyNotConfirmed}` : "",
    likelyAnswer.neededEvidence ? `需要确认：${likelyAnswer.neededEvidence}` : "",
  ].filter(Boolean);
  const body = structured.length ? structured.join(" ") : [
    context.sourceText ? `问题核心：${context.sourceText}` : "",
    `未确认分析：${likelyAnswer.reasoning || "只能给出未确认处理参考。"}`,
    "为什么不能确认：目前没有能直接回答当前问题的官方 Q&A / FAQ。",
    "需要确认：需要能覆盖该场景的官方 Q&A / FAQ / 事务局回答。",
  ].filter(Boolean).join(" ");
  return `${verdict}${body} ${likelyAnswer.disclaimer || "未确认裁定，不能替代官方 Q&A"}`.trim();
}

export function publicReasonForSubAnswer(item = {}) {
  if (item.displayReason) return item.displayReason;
  if (item.cardResolutionIssue) return "卡名没有 exact match，不能自动套用较短候选卡。";
  if (item.ruleDerivedAnswer?.status === "rule_derived") return "没有完全同场景的直接条目；以下结论由公开规则、卡片文本和官方裁定结构推导。";
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

function fallbackClarificationForSubAnswer(item = {}) {
  if (!item || item.status !== "unknown") return null;
  if (item.ruleDerivedAnswer || (item.likelyAnswer && item.likelyAnswer.status !== "not_available") || item.conditionalAnswer || item.provisionalAnswer || item.clarification?.question) return null;
  return "需要确认：请补充正式卡名、效果编号、具体时点，或提供能直接覆盖该场景的官方 Q&A / FAQ。";
}
