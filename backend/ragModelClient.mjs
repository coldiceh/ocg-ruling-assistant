import { emptyOperationLegality, validateOperationLegalityModelOutput } from "./operationLegalityAnalyzer.mjs";
import { RAG_ANSWER_LEVELS } from "./ragRulingPrompt.mjs";
import { compileRuleScenario } from "./ruleScenarioCompiler.mjs";
import {
  DEFAULT_PUBLIC_RELAY_BASE_URL,
  DEFAULT_PUBLIC_RELAY_MODEL,
  resolvePublicRulingModelProfile,
} from "./publicRulingModelConfig.mjs";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_CARD_MODEL = "deepseek-v4-flash";
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_MODEL = "glm-5.2";
const DEFAULT_JSON_TASK_MAX_OUTPUT_TOKENS = 4000;
const DEFAULT_RAG_RECOVERY_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_LIGHTWEIGHT_EXTRACTION_TIMEOUT_MS = 4500;
const DEFAULT_DAILY_BUDGET_CNY = 10;
const DEFAULT_BUDGET_TIMEZONE = "Asia/Shanghai";
const DEEPSEEK_THINKING_MODES = new Set(["enabled", "disabled"]);
const DEEPSEEK_REASONING_EFFORTS = new Set(["high", "max"]);
const RELAY_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const PUBLIC_BUDGET_BUCKETS = Object.freeze([
  Object.freeze({ id: "evidence_preparation:deepseek", stage: "evidence_preparation", provider: "deepseek", label: "DeepSeek 资料准备" }),
  Object.freeze({ id: "final_ruling:glm", stage: "final_ruling", provider: "glm", label: "GLM 最终裁定" }),
  Object.freeze({ id: "final_ruling:deepseek", stage: "final_ruling", provider: "deepseek", label: "DeepSeek 最终裁定" }),
  Object.freeze({ id: "final_ruling:relay", stage: "final_ruling", provider: "relay", label: "第三方中转最终裁定（模型身份未验证）" }),
]);
const RESTRICTIVE_EVIDENCE_PATTERN = /(?:不能|不可|不得|无法|不可以|不适用|不在场上存在|禁止|不满足|不存在|cannot|can't|must not|may not|not allowed|できません|発動できません)/iu;
const GROUNDING_MECHANISM_PATTERNS = Object.freeze([
  ["activation", /发动|發動|発動|activate/iu],
  ["chain", /连锁|連鎖|チェーン|chain/iu],
  ["target", /对象|對象|対象|target/iu],
  ["applicability", /适用|適用|处理|處理|処理|resolve|applicable/iu],
  ["return", /回到|返回|回去|放回|弹回|彈回|戻|return/iu],
  ["hand", /手卡|手牌|手札|hand/iu],
  ["deck", /卡组|牌组|牌組|デッキ|deck/iu],
  ["spell_trap", /魔法|陷阱|罠|spell|trap/iu],
  ["field", /场上|場上|フィールド|field/iu],
  ["destroy", /破坏|破壊|destroy/iu],
  ["negate", /无效|無效|negate/iu],
  ["banish", /除外|banish/iu],
  ["graveyard", /墓地|graveyard|GY/iu],
  ["summon", /召唤|召喚|summon/iu],
  ["cost", /cost|代价|代價|支付|舍弃|丢弃|捨て/iu],
  ["timing", /时点|時点|时机|タイミング|timing/iu],
  ["attack", /攻击|攻擊|攻撃|attack/iu],
  ["unaffected", /不受.{0,8}影响|不受.{0,8}影響|受けない|unaffected/iu],
]);
const PRIORITY_SCENARIO_ABSENCE_PATTERN = /(?:没有其他|不存在其他|并无其他|无其他|除.{0,12}以外没有|只有.{0,24}(?:1|一)张|only.{0,24}(?:one|1)|no other|none(?:\s+(?:available|applicable))?)/iu;
const PRIORITY_ACTIVE_SPELL_TRAP_RETURN_PATTERN = /(?:发动|發動|発動|连锁|連鎖|チェーン|chain).{0,80}(?:魔法|陷阱|罠|spell|trap).{0,80}(?:回到|返回|放回|弹回|彈回|戻|return)|(?:魔法|陷阱|罠|spell|trap).{0,80}(?:连锁|連鎖|チェーン|chain).{0,80}(?:回到|返回|放回|弹回|彈回|戻|return)/iu;
const PRIORITY_NO_APPLICABLE_CARD_PATTERN = /(?:(?:除(?:了)?自身以外|除.{0,20}以外|没有其他|不存在其他|并无其他|无其他|no other|none|ほか|他).{0,180}(?:适用|適用|返回|回到|放回|选择|選択|对象|対象|处理|處理|処理|カード|card).{0,100}(?:(?:不能|不可|不得|无法|不可以|cannot).{0,16}(?:发动|發動|発動|activate)|発動できません|cannot activate))|(?:(?:(?:不能|不可|不得|无法|不可以|cannot).{0,16}(?:发动|發動|発動|activate)|発動できません|cannot activate).{0,100}(?:除自身以外|没有其他|不存在其他|no other|ほか.{0,24}ない))/iu;
const PRIORITY_GENERIC_NO_APPLICABLE_CARD_PATTERN = /(?:(?:除(?:了)?自身以外|除.{0,20}以外).{0,40}(?:没有|不存在|并无|无).{0,20}(?:适用|適用|处理|處理|选择|選択|返回|回到).{0,20}(?:卡|カード|card).{0,24}(?:不能|不可|不得|无法|不可以|発動できません|cannot).{0,12}(?:发动|發動|発動|activate)?|(?:no other|none).{0,40}(?:applicable|eligible).{0,24}(?:card).{0,24}(?:cannot|can't|may not).{0,12}activate)/iu;
const PRIORITY_TARGET_RESTRICTION_PATTERN = /(?:不能|不可|不得|无法|不可以|cannot|can't|対象にできません).{0,28}(?:作为|成为|选为|選択|取为|取作|対象|target).{0,16}(?:对象|對象|対象|target)|(?:不能|不可|不得|无法|不可以|cannot|can't).{0,20}(?:取|选择|選択).{0,12}(?:对象|對象|対象|target)/iu;
const PRIORITY_SIMULTANEOUS_REPLACEMENT_PATTERN = /同\s*1?\s*时点.{0,24}双方.{0,30}(?:代替破坏|破坏.{0,12}代替).{0,60}回合玩家.{0,18}先适用.{0,100}非回合玩家.{0,60}(?:不在场上存在|已经不在场上).{0,30}不适用/su;
const memoryBudget = new Map();
const cardNameExtractionCache = new Map();
const ruleQueryExtractionCache = new Map();
const rulebookGroundingCache = new Map();

export async function callRagModel({
  prompt,
  recoveryPrompt,
  evidence = {},
  cardResolution = {},
  env = globalThis.process?.env || {},
  modelInvoker,
  dryRun,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  thinkingMode,
  reasoningEffort,
  signal,
} = {}) {
  const providerResolution = resolveRagProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForProvider(provider, env);
  const reasoningGeneration = provider === "deepseek" || provider === "glm"
    ? resolveReasoningGenerationConfig({ provider, modelName, thinkingMode, reasoningEffort, env })
    : provider === "relay"
      ? resolveRelayReasoningGenerationConfig({ reasoningEffort, env })
      : null;
  const maxTokens = resolveRagMaxOutputTokens(env, {
    provider,
    thinkingMode: reasoningGeneration?.thinkingMode,
  });
  const compactRecoveryMaxTokens = provider === "deepseek" && recoveryPrompt
    ? readPositiveNumber(
        env.RAG_RECOVERY_MAX_OUTPUT_TOKENS,
        DEFAULT_RAG_RECOVERY_MAX_OUTPUT_TOKENS,
      )
    : 0;
  const generationConfig = {
    requestModel: modelName,
    maxOutputTokens: maxTokens,
    ...(reasoningGeneration ? {
      thinkingMode: reasoningGeneration.thinkingMode,
      reasoningEffort: reasoningGeneration.reasoningEffort,
      thinkingModeSource: reasoningGeneration.thinkingModeSource,
      reasoningEffortSource: reasoningGeneration.reasoningEffortSource,
    } : {}),
  };
  const generationWarnings = reasoningGeneration?.warnings || [];
  const forcedDryRun = dryRun === true || isEnabled(env.RAG_DRY_RUN);
  const willCallRemote = !modelInvoker && !forcedDryRun && provider !== "mock" && hasProviderKey(provider, env) && typeof fetchImpl === "function";
  const budget = await buildBudgetPreflight({
    provider,
    stage: "final_ruling",
    // Compact recovery is a second paid request. Reserve both worst-case
    // outputs before the primary call so the retry cannot bypass the day cap.
    prompt: compactRecoveryMaxTokens > 0 ? `${prompt}\n${recoveryPrompt}` : prompt,
    maxTokens: maxTokens + compactRecoveryMaxTokens,
    env,
    fetchImpl,
    now,
    trackSpend: willCallRemote,
  });

  if (forcedDryRun) {
    return {
      answer: buildMockAnswer({ evidence, cardResolution }),
      rawText: "",
      provider: "mock",
      providerUsed: "mock",
      modelName: "mock-rag",
      modelUsed: "mock-rag",
      dryRun: true,
      warnings: [...providerResolution.warnings, ...generationWarnings, ...budget.warnings],
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: budget.status,
      generationConfig,
    };
  }

  if (modelInvoker) {
    const raw = await modelInvoker({
      prompt,
      provider,
      modelName,
      maxTokens,
      thinkingMode: reasoningGeneration?.thinkingMode,
      reasoningEffort: reasoningGeneration?.reasoningEffort,
      signal,
    });
    const parsed = parseModelResult(raw, {
      provider,
      modelName,
      dryRun: false,
      warnings: [...providerResolution.warnings, ...generationWarnings],
      budgetStatus: budget.status,
      generationConfig,
    });
    return {
      ...parsed,
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: budget.status,
      generationConfig,
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
      warnings: [...providerResolution.warnings, ...generationWarnings, "api_daily_budget_exceeded", ...budget.warnings],
      tokenUsage: {},
      estimatedCostCny: budget.status.estimatedThisCallCny,
      budgetStatus: budget.status,
      generationConfig,
    };
  }

  if (provider === "mock" || !hasProviderKey(provider, env) || typeof fetchImpl !== "function") {
    return {
      answer: buildMockAnswer({ evidence, cardResolution }),
      rawText: "",
      provider: "mock",
      providerUsed: "mock",
      modelName: "mock-rag",
      modelUsed: "mock-rag",
      dryRun: true,
      warnings: [...providerResolution.warnings, ...generationWarnings, ...budget.warnings],
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: budget.status,
      generationConfig,
    };
  }

  try {
    let retainFullReservation = false;
    let response = provider === "gemini"
      ? await callGemini({ prompt, env, modelName, maxTokens, fetchImpl, signal })
      : provider === "glm"
        ? await callGlm({
          prompt,
          env,
          modelName,
          maxTokens,
          fetchImpl,
          thinkingMode: reasoningGeneration.thinkingMode,
          reasoningEffort: reasoningGeneration.reasoningEffort,
          signal,
        })
        : provider === "relay"
          ? await callRelay({
            prompt,
            env,
            modelName,
            maxTokens,
            fetchImpl,
            reasoningEffort: reasoningGeneration.reasoningEffort,
            signal,
          })
        : await callDeepSeek({
          prompt,
          env,
          modelName,
          maxTokens,
          fetchImpl,
          thinkingMode: reasoningGeneration.thinkingMode,
          reasoningEffort: reasoningGeneration.reasoningEffort,
          requireJson: true,
          signal,
        });
    const compactRecoveryAssessment = provider === "deepseek"
      ? assessDeepSeekPrimaryForCompactRecovery(response)
      : { retry: false, warning: "" };
    if (compactRecoveryAssessment.warning) {
      response = {
        ...response,
        warnings: [...(response.warnings || []), compactRecoveryAssessment.warning],
      };
    }
    const responses = [response];
    if (provider === "deepseek" && compactRecoveryAssessment.retry && recoveryPrompt) {
      const recoveryMaxTokens = compactRecoveryMaxTokens;
      try {
        const recovery = await callDeepSeek({
          prompt: recoveryPrompt,
          env,
          modelName,
          maxTokens: recoveryMaxTokens,
          fetchImpl,
          temperature: 0,
          // Compact recovery prioritizes a strict structured result. Disable
          // thinking so DeepSeek can enforce JSON response mode on this pass.
          thinkingMode: "disabled",
          reasoningEffort: undefined,
          requireJson: true,
          signal,
        });
        responses.push(recovery);
        const recoveryAssessment = assessDeepSeekRecovery(recovery);
        response = recoveryAssessment.ok
          ? {
              ...recovery,
              warnings: [
                ...withoutRecoverableDeepSeekWarnings(responses[0].warnings || []),
                "deepseek_compact_recovery_attempted",
                "deepseek_compact_recovery_succeeded",
                ...(recovery.warnings || []),
              ],
            }
          : {
              ...responses[0],
              warnings: [
                ...(responses[0].warnings || []),
                "deepseek_compact_recovery_attempted",
                "deepseek_compact_recovery_failed",
                recoveryAssessment.warning,
                ...(recovery.warnings || []),
              ],
            };
      } catch (error) {
        // The primary response is already billable. A failed or aborted compact
        // recovery must not route through the outer reservation-refund path.
        retainFullReservation = !isBudgetReservationReleaseSafe(error);
        response = {
          ...responses[0],
          warnings: [
            ...(responses[0].warnings || []),
            "deepseek_compact_recovery_attempted",
            "deepseek_compact_recovery_failed",
            `deepseek_compact_recovery_call_failed:${safeErrorMessage(error)}`,
            ...(retainFullReservation
              ? ["budget_reservation_retained_after_ambiguous_remote_failure"]
              : []),
          ],
        };
      }
    }
    const tokenUsage = sumTokenUsage(responses.map((item) => normalizeUsage(provider, item.usage)));
    const reportedTokens = Number(tokenUsage.prompt_tokens || 0)
      + Number(tokenUsage.completion_tokens || 0)
      + Number(tokenUsage.total_tokens || 0);
    const measuredCost = estimateActualCostCny(provider, tokenUsage, env);
    const actualCost = retainFullReservation
      ? roundCost(budget.reservedAmountCny || Number(budget.status?.estimatedThisCallCny || 0))
      : reportedTokens > 0 || provider === "gemini"
        ? measuredCost
        : roundCost(budget.reservedAmountCny || Number(budget.status?.estimatedThisCallCny || 0));
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
      warnings: [
        ...providerResolution.warnings,
        ...generationWarnings,
        ...budget.warnings,
        ...spendWarnings,
        ...(response.warnings || []),
      ],
      budgetStatus,
    });
    return {
      ...parsed,
      tokenUsage,
      estimatedCostCny: actualCost,
      budgetStatus,
      generationAttempts: responses.map((item, index) => summarizeGenerationAttempt(item, index)),
      generationConfig,
    };
  } catch (error) {
    const warning = `model_call_failed:${error instanceof Error ? error.message : String(error)}`;
    const releaseSafe = isBudgetReservationReleaseSafe(error);
    const failedBudgetStatus = releaseSafe
      ? await releaseBudgetReservation({ preflight: budget, env, fetchImpl }).catch(() => budget.status)
      : budget.status;
    return {
      answer: safeFallbackAnswer("model_call_failed"),
      rawText: "",
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun: false,
      warnings: [
        ...providerResolution.warnings,
        ...generationWarnings,
        warning,
        ...(releaseSafe ? [] : ["budget_reservation_retained_after_ambiguous_remote_failure"]),
        ...budget.warnings,
      ],
      tokenUsage: {},
      estimatedCostCny: releaseSafe ? 0 : budget.reservedAmountCny,
      budgetStatus: failedBudgetStatus,
      generationConfig,
    };
  }
}

/**
 * Runs one server-side DeepSeek JSON task for non-authoritative evidence/draft
 * preparation. Callers on the public path must opt into public budget tracking;
 * final ruling authorization is enforced by the downstream proof gate or the
 * provider adapter.
 */
export async function callDeepSeekJsonTask({
  prompt,
  modelName,
  maxTokens = null,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  temperature = 0,
  thinkingMode = "disabled",
  reasoningEffort,
  signal,
  trackPublicBudget = false,
  allowResponseFormatFallback = true,
  now = new Date(),
} = {}) {
  const normalizedPrompt = String(prompt || "").trim();
  if (!normalizedPrompt) throw new TypeError("DeepSeek JSON task prompt must not be empty");
  if (!String(env.DEEPSEEK_API_KEY || "").trim()) {
    const error = new Error("DeepSeek is not configured");
    error.code = "deepseek_not_configured";
    throw error;
  }
  if (typeof fetchImpl !== "function") throw new TypeError("DeepSeek JSON task requires fetch");
  const resolvedMaxTokens = optionalPositiveInteger(maxTokens);
  const budget = trackPublicBudget === true
    ? await buildBudgetPreflight({
        provider: "deepseek",
        stage: "evidence_preparation",
        prompt: normalizedPrompt,
        maxTokens: resolvedMaxTokens || DEFAULT_JSON_TASK_MAX_OUTPUT_TOKENS,
        env,
        fetchImpl,
        now,
        trackSpend: true,
      })
    : null;
  if (budget?.blocked) {
    const error = new Error("public DeepSeek budget is exhausted");
    error.code = "api_daily_budget_exceeded";
    throw error;
  }

  try {
    const response = await callDeepSeek({
      prompt: normalizedPrompt,
      env,
      modelName: String(modelName || env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL).trim(),
      maxTokens: resolvedMaxTokens,
      fetchImpl,
      temperature: readNumber(temperature, 0),
      thinkingMode,
      reasoningEffort,
      requireJson: true,
      allowResponseFormatFallback: allowResponseFormatFallback === true,
      signal,
    });
    const usage = normalizeUsage("deepseek", response.usage);
    const estimatedCostCny = estimateActualCostCny("deepseek", usage, env);
    let budgetStatus = budget?.status || null;
    const budgetWarnings = [];
    if (budget) {
      try {
        budgetStatus = await recordBudgetSpend({ preflight: budget, actualCostCny: estimatedCostCny, env, fetchImpl });
      } catch (error) {
        budgetWarnings.push(`budget_spend_record_failed:${safeErrorMessage(error)}`);
        budgetStatus = { ...budget.status, budgetStorage: "unavailable" };
      }
    }
    let parsed;
    try {
      parsed = parseStrictJsonObject(response.rawText);
    } catch (error) {
      const contentFailureKind = classifyDeepSeekJsonTaskContentFailure(
        response.rawText,
        error,
      );
      if (contentFailureKind) {
        throw deepSeekJsonTaskContentError({
          contentFailureKind,
          response,
          usage,
        });
      }
      throw error;
    }
    return {
      ...parsed,
      rawText: response.rawText,
      usage,
      warnings: [...(response.warnings || []), ...(budget?.warnings || []), ...budgetWarnings],
      estimatedCostCny,
      budgetStatus,
    };
  } catch (error) {
    if (budget && isBudgetReservationReleaseSafe(error)) {
      await releaseBudgetReservation({ preflight: budget, env, fetchImpl }).catch(() => {});
    }
    throw error;
  }
}

export async function callCardNameExtractionModel({
  userQuery,
  env = globalThis.process?.env || {},
  modelInvoker,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  dryRun = false,
  signal,
} = {}) {
  const providerResolution = resolveCardExtractionProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForCardExtractionProvider(provider, env);
  const maxTokens = readNumber(env.RAG_CARD_MODEL_MAX_OUTPUT_TOKENS, 800);
  const prompt = buildCardNameExtractionPrompt(userQuery);

  if (dryRun === true || isEnabled(env.RAG_DRY_RUN)) {
    return emptyCardNameExtractionResult(provider, modelName, true, [
      ...providerResolution.warnings,
      "card_name_model_dry_run_skipped",
    ]);
  }

  if (modelInvoker) {
    try {
      const execution = await runBudgetedAuxiliaryModelCall({
        provider,
        prompt,
        maxTokens,
        env,
        fetchImpl,
        now,
        invoke: async () => {
          const raw = await modelInvoker({ prompt, provider, modelName, maxTokens, task: "card_name_extraction", signal });
          return { rawPayload: raw, rawText: String(raw || ""), usage: raw?.usage || {} };
        },
      });
      if (execution.blocked) {
        return {
          ...emptyCardNameExtractionResult(provider, modelName, true, [
            ...providerResolution.warnings,
            ...execution.warnings,
            "api_daily_budget_exceeded_card_name_model_skipped",
          ]),
          budgetStatus: execution.budgetStatus,
        };
      }
      const raw = execution.value.rawPayload;
      return {
        candidates: normalizeCardNameCandidates(raw),
        rawText: String(raw || ""),
        providerUsed: provider,
        modelUsed: modelName,
        dryRun: false,
        warnings: [...providerResolution.warnings, ...execution.warnings],
        tokenUsage: execution.usage,
        estimatedCostCny: execution.estimatedCostCny,
        budgetStatus: execution.budgetStatus,
      };
    } catch (error) {
      return {
        ...emptyCardNameExtractionResult(provider, modelName, false, [
          ...providerResolution.warnings,
          ...(error.budgetWarnings || []),
          `card_name_model_failed:${safeErrorMessage(error)}`,
        ]),
        budgetStatus: error.budgetStatus || null,
      };
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
    const execution = await runBudgetedAuxiliaryModelCall({
      provider,
      prompt,
      maxTokens,
      env,
      fetchImpl,
      now,
      invoke: () => withTimeout(
        provider === "gemini"
          ? callGemini({
            prompt,
            env,
            modelName,
            maxTokens,
            fetchImpl,
            temperature: readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0),
            maxTokensEnvName: "GEMINI_CARD_MODEL_MAX_OUTPUT_TOKENS",
            signal,
          })
          : callDeepSeek({
            prompt,
            env,
            modelName,
            maxTokens,
            fetchImpl,
            temperature: readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0),
            thinkingMode: "disabled",
            signal,
          }),
        timeoutMs,
        "card_name_model_timeout",
      ),
    });
    if (execution.blocked) {
      return {
        ...emptyCardNameExtractionResult(provider, modelName, true, [
          ...providerResolution.warnings,
          ...execution.warnings,
          "api_daily_budget_exceeded_card_name_model_skipped",
        ]),
        budgetStatus: execution.budgetStatus,
      };
    }
    const response = execution.value;
    const result = {
      candidates: normalizeCardNameCandidates(response.rawText),
      rawText: response.rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [...providerResolution.warnings, ...execution.warnings, ...(response.warnings || [])],
      tokenUsage: execution.usage,
      estimatedCostCny: execution.estimatedCostCny,
      budgetStatus: execution.budgetStatus,
    };
    writeCachedExtraction(cardNameExtractionCache, cacheKey, result, env);
    return result;
  } catch (error) {
    return {
      ...emptyCardNameExtractionResult(provider, modelName, false, [
        ...providerResolution.warnings,
        ...(error.budgetWarnings || []),
        `card_name_model_failed:${safeErrorMessage(error)}`,
      ]),
      budgetStatus: error.budgetStatus || null,
    };
  }
}

