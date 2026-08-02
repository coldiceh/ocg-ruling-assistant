import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";

function fixture(prefix = "测试") {
  const names = {
    source: `${prefix}双生召唤者`,
    limit: `${prefix}同族限制`,
    first: `${prefix}甲战士`,
    second: `${prefix}乙战士`,
  };
  const resolvedCards = [
    { id: `${prefix}-source`, name: names.source, aliases: [names.source], cardType: "monster", race: "机械族" },
    { id: `${prefix}-limit`, name: names.limit, aliases: [names.limit], cardType: "trap" },
    { id: `${prefix}-first`, name: names.first, aliases: [names.first], cardType: "monster", race: "战士族" },
    { id: `${prefix}-second`, name: names.second, aliases: [names.second], cardType: "monster", race: "战士族" },
  ];
  const cardTexts = [
    {
      id: `${prefix}-source-text`,
      cards: [names.source],
      cardType: "monster",
      text: `②：在自己・对手回合中，解放此卡可以发动。从自己牌组・墓地将「${names.first}」「${names.second}」各1只特殊召唤。然后，可将场上的1张卡破坏。`,
    },
    {
      id: `${prefix}-limit-text`,
      cards: [names.limit],
      cardType: "trap",
      text: "①：只要此卡存在于魔法与陷阱区域，双方场上各只可有1只同种族怪兽以表侧表示存在。双方玩家自身场上有2只以上同种族怪兽存在的情况下，必须将怪兽送至墓地，直至同种族怪兽只有1只为止。",
    },
    { id: `${prefix}-first-text`, cards: [names.first], cardType: "monster", text: "战士族怪兽。" },
    { id: `${prefix}-second-text`, cards: [names.second], cardType: "monster", text: "战士族怪兽。" },
  ];
  const userQuery = `对方场上表侧表示存在「${names.limit}」，我方场上表侧表示存在「${names.source}」。我方可以发动「${names.source}」的②效果吗？效果处理时先做什么；如果最后破坏「${names.limit}」或破坏其他卡，场上的两只怪兽分别如何处理？`;
  return { names, resolvedCards, cardTexts, userQuery };
}

test("normalized IR preserves tribute-self cost, simultaneous named pair, THEN optional field destruction", () => {
  const { cardTexts } = fixture();
  const ir = normalizeCardText({
    id: "normalized-source",
    name: cardTexts[0].cards[0],
    cardType: "monster",
    effectText: cardTexts[0].text,
  });
  const effect = ir.effects.find((candidate) => candidate.nature === "activated");
  assert.equal(effect.activation.costs[0].type, "tribute");
  assert.equal(effect.activation.costs[0].subject, "effect_source");
  const summon = effect.resolution[0].operation;
  const destroy = effect.resolution[1];
  assert.equal(summon.type, "special_summon");
  assert.equal(summon.amount, 2);
  assert.equal(summon.simultaneous, true);
  assert.deepEqual(new Set(summon.fromZones), new Set(["deck", "graveyard"]));
  assert.equal(destroy.connector, "THEN");
  assert.equal(destroy.operation.type, "destroy");
  assert.equal(destroy.operation.optional, true);
  assert.deepEqual(destroy.operation.selector, { zone: "field", amount: 1, controller: "either" });
});

test("trusted state execution waits for the whole effect before applying a same-race field limit", () => {
  const input = fixture();
  const result = analyzeEffectStateTransition(input);

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.activation, "legal");
  assert.match(result.shortAnswer, /可以发动/u);
  assert.match(result.shortAnswer, /先把.*甲战士.*乙战士.*同时特殊召唤/u);
  assert.match(result.shortAnswer, /之后才可以选择破坏/u);
  assert.match(result.shortAnswer, /限制已不再适用.*两只怪兽都正常留在场上/u);
  assert.match(result.shortAnswer, /限制.*仍适用.*选择1只送去墓地/u);

  const carrier = result.program.branches.destroyLimitCarrier;
  const other = result.program.branches.destroyOtherCard;
  assert.equal(carrier.complete, true);
  assert.equal(carrier.afterResolutionCheckpoint.adjustments.length, 0);
  assert.ok(carrier.afterResolutionCheckpoint.trace.some((entry) => (
    entry.event === "field_restriction_inactive"
  )));
  const adjustment = other.afterResolutionCheckpoint.adjustments[0];
  assert.equal(adjustment.status, "choice_required");
  assert.equal(adjustment.sendCount, 1);
  assert.deepEqual(other.operationOrder, ["special_summon_cards", "destroy_target"]);
});

