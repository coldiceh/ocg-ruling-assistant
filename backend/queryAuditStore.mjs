import { createHash } from "node:crypto";

const DEFAULT_KEY = "rag-query-audit:v1";
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 100;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 1800;

export function queryAuditStorageStatus(env = globalThis.process?.env || {}) {
  const storesContent = shouldStoreQuestionContent(env);
  if (isDisabled(env.QUERY_AUDIT_ENABLED)) {
    return { enabled: false, storage: "disabled", persistent: false, storesContent };
  }
  const redis = redisConfig(env);
  if (!redis.url || !redis.token) {
    return { enabled: false, storage: "unconfigured", persistent: false, storesContent };
  }
  return { enabled: true, storage: "redis", persistent: true, storesContent };
}

export async function appendQueryAudit({
  question,
  mode = "rag",
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const status = queryAuditStorageStatus(env);
  const normalizedQuestion = String(question || "").trim().slice(0, 6000);
  if (!status.enabled || !normalizedQuestion || typeof fetchImpl !== "function") {
    return {
      stored: false,
      ...status,
      reason: !normalizedQuestion ? "empty_question" : status.storage,
    };
  }

  const createdAt = validDate(now).toISOString();
  const questionSha256 = sha256(normalizedQuestion);
  const entry = {
    schemaVersion: 2,
    id: createHash("sha256")
      .update(createdAt + "\u0000" + String(mode || "rag") + "\u0000" + questionSha256)
      .digest("hex")
      .slice(0, 20),
    createdAt,
    mode: String(mode || "rag").slice(0, 32),
    questionSha256,
    questionCharacters: Array.from(normalizedQuestion).length,
    questionBytes: Buffer.byteLength(normalizedQuestion, "utf8"),
    languageHint: detectLanguageHint(normalizedQuestion),
    contentStored: status.storesContent,
    ...(status.storesContent ? { question: normalizedQuestion } : {}),
  };
  const key = String(env.QUERY_AUDIT_REDIS_KEY || DEFAULT_KEY).trim() || DEFAULT_KEY;
  const maxEntries = boundedInteger(env.QUERY_AUDIT_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, 10, MAX_ENTRIES);
  const retentionSeconds = boundedInteger(
    env.QUERY_AUDIT_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    1,
    90,
  ) * 86400;

  await redisCommand(env, fetchImpl, ["LPUSH", key, JSON.stringify(entry)]);
  await Promise.all([
    redisCommand(env, fetchImpl, ["LTRIM", key, "0", String(maxEntries - 1)]),
    redisCommand(env, fetchImpl, ["EXPIRE", key, String(retentionSeconds)]),
  ]);
  return { stored: true, ...status, entry };
}

export async function listQueryAudits({
  limit = DEFAULT_LIST_LIMIT,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const status = queryAuditStorageStatus(env);
  if (!status.enabled || typeof fetchImpl !== "function") {
    const error = new Error("query_audit_storage_unavailable");
    error.code = "query_audit_storage_unavailable";
    throw error;
  }

  const key = String(env.QUERY_AUDIT_REDIS_KEY || DEFAULT_KEY).trim() || DEFAULT_KEY;
  const safeLimit = boundedInteger(limit, DEFAULT_LIST_LIMIT, 1, MAX_ENTRIES);
  const values = await redisCommand(env, fetchImpl, ["LRANGE", key, "0", String(safeLimit - 1)]);
  const entries = (Array.isArray(values) ? values : [])
    .map(parseEntry)
    .filter(Boolean);
  return {
    ...status,
    entries,
    count: entries.length,
  };
}

async function redisCommand(env, fetchImpl, command) {
  const redis = redisConfig(env);
  if (!redis.url || !redis.token) throw new Error("redis_not_configured");
  const timeoutMs = boundedInteger(env.QUERY_AUDIT_REDIS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 5000);
  const response = await withTimeout(fetchImpl(redis.url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + redis.token,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  }), timeoutMs, "query_audit_redis_timeout");
  if (!response?.ok) throw new Error("redis " + (response?.status || "error"));
  const payload = await response.json();
  if (payload?.error) throw new Error(String(payload.error));
  return payload?.result;
}

function redisConfig(env = {}) {
  return {
    url: String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || env.REDIS_REST_API_URL || "").trim(),
    token: String(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.REDIS_REST_API_TOKEN || "").trim(),
  };
}

function parseEntry(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    const question = String(parsed?.question || "").trim();
    const createdAt = String(parsed?.createdAt || "").trim();
    const questionSha256 = normalizeSha256(parsed?.questionSha256)
      || (question ? sha256(question) : "");
    if (!createdAt || !questionSha256) return null;
    const questionCharacters = nonNegativeInteger(
      parsed?.questionCharacters,
      question ? Array.from(question).length : null,
    );
    const questionBytes = nonNegativeInteger(
      parsed?.questionBytes,
      question ? Buffer.byteLength(question, "utf8") : null,
    );
    if (questionCharacters === null || questionBytes === null) return null;
    return {
      id: String(parsed.id || ""),
      createdAt,
      mode: String(parsed.mode || "rag"),
      questionSha256,
      questionCharacters,
      questionBytes,
      languageHint: normalizeLanguageHint(parsed?.languageHint)
        || detectLanguageHint(question),
      contentStored: Boolean(question),
      ...(question ? { question } : {}),
    };
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeSha256(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : "";
}

function nonNegativeInteger(value, fallback = null) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return fallback;
  return number;
}

function detectLanguageHint(value) {
  const text = String(value || "");
  if (!text) return "unknown";
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return "ja";
  if (/\p{Script=Han}/u.test(text)) return "cjk";
  if (/\p{Script=Latin}/u.test(text)) return "latin";
  return "other";
}

function normalizeLanguageHint(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^(?:ja|cjk|latin|other|unknown)$/u.test(text) ? text : "";
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function isDisabled(value) {
  return /^(?:0|false|off|no)$/iu.test(String(value || "").trim());
}

function shouldStoreQuestionContent(env = {}) {
  return /^(?:1|true|on|yes)$/iu.test(String(env.QUERY_AUDIT_STORE_CONTENT || "").trim());
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
