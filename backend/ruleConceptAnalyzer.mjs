const CONCEPT_DEFINITIONS = [
  {
    concept: "damage_step_timing",
    patterns: [/伤害步骤开始时/iu, /伤害计算前/iu, /伤害计算时/iu, /伤害计算后/iu, /伤害步骤结束时/iu, /damage step/iu],
  },
  {
    concept: "battle_position_and_attack_target",
    patterns: [/里侧守备/iu, /攻击表示.{0,20}守备表示/iu, /守备表示.{0,20}攻击/iu, /战斗.{0,10}(继续|终止)/iu],
  },
  {
    concept: "effect_immunity_during_resolution",
    patterns: [/不受.{0,12}效果影响/iu, /效果处理途中/iu, /同一效果处理/iu, /作为.{0,10}超量素材/iu],
  },
  {
    concept: "atk_def_modification",
    patterns: [/攻击力.{0,16}(变为|上升|下降|倍)/iu, /守备力.{0,16}(变为|上升|下降|倍)/iu, /交换.{0,10}攻击力/iu],
  },
  {
    concept: "simultaneous_processing_order",
    patterns: [/扣血和加攻.{0,10}同时/iu, /失去.{0,8}LP.{0,20}攻击力/iu, /同一效果处理.{0,16}顺序/iu],
  },
  {
    concept: "copy_effect",
    patterns: [/复制.{0,20}效果/iu, /拷贝.{0,20}效果/iu, /变成.{0,30}效果相同/iu, /變成.{0,30}效果相同/iu, /事务回滚|事務回滾|Transaction Rollback/iu],
  },
  {
    concept: "activation_procedure",
    patterns: [/这张卡也能.{0,30}发动/iu, /這張卡也能.{0,30}發動/iu, /也能.{0,20}来发动/iu, /可以从墓地发动/iu, /墓地から発動/iu, /作为.{0,12}(cost|代价).{0,12}发动/iu, /コストとして.{0,20}発動/iu, /捨てて発動/iu],
  },
  {
    concept: "effect_text_scope",
    patterns: [/效果外文本/iu, /外文本/iu, /发动手续/iu, /发动方式/iu, /发动条件/iu, /效果处理内容/iu, /効果処理/iu],
  },
  {
    concept: "once_per_turn_scope",
    patterns: [/1回合1次/iu, /一回合一次/iu, /once per turn/iu, /１ターンに１度/iu],
  },
  {
    concept: "reveal_same_card",
    patterns: [/再次给.{0,8}观看/iu, /再次展示/iu, /再次公开/iu, /同一张手卡/iu, /同一張手札/iu, /給對方觀看/iu, /给对手观看/iu, /reveal.{0,20}same/iu],
  },
  {
    concept: "direct_attack_permission",
    patterns: [/直接攻击/iu, /直接攻擊/iu, /direct attack/iu, /ダイレクトアタック/iu],
  },
  {
    concept: "attack_target_restriction",
    patterns: [/攻击对象/iu, /攻擊對象/iu, /只能攻击/iu, /只能攻擊/iu, /attack target/iu, /must attack/iu, /攻撃対象/iu],
  },
  {
    concept: "damage_step_activation",
    patterns: [/伤害步骤.{0,12}发动/iu, /伤害计算后.{0,12}发动/iu, /ダメージステップ.{0,12}発動/iu, /damage step.{0,20}activat/iu],
  },
  {
    concept: "chain_timing",
    patterns: [/\bC\s*[0-9]+\b/iu, /连锁链/iu, /連鎖/iu, /chain link/iu, /在这个连锁/iu],
  },
];

export function analyzeRuleConcepts({
  formalQuery = {},
  resolvedCards = [],
  unresolvedCards = [],
  cardTexts = [],
  similarEvidence = [],
  rejectedEvidence = [],
  eventTimeline = null,
} = {}) {
  const text = collectText(formalQuery);
  const concepts = detectConcepts(text);
  const riskFlags = buildRiskFlags({ unresolvedCards, similarEvidence, rejectedEvidence, eventTimeline });
  const clarificationNeeds = buildClarificationNeeds({ concepts, unresolvedCards });
  return {
    concepts,
    issueSummary: buildIssueSummary(concepts, text),
    likelyReasoningSlots: buildReasoningSlots({ concepts, cardTexts, similarEvidence, rejectedEvidence, unresolvedCards }),
    clarificationNeeds,
    riskFlags,
  };
}

export function detectConcepts(text) {
  const source = String(text || "");
  const concepts = [];
  for (const definition of CONCEPT_DEFINITIONS) {
    if (definition.patterns.some((pattern) => pattern.test(source))) concepts.push(definition.concept);
  }
  return [...new Set(concepts)];
}

function collectText(formalQuery = {}) {
  return [
    formalQuery.originalText,
    formalQuery.scenario?.rawContext,
    ...(formalQuery.cards || []).map((card) => card.name),
    ...(formalQuery.subQuestions || []).flatMap((question) => [
      question.sourceText,
      question.type,
      question.askedResult,
      question.card,
    ]),
  ].filter(Boolean).join("\n");
}

