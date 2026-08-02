import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES,
  MAX_FINAL_RULING_INPUT_BYTES,
  buildFinalRulingInput,
  createAdminModelLabService,
} from "../backend/adminModelLabService.mjs";
import {
  ADMIN_RUN_STATUSES,
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "../backend/adminRunStore.mjs";
import { MODEL_RULING_COUNTER_CHECK_TYPES } from "../backend/modelRulingSchema.mjs";

test("final ruling input rejects oversized peripheral snapshot fields", () => {
  assert.throws(
    () => buildFinalRulingInput({
      snapshotId: "snapshot-oversized",
      contentSha256: "a".repeat(64),
      question: "问".repeat(MAX_FINAL_RULING_INPUT_BYTES),
      evidence: {
        questions: [],
        providedFacts: [],
        cardResolution: {},
        unresolved: {},
        retrievalWarnings: [],
        completeness: {},
        evidenceDecisionPacket: { modelPacket: { evidenceItems: [] } },
      },
      dataVersions: {},
      metadata: {},
    }),
    (error) => error?.code === "final_ruling_input_too_large",
  );
});

test("createRun returns before preparation; executeRun then preserves all evidence with real stages", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);

  const created = await service.createRun({
    body: {
      question: "匿名卡A与匿名卡B如何处理？",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      reasoningMode: "standard",
      providedFacts: ["匿名卡A在场上。"],
    },
  });

  assert.equal(created.status, ADMIN_RUN_STATUSES.QUEUED);
  assert.equal(created.stageTiming, null);
  assert.equal(created.evidenceSnapshot.evidence.preparationStatus, "pending");
  assert.equal(fixture.deepSeekPrepareCalls, 0);
  assert.equal(fixture.loadDataCalls, 0);
  assert.equal(fixture.openAICreateCalls.length, 0);

  const execution = await service.executeRun({ runId: created.runId });
  const run = execution.run;

  assert.equal(run.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.equal(run.stageTiming.stages.length, 5);
  assert.deepEqual(
    run.stageTiming.stages.map((stage) => stage.status),
    ["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "RUNNING"],
  );
  assert.equal(
    run.evidenceSnapshot.evidence.evidenceArchive.statistics.inputOccurrenceCount > 3,
    true,
  );
  assert.equal(
    run.evidenceSnapshot.evidence.evidenceDecisionPacket.modelPacket.evidenceItems.length >= 3,
    true,
  );
  assert.equal(run.evidenceSnapshot.evidence.preparation.rawResult.result.organizedEvidenceIds.length, 1);
  assert.equal(run.evidenceSnapshot.evidence.unresolved.cardMentions.length, 1);
  assert.equal(run.evidenceSnapshot.evidence.unresolved.ambiguousMentions.length, 1);
  assert.equal(run.evidenceSnapshot.evidence.conflicts.length >= 1, true);
  assert.equal(run.evidenceSnapshot.metadata.finalRulingRequired, true);
  assert.equal(run.evidenceSnapshot.metadata.simulatorUsed, false);
  assert.equal(run.evidenceSnapshot.evidence.initialRequest.snapshotId, created.evidenceSnapshot.snapshotId);
  assert.equal(Boolean(run.preparationFinalizedAt), true);
  assert.equal(fixture.deepSeekPrepareCalls, 1);
  assert.equal(fixture.deepSeekFinalCalls, 0);
  assert.equal(Object.isFrozen(run.evidenceSnapshot.evidence.evidenceArchive), true);
  assert.equal(
    run.evidenceSnapshot.evidence.completeness.evidenceSufficiency,
    "NOT_ASSESSED",
  );
  assert.equal(
    run.evidenceSnapshot.evidence.conflicts.some(
      (item) => item.type === "preparation_model_reported",
    ),
    false,
  );

  const capability = await service.capabilities();
  assert.equal(capability.architecture.finalRulingRequiredForEveryRun, true);
  assert.equal(capability.architecture.simulatorUsed, false);
  assert.equal(capability.features.history, false);
  assert.equal(capability.promptVersions[0].id, "openai-ruling-v1");
  assert.match(capability.unavailableReasons.history, /no persistent list\/index/u);
  assert.equal(fixture.retrieveRequests[0].enableLiveOfficialQa, true);
});

test("executeRun always starts OpenAI final ruling with the complete frozen snapshot", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  const execution = await service.executeRun({ runId: created.runId });

  assert.equal(execution.run.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.equal(execution.providerRequest.requestId, "resp_admin_1");
  assert.equal(fixture.openAICreateCalls.length, 1);
  const request = fixture.openAICreateCalls[0];
  assert.equal(request.model, "gpt-5.6-terra");
  assert.equal(request.reasoningEffort, "low");
  assert.equal(request.metadata.runId, created.runId);
  assert.match(request.input, /evidence-direct/u);
  assert.match(request.input, /evidence-related/u);
  assert.match(request.input, /finalRulingRequired/u);
  assert.doesNotMatch(request.input, /organizedEvidenceIds/u);
  assert.equal(Buffer.byteLength(request.input) < 150_000, true);
  const boundedInput = JSON.parse(request.input.split("\n").at(-1));
  assert.equal(Object.hasOwn(boundedInput, "conflicts"), false);
  assert.equal(
    boundedInput.evidenceDecisionPacket.conflictSummary.totalConflictCount >= 1,
    true,
  );
  assert.equal(boundedInput.questions[0].questionId, "q1");
  assert.equal(boundedInput.cardResolution.resolvedCards[0].race, "测试族");
  assert.equal(boundedInput.cardResolution.resolvedCards[0].attribute, "测试属性");
  assert.equal(boundedInput.cardResolution.resolvedCards[0].level, 4);
  assert.equal(boundedInput.cardResolution.resolvedCards[0].attack, 1800);

  const replay = await service.replayEvents({ runId: created.runId });
  assert.deepEqual(
    replay.events.map((event) => event.sequence),
    Array.from({ length: replay.events.length }, (_, index) => index + 1),
  );
  assert.equal(
    replay.events.some((event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_REQUEST_CREATED),
    true,
  );
});

test("preparation model selects a registry provider while OpenAI remains the final judge", async () => {
  const fixture = makeFixture();
  const preparationCalls = [];
  const service = makeService(fixture, { GLM_API_KEY: "server-only-glm-key" }, {
    preparationProviders: {
      glm: {
        providerId: "glm",
        async prepareEvidence(request) {
          preparationCalls.push(request);
          return {
            provider: "glm",
            model: request.model,
            canMakeFinalRuling: false,
            canDecideEscalation: false,
            result: {
              cardNameCandidates: [
                { name: "匿名卡A", originalText: "匿名卡A" },
                { name: "匿名卡B", originalText: "匿名卡B" },
              ],
              ruleSearchQueries: [{ query: "匿名规则", reason: "mechanism" }],
              unresolvedNotes: [],
              conflicts: [],
            },
          };
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名问题",
      preparationModel: "glm-5.2",
      preparationReasoningMode: "pro",
      preparationReasoningEffort: "high",
      provider: "glm",
      baseUrl: "https://attacker.invalid/v1",
      apiKey: "frontend-secret",
    },
  });
  assert.equal(created.executionProfile.preparation.provider, "glm");
  assert.equal(created.executionProfile.preparation.reasoningMode, "pro");
  assert.equal(created.executionProfile.finalRuling.provider, "openai");
  assert.equal(JSON.stringify(created).includes("frontend-secret"), false);
  assert.equal(JSON.stringify(created).includes("attacker.invalid"), false);

  const execution = await service.executeRun({ runId: created.runId });
  assert.equal(preparationCalls.length, 1);
  assert.equal(preparationCalls[0].model, "glm-5.2");
  assert.equal(preparationCalls[0].reasoningEffort, "high");
  assert.equal(execution.run.evidenceSnapshot.evidence.preparation.provider, "glm");
  assert.equal(fixture.openAICreateCalls.length, 1);

  await assert.rejects(
    service.createRun({
      body: {
        question: "provider mismatch",
        preparationProvider: "kimi",
        preparationModel: "glm-5.2",
      },
    }),
    (error) => error.code === "provider_model_mismatch",
  );
});

test("getRun reconciles a completed background response, validates it, and persists metrics", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  fixture.providerResponse = completedResponse(makeStructuredRuling());
  fixture.advance(2_500);

  const completed = await service.getRun({ runId: created.runId });

  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(completed.result.finalRuling.conciseAnswer, "可以发动，并完成处理。");
  assert.equal(completed.result.validation.ok, true);
  assert.equal(completed.result.provider.requestId, "resp_admin_1");
  assert.equal(completed.result.usage.totalTokens, 1500);
  assert.equal(completed.result.cost.model, "gpt-5.6-terra");
  assert.equal(completed.result.cost.totalCostUsd > 0, true);
  assert.equal(completed.result.metering.stages.evidencePreparation.usage.totalTokens, 30);
  assert.equal(completed.result.metering.stages.finalRuling.usage.totalTokens, 1500);
  assert.equal(completed.result.metering.totals.usage.totalTokens, 1530);
  assert.equal(completed.result.metering.totals.usage.complete, true);
  assert.equal(completed.result.metering.stages.evidencePreparation.cost.totalCostCny, null);
  assert.equal(completed.result.metering.stages.evidencePreparation.cost.pricingVersion, null);
  assert.equal(completed.result.metering.totals.cost.totalCostUsd, null);
  assert.equal(
    completed.result.metering.totals.cost.knownCostUsd,
    completed.result.cost.totalCostUsd,
  );
  assert.equal(completed.result.metrics.usage.totalTokens, 1530);
  assert.equal(completed.result.metrics.estimatedCostUsd, null);
  assert.equal(completed.result.latency.finalRulingMs >= 2_500, true);
  assert.equal(completed.stageTiming.status, "COMPLETED");
  assert.equal(completed.stageTiming.stages[4].status, "COMPLETED");
});

test("server-versioned DeepSeek pricing produces complete two-stage totals and ignores body pricing", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "8",
    ADMIN_MODEL_LAB_EXCHANGE_RATE_VERSION: "server-fx-v1",
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "server-deepseek-v1",
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2026-07-28",
    ADMIN_MODEL_LAB_DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    ADMIN_MODEL_LAB_DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  });
  const created = await service.createRun({
    body: {
      question: "匿名问题",
      pricing: {
        usdToCnyRate: 999,
        deepSeek: {
          pricingVersion: "client-forged",
          inputCnyPerMillion: 999,
          outputCnyPerMillion: 999,
        },
      },
    },
  });
  assert.equal(created.executionProfile.pricing.deepSeek.pricingVersion, "server-deepseek-v1");
  assert.equal(created.executionProfile.pricing.deepSeek.inputCnyPerMillion, 1);
  await service.executeRun({ runId: created.runId });
  fixture.providerResponse = completedResponse(makeStructuredRuling());

  const completed = await service.getRun({ runId: created.runId });
  const preparationCost = completed.result.metering.stages.evidencePreparation.cost;
  assert.equal(preparationCost.pricingVersion, "server-deepseek-v1");
  assert.equal(preparationCost.totalCostCny, 0.00004);
  assert.equal(preparationCost.totalCostUsd, 0.000005);
  assert.equal(completed.result.metering.totals.cost.complete, true);
  assert.equal(completed.result.metering.totals.cost.totalCostUsd, 0.00978);
  assert.equal(completed.result.metering.totals.cost.totalCostCny, 0.07824);
  assert.equal(completed.result.metrics.estimatedCostUsd, 0.00978);
});

