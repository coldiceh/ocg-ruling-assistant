import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateModelEffortMatrix,
  aggregateModelEffortMatrixFiles,
  main,
  parseModelEffortMatrixArguments,
  renderModelEffortMatrixMarkdown,
} from "../scripts/aggregate-model-effort-matrix.mjs";
import { createExperimentResultBinding } from "../scripts/lib/experiment-result-binding.mjs";

const CASE_IDS = ["case-a", "case-b", "case-c", "case-d"];

test("keeps semantic review, auto assertion and hard validation as separate metrics", () => {
  const runs = [
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
  ];
  const semanticReviews = [fixtureSemanticReview(runs, {
    ratings: {
      "case-a::relay-gpt-5.6-sol::low::full": "correct",
      "case-b::relay-gpt-5.6-sol::low::full": "correct",
      "case-c::relay-gpt-5.6-sol::low::full": "partially_correct",
      "case-d::relay-gpt-5.6-sol::low::full": "incorrect",
      "case-a::relay-gpt-5.6-terra::medium::full": "correct",
      "case-b::relay-gpt-5.6-terra::medium::full": "incorrect",
      "case-c::relay-gpt-5.6-terra::medium::full": "partially_correct",
      "case-d::relay-gpt-5.6-terra::medium::full": "correct",
    },
  })];
  const report = aggregateModelEffortMatrix({
    runs,
    semanticReviews,
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
    caseMetadata: {
      cases: CASE_IDS.map((id, index) => ({ id, question: `完整测试问题 ${index + 1}` })),
    },
  });

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.publishable, true);
  assert.equal(report.semanticPublishable, true);
  assert.deepEqual(report.caseIds, CASE_IDS);
  assert.equal(report.evidenceConsistency.canonicalVariant, "full");
  assert.deepEqual(report.evidenceConsistency.canonicalCaseIds, CASE_IDS);
  assert.deepEqual(report.caseCatalog.map((item) => item.label), ["Q1", "Q2", "Q3", "Q4"]);
  assert.equal(report.caseCatalog[0].question, "完整测试问题 1");
  assert.equal(report.evidenceConsistency.bundleSha256, "bundle-shared");
  assert.deepEqual(report.evidenceConsistency.finalInputSha256ByCase, {
    "case-a": ["input-case-a"],
    "case-b": ["input-case-b"],
    "case-c": ["input-case-c"],
    "case-d": ["input-case-d"],
  });

  const sol = report.configurations.find((item) => item.model === "relay-gpt-5.6-sol");
  assert.equal(sol.requestedModel, "relay-gpt-5.6-sol");
  assert.equal(sol.returnedModel, "gpt-5.6-sol");
  assert.deepEqual(
    sol.cases.map((item) => item.semanticReview?.rating),
    ["correct", "correct", "partially_correct", "incorrect"],
  );
  assert.deepEqual(sol.autoAssertion, {
    counts: { PASS: 3, FAIL: 1, INCONCLUSIVE: 0 },
    humanTruth: false,
  });
  assert.deepEqual(sol.autoAssertionAccuracy, {
    numerator: 3,
    denominator: 4,
    rate: 0.75,
    humanTruth: false,
  });
  assert.deepEqual(sol.semanticAccuracy, {
    numerator: 2,
    denominator: 4,
    rate: 0.5,
    determinateReviewCount: 4,
    complete: true,
  });
  assert.deepEqual(sol.reviewCoverage, { numerator: 4, denominator: 4, rate: 1 });
  assert.deepEqual(sol.hardValidationRate, { numerator: 4, denominator: 4, rate: 1 });
  assert.deepEqual(sol.latency.totalMs, { reportedCount: 4, average: 2500, median: 2500 });
  assert.deepEqual(sol.latency.firstContentMs, { reportedCount: 4, average: 250, median: 250 });
  assert.deepEqual(sol.tokens.input, { reportedCount: 4, average: 25, median: 25, sum: 100 });
  assert.deepEqual(sol.tokens.output, { reportedCount: 4, average: 2.5, median: 2.5, sum: 10 });
  assert.deepEqual(sol.tokens.reasoning, { reportedCount: 4, average: 1.5, median: 1.5, sum: 6 });
  assert.deepEqual(sol.tokens.total, { reportedCount: 4, average: 27.5, median: 27.5, sum: 110 });
  assert.deepEqual(sol.failureCounts, {
    timeout: 0,
    empty_response: 0,
    upstream_failure: 0,
    truncated: 0,
    invalid_format: 0,
    other_failure: 0,
  });
  assert.deepEqual(sol.estimatedCost, {
    reportedCaseCount: 4,
    plannedCaseCount: 4,
    complete: true,
    coverageByCurrency: {
      USD: { reportedCaseCount: 4, plannedCaseCount: 4, complete: true },
    },
    totals: { USD: 0.0008 },
    averagesPerReportedCase: { USD: 0.0002 },
    costsPerCorrectAnswer: { USD: 0.0004 },
    sourceFields: ["official_standard_api_list_price"],
    verification: ["official_list_rate_estimate"],
    pricingVersions: ["openai-gpt-5.6-standard-2026-08-10"],
    relayCreditTotal: null,
  });

  const terra = report.configurations.find((item) => item.model === "relay-gpt-5.6-terra");
  assert.deepEqual(terra.semanticAccuracy, {
    numerator: 2,
    denominator: 4,
    rate: 0.5,
    determinateReviewCount: 4,
    complete: true,
  });
  assert.equal(terra.autoAssertion.humanTruth, false);
  assert.deepEqual(terra.hardValidationRate, { numerator: 3, denominator: 4, rate: 0.75 });
  assert.deepEqual(terra.estimatedCost.verification, ["official_list_rate_estimate"]);
  assert.equal(terra.estimatedCost.complete, true);

  assert.equal(report.dashboard.attributionScope, "batch_only");
  assert.equal(report.dashboard.perRequestAllocation, null);
  assert.equal(report.dashboard.batches[0].perRequestAllocation, null);
  assert.equal(report.pricingAssumptions.officialListPrice.currency, "USD");
  assert.equal(report.pricingAssumptions.officialListPrice.pricingVersion, "openai-gpt-5.6-standard-2026-08-10");
  assert.match(report.metricDefinitions.cost, /final-ruling model calls only/u);
  assert.match(report.metricDefinitions.costPerCorrectAnswer, /semantically correct count/u);
  assert.equal(report.autoAssertionAccuracy.humanTruth, false);
  const markdown = renderModelEffortMatrixMarkdown(report);
  assert.match(markdown, /gpt-5\.6-sol/u);
  assert.doesNotMatch(markdown, /relay-gpt/u);
  assert.match(markdown, /\| 请求模型 \| 推理强度 \| 证据方案 \| 严格正确率 \| 部分正确 \|/u);
  assert.match(markdown, /聚合 Token（输入 \/ 输出 \/ 推理 \/ 总计） \| 官方理论费用（USD \/ 约人民币） \| 失败类型汇总/u);
  assert.doesNotMatch(markdown, /Auto|Validator|复核覆盖率|实际返回模型/u);
  assert.match(markdown, /\| gpt-5\.6-sol \| low \| 完整资料 \|/u);
  assert.doesNotMatch(markdown, /Q[1-9][0-9]*|case-[a-d]|完整测试问题|人工:|Codex:/u);
  assert.match(markdown, /2\/4 \(50\.0%\)/u);
  assert.match(markdown, /2\.5 \/ 2\.5 s/u);
  assert.match(markdown, /100 \/ 10 \/ 6 \/ 110/u);
  assert.match(markdown, /USD 0\.0008<br>约 CN¥0\.01/u);
  assert.match(markdown, /2026-08.*1 USD ≈ CN¥6\.8/u);
  assert.doesNotMatch(markdown, /看板实际批次增量|relay pilot|manual screenshot|第三方中转/u);
});

