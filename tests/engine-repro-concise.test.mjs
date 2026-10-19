import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuestion, renderQuestion } from "../backend/engineRepro/aggregate.mjs";
import { ADMISSION_LIMIT_LINES, CONCISE_DISCLAIMER, engineReproConciseText, engineReproDigest, officialQaExactLine,
  REASON_PLAIN } from "../backend/engineRepro/concise.mjs";
import { appendEngineReproSection, engineReproSectionText } from "../backend/engineRepro/session.mjs";
import { finalizePreparedRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

// Synthetic cards (passcode -> engine name). 1184620 is one of the planner's filler cards.
const SPELL = 9000001, MONSTER_A = 9000002, MONSTER_B = 9000003, FUSION = 9000004, HAND_TRAP = 9000005, FILLER = 1184620;
const cards = [[SPELL, "测试融合魔法"], [MONSTER_A, "测试怪兽A"], [MONSTER_B, "测试怪兽B"], [FUSION, "测试融合怪兽"],
  [HAND_TRAP, "测试手坑"]].map(([code, engineName], i) => ({ code, cid: String(i + 1), engineName, mentionedAs: [engineName] }));

const board = () => ({ schema: "ocg-repro-scenario/v1", seed: 2026, first_player: 0, players: [
  { lp: 8000, draw_count: 0, hand: [SPELL, FILLER], extra: [FUSION], deck: [FILLER, FILLER, FILLER, FILLER, FILLER] },
  { lp: 8000, draw_count: 0, hand: [HAND_TRAP], deck: [FILLER, FILLER, FILLER, FILLER, FILLER],
    mzone: [{ seq: 0, code: MONSTER_A, position: "faceup_attack" }, { seq: 1, code: MONSTER_B, position: "facedown_defense" }] },
] });

// The engine's own Chinese replay carries the debugging detail the short section must leave out.
const DEBUG_REPLAY = ["【引擎复现】", "状态：已按步骤回放完成", "版本：核心 abc1234 · 脚本 def5678 · 卡库 0123456 · Lua 5.4",
  "  · 此时 P1 本可发动：测试手坑（未发动）", "  （另有 3 个响应窗口无可发动效果，已跳过）", "结束时基本分：P0 8000，P1 8000",
  "  窗口（决策#4，主要阶段1，连锁/发动窗口）：无可发动效果【不含目标】"].join("\n");

// A judge EXACT match: a 未复现 / 不适用 / admission-limit section still shows no official-Q&A line.
const EXACT_MATCH = [{ id: "qa-1", title: "测试官方问答" }];

const decision = (index, kind, player, options = [], turnPlayer = 0) => ({ index, kind, player, phase: "main1", turn: 1,
  turn_player: turnPlayer, passable: kind === "chain", options });
const window = (d, containsTarget) => ({ decision: d.index, kind: d.kind, phase: d.phase, hint: null, options: d.options,
  contains_target: containsTarget });

function replayed(probes, decisions) {
  return { status: "replayed", reason_code: null, failure: null, probes,
    decisions: decisions.map((d) => ({ decision: d, by: "pass", choice: "pass", log_pos: 0 })),
    log: [{ type: "chaining", card: MONSTER_B, name: "测试怪兽B", player: 1, link: 1, desc: 0 }],
    state: { players: { 0: { lp: 8000 }, 1: { lp: 8000 } } }, rendered_zh: DEBUG_REPLAY };
}

function finished(record) {
  record.summary = aggregateQuestion(record);
  record.rendered = renderQuestion(record, record.summary);
  return record;
}

const FORBIDDEN = [/本可发动/u, /决策#/u, /版本：/u, /基本分/u, /个响应窗口/u, /\bLP\b/u, /\[\d\]/u, /卡组：?\s*\d+\s*张/u, /先攻/u];
function assertConcise(text) {
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
  for (const line of text.split("\n\n")) assert.doesNotMatch(line, /\n/u, "one sentence per Markdown paragraph");
}

test("已复现: two sub-questions, one core auto-activation; board, assumptions, no debugging detail", () => {
  const idle = decision(3, "idle", 0, [{ id: 0, cmd: "activate", card: SPELL, name: "测试融合魔法", controller: 0, from: "hand" }]);
  const chain = decision(5, "chain", 1, []);
  const record = finished({
    cards,
    plan: { applicability: "applicable", assumptions: ["双方无其他适用效果", "我方有填充卡可供舍弃。"], extra_cards: [] },
    subQuestions: [
      { id: "q1", quoted_span: "能发动吗", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
        engine: replayed([{ index: 0, after: 0, player: 0, decision_kind: "idle", target: { card: SPELL }, result: "present",
          windows: [window(idle, true)], ambiguous: false }], [idle]) }] },
      { id: "q2", quoted_span: "会怎样", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
        engine: replayed([
          { index: 0, after: 1, player: 1, decision_kind: "chain", target: { card: MONSTER_B }, result: "present_auto",
            windows: [], ambiguous: false, auto_desc: 0, card_level_only: true },
          { index: 1, after: 1, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "absent",
            windows: [window(chain, false)], ambiguous: false },
        ], [chain]) }] },
    ],
  });
  assert.equal(record.summary.status, "已复现");
  assert.match(record.rendered, /本可发动/u, "the full replay keeps the debugging detail");
  const text = engineReproConciseText(engineReproDigest(record));
  assert.deepEqual(text.split("\n\n"), [
    "【ygopro 引擎复现（实验性）】已复现",
    "ygopro（MyCard 版核心）在下面的局面里：",
    "子问题 1：我方在主要阶段1可以选择「发动测试融合魔法」。",
    "子问题 2：「测试怪兽B」作为必发效果由引擎自动发动（只能确认到卡，不能确认是哪个效果）；对方在我方主要阶段1没有出现「测试手坑」的发动机会。",
    "局面：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
    "假设：双方无其他适用效果；我方有填充卡可供舍弃。",
    CONCISE_DISCLAIMER,
  ]);
  assertConcise(text);
});

