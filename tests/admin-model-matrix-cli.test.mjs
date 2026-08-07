import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAvailableModels,
  createAdminModelLabHttpClient,
  FIVE_MODEL_PILOT_CONFIGURATIONS,
  formatMatrixMarkdown,
  main,
  parseMatrixArguments,
  runAdminModelMatrix,
  runAdminModelMatrixBatch,
  validateReusableSourceRun,
} from "../scripts/admin-model-matrix.mjs";

test("admin matrix client requires HTTPS remotely and never follows redirects", async () => {
  assert.throws(
    () => createAdminModelLabHttpClient({
      baseUrl: "http://lab.example.test",
      password: "test-password",
      fetchImpl: async () => { throw new Error("must not fetch"); },
    }),
    /HTTPS.*loopback/iu,
  );
  assert.doesNotThrow(() => createAdminModelLabHttpClient({
    baseUrl: "http://127.0.0.1:8787",
    password: "test-password",
    fetchImpl: async () => { throw new Error("not called"); },
  }));
  assert.doesNotThrow(() => createAdminModelLabHttpClient({
    baseUrl: "http://[::1]:8787",
    password: "test-password",
    fetchImpl: async () => { throw new Error("not called"); },
  }));

  const requests = [];
  const client = createAdminModelLabHttpClient({
    baseUrl: "https://lab.example.test",
    password: "test-password",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: false,
        status: 307,
        headers: new Headers({ location: "https://evil.example.test/collect" }),
        async json() { return {}; },
      };
    },
  });

  await assert.rejects(
    client.login(),
    (error) => error?.code === "admin_model_lab_redirect_forbidden",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://lab.example.test/api/admin-auth");
  assert.equal(requests[0].options.redirect, "manual");
  assert.match(requests[0].options.body, /test-password/u);
});

test("admin matrix client binds an uncharged reservation release to run and attempt ids", async () => {
  const requests = [];
  const client = createAdminModelLabHttpClient({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-password",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/admin-auth")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "set-cookie": "admin_session=test; Path=/; HttpOnly" }),
          async json() {
            return { authenticated: true, csrfToken: "csrf-test" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async json() { return { ok: true, data: { released: true } }; },
      };
    },
  });

  await client.login();
  await client.releaseBudgetReservation({ runId: "run-1", attemptId: "attempt-1" });

  assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].options.body);
  assert.deepEqual(body, {
    action: "release-budget-reservation",
    runId: "run-1",
    confirmation: "provider-dashboard-confirmed-not-charged/v1:run-1:attempt-1",
  });
  assert.equal(requests[1].options.headers["x-csrf-token"], "csrf-test");
});
import { createEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";

test("matrix creates one Flash source, forks frozen evidence, skips unavailable models, and continues after failure", async () => {
  const fixture = createFetchFixture();
  let tick = 0;
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "测试问题",
    configurations: [
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        reasoningMode: "standard",
        reasoningEffort: "none",
      },
      {
        provider: "glm",
        model: "glm-5.2",
        reasoningMode: "standard",
        reasoningEffort: "none",
      },
      {
        provider: "glm",
        model: "glm-5.2",
        reasoningMode: "pro",
        reasoningEffort: "high",
      },
      {
        provider: "kimi",
        model: "kimi-k2.6",
        reasoningMode: "standard",
        reasoningEffort: "none",
      },
    ],
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    concurrency: 1,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
    now: () => new Date(1_000 + tick++ * 500),
  });

  assert.equal(report.sourceRunId, "source-1");
  assert.equal(report.results.length, 4);
  assert.deepEqual(report.results.map((item) => item.status), [
    "SUCCEEDED",
    "SUCCEEDED",
    "FAILED",
    "SKIPPED",
  ]);
  assert.equal(report.results[0].conciseAnswer, "answer:deepseek-v4-flash");
  assert.equal(report.results[1].conciseAnswer, "answer:glm-5.2");
  assert.equal(report.results[1].verdicts[0].value, "TRUE");
  assert.equal(report.results[1].timeline[0].order, 1);
  assert.equal(report.results[1].metrics.totalDurationMs, 123);
  assert.equal(report.results[1].metrics.finalRulingMs, 45);
  assert.equal(report.results[1].metrics.tokenUsage.totalTokens, 10);
  assert.equal(report.results[1].metrics.cost.totalCostCny, 0.01);
  assert.equal(report.results[2].error.code, "mock_fork_failure");
  assert.equal(report.results[3].error.code, "model_unavailable");

  const create = fixture.calls.find((call) => call.action === "create");
  assert.deepEqual({
    provider: create.body.provider,
    model: create.body.model,
    reasoningMode: create.body.reasoningMode,
    reasoningEffort: create.body.reasoningEffort,
    preparationProvider: create.body.preparationProvider,
    preparationModel: create.body.preparationModel,
    finalAttemptPolicy: create.body.finalAttemptPolicy,
  }, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    reasoningEffort: "none",
    preparationProvider: "deepseek",
    preparationModel: "deepseek-v4-flash",
    finalAttemptPolicy: "single",
  });
  const forks = fixture.calls.filter((call) => call.action === "fork");
  assert.equal(forks.length, 2, "unavailable Kimi must not be called");
  assert.equal(forks.every((call) => call.body.forkFromRunId === "source-1"), true);
  assert.equal(forks.every((call) => /^matrix-[A-Za-z0-9-]+-[0-9]+$/u.test(call.body.idempotencyKey)), true);
  assert.equal(fixture.calls.filter((call) => call.action === "create").length, 1);
  assert.equal(fixture.auth.password, "test-only-password");
  assert.equal(fixture.auth.origin, "https://admin.example.test");
  assert.equal(fixture.protectedHeaders.every((headers) => (
    headers.cookie === "admin_session=test-session"
      && headers["x-csrf-token"] === "test-csrf"
  )), true);

  const markdown = formatMatrixMarkdown(report);
  assert.match(markdown, /glm-5\.2 \/ standard \/ none/u);
  assert.match(markdown, /answer:glm-5\.2/u);
  assert.match(markdown, /10/u);
});

