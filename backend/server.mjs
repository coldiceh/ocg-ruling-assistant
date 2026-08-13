import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeBudgetResetRequest, budgetResetTokenConfigured } from "./budgetAuth.mjs";
import { checkDataHealth } from "./dataHealth.mjs";
import {
  capPublicChatGptBudget,
  getRagBudgetStatus,
  resetRagBudget,
} from "./ragModelClient.mjs";
import { getOcgEngineHealth } from "./ocgEngineClient.mjs";
import { getFormalEngineCapabilities } from "./formalEngineClient.mjs";
import { formalShadowEnabled } from "./formalEngineShadow.mjs";
import {
  answerPublicRulingQuestion,
  createPublicAnswerAbortContext,
  getPublicAnswerModelInfo,
  parsePublicAnswerPayload,
  persistPublicAnswerLatency,
  PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES,
  publicAnswerHttpError,
} from "./publicAnswerService.mjs";
import { readRequestBody as readBody } from "./requestBodyReader.mjs";

const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || "127.0.0.1").trim();
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const ADMIN_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const startupDataHealth = await checkDataHealth(join(projectRoot, "data"));
const adminApiPaths = new Set([
  "/api/admin-auth",
  "/api/admin-model-lab",
  "/api/admin-queries",
]);
let localAdminHandlersPromise;

if (!startupDataHealth.usable) {
  console.error("数据源未初始化，请先运行 node scripts/sync-data.mjs");
}

