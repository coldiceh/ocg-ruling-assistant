const TERMINAL_RESULT_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"]);
const LOCAL_TERMINAL_RESULT_STATUSES = new Set([
  "completed_valid",
  "completed_invalid",
  "error_rejected",
  "error_outcome_unknown",
]);
const EFFORT_ORDER = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
const VERDICT_MODES = new Set(["determinate", "any"]);
const DETERMINATE_VERDICT_VALUES = new Set(["TRUE", "FALSE"]);
const INDETERMINATE_VERDICT_VALUES = new Set(["CONDITIONAL", "UNKNOWN"]);

/**
 * Scores a completed paid-experiment report against an independently loaded
 * assertion fixture. This module is intentionally outside the production
 * ruling pipeline: assertions describe evaluation expectations and never
 * participate in evidence preparation or model requests.
 */
export function scoreOfflineExperimentReport({ report, assertionFixture } = {}) {
  const normalizedReports = normalizeExperimentReports(report);
  const assertionsByCaseId = validateAssertionFixture(assertionFixture);
  const results = [];

  for (const caseReport of normalizedReports) {
    const testCase = assertionsByCaseId.get(caseReport.caseId);
    if (!testCase) {
      for (const item of caseReport.results) {
        results.push(inconclusiveScore(caseReport.caseId, item, "没有该 case 的离线断言。"));
      }
      continue;
    }
    for (const item of caseReport.results) {
      results.push(scoreResult({ caseId: caseReport.caseId, item, testCase }));
    }
  }

  const counts = countStatuses(results);
  return {
    schemaVersion: 1,
    assessmentType: "offline_post_paid_assertion_check",
    humanTruth: false,
    disclaimer: "这是付费结果生成后的离线回归检查，不是官方裁定，也不会把标准答案发送给模型。",
    counts,
    allPassed: results.length > 0 && counts.PASS === results.length,
    configurations: summarizeConfigurations(results),
    lowestPassingEfforts: summarizeLowestPassingEfforts(results),
    results,
  };
}

export function assertPaidExperimentReportGenerated(report) {
  assertLocalRelayCheckpointTerminal(report);
  const normalized = normalizeExperimentReports(report);
  if (normalized.length === 0 || normalized.every((item) => item.results.length === 0)) {
    throw scorerError("experiment report contains no generated model results");
  }
  for (const caseReport of normalized) {
    for (const result of caseReport.results) {
      const status = normalizeStatus(result?.status);
      if (!TERMINAL_RESULT_STATUSES.has(status)) {
        throw scorerError(
          `experiment result is not terminal: ${caseReport.caseId}/${status || "UNKNOWN"}`,
        );
      }
    }
  }
  return normalized;
}

function assertLocalRelayCheckpointTerminal(report) {
  if (report?.runner !== "local-relay-effort-experiment/v1") return;
  if (String(report?.status || "").trim().toLowerCase() !== "completed") {
    throw scorerError("local Relay checkpoint is not completed");
  }
  if (!Array.isArray(report.results) || report.results.length === 0) {
    throw scorerError("local Relay checkpoint contains no generated model results");
  }
  if (Number.isInteger(report.plannedRequests)
    && report.plannedRequests !== report.results.length) {
    throw scorerError("local Relay checkpoint does not contain every planned result");
  }
  for (const item of report.results) {
    const status = String(item?.status || "").trim().toLowerCase();
    if (!LOCAL_TERMINAL_RESULT_STATUSES.has(status)) {
      throw scorerError(
        `local Relay result is not terminal: ${item?.caseId || "unknown"}/${status || "unknown"}`,
      );
    }
  }
}

export function validateAssertionFixture(value) {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.goldens)) {
    throw scorerError("assertion fixture must use schemaVersion 1 and contain goldens");
  }
  const result = new Map();
  for (const [index, item] of value.goldens.entries()) {
    if (!isObject(item)) throw scorerError(`goldens[${index}] must be an object`);
    const id = requiredText(item.id, `goldens[${index}].id`);
    if (result.has(id)) throw scorerError(`duplicate golden id: ${id}`);
    const assertions = normalizeAssertions(item.assertions, `goldens[${index}].assertions`);
    const verdictMode = normalizeVerdictMode(item.verdictMode, `goldens[${index}].verdictMode`);
    result.set(id, Object.freeze({ id, assertions, verdictMode }));
  }
  return result;
}

