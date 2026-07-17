import { createServer } from "node:http";
import { authorizeAdminRequest } from "./adminAuth.mjs";
import { authorizeBudgetResetRequest, budgetResetTokenConfigured } from "./budgetAuth.mjs";
import { answerQuestion, getDataHealth } from "./engine.mjs";
import { answerRulingQuestionFast } from "./fastJudgeEngine.mjs";
import { appendFeedbackCase } from "./feedbackCases.mjs";
import { getRagBudgetStatus, resetRagBudget, resolveCardExtractionProvider, resolveRagProvider } from "./ragModelClient.mjs";
import { getOcgEngineHealth, requestOcgEngineSimulation } from "./ocgEngineClient.mjs";
import { appendQueryAudit, listQueryAudits } from "./queryAuditStore.mjs";
import { answerRagRulingQuestion } from "./ragRulingPipeline.mjs";

const port = Number(process.env.PORT || 8787);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const startupDataHealth = await getDataHealth();

if (!startupDataHealth.usable) {
  console.error("数据源未初始化，请先运行 node scripts/sync-data.mjs");
}

const server = createServer(async (request, response) => {
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
    sendJson(response, health.ok ? 200 : 503, health);
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

  if (request.method === "POST" && request.url === "/api/admin-queries") {
    const body = await readJsonBody(request);
    const auth = authorizeAdminRequest(request, { env: process.env, body });
    if (!auth.ok) {
      sendJson(response, auth.status, { ok: false, error: auth.error, message: auth.message });
      return;
    }
    try {
      sendJson(response, 200, {
        ok: true,
        ...await listQueryAudits({ limit: body.limit, env: process.env }),
      });
    } catch (error) {
      sendJson(response, 503, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const mode = String(payload.mode || "rag").toLowerCase();
      auditPromise = appendQueryAudit({
        question: payload.question,
        mode,
        env: process.env,
      }).catch(() => null);
      if (!["legacy", "fastjudge"].includes(mode)) {
        const answer = await answerRagRulingQuestion({
          question: payload.question,
          env: envForModelTier(process.env, payload.modelTier),
          engineScenario: payload.engineScenario,
        });
        await auditPromise;
        sendJson(response, 200, answer);
        return;
      }
      const useFastJudge = mode === "fastjudge";
      const answer = useFastJudge
        ? await answerRulingQuestionFast({
            question: payload.question,
            mode: "duel",
            maxLatencyMs: 6000,
            gameState: payload.gameState || {},
            chainLinks: Array.isArray(payload.chainLinks) ? payload.chainLinks : [],
          })
        : await answerQuestion(payload);
      await auditPromise;
      sendJson(response, 200, answer);
    } catch (error) {
      await auditPromise;
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
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

server.listen(port, () => {
  console.log(`OCG ruling backend listening on http://localhost:${port}`);
});

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-budget-reset-password,x-budget-reset-token,x-admin-token");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  try {
    return JSON.parse(await readBody(request) || "{}");
  } catch {
    return {};
  }
}

async function getModelInfo() {
  const ragProvider = resolveRagProvider(process.env);
  const cardProvider = resolveCardExtractionProvider(process.env);
  const budget = await getRagBudgetStatus({ env: process.env }).catch(() => null);
  if (ragProvider.provider === "deepseek") {
    return {
      provider: "deepseek",
      requestedProvider: ragProvider.requested,
      models: [process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"],
      cardNameProvider: cardProvider.provider,
      cardNameModels: [process.env.DEEPSEEK_CARD_MODEL || process.env.RAG_CARD_MODEL || "deepseek-v4-flash"],
      modelTiers: buildModelTiers("deepseek", process.env),
      budget,
      enabled: true,
      pipeline: "rag_baseline",
      legacyModes: ["legacy", "fastjudge"],
    };
  }
  if (ragProvider.provider === "gemini") {
    return {
      provider: "gemini",
      requestedProvider: ragProvider.requested,
      models: [process.env.GEMINI_MODEL || "gemini-1.5-flash"],
      cardNameProvider: cardProvider.provider,
      cardNameModels: splitList(process.env.GEMINI_CARD_MODEL || process.env.GEMINI_CARD_RESOLUTION_MODELS || process.env.GEMINI_CARD_RESOLUTION_MODEL || "gemini-1.5-flash"),
      modelTiers: buildModelTiers("gemini", process.env),
      budget,
      enabled: true,
      pipeline: "rag_baseline",
      legacyModes: ["legacy", "fastjudge"],
    };
  }
  return {
    provider: "mock",
    requestedProvider: ragProvider.requested,
    models: [],
    modelTiers: [],
    budget,
    enabled: false,
    pipeline: "rag_baseline",
    legacyModes: ["legacy", "fastjudge"],
  };
}

function envForModelTier(env, tier) {
  const normalized = normalizeModelTier(tier);
  return normalized ? { ...env, RAG_MODEL_TIER: normalized } : env;
}

function normalizeModelTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  return tier === "flash" || tier === "pro" ? tier : "";
}

function buildModelTiers(provider, env) {
  if (provider === "deepseek") {
    return [
      { id: "flash", label: "Flash", model: env.DEEPSEEK_FLASH_MODEL || env.DEEPSEEK_CARD_MODEL || env.RAG_CARD_MODEL || "deepseek-v4-flash" },
      { id: "pro", label: "Pro", model: env.DEEPSEEK_PRO_MODEL || env.DEEPSEEK_MODEL || "deepseek-v4-flash" },
    ];
  }
  if (provider === "gemini") {
    return [
      { id: "flash", label: "Flash", model: env.GEMINI_FLASH_MODEL || env.GEMINI_CARD_MODEL || "gemini-1.5-flash" },
      { id: "pro", label: "Pro", model: env.GEMINI_PRO_MODEL || env.GEMINI_MODEL || "gemini-1.5-flash" },
    ];
  }
  return [];
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
