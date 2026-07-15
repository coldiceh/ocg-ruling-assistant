import { getOcgEngineHealth, requestOcgEngineSimulation } from "../backend/ocgEngineClient.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method === "GET") {
    const health = await getOcgEngineHealth({ env: process.env });
    response.status(health.ok ? 200 : 503).json(health);
    return;
  }
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const payload = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
  const result = await requestOcgEngineSimulation({
    engineScenario: payload.engineScenario ?? payload.scenario,
    env: process.env,
  });
  response.status(result.status === "completed" ? 200 : 503).json(result);
}
