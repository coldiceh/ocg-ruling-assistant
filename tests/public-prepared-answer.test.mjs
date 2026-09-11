import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createPublicAnswerHandler } from "../api/answer.js";
import {
  createPublicAnswerPreparationStore,
  PUBLIC_PREPARATION_RUNNING_TTL_SECONDS,
  PUBLIC_PREPARATION_TTL_SECONDS,
} from "../backend/publicAnswerPreparationStore.mjs";
import { preparePublicAnswer, finalizePublicAnswer } from "../backend/publicPreparedAnswerService.mjs";
import { createPublicAnswerProgress } from "../backend/publicAnswerProgress.mjs";
import { answerPublicRulingQuestion, parsePublicAnswerPayload } from "../backend/publicAnswerService.mjs";
import { classifyPublicRequestChannel, presentPublicAnswer } from "../backend/publicAnswerPresentation.mjs";

const env = { MODEL_PROVIDER: "mock", PUBLIC_RULING_MODEL_PROFILE: "official-astra-low",
  UPSTASH_REDIS_REST_URL: "https://redis.invalid", UPSTASH_REDIS_REST_TOKEN: "test-only-secret", VERCEL_GIT_COMMIT_SHA: "test-release" };
const body = { action: "prepare", question: "Synthetic test question", mode: "rag", rulingVersion: "latest", rulingModelProfile: "official-astra-low" };
const continuation = { promptBundle: { prompt: "Synthetic exact prompt\n[]\n汉字", allowedEvidenceIds: [] }, evidence: { records: [], empty: null }, cardResolution: { resolvedCards: [] } };

// Redis REST mock: atomic commands are indivisible, and values are transported
// as real JSON strings. This tests application request/storage boundaries;
// it is not a live Redis or an external model quality test.
function redisFixture({ loseCompletionAckOnce = false } = {}) {
  const values = new Map();
  const commands = [];
  let completionAckLost = false;
  const fetchImpl = async (url, options) => {
    assert.equal(url, env.UPSTASH_REDIS_REST_URL);
    const args = JSON.parse(options.body); commands.push(args);
    let result;
    if (args[0] === "SET") {
      assert.deepEqual(args.slice(3), ["EX", PUBLIC_PREPARATION_TTL_SECONDS, "NX"]);
      result = values.has(args[1]) ? null : "OK";
      if (result) values.set(args[1], args[2]);
    } else {
      assert.equal(args[0], "EVAL");
      const [, script, numberOfKeys, key, deployment] = args;
      assert.equal(numberOfKeys, 1);
      const raw = values.get(key);
      const record = raw ? JSON.parse(raw) : null;
      if (script.includes("record.state = ARGV[2]")) {
        const nextState = args[5];
        const savedResult = args[6];
        result = !record
          ? "missing"
          : record.deployment !== deployment
            ? "conflict"
            : record.state === "completed"
              ? record.result === savedResult ? "saved" : "conflict"
              : record.state !== "running" ? "conflict" : "saved";
        if (result === "saved" && record.state === "running") {
          values.set(key, JSON.stringify({ ...record, state: nextState, result: savedResult }));
          if (loseCompletionAckOnce && nextState === "completed" && !completionAckLost) {
            completionAckLost = true;
            throw new Error("synthetic lost completion acknowledgement");
          }
        }
      } else if (!record) result = ["missing"];
      else if (record.deployment !== deployment) result = ["deployment_changed"];
      else if (record.state === "completed") result = ["completed", record.result];
      else if (!script.includes('"claimed"')) result = [record.state];
      else if (record.state !== "ready") result = [record.state];
      else {
        assert.equal(args[5], PUBLIC_PREPARATION_RUNNING_TTL_SECONDS);
        assert.match(script, /"EX", ARGV\[2\]/u);
        values.set(key, JSON.stringify({ ...record, state: "running" }));
        result = ["claimed", record.preparation];
      }
    }
    return { ok: true, json: async () => ({ result }) };
  };
  return { values, commands, fetchImpl, store: createPublicAnswerPreparationStore({ env, fetchImpl }) };
}
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
const events = (res) => res.chunks.join("").split("\n\n").filter(Boolean).map(block => ({ type: block.split("\n")[0].slice(7), data: JSON.parse(block.split("\n")[1].slice(6)) }));
function fixture({
  beforeFinal = async () => {},
  earlyAnswer = false,
  readRiskControl = async () => ({ ok: true, active: false }),
  completeFailure = null,
} = {}) {
  const redis = redisFixture();
  const counts = { prepare: 0, final: 0 };
  const handlerStore = completeFailure
    ? { ...redis.store, complete: async () => { throw completeFailure; } }
    : redis.store;
  const handler = createPublicAnswerHandler({ env, createStore: () => handlerStore,
    readRiskControl,
    prepare: (options) => preparePublicAnswer({ ...options, answerPublic: async (input) => {
      counts.prepare++;
      assert.equal(input.prepareForContinuation, true);
      assert.equal(input.payload.rulingModelProfile, body.rulingModelProfile);
      input.progress.transition("extract_card_names"); input.progress.transition("retrieve_card_texts"); input.progress.transition("retrieve_rulings");
      return { answer: earlyAnswer ? { shortAnswer: "Early synthetic answer", rulingVersion: "latest" } : {
        status: "evidence_prepared", continuation, rulingVersion: "latest",
        debug: { cloudCosts: { actualCny: 0.1, theoreticalUsd: 0.2, calls: [{ id: "preparation" }] } },
      }, latency: { profileId: body.rulingModelProfile } };
    } }),
    finalize: (options) => finalizePublicAnswer({ ...options, finalize: async (input) => {
      counts.final++;
      assert.deepEqual(input.continuation, continuation);
      assert.equal(input.rulingVersion, "latest");
      assert.equal(input.env.RAG_REASONING_EFFORT, "low");
      await beforeFinal(input);
      return { shortAnswer: "Final synthetic answer", rulingVersion: "latest", effectiveRulingVersion: "latest",
        debug: { cloudCosts: { actualCny: 0.3, theoreticalUsd: 0.4, calls: [{ id: "final" }] } } };
    } }),
  });
  return { ...redis, handler, counts };
}
async function prepare(f) {
  const res = response(); await f.handler(request(body), res);
  const output = events(res);
  assert.equal(output.at(-1).type, "end");
  return { res, output, id: output.find(x => x.type === "prepared")?.data.preparationId };
}

