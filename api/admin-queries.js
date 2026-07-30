import { createAdminSessionManager } from "../backend/adminSession.mjs";
import { listQueryAudits } from "../backend/queryAuditStore.mjs";

let defaultHandler;

export function createAdminQueriesHandler(options = {}) {
  const manager = options.manager || createAdminSessionManager(options);
  const listQueries = options.listQueries || listQueryAudits;
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return async function adminQueriesHandler(request, response) {
    const origin = manager.checkOrigin(request);
    setCors(response, origin.ok ? origin.origin : "");

    if (request.method === "OPTIONS") {
      if (!origin.ok) {
        response.status(origin.status || 403).json({
          ok: false,
          error: origin.error || "admin_origin_forbidden",
          ...(origin.message ? { message: origin.message } : {}),
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
      response.status(origin.status || 403).json({
        ok: false,
        error: origin.error || "admin_origin_forbidden",
        ...(origin.message ? { message: origin.message } : {}),
      });
      return;
    }

    // This endpoint is read-only. Its legacy POST form is retained during the
    // UI migration, but neither method accepts a password in the request body.
    const auth = await manager.authorize({ request, requireCsrf: false });
    if (!auth.ok) {
      response.status(auth.status || 401).json({
        ok: false,
        error: auth.error || "admin_session_required",
        ...(auth.message ? { message: auth.message } : {}),
      });
      return;
    }

    const body = request.method === "POST" ? parseBody(request.body) : {};
    const query = parseRequestUrl(request).searchParams;
    try {
      const result = await listQueries({
        limit: body.limit ?? query.get("limit") ?? undefined,
        env,
        fetchImpl,
      });
      response.status(200).json({ ok: true, ...result });
    } catch {
      response.status(503).json({
        ok: false,
        error: "query_audit_storage_unavailable",
      });
    }
  };
}

export default async function handler(request, response) {
  defaultHandler ||= createAdminQueriesHandler({
    env: globalThis.process?.env || {},
    fetchImpl: globalThis.fetch,
  });
  return defaultHandler(request, response);
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

function parseRequestUrl(request) {
  try {
    return new URL(String(request?.url || "/api/admin-queries"), "https://admin.invalid");
  } catch {
    return new URL("https://admin.invalid/api/admin-queries");
  }
}

function setCors(response, origin) {
  if (origin) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-csrf-token");
  response.setHeader("vary", "Origin");
  response.setHeader("cache-control", "no-store");
}
