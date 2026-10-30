import assert from "node:assert/strict";
import test from "node:test";
import { CONCISE_DISCLAIMER, CONCISE_RESULTS_LEAD, engineReproConciseText, engineReproDigest } from "../backend/engineRepro/concise.mjs";
import { CONCLUSION_INSTRUCTIONS, CONCLUSION_MODEL, buildConclusionInput, conclusionConfigFromEnv, parseConclusionOutput,
  writeConclusion } from "../backend/engineRepro/conclusion.mjs";
import { OFFICIAL_RESPONSES_URL, createOfficialModelCall, usageCostUsd } from "../backend/engineRepro/modelCalls.mjs";
import { runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { attachEngineReproWhenReady, createEngineReproSession } from "../backend/engineRepro/session.mjs";

// Synthetic cards (passcode -> engine name); no real card or question is special-cased anywhere.
const SPELL = 9100001, MONSTER = 9100002, HAND_TRAP = 9100003, TRAP = 9100004;
const NAMES = new Map([[SPELL, "测试属性魔法"], [MONSTER, "测试怪兽B"], [HAND_TRAP, "测试手坑"], [TRAP, "测试反击陷阱"]]);
const cidMap = { 1: SPELL, 2: MONSTER, 3: HAND_TRAP, 4: TRAP };
const identityOf = (...cids) => ({ resolved: cids.map((cid) => ({ cid: String(cid), mentionedAs: [NAMES.get(cidMap[cid])], resolutionSources: [] })),
  unresolved: [], groupMentions: [] });
const cardsById = new Map(Object.keys(cidMap).map((cid) => [cid, { id: cid, name: NAMES.get(cidMap[cid]), effectText: "卡文" }]));

const plan = (subQuestion, assumptions = []) => JSON.stringify({ applicability: "applicable", reason_code: null, archetype_name: null,
  quoted_span: subQuestion.quoted_span, what_not_why: false, assumptions, extra_cards: [], sub_questions: [subQuestion] });

// Question A (a result question about an attribute): the plan names the card to report; the engine state carries
// every field of the state contract (docs/ocg-engine-integration.md 引擎状态接口规格), the attribute among them.
const ATTRIBUTE_QUESTION = "对方的「测试怪兽B」被「测试属性魔法」的效果改变属性后，到我方战斗阶段时它是什么属性？";
const attributePlan = plan({ id: "q1", quoted_span: "它是什么属性", unrepresentable: null, branches: [{ id: "b1", assumption: null,
  observe: "测试怪兽B 现在的属性", result_cards: [{ card: MONSTER, controller: 1 }],
  scenario: { first_player: 0, players: [{ hand: [SPELL] }, { mzone: [{ seq: 0, code: MONSTER, position: "faceup_attack" }] }] },
  actions: { setup: [{ player: 0, decision: "idle", choose: { cmd: "activate", card: SPELL } }] } }] }, ["双方无其他适用效果"]);
const monsterState = { card: MONSTER, name: "测试怪兽B", seq: 0, position: "faceup_attack", owner: 1, type: 0x1 | 0x20,
  attribute: 0x20, race: 0x2, level: 4, attack: 1900, base_attack: 1900, defense: 1200, base_defense: 1200, disabled: false,
  counters: [], targets: [] };
const attributeEngineResult = () => ({ status: "replayed", reason_code: null, failure: null, probes: [], log: [],
  decisions: [{ decision: { index: 9, kind: "battle", player: 0, phase: "battle_start", turn: 1, turn_player: 0, options: [] },
    by: "end", choice: null, log_pos: 0 }],
  state: { players: { 0: { lp: 8000, mzone: [], szone: [], hand: [], grave: [{ card: SPELL, name: "测试属性魔法", seq: 0 }] },
    1: { lp: 8000, mzone: [monsterState], szone: [], hand: [], grave: [] } } },
  rendered_zh: "【引擎复现】\n状态：已按步骤回放完成" });
const ATTRIBUTE_OBSERVATION = "到我方战斗阶段时，对方场上的「测试怪兽B」：表侧攻击表示，种类 怪兽/效果，属性 暗，种族 魔法师，等级 4，"
  + "攻击力 1900（原本 1900），守备力 1200（原本 1200），效果没有被无效，没有指示物、装备卡、持续对象";

// Question B (can it be activated): the plan probes our chain window; the engine reports the offer.
const ACTIVATION_QUESTION = "对方发动「测试手坑」时，我方能连锁发动盖放的「测试反击陷阱」吗？";
const activationPlan = plan({ id: "q1", quoted_span: "能连锁发动", unrepresentable: null, branches: [{ id: "b1", assumption: null,
  observe: "我方能否连锁发动测试反击陷阱",
  scenario: { first_player: 0, players: [{ szone: [{ seq: 0, code: TRAP, position: "facedown" }] }, { hand: [HAND_TRAP] }] },
  actions: { setup: [{ player: 1, decision: "chain", choose: { card: HAND_TRAP, from: "hand" } }],
    probes: [{ after: 1, player: 0, decision_kind: "chain", target: { card: TRAP } }] } }] });
const chainWindow = { index: 7, kind: "chain", player: 0, phase: "main1", turn: 1, turn_player: 0,
  options: [{ id: 0, cmd: "chain", card: TRAP, name: "测试反击陷阱", controller: 0, from: "szone" }] };
const activationEngineResult = () => ({ status: "replayed", reason_code: null, failure: null, log: [],
  probes: [{ index: 0, after: 1, player: 0, decision_kind: "chain", target: { card: TRAP }, result: "present", ambiguous: false,
    windows: [{ decision: 7, kind: "chain", phase: "main1", hint: null, options: chainWindow.options, contains_target: true,
      chain_links: 1, in_activation: false, in_resolution: false, after_chain_end: false }] }],
  decisions: [{ decision: chainWindow, by: "pass", choice: "pass", log_pos: 0 }],
  state: { players: { 0: { lp: 8000 }, 1: { lp: 8000 } } }, rendered_zh: "【引擎复现】\n状态：已按步骤回放完成" });

function engineReturning(result) {
  return async (op, body) => {
    if (op === "cards") return { cards: (body.codes || []).map((code) => ({ code, exists: true, name: NAMES.get(code) || `工具卡${code}`,
      types: ["怪兽"], text: "t" })) };
    if (op === "related") return { related: [] };
    if (op === "reproduce") return { result: { ...result(), scenario: body.scenario } };
    throw new Error(`unexpected engine op ${op}`);
  };
}

// The official OpenAI transport (modelCalls.mjs createOfficialModelCall) over a mock fetch. The planner and the
// conclusion call share it; the mock tells them apart by their instructions and advances a fake clock.
function mockOpenAi({ planOutput, conclusion = null, conclusionHttpStatus = 200, conclusionStatus = "completed", clockRef = { t: 0 },
  planMs = 2000, conclusionMs = 3000 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, OFFICIAL_RESPONSES_URL);
    const body = JSON.parse(init.body);
    const stage = body.instructions === CONCLUSION_INSTRUCTIONS ? "conclusion" : "plan";
    calls.push({ stage, body, authorization: init.headers.authorization });
    clockRef.t += stage === "conclusion" ? conclusionMs : planMs;
    if (stage === "conclusion" && conclusionHttpStatus !== 200) {
      return new Response(JSON.stringify({ error: { code: "server_error" } }), { status: conclusionHttpStatus });
    }
    const text = stage === "conclusion" ? (typeof conclusion === "string" ? conclusion : JSON.stringify(conclusion)) : planOutput;
    const usage = stage === "conclusion" ? { input_tokens: 1400, output_tokens: 350 } : { input_tokens: 9000, output_tokens: 900 };
    return new Response(JSON.stringify({ id: `resp-${calls.length}`, model: body.model,
      status: stage === "conclusion" ? conclusionStatus : "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }], usage }), { status: 200 });
  };
  return { fetchImpl, calls, clockRef };
}

function fakeLimits() {
  const ledger = { reserved: [], settled: [] };
  return { ledger, admit: async () => {}, reserve: async (usd) => { ledger.reserved.push(usd); return { usd }; },
    settle: async (reservation, actual) => { ledger.settled.push([reservation.usd, actual]); } };
}

async function reproduce({ question, planOutput, engineResult, identity, conclusion, conclusionHttpStatus, conclusionStatus,
  config = CONCLUSION_MODEL }) {
  const transport = mockOpenAi({ planOutput, conclusion, conclusionHttpStatus, conclusionStatus });
  const limits = fakeLimits();
  const modelCall = createOfficialModelCall({ env: { ENGINE_REPRO_OPENAI_API_KEY: "test-key" }, limits, fetchImpl: transport.fetchImpl });
  const record = await runEngineReproduction({ question, identity, cardsById, cidMap, engine: engineReturning(engineResult), modelCall,
    clock: () => transport.clockRef.t, conclusion: config });
  return { record, transport, limits, text: engineReproConciseText(engineReproDigest(record)) };
}

const LOG_WORDS = /回放|日志|行动选择|窗口|决策|探测|分支|setup/u;

test("golden (attribute question): the model's sentence, the observation it used verbatim, board, assumption, disclaimer", async () => {
  const { record, transport, limits, text } = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan,
    engineResult: attributeEngineResult, identity: identityOf(1, 2),
    conclusion: { conclusion: "在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」是暗属性。", used: ["o1"] } });
  assert.equal(text, [
    "【ygopro 引擎复现（实验性）】已复现",
    "结论：在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」是暗属性。",
    `依据的引擎观察值：\n- ${ATTRIBUTE_OBSERVATION}`,
    "局面：我方手卡 测试属性魔法；对方场上 测试怪兽B（表侧攻击）。",
    "假设：双方无其他适用效果。",
    CONCISE_DISCLAIMER,
  ].join("\n\n"));
  assert.doesNotMatch(text, LOG_WORDS);
  // the request: GPT-6 Luna, reasoning low, JSON output, the reproduction's own key; the input carries the question, what
  // the plan looks at and the numbered observation with every field (attribute, race, level, ATK/DEF, ...)
  const call = transport.calls.find((item) => item.stage === "conclusion");
  assert.deepEqual([call.body.model, call.body.reasoning, call.body.text, call.body.max_output_tokens, call.authorization],
    ["gpt-6-luna", { effort: "low" }, { format: { type: "json_object" } }, CONCLUSION_MODEL.maxOutput, "Bearer test-key"]);
  assert.ok(call.body.input.includes(ATTRIBUTE_QUESTION));
  assert.ok(call.body.input.includes("- 子问题 1「它是什么属性」：看点：测试怪兽B 现在的属性；要看结果的卡：对方的「测试怪兽B」"));
  assert.ok(call.body.input.includes(`[o1] ${ATTRIBUTE_OBSERVATION}`));
  // its time and cost are the engine section's own: their own timing entry and model-usage stage, reserved in the
  // reproduction's budget bucket before the call and settled afterwards
  assert.equal(record.conclusion.status, "done");
  assert.deepEqual(record.conclusion.used, [{ id: "o1", text: ATTRIBUTE_OBSERVATION }]);
  assert.deepEqual([record.timings.plannerMs, record.timings.conclusionMs], [2000, 3000]);
  assert.deepEqual(record.modelUsage.map((usage) => usage.stage), ["plan", "conclusion"]);
  const usage = record.modelUsage.at(-1);
  assert.deepEqual([usage.inputTokens, usage.outputTokens], [1400, 350]);
  assert.equal(usage.costUsd, usageCostUsd("gpt-6-luna", { input_tokens: 1400, output_tokens: 350 }));
  assert.equal(limits.ledger.reserved.length, 2, "planner and conclusion each reserve in the reproduction's bucket");
  assert.deepEqual(limits.ledger.settled.at(-1)[1], usage.costUsd);
});

test("golden (can it be activated): same code path; the sentence cites the check point, not a card state", async () => {
  const { record, text } = await reproduce({ question: ACTIVATION_QUESTION, planOutput: activationPlan,
    engineResult: activationEngineResult, identity: identityOf(3, 4),
    conclusion: { conclusion: "在 ygopro 里，对方发动「测试手坑」后，我方可以连锁发动「测试反击陷阱」。", used: ["o1"] } });
  assert.equal(text, [
    "【ygopro 引擎复现（实验性）】已复现",
    "结论：在 ygopro 里，对方发动「测试手坑」后，我方可以连锁发动「测试反击陷阱」。",
    "依据的引擎观察值：\n- 我方在主要阶段1（连锁 1 处理前）可以选择「发动测试反击陷阱」",
    "局面：我方场上 测试反击陷阱（盖放）；对方手卡 测试手坑。",
    CONCISE_DISCLAIMER,
  ].join("\n\n"));
  assert.equal(record.conclusion.status, "done");
  assert.doesNotMatch(text, /属性|攻击力/u, "nothing about card fields: the question did not ask");
  assert.doesNotMatch(text, LOG_WORDS);
});

test("the question decides the sentence: an ATK question over the very same engine state cites the same observation", async () => {
  const atk = await reproduce({ question: "对方的「测试怪兽B」被「测试属性魔法」的效果影响后，到我方战斗阶段时攻击力是多少？",
    planOutput: attributePlan, engineResult: attributeEngineResult, identity: identityOf(1, 2),
    conclusion: { conclusion: "在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」攻击力是 1900，原本攻击力也是 1900。", used: ["o1"] } });
  const lines = atk.text.split("\n\n");
  assert.equal(lines[1], "结论：在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」攻击力是 1900，原本攻击力也是 1900。");
  assert.equal(lines[2], `依据的引擎观察值：\n- ${ATTRIBUTE_OBSERVATION}`, "the observation is the full state, whatever was asked");
});

test("the model call fails or answers out of shape: the section lists every observation instead", async () => {
  const fallback = [
    "【ygopro 引擎复现（实验性）】已复现",
    [CONCISE_RESULTS_LEAD, `- 测试怪兽B 现在的属性——${ATTRIBUTE_OBSERVATION}`].join("\n"),
    "局面：我方手卡 测试属性魔法；对方场上 测试怪兽B（表侧攻击）。",
    "假设：双方无其他适用效果。",
    CONCISE_DISCLAIMER,
  ].join("\n\n");
  const cases = [
    [{ conclusionHttpStatus: 500 }, "engine_repro_model_error", false],
    [{ conclusionStatus: "incomplete", conclusion: { conclusion: "截断", used: ["o1"] } }, "response_incomplete", true],
    [{ conclusion: "不是 JSON" }, "output_not_json", true],
    [{ conclusion: { conclusion: "", used: ["o1"] } }, "conclusion_missing", true],
    [{ conclusion: { conclusion: "是暗属性。", used: [] } }, "used_missing", true],
    [{ conclusion: { conclusion: "是暗属性。", used: ["o1", "o7"] } }, "unknown_observation:o7", true],
  ];
  for (const [transport, error, responded] of cases) {
    const { record, text } = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan, engineResult: attributeEngineResult,
      identity: identityOf(1, 2), ...transport });
    assert.deepEqual([record.conclusion.status, record.conclusion.error], ["failed", error], error);
    assert.equal(text, fallback, error);
    assert.equal(record.summary.status, "已复现", "a failed conclusion never fails the reproduction");
    assert.equal(record.timings.conclusionMs, 3000, `${error}: the attempt is timed with the engine section`);
    assert.equal(record.modelUsage.some((usage) => usage.stage === "conclusion"), responded, `${error}: usage only when the provider answered`);
  }
});