test("an active global lock blocks finalize before claiming the preparation or calling the final model", async () => {
  const f = fixture({
    readRiskControl: async () => ({
      ok: true,
      active: true,
      remainingMinutes: 11,
    }),
  });
  const first = await prepare(f);
  const commandCountBeforeFinalize = f.commands.length;
  const storedBeforeFinalize = [...f.values.values()][0];

  const res = response();
  await f.handler(request({ action: "finalize", preparationId: first.id }), res);
  const output = events(res);
  const answer = output.find((item) => item.type === "answer")?.data.answer;

  assert.equal(answer?.answerLevel, "risk_control");
  assert.match(answer?.shortAnswer || "", /预计还需 11 分钟/u);
  assert.equal(output.at(-1)?.type, "end");
  assert.equal(f.counts.final, 0);
  assert.equal(f.commands.length, commandCountBeforeFinalize);
  assert.equal([...f.values.values()][0], storedBeforeFinalize);
  assert.equal(JSON.parse(storedBeforeFinalize).state, "ready");
});

test("two real handler invocations preserve server-only input, finalize once and replay completed answer", async () => {
  const f = fixture(); const first = await prepare(f);
  assert.match(first.id, /^[0-9a-f]{64}$/);
  assert.equal(f.counts.final, 0);
  assert.equal(first.output.some(x => x.type === "answer" || x.data.stageId === "generate_ruling"), false);
  assert.equal(first.res.chunks.join("").includes(continuation.promptBundle.prompt), false);
  const stored = JSON.parse([...f.values.values()][0]);
  assert.equal(typeof stored.preparation, "string");
  assert.deepEqual(JSON.parse(stored.preparation).continuation, continuation);
  assert.ok(![...f.values.keys()][0].includes(first.id));
  const res = response(); await f.handler(request({ action: "finalize", preparationId: first.id }), res);
  const second = events(res); const answer = second.find(x => x.type === "answer")?.data.answer;
  assert.equal(second.find(x => x.type === "error"), undefined, JSON.stringify(second));
  assert.equal(answer?.shortAnswer, "Final synthetic answer");
  assert.deepEqual(answer.debug.cloudCosts.calls.map(x => x.id), ["preparation", "final"]);
  assert.equal(answer.debug.cloudCosts.actualCny, 0.4);
  const completedRecord = JSON.parse([...f.values.values()][0]);
  const completedResult = JSON.parse(completedRecord.result);
  assert.equal(completedResult.latency.preparationId, first.id);
  assert.ok(Number.isFinite(completedResult.latency.finalizeStartedAtMs));
  assert.ok(completedResult.latency.finalizeCompletedAtMs >= completedResult.latency.finalizeStartedAtMs);
  assert.ok(completedResult.latency.completionPersistenceStartedAtMs >= completedResult.latency.finalizeCompletedAtMs);
  assert.equal(completedResult.answer.debug.requestDiagnostics.preparationId, first.id);
  assert.ok(Date.parse(completedResult.answer.debug.requestDiagnostics.finalizeStartedAt) >= 0);
  assert.ok(Date.parse(completedResult.answer.debug.requestDiagnostics.finalizeCompletedAt) >= 0);
  assert.ok(Date.parse(completedResult.answer.debug.requestDiagnostics.completionPersistenceStartedAt) >= 0);
  assert.deepEqual(second.filter(x => x.type === "stage_start").map(x => x.data.stageId), ["generate_ruling"]);
  assert.ok(second.at(-1).data.totalMs >= first.output.at(-1).data.totalMs);
  const replay = response(); await f.handler(request({ action: "finalize", preparationId: first.id }), replay);
  assert.deepEqual(events(replay).find(x => x.type === "answer").data.answer, answer);
  assert.deepEqual(f.counts, { prepare: 1, final: 1 });
});

