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

test("a domestic experimental final ruling completes synchronously and is labelled non-authoritative", async () => {
  const fixture = makeFixture();
  const domesticCalls = [];
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        async create(request) {
          domesticCalls.push(request);
          return {
            id: "deepseek-final-1",
            status: "completed",
            model: "deepseek-v4-flash",
            output_text: JSON.stringify(makeStructuredRuling()),
            usage: { prompt_tokens: 900, completion_tokens: 600, total_tokens: 1500 },
          };
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名问题",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
      reasoningMode: "standard",
    },
  });
  const execution = await service.executeRun({ runId: created.runId });

  assert.equal(execution.run.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(execution.run.result.experimental, true);
  assert.equal(execution.run.result.authority.classification, "experimental_non_authoritative");
  assert.equal(execution.run.result.authority.publicAnswerEligible, false);
  assert.equal(execution.run.result.provider.providerId, "deepseek");
  assert.equal(execution.run.result.finalRuling.conciseAnswer, "可以发动，并完成处理。");
  assert.equal(domesticCalls.length, 1);
  assert.match(domesticCalls[0].input, /evidence-direct/u);
  assert.equal(fixture.openAICreateCalls.length, 0);
});

test("one directed repair succeeds on the same frozen evidence and accumulates both paid attempts", async () => {
  const fixture = makeFixture();
  const calls = [];
  const responses = [
    {
      id: "deepseek-primary-invalid",
      status: "completed",
      model: "deepseek-v4-flash",
      output_text: "{}",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
    {
      id: "deepseek-repair-valid",
      status: "completed",
      model: "deepseek-v4-flash",
      output_text: JSON.stringify(makeStructuredRuling()),
      usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    },
  ];
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "test-v1",
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2027-01-01",
    ADMIN_MODEL_LAB_DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    ADMIN_MODEL_LAB_DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7",
  }, {
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        async create(request) {
          calls.push(request);
          return responses[calls.length - 1];
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名修复问题",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
    },
  });
  const originalSnapshot = structuredClone(created.evidenceSnapshot);
  const completed = (await service.executeRun({ runId: created.runId })).run;

  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(calls.length, 2);
  assert.equal(fixture.deepSeekPrepareCalls, 1);
  assert.equal(fixture.loadDataCalls, 1);
  assert.deepEqual(completed.evidenceSnapshot.evidence.initialRequest, originalSnapshot);
  assert.equal(
    completed.execution.repair.invariants.evidenceSnapshotId,
    completed.evidenceSnapshot.snapshotId,
  );
  assert.equal(
    completed.execution.repair.invariants.promptSha256,
    completed.executionProfile.prompt.sha256,
  );
  assert.equal(calls[0].instructions, calls[1].instructions);
  assert.match(calls[1].input, /单次定向修复/u);
  assert.match(calls[1].input, /validationErrors/u);
  assert.equal(completed.result.provider.requestId, "deepseek-repair-valid");
  assert.equal(completed.result.repair.attempted, true);
  assert.equal(completed.result.repair.attempts.length, 2);
  assert.equal(completed.result.metering.stages.finalRuling.attempts.length, 2);
  assert.equal(completed.result.metering.stages.finalRuling.usage.totalTokens, 270);
  assert.equal(completed.execution.repair.totals.usage.totalTokens, 270);
  const [firstAttempt, repairAttempt] = completed.result.metering.stages.finalRuling.attempts;
  assert.equal(
    completed.result.metering.stages.finalRuling.cost.totalCostCny,
    firstAttempt.cost.totalCostCny + repairAttempt.cost.totalCostCny,
  );
});

test("a second invalid completed response fails closed without a third submission", async () => {
  const fixture = makeFixture();
  const calls = [];
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      glm: {
        providerId: "glm",
        async create(request) {
          calls.push(request);
          return {
            id: `glm-invalid-${calls.length}`,
            status: "completed",
            model: "glm-5.2",
            output_text: "{}",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  });
  const created = await service.createRun({
    body: { question: "匿名二次失败问题", provider: "glm", model: "glm-5.2" },
  });
  const failed = (await service.executeRun({ runId: created.runId })).run;

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "model_ruling_validation_failed");
  assert.equal(calls.length, 2);
  assert.equal(failed.execution.repairSubmission.state, "SUBMITTED");
  assert.equal(failed.execution.repair.attempts.length, 2);
  assert.equal(failed.execution.repair.totals.usage.totalTokens, 30);
  assert.equal(failed.execution.repair.completedAttempt.validation.ok, false);
  await service.executeRun({ runId: created.runId });
  assert.equal(calls.length, 2);
});

