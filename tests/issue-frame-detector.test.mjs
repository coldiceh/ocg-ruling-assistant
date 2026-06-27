import assert from "node:assert/strict";
import test from "node:test";
import { detectIssueFrames, issueFrameIds } from "../backend/issueFrameDetector.mjs";

const failureQuestion = `自己场上的「霸王眷龙 凶饿毒」得到另一只怪兽的原本卡名和效果。这个回合，自己怪兽向守备表示怪兽攻击时给予贯穿战斗伤害。自己场上的「混绝狱神 比托利姆」攻击时会造成贯穿伤害吗？场上的这张卡不受「狱神」怪兽以外的怪兽效果影响。`;

test("real failure case detects only the relevant ruling issues", () => {
  const result = detectIssueFrames({ question: failureQuestion });
  const ids = issueFrameIds(result);
  for (const expected of ["copy_or_gain_effect", "piercing_battle_damage", "unaffected_by_effect", "continuous_effect_application"]) assert.ok(ids.includes(expected), expected);
  assert.ok(!ids.includes("xyz_material_attach"));
  assert.ok(!ids.includes("no_41_chain"));
  assert.ok(!ids.includes("defense_position_attack"));
});
