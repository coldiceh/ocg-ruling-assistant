import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminEvidenceSnapshot,
  parseAdminEvidenceSnapshot,
  serializeAdminEvidenceSnapshot,
} from "../backend/adminEvidenceSnapshot.mjs";
import {
  ADMIN_RUN_STAGE_CATALOG,
  ADMIN_STAGE_SPEED_LABELS,
  createAdminStageTracker,
} from "../backend/adminStageTracker.mjs";
import {
  ADMIN_PROVIDER_SUBMISSION_STATES,
  ADMIN_RUN_STATUSES,
  createAdminRunStore,
  createMemoryAdminRunStorage,
  isAdminRunLimitEnabled,
  normalizeAdminRunLimits,
} from "../backend/adminRunStore.mjs";

test("evidence snapshots are detached, deeply immutable, content-addressed, and integrity checked", () => {
  const source = {
    cards: [{ id: "anonymous-card", text: "anonymous effect" }],
    evidence: [{ id: "anonymous-evidence", claims: ["claim-a"] }],
  };
  const snapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: source,
    dataVersions: { faq: "v1" },
    createdAt: "2026-07-27T00:00:00.000Z",
  });

  source.cards[0].text = "mutated";
  source.evidence.push({ id: "late-item" });
  assert.equal(snapshot.evidence.cards[0].text, "anonymous effect");
  assert.equal(snapshot.evidence.evidence.length, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.evidence.cards[0]), true);
  assert.throws(() => {
    snapshot.evidence.cards[0].text = "cannot mutate";
  }, TypeError);

  const restored = parseAdminEvidenceSnapshot(serializeAdminEvidenceSnapshot(snapshot));
  assert.deepEqual(restored, snapshot);
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.evidence.cards[0].text = "tampered";
  assert.throws(() => parseAdminEvidenceSnapshot(tampered), /integrity check failed/u);
});

test("five-stage monotonic tracker supports overlapping stages and does not sum their durations", () => {
  let monotonicMs = 100;
  let wallMs = Date.parse("2026-07-27T00:00:00.000Z");
  const tracker = createAdminStageTracker({
    runId: "anonymous-run",
    monotonicNow: () => monotonicMs,
    wallNow: () => new Date(wallMs),
  });
  const [first, second, ...remaining] = ADMIN_RUN_STAGE_CATALOG;

  tracker.startStage(first.id);
  tracker.startSubstage(first.id, "parse");
  monotonicMs += 5_000;
  wallMs += 5_000;
  tracker.startStage(second.id);
  monotonicMs += 7_000;
  wallMs += 7_000;
  tracker.finishSubstage(first.id, "parse");
  tracker.finishStage(first.id);
  monotonicMs += 2_000;
  wallMs += 2_000;
  tracker.finishStage(second.id);
  for (const stage of remaining) tracker.skipStage(stage.id, { reason: "not used by this anonymous run" });
  const completed = tracker.complete();

  assert.equal(completed.stages.length, 5);
  assert.equal(completed.totalElapsedMs, 14_000);
  assert.equal(completed.stages[0].durationMs, 12_000);
  assert.equal(completed.stages[1].durationMs, 9_000);
  assert.equal(completed.stages[0].durationMs + completed.stages[1].durationMs, 21_000);
  assert.equal(completed.stages[0].speedLabel, ADMIN_STAGE_SPEED_LABELS.NORMAL);
  assert.equal(completed.stages[1].speedLabel, ADMIN_STAGE_SPEED_LABELS.FAST);
  assert.equal(completed.stages[0].substages[0].durationMs, 12_000);
});

test("stage speed labels never cancel or time-limit a slow run", () => {
  let monotonicMs = 0;
  const tracker = createAdminStageTracker({
    runId: "slow-anonymous-run",
    monotonicNow: () => monotonicMs,
    wallNow: () => new Date(1_800_000_000_000 + monotonicMs),
  });
  const [first, ...remaining] = ADMIN_RUN_STAGE_CATALOG;
  tracker.startStage(first.id);
  monotonicMs = 45_000;
  tracker.finishStage(first.id);
  for (const stage of remaining) tracker.skipStage(stage.id);
  const completed = tracker.complete();
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.stages[0].speedLabel, ADMIN_STAGE_SPEED_LABELS.SLOW);
});

