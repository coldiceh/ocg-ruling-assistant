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
