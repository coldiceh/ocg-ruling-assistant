import assert from "node:assert/strict";
import test from "node:test";

import { createAdminRiskControlHandler } from "../api/admin-risk-control.js";
import {
  createAdminSessionManager,
  createMemoryAdminSessionStore,
} from "../backend/adminSession.mjs";

const ADMIN_ORIGIN = "https://admin.example.test";

test("admin risk status requires an exact-origin cookie session", async () => {
  let reads = 0;
  const { handler, cookie } = await createHarness({
    login: true,
    readControl: async () => {
      reads += 1;
      return activeStatus();
    },
  });

  let response = createResponse();
  await handler(request({ method: "GET", headers: {} }), response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.payload.error, "admin_session_required");

  response = createResponse();
  await handler(request({
    method: "GET",
    origin: `${ADMIN_ORIGIN}.evil.invalid`,
    headers: { cookie },
  }), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);

  response = createResponse();
  await handler(request({ method: "GET", headers: { cookie } }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.status.active, true);
  assert.equal(reads, 1);
  assert.equal(response.headers["access-control-allow-origin"], ADMIN_ORIGIN);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("admin unlock is POST-only, requires CSRF, and dispatches no other action", async () => {
  let unlocks = 0;
  const { handler, cookie, csrfToken } = await createHarness({
    login: true,
    unlockControl: async () => {
      unlocks += 1;
      return {
        ok: true,
        active: false,
        cleared: true,
        failOpen: false,
        storage: "redis",
        persistent: true,
        activatedAt: null,
        expiresAt: null,
        durationMinutes: 0,
        remainingMinutes: 0,
      };
    },
  });

  let response = createResponse();
  await handler(request({
    method: "POST",
    headers: { cookie },
    body: { action: "unlock" },
  }), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.error, "admin_csrf_invalid");
  assert.equal(unlocks, 0);

  response = createResponse();
  await handler(request({
    method: "POST",
    headers: { cookie, "x-csrf-token": csrfToken },
    body: { action: "lock" },
  }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, "risk_control_action_invalid");
  assert.equal(unlocks, 0);

  response = createResponse();
  await handler(request({
    method: "POST",
    headers: { cookie, "x-csrf-token": csrfToken },
    body: JSON.stringify({ action: "unlock" }),
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.status.cleared, true);
  assert.equal(unlocks, 1);
});

test("admin API reports durable-store failure without exposing configuration", async () => {
  const { handler, cookie } = await createHarness({
    login: true,
    readControl: async () => ({
      ok: false,
      active: false,
      failOpen: true,
      storage: "unavailable",
      persistent: false,
      reason: "storage_unavailable",
    }),
  });
  const response = createResponse();
  await handler(request({ method: "GET", headers: { cookie } }), response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.failOpen, true);
  assert.equal(response.payload.status.active, false);
  assert.equal(JSON.stringify(response.payload).includes("token"), false);
  assert.equal(JSON.stringify(response.payload).includes("redis.example"), false);
});

async function createHarness({ login = false, readControl, unlockControl } = {}) {
  const env = {
    ADMIN_ALLOWED_ORIGIN: ADMIN_ORIGIN,
    ADMIN_SESSION_PASSWORD: "owner-secret",
  };
  const manager = createAdminSessionManager({
    env,
    store: createMemoryAdminSessionStore(),
  });
  const handler = createAdminRiskControlHandler({
    env,
    manager,
    readControl,
    unlockControl,
  });
  if (!login) return { handler, manager };
  const session = await manager.login({
    request: request({ method: "POST" }),
    body: { password: env.ADMIN_SESSION_PASSWORD },
  });
  assert.equal(session.ok, true);
  return {
    handler,
    manager,
    cookie: String(session.setCookie).split(";", 1)[0],
    csrfToken: session.csrfToken,
  };
}

function activeStatus() {
  return {
    ok: true,
    active: true,
    failOpen: false,
    storage: "redis",
    persistent: true,
    activatedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-14T00:12:00.000Z",
    durationMinutes: 12,
    remainingMinutes: 9,
  };
}

function request({ method, origin = ADMIN_ORIGIN, headers = {}, body } = {}) {
  return {
    method,
    url: "/api/admin-risk-control",
    headers: {
      origin,
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body,
  };
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
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
      return this;
    },
  };
}
