import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuestion, renderQuestion } from "../backend/engineRepro/aggregate.mjs";
import { CONCISE_DISCLAIMER, engineReproConciseText, engineReproDigest, OFFICIAL_QA_ABSENT_LINE,
  OFFICIAL_QA_PRESENT_LINE, officialQaDirectFromAnswer, REASON_PLAIN } from "../backend/engineRepro/concise.mjs";
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
  const text = engineReproConciseText(engineReproDigest(record), { officialQaDirect: false });
  assert.deepEqual(text.split("\n\n"), [
    "【引擎复现（实验性）】已复现",
    "引擎在下面的局面里：",
    "子问题 1：我方在主要阶段1可以选择「发动测试融合魔法」。",
    "子问题 2：「测试怪兽B」作为必发效果由引擎自动发动（只能确认到卡，不能确认是哪个效果）；对方在我方主要阶段1没有出现「测试手坑」的发动机会。",
    "局面：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
    "假设：双方无其他适用效果；我方有填充卡可供舍弃。",
    OFFICIAL_QA_ABSENT_LINE,
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
  const lines = engineReproConciseText(engineReproDigest(record), { officialQaDirect: true }).split("\n\n");
  assert.deepEqual(lines, [
    "【引擎复现（实验性）】已复现",
    "引擎在下面的局面里：",
    "假设「对方手卡有测试手坑」：对方在我方主要阶段1可以选择「发动测试手坑」。",
    "无额外假设：引擎按计划走完了操作，这一问没有设置检查点（过程见完整回放）。",
    "局面（假设「对方手卡有测试手坑」）：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备），手卡 测试手坑（另有填充卡）。",
    "局面（无额外假设）：我方手卡 测试融合魔法，额外卡组 测试融合怪兽；对方场上 测试怪兽A（表侧攻击）、测试怪兽B（里侧守备）（另有填充卡）。",
    OFFICIAL_QA_PRESENT_LINE,
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
  const text = engineReproConciseText(engineReproDigest(record), { officialQaDirect: false });
  assert.deepEqual(text.split("\n\n").slice(0, 6), [
    "【引擎复现（实验性）】部分复现",
    "引擎在下面的局面里：",
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
    const text = engineReproConciseText(engineReproDigest(record), { officialQaDirect: false });
    assert.equal(text, `【引擎复现（实验性）】未复现\n\n原因：${reason}。`, code);
    assertConcise(text);
  }
  // the same through the mechanical aggregation: the only sub-question cannot be built
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", unrepresentable: "伤害步骤中", branches: [] }] });
  assert.equal(engineReproConciseText(engineReproDigest(record), { officialQaDirect: true }),
    "【引擎复现（实验性）】未复现\n\n原因：引擎搭不出题目描述的局面。");
});

test("不适用: one plain sentence per planner reason; no steps, no assumptions, no Q&A line", () => {
  for (const code of ["pure_rule", "archetype_level", "tournament_policy", "ruleset_version"]) {
    const record = finished({ cards, plan: { applicability: "not_applicable", reason_code: code, archetype_name: null,
      assumptions: ["不应出现"], sub_questions: [] }, subQuestions: [] });
    assert.equal(record.summary.status, "不适用");
    const text = engineReproConciseText(engineReproDigest(record), { officialQaDirect: true });
    assert.equal(text, `【引擎复现（实验性）】不适用\n\n原因：${REASON_PLAIN[code]}。`, code);
  }
  const noCard = finished({ preStatus: { status: "不适用", reason: "no_card_mentioned", detail: "没有抽取到卡名" } });
  assert.equal(engineReproConciseText(engineReproDigest(noCard)), "【引擎复现（实验性）】不适用\n\n原因：题目没有点名具体的卡。");
});

test("official Q&A line follows the evidence pack only: empty, non-empty, unknown", () => {
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", branches: [{ id: "b1", scenario: board(), engine: replayed([], []) }] }] });
  const digest = engineReproDigest(record);
  const withLine = (value) => engineReproConciseText(digest, { officialQaDirect: value }).split("\n\n");
  assert.equal(withLine(false).at(-2), OFFICIAL_QA_ABSENT_LINE);
  assert.equal(withLine(true).at(-2), OFFICIAL_QA_PRESENT_LINE);
  assert.ok(!withLine(null).includes(OFFICIAL_QA_ABSENT_LINE) && !withLine(null).includes(OFFICIAL_QA_PRESENT_LINE));
  assert.equal(withLine(null).at(-1), CONCISE_DISCLAIMER);
  assert.equal(officialQaDirectFromAnswer({ debug: { retrievalCounts: { officialQaDirectCandidates: 0 } } }), false);
  assert.equal(officialQaDirectFromAnswer({ debug: { retrievalCounts: { officialQaDirectCandidates: 2 } } }), true);
  assert.equal(officialQaDirectFromAnswer({ debug: {} }), null);
});

test("the official Q&A signal is the prepared evidence pack's direct candidates, not the model's wording", async () => {
  const finalize = (officialQaDirectCandidates, modelText) => finalizePreparedRagRulingQuestion({
    continuation: { schemaVersion: 1, mode: "rag_baseline", evidence: { officialQaDirectCandidates },
      promptBundle: { prompt: "Synthetic saved prompt", modelEvidence: {}, allowedEvidenceIds: [] },
      cardResolution: { resolvedCards: [] } },
    env: { RAG_MODEL_PROVIDER: "mock" },
    modelInvoker: async () => modelText,
    fetchImpl: async () => { throw new Error("network is not allowed in this test"); },
  });
  const direct = { id: "qa-direct", type: "official_qa", title: "Synthetic official Q&A" };
  assert.equal(officialQaDirectFromAnswer(await finalize([], "本题有官方 Q&A 直接对应。")), false);
  assert.equal(officialQaDirectFromAnswer(await finalize([direct], "没有找到官方 Q&A。")), true);
});

test("append: the answer text gets the short section only; the full replay stays in engineRepro.rendered", () => {
  const record = finished({ cards, plan: { applicability: "applicable", assumptions: [] },
    subQuestions: [{ id: "q1", branches: [{ id: "b1", scenario: board(), engine: replayed([], []) }] }] });
  const section = { status: "done", questionStatus: record.summary.status, rendered: record.rendered, digest: engineReproDigest(record) };
  const footer = "\n\n实际最终模型：m；请求推理强度：low";
  const answer = { shortAnswer: `主回答${footer}`, generation: { embeddedInAnswerText: true, answerTextFooter: footer },
    debug: { retrievalCounts: { officialQaDirectCandidates: 0 } } };
  const out = appendEngineReproSection(answer, section);
  const concise = engineReproSectionText(section, { officialQaDirect: false });
  assert.equal(out.shortAnswer, `主回答\n\n${concise}${footer}`);
  assert.equal(out.engineRepro.concise, concise);
  assert.equal(out.engineRepro.officialQaDirect, false);
  assert.equal(out.engineRepro.rendered, record.rendered);
  assert.ok(!out.shortAnswer.includes(record.rendered.split("\n")[0]), "the full replay header is not in the answer text");
  assertConcise(out.shortAnswer);

  const timeout = engineReproSectionText({ status: "timeout", elapsedMs: 3000, waitedMs: 1500 });
  assert.equal(timeout, "【引擎复现（实验性）】未完成\n\n引擎复现在等待上限内未完成（复现已耗时 3.0 秒，主回答完成后已等待 1.5 秒）。结果仍会写入历史记录。");
  assert.equal(appendEngineReproSection({ shortAnswer: "a" }, { status: "done" }).shortAnswer, "a");
});
