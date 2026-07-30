import { readFile } from "node:fs/promises";

const DEFAULT_CORPUS_URL = new URL(
  "../data/test/admin-model-lab-evaluations.json",
  import.meta.url,
);

export const ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER =
  "这是可解释的自动回归检查，不是人工裁定真值，也不能替代人工复核。";

export async function loadAdminLabEvaluationCorpus({
  corpusUrl = DEFAULT_CORPUS_URL,
  readFileImpl = readFile,
} = {}) {
  if (typeof readFileImpl !== "function") {
    throw new TypeError("readFileImpl must be a function");
  }
  const text = await readFileImpl(corpusUrl, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw evaluationError("evaluation corpus is invalid JSON");
  }
  return validateEvaluationCorpus(parsed);
}

export function evaluateAdminLabResult({
  testCase,
  structuredResult,
  evidenceSnapshot,
} = {}) {
  const normalizedCase = validateEvaluationCase(testCase);
  const finalRuling = unwrapFinalRuling(structuredResult);
  const answerText = collectAnswerText(finalRuling);
  const normalizedAnswer = normalizeForMatch(answerText);

  const keyPoints = normalizedCase.expectedAnswerKeyPoints.map((expected) => {
    const normalizedExpected = normalizeForMatch(expected);
    const matched = Boolean(normalizedExpected)
      && normalizedAnswer.includes(normalizedExpected);
    return {
      expected,
      matched,
      method: "normalized_substring",
      explanation: matched
        ? "结构化回答中找到了该关键点。"
        : "结构化回答中没有找到该关键点；可能缺失，也可能使用了当前确定性检查无法识别的改写。",
    };
  });

  const forbiddenPhrases = normalizedCase.mustNotInclude.map((phrase) => {
    const normalizedPhrase = normalizeForMatch(phrase);
    const present = Boolean(normalizedPhrase)
      && normalizedAnswer.includes(normalizedPhrase);
    return {
      phrase,
      present,
      method: "normalized_substring",
      explanation: present
        ? "结构化回答包含明确禁止的表述。"
        : "结构化回答未出现该禁止表述。",
    };
  });

  const foundCardIds = collectEvidenceCardIds(evidenceSnapshot);
  const cardEvidence = normalizedCase.expectedCardIds.map((cardId) => {
    const found = foundCardIds.has(cardId);
    return {
      cardId,
      found,
      explanation: found
        ? "Evidence Snapshot 中存在该卡的卡片证据。"
        : "Evidence Snapshot 中未发现该卡的卡片证据。",
    };
  });

  const matchedKeyPointCount = keyPoints.filter((item) => item.matched).length;
  const forbiddenHitCount = forbiddenPhrases.filter((item) => item.present).length;
  const foundCardCount = cardEvidence.filter((item) => item.found).length;
  const keyPointCoverage = ratio(matchedKeyPointCount, keyPoints.length);
  const cardEvidenceCoverage = ratio(foundCardCount, cardEvidence.length);
  const passed = keyPointCoverage === 1
    && forbiddenHitCount === 0
    && cardEvidenceCoverage === 1;

  return Object.freeze({
    schemaVersion: 1,
    testCaseId: normalizedCase.id,
    assessmentType: "automated_regression_check",
    humanTruth: false,
    disclaimer: ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
    passed,
    summary: {
      matchedKeyPointCount,
      totalKeyPointCount: keyPoints.length,
      keyPointCoverage,
      forbiddenHitCount,
      foundCardCount,
      expectedCardCount: cardEvidence.length,
      cardEvidenceCoverage,
    },
    checks: {
      keyPoints,
      forbiddenPhrases,
      cardEvidence,
    },
  });
}

export function evaluateAdminLabCorpusResults({
  corpus,
  resultsByCaseId,
} = {}) {
  const normalizedCorpus = validateEvaluationCorpus(corpus);
  const resultMap = normalizeResultMap(resultsByCaseId);
  const cases = normalizedCorpus.cases.map((testCase) => {
    const entry = resultMap.get(testCase.id);
    if (!entry) {
      return {
        testCaseId: testCase.id,
        assessmentType: "automated_regression_check",
        humanTruth: false,
        disclaimer: ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
        passed: false,
        missingResult: true,
        explanation: "没有为该测试用例提供结构化结果。",
      };
    }
    return evaluateAdminLabResult({
      testCase,
      structuredResult: entry.structuredResult ?? entry.result ?? entry,
      evidenceSnapshot: entry.evidenceSnapshot,
    });
  });
  return {
    schemaVersion: 1,
    assessmentType: "automated_regression_suite",
    humanTruth: false,
    disclaimer: ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
    passed: cases.every((item) => item.passed),
    passedCount: cases.filter((item) => item.passed).length,
    totalCount: cases.length,
    cases,
  };
}