test("concurrent finalize, failed finalize and lost claim acknowledgement cannot trigger another model", { timeout: 3000 }, async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ beforeFinal: async () => { entered(); await waiting; throw Error("synthetic final failure"); } });
  const { id } = await prepare(f); const payload = { action: "finalize", preparationId: id };
  const one = response(); const pending = f.handler(request(payload), one); await started;
  const two = response(); await f.handler(request(payload), two);
  assert.equal(two.statusCode, 409); assert.equal(two.payload.code, "answer_preparation_in_progress");
  release(); await pending;
  const three = response(); await f.handler(request(payload), three);
  assert.equal(three.statusCode, 409); assert.equal(three.payload.code, "answer_preparation_failed");
  assert.equal(f.counts.final, 1);
  let calls = 0;
  const uncertain = createPublicAnswerHandler({ env,
    createStore: () => ({ claim: async () => { throw Error("unacknowledged claim"); } }),
    finalize: async () => { calls++; },
  });
  await uncertain(request(payload), response()); assert.equal(calls, 0);
});

test("finalize payload cannot inject prompt, history, model or question; missing/deployment-changed records do not call models", async () => {
  for (const extras of [{ question: "replacement" }, { prompt: "replacement" }, { rulingModelProfile: "relay-gpt-6-astra-low" }, { messages: [] }]) {
    assert.throws(() => parsePublicAnswerPayload({ action: "finalize", preparationId: "a".repeat(64), ...extras }), { code: "invalid_preparation_id" });
  }
  assert.equal(classifyPublicRequestChannel(body), "web");
  assert.equal(classifyPublicRequestChannel({ action: "finalize", preparationId: "a".repeat(64) }), "web");
  const f = fixture(); const missing = response();
  await f.handler(request({ action: "finalize", preparationId: "a".repeat(64) }), missing);
  assert.equal(missing.statusCode, 410); assert.equal(f.counts.final, 0);
  const { id } = await prepare(f);
  const newDeployment = createPublicAnswerPreparationStore({ env: { ...env, VERCEL_GIT_COMMIT_SHA: "changed-release" }, fetchImpl: f.fetchImpl });
  await assert.rejects(newDeployment.claim(id), { code: "answer_preparation_deployment_changed" });
  assert.equal(f.counts.final, 0);
});

test("status payload accepts only a valid preparationId", () => {
  const preparationId = "a".repeat(64);
  assert.deepEqual(
    parsePublicAnswerPayload({ action: "status", preparationId }),
    { action: "status", preparationId },
  );
  for (const extras of [{ question: "replacement" }, { prompt: "replacement" }, { messages: [] }]) {
    assert.throws(
      () => parsePublicAnswerPayload({ action: "status", preparationId, ...extras }),
      { code: "invalid_preparation_id" },
    );
  }
  assert.throws(
    () => parsePublicAnswerPayload({ action: "status", preparationId: "short" }),
    { code: "invalid_preparation_id" },
  );
});

test("status is rejected by the direct answer service and remains confined to saved-preparation recovery", async () => {
  await assert.rejects(
    answerPublicRulingQuestion({
      payload: { action: "status", preparationId: "a".repeat(64) },
      env,
    }),
    { code: "invalid_answer_action" },
  );
});

test("status reads ready, running, failed and completed records without claiming or calling the final model", async () => {
  const readyFixture = fixture();
  const ready = await prepare(readyFixture);
  const storedReady = [...readyFixture.values.values()][0];
  const readyResponse = response();
  await readyFixture.handler(request({ action: "status", preparationId: ready.id }), readyResponse);
  assert.deepEqual(readyResponse.payload, { status: "ready" });
  assert.equal([...readyFixture.values.values()][0], storedReady);

  await readyFixture.store.claim(ready.id);
  const storedRunning = [...readyFixture.values.values()][0];
  const runningResponse = response();
  await readyFixture.handler(request({ action: "status", preparationId: ready.id }), runningResponse);
  assert.deepEqual(runningResponse.payload, { status: "running" });
  assert.equal([...readyFixture.values.values()][0], storedRunning);

  const recoveredResult = { answer: { shortAnswer: "Recovered synthetic answer" }, latency: { profileId: "synthetic" } };
  await readyFixture.store.complete(ready.id, recoveredResult);
  const completedResponse = response();
  await readyFixture.handler(request({ action: "status", preparationId: ready.id }), completedResponse);
  assert.deepEqual(completedResponse.payload, { status: "completed", result: recoveredResult });
  assert.deepEqual(
    completedResponse.payload.result.answer,
    presentPublicAnswer(recoveredResult.answer, { channel: "web", env }),
  );
  assert.equal(readyFixture.counts.final, 0);

  const failedFixture = fixture();
  const failed = await prepare(failedFixture);
  await failedFixture.store.claim(failed.id);
  await failedFixture.store.fail(failed.id);
  const failedResponse = response();
  await failedFixture.handler(request({ action: "status", preparationId: failed.id }), failedResponse);
  assert.deepEqual(failedResponse.payload, { status: "failed" });
  assert.equal(failedFixture.counts.final, 0);
});

