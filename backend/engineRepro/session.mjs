// Production wiring of the engine-reproduction section (experimental; public since 2026-10-16,
// stage 4: it runs for every public request while ENGINE_REPRO_ENABLED is on, inside its own
// daily budget bucket and per-minute rate limit, limits.mjs).
//
// The reproduction starts the moment the main pipeline has its card resolution and card texts
// (it reuses that exact resolution and data snapshot) and runs alongside retrieval / selection /
// generation. The response is sent when both are ready: when the main answer completes, its
// completion time is recorded and the request waits for the stored reproduction result. The only
// limit is the function's own duration (vercel.json maxDuration for api/answer.js): past the wait
// deadline the answer goes out with a one-line notice, and the reproduction still writes its
// result to the history record. The engine service is woken when the session is created.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpEngineClient, warmHttpEngine } from "./engineClient.mjs";
import { createEngineReproLimits, redisCommand } from "./limits.mjs";
import { createOfficialModelCall } from "./modelCalls.mjs";
import { DEFAULT_PLANNER, identityFromCardResolution, runEngineReproduction } from "./reproduce.mjs";
import { STATUS, renderQuestion } from "./aggregate.mjs";
import { CONCISE_HEADER, OFFICIAL_QA_STATE, engineReproConciseText, engineReproDigest, officialQaStateFromAnswer } from "./concise.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let cidMapCache = null;
function loadCidMap() {
  cidMapCache ||= JSON.parse(readFileSync(join(HERE, "..", "..", "data", "engine-repro", "cid-passcode-map.json"), "utf8")).map;
  return cidMapCache;
}

export function engineReproEnabled(env = {}) {
  return /^(?:1|true|yes|on)$/iu.test(String(env.ENGINE_REPRO_ENABLED || "").trim());
}

// Vercel exposes waitUntil through this request-context symbol (what @vercel/functions wraps).
export function defaultWaitUntil(promise) {
  const context = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (typeof context?.waitUntil === "function") context.waitUntil(promise);
}

const keyPrefix = (env) => `engine-repro:v1:${String(env.PUBLIC_OPENAI_BUDGET_RUN_ID || "default").replace(/[^A-Za-z0-9_-]/gu, "")}`;
const RESULT_TTL_SECONDS = "2592000";

// api/answer.js runs at most 300 s (vercel.json). Waiting ends 20 s before that so the answer,
// its audit update and the response still fit; a test keeps this tied to vercel.json.
export const FUNCTION_MAX_DURATION_MS = 300_000;
export const DEFAULT_WAIT_BUDGET_MS = FUNCTION_MAX_DURATION_MS - 20_000;
export function engineReproWaitDeadline(invocationStartedAt, env = {}) {
  const budget = Number(env.ENGINE_REPRO_WAIT_BUDGET_MS);
  return invocationStartedAt + (budget > 0 && budget <= DEFAULT_WAIT_BUDGET_MS ? budget : DEFAULT_WAIT_BUDGET_MS);
}

function storedRecord(record) {
  // Keep replay material (scenario, actions, responses, versions, log); cap the size.
  let value = JSON.stringify(record);
  if (value.length > 900_000) {
    for (const sq of record.subQuestions || []) for (const b of sq.branches || []) if (b.engine) delete b.engine.log;
    value = JSON.stringify(record);
  }
  return value;
}

// The short, user-facing section (concise.mjs). The full step-by-step replay is not part of the
// answer text: it stays in section.rendered (response field engineRepro.rendered and the history
// record), and the website shows it in a collapsed block under the short section.
export function engineReproSectionText(section, { officialQaState = null } = {}) {
  if (!section) return "";
  if (section.status === "timeout") {
    return `${CONCISE_HEADER}未完成\n\nygopro 引擎复现在等待上限内未完成（复现已耗时 ${(section.elapsedMs / 1000).toFixed(1)} 秒，`
      + `主回答完成后已等待 ${(section.waitedMs / 1000).toFixed(1)} 秒）。结果仍会写入历史记录。`;
  }
  return section.digest ? engineReproConciseText(section.digest, { officialQaState }) : "";
}

/** Insert the short section after the answer text (before an embedded generation footer, if any). */
export function appendEngineReproSection(answer, section) {
  if (!section || !answer || typeof answer !== "object") return answer;
  const officialQaState = officialQaStateFromAnswer(answer);
  const text = engineReproSectionText(section, { officialQaState });
  // officialQaDirect (true / false / null) is kept for existing readers of the response.
  const officialQaDirect = officialQaState === null ? null : officialQaState === OFFICIAL_QA_STATE.DIRECT;
  const engineRepro = { ...section, concise: text, officialQaState, officialQaDirect };
  if (!text) return { ...answer, engineRepro };
  const shortAnswer = typeof answer.shortAnswer === "string" ? answer.shortAnswer : "";
  const footer = answer.generation?.embeddedInAnswerText === true ? String(answer.generation.answerTextFooter || "") : "";
  const body = footer && shortAnswer.endsWith(footer) ? shortAnswer.slice(0, -footer.length) : shortAnswer;
  return { ...answer, engineRepro, shortAnswer: `${body}\n\n${text}${footer && shortAnswer.endsWith(footer) ? footer : ""}` };
}

