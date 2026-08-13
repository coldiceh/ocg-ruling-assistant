import assert from "node:assert/strict";
import test from "node:test";

import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";
import { findNormalizedSemantics, normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { resolveUniqueEntityFragment } from "../backend/scenarioEntityResolver.mjs";

function fixture(names = {
  material: "混沌的黑魔术师",
  summoned: "毁灭的黑魔术师",
  hand: "深渊的相剑龙",
}, { replacement = true, history = true } = {}) {
  const question = [
    `自己场上表侧表示存在「${names.material}」，手牌中有「${names.hand}」。${history ? "本回合，自己已经发动过魔法卡的效果。" : ""}`,
    `是否可以将「${names.material}」除外，从额外卡组特殊召唤「${names.summoned}」？`,
    `如果可以特殊召唤，那么之后是否还可以发动手牌中「${names.hand}」的效果？`,
  ].join("\n");
  return {
    userQuery: question,
    cardTexts: [{
      id: "card-text-source",
      cardIds: ["source"],
      cards: [names.material],
      name: names.material,
      cardType: "monster",
      level: 8,
      race: "魔法师族",
      attribute: "暗属性",
      text: replacement
        ? "③：表侧表示的此卡离开场上的情况下，将其除外。"
        : "③：此卡战斗破坏怪兽的场合可以发动。抽1张卡。",
    }, {
      id: "card-text-summoned",
      cardIds: ["summoned"],
      cards: [names.summoned],
      name: names.summoned,
      cardType: "fusion monster",
      text: [
        `“${names.summoned}”1回合1次，仅可通过融合召唤及以下方法特殊召唤。`,
        "●在发动了魔法卡的效果的回合，将自己场上的1只等级6以上的魔法师族・暗属性怪兽除外的情况下，可从额外牌组特殊召唤。",
        "②：此卡特殊召唤的情况下可以发动。从牌组将1张卡加入手牌。",
      ].join("\n"),
    }, {
      id: "card-text-hand",
      cardIds: ["hand"],
      cards: [names.hand],
      name: names.hand,
      cardType: "monster",
      text: "①：此卡存在于手牌・墓地，且有怪兽因卡的效果被除外的情况下可以发动。将此卡特殊召唤。",
    }],
  };
}

test("executes the summon procedure, replacement attribution, and public-C1/private-C2 order", () => {
  const result = analyzeEffectStateTransition(fixture());
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.activation, "legal");
  assert.equal(result.trace[1].proof.originalCauseKind, "summon_procedure");
  assert.equal(result.trace[1].proof.finalDestinationCauseKind, "card_effect");
  assert.equal(result.trace[1].proof.banishedByCardEffect, true);
  assert.deepEqual(
    result.simultaneousTriggerChain.exampleAfterOpponentPass.chainLinks.map((link) => [link.id, link.sourceZone]),
    [["C1", "monster_zone"], ["C2", "hand"]],
  );
  assert.match(result.shortAnswer, /先声明.*C1.*对方.*不连锁.*手牌.*C2/u);
  assert.doesNotMatch(result.shortAnswer, /任意.*顺序|自由.*顺序/u);
});

test("public prompts keep the raw question and card text without the state-transition component", () => {
  const input = fixture();
  const transition = analyzeEffectStateTransition(input);
  const bundle = buildRagRulingPromptBundle({
    userQuery: input.userQuery,
    cardResolution: {
      resolvedCards: input.cardTexts.map((card) => ({
        id: card.cardIds[0],
        name: card.name,
        effectText: card.text,
      })),
    },
    evidence: {
      cardTexts: input.cardTexts,
      semanticStateTransition: transition,
    },
  });

  assert.equal(bundle.recoveryPrompt, "");
  for (const prompt of [bundle.prompt]) {
    assert.match(prompt, /是否可以将/u);
    assert.match(prompt, /深渊的相剑龙/u);
    assert.match(prompt, /card-text-summoned/u);
    assert.match(prompt, /仅可通过融合召唤及以下方法特殊召唤/u);
    assert.doesNotMatch(prompt, /semanticStateTransition/u);
    assert.doesNotMatch(prompt, /finalDestinationCauseKind/u);
    assert.doesNotMatch(prompt, /实际移动及最终归因/u);
    assert.doesNotMatch(prompt, /"stateSnapshot"/u);
  }
});

