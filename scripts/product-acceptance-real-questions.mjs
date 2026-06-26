import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion } from "../backend/engine.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";

export const PRODUCT_ACCEPTANCE_REAL_QUESTIONS = [
  {
    id: "transaction-rollback-copy-extra-text",
    input: "场上发动的事务回滚能否复制「六花的薄冰」和「随心捏军费」的效果外文本的「这张卡也能……来发动」",
  },
  {
    id: "toon-blue-eyes-ultimate-direct-attack",
    input: "我方场上有已经发动的耀圣之诗～狂奏之狂想曲由我方中央的主要怪兽区有怪兽存在，场上没有其他影响攻击对象的效果，对方的卡通青眼究极龙是否能直接攻击",
  },
  {
    id: "illusion-of-chaos-reveal-same-card-chain",
    input: "我方手卡仅有1张，C1给对手观看这张「混沌之幻想魔术师」发动效果，对手C2连锁怪兽效果，在这个连锁链上，我方如果想在C3发动当回合盖放的「黑魔术的护符」，能否再次给对手观看混沌之幻想魔术师",
  },
];

const INTERNAL_REASON_PATTERN = /\b(?:no_direct_evidence|conflicting_direct_evidence|condition_branch_missing_state|similar_evidence|card_text_only|rejected_evidence_only|parser_warning|unresolved_dependency|evidence_mentions_action_but_not_asked_result|matcher_rejected_all|question_type_mismatch)\b/u;

export async function runProductAcceptanceRealQuestions(options = {}) {
  const cases = options.cases || PRODUCT_ACCEPTANCE_REAL_QUESTIONS;
  const results = [];
  for (const productCase of cases) {
    const answer = options.answers?.[productCase.id] || await answerQuestion(
      { question: productCase.input },
      { useModel: false, onDemandSync: false, recordAnswerHistory: false }
    );
    results.push(buildProductAcceptanceCaseResult(productCase, answer));
  }
  return buildProductAcceptanceReport(results);
}

export function buildProductAcceptanceCaseResult(productCase, answer = {}) {
  const subAnswers = (answer.subAnswers || []).map((item) => {
    const presentation = buildUserFacingSubAnswerSummary(item);
    return {
      questionId: item.questionId || item.id,
      sourceText: item.sourceText || item.question || "",
      type: item.type || "unknown",
      detectedQuestionTypes: [...new Set([item.type, ...(item.likelyAnswer?.concepts || [])].filter(Boolean))],
      card: item.card || "unknown",
      status: item.status || "unknown",
      verdict: item.verdict || "unknown",
      officialAnswer: item.officialAnswer || null,
      likelyAnswer: item.likelyAnswer || null,
      conditionalAnswer: item.conditionalAnswer || null,
      provisionalAnswer: item.provisionalAnswer || null,
      clarification: item.clarification || null,
      evidenceIds: item.evidenceIds || [],
      riskFlags: item.likelyAnswer?.riskFlags || presentation.riskFlags || [],
      presentation,
    };
  });
  const unresolvedCardPrompt = collectUnresolvedPrompts(answer, subAnswers);
  const userFacingSummary = buildProductSummary(subAnswers);
  const officialAnswer = first(subAnswers.map((item) => item.officialAnswer)) || {
    status: "unknown",
    verdict: "unknown",
    evidenceIds: [],
    reason: "",
  };
  const likelyAnswer = first(subAnswers.map((item) => item.likelyAnswer && item.likelyAnswer.status !== "not_available" ? item.likelyAnswer : null));
  const conditionalAnswer = first(subAnswers.map((item) => item.conditionalAnswer));
  const provisionalAnswer = first(subAnswers.map((item) => item.provisionalAnswer));
  const clarification = first(subAnswers.map((item) => item.clarification)) || unresolvedCardPrompt[0] || null;
  const finalStatus = answer.mode || answer.confidence?.status || "unknown";
  const internalReasonLeaked = hasInternalReasonLeak(userFacingSummary)
    || subAnswers.some((item) => hasInternalReasonLeak(item.presentation?.reason) || hasInternalReasonLeak(item.presentation?.likelyAnswerText));
  const wrongCardResolutionSuspected = detectWrongCardResolution(productCase.input, answer);
  const unsafeConfirmed = subAnswers.some((item) => item.status === "confirmed" && (
    !(item.officialAnswer?.evidenceIds || item.evidenceIds || []).length ||
    item.provisionalAnswer ||
    item.officialAnswer?.verdict === "unknown"
  ));
  const useful = isUsefulProductAnswer({ finalStatus, subAnswers, likelyAnswer, conditionalAnswer, provisionalAnswer, clarification, unresolvedCardPrompt });
  return {
    id: productCase.id,
    input: productCase.input,
    resolvedCards: (answer.cards || []).map((card) => ({
      id: card.id || card.passcode || "",
      name: card.name || card.cnName || card.jaName || card.enName || "",
      matched: card.matched || "",
    })),
    unresolvedCardNames: unresolvedCardPrompt.map((item) => item.unresolvedCardName || item.question).filter(Boolean),
    unresolvedCardPrompt,
    officialAnswer,
    likelyAnswer: likelyAnswer || null,
    conditionalAnswer: conditionalAnswer || null,
    provisionalAnswer: provisionalAnswer || null,
    clarification,
    userFacingSummary,
    riskFlags: [...new Set(subAnswers.flatMap((item) => item.riskFlags || []))],
    evidenceIds: [...new Set(subAnswers.flatMap((item) => item.evidenceIds || []))],
    subAnswers,
    internalReasonLeaked,
    wrongCardResolutionSuspected,
    unsafeConfirmed,
    useful,
    acceptanceResult: useful && !internalReasonLeaked && !wrongCardResolutionSuspected && !unsafeConfirmed ? "pass" : "needs_review",
  };
}

