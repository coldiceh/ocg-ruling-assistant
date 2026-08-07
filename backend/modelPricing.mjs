import { readFileSync } from "node:fs";

const DEFAULT_PRICING_FILE_URL = new URL("../data/model-pricing.json", import.meta.url);
const DEFAULT_PRICING = loadAndValidatePricing(DEFAULT_PRICING_FILE_URL);
const DEFAULT_RELAY_PRICING_FILE_URL = new URL("../data/relay-model-pricing.json", import.meta.url);
const DEFAULT_RELAY_PRICING = loadAndValidateRelayPricing(DEFAULT_RELAY_PRICING_FILE_URL);

export function getModelPricingConfig() {
  return cloneJson(DEFAULT_PRICING);
}

export function getRelayModelPricingConfig() {
  return cloneJson(DEFAULT_RELAY_PRICING);
}

/**
 * Resolves the relay token-group multiplier. A blank or missing override uses
 * the versioned dataset default; any explicit override fails closed unless it
 * is a finite value in the interval (0, 1].
 */
export function resolveRelayPricingMultiplier(
  value = process.env.RELAY_PRICING_MULTIPLIER,
  pricing = DEFAULT_RELAY_PRICING,
) {
  const candidate = value === null || value === undefined || String(value).trim() === ""
    ? pricing.multiplier
    : value;
  const multiplier = Number(candidate);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) {
    throw new TypeError("RELAY_PRICING_MULTIPLIER must be greater than 0 and at most 1");
  }
  return multiplier;
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

/**
 * Estimates a third-party relay charge from the versioned rates transcribed
 * from the user-provided relay dashboard screenshot. The source is deliberately
 * marked unverified; this estimate is useful for budget settlement and audit,
 * but the relay dashboard remains the billing authority.
 */
