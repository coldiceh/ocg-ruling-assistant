import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateModelEffortMatrix,
  aggregateModelEffortMatrixFiles,
  main,
  parseModelEffortMatrixArguments,
  renderModelEffortMatrixMarkdown,
} from "../scripts/aggregate-model-effort-matrix.mjs";

const CASE_IDS = ["case-a", "case-b", "case-c", "case-d"];

test("aggregates model+effort accuracy, availability, streaming latency, tokens and explicit estimates", () => {
  const report = aggregateModelEffortMatrix({
    runs: [
      fixtureRun({
        model: "relay-gpt-5.6-sol",
        effort: "low",
        scores: ["PASS", "PASS", "PASS", "FAIL"],
      }),
      fixtureRun({
        model: "relay-gpt-5.6-terra",
        effort: "medium",
        scores: ["PASS", "FAIL", "INCONCLUSIVE", "PASS"],
      }),
    ],
    expectedCaseCount: 4,
    generatedAt: "2026-08-08T00:00:00.000Z",
    dashboardMetadata: {
      batches: [{
        label: "relay pilot",
        requestCount: 8,
        before: 0.5,
        after: 0.9,
        delta: 0.4,
        unit: "relay dashboard credit",
        source: "manual screenshot",
      }],
    },
  });

  assert.equal(report.publishable, true);
  assert.deepEqual(report.caseIds, CASE_IDS);
  assert.equal(report.evidenceConsistency.bundleSha256, "bundle-shared");
  assert.deepEqual(report.evidenceConsistency.finalInputSha256ByCase, {
    "case-a": ["input-case-a"],
    "case-b": ["input-case-b"],
    "case-c": ["input-case-c"],
    "case-d": ["input-case-d"],
  });

  const sol = report.configurations.find((item) => item.model === "relay-gpt-5.6-sol");
  assert.deepEqual(sol.cases.map((item) => item.status), ["PASS", "PASS", "PASS", "FAIL"]);
  assert.deepEqual(sol.counts, { PASS: 3, FAIL: 1, INCONCLUSIVE: 0 });
  assert.deepEqual(sol.accuracy, { numerator: 3, denominator: 4, rate: 0.75 });
  assert.deepEqual(sol.availability, { numerator: 4, denominator: 4, rate: 1 });
  assert.deepEqual(sol.latency.totalMs, { reportedCount: 4, average: 2500, median: 2500 });
  assert.deepEqual(sol.latency.firstContentMs, { reportedCount: 4, average: 250, median: 250 });
  assert.deepEqual(sol.tokens.input, { reportedCount: 4, average: 25, median: 25, sum: 100 });
  assert.deepEqual(sol.tokens.output, { reportedCount: 4, average: 2.5, median: 2.5, sum: 10 });
  assert.deepEqual(sol.tokens.reasoning, { reportedCount: 4, average: 1.5, median: 1.5, sum: 6 });
  assert.deepEqual(sol.tokens.total, { reportedCount: 4, average: 27.5, median: 27.5, sum: 110 });
  assert.deepEqual(sol.estimatedCost, {
    reportedCaseCount: 4,
    plannedCaseCount: 4,
    complete: true,
    totals: { CNY: 0.00031536 },
    averagesPerReportedCase: { CNY: 0.00007884 },
    costsPerCorrectAnswer: { CNY: 0.00010512 },
    sourceFields: ["estimateRelayModelCost"],
    verification: ["unverified"],
    pricingVersions: ["relay-token-group-screenshot-2026-08-07"],
    relayCreditTotal: 0.00031536,
  });

  const terra = report.configurations.find((item) => item.model === "relay-gpt-5.6-terra");
  assert.deepEqual(terra.counts, { PASS: 2, FAIL: 1, INCONCLUSIVE: 1 });
  assert.deepEqual(terra.accuracy, { numerator: 2, denominator: 4, rate: 0.5 });
  assert.deepEqual(terra.availability, { numerator: 3, denominator: 4, rate: 0.75 });
  assert.deepEqual(terra.estimatedCost.verification, ["unverified"]);
  assert.equal(terra.estimatedCost.complete, true);

  assert.equal(report.dashboard.attributionScope, "batch_only");
  assert.equal(report.dashboard.perRequestAllocation, null);
  assert.equal(report.dashboard.batches[0].perRequestAllocation, null);
  assert.equal(report.pricingAssumptions.relay.relayCreditToCny, 1);
  assert.equal(report.pricingAssumptions.relay.pricingMultiplier, 0.27);
  assert.equal(report.pricingAssumptions.relay.pricingSourceVerified, false);
  assert.match(report.metricDefinitions.cost, /final-ruling model calls only/u);
  assert.match(report.metricDefinitions.costPerCorrectAnswer, /PASS count/u);
  const markdown = renderModelEffortMatrixMarkdown(report);
  assert.match(markdown, /relay-gpt-5\.6-sol/u);
  assert.match(markdown, /\| 正确 \| 正确 \| 正确 \| 错误 \|/u);
  assert.match(markdown, /3\/4 \(75\.0%\)/u);
  assert.match(markdown, /2\.5 \/ 2\.5 s/u);
  assert.match(markdown, /100 \(4\)/u);
  assert.match(markdown, /CNY 0\.000315 \/ 0\.000079 \/ 0\.000105 \(未验证；4\/4\)/u);
  assert.match(markdown, /看板实际批次增量/u);
  assert.match(markdown, /不推导、不分摊为单次请求费用/u);
});