test("对照分支: one line per assumption; differing boards are labelled the same way", () => {
  const chain = decision(5, "chain", 1, [{ id: 0, cmd: "chain", card: HAND_TRAP, name: "测试手坑", controller: 1, from: "hand" }]);
  const without = board();
  without.players[1].hand = [];
  const record = finished({
    cards,
    plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [
      { id: "b1", assumption: "对方手卡有测试手坑", scenario: board(), engine: replayed([{ index: 0, after: 1, player: 1,
        decision_kind: "chain", target: { card: HAND_TRAP }, result: "present", windows: [window(chain, true)] }], [chain]) },
      { id: "b2", assumption: null, scenario: without, engine: replayed([], []) },
    ] }],
  });
  const lines = engineReproConciseText(engineReproDigest(record),
    { officialQaMatches: [{ id: "qa-1", title: "测试手坑能否在对方回合发动？" }] }).split("\n\n");
  assert.deepEqual(lines, [
    "【ygopro 引擎复现（实验性）】已复现",
    "ygopro（MyCard 版核心）在下面的局面里：",
    "假设「对方手卡有测试手坑」：对方在我方主要阶段1可以选择「发动测试手坑」。",
    "无额外假设：引擎按计划走完了操作，这一问没有设置检查点（过程见完整回放）。",
    "局面（假设「对方手卡有测试手坑」）：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
    "局面（无额外假设）：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备）（另有填充卡）。",
    "判断模型认为官方 Q&A【测试手坑能否在对方回合发动？】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。",
    CONCISE_DISCLAIMER,
  ]);
});

