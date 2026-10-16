import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEngineReproSession, DEFAULT_WAIT_BUDGET_MS, engineReproWaitDeadline, FUNCTION_MAX_DURATION_MS,
  plannerFromEnv } from "../backend/engineRepro/session.mjs";
import { expandPlanDefaults, runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { DEFAULT_DECK } from "../backend/engineRepro/plannerPrompt.mjs";

const identity = { resolved: [{ cid: "12950", mentionedAs: ["灰流丽"], resolutionSources: [] }], unresolved: [], groupMentions: [] };
const cardsById = new Map([["12950", { id: "12950", name: "灰流丽", effectText: "text" }]]);
const compactPlan = (branches) => ({
  applicability: "applicable", reason_code: null, archetype_name: null, quoted_span: "q", what_not_why: false,
  assumptions: [], extra_cards: [],
  sub_questions: [{ id: "q1", quoted_span: "q", unrepresentable: null, branches }],
});
const branch = (id) => ({ id, assumption: null, observe: "x",
  scenario: { first_player: 0, players: [{ hand: [14558127] }, { lp: 4000, deck: [89631139, 89631139, 89631139, 89631139, 89631139] }] },
  actions: { setup: [] } });

function fakeEngine({ reproduceDelayMs = 0, mismatch = false, log = [] } = {}) {
  return async (op, body) => {
    log.push({ op, at: Date.now() });
    if (op === "cards") return { cards: (body.codes || []).map((code) => ({ code, exists: true, name: "灰流丽", types: ["怪兽"], text: "t" })) };
    if (op === "related") return { related: [] };
    if (op === "reproduce") {
      await new Promise((r) => setTimeout(r, reproduceDelayMs));
      return { result: mismatch
        ? { status: "action_mismatch", reason_code: "action_mismatch", failure: { reason: "not_found", step: 0 }, scenario: body.scenario }
        : { status: "replayed", probes: [], rendered_zh: "【引擎复现】", scenario: body.scenario } };
    }
    throw new Error(op);
  };
}

test("defaults the planner may omit are filled mechanically; explicit values are kept", () => {
  const { scenario, actions } = expandPlanDefaults(branch("b1").scenario, { setup: [{ player: 0 }] });
  assert.equal(scenario.schema, "ocg-repro-scenario/v1");
  assert.equal(scenario.seed, 2026);
  assert.deepEqual(scenario.players[0], { hand: [14558127], lp: 8000, draw_count: 0, deck: [...DEFAULT_DECK] });
  assert.equal(scenario.players[1].lp, 4000);
  assert.deepEqual(scenario.players[1].deck, [89631139, 89631139, 89631139, 89631139, 89631139]);
  assert.equal(actions.schema, "ocg-repro-actions/v1");
  assert.deepEqual(actions.probes, []);
  assert.equal(expandPlanDefaults({ seed: 7, players: [] }, {}).scenario.seed, 7);
});

test("branches run in parallel and the engine phase is counted as wall time", async () => {
  let t = 0;
  const clock = () => t;
  const engine = fakeEngine({ reproduceDelayMs: 40 });
  const started = Date.now();
  const record = await runEngineReproduction({ question: "q", identity, cardsById, cidMap: { 12950: 14558127 },
    engine: async (op, body) => { const r = await engine(op, body); t = Date.now() - started; return r; },
    clock, modelCall: async () => ({ status: "completed", outputText: JSON.stringify(compactPlan([branch("b1"), branch("b2")])), usage: {} }) });
  assert.equal(record.summary.status, "已复现");
  assert.ok(Date.now() - started < 75, "two 40 ms branches finished together");
  assert.equal(record.subQuestions[0].branches[0].scenario.schema, "ocg-repro-scenario/v1");
});

test("session: the engine service is woken at creation (configured URL, admin, no injected engine only)", () => {
  const warmed = [];
  const make = (env, extra = {}) => createEngineReproSession({ env: { ENGINE_REPRO_ENABLED: "true", ...env }, isAdmin: true,
    requestStartedAt: 0, now: () => 0, waitUntil: () => {}, command: async () => null,
    warmEngine: (opts) => { warmed.push(opts.baseUrl); return Promise.resolve(true); }, ...extra });
  make({ ENGINE_REPRO_URL: "https://engine.example.test" });
  make({});
  make({ ENGINE_REPRO_URL: "https://x.test" }, { engine: async () => ({}) });
  make({ ENGINE_REPRO_URL: "https://y.test" }, { isAdmin: false });
  assert.deepEqual(warmed, ["https://engine.example.test"]);
});

test("the wait deadline stays inside the answer function's maxDuration in vercel.json", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercel.functions["api/answer.js"].maxDuration * 1000, FUNCTION_MAX_DURATION_MS);
  assert.ok(DEFAULT_WAIT_BUDGET_MS < FUNCTION_MAX_DURATION_MS);
  assert.equal(engineReproWaitDeadline(1000, {}), 1000 + DEFAULT_WAIT_BUDGET_MS);
  assert.equal(engineReproWaitDeadline(1000, { ENGINE_REPRO_WAIT_BUDGET_MS: "60000" }), 61000);
  assert.equal(engineReproWaitDeadline(1000, { ENGINE_REPRO_WAIT_BUDGET_MS: "999999" }), 1000 + DEFAULT_WAIT_BUDGET_MS);
  assert.equal(plannerFromEnv({ ENGINE_REPRO_PLANNER_MAX_OUTPUT: "1200" }).maxOutput, 1200);
  assert.equal("serviceTier" in plannerFromEnv({ ENGINE_REPRO_SERVICE_TIER: "priority" }), false);
});

test("finalize (second web request) waits with a deadline counted from its own start", async () => {
  const { finalizePublicAnswer } = await import("../backend/publicPreparedAnswerService.mjs");
  const preparation = { profileId: "official-astra-low", pipeline: "rag_baseline", continuation: { promptBundle: { prompt: "x" } }, rulingVersion: "latest",
    startedAt: 0, auditId: "audit-f", requestDiagnostics: { scope: { scope: "in_scope" } },
    engineRepro: { enabled: true, requestStartedAt: 111 } };
  let seen = null;
  const before = Date.now();
  const result = await finalizePublicAnswer({ preparation, env: { MODEL_PROVIDER: "mock" },
    selectProfile: async () => ({ profile: { id: "official-astra-low", provider: "openai" } }),
    finalize: async () => ({ shortAnswer: "a" }), addGeneration: async (answer) => answer, updateAudit: async () => ({ updated: true }),
    attachEngineRepro: async (answer, options) => { seen = options; return { ...answer, shortAnswer: `${answer.shortAnswer}\n\nR` }; } });
  assert.equal(seen.auditId, "audit-f");
  assert.equal(seen.requestStartedAt, 111);
  assert.ok(seen.waitDeadlineAt >= before + DEFAULT_WAIT_BUDGET_MS && seen.waitDeadlineAt <= Date.now() + DEFAULT_WAIT_BUDGET_MS);
  assert.match(result.answer.shortAnswer, /R$/u);
});