test("missing DeepSeek usage remains null and makes aggregate token totals explicitly incomplete", async () => {
  const fixture = makeFixture();
  fixture.deepSeekUsage = null;
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  fixture.providerResponse = completedResponse(makeStructuredRuling());

  const completed = await service.getRun({ runId: created.runId });
  const preparation = completed.result.metering.stages.evidencePreparation;
  assert.equal(preparation.usage, null);
  assert.equal(preparation.rawUsage, null);
  assert.equal(preparation.cost.totalCostCny, null);
  assert.equal(preparation.cost.unavailabilityReason, "provider_usage_unavailable");
  assert.equal(completed.result.metering.totals.usage.totalTokens, null);
  assert.equal(completed.result.metering.totals.usage.knownTotalTokens, 1500);
  assert.deepEqual(
    completed.result.metering.totals.usage.missingStages,
    ["evidencePreparation"],
  );
});

test("invalid final JSON fails closed instead of accepting or repairing it", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  fixture.providerResponse = completedResponse("```json\n{}\n```");

  const failed = await service.getRun({ runId: created.runId });

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "model_ruling_validation_failed");
  assert.equal(failed.stageTiming.status, "CANCELLED");
  const replay = await service.replayEvents({ runId: created.runId });
  assert.equal(
    replay.events.some((event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_VALIDATION_FAILED),
    true,
  );
});