function scoreResult({ caseId, item, testCase }) {
  const identity = resultIdentity(caseId, item);
  if (item?.localExecutionStatus && item.localExecutionStatus !== "completed_valid") {
    return inconclusiveScore(
      caseId,
      item,
      `本地模型结果状态为 ${item.localExecutionStatus}，只有 completed_valid 可以评分。`,
      identity,
    );
  }
  if (item?.localExecutionStatus === "completed_valid"
    && (!validationHardOk(item?.validation) || !isObject(item?.validation?.normalized))) {
    return inconclusiveScore(
      caseId,
      item,
      "本地模型结果缺少成功的结构化校验或 normalized 结果。",
      identity,
    );
  }
  if (normalizeStatus(item?.status) !== "SUCCEEDED") {
    return inconclusiveScore(
      caseId,
      item,
      `模型运行状态为 ${normalizeStatus(item?.status) || "UNKNOWN"}，没有可判定的成功结果。`,
    );
  }
  if ((item?.validation && !validationHardOk(item.validation))
    || (item?.result?.validation && !validationHardOk(item.result.validation))) {
    return inconclusiveScore(caseId, item, "模型结果没有通过结构化校验。", identity);
  }
  const extracted = extractStructuredRuling(item);
  if (!extracted) {
    return inconclusiveScore(caseId, item, "成功运行中没有可读取的结构化裁定。", identity);
  }
  const verdictModeCheck = evaluateVerdictMode(testCase.verdictMode, extracted.ruling);
  const surfaces = collectTextSurfaces(extracted.ruling);
  if (surfaces.all.length === 0) {
    return inconclusiveScore(caseId, item, "结构化裁定没有任何可评分文本。", identity);
  }

  const checks = testCase.assertions.map((assertion) => evaluateAssertion(assertion, surfaces));
  if (!verdictModeCheck.passed) checks.unshift(verdictModeCheck);
  const missingConclusions = checks
    .filter((check) => !check.passed)
    .map((check) => ({ assertionId: check.assertionId, description: check.description }));
  const status = missingConclusions.length === 0 ? "PASS" : "FAIL";
  return {
    ...identity,
    status,
    structuredResultSource: extracted.source,
    missingConclusions,
    checks,
  };
}

function evaluateAssertion(assertion, surfaces) {
  const candidates = surfaces[assertion.source] || [];
  const evaluations = candidates.map((text, surfaceIndex) => {
    const matchedAlternatives = assertion.allOf.map((alternatives) => (
      alternatives.find((candidate) => text.includes(candidate)) || null
    ));
    const forbiddenMatches = assertion.noneOf.filter((candidate) => text.includes(candidate));
    return {
      surfaceIndex,
      matchedAlternatives,
      forbiddenMatches,
      matchedGroupCount: matchedAlternatives.filter(Boolean).length,
      passed: matchedAlternatives.every(Boolean) && forbiddenMatches.length === 0,
    };
  });
  const passing = evaluations.find((item) => item.passed);
  const best = passing || evaluations.sort((left, right) => (
    right.matchedGroupCount - left.matchedGroupCount
    || left.forbiddenMatches.length - right.forbiddenMatches.length
    || left.surfaceIndex - right.surfaceIndex
  ))[0] || {
    surfaceIndex: null,
    matchedAlternatives: assertion.allOf.map(() => null),
    forbiddenMatches: [],
    passed: false,
  };
  return {
    assertionId: assertion.id,
    description: assertion.description,
    source: assertion.source,
    passed: best.passed,
    matchedSurfaceIndex: best.surfaceIndex,
    matchedAlternatives: best.matchedAlternatives,
    missingGroups: assertion.allOf
      .map((alternatives, index) => best.matchedAlternatives[index] ? null : alternatives)
      .filter(Boolean),
    forbiddenMatches: best.forbiddenMatches,
  };
}

function evaluateVerdictMode(verdictMode, ruling) {
  const mode = VERDICT_MODES.has(verdictMode) ? verdictMode : "determinate";
  if (mode === "any") return passedVerdictModeCheck("该评测允许条件性或未知裁定。");

  const verdicts = array(ruling?.verdicts);
  // Preserve compatibility with legacy independently-produced reports that
  // contain only conciseAnswer. Whenever structured verdicts are present,
  // however, a determinate fixture must not accept CONDITIONAL or UNKNOWN.
  if (verdicts.length === 0) {
    return passedVerdictModeCheck("需要确定裁定（旧版仅 conciseAnswer 结果）。");
  }

  const values = verdicts.map((item) => String(item?.value || "").trim().toUpperCase());
  const indeterminate = values.filter((value) => INDETERMINATE_VERDICT_VALUES.has(value));
  const invalid = values.filter((value) => !DETERMINATE_VERDICT_VALUES.has(value)
    && !INDETERMINATE_VERDICT_VALUES.has(value));
  const passed = indeterminate.length === 0
    && invalid.length === 0
    && values.every((value) => DETERMINATE_VERDICT_VALUES.has(value));
  return {
    assertionId: "verdict-mode",
    description: "该 case 要求所有结构化 verdict 都是确定裁定（TRUE 或 FALSE）。",
    source: "verdicts",
    passed,
    matchedSurfaceIndex: null,
    matchedAlternatives: passed ? values : [],
    missingGroups: passed ? [] : [["TRUE", "FALSE"]],
    forbiddenMatches: [...indeterminate, ...invalid],
  };
}

