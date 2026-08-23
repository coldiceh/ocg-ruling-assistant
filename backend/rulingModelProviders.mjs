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
const EVIDENCE_PREPARATION_PROVIDER_IDS = new Set(["glm", "kimi", "relay"]);
const RELAY_TIMEOUT_HTTP_STATUSES = new Set([408, 504, 524]);
const RELAY_SAFE_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "function_call",
  "content_filter",
  "cancelled",
  "error",
]);
const RELAY_ACCESS_DENIED_PATTERN = /(?:无权访问|没有权限|权限不足|拒绝访问|access(?:[_ -]?is)?[_ -]?denied|permission[_ -]?denied|forbidden|unauthori[sz]ed|group[_ -]?access[_ -]?denied|no[_ -]?permission)/iu;
const RELAY_TIMEOUT_PATTERN = /(?:超时|timed[ _-]?out|timeout|etimedout|und_err_(?:headers|body)_timeout)/iu;
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
    requestedModel = null,
    submittedModel = null,
    reportedModel = null,
    requestId = null,
    streamMetrics = null,
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
    this.requestedModel = typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : null;
    this.submittedModel = typeof submittedModel === "string" && submittedModel.trim()
      ? submittedModel.trim()
      : null;
    this.reportedModel = typeof reportedModel === "string" && reportedModel.trim()
      ? reportedModel.trim()
      : null;
    this.requestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : null;
    this.streamMetrics = copySafeRelayStreamMetrics(streamMetrics);
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
    clock = defaultMonotonicClock,
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
    if (typeof clock !== "function") {
      throw new TypeError(`${normalizedProvider} evidence provider clock must be a function`);
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
    this.clock = clock;
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
    const result = parseStrictJsonObject(text, this.providerId, {
      usage: payload?.usage || null,
    });
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
    const { selection, body } = buildCompatibleFinalRequest({
      providerId: this.providerId,
      env: this.env,
      model,
      reasoningEffort,
      reasoningMode,
      instructions,
      input,
      maxOutputTokens,
      metadata,
    });
    const startedAt = new Date();
    let payload;
    try {
      if (this.providerId === "relay" && readBooleanFlag(this.env.RELAY_STREAM, true)) {
        payload = await this.requestRelayStream("/chat/completions", {
          method: "POST",
          body: {
            ...body,
            stream: true,
            stream_options: { include_usage: true },
          },
          signal,
        });
      } else {
        payload = await this.requestJson("/chat/completions", {
          method: "POST",
          body,
          signal,
        });
      }
    } catch (error) {
      if (error instanceof RulingModelProviderError) {
        error.requestedModel = selection.requestedModel;
        error.submittedModel = selection.model;
      }
      throw error;
    }
    const upstreamRequestId = String(payload?.id || "").trim();
    const reportedModel = String(payload?.model || "").trim();
    const relayIdentityErrorCode = this.providerId !== "relay"
      ? null
      : (!reportedModel
          ? "relay_returned_model_missing"
          : (reportedModel.toLowerCase() !== selection.model.toLowerCase()
              ? "relay_returned_model_mismatch"
              : null));
    if (relayIdentityErrorCode) {
      throw new RulingModelProviderError(
        relayIdentityErrorCode === "relay_returned_model_missing"
          ? `relay response omitted the model identity submitted as ${selection.model}`
          : `relay returned a different model identity (submitted ${selection.model}, returned ${reportedModel})`,
        {
          code: relayIdentityErrorCode,
          provider: this.providerId,
          status: 200,
          outcomeKnown: true,
          // HTTP 200 proves the request reached the third party. Preserve and
          // settle the charge from reported usage even though the answer is
          // rejected for experiment-integrity purposes.
          budgetReservationMayExist: true,
          usage: payload?.usage || null,
          model: reportedModel || null,
          requestedModel: selection.requestedModel,
          submittedModel: selection.model,
          reportedModel: reportedModel || null,
          requestId: upstreamRequestId,
          streamMetrics: payload?.stream_metrics,
        },
      );
    }
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
        requestedModel: selection.requestedModel,
        submittedModel: selection.model,
        reportedModel: reportedModel || null,
        requestId: String(payload?.id || ""),
        streamMetrics: payload?.stream_metrics,
      });
    }
    return {
      id: upstreamRequestId || `${this.providerId}-synthetic-${Date.now()}`,
      request_id_source: upstreamRequestId ? "upstream" : "synthetic",
      status: "completed",
      model: String(payload?.model || selection.model),
      requested_model: selection.requestedModel,
      submitted_model: selection.model,
      reported_model: reportedModel || null,
      finish_reason: String(payload?.choices?.[0]?.finish_reason || "").trim() || null,
      stream_metrics: copySafeRelayStreamMetrics(payload?.stream_metrics),
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

  getFinalRequestBudgetEnvelope(request = {}) {
    const { selection, body, maxTokens } = buildCompatibleFinalRequest({
      providerId: this.providerId,
      env: this.env,
      ...request,
    });
    // One tokenizer token cannot encode fewer than one source byte. Treating
    // every UTF-8 byte as a token plus a fixed chat-framing allowance is a
    // deliberately conservative upper bound for pre-call budget reservation.
    const inputTokenUpperBound = new TextEncoder().encode(
      JSON.stringify(body.messages),
    ).length + 4_096;
    return Object.freeze({
      provider: this.providerId,
      model: selection.model,
      inputTokenUpperBound,
      maxOutputTokens: maxTokens,
    });
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
    const payload = await readResponsePayload(response, { signal });
    if (!response.ok) {
      const outcomeKnown = isProvableHttpRejection(response.status);
      throw new RulingModelProviderError(
        payload?.error?.message || `${this.providerId} Chat Completions API returned HTTP ${response.status}`,
        {
          code: payload?.error?.code || `${this.providerId}_http_error`,
          provider: this.providerId,
          status: response.status,
          outcomeKnown,
          budgetReservationMayExist: !outcomeKnown,
        },
      );
    }
    return payload;
  }

  async requestRelayStream(path, { method, body, signal } = {}) {
    if (this.providerId !== "relay") {
      throw new TypeError("requestRelayStream is restricted to the relay provider");
    }
    return requestRelayChatCompletionSse({
      fetchImpl: this.fetchImpl,
      endpoint: `${this.baseUrl}${path}`,
      apiKey: this.apiKey,
      method,
      body,
      env: this.env,
      signal,
      clock: this.clock,
    });
  }
}

