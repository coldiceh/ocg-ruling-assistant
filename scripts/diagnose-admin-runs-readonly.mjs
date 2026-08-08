import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TERMINAL_STATUSES = new Set(["CANCELLED", "FAILED", "SUCCEEDED"]);
const READ_ACTIONS = new Set(["list", "run", "events"]);
const DEFAULT_START_UTC = "2026-08-08T01:51:00Z";
const DEFAULT_END_UTC = "2026-08-08T01:54:00Z";
const MAX_LIST_PAGES = 100;

/**
 * Strictly read-only post-mortem collection. The only POST is authentication;
 * every Model Lab request is a GET. Run details are terminal-only; events may
 * be replayed for any listed run because that endpoint does not reconcile.
 */
export async function diagnoseAdminRunsReadonly({
  client,
  startUtc = DEFAULT_START_UTC,
  endUtc = DEFAULT_END_UTC,
  now = () => new Date(),
} = {}) {
  if (!client || typeof client.listRuns !== "function") {
    throw new TypeError("a read-only admin diagnostics client is required");
  }
  const window = normalizeUtcWindow(startUtc, endUtc);
  const listed = await listAllRuns(client);
  const candidates = listed.filter((record) => overlapsWindow(record, window));

  const runs = [];
  for (const record of candidates) {
    const runId = requiredText(record?.runId || record?.id, "listed runId");
    const listedStatus = normalizeStatus(record?.status);
    let run = record;
    let detailSource = "list";
    if (TERMINAL_STATUSES.has(listedStatus)) {
      const envelope = await client.getTerminalRun(runId, listedStatus);
      run = envelope?.run || envelope?.record || envelope?.item || envelope;
      if (!TERMINAL_STATUSES.has(normalizeStatus(run?.status))) {
        throw new Error(`run ${runId} ceased to be terminal`);
      }
      detailSource = "terminal_run";
    }
    const events = await client.getListedRunEvents(runId);
    runs.push(projectRun(run, events, { detailSource }));
  }

  return {
    schemaVersion: 1,
    kind: "admin-run-readonly-diagnostics",
    generatedAt: now().toISOString(),
    zeroPaidOperations: true,
    allowedOperations: ["login", "GET list", "GET run (terminal only)", "GET events (listed runs only)"],
    forbiddenOperations: ["create", "fork", "execute", "cancel", "reconcile"],
    utcWindow: {
      start: window.startIso,
      end: window.endIso,
    },
    listedRunCount: listed.length,
    matchedRunCount: runs.length,
    matchedTerminalRunCount: runs.filter((run) => TERMINAL_STATUSES.has(run.status)).length,
    matchedNonTerminalRunCount: runs.filter((run) => !TERMINAL_STATUSES.has(run.status)).length,
    runs,
  };
}