test("argument and capability normalization keep only server-available configurations", () => {
  const parsed = parseMatrixArguments([
    "--question", "Q",
    "--source-run-id", "source-existing",
    "--config", "glm:glm-5.2:standard:none",
    "--format", "markdown",
    "--concurrency", "3",
  ]);
  assert.equal(parsed.question, "Q");
  assert.equal(parsed.sourceRunId, "source-existing");
  assert.equal(parsed.format, "markdown");
  assert.equal(parsed.concurrency, 3);
  assert.deepEqual(parsed.configurations[0], {
    provider: "glm",
    model: "glm-5.2",
    reasoningMode: "standard",
    reasoningEffort: "none",
    evidenceVariant: "full",
  });

  const ablation = parseMatrixArguments([
    "--question", "Q",
    "--config", "relay:relay-gpt-5.6-sol:pro:high:card_text_only",
    "--config", "relay:relay-gpt-5.6-sol:pro:high:without_lua",
  ]);
  assert.deepEqual(
    ablation.configurations.map((configuration) => configuration.evidenceVariant),
    ["card_text_only", "without_lua"],
  );

  const available = collectAvailableModels({
    providers: {
      providers: [
        {
          providerId: "glm",
          available: true,
          models: [{
            modelId: "glm-5.2",
            available: true,
            transportAvailable: true,
            budgetConfigured: true,
            budgetAvailable: true,
            budgetPool: "glm",
          }],
        },
        {
          providerId: "kimi",
          available: false,
          models: [{ modelId: "kimi-k2.6", available: true }],
        },
      ],
    },
  });
  assert.deepEqual([...available.keys()], ["glm-5.2"]);
});

test("matrix can reuse an existing frozen source without creating or executing it", async () => {
  const fixture = createFetchFixture();
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "测试问题",
    sourceRunId: "source-existing",
    configurations: [relaySolConfiguration()],
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    sleep: async () => {},
  });

  assert.equal(report.sourceRunId, "source-existing");
  assert.equal(report.results[0].conciseAnswer, "answer:gpt-5.6-sol");
  assert.equal(report.results[0].returnedModel, "gpt-5.6-sol");
  assert.equal(report.results[0].evidenceSnapshot.integrity, "verified");
  assert.equal(report.results[0].evidenceSnapshot.id, fixture.existingSnapshot.snapshotId);
  assert.equal(report.results[0].evidenceSnapshot.sha256, fixture.existingSnapshot.contentSha256);
  assert.equal(report.results[0].metrics.finishReason, "stop");
  assert.equal(fixture.calls.some((call) => call.action === "create"), false);
  assert.equal(fixture.calls.some((call) => call.action === "execute"), false);
});

test("matrix forks all evidence variants from one frozen source snapshot and reports their input hashes", async () => {
  const fixture = createFetchFixture();
  const base = relaySolConfiguration();
  const configurations = [
    { ...base, evidenceVariant: "full" },
    { ...base, evidenceVariant: "card_text_only" },
    { ...base, evidenceVariant: "without_lua" },
  ];
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "测试问题",
    configurations,
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    concurrency: 1,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
  });

  assert.deepEqual(report.evidenceVariants, ["full", "card_text_only", "without_lua"]);
  assert.deepEqual(
    report.results.map((item) => item.evidenceVariant),
    ["full", "card_text_only", "without_lua"],
  );
  assert.equal(new Set(report.results.map((item) => item.evidenceSnapshot.sha256)).size, 1);
  assert.equal(new Set(report.results.map((item) => item.finalRulingInputSha256)).size, 3);
  const forks = fixture.calls.filter((call) => call.action === "fork");
  assert.deepEqual(
    forks.map((call) => call.body.evidenceVariant),
    ["card_text_only", "without_lua"],
  );
});

