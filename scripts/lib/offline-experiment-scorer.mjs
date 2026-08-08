const TERMINAL_RESULT_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"]);
const LOCAL_TERMINAL_RESULT_STATUSES = new Set([
  "completed_valid",
  "completed_invalid",
  "error_rejected",
  "error_outcome_unknown",
]);
const EFFORT_ORDER = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

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
    result.set(id, Object.freeze({ id, assertions }));
  }
  return result;
}

function scoreResult({ caseId, item, testCase }) {
  const identity = resultIdentity(caseId, item);
  if (normalizeStatus(item?.status) !== "SUCCEEDED") {
    return inconclusiveScore(
      caseId,
      item,
      `模型运行状态为 ${normalizeStatus(item?.status) || "UNKNOWN"}，没有可判定的成功结果。`,
    );
  }
  if (item?.validation?.ok === false || item?.result?.validation?.ok === false) {
    return inconclusiveScore(caseId, item, "模型结果没有通过结构化校验。", identity);
  }
  const extracted = extractStructuredRuling(item);
  if (!extracted) {
    return inconclusiveScore(caseId, item, "成功运行中没有可读取的结构化裁定。", identity);
  }
  const surfaces = collectTextSurfaces(extracted.ruling);
  if (!surfaces.all) {
    return inconclusiveScore(caseId, item, "结构化裁定没有任何可评分文本。", identity);
  }

  const checks = testCase.assertions.map((assertion) => evaluateAssertion(assertion, surfaces));
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
  const text = surfaces[assertion.source];
  const matchedAlternatives = assertion.allOf.map((alternatives) => (
    alternatives.find((candidate) => text.includes(candidate)) || null
  ));
  const forbiddenMatches = assertion.noneOf.filter((candidate) => text.includes(candidate));
  const passed = matchedAlternatives.every(Boolean) && forbiddenMatches.length === 0;
  return {
    assertionId: assertion.id,
    description: assertion.description,
    source: assertion.source,
    passed,
    matchedAlternatives,
    missingGroups: assertion.allOf
      .map((alternatives, index) => matchedAlternatives[index] ? null : alternatives)
      .filter(Boolean),
    forbiddenMatches,
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
  const verdicts = normalizeText(array(ruling?.verdicts).flatMap((item) => [
    item?.conclusion,
    ...array(item?.conditions),
  ]).join("\n"));
  const claims = normalizeText(array(ruling?.claims).map((item) => item?.proposition).join("\n"));
  const timeline = normalizeText(array(ruling?.timeline).flatMap((item) => [
    item?.action,
    item?.result,
  ]).join("\n"));
  return {
    concise,
    verdicts,
    claims,
    timeline,
    all: [concise, verdicts, claims, timeline].filter(Boolean).join("\n"),
  };
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
  const transportCompleted = new Set(["completed_valid", "completed_invalid"]).has(localStatus);
  const validation = item?.validatedResult || null;
  const rawStructuredResult = parseLocalRawOutput(item?.rawOutput);
  return {
    ...item,
    status: transportCompleted ? "SUCCEEDED" : "FAILED",
    requestedModel: item?.requestedModel || item?.model || null,
    returnedModel: item?.reportedModel || item?.submittedModel || null,
    configuration: {
      model: item?.requestedModel || item?.model || null,
      reasoningMode: item?.reasoningMode || "pro",
      reasoningEffort: item?.effort || null,
      evidenceVariant: item?.evidenceVariant || "full",
    },
    validation,
    validatedStructuredResult: validation?.normalized || rawStructuredResult,
    localExecutionStatus: localStatus || null,
  };
}

function parseLocalRawOutput(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const candidates = [text];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1]) candidates.push(fenced[1]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed)) return parsed;
    } catch {
      // Invalid raw output remains unscorable; this offline adapter never asks
      // a model to repair it.
    }
  }
  return null;
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
    .replace(/[，。；：、！？,.!?;:'"“”‘’「」『』（）()[\]【】《》〈〉·•—–\-_=+]/gu, "");
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
