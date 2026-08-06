import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_RUN_CLEANUP_CONFIRMATION,
  executeAdminRunCleanup,
  planAdminRunCleanup,
} from "../backend/adminRunRedisCleanup.mjs";
import {
  parseAdminRunCleanupArguments,
  runAdminRunCleanupCli,
} from "../scripts/cleanup-upstash-admin-runs.mjs";

const RUN_URL = "https://run-redis.invalid";
const HISTORY_URL = "https://history-redis.invalid";
const RUN_PREFIX = "admin-runs:v1";
const HISTORY_PREFIX = "admin-lab-records:v1";
const NOW = new Date("2026-08-06T12:00:00.000Z");
const OLD = "2026-06-01T00:00:00.000Z";
const RECENT = "2026-08-06T11:30:00.000Z";

test("cleanup dry-run performs zero writes, retains only fingerprints, and isolates namespaces", async () => {
  const redis = createRedisFixture();
  seedRun(redis.run, { runId: "old/run", question: "不得输出的完整问题" });
  seedHistory(redis.history, "old/run", "不得输出的问题摘要");
  redis.run.strings.set("rag-query-audit:v1", "question history");
  redis.run.strings.set("admin-final-budget:v1:2026-08-06", "budget");
  redis.run.strings.set("ocg-admin:v1:session", "session");
  redis.run.strings.set("rag-public-answer-latency:v1:value", "latency");

  const report = await planFixture(redis, { olderThanDays: 7 });

  assert.equal(report.mode, "dry_run");
  assert.equal(report.canExecute, true, JSON.stringify(report));
  assert.match(report.planFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].keyCount, 3);
  assert.equal(report.historyRetentionNotice.includes("500"), true);
  assert.equal(redis.commands.some((item) => item.command[0] === "EVAL"), false);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /不得输出的完整问题|old\/run|run-redis|history-redis|run-token|history-token/u);
  assert.deepEqual(report.namespaceIsolation, {
    adminRunOnly: true,
    historyReadOnly: true,
    queryAuditTouched: false,
    sessionTouched: false,
    budgetTouched: false,
    latencyTouched: false,
  });
  const touchedKeys = redis.commands.flatMap((entry) => entry.command.slice(1).map(String));
  assert.equal(touchedKeys.some((value) => /rag-query-audit|admin-final-budget|ocg-admin|answer-latency/u.test(value)), false);
});

test("cleanup candidate selection fails closed for nonterminal, recent, active-lease, invalid, and unarchived runs", async () => {
  const redis = createRedisFixture();
  seedRun(redis.run, { runId: "nonterminal", status: "RUNNING" });
  seedHistory(redis.history, "nonterminal", "nonterminal question");
  seedRun(redis.run, { runId: "recent", endedAt: RECENT, updatedAt: RECENT });
  seedHistory(redis.history, "recent", "recent question");
  seedRun(redis.run, {
    runId: "exact-cutoff",
    endedAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  });
  seedHistory(redis.history, "exact-cutoff", "cutoff question");
  seedRun(redis.run, {
    runId: "leased",
    lease: { expiresAt: "2026-08-06T13:00:00.000Z" },
  });
  seedHistory(redis.history, "leased", "leased question");
  seedRun(redis.run, { runId: "no-history" });
  seedRun(redis.run, { runId: "invalid" });
  redis.run.strings.set(runKeys("invalid").state, "{bad-json");

  const report = await planFixture(redis, { olderThanDays: 7 });
  const reasons = new Set(report.skipped.flatMap((item) => item.reasons));

  assert.equal(report.candidates.length, 0);
  assert.equal(report.canExecute, false);
  assert.equal(reasons.has("run_not_terminal"), true);
  assert.equal(reasons.has("run_not_older_than_threshold"), true);
  assert.equal(reasons.has("active_execution_lease"), true);
  assert.equal(reasons.has("history_question_summary_missing"), true);
  assert.equal(reasons.has("run_state_invalid"), true);
});

