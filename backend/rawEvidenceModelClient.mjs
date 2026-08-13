import { createHash } from "node:crypto";

import { estimateOpenAIModelCost } from "./modelPricing.mjs";
import {
  DEFAULT_PUBLIC_RELAY_BASE_URL,
  DEFAULT_PUBLIC_RELAY_MODEL,
  resolvePublicRulingModelProfile,
} from "./publicRulingModelConfig.mjs";
import {
  getPublicModelBudgetStatus,
  releasePublicModelBudgetReservation,
  reservePublicModelBudget,
  resetPublicModelBudget,
  settlePublicModelBudget,
} from "./publicModelBudgetLedger.mjs";
import { requestRelayChatCompletionSse } from "./relayChatCompletionSseTransport.mjs";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_EXTRACTION_TIMEOUT_MS = 4500;
const DEEPSEEK_MODES = new Set(["enabled", "disabled"]);
const DEEPSEEK_EFFORTS = new Set(["low", "high", "max"]);
const RELAY_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const ANSWER_LEVELS = new Set([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
  "budget_limited",
]);
const extractionCache = new Map();
const extractionFlights = new Map();

/**
 * Public transport-only model client for the raw-evidence pipeline.
 *
 * There are no question-type branches, duel-state interpreters, handwritten
 * mechanism rules, semantic validators, Lua/formal calls or repair requests in
 * this module. The final model is invoked exactly once.
 */
export async function callRagModel({
  prompt = "",
  env = globalThis.process?.env || {},
  modelInvoker,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  thinkingMode,
  reasoningEffort,
  signal,
} = {}) {
  throwIfAborted(signal);
  const resolution = resolveRagProvider(env);
  const provider = resolution.provider;
  const modelName = finalModelName(provider, env);
  const generation = resolveGeneration({
    provider,
    env,
    thinkingMode,
    reasoningEffort,
  });
  const maxTokens = finalMaxTokens(provider, generation.thinkingMode, env);
  const forcedDryRun = dryRun === true || isEnabled(env.RAG_DRY_RUN);
  const remoteConfigured = provider !== "mock"
    && providerHasKey(provider, env)
    && typeof fetchImpl === "function";
  let preparedEndpoint = null;
  if (!modelInvoker && !forcedDryRun && remoteConfigured) {
    try {
      preparedEndpoint = provider === "relay"
        ? relayUrl(env.RELAY_BASE_URL || DEFAULT_PUBLIC_RELAY_BASE_URL)
        : deepSeekUrl(env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL);
    } catch (error) {
      return failureResult(error, {
        provider,
        modelName,
        resolution,
        generation,
        reservation: emptyReservation(provider, env),
        maxTokens,
        actualCost: 0,
      });
    }
  }
  const reservation = await reservePublicModelBudget({
    provider: provider === "mock" ? profileProvider(env) : provider,
    stage: "final_ruling",
    estimatedAmount: estimatePreflightCost({ provider, modelName, prompt, maxTokens, env }),
    env,
    fetchImpl,
    now,
    trackSpend: !modelInvoker && !forcedDryRun && remoteConfigured,
  });

  if (signal?.aborted) {
    await releasePublicModelBudgetReservation({ reservation, env, fetchImpl }).catch(() => null);
    throwIfAborted(signal);
  }
  if (forcedDryRun || !remoteConfigured && !modelInvoker) {
    return baseResult(neutralAnswer(
      "模型调用处于 dry-run 或未配置状态。",
      "model_not_called",
    ), {
      provider: "mock",
      modelName: "mock-raw-evidence",
      dryRun: true,
      warnings: [...resolution.warnings, ...generation.warnings, ...reservation.warnings],
      budgetStatus: reservation.status,
      generationConfig: generationConfig(modelName, maxTokens, generation),
    });
  }
  if (reservation.blocked) {
    return baseResult(neutralAnswer(
      "今日 API 预算已用完，未调用模型。",
      "api_daily_budget_exceeded",
      "budget_limited",
    ), {
      provider,
      modelName,
      dryRun: true,
      warnings: [...resolution.warnings, ...generation.warnings, ...reservation.warnings, "api_daily_budget_exceeded"],
      budgetStatus: reservation.status,
      generationConfig: generationConfig(modelName, maxTokens, generation),
    });
  }

  if (modelInvoker) {
    try {
      const invoked = await modelInvoker({
        prompt,
        provider,
        modelName,
        maxTokens,
        thinkingMode: generation.thinkingMode,
        reasoningEffort: generation.reasoningEffort,
        signal,
      });
      const response = normalizeInjectedResponse(invoked, modelName);
      const usageState = validateUsage(response.usage);
      return {
        ...parseFinalResult(response.rawText, {
          provider,
          modelName,
          warnings: unique([
            ...resolution.warnings,
            ...generation.warnings,
            ...(response.warnings || []),
            ...usageState.warnings,
          ]),
          budgetStatus: reservation.status,
        }),
        tokenUsage: usageState.present ? usageState.usage : {},
        estimatedCost: 0,
        estimatedCostCny: 0,
        estimatedCostUsd: 0,
        generationAttempts: [{
          attempt: "primary",
          requestModel: modelName,
          responseModel: response.responseModel || modelName,
          finishReason: response.finishReason || "",
          usage: usageState.usage,
        }],
        generationConfig: generationConfig(modelName, maxTokens, generation),
      };
    } catch (error) {
      return failureResult(error, {
        provider,
        modelName,
        resolution,
        generation,
        reservation,
        maxTokens,
      });
    }
  }

  try {
    const response = provider === "relay"
      ? await callRelay({
          prompt,
          env,
          modelName,
          maxTokens,
          fetchImpl,
          reasoningEffort: generation.reasoningEffort,
          signal,
          endpoint: preparedEndpoint,
        })
      : await callDeepSeek({
          prompt,
          env,
          modelName,
          maxTokens,
          fetchImpl,
          thinkingMode: generation.thinkingMode,
          reasoningEffort: generation.reasoningEffort,
          signal,
          endpoint: preparedEndpoint,
        });
    const usageState = validateUsage(response.usage);
    const tokenUsage = usageState.usage;
    const measured = estimateActualCost({ provider, modelName, usage: tokenUsage, env });
    const actualCost = usageState.complete
      ? measured
      : reservation.reservedAmount;
    let budgetStatus = reservation.status;
    const warnings = unique([
      ...resolution.warnings,
      ...generation.warnings,
      ...reservation.warnings,
      ...(response.warnings || []),
      ...usageState.warnings,
      ...(!usageState.complete
        ? ["provider_usage_incomplete_reservation_retained"]
        : []),
    ]);
    try {
      budgetStatus = await settlePublicModelBudget({
        reservation,
        actualAmount: actualCost,
        env,
        fetchImpl,
      });
    } catch (error) {
      warnings.push(`budget_spend_record_failed:${safeErrorMessage(error)}`);
      budgetStatus = { ...reservation.status, budgetStorage: "unavailable" };
    }
    return {
      ...parseFinalResult(response.rawText, {
        provider,
        modelName,
        warnings,
        budgetStatus,
      }),
      tokenUsage,
      ...costFields(reservation, actualCost),
      budgetStatus,
      generationAttempts: [summarizeAttempt(response)],
      generationConfig: generationConfig(modelName, maxTokens, generation),
    };
  } catch (error) {
    const releaseSafe = error?.budgetReservationReleaseSafe === true;
    const budgetStatus = releaseSafe
      ? await releasePublicModelBudgetReservation({ reservation, env, fetchImpl })
          .catch(() => reservation.status)
      : reservation.status;
    return failureResult(error, {
      provider,
      modelName,
      resolution,
      generation,
      reservation: { ...reservation, status: budgetStatus },
      maxTokens,
      actualCost: releaseSafe ? 0 : reservation.reservedAmount,
    });
  }
}

