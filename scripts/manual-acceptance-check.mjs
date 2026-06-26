import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion } from "../backend/engine.mjs";
import {
  SMOKE_REAL_QUESTIONS,
  buildSmokeCaseResult,
  buildSmokeReport,
} from "./smoke-real-questions.mjs";

export const MANUAL_ACCEPTANCE_CASES = [
  ...SMOKE_REAL_QUESTIONS,
  {
    id: "long-card-name-confirmation",
    type: "card name confirmation",
    question: "卡通青眼究极龙可以发动它的效果吗？",
  },
];

const INTERNAL_REASON_PATTERN = /\b(?:no_direct_evidence|conflicting_direct_evidence|condition_branch_missing_state|similar_evidence|card_text_only|rejected_evidence_only|parser_warning|unresolved_dependency|evidence_mentions_action_but_not_asked_result|matcher_rejected_all)\b/u;

export async function runManualAcceptanceCheck(options = {}) {
  const cases = options.cases || MANUAL_ACCEPTANCE_CASES;
  const results = [];
  for (const acceptanceCase of cases) {
    const answer = options.answers?.[acceptanceCase.id] || await answerQuestion(
      { question: acceptanceCase.question },
      { useModel: false, onDemandSync: false, recordAnswerHistory: false }
    );
    results.push(buildAcceptanceCaseResult(acceptanceCase, answer));
  }
  return buildManualAcceptanceReport(results);
}

export function buildAcceptanceCaseResult(acceptanceCase, answer) {
  const smokeCase = buildSmokeCaseResult(acceptanceCase, answer);
  return buildAcceptanceCaseFromSmoke(smokeCase);
}

export function buildAcceptanceCaseFromSmoke(smokeCase) {
  const subAnswers = smokeCase.subAnswers || [];
  const first = subAnswers[0] || {};
  const resolvedCards = collectResolvedCards(smokeCase);
  const unresolvedCardNames = collectUnresolvedCardNames(smokeCase);
  const officialAnswer = first.officialAnswer || {
    status: first.status === "confirmed" ? "confirmed" : "unknown",
    verdict: first.status === "confirmed" ? first.verdict : "unknown",
    evidenceIds: first.evidenceIds || [],
    reason: first.reason || "",
  };
  const internalReasonLeaked = hasInternalReasonLeak(smokeCase.userFacingSummary)
    || subAnswers.some((item) => hasInternalReasonLeak(item.presentation?.reason));
  const wrongCardResolutionSuspected = detectWrongCardResolution(smokeCase);
  const unsafeConfirmed = subAnswers.some((item) => item.status === "confirmed" && (
    !item.evidenceIds?.length ||
    !item.directEvidenceCount ||
    !item.extractedVerdict ||
    item.extractedVerdict === "unknown" ||
    item.provisionalAnswer
  ));
  const uselessUnknown = subAnswers.some((item) => item.status === "unknown" && !isUsefulUnknown(smokeCase, item));
  const missingLikely = subAnswers.some((item) => item.status === "unknown" && !isUsefulUnknown(smokeCase, item));
  const failures = [
    ...(unsafeConfirmed ? ["unsafe_confirmed"] : []),
    ...(uselessUnknown ? ["useless_unknown"] : []),
    ...(internalReasonLeaked ? ["internal_reason_leak"] : []),
    ...(wrongCardResolutionSuspected ? ["wrong_card_resolution"] : []),
    ...(missingLikely ? ["missing_likely_answer"] : []),
    ...subAnswers.flatMap((item) => validateSubAnswerPresentation(item)),
  ];
  const uniqueFailures = [...new Set(failures)];
  return {
    id: smokeCase.id,
    input: smokeCase.input,
    resolvedCards,
    unresolvedCardNames,
    officialAnswer,
    likelyAnswer: first.likelyAnswer || null,
    conditionalAnswer: smokeCase.conditionalAnswer || first.conditionalAnswer || null,
    provisionalAnswer: smokeCase.provisionalAnswer || first.provisionalAnswer || null,
    clarification: first.clarification || null,
    userFacingSummary: smokeCase.userFacingSummary || "",
    riskFlags: [...new Set(subAnswers.flatMap((item) => item.likelyAnswer?.riskFlags || item.presentation?.riskFlags || []))],
    evidenceIds: smokeCase.evidenceIds || [],
    internalReasonLeaked,
    wrongCardResolutionSuspected,
    acceptanceResult: uniqueFailures.length ? "needs_review" : "pass",
    reviewReasons: uniqueFailures,
    feedbackDrafts: uniqueFailures.map((type) => buildAcceptanceFeedbackDraft(type, smokeCase)),
  };
}

