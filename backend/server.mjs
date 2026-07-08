import { createServer } from "node:http";
import { answerQuestion, getDataHealth } from "./engine.mjs";
import { answerRulingQuestionFast } from "./fastJudgeEngine.mjs";
import { appendFeedbackCase } from "./feedbackCases.mjs";
import { resolveRagProvider } from "./ragModelClient.mjs";
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

  if (request.method === "GET" && request.url === "/api/answer") {
    sendJson(response, 200, getModelInfo());
    return;
  }

  if (request.method === "POST" && request.url === "/api/answer") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const mode = String(payload.mode || "rag").toLowerCase();
      if (!["legacy", "fastjudge"].includes(mode)) {
        const answer = await answerRagRulingQuestion({ question: payload.question });
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
      sendJson(response, 200, answer);
    } catch (error) {
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
  response.setHeader("access-control-allow-headers", "content-type");
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

function getModelInfo() {
  const ragProvider = resolveRagProvider(process.env);
  if (ragProvider.provider === "deepseek") {
    return {
      provider: "deepseek",
      requestedProvider: ragProvider.requested,
      models: [process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"],
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