test("matrix can reuse an explicitly available DeepSeek frozen source", async () => {
  const sourceConfiguration = deepSeekFlashConfiguration();
  const fixture = createFetchFixture({ existingSourceConfiguration: sourceConfiguration });
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "测试问题",
    sourceRunId: "source-existing",
    configurations: [sourceConfiguration, relayConfiguration("terra")],
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
  });

  assert.equal(report.results[0].requestedModel, "deepseek-v4-flash");
  assert.equal(report.results[0].returnedModel, "deepseek-v4-flash");
  assert.equal(fixture.calls.some((call) => call.action === "create"), false);
  assert.equal(fixture.calls.filter((call) => call.action === "execute").length, 1);
  assert.equal(fixture.calls.filter((call) => call.action === "fork").length, 1);
});

test("reusable source fails closed when question, snapshot, policy, returned model, or full evidence differs", () => {
  const availableModels = collectAvailableModels(createCapabilityResponse({
    finalCallBudget: {
      configured: true,
      persistent: true,
      storageKind: "redis-admin-final-budget",
    },
    capabilityMode: "complete",
  }));
  const validate = (run, question = "测试问题") => validateReusableSourceRun({
    run,
    question,
    sourceConfiguration: relaySolConfiguration(),
    availableModels,
  });

  assert.throws(
    () => validateReusableSourceRun({
      run: createReusableSourceRun(),
      question: "测试问题",
      sourceConfiguration: relaySolConfiguration(),
    }),
    /source capabilities are required/u,
  );

  assert.throws(
    () => validateReusableSourceRun({
      run: createReusableSourceRun(),
      question: "测试问题",
      sourceConfiguration: deepSeekFlashConfiguration(),
      availableModels,
    }),
    /execution profile does not match/u,
  );

  assert.throws(
    () => validate(createReusableSourceRun(), "另一道题"),
    /question does not match/u,
  );

  const tamperedSnapshot = createReusableSourceRun();
  tamperedSnapshot.evidenceSnapshot.evidence.request.finalModel = "gpt-5.6-terra";
  assert.throws(
    () => validate(tamperedSnapshot),
    /snapshot integrity check failed/u,
  );

  const repairOnce = createReusableSourceRun();
  repairOnce.executionProfile.finalRuling.finalAttemptPolicy = "repair_once";
  assert.throws(
    () => validate(repairOnce),
    /single/u,
  );

  const returnedOtherModel = createReusableSourceRun();
  returnedOtherModel.result.provider.model = "gpt-5.6-terra";
  assert.throws(
    () => validate(returnedOtherModel),
    /no completed response from gpt-5\.6-sol/u,
  );

  const missingFullSnapshot = createReusableSourceRun();
  delete missingFullSnapshot.evidenceSnapshot;
  delete missingFullSnapshot.result.evidenceSnapshot;
  assert.throws(
    () => validate(missingFullSnapshot),
    /does not contain a full frozen evidence snapshot/u,
  );
});

test("failed terminal call recovers returned model, usage, and cost from validation audit without inventing finish reason", async () => {
  const fixture = createFetchFixture({ terminalFailureModel: "relay-gpt-5.6-terra" });
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "失败计量测试",
    configurations: [
      relaySolConfiguration(),
      relayConfiguration("terra"),
    ],
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    concurrency: 1,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
  });

  const failed = report.results.find((item) => item.configuration.model === "relay-gpt-5.6-terra");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.returnedModel, "gpt-5.6-terra");
  assert.deepEqual(failed.metrics.tokenUsage, {
    inputTokens: 11,
    outputTokens: 4,
    totalTokens: 15,
  });
  assert.deepEqual(failed.metrics.cost, { totalCostCny: 0.025 });
  assert.equal(failed.metrics.finishReason, null);
  assert.equal(failed.audit.completedAttemptRecovered, true);
  assert.equal(failed.audit.eventCount, 1);
  assert.equal(failed.error.code, "mock_validation_failed");
});

