import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion } from "../backend/engine.mjs";

export const RULE_DERIVED_GOLDEN_CASES = [
  {
    id: "damage-step-bagooska-three-attackers",
    input: "我方场上有里侧守备表示的「No.41 泥睡魔兽 酣睡貘」，对方场上有攻击表示的「神影依 拿非利」，攻击表示的「青眼白龙」，守备表示的「超重武者 大弁庆-K」。战斗阶段，对方分别用以上三只怪兽向里侧表示的「No.41 泥睡魔兽 酣睡貘」作出攻击的场合，各自能否由战斗或怪兽效果破坏「No.41 泥睡魔兽 酣睡貘」？",
    requiredConcepts: ["damage_step_start", "before_damage_calculation", "face_down_flipped_before_damage_calculation", "attack_target_restriction", "battle_position_change", "defense_position_attack"],
    expectedCards: ["编号41 泥睡魔兽 貘熟梦", "神影依・拿非利", "青眼白龙", "超重武者 大弁庆－K"],
  },
  {
    id: "same-resolution-immunity-material",
    input: "发动在灵摆区域的 霸王黑龙 异色眼叛逆龙-霸王 的灵摆效果，特殊召唤自身后叠放 急袭猛禽-起升反叛猎鹰。这时，根据 霸王黑龙 的效果，可以选择灵摆区域的一张卡作为 究极猎鹰 的超量素材。这张卡会正常成为素材吗？",
    requiredConcepts: ["effect_immunity_during_resolution", "material_attach_during_resolution", "same_effect_resolution", "effect_already_processing"],
    expectedCards: ["霸王黑龙 异色眼反叛龙－霸主", "急袭猛禽－起升反叛猎鹰", "急袭猛禽－究极猎鹰"],
  },
  {
    id: "atk-modifier-order-and-lock",
    input: "下例状况中，正确的「青眼白龙」场上的最终攻击力数值是？自己生命值5000，对方生命值4000，装备自己已发动的「巨大化」的「青眼白龙」向对方怪兽攻击宣言时，发动「才呼粉身」。处理后，对方发动「旋风」把「巨大化」破坏。问题：1. 扣血和加攻时点是否同时？2. 巨大化破坏后为什么攻击力还是12000而不是6000？",
    requiredConcepts: ["simultaneous_processing_order", "lp_change_before_atk_setting", "continuous_modifier_reapply", "atk_value_lock", "set_attack_value", "final_atk_12000"],
    expectedCards: ["青眼白龙", "巨大化", "才呼粉身", "气旋"],
  },
];

const INTERNAL_REASON_PATTERN = /\b(?:no_direct_evidence|conflicting_direct_evidence|similar_evidence|card_text_only|question_type_mismatch|matcher_rejected_all)\b/u;
const EMPTY_ANSWER_PATTERN = /^(?:可以参考卡片文本|需要官方 Q&A|资料不足|没有 direct evidence|找到类似资料但不能确认)[。！!\s]*$/u;

export async function runProductAnswerQuality(options = {}) {
  const cases = options.cases || RULE_DERIVED_GOLDEN_CASES;
  const results = [];
  for (const item of cases) {
    const answer = options.answers?.[item.id] || await answerQuestion(
      { question: item.input },
      { useModel: false, onDemandSync: false, recordAnswerHistory: false }
    );
    results.push(buildQualityCaseResult(item, answer));
  }
  return buildProductAnswerQualityReport(results);
}

export function buildQualityCaseResult(goldenCase, answer = {}) {
  const subAnswers = answer.subAnswers || [];
  const ruleDerivedAnswer = subAnswers
    .map((item) => item.ruleDerivedAnswer)
    .filter(Boolean)
    .sort((left, right) => (right.reasoningSteps?.length || 0) - (left.reasoningSteps?.length || 0))[0] || null;
  const concepts = [...new Set(ruleDerivedAnswer?.concepts || [])];
  const missingConcepts = (goldenCase.requiredConcepts || []).filter((concept) => !concepts.includes(concept));
  const resolvedCards = (answer.cards || []).map((card) => card.name || card.cnName || card.jaName || card.enName).filter(Boolean);
  const unresolvedCardPrompts = (answer.cardResolutionConfirmations || []).map((item) => item.unresolvedCardName).filter(Boolean);
  const missingCardHandling = (goldenCase.expectedCards || []).filter((name) => {
    if (resolvedCards.some((resolved) => normalizeKey(resolved) === normalizeKey(name))) return false;
    return !unresolvedCardPrompts.some((unresolved) => normalizeKey(unresolved) === normalizeKey(name));
  });
  const useful = isUsefulRuleDerived(ruleDerivedAnswer, goldenCase.requiredConcepts || []);
  const officialConfirmed = subAnswers.some((item) => item.officialAnswer?.status === "confirmed" || item.status === "confirmed");
  const unsafeConfirmed = subAnswers.some((item) => item.status === "confirmed" && (!item.evidenceIds?.length || item.verdict === "unknown" || item.ruleDerivedAnswer));
  const visibleText = [ruleDerivedAnswer?.shortAnswer, ...(ruleDerivedAnswer?.reasoningSteps || []).map((item) => item.explanation)].join(" ");
  return {
    id: goldenCase.id,
    input: goldenCase.input,
    officialConfirmed,
    ruleDerivedAnswer,
    concepts,
    missingConcepts,
    resolvedCards,
    unresolvedCardPrompts,
    missingCardHandling,
    useful,
    wrongCardResolution: missingCardHandling.length > 0,
    internalReasonLeaked: INTERNAL_REASON_PATTERN.test(visibleText),
    unsafeConfirmed,
    summary: ruleDerivedAnswer?.shortAnswer || "",
  };
}

export function buildProductAnswerQualityReport(cases = []) {
  return {
    total: cases.length,
    ruleDerivedAnswerCount: cases.filter((item) => item.ruleDerivedAnswer).length,
    usefulRuleDerivedCount: cases.filter((item) => item.useful).length,
    uselessRuleDerivedCount: cases.filter((item) => item.ruleDerivedAnswer && !item.useful).length,
    officialConfirmedCount: cases.filter((item) => item.officialConfirmed).length,
    unresolvedCardPromptCount: cases.reduce((count, item) => count + item.unresolvedCardPrompts.length, 0),
    wrongCardResolutionCount: cases.filter((item) => item.wrongCardResolution).length,
    unsafeConfirmedCount: cases.filter((item) => item.unsafeConfirmed).length,
    internalReasonLeakCount: cases.filter((item) => item.internalReasonLeaked).length,
    cases,
  };
}

export function isUsefulRuleDerived(answer, requiredConcepts = []) {
  if (!answer || answer.status !== "rule_derived") return false;
  if (!String(answer.shortAnswer || "").trim() || EMPTY_ANSWER_PATTERN.test(String(answer.shortAnswer || "").trim())) return false;
  if (!Array.isArray(answer.reasoningSteps) || answer.reasoningSteps.length < 2) return false;
  if (!Array.isArray(answer.concepts) || answer.concepts.length < 2) return false;
  if (requiredConcepts.some((concept) => !answer.concepts.includes(concept))) return false;
  if (!answer.verdict || answer.verdict === "unknown") return false;
  if (answer.counterEvidenceChecked !== true) return false;
  if (!String(answer.notice || "").includes("直接 Q&A")) return false;
  return true;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\-－ー・･:："'“”‘’「」『』《》()（）【】\[\]，。；;、？?!！]/gu, "")
    .toLocaleLowerCase();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await runProductAnswerQuality();
  console.log(JSON.stringify(report, null, 2));
}
