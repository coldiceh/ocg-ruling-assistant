import {
  ADMIN_MODEL_LAB_STAGES,
  ADMIN_MODEL_CAPABILITY_TABLE,
  getAdminModelProviderCapabilities,
  resolveAdminModelSelection,
} from "./adminModelLabConfig.mjs";
import {
  MODEL_RULING_RESULT_JSON_SCHEMA,
  parseAndValidateModelRulingResult,
} from "./modelRulingSchema.mjs";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const MODEL_RULING_FORMAT_NAME = "model_ruling_result";

export class RulingModelProviderError extends Error {
  constructor(message, {
    code = "ruling_model_provider_error",
    provider,
    status = null,
    responseBody = null,
    outcomeKnown = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RulingModelProviderError";
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.responseBody = responseBody;
    this.outcomeKnown = outcomeKnown;
  }
}

export class ExistingDeepSeekProvider {
  constructor({
    invoke,
    env = globalThis.process?.env || {},
  } = {}) {
    if (typeof invoke !== "function") {
      throw new TypeError("ExistingDeepSeekProvider requires an injected existing DeepSeek invoke function");
    }
    this.providerId = "deepseek";
    this.invoke = invoke;
    this.env = env;
  }

  async getCapabilities() {
    return getAdminModelProviderCapabilities({ env: this.env }).providers
      .find((provider) => provider.providerId === this.providerId);
  }

  async prepareEvidence({
    input,
    model = "deepseek-v4-flash",
    metadata = {},
    maxOutputTokens,
  } = {}) {
    const selection = resolveAdminModelSelection({
      provider: "deepseek",
      model,
      reasoningEffort: "none",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
    });
    const prompt = normalizeDeepSeekInput(input);
    if (!prompt) throw new TypeError("DeepSeek preparation input must not be empty");

    const result = await this.invoke({
      prompt,
      provider: "deepseek",
      modelName: selection.model,
      maxTokens: optionalPositiveInteger(maxOutputTokens, "maxOutputTokens"),
      metadata: sanitizeMetadata(metadata, { requireTraceFields: false }),
      purpose: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
      canMakeFinalRuling: false,
      canDecideEscalation: false,
    });

    return {
      provider: "deepseek",
      model: selection.model,
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
      canMakeFinalRuling: false,
      canDecideEscalation: false,
      result,
    };
  }

  async create(request = {}) {
    return this.prepareEvidence(request);
  }

  async runRuling() {
    throw new RulingModelProviderError(
      "DeepSeek is restricted to evidence preparation; every final ruling must use an allowlisted GPT-5.6 model",
      { code: "deepseek_final_ruling_forbidden", provider: "deepseek" },
    );
  }

  async retrieve() {
    throw new RulingModelProviderError("DeepSeek adapter does not support background retrieval", {
      code: "provider_retrieve_not_supported",
      provider: "deepseek",
    });
  }

