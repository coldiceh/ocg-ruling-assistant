import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildGenerationRequest,
  buildJudgeRequest,
  createManualReviewBundle,
  createPublicReport,
  extractCandidatePublicMetrics,
  isSolModelIdentity,
  parseChatCompletionSse,
  parseCliArguments,
  parseDatasetText,
  parseJudgeContent,
  resolveAnswerEndpoint,
  resolveRelayChatCompletionsEndpoint,
  requestBoundedResponseWithTimeout,
  runPureLlmPreviewEvaluation,
} from "../scripts/evaluate-pure-llm-preview.mjs";

test("private block parsing joins multiline questions and removes an equivalent duplicate", () => {
  const dataset = parseDatasetText([
    "匿名场景甲第一行",
    "匿名场景甲第二行",
    "裁判答案甲。",
    "",
    "匿名场景乙",
    "裁判答案乙",
    "",
    "匿名场景甲第一行",
    "匿名场景甲第二行",
    "裁判答案甲",
  ].join("\n"));

  assert.equal(dataset.sourceBlockCount, 3);
  assert.equal(dataset.uniqueCaseCount, 2);
  assert.equal(dataset.duplicateCount, 1);
  assert.deepEqual(dataset.cases.map((item) => item.id), ["case-001", "case-002"]);
  assert.equal(dataset.cases[0].question, "匿名场景甲第一行\n匿名场景甲第二行");
  assert.deepEqual(dataset.cases[0].sourceBlocks, [1, 3]);
});

test("generation request contains only the ordinary user question", () => {
  const request = buildGenerationRequest("匿名用户问题");
  assert.deepEqual(request, { question: "匿名用户问题" });
  assert.equal(JSON.stringify(request).includes("裁判标准答案"), false);
});

test("judge request is isolated, fixed to Sol and includes all private comparison inputs", () => {
  const request = buildJudgeRequest({
    question: "匿名问题",
    referenceAnswer: "匿名裁判答案",
    candidateResponseText: "{\"answer\":\"匿名候选\"}",
  });
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.reasoning_effort, "high");
  assert.equal(request.stream, true);
  assert.match(request.messages[1].content, /匿名问题/u);
  assert.match(request.messages[1].content, /匿名裁判答案/u);
  assert.match(request.messages[1].content, /匿名候选/u);
});

test("judge verdict parser accepts only the three reviewed verdicts", () => {
  assert.deepEqual(
    parseJudgeContent('{"verdict":"correct","reason":"一致"}'),
    { verdict: "correct", reason: "一致" },
  );
  assert.equal(parseJudgeContent("```json\n{\"verdict\":\"partially_correct\"}\n```").verdict, "partially_correct");
  assert.throws(() => parseJudgeContent('{"verdict":"pass"}'), /unsupported verdict/u);
  assert.throws(() => parseJudgeContent('{"verdict":"not_reviewed"}'), /unsupported verdict/u);
});

test("returned judge model must explicitly identify Sol", () => {
  assert.equal(isSolModelIdentity("gpt-5.6-sol"), true);
  assert.equal(isSolModelIdentity("provider/gpt-5.6-sol-202608"), true);
  assert.equal(isSolModelIdentity("relay-gpt-5.6-sol"), true);
  assert.equal(isSolModelIdentity("fake-sol"), false);
  assert.equal(isSolModelIdentity("gpt-4-sol"), false);
  assert.equal(isSolModelIdentity("gpt-5.6-terra"), false);
  assert.equal(isSolModelIdentity("gpt-5.6"), false);
});