test("部分复现: an unreached check point and an unrepresentable sub-question; more than three assumptions end in 等", () => {
  const idle = decision(3, "idle", 0, [{ id: 0, cmd: "activate", card: SPELL, name: "测试融合魔法", controller: 0, from: "hand", desc: 0 }]);
  const record = finished({
    cards,
    plan: { applicability: "applicable", assumptions: ["甲", "乙", "丙", "丁"], extra_cards: [] },
    subQuestions: [
      { id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
        engine: replayed([{ index: 0, after: 0, player: 0, decision_kind: "idle", target: { card: SPELL, desc: 1 },
          result: "present", windows: [window(idle, true)], card_level_only: true }], [idle]) }] },
      { id: "q2", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
        engine: { status: "not_reproduced", reason_code: "action_mismatch", failure: { reason: "probe_not_reached", probes: [0] },
          probes: [{ index: 0, after: 2, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "not_reached", windows: [] }],
          decisions: [], log: [], rendered_zh: DEBUG_REPLAY } }] },
      { id: "q3", unrepresentable: "本回合已通常召唤", branches: [] },
    ],
  });
  assert.equal(record.summary.status, "部分复现");
  const text = engineReproConciseText(engineReproDigest(record));
  assert.deepEqual(text.split("\n\n").slice(0, 6), [
    "【ygopro 引擎复现（实验性）】部分复现",
    "ygopro（MyCard 版核心）在下面的局面里：",
    "子问题 1：我方在主要阶段1可以选择「发动测试融合魔法」（只能确认到卡，不能确认是哪个效果）。",
    "子问题 2：没有到达要看的时点（对方的连锁/发动窗口）。",
    `子问题 3：${REASON_PLAIN.unrepresentable}。`,
    "局面：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
  ]);
  assert.match(text, /\n\n假设：甲；乙；丙等。\n\n/u);
  assertConcise(text);
});

test("未复现: only the first line and one plain reason, for every reason code", () => {
  const expected = {
    identity: "题目里的卡名没有解析出来",
    unrepresentable: "引擎搭不出题目描述的局面",
    action_mismatch: "引擎实际的操作流程和计划不一致，没能走到要看的时点",
    engine_error: "引擎运行出错",
    budget_exceeded: "超出引擎运行限制",
    invalid_input: REASON_PLAIN.invalid_input,
  };
  for (const [code, reason] of Object.entries(expected)) {
    const record = { cards, summary: { status: "未复现", reasonCodes: [code], flags: ["with_assumptions"] },
      plan: { applicability: "applicable", assumptions: ["不应出现的假设"] },
      subQuestions: [{ id: "q1", branches: [{ id: "b1", scenario: board(), engine: { status: "not_reproduced", reason_code: code,
        failure: { reason: "not_found", step: 0 }, rendered_zh: DEBUG_REPLAY } }] }] };
    const text = engineReproConciseText(engineReproDigest(record), { officialQaMatches: EXACT_MATCH });
    assert.equal(text, `【ygopro 引擎复现（实验性）】未复现\n\n原因：${reason}。`, code);
    assertConcise(text);
  }
  // the same through the mechanical aggregation: the only sub-question cannot be built
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", unrepresentable: "伤害步骤中", branches: [] }] });
  assert.equal(engineReproConciseText(engineReproDigest(record), { officialQaMatches: EXACT_MATCH }),
    "【ygopro 引擎复现（实验性）】未复现\n\n原因：引擎搭不出题目描述的局面。");
});

test("不适用: one plain sentence per planner reason; no steps, no assumptions, no Q&A line", () => {
  for (const code of ["pure_rule", "archetype_level", "tournament_policy", "ruleset_version"]) {
    const record = finished({ cards, plan: { applicability: "not_applicable", reason_code: code, archetype_name: null,
      assumptions: ["不应出现"], sub_questions: [] }, subQuestions: [] });
    assert.equal(record.summary.status, "不适用");
    const text = engineReproConciseText(engineReproDigest(record), { officialQaMatches: EXACT_MATCH });
    assert.equal(text, `【ygopro 引擎复现（实验性）】不适用\n\n原因：${REASON_PLAIN[code]}。`, code);
  }
  const noCard = finished({ preStatus: { status: "不适用", reason: "no_card_mentioned", detail: "没有抽取到卡名" } });
  assert.equal(engineReproConciseText(engineReproDigest(noCard)), "【ygopro 引擎复现（实验性）】不适用\n\n原因：题目没有点名具体的卡。");
});