test("claim renews the running TTL and completion tolerates an identical retry or lost acknowledgement", async () => {
  const f = redisFixture({ loseCompletionAckOnce: true });
  const id = await f.store.create({ continuation });
  await f.store.claim(id);
  const claimCommand = f.commands.find((args) => args[0] === "EVAL" && args[1].includes('"claimed"'));
  assert.equal(claimCommand[5], PUBLIC_PREPARATION_RUNNING_TTL_SECONDS);

  const result = { answer: { shortAnswer: "Synthetic persisted answer" }, latency: { durationMs: 42 } };
  const commandsBeforeCompletion = f.commands.length;
  await f.store.complete(id, result);
  assert.equal(f.commands.length - commandsBeforeCompletion, 2, "one write plus one read-only confirmation");
  assert.deepEqual(await f.store.status(id), { state: "completed", result });
  await f.store.complete(id, result);
  await assert.rejects(
    f.store.complete(id, { ...result, latency: { durationMs: 43 } }),
    { code: "answer_preparation_save_unconfirmed" },
  );
});

test("an unconfirmed completion save is reported in the delivered answer without another final-model call", async () => {
  const f = fixture({
    completeFailure: Object.assign(new Error("internal storage detail"), {
      code: "answer_preparation_save_unconfirmed",
    }),
  });
  const { id } = await prepare(f);
  const res = response();
  await f.handler(request({ action: "finalize", preparationId: id }), res);
  const answer = events(res).find((event) => event.type === "answer")?.data.answer;
  assert.deepEqual(answer.debug.requestDiagnostics.completionPersistence, {
    status: "save-unconfirmed",
    code: "answer_preparation_save_unconfirmed",
  });
  assert.equal(JSON.stringify(answer).includes("internal storage detail"), false);
  assert.equal(f.counts.final, 1);
  assert.equal(JSON.parse([...f.values.values()][0]).state, "running");
});

test("early answer does not create a preparation; aborted final never reaches model", async () => {
  const f = fixture({ earlyAnswer: true }); const { output } = await prepare(f);
  assert.equal(output.find(x => x.type === "answer").data.answer.shortAnswer, "Early synthetic answer");
  assert.equal(output.some(x => x.type === "prepared"), false); assert.equal(f.values.size, 0);
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(finalizePublicAnswer({ preparation: {}, env, signal: controller.signal, finalize: async () => { calls++; } }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("independent final phase can complete after the old total 300-second boundary without resetting preparation timings", () => {
  let clock = 0; const prep = createPublicAnswerProgress({ now: () => clock }); prep.start();
  clock = 290000; const first = prep.complete();
  clock = 0; const emitted = [];
  const final = createPublicAnswerProgress({ now: () => clock, initialStageId: "generate_ruling", initialProgress: first, emit: (type, data) => emitted.push({ type, data }) });
  final.start(); clock = 100000; const second = final.complete();
  assert.equal(second.totalMs, 390000);
  assert.equal(second.stageDurationsMs.understand, 290000);
  assert.equal(second.stageDurationsMs.generate_ruling, 100000);
  assert.equal(emitted[0].data.serverElapsedMs, 290000);
});

test("storage failures do not leak credentials or retry, and configuration absence fails before generation", async () => {
  let requests = 0;
  const store = createPublicAnswerPreparationStore({ env, fetchImpl: async () => { requests++; throw Error(env.UPSTASH_REDIS_REST_TOKEN); } });
  await assert.rejects(store.create({ continuation }), error => error.code === "answer_preparation_storage_unavailable" && !error.message.includes(env.UPSTASH_REDIS_REST_TOKEN));
  assert.equal(requests, 1);
  let prepares = 0;
  const handler = createPublicAnswerHandler({ env: {}, prepare: async () => { prepares++; } });
  const res = response(); await handler(request(body), res);
  assert.equal(res.statusCode, 503); assert.equal(prepares, 0);
});
