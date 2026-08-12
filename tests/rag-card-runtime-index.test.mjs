import assert from "node:assert/strict";
import test from "node:test";

import {
  compileRagCardAliasRuntimeIndex,
  extractRagCards,
  hydrateRagCardAliasRuntimeIndex,
} from "../backend/ragCardExtractor.mjs";

function makeCards() {
  return [{
    id: "runtime-1",
    name: "匿名长名龙G",
    cnName: "匿名长名龙G",
    jaName: "匿名長名竜G",
    enName: "ANM Long Dragon G",
    aliases: ["匿名长龙G"],
    effectText: "以「匿名场地」为对象发动。",
  }, {
    id: "runtime-2",
    name: "匿名长名龙",
    aliases: ["匿名长龙"],
    effectText: "不相关的短名称卡。",
  }, {
    id: "runtime-3",
    name: "匿名场地",
    aliases: ["ANM Field"],
    effectText: "场地效果。",
  }, {
    id: "runtime-4",
    name: "No.17 匿名水龙",
    aliases: ["No.17 匿名水龙", "编号17 匿名水龙"],
    effectText: "超量怪兽。",
  }, {
    id: "runtime-5",
    name: "匿名系列・北方水龙",
    aliases: ["匿名系列 北方水龙"],
    effectText: "需要匿名场地。",
  }, {
    id: "runtime-6",
    name: "匿名系列・南方火龙",
    aliases: ["匿名系列 南方火龙"],
    effectText: "需要匿名场地。",
  }];
}

const QUERIES = [
  "发动「匿名长名龙G」的效果。",
  "「匿名长龙G」处理后，另一张匿名长名龙发动效果。",
  "No.17 匿名水龙可以发动效果吗？",
  "场上有「匿名系列・北方水龙」，水龙的效果如何处理？",
  "ANM Long Dragon G发动效果后，能否发动「匿名场地」？",
  "发动「匿名长名龙F」的效果。",
];

function extractAll(cards) {
  return QUERIES.map((query) => extractRagCards(query, { cards, maxCards: 8 }));
}

test("compiled card alias runtime index hydrates fresh cards with byte-stable query behavior", () => {
  const sourceCards = makeCards();
  const expected = extractAll(sourceCards);
  const first = compileRagCardAliasRuntimeIndex(sourceCards);
  const second = compileRagCardAliasRuntimeIndex(structuredClone(sourceCards));
  assert.deepEqual(second, first);

  const hydratedCards = structuredClone(sourceCards);
  assert.equal(hydrateRagCardAliasRuntimeIndex(hydratedCards, structuredClone(first)), true);
  assert.deepEqual(extractAll(hydratedCards), expected);
});

test("card alias runtime index rejects a corrupt ordinal without poisoning the card cache", () => {
  const sourceCards = makeCards();
  const snapshot = compileRagCardAliasRuntimeIndex(sourceCards);
  const corrupted = structuredClone(snapshot);
  corrupted.primary[0][1][0].cardOrdinal = sourceCards.length;

  const freshCards = structuredClone(sourceCards);
  assert.equal(hydrateRagCardAliasRuntimeIndex(freshCards, corrupted), false);
  assert.deepEqual(extractAll(freshCards), extractAll(sourceCards));
});

test("card alias runtime index rejects reordered or mismatched card identities fail closed", () => {
  const sourceCards = makeCards();
  const snapshot = compileRagCardAliasRuntimeIndex(sourceCards);

  const reorderedCards = structuredClone(sourceCards);
  [reorderedCards[0], reorderedCards[1]] = [reorderedCards[1], reorderedCards[0]];
  assert.equal(hydrateRagCardAliasRuntimeIndex(reorderedCards, snapshot), false);

  const tamperedIdentity = structuredClone(snapshot);
  tamperedIdentity.cardIdentities[2] = "wrong-card-identity";
  const freshCards = structuredClone(sourceCards);
  assert.equal(hydrateRagCardAliasRuntimeIndex(freshCards, tamperedIdentity), false);
  assert.deepEqual(extractAll(freshCards), extractAll(sourceCards));
});
