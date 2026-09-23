import { createCloudRequestBudget } from "./cloudRequestBudget.mjs";
import { DEFAULT_BAI_GENERATION_BASE_URL } from "./evidenceGenerationTransport.mjs";
import { preparationError, isPublicPreparationId } from "./publicAnswerPreparationStore.mjs";

export const SOURCE_TRANSLATION_VERSION = "gpt-6-luna-low-fields-v1";
const LOCALES = ["zh-CN", "en", "ja"];
const BODY_KEYS = ["question", "rawQuestion", "rawDetailedQuestion", "detailedScene", "answer", "officialAnswer", "conclusion",
  "officialText", "fullText", "cardText", "ruleText", "body", "content", "paragraph", "description", "text", "explanation"];

export function sourceTranslationFields(source) {
  let record = source;
  if (typeof source?.text === "string" && /^[\s]*[{[]/u.test(source.text)) {
    try {
      const parsed = JSON.parse(source.text);
      if (parsed && !Array.isArray(parsed) && typeof parsed === "object"
          && ["qa", "card-faq"].includes(parsed.recordType)) record = parsed;
    } catch { /* The plain source may begin with a brace. */ }
  }
  return Object.fromEntries(BODY_KEYS.filter((key) => typeof record?.[key] === "string" && record[key])
    .map((key) => [key, record[key]]));
}

export async function translatePublicSource({ payload, store, env = process.env,
  fetchImpl = globalThis.fetch, createBudget = createCloudRequestBudget, signal } = {}) {
  const { sourceSnapshotId, sourceId, targetLocale } = payload || {};
  if (!isPublicPreparationId(sourceSnapshotId) || typeof sourceId !== "string" || !sourceId
      || sourceId.length > 200 || !LOCALES.includes(targetLocale)) {
    throw preparationError("无效的来源翻译请求", "invalid_source_translation_request", 400);
  }
  const snapshot = await store.readSourceSnapshot(sourceSnapshotId);
  const source = snapshot.sources?.find((item) => item.id === sourceId);
  if (!source || !/^[0-9a-f]{64}$/u.test(String(source.sourceHash || ""))) {
    throw preparationError("来源不在本次引用中", "source_not_in_snapshot", 404);
  }
  const identity = [source.id, snapshot.system, source.sourceHash, targetLocale, SOURCE_TRANSLATION_VERSION];
  if (source.sourceLanguage === targetLocale) return { status: "original", sourceHash: source.sourceHash };
  const cached = await store.readSourceTranslation(identity);
  if (cached) return { status: "translated", ...cached, cached: true };
  const fields = sourceTranslationFields(source);
  if (!Object.keys(fields).length || JSON.stringify(fields).length > 40000) {
    throw preparationError("此来源暂不能翻译", "source_translation_unavailable", 422);
  }
  const dailyBudget = Number(env.SOURCE_TRANSLATION_DAILY_BUDGET_USD);
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
    throw preparationError("来源翻译尚未启用", "source_translation_disabled", 503);
  }
  if (!await store.claimSourceTranslation(identity)) {
    return { status: "pending", sourceHash: source.sourceHash };
  }
  const budgetEnv = { ...env, CLOUD_BUDGET_RUN_ID: "source_translation",
    CLOUD_BUDGET_PERIOD: "daily", CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "0",
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: String(dailyBudget),
    CLOUD_BUDGET_INITIAL_ACTUAL_CNY: "0", CLOUD_BUDGET_INITIAL_THEORETICAL_USD: "0" };
  const body = {
    model: "gpt-6-luna",
    reasoning: { effort: "low" },
    max_output_tokens: 16384,
    instructions: `Translate each JSON string value completely into ${targetLocale}. Preserve conditions, negations, card names, numbers, citations and line breaks. Return only a JSON object with exactly the same keys. Do not summarize.`,
    input: JSON.stringify(fields),
  };
  const base = new URL(String(env.RAG_EVIDENCE_BAI_BASE_URL || env.BAI_BASE_URL || DEFAULT_BAI_GENERATION_BASE_URL));
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw preparationError("翻译服务配置错误", "source_translation_configuration_invalid", 503);
  }
  const endpoint = `${base.href.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/responses`;
  const apiKey = String(env.RAG_EVIDENCE_BAI_API_KEY || env.BAI_API_KEY || "").trim();
  if (!apiKey) throw preparationError("翻译服务尚未配置", "source_translation_configuration_invalid", 503);
  const budget = createBudget({ env: budgetEnv, fetchImpl });
  const raw = await budget.sourceTranslation({ body, signal, invoke: async () => {
    const response = await fetchImpl(endpoint, { method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: signal || AbortSignal.timeout(90000) });
    if (!response.ok) throw preparationError("翻译服务暂不可用", `source_translation_provider_http_${response.status}`, 503);
    return response.json();
  } });
  if (raw?.status !== "completed") throw preparationError("翻译未完成", "source_translation_incomplete", 503);
  const content = (Array.isArray(raw.output) ? raw.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === "output_text")
    .map((part) => String(part.text || "")).join("");
  let translated;
  try { translated = JSON.parse(content); } catch {
    throw preparationError("译文格式不可用", "source_translation_invalid_output", 503);
  }
  if (!translated || Array.isArray(translated) || typeof translated !== "object"
      || Object.keys(fields).some((key) => typeof translated[key] !== "string" || !translated[key])
      || Object.keys(translated).some((key) => !Object.hasOwn(fields, key))) {
    throw preparationError("译文格式不可用", "source_translation_invalid_output", 503);
  }
  const value = { sourceHash: source.sourceHash, targetLocale, version: SOURCE_TRANSLATION_VERSION, fields: translated };
  try {
    await store.saveSourceTranslation(identity, value);
  } catch {
    // The provider has already returned a billable translation. Deliver it
    // to this browser even if the shared cache is temporarily unavailable.
    return { status: "translated", ...value, cached: false, cachePersisted: false };
  }
  return { status: "translated", ...value, cached: false, cachePersisted: true };
}