const server = createServer(async (request, response) => {
  const pathname = requestPathname(request);
  if (adminApiPaths.has(pathname)) {
    const adminHandler = (await getLocalAdminHandlers()).get(pathname);
    await handleNodeAdminApi({ request, response, handler: adminHandler });
    return;
  }

  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, startupDataHealth.usable ? 200 : 503, { ok: startupDataHealth.usable, data: startupDataHealth });
    return;
  }

  if (request.method === "GET" && request.url === "/api/engine") {
    const health = await getOcgEngineHealth({ env: process.env });
    const formal = formalShadowEnabled(process.env)
      ? await getFormalEngineCapabilities({ env: process.env })
      : { status: "disabled", capabilities: null, error: null };
    sendJson(response, health.ok ? 200 : 503, { ...health, formal });
    return;
  }

  if (request.method === "GET" && request.url === "/api/answer") {
    sendJson(response, 200, await getPublicAnswerModelInfo({ env: process.env }));
    return;
  }

  if (request.method === "GET" && request.url === "/api/budget") {
    const status = await getRagBudgetStatus({ env: process.env });
    sendJson(response, 200, {
      ...status,
      resetEnabled: budgetResetTokenConfigured(process.env) && status.budgetStorage !== "unconfigured",
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/budget") {
    const body = await readJsonBody(request);
    const auth = authorizeBudgetResetRequest(request, { env: process.env, body });
    if (!auth.ok) {
      sendJson(response, auth.status, { ok: false, error: auth.error, message: auth.message });
      return;
    }
    const action = String(body.action || "reset").trim().toLowerCase();
    if (action === "cap_public_chatgpt") {
      sendJson(response, 200, await capPublicChatGptBudget({ env: process.env }));
      return;
    }
    if (action !== "reset") {
      sendJson(response, 400, { ok: false, error: "budget_action_invalid" });
      return;
    }
    sendJson(response, 200, await resetRagBudget({ env: process.env }));
    return;
  }

  if (request.method === "POST" && request.url === "/api/answer") {
    const requestAbort = createPublicAnswerAbortContext(request, response);
    try {
      const body = await readBody(request, {
        maxBytes: PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES,
      });
      const payload = parsePublicAnswerPayload(body);
      const result = await answerPublicRulingQuestion({
        payload,
        env: process.env,
        signal: requestAbort.signal,
      });
      sendJson(response, 200, result.answer);
      // sendJson ends the HTTP response before this best-effort persistence.
      // Redis failure therefore cannot delay or replace a successful answer.
      await persistPublicAnswerLatency({
        latency: result.latency,
        env: process.env,
      }).catch(() => null);
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      const httpError = publicAnswerHttpError(error);
      sendJson(response, httpError.statusCode, httpError.payload);
    } finally {
      requestAbort.cleanup();
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, host, () => {
  console.log(`OCG ruling backend listening on http://${host}:${port}`);
});

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-budget-reset-password,x-budget-reset-token");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
async function readJsonBody(request) {
  try {
    return JSON.parse(await readBody(request) || "{}");
  } catch {
    return {};
  }
}

async function handleNodeAdminApi({ request, response, handler }) {
  response.status = (statusCode) => {
    response.statusCode = Number(statusCode) || 500;
    return response;
  };
  response.json = (payload) => {
    if (!response.getHeader("content-type")) {
      response.setHeader("content-type", "application/json; charset=utf-8");
    }
    response.end(JSON.stringify(payload));
    return response;
  };
  try {
    if (request.method === "POST") {
      request.body = await readBody(request, {
        maxBytes: ADMIN_REQUEST_BODY_LIMIT_BYTES,
      });
    }
    await handler(request, response);
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    if (error?.code === "request_body_too_large") {
      response.setHeader("connection", "close");
      const destroyRequest = () => {
        if (!request.destroyed && typeof request.destroy === "function") request.destroy();
      };
      if (typeof response.once === "function") {
        response.once("finish", destroyRequest);
        response.once("close", destroyRequest);
      }
      sendJson(response, 413, {
        ok: false,
        error: "admin_request_body_too_large",
      });
      if (typeof response.once !== "function") destroyRequest();
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: "admin_api_internal_error",
    });
  }
}

function getLocalAdminHandlers() {
  localAdminHandlersPromise ||= createLocalAdminHandlers();
  return localAdminHandlersPromise;
}

async function createLocalAdminHandlers() {
  const [
    { createAdminAuthHandler },
    { createProductionAdminModelLabHandler },
    { createAdminQueriesHandler },
    { createAdminSessionManager },
    {
      createAdminModelLabDevelopmentService,
    },
  ] = await Promise.all([
    import("../api/admin-auth.js"),
    import("../api/admin-model-lab.js"),
    import("../api/admin-queries.js"),
    import("./adminSession.mjs"),
    import("./adminModelLabProduction.mjs"),
  ]);
  const allowLocalMemoryStore = (
    String(process.env.NODE_ENV || "development").trim().toLowerCase() !== "production"
    && !/^(?:1|true|yes|on)$/iu.test(String(process.env.VERCEL || "").trim())
    && /^(?:127(?:\.\d{1,3}){3}|::1|localhost)$/iu.test(host)
  );
  const localAdminEnv = {
    ...process.env,
    ADMIN_SESSION_STORAGE: process.env.ADMIN_SESSION_STORAGE
      || (allowLocalMemoryStore ? "memory" : "redis"),
  };
  const shared = {
    env: localAdminEnv,
    fetchImpl: globalThis.fetch,
    manager: createAdminSessionManager({
      env: localAdminEnv,
      fetchImpl: globalThis.fetch,
      // The long-lived local Node process owns this one shared in-memory
      // manager. Serverless handlers still require the configured durable
      // store and do not inherit this development-only fallback.
      allowMemoryStore: allowLocalMemoryStore,
    }),
  };
  const useLocalEphemeralModelLab = allowLocalMemoryStore
    && !String(process.env.ADMIN_RUN_STORAGE || "").trim()
    && !String(process.env.ADMIN_LAB_RECORD_STORAGE || "").trim();
  return new Map([
    ["/api/admin-auth", createAdminAuthHandler(shared)],
    ["/api/admin-model-lab", createProductionAdminModelLabHandler({
      ...shared,
      productionFactory: useLocalEphemeralModelLab
        ? createAdminModelLabDevelopmentService
        : undefined,
    })],
    ["/api/admin-queries", createAdminQueriesHandler(shared)],
  ]);
}

function requestPathname(request) {
  try {
    return new URL(String(request?.url || "/"), "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}