test("an unrecoverable empty completed response never opens a repair submission", async () => {
  const fixture = makeFixture();
  const calls = [];
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      kimi: {
        providerId: "kimi",
        async create(request) {
          calls.push(request);
          return {
            id: "kimi-empty-primary",
            status: "completed",
            model: "kimi-k2.6",
            output_text: "",
            usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          };
        },
      },
    },
  });
  const created = await service.createRun({
    body: { question: "匿名空输出问题", provider: "kimi", model: "kimi-k2.6" },
  });
  const failed = (await service.executeRun({ runId: created.runId })).run;

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(calls.length, 1);
  assert.equal(failed.execution.repair, null);
  assert.equal(failed.execution.repairSubmission.state, "NONE");
});

test("cancelling an in-flight repair aborts it and an unknown outcome is never retried", async () => {
  const fixture = makeFixture();
  const calls = [];
  const repairStarted = deferred();
  let repairSignal = null;
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      glm: {
        providerId: "glm",
        async create(request) {
          calls.push(request);
          if (calls.length === 1) {
            return {
              id: "glm-primary-invalid",
              status: "completed",
              model: "glm-5.2",
              output_text: "{}",
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          repairSignal = request.signal;
          repairStarted.resolve();
          return new Promise((resolve, reject) => {
            const abort = () => reject(request.signal.reason || new Error("repair aborted"));
            if (request.signal.aborted) abort();
            else request.signal.addEventListener("abort", abort, { once: true });
          });
        },
      },
    },
  });
  const created = await service.createRun({
    body: { question: "匿名取消修复问题", provider: "glm", model: "glm-5.2" },
  });
  const execution = service.executeRun({ runId: created.runId });
  await repairStarted.promise;
  await service.cancelRun({
    runId: created.runId,
    body: { reason: "cancel repair", requestedBy: "test" },
  });
  const failed = (await execution).run;

  assert.equal(repairSignal.aborted, true);
  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.execution.repairSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(calls.length, 2);
  await service.executeRun({ runId: created.runId });
  assert.equal(calls.length, 2);
});

test("polling cannot fail a domestic synchronous result while its executor still owns the lease", async () => {
  const fixture = makeFixture();
  const acceptedGate = deferred();
  fixture.afterProviderAccepted = acceptedGate.promise;
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        async create() {
          return {
            id: "deepseek-final-race",
            status: "completed",
            model: "deepseek-v4-flash",
            output_text: JSON.stringify(makeStructuredRuling()),
            usage: { prompt_tokens: 900, completion_tokens: 600, total_tokens: 1500 },
          };
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名并发轮询问题",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
      reasoningMode: "standard",
    },
  });
  const executionPromise = service.executeRun({ runId: created.runId });
  await waitUntil(async () => {
    const run = await fixture.runStore.getRun(created.runId);
    return run.execution?.providerSubmission?.state === "SUBMITTED";
  });

  const duringExecution = await service.pollRun({ runId: created.runId });
  assert.equal(duringExecution.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.equal(duringExecution.error, null);

  acceptedGate.resolve();
  const execution = await executionPromise;
  assert.equal(execution.run.status, ADMIN_RUN_STATUSES.SUCCEEDED);
});

test("evidence preparation is fixed to DeepSeek V4 Flash and client transport fields are ignored", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({
    body: {
      question: "匿名问题",
      preparationModel: "deepseek-v4-flash",
      preparationReasoningMode: "standard",
      preparationReasoningEffort: "none",
      provider: "openai",
      model: "gpt-5.6-terra",
      baseUrl: "https://attacker.invalid/v1",
      apiKey: "frontend-secret",
    },
  });
  assert.equal(created.executionProfile.preparation.provider, "deepseek");
  assert.equal(created.executionProfile.preparation.model, "deepseek-v4-flash");
  assert.equal(created.executionProfile.finalRuling.provider, "openai");
  assert.equal(JSON.stringify(created).includes("frontend-secret"), false);
  assert.equal(JSON.stringify(created).includes("attacker.invalid"), false);

  const execution = await service.executeRun({ runId: created.runId });
  assert.equal(fixture.deepSeekPrepareCalls, 1);
  assert.equal(execution.run.evidenceSnapshot.evidence.preparation.provider, "deepseek");
  assert.equal(fixture.openAICreateCalls.length, 1);

  await assert.rejects(
    service.createRun({
      body: {
        question: "provider mismatch",
        preparationProvider: "glm",
        preparationModel: "glm-5.2",
      },
    }),
    (error) => error.code === "model_stage_not_allowed",
  );
});

