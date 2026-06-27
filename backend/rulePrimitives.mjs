const SOURCE_BASIS = ["rulebook", "card_text", "official_faq_analogy"];

export const RULE_PRIMITIVES = [
  {
    id: "damage_step_timing",
    name: "伤害步骤时点与里侧怪兽翻开",
    appliesWhen: (input) => hasAny(input, [
      /伤害步骤|伤害计算|里侧守备|被攻击|damage step|before damage calculation/iu,
      "damage_step_timing",
      "damage_step_activation",
    ]),
    derive: deriveDamageStepTiming,
    requiredFacts: ["attack_declared", "damage_step_window"],
    assumptions: [],
    riskFlags: [],
    sourceBasis: SOURCE_BASIS,
  },
  {
    id: "battle_position_and_attack_target",
    name: "表示形式变化与战斗继续",
    appliesWhen: (input) => hasAny(input, [
      /攻击表示|守备表示|直接攻击|攻击对象|战斗继续|守备表示.{0,12}攻击/iu,
      "battle_position_and_attack_target",
      "direct_attack_permission",
      "attack_target_restriction",
    ]),
    derive: deriveBattlePosition,
    requiredFacts: ["attacker_position", "attack_target_state"],
    assumptions: [],
    riskFlags: [],
    sourceBasis: SOURCE_BASIS,
  },
  {
    id: "effect_immunity_during_resolution",
    name: "同一效果处理中的抗性适用",
    appliesWhen: (input) => input.concepts.has("effect_immunity_during_resolution") || (
      /效果处理|处理中|成为.{0,8}(素材|超量素材)|叠放|特殊召唤.{0,20}素材/iu.test(input.questionText)
      && /不受.{0,12}效果影响/iu.test(input.text)
    ),
    derive: deriveEffectImmunity,
    requiredFacts: ["same_effect_resolution", "immunity_applies_after_summon"],
    assumptions: ["题述素材叠放与特殊召唤属于同一个效果的连续处理"],
    riskFlags: ["same_resolution_immunity_needs_direct_qa_if_exception_exists"],
    sourceBasis: SOURCE_BASIS,
  },
  {
    id: "atk_def_modification",
    name: "攻守数值的设定与持续修正",
    appliesWhen: (input) => hasAny(input, [
      /攻击力|守备力|变为.{0,10}(两倍|一半|倍)|加攻|攻守|ATK|DEF/iu,
      "atk_def_modification",
    ]),
    derive: deriveAtkDefModification,
    requiredFacts: ["modifier_kind", "application_order"],
    assumptions: [],
    riskFlags: [],
    sourceBasis: SOURCE_BASIS,
  },
  {
    id: "simultaneous_processing_order",
    name: "同一效果处理中的状态更新顺序",
    appliesWhen: (input) => hasAny(input, [
      /同时|同一效果处理|失去.{0,8}LP|扣血.{0,8}加攻|那之后|然后/iu,
      "simultaneous_processing_order",
    ]),
    derive: deriveSimultaneousProcessing,
    requiredFacts: ["multi_part_effect"],
    assumptions: [],
    riskFlags: [],
    sourceBasis: SOURCE_BASIS,
  },
  {
    id: "copy_effect_scope",
    name: "复制效果的文本范围",
    appliesWhen: (input) => hasAny(input, [
      /复制.{0,20}效果|变成.{0,30}效果相同|效果外文本|额外发动方式/iu,
      "copy_effect",
      "copy_effect_scope",
    ]),
    derive: deriveCopyEffectScope,
    requiredFacts: ["copied_effect_text", "activation_procedure_text"],
    assumptions: [],
    riskFlags: ["copy_wording_requires_source_text_comparison"],
    sourceBasis: SOURCE_BASIS,
  },
  {
    id: "reveal_same_card_procedure",
    name: "同一张卡再次展示的发动手续",
    appliesWhen: (input) => hasAny(input, [
      /再次.{0,8}(展示|给对手观看|公开)|同一张手卡|展示.{0,12}(手续|cost|代价)/iu,
      "reveal_same_card",
      "reveal_same_card_procedure",
    ]),
    derive: deriveRevealSameCard,
    requiredFacts: ["same_physical_card", "reveal_is_procedure"],
    assumptions: ["第一次展示后该卡仍留在手卡且未被其他处理改变"],
    riskFlags: ["same_chain_reveal_needs_card_specific_restriction_check"],
    sourceBasis: SOURCE_BASIS,
  },
];

