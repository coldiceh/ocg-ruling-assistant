import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { callRulebookGroundingModel } from "../backend/ragModelClient.mjs";
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

test("actual_return_constraints_are_prioritized_for_operation_grounding", async () => {
  const data = await loadRagData();
  const resolvedCards = ["13631", "22130"]
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  const question = "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？";
  const evidence = await retrieveRagEvidence({
    userQuery: question,
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
  let prompt = "";
  const grounding = await callRulebookGroundingModel({
    userQuery: question,
    cardTexts: evidence.cardTexts,
    ruleEvidence: evidence.rulebookCandidates,
    qaEvidence: [...evidence.officialQaDirectCandidates, ...evidence.officialQaRelated, ...evidence.faqRelated],
    modelInvoker: async (request) => {
      prompt = request.prompt;
      return JSON.stringify({ constraintReviews: [], operationChecks: [], overallConclusion: "证据待核对。" });
    },
  });

  const priorityIds = grounding.operationLegality.priorityConstraintEvidence.map((item) => item.id);
  assert.ok(priorityIds.some((id) => id.includes("卡片·效果的发动#p263-267")), "expected the activated Spell/Trap return restriction");
  assert.ok(priorityIds.some((id) => id.includes("卡片·效果的发动#p285-289")), "expected the no-applicable-card activation restriction");
  assert.ok(priorityIds.length <= 3);
  assert.match(prompt, /priorityConstraintCandidates/u);
  assert.match(prompt, /只说明诱发条件或可连锁时点的一般卡片 FAQ/u);
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


test("rulebook_passage_keeps_the_matched_paragraph_when_context_is_too_long", () => {
  const marker = "命中规则：卡的发动被无效后，不再视为场上的卡。";
  const passages = retrieveRulebookPassages({
    records: [{
      id: "ocg-rule:test-focus",
      recordType: "rule-doc",
      title: "测试规则",
      text: [
        "无关前文".repeat(160),
        marker,
        "无关后文".repeat(160),
      ].join("\n\n"),
      sourceUrl: "https://example.test/rule",
    }],
    userQuery: "卡的发动被无效后是否仍视为场上的卡？",
    ruleSearchQueries: [{ query: "卡的发动 无效 场上的卡", confidence: "high" }],
    maxPassages: 3,
    maxPassageChars: 180,
  });

  assert.ok(passages.length > 0);
  assert.match(passages[0].text, /命中规则：卡的发动被无效后，不再视为场上的卡/u);
  assert.ok(passages[0].text.length <= 180);
});

test("inline_card_references_link_the_stardust_official_qa", async () => {
  const data = await loadRagData();
  const resolvedCards = ["4678", "16386", "7734"]
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  const evidence = await retrieveRagEvidence({
    userQuery: "我方C1发动「神鹰羽毛扫」，对手C2连锁「鲜花之女男爵」的无效并破坏效果，我方是否可以C3发动「星尘龙」？",
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

  const qa = evidence.officialQaRelated.find((item) => item.id === "ygoresources-qa-11290");
  assert.ok(qa, "expected the official Stardust activation-negation analogy to be retrieved");
  assert.ok(qa.cardIds.includes("7734"), "expected <<7734>> to be indexed as a referenced card");
  assert.match(qa.text, /not treated as being on the field/iu);
});

test("grounding_candidate_budget_preserves_faq_rulebook_and_card_text", async () => {
  const noisyRelated = Array.from({ length: 12 }, (_, index) => ({
    id: `related-${index + 1}`,
    type: "related",
    recordType: "qa",
    title: `相似问答 ${index + 1}`,
    text: `只与卡名相关但没有覆盖关键处理的问答 ${index + 1}`,
  }));
  const faq = {
    id: "card-faq-critical",
    type: "faq",
    recordType: "card-faq",
    title: "关键卡片 FAQ",
    text: "关键 FAQ 原文：这个处理仍然进行。",
  };
  const rule = {
    id: "rulebook-critical",
    type: "rulebook",
    recordType: "rulebook",
    title: "关键规则",
    text: "关键规则原文：逐项处理效果。",
  };
  const cardText = {
    id: "card-text-critical",
    type: "card_text",
    title: "关键卡片文本",
    text: "关键卡文原文：然后，挑选一张手牌舍弃。",
  };
  let prompt = "";

  await callRulebookGroundingModel({
    userQuery: "这个效果如何处理？",
    qaEvidence: [...noisyRelated, faq],
    ruleEvidence: [rule],
    cardTexts: [cardText],
    env: { RAG_MAX_QA_GROUNDING_CANDIDATES: "4" },
    modelInvoker: async (request) => {
      prompt = request.prompt;
      return JSON.stringify({ operationChecks: [], overallConclusion: "证据不足。" });
    },
  });

  assert.match(prompt, /card-faq-critical/u);
  assert.match(prompt, /rulebook-critical/u);
  assert.match(prompt, /card-text-critical/u);
  assert.match(prompt, /关键 FAQ 原文/u);
  assert.match(prompt, /关键规则原文/u);
  assert.match(prompt, /关键卡文原文/u);
});
