import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  ADMIN_RUN_CLEANUP_CONFIRMATION,
  ADMIN_RUN_HISTORY_BACKFILL_CONFIRMATION,
  ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
  executeAdminRunCleanup,
  executeAdminRunHistoryBackfill,
  planAdminRunCleanup,
  planAdminRunHistoryBackfill,
} from "../backend/adminRunRedisCleanup.mjs";
import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
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

test("History backfill plan is read-only, aggregate-only, and does not leak identifiers or values", async () => {
  const redis = createRedisFixture();
  const secretQuestion = "不得输出的完整问题：霸王眷龙与同伴的牵绊";
  const secretRunId = "private/run-id";
  seedBackfillRun(redis.run, { runId: secretRunId, question: secretQuestion });
  const sentinels = seedUnrelatedSentinels(redis.run);

  const report = await planBackfillFixture(redis, { olderThanDays: 7 });

  assert.equal(report.mode, "backfill_dry_run");
  assert.equal(report.canExecute, true, JSON.stringify(report));
  assert.equal(report.totals.runCount, 1);
  assert.equal(report.valuesExposed, false);
  assert.equal(report.questionsExposed, false);
  assert.equal(report.runIdsExposed, false);
  assert.equal(report.redisKeysExposed, false);
  assert.equal(report.secretsExposed, false);
  assert.deepEqual(report.namespaceIsolation, {
    adminRunTouched: false,
    historyQuestionOnlyWrite: true,
    queryAuditTouched: false,
    sessionTouched: false,
    budgetTouched: false,
    latencyTouched: false,
    feedbackTouched: false,
  });
  assert.equal(redis.commands.some(({ command }) => command[0] === "EVAL"), false);
  assert.equal(
    redis.commands.every(({ command }) => ["SCAN", "TYPE", "GET", "ZSCORE"].includes(command[0])),
    true,
  );
  assertSentinelsUnchanged(redis.run, sentinels);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(
    serialized,
    new RegExp([
      escapeRegex(secretQuestion),
      escapeRegex(secretRunId),
      "admin-runs:v1",
      "admin-lab-records:v1",
      "run-redis",
      "history-redis",
      "run-token",
      "history-token",
    ].join("|"), "u"),
  );
});

test("History backfill accepts legacy full, gzip full, and resolved reference snapshots", async () => {
  const redis = createRedisFixture();
  const legacy = seedBackfillRun(redis.run, {
    runId: "legacy-full",
    question: "legacy full question",
  });
  const gzip = seedBackfillRun(redis.run, {
    runId: "gzip-full",
    question: "gzip full question",
    encoding: "gzip",
  });
  const owner = seedBackfillRun(redis.run, {
    runId: "reference-owner",
    question: "reference question",
    endedAt: RECENT,
    updatedAt: RECENT,
  });
  seedBackfillRun(redis.run, {
    runId: "reference-child",
    snapshot: owner.snapshot,
    snapshotRecord: snapshotReference("reference-owner", owner.snapshot),
  });

  const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
  assert.equal(plan.canExecute, true, JSON.stringify(plan));
  assert.equal(plan.totals.runCount, 3);
  assert.equal(plan.scanned.snapshotRecordCount, 4);

  const result = await executeBackfill(redis, plan);
  assert.equal(result.backfilledRunCount, 3);
  assert.equal(readHistory(redis.history, "legacy-full").questionSummary, legacy.snapshot.question);
  assert.equal(readHistory(redis.history, "gzip-full").questionSummary, gzip.snapshot.question);
  assert.equal(readHistory(redis.history, "reference-child").questionSummary, owner.snapshot.question);
  assert.equal(redis.history.strings.has(historyKey("reference-owner")), false);
});

