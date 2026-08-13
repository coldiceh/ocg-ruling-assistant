import assert from "node:assert/strict";
import test from "node:test";

import { resolveRawGenericCards } from "../backend/rawGenericCardResolver.mjs";

const cards = [
  { id: "101", cid: "9001", name: "匿名甲", aliases: ["匿名甲"] },
  { id: "102", cid: "9002", name: "匿名甲·延长形", aliases: ["匿名甲·延长形"] },
  { id: "103", cid: "9003", name: "共享简称一", aliases: ["共同简称"] },
  { id: "104", cid: "9004", name: "共享简称二", aliases: ["共同简称"] },
  { id: "105", cid: "9005", name: "匿名长名称", aliases: ["匿名长名称"] },
  { id: "106", cid: "9006", name: "前缀独特水龙后缀", aliases: ["前缀独特水龙后缀"] },
  { id: "107", cid: "9007", name: "另一共同片段结尾", aliases: ["另一共同片段结尾"] },
  { id: "108", cid: "9008", name: "额外共同片段开头", aliases: ["额外共同片段开头"] },
  { id: "109", cid: "9009", name: "融合", aliases: ["融合"] },
];

function resolvedIds(question, options = {}) {
  return resolveRawGenericCards({ userQuery: question, cards, ...options })
    .resolvedCards.map((card) => card.id);
}

test("resolves exact aliases and explicit CID values", () => {
  assert.deepEqual(resolvedIds("「匿名甲」可以发动吗？"), ["101"]);
  assert.deepEqual(resolvedIds("请检查 CID: 9005。"), ["105"]);
});

test("longest non-overlapping exact alias wins", () => {
  const result = resolveRawGenericCards({
    userQuery: "「匿名甲·延长形」的处理是什么？",
    cards,
  });
  assert.deepEqual(result.resolvedCards.map((card) => card.id), ["102"]);
  assert.deepEqual(result.ambiguousMentions, []);
});

test("a shared exact surface fails closed as ambiguous", () => {
  const result = resolveRawGenericCards({ userQuery: "「共同简称」如何处理？", cards });
  assert.deepEqual(result.resolvedCards, []);
  assert.equal(result.ambiguousMentions.length, 1);
  assert.deepEqual(
    result.ambiguousMentions[0].candidateCards.map((card) => card.id).sort(),
    ["103", "104"],
  );
});

test("model originalText must occur in the question before its exact canonical name is accepted", () => {
  const accepted = resolveRawGenericCards({
    userQuery: "匿长名称能否处理？",
    cards,
    modelCardNameCandidates: [{ name: "匿名长名称", originalText: "匿长名称" }],
  });
  assert.deepEqual(accepted.resolvedCards.map((card) => card.id), ["105"]);

  const rejected = resolveRawGenericCards({
    userQuery: "完全没有写卡名。",
    cards,
    modelCardNameCandidates: [{ name: "匿名长名称", originalText: "匿长名称" }],
  });
  assert.deepEqual(rejected.resolvedCards, []);
});

test("unknown quoted prose is ignored instead of becoming an unresolved card", () => {
  const result = resolveRawGenericCards({ userQuery: "「匿名长名城」可以发动吗？", cards });
  assert.deepEqual(result.resolvedCards, []);
  assert.deepEqual(result.unresolvedMentions, []);
  assert.deepEqual(result.ambiguousMentions, []);
});

test("catalog-unique short fragments resolve without fuzzy or topic rules", () => {
  const quoted = resolveRawGenericCards({ userQuery: "「独特水龙」可以发动吗？", cards });
  assert.deepEqual(quoted.resolvedCards.map((card) => card.id), ["106"]);
  assert.equal(quoted.resolvedCards[0].identityMatchKind, "unique_alias_fragment");

  const modelSurface = resolveRawGenericCards({
    userQuery: "独特水龙可以发动吗？",
    cards,
    modelCardNameCandidates: [{ name: "独特水龙", originalText: "独特水龙" }],
  });
  assert.deepEqual(modelSurface.resolvedCards.map((card) => card.id), ["106"]);

  const twoCharacterModelSurface = resolveRawGenericCards({
    userQuery: "水龙可以发动吗？",
    cards,
    modelCardNameCandidates: [{ name: "水龙", originalText: "水龙" }],
  });
  assert.deepEqual(twoCharacterModelSurface.resolvedCards.map((card) => card.id), ["106"]);
  assert.equal(twoCharacterModelSurface.resolvedCards[0].identityMatchKind, "unique_alias_fragment");
});

test("a fragment shared by multiple card identities fails closed as ambiguous", () => {
  const result = resolveRawGenericCards({ userQuery: "「共同片段」如何处理？", cards });
  assert.deepEqual(result.resolvedCards, []);
  assert.deepEqual(result.unresolvedMentions, []);
  assert.deepEqual(
    result.ambiguousMentions[0].candidateCards.map((card) => card.id).sort(),
    ["107", "108"],
  );
});

test("two-character card names are not harvested from unquoted game prose", () => {
  assert.deepEqual(resolvedIds("这个回合进行融合召唤。"), []);
  assert.deepEqual(resolvedIds("这个回合进行融合召唤。", {
    modelCardNameCandidates: [{ name: "融合", originalText: "融合" }],
  }), []);
  assert.deepEqual(resolvedIds("发动「融合」。"), ["109"]);
});

test("identity resolution is invariant to gameplay wording", () => {
  const questions = [
    "我方召唤「匿名甲」后能否发动？",
    "对方把「匿名甲」送去墓地后如何处理？",
    "连锁二处理时「匿名甲」仍在手卡。",
    "额外卡组的「匿名甲」成为素材。",
  ];
  for (const question of questions) assert.deepEqual(resolvedIds(question), ["101"]);
});

test("a card name written only inside a supplied effect-text body is not auto-expanded", () => {
  const result = resolveRawGenericCards({
    userQuery: [
      "【用户新卡】",
      "①：把「匿名甲」加入手卡。",
      "问题：这张卡如何处理？",
    ].join("\n"),
    cards,
  });
  assert.deepEqual(result.resolvedCards, []);
  assert.equal(result.userProvidedCardTexts.length, 1);
});

test("resolver source has no gameplay-topic selectors or legacy resolver dependency", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("../backend/rawGenericCardResolver.mjs", import.meta.url), "utf8")
  ));
  assert.doesNotMatch(source, /ragCardExtractor|extractRagCards|officialQaMatcher|rulebookPassageRetriever/u);
  assert.doesNotMatch(source, /playerRole|scenarioPremise|mechanism/u);
});