export function callCardNameExtractionModel(options = {}) {
  return callExtraction({ ...options, kind: "card" });
}

export function callRuleQueryExtractionModel(options = {}) {
  return callExtraction({ ...options, kind: "rule" });
}

async function callExtraction({
  kind,
  userQuery = "",
  dataRevision = "",
  env = globalThis.process?.env || {},
  modelInvoker,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  dryRun = false,
  signal,
} = {}) {
  throwIfAborted(signal);
  const resolution = kind === "card"
    ? resolveCardExtractionProvider(env)
    : resolveRuleQueryExtractionProvider(env);
  const provider = resolution.provider;
  const modelName = kind === "card"
    ? String(env.DEEPSEEK_CARD_MODEL || env.RAG_CARD_MODEL || DEFAULT_DEEPSEEK_MODEL)
    : String(env.DEEPSEEK_RULE_MODEL
        || env.RAG_RULE_MODEL
        || env.DEEPSEEK_CARD_MODEL
        || DEFAULT_DEEPSEEK_MODEL);
  const maxTokens = positiveNumber(
    kind === "card"
      ? env.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS
      : env.RAG_RULE_MODEL_MAX_OUTPUT_TOKENS,
    kind === "card" ? 800 : 700,
  );
  const prompt = kind === "card"
    ? cardExtractionPrompt(userQuery)
    : ruleQueryExtractionPrompt(userQuery);
  const empty = ({
    providerUsed = provider,
    modelUsed = modelName,
    warnings = [],
    dry = true,
    budgetStatus = null,
  } = {}) => ({
    ...(kind === "card" ? { candidates: [] } : { queries: [] }),
    rawText: "",
    providerUsed,
    modelUsed,
    dryRun: dry,
    warnings: unique(warnings),
    tokenUsage: {},
    estimatedCostCny: 0,
    estimatedCostUsd: 0,
    budgetStatus,
    cacheHit: false,
    singleflightHit: false,
  });

  if (dryRun === true || isEnabled(env.RAG_DRY_RUN)) {
    return empty({
      warnings: [...resolution.warnings, `${kind}_extraction_dry_run_skipped`],
    });
  }
  if (!modelInvoker && (provider === "mock"
      || !env.DEEPSEEK_API_KEY || typeof fetchImpl !== "function")) {
    return empty({
      providerUsed: "mock",
      modelUsed: `mock-${kind}-extractor`,
      warnings: resolution.warnings,
    });
  }
  let preparedEndpoint = null;
  if (!modelInvoker) {
    try {
      preparedEndpoint = deepSeekUrl(env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL);
    } catch (error) {
      return empty({
        warnings: [...resolution.warnings, `${kind}_extraction_config_invalid:${safeErrorMessage(error)}`],
        dry: false,
      });
    }
  }

  const cacheKey = sha256(JSON.stringify({
    kind,
    provider,
    modelName,
    dataRevision,
    prompt,
    maxTokens,
  }));
  const cached = readCache(cacheKey, env);
  if (cached) {
    return {
      ...structuredClone(cached),
      warnings: unique([...(cached.warnings || []), `${kind}_extraction_cache_hit`]),
      estimatedCostCny: 0,
      estimatedCostUsd: 0,
      cacheHit: true,
      singleflightHit: false,
    };
  }
  if (extractionFlights.has(cacheKey)) {
    const shared = await awaitWithSignal(extractionFlights.get(cacheKey), signal);
    return {
      ...structuredClone(shared),
      warnings: unique([...(shared.warnings || []), `${kind}_extraction_singleflight_hit`]),
      estimatedCostCny: 0,
      estimatedCostUsd: 0,
      cacheHit: false,
      singleflightHit: true,
    };
  }

  const flight = (async () => {
    const reservation = await reservePublicModelBudget({
      provider: "deepseek",
      stage: "evidence_preparation",
      estimatedAmount: estimatePreflightCost({
        provider: "deepseek",
        modelName,
        prompt,
        maxTokens,
        env,
      }),
      env,
      fetchImpl,
      now,
      trackSpend: !modelInvoker,
    });
    if (signal?.aborted) {
      await releasePublicModelBudgetReservation({ reservation, env, fetchImpl }).catch(() => null);
      throwIfAborted(signal);
    }
    if (reservation.blocked) {
      return empty({
        warnings: [...resolution.warnings, ...reservation.warnings, "api_daily_budget_exceeded_extraction_skipped"],
        budgetStatus: reservation.status,
      });
    }
    try {
      const response = modelInvoker
        ? await modelInvoker({
            prompt,
            provider,
            modelName,
            maxTokens,
            task: kind === "card" ? "card_name_extraction" : "rule_query_extraction",
            signal,
          })
        : await callDeepSeekWithTimeout({
            prompt,
            env,
            modelName,
            maxTokens,
            fetchImpl,
            signal,
            endpoint: preparedEndpoint,
            timeoutMs: positiveNumber(
              kind === "card"
                ? env.RAG_CARD_MODEL_TIMEOUT_MS
                : env.RAG_RULE_MODEL_TIMEOUT_MS,
              DEFAULT_EXTRACTION_TIMEOUT_MS,
            ),
          });
      const normalizedResponse = modelInvoker
        ? normalizeInjectedResponse(response, modelName)
        : response;
      const raw = normalizedResponse.rawText;
      const items = kind === "card"
        ? normalizeCardCandidates(raw)
        : normalizeRuleQueries(raw);
      const usageState = validateUsage(normalizedResponse?.usage || {});
      const usage = usageState.usage;
      const actualCost = modelInvoker
        ? 0
        : usageState.complete
          ? estimateActualCost({ provider: "deepseek", modelName, usage, env })
          : reservation.reservedAmount;
      const budgetStatus = modelInvoker
        ? reservation.status
        : await settlePublicModelBudget({
            reservation,
            actualAmount: actualCost,
            env,
            fetchImpl,
          }).catch(() => ({ ...reservation.status, budgetStorage: "unavailable" }));
      const result = {
        ...(kind === "card" ? { candidates: items } : { queries: items }),
        rawText: typeof raw === "string" ? raw : JSON.stringify(raw || {}),
        providerUsed: provider,
        modelUsed: modelName,
        dryRun: false,
        warnings: unique([
          ...resolution.warnings,
          ...(normalizedResponse?.warnings || []),
          ...usageState.warnings,
          ...(!modelInvoker && !usageState.complete
            ? ["provider_usage_incomplete_reservation_retained"]
            : []),
        ]),
        tokenUsage: usage,
        estimatedCostCny: actualCost,
        estimatedCostUsd: 0,
        budgetStatus,
        cacheHit: false,
        singleflightHit: false,
      };
      if (items.length) writeCache(cacheKey, result, env);
      return result;
    } catch (error) {
      const releaseSafe = error?.budgetReservationReleaseSafe === true;
      const budgetStatus = releaseSafe
        ? await releasePublicModelBudgetReservation({ reservation, env, fetchImpl })
            .catch(() => reservation.status)
        : reservation.status;
      return empty({
        warnings: [...resolution.warnings, `${kind}_extraction_failed:${safeErrorMessage(error)}`],
        dry: false,
        budgetStatus,
      });
    }
  })();
  extractionFlights.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    if (extractionFlights.get(cacheKey) === flight) extractionFlights.delete(cacheKey);
  }
}