export function selectRulePrimitives(input = {}) {
  const normalized = normalizePrimitiveInput(input);
  return RULE_PRIMITIVES.filter((primitive) => primitive.appliesWhen(normalized));
}

export function deriveRulePrimitiveResults(input = {}) {
  const normalized = normalizePrimitiveInput(input);
  return selectRulePrimitives(normalized)
    .map((primitive) => ({ primitive, result: primitive.derive(normalized) }))
    .filter(({ result }) => result && Array.isArray(result.steps) && result.steps.length);
}

export function normalizePrimitiveInput(input = {}) {
  const originalQuestion = String(input.originalQuestion || input.formalQuery?.originalText || "");
  const resolvedCards = Array.isArray(input.resolvedCards) ? input.resolvedCards : [];
  const cardTexts = [
    ...resolvedCards.map((card) => ({
      id: card.id || card.passcode || card.name,
      name: card.name || card.cnName || card.jaName || card.enName || "unknown",
      text: card.effectText || card.text || "",
      sourceUrl: card.sourceUrl || card.ygoResourcesUrl || "",
    })),
    ...(input.cardTexts || []).map((record) => ({
      id: record.evidenceId || record.id || record.cardId || record.title,
      name: record.card || record.cardName || record.title || "unknown",
      text: record.conclusion || record.effectText || record.text || record.textPreview || "",
      sourceUrl: record.sourceUrl || "",
    })),
  ];
  const concepts = new Set([
    ...(Array.isArray(input.ruleConcepts) ? input.ruleConcepts : input.ruleConcepts?.concepts || []),
    ...(input.ruleConceptAnalysis?.concepts || []),
  ]);
  const questionText = [
    originalQuestion,
    input.formalQuery?.scenario?.rawContext,
    ...(input.formalQuery?.subQuestions || []).flatMap((item) => [item.sourceText, item.askedResult, item.type]),
  ].filter(Boolean).join("\n");
  const text = [
    questionText,
    ...cardTexts.map((item) => `${item.name} ${item.text}`),
  ].filter(Boolean).join("\n");
  return { ...input, originalQuestion, resolvedCards, cardTexts, concepts, questionText, text };
}

function deriveDamageStepTiming(input) {
  const steps = [];
  const related = relatedCardNames(input, /伤害步骤开始时|damage step.{0,12}start/iu);
  const relatedLabel = related.length ? `（${related.join("、")}）` : "";
  if (/里侧守备|里侧表示/iu.test(input.text)) {
    steps.push(step(
      "damage_step_start",
      `${relatedLabel}伤害步骤开始时早于伤害计算前的翻开检查。`,
      related,
      input,
    ));
    steps.push(step(
      "face_down_flipped_before_damage_calculation",
      "被攻击的里侧守备怪兽通常到伤害计算前才翻为表侧；在此之前，依赖表侧存在的持续效果尚未适用。",
      relatedCardNames(input, /里侧|守备表示|表侧/iu),
      input,
    ));
  } else {
    steps.push(step(
      "before_damage_calculation",
      "必须先定位当前处于伤害步骤开始时、伤害计算前、伤害计算时、伤害计算后或伤害步骤结束时。",
      [],
      input,
    ));
  }
  if (related.length && /破坏/iu.test(input.text)) {
    steps.push(step(
      "damage_step_start_effect_resolves_before_flip",
      `${relatedLabel}伤害步骤开始时发动的破坏处理会在里侧对象因战斗翻开前处理，因此不能倒用该怪兽翻开后才适用的持续效果。`,
      related,
      input,
    ));
  }
  return {
    concepts: unique(["damage_step_timing", "damage_step_start", "before_damage_calculation", ...(steps.some((item) => item.step === "face_down_flipped_before_damage_calculation") ? ["face_down_flipped_before_damage_calculation"] : [])]),
    steps,
    verdictHint: related.length ? "伤害步骤开始时的效果先于里侧怪兽翻开处理" : "按具体伤害步骤窗口判断",
    shortAnswer: related.length ? "伤害步骤开始时的效果先处理；里侧怪兽到伤害计算前才翻开。" : "先区分伤害步骤的具体窗口，再判断效果与战斗处理。",
  };
}

