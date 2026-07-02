export const DAMAGE_STEP_SUBPHASES = Object.freeze([
  "damage_step_start",
  "before_damage_calculation",
  "during_damage_calculation",
  "after_damage_calculation",
  "damage_step_end",
  "unknown_damage_step_timing",
]);

export const DAMAGE_STEP_ALLOWED_CATEGORIES = Object.freeze([
  "counter_trap_activation",
  "negate_activation",
  "negate_effect_activation",
  "modify_atk_def",
  "trigger_effect_that_specifically_triggers_in_damage_step",
  "mandatory_trigger_required_by_rules",
  "effect_that_states_damage_step_allowed",
]);

export const DAMAGE_STEP_RESTRICTED_CATEGORIES = Object.freeze([
  "generic_quick_effect_without_damage_step_permission",
  "generic_ignition_effect",
  "normal_spell_or_trap_activation_without_specific_permission",
  "search_or_draw_generic_effect_without_damage_step_permission",
  "non_timing_appropriate_trigger",
]);

export function detectDamageStepSubphase(input = "") {
  const text = normalize(input);
  if (/伤害步骤开始|ダメージステップ開始|start of (?:the )?damage step/iu.test(text)) return "damage_step_start";
  if (/伤害计算前|ダメージ計算前|before damage calculation/iu.test(text)) return "before_damage_calculation";
  if (/伤害计算时|伤害计算中|ダメージ計算時|during damage calculation/iu.test(text)) return "during_damage_calculation";
  if (/伤害计算后|ダメージ計算後|after damage calculation/iu.test(text)) return "after_damage_calculation";
  if (/伤害步骤结束|ダメージステップ終了|end of (?:the )?damage step/iu.test(text)) return "damage_step_end";
  if (/伤害步骤|ダメージステップ|damage step/iu.test(text)) return "unknown_damage_step_timing";
  return null;
}

export function classifyDamageStepEffect({ question = "", effectText = "", cardType = "" } = {}) {
  const effect = normalize(effectText);
  const text = normalize(`${effectText}\n${question}`);
  const type = normalize(cardType);
  if (/反击陷阱|counter trap/iu.test(`${type}\n${effect}`)) return "counter_trap_activation";
  if (/效果的发动无效|效果发动无效|効果の発動を無効|negate the activation of (?:that|an?) effect/iu.test(effect)) return "negate_effect_activation";
  if (/发动无效|発動を無効|negate (?:its|the|that) activation/iu.test(effect)) return "negate_activation";
  if (/伤害步骤.{0,12}(?:也)?(?:可以|能)发动|ダメージステップでも発動|can be activated during the damage step/iu.test(effect)) return "effect_that_states_damage_step_allowed";
  if (/(?:攻击力|守备力|atk|def).{0,24}(?:上升|下降|增加|减少|变成|成为|改变|gain|lose|become|change)/iu.test(effect)
    || /(?:上升|下降|增加|减少|变成|改变).{0,24}(?:攻击力|守备力|atk|def)/iu.test(effect)) return "modify_atk_def";
  if (/(?:伤害步骤开始|伤害计算前|伤害计算后|伤害步骤结束).{0,24}(?:发动|诱发)|(?:ダメージステップ開始|ダメージ計算前|ダメージ計算後).{0,24}発動/iu.test(effect)) return "trigger_effect_that_specifically_triggers_in_damage_step";
  if (/必须发动|强制发动|必ず発動|must activate/iu.test(effect)) return "mandatory_trigger_required_by_rules";
  if (/快速效果|诱发即时效果|quick effect/iu.test(effect)) return "generic_quick_effect_without_damage_step_permission";
  if (/起动效果|主要阶段.{0,12}发动|ignition effect/iu.test(effect)) return "generic_ignition_effect";
  if (/(?:抽|加入手卡|检索|draw|add .{0,12} to (?:your )?hand)/iu.test(effect)) return "search_or_draw_generic_effect_without_damage_step_permission";
  if (/(?:通常魔法|通常陷阱|normal spell|normal trap)/iu.test(`${type}\n${effect}`)) return "normal_spell_or_trap_activation_without_specific_permission";
  if (/诱发效果|trigger effect/iu.test(effect)) return "non_timing_appropriate_trigger";
  return "unknown";
}

