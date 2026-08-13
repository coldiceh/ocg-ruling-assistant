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
} from "../backend/queryAuditStore.mjs";

const redisEnv = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

test("query audit stores only non-content metadata by default", async () => {
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
  assert.equal(result.storesContent, false);
  assert.equal(result.entry.question, undefined);
  assert.deepEqual(commands.map((command) => command[0]), ["LPUSH", "LTRIM", "EXPIRE"]);
  assert.doesNotMatch(commands[0][2], /无限泡影/u);
  const stored = JSON.parse(commands[0][2]);
  assert.deepEqual(Object.keys(stored).sort(), [
    "contentStored",
    "createdAt",
    "id",
    "languageHint",
    "mode",
    "questionBytes",
    "questionCharacters",
    "questionSha256",
    "schemaVersion",
  ]);
  assert.equal(stored.question, undefined);
  assert.match(stored.questionSha256, /^[a-f0-9]{64}$/u);
  assert.equal(stored.questionCharacters, 12);
  assert.equal(stored.questionBytes, 36);
  assert.equal(stored.languageHint, "cjk");
  assert.equal(stored.contentStored, false);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.createdAt, "2026-07-16T02:03:04.000Z");
  assert.equal(stored.mode, "rag");
  assert.ok(!("ip" in stored));
  assert.equal(commands[1][3], "99");
  assert.equal(commands[2][2], String(30 * 86400));
});

test("query audit stores full content only after explicit opt-in", async () => {
  const commands = [];
  const result = await appendQueryAudit({
    question: "保留这条问题",
    env: {
      ...redisEnv,
      QUERY_AUDIT_STORE_CONTENT: "true",
    },
    fetchImpl: async (_url, options) => {
      commands.push(JSON.parse(options.body));
      return jsonResponse(1);
    },
  });

  const stored = JSON.parse(commands[0][2]);
  assert.equal(result.storesContent, true);
  assert.equal(stored.contentStored, true);
  assert.equal(stored.question, "保留这条问题");
});

test("query audit list reads legacy content entries and current metadata entries", async () => {
  assert.equal(queryAuditStorageStatus({}).persistent, false);
  assert.equal(queryAuditStorageStatus({}).storesContent, false);

  const legacyEntry = {
    id: "entry-1",
    createdAt: "2026-07-16T02:03:04.000Z",
    question: "测试问题",
    mode: "rag",
  };
  const metadataEntry = {
    schemaVersion: 2,
    id: "entry-2",
    createdAt: "2026-07-16T03:04:05.000Z",
    mode: "rag",
    questionSha256: "a".repeat(64),
    questionCharacters: 27,
    questionBytes: 61,
    languageHint: "cjk",
    contentStored: false,
  };
  const commands = [];
  const result = await listQueryAudits({
    limit: 12,
    env: redisEnv,
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      commands.push(command);
      return jsonResponse([legacyEntry, metadataEntry].map((entry) => JSON.stringify(entry)));
    },
  });

  assert.deepEqual(commands[0], ["LRANGE", "rag-query-audit:v1", "0", "11"]);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].question, "测试问题");
  assert.equal(result.entries[0].contentStored, true);
  assert.match(result.entries[0].questionSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.entries[0].questionCharacters, 4);
  assert.equal(result.entries[0].questionBytes, 12);
  assert.deepEqual(result.entries[1], {
    id: "entry-2",
    createdAt: "2026-07-16T03:04:05.000Z",
    mode: "rag",
    questionSha256: "a".repeat(64),
    questionCharacters: 27,
    questionBytes: 61,
    languageHint: "cjk",
    contentStored: false,
  });
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
