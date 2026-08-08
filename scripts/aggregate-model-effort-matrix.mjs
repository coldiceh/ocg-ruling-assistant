#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  estimateRelayModelCost,
  getRelayModelPricingConfig,
} from "../backend/modelPricing.mjs";

const SCORE_STATUSES = new Set(["PASS", "FAIL", "INCONCLUSIVE"]);
const EFFORT_ORDER = new Map(
  ["none", "low", "medium", "high", "xhigh", "max"].map((value, index) => [value, index]),
);
const RELAY_PRICING = getRelayModelPricingConfig();
const DEFAULT_RELAY_CREDIT_TO_CNY = 1;

export async function aggregateModelEffortMatrixFiles({
  pairs = [],
  dashboardMetadataFile = "",
  expectedCaseCount,
  strictEvidence = true,
  relayCreditToCny = DEFAULT_RELAY_CREDIT_TO_CNY,
  now = () => new Date(),
  readFileImpl = readFile,
} = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new TypeError("at least one checkpoint/scored pair is required");
  }
  const runs = [];
  for (const [index, pair] of pairs.entries()) {
    if (!pair?.checkpointFile || !pair?.scoredFile) {
      throw new TypeError(`pair ${index + 1} requires checkpointFile and scoredFile`);
    }
    const [checkpointText, scoredText] = await Promise.all([
      readFileImpl(pair.checkpointFile, "utf8"),
      readFileImpl(pair.scoredFile, "utf8"),
    ]);
    runs.push({
      checkpoint: parseJson(checkpointText, `checkpoint ${pair.checkpointFile}`),
      scored: parseJson(scoredText, `scored report ${pair.scoredFile}`),
      checkpointPath: String(pair.checkpointFile),
      scoredPath: String(pair.scoredFile),
    });
  }
  let dashboardMetadata = null;
  if (dashboardMetadataFile) {
    dashboardMetadata = parseJson(
      await readFileImpl(dashboardMetadataFile, "utf8"),
      `dashboard metadata ${dashboardMetadataFile}`,
    );
  }
  return aggregateModelEffortMatrix({
    runs,
    dashboardMetadata,
    expectedCaseCount,
    strictEvidence,
    relayCreditToCny,
    generatedAt: now().toISOString(),
  });
}

export function aggregateModelEffortMatrix({
  runs = [],
  dashboardMetadata = null,
  expectedCaseCount,
  strictEvidence = true,
  relayCreditToCny = DEFAULT_RELAY_CREDIT_TO_CNY,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new TypeError("runs must contain at least one checkpoint/scored pair");
  }
  const normalizedRelayCreditToCny = positiveNumber(relayCreditToCny, "relayCreditToCny");
  const plannedRecords = runs.flatMap((run, runIndex) => normalizeRunPair(
    run,
    runIndex,
    normalizedRelayCreditToCny,
  ));
  const records = dedupeRecords(plannedRecords);
  const configurations = groupRecords(records);
  const evidenceConsistency = inspectEvidenceConsistency({
    runs,
    records,
    configurations,
    expectedCaseCount,
  });
  if (strictEvidence && !evidenceConsistency.valid) {
    const error = new Error(`evidence consistency validation failed: ${evidenceConsistency.errors.join("; ")}`);
    error.code = "evidence_consistency_failed";
    error.details = evidenceConsistency;
    throw error;
  }
  const caseIds = configurations[0]?.plannedCaseIds || [];
  const dashboard = normalizeDashboardMetadata(dashboardMetadata);
  return {
    schemaVersion: 1,
    reportType: "offline_model_effort_matrix",
    generatedAt,
    publishable: evidenceConsistency.valid,
    caseIds,
    evidenceConsistency,
    metricDefinitions: {
      accuracy: "PASS / planned cases",
      availability: "(PASS + FAIL) / planned cases; INCONCLUSIVE is unavailable for scoring",
      cost: "attributable final-ruling model calls only; shared Evidence Snapshot preparation is not duplicated across configurations",
      costPerCorrectAnswer: "complete attributable configuration cost / PASS count; unavailable when cost coverage is incomplete or PASS count is zero",
    },
    pricingAssumptions: {
      relay: {
        status: "estimated_unverified",
        estimateOnly: true,
        relayCreditToCny: normalizedRelayCreditToCny,
        conversionBasis: "user_confirmed_relay_dashboard_credit_to_cny",
        pricingMultiplier: RELAY_PRICING.multiplier,
        pricingVersion: RELAY_PRICING.pricingVersion,
        pricingSourceVerified: false,
        disclaimer: "Relay estimates are unverified; the relay dashboard remains the billing authority.",
      },
    },
    dashboard,
    configurations: configurations.map((group) => summarizeConfiguration(group, caseIds)),
  };
}

