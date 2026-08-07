import assert from "node:assert/strict";
import test from "node:test";

import { createAdminModelLabHandler } from "../api/admin-model-lab.js";
import {
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionManager,
  createMemoryAdminSessionStore,
} from "../backend/adminSession.mjs";

const ADMIN_ORIGIN = "https://admin.example.test";

test("admin model lab requires an exact origin and cookie session; admin=1 never authenticates", async () => {
  const { handler } = await createHarness({
    service: {
      capabilities: async () => ({ providers: ["openai"] }),
    },
  });

  const queryOnly = createResponse();
  await handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=capabilities&admin=1",
  }), queryOnly);
  assert.equal(queryOnly.statusCode, 401);
  assert.equal(queryOnly.payload.error, "admin_session_required");

  const wrongOrigin = createResponse();
  await handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=capabilities",
    origin: `${ADMIN_ORIGIN}.evil.invalid`,
  }), wrongOrigin);
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal(wrongOrigin.headers["access-control-allow-origin"], undefined);

  const { handler: authorizedHandler, cookie } = await createHarness({
    service: {
      capabilities: async () => ({ providers: ["openai"] }),
    },
    login: true,
  });
  const allowed = createResponse();
  await authorizedHandler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=capabilities",
    headers: { cookie },
  }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.payload, {
    ok: true,
    action: "capabilities",
    data: { providers: ["openai"] },
  });
  assert.equal(allowed.headers["access-control-allow-origin"], ADMIN_ORIGIN);
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  assert.notEqual(allowed.headers["access-control-allow-origin"], "*");
});

test("all POST actions require CSRF and dispatch only through the injected service", async () => {
  const calls = [];
  const service = {
    createRun: async (input) => calls.push(["createRun", input]) && { runId: "run-1" },
    forkRun: async (input) => calls.push(["forkRun", input]) && { runId: "fork-1" },
    executeRun: async (input) => calls.push(["executeRun", input]) && { accepted: true },
    cancelRun: async (input) => calls.push(["cancelRun", input]) && { requested: true },
    releaseUnchargedRelayReservation: async (input) => (
      calls.push(["releaseUnchargedRelayReservation", input])
      && { released: true }
    ),
    reconcileRelayTotalOnlyUsage: async (input) => (
      calls.push(["reconcileRelayTotalOnlyUsage", input])
      && { reconciled: true }
    ),
    saveRating: async (input) => calls.push(["saveRating", input]) && { stored: true },
  };
  const { handler, cookie, csrfToken } = await createHarness({ service, login: true });

  const missingCsrf = createResponse();
  await handler(request({
    method: "POST",
    headers: { cookie },
    body: { action: "create", question: "test" },
  }), missingCsrf);
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(missingCsrf.payload.error, "admin_csrf_invalid");
  assert.equal(calls.length, 0);

  for (const body of [
    { action: "create", question: "test", finalAttemptPolicy: "single" },
    {
      action: "fork",
      forkFromRunId: "run-1",
      idempotencyKey: "fork-api-key-0001",
      provider: "glm",
    },
    { action: "execute", runId: "run-1", prompt: "p" },
    { action: "cancel", runId: "run-1", reason: "manual" },
    {
      action: "release-budget-reservation",
      runId: "run-1",
      confirmation: "provider-dashboard-confirmed-not-charged/v1:run-1:attempt-1",
    },
    {
      action: "reconcile-relay-total-only-usage",
      runId: "run-1",
      confirmation: "relay-total-only-usage-reconciliation/v1:run-1:attempt-1",
    },
    { action: "rating", runId: "run-1", rating: 4, notes: "ok" },
  ]) {
    const response = createResponse();
    await handler(request({
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
      },
      body,
    }), response);
    assert.equal(response.statusCode, 200, body.action);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.action, body.action);
  }

  assert.deepEqual(calls.map(([name]) => name), [
    "createRun",
    "forkRun",
    "executeRun",
    "cancelRun",
    "releaseUnchargedRelayReservation",
    "reconcileRelayTotalOnlyUsage",
    "saveRating",
  ]);
  assert.deepEqual(calls[0][1].body, {
    question: "test",
    finalAttemptPolicy: "single",
  });
  assert.equal(calls[1][1].forkFromRunId, "run-1");
  assert.equal(calls[1][1].body.idempotencyKey, "fork-api-key-0001");
  assert.equal(calls[1][1].body.provider, "glm");
  assert.equal(Object.hasOwn(calls[1][1].body, "action"), false);
  assert.equal(calls[2][1].runId, "run-1");
  assert.equal(calls[3][1].runId, "run-1");
  assert.equal(calls[4][1].runId, "run-1");
  assert.equal(
    calls[4][1].confirmation,
    "provider-dashboard-confirmed-not-charged/v1:run-1:attempt-1",
  );
  assert.equal(
    calls[5][1].confirmation,
    "relay-total-only-usage-reconciliation/v1:run-1:attempt-1",
  );
  assert.equal(calls[6][1].rating, 4);
  assert.equal(calls[6][1].notes, "ok");
});