export function createReadonlyAdminDiagnosticsClient({
  baseUrl,
  origin,
  password,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const root = normalizeBaseUrl(baseUrl);
  const requestOrigin = String(origin || root.origin).replace(/\/$/u, "");
  const adminPassword = requiredText(password, "password");
  let cookie = "";
  const listedRunIds = new Set();
  const terminalRunIds = new Set();

  async function login() {
    const response = await fetchImpl(new URL("/api/admin-auth", root), {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: requestOrigin,
      },
      body: JSON.stringify({ action: "login", password: adminPassword }),
    });
    rejectRedirect(response);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.authenticated !== true) {
      throw responseError(response, payload, "admin_readonly_login_failed");
    }
    cookie = extractCookie(response.headers);
    if (!cookie) throw new Error("admin login did not return a session cookie");
    return { authenticated: true };
  }

  async function readJson(action, query = {}) {
    assertReadonlyAction(action);
    if (!cookie) throw new Error("admin diagnostics client is not authenticated");
    const url = modelLabUrl(root, action, query);
    const response = await fetchImpl(url, readOptions(requestOrigin, cookie, "application/json"));
    rejectRedirect(response);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw responseError(response, payload, "admin_readonly_request_failed", action);
    }
    return payload?.data ?? payload;
  }

  async function readEvents(runId) {
    assertReadonlyAction("events");
    if (!cookie) throw new Error("admin diagnostics client is not authenticated");
    const url = modelLabUrl(root, "events", {
      runId: requiredText(runId, "runId"),
      afterSequence: 0,
      limit: 1000,
    });
    const response = await fetchImpl(url, readOptions(requestOrigin, cookie, "text/event-stream"));
    rejectRedirect(response);
    const text = await response.text();
    if (!response.ok) {
      let payload = {};
      try { payload = JSON.parse(text); } catch { /* bounded generic error */ }
      throw responseError(response, payload, "admin_readonly_events_failed", "events");
    }
    return parseSseEvents(text);
  }

  return Object.freeze({
    login,
    async listRuns({ limit = 100, cursor = null } = {}) {
      const page = await readJson("list", { limit, cursor });
      for (const record of extractRecords(page)) {
        const runId = String(record?.runId || record?.id || "").trim();
        if (runId) listedRunIds.add(runId);
        if (runId && TERMINAL_STATUSES.has(normalizeStatus(record?.status))) {
          terminalRunIds.add(runId);
        }
      }
      return page;
    },
    async getTerminalRun(runId, listedStatus) {
      const id = requiredText(runId, "runId");
      if (!TERMINAL_STATUSES.has(normalizeStatus(listedStatus)) || !terminalRunIds.has(id)) {
        throw new Error(`refusing GET run for non-terminal or unlisted run ${id}`);
      }
      return readJson("run", { runId: id });
    },
    async getListedRunEvents(runId) {
      const id = requiredText(runId, "runId");
      if (!listedRunIds.has(id)) {
        throw new Error(`refusing GET events for unlisted run ${id}`);
      }
      return readEvents(id);
    },
  });
}

export function assertReadonlyAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  if (!READ_ACTIONS.has(normalized)) {
    throw new Error(`forbidden admin diagnostics action: ${normalized || "empty"}`);
  }
  return normalized;
}

export function parseArguments(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    if (argument === "--start-utc") options.startUtc = take();
    else if (argument === "--end-utc") options.endUtc = take();
    else if (argument === "--output") options.output = take();
    else if (argument === "--base-url") options.baseUrl = take();
    else if (argument === "--origin") options.origin = take();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseArguments(argv);
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write("Usage: node scripts/diagnose-admin-runs-readonly.mjs --output FILE [--start-utc ISO --end-utc ISO]\n");
    return 0;
  }
  const output = requiredText(options.output, "--output");
  const client = (dependencies.createClient || createReadonlyAdminDiagnosticsClient)({
    baseUrl: options.baseUrl || env.ADMIN_MODEL_LAB_BASE_URL,
    origin: options.origin || env.ADMIN_MODEL_LAB_ORIGIN,
    password: requiredText(env.ADMIN_MODEL_LAB_PASSWORD, "ADMIN_MODEL_LAB_PASSWORD"),
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
  });
  await client.login();
  const report = await diagnoseAdminRunsReadonly({
    client,
    startUtc: options.startUtc || DEFAULT_START_UTC,
    endUtc: options.endUtc || DEFAULT_END_UTC,
    now: dependencies.now,
  });
  await (dependencies.writeFileImpl || writeFile)(output, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  stdout.write(`${JSON.stringify({ ok: true, output, matchedRunCount: report.matchedRunCount })}\n`);
  return 0;
}

async function listAllRuns(client) {
  const records = [];
  let cursor = null;
  const seen = new Set();
  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const page = await client.listRuns({ limit: 100, cursor });
    records.push(...extractRecords(page));
    const next = String(page?.nextCursor || "").trim();
    if (!next) return records;
    if (seen.has(next)) throw new Error("admin run list cursor repeated");
    seen.add(next);
    cursor = next;
  }
  throw new Error(`admin run list exceeded ${MAX_LIST_PAGES} pages`);
}

