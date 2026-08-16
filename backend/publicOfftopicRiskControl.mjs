import { randomInt as cryptoRandomInt } from "node:crypto";
import { formatAuthorContactSentence } from "./publicAnswerPresentation.mjs";

const DEFAULT_REDIS_KEY_PREFIX = "rag-public-offtopic-risk-control:v1";
const DEFAULT_MIN_DURATION_MINUTES = 5;
const DEFAULT_MAX_DURATION_MINUTES = 60;
const DEFAULT_REDIS_TIMEOUT_MS = 1200;
const MAX_REDIS_TIMEOUT_MS = 5000;

export function publicOfftopicRiskControlStorageStatus(
  env = globalThis.process?.env || {},
) {
  if (isDisabled(env.PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED)) {
    return {
      enabled: false,
      storage: "disabled",
      persistent: false,
      failOpen: true,
    };
  }
  const redis = redisConfiguration(env);
  if (!redis.url || !redis.token) {
    return {
      enabled: false,
      storage: "unconfigured",
      persistent: false,
      failOpen: true,
    };
  }
  return {
    enabled: true,
    storage: "redis",
    persistent: true,
    failOpen: false,
  };
}

export async function readPublicOfftopicRiskControl({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const context = riskControlContext(env, fetchImpl);
  if (!context.ok) return failOpenStatus(context.reason, context.storage);

  try {
    const stored = await redisCommand(context, ["GET", context.lockKey]);
    return activeStatusFromStoredValue(stored, currentTimeMs(now));
  } catch {
    return failOpenStatus("storage_unavailable", "unavailable");
  }
}

export async function activatePublicOfftopicRiskControl({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  randomInt = cryptoRandomInt,
  durationMinutes,
} = {}) {
  const context = riskControlContext(env, fetchImpl);
  if (!context.ok) return failOpenStatus(context.reason, context.storage, { triggered: false });

  const nowMs = currentTimeMs(now);
  const duration = normalizeDurationMinutes(durationMinutes, randomInt);
  const ttlSeconds = duration * 60;
  const record = Object.freeze({
    version: 1,
    activatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
    durationMinutes: duration,
  });

  try {
    const result = await redisCommand(context, [
      "SET",
      context.lockKey,
      JSON.stringify(record),
      "NX",
      "EX",
      String(ttlSeconds),
    ]);
    if (result === "OK" || result === true) {
      return {
        ok: true,
        active: true,
        triggered: true,
        failOpen: false,
        storage: "redis",
        persistent: true,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        durationMinutes: duration,
        remainingMinutes: duration,
      };
    }
    if (result !== null && result !== undefined && result !== false) {
      return failOpenStatus("storage_unavailable", "unavailable", { triggered: false });
    }

    // SET NX is the only lock write. Reading the winning record reports the
    // current lock without refreshing its TTL, even when requests race.
    const stored = await redisCommand(context, ["GET", context.lockKey]);
    const status = activeStatusFromStoredValue(stored, nowMs);
    return {
      ...status,
      triggered: false,
    };
  } catch {
    return failOpenStatus("storage_unavailable", "unavailable", { triggered: false });
  }
}

export async function clearPublicOfftopicRiskControl({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const context = riskControlContext(env, fetchImpl);
  if (!context.ok) return failOpenStatus(context.reason, context.storage, { cleared: false });

  try {
    const deleted = Number(await redisCommand(context, [
      "DEL",
      context.lockKey,
    ]));
    return {
      ok: true,
      active: false,
      cleared: Number.isFinite(deleted) && deleted > 0,
      failOpen: false,
      storage: "redis",
      persistent: true,
      activatedAt: null,
      expiresAt: null,
      durationMinutes: 0,
      remainingMinutes: 0,
    };
  } catch {
    return failOpenStatus("storage_unavailable", "unavailable", { cleared: false });
  }
}

export const unlockPublicOfftopicRiskControl = clearPublicOfftopicRiskControl;

export function buildPublicOfftopicRiskControlAnswer({
  status = {},
  triggered = status.triggered === true,
  env = globalThis.process?.env || {},
} = {}) {
  const minutes = Math.max(1, boundedInteger(status.remainingMinutes, 1, 1, 60));
  const contact = formatAuthorContactSentence("如需提前解除，请联系作者", env);
  const shortAnswer = triggered
    ? `检测到非游戏王规则／裁定相关问题，系统自动关闭 ${minutes} 分钟。${contact}`
    : `因有人提交非游戏王规则／裁定相关问题，系统暂时停止回答，预计还需 ${minutes} 分钟。${contact}`;
  return {
    answerLevel: "risk_control",
    shortAnswer,
    reasoning: ["本次请求未调用裁定模型。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: ["public_offtopic_risk_control"],
    confidenceSelfEstimate: "high",
  };
}

function activeStatusFromStoredValue(value, nowMs) {
  if (value === null || value === undefined || value === "") return inactiveStatus();
  const record = parseStoredRecord(value);
  if (!record) return failOpenStatus("storage_record_invalid", "unavailable");
  const expiresAtMs = Date.parse(record.expiresAt);
  if (expiresAtMs <= nowMs) return inactiveStatus();
  return {
    ok: true,
    active: true,
    failOpen: false,
    storage: "redis",
    persistent: true,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    durationMinutes: record.durationMinutes,
    remainingMinutes: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 60000)),
  };
}

function inactiveStatus() {
  return {
    ok: true,
    active: false,
    failOpen: false,
    storage: "redis",
    persistent: true,
    activatedAt: null,
    expiresAt: null,
    durationMinutes: 0,
    remainingMinutes: 0,
  };
}

function failOpenStatus(reason, storage, extra = {}) {
  return {
    ok: false,
    active: false,
    failOpen: true,
    storage,
    persistent: false,
    reason,
    activatedAt: null,
    expiresAt: null,
    durationMinutes: 0,
    remainingMinutes: 0,
    ...extra,
  };
}

function parseStoredRecord(value) {
  try {
    const parsed = JSON.parse(String(value));
    const activatedAt = String(parsed?.activatedAt || "");
    const expiresAt = String(parsed?.expiresAt || "");
    const activatedAtMs = Date.parse(activatedAt);
    const expiresAtMs = Date.parse(expiresAt);
    const durationMinutes = Number(parsed?.durationMinutes);
    if (
      parsed?.version !== 1
      || !Number.isInteger(durationMinutes)
      || durationMinutes < DEFAULT_MIN_DURATION_MINUTES
      || durationMinutes > DEFAULT_MAX_DURATION_MINUTES
      || !Number.isFinite(activatedAtMs)
      || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= activatedAtMs
    ) return null;
    return { activatedAt, expiresAt, durationMinutes };
  } catch {
    return null;
  }
}

function riskControlContext(env, fetchImpl) {
  const status = publicOfftopicRiskControlStorageStatus(env);
  if (!status.enabled) {
    return { ok: false, storage: status.storage, reason: `storage_${status.storage}` };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, storage: "unavailable", reason: "fetch_unavailable" };
  }
  const redis = redisConfiguration(env);
  return {
    ok: true,
    ...redis,
    fetchImpl,
    ...publicOfftopicRiskControlRedisKeys(env),
  };
}

