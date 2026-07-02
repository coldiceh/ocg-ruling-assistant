import { extractOfficialQaAnswer } from "./officialQaAnswerExtractor.mjs";
import { renderOfficialQaDirect, renderOfficialQaNearCase } from "./officialQaRenderer.mjs";

export const ANSWER_ROUTE_LEVELS = [
  "official_qa_exact_match",
  "official_qa_near_case_match",
  "rule_engine_answer",
  "conditional_branch_answer",
  "needs_more_info",
];

export function selectOfficialQaRoute({ matches = {}, freshness = {}, staleEvidenceIds = [] } = {}) {
  const stale = new Set((staleEvidenceIds || []).map(String));
  const exact = usableMatches(matches.exact, stale);
    const extractedExact = exact.map((match) => ({ match, extracted: extractOfficialQaAnswer(match.record, { questionType: matches.questionType }) }))
    .filter((item) => item.extracted.explicit);
  const exactVerdicts = new Set(extractedExact.map((item) => item.extracted.verdict).filter((item) => item !== "unknown"));
  if (freshness.freshness === "fresh" && (freshness.safetyPenalty || 0) === 0 && extractedExact.length && exactVerdicts.size === 1) {
    return { level: "official_qa_exact_match", answer: renderOfficialQaDirect(extractedExact[0]), conflicts: [] };
  }
  if (exactVerdicts.size > 1) {
    return { level: null, answer: null, conflicts: extractedExact.map((item) => item.match.id), reason: "conflicting_official_exact_answers" };
  }

  const near = usableMatches(matches.near, stale)
    .map((match) => ({ match, extracted: extractOfficialQaAnswer(match.record, { questionType: matches.questionType }) }))
    .find((item) => item.extracted.explicit);
  if (near) return { level: "official_qa_near_case_match", answer: renderOfficialQaNearCase(near), conflicts: [] };
  return { level: null, answer: null, conflicts: [], reason: "no_explicit_official_answer" };
}

export function routeAnswer({ officialRoute, ruleEngineAnswer, conditionalAnswer, noEvidenceAnswer } = {}) {
  if (officialRoute?.answer) return officialRoute.answer;
  if (isUsableRuleAnswer(ruleEngineAnswer)) return withRoute(ruleEngineAnswer, "rule_engine_answer");
  if (conditionalAnswer) return withRoute({
    ...conditionalAnswer,
    requiredFacts: [...new Set([...(conditionalAnswer.requiredFacts || []), ...(noEvidenceAnswer?.requiredFacts || [])])],
  }, "conditional_branch_answer");
  return withRoute(noEvidenceAnswer || buildTrueNeedsMoreInfo(), "needs_more_info");
}