export function resolveRagProvider(env = {}) {
  const requested = String(env.RAG_MODEL_PROVIDER || env.MODEL_PROVIDER || "auto")
    .trim()
    .toLowerCase() || "auto";
  const warnings = [];
  if (requested === "mock") return { provider: "mock", requested, warnings };
  if (requested === "relay") {
    if (!String(env.RELAY_API_KEY || "").trim()) warnings.push("relay_api_key_missing_using_mock");
    return { provider: env.RELAY_API_KEY ? "relay" : "mock", requested, warnings };
  }
  if (requested === "deepseek") {
    if (!String(env.DEEPSEEK_API_KEY || "").trim()) warnings.push("deepseek_api_key_missing_using_mock");
    return { provider: env.DEEPSEEK_API_KEY ? "deepseek" : "mock", requested, warnings };
  }
  if (requested !== "auto") warnings.push(`unsupported_model_provider:${requested}`);
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", requested, warnings };
  warnings.push("no_model_api_key_using_mock");
  return { provider: "mock", requested, warnings };
}

export function resolveCardExtractionProvider(env = {}) {
  return auxiliaryProvider({
    enabled: env.RAG_CARD_EXTRACTOR_ENABLED,
    requested: env.RAG_CARD_MODEL_PROVIDER,
    env,
  });
}