test("History backfill normalizes whitespace, truncates to 500 characters, and copies no other snapshot or event data", async () => {
  const redis = createRedisFixture();
  const question = `  问题开头\n\t${"甲".repeat(600)}   问题结尾  `;
  const forbidden = {
    answer: "FORBIDDEN_ANSWER",
    reasoning: "FORBIDDEN_REASONING_CONTENT",
    evidence: "FORBIDDEN_EVIDENCE",
    result: "FORBIDDEN_RESULT",
    event: "FORBIDDEN_EVENT",
  };
  const seeded = seedBackfillRun(redis.run, {
    runId: "minimal-record",
    question,
    evidence: {
      answer: forbidden.answer,
      reasoning_content: forbidden.reasoning,
      evidence: forbidden.evidence,
    },
    metadata: { result: forbidden.result },
    eventValue: JSON.stringify({ result: forbidden.event, answer: forbidden.answer }),
  });
  const sentinels = seedUnrelatedSentinels(redis.run);
  const runBefore = snapshotStore(redis.run);

  const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
  await executeBackfill(redis, plan);

  const raw = redis.history.strings.get(historyKey("minimal-record"));
  const record = JSON.parse(raw);
  const expected = question.replace(/\s+/gu, " ").trim().slice(0, 500);
  assert.equal(record.questionSummary, expected);
  assert.equal(record.questionSummary.length, 500);
  assert.deepEqual(Object.keys(record).sort(), [
    "createdAt",
    "modelConfig",
    "questionSummary",
    "runId",
    "schemaVersion",
  ]);
  assert.deepEqual(record.modelConfig, {});
  for (const value of Object.values(forbidden)) assert.equal(raw.includes(value), false);
  assert.deepEqual(snapshotStore(redis.run), runBefore);
  assertSentinelsUnchanged(redis.run, sentinels);
  assert.equal(redis.run.strings.has(seeded.keys.snapshot), true);
  assert.equal(redis.run.lists.has(seeded.keys.events), true);
  const writes = redis.commands.filter(({ command }) => command[0] === "EVAL");
  assert.equal(writes.length, 1);
  assert.equal(String(writes[0].command[1]).includes("admin-run-history-question-backfill-v1"), true);
  assert.deepEqual(writes[0].command.slice(3, 5), [
    historyKey("minimal-record"),
    historyIndexKey(),
  ]);
  assert.equal(redis.commands.some(({ command }) => command[0] === "DEL"), false);
});

test("History backfill fails closed for corrupt gzip, noncanonical base64, size mismatch, and content hash mismatch", async (t) => {
  const cases = [
    ["corrupt gzip", (record) => {
      const payload = Buffer.from("not a gzip stream").toString("base64");
      return { ...record, payload, compressedBytes: Buffer.byteLength("not a gzip stream") };
    }],
    ["noncanonical base64", (record) => ({ ...record, payload: `${record.payload}\n` })],
    ["compressed size mismatch", (record) => ({ ...record, compressedBytes: record.compressedBytes + 1 })],
    ["content hash mismatch", (_record, snapshot) => ({ ...snapshot, question: `${snapshot.question} changed` })],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const redis = createRedisFixture();
      const seeded = seedBackfillRun(redis.run, {
        runId: `invalid-${name.replaceAll(" ", "-")}`,
        question: "integrity protected question",
        encoding: name === "content hash mismatch" ? "legacy" : "gzip",
      });
      const raw = JSON.parse(redis.run.strings.get(seeded.keys.snapshot));
      redis.run.strings.set(seeded.keys.snapshot, JSON.stringify(mutate(raw, seeded.snapshot)));
      const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
      assert.equal(plan.canExecute, false, JSON.stringify(plan));
      assert.equal(plan.totals.runCount, 0);
      assert.equal(plan.blockReasons.includes("snapshot_graph_incomplete"), true);
      assert.equal(redis.commands.some(({ command }) => command[0] === "EVAL"), false);
      assert.equal(redis.history.strings.has(historyKey(`invalid-${name.replaceAll(" ", "-")}`)), false);
    });
  }
});

