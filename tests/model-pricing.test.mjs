import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateDeepSeekModelCost,
  estimateOpenAIModelCost,
  estimateRelayModelCost,
  getModelPricingConfig,
  getRelayModelPricingConfig,
  normalizeOpenAIResponsesUsage,
  normalizeReportedModelUsage,
  resolveRelayPricingMultiplier,
  resolvePricedModelId,
} from "../backend/modelPricing.mjs";

test("versioned relay screenshot pricing remains explicitly unverified", () => {
  const pricing = getRelayModelPricingConfig();
  assert.equal(pricing.pricingVersion, "relay-token-group-screenshot-2026-08-07");
  assert.equal(pricing.effectiveDate, "2026-08-07");
  assert.equal(pricing.checkedAt, "2026-08-07");
  assert.equal(pricing.multiplier, 0.27);
  assert.equal(pricing.source.kind, "user_provided_token_group_screenshot");
  assert.equal(pricing.source.providerVerified, false);
  assert.deepEqual(pricing.models["gpt-5.6-sol"], {
    inputUsdPerMillion: 7.3,
    cachedInputUsdPerMillion: 0.73,
    outputUsdPerMillion: 43.8,
  });
  assert.equal(pricing.models["gpt-5.6-terra"].outputUsdPerMillion, 17.52);
  assert.equal(pricing.models["gpt-5.6-luna"].cachedInputUsdPerMillion, 0.03942);
});

