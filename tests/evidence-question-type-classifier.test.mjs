import assert from "node:assert/strict";
import test from "node:test";
import { classifyEvidenceQuestionTypes } from "../backend/evidenceQuestionTypeClassifier.mjs";

test("Japanese damage-step activation question detects activation and damage-step timing", () => {
  const result = classifyEvidenceQuestionTypes("ダメージステップでも発動できますか？");
  assert.ok(result.questionTypes.includes("activation_condition"));
  assert.ok(result.questionTypes.includes("damage_step_activation"));
  assert.ok(result.timing.includes("damage_step"));
  assert.equal(result.polarity, "can");
});

test("Japanese effect applicability phrase detects effect_applicability", () => {
  const result = classifyEvidenceQuestionTypes("この効果を適用できますか？");
  assert.ok(result.questionTypes.includes("effect_applicability"));
  assert.ok(result.actions.includes("apply"));
});

test("Japanese banish phrase detects temporary_banish", () => {
  const result = classifyEvidenceQuestionTypes("このモンスターを除外できますか？");
  assert.ok(result.questionTypes.includes("temporary_banish"));
  assert.ok(result.questionTypes.includes("banish_applicability"));
  assert.ok(result.actions.includes("banish"));
});

test("English damage-step activation phrase detects activation and timing", () => {
  const result = classifyEvidenceQuestionTypes("This effect can be activated during the Damage Step.");
  assert.ok(result.questionTypes.includes("activation_condition"));
  assert.ok(result.questionTypes.includes("damage_step_activation"));
  assert.ok(result.timing.includes("damage_step"));
  assert.equal(result.polarity, "can");
});

test("activation-location phrases detect activation_location", () => {
  const japanese = classifyEvidenceQuestionTypes("戦闘で破壊され墓地へ送られた場合には墓地で発動できます。除外状態で発動できます。");
  assert.ok(japanese.questionTypes.includes("activation_location"));
  assert.ok(japanese.zones.includes("graveyard"));
  assert.ok(japanese.zones.includes("banished"));

  const english = classifyEvidenceQuestionTypes("This effect can be activated in the Graveyard or while banished.");
  assert.ok(english.questionTypes.includes("activation_location"));
});

test("Chinese effect-applicability banish phrase detects temporary banish and applicability", () => {
  const result = classifyEvidenceQuestionTypes("可以适用这个效果把怪兽一时除外吗？");
  assert.ok(result.questionTypes.includes("temporary_banish"));
  assert.ok(result.questionTypes.includes("effect_applicability"));
  assert.ok(result.actions.includes("banish"));
  assert.ok(result.actions.includes("apply"));
});

test("negative activation phrases keep cannot polarity", () => {
  for (const text of ["発動できません", "cannot be activated", "不能发动"]) {
    const result = classifyEvidenceQuestionTypes(text);
    assert.ok(result.questionTypes.includes("activation_condition"));
    assert.equal(result.polarity, "cannot");
  }
});

test("battle outcome wording detects battle resolution without requiring a fixed phrase order", () => {
  const result = classifyEvidenceQuestionTypes(
    "分别用两只怪兽攻击里侧守备表示的怪兽，各自能否由战斗或怪兽效果破坏它？",
  );
  assert.ok(result.questionTypes.includes("battle_resolution"));
  assert.ok(result.questionTypes.includes("face_down_flip_before_damage_calculation"));
  assert.ok(result.actions.includes("attack"));
});

test("position changes during battle request an attack-continuation recheck", () => {
  const result = classifyEvidenceQuestionTypes(
    "攻击怪兽在伤害计算前变成守备表示后，这次攻击能否继续？",
  );
  assert.ok(result.questionTypes.includes("battle_resolution"));
  assert.ok(result.questionTypes.includes("attack_continuation_after_position_change"));
  assert.ok(result.timing.includes("before_damage_calculation"));
});

test("activated-effect negation remains distinct from continuous effects", () => {
  const result = classifyEvidenceQuestionTypes(
    "无效守备表示怪兽发动的效果，是否也会使其永续效果无效？",
  );
  assert.ok(result.questionTypes.includes("activated_vs_continuous_effect"));
});

test("battle-phase end timing is not misclassified as damage-step battle resolution", () => {
  for (const text of [
    "战斗阶段结束时可以发动这个效果吗？",
    "Can this effect be activated at the end of the Battle Phase?",
    "バトルフェイズ終了時にこの効果を発動できますか？",
  ]) {
    const result = classifyEvidenceQuestionTypes(text);
    assert.ok(result.questionTypes.includes("activation_condition"));
    assert.ok(!result.questionTypes.includes("battle_resolution"));
  }

  assert.ok(classifyEvidenceQuestionTypes("Will this attack continue after its position changes?")
    .questionTypes.includes("battle_resolution"));
});
