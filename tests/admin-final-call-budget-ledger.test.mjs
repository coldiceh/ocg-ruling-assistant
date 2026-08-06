import assert from "node:assert/strict";
import test from "node:test";
import {
  adminFinalBudgetPool,
  createMemoryAdminFinalCallBudgetLedger,
  createRedisAdminFinalCallBudgetLedger,
} from "../backend/adminFinalCallBudgetLedger.mjs";

const RESERVED_AT = "2026-08-05T04:00:00.000Z";

test("DeepSeek models share one pool while each relay model has an independent pool", async () => {
  const ledger = createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      deepseek: { dailyBudgetCny: 10, reservationCny: 5 },
      relay_sol: { dailyBudgetCny: 10, reservationCny: 5 },
      relay_terra: { dailyBudgetCny: 10, reservationCny: 5 },
      relay_luna: { dailyBudgetCny: 10, reservationCny: 5 },
    },
  });

  assert.equal(adminFinalBudgetPool("deepseek"), "deepseek");
  assert.equal(adminFinalBudgetPool("relay", "relay-gpt-5.6-sol"), "relay_sol");
  assert.equal(adminFinalBudgetPool("relay", "gpt-5.6-terra"), "relay_terra");
  assert.equal(adminFinalBudgetPool("relay", "relay-gpt-5.6-luna"), "relay_luna");
  assert.equal(adminFinalBudgetPool("relay", "unknown-relay-model"), null);
  assert.equal(adminFinalBudgetPool("unknown-provider"), null);

  await ledger.reserve({
    reservationId: "deepseek-flash-primary",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reservedAt: RESERVED_AT,
  });
  await ledger.reserve({
    reservationId: "deepseek-pro-primary",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reservedAt: RESERVED_AT,
  });
  const deepSeekStatus = await ledger.status({
    provider: "deepseek",
    reservedAt: RESERVED_AT,
  });
  assert.deepEqual(
    {
      pool: deepSeekStatus.pool,
      day: deepSeekStatus.day,
      usedCny: deepSeekStatus.usedCny,
      dailyBudgetCny: deepSeekStatus.dailyBudgetCny,
    },
    {
      pool: "deepseek",
      day: "2026-08-05",
      usedCny: 10,
      dailyBudgetCny: 10,
    },
  );
  await assert.rejects(
    ledger.reserve({
      reservationId: "deepseek-over-limit",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reservedAt: RESERVED_AT,
    }),
    (error) => error?.code === "admin_final_budget_exceeded"
      && error?.details?.pool === "deepseek",
  );

  await ledger.reserve({
    reservationId: "relay-sol-1",
    provider: "relay",
    model: "gpt-5.6-sol",
    reservedAt: RESERVED_AT,
  });
  await ledger.reserve({
    reservationId: "relay-sol-2",
    provider: "relay",
    model: "relay-gpt-5.6-sol",
    reservedAt: RESERVED_AT,
  });
  await assert.rejects(
    ledger.reserve({
      reservationId: "relay-sol-over-limit",
      provider: "relay",
      model: "gpt-5.6-sol",
      reservedAt: RESERVED_AT,
    }),
    (error) => error?.code === "admin_final_budget_exceeded"
      && error?.details?.pool === "relay_sol",
  );
  await ledger.reserve({
    reservationId: "relay-terra-independent",
    provider: "relay",
    model: "gpt-5.6-terra",
    reservedAt: RESERVED_AT,
  });
  await ledger.reserve({
    reservationId: "relay-luna-independent",
    provider: "relay",
    model: "gpt-5.6-luna",
    reservedAt: RESERVED_AT,
  });
  assert.equal(
    (await ledger.status({ provider: "deepseek", reservedAt: RESERVED_AT })).usedCny,
    10,
  );
  assert.equal(
    (await ledger.status({
      provider: "relay",
      model: "gpt-5.6-sol",
      reservedAt: RESERVED_AT,
    })).usedCny,
    10,
  );
  assert.equal(
    (await ledger.status({
      provider: "relay",
      model: "gpt-5.6-terra",
      reservedAt: RESERVED_AT,
    })).usedCny,
    5,
  );
});

test("memory reservations are idempotent and settle or release exactly once", async () => {
  const ledger = createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      openai: { dailyBudgetCny: 20, reservationCny: 7 },
    },
  });
  const base = {
    provider: "openai",
    model: "gpt-5.6-terra",
    reservedAt: RESERVED_AT,
  };

  const first = await ledger.reserve({ ...base, reservationId: "primary" });
  const duplicate = await ledger.reserve({ ...base, reservationId: "primary" });
  assert.equal(first.status, "reserved");
  assert.equal(duplicate.status, "existing");
  assert.equal(duplicate.usedCny, 7);

  const settled = await ledger.settle({
    ...base,
    reservationId: "primary",
    actualCny: 2.345678,
  });
  const duplicateSettlement = await ledger.settle({
    ...base,
    reservationId: "primary",
    actualCny: 2.345678,
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.usedCny, 2.345678);
  assert.equal(duplicateSettlement.status, "existing");
  assert.equal(duplicateSettlement.usedCny, 2.345678);

  await ledger.reserve({ ...base, reservationId: "repair" });
  const released = await ledger.release({ ...base, reservationId: "repair" });
  const duplicateRelease = await ledger.release({ ...base, reservationId: "repair" });
  assert.equal(released.status, "released");
  assert.equal(released.usedCny, 2.345678);
  assert.equal(duplicateRelease.status, "existing");
  assert.equal(duplicateRelease.usedCny, 2.345678);
});