export async function callRuleQueryExtractionModel({
  userQuery,
  env = globalThis.process?.env || {},
  modelInvoker,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  dryRun = false,
  signal,
} = {}) {
  const providerResolution = resolveRuleQueryExtractionProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForRuleQueryExtractionProvider(provider, env);
  const maxTokens = readNumber(env.RAG_RULE_MODEL_MAX_OUTPUT_TOKENS, 700);
  const prompt = buildRuleQueryExtractionPrompt(userQuery);

  if (dryRun === true || isEnabled(env.RAG_DRY_RUN)) {
    return emptyRuleQueryExtractionResult(provider, modelName, true, [
      ...providerResolution.warnings,
      "rule_query_model_dry_run_skipped",
    ]);
  }

  if (modelInvoker) {
    try {
      const execution = await runBudgetedAuxiliaryModelCall({
        provider,
        prompt,
        maxTokens,
        env,
        fetchImpl,
        now,
        invoke: async () => {
          const raw = await modelInvoker({ prompt, provider, modelName, maxTokens, task: "rule_query_extraction", signal });
          return { rawPayload: raw, rawText: String(raw || ""), usage: raw?.usage || {} };
        },
      });
      if (execution.blocked) {
        return {
          ...emptyRuleQueryExtractionResult(provider, modelName, true, [
            ...providerResolution.warnings,
            ...execution.warnings,
            "api_daily_budget_exceeded_rule_query_model_skipped",
          ]),
          budgetStatus: execution.budgetStatus,
        };
      }
      const raw = execution.value.rawPayload;
      return {
        queries: normalizeRuleSearchQueries(raw),
        rawText: String(raw || ""),
        providerUsed: provider,
        modelUsed: modelName,
        dryRun: false,
        warnings: [...providerResolution.warnings, ...execution.warnings],
        tokenUsage: execution.usage,
        estimatedCostCny: execution.estimatedCostCny,
        budgetStatus: execution.budgetStatus,
      };
    } catch (error) {
      return {
        ...emptyRuleQueryExtractionResult(provider, modelName, false, [
          ...providerResolution.warnings,
          ...(error.budgetWarnings || []),
          `rule_query_model_failed:${safeErrorMessage(error)}`,
        ]),
        budgetStatus: error.budgetStatus || null,
      };
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
    const execution = await runBudgetedAuxiliaryModelCall({
      provider,
      prompt,
      maxTokens,
      env,
      fetchImpl,
      now,
      invoke: () => withTimeout(
        provider === "gemini"
          ? callGemini({
            prompt,
            env,
            modelName,
            maxTokens,
            fetchImpl,
            temperature: readNumber(env.RAG_RULE_MODEL_TEMPERATURE, readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0)),
            maxTokensEnvName: "GEMINI_RULE_MODEL_MAX_OUTPUT_TOKENS",
            signal,
          })
          : callDeepSeek({
            prompt,
            env,
            modelName,
            maxTokens,
            fetchImpl,
            temperature: readNumber(env.RAG_RULE_MODEL_TEMPERATURE, readNumber(env.RAG_CARD_MODEL_TEMPERATURE, 0)),
            thinkingMode: "disabled",
            signal,
          }),
        timeoutMs,
        "rule_query_model_timeout",
      ),
    });
    if (execution.blocked) {
      return {
        ...emptyRuleQueryExtractionResult(provider, modelName, true, [
          ...providerResolution.warnings,
          ...execution.warnings,
          "api_daily_budget_exceeded_rule_query_model_skipped",
        ]),
        budgetStatus: execution.budgetStatus,
      };
    }
    const response = execution.value;
    const result = {
      queries: normalizeRuleSearchQueries(response.rawText),
      rawText: response.rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [...providerResolution.warnings, ...execution.warnings, ...(response.warnings || [])],
      tokenUsage: execution.usage,
      estimatedCostCny: execution.estimatedCostCny,
      budgetStatus: execution.budgetStatus,
    };
    writeCachedExtraction(ruleQueryExtractionCache, cacheKey, result, env);
    return result;
  } catch (error) {
    return {
      ...emptyRuleQueryExtractionResult(provider, modelName, false, [
        ...providerResolution.warnings,
        ...(error.budgetWarnings || []),
        `rule_query_model_failed:${safeErrorMessage(error)}`,
      ]),
      budgetStatus: error.budgetStatus || null,
    };
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
  dryRun = false,
  signal,
} = {}) {
  const maxRulebookCandidates = readPositiveNumber(env.RAG_MAX_RULEBOOK_CANDIDATES, 24);
  const maxQaCandidates = readPositiveNumber(env.RAG_MAX_QA_GROUNDING_CANDIDATES, 12);
  const maxCardTextCandidates = readPositiveNumber(env.RAG_MAX_CARDS, 6);
  const maxPriorityConstraints = readPositiveNumber(env.RAG_MAX_PRIORITY_CONSTRAINTS, 5);
  const maxFocusedCandidates = readPositiveNumber(env.RAG_MAX_FOCUSED_GROUNDING_CANDIDATES, 28);
  const selectedQaEvidence = selectGroundingQaEvidence(qaEvidence, maxQaCandidates);
  const selectedRuleEvidence = dedupeGroundingEvidence(ruleEvidence).slice(0, maxRulebookCandidates);
  const selectedCardTexts = dedupeGroundingEvidence(cardTexts).slice(0, maxCardTextCandidates);
  const priorityConstraintEvidence = selectPriorityConstraintEvidence({
    items: selectedRuleEvidence,
    userQuery,
    cardTexts: selectedCardTexts,
    limit: maxPriorityConstraints,
  });
  const candidates = selectGroundingCandidates({
    priorityConstraintEvidence,
    selectedQaEvidence,
    selectedCardTexts,
    selectedRuleEvidence,
    maxCandidates: priorityConstraintEvidence.length
      ? maxFocusedCandidates
      : maxRulebookCandidates + maxQaCandidates + maxCardTextCandidates,
  });
  if (!candidates.length) {
    return emptyRulebookGroundingResult("none", "none", true, ["grounding_evidence_candidates_missing"]);
  }

  const providerResolution = resolveRulebookGroundingProvider(env);
  const provider = providerResolution.provider;
  const modelName = modelNameForRulebookGroundingProvider(provider, env);
  const maxTokens = readNumber(env.RAG_RULEBOOK_MODEL_MAX_OUTPUT_TOKENS, 2800);
  const prompt = buildRulebookGroundingPrompt({
    userQuery,
    cardTexts: selectedCardTexts,
    evidenceCandidates: candidates,
    priorityConstraintEvidence,
  });
  const repairMaxTokens = Math.min(
    maxTokens,
    readPositiveNumber(env.RAG_RULEBOOK_REPAIR_MAX_OUTPUT_TOKENS, 2200),
  );
  const focusedStateTransitionReview = !priorityConstraintEvidence.length
    && shouldRunFocusedStateTransitionReview({
      userQuery,
      cardTexts: selectedCardTexts,
      evidenceCandidates: candidates,
    });
  const repairPrompt = priorityConstraintEvidence.length
    ? buildFocusedConstraintRepairPrompt({
      userQuery,
      cardTexts: selectedCardTexts,
      priorityConstraintEvidence,
    })
    : focusedStateTransitionReview
      ? buildFocusedStateTransitionRepairPrompt({
        userQuery,
        cardTexts: selectedCardTexts,
        evidenceCandidates: candidates,
      })
      : "";
  const focusedTaskName = priorityConstraintEvidence.length
    ? "rulebook_constraint_repair"
    : "rulebook_state_transition_repair";

  const focusedReviewEnabled = Boolean(repairPrompt) && !isDisabled(env.RAG_RULEBOOK_FOCUSED_REPAIR_ENABLED);
  if (dryRun === true || isEnabled(env.RAG_DRY_RUN)) {
    return emptyRulebookGroundingResult(
      provider,
      modelName,
      true,
      [...providerResolution.warnings, "rulebook_grounding_dry_run_skipped"],
      priorityConstraintEvidence,
    );
  }
  if (modelInvoker) {
    const primaryTask = Promise.resolve().then(() => modelInvoker({
      prompt,
      provider,
      modelName,
      maxTokens,
      task: "rulebook_grounding",
      signal,
    }));
    const focusedTask = focusedReviewEnabled
      ? Promise.resolve().then(() => modelInvoker({
        prompt: repairPrompt,
        provider,
        modelName,
        maxTokens: repairMaxTokens,
        task: focusedTaskName,
        signal,
      }))
      : null;
    const [primaryOutcome, focusedOutcome] = await Promise.allSettled([
      primaryTask,
      ...(focusedTask ? [focusedTask] : []),
    ]);
    const combined = combineRulebookGroundingOutcomes({
      primaryOutcome,
      focusedOutcome: focusedTask ? focusedOutcome : null,
      candidates,
      priorityConstraintEvidence,
      userQuery,
      cardTexts: selectedCardTexts,
    });
    if (!combined.operationLegality) {
      return emptyRulebookGroundingResult(provider, modelName, false, [
        ...providerResolution.warnings,
        ...combined.warnings,
      ], priorityConstraintEvidence);
    }
    return {
      operationLegality: combined.operationLegality,
      rawText: combined.rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [
        ...providerResolution.warnings,
        ...combined.warnings,
        ...(combined.operationLegality.warnings || []),
      ],
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: null,
    };
  }
  if (provider === "mock" || !hasProviderKey(provider, env) || typeof fetchImpl !== "function") {
    return emptyRulebookGroundingResult(
      "mock",
      "mock-rulebook-grounding",
      true,
      providerResolution.warnings,
      priorityConstraintEvidence,
    );
  }

  const cacheInput = `${userQuery}\n${candidates.map((item) => item.id).join("|")}\n${(cardTexts || []).map((item) => item.id || item.title || "").join("|")}`;
  const cacheKey = extractionCacheKey("rulebook-grounding-v9", provider, modelName, cacheInput);
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
    stage: "evidence_preparation",
    prompt: repairPrompt ? prompt + "\n" + repairPrompt : prompt,
    maxTokens: maxTokens + (repairPrompt ? repairMaxTokens : 0),
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

  let remoteCallCompleted = false;
  let allFailedCallsWereReleaseSafe = false;
  let budgetStatus = budget.status;
  let tokenUsage = {};
  let actualCost = 0;
  const spendWarnings = [];
  try {
    const timeoutMs = readPositiveNumber(env.RAG_RULEBOOK_MODEL_TIMEOUT_MS, 10000);
    const invokeGrounding = (modelPrompt, outputTokens) => provider === "gemini"
      ? callGemini({
        prompt: modelPrompt,
        env,
        modelName,
        maxTokens: outputTokens,
        fetchImpl,
        temperature: 0,
        maxTokensEnvName: "GEMINI_RULEBOOK_MODEL_MAX_OUTPUT_TOKENS",
        signal,
      })
      : callDeepSeek({
        prompt: modelPrompt,
        env,
        modelName,
        maxTokens: outputTokens,
        fetchImpl,
        temperature: 0,
        thinkingMode: "disabled",
        signal,
      });
    const primaryTask = withTimeout(
      invokeGrounding(prompt, maxTokens),
      timeoutMs,
      "rulebook_grounding_model_timeout",
    );
    const repairTimeoutMs = readPositiveNumber(env.RAG_RULEBOOK_REPAIR_TIMEOUT_MS, 10000);
    const focusedTask = focusedReviewEnabled
      ? withTimeout(
        invokeGrounding(repairPrompt, repairMaxTokens),
        repairTimeoutMs,
        "rulebook_grounding_focused_repair_timeout",
      )
      : null;
    const [primaryOutcome, focusedOutcome] = await Promise.allSettled([
      primaryTask,
      ...(focusedTask ? [focusedTask] : []),
    ]);
    const responses = [primaryOutcome, focusedOutcome]
      .filter((outcome) => outcome?.status === "fulfilled")
      .map((outcome) => outcome.value);
    remoteCallCompleted = responses.length > 0;
    const attemptedOutcomes = [primaryOutcome, focusedOutcome].filter(Boolean);
    allFailedCallsWereReleaseSafe = !remoteCallCompleted
      && attemptedOutcomes.length > 0
      && attemptedOutcomes.every((outcome) => (
        outcome.status === "rejected"
        && isBudgetReservationReleaseSafe(outcome.reason)
      ));
    tokenUsage = sumTokenUsage(responses.map((item) => normalizeUsage(provider, item.usage)));
    const reportedTokens = Number(tokenUsage.prompt_tokens || 0)
      + Number(tokenUsage.completion_tokens || 0)
      + Number(tokenUsage.total_tokens || 0);
    const measuredCost = estimateActualCostCny(provider, tokenUsage, env);
    actualCost = reportedTokens > 0 || provider === "gemini"
      ? measuredCost
      : roundCost(budget.reservedAmountCny || Number(budget.status?.estimatedThisCallCny || 0));
    if (remoteCallCompleted) {
      try {
        budgetStatus = await recordBudgetSpend({ preflight: budget, actualCostCny: actualCost, env, fetchImpl });
      } catch (error) {
        spendWarnings.push("budget_spend_record_failed:" + safeErrorMessage(error));
        budgetStatus = { ...budget.status, budgetStorage: "unavailable" };
      }
    }
    const combined = combineRulebookGroundingOutcomes({
      primaryOutcome,
      focusedOutcome: focusedTask ? focusedOutcome : null,
      candidates,
      priorityConstraintEvidence,
      userQuery,
      cardTexts: selectedCardTexts,
      readRaw: (response) => response?.rawText,
    });
    if (!combined.operationLegality) {
      const message = combined.warnings.join(";") || "rulebook_grounding_model_failed";
      throw new Error(message);
    }
    const rawText = combined.rawText;
    const operationLegality = combined.operationLegality;
    const result = {
      operationLegality,
      rawText,
      providerUsed: provider,
      modelUsed: modelName,
      dryRun: false,
      warnings: [
        ...providerResolution.warnings,
        ...budget.warnings,
        ...spendWarnings,
        ...combined.warnings,
        ...responses.flatMap((item) => item.warnings || []),
        ...(operationLegality.warnings || []),
      ],
      tokenUsage,
      estimatedCostCny: actualCost,
      budgetStatus,
    };
    if (operationLegality.hasGroundedChecks && !operationLegality.hasUnresolvedConstraints) {
      writeCachedExtraction(rulebookGroundingCache, cacheKey, result, env);
    } else {
      result.warnings = [...new Set([...result.warnings, "rulebook_grounding_unresolved_not_cached"])];
    }
    return result;
  } catch (error) {
    const failedBudgetStatus = allFailedCallsWereReleaseSafe
      ? await releaseBudgetReservation({ preflight: budget, env, fetchImpl }).catch(() => budget.status)
      : budgetStatus;
    return {
      ...emptyRulebookGroundingResult(provider, modelName, false, [
        ...providerResolution.warnings,
        ...budget.warnings,
        ...spendWarnings,
        ...(!remoteCallCompleted && !allFailedCallsWereReleaseSafe
          ? ["budget_reservation_retained_after_ambiguous_remote_failure"]
          : []),
        `rulebook_grounding_model_failed:${safeErrorMessage(error)}`,
      ], priorityConstraintEvidence),
      tokenUsage,
      estimatedCostCny: actualCost,
      budgetStatus: failedBudgetStatus,
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
  if (requested === "glm") {
    if (!env.GLM_API_KEY) warnings.push("glm_api_key_missing_using_mock");
    return { provider: env.GLM_API_KEY ? "glm" : "mock", requested, warnings };
  }
  if (requested === "relay") {
    const configured = Boolean(String(env.RELAY_API_KEY || "").trim());
    if (!configured) warnings.push("relay_api_key_missing_using_mock");
    return { provider: configured ? "relay" : "mock", requested, warnings };
  }
  if (requested === "gemini") {
    if (!env.GEMINI_API_KEY) warnings.push("gemini_api_key_missing_using_mock");
    return { provider: env.GEMINI_API_KEY ? "gemini" : "mock", requested, warnings };
  }
  if (requested !== "auto") warnings.push(`unsupported_model_provider:${requested}`);
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", requested, warnings };
  if (env.GLM_API_KEY) return { provider: "glm", requested, warnings };
  if (env.GEMINI_API_KEY) return { provider: "gemini", requested, warnings };
  warnings.push("no_model_api_key_using_mock");
  return { provider: "mock", requested, warnings };
}

/**
 * Builds the only environment that public answer entry points may pass into
 * model-aware code.
 *
 * OpenAI is reserved for the authenticated admin model lab. Public legacy and
 * fast-judge code predate that boundary and also read MODEL_PROVIDER, so merely
 * ignoring provider fields from the HTTP body is insufficient: adding the
 * server-side admin OpenAI key could otherwise enable anonymous paid calls.
 *
 * The explicit mock mode is retained for offline tests. Every other public
 * configuration is resolved from the server-owned public profile allowlist;
 * evidence preparation remains pinned to DeepSeek Flash while the selected
 * allowlisted provider performs the final ruling.
 */
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
  const mockRequested = [
    source.RAG_MODEL_PROVIDER,
    source.MODEL_PROVIDER,
  ].some((value) => String(value || "").trim().toLowerCase() === "mock");
  const provider = mockRequested ? "mock" : profile.provider;
  result.MODEL_PROVIDER = provider;
  result.RAG_MODEL_PROVIDER = provider;
  result.RAG_MODEL = profile.model;
  result.RAG_THINKING_MODE = profile.thinkingMode;
  result.RAG_REASONING_EFFORT = profile.reasoningEffort;
  result.PUBLIC_RULING_MODEL_PROFILE = profile.id;
  // The tier flag is consumed by DeepSeek evidence-preparation pricing; every
  // public DeepSeek stage is Flash.
  result.RAG_MODEL_TIER = "flash";
  result.RAG_CARD_MODEL_PROVIDER = mockRequested ? "mock" : "deepseek";
  result.RAG_RULE_MODEL_PROVIDER = mockRequested ? "mock" : "deepseek";
  result.RAG_RULEBOOK_MODEL_PROVIDER = mockRequested ? "mock" : "deepseek";
  result.DEEPSEEK_CARD_MODEL = String(source.DEEPSEEK_CARD_MODEL || "deepseek-v4-flash");
  result.DEEPSEEK_RULE_MODEL = String(source.DEEPSEEK_RULE_MODEL || result.DEEPSEEK_CARD_MODEL);
  result.DEEPSEEK_RULEBOOK_MODEL = String(source.DEEPSEEK_RULEBOOK_MODEL || result.DEEPSEEK_RULE_MODEL);
  return result;
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
    return {
      ...budgetStatusPayload({ config, storage, dayKey, spent: null, estimated: 0, blocked: false }),
      currency: "CNY",
      buckets: PUBLIC_BUDGET_BUCKETS.map((bucket) => budgetBucketStatusPayload({
        bucket,
        bucketConfig: budgetBucketConfig(env, bucket),
        spent: null,
      })),
    };
  }
  const [spent, ...bucketSpent] = await Promise.all([
    readBudgetSpent({ storage, dayKey, env, fetchImpl }),
    ...PUBLIC_BUDGET_BUCKETS.map((bucket) => readBudgetSpent({
      storage,
      dayKey: budgetBucketDayKey(config.timezone, now, bucket.id),
      env,
      fetchImpl,
    })),
  ]);
  return {
    ...budgetStatusPayload({ config, storage, dayKey, spent, estimated: 0, blocked: false }),
    currency: "CNY",
    buckets: PUBLIC_BUDGET_BUCKETS.map((bucket, index) => budgetBucketStatusPayload({
      bucket,
      bucketConfig: budgetBucketConfig(env, bucket),
      spent: bucketSpent[index],
    })),
  };
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
    return getRagBudgetStatus({ env, fetchImpl, now });
  }
  await Promise.all([
    setBudgetSpent({ storage, dayKey, value: 0, env, fetchImpl }),
    ...PUBLIC_BUDGET_BUCKETS.map((bucket) => setBudgetSpent({
      storage,
      dayKey: budgetBucketDayKey(config.timezone, now, bucket.id),
      value: 0,
      env,
      fetchImpl,
    })),
  ]);
  return getRagBudgetStatus({ env, fetchImpl, now });
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