test("a retained fork protects its source full snapshot while the old source state and events can be deleted", async () => {
  const redis = createRedisFixture();
  const source = seedRun(redis.run, { runId: "old-source", question: "source question" });
  seedHistory(redis.history, "old-source", "source question");
  const fork = seedRun(redis.run, {
    runId: "new-fork",
    question: "source question",
    endedAt: RECENT,
    updatedAt: RECENT,
    snapshotRecord: {
      recordType: "admin_evidence_snapshot_reference",
      schemaVersion: 1,
      ownerRunId: "old-source",
      snapshotId: source.snapshotId,
      contentSha256: source.hash,
    },
    snapshotId: source.snapshotId,
    hash: source.hash,
  });
  seedHistory(redis.history, "new-fork", "source question");

  const plan = await planFixture(redis, { olderThanDays: 7 });
  assert.equal(plan.canExecute, true);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].protectedSnapshotKeyCount, 1);
  assert.equal(plan.candidates[0].keyCount, 2);

  const result = await executeAdminRunCleanup(plan, {
    execute: true,
    confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
    approvalFingerprint: plan.planFingerprint,
    fetchImpl: redis.fetchImpl,
  });

  assert.equal(result.deletedRunCount, 1);
  assert.equal(redis.run.strings.has(runKeys("old-source", source.snapshotId).state), false);
  assert.equal(redis.run.lists.has(runKeys("old-source", source.snapshotId).events), false);
  assert.equal(redis.run.strings.has(runKeys("old-source", source.snapshotId).snapshot), true);
  assert.equal(redis.run.strings.has(runKeys("new-fork", fork.snapshotId).snapshot), true);
  assert.equal(redis.history.strings.has(historyKey("old-source")), true);
  assert.deepEqual(
    [...new Set(redis.commands
      .filter((entry) => entry.url === HISTORY_URL)
      .map((entry) => entry.command[0]))],
    ["GET"],
  );
  const appliedEval = redis.commands.find((entry) => entry.command[0] === "EVAL");
  assert.ok(appliedEval);
  assert.equal(appliedEval.command.slice(3, 5).every((key) => (
    String(key).startsWith(`${RUN_PREFIX}:{old-source}:`)
  )), true);
});

test("execution requires the exact confirmation and CAS refuses a changed state without deleting the group", async () => {
  const redis = createRedisFixture();
  const seeded = seedRun(redis.run, { runId: "cas-run" });
  seedHistory(redis.history, "cas-run", "CAS question");
  const plan = await planFixture(redis, { olderThanDays: 7 });

  await assert.rejects(
    executeAdminRunCleanup(plan, { execute: true, confirmation: "wrong", fetchImpl: redis.fetchImpl }),
    { code: "admin_run_cleanup_refused" },
  );
  await assert.rejects(
    executeAdminRunCleanup(plan, {
      execute: true,
      confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
      fetchImpl: redis.fetchImpl,
    }),
    { code: "admin_run_cleanup_refused" },
  );
  const keys = runKeys("cas-run", seeded.snapshotId);
  const changed = JSON.parse(redis.run.strings.get(keys.state));
  changed.revision += 1;
  changed.lastSequence += 1;
  redis.run.strings.set(keys.state, JSON.stringify(changed));

  await assert.rejects(
    executeAdminRunCleanup(plan, {
      execute: true,
      confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
      approvalFingerprint: plan.planFingerprint,
      fetchImpl: redis.fetchImpl,
    }),
    { code: "admin_run_cleanup_conflict" },
  );
  assert.equal(redis.run.strings.has(keys.state), true);
  assert.equal(redis.run.lists.has(keys.events), true);
  assert.equal(redis.run.strings.has(keys.snapshot), true);
});

test("execution binds approval to the reviewed plan and stops if the run namespace changes", async () => {
  const redis = createRedisFixture();
  const seeded = seedRun(redis.run, { runId: "reviewed-run" });
  seedHistory(redis.history, "reviewed-run", "reviewed question");
  const plan = await planFixture(redis, { olderThanDays: 7 });

  await assert.rejects(
    executeAdminRunCleanup(plan, {
      execute: true,
      confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
      approvalFingerprint: "f".repeat(64),
      fetchImpl: redis.fetchImpl,
    }),
    { code: "admin_run_cleanup_refused" },
  );

  redis.run.strings.set(`${RUN_PREFIX}:{new-fork}:snapshot:evidence_${"b".repeat(24)}`, "staged");
  await assert.rejects(
    executeAdminRunCleanup(plan, {
      execute: true,
      confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
      approvalFingerprint: plan.planFingerprint,
      fetchImpl: redis.fetchImpl,
    }),
    { code: "admin_run_cleanup_conflict" },
  );
  const keys = runKeys("reviewed-run", seeded.snapshotId);
  assert.equal(redis.run.strings.has(keys.state), true);
  assert.equal(redis.run.lists.has(keys.events), true);
  assert.equal(redis.run.strings.has(keys.snapshot), true);
  assert.equal(redis.commands.some((entry) => entry.command[0] === "EVAL"), false);
});

