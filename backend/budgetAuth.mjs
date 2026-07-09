import { timingSafeEqual } from "node:crypto";

const RESET_TOKEN_ENV = "API_BUDGET_RESET_TOKEN";
const RESET_PASSWORD_ENV = "API_BUDGET_RESET_PASSWORD";
const DEFAULT_RESET_PASSWORD = "allure";

export function budgetResetTokenConfigured(env = globalThis.process?.env || {}) {
  return Boolean(readConfiguredSecret(env));
}

export function authorizeBudgetResetRequest(request, { env = globalThis.process?.env || {}, body = null } = {}) {
  const configuredSecret = readConfiguredSecret(env);
  if (!configuredSecret) {
    return {
      ok: false,
      status: 403,
      error: "budget_reset_token_not_configured",
      message: `Budget reset is disabled. Set ${RESET_PASSWORD_ENV} or ${RESET_TOKEN_ENV} to enable owner-only reset.`,
    };
  }

  const providedSecret = readRequestSecret(request, body);
  if (!providedSecret) {
    return {
      ok: false,
      status: 401,
      error: "budget_reset_token_required",
      message: "Budget reset requires owner authorization.",
    };
  }

  if (!safeEqual(providedSecret, configuredSecret)) {
    return {
      ok: false,
      status: 403,
      error: "budget_reset_token_invalid",
      message: "Budget reset authorization failed.",
    };
  }

  return { ok: true, status: 200 };
}

function readConfiguredSecret(env) {
  return String(env?.[RESET_PASSWORD_ENV] || env?.[RESET_TOKEN_ENV] || DEFAULT_RESET_PASSWORD).trim();
}

function readRequestSecret(request, body) {
  const bearer = readHeader(request, "authorization").match(/^Bearer\s+(.+)$/iu)?.[1];
  return String(
    readBodySecret(body)
    || bearer
    || readHeader(request, "x-budget-reset-password")
    || readHeader(request, "x-budget-reset-token")
    || readHeader(request, "x-admin-token")
    || "",
  ).trim();
}

function readBodySecret(body) {
  if (!body || typeof body !== "object") return "";
  return String(body.password || body.resetPassword || body.token || body.adminToken || "").trim();
}

function readHeader(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
