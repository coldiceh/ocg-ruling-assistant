import { createHash } from "node:crypto";

import {
  constantTimeSecretEqual,
  inspectAdminRequestOrigin,
} from "./adminSession.mjs";
import { parseAndValidateModelRulingResult } from "./modelRulingSchema.mjs";
import { CompatibleEvidencePreparationProvider } from "./rulingModelProviders.mjs";

export const FROZEN_DEEPSEEK_BRIDGE_SCHEMA_VERSION = 1;
export const FROZEN_DEEPSEEK_MAX_BODY_BYTES = 128 * 1024;
export const FROZEN_DEEPSEEK_MAX_CALLS_PER_REQUEST = 1;
export const FROZEN_DEEPSEEK_MAX_CONCURRENT_CALLS_PER_INSTANCE = 1;

const DEFAULT_TIMEOUT_MS = 285_000;
const MAX_TIMEOUT_MS = 290_000;
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const MAX_FINAL_INPUT_BYTES = 96 * 1024;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_OUTPUT_TEXT_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALLOWED_REQUEST_KEYS = new Set([
  "schemaVersion",
  "model",
  "reasoningMode",
  "reasoningEffort",
  "instructions",
  "input",
  "maxOutputTokens",
  "metadata",
  "bindings",
]);
const ALLOWED_METADATA_KEYS = new Set(["runId", "promptVersion"]);
const ALLOWED_BINDING_KEYS = new Set(["instructionsSha256", "finalInputSha256"]);
const ALLOWED_CONFIGURATIONS = new Set([
  "deepseek-v4-flash\u0000standard\u0000none",
  "deepseek-v4-flash\u0000pro\u0000high",
  "deepseek-v4-pro\u0000standard\u0000none",
  "deepseek-v4-pro\u0000pro\u0000max",
]);

/**
 * Direct, storage-free authentication for the server-to-server experiment
 * bridge. This intentionally does not create an admin session or touch Redis.
 */
export function authorizeFrozenDeepseekExperimentRequest(
  request,
  env = globalThis.process?.env || {},
) {
  const origin = inspectAdminRequestOrigin(request, env);
  if (!origin.ok) return origin;

  const expected = String(
    env.ADMIN_FROZEN_DEEPSEEK_TOKEN
    || env.ADMIN_SESSION_PASSWORD
    || env.API_ADMIN_PASSWORD
    || "",
  ).trim();
  if (!expected) {
    return bridgeFailure(
      503,
      "frozen_deepseek_auth_not_configured",
      "Frozen DeepSeek experiment access is disabled.",
    );
  }

  const authorization = readHeader(request, "authorization");
  const supplied = authorization.match(/^Bearer\s+([^\s].*)$/iu)?.[1]?.trim() || "";
  if (!supplied) {
    return bridgeFailure(
      401,
      "frozen_deepseek_authorization_required",
      "Frozen DeepSeek experiment authorization is required.",
    );
  }
  if (!constantTimeSecretEqual(supplied, expected)) {
    return bridgeFailure(
      403,
      "frozen_deepseek_authorization_invalid",
      "Frozen DeepSeek experiment authorization failed.",
    );
  }
  return { ok: true, status: 200, origin: origin.origin };
}

export function normalizeFrozenDeepseekExperimentRequest(body) {
  if (!isPlainObject(body)) {
    throw exposedBridgeError(400, "frozen_deepseek_body_invalid", "Request body must be one JSON object.");
  }
  assertExactKeys(body, ALLOWED_REQUEST_KEYS, "request");
  if (body.schemaVersion !== FROZEN_DEEPSEEK_BRIDGE_SCHEMA_VERSION) {
    throw exposedBridgeError(400, "frozen_deepseek_schema_version_invalid", "Unsupported bridge schema version.");
  }

  const model = boundedText(body.model, "model", 64);
  const reasoningMode = boundedText(body.reasoningMode, "reasoningMode", 16).toLowerCase();
  const reasoningEffort = boundedText(body.reasoningEffort, "reasoningEffort", 16).toLowerCase();
  if (!ALLOWED_CONFIGURATIONS.has(`${model}\u0000${reasoningMode}\u0000${reasoningEffort}`)) {
    throw exposedBridgeError(
      400,
      "frozen_deepseek_configuration_not_allowlisted",
      "The requested DeepSeek model, mode and effort combination is not allowlisted.",
    );
  }

  const instructions = boundedUtf8Text(
    body.instructions,
    "instructions",
    MAX_INSTRUCTIONS_BYTES,
  );
  const input = boundedUtf8Text(body.input, "input", MAX_FINAL_INPUT_BYTES);
  const maxOutputTokens = Number(body.maxOutputTokens);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw exposedBridgeError(
      400,
      "frozen_deepseek_max_output_tokens_invalid",
      `maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}.`,
    );
  }

  if (!isPlainObject(body.metadata)) {
    throw exposedBridgeError(400, "frozen_deepseek_metadata_invalid", "metadata must be one JSON object.");
  }
  assertExactKeys(body.metadata, ALLOWED_METADATA_KEYS, "metadata");
  const metadata = Object.freeze({
    runId: boundedText(body.metadata.runId, "metadata.runId", 512),
    promptVersion: boundedText(body.metadata.promptVersion, "metadata.promptVersion", 512),
  });

  if (!isPlainObject(body.bindings)) {
    throw exposedBridgeError(400, "frozen_deepseek_bindings_invalid", "bindings must be one JSON object.");
  }
  assertExactKeys(body.bindings, ALLOWED_BINDING_KEYS, "bindings");
  const instructionsSha256 = requiredSha256(
    body.bindings.instructionsSha256,
    "bindings.instructionsSha256",
  );
  const finalInputSha256 = requiredSha256(
    body.bindings.finalInputSha256,
    "bindings.finalInputSha256",
  );
  if (!constantTimeSecretEqual(instructionsSha256, sha256(instructions))) {
    throw exposedBridgeError(
      400,
      "frozen_deepseek_instructions_binding_mismatch",
      "instructions do not match their SHA-256 binding.",
    );
  }
  if (!constantTimeSecretEqual(finalInputSha256, sha256(input))) {
    throw exposedBridgeError(
      400,
      "frozen_deepseek_input_binding_mismatch",
      "input does not match its SHA-256 binding.",
    );
  }

  return Object.freeze({
    schemaVersion: FROZEN_DEEPSEEK_BRIDGE_SCHEMA_VERSION,
    model,
    reasoningMode,
    reasoningEffort,
    instructions,
    input,
    maxOutputTokens,
    metadata,
    bindings: Object.freeze({ instructionsSha256, finalInputSha256 }),
  });
}

