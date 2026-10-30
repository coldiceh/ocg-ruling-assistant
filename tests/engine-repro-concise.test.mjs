import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuestion, renderQuestion } from "../backend/engineRepro/aggregate.mjs";
import { ADMISSION_LIMIT_LINES, CONCISE_DISCLAIMER, CONCISE_RESULTS_LEAD, cardStateText, engineReproConciseText, engineReproDigest,
  normalizeCardState, officialQaExactLine, REASON_PLAIN } from "../backend/engineRepro/concise.mjs";
import { runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
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

// Life points appear only as a change at the end of a replay without check points ("基本分 对方 8000→7200"),
// never as the replay's own "结束时基本分：" line. Replay / log vocabulary stays out of the short section
// (2026-10-30): times are written in players' terms.
const FORBIDDEN = [/本可发动/u, /决策#/u, /版本：/u, /基本分：/u, /个响应窗口/u, /\bLP\b/u, /\[\d\]/u, /卡组：?\s*\d+\s*张/u, /先攻/u,
  /回放/u, /日志/u, /行动选择/u, /窗口/u, /决策/u, /探测/u, /分支/u, /setup/u, /没能生成引擎可以执行的计划/u];
function assertConcise(text) {
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
  // one sentence per Markdown paragraph, or a lead line followed by "- " list items
  for (const block of text.split("\n\n")) {
    const [, ...items] = block.split("\n");
    for (const item of items) assert.match(item, /^- \S/u, `list item: ${item}`);
  }
}
// The fields an engine without the extended state (ocg-sim-core fc0b250: position, ATK, DEF, disabled) leaves
// out of a monster on the field, as the short section names them.
const MONSTER_MISSING = "种类、属性、种族、等级/阶级/连接数、原本攻击力、原本守备力、指示物、超量素材、装备卡、持续对象、持有者未取得";
const results = (...items) => [CONCISE_RESULTS_LEAD, ...items.map((item) => `- ${item}`)].join("\n");

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
    results("子问题 1「能发动吗」：我方在主要阶段1可以选择「发动测试融合魔法」",
      "子问题 2「会怎样」：「测试怪兽B」作为必发效果由引擎自动发动（只能确认到卡，不能确认是哪个效果）",
      "子问题 2「会怎样」：对方在我方主要阶段1没有出现「测试手坑」的发动机会"),
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
    results("假设「对方手卡有测试手坑」：对方在我方主要阶段1可以选择「发动测试手坑」",
      "无额外假设：操作做完后，引擎没有返回场上的卡"),
    "局面（假设「对方手卡有测试手坑」）：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
    "局面（无额外假设）：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备）（另有填充卡）。",
    "判断模型认为官方 Q&A【测试手坑能否在对方回合发动？】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。",
    CONCISE_DISCLAIMER,
  ]);
});

test("部分复现: an unreached check point and an unrepresentable sub-question (the planner's own words); more than three assumptions end in 等", () => {
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
  assert.deepEqual(text.split("\n\n"), [
    "【ygopro 引擎复现（实验性）】部分复现",
    results("子问题 1：我方在主要阶段1可以选择「发动测试融合魔法」（只能确认到卡，不能确认是哪个效果）",
      "子问题 2：要看的这段过程里对方一次也没有得到发动或连锁的机会，所以看不出「测试手坑」能否发动"),
    "局面：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
    "假设：甲；乙；丙等。",
    "没能复现的部分：子问题 3：搭不出题目说的局面——本回合已通常召唤。",
    CONCISE_DISCLAIMER,
  ]);
  assertConcise(text);
});