async function callDeepSeek({
  prompt,
  env,
  modelName,
  maxTokens,
  fetchImpl,
  temperature,
  thinkingMode,
  reasoningEffort,
  requireJson = true,
  allowResponseFormatFallback = false,
  signal,
}) {
  const endpoint = deepSeekChatCompletionsUrl(env.DEEPSEEK_BASE_URL);
  const jsonResponseModeEnabled = requireJson && thinkingMode !== "enabled";
  const body = {
    model: modelName || DEFAULT_DEEPSEEK_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    ...(jsonResponseModeEnabled ? { response_format: { type: "json_object" } } : {}),
  };
  if (DEEPSEEK_THINKING_MODES.has(thinkingMode)) {
    body.thinking = { type: thinkingMode };
  }
  if (thinkingMode === "enabled") {
    if (DEEPSEEK_REASONING_EFFORTS.has(reasoningEffort)) body.reasoning_effort = reasoningEffort;
  } else {
    body.temperature = temperature ?? readNumber(env.RAG_MODEL_TEMPERATURE, 0);
  }
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  let response = await postJson(fetchImpl, endpoint, {
    authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    "content-type": "application/json",
  }, body, { signal });
  const warnings = [];
  if (allowResponseFormatFallback && jsonResponseModeEnabled && !response.ok && response.status === 400) {
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    response = await postJson(fetchImpl, endpoint, {
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    }, fallbackBody, { signal });
    warnings.push("deepseek_response_format_fallback");
  }
  assertProviderHttpResponse(response, "deepseek");
  const payload = await response.json();
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const rawText = extractChatMessageText(message.content);
  const finishReason = String(choice.finish_reason || "");
  const reasoningContent = extractChatMessageText(message.reasoning_content);
  if (!rawText) warnings.push(`deepseek_empty_content:${finishReason || "unknown"}`);
  if (finishReason === "length") warnings.push("deepseek_output_truncated_by_token_limit");
  return {
    rawText,
    finishReason,
    contentChars: rawText.length,
    reasoningContentPresent: Boolean(reasoningContent),
    reasoningContentChars: reasoningContent.length,
    requestModel: String(body.model || ""),
    responseModel: String(payload?.model || ""),
    requestId: String(payload?.id || ""),
    systemFingerprint: String(payload?.system_fingerprint || ""),
    thinkingMode: DEEPSEEK_THINKING_MODES.has(thinkingMode) ? thinkingMode : "provider_default",
    reasoningEffort: thinkingMode === "enabled" && DEEPSEEK_REASONING_EFFORTS.has(reasoningEffort)
      ? reasoningEffort
      : null,
    maxOutputTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : null,
    responseFormat: jsonResponseModeEnabled ? "json_object" : "text",
    usage: payload?.usage || {},
    warnings,
  };
}

