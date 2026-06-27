const frameCoverage = {
  copy_or_gain_effect: /复制|得到|获得|卡名.*效果|同じ効果|copy|gain/iu,
  copied_effect_scope: /发动手续|发动条件|效果处理|效果外文本|复制范围|scope|procedure/iu,
  piercing_battle_damage: /贯穿|貫通|守备力.*战斗伤害|piercing/iu,
  unaffected_by_effect: /不受.*效果|抗性|効果を受けない|unaffected/iu,
  continuous_effect_application: /持续|适用|这个回合|永续|continuous/iu,
  activation_legality: /发动|activate/iu,
  effect_resolution: /处理|适用|resolve/iu,
  battle_damage_calculation: /战斗伤害|伤害计算|damage/iu,
  atk_def_modification: /攻击力|守备力|ATK|DEF/iu,
  simultaneous_processing: /同时|然后|那之后|处理/iu,
  damage_step_timing: /伤害步骤|伤害计算|damage step/iu,
  attack_target_legality: /攻击对象|直接攻击|攻击目标|attack target/iu,
  pendulum_effect_scope: /灵摆|P效果|pendulum/iu,
  same_chain_cost_or_procedure: /连锁|费用|手续|展示|cost|chain/iu,
  once_per_turn_scope: /1回合1次|再次|once per turn/iu,
};

const offTopicGroups = [
  { triggers: /超量|Xyz|XYZ|素材|叠放|重叠/iu, terms: [/素材叠放/iu, /超量素材/iu] },
  { triggers: /No\.?\s*41|泥睡魔兽|バグースカ/iu, terms: [/No\.?\s*41/iu, /泥睡魔兽/iu] },
  { triggers: /青眼白龙|Blue-Eyes White Dragon/iu, terms: [/青眼白龙/iu] },
  { triggers: /守备表示攻击|超重武者|伤害计算前|翻开/iu, terms: [/守备表示攻击仍可继续/iu, /攻击怪兽转守后战斗停止/iu, /超重武者/iu] },
];

const internalCodePattern = /\b(?:no_direct_evidence|similar_evidence|question_type_mismatch|matcher_rejected_all|conflicting_direct_evidence|parser_warning)\b/iu;

export function validateJudgeAnswer({ question = "", issueFrames = {}, contextPack = {}, modelAnswer = {} } = {}) {
  const primary = issueFrames.primaryIssueFrames || [];
  const visibleText = answerText(modelAnswer);
  const coveredIssueFrames = primary.filter((frame) => (frameCoverage[frame.id] || /./u).test(visibleText)).map((frame) => frame.id);
  const missingIssueFrames = primary.map((frame) => frame.id).filter((id) => !coveredIssueFrames.includes(id));
  const contextText = contextPackText(contextPack);
  const offTopicTerms = [];
  for (const group of offTopicGroups) {
    if (group.triggers.test(`${question}\n${contextText}`)) continue;
    for (const term of group.terms) {
      const match = visibleText.match(term);
      if (match) offTopicTerms.push(match[0]);
    }
  }
  if (internalCodePattern.test(visibleText)) offTopicTerms.push("internal_reason_code");

  const knownRefs = collectKnownRefs(contextPack);
  const unsupportedClaims = [];
  for (const [index, item] of (modelAnswer.judgeReasoning || []).entries()) {
    if (!item.basis?.length) unsupportedClaims.push(`reasoning_${index + 1}_missing_basis`);
    if (!item.refs?.length) unsupportedClaims.push(`reasoning_${index + 1}_missing_refs`);
    for (const ref of item.refs || []) if (!isValidRef(ref, knownRefs)) unsupportedClaims.push(`invalid_ref:${ref}`);
  }
  if (modelAnswer.answerType === "direct_official") {
    const officialIds = new Set([...(contextPack.officialQaCandidates || []), ...(contextPack.faqCandidates || [])].map((item) => String(item.id)));
    const used = (modelAnswer.judgeReasoning || []).flatMap((item) => item.refs || []);
    if (!used.some((ref) => officialIds.has(String(ref)))) unsupportedClaims.push("direct_official_without_direct_official_ref");
  }
  const staleness = contextPack.staleness || {};
  const usedRefs = (modelAnswer.judgeReasoning || []).flatMap((item) => item.refs || []).map(String);
  const staleIds = new Set((staleness.staleEvidenceIds || []).map(String));
  if (usedRefs.some((ref) => staleIds.has(ref))) unsupportedClaims.push("stale_source_used_as_current_rule");
  if (
    ["direct_official", "rule_judgment"].includes(modelAnswer.answerType)
    && staleness.matchedRuleChanges?.length
    && !(staleness.currentEvidenceIds || []).length
  ) unsupportedClaims.push("missing_current_rule_source");

  const currentNames = [
    ...(contextPack.resolvedCards || []).flatMap((card) => [card.name, card.names?.zh, card.names?.ja, card.names?.en]),
    ...(contextPack.unresolvedCards || []).map((item) => item.unresolvedCardName),
  ].map(clean).filter((item) => item.length >= 2);
  const currentCardsMentioned = currentNames.filter((name) => visibleText.includes(name));
  if (currentNames.length && !currentCardsMentioned.length) unsupportedClaims.push("current_card_not_mentioned");

  if (!modelAnswer.shortAnswer) unsupportedClaims.push("missing_short_answer");
  if ((modelAnswer.judgeReasoning || []).length > 3) unsupportedClaims.push("too_many_reasoning_items");
  if (String(modelAnswer.shortAnswer || "").length > 120 && contextPack.mode !== "analysis") unsupportedClaims.push("duel_short_answer_too_long");
  if (!["direct_official", "rule_judgment", "needs_clarification", "cannot_answer_safely"].includes(modelAnswer.answerType)) unsupportedClaims.push("invalid_answer_type");

  const diagnostics = {
    coveredIssueFrames,
    missingIssueFrames,
    offTopicTerms: [...new Set(offTopicTerms)],
    unsupportedClaims: [...new Set(unsupportedClaims)],
    currentCardsMentioned,
    sourceRefsValid: !unsupportedClaims.some((item) => item.startsWith("invalid_ref:") || item.includes("missing_refs")),
  };
  const ok = !missingIssueFrames.length && !diagnostics.offTopicTerms.length && !diagnostics.unsupportedClaims.length;
  return {
    ok,
    ...(ok ? {} : {
      rejectedReason: rejectionReason(diagnostics),
      fixedAnswer: buildSafeClarification(question, issueFrames, contextPack, diagnostics),
    }),
    diagnostics,
  };
}