/**
 * Execute exactly one Relay Chat Completions request over SSE.
 *
 * Both the isolated model lab and the public ruling adapter use this transport
 * so timeout, abort, byte-limit and protocol handling cannot drift between the
 * two call sites. Reasoning deltas are validated and discarded by the shared
 * parser; only visible assistant content and safe usage metadata are returned.
 */
export async function requestRelayChatCompletionSse({
  fetchImpl = globalThis.fetch,
  endpoint,
  apiKey,
  method = "POST",
  body = {},
  env = globalThis.process?.env || {},
  signal,
  clock = defaultMonotonicClock,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("relay stream transport requires fetch");
  }
  if (typeof clock !== "function") {
    throw new TypeError("relay stream transport clock must be a function");
  }
  const normalizedApiKey = String(apiKey || "").trim();
  if (!normalizedApiKey) {
    throw new TypeError("relay stream transport requires a server-side API key");
  }
  const normalizedEndpoint = normalizeRelayStreamEndpoint(endpoint);
  const requestBody = {
    ...(isPlainObject(body) ? body : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
  const timeoutMaximumMs = readRelayStreamTimeoutMaximumMs(env);
  const timeoutMs = boundedPositiveInteger(
    env.RELAY_STREAM_TIMEOUT_MS,
    "RELAY_STREAM_TIMEOUT_MS",
    270_000,
    { minimum: 1_000, maximum: timeoutMaximumMs },
  );
  const maxBytes = boundedPositiveInteger(
    env.RELAY_STREAM_MAX_BYTES,
    "RELAY_STREAM_MAX_BYTES",
    16 * 1024 * 1024,
    { minimum: 1_024, maximum: 32 * 1024 * 1024 },
  );
  const maxContentBytes = boundedPositiveInteger(
    env.RELAY_STREAM_MAX_CONTENT_BYTES,
    "RELAY_STREAM_MAX_CONTENT_BYTES",
    1024 * 1024,
    { minimum: 1_024, maximum: 4 * 1024 * 1024 },
  );
  const controller = new AbortController();
  const externalAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) externalAbort();
  else signal?.addEventListener?.("abort", externalAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("relay stream timed out")),
    timeoutMs,
  );
  timeout.unref?.();
  const requestStartedAt = readMonotonicClock(clock);
  let requestToResponseHeadersMs = null;
  let response;
  try {
    response = await fetchImpl(normalizedEndpoint, {
      method,
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${normalizedApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    requestToResponseHeadersMs = elapsedMonotonicMs(clock, requestStartedAt);
    if (!response.ok) {
      const payload = await readResponsePayload(response, { signal: controller.signal });
      const outcomeKnown = isProvableHttpRejection(response.status);
      const failureKind = classifyRelayUpstreamFailure({
        status: response.status,
        code: payload?.error?.code || payload?.error?.type,
        message: typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message,
      });
      throw new RulingModelProviderError(
        safeRelayFailureMessage(failureKind, { status: response.status, transport: "HTTP" }),
        {
          code: failureKind === "access_denied"
            ? "relay_http_access_denied"
            : failureKind === "timeout"
              ? "relay_http_timeout"
              : "relay_http_error",
          provider: "relay",
          status: response.status,
          responseBody: payload,
          requestedModel: String(requestBody.model || "") || null,
          submittedModel: String(requestBody.model || "") || null,
          outcomeKnown,
          budgetReservationMayExist: !outcomeKnown,
          streamMetrics: makeRelayStreamMetrics({
            requestToResponseHeadersMs,
          }),
        },
      );
    }
    const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      throw new RulingModelProviderError(
        `relay stream returned unsupported content type ${contentType || "missing"}`,
        {
          code: "relay_stream_content_type_invalid",
          provider: "relay",
          status: response.status,
          outcomeKnown: false,
          budgetReservationMayExist: true,
          streamMetrics: makeRelayStreamMetrics({
            requestToResponseHeadersMs,
          }),
        },
      );
    }
    return await readRelayChatCompletionSse(response, {
      maxBytes,
      maxContentBytes,
      signal: controller.signal,
      clock,
      requestStartedAt,
      requestToResponseHeadersMs,
    });
  } catch (cause) {
    if (cause instanceof RulingModelProviderError) throw cause;
    const timedOut = (controller.signal.aborted
      && isTimeoutAbortReason(controller.signal.reason))
      || isTimeoutAbortReason(cause);
    throw new RulingModelProviderError(
      timedOut
        ? "relay stream timed out after submission"
        : "relay stream ended unexpectedly after submission",
      {
        code: timedOut ? "relay_stream_timeout" : "relay_stream_interrupted",
        provider: "relay",
        status: response?.status ?? null,
        outcomeKnown: false,
        budgetReservationMayExist: true,
        streamMetrics: makeRelayStreamMetrics({
          requestToResponseHeadersMs,
        }),
        cause,
      },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", externalAbort);
  }
}

function readRelayStreamTimeoutMaximumMs(env = {}) {
  const value = env.RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS;
  if (readBooleanFlag(env.VERCEL, false)) {
    if (value !== undefined && value !== null && value !== "") {
      throw new TypeError(
        "RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS is local-only and must not be set on Vercel",
      );
    }
    return 270_000;
  }
  if (value === undefined || value === null || value === "") return 280_000;
  return boundedPositiveInteger(
    value,
    "RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS",
    280_000,
    { minimum: 280_000, maximum: 3_600_000 },
  );
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

function buildCompatibleFinalRequest({
  providerId,
  env,
  model,
  reasoningEffort,
  reasoningMode,
  instructions,
  input,
  maxOutputTokens,
  metadata = {},
}) {
  const capability = ADMIN_MODEL_CAPABILITY_TABLE[String(model || "").trim()];
  const selection = resolveAdminModelSelection({
    provider: providerId,
    model,
    reasoningEffort: reasoningEffort || capability?.defaultReasoningEffort,
    reasoningMode: reasoningMode || capability?.defaultReasoningMode,
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  const finalInput = normalizeDeepSeekInput(input);
  if (!finalInput) throw new TypeError(`${providerId} final-ruling input must not be empty`);
  sanitizeMetadata(metadata, { requireTraceFields: true });
  const configuredRelayMaxTokens = providerId === "relay"
    ? optionalPositiveInteger(env?.RELAY_MAX_COMPLETION_TOKENS, "RELAY_MAX_COMPLETION_TOKENS")
    : undefined;
  const maxTokens = optionalPositiveInteger(maxOutputTokens, "maxOutputTokens")
    ?? configuredRelayMaxTokens
    ?? (selection.reasoningMode === "pro" ? 64_000 : 16_000);
  const deepSeekThinkingMode = providerId === "deepseek"
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
  body[new Set(["kimi", "relay"]).has(providerId)
    ? "max_completion_tokens"
    : "max_tokens"] = maxTokens;
  return { selection, body, maxTokens };
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

    const payload = await readResponsePayload(response, { signal });
    if (!response.ok) {
      const upstreamCode = payload?.error?.code || payload?.error?.type;
      const outcomeKnown = isProvableHttpRejection(response.status);
      throw new RulingModelProviderError(
        payload?.error?.message || `OpenAI Responses API returned HTTP ${response.status}`,
        {
          code: upstreamCode || "openai_http_error",
          provider: "openai",
          status: response.status,
          responseBody: payload,
          outcomeKnown,
          budgetReservationMayExist: !outcomeKnown,
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

function parseStrictJsonObject(text, providerId, { usage = null } = {}) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    throw confirmedPreparationContentError({
      providerId,
      contentFailureKind: "empty",
      code: `${providerId}_empty_content`,
      message: `${providerId} preparation response was empty`,
      usage,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(normalizedText);
  } catch (cause) {
    throw confirmedPreparationContentError({
      providerId,
      contentFailureKind: "invalid_json",
      code: `${providerId}_invalid_json`,
      message: `${providerId} preparation response was not valid JSON`,
      usage,
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw confirmedPreparationContentError({
      providerId,
      contentFailureKind: "invalid_json",
      code: `${providerId}_invalid_json_shape`,
      message: `${providerId} preparation response must be a JSON object`,
      usage,
    });
  }
  return parsed;
}

function confirmedPreparationContentError({
  providerId,
  contentFailureKind,
  code,
  message,
  usage,
  cause,
}) {
  return Object.assign(new RulingModelProviderError(message, {
    code,
    provider: providerId,
    status: 200,
    outcomeKnown: true,
    budgetReservationMayExist: true,
    usage,
    cause,
  }), {
    confirmedContentFailure: true,
    contentFailureKind,
  });
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

function boundedPositiveInteger(value, field, fallback, { minimum, maximum }) {
  const resolved = optionalPositiveInteger(value, field) ?? fallback;
  if (resolved < minimum || resolved > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function readBooleanFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (new Set(["1", "true", "yes", "on"]).has(normalized)) return true;
  if (new Set(["0", "false", "no", "off"]).has(normalized)) return false;
  throw new TypeError("RELAY_STREAM must be true or false when provided");
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

function normalizeRelayStreamEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(String(endpoint || "").trim());
  } catch {
    throw new TypeError("relay stream endpoint must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new TypeError("relay stream endpoint must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(
      "relay stream endpoint must not contain credentials, query parameters or fragments",
    );
  }
  return parsed.toString();
}

async function readResponsePayload(response, { signal } = {}) {
  const contentType = String(response?.headers?.get?.("content-type") || "");
  if (contentType.includes("application/json") && typeof response.json === "function") {
    try {
      return await awaitOperationOrAbort(() => response.json(), signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      return {};
    }
  }
  if (typeof response?.text === "function" || response?.body?.getReader) {
    const text = await readBoundedResponseText(response, 64 * 1024, { signal });
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {
        error: {
          code: "upstream_non_json_error",
          message: summarizeNonJsonProviderError(text, response?.status),
        },
      };
    }
  }
  return {};
}

function awaitOperationOrAbort(operation, signal) {
  if (typeof operation !== "function") {
    return Promise.reject(new TypeError("abortable operation must be a function"));
  }
  if (!signal || typeof signal.addEventListener !== "function") {
    return Promise.resolve().then(operation);
  }
  if (signal.aborted) return Promise.reject(abortReasonError(signal));

  let onAbort;
  const abortPromise = new Promise((resolve, reject) => {
    onAbort = () => reject(abortReasonError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the check/listener race for non-standard AbortSignal implementations.
    if (signal.aborted) onAbort();
  });
  const operationPromise = Promise.resolve().then(operation);
  return Promise.race([operationPromise, abortPromise]).finally(() => {
    signal.removeEventListener?.("abort", onAbort);
  });
}

function abortReasonError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const reason = signal?.reason;
  const error = new Error(reason === undefined || reason === null || reason === ""
    ? "relay operation aborted"
    : String(reason));
  error.name = "AbortError";
  if (reason !== undefined) error.cause = reason;
  return error;
}

function cancelReaderWithoutWaiting(reader, reason) {
  try {
    const cancellation = reader?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {
    // Best-effort cleanup only. Cancellation must never extend the deadline.
  }
}

async function readRelayChatCompletionSse(response, {
  maxBytes,
  maxContentBytes,
  signal,
  clock = defaultMonotonicClock,
  requestStartedAt = readMonotonicClock(clock),
  requestToResponseHeadersMs = null,
} = {}) {
  const reader = response?.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") {
    throw new RulingModelProviderError("relay stream response has no readable body", {
      code: "relay_stream_body_missing",
      provider: "relay",
      status: response?.status ?? 200,
      outcomeKnown: false,
      budgetReservationMayExist: true,
    });
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const state = {
    bytes: 0,
    networkChunks: 0,
    chunks: 0,
    contentChunks: 0,
    completionChunks: 0,
    done: false,
    finishReason: null,
    id: null,
    model: null,
    usage: null,
    content: "",
    contentBytes: 0,
    requestToFirstByteMs: null,
    requestToFirstEventMs: null,
    requestToFirstContentMs: null,
    requestToCompleteMs: null,
  };
  let buffer = "";
  const metrics = () => makeRelayStreamMetrics({
    requestToResponseHeadersMs,
    requestToFirstByteMs: state.requestToFirstByteMs,
    requestToFirstEventMs: state.requestToFirstEventMs,
    requestToFirstContentMs: state.requestToFirstContentMs,
    requestToCompleteMs: state.requestToCompleteMs,
    networkChunkCount: state.networkChunks,
    sseEventCount: state.chunks,
    visibleContentChunkCount: state.contentChunks,
    responseBytes: state.bytes,
    visibleContentBytes: state.contentBytes,
    finishReason: state.finishReason,
  });
  const streamError = (message, {
    code = "relay_stream_protocol_error",
    cause,
    outcomeKnown = false,
    budgetReservationMayExist = true,
  } = {}) => (
    new RulingModelProviderError(message, {
      code,
      provider: "relay",
      status: response?.status ?? 200,
      outcomeKnown,
      budgetReservationMayExist,
      usage: state.usage,
      model: state.model,
      reportedModel: state.model,
      requestId: state.id,
      streamMetrics: metrics(),
      cause,
    })
  );
  const protocolError = (message, code = "relay_stream_protocol_error", cause) => (
    streamError(message, { code, cause })
  );
  const processFrame = (rawFrame) => {
    const frame = String(rawFrame || "");
    if (!frame.trim()) return;
    if (state.done) throw protocolError("relay stream contained data after [DONE]");
    const dataLines = [];
    let eventName = "";
    for (const line of frame.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = (separator === -1 ? line : line.slice(0, separator)).trim();
      const rawValue = separator === -1 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "data") dataLines.push(value);
      else if (field === "event") eventName = value.trim().toLowerCase();
      else if (!new Set(["event", "id", "retry"]).has(field)) {
        throw protocolError(`relay stream used unsupported SSE field ${field || "missing"}`);
      }
    }
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    if (data === "[DONE]") {
      state.done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch (cause) {
      throw protocolError("relay stream contained malformed JSON", "relay_stream_json_invalid", cause);
    }
    if (!isPlainObject(chunk)) throw protocolError("relay stream chunk must be a JSON object");
    const embeddedError = relayStreamEmbeddedError(chunk, eventName);
    if (embeddedError) {
      const generatedBeforeRejection = state.completionChunks > 0
        || state.contentBytes > 0
        || state.usage !== null
        || relayChunkContainsCompletionOrUsage(chunk);
      const releaseSafe = embeddedError.kind === "access_denied" && !generatedBeforeRejection;
      throw streamError(
        safeRelayFailureMessage(embeddedError.kind, { transport: "stream" }),
        {
          code: embeddedError.kind === "access_denied"
            ? "relay_stream_access_denied"
            : embeddedError.kind === "timeout"
              ? "relay_stream_timeout"
              : "relay_stream_upstream_error",
          outcomeKnown: releaseSafe,
          budgetReservationMayExist: !releaseSafe,
        },
      );
    }
    state.chunks += 1;
    if (state.requestToFirstEventMs === null) {
      state.requestToFirstEventMs = elapsedMonotonicMs(clock, requestStartedAt);
    }
    if (state.chunks > 250_000) throw protocolError("relay stream exceeded the chunk limit");
    const chunkId = optionalBoundedString(chunk.id, "relay stream id", 512);
    const chunkModel = optionalBoundedString(chunk.model, "relay stream model", 256);
    state.id = mergeStableStreamIdentity(state.id, chunkId, "id", protocolError);
    state.model = mergeStableStreamIdentity(state.model, chunkModel, "model", protocolError);
    if (chunk.usage !== undefined && chunk.usage !== null) {
      state.usage = sanitizeRelayStreamUsage(chunk.usage, protocolError);
    }
    if (chunk.choices === undefined) return;
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 16) {
      throw protocolError("relay stream choices must be a bounded array");
    }
    for (const choice of chunk.choices) {
      if (!isPlainObject(choice) || choice.index !== 0) {
        throw protocolError("relay stream must contain only choice index 0");
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const finishReason = optionalBoundedString(
          choice.finish_reason,
          "relay stream finish_reason",
          128,
        );
        state.finishReason = mergeStableStreamIdentity(
          state.finishReason,
          finishReason,
          "finish_reason",
          protocolError,
        );
      }
      const completion = choice.delta !== undefined && choice.delta !== null
        ? choice.delta
        : choice.message;
      if (completion === undefined || completion === null) continue;
      if (!isPlainObject(completion)) {
        throw protocolError(choice.delta !== undefined
          ? "relay stream delta must be an object"
          : "relay stream message must be an object");
      }
      state.completionChunks += 1;
      for (const reasoningField of ["reasoning_content", "reasoning"]) {
        const reasoning = completion[reasoningField];
        if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") {
          throw protocolError(`relay stream ${reasoningField} must be text when present`);
        }
        // Reasoning content is deliberately validated and discarded. It is
        // never copied into the response, logs or persisted run data.
      }
      if (
        (Array.isArray(completion.tool_calls) && completion.tool_calls.length)
        || completion.function_call
      ) {
        throw protocolError("relay final-ruling stream must not contain tool calls");
      }
      const content = completion.content;
      if (content === undefined || content === null || content === "") continue;
      if (typeof content !== "string") throw protocolError("relay stream content must be text");
      const contentBytes = encoder.encode(content).byteLength;
      state.contentBytes += contentBytes;
      if (state.contentBytes > maxContentBytes) {
        throw protocolError("relay stream content exceeded the byte limit", "relay_stream_content_too_large");
      }
      state.contentChunks += 1;
      if (state.requestToFirstContentMs === null) {
        state.requestToFirstContentMs = elapsedMonotonicMs(clock, requestStartedAt);
      }
      state.content += content;
    }
  };
  const processBufferedFrames = ({ flush = false } = {}) => {
    while (true) {
      const match = /\r?\n\r?\n/u.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      processFrame(frame);
    }
    if (flush && buffer.trim()) {
      processFrame(buffer);
      buffer = "";
    }
    if (encoder.encode(buffer).byteLength > Math.min(maxBytes, 2 * 1024 * 1024)) {
      throw protocolError("relay stream event exceeded the byte limit", "relay_stream_event_too_large");
    }
  };
  try {
    while (true) {
      const { done, value } = await awaitOperationOrAbort(() => reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw protocolError("relay stream yielded a non-byte chunk");
      }
      state.networkChunks += 1;
      state.bytes += value.byteLength;
      if (value.byteLength > 0 && state.requestToFirstByteMs === null) {
        state.requestToFirstByteMs = elapsedMonotonicMs(clock, requestStartedAt);
      }
      if (state.bytes > maxBytes) {
        throw protocolError("relay stream exceeded the response byte limit", "relay_stream_too_large");
      }
      buffer += decoder.decode(value, { stream: true });
      processBufferedFrames();
    }
    buffer += decoder.decode();
    processBufferedFrames({ flush: true });
  } catch (cause) {
    cancelReaderWithoutWaiting(reader, cause);
    if (cause instanceof RulingModelProviderError) throw cause;
    const timedOut = (signal?.aborted && isTimeoutAbortReason(signal.reason))
      || isTimeoutAbortReason(cause);
    throw protocolError(
      timedOut
        ? "relay stream timed out after submission"
        : `relay stream was interrupted ${state.chunks ? "after" : "before"} the first valid chunk`,
      timedOut ? "relay_stream_timeout" : "relay_stream_interrupted",
      cause,
    );
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
  // Some OpenAI-compatible relays close a healthy HTTP body immediately after
  // the terminal choice instead of emitting the optional SSE [DONE] sentinel.
  // An explicit `finish_reason: stop` plus a clean EOF is a complete model
  // response; timeout/abort, missing finish reason and length truncation still
  // fail closed below.
  const cleanEofAfterStop = !state.done
    && state.finishReason === "stop"
    && Boolean(state.content.trim());
  if (!state.done && !cleanEofAfterStop) {
    throw protocolError("relay stream closed without [DONE]", "relay_stream_incomplete");
  }
  if (!state.chunks) {
    throw protocolError("relay stream completed without any JSON chunk", "relay_stream_empty");
  }
  if (!state.completionChunks) {
    throw protocolError(
      "relay stream completed without a supported completion payload",
      "relay_stream_completion_missing",
    );
  }
  if (!state.content.trim()) {
    throw protocolError(
      "relay stream completed without visible assistant content",
      "relay_stream_empty_content",
    );
  }
  state.requestToCompleteMs = elapsedMonotonicMs(clock, requestStartedAt);
  return {
    ...(state.id ? { id: state.id } : {}),
    ...(state.model ? { model: state.model } : {}),
    choices: [{
      index: 0,
      message: { role: "assistant", content: state.content },
      finish_reason: safeRelayFinishReason(state.finishReason),
    }],
    usage: state.usage,
    stream_metrics: metrics(),
  };
}

function defaultMonotonicClock() {
  const value = globalThis.performance?.now?.();
  return Number.isFinite(value) ? value : Date.now();
}

function isTimeoutAbortReason(reason) {
  const code = String(reason?.code || "").trim().toLowerCase();
  const message = String(reason?.message || reason || "");
  return code === "final_ruling_provider_timeout"
    || RELAY_TIMEOUT_PATTERN.test(code)
    || /(?:timed out|timeout|exceeded\s+\d+ms|etimedout|und_err_(?:headers|body)_timeout)/iu.test(message);
}

function readMonotonicClock(clock) {
  const value = Number(clock());
  if (!Number.isFinite(value)) throw new TypeError("provider clock must return a finite number");
  return value;
}

function elapsedMonotonicMs(clock, startedAt) {
  const elapsed = Math.max(0, readMonotonicClock(clock) - Number(startedAt));
  return Math.round(elapsed * 1_000) / 1_000;
}

function makeRelayStreamMetrics(value = {}) {
  return copySafeRelayStreamMetrics({
    schemaVersion: 1,
    transport: "sse",
    requestToResponseHeadersMs: null,
    requestToFirstByteMs: null,
    requestToFirstEventMs: null,
    requestToFirstContentMs: null,
    requestToCompleteMs: null,
    networkChunkCount: 0,
    sseEventCount: 0,
    visibleContentChunkCount: 0,
    responseBytes: 0,
    visibleContentBytes: 0,
    finishReason: null,
    ...value,
  });
}

function copySafeRelayStreamMetrics(value) {
  if (!isPlainObject(value)) return null;
  const duration = (field) => {
    const candidate = value[field];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : null;
  };
  const count = (field) => {
    const candidate = value[field];
    return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  };
  const finishReason = safeRelayFinishReason(value.finishReason);
  return {
    schemaVersion: 1,
    transport: "sse",
    requestToResponseHeadersMs: duration("requestToResponseHeadersMs"),
    requestToFirstByteMs: duration("requestToFirstByteMs"),
    requestToFirstEventMs: duration("requestToFirstEventMs"),
    requestToFirstContentMs: duration("requestToFirstContentMs"),
    requestToCompleteMs: duration("requestToCompleteMs"),
    networkChunkCount: count("networkChunkCount"),
    sseEventCount: count("sseEventCount"),
    visibleContentChunkCount: count("visibleContentChunkCount"),
    responseBytes: count("responseBytes"),
    visibleContentBytes: count("visibleContentBytes"),
    finishReason,
  };
}

function mergeStableStreamIdentity(previous, next, field, protocolError) {
  if (!next) return previous;
  if (previous && previous !== next) {
    throw protocolError(`relay stream changed ${field} between chunks`);
  }
  return previous || next;
}

function optionalBoundedString(value, field, maximumLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new TypeError(`${field} must be non-empty text within ${maximumLength} characters`);
  }
  return value.trim();
}

function relayStreamEmbeddedError(chunk, eventName = "") {
  const type = String(chunk?.type || "").trim().toLowerCase();
  const explicitError = chunk?.error !== undefined && chunk?.error !== null;
  const source = chunk?.error ?? chunk?.response?.error ?? chunk;
  const message = typeof source === "string"
    ? source
    : String(source?.message || source?.code || type || eventName || "unknown upstream error");
  const code = typeof source === "object" && source !== null
    ? String(source.code || source.type || chunk?.code || "")
    : String(chunk?.code || "");
  const statusCandidate = typeof source === "object" && source !== null
    ? source.status ?? source.status_code ?? chunk?.status
    : chunk?.status;
  const status = Number(statusCandidate);
  const kind = classifyRelayUpstreamFailure({
    status: Number.isInteger(status) ? status : null,
    code,
    message,
  });
  const errorLike = eventName === "error"
    || type === "error"
    || type === "response.failed"
    || explicitError
    || kind !== "provider_failure";
  if (!errorLike) return null;
  return {
    kind,
  };
}

function relayChunkContainsCompletionOrUsage(chunk) {
  if (chunk?.usage !== undefined && chunk?.usage !== null) return true;
  return (Array.isArray(chunk?.choices) ? chunk.choices : []).some((choice) => (
    choice?.delta !== undefined && choice?.delta !== null
  ) || (
    choice?.message !== undefined && choice?.message !== null
  ));
}

function classifyRelayUpstreamFailure({ status, code, message } = {}) {
  const numericStatus = Number(status);
  const searchable = `${String(code || "")} ${String(message || "")}`;
  if (numericStatus === 401 || numericStatus === 403 || RELAY_ACCESS_DENIED_PATTERN.test(searchable)) {
    return "access_denied";
  }
  if (RELAY_TIMEOUT_HTTP_STATUSES.has(numericStatus) || RELAY_TIMEOUT_PATTERN.test(searchable)) {
    return "timeout";
  }
  return "provider_failure";
}

function safeRelayFailureMessage(kind, { status, transport = "stream" } = {}) {
  const suffix = Number.isInteger(Number(status)) ? ` (HTTP ${Number(status)})` : "";
  if (kind === "access_denied") return `relay upstream denied model access${suffix}`;
  if (kind === "timeout") return `relay upstream timed out during ${transport}${suffix}`;
  return `relay upstream rejected the ${transport} request${suffix}`;
}

function safeRelayFinishReason(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return null;
  return RELAY_SAFE_FINISH_REASONS.has(normalized) ? normalized : "other";
}

function sanitizeRelayStreamUsage(value, protocolError) {
  if (!isPlainObject(value)) throw protocolError("relay stream usage must be an object");
  const result = {};
  for (const field of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "cache_write_tokens",
  ]) {
    if (value[field] === undefined) continue;
    if (!Number.isFinite(value[field]) || value[field] < 0) {
      throw protocolError(`relay stream usage.${field} must be a non-negative number`);
    }
    result[field] = value[field];
  }
  for (const [field, allowed] of Object.entries({
    prompt_tokens_details: ["cached_tokens", "cache_read_input_tokens", "cache_write_input_tokens", "cache_write_tokens"],
    completion_tokens_details: ["reasoning_tokens"],
    input_tokens_details: ["cached_tokens", "cache_read_input_tokens", "cache_write_input_tokens", "cache_write_tokens"],
    output_tokens_details: ["reasoning_tokens"],
  })) {
    if (value[field] === undefined || value[field] === null) continue;
    if (!isPlainObject(value[field])) throw protocolError(`relay stream usage.${field} must be an object`);
    const details = {};
    for (const detail of allowed) {
      if (value[field][detail] === undefined) continue;
      if (!Number.isFinite(value[field][detail]) || value[field][detail] < 0) {
        throw protocolError(`relay stream usage.${field}.${detail} must be a non-negative number`);
      }
      details[detail] = value[field][detail];
    }
    result[field] = details;
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedResponseText(response, maxBytes, { signal } = {}) {
  const reader = response?.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") {
    const text = typeof response?.text === "function"
      ? await awaitOperationOrAbort(() => response.text(), signal)
      : "";
    return new TextDecoder().decode(new TextEncoder().encode(String(text || "")).slice(0, maxBytes));
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await awaitOperationOrAbort(() => reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) break;
      const remaining = maxBytes - bytes;
      const part = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(decoder.decode(part, { stream: true }));
      bytes += part.byteLength;
      if (part.byteLength < value.byteLength) break;
    }
    chunks.push(decoder.decode());
  } finally {
    cancelReaderWithoutWaiting(reader, signal?.reason);
    try {
      reader.releaseLock?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
  return chunks.join("");
}

function summarizeNonJsonProviderError(text, status) {
  const source = String(text || "");
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] || "";
  const plain = source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[redacted-ip]")
    .replace(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/gu, "[redacted-ip]")
    .replace(/\s+/gu, " ")
    .trim();
  const safeTitle = String(title)
    .replace(/<[^>]+>/gu, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[redacted-ip]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  const prefix = `Upstream returned non-JSON HTTP ${Number(responseStatus(status)) || "unknown"}`;
  const summary = plain.slice(0, 700);
  return [prefix, safeTitle, summary]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 1_000);
}

function responseStatus(value) {
  return Number.isInteger(Number(value)) ? Number(value) : 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
