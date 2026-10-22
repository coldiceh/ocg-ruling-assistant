import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPublicAnswerHandler } from "../api/answer.js";
import { parsePublicAnswerPayload } from "../backend/publicAnswerService.mjs";
import { preparePublicAnswer } from "../backend/publicPreparedAnswerService.mjs";
import { createPublicAnswerProgress } from "../backend/publicAnswerProgress.mjs";

// 仅引擎复现: a prepare request with engineOnly waits, after preparing, for the engine reproduction the
// preparation started and returns its section with the preparation. The final model is not called.
const body = { action: "prepare", question: "Synthetic test question", mode: "rag", rulingVersion: "latest",
  rulingModelProfile: "official-astra-low" };
const PREPARATION_ID = "a".repeat(64);
const progress = { status: "completed", totalMs: 1200, stageDurationsMs: { understand: 100 } };

function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 0, chunks: [], headers: {}, writableEnded: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; this.writableEnded = true; return this; },
    write(value) { this.chunks.push(value); },
    end() { this.writableEnded = true; }, flushHeaders() {},
  });
}
const request = (payload) => ({ method: "POST", url: "/api/answer?progress=1", headers: { accept: "text/event-stream" }, body: payload });
const events = (res) => res.chunks.join("").split("\n\n").filter(Boolean)
  .map((block) => ({ type: block.split("\n")[0].slice(7), data: JSON.parse(block.split("\n")[1].slice(6)) }));

function handler({ engineReproWait = { auditId: "audit-1", requestStartedAt: 1000 }, section = null } = {}) {
  const calls = { prepare: 0, finalize: 0, waits: [] };
  const run = createPublicAnswerHandler({
    env: { MODEL_PROVIDER: "mock" },
    createStore: () => ({}),
    rateLimit: async () => ({ allowed: true }),
    prepare: async () => {
      calls.prepare += 1;
      return { preparationId: PREPARATION_ID, progress, evidencePreview: [{ id: "card:1", type: "card_text" }],
        evidencePackage: { text: "prompt", filename: "ocg-evidence.txt" }, engineReproWait };
    },
    finalize: async () => { calls.finalize += 1; throw new Error("the final model must not run"); },
    waitEngineRepro: async (options) => { calls.waits.push(options); return section; },
  });
  return { run, calls };
}

const doneSection = { status: "done", questionStatus: "已复现", rendered: "【引擎复现】完整回放",
  digest: { status: "已复现", reasonCodes: [], assumptions: [], subQuestions: [] } };

test("engineOnly is accepted only as true on a prepare request", () => {
  assert.equal(parsePublicAnswerPayload({ ...body, engineOnly: true }).engineOnly, true);
  for (const bad of [{ ...body, engineOnly: false }, { ...body, engineOnly: "yes" }, { ...body, action: undefined, engineOnly: true }]) {
    assert.throws(() => parsePublicAnswerPayload(bad), /engineOnly is only true on a prepare request/u, JSON.stringify(bad));
  }
  assert.throws(() => parsePublicAnswerPayload({ action: "finalize", preparationId: PREPARATION_ID, engineOnly: true }),
    /requires only a valid preparationId/u);
});

test("仅引擎复现: the prepare request waits for the reproduction and returns its section; no final model", async () => {
  const { run, calls } = handler({ section: doneSection });
  const res = response();
  await run(request({ ...body, engineOnly: true }), res);
  const output = events(res);
  assert.deepEqual(output.map((event) => event.type).slice(-3), ["phase_start", "prepared", "end"]);
  assert.deepEqual(output.at(-3).data, { phase: "engine_repro" });
  const prepared = output.at(-2).data;
  assert.equal(prepared.preparationId, PREPARATION_ID);
  assert.equal(prepared.engineRepro.status, "done");
  assert.equal(prepared.engineRepro.questionStatus, "已复现");
  assert.match(prepared.engineRepro.concise, /^【ygopro 引擎复现（实验性）】已复现/u);
  assert.equal(prepared.engineRepro.rendered, "【引擎复现】完整回放");
  assert.equal(Object.hasOwn(prepared, "engineReproWait"), false, "the wait key stays on the server");
  assert.equal(calls.finalize, 0);
  assert.equal(calls.waits.length, 1);
  assert.equal(calls.waits[0].auditId, "audit-1");
  assert.equal(calls.waits[0].requestStartedAt, 1000);
  assert.ok(calls.waits[0].waitDeadlineAt > 1000, "bounded by this invocation's own limit");
});

