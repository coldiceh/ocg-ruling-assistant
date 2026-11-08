import assert from "node:assert/strict";
import test from "node:test";
import { CONCISE_DISCLAIMER, CONCISE_RESULTS_LEAD, engineReproConciseText, engineReproDigest } from "../backend/engineRepro/concise.mjs";
import { CONCLUSION_INSTRUCTIONS, CONCLUSION_MODEL, buildConclusionInput, conclusionConfigFromEnv, conclusionQuestions,
  parseConclusionOutput, writeConclusion } from "../backend/engineRepro/conclusion.mjs";
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
// The conclusion's output contract since 2026-11-08: one entry per sub-question (ids q1, q2, … by position).
const perQuestion = (...entries) => ({ perQuestion: entries.map(([sentence, used, verdict = "observed"], index) =>
  ({ id: `q${index + 1}`, verdict, sentence, used })) });

test("golden (attribute question): the model's sentence, the observation it used verbatim, board, assumption, disclaimer", async () => {
  const { record, transport, limits, text } = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan,
    engineResult: attributeEngineResult, identity: identityOf(1, 2),
    conclusion: perQuestion(["在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」是暗属性。", ["o1"]]) });
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
    conclusion: perQuestion(["在 ygopro 里，对方发动「测试手坑」后，我方可以连锁发动「测试反击陷阱」。", ["o1"]]) });
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
    conclusion: perQuestion(["在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」攻击力是 1900，原本攻击力也是 1900。", ["o1"]]) });
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
    [{ conclusionStatus: "incomplete", conclusion: perQuestion(["截断", ["o1"]]) }, "response_incomplete", true],
    [{ conclusion: "不是 JSON" }, "output_not_json", true],
    // the single-sentence shape used before 2026-11-08 is not the contract any more
    [{ conclusion: { conclusion: "是暗属性。", used: ["o1"] } }, "per_question_missing", true],
    [{ conclusion: perQuestion(["", ["o1"]]) }, "sentence_missing:q1", true],
    [{ conclusion: perQuestion(["是暗属性。", []]) }, "used_missing:q1", true],
    [{ conclusion: perQuestion(["是暗属性。", ["o1", "o7"]]) }, "unknown_observation:o7", true],
    [{ conclusion: perQuestion(["是暗属性。", ["o1"], "maybe"]) }, "verdict_invalid:q1", true],
    [{ conclusion: perQuestion(["是暗属性。", ["o1"]], ["多出来的一问", ["o1"]]) }, "unknown_question:q2", true],
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
      conclusion: perQuestion(["不应出现", ["o1"]]) });
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
    conclusion: perQuestion(["不应出现", ["o1"]]) });
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
    "## 小问（每个小问写一句；id 用方括号里的编号）",
    "- [q1] 子问题 1「属性」",
    "- [q2] 子问题 2「能发动吗」（没能复现）", "",
    "## 引擎观察值（只能引用这些；“未取得”表示引擎没有返回这一项）",
    "[o1] 子问题 1「属性」：到我方战斗阶段时，对方场上的「测试怪兽B」：表侧攻击表示；种类、属性未取得", "",
    "## 没能复现的部分（背景，不是观察值）", "- 子问题 2「能发动吗」：搭不出题目说的局面——题目没说是谁发动", "",
    "## 计划补充的假设（背景，不是观察值）", "- 双方无其他适用效果", "",
    "## 局面（计划搭的初始局面，背景，不是观察值）", "- 子问题 1「属性」：对方场上 测试怪兽B（表侧攻击）", "",
    "按要求输出 JSON。",
  ].join("\n"));
  // the instructions tell the model to answer each sub-question, use an observation that answers it, name the missing
  // observation instead of a vague "no result", use only the observations
  for (const rule of ["每个小问单独写一句", "题目问哪一项就说哪一项", "观察值里有能直接回答这个小问的事实，就必须用它作答",
    "引擎里的结果是……", "引擎记录里看不出：缺少……的观察", "不要写“引擎没有给出结果”这类笼统的话", "只用引擎观察值里写出来的值",
    "不评价任何回答或官方裁定的对错", "used 列出句子用到的观察值编号"]) assert.ok(CONCLUSION_INSTRUCTIONS.includes(rule), rule);
  assert.doesNotMatch(CONCLUSION_INSTRUCTIONS, /直说引擎没有给出这一项/u, "the vague wording is gone");
});

