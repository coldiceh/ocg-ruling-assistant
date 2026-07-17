import { timingSafeEqual } from "node:crypto";

const ADMIN_PASSWORD_ENV = "API_ADMIN_PASSWORD";
const ADMIN_TOKEN_ENV = "API_ADMIN_TOKEN";
const FALLBACK_PASSWORD_ENV = "API_BUDGET_RESET_PASSWORD";
const FALLBACK_TOKEN_ENV = "API_BUDGET_RESET_TOKEN";

export function adminAccessConfigured(env = globalThis.process?.env || {}) {
  return Boolean(configuredSecret(env));
}

export function authorizeAdminRequest(request, {
  env = globalThis.process?.env || {},
  body = {},
} = {}) {
  const expected = configuredSecret(env);
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "admin_access_not_configured",
      message: "Admin access is disabled. Set " + ADMIN_PASSWORD_ENV + " or " + ADMIN_TOKEN_ENV + ".",
    };
  }

  const provided = readCredential(request, body);
  if (!provided) {
    return {
      ok: false,
      status: 401,
      error: "admin_authorization_required",
      message: "Admin authorization is required.",
    };
  }

  if (!secureEqual(provided, expected)) {
    return {
      ok: false,
      status: 403,
      error: "admin_authorization_invalid",
      message: "Admin authorization failed.",
    };
  }

  return { ok: true, status: 200 };
}

function configuredSecret(env) {
  return String(
    env[ADMIN_PASSWORD_ENV]
    || env[ADMIN_TOKEN_ENV]
    || env[FALLBACK_PASSWORD_ENV]
    || env[FALLBACK_TOKEN_ENV]
    || "",
  ).trim();
}

function readCredential(request, body = {}) {
  const authorization = readHeader(request, "authorization");
  const bearer = authorization.match(/^Bearer\s+(.+)$/iu)?.[1] || "";
  return String(
    bearer
    || readHeader(request, "x-admin-token")
    || body.password
    || body.adminPassword
    || body.adminToken
    || "",
  ).trim();
}

function readHeader(request, name) {
  if (!request?.headers) return "";
  if (typeof request.headers.get === "function") return String(request.headers.get(name) || "");
  const direct = request.headers[name] ?? request.headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}