test("failed Relay report safely recovers identity, final-only metering and SSE diagnostics from run error", async () => {
  const fixture = createFetchFixture({ terminalFailureErrorOnlyModel: "relay-gpt-5.6-terra" });
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "失败错误白名单测试",
    configurations: [relaySolConfiguration(), relayConfiguration("terra")],
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    concurrency: 1,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
  });

  const failed = report.results.find((item) => item.configuration.model === "relay-gpt-5.6-terra");
  assert.equal(failed.returnedModel, "gpt-5.6-terra");
  assert.equal(failed.metrics.tokenUsage.totalTokens, 21);
  assert.equal(failed.metrics.cost.cacheWriteCostCny, 0.003);
  assert.equal(failed.metrics.relayStream.requestToFirstContentMs, null);
  assert.equal(failed.metrics.relayStream.sseEventCount, 2);
  assert.equal(failed.error.requestId, "request-error-only");
  assert.equal(failed.error.reportedModel, "gpt-5.6-terra");
  assert.equal(failed.error.billingStatus, "metered_final_ruling_usage_reported");
  assert.equal(failed.error.failureMetering.usage.totalTokens, 21);
  assert.equal(JSON.stringify(failed).includes("DO_NOT_COPY_UNKNOWN_ERROR_FIELD"), false);
});

test("matrix uses the first candidate as source and enforces request cost and concurrency guards before paid runs", async () => {
  const blockedByCost = createFetchFixture();
  await assert.rejects(
    runAdminModelMatrix({
      baseUrl: "https://lab.example.test",
      origin: "https://admin.example.test",
      password: "test-only-password",
      question: "测试问题",
      fetchImpl: blockedByCost.fetch,
      estimatedCnyPerFinalRequest: 10,
      sleep: async () => {},
    }),
    /planned estimated cost CNY 30 exceeds the hard limit 10/u,
  );
  assert.equal(blockedByCost.calls.some((call) => call.action === "create"), false);

  const allowed = createFetchFixture();
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "测试问题",
    fetchImpl: allowed.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    sleep: async () => {},
  });
  const create = allowed.calls.find((call) => call.action === "create");
  assert.equal(create.body.provider, "relay");
  assert.equal(create.body.model, "relay-gpt-5.6-sol");
  assert.equal(create.body.preparationProvider, "deepseek");
  assert.equal(create.body.finalAttemptPolicy, "single");
  assert.equal(report.guard.plannedFinalRequests, 3);
  assert.equal(report.guard.costEstimateMode, "relay_screenshot_token_envelope");
  assert.equal(report.guard.pricingVerified, false);
  assert.equal(report.guard.pricingMultiplier, 0.27);
  assert.equal(report.guard.estimatedInputTokensPerFinalRequest, 32000);
  assert.equal(report.guard.estimatedOutputTokensPerFinalRequest, 8192);
  assert.equal(report.guard.plannedEstimatedCostCny, 1.744261208);
  assert.deepEqual(
    report.guard.requestEstimates.map((item) => [item.model, item.estimatedCnyPerRequest]),
    [
      ["relay-gpt-5.6-sol", 1.19962944],
      ["relay-gpt-5.6-terra", 0.479851778],
      ["relay-gpt-5.6-luna", 0.06477999],
    ],
  );

  const blockedByConcurrency = createFetchFixture();
  await assert.rejects(
    runAdminModelMatrix({
      baseUrl: "https://lab.example.test",
      origin: "https://admin.example.test",
      password: "test-only-password",
      question: "测试问题",
      concurrency: 2,
      fetchImpl: blockedByConcurrency.fetch,
    }),
    /concurrency 2 exceeds the hard limit 1/u,
  );
  assert.equal(blockedByConcurrency.calls.length, 0);
});

test("paid matrix fails closed before run creation without a persistent final-call budget ledger", async () => {
  const fixture = createFetchFixture({
    finalCallBudget: {
      configured: true,
      persistent: false,
      storageKind: "memory-admin-final-budget",
    },
  });
  await assert.rejects(
    runAdminModelMatrix({
      baseUrl: "https://lab.example.test",
      origin: "https://admin.example.test",
      password: "test-only-password",
      question: "测试问题",
      fetchImpl: fixture.fetch,
      estimatedCnyPerFinalRequest: 0,
    }),
    /configured persistent final-call budget ledger/u,
  );
  assert.equal(fixture.calls.some((call) => call.action === "create"), false);
  assert.equal(fixture.calls.some((call) => call.action === "execute"), false);
});

test("paid matrix fails closed before run creation when capabilities are unavailable or incomplete", async (t) => {
  for (const [capabilityMode, expectedError] of [
    ["zero_available", /Evidence preparation configuration is unavailable/u],
    ["missing_budget_fields", /Evidence preparation configuration is unavailable/u],
    ["missing_features", /Admin lab capability is unavailable: executeRun/u],
  ]) {
    await t.test(capabilityMode, async () => {
      const fixture = createFetchFixture({ capabilityMode });
      await assert.rejects(
        runAdminModelMatrix({
          baseUrl: "https://lab.example.test",
          origin: "https://admin.example.test",
          password: "test-only-password",
          question: "测试问题",
          fetchImpl: fixture.fetch,
          estimatedCnyPerFinalRequest: 0,
        }),
        expectedError,
      );
      assert.equal(fixture.calls.some((call) => call.action === "create"), false);
      assert.equal(fixture.calls.some((call) => call.action === "fork"), false);
      assert.equal(fixture.calls.some((call) => call.action === "execute"), false);
    });
  }
});

