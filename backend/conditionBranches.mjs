const BRANCH_PATTERNS = [
  {
    pattern: /(?:このカードが)?戦闘で破壊されなかった場合には?モンスターゾーンで|(?:没有|未)(?:被)?战斗破坏.{0,24}(?:怪兽区|场上)|if (?:this card|it) is not destroyed by battle.{0,100}(?:monster zone|on the field)/giu,
    conditions: ["not_destroyed_by_battle", "remains_on_field", "monster_zone"],
    verdict: "activates_on_field",
  },
  {
    pattern: /戦闘で破壊され墓地へ送られた場合には?墓地で|(?:被)?战斗破坏并(?:被)?送(?:去|到)?墓地.{0,24}墓地(?:中)?发动|destroyed by battle and sent to the (?:GY|Graveyard).{0,100}(?:activate|Graveyard)/giu,
    conditions: ["destroyed_by_battle", "sent_to_graveyard", "graveyard"],
    verdict: "activates_in_graveyard",
  },
  {
    pattern: /戦闘で破壊され(?:表側で)?除外された場合には?除外状態で|(?:被)?战斗破坏并(?:被)?除外.{0,24}除外状态(?:中)?发动|destroyed by battle and (?:face-up )?banished.{0,100}(?:activate|banished)/giu,
    conditions: ["destroyed_by_battle", "banished", "banished_zone"],
    verdict: "activates_while_banished",
  },
  {
    pattern: /(?:如果|若|場合|if|when).{0,80}(?:(?:不可以|不能).{0,20}除外|cannot\s+banish)/giu,
    conditions: ["unknown"],
    verdict: "cannot_banish",
  },
  {
    pattern: /(?:如果|若|場合|if|when).{0,80}(?:(?:可以|能够).{0,20}除外|can\s+banish)/giu,
    conditions: ["unknown"],
    verdict: "can_banish",
  },
];

export function extractConditionBranchesFromEvidence(evidence) {
  const evidenceId = String(evidence?.evidenceId || evidence?.id || "unknown");
  const text = evidenceText(evidence);
  const branches = [];
  for (const definition of BRANCH_PATTERNS) {
    for (const match of text.matchAll(definition.pattern)) {
      const source = match[0].trim();
      branches.push({
        conditionText: source,
        normalizedConditions: definition.conditions,
        verdict: definition.verdict,
        verdictText: verdictText(definition.verdict, source),
        sourceSpan: { start: match.index, end: match.index + match[0].length, text: source },
      });
    }
  }

  const deduped = dedupeBranches(branches);
  const warnings = [];
  if (!deduped.length && /(?:場合|如果|若|if |when )/iu.test(text)) warnings.push("conditional_text_without_supported_branch");
  if (deduped.some((branch) => branch.normalizedConditions.includes("unknown"))) warnings.push("branch_contains_unknown_condition");
  return { evidenceId, branches: deduped, warnings };
}

function evidenceText(evidence) {
  if (typeof evidence === "string") return evidence;
  return [evidence?.question, evidence?.title, evidence?.conclusion, evidence?.answer, evidence?.text]
    .filter(Boolean)
    .join("\n");
}

function verdictText(verdict, source) {
  const labels = {
    activates_on_field: "在怪兽区发动",
    activates_in_graveyard: "在墓地发动",
    activates_while_banished: "在除外状态发动",
    can_banish: "可以除外",
    cannot_banish: "不可以除外",
    sent_to_graveyard: "送去墓地",
    not_sent_to_graveyard: "不送去墓地",
  };
  return labels[verdict] || source || "unknown";
}

function dedupeBranches(branches) {
  const map = new Map();
  for (const branch of branches) {
    const key = `${branch.normalizedConditions.slice().sort().join("|")}:${branch.verdict}`;
    if (!map.has(key)) map.set(key, branch);
  }
  return [...map.values()];
}
