import { answerQuestion } from "../backend/engine.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";
import { resolveRagProvider } from "../backend/ragModelClient.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method === "GET") {
    response.status(200).json(getModelInfo());
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const payload = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const mode = String(payload.mode || "rag").toLowerCase();
    if (!["legacy", "fastjudge"].includes(mode)) {
      const answer = await answerRagRulingQuestion({ question: payload.question });
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
    response.status(200).json(answer);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function getModelInfo() {
  const ragProvider = resolveRagProvider(process.env);
  const provider = ragProvider.provider;
  if (provider === "deepseek") {
    return {
      provider: "deepseek",
      requestedProvider: ragProvider.requested,
      models: [process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"],
      enabled: true,
      pipeline: "rag_baseline",
      legacyModes: ["legacy", "fastjudge"],
    };
  }

  if (provider === "gemini") {
    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    return {
      provider: "gemini",
      requestedProvider: ragProvider.requested,
      models: [model],
      cardResolutionModels: splitList(process.env.GEMINI_CARD_RESOLUTION_MODELS || process.env.GEMINI_CARD_RESOLUTION_MODEL),
      enabled: true,
      pipeline: "rag_baseline",
      legacyModes: ["legacy", "fastjudge"],
    };
  }

  return {
    provider: "mock",
    requestedProvider: ragProvider.requested,
    models: [],
    enabled: false,
    pipeline: "rag_baseline",
    legacyModes: ["legacy", "fastjudge"],
  };
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