test("未复现: only the first line and the reason; a reason code alone reads in plain words", () => {
  const expected = {
    identity: "题目里的卡名没有解析出来",
    unrepresentable: "引擎搭不出题目描述的局面",
    action_mismatch: "计划里有一步在引擎里做不到，没能走到题目要看的时点",
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
  // the same through the mechanical aggregation: the only sub-question cannot be built; the planner's own
  // sentence is the reason, as written
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", unrepresentable: "题目没说是哪张卡让你抽牌，复现器不会自己补卡。", branches: [] }] });
  const text = engineReproConciseText(engineReproDigest(record), { officialQaMatches: EXACT_MATCH });
  assert.equal(text, "【ygopro 引擎复现（实验性）】未复现\n\n原因：搭不出题目说的局面——题目没说是哪张卡让你抽牌，复现器不会自己补卡。");
  assertConcise(text);
});

test("未复现: where the replay stopped, in words, from the engine's failure record", () => {
  // The step the replay could not take (failure.step is 0-based), the decision the engine was at, and for a
  // step that waits for a window the windows of its player the replay passed after the last executed step.
  const executed = (index, kind, player, step) => ({ decision: { ...decision(index, kind, player), turn_player: 0 }, by: "setup", step, log_pos: 0 });
  const passed = (index, kind, player, options = []) => ({ decision: { ...decision(index, kind, player, options), turn_player: 0 },
    by: "pass", choice: "pass", log_pos: 0 });
  const failedRun = (failure, decisions) => ({ status: "not_reproduced", reason_code: "action_mismatch", failure, probes: [],
    decisions, log: [], rendered_zh: DEBUG_REPLAY });
  const idleAt = { kind: "idle", player: 0, phase: "main1", options: [{ id: 0, cmd: "to_bp" }, { id: 1, cmd: "to_ep" }] };
  const handTrapChain = { player: 1, decision: "chain", choose: { card: HAND_TRAP } };
  const text = (engine, assumption = null) => engineReproConciseText(engineReproDigest(finished({ cards,
    plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption, scenario: board(), engine }] }] })));
  const head = "【ygopro 引擎复现（实验性）】未复现\n\n原因：";

  // the question's own action written as a step: the opponent's windows came, none offered the card
  const neverOffered = failedRun({ reason: "not_found", step: 2, step_spec: handTrapChain, decision: idleAt },
    [executed(1, "idle", 0, 0), executed(2, "select_card", 0, 1), passed(3, "chain", 1), passed(4, "chain", 0)]);
  const shown = text(neverOffered);
  assert.equal(shown, `${head}按计划操作到第 3 步（对方发动「测试手坑」）时卡住了：之后对方有过发动或连锁的机会，但里面都没有这张卡，接着就到了我方的主要阶段1。`);
  assertConcise(shown);
  // offered, but the step's filter did not match it
  const offered = failedRun({ reason: "not_found", step: 2, step_spec: { ...handTrapChain, choose: { card: HAND_TRAP, from: "grave" } },
    decision: idleAt }, [executed(1, "idle", 0, 0), executed(2, "select_card", 0, 1),
    passed(3, "chain", 1, [{ id: 0, cmd: "chain", card: HAND_TRAP, name: "测试手坑", controller: 1, from: "hand" }])]);
  assert.equal(text(offered), `${head}按计划操作到第 3 步（对方发动「测试手坑」）时卡住了：这张卡在之后的发动机会里出现过，但这一步写的时机、区域或效果没有对上，接着就到了我方的主要阶段1。`);
  // no window of that player at all after the last executed step
  const noWindow = failedRun({ reason: "not_found", step: 1, step_spec: handTrapChain, decision: idleAt }, [executed(1, "idle", 0, 0)]);
  assert.equal(text(noWindow), `${head}按计划操作到第 2 步（对方发动「测试手坑」）时卡住了：之后对方再也没有发动或连锁的机会，接着就到了我方的主要阶段1。`);
  // a choice the plan left out (the position of a special summon during resolution)
  const position = failedRun({ reason: "not_found", step: 1, step_spec: { player: 0, decision: "idle", choose: { cmd: "summon", card: MONSTER_A } },
    decision: { kind: "select_position", player: 0, phase: "main1", card: { card: MONSTER_B, name: "测试怪兽B" },
      options: [{ id: 0, cmd: "position", position: "faceup_attack" }, { id: 1, cmd: "position", position: "faceup_defense" }] } },
  [executed(1, "idle", 0, 0)]);
  assert.equal(text(position), `${head}按计划操作到第 2 步（我方通常召唤「测试怪兽A」）时卡住了：引擎这时要我方先为「测试怪兽B」选择表示形式（可选：表侧攻击、表侧守备），计划里没有写这一步。`);
  // the right decision, an option it does not offer; and a step that matches more than one option
  const picked = { player: 0, decision: "select_card", choose: { cards: [{ card: MONSTER_A, controller: 1 }] } };
  const notOffered = failedRun({ reason: "not_found", step: 3, step_spec: picked, decision: { kind: "select_card", player: 0, phase: "main1",
    options: [{ id: 0, cmd: "card", card: MONSTER_B, name: "测试怪兽B" }, { id: 1, cmd: "card", card: FUSION, name: "测试融合怪兽" }] } },
  [executed(1, "idle", 0, 0)]);
  assert.equal(text(notOffered), `${head}按计划操作到第 4 步（我方选择「测试怪兽A」）时卡住了：引擎给出的选项里没有这一项（可选：测试怪兽B、测试融合怪兽）。`);
  const twice = failedRun({ reason: "not_unique", step: 3, step_spec: picked, decision: { kind: "select_card", player: 0, phase: "main1",
    options: [] } }, [executed(1, "idle", 0, 0)]);
  assert.equal(text(twice), `${head}按计划操作到第 4 步（我方选择「测试怪兽A」）时卡住了：引擎里有不止一个选项都符合这一步，没法确定是哪一个。`);
  for (const engine of [neverOffered, offered, noWindow, position, notOffered, twice]) assertConcise(text(engine));

  // 部分复现: the failed branch's reason is listed under 没能复现的部分
  const ok = replayed([{ index: 0, after: 1, player: 1, decision_kind: "chain", target: { card: HAND_TRAP }, result: "absent",
    windows: [window(decision(5, "chain", 1, []), false)] }], [decision(5, "chain", 1, [])]);
  const partial = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: "写成探测", scenario: board(), engine: ok },
      { id: "b2", assumption: "写成步骤", scenario: board(), engine: neverOffered }] }] });
  assert.equal(partial.summary.status, "部分复现");
  const lines = engineReproConciseText(engineReproDigest(partial)).split("\n\n");
  assert.ok(lines.includes("没能复现的部分：假设「写成步骤」：按计划操作到第 3 步（对方发动「测试手坑」）时卡住了：之后对方有过发动或连锁的机会，但里面都没有这张卡，接着就到了我方的主要阶段1。"),
    lines.join("\n"));
  assert.equal(lines[1], results("假设「写成探测」：对方在我方主要阶段1没有出现「测试手坑」的发动机会"));
});

