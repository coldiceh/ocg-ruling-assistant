import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRedisEvidencePreprocessBudget,
  initializeRedisEvidencePreprocessLedger,
  readRedisEvidencePreprocessLedger,
} from "../scripts/lib/evidence-preprocess-cache.mjs";
import {
  createCloudEvidencePreprocessResources,
  initializeCloudEvidencePreprocessLedger,
} from "../scripts/lib/evidence-preprocess-cloud.mjs";
import { setupCloudEvidencePreprocessLedger } from "../scripts/setup-cloud-evidence-preprocess-ledger.mjs";

function fakeRedis() {
  const values = new Map();
  const command = async (args) => {
    if (args[0] === "GET") return values.get(args[1]) ?? null;
    const [script, key] = [args[1], args[3]];
    if (script.includes("EVIDENCE_PREPROCESS_LEDGER_INITIALIZE")) {
      if (!values.has(key)) {
        values.set(key, args[4]);
        return ["INITIALIZED", args[4]];
      }
      return ["EXISTING", values.get(key)];
    }
    if (script.includes("EVIDENCE_PREPROCESS_LEDGER_RESERVE")) {
      const ledger = JSON.parse(values.get(key) || "null");
      if (!ledger) return ["MISSING"];
      if (ledger.cloudPreprocessAuthorizationId !== args[4]) return ["AUTHORIZATION_MISMATCH"];
      ledger.tickets ||= {};
      if (ledger.tickets[args[5]]) return ["EXISTING", JSON.stringify(ledger.tickets[args[5]])];
      const amount = Number(args[6]);
      const maxUsd = Number(args[7]);
      const remainingStage = maxUsd - Number(ledger.stageSpentUsd || 0) - Number(ledger.stageReservedUsd || 0);
      const remainingLedger = ledger.limitUsd - ledger.spentUsd - ledger.reservedUsd;
      if (amount > remainingStage || amount > remainingLedger) return ["BLOCKED"];
      const ticket = { state: "reserved", reservedUsd: amount };
      ledger.reservedUsd += amount;
      ledger.stageReservedUsd = Number(ledger.stageReservedUsd || 0) + amount;
      ledger.tickets[args[5]] = ticket;
      values.set(key, JSON.stringify(ledger));
      return ["RESERVED", JSON.stringify(ticket)];
    }
    if (script.includes("EVIDENCE_PREPROCESS_LEDGER_SETTLE")) {
      const ledger = JSON.parse(values.get(key) || "null");
      if (!ledger) return ["MISSING"];
      if (ledger.cloudPreprocessAuthorizationId !== args[4]) return ["AUTHORIZATION_MISMATCH"];
      const row = ledger.tickets?.[args[5]];
      if (!row) return ["TICKET_MISSING"];
      const spent = Number(args[6]);
      if (row.state === "settled") return row.spentUsd === spent
        ? ["SETTLED", JSON.stringify(row)] : ["CONFLICT"];
      if (spent > row.reservedUsd) return ["CONFLICT"];
      ledger.reservedUsd -= row.reservedUsd;
      ledger.stageReservedUsd = Number(ledger.stageReservedUsd || 0) - row.reservedUsd;
      ledger.spentUsd += spent;
      ledger.stageSpentUsd = Number(ledger.stageSpentUsd || 0) + spent;
      Object.assign(row, { state: "settled", spentUsd: spent });
      values.set(key, JSON.stringify(ledger));
      return ["SETTLED", JSON.stringify(row)];
    }
    throw new Error(`unexpected fake Redis command: ${args[0]}`);
  };
  return { command, values };
}

function legacyLedger(overrides = {}) {
  return {
    startedAt: "2026-09-01T00:00:00.000Z",
    decision: "authorized-bounded-run",
    limitUsd: 6,
    spentUsd: 4.603420459857142,
    reservedUsd: 0.160897,
    rows: [{ phase: "historical-paid-work", amountUsd: 4.603420459857142 }],
    tickets: { historical: { state: "reserved", reservedUsd: 0.160897 } },
    ...overrides,
  };
}