test("the same mechanism works after every card name is changed", () => {
  const names = { material: "星尘术士", summoned: "终焉秘法师", hand: "焰渊游龙" };
  const result = analyzeEffectStateTransition(fixture(names));
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.trace[1].proof.finalDestinationCauseKind, "card_effect");
  assert.match(result.shortAnswer, /终焉秘法师/u);
  assert.match(result.shortAnswer, /焰渊游龙/u);
  assert.doesNotMatch(JSON.stringify(result), /混沌|黑魔术师|相剑/u);
});

test("reordered wording binds a uniquely introduced former entity without card-name rules", () => {
  const names = { material: "苍穹术士", summoned: "终点观测者", hand: "焰海游龙" };
  const input = fixture(names);
  input.userQuery = [
    "本回合我方曾发动过魔法卡的效果。",
    `场上表侧的「${names.material}」是8星、暗属性、魔法师族；手牌有「${names.hand}」。`,
    `现在把前者除外，能否依照「${names.summoned}」的手续从额外卡组特殊召唤它？成功后诱发效果如何组成连锁？`,
  ].join("");
  const result = analyzeEffectStateTransition(input);
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /苍穹术士.*除外/u);
  assert.match(result.shortAnswer, /C1.*C2/u);
  assert.doesNotMatch(JSON.stringify(result), /混沌|黑魔术师|相剑/u);
});

test("former/latter reference fails closed when more than one antecedent pair is possible", () => {
  const input = fixture({ material: "苍穹术士", summoned: "终点观测者", hand: "焰海游龙" });
  input.cardTexts.push({
    id: "card-text-unrelated",
    cardIds: ["unrelated"],
    cards: ["旁观记录者"],
    name: "旁观记录者",
    cardType: "monster",
    text: "①：此卡被破坏的场合可以发动。抽1张卡。",
  });
  input.userQuery = [
    "本回合我方曾发动过魔法卡的效果。",
    "场上表侧存在「苍穹术士」，手牌有「焰海游龙」，墓地还有「旁观记录者」。",
    "现在把前者除外，能否依照「终点观测者」的手续从额外卡组特殊召唤它？",
  ].join("");
  const result = analyzeEffectStateTransition(input);
  assert.equal(result.complete, false, JSON.stringify(result));
  assert.equal(result.reason, "summon_procedure_material_reference_ambiguous");
});

test("missing turn history fails closed instead of assuming the procedure is legal", () => {
  const result = analyzeEffectStateTransition(fixture(undefined, { history: false }));
  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "spell_effect_turn_history_unknown");
});

test("missing material properties fail closed instead of treating the question as proof", () => {
  const input = fixture();
  delete input.cardTexts[0].level;
  delete input.cardTexts[0].race;
  delete input.cardTexts[0].attribute;
  const result = analyzeEffectStateTransition(input);
  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "procedure_material_properties_unknown");
});

test("Chinese N-star-or-higher text is compiled and rejects a lower-Level material", () => {
  const input = fixture();
  input.cardTexts[0].level = 5;
  input.cardTexts[1].text = input.cardTexts[1].text.replace("等级6以上", "6星以上");
  const normalized = normalizeCardText({
    ...input.cardTexts[1],
    effectText: input.cardTexts[1].text,
  });
  const procedures = findNormalizedSemantics(normalized, "special_summon_procedure");
  assert.equal(procedures[0].semantic.requiredMovements[0].selector.minimumLevel, 6);

  const result = analyzeEffectStateTransition(input);
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "illegal");
  assert.equal(result.reason, "procedure_material_selector_mismatch");
});