export function buildSafeClarification(question, issueFrames = {}, contextPack = {}, diagnostics = {}) {
  const frameIds = (issueFrames.primaryIssueFrames || []).map((frame) => frame.id);
  const cardNames = [
    ...(contextPack.resolvedCards || []).map((card) => card.name),
    ...(contextPack.unresolvedCards || []).map((item) => item.unresolvedCardName),
  ].filter(Boolean);
  const subject = cardNames.slice(0, 2).join("、") || "当前卡片";
  const issueLabel = humanIssueSummary(frameIds);
  const missingSections = (contextPack.cardProfiles || []).flatMap((profile) => profile.missingSections || []);
  const requiredFacts = [
    ...(issueFrames.primaryIssueFrames || []).flatMap((frame) => frame.requiredFacts || []),
    ...missingSections.map((section) => section === "pendulumEffects" ? "请确认相关卡的灵摆效果全文是否已收录" : `请补充缺失的卡片文本分区：${section}`),
    ...(contextPack.unresolvedCards || []).map((item) => `请确认卡名“${item.unresolvedCardName}”`),
  ];
  const refs = (contextPack.relevantCardSections || []).slice(0, 2).map((item) => item.cardId || item.cardName).filter(Boolean);
  return {
    answerType: "needs_clarification",
    verdict: "unknown",
    shortAnswer: trim(`需要补充。${subject}这题涉及${issueLabel}，现有上下文不足以形成可靠规则结论。`, 120),
    judgeReasoning: refs.length ? [{ text: `已按${issueLabel}检查当前卡片文本，但关键状态或文本仍不完整。`, basis: ["card_text"], refs }] : [],
    requiredFacts: [...new Set(requiredFacts)].slice(0, 6),
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
    warnings: diagnostics.offTopicTerms?.length ? ["模型答案包含未触发争点，已拦截。"] : [],
  };
}

function collectKnownRefs(pack) {
  const refs = new Set();
  for (const item of [...(pack.officialQaCandidates || []), ...(pack.faqCandidates || []), ...(pack.ruleSnippets || []), ...(pack.knownAnalogies || [])]) refs.add(String(item.id));
  for (const item of pack.relevantCardSections || []) {
    if (item.cardId) refs.add(String(item.cardId));
    if (item.cardName) refs.add(String(item.cardName));
  }
  return refs;
}

function isValidRef(ref, knownRefs) {
  const value = String(ref);
  return knownRefs.has(value) || [...knownRefs].some((known) => value.startsWith(`${known}:`) || known.startsWith(`${value}:`));
}

function answerText(answer) {
  return clean([answer.shortAnswer, ...(answer.judgeReasoning || []).map((item) => item.text), ...(answer.requiredFacts || [])].join("\n"));
}

function contextPackText(pack) {
  return clean([
    ...(pack.relevantCardSections || []).map((item) => item.text),
    ...(pack.officialQaCandidates || []).map((item) => item.text),
    ...(pack.faqCandidates || []).map((item) => item.text),
    ...(pack.ruleSnippets || []).map((item) => item.text),
  ].join("\n"));
}

function humanIssueSummary(ids) {
  const labels = {
    copy_or_gain_effect: "复制或获得效果",
    copied_effect_scope: "复制范围",
    piercing_battle_damage: "贯穿战斗伤害",
    unaffected_by_effect: "不受效果影响",
    continuous_effect_application: "持续效果的适用主体",
    activation_legality: "发动合法性",
    effect_resolution: "效果处理",
    battle_damage_calculation: "战斗伤害计算",
    atk_def_modification: "攻击力与守备力",
    simultaneous_processing: "同时处理",
    damage_step_timing: "伤害步骤时点",
    attack_target_legality: "攻击对象限制",
    pendulum_effect_scope: "灵摆效果",
    same_chain_cost_or_procedure: "同一连锁中的费用或手续",
    once_per_turn_scope: "一回合一次限制",
  };
  const values = [...new Set(ids.map((id) => labels[id]).filter(Boolean))];
  const visible = values.slice(0, 5).join("、");
  return `${visible || "当前处理"}${values.length > 5 ? "等争点" : ""}`;
}

function rejectionReason(diagnostics) {
  if (diagnostics.offTopicTerms.length) return "off_topic_content";
  if (diagnostics.missingIssueFrames.length) return "primary_issue_not_covered";
  return "unsupported_claims";
}

function clean(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function trim(value, max) {
  return value.length <= max ? value : value.slice(0, max);
}