test("explicit five-model pilot performs exactly one final submission per available model", async () => {
  const fixture = createFetchFixture();
  const report = await runAdminModelMatrix({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    question: "测试问题",
    configurations: FIVE_MODEL_PILOT_CONFIGURATIONS,
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    maxFinalRequests: 5,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
  });

  assert.equal(report.guard.finalAttemptPolicy, "single");
  assert.equal(report.guard.plannedFinalRequests, 5);
  assert.deepEqual(
    report.results.map((item) => item.requestedModel),
    [
      "relay-gpt-5.6-sol",
      "relay-gpt-5.6-terra",
      "relay-gpt-5.6-luna",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ],
  );
  assert.equal(fixture.calls.filter((call) => call.action === "execute").length, 5);
  assert.equal(fixture.calls.filter((call) => call.action === "create").length, 1);
  assert.equal(fixture.calls.filter((call) => call.action === "fork").length, 4);
});

test("four-case pilot applies the relay multiplier before enforcing the CLI cost cap", async () => {
  const blocked = createFetchFixture();
  await assert.rejects(
    runAdminModelMatrixBatch({
      baseUrl: "https://lab.example.test",
      origin: "https://admin.example.test",
      password: "test-only-password",
      questions: ["Q1", "Q2", "Q3", "Q4"],
      fetchImpl: blocked.fetch,
      estimatedCnyPerFinalRequest: 10,
    }),
    /planned estimated cost CNY 120 exceeds the hard limit 10/u,
  );
  assert.equal(blocked.calls.length, 0);

  const defaultBlocked = createFetchFixture();
  await assert.rejects(
    runAdminModelMatrixBatch({
      baseUrl: "https://lab.example.test",
      origin: "https://admin.example.test",
      password: "test-only-password",
      questions: ["Q1", "Q2", "Q3", "Q4"],
      fetchImpl: defaultBlocked.fetch,
      maxEstimatedCostCny: 5,
    }),
    /planned estimated cost CNY 6\.977044832 exceeds the hard limit 5/u,
  );
  assert.equal(defaultBlocked.calls.length, 0);

  const fixture = createFetchFixture();
  const report = await runAdminModelMatrixBatch({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-only-password",
    questions: ["Q1", "Q2", "Q3", "Q4"],
    fetchImpl: fixture.fetch,
    pollIntervalMs: 1,
    runTimeoutMs: 1_000,
    estimatedCnyPerFinalRequest: 0,
    sleep: async () => {},
  });
  assert.equal(report.guard.plannedFinalRequests, 12);
  assert.equal(report.guard.costEstimateMode, "explicit_uniform_override");
  assert.equal(report.guard.plannedEstimatedCostCny, 0);
  assert.equal(report.reports.length, 4);
  assert.equal(fixture.calls.filter((call) => call.action === "create").length, 4);
  assert.equal(fixture.calls.filter((call) => call.action === "fork").length, 8);
  assert.equal(fixture.calls.filter((call) => call.action === "execute").length, 12);
});