test("strict evidence validation rejects bundle, per-case input and planned-case mismatches", () => {
  const first = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const bundleMismatch = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "low" });
  bundleMismatch.checkpoint.bundleSha256 = "different-bundle";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [first, bundleMismatch], expectedCaseCount: 4 }),
    /bundleSha256 mismatch/u,
  );

  const inputMismatch = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "low" });
  inputMismatch.checkpoint.results[0].finalInputSha256 = "different-input";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [first, inputMismatch], expectedCaseCount: 4 }),
    /case-a finalInputSha256 mismatch/u,
  );

  const planMismatch = fixtureRun({
    model: "relay-gpt-5.6-terra",
    effort: "low",
    caseIds: CASE_IDS.slice(0, 3),
  });
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [first, planMismatch], expectedCaseCount: 4 }),
    /does not use the same planned case set/u,
  );
});

test("an explicit mismatch override preserves diagnostics and marks the report unpublishable", () => {
  const first = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const second = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "low" });
  second.checkpoint.bundleSha256 = "different-bundle";
  second.checkpoint.results[2].finalInputSha256 = "different-case-c-input";

  const report = aggregateModelEffortMatrix({
    runs: [first, second],
    expectedCaseCount: 4,
    strictEvidence: false,
  });
  assert.equal(report.publishable, false);
  assert.equal(report.evidenceConsistency.valid, false);
  assert.match(report.evidenceConsistency.errors.join("\n"), /bundleSha256 mismatch/u);
  assert.match(report.evidenceConsistency.errors.join("\n"), /case-c finalInputSha256 mismatch/u);
});

test("missing optional hashes and metrics remain null instead of becoming zero", () => {
  const run = fixtureRun({ model: "deepseek-v4-flash", effort: "pro" });
  delete run.checkpoint.bundleSha256;
  for (const result of run.checkpoint.results) {
    delete result.finalInputSha256;
    delete result.durationMs;
    delete result.sseTiming;
    delete result.usage;
  }
  const report = aggregateModelEffortMatrix({ runs: [run], expectedCaseCount: 4 });
  const summary = report.configurations[0];
  assert.equal(report.publishable, true);
  assert.ok(report.evidenceConsistency.warnings.length >= 5);
  assert.deepEqual(summary.latency.totalMs, { reportedCount: 0, average: null, median: null });
  assert.deepEqual(summary.latency.firstContentMs, { reportedCount: 0, average: null, median: null });
  assert.deepEqual(summary.tokens.input, { reportedCount: 0, average: null, median: null, sum: null });
  assert.equal(summary.estimatedCost, null);
});

test("DeepSeek keeps only an estimate explicitly present in the raw checkpoint", () => {
  const run = fixtureRun({
    model: "deepseek-v4-pro",
    effort: "high",
    estimatedCostCny: [0.01, 0.02, 0.03, 0.04],
  });
  const report = aggregateModelEffortMatrix({ runs: [run], expectedCaseCount: 4 });
  assert.deepEqual(report.configurations[0].estimatedCost, {
    reportedCaseCount: 4,
    plannedCaseCount: 4,
    complete: true,
    totals: { CNY: 0.1 },
    averagesPerReportedCase: { CNY: 0.025 },
    costsPerCorrectAnswer: { CNY: 0.025 },
    sourceFields: ["estimatedCostCny"],
    verification: ["raw_record"],
    pricingVersions: [],
    relayCreditTotal: null,
  });
});

