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
import { DEFAULT_PUBLIC_RELAY_BASE_URL } from "./publicRulingModelConfig.mjs";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const MODEL_RULING_FORMAT_NAME = "model_ruling_result";
const EVIDENCE_PREPARATION_PROVIDER_IDS = new Set(["deepseek", "glm", "kimi"]);
const MODEL_RULING_JSON_SHAPE_EXAMPLE = Object.freeze({
  schemaVersion: "1.0",
  verdicts: [{
    questionId: "q1",
    value: "UNKNOWN",
    conclusion: "根据实际问题与证据填写，不得复制示例结论。",
    conditions: [],
  }],
  conciseAnswer: "根据实际问题与证据填写。",
  claims: [],
  timeline: [],
  assumptions: [],
  evidenceUsage: [],
  counterChecks: [],
  unresolved: [{
    questionId: "q1",
    code: "example_only",
    decisive: true,
    explanation: "这里只展示 JSON 字段结构。",
  }],
  confidence: { level: "LOW", reasons: ["这里只展示 JSON 字段结构。"] },
});

export class RulingModelProviderError extends Error {
  constructor(message, {
    code = "ruling_model_provider_error",
    provider,
    status = null,
    responseBody = null,
    outcomeKnown = null,
    budgetReservationMayExist = null,
    usage = null,
    model = null,
    requestId = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RulingModelProviderError";
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.responseBody = responseBody;
    this.outcomeKnown = outcomeKnown;
    this.budgetReservationMayExist = budgetReservationMayExist;
    this.usage = usage === null ? null : cloneJson(usage);
    this.model = typeof model === "string" && model.trim() ? model.trim() : null;
    this.requestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : null;
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
    if (!new Set(["deepseek", "glm", "kimi", "relay"]).has(normalizedProvider)) {
      throw new TypeError("Compatible model provider must be deepseek, glm, kimi or relay");
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
      relay: DEFAULT_PUBLIC_RELAY_BASE_URL,
    })[normalizedProvider], { requireHttps: true });
    this.env = env;
  }

  async getCapabilities() {
    const keyName = ({
      deepseek: "DEEPSEEK_API_KEY",
      glm: "GLM_API_KEY",
      kimi: "KIMI_API_KEY",
      relay: "RELAY_API_KEY",
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
      ...compatibleJsonResponseFormat(selection),
      ...compatibleThinkingParameters(selection),
    };
    if (maxTokens !== undefined) {
      body[new Set(["kimi", "relay"]).has(this.providerId)
        ? "max_completion_tokens"
        : "max_tokens"] = maxTokens;
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
    // Thinking tokens share the completion budget with the final JSON. The
    // former 16k default could be exhausted by reasoning alone, producing an
    // empty `content` even though the upstream request succeeded.
    const configuredRelayMaxTokens = this.providerId === "relay"
      ? optionalPositiveInteger(this.env?.RELAY_MAX_COMPLETION_TOKENS, "RELAY_MAX_COMPLETION_TOKENS")
      : undefined;
    const maxTokens = optionalPositiveInteger(maxOutputTokens, "maxOutputTokens")
      ?? configuredRelayMaxTokens
      ?? (selection.reasoningMode === "pro" ? 64_000 : 16_000);
    // DeepSeek's JSON Output guarantees syntax, not this application's field
    // contract. Keep the schema/example in the prompt and validate locally;
    // an occasional empty JSON-mode content is diagnosed below rather than
    // silently weakening a paid final-ruling request to unconstrained text.
    const deepSeekThinkingMode = this.providerId === "deepseek"
      && selection.reasoningMode === "pro";
    const schemaInstruction = [
      String(instructions || "").trim(),
      "这是隔离后台中的实验性最终裁定运行，不代表正式裁定或普通用户答案。",
      "只输出一个符合下列 JSON Schema 的 JSON 对象，不要输出 Markdown、代码围栏或额外说明：",
      JSON.stringify(MODEL_RULING_RESULT_JSON_SCHEMA),
      ...(deepSeekThinkingMode
        ? [
            "以下 JSON 仅展示字段结构；必须用本题的 questionId、结论、证据和检查结果替换全部示例内容：",
            JSON.stringify(MODEL_RULING_JSON_SHAPE_EXAMPLE),
          ]
        : []),
    ].filter(Boolean).join("\n\n");
    const body = {
      model: selection.model,
      messages: [
        { role: "system", content: schemaInstruction },
        { role: "user", content: finalInput },
      ],
      ...compatibleJsonResponseFormat(selection),
      ...compatibleThinkingParameters(selection),
    };
    if (maxTokens !== undefined) {
      body[new Set(["kimi", "relay"]).has(this.providerId)
        ? "max_completion_tokens"
        : "max_tokens"] = maxTokens;
    }
    const startedAt = new Date();
    const payload = await this.requestJson("/chat/completions", {
      method: "POST",
      body,
      signal,
    });
    const text = extractChatCompletionText(payload);
    if (!text) {
      const choice = payload?.choices?.[0] || {};
      const message = choice?.message || {};
      const finishReason = String(choice?.finish_reason || "").trim();
      const reasoningLength = typeof message?.reasoning_content === "string"
        ? message.reasoning_content.length
        : 0;
      const toolCallCount = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
      const completionTokens = Number(payload?.usage?.completion_tokens);
      const reasoningTokens = Number(payload?.usage?.completion_tokens_details?.reasoning_tokens);
      const diagnostics = [
        `finish_reason=${finishReason || "missing"}`,
        `reasoning_chars=${reasoningLength}`,
        `tool_calls=${toolCallCount}`,
        `completion_tokens=${Number.isFinite(completionTokens) ? completionTokens : "missing"}`,
        `reasoning_tokens=${Number.isFinite(reasoningTokens) ? reasoningTokens : "missing"}`,
      ].join(", ");
      throw new RulingModelProviderError(
        `${this.providerId} returned an empty final ruling (${diagnostics})`, {
        code: finishReason === "length"
          ? `${this.providerId}_final_ruling_output_exhausted`
          : `${this.providerId}_empty_final_ruling`,
        provider: this.providerId,
        outcomeKnown: true,
        // A successful HTTP response proves that the provider processed the
        // request, not that it was free. Preserve the reservation when usage is
        // absent, and expose metering-only fields so the service can settle the
        // actual charge when the provider reported it.
        budgetReservationMayExist: true,
        usage: payload?.usage || null,
        model: String(payload?.model || selection.model),
        requestId: String(payload?.id || ""),
      });
    }
    const upstreamRequestId = String(payload?.id || "").trim();
    return {
      id: upstreamRequestId || `${this.providerId}-synthetic-${Date.now()}`,
      request_id_source: upstreamRequestId ? "upstream" : "synthetic",
      status: "completed",
      model: String(payload?.model || selection.model),
      requested_model: selection.model,
      output_text: text,
      usage: cloneJson(payload?.usage || null),
      created_at: payload?.created ?? startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      provider: this.providerId,
      experimental: true,
      ...(this.providerId === "relay"
        ? { third_party: true, model_identity_verified: false }
        : {}),
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
  if (selection.provider === "relay") {
    return selection.reasoningEffort === "none"
      ? {}
      : { reasoning_effort: selection.reasoningEffort };
  }
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

function compatibleJsonResponseFormat(selection) {
  // DeepSeek thinking mode and JSON Output are not combined. The prompt still
  // carries the strict application schema and the response is validated
  // locally. Non-thinking DeepSeek and the other compatible providers retain
  // their existing JSON-mode request.
  return selection.provider === "deepseek" && selection.reasoningMode === "pro"
    ? {}
    : { response_format: { type: "json_object" } };
}

function extractChatCompletionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(extractCompatibleContentPartText).join("").trim();
  }
  return extractCompatibleContentPartText(content).trim();
}

function extractCompatibleContentPartText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.text?.value === "string") return part.text.value;
  if (Array.isArray(part.content)) return part.content.map(extractCompatibleContentPartText).join("");
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