test("marks transport timeout and empty response separately from a wrong ruling", () => {
  const run = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "max",
    caseIds: ["case-a", "case-b"],
    scores: ["INCONCLUSIVE", "INCONCLUSIVE"],
  });
  const [empty, timeout] = run.checkpoint.results;
  empty.status = "error_rejected";
  empty.durationMs = 788_300;
  empty.rawOutput = null;
  empty.error = { code: "relay_empty_final_ruling" };
  delete empty.reportedModel;
  timeout.status = "error_outcome_unknown";
  timeout.durationMs = 900_000;
  timeout.rawOutput = null;
  timeout.error = { code: "relay_stream_timeout" };
  delete timeout.reportedModel;
  for (let index = 0; index < run.scored.results.length; index += 1) {
    run.scored.results[index].sourceBinding = createExperimentResultBinding(
      run.checkpoint.results[index],
    );
  }
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run], {
      kind: "codex",
      ratings: { "case-a": "incorrect", "case-b": "incorrect" },
    })],
    expectedCaseCount: 2,
    generatedAt: "2026-08-09T00:00:00.000Z",
  });

  assert.equal(report.configurations[0].cases[0].failureKind, "empty_response");
  assert.equal(report.configurations[0].cases[1].failureKind, "timeout");
  assert.deepEqual(report.configurations[0].failureCounts, {
    timeout: 1,
    empty_response: 1,
    upstream_failure: 0,
    truncated: 0,
    invalid_format: 0,
    other_failure: 0,
  });
  const zh = renderModelEffortMatrixMarkdown(report, { locale: "zh" });
  assert.match(zh, /超时: 1, 空响应: 1/u);
  assert.doesNotMatch(zh, /case-a|case-b|Codex:/u);
  const en = renderModelEffortMatrixMarkdown(report, { locale: "en" });
  assert.match(en, /Timed out: 1, Empty response: 1/u);
  assert.doesNotMatch(en, /case-a|case-b|Codex:/u);
});

test("keeps DeepSeek reasoning modes distinct while accepting legacy GPT reviews without a mode", () => {
  const standard = fixtureRun({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    effort: "low",
    caseIds: ["private-case"],
  });
  const pro = fixtureRun({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "pro",
    effort: "low",
    caseIds: ["private-case"],
  });
  const deepseekReview = fixtureSemanticReview([standard, pro], {
    kind: "codex",
    ratings: {
      "private-case::deepseek-v4-flash::standard::low::full": "correct",
      "private-case::deepseek-v4-flash::pro::low::full": "incorrect",
    },
  });
  const report = aggregateModelEffortMatrix({
    runs: [standard, pro],
    semanticReviews: [deepseekReview],
    expectedCaseCount: 1,
  });

  assert.equal(report.configurations.length, 2);
  assert.deepEqual(
    report.configurations.map((item) => [item.reasoningMode, item.semanticAccuracy.numerator]),
    [["pro", 0], ["standard", 1]],
  );
  assert.match(standard.checkpoint.plan[0].key, /::standard::low$/u);
  assert.match(pro.checkpoint.plan[0].key, /::pro::low$/u);
  const markdown = renderModelEffortMatrixMarkdown(report, { locale: "en" });
  assert.match(markdown, /\| Requested model \| Reasoning mode \| Reasoning effort \|/u);
  assert.match(markdown, /\| deepseek-v4-flash \| standard \| low \|/u);
  assert.match(markdown, /\| deepseek-v4-flash \| pro \| low \|/u);
  assert.doesNotMatch(markdown, /private-case|Q1|Codex:/u);

  const ambiguousReview = structuredClone(deepseekReview);
  for (const review of ambiguousReview.reviews) delete review.reasoningMode;
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [standard, pro],
      semanticReviews: [ambiguousReview],
      expectedCaseCount: 1,
    }),
    /ambiguous semantic review without reasoningMode/u,
  );

  const gpt = fixtureRun({
    model: "relay-gpt-5.6-sol",
    reasoningMode: "pro",
    effort: "low",
    caseIds: ["legacy-private-case"],
  });
  const legacyReview = fixtureSemanticReview([gpt]);
  delete legacyReview.reviews[0].reasoningMode;
  const legacyReport = aggregateModelEffortMatrix({
    runs: [gpt],
    semanticReviews: [legacyReview],
    expectedCaseCount: 1,
  });
  assert.equal(legacyReport.publishable, true);
  assert.equal(legacyReport.configurations[0].reasoningMode, "pro");
});

test("summarizes DeepSeek upstream, truncation and invalid-format failures anonymously", () => {
  const run = fixtureRun({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningMode: "pro",
    effort: "high",
    caseIds: ["secret-upstream", "secret-truncated", "secret-format"],
    scores: ["INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"],
  });
  const [upstream, truncated, invalidFormat] = run.checkpoint.results;
  upstream.status = "error_rejected";
  upstream.error = { code: "frozen_deepseek_upstream_failed" };
  upstream.rawOutput = null;
  delete upstream.usage;
  truncated.status = "completed_invalid";
  truncated.finishReason = "length";
  invalidFormat.status = "completed_invalid";
  invalidFormat.finishReason = "stop";
  for (let index = 0; index < run.scored.results.length; index += 1) {
    run.scored.results[index].sourceBinding = createExperimentResultBinding(
      run.checkpoint.results[index],
    );
  }
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run], {
      ratings: {
        "secret-upstream": "incorrect",
        "secret-truncated": "incorrect",
        "secret-format": "correct",
      },
    })],
    expectedCaseCount: 3,
  });
  assert.deepEqual(report.configurations[0].failureCounts, {
    timeout: 0,
    empty_response: 0,
    upstream_failure: 1,
    truncated: 1,
    invalid_format: 1,
    other_failure: 0,
  });
  const markdown = renderModelEffortMatrixMarkdown(report, { locale: "en" });
  assert.match(markdown, /Upstream failure: 1, Truncated: 1, Invalid format: 1/u);
  assert.match(markdown, /\(2\/3 metered\)/u);
  assert.doesNotMatch(markdown, /secret-upstream|secret-truncated|secret-format|Q1|Validator|assertion/u);
});

test("official benchmark cost uses displayed token aliases and bills all input as uncached", () => {
  const run = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "low",
    caseIds: ["case-a"],
  });
  run.checkpoint.results[0].usage = {
    prompt_tokens: 10_000,
    completion_tokens: 1_000,
    total_tokens: 11_000,
    prompt_tokens_details: { cached_tokens: 4_000 },
    completion_tokens_details: { reasoning_tokens: 700 },
    input_tokens: 0,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };

  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run])],
    expectedCaseCount: 1,
  });
  const summary = report.configurations[0];

  assert.deepEqual(summary.tokens.input, {
    reportedCount: 1,
    average: 10_000,
    median: 10_000,
    sum: 10_000,
  });
  assert.deepEqual(summary.tokens.output, {
    reportedCount: 1,
    average: 1_000,
    median: 1_000,
    sum: 1_000,
  });
  assert.deepEqual(summary.tokens.reasoning, {
    reportedCount: 1,
    average: 700,
    median: 700,
    sum: 700,
  });
  assert.deepEqual(summary.estimatedCost, {
    reportedCaseCount: 1,
    plannedCaseCount: 1,
    complete: true,
    coverageByCurrency: {
      USD: { reportedCaseCount: 1, plannedCaseCount: 1, complete: true },
    },
    totals: { USD: 0.08 },
    averagesPerReportedCase: { USD: 0.08 },
    costsPerCorrectAnswer: { USD: 0.08 },
    sourceFields: ["official_standard_api_list_price"],
    verification: ["official_list_rate_estimate"],
    pricingVersions: ["openai-gpt-5.6-standard-2026-08-10"],
    relayCreditTotal: null,
  });
});

