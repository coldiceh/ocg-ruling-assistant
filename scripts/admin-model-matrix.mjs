import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { parseEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  DEFAULT_ADMIN_EVIDENCE_VARIANT,
  normalizeAdminEvidenceVariant,
} from "../backend/adminEvidenceVariant.mjs";
import {
  estimateRelayModelCost,
  getRelayModelPricingConfig,
} from "../backend/modelPricing.mjs";

const TERMINAL_STATUSES = new Set(["CANCELLED", "SUCCEEDED", "FAILED"]);
const DEFAULT_MAX_FINAL_REQUESTS = 12;
const DEFAULT_MAX_ESTIMATED_COST_CNY = 10;
const DEFAULT_ESTIMATED_INPUT_TOKENS_PER_FINAL_REQUEST = 32_000;
const DEFAULT_ESTIMATED_OUTPUT_TOKENS_PER_FINAL_REQUEST = 8_192;
// This is a deliberately configurable budget-conversion factor, not a claim
// about a live foreign-exchange quote.
const DEFAULT_BUDGET_USD_TO_CNY = 7.5;
const RELAY_SCREENSHOT_PRICING = getRelayModelPricingConfig();

export const EVIDENCE_PREPARATION_CONFIGURATION = Object.freeze({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  reasoningMode: "standard",
  reasoningEffort: "none",
});

export const SOURCE_CONFIGURATION = Object.freeze({
  provider: "relay",
  model: "relay-gpt-5.6-sol",
  reasoningMode: "pro",
  reasoningEffort: "high",
  evidenceVariant: DEFAULT_ADMIN_EVIDENCE_VARIANT,
});

export const DEFAULT_MATRIX_CONFIGURATIONS = Object.freeze([
  SOURCE_CONFIGURATION,
  Object.freeze({
    provider: "relay",
    model: "relay-gpt-5.6-terra",
    reasoningMode: "pro",
    reasoningEffort: "high",
    evidenceVariant: DEFAULT_ADMIN_EVIDENCE_VARIANT,
  }),
  Object.freeze({
    provider: "relay",
    model: "relay-gpt-5.6-luna",
    reasoningMode: "pro",
    reasoningEffort: "high",
    evidenceVariant: DEFAULT_ADMIN_EVIDENCE_VARIANT,
  }),
]);

// Explicit opt-in pilot requested for the four real ruling cases. Keep this
// separate from the cheaper 12-request default: four cases across these five
// models are 20 paid final-ruling submissions before unavailable models are
// skipped by the server capability preflight.
export const FIVE_MODEL_PILOT_CONFIGURATIONS = Object.freeze([
  ...DEFAULT_MATRIX_CONFIGURATIONS,
  Object.freeze({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "pro",
    reasoningEffort: "high",
    evidenceVariant: DEFAULT_ADMIN_EVIDENCE_VARIANT,
  }),
  Object.freeze({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningMode: "pro",
    reasoningEffort: "max",
    evidenceVariant: DEFAULT_ADMIN_EVIDENCE_VARIANT,
  }),
]);

/**
 * Runs one evidence-preparation source, then evaluates final models against
 * frozen evidence through the admin lab fork contract.
 */