test("cases-file CLI executes four questions as exactly twelve single final requests", async () => {
  const fixture = createFetchFixture();
  const output = [];
  const cases = {
    cases: [
      {
        caseId: "case-a",
        question: "Q1",
        candidateCards: ["匿名卡A", "匿名卡B"],
        expectedAnswer: "GOLD_ONLY_ANSWER_MUST_NOT_LEAK",
        leakCanary: "GOLD_ONLY_CANARY_MUST_NOT_LEAK",
      },
      { caseId: "case-b", question: "Q2" },
      { caseId: "case-c", question: "Q3" },
      { caseId: "case-d", question: "Q4" },
    ],
  };

  const exitCode = await main([
    "--base-url", "https://lab.example.test",
    "--origin", "https://admin.example.test",
    "--cases-file", "matrix-cases.json",
    "--poll-ms", "1",
    "--timeout-ms", "1000",
    "--max-final-requests", "12",
    "--max-cost-cny", "12",
    "--estimated-cny-per-request", "1",
  ], {
    ADMIN_MODEL_LAB_PASSWORD: "test-only-password",
  }, {
    fetchImpl: fixture.fetch,
    readFileImpl: async (pathname) => {
      assert.equal(pathname, "matrix-cases.json");
      return JSON.stringify(cases);
    },
    stdout: { write: (value) => output.push(String(value)) },
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(output.join(""));
  assert.equal(report.guard.finalAttemptPolicy, "single");
  assert.equal(report.guard.plannedFinalRequests, 12);
  assert.equal(report.reports.length, 4);
  assert.deepEqual(report.reports.map((item) => item.caseId), [
    "case-a",
    "case-b",
    "case-c",
    "case-d",
  ]);
  assert.equal(fixture.calls.filter((call) => call.action === "create").length, 4);
  assert.equal(fixture.calls.filter((call) => call.action === "fork").length, 8);
  assert.equal(fixture.calls.filter((call) => call.action === "execute").length, 12);
  const firstCreate = fixture.calls.find(
    (call) => call.action === "create" && call.body.question === "Q1",
  );
  assert.deepEqual(firstCreate.body.cardNameCandidates, ["匿名卡A", "匿名卡B"]);
  assert.doesNotMatch(
    JSON.stringify(fixture.calls),
    /GOLD_ONLY_(?:ANSWER|CANARY)_MUST_NOT_LEAK/u,
  );
});

function createFetchFixture({
  terminalFailureModel = "",
  terminalFailureErrorOnlyModel = "",
  capabilityMode = "complete",
  existingSourceConfiguration = relaySolConfiguration(),
  finalCallBudget = {
    configured: true,
    persistent: true,
    storageKind: "redis-admin-final-budget",
  },
} = {}) {
  const runs = new Map();
  const events = new Map();
  const existingRun = createReusableSourceRun({ configuration: existingSourceConfiguration });
  runs.set(existingRun.runId, existingRun);
  const calls = [];
  const protectedHeaders = [];
  const auth = {};
  let sourceNumber = 0;
  let forkNumber = 0;

  async function fetch(urlValue, options = {}) {
    const url = new URL(urlValue);
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = normalizeHeaders(options.headers);
    if (url.pathname === "/api/admin-auth") {
      auth.password = body.password;
      auth.origin = headers.origin;
      return jsonResponse({
        ok: true,
        authenticated: true,
        csrfToken: "test-csrf",
      }, 200, { "set-cookie": "admin_session=test-session; Path=/; HttpOnly" });
    }

    assert.equal(headers.cookie, "admin_session=test-session");
    if (options.method === "POST") {
      assert.equal(headers["x-csrf-token"], "test-csrf");
      protectedHeaders.push(headers);
    }
    const action = options.method === "POST" ? body.action : url.searchParams.get("action");
    calls.push({ action, body, url: url.toString() });
    if (action === "capabilities") {
      return ok(createCapabilityResponse({
        finalCallBudget,
        capabilityMode,
      }), "capabilities");
    }
    if (action === "create") {
      const snapshot = createFixtureSnapshot(body.question, body);
      const run = createQueuedRun({
        runId: `source-${++sourceNumber}`,
        configuration: body,
        snapshot,
      });
      runs.set(run.runId, run);
      return ok({ run }, "create");
    }
    if (action === "fork") {
      if (body.provider === "glm" && body.reasoningMode === "pro") {
        return jsonResponse({ ok: false, error: "mock_fork_failure" }, 500);
      }
      const source = runs.get(body.forkFromRunId);
      const run = createQueuedRun({
        runId: `fork-${++forkNumber}`,
        configuration: body,
        snapshot: source?.evidenceSnapshot,
        sourceRun: source,
      });
      runs.set(run.runId, run);
      return ok({ run }, "fork");
    }
    if (action === "execute") {
      const run = runs.get(body.runId);
      if (!run) return jsonResponse({ ok: false, error: "not_found" }, 404);
      const returnedModel = canonicalModel(run.configuration.model);
      if (run.configuration.model === terminalFailureErrorOnlyModel) {
        run.status = "FAILED";
        run.error = {
          code: "provider_submission_outcome_unknown",
          message: "stream closed without DONE",
          provider: "relay",
          requestId: "request-error-only",
          requestedModel: "relay-gpt-5.6-terra",
          submittedModel: "gpt-5.6-terra",
          reportedModel: "gpt-5.6-terra",
          billingStatus: "metered_final_ruling_usage_reported",
          outcomeKnown: false,
          usage: { inputTokens: 17, outputTokens: 4, totalTokens: 21 },
          failureMetering: {
            scope: "final_ruling_only",
            usage: { inputTokens: 17, outputTokens: 4, totalTokens: 21 },
            cost: { totalCostCny: 0.03, cacheWriteCostCny: 0.003 },
          },
          streamMetrics: {
            requestToResponseHeadersMs: 20,
            requestToFirstByteMs: 30,
            requestToFirstEventMs: 40,
            requestToFirstContentMs: null,
            requestToCompleteMs: null,
            networkChunkCount: 2,
            sseEventCount: 2,
            visibleContentChunkCount: 0,
            responseBytes: 300,
            visibleContentBytes: 0,
            finishReason: null,
          },
          unknownSecret: "DO_NOT_COPY_UNKNOWN_ERROR_FIELD",
        };
      } else if (run.configuration.model === terminalFailureModel) {
        run.status = "FAILED";
        run.error = {
          code: "mock_validation_failed",
          message: "mock response failed schema validation",
        };
        const completedAttempt = {
          schemaVersion: 1,
          attemptKind: "primary",
          providerId: run.configuration.provider,
          requestId: `request-${run.runId}`,
          model: returnedModel,
          status: "completed",
          usageStatus: "reported",
          usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
          cost: { totalCostCny: 0.025 },
          validation: { ok: false, errors: [{ code: "invalid_schema" }] },
        };
        events.set(run.runId, [{
          sequence: 1,
          type: "MODEL_VALIDATION_FAILED",
          payload: { completedAttempt },
        }]);
      } else {
        run.status = "SUCCEEDED";
        run.result = completedResult(returnedModel, run.evidenceSnapshot);
      }
      return ok({ run }, "execute");
    }
    if (action === "run") {
      const run = runs.get(url.searchParams.get("runId"));
      return ok({ run }, "run");
    }
    if (action === "events") {
      return sseResponse(events.get(url.searchParams.get("runId")) || []);
    }
    return jsonResponse({ ok: false, error: "unexpected_action" }, 400);
  }

  return {
    fetch,
    calls,
    protectedHeaders,
    auth,
    existingSnapshot: existingRun.evidenceSnapshot,
  };
}

function createCapabilityResponse({ finalCallBudget, capabilityMode }) {
  const budgetedModel = ({ modelId, budgetPool, modes, efforts, available = true }) => ({
    modelId,
    canonicalModelId: canonicalModel(modelId),
    available,
    transportAvailable: available,
    budgetConfigured: available,
    budgetAvailable: available,
    budgetPool,
    supportedReasoningModes: modes || [],
    supportedReasoningEfforts: efforts || [],
  });
  let providers = [
    {
      providerId: "deepseek",
      available: true,
      transportAvailable: true,
      models: [
        budgetedModel({
          modelId: "deepseek-v4-flash",
          budgetPool: "deepseek",
          modes: ["standard", "pro"],
          efforts: ["none", "high"],
        }),
        budgetedModel({
          modelId: "deepseek-v4-pro",
          budgetPool: "deepseek",
          modes: ["standard", "pro"],
          efforts: ["none", "high", "max"],
        }),
      ],
    },
    {
      providerId: "glm",
      available: true,
      transportAvailable: true,
      models: [budgetedModel({
        modelId: "glm-5.2",
        budgetPool: "glm",
        modes: ["standard", "pro"],
        efforts: ["none", "high"],
      })],
    },
    {
      providerId: "kimi",
      available: false,
      transportAvailable: false,
      models: [budgetedModel({
        modelId: "kimi-k2.6",
        budgetPool: "kimi",
        available: false,
      })],
    },
    {
      providerId: "relay",
      available: true,
      transportAvailable: true,
      models: ["sol", "terra", "luna"].map((name) => budgetedModel({
        modelId: `relay-gpt-5.6-${name}`,
        budgetPool: `relay_${name}`,
        modes: ["pro"],
        efforts: ["high"],
      })),
    },
  ];
  const flatModels = Object.fromEntries(providers.flatMap((provider) => (
    provider.models.map((model) => [model.modelId, {
      providerId: provider.providerId,
      supportedReasoningModes: model.supportedReasoningModes,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
    }])
  )));
  if (capabilityMode === "zero_available") {
    providers = providers.map((provider) => ({
      ...provider,
      available: false,
      models: provider.models.map((model) => ({
        ...model,
        available: false,
        budgetAvailable: false,
      })),
    }));
  } else if (capabilityMode === "missing_budget_fields") {
    providers = providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => {
        const {
          budgetConfigured,
          budgetAvailable,
          budgetPool,
          ...remainder
        } = model;
        return remainder;
      }),
    }));
  }
  return {
    features: capabilityMode === "missing_features"
      ? { createRun: true, forkRun: true }
      : { createRun: true, forkRun: true, executeRun: true },
    architecture: { finalCallBudget },
    providers: { providers },
    // The real endpoint also exposes this unbudgeted static table. Paid matrix
    // discovery must never fall back to it when budgeted providers are empty.
    models: flatModels,
  };
}

