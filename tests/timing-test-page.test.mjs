import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TIMING_STAGES,
  applyTimingProtocolEvent,
  buildTimingProgressUrl,
  buildTimingRequestBody,
  createTimingProtocolState,
  finalizeTimingProtocolState,
  parseTimingSseBlock,
} from "../public/timing-test.js";

test("timing test page is isolated and always targets the current deployment origin", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../public/timing-test.html", import.meta.url), "utf8"),
    readFile(new URL("../public/timing-test.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /裁定流程真实计时测试/u);
  assert.match(html, /浏览器总等待/u);
  assert.match(html, /后端总计/u);
  assert.match(html, /浏览器－后端/u);
  assert.match(html, /首个事件到达/u);
  assert.match(html, /查看原始 SSE 事件/u);
  assert.match(html, /src="timing-test\.js\?v=/u);
  assert.match(source, /TIMING_TEST_API_PATH = "\/api\/answer"/u);
  assert.doesNotMatch(source, /config\.json|ocg-ruling-assistant\.vercel\.app/u);
  assert.doesNotMatch(source, /retry|setTimeout/u);

  assert.equal(
    buildTimingProgressUrl({ origin: "https://preview.example" }),
    "https://preview.example/api/answer?progress=1",
  );
});

test("timing request uses the exact web-channel request shape", () => {
  const body = buildTimingRequestBody("  测试问题  ", "relay-gpt-5.6-sol-low");
  assert.deepEqual(Object.keys(body).sort(), [
    "mode",
    "question",
    "rulingModelProfile",
    "rulingVersion",
  ]);
  assert.deepEqual(body, {
    mode: "rag",
    question: "测试问题",
    rulingModelProfile: "relay-gpt-5.6-sol-low",
    rulingVersion: "latest",
  });
});

test("timing protocol renders all five backend stages from measured SSE fields", () => {
  assert.deepEqual(TIMING_STAGES.map((stage) => stage.id), [
    "understand",
    "extract_card_names",
    "retrieve_card_texts",
    "retrieve_rulings",
    "generate_ruling",
  ]);

  const state = createTimingProtocolState();
  applyTimingProtocolEvent(state, parseTimingSseBlock(
    'event: stage_start\ndata: {"stageId":"understand","serverElapsedMs":3}',
  ));
  applyTimingProtocolEvent(state, parseTimingSseBlock(
    'event: tick\ndata: {"stageId":"understand","serverElapsedMs":803,"activeStageElapsedMs":800}',
  ));
  applyTimingProtocolEvent(state, parseTimingSseBlock(
    'event: stage_end\ndata: {"stageId":"understand","serverElapsedMs":1003,"durationMs":1000,"status":"completed"}',
  ));
  applyTimingProtocolEvent(state, parseTimingSseBlock(
    'event: stage_start\ndata: {"stageId":"extract_card_names","serverElapsedMs":1003}',
  ));
  applyTimingProtocolEvent(state, parseTimingSseBlock(
    'event: stage_end\ndata: {"stageId":"extract_card_names","serverElapsedMs":2303,"durationMs":1300,"status":"completed"}',
  ));
  applyTimingProtocolEvent(state, {
    type: "answer",
    data: { answer: { route: "ordinary_rag", shortAnswer: "测试回答" }, progress: { totalMs: 2303 } },
  });
  applyTimingProtocolEvent(state, { type: "end", data: { totalMs: 2303 } });

  assert.equal(state.stages[0].startedAtMs, 3);
  assert.equal(state.stages[0].durationMs, 1000);
  assert.equal(state.stages[1].startedAtMs, 1003);
  assert.equal(state.stages[1].durationMs, 1300);
  assert.equal(state.stages[2].status, "skipped");
  assert.equal(state.backendTotalMs, 2303);
  assert.equal(finalizeTimingProtocolState(state).shortAnswer, "测试回答");
});

test("missing backend timing remains unavailable instead of becoming zero", () => {
  const state = createTimingProtocolState();
  applyTimingProtocolEvent(state, {
    type: "stage_start",
    data: { stageId: "understand", serverElapsedMs: null },
  });

  assert.equal(state.backendTotalMs, null);
  assert.equal(state.stages[0].startedAtMs, null);
  assert.throws(
    () => applyTimingProtocolEvent(state, {
      type: "tick",
      data: { stageId: "understand", activeStageElapsedMs: "" },
    }),
    (error) => error?.code === "timing_sse_tick_invalid",
  );
});

test("timing protocol fails closed on malformed or out-of-order streams", () => {
  assert.throws(
    () => parseTimingSseBlock("event: tick\ndata: not-json"),
    (error) => error?.code === "timing_sse_json_invalid",
  );

  const missingEnd = createTimingProtocolState();
  applyTimingProtocolEvent(missingEnd, {
    type: "answer",
    data: { answer: { shortAnswer: "尚未结束" } },
  });
  assert.throws(
    () => finalizeTimingProtocolState(missingEnd),
    (error) => error?.code === "timing_sse_end_missing",
  );

  const wrongOrder = createTimingProtocolState();
  assert.throws(
    () => applyTimingProtocolEvent(wrongOrder, {
      type: "stage_start",
      data: { stageId: "retrieve_rulings", serverElapsedMs: 10 },
    }) && applyTimingProtocolEvent(wrongOrder, {
      type: "stage_start",
      data: { stageId: "extract_card_names", serverElapsedMs: 20 },
    }),
    (error) => error?.code === "timing_sse_stage_order_invalid",
  );

  const answerDuringStage = createTimingProtocolState();
  applyTimingProtocolEvent(answerDuringStage, {
    type: "stage_start",
    data: { stageId: "understand", serverElapsedMs: 10 },
  });
  assert.throws(
    () => applyTimingProtocolEvent(answerDuringStage, {
      type: "answer",
      data: { answer: { shortAnswer: "过早回答" }, progress: { totalMs: 11 } },
    }),
    (error) => error?.code === "timing_sse_answer_during_stage",
  );

  const stageAfterAnswer = createTimingProtocolState();
  applyTimingProtocolEvent(stageAfterAnswer, {
    type: "answer",
    data: { answer: { shortAnswer: "已回答" }, progress: { totalMs: 12 } },
  });
  assert.throws(
    () => applyTimingProtocolEvent(stageAfterAnswer, {
      type: "stage_start",
      data: { stageId: "understand", serverElapsedMs: 13 },
    }),
    (error) => error?.code === "timing_sse_event_after_result",
  );

  const elapsedRegression = createTimingProtocolState();
  applyTimingProtocolEvent(elapsedRegression, {
    type: "stage_start",
    data: { stageId: "understand", serverElapsedMs: 20 },
  });
  assert.throws(
    () => applyTimingProtocolEvent(elapsedRegression, {
      type: "tick",
      data: { stageId: "understand", serverElapsedMs: 19, activeStageElapsedMs: 1 },
    }),
    (error) => error?.code === "timing_sse_server_elapsed_regressed",
  );
});

test("early direct answers keep unentered stages explicitly unexecuted", () => {
  const state = createTimingProtocolState();
  applyTimingProtocolEvent(state, {
    type: "stage_start",
    data: { stageId: "understand", serverElapsedMs: 0 },
  });
  applyTimingProtocolEvent(state, {
    type: "stage_end",
    data: { stageId: "understand", serverElapsedMs: 25, durationMs: 25, status: "completed" },
  });
  applyTimingProtocolEvent(state, {
    type: "answer",
    data: { answer: { route: "official_qa_exact_direct" }, progress: { totalMs: 25 } },
  });
  applyTimingProtocolEvent(state, { type: "end", data: { totalMs: 25 } });

  assert.equal(state.stages[0].status, "done");
  assert.equal(state.stages.slice(1).every((stage) => stage.status === "skipped"), true);
});
