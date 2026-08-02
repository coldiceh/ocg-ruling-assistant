import { createAdminSessionManager } from "../backend/adminSession.mjs";
import {
  createAdminModelLabProductionService,
} from "../backend/adminModelLabProduction.mjs";

const GET_ACTIONS = new Set([
  "capabilities",
  "run",
  "list",
  "events",
  "export",
  "evaluation",
]);

const POST_ACTIONS = new Set([
  "create",
  "fork",
  "execute",
  "cancel",
  "rating",
]);

const TERMINAL_RUN_STATUSES = new Set([
  "CANCELLED",
  "SUCCEEDED",
  "FAILED",
]);
const MAX_ADMIN_MODEL_LAB_BODY_BYTES = 256 * 1024;

let defaultHandler;

/**
 * HTTP-only adapter for the admin model lab.
 *
 * Business behavior is deliberately injected through `service`. This route
 * owns authentication, request parsing, CORS, stable response envelopes and
 * SSE serialization; it does not invent an in-memory production service when
 * persistence or a lab capability has not been implemented.
 */
export function createAdminModelLabHandler(options = {}) {
  const manager = options.manager || createAdminSessionManager(options);
  const service = options.service || Object.freeze({});

  return async function adminModelLabHandler(request, response) {
    const method = String(request?.method || "").toUpperCase();
    const origin = manager.checkOrigin(request);
    setCors(response, origin.ok ? origin.origin : "");

    if (method === "OPTIONS") {
      if (!origin.ok) return sendAuthorizationFailure(response, origin);
      response.status(204).end();
      return;
    }

    if (!["GET", "POST"].includes(method)) {
      response.status(405).json({
        ok: false,
        error: "method_not_allowed",
      });
      return;
    }

    if (!origin.ok) return sendAuthorizationFailure(response, origin);

    const authorization = await manager.authorize({
      request,
      requireCsrf: method === "POST",
    });
    if (!authorization.ok) {
      return sendAuthorizationFailure(response, authorization);
    }

    try {
      const url = parseRequestUrl(request);
      const body = method === "POST" ? await readRequestBody(request) : {};
      const action = String(
        method === "GET"
          ? url.searchParams.get("action")
          : body.action,
      ).trim().toLowerCase();
      const allowedActions = method === "GET" ? GET_ACTIONS : POST_ACTIONS;
      if (!allowedActions.has(action)) {
        throw exposedError(400, "admin_model_lab_action_invalid");
      }

      const context = {
        request,
        authorization,
        action,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      };
      if (action === "events") {
        await handleEvents({ service, context, response });
        return;
      }

      const data = await dispatchJsonAction({ service, context });
      response.status(200).json({
        ok: true,
        action,
        data: data === undefined ? null : data,
      });
    } catch (error) {
      sendServiceError(response, error);
    }
  };
}

export default async function handler(request, response) {
  defaultHandler ||= createProductionAdminModelLabHandler({
    env: globalThis.process?.env || {},
    fetchImpl: globalThis.fetch,
  });
  return defaultHandler(request, response);
}

/**
 * Production entry point with a narrow server-owned dependency boundary.
 * Configuration failures are converted to an authenticated, generic 500
 * response by the normal route error path; they never fall back to memory.
 */
export function createProductionAdminModelLabHandler(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const manager = options.manager || createAdminSessionManager({
    env,
    fetchImpl,
  });
  let service = options.service;
  if (!service) {
    try {
      const productionFactory = options.productionFactory
        || createAdminModelLabProductionService;
      service = productionFactory({
        env,
        fetchImpl,
      });
    } catch (error) {
      service = unavailableProductionService(error);
    }
  }
  return createAdminModelLabHandler({
    manager,
    service,
  });
}

