import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

const PREFIX = "public-request-rate-limit:v1";
const CONFIG_PREFIX = "PUBLIC_REQUEST_RATE_LIMIT_";

// Redis owns both the clock and the complete read/check/write transaction.
// One sliding log serves all windows for this action, so a rejected request
// never consumes a different window and window boundaries cannot double quota.
export const PUBLIC_REQUEST_RATE_LIMIT_LUA = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local windows = tonumber(ARGV[2])
local longest = 0
for i = 1, windows do
  longest = math.max(longest, tonumber(ARGV[2 * i + 1]))
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - longest)
local remaining = {}
local retry = 0
for i = 1, windows do
  local duration = tonumber(ARGV[2 * i + 1])
  local limit = tonumber(ARGV[2 * i + 2])
  local cutoff = '(' .. string.format('%.0f', now - duration)
  local count = redis.call('ZCOUNT', KEYS[1], cutoff, '+inf')
  remaining[i] = math.max(0, limit - count - 1)
  if count >= limit then
    local oldest = redis.call('ZRANGEBYSCORE', KEYS[1], cutoff, '+inf',
      'WITHSCORES', 'LIMIT', count - limit, 1)
    retry = math.max(retry, tonumber(oldest[2]) + duration - now)
  end
end
if retry > 0 then return {'blocked', retry} end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], longest)
local result = {'allowed', 0}
for i = 1, windows do result[#result + 1] = remaining[i] end
return result
`;

/** Apply before any public paid work, including before starting an SSE response. */
export async function enforcePublicRequestRateLimit({
  request,
  env = process.env,
  action,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  signal?.throwIfAborted();
  // Status only reads an existing capability and must not spend new-question quota.
  if (action === "status") return { ok: true, exempt: true, action: "status" };
  const bucket = actionBucket(action);
  const windows = actionWindows(bucket, env);
  const ip = trustedClientNetwork(request, env);
  if (!ip) throw unavailable("public_request_client_identity_unavailable");
  const config = configuration(env);
  if (typeof fetchImpl !== "function") throw unavailable();
  const digest = createHmac("sha256", config.hmacSecret).update(ip).digest("hex");
  const key = `${PREFIX}:${config.namespace}:${bucket}:${digest}`;
  const command = ["EVAL", PUBLIC_REQUEST_RATE_LIMIT_LUA, 1, key,
    randomBytes(16).toString("hex"), windows.length,
    ...windows.flatMap(({ seconds, limit }) => [seconds * 1000, limit])];
  const result = await redisCommand(config, command, { signal, fetchImpl });
  if (!Array.isArray(result)) throw unavailable();
  if (result.length === 2 && result[0] === "blocked"
      && Number.isSafeInteger(result[1]) && result[1] > 0
      && result[1] <= Math.max(...windows.map(window => window.seconds * 1000))) {
    const error = new Error("Too many requests. Please try again later.");
    error.code = "public_request_rate_limited";
    error.statusCode = 429;
    error.retryAfterSeconds = Math.ceil(result[1] / 1000);
    throw error;
  }
  if (result[0] !== "allowed" || result[1] !== 0 || result.length !== windows.length + 2
      || !windows.every((window, index) => Number.isSafeInteger(result[index + 2])
        && result[index + 2] >= 0 && result[index + 2] < window.limit)) {
    throw unavailable();
  }
  // Never return the raw IP, its persistent pseudonym, or storage configuration.
  return {
    ok: true,
    action: bucket,
    windows: windows.map((window, index) => ({ ...window, remaining: result[index + 2] })),
  };
}

function actionBucket(action) {
  if (action === undefined || action === "answer" || action === "prepare") return "new_question";
  if (action === "finalize") return "finalize";
  if (action === "translate_source") return "translate_source";
  throw unavailable("public_request_rate_limit_action_invalid");
}

function actionWindows(bucket, env) {
  if (bucket === "new_question") return [
    { seconds: 60, limit: positiveInteger(env, "NEW_PER_MINUTE", 6) },
    { seconds: 3600, limit: positiveInteger(env, "NEW_PER_HOUR", 30) },
  ];
  const finalize = bucket === "finalize";
  return [
    { seconds: 60, limit: positiveInteger(env,
      finalize ? "FINALIZE_PER_MINUTE" : "TRANSLATE_PER_MINUTE", 30) },
    { seconds: 3600, limit: positiveInteger(env,
      finalize ? "FINALIZE_PER_HOUR" : "TRANSLATE_PER_HOUR", finalize ? 60 : 120) },
  ];
}

function trustedClientNetwork(request, env) {
  // Vercel's platform header is authoritative only when the server is on Vercel.
  // Never fall back to client-controlled forwarding headers or a request body.
  const raw = String(env.VERCEL || "") === "1"
    ? singleHeader(request?.headers, "x-vercel-forwarded-for")
    : request?.socket?.remoteAddress;
  return canonicalClientNetwork(raw);
}

function singleHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const entries = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length === 1 && typeof entries[0][1] === "string" ? entries[0][1] : null;
}

function canonicalClientNetwork(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const address = value.trim();
  // A single address is required. Reject zone identifiers and forwarding chains.
  if (/[\s%,\[\]]/u.test(address)) return null;
  const family = isIP(address);
  if (family === 4) return `ipv4:${address}`;
  if (family !== 6) return null;
  let expanded = address.toLowerCase();
  if (expanded.includes(".")) {
    const boundary = expanded.lastIndexOf(":");
    const bytes = expanded.slice(boundary + 1).split(".").map(Number);
    expanded = `${expanded.slice(0, boundary + 1)}${(bytes[0] * 256 + bytes[1]).toString(16)}:${(bytes[2] * 256 + bytes[3]).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const words = (halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left).map(word => Number.parseInt(word, 16));
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return `ipv4:${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  }
  return `ipv6:${words.slice(0, 4).map(word => word.toString(16).padStart(4, "0")).join(":")}::/64`;
}

function configuration(env) {
  const url = String(env.PUBLIC_REQUEST_RATE_LIMIT_REDIS_REST_URL
    || env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || env.REDIS_REST_API_URL || "").trim();
  const token = String(env.PUBLIC_REQUEST_RATE_LIMIT_REDIS_REST_TOKEN
    || env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.REDIS_REST_API_TOKEN || "").trim();
  if (!url || !token) throw unavailable();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error();
    }
  } catch { throw unavailable("public_request_rate_limit_configuration_invalid"); }
  const configuredNamespace = String(env.PUBLIC_REQUEST_RATE_LIMIT_NAMESPACE || "").trim();
  // Project/environment survive deploys; a deployment URL/ID must never reset quota.
  const namespace = configuredNamespace || (String(env.VERCEL || "") === "1"
    ? `vercel:${env.VERCEL_PROJECT_ID || "default"}:${env.VERCEL_ENV || "unknown"}`
    : `local:${env.NODE_ENV || "development"}`);
  if (!/^[a-zA-Z0-9:._-]{1,160}$/u.test(namespace)) {
    throw unavailable("public_request_rate_limit_configuration_invalid");
  }
  const timeoutMs = positiveInteger(env, "REDIS_TIMEOUT_MS", 1800);
  if (timeoutMs > 10000) throw unavailable("public_request_rate_limit_configuration_invalid");
  const hmacSecret = String(env.PUBLIC_REQUEST_RATE_LIMIT_HMAC_SECRET || token).trim();
  if (!hmacSecret) throw unavailable("public_request_rate_limit_configuration_invalid");
  return { url, token, hmacSecret, namespace, timeoutMs };
}

function positiveInteger(env, name, fallback) {
  const raw = env[CONFIG_PREFIX + name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (!/^[1-9]\d*$/u.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw unavailable("public_request_rate_limit_configuration_invalid");
  }
  return Number(raw);
}

async function redisCommand(config, command, { signal, fetchImpl }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort(signal.reason);
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(config.url, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response?.ok) throw unavailable();
    const payload = await response.json();
    if (payload?.error) throw unavailable();
    return payload?.result;
  } catch {
    signal?.throwIfAborted();
    // Unknown storage outcomes cannot authorize work; there is deliberately no retry.
    throw unavailable();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function unavailable(code = "public_request_rate_limit_unavailable") {
  const error = new Error("Request protection is temporarily unavailable. Please try again later.");
  error.code = code;
  error.statusCode = 503;
  return error;
}
