import { emptyOperationLegality, validateOperationLegalityModelOutput } from "./operationLegalityAnalyzer.mjs";
import { RAG_ANSWER_LEVELS } from "./ragRulingPrompt.mjs";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_CARD_MODEL = "deepseek-v4-flash";
const DEFAULT_LIGHTWEIGHT_EXTRACTION_TIMEOUT_MS = 4500;
const DEFAULT_DAILY_BUDGET_CNY = 10;
const DEFAULT_BUDGET_TIMEZONE = "Asia/Tokyo";
const RESTRICTIVE_EVIDENCE_PATTERN = /(?:不能|不可|不得|无法|不可以|禁止|不满足|不存在|cannot|can't|must not|may not|not allowed|できません|発動できません)/iu;
const GROUNDING_MECHANISM_PATTERNS = Object.freeze([
  ["activation", /发动|發動|発動|activate/iu],
  ["chain", /连锁|連鎖|チェーン|chain/iu],
  ["target", /对象|對象|対象|target/iu],
  ["applicability", /适用|適用|处理|處理|処理|resolve|applicable/iu],
  ["return", /回到|返回|放回|弹回|彈回|戻|return/iu],
  ["hand", /手卡|手牌|手札|hand/iu],
  ["deck", /卡组|牌组|牌組|デッキ|deck/iu],
  ["spell_trap", /魔法|陷阱|罠|spell|trap/iu],
  ["field", /场上|場上|フィールド|field/iu],
  ["destroy", /破坏|破壊|destroy/iu],
  ["negate", /无效|無效|negate/iu],
  ["banish", /除外|banish/iu],
  ["graveyard", /墓地|graveyard|GY/iu],
  ["summon", /召唤|召喚|summon/iu],
  ["cost", /cost|代价|代價|支付/iu],
  ["timing", /时点|時点|时机|タイミング|timing/iu],
  ["attack", /攻击|攻擊|攻撃|attack/iu],
  ["unaffected", /不受.{0,8}影响|不受.{0,8}影響|受けない|unaffected/iu],
]);
const memoryBudget = new Map();
const cardNameExtractionCache = new Map();
const ruleQueryExtractionCache = new Map();
const rulebookGroundingCache = new Map();

export async function callRagModel({
  prompt,
  evidence = {},
  cardResolution = {},
  env = globalThis.process?.env || {},
  modelInvoker,
  dryRun,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const providerResolution = resolveRagProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForProvider(provider, env);
  const maxTokens = resolveRagMaxOutputTokens(env);
  const forcedDryRun = dryRun === true || isEnabled(env.RAG_DRY_RUN);
  const willCallRemote = !modelInvoker && !forcedDryRun && provider !== "mock" && hasProviderKey(provider, env) && typeof fetchImpl === "function";
  const budget = await buildBudgetPreflight({
    provider,
    prompt,
    maxTokens,
    env,
    fetchImpl,
    now,
    trackSpend: willCallRemote,
  });

  if (modelInvoker) {
    const raw = await modelInvoker({ prompt, provider, modelName, maxTokens });
    const parsed = parseModelResult(raw, {
      provider,
      modelName,
      dryRun: false,
      warnings: providerResolution.warnings,
      budgetStatus: budget.status,
    });
    return {
      ...parsed,
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: budget.status,
    };
  }

  if (budget.blocked) {
    return {
      answer: safeFallbackAnswer("api_daily_budget_exceeded", "今日 API 预算已用完，未调用模型。", "budget_limited"),
      rawText: "",
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun: true,
      warnings: [...providerResolution.warnings, "api_daily_budget_exceeded", ...budget.warnings],
      tokenUsage: {},
      estimatedCostCny: budget.status.estimatedThisCallCny,
      budgetStatus: budget.status,
    };
  }

  if (forcedDryRun || provider === "mock" || !hasProviderKey(provider, env) || typeof fetchImpl !== "function") {
    return {
      answer: buildMockAnswer({ evidence, cardResolution }),
      rawText: "",
      provider: "mock",
      providerUsed: "mock",
      modelName: "mock-rag",
      modelUsed: "mock-rag",
      dryRun: true,
      warnings: [...providerResolution.warnings, ...budget.warnings],
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: budget.status,
    };
  }

  try {
    const response = provider === "gemini"
      ? await callGemini({ prompt, env, modelName, maxTokens, fetchImpl })
      : await callDeepSeek({ prompt, env, modelName, maxTokens, fetchImpl });
    const tokenUsage = normalizeUsage(provider, response.usage);
    const actualCost = estimateActualCostCny(provider, tokenUsage, env);
    const spendWarnings = [];
    let budgetStatus = budget.status;
    try {
      budgetStatus = await recordBudgetSpend({
        preflight: budget,
        actualCostCny: actualCost,
        env,
        fetchImpl,
      });
    } catch (error) {
      spendWarnings.push(`budget_spend_record_failed:${safeErrorMessage(error)}`);
      budgetStatus = {
        ...budget.status,
        budgetStorage: "unavailable",
      };
    }
    const parsed = parseModelResult(response.rawText, {
      provider,
      modelName,
      dryRun: false,
      warnings: [...providerResolution.warnings, ...budget.warnings, ...spendWarnings, ...(response.warnings || [])],
      budgetStatus,
    });
    return {
      ...parsed,
      tokenUsage,
      estimatedCostCny: actualCost,
      budgetStatus,
    };
  } catch (error) {
    const warning = `model_call_failed:${error instanceof Error ? error.message : String(error)}`;
    const releasedBudgetStatus = await releaseBudgetReservation({ preflight: budget, env, fetchImpl }).catch(() => budget.status);
    return {
      answer: safeFallbackAnswer("model_call_failed"),
      rawText: "",
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun: false,
      warnings: [...providerResolution.warnings, warning, ...budget.warnings],
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: releasedBudgetStatus,
    };
  }
}

export async function callCardNameExtractionModel({
  userQuery,
  env = globalThis.process?.env || {},
  modelInvoker,
  fetchImpl = globalThis.fetch,
} = {}) {
  const providerResolution = resolveCardExtractionProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForCardExtractionProvider(provider, env);
  const maxTokens = readNumber(env.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS, 800);
  const prompt = buildCardNameExtractionPrompt(userQuery);

  if (modelInvoker) {
    try {
      const raw = await modelInvoker({ prompt, provider, modelName, maxTokens, task: "card_name_extraction" });
      return {
        candidates: normalizeCardNameCandidates(raw),
        rawText: String(raw || ""),
        providerUsed: provider,
        modelUsed: modelName,
        dryRun: false,
        warnings: providerResolution.warnings,
      };
    } catch (error) {
      return emptyCardNameExtractionResult(provider, modelName, false, [
        ...providerResolution.warnings,
        `card_name_model_failed:${safeErrorMessage(error)}`,
      ]);
    }
  }

  if (provider === "mock" || !hasProviderKey(provider, env) || typeof fetchImpl !== "function") {
    return emptyCardNameExtractionResult("mock", "mock-card-extractor", true, providerResolution.warnings);
  }

  const cacheKey = extractionCacheKey("card", provider, modelName, userQuery);
  const cached = readCachedExtraction(cardNameExtractionCache, cacheKey, env);
  if (cached) {
    return {
      ...cached,
      cacheHit: true,
      warnings: [...new Set([...(cached.warnings || []), "card_name_model_cache_hit"])],
    };
  }

  try {
    const timeoutMs = readPositiveNumber(env.RAG_CARD_MODEL_TIMEOUT_MS, DEFAULT_LIGHTWEIGHT_EXTRACTION_TIMEOUT_MS);
    const call = provider === "gemini"
      ? callGemini({
        prompt,
        env,
        modelName,
        maxTokens,
        fetchImpl,
        temperature: readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0),
        maxTokensEnvName: "GEMINI_CARD_MODEL_MAX_OUTPUT_TOKENS",
      })
      : callDeepSeek({
        prompt,
        env,
        modelName,
        maxTokens,
        fetchImpl,
        temperature: readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0),
      });
    const response = await withTimeout(call, timeoutMs, "card_name_model_timeout");
    const result = {
      candidates: normalizeCardNameCandidates(response.rawText),
      rawText: response.rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [...providerResolution.warnings, ...(response.warnings || [])],
    };
    writeCachedExtraction(cardNameExtractionCache, cacheKey, result, env);
    return result;
  } catch (error) {
    return emptyCardNameExtractionResult(provider, modelName, false, [
      ...providerResolution.warnings,
      `card_name_model_failed:${safeErrorMessage(error)}`,
    ]);
  }
}