test("the section names ygopro: header, lead line and disclaimer", () => {
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", branches: [{ id: "b1", scenario: board(), engine: replayed([], []) }] }] });
  const lines = engineReproConciseText(engineReproDigest(record)).split("\n\n");
  assert.equal(lines[0], "【ygopro 引擎复现（实验性）】已复现");
  assert.match(lines[1], /^ygopro（MyCard 版核心）在下面的局面里：/u);
  assert.equal(lines.at(-1), "ygopro 只显示它运行的结果，卡片脚本可能有 bug，不代表官方裁定。");
  assert.equal(CONCISE_DISCLAIMER, lines.at(-1));
  for (const status of ["未复现", "不适用"]) {
    const failed = { summary: { status, reasonCodes: ["engine_error"] } };
    assert.match(engineReproConciseText(engineReproDigest(failed)), /^【ygopro 引擎复现（实验性）】/u);
  }
});

test("official Q&A line: only for the judge's EXACT matches; wording, two titles at most, brackets, long titles", () => {
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", branches: [{ id: "b1", scenario: board(), engine: replayed([], []) }] }] });
  const digest = engineReproDigest(record);
  const lines = (matches) => engineReproConciseText(digest, { officialQaMatches: matches }).split("\n\n");
  assert.equal(officialQaExactLine([{ title: "题A" }]),
    "判断模型认为官方 Q&A【题A】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。");
  assert.equal(lines([{ title: "题A" }]).at(-2), officialQaExactLine([{ title: "题A" }]));
  assert.equal(lines([{ title: "题A" }]).at(-1), CONCISE_DISCLAIMER);
  assert.equal(officialQaExactLine([{ title: "题A" }, { title: "题B" }]),
    "判断模型认为官方 Q&A【题A】【题B】与本题条件一致，以这些官方 Q&A 为准；ygopro 的结果只作参考。");
  assert.equal(officialQaExactLine([{ title: "题A" }, { title: "题B" }, { title: "题C" }, { title: "题A" }]),
    "判断模型认为官方 Q&A【题A】【题B】等 3 条与本题条件一致，以这些官方 Q&A 为准；ygopro 的结果只作参考。");
  assert.equal(officialQaExactLine([{ title: "「卡」的【1】效果\n能否发动？" }]),
    "判断模型认为官方 Q&A【「卡」的［1］效果 能否发动？】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。");
  const long = officialQaExactLine([{ title: "长".repeat(200) }]);
  assert.ok(long.includes(`【${"长".repeat(120)}…】`));
  // no EXACT match, no line: the old "not found" sentence is gone in every case
  for (const none of [undefined, null, [], [{ title: "" }], [{}], "EXACT"]) {
    const shown = lines(none);
    assert.equal(shown.at(-1), CONCISE_DISCLAIMER);
    assert.ok(!shown.some((line) => line.includes("官方 Q&A")), String(none));
  }
});

test("the final answer object never carries the judge material from the continuation", async () => {
  const marker = "SYNTHETIC-JUDGE-MATERIAL";
  const answer = await finalizePreparedRagRulingQuestion({
    continuation: { schemaVersion: 1, mode: "rag_baseline", evidence: { officialQaRelated: [] },
      promptBundle: { prompt: "Synthetic saved prompt", modelEvidence: {}, allowedEvidenceIds: [] },
      cardResolution: { resolvedCards: [] },
      officialQaJudgeInput: { schema: "official-qa-judge-input/v1", userQuery: marker, userCards: [],
        candidates: [{ id: "qa-1", rawQuestion: marker }] } },
    env: { RAG_MODEL_PROVIDER: "mock" },
    modelInvoker: async () => "主回答",
    fetchImpl: async () => { throw new Error("network is not allowed in this test"); },
  });
  assert.ok(!JSON.stringify(answer).includes(marker));
});

