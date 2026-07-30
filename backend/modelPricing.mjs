import { readFileSync } from "node:fs";

const DEFAULT_PRICING_FILE_URL = new URL("../data/model-pricing.json", import.meta.url);
const DEFAULT_PRICING = loadAndValidatePricing(DEFAULT_PRICING_FILE_URL);

export function getModelPricingConfig() {
  return cloneJson(DEFAULT_PRICING);
}

export function resolvePricedModelId(modelId, pricing = DEFAULT_PRICING) {
  const requested = String(modelId || "").trim();
  const canonical = pricing.aliases?.[requested] || requested;
  if (!pricing.models?.[canonical]) {
    throw new RangeError(`No pricing configured for model: ${requested || "(empty)"}`);
  }
  return canonical;
}

export function normalizeOpenAIResponsesUsage(usage = {}) {
  const inputTokens = nonNegativeInteger(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0,
    "input_tokens",
  );
  const outputTokens = nonNegativeInteger(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0,
    "output_tokens",
  );
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeInteger(
      inputDetails.cached_tokens
        ?? usage.cached_input_tokens
        ?? usage.prompt_cache_hit_tokens
        ?? usage.cachedInputTokens
        ?? 0,
      "cached_input_tokens",
    ),
  );
  const cacheWriteTokens = Math.min(
    inputTokens - cachedInputTokens,
    nonNegativeInteger(
      inputDetails.cache_write_tokens
        ?? usage.cache_write_tokens
        ?? usage.cacheWriteTokens
        ?? 0,
      "cache_write_tokens",
    ),
  );
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteTokens;
  const reasoningTokens = Math.min(
    outputTokens,
    nonNegativeInteger(
      outputDetails.reasoning_tokens ?? usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
      "reasoning_tokens",
    ),
  );
  const totalTokens = nonNegativeInteger(
    usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens,
    "total_tokens",
  );

  return Object.freeze({
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  });
}

/**
 * Normalizes provider-reported token usage without turning a missing report
 * into a fabricated all-zero measurement.
 */
export function normalizeReportedModelUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const normalized = normalizeOpenAIResponsesUsage(usage);
  if (
    normalized.inputTokens === 0
    && normalized.outputTokens === 0
    && normalized.totalTokens === 0
  ) {
    return null;
  }
  return normalized;
}

export function estimateOpenAIModelCost({
  model,
  usage,
  reasoningMode = "standard",
  usdToCnyRate = null,
  exchangeRateVersion = null,
  pricing = DEFAULT_PRICING,
} = {}) {
  if (!["standard", "pro"].includes(reasoningMode)) {
    throw new RangeError(`Unsupported reasoning mode for pricing: ${reasoningMode}`);
  }
  const canonicalModel = resolvePricedModelId(model, pricing);
  const rates = pricing.models[canonicalModel];
  const normalizedUsage = normalizeOpenAIResponsesUsage(usage);
  const isLongContext = normalizedUsage.inputTokens > rates.longContext.thresholdInputTokensExclusive;
  const inputMultiplier = isLongContext ? rates.longContext.inputMultiplier : 1;
  const outputMultiplier = isLongContext ? rates.longContext.outputMultiplier : 1;

  const inputCostUsd = tokenCost(
    normalizedUsage.uncachedInputTokens,
    rates.inputUsdPerMillion * inputMultiplier,
  );
  const cachedInputCostUsd = tokenCost(
    normalizedUsage.cachedInputTokens,
    rates.cachedInputUsdPerMillion * inputMultiplier,
  );
  const cacheWriteCostUsd = tokenCost(
    normalizedUsage.cacheWriteTokens,
    rates.cacheWriteUsdPerMillion * inputMultiplier,
  );
  const outputCostUsd = tokenCost(
    normalizedUsage.outputTokens,
    rates.outputUsdPerMillion * outputMultiplier,
  );
  const toolCostUsd = 0;
  const totalCostUsd = roundMoney(
    inputCostUsd + cachedInputCostUsd + cacheWriteCostUsd + outputCostUsd + toolCostUsd,
  );
  const exchangeRate = normalizeExchangeRate(usdToCnyRate);

  return Object.freeze({
    model: canonicalModel,
    requestedModel: String(model),
    reasoningMode,
    usage: normalizedUsage,
    inputCostUsd,
    cachedInputCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    toolCostUsd,
    reasoningCostUsd: 0,
    totalCostUsd,
    exchangeRate,
    exchangeRateVersion: exchangeRate === null ? null : stringOrNull(exchangeRateVersion),
    totalCostCny: exchangeRate === null ? null : roundMoney(totalCostUsd * exchangeRate),
    pricingVersion: pricing.pricingVersion,
    pricingEffectiveDate: pricing.effectiveDate,
    longContextApplied: isLongContext,
    estimateOnly: true,
  });
}

/**
 * Estimates DeepSeek preparation cost only when the server has supplied a
 * complete, explicitly versioned CNY price profile. The public-answer budget
 * and its legacy fallback prices are intentionally not consulted.
 */