export function estimateGlmCostCny(usage = {}, env = {}) {
  const inputPrice = readNumber(env.GLM_INPUT_CNY_PER_MTOK, 8);
  const outputPrice = readNumber(env.GLM_OUTPUT_CNY_PER_MTOK, 28);
  const cacheHitPrice = readNumber(env.GLM_CACHE_HIT_INPUT_CNY_PER_MTOK, 2);
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const cacheHit = Number(usage.prompt_cache_hit_tokens || 0);
  const uncachedInput = Math.max(0, promptTokens - cacheHit);
  return roundCost(
    mtok(cacheHit) * cacheHitPrice
    + mtok(uncachedInput) * inputPrice
    + mtok(completionTokens) * outputPrice,
  );
}

async function callGlm({
  prompt,
  env,
  modelName,
  maxTokens,
  fetchImpl,
  thinkingMode,
  reasoningEffort,
  signal,
}) {
  const endpoint = compatibleChatCompletionsUrl(env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL);
  const body = {
    model: modelName || DEFAULT_GLM_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    response_format: { type: "json_object" },
    thinking: { type: thinkingMode === "disabled" ? "disabled" : "enabled" },
  };
  if (thinkingMode !== "disabled" && DEEPSEEK_REASONING_EFFORTS.has(reasoningEffort)) {
    body.reasoning_effort = reasoningEffort;
  }
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  const response = await postJson(fetchImpl, endpoint, {
    authorization: `Bearer ${env.GLM_API_KEY}`,
    "content-type": "application/json",
  }, body, { signal });
  assertProviderHttpResponse(response, "glm");
  const payload = await response.json();
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const rawText = extractChatMessageText(message.content);
  const finishReason = String(choice.finish_reason || "");
  const reasoningContent = extractChatMessageText(message.reasoning_content);
  const warnings = [];
  if (!rawText) warnings.push(`glm_empty_content:${finishReason || "unknown"}`);
  if (finishReason === "length") warnings.push("glm_output_truncated_by_token_limit");
  return {
    rawText,
    finishReason,
    contentChars: rawText.length,
    reasoningContentPresent: Boolean(reasoningContent),
    reasoningContentChars: reasoningContent.length,
    requestModel: String(body.model || ""),
    responseModel: String(payload?.model || ""),
    systemFingerprint: String(payload?.system_fingerprint || ""),
    thinkingMode: thinkingMode === "disabled" ? "disabled" : "enabled",
    reasoningEffort: thinkingMode === "disabled" ? null : reasoningEffort,
    maxOutputTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : null,
    usage: payload?.usage || {},
    warnings,
  };
}

/**
 * Third-party relay adapter for the public final-ruling stage.
 *
 * This intentionally does not reuse OpenAIResponsesProvider: relay capability
 * parity for background Responses, retrieval/cancellation and strict schemas is
 * unverified. One synchronous Chat Completions request is made, with no tools,
 * automatic retry or official-provider attribution.
 */
async function callRelay({
  prompt,
  env,
  modelName,
  maxTokens,
  fetchImpl,
  reasoningEffort,
  signal,
}) {
  const endpoint = relayChatCompletionsUrl(env.RELAY_BASE_URL || DEFAULT_PUBLIC_RELAY_BASE_URL);
  const body = {
    model: modelName || DEFAULT_PUBLIC_RELAY_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    response_format: { type: "json_object" },
  };
  if (RELAY_REASONING_EFFORTS.has(reasoningEffort)) {
    body.reasoning_effort = reasoningEffort;
  }
  if (Number.isInteger(maxTokens) && maxTokens > 0) {
    body.max_completion_tokens = maxTokens;
  }

  const response = await postJson(fetchImpl, endpoint, {
    authorization: `Bearer ${String(env.RELAY_API_KEY || "").trim()}`,
    "content-type": "application/json",
  }, body, { signal });
  assertProviderHttpResponse(response, "relay");
  const payload = await response.json();
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const rawText = extractChatMessageText(message.content);
  const finishReason = String(choice.finish_reason || "");
  const responseModel = String(payload?.model || "");
  const warnings = [];
  if (!rawText) warnings.push(`relay_empty_content:${finishReason || "unknown"}`);
  if (finishReason === "length") warnings.push("relay_output_truncated_by_token_limit");
  if (responseModel && responseModel !== String(body.model)) {
    warnings.push("relay_response_model_mismatch");
  }
  return {
    rawText,
    finishReason,
    contentChars: rawText.length,
    reasoningContentPresent: false,
    reasoningContentChars: 0,
    requestModel: String(body.model || ""),
    responseModel,
    systemFingerprint: String(payload?.system_fingerprint || ""),
    thinkingMode: "not_applicable",
    reasoningEffort: RELAY_REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : null,
    maxOutputTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : null,
    responseFormat: "json_object",
    usage: payload?.usage || {},
    warnings,
  };
}

function assessDeepSeekPrimaryForCompactRecovery(response = {}) {
  if (!String(response.rawText || "").trim()) return { retry: true, warning: "" };
  if ((response.warnings || []).includes("deepseek_output_truncated_by_token_limit")) {
    return { retry: true, warning: "" };
  }
  // JSON Output guarantees syntax but can still return empty content or the
  // wrong application shape. Validate the completed response here
  // and recover through a smaller non-thinking JSON pass when necessary.
  let parsed;
  try {
    parsed = parseStrictJsonObject(response.rawText);
  } catch {
    return { retry: true, warning: "deepseek_primary_invalid_json" };
  }
  if (!hasBasicRagAnswerSchema(parsed)) {
    return { retry: true, warning: "deepseek_primary_invalid_schema" };
  }
  return { retry: false, warning: "" };
}