test("battle timings reported by the engine replace the stale phase in time labels", () => {
  // During the battle and damage steps the engine's decision phase stays at battle_start; newer engine
  // builds add timing.at (ocg-sim-core harness "at"). Windows without it keep the phase label.
  const option = { id: 0, cmd: "chain", card: HAND_TRAP, name: "测试手坑", controller: 1, from: "hand" };
  const at = (d, id, text, value) => ({ ...d, phase: "battle_start", timing: { id, text, at: value } });
  const start = at(decision(9, "chain", 1, [option]), 40, "伤害步骤开始时", "damage_step_start");
  const before = at(decision(12, "chain", 1, [option]), 41, "伤害计算前", "before_damage_calc");
  const own = at(decision(14, "chain", 0, [{ ...option, controller: 0, card: SPELL, name: "测试融合魔法" }]), 41, "伤害计算前",
    "before_damage_calc");
  const stale = { ...decision(16, "chain", 1, []), phase: "battle_start" };
  const win = (d, hit) => ({ ...window(d, hit), timing: d.timing });
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
      engine: replayed([
        { index: 0, after: 4, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "present",
          windows: [win(before, true)], ambiguous: false },
        { index: 1, after: 4, player: 0, decision_kind: "chain", target: { card: SPELL }, result: "present",
          windows: [win(own, true)], ambiguous: false },
        { index: 2, after: 3, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "absent",
          windows: [win(stale, false)], ambiguous: false },
      ], [start, before, own, stale]) }] }] });
  const text = engineReproConciseText(engineReproDigest(record));
  assert.ok(text.includes("对方在我方回合的伤害计算前可以选择「发动测试手坑」"), text);
  assert.ok(text.includes("我方在伤害计算前可以选择「发动测试融合魔法」"), text);
  assert.ok(text.includes("对方在我方战斗阶段开始没有出现「测试手坑」的发动机会"), "no timing: the phase label stays");
  assertConcise(text);
});

test("windows at one time are told apart by the chain state; every window that offered the target counts", () => {
  // The Honest pattern: our activation at 伤害计算前 (chain link 1), the opponent's window while it waits on
  // the chain, then the window again after the chain resolved. The chain state is the engine's own
  // (window chain_links / after_chain_end / in_activation / in_resolution, ocg-sim-core 2026-10-18).
  const option = { id: 0, cmd: "chain", card: HAND_TRAP, name: "测试手坑", controller: 1, from: "hand" };
  const at = (d, value) => ({ ...d, phase: "battle_start", timing: { id: 0, text: "", at: value } });
  const win = (d, hit, chain) => ({ ...window(d, hit), timing: d.timing, in_activation: false, in_resolution: false,
    after_chain_end: false, ...chain });
  const start = at(decision(9, "chain", 1, [option]), "damage_step_start");
  const during = at(decision(12, "chain", 1, [option]), "before_damage_calc");
  const after = at(decision(15, "chain", 1, [option]), "before_damage_calc");
  const main = decision(20, "chain", 1, [option]);
  const summonWindow = decision(22, "chain", 1, [option]);
  const resolving = { ...decision(30, "yesno", 1, []), kind: "yesno" };
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
      engine: replayed([
        { index: 0, after: 3, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "present", ambiguous: false,
          windows: [win(start, true, { chain_links: 0 }), win(during, true, { chain_links: 1 }),
            win(after, true, { chain_links: 0, after_chain_end: true })] },
        { index: 1, after: 5, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "present", ambiguous: false,
          windows: [win(main, true, { chain_links: 1 }), win(summonWindow, true, { chain_links: 0 })] },
        { index: 2, after: 6, player: 1, decision_kind: "yesno", target: { card: HAND_TRAP }, result: "present", ambiguous: false,
          windows: [win(resolving, true, { chain_links: 0, in_resolution: true })] },
      ], [start, during, after, main, summonWindow, resolving]) }] }] });
  const digest = engineReproDigest(record);
  assert.deepEqual(digest.subQuestions[0].branches[0].probes.map((probe) => probe.when), [
    ["我方回合的伤害步骤开始时", "我方回合的伤害计算前（连锁 1 处理前、连锁处理完毕后）"],
    ["我方主要阶段1（连锁 1 处理前、没有连锁时）"],
    ["我方主要阶段1（连锁 1 处理中）"],
  ]);
  const text = engineReproConciseText(digest);
  assert.ok(text.includes("对方在我方回合的伤害步骤开始时、我方回合的伤害计算前（连锁 1 处理前、连锁处理完毕后）可以选择「发动测试手坑」"), text);
  assertConcise(text);
});