test("ENGINE_REPRO_CONCLUSION=off: no call, the mechanical list", async () => {
  for (const value of ["off", "0", "false", "no"]) {
    const config = conclusionConfigFromEnv({ ENGINE_REPRO_CONCLUSION: value });
    assert.equal(config.enabled, false);
    const { record, transport, text } = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan,
      engineResult: attributeEngineResult, identity: identityOf(1, 2), config,
      conclusion: { conclusion: "不应出现", used: ["o1"] } });
    assert.deepEqual(transport.calls.map((call) => call.stage), ["plan"]);
    assert.deepEqual([record.conclusion.status, record.conclusion.reason], ["skipped", "disabled"]);
    assert.ok(text.includes(CONCISE_RESULTS_LEAD) && !text.includes("不应出现"));
  }
  assert.equal(conclusionConfigFromEnv({}).enabled, true, "on by default");
  assert.equal(conclusionConfigFromEnv({ ENGINE_REPRO_CONCLUSION: "on" }).enabled, true);
});

test("no call when there is nothing the engine observed: 未复现, 不适用, an empty result", async () => {
  const failing = () => ({ status: "not_reproduced", reason_code: "action_mismatch", probes: [], decisions: [], log: [],
    failure: { reason: "not_found", step: 0, step_spec: { player: 0, decision: "idle", choose: { cmd: "activate", card: SPELL } },
      decision: { kind: "idle", player: 0, phase: "main1", options: [] } } });
  const failed = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan, engineResult: failing, identity: identityOf(1, 2),
    conclusion: { conclusion: "不应出现", used: ["o1"] } });
  assert.equal(failed.record.summary.status, "未复现");
  assert.deepEqual(failed.record.conclusion, { status: "skipped", reason: "not_reproduced" });
  assert.deepEqual(failed.transport.calls.map((call) => call.stage), ["plan", "plan"], "plan and repair only");
  const notApplicable = await reproduce({ question: "什么是连锁？", identity: identityOf(1),
    planOutput: JSON.stringify({ applicability: "not_applicable", reason_code: "pure_rule", quoted_span: "什么是连锁", sub_questions: [] }),
    engineResult: attributeEngineResult });
  assert.equal(notApplicable.record.conclusion.reason, "not_reproduced");
  const nothing = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan, identity: identityOf(1, 2),
    engineResult: () => ({ status: "replayed", probes: [], decisions: [], log: [], rendered_zh: "x" }) });
  assert.deepEqual([nothing.record.summary.status, nothing.record.conclusion.reason], ["已复现", "no_observations"]);
  assert.deepEqual(nothing.transport.calls.map((call) => call.stage), ["plan"]);
});