function projectRun(run, events, { detailSource } = {}) {
  const runId = requiredText(run?.runId || run?.id, "runId");
  return compact({
    runId,
    status: normalizeStatus(run?.status),
    detailSource: safeToken(detailSource),
    createdAt: safeIso(run?.createdAt),
    startedAt: safeIso(run?.startedAt),
    updatedAt: safeIso(run?.updatedAt),
    endedAt: safeIso(run?.endedAt),
    stages: projectStageTiming(run?.stageTiming || run?.stages),
    error: projectError(run?.error),
    providerSubmission: projectSubmission(run?.execution?.providerSubmission || run?.providerSubmission),
    repairSubmission: projectSubmission(run?.execution?.repairSubmission || run?.repairSubmission),
    events: (Array.isArray(events) ? events : []).map(projectEvent),
  });
}

function projectEvent(event) {
  const payload = event?.payload || {};
  return compact({
    sequence: safeInteger(event?.sequence),
    type: safeToken(event?.type),
    timestamp: safeIso(event?.timestamp),
    status: safeToken(event?.status),
    stageId: safeToken(payload?.stageId || payload?.stage),
    error: projectError(payload?.error),
    providerSubmission: projectSubmission(payload?.providerSubmission),
    completedAttempt: projectCompletedAttempt(payload?.completedAttempt),
  });
}

function projectStageTiming(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return compact({
    status: safeToken(value.status),
    createdAt: safeIso(value.createdAt),
    endedAt: safeIso(value.endedAt),
    totalElapsedMs: safeNumber(value.totalElapsedMs),
    durationMs: safeNumber(value.durationMs),
    stages: Array.isArray(value.stages) ? value.stages.map(projectStage) : [],
  });
}

function projectStage(value) {
  return compact({
    id: safeToken(value?.id),
    status: safeToken(value?.status),
    startedAt: safeIso(value?.startedAt),
    endedAt: safeIso(value?.endedAt),
    durationMs: safeNumber(value?.durationMs),
    speedLabel: safeToken(value?.speedLabel),
    substages: Array.isArray(value?.substages) ? value.substages.map(projectStage) : [],
  });
}

function projectError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return compact({
    code: safeToken(value.code || value.error),
    status: safeNumber(value.status),
    stage: safeToken(value.stage),
    provider: safeToken(value.provider),
    requestId: safeToken(value.requestId),
    requestedModel: safeToken(value.requestedModel),
    submittedModel: safeToken(value.submittedModel),
    reportedModel: safeToken(value.reportedModel),
    upstreamErrorCode: safeToken(value.upstreamErrorCode),
    upstreamCauseCode: safeToken(value.upstreamCauseCode),
    billingStatus: safeToken(value.billingStatus),
    outcomeKnown: typeof value.outcomeKnown === "boolean" ? value.outcomeKnown : null,
    failureMetering: projectFailureMetering(value.failureMetering),
    streamMetrics: projectStreamMetrics(value.streamMetrics),
  });
}

function projectCompletedAttempt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return compact({
    attemptKind: safeToken(value.attemptKind),
    providerId: safeToken(value.providerId),
    requestId: safeToken(value.requestId),
    model: safeToken(value.model),
    requestedModel: safeToken(value.requestedModel),
    submittedModel: safeToken(value.submittedModel),
    reportedModel: safeToken(value.reportedModel),
    status: safeToken(value.status),
    finishReason: safeToken(value.finishReason),
    usage: projectUsage(value.usage),
    cost: projectCost(value.cost),
    failureMetering: projectFailureMetering(value.failureMetering),
    streamMetrics: projectStreamMetrics(value.streamMetrics),
    error: projectError(value.error),
  });
}

function projectFailureMetering(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = safeToken(value.scope);
  if (scope !== "final_ruling_only") return null;
  return compact({
    scope,
    usage: projectUsage(value.usage),
    cost: projectCost(value.cost),
  });
}

function projectUsage(value) {
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
    const number = safeNumber(value[field]);
    if (number !== null) result[field] = number;
  }
  return Object.keys(result).length ? result : null;
}