  async cancel() {
    throw new RulingModelProviderError("DeepSeek adapter does not support background cancellation", {
      code: "provider_cancel_not_supported",
      provider: "deepseek",
    });
  }
}

export class OpenAIResponsesProvider {
  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_OPENAI_BASE_URL,
    env = globalThis.process?.env || {},
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("OpenAIResponsesProvider requires fetch");
    }
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new TypeError("OpenAIResponsesProvider requires a server-side API key");
    }
    this.providerId = "openai";
    this.apiKey = apiKey.trim();
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.env = env;
  }

  async getCapabilities() {
    return getAdminModelProviderCapabilities({
      env: {
        ...this.env,
        ADMIN_OPENAI_ENABLED: "true",
        OPENAI_API_KEY: "__configured_server_side__",
      },
    }).providers.find((provider) => provider.providerId === this.providerId);
  }

  async create({
    model,
    reasoningEffort = "low",
    reasoningMode = "standard",
    instructions,
    input,
    maxOutputTokens,
    metadata,
    signal,
  } = {}) {
    const selection = resolveAdminModelSelection({
      provider: "openai",
      model,
      reasoningEffort,
      reasoningMode,
      stage: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
    });
    assertResponsesInput(input);
    const traceMetadata = sanitizeMetadata(metadata, { requireTraceFields: true });
    const maxTokens = optionalPositiveInteger(maxOutputTokens, "maxOutputTokens");
    if (maxTokens !== undefined && maxTokens > selection.capability.maxOutputTokens) {
      throw new RangeError(
        `maxOutputTokens exceeds ${selection.model} capability (${selection.capability.maxOutputTokens})`,
      );
    }

    const body = {
      model: selection.model,
      input,
      background: true,
      store: false,
      reasoning: {
        effort: selection.reasoningEffort,
        mode: selection.reasoningMode,
      },
      text: {
        format: {
          type: "json_schema",
          name: MODEL_RULING_FORMAT_NAME,
          strict: true,
          schema: cloneJson(MODEL_RULING_RESULT_JSON_SCHEMA),
        },
      },
      metadata: traceMetadata,
    };
    if (typeof instructions === "string" && instructions.trim()) body.instructions = instructions;
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;

    return this.requestJson("/responses", {
      method: "POST",
      body,
      signal,
    });
  }

  async runRuling(request = {}) {
    return this.create(request);
  }

  async retrieve(responseId, { signal } = {}) {
    const id = validateResponseId(responseId);
    return this.requestJson(`/responses/${encodeURIComponent(id)}`, {
      method: "GET",
      signal,
    });
  }

  async cancel(responseId, { signal } = {}) {
    const id = validateResponseId(responseId);
    return this.requestJson(`/responses/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      signal,
    });
  }

  validateCompletedResponse(response, validationOptions = {}) {
    if (!response || response.status !== "completed") {
      return {
        ok: false,
        errors: [`response is not completed: ${response?.status || "missing"}`],
      };
    }
    const outputText = extractOpenAIResponseOutputText(response);
    return parseAndValidateModelRulingResult(outputText, validationOptions);
  }

  async requestJson(path, { method, body, signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new RulingModelProviderError("OpenAI Responses request failed before receiving a response", {
        code: "openai_network_error",
        provider: "openai",
        outcomeKnown: false,
        cause,
      });
    }

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      const upstreamCode = payload?.error?.code || payload?.error?.type;
      throw new RulingModelProviderError(
        payload?.error?.message || `OpenAI Responses API returned HTTP ${response.status}`,
        {
          code: upstreamCode || "openai_http_error",
          provider: "openai",
          status: response.status,
          responseBody: payload,
          outcomeKnown: isProvableHttpRejection(response.status),
        },
      );
    }
    return payload;
  }
}

function isProvableHttpRejection(status) {
  const value = Number(status);
  if (!Number.isInteger(value) || value < 400 || value >= 500) return false;
  // Timeout, conflict/early-data and rate-limit responses can be produced
  // after an intermediary has forwarded the request. Without an upstream
  // idempotency guarantee they must remain outcome-unknown.
  return !new Set([408, 409, 425, 429]).has(value);
}

export function extractOpenAIResponseOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const parts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("").trim();
}

export function getRulingModelCapabilityTable() {
  return ADMIN_MODEL_CAPABILITY_TABLE;
}

function normalizeDeepSeekInput(input) {
  if (typeof input === "string") return input.trim();
  if (input === undefined || input === null) return "";
  return JSON.stringify(input);
}

function assertResponsesInput(input) {
  if (typeof input === "string" && input.trim()) return;
  if (Array.isArray(input) && input.length > 0) return;
  throw new TypeError("OpenAI Responses input must be a non-empty string or input array");
}

function sanitizeMetadata(metadata, { requireTraceFields }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    if (requireTraceFields) throw new TypeError("metadata must contain runId and promptVersion");
    return {};
  }
  if (requireTraceFields) {
    for (const field of ["runId", "promptVersion"]) {
      if (typeof metadata[field] !== "string" || metadata[field].trim() === "") {
        throw new TypeError(`metadata.${field} must be a non-empty string`);
      }
    }
  }
  const entries = Object.entries(metadata);
  if (entries.length > 16) throw new RangeError("metadata supports at most 16 entries");
  return Object.fromEntries(entries.map(([key, value]) => {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    if (!normalizedKey || normalizedKey.length > 64) {
      throw new RangeError("metadata keys must contain 1 to 64 characters");
    }
    if (normalizedValue.length > 512) {
      throw new RangeError(`metadata.${normalizedKey} exceeds 512 characters`);
    }
    return [normalizedKey, normalizedValue];
  }));
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive integer when provided`);
  }
  return number;
}

function validateResponseId(responseId) {
  const id = String(responseId || "").trim();
  if (!/^resp_[A-Za-z0-9_-]{1,240}$/u.test(id)) {
    throw new TypeError("responseId must be a valid OpenAI response ID");
  }
  return id;
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//iu.test(value)) throw new TypeError("baseUrl must be an HTTP(S) URL");
  return value;
}

async function readResponsePayload(response) {
  const contentType = String(response?.headers?.get?.("content-type") || "");
  if (contentType.includes("application/json") && typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { error: { message: text } };
    }
  }
  return {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