test("output shape check only: one entry per sub-question, ids resolved in section order; nothing about the sentences", () => {
  const observations = [{ id: "o1", text: "甲" }, { id: "o2", text: "乙" }, { id: "o3", text: "丙" }];
  const questions = conclusionQuestions({ subQuestions: [{ quotedSpan: "一" }, { quotedSpan: "二" }] });
  assert.deepEqual(questions.map((item) => [item.id, item.index, item.head]), [["q1", 0, "子问题 1「一」"], ["q2", 1, "子问题 2「二」"]]);
  const output = { perQuestion: [
    { id: "q2", verdict: "not_observable", sentence: "引擎记录里看不出：缺少选卡时可选的卡的观察。", used: [] },
    { id: "q1", verdict: "observed", sentence: " 引擎里\n是暗属性。 ", used: ["o3", "o1", "o3"] }] };
  assert.deepEqual(parseConclusionOutput(JSON.stringify(output), observations, questions), { ok: true,
    perQuestion: [
      { id: "q1", index: 0, verdict: "observed", sentence: "引擎里 是暗属性。", used: [{ id: "o1", text: "甲" }, { id: "o3", text: "丙" }] },
      { id: "q2", index: 1, verdict: "not_observable", sentence: "引擎记录里看不出：缺少选卡时可选的卡的观察。", used: [] }],
    text: "引擎里 是暗属性。 引擎记录里看不出：缺少选卡时可选的卡的观察。",
    used: [{ id: "o1", text: "甲" }, { id: "o3", text: "丙" }] });
  // a sentence that does not even mention its observation, or says the vague thing, is accepted: no semantic check
  const loose = { perQuestion: [{ id: "q1", verdict: "observed", sentence: "任意句子", used: ["o2"] },
    { id: "q2", verdict: "not_observable", sentence: "引擎没有给出结果", used: ["o2"] }] };
  assert.equal(parseConclusionOutput(JSON.stringify(loose), observations, questions).ok, true);
  const entry = (overrides) => ({ id: "q1", verdict: "observed", sentence: "x", used: ["o1"], ...overrides });
  const second = entry({ id: "q2" });
  for (const [value, error] of [
    ["", "output_not_json"], ["[]", "output_not_object"], [{ conclusion: "x", used: ["o1"] }, "per_question_missing"],
    [{ perQuestion: [] }, "per_question_missing"], [{ perQuestion: ["x"] }, "entry_not_object"],
    [{ perQuestion: [entry({ id: "q9" }), second] }, "unknown_question:q9"],
    [{ perQuestion: [entry(), entry(), second] }, "duplicate_question:q1"],
    [{ perQuestion: [entry()] }, "question_missing:q2"],
    [{ perQuestion: [entry({ verdict: "yes" }), second] }, "verdict_invalid:q1"],
    [{ perQuestion: [entry({ sentence: " " }), second] }, "sentence_missing:q1"],
    [{ perQuestion: [entry({ used: "o1" }), second] }, "used_missing:q1"],
    [{ perQuestion: [entry({ used: [] }), second] }, "used_missing:q1"],
    [{ perQuestion: [entry({ used: [1] }), second] }, "unknown_observation:(empty)"],
  ]) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    assert.deepEqual(parseConclusionOutput(text, observations, questions), { ok: false, error }, text);
  }
});

test("a fault while building the conclusion never fails the reproduction", async () => {
  // engine state the digest cannot read (a getter that throws, on a copy) reaches the conclusion step only
  const hostile = () => {
    const result = attributeEngineResult();
    const monster = { ...monsterState };
    Object.defineProperty(monster, "attribute", { enumerable: true, get() { throw new Error("boom"); } });
    result.state.players[1].mzone = [monster];
    return result;
  };
  const transport = mockOpenAi({ planOutput: attributePlan, conclusion: { conclusion: "不应出现", used: ["o1"] } });
  const record = await runEngineReproduction({ question: ATTRIBUTE_QUESTION, identity: identityOf(1, 2), cardsById, cidMap,
    engine: engineReturning(hostile), clock: () => transport.clockRef.t, conclusion: CONCLUSION_MODEL,
    modelCall: createOfficialModelCall({ env: { ENGINE_REPRO_OPENAI_API_KEY: "test-key" }, limits: fakeLimits(), fetchImpl: transport.fetchImpl }) });
  assert.equal(record.summary.status, "已复现");
  assert.deepEqual([record.conclusion.status, record.conclusion.error], ["failed", "conclusion_internal_error:boom"]);
  assert.deepEqual(transport.calls.map((call) => call.stage), ["plan"], "no conclusion request was sent");
  assert.ok(typeof record.rendered === "string" && Number.isFinite(record.timings.finishedAtMs));
});

