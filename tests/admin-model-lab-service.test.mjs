import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES,
  MAX_FINAL_RULING_INPUT_BYTES,
  buildFinalRulingInput,
  buildFinalRulingModelEvidencePacket,
  createAdminModelLabService,
} from "../backend/adminModelLabService.mjs";
import { createAdminEvidenceArchive } from "../backend/adminEvidenceArchive.mjs";
import {
  ADMIN_RUN_STATUSES,
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "../backend/adminRunStore.mjs";
import {
  createMemoryAdminFinalCallBudgetLedger,
} from "../backend/adminFinalCallBudgetLedger.mjs";
import { createAdminStageTracker } from "../backend/adminStageTracker.mjs";
import { MODEL_RULING_COUNTER_CHECK_TYPES } from "../backend/modelRulingSchema.mjs";
import { CompatibleEvidencePreparationProvider } from "../backend/rulingModelProviders.mjs";
import { hashAdminFinalInput } from "../backend/adminEvidenceVariant.mjs";

test("final ruling input rejects oversized model-visible question text", () => {
  assert.throws(
    () => buildFinalRulingInput({
      snapshotId: "snapshot-oversized",
      contentSha256: "a".repeat(64),
      question: "审计副本不会重复进入模型输入",
      evidence: {
        questions: [{
          questionId: "q1",
          text: "问".repeat(MAX_FINAL_RULING_INPUT_BYTES),
        }],
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

test("final ruling input omits duplicate audit metadata while retaining snapshot identity", () => {
  const input = buildFinalRulingInput({
    snapshotId: "snapshot-compact",
    contentSha256: "b".repeat(64),
    question: "匿名问题",
    evidence: {
      questions: [{ questionId: "q1", text: "匿名问题" }],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {
        allCardNamesResolved: true,
        sourceCorpusCounts: { cards: 99_999, records: 99_999 },
      },
      evidenceDecisionPacket: { modelPacket: { evidenceItems: [] } },
    },
    dataVersions: { auditPayload: "版本".repeat(40_000) },
    metadata: { auditPayload: "元数据".repeat(40_000) },
  });
  const payload = JSON.parse(input.split("\n").at(-1));

  assert.deepEqual(payload.evidenceSnapshot, {
    id: "snapshot-compact",
    sha256: "b".repeat(64),
  });
  assert.equal(Object.hasOwn(payload, "metadata"), false);
  assert.equal(Object.hasOwn(payload, "dataVersions"), false);
  assert.doesNotMatch(input, /auditPayload/u);
  assert.equal(Buffer.byteLength(input) <= MAX_FINAL_RULING_INPUT_BYTES, true);
});

test("final ruling input retains distinct shared scenario text beside subquestions", () => {
  const input = buildFinalRulingInput({
    snapshotId: "snapshot-scenario",
    contentSha256: "c".repeat(64),
    question: "共同场面：匿名卡A在场上，连锁1已经发动。",
    evidence: {
      questions: [
        { questionId: "q1", text: "能否连锁发动匿名卡B？" },
        { questionId: "q2", text: "处理后匿名卡A是否留场？" },
      ],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket: { evidenceItems: [] } },
    },
  });
  const payload = JSON.parse(input.split("\n").at(-1));

  assert.equal(payload.scenarioText, "共同场面：匿名卡A在场上，连锁1已经发动。");
  assert.deepEqual(
    payload.questions.map((item) => item.questionId),
    ["q1", "q2"],
  );
});

test("final ruling input preserves legacy question and unresolved shapes", () => {
  const input = buildFinalRulingInput({
    snapshotId: "snapshot-legacy-shapes",
    contentSha256: "d".repeat(64),
    question: "[q1] 旧字符串子问题",
    evidence: {
      questions: ["旧字符串子问题"],
      providedFacts: [],
      cardResolution: {
        resolvedCards: [],
        unresolvedMentions: [{ input: "卡B", reason: "not_found" }],
      },
      unresolved: {
        cardMentions: [{ input: "卡A", reason: "not_found" }],
      },
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket: { evidenceItems: [] } },
    },
  });
  const payload = JSON.parse(input.split("\n").at(-1));

  assert.deepEqual(payload.questions, [{ questionId: "q1", text: "旧字符串子问题" }]);
  assert.deepEqual(
    payload.unresolved.cardMentions.map((item) => item.input),
    ["卡A", "卡B"],
  );
  assert.equal(Object.hasOwn(payload, "scenarioText"), false);
});

test("historical large decision packets are deterministically reprojected from their archive", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [{
        id: "legacy-related",
        type: "official_qa",
        question: "历史问题",
        answer: "历史答案",
      }],
    },
  });
  const legacyOnlyMarker = `legacy-large-${"旧".repeat(30_000)}`;
  const input = buildFinalRulingInput({
    snapshotId: "snapshot-legacy-packet",
    contentSha256: "e".repeat(64),
    question: "历史问题",
    evidence: {
      questions: [{ questionId: "q1", text: "历史问题" }],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceArchive: archive,
      evidenceDecisionPacket: {
        modelPacket: {
          schemaVersion: 1,
          evidenceItems: [{ evidenceId: "legacy-large", body: legacyOnlyMarker }],
        },
      },
    },
  });
  const payload = JSON.parse(input.split("\n").at(-1));

  assert.equal(payload.evidenceDecisionPacket.schemaVersion, 2);
  assert.equal(payload.evidenceDecisionPacket.evidenceItems[0].evidenceId, "legacy-related");
  assert.doesNotMatch(input, /legacy-large/u);
  assert.equal(Buffer.byteLength(input) <= MAX_FINAL_RULING_INPUT_BYTES, true);
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
  assert.equal(created.executionProfile.finalRuling.finalAttemptPolicy, "repair_once");
  assert.equal(
    created.evidenceSnapshot.evidence.request.finalAttemptPolicy,
    "repair_once",
  );
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
  assert.equal(run.evidenceSnapshot.evidence.unresolved.cardMentions.length, 0);
  assert.equal(run.evidenceSnapshot.evidence.unresolved.ambiguousMentions.length, 0);
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

test("Admin freezes the retriever-reconciled card identity instead of the pre-retrieval approximation", async () => {
  const fixture = makeFixture();
  fixture.data.cards.push({
    id: "card-canonical",
    name: "社区译名卡",
    effectText: "检索后桥接到的本地完整卡文。",
  });
  fixture.retrieval.cardResolution = {
    ...fixture.cardResolution,
    resolvedCards: [{
      input: "用户原始译名",
      id: "card-canonical",
      cardId: "card-canonical",
      passcode: "12345678",
      name: "社区译名卡",
      aliases: ["社区译名卡", "用户原始译名"],
      effectText: "检索后桥接到的本地完整卡文。",
      confidence: 1,
      resolutionSource: "external_identity_verification",
    }],
    unresolvedMentions: [],
    ambiguousMentions: [],
  };
  fixture.retrieval.retrievedCards = fixture.retrieval.cardResolution.resolvedCards;
  fixture.retrieval.remainingUnresolvedMentions = [];
  fixture.preparationCardNameCandidates = [{
    name: "用户原始译名",
    originalText: "用户原始译名",
  }];
  const service = makeService(fixture);

  const created = await service.createRun({ body: { question: "匿名身份桥接问题" } });
  const run = (await service.executeRun({ runId: created.runId })).run;

  assert.equal(run.evidenceSnapshot.evidence.cardResolution.resolvedCards.length, 1);
  assert.equal(run.evidenceSnapshot.evidence.cardResolution.resolvedCards[0].id, "card-canonical");
  assert.equal(run.evidenceSnapshot.evidence.cardResolution.resolvedCards[0].input, "用户原始译名");
  assert.ok(run.evidenceSnapshot.evidence.cardResolution.resolvedCards[0].aliases.includes("用户原始译名"));
  assert.deepEqual(run.evidenceSnapshot.evidence.unresolved.cardMentions, []);
  assert.equal(run.evidenceSnapshot.evidence.completeness.resolvedCardCount, 1);
  assert.equal(run.evidenceSnapshot.evidence.completeness.allCardNamesResolved, true);
  const finalInputPayload = JSON.parse(buildFinalRulingInput(run.evidenceSnapshot).split("\n").at(-1));
  assert.equal(finalInputPayload.cardResolution.resolvedCards[0].id, "card-canonical");
});

test("createRun accepts only allowlisted final-attempt policies", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);

  const created = await service.createRun({
    body: {
      question: "匿名单次尝试问题",
      finalAttemptPolicy: "single",
    },
  });
  assert.equal(created.executionProfile.finalRuling.finalAttemptPolicy, "single");
  assert.equal(created.evidenceSnapshot.evidence.request.finalAttemptPolicy, "single");

  await assert.rejects(
    service.createRun({
      body: {
        question: "匿名非法策略问题",
        finalAttemptPolicy: "retry_forever",
      },
    }),
    (error) => error?.code === "admin_final_attempt_policy_invalid" && error.status === 400,
  );
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
  assert.doesNotMatch(request.input, /finalRulingRequired/u);
  assert.doesNotMatch(request.input, /organizedEvidenceIds/u);
  assert.equal(Buffer.byteLength(request.input) <= MAX_FINAL_RULING_INPUT_BYTES, true);
  const boundedInput = JSON.parse(request.input.split("\n").at(-1));
  assert.equal(boundedInput.schemaVersion, 2);
  assert.equal(Object.hasOwn(boundedInput, "question"), false);
  assert.equal(Object.hasOwn(boundedInput, "metadata"), false);
  assert.equal(Object.hasOwn(boundedInput, "dataVersions"), false);
  assert.equal(Object.hasOwn(boundedInput, "conflicts"), false);
  assert.equal(Object.hasOwn(boundedInput.cardResolution, "unresolvedMentions"), false);
  assert.equal(
    boundedInput.evidenceDecisionPacket.conflictSummary.totalConflictCount >= 1,
    true,
  );
  assert.equal(boundedInput.questions[0].questionId, "q1");
  assert.equal(boundedInput.cardResolution.resolvedCards[0].race, "测试族");
  assert.equal(boundedInput.cardResolution.resolvedCards[0].attribute, "测试属性");
  assert.equal(boundedInput.cardResolution.resolvedCards[0].level, 4);
  assert.equal(boundedInput.cardResolution.resolvedCards[0].attack, 1800);
  assert.equal(
    Object.hasOwn(boundedInput.cardResolution.resolvedCards[0], "rank"),
    false,
  );
  assert.equal(
    Object.hasOwn(boundedInput.completeness, "sourceCorpusCounts"),
    false,
  );

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

test("final-call budget reserves before provider create and settles reliable completed usage", async () => {
  const fixture = makeFixture();
  fixture.providerResponse = completedResponse(makeStructuredRuling());
  const calls = [];
  const ledger = {
    kind: "test-budget-spy",
    persistent: false,
    async reserve(input) {
      assert.equal(fixture.openAICreateCalls.length, 0, "reserve must precede provider create");
      calls.push({ operation: "reserve", input });
      return { status: "reserved" };
    },
    async settle(input) {
      calls.push({ operation: "settle", input });
      return { status: "settled" };
    },
    async release(input) {
      calls.push({ operation: "release", input });
      return { status: "released" };
    },
  };
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7",
    ADMIN_MODEL_LAB_EXCHANGE_RATE_VERSION: "test-rate",
  }, { finalCallBudgetLedger: ledger });
  const created = await service.createRun({ body: { question: "匿名预算顺序问题" } });

  await service.executeRun({ runId: created.runId });
  const completed = await service.pollRun({ runId: created.runId });

  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  const finalCalls = calls.filter((item) => item.input.attemptKind !== "evidence_preparation");
  assert.deepEqual(finalCalls.map((item) => item.operation), ["reserve", "settle"]);
  assert.equal(finalCalls[0].input.attemptKind, "primary");
  assert.equal(finalCalls[1].input.reservationId, finalCalls[0].input.reservationId);
  assert.equal(finalCalls[1].input.actualCny > 0, true);
});

test("relay model mismatch fails closed while settling reported usage at the requested model rate", async () => {
  const fixture = makeFixture();
  const budgetCalls = [];
  const transportCalls = [];
  const relayProvider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-test-key",
    baseUrl: "https://relay.example/v1",
    env: { RELAY_STREAM: "false" },
    fetchImpl: async (url, options) => {
      transportCalls.push({ url, body: JSON.parse(options.body) });
      return Response.json({
        id: "relay-mismatched-model",
        model: "gpt-5.6-luna",
        choices: [{ message: { content: JSON.stringify(makeStructuredRuling()) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      });
    },
  });
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
    ADMIN_MODEL_LAB_EXCHANGE_RATE_VERSION: "pilot-budget-factor-v1",
    RELAY_API_KEY: "relay-test-key",
  }, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
    finalRulingProviders: {
      relay: relayProvider,
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名中转计费模型问题",
      provider: "relay",
      model: "relay-gpt-5.6-sol",
      reasoningMode: "pro",
      reasoningEffort: "high",
      finalAttemptPolicy: "single",
    },
  });

  const completed = (await service.executeRun({ runId: created.runId })).run;
  const finalCost = completed.error.failureMetering.cost;
  const settlements = budgetCalls.filter((item) => (
    item.operation === "settle" && item.input.attemptKind === "primary"
  ));

  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].body.model, "gpt-5.6-sol");
  assert.equal(completed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(completed.error.code, "relay_returned_model_mismatch");
  assert.equal(completed.error.requestedModel, "relay-gpt-5.6-sol");
  assert.equal(completed.error.submittedModel, "gpt-5.6-sol");
  assert.equal(completed.error.reportedModel, "gpt-5.6-luna");
  assert.equal(completed.error.model, "gpt-5.6-luna");
  assert.equal(completed.error.failureMetering.scope, "final_ruling_only");
  assert.equal(finalCost.model, "gpt-5.6-sol");
  assert.equal(finalCost.pricingStatus, "estimated_unverified");
  assert.equal(finalCost.pricingSourceVerified, false);
  assert.equal(Number.isFinite(finalCost.totalCostCny), true);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].input.actualCny, finalCost.totalCostCny);
});