test("versioned GPT-5.6 pricing matches current official standard rates", () => {
  const pricing = getModelPricingConfig();
  assert.equal(pricing.pricingVersion, "openai-gpt-5.6-standard-2026-07-09");
  assert.deepEqual(pricing.models["gpt-5.6-sol"], {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 6.25,
    outputUsdPerMillion: 30,
    longContext: {
      thresholdInputTokensExclusive: 272000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  });
  assert.equal(pricing.models["gpt-5.6-terra"].inputUsdPerMillion, 2.5);
  assert.equal(pricing.models["gpt-5.6-luna"].outputUsdPerMillion, 6);
  assert.equal(resolvePricedModelId("gpt-5.6"), "gpt-5.6-sol");
});

test("usage separates cached, cache-write and uncached input without charging reasoning twice", () => {
  const usage = normalizeOpenAIResponsesUsage({
    input_tokens: 1000,
    input_tokens_details: {
      cached_tokens: 100,
      cache_write_tokens: 200,
    },
    output_tokens: 500,
    output_tokens_details: {
      reasoning_tokens: 400,
    },
    total_tokens: 1500,
  });
  assert.deepEqual(usage, {
    inputTokens: 1000,
    cachedInputTokens: 100,
    cacheWriteTokens: 200,
    uncachedInputTokens: 700,
    outputTokens: 500,
    reasoningTokens: 400,
    totalTokens: 1500,
  });
});

test("reported usage keeps missing provider metrics distinct from a real measurement", () => {
  assert.equal(normalizeReportedModelUsage(null), null);
  assert.equal(normalizeReportedModelUsage({}), null);
  assert.equal(normalizeReportedModelUsage({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }), null);
  assert.deepEqual(normalizeReportedModelUsage({
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
  }), {
    inputTokens: 20,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 30,
  });
});

test("DeepSeek cost requires a complete server-owned versioned price profile", () => {
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
  const unavailable = estimateDeepSeekModelCost({
    model: "deepseek-v4-flash",
    usage,
  });
  assert.equal(unavailable.usage.totalTokens, 30);
  assert.equal(unavailable.totalCostCny, null);
  assert.equal(unavailable.totalCostUsd, null);
  assert.equal(unavailable.pricingVersion, null);
  assert.equal(unavailable.pricingStatus, "unavailable");
  assert.equal(unavailable.unavailabilityReason, "versioned_server_pricing_unavailable");

  const estimated = estimateDeepSeekModelCost({
    model: "deepseek-v4-flash",
    usage,
    pricingProfile: {
      pricingVersion: "admin-deepseek-flash-2026-07-28",
      pricingEffectiveDate: "2026-07-28",
      inputCnyPerMillion: 1,
      outputCnyPerMillion: 2,
    },
    usdToCnyRate: 8,
    exchangeRateVersion: "test-fx-v1",
  });
  assert.equal(estimated.pricingStatus, "estimated");
  assert.equal(estimated.pricingVersion, "admin-deepseek-flash-2026-07-28");
  assert.equal(estimated.totalCostCny, 0.00004);
  assert.equal(estimated.totalCostUsd, 0.000005);
});

test("DeepSeek pricing fails closed when a used cache tier has no versioned rate", () => {
  const cost = estimateDeepSeekModelCost({
    model: "deepseek-v4-flash",
    usage: {
      prompt_tokens: 20,
      prompt_cache_hit_tokens: 5,
      completion_tokens: 10,
    },
    pricingProfile: {
      pricingVersion: "incomplete-test-price-v1",
      inputCnyPerMillion: 1,
      outputCnyPerMillion: 2,
    },
  });
  assert.equal(cost.totalCostCny, null);
  assert.equal(cost.pricingVersion, "incomplete-test-price-v1");
  assert.equal(cost.unavailabilityReason, "cached_input_price_unavailable");
});

test("relay usage is estimated with its model-specific screenshot rate and configurable FX", () => {
  const cost = estimateRelayModelCost({
    model: "relay-gpt-5.6-terra",
    usage: {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens: 100,
      total_tokens: 1100,
    },
    usdToCnyRate: 7.5,
    exchangeRateVersion: "pilot-budget-factor-v1",
  });
  assert.equal(cost.model, "gpt-5.6-terra");
  assert.equal(cost.pricingStatus, "estimated_unverified");
  assert.equal(cost.pricingMultiplier, 0.27);
  assert.equal(cost.pricingSourceVerified, false);
  assert.equal(cost.inputCostUsd, 0.00063072);
  assert.equal(cost.cachedInputCostUsd, 0.000015768);
  assert.equal(cost.outputCostUsd, 0.00047304);
  assert.equal(cost.totalCostUsd, 0.001119528);
  assert.equal(cost.totalCostCny, 0.00839646);
});

test("relay pricing multiplier supports a strict server override", () => {
  assert.equal(resolveRelayPricingMultiplier(undefined, { multiplier: 0.27 }), 0.27);
  assert.equal(resolveRelayPricingMultiplier("", { multiplier: 0.27 }), 0.27);
  assert.equal(resolveRelayPricingMultiplier("0.5", { multiplier: 0.27 }), 0.5);
  assert.equal(resolveRelayPricingMultiplier(1, { multiplier: 0.27 }), 1);
  for (const invalid of [0, "0", -0.1, 1.00001, "not-a-number", Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveRelayPricingMultiplier(invalid, { multiplier: 0.27 }),
      /greater than 0 and at most 1/u,
    );
  }

  const original = process.env.RELAY_PRICING_MULTIPLIER;
  try {
    process.env.RELAY_PRICING_MULTIPLIER = "0.42";
    assert.equal(resolveRelayPricingMultiplier(), 0.42);
    process.env.RELAY_PRICING_MULTIPLIER = "1.01";
    assert.throws(() => resolveRelayPricingMultiplier(), /greater than 0 and at most 1/u);
  } finally {
    if (original === undefined) delete process.env.RELAY_PRICING_MULTIPLIER;
    else process.env.RELAY_PRICING_MULTIPLIER = original;
  }
});

test("relay pricing multiplier scales every cost component and the total", () => {
  const cost = estimateRelayModelCost({
    model: "relay-gpt-5.6-terra",
    usage: {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens: 100,
    },
    usdToCnyRate: 7.5,
    pricingMultiplier: 0.5,
  });
  assert.equal(cost.pricingMultiplier, 0.5);
  assert.equal(cost.inputCostUsd, 0.001168);
  assert.equal(cost.cachedInputCostUsd, 0.0000292);
  assert.equal(cost.outputCostUsd, 0.000876);
  assert.equal(cost.totalCostUsd, 0.0020732);
  assert.equal(cost.totalCostCny, 0.015549);
});

test("relay total-only usage settles a conservative highest-rate upper bound instead of zero", () => {
  const cost = estimateRelayModelCost({
    model: "relay-gpt-5.6-luna",
    usage: { total_tokens: 13_412 },
    usdToCnyRate: 7.5,
  });

  assert.equal(cost.pricingStatus, "estimated_upper_bound_unverified");
  assert.equal(cost.usageBreakdownComplete, false);
  assert.equal(cost.upperBoundApplied, true);
  assert.equal(cost.upperBoundTokenBasis, "total_tokens_at_highest_rate");
  assert.equal(cost.totalCostCny > 0, true);
  assert.equal(cost.totalCostCny, 0.064237178);
});

test("relay cost keeps the reservation when usage, FX, or a used price tier is unavailable", () => {
  assert.equal(estimateRelayModelCost({
    model: "gpt-5.6-sol",
    usage: null,
    usdToCnyRate: 7.5,
  }).totalCostCny, null);
  assert.equal(estimateRelayModelCost({
    model: "gpt-5.6-sol",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }).totalCostCny, null);
  const cacheWrite = estimateRelayModelCost({
    model: "gpt-5.6-sol",
    usage: {
      prompt_tokens: 10,
      prompt_tokens_details: { cache_write_tokens: 5 },
      completion_tokens: 5,
    },
    usdToCnyRate: 7.5,
  });
  assert.equal(cacheWrite.totalCostCny, null);
  assert.equal(cacheWrite.unavailabilityReason, "relay_cache_write_price_unavailable");
});

test("standard cost uses output_tokens once even when reasoning_tokens is present", () => {
  const cost = estimateOpenAIModelCost({
    model: "gpt-5.6-terra",
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 80 },
    },
  });
  assert.equal(cost.inputCostUsd, 0.002);
  assert.equal(cost.cachedInputCostUsd, 0.00005);
  assert.equal(cost.outputCostUsd, 0.0015);
  assert.equal(cost.reasoningCostUsd, 0);
  assert.equal(cost.totalCostUsd, 0.00355);
  assert.equal(cost.totalCostCny, null);
});

