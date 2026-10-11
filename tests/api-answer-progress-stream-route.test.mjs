import assert from "node:assert/strict";
import test from "node:test";

import { createPublicAnswerHandler } from "../api/answer.js";

// The single-request stream route (`POST /api/answer?progress=1` without a
// prepare/finalize action) is what the timing diagnostics page and external
// streaming clients use. A block-scoped `const answer` inside the route once
// shadowed the injected `answer` function, so every request died with
// "Cannot access 'answer' before initialization" before any stage ran.

function createSseResponse() {
  return {
    statusCode: 0, headers: {}, body: "", writableEnded: false, destroyed: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    flushHeaders() {}, flush() {},
    write(chunk) { this.body += chunk; return true; },
    end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = JSON.stringify(payload); this.writableEnded = true; },
    on() {}, once() {}, off() {},
  };
}

function parseSseEvents(body) {
  return String(body || "").trim().split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
    let type = "message"; const data = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return { type, data: data.length ? JSON.parse(data.join("\n")) : null };
  });
}

test("the single-request stream route reaches the injected answer function and emits the answer", async () => {
  const seen = [];
  const handler = createPublicAnswerHandler({
    env: { MODEL_PROVIDER: "mock", PUBLIC_RULING_MODEL_PROFILE: "bai-astra-low" },
    rateLimit: async () => {},
    answer: async ({ payload, progress }) => {
      seen.push(payload.question);
      progress.transition("understand");
      progress.transition("generate_ruling");
      return { answer: { status: "inferred", shortAnswer: "可以。", usedEvidence: [] }, latency: null };
    },
  });
  const response = createSseResponse();
  await handler({
    method: "POST",
    url: "/api/answer?progress=1",
    headers: { accept: "text/event-stream" },
    // The exact web key set: only the web channel is offered the stream route.
    body: { mode: "rag", question: "伤害步骤中可以发动这个效果吗？", rulingModelProfile: "bai-astra-low", rulingVersion: "latest" },
    on() {}, once() {}, off() {},
  }, response);

  assert.deepEqual(seen, ["伤害步骤中可以发动这个效果吗？"]);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/u);
  const events = parseSseEvents(response.body);
  assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events));
  assert.equal(events[0].type, "stage_start");
  assert.equal(events[0].data.stageId, "understand");
  const answer = events.find((event) => event.type === "answer");
  assert.ok(answer, "an answer event must be streamed");
  assert.equal(answer.data.answer.shortAnswer, "可以。");
  assert.equal(events.at(-1).type, "end");
  assert.equal(events.at(-1).data.status, "completed");
});
