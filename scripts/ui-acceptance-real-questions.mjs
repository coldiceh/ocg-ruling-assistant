import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion } from "../backend/engine.mjs";
import { BENCHMARK_CASES } from "./benchmark-report.mjs";
import { PRODUCT_ACCEPTANCE_REAL_QUESTIONS } from "./product-acceptance-real-questions.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";

export const UI_ACCEPTANCE_REAL_QUESTIONS = [
  ...PRODUCT_ACCEPTANCE_REAL_QUESTIONS.map((item) => ({
    id: item.id,
    input: item.input,
  })),
  ...BENCHMARK_CASES
    .filter((item) => !new Set(PRODUCT_ACCEPTANCE_REAL_QUESTIONS.map((product) => product.id)).has(item.id))
    .slice(0, 17)
    .map((item) => ({
      id: item.id,
      input: item.question,
    })),
];

const INTERNAL_REASON_PATTERN = /\b(?:similar_evidence|conflicting_direct_evidence|evidence_mentions_action_but_not_asked_result|question_type_mismatch|no_direct_evidence|condition_branch_missing_state|condition_branch_ambiguous|matcher_rejected_all|rejected_evidence_only|card_text_only|parser_warning|unresolved_dependency)\b/u;

export async function runUiAcceptanceRealQuestions(options = {}) {
  const cases = options.cases || UI_ACCEPTANCE_REAL_QUESTIONS;
  const results = [];
  for (const uiCase of cases) {
    const answer = options.answers?.[uiCase.id] || await answerQuestion(
      { question: uiCase.input },
      { useModel: false, onDemandSync: false, recordAnswerHistory: false }
    );
    results.push(buildUiAcceptanceCaseResult(uiCase, answer));
  }
  return buildUiAcceptanceReport(results);
}

export function buildUiAcceptanceCaseResult(uiCase, answer = {}) {
  const subAnswers = Array.isArray(answer.subAnswers) ? answer.subAnswers : [];
  const presentations = subAnswers.map((item) => ({
    subAnswer: item,
    presentation: buildUserFacingSubAnswerSummary(item),
  }));
  const unresolvedCardPrompts = buildUnresolvedCardPrompts(answer, subAnswers);
  const visibleOfficialAnswer = buildVisibleOfficialAnswer(presentations);
  const visibleLikelyAnswer = firstText(presentations.map(({ presentation }) => {
    if (!presentation.likelyAnswerText) return "";
    return presentation.likelyAnswerText.startsWith("未确认分析")
      ? presentation.likelyAnswerText
      : `未确认分析：${presentation.likelyAnswerText}`;
  }));
  const visibleConditionalAnswer = firstText(presentations.map(({ presentation }) => formatConditionalAnswer(presentation)));
  const visibleProvisionalAnswer = firstText(presentations.map(({ presentation, subAnswer }) => formatProvisionalAnswer(presentation, subAnswer)));
  const visibleClarification = firstText([
    ...unresolvedCardPrompts.map((item) => item.visibleText),
    ...presentations.map(({ presentation }) => presentation.clarificationQuestion || ""),
  ]);
  const visibleEvidence = buildVisibleEvidence(presentations);
  const userFacingSummary = buildUiUserFacingSummary({
    visibleOfficialAnswer,
    visibleLikelyAnswer,
    visibleConditionalAnswer,
    visibleProvisionalAnswer,
    visibleClarification,
  });
  const visibleText = [
    visibleOfficialAnswer,
    visibleLikelyAnswer,
    visibleConditionalAnswer,
    visibleProvisionalAnswer,
    visibleClarification,
    visibleEvidence.join(" "),
    userFacingSummary,
  ].filter(Boolean).join("\n");
  const reviewReasons = buildReviewReasons({
    answer,
    subAnswers,
    unresolvedCardPrompts,
    visibleLikelyAnswer,
    visibleConditionalAnswer,
    visibleProvisionalAnswer,
    visibleClarification,
    visibleEvidence,
    userFacingSummary,
    visibleText,
  });
  return {
    id: uiCase.id,
    input: uiCase.input,
    resolvedCards: (answer.cards || []).map((card) => ({
      id: card.id || card.passcode || "",
      name: card.name || card.cnName || card.jaName || card.enName || "",
      matched: card.matched || "",
    })),
    unresolvedCardPrompts,
    visibleOfficialAnswer,
    visibleLikelyAnswer,
    visibleConditionalAnswer,
    visibleProvisionalAnswer,
    visibleClarification,
    visibleEvidence,
    userFacingSummary,
    acceptance: reviewReasons.length ? "needs_review" : "pass",
    reviewReasons,
  };
}