export async function runAdminModelMatrix({
  baseUrl,
  origin,
  password,
  question,
  sourceRunId: requestedSourceRunId,
  sourceConfiguration: requestedSourceConfiguration,
  configurations = DEFAULT_MATRIX_CONFIGURATIONS,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 1_500,
  runTimeoutMs = 10 * 60_000,
  concurrency = 1,
  maxConcurrency = 1,
  maxFinalRequests = DEFAULT_MAX_FINAL_REQUESTS,
  maxEstimatedCostCny = DEFAULT_MAX_ESTIMATED_COST_CNY,
  estimatedCnyPerFinalRequest,
  estimatedInputTokensPerFinalRequest = DEFAULT_ESTIMATED_INPUT_TOKENS_PER_FINAL_REQUEST,
  estimatedOutputTokensPerFinalRequest = DEFAULT_ESTIMATED_OUTPUT_TOKENS_PER_FINAL_REQUEST,
  budgetUsdToCny = DEFAULT_BUDGET_USD_TO_CNY,
  now = () => new Date(),
  sleep = defaultSleep,
} = {}) {
  const normalizedQuestion = requiredText(question, "question");
  const normalizedConfigurations = dedupeConfigurations(configurations);
  if (normalizedConfigurations.length === 0) throw new Error("at least one model configuration is required");
  const sourceConfiguration = normalizeConfiguration(
    requestedSourceConfiguration || normalizedConfigurations[0],
  );
  if (!normalizedConfigurations.some((item) => (
    configurationKey(item) === configurationKey(sourceConfiguration)
  ))) {
    throw new Error("sourceConfiguration must be included in configurations");
  }
  const safeConcurrency = positiveInteger(concurrency, "concurrency");
  const safeMaxConcurrency = positiveInteger(maxConcurrency, "maxConcurrency");
  if (safeConcurrency > safeMaxConcurrency) {
    throw new Error(`concurrency ${safeConcurrency} exceeds the hard limit ${safeMaxConcurrency}`);
  }
  const startedAt = now();
  const client = createAdminModelLabHttpClient({
    baseUrl,
    origin,
    password,
    fetchImpl,
  });

  await client.login();
  const capabilities = await client.capabilities();
  assertRequiredFeatures(capabilities);
  assertPersistentFinalCallBudget(capabilities);
  const availableModels = collectAvailableModels(capabilities);
  const preparationAvailability = validateConfiguration(
    EVIDENCE_PREPARATION_CONFIGURATION,
    availableModels,
  );
  if (!preparationAvailability.ok) {
    throw new Error(
      `Evidence preparation configuration is unavailable: ${preparationAvailability.reason}`,
    );
  }
  const sourceAvailability = validateConfiguration(sourceConfiguration, availableModels);
  if (!sourceAvailability.ok) {
    throw new Error(`Source configuration is unavailable: ${sourceAvailability.reason}`);
  }

  const sourceKey = configurationKey(sourceConfiguration);
  const availableConfigurations = normalizedConfigurations.filter(
    (configuration) => validateConfiguration(configuration, availableModels).ok,
  );
  const plannedFinalRequests = availableConfigurations.filter((configuration) => (
    !requestedSourceRunId || configurationKey(configuration) !== sourceKey
  )).length;
  const requestLimit = positiveInteger(maxFinalRequests, "maxFinalRequests");
  if (plannedFinalRequests > requestLimit) {
    throw new Error(`planned final requests ${plannedFinalRequests} exceed the hard limit ${requestLimit}`);
  }
  const costLimit = nonNegativeNumber(maxEstimatedCostCny, "maxEstimatedCostCny");
  const plannedCost = estimatePlannedFinalCost({
    configurations: availableConfigurations.filter((configuration) => (
      !requestedSourceRunId || configurationKey(configuration) !== sourceKey
    )),
    estimatedCnyPerFinalRequest,
    estimatedInputTokensPerFinalRequest,
    estimatedOutputTokensPerFinalRequest,
    budgetUsdToCny,
  });
  const plannedEstimatedCostCny = plannedCost.totalCny;
  if (plannedEstimatedCostCny > costLimit) {
    throw new Error(
      `planned estimated cost CNY ${plannedEstimatedCostCny} exceeds the hard limit ${costLimit}`,
    );
  }

  let sourceRunId = optionalText(requestedSourceRunId);
  let sourceRun;
  let sourceAudit = { events: [], error: null };
  if (sourceRunId) {
    sourceRun = extractRun(await client.getRun(sourceRunId));
    if (!sourceRun || !TERMINAL_STATUSES.has(normalizeStatus(sourceRun.status))) {
      throw new Error(`Source run ${sourceRunId} is missing or not terminal`);
    }
    sourceAudit = await readRunAudit(client, sourceRunId);
    validateReusableSourceRun({
      run: sourceRun,
      events: sourceAudit.events,
      question: normalizedQuestion,
      sourceConfiguration,
      availableModels,
    });
  } else {
    const sourceCreated = await client.createRun({
      question: normalizedQuestion,
      preparationProvider: EVIDENCE_PREPARATION_CONFIGURATION.provider,
      preparationModel: EVIDENCE_PREPARATION_CONFIGURATION.model,
      preparationReasoningMode: EVIDENCE_PREPARATION_CONFIGURATION.reasoningMode,
      preparationReasoningEffort: EVIDENCE_PREPARATION_CONFIGURATION.reasoningEffort,
      ...sourceConfiguration,
      finalAttemptPolicy: "single",
    });
    sourceRunId = extractRunId(sourceCreated);
    if (!sourceRunId) throw new Error("Admin lab create did not return a runId");
    sourceRun = await executeAndWait({
      client,
      runId: sourceRunId,
      pollIntervalMs,
      runTimeoutMs,
      sleep,
    });
    sourceAudit = await readRunAudit(client, sourceRunId);
  }
  const sourceResult = summarizeRun({
    role: "source",
    configuration: sourceConfiguration,
    run: sourceRun,
    events: sourceAudit.events,
    auditReadError: sourceAudit.error,
  });

  const forkConfigurations = normalizedConfigurations.filter((configuration) => (
    configurationKey(configuration) !== sourceKey
  ));
  const forkResults = await mapLimit(forkConfigurations, safeConcurrency, async (configuration, index) => {
    const availability = validateConfiguration(configuration, availableModels);
    if (!availability.ok) {
      return summarizeSkipped(configuration, availability.reason);
    }
    try {
      const forked = await client.forkRun({
        forkFromRunId: sourceRunId,
        idempotencyKey: `matrix-${randomUUID()}-${index}`,
        label: `matrix:${configurationKey(configuration)}`,
        ...configuration,
      });
      const runId = extractRunId(forked);
      if (!runId) throw new Error("Admin lab fork did not return a runId");
      const run = await executeAndWait({
        client,
        runId,
        pollIntervalMs,
        runTimeoutMs,
        sleep,
      });
      const audit = await readRunAudit(client, runId);
      return summarizeRun({
        role: "fork",
        configuration,
        run,
        events: audit.events,
        auditReadError: audit.error,
      });
    } catch (error) {
      return summarizeFailure(configuration, error);
    }
  });

  const endedAt = now();
  return {
    schemaVersion: 1,
    question: normalizedQuestion,
    sourceRunId,
    sourceEvidenceVariant: sourceConfiguration.evidenceVariant,
    evidenceVariants: [...new Set(normalizedConfigurations.map(
      (configuration) => configuration.evidenceVariant,
    ))],
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    guard: {
      finalAttemptPolicy: "single",
      concurrency: safeConcurrency,
      maxConcurrency: safeMaxConcurrency,
      plannedFinalRequests,
      maxFinalRequests: requestLimit,
      ...plannedCost.guard,
      plannedEstimatedCostCny,
      maxEstimatedCostCny: costLimit,
    },
    availableModels: [...availableModels.values()].map((entry) => ({
      provider: entry.provider,
      model: entry.model,
    })),
    results: [sourceResult, ...forkResults],
  };
}

/**
 * Runs several questions sequentially under one preflight request/cost guard.
 * This is the paid pilot boundary: it never retries a case and delegates each
 * question to the single-attempt frozen-evidence matrix above.
 */
export async function runAdminModelMatrixBatch({
  questions,
  configurations = DEFAULT_MATRIX_CONFIGURATIONS,
  maxFinalRequests = DEFAULT_MAX_FINAL_REQUESTS,
  maxEstimatedCostCny = DEFAULT_MAX_ESTIMATED_COST_CNY,
  estimatedCnyPerFinalRequest,
  estimatedInputTokensPerFinalRequest = DEFAULT_ESTIMATED_INPUT_TOKENS_PER_FINAL_REQUEST,
  estimatedOutputTokensPerFinalRequest = DEFAULT_ESTIMATED_OUTPUT_TOKENS_PER_FINAL_REQUEST,
  budgetUsdToCny = DEFAULT_BUDGET_USD_TO_CNY,
  concurrency = 1,
  now = () => new Date(),
  ...options
} = {}) {
  const cases = normalizeQuestionCases(questions);
  const normalizedConfigurations = dedupeConfigurations(configurations);
  if (normalizedConfigurations.length === 0) throw new Error("at least one model configuration is required");
  const requestLimit = positiveInteger(maxFinalRequests, "maxFinalRequests");
  const plannedFinalRequests = cases.length * normalizedConfigurations.length;
  if (plannedFinalRequests > requestLimit) {
    throw new Error(`planned final requests ${plannedFinalRequests} exceed the hard limit ${requestLimit}`);
  }
  const costLimit = nonNegativeNumber(maxEstimatedCostCny, "maxEstimatedCostCny");
  const plannedCost = estimatePlannedFinalCost({
    configurations: normalizedConfigurations,
    repetitions: cases.length,
    estimatedCnyPerFinalRequest,
    estimatedInputTokensPerFinalRequest,
    estimatedOutputTokensPerFinalRequest,
    budgetUsdToCny,
  });
  const plannedEstimatedCostCny = plannedCost.totalCny;
  if (plannedEstimatedCostCny > costLimit) {
    throw new Error(
      `planned estimated cost CNY ${plannedEstimatedCostCny} exceeds the hard limit ${costLimit}`,
    );
  }
  if (positiveInteger(concurrency, "concurrency") !== 1) {
    throw new Error("paid matrix batch requires concurrency 1");
  }

  const startedAt = now();
  const reports = [];
  for (const item of cases) {
    const report = await runAdminModelMatrix({
      ...options,
      question: item.question,
      configurations: normalizedConfigurations,
      concurrency: 1,
      maxConcurrency: 1,
      maxFinalRequests: normalizedConfigurations.length,
      maxEstimatedCostCny: costLimit,
      estimatedCnyPerFinalRequest,
      estimatedInputTokensPerFinalRequest,
      estimatedOutputTokensPerFinalRequest,
      budgetUsdToCny,
      now,
    });
    reports.push({ caseId: item.caseId, ...report });
  }
  const endedAt = now();
  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    guard: {
      finalAttemptPolicy: "single",
      concurrency: 1,
      plannedFinalRequests,
      maxFinalRequests: requestLimit,
      ...plannedCost.guard,
      plannedEstimatedCostCny,
      maxEstimatedCostCny: costLimit,
    },
    reports,
  };
}

