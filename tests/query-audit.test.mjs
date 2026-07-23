import assert from "node:assert/strict";
import test from "node:test";
import adminQueriesHandler from "../api/admin-queries.js";
import { authorizeAdminRequest } from "../backend/adminAuth.mjs";
import {
  appendQueryAudit,
  listQueryAudits,
  queryAuditStorageStatus,
} from "../backend/queryAuditStore.mjs";

const redisEnv = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

test("query_audit_persists_only_question_metadata_with_retention", async () => {
  const commands = [];
  const fetchImpl = async (_url, options) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    return jsonResponse(1);
  };

  const result = await appendQueryAudit({
    question: "  「无限泡影」可以发动吗？  ",
    mode: "rag",
    env: redisEnv,
    fetchImpl,
    now: new Date("2026-07-16T02:03:04.000Z"),
  });

  assert.equal(result.stored, true);
  assert.deepEqual(commands.map((command) => command[0]), ["LPUSH", "LTRIM", "EXPIRE"]);
  const stored = JSON.parse(commands[0][2]);
  assert.deepEqual(Object.keys(stored).sort(), ["createdAt", "id", "mode", "question"]);
  assert.equal(stored.question, "「无限泡影」可以发动吗？");
  assert.equal(stored.createdAt, "2026-07-16T02:03:04.000Z");
  assert.equal(stored.mode, "rag");
  assert.ok(!("ip" in stored));
  assert.equal(commands[1][3], "99");
  assert.equal(commands[2][2], String(30 * 86400));
});

test("query_audit_list_is_owner_protected_and_parses_entries", async () => {
  assert.equal(queryAuditStorageStatus({}).persistent, false);

  const missing = authorizeAdminRequest({ headers: {} }, {
    env: { API_ADMIN_PASSWORD: "owner-secret" },
    body: {},
  });
  assert.equal(missing.status, 401);

  const wrong = authorizeAdminRequest({ headers: {} }, {
    env: { API_ADMIN_PASSWORD: "owner-secret" },
    body: { password: "wrong" },
  });
  assert.equal(wrong.status, 403);

  const allowed = authorizeAdminRequest({ headers: {} }, {
    env: { API_ADMIN_PASSWORD: "owner-secret" },
    body: { password: "owner-secret" },
  });
  assert.equal(allowed.ok, true);

  const entries = [{
    id: "entry-1",
    createdAt: "2026-07-16T02:03:04.000Z",
    question: "测试问题",
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

function jsonResponse(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
  };
}
test("admin_queries_endpoint_rejects_public_access_and_accepts_owner_password", async () => {
  const previous = {
    password: process.env.API_ADMIN_PASSWORD,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    fetch: globalThis.fetch,
  };
  try {
    process.env.API_ADMIN_PASSWORD = "owner-secret";
    process.env.UPSTASH_REDIS_REST_URL = redisEnv.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = redisEnv.UPSTASH_REDIS_REST_TOKEN;

    let response = createJsonResponse();
    await adminQueriesHandler({ method: "POST", headers: {}, body: {} }, response);
    assert.equal(response.statusCode, 401);

    globalThis.fetch = async () => jsonResponse([
      JSON.stringify({
        id: "entry-2",
        createdAt: "2026-07-16T03:04:05.000Z",
        question: "仅管理员可见",
        mode: "rag",
      }),
    ]);
    response = createJsonResponse();
    await adminQueriesHandler({
      method: "POST",
      headers: {},
      body: { password: "owner-secret", limit: 5 },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.entries[0].question, "仅管理员可见");
  } finally {
    restoreEnv("API_ADMIN_PASSWORD", previous.password);
    restoreEnv("UPSTASH_REDIS_REST_URL", previous.url);
    restoreEnv("UPSTASH_REDIS_REST_TOKEN", previous.token);
    globalThis.fetch = previous.fetch;
  }
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

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