test("fork is POST-only and requires source run and idempotency key before dispatch", async () => {
  let calls = 0;
  const { handler, cookie, csrfToken } = await createHarness({
    login: true,
    service: { forkRun: async () => { calls += 1; } },
  });
  for (const body of [
    { action: "fork", idempotencyKey: "fork-api-key-0002" },
    { action: "fork", forkFromRunId: "run-1" },
  ]) {
    const response = createResponse();
    await handler(request({
      method: "POST",
      headers: { cookie, "x-csrf-token": csrfToken },
      body,
    }), response);
    assert.equal(response.statusCode, 400);
  }
  const getResponse = createResponse();
  await handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=fork",
    headers: { cookie },
  }), getResponse);
  assert.equal(getResponse.statusCode, 400);
  assert.equal(calls, 0);
});

test("authenticated POST bodies are rejected before dispatch when the byte limit is exceeded", async () => {
  let called = false;
  const { handler, cookie, csrfToken } = await createHarness({
    login: true,
    service: {
      createRun: async () => {
        called = true;
        return { runId: "should-not-exist" };
      },
    },
  });
  const response = createResponse();
  await handler(request({
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      action: "create",
      question: "界".repeat(100_000),
    }),
  }), response);

  assert.equal(response.statusCode, 413);
  assert.equal(response.payload.error, "admin_model_lab_body_too_large");
  assert.equal(called, false);
});

test("GET run/list/export/evaluation actions have stable thin-adapter arguments", async () => {
  const calls = [];
  const service = {
    getRun: async (input) => calls.push(["getRun", input]) && { runId: input.runId },
    listRuns: async (input) => calls.push(["listRuns", input]) && { entries: [] },
    exportRuns: async (input) => calls.push(["exportRuns", input]) && { records: [] },
    getEvaluation: async (input) => calls.push(["getEvaluation", input]) && { cases: [] },
  };
  const { handler, cookie } = await createHarness({ service, login: true });
  const urls = [
    "/api/admin-model-lab?action=run&runId=run-7",
    "/api/admin-model-lab?action=list&limit=20&cursor=next",
    "/api/admin-model-lab?action=export&runId=run-7&format=json",
    "/api/admin-model-lab?action=evaluation&evaluationId=suite-1&limit=5",
  ];
  for (const url of urls) {
    const response = createResponse();
    await handler(request({ method: "GET", url, headers: { cookie } }), response);
    assert.equal(response.statusCode, 200, url);
  }
  assert.equal(calls[0][1].runId, "run-7");
  assert.equal(calls[1][1].limit, 20);
  assert.equal(calls[1][1].cursor, "next");
  assert.equal(calls[2][1].format, "json");
  assert.equal(calls[3][1].evaluationId, "suite-1");
  assert.equal(calls[3][1].limit, 5);
});

test("SSE replays sequence-numbered events after a cursor and ends terminal runs", async () => {
  const calls = [];
  const service = {
    replayEvents: async (input) => {
      calls.push(input);
      return {
        runId: input.runId,
        nextAfterSequence: 4,
        status: "SUCCEEDED",
        events: [
          {
            runId: input.runId,
            sequence: 3,
            type: "STAGE_PROGRESS",
            status: "RUNNING",
            payload: { stage: "generate_ruling" },
          },
          {
            runId: input.runId,
            sequence: 4,
            type: "RUN_SUCCEEDED",
            status: "SUCCEEDED",
            payload: {},
          },
        ],
      };
    },
  };
  const { handler, cookie } = await createHarness({ service, login: true });
  const response = createResponse({ sse: true });
  await handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=events&runId=run-9&afterSequence=2",
    headers: { cookie },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(response.headers["x-accel-buffering"], "no");
  assert.equal(calls[0].afterSequence, 2);
  assert.match(response.body, /retry: 1000/u);
  assert.match(response.body, /id: 3\nevent: STAGE_PROGRESS/u);
  assert.match(response.body, /id: 4\nevent: RUN_SUCCEEDED/u);
  assert.match(response.body, /event: end\ndata: .*"terminal":true/u);
  assert.equal(response.ended, true);
});