test("writeConclusion never throws: a budget refusal or a missing call is a recorded outcome", async () => {
  const digest = { subQuestions: [{ quotedSpan: "q", branches: [] }], observations: [{ id: "o1", text: "甲" }], notReproduced: [] };
  const refused = await writeConclusion({ question: "q", digest, modelCall: async () => {
    throw Object.assign(new Error("engine_repro_daily_budget_exceeded"), { code: "engine_repro_daily_budget_exceeded" }); } });
  assert.deepEqual([refused.status, refused.error, refused.responded], ["failed", "engine_repro_daily_budget_exceeded", undefined]);
  assert.equal((await writeConclusion({ question: "q", digest })).reason, "no_model_call");
  assert.equal((await writeConclusion({ question: "q", digest: { observations: [{ id: "o1", text: "甲", empty: true }] },
    modelCall: async () => assert.fail("not called") })).reason, "no_observations");
  assert.equal((await writeConclusion({ question: "q", digest: { subQuestions: [], observations: [{ id: "o1", text: "甲" }] },
    modelCall: async () => assert.fail("not called") })).reason, "no_sub_questions");
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
      conclusion: perQuestion(["在 ygopro 里，到我方战斗阶段时，对方场上的「测试怪兽B」是暗属性。", ["o1"]]) });
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

// ---------------------------------------------------------------------------------------------------
// Golden (2026-11-08): "水晶机巧-继承玻纤·棱镜吃幽鬼兔，还能拉人吗，检测的到素材星级吗", two sub-questions, one sentence each.
// Not an engine run: the plan, the engine result and the model output are constructed here. The card (repo data
// 水晶机巧－玻璃光纤 棱彩, passcode 65400671): ① when Link Summoned, Special Summon from the Extra Deck 1 Tuner whose
// Level is at most the total original Levels of its Link Materials. The plan follows the new rules: the link
// materials are not cards of the question (幽鬼兔 stays the opponent's), and the Extra Deck holds Tuners on both
// sides of the limit (materials 2 + 2 = 4); the selection while ① resolves is a selection check point.
// ---------------------------------------------------------------------------------------------------
const PRISM = 65400671, RABBIT = 59438930, FORMULA = 50091196, DORON = 756652;
const MAT_TUNER = 9300013, TUNER4 = 9300011, TUNER6 = 9300012;   // synthetic
const PRISM_NAMES = new Map([[PRISM, "水晶机巧-继承玻纤·棱镜"], [RABBIT, "幽鬼兔"], [FORMULA, "方程式同调士"], [DORON, "多隆"],
  [MAT_TUNER, "测试调整怪兽"], [TUNER4, "测试同调调整甲"], [TUNER6, "测试同调调整乙"]]);
const SYNCHRO_TUNER = ["怪兽", "效果", "调整", "同调"];
const PRISM_FACTS = new Map([
  [FORMULA, { types: SYNCHRO_TUNER, level: 2, atk: 200, def: 1500, attribute: "光", race: "机械" }],
  [TUNER4, { types: SYNCHRO_TUNER, level: 4, atk: 1800, def: 1000, attribute: "光", race: "机械" }],
  [TUNER6, { types: SYNCHRO_TUNER, level: 6, atk: 2400, def: 1200, attribute: "光", race: "机械" }],
  [MAT_TUNER, { types: ["怪兽", "效果", "调整"], level: 2, atk: 500, def: 500, attribute: "地", race: "战士" }],
]);
const PRISM_QUESTION = "水晶机巧-继承玻纤·棱镜吃幽鬼兔，还能拉人吗，检测的到素材星级吗";
const prismCidMap = { 11: PRISM, 12: RABBIT };
const prismIdentity = { resolved: [{ cid: "11", mentionedAs: ["水晶机巧-继承玻纤·棱镜"], resolutionSources: [] },
  { cid: "12", mentionedAs: ["幽鬼兔"], resolutionSources: [] }], unresolved: [], groupMentions: [] };