test("admin evidence variant is frozen into the run and forks project the same snapshot without new preparation", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  await assert.rejects(
    service.createRun({
      body: { question: "匿名非法消融", evidenceVariant: "answer_override" },
    }),
    (error) => error?.code === "admin_evidence_variant_invalid" && error.status === 400,
  );

  const created = await service.createRun({
    body: {
      question: "匿名消融问题",
      finalAttemptPolicy: "single",
      evidenceVariant: "card_text_only",
    },
  });
  assert.equal(created.executionProfile.evidenceVariant, "card_text_only");
  await service.executeRun({ runId: created.runId });
  const sourceInput = fixture.openAICreateCalls[0].input;
  assert.match(sourceInput, /匿名效果A全文/u);
  assert.doesNotMatch(sourceInput, /evidence-direct|相似场景资料/u);
  let source = await service.getRun({ runId: created.runId });
  assert.equal(source.executionProfile.finalRulingInputSha256, hashAdminFinalInput(sourceInput));

  const cardEvidenceId = buildFinalRulingModelEvidencePacket(source.evidenceSnapshot, {
    evidenceVariant: "card_text_only",
  }).evidenceItems[0].evidenceId;
  const cardTextRuling = makeStructuredRuling();
  cardTextRuling.claims[0].evidenceIds = [cardEvidenceId];
  cardTextRuling.claims[0].inferenceType = "CARD_TEXT";
  cardTextRuling.timeline[0].evidenceIds = [cardEvidenceId];
  cardTextRuling.evidenceUsage[0].evidenceId = cardEvidenceId;
  cardTextRuling.evidenceUsage[0].relation = "SUPPORTS_STEP";
  fixture.providerResponse = completedResponse(cardTextRuling);
  source = await service.getRun({ runId: created.runId });
  assert.equal(source.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(source.result.evidenceVariant, "card_text_only");
  assert.equal(source.result.finalRulingInputSha256, hashAdminFinalInput(sourceInput));
  const preparationCalls = fixture.deepSeekPrepareCalls;

  const fork = await service.forkRun({
    forkFromRunId: source.runId,
    body: {
      idempotencyKey: "ablation-fork-idempotency-0001",
      evidenceVariant: "without_lua",
    },
  });
  assert.deepEqual(fork.evidenceSnapshot, source.evidenceSnapshot);
  assert.equal(fork.executionProfile.evidenceVariant, "without_lua");
  assert.notEqual(
    fork.executionProfile.finalRulingInputSha256,
    source.executionProfile.finalRulingInputSha256,
  );

  await service.executeRun({ runId: fork.runId });
  const forkInput = fixture.openAICreateCalls[1].input;
  assert.match(forkInput, /evidence-direct/u);
  assert.doesNotMatch(forkInput, /legacyLuaSemanticPacket/u);
  assert.equal(fork.executionProfile.finalRulingInputSha256, hashAdminFinalInput(forkInput));
  assert.equal(fixture.deepSeekPrepareCalls, preparationCalls);
});