export function buildProductAcceptanceReport(cases = []) {
  return {
    total: cases.length,
    usefulAnswerCount: cases.filter((item) => item.useful).length,
    uselessAnswerCount: cases.filter((item) => !item.useful).length,
    officialConfirmedCount: cases.reduce((count, item) => count + item.subAnswers.filter((sub) => sub.officialAnswer?.status === "confirmed" || sub.status === "confirmed").length, 0),
    likelyAnswerCount: cases.reduce((count, item) => count + item.subAnswers.filter((sub) => sub.likelyAnswer && sub.likelyAnswer.status !== "not_available").length, 0),
    clarificationCount: cases.reduce((count, item) => count + item.subAnswers.filter((sub) => sub.clarification?.question || sub.conditionalAnswer?.clarificationQuestion).length, 0),
    unresolvedCardPromptCount: cases.reduce((count, item) => count + (item.unresolvedCardPrompt || []).length, 0),
    wrongCardResolutionCount: cases.filter((item) => item.wrongCardResolutionSuspected).length,
    internalReasonLeakCount: cases.filter((item) => item.internalReasonLeaked).length,
    unsafeConfirmedCount: cases.filter((item) => item.unsafeConfirmed).length,
    cases,
  };
}

function isUsefulProductAnswer({ finalStatus, subAnswers, likelyAnswer, conditionalAnswer, provisionalAnswer, clarification, unresolvedCardPrompt }) {
  if (finalStatus === "confirmed") return true;
  if (likelyAnswer && likelyAnswer.status !== "not_available") return true;
  if (conditionalAnswer || provisionalAnswer || clarification?.question) return true;
  if ((unresolvedCardPrompt || []).length) return true;
  return !subAnswers.some((item) => item.status === "unknown");
}

function collectUnresolvedPrompts(answer, subAnswers) {
  const prompts = [];
  for (const issue of answer.cardResolutionConfirmations || []) {
    prompts.push({
      unresolvedCardName: issue.unresolvedCardName,
      candidateCards: issue.candidateCards || [],
      reason: issue.reason || "card_name_requires_confirmation",
      question: `请确认你指的是哪张卡：${issue.unresolvedCardName}？`,
    });
  }
  for (const item of subAnswers || []) {
    if (item.cardResolutionIssue?.unresolvedCardName) {
      prompts.push({
        unresolvedCardName: item.cardResolutionIssue.unresolvedCardName,
        candidateCards: item.cardResolutionIssue.candidateCards || [],
        reason: item.cardResolutionIssue.reason || "card_name_requires_confirmation",
        question: item.clarification?.question || `请确认你指的是哪张卡：${item.cardResolutionIssue.unresolvedCardName}？`,
      });
    }
  }
  return dedupeBy(prompts, (item) => item.unresolvedCardName || item.question);
}

function buildProductSummary(subAnswers) {
  const firstAnswer = subAnswers[0];
  if (!firstAnswer) return "";
  const presentation = firstAnswer.presentation || {};
  if (firstAnswer.officialAnswer?.status === "confirmed" || firstAnswer.status === "confirmed") {
    return `官方确认：已确认。${presentation.verdictText || firstAnswer.verdict || ""}`.trim();
  }
  if (firstAnswer.provisionalAnswer) return `未确认处理方式：${presentation.provisionalText || "事务局回答截图，官方数据库未收录。"}`;
  if (firstAnswer.conditionalAnswer) return `条件不足：${presentation.conditionalBranches?.map((branch) => `${branch.label}：${branch.text}`).join("；") || ""} ${presentation.clarificationQuestion || ""}`.trim();
  if (firstAnswer.likelyAnswer && firstAnswer.likelyAnswer.status !== "not_available") return `官方确认：暂无直接裁定。未确认分析：${presentation.likelyAnswerText || firstAnswer.likelyAnswer.reasoning || ""}`;
  if (firstAnswer.clarification?.question) return `需要补充：${firstAnswer.clarification.question}`;
  return `${presentation.statusLabel || "资料不足"}：${presentation.reason || "暂时不能确定。"}`;
}

function detectWrongCardResolution(input, answer) {
  if ((answer.cardResolutionConfirmations || []).some((issue) => issue.autoResolved === true)) return true;
  const inputKey = normalizeKey(input);
  return (answer.cards || []).some((card) => {
    const nameKey = normalizeKey(card.name || card.cnName || "");
    if (!nameKey) return false;
    if (inputKey.includes(`卡通${nameKey}`) && !hasConfirmationFor(answer, `卡通${card.name || card.cnName || ""}`)) return true;
    return false;
  });
}

function hasConfirmationFor(answer, name) {
  const key = normalizeKey(name);
  return (answer.cardResolutionConfirmations || []).some((item) => normalizeKey(item.unresolvedCardName || "") === key);
}

function hasInternalReasonLeak(value) {
  return INTERNAL_REASON_PATTERN.test(String(value || ""));
}

function first(values) {
  return (values || []).find(Boolean) || null;
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
  const report = await runProductAcceptanceRealQuestions();
  console.log(JSON.stringify(report, null, 2));
}