function deriveBattlePosition(input) {
  const steps = [];
  const defenseAttackers = relatedCardNames(input, /守备表示.{0,20}(攻击|进行攻击)|守備表示.{0,20}攻撃/iu);
  const damageStepAttackers = relatedCardNames(input, /伤害步骤开始时|damage step.{0,12}start/iu);
  const attackPositionNames = resolveMentionNames(input, extractPositionMentions(input.originalQuestion, "攻击表示"));
  const ordinaryAttackers = attackPositionNames.filter((name) => !damageStepAttackers.includes(name));
  const positionControllers = relatedCardNames(input, /表侧表示怪兽变为守备表示|表側表示モンスター.{0,12}守備表示/iu);
  if (/攻击表示|守备表示|表示形式/iu.test(input.text)) {
    steps.push(step(
      "battle_position_change",
      `${ordinaryAttackers.length ? `${ordinaryAttackers.join("、")}等通常攻击者` : "攻击怪兽"}在伤害计算前变为守备表示时，通常不再保持可进行该次攻击的状态，战斗会停止。`,
      unique([...positionControllers, ...ordinaryAttackers]),
      input,
    ));
  }
  if (defenseAttackers.length || /守备表示.{0,16}(作出攻击|进行攻击)/iu.test(input.text)) {
    steps.push(step(
      "defense_position_attack",
      `${defenseAttackers.length ? defenseAttackers.join("、") : "文本明确允许守备表示攻击的怪兽"}可在守备表示攻击；因此变为守备表示本身不会使该次战斗停止，并按该文本指定的数值进行伤害计算。`,
      defenseAttackers,
      input,
    ));
  }
  if (/里侧守备|攻击对象|作出攻击/iu.test(input.text)) {
    steps.push(step(
      "attack_target_restriction",
      "战斗是否继续取决于攻击怪兽在伤害计算前是否仍具备合法攻击状态；攻击对象翻开并不等同于重新选择攻击对象。",
      [],
      input,
    ));
  }
  return {
    concepts: unique(["battle_position_and_attack_target", "battle_position_change", "attack_target_restriction", ...(defenseAttackers.length ? ["defense_position_attack"] : [])]),
    steps,
    verdictHint: defenseAttackers.length ? "普通攻击者转守后停止战斗；可守备表示攻击者继续战斗" : "攻击者转为守备表示后通常停止该次战斗",
    shortAnswer: defenseAttackers.length
      ? "普通攻击怪兽转为守备表示后停止战斗；明确允许守备表示攻击的怪兽仍可继续。"
      : "攻击怪兽若在伤害计算前失去可攻击状态，该次战斗通常停止。",
  };
}

function deriveEffectImmunity(input) {
  if (!/效果处理|处理中|特殊召唤|作为.{0,8}(超量)?素材|叠放/iu.test(input.text)) return null;
  const immuneCards = relatedCardNames(input, /不受.{0,12}效果影响/iu);
  return {
    concepts: ["effect_immunity_during_resolution", "material_attach_during_resolution", "same_effect_resolution", "effect_already_processing"],
    steps: [
      step("same_effect_resolution", "特殊召唤与后续素材叠放若写在同一效果处理中，应作为同一次正在进行的效果处理连续判断。", [], input),
      step("effect_already_processing", "怪兽特殊召唤后开始适用的不受影响状态，不会把已经进入处理流程的同一效果追溯为未处理。", immuneCards, input),
      step("material_attach_during_resolution", "因此，在没有相反特例裁定的前提下，后续将指定卡叠放为超量素材的处理应继续进行。", immuneCards, input),
    ],
    verdictHint: "material_attaches_during_same_resolution",
    shortAnswer: "按同一效果处理的连续性推导，素材叠放应正常进行；新适用的抗性不倒过来中断已在处理的效果。",
  };
}