test("a check point not reached: its result is told; another check point's result makes it 部分复现, not 未复现", () => {
  // The setup finished but an effect_yn probe saw no prompt at all (the trigger was not triggered), while a
  // chain probe of the same card saw an empty window: the engine reports action_mismatch / probe_not_reached.
  const effectYn = { index: 1, after: 3, player: 0, decision_kind: "effect_yn", target: { card: FUSION }, result: "not_reached", windows: [] };
  const chainWindow = { ...decision(9, "chain", 0, []), chain_links: 0, after_chain_end: true };
  const chain = { index: 0, after: 3, player: 0, decision_kind: "chain", target: { card: FUSION, from: "grave" }, result: "absent",
    windows: [{ ...window(chainWindow, false), chain_links: 0, in_activation: false, in_resolution: false, after_chain_end: true }] };
  const unreached = (probes) => ({ status: "not_reproduced", reason_code: "action_mismatch",
    failure: { reason: "probe_not_reached", probes: probes.map((p) => p.index).filter((_, i) => probes[i].result === "not_reached") },
    probes, decisions: [{ decision: chainWindow, by: "pass", choice: "pass", log_pos: 0 }], log: [], rendered_zh: DEBUG_REPLAY });
  const record = (probes) => finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(), engine: unreached(probes) }] }] });

  const onlyPrompt = record([effectYn]);
  assert.equal(onlyPrompt.summary.status, "未复现", "nothing was decided");
  const failed = engineReproConciseText(engineReproDigest(onlyPrompt));
  assert.equal(failed, "【ygopro 引擎复现（实验性）】未复现\n\n"
    + "原因：要看的这段过程里我方一次也没有被询问是否发动效果，所以看不出「测试融合怪兽」能否发动。");
  assertConcise(failed);

  const both = record([chain, effectYn]);
  assert.equal(both.summary.status, "部分复现", "the chain probe decided");
  const partly = engineReproConciseText(engineReproDigest(both));
  assert.equal(partly.split("\n\n")[1], results("我方在主要阶段1（连锁处理完毕后）没有出现「测试融合怪兽」的发动机会",
    "要看的这段过程里我方一次也没有被询问是否发动效果，所以看不出「测试融合怪兽」能否发动"));
  assert.doesNotMatch(partly, /没能复现的部分/u, "the unreached check point is already among the results");
  assertConcise(partly);
});

