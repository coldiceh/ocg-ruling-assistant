import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAvailableModels,
  formatMatrixMarkdown,
  main,
  parseMatrixArguments,
  runAdminModelMatrix,
  runAdminModelMatrixBatch,
  validateReusableSourceRun,
} from "../scripts/admin-model-matrix.mjs";
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
  });

  const available = collectAvailableModels({
    providers: {
      providers: [
        {
          providerId: "glm",
          available: true,
          models: [{ modelId: "glm-5.2", available: true }],
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

test("reusable source fails closed when question, snapshot, policy, returned model, or full evidence differs", () => {
  const validate = (run, question = "测试问题") => validateReusableSourceRun({
    run,
    question,
    sourceConfiguration: relaySolConfiguration(),
  });

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
    /no completed relay GPT-5\.6 Sol response/u,
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
  assert.equal(report.guard.estimatedInputTokensPerFinalRequest, 32000);
  assert.equal(report.guard.estimatedOutputTokensPerFinalRequest, 8192);
  assert.equal(report.guard.plannedEstimatedCostCny, 6.460226685);
  assert.deepEqual(
    report.guard.requestEstimates.map((item) => [item.model, item.estimatedCnyPerRequest]),
    [
      ["relay-gpt-5.6-sol", 4.443072],
      ["relay-gpt-5.6-terra", 1.7772288],
      ["relay-gpt-5.6-luna", 0.239925885],
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

test("four-case pilot blocks the default twelve-call estimate under the shared 10 CNY pool", async () => {
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
    }),
    /planned estimated cost CNY 25\.84090674 exceeds the hard limit 10/u,
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
      { caseId: "case-a", question: "Q1" },
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
});

function createFetchFixture({ terminalFailureModel = "" } = {}) {
  const runs = new Map();
  const events = new Map();
  const existingRun = createReusableSourceRun();
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
      return ok({
        features: { createRun: true, forkRun: true, executeRun: true },
        providers: {
          providers: [
            {
              providerId: "deepseek",
              available: true,
              models: [{
                modelId: "deepseek-v4-flash",
                available: true,
                supportedReasoningModes: ["standard", "pro"],
                supportedReasoningEfforts: ["none", "high"],
              }],
            },
            {
              providerId: "glm",
              available: true,
              models: [{
                modelId: "glm-5.2",
                available: true,
                supportedReasoningModes: ["standard", "pro"],
                supportedReasoningEfforts: ["none", "high"],
              }],
            },
            {
              providerId: "kimi",
              available: false,
              models: [{ modelId: "kimi-k2.6", available: false }],
            },
            {
              providerId: "relay",
              available: true,
              models: ["sol", "terra", "luna"].map((name) => ({
                modelId: `relay-gpt-5.6-${name}`,
                available: true,
                supportedReasoningModes: ["pro"],
                supportedReasoningEfforts: ["high"],
              })),
            },
          ],
        },
      }, "capabilities");
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
      if (run.configuration.model === terminalFailureModel) {
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

function createReusableSourceRun({ question = "测试问题" } = {}) {
  const configuration = relaySolConfiguration();
  const snapshot = createFixtureSnapshot(question, configuration);
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
      finalRuling: {
        provider: "relay",
        requestedModel: "relay-gpt-5.6-sol",
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        finalAttemptPolicy: "single",
      },
    },
    result: completedResult("gpt-5.6-sol", snapshot),
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