test("cache writes use 1.25x input price and alias uses Sol rates", () => {
  const cost = estimateOpenAIModelCost({
    model: "gpt-5.6",
    reasoningMode: "pro",
    usage: {
      input_tokens: 1000,
      input_tokens_details: {
        cached_tokens: 100,
        cache_write_tokens: 200,
      },
      output_tokens: 0,
    },
  });
  assert.equal(cost.model, "gpt-5.6-sol");
  assert.equal(cost.inputCostUsd, 0.0035);
  assert.equal(cost.cachedInputCostUsd, 0.00005);
  assert.equal(cost.cacheWriteCostUsd, 0.00125);
  assert.equal(cost.totalCostUsd, 0.0048);
});

test("long context applies full-request 2x input and 1.5x output multipliers", () => {
  const cost = estimateOpenAIModelCost({
    model: "gpt-5.6-sol",
    usage: {
      input_tokens: 300000,
      output_tokens: 1000,
    },
  });
  assert.equal(cost.longContextApplied, true);
  assert.equal(cost.inputCostUsd, 3);
  assert.equal(cost.outputCostUsd, 0.045);
  assert.equal(cost.totalCostUsd, 3.045);
});

test("configurable FX is recorded with its version", () => {
  const cost = estimateOpenAIModelCost({
    model: "gpt-5.6-luna",
    usage: {
      input_tokens: 100_000,
      output_tokens: 100_000,
    },
    usdToCnyRate: 7.25,
    exchangeRateVersion: "manual-2026-07-27",
  });
  assert.equal(cost.totalCostUsd, 0.7);
  assert.equal(cost.exchangeRate, 7.25);
  assert.equal(cost.exchangeRateVersion, "manual-2026-07-27");
  assert.equal(cost.totalCostCny, 5.075);
});

test("unknown models and invalid rates fail closed", () => {
  assert.throws(() => estimateOpenAIModelCost({
    model: "arbitrary-model",
    usage: {},
  }), /No pricing configured/u);
  assert.throws(() => estimateOpenAIModelCost({
    model: "gpt-5.6-luna",
    usage: {},
    usdToCnyRate: 0,
  }), /positive number/u);
});
