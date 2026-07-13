import { authorizeBudgetResetRequest, budgetResetTokenConfigured } from "../backend/budgetAuth.mjs";
import { getRagBudgetStatus, resetRagBudget } from "../backend/ragModelClient.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  try {
    if (request.method === "GET") {
      const status = await getRagBudgetStatus({ env: process.env });
      response.status(200).json({
        ...status,
        resetEnabled: budgetResetTokenConfigured(process.env) && status.budgetStorage !== "unconfigured",
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readRequestBody(request);
      const auth = authorizeBudgetResetRequest(request, { env: process.env, body });
      if (!auth.ok) {
        response.status(auth.status).json({ ok: false, error: auth.error, message: auth.message });
        return;
      }
      response.status(200).json(await resetRagBudget({ env: process.env }));
      return;
    }

    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-budget-reset-password,x-budget-reset-token,x-admin-token");
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
  const raw = typeof request?.body === "string" || Buffer.isBuffer(request?.body) ? String(request.body || "") : "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