const prismCards = new Map([["11", { id: "11", name: "水晶机巧－玻璃光纤 棱彩", effectText: "包含协调在内的怪兽2只以上……" }],
  ["12", { id: "12", name: "幽鬼兔", effectText: "①：场上的怪兽的效果发动时……将场上的该卡破坏。" }]]);
const prismScenario = { first_player: 0, players: [
  { mzone: [{ seq: 0, code: MAT_TUNER, position: "faceup_attack" }, { seq: 1, code: DORON, position: "faceup_attack" }],
    extra: [PRISM, FORMULA, TUNER4, TUNER6] },
  { hand: [RABBIT] }] };
const prismSetup = [
  { player: 0, decision: "idle", choose: { cmd: "spsummon", card: PRISM, from: "extra" } },
  { player: 0, decision: "select_card", choose: { cards: [{ card: MAT_TUNER, from: "mzone" }, { card: DORON, from: "mzone" }] } },
  { player: 0, decision: "select_place", choose: { place: { player: 0, zone: "mzone", seq: 5 } } },
  { player: 0, decision: "effect_yn", choose: { answer: true } },
  { player: 1, decision: "chain", choose: { card: RABBIT, from: "hand" } },
  { player: 0, decision: "select_card", choose: { cards: [{ card: FORMULA, from: "extra" }] } },
  { player: 0, decision: "select_place", choose: { place: { player: 0, zone: "mzone", seq: 0 } } },
];
const prismPlanOf = (q2Branch) => JSON.stringify({ applicability: "applicable", reason_code: null, archetype_name: null,
  quoted_span: "吃幽鬼兔，还能拉人吗", what_not_why: false,
  assumptions: ["以「测试调整怪兽」（2星调整）和填充卡「多隆」（2星）为连接素材，原本等级合计4",
    "额外卡组放方程式同调士2星、测试同调调整甲4星：不超过合计4，代表满足一侧",
    "额外卡组放测试同调调整乙6星：超过合计4，代表不满足一侧"],
  extra_cards: [{ code: FORMULA, name: "方程式同调士" }, { code: MAT_TUNER, name: "测试调整怪兽" },
    { code: TUNER4, name: "测试同调调整甲" }, { code: TUNER6, name: "测试同调调整乙" }],
  sub_questions: [
    { id: "q1", quoted_span: "还能拉人吗", unrepresentable: null, branches: [{ id: "b1", assumption: null,
      observe: "效果处理后调整是否被特殊召唤", result_cards: [{ card: FORMULA, controller: 0 }, { card: PRISM, controller: 0 }],
      scenario: prismScenario, actions: { setup: prismSetup } }] },
    { id: "q2", quoted_span: "检测的到素材星级吗", unrepresentable: null, branches: [{ id: "b1", assumption: null,
      scenario: prismScenario, actions: { setup: prismSetup }, ...q2Branch }] },
  ] });
const PRISM_SELECT_PROBES = [{ after: 5, player: 0, candidates: [{ card: FORMULA, from: "extra", side: "meets" },
  { card: TUNER4, from: "extra", side: "meets" }, { card: TUNER6, from: "extra", side: "fails" }] }];

const prismDecision = (index, kind, player, extra = {}) => ({ index, kind, player, phase: "main1", turn: 1, turn_player: 0, timing: null,
  chain_links: 0, in_activation: false, in_resolution: false, after_chain_end: false, options: [], ...extra });
