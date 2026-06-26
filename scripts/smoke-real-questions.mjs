import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion } from "../backend/engine.mjs";
import { buildAnswerHistoryItem, shouldRecordAnswerHistory } from "../backend/answerHistory.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";

export const SMOKE_REAL_QUESTIONS = [
  {
    id: "confirmed-official-faq",
    type: "confirmed 官方 Q&A / FAQ",
    question: "青眼暴君龙被战斗破坏并送去墓地后，它的③效果是在墓地发动还是在场上发动？",
  },
  {
    id: "unknown-no-direct-evidence",
    type: "unknown + no_direct_evidence",
    question: "伤害计算后已经确定会被战斗破坏的卡通怪兽，能用完美世界-卡通世界的③效果暂时除外到效果处理后吗？",
  },
  {
    id: "conditional-answer",
    type: "conditionalAnswer + clarificationQuestion",
    question: "青眼暴君龙被战斗破坏的时候，这个效果是在墓地发动还是在场上发动？",
  },
  {
    id: "provisional-official-response",
    type: "provisionalAnswer 事务局截图但 DB 未收录",
    question: "自分のEXデッキに氷剣竜ミラジェイドが存在し、手札に導きの聖女エクレシアとアルバスの落胤があり、相手フィールドに表側表示の聖痕喰らいし竜のみ存在します。アルバスの落胤を召喚した時、導きの聖女エクレシアをコストとして墓地へ送り、アルバスの落胤①の効果を発動できますか？",
  },
  {
    id: "answer-history-watch",
    type: "answerHistory / revalidation queue",
    question: "自分のEXデッキに氷剣竜ミラジェイドが存在し、手札に導きの聖女エクレシアとアルバスの落胤があり、相手フィールドに表側表示の聖痕喰らいし竜のみ存在します。アルバスの落胤を召喚した時、導きの聖女エクレシアをコストとして墓地へ送り、アルバスの落胤①の効果を発動できますか？",
  },
  {
    id: "conflicting-evidence",
    type: "conflicting evidence",
    question: "对方主要阶段，能否发动I：P百变莱娜的效果，用它和另一只怪兽连接召唤S：P小夜骑士？",
  },
  {
    id: "card-resolution-alias",
    type: "card resolution alias",
    question: "Perfect Toon World 能把已经确定会被战斗破坏的 Toon monster 暂时 banish 吗？",
  },
  {
    id: "damage-step-activation",
    type: "damage step activation",
    question: "大日女之御巫的①效果能否在伤害步骤发动？",
  },
  {
    id: "temporary-banish",
    type: "temporary banish",
    question: "能用完美世界-卡通世界的效果除外该卡通怪兽吗？",
  },
  {
    id: "activation-location-branch",
    type: "activation location branch",
    question: "青眼暴君龙被战斗破坏并被表侧除外后，它的③效果在哪里发动？",
  },
];

export async function runSmokeRealQuestions(options = {}) {
  const cases = options.cases || SMOKE_REAL_QUESTIONS;
  const results = [];
  for (const smokeCase of cases) {
    const answer = await answerQuestion(
      { question: smokeCase.question },
      { useModel: false, onDemandSync: false, recordAnswerHistory: false }
    );
    results.push(buildSmokeCaseResult(smokeCase, answer));
  }
  return buildSmokeReport(results);
}

export function buildSmokeCaseResult(smokeCase, answer) {
  const traces = new Map((answer.parserDebug?.evidenceTrace || []).map((trace) => [String(trace.questionId), trace]));
  const subSummaries = (answer.subAnswers || []).map((subAnswer) => {
    const trace = traces.get(String(subAnswer.questionId || subAnswer.id)) || {};
    return {
      questionId: subAnswer.questionId || subAnswer.id,
      sourceText: subAnswer.sourceText || subAnswer.question || "",
      status: subAnswer.status || "unknown",
      verdict: subAnswer.verdict || "unknown",
      reason: subAnswer.reason || trace.reason || "",
      evidenceIds: subAnswer.evidenceIds || [],
      directEvidenceCount: (trace.directEvidence || []).length,
      extractedVerdict: trace.extractedVerdict || "unknown",
      conditionalAnswer: subAnswer.conditionalAnswer || null,
      provisionalAnswer: subAnswer.provisionalAnswer || null,
      presentation: buildUserFacingSubAnswerSummary(subAnswer),
    };
  });
  const provisionalAnswer = subSummaries.map((item) => item.provisionalAnswer).find(Boolean) || null;
  const conditionalAnswer = subSummaries.map((item) => item.conditionalAnswer).find(Boolean) || null;
  const reason = firstReason(answer, subSummaries);
  const historyItem = buildAnswerHistoryItem(answer);
  return {
    id: smokeCase.id,
    type: smokeCase.type,
    input: smokeCase.question,
    finalStatus: answer.mode || answer.confidence?.status || "unknown",
    finalVerdict: summarizeFinalVerdict(answer),
    reason,
    evidenceIds: answer.evidenceIds || [],
    conditionalAnswer,
    provisionalAnswer,
    answerHistoryWatchable: shouldRecordAnswerHistory(answer),
    answerHistoryId: shouldRecordAnswerHistory(answer) ? historyItem?.id || null : null,
    canRevalidate: Boolean(provisionalAnswer?.canRevalidate || provisionalAnswer?.watchOfficialDb),
    subAnswers: subSummaries,
    userFacingSummary: buildUserFacingSummary(answer, subSummaries),
  };
}