function estimatePlannedFinalCost({
  configurations,
  repetitions = 1,
  estimatedCnyPerFinalRequest,
  estimatedInputTokensPerFinalRequest,
  estimatedOutputTokensPerFinalRequest,
  budgetUsdToCny,
} = {}) {
  const count = positiveInteger(repetitions, "repetitions");
  const values = Array.isArray(configurations) ? configurations : [];
  const hasUniformOverride = estimatedCnyPerFinalRequest !== undefined
    && estimatedCnyPerFinalRequest !== null
    && estimatedCnyPerFinalRequest !== "";
  if (hasUniformOverride) {
    const uniformCny = nonNegativeNumber(
      estimatedCnyPerFinalRequest,
      "estimatedCnyPerFinalRequest",
    );
    const estimates = values.map((configuration) => ({
      model: configuration.model,
      requests: count,
      estimatedCnyPerRequest: uniformCny,
      estimatedSubtotalCny: roundMoney(uniformCny * count),
    }));
    return {
      totalCny: roundMoney(uniformCny * values.length * count),
      guard: {
        costEstimateMode: "explicit_uniform_override",
        estimatedCnyPerFinalRequest: uniformCny,
        requestEstimates: estimates,
      },
    };
  }

  const inputTokens = nonNegativeInteger(
    estimatedInputTokensPerFinalRequest,
    "estimatedInputTokensPerFinalRequest",
  );
  const outputTokens = nonNegativeInteger(
    estimatedOutputTokensPerFinalRequest,
    "estimatedOutputTokensPerFinalRequest",
  );
  const exchange = positiveNumber(budgetUsdToCny, "budgetUsdToCny");
  const estimates = values.map((configuration) => {
    const canonicalModel = configuration.model.replace(/^relay-/u, "");
    const rates = RELAY_SCREENSHOT_PRICING.models[canonicalModel];
    if (!rates) {
      throw new Error(
        `No default pilot pricing for ${configuration.model}; provide --estimated-cny-per-request explicitly`,
      );
    }
    const cost = estimateRelayModelCost({
      model: configuration.model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      usdToCnyRate: exchange,
      exchangeRateVersion: "matrix-budget-factor-v1",
    });
    if (!Number.isFinite(cost.totalCostCny)) {
      throw new Error(`Default pilot pricing could not estimate ${configuration.model}`);
    }
    const estimatedUsdPerRequest = cost.totalCostUsd;
    const estimatedCnyPerRequest = cost.totalCostCny;
    return {
      model: configuration.model,
      requests: count,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      inputUsdPerMillionTokens: rates.inputUsdPerMillion,
      cachedInputUsdPerMillionTokens: rates.cachedInputUsdPerMillion,
      outputUsdPerMillionTokens: rates.outputUsdPerMillion,
      pricingMultiplier: cost.pricingMultiplier,
      estimatedUsdPerRequest,
      estimatedCnyPerRequest,
      estimatedSubtotalCny: roundMoney(estimatedCnyPerRequest * count),
    };
  });
  return {
    totalCny: roundMoney(estimates.reduce((sum, item) => sum + item.estimatedSubtotalCny, 0)),
    guard: {
      costEstimateMode: "relay_screenshot_token_envelope",
      estimatedCnyPerFinalRequest: null,
      pricingSource: RELAY_SCREENSHOT_PRICING.pricingVersion,
      pricingVerified: RELAY_SCREENSHOT_PRICING.source.providerVerified,
      pricingMultiplier: estimates[0]?.pricingMultiplier ?? RELAY_SCREENSHOT_PRICING.multiplier,
      estimatedInputTokensPerFinalRequest: inputTokens,
      estimatedOutputTokensPerFinalRequest: outputTokens,
      budgetUsdToCny: exchange,
      requestEstimates: estimates,
    },
  };
}

export function createAdminModelLabHttpClient({
  baseUrl,
  origin,
  password,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const root = normalizeAdminModelLabBaseUrl(baseUrl);
  const requestOrigin = String(origin || root.origin).replace(/\/$/u, "");
  const adminPassword = requiredText(password, "password");
  let cookie = "";
  let csrfToken = "";

  async function request(pathname, { method = "GET", query, body } = {}) {
    const url = new URL(pathname, root);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      accept: "application/json",
      origin: requestOrigin,
      ...(cookie ? { cookie } : {}),
    };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      if (csrfToken) headers["x-csrf-token"] = csrfToken;
    }
    const response = await fetchImpl(url, {
      method,
      cache: "no-store",
      // Never let fetch replay the admin password, session cookie, CSRF token,
      // or request body to a redirect target. Operators must configure the
      // canonical backend URL explicitly.
      redirect: "manual",
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) }),
    });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error("Admin Model Lab redirects are forbidden");
      error.status = response.status;
      error.code = "admin_model_lab_redirect_forbidden";
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const error = new Error(String(payload?.message || payload?.error || `HTTP ${response.status}`));
      error.status = response.status;
      error.code = payload?.error || "admin_model_lab_request_failed";
      throw error;
    }
    return { payload, response };
  }

  async function labRequest(action, { method = "GET", query = {}, body = {} } = {}) {
    const requestQuery = method === "GET" ? { action, ...query } : undefined;
    const requestBody = method === "GET" ? undefined : { action, ...body };
    const { payload } = await request("/api/admin-model-lab", {
      method,
      query: requestQuery,
      body: requestBody,
    });
    return payload?.data ?? payload;
  }

  async function runEvents(runId) {
    const url = new URL("/api/admin-model-lab", root);
    url.searchParams.set("action", "events");
    url.searchParams.set("runId", requiredText(runId, "runId"));
    url.searchParams.set("afterSequence", "0");
    url.searchParams.set("limit", "1000");
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "text/event-stream",
        origin: requestOrigin,
        ...(cookie ? { cookie } : {}),
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error("Admin Model Lab redirects are forbidden");
      error.status = response.status;
      error.code = "admin_model_lab_redirect_forbidden";
      throw error;
    }
    const text = await response.text();
    if (!response.ok) {
      let payload = {};
      try {
        payload = JSON.parse(text);
      } catch {
        // Preserve a bounded generic error when an intermediary did not return JSON.
      }
      const error = new Error(String(payload?.message || payload?.error || `HTTP ${response.status}`));
      error.status = response.status;
      error.code = payload?.error || "admin_model_lab_events_failed";
      throw error;
    }
    return parseSseEvents(text);
  }

  return Object.freeze({
    async login() {
      const { payload, response } = await request("/api/admin-auth", {
        method: "POST",
        body: { action: "login", password: adminPassword },
      });
      cookie = extractCookie(response.headers);
      csrfToken = String(payload?.csrfToken || "");
      if (!cookie || !csrfToken || payload?.authenticated !== true) {
        throw new Error("Admin login did not return a cookie and CSRF token");
      }
      return payload;
    },
    capabilities: () => labRequest("capabilities"),
    createRun: (body) => labRequest("create", { method: "POST", body }),
    forkRun: (body) => labRequest("fork", { method: "POST", body }),
    executeRun: (runId) => labRequest("execute", {
      method: "POST",
      body: { runId },
    }),
    getRun: (runId) => labRequest("run", { query: { runId } }),
    getRunEvents: runEvents,
  });
}

