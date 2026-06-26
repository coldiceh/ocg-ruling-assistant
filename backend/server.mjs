import { createServer } from "node:http";
import { answerQuestion, getDataHealth } from "./engine.mjs";
import { appendFeedbackCase } from "./feedbackCases.mjs";

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

  if (request.method === "POST" && request.url === "/api/answer") {
    try {
      const body = await readBody(request);
      const answer = await answerQuestion(JSON.parse(body || "{}"));
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
