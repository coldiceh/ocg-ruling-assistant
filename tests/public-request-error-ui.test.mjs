import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const client = app.slice(app.indexOf("async function requestBackendAnswer"), app.indexOf("function renderPending"));
const requestWith = (fetchImpl) => new Function("fetch", `
  const appConfig = { answerApiUrl: "https://example.invalid/api/answer" };
  const selectedRulingModelProfile = "relay-gpt-6-astra-max";
  const analysisRequestId = 0;
  function applyPendingStageProgressEvent() {}
  ${client}
  return requestBackendAnswer;
`)(fetchImpl);

function renderer() {
  const source = app.slice(app.indexOf("function renderBackendVersionError"), app.indexOf("function relayPreparationFailurePresentation"));
  const ui = Object.fromEntries(["resultGrid", "verdictBlock", "confidenceText", "verdictTitle", "rulingBasisText", "answerVersionText", "verdictBody", "stepsTitle", "stepsList", "questionsList"].map((key) => [key, {
    textContent: "", hidden: true, classList: { add() {} },
  }]));
  const render = new Function("ui", `
    let lastRenderedBackendAnswer = null;
    function failPendingStages() {}
    function renderCards() {}
    function renderEngineSimulation() {}
    function renderParserDebug() {}
    function renderFeedbackPanel() {}
    function renderSubAnswers() {}
    function renderSources() {}
    function updateModelStatus() {}
    function relayPreparationFailurePresentation() { return null; }
    function normalizeRulingVersion(value) { return value === "latest" ? value : ""; }
    function renderList(node, values) { node.items = values; }
    ${source}
    return renderBackendVersionError;
  `)(ui);
  return { ui, render };
}

test("HTTP input errors retain public code and message and render outside version failures", async () => {
  for (const [status, payload, title] of [
    [413, { code: "question_too_long", error: "question exceeds 12000 characters" }, "输入内容过长"],
    [413, { code: "request_body_too_large", error: "request body exceeds 65536 bytes" }, "输入内容过长"],
    [400, { code: "invalid_question", error: "question must be a non-empty string" }, "请求内容无效"],
  ]) {
    let calls = 0;
    let jsonReads = 0;
    const request = requestWith(async () => {
      calls++;
      return { ok: false, status, json: async () => { jsonReads++; return payload; } };
    });
    let captured;
    await assert.rejects(request("Synthetic input only", "latest"), (error) => {
      captured = error;
      assert.equal(error.code, payload.code);
      assert.equal(error.publicMessage, payload.error);
      assert.equal(error.status, status);
      assert.equal(error.requestFailure, true);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(jsonReads, 1);
    const { ui, render } = renderer(); render(captured, "latest");
    assert.equal(ui.verdictTitle.textContent, title);
    assert.doesNotMatch(JSON.stringify(ui), /版本协议校验失败|无法确认回答版本|未计费/);
    assert.ok(ui.questionsList.items.includes(payload.error));
    if (status === 413) assert.match(JSON.stringify(ui), /未开始裁定/);
  }
});

test("non-JSON HTTP 500 and network errors preserve unknown backend execution", async () => {
  for (const kind of ["http", "network"]) {
    let calls = 0;
    const request = requestWith(async () => {
      calls++;
      if (kind === "network") throw new TypeError("Synthetic failed fetch");
      return { ok: false, status: 500, json: async () => { throw new SyntaxError("not JSON"); } };
    });
    let captured;
    await assert.rejects(request("Synthetic input only", "latest"), (error) => {
      captured = error;
      assert.equal(error.code, kind === "http" ? "answer_http_error" : "answer_network_error");
      assert.equal(error.requestFailure, true);
      return true;
    });
    assert.equal(calls, 1);
    const { ui, render } = renderer(); render(captured, "latest");
    assert.doesNotMatch(JSON.stringify(ui), /版本协议校验失败|无法确认回答版本|未调用|未计费|未开始裁定/);
    assert.match(ui.verdictBody.textContent, /后台执行状态尚未确认/);
  }
});

test("network interruption while reading a successful HTTP stream is not a version mismatch", async () => {
  let calls = 0;
  const request = requestWith(async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: { getReader: () => ({
      read: async () => { throw new TypeError("Synthetic stream disconnect"); }, cancel: async () => {}, releaseLock() {},
    }) } };
  });
  await assert.rejects(request("Synthetic input only", "latest"), (error) => error.requestFailure === true && error.code === "answer_network_error");
  assert.equal(calls, 1);
});

test("normal EOF without an SSE end marker displays incomplete delivery and preserves HTTP 200 context", async () => {
  let calls = 0;
  const bytes = new TextEncoder().encode('event: tick\ndata: {"stageId":"generate_ruling","serverElapsedMs":299000}\n\n');
  const request = requestWith(async () => {
    calls++;
    let read = false;
    return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: { getReader: () => ({
      read: async () => {
        if (read) return { done: true, value: undefined };
        read = true;
        return { done: false, value: bytes };
      },
      cancel: async () => {}, releaseLock() {},
    }) } };
  });
  let captured;
  await assert.rejects(request("Synthetic input only", "latest"), (error) => {
    captured = error;
    return error.code === "ruling_progress_end_missing" && error.status === 200;
  });
  const { ui, render } = renderer(); render(captured, "latest");
  assert.equal(ui.verdictTitle.textContent, "回答传输未完成");
  assert.match(ui.verdictBody.textContent, /HTTP 200.*连接已建立/);
  assert.match(ui.verdictBody.textContent, /后台执行状态尚未确认/);
  assert.doesNotMatch(JSON.stringify(ui), /版本协议校验失败|无法确认回答版本|未调用|未计费|未开始裁定/);
  assert.equal(calls, 1);
});
