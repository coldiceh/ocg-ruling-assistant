import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePlannerContext } from "../backend/engineRepro/plannerContext.mjs";
import { DEFAULT_PLANNER, runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { createEngineReproSession, plannerFromEnv } from "../backend/engineRepro/session.mjs";
import { createModelRunner, createOfficialModelCall } from "../backend/engineRepro/modelCalls.mjs";

const card = { code: 14558127, cid: "12950", engineName: "灰流丽", mentionedAs: ["灰流丽"],
  effectText: "不可裁剪的题目点名卡文。", pendulumEffectText: "不可裁剪的灵摆卡文。" };
const related = [{ ref: "示例字段", kind: "archetype", cards: [{ code: 123, name: "相关卡", text: "相".repeat(50000) }] }];
const tools = [{ code: 456, name: "通用工具", types: "怪兽", text: "工".repeat(1000) }];
const base = { question: "不能裁剪的题目。", cards: [card], relatedCards: related, toolCards: tools };
const naPlan = { applicability: "not_applicable", reason_code: "pure_rule", quoted_span: "q", sub_questions: [] };

test("default 16000 and a positive integer environment override; invalid overrides keep the default", () => {
  assert.equal(DEFAULT_PLANNER.maxInput, 16000);
  assert.equal(plannerFromEnv({ ENGINE_REPRO_PLANNER_MAX_INPUT: "24000" }).maxInput, 24000);
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.equal(plannerFromEnv({ ENGINE_REPRO_PLANNER_MAX_INPUT: value }).maxInput, 16000);
  }
});

test("context that fits retains all optional material and has no trimming marker", () => {
  const result = preparePlannerContext({ ...base, relatedCards: [], maxInput: 16000 });
  assert.equal(result.context.trimmed, false);
  assert.equal(result.context.overLimitAfterTrim, false);
  assert.ok(result.input.includes(card.effectText) && result.input.includes(tools[0].text));
});

test("drop quoted related cards first and retain fixed tools once the input fits", () => {
  const result = preparePlannerContext({ ...base, maxInput: 16000 });
  assert.deepEqual(result.context.removed.map((r) => r.kind), ["related_cards"]);
  assert.equal(result.context.removed[0].refs[0].cards[0].name, "相关卡");
  assert.ok(!result.input.includes(related[0].cards[0].text));
  assert.ok(result.input.includes(tools[0].text));
  assert.ok(result.input.includes(card.effectText));
  assert.equal(result.context.overLimitAfterTrim, false);
});

test("drop fixed tools second, preserving the whole question and both card text fields even above the target", () => {
  const result = preparePlannerContext({ ...base, maxInput: 1 });
  assert.deepEqual(result.context.removed.map((r) => r.kind), ["related_cards", "tool_cards"]);
  assert.equal(result.context.removed[1].cards[0].code, 456);
  assert.ok(!result.input.includes(tools[0].text));
  assert.ok(result.input.includes(base.question) && result.input.includes(card.effectText) && result.input.includes(card.pendulumEffectText));
  assert.equal(result.context.overLimitAfterTrim, true);
});

test("repair overhead gets its own ordered trimming pass without deleting the previous plan or failures", () => {
  const withoutRelated = { ...base, relatedCards: [] };
  const first = preparePlannerContext({ ...withoutRelated, maxInput: 16000 });
  const result = preparePlannerContext({ ...withoutRelated, maxInput: first.context.inputTokensEstimate,
    repair: { previousPlan: { note: "必须保留的旧计划" }, failures: [{ reason_code: "action_mismatch", detail: "失".repeat(2000) }], planLevel: true } });
  assert.equal(result.context.stage, "repair");
  assert.deepEqual(result.context.removed.map((r) => r.kind), ["tool_cards"]);
  assert.ok(result.input.includes("必须保留的旧计划") && result.input.includes("action_mismatch"));
  assert.ok(result.input.includes(card.effectText));
});

const identity = { resolved: [{ cid: "12950", mentionedAs: ["灰流丽"] }], unresolved: [], groupMentions: [] };
const cardsById = new Map([["12950", { effectText: card.effectText, pendulumEffectText: card.pendulumEffectText }]]);
const engine = async (op, body) => {
  if (op === "cards") return { cards: body.with_text ? tools.map((c) => ({ ...c, types: [c.types] }))
    : [{ code: 14558127, exists: true, name: "灰流丽", types: ["怪兽"] }] };
  if (op === "related") return { related };
  throw new Error("unexpected engine operation " + op);
};

test("planning and its one repair proceed after trimming; both records and the rendered section explain removals", async () => {
  const calls = [];
  const record = await runEngineReproduction({ question: base.question, identity, cardsById, cidMap: { 12950: 14558127 }, engine,
    planner: { ...DEFAULT_PLANNER, maxInput: 1 }, modelCall: async (opts) => {
      calls.push(opts);
      return { status: "completed", outputText: calls.length === 1 ? "invalid JSON" : JSON.stringify(naPlan),
        usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.0004 };
    } });
  assert.deepEqual(calls.map((c) => c.stage), ["plan", "repair"]);
  assert.ok(calls.every((c) => c.input.includes(card.effectText) && !c.input.includes(tools[0].text)));
  assert.ok(record.plannerContext.every((c) => c.overLimitAfterTrim && c.trimmed));
  assert.ok(record.summary.flags.includes("context_trimmed"));
  assert.match(record.rendered, /上下文已裁剪/u);
  assert.match(record.rendered, /相关卡\(123\)/u);
  assert.match(record.rendered, /通用工具\(456\)/u);
  assert.deepEqual(record.modelUsage.map((c) => c.inputTokens), [100, 100]);
});