export function publicOfftopicRiskControlRedisKeys(env = {}) {
  const prefix = normalizeRedisKeyPrefix(
    env.PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_KEY_PREFIX
      || env.PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_KEY,
  );
  const namespace = deploymentNamespace(env);
  const namespacedPrefix = `${prefix}:${namespace}`;
  return {
    namespace,
    lockKey: `${namespacedPrefix}:lock`,
  };
}

async function redisCommand(context, command) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const response = await context.fetchImpl(context.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`redis ${response?.status || "error"}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(String(payload.error));
    return payload?.result;
  } finally {
    clearTimeout(timeout);
  }
}

function redisConfiguration(env = {}) {
  return {
    url: String(
      env.PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_REST_URL
      || env.UPSTASH_REDIS_REST_URL
      || env.KV_REST_API_URL
      || env.REDIS_REST_API_URL
      || "",
    ).trim(),
    token: String(
      env.PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_REST_TOKEN
      || env.UPSTASH_REDIS_REST_TOKEN
      || env.KV_REST_API_TOKEN
      || env.REDIS_REST_API_TOKEN
      || "",
    ).trim(),
    timeoutMs: boundedInteger(
      env.PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_TIMEOUT_MS,
      DEFAULT_REDIS_TIMEOUT_MS,
      250,
      MAX_REDIS_TIMEOUT_MS,
    ),
  };
}

function normalizeRedisKeyPrefix(value) {
  const key = String(value || DEFAULT_REDIS_KEY_PREFIX).trim() || DEFAULT_REDIS_KEY_PREFIX;
  if (key.length > 120 || /[{}\r\n]/u.test(key)) return DEFAULT_REDIS_KEY_PREFIX;
  return key.replace(/:+$/u, "") || DEFAULT_REDIS_KEY_PREFIX;
}

function deploymentNamespace(env = {}) {
  const vercelEnvironment = String(env.VERCEL_ENV || "").trim().toLowerCase();
  if (["production", "preview", "development"].includes(vercelEnvironment)) {
    return `vercel-${vercelEnvironment}`;
  }
  if (/^(?:1|true|yes|on)$/iu.test(String(env.VERCEL || "").trim())) {
    return "vercel-unknown";
  }
  const configured = normalizeNamespaceSegment(
    env.PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_NAMESPACE,
  );
  if (configured) return configured;
  return String(env.NODE_ENV || "").trim().toLowerCase() === "production"
    ? "production"
    : "development";
}

function normalizeNamespaceSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
}

function normalizeDurationMinutes(value, randomInt) {
  const supplied = Number(value);
  if (Number.isInteger(supplied)) {
    return Math.max(
      DEFAULT_MIN_DURATION_MINUTES,
      Math.min(DEFAULT_MAX_DURATION_MINUTES, supplied),
    );
  }
  if (typeof randomInt !== "function") return DEFAULT_MIN_DURATION_MINUTES;
  let generated;
  try {
    generated = Number(randomInt(
      DEFAULT_MIN_DURATION_MINUTES,
      DEFAULT_MAX_DURATION_MINUTES + 1,
    ));
  } catch {
    return DEFAULT_MIN_DURATION_MINUTES;
  }
  if (!Number.isInteger(generated)) return DEFAULT_MIN_DURATION_MINUTES;
  return Math.max(
    DEFAULT_MIN_DURATION_MINUTES,
    Math.min(DEFAULT_MAX_DURATION_MINUTES, generated),
  );
}

function currentTimeMs(now) {
  try {
    const value = typeof now === "function" ? now() : now;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  } catch {
    return Date.now();
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function isDisabled(value) {
  return /^(?:0|false|off|no)$/iu.test(String(value || "").trim());
}
