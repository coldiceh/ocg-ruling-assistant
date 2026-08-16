import assert from "node:assert/strict";
import test from "node:test";

import {
  activatePublicOfftopicRiskControl,
  buildPublicOfftopicRiskControlAnswer,
  clearPublicOfftopicRiskControl,
  publicOfftopicRiskControlRedisKeys,
  publicOfftopicRiskControlStorageStatus,
  readPublicOfftopicRiskControl,
} from "../backend/publicOfftopicRiskControl.mjs";

const REDIS_ENV = {
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
  VERCEL_ENV: "production",
};
const LOCK_KEY = "rag-public-offtopic-risk-control:v1:vercel-production:lock";
const NOW = new Date("2026-08-14T00:00:00.000Z");

test("off-topic risk control fails open when durable storage is unavailable", async () => {
  assert.deepEqual(publicOfftopicRiskControlStorageStatus({}), {
    enabled: false,
    storage: "unconfigured",
    persistent: false,
    failOpen: true,
  });

  const unconfigured = await readPublicOfftopicRiskControl({
    env: {},
    fetchImpl: async () => assert.fail("unconfigured storage must not be called"),
  });
  assert.equal(unconfigured.active, false);
  assert.equal(unconfigured.failOpen, true);
  assert.equal(unconfigured.reason, "storage_unconfigured");

  const unavailable = await readPublicOfftopicRiskControl({
    env: REDIS_ENV,
    fetchImpl: async () => { throw new Error("network unavailable"); },
  });
  assert.equal(unavailable.active, false);
  assert.equal(unavailable.failOpen, true);
  assert.equal(unavailable.storage, "unavailable");
});

test("activation uses one anonymous SET NX EX record", async () => {
  const commands = [];
  const randomCalls = [];
  const result = await activatePublicOfftopicRiskControl({
    env: REDIS_ENV,
    now: () => NOW,
    randomInt: (minimum, maximumExclusive) => {
      randomCalls.push([minimum, maximumExclusive]);
      return 17;
    },
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return jsonResponse("OK");
    },
  });

  assert.deepEqual(randomCalls, [[5, 61]]);
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.triggered, true);
  assert.equal(result.durationMinutes, 17);
  assert.equal(result.remainingMinutes, 17);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(0, 2), ["SET", LOCK_KEY]);
  assert.deepEqual(commands[0].slice(3), ["NX", "EX", String(17 * 60)]);

  const stored = JSON.parse(commands[0][2]);
  assert.deepEqual(Object.keys(stored).sort(), [
    "activatedAt",
    "durationMinutes",
    "expiresAt",
    "version",
  ]);
  assert.equal(JSON.stringify(stored).includes("question"), false);
  assert.equal(stored.activatedAt, "2026-08-14T00:00:00.000Z");
  assert.equal(stored.expiresAt, "2026-08-14T00:17:00.000Z");
});

test("a concurrent activation reads the existing lock without extending it", async () => {
  const record = {
    version: 1,
    activatedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-14T00:31:00.000Z",
    durationMinutes: 31,
  };
  const commands = [];
  const results = [null, JSON.stringify(record)];
  const status = await activatePublicOfftopicRiskControl({
    env: REDIS_ENV,
    now: () => new Date("2026-08-14T00:07:30.000Z"),
    randomInt: () => 60,
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return jsonResponse(results.shift());
    },
  });

  assert.deepEqual(commands.map((command) => command[0]), ["SET", "GET"]);
  assert.equal(commands.some((command) => command[0] === "EXPIRE"), false);
  assert.equal(status.active, true);
  assert.equal(status.triggered, false);
  assert.equal(status.durationMinutes, 31);
  assert.equal(status.remainingMinutes, 24);
});

test("read rounds remaining time upward and unlock deletes only the single lock key", async () => {
  const record = {
    version: 1,
    activatedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-14T00:06:01.000Z",
    durationMinutes: 7,
  };
  const commands = [];
  const status = await readPublicOfftopicRiskControl({
    env: REDIS_ENV,
    now: () => new Date("2026-08-14T00:05:01.001Z"),
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return jsonResponse(JSON.stringify(record));
    },
  });
  assert.equal(status.active, true);
  assert.equal(status.remainingMinutes, 1);

  const unlocked = await clearPublicOfftopicRiskControl({
    env: REDIS_ENV,
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return jsonResponse(1);
    },
  });
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.active, false);
  assert.equal(unlocked.cleared, true);
  assert.deepEqual(commands, [
    ["GET", LOCK_KEY],
    ["DEL", LOCK_KEY],
  ]);
});

test("preview and production always use separate Redis namespaces", () => {
  const production = publicOfftopicRiskControlRedisKeys({
    PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_KEY_PREFIX: "custom-risk:v2",
    PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_NAMESPACE: "misconfigured-shared-value",
    VERCEL_ENV: "production",
  });
  const preview = publicOfftopicRiskControlRedisKeys({
    PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_KEY_PREFIX: "custom-risk:v2",
    PUBLIC_OFFTOPIC_RISK_CONTROL_REDIS_NAMESPACE: "misconfigured-shared-value",
    VERCEL_ENV: "preview",
  });

  assert.equal(production.lockKey, "custom-risk:v2:vercel-production:lock");
  assert.equal(preview.lockKey, "custom-risk:v2:vercel-preview:lock");
  assert.notEqual(production.lockKey, preview.lockKey);
});

test("public answer helper distinguishes the triggering request from later blocked requests", () => {
  const triggering = buildPublicOfftopicRiskControlAnswer({
    status: { triggered: true, remainingMinutes: 12 },
  });
  const blocked = buildPublicOfftopicRiskControlAnswer({
    status: { active: true, remainingMinutes: 4 },
  });

  assert.equal(
    triggering.shortAnswer,
    "检测到非游戏王规则／裁定相关问题，系统自动关闭 12 分钟。如需提前解除，请联系作者：B站 おmaginai，或 QQ 1195362230。",
  );
  assert.equal(
    blocked.shortAnswer,
    "因有人提交非游戏王规则／裁定相关问题，系统暂时停止回答，预计还需 4 分钟。如需提前解除，请联系作者：B站 おmaginai，或 QQ 1195362230。",
  );
  assert.doesNotMatch(triggering.shortAnswer, /\*\*/u);
  assert.doesNotMatch(blocked.shortAnswer, /\*\*/u);
  assert.equal(triggering.answerLevel, "risk_control");
  assert.deepEqual(triggering.riskFlags, ["public_offtopic_risk_control"]);
  assert.equal(triggering.usedCards.length, 0);
  assert.equal(triggering.usedEvidence.length, 0);
});

function jsonResponse(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
  };
}
