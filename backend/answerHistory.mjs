import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WATCHABLE_UNKNOWN_REASONS = new Set([
  "no_direct_evidence",
  "pending_adjustment",
  "provisional_official_response",
  "condition_branch_missing_state",
]);

export function shouldRecordAnswerHistory(answer) {
  const item = buildAnswerHistoryItem(answer);
  if (!item) return false;
  if (item.finalStatus === "confirmed") return false;
  if (item.provisionalAnswer) return item.watchCardIds.length > 0 || item.watchTerms.length > 0;
  return item.finalStatus === "unknown" &&
    item.watchCardIds.length > 0 &&
    item.unknownReasons.some((reason) => WATCHABLE_UNKNOWN_REASONS.has(reason));
}

export function buildAnswerHistoryItem(answer, options = {}) {
  if (!answer || typeof answer !== "object") return null;
  const originalText = String(answer.formalQuery?.originalText || answer.parserDebug?.rawQuestion || "").trim();
  if (!originalText) return null;
  const formalQuery = answer.formalQuery || answer.parserDebug?.normalizedFormalQuery || null;
  if (!formalQuery || typeof formalQuery !== "object") return null;

  const now = options.now || new Date().toISOString();
  const provisionalAnswers = collectProvisionalAnswers(answer);
  const provisionalAnswer = provisionalAnswers.length === 1
    ? provisionalAnswers[0]
    : provisionalAnswers.length > 1
      ? { answers: provisionalAnswers }
      : undefined;
  const watchCardIds = collectWatchCardIds(answer, provisionalAnswers);
  const watchTerms = collectWatchTerms(answer, provisionalAnswers);
  const finalStatus = normalizeStatus(answer.mode || answer.status || "unknown");
  const finalVerdict = finalStatus === "confirmed" ? summarizeFinalVerdict(answer) : "unknown";
  const unknownReasons = collectUnknownReasons(answer, provisionalAnswers);
  const usedEvidenceIds = [...new Set([
    ...(Array.isArray(answer.evidenceIds) ? answer.evidenceIds : []),
    ...(Array.isArray(answer.subAnswers) ? answer.subAnswers.flatMap((item) => item.evidenceIds || []) : []),
  ].map(String).filter(Boolean))];
  const formalQueryHash = stableHash(formalQuery);

  return {
    id: stableHash({ originalText, watchCardIds, formalQueryHash }).slice(0, 24),
    originalText,
    formalQuery,
    watchCardIds,
    watchTerms,
    finalStatus,
    finalVerdict,
    unknownReasons,
    ...(provisionalAnswer ? { provisionalAnswer } : {}),
    usedEvidenceIds,
    evidenceHash: stableHash({
      usedEvidenceIds,
      trace: (answer.parserDebug?.evidenceTrace || []).map((trace) => ({
        questionId: trace.questionId,
        direct: (trace.directEvidence || []).map((item) => item.id),
        similar: (trace.similarEvidence || []).map((item) => item.id),
        rejected: (trace.rejectedEvidence || []).map((item) => item.id),
      })),
    }),
    createdAt: now,
    lastEvaluatedAt: now,
    ...(options.lastRevalidationResult ? { lastRevalidationResult: options.lastRevalidationResult } : {}),
  };
}

export async function recordAnswerHistory(answer, options = {}) {
  const item = buildAnswerHistoryItem(answer, options);
  if (!item || !shouldRecordAnswerHistory(answer)) {
    return { recorded: false, reason: item?.finalStatus === "confirmed" ? "confirmed_not_watched" : "not_watchable" };
  }
  const dataDir = options.dataDir || join(process.cwd(), "data");
  const path = options.path || join(dataDir, "answer-history.json");
  const history = await loadAnswerHistory(path);
  const records = Array.isArray(history.records) ? history.records : [];
  const dedupeKey = answerHistoryDedupeKey(item);
  const existingIndex = records.findIndex((record) => answerHistoryDedupeKey(record) === dedupeKey);
  if (existingIndex >= 0) {
    records[existingIndex] = {
      ...records[existingIndex],
      ...item,
      id: records[existingIndex].id,
      createdAt: records[existingIndex].createdAt || item.createdAt,
      lastEvaluatedAt: item.lastEvaluatedAt,
      lastRevalidationResult: records[existingIndex].lastRevalidationResult,
    };
  } else {
    records.push(item);
  }
  await saveAnswerHistory({ schemaVersion: 1, records }, path);
  return {
    recorded: true,
    id: existingIndex >= 0 ? records[existingIndex].id : item.id,
    updatedExisting: existingIndex >= 0,
    path,
  };
}