function deriveAtkDefModification(input) {
  if (!/攻击力|守备力|ATK|DEF/iu.test(input.text)) return null;
  const setCards = relatedCardNames(input, /(?:攻击力|攻撃力).{0,18}(?:变为|は).{0,10}(?:倍|两倍|半分|一半)/iu);
  const continuousCards = relatedCardNames(input, /装备怪兽的攻击力变为|装備モンスターの攻撃力/iu);
  const statedValues = extractStatedValuePair(input.originalQuestion);
  const statedFinal = statedValues.final;
  const steps = [
    step("continuous_modifier_reapply", `持续效果会在游戏状态变化时重新适用；生命值关系改变后，装备效果先按新的条件更新当前攻击力${statedValues.intermediate ? `为题述中间值 ${statedValues.intermediate}` : ""}。`, continuousCards, input),
    step("set_attack_value", `随后处理的发动型“攻击力变为／倍化”效果以当时的攻击力为基准设定新的处理结果${statedFinal && statedValues.intermediate ? `，即由 ${statedValues.intermediate} 变为 ${statedFinal}` : ""}。`, setCards, input),
    step("atk_value_lock", "该设定处理完成后，先前持续修正的移除不会自动把已经设定的数值倒回处理前的中间值，除非文本或规则要求重新计算。", unique([...setCards, ...continuousCards]), input),
  ];
  if (/失去.{0,8}LP|扣血/iu.test(input.text)) {
    steps.unshift(step("lp_change_before_atk_setting", "同一效果先执行失去 LP 的部分；该状态变化会立即影响依赖双方 LP 高低的持续效果，然后才执行后续攻击力设定。", setCards, input));
  }
  return {
    concepts: unique(["atk_def_modification", "continuous_modifier_reapply", "set_attack_value", "atk_value_lock", ...(steps.some((item) => item.step === "lp_change_before_atk_setting") ? ["lp_change_before_atk_setting"] : []), ...(statedFinal ? [`final_atk_${statedFinal}`] : [])]),
    steps,
    verdictHint: statedFinal ? `final_atk_${statedFinal}` : "set_attack_value_remains_after_prior_modifier_removed",
    shortAnswer: statedFinal
      ? `按处理顺序，最终攻击力应为 ${statedFinal}；之后移除先前的持续修正不会把已设定数值改回中间值。`
      : "先更新持续修正，再执行发动型数值设定；之后移除先前修正通常不改写已设定结果。",
  };
}

function deriveSimultaneousProcessing(input) {
  if (!/同时|同一效果处理|失去.{0,8}LP|扣血|那之后|然后/iu.test(input.text)) return null;
  return {
    concepts: ["simultaneous_processing_order"],
    steps: [
      step("simultaneous_processing_order", "多个部分属于同一效果处理，不代表处理中间不存在先后；每完成一个处理动作，相关持续效果会按新的游戏状态重新适用。", [], input),
      step("state_update_within_resolution", "因此应按卡片文本顺序记录 LP、区域、表示形式或数值变化，再把更新后的状态交给后续处理。", [], input),
    ],
    verdictHint: "same_effect_has_ordered_state_updates",
    shortAnswer: "同一效果中的处理可以在结算完成时视为一体，但内部仍按文本顺序更新游戏状态。",
  };
}

