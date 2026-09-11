import assert from "node:assert/strict";
import test from "node:test";
import { createAdminQueriesHandler } from "../api/admin-queries.js";
import {
  createAdminSessionManager,
  createMemoryAdminSessionStore,
} from "../backend/adminSession.mjs";
import {
  appendQueryAudit,
  listQueryAudits,
  queryAuditStorageStatus,
  updateQueryAudit,
} from "../backend/queryAuditStore.mjs";

const redisEnv = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

test("query_audit_persists_preparing_request_context_with_retention", async () => {
  const commands = [];
  const fetchImpl = async (_url, options) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    return jsonResponse(1);
  };

  const result = await appendQueryAudit({
    question: "  「无限泡影」可以发动吗？  ",
    mode: "rag",
    requestId: "request-1",
    requestContext: {
      ip: "203.0.113.18",
      ipSource: "x-forwarded-for",
      headers: { authorization: "must-not-be-stored" },
      cookies: "must-not-be-stored",
    },
    profileId: "official-astra-low",
    env: redisEnv,
    fetchImpl,
    now: new Date("2026-07-16T02:03:04.000Z"),
  });

  assert.equal(result.stored, true);
  assert.deepEqual(commands.map((command) => command[0]), ["LPUSH", "LTRIM", "EXPIRE"]);
  const stored = JSON.parse(commands[0][2]);
  assert.deepEqual(Object.keys(stored).sort(), [
    "createdAt", "id", "ip", "ipSource", "mode", "profileId", "question", "requestId", "status",
  ]);
  assert.match(stored.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(stored.question, "「无限泡影」可以发动吗？");
  assert.equal(stored.createdAt, "2026-07-16T02:03:04.000Z");
  assert.equal(stored.mode, "rag");
  assert.equal(stored.status, "preparing");
  assert.equal(stored.requestId, "request-1");
  assert.equal(stored.ip, "203.0.113.18");
  assert.equal(stored.ipSource, "x-forwarded-for");
  assert.equal(stored.profileId, "official-astra-low");
  assert.ok(!("headers" in stored));
  assert.ok(!("cookies" in stored));
  assert.equal(commands[1][3], "99");
  assert.equal(commands[2][2], String(30 * 86400));
});

test("query audit ids remain unique for identical questions created in the same millisecond", async () => {
  const fetchImpl = async () => jsonResponse(1);
  const input = {
    question: "同一问题",
    env: redisEnv,
    fetchImpl,
    now: new Date("2026-07-16T02:03:04.000Z"),
  };
  const [first, second] = await Promise.all([appendQueryAudit(input), appendQueryAudit(input)]);
  assert.notEqual(first.entry.id, second.entry.id);
});

test("query audit keeps a valid 12000-character public question intact", async () => {
  const question = "问".repeat(12000);
  let stored;
  await appendQueryAudit({
    question,
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      if (command[0] === "LPUSH") stored = JSON.parse(command[2]);
      return jsonResponse(1);
    },
  });
  assert.equal(stored.question, question);
});

test("query audit counts the 12000-character public limit by Unicode code point", async () => {
  const question = "𠮷".repeat(12000);
  let stored;
  await appendQueryAudit({
    question,
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      if (command[0] === "LPUSH") stored = JSON.parse(command[2]);
      return jsonResponse(1);
    },
  });
  assert.equal(stored.question, question);
  assert.equal(Array.from(stored.question).length, 12000);
});

test("query_audit_list_parses_entries", async () => {
  assert.equal(queryAuditStorageStatus({}).persistent, false);

  const entries = [{
    id: "entry-1",
    createdAt: "2026-07-16T02:03:04.000Z",
    question: "测试问题",
    mode: "rag",
    requestId: "request-1",
    ip: "203.0.113.18",
    ipSource: "x-forwarded-for",
    profileId: "official-astra-low",
    status: "completed",
    completedAt: "2026-07-16T02:03:08.000Z",
    answer: "完整公开答案",
    model: "gpt-6-astra",
    reasoningEffort: "low",
    latencyMs: 4000,
  }, {
    id: "legacy-entry",
    createdAt: "2026-07-15T02:03:04.000Z",
    question: "旧记录",
    mode: "rag",
  }];
  const commands = [];
  const result = await listQueryAudits({
    limit: 12,
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      commands.push(command);
      return jsonResponse(entries.map((entry) => JSON.stringify(entry)));
    },
  });

  assert.deepEqual(commands[0], ["LRANGE", "rag-query-audit:v1", "0", "11"]);
  assert.deepEqual(result.entries, entries);
  assert.equal(Object.hasOwn(result.entries[1], "status"), false);
  assert.equal(Object.hasOwn(result.entries[1], "answer"), false);
});

