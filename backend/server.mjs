import { createServer } from "node:http";
import { authorizeBudgetResetRequest, budgetResetTokenConfigured } from "./budgetAuth.mjs";
import { getDataHealth } from "./engine.mjs";
import { appendFeedbackCase } from "./feedbackCases.mjs";
import {
  createPublicAnswerModelEnv,
  getRagBudgetStatus,
  resetRagBudget,
  resolveCardExtractionProvider,
  resolveRagProvider,
} from "./ragModelClient.mjs";
import {
  assertPublicRulingModelProfileAvailable,
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from "./publicRulingModelConfig.mjs";
import { getOcgEngineHealth, requestOcgEngineSimulation } from "./ocgEngineClient.mjs";
import { getFormalEngineCapabilities } from "./formalEngineClient.mjs";
import { formalShadowEnabled } from "./formalEngineShadow.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "./legacyLuaSemanticProduction.mjs";
import {
  publicAnswerLatencyStorageStatus,
  readPublicAnswerLatencyProfiles,
  recordPublicAnswerLatency,
} from "./publicAnswerLatencyStore.mjs";
import { appendQueryAudit } from "./queryAuditStore.mjs";
import {
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
} from "./rulingVersionRegistry.mjs";
import { readRequestBody as readBody } from "./requestBodyReader.mjs";

const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || "127.0.0.1").trim();
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const ADMIN_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
const startupDataHealth = await getDataHealth();
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
    sendJson(response, 200, await getModelInfo());
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
    sendJson(response, 200, await resetRagBudget({ env: process.env }));
    return;
  }

  if (request.method === "POST" && request.url === "/api/engine") {
    const payload = await readJsonBody(request);
    const result = await requestOcgEngineSimulation({
      engineScenario: payload.engineScenario ?? payload.scenario,
      env: process.env,
    });
    sendJson(response, result.status === "completed" ? 200 : 503, result);
    return;
  }

  if (request.method === "POST" && request.url === "/api/answer") {
    let auditPromise = Promise.resolve();
    let answerStartedAt = 0;
    let selectedProfileId = "";
    const requestAbort = createRequestAbortContext(request, response);
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const mode = String(payload.mode || "rag").toLowerCase();
      if (mode !== "rag") {
        const error = new Error("Only the evidence-grounded RAG answer mode is public");
        error.statusCode = 400;
        error.code = "unsupported_answer_mode";
        throw error;
      }
      const profile = resolvePublicRulingModelProfile(payload.rulingModelProfile);
      assertPublicRulingModelProfileAvailable(profile, process.env);
      selectedProfileId = profile.id;
      const publicEnv = createPublicAnswerModelEnv(process.env, profile.id);
      const legacyLuaSemanticPacketFactory =
        createConfiguredLegacyLuaSemanticPacketFactory({ env: publicEnv });
      auditPromise = appendQueryAudit({
        question: payload.question,
        mode,
        env: publicEnv,
      }).catch(() => null);
      answerStartedAt = Date.now();
      const answer = await answerRagRulingQuestionForVersion({
        rulingVersion: payload.rulingVersion,
        question: payload.question,
        env: publicEnv,
        engineScenario: payload.engineScenario,
        legacyLuaSemanticPacketFactory,
        signal: requestAbort.signal,
      });
      await auditPromise;
      const durationMs = Math.max(0, Date.now() - answerStartedAt);
      sendJson(response, 200, answer);
      // sendJson ends the HTTP response before this best-effort persistence.
      // Redis failure therefore cannot delay or replace a successful answer.
      await recordPublicAnswerLatency({
        profileId: selectedProfileId,
        durationMs,
        env: process.env,
      }).catch(() => null);
    } catch (error) {
      await auditPromise;
      if (requestAbort.signal.aborted) return;
      sendJson(response, [400, 503].includes(error?.statusCode) ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "answer_failed",
      });
    } finally {
      requestAbort.cleanup();
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/feedback") {
    try {
      const body = await readBody(request);
      const feedbackCase = await appendFeedbackCase(JSON.parse(body || "{}"));
      sendJson(response, 200, {
        ok: true,
        feedbackCase,
        message: "反馈已记录。它不会立即改变裁定结论；确认后会转成回归测试。",
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
function createRequestAbortContext(request, response) {
  if (request?.signal && typeof request.signal.aborted === "boolean") {
    return { signal: request.signal, cleanup() {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!response?.writableEnded && !response?.finished) abort();
  };
  request?.once?.("aborted", abort);
  response?.once?.("close", close);
  return {
    signal: controller.signal,
    cleanup() {
      request?.off?.("aborted", abort);
      response?.off?.("close", close);
    },
  };
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

async function getModelInfo() {
  const modelCapabilities = getPublicRulingModelCapabilities(process.env);
  const availableProfileIds = modelCapabilities.rulingModelProfiles
    .filter((profile) => profile.available)
    .map((profile) => profile.id);
  const latencyStorage = publicAnswerLatencyStorageStatus(process.env);
  const latencyResult = await readPublicAnswerLatencyProfiles({
    profileIds: availableProfileIds,
    env: process.env,
  }).catch(() => ({ profiles: [] }));
  const latencyByProfile = new Map(
    (latencyResult.profiles || []).map((item) => [item.profileId, item]),
  );
  const rulingModelProfiles = modelCapabilities.rulingModelProfiles.map((profile) => ({
    ...profile,
    ...(profile.available ? { answerLatency: latencyByProfile.get(profile.id) || null } : {}),
  }));
  const publicEnv = createPublicAnswerModelEnv(process.env, modelCapabilities.defaultRulingModelProfile);
  const ragProvider = resolveRagProvider(publicEnv);
  const cardProvider = resolveCardExtractionProvider(publicEnv);
  const budget = await getRagBudgetStatus({ env: publicEnv }).catch(() => null);
  const engineEnabled = !/^(?:0|false|off|disabled|no)$/iu.test(
    String(publicEnv.RAG_AUTO_ENGINE_SIMULATION ?? "true").trim(),
  ) && Boolean(String(publicEnv.OCG_ENGINE_URL || "").trim());
  const rulingVersionCapabilities = getRulingVersionCapabilities();
  return {
    ...rulingVersionCapabilities,
    ...modelCapabilities,
    rulingModelProfiles,
    answerLatency: {
      ...latencyStorage,
      profiles: latencyResult.profiles || [],
    },
    provider: "glm",
    requestedProvider: ragProvider.requested,
    models: rulingModelProfiles.map((profile) => profile.model),
    cardNameProvider: cardProvider.provider,
    cardNameModels: [publicEnv.DEEPSEEK_CARD_MODEL || "deepseek-v4-flash"],
    modelTiers: [],
    budget,
    engineEnabled,
    enabled: rulingModelProfiles.some((profile) => profile.available),
    pipeline: "rag_baseline",
    legacyModes: [],
  };
}
