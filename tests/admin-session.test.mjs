import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SESSION_COOKIE_NAME,
  constantTimeSecretEqual,
  createConfiguredAdminSessionStore,
  createAdminSessionManager,
  createMemoryAdminSessionStore,
  createRedisAdminSessionStore,
} from "../backend/adminSession.mjs";
import { createAdminAuthHandler } from "../api/admin-auth.js";

const ADMIN_ORIGIN = "https://admin.example.test";

test("admin login, session validation, CSRF-protected logout, and secure cookie lifecycle", async () => {
  let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const env = adminEnv();
  const store = createMemoryAdminSessionStore({ now });
  const handler = createAdminAuthHandler({
    manager: createAdminSessionManager({ env, store, now }),
  });

  const login = createJsonResponse();
  await handler(adminRequest({
    method: "POST",
    body: { action: "login", password: env.ADMIN_SESSION_PASSWORD },
  }), login);

  assert.equal(login.statusCode, 200);
  assert.equal(login.payload.ok, true);
  assert.equal(login.payload.authenticated, true);
  assert.match(login.payload.csrfToken, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(login.headers["access-control-allow-origin"], ADMIN_ORIGIN);
  assert.equal(login.headers["access-control-allow-credentials"], "true");
  assert.equal(login.headers["cache-control"], "no-store");
  assert.match(login.headers["set-cookie"], new RegExp(`^${ADMIN_SESSION_COOKIE_NAME}=`));
  assert.match(login.headers["set-cookie"], /;\s*Path=\//iu);
  assert.match(login.headers["set-cookie"], /;\s*HttpOnly/iu);
  assert.match(login.headers["set-cookie"], /;\s*Secure/iu);
  assert.match(login.headers["set-cookie"], /;\s*SameSite=None/iu);
  assert.doesNotMatch(login.headers["set-cookie"], new RegExp(env.ADMIN_SESSION_PASSWORD, "u"));

  const cookie = cookiePair(login.headers["set-cookie"]);
  const session = createJsonResponse();
  await handler(adminRequest({
    method: "GET",
    headers: { cookie },
  }), session);
  assert.equal(session.statusCode, 200);
  assert.equal(session.payload.authenticated, true);
  assert.equal(session.payload.csrfToken, login.payload.csrfToken);

  const missingCsrf = createJsonResponse();
  await handler(adminRequest({
    method: "POST",
    headers: { cookie },
    body: { action: "logout" },
  }), missingCsrf);
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(missingCsrf.payload.error, "admin_csrf_invalid");

  const stillActive = createJsonResponse();
  await handler(adminRequest({
    method: "GET",
    headers: { cookie },
  }), stillActive);
  assert.equal(stillActive.statusCode, 200);

  const logout = createJsonResponse();
  await handler(adminRequest({
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": login.payload.csrfToken,
    },
    body: { action: "logout" },
  }), logout);
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.payload.authenticated, false);
  assert.match(logout.headers["set-cookie"], new RegExp(`^${ADMIN_SESSION_COOKIE_NAME}=;`));
  assert.match(logout.headers["set-cookie"], /Max-Age=0/iu);
  assert.match(logout.headers["set-cookie"], /HttpOnly/iu);
  assert.match(logout.headers["set-cookie"], /Secure/iu);
  assert.match(logout.headers["set-cookie"], /SameSite=None/iu);

  const afterLogout = createJsonResponse();
  await handler(adminRequest({
    method: "GET",
    headers: { cookie },
  }), afterLogout);
  assert.equal(afterLogout.statusCode, 401);
  assert.equal(afterLogout.payload.authenticated, false);
});

test("admin session expires and cannot be revived by an old cookie", async () => {
  let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const env = adminEnv({
    ADMIN_SESSION_TTL_SECONDS: "60",
  });
  const store = createMemoryAdminSessionStore({ now });
  const handler = createAdminAuthHandler({
    manager: createAdminSessionManager({ env, store, now }),
  });

  const login = createJsonResponse();
  await handler(adminRequest({
    method: "POST",
    body: { action: "login", password: env.ADMIN_SESSION_PASSWORD },
  }), login);
  assert.equal(login.statusCode, 200);

  nowMs += 60_001;
  const expired = createJsonResponse();
  await handler(adminRequest({
    method: "GET",
    headers: { cookie: cookiePair(login.headers["set-cookie"]) },
  }), expired);
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.payload.authenticated, false);
  assert.match(expired.payload.error, /^admin_session_(?:invalid|expired)$/u);
});

test("admin origin is an exact allow-list match and query parameters never authenticate", async () => {
  const env = adminEnv();
  const store = createMemoryAdminSessionStore();
  const handler = createAdminAuthHandler({
    manager: createAdminSessionManager({ env, store }),
  });

  for (const origin of [
    "",
    `${ADMIN_ORIGIN}.evil.invalid`,
    `${ADMIN_ORIGIN}/`,
    "null",
  ]) {
    const response = createJsonResponse();
    await handler({
      method: "POST",
      headers: origin ? { origin } : {},
      body: { action: "login", password: env.ADMIN_SESSION_PASSWORD },
    }, response);
    assert.equal(response.statusCode, 403, origin || "missing origin");
    assert.equal(response.payload.ok, false);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }

  const queryOnly = createJsonResponse();
  await handler(adminRequest({
    method: "GET",
    url: "/api/admin-auth?admin=1",
  }), queryOnly);
  assert.equal(queryOnly.statusCode, 401);
  assert.equal(queryOnly.payload.error, "admin_session_required");
});

