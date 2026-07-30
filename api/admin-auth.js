import {
  createAdminSessionManager,
} from "../backend/adminSession.mjs";

let defaultHandler;

export function createAdminAuthHandler(options = {}) {
  const manager = options.manager || createAdminSessionManager(options);

  return async function adminAuthHandler(request, response) {
    const origin = manager.checkOrigin(request);
    setCors(response, origin.ok ? origin.origin : "");

    if (request.method === "OPTIONS") {
      if (!origin.ok) {
        response.status(origin.status).json({
          ok: false,
          error: origin.error,
          message: origin.message,
        });
        return;
      }
      response.status(204).end();
      return;
    }

    if (!["GET", "POST"].includes(String(request.method || "").toUpperCase())) {
      response.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }
    if (!origin.ok) {
      response.status(origin.status).json({
        ok: false,
        error: origin.error,
        message: origin.message,
      });
      return;
    }

    const body = request.method === "POST" ? await readRequestBody(request) : {};
    const action = request.method === "GET"
      ? "session"
      : String(body.action || "").trim().toLowerCase();
    let result;
    if (action === "login") result = await manager.login({ request, body });
    else if (action === "session") result = await manager.session({ request });
    else if (action === "logout") result = await manager.logout({ request });
    else result = { ok: false, status: 400, error: "admin_auth_action_invalid", message: "Invalid admin auth action." };

    if (result.setCookie) response.setHeader("set-cookie", result.setCookie);
    if (result.clearCookie) response.setHeader("set-cookie", result.clearCookie);
    if (result.retryAfterSeconds) response.setHeader("retry-after", String(result.retryAfterSeconds));
    response.status(result.status || 500).json(publicResult(result));
  };
}

export default async function handler(request, response) {
  defaultHandler ||= createAdminAuthHandler({
    env: globalThis.process?.env || {},
    fetchImpl: globalThis.fetch,
  });
  return defaultHandler(request, response);
}

function publicResult(result) {
  return {
    ok: result.ok === true,
    authenticated: result.authenticated === true,
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    ...(result.csrfToken ? { csrfToken: result.csrfToken } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.message ? { message: result.message } : {}),
  };
}

function setCors(response, origin) {
  if (origin) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-csrf-token");
  response.setHeader("vary", "Origin");
  response.setHeader("cache-control", "no-store");
}

async function readRequestBody(request) {
  if (request?.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  if (typeof request?.json === "function") {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }
  const raw = typeof request?.body === "string" || Buffer.isBuffer(request?.body)
    ? String(request.body || "")
    : "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
