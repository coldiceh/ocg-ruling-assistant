import test from "node:test";
import assert from "node:assert/strict";
import { ATTRIBUTE_BITS, PLANNER_INSTRUCTIONS, RACE_BITS } from "../backend/engineRepro/plannerPrompt.mjs";
import { collectCodes } from "../backend/engineRepro/reproduce.mjs";

// The engine harness accepts these four declaration decisions with choose.value
// (ocg-sim-core ocgrepro/harness.py, docs/ENGINE_INTERFACE.md); the planner must be told about them,
// otherwise a question that needs a declaration (e.g. naming a card) is reported as unrepresentable.
test("planner prompt documents the declaration steps and their values", () => {
  for (const kind of ["announce_card", "announce_number", "announce_attrib", "announce_race"]) {
    assert.ok(PLANNER_INSTRUCTIONS.includes(kind), kind);
  }
  assert.match(PLANNER_INSTRUCTIONS, /announce_card（宣言卡名）：\{"value":卡号\}/u);
  assert.match(PLANNER_INSTRUCTIONS, /需要宣言不是搭不出局面的理由/u);
  // decision order measured on the pinned engine (core 3209cd8, scripts b83db1c, database 09bf7de), 2026-10-18
  assert.match(PLANNER_INSTRUCTIONS, /抹杀之指名者）：idle activate → select_place\(自己 szone 空位\) → announce_card → 双方连锁窗口/u);
  assert.match(PLANNER_INSTRUCTIONS, /选选项、宣言、其他是否询问/u, "a declaration cannot be declined");
  assert.match(PLANNER_INSTRUCTIONS, /属性：地1 水2 炎4 风8 光16 暗32 神64。/u);
  assert.match(PLANNER_INSTRUCTIONS, /种族：战士1 魔法师2 .* 电子界16777216 幻想魔33554432。/u);
});

// ocg-sim-core "at" (harness step / probe filter, schema enum; frozen test P08). Needs an engine
// build with battle timings: this prompt must not ship before that engine is deployed.
test("planner prompt documents battle timings for steps and probes", () => {
  for (const at of ["attack_declaration", "damage_step_start", "before_damage_calc", "damage_calc", "after_damage_calc",
    "damage_step_end"]) assert.ok(PLANNER_INSTRUCTIONS.includes(at), at);
  assert.match(PLANNER_INSTRUCTIONS, /"at":"可选：战斗时点","note"/u);
  assert.match(PLANNER_INSTRUCTIONS, /"target":\{"card":卡号,"cmd":"可选","desc":可选\},"at":"可选：战斗时点"\}/u);
  assert.match(PLANNER_INSTRUCTIONS, /不写 at 就在第一个出现它的窗口匹配/u);
  // the attack declaration window itself (MSG_ATTACK, before HINT_EVENT 24) is attack_declaration (engine P09)
  assert.match(PLANNER_INSTRUCTIONS, /attack_declaration（攻击宣言时：攻击宣言之后、进入伤害步骤之前的窗口/u);
  assert.doesNotMatch(PLANNER_INSTRUCTIONS, /前置状态搭不出来（处于伤害步骤中/u);
});

test("declaration bit values are the engine's ATTRIBUTE / RACE flags", () => {
  // Copied from ocg-sim-core ocgrepro/service.py (ATTRIBUTE, RACE).
  const attribute = { 0x1: "地", 0x2: "水", 0x4: "炎", 0x8: "风", 0x10: "光", 0x20: "暗", 0x40: "神" };
  const race = { 0x1: "战士", 0x2: "魔法师", 0x4: "天使", 0x8: "恶魔", 0x10: "不死", 0x20: "机械", 0x40: "水", 0x80: "炎",
    0x100: "岩石", 0x200: "鸟兽", 0x400: "植物", 0x800: "昆虫", 0x1000: "雷", 0x2000: "龙", 0x4000: "兽",
    0x8000: "兽战士", 0x10000: "恐龙", 0x20000: "鱼", 0x40000: "海龙", 0x80000: "爬虫类", 0x100000: "念动力",
    0x200000: "幻神兽", 0x400000: "创造神", 0x800000: "幻龙", 0x1000000: "电子界", 0x2000000: "幻想魔" };
  assert.deepEqual(Object.fromEntries(ATTRIBUTE_BITS.map(([name, bit]) => [bit, name])), attribute);
  assert.deepEqual(Object.fromEntries(RACE_BITS.map(([name, bit]) => [bit, name])), race);
});

test("a declared card is checked like every other card number; declared numbers and bits are not cards", () => {
  const actions = { setup: [
    { player: 0, decision: "idle", choose: { cmd: "activate", card: 65681983, from: "hand" } },
    { player: 0, decision: "announce_card", choose: { value: 22702055 } },
    { player: 0, decision: "announce_number", choose: { value: 4 } },
    { player: 0, decision: "announce_race", choose: { value: 0x2000 } },
    { player: 0, decision: "announce_attrib", choose: { value: 0x10 } },
  ] };
  assert.deepEqual(collectCodes({ players: [] }, actions), [65681983, 22702055]);
});