test("the conclusion input: question, plan focus, numbered observations with 未取得, background apart; no main answer", () => {
  const digest = {
    assumptions: ["双方无其他适用效果"],
    subQuestions: [
      { label: "子问题 1「属性」", quotedSpan: "属性", unrepresentable: false, branches: [{ label: "子问题 1「属性」", ok: true,
        assumption: null, observe: "现在的属性", resultCards: [{ card: MONSTER, controller: 1, name: "测试怪兽B" }],
        board: { sides: [{ side: 1, zones: [{ zone: "场上", cards: [{ name: "测试怪兽B", label: "表侧攻击" }] }] }], others: {} } }] },
      { label: "子问题 2「能发动吗」", quotedSpan: "能发动吗", unrepresentable: true, unrepresentableReason: "题目没说是谁发动", branches: [] },
    ],
    observations: [{ id: "o1", label: "子问题 1「属性」", text: "子问题 1「属性」：到我方战斗阶段时，对方场上的「测试怪兽B」：表侧攻击表示；种类、属性未取得" }],
    notReproduced: [{ label: "子问题 2「能发动吗」", text: "搭不出题目说的局面——题目没说是谁发动" }],
  };
  const input = buildConclusionInput({ question: "题目原文", digest });
  assert.equal(input, [
    "## 题目（原文）", "题目原文", "",
    "## 计划要看的",
    "- 子问题 1「属性」：看点：现在的属性；要看结果的卡：对方的「测试怪兽B」",
    "- 子问题 2「能发动吗」：没能复现（见“没能复现的部分”）", "",
    "## 引擎观察值（只能引用这些；“未取得”表示引擎没有返回这一项）",
    "[o1] 子问题 1「属性」：到我方战斗阶段时，对方场上的「测试怪兽B」：表侧攻击表示；种类、属性未取得", "",
    "## 没能复现的部分（背景，不是观察值）", "- 子问题 2「能发动吗」：搭不出题目说的局面——题目没说是谁发动", "",
    "## 计划补充的假设（背景，不是观察值）", "- 双方无其他适用效果", "",
    "## 局面（计划搭的初始局面，背景，不是观察值）", "- 子问题 1「属性」：对方场上 测试怪兽B（表侧攻击）", "",
    "按要求输出 JSON。",
  ].join("\n"));
  // the instructions tell the model to answer what is asked, use only the observations, say 未取得 plainly
  for (const rule of ["题目问哪一项就说哪一项", "只用引擎观察值里写出来的值", "直说引擎没有给出这一项", "不评价任何回答或官方裁定的对错",
    "used 列出句子用到的观察值编号"]) assert.ok(CONCLUSION_INSTRUCTIONS.includes(rule), rule);
});