export function resolveRuleQueryExtractionProvider(env = {}) {
  return auxiliaryProvider({
    enabled: env.RAG_RULE_QUERY_EXTRACTOR_ENABLED,
    requested: env.RAG_RULE_MODEL_PROVIDER || env.RAG_CARD_MODEL_PROVIDER,
    env,
  });
}

function auxiliaryProvider({ enabled, requested, env }) {
  if (isDisabled(enabled)) {
    return { provider: "mock", requested: "disabled", warnings: ["extraction_model_disabled"] };
  }
  const normalized = String(requested || "deepseek").trim().toLowerCase();
  if (normalized === "mock") return { provider: "mock", requested: normalized, warnings: [] };
  if (normalized !== "deepseek") {
    return { provider: "mock", requested: normalized, warnings: [`unsupported_extraction_provider:${normalized}`] };
  }
  return env.DEEPSEEK_API_KEY
    ? { provider: "deepseek", requested: normalized, warnings: [] }
    : { provider: "mock", requested: normalized, warnings: ["deepseek_api_key_missing_extraction_disabled"] };
}

export function createPublicAnswerModelEnv(env = {}, profileValue) {
  const source = env && typeof env === "object" ? env : {};
  const result = { ...source };
  for (const key of Object.keys(result)) {
    if (/^(?:OPENAI_|ADMIN_|GLM_|KIMI_)/iu.test(key)) delete result[key];
  }
  const profile = resolvePublicRulingModelProfile(
    profileValue || source.PUBLIC_RULING_MODEL_PROFILE,
  );
  if (profile.provider !== "relay") {
    for (const key of Object.keys(result)) {
      if (/^RELAY_/iu.test(key)) delete result[key];
    }
  }
  const mockRequested = [source.RAG_MODEL_PROVIDER, source.MODEL_PROVIDER]
    .some((value) => String(value || "").trim().toLowerCase() === "mock");
  const provider = mockRequested ? "mock" : profile.provider;
  Object.assign(result, {
    MODEL_PROVIDER: provider,
    RAG_MODEL_PROVIDER: provider,
    RAG_MODEL: profile.model,
    RAG_THINKING_MODE: profile.thinkingMode,
    RAG_REASONING_EFFORT: profile.reasoningEffort,
    PUBLIC_RULING_MODEL_PROFILE: profile.id,
    RAG_MODEL_TIER: "flash",
    RAG_CARD_MODEL_PROVIDER: mockRequested ? "mock" : "deepseek",
    RAG_RULE_MODEL_PROVIDER: mockRequested ? "mock" : "deepseek",
    DEEPSEEK_CARD_MODEL: String(source.DEEPSEEK_CARD_MODEL || DEFAULT_DEEPSEEK_MODEL),
  });
  result.DEEPSEEK_RULE_MODEL = String(
    source.DEEPSEEK_RULE_MODEL || result.DEEPSEEK_CARD_MODEL,
  );
  return result;
}

export const getRagBudgetStatus = getPublicModelBudgetStatus;
export const resetRagBudget = resetPublicModelBudget;