test("stage tracker rejects a regressing monotonic clock", () => {
  let monotonicMs = 10;
  const tracker = createAdminStageTracker({
    runId: "clock-run",
    monotonicNow: () => monotonicMs,
  });
  monotonicMs = 9;
  assert.throws(() => tracker.snapshot(), /monotonic clock regressed/u);
});

test("stage tracker clamps floating-point cancellation at a large monotonic origin", () => {
  const originTick = 3.0890071227801844e52;
  const stageStartTick = 6.361174194133177e53;
  assert.ok(
    stageStartTick - (originTick + (stageStartTick - originTick)) < 0,
    "fixture must reproduce the absolute-tick floating-point cancellation",
  );

  let monotonicTick = originTick;
  const tracker = createAdminStageTracker({
    runId: "large-origin-run",
    monotonicNow: () => monotonicTick,
  });
  monotonicTick = stageStartTick;
  const [first, ...remaining] = ADMIN_RUN_STAGE_CATALOG;
  const started = tracker.startStage(first.id);
  assert.equal(started.durationMs, 0);
  assert.equal(tracker.snapshot().stages[0].durationMs, 0);
  assert.equal(tracker.finishStage(first.id).durationMs, 0);
  for (const stage of remaining) tracker.skipStage(stage.id);

  const completed = tracker.complete();
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.stages[0].durationMs, 0);
});

test("run limits default to disabled and preserve explicit zero instead of coercing null", () => {
  const defaults = normalizeAdminRunLimits();
  assert.deepEqual(Object.values(defaults), Object.values(defaults).map(() => null));
  assert.equal(isAdminRunLimitEnabled(defaults.maxRunDurationMs), false);

  const explicit = normalizeAdminRunLimits({
    maxConcurrentRuns: null,
    maxRunDurationMs: 0,
    maxCostUsd: 0,
  });
  assert.equal(explicit.maxConcurrentRuns, null);
  assert.equal(explicit.maxRunDurationMs, 0);
  assert.equal(explicit.maxCostUsd, 0);
  assert.equal(isAdminRunLimitEnabled(explicit.maxRunDurationMs), true);
});

test("run store persists immutable state, increasing events, replay cursors, stage timing, and cancellation", async () => {
  const storage = createMemoryAdminRunStorage();
  let wallMs = Date.parse("2026-07-27T01:00:00.000Z");
  const runStore = createAdminRunStore({
    storage,
    now: () => new Date(wallMs++),
    runIdFactory: () => "run-immutable-1",
  });
  const snapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: { items: [{ id: "e1" }] },
  });
  const created = await runStore.createRun({ evidenceSnapshot: snapshot });
  assert.equal(created.status, ADMIN_RUN_STATUSES.QUEUED);
  assert.equal(created.lastSequence, 1);
  assert.equal(created.limits.maxConcurrentRuns, null);

  await runStore.startRun(created.runId);
  const tracker = createAdminStageTracker({ runId: created.runId });
  tracker.startStage(ADMIN_RUN_STAGE_CATALOG[0].id);
  const persistedStageSnapshot = tracker.snapshot();
  await runStore.updateStageProgress(created.runId, persistedStageSnapshot);
  await runStore.requestCancellation(created.runId, {
    reason: "operator requested",
    requestedBy: "anonymous-admin",
  });
  assert.equal(await runStore.isCancellationRequested(created.runId), true);
  const cancelled = await runStore.markCancelled(created.runId);
  assert.equal(cancelled.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(cancelled.lastSequence, 5);
  assert.equal(cancelled.stageTiming.runId, created.runId);

  const replay = await runStore.replayEvents(created.runId, { afterSequence: 2 });
  assert.deepEqual(replay.events.map((event) => event.sequence), [3, 4, 5]);
  assert.deepEqual(replay.events[0].payload.stageTiming, persistedStageSnapshot);
  assert.deepEqual(replay.events[0].payload.stages, persistedStageSnapshot.stages);
  assert.equal(replay.nextAfterSequence, 5);
  assert.equal(replay.hasMore, false);

  const secondStore = createAdminRunStore({ storage });
  const persisted = await secondStore.getRun(created.runId);
  assert.equal(persisted.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(Object.isFrozen(persisted.evidenceSnapshot.evidence.items), true);
  assert.throws(() => {
    persisted.status = ADMIN_RUN_STATUSES.RUNNING;
  }, TypeError);
  assert.equal((await secondStore.getRun(created.runId)).status, ADMIN_RUN_STATUSES.CANCELLED);
});