test("the engine refused a response: the step comes from the branch's own setup", () => {
  const setup = [{ player: 0, decision: "idle", choose: { cmd: "activate", card: SPELL } },
    { player: 0, decision: "select_card", choose: { cards: [{ card: MONSTER_A, controller: 1 }, { card: MONSTER_B, controller: 1 }] } }];
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(),
      actions: { schema: "ocg-repro-actions/v1", setup, probes: [] },
      engine: { status: "not_reproduced", reason_code: "action_mismatch", probes: [], log: [], rendered_zh: DEBUG_REPLAY,
        decisions: [{ decision: decision(2, "idle", 0), by: "setup", step: 0, choice: [0], log_pos: 0 }],
        failure: { reason: "engine_rejected_response", message: "MSG_RETRY",
          last_decision: { decision: decision(3, "select_card", 0), by: "setup", step: 1, choice: [0, 1], log_pos: 0 },
          last_response: null } } }] }] });
  assert.equal(engineReproConciseText(engineReproDigest(record)).split("\n\n")[1],
    "原因：按计划操作到第 2 步（我方选择「测试怪兽A」、「测试怪兽B」）时卡住了：引擎不接受这个选择（例如选的卡不符合条件或张数不对）。");
});

test("no check point: every card on both fields with its full state, life points and the cards that left", () => {
  // A question about what the processing does has no probe; the line is the end of the replay: face-up
  // monsters with ATK (DEF in defense position), face-down ones by name, life points that changed and the
  // cards that left the field (a card that only finished resolving, reason "rule", is not listed).
  const end = replayed([], []);
  end.state = { players: {
    0: { lp: 8000, mzone: [{ card: MONSTER_A, name: "测试怪兽A", seq: 0, position: "faceup_attack", attack: 1600, defense: 1000 }, null] },
    1: { lp: 7200, mzone: [{ card: MONSTER_B, name: "测试怪兽B", seq: 0, position: "faceup_defense", attack: 0, defense: 2000 },
      { card: FUSION, name: "测试融合怪兽", seq: 1, position: "facedown_defense", attack: 3000, defense: 2500 }] } } };
  end.log = [
    { type: "move", card: SPELL, name: "测试融合魔法", from: { player: 0, location: "szone", seq: 0 }, to: { player: 0, location: "grave" }, reason: ["rule"] },
    { type: "move", card: HAND_TRAP, name: "测试手坑", from: { player: 1, location: "mzone", seq: 2 }, to: { player: 1, location: "grave" },
      reason: ["destroy", "battle"] },
  ];
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(), engine: end }] }] });
  const text = engineReproConciseText(engineReproDigest(record));
  // no card in a spell/trap zone: no monster can carry an equip card; this older engine reports neither
  // `disabled` nor the extended fields, which are named as not obtained
  const missing = "种类、属性、种族、等级/阶级/连接数、原本攻击力、原本守备力、效果是否被无效、指示物、超量素材、持续对象、持有者未取得";
  assert.equal(text.split("\n\n")[1], results(
    `操作做完后，我方场上的「测试怪兽A」：表侧攻击表示，攻击力 1600，守备力 1000，没有装备卡；${missing}`,
    `操作做完后，对方场上的「测试怪兽B」：表侧守备表示，攻击力 0，守备力 2000，没有装备卡；${missing}`,
    `操作做完后，对方场上的「测试融合怪兽」：里侧守备表示，攻击力 3000，守备力 2500，没有装备卡；${missing}`,
    "操作做完后，基本分 对方 8000→7200",
    "离开过场上的卡：「测试手坑」（破坏、战斗，送去墓地）"));
  assertConcise(text);
  // the engine reported no zone at all: said so, not "both fields are empty"
  const empty = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(), engine: replayed([], []) }] }] });
  assert.equal(engineReproConciseText(engineReproDigest(empty)).split("\n\n")[1], results("操作做完后，引擎没有返回场上的卡"));
  assert.equal(engineReproDigest(empty).observations[0].empty, true, "nothing to report: no conclusion call is made for it");
});

