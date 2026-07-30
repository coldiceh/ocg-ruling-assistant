import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ADMIN_SESSION_COOKIE_NAME = "__Host-ocg_admin_session";

const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const DEFAULT_LOGIN_WINDOW_SECONDS = 10 * 60;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_REDIS_TIMEOUT_MS = 1800;
const DEFAULT_REDIS_PREFIX = "ocg-admin:v1";

export function createAdminSessionManager({
  env = globalThis.process?.env || {},
  store,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  allowMemoryStore = false,
} = {}) {
  const sessionStore = store || createConfiguredAdminSessionStore({
    env,
    fetchImpl,
    now,
    allowMemoryStore,
  });
  const sessionTtlSeconds = boundedInteger(
    env.ADMIN_SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS,
    60,
    60 * 60,
  );
  const loginWindowSeconds = boundedInteger(
    env.ADMIN_LOGIN_WINDOW_SECONDS,
    DEFAULT_LOGIN_WINDOW_SECONDS,
    30,
    60 * 60,
  );
  const loginMaxAttempts = boundedInteger(
    env.ADMIN_LOGIN_MAX_ATTEMPTS,
    DEFAULT_LOGIN_MAX_ATTEMPTS,
    1,
    20,
  );

  return Object.freeze({
    persistence: Object.freeze({
      kind: String(sessionStore?.kind || "unknown"),
      persistent: sessionStore?.persistent === true,
    }),

    checkOrigin(request) {
      return inspectAdminRequestOrigin(request, env);
    },

    async login({ request, body = {} } = {}) {
      const origin = inspectAdminRequestOrigin(request, env);
      if (!origin.ok) return originFailure(origin);

      const configuredPassword = configuredAdminPassword(env);
      if (!configuredPassword) {
        return failure(503, "admin_session_password_not_configured", "Admin session login is disabled.");
      }

      const rateKey = hashToken(`${origin.origin}\u0000${clientIdentity(request)}`);
      let attempt;
      try {
        attempt = await sessionStore.incrementLoginAttempt(rateKey, loginWindowSeconds);
      } catch {
        return failure(503, "admin_session_storage_unavailable", "Admin session storage is unavailable.");
      }
      if (Number(attempt?.count || attempt) > loginMaxAttempts) {
        return {
          ...failure(429, "admin_login_rate_limited", "Too many admin login attempts."),
          retryAfterSeconds: positiveInteger(attempt?.retryAfterSeconds) || loginWindowSeconds,
        };
      }

      const suppliedPassword = String(body.password || body.adminPassword || "");
      if (!constantTimeSecretEqual(suppliedPassword, configuredPassword)) {
        return failure(401, "admin_login_invalid", "Admin login failed.");
      }

      const issuedAt = currentTime(now);
      const expiresAt = new Date(issuedAt.getTime() + sessionTtlSeconds * 1000);
      const sessionToken = secureToken(randomBytesImpl);
      const csrfToken = secureToken(randomBytesImpl);
      const sessionKey = hashToken(sessionToken);
      const record = {
        version: 1,
        createdAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        csrfToken,
        origin: origin.origin,
      };

      try {
        await sessionStore.setSession(sessionKey, record, sessionTtlSeconds);
        await sessionStore.clearLoginAttempts(rateKey);
      } catch {
        return failure(503, "admin_session_storage_unavailable", "Admin session storage is unavailable.");
      }

      return {
        ok: true,
        status: 200,
        authenticated: true,
        origin: origin.origin,
        expiresAt: record.expiresAt,
        csrfToken,
        setCookie: buildAdminSessionCookie(sessionToken, sessionTtlSeconds),
      };
    },

    async session({ request } = {}) {
      const authorization = await authorizeSession({
        request,
        env,
        store: sessionStore,
        now,
        requireCsrf: false,
      });
      if (!authorization.ok) return authorization;
      return {
        ok: true,
        status: 200,
        authenticated: true,
        origin: authorization.origin,
        expiresAt: authorization.session.expiresAt,
        csrfToken: authorization.session.csrfToken,
      };
    },

    async authorize({ request, requireCsrf = true } = {}) {
      return authorizeSession({
        request,
        env,
        store: sessionStore,
        now,
        requireCsrf,
      });
    },

    async logout({ request } = {}) {
      const authorization = await authorizeSession({
        request,
        env,
        store: sessionStore,
        now,
        requireCsrf: true,
      });
      if (!authorization.ok) return authorization;
      try {
        await sessionStore.deleteSession(authorization.sessionKey);
      } catch {
        return failure(503, "admin_session_storage_unavailable", "Admin session storage is unavailable.");
      }
      return {
        ok: true,
        status: 200,
        authenticated: false,
        origin: authorization.origin,
        clearCookie: clearAdminSessionCookie(),
      };
    },
  });
}