test("concurrent event appends retain a gap-free per-run sequence", async () => {
  const storage = createMemoryAdminRunStorage();
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "concurrent-run",
  });
  const snapshot = createAdminEvidenceSnapshot({ evidence: { anonymous: true } });
  await store.createRun({ evidenceSnapshot: snapshot });
  await Promise.all(Array.from({ length: 8 }, (_, index) => (
    store.appendEvent("concurrent-run", {
      type: "ANONYMOUS_PROGRESS",
      payload: { index },
    })
  )));
  const replay = await store.replayEvents("concurrent-run");
  assert.deepEqual(replay.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("success and cancellation race through one idempotent atomic terminal mutation", async () => {
  const storage = createMemoryAdminRunStorage();
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "terminal-race-run",
  });
  const snapshot = createAdminEvidenceSnapshot({ evidence: { anonymous: true } });
  await store.createRun({ evidenceSnapshot: snapshot });
  await store.startRun("terminal-race-run");
  await store.requestCancellation("terminal-race-run", {
    reason: "operator requested",
    requestedBy: "anonymous-admin",
  });

  const completedTiming = {
    runId: "terminal-race-run",
    status: "COMPLETED",
    stages: [],
  };
  const cancelledTiming = {
    runId: "terminal-race-run",
    status: "CANCELLED",
    stages: [],
  };
  const [successAttempt, cancellationAttempt] = await Promise.all([
    store.completeRun("terminal-race-run", {
      result: { answer: "anonymous" },
      stageTiming: completedTiming,
    }),
    store.markCancelled("terminal-race-run", {
      reason: "operator requested",
      stageTiming: cancelledTiming,
    }),
  ]);
  const settled = await store.getRun("terminal-race-run");

  assert.equal(
    [ADMIN_RUN_STATUSES.SUCCEEDED, ADMIN_RUN_STATUSES.CANCELLED].includes(settled.status),
    true,
  );
  assert.equal(successAttempt.status, settled.status);
  assert.equal(cancellationAttempt.status, settled.status);
  if (settled.status === ADMIN_RUN_STATUSES.SUCCEEDED) {
    assert.deepEqual(settled.result, { answer: "anonymous" });
    assert.equal(settled.stageTiming.status, "COMPLETED");
  } else {
    assert.equal(settled.cancellation.cancelledAt !== null, true);
    assert.equal(settled.stageTiming.status, "CANCELLED");
  }

  const firstReplay = await store.replayEvents("terminal-race-run");
  assert.equal(
    firstReplay.events.filter((event) => (
      event.type === "RUN_SUCCEEDED" || event.type === "RUN_CANCELLED"
    )).length,
    1,
  );
  const terminalSequence = firstReplay.lastSequence;
  await store.completeRun("terminal-race-run", {
    result: { answer: "anonymous" },
    stageTiming: completedTiming,
  });
  await store.markCancelled("terminal-race-run", {
    reason: "operator requested",
    stageTiming: cancelledTiming,
  });
  assert.equal(
    (await store.replayEvents("terminal-race-run")).lastSequence,
    terminalSequence,
    "terminal replay must be a no-op",
  );
});