export function renderModelEffortMatrixMarkdown(report) {
  if (!report || report.reportType !== "offline_model_effort_matrix") {
    throw new TypeError("report must be an offline_model_effort_matrix report");
  }
  const lines = [
    "# 模型与推理强度实验矩阵",
    "",
    `证据一致性：**${report.evidenceConsistency.valid ? "通过" : "失败"}**。`,
    "",
    "正确率 = PASS 数 / 计划题数；可用率 = (PASS + FAIL) / 计划题数，INCONCLUSIVE 视为不可评分。",
    "费用仅统计可归属的最终裁定模型调用；共享 Evidence Snapshot 的准备费用不重复计入各模型配置。",
  ];
  if (report.evidenceConsistency.errors.length) {
    lines.push("", ...report.evidenceConsistency.errors.map((error) => `- 错误：${escapeMarkdown(error)}`));
  }
  if (report.evidenceConsistency.warnings.length) {
    lines.push("", ...report.evidenceConsistency.warnings.map((warning) => `- 警告：${escapeMarkdown(warning)}`));
  }
  const caseHeaders = report.caseIds.map((caseId) => escapeMarkdown(caseId));
  const headers = [
      "模型",
      "推理强度",
      ...caseHeaders,
      "正确率",
      "可用率",
      "平均 / 中位总耗时",
      "平均 / 中位首正文",
      "输入 Token",
      "输出 Token",
      "推理 Token",
      "总 Token",
      "费用（总计 / 平均每题 / 每答对一题）",
  ];
  lines.push(
    "",
    headers.map((value) => `| ${value} `).join("") + "|",
    headers.map(() => "| --- ").join("") + "|",
  );
  for (const configuration of report.configurations) {
    const caseStatus = new Map(configuration.cases.map((item) => [item.caseId, item.status]));
    lines.push([
      configuration.model,
      configuration.effort,
      ...report.caseIds.map((caseId) => formatCaseStatus(caseStatus.get(caseId))),
      formatRatio(configuration.accuracy),
      formatRatio(configuration.availability),
      formatLatency(configuration.latency.totalMs),
      formatLatency(configuration.latency.firstContentMs),
      formatTokenMetric(configuration.tokens.input),
      formatTokenMetric(configuration.tokens.output),
      formatTokenMetric(configuration.tokens.reasoning),
      formatTokenMetric(configuration.tokens.total),
      formatEstimatedCost(configuration.estimatedCost),
    ].map((value) => `| ${escapeMarkdown(value)} `).join("") + "|");
  }
  if (report.dashboard) {
    lines.push(
      "",
      "## 看板实际批次增量",
      "",
      "以下数值只是批次级观测，不推导、不分摊为单次请求费用。",
      "",
      "| 批次 | 请求数 | 开始值 | 结束值 | 增量 | 单位 | 来源 |",
      "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    );
    for (const batch of report.dashboard.batches) {
      lines.push(`| ${escapeMarkdown(batch.label)} | ${nullable(batch.requestCount)} | ${nullable(batch.before)} | ${nullable(batch.after)} | ${nullable(batch.delta)} | ${escapeMarkdown(batch.unit || "")} | ${escapeMarkdown(batch.source || "")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function normalizeRunPair(run, runIndex, relayCreditToCny) {
  const checkpoint = requiredObject(run?.checkpoint, `run ${runIndex + 1} checkpoint`);
  const scored = requiredObject(run?.scored, `run ${runIndex + 1} scored report`);
  if (!Array.isArray(checkpoint.results)) {
    throw new TypeError(`run ${runIndex + 1} checkpoint.results must be an array`);
  }
  if (!Array.isArray(scored.results)) {
    throw new TypeError(`run ${runIndex + 1} scored.results must be an array`);
  }
  if (checkpoint.status && checkpoint.status !== "completed") {
    throw new Error(`run ${runIndex + 1} checkpoint is not completed (${checkpoint.status})`);
  }
  const plans = Array.isArray(checkpoint.plan) && checkpoint.plan.length
    ? checkpoint.plan
    : checkpoint.results.map((result) => ({
        key: result.key,
        caseId: result.caseId,
        model: result.model,
        effort: result.effort,
        evidenceVariant: result.evidenceVariant,
      }));
  const resultByKey = new Map();
  for (const result of checkpoint.results) {
    const identity = recordIdentity({
      caseId: result.caseId,
      model: result.model || checkpoint.model,
      effort: result.effort,
      evidenceVariant: result.evidenceVariant || checkpoint.evidenceVariant || "full",
    });
    for (const key of [result.key, identity].filter(Boolean)) {
      if (resultByKey.has(key)) throw new Error(`duplicate checkpoint result: ${key}`);
      resultByKey.set(key, result);
    }
  }
  const scoreByIdentity = new Map();
  for (const score of scored.results) {
    const status = String(score.status || "").toUpperCase();
    if (!SCORE_STATUSES.has(status)) throw new Error(`unsupported scored status: ${score.status}`);
    const identity = recordIdentity({
      caseId: score.caseId,
      model: score.requestedModel || score.model,
      effort: score.reasoningEffort || score.effort,
      evidenceVariant: score.evidenceVariant || checkpoint.evidenceVariant || "full",
    });
    if (scoreByIdentity.has(identity)) throw new Error(`duplicate scored result: ${identity}`);
    scoreByIdentity.set(identity, { ...score, status });
  }
  return plans.map((plan) => {
    const descriptor = {
      caseId: requiredText(plan.caseId, "plan.caseId"),
      model: requiredText(plan.model || checkpoint.model, "plan model"),
      effort: requiredText(plan.effort, "plan effort").toLowerCase(),
      evidenceVariant: String(plan.evidenceVariant || checkpoint.evidenceVariant || "full"),
    };
    const identity = recordIdentity(descriptor);
    const result = resultByKey.get(plan.key) || resultByKey.get(identity) || null;
    const score = scoreByIdentity.get(identity) || null;
    return {
      ...descriptor,
      identity,
      runIndex,
      checkpointPath: run.checkpointPath || null,
      scoredPath: run.scoredPath || null,
      bundleSha256: optionalText(checkpoint.bundleSha256),
      snapshotSha256: optionalText(result?.snapshotSha256),
      finalInputSha256: optionalText(result?.finalInputSha256),
      rawStatus: result?.status || "missing_result",
      scoreStatus: score?.status || "INCONCLUSIVE",
      scoreReason: score?.reason || null,
      returnedModel: score?.returnedModel || result?.reportedModel || result?.returnedModel || null,
      durationMs: firstFinite(result?.durationMs, result?.sseTiming?.requestToCompleteMs),
      firstContentMs: firstFinite(
        result?.sseTiming?.requestToFirstContentMs,
        result?.streamMetrics?.requestToFirstContentMs,
      ),
      usage: extractUsage(result),
      estimatedCosts: extractEstimatedCosts(result, descriptor.model, relayCreditToCny),
    };
  });
}

function dedupeRecords(records) {
  const byIdentity = new Map();
  for (const record of records) {
    const existing = byIdentity.get(record.identity);
    if (!existing) {
      byIdentity.set(record.identity, record);
      continue;
    }
    const comparableKeys = [
      "bundleSha256", "snapshotSha256", "finalInputSha256", "rawStatus", "scoreStatus",
      "durationMs", "firstContentMs",
    ];
    if (comparableKeys.some((key) => existing[key] !== record[key])
      || JSON.stringify(existing.usage) !== JSON.stringify(record.usage)
      || JSON.stringify(existing.estimatedCosts) !== JSON.stringify(record.estimatedCosts)) {
      throw new Error(`conflicting duplicate experiment record: ${record.identity}`);
    }
  }
  return [...byIdentity.values()];
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.model}::${record.effort}::${record.evidenceVariant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    model: items[0].model,
    effort: items[0].effort,
    evidenceVariant: items[0].evidenceVariant,
    plannedCaseIds: items.map((item) => item.caseId),
    records: items,
  })).sort(compareConfigurations);
}

function inspectEvidenceConsistency({ runs, records, configurations, expectedCaseCount }) {
  const errors = [];
  const warnings = [];
  const bundleHashes = unique(runs.map((run) => optionalText(run.checkpoint?.bundleSha256)).filter(Boolean));
  if (bundleHashes.length > 1) errors.push(`bundleSha256 mismatch: ${bundleHashes.join(", ")}`);
  if (bundleHashes.length === 0) warnings.push("bundleSha256 was unavailable for every checkpoint");
  if (bundleHashes.length === 1 && runs.some((run) => !optionalText(run.checkpoint?.bundleSha256))) {
    warnings.push("bundleSha256 was unavailable for one or more checkpoints");
  }
  const referenceCaseIds = configurations[0]?.plannedCaseIds || [];
  if (expectedCaseCount !== undefined) {
    const expected = Number(expectedCaseCount);
    if (!Number.isInteger(expected) || expected < 1) throw new TypeError("expectedCaseCount must be a positive integer");
    if (referenceCaseIds.length !== expected) {
      errors.push(`expected ${expected} planned cases, found ${referenceCaseIds.length}`);
    }
  }
  const referenceCaseKey = sortedSetKey(referenceCaseIds);
  for (const configuration of configurations) {
    if (new Set(configuration.plannedCaseIds).size !== configuration.plannedCaseIds.length) {
      errors.push(`${configuration.key} contains duplicate planned cases`);
    }
    if (sortedSetKey(configuration.plannedCaseIds) !== referenceCaseKey) {
      errors.push(`${configuration.key} does not use the same planned case set`);
    }
  }
  const finalInputSha256ByCase = {};
  for (const caseId of referenceCaseIds) {
    const caseRecords = records.filter((record) => record.caseId === caseId);
    const hashes = unique(caseRecords.map((record) => record.finalInputSha256).filter(Boolean));
    finalInputSha256ByCase[caseId] = hashes;
    if (hashes.length > 1) errors.push(`${caseId} finalInputSha256 mismatch: ${hashes.join(", ")}`);
    if (hashes.length === 0) warnings.push(`${caseId} finalInputSha256 was unavailable`);
    else if (caseRecords.some((record) => !record.finalInputSha256)) {
      warnings.push(`${caseId} finalInputSha256 was unavailable for one or more planned records`);
    }
  }
  return {
    valid: errors.length === 0,
    checkedRunCount: runs.length,
    checkedConfigurationCount: configurations.length,
    expectedCaseCount: expectedCaseCount === undefined ? null : Number(expectedCaseCount),
    bundleSha256: bundleHashes.length === 1 ? bundleHashes[0] : null,
    observedBundleSha256: bundleHashes,
    finalInputSha256ByCase,
    errors,
    warnings,
  };
}

function summarizeConfiguration(group, caseIds) {
  const byCase = new Map(group.records.map((record) => [record.caseId, record]));
  const cases = caseIds.map((caseId) => {
    const record = byCase.get(caseId);
    if (!record) return { caseId, status: "INCONCLUSIVE", rawStatus: "not_planned" };
    return {
      caseId,
      status: record.scoreStatus,
      rawStatus: record.rawStatus,
      returnedModel: record.returnedModel,
      durationMs: record.durationMs,
      firstContentMs: record.firstContentMs,
      usage: record.usage,
      estimatedCost: record.estimatedCosts.length ? record.estimatedCosts : null,
    };
  });
  const counts = Object.fromEntries([...SCORE_STATUSES].map((status) => [
    status,
    cases.filter((item) => item.status === status).length,
  ]));
  const planned = cases.length;
  const scorable = counts.PASS + counts.FAIL;
  return {
    configurationKey: group.key,
    model: group.model,
    effort: group.effort,
    evidenceVariant: group.evidenceVariant,
    plannedCaseIds: [...caseIds],
    cases,
    counts,
    accuracy: ratio(counts.PASS, planned),
    availability: ratio(scorable, planned),
    latency: {
      totalMs: numericSummary(cases.map((item) => item.durationMs)),
      firstContentMs: numericSummary(cases.map((item) => item.firstContentMs)),
    },
    tokens: {
      input: numericSummary(cases.map((item) => item.usage?.inputTokens), { includeSum: true }),
      output: numericSummary(cases.map((item) => item.usage?.outputTokens), { includeSum: true }),
      reasoning: numericSummary(cases.map((item) => item.usage?.reasoningTokens), { includeSum: true }),
      total: numericSummary(cases.map((item) => item.usage?.totalTokens), { includeSum: true }),
    },
    estimatedCost: summarizeEstimatedCosts(cases, planned),
  };
}

function extractUsage(result) {
  if (!result) return null;
  const usage = result.usage || result.metering?.usage || result.metering?.totals?.usage || {};
  const inputTokens = firstFinite(usage.inputTokens, usage.prompt_tokens, usage.promptTokens);
  const outputTokens = firstFinite(usage.outputTokens, usage.completion_tokens, usage.completionTokens);
  const reasoningTokens = firstFinite(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );
  const explicitTotal = firstFinite(usage.totalTokens, usage.total_tokens);
  const totalTokens = explicitTotal ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  if ([inputTokens, outputTokens, reasoningTokens, totalTokens].every((value) => value === null)) return null;
  return { inputTokens, outputTokens, reasoningTokens, totalTokens };
}

function extractEstimatedCosts(result, model, relayCreditToCny) {
  if (!result) return [];
  if (/^relay-gpt-5\.6-(?:sol|terra|luna)$/u.test(String(model || ""))) {
    const estimate = estimateRelayModelCost({
      model,
      usage: result.usage,
      usdToCnyRate: relayCreditToCny,
      exchangeRateVersion: "user-confirmed-relay-credit-to-cny",
      pricing: RELAY_PRICING,
      pricingMultiplier: RELAY_PRICING.multiplier,
    });
    if (Number.isFinite(estimate.totalCostCny)) {
      return [{
        currency: "CNY",
        amount: estimate.totalCostCny,
        source: "estimateRelayModelCost",
        verification: "unverified",
        estimateOnly: true,
        pricingVersion: estimate.pricingVersion,
        pricingMultiplier: estimate.pricingMultiplier,
        relayCreditAmount: estimate.totalCostUsd,
        relayCreditToCny,
      }];
    }
  }
  const candidates = [];
  addCost(candidates, "CNY", result.estimatedCostCny, "estimatedCostCny");
  addCost(candidates, "USD", result.estimatedCostUsd, "estimatedCostUsd");
  const objects = [
    [result.estimatedCost, "estimatedCost"],
    [result.costEstimate, "costEstimate"],
    [result.metering?.estimatedCost, "metering.estimatedCost"],
    [result.metering?.totals?.estimatedCost, "metering.totals.estimatedCost"],
  ];
  for (const [value, source] of objects) {
    if (Number.isFinite(Number(value?.amount)) && optionalText(value?.currency)) {
      addCost(candidates, String(value.currency).toUpperCase(), value.amount, `${source}.amount`);
    }
    addCost(candidates, "CNY", value?.totalCostCny ?? value?.cny, `${source}.totalCostCny`);
    addCost(candidates, "USD", value?.totalCostUsd ?? value?.usd, `${source}.totalCostUsd`);
  }
  const byCurrency = new Map();
  for (const candidate of candidates) {
    if (!byCurrency.has(candidate.currency)) byCurrency.set(candidate.currency, candidate);
  }
  return [...byCurrency.values()];
}

function addCost(target, currency, amount, source) {
  if (amount === null || amount === undefined || amount === "") return;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) return;
  target.push({
    currency,
    amount: numeric,
    source,
    verification: "raw_record",
    estimateOnly: true,
  });
}

function summarizeEstimatedCosts(cases, planned) {
  const entries = cases.flatMap((item) => item.estimatedCost || []);
  if (entries.length === 0) return null;
  const caseCount = cases.filter((item) => item.estimatedCost?.length).length;
  const correctCount = cases.filter((item) => item.status === "PASS").length;
  const totals = {};
  const sourceFields = new Set();
  const verification = new Set();
  const pricingVersions = new Set();
  let relayCreditTotal = 0;
  let relayCreditReported = false;
  for (const entry of entries) {
    totals[entry.currency] = round((totals[entry.currency] || 0) + entry.amount, 9);
    sourceFields.add(entry.source);
    if (entry.verification) verification.add(entry.verification);
    if (entry.pricingVersion) pricingVersions.add(entry.pricingVersion);
    if (Number.isFinite(entry.relayCreditAmount)) {
      relayCreditTotal = round(relayCreditTotal + entry.relayCreditAmount, 9);
      relayCreditReported = true;
    }
  }
  return {
    reportedCaseCount: caseCount,
    plannedCaseCount: planned,
    complete: caseCount === planned,
    totals,
    averagesPerReportedCase: Object.fromEntries(
      Object.entries(totals).map(([currency, amount]) => [currency, round(amount / caseCount, 9)]),
    ),
    costsPerCorrectAnswer: caseCount === planned && correctCount > 0
      ? Object.fromEntries(
          Object.entries(totals).map(([currency, amount]) => [currency, round(amount / correctCount, 9)]),
        )
      : null,
    sourceFields: [...sourceFields].sort(),
    verification: [...verification].sort(),
    pricingVersions: [...pricingVersions].sort(),
    relayCreditTotal: relayCreditReported ? relayCreditTotal : null,
  };
}

function normalizeDashboardMetadata(value) {
  if (value === null || value === undefined) return null;
  const rawBatches = Array.isArray(value) ? value : value.batches;
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) {
    throw new TypeError("dashboard metadata must be a non-empty array or contain batches[]");
  }
  const batches = rawBatches.map((batch, index) => {
    const item = requiredObject(batch, `dashboard batch ${index + 1}`);
    const requestCount = item.requestCount === null || item.requestCount === undefined
      ? null
      : Number(item.requestCount);
    if (requestCount !== null && (!Number.isInteger(requestCount) || requestCount < 0)) {
      throw new TypeError(`dashboard batch ${index + 1} requestCount must be a non-negative integer`);
    }
    return {
      label: requiredText(item.label, `dashboard batch ${index + 1} label`),
      requestCount,
      before: finiteOrNull(item.before),
      after: finiteOrNull(item.after),
      delta: finiteOrNull(item.delta),
      unit: optionalText(item.unit),
      source: optionalText(item.source),
      note: optionalText(item.note),
      perRequestAllocation: null,
    };
  });
  return {
    attributionScope: "batch_only",
    perRequestAllocation: null,
    disclaimer: "Dashboard deltas are batch observations and are not allocated to individual requests.",
    batches,
  };
}

function numericSummary(values, { includeSum = false } = {}) {
  const usable = values.filter((value) => Number.isFinite(value)).map(Number).sort((a, b) => a - b);
  const result = {
    reportedCount: usable.length,
    average: usable.length ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length) : null,
    median: usable.length ? round(median(usable)) : null,
  };
  if (includeSum) result.sum = usable.length ? round(usable.reduce((sum, value) => sum + value, 0)) : null;
  return result;
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(numerator, denominator) {
  return { numerator, denominator, rate: denominator ? round(numerator / denominator) : null };
}

function recordIdentity({ caseId, model, effort, evidenceVariant }) {
  return [caseId, model, effort, evidenceVariant || "full"].map((value) => String(value || "")).join("::");
}

function compareConfigurations(left, right) {
  const model = left.model.localeCompare(right.model, "en");
  if (model) return model;
  const leftEffort = EFFORT_ORDER.get(left.effort) ?? Number.MAX_SAFE_INTEGER;
  const rightEffort = EFFORT_ORDER.get(right.effort) ?? Number.MAX_SAFE_INTEGER;
  if (leftEffort !== rightEffort) return leftEffort - rightEffort;
  return left.effort.localeCompare(right.effort, "en");
}

function formatRatio(value) {
  return `${value.numerator}/${value.denominator} (${value.rate === null ? "n/a" : `${round(value.rate * 100, 1).toFixed(1)}%`})`;
}

function formatCaseStatus(value) {
  return ({
    PASS: "正确",
    FAIL: "错误",
    INCONCLUSIVE: "不确定",
  })[value] || "不确定";
}

function formatLatency(value) {
  if (value.average === null) return "—";
  return `${round(value.average / 1000, 1).toFixed(1)} / ${round(value.median / 1000, 1).toFixed(1)} s`;
}

function formatTokenMetric(value) {
  return value.sum === null ? "—" : `${formatInteger(value.sum)} (${value.reportedCount})`;
}

function formatEstimatedCost(value) {
  if (!value) return "—";
  const totals = Object.entries(value.totals).map(([currency, amount]) => {
    const average = value.averagesPerReportedCase?.[currency];
    const perCorrect = value.costsPerCorrectAnswer?.[currency];
    return `${currency} ${round(amount, 6)} / ${round(average, 6)} / ${perCorrect === undefined ? "—" : round(perCorrect, 6)}`;
  });
  const verification = value.verification.includes("unverified") ? "未验证；" : "";
  return `${totals.join(" + ")} (${verification}${value.reportedCaseCount}/${value.plannedCaseCount})`;
}

function formatInteger(value) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function nullable(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`expected a finite number, received ${value}`);
  return numeric;
}

function positiveNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new TypeError(`${label} must be a positive number`);
  return numeric;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function optionalText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function unique(values) {
  return [...new Set(values)];
}

function sortedSetKey(values) {
  return [...new Set(values)].sort().join("\u0000");
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(String(serialized));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error?.message || error}`);
  }
}

export function parseModelEffortMatrixArguments(argv) {
  const options = {
    pairs: [],
    checkpoints: [],
    scored: [],
    strictEvidence: true,
    relayCreditToCny: DEFAULT_RELAY_CREDIT_TO_CNY,
  };
  const take = (argument, index) => {
    if (index + 1 >= argv.length) throw new TypeError(`${argument} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pair") {
      if (index + 2 >= argv.length) throw new TypeError("--pair requires CHECKPOINT and SCORED values");
      options.pairs.push({ checkpointFile: argv[index + 1], scoredFile: argv[index + 2] });
      index += 2;
    } else if (argument === "--checkpoint") {
      options.checkpoints.push(take(argument, index));
      index += 1;
    } else if (argument === "--scored") {
      options.scored.push(take(argument, index));
      index += 1;
    } else if (argument === "--dashboard-metadata") {
      options.dashboardMetadataFile = take(argument, index);
      index += 1;
    } else if (argument === "--expected-case-count") {
      options.expectedCaseCount = Number(take(argument, index));
      index += 1;
    } else if (argument === "--relay-credit-to-cny") {
      options.relayCreditToCny = Number(take(argument, index));
      index += 1;
    } else if (argument === "--json-out") {
      options.jsonOut = take(argument, index);
      index += 1;
    } else if (argument === "--markdown-out") {
      options.markdownOut = take(argument, index);
      index += 1;
    } else if (argument === "--allow-evidence-mismatch") {
      options.strictEvidence = false;
    } else if (argument === "--compact") {
      options.compact = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (options.checkpoints.length !== options.scored.length) {
    throw new TypeError("--checkpoint and --scored counts must match");
  }
  options.pairs.push(...options.checkpoints.map((checkpointFile, index) => ({
    checkpointFile,
    scoredFile: options.scored[index],
  })));
  delete options.checkpoints;
  delete options.scored;
  return options;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseModelEffortMatrixArguments(argv);
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write([
      "Usage: node scripts/aggregate-model-effort-matrix.mjs --pair CHECKPOINT.json SCORED.json [--pair ...]",
      "  [--expected-case-count 4] [--dashboard-metadata DASHBOARD.json]",
      "  [--relay-credit-to-cny 1]",
      "  [--json-out MATRIX.json] [--markdown-out MATRIX.md] [--allow-evidence-mismatch] [--compact]",
      "",
    ].join("\n"));
    return 0;
  }
  const report = await aggregateModelEffortMatrixFiles({
    pairs: options.pairs,
    dashboardMetadataFile: options.dashboardMetadataFile,
    expectedCaseCount: options.expectedCaseCount,
    strictEvidence: options.strictEvidence,
    relayCreditToCny: options.relayCreditToCny,
    readFileImpl: dependencies.readFileImpl,
    now: dependencies.now,
  });
  const markdown = renderModelEffortMatrixMarkdown(report);
  const writeFileImpl = dependencies.writeFileImpl || writeFile;
  if (options.jsonOut) {
    await writeFileImpl(resolve(options.jsonOut), `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`, "utf8");
  }
  if (options.markdownOut) await writeFileImpl(resolve(options.markdownOut), markdown, "utf8");
  if (!options.jsonOut && !options.markdownOut) stdout.write(markdown);
  return 0;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