export function createConfiguredAdminSessionStore({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  allowMemoryStore = false,
} = {}) {
  const requestedMode = String(env.ADMIN_SESSION_STORAGE || "redis")
    .trim()
    .toLowerCase();
  if (requestedMode === "memory") {
    if (allowMemoryStore !== true) throw memoryStoreForbidden();
    return createMemoryAdminSessionStore({ now });
  }
  if (!["auto", "redis", "redis-rest", "upstash", "kv"].includes(requestedMode)) {
    throw new RangeError(`unsupported admin session storage mode: ${requestedMode || "(empty)"}`);
  }
  const redis = redisConfiguration(env);
  if (redis.url && redis.token && typeof fetchImpl === "function") {
    return createRedisAdminSessionStore({ env, fetchImpl });
  }
  return unavailableStore();
}

export function createMemoryAdminSessionStore({ now = () => new Date() } = {}) {
  const sessions = new Map();
  const loginAttempts = new Map();

  return Object.freeze({
    kind: "memory",
    persistent: false,
    async getSession(key) {
      const item = sessions.get(String(key));
      if (!item) return null;
      if (item.expiresAtMs <= currentTime(now).getTime()) {
        sessions.delete(String(key));
        return null;
      }
      return clone(item.value);
    },
    async setSession(key, value, ttlSeconds) {
      sessions.set(String(key), {
        value: clone(value),
        expiresAtMs: currentTime(now).getTime() + positiveInteger(ttlSeconds) * 1000,
      });
    },
    async deleteSession(key) {
      sessions.delete(String(key));
    },
    async incrementLoginAttempt(key, ttlSeconds) {
      const id = String(key);
      const current = loginAttempts.get(id);
      const currentMs = currentTime(now).getTime();
      const expiresAtMs = current?.expiresAtMs > currentMs
        ? current.expiresAtMs
        : currentMs + positiveInteger(ttlSeconds) * 1000;
      const count = current?.expiresAtMs > currentMs ? current.count + 1 : 1;
      loginAttempts.set(id, { count, expiresAtMs });
      return {
        count,
        retryAfterSeconds: Math.max(1, Math.ceil((expiresAtMs - currentMs) / 1000)),
      };
    },
    async clearLoginAttempts(key) {
      loginAttempts.delete(String(key));
    },
  });
}

export function createRedisAdminSessionStore({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const redis = redisConfiguration(env);
  if (!redis.url || !redis.token || typeof fetchImpl !== "function") return unavailableStore();
  const prefix = String(env.ADMIN_SESSION_REDIS_PREFIX || DEFAULT_REDIS_PREFIX).trim() || DEFAULT_REDIS_PREFIX;

  return Object.freeze({
    kind: "redis-rest",
    persistent: true,
    async getSession(key) {
      const value = await redisCommand(redis, fetchImpl, ["GET", `${prefix}:session:${key}`]);
      if (!value) return null;
      try {
        return JSON.parse(String(value));
      } catch {
        return null;
      }
    },
    async setSession(key, value, ttlSeconds) {
      await redisCommand(redis, fetchImpl, [
        "SET",
        `${prefix}:session:${key}`,
        JSON.stringify(value),
        "EX",
        String(positiveInteger(ttlSeconds)),
      ]);
    },
    async deleteSession(key) {
      await redisCommand(redis, fetchImpl, ["DEL", `${prefix}:session:${key}`]);
    },
    async incrementLoginAttempt(key, ttlSeconds) {
      const redisKey = `${prefix}:login:${key}`;
      const count = Number(await redisCommand(redis, fetchImpl, ["INCR", redisKey]));
      if (count === 1) {
        await redisCommand(redis, fetchImpl, ["EXPIRE", redisKey, String(positiveInteger(ttlSeconds))]);
      }
      const remaining = Number(await redisCommand(redis, fetchImpl, ["TTL", redisKey]));
      return {
        count,
        retryAfterSeconds: remaining > 0 ? remaining : positiveInteger(ttlSeconds),
      };
    },
    async clearLoginAttempts(key) {
      await redisCommand(redis, fetchImpl, ["DEL", `${prefix}:login:${key}`]);
    },
  });
}

export function inspectAdminRequestOrigin(request, env = globalThis.process?.env || {}) {
  const allowedOrigins = configuredAdminOrigins(env);
  if (!allowedOrigins.length) {
    return {
      ok: false,
      status: 503,
      error: "admin_origin_not_configured",
      message: "Admin allowed origin is not configured.",
      origin: "",
    };
  }
  const rawOrigin = readHeader(request, "origin");
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) {
    return {
      ok: false,
      status: 403,
      error: "admin_origin_required",
      message: "Admin requests require an Origin header.",
      origin: "",
    };
  }
  if (!allowedOrigins.includes(origin) || rawOrigin !== origin) {
    return {
      ok: false,
      status: 403,
      error: "admin_origin_forbidden",
      message: "Admin request origin is not allowed.",
      origin,
    };
  }
  return { ok: true, status: 200, origin, allowedOrigins };
}