test("failed runs persist only whitelisted final-call metering fields from hostile error objects", async () => {
  const storage = createMemoryAdminRunStorage();
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "safe-error-audit-run",
  });
  const snapshot = createAdminEvidenceSnapshot({ evidence: { anonymous: true } });
  await store.createRun({ evidenceSnapshot: snapshot });
  await store.startRun("safe-error-audit-run");
  const circular = { secret: "must-not-persist", tokenCount: 9n };
  circular.self = circular;
  const error = new Error("relay identity failed");
  error.code = "relay_returned_model_missing";
  error.provider = "relay";
  error.status = 200;
  error.requestedModel = "relay-gpt-5.6-sol";
  error.submittedModel = "gpt-5.6-sol";
  error.reportedModel = null;
  error.usage = {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    unsafeBigInt: 12n,
    circular,
  };
  error.streamMetrics = {
    requestToResponseHeadersMs: 10,
    requestToFirstByteMs: 20,
    requestToFirstEventMs: 30,
    requestToFirstContentMs: null,
    requestToCompleteMs: null,
    networkChunkCount: 2,
    sseEventCount: 1,
    visibleContentChunkCount: 0,
    responseBytes: 123,
    visibleContentBytes: 0,
    finishReason: null,
    hiddenReasoning: "must-not-persist",
    circular,
  };
  error.metering = circular;
  error.failureMetering = {
    scope: "final_ruling_only",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      unsafeBigInt: 12n,
      circular,
    },
    cost: {
      provider: "relay",
      model: "gpt-5.6-sol",
      pricingStatus: "estimated_unverified",
      totalCostCny: 0.01,
      cacheWriteCostCny: 0.002,
      unsafeBigInt: 1n,
      circular,
    },
    circular,
  };

  const failed = await store.failRun("safe-error-audit-run", { error });

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(Object.hasOwn(failed.error, "metering"), false);
  assert.equal(Object.hasOwn(failed.error, "reportedModel"), true);
  assert.equal(failed.error.reportedModel, null);
  assert.deepEqual(failed.error.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.deepEqual(failed.error.streamMetrics, {
    schemaVersion: 1,
    transport: "sse",
    requestToResponseHeadersMs: 10,
    requestToFirstByteMs: 20,
    requestToFirstEventMs: 30,
    requestToFirstContentMs: null,
    requestToCompleteMs: null,
    networkChunkCount: 2,
    sseEventCount: 1,
    visibleContentChunkCount: 0,
    responseBytes: 123,
    visibleContentBytes: 0,
    finishReason: null,
  });
  assert.deepEqual(failed.error.failureMetering, {
    scope: "final_ruling_only",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    cost: {
      provider: "relay",
      model: "gpt-5.6-sol",
      pricingStatus: "estimated_unverified",
      totalCostCny: 0.01,
      cacheWriteCostCny: 0.002,
    },
  });
});

test("preparation finalization atomically replaces the initial request snapshot exactly once", async () => {
  const storage = createMemoryAdminRunStorage();
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "preparation-finalization-run",
  });
  const initialSnapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: { preparationStatus: "pending" },
  });
  const finalSnapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: {
      preparationStatus: "finalized",
      selectedEvidence: [{ id: "evidence-1", type: "card_text", text: "anonymous text" }],
      initialRequest: initialSnapshot,
    },
  });
  await store.createRun({
    evidenceSnapshot: initialSnapshot,
    executionProfile: { status: "planned" },
  });
  await assert.rejects(
    store.finalizePreparation("preparation-finalization-run", {
      evidenceSnapshot: finalSnapshot,
      executionProfile: { status: "finalized" },
    }),
    /cannot finalize preparation admin run from QUEUED/u,
  );
  await store.startRun("preparation-finalization-run");
  const finalized = await store.finalizePreparation("preparation-finalization-run", {
    evidenceSnapshot: finalSnapshot,
    executionProfile: { status: "finalized", finalRulingProvider: "openai" },
  });

  assert.equal(finalized.evidenceSnapshot.snapshotId, finalSnapshot.snapshotId);
  assert.equal(finalized.executionProfile.status, "finalized");
  assert.equal(Boolean(finalized.preparationFinalizedAt), true);
  assert.equal(finalized.lastSequence, 3);
  const events = await store.replayEvents(finalized.runId);
  assert.equal(events.events[2].type, "PREPARATION_FINALIZED");
  assert.equal(events.events[2].payload.evidenceSnapshotId, finalSnapshot.snapshotId);
  await assert.rejects(
    store.finalizePreparation(finalized.runId, {
      evidenceSnapshot: finalSnapshot,
      executionProfile: { status: "finalized" },
    }),
    (error) => error.code === "admin_run_preparation_already_finalized",
  );
});

