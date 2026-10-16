// Production wiring of the engine-reproduction section (experimental, admin-only).
//
// The reproduction starts the moment the main pipeline has its card resolution and card texts
// (it reuses that exact resolution and data snapshot), runs alongside retrieval / selection /
// generation, and is attached to the answer if it finished before the answer did. There is no
// grace period: an unfinished reproduction is reported as a latency defect, keeps running in the
// background (waitUntil) and still writes its result to the history record.
//
// Latency measures on the reproduction side only (the answer never waits): the engine service is
// woken when the session is created; once the main answer has its evidence and only final
// generation is left (onEvidenceReady), no repair call is started any more.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpEngineClient, warmHttpEngine } from "./engineClient.mjs";
import { createEngineReproLimits, redisCommand } from "./limits.mjs";
import { createOfficialModelCall } from "./modelCalls.mjs";
import { DEFAULT_PLANNER, identityFromCardResolution, runEngineReproduction } from "./reproduce.mjs";
import { STATUS } from "./aggregate.mjs";

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

function storedRecord(record) {
  // Keep replay material (scenario, actions, responses, versions, log); cap the size.
  let value = JSON.stringify(record);
  if (value.length > 900_000) {
    for (const sq of record.subQuestions || []) for (const b of sq.branches || []) if (b.engine) delete b.engine.log;
    value = JSON.stringify(record);
  }
  return value;
}

export function engineReproSectionText(section) {
  if (!section) return "";
  if (section.status === "pending") {
    return `【引擎复现（实验性）】引擎复现未在主回答完成前完成（截至主回答完成已耗时 ${(section.elapsedMs / 1000).toFixed(1)} 秒）。`;
  }
  return section.rendered || "";
}

/** Insert the section after the answer text (before an embedded generation footer, if any). */
export function appendEngineReproSection(answer, section) {
  if (!section || !answer || typeof answer !== "object") return answer;
  const text = engineReproSectionText(section);
  const shortAnswer = typeof answer.shortAnswer === "string" ? answer.shortAnswer : "";
  const footer = answer.generation?.embeddedInAnswerText === true ? String(answer.generation.answerTextFooter || "") : "";
  const body = footer && shortAnswer.endsWith(footer) ? shortAnswer.slice(0, -footer.length) : shortAnswer;
  return { ...answer, engineRepro: section, shortAnswer: `${body}\n\n${text}${footer && shortAnswer.endsWith(footer) ? footer : ""}` };
}

function sectionFromRecord(record) {
  return { status: "done", questionStatus: record.summary?.status, reasonCodes: record.summary?.reasonCodes || [],
    flags: record.summary?.flags || [], rendered: record.rendered, timings: record.timings };
}

export function plannerFromEnv(env = {}) {
  const tier = String(env.ENGINE_REPRO_SERVICE_TIER || "").trim();
  return { ...DEFAULT_PLANNER,
    model: env.ENGINE_REPRO_PLANNER_MODEL || DEFAULT_PLANNER.model,
    effort: env.ENGINE_REPRO_PLANNER_EFFORT || DEFAULT_PLANNER.effort,
    maxOutput: Number(env.ENGINE_REPRO_PLANNER_MAX_OUTPUT) > 0 ? Number(env.ENGINE_REPRO_PLANNER_MAX_OUTPUT) : DEFAULT_PLANNER.maxOutput,
    serviceTier: ["priority", "fast"].includes(tier) ? tier : null };
}

