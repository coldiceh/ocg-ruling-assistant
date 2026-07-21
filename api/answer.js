import { answerQuestion } from "../backend/engine.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";
import { getRagBudgetStatus, resolveCardExtractionProvider, resolveRagProvider } from "../backend/ragModelClient.mjs";
import { appendQueryAudit } from "../backend/queryAuditStore.mjs";
import {
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
} from "../backend/rulingVersionRegistry.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method === "GET") {
    response.status(200).json(await getModelInfo());
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auditPromise = Promise.resolve();
  try {
    const payload = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const mode = String(payload.mode || "rag").toLowerCase();
    auditPromise = appendQueryAudit({
      question: payload.question,
      mode,
      env: process.env,
    }).catch(() => null);
    if (!["legacy", "fastjudge"].includes(mode)) {
      const answer = await answerRagRulingQuestionForVersion({
        rulingVersion: payload.rulingVersion,
        question: payload.question,
        env: envForModelTier(process.env, payload.modelTier),
        engineScenario: payload.engineScenario,
      });
      await auditPromise;
      response.status(200).json(answer);
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
    response.status(200).json({
      ...answer,
      requestedRulingVersion: null,
      effectiveRulingVersion: null,
      rulingVersion: null,
    });
  } catch (error) {
    await auditPromise;
    response.status(error?.statusCode === 400 ? 400 : 500).json({
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || "answer_failed",
    });
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

async function getModelInfo() {
  const ragProvider = resolveRagProvider(process.env);
  const cardProvider = resolveCardExtractionProvider(process.env);
  const budget = await getRagBudgetStatus({ env: process.env }).catch(() => null);
  const engineEnabled = !/^(?:0|false|off|disabled|no)$/iu.test(
    String(process.env.RAG_AUTO_ENGINE_SIMULATION ?? "true").trim(),
  ) && Boolean(String(process.env.OCG_ENGINE_URL || "").trim());
  const provider = ragProvider.provider;
  const rulingVersionCapabilities = getRulingVersionCapabilities();
  if (provider === "deepseek") {
    return {
      ...rulingVersionCapabilities,
      provider: "deepseek",
      requestedProvider: ragProvider.requested,
      models: [process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"],
      cardNameProvider: cardProvider.provider,
      cardNameModels: [process.env.DEEPSEEK_CARD_MODEL || process.env.RAG_CARD_MODEL || "deepseek-v4-flash"],
      modelTiers: buildModelTiers("deepseek", process.env),
      budget,
      engineEnabled,
      enabled: true,
      pipeline: "rag_baseline",
      legacyModes: ["legacy", "fastjudge"],
    };
  }

  if (provider === "gemini") {
    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    return {
      ...rulingVersionCapabilities,
      provider: "gemini",
      requestedProvider: ragProvider.requested,
      models: [model],
      cardNameProvider: cardProvider.provider,
      cardNameModels: splitList(process.env.GEMINI_CARD_MODEL || process.env.GEMINI_CARD_RESOLUTION_MODELS || process.env.GEMINI_CARD_RESOLUTION_MODEL || "gemini-1.5-flash"),
      modelTiers: buildModelTiers("gemini", process.env),
      budget,
      engineEnabled,
      enabled: true,
      pipeline: "rag_baseline",
      legacyModes: ["legacy", "fastjudge"],
    };
  }

  return {
    ...rulingVersionCapabilities,
    provider: "mock",
    requestedProvider: ragProvider.requested,
    models: [],
    modelTiers: [],
    budget,
    engineEnabled,
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
