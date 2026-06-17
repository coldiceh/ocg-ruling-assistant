import { answerQuestion } from "../backend/engine.mjs";

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
    const answer = await answerQuestion(payload);
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
  const provider = String(process.env.MODEL_PROVIDER || "").toLowerCase() || inferProvider();
  if (provider === "gemini") {
    const models = splitList(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL);
    return {
      provider: "gemini",
      models,
      cardResolutionModels: splitList(process.env.GEMINI_CARD_RESOLUTION_MODELS || process.env.GEMINI_CARD_RESOLUTION_MODEL),
      enabled: Boolean(process.env.GEMINI_API_KEY && models.length),
    };
  }

  if (provider === "openai") {
    const models = splitList(process.env.OPENAI_MODEL);
    return {
      provider: "openai",
      models,
      enabled: Boolean(process.env.OPENAI_API_KEY && models.length),
    };
  }

  return {
    provider: provider || "none",
    models: [],
    enabled: false,
  };
}

function inferProvider() {
  if (process.env.GEMINI_API_KEY && (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL)) return "gemini";
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) return "openai";
  return "none";
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
