import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const GEMINI_BASELINE_PROFILE = new URL(
  '../config/evidence-generation/gemini-3.8-flash-low.json',
  import.meta.url,
);
const PROFILE_DIRECTORY = new URL('../config/evidence-generation/', import.meta.url);
const STAGES = new Set(['planning', 'selection', 'navigation']);
const MEASUREMENT_BASES = new Set([
  'provider_count',
  'verified_tokenizer',
  'documented_upper_bound',
  'user_authorized_theoretical',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`evidence_generation_contract_invalid_${label}`);
  }
  return value;
}

function nullablePositiveInteger(value, label) {
  if (value === null) return null;
  return positiveInteger(value, label);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`evidence_generation_contract_invalid_${label}`);
  }
  return value.trim();
}

function requestJson(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('evidence_generation_request_body_invalid');
  }
  const serialized = JSON.stringify(body);
  if (serialized === undefined) throw new Error('evidence_generation_request_body_invalid');
  return serialized;
}

function jsonEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function generationContractSha256(contract) {
  validateEvidenceGenerationContract(contract);
  return sha256(stableJson(contract));
}

export function validateEvidenceGenerationContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('evidence_generation_contract_invalid');
  }
  if (contract.status !== 'ready') throw new Error('evidence_generation_contract_incomplete');
  nonEmptyString(contract.contractId, 'contract_id');
  if (!STAGES.has(contract.stage)) throw new Error('evidence_generation_contract_invalid_stage');
  if (!['gemini', 'bai'].includes(contract.providerId)) {
    throw new Error('evidence_generation_contract_provider_unsupported');
  }
  nonEmptyString(contract.modelId, 'model_id');
  nonEmptyString(contract.apiContractVersion, 'api_contract_version');
  nonEmptyString(contract.priceVersion, 'price_version');
  nonEmptyString(contract.countingContractVersion, 'counting_contract_version');
  if (!contract.reasoningConfig || typeof contract.reasoningConfig !== 'object') {
    throw new Error('evidence_generation_contract_invalid_reasoning_config');
  }
  if (!contract.outputLimitConfig || typeof contract.outputLimitConfig !== 'object') {
    throw new Error('evidence_generation_contract_invalid_output_limit_config');
  }
  const outputLimit = positiveInteger(
    contract.outputLimitConfig.maxOutputTokens,
    'output_limit',
  );
  if (positiveInteger(contract.maxBillableOutputTokens, 'max_billable_output_tokens') !== outputLimit) {
    throw new Error('evidence_generation_contract_invalid_billable_output_bound');
  }
  if (!contract.responseFormatConfig || typeof contract.responseFormatConfig !== 'object') {
    throw new Error('evidence_generation_contract_invalid_response_format_config');
  }
  const capacity = contract.capacityContract;
  if (!capacity || typeof capacity !== 'object') {
    throw new Error('evidence_generation_contract_invalid_capacity');
  }
  nonEmptyString(capacity.version, 'capacity_version');
  nonEmptyString(capacity.contextCountingContractVersion, 'context_counting_contract_version');
  nullablePositiveInteger(capacity.maxInputTokens, 'max_input_tokens');
  positiveInteger(capacity.maxOutputTokens, 'max_output_tokens');
  nullablePositiveInteger(capacity.maxSharedContextTokens, 'max_shared_context_tokens');
  nullablePositiveInteger(capacity.maxRequestBodyBytes, 'max_request_body_bytes');
  if (capacity.sharedContextRuleId !== null
      && capacity.sharedContextRuleId !== 'input_plus_max_billable_output_lte_shared_context') {
    throw new Error('evidence_generation_contract_invalid_shared_context_rule');
  }
  if (outputLimit > capacity.maxOutputTokens) {
    throw new Error('evidence_generation_contract_invalid_output_capacity');
  }
  const pricing = contract.pricingContract;
  const validBillingMode = contract.providerId === 'gemini'
    ? pricing?.billingMode === 'standard'
    : pricing?.billingMode === 'busy_conservative_theoretical';
  if (!pricing || pricing.currency !== 'USD' || !validBillingMode) {
    throw new Error('evidence_generation_contract_invalid_pricing');
  }
  for (const [field, value] of [
    ['input_rate', pricing.inputUsdPerMillion],
    ['cached_input_rate', pricing.cachedInputUsdPerMillion],
    ['output_rate', pricing.outputUsdPerMillion],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`evidence_generation_contract_invalid_${field}`);
    }
  }
  if (contract.providerId === 'bai'
      && (!Number.isFinite(pricing.cacheWriteUsdPerMillion)
        || pricing.cacheWriteUsdPerMillion < 0)) {
    throw new Error('evidence_generation_contract_invalid_cache_write_rate');
  }
  if (pricing.outputIncludesThinking !== true || pricing.cachedInputMode !== 'usage_reported'
      || !['none', 'provider_automatic'].includes(pricing.requestCachingMode)) {
    throw new Error('evidence_generation_contract_invalid_pricing_categories');
  }
  if (contract.providerId === 'bai') {
    if (contract.transportContract?.protocol !== 'responses'
        || contract.transportContract?.endpoint !== '/v1/responses') {
      throw new Error('evidence_generation_contract_invalid_transport');
    }
    const measurement = contract.measurementContract;
    if (measurement?.status !== 'user_authorized_theoretical'
        || measurement?.basis !== 'user_authorized_theoretical'
        || measurement?.exact !== false
        || measurement?.estimator?.formula !== 'ceil(request_utf8_bytes / bytes_per_token) + fixed_allowance_tokens'
        || !Number.isFinite(measurement?.estimator?.bytesPerToken)
        || measurement.estimator.bytesPerToken <= 0
        || !Number.isSafeInteger(measurement?.estimator?.fixedAllowanceTokens)
        || measurement.estimator.fixedAllowanceTokens < 0) {
      throw new Error('evidence_generation_contract_invalid_theoretical_measurement');
    }
  }
  return contract;
}

