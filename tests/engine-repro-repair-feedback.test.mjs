import assert from "node:assert/strict";
import test from "node:test";
import { compactFailure, DEFAULT_PLANNER, replayExcerpt, runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { estimateTokens } from "../backend/engineRepro/modelCalls.mjs";

const CARD = 14558127;
const sq = { id: "q1" };
const setup = [{ player: 0, decision: "idle", choose: { cmd: "to_end" } }];
const decision = { kind: "select_place", player: 1, phase: "end", turn: 1,
  options: [{ place: { player: 1, zone: "mzone", seq: 0 } }, { place: { player: 1, zone: "mzone", seq: 4 } }] };
const replay = ["过程：", ...Array.from({ length: 800 }, (_, i) => `第${i}项实际事件：这段过程只作为回放证据保留。`)].join("\n");
const tokens = ({ replay: text = "", ...diagnostic }) => estimateTokens(`${JSON.stringify(diagnostic)}\n${text}`);
const serialized = (value) => JSON.parse(JSON.stringify(value));
const oldDecision = { kind: "select_place", player: 1, phase: "end", turn: 1, hint: null,
  options: decision.options };

test("required choice feedback trades replay space for exact probe identity and authoritative progress", () => {
  const probe = { index: 0, after: 1, player: 1, decision_kind: "yesno", target: { card: CARD, desc: 123, from: "mzone", seq: 0 },
    at: "damage_step_end", until: "chain_end", result: "not_reached", windows: [], interval: { end: "chain_end", completed: false } };
  const branch = { id: "bad", actions: { setup }, engine: { status: "not_reproduced", reason_code: "action_mismatch",
    setup_consumed: 1, failure: { reason: "required_decision_pending", step: 1, step_spec: null, decision },
    probes: [probe], rendered_zh: replay, state: { private_detail: "NOT_FEEDBACK_STATE" }, log: ["NOT_FEEDBACK_LOG"] } };
  const original = structuredClone(branch);
  // Frozen pre-change projection for this fixture; the whole old replay allowance is counted.
  const before = { sub_question: "q1", branch: "bad", reason_code: "action_mismatch",
    failure: { reason: "required_decision_pending", step: 1, step_spec: null }, decision: oldDecision,
    probes: [{ result: "not_reached" }], replay: replayExcerpt(replay) };
  const result = compactFailure(sq, branch);
  assert.equal(result.failure.reason, "required_decision_pending");
  assert.equal(result.failure.step_spec, null);
  assert.deepEqual(serialized(result.decision.options), decision.options);
  assert.deepEqual(result.progress, { setup_consumed: 1, setup_total: 1, next_step: 1 });
  assert.deepEqual(result.probes[0].target, probe.target);
  assert.deepEqual(result.probes[0].interval, probe.interval);
  assert.equal(result.probes[0].until, "chain_end");
  assert.equal(result.probes[0].at, "damage_step_end");
  assert.ok(tokens(result) <= tokens(before), `${tokens(result)} exceeds old ${tokens(before)}`);
  assert.ok(result.replay.startsWith("过程：") && result.replay.endsWith("第799项实际事件：这段过程只作为回放证据保留。"));
  assert.doesNotMatch(JSON.stringify(result), /NOT_FEEDBACK|"windows"/u);
  assert.deepEqual(branch, original, "feedback packing must not mutate replay evidence");
});

test("optional progress is omitted when a short legacy diagnostic has no replay space", () => {
  const branch = { id: "bad", actions: { setup }, engine: { status: "not_reproduced", reason_code: "action_mismatch",
    setup_consumed: 1, failure: { reason: "required_decision_pending", step: 1, step_spec: null, decision } } };
  const before = { sub_question: "q1", branch: "bad", reason_code: "action_mismatch",
    failure: { reason: "required_decision_pending", step: 1, step_spec: null }, decision: oldDecision };
  const result = compactFailure(sq, branch);
  assert.equal(result.progress, undefined);
  assert.deepEqual(serialized(result.decision.options), decision.options);
  assert.equal(tokens(result), tokens(before));
});

test("engine choice context replaces replay bytes within the unchanged legacy feedback allowance", () => {
  const attempted = { player: 0, decision: "select_card", choose: { cards: [{ card: CARD, from: "grave" }] } };
  const actual = { ...decision, player: 0, phase: "main1", in_activation: false, in_resolution: true,
    chain_links: 0, count: 1, min: 1, max: 1, hint: { player: 0, hint_type: 3, id: CARD, text: null },
    unrelated: { secret: "NOT_FEEDBACK_CONTEXT" } };
  const branch = { id: "bad", actions: { setup: [attempted] }, engine: {
    status: "not_reproduced", reason_code: "action_mismatch", setup_consumed: 0,
    failure: { reason: "not_found", step: 0, step_spec: attempted, decision: actual }, rendered_zh: replay } };
  // Frozen old projection: adding engine metadata must not enlarge this allowance.
  const before = { sub_question: "q1", branch: "bad", reason_code: "action_mismatch",
    failure: { reason: "not_found", step: 0, step_spec: attempted },
    decision: { ...oldDecision, player: 0, phase: "main1" }, replay: replayExcerpt(replay) };
  const original = structuredClone(branch);
  const result = compactFailure(sq, branch);
  assert.deepEqual(Object.fromEntries(["in_activation", "in_resolution", "chain_links", "count", "min", "max",
    "hint_player", "hint_type", "hint_id"].map(key => [key, result.decision[key]])), {
    in_activation: false, in_resolution: true, chain_links: 0, count: 1, min: 1, max: 1,
    hint_player: 0, hint_type: 3, hint_id: CARD,
  });
  assert.equal(result.failure.step_spec.decision, "select_card");
  assert.equal(result.decision.kind, "select_place", "feedback preserves the disagreement; it does not select an answer");
  assert.deepEqual(serialized(result.decision.options), decision.options);
  assert.ok(tokens(result) <= tokens(before));
  assert.ok(result.replay.length < before.replay.length, "context spends the old replay allowance");
  assert.doesNotMatch(JSON.stringify(result), /NOT_FEEDBACK_CONTEXT/u);
  assert.deepEqual(branch, original);
});

test("extra choice context cannot silently enlarge a diagnostic with no replay allowance", () => {
  const actual = { ...decision, in_activation: false, in_resolution: true, chain_links: 0,
    count: 1, min: 1, max: 1, hint: { player: 1, hint_type: 3, id: CARD, text: null } };
  const branch = { id: "bad", actions: { setup }, engine: { status: "not_reproduced", reason_code: "action_mismatch",
    failure: { reason: "not_found", step: 0, step_spec: setup[0], decision: actual } } };
  const before = { sub_question: "q1", branch: "bad", reason_code: "action_mismatch",
    failure: { reason: "not_found", step: 0, step_spec: setup[0] }, decision: oldDecision };
  const result = compactFailure(sq, branch);
  assert.equal(tokens(result), tokens(before));
  assert.deepEqual(serialized(result.decision), oldDecision);
  assert.equal(result.replay, undefined);
});

test("MSG_RETRY retains the attempted step and its actual decision without raw response bytes", () => {
  const attempted = { player: 1, decision: "select_place", choose: { place: { player: 1, zone: "mzone", seq: 2 } } };
  const branch = { id: "bad", actions: { setup: [attempted] }, engine: { status: "not_reproduced", reason_code: "action_mismatch",
    setup_consumed: 1, failure: { reason: "engine_rejected_response", message: "retry",
      last_decision: { by: "setup", step: 0, decision, choice: "RAW_RESPONSE_SENTINEL" },
      last_response: ["RAW_RESPONSE_SENTINEL"] } } };
  const result = compactFailure(sq, branch);
  assert.equal(result.failure.reason, "engine_rejected_response");
  assert.equal(result.failure.step, 0);
  assert.deepEqual(result.failure.step_spec, attempted);
  assert.deepEqual(serialized(result.decision.options), decision.options);
  assert.equal(result.progress, undefined, "no budget for optional progress in a legacy reason-only failure");
  assert.doesNotMatch(JSON.stringify(result), /RAW_RESPONSE_SENTINEL|last_response/u);
});

test("an unfinished interval is tied to the precise probe even when the old status says replayed", () => {
  const probe = { index: 0, after: 1, player: 0, decision_kind: "yesno", target: { card: CARD, desc: 123 },
    result: "present", interval: { end: "chain_end", completed: false }, windows: [] };
  const result = compactFailure(sq, { id: "bad", actions: { setup }, engine: { status: "replayed", reason_code: null,
    failure: null, probes: [probe], setup_consumed: 1, rendered_zh: replay } });
  assert.equal(result.reason_code, "action_mismatch");
  assert.equal(result.failure.reason, "probe_interval_incomplete");
  assert.deepEqual(result.failure.probes, [0]);
  assert.equal(result.probes[0].result, "present", "do not rewrite an actual positive observation as an absence");
  assert.deepEqual(result.probes[0].target, probe.target);
  assert.equal(result.probes[0].interval.completed, false);
});

test("legacy replayed-at-required-choice results reach the same repair diagnostic", () => {
  const result = compactFailure(sq, { id: "bad", actions: { setup }, engine: { status: "replayed", reason_code: null,
    failure: null, probes: [], decisions: [{ by: "end", decision }] } });
  assert.equal(result.reason_code, "action_mismatch");
  assert.equal(result.failure.reason, "required_decision_pending");
  assert.equal(result.failure.step, setup.length);
  assert.equal(result.decision.kind, "select_place");
});

test("a rejected legacy completion gets one repair; a good branch is preserved and budgets do not change", async () => {
  const makeBranch = (id, firstPlayer) => ({ id, scenario: { first_player: firstPlayer, players: [{ hand: [CARD] }, {}] },
    actions: { setup: [] }, observe: "测试结果" });
  const bad = makeBranch("bad", 0), good = makeBranch("good", 1);
  const initial = { applicability: "applicable", reason_code: null, what_not_why: false, assumptions: [], extra_cards: [],
    sub_questions: [{ id: "q1", quoted_span: "测试问题", unrepresentable: null, branches: [bad, good] }] };
  const fix = { extra_cards: [], sub_questions: [{ id: "q1", branches: [bad, good] }] };
  const modelCalls = [], replays = [];
  const engine = async (op, body) => {
    if (op === "cards") return { cards: body.codes.map((code) => ({ code, exists: true, name: "灰流丽", types: ["怪兽"], text: "测试卡文" })) };
    if (op === "related") return { related: [] };
    if (op !== "reproduce") throw new Error(`unexpected engine op ${op}`);
    replays.push(body.scenario.first_player);
    return { result: { status: "replayed", reason_code: null, failure: null, probes: [],
      decisions: body.scenario.first_player === 0 ? [{ by: "end", decision }]
        : [{ by: "end", decision: { kind: "idle", player: 1, phase: "main1", chain_links: 0 } }],
      rendered_zh: "" } };
  };
  const record = await runEngineReproduction({ question: "测试问题", identity: { resolved: [{ cid: "12950" }], unresolved: [], groupMentions: [] },
    cardsById: new Map([["12950", { effectText: "测试卡文" }]]), cidMap: { 12950: CARD }, engine,
    modelCall: async (opts) => {
      modelCalls.push(opts);
      return { status: "completed", outputText: JSON.stringify(modelCalls.length === 1 ? initial : fix), usage: {} };
    } });
  assert.deepEqual(modelCalls.map((c) => c.stage), ["plan", "repair"]);
  assert.ok(modelCalls.every((c) => c.maxInputTokens === DEFAULT_PLANNER.maxInput && c.maxOutputTokens === DEFAULT_PLANNER.maxOutput));
  assert.equal(replays.filter((p) => p === 0).length, 2);
  assert.equal(replays.filter((p) => p === 1).length, 1, "repair cannot rerun an already accepted branch");
  assert.match(modelCalls[1].input, /required_decision_pending/u);
  assert.equal(record.planRaw.length, 2);
  assert.equal(record.subQuestions[0].branches[0].repaired, true);
  assert.equal(record.summary.status, "部分复现");
});