test("official transport keeps all essential text above the soft target and still reserves and settles its monetary budget", async () => {
  let sent, reserved = 0, settled = 0;
  const call = createOfficialModelCall({ env: { ENGINE_REPRO_OPENAI_API_KEY: "test-key" }, limits: {
    reserve: async (cost) => { reserved++; assert.ok(cost > 0); return {}; }, settle: async () => { settled++; },
  }, fetchImpl: async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, headers: new Headers(), text: async () => JSON.stringify({ status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 2 } }) };
  } });
  await call({ model: DEFAULT_PLANNER.model, input: card.effectText, maxInputTokens: 1, maxOutputTokens: 1600, reasoningEffort: "low" });
  assert.equal(sent.input, card.effectText);
  assert.equal(reserved, 1);
  assert.equal(settled, 1);
});

test("a monetary budget rejection still prevents any dispatch", async () => {
  let dispatched = false;
  const call = createOfficialModelCall({ env: { ENGINE_REPRO_OPENAI_API_KEY: "test-key" },
    limits: { reserve: async () => { throw new Error("engine_repro_daily_budget_exceeded"); } },
    fetchImpl: async () => { dispatched = true; } });
  await assert.rejects(() => call({ model: DEFAULT_PLANNER.model, input: "q", maxInputTokens: 1, maxOutputTokens: 1600 }), /daily_budget_exceeded/u);
  assert.equal(dispatched, false);
});

test("batch transport also treats the input target as soft", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-context-"));
  try {
    const runner = createModelRunner({ outDir: dir, budgetUsd: 1,
      mock: async ({ body }) => { assert.equal(body.input, card.effectText); return { status: "completed", output: [] }; } });
    await runner.call({ qid: "synthetic", stage: "plan", model: DEFAULT_PLANNER.model, input: card.effectText,
      maxInputTokens: 1, maxOutputTokens: 1600 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("trimming is retained in stored results and the delivered API section", async () => {
  const store = new Map();
  const command = async (_env, _fetch, [op, key, value]) => { if (op === "SET") { store.set(key, value); return "OK"; } return store.get(key) ?? null; };
  const { attachEngineReproWhenReady } = await import("../backend/engineRepro/session.mjs");
  const session = createEngineReproSession({ env: { ENGINE_REPRO_ENABLED: "true", ENGINE_REPRO_PLANNER_MAX_INPUT: "1" }, isAdmin: true,
    requestStartedAt: 0, auditIdPromise: Promise.resolve("test"), now: () => 10, waitUntil: () => {}, engine, cidMap: { 12950: 14558127 },
    limits: { admit: async () => {} }, command,
    modelCall: async () => ({ status: "completed", outputText: JSON.stringify(naPlan), usage: {} }) });
  session.onCardTextsReady({ question: base.question, cardResolution: { resolvedCards: [{ id: "12950", input: "灰流丽" }] }, cards: [{ id: "12950", ...cardsById.get("12950") }] });
  await session.promise;
  const delivered = await attachEngineReproWhenReady({ shortAnswer: "主回答" }, { env: {}, auditId: "test", requestStartedAt: 0, now: () => 20, command });
  assert.equal(delivered.engineRepro.plannerContext[0].trimmed, true);
  assert.ok(delivered.engineRepro.flags.includes("context_trimmed"));
  // a debugging detail: kept in the full replay field, not in the short section of the answer text
  assert.match(delivered.engineRepro.rendered, /上下文已裁剪/u);
  assert.doesNotMatch(delivered.shortAnswer, /上下文已裁剪/u);
  assert.match(delivered.shortAnswer, /^主回答\n\n【引擎复现（实验性）】不适用\n\n原因：/u);
});

test("a financial failure after trimming retains the context marker and removal details", async () => {
  const session = createEngineReproSession({ env: { ENGINE_REPRO_ENABLED: "true", ENGINE_REPRO_PLANNER_MAX_INPUT: "1" }, isAdmin: true,
    auditIdPromise: Promise.resolve(null), waitUntil: () => {}, engine, cidMap: { 12950: 14558127 }, limits: { admit: async () => {} },
    modelCall: async () => { throw Object.assign(new Error("engine_repro_daily_budget_exceeded"), { code: "engine_repro_daily_budget_exceeded" }); } });
  session.onCardTextsReady({ question: base.question, cardResolution: { resolvedCards: [{ id: "12950", input: "灰流丽" }] }, cards: [{ id: "12950", ...cardsById.get("12950") }] });
  const record = await session.promise;
  assert.deepEqual(record.summary.reasonCodes, ["budget_exceeded"]);
  assert.match(record.rendered, /engine_repro_daily_budget_exceeded/u);
  assert.ok(record.summary.flags.includes("context_trimmed"));
  assert.match(record.rendered, /相关卡\(123\)/u);
  assert.ok(Number.isFinite(record.timings.plannerMs));
});