function buildIssueSummary(concepts, text) {
  if (hasAll(concepts, ["copy_effect", "activation_procedure", "effect_text_scope"])) {
    return "这个问题的核心是：复制效果时，是否也复制原卡的额外发动方式、发动手续或效果外文本。";
  }
  if (concepts.includes("copy_effect")) {
    return "这个问题的核心是复制效果时，复制范围是否只限于效果处理内容。";
  }
  if (hasAny(concepts, ["reveal_same_card", "once_per_turn_scope", "chain_timing"])) {
    return "这个问题的核心是：同一张手卡在同一连锁中已经作为展示成本或发动手续公开后，是否还能再次被展示来发动另一张卡。";
  }
  if (hasAny(concepts, ["direct_attack_permission", "attack_target_restriction"])) {
    return "这个问题的核心是：直接攻击许可与攻击对象限制效果同时存在时，当前怪兽是否仍能直接攻击。";
  }
  if (concepts.includes("damage_step_activation")) {
    return "这个问题的核心是伤害步骤中是否允许发动该效果。";
  }
  if (String(text || "").trim()) {
    return "这个问题需要先抽出卡片效果文本、发动手续、当前时点和适用中的限制效果，再判断是否存在直接裁定。";
  }
  return "";
}

function buildReasoningSlots({ concepts, cardTexts, similarEvidence, rejectedEvidence, unresolvedCards }) {
  const slots = {
    issueSummary: buildIssueSummary(concepts, ""),
    possibleHandling: "",
    whyNotConfirmed: "没有找到直接回答当前 askedResult 的官方 Q&A / FAQ，因此不能 confirmed。",
    neededEvidence: "需要官方 Q&A / FAQ / 可追溯事务局回答明确覆盖当前场景。",
  };

  if (hasAll(concepts, ["copy_effect", "activation_procedure"])) {
    slots.possibleHandling = "需要区分“效果处理内容”和“发动手续/发动条件/可以发动的方式”。复制通常陷阱效果时，未必等同于复制原卡全部非效果处理文本。";
    slots.neededEvidence = "需要官方资料明确说明复制效果时，是否复制“这张卡也能……来发动”这类额外发动方式或效果外文本。";
  } else if (hasAny(concepts, ["reveal_same_card", "chain_timing"])) {
    slots.possibleHandling = "需要判断同一张手卡在 C1 已经给对手观看后，是否仍能在同一连锁中再次作为展示成本或发动手续被给对手观看。";
    slots.neededEvidence = "需要直接裁定确认：同一张手卡已经展示过的场合，能否再次展示来支付另一张卡或效果的发动手续。";
  } else if (hasAny(concepts, ["direct_attack_permission", "attack_target_restriction"])) {
    slots.possibleHandling = "需要比较直接攻击许可、攻击对象限制、以及场上怪兽位置/是否存在可攻击对象。若卡名尚未确认，不能套用其他卡的攻击文本。";
    slots.neededEvidence = "需要确认相关卡名和适用中效果文本，再查找是否有直接攻击与攻击对象限制并存的官方裁定。";
  } else if (cardTexts.length || similarEvidence.length || rejectedEvidence.length) {
    slots.possibleHandling = "可以参考卡片文本和相似资料拆解问题，但这些资料没有直接覆盖当前 askedResult。";
  }

  if (unresolvedCards.length) {
    const names = unresolvedCards.map((item) => item.unresolvedCardName).filter(Boolean).join("、");
    slots.whyNotConfirmed = `存在未确认卡名（${names || "未知卡名"}），不能把较短候选卡或相似卡自动当作同一张卡。`;
    slots.neededEvidence = "请先确认正式卡名；之后仍需官方 direct evidence 才能 confirmed。";
  }

  return slots;
}

function buildClarificationNeeds({ concepts, unresolvedCards }) {
  const needs = [];
  for (const item of unresolvedCards || []) {
    needs.push({
      field: "card_name",
      question: `请确认你指的是哪张卡：${item.unresolvedCardName}？`,
      options: (item.candidateCards || []).map((card) => card.name).filter(Boolean),
    });
  }
  if (hasAny(concepts, ["direct_attack_permission", "attack_target_restriction"])) {
    needs.push({
      field: "attack_context",
      question: "请确认是否存在其他限制攻击对象、禁止直接攻击、或改变攻击对象的效果。",
      options: ["没有其他效果", "存在其他限制效果", "不确定"],
    });
  }
  return needs;
}

function buildRiskFlags({ unresolvedCards, similarEvidence, rejectedEvidence }) {
  const flags = [];
  if ((unresolvedCards || []).length) flags.push("card_name_unresolved");
  if ((similarEvidence || []).length) flags.push("similar_evidence_only");
  if ((rejectedEvidence || []).some((item) => /conflict|冲突|conflicting/u.test(item.rejectedReason || item.reason || ""))) {
    flags.push("conflicting_evidence");
  }
  if ((rejectedEvidence || []).some((item) => /different_question|question_type_mismatch|card_and_question_type_mismatch/u.test(item.rejectedReason || item.reason || ""))) {
    flags.push("different_question_evidence");
  }
  return [...new Set(flags)];
}

function hasAll(values, required) {
  return required.every((item) => values.includes(item));
}

function hasAny(values, candidates) {
  return candidates.some((item) => values.includes(item));
}