test("Redis ledger initialization is one-time and preserves cumulative history across reserve and settle", async () => {
  const redis = fakeRedis();
  const config = {
    command: redis.command,
    ledgerKey: "evidence-preprocess-ledger:v1:{authorized-run}",
    authorizationId: "authorized-run-20260914",
  };
  const original = legacyLedger();
  assert.equal((await initializeRedisEvidencePreprocessLedger({ ...config, ledger: original })).status, "initialized");
  const budget = createRedisEvidencePreprocessBudget({ ...config, maxUsd: 0.25 });
  await budget.reserve({ ticket: "new-request", amountUsd: 0.08 });
  await assert.rejects(
    budget.reserve({ ticket: "too-large", amountUsd: 0.18 }),
    { code: "evidence_preprocess_budget_exceeded" },
  );
  await budget.settle({ ticket: "new-request", spentUsd: 0.03 });

  const after = await readRedisEvidencePreprocessLedger(config);
  assert.deepEqual(after.rows, original.rows);
  assert.equal(after.tickets.historical.reservedUsd, original.tickets.historical.reservedUsd);
  assert.ok(Math.abs(after.spentUsd - (original.spentUsd + 0.03)) < 1e-12);
  assert.ok(Math.abs(after.reservedUsd - original.reservedUsd) < 1e-12);

  const staleBootstrap = legacyLedger({ spentUsd: 0, reservedUsd: 0, tickets: {} });
  assert.equal((await initializeRedisEvidencePreprocessLedger({ ...config, ledger: staleBootstrap })).status, "existing");
  assert.deepEqual(await readRedisEvidencePreprocessLedger(config), after);
});

test("cloud resources require a separately initialized authorized ledger", async () => {
  const redis = fakeRedis();
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer fixture-token");
    const result = await redis.command(JSON.parse(options.body));
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const baseEnv = {
    UPSTASH_BUDGET_KV_REST_API_URL: "https://fixture-redis.example.test",
    UPSTASH_BUDGET_KV_REST_API_TOKEN: "fixture-token",
    EVIDENCE_PREPROCESS_AUTHORIZATION_ID: "authorized-run-20260914",
    EVIDENCE_PREPROCESS_LEDGER_KEY: "evidence-preprocess-ledger:v1:{authorized-run}",
    EVIDENCE_PREPROCESS_CACHE_NAMESPACE: "authorized-run-20260914",
    EVIDENCE_PREPROCESS_MAX_USD: "0.25",
  };
  await assert.rejects(
    createCloudEvidencePreprocessResources({ env: baseEnv, fetchImpl }),
    /redis_ledger_missing/u,
  );
  assert.equal((await initializeCloudEvidencePreprocessLedger({
    env: baseEnv, ledger: legacyLedger(), fetchImpl,
  })).status, "initialized");
  const resources = await createCloudEvidencePreprocessResources({ env: baseEnv, fetchImpl });
  assert.equal(resources.cache.kind, "redis-evidence-preprocess-cache");
  assert.equal(resources.budget.kind, "redis-evidence-preprocess-budget");
});

test("setup CLI entrypoint exposes only a summary and cannot replace an initialized ledger", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-preprocess-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "authorized-ledger.json");
  const redis = fakeRedis();
  const fetchImpl = async (_url, options) => {
    const result = await redis.command(JSON.parse(options.body));
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = {
    UPSTASH_BUDGET_KV_REST_API_URL: "https://fixture-redis.example.test",
    UPSTASH_BUDGET_KV_REST_API_TOKEN: "fixture-token",
    EVIDENCE_PREPROCESS_AUTHORIZATION_ID: "authorized-run-20260914",
    EVIDENCE_PREPROCESS_LEDGER_KEY: "evidence-preprocess-ledger:v1:{authorized-run}",
    EVIDENCE_PREPROCESS_CACHE_NAMESPACE: "authorized-run-20260914",
  };
  const original = legacyLedger();
  await writeFile(ledgerPath, JSON.stringify(original), "utf8");

  assert.deepEqual(await setupCloudEvidencePreprocessLedger({ ledgerPath, env, fetchImpl }), {
    status: "initialized",
    limitUsd: original.limitUsd,
    spentUsd: original.spentUsd,
    reservedUsd: original.reservedUsd,
  });

  const stale = legacyLedger({ spentUsd: 0, reservedUsd: 0, rows: [], tickets: {} });
  await writeFile(ledgerPath, JSON.stringify(stale), "utf8");
  assert.deepEqual(await setupCloudEvidencePreprocessLedger({ ledgerPath, env, fetchImpl }), {
    status: "existing",
    limitUsd: original.limitUsd,
    spentUsd: original.spentUsd,
    reservedUsd: original.reservedUsd,
  });
});
