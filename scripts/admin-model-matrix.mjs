import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const TERMINAL_STATUSES = new Set(["CANCELLED", "SUCCEEDED", "FAILED"]);

export const SOURCE_CONFIGURATION = Object.freeze({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  reasoningMode: "standard",
  reasoningEffort: "none",
});

export const DEFAULT_MATRIX_CONFIGURATIONS = Object.freeze([
  SOURCE_CONFIGURATION,
  Object.freeze({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "pro",
    reasoningEffort: "high",
  }),
  Object.freeze({
    provider: "glm",
    model: "glm-5.2",
    reasoningMode: "standard",
    reasoningEffort: "none",
  }),
  Object.freeze({
    provider: "glm",
    model: "glm-5.2",
    reasoningMode: "pro",
    reasoningEffort: "high",
  }),
  Object.freeze({
    provider: "kimi",
    model: "kimi-k2.6",
    reasoningMode: "standard",
    reasoningEffort: "none",
  }),
  Object.freeze({
    provider: "kimi",
    model: "kimi-k2.6",
    reasoningMode: "pro",
    reasoningEffort: "none",
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
  configurations = DEFAULT_MATRIX_CONFIGURATIONS,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 1_500,
  runTimeoutMs = 10 * 60_000,
  concurrency = 1,
  now = () => new Date(),
  sleep = defaultSleep,
} = {}) {
  const normalizedQuestion = requiredText(question, "question");
  const normalizedConfigurations = dedupeConfigurations(configurations);
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
  const availableModels = collectAvailableModels(capabilities);
  const sourceAvailability = validateConfiguration(SOURCE_CONFIGURATION, availableModels);
  if (!sourceAvailability.ok) {
    throw new Error(`DeepSeek Flash source configuration is unavailable: ${sourceAvailability.reason}`);
  }

  let sourceRunId = optionalText(requestedSourceRunId);
  let sourceRun;
  if (sourceRunId) {
    sourceRun = extractRun(await client.getRun(sourceRunId));
    if (!sourceRun || !TERMINAL_STATUSES.has(normalizeStatus(sourceRun.status))) {
      throw new Error(`Source run ${sourceRunId} is missing or not terminal`);
    }
    if (!hasFrozenEvidence(sourceRun)) {
      throw new Error(`Source run ${sourceRunId} does not contain frozen evidence`);
    }
  } else {
    const sourceCreated = await client.createRun({
      question: normalizedQuestion,
      preparationProvider: SOURCE_CONFIGURATION.provider,
      preparationModel: SOURCE_CONFIGURATION.model,
      preparationReasoningMode: SOURCE_CONFIGURATION.reasoningMode,
      preparationReasoningEffort: SOURCE_CONFIGURATION.reasoningEffort,
      ...SOURCE_CONFIGURATION,
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
  }
  const sourceResult = summarizeRun({
    role: "source",
    configuration: SOURCE_CONFIGURATION,
    run: sourceRun,
  });

  const forkConfigurations = normalizedConfigurations.filter((configuration) => (
    configurationKey(configuration) !== configurationKey(SOURCE_CONFIGURATION)
  ));
  const forkResults = await mapLimit(forkConfigurations, concurrency, async (configuration, index) => {
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
      return summarizeRun({ role: "fork", configuration, run });
    } catch (error) {
      return summarizeFailure(configuration, error);
    }
  });

  const endedAt = now();
  return {
    schemaVersion: 1,
    question: normalizedQuestion,
    sourceRunId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    availableModels: [...availableModels.values()].map((entry) => ({
      provider: entry.provider,
      model: entry.model,
    })),
    results: [sourceResult, ...forkResults],
  };
}

export function createAdminModelLabHttpClient({
  baseUrl,
  origin,
  password,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const root = new URL(requiredText(baseUrl, "baseUrl"));
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
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) }),
    });
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
    const providerAvailable = providerEntry?.available !== false;
    for (const modelEntry of Array.isArray(providerEntry?.models) ? providerEntry.models : []) {
      const model = String(
        typeof modelEntry === "string"
          ? modelEntry
          : modelEntry?.modelId || modelEntry?.id || modelEntry?.model || "",
      ).trim();
      const descriptor = typeof modelEntry === "string" ? {} : modelEntry;
      if (!provider || !model || !providerAvailable || descriptor?.available === false) continue;
      result.set(model, {
        provider,
        model,
        supportedReasoningModes: arrayOrEmpty(descriptor?.supportedReasoningModes),
        supportedReasoningEfforts: arrayOrEmpty(descriptor?.supportedReasoningEfforts),
      });
    }
  }

  // Older test or self-hosted deployments may expose only a flat model table.
  if (result.size === 0 && source.models && typeof source.models === "object") {
    for (const [model, descriptor] of Object.entries(source.models)) {
      if (!descriptor || descriptor.available === false) continue;
      const provider = String(descriptor.providerId || descriptor.provider || "").trim().toLowerCase();
      if (!provider) continue;
      result.set(model, {
        provider,
        model,
        supportedReasoningModes: arrayOrEmpty(descriptor.supportedReasoningModes),
        supportedReasoningEfforts: arrayOrEmpty(descriptor.supportedReasoningEfforts),
      });
    }
  }
  return result;
}

