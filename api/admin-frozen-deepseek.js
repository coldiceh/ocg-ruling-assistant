import {
  authorizeFrozenDeepseekExperimentRequest,
  createFrozenDeepseekExperimentService,
  FROZEN_DEEPSEEK_MAX_BODY_BYTES,
} from "../backend/frozenDeepseekExperimentBridge.mjs";
import { readRequestBody } from "../backend/requestBodyReader.mjs";

let defaultHandler;

export function createAdminFrozenDeepseekHandler({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  service,
  providerFactory,
} = {}) {
  const activeService = service || createFrozenDeepseekExperimentService({
    env,
    fetchImpl,
    providerFactory,
  });

  return async function adminFrozenDeepseekHandler(request, response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");

    if (String(request?.method || "").toUpperCase() !== "POST") {
      response.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    const authorization = authorizeFrozenDeepseekExperimentRequest(request, env);
    if (!authorization.ok) {
      sendFailure(response, authorization);
      return;
    }
    if (!String(readHeader(request, "content-type")).toLowerCase().startsWith("application/json")) {
      response.status(415).json({
        ok: false,
        error: "frozen_deepseek_content_type_invalid",
        message: "Content-Type must be application/json.",
      });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await activeService.run(body);
      response.status(200).json({ ok: true, result });
    } catch (error) {
      sendFailure(response, {
        status: error?.status || (error?.code === "request_body_too_large" ? 413 : 400),
        error: error?.code || "frozen_deepseek_request_invalid",
        message: error?.expose === true
          ? error.message
          : (error?.code === "request_body_too_large"
              ? "Request body exceeds the frozen DeepSeek bridge limit."
              : "Frozen DeepSeek experiment request failed."),
        ...(typeof error?.outcomeKnown === "boolean" ? { outcomeKnown: error.outcomeKnown } : {}),
        ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
      });
    }
  };
}

export default async function handler(request, response) {
  defaultHandler ||= createAdminFrozenDeepseekHandler();
  return defaultHandler(request, response);
}

async function readJsonBody(request) {
  let raw;
  if (request?.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    raw = JSON.stringify(request.body);
  } else if (typeof request?.body === "string" || Buffer.isBuffer(request?.body)) {
    raw = String(request.body || "");
  } else {
    raw = await readRequestBody(request, { maxBytes: FROZEN_DEEPSEEK_MAX_BODY_BYTES });
  }
  if (Buffer.byteLength(raw, "utf8") > FROZEN_DEEPSEEK_MAX_BODY_BYTES) {
    const error = new Error("request body exceeds the configured byte limit");
    error.code = "request_body_too_large";
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("request body must contain valid JSON");
    error.code = "frozen_deepseek_json_invalid";
    error.expose = true;
    throw error;
  }
}

function sendFailure(response, failure) {
  response.status(failure.status || 500).json({
    ok: false,
    error: failure.error || "frozen_deepseek_failed",
    message: failure.message || "Frozen DeepSeek experiment request failed.",
    ...(typeof failure.outcomeKnown === "boolean" ? { outcomeKnown: failure.outcomeKnown } : {}),
    ...(Number.isInteger(failure.upstreamStatus) ? { upstreamStatus: failure.upstreamStatus } : {}),
  });
}

function readHeader(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}