function withoutRecoverableDeepSeekWarnings(warnings = []) {
  return warnings.filter((warning) => !String(warning).startsWith("deepseek_empty_content:")
    && warning !== "deepseek_output_truncated_by_token_limit");
}

function assessDeepSeekRecovery(response = {}) {
  const rawText = String(response.rawText || "").trim();
  if (!rawText) {
    return { ok: false, warning: "deepseek_compact_recovery_empty" };
  }
  if (response.finishReason === "length"
      || (response.warnings || []).includes("deepseek_output_truncated_by_token_limit")) {
    return { ok: false, warning: "deepseek_compact_recovery_truncated" };
  }
  let parsed;
  try {
    parsed = parseStrictJsonObject(rawText);
  } catch {
    return { ok: false, warning: "deepseek_compact_recovery_invalid_json" };
  }
  if (!hasBasicRagAnswerSchema(parsed)) {
    return { ok: false, warning: "deepseek_compact_recovery_invalid_schema" };
  }
  return { ok: true, warning: "" };
}

function hasBasicRagAnswerSchema(value) {
  return normalizeRagJsonContractObject(value) !== null;
}

function summarizeGenerationAttempt(response = {}, index = 0) {
  return {
    attempt: index === 0 ? "primary" : "compact_recovery",
    requestModel: String(response.requestModel || ""),
    responseModel: String(response.responseModel || ""),
    systemFingerprint: String(response.systemFingerprint || ""),
    thinkingMode: String(response.thinkingMode || "not_applicable"),
    reasoningEffort: response.reasoningEffort ? String(response.reasoningEffort) : null,
    maxOutputTokens: Number.isFinite(Number(response.maxOutputTokens)) ? Number(response.maxOutputTokens) : null,
    responseFormat: String(response.responseFormat || "text"),
    finishReason: String(response.finishReason || ""),
    contentChars: Number(response.contentChars ?? String(response.rawText || "").length),
    reasoningContentPresent: response.reasoningContentPresent === true,
    reasoningContentChars: Number(response.reasoningContentChars || 0),
    usage: normalizeUsage("deepseek", response.usage),
  };
}

function extractChatMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractChatMessagePartText).filter(Boolean).join("\n");
  }
  return extractChatMessagePartText(content);
}

function extractChatMessagePartText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.text?.value === "string") return part.text.value;
  if (Array.isArray(part.content)) {
    return part.content.map(extractChatMessagePartText).filter(Boolean).join("\n");
  }
  return "";
}

async function callGemini({ prompt, env, modelName, maxTokens, fetchImpl, temperature, maxTokensEnvName = "GEMINI_MAX_OUTPUT_TOKENS", signal }) {
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
  const response = await postJson(fetchImpl, endpoint, { "content-type": "application/json" }, body, { signal });
  assertProviderHttpResponse(response, "gemini");
  const payload = await response.json();
  return {
    rawText: (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("\n"),
    usage: payload?.usageMetadata || {},
    warnings: [],
  };
}

async function postJson(fetchImpl, url, headers, body, { signal } = {}) {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw markBudgetReservationOutcome(cause, { mayExist: true });
  }
}

function assertProviderHttpResponse(response, provider) {
  if (response?.ok) return;
  const status = Number(response?.status);
  const releaseSafe = isProvablePreAcceptanceHttpRejection(status);
  const error = new Error(`${provider} ${Number.isInteger(status) ? status : "unknown"}`);
  error.status = Number.isInteger(status) ? status : null;
  throw markBudgetReservationOutcome(error, { mayExist: !releaseSafe });
}

function isProvablePreAcceptanceHttpRejection(status) {
  const value = Number(status);
  if (!Number.isInteger(value) || value < 400 || value >= 500) return false;
  // These statuses may be emitted by a gateway after the request was already
  // forwarded. Without provider idempotency they are not refund evidence.
  return !new Set([408, 409, 425, 429]).has(value);
}

function markBudgetReservationOutcome(value, { mayExist }) {
  const source = value instanceof Error ? value : new Error(String(value));
  try {
    source.budgetReservationMayExist = mayExist === true;
    source.budgetReservationReleaseSafe = mayExist !== true;
    return source;
  } catch {
    const wrapped = new Error(source.message, { cause: source });
    wrapped.name = source.name;
    wrapped.budgetReservationMayExist = mayExist === true;
    wrapped.budgetReservationReleaseSafe = mayExist !== true;
    return wrapped;
  }
}

function isBudgetReservationReleaseSafe(error) {
  return error?.budgetReservationReleaseSafe === true
    || error?.budgetReservationMayExist === false;
}

function parseModelResult(rawText, { provider, modelName, dryRun, warnings = [], budgetStatus = null }) {
  const strictContract = normalizeStrictRagJsonOutput(rawText);
  if (strictContract?.valid) {
    return {
      answer: strictContract.answer,
      // Public validation must inspect the deterministic contract object, not
      // reject a syntactically valid response merely because optional arrays
      // were omitted or reasoning was emitted as one string.
      rawText: strictContract.rawText,
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun,
      warnings: [
        ...warnings,
        ...(strictContract.normalized ? ["model_json_structure_normalized"] : []),
      ],
      budgetStatus,
    };
  }
  if (strictContract?.valid === false) {
    return {
      answer: safeFallbackAnswer("model_json_invalid_schema"),
      rawText: strictContract.rawText,
      provider,
      providerUsed: provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun,
      warnings: [...warnings, "model_json_invalid_schema"],
      budgetStatus,
    };
  }
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

function optionalPositiveInteger(value) {
  if (value === null || value === undefined || String(value).trim() === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError("maxTokens must be a positive integer when provided");
  }
  return number;
}

function parseStrictJsonObject(rawText) {
  const normalized = stripJsonCodeFence(String(rawText || "").trim());
  if (!normalized) throw new SyntaxError("DeepSeek JSON task returned empty content");
  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("DeepSeek JSON task must return a JSON object");
  }
  return parsed;
}

function classifyDeepSeekJsonTaskContentFailure(rawText, error) {
  const normalized = stripJsonCodeFence(String(rawText || "").trim());
  if (!normalized) return "empty";
  return error instanceof SyntaxError ? "invalid_json" : null;
}

function deepSeekJsonTaskContentError({ contentFailureKind, response, usage }) {
  const error = new Error(
    contentFailureKind === "empty"
      ? "DeepSeek JSON task returned empty content"
      : "DeepSeek JSON task returned invalid JSON",
  );
  error.name = "DeepSeekJsonTaskContentError";
  error.code = contentFailureKind === "empty"
    ? "deepseek_json_task_empty_content"
    : "deepseek_json_task_invalid_json";
  error.provider = "deepseek";
  error.status = 200;
  error.outcomeKnown = true;
  error.budgetReservationMayExist = true;
  error.budgetReservationReleaseSafe = false;
  error.confirmedContentFailure = true;
  error.contentFailureKind = contentFailureKind;
  error.usage = usage && typeof usage === "object" ? { ...usage } : null;
  error.model = String(response?.responseModel || response?.requestModel || "").trim() || null;
  error.requestId = String(response?.requestId || "").trim() || null;
  error.finishReason = String(response?.finishReason || "").trim() || null;
  return error;
}

function normalizeStrictRagJsonOutput(rawText) {
  let parsed;
  try {
    parsed = rawText && typeof rawText === "object" && !Array.isArray(rawText)
      ? rawText
      : parseStrictJsonObject(rawText);
  } catch {
    return null;
  }
  const answer = normalizeRagJsonContractObject(parsed);
  if (!answer) {
    // Preserve the existing conservative reasoning-missing wrapper for local
    // or injected callers, but never coerce an illegal verdict level or a
    // non-string conclusion into a valid semantic header.
    if (RAG_ANSWER_LEVELS.includes(parsed?.answerLevel)
        && typeof parsed?.shortAnswer === "string"
        && parsed.shortAnswer.trim()) {
      return null;
    }
    return {
      valid: false,
      rawText: typeof rawText === "string" ? rawText : JSON.stringify(parsed),
    };
  }
  return {
    valid: true,
    answer,
    rawText: JSON.stringify(answer),
    normalized: !jsonValuesEqual(parsed, answer),
  };
}

function normalizeRagJsonContractObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!RAG_ANSWER_LEVELS.includes(value.answerLevel)) return null;
  if (typeof value.shortAnswer !== "string" || !value.shortAnswer.trim()) return null;
  const reasoningSource = Array.isArray(value.reasoning)
    ? value.reasoning
    : typeof value.reasoning === "string"
      ? [value.reasoning]
      : [];
  const reasoning = reasoningSource
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!reasoning.length) return null;

  return {
    answerLevel: value.answerLevel,
    shortAnswer: value.shortAnswer.trim(),
    reasoning,
    usedCards: normalizeContractStringArray(value.usedCards),
    usedEvidence: normalizeContractUsedEvidence(value.usedEvidence),
    missingInfo: normalizeContractStringArray(value.missingInfo),
    riskFlags: normalizeContractStringArray(value.riskFlags),
    confidenceSelfEstimate: ["low", "medium", "high"].includes(value.confidenceSelfEstimate)
      ? value.confidenceSelfEstimate
      : "low",
  };
}

function normalizeContractStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeContractUsedEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      id: typeof item.id === "string" || typeof item.id === "number"
        ? String(item.id).trim()
        : "",
      type: typeof item.type === "string" && item.type.trim() ? item.type.trim() : "related",
      title: typeof item.title === "string" ? item.title.trim() : "",
    }))
    .filter((item) => item.id)
    .slice(0, 12);
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
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

async function buildBudgetPreflight({ provider, stage, prompt, maxTokens, env, fetchImpl, now, trackSpend = true }) {
  const config = budgetConfig(env);
  const bucket = resolveBudgetBucket(stage, provider, env);
  const bucketConfig = budgetBucketConfig(env, bucket);
  const dayKey = budgetDayKey(config.timezone, now);
  const bucketDayKey = budgetBucketDayKey(config.timezone, now, bucket.id);
  let storage = budgetStorage(env);
  const warnings = budgetStorageWarnings(storage);
  const estimated = estimatePreflightCostCny(provider, prompt, maxTokens, env);
  const emptyResult = ({ blocked, spent, bucketSpent }) => ({
    config,
    bucketConfig,
    bucket,
    storage,
    dayKey,
    bucketDayKey,
    blocked,
    reservedAmountCny: 0,
    bucketReservedAmountCny: 0,
    warnings,
    status: budgetStatusPayload({
      config,
      storage,
      dayKey,
      spent,
      estimated,
      blocked,
      bucket,
      bucketConfig,
      bucketSpent,
    }),
  });

  if (storage === "unconfigured") {
    // A deployment that requires persistent accounting cannot enforce a
    // process-wide limit in memory. Missing Redis is therefore fail-closed,
    // even when API_BUDGET_MODE was not explicitly set to hard.
    return emptyResult({ blocked: trackSpend, spent: null, bucketSpent: null });
  }
  if (!trackSpend) return emptyResult({ blocked: false, spent: 0, bucketSpent: 0 });

  let spent = 0;
  let bucketSpent = 0;
  let blocked = false;
  let reservedAmountCny = 0;
  let bucketReservedAmountCny = 0;
  try {
    [spent, bucketSpent] = await Promise.all([
      readBudgetSpent({ storage, dayKey, env, fetchImpl }),
      readBudgetSpent({ storage, dayKey: bucketDayKey, env, fetchImpl }),
    ]);
  } catch (error) {
    warnings.push(`budget_storage_unavailable:${safeErrorMessage(error)}`);
    if (storage === "redis" && (config.mode === "hard" || requiresPersistentBudget(env))) {
      blocked = true;
      storage = "unavailable";
    } else {
      storage = "memory";
      warnings.push("redis_budget_unavailable_using_memory_soft_limit");
      [spent, bucketSpent] = await Promise.all([
        readBudgetSpent({ storage, dayKey, env, fetchImpl }),
        readBudgetSpent({ storage, dayKey: bucketDayKey, env, fetchImpl }),
      ]);
    }
  }

  const totalLimitExceeded = config.dailyBudgetCny > 0 && spent + estimated > config.dailyBudgetCny;
  const bucketLimitExceeded = bucketConfig.dailyBudgetCny !== null
    && bucketConfig.dailyBudgetCny > 0
    && bucketSpent + estimated > bucketConfig.dailyBudgetCny;
  if (!blocked && (totalLimitExceeded || bucketLimitExceeded)) blocked = true;

  if (!blocked && estimated > 0) {
    spent = await addBudgetSpent({ storage, dayKey, amount: estimated, env, fetchImpl });
    reservedAmountCny = estimated;
    if (config.dailyBudgetCny > 0 && spent > config.dailyBudgetCny) {
      await addBudgetSpent({ storage, dayKey, amount: -estimated, env, fetchImpl }).catch(() => null);
      spent = await readBudgetSpent({ storage, dayKey, env, fetchImpl }).catch(() => spent);
      blocked = true;
      reservedAmountCny = 0;
    }
  }

  if (!blocked && estimated > 0) {
    try {
      bucketSpent = await addBudgetSpent({ storage, dayKey: bucketDayKey, amount: estimated, env, fetchImpl });
      bucketReservedAmountCny = estimated;
      if (bucketConfig.dailyBudgetCny !== null
          && bucketConfig.dailyBudgetCny > 0
          && bucketSpent > bucketConfig.dailyBudgetCny) {
        await addBudgetSpent({ storage, dayKey: bucketDayKey, amount: -estimated, env, fetchImpl }).catch(() => null);
        bucketSpent = await readBudgetSpent({ storage, dayKey: bucketDayKey, env, fetchImpl }).catch(() => bucketSpent);
        blocked = true;
      }
    } catch (error) {
      warnings.push(`budget_bucket_storage_unavailable:${safeErrorMessage(error)}`);
      blocked = config.mode === "hard" || requiresPersistentBudget(env);
    }
    if (blocked && reservedAmountCny) {
      await addBudgetSpent({ storage, dayKey, amount: -reservedAmountCny, env, fetchImpl }).catch(() => null);
      spent = await readBudgetSpent({ storage, dayKey, env, fetchImpl }).catch(() => spent);
      reservedAmountCny = 0;
      bucketReservedAmountCny = 0;
    }
  }

  return {
    config,
    bucketConfig,
    bucket,
    storage,
    dayKey,
    bucketDayKey,
    blocked,
    reservedAmountCny,
    bucketReservedAmountCny,
    warnings,
    status: budgetStatusPayload({
      config,
      storage,
      dayKey,
      spent,
      estimated,
      blocked,
      bucket,
      bucketConfig,
      bucketSpent,
    }),
  };
}