async function callDeepSeek({
  prompt,
  env,
  modelName,
  maxTokens,
  fetchImpl,
  thinkingMode,
  reasoningEffort,
  signal,
  endpoint,
}) {
  const body = {
    model: modelName || DEFAULT_DEEPSEEK_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    ...(thinkingMode === "enabled"
      ? {}
      : { response_format: { type: "json_object" } }),
    ...(Number.isFinite(maxTokens) ? { max_tokens: Math.floor(maxTokens) } : {}),
  };
  if (DEEPSEEK_MODES.has(thinkingMode)) body.thinking = { type: thinkingMode };
  if (thinkingMode === "enabled" && DEEPSEEK_EFFORTS.has(reasoningEffort)) {
    body.reasoning_effort = reasoningEffort;
  } else {
    body.temperature = finiteNumber(env.RAG_MODEL_TEMPERATURE, 0);
  }
  let response;
  try {
    response = await fetchImpl(endpoint || deepSeekUrl(env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw providerError(cause, { mayExist: true });
  }
  if (!response.ok) {
    const releaseSafe = response.status >= 400
      && response.status < 500
      && ![408, 409, 425, 429].includes(response.status);
    throw providerError(new Error(`deepseek ${response.status}`), {
      mayExist: !releaseSafe,
      status: response.status,
    });
  }
  const payload = await response.json();
  return normalizeChatPayload(payload, body, {
    provider: "deepseek",
    thinkingMode,
    reasoningEffort,
    transport: "chat_completions",
  });
}

async function callDeepSeekWithTimeout(options) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener?.("abort", relayAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("extraction model timeout")),
    options.timeoutMs,
  );
  timer.unref?.();
  try {
    return await callDeepSeek({
      ...options,
      thinkingMode: "disabled",
      reasoningEffort: null,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", relayAbort);
  }
}

async function callRelay({
  prompt,
  env,
  modelName,
  maxTokens,
  fetchImpl,
  reasoningEffort,
  signal,
  endpoint,
}) {
  const body = {
    model: modelName || DEFAULT_PUBLIC_RELAY_MODEL,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    ...(RELAY_EFFORTS.has(reasoningEffort)
      ? { reasoning_effort: reasoningEffort }
      : {}),
    ...(Number.isFinite(maxTokens)
      ? { max_completion_tokens: Math.floor(maxTokens) }
      : {}),
  };
  const payload = await requestRelayChatCompletionSse({
    fetchImpl,
    endpoint: endpoint || relayUrl(env.RELAY_BASE_URL || DEFAULT_PUBLIC_RELAY_BASE_URL),
    apiKey: env.RELAY_API_KEY,
    body,
    env,
    signal,
  });
  return normalizeChatPayload(payload, body, {
    provider: "relay",
    thinkingMode: "not_applicable",
    reasoningEffort,
    transport: "chat_completions_sse",
  });
}

function normalizeChatPayload(payload, requestBody, {
  provider,
  thinkingMode,
  reasoningEffort,
  transport,
}) {
  const choice = payload?.choices?.[0] || {};
  const rawText = extractText(choice?.message?.content);
  const finishReason = String(choice?.finish_reason || "");
  return {
    rawText,
    finishReason,
    requestModel: String(requestBody.model || ""),
    responseModel: String(payload?.model || ""),
    requestId: String(payload?.id || ""),
    systemFingerprint: String(payload?.system_fingerprint || ""),
    thinkingMode,
    reasoningEffort: reasoningEffort || null,
    maxOutputTokens: requestBody.max_tokens
      || requestBody.max_completion_tokens
      || null,
    responseFormat: "json_object",
    transport,
    streamMetrics: payload?.stream_metrics || null,
    usage: payload?.usage || {},
    warnings: unique([
      ...(!rawText ? [`${provider}_empty_content:${finishReason || "unknown"}`] : []),
      ...(finishReason === "length"
        ? [`${provider}_output_truncated_by_token_limit`]
        : []),
      ...(provider === "relay"
          && payload?.model
          && payload.model !== requestBody.model
        ? ["relay_response_model_mismatch"]
        : []),
    ]),
  };
}

function parseFinalResult(raw, {
  provider,
  modelName,
  warnings = [],
  budgetStatus = null,
}) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? parseJsonObject(raw) : raw;
  } catch (error) {
    return baseResult(neutralAnswer(
      "模型输出格式不完整，未生成可展示的裁定。",
      "model_json_parse_failed",
    ), {
      provider,
      modelName,
      rawText: typeof raw === "string" ? raw : "",
      warnings: [...warnings, `model_json_parse_failed:${safeErrorMessage(error)}`],
      budgetStatus,
    });
  }
  const answer = normalizeAnswer(parsed);
  if (!answer) {
    return baseResult(neutralAnswer(
      "模型输出字段不完整，未生成可展示的裁定。",
      "model_json_invalid_schema",
    ), {
      provider,
      modelName,
      rawText: typeof raw === "string" ? raw : JSON.stringify(raw || {}),
      warnings: [...warnings, "model_json_invalid_schema"],
      budgetStatus,
    });
  }
  return baseResult(answer, {
    provider,
    modelName,
    rawText: JSON.stringify(answer),
    warnings,
    budgetStatus,
  });
}

function normalizeAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ANSWER_LEVELS.has(String(value.answerLevel || ""))) return null;
  const shortAnswer = typeof value.shortAnswer === "string"
    ? value.shortAnswer.trim()
    : "";
  const reasoning = (Array.isArray(value.reasoning)
    ? value.reasoning
    : typeof value.reasoning === "string"
      ? [value.reasoning]
      : [])
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!shortAnswer || !reasoning.length) return null;
  return {
    answerLevel: String(value.answerLevel),
    shortAnswer,
    reasoning,
    usedCards: stringList(value.usedCards, 12),
    usedEvidence: (Array.isArray(value.usedEvidence) ? value.usedEvidence : [])
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        id: String(item.id || "").trim(),
        type: String(item.type || "related").trim(),
        title: String(item.title || "").trim(),
      }))
      .filter((item) => item.id)
      .slice(0, 12),
    missingInfo: stringList(value.missingInfo, 12),
    riskFlags: stringList(value.riskFlags, 12),
    confidenceSelfEstimate: ["low", "medium", "high"].includes(
      value.confidenceSelfEstimate,
    ) ? value.confidenceSelfEstimate : "low",
  };
}