export function buildDamageStepAnalysis({ question = "", phase = "", effectText = "", cardType = "", officialDirectEvidence = false, officialVerdict = "unknown", evidenceIds = [] } = {}) {
  const subphase = detectDamageStepSubphase(`${phase}\n${question}`);
  const isDamageStep = Boolean(subphase);
  const effectCategory = classifyDamageStepEffect({ question, effectText, cardType });
  const base = {
    isDamageStep,
    subphase: subphase || "unknown_damage_step_timing",
    effectCategory,
    allowedInDamageStep: "unknown",
    verdict: "continue_activation_check",
    reasonCode: isDamageStep ? "damage_step_analysis_pending" : "not_damage_step",
    missingInfo: [],
    confirmationLevel: "conditional",
    evidenceIds: officialDirectEvidence ? [...new Set(evidenceIds.map(String))] : [],
  };
  if (!isDamageStep) return base;
  if (officialDirectEvidence) {
    const positive = ["can_activate", "can", "yes", "applies"].includes(officialVerdict);
    const negative = ["cannot_activate", "cannot", "no", "does_not_apply"].includes(officialVerdict);
    return {
      ...base,
      allowedInDamageStep: positive ? true : negative ? false : "unknown",
      verdict: negative ? "cannot_activate" : positive ? "continue_activation_check" : "insufficient_info",
      reasonCode: "official_direct_evidence_controls_damage_step_result",
      confirmationLevel: "official_confirmed",
    };
  }
  if (DAMAGE_STEP_RESTRICTED_CATEGORIES.includes(effectCategory)) {
    return {
      ...base,
      allowedInDamageStep: false,
      verdict: "activation_illegal_or_unsupported_in_damage_step",
      reasonCode: "damage_step_category_restricted_without_permission",
      confirmationLevel: "rule_derived",
    };
  }
  if (["counter_trap_activation", "negate_activation", "negate_effect_activation", "effect_that_states_damage_step_allowed", "trigger_effect_that_specifically_triggers_in_damage_step", "mandatory_trigger_required_by_rules"].includes(effectCategory)) {
    return { ...base, allowedInDamageStep: true, reasonCode: "damage_step_category_allowed", confirmationLevel: "rule_derived" };
  }
  if (effectCategory === "modify_atk_def") {
    if (subphase === "before_damage_calculation" || subphase === "damage_step_start") {
      return { ...base, allowedInDamageStep: true, reasonCode: "atk_def_modifier_allowed_in_identified_window", confirmationLevel: "rule_derived" };
    }
    return {
      ...base,
      verdict: "insufficient_info",
      reasonCode: "damage_step_subphase_required",
      missingInfo: ["请说明是伤害计算前、伤害计算时、伤害计算后，还是伤害步骤结束时。"],
      confirmationLevel: "insufficient_info",
    };
  }
  return {
    ...base,
    verdict: "insufficient_info",
    reasonCode: subphase === "unknown_damage_step_timing" ? "damage_step_subphase_required" : "damage_step_effect_category_unknown",
    missingInfo: [
      ...(subphase === "unknown_damage_step_timing" ? ["请说明具体的伤害步骤子阶段。"] : []),
      "请提供该效果的官方文本，以确认效果类别。",
      "请确认是否有官方 Q&A 直接说明该效果能否在此时点发动。",
    ],
    confirmationLevel: "insufficient_info",
  };
}

export function cardProfileRuleText(profiles = []) {
  return (profiles || []).map((profile) => [
    profile.effectText,
    profile.raw?.effectText,
    ...(Object.values(profile.sections || {}).flatMap((items) => (items || []).map((item) => typeof item === "string" ? item : item.text))),
  ].filter(Boolean).join(" ")).filter(Boolean).join("\n");
}

function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase(); }