test("relay missing model identity fails closed and preserves a possibly charged reservation when usage is absent", async () => {
  const fixture = makeFixture();
  const budgetCalls = [];
  const relayProvider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-test-key",
    baseUrl: "https://relay.example/v1",
    env: { RELAY_STREAM: "false" },
    fetchImpl: async () => Response.json({
      id: "relay-missing-model",
      choices: [{ message: { content: JSON.stringify(makeStructuredRuling()) } }],
    }),
  });
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
    RELAY_API_KEY: "relay-test-key",
  }, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
    finalRulingProviders: { relay: relayProvider },
  });
  const created = await service.createRun({
    body: {
      question: "匿名中转身份缺失问题",
      provider: "relay",
      model: "relay-gpt-5.6-luna",
      reasoningMode: "pro",
      reasoningEffort: "high",
      finalAttemptPolicy: "single",
    },
  });

  const completed = (await service.executeRun({ runId: created.runId })).run;
  const finalCalls = budgetCalls.filter((item) => item.input.attemptKind !== "evidence_preparation");

  assert.equal(completed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(completed.error.code, "relay_returned_model_missing");
  assert.equal(completed.error.requestedModel, "relay-gpt-5.6-luna");
  assert.equal(completed.error.submittedModel, "gpt-5.6-luna");
  assert.equal(Object.hasOwn(completed.error, "reportedModel"), true);
  assert.equal(completed.error.reportedModel, null);
  assert.equal(completed.error.billingStatus, "possibly_charged_usage_unavailable");
  assert.deepEqual(finalCalls.map((item) => item.operation), ["reserve"]);
  assert.equal(Object.hasOwn(completed.error, "failureMetering"), false);
});

