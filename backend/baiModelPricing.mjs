import { normalizeOpenAIResponsesUsage } from './modelPricing.mjs';

export const BAI_PRICING_SOURCE_URL = 'https://docs.b.ai/llmservice/pricing-and-usage/';
export const BAI_PRICING_VERSION = 'bai-standard-estimate-2026-09';
export const BAI_PRICING_TIMEZONE = 'Asia/Shanghai';

const MODEL_RATES = Object.freeze({
  'gpt-6-astra': Object.freeze({
    inputUsdPerMillion: 10,
    cacheWriteUsdPerMillion: 12.5,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 50,
  }),
  'glm-5.3': Object.freeze({
    inputUsdPerMillion: 1.4,
    cacheWriteUsdPerMillion: 1.4,
    cachedInputUsdPerMillion: 0.28,
    outputUsdPerMillion: 4.4,
  }),
  'deepseek-v4.1-flash': Object.freeze({
    busy: Object.freeze({
      inputUsdPerMillion: 0.30,
      cacheWriteUsdPerMillion: 0.30,
      cachedInputUsdPerMillion: 0.006,
      outputUsdPerMillion: 1.20,
    }),
    idle: Object.freeze({
      inputUsdPerMillion: 0.15,
      cacheWriteUsdPerMillion: 0.15,
      cachedInputUsdPerMillion: 0.003,
      outputUsdPerMillion: 0.60,
    }),
  }),
});

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e9) / 1e9;
}

function tokenCost(tokens, ratePerMillion) {
  return roundMoney((tokens / 1_000_000) * ratePerMillion);
}

function localPeriod(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: BAI_PRICING_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const busy = weekday && (
    (minutes >= 9 * 60 && minutes < 12 * 60)
    || (minutes >= 14 * 60 && minutes < 18 * 60)
  );
  return busy ? 'busy' : 'idle';
}

function canonicalModel(model) {
  const value = String(model || '').trim();
  if (!Object.hasOwn(MODEL_RATES, value)) {
    throw new RangeError(`No B.AI pricing configured for model: ${value || '(empty)'}`);
  }
  return value;
}

function usageBuckets(usage) {
  const normalized = normalizeOpenAIResponsesUsage(usage);
  return {
    inputTokens: normalized.inputTokens,
    uncachedInputTokens: normalized.uncachedInputTokens,
    cacheWriteTokens: normalized.cacheWriteTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
    totalTokens: normalized.totalTokens,
  };
}

/**
 * Estimates B.AI standard token charges. B.AI does not return an invoice in
 * the OpenAI-compatible response, so every result is explicitly an estimate.
 * `reserve` prices all input at the cache-write tier and all requested output
 * at the output tier; this is the conservative pre-dispatch reservation.
 */
export function estimateBaiModelCost({ model, usage = {}, now = new Date(), reserve = false } = {}) {
  const canonical = canonicalModel(model);
  const reported = usageBuckets(usage);
  const actualPeriod = localPeriod(now);
  const period = reserve && canonical === 'deepseek-v4.1-flash' ? 'busy' : actualPeriod;
  const rates = canonical === 'deepseek-v4.1-flash'
    ? MODEL_RATES[canonical][period]
    : MODEL_RATES[canonical];

  const billed = reserve
    ? {
      uncachedInputTokens: 0,
      cacheWriteTokens: reported.inputTokens,
      cachedInputTokens: 0,
    }
    : {
      uncachedInputTokens: reported.uncachedInputTokens,
      cacheWriteTokens: reported.cacheWriteTokens,
      cachedInputTokens: reported.cachedInputTokens,
    };
  const inputCostUsd = tokenCost(billed.uncachedInputTokens, rates.inputUsdPerMillion);
  const cacheWriteCostUsd = tokenCost(billed.cacheWriteTokens, rates.cacheWriteUsdPerMillion);
  const cachedInputCostUsd = tokenCost(billed.cachedInputTokens, rates.cachedInputUsdPerMillion);
  const outputCostUsd = tokenCost(reported.outputTokens, rates.outputUsdPerMillion);

  return Object.freeze({
    provider: 'bai',
    model: canonical,
    requestedModel: String(model),
    priceBasis: 'bai_standard_estimate',
    costBasis: 'bai_standard_estimate',
    pricingVersion: BAI_PRICING_VERSION,
    pricingSource: BAI_PRICING_SOURCE_URL,
    period,
    actualPeriod,
    periodTimezone: BAI_PRICING_TIMEZONE,
    reserve: Boolean(reserve),
    usage: reported,
    usageBuckets: reported,
    billedUsage: Object.freeze({
      ...billed,
      outputTokens: reported.outputTokens,
      reasoningTokens: reported.reasoningTokens,
    }),
    inputCostUsd,
    cacheWriteCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    reasoningCostUsd: 0,
    totalCostUsd: roundMoney(inputCostUsd + cacheWriteCostUsd + cachedInputCostUsd + outputCostUsd),
    actualCostKnown: false,
    estimateOnly: true,
  });
}

export function getBaiModelPricing() {
  return JSON.parse(JSON.stringify(MODEL_RATES));
}