test("final validation rejects an audit-only evidence ID omitted from the model packet", async () => {
  const fixture = makeFixture();
  fixture.retrieval.rawRelatedEvidence = Array.from({ length: 80 }, (_, index) => ({
    id: `audit-related-${String(index + 1).padStart(3, "0")}`,
    type: "related",
    sourceType: "related",
    text: `只用于扩大审计归档的相关资料 ${index + 1}。`,
  }));
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  const execution = await service.executeRun({ runId: created.runId });
  const decisionPacket = execution.run.evidenceSnapshot.evidence.evidenceDecisionPacket;
  const visibleIds = new Set(decisionPacket.modelPacket.evidenceItems.flatMap(
    (item) => item.evidenceIds || [item.evidenceId],
  ));
  const auditOnlyId = decisionPacket.omittedManifest
    .flatMap((item) => item.evidenceIds || [])
    .find((evidenceId) => !visibleIds.has(evidenceId));
  assert.equal(typeof auditOnlyId, "string");

  const auditOnlyCitation = makeStructuredRuling();
  auditOnlyCitation.claims[0].evidenceIds = [auditOnlyId];
  auditOnlyCitation.claims[0].inferenceType = "MODEL_SYNTHESIS";
  auditOnlyCitation.timeline[0].evidenceIds = [auditOnlyId];
  auditOnlyCitation.evidenceUsage[0] = {
    evidenceId: auditOnlyId,
    relation: "PARTIAL_SUPPORT",
    supportedClaimIds: ["claim-1"],
  };
  fixture.providerResponse = completedResponse(auditOnlyCitation);

  const failed = await service.getRun({ runId: created.runId });

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "model_ruling_validation_failed");
  const replay = await service.replayEvents({ runId: created.runId });
  const validationEvent = replay.events.find(
    (event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_VALIDATION_FAILED,
  );
  assert.ok(validationEvent?.payload?.errors?.some(
    (error) => error.includes(
      `not present in model-visible Evidence Packet: ${auditOnlyId}`,
    ),
  ));
});

test("manual cancellation reaches the OpenAI background request and persists cancellation", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });

  const cancelled = await service.cancelRun({
    runId: created.runId,
    body: { reason: "管理员取消", requestedBy: "tester" },
  });

  assert.equal(fixture.cancelledRequestIds.includes("resp_admin_1"), true);
  assert.equal(cancelled.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(cancelled.cancellation.reason, "管理员取消");
  assert.equal(cancelled.stageTiming.status, "CANCELLED");
});