function passedVerdictModeCheck(description) {
  return {
    assertionId: "verdict-mode",
    description,
    source: "verdicts",
    passed: true,
    matchedSurfaceIndex: null,
    matchedAlternatives: [],
    missingGroups: [],
    forbiddenMatches: [],
  };
}

function extractStructuredRuling(value) {
  const candidates = [
    ["validatedStructuredResult", value?.validatedStructuredResult],
    ["validatedFinalRuling", value?.validatedFinalRuling],
    ["structuredResult", value?.structuredResult],
    ["result.finalRuling", value?.result?.finalRuling],
    ["finalRuling", value?.finalRuling],
    ["matrixSummary", hasRulingFields(value) ? value : null],
  ];
  for (const [source, candidate] of candidates) {
    const ruling = candidate?.finalRuling ?? candidate;
    if (isObject(ruling) && hasRulingFields(ruling)) return { source, ruling };
  }
  return null;
}

function collectTextSurfaces(ruling) {
  const concise = normalizeText(ruling?.conciseAnswer);
  const verdicts = array(ruling?.verdicts)
    .filter((item) => DETERMINATE_VERDICT_VALUES.has(String(item?.value || "").trim().toUpperCase()))
    .map((item) => normalizeText(item?.conclusion))
    .filter(Boolean);
  const claims = array(ruling?.claims)
    .map((item) => normalizeText(item?.proposition))
    .filter(Boolean);
  const timeline = array(ruling?.timeline)
    .map((item) => normalizeText([item?.action, item?.result].filter(Boolean).join("\n")))
    .filter(Boolean);
  const primary = [concise, ...verdicts].filter(Boolean);
  return {
    concise: concise ? [concise] : [],
    verdicts,
    claims,
    timeline,
    // Every assertion must be satisfied by one primary answer surface. Do not
    // combine rejected conditions, supporting claims, or separate timeline
    // steps into a conclusion the model never actually stated.
    all: primary,
  };
}

function normalizeVerdictMode(value, label) {
  const mode = String(value || "determinate").trim().toLowerCase();
  if (!VERDICT_MODES.has(mode)) {
    throw scorerError(`${label} must be determinate or any`);
  }
  return mode;
}

function normalizeAssertions(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw scorerError(`${label} must be a non-empty array`);
  }
  const seen = new Set();
  return value.map((item, index) => {
    if (!isObject(item)) throw scorerError(`${label}[${index}] must be an object`);
    const id = requiredText(item.id, `${label}[${index}].id`);
    if (seen.has(id)) throw scorerError(`${label} contains duplicate assertion id: ${id}`);
    seen.add(id);
    const source = String(item.source || "all").trim();
    if (!["concise", "verdicts", "claims", "timeline", "all"].includes(source)) {
      throw scorerError(`${label}[${index}].source is invalid`);
    }
    if (!Array.isArray(item.allOf) || item.allOf.length === 0) {
      throw scorerError(`${label}[${index}].allOf must be a non-empty array`);
    }
    const allOf = item.allOf.map((group, groupIndex) => {
      if (!Array.isArray(group) || group.length === 0) {
        throw scorerError(`${label}[${index}].allOf[${groupIndex}] must be non-empty`);
      }
      return group.map((candidate) => normalizedRequiredText(
        candidate,
        `${label}[${index}].allOf[${groupIndex}]`,
      ));
    });
    const noneOf = array(item.noneOf).map((candidate) => normalizedRequiredText(
      candidate,
      `${label}[${index}].noneOf`,
    ));
    return Object.freeze({
      id,
      description: requiredText(item.description, `${label}[${index}].description`),
      source,
      allOf,
      noneOf,
    });
  });
}

function normalizeExperimentReports(value) {
  if (!isObject(value)) throw scorerError("experiment report must be an object");
  if (
    value.runner === "local-relay-effort-experiment/v1"
    && Array.isArray(value.results)
  ) {
    const grouped = new Map();
    for (const item of value.results) {
      const caseId = requiredText(item?.caseId, "local experiment result caseId");
      if (!grouped.has(caseId)) grouped.set(caseId, []);
      grouped.get(caseId).push(normalizeLocalExperimentResult(item));
    }
    return [...grouped.entries()].map(([caseId, results]) => ({ caseId, results }));
  }
  const reports = Array.isArray(value.reports)
    ? value.reports
    : (value.caseId && Array.isArray(value.results) ? [value] : []);
  return reports.map((item, index) => {
    if (!isObject(item)) throw scorerError(`reports[${index}] must be an object`);
    return {
      caseId: requiredText(item.caseId, `reports[${index}].caseId`),
      results: Array.isArray(item.results) ? item.results : [],
    };
  });
}

