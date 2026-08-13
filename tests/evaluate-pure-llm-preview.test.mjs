import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGenerationRequest,
  buildJudgeRequest,
  createPublicReport,
  isSolModelIdentity,
  parseChatCompletionSse,
  parseCliArguments,
  parseDatasetText,
  parseJudgeContent,
  resolveAnswerEndpoint,
  resolveRelayChatCompletionsEndpoint,
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
    { status: "generated", latencyMs: 120, candidateResponseText: privateCandidate },
  ]]);
  const judgments = new Map([[
    "case-001",
    { verdict: "correct", latencyMs: 30, reason: privateReference },
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
  assert.equal(serialized.includes(privateQuestion), false);
  assert.equal(serialized.includes(privateReference), false);
  assert.equal(serialized.includes(privateCandidate), false);
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
  assert.equal(resolveAnswerEndpoint("https://preview.example.test/"), "https://preview.example.test/api/answer");
  assert.equal(
    resolveRelayChatCompletionsEndpoint("https://relay.example.test/v1"),
    "https://relay.example.test/v1/chat/completions",
  );
  assert.throws(() => resolveRelayChatCompletionsEndpoint("http://relay.example.test/v1"), /HTTPS/u);
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
  const privateRoot = new URL(`file:///${process.env.TEMP.replaceAll("\\", "/")}/pure-llm-eval-${Date.now()}/`);
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
