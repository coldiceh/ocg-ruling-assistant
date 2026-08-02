import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_TEXT_IR_VERSION,
  findNormalizedSemantics,
  normalizeCardText,
} from "../backend/cardTextNormalizer.mjs";

test("normalizes activation procedure, cost, and ordered resolution without card-specific knowledge", () => {
  const normalized = normalizeCardText({
    id: "generic-trap",
    name: "测试陷阱",
    cardType: "trap",
    effectText: "①：支付２０００LP，将手牌全部出示给对手可以发动。确认对手的手牌，从其中挑选１张除外。",
  });

  assert.equal(normalized.version, CARD_TEXT_IR_VERSION);
  assert.equal(normalized.effects[0].nature, "activated");
  assert.deepEqual(
    normalized.effects[0].activation.costs.map((item) => [item.type, item.amount]),
    [["pay_lp", 2000]],
  );
  assert.deepEqual(
    normalized.effects[0].activation.procedures.map((item) => [item.type, item.scope, item.handOwner]),
    [["reveal_hand", "all", "controller"]],
  );
  assert.equal(normalized.effects[0].resolution[0].operation.type, "inspect_hand");
  assert.equal(normalized.effects[0].resolution[0].connector, "INDEPENDENT");
});

test("normalizes continuous opponent-hand visibility from Japanese text", () => {
  const normalized = normalizeCardText({
    id: "generic-continuous",
    name: "generic",
    cardType: "spell",
    effectText: "自分のフィールドにカードが存在する限り、相手は手札を全て公開し続けなければならない。",
  });
  const matches = findNormalizedSemantics(normalized, "hand_visibility");

  assert.equal(normalized.effects[0].nature, "continuous");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].semantic.affected, "opponent");
  assert.equal(matches[0].semantic.visibility, "public");
});

test("preserves all resolved identity aliases in the normalized card identity", () => {
  const normalized = normalizeCardText({
    id: "42",
    name: "canonical",
    aliases: ["旧译名", "別名"],
    input: "用户写法",
    matchedQuery: "检索写法",
    text: "没有编号的静态文本。",
  });

  assert.deepEqual(
    normalized.identity.names,
    ["canonical", "用户写法", "检索写法", "旧译名", "別名"],
  );
});

test("normalizes destination replacement independently of a specific card name", () => {
  const normalized = normalizeCardText({
    id: "replacement",
    name: "replacement",
    cardType: "monster",
    effectText: "①：只要此卡存在于怪兽区域，被送往对手墓地的卡不去墓地而直接被除外。",
  });
  const matches = findNormalizedSemantics(normalized, "destination_replacement");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].semantic.intendedZone, "graveyard");
  assert.equal(matches[0].semantic.replacementZone, "banished");
  assert.equal(matches[0].semantic.affected, "opponent");
});

test("normalizes mandatory summon outputs and per-player grouped field limits", () => {
  const summonCard = normalizeCardText({
    id: "generic-multi-summon",
    name: "generic",
    cardType: "monster",
    effectText: "①：在主要阶段可以发动。从手牌将此卡特殊召唤。然后，将1只“测试衍生物”（岩石族）特殊召唤至对手场上。",
  });
  const operations = summonCard.effects[0].resolution.map((step) => step.operation);

  assert.deepEqual(
    operations.filter((operation) => operation.type === "special_summon").map((operation) => ({
      subject: operation.subject,
      fromZone: operation.fromZone,
      player: operation.destinationPlayerRelation,
      race: operation.race || "",
      mandatory: operation.mandatory,
    })),
    [
      {
        subject: "effect_source",
        fromZone: "hand",
        player: "same_as_source_controller",
        race: "",
        mandatory: true,
      },
      {
        subject: "generated_monster",
        fromZone: "unknown",
        player: "opponent_of_source_controller",
        race: "岩石族",
        mandatory: true,
      },
    ],
  );

  const limitCard = normalizeCardText({
    id: "generic-limit",
    name: "generic",
    cardType: "trap",
    effectText: "①：只要此卡存在于魔法与陷阱区域，双方场上各只可有1只同种族怪兽以表侧表示存在。",
  });
  const limits = findNormalizedSemantics(limitCard, "field_count_limit");
  assert.deepEqual(limits.map(({ semantic }) => ({
    scope: semantic.scope,
    groupBy: semantic.groupBy,
    maxCount: semantic.maxCount,
    faceUp: semantic.faceUp,
  })), [{
    scope: "per_player",
    groupBy: "race",
    maxCount: 1,
    faceUp: true,
  }]);
});