test("different evidence variants may use distinct input hashes and planned case subsets", () => {
  const full = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "low",
    evidenceVariant: "full",
  });
  const cardTextOnly = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "low",
    evidenceVariant: "card_text_only",
    scores: ["PASS", "FAIL", "PASS", "PASS"],
  });
  const withoutLua = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "low",
    evidenceVariant: "without_lua",
    caseIds: CASE_IDS.slice(0, 2),
    scores: ["PASS", "FAIL"],
  });
  const runs = [full, cardTextOnly, withoutLua];
  const report = aggregateModelEffortMatrix({
    runs,
    semanticReviews: [fixtureSemanticReview(runs, {
      kind: "codex",
      ratings: {
        "case-b::relay-gpt-5.6-sol::low::without_lua": "incorrect",
      },
    })],
    expectedCaseCount: 4,
    generatedAt: "2026-08-08T00:00:00.000Z",
  });

  assert.equal(report.publishable, true);
  assert.deepEqual(report.caseIds, CASE_IDS);
  assert.deepEqual(report.evidenceConsistency.plannedCaseIdsByVariant, {
    full: CASE_IDS,
    card_text_only: CASE_IDS,
    without_lua: CASE_IDS.slice(0, 2),
  });
  assert.deepEqual(report.evidenceConsistency.finalInputSha256ByCase, {
    "case-a": ["input-case-a"],
    "case-b": ["input-case-b"],
    "case-c": ["input-case-c"],
    "case-d": ["input-case-d"],
  });
  assert.deepEqual(report.evidenceConsistency.finalInputSha256ByVariant.without_lua, {
    "case-a": ["input-without_lua-case-a"],
    "case-b": ["input-without_lua-case-b"],
  });

  const withoutLuaSummary = report.configurations.find((item) => (
    item.evidenceVariant === "without_lua"
  ));
  assert.deepEqual(withoutLuaSummary.plannedCaseIds, CASE_IDS.slice(0, 2));
  assert.deepEqual(
    withoutLuaSummary.cases.map((item) => item.semanticReview?.rating || null),
    ["correct", "incorrect", null, null],
  );
  assert.deepEqual(
    withoutLuaSummary.cases.map((item) => item.planned),
    [true, true, false, false],
  );
  assert.deepEqual(withoutLuaSummary.semanticAccuracy, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
    determinateReviewCount: 2,
    complete: true,
  });
  assert.equal(withoutLuaSummary.estimatedCost.plannedCaseCount, 2);

  const zh = renderModelEffortMatrixMarkdown(report, { locale: "zh" });
  assert.match(zh, /\| 请求模型 \| 推理强度 \| 证据方案 \|/u);
  assert.match(zh, /\| 仅卡文 \|/u);
  assert.doesNotMatch(zh, /Lua|case-a|case-b|Q1|Codex:/u);

  const en = renderModelEffortMatrixMarkdown(report, { locale: "en" });
  assert.match(en, /^# Model and reasoning-effort evaluation matrix/mu);
  assert.match(en, /\| Requested model \| Reasoning effort \| Evidence variant \|/u);
  assert.match(en, /\| gpt-5\.6-sol \| low \| Full evidence \|/u);
  assert.match(en, /\| Card text only \|/u);
  assert.doesNotMatch(en, /Lua|case-a|case-b|Q1|Codex:|CN¥|¥/u);

  const ja = renderModelEffortMatrixMarkdown(report, { locale: "ja" });
  assert.match(ja, /^# モデル・推論強度評価マトリクス/mu);
  assert.match(ja, /\| リクエストモデル \| 推論強度 \| 証拠構成 \|/u);
  assert.match(ja, /\| gpt-5\.6-sol \| low \| 完全な証拠 \|/u);
  assert.match(ja, /\| カードテキストのみ \|/u);
  assert.match(ja, /USD 0\.0008<br>約 ¥0/u);
  assert.match(ja, /2026-08.*1 USD ≈ ¥158\.4/u);
  assert.doesNotMatch(ja, /Lua|case-a|case-b|Q1|Codex:/u);
  assert.throws(
    () => renderModelEffortMatrixMarkdown(report, { locale: "fr" }),
    /unsupported Markdown locale/u,
  );
});

test("missing semantic reviews produce diagnostics and can never publish auto assertions as accuracy", () => {
  const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const report = aggregateModelEffortMatrix({ runs: [run], expectedCaseCount: 4 });
  const summary = report.configurations[0];

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.publishable, false);
  assert.equal(report.semanticPublishable, false);
  assert.equal(summary.semanticPublishable, false);
  assert.deepEqual(summary.semanticAccuracy, {
    numerator: 0,
    denominator: 4,
    rate: null,
    determinateReviewCount: 0,
    complete: false,
  });
  assert.deepEqual(summary.reviewCoverage, { numerator: 0, denominator: 4, rate: 0 });
  assert.equal(summary.autoAssertionAccuracy.rate, 1);
  assert.equal(summary.autoAssertionAccuracy.humanTruth, false);
  assert.equal(summary.estimatedCost.costsPerCorrectAnswer, null);
  assert.match(report.semanticReview.diagnostics.join("\n"), /4 planned result\(s\) have no semantic review/u);
  assert.match(renderModelEffortMatrixMarkdown(report), /0\/4 \(n\/a; 0\/4\)/u);
  assert.doesNotMatch(renderModelEffortMatrixMarkdown(report), /未复核|case-a|Q1/u);
});

test("semantic reviews bind to the exact result and human review takes precedence over Codex", () => {
  const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const codex = fixtureSemanticReview([run], {
    kind: "codex",
    ratings: { "case-a": "incorrect" },
  });
  const human = fixtureSemanticReview([run], {
    kind: "human",
    ratings: { "case-a": "correct" },
  });
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [codex, human],
    expectedCaseCount: 4,
  });
  assert.equal(report.publishable, true);
  assert.equal(report.semanticReview.selectedHumanCount, 4);
  assert.equal(report.semanticReview.selectedCodexCount, 0);
  assert.equal(report.configurations[0].cases[0].semanticReview.rating, "correct");
  assert.equal(report.configurations[0].cases[0].semanticReview.reviewer.kind, "human");

  for (const [field, wrongValue, pattern] of [
    ["resultKey", "wrong-result-key", /semantic review resultKey binding mismatch/u],
    ["requestId", "must-not-match-null", /semantic review requestId binding mismatch/u],
    ["finalInputSha256", "wrong-input", /semantic review finalInputSha256 binding mismatch/u],
    ["rawOutputSha256", "wrong-output", /semantic review rawOutputSha256 binding mismatch/u],
  ]) {
    const mismatched = fixtureSemanticReview([run]);
    mismatched.reviews[0][field] = wrongValue;
    assert.throws(
      () => aggregateModelEffortMatrix({
        runs: [run],
        semanticReviews: [mismatched],
        expectedCaseCount: 4,
      }),
      pattern,
    );
  }

  const orphan = fixtureSemanticReview([run]);
  orphan.reviews[0].caseId = "orphan-case";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [run], semanticReviews: [orphan], expectedCaseCount: 4 }),
    /orphan semantic review/u,
  );
});