test("History backfill fails closed for missing, cyclic, and hash-conflicting snapshot references", async (t) => {
  await t.test("missing target", async () => {
    const redis = createRedisFixture();
    const snapshot = createAdminEvidenceSnapshot({ question: "missing target" , createdAt: OLD });
    seedBackfillRun(redis.run, {
      runId: "missing-reference",
      snapshot,
      snapshotRecord: snapshotReference("missing-owner", snapshot),
    });
    const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
    assert.equal(plan.canExecute, false);
    assert.equal(plan.blockReasons.includes("snapshot_reference_target_missing"), true);
  });

  await t.test("reference cycle", async () => {
    const redis = createRedisFixture();
    const snapshot = createAdminEvidenceSnapshot({ question: "cycle" , createdAt: OLD });
    seedBackfillRun(redis.run, {
      runId: "cycle-a",
      snapshot,
      snapshotRecord: snapshotReference("cycle-b", snapshot),
    });
    seedBackfillRun(redis.run, {
      runId: "cycle-b",
      snapshot,
      snapshotRecord: snapshotReference("cycle-a", snapshot),
    });
    const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
    assert.equal(plan.canExecute, false);
    assert.equal(plan.blockReasons.includes("snapshot_reference_cycle"), true);
  });

  await t.test("reference hash conflict", async () => {
    const redis = createRedisFixture();
    const owner = seedBackfillRun(redis.run, {
      runId: "hash-owner",
      question: "hash owner",
      endedAt: RECENT,
      updatedAt: RECENT,
    });
    const differentTail = owner.snapshot.contentSha256[24] === "f" ? "e" : "f";
    const conflictingHash = `${owner.snapshot.contentSha256.slice(0, 24)}${differentTail.repeat(40)}`;
    seedBackfillRun(redis.run, {
      runId: "hash-child",
      snapshot: owner.snapshot,
      snapshotRecord: {
        ...snapshotReference("hash-owner", owner.snapshot),
        contentSha256: conflictingHash,
      },
    });
    const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
    assert.equal(plan.canExecute, false);
    assert.equal(plan.blockReasons.includes("snapshot_reference_hash_conflict"), true);
  });
});

test("History backfill never overwrites valid or malformed existing History records", async () => {
  const redis = createRedisFixture();
  seedBackfillRun(redis.run, { runId: "valid-history", question: "new valid question" });
  seedBackfillRun(redis.run, { runId: "malformed-history", question: "new malformed question" });
  const validRaw = JSON.stringify({
    schemaVersion: 1,
    runId: "valid-history",
    createdAt: OLD,
    questionSummary: "existing valid summary",
    modelConfig: {},
  });
  const malformedRaw = "{malformed-history";
  redis.history.strings.set(historyKey("valid-history"), validRaw);
  redis.history.strings.set(historyKey("malformed-history"), malformedRaw);

  const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
  assert.equal(plan.canExecute, false);
  assert.equal(plan.totals.runCount, 0);
  assert.equal(plan.skipped.reasonCounts.history_record_already_exists, 1);
  assert.equal(plan.skipped.reasonCounts.history_record_invalid, 1);
  assert.equal(redis.history.strings.get(historyKey("valid-history")), validRaw);
  assert.equal(redis.history.strings.get(historyKey("malformed-history")), malformedRaw);
  assert.equal(redis.commands.some(({ command }) => command[0] === "EVAL"), false);
});

test("History backfill execution conflicts if state, snapshot, or History changes after planning", async (t) => {
  for (const kind of ["state", "snapshot", "history"]) {
    await t.test(kind, async () => {
      const redis = createRedisFixture();
      const seeded = seedBackfillRun(redis.run, { runId: `changed-${kind}` });
      const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
      if (kind === "state") {
        const state = JSON.parse(redis.run.strings.get(seeded.keys.state));
        state.revision += 1;
        redis.run.strings.set(seeded.keys.state, JSON.stringify(state));
      } else if (kind === "snapshot") {
        redis.run.strings.set(
          seeded.keys.snapshot,
          `${redis.run.strings.get(seeded.keys.snapshot)} `,
        );
      } else {
        seedHistory(redis.history, `changed-${kind}`, "appeared after planning");
      }
      await assert.rejects(
        executeBackfill(redis, plan),
        { code: "admin_run_cleanup_conflict" },
      );
      assert.equal(redis.run.strings.has(seeded.keys.state), true);
      assert.equal(redis.run.lists.has(seeded.keys.events), true);
      assert.equal(redis.run.strings.has(seeded.keys.snapshot), true);
      assert.equal(redis.commands.some(({ command }) => command[0] === "DEL"), false);
    });
  }
});

test("a partially failed History backfill can be replanned and resumed without overwriting completed records", async () => {
  const redis = createRedisFixture();
  seedBackfillRun(redis.run, { runId: "partial-first", question: "first question" });
  seedBackfillRun(redis.run, { runId: "partial-second", question: "second question" });
  const plan = await planBackfillFixture(redis, { olderThanDays: 7 });
  redis.history.failBackfillEvalAt = 2;

  await assert.rejects(
    executeBackfill(redis, plan),
    { code: "admin_run_cleanup_conflict" },
  );
  const firstRaw = redis.history.strings.get(historyKey("partial-first"));
  assert.equal(typeof firstRaw, "string");
  assert.equal(redis.history.strings.has(historyKey("partial-second")), false);

  const retryPlan = await planBackfillFixture(redis, { olderThanDays: 7 });
  assert.equal(retryPlan.canExecute, true, JSON.stringify(retryPlan));
  assert.equal(retryPlan.totals.runCount, 1);
  await executeBackfill(redis, retryPlan);
  assert.equal(redis.history.strings.get(historyKey("partial-first")), firstRaw);
  assert.equal(readHistory(redis.history, "partial-second").questionSummary, "second question");
  assert.equal(redis.history.zsets.get(historyIndexKey()).size, 2);
});

