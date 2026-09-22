import assert from "node:assert/strict";
import test from "node:test";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

test("a resolved parenthetical alias group suppresses duplicate fallback card searches", async () => {
  const card = {
    id: "alias-card-100",
    name: "Official Inner",
    jaName: "Official Inner",
    aliases: ["Official Inner"],
    input: "Official Inner",
    confidence: 0.98,
    effectText: "①：这个效果可以发动。",
    sourceUrl: "https://example.test/card/alias-card-100",
  };
  let fetchCalls = 0;
  const evidence = await retrieveRagEvidence({
    userQuery: "「翻译名（Official Inner）」的效果如何处理？",
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [
        { input: "翻译名（Official Inner）", reason: "quoted_mention_not_found" },
        { input: "翻译名", reason: "quoted_mention_not_found" },
      ],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [card],
    records: [],
    qaRecords: [],
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fallback search should not run");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(evidence.baigeResolvedCards.length, 0);
  assert.equal(evidence.remainingUnresolvedMentions.length, 0);
  assert.ok(evidence.retrievalWarnings.includes("parenthetical_alias_mentions_collapsed:2"));
});