test("duplicate and conflicting reviews at the same precedence level fail closed", () => {
  const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const first = fixtureSemanticReview([run], { kind: "codex" });
  const duplicate = structuredClone(first);
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [run],
      semanticReviews: [first, duplicate],
      expectedCaseCount: 4,
    }),
    /duplicate semantic review at codex level/u,
  );

  const conflicting = structuredClone(first);
  conflicting.reviews[0].rating = "incorrect";
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [run],
      semanticReviews: [first, conflicting],
      expectedCaseCount: 4,
    }),
    /conflicting semantic reviews at codex level/u,
  );
});

test("hardValidity takes precedence and validatedResult is labeled only as a legacy combined validator", () => {
  const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  run.checkpoint.results[0].hardValidity = { ok: false, errors: ["hard failure"] };
  run.checkpoint.results[0].validatedResult = { ok: true, errors: [] };
  delete run.checkpoint.results[1].hardValidity;
  run.checkpoint.results[1].validatedResult = { ok: true, errors: [] };
  delete run.checkpoint.results[2].hardValidity;
  delete run.checkpoint.results[2].validatedResult;
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run])],
    expectedCaseCount: 4,
  });
  const cases = report.configurations[0].cases;
  assert.deepEqual(cases.slice(0, 3).map((item) => item.hardValidation.source), [
    "hard_validity",
    "legacy_combined_validator",
    "unavailable",
  ]);
  assert.deepEqual(cases.slice(0, 3).map((item) => item.hardValidation.status), [
    "FAIL",
    "UNAVAILABLE",
    "UNAVAILABLE",
  ]);
  assert.equal(cases[1].hardValidation.ok, true);
  assert.equal(cases[1].hardValidation.legacyStatus, "PASS");
  assert.deepEqual(report.configurations[0].hardValidationRate, {
    numerator: 1,
    denominator: 4,
    rate: 0.25,
  });
  assert.equal(report.configurations[0].hardValidation.semanticTruth, false);
});

test("the aggregator recomputes raw output hashes instead of trusting the scored report", () => {
  const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  run.scored.results[0].sourceBinding = {
    ...run.scored.results[0].sourceBinding,
    rawOutputSha256: "tampered-output-hash",
  };
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [run], expectedCaseCount: 4 }),
    /sourceBinding rawOutputSha256 mismatch/u,
  );
});

test("empty checkpoint results or an explicitly empty plan fail closed", () => {
  const emptyResults = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  emptyResults.checkpoint.results = [];
  emptyResults.scored.results = [];
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [emptyResults], expectedCaseCount: 4 }),
    /checkpoint\.results must not be empty/u,
  );

  const emptyPlan = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  emptyPlan.checkpoint.plan = [];
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [emptyPlan], expectedCaseCount: 4 }),
    /checkpoint\.plan must not be empty/u,
  );
});

test("Direct Relay checkpoints require completed status and an exact planned request count", () => {
  const missingStatus = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  delete missingStatus.checkpoint.status;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missingStatus], expectedCaseCount: 4 }),
    /Direct Relay checkpoint status must be completed/u,
  );

  const truncated = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  truncated.checkpoint.plannedRequests = 3;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [truncated], expectedCaseCount: 4 }),
    /plannedRequests 3 does not match plan\/results 4\/4/u,
  );

  const missingPlannedRequests = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  delete missingPlannedRequests.checkpoint.plannedRequests;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missingPlannedRequests], expectedCaseCount: 4 }),
    /Direct Relay plannedRequests is required/u,
  );

  const missingPlan = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  delete missingPlan.checkpoint.plan;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missingPlan], expectedCaseCount: 4 }),
    /Direct Relay checkpoint\.plan must be a non-empty array/u,
  );

  const nonArrayPlan = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  nonArrayPlan.checkpoint.plan = { reconstructed: true };
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [nonArrayPlan], expectedCaseCount: 4 }),
    /Direct Relay checkpoint\.plan must be a non-empty array/u,
  );
});

test("Direct Relay checkpoints satisfy the minimal deterministic schema contract", () => {
  const cases = [
    {
      name: "schema version",
      mutate(run) { run.checkpoint.schemaVersion = 2; },
      error: /schemaVersion must be 1/u,
    },
    {
      name: "non-empty case IDs",
      mutate(run) { run.checkpoint.caseIds = []; },
      error: /caseIds must be a non-empty array/u,
    },
    {
      name: "unique efforts",
      mutate(run) { run.checkpoint.efforts.push(run.checkpoint.efforts[0]); },
      error: /efforts must contain unique values/u,
    },
    {
      name: "single concurrency",
      mutate(run) { run.checkpoint.concurrency = 2; },
      error: /concurrency must be 1/u,
    },
    {
      name: "zero retries",
      mutate(run) { run.checkpoint.retries = 1; },
      error: /retries must be 0/u,
    },
    {
      name: "complete Cartesian plan",
      mutate(run) {
        run.checkpoint.plan.pop();
        run.checkpoint.results.pop();
        run.scored.results.pop();
        run.checkpoint.plannedRequests = 3;
      },
      error: /checkpoint\.plan must equal caseIds × efforts/u,
    },
    {
      name: "plan model",
      mutate(run) { run.checkpoint.plan[0].model = "relay-gpt-5.6-terra"; },
      error: /plan\[0\] model must match checkpoint\.model/u,
    },
    {
      name: "result variant",
      mutate(run) { run.checkpoint.results[0].evidenceVariant = "without_lua"; },
      error: /result\[0\] evidenceVariant must match checkpoint\.evidenceVariant/u,
    },
    {
      name: "deterministic plan key",
      mutate(run) { run.checkpoint.plan[0].key = "wrong-plan-key"; },
      error: /plan\[0\]\.key must be/u,
    },
    {
      name: "deterministic result key",
      mutate(run) { run.checkpoint.results[0].key = "wrong-result-key"; },
      error: /result\[0\]\.key must be/u,
    },
  ];
  for (const entry of cases) {
    const run = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
    entry.mutate(run);
    assert.throws(
      () => aggregateModelEffortMatrix({ runs: [run], expectedCaseCount: 4 }),
      entry.error,
      entry.name,
    );
  }

  const v2 = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  v2.checkpoint.runner = "local-relay-effort-experiment/v2";
  assert.equal(aggregateModelEffortMatrix({
    runs: [v2],
    semanticReviews: [fixtureSemanticReview([v2])],
    expectedCaseCount: 4,
  }).publishable, true);

  const legacyGptMode = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  for (const result of legacyGptMode.checkpoint.results) result.reasoningMode = "pro";
  for (const score of legacyGptMode.scored.results) score.reasoningMode = "pro";
  const legacyGptModeReview = fixtureSemanticReview([legacyGptMode]);
  for (const review of legacyGptModeReview.reviews) delete review.reasoningMode;
  const legacyGptModeReport = aggregateModelEffortMatrix({
    runs: [legacyGptMode],
    semanticReviews: [legacyGptModeReview],
    expectedCaseCount: 4,
  });
  assert.equal(legacyGptModeReport.configurations[0].reasoningMode, null);
});