export function estimateDeepSeekModelCost({
  model,
  usage,
  pricingProfile = null,
  usdToCnyRate = null,
  exchangeRateVersion = null,
} = {}) {
  const normalizedUsage = normalizeReportedModelUsage(usage);
  const profile = normalizeDeepSeekPricingProfile(pricingProfile);
  const exchangeRate = normalizeExchangeRate(usdToCnyRate);
  const common = {
    provider: "deepseek",
    model: stringOrNull(model),
    requestedModel: stringOrNull(model),
    usage: normalizedUsage,
    exchangeRate,
    exchangeRateVersion: exchangeRate === null ? null : stringOrNull(exchangeRateVersion),
    pricingVersion: profile.pricingVersion,
    pricingEffectiveDate: profile.pricingEffectiveDate,
    estimateOnly: true,
  };
  const unavailable = (reason) => Object.freeze({
    ...common,
    pricingStatus: "unavailable",
    unavailabilityReason: reason,
    inputCostCny: null,
    cachedInputCostCny: null,
    cacheWriteCostCny: null,
    outputCostCny: null,
    totalCostCny: null,
    totalCostUsd: null,
  });

  if (!normalizedUsage) return unavailable("provider_usage_unavailable");
  if (!profile.pricingVersion) return unavailable("versioned_server_pricing_unavailable");
  if (profile.inputCnyPerMillion === null || profile.outputCnyPerMillion === null) {
    return unavailable("versioned_server_pricing_incomplete");
  }
  if (normalizedUsage.cachedInputTokens > 0 && profile.cachedInputCnyPerMillion === null) {
    return unavailable("cached_input_price_unavailable");
  }
  if (normalizedUsage.cacheWriteTokens > 0 && profile.cacheWriteInputCnyPerMillion === null) {
    return unavailable("cache_write_input_price_unavailable");
  }

  const inputCostCny = tokenCost(
    normalizedUsage.uncachedInputTokens,
    profile.inputCnyPerMillion,
  );
  const cachedInputCostCny = tokenCost(
    normalizedUsage.cachedInputTokens,
    profile.cachedInputCnyPerMillion ?? 0,
  );
  const cacheWriteCostCny = tokenCost(
    normalizedUsage.cacheWriteTokens,
    profile.cacheWriteInputCnyPerMillion ?? 0,
  );
  const outputCostCny = tokenCost(
    normalizedUsage.outputTokens,
    profile.outputCnyPerMillion,
  );
  const totalCostCny = roundMoney(
    inputCostCny + cachedInputCostCny + cacheWriteCostCny + outputCostCny,
  );

  return Object.freeze({
    ...common,
    pricingStatus: "estimated",
    unavailabilityReason: null,
    inputCostCny,
    cachedInputCostCny,
    cacheWriteCostCny,
    outputCostCny,
    totalCostCny,
    totalCostUsd: exchangeRate === null ? null : roundMoney(totalCostCny / exchangeRate),
  });
}

export function loadModelPricing(fileUrl = DEFAULT_PRICING_FILE_URL) {
  return cloneJson(loadAndValidatePricing(fileUrl));
}

function loadAndValidatePricing(fileUrl) {
  const parsed = JSON.parse(readFileSync(fileUrl, "utf8"));
  if (parsed.schemaVersion !== 1) throw new TypeError("Unsupported model pricing schemaVersion");
  if (!parsed.pricingVersion || !parsed.effectiveDate) throw new TypeError("Pricing version metadata is required");
  if (!parsed.models || typeof parsed.models !== "object") throw new TypeError("Pricing models are required");
  for (const [modelId, rates] of Object.entries(parsed.models)) {
    for (const field of [
      "inputUsdPerMillion",
      "cachedInputUsdPerMillion",
      "cacheWriteUsdPerMillion",
      "outputUsdPerMillion",
    ]) {
      if (!Number.isFinite(rates[field]) || rates[field] < 0) {
        throw new TypeError(`Invalid ${field} for ${modelId}`);
      }
    }
    if (!Number.isFinite(rates.longContext?.thresholdInputTokensExclusive)
      || !Number.isFinite(rates.longContext?.inputMultiplier)
      || !Number.isFinite(rates.longContext?.outputMultiplier)) {
      throw new TypeError(`Invalid longContext pricing for ${modelId}`);
    }
  }
  return deepFreeze(parsed);
}

function tokenCost(tokens, ratePerMillion) {
  return roundMoney((tokens / 1_000_000) * ratePerMillion);
}

function normalizeExchangeRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("usdToCnyRate must be a positive number or null");
  return rate;
}

function normalizeDeepSeekPricingProfile(profile) {
  const source = profile && typeof profile === "object" && !Array.isArray(profile)
    ? profile
    : {};
  return {
    pricingVersion: stringOrNull(source.pricingVersion),
    pricingEffectiveDate: stringOrNull(source.pricingEffectiveDate ?? source.effectiveDate),
    inputCnyPerMillion: optionalNonNegativeNumber(source.inputCnyPerMillion),
    cachedInputCnyPerMillion: optionalNonNegativeNumber(source.cachedInputCnyPerMillion),
    cacheWriteInputCnyPerMillion: optionalNonNegativeNumber(source.cacheWriteInputCnyPerMillion),
    outputCnyPerMillion: optionalNonNegativeNumber(source.outputCnyPerMillion),
  };
}

function optionalNonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be non-negative`);
  return Math.floor(number);
}

function stringOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e9) / 1e9;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