export function validateEvaluationCorpus(value) {
  if (!isPlainObject(value) || value.schemaVersion !== 1) {
    throw evaluationError("evaluation corpus schemaVersion must be 1");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw evaluationError("evaluation corpus must contain cases");
  }
  const seen = new Set();
  const cases = value.cases.map((item) => {
    const normalized = validateEvaluationCase(item);
    if (seen.has(normalized.id)) {
      throw evaluationError(`duplicate evaluation case id: ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  });
  return deepFreeze({
    schemaVersion: 1,
    fixtureName: String(value.fixtureName || ""),
    purpose: String(value.purpose || ""),
    cases,
  });
}

export function validateEvaluationCase(value) {
  if (!isPlainObject(value)) throw evaluationError("evaluation case must be an object");
  const id = String(value.id || "").trim();
  const question = String(value.question || "").trim();
  const expectedVerdict = String(value.expectedVerdict || "").trim();
  if (!id || !question || !expectedVerdict) {
    throw evaluationError("evaluation case requires id, question, and expectedVerdict");
  }
  return deepFreeze({
    id,
    mechanisms: stringArray(value.mechanisms, "mechanisms"),
    question,
    expectedCardIds: stringArray(value.expectedCardIds, "expectedCardIds"),
    expectedVerdict,
    expectedAnswerKeyPoints: stringArray(
      value.expectedAnswerKeyPoints,
      "expectedAnswerKeyPoints",
    ),
    mustNotInclude: stringArray(value.mustNotInclude, "mustNotInclude"),
  });
}

function unwrapFinalRuling(value) {
  const candidate = value?.result?.finalRuling
    ?? value?.finalRuling
    ?? value?.result
    ?? value;
  if (!isPlainObject(candidate)) {
    throw evaluationError("structured result is required");
  }
  return candidate;
}

function collectAnswerText(value) {
  const parts = [];
  pushText(parts, value.conciseAnswer);
  for (const verdict of array(value.verdicts)) {
    pushText(parts, verdict?.conclusion);
    for (const condition of array(verdict?.conditions)) pushText(parts, condition);
  }
  for (const claim of array(value.claims)) pushText(parts, claim?.proposition);
  for (const step of array(value.timeline)) {
    pushText(parts, step?.action);
    pushText(parts, step?.result);
  }
  for (const item of array(value.assumptions)) pushAllObjectText(parts, item);
  for (const item of array(value.counterChecks)) pushAllObjectText(parts, item);
  for (const item of array(value.unresolved)) pushAllObjectText(parts, item);
  return parts.join("\n");
}

function collectEvidenceCardIds(value) {
  const found = new Set();
  const visited = new Set();

  function visit(candidate, parentKey = "") {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === "string" || typeof candidate === "number") {
      if (/cardids?$/iu.test(parentKey)) addCardId(found, candidate);
      return;
    }
    if (typeof candidate !== "object" || visited.has(candidate)) return;
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, parentKey);
      return;
    }

    const sourceType = String(
      candidate.sourceType
      ?? candidate.recordType
      ?? candidate.type
      ?? "",
    ).toLowerCase();
    for (const [key, item] of Object.entries(candidate)) {
      if (/^(?:cardId|cardIds|subjectCardId|relatedCardIds)$/iu.test(key)) {
        for (const id of array(item)) addCardId(found, id);
        if (!Array.isArray(item)) addCardId(found, item);
      }
      visit(item, key);
    }

    if (/(?:^|[_\-\s])card(?:[_\-\s]|$)|card[_\-\s]?text/iu.test(sourceType)) {
      addCardId(found, candidate.id);
    }
    if (candidate.cardName && candidate.id !== undefined) addCardId(found, candidate.id);
  }

  visit(value);
  return found;
}

function addCardId(target, value) {
  const text = String(value ?? "").trim();
  const exact = /^\d+$/u.exec(text);
  if (exact) {
    target.add(String(Number(exact[0])));
    return;
  }
  const embedded = /(?:^|[^\d])(\d{4,10})(?:[^\d]|$)/u.exec(text);
  if (embedded) target.add(String(Number(embedded[1])));
}

function normalizeResultMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    return new Map(value.map((item) => [
      String(item?.testCaseId || item?.id || ""),
      item,
    ]));
  }
  if (isPlainObject(value)) return new Map(Object.entries(value));
  return new Map();
}

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[，。；：、！？,.!?;:'"“”‘’「」『』（）()[\]【】《》〈〉·•—–\-_=+]/gu, "");
}

function pushAllObjectText(target, value) {
  if (!isPlainObject(value)) return;
  for (const item of Object.values(value)) {
    if (typeof item === "string") pushText(target, item);
    else if (Array.isArray(item)) {
      for (const child of item) {
        if (typeof child === "string") pushText(target, child);
      }
    }
  }
}

function pushText(target, value) {
  const text = String(value || "").trim();
  if (text) target.push(text);
}

function stringArray(value, label) {
  if (!Array.isArray(value)) throw evaluationError(`${label} must be an array`);
  const result = value.map((item) => String(item || "").trim());
  if (result.some((item) => !item)) {
    throw evaluationError(`${label} must contain non-empty strings`);
  }
  return result;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function evaluationError(message) {
  const error = new Error(`admin lab evaluation error: ${message}`);
  error.code = "admin_lab_evaluation_invalid";
  return error;
}
