import assert from "node:assert/strict";
import test from "node:test";
import { buildDamageStepAnalysis } from "../backend/damageStepRules.mjs";

test("damage_step_requires_subphase_when_ambiguous", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害步骤中能发动这个效果吗？" });
  assert.equal(analysis.isDamageStep, true);
  assert.equal(analysis.subphase, "unknown_damage_step_timing");
  assert.equal(analysis.verdict, "insufficient_info");
  assert.equal(analysis.confirmationLevel, "insufficient_info");
});

test("generic_quick_effect_blocked_in_damage_step_without_permission", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害步骤中能发动吗？", effectText: "快速效果：可以发动。" });
  assert.equal(analysis.effectCategory, "generic_quick_effect_without_damage_step_permission");
  assert.equal(analysis.allowedInDamageStep, false);
  assert.equal(analysis.verdict, "activation_illegal_or_unsupported_in_damage_step");
  assert.notEqual(analysis.confirmationLevel, "official_confirmed");
});

test("atk_def_modifier_allowed_before_damage_calculation", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害计算前能发动吗？", effectText: "使1只怪兽的攻击力上升1000。" });
  assert.equal(analysis.subphase, "before_damage_calculation");
  assert.equal(analysis.effectCategory, "modify_atk_def");
  assert.equal(analysis.allowedInDamageStep, true);
  assert.equal(analysis.confirmationLevel, "rule_derived");
});

test("negate_activation_allowed_category_in_damage_step", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害步骤中能发动吗？", effectText: "那个发动无效并破坏。" });
  assert.equal(analysis.effectCategory, "negate_activation");
  assert.equal(analysis.allowedInDamageStep, true);
  assert.equal(analysis.verdict, "continue_activation_check");
});

test("damage_step_unknown_category_needs_direct_evidence", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害计算后能发动这个效果吗？", effectText: "这个效果可以发动。" });
  assert.equal(analysis.effectCategory, "unknown");
  assert.equal(analysis.verdict, "insufficient_info");
  assert.ok(analysis.missingInfo.some((item) => /官方文本|官方 Q&A/u.test(item)));
});

test("no_unsafe_confirmed_damage_step", () => {
  const analysis = buildDamageStepAnalysis({ question: "伤害步骤中能发动吗？", effectText: "快速效果：可以发动。" });
  assert.notEqual(analysis.confirmationLevel, "official_confirmed");
  assert.deepEqual(analysis.evidenceIds, []);
});
