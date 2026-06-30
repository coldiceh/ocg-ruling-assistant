import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPath = join(root, "data", "test", "real-ruling-goldens.json");
const safetyRank = { "OUTDATED-RISK": 0, "NEEDS-INFO": 1, "CARD-TEXT-MISSING": 1, "RULE-JUDGED": 2, OFFICIAL: 3 };

export async function runRealRulingGoldens({ path = defaultPath, answerer = answerGolden } = {}) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  const cases = [];
  for (const golden of payload.cases || []) {
    const answer = await answerer(golden);
    cases.push(evaluateGoldenCase(golden, answer));
  }
  const failed = cases.filter((item) => !item.pass);
  return {
    total: cases.length,
    passed: cases.length - failed.length,
    failed: failed.length,
    unsafeConfirmedCount: cases.filter((item) => item.unsafeConfirmed).length,
    internalReasonLeakCount: cases.filter((item) => item.internalReasonLeak).length,
    cases,
  };
}

export function evaluateGoldenCase(golden, answer) {
  const visible = [answer.shortAnswer, ...(answer.judgeReasoning || []).map((item) => item.text), ...(answer.resolutionSteps || []).map((item) => item.action), ...(answer.finalJudgeSummary || [])].filter(Boolean).join("\n");
  const blockers = (answer.blockers || []).map((item) => item.id);
  const failures = [];
  for (const term of golden.mustMention || []) if (!visible.includes(term)) failures.push(`missing:${term}`);
  for (const term of golden.mustNotMention || []) if (visible.includes(term)) failures.push(`forbidden:${term}`);
  for (const id of golden.requiredBlockers || []) if (!blockers.includes(id)) failures.push(`missing_blocker:${id}`);
  for (const id of golden.forbiddenBlockers || []) if (blockers.includes(id)) failures.push(`forbidden_blocker:${id}`);
  const actualType = verdictType(answer);
  if (![golden.expectedVerdictType, "direct_or_safe"].includes(actualType) && golden.expectedVerdictType !== "direct_or_safe") failures.push(`verdict_type:${actualType}`);
  checkSafety(golden, answer.statusChip, failures);
  const internalReasonLeak = /(?:no_direct_evidence|matcher_rejected_all|parser_failed|conflicting_direct_evidence)/u.test(visible);
  if (internalReasonLeak) failures.push("internal_reason_leak");
  const unsafeConfirmed = answer.answerType === "direct_official" && (!answer.sourceSummary?.officialQaRefs?.length || answer.sourceFreshness !== "fresh");
  if (unsafeConfirmed) failures.push("unsafe_confirmed");
  return { id: golden.id, pass: !failures.length, failures, answerType: answer.answerType, verdict: answer.verdict, statusChip: answer.statusChip, sourceFreshness: answer.sourceFreshness, safetyPenalty: answer.safetyPenalty, blockerIds: blockers, visible, unsafeConfirmed, internalReasonLeak };
}

async function answerGolden(golden) {
  const modelInvoker = golden.id === "user-provided-new-card-text" ? async (input) => ({
    answerType: "rule_judgment",
    verdict: "damage_occurs",
    shortAnswer: "按用户提供的完整效果文本，测试新龙攻击力超过守备力时会造成该差值的贯穿战斗伤害；该文本尚未由数据库校验。",
    judgeReasoning: [{ text: "测试新龙的完整效果文本明确记载攻击力超过守备力时造成贯穿战斗伤害。", basis: ["card_text"], refs: [input.context.relevantCardSections[0]?.cardId] }],
    requiredFacts: [],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
  }) : undefined;
  return answerRulingQuestionFast({ question: golden.question, mode: "analysis", modelInvoker });
}

function verdictType(answer) {
  if (answer.primaryVerdict === "original_chain_illegal" && answer.hypotheticalBranch) return "illegal_premise_with_hypothetical";
  if (answer.primaryVerdict) return answer.primaryVerdict;
  return answer.answerType;
}

function checkSafety(golden, chip, failures) {
  const value = safetyRank[chip] ?? 0;
  const min = safetyRank[golden.expectedSafetyLevelMin];
  const max = safetyRank[golden.expectedSafetyLevelMax];
  if (Number.isFinite(min) && value < min) failures.push(`safety_below:${chip}`);
  if (Number.isFinite(max) && value > max) failures.push(`safety_above:${chip}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runRealRulingGoldens();
  console.log(JSON.stringify(report, null, 2));
  if (report.failed || report.unsafeConfirmedCount || report.internalReasonLeakCount) process.exitCode = 1;
}