test("incomplete reference graphs and configurable hard limits block execution", async () => {
  const broken = createRedisFixture();
  const seeded = seedRun(broken.run, { runId: "broken-ref" });
  seedHistory(broken.history, "broken-ref", "broken question");
  broken.run.strings.set(runKeys("broken-ref", seeded.snapshotId).snapshot, JSON.stringify({
    recordType: "admin_evidence_snapshot_reference",
    schemaVersion: 1,
    ownerRunId: "missing-owner",
    snapshotId: seeded.snapshotId,
    contentSha256: seeded.hash,
  }));
  const brokenPlan = await planFixture(broken, { olderThanDays: 7 });
  assert.equal(brokenPlan.canExecute, false);
  assert.equal(brokenPlan.blockReasons.includes("snapshot_reference_target_missing"), true);

  const limited = createRedisFixture();
  seedRun(limited.run, { runId: "limited" });
  seedHistory(limited.history, "limited", "limited question");
  const limitedPlan = await planFixture(limited, {
    olderThanDays: 7,
    limits: { maxRuns: 1, maxKeys: 2, maxKnownBytes: 1_000_000, maxScanKeys: 100 },
  });
  assert.equal(limitedPlan.canExecute, false);
  assert.equal(limitedPlan.blockReasons.includes("max_keys_exceeded"), true);
});

test("legacy History records qualify, while unknown Admin Run keys block the whole plan", async () => {
  const legacy = createRedisFixture();
  seedRun(legacy.run, { runId: "legacy-history" });
  seedHistory(legacy.history, "legacy-history", "legacy summary", { legacy: true });
  const legacyPlan = await planFixture(legacy, { olderThanDays: 7 });
  assert.equal(legacyPlan.canExecute, true);
  assert.equal(legacyPlan.candidates[0].historyRecordKind, "legacy");

  const unknown = createRedisFixture();
  seedRun(unknown.run, { runId: "known-run" });
  seedHistory(unknown.history, "known-run", "known summary");
  unknown.run.strings.set(`${RUN_PREFIX}:future-schema:key`, "future");
  const unknownPlan = await planFixture(unknown, { olderThanDays: 7 });
  assert.equal(unknownPlan.canExecute, false);
  assert.equal(unknownPlan.blockReasons.includes("unknown_admin_run_key"), true);
});

test("CLI is dry-run by default and requires an explicit age threshold plus exact execute phrase", async () => {
  assert.deepEqual(parseAdminRunCleanupArguments(["--older-than-days", "30"]), {
    olderThanDays: 30,
    execute: false,
    confirmation: "",
    approvalFingerprint: "",
    compact: false,
    limits: {
      maxRuns: 25,
      maxKeys: 250,
      maxKnownBytes: 134_217_728,
      maxScanKeys: 20_000,
    },
  });
  assert.equal(
    parseAdminRunCleanupArguments(["--", "--older-than-days", "30"]).olderThanDays,
    30,
  );
  await assert.rejects(
    runAdminRunCleanupCli([], { stdout: { write() {} } }),
    /--older-than-days is required/u,
  );
  let executeCalls = 0;
  let output = "";
  const fakePlan = Object.freeze({ mode: "dry_run" });
  const report = await runAdminRunCleanupCli(["--older-than-days", "30", "--compact"], {
    stdout: { write(value) { output += value; } },
    planCleanup: async () => fakePlan,
    executeCleanup: async () => { executeCalls += 1; },
  });
  assert.equal(report, fakePlan);
  assert.equal(executeCalls, 0);
  assert.equal(output, '{"mode":"dry_run"}\n');
  await assert.rejects(
    runAdminRunCleanupCli(["--older-than-days", "30", "--execute", "--confirm", "wrong"], {
      stdout: { write() {} },
    }),
    { code: "admin_run_cleanup_refused" },
  );
  await assert.rejects(
    runAdminRunCleanupCli([
      "--older-than-days",
      "30",
      "--execute",
      "--confirm",
      ADMIN_RUN_CLEANUP_CONFIRMATION,
    ], {
      stdout: { write() {} },
    }),
    { code: "admin_run_cleanup_refused" },
  );
});

async function planFixture(redis, options) {
  return planAdminRunCleanup({
    ...options,
    now: NOW,
    runConnection: { url: RUN_URL, token: "run-token" },
    historyConnection: { url: HISTORY_URL, token: "history-token" },
    fetchImpl: redis.fetchImpl,
  });
}