function configuredProfileUrl(stage, env = {}) {
  const key = stage === 'planning'
    ? 'EVIDENCE_PLANNING_PROFILE'
    : stage === 'selection'
      ? 'EVIDENCE_SELECTION_PROFILE'
      : 'EVIDENCE_NAVIGATION_PROFILE';
  const selected = String(env[key] || '').trim();
  if (!selected) return GEMINI_BASELINE_PROFILE;
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(selected) || selected.endsWith('.json')) {
    throw new Error(`evidence_generation_profile_config_invalid_${key}`);
  }
  return new URL(`${selected}.json`, PROFILE_DIRECTORY);
}

export function loadEvidenceGenerationContract(stage, { profileUrl, env = {} } = {}) {
  if (!STAGES.has(stage)) throw new Error('evidence_generation_profile_stage_invalid');
  const resolvedProfileUrl = profileUrl || configuredProfileUrl(stage, env);
  const profile = JSON.parse(readFileSync(resolvedProfileUrl, 'utf8'));
  if (profile.status !== 'ready') throw new Error('evidence_generation_profile_incomplete');
  const stageConfig = profile.stages?.[stage];
  if (!stageConfig || typeof stageConfig !== 'object') {
    throw new Error('evidence_generation_profile_stage_missing');
  }
  const { profileId, stages: _stages, ...base } = profile;
  const useProviderOutputLimit = env.EVIDENCE_GENERATION_OUTPUT_LIMIT === 'provider';
  // Keep a finite accounting/context reservation even when the request omits its output cap.
  const maxBillableOutputTokens = useProviderOutputLimit
    ? base.capacityContract.maxOutputTokens : stageConfig.maxBillableOutputTokens;
  const contract = {
    ...base,
    ...stageConfig,
    maxBillableOutputTokens,
    stage,
    contractId: `${profileId}:${stage}:v1`,
    outputLimitConfig: {
      ...base.outputLimitConfig,
      maxOutputTokens: maxBillableOutputTokens,
      ...(useProviderOutputLimit ? { omitFromRequest: true } : {}),
    },
  };
  validateEvidenceGenerationContract(contract);
  return deepFreeze(structuredClone(contract));
}