export function buildManualAcceptanceReport(cases) {
  const smokeSummary = buildSmokeReport(cases.map((item) => ({
    ...item,
    finalStatus: item.officialAnswer?.status === "confirmed" ? "confirmed" : "unknown",
    provisionalAnswer: item.provisionalAnswer,
    conditionalAnswer: item.conditionalAnswer,
    cardResolutionConfirmations: (item.unresolvedCardNames || []).map((name) => ({ unresolvedCardName: name })),
    subAnswers: [{
      questionId: "q1",
      status: item.officialAnswer?.status === "confirmed" ? "confirmed" : "unknown",
      reason: item.officialAnswer?.reason || item.userFacingSummary || "manual_acceptance",
      evidenceIds: item.officialAnswer?.evidenceIds || [],
      directEvidenceCount: item.officialAnswer?.status === "confirmed" ? Math.max(1, (item.officialAnswer?.evidenceIds || []).length) : 0,
      extractedVerdict: item.officialAnswer?.status === "confirmed" ? item.officialAnswer?.verdict || "unknown" : "unknown",
      likelyAnswer: item.likelyAnswer,
      conditionalAnswer: item.conditionalAnswer,
      provisionalAnswer: item.provisionalAnswer,
      clarification: item.clarification,
      presentation: { reason: item.userFacingSummary },
    }],
    userFacingSummary: item.userFacingSummary,
  })));
  const passCount = cases.filter((item) => item.acceptanceResult === "pass").length;
  const needsReviewCount = cases.length - passCount;
  return {
    generatedAt: new Date().toISOString(),
    total: cases.length,
    passCount,
    needsReviewCount,
    unsafeConfirmedCount: cases.filter((item) => item.reviewReasons.includes("unsafe_confirmed")).length,
    uselessUnknownCount: cases.filter((item) => item.reviewReasons.includes("useless_unknown")).length,
    internalReasonLeakCount: cases.filter((item) => item.internalReasonLeaked).length,
    wrongCardResolutionCount: cases.filter((item) => item.wrongCardResolutionSuspected).length,
    likelyAnswerCount: cases.filter((item) => item.likelyAnswer && item.likelyAnswer.status !== "not_available").length,
    conditionalAnswerCount: cases.filter((item) => item.conditionalAnswer).length,
    provisionalAnswerCount: cases.filter((item) => item.provisionalAnswer).length,
    clarificationCount: cases.filter((item) => item.clarification?.question || item.conditionalAnswer?.clarificationQuestion).length,
    smokeSummary: {
      officialConfirmedCount: smokeSummary.officialConfirmedCount,
      unsafeConfirmedCount: smokeSummary.unsafeConfirmedCount,
      uselessUnknownCount: smokeSummary.uselessUnknownCount,
      internalReasonLeakCount: smokeSummary.internalReasonLeakCount,
      wrongCardResolutionCount: smokeSummary.wrongCardResolutionCount,
    },
    cases,
    feedbackDrafts: cases.flatMap((item) => item.feedbackDrafts || []),
  };
}