function completedResult(model, snapshot = null) {
  return {
    provider: { model, finishReason: "stop" },
    ...(snapshot ? {
      evidenceSnapshotId: snapshot.snapshotId,
      evidenceSnapshot: snapshot,
    } : {}),
    finalRuling: {
      conciseAnswer: `answer:${model}`,
      verdicts: [{ questionId: "q1", value: "TRUE", conclusion: "ok", conditions: [] }],
      timeline: [{ order: 1, action: "act", result: "resolved", evidenceIds: [] }],
    },
    latency: {
      totalWallClockMs: 123,
      preparationMs: 67,
      finalRulingMs: 45,
      stages: [{ id: "final_ruling", status: "completed", durationMs: 45 }],
    },
    metering: {
      stages: { finalRuling: { model } },
      totals: {
        usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 },
        cost: { totalCostCny: 0.01 },
      },
    },
  };
}

function createReusableSourceRun({
  question = "测试问题",
  configuration = relaySolConfiguration(),
} = {}) {
  const snapshot = createFixtureSnapshot(question, configuration);
  const canonical = canonicalModel(configuration.model);
  return structuredClone({
    runId: "source-existing",
    status: "SUCCEEDED",
    configuration,
    evidenceSnapshot: snapshot,
    evidenceSnapshotId: snapshot.snapshotId,
    evidenceSnapshotSha256: snapshot.contentSha256,
    executionProfile: {
      status: "evidence_frozen",
      evidenceSnapshotId: snapshot.snapshotId,
      evidenceVariant: configuration.evidenceVariant || "full",
      finalRulingInputSha256: fixtureFinalInputHash(configuration),
      finalRuling: {
        provider: configuration.provider,
        requestedModel: configuration.model,
        model: canonical,
        reasoningMode: configuration.reasoningMode,
        reasoningEffort: configuration.reasoningEffort,
        finalAttemptPolicy: "single",
      },
    },
    result: completedResult(canonical, snapshot),
  });
}