test("run store atomically creates a preparation-finalized fork run", async () => {
  const store = createAdminRunStore({
    storage: createMemoryAdminRunStorage(),
    runIdFactory: () => "unused-generated-run-id",
    now: () => new Date("2027-01-02T00:00:00.000Z"),
  });
  const snapshot = createAdminEvidenceSnapshot({
    question: "anonymous frozen question",
    evidence: { preparationStatus: "finalized" },
  });
  const executionProfile = {
    status: "evidence_frozen",
    evidenceSnapshotId: snapshot.snapshotId,
  };
  const created = await store.createRun({
    runId: "prepared-fork-run",
    evidenceSnapshot: snapshot,
    executionProfile,
    preparationFinalized: true,
  });

  assert.equal(created.runId, "prepared-fork-run");
  assert.equal(created.status, ADMIN_RUN_STATUSES.QUEUED);
  assert.equal(created.preparationFinalizedAt, created.createdAt);
  assert.equal(created.stageTiming, null);
  assert.equal(
    created.execution.providerSubmission.state,
    ADMIN_PROVIDER_SUBMISSION_STATES.NONE,
  );
  assert.deepEqual(created.evidenceSnapshot, snapshot);
  assert.deepEqual(created.executionProfile, executionProfile);
  const replay = await store.replayEvents(created.runId);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].type, "RUN_CREATED");
  assert.equal(replay.events[0].payload.preparationFinalized, true);

  for (const [runId, profile] of [
    ["missing-profile", null],
    ["planned-profile", { status: "planned", evidenceSnapshotId: snapshot.snapshotId }],
    ["mismatched-profile", { status: "evidence_frozen", evidenceSnapshotId: "wrong" }],
  ]) {
    await assert.rejects(
      store.createRun({
        runId,
        evidenceSnapshot: snapshot,
        executionProfile: profile,
        preparationFinalized: true,
      }),
      TypeError,
    );
    assert.equal(await store.getRun(runId), null);
  }
});

test("persistent execution leases fence stale workers across store instances", async () => {
  const storage = createMemoryAdminRunStorage();
  let wallMs = Date.parse("2026-07-29T00:00:00.000Z");
  const common = {
    storage,
    now: () => new Date(wallMs),
    executionLeaseMs: 1_000,
  };
  const storeA = createAdminRunStore({
    ...common,
    runIdFactory: () => "execution-fence-run",
    executionTokenFactory: () => "worker-a-secret-token",
  });
  const storeB = createAdminRunStore({
    ...common,
    executionTokenFactory: () => "worker-b-secret-token",
  });
  const initialSnapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: { preparationStatus: "pending" },
  });
  const finalSnapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: { preparationStatus: "finalized" },
  });
  await storeA.createRun({
    evidenceSnapshot: initialSnapshot,
    executionProfile: { status: "planned" },
  });
  const leaseA = await storeA.acquireExecutionLease("execution-fence-run", {
    ownerId: "worker-a",
  });
  assert.equal(leaseA.executionEpoch, 1);
  assert.equal(leaseA.run.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.notEqual(leaseA.run.execution.lease.tokenHash, leaseA.executionToken);
  assert.equal(JSON.stringify(leaseA.run).includes("worker-a-secret-token"), false);

  const timingA = {
    runId: "execution-fence-run",
    status: "RUNNING",
    totalElapsedMs: 10,
    stages: [],
  };
  await storeA.updateStageProgress("execution-fence-run", timingA, {
    executionToken: leaseA.executionToken,
  });
  await assert.rejects(
    storeB.acquireExecutionLease("execution-fence-run", { ownerId: "worker-b" }),
    (error) => error?.code === "admin_run_execution_lease_active",
  );

  wallMs += 1_001;
  const leaseB = await storeB.acquireExecutionLease("execution-fence-run", {
    ownerId: "worker-b",
  });
  assert.equal(leaseB.executionEpoch, 2);
  await assert.rejects(
    storeA.updateStageProgress("execution-fence-run", {
      ...timingA,
      totalElapsedMs: 20,
    }, {
      executionToken: leaseA.executionToken,
    }),
    (error) => error?.code === "admin_run_execution_fenced",
  );
  await assert.rejects(
    storeA.finalizePreparation("execution-fence-run", {
      evidenceSnapshot: finalSnapshot,
      executionProfile: { status: "finalized" },
      executionToken: leaseA.executionToken,
    }),
    (error) => error?.code === "admin_run_execution_fenced",
  );
  const finalized = await storeB.finalizePreparation("execution-fence-run", {
    evidenceSnapshot: finalSnapshot,
    executionProfile: { status: "finalized" },
    executionToken: leaseB.executionToken,
  });
  assert.equal(finalized.execution.epoch, 2);
  assert.equal(finalized.evidenceSnapshot.snapshotId, finalSnapshot.snapshotId);
  await assert.rejects(
    storeA.failRun("execution-fence-run", {
      error: new Error("stale worker failure"),
      executionToken: leaseA.executionToken,
    }),
    (error) => error?.code === "admin_run_execution_fenced",
  );
  assert.equal(
    (await storeB.getRun("execution-fence-run")).status,
    ADMIN_RUN_STATUSES.RUNNING,
  );
});