function deriveCopyEffectScope(input) {
  return {
    concepts: ["copy_effect_scope", "copy_effect", "activation_procedure", "effect_text_scope"],
    steps: [
      step("copy_effect_scope", "先确定复制文本指向的是“发动时的效果处理”还是整段卡片文本；复制处理内容不当然等于复制原卡的全部文字。", [], input),
      step("activation_procedure", "“这张卡也能……来发动”、发动条件、支付 cost 与发动位置属于发动手续或额外发动方式，应与效果处理内容分开判断。", [], input),
      step("effect_text_scope", "只有复制效果的原文或官方类例明确把这些手续纳入复制范围时，才能一并适用。", [], input),
    ],
    verdictHint: "copied_effect_does_not_automatically_include_activation_procedure",
    shortAnswer: "按文本结构推导，复制效果处理内容不当然复制额外发动方式或效果外文本。",
  };
}

function deriveRevealSameCard(input) {
  return {
    concepts: ["reveal_same_card_procedure", "reveal_same_card", "once_per_turn_scope", "chain_timing"],
    steps: [
      step("reveal_is_activation_procedure", "展示手卡若是发动手续，应在每次发动时分别检查该卡此时是否仍在手卡、是否仍可被展示。", [], input),
      step("same_physical_card_reuse", "先前已经展示不等于该卡持续处于公开或被消耗；若它仍在手卡，是否可再次展示取决于文本是否限制同名卡、同一张卡或每回合次数。", [], input),
      step("same_chain_timing", "同一连锁中还要确认 C1 展示后是否有处理改变该卡状态，以及 C3 的卡是否具备当回合发动资格。", [], input),
    ],
    verdictHint: "same_card_may_be_revealed_again_if_still_in_hand_and_not_restricted",
    shortAnswer: "先前展示本身通常不消耗该卡；若仍在手卡且没有次数或同卡限制，规则结构上可再次作为展示手续，但需核对两张卡原文。",
  };
}

function hasAny(input, matchers) {
  return matchers.some((matcher) => {
    if (matcher instanceof RegExp) return matcher.test(input.questionText);
    return input.concepts.has(matcher);
  });
}

function relatedCardNames(input, pattern) {
  return unique(input.cardTexts
    .filter((item) => pattern.test(`${item.name} ${item.text}`))
    .map((item) => item.name)
    .filter((name) => name && name !== "unknown"));
}

function step(stepId, explanation, relatedCards, input) {
  const sourceRefs = unique(input.cardTexts
    .filter((item) => !relatedCards.length || relatedCards.includes(item.name))
    .map((item) => item.sourceUrl || (item.id ? `card:${item.id}` : "")));
  return {
    step: stepId,
    ruleBasis: primitiveRuleBasis(stepId),
    explanation,
    relatedCards: unique(relatedCards),
    sourceRefs,
  };
}

function primitiveRuleBasis(stepId) {
  if (/damage|battle|position|attack_target/u.test(stepId)) return "rulebook";
  if (/copy|activation_procedure|effect_text_scope|reveal/u.test(stepId)) return "card_text";
  return "rulebook + card_text + official_faq_analogy";
}

function extractStatedValuePair(text) {
  const source = String(text || "").normalize("NFKC");
  const match = source.match(/(?:为什么|为何|应为|还是)[^。？！?]{0,20}?(\d{3,6})\s*(?:而不是|不是|而非)\s*(\d{3,6})/u);
  return { final: match?.[1] || "", intermediate: match?.[2] || "" };
}

function extractPositionMentions(text, position) {
  const escaped = position.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...String(text || "").matchAll(new RegExp(`${escaped}的?[「『《]?([^「」『』《》，。；;]{2,30})[」』》]?`, "gu"))]
    .map((match) => match[1].trim());
}

function resolveMentionNames(input, mentions) {
  const results = [];
  for (const mention of mentions) {
    const mentionKey = normalizeName(mention);
    const matched = input.cardTexts.find((card) => {
      const nameKey = normalizeName(card.name);
      return nameKey && (mentionKey === nameKey || mentionKey.includes(nameKey) || nameKey.includes(mentionKey));
    });
    if (matched?.name) results.push(matched.name);
  }
  return unique(results);
}

function normalizeName(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\-－ー・･:："'“”‘’「」『』《》()（）【】\[\]，。；;、？?!！]/gu, "").toLocaleLowerCase();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