function sectionFromRecord(record) {
  return { status: "done", questionStatus: record.summary?.status, reasonCodes: record.summary?.reasonCodes || [],
    flags: record.summary?.flags || [], rendered: record.rendered, digest: engineReproDigest(record), timings: record.timings,
    plannerContext: record.plannerContext || [], modelUsage: record.modelUsage || [] };
}

export function plannerFromEnv(env = {}) {
  const maxInput = Number(env.ENGINE_REPRO_PLANNER_MAX_INPUT);
  return { ...DEFAULT_PLANNER,
    model: env.ENGINE_REPRO_PLANNER_MODEL || DEFAULT_PLANNER.model,
    effort: env.ENGINE_REPRO_PLANNER_EFFORT || DEFAULT_PLANNER.effort,
    maxOutput: Number(env.ENGINE_REPRO_PLANNER_MAX_OUTPUT) > 0 ? Number(env.ENGINE_REPRO_PLANNER_MAX_OUTPUT) : DEFAULT_PLANNER.maxOutput,
    maxInput: Number.isSafeInteger(maxInput) && maxInput > 0 ? maxInput : DEFAULT_PLANNER.maxInput };
}

export function createEngineReproSession({
  env, requestStartedAt = Date.now(), auditIdPromise = Promise.resolve(null),
  fetchImpl = globalThis.fetch, now = Date.now, waitUntil = defaultWaitUntil,
  engine = null, modelCall = null, limits = null, cidMap = null, planner = null, saveAudit = null,
  command = redisCommand, warmEngine = warmHttpEngine,
}) {
  const enabled = engineReproEnabled(env);
  const clock = () => now() - requestStartedAt;
  const state = { started: false, done: false, record: null, startedAtMs: null };
  let promise = null;
  // Cold start overlaps card-name extraction instead of sitting in front of the planner.
  if (enabled && !engine && env.ENGINE_REPRO_URL) {
    try { warmEngine({ baseUrl: env.ENGINE_REPRO_URL, fetchImpl }).catch(() => null); } catch { /* never affects the answer */ }
  }

  const persist = async (record) => {
    const auditId = await auditIdPromise;
    if (!auditId) return;
    const prefix = keyPrefix(env);
    // The waiting answer polls for this key, so one failed write is retried once.
    const writeResult = () => command(env, fetchImpl, ["SET", `${prefix}:result:${auditId}`, storedRecord(record), "EX", RESULT_TTL_SECONDS]);
    await writeResult().catch(writeResult);
    // When the answer completed first, its completion time is already stored (see
    // awaitEngineReproAtMainCompletion): the difference is how long the response waited for this.
    const storedMain = await command(env, fetchImpl, ["GET", `${prefix}:main:${auditId}`]).catch(() => null);
    const main = storedMain ? JSON.parse(storedMain) : null;
    if (main && record.timings.finishedAtMs > main.mainCompletedAtMs) {
      record.answerDelay = { mainCompletedAtMs: main.mainCompletedAtMs, reproFinishedAtMs: record.timings.finishedAtMs,
        delayMs: record.timings.finishedAtMs - main.mainCompletedAtMs };
      if (Number.isFinite(main.gaveUpAtMs) && record.timings.finishedAtMs > main.gaveUpAtMs) {
        record.answerDelay.waitTimedOutAtMs = main.gaveUpAtMs;
      }
      await command(env, fetchImpl, ["SET", `${prefix}:result:${auditId}`, storedRecord(record), "EX", RESULT_TTL_SECONDS]);
    }
    await saveAudit?.(auditId, { engineRepro: { status: record.summary?.status, reasonCodes: record.summary?.reasonCodes,
      flags: record.summary?.flags, timings: record.timings, answerDelay: record.answerDelay || null,
      plannerCalls: (record.planRaw || []).length, rendered: String(record.rendered || "").slice(0, 12000) } });
  };

  return {
    enabled,
    requestStartedAt,
    state,
    get promise() { return promise; },

    // Called by the main pipeline once card resolution and card texts are ready.
    onCardTextsReady({ question, cardResolution, groupMentions = [], cards = [] }) {
      if (!enabled || state.started) return;
      state.started = true;
      state.startedAtMs = clock();
      const identity = identityFromCardResolution(cardResolution, groupMentions);
      const wanted = new Set(identity.resolved.map((c) => c.cid));
      const cardsById = new Map(cards.filter((c) => wanted.has(String(c.id))).map((c) => [String(c.id), c]));
      const lim = limits || createEngineReproLimits({ env, fetchImpl, now, command });
      const run = async () => {
        try {
          await lim.admit();
          return await runEngineReproduction({
            question, identity, cardsById, cidMap: cidMap || loadCidMap(), clock,
            planner: planner || plannerFromEnv(env),
            engine: engine || createHttpEngineClient({ baseUrl: env.ENGINE_REPRO_URL, secret: env.ENGINE_REPRO_SECRET, fetchImpl }),
            modelCall: modelCall || createOfficialModelCall({ env, limits: lim, fetchImpl }),
          });
        } catch (error) {
          // Budget, rate limit, missing configuration, engine or model outage: fail closed, never affect the answer.
          const reason = /budget|rate_limited|input_cap/u.test(String(error.code || error.message)) ? "budget_exceeded" : "engine_error";
          const previous = error.engineReproRecord;
          const record = { ...previous, text: question, identity,
            timings: { ...previous?.timings, startedAtMs: state.startedAtMs, finishedAtMs: clock() },
            error: { code: error.code || null, message: String(error.message || error).slice(0, 300) },
            summary: { status: STATUS.FAIL, reasonCodes: [reason],
              flags: previous?.plannerContext?.some((context) => context.trimmed) ? ["context_trimmed"] : [] } };
          record.rendered = previous ? renderQuestion(record, record.summary)
            : `【ygopro 引擎复现（实验性，未经评测）】\n状态：未复现 —— ${reason}（${record.error.code || record.error.message}）`;
          return record;
        }
      };
      auditIdPromise.then((auditId) => auditId && command(env, fetchImpl, ["SET", `${keyPrefix(env)}:started:${auditId}`,
        JSON.stringify({ startedAtMs: state.startedAtMs }), "EX", RESULT_TTL_SECONDS])).catch(() => null);
      promise = run().then(async (record) => {
        state.done = true;
        state.record = record;
        await persist(record).catch(() => null);
        return record;
      });
      waitUntil(promise);
    },
  };
}