test("Direct Relay v2 publication requires every checkpoint to share a non-empty bundle hash", () => {
  const missing = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  delete missing.checkpoint.bundleSha256;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missing], expectedCaseCount: 4 }),
    /Direct Relay v2 requires bundleSha256 for every Direct Relay checkpoint/u,
  );
  const diagnostic = aggregateModelEffortMatrix({
    runs: [missing],
    semanticReviews: [fixtureSemanticReview([missing])],
    expectedCaseCount: 4,
    strictEvidence: false,
  });
  assert.equal(diagnostic.evidenceConsistency.valid, false);
  assert.equal(diagnostic.publishable, false);
  assert.match(diagnostic.evidenceConsistency.errors.join("\n"), /missing run\(s\): 1/u);

  const complete = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const partial = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "medium" });
  delete partial.checkpoint.bundleSha256;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [complete, partial], expectedCaseCount: 4 }),
    /missing run\(s\): 2/u,
  );

  const legacy = fixtureRun({ model: "deepseek-v4-flash", effort: "pro" });
  legacy.checkpoint.runner = "legacy-offline-experiment/v1";
  delete legacy.checkpoint.bundleSha256;
  const legacyReport = aggregateModelEffortMatrix({
    runs: [legacy],
    semanticReviews: [fixtureSemanticReview([legacy])],
    expectedCaseCount: 4,
  });
  assert.equal(legacyReport.publishable, true);
  assert.match(legacyReport.evidenceConsistency.warnings.join("\n"), /unavailable for every checkpoint/u);
});

test("mixed Direct and legacy runs only enforce bundle completeness on Direct checkpoints", () => {
  const direct = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const legacy = fixtureRun({ model: "deepseek-v4-flash", effort: "pro" });
  legacy.checkpoint.runner = "legacy-offline-experiment/v1";
  delete legacy.checkpoint.bundleSha256;
  const runs = [direct, legacy];
  const report = aggregateModelEffortMatrix({
    runs,
    semanticReviews: [fixtureSemanticReview(runs)],
    expectedCaseCount: 4,
  });
  assert.equal(report.publishable, true);
  assert.equal(report.evidenceConsistency.bundleSha256, "bundle-shared");
  assert.deepEqual(report.evidenceConsistency.observedDirectRelayBundleSha256, ["bundle-shared"]);
  assert.match(report.evidenceConsistency.warnings.join("\n"), /legacy checkpoints; run\(s\): 2/u);
  assert.doesNotMatch(report.evidenceConsistency.errors.join("\n"), /missing run/u);
});

test("returned model identity is required, alias-bounded, source-consistent and stable per configuration", () => {
  const exact = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  for (let index = 0; index < exact.checkpoint.results.length; index += 1) {
    exact.checkpoint.results[index].reportedModel = "relay-gpt-5.6-sol";
    exact.scored.results[index].returnedModel = "relay-gpt-5.6-sol";
  }
  assert.equal(aggregateModelEffortMatrix({
    runs: [exact],
    semanticReviews: [fixtureSemanticReview([exact])],
    expectedCaseCount: 4,
  }).publishable, true);

  const missingCheckpointIdentity = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  delete missingCheckpointIdentity.checkpoint.results[0].reportedModel;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missingCheckpointIdentity], expectedCaseCount: 4 }),
    /Direct Relay checkpoint returnedModel was unavailable/u,
  );

  const wrongModel = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  wrongModel.checkpoint.results[0].reportedModel = "gpt-5.6-terra";
  wrongModel.scored.results[0].returnedModel = "gpt-5.6-terra";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [wrongModel], expectedCaseCount: 4 }),
    /returnedModel mismatch: requested relay-gpt-5\.6-sol, returned gpt-5\.6-terra/u,
  );

  const reverseAlias = fixtureRun({ model: "gpt-5.6-sol", effort: "low" });
  reverseAlias.checkpoint.results[0].reportedModel = "relay-gpt-5.6-sol";
  reverseAlias.scored.results[0].returnedModel = "relay-gpt-5.6-sol";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [reverseAlias], expectedCaseCount: 4 }),
    /returnedModel mismatch: requested gpt-5\.6-sol, returned relay-gpt-5\.6-sol/u,
  );

  const sourceConflict = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  sourceConflict.scored.results[0].returnedModel = "gpt-5.6-terra";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [sourceConflict], expectedCaseCount: 4 }),
    /returnedModel source mismatch/u,
  );

  const unstable = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  unstable.checkpoint.results[0].reportedModel = "relay-gpt-5.6-sol";
  unstable.scored.results[0].returnedModel = "relay-gpt-5.6-sol";
  const unstableReport = aggregateModelEffortMatrix({
    runs: [unstable],
    semanticReviews: [fixtureSemanticReview([unstable])],
    expectedCaseCount: 4,
    strictEvidence: false,
  });
  assert.equal(unstableReport.publishable, false);
  assert.match(
    unstableReport.evidenceConsistency.errors.join("\n"),
    /returnedModel is inconsistent within configuration/u,
  );
  assert.deepEqual(unstableReport.configurations[0].observedReturnedModels, [
    "gpt-5.6-sol",
    "relay-gpt-5.6-sol",
  ]);

  const duplicateA = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const duplicateB = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  for (let index = 0; index < duplicateB.checkpoint.results.length; index += 1) {
    duplicateB.checkpoint.results[index].reportedModel = "relay-gpt-5.6-sol";
    duplicateB.scored.results[index].returnedModel = "relay-gpt-5.6-sol";
  }
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [duplicateA, duplicateB], expectedCaseCount: 4 }),
    /conflicting duplicate experiment record/u,
  );
});

test("legacy returned-model gaps and aliases are warnings rather than publication blockers", () => {
  const missing = fixtureRun({ model: "legacy-model", effort: "low" });
  missing.checkpoint.runner = "legacy-offline-experiment/v1";
  for (let index = 0; index < missing.checkpoint.results.length; index += 1) {
    delete missing.checkpoint.results[index].reportedModel;
    missing.scored.results[index].returnedModel = null;
  }
  const missingReport = aggregateModelEffortMatrix({
    runs: [missing],
    semanticReviews: [fixtureSemanticReview([missing])],
    expectedCaseCount: 4,
  });
  assert.equal(missingReport.publishable, true);
  assert.match(missingReport.evidenceConsistency.warnings.join("\n"), /returnedModel was unavailable/u);
  assert.doesNotMatch(renderModelEffortMatrixMarkdown(missingReport), /未返回|returnedModel/u);

  const alias = fixtureRun({ model: "legacy-model", effort: "medium" });
  alias.checkpoint.runner = "legacy-offline-experiment/v1";
  for (let index = 0; index < alias.checkpoint.results.length; index += 1) {
    alias.checkpoint.results[index].reportedModel = "provider-renamed-model";
    alias.scored.results[index].returnedModel = "provider-renamed-model";
  }
  alias.scored.results[0].returnedModel = "scored-only-alias";
  const aliasReport = aggregateModelEffortMatrix({
    runs: [alias],
    semanticReviews: [fixtureSemanticReview([alias])],
    expectedCaseCount: 4,
  });
  assert.equal(aliasReport.publishable, true);
  assert.match(aliasReport.evidenceConsistency.warnings.join("\n"), /returnedModel mismatch/u);
  assert.match(aliasReport.evidenceConsistency.warnings.join("\n"), /returnedModel source mismatch/u);
});