export function createFrozenDeepseekExperimentService({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  providerFactory,
} = {}) {
  const timeoutMs = boundedInteger(
    env.ADMIN_FROZEN_DEEPSEEK_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    MAX_TIMEOUT_MS,
    "ADMIN_FROZEN_DEEPSEEK_TIMEOUT_MS",
  );
  let activeCalls = 0;

  return Object.freeze({
    limits: Object.freeze({
      callsPerRequest: FROZEN_DEEPSEEK_MAX_CALLS_PER_REQUEST,
      concurrentCallsPerInstance: FROZEN_DEEPSEEK_MAX_CONCURRENT_CALLS_PER_INSTANCE,
      timeoutMs,
    }),

    async run(rawRequest) {
      const request = normalizeFrozenDeepseekExperimentRequest(rawRequest);
      if (activeCalls >= FROZEN_DEEPSEEK_MAX_CONCURRENT_CALLS_PER_INSTANCE) {
        throw exposedBridgeError(
          429,
          "frozen_deepseek_concurrency_limit",
          "The frozen DeepSeek bridge is already processing one request in this instance.",
        );
      }
      const apiKey = String(env.DEEPSEEK_API_KEY || "").trim();
      if (!apiKey) {
        throw exposedBridgeError(
          503,
          "frozen_deepseek_provider_unavailable",
          "The server-side DeepSeek provider is unavailable.",
        );
      }

      activeCalls += 1;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("frozen DeepSeek bridge timed out")),
        timeoutMs,
      );
      timeout.unref?.();
      try {
        const provider = providerFactory
          ? providerFactory({ apiKey, env, fetchImpl })
          : new CompatibleEvidencePreparationProvider({
              providerId: "deepseek",
              apiKey,
              env,
              fetchImpl,
            });
        if (!provider || typeof provider.runRuling !== "function") {
          throw new TypeError("frozen DeepSeek bridge provider is invalid");
        }
        const response = await provider.runRuling({
          model: request.model,
          reasoningMode: request.reasoningMode,
          reasoningEffort: request.reasoningEffort,
          instructions: request.instructions,
          input: request.input,
          maxOutputTokens: request.maxOutputTokens,
          metadata: request.metadata,
          signal: controller.signal,
        });
        return sanitizeBridgeResponse(response);
      } catch (error) {
        if (error?.expose === true) throw error;
        if (controller.signal.aborted) {
          throw exposedBridgeError(
            504,
            "frozen_deepseek_timeout",
            "The server-side DeepSeek call timed out.",
            { outcomeKnown: false },
          );
        }
        throw exposedBridgeError(
          502,
          "frozen_deepseek_upstream_failed",
          "The server-side DeepSeek call failed.",
          {
            outcomeKnown: error?.outcomeKnown === true,
            upstreamStatus: safeHttpStatus(error?.status),
          },
        );
      } finally {
        clearTimeout(timeout);
        activeCalls -= 1;
      }
    },
  });
}

/**
 * Client used by the serial GitHub runner. It only transports one already
 * constructed final input and validates the returned ruling locally.
 */