async function dispatchJsonAction({ service, context }) {
  const { action, body, query, request, authorization } = context;
  if (action === "capabilities") {
    return callService(service, "capabilities", {
      request,
      authorization,
    });
  }
  if (action === "run") {
    return callService(service, "getRun", {
      runId: requiredParameter(query.runId, "runId"),
      request,
      authorization,
    });
  }
  if (action === "list") {
    return callService(service, "listRuns", {
      limit: optionalPositiveInteger(query.limit, "limit"),
      cursor: optionalString(query.cursor),
      request,
      authorization,
    });
  }
  if (action === "export") {
    return callService(service, "exportRuns", {
      runId: optionalString(query.runId),
      format: optionalString(query.format) || "json",
      cursor: optionalString(query.cursor),
      request,
      authorization,
    });
  }
  if (action === "evaluation") {
    return callService(service, "getEvaluation", {
      runId: optionalString(query.runId),
      evaluationId: optionalString(query.evaluationId),
      limit: optionalPositiveInteger(query.limit, "limit"),
      cursor: optionalString(query.cursor),
      request,
      authorization,
    });
  }
  if (action === "create") {
    return callService(service, "createRun", {
      body: withoutAction(body),
      request,
      authorization,
    });
  }
  if (action === "fork") {
    requiredParameter(body.idempotencyKey, "idempotencyKey");
    return callService(service, "forkRun", {
      forkFromRunId: requiredParameter(body.forkFromRunId, "forkFromRunId"),
      body: withoutAction(body),
      request,
      authorization,
    });
  }
  if (action === "execute") {
    return callService(service, "executeRun", {
      runId: requiredParameter(body.runId, "runId"),
      body: withoutAction(body),
      request,
      authorization,
    });
  }
  if (action === "cancel") {
    return callService(service, "cancelRun", {
      runId: requiredParameter(body.runId, "runId"),
      body: withoutAction(body),
      request,
      authorization,
    });
  }
  if (action === "rating") {
    return callService(service, "saveRating", {
      runId: requiredParameter(body.runId, "runId"),
      rating: body.rating,
      notes: optionalString(body.notes),
      body: withoutAction(body),
      request,
      authorization,
    });
  }
  throw exposedError(400, "admin_model_lab_action_invalid");
}

async function handleEvents({ service, context, response }) {
  const runId = requiredParameter(context.query.runId, "runId");
  const headerSequence = readHeader(context.request, "last-event-id");
  const afterSequence = optionalNonNegativeInteger(
    context.query.afterSequence ?? headerSequence ?? "0",
    "afterSequence",
  ) ?? 0;
  const limit = optionalPositiveInteger(context.query.limit, "limit");
  const replay = await callService(service, "replayEvents", {
    runId,
    afterSequence,
    limit,
    request: context.request,
    authorization: context.authorization,
  });
  const normalized = normalizeReplay(replay, runId, afterSequence);

  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-store, no-transform");
  response.setHeader("x-accel-buffering", "no");
  if (typeof response.flushHeaders === "function") response.flushHeaders();

  writeSse(response, "retry: 1000\n\n");
  for (const event of normalized.events) {
    const sequence = requiredSequence(event.sequence);
    const eventName = safeSseEventName(event.type || "message");
    writeSse(response, `id: ${sequence}\n`);
    writeSse(response, `event: ${eventName}\n`);
    writeSse(response, `data: ${safeJson(event)}\n\n`);
  }

  if (normalized.terminal) {
    const lastSequence = normalized.events.length
      ? requiredSequence(normalized.events.at(-1).sequence)
      : normalized.nextAfterSequence;
    if (lastSequence > 0) writeSse(response, `id: ${lastSequence}\n`);
    writeSse(response, "event: end\n");
    writeSse(response, `data: ${safeJson({
      runId,
      status: normalized.status,
      terminal: true,
      nextAfterSequence: normalized.nextAfterSequence,
    })}\n\n`);
  }
  response.end();
}

async function callService(service, method, argument) {
  if (typeof service?.[method] !== "function") {
    throw exposedError(
      501,
      "admin_model_lab_capability_unavailable",
      `Admin model lab capability is unavailable: ${method}.`,
    );
  }
  return service[method](argument);
}

function normalizeReplay(value, runId, afterSequence) {
  const source = Array.isArray(value) ? { events: value } : (value || {});
  const events = Array.isArray(source.events) ? source.events : [];
  let previous = afterSequence;
  for (const event of events) {
    const sequence = requiredSequence(event?.sequence);
    if (sequence <= previous) {
      throw new TypeError("event sequence must be strictly increasing after afterSequence");
    }
    previous = sequence;
  }
  const nextAfterSequence = events.length
    ? requiredSequence(events.at(-1).sequence)
    : optionalNonNegativeInteger(source.nextAfterSequence, "nextAfterSequence") ?? afterSequence;
  const inferredStatus = String(
    source.status
      || source.run?.status
      || events.at(-1)?.status
      || "",
  ).toUpperCase();
  const terminal = source.terminal === true || TERMINAL_RUN_STATUSES.has(inferredStatus);
  return {
    events,
    nextAfterSequence,
    status: inferredStatus || null,
    terminal,
  };
}