function assertGenerationRequestProfile(body, contract) {
  const outputLimit = contract.outputLimitConfig.omitFromRequest
    ? undefined : contract.outputLimitConfig.maxOutputTokens;
  if (contract.providerId === 'bai') {
    if (body?.model !== contract.modelId
        || body?.stream !== false
        || body?.max_output_tokens !== outputLimit
        || !jsonEqual(body?.reasoning, contract.reasoningConfig.responses)
        || !jsonEqual(body?.text?.format, contract.responseFormatConfig.responses)) {
      throw new Error('evidence_generation_request_profile_mismatch');
    }
    return;
  }
  const config = body.generationConfig;
  if (!config || typeof config !== 'object') {
    throw new Error('evidence_generation_request_profile_mismatch');
  }
  if (config.maxOutputTokens !== outputLimit
      || !jsonEqual(config.thinkingConfig, contract.reasoningConfig.thinkingConfig)
      || config.responseMimeType !== contract.responseFormatConfig.responseMimeType) {
    throw new Error('evidence_generation_request_profile_mismatch');
  }
  if (contract.pricingContract.requestCachingMode === 'none'
      && Object.hasOwn(body, 'cachedContent')) {
    throw new Error('evidence_generation_request_profile_mismatch');
  }
}

function buildBaiTheoreticalInputMeasurement({ body, contract, checkCapacity = true }) {
  validateEvidenceGenerationContract(contract);
  if (contract.providerId !== 'bai') {
    throw new Error('evidence_generation_measurement_provider_unsupported');
  }
  assertGenerationRequestProfile(body, contract);
  const serialized = requestJson(body);
  const requestBodyBytes = Buffer.byteLength(serialized, 'utf8');
  const estimator = contract.measurementContract.estimator;
  const estimatedInputTokens = Math.max(1, Math.ceil(
    requestBodyBytes / estimator.bytesPerToken,
  ) + estimator.fixedAllowanceTokens);
  const measurement = {
    providerId: contract.providerId,
    modelId: contract.modelId,
    generationContractSha256: generationContractSha256(contract),
    requestSha256: sha256(serialized),
    // Legacy budget schema field. This is an estimated allocation, not an exact
    // tokenizer count or a guaranteed token upper bound.
    inputTokensUpperBound: estimatedInputTokens,
    contextInputTokensUpperBound: estimatedInputTokens,
    inputTokenAllocationKind: 'theoretical_estimate',
    contextCountingContractVersion: contract.capacityContract.contextCountingContractVersion,
    requestBodyBytes,
    exact: false,
    countingContractVersion: contract.countingContractVersion,
    basis: 'user_authorized_theoretical',
    estimatorVersion: estimator.version,
  };
  if (checkCapacity) assertGenerationCapacity({ body, contract, measurement });
  return Object.freeze(measurement);
}

export async function buildEvidenceInputMeasurement(options) {
  if (options?.contract?.providerId === 'gemini') return buildGeminiInputMeasurement(options);
  if (options?.contract?.providerId === 'bai') return buildBaiTheoreticalInputMeasurement(options);
  throw new Error('evidence_generation_measurement_provider_unsupported');
}

