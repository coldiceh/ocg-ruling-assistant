import assert from "node:assert/strict";
import test from "node:test";

import {
  getPublicModelBudgetStatus,
  releasePublicModelBudgetReservation,
  reservePublicModelBudget,
  resetPublicModelBudget,
  settlePublicModelBudget,
} from "../backend/publicModelBudgetLedger.mjs";

const NOW = new Date("2037-02-03T04:05:06.000Z");

test("production deployment fails closed when persistent budget storage is absent", async () => {
  const env = {
    VERCEL: "1",
    API_BUDGET_TIMEZONE: "UTC",
    API_BUDGET_MODE: "soft",
  };
  const status = await getPublicModelBudgetStatus({ env, now: NOW });
  const reservation = await reservePublicModelBudget({
    provider: "relay",
    stage: "final_ruling",
    estimatedAmount: 0.25,
    env,
    now: NOW,
  });

  assert.equal(status.budgetStorage, "unconfigured");
  assert.equal(status.budgetPersistent, false);
  assert.equal(status.spentTodayCny, null);
  assert.match(status.storageWarning, /持久化预算存储/u);
  assert.equal(reservation.blocked, true);
  assert.equal(reservation.reservedAmount, 0);
});

test("local soft mode falls back to memory while local hard mode fails closed", async () => {
  const baseEnv = {
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://anonymous-budget.example.test",
    KV_REST_API_TOKEN: "anonymous-token",
  };
  const unavailableFetch = async () => {
    throw new Error("anonymous storage unavailable");
  };
  const soft = await reservePublicModelBudget({
    provider: "deepseek",
    stage: "evidence_preparation",
    estimatedAmount: 0.01,
    env: { ...baseEnv, API_BUDGET_MODE: "soft" },
    fetchImpl: unavailableFetch,
    now: NOW,
  });
  const hard = await reservePublicModelBudget({
    provider: "deepseek",
    stage: "evidence_preparation",
    estimatedAmount: 0.01,
    env: { ...baseEnv, API_BUDGET_MODE: "hard" },
    fetchImpl: unavailableFetch,
    now: NOW,
  });

  assert.equal(soft.blocked, false);
  assert.equal(soft.storage.kind, "memory");
  assert.equal(soft.status.budgetMode, "soft");
  assert.ok(soft.warnings.includes("redis_budget_unavailable_using_memory_soft_limit"));
  assert.equal(hard.blocked, true);
  assert.equal(hard.storage.kind, "unavailable");
  assert.equal(hard.status.budgetMode, "hard");
  assert.equal(hard.storage.error, "budget_storage_unavailable");
});

test("Redis command waits are bounded by the shared budget I/O deadline", async () => {
  const env = {
    API_BUDGET_TIMEZONE: "UTC",
    API_BUDGET_MODE: "hard",
    API_BUDGET_REDIS_TIMEOUT_MS: "1000",
    API_BUDGET_REDIS_TOTAL_TIMEOUT_MS: "20",
    KV_REST_API_URL: "https://anonymous-budget.example.test",
    KV_REST_API_TOKEN: "anonymous-token",
  };
  const stalledFetch = async (_url, options = {}) => new Promise((_, reject) => {
    const rejectOnAbort = () => reject(options.signal?.reason || new Error("aborted"));
    if (options.signal?.aborted) rejectOnAbort();
    else options.signal?.addEventListener("abort", rejectOnAbort, { once: true });
  });
  const startedAt = Date.now();
  const reservation = await reservePublicModelBudget({
    provider: "deepseek",
    stage: "evidence_preparation",
    estimatedAmount: 0.01,
    env,
    fetchImpl: stalledFetch,
    now: NOW,
  });

  assert.equal(reservation.blocked, true);
  assert.equal(reservation.storage.kind, "unavailable");
  assert.ok(Date.now() - startedAt < 500, "budget I/O must not wait for the per-command 1s limit");
});

test("same-day legacy ledgers migrate without reinterpreting legacy CNY as USD", async () => {
  const env = redisEnv();
  const redis = createAnonymousRedis();
  redis.store.set("rag-api-budget:2037-02-03", "2.5");
  redis.store.set("rag-api-budget:v2:2037-02-03:evidence_preparation:deepseek", "0.2");
  redis.store.set("rag-api-budget:v2:2037-02-03:final_ruling:glm", "0.3");
  redis.store.set("rag-api-budget:v2:2037-02-03:final_ruling:relay", "0.01");

  const first = await getPublicModelBudgetStatus({
    env,
    fetchImpl: redis.fetchImpl,
    now: NOW,
  });
  const relay = first.buckets.find((bucket) => bucket.id === "final_ruling:relay");
  assert.equal(first.spentTodayCny, 2.5);
  assert.equal(
    first.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny,
    0.2,
  );
  assert.equal(
    first.buckets.find((bucket) => bucket.id === "final_ruling:glm").spentTodayCny,
    0.3,
  );
  assert.equal(relay.currency, "USD");
  assert.equal(relay.dailyBudgetUsd, 10);
  assert.equal(relay.spentTodayUsd, 10);
  assert.equal(relay.remainingTodayUsd, 0);

  const reset = await resetPublicModelBudget({ env, fetchImpl: redis.fetchImpl, now: NOW });
  assert.equal(reset.spentTodayCny, 0);
  assert.equal(
    reset.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny,
    0,
  );
  assert.equal(
    reset.buckets.find((bucket) => bucket.id === "final_ruling:glm").spentTodayCny,
    0,
  );
  assert.equal(
    reset.buckets.find((bucket) => bucket.id === "final_ruling:relay").spentTodayUsd,
    0,
  );
});