export async function saveManualAcceptanceReport(report, outputPath = join(process.cwd(), "data", "acceptance-report.json")) {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

function collectResolvedCards(smokeCase) {
  if (Array.isArray(smokeCase.resolvedCards) && smokeCase.resolvedCards.length) {
    return smokeCase.resolvedCards.map((card) => card.name || card.matched || card.id).filter(Boolean);
  }
  const names = new Set();
  for (const subAnswer of smokeCase.subAnswers || []) {
    if (subAnswer.card && subAnswer.card !== "unknown") names.add(subAnswer.card);
  }
  return [...names];
}

function collectUnresolvedCardNames(smokeCase) {
  const names = new Set();
  for (const issue of smokeCase.cardResolutionConfirmations || []) {
    if (issue.unresolvedCardName) names.add(issue.unresolvedCardName);
  }
  for (const subAnswer of smokeCase.subAnswers || []) {
    if (subAnswer.cardResolutionIssue?.unresolvedCardName) names.add(subAnswer.cardResolutionIssue.unresolvedCardName);
  }
  return [...names];
}

function validateSubAnswerPresentation(subAnswer) {
  const failures = [];
  if (subAnswer.status === "confirmed" && !subAnswer.officialAnswer?.evidenceIds?.length && !subAnswer.evidenceIds?.length) {
    failures.push("unsafe_confirmed");
  }
  if (subAnswer.likelyAnswer && subAnswer.likelyAnswer.status !== "not_available" && !/未确认裁定/u.test(subAnswer.likelyAnswer.disclaimer || "")) {
    failures.push("wrong_verdict");
  }
  if (subAnswer.provisionalAnswer && !/screenshot|official_response_screenshot/u.test(subAnswer.provisionalAnswer.sourceType || "")) {
    failures.push("wrong_verdict");
  }
  if (subAnswer.conditionalAnswer && (!subAnswer.conditionalAnswer.branches?.length || !subAnswer.conditionalAnswer.clarificationQuestion)) {
    failures.push("missing_likely_answer");
  }
  return failures;
}

function detectWrongCardResolution(smokeCase) {
  if ((smokeCase.cardResolutionConfirmations || []).some((issue) => issue.autoResolved === true)) return true;
  return (smokeCase.subAnswers || []).some((item) => item.cardResolutionIssue?.autoResolved === true);
}

function isUsefulUnknown(smokeCase, subAnswer) {
  return Boolean(
    (subAnswer.likelyAnswer && subAnswer.likelyAnswer.status !== "not_available") ||
    subAnswer.conditionalAnswer ||
    subAnswer.clarification?.question ||
    subAnswer.provisionalAnswer ||
    (smokeCase.cardResolutionConfirmations || []).length
  );
}

function hasInternalReasonLeak(value) {
  return INTERNAL_REASON_PATTERN.test(String(value || ""));
}

function buildAcceptanceFeedbackDraft(type, smokeCase) {
  return {
    type,
    originalQuestion: smokeCase.input,
    caseId: smokeCase.id,
    currentAnswer: {
      finalStatus: smokeCase.finalStatus,
      finalVerdict: smokeCase.finalVerdict,
      reason: smokeCase.reason,
      evidenceIds: smokeCase.evidenceIds || [],
      conditionalAnswer: smokeCase.conditionalAnswer || undefined,
      provisionalAnswer: smokeCase.provisionalAnswer || undefined,
    },
    notes: feedbackNotes(type),
    status: "new",
  };
}

function feedbackNotes(type) {
  const notes = {
    wrong_card_resolution: "Review card resolution trace; do not auto-confirm a shorter contained alias.",
    missing_likely_answer: "Unknown answer did not provide likelyAnswer, conditionalAnswer, provisionalAnswer, clarification, or card confirmation.",
    internal_reason_leak: "User-facing summary exposed internal reason codes.",
    unsafe_confirmed: "Confirmed answer must have official direct evidence, evidenceIds, and non-unknown verdict.",
    useless_unknown: "Unknown answer needs a useful reason, likely answer, clarification, or card confirmation.",
    wrong_verdict: "Review structured verdict and presentation; do not let AI explanation override program result.",
    missing_evidence: "Needs direct official evidence before confirmed can be enabled.",
  };
  return notes[type] || "Manual acceptance review required.";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await runManualAcceptanceCheck();
  const outputPath = await saveManualAcceptanceReport(report);
  console.log(JSON.stringify({
    outputPath,
    total: report.total,
    passCount: report.passCount,
    needsReviewCount: report.needsReviewCount,
    unsafeConfirmedCount: report.unsafeConfirmedCount,
    uselessUnknownCount: report.uselessUnknownCount,
    internalReasonLeakCount: report.internalReasonLeakCount,
    wrongCardResolutionCount: report.wrongCardResolutionCount,
    likelyAnswerCount: report.likelyAnswerCount,
    clarificationCount: report.clarificationCount,
  }, null, 2));
}
