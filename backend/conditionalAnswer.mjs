const ZONE_CONDITIONS = new Set([
  "remains_on_field",
  "monster_zone",
  "sent_to_graveyard",
  "graveyard",
  "banished",
  "banished_zone",
]);

export function buildConditionalAnswer({
  subQuestion,
  conditionBranches,
  branchSelectorResult,
} = {}) {
  const selection = branchSelectorResult || null;
  if (!selection || !["missing_state", "ambiguous"].includes(selection.status)) return null;
  const sourceBranches = Array.isArray(conditionBranches) ? conditionBranches : [];
  if (!sourceBranches.length) return null;

  const branches = sourceBranches
    .map((branch) => buildDisplayBranch(branch))
    .filter((branch) => branch.evidenceIds.length > 0);
  if (!branches.length) return null;

  const missingInfo = buildMissingInfo(subQuestion, selection, branches);
  const clarificationQuestion = missingInfo[0]?.questionToAsk || "";
  const reason = selection.status === "ambiguous"
    ? "已找到相关 FAQ/Q&A，但有多个条件分支都可能适用，当前无法确定唯一结论。"
    : "已找到相关 FAQ/Q&A，但当前问题缺少必要状态，无法确定唯一结论。";

  return {
    kind: "conditional_answer",
    questionId: String(subQuestion?.id || subQuestion?.questionId || "unknown"),
    status: "unknown",
    reason,
    branches,
    missingInfo,
    clarificationQuestion,
  };
}

function buildDisplayBranch(branch) {
  const conditions = Array.isArray(branch?.normalizedConditions) ? branch.normalizedConditions : [];
  return {
    label: labelForConditions(conditions, branch?.conditionText),
    conditions,
    verdict: branch?.verdict || "unknown",
    explanation: explanationForVerdict(branch?.verdict, branch?.verdictText),
    evidenceIds: collectEvidenceIds(branch),
  };
}

function collectEvidenceIds(branch) {
  const ids = [
    ...(Array.isArray(branch?.evidenceIds) ? branch.evidenceIds : []),
    branch?.evidenceId,
    branch?.id,
  ];
  return [...new Set(ids.map((item) => String(item || "").trim()).filter(Boolean))];
}

function labelForConditions(conditions, fallbackText = "") {
  const set = new Set(conditions);
  if (set.has("remains_on_field") || set.has("monster_zone") || set.has("not_destroyed_by_battle")) {
    return "如果仍在怪兽区域";
  }
  if (set.has("sent_to_graveyard") || set.has("graveyard")) return "如果已经送去墓地";
  if (set.has("banished") || set.has("banished_zone")) return "如果已经被除外";
  return fallbackText ? `如果满足条件：${fallbackText}` : "如果满足该证据分支条件";
}

function explanationForVerdict(verdict, fallbackText = "") {
  const labels = {
    activates_on_field: "在怪兽区域发动。",
    activates_in_graveyard: "在墓地发动。",
    activates_while_banished: "在除外状态发动。",
    can_banish: "可以除外。",
    cannot_banish: "不能除外。",
    sent_to_graveyard: "送去墓地。",
    not_sent_to_graveyard: "不送去墓地。",
    banished_temporarily: "暂时除外。",
    returns_to_original_zone: "返回原本区域。",
  };
  return labels[verdict] || fallbackText || "该分支结论仍需核对。";
}

function buildMissingInfo(subQuestion, selection, branches) {
  const missing = new Set(selection?.missingConditions || []);
  for (const branch of branches) {
    for (const condition of branch.conditions || []) {
      if (ZONE_CONDITIONS.has(condition)) missing.add(condition);
    }
  }

  if ([...missing].some((condition) => ZONE_CONDITIONS.has(condition))) {
    const card = normalizeCardName(subQuestion?.card);
    return [{
      field: "current_zone",
      questionToAsk: `请补充：这个时点${card}是仍在怪兽区域、已经送去墓地，还是已经被除外？`,
      options: ["仍在怪兽区域", "已经送去墓地", "已经被除外"],
    }];
  }

  const fields = [...missing].filter(Boolean);
  if (!fields.length) return [];
  return [{
    field: fields.join(","),
    questionToAsk: `请补充：当前问题还缺少这些状态：${fields.join("、")}。`,
    options: fields,
  }];
}

function normalizeCardName(value) {
  const card = String(value || "").trim();
  return card && card !== "unknown" ? card : "该怪兽";
}
