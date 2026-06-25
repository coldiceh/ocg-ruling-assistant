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