// The only delivery mechanism, the same for every channel and request shape: when the answer
// completes, record that time, then wait (polling the stored result by history-record id) until
// the reproduction's result is there. A reproduction that never started is not waited for.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function awaitEngineReproAtMainCompletion({ env, auditId, requestStartedAt, waitDeadlineAt,
  pollMs = 300, fetchImpl = globalThis.fetch, now = Date.now, sleep = defaultSleep, command = redisCommand }) {
  if (!auditId) return null;
  const prefix = keyPrefix(env);
  const mainCompletedAtMs = now() - requestStartedAt;
  const mainKey = `${prefix}:main:${auditId}`;
  await command(env, fetchImpl, ["SET", mainKey, JSON.stringify({ mainCompletedAtMs }), "EX", RESULT_TTL_SECONDS]).catch(() => null);
  const read = async () => {
    const stored = await command(env, fetchImpl, ["GET", `${prefix}:result:${auditId}`]).catch(() => null);
    return stored ? JSON.parse(stored) : null;
  };
  const done = (record) => ({ ...sectionFromRecord(record), mainCompletedAtMs,
    waitedMs: Math.max(0, now() - requestStartedAt - mainCompletedAtMs) });
  let record = await read();
  if (record) return done(record);
  const started = await command(env, fetchImpl, ["GET", `${prefix}:started:${auditId}`]).catch(() => null);
  if (!started) return null;   // the reproduction never started for this question
  const startedAtMs = JSON.parse(started).startedAtMs;
  while (now() < waitDeadlineAt) {
    await sleep(Math.min(pollMs, Math.max(0, waitDeadlineAt - now())));
    record = await read();
    if (record) return done(record);
  }
  const gaveUpAtMs = now() - requestStartedAt;
  await command(env, fetchImpl, ["SET", mainKey, JSON.stringify({ mainCompletedAtMs, gaveUpAtMs }), "EX", RESULT_TTL_SECONDS])
    .catch(() => null);
  return { status: "timeout", startedAtMs, mainCompletedAtMs, gaveUpAtMs,
    elapsedMs: gaveUpAtMs - startedAtMs, waitedMs: gaveUpAtMs - mainCompletedAtMs };
}

export async function attachEngineReproWhenReady(answer, options) {
  const section = await awaitEngineReproAtMainCompletion(options).catch(() => null);
  return appendEngineReproSection(answer, section);
}
