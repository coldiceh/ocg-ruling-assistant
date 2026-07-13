import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { retrieveRulebookPassages } from "../backend/rulebookPassageRetriever.mjs";

test("actual_rulebook_late_paragraph_is_retrieved_as_a_passage", async () => {
  const payload = JSON.parse(await readFile(new URL("../data/ocg-rule-corpus.json", import.meta.url), "utf8"));
  const passages = retrieveRulebookPassages({
    records: payload.records || [],
    userQuery: "正在发动的通常陷阱能否被返回手卡？",
    ruleSearchQueries: [
      { query: "发动中的通常魔法 通常陷阱 回到手卡 场上的魔法陷阱", confidence: "high" },
      { query: "魔法 陷阱 连锁途中 回到手卡 卡组", confidence: "high" },
    ],
    maxPassages: 20,
  });

  const relevant = passages.find((item) => /这种魔法·陷阱卡在连锁途中不能从场上回到手卡·卡组/u.test(item.text));
  assert.ok(relevant, "expected the rulebook passage about activated Spell/Trap Cards returning to hand");
  assert.match(relevant.id, /^ocg-rule:c02\/卡片·效果的发动#p/u);
  assert.equal(relevant.type, "rulebook");
  assert.ok(relevant.sourceUrl);
});

test("actual_xyz_encore_faq_is_retrieved_for_unaffected_rhongomyniad", async () => {
  const data = await loadRagData();
  const resolvedCards = ["10820", "11296"]
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  const evidence = await retrieveRagEvidence({
    userQuery: "持有三个X素材的「NO.86 英豪冠军 击灭枪王」能否成为「超量叠光延迟」的对象？",
    cardResolution: {
      resolvedCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
  });

  const faq = evidence.faqRelated.find((item) => item.id === "card-faq-10820-1");
  assert.ok(faq, "expected Xyz Encore FAQ 1 to be retrieved");
  assert.match(faq.text, /X素材.*全て取り除/u);
  assert.match(faq.sourceUrl, /www\.db\.yugioh-card\.com\/yugiohdb\/faq_search\.action/u);

  const exactRuleIndex = evidence.rulebookCandidates.findIndex((item) => (
    /No\.86 英豪冠军 击灭枪王/u.test(item.text)
    && /超量叠光延迟/u.test(item.text)
    && /后续效果/u.test(item.text)
  ));
  assert.ok(exactRuleIndex >= 0, "expected the exact No.86 and Xyz Encore rule example");
  assert.ok(exactRuleIndex < 3, `expected exact scenario evidence near the top, got rank ${exactRuleIndex + 1}`);
});