test("yes/no probes: a prompt that names the card is quoted; only the generic offer is called an activation", () => {
  const prompt = (index, kind, extra) => ({ decision: index, kind, phase: "main1", hint: null, options: [], contains_target: true,
    chain_links: 0, in_activation: false, in_resolution: true, after_chain_end: false, ...extra });
  const replacement = prompt(31, "effect_yn", { desc: 96, desc_text: "是否使用[%ls]的效果代替破坏？",
    card: { card: MONSTER_A, name: "测试怪兽A", from: "mzone" } });
  const generic = prompt(32, "effect_yn", { desc: 221, desc_text: "是否发动效果？", in_resolution: false,
    card: { card: MONSTER_B, name: "测试怪兽B", from: "grave" } });
  const opponentAsked = prompt(33, "yesno", { desc: HAND_TRAP * 16 + 1, desc_text: "是否把怪兽从手卡特殊召唤？" });
  const quiet = { ...prompt(34, "yesno", { desc: 30, desc_text: "是否继续攻击？", in_resolution: false }), contains_target: false };
  const d = (index, player) => decision(index, "effect_yn", player);
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
      engine: replayed([
        { index: 0, after: 1, player: 0, decision_kind: "effect_yn", target: { card: MONSTER_A }, result: "present", windows: [replacement] },
        { index: 1, after: 1, player: 0, decision_kind: "effect_yn", target: { card: MONSTER_B }, result: "present", windows: [generic],
          card_level_only: true },
        { index: 2, after: 1, player: 1, decision_kind: "yesno", target: { card: HAND_TRAP }, result: "present", windows: [opponentAsked] },
        { index: 3, after: 1, player: 1, decision_kind: "yesno", target: { card: SPELL }, result: "absent", windows: [quiet] },
      ], [d(31, 0), d(32, 0), d(33, 1), d(34, 1)]) }] }] });
  const text = engineReproConciseText(engineReproDigest(record));
  assert.ok(text.includes("我方在主要阶段1（连锁 1 处理中）被询问「是否使用测试怪兽A的效果代替破坏？」"), text);
  assert.ok(text.includes("我方在主要阶段1可以选择「发动测试怪兽B」（只能确认到卡，不能确认是哪个效果）"), text);
  assert.ok(text.includes("对方在我方主要阶段1（连锁 1 处理中）被询问「是否把怪兽从手卡特殊召唤？」"), text);
  assert.ok(text.includes("对方在我方主要阶段1没有出现与「测试融合魔法」有关的询问"), text);
  assert.doesNotMatch(text, /发动测试怪兽A|发动测试手坑/u);
  assertConcise(text);
});

test("older engine results without chain fields read as before (no chain state)", () => {
  const option = { id: 0, cmd: "chain", card: HAND_TRAP, name: "测试手坑", controller: 1, from: "hand" };
  const d = { ...decision(12, "chain", 1, [option]), phase: "battle_start", timing: { id: 41, text: "伤害计算前", at: "before_damage_calc" } };
  const later = { ...d, index: 15 };
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
      engine: replayed([{ index: 0, after: 4, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "present",
        windows: [{ ...window(d, true), timing: d.timing }, { ...window(later, true), timing: later.timing, chain_links: "1" }],
        ambiguous: false }], [d, later]) }] }] });
  assert.deepEqual(engineReproDigest(record).subQuestions[0].branches[0].probes[0].when, ["我方回合的伤害计算前"]);
});