function baseResult(answer, {
  provider = "mock",
  modelName = "mock-raw-evidence",
  dryRun = false,
  warnings = [],
  rawText = "",
  budgetStatus = null,
  generationConfig: config,
  providerFailure,
} = {}) {
  return {
    answer,
    rawText,
    provider,
    providerUsed: provider,
    modelName,
    modelUsed: modelName,
    dryRun,
    warnings: unique(warnings),
    tokenUsage: {},
    estimatedCost: 0,
    estimatedCostCny: 0,
    estimatedCostUsd: 0,
    budgetStatus,
    ...(config ? { generationConfig: config } : {}),
    ...(providerFailure ? { providerFailure } : {}),
  };
}

function failureResult(error, {
  provider,
  modelName,
  resolution,
  generation,
  reservation,
  maxTokens,
  actualCost = 0,
}) {
  const kind = classifyFailure(error);
  const shortAnswer = kind === "timeout"
    ? "模型服务本次响应超时，未生成可展示的裁定。"
    : kind === "access_denied"
      ? "模型服务拒绝了本次请求，未生成可展示的裁定。"
      : "模型服务本次调用失败，未生成可展示的裁定。";
  return {
    ...baseResult(neutralAnswer(
      shortAnswer,
      `model_call_failed:${kind}`,
    ), {
      provider,
      modelName,
      warnings: [
        ...resolution.warnings,
        ...generation.warnings,
        ...reservation.warnings,
        `model_call_failed:${safeErrorMessage(error)}`,
      ],
      budgetStatus: reservation.status,
      generationConfig: generationConfig(modelName, maxTokens, generation),
      providerFailure: { kind, message: safeErrorMessage(error) },
    }),
    ...costFields(reservation, actualCost),
    generationAttempts: [{
      attempt: "primary",
      requestModel: modelName,
      responseModel: "",
      finishReason: "error",
    }],
  };
}

function neutralAnswer(shortAnswer, riskFlag, answerLevel = "needs_more_info") {
  return {
    answerLevel,
    shortAnswer,
    reasoning: ["系统没有使用本地规则模板或派生语义补造裁定结论。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: [riskFlag],
    confidenceSelfEstimate: "low",
  };
}

function cardExtractionPrompt(userQuery) {
  return [
    "从用户问题中抽取明确出现的游戏王卡片名称表面文本。不要推理裁定，不要补写题面未出现的卡名。",
    "输出 JSON：{\"cardNames\":[{\"name\":\"数据库中的完整正式卡名（不知道则保持原文）\",\"originalText\":\"题面原文\",\"confidence\":\"low|medium|high\"}]}。",
    String(userQuery || "").slice(0, 12000),
  ].join("\n");
}

function ruleQueryExtractionPrompt(userQuery) {
  return [
    "为游戏王 OCG 原始规则资料做词法检索词抽取。不要回答问题，不要判断合法性，不要生成规则。",
    "输出 JSON：{\"ruleQueries\":[{\"query\":\"题面中可用于检索的短语\"}]}，最多 8 条。只保留题面明示的动作、区域、状态与规则术语。",
    String(userQuery || "").slice(0, 12000),
  ].join("\n");
}

function normalizeCardCandidates(raw) {
  let parsed;
  try { parsed = typeof raw === "string" ? parseJsonObject(raw) : raw; } catch { return []; }
  const source = parsed?.cardNames || parsed?.cards || parsed?.names || [];
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(source) ? source : []) {
    const name = String(
      typeof item === "string" ? item : item?.name || item?.cardName || "",
    ).trim().slice(0, 100);
    const originalText = String(
      typeof item === "string"
        ? item
        : item?.originalText || item?.surface || item?.mention || name,
    ).trim().slice(0, 100);
    const key = `${name.normalize("NFKC").toLowerCase()}\u0000${originalText.normalize("NFKC").toLowerCase()}`;
    if (name.length < 2 || !originalText || seen.has(key)) continue;
    seen.add(key);
    result.push({
      name,
      originalText,
      confidence: ["low", "medium", "high"].includes(item?.confidence)
        ? item.confidence
        : "medium",
      source: "model_card_name_extractor",
    });
    if (result.length >= 12) break;
  }
  return result;
}

function normalizeRuleQueries(raw) {
  let parsed;
  try { parsed = typeof raw === "string" ? parseJsonObject(raw) : raw; } catch { return []; }
  const source = parsed?.ruleQueries || parsed?.queries || parsed?.keywords || [];
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(source) ? source : []) {
    const query = String(
      typeof item === "string"
        ? item
        : item?.query || item?.searchQuery || item?.keyword || "",
    ).replace(/\s+/gu, " ").trim().slice(0, 160);
    const key = query.normalize("NFKC").toLowerCase();
    if (query.length < 2 || seen.has(key)) continue;
    seen.add(key);
    result.push({ query });
    if (result.length >= 8) break;
  }
  return result;
}

function parseJsonObject(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("model output must be a JSON object");
  }
  return parsed;
}

