import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_ANSWER_PROGRESS_STAGES,
  beginPublicAnswerEventStream,
  createPublicAnswerProgress,
  sendPublicAnswerEvent,
  wantsPublicAnswerProgress,
} from "../backend/publicAnswerProgress.mjs";

test("real backend stages form one gap-free measured wall-clock timeline", () => {
  let currentMs = 100;
  const events = [];
  const progress = createPublicAnswerProgress({
    now: () => currentMs,
    emit: (type, data) => events.push({ type, ...data }),
  });

  progress.start();
  currentMs += 11;
  progress.transition("extract_card_names");
  currentMs += 22;
  progress.transition("retrieve_card_texts");
  currentMs += 33;
  progress.transition("retrieve_rulings");
  currentMs += 44;
  progress.transition("generate_ruling");
  currentMs += 55;
  const measured = progress.complete();

  assert.deepEqual(
    events.filter((event) => event.type === "stage_start").map((event) => event.stageId),
    PUBLIC_ANSWER_PROGRESS_STAGES.map((stage) => stage.id),
  );
  assert.deepEqual(measured.stageDurationsMs, {
    understand: 11,
    extract_card_names: 22,
    retrieve_card_texts: 33,
    retrieve_rulings: 44,
    generate_ruling: 55,
  });
  assert.equal(measured.totalMs, 165);
  assert.equal(
    Object.values(measured.stageDurationsMs).reduce((sum, value) => sum + value, 0),
    measured.totalMs,
  );
});

test("ticks report the backend active stage instead of advancing it", () => {
  let currentMs = 0;
  const events = [];
  const progress = createPublicAnswerProgress({
    now: () => currentMs,
    emit: (type, data) => events.push({ type, ...data }),
  });
  progress.start();
  currentMs = 1_234;
  progress.tick();

  assert.deepEqual(events.at(-1), {
    type: "tick",
    stageId: "understand",
    serverElapsedMs: 1_234,
    activeStageElapsedMs: 1_234,
  });
  assert.equal(progress.activeStageId, "understand");
});

test("progress streaming is opt-in for the web request shape only", () => {
  const request = {
    url: "/api/answer?progress=1",
    headers: { accept: "text/event-stream" },
  };
  assert.equal(wantsPublicAnswerProgress(request, "web"), true);
  assert.equal(wantsPublicAnswerProgress(request, "external_api"), false);
  assert.equal(wantsPublicAnswerProgress({ ...request, url: "/api/answer" }, "web"), false);
  assert.equal(wantsPublicAnswerProgress({ ...request, headers: { accept: "application/json" } }, "web"), false);
});

test("SSE helpers disable buffering and preserve UTF-8 JSON payloads", () => {
  const headers = new Map();
  let body = "";
  const response = {
    setHeader(name, value) { headers.set(name, value); },
    write(chunk) { body += chunk; },
    flushHeaders() {},
    flush() {},
    writableEnded: false,
    destroyed: false,
  };
  beginPublicAnswerEventStream(response);
  sendPublicAnswerEvent(response, "tick", { stageId: "retrieve_rulings", label: "检索规则资料" });

  assert.equal(headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(headers.get("cache-control"), "no-cache, no-transform");
  assert.match(body, /^event: tick\ndata: /u);
  assert.match(body, /检索规则资料/u);
});