test("a result question: the plan's result cards at the moment the engine stopped, every reported field, 未取得 for the rest", () => {
  // 虹之衣 pattern (checked on the pinned engine): the attack is cancelled on replay; the replay stops at our
  // battle command; the attacked monster is still negated. The engine state carries `disabled` (2026-10-20).
  const stopAt = { ...decision(31, "battle", 0, [{ id: 0, cmd: "to_m2" }, { id: 1, cmd: "to_ep" }]), phase: "battle_start" };
  const end = replayed([], []);
  end.decisions = [{ decision: stopAt, by: "end", choice: null, log_pos: 0 }];
  end.state = { phase: "battle_start", players: {
    0: { lp: 8000, mzone: [{ card: FILLER, name: "魔物狩人", seq: 0, position: "faceup_attack", attack: 1500, defense: 1200, disabled: false }],
      szone: [{ card: SPELL, name: "测试融合魔法", seq: 0, position: "faceup", disabled: false }], grave: [], hand: [] },
    1: { lp: 8000, mzone: [{ card: MONSTER_B, name: "测试怪兽B", seq: 0, position: "faceup_defense", attack: 3000, defense: 2000, disabled: true },
      { card: MONSTER_A, name: "测试怪兽A", seq: 1, position: "faceup_attack", attack: 100, defense: 2100, disabled: false }],
      grave: [{ card: HAND_TRAP, name: "测试手坑", seq: 0 }] } } };
  const equipped = board();
  equipped.players[0].mzone = [{ seq: 0, code: FILLER, position: "faceup_attack" }];
  equipped.players[0].szone = [{ seq: 0, code: SPELL, position: "faceup", equip_to: { player: 0, zone: "mzone", seq: 0 } }];
  const record = (resultCards, observe = null) => finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: equipped, engine: end,
      resultCards, observe }] }] });

  const focused = engineReproConciseText(engineReproDigest(record([{ card: MONSTER_B, controller: 1 },
    { card: HAND_TRAP, controller: 1 }, { card: FUSION, controller: 0 }], "取消攻击后测试怪兽B是否仍被无效"))).split("\n\n");
  // the moment is the battle command the replay stopped at, in players' terms; ATK and DEF both, never only one
  assert.equal(focused[1], results(
    `取消攻击后测试怪兽B是否仍被无效——到我方战斗阶段时，对方场上的「测试怪兽B」：表侧守备表示，攻击力 3000，守备力 2000，效果被无效；${MONSTER_MISSING}`,
    "到我方战斗阶段时，对方的「测试手坑」在墓地：种类、属性、种族、等级、攻守等状态未取得",
    "到我方战斗阶段时，我方的「测试融合怪兽」不在场上，也不在手卡、墓地、除外区、卡组和额外卡组里"));
  // the field cards are all on the board line (the attacker is a filler card), an equip card names its monster
  assert.equal(focused[2], "局面：我方场上 魔物狩人（表侧攻击）、测试融合魔法（装备给魔物狩人），手卡 测试融合魔法，额外卡组 测试融合怪兽；"
    + "对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。");
  // a focus monster that is not negated says so
  const enabled = engineReproConciseText(engineReproDigest(record([{ card: MONSTER_A, controller: 1 }]))).split("\n\n")[1];
  assert.equal(enabled, results(`到我方战斗阶段时，对方场上的「测试怪兽A」：表侧攻击表示，攻击力 100，守备力 2100，效果没有被无效；${MONSTER_MISSING}`));
  // without result cards: every card on both fields, spells and traps too
  const all = engineReproConciseText(engineReproDigest(record(null))).split("\n\n")[1];
  assert.equal(all, results(
    `到我方战斗阶段时，我方场上的「魔物狩人」：表侧攻击表示，攻击力 1500，守备力 1200，效果没有被无效；${MONSTER_MISSING}`,
    "到我方战斗阶段时，我方场上的「测试融合魔法」：表侧表示，效果没有被无效；种类、指示物、装备对象、持续对象、持有者未取得",
    `到我方战斗阶段时，对方场上的「测试怪兽B」：表侧守备表示，攻击力 3000，守备力 2000，效果被无效；${MONSTER_MISSING}`,
    `到我方战斗阶段时，对方场上的「测试怪兽A」：表侧攻击表示，攻击力 100，守备力 2100，效果没有被无效；${MONSTER_MISSING}`));
  for (const text of [focused.join("\n\n"), enabled, all]) assertConcise(text);
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
  assert.match(lines[1], /^ygopro（MyCard 版核心）的运行结果：\n- /u);
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

// ---------------------------------------------------------------------------------------------------
// The full card state (2026-10-30): every field the engine can report, 未取得 for the ones it did not.
// ---------------------------------------------------------------------------------------------------