test("query audit update atomically finds the exact id and merges only allowed fields", async () => {
  const original = {
    id: "entry-target",
    createdAt: "2026-07-16T02:03:04.000Z",
    question: "测试问题",
    mode: "rag",
    status: "preparing",
    ip: "203.0.113.18",
  };
  const commands = [];
  const answer = "  完整公开答案\n第二段保持原样  ";
  const result = await updateQueryAudit({
    id: original.id,
    patch: {
      status: "completed",
      completedAt: "2026-07-16T02:03:08.000Z",
      answer,
      model: "gpt-6-astra",
      reasoningEffort: "low",
      latencyMs: 4000,
      errorCode: "",
      profileId: "official-astra-low",
      question: "must-not-change",
      ip: "must-not-change",
      headers: { authorization: "must-not-be-stored" },
      cookies: "must-not-be-stored",
      rawError: "must-not-be-stored",
    },
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      commands.push(command);
      return jsonResponse(JSON.stringify({ ...original, ...JSON.parse(command[5]) }));
    },
  });

  assert.equal(result.updated, true);
  assert.equal(result.entry.answer, answer);
  assert.equal(result.entry.ip, original.ip);
  assert.equal(result.entry.question, original.question);
  assert.deepEqual(commands[0].slice(0, 1), ["EVAL"]);
  assert.equal(commands[0][2], "1");
  assert.equal(commands[0][3], "rag-query-audit:v1");
  assert.equal(commands[0][4], original.id);
  assert.match(commands[0][1], /LRANGE[\s\S]*0, 99/u);
  assert.match(commands[0][1], /entry\.id == ARGV\[1\]/u);
  assert.match(commands[0][1], /LSET/u);
  assert.equal(commands[0][1].includes("LPUSH"), false);
  assert.deepEqual(Object.keys(JSON.parse(commands[0][5])).sort(), [
    "answer", "completedAt", "errorCode", "latencyMs", "model", "profileId", "reasoningEffort", "status",
  ]);
});

test("query audit update leaves an evicted id absent and validates mechanical patch fields", async () => {
  const missing = await updateQueryAudit({
    id: "evicted-entry",
    patch: { status: "failed", errorCode: "public_error" },
    env: redisEnv,
    fetchImpl: async () => jsonResponse(null),
  });
  assert.deepEqual(missing, {
    updated: false,
    enabled: true,
    storage: "redis",
    persistent: true,
    reason: "not_found",
  });
  await assert.rejects(
    updateQueryAudit({ id: "entry", patch: { status: "unknown" }, env: redisEnv, fetchImpl: async () => jsonResponse(null) }),
    /query_audit_status_invalid/u,
  );
  await assert.rejects(
    updateQueryAudit({ id: "entry", patch: { latencyMs: -1 }, env: redisEnv, fetchImpl: async () => jsonResponse(null) }),
    /query_audit_latency_invalid/u,
  );
});

test("query audit retention and listing are capped at 100 questions", async () => {
  const appendCommands = [];
  await appendQueryAudit({
    question: "测试保留上限",
    env: {
      ...redisEnv,
      QUERY_AUDIT_MAX_ENTRIES: "500",
    },
    fetchImpl: async (_url, options) => {
      appendCommands.push(JSON.parse(options.body));
      return jsonResponse(1);
    },
  });
  assert.deepEqual(appendCommands[1], ["LTRIM", "rag-query-audit:v1", "0", "99"]);

  const listCommands = [];
  await listQueryAudits({
    limit: 500,
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      listCommands.push(JSON.parse(options.body));
      return jsonResponse([]);
    },
  });
  assert.deepEqual(listCommands[0], ["LRANGE", "rag-query-audit:v1", "0", "99"]);

  const defaultListCommands = [];
  await listQueryAudits({
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      defaultListCommands.push(JSON.parse(options.body));
      return jsonResponse([]);
    },
  });
  assert.deepEqual(defaultListCommands[0], ["LRANGE", "rag-query-audit:v1", "0", "99"]);
});

test("query audit timeout covers a stalled response body and aborts the request", async () => {
  let requestSignal;
  const startedAt = Date.now();
  await assert.rejects(
    listQueryAudits({
      env: { ...redisEnv, QUERY_AUDIT_REDIS_TIMEOUT_MS: "250" },
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return { ok: true, status: 200, json: async () => new Promise(() => {}) };
      },
    }),
    /query_audit_redis_timeout/u,
  );
  assert.equal(requestSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 1000);
});

function jsonResponse(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
  };
}
test("admin_queries_endpoint_uses_cookie_session_and_never_body_password", async () => {
  const origin = "https://admin.example.test";
  const env = {
    ...redisEnv,
    ADMIN_ALLOWED_ORIGIN: origin,
    ADMIN_SESSION_PASSWORD: "owner-secret",
  };
  const manager = createAdminSessionManager({
    env,
    store: createMemoryAdminSessionStore(),
  });
  const handler = createAdminQueriesHandler({
    env,
    manager,
    listQueries: async ({ limit }) => ({
      entries: [{
        id: "entry-2",
        createdAt: "2026-07-16T03:04:05.000Z",
        question: "仅管理员可见",
        mode: "rag",
      }],
      count: 1,
      receivedLimit: limit,
    }),
  });

  let response = createJsonResponse();
  await handler({
    method: "POST",
    url: "/api/admin-queries",
    headers: { origin },
    body: { password: "owner-secret", limit: 5 },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.payload.error, "admin_session_required");

  const login = await manager.login({
    request: {
      headers: {
        origin,
        "x-forwarded-for": "203.0.113.12",
      },
    },
    body: { password: "owner-secret" },
  });
  assert.equal(login.ok, true);
  const cookie = String(login.setCookie).split(";", 1)[0];

  response = createJsonResponse();
  await handler({
    method: "GET",
    url: "/api/admin-queries?limit=5&admin=1",
    headers: { origin, cookie },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.entries[0].question, "仅管理员可见");
  assert.equal(response.payload.receivedLimit, "5");
  assert.equal(response.headers["access-control-allow-origin"], origin);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.notEqual(response.headers["access-control-allow-origin"], "*");
});

function createJsonResponse() {
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