test("ChatGPT public budget remains an official-price USD pool capped at ten dollars", async () => {
  const budgetDay = new Date("2037-02-05T04:05:06.000Z");
  const env = {
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "999",
  };
  const first = await reservePublicModelBudget({
    provider: "relay",
    stage: "final_ruling",
    estimatedAmount: 9,
    env,
    now: budgetDay,
  });
  assert.equal(first.blocked, false);
  assert.equal(first.bucketConfig.currency, "USD");
  assert.equal(first.bucketConfig.dailyBudget, 10);
  assert.equal(first.status.spentTodayCny, 0);
  assert.equal(first.status.bucket.spentTodayUsd, 9);

  const settled = await settlePublicModelBudget({
    reservation: first,
    actualAmount: 8,
    env,
  });
  assert.equal(settled.bucket.spentTodayUsd, 8);

  const blocked = await reservePublicModelBudget({
    provider: "relay",
    stage: "final_ruling",
    estimatedAmount: 3,
    env,
    now: budgetDay,
  });
  assert.equal(blocked.blocked, true);

  const released = await releasePublicModelBudgetReservation({
    reservation: first,
    env,
  });
  assert.equal(released.bucket.spentTodayUsd, 0);

  const invalidLimit = await getPublicModelBudgetStatus({
    env: { API_BUDGET_TIMEZONE: "UTC", API_CHATGPT_DAILY_BUDGET_USD: "0" },
    now: new Date("2037-02-06T04:05:06.000Z"),
  });
  assert.equal(
    invalidLimit.buckets.find((bucket) => bucket.id === "final_ruling:relay").dailyBudgetUsd,
    10,
  );
});

function redisEnv() {
  return {
    API_BUDGET_TIMEZONE: "UTC",
    API_BUDGET_MODE: "hard",
    KV_REST_API_URL: "https://anonymous-budget.example.test",
    KV_REST_API_TOKEN: "anonymous-token",
  };
}

function createAnonymousRedis() {
  const store = new Map();
  return {
    store,
    fetchImpl: async (_url, options = {}) => {
      const command = JSON.parse(options.body || "[]");
      const [operation, key, value] = command;
      if (operation === "GET") return jsonResponse({ result: store.get(key) || null });
      if (operation === "SET") {
        store.set(key, String(value));
        return jsonResponse({ result: "OK" });
      }
      if (operation !== "EVAL") return jsonResponse({ result: null });
      const keyCount = Number(command[2] || 0);
      if (keyCount === 3) {
        const currentKey = command[3];
        const legacyKey = command[4];
        const watermarkKey = command[5];
        const mode = command[6];
        const cap = Number(command[7] || 0);
        let current = Math.max(0, Number(store.get(currentKey) || 0));
        const legacy = Math.max(0, Number(store.get(legacyKey) || 0));
        const watermark = Math.max(0, Number(store.get(watermarkKey) || 0));
        if (mode === "reset") current = 0;
        else if (mode === "relay_cap") {
          if (legacy > watermark && legacy > 0) current = Math.max(current, cap);
        } else {
          current += Math.max(0, legacy - watermark);
        }
        store.set(currentKey, String(current));
        store.set(watermarkKey, String(Math.max(watermark, legacy)));
        return jsonResponse({ result: String(current) });
      }
      if (keyCount === 1) {
        const currentKey = command[3];
        const amount = Number(command[4] || 0);
        const next = Math.max(0, Number(store.get(currentKey) || 0) + amount);
        store.set(currentKey, String(next));
        return jsonResponse({ result: String(next) });
      }
      if (keyCount === 2) {
        const totalKey = command[3];
        const bucketKey = command[4];
        const amount = Number(command[5] || 0);
        const totalLimit = Number(command[6] || -1);
        const bucketLimit = Number(command[7] || -1);
        const countTotal = command[8] === "1";
        let total = Math.max(0, Number(store.get(totalKey) || 0));
        let bucket = Math.max(0, Number(store.get(bucketKey) || 0));
        const blocked = (countTotal && totalLimit > 0 && total + amount > totalLimit)
          || (bucketLimit > 0 && bucket + amount > bucketLimit);
        if (!blocked) {
          if (countTotal) total += amount;
          bucket += amount;
          if (countTotal) store.set(totalKey, String(total));
          store.set(bucketKey, String(bucket));
        }
        return jsonResponse({ result: [blocked ? 1 : 0, String(total), String(bucket)] });
      }
      return jsonResponse({ result: null });
    },
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}