const extraDeckTuner = (id, card, seq) => ({ id, cmd: "card", card, name: PRISM_NAMES.get(card), controller: 0, from: "extra", seq });
// The engine's log: link materials, 棱镜 summoned, ① chained by 幽鬼兔, 棱镜 destroyed, then ① resolves (the tuner
// selection at log position 9), 方程式同调士 summoned in Defense Position, our main phase again.
const prismLog = [
  { type: "move", card: MAT_TUNER, name: "测试调整怪兽", from: { player: 0, location: "mzone", seq: 0 }, to: { player: 0, location: "grave", seq: 0 }, reason: ["material", "link"] },
  { type: "move", card: DORON, name: "多隆", from: { player: 0, location: "mzone", seq: 1 }, to: { player: 0, location: "grave", seq: 1 }, reason: ["material", "link"] },
  { type: "move", card: PRISM, name: "水晶机巧-继承玻纤·棱镜", from: { player: 0, location: "extra", seq: 0 }, to: { player: 0, location: "mzone", seq: 5, position: "faceup_attack" }, reason: ["summon", "spsummon"] },
  { type: "spsummoned" },
  { type: "chaining", card: PRISM, name: "水晶机巧-继承玻纤·棱镜", player: 0, link: 1, desc: 0 },
  { type: "move", card: RABBIT, name: "幽鬼兔", from: { player: 1, location: "hand", seq: 0 }, to: { player: 1, location: "grave", seq: 0 }, reason: ["cost"] },
  { type: "chaining", card: RABBIT, name: "幽鬼兔", player: 1, link: 2, desc: 0 },
  { type: "move", card: PRISM, name: "水晶机巧-继承玻纤·棱镜", from: { player: 0, location: "mzone", seq: 5 }, to: { player: 0, location: "grave", seq: 2 }, reason: ["destroy", "effect"] },
  { type: "chain_solved" },
  { type: "move", card: FORMULA, name: "方程式同调士", from: { player: 0, location: "extra", seq: 1 }, to: { player: 0, location: "mzone", seq: 0, position: "faceup_defense" }, reason: ["summon", "spsummon"] },
  { type: "spsummoned" },
  { type: "chain_end" },
];
const prismEngineResult = () => ({ status: "replayed", reason_code: null, failure: null, probes: [], setup_consumed: 7,
  decisions: [
    { by: "setup", step: 0, choice: 0, log_pos: 0, decision: prismDecision(1, "idle", 0) },
    { by: "setup", step: 1, choice: [0, 1], log_pos: 0, decision: prismDecision(2, "select_card", 0, { min: 2, max: 2 }) },
    { by: "setup", step: 2, choice: 5, log_pos: 2, decision: prismDecision(3, "select_place", 0) },
    { by: "setup", step: 3, choice: true, log_pos: 4, decision: prismDecision(4, "effect_yn", 0) },
    { by: "setup", step: 4, choice: 0, log_pos: 5, decision: prismDecision(5, "chain", 1, { chain_links: 1,
      options: [{ id: 0, cmd: "chain", card: RABBIT, name: "幽鬼兔", controller: 1, from: "hand", seq: 0 }] }) },
    { by: "pass", choice: "pass", log_pos: 7, decision: prismDecision(6, "chain", 0, { chain_links: 2 }) },
    { by: "setup", step: 5, choice: [0], log_pos: 9, decision: prismDecision(7, "select_card", 0, { in_resolution: true, min: 1, max: 1,
      hint: { player: 0, hint_type: 3, id: 509, text: "请选择要特殊召唤的卡" },
      options: [extraDeckTuner(0, FORMULA, 1), extraDeckTuner(1, TUNER4, 2)] }) },
    { by: "setup", step: 6, choice: 0, log_pos: 9, decision: prismDecision(8, "select_place", 0, { in_resolution: true }) },
    { by: "end", choice: null, log_pos: 12, decision: prismDecision(9, "idle", 0) },
  ],
  log: prismLog,
  state: { players: {
    0: { lp: 8000, szone: [], hand: [], mzone: [{ card: FORMULA, name: "方程式同调士", seq: 0, position: "faceup_defense", owner: 0,
      type: 0x1 | 0x20 | 0x1000 | 0x2000, attribute: 0x10, race: 0x20, level: 2, attack: 200, base_attack: 200, defense: 1500,
      base_defense: 1500, disabled: false, counters: [], targets: [] }],
    grave: [{ card: MAT_TUNER, name: "测试调整怪兽", seq: 0 }, { card: DORON, name: "多隆", seq: 1 }, { card: PRISM, name: "水晶机巧-继承玻纤·棱镜", seq: 2 }],
    extra: [{ card: TUNER4, name: "测试同调调整甲", seq: 0 }, { card: TUNER6, name: "测试同调调整乙", seq: 1 }] },
    1: { lp: 8000, mzone: [], szone: [], hand: [], grave: [{ card: RABBIT, name: "幽鬼兔", seq: 0 }] } } },
  rendered_zh: "【引擎复现】\n状态：已按步骤回放完成" });