test("a completed provider response wins a late cancellation race and settles atomically", async () => {
  const fixture = makeFixture();
  fixture.providerCancelStatus = "completed";
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  const cancellationRequested = await service.cancelRun({
    runId: created.runId,
    body: {
      reason: "管理员稍晚取消",
      requestedBy: "tester",
    },
  });
  assert.equal(cancellationRequested.status, ADMIN_RUN_STATUSES.CANCEL_REQUESTED);
  const beforePoll = await service.replayEvents({ runId: created.runId });
  fixture.providerResponse = completedResponse(makeStructuredRuling());

  const settled = await service.pollRun({ runId: created.runId });

  assert.equal(settled.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(settled.stageTiming.status, "COMPLETED");
  assert.equal(settled.cancellation.reason, "管理员稍晚取消");
  assert.equal(settled.cancellation.cancelledAt, null);
  const replay = await service.replayEvents({
    runId: created.runId,
    afterSequence: beforePoll.lastSequence,
  });
  assert.equal(replay.events.some((event) => event.type === "STAGE_PROGRESS"), false);
  assert.equal(replay.events.at(-1).type, "RUN_SUCCEEDED");
  assert.equal(replay.events.at(-1).payload.trackerStatus, "COMPLETED");
});

test("a failed provider response settles CANCEL_REQUESTED as FAILED", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  await fixture.runStore.requestCancellation(created.runId, {
    reason: "管理员取消",
    requestedBy: "tester",
  });
  fixture.providerResponse = {
    id: "resp_admin_1",
    status: "failed",
    model: "gpt-5.6-terra",
    error: {
      code: "provider_failed_after_cancel",
      message: "provider failed after cancellation was requested",
    },
  };

  const settled = await service.pollRun({ runId: created.runId });

  assert.equal(settled.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(settled.error.code, "provider_failed_after_cancel");
});

test("an active CANCEL_REQUESTED run retries a transient provider cancellation failure", async () => {
  const fixture = makeFixture();
  fixture.providerCancelFailuresRemaining = 1;
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });

  const requested = await service.cancelRun({
    runId: created.runId,
    body: { reason: "管理员取消", requestedBy: "tester" },
  });
  assert.equal(requested.status, ADMIN_RUN_STATUSES.CANCEL_REQUESTED);
  assert.equal(fixture.providerCancelAttempts, 1);

  const settled = await service.pollRun({ runId: created.runId });

  assert.equal(settled.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(settled.stageTiming.status, "CANCELLED");
  assert.equal(fixture.providerCancelAttempts, 2);
  const replay = await service.replayEvents({ runId: created.runId });
  assert.equal(
    replay.events.filter(
      (event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_CANCEL_FAILED,
    ).length,
    1,
  );
});

test("legacy interrupted terminal timing snapshots replay to terminal run states", async () => {
  const completionFixture = makeFixture();
  const completionService = makeService(completionFixture);
  const completionCreated = await completionService.createRun({
    body: { question: "匿名成功恢复问题" },
  });
  await completionService.executeRun({ runId: completionCreated.runId });
  const completionRunning = await completionFixture.runStore.getRun(completionCreated.runId);
  await completionFixture.runStore.updateStageProgress(
    completionCreated.runId,
    makeLegacyTerminalTiming(completionRunning.stageTiming, "COMPLETED"),
    { executionToken: "admin-service-test-execution-token" },
  );
  completionFixture.providerResponse = completedResponse(makeStructuredRuling());

  const completed = await completionService.pollRun({ runId: completionCreated.runId });
  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(completed.stageTiming.status, "COMPLETED");

  const cancellationFixture = makeFixture();
  const cancellationService = makeService(cancellationFixture);
  const cancellationCreated = await cancellationService.createRun({
    body: { question: "匿名取消恢复问题" },
  });
  await cancellationService.executeRun({ runId: cancellationCreated.runId });
  await cancellationFixture.runStore.requestCancellation(cancellationCreated.runId, {
    reason: "管理员取消",
    requestedBy: "tester",
  });
  const cancellationRunning = await cancellationFixture.runStore.getRun(cancellationCreated.runId);
  await cancellationFixture.runStore.updateStageProgress(
    cancellationCreated.runId,
    makeLegacyTerminalTiming(cancellationRunning.stageTiming, "CANCELLED"),
    { executionToken: "admin-service-test-execution-token" },
  );
  cancellationFixture.providerResponse = {
    id: "resp_admin_1",
    status: "cancelled",
    model: "gpt-5.6-terra",
  };

  const cancelled = await cancellationService.pollRun({ runId: cancellationCreated.runId });
  assert.equal(cancelled.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(cancelled.stageTiming.status, "CANCELLED");
});

test("only a server-side environment switch can disable live official QA", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_LIVE_OFFICIAL_QA: "false",
  });
  const created = await service.createRun({
    body: {
      question: "匿名问题",
      enableLiveOfficialQa: true,
      retrievalEnv: { RAG_LIVE_OFFICIAL_QA: "true" },
    },
  });
  await service.executeRun({ runId: created.runId });
  assert.equal(fixture.retrieveRequests[0].enableLiveOfficialQa, false);
  assert.equal(fixture.retrieveRequests[0].env.RAG_LIVE_OFFICIAL_QA, "false");
});

