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
