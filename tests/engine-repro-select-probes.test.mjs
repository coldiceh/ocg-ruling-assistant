import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuestion, branchOutcome, renderQuestion } from "../backend/engineRepro/aggregate.mjs";
import { engineReproConciseText, engineReproDigest } from "../backend/engineRepro/concise.mjs";
import { PLANNER_INSTRUCTIONS, buildRepairInput } from "../backend/engineRepro/plannerPrompt.mjs";
import { runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { checkSelectProbes, evaluateSelectProbes, normalizeSelectProbes, selectProbeCodes } from "../backend/engineRepro/selectProbes.mjs";

// Selection check points (plan select_probes, 2026-11-08). Synthetic cards (passcode -> engine name); no real card or
// question is special-cased anywhere.
const SPELL = 9400001, LOW = 9400002, MID = 9400003, HIGH = 9400004, OTHER = 9400005;
const NAMES = new Map([[SPELL, "测试检索魔法"], [LOW, "测试调整二星"], [MID, "测试调整四星"], [HIGH, "测试调整六星"], [OTHER, "测试怪兽"]]);
const FACTS = new Map([
  [LOW, { types: ["怪兽", "效果", "调整"], level: 2, atk: 500, def: 300, attribute: "光", race: "机械" }],
  [MID, { types: ["怪兽", "效果", "调整"], level: 4, atk: 1500, def: 1000, attribute: "光", race: "机械" }],
  [HIGH, { types: ["怪兽", "效果", "调整"], level: 6, atk: 2200, def: 1400, attribute: "光", race: "机械" }],
]);
const FORBIDDEN = /回放|日志|行动选择|窗口|决策|探测|分支|setup|\[\d\]/u;

// The plan: activate the spell, choose one tuner from the deck while it resolves. The question asks whether the
// spell's Level limit is checked, so the deck holds tuners on both sides of the limit.
const setup = [
  { player: 0, decision: "idle", choose: { cmd: "activate", card: SPELL, from: "hand" } },
  { player: 0, decision: "select_place", choose: { place: { player: 0, zone: "szone", seq: 0 } } },
  { player: 0, decision: "select_card", choose: { cards: [{ card: LOW, from: "deck" }] } },
];
const scenario = () => ({ first_player: 0, players: [{ hand: [SPELL], deck: [LOW, MID, HIGH, 13179332, 756652] }, {}] });
const contrast = (sides = ["meets", "meets", "fails"]) => [{ after: 2, player: 0, candidates: [
  { card: LOW, from: "deck", side: sides[0] }, { card: MID, from: "deck", side: sides[1] }, { card: HIGH, from: "deck", side: sides[2] }]
  .filter((item) => item.side) }];
const planWith = (selectProbes, extra = {}) => ({ applicability: "applicable", reason_code: null, archetype_name: null,
  quoted_span: "检测等级吗", what_not_why: false,
  assumptions: ["卡组放测试调整二星、四星：不超过上限4，代表满足一侧", "卡组放测试调整六星：超过上限4，代表不满足一侧"],
  extra_cards: [{ code: LOW, name: "测试调整二星" }, { code: MID, name: "测试调整四星" }, { code: HIGH, name: "测试调整六星" }],
  sub_questions: [{ id: "q1", quoted_span: "检测等级吗", unrepresentable: null, branches: [{ id: "b1", assumption: null,
    observe: "检索时可选的调整", scenario: scenario(), actions: { setup }, ...(selectProbes ? { select_probes: selectProbes } : {}), ...extra }] }] });

// Test-only: a select probe whose candidates do not cover both sides of the question's condition. Production never
// checks this (the planner prompt asks for both sides; there is no gate), so only the fixture flags it.
function selectProbesMissingASide(plan) {
  const flagged = [];
  for (const sq of plan.sub_questions || []) {
    for (const branch of sq.branches || []) {
      (branch.select_probes || []).forEach((probe, index) => {
        const sides = new Set((probe.candidates || []).map((item) => item.side));
        const missing = ["meets", "fails"].filter((side) => !sides.has(side));
        if (missing.length) flagged.push({ branch: `${sq.id}/${branch.id}`, probe: index, missing });
      });
    }
  }
  return flagged;
}

const decision = (index, kind, extra = {}) => ({ index, kind, player: 0, phase: "main1", turn: 1, turn_player: 0, timing: null,
  chain_links: 0, in_activation: false, in_resolution: false, after_chain_end: false, options: [], ...extra });
const offered = (...codes) => codes.map((card, id) => ({ id, cmd: "card", card, name: NAMES.get(card), controller: 0, from: "deck", seq: id }));
const SELECTION = (options = offered(LOW, MID)) => decision(3, "select_card", { in_resolution: true, min: 1, max: 1,
  hint: { player: 0, hint_type: 3, id: 509, text: "请选择要加入手卡的卡" }, options });
// A completed replay: the three setup steps, then our main phase (where the engine stops).
function replayed({ selection = SELECTION(), log = [], decisions = null } = {}) {
  return { status: "replayed", reason_code: null, failure: null, probes: [], setup_consumed: 3,
    decisions: decisions || [
      { by: "setup", step: 0, choice: 0, log_pos: 0, decision: decision(1, "idle") },
      { by: "setup", step: 1, choice: 0, log_pos: 0, decision: decision(2, "select_place") },
      { by: "setup", step: 2, choice: [0], log_pos: log.length, decision: selection },
      { by: "end", choice: null, log_pos: log.length, decision: decision(4, "idle") },
    ],
    log, state: { players: { 0: { lp: 8000, mzone: [], szone: [], hand: [{ card: LOW, name: "测试调整二星", seq: 0 }] }, 1: { lp: 8000 } } },
    rendered_zh: "【引擎复现】\n状态：已按步骤回放完成" };
}

function engineFor(result, calls = []) {
  return async (op, body) => {
    calls.push({ op, body });
    if (op === "cards") {
      return { cards: (body.codes || []).map((code) => ({ code, exists: true, name: NAMES.get(code) || `工具卡${code}`,
        types: ["怪兽"], text: "t", ...(FACTS.get(code) || {}) })) };
    }
    if (op === "related") return { related: [] };
    if (op === "reproduce") return { result: { ...result(body), scenario: body.scenario } };
    throw new Error(`unexpected engine op ${op}`);
  };
}

async function run(plans, result, calls = []) {
  const outputs = (Array.isArray(plans) ? plans : [plans]).map((plan) => (typeof plan === "string" ? plan : JSON.stringify(plan)));
  const inputs = [];
  const record = await runEngineReproduction({ question: "「测试检索魔法」检测调整的等级吗？",
    identity: { resolved: [{ cid: "1", mentionedAs: ["测试检索魔法"], resolutionSources: [] }], unresolved: [], groupMentions: [] },
    cardsById: new Map([["1", { id: "1", name: "测试检索魔法", effectText: "从卡组把1只4星以下的调整加入手卡。" }]]),
    cidMap: { 1: SPELL }, engine: engineFor(result, calls), clock: () => 0,
    modelCall: async ({ input }) => { inputs.push(input); return { status: "completed", outputText: outputs[Math.min(inputs.length, outputs.length) - 1], usage: {} }; } });
  return { record, inputs, calls };
}

test("planner prompt: contrast candidates on both sides, a selection check point, each candidate's side in assumptions", () => {
  for (const rule of ["## 对照候选与无关角色", "至少一张满足条件、一张不满足", "例如等级在上限以内和超出上限的调整各一张",
    "并在这一分支写 select_probes 记录那次选卡", "候选卡由你自选", "在 assumptions 里逐张写明：哪张卡、放在哪里、为什么代表满足 / 不满足的一侧",
    "branches[].select_probes：题目问“能不能选到 X / 检测不检测某条件 / 选择范围是否受限”时用", "不要写进 actions.probes（引擎的探测不认选卡）",
    "side 是它按题目里的条件属于哪一侧（meets 满足、fails 不满足；这是对候选的说明，不是预测结果）",
    "问能选到哪些卡（选择范围、是否检测某条件）时例外：那次选卡照常写成步骤，可选的卡由 select_probes 记录"]) {
    assert.ok(PLANNER_INSTRUCTIONS.includes(rule), rule);
  }
  assert.match(PLANNER_INSTRUCTIONS, /"result_cards":\[\],"select_probes":\[\]/u, "the output example carries the field");
  // the planner may still answer the other "can it choose" questions with engine probes
  assert.match(PLANNER_INSTRUCTIONS, /题目问的动作（能不能发动 \/ 攻击 \/ 选择，还能做几次）用探测观察，不要写成步骤/u);
  // a repaired branch whose step numbers moved restates its select_probes
  const repair = buildRepairInput({ plannerInput: "x", previousPlan: {}, failures: [{ sub_question: "q1", branch: "b1" }] });
  assert.match(repair, /分支有 select_probes 而改动后它指向的选卡步骤序号变了，就把改好的 select_probes 一起写出/u);
});

test("planner prompt: a card the question names keeps its own role; unrelated roles use filler cards, written into assumptions", () => {
  for (const rule of ["题目里点名的卡只充当题目给它的角色", "题目没指定的素材、解放或舍弃用的卡、被选的对象、凑数的怪兽等无关角色",
    "不要拿题目里出现的卡顶替", "为此选了哪张卡、充当什么，写进 assumptions",
    "但充当素材、对象、对照候选等角色的卡要写（见“对照候选与无关角色”）"]) {
    assert.ok(PLANNER_INSTRUCTIONS.includes(rule), rule);
  }
  assert.doesNotMatch(PLANNER_INSTRUCTIONS, /填充卡、卡组内容这类不影响结果的布置不用写/u, "the old blanket exemption is narrowed");
  // general rules only: no card of any reported question is named in the prompt
  assert.doesNotMatch(PLANNER_INSTRUCTIONS, /幽鬼兔|玻璃光纤|继承玻纤|棱镜|棱彩|方程式同/u);
});

test("a plan with contrast candidates and a selection check point passes the plan check; the engine never sees select_probes", async () => {
  const plan = planWith(contrast());
  assert.deepEqual(selectProbesMissingASide(plan), [], "the fixture sees both sides");
  const { record, calls } = await run(plan, () => replayed());
  const branch = record.subQuestions[0].branches[0];
  assert.equal(branch.planProblems, null);
  assert.equal(record.summary.status, "已复现");
  assert.deepEqual(branch.selectProbes, normalizeSelectProbes(contrast()));
  // the engine got the plan's actions as before (schema, setup, probes), never the selection check point
  const reproduce = calls.filter((call) => call.op === "reproduce");
  assert.equal(reproduce.length, 1);
  assert.deepEqual(Object.keys(reproduce[0].body.actions).sort(), ["probes", "schema", "setup"]);
  assert.doesNotMatch(JSON.stringify(reproduce[0].body), /select_probes|candidates|"side"/u);
  // one card-data request for the cards the selection names
  const cardData = calls.filter((call) => call.op === "cards").at(-1);
  assert.deepEqual(cardData.body, { codes: [LOW, MID, HIGH] });
  const [result] = branch.selectProbeResults;
  assert.equal(result.status, "observed");
  assert.deepEqual(result.selectable.map((card) => card.card), [LOW, MID]);
  assert.deepEqual(result.candidates.map((card) => [card.card, card.side, card.result]),
    [[LOW, "meets", "selectable"], [MID, "meets", "selectable"], [HIGH, "fails", "not_selectable"]]);
  assert.deepEqual(result.decision, { index: 3, kind: "select_card", player: 0, phase: "main1", turn_player: 0, at: null,
    hint: "请选择要加入手卡的卡", chain_links: 0, min: 1, max: 1, in_activation: false, in_resolution: true, after_chain_end: false });
  // the observation, numbered with the rest
  const digest = engineReproDigest(record);
  assert.deepEqual(digest.observations.map((item) => [item.id, item.text]), [["o1",
    "我方在主要阶段1（连锁 1 处理中）选择卡（提示「请选择要加入手卡的卡」）时，可选：卡组的「测试调整二星」（效果·调整 2星 光/机械 500/300）、"
    + "卡组的「测试调整四星」（效果·调整 4星 光/机械 1500/1000）；不可选：卡组的「测试调整六星」（效果·调整 6星 光/机械 2200/1400）（括号里是卡片的原本数据）"]]);
  assert.doesNotMatch(engineReproConciseText(digest), FORBIDDEN);
});

test("a plan missing one side is flagged by the test fixture only; production runs it without any problem", async () => {
  const plan = planWith(contrast(["meets", "meets", null]));
  assert.deepEqual(selectProbesMissingASide(plan), [{ branch: "q1/b1", probe: 0, missing: ["fails"] }]);
  const { record, inputs } = await run(plan, () => replayed());
  const branch = record.subQuestions[0].branches[0];
  assert.equal(branch.planProblems, null, "no gate on the sides");
  assert.equal(record.planProblems.length, 0);
  assert.equal(inputs.length, 1, "no repair round");
  assert.deepEqual(branch.selectProbeResults[0].candidates.map((card) => card.result), ["selectable", "selectable"]);
  assert.match(engineReproDigest(record).observations[0].text, /；计划放的对照候选都可以选/u);
});

test("plan check: a selection check point points at a card selection of the same player, with allowed cards and a side", async () => {
  const allowed = new Set([LOW, MID, HIGH]);
  assert.deepEqual(checkSelectProbes(undefined, setup, allowed), []);
  assert.deepEqual(checkSelectProbes(contrast(), setup, allowed), []);
  assert.deepEqual(checkSelectProbes({}, setup, allowed), ["select_probes 应为最多 3 项的数组"]);
  const problems = (probe) => checkSelectProbes([probe], setup, allowed);
  assert.deepEqual(problems({ after: 0, player: 0, candidates: [{ card: LOW, from: "deck", side: "meets" }] }),
    ["select_probes[0].after=0：setup 第 1 步是 idle，不是选卡步骤（select_card / select_unselect / select_sum / select_tribute）"]);
  assert.deepEqual(problems({ after: 3, player: 0, candidates: [{ card: LOW, from: "deck", side: "meets" }] }),
    ["select_probes[0].after 应为 0 到 2 的整数：回答这次选卡的那一步（setup 第 after+1 步）必须写在 setup 里"]);
  assert.deepEqual(problems({ after: 2, player: 1, candidates: [{ card: LOW, from: "deck", side: "meets" }] }),
    ["select_probes[0].player=1 与 setup 第 3 步的玩家 0 不一致"]);
  assert.deepEqual(problems({ after: 2, player: 0, candidates: [] }), ["select_probes[0].candidates 应为 1–8 项的数组"]);
  assert.deepEqual(problems({ after: 2, player: 0, candidates: [{ card: OTHER, from: "pile", controller: 2, side: "maybe" }] }), [
    `select_probes[0].candidates[0] 的卡号 ${OTHER} 不在允许的卡号列表中`,
    "select_probes[0].candidates[0].from 取值无效（hand, deck, grave, removed, extra, mzone, szone, fzone, pzone, overlay）",
    "select_probes[0].candidates[0].controller 只能是 0 或 1",
    "select_probes[0].candidates[0].side 只能是 \"meets\" 或 \"fails\"",
  ]);
  // in the pipeline: the branch is not run, the problem reaches the repair round, which may fix it
  const bad = planWith([{ after: 0, player: 0, candidates: [{ card: LOW, from: "deck", side: "meets" }, { card: HIGH, from: "deck", side: "fails" }] }]);
  const repaired = { extra_cards: [], sub_questions: [{ id: "q1", branches: [{ id: "b1", scenario: scenario(), actions: { setup },
    select_probes: contrast() }] }] };
  const { record, inputs, calls } = await run([bad, repaired], () => replayed());
  assert.equal(inputs.length, 2);
  assert.match(inputs[1], /select_probes\[0\]\.after=0：setup 第 1 步是 idle，不是选卡步骤/u);
  const branch = record.subQuestions[0].branches[0];
  assert.deepEqual([branch.repaired, branch.planProblems, record.summary.status], [true, null, "已复现"]);
  assert.equal(calls.filter((call) => call.op === "reproduce").length, 1, "only the repaired branch ran");
  assert.equal(branch.selectProbeResults[0].status, "observed");
});

test("repair: a branch that does not restate its select_probes keeps them, checked against the repaired setup", async () => {
  const failing = () => ({ status: "not_reproduced", reason_code: "action_mismatch", probes: [], decisions: [], log: [],
    failure: { reason: "not_found", step: 1, step_spec: setup[1], decision: decision(2, "select_card", { options: [] }) } });
  let runs = 0;
  const result = (body) => { runs += 1; return runs === 1 ? failing() : replayed(); };
  // the repaired setup inserts a step before the selection: the kept check point now points at the place step
  const shifted = [setup[0], { player: 0, decision: "select_option", choose: { option: 1 } }, ...setup.slice(1)];
  const repair = { extra_cards: [], sub_questions: [{ id: "q1", branches: [{ id: "b1", scenario: scenario(), actions: { setup: shifted } }] }] };
  const { record } = await run([planWith(contrast()), repair], result);
  const branch = record.subQuestions[0].branches[0];
  assert.deepEqual(branch.selectProbes, normalizeSelectProbes(contrast()), "kept");
  assert.deepEqual(branch.planProblems,
    ["select_probes[0].after=2：setup 第 3 步是 select_place，不是选卡步骤（select_card / select_unselect / select_sum / select_tribute）"]);
  assert.equal(runs, 1, "the branch with the stale check point did not run again");
  assert.equal(branch.selectProbeResults, undefined);
  // restating it with the new step number runs it
  runs = 0;
  const restated = { extra_cards: [], sub_questions: [{ id: "q1", branches: [{ id: "b1", scenario: scenario(), actions: { setup: shifted },
    select_probes: [{ ...contrast()[0], after: 3 }] }] }] };
  const again = await run([planWith(contrast()), restated], (body) => {
    runs += 1;
    if (runs === 1) return failing();
    const decisions = replayed().decisions;
    decisions.splice(1, 0, { by: "setup", step: 1, choice: 0, log_pos: 0, decision: decision(5, "select_option") });
    decisions[2].step = 2;
    decisions[3].step = 3;
    return replayed({ decisions });
  });
  const fixedBranch = again.record.subQuestions[0].branches[0];
  assert.equal(fixedBranch.planProblems, null);
  assert.equal(fixedBranch.selectProbes[0].after, 3);
  assert.equal(fixedBranch.selectProbeResults[0].status, "observed");
});

test("evaluation: offered cards; a candidate in its zone but not offered; moved away first; never placed; unknown presence", () => {
  const probes = normalizeSelectProbes([{ after: 2, player: 0, candidates: [
    { card: LOW, from: "deck", side: "meets" }, { card: HIGH, from: "deck", side: "fails" }, { card: MID, from: "deck", side: "meets" },
    { card: OTHER, from: "grave", side: "fails" }, { card: SPELL, from: "removed", controller: 1, side: "fails" }] }]);
  // MID left the deck (sent to the graveyard) before the selection; a later move does not count
  const log = [
    { type: "move", card: MID, from: { player: 0, location: "deck", seq: 1 }, to: { player: 0, location: "grave", seq: 0 }, reason: ["effect"] },
    { type: "chaining", card: SPELL },
  ];
  const engine = replayed({ selection: SELECTION(offered(LOW)), log: [...log,
    { type: "move", card: HIGH, from: { player: 0, location: "deck", seq: 2 }, to: { player: 0, location: "hand", seq: 1 }, reason: ["effect"] }] });
  engine.decisions[2].log_pos = 2;
  const branch = { selectProbes: probes, engine, scenario: { players: [{ hand: [SPELL], deck: [LOW, MID, HIGH] }, { removed: [] }] } };
  assert.deepEqual(selectProbeCodes([branch]), [SPELL, LOW, MID, HIGH, OTHER].sort((a, b) => a - b));
  const [result] = evaluateSelectProbes(branch, { facts: new Map() });
  assert.deepEqual(result.candidates.map((card) => [card.card, card.result]),
    [[LOW, "selectable"], [HIGH, "not_selectable"], [MID, "left_zone"], [OTHER, "not_placed"], [SPELL, "not_placed"]]);
  // without the engine's log the presence of a candidate that was not offered cannot be told
  const [unknown] = evaluateSelectProbes({ ...branch, engine: { ...engine, log: undefined } }, { facts: new Map() });
  assert.deepEqual(unknown.candidates.map((card) => card.result).slice(0, 3), ["selectable", "presence_unknown", "presence_unknown"]);
  // a draw takes the card out of the deck too (MSG_DRAW marks a face-up draw with 0x80000000)
  const drawn = replayed({ selection: SELECTION(offered(LOW)), log: [{ type: "draw", player: 0, cards: [{ card: HIGH + 0x80000000 }] }] });
  const [afterDraw] = evaluateSelectProbes({ ...branch, engine: drawn }, { facts: new Map() });
  assert.equal(afterDraw.candidates[1].result, "left_zone");
  // the selection was never answered (the replay stopped earlier) / the step answered something else / no options
  const [notReached] = evaluateSelectProbes({ ...branch, engine: { decisions: engine.decisions.slice(0, 2) } });
  assert.equal(notReached.status, "not_reached");
  const other = replayed();
  other.decisions[2].decision = decision(3, "select_position");
  assert.equal(evaluateSelectProbes({ ...branch, engine: other })[0].status, "not_card_selection");
  const bare = replayed();
  delete bare.decisions[2].decision.options;
  assert.equal(evaluateSelectProbes({ ...branch, engine: bare })[0].status, "no_options");
});

test("evaluation: a one-card-per-prompt selection reads its first prompt; already chosen cards are not offered", () => {
  const first = decision(3, "select_unselect", { in_resolution: true, options: [
    ...offered(LOW, MID), { id: 2, cmd: "card", card: HIGH, name: "测试调整六星", controller: 0, from: "deck", seq: 2, selected: true }] });
  const second = decision(4, "select_unselect", { in_resolution: true, options: offered(MID) });
  const engine = replayed({ decisions: [
    { by: "setup", step: 0, log_pos: 0, decision: decision(1, "idle") },
    { by: "setup", step: 1, log_pos: 0, decision: decision(2, "select_place") },
    { by: "setup", step: 2, log_pos: 0, decision: first, note: "逐张选卡 1/2" },
    { by: "setup", step: 2, log_pos: 0, decision: second, note: "逐张选卡 2/2" },
    { by: "end", log_pos: 0, decision: decision(5, "idle") }] });
  const [result] = evaluateSelectProbes({ selectProbes: normalizeSelectProbes(contrast()), engine, scenario: scenario() });
  assert.deepEqual(result.selectable.map((card) => card.card), [LOW, MID]);
  assert.equal(result.decision.index, 3);
});

test("short section: the selection in players' words; an opponent's zone is named; unknown data and presence are said so", () => {
  const record = (selectProbeResults) => {
    const value = { cards: [{ code: SPELL, engineName: "测试检索魔法" }],
      plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
      subQuestions: [{ id: "q1", quoted_span: "检测等级吗", unrepresentable: null, branches: [{ id: "b1", assumption: null,
        scenario: { ...scenario(), schema: "ocg-repro-scenario/v1" }, actions: { setup }, selectProbes: normalizeSelectProbes(contrast()),
        selectProbeResults, engine: replayed() }] }] };
    value.summary = aggregateQuestion(value);
    value.rendered = renderQuestion(value, value.summary);
    return value;
  };
  const base = { after: 2, player: 0, status: "observed", decision: { index: 3, kind: "select_card", player: 0, phase: "main1", turn_player: 1,
    at: "damage_step_start", hint: null, chain_links: 1, in_activation: false, in_resolution: false } };
  const text = engineReproDigest(record([{ ...base, factsUnavailable: true,
    selectable: [{ card: OTHER, name: "测试怪兽", controller: 1, from: "grave", facts: null }],
    candidates: [{ card: HIGH, name: "测试调整六星", from: "deck", controller: 0, side: "fails", result: "presence_unknown", facts: null },
      { card: MID, name: "测试调整四星", from: "deck", controller: 0, side: "meets", result: "left_zone", facts: null },
      { card: LOW, name: "测试调整二星", from: "hand", controller: 1, side: "meets", result: "not_placed", facts: null }] }])).observations[0].text;
  assert.equal(text, "我方在对方回合的伤害步骤开始时（连锁 1 处理前）选择卡时，可选：对方墓地的「测试怪兽」；「测试调整四星」在这次选卡前已经离开卡组，不在可选之列；"
    + "计划没有把「测试调整二星」放进对方手卡；「测试调整六星」不在可选之列，但当时是否在卡组未取得（卡片数据未取得）");
  assert.doesNotMatch(text, FORBIDDEN);
  const many = Array.from({ length: 10 }, (_, i) => ({ card: 9500000 + i, name: `卡${i}`, controller: 0, from: "deck", facts: null }));
  assert.match(engineReproDigest(record([{ ...base, selectable: many, candidates: [] }])).observations[0].text,
    /可选：卡组的「卡0」、.*卡组的「卡7」等 10 张$/u);
  // not reached / older engine record without the offered cards: listed, but not a result
  const [notReached] = engineReproDigest(record([{ after: 2, player: 0, status: "not_reached", decision: null, selectable: [], candidates: [] }])).observations;
  assert.deepEqual([notReached.text, notReached.empty], ["我方要看的那次选卡没有出现在引擎的记录里，看不出能选哪些卡", true]);
  const [bare] = engineReproDigest(record([{ ...base, status: "no_options", selectable: [], candidates: [] }])).observations;
  assert.deepEqual([bare.text, bare.empty], ["我方在对方回合的伤害步骤开始时（连锁 1 处理前）选择卡时，引擎没有返回可选的卡（未取得）", true]);
});

test("a selection seen before a required choice was left pending: 部分复现 with the selection's observation and the reason", async () => {
  const pending = () => {
    const result = replayed();
    result.decisions[3] = { by: "end", choice: null, log_pos: 0, decision: decision(4, "select_position", { in_resolution: true }) };
    return result;
  };
  const { record } = await run([planWith(contrast()), { extra_cards: [], sub_questions: [] }], pending);
  const branch = record.subQuestions[0].branches[0];
  assert.deepEqual(branchOutcome(branch), { ok: false, reason: "action_mismatch", observed: true });
  assert.equal(record.summary.status, "部分复现");
  const text = engineReproConciseText(engineReproDigest(record));
  assert.match(text, /可选：卡组的「测试调整二星」/u);
  assert.match(text, /没能复现的部分：计划中的操作已经用完，但我方仍需选择表示形式，相关处理尚未完成。/u);
  // without the selection check point the same replay reads 未复现, as before
  const { record: plain } = await run([planWith(null), { extra_cards: [], sub_questions: [] }], pending);
  assert.equal(plain.summary.status, "未复现");
});

test("a branch with a selection check point and result cards reports both; without result cards no field list is added", async () => {
  const both = await run(planWith(contrast(), { result_cards: [{ card: LOW, controller: 0 }] }), () => replayed());
  const [selection, card] = engineReproDigest(both.record).observations.map((item) => item.text);
  assert.match(selection, /^我方在主要阶段1（连锁 1 处理中）选择卡/u);
  assert.match(card, /^到我方主要阶段1时，我方的「测试调整二星」在手卡/u);
  const only = await run(planWith(contrast()), () => replayed());
  assert.equal(engineReproDigest(only.record).observations.length, 1);
});
