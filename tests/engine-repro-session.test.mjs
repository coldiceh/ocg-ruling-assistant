import assert from "node:assert/strict";
import test from "node:test";
import { appendEngineReproSection, createEngineReproSession, readEngineReproAtMainCompletion } from "../backend/engineRepro/session.mjs";
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

test("finished before the answer: the section is attached after the answer text", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 5, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  await Promise.all(pending);
  clockRef.t = 9000;
  const section = session.sectionAtMainCompletion();
  assert.equal(section.status, "done");
  assert.equal(section.questionStatus, "已复现");
  const answer = appendEngineReproSection({ shortAnswer: "主回答" }, section);
  assert.match(answer.shortAnswer, /^主回答\n\n【引擎复现/u);
  const audit = JSON.parse(redis.data.get("audit:audit-1"));
  assert.equal(audit.engineRepro.status, "已复现");
  assert.equal(audit.engineRepro.latencyDefect, null);
});

test("not finished when the answer completes: a notice, no waiting, and a latency defect in the record", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 30, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  const section = session.sectionAtMainCompletion();      // answer completes immediately
  assert.equal(section.status, "pending");
  const answer = appendEngineReproSection({ shortAnswer: "主回答" }, section);
  assert.match(answer.shortAnswer, /引擎复现未在主回答完成前完成（截至主回答完成已耗时 0\.0 秒）/u);
  await Promise.all(pending);
  const audit = JSON.parse(redis.data.get("audit:audit-1"));
  assert.ok(audit.engineRepro.latencyDefect.overshootMs > 0);
});

test("two requests (prepare, then finalize): finalize reads once and records its completion time", async () => {
  const redis = fakeRedis();
  const clockRef = { t: 1000 };
  const { session, pending } = makeSession({ delayMs: 30, clockRef, redis });
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  // finalize completes before the reproduction
  await new Promise((r) => setTimeout(r, 0));
  const early = await readEngineReproAtMainCompletion({ env: {}, auditId: "audit-1", requestStartedAt: 0,
    now: () => clockRef.t, command: redis.command });
  assert.equal(early.status, "pending");
  await Promise.all(pending);
  const record = JSON.parse(redis.data.get("engine-repro:v1:default:result:audit-1"));
  assert.ok(record.latencyDefect && record.latencyDefect.overshootMs > 0);
  // a later read (e.g. status polling) sees the stored result
  const later = await readEngineReproAtMainCompletion({ env: {}, auditId: "audit-1", requestStartedAt: 0,
    now: () => clockRef.t, command: redis.command });
  assert.equal(later.status, "done");
});

test("not an administrator: nothing runs and nothing is attached", async () => {
  const redis = fakeRedis();
  const { session, pending } = makeSession({ delayMs: 1, clockRef: { t: 0 }, redis, isAdmin: false });
  assert.equal(session.enabled, false);
  session.onCardTextsReady({ question: "q", cardResolution, cards });
  assert.equal(pending.length, 0);
  assert.equal(session.sectionAtMainCompletion(), null);
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
      const made = makeSession({ delayMs: 1, clockRef, redis });
      observed = { options, made };
      return made.session;
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