test("仅引擎复现 without a reproduction reads not_started; an ordinary prepare does not wait", async () => {
  const off = handler({ engineReproWait: null, section: doneSection });
  const res = response();
  await off.run(request({ ...body, engineOnly: true }), res);
  assert.deepEqual(events(res).find((event) => event.type === "prepared").data.engineRepro, { status: "not_started" });
  assert.equal(off.calls.waits.length, 0);

  const nothingStored = handler({ section: null });
  const stored = response();
  await nothingStored.run(request({ ...body, engineOnly: true }), stored);
  assert.deepEqual(events(stored).find((event) => event.type === "prepared").data.engineRepro, { status: "not_started" });

  const plain = handler({ section: doneSection });
  const ordinary = response();
  await plain.run(request(body), ordinary);
  const output = events(ordinary);
  assert.ok(!output.some((event) => event.type === "phase_start"));
  assert.equal(Object.hasOwn(output.find((event) => event.type === "prepared").data, "engineRepro"), false);
  assert.equal(plain.calls.waits.length, 0);
});

test("prepare tells the handler where the reproduction it started stores its result", async () => {
  const result = await preparePublicAnswer({
    payload: { ...body }, env: { MODEL_PROVIDER: "mock" }, progress: createPublicAnswerProgress(),
    store: { create: async () => PREPARATION_ID }, updateAudit: async () => null,
    answerPublic: async () => ({
      answer: { status: "evidence_prepared", rulingVersion: "latest",
        continuation: { promptBundle: { prompt: "p", allowedEvidenceIds: [], modelEvidence: {} }, evidence: {} }, debug: {} },
      latency: { profileId: "official-astra-low" }, auditId: "audit-9", engineRepro: { enabled: true, requestStartedAt: 42 } }),
  });
  assert.deepEqual(result.engineReproWait, { auditId: "audit-9", requestStartedAt: 42 });
});

test("the page: a 仅引擎复现 button that prepares with engineOnly and shows the section with 生成答案", async () => {
  const [html, app] = await Promise.all([readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8")]);
  assert.match(html, /<button class="text-button prepare-only-button" id="engineOnlyButton" type="button">仅引擎复现<\/button>/u);
  assert.match(app, /ui\.engineOnlyButton\?\.addEventListener\("click", \(\) => analyzeQuestion\(\{ prepareOnly: true, engineOnly: true \}\)\)/u);
  assert.match(app, /\.\.\.\(engineOnly \? \{ engineOnly: true \} : \{\}\),/u);
  const view = app.slice(app.indexOf("function renderEngineOnly"), app.indexOf("async function continuePreparedAnswer"));
  assert.match(view, /renderMarkdown\(ui\.verdictBody, engine\.concise, \[\]\)/u);
  assert.match(view, /renderEngineReproReplay\(ui\.verdictBody, engine\)/u);
  assert.match(view, /appendPreparedContinueButton\(prepared, \{ question, requestedRulingVersion \}\)/u);
  assert.match(app, /if \(engineOnly\) renderEngineOnly\(answer, \{ question: text, requestedRulingVersion \}\);/u);
  assert.match(app, /pendingPipelinePhase === "engine_repro"/u);
  assert.match(app, /engineRepro: normalizeEngineOnlyResult\(payload\.engineRepro\)/u);
});

test("a 仅引擎复现 prepare request from the page is still the web channel (progress stream, web presentation)", async () => {
  const { classifyPublicRequestChannel } = await import("../backend/publicAnswerPresentation.mjs");
  assert.equal(classifyPublicRequestChannel({ ...body, engineOnly: true }), classifyPublicRequestChannel(body));
  assert.equal(classifyPublicRequestChannel({ ...body, engineOnly: true, evidenceSelector: "luna", answerLocale: "zh-CN" }),
    classifyPublicRequestChannel(body));
  assert.notEqual(classifyPublicRequestChannel({ ...body, engineOnly: false }), classifyPublicRequestChannel(body));
  assert.notEqual(classifyPublicRequestChannel({ ...body, action: undefined, engineOnly: true }), classifyPublicRequestChannel(body));
});
