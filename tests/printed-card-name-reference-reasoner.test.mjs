import assert from "node:assert/strict";
import test from "node:test";

import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";
import {
  analyzePrintedCardNameReferenceTransition,
  compileImmutablePrintedCardDefinitions,
} from "../backend/printedCardNameReferenceReasoner.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const realCards = [{
  id: "13077",
  name: "霸王眷龙 凶饿猛毒",
  aliases: ["霸王眷龙 凶饿猛毒", "覇王眷竜スターヴ・ヴェノム", "Supreme King Dragon Starving Venom"],
  effectText: "暗属性灵摆怪兽×2\n此卡仅可以融合召唤及以下方法特殊召唤。\n●解放自己场上的上述卡的情况下，可从额外牌组特殊召唤。\n①：1回合1次，以此卡以外的、自己或对手场上・墓地的1只怪兽为对象可以发动。此卡直至结束阶段为止，获得与该怪兽原本卡名・效果相同的卡名・效果。",
}, {
  id: "19842",
  name: "破坏龙 钢多拉G",
  aliases: ["破坏龙 钢多拉G", "破壊竜ガンドラG", "Gandora-G the Dragon of Destruction"],
  effectText: "①：自己场上存在“光之黄金柜”的情况下可以发动。从手牌将此卡特殊召唤。\n③：支付一半LP可以发动。将场上的其他卡全部破坏并除外。然后，从牌组将记载有“光之黄金柜”卡名的1只等级7以下的怪兽特殊召唤。",
}, {
  id: "19892",
  name: "光之黄金柜",
  aliases: ["光之黄金柜", "光の黄金櫃", "Shining Sarcophagus"],
  effectText: "①：此卡只要存在于魔法与陷阱区域，不会因怪兽的效果被破坏。",
}];

const realQuestion = "自己场上有「霸王眷龙 凶饿猛毒」与「光之黄金柜」。该「霸王眷龙 凶饿猛毒」复制了「破坏龙 钢多拉G」的原本卡名和效果。此时它是否成为效果文本框内记载有「光之黄金柜」卡名的怪兽，并可据此发动要求该记载的卡？";

test("quoted text tokens are typed as exact card names, archetypes, or unresolved references", () => {
  const compiled = compileImmutablePrintedCardDefinitions({
    resolvedCards: [{
      id: "receiver",
      name: "文本载体",
      effectText: "记载有“精确场地”卡名的怪兽。也可选择“测试系列”怪兽，但不处理“未绑定称呼”。",
    }, {
      id: "field",
      name: "精确场地",
      aliases: ["精确场地"],
      effectText: "场地效果。",
    }],
  });
  const receiver = compiled.definitions.find((definition) => definition.definitionId === "receiver");
  assert.deepEqual(
    receiver.printedReferences.map((reference) => reference.kind),
    ["exact_card_name", "archetype_or_field_label", "unresolved"],
  );
  assert.equal(receiver.printedReferences[0].definitionId, "field");
  assert.equal(receiver.rawQuotedTokens[0].surface, "精确场地");
});

test("the real copied-effect question resolves from immutable printed text", () => {
  const result = analyzePrintedCardNameReferenceTransition({
    userQuery: realQuestion,
    resolvedCards: realCards,
  });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.condition, "not_satisfied");
  assert.match(result.shortAnswer, /^不能仅凭复制/u);
  assert.match(result.shortAnswer, /卡面原本的效果文本框/u);
  assert.match(result.shortAnswer, /复制不会改写卡面印刷文本/u);
  assert.equal(result.program.verdict.copiedTextCountsAsReceiverPrintedReference, false);
  assert.equal(result.program.runtimeAcquisition.mutatesReceiverPrintedDefinition, false);
  assert.deepEqual(result.program.runtimeAcquisition.acquiredNames.map((item) => item.definitionId), ["19842"]);
  assert.ok(Object.isFrozen(result.program.immutablePrintedDefinitions));
  assert.ok(Object.isFrozen(result.program.immutablePrintedDefinitions.definitions[0].printedReferences));
});

test("a receiver whose own printed text already names the target satisfies the condition", () => {
  const cards = renamedCards({ receiverPrintedReference: true });
  const result = analyzePrintedCardNameReferenceTransition({
    userQuery: renamedQuestion(),
    resolvedCards: cards,
  });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.condition, "satisfied");
  assert.match(result.shortAnswer, /^满足这项卡名记载条件/u);
  assert.match(result.shortAnswer, /但不是因为复制/u);
  assert.equal(result.program.verdict.receiverHasRequiredReference, true);
});