test("a RUNNING run interrupted before evidence finalization can restart from its immutable request", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名恢复问题" } });
  await fixture.runStore.startRun(created.runId);

  const execution = await service.executeRun({ runId: created.runId });
  assert.equal(execution.run.preparationFinalizedAt !== null, true);
  assert.equal(execution.providerRequest.requestId, "resp_admin_1");
  assert.equal(fixture.deepSeekPrepareCalls, 1);
});

test("cancelling SUBMITTING persists the accepted request id before provider cancellation", async () => {
  const fixture = makeFixture();
  const createGate = deferred();
  fixture.openAICreateGate = createGate.promise;
  fixture.providerCancelDelayMs = 15;
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_EXECUTION_HEARTBEAT_MS: "5",
  });
  const created = await service.createRun({ body: { question: "匿名取消竞态问题" } });

  const executionPromise = service.executeRun({ runId: created.runId });
  await waitUntil(() => fixture.openAICreateCalls.length === 1);
  const beforeHeartbeat = await service.replayEvents({ runId: created.runId });
  await delay(18);
  const duringHeartbeat = await service.replayEvents({ runId: created.runId });
  assert.ok(
    countEvents(duringHeartbeat, "EXECUTION_LEASE_RENEWED")
      > countEvents(beforeHeartbeat, "EXECUTION_LEASE_RENEWED"),
    "provider create must renew its execution lease while awaiting the network",
  );

  const requested = await service.cancelRun({
    runId: created.runId,
    body: { reason: "管理员取消", requestedBy: "tester" },
  });
  assert.equal(requested.status, ADMIN_RUN_STATUSES.CANCEL_REQUESTED);
  assert.equal(requested.execution.providerSubmission.state, "SUBMITTING");

  createGate.resolve();
  const settled = await executionPromise;
  assert.equal(settled.run.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(settled.run.execution.providerSubmission.state, "SUBMITTED");
  assert.equal(settled.run.execution.providerSubmission.requestId, "resp_admin_1");
  assert.equal(fixture.providerCancelAttempts, 1);
  assert.deepEqual(fixture.cancelledRequestIds, ["resp_admin_1"]);
  assert.equal(typeof fixture.openAICreateCalls[0].signal?.addEventListener, "function");
  assert.equal(typeof fixture.cancelSignals[0]?.addEventListener, "function");
  const afterCancellation = await service.replayEvents({ runId: created.runId });
  assert.ok(
    countEvents(afterCancellation, "EXECUTION_LEASE_RENEWED")
      >= countEvents(duringHeartbeat, "EXECUTION_LEASE_RENEWED") + 2,
    "provider cancellation must keep renewing the lease while awaiting the network",
  );
});

test("preparation and provider polling renew leases during long awaits", async () => {
  const fixture = makeFixture();
  const preparationGate = deferred();
  fixture.deepSeekPrepareGate = preparationGate.promise;
  fixture.providerRetrieveDelayMs = 20;
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_EXECUTION_HEARTBEAT_MS: "5",
  });
  const created = await service.createRun({ body: { question: "匿名心跳问题" } });

  const executionPromise = service.executeRun({ runId: created.runId });
  await waitUntil(() => fixture.deepSeekPrepareCalls === 1);
  const beforePreparationHeartbeat = await service.replayEvents({ runId: created.runId });
  await delay(18);
  const duringPreparationHeartbeat = await service.replayEvents({ runId: created.runId });
  assert.ok(
    countEvents(duringPreparationHeartbeat, "EXECUTION_LEASE_RENEWED")
      > countEvents(beforePreparationHeartbeat, "EXECUTION_LEASE_RENEWED"),
  );
  preparationGate.resolve();
  await executionPromise;

  const beforePoll = await service.replayEvents({ runId: created.runId });
  await service.pollRun({ runId: created.runId });
  const afterPoll = await service.replayEvents({ runId: created.runId });
  assert.ok(
    countEvents(afterPoll, "EXECUTION_LEASE_RENEWED")
      > countEvents(beforePoll, "EXECUTION_LEASE_RENEWED"),
    "provider retrieve must renew its lease while awaiting the network",
  );
  assert.equal(typeof fixture.retrieveSignals[0]?.addEventListener, "function");
});