test("card state: an engine reporting every field (ygopro query values) reads in full; nothing is marked 未取得", () => {
  // Spec fields (docs/ocg-engine-integration.md 引擎状态接口规格): QUERY_TYPE / ATTRIBUTE / RACE bits, rank, current and
  // original ATK/DEF, counters, overlay, equip_target, targets, owner. The equip card sits in our zone, the monster
  // (owned by us, controlled by the opponent) in theirs.
  const monster = { card: MONSTER_B, name: "测试怪兽B", seq: 0, position: "faceup_attack", owner: 0, type: 0x1 | 0x20 | 0x800000,
    attribute: 0x20, race: 0x2, rank: 4, attack: 1900, base_attack: 2500, defense: 2100, base_defense: 2100, disabled: false,
    counters: [{ type: 0x1, name: "魔力指示物", count: 2 }], overlay: [FILLER, { card: MONSTER_A, name: "测试怪兽A" }], targets: [] };
  const equip = { card: SPELL, name: "测试融合魔法", seq: 1, position: "faceup", owner: 0, type: 0x2 | 0x40000, disabled: false,
    counters: [], equip_target: { player: 1, location: "mzone", seq: 0, card: MONSTER_B }, targets: [] };
  const link = { card: FUSION, name: "测试融合怪兽", seq: 5, position: "faceup_attack", owner: 1, type: 0x1 | 0x20 | 0x4000000,
    attribute: 0x10, race: 0x1000000, link: 2, link_marker: 0x1 | 0x4, attack: 1500, base_attack: 1500, defense: null, base_defense: null,
    disabled: true, counters: [], overlay: [], targets: [{ player: 1, location: "mzone", seq: 0 }] };
  const grave = { card: HAND_TRAP, name: "测试手坑", seq: 0, type: 0x1 | 0x20, attribute: 0x1, race: 0x4000, level: 3,
    attack: 0, base_attack: 0, defense: 1800, base_defense: 1800 };
  const stopAt = { ...decision(40, "idle", 1, [], 1), phase: "main2" };
  const end = replayed([], []);
  end.decisions = [{ decision: stopAt, by: "end", choice: null, log_pos: 0 }];
  end.log = [{ type: "move", card: HAND_TRAP, name: "测试手坑", from: { player: 1, location: "hand" }, to: { player: 1, location: "grave" },
    reason: ["discard", "cost"] }];
  end.state = { players: { 0: { lp: 8000, mzone: [], szone: [equip], hand: [], grave: [] },
    1: { lp: 8000, mzone: [monster, link], szone: [], hand: [], grave: [grave] } } };
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [], extra_cards: [] },
    subQuestions: [{ id: "q1", unrepresentable: null, branches: [{ id: "b1", assumption: null, scenario: board(), engine: end,
      resultCards: [{ card: MONSTER_B, controller: 1 }, { card: FUSION, controller: 1 }, { card: HAND_TRAP, controller: 1 }] }] }] });
  const digest = engineReproDigest(record);
  assert.deepEqual(digest.observations.map((item) => item.text), [
    "到对方主要阶段2时，对方场上的「测试怪兽B」：表侧攻击表示，种类 怪兽/效果/超量，属性 暗，种族 魔法师，阶级 4，攻击力 1900（原本 2500），"
      + "守备力 2100（原本 2100），效果没有被无效，指示物 魔力指示物 2 个，超量素材 「魔物狩人」、「测试怪兽A」，装备卡 我方的「测试融合魔法」，"
      + "持有者 我方，没有持续对象",
    "到对方主要阶段2时，对方场上的「测试融合怪兽」：表侧攻击表示，种类 怪兽/效果/连接，属性 光，种族 电子界，连接数 2，连接标记 左下、右下，"
      + "攻击力 1500（原本 1500），效果被无效，以「测试怪兽B」为持续对象，没有指示物、装备卡",
    "到对方主要阶段2时，对方的「测试手坑」在墓地（丢弃、代价，送去墓地）：种类 怪兽/效果，属性 地，种族 兽，等级 3，攻击力 0（原本 0），"
      + "守备力 1800（原本 1800）",
  ]);
  assert.ok(digest.observations.every((item) => !item.text.includes("未取得")));
  const state = digest.subQuestions[0].branches[0].end.focus[0];
  assert.deepEqual({ ...state.values }, { position: "faceup_attack", type: ["怪兽", "效果", "超量"], attribute: ["暗"], race: ["魔法师"],
    rank: 4, attack: 1900, baseAttack: 2500, defense: 2100, baseDefense: 2100, disabled: false, counters: ["魔力指示物 2 个"],
    overlay: ["「魔物狩人」", "「测试怪兽A」"], equippedBy: ["我方的「测试融合魔法」"], targets: [], owner: 0 });
  assert.deepEqual(state.missing, []);
  // the equip card on our side, seen from the field listing
  const spell = normalizeCardState(equip, { side: 0, location: "szone", names: new Map([[MONSTER_B, "测试怪兽B"]]),
    field: [{ player: 1, zone: "mzone", location: "mzone", seq: 0, entry: monster, name: "测试怪兽B" }] });
  assert.equal(cardStateText(spell), "我方场上的「测试融合魔法」：表侧表示，种类 魔法/装备，效果没有被无效，装备给对方的「测试怪兽B」，没有指示物、持续对象");
});