function prismEngine(calls) {
  return async (op, body) => {
    calls.push({ op, body });
    if (op === "cards") {
      return { cards: (body.codes || []).map((code) => ({ code, exists: true, name: PRISM_NAMES.get(code) || `工具卡${code}`,
        types: ["怪兽"], text: "t", ...(PRISM_FACTS.get(code) || {}) })) };
    }
    if (op === "related") return { related: [] };
    if (op === "reproduce") return { result: { ...prismEngineResult(), scenario: body.scenario } };
    throw new Error(`unexpected engine op ${op}`);
  };
}

async function reproducePrism({ q2Branch, conclusion }) {
  const transport = mockOpenAi({ planOutput: prismPlanOf(q2Branch), conclusion });
  const calls = [];
  const modelCall = createOfficialModelCall({ env: { ENGINE_REPRO_OPENAI_API_KEY: "test-key" }, limits: fakeLimits(), fetchImpl: transport.fetchImpl });
  const record = await runEngineReproduction({ question: PRISM_QUESTION, identity: prismIdentity, cardsById: prismCards, cidMap: prismCidMap,
    engine: prismEngine(calls), modelCall, clock: () => transport.clockRef.t, conclusion: CONCLUSION_MODEL });
  return { record, transport, calls, text: engineReproConciseText(engineReproDigest(record)) };
}

const Q1 = "子问题 1「还能拉人吗」";
const Q2 = "子问题 2「检测的到素材星级吗」";
const FORMULA_OBSERVATION = "到我方主要阶段1时，我方场上的「方程式同调士」：表侧守备表示，种类 怪兽/效果/调整/同调，属性 光，种族 机械，等级 2，"
  + "攻击力 200（原本 200），守备力 1500（原本 1500），效果没有被无效，没有指示物、装备卡、持续对象";
const PRISM_OBSERVATION = "到我方主要阶段1时，我方的「水晶机巧-继承玻纤·棱镜」在墓地（破坏，从场上送去墓地）：种类、属性、种族、等级、攻守等状态未取得";
const SELECTION_OBSERVATION = "我方在主要阶段1（连锁 1 处理中）选择卡（提示「请选择要特殊召唤的卡」）时，"
  + "可选：额外卡组的「方程式同调士」（效果·调整·同调 2星 光/机械 200/1500）、额外卡组的「测试同调调整甲」（效果·调整·同调 4星 光/机械 1800/1000）；"
  + "不可选：额外卡组的「测试同调调整乙」（效果·调整·同调 6星 光/机械 2400/1200）（括号里是卡片的原本数据）";
const PRISM_BOARD = "局面：我方场上 测试调整怪兽、多隆（表侧攻击），额外卡组 水晶机巧-继承玻纤·棱镜；对方手卡 幽鬼兔（另有其他辅助卡）。";
const PRISM_ASSUMPTIONS = "假设：以「测试调整怪兽」（2星调整）和填充卡「多隆」（2星）为连接素材，原本等级合计4；"
  + "额外卡组放方程式同调士2星、测试同调调整甲4星：不超过合计4，代表满足一侧；额外卡组放测试同调调整乙6星：超过合计4，代表不满足一侧。";
const SENTENCE_Q1 = "引擎里的结果是：「水晶机巧-继承玻纤·棱镜」被破坏送去墓地后，效果仍把「方程式同调士」以表侧守备表示特殊召唤到了我方场上。";