export async function loadAnswerHistory(pathOrDataDir = join(process.cwd(), "data", "answer-history.json")) {
  const path = pathOrDataDir.endsWith?.(".json") ? pathOrDataDir : join(pathOrDataDir, "answer-history.json");
  try {
    const payload = JSON.parse(await readFile(path, "utf8"));
    return {
      schemaVersion: Number(payload.schemaVersion || 1),
      records: Array.isArray(payload.records) ? payload.records : [],
    };
  } catch {
    return { schemaVersion: 1, records: [] };
  }
}

export async function saveAnswerHistory(history, pathOrDataDir = join(process.cwd(), "data", "answer-history.json")) {
  const path = pathOrDataDir.endsWith?.(".json") ? pathOrDataDir : join(pathOrDataDir, "answer-history.json");
  const payload = {
    schemaVersion: Number(history?.schemaVersion || 1),
    records: Array.isArray(history?.records) ? history.records : [],
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function answerHistoryDedupeKey(item) {
  return stableHash({
    originalText: item?.originalText || "",
    watchCardIds: (item?.watchCardIds || []).map(String).sort(),
    formalQueryHash: stableHash(item?.formalQuery || {}),
  });
}

function collectProvisionalAnswers(answer) {
  return (answer.subAnswers || [])
    .map((item) => item.provisionalAnswer)
    .filter(Boolean)
    .map((item) => sanitizeJson(item));
}

function collectWatchCardIds(answer, provisionalAnswers) {
  const values = [
    ...(answer.cards || []).flatMap((card) => [card.id, card.passcode, card.liveId]),
    ...(answer.parserDebug?.evidenceTrace || []).flatMap((trace) => trace.resolvedCardIds || []),
    ...provisionalAnswers.flatMap((item) => item.watchOfficialDbConfig?.cardIds || []),
  ];
  return [...new Set(values.map(normalizeNumericId).filter((value) => value !== null))];
}

function collectWatchTerms(answer, provisionalAnswers) {
  const terms = [
    ...(answer.formalQuery?.cards || []).map((card) => card.name),
    ...(answer.formalQuery?.subQuestions || []).flatMap((item) => [item.card, item.sourceText, item.askedResult]),
    ...(answer.cards || []).flatMap((card) => [card.name, card.cnName, card.jaName, card.enName]),
    ...provisionalAnswers.flatMap((item) => item.watchOfficialDbConfig?.queryTerms || []),
  ];
  return [...new Set(terms.map((term) => String(term || "").trim()).filter((term) => term && term !== "unknown"))].slice(0, 80);
}

function collectUnknownReasons(answer, provisionalAnswers) {
  const reasons = new Set();
  if (provisionalAnswers.length) reasons.add("provisional_official_response");
  for (const subAnswer of answer.subAnswers || []) {
    const reason = String(subAnswer.reason || "");
    if (/condition_branch_missing_state/u.test(reason)) reasons.add("condition_branch_missing_state");
    if (/pending_adjustment/u.test(reason)) reasons.add("pending_adjustment");
    if (/no_direct_evidence|no_evidence|card_text_only|rejected_evidence_only|matcher_rejected_all/u.test(reason)) reasons.add("no_direct_evidence");
    for (const warning of subAnswer.warnings || []) {
      if (/provisional_official_response/u.test(warning)) reasons.add("provisional_official_response");
    }
  }
  for (const trace of answer.parserDebug?.evidenceTrace || []) {
    if (trace.finalStatus === "unknown" && !(trace.directEvidence || []).length) reasons.add("no_direct_evidence");
    if (/condition_branch_missing_state/u.test(String(trace.reason || ""))) reasons.add("condition_branch_missing_state");
    if (/pending_adjustment/u.test(String(trace.reason || ""))) reasons.add("pending_adjustment");
  }
  return [...reasons].length ? [...reasons] : answer.mode === "unknown" ? ["unknown"] : [];
}

function summarizeFinalVerdict(answer) {
  const verdicts = (answer.subAnswers || []).map((item) => item.verdict).filter(Boolean);
  if (!verdicts.length) return answer.verdict || "unknown";
  const unique = new Map(verdicts.map((item) => [JSON.stringify(item), item]));
  return unique.size === 1 ? [...unique.values()][0] : { subAnswers: verdicts };
}

function normalizeStatus(value) {
  return ["confirmed", "inferred", "unknown", "parse_failed"].includes(value) ? value : "unknown";
}

function normalizeNumericId(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/u.test(text)) return null;
  return Number(text);
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sanitizeJson(value) {
  return JSON.parse(JSON.stringify(value));
}
