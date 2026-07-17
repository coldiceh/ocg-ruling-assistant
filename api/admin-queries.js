import { authorizeAdminRequest } from "../backend/adminAuth.mjs";
import { listQueryAudits } from "../backend/queryAuditStore.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = parseBody(request.body);
  const auth = authorizeAdminRequest(request, { env: process.env, body });
  if (!auth.ok) {
    response.status(auth.status).json({ ok: false, error: auth.error, message: auth.message });
    return;
  }

  try {
    const result = await listQueryAudits({
      limit: body.limit,
      env: process.env,
    });
    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    response.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseBody(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-admin-token");
}