test("complete deterministic card resolution skips the paid preparation model", async () => {
  const fixture = makeFixture();
  fixture.cardResolution = {
    ...fixture.cardResolution,
    unresolvedMentions: [],
    ambiguousMentions: [],
  };
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "「匿名卡A」如何处理？" } });
  const execution = await service.executeRun({ runId: created.runId });

  assert.equal(fixture.deepSeekPrepareCalls, 0);
  assert.equal(execution.run.evidenceSnapshot.evidence.preparation.skipped, true);
  assert.equal(
    execution.run.evidenceSnapshot.evidence.preparation.skipReason,
    "deterministic_card_resolution_complete",
  );
  assert.deepEqual(
    execution.run.evidenceSnapshot.evidence.preparation.extractedHints.ruleSearchQueries,
    [],
  );

  fixture.providerResponse = completedResponse(makeStructuredRuling());
  const completed = await service.getRun({ runId: created.runId });
  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(completed.result.metering.stages.evidencePreparation.usageStatus, "skipped");
  assert.equal(completed.result.metering.stages.evidencePreparation.usage.totalTokens, 0);
  assert.equal(completed.result.metering.stages.evidencePreparation.cost.totalCostCny, 0);
});

test("zero deterministic card matches still invokes preparation even without quote marks", async () => {
  const fixture = makeFixture();
  fixture.cardResolution = {
    ...fixture.cardResolution,
    resolvedCards: [],
    unresolvedMentions: [],
    ambiguousMentions: [],
  };
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "简称卡发动后如何处理？" } });
  await service.executeRun({ runId: created.runId });

  assert.equal(fixture.deepSeekPrepareCalls, 1);
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

test("invalid final JSON receives one directed repair and then fails closed", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  fixture.providerResponse = completedResponse("```json\n{}\n```");

  const repairing = await service.getRun({ runId: created.runId });
  assert.equal(repairing.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.equal(repairing.execution.repairSubmission.state, "SUBMITTED");
  const failed = await service.getRun({ runId: created.runId });

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "model_ruling_validation_failed");
  assert.equal(failed.stageTiming.status, "CANCELLED");
  assert.equal(fixture.openAICreateCalls.length, 2);
  const replay = await service.replayEvents({ runId: created.runId });
  assert.equal(
    replay.events.some((event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_VALIDATION_FAILED),
    true,
  );
});