test("special-summon normalization excludes an 'other than' card name without inflating the count", () => {
  const normalized = normalizeCardText({
    id: "fictional-archetype-summon",
    name: "折光航标",
    cardType: "monster",
    effectText: "①：可以发动。从牌组将“折光航标”以外的1只“棱镜”怪兽特殊召唤。",
  });
  const summon = normalized.effects[0].resolution
    .map((step) => step.operation)
    .find((operation) => operation.type === "special_summon");

  assert.equal(summon.amount, 1);
  assert.equal(summon.name, "棱镜");
  assert.deepEqual(summon.names, ["棱镜"]);
  assert.deepEqual(summon.excludedNames, ["折光航标"]);
});

test("special-summon normalization keeps a true each-named-card output count", () => {
  const normalized = normalizeCardText({
    id: "fictional-enumerated-summon",
    name: "折光双召术",
    cardType: "spell",
    effectText: "①：可以发动。从牌组将“棱镜甲”“棱镜乙”各1只特殊召唤。",
  });
  const summon = normalized.effects[0].resolution
    .map((step) => step.operation)
    .find((operation) => operation.type === "special_summon");

  assert.equal(summon.amount, 2);
  assert.deepEqual(summon.names, ["棱镜甲", "棱镜乙"]);
  assert.equal(Object.hasOwn(summon, "excludedNames"), false);
});

test("normalizes field-only numeric modifiers without relying on a real card identity", () => {
  const normalized = normalizeCardText({
    id: "fictional-level-carrier",
    name: "架空等级载体",
    cardType: "monster",
    effectText: "①：对手场上的怪兽的等级上升2。",
  });
  const [match] = findNormalizedSemantics(normalized, "numeric_value_modifier");

  assert.equal(normalized.effects[0].nature, "continuous");
  assert.equal(match.semantic.property, "level");
  assert.equal(match.semantic.operation, "add");
  assert.equal(match.semantic.amount, 2);
  assert.equal(match.semantic.affected, "opponent");
  assert.equal(match.semantic.selector.zone, "monster_zone");
  assert.equal(match.semantic.expiresWhenLeavingSelectorZone, true);
});

test("normalizes a field-material cost and resolution-time reference to those cost cards", () => {
  const normalized = normalizeCardText({
    id: "fictional-post-cost-spell",
    name: "架空双召术",
    cardType: "spell",
    effectText: "此卡名的卡１回合仅可发动１张，发动此卡的回合中，自己从额外牌组仅可特殊召唤融合・同步怪兽。\n①：将自己场上表侧表示的协调和协调以外的怪兽各１只送至墓地可以发动。从额外牌组将以下怪兽各１只特殊召唤。\n●能够以墓地的该２只怪兽作为素材同步召唤的同步怪兽\n●能够以墓地的该２只怪兽作为素材融合召唤的融合怪兽",
  });
  const effect = normalized.effects.find((item) => item.effectNo === "1");
  const cost = effect.activation.costs.find((item) => item.type === "send_field_monsters_to_graveyard");
  const operations = effect.resolution.map((step) => step.operation);
  const operation = operations.find((item) => item.type === "summon_using_activation_cost_cards");
  const extraDeckSummon = operations.find((item) => item.type === "special_summon");

  assert.equal(normalized.effects.find((item) => item.effectNo === "unknown").nature, "static");
  assert.equal(effect.nature, "activated");
  assert.equal(cost.faceUp, true);
  assert.deepEqual(cost.requiredRoles, ["tuner", "non_tuner"]);
  assert.equal(extraDeckSummon.fromZone, "extra_deck");
  assert.deepEqual(extraDeckSummon.fromZones, ["extra_deck"]);
  assert.equal(operation.materialReference, "activation_cost_cards");
  assert.equal(operation.materialStateAt, "resolution_current_state");
  assert.deepEqual(operation.summonKinds, ["synchro", "fusion"]);
});