async function runBudgetedAuxiliaryModelCall({
  provider,
  prompt,
  maxTokens,
  env,
  fetchImpl,
  now,
  invoke,
}) {
  const budget = await buildBudgetPreflight({
    provider,
    stage: "evidence_preparation",
    prompt,
    maxTokens,
    env,
    fetchImpl,
    now,
    trackSpend: true,
  });
  if (budget.blocked) {
    return {
      blocked: true,
      value: null,
      usage: {},
      estimatedCostCny: 0,
      budgetStatus: budget.status,
      warnings: budget.warnings,
    };
  }

  try {
    const value = await invoke();
    const usage = normalizeUsage(provider, value?.usage || {});
    const reportedTokens = Number(usage.prompt_tokens || 0)
      + Number(usage.completion_tokens || 0)
      + Number(usage.total_tokens || 0);
    const measuredCost = estimateActualCostCny(provider, usage, env);
    // Some providers omit usage from otherwise successful responses. In that
    // case keep the preflight estimate instead of silently refunding a paid call.
    const estimatedCostCny = reportedTokens > 0 || provider === "gemini"
      ? measuredCost
      : roundCost(budget.reservedAmountCny || Number(budget.status?.estimatedThisCallCny || 0));
    let budgetStatus = budget.status;
    const warnings = [...budget.warnings];
    try {
      budgetStatus = await recordBudgetSpend({ preflight: budget, actualCostCny: estimatedCostCny, env, fetchImpl });
    } catch (error) {
      warnings.push(`budget_spend_record_failed:${safeErrorMessage(error)}`);
      budgetStatus = { ...budget.status, budgetStorage: "unavailable" };
    }
    return {
      blocked: false,
      value,
      usage,
      estimatedCostCny,
      budgetStatus,
      warnings,
    };
  } catch (caught) {
    const releaseSafe = isBudgetReservationReleaseSafe(caught);
    const error = markBudgetReservationOutcome(caught, { mayExist: !releaseSafe });
    error.budgetStatus = releaseSafe
      ? await releaseBudgetReservation({ preflight: budget, env, fetchImpl }).catch(() => budget.status)
      : budget.status;
    error.budgetWarnings = [
      ...budget.warnings,
      ...(releaseSafe ? [] : ["budget_reservation_retained_after_ambiguous_remote_failure"]),
    ];
    throw error;
  }
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
  const bucketDelta = preflight.bucketReservedAmountCny
    ? actualCostCny - preflight.bucketReservedAmountCny
    : actualCostCny;
  const bucketSpent = await addBudgetSpent({
    storage: preflight.storage,
    dayKey: preflight.bucketDayKey,
    amount: bucketDelta,
    env,
    fetchImpl,
  });
  return {
    ...preflight.status,
    spentTodayCny: roundCost(spent),
    estimatedThisCallCny: actualCostCny,
    limitEnforced: preflight.blocked,
    bucket: budgetBucketStatusPayload({
      bucket: preflight.bucket,
      bucketConfig: preflight.bucketConfig,
      spent: bucketSpent,
      estimated: actualCostCny,
      blocked: preflight.blocked,
    }),
  };
}

async function releaseBudgetReservation({ preflight, env, fetchImpl }) {
  if (!preflight.reservedAmountCny && !preflight.bucketReservedAmountCny) return preflight.status;
  const [spent, bucketSpent] = await Promise.all([
    preflight.reservedAmountCny
      ? addBudgetSpent({
        storage: preflight.storage,
        dayKey: preflight.dayKey,
        amount: -preflight.reservedAmountCny,
        env,
        fetchImpl,
      })
      : readBudgetSpent({ storage: preflight.storage, dayKey: preflight.dayKey, env, fetchImpl }),
    preflight.bucketReservedAmountCny
      ? addBudgetSpent({
        storage: preflight.storage,
        dayKey: preflight.bucketDayKey,
        amount: -preflight.bucketReservedAmountCny,
        env,
        fetchImpl,
      })
      : readBudgetSpent({ storage: preflight.storage, dayKey: preflight.bucketDayKey, env, fetchImpl }),
  ]);
  return {
    ...preflight.status,
    spentTodayCny: roundCost(spent),
    estimatedThisCallCny: 0,
    bucket: budgetBucketStatusPayload({
      bucket: preflight.bucket,
      bucketConfig: preflight.bucketConfig,
      spent: bucketSpent,
      estimated: 0,
      blocked: false,
    }),
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

function budgetStatusPayload({ config, storage, dayKey, spent, estimated, blocked, bucket = null, bucketConfig = null, bucketSpent = null }) {
  const status = {
    schemaVersion: 2,
    dailyBudgetCny: config.dailyBudgetCny,
    spentTodayCny: spent === null ? null : roundCost(spent),
    remainingTodayCny: spent === null || config.dailyBudgetCny <= 0
      ? null
      : roundCost(Math.max(0, config.dailyBudgetCny - spent)),
    estimatedThisCallCny: estimated,
    budgetMode: config.mode,
    budgetStorage: storage,
    budgetPersistent: storage === "redis",
    limitEnforced: blocked,
    dayKey,
    timezone: config.timezone,
  };
  if (bucket && bucketConfig) {
    status.bucket = budgetBucketStatusPayload({
      bucket,
      bucketConfig,
      spent: bucketSpent,
      estimated,
      blocked,
    });
  }
  if (storage === "unconfigured") {
    status.storageWarning = "后端未启用持久化预算存储；请配置 KV_REST_API_URL/KV_REST_API_TOKEN 或 UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN。";
  } else if (storage === "memory") {
    status.storageWarning = "当前使用进程内存统计；本地可用，serverless 部署刷新或冷启动后不会可靠保留。";
  }
  return status;
}

function budgetBucketStatusPayload({ bucket, bucketConfig, spent, estimated = 0, blocked = false }) {
  const limit = bucketConfig?.dailyBudgetCny ?? null;
  return {
    id: bucket.id,
    stage: bucket.stage,
    provider: bucket.provider,
    label: bucket.label,
    dailyBudgetCny: limit,
    spentTodayCny: spent === null ? null : roundCost(spent),
    remainingTodayCny: spent === null || limit === null || limit <= 0
      ? null
      : roundCost(Math.max(0, limit - spent)),
    estimatedThisCallCny: roundCost(estimated),
    limitEnforced: blocked,
  };
}

function estimatePreflightCostCny(provider, prompt, maxTokens, env) {
  const promptTokens = Math.ceil(String(prompt || "").length / 4);
  if (provider === "deepseek") {
    return estimateDeepSeekCostCny({ prompt_tokens: promptTokens, completion_tokens: maxTokens }, env);
  }
  if (provider === "glm") {
    return estimateGlmCostCny({ prompt_tokens: promptTokens, completion_tokens: maxTokens }, env);
  }
  if (provider === "relay") {
    return roundCost(readPositiveNumber(env.RELAY_ESTIMATED_CNY_PER_CALL, 10));
  }
  if (provider === "gemini") {
    return roundCost(readTieredProviderNumber(env, "GEMINI", "ESTIMATED_CNY_PER_CALL", 0.01));
  }
  return 0;
}

function estimateActualCostCny(provider, usage, env) {
  if (provider === "deepseek") return estimateDeepSeekCostCny(usage, env);
  if (provider === "glm") return estimateGlmCostCny(usage, env);
  if (provider === "relay") return roundCost(readPositiveNumber(env.RELAY_ESTIMATED_CNY_PER_CALL, 10));
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
    reasoning_tokens: Number(usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0),
    prompt_cache_hit_tokens: Number(usage.prompt_cache_hit_tokens || usage.prompt_tokens_details?.cached_tokens || 0),
    prompt_cache_miss_tokens: Number(usage.prompt_cache_miss_tokens || 0),
  };
}

function resolveBudgetBucket(stage, provider, env = {}) {
  const normalizedStage = String(stage || "").trim().toLowerCase();
  let normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "mock") {
    normalizedProvider = normalizedStage === "evidence_preparation"
      ? "deepseek"
      : String(env.PUBLIC_RULING_MODEL_PROFILE || "").startsWith("glm-")
        ? "glm"
        : String(env.PUBLIC_RULING_MODEL_PROFILE || "").startsWith("relay-")
          ? "relay"
        : "deepseek";
  }
  const id = `${normalizedStage}:${normalizedProvider}`;
  const bucket = PUBLIC_BUDGET_BUCKETS.find((item) => item.id === id);
  if (bucket) return bucket;
  if (normalizedProvider === "gemini") {
    return Object.freeze({ id: `internal:${normalizedStage}:gemini`, stage: normalizedStage, provider: "gemini", label: "Gemini 内部调用" });
  }
  throw new TypeError(`Unsupported public budget bucket: ${id}`);
}