test("admin origin never falls back to the public API origin", async () => {
  const publicOnlyEnv = {
    ADMIN_SESSION_PASSWORD: "owner-secret",
    ALLOWED_ORIGIN: ADMIN_ORIGIN,
  };
  const handler = createAdminAuthHandler({
    manager: createAdminSessionManager({
      env: publicOnlyEnv,
      store: createMemoryAdminSessionStore(),
    }),
  });
  const response = createJsonResponse();

  await handler(adminRequest({
    method: "POST",
    body: { action: "login", password: publicOnlyEnv.ADMIN_SESSION_PASSWORD },
  }), response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error, "admin_origin_not_configured");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("admin login rate limit is enforced per origin and client, then expires", async () => {
  let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const env = adminEnv({
    ADMIN_LOGIN_MAX_ATTEMPTS: "2",
    ADMIN_LOGIN_WINDOW_SECONDS: "30",
  });
  const store = createMemoryAdminSessionStore({ now });
  const handler = createAdminAuthHandler({
    manager: createAdminSessionManager({ env, store, now }),
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const invalid = createJsonResponse();
    await handler(adminRequest({
      method: "POST",
      body: { action: "login", password: "wrong" },
    }), invalid);
    assert.equal(invalid.statusCode, 401);
  }

  const blocked = createJsonResponse();
  await handler(adminRequest({
    method: "POST",
    body: { action: "login", password: env.ADMIN_SESSION_PASSWORD },
  }), blocked);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.error, "admin_login_rate_limited");
  assert.equal(blocked.headers["retry-after"], "30");

  nowMs += 30_001;
  const afterWindow = createJsonResponse();
  await handler(adminRequest({
    method: "POST",
    body: { action: "login", password: env.ADMIN_SESSION_PASSWORD },
  }), afterWindow);
  assert.equal(afterWindow.statusCode, 200);
});

test("secret comparison handles equal and unequal values without length-dependent comparison", () => {
  assert.equal(constantTimeSecretEqual("same secret", "same secret"), true);
  assert.equal(constantTimeSecretEqual("same secret", "different"), false);
  assert.equal(constantTimeSecretEqual("short", "a much longer supplied secret"), false);
});

test("configured session memory requires mode plus code opt-in and a shared manager keeps the session", async () => {
  const env = adminEnv({ ADMIN_SESSION_STORAGE: "memory" });
  assert.throws(
    () => createConfiguredAdminSessionStore({ env }),
    (error) => error?.code === "admin_session_memory_forbidden",
  );
  const store = createConfiguredAdminSessionStore({
    env,
    allowMemoryStore: true,
  });
  assert.equal(store.kind, "memory");
  assert.equal(store.persistent, false);

  const manager = createAdminSessionManager({ env, store });
  const loginHandler = createAdminAuthHandler({ manager });
  const sessionHandler = createAdminAuthHandler({ manager });
  const login = createJsonResponse();
  await loginHandler(adminRequest({
    method: "POST",
    body: { action: "login", password: env.ADMIN_SESSION_PASSWORD },
  }), login);
  assert.equal(login.statusCode, 200);

  const session = createJsonResponse();
  await sessionHandler(adminRequest({
    method: "GET",
    headers: { cookie: cookiePair(login.headers["set-cookie"]) },
  }), session);
  assert.equal(session.statusCode, 200);
  assert.equal(session.payload.authenticated, true);
  assert.equal(manager.persistence.persistent, false);
});

test("Redis session store uses injected transport and expiring namespaced records", async () => {
  const requests = [];
  const results = [
    "OK",
    JSON.stringify({ expiresAt: "2026-07-27T00:15:00.000Z", csrfToken: "csrf", origin: ADMIN_ORIGIN }),
    1,
    1,
    1,
    47,
    1,
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, command: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: results.shift() }),
    };
  };
  const store = createRedisAdminSessionStore({
    env: {
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "redis-secret",
      ADMIN_SESSION_REDIS_PREFIX: "test-admin",
    },
    fetchImpl,
  });

  const record = {
    expiresAt: "2026-07-27T00:15:00.000Z",
    csrfToken: "csrf",
    origin: ADMIN_ORIGIN,
  };
  await store.setSession("hashed-token", record, 900);
  assert.deepEqual(await store.getSession("hashed-token"), record);
  await store.deleteSession("hashed-token");
  assert.deepEqual(await store.incrementLoginAttempt("hashed-client", 60), {
    count: 1,
    retryAfterSeconds: 47,
  });
  await store.clearLoginAttempts("hashed-client");

  assert.deepEqual(requests.map((item) => item.command), [
    ["SET", "test-admin:session:hashed-token", JSON.stringify(record), "EX", "900"],
    ["GET", "test-admin:session:hashed-token"],
    ["DEL", "test-admin:session:hashed-token"],
    ["INCR", "test-admin:login:hashed-client"],
    ["EXPIRE", "test-admin:login:hashed-client", "60"],
    ["TTL", "test-admin:login:hashed-client"],
    ["DEL", "test-admin:login:hashed-client"],
  ]);
  assert.ok(requests.every((item) => item.url === "https://redis.example.test"));
  assert.ok(requests.every((item) => item.init.headers.authorization === "Bearer redis-secret"));
});

function adminEnv(overrides = {}) {
  return {
    ADMIN_ALLOWED_ORIGIN: ADMIN_ORIGIN,
    ADMIN_SESSION_PASSWORD: "correct horse battery staple",
    ADMIN_SESSION_TTL_SECONDS: "120",
    ...overrides,
  };
}

function adminRequest({
  method,
  url = "/api/admin-auth",
  headers = {},
  body,
} = {}) {
  return {
    method,
    url,
    headers: {
      origin: ADMIN_ORIGIN,
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body,
  };
}

function cookiePair(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}
