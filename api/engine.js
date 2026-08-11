import { getOcgEngineHealth } from "../backend/ocgEngineClient.mjs";
import { getFormalEngineCapabilities } from "../backend/formalEngineClient.mjs";
import { formalShadowEnabled } from "../backend/formalEngineShadow.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method === "GET") {
    const health = await getOcgEngineHealth({ env: process.env });
    const formal = formalShadowEnabled(process.env)
      ? await getFormalEngineCapabilities({ env: process.env })
      : { status: "disabled", capabilities: null, error: null };
    response.status(health.ok ? 200 : 503).json({ ...health, formal });
    return;
  }
  response.status(405).json({ error: "Method not allowed" });
}
