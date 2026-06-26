import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FEEDBACK_TYPES = Object.freeze([
  "wrong_verdict",
  "missing_evidence",
  "wrong_card_resolution",
  "wrong_question_type",
  "should_be_confirmed",
  "should_be_unknown",
  "other",
]);

export const FEEDBACK_STATUSES = Object.freeze([
  "new",
  "triaged",
  "converted_to_test",
  "rejected",
]);

const FEEDBACK_TYPE_SET = new Set(FEEDBACK_TYPES);
const FEEDBACK_STATUS_SET = new Set(FEEDBACK_STATUSES);

export function createFeedbackCase({ originalQuestion, formalQuery, currentAnswer, userFeedback } = {}, options = {}) {
  const question = String(originalQuestion || currentAnswer?.formalQuery?.originalText || "").trim();
  if (!question) throw new Error("originalQuestion is required");
  const normalizedCurrentAnswer = normalizeCurrentAnswer(currentAnswer || {});
  const normalizedFeedback = normalizeUserFeedback(userFeedback || {});
  const now = options.now || new Date().toISOString();
  const base = {
    id: options.id || buildFeedbackId({ question, normalizedCurrentAnswer, normalizedFeedback, now }),
    originalQuestion: question,
    ...(formalQuery || currentAnswer?.formalQuery ? { formalQuery: cloneJson(formalQuery || currentAnswer.formalQuery) } : {}),
    currentAnswer: normalizedCurrentAnswer,
    userFeedback: normalizedFeedback,
    generatedRegressionDraft: {},
    createdAt: now,
    status: normalizeFeedbackStatus(options.status || "new"),
  };
  return {
    ...base,
    generatedRegressionDraft: generateRegressionDraft(base),
  };
}

export function generateRegressionDraft(feedbackCase = {}) {
  const feedback = feedbackCase.userFeedback || {};
  const currentAnswer = feedbackCase.currentAnswer || {};
  const formalQuery = feedbackCase.formalQuery || {};
  const draft = {
    expectedCards: collectExpectedCards(formalQuery),
    expectedQuestionTypes: collectQuestionTypes(formalQuery),
    notes: "",
  };
  const notes = [];

  switch (feedback.type) {
    case "wrong_verdict":
      draft.forbiddenStatuses = currentAnswer.finalStatus ? [currentAnswer.finalStatus] : [];
      if (feedback.expectedVerdict !== undefined) draft.expectedVerdict = cloneJson(feedback.expectedVerdict);
      if (feedback.expectedStatus) draft.expectedStatus = feedback.expectedStatus;
      notes.push("Review verdict extractor, evidence selection, and final gate trace before converting this draft.");
      break;
    case "missing_evidence":
      notes.push("Needs additional official evidence. Do not set expectedStatus to confirmed until direct official evidence is available.");
      break;
    case "wrong_card_resolution":
      notes.push("Expected cards require manual confirmation before enabling this as a regression assertion.");
      break;
    case "wrong_question_type":
      notes.push("Expected question types require manual confirmation before enabling this as a regression assertion.");
      break;
    case "should_be_unknown":
      draft.expectedStatus = feedback.expectedStatus || "unknown";
      draft.forbiddenStatuses = ["confirmed"];
      notes.push("User expects conservative unknown; confirmed must remain forbidden unless direct evidence later proves otherwise.");
      break;
    case "should_be_confirmed":
      draft.expectedStatus = "confirmed";
      if (feedback.expectedVerdict !== undefined) draft.expectedVerdict = cloneJson(feedback.expectedVerdict);
      notes.push("requires direct official evidence before enabling");
      break;
    default:
      notes.push("Manual triage required before converting this feedback into a regression test.");
      break;
  }

  if (feedback.supportingSourceUrl) notes.push(`User supplied source URL: ${feedback.supportingSourceUrl}`);
  if (feedback.supportingSourceText) notes.push("User supplied source text; verify official provenance before using it as evidence.");
  if (currentAnswer.evidenceIds?.length) draft.forbiddenEvidenceIds = [];

  return cleanDraft({
    ...draft,
    notes: notes.join(" "),
  });
}

export async function appendFeedbackCase(input, options = {}) {
  const path = options.path || join(options.dataDir || join(process.cwd(), "data"), "feedback-cases.json");
  const feedbackCase = createFeedbackCase(input, options);
  const payload = await loadFeedbackCases(path);
  const records = Array.isArray(payload.records) ? payload.records : [];
  records.push(feedbackCase);
  await saveFeedbackCases({ schemaVersion: 1, records }, path);
  return feedbackCase;
}

