const DEFAULT_KEY_PREFIX = "rag-public-answer-latency:v1";
const DEFAULT_WINDOW_SIZE = 20;
const MAX_WINDOW_SIZE = 20;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 1200;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const RECORD_SAMPLE_SCRIPT = `
redis.call("LPUSH", KEYS[1], ARGV[1])
redis.call("LTRIM", KEYS[1], 0, tonumber(ARGV[2]))
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
return redis.call("LRANGE", KEYS[1], 0, tonumber(ARGV[2]))
`.trim();

/**
 * Small, best-effort rolling latency store for successful public answers.
 *
 * Callers decide what constitutes a successful answer and should only call
 * recordPublicAnswerLatency after that answer has completed. Storage failures
 * are represented in the returned status and never escape as exceptions.
 */
export async function recordPublicAnswerLatency({
  profileId,
  durationMs,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const context = latencyContext({ profileId, env });
  if (!context.ok) return unavailableStat(context.profileId, context.reason, context.storage);

  const duration = normalizeDuration(durationMs);
  if (duration === null) return unavailableStat(context.profileId, "invalid_duration", context.storage);
  if (typeof fetchImpl !== "function") {
    return unavailableStat(context.profileId, "fetch_unavailable", context.storage);
  }

  const timestamp = validDate(now).getTime();
  const sample = `${timestamp}:${duration}`;
  try {
    const values = await redisCommand(env, fetchImpl, [
      "EVAL",
      RECORD_SAMPLE_SCRIPT,
      "1",
      context.key,
      sample,
      String(context.windowSize - 1),
      String(context.retentionSeconds),
    ]);
    return summarizeSamples({
      profileId: context.profileId,
      values,
      nowMs: timestamp,
      windowSize: context.windowSize,
      retentionMs: context.retentionMs,
    });
  } catch {
    return unavailableStat(context.profileId, "storage_error", context.storage);
  }
}

export async function readPublicAnswerLatency({
  profileId,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const context = latencyContext({ profileId, env });
  if (!context.ok) return unavailableStat(context.profileId, context.reason, context.storage);
  if (typeof fetchImpl !== "function") {
    return unavailableStat(context.profileId, "fetch_unavailable", context.storage);
  }

  try {
    const values = await redisCommand(env, fetchImpl, [
      "LRANGE",
      context.key,
      "0",
      String(context.windowSize - 1),
    ]);
    return summarizeSamples({
      profileId: context.profileId,
      values,
      nowMs: validDate(now).getTime(),
      windowSize: context.windowSize,
      retentionMs: context.retentionMs,
    });
  } catch {
    return unavailableStat(context.profileId, "storage_error", context.storage);
  }
}

export async function readPublicAnswerLatencyProfiles({
  profileIds = [],
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const ids = [...new Set((Array.isArray(profileIds) ? profileIds : [])
    .map((profileId) => normalizeProfileId(profileId))
    .filter(Boolean))];
  const profiles = await Promise.all(ids.map((profileId) => readPublicAnswerLatency({
    profileId,
    env,
    fetchImpl,
    now,
  })));
  return { profiles };
}

export function publicAnswerLatencyStorageStatus(env = globalThis.process?.env || {}) {
  if (isDisabled(env.PUBLIC_ANSWER_LATENCY_ENABLED)) {
    return { enabled: false, storage: "disabled", persistent: false };
  }
  const redis = redisConfig(env);
  if (!redis.url || !redis.token) {
    return { enabled: false, storage: "unconfigured", persistent: false };
  }
  return { enabled: true, storage: "redis", persistent: true };
}

function latencyContext({ profileId, env }) {
  const normalizedProfileId = normalizeProfileId(profileId);
  if (!normalizedProfileId) {
    return { ok: false, profileId: "", storage: "unconfigured", reason: "invalid_profile" };
  }
  const status = publicAnswerLatencyStorageStatus(env);
  if (!status.enabled) {
    return {
      ok: false,
      profileId: normalizedProfileId,
      storage: status.storage,
      reason: status.storage,
    };
  }
  const windowSize = boundedInteger(
    env.PUBLIC_ANSWER_LATENCY_WINDOW_SIZE,
    DEFAULT_WINDOW_SIZE,
    1,
    MAX_WINDOW_SIZE,
  );
  const retentionDays = boundedInteger(
    env.PUBLIC_ANSWER_LATENCY_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    1,
    DEFAULT_RETENTION_DAYS,
  );
  const keyPrefix = String(env.PUBLIC_ANSWER_LATENCY_REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX).trim()
    || DEFAULT_KEY_PREFIX;
  const releaseId = latencyReleaseId(env);
  return {
    ok: true,
    profileId: normalizedProfileId,
    storage: "redis",
    key: [keyPrefix, releaseId, normalizedProfileId].filter(Boolean).join(":"),
    windowSize,
    retentionMs: retentionDays * 86400000,
    retentionSeconds: retentionDays * 86400,
  };
}

function latencyReleaseId(env = {}) {
  const candidates = [
    env.VERCEL_DEPLOYMENT_ID,
    env.PUBLIC_ANSWER_LATENCY_RELEASE_ID,
    env.VERCEL_GIT_COMMIT_SHA,
    env.VERCEL_URL,
  ];
  for (const value of candidates) {
    const id = String(value || "").trim();
    if (/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(id)) return id;
  }
  return "";
}

function summarizeSamples({ profileId, values, nowMs, windowSize, retentionMs }) {
  const cutoff = nowMs - retentionMs;
  const samples = (Array.isArray(values) ? values : [])
    .slice(0, windowSize)
    .map(parseSample)
    .filter((sample) => sample && sample.timestamp >= cutoff && sample.timestamp <= nowMs + 60000);
  if (!samples.length) {
    return {
      profileId,
      status: "no_samples",
      storage: "redis",
      persistent: true,
      averageMs: null,
      sampleCount: 0,
      windowSize,
      lastRecordedAt: null,
    };
  }
  return {
    profileId,
    status: "available",
    storage: "redis",
    persistent: true,
    averageMs: Math.round(samples.reduce((sum, sample) => sum + sample.durationMs, 0) / samples.length),
    sampleCount: samples.length,
    windowSize,
    lastRecordedAt: new Date(Math.max(...samples.map((sample) => sample.timestamp))).toISOString(),
  };
}

function parseSample(value) {
  const match = /^(\d{10,16}):(\d{1,12})$/u.exec(String(value || "").trim());
  if (!match) return null;
  const timestamp = Number(match[1]);
  const durationMs = normalizeDuration(match[2]);
  if (!Number.isFinite(timestamp) || durationMs === null) return null;
  return { timestamp, durationMs };
}

function unavailableStat(profileId, reason, storage = "unconfigured") {
  return {
    profileId: String(profileId || ""),
    status: "unavailable",
    storage,
    persistent: false,
    averageMs: null,
    sampleCount: 0,
    windowSize: DEFAULT_WINDOW_SIZE,
    lastRecordedAt: null,
    reason,
  };
}

function normalizeProfileId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id) ? id : "";
}

function normalizeDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_DURATION_MS) return null;
  return Math.round(number);
}

async function redisCommand(env, fetchImpl, command) {
  const redis = redisConfig(env);
  if (!redis.url || !redis.token) throw new Error("redis_not_configured");
  const timeoutMs = boundedInteger(
    env.PUBLIC_ANSWER_LATENCY_REDIS_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    250,
    5000,
  );
  const response = await withTimeout(fetchImpl(redis.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${redis.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  }), timeoutMs, "public_answer_latency_redis_timeout");
  if (!response?.ok) throw new Error(`redis ${response?.status || "error"}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(String(payload.error));
  return payload?.result;
}

function redisConfig(env = {}) {
  return {
    url: String(
      env.PUBLIC_ANSWER_LATENCY_REDIS_REST_URL
      || env.UPSTASH_REDIS_REST_URL
      || env.KV_REST_API_URL
      || env.REDIS_REST_API_URL
      || "",
    ).trim(),
    token: String(
      env.PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN
      || env.UPSTASH_REDIS_REST_TOKEN
      || env.KV_REST_API_TOKEN
      || env.REDIS_REST_API_TOKEN
      || "",
    ).trim(),
  };
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

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