function resolveGeneration({ provider, env, thinkingMode, reasoningEffort }) {
  if (provider === "relay") {
    let effort = String(
      reasoningEffort
        || env.RAG_REASONING_EFFORT
        || env.RELAY_REASONING_EFFORT
        || "low",
    ).toLowerCase();
    const warnings = ["third_party_relay_model_identity_unverified"];
    if (!RELAY_EFFORTS.has(effort)) {
      effort = "low";
      warnings.push("relay_reasoning_effort_invalid_defaulted_low");
    }
    return {
      thinkingMode: "not_applicable",
      reasoningEffort: effort,
      warnings,
    };
  }
  let mode = String(thinkingMode || env.RAG_THINKING_MODE || "enabled").toLowerCase();
  let effort = String(reasoningEffort || env.RAG_REASONING_EFFORT || "low").toLowerCase();
  const warnings = [];
  if (!DEEPSEEK_MODES.has(mode)) {
    mode = "enabled";
    warnings.push("deepseek_thinking_mode_invalid_defaulted_enabled");
  }
  if (!DEEPSEEK_EFFORTS.has(effort)) {
    effort = "low";
    warnings.push("deepseek_reasoning_effort_invalid_defaulted_low");
  }
  return {
    thinkingMode: mode,
    reasoningEffort: mode === "enabled" ? effort : null,
    warnings,
  };
}

function finalMaxTokens(provider, thinkingMode, env) {
  if (Number(env.RAG_MAX_OUTPUT_TOKENS) > 0) {
    return Math.floor(Number(env.RAG_MAX_OUTPUT_TOKENS));
  }
  if (provider === "relay") {
    return positiveNumber(env.RELAY_MAX_COMPLETION_TOKENS, 32000);
  }
  return thinkingMode === "enabled"
    ? positiveNumber(env.RAG_THINKING_MAX_OUTPUT_TOKENS, 32000)
    : positiveNumber(env.RAG_FLASH_MAX_OUTPUT_TOKENS, 8000);
}

function finalModelName(provider, env) {
  if (provider === "relay") {
    return String(env.RAG_MODEL || env.RELAY_MODEL || DEFAULT_PUBLIC_RELAY_MODEL);
  }
  if (provider === "deepseek") {
    return String(
      env.RAG_MODEL
        || env.DEEPSEEK_FLASH_MODEL
        || env.DEEPSEEK_MODEL
        || DEFAULT_DEEPSEEK_MODEL,
    );
  }
  return "mock-raw-evidence";
}

function profileProvider(env) {
  return String(env.PUBLIC_RULING_MODEL_PROFILE || "").startsWith("relay-")
    ? "relay"
    : "deepseek";
}

function providerHasKey(provider, env) {
  return provider === "relay"
    ? Boolean(String(env.RELAY_API_KEY || "").trim())
    : provider === "deepseek"
      ? Boolean(String(env.DEEPSEEK_API_KEY || "").trim())
      : false;
}

function relayUrl(value) {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
    throw new TypeError("RELAY_BASE_URL must be a credential-free HTTPS URL");
  }
  return chatUrl(parsed.toString());
}

function deepSeekUrl(value) {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
    throw new TypeError("DEEPSEEK_BASE_URL must be a credential-free HTTPS URL");
  }
  return chatUrl(parsed.toString());
}

function chatUrl(value) {
  const base = String(value || "").replace(/\/+$/u, "");
  return base.endsWith("/chat/completions")
    ? base
    : `${base}/chat/completions`;
}

function normalizeUsage(value = {}) {
  const prompt = firstFinite(
    value.prompt_tokens,
    value.input_tokens,
    value.inputTokens,
  );
  const completion = firstFinite(
    value.completion_tokens,
    value.output_tokens,
    value.outputTokens,
  );
  const total = firstFinite(
    value.total_tokens,
    value.totalTokens,
    prompt + completion,
  );
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

function hasCompleteUsage(value = {}) {
  return validateUsage(value).complete;
}

function validateUsage(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const inputValue = firstPresent(source, ["prompt_tokens", "input_tokens", "inputTokens"]);
  const outputValue = firstPresent(source, ["completion_tokens", "output_tokens", "outputTokens"]);
  const totalValue = firstPresent(source, ["total_tokens", "totalTokens"]);
  const input = strictTokenCount(inputValue);
  const output = strictTokenCount(outputValue);
  const total = strictTokenCount(totalValue);
  const warnings = [];
  if (inputValue.present && input === null) warnings.push("provider_usage_invalid_input_tokens");
  if (outputValue.present && output === null) warnings.push("provider_usage_invalid_output_tokens");
  if (totalValue.present && total === null) warnings.push("provider_usage_invalid_total_tokens");
  const computedTotal = (input ?? 0) + (output ?? 0);
  if (total !== null && input !== null && output !== null && total !== computedTotal) {
    warnings.push("provider_usage_total_mismatch");
  }
  const complete = input !== null
    && output !== null
    && (!totalValue.present || total === computedTotal);
  return {
    present: inputValue.present || outputValue.present || totalValue.present,
    complete,
    warnings,
    usage: {
      prompt_tokens: input ?? 0,
      completion_tokens: output ?? 0,
      total_tokens: complete ? computedTotal : 0,
    },
  };
}

function estimateActualCost({ provider, modelName, usage, env }) {
  if (provider === "relay") {
    try {
      return roundCost(estimateOpenAIModelCost({
        model: modelName,
        usage,
        inputBillingBasis: "all_uncached",
      }).totalCostUsd);
    } catch {
      return 0;
    }
  }
  const inputPrice = finiteNumber(
    env.DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK,
    finiteNumber(env.DEEPSEEK_INPUT_CNY_PER_MTOK, 1),
  );
  const outputPrice = finiteNumber(
    env.DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK,
    finiteNumber(env.DEEPSEEK_OUTPUT_CNY_PER_MTOK, 2),
  );
  return roundCost(
    usage.prompt_tokens / 1_000_000 * inputPrice
      + usage.completion_tokens / 1_000_000 * outputPrice,
  );
}

function estimatePreflightCost({ provider, modelName, prompt, maxTokens, env }) {
  const promptTokens = provider === "relay"
    ? new TextEncoder().encode(String(prompt || "")).byteLength
    : Math.ceil(String(prompt || "").length / 4);
  return estimateActualCost({
    provider,
    modelName,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: maxTokens,
      total_tokens: promptTokens + maxTokens,
    },
    env,
  });
}