test("cleanup requires a fresh plan after question-only History backfill and then retains History", async () => {
  const redis = createRedisFixture();
  const seeded = seedBackfillRun(redis.run, { runId: "backfill-then-delete" });
  const staleCleanupPlan = await planFixture(redis, { olderThanDays: 7 });
  assert.equal(staleCleanupPlan.canExecute, false);

  const backfillPlan = await planBackfillFixture(redis, { olderThanDays: 7 });
  await executeBackfill(redis, backfillPlan);
  await assert.rejects(
    executeAdminRunCleanup(staleCleanupPlan, {
      execute: true,
      confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
      writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
      approvalFingerprint: staleCleanupPlan.planFingerprint,
      fetchImpl: redis.fetchImpl,
    }),
    { code: "admin_run_cleanup_refused" },
  );

  const freshCleanupPlan = await planFixture(redis, { olderThanDays: 7 });
  assert.equal(freshCleanupPlan.canExecute, true, JSON.stringify(freshCleanupPlan));
  await executeAdminRunCleanup(freshCleanupPlan, {
    execute: true,
    confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
    writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    approvalFingerprint: freshCleanupPlan.planFingerprint,
    fetchImpl: redis.fetchImpl,
  });
  assert.equal(redis.run.strings.has(seeded.keys.state), false);
  assert.equal(redis.run.lists.has(seeded.keys.events), false);
  assert.equal(redis.run.strings.has(seeded.keys.snapshot), false);
  assert.equal(readHistory(redis.history, "backfill-then-delete").questionSummary, "backfill-then-delete question");
});