test("does not confuse a graveyard or banished target and an either-or operation with a banish cost", () => {
  const normalized = normalizeCardText({
    id: "fictional-choice",
    name: "架空选择怪兽",
    cardType: "monster",
    effectText: "③：对手发动怪兽效果时，以自己墓地・除外状态的1只协调为对象可以发动。将该怪兽加入手牌或特殊召唤。",
  });
  const effect = normalized.effects[0];
  const operation = effect.resolution[0].operation;

  assert.equal(effect.activation.costs.some((item) => item.type === "banish_as_cost"), false);
  assert.equal(operation.type, "special_summon");
  assert.equal(operation.fromZone, "unknown");
  assert.equal(operation.mandatory, false);
  assert.equal(operation.choice, "one_of_multiple_operations");
});

test("splits inline numbered effects after a preamble without splitting effect-number references", () => {
  const normalized = normalizeCardText({
    id: "fictional-inline-effects",
    name: "架空内联效果怪兽",
    cardType: "monster",
    effectText: [
      "此卡不可通常召唤。此卡名的①②效果1回合仅可各使用1次。",
      "①：此卡存在于手牌，且有怪兽因卡的效果被除外的情况下可以发动。将此卡特殊召唤。",
      "②：此卡特殊召唤成功的情况下可以发动。从牌组将1张卡加入手牌。",
      "③：表侧表示的此卡离开场上的情况下，将其除外。",
    ].join(""),
  });

  assert.deepEqual(
    normalized.effects.map((effect) => effect.effectNo),
    ["unknown", "1", "2", "3"],
  );
  assert.equal(normalized.effects.find((effect) => effect.effectNo === "1").nature, "activated");
  assert.equal(normalized.effects.find((effect) => effect.effectNo === "2").nature, "activated");
  const leaveField = normalized.effects.find((effect) => effect.effectNo === "3");
  assert.equal(leaveField.nature, "continuous");
  assert.equal(
    leaveField.continuous.some((semantic) => (
      semantic.type === "destination_replacement"
      && semantic.whenLeavingField === true
      && semantic.replacementZone === "banished"
    )),
    true,
  );
  assert.equal(normalized.missingSections.includes("monsterEffects"), false);
});

test("summon-bound lifecycle parsing requires an actual extra-deck summon restriction", () => {
  for (const effectText of [
    "①：可以发动。将1只怪兽特殊召唤。只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组仅可特殊召唤‘示例’怪兽。",
    "①：可以发动。将1只怪兽特殊召唤。只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，自己不是‘示例’怪兽不能从额外牌组特殊召唤。",
    "①：発動できる。モンスター1体を特殊召喚する。この効果で特殊召喚したモンスターが表側表示で自分フィールドに存在する限り、自分は「例」モンスターしかEXデッキから特殊召喚できない。",
    "①：発動できる。このカードを特殊召喚する。この効果で特殊召喚したこのカードが表側表示で自分フィールドに存在する限り、自分は「例」モンスターしかEXデッキから特殊召喚できない。",
    "You can activate this effect; Special Summon 1 monster. As long as a monster Special Summoned by this effect is face-up on your field, you can only Special Summon ‘Example’ monsters from your Extra Deck.",
  ]) {
    const positive = normalizeCardText({
      id: "fictional-bound-lock",
      name: "架空期限限制",
      cardType: "monster",
      effectText,
    });
    assert.equal(
      positive.effects.flatMap((effect) => effect.resolution)
        .some((step) => step.operation.type === "create_lingering_restriction"),
      true,
      effectText,
    );
  }

  for (const effectText of [
    "①：这个效果特殊召唤的怪兽的效果无效化。",
    "①：以此效果特殊召唤的怪兽作为融合素材。",
    "①：只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，那只怪兽的效果无效化。",
    "①：只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，自己场上的怪兽不能被从额外牌组特殊召唤的怪兽战斗破坏。",
    "①：只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，自己不能让从额外牌组特殊召唤的怪兽攻击。",
    "①：只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，自己不能把从额外牌组特殊召唤的怪兽作为融合素材。",
  ]) {
    const normalized = normalizeCardText({
      id: "fictional-non-lock",
      name: "架空非限制",
      cardType: "monster",
      effectText,
    });
    assert.equal(
      normalized.effects.flatMap((effect) => effect.resolution)
        .some((step) => step.operation.type === "create_lingering_restriction"),
      false,
      effectText,
    );
  }
});