export function collectAvailableModels(capabilities = {}) {
  const source = capabilities?.capabilities || capabilities || {};
  const providerEnvelope = source.providers;
  const providers = Array.isArray(providerEnvelope)
    ? providerEnvelope
    : (Array.isArray(providerEnvelope?.providers) ? providerEnvelope.providers : []);
  const result = new Map();

  for (const providerEntry of providers) {
    const provider = String(
      providerEntry?.providerId || providerEntry?.id || providerEntry?.provider || "",
    ).trim().toLowerCase();
    const providerAvailable = providerEntry?.available === true;
    for (const modelEntry of Array.isArray(providerEntry?.models) ? providerEntry.models : []) {
      const model = String(
        typeof modelEntry === "string"
          ? modelEntry
          : modelEntry?.modelId || modelEntry?.id || modelEntry?.model || "",
      ).trim();
      const descriptor = typeof modelEntry === "string" ? {} : modelEntry;
      if (
        !provider
        || !model
        || !providerAvailable
        || descriptor?.available !== true
        || descriptor?.transportAvailable !== true
        || descriptor?.budgetConfigured !== true
        || descriptor?.budgetAvailable !== true
        || !String(descriptor?.budgetPool || "").trim()
      ) continue;
      result.set(model, {
        provider,
        model,
        canonicalModel: String(descriptor?.canonicalModelId || "").trim(),
        budgetPool: String(descriptor.budgetPool),
        supportedReasoningModes: arrayOrEmpty(descriptor?.supportedReasoningModes),
        supportedReasoningEfforts: arrayOrEmpty(descriptor?.supportedReasoningEfforts),
      });
    }
  }
  return result;
}

function normalizeAdminModelLabBaseUrl(value) {
  let url;
  try {
    url = new URL(requiredText(value, "baseUrl"));
  } catch (cause) {
    throw new TypeError(`baseUrl must be a valid URL: ${cause?.message || cause}`);
  }
  if (url.username || url.password) {
    throw new TypeError("baseUrl must not contain credentials");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new TypeError("baseUrl must use HTTPS; HTTP is allowed only for loopback development");
}

function isLoopbackHostname(value) {
  const hostname = String(value || "").trim().toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!match || match.slice(1).some((part) => Number(part) > 255)) return false;
  return Number(match[1]) === 127;
}

