import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { answerQuestion } from "../backend/engine.mjs";
import { RULE_DERIVED_GOLDEN_CASES } from "./product-answer-quality.mjs";
import { UI_ACCEPTANCE_REAL_QUESTIONS } from "./ui-acceptance-real-questions.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_CODE_PATTERN = /\b(?:no_direct_evidence|conflicting_direct_evidence|similar_evidence|card_text_only|question_type_mismatch|matcher_rejected_all|rejected_evidence_only|parser_warning|unresolved_dependency)\b/u;
const EMPTY_LIKELY_PATTERN = /^(?:未确认|只能给出未确认处理参考|可以参考卡片文本|资料不足|需要官方 Q&A)[。！!\s]*$/u;

export const MANUAL_PLAYTEST_CASES = dedupeByInput([
  ...UI_ACCEPTANCE_REAL_QUESTIONS,
  ...RULE_DERIVED_GOLDEN_CASES.map((item) => ({ id: `golden-${item.id}`, input: item.input })),
]);

export async function runManualPlaytest(options = {}) {
  const cases = options.cases || MANUAL_PLAYTEST_CASES;
  const results = [];
  for (const playtestCase of cases) {
    const answer = options.answers?.[playtestCase.id] || await answerQuestion(
      { question: playtestCase.input },
      { useModel: false, onDemandSync: false, recordAnswerHistory: false }
    );
    results.push(buildManualPlaytestCaseResult(playtestCase, answer));
  }
  return buildManualPlaytestReport(results);
}

export function buildManualPlaytestCaseResult(playtestCase, answer = {}) {
  const subAnswers = Array.isArray(answer.subAnswers) ? answer.subAnswers : [];
  const official = subAnswers.find((item) => item.officialAnswer?.status === "confirmed" || item.status === "confirmed") || null;
  const ruleDerived = subAnswers.find((item) => item.ruleDerivedAnswer?.status === "rule_derived")?.ruleDerivedAnswer || null;
  const provisional = subAnswers.find((item) => item.provisionalAnswer)?.provisionalAnswer || null;
  const conditional = subAnswers.find((item) => item.conditionalAnswer)?.conditionalAnswer || null;
  const cardIssue = subAnswers.find((item) => item.cardResolutionIssue)?.cardResolutionIssue
    || answer.cardResolutionConfirmations?.[0]
    || null;
  const clarification = subAnswers.find((item) => item.clarification?.question)?.clarification || null;
  const likely = subAnswers.find((item) => isSubstantiveLikelyAnswer(item.likelyAnswer))?.likelyAnswer || null;
  const presentation = subAnswers.map((item) => buildUserFacingSubAnswerSummary(item));
  const visibleStatus = deriveVisibleStatus({ official, ruleDerived, provisional, conditional, cardIssue, clarification, likely, answer });
  const visibleSummary = buildVisibleSummary({ official, ruleDerived, provisional, conditional, cardIssue, clarification, likely, presentation });
  const hasRuleDerivedReasoning = Boolean(ruleDerived?.reasoningSteps?.length >= 2 && String(ruleDerived.shortAnswer || "").trim());
  const hasUsefulAnswer = Boolean(
    (official && (official.officialAnswer?.evidenceIds || official.evidenceIds || []).length)
    || hasRuleDerivedReasoning
    || provisional
    || conditional?.branches?.length
    || cardIssue
    || clarification?.question
    || likely
  );
  const hasInternalCodeLeak = INTERNAL_CODE_PATTERN.test(visibleSummary);
  const unsafeConfirmed = subAnswers.some((item) => item.status === "confirmed" && (
    !(item.officialAnswer?.evidenceIds || item.evidenceIds || []).length
    || item.verdict === "unknown"
    || item.ruleDerivedAnswer
    || item.provisionalAnswer
  ));
  const wrongCardResolution = Boolean((answer.cardResolutionConfirmations || []).some((item) => item.autoResolved === true));
  const reviewReasons = classifyReviewReasons({
    answer,
    ruleDerived,
    hasUsefulAnswer,
    hasRuleDerivedReasoning,
    hasInternalCodeLeak,
    unsafeConfirmed,
    wrongCardResolution,
    visibleStatus,
  });
  return {
    id: playtestCase.id,
    input: playtestCase.input,
    visibleStatus,
    visibleSummary,
    hasUsefulAnswer,
    hasRuleDerivedReasoning,
    hasCardResolutionIssue: Boolean(cardIssue),
    hasInternalCodeLeak,
    needsHumanReview: reviewReasons.length > 0,
    reviewReason: reviewReasons.join(", ") || null,
    flags: {
      officialConfirmed: Boolean(official),
      ruleDerived: Boolean(ruleDerived),
      provisional: Boolean(provisional),
      clarification: Boolean(clarification?.question || conditional?.clarificationQuestion),
      unresolvedCardPrompt: Boolean(cardIssue),
      wrongCardResolution,
      unsafeConfirmed,
    },
  };
}

export function buildManualPlaytestReport(cases = []) {
  return {
    total: cases.length,
    officialConfirmedCount: cases.filter((item) => item.flags.officialConfirmed).length,
    ruleDerivedAnswerCount: cases.filter((item) => item.flags.ruleDerived).length,
    provisionalAnswerCount: cases.filter((item) => item.flags.provisional).length,
    clarificationCount: cases.filter((item) => item.flags.clarification).length,
    unresolvedCardPromptCount: cases.filter((item) => item.flags.unresolvedCardPrompt).length,
    uselessAnswerCount: cases.filter((item) => !item.hasUsefulAnswer).length,
    wrongCardResolutionCount: cases.filter((item) => item.flags.wrongCardResolution).length,
    internalReasonLeakCount: cases.filter((item) => item.hasInternalCodeLeak).length,
    unsafeConfirmedCount: cases.filter((item) => item.flags.unsafeConfirmed).length,
    needsHumanReviewCount: cases.filter((item) => item.needsHumanReview).length,
    cases,
  };
}

