import { timingSafeEqual } from "node:crypto";

const RESET_TOKEN_ENV = "API_BUDGET_RESET_TOKEN";

export function budgetResetTokenConfigured(env = globalThis.process?.env || {}) {
  return Boolean(readConfiguredToken(env));
}

export function authorizeBudgetResetRequest(request, { env = globalThis.process?.env || {} } = {}) {
  const configuredToken = readConfiguredToken(env);
  if (!configuredToken) {
    return {
      ok: false,
      status: 403,
      error: "budget_reset_token_not_configured",
      message: `Budget reset is disabled. Set ${RESET_TOKEN_ENV} to enable owner-only reset.`,
    };
  }

  const providedToken = readRequestToken(request);
  if (!providedToken) {
    return {
      ok: false,
      status: 401,
      error: "budget_reset_token_required",
      message: "Budget reset requires owner authorization.",
    };
  }

  if (!safeEqual(providedToken, configuredToken)) {
    return {
      ok: false,
      status: 403,
      error: "budget_reset_token_invalid",
      message: "Budget reset authorization failed.",
    };
  }

  return { ok: true, status: 200 };
}

function readConfiguredToken(env) {
  return String(env?.[RESET_TOKEN_ENV] || "").trim();
}

function readRequestToken(request) {
  const bearer = readHeader(request, "authorization").match(/^Bearer\s+(.+)$/iu)?.[1];
  return String(bearer || readHeader(request, "x-budget-reset-token") || readHeader(request, "x-admin-token") || "").trim();
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
