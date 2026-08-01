import { extractOfficialQaAnswer } from "./officialQaAnswerExtractor.mjs";
import { renderOfficialQaDirect, renderOfficialQaNearCase } from "./officialQaRenderer.mjs";

export const ANSWER_ROUTE_LEVELS = [
  "official_qa_exact_match",
  "official_qa_near_case_match",
  "rule_engine_answer",
  "conditional_branch_answer",
  "insufficient",
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
  const fallback = noEvidenceAnswer || buildTrueNeedsMoreInfo();
  return withRoute(fallback, fallback.status === "insufficient" || fallback.verdict === "insufficient" ? "insufficient" : "needs_more_info");
}

export function buildGenericRuleEngineAnswer({ question, issueFrames = {} } = {}) {
  void question;
  void issueFrames;
  // Issue frames are retrieval hints, not executable proofs. The former
  // phrase-to-answer table was removed because it could answer without typed
  // premises, state execution or evidence bindings.
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