function setCors(response, origin) {
  if (origin) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type,x-csrf-token,last-event-id",
  );
  response.setHeader("vary", "Origin");
  response.setHeader("cache-control", "no-store");
}

function sendAuthorizationFailure(response, result) {
  response.status(result.status || 403).json({
    ok: false,
    error: result.error || "admin_authorization_failed",
    ...(result.message ? { message: result.message } : {}),
  });
}

function sendServiceError(response, error) {
  if (error?.expose === true) {
    response.status(error.status || 400).json({
      ok: false,
      error: error.code || "admin_model_lab_request_invalid",
      ...(error.publicMessage ? { message: error.publicMessage } : {}),
    });
    return;
  }
  if (error?.code === "admin_run_not_found") {
    response.status(404).json({
      ok: false,
      error: "admin_run_not_found",
    });
    return;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    response.status(400).json({
      ok: false,
      error: "admin_model_lab_request_invalid",
    });
    return;
  }
  response.status(500).json({
    ok: false,
    error: "admin_model_lab_internal_error",
  });
}

function exposedError(status, code, publicMessage = "") {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.expose = true;
  error.publicMessage = publicMessage;
  return error;
}

function parseRequestUrl(request) {
  try {
    return new URL(String(request?.url || "/api/admin-model-lab"), "https://admin.invalid");
  } catch {
    return new URL("https://admin.invalid/api/admin-model-lab");
  }
}

async function readRequestBody(request) {
  if (request?.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    assertBodyWithinLimit(request.body);
    return request.body;
  }
  if (typeof request?.json === "function") {
    try {
      const parsed = await request.json();
      assertBodyWithinLimit(parsed);
      return parsed;
    } catch (error) {
      if (error?.expose === true) throw error;
      throw exposedError(400, "admin_model_lab_json_invalid");
    }
  }
  const raw = typeof request?.body === "string" || Buffer.isBuffer(request?.body)
    ? String(request.body || "")
    : "";
  if (!raw) return {};
  if (Buffer.byteLength(raw, "utf8") > MAX_ADMIN_MODEL_LAB_BODY_BYTES) {
    throw exposedError(413, "admin_model_lab_body_too_large");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw exposedError(400, "admin_model_lab_json_invalid");
  }
}

function assertBodyWithinLimit(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw exposedError(400, "admin_model_lab_json_invalid");
  }
  if (Buffer.byteLength(serialized || "", "utf8") > MAX_ADMIN_MODEL_LAB_BODY_BYTES) {
    throw exposedError(413, "admin_model_lab_body_too_large");
  }
}

function withoutAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { action: _action, ...rest } = value;
  return rest;
}

function requiredParameter(value, name) {
  const result = optionalString(value);
  if (!result) throw exposedError(400, `admin_model_lab_${name}_required`);
  return result;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw exposedError(400, `admin_model_lab_${name}_invalid`);
  }
  return number;
}

function optionalNonNegativeInteger(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw exposedError(400, `admin_model_lab_${name}_invalid`);
  }
  return number;
}

function requiredSequence(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("event sequence must be a positive safe integer");
  }
  return number;
}

function safeSseEventName(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.-]+$/u.test(text) ? text : "message";
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/gu, (character) => (
    character === "\u2028" ? "\\u2028" : "\\u2029"
  ));
}

function writeSse(response, value) {
  if (typeof response.write !== "function") {
    throw new TypeError("SSE response does not support write()");
  }
  response.write(value);
}

function readHeader(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}

function unavailableProductionService(configurationError) {
  const methods = [
    "capabilities",
    "createRun",
    "forkRun",
    "executeRun",
    "getRun",
    "cancelRun",
    "replayEvents",
    "listRuns",
    "saveRating",
    "exportRuns",
    "getEvaluation",
  ];
  return Object.freeze(Object.fromEntries(methods.map((method) => [
    method,
    async () => {
      throw configurationError;
    },
  ])));
}