test("Direct Relay rejects non-terminal results but accepts terminal transport errors without a returned model", () => {
  for (const status of ["running", "unknown_terminal"] ) {
    const unfinished = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
    unfinished.checkpoint.results[0].status = status;
    assert.throws(
      () => aggregateModelEffortMatrix({ runs: [unfinished], expectedCaseCount: 4 }),
      /Direct Relay result\[0\]\.status must be terminal/u,
    );
  }

  const terminalErrors = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "low",
    scores: ["INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"],
  });
  for (let index = 0; index < terminalErrors.checkpoint.results.length; index += 1) {
    terminalErrors.checkpoint.results[index].status = index % 2 === 0
      ? "error_rejected"
      : "error_outcome_unknown";
    delete terminalErrors.checkpoint.results[index].reportedModel;
    terminalErrors.scored.results[index].returnedModel = null;
  }
  const report = aggregateModelEffortMatrix({
    runs: [terminalErrors],
    semanticReviews: [fixtureSemanticReview([terminalErrors], {
      ratings: Object.fromEntries(CASE_IDS.map((caseId) => [caseId, "incorrect"])),
    })],
    expectedCaseCount: 4,
  });
  assert.equal(report.publishable, true);
  assert.equal(report.configurations[0].missingReturnedModelCount, 4);
  assert.deepEqual(report.configurations[0].cases.map((item) => item.rawStatus), [
    "error_rejected",
    "error_outcome_unknown",
    "error_rejected",
    "error_outcome_unknown",
  ]);
  assert.match(report.evidenceConsistency.warnings.join("\n"), /returnedModel was not returned/u);
  assert.match(renderModelEffortMatrixMarkdown(report), /其他失败: 4/u);
  assert.doesNotMatch(renderModelEffortMatrixMarkdown(report), /未返回|case-a|Q1/u);
});

test("strict aggregation rejects crossed keys, duplicate plans, missing or orphan records, and invalid scored success", () => {
  const crossedKey = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  crossedKey.checkpoint.runner = "legacy-offline-experiment/v1";
  crossedKey.checkpoint.plan[0].key = crossedKey.checkpoint.results[1].key;
  crossedKey.checkpoint.plan[1].key = "unique-fallback-key";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [crossedKey], expectedCaseCount: 4 }),
    /checkpoint plan key identity mismatch/u,
  );

  const duplicatePlan = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  duplicatePlan.checkpoint.runner = "legacy-offline-experiment/v1";
  duplicatePlan.checkpoint.plan.push({ ...duplicatePlan.checkpoint.plan[0] });
  delete duplicatePlan.checkpoint.plannedRequests;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [duplicatePlan], expectedCaseCount: 4 }),
    /duplicate checkpoint plan identity/u,
  );

  const duplicatePlanKey = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  duplicatePlanKey.checkpoint.runner = "legacy-offline-experiment/v1";
  duplicatePlanKey.checkpoint.plan[1].key = duplicatePlanKey.checkpoint.plan[0].key;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [duplicatePlanKey], expectedCaseCount: 4 }),
    /duplicate checkpoint plan key/u,
  );

  const missingResult = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  missingResult.checkpoint.runner = "legacy-offline-experiment/v1";
  missingResult.checkpoint.results.shift();
  delete missingResult.checkpoint.plannedRequests;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missingResult], expectedCaseCount: 4 }),
    /checkpoint plan is missing result/u,
  );

  const orphanResult = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  orphanResult.checkpoint.runner = "legacy-offline-experiment/v1";
  orphanResult.checkpoint.results.push({
    ...orphanResult.checkpoint.results[0],
    key: "orphan-case::relay-gpt-5.6-sol::low",
    caseId: "orphan-case",
    finalInputSha256: "input-orphan-case",
  });
  delete orphanResult.checkpoint.plannedRequests;
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [orphanResult], expectedCaseCount: 4 }),
    /orphan checkpoint result/u,
  );

  const missingScore = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  missingScore.scored.results.shift();
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [missingScore], expectedCaseCount: 4 }),
    /checkpoint plan is missing score/u,
  );

  const orphanScore = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  orphanScore.scored.results.push({
    ...orphanScore.scored.results[0],
    caseId: "orphan-case",
  });
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [orphanScore], expectedCaseCount: 4 }),
    /orphan scored result/u,
  );

  const invalidPass = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  invalidPass.checkpoint.results[0].status = "completed_invalid";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [invalidPass], expectedCaseCount: 4 }),
    /scored PASS requires completed_valid result/u,
  );

  const invalidFail = fixtureRun({
    model: "relay-gpt-5.6-sol",
    effort: "low",
    scores: ["FAIL", "PASS", "PASS", "PASS"],
  });
  invalidFail.checkpoint.results[0].status = "completed_invalid";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [invalidFail], expectedCaseCount: 4 }),
    /scored FAIL requires completed_valid result/u,
  );
});

test("the evidence mismatch override never relaxes run integrity checks", () => {
  const invalidPass = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  invalidPass.checkpoint.results[0].status = "completed_invalid";
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [invalidPass],
      expectedCaseCount: 4,
      strictEvidence: false,
    }),
    /scored PASS requires completed_valid result/u,
  );

  const missingResult = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  missingResult.checkpoint.runner = "legacy-offline-experiment/v1";
  missingResult.checkpoint.results.shift();
  delete missingResult.checkpoint.plannedRequests;
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [missingResult],
      expectedCaseCount: 4,
      strictEvidence: false,
    }),
    /checkpoint plan is missing result/u,
  );

  const orphanResult = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  orphanResult.checkpoint.runner = "legacy-offline-experiment/v1";
  orphanResult.checkpoint.results.push({
    ...orphanResult.checkpoint.results[0],
    key: "orphan-case::relay-gpt-5.6-sol::low",
    caseId: "orphan-case",
    finalInputSha256: "input-orphan-case",
  });
  delete orphanResult.checkpoint.plannedRequests;
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [orphanResult],
      expectedCaseCount: 4,
      strictEvidence: false,
    }),
    /orphan checkpoint result/u,
  );

  const orphanScore = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  orphanScore.scored.results.push({
    ...orphanScore.scored.results[0],
    caseId: "orphan-case",
  });
  assert.throws(
    () => aggregateModelEffortMatrix({
      runs: [orphanScore],
      expectedCaseCount: 4,
      strictEvidence: false,
    }),
    /orphan scored result/u,
  );
});