export async function loadFeedbackCases(pathOrDataDir = join(process.cwd(), "data", "feedback-cases.json")) {
  const path = String(pathOrDataDir).endsWith(".json") ? pathOrDataDir : join(pathOrDataDir, "feedback-cases.json");
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

export async function saveFeedbackCases(payload, pathOrDataDir = join(process.cwd(), "data", "feedback-cases.json")) {
  const path = String(pathOrDataDir).endsWith(".json") ? pathOrDataDir : join(pathOrDataDir, "feedback-cases.json");
  const normalized = {
    schemaVersion: Number(payload?.schemaVersion || 1),
    records: Array.isArray(payload?.records) ? payload.records : [],
  };
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function buildFeedbackSummary(records = []) {
  const counts = Object.fromEntries(FEEDBACK_STATUSES.map((status) => [status, 0]));
  for (const record of records) {
    counts[normalizeFeedbackStatus(record?.status || "new")] += 1;
  }
  return {
    total: records.length,
    counts,
    latest: [...records]
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, 20),
  };
}

export function exportFeedbackRegressionDrafts(records = [], { format = "json" } = {}) {
  const drafts = records.map((record) => ({
    id: record.id,
    originalQuestion: record.originalQuestion,
    feedbackType: record.userFeedback?.type || "other",
    status: record.status || "new",
    generatedRegressionDraft: record.generatedRegressionDraft || generateRegressionDraft(record),
  }));
  if (format === "markdown") return formatDraftsAsMarkdown(drafts);
  return {
    total: drafts.length,
    drafts,
  };
}

function normalizeCurrentAnswer(answer) {
  const subAnswer = Array.isArray(answer.subAnswers) && answer.subAnswers.length === 1 ? answer.subAnswers[0] : null;
  return {
    finalStatus: normalizeAnswerStatus(answer.finalStatus || answer.mode || answer.status || answer.confidence?.status || subAnswer?.status || "unknown"),
    finalVerdict: cloneJson(answer.finalVerdict ?? subAnswer?.verdict ?? answer.verdict ?? "unknown"),
    ...(answer.reason || subAnswer?.reason ? { reason: String(answer.reason || subAnswer.reason) } : {}),
    evidenceIds: uniqueStrings(answer.evidenceIds || subAnswer?.evidenceIds || []),
    ...(answer.conditionalAnswer || subAnswer?.conditionalAnswer ? { conditionalAnswer: cloneJson(answer.conditionalAnswer || subAnswer.conditionalAnswer) } : {}),
    ...(answer.provisionalAnswer || subAnswer?.provisionalAnswer ? { provisionalAnswer: cloneJson(answer.provisionalAnswer || subAnswer.provisionalAnswer) } : {}),
  };
}

function normalizeUserFeedback(feedback) {
  const type = FEEDBACK_TYPE_SET.has(feedback.type) ? feedback.type : "other";
  return {
    type,
    comment: String(feedback.comment || "").trim(),
    ...(feedback.expectedVerdict !== undefined ? { expectedVerdict: cloneJson(feedback.expectedVerdict) } : {}),
    ...(feedback.expectedStatus ? { expectedStatus: normalizeExpectedStatus(feedback.expectedStatus) } : {}),
    ...(feedback.supportingSourceUrl ? { supportingSourceUrl: String(feedback.supportingSourceUrl).trim() } : {}),
    ...(feedback.supportingSourceText ? { supportingSourceText: String(feedback.supportingSourceText).trim() } : {}),
  };
}

function collectExpectedCards(formalQuery) {
  return uniqueStrings((formalQuery.cards || []).map((card) => card.name).filter((name) => name && name !== "unknown"));
}

function collectQuestionTypes(formalQuery) {
  return uniqueStrings((formalQuery.subQuestions || []).map((question) => question.type).filter((type) => type && type !== "unknown"));
}

function cleanDraft(draft) {
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== "";
  }));
}

function formatDraftsAsMarkdown(drafts) {
  const lines = ["# Feedback Regression Drafts", ""];
  for (const draft of drafts) {
    lines.push(`## ${draft.id}`);
    lines.push("");
    lines.push(`- feedbackType: ${draft.feedbackType}`);
    lines.push(`- status: ${draft.status}`);
    lines.push(`- question: ${draft.originalQuestion}`);
    lines.push("```json");
    lines.push(JSON.stringify(draft.generatedRegressionDraft, null, 2));
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function normalizeAnswerStatus(value) {
  return ["confirmed", "inferred", "unknown", "parse_failed"].includes(value) ? value : "unknown";
}

function normalizeExpectedStatus(value) {
  return ["confirmed", "inferred", "unknown"].includes(value) ? value : "unknown";
}

function normalizeFeedbackStatus(value) {
  return FEEDBACK_STATUS_SET.has(value) ? value : "new";
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function buildFeedbackId(value) {
  const date = String(value.now || new Date().toISOString()).slice(0, 10).replace(/-/gu, "");
  return `feedback-${date}-${stableHash(value).slice(0, 16)}`;
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