export function formatMatrixMarkdown(report) {
  const lines = [
    "# 管理实验室模型矩阵",
    "",
    `- 问题：${escapeMarkdown(report.question)}`,
    `- 源运行：${escapeMarkdown(report.sourceRunId)}`,
    `- 证据变体：${escapeMarkdown((report.evidenceVariants || []).join(", ") || "full")}`,
    `- 总耗时：${formatDuration(report.durationMs)}`,
    "",
    "| 配置 | 状态 | 裁定 | 总耗时 | 最终裁定耗时 | SSE | Token | 费用 |",
    "| --- | --- | --- | ---: | ---: | --- | ---: | ---: |",
  ];
  for (const item of report.results || []) {
    const config = item.configuration || {};
    lines.push(`| ${escapeMarkdown(`${config.model} / ${config.reasoningMode} / ${config.reasoningEffort} / ${item.evidenceVariant || config.evidenceVariant || "full"}`)} | ${escapeMarkdown(item.status)} | ${escapeMarkdown(item.conciseAnswer || item.error?.message || "-")} | ${formatDuration(item.metrics?.totalDurationMs)} | ${formatDuration(item.metrics?.finalRulingMs)} | ${escapeMarkdown(formatRelayStreamMetrics(item.metrics?.relayStream))} | ${escapeMarkdown(formatTokens(item.metrics?.tokenUsage))} | ${escapeMarkdown(formatCost(item.metrics?.cost))} |`);
    if (Array.isArray(item.verdicts) && item.verdicts.length) {
      lines.push(`| ↳ verdict |  | ${escapeMarkdown(item.verdicts.map((verdict) => `${verdict.questionId}: ${verdict.value}`).join("; "))} |  |  |  |  |  |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatMatrixBatchMarkdown(report) {
  const lines = [
    "# 管理实验室四题模型矩阵",
    "",
    `- 题目数：${Number(report?.reports?.length || 0)}`,
    `- 计划最终请求：${Number(report?.guard?.plannedFinalRequests || 0)}`,
    `- 计划费用上界：¥${Number(report?.guard?.plannedEstimatedCostCny || 0).toFixed(6)}`,
    `- 总耗时：${formatDuration(report?.durationMs)}`,
  ];
  for (const item of report?.reports || []) {
    lines.push(
      "",
      `## ${escapeMarkdown(item.caseId)}`,
      "",
      formatMatrixMarkdown(item).replace(/^# 管理实验室模型矩阵\r?\n+/u, "").trimEnd(),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseMatrixArguments(argv = []) {
  const options = { configurations: [], format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    if (argument === "--question") options.question = take();
    else if (argument === "--question-file") options.questionFile = take();
    else if (argument === "--cases-file") options.casesFile = take();
    else if (argument === "--source-run-id") options.sourceRunId = take();
    else if (argument === "--base-url") options.baseUrl = take();
    else if (argument === "--origin") options.origin = take();
    else if (argument === "--config") options.configurations.push(parseConfiguration(take()));
    else if (argument === "--config-file") options.configurationFile = take();
    else if (argument === "--format") options.format = take().toLowerCase();
    else if (argument === "--output") options.output = take();
    else if (argument === "--poll-ms") options.pollIntervalMs = positiveInteger(take(), "poll-ms");
    else if (argument === "--timeout-ms") options.runTimeoutMs = positiveInteger(take(), "timeout-ms");
    else if (argument === "--concurrency") options.concurrency = positiveInteger(take(), "concurrency");
    else if (argument === "--max-final-requests") options.maxFinalRequests = positiveInteger(take(), "max-final-requests");
    else if (argument === "--max-cost-cny") options.maxEstimatedCostCny = nonNegativeNumber(take(), "max-cost-cny");
    else if (argument === "--estimated-cny-per-request") options.estimatedCnyPerFinalRequest = nonNegativeNumber(take(), "estimated-cny-per-request");
    else if (argument === "--estimated-input-tokens") options.estimatedInputTokensPerFinalRequest = nonNegativeInteger(take(), "estimated-input-tokens");
    else if (argument === "--estimated-output-tokens") options.estimatedOutputTokensPerFinalRequest = nonNegativeInteger(take(), "estimated-output-tokens");
    else if (argument === "--budget-usd-to-cny") options.budgetUsdToCny = positiveNumber(take(), "budget-usd-to-cny");
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.configurations.length) delete options.configurations;
  if (!["json", "markdown"].includes(options.format)) {
    throw new Error("--format must be json or markdown");
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseMatrixArguments(argv);
  const readFileImpl = dependencies.readFileImpl || readFile;
  const writeFileImpl = dependencies.writeFileImpl || writeFile;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write(usageText());
    return 0;
  }
  if (options.casesFile && (options.question || options.questionFile || options.sourceRunId)) {
    throw new Error("--cases-file cannot be combined with --question, --question-file or --source-run-id");
  }
  if (options.question && options.questionFile) {
    throw new Error("--question and --question-file are mutually exclusive");
  }
  const password = env.ADMIN_MODEL_LAB_PASSWORD
    || env.ADMIN_PASSWORD
    || await (dependencies.promptSecretImpl || promptSecret)("管理密码：");
  const question = options.question || (options.questionFile
    ? await readFileImpl(options.questionFile, "utf8")
    : "");
  let configurations = options.configurations;
  if (options.configurationFile) {
    const parsed = JSON.parse(await readFileImpl(options.configurationFile, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("--config-file must contain a JSON array");
    configurations = parsed;
  }
  const sharedOptions = {
    ...options,
    baseUrl: options.baseUrl || env.ADMIN_MODEL_LAB_BASE_URL,
    origin: options.origin || env.ADMIN_MODEL_LAB_ORIGIN,
    password,
    fetchImpl,
    maxFinalRequests: options.maxFinalRequests
      ?? env.ADMIN_MATRIX_MAX_FINAL_REQUESTS
      ?? DEFAULT_MAX_FINAL_REQUESTS,
    maxEstimatedCostCny: options.maxEstimatedCostCny
      ?? env.ADMIN_MATRIX_MAX_ESTIMATED_COST_CNY
      ?? DEFAULT_MAX_ESTIMATED_COST_CNY,
    estimatedCnyPerFinalRequest: options.estimatedCnyPerFinalRequest
      ?? optionalNumber(env.RELAY_ESTIMATED_CNY_PER_CALL),
    estimatedInputTokensPerFinalRequest: options.estimatedInputTokensPerFinalRequest
      ?? env.ADMIN_MATRIX_ESTIMATED_INPUT_TOKENS
      ?? DEFAULT_ESTIMATED_INPUT_TOKENS_PER_FINAL_REQUEST,
    estimatedOutputTokensPerFinalRequest: options.estimatedOutputTokensPerFinalRequest
      ?? env.ADMIN_MATRIX_ESTIMATED_OUTPUT_TOKENS
      ?? DEFAULT_ESTIMATED_OUTPUT_TOKENS_PER_FINAL_REQUEST,
    budgetUsdToCny: options.budgetUsdToCny
      ?? env.ADMIN_MODEL_LAB_USD_TO_CNY_RATE
      ?? DEFAULT_BUDGET_USD_TO_CNY,
    ...(configurations ? { configurations } : {}),
  };
  const report = options.casesFile
    ? await runAdminModelMatrixBatch({
        ...sharedOptions,
        questions: parseCasesFile(await readFileImpl(options.casesFile, "utf8")),
      })
    : await runAdminModelMatrix({ ...sharedOptions, question });
  const output = options.format === "markdown"
    ? (options.casesFile ? formatMatrixBatchMarkdown(report) : formatMatrixMarkdown(report))
    : `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFileImpl(options.output, output, "utf8");
  else stdout.write(output);
  return 0;
}

async function executeAndWait({ client, runId, pollIntervalMs, runTimeoutMs, sleep }) {
  // Keep polling while the execute request is open. This supports both the
  // synchronous server implementation and future enqueue-and-return adapters.
  const executePromise = client.executeRun(runId).catch((error) => error);
  const deadline = Date.now() + runTimeoutMs;
  let lastRun = null;
  while (Date.now() <= deadline) {
    const response = await client.getRun(runId);
    lastRun = extractRun(response);
    if (TERMINAL_STATUSES.has(normalizeStatus(lastRun?.status))) {
      await Promise.race([executePromise, sleep(100)]);
      return lastRun;
    }
    await sleep(pollIntervalMs);
  }
  const executionOutcome = await Promise.race([executePromise, Promise.resolve(null)]);
  if (executionOutcome instanceof Error && !lastRun) throw executionOutcome;
  const error = new Error(`Run ${runId} did not reach a terminal status before timeout`);
  error.code = "admin_matrix_run_timeout";
  throw error;
}

async function readRunAudit(client, runId) {
  try {
    return {
      events: await client.getRunEvents(runId),
      error: null,
    };
  } catch (error) {
    return {
      events: [],
      error: normalizeError(error),
    };
  }
}

export function validateReusableSourceRun({
  run,
  events = [],
  question,
  sourceConfiguration,
  availableModels,
} = {}) {
  const normalizedSource = normalizeConfiguration(sourceConfiguration || SOURCE_CONFIGURATION);
  if (!(availableModels instanceof Map)) {
    throw sourceRunError("source capabilities are required");
  }
  const sourceAvailability = validateConfiguration(normalizedSource, availableModels);
  if (!sourceAvailability.ok) {
    throw sourceRunError(`source configuration is not explicitly available: ${sourceAvailability.reason}`);
  }
  const capability = availableModels.get(normalizedSource.model);
  const expectedCanonicalModel = String(capability?.canonicalModel || "").trim();
  if (!expectedCanonicalModel) {
    throw sourceRunError("source capability does not declare a canonical model identity");
  }
  if (!run || !TERMINAL_STATUSES.has(normalizeStatus(run.status))) {
    throw sourceRunError("source run must be terminal");
  }
  const rawSnapshot = fullEvidenceSnapshot(run);
  if (!rawSnapshot) throw sourceRunError("source run does not contain a full frozen evidence snapshot");
  let snapshot;
  try {
    snapshot = parseEvidenceSnapshot(rawSnapshot);
  } catch (error) {
    throw sourceRunError(`source evidence snapshot integrity check failed: ${error?.message || error}`);
  }
  const expectedQuestion = requiredText(question, "question");
  if (String(snapshot.question || "").trim() !== expectedQuestion) {
    throw sourceRunError("source evidence question does not match the requested question");
  }

  const profile = run.executionProfile || {};
  const finalProfile = profile.finalRuling || {};
  if (
    profile.status !== "evidence_frozen"
    || finalProfile.provider !== normalizedSource.provider
    || finalProfile.requestedModel !== normalizedSource.model
    || finalProfile.model !== expectedCanonicalModel
    || finalProfile.reasoningMode !== normalizedSource.reasoningMode
    || finalProfile.reasoningEffort !== normalizedSource.reasoningEffort
    || finalProfile.finalAttemptPolicy !== "single"
    || normalizeAdminEvidenceVariant(profile.evidenceVariant)
      !== normalizedSource.evidenceVariant
  ) {
    throw sourceRunError("source run execution profile does not match the requested capability configuration / single policy");
  }
  if (String(profile.evidenceSnapshotId || "") !== snapshot.snapshotId) {
    throw sourceRunError("source execution profile is not bound to the frozen evidence snapshot");
  }
  for (const [label, value] of [
    ["run evidenceSnapshotId", run.evidenceSnapshotId],
    ["result evidenceSnapshotId", run.result?.evidenceSnapshotId],
    ["fork sourceEvidenceSnapshotId", run.metadata?.fork?.sourceEvidenceSnapshotId],
  ]) {
    if (value !== undefined && value !== null && String(value) !== snapshot.snapshotId) {
      throw sourceRunError(`${label} does not match the frozen evidence snapshot`);
    }
  }
  for (const [label, value] of [
    ["run evidenceSnapshotSha256", run.evidenceSnapshotSha256],
    ["fork evidenceSnapshotSha256", run.metadata?.fork?.evidenceSnapshotSha256],
  ]) {
    if (value !== undefined && value !== null && String(value) !== snapshot.contentSha256) {
      throw sourceRunError(`${label} does not match the frozen evidence snapshot hash`);
    }
  }
  if (
    snapshot.evidence?.request?.finalAttemptPolicy !== "single"
    || snapshot.evidence?.request?.finalModel !== expectedCanonicalModel
    || snapshot.metadata?.finalRulingProvider !== normalizedSource.provider
  ) {
    throw sourceRunError("source evidence snapshot does not preserve the requested model/provider single-attempt request");
  }

  const attempt = latestFinalAttempt(run, events);
  const returnedModel = String(
    run.result?.provider?.model
    || run.result?.metering?.stages?.finalRuling?.model
    || attempt?.model
    || "",
  ).trim();
  if (returnedModel !== expectedCanonicalModel) {
    throw sourceRunError(`source run has no completed response from ${expectedCanonicalModel}`);
  }
  return snapshot;
}

function summarizeRun({ role, configuration, run, events = [], auditReadError = null }) {
  const finalRuling = run?.result?.finalRuling || run?.result?.ruling || run?.result?.output || null;
  const latency = run?.result?.latency || run?.result?.metrics?.latency || run?.metrics?.latency || {};
  const metering = run?.result?.metering || {};
  const attempt = latestFinalAttempt(run, events);
  const failureMetering = copySafeFailureMetering(run?.error?.failureMetering);
  const usage = metering?.totals?.usage
    || run?.result?.metrics?.usage
    || run?.result?.usage
    || attempt?.usage
    || failureMetering?.usage
    || null;
  const cost = metering?.totals?.cost
    || run?.result?.metrics?.cost
    || run?.result?.cost
    || attempt?.cost
    || failureMetering?.cost
    || null;
  const snapshot = safeSnapshotIdentity(run);
  const finishReason = optionalText(
    run?.result?.provider?.finishReason
    || run?.result?.provider?.finish_reason
    || attempt?.finishReason
    || attempt?.finish_reason
    || run?.error?.streamMetrics?.finishReason,
  );
  const relayStream = copySafeStreamMetrics(run?.result?.provider?.streamMetrics
    || latency?.relayStream
    || attempt?.streamMetrics
    || run?.error?.streamMetrics
    || null);
  return {
    role,
    runId: extractRunId(run),
    status: normalizeStatus(run?.status) || "UNKNOWN",
    configuration: { ...configuration },
    evidenceVariant: normalizeAdminEvidenceVariant(
      run?.result?.evidenceVariant
      || run?.executionProfile?.evidenceVariant
      || configuration?.evidenceVariant,
    ),
    finalRulingInputSha256: optionalText(
      run?.result?.finalRulingInputSha256
      || run?.executionProfile?.finalRulingInputSha256,
    ),
    requestedModel: String(configuration?.model || ""),
    returnedModel: String(
      metering?.stages?.finalRuling?.model
      || run?.result?.provider?.model
      || attempt?.model
      || run?.error?.reportedModel
      || run?.execution?.providerRequest?.model
      || run?.execution?.request?.model
      || "",
    ) || null,
    conciseAnswer: String(finalRuling?.conciseAnswer || ""),
    verdicts: Array.isArray(finalRuling?.verdicts) ? finalRuling.verdicts : [],
    timeline: Array.isArray(finalRuling?.timeline) ? finalRuling.timeline : [],
    evidenceSnapshot: snapshot,
    metrics: {
      totalDurationMs: firstFinite(latency.totalWallClockMs, latency.totalMs, run?.durationMs),
      preparationMs: firstFinite(latency.preparationMs),
      finalRulingMs: firstFinite(latency.finalRulingMs),
      stages: stageTimingSummary(run, latency),
      finishReason,
      relayStream,
      tokenUsage: usage,
      cost,
    },
    audit: {
      eventCount: Array.isArray(events) ? events.length : 0,
      completedAttemptRecovered: Boolean(attempt),
      ...(auditReadError ? { readError: auditReadError } : {}),
    },
    ...(run?.error ? { error: normalizeError(run.error) } : {}),
  };
}

function summarizeSkipped(configuration, reason) {
  return {
    role: "fork",
    runId: null,
    status: "SKIPPED",
    configuration: { ...configuration },
    evidenceVariant: normalizeAdminEvidenceVariant(configuration?.evidenceVariant),
    finalRulingInputSha256: null,
    conciseAnswer: "",
    verdicts: [],
    timeline: [],
    metrics: emptyMetrics(),
    error: { code: "model_unavailable", message: reason },
  };
}

function summarizeFailure(configuration, error) {
  return {
    role: "fork",
    runId: null,
    status: "FAILED",
    configuration: { ...configuration },
    evidenceVariant: normalizeAdminEvidenceVariant(configuration?.evidenceVariant),
    finalRulingInputSha256: null,
    conciseAnswer: "",
    verdicts: [],
    timeline: [],
    metrics: emptyMetrics(),
    error: normalizeError(error),
  };
}

function emptyMetrics() {
  return {
    totalDurationMs: null,
    preparationMs: null,
    finalRulingMs: null,
    stages: [],
    finishReason: null,
    tokenUsage: null,
    cost: null,
  };
}

function validateConfiguration(configuration, availableModels) {
  const descriptor = availableModels.get(configuration.model);
  if (!descriptor) return { ok: false, reason: `${configuration.model} is not available` };
  if (descriptor.provider !== configuration.provider) {
    return { ok: false, reason: `${configuration.model} belongs to ${descriptor.provider}` };
  }
  if (descriptor.supportedReasoningModes.length
    && !descriptor.supportedReasoningModes.includes(configuration.reasoningMode)) {
    return { ok: false, reason: `${configuration.model} does not support mode ${configuration.reasoningMode}` };
  }
  if (descriptor.supportedReasoningEfforts.length
    && !descriptor.supportedReasoningEfforts.includes(configuration.reasoningEffort)) {
    return { ok: false, reason: `${configuration.model} does not support effort ${configuration.reasoningEffort}` };
  }
  return { ok: true };
}

function assertRequiredFeatures(capabilities) {
  const features = capabilities?.features || capabilities?.capabilities?.features || {};
  for (const name of ["createRun", "forkRun", "executeRun"]) {
    if (features[name] !== true) throw new Error(`Admin lab capability is unavailable: ${name}`);
  }
}

function assertPersistentFinalCallBudget(capabilities) {
  const source = capabilities?.capabilities || capabilities || {};
  const budget = source?.architecture?.finalCallBudget;
  if (
    budget?.configured !== true
    || budget?.persistent !== true
    || !String(budget?.storageKind || "").trim()
    || budget?.storageKind === "unconfigured"
  ) {
    throw new Error(
      "Admin lab must report a configured persistent final-call budget ledger before paid matrix runs",
    );
  }
}

function dedupeConfigurations(configurations) {
  if (!Array.isArray(configurations)) throw new TypeError("configurations must be an array");
  const result = new Map();
  for (const value of configurations) {
    const normalized = normalizeConfiguration(value);
    result.set(configurationKey(normalized), normalized);
  }
  return [...result.values()];
}

function normalizeQuestionCases(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("questions must be a non-empty array");
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { caseId: `case-${index + 1}`, question: requiredText(item, `questions[${index}]`) };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`questions[${index}] must be a string or object`);
    }
    return {
      caseId: requiredText(item.caseId || item.id || `case-${index + 1}`, `questions[${index}].caseId`),
      question: requiredText(item.question, `questions[${index}].question`),
    };
  });
}

function parseCasesFile(serialized) {
  let parsed;
  try {
    parsed = JSON.parse(String(serialized || ""));
  } catch (error) {
    throw new Error(`--cases-file must contain valid JSON: ${error?.message || error}`);
  }
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(cases)) {
    throw new Error("--cases-file must contain a JSON array or an object with a cases array");
  }
  return normalizeQuestionCases(cases);
}

function parseSseEvents(serialized) {
  const events = [];
  for (const block of String(serialized || "").split(/\r?\n\r?\n/gu)) {
    let eventName = "message";
    const data = [];
    for (const line of block.split(/\r?\n/gu)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length || eventName === "end") continue;
    let value;
    try {
      value = JSON.parse(data.join("\n"));
    } catch (error) {
      throw new Error(`admin model lab event stream contained invalid JSON: ${error?.message || error}`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
  }
  return events;
}

function sourceRunError(message) {
  const error = new Error(`Reusable source run rejected: ${message}`);
  error.code = "admin_matrix_source_run_invalid";
  return error;
}

function fullEvidenceSnapshot(run) {
  const candidates = [run?.evidenceSnapshot, run?.result?.evidenceSnapshot];
  return candidates.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function safeSnapshotIdentity(run) {
  const snapshot = fullEvidenceSnapshot(run);
  if (!snapshot) {
    return {
      id: optionalText(run?.evidenceSnapshotId || run?.result?.evidenceSnapshotId),
      sha256: optionalText(run?.evidenceSnapshotSha256),
      integrity: "unavailable",
    };
  }
  try {
    const parsed = parseEvidenceSnapshot(snapshot);
    return {
      id: parsed.snapshotId,
      sha256: parsed.contentSha256,
      integrity: "verified",
    };
  } catch {
    return {
      id: optionalText(snapshot.snapshotId),
      sha256: optionalText(snapshot.contentSha256),
      integrity: "invalid",
    };
  }
}

function latestFinalAttempt(run, events = []) {
  const attempts = run?.result?.metering?.stages?.finalRuling?.attempts;
  if (Array.isArray(attempts) && attempts.length) return attempts.at(-1);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const attempt = events[index]?.payload?.completedAttempt;
    if (attempt && typeof attempt === "object" && !Array.isArray(attempt)) return attempt;
  }
  return null;
}

function stageTimingSummary(run, latency) {
  const stages = Array.isArray(latency?.stages)
    ? latency.stages
    : (Array.isArray(run?.stageTiming?.stages) ? run.stageTiming.stages : []);
  return stages.map((stage) => ({
    id: String(stage?.id || ""),
    status: String(stage?.status || ""),
    durationMs: firstFinite(stage?.durationMs),
    speedLabel: optionalText(stage?.speedLabel),
    skipReason: optionalText(stage?.skipReason),
  }));
}

function normalizeConfiguration(value = {}) {
  return {
    provider: requiredText(value.provider, "configuration.provider").toLowerCase(),
    model: requiredText(value.model, "configuration.model"),
    reasoningMode: requiredText(value.reasoningMode || value.mode, "configuration.reasoningMode").toLowerCase(),
    reasoningEffort: requiredText(value.reasoningEffort || value.effort, "configuration.reasoningEffort").toLowerCase(),
    evidenceVariant: normalizeAdminEvidenceVariant(
      value.evidenceVariant || value.variant,
    ),
  };
}

function parseConfiguration(text) {
  const [provider, model, reasoningMode, reasoningEffort, evidenceVariant, ...extra] = String(text || "").split(":");
  if (extra.length || !provider || !model || !reasoningMode || !reasoningEffort) {
    throw new Error("--config must be provider:model:reasoningMode:reasoningEffort[:evidenceVariant]");
  }
  return normalizeConfiguration({
    provider,
    model,
    reasoningMode,
    reasoningEffort,
    evidenceVariant,
  });
}

function configurationKey(configuration) {
  return [
    configuration.provider,
    configuration.model,
    configuration.reasoningMode,
    configuration.reasoningEffort,
    configuration.evidenceVariant,
  ].join(":");
}

async function mapLimit(values, limit, mapper) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(safeLimit, values.length) }, () => worker()));
  return results;
}

function extractRun(value) {
  return value?.run || value?.record || value?.item || value || null;
}

function extractRunId(value) {
  const run = extractRun(value);
  return String(run?.runId || run?.id || value?.runId || "").trim() || null;
}

function hasFrozenEvidence(run) {
  return Boolean(
    run?.evidenceSnapshot
    || run?.frozenEvidence
    || run?.evidenceSnapshotId
    || run?.evidenceArchiveId
    || run?.result?.evidenceSnapshot
    || run?.result?.evidenceSnapshotId,
  );
}

function extractCookie(headers) {
  const setCookies = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : [];
  const raw = setCookies[0] || headers?.get?.("set-cookie") || "";
  return String(raw).split(";", 1)[0].trim();
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeError(error) {
  const normalized = {
    code: String(error?.code || error?.error || "admin_matrix_request_failed"),
    message: String(error?.message || error?.detail || error?.code || error || "request failed"),
  };
  if (error && typeof error === "object") {
    for (const field of [
      "provider",
      "requestId",
      "model",
      "requestedModel",
      "submittedModel",
      "reportedModel",
      "billingStatus",
      "upstreamErrorCode",
      "upstreamCauseCode",
    ]) {
      const value = optionalText(error[field]);
      if (value) normalized[field] = value.slice(0, 512);
      else if (field === "reportedModel" && Object.hasOwn(error, field)) normalized[field] = null;
    }
    const status = firstFinite(error.status);
    if (status !== null) normalized.status = status;
    for (const field of ["outcomeKnown", "budgetReservationMayExist"]) {
      if (typeof error[field] === "boolean") normalized[field] = error[field];
    }
    const usage = copySafeUsage(error.usage);
    if (usage) normalized.usage = usage;
    const failureMetering = copySafeFailureMetering(error.failureMetering);
    if (failureMetering) normalized.failureMetering = failureMetering;
    const streamMetrics = copySafeStreamMetrics(error.streamMetrics);
    if (streamMetrics) normalized.streamMetrics = streamMetrics;
  }
  return normalized;
}

function copySafeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ]) {
    const number = firstFinite(value[field]);
    if (number !== null) result[field] = number;
  }
  return Object.keys(result).length ? result : null;
}

function copySafeFailureMetering(value) {
  if (!value || typeof value !== "object" || value.scope !== "final_ruling_only") return null;
  const usage = copySafeUsage(value.usage);
  const sourceCost = value.cost && typeof value.cost === "object" && !Array.isArray(value.cost)
    ? value.cost
    : {};
  const cost = {};
  for (const field of [
    "provider",
    "model",
    "requestedModel",
    "exchangeRateVersion",
    "pricingVersion",
    "pricingEffectiveDate",
    "pricingStatus",
    "unavailabilityReason",
  ]) {
    const text = optionalText(sourceCost[field]);
    if (text) cost[field] = text.slice(0, 512);
  }
  for (const field of [
    "exchangeRate",
    "pricingMultiplier",
    "inputCostUsd",
    "cachedInputCostUsd",
    "cacheWriteCostUsd",
    "outputCostUsd",
    "totalCostUsd",
    "inputCostCny",
    "cachedInputCostCny",
    "cacheWriteCostCny",
    "outputCostCny",
    "totalCostCny",
  ]) {
    const number = firstFinite(sourceCost[field]);
    if (number !== null) cost[field] = number;
  }
  for (const field of ["pricingSourceVerified", "estimateOnly"]) {
    if (typeof sourceCost[field] === "boolean") cost[field] = sourceCost[field];
  }
  return usage || Object.keys(cost).length
    ? { scope: "final_ruling_only", usage, cost }
    : null;
}

function copySafeStreamMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = { schemaVersion: 1, transport: "sse" };
  for (const field of [
    "requestToResponseHeadersMs",
    "requestToFirstByteMs",
    "requestToFirstEventMs",
    "requestToFirstContentMs",
    "requestToCompleteMs",
  ]) {
    result[field] = firstFinite(value[field]);
  }
  for (const field of [
    "networkChunkCount",
    "sseEventCount",
    "visibleContentChunkCount",
    "responseBytes",
    "visibleContentBytes",
  ]) {
    const number = firstFinite(value[field]);
    result[field] = Number.isSafeInteger(number) ? number : 0;
  }
  result.finishReason = optionalText(value.finishReason)?.slice(0, 128) || null;
  return result;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`);
  return number;
}

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return undefined;
  return nonNegativeNumber(value, "RELAY_ESTIMATED_CNY_PER_CALL");
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e9) / 1e9;
}

function formatDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number / 1_000).toFixed(2)}s` : "-";
}

function formatTokens(value) {
  if (!value || typeof value !== "object") return "-";
  const total = firstFinite(value.totalTokens, value.total_tokens, value.inputTokens + value.outputTokens);
  return total === null ? "-" : String(total);
}

function formatRelayStreamMetrics(value) {
  if (!value || typeof value !== "object") return "-";
  const duration = (field) => (
    typeof value[field] === "number" && Number.isFinite(value[field])
      ? `${(value[field] / 1_000).toFixed(2)}s`
      : "-"
  );
  const counts = Number.isSafeInteger(value.networkChunkCount)
    && Number.isSafeInteger(value.sseEventCount)
    ? `${value.networkChunkCount}/${value.sseEventCount}`
    : "-";
  const bytes = Number.isSafeInteger(value.responseBytes)
    && Number.isSafeInteger(value.visibleContentBytes)
    ? `${value.responseBytes}/${value.visibleContentBytes}B`
    : "-";
  return [
    `头 ${duration("requestToResponseHeadersMs")}`,
    `首字节 ${duration("requestToFirstByteMs")}`,
    `事件 ${duration("requestToFirstEventMs")}`,
    `正文 ${duration("requestToFirstContentMs")}`,
    `完成 ${duration("requestToCompleteMs")}`,
    `块/事件 ${counts}`,
    `响应/正文 ${bytes}`,
    `finish ${optionalText(value.finishReason) || "-"}`,
  ].join("；");
}

function formatCost(value) {
  if (!value || typeof value !== "object") return "-";
  const cny = firstFinite(value.totalCostCny, value.knownCostCny);
  if (cny !== null) return `¥${cny.toFixed(6)}`;
  const usd = firstFinite(value.totalCostUsd, value.knownCostUsd);
  return usd === null ? "-" : `$${usd.toFixed(6)}`;
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptSecret(label) {
  if (!process.stdin.isTTY) {
    throw new Error("Set ADMIN_MODEL_LAB_PASSWORD (or ADMIN_PASSWORD) when stdin is not interactive");
  }
  const output = process.stderr;
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const original = readline._writeToOutput;
  let muted = true;
  readline._writeToOutput = function maskedWrite(text) {
    if (!muted) return original.call(this, text);
    if (/^[\r\n]+$/u.test(text)) output.write(text);
  };
  try {
    const secret = await readline.question(label);
    muted = false;
    output.write("\n");
    return requiredText(secret, "password");
  } finally {
    readline.close();
  }
}

function usageText() {
  return `用法：node scripts/admin-model-matrix.mjs --base-url URL --origin ORIGIN (--question "问题" | --cases-file FILE) [选项]\n\n` +
    `密码从 ADMIN_MODEL_LAB_PASSWORD（或 ADMIN_PASSWORD）读取；未设置时在 TTY 中隐藏输入。\n` +
    `--question-file FILE 读取一道题；--cases-file FILE 读取四题 JSON 数组或 { cases: [...] }。\n` +
    `--source-run-id ID 只复用题面、快照哈希、capabilities 配置身份和 single 策略均严格匹配的源运行。\n` +
    `--cases-file 不可与单题参数或 --source-run-id 同时使用。\n` +
    `--config provider:model:reasoningMode:reasoningEffort[:evidenceVariant] 可重复指定。\n` +
    `evidenceVariant 严格支持 full、card_text_only、without_lua；同一模型可重复配置不同变体并共享源快照。\n` +
    `--config-file FILE 读取配置 JSON 数组。\n` +
    `--format json|markdown  --output FILE  --concurrency N（硬上限默认 1）\n` +
    `--max-final-requests N（默认 12）  --max-cost-cny N（默认 10，共享池）\n` +
    `--estimated-input-tokens N（默认 32000）  --estimated-output-tokens N（默认 8192）\n` +
    `--budget-usd-to-cny N（默认 7.5，仅预算换算因子，不是实时汇率）\n` +
    `--estimated-cny-per-request N（可选统一覆盖；未设置时按截图中的 Sol/Terra/Luna 分模型费率估算）\n`;
}

function isMain(metaUrl) {
  return process.argv[1] && fileURLToPath(metaUrl) === process.argv[1];
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`模型矩阵失败：${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
