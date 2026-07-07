import { RAG_ANSWER_LEVELS } from "./ragRulingPrompt.mjs";

const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export async function callRagModel({
  prompt,
  evidence = {},
  cardResolution = {},
  env = globalThis.process?.env || {},
  modelInvoker,
  dryRun,
} = {}) {
  const provider = String(env.RAG_MODEL_PROVIDER || env.MODEL_PROVIDER || inferProvider(env)).toLowerCase();
  const modelName = provider === "deepseek"
    ? String(env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL)
    : String(env.GLM_MODEL || env.OPENAI_MODEL || "");
  const forcedDryRun = dryRun === true || String(env.RAG_DRY_RUN || "").toLowerCase() === "true";

  if (modelInvoker) {
    return parseModelResult(await modelInvoker({ prompt, provider, modelName }), { provider: provider || "mock", modelName, dryRun: false });
  }

  if (forcedDryRun || !hasProviderKey(provider, env)) {
    return {
      answer: buildMockAnswer({ evidence, cardResolution }),
      rawText: "",
      provider: "mock",
      modelName: "mock-rag",
      modelUsed: "mock-rag",
      dryRun: true,
      warnings: [],
    };
  }

  if (provider === "deepseek") {
    const rawText = await callDeepSeek({ prompt, env, modelName });
    return parseModelResult(rawText, { provider, modelName, dryRun: false });
  }

  return {
    answer: safeFallbackAnswer("unsupported_provider"),
    rawText: "",
    provider: provider || "none",
    modelName,
    modelUsed: provider || "none",
    dryRun: true,
    warnings: [`unsupported_rag_model_provider:${provider || "none"}`],
  };
}

export function parseRagModelJson(rawText) {
  const text = String(rawText || "").trim();
  if (!text) throw new SyntaxError("empty model output");
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/u);
    if (!match) throw new SyntaxError("model output is not JSON");
    return JSON.parse(match[0]);
  }
}

function parseModelResult(rawText, { provider, modelName, dryRun }) {
  try {
    const parsed = rawText && typeof rawText === "object" ? rawText : parseRagModelJson(rawText);
    return {
      answer: normalizeModelAnswer(parsed),
      rawText: String(rawText || ""),
      provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun,
      warnings: [],
    };
  } catch (error) {
    return {
      answer: safeFallbackAnswer("model_json_parse_failed"),
      rawText: String(rawText || ""),
      provider,
      modelName,
      modelUsed: modelName || provider,
      dryRun,
      warnings: [`model_json_parse_failed:${error instanceof Error ? error.message : String(error)}`],
    };
  }
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
  if (cardText || related) {
    const used = [cardText, related].filter(Boolean).map((item) => ({ id: item.id, type: item.type, title: item.title }));
    return normalizeModelAnswer({
      answerLevel: related ? "rule_analysis" : "low_confidence_analysis",
      shortAnswer: related
        ? "没有命中官方直接 Q&A；下面只能基于卡片文本和相关资料给出未确认分析。"
        : "目前主要只有卡片文本，不能当作官方裁定。",
      reasoning: [
        cardText ? "已读取相关卡片文本。" : "",
        related ? "检索到相关资料，但它不是当前问题的官方 direct Q&A。" : "",
      ].filter(Boolean),
      usedCards: (cardResolution.resolvedCards || []).map((card) => card.name).filter(Boolean),
      usedEvidence: used,
      missingInfo: [],
      riskFlags: [related ? "no_official_direct_qa" : "card_text_only"],
      confidenceSelfEstimate: related ? "medium" : "low",
    });
  }
  return safeFallbackAnswer("no_retrieved_evidence");
}

function safeFallbackAnswer(reason) {
  return normalizeModelAnswer({
    answerLevel: "needs_more_info",
    shortAnswer: "当前资料不足，无法给出可靠裁定分析。",
    reasoning: ["没有可用的模型 JSON 结果或检索资料不足。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: ["请补充正式卡名、效果编号、具体时点和连锁状态。"],
    riskFlags: [reason],
    confidenceSelfEstimate: "low",
  });
}

async function callDeepSeek({ prompt, env, modelName }) {
  const response = await fetch(String(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions"), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelName || DEFAULT_DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: Number(env.RAG_MODEL_TEMPERATURE || 0.2),
    }),
  });
  if (!response.ok) throw new Error(`deepseek ${response.status}`);
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || "";
}

function inferProvider(env) {
  if (env.DEEPSEEK_API_KEY) return "deepseek";
  if (env.GLM_API_KEY) return "glm";
  return "mock";
}

function hasProviderKey(provider, env) {
  if (provider === "deepseek") return Boolean(env.DEEPSEEK_API_KEY);
  if (provider === "glm") return Boolean(env.GLM_API_KEY);
  return false;
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
