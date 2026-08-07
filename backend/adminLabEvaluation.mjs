import { readFile } from "node:fs/promises";

const DEFAULT_CORPUS_URL = new URL(
  "../data/test/admin-model-lab-evaluations.json",
  import.meta.url,
);

const VERDICT_VALUES = new Set(["TRUE", "FALSE", "CONDITIONAL", "UNKNOWN"]);

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
  const packet = locateModelVisibleDecisionPacket(evidenceSnapshot);

  const verdictAssertions = evaluateVerdictAssertions(
    normalizedCase.expectedAssertions.verdicts,
    finalRuling,
  );
  const claimAssertions = evaluateClaimAssertions(
    normalizedCase.expectedAssertions.claims,
    finalRuling,
  );
  const timelineOrderAssertions = evaluateTimelineOrderAssertions(
    normalizedCase.expectedAssertions.timelineOrder,
    finalRuling,
  );
  const assertionChecks = [
    ...verdictAssertions,
    ...claimAssertions,
    ...timelineOrderAssertions,
  ];

  const visibleEvidence = collectVisiblePacketEvidence(packet);
  const evidenceCoverage = normalizedCase.expectedEvidenceIds.map((evidenceId) => {
    const occurrences = visibleEvidence.occurrencesByEvidenceId.get(evidenceId) || [];
    const bestOccurrence = occurrences.length > 0
      ? occurrences.reduce((best, item) => item.packetRank < best.packetRank ? item : best)
      : null;
    const bestRank = bestOccurrence?.packetRank ?? null;
    const packetRank = bestOccurrence?.packetRank ?? null;
    const withinRank = bestRank !== null
      && (
        normalizedCase.expectedEvidenceMaxRank === null
        || bestRank <= normalizedCase.expectedEvidenceMaxRank
      );
    return {
      evidenceId,
      found: bestRank !== null,
      bestRank,
      packetRank,
      maxRank: normalizedCase.expectedEvidenceMaxRank,
      withinRank,
      explanation: bestRank === null
        ? "最终模型可见的 decision packet 中没有该证据。"
        : withinRank
          ? `该证据位于最终模型可见 decision packet 的第 ${packetRank} 项。`
          : `该证据位于最终模型可见 decision packet 的第 ${bestRank} 项，超过要求的前 ${normalizedCase.expectedEvidenceMaxRank} 项。`,
    };
  });

  const visibleCardIds = collectVisiblePacketCardIds(packet);
  const cardEvidence = normalizedCase.expectedCardIds.map((cardId) => {
    const found = visibleCardIds.has(cardId);
    return {
      cardId,
      found,
      explanation: found
        ? "最终模型可见的 decision packet 中存在该卡的卡片文本证据。"
        : "最终模型可见的 decision packet 中未发现该卡的卡片文本证据。",
    };
  });

  // These legacy lexical probes remain useful diagnostics, but are deliberately
  // excluded from the pass/fail gate. They cannot safely distinguish negation,
  // attribution, timing, or a paraphrase from the intended proposition.
  const normalizedAnswer = normalizeForMatch(collectAnswerText(finalRuling));
  const keyPoints = normalizedCase.expectedAnswerKeyPoints.map((expected) => {
    const normalizedExpected = normalizeForMatch(expected);
    const matched = Boolean(normalizedExpected) && normalizedAnswer.includes(normalizedExpected);
    return {
      expected,
      matched,
      gating: false,
      method: "normalized_substring_diagnostic_only",
      explanation: matched
        ? "回答中出现了该参考短语；此检查只作诊断，不决定通过。"
        : "未逐字命中该参考短语；可能缺失，也可能只是改写，此检查不决定通过。",
    };
  });
  const forbiddenPhrases = normalizedCase.mustNotInclude.map((phrase) => {
    const normalizedPhrase = normalizeForMatch(phrase);
    const present = Boolean(normalizedPhrase) && normalizedAnswer.includes(normalizedPhrase);
    return {
      phrase,
      present,
      gating: false,
      method: "normalized_substring_diagnostic_only",
      explanation: present
        ? "回答出现了参考禁句；请结合结构化断言复核其是否为引用、否定或实际结论。"
        : "回答未逐字出现该参考禁句。",
    };
  });

  const passedAssertionCount = assertionChecks.filter((item) => item.passed).length;
  const foundEvidenceCount = evidenceCoverage.filter((item) => item.withinRank).length;
  const foundCardCount = cardEvidence.filter((item) => item.found).length;
  const matchedKeyPointCount = keyPoints.filter((item) => item.matched).length;
  const forbiddenHitCount = forbiddenPhrases.filter((item) => item.present).length;
  const structuredAssertionCoverage = ratio(passedAssertionCount, assertionChecks.length);
  const evidenceCoverageRatio = ratio(foundEvidenceCount, evidenceCoverage.length);
  const cardEvidenceCoverage = ratio(foundCardCount, cardEvidence.length);
  const packetAvailable = Boolean(packet);
  const answerPassed = structuredAssertionCoverage === 1;
  const evidencePassed = packetAvailable
    && evidenceCoverageRatio === 1
    && cardEvidenceCoverage === 1;
  const pipelinePassed = answerPassed && evidencePassed;

  return Object.freeze({
    schemaVersion: 2,
    testCaseId: normalizedCase.id,
    assessmentType: "automated_regression_check",
    humanTruth: false,
    disclaimer: ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
    answerPassed,
    evidencePassed,
    pipelinePassed,
    // Backward-compatible aggregate: historically `passed` combined answer
    // correctness and evidence-pipeline coverage into one boolean.
    passed: pipelinePassed,
    expectedVerdict: {
      referenceText: normalizedCase.expectedVerdict,
      automaticallyCompared: false,
      explanation:
        "自然语言 expectedVerdict 只保留为人工参考；自动门槛使用测试语料中的结构化 expectedAssertions，避免把改写或否定误判为一致。",
    },
    summary: {
      packetAvailable,
      passedAssertionCount,
      totalAssertionCount: assertionChecks.length,
      structuredAssertionCoverage,
      foundEvidenceCount,
      expectedEvidenceCount: evidenceCoverage.length,
      evidenceCoverage: evidenceCoverageRatio,
      foundCardCount,
      expectedCardCount: cardEvidence.length,
      cardEvidenceCoverage,
      matchedKeyPointCount,
      totalKeyPointCount: keyPoints.length,
      keyPointCoverage: ratio(matchedKeyPointCount, keyPoints.length),
      forbiddenHitCount,
    },
    checks: {
      structuredAssertions: assertionChecks,
      decisionPacket: {
        available: packetAvailable,
        itemCount: array(packet?.evidenceItems).length,
        explanation: packetAvailable
          ? "证据覆盖只按最终模型可见 decision packet 计算。"
          : "未提供最终模型可见 decision packet；完整 Evidence Snapshot 中存在证据也不能代替。",
      },
      evidenceCoverage,
      cardEvidence,
      diagnostics: {
        keyPoints,
        forbiddenPhrases,
      },
      // Keep the former paths for existing admin UI/readers. Their entries now
      // explicitly state that they are diagnostic-only.
      keyPoints,
      forbiddenPhrases,
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
        answerPassed: false,
        evidencePassed: false,
        pipelinePassed: false,
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
  const answerPassedCount = cases.filter((item) => item.answerPassed).length;
  const evidencePassedCount = cases.filter((item) => item.evidencePassed).length;
  const pipelinePassedCount = cases.filter((item) => item.pipelinePassed).length;
  const answerPassed = cases.every((item) => item.answerPassed);
  const evidencePassed = cases.every((item) => item.evidencePassed);
  const pipelinePassed = cases.every((item) => item.pipelinePassed);
  return {
    schemaVersion: 2,
    assessmentType: "automated_regression_suite",
    humanTruth: false,
    disclaimer: ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
    answerPassed,
    evidencePassed,
    pipelinePassed,
    passed: pipelinePassed,
    answerPassedCount,
    evidencePassedCount,
    pipelinePassedCount,
    passedCount: pipelinePassedCount,
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
  const expectedEvidenceMaxRank = optionalPositiveInteger(
    value.expectedEvidenceMaxRank,
    "expectedEvidenceMaxRank",
  );
  const expectedAssertions = validateExpectedAssertions(value.expectedAssertions);
  return deepFreeze({
    id,
    mechanisms: stringArray(value.mechanisms, "mechanisms"),
    question,
    expectedCardIds: stringArray(value.expectedCardIds, "expectedCardIds").map(canonicalCardId),
    expectedEvidenceIds: stringArray(value.expectedEvidenceIds, "expectedEvidenceIds"),
    expectedEvidenceMaxRank,
    expectedVerdict,
    expectedAssertions,
    expectedAnswerKeyPoints: stringArray(
      value.expectedAnswerKeyPoints,
      "expectedAnswerKeyPoints",
    ),
    mustNotInclude: stringArray(value.mustNotInclude, "mustNotInclude"),
  });
}

function validateExpectedAssertions(value) {
  if (!isPlainObject(value)) {
    throw evaluationError("expectedAssertions must be an object");
  }
  const verdicts = array(value.verdicts).map((item, index) => {
    if (!isPlainObject(item)) {
      throw evaluationError(`expectedAssertions.verdicts[${index}] must be an object`);
    }
    const questionId = requiredString(item.questionId, `expectedAssertions.verdicts[${index}].questionId`);
    const verdictValue = requiredString(item.value, `expectedAssertions.verdicts[${index}].value`).toUpperCase();
    if (!VERDICT_VALUES.has(verdictValue)) {
      throw evaluationError(`expectedAssertions.verdicts[${index}].value is invalid`);
    }
    return { questionId, value: verdictValue };
  });
  const claims = array(value.claims).map((item, index) => {
    if (!isPlainObject(item)) {
      throw evaluationError(`expectedAssertions.claims[${index}] must be an object`);
    }
    const assertionId = requiredString(
      item.assertionId,
      `expectedAssertions.claims[${index}].assertionId`,
    );
    const status = item.status == null
      ? null
      : requiredVerdict(item.status, `expectedAssertions.claims[${index}].status`);
    return {
      assertionId,
      questionId: optionalString(item.questionId),
      status,
      decisive: item.decisive == null ? null : requiredBoolean(
        item.decisive,
        `expectedAssertions.claims[${index}].decisive`,
      ),
      evidenceIdsAll: stringArray(item.evidenceIdsAll || [], `expectedAssertions.claims[${index}].evidenceIdsAll`),
      proposition: validateTextPattern(
        item.proposition,
        `expectedAssertions.claims[${index}].proposition`,
      ),
    };
  });
  const timelineOrder = array(value.timelineOrder).map((item, index) => {
    if (!isPlainObject(item)) {
      throw evaluationError(`expectedAssertions.timelineOrder[${index}] must be an object`);
    }
    const assertionId = requiredString(
      item.assertionId,
      `expectedAssertions.timelineOrder[${index}].assertionId`,
    );
    if (!Array.isArray(item.steps) || item.steps.length < 2) {
      throw evaluationError(`expectedAssertions.timelineOrder[${index}].steps must contain at least two steps`);
    }
    return {
      assertionId,
      steps: item.steps.map((step, stepIndex) => {
        if (!isPlainObject(step)) {
          throw evaluationError(`expectedAssertions.timelineOrder[${index}].steps[${stepIndex}] must be an object`);
        }
        return {
          action: step.action == null
            ? null
            : validateTextPattern(
              step.action,
              `expectedAssertions.timelineOrder[${index}].steps[${stepIndex}].action`,
            ),
          result: step.result == null
            ? null
            : validateTextPattern(
              step.result,
              `expectedAssertions.timelineOrder[${index}].steps[${stepIndex}].result`,
            ),
          evidenceIdsAll: stringArray(
            step.evidenceIdsAll || [],
            `expectedAssertions.timelineOrder[${index}].steps[${stepIndex}].evidenceIdsAll`,
          ),
        };
      }),
    };
  });
  if (verdicts.length + claims.length + timelineOrder.length === 0) {
    throw evaluationError("expectedAssertions must contain at least one structured assertion");
  }
  return { verdicts, claims, timelineOrder };
}

function validateTextPattern(value, label) {
  if (!isPlainObject(value)) throw evaluationError(`${label} must be an object`);
  const allOf = array(value.allOf).map((group, index) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw evaluationError(`${label}.allOf[${index}] must be a non-empty string array`);
    }
    return stringArray(group, `${label}.allOf[${index}]`);
  });
  const noneOf = stringArray(value.noneOf || [], `${label}.noneOf`);
  if (allOf.length === 0 && noneOf.length === 0) {
    throw evaluationError(`${label} must define allOf or noneOf`);
  }
  return { allOf, noneOf };
}

function evaluateVerdictAssertions(expected, finalRuling) {
  const actual = array(finalRuling.verdicts);
  return expected.map((assertion) => {
    const candidate = actual.find(
      (item) => String(item?.questionId || "") === assertion.questionId,
    );
    const actualValue = String(candidate?.value || "").toUpperCase() || null;
    const passed = actualValue === assertion.value;
    return {
      assertionType: "verdict",
      assertionId: `verdict:${assertion.questionId}`,
      expected: assertion,
      actual: candidate || null,
      passed,
      explanation: passed
        ? `questionId=${assertion.questionId} 的结构化 verdict.value 与预期一致。`
        : `questionId=${assertion.questionId} 预期 ${assertion.value}，实际为 ${actualValue || "缺失"}。`,
    };
  });
}

function evaluateClaimAssertions(expected, finalRuling) {
  const claims = array(finalRuling.claims);
  return expected.map((assertion) => {
    const candidates = claims.filter((claim) => claimMatchesMetadata(claim, assertion));
    const matchingClaim = candidates.find(
      (claim) => textMatchesPattern(claim?.proposition, assertion.proposition),
    );
    const passed = Boolean(matchingClaim);
    return {
      assertionType: "claim",
      assertionId: assertion.assertionId,
      expected: assertion,
      actual: matchingClaim || null,
      candidateCount: candidates.length,
      passed,
      explanation: passed
        ? "找到同时满足结构化元数据和命题约束的 claim。"
        : "没有任何单个 claim 同时满足所需状态、证据归属和命题约束。",
    };
  });
}

function claimMatchesMetadata(claim, assertion) {
  if (!isPlainObject(claim)) return false;
  if (assertion.questionId && String(claim.questionId || "") !== assertion.questionId) return false;
  if (assertion.status && String(claim.status || "").toUpperCase() !== assertion.status) return false;
  if (assertion.decisive !== null && claim.decisive !== assertion.decisive) return false;
  const actualEvidenceIds = new Set(array(claim.evidenceIds).map(String));
  return assertion.evidenceIdsAll.every((id) => actualEvidenceIds.has(id));
}

function evaluateTimelineOrderAssertions(expected, finalRuling) {
  const timeline = [...array(finalRuling.timeline)].sort(
    (left, right) => Number(left?.order || 0) - Number(right?.order || 0),
  );
  return expected.map((assertion) => {
    const matchedSteps = [];
    let cursor = 0;
    for (const expectedStep of assertion.steps) {
      let foundIndex = -1;
      for (let index = cursor; index < timeline.length; index += 1) {
        if (timelineStepMatches(timeline[index], expectedStep)) {
          foundIndex = index;
          break;
        }
      }
      if (foundIndex === -1) break;
      matchedSteps.push(timeline[foundIndex]);
      cursor = foundIndex + 1;
    }
    const passed = matchedSteps.length === assertion.steps.length;
    return {
      assertionType: "timeline_order",
      assertionId: assertion.assertionId,
      expectedStepCount: assertion.steps.length,
      matchedStepCount: matchedSteps.length,
      actual: matchedSteps,
      passed,
      explanation: passed
        ? "timeline 中找到了按顺序出现的全部处理步骤。"
        : `timeline 只按顺序匹配到 ${matchedSteps.length}/${assertion.steps.length} 个处理步骤。`,
    };
  });
}

function timelineStepMatches(step, expected) {
  if (!isPlainObject(step)) return false;
  if (expected.action && !textMatchesPattern(step.action, expected.action)) return false;
  if (expected.result && !textMatchesPattern(step.result, expected.result)) return false;
  const evidenceIds = new Set(array(step.evidenceIds).map(String));
  return expected.evidenceIdsAll.every((id) => evidenceIds.has(id));
}

function textMatchesPattern(value, pattern) {
  const normalized = normalizeForMatch(value);
  const allGroupsMatch = pattern.allOf.every((alternatives) => alternatives.some((item) => {
    const candidate = normalizeForMatch(item);
    return Boolean(candidate) && normalized.includes(candidate);
  }));
  const forbiddenAbsent = pattern.noneOf.every((item) => {
    const candidate = normalizeForMatch(item);
    return !candidate || !normalized.includes(candidate);
  });
  return allGroupsMatch && forbiddenAbsent;
}

function locateModelVisibleDecisionPacket(value) {
  const candidates = [
    value?.evidence?.evidenceDecisionPacket?.modelPacket,
    value?.evidenceDecisionPacket?.modelPacket,
    value?.modelPacket,
  ];
  return candidates.find(
    (candidate) => isPlainObject(candidate) && Array.isArray(candidate.evidenceItems),
  ) || null;
}

function collectVisiblePacketEvidence(packet) {
  const occurrencesByEvidenceId = new Map();
  for (const [index, item] of array(packet?.evidenceItems).entries()) {
    const ids = new Set([
      ...array(item?.evidenceIds).map(String),
      ...(item?.evidenceId ? [String(item.evidenceId)] : []),
    ]);
    for (const id of ids) {
      if (!occurrencesByEvidenceId.has(id)) occurrencesByEvidenceId.set(id, []);
      occurrencesByEvidenceId.get(id).push({
        packetRank: index + 1,
      });
    }
  }
  return { occurrencesByEvidenceId };
}

function collectVisiblePacketCardIds(packet) {
  const found = new Set();
  for (const item of array(packet?.evidenceItems)) {
    const category = String(item?.category || item?.type || "").toLowerCase();
    const ids = [item?.evidenceId, ...array(item?.evidenceIds)];
    for (const id of ids) {
      const text = String(id || "");
      if (/^\d+$/u.test(text)) addCardId(found, text);
      const cardText = /^card-text-(\d+)$/iu.exec(text);
      if (cardText) addCardId(found, cardText[1]);
    }
    if (/(?:card|卡片).*(?:text|文本)|parsed_card_text/iu.test(category)) {
      addCardId(found, item?.cardId);
    }
  }
  return found;
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
  return parts.join("\n");
}

function addCardId(target, value) {
  const text = String(value ?? "").trim();
  const exact = /^\d+$/u.exec(text);
  if (exact) target.add(canonicalCardId(exact[0]));
}

function canonicalCardId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) throw evaluationError(`invalid card id: ${text}`);
  return String(Number(text));
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

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw evaluationError(`${label} must be a non-empty string`);
  return text;
}

function optionalString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw evaluationError(`${label} must be boolean`);
  return value;
}

function requiredVerdict(value, label) {
  const text = requiredString(value, label).toUpperCase();
  if (!VERDICT_VALUES.has(text)) throw evaluationError(`${label} is invalid`);
  return text;
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw evaluationError(`${label} must be a positive integer`);
  }
  return value;
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