test("cancelling evidence preparation aborts the active preparation request", async () => {
  const fixture = makeFixture();
  let preparationSignal = null;
  const service = makeService(fixture, { GLM_API_KEY: "server-only-glm-key" }, {
    preparationProviders: {
      glm: {
        providerId: "glm",
        async prepareEvidence({ signal }) {
          preparationSignal = signal;
          return new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason || new Error("aborted"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名资料准备取消问题",
      preparationModel: "glm-5.2",
      preparationReasoningMode: "standard",
      preparationReasoningEffort: "none",
    },
  });

  const executionPromise = service.executeRun({ runId: created.runId });
  await waitUntil(() => preparationSignal !== null);
  const cancelled = await service.cancelRun({
    runId: created.runId,
    body: { reason: "取消资料准备", requestedBy: "tester" },
  });
  const execution = await executionPromise;

  assert.equal(preparationSignal.aborted, true);
  assert.ok([
    ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
    ADMIN_RUN_STATUSES.CANCELLED,
  ].includes(cancelled.status));
  assert.equal(execution.run.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(fixture.openAICreateCalls.length, 0);
});

test("poll safely reconciles an expired SUBMITTING owner to outcome_unknown without resubmission", async () => {
  const fixture = makeFixture();
  const createGate = deferred();
  fixture.openAICreateGate = createGate.promise;
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_EXECUTION_HEARTBEAT_MS: "600000",
  });
  const created = await service.createRun({ body: { question: "匿名崩溃恢复问题" } });
  const abandonedExecution = service.executeRun({ runId: created.runId });
  await waitUntil(() => fixture.openAICreateCalls.length === 1);
  assert.equal(
    (await fixture.runStore.getRun(created.runId)).execution.providerSubmission.state,
    "SUBMITTING",
  );

  fixture.advance(120_001);
  const reconciled = await service.pollRun({ runId: created.runId });
  assert.equal(reconciled.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(reconciled.error.code, "openai_submission_outcome_unknown");
  assert.equal(reconciled.execution.providerSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(fixture.openAICreateCalls.length, 1);

  createGate.resolve();
  await abandonedExecution;
  await service.executeRun({ runId: created.runId });
  assert.equal(fixture.openAICreateCalls.length, 1, "reconcile must never reissue provider create");
});

test("expired CANCEL_REQUESTED plus SUBMITTING settles unknown instead of cancelled or resubmitted", async () => {
  const fixture = makeFixture();
  const createGate = deferred();
  fixture.openAICreateGate = createGate.promise;
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_EXECUTION_HEARTBEAT_MS: "600000",
  });
  const created = await service.createRun({ body: { question: "匿名取消崩溃问题" } });
  const abandonedExecution = service.executeRun({ runId: created.runId });
  await waitUntil(() => fixture.openAICreateCalls.length === 1);
  const requested = await service.cancelRun({
    runId: created.runId,
    body: { reason: "管理员取消", requestedBy: "tester" },
  });
  assert.equal(requested.status, ADMIN_RUN_STATUSES.CANCEL_REQUESTED);
  assert.equal(requested.execution.providerSubmission.state, "SUBMITTING");

  fixture.advance(120_001);
  const reconciled = await service.pollRun({ runId: created.runId });
  assert.equal(reconciled.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(reconciled.error.code, "openai_submission_outcome_unknown");
  assert.equal(reconciled.execution.providerSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(fixture.openAICreateCalls.length, 1);

  createGate.resolve();
  await abandonedExecution;
  await service.executeRun({ runId: created.runId });
  assert.equal(fixture.openAICreateCalls.length, 1);
});

test("two service instances sharing persistent CAS issue only one provider create", async () => {
  const fixture = makeFixture();
  const storage = createMemoryAdminRunStorage();
  const serviceA = makeService(fixture, {}, { storage });
  const serviceB = makeService(fixture, {}, { storage });
  const created = await serviceA.createRun({ body: { question: "匿名并发提交问题" } });

  const results = await Promise.all([
    serviceA.executeRun({ runId: created.runId }),
    serviceB.executeRun({ runId: created.runId }),
  ]);
  assert.equal(fixture.openAICreateCalls.length, 1);
  assert.equal(fixture.deepSeekPrepareCalls, 1);
  assert.equal(
    results.some((item) => item.providerRequest?.requestId === "resp_admin_1"),
    true,
  );
  const persisted = await fixture.runStore.getRun(created.runId);
  assert.equal(persisted.execution.providerSubmission.state, "SUBMITTED");
  assert.equal(persisted.execution.providerSubmission.requestId, "resp_admin_1");
});

test("accept-before-record storage failure becomes outcome_unknown without a second create", async () => {
  const fixture = makeFixture();
  const baseStorage = createMemoryAdminRunStorage();
  let failAcceptedCommit = true;
  const storage = {
    ...baseStorage,
    async commitRun(argument) {
      if (
        failAcceptedCommit
        && argument?.event?.type === "PROVIDER_SUBMISSION_ACCEPTED"
      ) {
        failAcceptedCommit = false;
        throw new Error("simulated persistence loss after upstream acceptance");
      }
      return baseStorage.commitRun(argument);
    },
  };
  const service = makeService(fixture, {}, { storage });
  const created = await service.createRun({ body: { question: "匿名落库歧义问题" } });

  const first = await service.executeRun({ runId: created.runId });
  assert.equal(first.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(first.run.error.code, "openai_submission_record_outcome_unknown");
  assert.equal(first.run.execution.providerSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(fixture.openAICreateCalls.length, 1);

  const second = await service.executeRun({ runId: created.runId });
  assert.equal(second.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(second.providerRequest, null);
  assert.equal(fixture.openAICreateCalls.length, 1);
});

test("an ambiguous provider submission is failed closed and never resubmitted", async () => {
  const fixture = makeFixture();
  fixture.openAICreateFailuresRemaining = 1;
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名提交恢复问题" } });

  const interrupted = await service.executeRun({ runId: created.runId });
  assert.equal(interrupted.run.preparationFinalizedAt !== null, true);
  assert.equal(interrupted.providerRequest, null);
  assert.equal(interrupted.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(interrupted.run.error.code, "openai_submission_outcome_unknown");
  assert.equal(
    interrupted.run.execution.providerSubmission.state,
    "OUTCOME_UNKNOWN",
  );

  const resumed = await service.executeRun({ runId: created.runId });
  assert.equal(resumed.providerRequest, null);
  assert.equal(resumed.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(fixture.deepSeekPrepareCalls, 1, "frozen evidence must not be rebuilt");
  assert.equal(fixture.openAICreateCalls.length, 1, "ambiguous create must never be retried");
});

function makeService(fixture, envOverrides = {}, {
  storage = createMemoryAdminRunStorage(),
  preparationProviders = {},
} = {}) {
  const runStore = createAdminRunStore({
    storage,
    runIdFactory: () => "admin-service-run-1",
    executionTokenFactory: () => "admin-service-test-execution-token",
    now: () => fixture.wallNow(),
  });
  fixture.runStore = runStore;
  return createAdminModelLabService({
    runStore,
    env: {
      ADMIN_MODEL_LAB_ENABLED: "true",
      ADMIN_OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "server-only-test-key",
      DEEPSEEK_API_KEY: "server-only-test-key",
      ...envOverrides,
    },
    deepSeekProvider: {
      async prepareEvidence() {
        fixture.deepSeekPrepareCalls += 1;
        if (fixture.deepSeekPrepareGate) await fixture.deepSeekPrepareGate;
        fixture.advance(20);
        return {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          canMakeFinalRuling: false,
          canDecideEscalation: false,
          result: {
            cardNameCandidates: [
              { name: "匿名卡A", originalText: "匿名卡A" },
              { name: "匿名卡B", originalText: "匿名卡B" },
            ],
            ruleSearchQueries: [
              { query: "匿名规则", reason: "mechanism" },
            ],
            conflicts: ["廉价模型发现候选资料可能冲突"],
            organizedEvidenceIds: ["evidence-direct"],
          },
          usage: fixture.deepSeekUsage,
        };
      },
      async runRuling() {
        fixture.deepSeekFinalCalls += 1;
        throw new Error("must never be called");
      },
    },
    preparationProviders,
    openAIProvider: {
      async create(request) {
        fixture.openAICreateCalls.push(request);
        if (fixture.openAICreateGate) await fixture.openAICreateGate;
        fixture.advance(30);
        if (fixture.openAICreateFailuresRemaining > 0) {
          fixture.openAICreateFailuresRemaining -= 1;
          throw new Error("simulated provider submission interruption");
        }
        return {
          id: "resp_admin_1",
          status: "queued",
          model: "gpt-5.6-terra",
          created_at: 1_800_000_000,
        };
      },
      async retrieve(_responseId, options = {}) {
        fixture.retrieveSignals.push(options.signal || null);
        if (fixture.providerRetrieveDelayMs > 0) {
          await delay(fixture.providerRetrieveDelayMs);
        }
        fixture.advance(40);
        return fixture.providerResponse;
      },
      async cancel(responseId, options = {}) {
        fixture.providerCancelAttempts += 1;
        fixture.cancelledRequestIds.push(responseId);
        fixture.cancelSignals.push(options.signal || null);
        if (fixture.providerCancelDelayMs > 0) {
          await delay(fixture.providerCancelDelayMs);
        }
        if (fixture.providerCancelFailuresRemaining > 0) {
          fixture.providerCancelFailuresRemaining -= 1;
          throw new Error("simulated transient provider cancellation failure");
        }
        return {
          id: responseId,
          status: fixture.providerCancelStatus,
        };
      },
    },
    loadData: async () => {
      fixture.loadDataCalls += 1;
      fixture.advance(10);
      return fixture.data;
    },
    extractCards: (_question, options) => {
      fixture.advance(5);
      assert.equal(options.maxCards, fixture.data.cards.length);
      assert.deepEqual(
        options.modelCardNameCandidates.map((item) => item.name),
        ["匿名卡A", "匿名卡B"],
      );
      return fixture.cardResolution;
    },
    retrieveEvidence: async (request) => {
      fixture.retrieveRequests.push(request);
      fixture.advance(25);
      assert.equal(request.ruleSearchQueries[0].query, "匿名规则");
      return fixture.retrieval;
    },
    promptLoader: async () => "匿名系统提示：只依据证据输出严格 JSON。",
    monotonicNow: () => fixture.monotonicMs,
    wallNow: () => fixture.wallNow(),
  });
}

function makeFixture() {
  const baseMs = Date.parse("2027-01-01T00:00:00.000Z");
  const fixture = {
    monotonicMs: 0,
    deepSeekPrepareCalls: 0,
    deepSeekFinalCalls: 0,
    loadDataCalls: 0,
    retrieveRequests: [],
    openAICreateCalls: [],
    openAICreateGate: null,
    openAICreateFailuresRemaining: 0,
    deepSeekPrepareGate: null,
    cancelledRequestIds: [],
    cancelSignals: [],
    retrieveSignals: [],
    providerCancelAttempts: 0,
    providerCancelFailuresRemaining: 0,
    providerCancelStatus: "cancelled",
    providerCancelDelayMs: 0,
    providerRetrieveDelayMs: 0,
    providerResponse: {
      id: "resp_admin_1",
      status: "in_progress",
      model: "gpt-5.6-terra",
    },
    deepSeekUsage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    data: {
      cards: [
        { id: "card-a", name: "匿名卡A", text: "匿名效果A全文" },
        { id: "card-b", name: "匿名卡B", text: "匿名效果B全文" },
      ],
      records: [{ id: "raw-rule", text: "完整规则资料" }],
      qaRecords: [{ id: "raw-qa", text: "完整问答资料" }],
    },
    cardResolution: {
      resolvedCards: [{
        id: "card-a",
        name: "匿名卡A",
        text: "匿名效果A全文",
        type: "效果怪兽",
        cardType: "monster",
        race: "测试族",
        attribute: "测试属性",
        level: 4,
        attack: 1800,
        defense: 1200,
      }],
      unresolvedMentions: [{ input: "匿名卡C", reason: "not_found" }],
      ambiguousMentions: [{
        input: "匿名简称",
        candidates: [{ id: "card-a" }, { id: "card-b" }],
      }],
      omittedResolvedCards: [],
      userProvidedCardTexts: [],
    },
    retrieval: {
      cardTexts: [{
        id: "card-text-a",
        type: "card_text",
        sourceType: "card_text",
        text: "匿名效果A全文",
      }],
      userProvidedCardTexts: [],
      officialQaDirectCandidates: [{
        id: "evidence-direct",
        type: "official_qa",
        sourceType: "official_qa",
        text: "可以发动，并完成处理。",
        isDirect: true,
        current: true,
      }],
      officialQaRelated: [{
        id: "evidence-related",
        type: "related",
        sourceType: "official_qa",
        text: "相似场景资料。",
      }],
      provisionalOfficialResponses: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      rulebookCandidates: [],
      retrievedCards: [{ id: "card-a", name: "匿名卡A" }],
      remainingUnresolvedMentions: [{ input: "匿名卡C", reason: "not_found" }],
      fuzzyResolvedCards: [],
      baigeResolvedCards: [],
      baigeAmbiguousMentions: [],
      ruleSearchQueries: [{ query: "匿名规则", reason: "mechanism" }],
      retrievalWarnings: [],
      debug: { raw: "debug is preserved in the frozen snapshot" },
    },
    advance(ms) {
      this.monotonicMs += ms;
    },
    wallNow() {
      return new Date(baseMs + this.monotonicMs);
    },
  };
  return fixture;
}

function completedResponse(output) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return {
    id: "resp_admin_1",
    status: "completed",
    model: "gpt-5.6-terra",
    created_at: 1_800_000_000,
    completed_at: 1_800_000_003,
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 200 },
      total_tokens: 1500,
    },
    output: [{
      type: "message",
      content: [{ type: "output_text", text }],
    }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await delay(0);
  }
  throw new Error("timed out waiting for asynchronous test state");
}

function countEvents(replay, type) {
  return replay.events.filter((event) => event.type === type).length;
}

function makeLegacyTerminalTiming(value, status) {
  const timing = structuredClone(value);
  const finalStage = timing.stages.find((stage) => stage.id === "generate_ruling");
  const endOffsetMs = Math.max(
    Number(timing.totalElapsedMs) || 0,
    Number(finalStage?.startOffsetMs) || 0,
  ) + 1;
  const endedAt = new Date(Date.parse(timing.createdAt) + endOffsetMs).toISOString();
  timing.status = status;
  timing.totalElapsedMs = endOffsetMs;
  timing.endedAt = endedAt;
  if (finalStage) {
    finalStage.status = status;
    finalStage.endOffsetMs = endOffsetMs;
    finalStage.durationMs = Math.max(
      0,
      endOffsetMs - (Number(finalStage.startOffsetMs) || 0),
    );
    finalStage.endedAt = endedAt;
  }
  if (status === "CANCELLED") {
    timing.cancellation = {
      reason: "legacy interrupted cancellation",
      requestedBy: "tester",
      cancelledAt: endedAt,
    };
  }
  return timing;
}

function makeStructuredRuling() {
  return {
    schemaVersion: "1.0",
    verdicts: [{
      questionId: "q1",
      value: "TRUE",
      conclusion: "可以发动，并完成处理。",
      conditions: [],
    }],
    conciseAnswer: "可以发动，并完成处理。",
    claims: [{
      claimId: "claim-1",
      proposition: "题目中的操作合法。",
      status: "TRUE",
      decisive: true,
      evidenceIds: ["evidence-direct"],
      inferenceType: "DIRECT_OFFICIAL",
    }],
    timeline: [{
      order: 1,
      action: "效果处理",
      result: "完成处理。",
      evidenceIds: ["evidence-direct"],
    }],
    assumptions: [],
    evidenceUsage: [{
      evidenceId: "evidence-direct",
      relation: "DIRECTLY_ENTAILS",
      supportedClaimIds: ["claim-1"],
    }],
    counterChecks: MODEL_RULING_COUNTER_CHECK_TYPES.map((type) => ({
      type,
      passed: true,
      note: "",
    })),
    unresolved: [],
    confidence: {
      level: "HIGH",
      reasons: ["存在直接证据。"],
    },
  };
}
