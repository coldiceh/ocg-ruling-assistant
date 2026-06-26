const DISCLAIMER = "未确认裁定，不能替代官方 Q&A";

export function buildLikelyAnswer({
  subQuestion = {},
  formalQuery = {},
  cardTexts = [],
  similarEvidence = [],
  rejectedEvidence = [],
  conditionBranches = [],
  eventTimeline = null,
  dependencies = [],
  unresolvedDependencies = [],
  currentVerdict = "unknown",
  currentStatus = "unknown",
  provisionalAnswer = null,
  cardResolutionIssue = null,
} = {}) {
  if (cardResolutionIssue) {
    return {
      status: "not_available",
      verdict: "unknown",
      reasoning: buildCardResolutionReason(cardResolutionIssue),
      basis: [],
      riskFlags: ["card_name_unresolved"],
      disclaimer: DISCLAIMER,
    };
  }

  if (!subQuestion.type || subQuestion.type === "unknown") {
    return {
      status: "not_available",
      verdict: "unknown",
      reasoning: "问题类型尚未识别，不能生成可靠的未确认处理。请先明确是在问发动条件、处理方式、区域变化还是时点。",
      basis: [],
      riskFlags: ["question_type_unknown"],
      disclaimer: DISCLAIMER,
    };
  }

  if (provisionalAnswer) {
    return {
      status: "provisional",
      verdict: provisionalAnswer.verdict ?? "unknown",
      reasoning: provisionalAnswer.explanation || "存在事务局回答截图，但尚未在官方数据库中找到对应 direct Q&A。",
      basis: ["official_response_screenshot"],
      riskFlags: ["official_database_not_found"],
      disclaimer: DISCLAIMER,
    };
  }

  if (conditionBranches.length) {
    return {
      status: "best_effort",
      verdict: currentVerdict && currentVerdict !== "unknown" ? currentVerdict : "conditional",
      reasoning: buildConditionBranchReason(conditionBranches),
      basis: unique(["condition_branch", eventTimeline ? "event_timeline" : ""]),
      riskFlags: ["condition_branch_requires_state"],
      disclaimer: DISCLAIMER,
    };
  }

  const riskFlags = buildRiskFlags({ similarEvidence, rejectedEvidence, unresolvedDependencies });
  const basis = buildBasis({ cardTexts, similarEvidence, rejectedEvidence, eventTimeline, dependencies });

  if (currentStatus === "inferred" && currentVerdict && currentVerdict !== "unknown") {
    return {
      status: "best_effort",
      verdict: currentVerdict,
      reasoning: "没有 direct Q&A；当前结论只来自相似 Q&A 或非直接证据，不能作为官方确认。",
      basis,
      riskFlags: unique([...riskFlags, "no_direct_evidence"]),
      disclaimer: DISCLAIMER,
    };
  }

  if (similarEvidence.length || rejectedEvidence.length || cardTexts.length || dependencies.length || eventTimeline?.events?.length) {
    return {
      status: "best_effort",
      verdict: "unknown",
      reasoning: buildBestEffortReason({ subQuestion, formalQuery, cardTexts, similarEvidence, rejectedEvidence, dependencies }),
      basis,
      riskFlags: unique([...riskFlags, "no_direct_evidence"]),
      disclaimer: DISCLAIMER,
    };
  }

  return {
    status: "not_available",
    verdict: "unknown",
    reasoning: "目前没有足够的卡片文本、相似 Q&A 或状态线索来生成未确认处理。",
    basis: [],
    riskFlags: ["insufficient_context"],
    disclaimer: DISCLAIMER,
  };
}

function buildCardResolutionReason(issue) {
  const candidates = (issue.candidateCards || []).map((card) => card.name).filter(Boolean);
  const suffix = candidates.length
    ? `系统只找到了较短候选：${candidates.join("、")}，需要玩家确认。`
    : "需要玩家确认具体卡片。";
  return `卡名尚未确认：${issue.unresolvedCardName || "未知卡名"}。${suffix}`;
}

function buildConditionBranchReason(branches) {
  const lines = branches.map((branch) => {
    const condition = branch.conditionText || (branch.normalizedConditions || []).join("+") || "某条件";
    const verdict = branch.verdictText || branch.verdict || "unknown";
    return `如果 ${condition}，则 ${verdict}`;
  });
  return `已找到条件分支证据，但当前场景不足以选择唯一分支。${lines.join("；")}。`;
}

function buildRiskFlags({ similarEvidence, rejectedEvidence, unresolvedDependencies }) {
  const flags = [];
  if (similarEvidence.length) flags.push("similar_evidence_only");
  if (unresolvedDependencies.length) flags.push("unresolved_dependency");
  if ((rejectedEvidence || []).some((item) => /conflict|冲突|conflicting/u.test(item.rejectedReason || item.reason || ""))) {
    flags.push("conflicting_evidence");
  }
  if ((rejectedEvidence || []).some((item) => /different_question|question_type_mismatch|card_and_question_type_mismatch/u.test(item.rejectedReason || item.reason || ""))) {
    flags.push("different_question_evidence");
  }
  return unique(flags);
}

function buildBasis({ cardTexts, similarEvidence, rejectedEvidence, eventTimeline, dependencies }) {
  const basis = [];
  if (cardTexts.length) basis.push("card_text");
  if (similarEvidence.length) basis.push("similar_qa");
  if (eventTimeline?.events?.length) basis.push("event_timeline");
  if (dependencies.length) basis.push("event_timeline");
  if (rejectedEvidence.length && !similarEvidence.length) basis.push("similar_qa");
  return unique(basis);
}

function buildBestEffortReason({ subQuestion, cardTexts, similarEvidence, rejectedEvidence, dependencies }) {
  const parts = [];
  if (cardTexts.length) parts.push("可以参考卡片文本本身的发动条件和处理描述");
  if (similarEvidence.length) parts.push("已找到相似 Q&A，但它不是当前问题的 direct evidence");
  if (rejectedEvidence.length && !similarEvidence.length) parts.push("候选资料存在，但回答的是不同问题或场景不一致");
  if (dependencies.length) parts.push("该问题还依赖其他子问题的结果");
  if (!parts.length) parts.push("目前只有有限的状态线索");
  return `${parts.join("；")}。针对“${subQuestion.sourceText || subQuestion.askedResult || "该问题"}”，只能给出未确认的处理参考，仍需官方 Q&A 或事务局回答确认。`;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