test("an explicitly opposing field monster is not re-labelled as the summon player's material", () => {
  const input = fixture();
  input.userQuery = input.userQuery.replace("自己场上表侧表示存在", "对方场上表侧表示存在");
  const result = analyzeEffectStateTransition(input);
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "illegal");
  assert.equal(result.reason, "procedure_material_controller_mismatch");
  assert.equal(result.trace[0].proof.ownership.material.player, "opponent");
});

test("opposing hand or Extra Deck ownership fails closed instead of constructing self-owned instances", () => {
  const opposingHand = fixture();
  opposingHand.userQuery = opposingHand.userQuery.replace("手牌中有", "对方手牌中有");
  const handResult = analyzeEffectStateTransition(opposingHand);
  assert.equal(handResult.complete, false, JSON.stringify(handResult));
  assert.equal(handResult.reason, "hand_trigger_controller_mismatch");

  const opposingExtra = fixture();
  opposingExtra.userQuery = opposingExtra.userQuery.replace("从额外卡组", "从对方额外卡组");
  const extraResult = analyzeEffectStateTransition(opposingExtra);
  assert.equal(extraResult.status, "resolved", JSON.stringify(extraResult));
  assert.equal(extraResult.activation, "illegal");
  assert.equal(extraResult.reason, "procedure_summon_card_owner_mismatch");
});

test("unique fragment binding rejects generic nouns but accepts a grounded prior short form", () => {
  const entities = [{
    id: "saint",
    name: "教导的圣女 艾克莉西亚",
    names: ["教导的圣女 艾克莉西亚"],
  }, {
    id: "dragon",
    name: "吞食圣痕之龙",
    names: ["吞食圣痕之龙"],
  }];
  for (const fragment of ["龙", "圣", "族怪兽", "卡", "手牌"]) {
    assert.equal(resolveUniqueEntityFragment(fragment, entities).status, "unresolved", fragment);
  }
  assert.equal(resolveUniqueEntityFragment("圣女", entities).status, "unresolved");
  const query = "我方手牌有「教导的圣女 艾克莉西亚」。之后丢弃圣女支付COST。";
  const referenceIndex = query.lastIndexOf("圣女");
  const grounded = resolveUniqueEntityFragment("圣女", entities, { query, referenceIndex });
  assert.equal(grounded.status, "bound", JSON.stringify(grounded));
  assert.deepEqual(grounded.entityIds, ["saint"]);
});

test("a procedure-only banish does not manufacture a card-effect banish trigger", () => {
  const result = analyzeEffectStateTransition(fixture(undefined, { replacement: false }));
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.trace[1].proof.originalCauseKind, "summon_procedure");
  assert.equal(result.trace[1].proof.finalDestinationCauseKind, "summon_procedure");
  assert.equal(result.trace[1].proof.banishedByCardEffect, false);
  assert.match(result.shortAnswer, /不能因这次除外发动/u);
});

test("the summon procedure IR also preserves the equivalent current English ordering", () => {
  const normalized = normalizeCardText({
    id: "english-procedure",
    name: "Generic Procedure Monster",
    cardType: "fusion monster",
    effectText: "Must be Fusion Summoned, or Special Summoned (from your Extra Deck) by banishing 1 Level 6 or higher DARK Spellcaster monster you control from your field, during a turn in which a Spell Card effect was activated.",
  });
  const procedures = findNormalizedSemantics(normalized, "special_summon_procedure");
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0].semantic.usesChain, false);
  assert.equal(procedures[0].semantic.requiredMovements[0].selector.minimumLevel, 6);
  assert.equal(procedures[0].semantic.requiredMovements[0].selector.race, "Spellcaster");
  assert.equal(procedures[0].semantic.requiredMovements[0].selector.attribute, "DARK");
  assert.deepEqual(procedures[0].semantic.historyConditions, [{
    type: "spell_card_effect_activated_this_turn",
    player: "controller",
  }]);
});
