import { createAdminSessionManager } from "../backend/adminSession.mjs";
import {
  clearPublicOfftopicRiskControl,
  readPublicOfftopicRiskControl,
} from "../backend/publicOfftopicRiskControl.mjs";

let defaultHandler;

export function createAdminRiskControlHandler(options = {}) {
  const manager = options.manager || createAdminSessionManager(options);
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const readControl = options.readControl || readPublicOfftopicRiskControl;
  const unlockControl = options.unlockControl || clearPublicOfftopicRiskControl;

  return async function adminRiskControlHandler(request, response) {
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

    const method = String(request.method || "").toUpperCase();
    if (!["GET", "POST"].includes(method)) {
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

    const authorization = await manager.authorize({
      request,
      requireCsrf: method === "POST",
    });
    if (!authorization.ok) {
      response.status(authorization.status || 401).json({
        ok: false,
        error: authorization.error || "admin_session_required",
        ...(authorization.message ? { message: authorization.message } : {}),
      });
      return;
    }

    if (method === "GET") {
      const status = await readControl({ env, fetchImpl });
      respondWithStorageResult(response, status);
      return;
    }

    const body = parseBody(request.body);
    const action = String(body.action || "").trim().toLowerCase();
    if (action !== "unlock") {
      response.status(400).json({
        ok: false,
        error: "risk_control_action_invalid",
        message: "Invalid risk-control action.",
      });
      return;
    }
    const status = await unlockControl({ env, fetchImpl });
    respondWithStorageResult(response, status);
  };
}

export default async function handler(request, response) {
  defaultHandler ||= createAdminRiskControlHandler({
    env: globalThis.process?.env || {},
    fetchImpl: globalThis.fetch,
  });
  return defaultHandler(request, response);
}

function respondWithStorageResult(response, result) {
  if (result?.ok !== true) {
    response.status(503).json({
      ok: false,
      error: "offtopic_risk_control_storage_unavailable",
      failOpen: true,
      status: sanitizeStatus(result),
    });
    return;
  }
  response.status(200).json({
    ok: true,
    status: sanitizeStatus(result),
  });
}

function sanitizeStatus(result = {}) {
  return {
    active: result.active === true,
    ...(result.triggered !== undefined ? { triggered: result.triggered === true } : {}),
    ...(result.cleared !== undefined ? { cleared: result.cleared === true } : {}),
    failOpen: result.failOpen === true,
    storage: String(result.storage || "unavailable"),
    persistent: result.persistent === true,
    activatedAt: result.activatedAt || null,
    expiresAt: result.expiresAt || null,
    durationMinutes: nonNegativeInteger(result.durationMinutes),
    remainingMinutes: nonNegativeInteger(result.remainingMinutes),
    ...(result.reason ? { reason: String(result.reason) } : {}),
  };
}

function parseBody(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function setCors(response, origin) {
  if (origin) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-csrf-token");
  response.setHeader("vary", "Origin");
  response.setHeader("cache-control", "no-store");
}