export async function callRuleQueryExtractionModel({
  userQuery,
  env = globalThis.process?.env || {},
  modelInvoker,
  fetchImpl = globalThis.fetch,
} = {}) {
  const providerResolution = resolveRuleQueryExtractionProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForRuleQueryExtractionProvider(provider, env);
  const maxTokens = readNumber(env.RAG_RULE_MODEL_MAX_OUTPUT_TOKENS, 700);
  const prompt = buildRuleQueryExtractionPrompt(userQuery);

  if (modelInvoker) {
    try {
      const raw = await modelInvoker({ prompt, provider, modelName, maxTokens, task: "rule_query_extraction" });
      return {
        queries: normalizeRuleSearchQueries(raw),
        rawText: String(raw || ""),
        providerUsed: provider,
        modelUsed: modelName,
        dryRun: false,
        warnings: providerResolution.warnings,
      };
    } catch (error) {
      return emptyRuleQueryExtractionResult(provider, modelName, false, [
        ...providerResolution.warnings,
        `rule_query_model_failed:${safeErrorMessage(error)}`,
      ]);
    }
  }

  if (provider === "mock" || !hasProviderKey(provider, env) || typeof fetchImpl !== "function") {
    return emptyRuleQueryExtractionResult("mock", "mock-rule-query-extractor", true, providerResolution.warnings);
  }

  const cacheKey = extractionCacheKey("rule", provider, modelName, userQuery);
  const cached = readCachedExtraction(ruleQueryExtractionCache, cacheKey, env);
  if (cached) {
    return {
      ...cached,
      cacheHit: true,
      warnings: [...new Set([...(cached.warnings || []), "rule_query_model_cache_hit"])],
    };
  }

  try {
    const timeoutMs = readPositiveNumber(env.RAG_RULE_MODEL_TIMEOUT_MS, readPositiveNumber(env.RAG_CARD_MODEL_TIMEOUT_MS, DEFAULT_LIGHTWEIGHT_EXTRACTION_TIMEOUT_MS));
    const call = provider === "gemini"
      ? callGemini({
        prompt,
        env,
        modelName,
        maxTokens,
        fetchImpl,
        temperature: readNumber(env.RAG_RULE_MODEL_TEMPERATURE, readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0)),
        maxTokensEnvName: "GEMINI_RULE_MODEL_MAX_OUTPUT_TOKENS",
      })
      : callDeepSeek({
        prompt,
        env,
        modelName,
        maxTokens,
        fetchImpl,
        temperature: readNumber(env.RAG_RULE_MODEL_TEMPERATURE, readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0)),
      });
    const response = await withTimeout(call, timeoutMs, "rule_query_model_timeout");
    const result = {
      queries: normalizeRuleSearchQueries(response.rawText),
      rawText: response.rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [...providerResolution.warnings, ...(response.warnings || [])],
    };
    writeCachedExtraction(ruleQueryExtractionCache, cacheKey, result, env);
    return result;
  } catch (error) {
    return emptyRuleQueryExtractionResult(provider, modelName, false, [
      ...providerResolution.warnings,
      `rule_query_model_failed:${safeErrorMessage(error)}`,
    ]);
  }
}