test("cleanup dry-run performs zero writes, exposes aggregates only, and isolates namespaces", async () => {
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
  assert.equal(report.totals.runCount, 1);
  assert.equal(report.totals.keyCount, 3);
  assert.equal(report.historyRetentionNotice.includes("500"), true);
  assert.equal(redis.commands.some((item) => item.command[0] === "EVAL"), false);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /不得输出的完整问题|old\/run|run-redis|history-redis|run-token|history-token/u);
  assert.doesNotMatch(serialized, /runFingerprint|keyFingerprints/u);
  assert.deepEqual(report.namespaceIsolation, {
    adminRunOnly: true,
    historyReadOnly: true,
    queryAuditTouched: false,
    sessionTouched: false,
    budgetTouched: false,
    latencyTouched: false,
    feedbackTouched: false,
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
  const reasons = new Set(Object.keys(report.skipped.reasonCounts));

  assert.equal(report.totals.runCount, 0);
  assert.equal(report.canExecute, false);
  assert.equal(reasons.has("run_not_terminal"), true);
  assert.equal(reasons.has("run_not_older_than_threshold"), true);
  assert.equal(reasons.has("active_execution_lease"), true);
  assert.equal(reasons.has("history_question_summary_missing"), true);
  assert.equal(reasons.has("run_state_invalid"), true);
});

test("referenced snapshots are reclaimed only on a later plan after the fork is deleted", async () => {
  const redis = createRedisFixture();
  const source = seedRun(redis.run, { runId: "old-source", question: "source question" });
  seedHistory(redis.history, "old-source", "source question");
  const fork = seedRun(redis.run, {
    runId: "new-fork",
    question: "source question",
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
  assert.equal(plan.totals.runCount, 1);
  assert.equal(plan.totals.protectedSnapshotKeyCount, 1);
  assert.equal(plan.totals.keyCount, 3);
  assert.equal(plan.skipped.reasonCounts.snapshot_referenced_by_existing_run, 1);

  const result = await executeAdminRunCleanup(plan, {
    execute: true,
    confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
    writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    approvalFingerprint: plan.planFingerprint,
    fetchImpl: redis.fetchImpl,
  });

  assert.equal(result.deletedRunCount, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    "confirmationAccepted",
    "deletedKeyCount",
    "deletedRunCount",
    "executedAt",
    "historyRetentionNotice",
    "mode",
    "questionsExposed",
    "schemaVersion",
    "writeQuiescence",
    "writesDisabledConfirmationAccepted",
  ]);
  assert.equal(redis.run.strings.has(runKeys("old-source", source.snapshotId).state), true);
  assert.equal(redis.run.lists.has(runKeys("old-source", source.snapshotId).events), true);
  assert.equal(redis.run.strings.has(runKeys("old-source", source.snapshotId).snapshot), true);
  assert.equal(redis.run.strings.has(runKeys("new-fork", fork.snapshotId).state), false);
  assert.equal(redis.run.lists.has(runKeys("new-fork", fork.snapshotId).events), false);
  assert.equal(redis.run.strings.has(runKeys("new-fork", fork.snapshotId).snapshot), false);
  assert.equal(redis.history.strings.has(historyKey("old-source")), true);
  assert.deepEqual(
    [...new Set(redis.commands
      .filter((entry) => entry.url === HISTORY_URL)
      .map((entry) => entry.command[0]))],
    ["GET"],
  );
  const secondPlan = await planFixture(redis, { olderThanDays: 7 });
  assert.equal(secondPlan.canExecute, true);
  assert.equal(secondPlan.totals.runCount, 1);
  assert.equal(secondPlan.totals.keyCount, 3);
  assert.equal(secondPlan.totals.protectedSnapshotKeyCount, 0);
  await executeAdminRunCleanup(secondPlan, {
    execute: true,
    confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
    writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    approvalFingerprint: secondPlan.planFingerprint,
    fetchImpl: redis.fetchImpl,
  });
  assert.equal(redis.run.strings.has(runKeys("old-source", source.snapshotId).state), false);
  assert.equal(redis.run.lists.has(runKeys("old-source", source.snapshotId).events), false);
  assert.equal(redis.run.strings.has(runKeys("old-source", source.snapshotId).snapshot), false);
  assert.equal(redis.history.strings.has(historyKey("old-source")), true);
  assert.equal(redis.history.strings.has(historyKey("new-fork")), true);
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
      approvalFingerprint: plan.planFingerprint,
      fetchImpl: redis.fetchImpl,
    }),
    { code: "admin_run_cleanup_refused" },
  );
  await assert.rejects(
    executeAdminRunCleanup(plan, {
      execute: true,
      confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
      writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
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
      writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
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
      writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
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
      writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
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

test("batch execution validates full snapshot contents only at batch boundaries", async () => {
  const redis = createRedisFixture();
  for (const runId of ["batch-one", "batch-two", "batch-three"]) {
    seedRun(redis.run, { runId });
    seedHistory(redis.history, runId, `${runId} question`);
  }
  const retained = seedRun(redis.run, {
    runId: "recent-retained",
    endedAt: RECENT,
    updatedAt: RECENT,
  });
  seedHistory(redis.history, "recent-retained", "recent question");
  const plan = await planFixture(redis, { olderThanDays: 7 });
  assert.equal(plan.totals.runCount, 3);
  const commandStart = redis.commands.length;

  await executeAdminRunCleanup(plan, {
    execute: true,
    confirmation: ADMIN_RUN_CLEANUP_CONFIRMATION,
    writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    approvalFingerprint: plan.planFingerprint,
    fetchImpl: redis.fetchImpl,
  });

  const executionSnapshotGets = redis.commands.slice(commandStart).filter(
    (entry) => entry.url === RUN_URL
      && entry.command[0] === "GET"
      && /:snapshot:/u.test(String(entry.command[1])),
  );
  assert.equal(executionSnapshotGets.length, 5);
  assert.equal(
    executionSnapshotGets.filter((entry) => entry.command[1] === retained.keys.snapshot).length,
    2,
  );
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
  assert.equal(legacyPlan.candidateSummary.historyRecordKindCounts.legacy, 1);

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
    backfillHistory: false,
    execute: false,
    confirmation: "",
    writesDisabledConfirmation: "",
    approvalFingerprint: "",
    compact: false,
    timeoutMs: 30_000,
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
  assert.equal(
    parseAdminRunCleanupArguments([
      "--older-than-days",
      "30",
      "--timeout-ms",
      "12345",
    ]).timeoutMs,
    12_345,
  );
  assert.equal(
    parseAdminRunCleanupArguments([
      "--backfill-history",
      "--older-than-days",
      "30",
    ]).backfillHistory,
    true,
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
      "--confirm-writes-disabled",
      "wrong",
    ], {
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

test("CLI dispatches independent History backfill plan/execute modes with their own confirmation", async () => {
  let cleanupPlanCalls = 0;
  let cleanupExecuteCalls = 0;
  let backfillPlanCalls = 0;
  let backfillExecuteCalls = 0;
  let executeOptions = null;
  let output = "";
  const fakeFetch = async () => { throw new Error("not called"); };
  const plan = Object.freeze({
    mode: "backfill_dry_run",
    planFingerprint: "a".repeat(64),
  });
  const executed = Object.freeze({ mode: "backfill_executed" });

  const report = await runAdminRunCleanupCli([
    "--backfill-history",
    "--older-than-days",
    "30",
    "--execute",
    "--confirm",
    ADMIN_RUN_HISTORY_BACKFILL_CONFIRMATION,
    "--confirm-writes-disabled",
    ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    "--plan-fingerprint",
    plan.planFingerprint,
    "--compact",
  ], {
    fetchImpl: fakeFetch,
    stdout: { write(value) { output += value; } },
    planCleanup: async () => { cleanupPlanCalls += 1; },
    executeCleanup: async () => { cleanupExecuteCalls += 1; },
    planHistoryBackfill: async () => {
      backfillPlanCalls += 1;
      return plan;
    },
    executeHistoryBackfill: async (_plan, options) => {
      backfillExecuteCalls += 1;
      executeOptions = options;
      return executed;
    },
  });

  assert.equal(report, executed);
  assert.equal(output, '{"mode":"backfill_executed"}\n');
  assert.equal(cleanupPlanCalls, 0);
  assert.equal(cleanupExecuteCalls, 0);
  assert.equal(backfillPlanCalls, 1);
  assert.equal(backfillExecuteCalls, 1);
  assert.deepEqual(executeOptions, {
    execute: true,
    confirmation: ADMIN_RUN_HISTORY_BACKFILL_CONFIRMATION,
    writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    approvalFingerprint: plan.planFingerprint,
    fetchImpl: fakeFetch,
  });

  await assert.rejects(
    runAdminRunCleanupCli([
      "--backfill-history",
      "--older-than-days",
      "30",
      "--execute",
      "--confirm",
      ADMIN_RUN_CLEANUP_CONFIRMATION,
      "--confirm-writes-disabled",
      ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
      "--plan-fingerprint",
      plan.planFingerprint,
    ], { stdout: { write() {} } }),
    { code: "admin_run_history_backfill_refused" },
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

async function planBackfillFixture(redis, options) {
  return planAdminRunHistoryBackfill({
    ...options,
    now: NOW,
    runConnection: { url: RUN_URL, token: "run-token" },
    historyConnection: { url: HISTORY_URL, token: "history-token" },
    fetchImpl: redis.fetchImpl,
  });
}

async function executeBackfill(redis, plan) {
  return executeAdminRunHistoryBackfill(plan, {
    execute: true,
    confirmation: ADMIN_RUN_HISTORY_BACKFILL_CONFIRMATION,
    writesDisabledConfirmation: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    approvalFingerprint: plan.planFingerprint,
    fetchImpl: redis.fetchImpl,
  });
}

function seedBackfillRun(store, {
  runId,
  status = "SUCCEEDED",
  endedAt = OLD,
  updatedAt = OLD,
  lease = null,
  question = `${runId} question`,
  evidence = {},
  dataVersions = {},
  metadata = {},
  snapshot = null,
  snapshotRecord = null,
  encoding = "legacy",
  eventValue = JSON.stringify({ runId, sequence: 1 }),
} = {}) {
  const fullSnapshot = snapshot || createAdminEvidenceSnapshot({
    question,
    evidence,
    dataVersions,
    metadata,
    createdAt: OLD,
  });
  const keys = runKeys(runId, fullSnapshot.snapshotId);
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
    evidenceSnapshotId: fullSnapshot.snapshotId,
    execution: { lease },
  }));
  store.lists.set(keys.events, [eventValue]);
  const storedSnapshot = snapshotRecord
    || (encoding === "gzip" ? gzipSnapshotRecord(fullSnapshot) : fullSnapshot);
  store.strings.set(keys.snapshot, JSON.stringify(storedSnapshot));
  return {
    keys,
    hash: fullSnapshot.contentSha256,
    snapshotId: fullSnapshot.snapshotId,
    snapshot: fullSnapshot,
  };
}

function gzipSnapshotRecord(snapshot) {
  const input = Buffer.from(JSON.stringify(snapshot), "utf8");
  const compressed = gzipSync(input, { level: 9, mtime: 0 });
  return {
    recordType: "admin_evidence_snapshot_gzip",
    schemaVersion: 1,
    encoding: "gzip+base64",
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
    uncompressedBytes: input.byteLength,
    compressedBytes: compressed.byteLength,
    payload: compressed.toString("base64"),
  };
}

function snapshotReference(ownerRunId, snapshot) {
  return {
    recordType: "admin_evidence_snapshot_reference",
    schemaVersion: 1,
    ownerRunId,
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
  };
}

function readHistory(store, runId) {
  return JSON.parse(store.strings.get(historyKey(runId)));
}

function historyIndexKey() {
  return `{${HISTORY_PREFIX}}:created`;
}

function seedUnrelatedSentinels(store) {
  const values = new Map([
    ["rag-query-audit:v1", "query-audit-byte-exact"],
    ["admin-final-budget:v1:2026-08-06", "budget-byte-exact"],
    ["ocg-admin:v1:session", "session-byte-exact"],
    ["rag-public-answer-latency:v1:value", "latency-byte-exact"],
  ]);
  for (const [key, value] of values) store.strings.set(key, value);
  return values;
}

function assertSentinelsUnchanged(store, expected) {
  for (const [key, value] of expected) assert.equal(store.strings.get(key), value);
}

function snapshotStore(store) {
  return {
    strings: [...store.strings.entries()],
    lists: [...store.lists.entries()].map(([key, values]) => [key, [...values]]),
    zsets: [...store.zsets.entries()].map(([key, values]) => [key, [...values.entries()]]),
  };
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
  return {
    strings: new Map(),
    lists: new Map(),
    zsets: new Map(),
    backfillEvalCalls: 0,
    failBackfillEvalAt: null,
  };
}

function executeMockCommand(store, command) {
  const operation = String(command[0]).toUpperCase();
  if (operation === "SCAN") {
    const pattern = String(command[3]);
    const keys = [...store.strings.keys(), ...store.lists.keys(), ...store.zsets.keys()]
      .filter((key) => globMatches(pattern, key));
    return ["0", keys];
  }
  if (operation === "TYPE") {
    if (store.strings.has(command[1])) return "string";
    if (store.lists.has(command[1])) return "list";
    if (store.zsets.has(command[1])) return "zset";
    return "none";
  }
  if (operation === "GET") return store.strings.get(command[1]) ?? null;
  if (operation === "ZSCORE") {
    return store.zsets.get(command[1])?.get(String(command[2])) ?? null;
  }
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
  if (operation === "EVAL"
    && String(command[1]).includes("admin-run-history-question-backfill-v1")) {
    store.backfillEvalCalls += 1;
    if (store.failBackfillEvalAt === store.backfillEvalCalls) return "INDEX_TYPE_INVALID";
    const keyCount = Number(command[2]);
    assert.equal(keyCount, 2);
    const recordKey = String(command[3]);
    const indexKey = String(command[4]);
    const recordRaw = String(command[5]);
    const indexScore = String(command[6]);
    const runId = String(command[7]);
    if (store.strings.has(recordKey) || store.lists.has(recordKey) || store.zsets.has(recordKey)) {
      return "RECORD_EXISTS";
    }
    if (store.strings.has(indexKey) || store.lists.has(indexKey)) return "INDEX_TYPE_INVALID";
    const index = store.zsets.get(indexKey) || new Map();
    if (index.has(runId)) return "INDEX_MEMBER_EXISTS";
    let record;
    try {
      record = JSON.parse(recordRaw);
    } catch {
      return "INVALID_RECORD";
    }
    if (record.schemaVersion !== 1
      || record.runId !== runId
      || !record.createdAt
      || !record.questionSummary) {
      return "INVALID_RECORD";
    }
    store.strings.set(recordKey, recordRaw);
    index.set(runId, indexScore);
    store.zsets.set(indexKey, index);
    return "CREATED";
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
