import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAvailableModels,
  formatMatrixMarkdown,
  parseMatrixArguments,
  runAdminModelMatrix,
} from "../scripts/admin-model-matrix.mjs";

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
    concurrency: 2,
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
  }, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    reasoningEffort: "none",
    preparationProvider: "deepseek",
    preparationModel: "deepseek-v4-flash",
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
    "--config", "glm:glm-5.2:standard:none",
    "--format", "markdown",
    "--concurrency", "3",
  ]);
  assert.equal(parsed.question, "Q");
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

function createFetchFixture() {
  const runs = new Map();
  const calls = [];
  const protectedHeaders = [];
  const auth = {};
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
          ],
        },
      }, "capabilities");
    }
    if (action === "create") {
      const run = { runId: "source-1", status: "QUEUED", configuration: body };
      runs.set(run.runId, run);
      return ok({ run }, "create");
    }
    if (action === "fork") {
      if (body.reasoningMode === "pro") {
        return jsonResponse({ ok: false, error: "mock_fork_failure" }, 500);
      }
      const run = {
        runId: `fork-${++forkNumber}`,
        status: "QUEUED",
        configuration: body,
      };
      runs.set(run.runId, run);
      return ok({ run }, "fork");
    }
    if (action === "execute") {
      const run = runs.get(body.runId);
      if (!run) return jsonResponse({ ok: false, error: "not_found" }, 404);
      run.status = "SUCCEEDED";
      run.result = completedResult(run.configuration.model);
      return ok({ run }, "execute");
    }
    if (action === "run") {
      const run = runs.get(url.searchParams.get("runId"));
      return ok({ run }, "run");
    }
    return jsonResponse({ ok: false, error: "unexpected_action" }, 400);
  }

  return { fetch, calls, protectedHeaders, auth };
}

function completedResult(model) {
  return {
    finalRuling: {
      conciseAnswer: `answer:${model}`,
      verdicts: [{ questionId: "q1", value: "TRUE", conclusion: "ok", conditions: [] }],
      timeline: [{ order: 1, action: "act", result: "resolved", evidenceIds: [] }],
    },
    latency: { totalWallClockMs: 123, finalRulingMs: 45 },
    metering: {
      totals: {
        usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 },
        cost: { totalCostCny: 0.01 },
      },
    },
  };
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