export function buildGenericRuleEngineAnswer({ question, issueFrames = {} } = {}) {
  const text = String(question || "");
  const ids = new Set([...(issueFrames.primaryIssueFrames || []), ...(issueFrames.secondaryIssueFrames || [])].map((item) => item.id));

  const asksPostSummonWindow = (ids.has("summon_response_window") || /召唤成功时点|召喚成功時|summon response window/iu.test(text))
    && /(?:对方|相手|opponent).{0,18}(?:不能|无法|できない|cannot).{0,12}发动/iu.test(text)
    && /之后|补发|开放游戏状态|自由时点|1速|一速|after|open game state/iu.test(text);
  if (asksPostSummonWindow) {
    return ruleAnswer({
      verdict: "turn_player_enters_open_game_state",
      shortAnswer: "可以继续行动。召唤成功时的响应窗口结束后，不会额外产生一个让对方补发效果的自由时点；进入开放游戏状态后，由回合玩家先进行一次允许的 1 速行动。",
      reasoning: ["召唤成功响应窗口与之后的开放游戏状态是两个不同的时点。", "不能在召唤成功响应窗口发动的效果，不能在窗口结束后倒回该时点补发。"],
      requiredFacts: ["确认没有其他必须处理的诱发效果或正在等待组成连锁的效果"],
    });
  }

  if (ids.has("copy_effect_activation_procedure") || /复制.*(?:取对象|对象)|copy.*target/iu.test(text)) {
    return ruleAnswer({
      verdict: "copied_effect_selects_target_on_activation",
      shortAnswer: "复制需要取对象的陷阱效果本身并不会因为“取对象”而无法复制；需要的对象应在 copied effect 发动时选择，不是等到效果处理时才选择。",
      reasoning: ["要区分原卡的发动费用与 copied effect 为成立所需的发动手续。", "取对象属于发动时确定的事项，不能推迟到处理时选择。"],
      requiredFacts: ["确认复制效果的文本确实让处理变成该陷阱卡发动时的效果"],
    });
  }

  if (ids.has("continuous_effect_during_resolution") || /效果处理中.*(?:自坏|永续|持续)|处理过程中.*墓地/iu.test(text)) {
    return ruleAnswer({
      verdict: "continuous_effect_checked_after_current_resolution",
      shortAnswer: "当前效果处理过程中，不会插入一个新的连锁块来处理自坏类永续效果；先完成当前效果处理，再更新场面并进行处理后检查。",
      reasoning: ["永续效果不另开连锁插入正在进行的效果处理。", "墓地或场面在处理中变化时，当前处理完成后再检查因此开始或停止适用的永续效果。"],
      requiredFacts: ["确认相关保护或自坏文本属于永续效果，而不是必须发动的诱发效果"],
    });
  }

  if (ids.has("spell_trap_card_activation_vs_effect_activation") || /卡的发动.*(?:①|②|效果)|カードの発動.*(?:①|②|効果)/iu.test(text)) {
    return ruleAnswer({
      verdict: "card_activation_does_not_imply_numbered_effect_activation",
      shortAnswer: "允许从手卡进行陷阱卡的“卡的发动”，不等于可以同时发动该卡的①②效果；若要在卡的发动时使用编号效果，仍必须满足该效果自己的发动条件和时点。",
      reasoning: ["卡的发动与卡片上编号效果的发动是不同判断。", "当前时点不满足编号效果条件时，只能进行卡的发动，不能一并使用该效果。"],
      requiredFacts: ["确认当前阶段，以及要同时使用的具体效果编号"],
    });
  }
  return null;
}

function usableMatches(matches = [], stale) {
  return (matches || []).filter((item) => !stale.has(String(item.id)) && !["removed", "superseded", "parse_failed", "conflict"].includes(item.record?.evidenceStatus || item.record?.status));
}

function isUsableRuleAnswer(answer) {
  return answer && !["cannot_answer_safely", "needs_clarification"].includes(answer.answerType);
}

function withRoute(answer, level) {
  return { ...answer, answerRoute: answer.answerRoute || level };
}

function ruleAnswer({ verdict, shortAnswer, reasoning, requiredFacts }) {
  return {
    answerType: "rule_judgment",
    answerRoute: "rule_engine_answer",
    answerSource: "deterministic_rule_engine",
    confirmationLevel: "rule_derived",
    verdict,
    shortAnswer,
    judgeReasoning: reasoning.map((text) => ({ text, basis: ["rule_snippet"], refs: [] })),
    requiredFacts,
    assumptions: [],
    possibleCounterCases: [],
    confidence: "medium",
  };
}

function buildTrueNeedsMoreInfo() {
  return {
    answerType: "needs_clarification",
    answerRoute: "needs_more_info",
    answerSource: "no_evidence",
    confirmationLevel: "insufficient_for_single_verdict",
    verdict: "unknown",
    shortAnswer: "目前无法判断：未识别到可用实体，也没有命中官方资料或能建立条件分支的规则事实。",
    judgeReasoning: [],
    requiredFacts: ["相关卡的正式卡名或完整效果文本", "要判断的动作、时点与连锁顺序"],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
  };
}