export function estimateRelayModelCost({
  model,
  usage,
  usdToCnyRate = null,
  exchangeRateVersion = null,
  pricing = DEFAULT_RELAY_PRICING,
  pricingMultiplier = undefined,
} = {}) {
  const normalizedUsage = normalizeReportedModelUsage(usage);
  const requestedModel = String(model || "").trim();
  const canonicalModel = requestedModel.replace(/^relay-/u, "");
  const rates = pricing.models?.[canonicalModel];
  const exchangeRate = normalizeExchangeRate(usdToCnyRate);
  const resolvedPricingMultiplier = resolveRelayPricingMultiplier(pricingMultiplier, pricing);
  const common = {
    provider: "relay",
    model: canonicalModel || null,
    requestedModel: requestedModel || null,
    usage: normalizedUsage,
    exchangeRate,
    exchangeRateVersion: exchangeRate === null ? null : stringOrNull(exchangeRateVersion),
    pricingVersion: pricing.pricingVersion,
    pricingEffectiveDate: pricing.effectiveDate,
    pricingMultiplier: resolvedPricingMultiplier,
    pricingSourceVerified: pricing.source?.providerVerified === true,
    estimateOnly: true,
  };
  const unavailable = (reason) => Object.freeze({
    ...common,
    pricingStatus: "unavailable",
    unavailabilityReason: reason,
    inputCostUsd: null,
    cachedInputCostUsd: null,
    cacheWriteCostUsd: null,
    outputCostUsd: null,
    totalCostUsd: null,
    totalCostCny: null,
  });

  if (!normalizedUsage) return unavailable("provider_usage_unavailable");
  if (!rates) return unavailable("relay_model_pricing_unavailable");
  if (normalizedUsage.cacheWriteTokens > 0) {
    return unavailable("relay_cache_write_price_unavailable");
  }
  const inputBreakdownReported = hasAnyOwnField(usage, [
    "input_tokens",
    "prompt_tokens",
    "inputTokens",
  ]);
  const outputBreakdownReported = hasAnyOwnField(usage, [
    "output_tokens",
    "completion_tokens",
    "outputTokens",
  ]);
  if (!inputBreakdownReported || !outputBreakdownReported) {
    if (normalizedUsage.totalTokens <= 0) {
      return unavailable("provider_usage_breakdown_unavailable");
    }
    // Some relay models report only total_tokens. Charging that entire total at
    // the highest applicable token rate is a conservative ledger upper bound:
    // it never turns an incomplete usage report into a zero-cost refund.
    const highestRate = Math.max(
      rates.inputUsdPerMillion,
      rates.cachedInputUsdPerMillion,
      rates.outputUsdPerMillion,
    );
    const upperBoundCostUsd = tokenCost(
      normalizedUsage.totalTokens,
      highestRate * resolvedPricingMultiplier,
    );
    return Object.freeze({
      ...common,
      pricingStatus: "estimated_upper_bound_unverified",
      unavailabilityReason: "provider_usage_breakdown_unavailable",
      usageBreakdownComplete: false,
      upperBoundApplied: true,
      upperBoundTokenBasis: "total_tokens_at_highest_rate",
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      cacheWriteCostUsd: 0,
      outputCostUsd: upperBoundCostUsd,
      totalCostUsd: upperBoundCostUsd,
      totalCostCny: exchangeRate === null ? null : roundMoney(upperBoundCostUsd * exchangeRate),
    });
  }
  const inputCostUsd = tokenCost(
    normalizedUsage.uncachedInputTokens,
    rates.inputUsdPerMillion * resolvedPricingMultiplier,
  );
  const cachedInputCostUsd = tokenCost(
    normalizedUsage.cachedInputTokens,
    rates.cachedInputUsdPerMillion * resolvedPricingMultiplier,
  );
  const cacheWriteCostUsd = 0;
  const outputCostUsd = tokenCost(
    normalizedUsage.outputTokens,
    rates.outputUsdPerMillion * resolvedPricingMultiplier,
  );
  const totalCostUsd = roundMoney(
    inputCostUsd + cachedInputCostUsd + cacheWriteCostUsd + outputCostUsd,
  );
  return Object.freeze({
    ...common,
    pricingStatus: "estimated_unverified",
    unavailabilityReason: null,
    usageBreakdownComplete: true,
    upperBoundApplied: false,
    inputCostUsd,
    cachedInputCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    totalCostUsd,
    totalCostCny: exchangeRate === null ? null : roundMoney(totalCostUsd * exchangeRate),
  });
}

function hasAnyOwnField(value, fields) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && fields.some((field) => Object.hasOwn(value, field)),
  );
}

export function loadModelPricing(fileUrl = DEFAULT_PRICING_FILE_URL) {
  return cloneJson(loadAndValidatePricing(fileUrl));
}

export function loadRelayModelPricing(fileUrl = DEFAULT_RELAY_PRICING_FILE_URL) {
  return cloneJson(loadAndValidateRelayPricing(fileUrl));
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

function loadAndValidateRelayPricing(fileUrl) {
  const parsed = JSON.parse(readFileSync(fileUrl, "utf8"));
  if (parsed.schemaVersion !== 1) throw new TypeError("Unsupported relay pricing schemaVersion");
  if (!parsed.pricingVersion || !parsed.effectiveDate) {
    throw new TypeError("Relay pricing version metadata is required");
  }
  if (!parsed.models || typeof parsed.models !== "object") {
    throw new TypeError("Relay pricing models are required");
  }
  if (parsed.source?.providerVerified !== false) {
    throw new TypeError("Relay screenshot pricing must remain explicitly unverified");
  }
  if (!Number.isFinite(parsed.multiplier) || parsed.multiplier <= 0 || parsed.multiplier > 1) {
    throw new TypeError("Relay pricing multiplier must be greater than 0 and at most 1");
  }
  for (const [modelId, rates] of Object.entries(parsed.models)) {
    for (const field of [
      "inputUsdPerMillion",
      "cachedInputUsdPerMillion",
      "outputUsdPerMillion",
    ]) {
      if (!Number.isFinite(rates[field]) || rates[field] < 0) {
        throw new TypeError(`Invalid relay ${field} for ${modelId}`);
      }
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