export function buildUiAcceptanceReport(cases = []) {
  return {
    total: cases.length,
    passCount: cases.filter((item) => item.acceptance === "pass").length,
    needsReviewCount: cases.filter((item) => item.acceptance !== "pass").length,
    visibleLikelyAnswerCount: cases.filter((item) => Boolean(item.visibleLikelyAnswer)).length,
    visibleClarificationCount: cases.filter((item) => Boolean(item.visibleClarification)).length,
    visibleProvisionalAnswerCount: cases.filter((item) => Boolean(item.visibleProvisionalAnswer)).length,
    visibleUnresolvedCardPromptCount: cases.reduce((count, item) => count + (item.unresolvedCardPrompts || []).length, 0),
    uselessVisibleAnswerCount: cases.filter((item) => item.reviewReasons.includes("useless_visible_answer")).length,
    internalReasonLeakCount: cases.filter((item) => item.reviewReasons.includes("internal_reason_leak")).length,
    mistakenConfirmedCount: cases.filter((item) => item.reviewReasons.includes("mistaken_confirmed")).length,
    wrongCardResolutionSuspectedCount: cases.filter((item) => item.reviewReasons.includes("wrong_card_resolution_suspected")).length,
    cases,
  };
}

function buildVisibleOfficialAnswer(presentations) {
  const confirmed = presentations.find(({ subAnswer }) => subAnswer.officialAnswer?.status === "confirmed" || subAnswer.status === "confirmed");
  if (confirmed) {
    const ids = confirmed.presentation.evidenceIds || confirmed.subAnswer.evidenceIds || [];
    return `官方确认：已确认。结论：${confirmed.presentation.verdictText || confirmed.subAnswer.verdict || "unknown"}。依据：${ids.join("、") || "未列出"}`;
  }
  return "官方确认：暂无直接裁定。";
}

function formatConditionalAnswer(presentation) {
  if (!presentation.conditionalBranches?.length) return "";
  const branches = presentation.conditionalBranches
    .map((branch) => `${branch.label}：${branch.text}`)
    .join("；");
  return `条件分支：${branches}${presentation.clarificationQuestion ? `。需要补充：${presentation.clarificationQuestion}` : ""}`;
}

function formatProvisionalAnswer(presentation, subAnswer) {
  if (!subAnswer.provisionalAnswer && !presentation.provisionalText) return "";
  return `未确认处理方式：事务局回答截图，官方 DB 未收录。${presentation.provisionalText || "等待 revalidation。"}`;
}

function buildVisibleEvidence(presentations) {
  const ids = new Set();
  for (const { presentation, subAnswer } of presentations) {
    for (const id of presentation.evidenceIds || subAnswer.evidenceIds || []) ids.add(id);
  }
  return [...ids].slice(0, 8).map((id) => `依据：${id}`);
}

function buildUnresolvedCardPrompts(answer, subAnswers) {
  const prompts = [];
  for (const issue of answer.cardResolutionConfirmations || []) {
    prompts.push({
      unresolvedCardName: issue.unresolvedCardName,
      candidateCards: issue.candidateCards || [],
      visibleText: `卡名需要确认：${issue.unresolvedCardName}。候选：${(issue.candidateCards || []).map((item) => item.name).filter(Boolean).join("、") || "无"}`,
    });
  }
  for (const item of subAnswers || []) {
    const issue = item.cardResolutionIssue;
    if (!issue?.unresolvedCardName) continue;
    prompts.push({
      unresolvedCardName: issue.unresolvedCardName,
      candidateCards: issue.candidateCards || [],
      visibleText: `卡名需要确认：${issue.unresolvedCardName}。候选：${(issue.candidateCards || []).map((candidate) => candidate.name).filter(Boolean).join("、") || "无"}`,
    });
  }
  return dedupeBy(prompts, (item) => normalizeKey(item.unresolvedCardName));
}

