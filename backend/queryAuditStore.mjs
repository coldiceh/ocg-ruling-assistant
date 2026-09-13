import { randomUUID } from "node:crypto";

const DEFAULT_KEY = "rag-query-audit:v1";
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 100;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 1800;
const MAX_QUESTION_LENGTH = 12000;
const UPDATE_ENTRY = `
local values = redis.call("LRANGE", KEYS[1], 0, 99)
for index, raw in ipairs(values) do
  local decoded, entry = pcall(cjson.decode, raw)
  if decoded and type(entry) == "table" and entry.id == ARGV[1] then
    local patch = cjson.decode(ARGV[2])
    for field, value in pairs(patch) do
      entry[field] = value
    end
    local updated = cjson.encode(entry)
    redis.call("LSET", KEYS[1], index - 1, updated)
    return updated
  end
end
return nil
`.trim();
const AUDIT_STATUSES = new Set(["preparing", "prepared", "completed", "blocked", "failed"]);

export function queryAuditStorageStatus(env = globalThis.process?.env || {}) {
  if (isDisabled(env.QUERY_AUDIT_ENABLED)) {
    return { enabled: false, storage: "disabled", persistent: false };
  }
  const redis = redisConfig(env);
  if (!redis.url || !redis.token) {
    return { enabled: false, storage: "unconfigured", persistent: false };
  }
  return { enabled: true, storage: "redis", persistent: true };
}

export async function appendQueryAudit({
  question,
  mode = "rag",
  requestId,
  requestContext,
  profileId,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const status = queryAuditStorageStatus(env);
  const normalizedQuestion = Array.from(String(question || "").trim())
    .slice(0, MAX_QUESTION_LENGTH)
    .join("");
  if (!status.enabled || !normalizedQuestion || typeof fetchImpl !== "function") {
    return {
      stored: false,
      ...status,
      reason: !normalizedQuestion ? "empty_question" : status.storage,
    };
  }

  const createdAt = validDate(now).toISOString();
  const entry = {
    id: randomUUID(),
    createdAt,
    question: normalizedQuestion,
    mode: String(mode || "rag").slice(0, 32),
    status: "preparing",
    ...optionalString("requestId", requestId),
    ...optionalString("ip", requestContext?.ip),
    ...optionalString("ipSource", requestContext?.ipSource),
    ...optionalString("requestChannel", requestContext?.requestChannel),
    ...optionalString("profileId", profileId),
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

export async function updateQueryAudit({
  id,
  patch,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const storage = queryAuditStorageStatus(env);
  const normalizedId = String(id || "").trim();
  if (!storage.enabled || typeof fetchImpl !== "function") {
    const error = new Error("query_audit_storage_unavailable");
    error.code = "query_audit_storage_unavailable";
    throw error;
  }
  if (!normalizedId) {
    const error = new Error("query_audit_id_required");
    error.code = "query_audit_id_required";
    throw error;
  }

  const normalizedPatch = normalizeAuditPatch(patch);
  const key = String(env.QUERY_AUDIT_REDIS_KEY || DEFAULT_KEY).trim() || DEFAULT_KEY;
  const updated = await redisCommand(env, fetchImpl, [
    "EVAL", UPDATE_ENTRY, "1", key, normalizedId, JSON.stringify(normalizedPatch),
  ]);
  if (updated === null || updated === undefined) {
    return { updated: false, ...storage, reason: "not_found" };
  }
  const entry = parseEntry(updated);
  if (!entry) throw new Error("query_audit_update_response_invalid");
  return { updated: true, ...storage, entry };
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
  const controller = new AbortController();
  return withTimeout((async () => {
    const response = await fetchImpl(redis.url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + redis.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error("redis " + (response?.status || "error"));
    const payload = await response.json();
    if (payload?.error) throw new Error(String(payload.error));
    return payload?.result;
  })(), timeoutMs, "query_audit_redis_timeout", () => controller.abort());
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
    if (!question || !createdAt) return null;
    const entry = {
      id: String(parsed.id || ""),
      createdAt,
      question,
      mode: String(parsed.mode || "rag"),
    };
    for (const field of ["requestId", "ip", "ipSource", "requestChannel", "profileId", "status", "completedAt", "answer", "model", "reasoningEffort", "errorCode"]) {
      if (Object.hasOwn(parsed, field)) entry[field] = parsed[field];
    }
    if (Object.hasOwn(parsed, "latencyMs")) entry.latencyMs = parsed.latencyMs;
    return entry;
  } catch {
    return null;
  }
}

function normalizeAuditPatch(patch) {
  const source = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const normalized = {};
  if (Object.hasOwn(source, "status")) {
    if (!AUDIT_STATUSES.has(source.status)) throw new TypeError("query_audit_status_invalid");
    normalized.status = source.status;
  }
  for (const field of ["completedAt", "answer", "model", "reasoningEffort", "errorCode", "profileId"]) {
    if (!Object.hasOwn(source, field)) continue;
    if (typeof source[field] !== "string") throw new TypeError(`query_audit_${field}_invalid`);
    normalized[field] = source[field];
  }
  if (Object.hasOwn(source, "latencyMs")) {
    if (!Number.isFinite(source.latencyMs) || source.latencyMs < 0) {
      throw new TypeError("query_audit_latency_invalid");
    }
    normalized.latencyMs = source.latencyMs;
  }
  return normalized;
}

function optionalString(field, value) {
  if (typeof value !== "string" || !value.trim()) return {};
  return { [field]: value.trim() };
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

function withTimeout(promise, timeoutMs, label, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label));
      onTimeout();
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