test("the reproduction's own daily budget or per-minute limit: one line that names ygopro", () => {
  const refused = (code) => ({ cards, error: { code, message: code }, summary: { status: "未复现", reasonCodes: ["budget_exceeded"], flags: [] },
    plan: { applicability: "applicable", assumptions: ["不应出现"] }, subQuestions: [] });
  for (const code of ["engine_repro_daily_budget_exceeded", "engine_repro_rate_limited"]) {
    const digest = engineReproDigest(refused(code));
    assert.equal(digest.admissionLimit, code);
    const text = engineReproConciseText(digest, { officialQaMatches: EXACT_MATCH });
    assert.equal(text, ADMISSION_LIMIT_LINES[code]);
    assert.doesNotMatch(text, /\n/u, "a single line");
    assert.match(text, /^【ygopro 引擎复现（实验性）】.*ygopro/u);
  }
  assert.equal(ADMISSION_LIMIT_LINES.engine_repro_daily_budget_exceeded, "【ygopro 引擎复现（实验性）】今日额度已用完，本题没有完成 ygopro 复现。");
  assert.equal(ADMISSION_LIMIT_LINES.engine_repro_rate_limited, "【ygopro 引擎复现（实验性）】每分钟次数已达上限，本题没有运行 ygopro 复现。");
  // the engine's own run limit (no admission error code) keeps the status and the plain reason
  const engineLimit = engineReproDigest({ cards, summary: { status: "未复现", reasonCodes: ["budget_exceeded"] } });
  assert.equal(engineLimit.admissionLimit, null);
  assert.equal(engineReproConciseText(engineLimit), `【ygopro 引擎复现（实验性）】未复现\n\n原因：${REASON_PLAIN.budget_exceeded}。`);
});

test("append: the answer text gets the short section only; the full replay stays in engineRepro.rendered", () => {
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", branches: [{ id: "b1", scenario: board(), engine: replayed([], []) }] }] });
  const section = { status: "done", questionStatus: record.summary.status, rendered: record.rendered, digest: engineReproDigest(record) };
  const footer = "\n\n实际最终模型：m；请求推理强度：low";
  const answer = { shortAnswer: `主回答${footer}`, generation: { embeddedInAnswerText: true, answerTextFooter: footer },
    debug: { retrievalCounts: { officialQaDirectCandidates: 1, officialQaRelated: 2 } } };
  const judge = { status: "done", promptVersion: "official-qa-correspondence-v1", model: "gpt-6-luna", effort: "low",
    candidateCount: 2, exact: [{ id: "qa-1", title: "题A", handle: "h1" }], ms: 4000, costUsd: 0.0003,
    assessments: [{ id: "qa-1", verdict: "EXACT", differences: [], reason: "r1" },
      { id: "qa-2", verdict: "PARTIAL", differences: ["时点"], reason: "r2" }] };
  const out = appendEngineReproSection(answer, section, { officialQaJudge: judge });
  const concise = engineReproSectionText(section, { officialQaMatches: judge.exact });
  assert.ok(concise.includes(officialQaExactLine(judge.exact)));
  assert.equal(out.shortAnswer, `主回答\n\n${concise}${footer}`);
  assert.equal(out.engineRepro.concise, concise);
  assert.deepEqual(out.engineRepro.officialQaJudge.verdicts, { EXACT: 1, PARTIAL: 1, NOT: 0 });
  assert.deepEqual(out.engineRepro.officialQaJudge.exact, [{ id: "qa-1", title: "题A" }]);
  assert.equal(Object.hasOwn(out.engineRepro, "officialQaState"), false);
  assert.equal(out.engineRepro.rendered, record.rendered);
  // without a judge result, or with any result that is not "done", there is no line
  for (const other of [null, { status: "failed", error: "output_not_json", exact: [{ id: "qa-1", title: "题A" }] },
    { status: "skipped", reason: "no_candidates" }]) {
    const plain = appendEngineReproSection(answer, section, { officialQaJudge: other });
    assert.ok(!plain.engineRepro.concise.includes("官方 Q&A"), JSON.stringify(other));
  }
  assert.equal(appendEngineReproSection(answer, section).engineRepro.officialQaJudge, null);
  assert.ok(!out.shortAnswer.includes(record.rendered.split("\n")[0]), "the full replay header is not in the answer text");
  assertConcise(out.shortAnswer);

  const timeout = engineReproSectionText({ status: "timeout", elapsedMs: 3000, waitedMs: 1500 });
  assert.equal(timeout, "【ygopro 引擎复现（实验性）】未完成\n\nygopro 引擎复现在等待上限内未完成（复现已耗时 3.0 秒，主回答完成后已等待 1.5 秒）。结果仍会写入历史记录。");
  assert.equal(appendEngineReproSection({ shortAnswer: "a" }, { status: "done" }).shortAnswer, "a");
});
