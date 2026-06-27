import assert from "node:assert/strict";
import test from "node:test";
import { buildRulingContextPack, resolveCardsForFastJudge } from "../backend/rulingContextPack.mjs";
import { detectIssueFrames } from "../backend/issueFrameDetector.mjs";
import { buildCardProfiles } from "../backend/cardProfile.mjs";

test("context pack stays small and excludes rule-test golden cases", () => {
  const cards = [{ id: "1", name: "测试卡", aliases: ["测试卡"], cardType: "monster", effectText: "①：这张卡可以造成贯穿战斗伤害。" }];
  const question = "测试卡攻击守备怪兽时会造成贯穿战斗伤害吗？";
  const resolution = resolveCardsForFastJudge(question, cards);
  const profiles = buildCardProfiles(resolution.resolvedCards);
  const frames = detectIssueFrames({ question, cardProfiles: profiles });
  const records = [
    ...Array.from({ length: 12 }, (_, index) => ({ id: `faq-${index}`, recordType: "card-faq", title: "测试卡 FAQ", cards: ["测试卡"], cardIds: ["1"], text: "测试卡可以造成贯穿战斗伤害。" })),
    { id: "golden", recordType: "rule-test", title: "golden answer", text: "不应进入上下文" },
  ];
  const pack = buildRulingContextPack({ question, resolvedCards: resolution.resolvedCards, cardProfiles: profiles, issueFrames: frames, snapshot: { records } });
  assert.ok(pack.relevantCardSections.length <= 10);
  assert.ok(pack.faqCandidates.length <= 8);
  assert.ok(!JSON.stringify(pack).includes("不应进入上下文"));
});

test("long unresolved quoted name is not silently resolved as shorter card", () => {
  const result = resolveCardsForFastJudge("对方的「卡通青眼究极龙」能直接攻击吗？", [{ id: "2", name: "青眼究极龙", aliases: ["青眼究极龙"] }]);
  assert.equal(result.resolvedCards.length, 0);
  assert.equal(result.unresolvedCards[0].unresolvedCardName, "卡通青眼究极龙");
});
