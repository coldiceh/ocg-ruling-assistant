import assert from "node:assert/strict";
import test from "node:test";

import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

const shortQuestion = "对方场上有一个b2b，导致我方场上的4+4变成了6+6。这个情况下假如我方额外只有8星同调而没有12星同调的话，可以发动异界共鸣吗";
const fullQuestion = "对方场上有一个《杀手级调整曲 B2B》，导致我方场上的2只四星怪兽变成了2只六星怪兽，这个情况下假如我方额外只有一只可以同调召唤的8星同调怪兽而没有12星同调怪兽的话，可以发动【异界共鸣-同调融合】吗";

test("unique short aliases and translated partial names resolve to the same cards as full names", async () => {
  const data = await loadRagData();
  const shortResolution = extractRagCards(shortQuestion, { cards: data.cards, maxCards: 8 });
  const fullResolution = extractRagCards(fullQuestion, { cards: data.cards, maxCards: 8 });
  const expectedIds = new Set(["19046", "22551"]);

  assert.deepEqual(new Set(shortResolution.resolvedCards.map((card) => String(card.id))), expectedIds);
  assert.deepEqual(new Set(fullResolution.resolvedCards.map((card) => String(card.id))), expectedIds);
  assert.deepEqual(shortResolution.unresolvedMentions, []);
  assert.deepEqual(fullResolution.unresolvedMentions, []);
});

test("equivalent short and full questions retrieve the same governing FAQ without a network fallback", async () => {
  const data = await loadRagData();
  const results = [];

  for (const question of [shortQuestion, fullQuestion]) {
    let fetchCalls = 0;
    const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });
    const evidence = await retrieveRagEvidence({
      userQuery: question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("network fallback should not run");
      },
    });
    results.push({
      ids: evidence.retrievedCards.map((card) => String(card.id)).sort(),
      faqIds: evidence.faqRelated.map((item) => String(item.id)),
      fetchCalls,
    });
  }

  for (const result of results) {
    assert.deepEqual(result.ids, ["19046", "22551"]);
    assert.equal(result.fetchCalls, 0);
    assert.ok(result.faqIds.includes("card-faq-19046-1"));
    assert.ok(!result.faqIds.some((id) => id.startsWith("card-faq-10340-")));
  }
});

test("a shared short fragment is not resolved when it identifies multiple cards", () => {
  const cards = [
    { id: "a", name: "测试卡 A1B", aliases: ["Alpha A1B"] },
    { id: "b", name: "另一测试卡 A1B", aliases: ["Beta A1B"] },
  ];
  const resolution = extractRagCards("对方场上有一个A1B，这个效果如何处理？", { cards });

  assert.deepEqual(resolution.resolvedCards, []);
});