export async function callRulebookGroundingModel({
  userQuery,
  cardTexts = [],
  ruleEvidence = [],
  qaEvidence = [],
  env = globalThis.process?.env || {},
  modelInvoker,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const maxRulebookCandidates = readPositiveNumber(env.RAG_MAX_RULEBOOK_CANDIDATES, 18);
  const maxQaCandidates = readPositiveNumber(env.RAG_MAX_QA_GROUNDING_CANDIDATES, 10);
  const maxCardTextCandidates = readPositiveNumber(env.RAG_MAX_CARDS, 6);
  const maxPriorityConstraints = readPositiveNumber(env.RAG_MAX_PRIORITY_CONSTRAINTS, 3);
  const selectedQaEvidence = selectGroundingQaEvidence(qaEvidence, maxQaCandidates);
  const selectedRuleEvidence = dedupeGroundingEvidence(ruleEvidence).slice(0, maxRulebookCandidates);
  const selectedCardTexts = dedupeGroundingEvidence(cardTexts).slice(0, maxCardTextCandidates);
  const priorityConstraintEvidence = selectPriorityConstraintEvidence({
    items: selectedRuleEvidence,
    userQuery,
    cardTexts: selectedCardTexts,
    limit: maxPriorityConstraints,
  });
  const candidates = interleaveGroundingEvidence([
    priorityConstraintEvidence,
    selectedQaEvidence.filter(isDirectGroundingQa),
    selectedCardTexts,
    selectedRuleEvidence,
    selectedQaEvidence.filter(isFaqGroundingEvidence),
    selectedQaEvidence.filter((item) => !isDirectGroundingQa(item) && !isFaqGroundingEvidence(item)),
  ], maxRulebookCandidates + maxQaCandidates + maxCardTextCandidates);
  if (!candidates.length) {
    return emptyRulebookGroundingResult("none", "none", true, ["grounding_evidence_candidates_missing"]);
  }

  const providerResolution = resolveRulebookGroundingProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForRulebookGroundingProvider(provider, env);
  const maxTokens = readNumber(env.RAG_RULEBOOK_MODEL_MAX_OUTPUT_TOKENS, 2400);
  const prompt = buildRulebookGroundingPrompt({
    userQuery,
    cardTexts,
    evidenceCandidates: candidates,
    priorityConstraintEvidence,
  });

  if (modelInvoker) {
    try {
      const raw = await modelInvoker({ prompt, provider, modelName, maxTokens, task: "rulebook_grounding" });
      const operationLegality = validateOperationLegalityModelOutput(raw, candidates, {
        requiredConstraintEvidence: priorityConstraintEvidence,
      });
      return {
        operationLegality,
        rawText: String(raw || ""),
        providerUsed: provider,
        modelUsed: modelName,
        dryRun: false,
        warnings: [...providerResolution.warnings, ...(operationLegality.warnings || [])],
        tokenUsage: {},
        estimatedCostCny: 0,
        budgetStatus: null,
      };
    } catch (error) {
      return emptyRulebookGroundingResult(provider, modelName, false, [
        ...providerResolution.warnings,
        `rulebook_grounding_model_failed:${safeErrorMessage(error)}`,
      ], priorityConstraintEvidence);
    }
  }

  if (provider === "mock" || !hasProviderKey(provider, env) || typeof fetchImpl !== "function" || isEnabled(env.RAG_DRY_RUN)) {
    return emptyRulebookGroundingResult(
      "mock",
      "mock-rulebook-grounding",
      true,
      providerResolution.warnings,
      priorityConstraintEvidence,
    );
  }

  const cacheInput = `${userQuery}\n${candidates.map((item) => item.id).join("|")}\n${(cardTexts || []).map((item) => item.id || item.title || "").join("|")}`;
  const cacheKey = extractionCacheKey("rulebook-grounding-v3", provider, modelName, cacheInput);
  const cached = readCachedExtraction(rulebookGroundingCache, cacheKey, env);
  if (cached) {
    return {
      ...cached,
      cacheHit: true,
      estimatedCostCny: 0,
      warnings: [...new Set([...(cached.warnings || []), "rulebook_grounding_model_cache_hit"])],
    };
  }

  const budget = await buildBudgetPreflight({
    provider,
    prompt,
    maxTokens,
    env,
    fetchImpl,
    now,
    trackSpend: true,
  });
  if (budget.blocked) {
    return {
      ...emptyRulebookGroundingResult(provider, modelName, true, [
        ...providerResolution.warnings,
        ...budget.warnings,
        "api_daily_budget_exceeded_rulebook_grounding_skipped",
      ], priorityConstraintEvidence),
      budgetStatus: budget.status,
    };
  }

  try {
    const timeoutMs = readPositiveNumber(env.RAG_RULEBOOK_MODEL_TIMEOUT_MS, 7000);
    const call = provider === "gemini"
      ? callGemini({
        prompt,
        env,
        modelName,
        maxTokens,
        fetchImpl,
        temperature: 0,
        maxTokensEnvName: "GEMINI_RULEBOOK_MODEL_MAX_OUTPUT_TOKENS",
      })
      : callDeepSeek({ prompt, env, modelName, maxTokens, fetchImpl, temperature: 0 });
    const response = await withTimeout(call, timeoutMs, "rulebook_grounding_model_timeout");
    const tokenUsage = normalizeUsage(provider, response.usage);
    const actualCost = estimateActualCostCny(provider, tokenUsage, env);
    let budgetStatus = budget.status;
    const spendWarnings = [];
    try {
      budgetStatus = await recordBudgetSpend({ preflight: budget, actualCostCny: actualCost, env, fetchImpl });
    } catch (error) {
      spendWarnings.push(`budget_spend_record_failed:${safeErrorMessage(error)}`);
      budgetStatus = { ...budget.status, budgetStorage: "unavailable" };
    }
    const operationLegality = validateOperationLegalityModelOutput(response.rawText, candidates, {
      requiredConstraintEvidence: priorityConstraintEvidence,
    });
    const result = {
      operationLegality,
      rawText: response.rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [
        ...providerResolution.warnings,
        ...budget.warnings,
        ...spendWarnings,
        ...(response.warnings || []),
        ...(operationLegality.warnings || []),
      ],
      tokenUsage,
      estimatedCostCny: actualCost,
      budgetStatus,
    };
    writeCachedExtraction(rulebookGroundingCache, cacheKey, result, env);
    return result;
  } catch (error) {
    const releasedBudgetStatus = await releaseBudgetReservation({ preflight: budget, env, fetchImpl }).catch(() => budget.status);
    return {
      ...emptyRulebookGroundingResult(provider, modelName, false, [
        ...providerResolution.warnings,
        ...budget.warnings,
        `rulebook_grounding_model_failed:${safeErrorMessage(error)}`,
      ], priorityConstraintEvidence),
      budgetStatus: releasedBudgetStatus,
    };
  }
}

export function resolveRagProvider(env = {}) {
  const requested = String(env.RAG_MODEL_PROVIDER || env.MODEL_PROVIDER || "auto").trim().toLowerCase() || "auto";
  const warnings = [];
  if (requested === "mock") return { provider: "mock", requested, warnings };
  if (requested === "deepseek") {
    if (!env.DEEPSEEK_API_KEY) warnings.push("deepseek_api_key_missing_using_mock");
    return { provider: env.DEEPSEEK_API_KEY ? "deepseek" : "mock", requested, warnings };
  }
  if (requested === "gemini") {
    if (!env.GEMINI_API_KEY) warnings.push("gemini_api_key_missing_using_mock");
    return { provider: env.GEMINI_API_KEY ? "gemini" : "mock", requested, warnings };
  }
  if (requested !== "auto") warnings.push(`unsupported_model_provider:${requested}`);
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", requested, warnings };
  if (env.GEMINI_API_KEY) return { provider: "gemini", requested, warnings };
  warnings.push("no_model_api_key_using_mock");
  return { provider: "mock", requested, warnings };
}

export function resolveCardExtractionProvider(env = {}) {
  if (isDisabled(env.RAG_CARD_EXTRACTOR_ENABLED)) {
    return { provider: "mock", requested: "disabled", warnings: ["card_name_model_disabled"] };
  }
  const requested = String(env.RAG_CARD_MODEL_PROVIDER || env.RAG_MODEL_PROVIDER || env.MODEL_PROVIDER || "auto").trim().toLowerCase() || "auto";
  const warnings = [];
  if (requested === "mock") return { provider: "mock", requested, warnings };
  if (requested === "deepseek") {
    if (!env.DEEPSEEK_API_KEY) warnings.push("deepseek_api_key_missing_card_name_model_disabled");
    return { provider: env.DEEPSEEK_API_KEY ? "deepseek" : "mock", requested, warnings };
  }
  if (requested === "gemini") {
    if (!env.GEMINI_API_KEY) warnings.push("gemini_api_key_missing_card_name_model_disabled");
    return { provider: env.GEMINI_API_KEY ? "gemini" : "mock", requested, warnings };
  }
  if (requested !== "auto") warnings.push(`unsupported_card_name_model_provider:${requested}`);
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", requested, warnings };
  if (env.GEMINI_API_KEY) return { provider: "gemini", requested, warnings };
  warnings.push("no_model_api_key_card_name_model_disabled");
  return { provider: "mock", requested, warnings };
}

export function resolveRuleQueryExtractionProvider(env = {}) {
  if (isDisabled(env.RAG_RULE_QUERY_EXTRACTOR_ENABLED)) {
    return { provider: "mock", requested: "disabled", warnings: ["rule_query_model_disabled"] };
  }
  const requested = String(env.RAG_RULE_MODEL_PROVIDER || env.RAG_CARD_MODEL_PROVIDER || env.RAG_MODEL_PROVIDER || env.MODEL_PROVIDER || "auto").trim().toLowerCase() || "auto";
  const warnings = [];
  if (requested === "mock") return { provider: "mock", requested, warnings };
  if (requested === "deepseek") {
    if (!env.DEEPSEEK_API_KEY) warnings.push("deepseek_api_key_missing_rule_query_model_disabled");
    return { provider: env.DEEPSEEK_API_KEY ? "deepseek" : "mock", requested, warnings };
  }
  if (requested === "gemini") {
    if (!env.GEMINI_API_KEY) warnings.push("gemini_api_key_missing_rule_query_model_disabled");
    return { provider: env.GEMINI_API_KEY ? "gemini" : "mock", requested, warnings };
  }
  if (requested !== "auto") warnings.push(`unsupported_rule_query_model_provider:${requested}`);
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", requested, warnings };
  if (env.GEMINI_API_KEY) return { provider: "gemini", requested, warnings };
  warnings.push("no_model_api_key_rule_query_model_disabled");
  return { provider: "mock", requested, warnings };
}

export function resolveRulebookGroundingProvider(env = {}) {
  if (isDisabled(env.RAG_RULEBOOK_GROUNDING_ENABLED)) {
    return { provider: "mock", requested: "disabled", warnings: ["rulebook_grounding_model_disabled"] };
  }
  const requested = String(env.RAG_RULEBOOK_MODEL_PROVIDER || env.RAG_RULE_MODEL_PROVIDER || env.RAG_MODEL_PROVIDER || env.MODEL_PROVIDER || "auto").trim().toLowerCase() || "auto";
  const warnings = [];
  if (requested === "mock") return { provider: "mock", requested, warnings };
  if (requested === "deepseek") {
    if (!env.DEEPSEEK_API_KEY) warnings.push("deepseek_api_key_missing_rulebook_grounding_model_disabled");
    return { provider: env.DEEPSEEK_API_KEY ? "deepseek" : "mock", requested, warnings };
  }
  if (requested === "gemini") {
    if (!env.GEMINI_API_KEY) warnings.push("gemini_api_key_missing_rulebook_grounding_model_disabled");
    return { provider: env.GEMINI_API_KEY ? "gemini" : "mock", requested, warnings };
  }
  if (requested !== "auto") warnings.push(`unsupported_rulebook_grounding_model_provider:${requested}`);
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", requested, warnings };
  if (env.GEMINI_API_KEY) return { provider: "gemini", requested, warnings };
  warnings.push("no_model_api_key_rulebook_grounding_model_disabled");
  return { provider: "mock", requested, warnings };
}

export function estimateDeepSeekCostCny(usage = {}, env = {}) {
  const inputPrice = readTieredProviderNumber(env, "DEEPSEEK", "INPUT_CNY_PER_MTOK", 1);
  const outputPrice = readTieredProviderNumber(env, "DEEPSEEK", "OUTPUT_CNY_PER_MTOK", 2);
  const cacheHitPrice = readTieredProviderNumber(env, "DEEPSEEK", "CACHE_HIT_INPUT_CNY_PER_MTOK", 0.02);
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const cacheHit = Number(usage.prompt_cache_hit_tokens || 0);
  const cacheMiss = Number(usage.prompt_cache_miss_tokens || 0);
  const inputCost = cacheHit + cacheMiss > 0
    ? mtok(cacheHit) * cacheHitPrice + mtok(cacheMiss) * inputPrice
    : mtok(promptTokens) * inputPrice;
  return roundCost(inputCost + mtok(completionTokens) * outputPrice);
}

export async function getRagBudgetStatus({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = budgetConfig(env);
  const dayKey = budgetDayKey(config.timezone, now);
  const storage = budgetStorage(env);
  if (storage === "unconfigured") {
    return budgetStatusPayload({ config, storage, dayKey, spent: null, estimated: 0, blocked: false });
  }
  const spent = await readBudgetSpent({ storage, dayKey, env, fetchImpl });
  return budgetStatusPayload({ config, storage, dayKey, spent, estimated: 0, blocked: false });
}

export async function resetRagBudget({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = budgetConfig(env);
  const dayKey = budgetDayKey(config.timezone, now);
  const storage = budgetStorage(env);
  if (storage === "unconfigured") {
    return budgetStatusPayload({ config, storage, dayKey, spent: null, estimated: 0, blocked: false });
  }
  await setBudgetSpent({ storage, dayKey, value: 0, env, fetchImpl });
  return budgetStatusPayload({ config, storage, dayKey, spent: 0, estimated: 0, blocked: false });
}

export function parseRagModelJson(rawText) {
  const text = stripJsonCodeFence(String(rawText || "").trim());
  if (!text) throw new SyntaxError("empty model output");
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/u);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        const loose = parseLooseRagModelJson(match[0]);
        if (loose) return loose;
      }
    }
    const loose = parseLooseRagModelJson(text);
    if (loose) return loose;
    throw new SyntaxError("model output is not JSON");
  }
}