test("the repair round sees the battle timing and the engine's detail of a failed decision", async () => {
  const { runEngineReproduction } = await import("../backend/engineRepro/reproduce.mjs");
  const plan = { applicability: "applicable", reason_code: null, archetype_name: null, quoted_span: "q", what_not_why: false,
    assumptions: [], extra_cards: [], sub_questions: [{ id: "q1", quoted_span: "q", unrepresentable: null, branches: [{
      id: "b1", assumption: null, observe: "x", scenario: { first_player: 0, players: [{ hand: [14558127] }, {}] },
      actions: { setup: [{ player: 0, decision: "chain", choose: { card: 14558127 }, at: "damage_calc" }] } }] }] };
  const detail = "step restricted to at=damage_calc; battle timings of the decisions seen while it was pending: damage_step_start";
  const engine = async (op, body) => {
    if (op === "cards") return { cards: (body.codes || []).map((code) => ({ code, exists: true, name: "灰流丽", types: ["怪兽"] })) };
    if (op === "related") return { related: [] };
    if (op === "reproduce") return { result: { status: "not_reproduced", reason_code: "action_mismatch", scenario: body.scenario,
      failure: { reason: "not_found", step: 0, step_spec: body.actions.setup[0], detail,
        decision: { kind: "battle", player: 0, phase: "battle_start", timing: null, turn: 1, options: [] } },
      decisions: [{ decision: { kind: "chain", player: 0, phase: "battle_start", timing: { id: 40, at: "damage_step_start" } } }] } };
    throw new Error(op);
  };
  const inputs = [];
  const modelCall = async ({ input }) => { inputs.push(input); return { status: "completed", outputText: JSON.stringify(plan), usage: {} }; };
  await runEngineReproduction({ question: "q", identity: { resolved: [{ cid: "12950", mentionedAs: ["灰流丽"], resolutionSources: [] }],
    unresolved: [], groupMentions: [] }, cardsById: new Map([["12950", { id: "12950", name: "灰流丽", effectText: "t" }]]),
    cidMap: { 12950: 14558127 }, engine, modelCall, clock: () => 0 });
  assert.ok(inputs.length >= 2, "a repair round ran");
  assert.ok(inputs[1].includes(detail), "the engine's detail reaches the repair round");
  // a failed decision with a battle timing carries it; this one (the battle command) has none
  const engineWithTiming = async (op, body) => {
    const result = await engine(op, body);
    if (op === "reproduce") result.result.failure.decision.timing = { id: 41, text: "伤害计算前", at: "before_damage_calc" };
    return result;
  };
  const withTiming = [];
  await runEngineReproduction({ question: "q", identity: { resolved: [{ cid: "12950", mentionedAs: ["灰流丽"], resolutionSources: [] }],
    unresolved: [], groupMentions: [] }, cardsById: new Map([["12950", { id: "12950", name: "灰流丽", effectText: "t" }]]),
    cidMap: { 12950: 14558127 }, engine: engineWithTiming, clock: () => 0,
    modelCall: async ({ input }) => { withTiming.push(input); return { status: "completed", outputText: JSON.stringify(plan), usage: {} }; } });
  assert.match(withTiming[1], /"timing":"before_damage_calc"/u);
  assert.doesNotMatch(inputs[1], /"timing":/u);
  // a failed declaration carries what could be declared
  const declaring = (decision) => async (op, body) => {
    const result = await engine(op, body);
    if (op === "reproduce") result.result.failure.decision = decision;
    return result;
  };
  const repairInputs = async (decision) => {
    const seen = [];
    await runEngineReproduction({ question: "q", identity: { resolved: [{ cid: "12950", mentionedAs: ["灰流丽"], resolutionSources: [] }],
      unresolved: [], groupMentions: [] }, cardsById: new Map([["12950", { id: "12950", name: "灰流丽", effectText: "t" }]]),
      cidMap: { 12950: 14558127 }, engine: declaring(decision), clock: () => 0,
      modelCall: async ({ input }) => { seen.push(input); return { status: "completed", outputText: JSON.stringify(plan), usage: {} }; } });
    return seen[1];
  };
  assert.match(await repairInputs({ kind: "announce_number", player: 0, phase: "main1", turn: 1, options: [], values: [3, 2, 1] }),
    /"values":\[3,2,1\]/u);
  const race = await repairInputs({ kind: "announce_race", player: 0, phase: "main1", turn: 1, options: [], available: 0x3, count: 1 });
  assert.match(race, /"available":3,"count":1/u);
  assert.doesNotMatch(await repairInputs({ kind: "announce_card", player: 0, phase: "main1", turn: 1, options: [], values: [1073741826] }),
    /"values":/u, "announce_card values are filter opcodes, not candidates");
});