test("output shape check only: ids resolved in section order, each once; nothing about the sentence itself", () => {
  const observations = [{ id: "o1", text: "甲" }, { id: "o2", text: "乙" }, { id: "o3", text: "丙" }];
  assert.deepEqual(parseConclusionOutput(JSON.stringify({ conclusion: " 引擎里\n是暗属性。 ", used: ["o3", "o1", "o3"] }), observations),
    { ok: true, text: "引擎里 是暗属性。", used: [{ id: "o1", text: "甲" }, { id: "o3", text: "丙" }] });
  // a sentence that does not even mention its observation is accepted: no semantic check
  assert.equal(parseConclusionOutput(JSON.stringify({ conclusion: "任意句子", used: ["o2"] }), observations).ok, true);
  for (const [output, error] of [["", "output_not_json"], ["[]", "output_not_object"], ["{\"used\":[\"o1\"]}", "conclusion_missing"],
    ["{\"conclusion\":\"x\"}", "used_missing"], ["{\"conclusion\":\"x\",\"used\":[1]}", "unknown_observation:(empty)"]]) {
    assert.deepEqual(parseConclusionOutput(output, observations), { ok: false, error }, output);
  }
});

test("writeConclusion never throws: a budget refusal or a missing call is a recorded outcome", async () => {
  const digest = { subQuestions: [], observations: [{ id: "o1", text: "甲" }], notReproduced: [] };
  const refused = await writeConclusion({ question: "q", digest, modelCall: async () => {
    throw Object.assign(new Error("engine_repro_daily_budget_exceeded"), { code: "engine_repro_daily_budget_exceeded" }); } });
  assert.deepEqual([refused.status, refused.error, refused.responded], ["failed", "engine_repro_daily_budget_exceeded", undefined]);
  assert.equal((await writeConclusion({ question: "q", digest })).reason, "no_model_call");
  assert.equal((await writeConclusion({ question: "q", digest: { observations: [{ id: "o1", text: "甲", empty: true }] },
    modelCall: async () => assert.fail("not called") })).reason, "no_observations");
});