async function callDeepSeek({ prompt, env, modelName, maxTokens, fetchImpl, temperature }) {
  const endpoint = deepSeekChatCompletionsUrl(env.DEEPSEEK_BASE_URL);
  const body = {
    model: modelName || DEFAULT_DEEPSEEK_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    temperature: temperature ?? readNumber(env.RAG_MODEL_TEMPERATURE, 0),
  };
  let response = await postJson(fetchImpl, endpoint, {
    authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    "content-type": "application/json",
  }, body);
  const warnings = [];
  if (!response.ok && response.status === 400) {
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    response = await postJson(fetchImpl, endpoint, {
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    }, fallbackBody);
    warnings.push("deepseek_response_format_fallback");
  }
  if (!response.ok) throw new Error(`deepseek ${response.status}`);
  const payload = await response.json();
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const rawText = extractChatMessageText(message.content);
  if (!rawText) warnings.push(`deepseek_empty_content:${choice.finish_reason || "unknown"}`);
  if (choice.finish_reason === "length") warnings.push("deepseek_output_truncated_by_token_limit");
  return {
    rawText,
    usage: payload?.usage || {},
    warnings,
  };
}

function extractChatMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    return typeof part?.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

async function callGemini({ prompt, env, modelName, maxTokens, fetchImpl, temperature, maxTokensEnvName = "GEMINI_MAX_OUTPUT_TOKENS" }) {
  const model = modelName || env.GEMINI_MODEL || "gemini-1.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: temperature ?? readNumber(env.GEMINI_TEMPERATURE, readNumber(env.RAG_MODEL_TEMPERATURE, 0)),
      maxOutputTokens: readNumber(env[maxTokensEnvName], maxTokens),
      responseMimeType: "application/json",
    },
  };
  const response = await postJson(fetchImpl, endpoint, { "content-type": "application/json" }, body);
  if (!response.ok) throw new Error(`gemini ${response.status}`);
  const payload = await response.json();
  return {
    rawText: (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("\n"),
    usage: payload?.usageMetadata || {},
    warnings: [],
  };
}