test("canonical case selection prefers full, otherwise the deterministic largest variant", () => {
  const noFull = aggregateModelEffortMatrix({
    runs: [
      fixtureRun({
        model: "relay-gpt-5.6-sol",
        effort: "low",
        evidenceVariant: "card_text_only",
        caseIds: CASE_IDS,
      }),
      fixtureRun({
        model: "relay-gpt-5.6-sol",
        effort: "low",
        evidenceVariant: "without_lua",
        caseIds: CASE_IDS.slice(0, 2),
      }),
    ],
    expectedCaseCount: 4,
  });
  assert.equal(noFull.evidenceConsistency.canonicalVariant, "card_text_only");
  assert.deepEqual(noFull.caseIds, CASE_IDS);

  const tie = aggregateModelEffortMatrix({
    runs: [
      fixtureRun({
        model: "relay-gpt-5.6-sol",
        effort: "low",
        evidenceVariant: "without_lua",
        caseIds: CASE_IDS.slice(0, 2),
      }),
      fixtureRun({
        model: "relay-gpt-5.6-sol",
        effort: "low",
        evidenceVariant: "card_text_only",
        caseIds: CASE_IDS.slice(0, 2),
      }),
    ],
    expectedCaseCount: 2,
  });
  assert.equal(tie.evidenceConsistency.canonicalVariant, "card_text_only");

  const unionMask = [
    fixtureRun({
      model: "relay-gpt-5.6-sol",
      effort: "low",
      evidenceVariant: "card_text_only",
      caseIds: CASE_IDS.slice(0, 2),
    }),
    fixtureRun({
      model: "relay-gpt-5.6-sol",
      effort: "low",
      evidenceVariant: "without_lua",
      caseIds: CASE_IDS.slice(2),
    }),
  ];
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: unionMask, expectedCaseCount: 4 }),
    /expected 4 canonical planned cases, found 2/u,
  );

  const outsideFull = [
    fixtureRun({
      model: "relay-gpt-5.6-sol",
      effort: "low",
      caseIds: CASE_IDS.slice(0, 2),
    }),
    fixtureRun({
      model: "relay-gpt-5.6-sol",
      effort: "low",
      evidenceVariant: "without_lua",
      caseIds: [CASE_IDS[0], CASE_IDS[2]],
    }),
  ];
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: outsideFull, expectedCaseCount: 2 }),
    /is not a subset of canonical full/u,
  );
});

test("strict evidence validation rejects bundle, per-case input and planned-case mismatches", () => {
  const first = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const planHashMismatch = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "low" });
  planHashMismatch.checkpoint.results[0].finalInputSha256 = "different-input";
  planHashMismatch.scored.results[0].sourceBinding = createExperimentResultBinding(
    planHashMismatch.checkpoint.results[0],
  );
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [planHashMismatch], expectedCaseCount: 4 }),
    /checkpoint plan finalInputSha256 mismatch/u,
  );

  const bundleMismatch = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "low" });
  bundleMismatch.checkpoint.bundleSha256 = "different-bundle";
  assert.throws(
    () => aggregateModelEffortMatrix({ runs: [first, bundleMismatch], expectedCaseCount: 4 }),
    /bundleSha256 mismatch/u,
  );

  const inputMismatch = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "low" });
  inputMismatch.checkpoint.plan[0].finalInputSha256 = "different-input";
  inputMismatch.checkpoint.results[0].finalInputSha256 = "different-input";
  inputMismatch.scored.results[0].sourceBinding = createExperimentResultBinding(
    inputMismatch.checkpoint.results[0],
  );
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
  second.checkpoint.plan[2].finalInputSha256 = "different-case-c-input";
  second.checkpoint.results[2].finalInputSha256 = "different-case-c-input";
  second.scored.results[2].sourceBinding = createExperimentResultBinding(
    second.checkpoint.results[2],
  );

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

test("legacy missing optional bundle and metrics remain null instead of becoming zero", () => {
  const run = fixtureRun({ model: "deepseek-v4-flash", effort: "pro" });
  run.checkpoint.runner = "legacy-offline-experiment/v1";
  delete run.checkpoint.bundleSha256;
  for (const result of run.checkpoint.results) {
    delete result.durationMs;
    delete result.sseTiming;
    delete result.usage;
  }
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run])],
    expectedCaseCount: 4,
  });
  const summary = report.configurations[0];
  assert.equal(report.publishable, true);
  assert.ok(report.evidenceConsistency.warnings.length >= 1);
  assert.deepEqual(summary.latency.totalMs, { reportedCount: 0, average: null, median: null });
  assert.deepEqual(summary.latency.firstContentMs, { reportedCount: 0, average: null, median: null });
  assert.deepEqual(summary.tokens.input, { reportedCount: 0, average: null, median: null, sum: null });
  assert.equal(summary.estimatedCost, null);
});

test("DeepSeek uses the versioned official list price instead of run-specific billing", () => {
  const run = fixtureRun({
    model: "deepseek-v4-pro",
    effort: "high",
    estimatedCostCny: [0.01, 0.02, 0.03, 0.04],
  });
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run])],
    expectedCaseCount: 4,
  });
  assert.deepEqual(report.configurations[0].estimatedCost, {
    reportedCaseCount: 4,
    plannedCaseCount: 4,
    complete: true,
    coverageByCurrency: {
      USD: { reportedCaseCount: 4, plannedCaseCount: 4, complete: true },
    },
    totals: { USD: 0.0000522 },
    averagesPerReportedCase: { USD: 0.00001305 },
    costsPerCorrectAnswer: { USD: 0.00001305 },
    sourceFields: ["official_deepseek_api_list_price"],
    verification: ["official_list_rate_estimate"],
    pricingVersions: ["deepseek-v4-standard-2026-08-10"],
    relayCreditTotal: null,
  });
});

test("mixed-currency cost coverage is calculated independently per currency", () => {
  const run = fixtureRun({
    model: "glm-5.2",
    effort: "high",
    estimatedCostCny: [0.01, 0.02, 0.03, 0.04],
  });
  run.checkpoint.results[0].estimatedCostUsd = 0.1;
  run.checkpoint.results[1].estimatedCostUsd = 0.2;
  const report = aggregateModelEffortMatrix({
    runs: [run],
    semanticReviews: [fixtureSemanticReview([run])],
    expectedCaseCount: 4,
  });
  const cost = report.configurations[0].estimatedCost;
  assert.equal(cost.reportedCaseCount, 4);
  assert.equal(cost.complete, false);
  assert.deepEqual(cost.coverageByCurrency, {
    CNY: { reportedCaseCount: 4, plannedCaseCount: 4, complete: true },
    USD: { reportedCaseCount: 2, plannedCaseCount: 4, complete: false },
  });
  assert.deepEqual(cost.averagesPerReportedCase, { CNY: 0.025, USD: 0.15 });
  assert.deepEqual(cost.costsPerCorrectAnswer, { CNY: 0.025 });
  const markdown = renderModelEffortMatrixMarkdown(report, { locale: "en" });
  assert.match(markdown, /\| — \| — \|$/mu);
  assert.doesNotMatch(markdown, /CNY|per-currency coverage|0\.025|0\.15/u);
});