// ---------------------------------------------------------------------------------------------------
// Production wiring: the session builds the official model call itself; the response carries the section.
// ---------------------------------------------------------------------------------------------------

function fakeRedis() {
  const data = new Map();
  const command = async (_env, _fetch, [op, key, value]) => {
    if (op === "SET") { data.set(key, value); return "OK"; }
    if (op === "GET") return data.has(key) ? data.get(key) : null;
    throw new Error(`unexpected ${op}`);
  };
  return { data, command };
}

for (const switchValue of [undefined, "off"]) {
  test(`session (ENGINE_REPRO_CONCLUSION ${switchValue ?? "unset"}): the section and its separate time and cost`, async () => {
    const redis = fakeRedis();
    const clockRef = { t: 0 };
    const transport = mockOpenAi({ planOutput: attributePlan, clockRef,
      conclusion: { conclusion: "在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」是暗属性。", used: ["o1"] } });
    const audits = [];
    const pending = [];
    const env = { ENGINE_REPRO_ENABLED: "true", ENGINE_REPRO_OPENAI_API_KEY: "test-key",
      ...(switchValue ? { ENGINE_REPRO_CONCLUSION: switchValue } : {}) };
    const session = createEngineReproSession({ env, requestStartedAt: 0, auditIdPromise: Promise.resolve("audit-c"),
      now: () => clockRef.t, waitUntil: (promise) => pending.push(promise), engine: engineReturning(attributeEngineResult), cidMap,
      limits: fakeLimits(), fetchImpl: transport.fetchImpl, command: redis.command,
      saveAudit: async (_id, patch) => { audits.push(patch); } });
    session.onCardTextsReady({ question: ATTRIBUTE_QUESTION, cardResolution: { resolvedCards: [{ id: "1", input: "测试属性魔法" },
      { id: "2", input: "测试怪兽B" }] }, cards: [...cardsById.values()] });
    await Promise.all(pending);
    const answer = await attachEngineReproWhenReady({ shortAnswer: "主回答" }, { env, auditId: "audit-c", requestStartedAt: 0,
      waitDeadlineAt: Date.now() + 60_000, now: () => clockRef.t, command: redis.command });
    const engineRepro = answer.engineRepro;
    if (switchValue === "off") {
      assert.deepEqual(transport.calls.map((call) => call.stage), ["plan"]);
      assert.deepEqual([engineRepro.conclusion.status, engineRepro.conclusion.reason], ["skipped", "disabled"]);
      assert.ok(engineRepro.concise.includes(CONCISE_RESULTS_LEAD));
      assert.equal(engineRepro.timings.conclusionMs, 0);
      return;
    }
    assert.deepEqual(transport.calls.map((call) => call.stage), ["plan", "conclusion"]);
    assert.equal(answer.shortAnswer, `主回答\n\n${engineRepro.concise}`);
    assert.ok(engineRepro.concise.includes("结论：在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」是暗属性。"));
    assert.ok(engineRepro.concise.includes(`依据的引擎观察值：\n- ${ATTRIBUTE_OBSERVATION}`));
    assert.deepEqual({ ...engineRepro.conclusion, ms: null }, { status: "done", promptVersion: engineRepro.conclusion.promptVersion,
      model: "gpt-6-luna", effort: "low", used: ["o1"], ms: null,
      costUsd: usageCostUsd("gpt-6-luna", { input_tokens: 1400, output_tokens: 350 }), inputTokens: 1400, outputTokens: 350 });
    // engine-section telemetry, apart from the main answer: its own timing entry and usage stage
    assert.deepEqual([engineRepro.timings.plannerMs, engineRepro.timings.conclusionMs], [2000, 3000]);
    assert.deepEqual(engineRepro.modelUsage.map((usage) => usage.stage), ["plan", "conclusion"]);
    assert.equal(audits.at(-1).engineRepro.timings.conclusionMs, 3000);
    assert.equal(Object.hasOwn(answer, "debug"), false, "nothing is added to the main answer's own fields");
  });
}