test("card state: an engine reporting only position, ATK/DEF and negation names every other field as 未取得", () => {
  const entry = { card: MONSTER_B, name: "测试怪兽B", seq: 0, position: "faceup_attack", attack: 1900, defense: 1200, disabled: false };
  const state = normalizeCardState(entry, { side: 1, location: "mzone", names: new Map(), field: [] });
  assert.equal(cardStateText(state), "对方场上的「测试怪兽B」：表侧攻击表示，攻击力 1900，守备力 1200，效果没有被无效，没有装备卡；"
    + "种类、属性、种族、等级/阶级/连接数、原本攻击力、原本守备力、指示物、超量素材、持续对象、持有者未取得");
  assert.deepEqual(state.missing, ["种类", "属性", "种族", "等级/阶级/连接数", "原本攻击力", "原本守备力", "指示物", "超量素材", "持续对象", "持有者"]);
  // nothing at all reported but the card itself: every field named, ATK/DEF included
  const bare = normalizeCardState({ card: MONSTER_B, seq: 0 }, { side: 0, location: "mzone", names: new Map([[MONSTER_B, "测试怪兽B"]]) });
  assert.equal(cardStateText(bare), "我方场上的「测试怪兽B」：表示形式、种类、属性、种族、等级/阶级/连接数、攻击力、原本攻击力、守备力、原本守备力、"
    + "效果是否被无效、指示物、超量素材、装备卡、持续对象、持有者未取得");
  // a set spell/trap and a card off the field
  assert.equal(cardStateText(normalizeCardState({ card: SPELL, seq: 2, position: "facedown" }, { side: 0, location: "szone",
    names: new Map([[SPELL, "测试融合魔法"]]) })), "我方场上的「测试融合魔法」：盖放；种类、效果是否被无效、指示物、装备对象、持续对象、持有者未取得");
  assert.equal(cardStateText(normalizeCardState({ card: HAND_TRAP, seq: 0, position: "facedown" }, { side: 1, location: "removed",
    names: new Map([[HAND_TRAP, "测试手坑"]]) })), "对方的「测试手坑」被除外（里侧）：种类、属性、种族、等级、攻守等状态未取得");
  // a reported null does not apply (no DEF line for it) and is not 未取得
  const nulls = normalizeCardState({ ...entry, defense: null, base_defense: null }, { side: 1, location: "mzone", field: [] });
  assert.doesNotMatch(cardStateText(nulls), /守备力/u);
});

// ---------------------------------------------------------------------------------------------------
// Why a part was not reproduced: the specific record, never the old catch-all sentence.
// ---------------------------------------------------------------------------------------------------

const engineFor = ({ reproduce } = {}) => async (op, body) => {
  if (op === "cards") return { cards: (body.codes || []).map((code) => ({ code, exists: true, name: "灰流丽", types: ["怪兽"], text: "t" })) };
  if (op === "related") return { related: [] };
  if (op === "reproduce") return { result: reproduce ? reproduce(body) : { status: "replayed", probes: [], scenario: body.scenario } };
  throw new Error(op);
};
const ashIdentity = { resolved: [{ cid: "12950", mentionedAs: ["灰流丽"], resolutionSources: [] }], unresolved: [], groupMentions: [] };
const ashCards = new Map([["12950", { id: "12950", name: "灰流丽", effectText: "t" }]]);
const reproduceWith = (outputs, { engine = engineFor(), identity = ashIdentity } = {}) => runEngineReproduction({ question: "q",
  identity, cardsById: ashCards, cidMap: { 12950: 14558127 }, engine, clock: () => 0,
  modelCall: async ({ stage }) => outputs[stage] });
const sectionOf = (record) => engineReproConciseText(engineReproDigest(record));
const ashBranch = (id, extra = {}) => ({ id, assumption: null, observe: "x", scenario: { first_player: 0, players: [{ hand: [14558127] }, {}] },
  actions: { setup: [] }, ...extra });
const ashPlan = (subQuestions) => ({ applicability: "applicable", reason_code: null, archetype_name: null, quoted_span: "q",
  what_not_why: false, assumptions: [], extra_cards: [], sub_questions: subQuestions });