test("final validation records a provenance-only downgrade without changing the ruling", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const created = await service.createRun({ body: { question: "匿名问题" } });
  const execution = await service.executeRun({ runId: created.runId });
  const cardTextEvidence = execution.run.evidenceSnapshot.evidence.evidenceDecisionPacket
    .modelPacket.evidenceItems.find((item) => item.category === "parsed_card_text");
  assert.ok(cardTextEvidence?.evidenceId);

  const overclaimed = makeStructuredRuling();
  overclaimed.claims[0].evidenceIds = [cardTextEvidence.evidenceId];
  overclaimed.timeline[0].evidenceIds = [cardTextEvidence.evidenceId];
  overclaimed.evidenceUsage[0].evidenceId = cardTextEvidence.evidenceId;
  fixture.providerResponse = completedResponse(overclaimed);

  const completed = await service.getRun({ runId: created.runId });
  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(completed.result.finalRuling.verdicts[0].value, "TRUE");
  assert.equal(completed.result.finalRuling.claims[0].inferenceType, "CARD_TEXT");
  assert.equal(completed.result.finalRuling.evidenceUsage[0].relation, "SUPPORTS_STEP");
  assert.equal(completed.result.validation.provenanceCorrections.length, 2);
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

  const repairing = await service.getRun({ runId: created.runId });
  assert.equal(repairing.status, ADMIN_RUN_STATUSES.RUNNING);
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
  const service = makeService(fixture, {}, {
    deepSeekProvider: {
      providerId: "deepseek",
      async prepareEvidence({ signal }) {
        preparationSignal = signal;
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason || new Error("aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名资料准备取消问题",
      preparationModel: "deepseek-v4-flash",
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
  assert.equal(reconciled.error.code, "provider_submission_outcome_unknown");
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
  assert.equal(reconciled.error.code, "provider_submission_outcome_unknown");
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

test("a pre-commit acknowledgement timeout retries only the local write", async () => {
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
        throw codedError(
          "simulated persistence loss after upstream acceptance",
          "admin_run_redis_request_failed",
        );
      }
      return baseStorage.commitRun(argument);
    },
  };
  const service = makeService(fixture, {}, { storage });
  const created = await service.createRun({ body: { question: "匿名落库歧义问题" } });

  const first = await service.executeRun({ runId: created.runId });
  assert.equal(first.run.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.equal(first.providerRequest.requestId, "resp_admin_1");
  assert.equal(first.run.execution.providerSubmission.state, "SUBMITTED");
  assert.equal(fixture.openAICreateCalls.length, 1);

  const second = await service.executeRun({ runId: created.runId });
  assert.equal(second.providerRequest.requestId, "resp_admin_1");
  assert.equal(fixture.openAICreateCalls.length, 1);
});

test("a post-commit acknowledgement timeout is recovered idempotently", async () => {
  const fixture = makeFixture();
  const baseStorage = createMemoryAdminRunStorage();
  let loseFirstAcceptedResponse = true;
  const storage = {
    ...baseStorage,
    async commitRun(argument) {
      if (
        loseFirstAcceptedResponse
        && argument?.event?.type === "PROVIDER_SUBMISSION_ACCEPTED"
      ) {
        loseFirstAcceptedResponse = false;
        await baseStorage.commitRun(argument);
        throw codedError(
          "simulated timeout after the Redis transaction committed",
          "admin_run_redis_timeout",
        );
      }
      return baseStorage.commitRun(argument);
    },
  };
  const service = makeService(fixture, {}, { storage });
  const created = await service.createRun({ body: { question: "匿名提交已落库但响应丢失" } });

  const first = await service.executeRun({ runId: created.runId });
  assert.equal(first.run.status, ADMIN_RUN_STATUSES.RUNNING);
  assert.equal(first.providerRequest.requestId, "resp_admin_1");
  assert.equal(first.run.execution.providerSubmission.state, "SUBMITTED");
  assert.equal(fixture.openAICreateCalls.length, 1);
  const events = await service.replayEvents({ runId: created.runId });
  assert.equal(
    events.events.filter((event) => event.type === "PROVIDER_SUBMISSION_ACCEPTED").length,
    1,
    "idempotent acknowledgement must not duplicate the accepted event",
  );
});

test("persistent acknowledgement failure is bounded and never repeats provider create", async () => {
  const fixture = makeFixture();
  const baseStorage = createMemoryAdminRunStorage();
  let acceptedCommitAttempts = 0;
  const storage = {
    ...baseStorage,
    async commitRun(argument) {
      if (argument?.event?.type === "PROVIDER_SUBMISSION_ACCEPTED") {
        acceptedCommitAttempts += 1;
        throw codedError(
          "simulated persistent acknowledgement outage",
          "admin_run_redis_request_failed",
        );
      }
      return baseStorage.commitRun(argument);
    },
  };
  const service = makeService(fixture, {}, { storage });
  const created = await service.createRun({ body: { question: "匿名持续落库失败问题" } });

  const first = await service.executeRun({ runId: created.runId });
  assert.equal(first.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(first.run.error.code, "openai_submission_record_outcome_unknown");
  assert.equal(first.run.execution.providerSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(acceptedCommitAttempts, 3, "local acknowledgement retries must be bounded");
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
  assert.equal(interrupted.run.error.code, "provider_submission_outcome_unknown");
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

test("fork reuses the exact frozen evidence packet, skips preparation, and meters only the new final ruling", async () => {
  const fixture = makeFixture();
  const domesticCalls = [];
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        async create(request) {
          domesticCalls.push(request);
          return {
            id: "deepseek-fork-final-1",
            status: "completed",
            model: "deepseek-v4-flash",
            output_text: JSON.stringify(makeStructuredRuling()),
            usage: { prompt_tokens: 900, completion_tokens: 600, total_tokens: 1500 },
          };
        },
      },
    },
  });
  fixture.providerResponse = completedResponse(makeStructuredRuling());
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  const source = await service.getRun({ runId: created.runId });
  assert.equal(source.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  const sourceRequest = fixture.openAICreateCalls[0];
  const baseline = {
    deepSeekPrepareCalls: fixture.deepSeekPrepareCalls,
    loadDataCalls: fixture.loadDataCalls,
    extractCardsCalls: fixture.extractCardsCalls.length,
    retrieveRequests: fixture.retrieveRequests.length,
  };

  const fork = await service.forkRun({
    forkFromRunId: source.runId,
    body: {
      idempotencyKey: "fork-idempotency-0001",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
      reasoningMode: "standard",
    },
  });

  assert.equal(fork.status, ADMIN_RUN_STATUSES.QUEUED);
  assert.equal(Boolean(fork.preparationFinalizedAt), true);
  assert.equal(fork.stageTiming, null);
  assert.equal(fork.execution.providerSubmission.state, "NONE");
  assert.deepEqual(fork.evidenceSnapshot, source.evidenceSnapshot);
  assert.deepEqual(
    fork.evidenceSnapshot.evidence.evidenceDecisionPacket,
    source.evidenceSnapshot.evidence.evidenceDecisionPacket,
  );
  assert.deepEqual(fork.executionProfile.preparation, source.executionProfile.preparation);
  assert.deepEqual(fork.executionProfile.prompt, source.executionProfile.prompt);
  assert.deepEqual(fork.executionProfile.providedFacts, source.executionProfile.providedFacts);
  assert.deepEqual(fork.limits, source.limits);
  assert.equal(fork.evidenceSnapshot.metadata.finalRulingProvider, "openai");
  assert.equal(fork.executionProfile.finalRuling.provider, "deepseek");
  assert.equal(domesticCalls.length, 0, "fork creation must not submit a paid request");

  const execution = await service.executeRun({ runId: fork.runId });
  const completed = execution.run;
  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(fixture.deepSeekPrepareCalls, baseline.deepSeekPrepareCalls);
  assert.equal(fixture.loadDataCalls, baseline.loadDataCalls);
  assert.equal(fixture.extractCardsCalls.length, baseline.extractCardsCalls);
  assert.equal(fixture.retrieveRequests.length, baseline.retrieveRequests);
  assert.equal(domesticCalls.length, 1);
  assert.equal(sourceRequest.input, domesticCalls[0].input);
  assert.equal(sourceRequest.instructions, domesticCalls[0].instructions);
  assert.notEqual(sourceRequest.metadata.runId, domesticCalls[0].metadata.runId);
  assert.deepEqual(
    completed.stageTiming.stages.map((stage) => stage.status),
    ["SKIPPED", "SKIPPED", "SKIPPED", "SKIPPED", "COMPLETED"],
  );
  for (const stage of completed.stageTiming.stages.slice(0, 4)) {
    assert.equal(stage.skipReason, "reused_frozen_evidence_snapshot");
  }
  const preparation = completed.result.metering.stages.evidencePreparation;
  assert.equal(preparation.usageStatus, "reused");
  assert.equal(preparation.usage.totalTokens, 0);
  assert.equal(preparation.rawUsage, null);
  assert.equal(preparation.sourceUsage.totalTokens, 30);
  assert.equal(preparation.sourceRawUsage.total_tokens, 30);
  assert.equal(preparation.reusedFromRunId, source.runId);
  assert.equal(preparation.reusedEvidenceSnapshotId, source.evidenceSnapshot.snapshotId);
  assert.equal(preparation.cost.totalCostCny, 0);
  assert.equal(preparation.cost.totalCostUsd, 0);
  assert.equal(completed.result.metering.totals.usage.totalTokens, 1500);
  assert.equal(completed.result.latency.preparationReused, true);
  assert.equal(completed.result.latency.preparationMs, 0);
});

test("fork creation is idempotent and rejects key reuse or client evidence overrides", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  fixture.providerResponse = completedResponse(makeStructuredRuling());
  const created = await service.createRun({ body: { question: "匿名问题" } });
  await service.executeRun({ runId: created.runId });
  const source = await service.getRun({ runId: created.runId });
  const input = {
    forkFromRunId: source.runId,
    body: { idempotencyKey: "fork-idempotency-0002" },
  };
  const [first, second] = await Promise.all([
    service.forkRun(input),
    service.forkRun(input),
  ]);
  assert.equal(first.runId, second.runId);
  assert.deepEqual(first, second);
  assert.equal((await service.forkRun(input)).runId, first.runId);
  const replay = await service.replayEvents({ runId: first.runId });
  assert.equal(replay.events.filter((event) => event.type === "RUN_CREATED").length, 1);
  assert.equal(fixture.openAICreateCalls.length, 1, "fork creation must not submit another final request");

  await assert.rejects(
    service.forkRun({
      forkFromRunId: source.runId,
      body: {
        idempotencyKey: "fork-idempotency-0002",
        reasoningEffort: "high",
      },
    }),
    (error) => error?.code === "admin_fork_idempotency_conflict" && error.status === 409,
  );
  for (const field of [
    "question",
    "providedFacts",
    "instructions",
    "promptVersion",
    "preparationModel",
    "configuration",
    "evidenceSnapshot",
    "dataVersions",
  ]) {
    await assert.rejects(
      service.forkRun({
        forkFromRunId: source.runId,
        body: {
          idempotencyKey: "fork-forbidden-override-0001",
          [field]: "forbidden",
        },
      }),
      (error) => error?.code === "admin_fork_override_forbidden" && error.status === 400,
    );
  }
});

test("fork permits a failed source only after evidence is frozen and billing is unambiguous", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  await assert.rejects(
    service.forkRun({
      forkFromRunId: "missing-source-run",
      body: { idempotencyKey: "fork-source-missing-0001" },
    }),
    (error) => error?.code === "admin_run_not_found" && error.status === 404,
  );
  const queued = await service.createRun({ body: { question: "匿名问题" } });
  await assert.rejects(
    service.forkRun({
      forkFromRunId: queued.runId,
      body: { idempotencyKey: "fork-source-state-0001" },
    }),
    (error) => error?.code === "admin_fork_source_not_terminal" && error.status === 409,
  );

  fixture.providerResponse = completedResponse("{}");
  await service.executeRun({ runId: queued.runId });
  await service.getRun({ runId: queued.runId });
  const failed = await service.getRun({ runId: queued.runId });
  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.execution.providerSubmission.state, "SUBMITTED");
  const fork = await service.forkRun({
    forkFromRunId: failed.runId,
    body: { idempotencyKey: "fork-source-state-0002" },
  });
  assert.equal(fork.status, ADMIN_RUN_STATUSES.QUEUED);
  assert.equal(fork.metadata.fork.sourceRunId, failed.runId);
});

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function makeService(fixture, envOverrides = {}, {
  storage = createMemoryAdminRunStorage(),
  preparationProviders = {},
  deepSeekProvider = null,
  finalRulingProviders = {},
} = {}) {
  const baseRunStore = createAdminRunStore({
    storage,
    runIdFactory: () => "admin-service-run-1",
    executionTokenFactory: () => "admin-service-test-execution-token",
    now: () => fixture.wallNow(),
  });
  let runStore = baseRunStore;
  if (fixture.afterProviderAccepted) {
    runStore = {
      ...baseRunStore,
      async recordProviderSubmissionAccepted(...args) {
        const accepted = await baseRunStore.recordProviderSubmissionAccepted(...args);
        await fixture.afterProviderAccepted;
        return accepted;
      },
    };
  }
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
    deepSeekProvider: deepSeekProvider || {
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
    finalRulingProviders,
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
      const candidateNames = options.modelCardNameCandidates.map((item) => item.name);
      assert.equal(
        candidateNames.length === 0
          || JSON.stringify(candidateNames) === JSON.stringify(["匿名卡A", "匿名卡B"]),
        true,
      );
      fixture.extractCardsCalls.push(candidateNames);
      return fixture.cardResolution;
    },
    retrieveEvidence: async (request) => {
      fixture.retrieveRequests.push(request);
      fixture.advance(25);
      if (request.ruleSearchQueries.length > 0) {
        assert.equal(request.ruleSearchQueries[0].query, "匿名规则");
      }
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
    extractCardsCalls: [],
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
    if (await predicate()) return;
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
