import assert from "node:assert/strict";
import test from "node:test";
import { classifyEvidenceQuestionTypes } from "../backend/evidenceQuestionTypeClassifier.mjs";
import { classifyQaForSubQuestion } from "../backend/engine.mjs";

test("Triple Tactics Talent FAQ is direct for its activation condition", () => {
  const result = classifyQaForSubQuestion({
    id: "q1",
    type: "activation_condition",
    card: "三战之才",
    askedResult: "can_activate",
    sourceText: "对方在我的主要阶段发动过怪兽效果后，我能否发动三战之才？",
  }, {
    id: "card-faq-15296-1",
    recordType: "card-faq",
    title: "三战之才 FAQ 1",
    cards: ["三战之才"],
    conclusion: "【①の効果について】このターンの自分メインフェイズに相手がモンスターの効果を発動し、その発動が無効にならなかった場合に、このカードを発動できる条件が満たされます。",
  });

  assert.equal(result.match, "direct");
  assert.equal(result.extractedVerdict, "can");
  assert.ok(classifyEvidenceQuestionTypes("【①の効果について】このターンの自分メインフェイズに相手がモンスターの効果を発動し、その発動が無効にならなかった場合に、このカードを発動できる条件が満たされます。").questionTypes.includes("activation_condition"));
});

test("Ohime damage-step FAQ is direct only when the asked effect number matches", () => {
  const faq = {
    id: "card-faq-18017-3",
    recordType: "card-faq",
    title: "大日女之御巫 FAQ 3",
    cards: ["大日女之御巫"],
    conclusion: "【③の効果について】モンスターゾーンで発動できる誘発即時効果です。ダメージステップには発動できません。",
  };
  const matchingEffect = classifyQaForSubQuestion({
    id: "q1",
    type: "activation_condition",
    card: "大日女之御巫",
    askedResult: "can_activate",
    sourceText: "大日女之御巫的③效果能否在伤害步骤发动？",
  }, faq);
  assert.equal(matchingEffect.match, "direct");
  assert.equal(matchingEffect.extractedVerdict, "cannot");

  const wrongEffect = classifyQaForSubQuestion({
    id: "q1",
    type: "activation_condition",
    card: "大日女之御巫",
    askedResult: "can_activate",
    sourceText: "大日女之御巫的①效果能否在伤害步骤发动？",
  }, faq);
  assert.notEqual(wrongEffect.match, "direct");
  assert.equal(wrongEffect.reason, "effect_number_mismatch");
});

test("generic Perfect Toon World FAQ is not direct for a battle-destroyed toon monster", () => {
  const result = classifyQaForSubQuestion({
    id: "q1",
    type: "temporary_banish",
    card: "完美世界-卡通世界",
    askedResult: "can_banish_that_toon_monster",
    sourceText: "伤害计算后已经确定会被战斗破坏的卡通怪兽，能用完美世界-卡通世界的③效果暂时除外到效果处理后吗？",
  }, {
    id: "card-faq-23161-3",
    recordType: "card-faq",
    title: "完全なる世界 トゥーン・ワールド FAQ 3",
    cards: ["完美世界-卡通世界"],
    conclusion: "【③の効果について】このカード以外のカードの効果が発動した効果のチェーンブロックの処理時に自分のモンスターゾーンに表側表示で存在するトゥーンモンスターを、その効果処理後まで除外できます。ダメージステップ中でも適用できます。",
  });

  assert.notEqual(result.match, "direct");
  assert.equal(result.reason, "asked_result_not_covered");
  assert.ok(classifyEvidenceQuestionTypes("【③の効果について】このカード以外のカードの効果が発動した効果のチェーンブロックの処理時に自分のモンスターゾーンに表側表示で存在するトゥーンモンスターを、その効果処理後まで除外できます。ダメージステップ中でも適用できます。").questionTypes.includes("temporary_banish"));
});

test("battle-destruction-specific Perfect Toon World evidence can be direct", () => {
  const result = classifyQaForSubQuestion({
    id: "q1",
    type: "temporary_banish",
    card: "完美世界-卡通世界",
    askedResult: "can_banish_that_toon_monster",
    sourceText: "伤害计算后已经确定会被战斗破坏的卡通怪兽，能用完美世界-卡通世界的③效果暂时除外到效果处理后吗？",
  }, {
    id: "qa-perfect-toon-specific",
    recordType: "qa",
    title: "Perfect Toon World battle-destroyed monster ruling",
    cards: ["完美世界-卡通世界"],
    question: "A Toon monster has been determined to be destroyed by battle after damage calculation. Can Perfect Toon World's ③ effect temporarily banish that Toon monster until after the effect resolves?",
    conclusion: "Yes, the ③ effect can temporarily banish that Toon monster until after that effect resolves.",
  });

  assert.equal(result.match, "direct");
  assert.ok(["can", "banished_temporarily"].includes(result.extractedVerdict));
});
