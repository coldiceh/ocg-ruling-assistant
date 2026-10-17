import assert from "node:assert/strict";
import test from "node:test";
import { appendEngineReproSection, attachEngineReproWhenReady, awaitEngineReproAtMainCompletion, createEngineReproSession,
  engineReproSectionText } from "../backend/engineRepro/session.mjs";
import { createEngineReproLimits } from "../backend/engineRepro/limits.mjs";

function fakeRedis() {
  const data = new Map();
  const command = async (_env, _fetch, [op, key, value, ...rest]) => {
    if (op === "SET") { data.set(key, value); return "OK"; }
    if (op === "GET") return data.has(key) ? data.get(key) : null;
    if (op === "INCR") { const v = Number(data.get(key) || 0) + 1; data.set(key, String(v)); return v; }
    if (op === "INCRBYFLOAT") { const v = Number(data.get(key) || 0) + Number(value); data.set(key, String(v)); return String(v); }
    if (op === "EXPIRE") return 1;
    throw new Error(`unexpected ${op} ${rest}`);
  };
  return { data, command };
}

const plan = {
  applicability: "applicable", reason_code: null, archetype_name: null, quoted_span: "q", what_not_why: false,
  assumptions: [], extra_cards: [],
  sub_questions: [{ id: "q1", quoted_span: "q", unrepresentable: null, branches: [{ id: "b1", assumption: null,
    scenario: { schema: "ocg-repro-scenario/v1", seed: 1, first_player: 0, players: [{ lp: 8000, hand: [14558127] }, { lp: 8000 }] },
    actions: { schema: "ocg-repro-actions/v1", setup: [], probes: [] }, observe: "x" }] }],
};

const engine = async (op) => {
  if (op === "cards") return { cards: [{ code: 14558127, exists: true, name: "灰流丽", types: ["怪兽"] }] };
  if (op === "related") return { related: [] };
  if (op === "setnames") return { setnames: {} };
  if (op === "reproduce") return { result: { status: "replayed", probes: [], rendered_zh: "【引擎复现】\n状态：已按步骤回放完成" } };
  throw new Error(op);
};

const cardResolution = { resolvedCards: [{ id: "12950", input: "灰流丽", resolutionSource: "model_canonical_exact" }] };
const cards = [{ id: "12950", name: "灰流丽", effectText: "text" }];

function makeSession({ delayMs, clockRef, redis, isAdmin = true, auditId = "audit-1", limits }) {
  const pending = [];
  const session = createEngineReproSession({
    env: { ENGINE_REPRO_ENABLED: "true" }, isAdmin, requestStartedAt: 0, auditIdPromise: Promise.resolve(auditId),
    now: () => clockRef.t, waitUntil: (p) => pending.push(p), engine, cidMap: { 12950: 14558127 },
    limits: limits || { admit: async () => {}, reserve: async () => ({}), settle: async () => {} },
    modelCall: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      clockRef.t += delayMs;
      return { status: "completed", outputText: JSON.stringify(plan), usage: {}, costUsd: 0, ms: delayMs };
    },
    command: redis.command, saveAudit: async (id, patch) => { redis.data.set(`audit:${id}`, JSON.stringify(patch)); },
  });
  return { session, pending };
}

// Fake clock for the waiting side: each poll sleep yields to the event loop and advances the clock.
const pollSleep = (clockRef) => async (ms) => { await new Promise((r) => setTimeout(r, 2)); clockRef.t += ms; };

test("finished before the answer: attached right away, nothing waited, no answer delay recorded", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 5, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await Promise.all(pending);
  clockRef.t = 9000;
  const answer = await attachEngineReproWhenReady({ shortAnswer: "主回答" },
    { env: {}, auditId: "audit-1", requestStartedAt: 0, waitDeadlineAt: 280000, now: () => clockRef.t, command: redis.command,
      sleep: pollSleep(clockRef) });
  assert.equal(answer.engineRepro.status, "done");
  assert.equal(answer.engineRepro.questionStatus, "已复现");
  assert.equal(answer.engineRepro.waitedMs, 0);
  assert.equal(answer.engineRepro.mainCompletedAtMs, 9000);
  assert.match(answer.shortAnswer, /^主回答\n\n【引擎复现/u);
  const audit = JSON.parse(redis.data.get("audit:audit-1"));
  assert.equal(audit.engineRepro.status, "已复现");
  assert.equal(audit.engineRepro.answerDelay, null);
});