test("SSE judge parsing preserves visible content and returned model identity", () => {
  const completion = parseChatCompletionSse([
    'data: {"model":"gpt-5.6-sol","choices":[{"delta":{"reasoning_content":"hidden","content":"{\\"verdict\\":\\"cor"}}]}',
    "",
    'data: {"model":"gpt-5.6-sol","choices":[{"delta":{"content":"rect\\",\\"reason\\":\\"一致\\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"));
  assert.equal(completion.model, "gpt-5.6-sol");
  assert.equal(completion.content, '{"verdict":"correct","reason":"一致"}');
  assert.equal(completion.finishReason, "stop");
  assert.equal(completion.usage.total_tokens, undefined);
});

test("public report contains only anonymous result metadata", () => {
  const privateQuestion = "绝不能公开的匿名问题正文";
  const privateReference = "绝不能公开的裁判答案";
  const privateCandidate = "绝不能公开的候选回答";
  const dataset = parseDatasetText(`${privateQuestion}\n${privateReference}`);
  const generations = new Map([[
    "case-001",
    {
      status: "generated",
      latencyMs: 120,
      candidateResponseText: privateCandidate,
      estimatedCostUsd: 0.002,
    },
  ]]);
  const judgments = new Map([[
    "case-001",
    {
      verdict: "correct",
      latencyMs: 30,
      reason: privateReference,
      estimatedCostUsd: 0.001,
    },
  ]]);
  const report = createPublicReport({
    dataset,
    selectedCases: dataset.cases,
    generations,
    judgments,
    generatedAt: "2026-08-13T00:00:00.000Z",
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.summary.correct, 1);
  assert.equal(report.summary.reviewedAccuracy, 1);
  assert.equal(report.summary.strictOverallAccuracy, 1);
  assert.deepEqual(report.summary.latencyMs.generation, {
    count: 1,
    average: 120,
    p50: 120,
    p95: 120,
    min: 120,
    max: 120,
  });
  assert.equal(report.summary.latencyMs.judgment.average, 30);
  assert.deepEqual(report.summary.estimatedCostUsd, {
    pricingBasis: "official_list_rate_all_input_uncached",
    generation: 0.002,
    judgment: 0.001,
    total: 0.003,
    generationCoverage: 1,
    judgmentCoverage: 1,
  });
  assert.equal(serialized.includes(privateQuestion), false);
  assert.equal(serialized.includes(privateReference), false);
  assert.equal(serialized.includes(privateCandidate), false);
});

test("generation-only public report exposes no rows, judge, verdict or accuracy", () => {
  const dataset = parseDatasetText("私有问题\n私有参考答案");
  const report = createPublicReport({
    dataset,
    selectedCases: dataset.cases,
    generations: new Map([[
      "case-001",
      {
        status: "generated",
        latencyMs: 1250,
        candidateResponseText: "私有候选回答",
        estimatedCostUsd: 0.0025,
      },
    ]]),
    mode: "generate_only",
    generatedAt: "2026-08-13T00:00:00.000Z",
  });

  assert.deepEqual(report, {
    schemaVersion: 1,
    generatedAt: "2026-08-13T00:00:00.000Z",
    mode: "generate_only",
    summary: {
      total: 1,
      generated: 1,
      generationFailed: 0,
      latencyMs: {
        generation: {
          count: 1,
          average: 1250,
          p50: 1250,
          p95: 1250,
          min: 1250,
          max: 1250,
        },
      },
      estimatedCostUsd: {
        pricingBasis: "official_list_rate_all_input_uncached",
        generation: 0.0025,
        total: 0.0025,
        generationCoverage: 1,
      },
    },
  });
  const publicText = JSON.stringify(report);
  assert.doesNotMatch(publicText, /私有问题|私有参考答案|私有候选回答/u);
  assert.equal(Object.hasOwn(report, "cases"), false);
  assert.equal(Object.hasOwn(report, "judge"), false);
  assert.equal(Object.hasOwn(report.summary, "correct"), false);
  assert.equal(Object.hasOwn(report.summary, "reviewedAccuracy"), false);
});

test("private manual-review bundle puts question, reference and candidate together for human scoring", () => {
  const dataset = parseDatasetText("私有问题\n私有裁判答案");
  const bundle = createManualReviewBundle({
    dataset,
    selectedCases: dataset.cases,
    generations: new Map([[
      "case-001",
      {
        status: "generated",
        latencyMs: 4321,
        candidateResponseText: "私有候选回答",
      },
    ]]),
    generatedAt: "2026-08-13T00:00:00.000Z",
  });

  assert.equal(bundle.private, true);
  assert.equal(bundle.summary.generated, 1);
  assert.deepEqual(bundle.cases[0], {
    id: "case-001",
    question: "私有问题",
    referenceAnswer: "私有裁判答案",
    generationStatus: "generated",
    candidateResponseText: "私有候选回答",
    generationLatencyMs: 4321,
    generationFailureCode: null,
    generationError: null,
    humanVerdict: "not_reviewed",
    humanNotes: "",
  });
});

test("candidate public metrics read only cost and usage from the answer debug object", () => {
  assert.deepEqual(extractCandidatePublicMetrics(JSON.stringify({
    shortAnswer: "private answer text",
    debug: {
      estimatedCostUsd: 0.0123,
      tokenUsage: { prompt_tokens: 100, completion_tokens: 25, secret: "ignored" },
    },
  })), {
    estimatedCostUsd: 0.0123,
    usage: { prompt_tokens: 100, completion_tokens: 25 },
  });
  assert.deepEqual(extractCandidatePublicMetrics("plain text"), {});
});

test("failed or absent judge results are not reviewed and stay outside the reviewed denominator", () => {
  const dataset = parseDatasetText("问题甲\n答案甲\n\n问题乙\n答案乙");
  const generations = new Map(dataset.cases.map((item) => [item.id, { status: "generated" }]));
  const judgments = new Map([["case-001", { verdict: "correct" }]]);
  const report = createPublicReport({ dataset, selectedCases: dataset.cases, generations, judgments });

  assert.equal(report.summary.generated, 2);
  assert.equal(report.summary.reviewed, 1);
  assert.equal(report.summary.judgeFailed, 1);
  assert.equal(report.summary.reviewCoverage, 0.5);
  assert.equal(report.summary.reviewedAccuracy, 1);
  assert.equal(report.summary.strictOverallAccuracy, 0.5);
  assert.equal(report.cases[1].verdict, "not_reviewed");
});

test("CLI modes and HTTP endpoint normalization are explicit", () => {
  const defaultOptions = parseCliArguments([
    "--base-url",
    "https://preview.example.test",
  ]);
  assert.equal(defaultOptions.generateOnly, true);
  assert.equal(defaultOptions.autoJudge, false);

  const options = parseCliArguments([
    "--judge-only",
    "--checkpoint-dir",
    "C:/private/checkpoint",
    "--limit",
    "4",
  ]);
  assert.equal(options.judgeOnly, true);
  assert.equal(options.limit, 4);
  assert.throws(
    () => parseCliArguments(["--generate-only", "--judge-only"]),
    /mutually exclusive/u,
  );
  assert.throws(
    () => parseCliArguments(["--auto-judge", "--generate-only"]),
    /mutually exclusive/u,
  );
  assert.equal(resolveAnswerEndpoint("https://preview.example.test/"), "https://preview.example.test/api/answer");
  assert.equal(
    resolveRelayChatCompletionsEndpoint("https://relay.example.test/v1"),
    "https://relay.example.test/v1/chat/completions",
  );
  assert.throws(() => resolveRelayChatCompletionsEndpoint("http://relay.example.test/v1"), /HTTPS/u);
});

test("HTTP timeout remains active even when a custom body reader ignores abort", async () => {
  let requestSignal;
  const fetchImpl = async (_url, options) => {
    requestSignal = options.signal;
    return {
      status: 200,
      ok: true,
      headers: { get() { return null; } },
      body: {
        getReader() {
          return {
            read() {
              return new Promise(() => {});
            },
            cancel() { return Promise.resolve(); },
          };
        },
      },
    };
  };

  await assert.rejects(
    requestBoundedResponseWithTimeout(
      fetchImpl,
      "https://preview.example.test/api/answer",
      { method: "POST" },
      20,
      1024,
    ),
    (error) => error?.name === "TimeoutError" && /timed out/iu.test(error.message),
  );
  assert.equal(requestSignal.aborted, true);
});

test("a generation failure is checkpointed and reported before the evaluator exits unsuccessfully", async () => {
  const privateRoot = new URL(
    `file:///${tmpdir().replaceAll("\\", "/")}/pure-llm-failed-eval-${Date.now()}/`,
  );
  const datasetPath = new URL("dataset.txt", privateRoot);
  const checkpointDirectory = new URL("checkpoint", privateRoot);
  const { mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  await mkdir(fileURLToPath(privateRoot), { recursive: true });
  await writeFile(fileURLToPath(datasetPath), "匿名失败问题\n匿名标准答案", "utf8");
  try {
    await assert.rejects(
      runPureLlmPreviewEvaluation({
        argv: [
          "--dataset", fileURLToPath(datasetPath),
          "--checkpoint-dir", fileURLToPath(checkpointDirectory),
          "--base-url", "https://preview.example.test",
          "--generate-only",
        ],
        fetchImpl: async () => { throw new Error("synthetic transport failure"); },
        log() {},
      }),
      /generation failed for 1 of 1/iu,
    );
    const report = JSON.parse(await readFile(
      fileURLToPath(new URL("public-report.json", `${checkpointDirectory.href}/`)),
      "utf8",
    ));
    const manualReview = JSON.parse(await readFile(
      fileURLToPath(new URL("manual-review.json", `${checkpointDirectory.href}/`)),
      "utf8",
    ));
    assert.equal(report.summary.generated, 0);
    assert.equal(report.summary.generationFailed, 1);
    assert.equal(manualReview.cases[0].generationStatus, "generation_failed");
    assert.equal(manualReview.cases[0].generationFailureCode, "preview_request_failed");
  } finally {
    await rm(fileURLToPath(privateRoot), { recursive: true, force: true });
  }
});

test("a bounded HTTP 2xx text candidate is checkpointed and sent to the semantic judge", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (calls.length === 1) {
      return new Response("候选直接回答文本", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response([
      'data: {"model":"gpt-5.6-sol","choices":[{"delta":{"content":"{\\"verdict\\":\\"correct\\",\\"reason\\":\\"一致\\"}"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const privateRoot = new URL(
    `file:///${tmpdir().replaceAll("\\", "/")}/pure-llm-eval-${Date.now()}/`,
  );
  const datasetPath = new URL("dataset.txt", privateRoot);
  const checkpointDirectory = new URL("checkpoint", privateRoot);
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  await mkdir(fileURLToPath(privateRoot), { recursive: true });
  await writeFile(fileURLToPath(datasetPath), "匿名问题\n匿名答案", "utf8");
  try {
    const report = await runPureLlmPreviewEvaluation({
      argv: [
        "--dataset", fileURLToPath(datasetPath),
        "--checkpoint-dir", fileURLToPath(checkpointDirectory),
        "--base-url", "https://preview.example.test",
        "--auto-judge",
      ],
      env: {
        RELAY_API_KEY: "test-secret",
        RELAY_BASE_URL: "https://relay.example.test/v1",
      },
      fetchImpl,
      log() {},
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { question: "匿名问题" });
    assert.match(calls[1].body.messages[1].content, /候选直接回答文本/u);
    assert.equal(report.summary.correct, 1);
  } finally {
    await rm(fileURLToPath(privateRoot), { recursive: true, force: true });
  }
});