async function postJson(fetchImpl, url, headers, body) {
  return fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function parseModelResult(rawText, { provider, modelName, dryRun, warnings = [], budgetStatus = null }) {
  try {
    const parsed = rawText && typeof rawText === "object" ? rawText : parseRagModelJson(rawText);
    const parseWarnings = parsed?.__modelJsonRepaired ? ["model_json_repaired"] : [];
    if (parsed && typeof parsed === "object") delete parsed.__modelJsonRepaired;
    return {
      answer: normalizeModelAnswer(parsed),
      rawText: String(rawText || ""),
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun,
      warnings: [...warnings, ...parseWarnings],
      budgetStatus,
    };
  } catch (error) {
    const naturalLanguageAnswer = fallbackFromNaturalLanguage(rawText);
    if (naturalLanguageAnswer) {
      return {
        answer: naturalLanguageAnswer,
        rawText: String(rawText || ""),
        provider,
        providerUsed: provider,
        modelName,
        modelUsed: modelName || provider,
        dryRun,
        warnings: [...warnings, `model_json_parse_failed:${error instanceof Error ? error.message : String(error)}`, "model_natural_language_wrapped"],
        budgetStatus,
      };
    }
    return {
      answer: safeFallbackAnswer("model_json_parse_failed"),
      rawText: String(rawText || ""),
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun,
      warnings: [...warnings, `model_json_parse_failed:${error instanceof Error ? error.message : String(error)}`],
      budgetStatus,
    };
  }
}

function fallbackFromNaturalLanguage(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const jsonLike = looksLikeBrokenJson(text);
  return normalizeModelAnswer({
    answerLevel: "low_confidence_analysis",
    shortAnswer: jsonLike
      ? "模型返回了不完整的 JSON，无法完整解析；已转为低置信分析，请参考下方资料来源和风险提示。"
      : text.slice(0, 500),
    reasoning: [jsonLike
      ? "模型输出格式异常，系统没有把原始 JSON 当作裁定结论展示。"
      : "模型没有返回规范 JSON；已将自然语言内容作为低置信分析保留。"],
    usedEvidence: [],
    missingInfo: ["请复核引用资料，并优先寻找能直接覆盖该场景的官方 Q&A / FAQ。"],
    riskFlags: ["model_json_parse_failed", "model_output_not_json"],
    confidenceSelfEstimate: "low",
  });
}

function stripJsonCodeFence(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function parseLooseRagModelJson(text) {
  if (!looksLikeBrokenJson(text)) return null;
  const answerLevel = readJsonStringField(text, "answerLevel");
  const shortAnswer = readJsonStringField(text, "shortAnswer");
  if (!answerLevel && !shortAnswer) return null;
  const riskFlags = readJsonStringArrayField(text, "riskFlags");
  if (!riskFlags.includes("model_json_repaired")) riskFlags.push("model_json_repaired");
  return {
    __modelJsonRepaired: true,
    answerLevel: answerLevel || "low_confidence_analysis",
    shortAnswer: shortAnswer || "模型返回了不完整 JSON；以下为保守恢复后的分析。",
    reasoning: readJsonStringArrayField(text, "reasoning").length
      ? readJsonStringArrayField(text, "reasoning")
      : readJsonStringField(text, "reasoning"),
    usedCards: readJsonStringArrayField(text, "usedCards"),
    usedEvidence: readLooseUsedEvidence(text),
    missingInfo: readJsonStringArrayField(text, "missingInfo"),
    riskFlags,
    confidenceSelfEstimate: readJsonStringField(text, "confidenceSelfEstimate") || "low",
  };
}

function looksLikeBrokenJson(text) {
  return /^\s*[{[]/u.test(String(text || "")) || /"answerLevel"\s*:/u.test(String(text || ""));
}

function readJsonStringField(text, field) {
  const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u");
  const match = String(text || "").match(pattern);
  return match ? decodeJsonStringFragment(match[1]) : "";
}

function readJsonStringArrayField(text, field) {
  const segment = readJsonArraySegment(text, field);
  if (!segment) return [];
  return [...segment.matchAll(/"((?:\\.|[^"\\])*)"/gu)]
    .map((match) => decodeJsonStringFragment(match[1]))
    .filter(Boolean)
    .slice(0, 12);
}

function readLooseUsedEvidence(text) {
  const segment = readJsonArraySegment(text, "usedEvidence");
  if (!segment) return [];
  return [...segment.matchAll(/\{[^{}]*"id"\s*:\s*"((?:\\.|[^"\\])*)"[^{}]*\}/gu)]
    .map((match) => {
      const objectText = match[0];
      return {
        id: decodeJsonStringFragment(match[1]),
        type: readJsonStringField(objectText, "type"),
        title: readJsonStringField(objectText, "title"),
      };
    })
    .filter((item) => item.id)
    .slice(0, 8);
}

function readJsonArraySegment(text, field) {
  const source = String(text || "");
  const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*\\[`, "u");
  const match = pattern.exec(source);
  if (!match) return "";
  const start = match.index + match[0].lastIndexOf("[");
  const end = findMatchingClose(source, start, "[", "]");
  if (end >= 0) return source.slice(start, end + 1);
  const nextField = source.slice(start + 1).search(/,\s*"[A-Za-z][A-Za-z0-9_]*"\s*:/u);
  return nextField >= 0 ? source.slice(start, start + 1 + nextField) : source.slice(start);
}

function findMatchingClose(text, start, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function decodeJsonStringFragment(value) {
  try {
    return JSON.parse(`"${String(value || "").replace(/\n/gu, "\\n")}"`);
  } catch {
    return String(value || "")
      .replace(/\\"/gu, "\"")
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "\r")
      .replace(/\\t/gu, "\t")
      .trim();
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeModelAnswer(answer = {}) {
  const answerLevel = RAG_ANSWER_LEVELS.includes(answer.answerLevel)
    ? answer.answerLevel
    : "low_confidence_analysis";
  const confidence = ["low", "medium", "high"].includes(answer.confidenceSelfEstimate)
    ? answer.confidenceSelfEstimate
    : answerLevel === "official_confirmed" ? "high" : "low";
  const shortAnswer = nonEmpty(answer.shortAnswer || answer.short_answer || answer.verdict)
    || "根据现有资料只能给出未确认分析。";
  const reasoning = normalizeModelReasoning(answer);
  const riskFlags = cleanStringArray(answer.riskFlags);

  if (!reasoning.length) {
    const recovered = deriveReasoningFromShortAnswer(shortAnswer);
    if (recovered.length) {
      reasoning.push(...recovered);
      addUniqueString(riskFlags, "model_reasoning_recovered_from_short_answer");
    } else {
      reasoning.push("模型返回了结论，但没有提供可核对的理由；请结合下方资料来源复核。");
      addUniqueString(riskFlags, "model_reasoning_missing");
    }
  }

  return {
    answerLevel,
    shortAnswer,
    reasoning,
    usedCards: cleanStringArray(answer.usedCards),
    usedEvidence: normalizeUsedEvidence(answer.usedEvidence),
    missingInfo: cleanStringArray(answer.missingInfo),
    riskFlags,
    confidenceSelfEstimate: confidence,
  };
}

function normalizeModelReasoning(answer = {}) {
  const candidates = [
    answer.reasoning,
    answer.reasons,
    answer.explanation,
    answer.explanations,
    answer.analysis,
    answer.reason,
  ];
  for (const candidate of candidates) {
    const items = cleanReasoningItems(candidate);
    if (items.length) return items;
  }
  return [];
}

function cleanReasoningItems(value) {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return source
    .flatMap((item) => {
      const text = typeof item === "string"
        ? item
        : nonEmpty(item?.reason || item?.explanation || item?.text || item?.content);
      return String(text || "").split(/\r?\n+/u);
    })
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function deriveReasoningFromShortAnswer(shortAnswer) {
  const text = nonEmpty(shortAnswer);
  if (!text) return [];
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*|\r?\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = sentences.length > 1
    ? sentences.slice(1)
    : [text.replace(/^(?:可以|能够|能|不可以|不能|无法|是|否)[，,:：\s]*/u, "")];
  return candidates
    .filter((item) => item.length >= 8)
    .filter((item) => /因为|由于|根据|因此|所以|意味着|只能|无法|不满足|满足|要求|规定|处理时|结算时|连锁中|发动后|适用/u.test(item))
    .slice(0, 6);
}

function addUniqueString(items, value) {
  if (!items.includes(value)) items.push(value);
}

function buildMockAnswer({ evidence, cardResolution }) {
  const direct = evidence.officialQaDirectCandidates?.[0];
  const related = evidence.officialQaRelated?.[0] || evidence.faqRelated?.[0] || evidence.rawRelatedEvidence?.[0];
  const cardText = evidence.cardTexts?.[0];
  const userProvidedText = evidence.userProvidedCardTexts?.[0];
  const cardGrounding = cardText || userProvidedText;
  if (direct) {
    return normalizeModelAnswer({
      answerLevel: "official_confirmed",
      shortAnswer: "命中了官方直接 Q&A；请以该资料原文为准。",
      reasoning: ["检索结果中存在 officialQaDirectCandidates。", "该候选资料可以作为官方直接依据。"],
      usedCards: (cardResolution.resolvedCards || []).map((card) => card.name).filter(Boolean),
      usedEvidence: [{ id: direct.id, type: "official_qa", title: direct.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "high",
    });
  }
  if (cardGrounding || related) {
    const used = [cardGrounding, related].filter(Boolean).map((item) => ({ id: item.id, type: item.type, title: item.title }));
    return normalizeModelAnswer({
      answerLevel: cardGrounding ? "rule_analysis" : "low_confidence_analysis",
      shortAnswer: cardGrounding
        ? "没有命中官方直接 Q&A；下面只能基于卡片文本和相关资料给出未确认分析。"
        : "没有命中官方直接 Q&A；下面只能基于相关资料给出低置信分析。",
      reasoning: [
        cardGrounding ? "已读取相关卡片文本。" : "",
        related ? "检索到相关资料，但它不是当前问题的官方 direct Q&A。" : "",
      ].filter(Boolean),
      usedCards: [
        ...(cardResolution.resolvedCards || []).map((card) => card.name),
        ...(userProvidedText?.cards || []),
      ].filter(Boolean),
      usedEvidence: used,
      missingInfo: [],
      riskFlags: [
        "no_official_direct_qa",
        cardGrounding ? "card_text_grounding_only" : "partial_evidence_only",
        userProvidedText ? "user_provided_text_not_official" : "",
      ].filter(Boolean),
      confidenceSelfEstimate: cardGrounding && related ? "medium" : "low",
    });
  }
  return safeFallbackAnswer("no_retrieved_evidence");
}

function safeFallbackAnswer(reason, shortAnswer = "当前资料不足，无法给出可靠裁定分析。", answerLevel = "needs_more_info") {
  return normalizeModelAnswer({
    answerLevel,
    shortAnswer,
    reasoning: ["没有可用的模型 JSON 结果或检索资料不足。"],
    usedEvidence: [],
    missingInfo: ["请补充正式卡名、效果编号、具体时点和连锁状态。"],
    riskFlags: [reason],
    confidenceSelfEstimate: "low",
  });
}

async function buildBudgetPreflight({ provider, prompt, maxTokens, env, fetchImpl, now, trackSpend = true }) {
  const config = budgetConfig(env);
  const dayKey = budgetDayKey(config.timezone, now);
  let storage = budgetStorage(env);
  const warnings = budgetStorageWarnings(storage);
  const estimated = estimatePreflightCostCny(provider, prompt, maxTokens, env);
  if (storage === "unconfigured") {
    const blocked = trackSpend && config.mode === "hard";
    return {
      config,
      storage,
      dayKey,
      blocked,
      reservedAmountCny: 0,
      warnings,
      status: budgetStatusPayload({ config, storage, dayKey, spent: null, estimated, blocked }),
    };
  }
  if (!trackSpend) {
    return {
      config,
      storage,
      dayKey,
      blocked: false,
      reservedAmountCny: 0,
      warnings,
      status: budgetStatusPayload({ config, storage, dayKey, spent: 0, estimated, blocked: false }),
    };
  }
  let spent = 0;
  let blocked = false;
  let reservedAmountCny = 0;
  try {
    spent = await readBudgetSpent({ storage, dayKey, env, fetchImpl });
  } catch (error) {
    warnings.push(`budget_storage_unavailable:${safeErrorMessage(error)}`);
    if (storage === "redis" && config.mode === "hard") {
      blocked = true;
      storage = "unavailable";
    } else {
      storage = "memory";
      warnings.push("redis_budget_unavailable_using_memory_soft_limit");
      spent = await readBudgetSpent({ storage, dayKey, env, fetchImpl });
    }
  }
  if (!blocked && trackSpend && config.dailyBudgetCny > 0 && estimated > 0) {
    if (spent + estimated > config.dailyBudgetCny) {
      blocked = true;
    } else {
      spent = await addBudgetSpent({ storage, dayKey, amount: estimated, env, fetchImpl });
      reservedAmountCny = estimated;
      if (spent > config.dailyBudgetCny) {
        await addBudgetSpent({ storage, dayKey, amount: -estimated, env, fetchImpl }).catch(() => null);
        spent = await readBudgetSpent({ storage, dayKey, env, fetchImpl }).catch(() => spent);
        blocked = true;
        reservedAmountCny = 0;
      }
    }
  }
  return {
    config,
    storage,
    dayKey,
    blocked,
    reservedAmountCny,
    warnings,
    status: budgetStatusPayload({ config, storage, dayKey, spent, estimated, blocked }),
  };
}

async function recordBudgetSpend({ preflight, actualCostCny, env, fetchImpl }) {
  if (preflight.storage === "unconfigured") {
    return {
      ...preflight.status,
      estimatedThisCallCny: actualCostCny,
      limitEnforced: preflight.blocked,
    };
  }
  const delta = preflight.reservedAmountCny
    ? actualCostCny - preflight.reservedAmountCny
    : actualCostCny;
  const spent = await addBudgetSpent({
    storage: preflight.storage,
    dayKey: preflight.dayKey,
    amount: delta,
    env,
    fetchImpl,
  });
  return {
    ...preflight.status,
    spentTodayCny: roundCost(spent),
    estimatedThisCallCny: actualCostCny,
    limitEnforced: preflight.blocked,
  };
}

async function releaseBudgetReservation({ preflight, env, fetchImpl }) {
  if (!preflight.reservedAmountCny) return preflight.status;
  const spent = await addBudgetSpent({
    storage: preflight.storage,
    dayKey: preflight.dayKey,
    amount: -preflight.reservedAmountCny,
    env,
    fetchImpl,
  });
  return {
    ...preflight.status,
    spentTodayCny: roundCost(spent),
    estimatedThisCallCny: 0,
  };
}

function budgetConfig(env) {
  return {
    dailyBudgetCny: readNumber(env.API_DAILY_BUDGET_CNY, DEFAULT_DAILY_BUDGET_CNY),
    timezone: String(env.API_BUDGET_TIMEZONE || DEFAULT_BUDGET_TIMEZONE),
    mode: ["soft", "hard"].includes(String(env.API_BUDGET_MODE || "").toLowerCase())
      ? String(env.API_BUDGET_MODE).toLowerCase()
      : "soft",
  };
}

function budgetStorage(env) {
  const redis = redisConfig(env);
  if (redis.url && redis.token) return "redis";
  return requiresPersistentBudget(env) ? "unconfigured" : "memory";
}

async function readBudgetSpent({ storage, dayKey, env, fetchImpl }) {
  if (storage === "redis" && typeof fetchImpl === "function") {
    const result = await redisCommand(env, fetchImpl, ["GET", dayKey]);
    return Number(result || 0) || 0;
  }
  return Number(memoryBudget.get(dayKey) || 0);
}

async function addBudgetSpent({ storage, dayKey, amount, env, fetchImpl }) {
  if (!Number.isFinite(amount) || amount === 0) return readBudgetSpent({ storage, dayKey, env, fetchImpl });
  if (storage === "redis" && typeof fetchImpl === "function") {
    const result = await redisCommand(env, fetchImpl, ["INCRBYFLOAT", dayKey, String(amount)]);
    await redisCommand(env, fetchImpl, ["EXPIRE", dayKey, "172800"]);
    return Number(result || 0) || 0;
  }
  const next = Math.max(0, Number(memoryBudget.get(dayKey) || 0) + amount);
  memoryBudget.set(dayKey, next);
  return next;
}

async function setBudgetSpent({ storage, dayKey, value, env, fetchImpl }) {
  const next = Math.max(0, Number(value || 0));
  if (storage === "redis" && typeof fetchImpl === "function") {
    await redisCommand(env, fetchImpl, ["SET", dayKey, String(next), "EX", "172800"]);
    return next;
  }
  memoryBudget.set(dayKey, next);
  return next;
}

async function redisCommand(env, fetchImpl, command) {
  const redis = redisConfig(env);
  if (!redis.url || !redis.token) throw new Error("redis_not_configured");
  const response = await fetchImpl(redis.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${redis.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`redis ${response.status}`);
  const payload = await response.json();
  return payload?.result;
}

function redisConfig(env = {}) {
  return {
    url: String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || env.REDIS_REST_API_URL || "").trim(),
    token: String(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.REDIS_REST_API_TOKEN || "").trim(),
  };
}

function requiresPersistentBudget(env = {}) {
  return isEnabled(env.API_BUDGET_REQUIRE_PERSISTENT_STORAGE) || isEnabled(env.VERCEL);
}

function budgetStorageWarnings(storage) {
  if (storage === "memory") return ["persistent_budget_storage_missing_vercel_limit_is_soft"];
  if (storage === "unconfigured") return ["persistent_budget_storage_missing_backend_kv_required"];
  return [];
}

function budgetStatusPayload({ config, storage, dayKey, spent, estimated, blocked }) {
  const status = {
    dailyBudgetCny: config.dailyBudgetCny,
    spentTodayCny: spent === null ? null : roundCost(spent),
    estimatedThisCallCny: estimated,
    budgetMode: config.mode,
    budgetStorage: storage,
    budgetPersistent: storage === "redis",
    limitEnforced: blocked,
    dayKey,
  };
  if (storage === "unconfigured") {
    status.storageWarning = "后端未启用持久化预算存储；请配置 KV_REST_API_URL/KV_REST_API_TOKEN 或 UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN。";
  } else if (storage === "memory") {
    status.storageWarning = "当前使用进程内存统计；本地可用，serverless 部署刷新或冷启动后不会可靠保留。";
  }
  return status;
}

function estimatePreflightCostCny(provider, prompt, maxTokens, env) {
  const promptTokens = Math.ceil(String(prompt || "").length / 4);
  if (provider === "deepseek") {
    return estimateDeepSeekCostCny({ prompt_tokens: promptTokens, completion_tokens: maxTokens }, env);
  }
  if (provider === "gemini") {
    return roundCost(readTieredProviderNumber(env, "GEMINI", "ESTIMATED_CNY_PER_CALL", 0.01));
  }
  return 0;
}

function estimateActualCostCny(provider, usage, env) {
  if (provider === "deepseek") return estimateDeepSeekCostCny(usage, env);
  if (provider === "gemini") return roundCost(readTieredProviderNumber(env, "GEMINI", "ESTIMATED_CNY_PER_CALL", 0.01));
  return 0;
}

function normalizeUsage(provider, usage = {}) {
  if (provider === "gemini") {
    return {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    };
  }
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
    prompt_cache_hit_tokens: Number(usage.prompt_cache_hit_tokens || usage.prompt_tokens_details?.cached_tokens || 0),
    prompt_cache_miss_tokens: Number(usage.prompt_cache_miss_tokens || 0),
  };
}

function buildCardNameExtractionPrompt(userQuery) {
  const example = {
    cardNames: [
      { name: "正式或可能的卡名", originalText: "玩家原文片段", confidence: "medium" },
    ],
  };
  return [
    "你只负责从玩家的游戏王 OCG 裁定问题中提取所有可能的卡名候选，不要回答裁定。",
    "把问题中出现的每一张卡都列出，包括没有括号的卡名、简称、俗称、错别字、漏字、缺少间隔点、系列内短称和后文简称。",
    "中文问题优先把 name 写成可用于中文卡查/百鸽搜索的中文或日文卡名；除非玩家原文就是英文，不要只翻译成英文名。",
    "如果玩家先写完整卡名、后文用简称指代同一张卡，name 尽量输出可检索的完整卡名，originalText 保留后文实际片段。",
    "如果不能确信，也要输出为候选，只把 confidence 设为 low；后续检索会负责确认。",
    "不要因为卡名不在【】《》「」中就跳过。不要因为不熟悉该卡就跳过。",
    "保留玩家原文片段 originalText。",
    "输出必须是单个 JSON 对象，不要 markdown，不要解释。",
    "JSON 只包含 cardNames 数组；每项包含 name、originalText、confidence。",
    "不要输出效果名、动作、场地区域、玩家称谓、数值、处理结果或规则术语。",
    "示例结构如下，示例不是本题答案：",
    JSON.stringify(example),
    "玩家问题：",
    String(userQuery || ""),
  ].join("\n");
}

function buildRuleQueryExtractionPrompt(userQuery) {
  const example = {
    ruleQueries: [
      { query: "伤害步骤结束时 送去墓地 发动位置", reason: "判断时点和卡片当前位置", confidence: "medium" },
      { query: "连锁处理中 对象离场 效果处理", reason: "判断处理时对象状态", confidence: "medium" },
    ],
  };
  return [
    "你只负责从玩家的游戏王 OCG 裁定问题中提取用于检索规则资料、FAQ 或官方相似 Q&A 的查询词，不要回答裁定。",
    "查询词应围绕规则机制、处理时点、连锁窗口、对象要求、当前位置、表侧/里侧、效果处理、伤害步骤等，不要只输出卡名。",
    "如果问题涉及俗称或自然语言，请改写为可检索的规则词组；可以混合中文、日文或英文关键词。",
    "输出 3 到 8 条高价值查询词即可；不知道就输出空数组。",
    "输出必须是单个 JSON 对象，不要 markdown，不要解释。",
    "JSON 只包含 ruleQueries 数组；每项包含 query、reason、confidence。",
    "示例结构如下，示例不是本题答案：",
    JSON.stringify(example),
    "玩家问题：",
    String(userQuery || ""),
  ].join("\n");
}

function buildRulebookGroundingPrompt({
  userQuery,
  cardTexts = [],
  evidenceCandidates = [],
  priorityConstraintEvidence = [],
}) {
  const example = {
    constraintReviews: [{
      evidenceId: "restrictive-evidence-id",
      operationId: "operation-1",
      action: "玩家试图执行的操作",
      relevance: "applies",
      consequence: "blocks",
      conclusion: "该限制规则适用于当前事实，因此操作不能进行。",
      quote: "必须从候选原文逐字复制的连续片段",
      application: "逐项说明题目事实为何满足这条限制规则。",
    }],
    operationChecks: [{
      operationId: "operation-1",
      step: 1,
      action: "玩家试图执行的操作",
      legalityQuestion: "该操作在当前时点是否合法",
      status: "conditional",
      conclusion: "只有满足规则书引文所述条件时才合法。",
      reasoning: ["把题目事实与引文条件逐项比较。"],
      citations: [{ id: "evidence-id", quote: "必须从候选原文逐字复制的连续片段", application: "该引文如何约束当前操作。" }],
      missingFacts: [],
    }],
    overallConclusion: "基于逐步检查得到的结论。",
  };
  const payload = {
    userQuery: String(userQuery || ""),
    priorityConstraintCandidates: (priorityConstraintEvidence || []).slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      text: String(item.text || "").slice(0, 2200),
      sourceUrl: item.sourceUrl || "",
    })),
    cardTexts: (cardTexts || []).slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      cards: item.cards || [],
      source: item.source || item.type || "",
      cardType: item.cardType || "",
      attribute: item.attribute ?? "",
      race: item.race ?? "",
      text: String(item.text || "").slice(0, 2200),
    })),
    evidenceCandidates: (evidenceCandidates || []).slice(0, 34).map((item) => ({
      id: item.id,
      type: item.type || item.recordType || "related",
      title: item.title,
      text: String(item.text || "").slice(0, 1800),
      sourceUrl: item.sourceUrl || "",
      isDirect: item.isDirect === true,
    })),
  };
  return [
    "你是游戏王 OCG 证据判读器，不负责直接润色最终回答。",
    "先结合玩家问题与卡片文本，按实际发生顺序抽取每一步需要验证的操作，包括：发动条件、支付 cost、选择对象、连锁窗口、效果处理、位置变化、次数限制和后续处理。",
    "priorityConstraintCandidates 是后端按题目操作与限制性措辞筛出的潜在阻断规则，已附规则原文。它们不代表必然适用，但每一条都必须先审查，不能跳过。",
    "对 priorityConstraintCandidates 中每个 id 都输出一个 constraintReviews 项：relevance 只能是 applies、not_applicable、uncertain；consequence 只能是 blocks、limits、none、uncertain。quote 必须逐字来自对应 evidenceCandidates，application 必须比较题目事实与规则条件。",
    "如果限制规则适用且会阻止操作，constraintReviews 写 applies + blocks，并在 operationChecks 中把相应步骤判为 illegal。若判定不适用，必须明确说明规则条件与题目事实的差异，不能只写结论。",
    "每个关键步骤先列清题目事实，再选择真正覆盖该步骤的候选证据。卡片文本可以证明该卡写明的发动条件、cost、对象和处理；通用规则结论必须由规则书或适用场景一致的 Q&A / FAQ 支持。",
    "每一步都要分别检查‘能否发动’‘能否选择为对象’‘效果是否适用’‘处理后状态’；这四类问题不能互相替代。",
    "‘不受其他卡的效果影响’只约束效果是否适用，本身不等于‘不能成为效果对象’；‘不能成为对象’必须有独立的对象限制或玩家限制证据，反过来也一样。",
    "同一场景同时存在对象保护与效果抗性时，要分别列出证据，并明确最终阻止操作的是哪一项；不得把抗性误写成不能取对象的理由。",
    "涉及‘将发动无效并破坏’时，必须依据候选证据区分被无效的是魔法・陷阱卡的卡的发动，还是已在场卡片的效果发动，并据此判断是否属于破坏场上的卡。",
    "不得仅因发动效果的卡或效果对象在连锁处理中离开原位置，就把整条已经合法发动的效果判为不处理。必须分别检查发动是否已成立、每项处理依赖的卡或位置、前一项不能处理时后一项是否继续，并为规则结论引用证据。",
    "对象在处理时不再存在，不代表不依赖该对象的其他处理自动消失；但也不能反过来假定所有后续处理必然继续。要依据效果连接词、规则书和 Q&A 逐项判断。",
    "如果较早步骤已被证据判为 illegal，后续处理应标记为未发生或不再需要判断；不得假设该操作已经成功后继续推演。",
    "然后只使用 evidenceCandidates 中提供的卡片文本、规则书、官方 Q&A 或卡片 FAQ 原文，逐步判断该操作是 legal、illegal、conditional 还是 unknown。",
    "官方 Q&A / FAQ 可以作为规则适用案例，但必须逐项比较涉及的卡片、效果、时点、位置、素材数量和处理顺序；场景不同的相似案例不能直接套用。",
    "只说明诱发条件或可连锁时点的一般卡片 FAQ，不能单独证明整个发动合法。回答 legal 前还必须核对所有必做处理是否存在可适用对象或卡、是否受位置和连锁规则限制，以及 priorityConstraintCandidates 是否阻断。",
    "更具体地约束当前处理的规则，不得被只说明一般发动窗口的 FAQ 覆盖；两者看似冲突时必须分别说明各自证明了什么。",
    "isDirect=false 的 Q&A / FAQ 不是当前问题的官方直接裁定，只能支持规则分析；不得因此宣称 official_confirmed。",
    "不要依靠记忆补写规则，不要把卡片文本误当规则证据，不要因为候选标题看起来相关就直接下结论。",
    "每个 legal、illegal 或 conditional 判定都必须至少提供一个 citations 项；id 必须来自 evidenceCandidates，quote 必须逐字复制该候选中的一段连续原文。",
    "如果候选证据没有覆盖该操作，status 必须是 unknown，citations 留空，并在 missingFacts 说明缺什么；不得猜测。",
    "必须区分‘能否发动’、‘能否成为对象/可适用卡’与‘已经发动后的效果如何处理’，不要用后续处理规则倒推出错误的发动合法性。",
    "如果一条候选原文同时明确点名题目中的多张卡并描述同一操作，应把它视为比泛化规则更直接的场景证据，优先逐字引用并按其完整结论处理。",
    "对于包含多个连续处理的效果，必须依次检查取对象、移除素材、位置移动及后续特殊召唤等全部步骤；overallConclusion 必须覆盖完整处理，不能只回答第一步。",
    "对题目中的每一个关键操作都要单独生成 operationChecks 项；不能只检查最后一步。",
    "输出必须是单个 JSON 对象，不要 markdown，不要 JSON 外文字。",
    "JSON 只包含 constraintReviews、operationChecks 和 overallConclusion。",
    "示例结构如下，示例不是本题答案：",
    JSON.stringify(example, null, 2),
    "本次输入：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function normalizeCardNameCandidates(rawText) {
  let parsed = null;
  try {
    parsed = rawText && typeof rawText === "object" ? rawText : parseRagModelJson(rawText);
  } catch {
    return [];
  }
  const source = Array.isArray(parsed?.cardNames) ? parsed.cardNames
    : Array.isArray(parsed?.cards) ? parsed.cards
      : Array.isArray(parsed?.names) ? parsed.names
        : [];
  const candidates = source
    .map((item) => typeof item === "string"
      ? { name: item, originalText: item, confidence: "medium" }
      : {
          name: item?.name || item?.cardName || item?.candidate || "",
          originalText: item?.originalText || item?.surface || item?.mention || item?.input || item?.name || "",
          confidence: item?.confidence || item?.confidenceSelfEstimate || "medium",
        })
    .map((item) => ({
      name: nonEmpty(item.name).slice(0, 80),
      originalText: nonEmpty(item.originalText).slice(0, 80),
      confidence: ["low", "medium", "high"].includes(String(item.confidence || "").toLowerCase())
        ? String(item.confidence).toLowerCase()
        : "medium",
      source: "model_card_name_extractor",
    }))
    .filter((item) => item.name.length >= 2 && /[A-Za-z\u3040-\u30ff\u3400-\u9fff0-9]/u.test(item.name))
    .filter((item) => !/^(?:效果|发动|發動|适用|適用|对象|對象|场上|場上|墓地|除外|手卡|卡组|牌组|连锁|連鎖)$/u.test(item.name));
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.name.normalize("NFKC").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= 12) break;
  }
  return result;
}

function normalizeRuleSearchQueries(rawText) {
  let parsed = null;
  try {
    parsed = rawText && typeof rawText === "object" ? rawText : parseRagModelJson(rawText);
  } catch {
    return [];
  }
  const source = Array.isArray(parsed?.ruleQueries) ? parsed.ruleQueries
    : Array.isArray(parsed?.queries) ? parsed.queries
      : Array.isArray(parsed?.ruleSearchQueries) ? parsed.ruleSearchQueries
        : Array.isArray(parsed?.keywords) ? parsed.keywords
          : [];
  const candidates = source
    .map((item) => typeof item === "string"
      ? { query: item, reason: "", confidence: "medium" }
      : {
          query: item?.query || item?.searchQuery || item?.keyword || item?.topic || "",
          reason: item?.reason || item?.why || item?.purpose || "",
          confidence: item?.confidence || item?.confidenceSelfEstimate || "medium",
        })
    .map((item) => ({
      query: nonEmpty(item.query).replace(/\s+/gu, " ").slice(0, 120),
      reason: nonEmpty(item.reason).replace(/\s+/gu, " ").slice(0, 120),
      confidence: ["low", "medium", "high"].includes(String(item.confidence || "").toLowerCase())
        ? String(item.confidence).toLowerCase()
        : "medium",
      source: "model_rule_query_extractor",
    }))
    .filter((item) => item.query.length >= 2 && /[A-Za-z\u3040-\u30ff\u3400-\u9fff0-9]/u.test(item.query))
    .filter((item) => !/^[\s\p{P}]+$/u.test(item.query));
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.query.normalize("NFKC").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= 8) break;
  }
  return result;
}

function emptyCardNameExtractionResult(providerUsed, modelUsed, dryRun, warnings = []) {
  return {
    candidates: [],
    rawText: "",
    providerUsed,
    modelUsed,
    dryRun,
    warnings,
  };
}

function emptyRuleQueryExtractionResult(providerUsed, modelUsed, dryRun, warnings = []) {
  return {
    queries: [],
    rawText: "",
    providerUsed,
    modelUsed,
    dryRun,
    warnings,
  };
}

function emptyRulebookGroundingResult(
  providerUsed,
  modelUsed,
  dryRun,
  warnings = [],
  requiredConstraintEvidence = [],
) {
  return {
    operationLegality: emptyOperationLegality(warnings, requiredConstraintEvidence),
    rawText: "",
    providerUsed,
    modelUsed,
    dryRun,
    warnings: [...new Set(warnings)],
    tokenUsage: {},
    estimatedCostCny: 0,
    budgetStatus: null,
  };
}

function resolveRagMaxOutputTokens(env = {}) {
  const configured = Number(env.RAG_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return readPositiveNumber(env.RAG_FLASH_MAX_OUTPUT_TOKENS, 2500);
}

function dedupeGroundingEvidence(items = []) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const id = String(item?.id || "").trim();
    if (!id || !item?.text || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function selectPriorityConstraintEvidence({ items = [], userQuery = "", cardTexts = [], limit = 3 } = {}) {
  const scenarioText = [
    userQuery,
    ...(cardTexts || []).map((item) => [item.title, item.cardType, item.text].filter(Boolean).join("\n")),
  ].join("\n");
  const scenarioConcepts = extractGroundingMechanisms(scenarioText);
  if (scenarioConcepts.size < 2) return [];

  return dedupeGroundingEvidence(items)
    .filter((item) => RESTRICTIVE_EVIDENCE_PATTERN.test(String(item.text || "")))
    .map((item, index) => {
      const evidenceConcepts = extractGroundingMechanisms(`${item.title || ""}\n${item.text || ""}`);
      const sharedConcepts = [...scenarioConcepts].filter((concept) => evidenceConcepts.has(concept));
      const hasReturnChainPair = sharedConcepts.includes("return") && sharedConcepts.includes("chain");
      const hasActivationApplicabilityPair = sharedConcepts.includes("activation") && sharedConcepts.includes("applicability");
      const score = sharedConcepts.length * 20
        + (hasReturnChainPair ? 18 : 0)
        + (hasActivationApplicabilityPair ? 12 : 0)
        + Math.min(20, Number(item.score) || 0)
        - index * 0.01;
      return { item, sharedConcepts, score };
    })
    .filter((entry) => entry.sharedConcepts.length >= 3)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((entry) => entry.item);
}

function extractGroundingMechanisms(value) {
  const text = String(value || "");
  return new Set(GROUNDING_MECHANISM_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name));
}

function selectGroundingQaEvidence(items = [], maxCandidates = 10) {
  const available = dedupeGroundingEvidence(Array.isArray(items) ? items : []);
  const limit = Math.max(0, Number(maxCandidates) || 0);
  if (!limit) return [];

  const direct = available.filter(isDirectGroundingQa);
  const faq = available.filter((item) => !isDirectGroundingQa(item) && isFaqGroundingEvidence(item));
  const related = available.filter((item) => !isDirectGroundingQa(item) && !isFaqGroundingEvidence(item));
  const selectedDirect = direct.slice(0, limit);
  return dedupeGroundingEvidence([
    ...selectedDirect,
    ...interleaveGroundingEvidence([faq, related], limit - selectedDirect.length),
  ]).slice(0, limit);
}

function interleaveGroundingEvidence(buckets = [], maxItems = Number.POSITIVE_INFINITY) {
  const normalizedBuckets = (Array.isArray(buckets) ? buckets : [])
    .map((bucket) => dedupeGroundingEvidence(Array.isArray(bucket) ? bucket : []));
  const limit = Number.isFinite(maxItems) ? Math.max(0, Number(maxItems) || 0) : Number.POSITIVE_INFINITY;
  const result = [];
  const seen = new Set();
  let index = 0;

  while (result.length < limit && normalizedBuckets.some((bucket) => index < bucket.length)) {
    for (const bucket of normalizedBuckets) {
      const item = bucket[index];
      if (!item) continue;
      const id = String(item.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(item);
      if (result.length >= limit) break;
    }
    index += 1;
  }
  return result;
}

function isDirectGroundingQa(item = {}) {
  return item.isDirect === true || item.type === "official_qa";
}

function isFaqGroundingEvidence(item = {}) {
  return item.type === "faq" || item.recordType === "card-faq" || String(item.id || "").startsWith("card-faq-");
}

function modelNameForProvider(provider, env) {
  if (provider === "deepseek") {
    return String(env.DEEPSEEK_FLASH_MODEL || env.DEEPSEEK_CARD_MODEL || env.RAG_CARD_MODEL || DEFAULT_DEEPSEEK_CARD_MODEL);
  }
  if (provider === "gemini") {
    return String(env.GEMINI_FLASH_MODEL || env.GEMINI_CARD_MODEL || "gemini-1.5-flash");
  }
  return "mock-rag";
}

function modelNameForCardExtractionProvider(provider, env) {
  if (provider === "deepseek") return String(env.DEEPSEEK_CARD_MODEL || env.RAG_CARD_MODEL || DEFAULT_DEEPSEEK_CARD_MODEL);
  if (provider === "gemini") return String(env.GEMINI_CARD_MODEL || env.GEMINI_CARD_RESOLUTION_MODEL || env.RAG_CARD_MODEL || "gemini-1.5-flash");
  return "mock-card-extractor";
}

function modelNameForRuleQueryExtractionProvider(provider, env) {
  if (provider === "deepseek") return String(env.DEEPSEEK_RULE_MODEL || env.RAG_RULE_MODEL || env.DEEPSEEK_CARD_MODEL || env.RAG_CARD_MODEL || DEFAULT_DEEPSEEK_CARD_MODEL);
  if (provider === "gemini") return String(env.GEMINI_RULE_MODEL || env.GEMINI_CARD_MODEL || env.GEMINI_CARD_RESOLUTION_MODEL || env.RAG_RULE_MODEL || env.RAG_CARD_MODEL || "gemini-1.5-flash");
  return "mock-rule-query-extractor";
}

function modelNameForRulebookGroundingProvider(provider, env) {
  if (provider === "deepseek") return String(env.DEEPSEEK_RULEBOOK_MODEL || env.DEEPSEEK_RULE_MODEL || env.DEEPSEEK_CARD_MODEL || env.RAG_RULE_MODEL || env.RAG_CARD_MODEL || DEFAULT_DEEPSEEK_CARD_MODEL);
  if (provider === "gemini") return String(env.GEMINI_RULEBOOK_MODEL || env.GEMINI_RULE_MODEL || env.GEMINI_CARD_MODEL || env.RAG_RULE_MODEL || env.RAG_CARD_MODEL || "gemini-1.5-flash");
  return "mock-rulebook-grounding";
}

function hasProviderKey(provider, env) {
  if (provider === "deepseek") return Boolean(env.DEEPSEEK_API_KEY);
  if (provider === "gemini") return Boolean(env.GEMINI_API_KEY);
  return false;
}

function deepSeekChatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/u, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function normalizeUsedEvidence(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id || "").trim(),
      type: String(item?.type || "related").trim(),
      title: String(item?.title || "").trim(),
    }))
    .filter((item) => item.id)
    .slice(0, 12);
}

function cleanStringArray(value) {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return source
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item).trim();
      return nonEmpty(item?.text || item?.value || item?.name || item?.id);
    })
    .filter(Boolean)
    .slice(0, 12);
}

function nonEmpty(value) {
  const text = String(value || "").trim();
  return text || "";
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readTieredProviderNumber(env, providerPrefix, suffix, fallback) {
  const flashValue = Number(env[`${providerPrefix}_FLASH_${suffix}`]);
  if (Number.isFinite(flashValue)) return flashValue;
  return readNumber(env[`${providerPrefix}_${suffix}`], fallback);
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function extractionCacheKey(kind, provider, modelName, userQuery) {
  return [
    kind,
    provider || "",
    modelName || "",
    String(userQuery || "").normalize("NFKC").trim().toLowerCase(),
  ].join("\u0000");
}

function readCachedExtraction(cache, key, env) {
  const ttlMs = readPositiveNumber(env.RAG_EXTRACTION_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.savedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return JSON.parse(JSON.stringify(item.value));
}

function writeCachedExtraction(cache, key, value, env) {
  const maxEntries = readPositiveNumber(env.RAG_EXTRACTION_CACHE_MAX_ENTRIES, 200);
  cache.set(key, { savedAt: Date.now(), value: JSON.parse(JSON.stringify(value)) });
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isDisabled(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").toLowerCase());
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error || "unknown").replace(/\s+/gu, "_").slice(0, 120);
}

function mtok(tokens) {
  return Number(tokens || 0) / 1_000_000;
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function budgetDayKey(timezone, now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_BUDGET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `rag-api-budget:${lookup.year}-${lookup.month}-${lookup.day}`;
}