test("not finished when the answer completes: the response waits for it; the delay is recorded", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 30, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await new Promise((r) => setTimeout(r, 0));             // let the start record land
  const answer = await attachEngineReproWhenReady({ shortAnswer: "主回答" },   // the answer completes now
    { env: {}, auditId: "audit-1", requestStartedAt: 0, waitDeadlineAt: 280000, now: () => clockRef.t, command: redis.command,
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, 5)); } });
  assert.equal(answer.engineRepro.status, "done");
  // the answer text carries only the short section; the full replay stays in engineRepro.rendered
  assert.match(answer.shortAnswer, /^主回答\n\n【引擎复现（实验性）】已复现\n\n引擎在下面的局面里：/u);
  assert.match(answer.shortAnswer, /局面：我方手卡 灰流丽。/u);
  assert.doesNotMatch(answer.shortAnswer, /状态：|未经评测|【引擎复现】/u);
  assert.match(answer.engineRepro.rendered, /^【引擎复现（实验性，未经评测）】\n状态：已复现/u);
  assert.match(answer.engineRepro.rendered, /【引擎复现】\n {2}状态：已按步骤回放完成/u);
  assert.equal(answer.shortAnswer.endsWith(answer.engineRepro.concise), true);
  await Promise.all(pending);
  const audit = JSON.parse(redis.data.get("audit:audit-1"));
  assert.equal(audit.engineRepro.answerDelay.delayMs, 30);
  assert.equal(audit.engineRepro.answerDelay.mainCompletedAtMs, 1000);
});

test("two requests (prepare, then finalize): finalize waits on the stored result by history-record id", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 30, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });   // in the preparation request
  await new Promise((r) => setTimeout(r, 0));
  // the finalize request knows only the audit id and the preparation's request start
  const section = await awaitEngineReproAtMainCompletion({ env: {}, auditId: "audit-1", requestStartedAt: 0,
    waitDeadlineAt: 280000, now: () => clockRef.t, command: redis.command, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); } });
  assert.equal(section.status, "done");
  assert.equal(section.questionStatus, "已复现");
  assert.equal(section.digest.status, "已复现");
  assert.match(section.rendered, /^【引擎复现（实验性，未经评测）】/u);
  await Promise.all(pending);
});

test("past the wait deadline: the answer goes out with a notice; the late result is still stored and marked", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  let release;
  const gate = new Promise((r) => { release = r; });
  const pending = [];
  const session = createEngineReproSession({
    env: { ENGINE_REPRO_ENABLED: "true" }, isAdmin: true, requestStartedAt: 0, auditIdPromise: Promise.resolve("audit-t"),
    now: () => clockRef.t, waitUntil: (p) => pending.push(p), engine, cidMap: { 12950: 14558127 },
    limits: { admit: async () => {}, reserve: async () => ({}), settle: async () => {} },
    modelCall: async () => { await gate; clockRef.t += 500000;
      return { status: "completed", outputText: JSON.stringify(plan), usage: {}, costUsd: 0, ms: 1 }; },
    command: redis.command, saveAudit: async (id, patch) => { redis.data.set(`audit:${id}`, JSON.stringify(patch)); },
  });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await new Promise((r) => setTimeout(r, 0));
  const answer = await attachEngineReproWhenReady({ shortAnswer: "主回答" },
    { env: {}, auditId: "audit-t", requestStartedAt: 0, waitDeadlineAt: 4000, pollMs: 1000, now: () => clockRef.t,
      command: redis.command, sleep: pollSleep(clockRef) });
  assert.equal(answer.engineRepro.status, "timeout");
  assert.equal(answer.engineRepro.waitedMs, 3000);
  assert.match(answer.shortAnswer, /^主回答\n\n【引擎复现（实验性）】未完成\n\n引擎复现在等待上限内未完成（复现已耗时 3\.0 秒，主回答完成后已等待 3\.0 秒）/u);
  release();
  await Promise.all(pending);
  const audit = JSON.parse(redis.data.get("audit:audit-t"));
  assert.equal(audit.engineRepro.answerDelay.waitTimedOutAtMs, 4000);
});