function projectCost(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
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
    const text = safeToken(value[field]);
    if (text !== null) result[field] = text;
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
    const number = safeNumber(value[field]);
    if (number !== null) result[field] = number;
  }
  for (const field of ["pricingSourceVerified", "estimateOnly"]) {
    if (typeof value[field] === "boolean") result[field] = value[field];
  }
  return Object.keys(result).length ? result : null;
}

function projectStreamMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return compact({
    requestToFirstContentMs: safeNumber(value.requestToFirstContentMs),
    requestToCompleteMs: safeNumber(value.requestToCompleteMs),
    networkChunkCount: safeInteger(value.networkChunkCount),
    sseEventCount: safeInteger(value.sseEventCount),
    visibleContentBytes: safeInteger(value.visibleContentBytes),
    finishReason: safeToken(value.finishReason),
  });
}

function projectSubmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return compact({
    state: safeToken(value.state),
    attemptId: safeToken(value.attemptId),
    requestId: safeToken(value.requestId),
    intentAt: safeIso(value.intentAt),
    submittedAt: safeIso(value.submittedAt),
    acceptedAt: safeIso(value.acceptedAt),
    rejectedAt: safeIso(value.rejectedAt),
    outcomeUnknownAt: safeIso(value.outcomeUnknownAt),
    error: projectError(value.error),
  });
}

function overlapsWindow(record, window) {
  const start = firstTimestamp(record?.createdAt, record?.startedAt, record?.updatedAt, record?.endedAt);
  const end = lastTimestamp(record?.endedAt, record?.updatedAt, record?.startedAt, record?.createdAt);
  return start !== null && end !== null && start <= window.endMs && end >= window.startMs;
}

function normalizeUtcWindow(startValue, endValue) {
  const start = strictUtc(startValue, "startUtc");
  const end = strictUtc(endValue, "endUtc");
  if (start.ms > end.ms) throw new Error("startUtc must not be after endUtc");
  return { startMs: start.ms, endMs: end.ms, startIso: start.iso, endIso: end.iso };
}

function strictUtc(value, name) {
  const text = requiredText(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u.test(text)) {
    throw new Error(`${name} must be an ISO-8601 UTC timestamp ending in Z`);
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${name} is invalid`);
  return { ms, iso: new Date(ms).toISOString() };
}

function extractRecords(page) {
  const records = page?.records || page?.entries || page?.runs || [];
  if (!Array.isArray(records)) throw new Error("admin run list did not return an array");
  return records;
}

function modelLabUrl(root, action, query) {
  assertReadonlyAction(action);
  const url = new URL("/api/admin-model-lab", root);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

function readOptions(origin, cookie, accept) {
  return {
    method: "GET",
    cache: "no-store",
    redirect: "manual",
    headers: { accept, origin, cookie },
  };
}

function parseSseEvents(text) {
  const events = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sequence) events.push(parsed);
    } catch { /* Ignore keep-alive or malformed diagnostic-only frames. */ }
  }
  return events;
}

function normalizeBaseUrl(value) {
  const url = new URL(requiredText(value, "baseUrl"));
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Admin diagnostics requires HTTPS except for loopback");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function responseError(response, payload, fallback, action = "login") {
  const error = new Error(String(payload?.error || `${fallback}:${action}:HTTP_${response.status}`));
  error.code = payload?.error || fallback;
  error.status = response.status;
  return error;
}

function rejectRedirect(response) {
  if (response.status >= 300 && response.status < 400) throw new Error("admin diagnostics redirects are forbidden");
}

function extractCookie(headers) {
  const values = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : [];
  return String(values[0] || headers?.get?.("set-cookie") || "").split(";", 1)[0].trim();
}

function firstTimestamp(...values) {
  for (const value of values) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function lastTimestamp(...values) {
  return firstTimestamp(...values);
}

function safeIso(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function safeToken(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 240) : null;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === String(process.argv[1]).toLowerCase();
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || error?.message || error}\n`);
    process.exitCode = 1;
  });
}