export function formatMatrixMarkdown(report) {
  const lines = [
    "# 管理实验室模型矩阵",
    "",
    `- 问题：${escapeMarkdown(report.question)}`,
    `- 源运行：${escapeMarkdown(report.sourceRunId)}`,
    `- 总耗时：${formatDuration(report.durationMs)}`,
    "",
    "| 配置 | 状态 | 裁定 | 总耗时 | 最终裁定耗时 | Token | 费用 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const item of report.results || []) {
    const config = item.configuration || {};
    lines.push(`| ${escapeMarkdown(`${config.model} / ${config.reasoningMode} / ${config.reasoningEffort}`)} | ${escapeMarkdown(item.status)} | ${escapeMarkdown(item.conciseAnswer || item.error?.message || "-")} | ${formatDuration(item.metrics?.totalDurationMs)} | ${formatDuration(item.metrics?.finalRulingMs)} | ${escapeMarkdown(formatTokens(item.metrics?.tokenUsage))} | ${escapeMarkdown(formatCost(item.metrics?.cost))} |`);
    if (Array.isArray(item.verdicts) && item.verdicts.length) {
      lines.push(`| ↳ verdict |  | ${escapeMarkdown(item.verdicts.map((verdict) => `${verdict.questionId}: ${verdict.value}`).join("; "))} |  |  |  |  |`);
    }
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
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.configurations.length) delete options.configurations;
  if (!["json", "markdown"].includes(options.format)) {
    throw new Error("--format must be json or markdown");
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseMatrixArguments(argv);
  if (options.help) {
    process.stdout.write(usageText());
    return 0;
  }
  const password = env.ADMIN_MODEL_LAB_PASSWORD || env.ADMIN_PASSWORD || await promptSecret("管理密码：");
  const question = options.question || (options.questionFile
    ? await readFile(options.questionFile, "utf8")
    : "");
  let configurations = options.configurations;
  if (options.configurationFile) {
    const parsed = JSON.parse(await readFile(options.configurationFile, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("--config-file must contain a JSON array");
    configurations = parsed;
  }
  const report = await runAdminModelMatrix({
    ...options,
    baseUrl: options.baseUrl || env.ADMIN_MODEL_LAB_BASE_URL,
    origin: options.origin || env.ADMIN_MODEL_LAB_ORIGIN,
    question,
    password,
    ...(configurations ? { configurations } : {}),
  });
  const output = options.format === "markdown"
    ? formatMatrixMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(options.output, output, "utf8");
  else process.stdout.write(output);
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

function summarizeRun({ role, configuration, run }) {
  const finalRuling = run?.result?.finalRuling || run?.result?.ruling || run?.result?.output || null;
  const latency = run?.result?.latency || run?.result?.metrics?.latency || run?.metrics?.latency || {};
  const metering = run?.result?.metering || {};
  const usage = metering?.totals?.usage || run?.result?.metrics?.usage || run?.result?.usage || null;
  const cost = metering?.totals?.cost || run?.result?.metrics?.cost || run?.result?.cost || null;
  return {
    role,
    runId: extractRunId(run),
    status: normalizeStatus(run?.status) || "UNKNOWN",
    configuration: { ...configuration },
    conciseAnswer: String(finalRuling?.conciseAnswer || ""),
    verdicts: Array.isArray(finalRuling?.verdicts) ? finalRuling.verdicts : [],
    timeline: Array.isArray(finalRuling?.timeline) ? finalRuling.timeline : [],
    metrics: {
      totalDurationMs: firstFinite(latency.totalWallClockMs, latency.totalMs, run?.durationMs),
      finalRulingMs: firstFinite(latency.finalRulingMs),
      tokenUsage: usage,
      cost,
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
    conciseAnswer: "",
    verdicts: [],
    timeline: [],
    metrics: emptyMetrics(),
    error: normalizeError(error),
  };
}

function emptyMetrics() {
  return { totalDurationMs: null, finalRulingMs: null, tokenUsage: null, cost: null };
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
    if (features[name] === false) throw new Error(`Admin lab capability is unavailable: ${name}`);
  }
}

function dedupeConfigurations(configurations) {
  if (!Array.isArray(configurations)) throw new TypeError("configurations must be an array");
  const result = new Map();
  for (const value of configurations) {
    const normalized = normalizeConfiguration(value);
    result.set(configurationKey(normalized), normalized);
  }
  if (!result.has(configurationKey(SOURCE_CONFIGURATION))) {
    result.set(configurationKey(SOURCE_CONFIGURATION), { ...SOURCE_CONFIGURATION });
  }
  return [...result.values()];
}

function normalizeConfiguration(value = {}) {
  return {
    provider: requiredText(value.provider, "configuration.provider").toLowerCase(),
    model: requiredText(value.model, "configuration.model"),
    reasoningMode: requiredText(value.reasoningMode || value.mode, "configuration.reasoningMode").toLowerCase(),
    reasoningEffort: requiredText(value.reasoningEffort || value.effort, "configuration.reasoningEffort").toLowerCase(),
  };
}

function parseConfiguration(text) {
  const [provider, model, reasoningMode, reasoningEffort, ...extra] = String(text || "").split(":");
  if (extra.length || !provider || !model || !reasoningMode || !reasoningEffort) {
    throw new Error("--config must be provider:model:reasoningMode:reasoningEffort");
  }
  return normalizeConfiguration({ provider, model, reasoningMode, reasoningEffort });
}

function configurationKey(configuration) {
  return [
    configuration.provider,
    configuration.model,
    configuration.reasoningMode,
    configuration.reasoningEffort,
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
  if (error && typeof error === "object" && !(error instanceof Error)) {
    return {
      code: String(error.code || error.error || "admin_matrix_run_failed"),
      message: String(error.message || error.detail || error.code || "run failed"),
    };
  }
  return {
    code: String(error?.code || "admin_matrix_request_failed"),
    message: String(error?.message || error || "request failed"),
  };
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

function formatDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number / 1_000).toFixed(2)}s` : "-";
}

function formatTokens(value) {
  if (!value || typeof value !== "object") return "-";
  const total = firstFinite(value.totalTokens, value.total_tokens, value.inputTokens + value.outputTokens);
  return total === null ? "-" : String(total);
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
  return `用法：node scripts/admin-model-matrix.mjs --base-url URL --origin ORIGIN --question "问题" [选项]\n\n` +
    `密码从 ADMIN_MODEL_LAB_PASSWORD（或 ADMIN_PASSWORD）读取；未设置时在 TTY 中隐藏输入。\n` +
    `--source-run-id ID 复用已有冻结证据，不再创建源运行。\n` +
    `--config provider:model:reasoningMode:reasoningEffort 可重复指定。\n` +
    `--config-file FILE 读取配置 JSON 数组。\n` +
    `--format json|markdown  --output FILE  --concurrency N（默认 1）\n`;
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
