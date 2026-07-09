import { RAG_ANSWER_LEVELS } from "./ragRulingPrompt.mjs";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_CARD_MODEL = "deepseek-v4-flash";
const DEFAULT_LIGHTWEIGHT_EXTRACTION_TIMEOUT_MS = 4500;
const DEFAULT_DAILY_BUDGET_CNY = 10;
const DEFAULT_BUDGET_TIMEZONE = "Asia/Tokyo";
const memoryBudget = new Map();
const cardNameExtractionCache = new Map();
const ruleQueryExtractionCache = new Map();

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
  const maxTokens = readNumber(env.RAG_MAX_OUTPUT_TOKENS, 2500);
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

export function estimateDeepSeekCostCny(usage = {}, env = {}) {
  const inputPrice = readNumber(env.DEEPSEEK_INPUT_CNY_PER_MTOK, 1);
  const outputPrice = readNumber(env.DEEPSEEK_OUTPUT_CNY_PER_MTOK, 2);
  const cacheHitPrice = readNumber(env.DEEPSEEK_CACHE_HIT_INPUT_CNY_PER_MTOK, 0.02);
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const cacheHit = Number(usage.prompt_cache_hit_tokens || 0);
  const cacheMiss = Number(usage.prompt_cache_miss_tokens || 0);
  const inputCost = cacheHit + cacheMiss > 0
    ? mtok(cacheHit) * cacheHitPrice + mtok(cacheMiss) * inputPrice
    : mtok(promptTokens) * inputPrice;
  return roundCost(inputCost + mtok(completionTokens) * outputPrice);
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
    temperature: temperature ?? readNumber(env.RAG_MODEL_TEMPERATURE, 0.2),
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
  return {
    rawText: payload?.choices?.[0]?.message?.content || "",
    usage: payload?.usage || {},
    warnings,
  };
}

async function callGemini({ prompt, env, modelName, maxTokens, fetchImpl, temperature, maxTokensEnvName = "GEMINI_MAX_OUTPUT_TOKENS" }) {
  const model = modelName || env.GEMINI_MODEL || "gemini-1.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: temperature ?? readNumber(env.GEMINI_TEMPERATURE, readNumber(env.RAG_MODEL_TEMPERATURE, 0.2)),
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
    reasoning: readJsonStringArrayField(text, "reasoning"),
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
  return {
    answerLevel,
    shortAnswer: nonEmpty(answer.shortAnswer) || "根据现有资料只能给出未确认分析。",
    reasoning: cleanStringArray(answer.reasoning),
    usedCards: cleanStringArray(answer.usedCards),
    usedEvidence: normalizeUsedEvidence(answer.usedEvidence),
    missingInfo: cleanStringArray(answer.missingInfo),
    riskFlags: cleanStringArray(answer.riskFlags),
    confidenceSelfEstimate: confidence,
  };
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
  const warnings = storage === "memory"
    ? ["persistent_budget_storage_missing_vercel_limit_is_soft"]
    : [];
  const estimated = estimatePreflightCostCny(provider, prompt, maxTokens, env);
  if (!trackSpend) {
    return {
      config,
      storage,
      dayKey,
      blocked: false,
      reservedAmountCny: 0,
      warnings,
      status: {
        dailyBudgetCny: config.dailyBudgetCny,
        spentTodayCny: 0,
        estimatedThisCallCny: estimated,
        budgetMode: config.mode,
        budgetStorage: storage,
        limitEnforced: false,
      },
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
    status: {
      dailyBudgetCny: config.dailyBudgetCny,
      spentTodayCny: roundCost(spent),
      estimatedThisCallCny: estimated,
      budgetMode: config.mode,
      budgetStorage: storage,
      limitEnforced: blocked,
    },
  };
}

async function recordBudgetSpend({ preflight, actualCostCny, env, fetchImpl }) {
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
  return env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? "redis" : "memory";
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

async function redisCommand(env, fetchImpl, command) {
  const response = await fetchImpl(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`redis ${response.status}`);
  const payload = await response.json();
  return payload?.result;
}

function estimatePreflightCostCny(provider, prompt, maxTokens, env) {
  const promptTokens = Math.ceil(String(prompt || "").length / 4);
  if (provider === "deepseek") {
    return estimateDeepSeekCostCny({ prompt_tokens: promptTokens, completion_tokens: maxTokens }, env);
  }
  if (provider === "gemini") {
    return roundCost(readNumber(env.GEMINI_ESTIMATED_CNY_PER_CALL, 0.01));
  }
  return 0;
}

function estimateActualCostCny(provider, usage, env) {
  if (provider === "deepseek") return estimateDeepSeekCostCny(usage, env);
  if (provider === "gemini") return roundCost(readNumber(env.GEMINI_ESTIMATED_CNY_PER_CALL, 0.01));
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
    "你只负责从玩家的游戏王 OCG 裁定问题中提取可能的卡名候选，不要回答裁定。",
    "如果玩家卡名有错别字、漏字、俗称、缺少间隔点，可以给出你认为最可能的正式卡名候选，但不要编造没有依据的卡。",
    "保留玩家原文片段 originalText；如果不能确信，只把 confidence 设为 low。",
    "输出必须是单个 JSON 对象，不要 markdown，不要解释。",
    "JSON 只包含 cardNames 数组；每项包含 name、originalText、confidence。",
    "不要输出效果名、动作、场地区域、玩家称谓或规则术语。",
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
    if (result.length >= 8) break;
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

function modelNameForProvider(provider, env) {
  if (provider === "deepseek") return String(env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL);
  if (provider === "gemini") return String(env.GEMINI_MODEL || "gemini-1.5-flash");
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
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
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
