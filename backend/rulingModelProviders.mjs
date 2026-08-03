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
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const MODEL_RULING_FORMAT_NAME = "model_ruling_result";
const EVIDENCE_PREPARATION_PROVIDER_IDS = new Set(["deepseek", "glm", "kimi"]);

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
    reasoningEffort,
    reasoningMode,
    metadata = {},
    maxOutputTokens,
    signal,
  } = {}) {
    const selection = resolveAdminModelSelection({
      provider: "deepseek",
      model,
      reasoningEffort,
      reasoningMode,
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
    });
    const prompt = normalizeDeepSeekInput(input);
    if (!prompt) throw new TypeError("DeepSeek preparation input must not be empty");

    const result = await this.invoke({
      prompt,
      provider: "deepseek",
      modelName: selection.model,
      maxTokens: optionalPositiveInteger(maxOutputTokens, "maxOutputTokens"),
      thinkingMode: selection.reasoningMode === "pro" ? "enabled" : "disabled",
      reasoningEffort: selection.reasoningMode === "pro" ? selection.reasoningEffort : undefined,
      metadata: sanitizeMetadata(metadata, { requireTraceFields: false }),
      purpose: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
      canMakeFinalRuling: false,
      canDecideEscalation: false,
      signal,
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

/**
 * Server-owned OpenAI-compatible Chat Completions adapter. The same transport
 * can prepare evidence-search hints or, when selected explicitly in the
 * isolated admin lab, produce an experimental final ruling from the complete
 * frozen evidence packet. Public answers never use this final-ruling method.
 */
export class CompatibleEvidencePreparationProvider {
  constructor({
    providerId,
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl,
    env = globalThis.process?.env || {},
  } = {}) {
    const normalizedProvider = String(providerId || "").trim().toLowerCase();
    if (!new Set(["deepseek", "glm", "kimi"]).has(normalizedProvider)) {
      throw new TypeError("Compatible model provider must be deepseek, glm or kimi");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError(`${normalizedProvider} evidence provider requires fetch`);
    }
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new TypeError(`${normalizedProvider} evidence provider requires a server-side API key`);
    }
    this.providerId = normalizedProvider;
    this.apiKey = apiKey.trim();
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl || ({
      deepseek: DEFAULT_DEEPSEEK_BASE_URL,
      glm: DEFAULT_GLM_BASE_URL,
      kimi: DEFAULT_KIMI_BASE_URL,
    })[normalizedProvider], { requireHttps: true });
    this.env = env;
  }

  async getCapabilities() {
    const keyName = ({
      deepseek: "DEEPSEEK_API_KEY",
      glm: "GLM_API_KEY",
      kimi: "KIMI_API_KEY",
    })[this.providerId];
    return getAdminModelProviderCapabilities({
      env: {
        ...this.env,
        [keyName]: "__configured_server_side__",
      },
    }).providers.find((provider) => provider.providerId === this.providerId);
  }

  async prepareEvidence({
    input,
    model,
    reasoningEffort,
    reasoningMode,
    metadata = {},
    maxOutputTokens,
    signal,
  } = {}) {
    const capability = ADMIN_MODEL_CAPABILITY_TABLE[String(model || "").trim()];
    const selection = resolveAdminModelSelection({
      provider: this.providerId,
      model,
      reasoningEffort: reasoningEffort || capability?.defaultReasoningEffort,
      reasoningMode: reasoningMode || capability?.defaultReasoningMode,
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
    });
    const prompt = normalizeDeepSeekInput(input);
    if (!prompt) throw new TypeError(`${this.providerId} preparation input must not be empty`);
    sanitizeMetadata(metadata, { requireTraceFields: false });
    const maxTokens = optionalPositiveInteger(maxOutputTokens, "maxOutputTokens");
    const body = {
      model: selection.model,
      messages: [
        {
          role: "system",
          content: "Return only one JSON object. Prepare search evidence; do not make a final ruling or an escalation decision.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      ...compatibleThinkingParameters(selection),
    };
    if (maxTokens !== undefined) {
      body[this.providerId === "kimi" ? "max_completion_tokens" : "max_tokens"] = maxTokens;
    }

    const payload = await this.requestJson("/chat/completions", {
      method: "POST",
      body,
      signal,
    });
    const text = extractChatCompletionText(payload);
    const result = parseStrictJsonObject(text, this.providerId);
    return {
      provider: this.providerId,
      model: selection.model,
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
      canMakeFinalRuling: false,
      canDecideEscalation: false,
      result,
      usage: cloneJson(payload?.usage || null),
    };
  }

  async create({
    model,
    reasoningEffort,
    reasoningMode,
    instructions,
    input,
    maxOutputTokens,
    metadata = {},
    signal,
  } = {}) {
    const capability = ADMIN_MODEL_CAPABILITY_TABLE[String(model || "").trim()];
    const selection = resolveAdminModelSelection({
      provider: this.providerId,
      model,
      reasoningEffort: reasoningEffort || capability?.defaultReasoningEffort,
      reasoningMode: reasoningMode || capability?.defaultReasoningMode,
      stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
    });
    const finalInput = normalizeDeepSeekInput(input);
    if (!finalInput) throw new TypeError(`${this.providerId} final-ruling input must not be empty`);
    sanitizeMetadata(metadata, { requireTraceFields: true });
    const maxTokens = optionalPositiveInteger(maxOutputTokens, "maxOutputTokens") ?? 16_000;
    const schemaInstruction = [
      String(instructions || "").trim(),
      "这是隔离后台中的实验性最终裁定运行，不代表正式裁定或普通用户答案。",
      "只输出一个符合下列 JSON Schema 的 JSON 对象，不要输出 Markdown、代码围栏或额外说明：",
      JSON.stringify(MODEL_RULING_RESULT_JSON_SCHEMA),
    ].filter(Boolean).join("\n\n");
    const body = {
      model: selection.model,
      messages: [
        { role: "system", content: schemaInstruction },
        { role: "user", content: finalInput },
      ],
      response_format: { type: "json_object" },
      ...compatibleThinkingParameters(selection),
    };
    if (maxTokens !== undefined) {
      body[this.providerId === "kimi" ? "max_completion_tokens" : "max_tokens"] = maxTokens;
    }
    const startedAt = new Date();
    const payload = await this.requestJson("/chat/completions", {
      method: "POST",
      body,
      signal,
    });
    const text = extractChatCompletionText(payload);
    if (!text) {
      throw new RulingModelProviderError(`${this.providerId} returned an empty final ruling`, {
        code: `${this.providerId}_empty_final_ruling`,
        provider: this.providerId,
        outcomeKnown: true,
      });
    }
    const upstreamRequestId = String(payload?.id || "").trim();
    return {
      id: upstreamRequestId || `${this.providerId}-synthetic-${Date.now()}`,
      request_id_source: upstreamRequestId ? "upstream" : "synthetic",
      status: "completed",
      model: String(payload?.model || selection.model),
      output_text: text,
      usage: cloneJson(payload?.usage || null),
      created_at: payload?.created ?? startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      provider: this.providerId,
      experimental: true,
    };
  }

  async runRuling(request = {}) {
    return this.create(request);
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

  async requestJson(path, { method, body, signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new RulingModelProviderError(`${this.providerId} model request failed`, {
        code: `${this.providerId}_network_error`,
        provider: this.providerId,
        outcomeKnown: false,
        cause,
      });
    }
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new RulingModelProviderError(
        payload?.error?.message || `${this.providerId} Chat Completions API returned HTTP ${response.status}`,
        {
          code: payload?.error?.code || `${this.providerId}_http_error`,
          provider: this.providerId,
          status: response.status,
          outcomeKnown: isProvableHttpRejection(response.status),
        },
      );
    }
    return payload;
  }
}

export function createEvidencePreparationProviderRegistry({ providers = [] } = {}) {
  const entries = providers instanceof Map
    ? [...providers.entries()]
    : Object.entries(providers || {});
  const registry = new Map();
  for (const [declaredId, provider] of entries) {
    if (!provider) continue;
    const providerId = String(provider.providerId || declaredId || "").trim().toLowerCase();
    if (!EVIDENCE_PREPARATION_PROVIDER_IDS.has(providerId)) {
      throw new TypeError(`Unsupported evidence preparation provider: ${providerId || "(empty)"}`);
    }
    if (String(declaredId || providerId).trim().toLowerCase() !== providerId) {
      throw new TypeError(`Evidence preparation provider registry key mismatch: ${declaredId}`);
    }
    if (typeof provider.prepareEvidence !== "function") {
      throw new TypeError(`${providerId} evidence preparation provider requires prepareEvidence()`);
    }
    registry.set(providerId, provider);
  }
  return Object.freeze({
    get(providerId) {
      return registry.get(String(providerId || "").trim().toLowerCase()) || null;
    },
    has(providerId) {
      return registry.has(String(providerId || "").trim().toLowerCase());
    },
    listProviderIds() {
      return Object.freeze([...registry.keys()]);
    },
  });
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

function compatibleThinkingParameters(selection) {
  if (selection.provider === "glm") {
    const enabled = selection.reasoningMode === "pro";
    return {
      thinking: { type: enabled ? "enabled" : "disabled" },
      ...(enabled && selection.reasoningEffort !== "none"
        ? { reasoning_effort: selection.reasoningEffort }
        : {}),
    };
  }
  if (selection.model === "kimi-k3") {
    return { reasoning_effort: selection.reasoningEffort };
  }
  if (selection.provider === "deepseek") {
    const enabled = selection.reasoningMode === "pro";
    return {
      thinking: { type: enabled ? "enabled" : "disabled" },
      ...(enabled && selection.reasoningEffort !== "none"
        ? { reasoning_effort: selection.reasoningEffort }
        : {}),
    };
  }
  return {
    thinking: { type: selection.reasoningMode === "pro" ? "enabled" : "disabled" },
  };
}

function extractChatCompletionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => String(part?.text || part?.content || "")).join("").trim();
  }
  return "";
}

function parseStrictJsonObject(text, providerId) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch (cause) {
    throw new RulingModelProviderError(`${providerId} preparation response was not valid JSON`, {
      code: `${providerId}_invalid_json`,
      provider: providerId,
      outcomeKnown: true,
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RulingModelProviderError(`${providerId} preparation response must be a JSON object`, {
      code: `${providerId}_invalid_json_shape`,
      provider: providerId,
      outcomeKnown: true,
    });
  }
  return parsed;
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

function normalizeBaseUrl(baseUrl, { requireHttps = false } = {}) {
  const value = String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("baseUrl must be an HTTP(S) URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new TypeError("baseUrl must be an HTTP(S) URL");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("baseUrl must not contain userinfo");
  }
  if (requireHttps && parsed.protocol !== "https:") {
    throw new TypeError("evidence preparation baseUrl must use HTTPS");
  }
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