test("file loader and CLI parser accept repeated checkpoint/scored pairs without network access", async () => {
  const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const files = new Map([
    ["checkpoint.json", JSON.stringify(run.checkpoint)],
    ["scored.json", JSON.stringify(run.scored)],
    ["dashboard.json", JSON.stringify({ batches: [{ label: "one batch", delta: 1 }] })],
  ]);
  const report = await aggregateModelEffortMatrixFiles({
    pairs: [{ checkpointFile: "checkpoint.json", scoredFile: "scored.json" }],
    dashboardMetadataFile: "dashboard.json",
    expectedCaseCount: 4,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    readFileImpl: async (pathname) => {
      assert.equal(files.has(String(pathname)), true);
      return files.get(String(pathname));
    },
  });
  assert.equal(report.generatedAt, "2026-08-08T00:00:00.000Z");
  assert.equal(report.configurations.length, 1);

  const parsed = parseModelEffortMatrixArguments([
    "--pair", "a.json", "a-scored.json",
    "--checkpoint", "b.json",
    "--scored", "b-scored.json",
    "--expected-case-count", "4",
    "--relay-credit-to-cny", "1",
    "--allow-evidence-mismatch",
  ]);
  assert.deepEqual(parsed.pairs, [
    { checkpointFile: "a.json", scoredFile: "a-scored.json" },
    { checkpointFile: "b.json", scoredFile: "b-scored.json" },
  ]);
  assert.equal(parsed.expectedCaseCount, 4);
  assert.equal(parsed.relayCreditToCny, 1);
  assert.equal(parsed.strictEvidence, false);

  const writes = [];
  const exitCode = await main([
    "--pair", "checkpoint.json", "scored.json",
    "--expected-case-count", "4",
    "--json-out", "matrix.json",
    "--markdown-out", "matrix.md",
  ], {
    readFileImpl: async (pathname) => files.get(String(pathname)),
    writeFileImpl: async (pathname, content) => writes.push({ pathname: String(pathname), content }),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    stdout: { write() {} },
  });
  assert.equal(exitCode, 0);
  assert.equal(writes.length, 2);
  assert.ok(writes.some((item) => item.pathname.endsWith("matrix.json") && /offline_model_effort_matrix/u.test(item.content)));
  assert.ok(writes.some((item) => item.pathname.endsWith("matrix.md") && /模型与推理强度实验矩阵/u.test(item.content)));
});

function fixtureRun({
  model,
  effort,
  scores = ["PASS", "PASS", "PASS", "PASS"],
  caseIds = CASE_IDS,
  estimatedCostCny = [],
} = {}) {
  const plan = caseIds.map((caseId) => ({
    caseId,
    effort,
    evidenceVariant: "full",
    key: `${caseId}::${model}::${effort}`,
  }));
  const results = caseIds.map((caseId, index) => ({
    key: `${caseId}::${model}::${effort}`,
    caseId,
    model,
    effort,
    evidenceVariant: "full",
    status: scores[index] === "INCONCLUSIVE" ? "completed_invalid" : "completed_valid",
    durationMs: (index + 1) * 1000,
    finalInputSha256: `input-${caseId}`,
    snapshotSha256: `snapshot-${caseId}`,
    reportedModel: model.replace(/^relay-/u, ""),
    usage: {
      prompt_tokens: (index + 1) * 10,
      completion_tokens: index + 1,
      total_tokens: (index + 1) * 11,
      completion_tokens_details: { reasoning_tokens: index },
    },
    sseTiming: {
      requestToFirstContentMs: (index + 1) * 100,
      requestToCompleteMs: (index + 1) * 1000 - 1,
    },
    ...(estimatedCostCny[index] === undefined ? {} : {
      estimatedCostCny: estimatedCostCny[index],
    }),
  }));
  const scoredResults = caseIds.map((caseId, index) => ({
    caseId,
    requestedModel: model,
    returnedModel: model.replace(/^relay-/u, ""),
    reasoningEffort: effort,
    evidenceVariant: "full",
    status: scores[index],
  }));
  return {
    checkpointPath: `${model}-${effort}-checkpoint.json`,
    scoredPath: `${model}-${effort}-scored.json`,
    checkpoint: {
      schemaVersion: 1,
      runner: "local-relay-effort-experiment/v1",
      status: "completed",
      bundleSha256: "bundle-shared",
      model,
      efforts: [effort],
      plannedRequests: caseIds.length,
      plan,
      results,
    },
    scored: {
      schemaVersion: 1,
      results: scoredResults,
    },
  };
}