function createQueuedRun({ runId, configuration, snapshot, sourceRun = null }) {
  const resolvedSnapshot = snapshot || createFixtureSnapshot("fixture question", configuration);
  const canonical = canonicalModel(configuration.model);
  return {
    runId,
    status: "QUEUED",
    configuration,
    evidenceSnapshot: resolvedSnapshot,
    evidenceSnapshotId: resolvedSnapshot.snapshotId,
    evidenceSnapshotSha256: resolvedSnapshot.contentSha256,
    executionProfile: {
      status: "evidence_frozen",
      evidenceSnapshotId: resolvedSnapshot.snapshotId,
      evidenceVariant: configuration.evidenceVariant || "full",
      finalRulingInputSha256: fixtureFinalInputHash(configuration),
      finalRuling: {
        provider: configuration.provider,
        requestedModel: configuration.model,
        model: canonical,
        reasoningMode: configuration.reasoningMode,
        reasoningEffort: configuration.reasoningEffort,
        finalAttemptPolicy: configuration.finalAttemptPolicy || "single",
      },
    },
    ...(sourceRun ? {
      metadata: {
        fork: {
          sourceRunId: sourceRun.runId,
          sourceEvidenceSnapshotId: resolvedSnapshot.snapshotId,
          evidenceSnapshotSha256: resolvedSnapshot.contentSha256,
        },
      },
    } : {}),
  };
}

function createFixtureSnapshot(question, configuration) {
  return createEvidenceSnapshot({
    question,
    evidence: {
      request: {
        finalAttemptPolicy: configuration.finalAttemptPolicy || "single",
        finalModel: canonicalModel(configuration.model),
      },
    },
    dataVersions: { fixture: "matrix-v1" },
    metadata: { finalRulingProvider: configuration.provider },
    createdAt: new Date("2026-08-05T00:00:00.000Z"),
  });
}

function relaySolConfiguration() {
  return relayConfiguration("sol");
}

function fixtureFinalInputHash(configuration) {
  const marker = {
    full: "f",
    card_text_only: "c",
    without_lua: "a",
  }[configuration?.evidenceVariant || "full"] || "0";
  return marker.repeat(64);
}

function deepSeekFlashConfiguration() {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    reasoningEffort: "none",
  };
}

function relayConfiguration(name) {
  return {
    provider: "relay",
    model: `relay-gpt-5.6-${name}`,
    reasoningMode: "pro",
    reasoningEffort: "high",
  };
}

function canonicalModel(model) {
  return String(model || "").replace(/^relay-/u, "");
}

function sseResponse(events) {
  const body = events.map((event) => (
    `event: run-event\ndata: ${JSON.stringify(event)}\n\n`
  )).join("") + "event: end\ndata: {}\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function ok(data, action) {
  return jsonResponse({ ok: true, action, data });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