test("relay SSE diagnostics reach the completed attempt, latency metrics and provider summary without reasoning content", async () => {
  const fixture = makeFixture();
  const structured = JSON.stringify(makeStructuredRuling());
  const hiddenReasoning = "NEVER_PERSIST_THIS_HIDDEN_REASONING";
  const stream = [
    `data: ${JSON.stringify({
      id: "relay-sse-service-success",
      model: "gpt-5.6-terra",
      choices: [{ index: 0, delta: { reasoning_content: hiddenReasoning }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "relay-sse-service-success",
      model: "gpt-5.6-terra",
      choices: [{ index: 0, delta: { content: structured }, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "relay-sse-service-success",
      model: "gpt-5.6-terra",
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const clockValues = [0, 10, 20, 30, 40, 50];
  const relayProvider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-test-key",
    baseUrl: "https://relay.example/v1",
    clock: () => clockValues.shift(),
    fetchImpl: async () => new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
    RELAY_API_KEY: "relay-test-key",
  }, {
    finalRulingProviders: { relay: relayProvider },
  });
  const created = await service.createRun({
    body: {
      question: "匿名 SSE 指标问题",
      provider: "relay",
      model: "relay-gpt-5.6-terra",
      reasoningMode: "pro",
      reasoningEffort: "high",
      finalAttemptPolicy: "single",
    },
  });

  const completed = (await service.executeRun({ runId: created.runId })).run;
  const attempt = completed.result.metering.stages.finalRuling.attempts[0];

  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(completed.result.provider.finishReason, "stop");
  assert.equal(completed.result.provider.streamMetrics.requestToFirstContentMs, 40);
  assert.equal(completed.result.latency.relayStream.requestToCompleteMs, 50);
  assert.equal(completed.result.latency.finalRulingAttempts[0].streamMetrics.sseEventCount, 3);
  assert.equal(attempt.finishReason, "stop");
  assert.equal(attempt.streamMetrics.networkChunkCount, 1);
  assert.equal(attempt.streamMetrics.finishReason, "stop");
  assert.equal(JSON.stringify(completed).includes(hiddenReasoning), false);
  assert.equal(clockValues.length, 0);
});

test("outcome-unknown Relay stream with reported usage stays final-only metered and keeps safe diagnostics", async () => {
  const fixture = makeFixture();
  const budgetCalls = [];
  const hidden = "DO_NOT_PERSIST_STREAM_PAYLOAD";
  const stream = [
    `data: ${JSON.stringify({
      id: "relay-sse-usage-incomplete",
      model: "gpt-5.6-sol",
      choices: [{ index: 0, delta: { reasoning_content: hidden }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "relay-sse-usage-incomplete",
      model: "gpt-5.6-sol",
      choices: [],
      usage: { prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400 },
    })}\n\n`,
  ].join("");
  const relayProvider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-test-key",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
    RELAY_API_KEY: "relay-test-key",
  }, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
    finalRulingProviders: { relay: relayProvider },
  });
  const created = await service.createRun({
    body: {
      question: "匿名 SSE 未完整结束问题",
      provider: "relay",
      model: "relay-gpt-5.6-sol",
      reasoningMode: "pro",
      reasoningEffort: "high",
      finalAttemptPolicy: "single",
    },
  });

  const failed = (await service.executeRun({ runId: created.runId })).run;
  const finalCalls = budgetCalls.filter((item) => item.input.attemptKind === "primary");

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "provider_submission_outcome_unknown");
  assert.equal(failed.error.requestId, "relay-sse-usage-incomplete");
  assert.equal(failed.error.requestedModel, "relay-gpt-5.6-sol");
  assert.equal(failed.error.submittedModel, "gpt-5.6-sol");
  assert.equal(failed.error.reportedModel, "gpt-5.6-sol");
  assert.equal(failed.error.billingStatus, "metered_final_ruling_usage_reported");
  assert.equal(failed.error.failureMetering.scope, "final_ruling_only");
  assert.equal(failed.error.failureMetering.usage.totalTokens, 1400);
  assert.equal(failed.error.usage.totalTokens, 1400);
  assert.equal(failed.error.streamMetrics.sseEventCount, 2);
  assert.equal(finalCalls.filter((item) => item.operation === "settle").length, 1);
  assert.equal(JSON.stringify(failed).includes(hidden), false);
});

test("relay worst-case cost above its daily pool is rejected before provider transport", async () => {
  const fixture = makeFixture();
  fixture.cardResolution = {
    ...fixture.cardResolution,
    unresolvedMentions: [],
    ambiguousMentions: [],
  };
  let transportCalls = 0;
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
    RELAY_API_KEY: "relay-test-key",
  }, {
    finalCallBudgetLedger: createMemoryAdminFinalCallBudgetLedger({
      timezone: "UTC",
      pools: {
        relay_sol: { dailyBudgetCny: 0.001, reservationCny: 0.001 },
      },
    }),
    finalRulingProviders: {
      relay: {
        providerId: "relay",
        getFinalRequestBudgetEnvelope() {
          return {
            provider: "relay",
            model: "gpt-5.6-sol",
            inputTokenUpperBound: 1_000,
            maxOutputTokens: 100_000,
          };
        },
        async create() {
          transportCalls += 1;
          throw new Error("transport must not run");
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名中转最坏成本问题",
      provider: "relay",
      model: "relay-gpt-5.6-sol",
      reasoningMode: "pro",
      reasoningEffort: "high",
      finalAttemptPolicy: "single",
    },
  });

  const result = await service.executeRun({ runId: created.runId });

  assert.equal(result.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(result.run.error.code, "admin_final_budget_exceeded");
  assert.equal(transportCalls, 0);
  assert.equal(fixture.deepSeekPrepareCalls, 0);
});

test("DeepSeek final reserves its priced worst-case token envelope before transport", async () => {
  const fixture = makeFixture();
  fixture.cardResolution = {
    ...fixture.cardResolution,
    unresolvedMentions: [],
    ambiguousMentions: [],
  };
  const budgetCalls = [];
  const transportCalls = [];
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_MAX_OUTPUT_TOKENS: "128000",
  }, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        getFinalRequestBudgetEnvelope(request) {
          assert.equal(request.maxOutputTokens, 128_000);
          return {
            provider: "deepseek",
            model: "deepseek-v4-pro",
            inputTokenUpperBound: 524_288,
            maxOutputTokens: 128_000,
          };
        },
        async create(request) {
          transportCalls.push(request);
          return {
            id: "deepseek-dynamic-budget-1",
            status: "completed",
            model: "deepseek-v4-pro",
            output_text: JSON.stringify(makeStructuredRuling()),
            usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
          };
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名 DeepSeek 动态预算问题",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningMode: "pro",
      reasoningEffort: "max",
      finalAttemptPolicy: "single",
    },
  });

  const result = await service.executeRun({ runId: created.runId });
  const finalReservation = budgetCalls.find((item) => (
    item.operation === "reserve" && item.input.attemptKind === "primary"
  ));

  assert.equal(result.run.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(transportCalls.length, 1);
  assert.equal(fixture.deepSeekPrepareCalls, 0);
  assert.equal(finalReservation.input.requiredReservationCny, 2.340864);
});

test("final evidence readiness fails before provider submission, budget, and transport", async () => {
  const fixture = makeFixture();
  fixture.preparedCardResolution = {
    resolvedCards: [],
    unresolvedMentions: [{ input: "匿名卡A", reason: "not_found" }],
    ambiguousMentions: [],
    omittedResolvedCards: [],
    userProvidedCardTexts: [],
    modelCardNameCandidates: fixture.preparationCardNameCandidates,
  };
  const budgetCalls = [];
  const service = makeService(fixture, {}, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
  });
  const created = await service.createRun({ body: { question: "匿名证据未就绪问题" } });

  await assert.rejects(
    service.executeRun({ runId: created.runId }),
    (error) => error?.code === "admin_final_evidence_not_ready",
  );
  const failed = await service.getRun({ runId: created.runId, reconcile: false });

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "admin_final_evidence_not_ready");
  assert.equal(failed.execution.providerSubmission.state, "NONE");
  assert.deepEqual(
    budgetCalls.filter((item) => item.input.attemptKind !== "evidence_preparation"),
    [],
  );
  assert.deepEqual(fixture.openAICreateCalls, []);
});

test("missing or exceeded final-call budget fails before provider transport", async (t) => {
  await t.test("missing ledger", async () => {
    const fixture = makeFixture();
    const service = makeService(fixture, {}, { finalCallBudgetLedger: null });
    const created = await service.createRun({ body: { question: "匿名缺少预算账本" } });
    await assert.rejects(
      service.executeRun({ runId: created.runId }),
      (error) => error?.code === "admin_final_budget_storage_unavailable",
    );
    const result = await service.getRun({ runId: created.runId, reconcile: false });

    assert.equal(result.status, ADMIN_RUN_STATUSES.FAILED);
    assert.equal(result.error.code, "admin_final_budget_storage_unavailable");
    assert.equal(fixture.openAICreateCalls.length, 0);
  });

  await t.test("daily pool exceeded", async () => {
    const fixture = makeFixture();
    const ledger = {
      kind: "test-budget-reject",
      persistent: false,
      async reserve(input) {
        if (input.attemptKind === "evidence_preparation") return { status: "reserved" };
        const error = codedError("daily budget exceeded", "admin_final_budget_exceeded");
        error.outcomeKnown = true;
        error.budgetReservationMayExist = false;
        throw error;
      },
      async settle(input) {
        if (input.attemptKind === "evidence_preparation") return { status: "settled" };
        throw new Error("settle must not run");
      },
      async release() {
        return { status: "missing" };
      },
    };
    const service = makeService(fixture, {}, { finalCallBudgetLedger: ledger });
    const created = await service.createRun({ body: { question: "匿名超预算问题" } });
    const result = await service.executeRun({ runId: created.runId });

    assert.equal(result.run.status, ADMIN_RUN_STATUSES.FAILED);
    assert.equal(result.run.error.code, "admin_final_budget_exceeded");
    assert.equal(fixture.openAICreateCalls.length, 0);
  });
});

test("evidence preparation releases only provably unaccepted failures and is never retried", async (t) => {
  for (const releaseSafe of [true, false]) {
    await t.test(releaseSafe ? "known rejection releases" : "unknown outcome retains", async () => {
      const fixture = makeFixture();
      const budgetCalls = [];
      let preparationCalls = 0;
      const providerError = codedError(
        releaseSafe ? "request rejected before acceptance" : "network outcome unknown",
        releaseSafe ? "deepseek_bad_request" : "deepseek_network_unknown",
      );
      providerError.budgetReservationMayExist = !releaseSafe;
      const service = makeService(fixture, {}, {
        finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
        deepSeekProvider: {
          async prepareEvidence() {
            preparationCalls += 1;
            throw providerError;
          },
        },
      });
      const created = await service.createRun({ body: { question: "匿名证据准备失败问题" } });

      await assert.rejects(
        service.executeRun({ runId: created.runId }),
        (error) => error?.code === providerError.code,
      );
      assert.deepEqual(
        budgetCalls.map((item) => item.operation),
        releaseSafe ? ["reserve", "release"] : ["reserve"],
      );
      assert.equal(preparationCalls, 1);
      const repeated = await service.executeRun({ runId: created.runId });
      assert.equal(repeated.run.status, ADMIN_RUN_STATUSES.FAILED);
      assert.equal(repeated.run.error.code, providerError.code);
      assert.equal(preparationCalls, 1);
    });
  }
});

test("confirmed HTTP 200 preparation content failure retries once with independent budget and aggregated usage", async () => {
  const fixture = makeFixture();
  const budgetCalls = [];
  const providerCalls = [];
  const service = makeService(fixture, {}, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
    deepSeekProvider: {
      providerId: "deepseek",
      async prepareEvidence(request) {
        providerCalls.push(request);
        if (providerCalls.length === 1) {
          throw confirmedPreparationContentError("invalid_json", {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
          });
        }
        return {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          result: {
            cardNameCandidates: fixture.preparationCardNameCandidates,
            ruleSearchQueries: [{ query: "匿名规则", reason: "mechanism" }],
            unresolvedNotes: [],
            conflicts: [],
          },
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
          },
        };
      },
    },
  });
  const created = await service.createRun({ body: { question: "匿名内容恢复问题" } });

  const execution = await service.executeRun({ runId: created.runId });
  const preparation = execution.run.evidenceSnapshot.evidence.preparation;
  const preparationBudgetCalls = budgetCalls.filter((entry) => (
    entry.input.attemptKind === "evidence_preparation"
  ));

  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[0].metadata.attempt, "primary");
  assert.equal(providerCalls[1].metadata.attempt, "confirmed_content_recovery");
  assert.equal(providerCalls[1].reasoningMode, "standard");
  assert.equal(providerCalls[1].reasoningEffort, "none");
  assert.deepEqual(
    preparationBudgetCalls.map((entry) => entry.operation),
    ["reserve", "settle", "reserve", "settle"],
  );
  const reservationIds = preparationBudgetCalls
    .filter((entry) => entry.operation === "reserve")
    .map((entry) => entry.input.reservationId);
  assert.equal(new Set(reservationIds).size, 2);
  assert.deepEqual(
    preparation.attempts.map((attempt) => [attempt.attemptId, attempt.status]),
    [
      ["paid_model_submission", "failed"],
      ["paid_model_submission_content_recovery", "completed"],
    ],
  );
  assert.equal(preparation.usage.inputTokens, 31);
  assert.equal(preparation.usage.outputTokens, 17);
  assert.equal(preparation.usage.totalTokens, 48);
  assert.ok(preparation.warnings.includes("deepseek_preparation_invalid_json_retried_once"));

  fixture.providerResponse = completedResponse(makeStructuredRuling());
  const completed = await service.getRun({ runId: created.runId });
  const restoredSubstages = completed.stageTiming.stages
    .find((stage) => stage.id === "understand")
    .substages;
  assert.deepEqual(
    restoredSubstages.map((substage) => [substage.id, substage.status]),
    [
      ["paid_model_submission", "COMPLETED"],
      ["paid_model_submission_content_recovery", "COMPLETED"],
    ],
  );
});

test("preparation content recovery is attempted at most once", async () => {
  const fixture = makeFixture();
  const budgetCalls = [];
  let providerCalls = 0;
  const service = makeService(fixture, {}, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
    deepSeekProvider: {
      providerId: "deepseek",
      async prepareEvidence() {
        providerCalls += 1;
        throw confirmedPreparationContentError("empty", {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
        });
      },
    },
  });
  const created = await service.createRun({ body: { question: "匿名最多一次恢复问题" } });

  await assert.rejects(
    service.executeRun({ runId: created.runId }),
    (error) => error?.code === "deepseek_json_task_empty_content",
  );
  const failed = await service.getRun({ runId: created.runId, reconcile: false });
  const preparationBudgetCalls = budgetCalls.filter((entry) => (
    entry.input.attemptKind === "evidence_preparation"
  ));

  assert.equal(providerCalls, 2);
  assert.deepEqual(
    preparationBudgetCalls.map((entry) => entry.operation),
    ["reserve", "settle", "reserve", "settle"],
  );
  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.deepEqual(
    failed.stageTiming.stages
      .find((stage) => stage.id === "understand")
      .substages
      .map((substage) => [substage.id, substage.status]),
    [
      ["paid_model_submission", "COMPLETED"],
      ["paid_model_submission_content_recovery", "CANCELLED"],
    ],
  );
  const repeated = await service.executeRun({ runId: created.runId });
  assert.equal(repeated.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(providerCalls, 2, "a terminal recovery failure must never be resubmitted");
  assert.equal(
    budgetCalls.filter((entry) => entry.operation === "reserve").length,
    2,
  );
});

test("cancellation after recovery reservation releases it without invoking the recovery model", async () => {
  const fixture = makeFixture();
  const budgetCalls = [];
  const recoveryReserveEntered = deferred();
  const allowRecoveryReserveReturn = deferred();
  const innerLedger = createTestFinalCallBudgetLedger();
  let providerCalls = 0;
  const service = makeService(fixture, {}, {
    finalCallBudgetLedger: {
      kind: "test-cancellable-preparation-budget",
      persistent: false,
      async reserve(input) {
        const result = await innerLedger.reserve(input);
        budgetCalls.push({ operation: "reserve", input: structuredClone(input) });
        if (input.attemptId === "paid_model_submission_content_recovery") {
          recoveryReserveEntered.resolve();
          await allowRecoveryReserveReturn.promise;
        }
        return result;
      },
      async settle(input) {
        budgetCalls.push({ operation: "settle", input: structuredClone(input) });
        return innerLedger.settle(input);
      },
      async release(input) {
        budgetCalls.push({ operation: "release", input: structuredClone(input) });
        return innerLedger.release(input);
      },
    },
    deepSeekProvider: {
      providerId: "deepseek",
      async prepareEvidence() {
        providerCalls += 1;
        if (providerCalls > 1) throw new Error("recovery model must not be invoked");
        throw confirmedPreparationContentError("invalid_json", {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
        });
      },
    },
  });
  const created = await service.createRun({ body: { question: "匿名恢复预约取消问题" } });

  const executionPromise = service.executeRun({ runId: created.runId });
  await recoveryReserveEntered.promise;
  const cancellation = await service.cancelRun({
    runId: created.runId,
    body: { reason: "取消恢复调用", requestedBy: "tester" },
  });
  allowRecoveryReserveReturn.resolve();
  const execution = await executionPromise;

  assert.ok([
    ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
    ADMIN_RUN_STATUSES.CANCELLED,
  ].includes(cancellation.status));
  assert.equal(execution.run.status, ADMIN_RUN_STATUSES.CANCELLED);
  assert.equal(providerCalls, 1);
  assert.deepEqual(
    budgetCalls
      .filter((entry) => entry.input.attemptKind === "evidence_preparation")
      .map((entry) => [entry.operation, entry.input.attemptId]),
    [
      ["reserve", "paid_model_submission"],
      ["settle", "paid_model_submission"],
      ["reserve", "paid_model_submission_content_recovery"],
      ["release", "paid_model_submission_content_recovery"],
    ],
  );
});

test("preparation budget settlement fails closed for unconfirmed ledger states", async (t) => {
  for (const scenario of ["missing", "released", "throws"]) {
    await t.test(scenario, async () => {
      const fixture = makeFixture();
      let providerCalls = 0;
      const ledgerError = codedError(
        "settlement exceeds reservation",
        "admin_final_budget_state_conflict",
      );
      const service = makeService(fixture, {}, {
        finalCallBudgetLedger: {
          kind: "test-preparation-settlement-state",
          persistent: false,
          async reserve() {
            return { status: "reserved" };
          },
          async settle() {
            if (scenario === "throws") throw ledgerError;
            return { status: scenario };
          },
          async release() {
            return { status: "released" };
          },
        },
        deepSeekProvider: {
          providerId: "deepseek",
          async prepareEvidence() {
            providerCalls += 1;
            return {
              result: {
                cardNameCandidates: fixture.preparationCardNameCandidates,
                ruleSearchQueries: [],
                unresolvedNotes: [],
                conflicts: [],
              },
              usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            };
          },
        },
      });
      const created = await service.createRun({ body: { question: `匿名结算 ${scenario}` } });

      await assert.rejects(
        service.executeRun({ runId: created.runId }),
        (error) => error?.code === (
          scenario === "throws"
            ? "admin_final_budget_state_conflict"
            : "preparation_budget_settlement_unconfirmed"
        ),
      );
      const failed = await service.getRun({ runId: created.runId, reconcile: false });
      assert.equal(providerCalls, 1);
      assert.equal(fixture.openAICreateCalls.length, 0);
      assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
    });
  }
});

test("known provider rejection releases budget while unknown transport outcome retains it", async (t) => {
  for (const outcomeKnown of [true, false]) {
    await t.test(outcomeKnown ? "known rejection" : "unknown outcome", async () => {
      const fixture = makeFixture();
      const providerError = codedError(
        outcomeKnown ? "explicit bad request" : "network interrupted",
        outcomeKnown ? "provider_bad_request" : "provider_network_unknown",
      );
      providerError.outcomeKnown = outcomeKnown;
      fixture.openAICreateError = providerError;
      const calls = [];
      const ledger = {
        kind: "test-budget-spy",
        persistent: false,
        async reserve(input) {
          calls.push({ operation: "reserve", input });
          return { status: "reserved" };
        },
        async settle(input) {
          calls.push({ operation: "settle", input });
          return { status: "settled" };
        },
        async release(input) {
          calls.push({ operation: "release", input });
          return { status: "released" };
        },
      };
      const service = makeService(fixture, {}, { finalCallBudgetLedger: ledger });
      const created = await service.createRun({ body: { question: "匿名提交失败问题" } });
      const result = await service.executeRun({ runId: created.runId });

      assert.equal(result.run.status, ADMIN_RUN_STATUSES.FAILED);
      assert.equal(fixture.openAICreateCalls.length, 1);
      const finalCalls = calls.filter((item) => item.input.attemptKind !== "evidence_preparation");
      assert.deepEqual(
        finalCalls.map((item) => item.operation),
        outcomeKnown ? ["reserve", "release"] : ["reserve"],
      );
      if (outcomeKnown) {
        assert.equal(finalCalls.find((item) => item.operation === "release")?.input?.model, "gpt-5.6-terra");
      } else {
        assert.equal(result.run.error.code, "provider_submission_outcome_unknown");
        assert.equal(result.run.error.outcomeKnown, false);
        assert.equal(result.run.error.budgetReservationMayExist, true);
        assert.equal(result.run.error.billingStatus, "possibly_charged_usage_unavailable");
        assert.equal(result.run.error.upstreamErrorCode, "provider_network_unknown");
      }
    });
  }
});

test("manual reconciliation releases only an exact uncharged legacy Relay 524 reservation", async (t) => {
  async function createFailedRelayRun({
    status = 524,
    code = "relay_http_error",
    message = "relay Chat Completions API returned HTTP 524",
    usage = null,
    requestId = null,
  } = {}) {
    const fixture = makeFixture();
    const budgetCalls = [];
    const providerError = codedError(message, code);
    Object.assign(providerError, {
      provider: "relay",
      status,
      outcomeKnown: false,
      budgetReservationMayExist: true,
      ...(usage ? { usage } : {}),
      ...(requestId ? { requestId } : {}),
    });
    const service = makeService(fixture, {
      ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
      RELAY_API_KEY: "relay-test-key",
    }, {
      finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
      finalRulingProviders: {
        relay: {
          providerId: "relay",
          async create() {
            throw providerError;
          },
        },
      },
    });
    const created = await service.createRun({
      body: {
        question: "匿名旧中转超时预约",
        provider: "relay",
        model: "relay-gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        finalAttemptPolicy: "single",
      },
    });
    const failed = (await service.executeRun({ runId: created.runId })).run;
    return { service, failed, budgetCalls };
  }

  function confirmation(run) {
    return [
      "provider-dashboard-confirmed-not-charged/v1",
      run.runId,
      run.execution.providerSubmission.attemptId,
    ].join(":");
  }

  await t.test("exact failed unmetered 524 is released idempotently and audited", async () => {
    const { service, failed, budgetCalls } = await createFailedRelayRun();
    assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
    assert.equal(failed.execution.providerSubmission.state, "OUTCOME_UNKNOWN");
    assert.equal(failed.execution.providerSubmission.error.code, "relay_http_error");
    assert.equal(failed.execution.providerSubmission.error.status, 524);

    await assert.rejects(
      service.releaseUnchargedRelayReservation({
        runId: failed.runId,
        confirmation: `${confirmation(failed)}-wrong`,
      }),
      (error) => error?.code === "admin_budget_release_confirmation_invalid",
    );
    const released = await service.releaseUnchargedRelayReservation({
      runId: failed.runId,
      confirmation: confirmation(failed),
    });
    const duplicate = await service.releaseUnchargedRelayReservation({
      runId: failed.runId,
      confirmation: confirmation(failed),
    });
    assert.equal(released.release.status, "released");
    assert.equal(duplicate.release.status, "existing");
    assert.equal(released.attemptId, failed.execution.providerSubmission.attemptId);
    assert.deepEqual(
      budgetCalls
        .filter((item) => item.input.attemptKind === "primary")
        .map((item) => item.operation),
      ["reserve", "release", "release"],
    );
    const replay = await service.replayEvents({ runId: failed.runId });
    assert.equal(
      replay.events.filter(
        (event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.BUDGET_RESERVATION_RELEASED,
      ).length,
      2,
    );
  });

  for (const scenario of [
    {
      name: "reported usage",
      options: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      expectedCode: "admin_budget_release_usage_present",
    },
    {
      name: "provider request id",
      options: { requestId: "relay-request-1" },
      expectedCode: "admin_budget_release_submission_invalid",
    },
    {
      name: "non-524 status",
      options: { status: 503, message: "relay Chat Completions API returned HTTP 524" },
      expectedCode: "admin_budget_release_error_invalid",
    },
    {
      name: "non-Relay error code",
      options: { code: "upstream_non_json_error" },
      expectedCode: "admin_budget_release_error_invalid",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { service, failed, budgetCalls } = await createFailedRelayRun(scenario.options);
      await assert.rejects(
        service.releaseUnchargedRelayReservation({
          runId: failed.runId,
          confirmation: confirmation(failed),
        }),
        (error) => error?.code === scenario.expectedCode,
      );
      assert.equal(
        budgetCalls.filter(
          (item) => item.operation === "release" && item.input.attemptKind === "primary",
        ).length,
        0,
      );
    });
  }

  await t.test("non-Relay provider", async () => {
    const fixture = makeFixture();
    const providerError = codedError(
      "relay Chat Completions API returned HTTP 524",
      "relay_http_error",
    );
    Object.assign(providerError, {
      status: 524,
      outcomeKnown: false,
      budgetReservationMayExist: true,
    });
    fixture.openAICreateError = providerError;
    const service = makeService(fixture);
    const created = await service.createRun({ body: { question: "匿名非中转超时" } });
    const failed = (await service.executeRun({ runId: created.runId })).run;
    await assert.rejects(
      service.releaseUnchargedRelayReservation({
        runId: failed.runId,
        confirmation: confirmation(failed),
      }),
      (error) => error?.code === "admin_budget_release_provider_invalid",
    );
  });

  await t.test("successful or nonterminal run", async () => {
    const fixture = makeFixture();
    const service = makeService(fixture, {
      ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
      RELAY_API_KEY: "relay-test-key",
    }, {
      finalRulingProviders: {
        relay: {
          providerId: "relay",
          async create() {
            throw new Error("must not run");
          },
        },
      },
    });
    const queued = await service.createRun({
      body: {
        question: "匿名尚未执行中转任务",
        provider: "relay",
        model: "relay-gpt-5.6-sol",
      },
    });
    await assert.rejects(
      service.releaseUnchargedRelayReservation({
        runId: queued.runId,
        confirmation: `provider-dashboard-confirmed-not-charged/v1:${queued.runId}:`,
      }),
      (error) => error?.code === "admin_budget_release_run_not_failed",
    );
  });
});

test("a billed HTTP 200 empty response settles reported usage or conservatively retains its reservation", async (t) => {
  for (const usage of [
    { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    null,
  ]) {
    await t.test(usage ? "reported usage settles actual cost" : "missing usage keeps reservation", async () => {
      const fixture = makeFixture();
      const providerError = codedError("empty successful response", "deepseek_empty_final_ruling");
      providerError.outcomeKnown = true;
      providerError.budgetReservationMayExist = true;
      providerError.usage = usage;
      providerError.model = "deepseek-v4-flash";
      providerError.requestId = "deepseek-empty-200";
      const calls = [];
      const service = makeService(fixture, {
        ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "test-v1",
        ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2027-01-01",
        ADMIN_MODEL_LAB_DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
        ADMIN_MODEL_LAB_DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
      }, {
        finalCallBudgetLedger: createRecordingBudgetLedger(calls),
        finalRulingProviders: {
          deepseek: {
            providerId: "deepseek",
            async create() {
              throw providerError;
            },
          },
        },
      });
      const created = await service.createRun({
        body: {
          question: "匿名空响应预算问题",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoningEffort: "none",
          reasoningMode: "standard",
        },
      });
      const result = await service.executeRun({ runId: created.runId });

      assert.equal(result.run.status, ADMIN_RUN_STATUSES.FAILED);
      assert.equal(result.run.error.code, "deepseek_empty_final_ruling");
      const finalCalls = calls.filter((item) => item.input.attemptKind !== "evidence_preparation");
      assert.deepEqual(
        finalCalls.map((item) => item.operation),
        usage ? ["reserve", "settle"] : ["reserve"],
      );
      if (usage) {
        assert.equal(finalCalls[1].input.actualCny, 0.0002);
      }
    });
  }
});

test("a metered relay HTTP 200 empty response settles using the requested model rate", async () => {
  const fixture = makeFixture();
  const providerError = codedError("empty successful relay response", "relay_empty_final_ruling");
  providerError.outcomeKnown = true;
  providerError.budgetReservationMayExist = true;
  providerError.usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
  providerError.model = "gpt-5.6-luna";
  providerError.requestId = "relay-empty-200";
  const calls = [];
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_USD_TO_CNY_RATE: "7.5",
    RELAY_API_KEY: "relay-test-key",
  }, {
    finalCallBudgetLedger: createRecordingBudgetLedger(calls),
    finalRulingProviders: {
      relay: {
        providerId: "relay",
        getFinalRequestBudgetEnvelope() {
          return {
            provider: "relay",
            model: "gpt-5.6-sol",
            inputTokenUpperBound: 2_000,
            maxOutputTokens: 1_000,
          };
        },
        async create() {
          throw providerError;
        },
      },
    },
  });
  const created = await service.createRun({
    body: {
      question: "匿名中转空响应预算问题",
      provider: "relay",
      model: "relay-gpt-5.6-sol",
      reasoningMode: "pro",
      reasoningEffort: "high",
      finalAttemptPolicy: "single",
    },
  });

  const result = await service.executeRun({ runId: created.runId });

  assert.equal(result.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(result.run.error.code, "relay_empty_final_ruling");
  assert.equal(result.run.error.requestedModel, "relay-gpt-5.6-sol");
  assert.equal(result.run.error.submittedModel, "gpt-5.6-sol");
  assert.equal(Object.hasOwn(result.run.error, "reportedModel"), true);
  assert.equal(result.run.error.reportedModel, null);
  assert.equal(result.run.error.failureMetering.scope, "final_ruling_only");
  const finalCalls = calls.filter((item) => item.input.attemptKind !== "evidence_preparation");
  assert.deepEqual(finalCalls.map((item) => item.operation), ["reserve", "settle"]);
  assert.equal(finalCalls[1].input.model, "relay-gpt-5.6-sol");
  assert.equal(
    finalCalls[1].input.actualCny,
    result.run.error.failureMetering.cost.totalCostCny,
  );
});

test("a domestic experimental final ruling completes synchronously and is labelled non-authoritative", async () => {
  const fixture = makeFixture();
  const domesticCalls = [];
  const service = makeService(fixture, {
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "official-test-v4",
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2026-08-06",
    ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "1",
    ADMIN_MODEL_LAB_DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "2",
    ADMIN_MODEL_LAB_DEEPSEEK_PRO_INPUT_CNY_PER_MTOK: "3",
    ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK: "6",
  }, {
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        async create(request) {
          domesticCalls.push(request);
          return {
            id: "deepseek-final-1",
            status: "completed",
            model: "deepseek-v4-pro",
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
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      reasoningMode: "pro",
    },
  });
  const execution = await service.executeRun({ runId: created.runId });

  assert.equal(execution.run.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.equal(execution.run.result.experimental, true);
  assert.equal(execution.run.result.authority.classification, "experimental_non_authoritative");
  assert.equal(execution.run.result.authority.publicAnswerEligible, false);
  assert.equal(execution.run.result.provider.providerId, "deepseek");
  assert.equal(execution.run.result.finalRuling.conciseAnswer, "可以发动，并完成处理。");
  assert.equal(execution.run.result.metering.stages.finalRuling.cost.model, "deepseek-v4-pro");
  assert.equal(execution.run.result.metering.stages.finalRuling.cost.totalCostCny, 0.0063);
  assert.equal(execution.run.result.metering.stages.evidencePreparation.cost.model, "deepseek-v4-flash");
  assert.equal(domesticCalls.length, 1);
  assert.match(domesticCalls[0].input, /evidence-direct/u);
  assert.equal(fixture.openAICreateCalls.length, 0);
});

test("one directed repair succeeds on the same frozen evidence and accumulates both paid attempts", async () => {
  const fixture = makeFixture();
  const calls = [];
  const budgetCalls = [];
  const budgetLedger = createRecordingBudgetLedger(budgetCalls);
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
    finalCallBudgetLedger: budgetLedger,
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
  assert.equal(created.executionProfile.finalRuling.finalAttemptPolicy, "repair_once");
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
  const reservations = budgetCalls.filter((item) => item.operation === "reserve");
  const settlements = budgetCalls.filter((item) => item.operation === "settle");
  const finalReservations = reservations.filter((item) => item.input.attemptKind !== "evidence_preparation");
  const finalSettlements = settlements.filter((item) => item.input.attemptKind !== "evidence_preparation");
  assert.deepEqual(finalReservations.map((item) => item.input.attemptKind), ["primary", "repair"]);
  assert.equal(new Set(finalReservations.map((item) => item.input.reservationId)).size, 2);
  assert.deepEqual(
    finalSettlements.map((item) => item.input.reservationId),
    finalReservations.map((item) => item.input.reservationId),
  );
});

test("completed output without reported usage conservatively keeps its reservation", async () => {
  const fixture = makeFixture();
  fixture.providerResponse = {
    id: "resp-admin-usage-missing",
    status: "completed",
    model: "gpt-5.6-terra",
    output_text: JSON.stringify(makeStructuredRuling()),
  };
  const budgetCalls = [];
  const service = makeService(fixture, {}, {
    finalCallBudgetLedger: createRecordingBudgetLedger(budgetCalls),
  });
  const created = await service.createRun({ body: { question: "匿名缺少用量问题" } });

  await service.executeRun({ runId: created.runId });
  const completed = await service.pollRun({ runId: created.runId });

  assert.equal(completed.status, ADMIN_RUN_STATUSES.SUCCEEDED);
  assert.deepEqual(
    budgetCalls
      .filter((item) => item.input.attemptKind !== "evidence_preparation")
      .map((item) => item.operation),
    ["reserve"],
  );
});

test("single final-attempt policy fails after one invalid response and preserves its audit event", async () => {
  const fixture = makeFixture();
  const calls = [];
  const service = makeService(fixture, {}, {
    finalRulingProviders: {
      glm: {
        providerId: "glm",
        async create(request) {
          calls.push(request);
          return {
            id: "glm-single-invalid",
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
    body: {
      question: "匿名单次失败问题",
      provider: "glm",
      model: "glm-5.2",
      finalAttemptPolicy: "single",
    },
  });
  const failed = (await service.executeRun({ runId: created.runId })).run;

  assert.equal(failed.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(failed.error.code, "model_ruling_validation_failed");
  assert.equal(failed.executionProfile.finalRuling.finalAttemptPolicy, "single");
  assert.equal(calls.length, 1);
  assert.equal(failed.execution.repair, null);
  assert.equal(failed.execution.repairSubmission.state, "NONE");

  const replay = await service.replayEvents({ runId: created.runId });
  const validationEvent = replay.events.find(
    (event) => event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_VALIDATION_FAILED,
  );
  assert.equal(validationEvent.payload.attemptKind, "primary");
  assert.equal(validationEvent.payload.recoverable, true);
  assert.equal(validationEvent.payload.completedAttempt.requestId, "glm-single-invalid");
  assert.equal(validationEvent.payload.completedAttempt.attemptKind, "primary");
  assert.equal(validationEvent.payload.completedAttempt.validation.ok, false);
  assert.equal(validationEvent.payload.completedAttempt.usage.totalTokens, 15);
  assert.match(validationEvent.payload.completedAttempt.responseContentSha256, /^[a-f0-9]{64}$/u);

  await service.executeRun({ runId: created.runId });
  assert.equal(calls.length, 1, "a terminal single-attempt run must never submit again");
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
  assert.equal(completed.result.metering.stages.evidencePreparation.cost.totalCostCny, 0.00004);
  assert.equal(completed.result.metering.stages.evidencePreparation.cost.pricingVersion, "test-deepseek-v4");
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

test("a completed paid preparation substage without a frozen snapshot fails closed", async () => {
  const fixture = makeFixture();
  const storage = createMemoryAdminRunStorage();
  const firstService = makeService(fixture, {}, { storage });
  const created = await firstService.createRun({
    body: { question: "匿名准备模型完成后崩溃问题" },
  });
  await fixture.runStore.startRun(created.runId);
  const claim = await fixture.runStore.acquireExecutionLease(created.runId, {
    ownerId: "abandoned-preparation-worker",
  });
  const tracker = createAdminStageTracker({
    runId: created.runId,
    monotonicNow: () => fixture.monotonicMs,
    wallNow: () => fixture.wallNow(),
  });
  tracker.startStage("understand");
  tracker.startSubstage("understand", "paid_model_submission", {
    label: "低成本模型准备证据",
  });
  fixture.advance(20);
  tracker.finishSubstage("understand", "paid_model_submission");
  await fixture.runStore.updateStageProgress(created.runId, tracker.snapshot(), {
    executionToken: claim.executionToken,
  });
  await fixture.runStore.releaseExecutionLease(created.runId, {
    executionToken: claim.executionToken,
  });

  const persisted = await fixture.runStore.getRun(created.runId);
  assert.equal(persisted.preparationFinalizedAt, null);
  assert.equal(
    persisted.stageTiming.stages
      .find((stage) => stage.id === "understand")
      .substages.find((substage) => substage.id === "paid_model_submission")
      .status,
    "COMPLETED",
  );

  const resumedService = makeService(fixture, {}, { storage });
  const resumed = await resumedService.executeRun({ runId: created.runId });

  assert.equal(resumed.run.status, ADMIN_RUN_STATUSES.FAILED);
  assert.equal(resumed.run.error.code, "preparation_submission_outcome_unknown");
  assert.equal(resumed.providerRequest, null);
  assert.equal(fixture.deepSeekPrepareCalls, 0, "paid preparation must not be resubmitted");
  assert.equal(fixture.openAICreateCalls.length, 0, "final ruling must not start");
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
  const created = await service.createRun({
    body: { question: "匿名问题", finalAttemptPolicy: "single" },
  });
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
  assert.equal(fork.executionProfile.finalRuling.finalAttemptPolicy, "single");
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
    "finalAttemptPolicy",
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

function confirmedPreparationContentError(contentFailureKind, usage) {
  return Object.assign(
    codedError(
      `confirmed preparation ${contentFailureKind}`,
      contentFailureKind === "empty"
        ? "deepseek_json_task_empty_content"
        : "deepseek_json_task_invalid_json",
    ),
    {
      provider: "deepseek",
      status: 200,
      outcomeKnown: true,
      budgetReservationMayExist: true,
      budgetReservationReleaseSafe: false,
      confirmedContentFailure: true,
      contentFailureKind,
      usage,
    },
  );
}

function makeService(fixture, envOverrides = {}, {
  storage = createMemoryAdminRunStorage(),
  preparationProviders = {},
  deepSeekProvider = null,
  finalRulingProviders = {},
  finalCallBudgetLedger = createTestFinalCallBudgetLedger(),
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
    finalCallBudgetLedger,
    env: {
      ADMIN_MODEL_LAB_ENABLED: "true",
      ADMIN_OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "server-only-test-key",
      DEEPSEEK_API_KEY: "server-only-test-key",
      ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "test-deepseek-v4",
      ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2027-01-01",
      ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "1",
      ADMIN_MODEL_LAB_DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "2",
      ADMIN_MODEL_LAB_DEEPSEEK_PRO_INPUT_CNY_PER_MTOK: "3",
      ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK: "6",
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
            cardNameCandidates: fixture.preparationCardNameCandidates,
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
        if (fixture.openAICreateError) throw fixture.openAICreateError;
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
          || JSON.stringify(candidateNames) === JSON.stringify(
            fixture.preparationCardNameCandidates.map((item) => item.name),
          ),
        true,
      );
      fixture.extractCardsCalls.push(candidateNames);
      return candidateNames.length > 0
        ? fixture.preparedCardResolution
        : fixture.cardResolution;
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

function createTestFinalCallBudgetLedger() {
  return createMemoryAdminFinalCallBudgetLedger({
    timezone: "UTC",
    pools: {
      openai: { dailyBudgetCny: 1_000, reservationCny: 10 },
      deepseek: { dailyBudgetCny: 1_000, reservationCny: 10 },
      glm: { dailyBudgetCny: 1_000, reservationCny: 10 },
      kimi: { dailyBudgetCny: 1_000, reservationCny: 10 },
      relay_sol: { dailyBudgetCny: 1_000, reservationCny: 10 },
      relay_terra: { dailyBudgetCny: 1_000, reservationCny: 10 },
      relay_luna: { dailyBudgetCny: 1_000, reservationCny: 10 },
    },
  });
}

function createRecordingBudgetLedger(calls) {
  const inner = createTestFinalCallBudgetLedger();
  return Object.freeze({
    kind: "test-recording-budget-ledger",
    persistent: false,
    async reserve(input) {
      calls.push({ operation: "reserve", input: structuredClone(input) });
      return inner.reserve(input);
    },
    async settle(input) {
      calls.push({ operation: "settle", input: structuredClone(input) });
      return inner.settle(input);
    },
    async release(input) {
      calls.push({ operation: "release", input: structuredClone(input) });
      return inner.release(input);
    },
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
    openAICreateError: null,
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
    preparationCardNameCandidates: [
      { name: "匿名卡A", originalText: "匿名卡A" },
      { name: "匿名卡B", originalText: "匿名卡B" },
    ],
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
    preparedCardResolution: {
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
        confidence: 0.6,
        aliases: ["匿名卡A"],
      }, {
        id: "card-b",
        name: "匿名卡B",
        text: "匿名效果B全文",
        type: "效果怪兽",
        cardType: "monster",
        confidence: 0.6,
        aliases: ["匿名卡B"],
      }],
      unresolvedMentions: [],
      ambiguousMentions: [],
      omittedResolvedCards: [],
      userProvidedCardTexts: [],
      modelCardNameCandidates: [
        { name: "匿名卡A", originalText: "匿名卡A" },
        { name: "匿名卡B", originalText: "匿名卡B" },
      ],
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
      remainingUnresolvedMentions: [],
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