test("a reproduction that never started is not waited for", async () => {
  const redis = fakeRedis();
  let slept = 0;
  const section = await awaitEngineReproAtMainCompletion({ env: {}, auditId: "audit-none", requestStartedAt: 0,
    waitDeadlineAt: 280000, now: () => 5, command: redis.command, sleep: async () => { slept += 1; } });
  assert.equal(section, null);
  assert.equal(slept, 0);
  assert.equal(engineReproSectionText(null), "");
});

test("not an administrator: nothing runs and nothing is attached", async () => {
  const redis = fakeRedis();
  const { session, pending } = makeSession({ delayMs: 1, clockRef: { t: 0 }, redis, isAdmin: false });
  assert.equal(session.enabled, false);
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  assert.equal(pending.length, 0);
  const answer = await attachEngineReproWhenReady({ shortAnswer: "a" },
    { env: {}, auditId: "audit-1", requestStartedAt: 0, waitDeadlineAt: 280000, now: () => 0, command: redis.command });
  assert.equal(answer.shortAnswer, "a");
  assert.equal(appendEngineReproSection({ shortAnswer: "a" }, null).shortAnswer, "a");
});

test("own daily budget bucket: refusal fails the reproduction closed", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 0 };
  const limits = createEngineReproLimits({ env: { ENGINE_REPRO_DAILY_LIMIT_USD: "0.001" }, command: redis.command, now: () => 0 });
  const session = createEngineReproSession({
    env: { ENGINE_REPRO_ENABLED: "true", ENGINE_REPRO_OPENAI_API_KEY: "k" }, isAdmin: true, requestStartedAt: 0,
    auditIdPromise: Promise.resolve("a2"), now: () => clockRef.t, waitUntil: () => {}, engine, cidMap: { 12950: 14558127 },
    limits, command: redis.command, saveAudit: async () => {},
    fetchImpl: async () => { throw new Error("must not reach the model"); },
  });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  const record = await session.promise;
  assert.equal(record.summary.status, "未复现");
  assert.deepEqual(record.summary.reasonCodes, ["budget_exceeded"]);
});

test("answer service wiring: the pipeline gets the observer and the finished section follows the answer", async () => {
  const { answerPublicRulingQuestion } = await import("../backend/publicAnswerService.mjs");
  const redis = fakeRedis();
  const clockRef = { t: 0 };
  let observed = null;
  const result = await answerPublicRulingQuestion({
    payload: { question: "Synthetic question" },
    env: { MODEL_PROVIDER: "mock", UPSTASH_REDIS_REST_URL: "https://redis.example.test", UPSTASH_REDIS_REST_TOKEN: "t",
      ENGINE_REPRO_ENABLED: "true" },
    engineReproAdmin: true,
    appendAudit: async () => ({ entry: { id: "audit-w" } }),
    updateAudit: async () => ({ updated: true }),
    assetsResident: () => true,
    classifyScope: async () => ({ scope: "in_scope", confidence: "high" }),
    readRiskControl: async () => ({ ok: true, active: false }),
    preloadAssets: () => ({}),
    createEngineRepro: (options) => {
      const made = makeSession({ delayMs: 1, clockRef, redis, auditId: "audit-w" });
      observed = { options, made };
      return made.session;
    },
    attachEngineRepro: (answer, options) => {
      assert.equal(options.auditId, "audit-w");
      assert.ok(options.waitDeadlineAt - Date.now() > 270000, "deadline counted from this invocation");
      return attachEngineReproWhenReady(answer, { ...options, now: () => clockRef.t, command: redis.command });
    },
    answerRuling: async (options) => {
      assert.equal(typeof options.onCardTextsReady, "function");
      options.onCardTextsReady({ question: "Synthetic question", cardResolution, cards });
      await Promise.all(observed.made.pending);
      return { shortAnswer: "Synthetic ruling" };
    },
  });
  assert.equal(observed.options.isAdmin, true);
  assert.match(result.answer.shortAnswer, /^Synthetic ruling\n\n【引擎复现/u);
  assert.equal(result.answer.engineRepro.status, "done");
});