test("the ordered checkpoint compiler is invariant under complete card renaming", () => {
  const first = analyzeEffectStateTransition(fixture("棱镜"));
  const second = analyzeEffectStateTransition(fixture("星河"));
  for (const result of [first, second]) {
    assert.equal(result.status, "resolved", JSON.stringify(result));
    assert.equal(result.activation, "legal");
    assert.equal(result.program.type, "compiled_ordered_resolution_checkpoint");
    assert.equal(result.program.branches.destroyOtherCard
      .afterResolutionCheckpoint.adjustments[0].sendCount, 1);
  }
  assert.doesNotMatch(JSON.stringify(first), /闪刀|千查|千察|零露|零萝/u);
});

test("the reported real wording resolves through aliases and executes both destruction branches", () => {
  const result = analyzeEffectStateTransition({
    userQuery: "对方场上表侧表示存在「千查万别」，我方场上表侧表示存在「闪刀姬＝零露」。我方可以发动「闪刀姬＝零露」的②效果吗？效果处理时先做什么；如果最后破坏「千查万别」或破坏其他卡，场上的两只怪兽分别如何处理？",
    resolvedCards: [
      { id: "21460", input: "闪刀姬＝零露", matchedQuery: "闪刀姬＝零露", name: "闪刀姬＝零萝", jaName: "閃刀姫＝ゼロ", cardType: "monster", race: "机械族" },
      { id: "13447", input: "千查万别", matchedQuery: "千查万别", name: "千察万别", jaName: "センサー万別", cardType: "trap" },
      { id: "13670", name: "闪刀姬－零", jaName: "閃刀姫－レイ", cardType: "monster", race: "战士族" },
      { id: "14829", name: "闪刀姬－萝杰", jaName: "閃刀姫－ロゼ", cardType: "monster", race: "战士族" },
    ],
    cardTexts: [
      {
        id: "card-text-21460",
        cards: ["闪刀姬＝零萝", "閃刀姫＝ゼロ"],
        cardType: "monster",
        text: "②：在自己・对手回合中，解放此卡可以发动。从自己牌组・墓地将「闪刀姬－零」「闪刀姬－萝杰」各1只特殊召唤。然后，可将场上的1张卡破坏。",
      },
      {
        id: "card-text-13447",
        cards: ["千察万别", "センサー万別"],
        cardType: "trap",
        text: "①：只要此卡存在于魔法与陷阱区域，双方场上各只可有1只同种族怪兽以表侧表示存在。双方玩家自身场上有2只以上同种族怪兽存在的情况下，必须将怪兽送至墓地，直至同种族怪兽只有1只为止。",
      },
      { id: "card-text-13670", cards: ["闪刀姬－零"], cardType: "monster", text: "战士族怪兽。" },
      { id: "card-text-14829", cards: ["闪刀姬－萝杰"], cardType: "monster", text: "战士族怪兽。" },
    ],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "legal");
  assert.match(result.shortAnswer, /破坏「千察万别」.*两只怪兽都正常留在场上/u);
  assert.match(result.shortAnswer, /破坏其他卡.*选择1只送去墓地/u);
});

test("missing an output monster's race fails closed instead of guessing checkpoint cleanup", () => {
  const input = fixture("缺失");
  delete input.resolvedCards[3].race;
  const result = analyzeEffectStateTransition(input);

  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.reason, "ordered_resolution_checkpoint_output_race_unknown");
});