test("no plan came out of the planner: each round's own outcome is the reason", async () => {
  const truncated = { status: "incomplete", incomplete: { reason: "max_output_tokens" }, outputText: "{\"applicability\":\"appl" };
  const cut = await reproduceWith({ plan: truncated, repair: truncated });
  assert.equal(cut.summary.status, "未复现");
  assert.deepEqual(cut.planFailures, [{ call: "plan", kind: "truncated" }, { call: "repair", kind: "truncated" }]);
  assert.equal(sectionOf(cut), "【ygopro 引擎复现（实验性）】未复现\n\n原因：规划模型没有给出能交给引擎的计划：第一次输出太长被截断；修复时输出太长被截断。");
  const invalid = { status: "completed", outputText: JSON.stringify({ applicability: "maybe", sub_questions: [] }) };
  const checked = await reproduceWith({ plan: invalid, repair: { status: "completed", outputText: "不是 JSON" } });
  assert.deepEqual([checked.summary.status, checked.summary.reasonCodes], ["未复现", ["invalid_input"]]);
  assert.equal(sectionOf(checked), "【ygopro 引擎复现（实验性）】未复现\n\n原因：规划模型没有给出能交给引擎的计划：第一次的计划没通过检查（applicability 取值无效）；修复时输出的不是完整的计划。");
  for (const record of [cut, checked]) {
    assertConcise(sectionOf(record));
    assert.doesNotMatch(sectionOf(record), new RegExp(REASON_PLAIN.invalid_input.replace(/[()（）]/gu, "."), "u"));
  }
});

test("a branch the plan check or the engine refused: the problems themselves are the reason", async () => {
  const notAllowed = { status: "completed", outputText: JSON.stringify(ashPlan([{ id: "q1", quoted_span: "q", unrepresentable: null,
    branches: [ashBranch("b1", { scenario: { first_player: 0, players: [{ hand: [99999999] }, {}] } })] }])) };
  const refused = await reproduceWith({ plan: notAllowed, repair: notAllowed });
  assert.equal(sectionOf(refused), "【ygopro 引擎复现（实验性）】未复现\n\n原因：计划没通过检查：卡号 99999999 不在允许的卡号列表中（题目中的卡、填充卡、相关卡、通用工具卡、extra_cards）。");
  const plan = { status: "completed", outputText: JSON.stringify(ashPlan([{ id: "q1", quoted_span: "q", unrepresentable: null, branches: [ashBranch("b1")] }])) };
  const engineSaid = await reproduceWith({ plan, repair: plan }, { engine: engineFor({ reproduce: () => ({ status: "invalid_input",
    reason_code: "invalid_input", errors: ["players[0].mzone[0].seq: 9 is not one of 0-6"] }) }) });
  assert.equal(sectionOf(engineSaid), "【ygopro 引擎复现（实验性）】未复现\n\n原因：引擎没有接受这个计划：players[0].mzone[0].seq: 9 is not one of 0-6。");
});

test("identity and run-time failures: which card, which service", async () => {
  const unknown = await reproduceWith({}, { identity: { resolved: [], unresolved: [{ input: "某张卡", reason: "not_found" }], groupMentions: [] } });
  assert.equal(sectionOf(unknown), "【ygopro 引擎复现（实验性）】未复现\n\n原因：没法确认题目里的卡：「某张卡」没能确定是哪张卡。");
  const failed = (error, reason = "engine_error") => sectionOf({ cards, error, summary: { status: "未复现", reasonCodes: [reason], flags: [] },
    subQuestions: [{ id: "q1", branches: [ashBranch("b1")] }], plan: { applicability: "applicable", assumptions: [] } });
  assert.equal(failed({ code: "engine_unavailable", message: "engine_http_503" }), "【ygopro 引擎复现（实验性）】未复现\n\n原因：引擎服务出错或暂时连不上。");
  assert.equal(failed({ code: null, name: "TimeoutError", message: "The operation was aborted due to timeout" }),
    "【ygopro 引擎复现（实验性）】未复现\n\n原因：等待引擎或规划模型超时。");
  assert.equal(failed({ code: "budget_cap", message: "budget cap" }, "budget_exceeded"), `【ygopro 引擎复现（实验性）】未复现\n\n原因：${REASON_PLAIN.budget_exceeded}。`);
  // two parts that could not be built: one item each
  const both = finished({ cards, plan: { applicability: "applicable", assumptions: [] }, subQuestions: [
    { id: "q1", quoted_span: "先发动的那张", unrepresentable: "题目没说先发动的是哪张卡", branches: [] },
    { id: "q2", quoted_span: "之后还能召唤吗", unrepresentable: "本回合已经通常召唤过这一前提要先打出来，复现器做不到", branches: [] }] });
  assert.equal(sectionOf(both), "【ygopro 引擎复现（实验性）】未复现\n\n原因：\n"
    + "- 子问题 1「先发动的那张」：搭不出题目说的局面——题目没说先发动的是哪张卡\n"
    + "- 子问题 2「之后还能召唤吗」：搭不出题目说的局面——本回合已经通常召唤过这一前提要先打出来，复现器做不到");
  assertConcise(sectionOf(both));
});
