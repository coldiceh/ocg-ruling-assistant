import assert from "node:assert/strict";
import test from "node:test";
import { createEngineReproSession, plannerFromEnv } from "../backend/engineRepro/session.mjs";
import { expandPlanDefaults, runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { createOfficialModelCall, usageCostUsd, worstCaseCostUsd } from "../backend/engineRepro/modelCalls.mjs";
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

test("after the main answer's evidence is ready, no repair call is started", async () => {
  const calls = [];
  const record = await runEngineReproduction({ question: "q", identity, cardsById, cidMap: { 12950: 14558127 },
    engine: fakeEngine({ mismatch: true }), allowRepair: () => false,
    modelCall: async (opts) => { calls.push(opts.stage); return { status: "completed", outputText: JSON.stringify(compactPlan([branch("b1")])), usage: {} }; } });
  assert.deepEqual(calls, ["plan"]);
  assert.equal(record.repairSkipped, "main_answer_generating");
  assert.equal(record.summary.status, "未复现");
  assert.ok(record.summary.flags.includes("repair_skipped"));
  assert.match(record.rendered, /修复因时限跳过/u);
});

test("session: the engine service is woken at creation (configured URL only); evidence-ready is recorded once", () => {
  const warmed = [];
  const make = (env, extra = {}) => createEngineReproSession({ env: { ENGINE_REPRO_ENABLED: "true", ...env }, isAdmin: true,
    requestStartedAt: 0, now: () => 1234, waitUntil: () => {}, command: async () => null,
    warmEngine: (opts) => { warmed.push(opts.baseUrl); return Promise.resolve(true); }, ...extra });
  const session = make({ ENGINE_REPRO_URL: "https://engine.example.test" });
  assert.deepEqual(warmed, ["https://engine.example.test"]);
  make({});                                                    // no URL: nothing to wake
  make({ ENGINE_REPRO_URL: "https://x.test" }, { engine: async () => ({}) });  // injected engine: no wake
  createEngineReproSession({ env: { ENGINE_REPRO_ENABLED: "true", ENGINE_REPRO_URL: "https://y.test" }, isAdmin: false,
    warmEngine: (opts) => { warmed.push(opts.baseUrl); return Promise.resolve(true); } });   // not admin: no wake
  assert.deepEqual(warmed, ["https://engine.example.test"]);
  session.onEvidenceReady();
  session.onEvidenceReady();
  assert.equal(session.state.mainEvidenceReadyAtMs, 1234);
});

test("session with a mismatching first plan and evidence already ready: delivered without repair", async () => {
  const stages = [];
  const session = createEngineReproSession({
    env: { ENGINE_REPRO_ENABLED: "true" }, isAdmin: true, requestStartedAt: 0, auditIdPromise: Promise.resolve(null),
    now: () => 0, waitUntil: () => {}, engine: fakeEngine({ mismatch: true }),
    modelCall: async (opts) => { stages.push(opts.stage); session.onEvidenceReady();
      return { status: "completed", outputText: JSON.stringify(compactPlan([branch("b1")])), usage: {} }; },
    limits: { admit: async () => {}, reserve: async () => ({}), settle: async () => {} },
    cidMap: { 12950: 14558127 }, command: async () => null,
  });
  session.onCardTextsReady({ question: "q", cardResolution: { resolvedCards: [{ id: "12950", input: "灰流丽" }] },
    cards: [{ id: "12950", name: "灰流丽", effectText: "t" }] });
  const record = await session.promise;
  assert.deepEqual(stages, ["plan"]);
  assert.equal(record.repairSkipped, "main_answer_generating");
});

test("Fast mode is opt-in; the request carries service_tier and the served tier sets the price", async () => {
  assert.equal(plannerFromEnv({}).serviceTier, null);
  assert.equal(plannerFromEnv({ ENGINE_REPRO_SERVICE_TIER: "priority" }).serviceTier, "priority");
  assert.equal(plannerFromEnv({ ENGINE_REPRO_SERVICE_TIER: "ultra" }).serviceTier, null);
  const usage = { input_tokens: 1000, output_tokens: 500 };
  assert.equal(usageCostUsd("gpt-6.1-sol", usage, "priority"), 2 * usageCostUsd("gpt-6.1-sol", usage));
  assert.equal(usageCostUsd("gpt-6.1-sol", usage, "default"), usageCostUsd("gpt-6.1-sol", usage));
  assert.ok(worstCaseCostUsd("gpt-6.1-sol", "abc", 100, "priority") > 2 * worstCaseCostUsd("gpt-6.1-sol", "abc", 100));
  const bodies = [];
  const settled = [];
  const call = createOfficialModelCall({ env: { ENGINE_REPRO_OPENAI_API_KEY: "k" },
    limits: { reserve: async (usd) => ({ usd }), settle: async (r, usd) => settled.push(usd) },
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ status: "completed", service_tier: "default", usage, output: [] }), { status: 200 }); } });
  const r = await call({ model: "gpt-6.1-sol", input: "x", reasoningEffort: "low", maxOutputTokens: 100, serviceTier: "priority" });
  assert.equal(bodies[0].service_tier, "priority");
  assert.equal(r.servedTier, "default");
  assert.equal(settled[0], usageCostUsd("gpt-6.1-sol", usage));
  await call({ model: "gpt-6.1-sol", input: "x", reasoningEffort: "low", maxOutputTokens: 100 });
  assert.equal("service_tier" in bodies[1], false);
});

test("answer service passes the evidence-ready observer to the pipeline only for admins", async () => {
  const { answerPublicRulingQuestion } = await import("../backend/publicAnswerService.mjs");
  let seen = null;
  await answerPublicRulingQuestion({
    payload: { question: "Synthetic question" },
    env: { MODEL_PROVIDER: "mock", ENGINE_REPRO_ENABLED: "true" },
    engineReproAdmin: true,
    appendAudit: async () => ({ entry: { id: "a" } }), updateAudit: async () => ({ updated: true }),
    assetsResident: () => true, preloadAssets: () => ({}),
    classifyScope: async () => ({ scope: "in_scope", confidence: "high" }),
    readRiskControl: async () => ({ ok: true, active: false }),
    createEngineRepro: () => ({ enabled: true, state: { started: false }, onCardTextsReady() {}, onEvidenceReady() {} }),
    attachEngineRepro: (answer) => answer,
    answerRuling: async (options) => { seen = options; return { shortAnswer: "a" }; },
  });
  assert.equal(typeof seen.onEvidenceReady, "function");
});