export function buildSmokeReport(cases) {
  const unsafeConfirmed = [];
  const missingReason = [];
  for (const smokeCase of cases) {
    for (const subAnswer of smokeCase.subAnswers || []) {
      const key = `${smokeCase.id}:${subAnswer.questionId}`;
      if (subAnswer.status === "confirmed") {
        if (!subAnswer.evidenceIds.length) unsafeConfirmed.push(`${key}:evidenceIds_missing`);
        if (!subAnswer.directEvidenceCount) unsafeConfirmed.push(`${key}:directEvidence_missing`);
        if (!subAnswer.extractedVerdict || subAnswer.extractedVerdict === "unknown") unsafeConfirmed.push(`${key}:verdict_unknown`);
        if (subAnswer.provisionalAnswer) unsafeConfirmed.push(`${key}:provisional_confirmed`);
      }
      if (subAnswer.conditionalAnswer && subAnswer.status !== "unknown") {
        unsafeConfirmed.push(`${key}:conditional_raised_status`);
      }
      if (subAnswer.status === "unknown" && !String(subAnswer.reason || "").trim()) {
        missingReason.push(key);
      }
    }
  }
  return {
    total: cases.length,
    confirmed: cases.filter((item) => item.finalStatus === "confirmed").length,
    inferred: cases.filter((item) => item.finalStatus === "inferred").length,
    unknown: cases.filter((item) => item.finalStatus !== "confirmed" && item.finalStatus !== "inferred").length,
    provisionalAnswerCount: cases.filter((item) => item.provisionalAnswer).length,
    conditionalAnswerCount: cases.filter((item) => item.conditionalAnswer).length,
    clarificationQuestionCount: cases.filter((item) => item.conditionalAnswer?.clarificationQuestion).length,
    unsafeConfirmedCount: unsafeConfirmed.length,
    missingReasonCount: missingReason.length,
    unsafeConfirmed,
    missingReason,
    cases,
  };
}

export function formatSmokeMarkdown(report) {
  const lines = [
    "# Real Question Smoke Test",
    "",
    `- total: ${report.total}`,
    `- confirmed: ${report.confirmed}`,
    `- inferred: ${report.inferred}`,
    `- unknown: ${report.unknown}`,
    `- provisionalAnswerCount: ${report.provisionalAnswerCount}`,
    `- conditionalAnswerCount: ${report.conditionalAnswerCount}`,
    `- clarificationQuestionCount: ${report.clarificationQuestionCount}`,
    `- unsafeConfirmedCount: ${report.unsafeConfirmedCount}`,
    `- missingReasonCount: ${report.missingReasonCount}`,
    "",
  ];
  for (const item of report.cases) {
    lines.push(`## ${item.id}`);
    lines.push("");
    lines.push(`- type: ${item.type}`);
    lines.push(`- status: ${item.finalStatus}`);
    lines.push(`- verdict: ${JSON.stringify(item.finalVerdict)}`);
    lines.push(`- reason: ${item.reason || "unknown"}`);
    lines.push(`- evidenceIds: ${(item.evidenceIds || []).join(", ") || "none"}`);
    if (item.conditionalAnswer?.clarificationQuestion) {
      lines.push(`- clarification: ${item.conditionalAnswer.clarificationQuestion}`);
    }
    if (item.provisionalAnswer) {
      lines.push("- provisional: 事务局回答截图，官方数据库未收录");
    }
    lines.push(`- summary: ${item.userFacingSummary}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function summarizeFinalVerdict(answer) {
  if ((answer.subAnswers || []).length === 1) return answer.subAnswers[0].verdict;
  return {
    subAnswers: (answer.subAnswers || []).map((item) => ({
      questionId: item.questionId || item.id,
      status: item.status,
      verdict: item.verdict,
    })),
  };
}

function firstReason(answer, subSummaries) {
  const reason = subSummaries.map((item) => item.reason).find((value) => String(value || "").trim());
  if (reason) return reason;
  return (answer.needsConfirmation || []).find(Boolean) || "";
}

function buildUserFacingSummary(answer, subSummaries) {
  const first = subSummaries[0];
  if (!first) return answer.verdict || "";
  if (first.provisionalAnswer) return `未确认处理方式：${first.presentation.provisionalText}`;
  if (first.conditionalAnswer) {
    const branches = first.presentation.conditionalBranches
      .map((branch) => `${branch.label}：${branch.text}`)
      .join("；");
    return `条件不足：${branches}。${first.presentation.clarificationQuestion || ""}`.trim();
  }
  if (first.status === "confirmed") return `已确认：${first.presentation.verdictText}`;
  return `${first.presentation.statusLabel}：${first.reason || "暂时不能确定。"}`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await runSmokeRealQuestions();
  if (process.argv.includes("--markdown")) {
    console.log(formatSmokeMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