function normalizeLocalExperimentResult(item) {
  const localStatus = String(item?.status || "").trim().toLowerCase();
  const validation = item?.validatedResult || null;
  const validated = localStatus === "completed_valid"
    && validationHardOk(validation)
    && isObject(validation?.normalized);
  return {
    ...item,
    status: validated ? "SUCCEEDED" : "FAILED",
    requestedModel: item?.requestedModel || item?.model || null,
    returnedModel: item?.reportedModel || item?.submittedModel || null,
    configuration: {
      model: item?.requestedModel || item?.model || null,
      reasoningMode: item?.reasoningMode || "pro",
      reasoningEffort: item?.effort || null,
      evidenceVariant: item?.evidenceVariant || "full",
    },
    validation,
    validatedStructuredResult: validated ? validation.normalized : null,
    localExecutionStatus: localStatus || null,
  };
}

function validationHardOk(validation) {
  if (!isObject(validation)) return false;
  if (isObject(validation.hardValidity)
    && typeof validation.hardValidity.ok === "boolean") {
    return validation.hardValidity.ok;
  }
  return validation.ok === true;
}

function inconclusiveScore(caseId, item, reason, identity = resultIdentity(caseId, item)) {
  return {
    ...identity,
    status: "INCONCLUSIVE",
    structuredResultSource: null,
    missingConclusions: [],
    checks: [],
    reason,
  };
}

function resultIdentity(caseId, item) {
  const configuration = isObject(item?.configuration) ? item.configuration : {};
  return {
    caseId,
    runId: String(item?.runId || "") || null,
    requestedModel: String(item?.requestedModel || configuration.model || "") || null,
    returnedModel: String(item?.returnedModel || "") || null,
    reasoningMode: String(configuration.reasoningMode || configuration.mode || "") || null,
    reasoningEffort: String(configuration.reasoningEffort || configuration.effort || "") || null,
    evidenceVariant: String(item?.evidenceVariant || configuration.evidenceVariant || "") || null,
  };
}

function summarizeConfigurations(results) {
  const groups = new Map();
  for (const item of results) {
    const key = [
      item.requestedModel || "unknown",
      item.reasoningMode || "unknown",
      item.reasoningEffort || "unknown",
      item.evidenceVariant || "unknown",
    ].join(":");
    if (!groups.has(key)) groups.set(key, { configurationKey: key, PASS: 0, FAIL: 0, INCONCLUSIVE: 0 });
    groups.get(key)[item.status] += 1;
  }
  return [...groups.values()].map((item) => ({
    ...item,
    total: item.PASS + item.FAIL + item.INCONCLUSIVE,
  }));
}

function summarizeLowestPassingEfforts(results) {
  const groups = new Map();
  for (const item of results.filter((entry) => entry.status === "PASS")) {
    const key = `${item.caseId}:${item.requestedModel || "unknown"}:${item.evidenceVariant || "unknown"}`;
    const current = groups.get(key);
    if (!current || effortRank(item.reasoningEffort) < effortRank(current.reasoningEffort)) {
      groups.set(key, {
        caseId: item.caseId,
        requestedModel: item.requestedModel,
        evidenceVariant: item.evidenceVariant,
        reasoningEffort: item.reasoningEffort,
      });
    }
  }
  return [...groups.values()];
}

function countStatuses(results) {
  const counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const item of results) counts[item.status] += 1;
  return counts;
}

function effortRank(value) {
  const rank = EFFORT_ORDER.indexOf(String(value || "").toLowerCase());
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

function hasRulingFields(value) {
  return isObject(value) && (
    typeof value.conciseAnswer === "string"
    || Array.isArray(value.verdicts)
    || Array.isArray(value.claims)
    || Array.isArray(value.timeline)
  );
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[，。；：、！？,.!?;:'"“”‘’「」『』（）()[\]【】《》〈〉·•—–\-_=+]/gu, "")
    // Normalize common Chinese OCG translation variants before matching the
    // generic assertion vocabulary. These are language equivalents, not
    // case-specific ruling shortcuts.
    .replace(/(?:牌组|牌库)/gu, "卡组")
    .replace(/(?:丢弃|舍弃)(?=[0-9一二两])/gu, "弃");
}

function normalizedRequiredText(value, label) {
  const text = normalizeText(value);
  if (!text) throw scorerError(`${label} must contain non-empty strings`);
  return text;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw scorerError(`${label} must be a non-empty string`);
  return text;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function scorerError(message) {
  const error = new Error(`offline experiment scorer error: ${message}`);
  error.code = "offline_experiment_scorer_invalid";
  return error;
}