function buildUiUserFacingSummary({
  visibleOfficialAnswer,
  visibleLikelyAnswer,
  visibleConditionalAnswer,
  visibleProvisionalAnswer,
  visibleClarification,
}) {
  return [
    visibleOfficialAnswer,
    visibleProvisionalAnswer,
    visibleConditionalAnswer,
    visibleLikelyAnswer,
    visibleClarification,
  ].filter(Boolean).join("\n");
}

function buildReviewReasons({
  answer,
  subAnswers,
  unresolvedCardPrompts,
  visibleLikelyAnswer,
  visibleConditionalAnswer,
  visibleProvisionalAnswer,
  visibleClarification,
  visibleEvidence,
  userFacingSummary,
  visibleText,
}) {
  const reasons = [];
  if (INTERNAL_REASON_PATTERN.test(visibleText)) reasons.push("internal_reason_leak");
  if (hasMistakenConfirmed(subAnswers)) reasons.push("mistaken_confirmed");
  if (detectWrongCardResolution(answer)) reasons.push("wrong_card_resolution_suspected");
  if (isUselessVisibleAnswer({
    subAnswers,
    unresolvedCardPrompts,
    visibleLikelyAnswer,
    visibleConditionalAnswer,
    visibleProvisionalAnswer,
    visibleClarification,
    userFacingSummary,
  })) reasons.push("useless_visible_answer");
  if (subAnswers.some((item) => item.status === "confirmed") && !visibleEvidence.length) reasons.push("confirmed_without_visible_evidence");
  if (visibleLikelyAnswer && !/未确认分析/u.test(visibleLikelyAnswer)) reasons.push("likely_answer_not_marked_unconfirmed");
  if (visibleProvisionalAnswer && !/(事务局回答截图|官方 DB 未收录|官方数据库未收录)/u.test(visibleProvisionalAnswer)) reasons.push("provisional_not_marked");
  if ((unresolvedCardPrompts || []).length && !/卡名需要确认/u.test(visibleText)) reasons.push("unresolved_card_prompt_missing");
  return [...new Set(reasons)];
}

function hasMistakenConfirmed(subAnswers) {
  return (subAnswers || []).some((item) => {
    if (item.status !== "confirmed" && item.officialAnswer?.status !== "confirmed") return false;
    const evidenceIds = item.officialAnswer?.evidenceIds || item.evidenceIds || [];
    return !evidenceIds.length || item.provisionalAnswer || item.officialAnswer?.verdict === "unknown";
  });
}

function isUselessVisibleAnswer({
  subAnswers,
  unresolvedCardPrompts,
  visibleLikelyAnswer,
  visibleConditionalAnswer,
  visibleProvisionalAnswer,
  visibleClarification,
  userFacingSummary,
}) {
  const hasConfirmed = (subAnswers || []).some((item) => item.status === "confirmed" || item.officialAnswer?.status === "confirmed");
  if (hasConfirmed || visibleLikelyAnswer || visibleConditionalAnswer || visibleProvisionalAnswer || visibleClarification) return false;
  if ((unresolvedCardPrompts || []).length) return false;
  return (subAnswers || []).some((item) => item.status === "unknown")
    && /^(官方确认：暂无直接裁定。?\s*)?(资料不足。?|资料不足：?。?)?$/u.test(String(userFacingSummary || "").trim());
}

function detectWrongCardResolution(answer) {
  if ((answer.cardResolutionConfirmations || []).some((issue) => issue.autoResolved === true)) return true;
  return false;
}

function firstText(values) {
  return (values || []).find((value) => String(value || "").trim()) || null;
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\-－ー・･:："'“”‘’「」『』《》()（）【】\[\]，。；;、？?!！]/gu, "")
    .toLocaleLowerCase();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await runUiAcceptanceRealQuestions();
  console.log(JSON.stringify(report, null, 2));
}