test("renaming every card preserves the copied printed-reference verdict", () => {
  const result = analyzePrintedCardNameReferenceTransition({
    userQuery: renamedQuestion(),
    resolvedCards: renamedCards(),
  });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.condition, "not_satisfied");
  assert.match(result.shortAnswer, /^不能仅凭复制/u);
  assert.doesNotMatch(JSON.stringify(result), /霸王|钢多拉|黄金柜/u);
});

test("a missing required card identity fails closed", () => {
  const result = analyzePrintedCardNameReferenceTransition({
    userQuery: renamedQuestion(),
    resolvedCards: renamedCards().filter((card) => card.id !== "renamed-field"),
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  assert.ok(result.authorityReasons.includes("required_name_identity_unresolved"));
});

test("ambiguous aliases for the required exact name fail closed", () => {
  const cards = renamedCards();
  cards.push({
    id: "ambiguous-field",
    name: "另一实体",
    aliases: ["匿名场地"],
    effectText: "另一张完整卡片文本。",
  });
  const result = analyzePrintedCardNameReferenceTransition({
    userQuery: renamedQuestion(),
    resolvedCards: cards,
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.complete, false);
  assert.ok(result.authorityReasons.some((reason) => /ambiguous/u.test(reason)));
});

test("unresolved receiver printed tokens prevent a negative absence inference", () => {
  const cards = renamedCards();
  cards[0] = {
    ...cards[0],
    effectText: `${cards[0].effectText}\n“未知别名”的卡。`,
  };
  const result = analyzePrintedCardNameReferenceTransition({
    userQuery: renamedQuestion(),
    resolvedCards: cards,
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.complete, false);
  assert.ok(result.authorityReasons.some((reason) => /receiver_printed_reference_unresolved/u.test(reason)));
});

test("analyzeEffectStateTransition routes the real question to the printed-reference executor", () => {
  const result = analyzeEffectStateTransition({
    userQuery: realQuestion,
    resolvedCards: realCards,
  });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.scenarioType, "printed_card_name_reference_after_runtime_copy");
  assert.equal(result.condition, "not_satisfied");
});

test("the public RAG path trusts the real printed-reference execution and skips the final model", async () => {
  const answer = await answerRagRulingQuestion({
    question: realQuestion,
    cards: realCards,
    records: [],
    qaRecords: [],
    env: {
      MODEL_PROVIDER: "mock",
      RAG_MODEL_PROVIDER: "mock",
      RAG_DRY_RUN: "1",
      OCG_ENGINE_ENABLED: "0",
    },
    dryRun: true,
  });
  assert.match(answer.shortAnswer, /^不能仅凭复制/u);
  assert.equal(answer.debug.deterministicDecision, "state_transition");
  assert.equal(answer.debug.modelUsed, "trusted-semantic-state-executor");
  assert.equal(answer.debug.timingsMs.finalModel, 0);
  assert.ok(answer.riskFlags.includes("trusted_local_semantic_execution"));
  assert.deepEqual(new Set(answer.resolvedCards.map((card) => card.id)), new Set(["13077", "19842", "19892"]));
});

function renamedQuestion() {
  return "自己场上有「匿名复制体」与「匿名场地」。该「匿名复制体」复制了「匿名来源体」的原本卡名和效果。此时它是否成为效果文本框内记载有「匿名场地」卡名的怪兽，并可据此发动要求该记载的卡？";
}

function renamedCards({ receiverPrintedReference = false } = {}) {
  return [{
    id: "renamed-receiver",
    name: "匿名复制体",
    aliases: ["匿名复制体"],
    effectText: [
      "①：以场上或墓地1只怪兽为对象可以发动。此卡获得与该怪兽原本卡名和效果相同的卡名和效果。",
      receiverPrintedReference ? "此卡原本效果文本记载有“匿名场地”卡名。" : "",
    ].filter(Boolean).join("\n"),
  }, {
    id: "renamed-source",
    name: "匿名来源体",
    aliases: ["匿名来源体"],
    effectText: "自己场上存在“匿名场地”的情况下可以发动。从牌组将记载有“匿名场地”卡名的怪兽特殊召唤。",
  }, {
    id: "renamed-field",
    name: "匿名场地",
    aliases: ["匿名场地"],
    effectText: "此卡在场地区域存在时适用。",
  }];
}