export function configuredAdminOrigins(env = globalThis.process?.env || {}) {
  const raw = String(
    env.ADMIN_ALLOWED_ORIGINS
    || env.ADMIN_ALLOWED_ORIGIN
    || "",
  );
  return [...new Set(raw
    .split(",")
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value) => value && value !== "*"))];
}

export function constantTimeSecretEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function buildAdminSessionCookie(token, maxAgeSeconds) {
  return [
    `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(String(token))}`,
    "Path=/",
    `Max-Age=${positiveInteger(maxAgeSeconds)}`,
    "HttpOnly",
    "Secure",
    "SameSite=None",
  ].join("; ");
}

export function clearAdminSessionCookie() {
  return [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "Secure",
    "SameSite=None",
  ].join("; ");
}

async function authorizeSession({
  request,
  env,
  store,
  now,
  requireCsrf,
}) {
  const origin = inspectAdminRequestOrigin(request, env);
  if (!origin.ok) return originFailure(origin);
  const sessionToken = readCookie(request, ADMIN_SESSION_COOKIE_NAME);
  if (!sessionToken) {
    return failure(401, "admin_session_required", "Admin session is required.");
  }
  const sessionKey = hashToken(sessionToken);
  let session;
  try {
    session = await store.getSession(sessionKey);
  } catch {
    return failure(503, "admin_session_storage_unavailable", "Admin session storage is unavailable.");
  }
  if (!session) return failure(401, "admin_session_invalid", "Admin session is invalid or expired.");

  const expiresAtMs = Date.parse(String(session.expiresAt || ""));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= currentTime(now).getTime()) {
    await store.deleteSession(sessionKey).catch(() => {});
    return failure(401, "admin_session_expired", "Admin session has expired.");
  }
  if (session.origin !== origin.origin) {
    return failure(403, "admin_session_origin_mismatch", "Admin session origin does not match.");
  }
  if (requireCsrf) {
    const csrf = readHeader(request, "x-csrf-token");
    if (!csrf || !constantTimeSecretEqual(csrf, session.csrfToken || "")) {
      return failure(403, "admin_csrf_invalid", "Admin CSRF token is missing or invalid.");
    }
  }
  return {
    ok: true,
    status: 200,
    authenticated: true,
    origin: origin.origin,
    sessionKey,
    session: clone(session),
  };
}

function configuredAdminPassword(env) {
  return String(env.ADMIN_SESSION_PASSWORD || env.API_ADMIN_PASSWORD || "");
}

function clientIdentity(request) {
  const forwarded = readHeader(request, "x-forwarded-for").split(",")[0].trim();
  return forwarded
    || readHeader(request, "x-real-ip")
    || String(request?.socket?.remoteAddress || request?.connection?.remoteAddress || "unknown");
}

function readCookie(request, name) {
  const cookie = readHeader(request, "cookie");
  for (const segment of cookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function readHeader(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}

function normalizeOrigin(value) {
  const text = String(value || "").trim();
  if (!text || text === "*" || text === "null") return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.origin !== text) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function secureToken(randomBytesImpl) {
  const bytes = randomBytesImpl(32);
  return Buffer.from(bytes).toString("base64url");
}

function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function currentTime(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function originFailure(origin) {
  return failure(origin.status, origin.error, origin.message);
}

function failure(status, error, message) {
  return { ok: false, status, error, message, authenticated: false };
}

function unavailableStore() {
  const unavailable = async () => {
    throw new Error("admin_session_storage_unavailable");
  };
  return Object.freeze({
    kind: "unavailable",
    persistent: false,
    getSession: unavailable,
    setSession: unavailable,
    deleteSession: unavailable,
    incrementLoginAttempt: unavailable,
    clearLoginAttempts: unavailable,
  });
}

function memoryStoreForbidden() {
  const error = new Error("memory admin session storage requires explicit local/test opt-in");
  error.code = "admin_session_memory_forbidden";
  return error;
}

async function redisCommand(redis, fetchImpl, command) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), redis.timeoutMs);
  try {
    const response = await fetchImpl(redis.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${redis.token}`,
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

function redisConfiguration(env) {
  return {
    url: String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || env.REDIS_REST_API_URL || "").trim(),
    token: String(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.REDIS_REST_API_TOKEN || "").trim(),
    timeoutMs: boundedInteger(
      env.ADMIN_SESSION_REDIS_TIMEOUT_MS,
      DEFAULT_REDIS_TIMEOUT_MS,
      250,
      5000,
    ),
  };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