test("SSE Last-Event-ID supports reconnect replay when afterSequence is omitted", async () => {
  let received;
  const { handler, cookie } = await createHarness({
    login: true,
    service: {
      replayEvents: async (input) => {
        received = input;
        return { events: [], nextAfterSequence: input.afterSequence, status: "RUNNING" };
      },
    },
  });
  const response = createResponse({ sse: true });
  await handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=events&runId=run-10",
    headers: {
      cookie,
      "last-event-id": "12",
    },
  }), response);
  assert.equal(received.afterSequence, 12);
  assert.doesNotMatch(response.body, /event: end/u);
  assert.equal(response.ended, true);
});

test("missing service capability returns 501 and internal errors never disclose secrets", async () => {
  const first = await createHarness({ service: {}, login: true });
  const unavailable = createResponse();
  await first.handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=capabilities",
    headers: { cookie: first.cookie },
  }), unavailable);
  assert.equal(unavailable.statusCode, 501);
  assert.equal(unavailable.payload.error, "admin_model_lab_capability_unavailable");

  const secret = "sk-sensitive-openai-key";
  const second = await createHarness({
    login: true,
    service: {
      capabilities: async () => {
        throw new Error(`upstream rejected ${secret}`);
      },
    },
  });
  const failed = createResponse();
  await second.handler(request({
    method: "GET",
    url: "/api/admin-model-lab?action=capabilities",
    headers: { cookie: second.cookie },
  }), failed);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.payload.error, "admin_model_lab_internal_error");
  assert.doesNotMatch(JSON.stringify(failed.payload), new RegExp(secret, "u"));
});

test("invalid JSON is a bounded 400 response after authentication", async () => {
  const { handler, cookie, csrfToken } = await createHarness({
    login: true,
    service: {
      createRun: async () => ({ runId: "unreachable" }),
    },
  });
  const response = createResponse();
  await handler(request({
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": csrfToken,
    },
    body: "{not-json",
  }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, "admin_model_lab_json_invalid");
});

test("preflight reflects only an exact allowed origin and never uses wildcard CORS", async () => {
  const { handler } = await createHarness({ service: {} });
  const allowed = createResponse();
  await handler(request({ method: "OPTIONS" }), allowed);
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], ADMIN_ORIGIN);
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");

  const rejected = createResponse();
  await handler(request({
    method: "OPTIONS",
    origin: "https://other.example.test",
  }), rejected);
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

async function createHarness({ service, login = false } = {}) {
  const env = {
    ADMIN_ALLOWED_ORIGIN: ADMIN_ORIGIN,
    ADMIN_SESSION_PASSWORD: "admin-password",
  };
  const store = createMemoryAdminSessionStore();
  const manager = createAdminSessionManager({ env, store });
  const handler = createAdminModelLabHandler({ manager, service });
  if (!login) return { manager, handler, cookie: "", csrfToken: "" };

  const result = await manager.login({
    request: request({ method: "POST" }),
    body: { password: env.ADMIN_SESSION_PASSWORD },
  });
  assert.equal(result.ok, true);
  return {
    manager,
    handler,
    cookie: cookiePair(result.setCookie),
    csrfToken: result.csrfToken,
  };
}

function request({
  method,
  url = "/api/admin-model-lab",
  origin = ADMIN_ORIGIN,
  headers = {},
  body,
} = {}) {
  return {
    method,
    url,
    headers: {
      origin,
      "x-forwarded-for": "203.0.113.11",
      ...headers,
    },
    body,
  };
}

function cookiePair(setCookie) {
  const pair = String(setCookie || "").split(";", 1)[0];
  assert.match(pair, new RegExp(`^${ADMIN_SESSION_COOKIE_NAME}=`));
  return pair;
}

function createResponse({ sse = false } = {}) {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    body: "",
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
      this.ended = true;
      return this;
    },
    write(value) {
      if (!sse) throw new Error("unexpected response.write");
      this.body += String(value);
      return true;
    },
    flushHeaders() {},
    end() {
      this.ended = true;
      return this;
    },
  };
}