test("file loader and CLI parser accept repeated checkpoint/scored pairs without network access", async () => {
  const runA = fixtureRun({ model: "relay-gpt-5.6-sol", effort: "low" });
  const runB = fixtureRun({ model: "relay-gpt-5.6-terra", effort: "medium" });
  const codexReview = fixtureSemanticReview([runA, runB], { kind: "codex" });
  const humanReview = fixtureSemanticReview([runA], { kind: "human" });
  const files = new Map([
    ["checkpoint-a.json", JSON.stringify(runA.checkpoint)],
    ["scored-a.json", JSON.stringify(runA.scored)],
    ["checkpoint-b.json", JSON.stringify(runB.checkpoint)],
    ["scored-b.json", JSON.stringify(runB.scored)],
    ["review-codex.json", JSON.stringify(codexReview)],
    ["review-human.json", JSON.stringify(humanReview)],
    ["dashboard.json", JSON.stringify({ batches: [{ label: "one batch", delta: 1 }] })],
    ["cases.json", JSON.stringify({ cases: CASE_IDS.map((id) => ({ id, question: `${id} question` })) })],
  ]);
  const report = await aggregateModelEffortMatrixFiles({
    pairs: [
      { checkpointFile: "checkpoint-a.json", scoredFile: "scored-a.json" },
      { checkpointFile: "checkpoint-b.json", scoredFile: "scored-b.json" },
    ],
    semanticReviewFiles: ["review-codex.json", "review-human.json"],
    dashboardMetadataFile: "dashboard.json",
    caseMetadataFile: "cases.json",
    expectedCaseCount: 4,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    readFileImpl: async (pathname) => {
      assert.equal(files.has(String(pathname)), true);
      return files.get(String(pathname));
    },
  });
  assert.equal(report.generatedAt, "2026-08-08T00:00:00.000Z");
  assert.equal(report.configurations.length, 2);
  assert.equal(report.semanticReview.selectedHumanCount, 4);
  assert.equal(report.semanticReview.selectedCodexCount, 4);
  assert.equal(report.semanticPublishable, true);

  const parsed = parseModelEffortMatrixArguments([
    "--pair", "a.json", "a-scored.json",
    "--checkpoint", "b.json",
    "--scored", "b-scored.json",
    "--semantic-review", "review-a.json",
    "--semantic-review", "review-b.json",
    "--expected-case-count", "4",
    "--case-metadata", "cases.json",
    "--relay-credit-to-cny", "1",
    "--locale", "en",
    "--allow-evidence-mismatch",
  ]);
  assert.deepEqual(parsed.pairs, [
    { checkpointFile: "a.json", scoredFile: "a-scored.json" },
    { checkpointFile: "b.json", scoredFile: "b-scored.json" },
  ]);
  assert.equal(parsed.expectedCaseCount, 4);
  assert.equal(parsed.caseMetadataFile, "cases.json");
  assert.deepEqual(parsed.semanticReviewFiles, ["review-a.json", "review-b.json"]);
  assert.equal(parsed.relayCreditToCny, 1);
  assert.equal(parsed.locale, "en");
  assert.equal(parsed.strictEvidence, false);
  assert.throws(
    () => parseModelEffortMatrixArguments(["--locale", "fr"]),
    /--locale must be zh, en or ja/u,
  );

  const writes = [];
  const exitCode = await main([
    "--pair", "checkpoint-a.json", "scored-a.json",
    "--pair", "checkpoint-b.json", "scored-b.json",
    "--semantic-review", "review-codex.json",
    "--semantic-review", "review-human.json",
    "--expected-case-count", "4",
    "--json-out", "matrix.json",
    "--markdown-out", "matrix.md",
    "--locale", "ja",
  ], {
    readFileImpl: async (pathname) => files.get(String(pathname)),
    writeFileImpl: async (pathname, content) => writes.push({ pathname: String(pathname), content }),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    stdout: { write() {} },
  });
  assert.equal(exitCode, 0);
  assert.equal(writes.length, 2);
  assert.ok(writes.some((item) => (
    item.pathname.endsWith("matrix.json")
      && /offline_model_effort_matrix/u.test(item.content)
      && /"schemaVersion": 2/u.test(item.content)
      && /"semanticPublishable": true/u.test(item.content)
  )));
  assert.ok(writes.some((item) => (
    item.pathname.endsWith("matrix.md")
      && /モデル・推論強度評価マトリクス/u.test(item.content)
      && /\| リクエストモデル \| 推論強度 \| 証拠構成 \|/u.test(item.content)
      && !/case-a|Q1|人間:|Codex:/u.test(item.content)
  )));
});

function fixtureRun({
  model,
  effort,
  provider = null,
  reasoningMode = null,
  evidenceVariant = "full",
  scores = ["PASS", "PASS", "PASS", "PASS"],
  caseIds = CASE_IDS,
  estimatedCostCny = [],
} = {}) {
  const resultKey = (caseId) => {
    const base = provider === "deepseek"
      ? `${caseId}::${model}::${reasoningMode}::${effort}`
      : `${caseId}::${model}::${effort}`;
    return evidenceVariant === "full" ? base : `${base}::${evidenceVariant}`;
  };
  const plan = caseIds.map((caseId) => ({
    caseId,
    effort,
    ...(reasoningMode ? { reasoningMode } : {}),
    evidenceVariant,
    key: resultKey(caseId),
    finalInputSha256: evidenceVariant === "full"
      ? `input-${caseId}`
      : `input-${evidenceVariant}-${caseId}`,
  }));
  const results = caseIds.map((caseId, index) => ({
    key: resultKey(caseId),
    caseId,
    ...(provider ? { provider } : {}),
    model,
    effort,
    ...(reasoningMode ? { reasoningMode } : {}),
    evidenceVariant,
    status: scores[index] === "INCONCLUSIVE" ? "completed_invalid" : "completed_valid",
    requestId: index === 0 ? null : `request-${caseId}-${model}-${effort}-${evidenceVariant}`,
    durationMs: (index + 1) * 1000,
    finalInputSha256: evidenceVariant === "full"
      ? `input-${caseId}`
      : `input-${evidenceVariant}-${caseId}`,
    snapshotSha256: `snapshot-${caseId}`,
    rawOutput: `raw-output-${model}-${effort}-${evidenceVariant}-${caseId}`,
    hardValidity: {
      ok: scores[index] !== "INCONCLUSIVE",
      errors: scores[index] === "INCONCLUSIVE" ? ["hard validation failed"] : [],
    },
    validatedResult: {
      ok: scores[index] !== "INCONCLUSIVE",
      errors: scores[index] === "INCONCLUSIVE" ? ["combined validation failed"] : [],
    },
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
    ...(reasoningMode ? { reasoningMode } : {}),
    evidenceVariant,
    status: scores[index],
    sourceBinding: createExperimentResultBinding(results[index]),
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
      ...(provider ? { provider } : {}),
      efforts: [effort],
      ...(reasoningMode ? { reasoningMode } : {}),
      caseIds: [...caseIds],
      evidenceVariant,
      concurrency: 1,
      retries: 0,
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

function fixtureSemanticReview(runs, {
  kind = "human",
  name = kind === "human" ? "Test Judge" : "Codex",
  model = kind === "codex" ? "gpt-5.6-sol" : null,
  version = "review-v1",
  ratings = {},
  reviewedAt = "2026-08-08T01:00:00.000Z",
} = {}) {
  const reviews = [];
  for (const run of runs) {
    for (const [index, result] of run.checkpoint.results.entries()) {
      const score = run.scored.results.find((item) => (
        item.caseId === result.caseId
        && item.requestedModel === result.model
        && (item.reasoningMode || null) === (result.reasoningMode || null)
        && item.reasoningEffort === result.effort
        && item.evidenceVariant === result.evidenceVariant
      ));
      const identity = [
        result.caseId,
        result.model,
        ...(result.reasoningMode ? [result.reasoningMode] : []),
        result.effort,
        result.evidenceVariant,
      ].join("::");
      reviews.push({
        caseId: result.caseId,
        requestedModel: result.model,
        ...(result.reasoningMode ? { reasoningMode: result.reasoningMode } : {}),
        reasoningEffort: result.effort,
        evidenceVariant: result.evidenceVariant,
        ...score.sourceBinding,
        rating: ratings[identity] || ratings[result.caseId] || "correct",
        reviewer: {
          kind,
          name,
          ...(model ? { model } : {}),
          ...(version ? { version } : {}),
        },
        reviewedAt,
        rationale: `Review ${index + 1} for ${identity}`,
      });
    }
  }
  return {
    schemaVersion: 1,
    assessmentType: "semantic_result_review",
    reviews,
  };
}