export function createEngineReproSession({
  env, isAdmin = false, requestStartedAt = Date.now(), auditIdPromise = Promise.resolve(null),
  fetchImpl = globalThis.fetch, now = Date.now, waitUntil = defaultWaitUntil,
  engine = null, modelCall = null, limits = null, cidMap = null, planner = null, saveAudit = null,
  command = redisCommand, warmEngine = warmHttpEngine,
}) {
  const enabled = engineReproEnabled(env) && isAdmin === true;
  const clock = () => now() - requestStartedAt;
  const state = { started: false, done: false, record: null, startedAtMs: null, mainEvidenceReadyAtMs: null };
  let promise = null;
  // Cold start overlaps card-name extraction instead of sitting in front of the planner.
  if (enabled && !engine && env.ENGINE_REPRO_URL) {
    try { warmEngine({ baseUrl: env.ENGINE_REPRO_URL, fetchImpl }).catch(() => null); } catch { /* never affects the answer */ }
  }

  const persist = async (record) => {
    const auditId = await auditIdPromise;
    if (!auditId) return;
    const prefix = keyPrefix(env);
    record.timings.mainEvidenceReadyAtMs = state.mainEvidenceReadyAtMs;
    await command(env, fetchImpl, ["SET", `${prefix}:result:${auditId}`, storedRecord(record), "EX", RESULT_TTL_SECONDS]);
    // When the answer completed first, its completion time is already stored (see attachEngineReproAtMainCompletion).
    const storedMain = await command(env, fetchImpl, ["GET", `${prefix}:main:${auditId}`]).catch(() => null);
    const mainAt = storedMain ? JSON.parse(storedMain).mainCompletedAtMs : null;
    if (mainAt !== null && record.timings.finishedAtMs > mainAt) {
      record.latencyDefect = { reproFinishedAtMs: record.timings.finishedAtMs, mainCompletedAtMs: mainAt,
        overshootMs: record.timings.finishedAtMs - mainAt };
      await command(env, fetchImpl, ["SET", `${prefix}:result:${auditId}`, storedRecord(record), "EX", RESULT_TTL_SECONDS]);
    }
    await saveAudit?.(auditId, { engineRepro: { status: record.summary?.status, reasonCodes: record.summary?.reasonCodes,
      flags: record.summary?.flags, timings: record.timings, latencyDefect: record.latencyDefect || null,
      plannerCalls: (record.planRaw || []).length, rendered: String(record.rendered || "").slice(0, 12000) } });
  };

  return {
    enabled,
    requestStartedAt,
    state,
    get promise() { return promise; },

    // Called by the main pipeline when its evidence is ready and only final generation remains.
    onEvidenceReady() {
      if (!enabled || state.mainEvidenceReadyAtMs !== null) return;
      state.mainEvidenceReadyAtMs = clock();
    },

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
            allowRepair: () => state.mainEvidenceReadyAtMs === null,
            planner: planner || plannerFromEnv(env),
            engine: engine || createHttpEngineClient({ baseUrl: env.ENGINE_REPRO_URL, secret: env.ENGINE_REPRO_SECRET, fetchImpl }),
            modelCall: modelCall || createOfficialModelCall({ env, limits: lim, fetchImpl }),
          });
        } catch (error) {
          // Budget, rate limit, missing configuration, engine or model outage: fail closed, never affect the answer.
          const reason = /budget|rate_limited|input_cap/u.test(String(error.code || error.message)) ? "budget_exceeded" : "engine_error";
          const record = { text: question, identity, timings: { startedAtMs: state.startedAtMs, finishedAtMs: clock() },
            error: { code: error.code || null, message: String(error.message || error).slice(0, 300) },
            summary: { status: STATUS.FAIL, reasonCodes: [reason], flags: [] } };
          record.rendered = `【引擎复现（实验性，未经评测）】\n状态：未复现 —— ${reason}（${record.error.code || record.error.message}）`;
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

// The only delivery mechanism, the same for every channel and request shape: at the moment the
// answer completes, record that time and read the stored reproduction result exactly once.
export async function readEngineReproAtMainCompletion({ env, auditId, requestStartedAt, fetchImpl = globalThis.fetch,
  now = Date.now, command = redisCommand }) {
  if (!auditId) return null;
  const prefix = keyPrefix(env);
  const mainCompletedAtMs = now() - requestStartedAt;
  await command(env, fetchImpl, ["SET", `${prefix}:main:${auditId}`, JSON.stringify({ mainCompletedAtMs }), "EX", RESULT_TTL_SECONDS])
    .catch(() => null);
  const stored = await command(env, fetchImpl, ["GET", `${prefix}:result:${auditId}`]).catch(() => null);
  if (stored) return { ...sectionFromRecord(JSON.parse(stored)), mainCompletedAtMs };
  const started = await command(env, fetchImpl, ["GET", `${prefix}:started:${auditId}`]).catch(() => null);
  if (!started) return null;   // the reproduction never started for this question
  const startedAtMs = JSON.parse(started).startedAtMs;
  return { status: "pending", elapsedMs: mainCompletedAtMs - startedAtMs, startedAtMs, mainCompletedAtMs };
}

export async function attachEngineReproAtMainCompletion(answer, options) {
  const section = await readEngineReproAtMainCompletion(options).catch(() => null);
  return appendEngineReproSection(answer, section);
}