export async function buildGeminiInputMeasurement({ body, contract, countTokens, checkCapacity = true }) {
  validateEvidenceGenerationContract(contract);
  if (contract.providerId !== 'gemini') throw new Error('evidence_generation_measurement_provider_unsupported');
  if (typeof countTokens !== 'function') throw new Error('evidence_generation_count_tokens_required');
  assertGenerationRequestProfile(body, contract);
  const serialized = requestJson(body);
  const countRequest = {
    generateContentRequest: {
      model: `models/${contract.modelId}`,
      ...body,
    },
  };
  const response = await countTokens(countRequest);
  const totalTokens = typeof response === 'number' ? response : response?.totalTokens;
  positiveInteger(totalTokens, 'provider_input_token_count');
  const measurement = {
    providerId: contract.providerId,
    modelId: contract.modelId,
    generationContractSha256: generationContractSha256(contract),
    requestSha256: sha256(serialized),
    inputTokensUpperBound: totalTokens,
    contextInputTokensUpperBound: totalTokens,
    contextCountingContractVersion: contract.capacityContract.contextCountingContractVersion,
    requestBodyBytes: Buffer.byteLength(serialized, 'utf8'),
    exact: true,
    countingContractVersion: contract.countingContractVersion,
    basis: 'provider_count',
  };
  // Selection assembly may measure one oversized candidate in order to rebuild
  // it. The actual send always enforces capacity against the measured body.
  if (checkCapacity) assertGenerationCapacity({ body, contract, measurement });
  return Object.freeze(measurement);
}

export function assertGenerationCapacity({ body, contract, measurement }) {
  validateEvidenceGenerationContract(contract);
  assertGenerationRequestProfile(body, contract);
  if (!measurement || typeof measurement !== 'object') {
    throw new Error('evidence_generation_measurement_required');
  }
  const serialized = requestJson(body);
  const expectedContractHash = generationContractSha256(contract);
  if (measurement.providerId !== contract.providerId
      || measurement.modelId !== contract.modelId
      || measurement.generationContractSha256 !== expectedContractHash
      || measurement.requestSha256 !== sha256(serialized)
      || measurement.requestBodyBytes !== Buffer.byteLength(serialized, 'utf8')
      || measurement.countingContractVersion !== contract.countingContractVersion
      || measurement.contextCountingContractVersion
        !== contract.capacityContract.contextCountingContractVersion) {
    throw new Error('evidence_generation_measurement_binding_error');
  }
  if (!MEASUREMENT_BASES.has(measurement.basis) || typeof measurement.exact !== 'boolean') {
    throw new Error('evidence_generation_measurement_invalid');
  }
  if (contract.providerId === 'gemini'
      && (measurement.basis !== 'provider_count' || measurement.exact !== true)) {
    throw new Error('evidence_generation_measurement_invalid');
  }
  if (contract.providerId === 'bai'
      && (contract.measurementContract?.status !== 'user_authorized_theoretical'
        || measurement.basis !== 'user_authorized_theoretical'
        || measurement.exact !== false
        || measurement.inputTokenAllocationKind !== 'theoretical_estimate'
        || measurement.estimatorVersion !== contract.measurementContract.estimator.version)) {
    throw new Error('evidence_generation_measurement_invalid');
  }
  const input = positiveInteger(measurement.inputTokensUpperBound, 'measured_input_tokens');
  const contextInput = measurement.contextInputTokensUpperBound === null
    ? null
    : positiveInteger(measurement.contextInputTokensUpperBound, 'measured_context_input_tokens');
  const capacity = contract.capacityContract;
  if (capacity.maxInputTokens !== null && input > capacity.maxInputTokens) {
    throw new Error('provider_input_capacity_exceeded');
  }
  if (contract.maxBillableOutputTokens > capacity.maxOutputTokens) {
    throw new Error('provider_output_capacity_exceeded');
  }
  if (capacity.maxRequestBodyBytes !== null
      && measurement.requestBodyBytes > capacity.maxRequestBodyBytes) {
    throw new Error('provider_request_body_capacity_exceeded');
  }
  if (capacity.sharedContextRuleId === 'input_plus_max_billable_output_lte_shared_context') {
    if (contextInput === null) throw new Error('evidence_generation_context_measurement_required');
    if (contextInput + contract.maxBillableOutputTokens > capacity.maxSharedContextTokens) {
      throw new Error('provider_shared_context_capacity_exceeded');
    }
  }
  return {
    inputTokensUpperBound: input,
    contextInputTokensUpperBound: contextInput,
    outputTokensUpperBound: contract.maxBillableOutputTokens,
    requestBodyBytes: measurement.requestBodyBytes,
  };
}