function seedRun(store, {
  runId,
  status = "SUCCEEDED",
  endedAt = OLD,
  updatedAt = OLD,
  lease = null,
  question = `${runId} question`,
  hash = "a".repeat(64),
  snapshotId = `evidence_${hash.slice(0, 24)}`,
  snapshotRecord = null,
} = {}) {
  const keys = runKeys(runId, snapshotId);
  store.strings.set(keys.state, JSON.stringify({
    schemaVersion: 1,
    runId,
    revision: 1,
    lastSequence: 1,
    status,
    createdAt: OLD,
    updatedAt,
    startedAt: OLD,
    endedAt,
    evidenceSnapshotId: snapshotId,
    execution: { lease },
  }));
  store.lists.set(keys.events, [JSON.stringify({ runId, sequence: 1 })]);
  store.strings.set(keys.snapshot, JSON.stringify(snapshotRecord || {
    schemaVersion: 1,
    snapshotId,
    contentSha256: hash,
    createdAt: OLD,
    question,
    evidence: {},
    dataVersions: {},
    metadata: {},
  }));
  return { keys, hash, snapshotId };
}

function seedHistory(store, runId, questionSummary, { legacy = false } = {}) {
  const key = legacy
    ? `${HISTORY_PREFIX}:run:${encodeURIComponent(runId)}`
    : historyKey(runId);
  store.strings.set(key, JSON.stringify({
    schemaVersion: 1,
    runId,
    createdAt: OLD,
    questionSummary,
    modelConfig: {},
  }));
  return key;
}

function runKeys(runId, snapshotId = `evidence_${"a".repeat(24)}`) {
  const tag = encodeURIComponent(runId);
  return {
    state: `${RUN_PREFIX}:{${tag}}:state`,
    events: `${RUN_PREFIX}:{${tag}}:events`,
    snapshot: `${RUN_PREFIX}:{${tag}}:snapshot:${encodeURIComponent(snapshotId)}`,
  };
}

function historyKey(runId) {
  return `{${HISTORY_PREFIX}}:run:${encodeURIComponent(runId)}`;
}

function createRedisFixture() {
  const run = createStore();
  const history = createStore();
  const commands = [];
  return {
    run,
    history,
    commands,
    async fetchImpl(url, init) {
      const store = String(url) === RUN_URL ? run : history;
      const command = JSON.parse(init.body);
      commands.push({ url: String(url), command });
      const result = executeMockCommand(store, command);
      return {
        ok: true,
        status: 200,
        async json() { return { result }; },
      };
    },
  };
}

function createStore() {
  return { strings: new Map(), lists: new Map() };
}

function executeMockCommand(store, command) {
  const operation = String(command[0]).toUpperCase();
  if (operation === "SCAN") {
    const pattern = String(command[3]);
    const keys = [...store.strings.keys(), ...store.lists.keys()]
      .filter((key) => globMatches(pattern, key));
    return ["0", keys];
  }
  if (operation === "TYPE") {
    if (store.strings.has(command[1])) return "string";
    if (store.lists.has(command[1])) return "list";
    return "none";
  }
  if (operation === "GET") return store.strings.get(command[1]) ?? null;
  if (operation === "STRLEN") {
    const value = store.strings.get(command[1]);
    return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
  }
  if (operation === "MEMORY") {
    const key = command[2];
    if (store.strings.has(key)) return Buffer.byteLength(store.strings.get(key), "utf8") + 32;
    if (store.lists.has(key)) {
      return store.lists.get(key).reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 32);
    }
    return null;
  }
  if (operation === "EVAL" && String(command[1]).includes("admin-run-cleanup-delete-v1")) {
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const expectedState = command[3 + keyCount];
    const expectedRunId = command[4 + keyCount];
    const current = store.strings.get(keys[0]);
    if (current === undefined) return "NOT_FOUND";
    if (current !== expectedState) return "STATE_CHANGED";
    const parsed = JSON.parse(current);
    if (parsed.runId !== expectedRunId || !["SUCCEEDED", "FAILED", "CANCELLED"].includes(parsed.status)) {
      return "INVALID_STATE";
    }
    if (keys.some((key) => !store.strings.has(key) && !store.lists.has(key))) return "MISSING_KEY";
    let deleted = 0;
    for (const key of keys) {
      if (store.strings.delete(key)) deleted += 1;
      else if (store.lists.delete(key)) deleted += 1;
    }
    return `DELETED:${deleted}`;
  }
  throw new Error(`unsupported mock command: ${JSON.stringify(command)}`);
}

function globMatches(pattern, value) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) {
      source += escapeRegex(pattern[++index]);
    } else if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`, "u").test(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
