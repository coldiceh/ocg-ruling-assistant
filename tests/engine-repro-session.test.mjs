import assert from "node:assert/strict";
import test from "node:test";
import { appendEngineReproSection, attachEngineReproWhenReady, awaitEngineReproAtMainCompletion, createEngineReproSession,
  engineReproSectionText } from "../backend/engineRepro/session.mjs";
import { createEngineReproLimits } from "../backend/engineRepro/limits.mjs";
import { engineReproDigest } from "../backend/engineRepro/concise.mjs";

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

function makeSession({ delayMs, clockRef, redis, auditId = "audit-1", limits, env = { ENGINE_REPRO_ENABLED: "true" } }) {
  const pending = [];
  const session = createEngineReproSession({
    env, requestStartedAt: 0, auditIdPromise: Promise.resolve(auditId),
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
  assert.match(answer.shortAnswer, /^主回答\n\n【ygopro 引擎复现/u);
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
  assert.match(answer.shortAnswer, /^主回答\n\n【ygopro 引擎复现（实验性）】已复现\n\nygopro（MyCard 版核心）的运行结果：\n- /u);
  // the engine returned nothing to look at: no conclusion call was made for it
  assert.equal(answer.engineRepro.conclusion.status, "skipped");
  assert.equal(answer.engineRepro.timings.conclusionMs, 0);
  assert.match(answer.shortAnswer, /局面：我方手卡 灰流丽。/u);
  assert.doesNotMatch(answer.shortAnswer, /状态：|未经评测|【引擎复现】/u);
  assert.match(answer.engineRepro.rendered, /^【ygopro 引擎复现（实验性，未经评测）】\n状态：已复现/u);
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
  assert.match(section.rendered, /^【ygopro 引擎复现（实验性，未经评测）】/u);
  await Promise.all(pending);
});

test("past the wait deadline: the answer goes out with a notice; the late result is still stored and marked", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  let release;
  const gate = new Promise((r) => { release = r; });
  const pending = [];
  const session = createEngineReproSession({
    env: { ENGINE_REPRO_ENABLED: "true" }, requestStartedAt: 0, auditIdPromise: Promise.resolve("audit-t"),
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
  assert.match(answer.shortAnswer, /^主回答\n\n【ygopro 引擎复现（实验性）】未完成\n\nygopro 引擎复现在等待上限内未完成（复现已耗时 3\.0 秒，主回答完成后已等待 3\.0 秒）/u);
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

test("switch off (ENGINE_REPRO_ENABLED not on): nothing runs and nothing is attached", async () => {
  const redis = fakeRedis();
  const { session, pending } = makeSession({ delayMs: 1, clockRef: { t: 0 }, redis, env: { ENGINE_REPRO_ENABLED: "false" } });
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
    env: { ENGINE_REPRO_ENABLED: "true", ENGINE_REPRO_OPENAI_API_KEY: "k" }, requestStartedAt: 0,
    auditIdPromise: Promise.resolve("a2"), now: () => clockRef.t, waitUntil: () => {}, engine, cidMap: { 12950: 14558127 },
    limits, command: redis.command, saveAudit: async () => {},
    fetchImpl: async () => { throw new Error("must not reach the model"); },
  });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  const record = await session.promise;
  assert.equal(record.summary.status, "未复现");
  assert.deepEqual(record.summary.reasonCodes, ["budget_exceeded"]);
  // the user-visible notice is one line that names ygopro
  assert.equal(engineReproSectionText({ status: "done", digest: engineReproDigest(record) }),
    "【ygopro 引擎复现（实验性）】今日额度已用完，本题没有完成 ygopro 复现。");
});

test("own per-minute limit: refusal fails the reproduction closed with a one-line notice", async () => {
  const redis = fakeRedis();
  const limits = createEngineReproLimits({ env: { ENGINE_REPRO_MAX_PER_MINUTE: "1" }, command: redis.command, now: () => 0 });
  const run = async () => {
    const session = createEngineReproSession({
      env: { ENGINE_REPRO_ENABLED: "true" }, requestStartedAt: 0, auditIdPromise: Promise.resolve(null), now: () => 0,
      waitUntil: () => {}, engine, cidMap: { 12950: 14558127 }, limits, command: redis.command, saveAudit: async () => {},
      modelCall: async () => ({ status: "completed", outputText: JSON.stringify(plan), usage: {}, costUsd: 0, ms: 1 }),
    });
    session.onCardTextsReady({ question: "q", cardResolution, cards });
    return session.promise;
  };
  assert.equal((await run()).summary.status, "已复现");
  const refused = await run();
  assert.equal(refused.summary.status, "未复现");
  assert.deepEqual(refused.summary.reasonCodes, ["budget_exceeded"]);
  const text = engineReproSectionText({ status: "done", digest: engineReproDigest(refused) });
  assert.equal(text, "【ygopro 引擎复现（实验性）】每分钟次数已达上限，本题没有运行 ygopro 复现。");
  assert.doesNotMatch(text, /\n/u);
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
  assert.equal("isAdmin" in observed.options, false, "the session is gated by ENGINE_REPRO_ENABLED only");
  assert.match(result.answer.shortAnswer, /^Synthetic ruling\n\n【ygopro 引擎复现/u);
  assert.equal(result.answer.engineRepro.status, "done");
});

// Public since 2026-10-16 (stage 4): no administrator session is involved; only the switch decides.
function publicServiceDoubles({ redis, clockRef, auditId, sessions }) {
  return {
    appendAudit: async () => ({ entry: { id: auditId } }), updateAudit: async () => ({ updated: true }),
    assetsResident: () => true, preloadAssets: () => ({}),
    classifyScope: async () => ({ scope: "in_scope", confidence: "high" }),
    readRiskControl: async () => ({ ok: true, active: false }),
    // the real session factory with test doubles; the gate sees the request's own env
    createEngineRepro: (options) => {
      const made = makeSession({ delayMs: 1, clockRef, redis, auditId, env: options.env });
      sessions.push(made);
      return made.session;
    },
  };
}
const publicRuling = (sessions, answer) => async (options) => {
  options.onCardTextsReady?.({ question: "Synthetic question", cardResolution, cards });
  await Promise.all(sessions.flatMap((made) => made.pending));
  return answer;
};
const mainCounts = { officialQaDirectCandidates: 0, officialQaRelated: 1 };
// Judge material and an EXACT result (the judge itself is tested in official-qa-correspondence.test.mjs).
const judgeMaterial = { schema: "official-qa-judge-input/v1", userQuery: "Synthetic question", userCards: [],
  candidates: [{ id: "ygoresources-qa-1", rawQuestion: "合成题面", handle: "h1", displayTitle: "合成官方问答" }] };
const exactJudge = { status: "done", exact: [{ id: "ygoresources-qa-1", title: "合成官方问答", handle: "h1" }],
  assessments: [{ id: "ygoresources-qa-1", verdict: "EXACT", differences: [], reason: "同" }] };
const EXACT_LINE = "判断模型认为官方 Q&A【合成官方问答】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。";

for (const switchOn of [true, false]) {
  test(`single request, public (no admin session): switch ${switchOn ? "on -> engine section" : "off -> no engine section"}`, async () => {
    const { answerPublicRulingQuestion } = await import("../backend/publicAnswerService.mjs");
    const redis = fakeRedis();
    const clockRef = { t: 0 };
    const sessions = [];
    let observer = null;
    let evidenceObserver = null;
    const judgeStarts = [];
    const ruling = publicRuling(sessions, { shortAnswer: "Synthetic ruling", debug: { retrievalCounts: mainCounts } });
    const env = { MODEL_PROVIDER: "mock", ...(switchOn ? { ENGINE_REPRO_ENABLED: "true" } : {}) };
    const result = await answerPublicRulingQuestion({
      payload: { question: "Synthetic question" }, env,
      ...publicServiceDoubles({ redis, clockRef, auditId: "audit-s", sessions }),
      attachEngineRepro: (answer, options) => attachEngineReproWhenReady(answer, { ...options, requestStartedAt: 0,
        now: () => clockRef.t, command: redis.command }),
      startJudge: (options) => { judgeStarts.push(options); return Promise.resolve(exactJudge); },
      answerRuling: async (options) => {
        observer = options.onCardTextsReady;
        evidenceObserver = options.onEvidencePrepared;
        // the pipeline calls the evidence observer before its final model call
        options.onEvidencePrepared?.({ officialQaJudgeInput: judgeMaterial });
        return ruling(options);
      },
    });
    if (switchOn) {
      assert.equal(typeof observer, "function");
      assert.equal(typeof evidenceObserver, "function");
      assert.equal(judgeStarts.length, 1);
      assert.equal(judgeStarts[0].input, judgeMaterial);
      assert.equal(judgeStarts[0].env, env, "the judge gets the request's own env, like the reproduction session");
      assert.match(result.answer.shortAnswer, /^Synthetic ruling\n\n【ygopro 引擎复现（实验性）】已复现/u);
      assert.ok(result.answer.shortAnswer.includes(EXACT_LINE));
      assert.equal(result.answer.engineRepro.status, "done");
      assert.equal(result.answer.engineRepro.officialQaJudge.status, "done");
    } else {
      assert.equal(observer, undefined);
      assert.equal(evidenceObserver, undefined);
      assert.equal(judgeStarts.length, 0);
      assert.equal(result.answer.shortAnswer, "Synthetic ruling");
      assert.equal(result.answer.engineRepro, undefined);
    }
  });

  test(`two requests (prepare + finalize), public: switch ${switchOn ? "on -> engine section" : "off -> no engine section"}`, async () => {
    const { answerPublicRulingQuestion } = await import("../backend/publicAnswerService.mjs");
    const { preparePublicAnswer, finalizePublicAnswer } = await import("../backend/publicPreparedAnswerService.mjs");
    const redis = fakeRedis();
    const clockRef = { t: 0 };
    const sessions = [];
    const env = { MODEL_PROVIDER: "mock", ...(switchOn ? { ENGINE_REPRO_ENABLED: "true" } : {}) };
    let stored = null;
    const prepared = await preparePublicAnswer({
      payload: { question: "Synthetic question", action: "prepare" }, env,
      progress: { complete: () => ({ totalMs: 0 }) },
      store: { create: async (value) => { stored = value; return "prep-1"; } },
      updateAudit: async () => ({ updated: true }),
      answerPublic: (input) => answerPublicRulingQuestion({ ...input,
        ...publicServiceDoubles({ redis, clockRef, auditId: "audit-p", sessions }),
        answerRuling: publicRuling(sessions, { status: "evidence_prepared", rulingVersion: "latest",
          continuation: { promptBundle: { prompt: "Synthetic saved prompt" }, officialQaJudgeInput: judgeMaterial } }) }),
    });
    assert.equal(prepared.preparationId, "prep-1");
    if (switchOn) assert.equal(stored.engineRepro.enabled, true);
    else assert.equal(stored.engineRepro, null);
    const order = [];
    const judgeStarts = [];
    const finalized = await finalizePublicAnswer({
      preparation: stored, env,
      selectProfile: async () => ({ profile: { id: "official-astra-low", provider: "openai" } }),
      finalize: async () => { order.push("final model"); return { shortAnswer: "主回答", debug: { retrievalCounts: mainCounts } }; },
      addGeneration: async (answer) => answer, updateAudit: async () => ({ updated: true }),
      startJudge: (options) => { order.push("judge started"); judgeStarts.push(options); return Promise.resolve(exactJudge); },
      attachEngineRepro: (answer, options) => attachEngineReproWhenReady(answer, { ...options, requestStartedAt: 0,
        now: () => clockRef.t, command: redis.command }),
    });
    if (switchOn) {
      assert.deepEqual(order, ["judge started", "final model"], "the judge runs alongside the final model call");
      assert.deepEqual(judgeStarts[0].input, judgeMaterial, "the material fixed when the evidence was prepared");
      assert.match(finalized.answer.shortAnswer, /^主回答\n\n【ygopro 引擎复现（实验性）】已复现/u);
      assert.ok(finalized.answer.shortAnswer.includes(EXACT_LINE));
      assert.equal(finalized.answer.engineRepro.status, "done");
    } else {
      assert.deepEqual(order, ["final model"]);
      assert.equal(finalized.answer.shortAnswer, "主回答");
      assert.equal(finalized.answer.engineRepro, undefined);
    }
  });
}

test("both request shapes give the same short section; the official Q&A line follows the judge only", async () => {
  const { finalizePublicAnswer } = await import("../backend/publicPreparedAnswerService.mjs");
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 1, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await Promise.all(pending);
  const options = { env: {}, auditId: "audit-1", requestStartedAt: 0, waitDeadlineAt: 280000, now: () => clockRef.t,
    command: redis.command };
  // The evidence-pack counts no longer choose any line.
  const mainAnswer = () => ({ shortAnswer: "主回答",
    debug: { retrievalCounts: { officialQaDirectCandidates: 3, officialQaRelated: 4 } } });

  const single = await attachEngineReproWhenReady(mainAnswer(), { ...options, officialQaJudge: Promise.resolve(exactJudge) });
  const prepared = await finalizePublicAnswer({
    preparation: { profileId: "official-astra-low", pipeline: "rag_baseline",
      continuation: { promptBundle: { prompt: "x" }, officialQaJudgeInput: judgeMaterial },
      rulingVersion: "latest", startedAt: 0, auditId: "audit-1", requestDiagnostics: { scope: { scope: "in_scope" } },
      progress: { totalMs: 0 }, engineRepro: { enabled: true, requestStartedAt: 0 } },
    env: { MODEL_PROVIDER: "mock" },
    selectProfile: async () => ({ profile: { id: "official-astra-low", provider: "openai" } }),
    finalize: async () => mainAnswer(), addGeneration: async (answer) => answer, updateAudit: async () => ({ updated: true }),
    startJudge: async () => exactJudge,
    attachEngineRepro: (answer, attachOptions) => attachEngineReproWhenReady(answer, { ...attachOptions, now: () => clockRef.t,
      command: redis.command }),
  });
  assert.equal(prepared.answer.shortAnswer, single.shortAnswer);
  assert.equal(prepared.answer.engineRepro.rendered, single.engineRepro.rendered);
  assert.ok(single.shortAnswer.includes(EXACT_LINE));
  const lines = single.engineRepro.concise.split("\n\n");
  assert.equal(lines.at(-2), EXACT_LINE, "the line sits right before the disclaimer");

  const noJudge = await attachEngineReproWhenReady(mainAnswer(), options);
  assert.ok(!noJudge.shortAnswer.includes("官方 Q&A"), "no judge result, no official-Q&A line (counts are ignored)");
  assert.equal(noJudge.engineRepro.officialQaJudge, null);
  const partialOnly = await attachEngineReproWhenReady(mainAnswer(), { ...options, officialQaJudge: Promise.resolve({ status: "done",
    exact: [], assessments: [{ id: "ygoresources-qa-1", verdict: "PARTIAL", differences: ["时点"], reason: "r" }] }) });
  assert.ok(!partialOnly.shortAnswer.includes("官方 Q&A"));
  assert.deepEqual(partialOnly.engineRepro.officialQaJudge.verdicts, { EXACT: 0, PARTIAL: 1, NOT: 0 });
  const rejected = await attachEngineReproWhenReady(mainAnswer(), { ...options, officialQaJudge: Promise.reject(new Error("boom")) });
  assert.ok(!rejected.shortAnswer.includes("官方 Q&A"));
  assert.match(rejected.shortAnswer, /【ygopro 引擎复现（实验性）】已复现/u);
});

test("the section waits for a judge that finishes after the reproduction's result is stored", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 1, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await Promise.all(pending);
  let release;
  const late = new Promise((resolve) => { release = resolve; });
  const attached = attachEngineReproWhenReady({ shortAnswer: "主回答" }, { env: {}, auditId: "audit-1", requestStartedAt: 0,
    waitDeadlineAt: 280000, now: () => clockRef.t, command: redis.command, officialQaJudge: late });
  setTimeout(() => release(exactJudge), 20);
  const answer = await attached;
  assert.ok(answer.shortAnswer.includes(EXACT_LINE));
  // a section that never started is not waited for and gets no line, whatever the judge says
  assert.equal((await attachEngineReproWhenReady({ shortAnswer: "a" }, { env: {}, auditId: "audit-none", requestStartedAt: 0,
    waitDeadlineAt: 280000, now: () => clockRef.t, command: redis.command, officialQaJudge: Promise.resolve(exactJudge) })).shortAnswer, "a");
});

test("the response waits for the judge only when the section can show the line, and never past the deadline", async () => {
  const redis = fakeRedis();
  const stored = (auditId, status, reasonCodes = []) => redis.data.set(`engine-repro:v1:default:result:${auditId}`,
    JSON.stringify({ summary: { status, reasonCodes, flags: [] }, rendered: "【引擎复现】", plan: { assumptions: [] },
      subQuestions: [], timings: { startedAtMs: 0, finishedAtMs: 1 } }));
  const never = new Promise(() => {});
  const options = (auditId, extra = {}) => ({ env: {}, auditId, requestStartedAt: 0, waitDeadlineAt: Date.now() + 60_000,
    command: redis.command, ...extra });

  // 不适用 / 未复现: nothing waits for a pending judge; a result already in hand is still reported
  for (const [auditId, status, codes] of [["a-na", "不适用", ["pure_rule"]], ["a-fail", "未复现", ["unrepresentable"]]]) {
    stored(auditId, status, codes);
    const startedAt = Date.now();
    const out = await attachEngineReproWhenReady({ shortAnswer: "主回答" }, options(auditId, { officialQaJudge: never }));
    assert.ok(Date.now() - startedAt < 1000, `${status}: no wait`);
    assert.equal(out.engineRepro.officialQaJudge, null);
    assert.ok(!out.shortAnswer.includes("官方 Q&A"));
    const ready = await attachEngineReproWhenReady({ shortAnswer: "主回答" },
      options(auditId, { officialQaJudge: Promise.resolve(exactJudge) }));
    assert.equal(ready.engineRepro.officialQaJudge.status, "done", `${status}: a finished result is kept`);
    assert.ok(!ready.shortAnswer.includes("官方 Q&A"), `${status}: never the line`);
  }

  // 已复现: waits, but only until the same wait deadline
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 1, clockRef, redis, auditId: "a-ok" });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await Promise.all(pending);
  const startedAt = Date.now();
  const late = await attachEngineReproWhenReady({ shortAnswer: "主回答" },
    options("a-ok", { officialQaJudge: never, waitDeadlineAt: Date.now() + 50 }));
  const waited = Date.now() - startedAt;
  assert.ok(waited >= 40 && waited < 2000, `waited ${waited} ms`);
  assert.match(late.shortAnswer, /【ygopro 引擎复现（实验性）】已复现/u);
  assert.ok(!late.shortAnswer.includes("官方 Q&A"));
  assert.deepEqual([late.engineRepro.officialQaJudge.status, late.engineRepro.officialQaJudge.error],
    ["failed", "judge_wait_deadline"]);
  const past = await attachEngineReproWhenReady({ shortAnswer: "主回答" },
    options("a-ok", { officialQaJudge: never, waitDeadlineAt: Date.now() - 1 }));
  assert.equal(past.engineRepro.officialQaJudge.error, "judge_wait_deadline", "a deadline already passed: no wait at all");
});