export class FrozenDeepseekExperimentBridgeClient {
  constructor({
    bridgeUrl,
    password,
    origin,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("frozen DeepSeek bridge client requires fetch");
    this.bridgeUrl = normalizeBridgeUrl(bridgeUrl);
    this.password = boundedText(password, "bridge password", 4_096);
    this.origin = normalizeOrigin(origin);
    this.fetchImpl = fetchImpl;
  }

  async runRuling(request = {}) {
    const body = normalizeFrozenDeepseekExperimentRequest({
      schemaVersion: FROZEN_DEEPSEEK_BRIDGE_SCHEMA_VERSION,
      model: request.model,
      reasoningMode: request.reasoningMode,
      reasoningEffort: request.reasoningEffort,
      instructions: request.instructions,
      input: request.input,
      maxOutputTokens: request.maxOutputTokens,
      metadata: request.metadata,
      bindings: {
        instructionsSha256: sha256(String(request.instructions || "")),
        finalInputSha256: sha256(String(request.input || "")),
      },
    });
    let response;
    try {
      response = await this.fetchImpl(this.bridgeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.password}`,
          "content-type": "application/json",
          origin: this.origin,
        },
        body: JSON.stringify(body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (cause) {
      throw bridgeClientError("Frozen DeepSeek bridge request failed", {
        code: "frozen_deepseek_bridge_network_error",
        outcomeKnown: false,
        cause,
      });
    }
    const payload = await readJsonResponse(response);
    if (!response.ok || payload?.ok !== true || !payload.result) {
      throw bridgeClientError(
        payload?.message || `Frozen DeepSeek bridge returned HTTP ${response.status}`,
        {
          code: payload?.error || "frozen_deepseek_bridge_http_error",
          status: response.status,
          outcomeKnown: payload?.outcomeKnown === true,
        },
      );
    }
    return sanitizeBridgeResponse(payload.result);
  }

  validateCompletedResponse(response, validationOptions = {}) {
    if (!response || response.status !== "completed") {
      return {
        ok: false,
        errors: [`response is not completed: ${response?.status || "missing"}`],
      };
    }
    return parseAndValidateModelRulingResult(
      String(response.output_text || ""),
      validationOptions,
    );
  }
}

function sanitizeBridgeResponse(response) {
  if (!isPlainObject(response)) {
    throw new TypeError("DeepSeek provider returned an invalid response");
  }
  const outputText = typeof response.output_text === "string" ? response.output_text : "";
  if (Buffer.byteLength(outputText, "utf8") > MAX_OUTPUT_TEXT_BYTES) {
    throw new RangeError("DeepSeek provider output exceeds the bridge response limit");
  }
  return Object.freeze({
    id: nullableText(response.id, 512),
    request_id_source: nullableText(response.request_id_source, 32),
    status: nullableText(response.status, 32),
    model: nullableText(response.model, 128),
    requested_model: nullableText(response.requested_model, 128),
    submitted_model: nullableText(response.submitted_model, 128),
    reported_model: nullableText(response.reported_model, 128),
    finish_reason: nullableText(response.finish_reason, 128),
    output_text: outputText,
    usage: jsonClone(response.usage),
    created_at: nullableText(response.created_at, 128),
    completed_at: nullableText(response.completed_at, 128),
    provider: "deepseek",
    experimental: true,
  });
}

function exposedBridgeError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expose = true;
  Object.assign(error, details);
  return error;
}

function bridgeClientError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function bridgeFailure(status, error, message) {
  return { ok: false, status, error, message };
}

function assertExactKeys(value, allowedKeys, field) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const missing = [...allowedKeys].filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    throw exposedBridgeError(
      400,
      `frozen_deepseek_${field.replaceAll(".", "_")}_shape_invalid`,
      `${field} has missing or unsupported fields.`,
    );
  }
}

function boundedText(value, field, maximumLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw exposedBridgeError(400, "frozen_deepseek_text_invalid", `${field} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > maximumLength) {
    throw exposedBridgeError(400, "frozen_deepseek_text_too_long", `${field} exceeds its length limit.`);
  }
  return text;
}

function boundedUtf8Text(value, field, maximumBytes) {
  if (typeof value !== "string" || !value.trim()) {
    throw exposedBridgeError(400, "frozen_deepseek_text_invalid", `${field} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw exposedBridgeError(400, "frozen_deepseek_text_too_large", `${field} exceeds its byte limit.`);
  }
  return value;
}

function requiredSha256(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(text)) {
    throw exposedBridgeError(400, "frozen_deepseek_sha256_invalid", `${field} must be a SHA-256 digest.`);
  }
  return text;
}

function nullableText(value, maximumLength) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, maximumLength);
}

function jsonClone(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function readHeader(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}

function normalizeOrigin(value) {
  const text = String(value || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("bridge origin must be one exact http(s) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== text) {
    throw new TypeError("bridge origin must be one exact http(s) origin");
  }
  return url.origin;
}

function normalizeBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new TypeError("--bridge-url must be one absolute URL");
  }
  const local = new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError("--bridge-url must use HTTPS outside loopback development");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("--bridge-url must not contain credentials, a query or a fragment");
  }
  return url.toString();
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw bridgeClientError("Frozen DeepSeek bridge returned invalid JSON", {
      code: "frozen_deepseek_bridge_invalid_json",
      status: response.status,
      outcomeKnown: false,
    });
  }
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}