test("an unconfigured provider pool fails closed", async () => {
  const ledger = createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      relay_sol: { dailyBudgetCny: 10, reservationCny: 10 },
    },
  });

  await assert.rejects(
    ledger.reserve({
      reservationId: "missing-deepseek-policy",
      provider: "deepseek",
      reservedAt: RESERVED_AT,
    }),
    (error) => error?.code === "admin_final_budget_unconfigured"
      && error?.outcomeKnown === true
      && error?.budgetReservationMayExist === false,
  );
  await assert.rejects(
    ledger.reserve({
      reservationId: "unknown-relay-model",
      provider: "relay",
      model: "relay-gpt-5.6-unknown",
      reservedAt: RESERVED_AT,
    }),
    (error) => error?.code === "admin_final_budget_unconfigured"
      && /relay model is not budgeted/u.test(error?.message || ""),
  );
});

test("a dynamic worst-case reservation replaces the smaller fixed reservation and fails closed above the pool limit", async () => {
  const ledger = createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      relay_sol: { dailyBudgetCny: 10, reservationCny: 5 },
    },
  });
  const base = {
    provider: "relay",
    model: "relay-gpt-5.6-sol",
    reservedAt: RESERVED_AT,
  };

  const reserved = await ledger.reserve({
    ...base,
    reservationId: "dynamic-within-limit",
    requiredReservationCny: 7.25,
  });
  assert.equal(reserved.reservedCny, 7.25);
  assert.equal(reserved.usedCny, 7.25);

  await assert.rejects(
    ledger.reserve({
      ...base,
      reservationId: "dynamic-above-limit",
      requiredReservationCny: 10.01,
    }),
    (error) => error?.code === "admin_final_budget_exceeded"
      && error?.details?.reservationCny === 10.01
      && error?.details?.dailyBudgetCny === 10,
  );
});

test("concurrent reservations cannot jointly cross the daily limit", async () => {
  const ledger = createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      glm: { dailyBudgetCny: 10, reservationCny: 6 },
    },
  });

  const results = await Promise.allSettled([
    ledger.reserve({
      reservationId: "glm-concurrent-a",
      provider: "glm",
      reservedAt: RESERVED_AT,
    }),
    ledger.reserve({
      reservationId: "glm-concurrent-b",
      provider: "glm",
      reservedAt: RESERVED_AT,
    }),
  ]);

  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(results.find((item) => item.status === "rejected").reason.code, "admin_final_budget_exceeded");
  assert.equal(
    (await ledger.status({ provider: "glm", reservedAt: RESERVED_AT })).usedCny,
    6,
  );
});

test("settlement cannot expand a pre-call reservation or push the ledger past its cap", async () => {
  const ledger = createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      deepseek: { dailyBudgetCny: 10, reservationCny: 2 },
    },
  });
  for (let index = 0; index < 5; index += 1) {
    await ledger.reserve({
      reservationId: `deepseek-${index}`,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reservedAt: RESERVED_AT,
    });
  }

  await assert.rejects(
    ledger.settle({
      reservationId: "deepseek-0",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reservedAt: RESERVED_AT,
      actualCny: 3,
    }),
    (error) => error?.code === "admin_final_budget_state_conflict",
  );
  assert.equal(
    (await ledger.status({ provider: "deepseek", reservedAt: RESERVED_AT })).usedCny,
    10,
  );
});

test("Redis reserve, settle and release each use one atomic EVAL request", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const command = JSON.parse(options.body);
    calls.push({ url, options, command });
    const script = String(command[1] || "");
    if (script.includes("ADMIN_FINAL_BUDGET_RESERVE_V1")) {
      return redisResponse(["RESERVED", "5000000", "5000000", "10000000"]);
    }
    if (script.includes("ADMIN_FINAL_BUDGET_SETTLE_V1")) {
      return redisResponse(["SETTLED", "5000000", "1250000", "1250000"]);
    }
    if (script.includes("ADMIN_FINAL_BUDGET_RELEASE_V1")) {
      return redisResponse(["RELEASED", "5000000", "0"]);
    }
    throw new Error("unexpected Redis command");
  };
  const ledger = createRedisAdminFinalCallBudgetLedger({
    env: {
      ADMIN_RUN_REDIS_REST_URL: "https://redis.example.test",
      ADMIN_RUN_REDIS_REST_TOKEN: "server-only-test-token",
      ADMIN_FINAL_BUDGET_OPENAI_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_OPENAI_RESERVATION_CNY: "5",
      ADMIN_FINAL_BUDGET_TIMEZONE: "UTC",
    },
    fetchImpl,
  });
  const base = {
    provider: "openai",
    model: "gpt-5.6-terra",
    reservedAt: RESERVED_AT,
  };

  await ledger.reserve({ ...base, reservationId: "redis-primary" });
  await ledger.settle({
    ...base,
    reservationId: "redis-primary",
    actualCny: 1.25,
  });
  await ledger.release({ ...base, reservationId: "redis-rejected" });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, "https://redis.example.test");
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers.authorization, "Bearer server-only-test-token");
    assert.equal(call.command[0], "EVAL");
    assert.equal(call.command[2], "1");
    assert.match(call.command[3], /^admin-final-budget:v1:\{openai\}:2026-08-05$/u);
  }
  assert.match(calls[0].command[1], /ADMIN_FINAL_BUDGET_RESERVE_V1/u);
  assert.match(calls[1].command[1], /ADMIN_FINAL_BUDGET_SETTLE_V1/u);
  assert.match(calls[2].command[1], /ADMIN_FINAL_BUDGET_RELEASE_V1/u);
});

function redisResponse(result) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result };
    },
  };
}