export function estimateGenerationUpperBoundUsd({ measurement, contract }) {
  validateEvidenceGenerationContract(contract);
  const input = positiveInteger(measurement?.inputTokensUpperBound, 'measured_input_tokens');
  const output = contract.maxBillableOutputTokens;
  const pricing = contract.pricingContract;
  const theoreticalInputRate = contract.providerId === 'bai'
    ? Math.max(pricing.inputUsdPerMillion, pricing.cacheWriteUsdPerMillion)
    : pricing.inputUsdPerMillion;
  const amountUsd = (input * theoreticalInputRate
    + output * pricing.outputUsdPerMillion) / 1_000_000;
  return {
    currency: 'USD',
    amountUsd,
    inputTokenUpperBound: input,
    outputTokenUpperBound: output,
    priceVersion: contract.priceVersion,
    basis: contract.providerId === 'bai'
      ? 'user_authorized_theoretical_estimated_input_and_max_billable_output'
      : 'all_uncached_input_and_max_billable_output',
  };
}

function optionalTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeGeminiGenerationUsage(rawUsage, contract) {
  validateEvidenceGenerationContract(contract);
  const raw = rawUsage && typeof rawUsage === 'object' ? structuredClone(rawUsage) : null;
  const prompt = optionalTokenCount(raw?.promptTokenCount);
  const cachedPresent = raw !== null && Object.prototype.hasOwnProperty.call(raw, 'cachedContentTokenCount');
  const cachedReported = optionalTokenCount(raw?.cachedContentTokenCount);
  const cached = !cachedPresent && pricingRequestHasNoCache(contract) ? 0 : cachedReported;
  const candidates = optionalTokenCount(raw?.candidatesTokenCount);
  const thoughts = optionalTokenCount(raw?.thoughtsTokenCount);
  const total = optionalTokenCount(raw?.totalTokenCount);
  const outputFromTotal = prompt !== null && total !== null && total >= prompt
    ? total - prompt
    : null;
  const outputFromParts = candidates !== null && thoughts !== null
    ? candidates + thoughts
    : null;
  const billableOutput = outputFromTotal === null
    ? outputFromParts
    : outputFromParts === null ? outputFromTotal : Math.max(outputFromTotal, outputFromParts);
  const complete = prompt !== null && cached !== null && cached <= prompt
    && billableOutput !== null && billableOutput <= contract.maxBillableOutputTokens
    && total !== null && total >= prompt;
  const billableUsage = {
    status: complete ? 'known' : 'unknown',
    inputTokens: prompt,
    cachedInputTokens: cached,
    candidatesTokens: candidates,
    thinkingTokens: thoughts,
    totalTokens: total,
    billableOutputTokens: billableOutput,
  };
  const pricing = contract.pricingContract;
  const amountUsd = complete
    ? ((prompt - cached) * pricing.inputUsdPerMillion
      + cached * pricing.cachedInputUsdPerMillion
      + billableOutput * pricing.outputUsdPerMillion) / 1_000_000
    : null;
  return {
    rawUsage: raw,
    billableUsage,
    usageNormalization: {
      status: complete ? 'complete' : 'unknown',
      countingContractVersion: contract.countingContractVersion,
      rule: 'max_candidates_plus_thoughts_or_total_minus_prompt',
      cachedInputRule: !cachedPresent && pricingRequestHasNoCache(contract)
        ? 'omitted_optional_cache_count_treated_as_zero_upper_bound'
        : 'provider_reported_cache_count',
      missingOrInvalidFields: complete ? [] : [
        ...(prompt === null ? ['promptTokenCount'] : []),
        ...(cached === null || (prompt !== null && cached > prompt) ? ['cachedContentTokenCount'] : []),
        ...(total === null || (prompt !== null && total < prompt) ? ['totalTokenCount'] : []),
        ...(billableOutput === null ? ['billableOutputTokenCount'] : []),
        ...(billableOutput !== null && billableOutput > contract.maxBillableOutputTokens
          ? ['billableOutputTokensExceedContract'] : []),
      ],
    },
    billableCost: {
      status: complete ? 'known' : 'unknown',
      currency: 'USD',
      amountUsd,
      priceVersion: contract.priceVersion,
      basis: !cachedPresent && pricingRequestHasNoCache(contract)
        ? 'all_input_priced_uncached_conservative_upper_bound'
        : 'provider_reported_usage',
    },
  };
}