export function buildPlaytestFeedback(report = {}) {
  return (report.cases || [])
    .filter((item) => item.needsHumanReview)
    .map((item) => ({
      id: `playtest-${item.id}`,
      originalQuestion: item.input,
      category: item.reviewReason?.split(", ")[0] || "missing_evidence",
      visibleStatus: item.visibleStatus,
      visibleSummary: item.visibleSummary,
      reviewReasons: item.reviewReason?.split(", ").map((value) => value.trim()).filter(Boolean) || [],
      generatedRegressionDraft: {
        forbiddenStatuses: item.flags.unsafeConfirmed ? ["confirmed"] : [],
        notes: "Playtest draft only. Confirm the source and failure mode before converting to a regression test.",
      },
      status: "new",
      createdAt: new Date().toISOString(),
    }));
}

export async function writeManualPlaytestArtifacts(report, options = {}) {
  const reportPath = resolve(options.reportPath || resolve(projectRoot, "artifacts", "manual-playtest-report.json"));
  const feedbackPath = resolve(options.feedbackPath || resolve(projectRoot, "data", "playtest-feedback.json"));
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(feedbackPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(feedbackPath, `${JSON.stringify(buildPlaytestFeedback(report), null, 2)}\n`, "utf8");
  return { reportPath, feedbackPath };
}

function deriveVisibleStatus({ official, ruleDerived, provisional, conditional, cardIssue, clarification, likely, answer }) {
  if (official) return "官方直接裁定";
  if (ruleDerived) return "规则推导结论";
  if (provisional) return "事务局回答参考";
  if (conditional) return "条件不足";
  if (cardIssue) return "卡名需要确认";
  if (clarification?.question) return "需要确认";
  if (likely) return "规则参考";
  if (answer.mode === "parse_failed") return "解析失败";
  return "资料不足";
}

function buildVisibleSummary({ official, ruleDerived, provisional, conditional, cardIssue, clarification, likely, presentation }) {
  if (official) {
    const ids = official.officialAnswer?.evidenceIds || official.evidenceIds || [];
    return `官方直接裁定：${String(official.verdict || "")}。依据：${ids.join("、")}`;
  }
  if (ruleDerived) {
    return [
      `规则推导结论：${ruleDerived.shortAnswer}`,
      ...(ruleDerived.reasoningSteps || []).map((item, index) => `${index + 1}. ${item.explanation}`),
      ruleDerived.notice,
    ].filter(Boolean).join(" ");
  }
  if (provisional) return `事务局回答参考：${provisional.explanation || "官方数据库尚未收录，等待 revalidation。"}`;
  if (conditional) {
    return `条件不足：${(conditional.branches || []).map((branch) => `${branch.label}：${branch.explanation || branch.verdict}`).join("；")} ${conditional.clarificationQuestion || ""}`.trim();
  }
  if (cardIssue) {
    const candidates = (cardIssue.candidateCards || []).map((item) => item.name).filter(Boolean).join("、") || "无";
    return `卡名需要确认：${cardIssue.unresolvedCardName} 没有 exact match。较短候选：${candidates}，不会自动当作同一张卡。`;
  }
  if (clarification?.question) return `需要确认：${clarification.question}`;
  if (likely) {
    return [likely.issueSummary, likely.possibleHandling, likely.whyNotConfirmed, likely.neededEvidence].filter(Boolean).join(" ");
  }
  const first = presentation[0];
  return [first?.reason, first?.clarificationQuestion].filter(Boolean).join(" ") || "资料不足。";
}

function isSubstantiveLikelyAnswer(answer) {
  if (!answer || answer.status === "not_available") return false;
  const summary = String(answer.issueSummary || "").trim();
  const handling = String(answer.possibleHandling || answer.reasoning || "").trim();
  if (!summary || !handling || EMPTY_LIKELY_PATTERN.test(handling)) return false;
  return summary.length >= 12 && handling.length >= 16;
}

function classifyReviewReasons({ answer, ruleDerived, hasUsefulAnswer, hasRuleDerivedReasoning, hasInternalCodeLeak, unsafeConfirmed, wrongCardResolution, visibleStatus }) {
  const reasons = [];
  if (wrongCardResolution) reasons.push("wrong_card_resolution");
  if (ruleDerived && !hasRuleDerivedReasoning) reasons.push("useless_rule_derived_answer");
  if (!hasUsefulAnswer && answer.mode === "parse_failed") reasons.push("parser_failed");
  else if (!hasUsefulAnswer && visibleStatus === "资料不足") reasons.push("missing_rule_concept");
  if (hasInternalCodeLeak) reasons.push("internal_reason_leak");
  if (unsafeConfirmed) reasons.push("unsafe_confirmed");
  if (!hasUsefulAnswer && !reasons.length) reasons.push("missing_evidence");
  return [...new Set(reasons)];
}

function dedupeByInput(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.input || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await runManualPlaytest();
  const files = await writeManualPlaytestArtifacts(report);
  console.log(JSON.stringify({ ...report, files }, null, 2));
}