test("golden (棱镜): one sentence per sub-question; the selection's offered and refused cards answer the Level question", async () => {
  const { record, transport, calls, text } = await reproducePrism({ q2Branch: { observe: "效果处理时可选的调整", select_probes: PRISM_SELECT_PROBES },
    conclusion: perQuestion([SENTENCE_Q1, ["o1", "o2"]],
      ["引擎里的结果是：效果处理时可选的是 2 星的「方程式同调士」和 4 星的「测试同调调整甲」，6 星的「测试同调调整乙」不可选。", ["o3"]]) });
  assert.equal(record.summary.status, "已复现");
  assert.equal(text, [
    "【ygopro 引擎复现（实验性）】已复现",
    ["结论：",
      `- ${Q1}：${SENTENCE_Q1}`,
      `- ${Q2}：引擎里的结果是：效果处理时可选的是 2 星的「方程式同调士」和 4 星的「测试同调调整甲」，6 星的「测试同调调整乙」不可选。`].join("\n"),
    ["依据的引擎观察值：", `- ${Q1}：${FORMULA_OBSERVATION}`, `- ${Q1}：${PRISM_OBSERVATION}`, `- ${Q2}：${SELECTION_OBSERVATION}`].join("\n"),
    PRISM_BOARD,
    PRISM_ASSUMPTIONS,
    CONCISE_DISCLAIMER,
  ].join("\n\n"));
  assert.doesNotMatch(text, LOG_WORDS);
  assert.doesNotMatch(text, /\bo\d\b|\bq\d\b/u, "no ids in the text players read");
  // the request lists the sub-questions with their ids, the contrast candidates and the numbered selection
  const input = transport.calls.find((call) => call.stage === "conclusion").body.input;
  for (const line of [`- [q1] ${Q1}`, `- [q2] ${Q2}`,
    `- ${Q2}：看点：效果处理时可选的调整；选卡时放的对照候选：满足条件的「方程式同调士」「测试同调调整甲」，不满足条件的「测试同调调整乙」`,
    `[o3] ${Q2}：${SELECTION_OBSERVATION}`]) assert.ok(input.includes(line), line);
  assert.deepEqual(record.conclusion.perQuestion.map((item) => [item.id, item.verdict, item.used.map((used) => used.id)]),
    [["q1", "observed", ["o1", "o2"]], ["q2", "observed", ["o3"]]]);
  // two engine runs (one per sub-question), select_probes never sent; one card-data request for the selection's cards
  assert.equal(calls.filter((call) => call.op === "reproduce").length, 2);
  assert.ok(calls.filter((call) => call.op === "reproduce").every((call) => !JSON.stringify(call.body).includes("select_probes")));
  assert.deepEqual(calls.filter((call) => call.op === "cards").at(-1).body, { codes: [FORMULA, TUNER4, TUNER6].sort((a, b) => a - b) });
});

test("golden (棱镜, as on the live site): no selection was recorded, so the Level question says which observation is missing", async () => {
  const notObservable = "引擎记录里看不出：缺少效果处理时可选调整的观察（这次没有记录选卡时可选的卡）。";
  const { record, text } = await reproducePrism({ q2Branch: { observe: "效果处理后的场面", result_cards: [{ card: FORMULA, controller: 0 }] },
    conclusion: perQuestion([SENTENCE_Q1, ["o1", "o2"]], [notObservable, [], "not_observable"]) });
  assert.deepEqual(text.split("\n\n").slice(1, 3), [
    ["结论：", `- ${Q1}：${SENTENCE_Q1}`, `- ${Q2}：${notObservable}`].join("\n"),
    ["依据的引擎观察值：", `- ${Q1}：${FORMULA_OBSERVATION}`, `- ${Q1}：${PRISM_OBSERVATION}`].join("\n"),
  ]);
  assert.equal(engineReproDigest(record).observations.length, 3, "the second sub-question's own field observation exists, unused");
  assert.doesNotMatch(text, /引擎没有给出/u);
});

test("a single sub-question the engine record cannot answer: the sentence says what is missing; the observations are still listed", async () => {
  const missing = "引擎记录里看不出：缺少效果处理时可选调整的观察。";
  const { record, text } = await reproduce({ question: ATTRIBUTE_QUESTION, planOutput: attributePlan, engineResult: attributeEngineResult,
    identity: identityOf(1, 2), conclusion: perQuestion([missing, [], "not_observable"]) });
  assert.deepEqual([record.conclusion.status, record.conclusion.perQuestion[0].verdict, record.conclusion.used], ["done", "not_observable", []]);
  assert.deepEqual(text.split("\n\n").slice(0, 3), [
    "【ygopro 引擎复现（实验性）】已复现",
    `结论：${missing}`,
    [CONCISE_RESULTS_LEAD, `- 测试怪兽B 现在的属性——${ATTRIBUTE_OBSERVATION}`].join("\n"),
  ]);
});