test("answer service wiring: without an admin session the pipeline gets no observer", async () => {
  const { answerPublicRulingQuestion } = await import("../backend/publicAnswerService.mjs");
  const result = await answerPublicRulingQuestion({
    payload: { question: "Synthetic question" },
    env: { MODEL_PROVIDER: "mock", ENGINE_REPRO_ENABLED: "true" },
    appendAudit: async () => null, assetsResident: () => true, preloadAssets: () => ({}),
    classifyScope: async () => ({ scope: "in_scope", confidence: "high" }),
    readRiskControl: async () => ({ ok: true, active: false }),
    answerRuling: async (options) => {
      assert.equal(options.onCardTextsReady, undefined);
      return { shortAnswer: "Synthetic ruling" };
    },
  });
  assert.equal(result.answer.shortAnswer, "Synthetic ruling");
  assert.equal(result.answer.engineRepro, undefined);
});

test("both request shapes give the same short section; the official Q&A line follows the evidence-pack count", async () => {
  const { finalizePublicAnswer } = await import("../backend/publicPreparedAnswerService.mjs");
  const { OFFICIAL_QA_ABSENT_LINE, OFFICIAL_QA_PRESENT_LINE } = await import("../backend/engineRepro/concise.mjs");
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 1, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await Promise.all(pending);
  const options = { env: {}, auditId: "audit-1", requestStartedAt: 0, waitDeadlineAt: 280000, now: () => clockRef.t,
    command: redis.command };
  const mainAnswer = (count) => ({ shortAnswer: "主回答", debug: { retrievalCounts: { officialQaDirectCandidates: count } } });

  const single = await attachEngineReproWhenReady(mainAnswer(0), options);
  const prepared = await finalizePublicAnswer({
    preparation: { profileId: "official-astra-low", pipeline: "rag_baseline", continuation: { promptBundle: { prompt: "x" } },
      rulingVersion: "latest", startedAt: 0, auditId: "audit-1", requestDiagnostics: { scope: { scope: "in_scope" } },
      progress: { totalMs: 0 }, engineRepro: { enabled: true, requestStartedAt: 0 } },
    env: { MODEL_PROVIDER: "mock" },
    selectProfile: async () => ({ profile: { id: "official-astra-low", provider: "openai" } }),
    finalize: async () => mainAnswer(0), addGeneration: async (answer) => answer, updateAudit: async () => ({ updated: true }),
    attachEngineRepro: (answer, attachOptions) => attachEngineReproWhenReady(answer, { ...attachOptions, now: () => clockRef.t,
      command: redis.command }),
  });
  assert.equal(prepared.answer.shortAnswer, single.shortAnswer);
  assert.equal(prepared.answer.engineRepro.rendered, single.engineRepro.rendered);
  assert.ok(single.shortAnswer.includes(OFFICIAL_QA_ABSENT_LINE));
  const withDirect = await attachEngineReproWhenReady(mainAnswer(1), options);
  assert.ok(withDirect.shortAnswer.includes(OFFICIAL_QA_PRESENT_LINE));
  assert.ok(!withDirect.shortAnswer.includes(OFFICIAL_QA_ABSENT_LINE));
});