export function normalizeEvidenceGenerationUsage(rawUsage, contract) {
  if (contract?.providerId === 'gemini') {
    return normalizeGeminiGenerationUsage(rawUsage, contract);
  }
  if (contract?.providerId !== 'bai') {
    throw new Error('evidence_generation_usage_provider_unsupported');
  }
  validateEvidenceGenerationContract(contract);
  const raw = rawUsage && typeof rawUsage === 'object' ? structuredClone(rawUsage) : null;
  const input = optionalTokenCount(raw?.input_tokens);
  const output = optionalTokenCount(raw?.output_tokens);
  const total = optionalTokenCount(raw?.total_tokens);
  const inputDetails = raw?.input_tokens_details;
  const cached = inputDetails && Object.hasOwn(inputDetails, 'cached_tokens')
    ? optionalTokenCount(inputDetails.cached_tokens)
    : 0;
  const cacheWriteValue = inputDetails?.cache_write_tokens
    ?? inputDetails?.cache_creation_tokens
    ?? raw?.cache_write_input_tokens;
  const cacheWrite = cacheWriteValue === undefined ? 0 : optionalTokenCount(cacheWriteValue);
  const reasoningValue = raw?.output_tokens_details?.reasoning_tokens;
  const reasoning = reasoningValue === undefined ? null : optionalTokenCount(reasoningValue);
  const inputCategoriesValid = input !== null && cached !== null && cacheWrite !== null
    && cached + cacheWrite <= input;
  const totalValid = input !== null && output !== null && total !== null
    && total >= input + output;
  const reasoningValid = reasoning === null || (output !== null && reasoning <= output);
  const complete = inputCategoriesValid && totalValid && reasoningValid
    && output <= contract.maxBillableOutputTokens;
  const visibleOutput = output !== null && reasoning !== null ? output - reasoning : null;
  const billableUsage = {
    status: complete ? 'known' : 'unknown',
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    candidatesTokens: visibleOutput,
    thinkingTokens: reasoning,
    totalTokens: total,
    billableOutputTokens: output,
  };
  const pricing = contract.pricingContract;
  const amountUsd = complete
    ? (((input - cached - cacheWrite) * pricing.inputUsdPerMillion
      + cached * pricing.cachedInputUsdPerMillion
      + cacheWrite * pricing.cacheWriteUsdPerMillion
      + output * pricing.outputUsdPerMillion) / 1_000_000)
    : null;
  return {
    rawUsage: raw,
    billableUsage,
    usageNormalization: {
      status: complete ? 'complete' : 'unknown',
      countingContractVersion: contract.countingContractVersion,
      rule: 'bai_responses_provider_reported_usage_output_includes_reasoning',
      cachedInputRule: 'provider_reported_when_present_otherwise_zero',
      missingOrInvalidFields: complete ? [] : [
        ...(input === null ? ['input_tokens'] : []),
        ...(output === null ? ['output_tokens'] : []),
        ...(total === null || !totalValid ? ['total_tokens'] : []),
        ...(!inputCategoriesValid ? ['input_tokens_details'] : []),
        ...(!reasoningValid ? ['output_tokens_details.reasoning_tokens'] : []),
        ...(output !== null && output > contract.maxBillableOutputTokens
          ? ['billableOutputTokensExceedContract'] : []),
      ],
    },
    billableCost: {
      status: complete ? 'known' : 'unknown',
      currency: 'USD',
      amountUsd,
      priceVersion: contract.priceVersion,
      basis: complete ? 'provider_reported_usage_theoretical_usd_not_supplier_charge' : 'unknown',
    },
  };
}

function pricingRequestHasNoCache(contract) {
  return contract?.pricingContract?.requestCachingMode === 'none';
}