test("provider SUBMITTING intent is an atomic one-winner gate before create", async () => {
  const storage = createMemoryAdminRunStorage();
  const storeA = createAdminRunStore({
    storage,
    runIdFactory: () => "provider-submit-race-run",
    executionTokenFactory: () => "shared-execution-token",
    submissionAttemptIdFactory: () => "attempt-a",
  });
  const storeB = createAdminRunStore({
    storage,
    submissionAttemptIdFactory: () => "attempt-b",
  });
  const initialSnapshot = createAdminEvidenceSnapshot({
    evidence: { preparationStatus: "pending" },
  });
  const finalSnapshot = createAdminEvidenceSnapshot({
    evidence: { preparationStatus: "finalized" },
  });
  await storeA.createRun({
    evidenceSnapshot: initialSnapshot,
    executionProfile: { status: "planned" },
  });
  const lease = await storeA.acquireExecutionLease("provider-submit-race-run", {
    ownerId: "worker-a",
  });
  await storeA.finalizePreparation("provider-submit-race-run", {
    evidenceSnapshot: finalSnapshot,
    executionProfile: { status: "finalized" },
    executionToken: lease.executionToken,
  });

  const attempts = await Promise.allSettled([
    storeA.beginProviderSubmission("provider-submit-race-run", {
      executionToken: lease.executionToken,
      providerId: "openai",
      requestFingerprint: "sha256:anonymous",
    }),
    storeB.beginProviderSubmission("provider-submit-race-run", {
      executionToken: lease.executionToken,
      providerId: "openai",
      requestFingerprint: "sha256:anonymous",
    }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.equal(
    attempts.find((item) => item.status === "rejected").reason.code,
    "admin_run_provider_submission_in_progress",
  );
  const winner = attempts.find((item) => item.status === "fulfilled").value;
  const accepted = await storeA.recordProviderSubmissionAccepted("provider-submit-race-run", {
    executionToken: lease.executionToken,
    attemptId: winner.submissionIntent.attemptId,
    providerId: "openai",
    requestId: "resp_anonymous",
  });
  assert.equal(
    accepted.execution.providerSubmission.state,
    ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED,
  );
  assert.equal(accepted.execution.providerSubmission.requestId, "resp_anonymous");
  const acceptedAgain = await storeA.recordProviderSubmissionAccepted("provider-submit-race-run", {
    executionToken: lease.executionToken,
    attemptId: winner.submissionIntent.attemptId,
    providerId: "openai",
    requestId: "resp_anonymous",
  });
  assert.equal(acceptedAgain.revision, accepted.revision);
  assert.equal(acceptedAgain.lastSequence, accepted.lastSequence);
  assert.equal(
    (await storeA.replayEvents("provider-submit-race-run", { afterSequence: 0 }))
      .events.filter((event) => event.type === "PROVIDER_SUBMISSION_ACCEPTED").length,
    1,
    "an exact acknowledgement retry must not append a duplicate event",
  );
  await assert.rejects(
    storeA.recordProviderSubmissionAccepted("provider-submit-race-run", {
      executionToken: lease.executionToken,
      attemptId: winner.submissionIntent.attemptId,
      providerId: "openai",
      requestId: "resp_different",
    }),
    (error) => error?.code === "admin_run_provider_submission_already_accepted",
  );
  await assert.rejects(
    storeA.beginProviderSubmission("provider-submit-race-run", {
      executionToken: lease.executionToken,
      providerId: "openai",
    }),
    (error) => error?.code === "admin_run_provider_submission_already_accepted",
  );
});

test("accept-before-record ambiguity becomes durable outcome_unknown and is never auto-retried", async () => {
  const storage = createMemoryAdminRunStorage();
  let wallMs = Date.parse("2026-07-29T02:00:00.000Z");
  const storeA = createAdminRunStore({
    storage,
    now: () => new Date(wallMs),
    runIdFactory: () => "provider-ambiguous-run",
    executionTokenFactory: () => "worker-a-token",
    submissionAttemptIdFactory: () => "attempt-before-crash",
    executionLeaseMs: 100,
  });
  const storeB = createAdminRunStore({
    storage,
    now: () => new Date(wallMs),
    executionTokenFactory: () => "worker-b-token",
    executionLeaseMs: 100,
  });
  const initialSnapshot = createAdminEvidenceSnapshot({
    evidence: { preparationStatus: "pending" },
  });
  const finalSnapshot = createAdminEvidenceSnapshot({
    evidence: { preparationStatus: "finalized" },
  });
  await storeA.createRun({
    evidenceSnapshot: initialSnapshot,
    executionProfile: { status: "planned" },
  });
  const leaseA = await storeA.acquireExecutionLease("provider-ambiguous-run", {
    ownerId: "worker-a",
  });
  await storeA.finalizePreparation("provider-ambiguous-run", {
    evidenceSnapshot: finalSnapshot,
    executionProfile: { status: "finalized" },
    executionToken: leaseA.executionToken,
  });
  const submitting = await storeA.beginProviderSubmission("provider-ambiguous-run", {
    executionToken: leaseA.executionToken,
    providerId: "openai",
  });

  // The upstream may have accepted the request here, but the process dies
  // before requestId is durably committed.
  wallMs += 101;
  const leaseB = await storeB.acquireExecutionLease("provider-ambiguous-run", {
    ownerId: "worker-b",
  });
  assert.equal(leaseB.executionEpoch, 2);
  assert.equal(
    leaseB.run.execution.providerSubmission.state,
    ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
  );
  assert.equal(
    leaseB.run.execution.providerSubmission.error.code,
    "provider_submission_owner_lost",
  );
  await assert.rejects(
    storeB.beginProviderSubmission("provider-ambiguous-run", {
      executionToken: leaseB.executionToken,
      providerId: "openai",
    }),
    (error) => error?.code === "admin_run_provider_submission_outcome_unknown",
  );
  await assert.rejects(
    storeA.recordProviderSubmissionAccepted("provider-ambiguous-run", {
      executionToken: leaseA.executionToken,
      attemptId: submitting.submissionIntent.attemptId,
      providerId: "openai",
      requestId: "resp_accepted_but_not_recorded",
    }),
    (error) => error?.code === "admin_run_execution_fenced",
  );
});

test("directed repair has its own one-shot durable fence and preserves the primary attempt audit", async () => {
  const storage = createMemoryAdminRunStorage();
  let wallMs = Date.parse("2026-07-29T03:00:00.000Z");
  const snapshot = createAdminEvidenceSnapshot({
    evidence: {
      preparationStatus: "finalized",
      evidenceDecisionPacket: {
        decisionPacketId: "decision-packet-test",
        packetContentSha256: "d".repeat(64),
      },
    },
  });
  const storeA = createAdminRunStore({
    storage,
    now: () => new Date(wallMs),
    runIdFactory: () => "provider-repair-fence-run",
    executionTokenFactory: () => "repair-worker-a-token",
    submissionAttemptIdFactory: (() => {
      let sequence = 0;
      return () => `repair-attempt-${++sequence}`;
    })(),
    executionLeaseMs: 100,
  });
  const storeB = createAdminRunStore({
    storage,
    now: () => new Date(wallMs),
    executionTokenFactory: () => "repair-worker-b-token",
    executionLeaseMs: 100,
  });
  await storeA.createRun({
    evidenceSnapshot: snapshot,
    executionProfile: {
      status: "evidence_frozen",
      evidenceSnapshotId: snapshot.snapshotId,
      prompt: { sha256: "p".repeat(64) },
    },
    preparationFinalized: true,
  });
  const leaseA = await storeA.acquireExecutionLease("provider-repair-fence-run", {
    ownerId: "repair-worker-a",
  });
  const primary = await storeA.beginProviderSubmission("provider-repair-fence-run", {
    executionToken: leaseA.executionToken,
    providerId: "glm",
  });
  await storeA.recordProviderSubmissionAccepted("provider-repair-fence-run", {
    executionToken: leaseA.executionToken,
    attemptId: primary.submissionIntent.attemptId,
    providerId: "glm",
    requestId: "glm-primary-request",
  });
  const invariants = {
    evidenceSnapshotId: snapshot.snapshotId,
    evidenceSnapshotSha256: snapshot.contentSha256,
    decisionPacketId: "decision-packet-test",
    decisionPacketSha256: "d".repeat(64),
    promptSha256: "p".repeat(64),
  };
  await assert.rejects(
    storeA.beginProviderRepairSubmission("provider-repair-fence-run", {
      executionToken: leaseA.executionToken,
      providerId: "glm",
      validationErrors: ["claims[0].evidenceIds is required"],
      initialAttempt: { requestId: "glm-primary-request" },
      invariants: { ...invariants, evidenceSnapshotSha256: "0".repeat(64) },
    }),
    (error) => error?.code === "admin_run_provider_repair_invariant_mismatch",
  );
  const repair = await storeA.beginProviderRepairSubmission("provider-repair-fence-run", {
    executionToken: leaseA.executionToken,
    providerId: "glm",
    validationErrors: ["claims[0].evidenceIds is required"],
    initialAttempt: {
      requestId: "glm-primary-request",
      usage: { totalTokens: 123 },
      cost: { totalCostCny: 0.25 },
    },
    invariants,
  });
  assert.equal(repair.run.execution.repairSubmission.state, "SUBMITTING");
  assert.equal(repair.run.execution.repair.initialAttempt.usage.totalTokens, 123);
  assert.deepEqual(repair.run.execution.repair.invariants, invariants);
  await assert.rejects(
    storeA.beginProviderRepairSubmission("provider-repair-fence-run", {
      executionToken: leaseA.executionToken,
      providerId: "glm",
      validationErrors: ["retry again"],
      initialAttempt: {},
      invariants,
    }),
    (error) => error?.code === "admin_run_provider_submission_in_progress",
  );

  wallMs += 101;
  const leaseB = await storeB.acquireExecutionLease("provider-repair-fence-run", {
    ownerId: "repair-worker-b",
  });
  assert.equal(leaseB.run.execution.providerSubmission.state, "SUBMITTED");
  assert.equal(leaseB.run.execution.repairSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(
    leaseB.run.execution.repairSubmission.error.code,
    "provider_repair_submission_owner_lost",
  );
  await assert.rejects(
    storeB.beginProviderRepairSubmission("provider-repair-fence-run", {
      executionToken: leaseB.executionToken,
      providerId: "glm",
      validationErrors: ["must not resubmit"],
      initialAttempt: {},
      invariants,
    }),
    (error) => error?.code === "admin_run_provider_submission_outcome_unknown",
  );
});