function costFields(reservation, amount) {
  const value = roundCost(amount);
  const currency = reservation?.bucketConfig?.currency || "CNY";
  return {
    costCurrency: currency,
    estimatedCost: value,
    estimatedCostCny: currency === "CNY" ? value : 0,
    estimatedCostUsd: currency === "USD" ? value : 0,
  };
}

function classifyFailure(error) {
  if (error?.failureKind) return error.failureKind;
  const text = `${error?.message || ""} ${error?.code || ""}`;
  const status = Number(error?.status);
  if ([401, 403].includes(status)
      || /access|forbidden|unauthori[sz]ed|permission|权限|拒绝/iu.test(text)) {
    return "access_denied";
  }
  if ([408, 504, 524].includes(status)
      || /timeout|timed out|aborted|超时/iu.test(text)) {
    return "timeout";
  }
  return "provider_failure";
}

function providerError(error, { mayExist, status = null }) {
  const result = error instanceof Error ? error : new Error(String(error));
  result.status = status;
  result.budgetReservationMayExist = mayExist === true;
  result.budgetReservationReleaseSafe = mayExist !== true;
  return result;
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return String(value.text || value.content || "");
}

function generationConfig(modelName, maxTokens, generation) {
  return {
    requestModel: modelName,
    maxOutputTokens: maxTokens,
    thinkingMode: generation.thinkingMode,
    reasoningEffort: generation.reasoningEffort,
  };
}

function summarizeAttempt(response) {
  return {
    attempt: "primary",
    requestModel: response.requestModel,
    responseModel: response.responseModel,
    finishReason: response.finishReason,
    thinkingMode: response.thinkingMode,
    reasoningEffort: response.reasoningEffort,
    maxOutputTokens: response.maxOutputTokens,
    responseFormat: response.responseFormat,
    usage: validateUsage(response.usage).usage,
  };
}

function normalizeInjectedResponse(value, fallbackModel) {
  if (value && typeof value === "object" && !Array.isArray(value)
      && Object.hasOwn(value, "rawText")) {
    return {
      rawText: typeof value.rawText === "string"
        ? value.rawText
        : JSON.stringify(value.rawText || {}),
      usage: value.usage || {},
      warnings: Array.isArray(value.warnings) ? value.warnings : [],
      responseModel: String(value.responseModel || value.model || fallbackModel || ""),
      finishReason: String(value.finishReason || value.finish_reason || ""),
    };
  }
  return {
    rawText: typeof value === "string" ? value : JSON.stringify(value || {}),
    usage: {},
    warnings: [],
    responseModel: String(fallbackModel || ""),
    finishReason: "",
  };
}

function emptyReservation(provider, env) {
  const currency = provider === "relay" ? "USD" : "CNY";
  return {
    blocked: false,
    reservedAmount: 0,
    warnings: [],
    bucketConfig: { currency },
    status: {
      spentTodayCny: 0,
      bucket: {
        currency,
        spentTodayCny: currency === "CNY" ? 0 : null,
        spentTodayUsd: currency === "USD" ? 0 : null,
        estimatedThisCallCny: 0,
      },
      budgetStorage: env?.VERCEL ? "unavailable" : "memory",
    },
  };
}

async function awaitWithSignal(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return await promise;
  return await new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
    };
    const cleanup = () => signal.removeEventListener?.("abort", abort);
    signal.addEventListener?.("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function firstPresent(value, keys) {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) return { present: true, value: value[key] };
  }
  return { present: false, value: undefined };
}

function strictTokenCount(entry) {
  if (!entry.present) return null;
  if (typeof entry.value !== "number"
      || !Number.isFinite(entry.value)
      || entry.value < 0
      || !Number.isInteger(entry.value)) return null;
  return entry.value;
}

function readCache(key, env) {
  const item = extractionCache.get(key);
  const ttlMs = positiveNumber(env.RAG_EXTRACTION_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
  if (!item || Date.now() - item.createdAt > ttlMs) {
    extractionCache.delete(key);
    return null;
  }
  return item.value;
}

function writeCache(key, value, env) {
  extractionCache.set(key, {
    createdAt: Date.now(),
    value: structuredClone(value),
  });
  const limit = positiveNumber(env.RAG_EXTRACTION_CACHE_MAX_ENTRIES, 200);
  while (extractionCache.size > limit) {
    extractionCache.delete(extractionCache.keys().next().value);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("request aborted");
}

function stringList(value, limit) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isDisabled(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").toLowerCase());
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error || "unknown")
    .replace(/\s+/gu, "_")
    .slice(0, 160);
}
