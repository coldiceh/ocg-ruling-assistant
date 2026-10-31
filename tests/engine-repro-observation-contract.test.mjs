import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuestion, branchOutcome, reproductionFailure } from "../backend/engineRepro/aggregate.mjs";
import { engineReproConciseText, engineReproDigest } from "../backend/engineRepro/concise.mjs";

const CARD = 9000001;
const terminal = (kind = "idle") => ({ index: 8, kind, player: 0, turn: 1, turn_player: 0,
  phase: "main1", chain_links: 0, in_activation: false, in_resolution: false, options: [] });
const probe = (result, extra = {}) => ({ index: 0, after: 1, player: 0, decision_kind: "yesno",
  target: { card: CARD, desc: CARD * 16 + 2 }, result, windows: [], ...extra });
const branch = (d = terminal(), probes = []) => ({ id: "b1", actions: { setup: [{}] },
  engine: { status: "replayed", failure: null, reason_code: null, probes,
    decisions: [{ by: "end", decision: d }], state: { players: {} } } });
function recordFor(b) {
  const record = { cards: [{ code: CARD, engineName: "测试卡" }], plan: { applicability: "applicable" },
    subQuestions: [{ id: "q1", quoted_span: "询问是否出现", branches: [b] }] };
  record.summary = aggregateQuestion(record);
  return record;
}

test("steps exhausted at a required choice do not become a completed replay, including legacy responses", () => {
  for (const kind of ["select_place", "select_card", "select_position", "announce_card", "yesno"]) {
    const b = branch(terminal(kind));
    assert.equal(branchOutcome(b).ok, false, kind);
    assert.equal(reproductionFailure(b).reason, "required_decision_pending", kind);
    const record = recordFor(b);
    assert.equal(record.summary.status, "未复现");
    assert.match(engineReproConciseText(engineReproDigest(record)), /相关处理尚未完成/u);
    assert.equal(engineReproDigest(record).observations.length, 0);
  }
  assert.equal(branchOutcome(branch()).ok, true);
  assert.equal(branchOutcome(branch({ ...terminal(), in_resolution: true })).ok, false);
});

test("an intentional prompt observation must hit the very prompt where execution stops", () => {
  const d = terminal("yesno");
  const hit = { decision: d.index, kind: d.kind, contains_target: true, desc: CARD * 16 + 2 };
  assert.equal(branchOutcome(branch(d, [probe("present", { windows: [hit] })])).ok, true);
  assert.equal(branchOutcome(branch(d, [probe("present", { windows: [{ ...hit, decision: d.index - 1 }] })])).ok, false);
  assert.equal(branchOutcome(branch(d, [probe("absent", { windows: [{ ...hit, contains_target: false }] })])).ok, false);
});

test("automatic chain activation is not evidence of a yes/no prompt", () => {
  const record = recordFor(branch(terminal(), [probe("present_auto")]));
  assert.equal(record.summary.status, "未复现");
  const observations = engineReproDigest(record).observations.map((o) => o.text).join("\n");
  assert.doesNotMatch(observations, /自动发动|出现了.*询问/u);
});

test("absence is a valid observation after the explicitly bounded chain has finished", () => {
  const record = recordFor(branch(terminal(), [probe("absent", {
    interval: { end: "chain_end", completed: true, log_index: 9 },
  })]));
  assert.equal(record.summary.status, "已复现");
  const text = engineReproDigest(record).observations.map((o) => o.text).join("\n");
  assert.match(text, /从观察开始到本次连锁处理完.*没有出现所检查的「测试卡」询问/u);
  assert.doesNotMatch(text, /不能发动|无法判断|看不出/u);
});

test("a prompt hit is retained as partial evidence, but cannot close an unfinished chain interval", () => {
  const b = branch(terminal(), [probe("present", { interval: { end: "chain_end", completed: false } })]);
  const record = recordFor(b);
  assert.equal(record.summary.status, "部分复现");
  assert.equal(reproductionFailure(b).reason, "probe_interval_incomplete");
  assert.match(engineReproDigest(record).observations[0].text, /询问已出现，但这段连锁尚未处理完/u);
  b.engine.probes[0].result = "absent";
  const unfinished = recordFor(b);
  assert.equal(unfinished.summary.status, "未复现");
  assert.doesNotMatch(engineReproDigest(unfinished).observations.map((o) => o.text).join(""), /没有出现所检查/u);
});

test("new engine pending-choice diagnostics remain actionable without a nonexistent next step_spec", () => {
  const b = branch(terminal("select_place"));
  b.engine.status = "not_reproduced";
  b.engine.reason_code = "action_mismatch";
  b.engine.failure = { reason: "required_decision_pending", step: 1, step_spec: null, decision: terminal("select_place") };
  assert.match(engineReproConciseText(engineReproDigest(recordFor(b))), /仍需选择区域/u);
});

test("a later required choice preserves an already completed negative observation without reporting unfinished card state", () => {
  const b = branch(terminal("select_place"), [probe("absent", { interval: { end: "chain_end", completed: true } })]);
  b.engine.status = "not_reproduced";
  b.engine.reason_code = "action_mismatch";
  b.engine.failure = { reason: "required_decision_pending", decision: terminal("select_place") };
  const record = recordFor(b);
  assert.equal(record.summary.status, "部分复现");
  const digest = engineReproDigest(record);
  assert.equal(digest.subQuestions[0].branches[0].end, null);
  const text = engineReproConciseText(digest);
  assert.match(text, /本次连锁处理完.*没有出现所检查/u);
  assert.match(text, /没能复现的部分：.*仍需选择区域/u);
});

test("a seen prompt with a pending answer retains both the observation and the unfinished-chain qualification", () => {
  const b = branch(terminal("yesno"), [probe("present", { interval: { end: "chain_end", completed: false } })]);
  b.engine.status = "not_reproduced";
  b.engine.reason_code = "action_mismatch";
  b.engine.failure = { reason: "required_decision_pending", decision: terminal("yesno") };
  const record = recordFor(b);
  assert.equal(record.summary.status, "部分复现");
  const text = engineReproConciseText(engineReproDigest(record));
  assert.match(text, /询问已出现，但这段连锁尚未处理完/u);
  assert.match(text, /相关处理尚未完成/u);
});
