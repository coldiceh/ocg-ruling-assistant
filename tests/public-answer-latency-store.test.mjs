import assert from "node:assert/strict";
import test from "node:test";
import {
  publicAnswerLatencyStorageStatus,
  readPublicAnswerLatency,
  readPublicAnswerLatencyProfiles,
  recordPublicAnswerLatency,
} from "../backend/publicAnswerLatencyStore.mjs";

const redisEnv = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};
const now = new Date("2026-08-03T08:00:00.000Z");
const nowMs = now.getTime();

test("public answer latency atomically keeps the latest 20 successful samples for 30 days", async () => {
  const commands = [];
  const result = await recordPublicAnswerLatency({
    profileId: "DeepSeek-V4-Flash-High",
    durationMs: 85_600.4,
    env: redisEnv,
    now,
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      commands.push(command);
      return jsonResponse([
        `${nowMs}:85600`,
        `${nowMs - 1000}:44400`,
      ]);
    },
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "EVAL");
  assert.match(commands[0][1], /LPUSH/u);
  assert.match(commands[0][1], /LTRIM/u);
  assert.match(commands[0][1], /EXPIRE/u);
  assert.deepEqual(commands[0].slice(2), [
    "1",
    "rag-public-answer-latency:v1:deepseek-v4-flash-high",
    `${nowMs}:85600`,
    "19",
    String(30 * 86400),
  ]);
  assert.deepEqual(result, {
    profileId: "deepseek-v4-flash-high",
    status: "available",
    storage: "redis",
    persistent: true,
    averageMs: 65000,
    sampleCount: 2,
    windowSize: 20,
    lastRecordedAt: now.toISOString(),
  });
});

test("public answer latency read excludes expired, future, corrupt, and excess samples", async () => {
  const values = [
    `${nowMs}:1000`,
    `${nowMs - 1000}:3000`,
    `${nowMs - (30 * 86400000) - 1}:999999`,
    `${nowMs + 61000}:999999`,
    "corrupt",
    ...Array.from({ length: 20 }, (_, index) => `${nowMs - 2000 - index}:5000`),
  ];
  let command;
  const result = await readPublicAnswerLatency({
    profileId: "deepseek-v4-flash-high",
    env: redisEnv,
    now,
    fetchImpl: async (_url, options) => {
      command = JSON.parse(options.body);
      return jsonResponse(values);
    },
  });

  assert.deepEqual(command, [
    "LRANGE",
    "rag-public-answer-latency:v1:deepseek-v4-flash-high",
    "0",
    "19",
  ]);
  assert.equal(result.status, "available");
  assert.equal(result.sampleCount, 17);
  assert.equal(result.averageMs, 4647);
});

test("public answer latency reports no samples without inventing an average", async () => {
  const result = await readPublicAnswerLatency({
    profileId: "deepseek-v4-flash-high",
    env: redisEnv,
    now,
    fetchImpl: async () => jsonResponse([]),
  });
  assert.deepEqual(result, {
    profileId: "deepseek-v4-flash-high",
    status: "no_samples",
    storage: "redis",
    persistent: true,
    averageMs: null,
    sampleCount: 0,
    windowSize: 20,
    lastRecordedAt: null,
  });
});

test("public answer latency storage failures never escape to the answer caller", async () => {
  const fetchImpl = async () => {
    throw new Error("network unavailable");
  };
  const [recorded, read, profiles] = await Promise.all([
    recordPublicAnswerLatency({
      profileId: "deepseek-v4-flash-high",
      durationMs: 1000,
      env: redisEnv,
      fetchImpl,
      now,
    }),
    readPublicAnswerLatency({
      profileId: "deepseek-v4-flash-high",
      env: redisEnv,
      fetchImpl,
      now,
    }),
    readPublicAnswerLatencyProfiles({
      profileIds: ["deepseek-v4-flash-high", "deepseek-v4-flash-high", "glm-5.2-high"],
      env: redisEnv,
      fetchImpl,
      now,
    }),
  ]);

  assert.equal(recorded.status, "unavailable");
  assert.equal(recorded.reason, "storage_error");
  assert.equal(read.status, "unavailable");
  assert.equal(read.reason, "storage_error");
  assert.deepEqual(profiles.profiles.map((item) => item.profileId), [
    "deepseek-v4-flash-high",
    "glm-5.2-high",
  ]);
  assert.ok(profiles.profiles.every((item) => item.status === "unavailable"));
});

test("public answer latency clearly distinguishes disabled and unconfigured storage", async () => {
  assert.deepEqual(publicAnswerLatencyStorageStatus({}), {
    enabled: false,
    storage: "unconfigured",
    persistent: false,
  });
  assert.deepEqual(publicAnswerLatencyStorageStatus({
    ...redisEnv,
    PUBLIC_ANSWER_LATENCY_ENABLED: "false",
  }), {
    enabled: false,
    storage: "disabled",
    persistent: false,
  });

  const unconfigured = await recordPublicAnswerLatency({
    profileId: "deepseek-v4-flash-high",
    durationMs: 1000,
    env: {},
    now,
  });
  assert.equal(unconfigured.status, "unavailable");
  assert.equal(unconfigured.reason, "unconfigured");

  const invalid = await recordPublicAnswerLatency({
    profileId: "../unsafe",
    durationMs: 1000,
    env: redisEnv,
    now,
  });
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.reason, "invalid_profile");
});

test("public answer latency can use an isolated Redis binding without enabling other Redis consumers", async () => {
  let requestedUrl = "";
  let authorization = "";
  const result = await readPublicAnswerLatency({
    profileId: "glm-5.2-high",
    env: {
      PUBLIC_ANSWER_LATENCY_REDIS_REST_URL: "https://latency-redis.example.test",
      PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN: "latency-token",
    },
    now,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      authorization = options.headers.authorization;
      return jsonResponse([`${nowMs}:42000`]);
    },
  });

  assert.equal(requestedUrl, "https://latency-redis.example.test");
  assert.equal(authorization, "Bearer latency-token");
  assert.equal(result.status, "available");
  assert.equal(result.averageMs, 42000);
});

function jsonResponse(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
  };
}