function budgetBucketConfig(env, bucket) {
  if (String(bucket?.id || "").startsWith("internal:")) {
    return { envName: "", dailyBudgetCny: null };
  }
  const envName = bucket.id === "evidence_preparation:deepseek"
    ? "API_EVIDENCE_DAILY_BUDGET_CNY"
    : bucket.id === "final_ruling:glm"
      ? "API_GLM_FINAL_DAILY_BUDGET_CNY"
      : bucket.id === "final_ruling:relay"
        ? "API_RELAY_FINAL_DAILY_BUDGET_CNY"
        : "API_DEEPSEEK_FINAL_DAILY_BUDGET_CNY";
  const configured = String(env[envName] ?? "").trim();
  const parsed = configured === "" ? null : Number(configured);
  return {
    envName,
    dailyBudgetCny: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
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
  const priorityIds = new Set((priorityConstraintEvidence || []).map((item) => String(item?.id || "")));
  const payload = {
    userQuery: String(userQuery || ""),
    priorityConstraintCandidates: (priorityConstraintEvidence || []).slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      text: String(item.text || "").slice(0, 2800),
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
      text: String(item.text || "").slice(0, 3000),
    })),
    evidenceCandidates: (evidenceCandidates || []).filter((item) => !priorityIds.has(String(item?.id || ""))).slice(0, 32).map((item) => ({
      id: item.id,
      type: item.type || item.recordType || "related",
      title: item.title,
      text: String(item.text || "").slice(0, 2200),
      sourceUrl: item.sourceUrl || "",
      isDirect: item.isDirect === true,
    })),
  };
  return [
    "你是游戏王 OCG 证据判读器，不负责直接润色最终回答。",
    "先结合玩家问题与卡片文本，按实际发生顺序抽取每一步需要验证的操作，包括：发动条件、支付 cost、选择对象、连锁窗口、效果处理、位置变化、次数限制和后续处理。",
    "必须建立状态时间线：先判断能否发动，再立即支付 cost；cost 造成的送墓、除外、解放或其他位置变化在支付后立刻成立。进入连锁处理前，必须按支付后的场面重新判断永续效果、抗性及区域条件。不得把支付 cost 前的手牌状态沿用到效果处理时。",
    "cost 支付后新开始适用的抗性可能改变效果处理，但不能在没有规则或卡文依据时倒推成原本的发动不合法；发动合法性与处理时能否实际完成必须分别给出结论。",
    "priorityConstraintCandidates 是后端按题目操作与限制性措辞筛出的潜在阻断规则，已附规则原文。它们不代表必然适用，但每一条都必须先审查，不能跳过。",
    "对 priorityConstraintCandidates 中每个 id 都输出一个 constraintReviews 项：relevance 只能是 applies、not_applicable、uncertain；consequence 只能是 blocks、limits、none、uncertain。quote 必须逐字来自该 priorityConstraintCandidates 项的 text，application 必须比较题目事实与规则条件。",
    "如果限制规则适用且会阻止操作，constraintReviews 写 applies + blocks，并在 operationChecks 中把相应步骤判为 illegal。若判定不适用，必须明确说明规则条件与题目事实的差异，不能只写结论。",
    "若题目明确没有其他可适用卡，而必做处理不能适用于当前正在发动或处理中的卡，应把是否存在可完成的必做处理作为发动合法性的一步；限制规则命中时直接判 illegal，不能只核对一般诱发窗口。",
    "每个关键步骤先列清题目事实，再选择真正覆盖该步骤的候选证据。卡片文本可以证明该卡写明的发动条件、cost、对象和处理；通用规则结论必须由规则书或适用场景一致的 Q&A / FAQ 支持。",
    "每一步都要分别检查‘能否发动’‘能否选择为对象’‘效果是否适用’‘处理后状态’；这四类问题不能互相替代。",
    "区域条件必须逐字核对并严格区分手牌、场上、墓地、除外和额外牌组；在所检查步骤中某卡仍只在手牌时，不得把它视为在场上或墓地来满足持续条件、抗性或发动条件；若前一步 cost 已使其离开手牌，必须使用更新后的区域。",
    "‘不受其他卡的效果影响’只约束效果是否适用，本身不等于‘不能成为效果对象’；‘不能成为对象’必须有独立的对象限制或玩家限制证据，反过来也一样。",
    "同一场景同时存在对象保护与效果抗性时，要分别列出证据，并明确最终阻止操作的是哪一项；不得把抗性误写成不能取对象的理由。",
    "涉及‘将发动无效并破坏’时，必须依据候选证据区分被无效的是魔法・陷阱卡的卡的发动，还是已在场卡片的效果发动，并据此判断是否属于破坏场上的卡。",
    "多个不入连锁效果或代替处理在同一时点适用时，必须检索其适用顺序；每适用一个效果后都要更新场面，再判断后续效果是否仍能适用，不能假定双方效果同时成功。",
    "当发动条件要求“有「X」卡名记述”的卡时，只检查候选卡自身卡面／数据库 effect text 栏中的印刷文字。临时获得、复制或适用另一张卡的卡名与效果，不会改写该卡自身的印刷文本引用，不能因此满足该条件。",
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

function buildFocusedConstraintRepairPrompt({
  userQuery,
  cardTexts = [],
  priorityConstraintEvidence = [],
}) {
  const payload = {
    userQuery: String(userQuery || ""),
    cardTexts: (cardTexts || []).slice(0, 4).map((item) => ({
      id: item.id,
      title: item.title,
      cardType: item.cardType || "",
      attribute: item.attribute || "",
      text: String(item.text || "").slice(0, 1800),
    })),
    priorityConstraintCandidates: (priorityConstraintEvidence || []).slice(0, 5).map((item) => ({
      id: item.id,
      title: item.title,
      text: String(item.text || "").slice(0, 2200),
      sourceUrl: item.sourceUrl || "",
    })),
  };
  return [
    "你正在修复一次未完成的游戏王 OCG 限制规则核对。只处理本次输入中的 priorityConstraintCandidates，不要讨论无关规则。",
    "对每个 priorityConstraintCandidates 的 id 必须输出一个 constraintReviews 项，不能遗漏。",
    "逐项比较玩家明确给出的场面事实、卡片文本和限制规则。只说明诱发条件或可连锁时点的一般卡片 FAQ，不能覆盖更具体的限制规则。",
    "若规则适用并阻止某一步，写 relevance=applies、consequence=blocks；后端会据此生成阻断步骤。",
    "若规则条件与题目事实不一致，写 relevance=not_applicable、consequence=none，并明确差异。证据仍不足才允许 uncertain。",
    "每项 application 只写一个完整句子，说明题目事实如何满足或不满足规则条件；quote 从对应候选 text 复制最短的连续原文。",
    "operationChecks 固定输出空数组，避免重复主分析；输出单个 JSON 对象，只包含 constraintReviews、operationChecks、overallConclusion，枚举值必须使用英文。",
    "本次聚焦输入：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function shouldRunFocusedStateTransitionReview({
  userQuery,
  cardTexts = [],
} = {}) {
  const scenarioText = [
    String(userQuery || ""),
    ...(cardTexts || []).map((item) => [item.title, item.cardType, item.text].filter(Boolean).join("\n")),
  ].filter(Boolean).join("\n");
  const hasActivation = /(?:发动|發動|発動|activate)/iu.test(scenarioText);
  const hasCostMove = /(?:cost|代价|代價|支付|舍弃|丢弃|捨て|送去墓地|送墓|解放)/iu.test(scenarioText);
  const hasConditionalContinuousEffect = /(?:只要|存在.{0,24}(?:场上|墓地|除外)|不受.{0,12}效果影响|受けない|unaffected)/iu.test(scenarioText);
  const costStateTransition = hasActivation && hasCostMove && hasConditionalContinuousEffect;
  const simultaneousReplacement = compileRuleScenario({ userQuery, cardTexts }).simultaneousDestructionReplacement;
  return costStateTransition || simultaneousReplacement;
}

function buildFocusedStateTransitionRepairPrompt({
  userQuery,
  cardTexts = [],
  evidenceCandidates = [],
}) {
  const payload = {
    userQuery: String(userQuery || ""),
    cardTexts: (cardTexts || []).slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      cards: item.cards || [],
      cardType: item.cardType || "",
      attribute: item.attribute ?? "",
      text: String(item.text || "").slice(0, 3000),
    })),
    evidenceCandidates: (evidenceCandidates || []).slice(0, 20).map((item) => ({
      id: item.id,
      type: item.type || item.recordType || "related",
      title: item.title,
      text: String(item.text || "").slice(0, 2200),
      sourceUrl: item.sourceUrl || "",
    })),
  };
  return [
    "你正在聚焦复核一次游戏王 OCG 状态转换或多个不入连锁效果的适用顺序。不要泛泛重述卡文。",
    "按真实时间线分别生成 operationChecks：发动条件；立即支付 cost 后的位置变化；按新场面重新适用永续效果和抗性；效果处理的每一步与最终状态。",
    "支付 cost 后才开始适用的抗性可以阻止效果处理，但不能倒推成原本不能发动。必须分别回答‘能否发动并支付 cost’和‘处理时实际进行什么’。",
    "若同一时点有多个代替破坏或其他不入连锁效果，先依据证据决定适用顺序；每适用一个后更新场面，再判断后一个是否仍能适用。",
    "每个 legal、illegal 或 conditional 检查都必须引用本次输入中的证据 id，并逐字复制 quote。证据没有覆盖的步骤标记 unknown，不能凭记忆补规则。",
    "constraintReviews 固定输出空数组。输出单个 JSON 对象，只包含 constraintReviews、operationChecks、overallConclusion。overallConclusion 必须同时覆盖发动合法性和处理结果。",
    "本次状态转换输入：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}
function mergeRulebookGroundingOutputs(primaryRaw, repairRaw) {
  let primary = {};
  let repair = {};
  try {
    primary = parseRagModelJson(primaryRaw);
  } catch {
    primary = {};
  }
  try {
    repair = parseRagModelJson(repairRaw);
  } catch {
    return String(primaryRaw || "");
  }

  const constraintReviews = mergeGroundingItems(
    Array.isArray(primary.constraintReviews) ? primary.constraintReviews : [],
    Array.isArray(repair.constraintReviews) ? repair.constraintReviews : [],
    (item) => item?.evidenceId || item?.id,
  );
  const operationChecks = mergeGroundingItems(
    Array.isArray(primary.operationChecks) ? primary.operationChecks : Array.isArray(primary.operations) ? primary.operations : [],
    Array.isArray(repair.operationChecks) ? repair.operationChecks : Array.isArray(repair.operations) ? repair.operations : [],
    (item) => item?.operationId || item?.id,
  );
  return JSON.stringify({
    ...primary,
    ...repair,
    constraintReviews,
    operationChecks,
    overallConclusion: String(repair.overallConclusion || primary.overallConclusion || "").trim(),
  });
}

function combineRulebookGroundingOutcomes({
  primaryOutcome,
  focusedOutcome,
  candidates = [],
  priorityConstraintEvidence = [],
  userQuery = "",
  cardTexts = [],
  readRaw = (value) => value,
} = {}) {
  const warnings = [];
  let rawText = "";
  let operationLegality = null;

  if (primaryOutcome?.status === "fulfilled") {
    rawText = String(readRaw(primaryOutcome.value) || "");
    operationLegality = validateOperationLegalityModelOutput(rawText, candidates, {
      requiredConstraintEvidence: priorityConstraintEvidence,
      userQuery,
      cardTexts,
    });
  } else if (primaryOutcome?.status === "rejected") {
    warnings.push("rulebook_grounding_primary_failed:" + safeErrorMessage(primaryOutcome.reason));
  }

  if (focusedOutcome?.status === "fulfilled") {
    const focusedRaw = String(readRaw(focusedOutcome.value) || "");
    if (operationLegality) {
      const mergedRaw = mergeRulebookGroundingOutputs(rawText, focusedRaw);
      const repaired = validateOperationLegalityModelOutput(mergedRaw, candidates, {
        requiredConstraintEvidence: priorityConstraintEvidence,
        userQuery,
        cardTexts,
      });
      if (isBetterOperationLegality(repaired, operationLegality)) {
        rawText = mergedRaw;
        operationLegality = repaired;
        warnings.push("rulebook_grounding_focused_repair_applied");
      } else {
        warnings.push("rulebook_grounding_focused_repair_no_improvement");
      }
    } else {
      rawText = focusedRaw;
      operationLegality = validateOperationLegalityModelOutput(rawText, candidates, {
        requiredConstraintEvidence: priorityConstraintEvidence,
        userQuery,
        cardTexts,
      });
      warnings.push("rulebook_grounding_focused_fallback_applied");
    }
  } else if (focusedOutcome?.status === "rejected") {
    warnings.push("rulebook_grounding_focused_repair_failed:" + safeErrorMessage(focusedOutcome.reason));
  }

  return { rawText, operationLegality, warnings };
}
function mergeGroundingItems(primary = [], repair = [], getKey) {
  const result = [];
  const indexByKey = new Map();
  for (const item of [...primary, ...repair]) {
    const key = String(getKey(item) || "").normalize("NFKC").trim();
    if (!key) {
      result.push(item);
      continue;
    }
    if (indexByKey.has(key)) {
      result[indexByKey.get(key)] = item;
      continue;
    }
    indexByKey.set(key, result.length);
    result.push(item);
  }
  return result;
}


function isBetterOperationLegality(candidate, current) {
  return operationLegalityScore(candidate) > operationLegalityScore(current);
}

function operationLegalityScore(value = {}) {
  const unresolved = Array.isArray(value.unresolvedConstraintEvidence)
    ? value.unresolvedConstraintEvidence.length
    : 0;
  const groundedChecks = Array.isArray(value.checks)
    ? value.checks.filter((item) => Array.isArray(item.citations) && item.citations.length > 0).length
    : 0;
  const resolvedReviews = Array.isArray(value.constraintReviews)
    ? value.constraintReviews.filter((item) => item.grounded && item.relevance !== "uncertain" && item.consequence !== "uncertain").length
    : 0;
  return (value.hasBlockingCheck ? 10000 : 0)
    + resolvedReviews * 200
    + groundedChecks * 30
    + (value.hasGroundedChecks ? 20 : 0)
    - unresolved * 500;
}

function sumTokenUsage(items = []) {
  const totals = {};
  for (const item of items || []) {
    for (const [key, value] of Object.entries(item || {})) {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      totals[key] = (totals[key] || 0) + number;
    }
  }
  return totals;
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

function resolveReasoningGenerationConfig({ provider = "deepseek", modelName, thinkingMode, reasoningEffort, env = {} } = {}) {
  const warnings = [];
  const providerPrefix = String(provider || "deepseek").trim().toUpperCase();
  const modeSetting = firstConfiguredValue([
    ["request", thinkingMode],
    ["RAG_THINKING_MODE", env.RAG_THINKING_MODE],
    [`${providerPrefix}_THINKING_MODE`, env[`${providerPrefix}_THINKING_MODE`]],
  ]);
  let effectiveThinkingMode = String(modeSetting.value || "enabled").trim().toLowerCase();
  if (!DEEPSEEK_THINKING_MODES.has(effectiveThinkingMode)) {
    warnings.push(`${provider}_thinking_mode_invalid_defaulted_enabled`);
    effectiveThinkingMode = "enabled";
  }

  const effortSetting = firstConfiguredValue([
    ["request", reasoningEffort],
    ["RAG_REASONING_EFFORT", env.RAG_REASONING_EFFORT],
    [`${providerPrefix}_REASONING_EFFORT`, env[`${providerPrefix}_REASONING_EFFORT`]],
  ]);
  let effectiveReasoningEffort = String(effortSetting.value || "high").trim().toLowerCase();
  if (!DEEPSEEK_REASONING_EFFORTS.has(effectiveReasoningEffort)) {
    warnings.push(`${provider}_reasoning_effort_invalid_defaulted_high`);
    effectiveReasoningEffort = "high";
  }

  if (effectiveThinkingMode === "disabled") {
    if (effortSetting.value !== undefined) warnings.push(`${provider}_reasoning_effort_ignored_when_thinking_disabled`);
    return {
      thinkingMode: "disabled",
      reasoningEffort: null,
      thinkingModeSource: modeSetting.source || "default",
      reasoningEffortSource: "not_applicable",
      warnings,
    };
  }

  return {
    thinkingMode: "enabled",
    reasoningEffort: effectiveReasoningEffort,
    thinkingModeSource: modeSetting.source || "default",
    reasoningEffortSource: effortSetting.source || "default",
    warnings,
  };
}

function resolveRelayReasoningGenerationConfig({ reasoningEffort, env = {} } = {}) {
  const effortSetting = firstConfiguredValue([
    ["request", reasoningEffort],
    ["RAG_REASONING_EFFORT", env.RAG_REASONING_EFFORT],
    ["RELAY_REASONING_EFFORT", env.RELAY_REASONING_EFFORT],
  ]);
  let effectiveReasoningEffort = String(effortSetting.value || "high").trim().toLowerCase();
  const warnings = ["third_party_relay_model_identity_unverified"];
  if (!RELAY_REASONING_EFFORTS.has(effectiveReasoningEffort)) {
    warnings.push("relay_reasoning_effort_invalid_defaulted_high");
    effectiveReasoningEffort = "high";
  }
  return {
    thinkingMode: "not_applicable",
    reasoningEffort: effectiveReasoningEffort,
    thinkingModeSource: "not_applicable",
    reasoningEffortSource: effortSetting.source || "default",
    warnings,
  };
}

function firstConfiguredValue(entries = []) {
  for (const [source, value] of entries) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    return { source, value };
  }
  return { source: "", value: undefined };
}

function resolveRagMaxOutputTokens(env = {}, { provider = "", thinkingMode = "" } = {}) {
  const configured = Number(env.RAG_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  if (provider === "relay") {
    return readPositiveNumber(env.RELAY_MAX_COMPLETION_TOKENS, 32000);
  }
  const tier = resolveConfiguredModelTier(env);
  if ((provider === "deepseek" || provider === "glm") && thinkingMode === "enabled") {
    const tierSpecific = tier === "flash"
      ? env.RAG_FLASH_THINKING_MAX_OUTPUT_TOKENS
      : env.RAG_PRO_THINKING_MAX_OUTPUT_TOKENS;
    return readPositiveNumber(tierSpecific || env.RAG_THINKING_MAX_OUTPUT_TOKENS, 32000);
  }
  if (tier === "flash") return readPositiveNumber(env.RAG_FLASH_MAX_OUTPUT_TOKENS, 8000);
  return readPositiveNumber(env.RAG_PRO_MAX_OUTPUT_TOKENS, 8000);
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

export function selectPriorityConstraintEvidence({ items = [], userQuery = "", cardTexts = [], limit = 5 } = {}) {
  const userText = String(userQuery || "");
  const cardText = (cardTexts || [])
    .map((item) => [item.title, item.cardType, item.text].filter(Boolean).join("\n"))
    .join("\n");
  const scenarioText = [userText, cardText].filter(Boolean).join("\n");
  const scenarioConcepts = extractGroundingMechanisms(scenarioText);
  const userConcepts = extractGroundingMechanisms(userText);
  const ruleScenario = compileRuleScenario({ userQuery, cardTexts });
  if (scenarioConcepts.size < 2
      && !ruleScenario.simultaneousDestructionReplacement
      && !(ruleScenario.mandatoryFieldSpellTrapReturn && ruleScenario.currentChainSpellTrap)) return [];

  const ranked = dedupeGroundingEvidence(items)
    .filter((item) => RESTRICTIVE_EVIDENCE_PATTERN.test(String(item.text || "")))
    .map((item, index) => {
      const matches = splitRestrictiveEvidenceSegments(item.text)
        .map((text) => classifyPriorityConstraintSegment({
          text,
          userText,
          scenarioConcepts,
          userConcepts,
          ruleScenario,
        }))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score);
      const best = matches[0];
      if (!best) return null;
      return {
        item: {
          ...item,
          text: best.text,
          priorityConstraintSignature: best.signature,
        },
        score: best.score + Math.min(20, Number(item.score) || 0) - index * 0.01,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  const selected = [];
  const seenSignatures = new Set();
  for (const entry of ranked) {
    const signature = String(entry.item.priorityConstraintSignature || entry.item.id);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    selected.push(entry.item);
    if (selected.length >= Math.max(0, Number(limit) || 0)) break;
  }
  return selected;
}

function splitRestrictiveEvidenceSegments(value) {
  const text = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n+/gu).map((item) => item.trim()).filter(Boolean);
  return paragraphs.filter((item) => RESTRICTIVE_EVIDENCE_PATTERN.test(item));
}

function classifyPriorityConstraintSegment({
  text,
  userText,
  scenarioConcepts,
  userConcepts,
  ruleScenario,
}) {
  const evidenceConcepts = extractGroundingMechanisms(text);
  const sharedConcepts = [...scenarioConcepts].filter((concept) => evidenceConcepts.has(concept));
  const scenarioHasReturnOperation = ["return", "spell_trap", "hand", "activation"]
    .every((concept) => scenarioConcepts.has(concept));
  const evidenceHasActiveReturnRule = PRIORITY_ACTIVE_SPELL_TRAP_RETURN_PATTERN.test(text)
    && evidenceConcepts.has("return")
    && evidenceConcepts.has("spell_trap")
    && (evidenceConcepts.has("hand") || evidenceConcepts.has("deck"))
    && (evidenceConcepts.has("chain") || evidenceConcepts.has("activation"));
  const scenarioHasNoAlternative = PRIORITY_SCENARIO_ABSENCE_PATTERN.test(userText);
  const evidenceHasNoApplicableCardRule = PRIORITY_NO_APPLICABLE_CARD_PATTERN.test(text);
  if (ruleScenario?.simultaneousDestructionReplacement && PRIORITY_SIMULTANEOUS_REPLACEMENT_PATTERN.test(text)) {
    return {
      text,
      signature: "simultaneous_destruction_replacement_turn_player_first",
      score: 280 + sharedConcepts.length * 10,
    };
  }
  if (scenarioHasReturnOperation
      && (scenarioHasNoAlternative || ruleScenario?.noOtherSpellTraps)
      && evidenceHasActiveReturnRule
      && evidenceHasNoApplicableCardRule) {
    return {
      text,
      signature: "mandatory_active_spell_trap_return_without_alternative",
      score: 240 + sharedConcepts.length * 10,
    };
  }
  if (scenarioHasReturnOperation && evidenceHasActiveReturnRule) {
    const genericRuleBonus = /这种魔法[・·]?陷阱卡.{0,40}连锁途中不能从场上回到手卡[・·]?卡组/u.test(text) ? 80 : 0;
    return {
      text,
      signature: "active_spell_trap_return",
      score: 180 + genericRuleBonus + sharedConcepts.length * 10,
    };
  }

  const scenarioHasConstrainedCardOperation = scenarioConcepts.has("spell_trap")
    && scenarioConcepts.has("activation")
    && ["return", "target", "destroy", "banish", "deck", "graveyard"]
      .some((concept) => scenarioConcepts.has(concept));
  if (scenarioHasConstrainedCardOperation
      && (scenarioHasNoAlternative || ruleScenario?.noOtherSpellTraps)
      && evidenceHasNoApplicableCardRule) {
    const genericRuleBonus = PRIORITY_GENERIC_NO_APPLICABLE_CARD_PATTERN.test(text)
      ? 120
      : 0;
    return {
      text,
      signature: "no_applicable_card_for_mandatory_operation",
      score: 160 + genericRuleBonus + sharedConcepts.length * 10,
    };
  }

  if (userConcepts.has("target")
      && evidenceConcepts.has("target")
      && PRIORITY_TARGET_RESTRICTION_PATTERN.test(text)) {
    return {
      text,
      signature: "targeting_restriction",
      score: 140 + sharedConcepts.length * 10,
    };
  }

  return null;
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

function selectGroundingCandidates({
  priorityConstraintEvidence = [],
  selectedQaEvidence = [],
  selectedCardTexts = [],
  selectedRuleEvidence = [],
  maxCandidates = Number.POSITIVE_INFINITY,
} = {}) {
  const priorities = dedupeGroundingEvidence(priorityConstraintEvidence);
  const directQa = dedupeGroundingEvidence(selectedQaEvidence.filter(isDirectGroundingQa));
  const cardTexts = dedupeGroundingEvidence(selectedCardTexts);
  const mandatory = dedupeGroundingEvidence([...priorities, ...directQa, ...cardTexts]);
  const mandatoryIds = new Set(mandatory.map((item) => String(item.id)));
  const remainingLimit = Number.isFinite(maxCandidates)
    ? Math.max(0, Number(maxCandidates) - mandatory.length)
    : Number.POSITIVE_INFINITY;
  const remainder = interleaveGroundingEvidence([
    selectedQaEvidence.filter((item) => !isDirectGroundingQa(item) && isFaqGroundingEvidence(item)),
    selectedRuleEvidence.filter((item) => !mandatoryIds.has(String(item.id))),
    selectedQaEvidence.filter((item) => !isDirectGroundingQa(item) && !isFaqGroundingEvidence(item)),
  ], remainingLimit);
  return dedupeGroundingEvidence([...mandatory, ...remainder]).slice(0, maxCandidates);
}

function isDirectGroundingQa(item = {}) {
  return item.isDirect === true || item.type === "official_qa";
}

function isFaqGroundingEvidence(item = {}) {
  return item.type === "faq" || item.recordType === "card-faq" || String(item.id || "").startsWith("card-faq-");
}

function modelNameForProvider(provider, env) {
  if (provider === "glm") {
    return String(env.GLM_MODEL || env.RAG_MODEL || DEFAULT_GLM_MODEL);
  }
  if (provider === "deepseek") {
    const tier = resolveConfiguredModelTier(env);
    if (tier === "flash") {
      return String(env.RAG_MODEL
        || env.DEEPSEEK_FLASH_MODEL
        || DEFAULT_DEEPSEEK_CARD_MODEL);
    }
    return String(env.RAG_MODEL
      || env.DEEPSEEK_PRO_MODEL
      || env.DEEPSEEK_MODEL
      || "deepseek-v4-pro");
  }
  if (provider === "relay") {
    return String(env.RAG_MODEL || env.RELAY_MODEL || DEFAULT_PUBLIC_RELAY_MODEL);
  }
  if (provider === "gemini") {
    const tier = resolveConfiguredModelTier(env);
    if (tier === "flash") {
      return String(env.GEMINI_FLASH_MODEL
        || env.GEMINI_CARD_MODEL
        || "gemini-1.5-flash");
    }
    return String(env.GEMINI_PRO_MODEL
      || env.GEMINI_MODEL
      || env.RAG_MODEL
      || env.GEMINI_FLASH_MODEL
      || env.GEMINI_CARD_MODEL
      || "gemini-1.5-flash");
  }
  return "mock-rag";
}

function resolveConfiguredModelTier(env = {}) {
  const tier = String(env.RAG_MODEL_TIER || "").trim().toLowerCase();
  return tier === "flash" ? "flash" : "pro";
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
  if (provider === "glm") return Boolean(env.GLM_API_KEY);
  if (provider === "relay") return Boolean(String(env.RELAY_API_KEY || "").trim());
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
  const tier = resolveConfiguredModelTier(env);
  const tierValue = Number(env[`${providerPrefix}_${tier.toUpperCase()}_${suffix}`]);
  if (Number.isFinite(tierValue)) return tierValue;
  return readNumber(env[`${providerPrefix}_${suffix}`], fallback);
}

function compatibleChatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/u, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function relayChatCompletionsUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || DEFAULT_PUBLIC_RELAY_BASE_URL).trim());
  } catch {
    throw new TypeError("RELAY_BASE_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new TypeError("RELAY_BASE_URL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("RELAY_BASE_URL must not contain credentials, query parameters or fragments");
  }
  return compatibleChatCompletionsUrl(parsed.toString());
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
  return `rag-api-budget:${budgetDate(timezone, now)}`;
}

function budgetBucketDayKey(timezone, now, bucketId) {
  if (!PUBLIC_BUDGET_BUCKETS.some((bucket) => bucket.id === bucketId)
      && !/^internal:(?:evidence_preparation|final_ruling):gemini$/u.test(String(bucketId || ""))) {
    throw new TypeError(`Unsupported public budget bucket: ${bucketId}`);
  }
  return `rag-api-budget:v2:${budgetDate(timezone, now)}:${bucketId}`;
}

function budgetDate(timezone, now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_BUDGET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}
