import assert from "node:assert/strict";
import test from "node:test";
import { clearBaigeSearchCache, searchCards } from "../backend/baigeCardProvider.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const packbitDesc = [
  "调整＋调整以外的怪兽1只以上",
  "这个卡名的①②的效果1回合各能使用1次。",
  "①：这张卡同调召唤的场合或者被送去墓地的场合，以自己墓地或对方场上（表侧表示）1只怪兽为对象才能发动。选自己1张手卡丢弃，作为对象的怪兽当作永续陷阱卡使用在原本持有者的魔法与陷阱区域表侧表示放置。",
  "②：这张卡是当作永续陷阱卡使用的场合，自己·对方回合可以发动。自己的魔法与陷阱区域1张表侧表示的怪兽卡特殊召唤。",
].join("\n");

const packbitRawCard = {
  cid: 19497,
  id: 72444406,
  cn_name: "谜式密码大师·紧缩位压缩员",
  sc_name: "谜码圣手・封元",
  nwbbs_n: "谜式密码大师·紧缩位压缩员",
  cnocg_n: "恩尼格码大师 紧缩位压缩员",
  jp_name: "エニグマスター・パックビット",
  en_name: "Enigmaster Packbit",
  text: {
    types: "[怪兽|效果|同调] 电子界/水\n[★8] 2900/2500",
    desc: packbitDesc,
  },
  data: {
    type: 8225,
    atk: 2900,
    def: 2500,
    level: 8,
    race: 16777216,
    attribute: 2,
  },
  html: {
    desc: packbitDesc.replace(/\n/gu, "<br>"),
  },
  weight: 90,
  faqcount: 3,
};

test("baige_search_mock_returns_enigmaster_packbit", async () => {
  clearBaigeSearchCache();
  const calls = [];
  const result = await searchCards("谜式密码大师", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ result: [packbitRawCard], next: 0 });
    },
  });

  assert.equal(result.provider, "baige");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /ygocdb\.com\/api\/v0\/\?search=/u);
  assert.match(decodeURIComponent(calls[0].url), /谜式密码大师/u);
  assert.equal(result.results[0].cnName, "谜式密码大师·紧缩位压缩员");
  assert.equal(result.results[0].enName, "Enigmaster Packbit");
  assert.match(result.results[0].text, /自己的魔法与陷阱区域/u);
  assert.equal(result.results[0].official, false);
  assert.equal(result.results[0].source, "baige");
  assert.ok(result.results[0].raw);
});

test("baige_short_name_can_match_long_card_name", async () => {
  clearBaigeSearchCache();
  const result = await searchCards("谜式密码大师", {
    fetchImpl: async () => jsonResponse({ result: [packbitRawCard], next: 0 }),
  });

  assert.equal(result.results[0].name, "谜式密码大师·紧缩位压缩员");
  assert.ok(result.results[0].confidence >= 0.72);
});

test("baige_exact_full_cn_name_ranks_above_shorter_candidate", async () => {
  clearBaigeSearchCache();
  const shorter = {
    ...packbitRawCard,
    id: 11111111,
    cid: 111,
    cn_name: "谜式密码大师",
    en_name: "Enigmaster",
  };
  const result = await searchCards("谜式密码大师·紧缩位压缩员", {
    fetchImpl: async () => jsonResponse({ result: [shorter, packbitRawCard], next: 0 }),
  });

  assert.equal(result.results[0].name, "谜式密码大师·紧缩位压缩员");
});

test("baige_two_book_title_mentions_are_preserved", () => {
  const resolution = extractRagCards("《凶导的白天底》攻击宣言时发动《宇宙耀变龙》效果。", { cards: [] });

  assert.deepEqual(resolution.resolvedCards, []);
  assert.deepEqual(resolution.unresolvedMentions.map((item) => item.input), ["凶导的白天底", "宇宙耀变龙"]);
});

test("baige_card_text_enters_rag_context", async () => {
  clearBaigeSearchCache();
  const question = "「谜式密码大师」被送去墓地的场合，①效果如何处理？";
  const cardResolution = extractRagCards(question, { cards: [] });
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards: [],
    records: [],
    qaRecords: [],
    fetchImpl: async () => jsonResponse({ result: [packbitRawCard], next: 0 }),
  });

  assert.equal(evidence.baigeResolvedCards[0].name, "谜式密码大师·紧缩位压缩员");
  assert.equal(evidence.cardTexts[0].type, "baige_card_text");
  assert.equal(evidence.cardTexts[0].source, "baige");
  assert.equal(evidence.cardTexts[0].official, false);
  assert.match(evidence.cardTexts[0].text, /永续陷阱卡/u);

  const bundle = buildRagRulingPromptBundle({ userQuery: question, cardResolution, evidence });
  assert.match(bundle.prompt, /baige_card_text/u);
  assert.match(bundle.prompt, /百鸽卡片资料/u);
  assert.equal(evidence.officialQaDirectCandidates.length, 0);
});

test("baige_low_confidence_single_result_is_not_resolved_card", async () => {
  clearBaigeSearchCache();
  const evidence = await retrieveRagEvidence({
    userQuery: "「完全不像谜式密码大师的卡名」可以发动吗？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [{ input: "完全不像谜式密码大师的卡名", reason: "quoted_mention_not_found" }],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [],
    qaRecords: [],
    fetchImpl: async () => jsonResponse({ result: [packbitRawCard], next: 0 }),
  });

  assert.equal(evidence.baigeResolvedCards.length, 0);
  assert.equal(evidence.cardTexts.length, 0);
  assert.ok(evidence.baigeAmbiguousMentions.length >= 1);
});

test("baige_card_text_is_not_official_direct", async () => {
  clearBaigeSearchCache();
  const answer = await answerRagRulingQuestion({
    question: "「谜式密码大师」被送去墓地的场合，①效果如何处理？",
    cards: [],
    records: [],
    qaRecords: [],
    fetchImpl: async () => jsonResponse({ result: [packbitRawCard], next: 0 }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "official_confirmed",
      shortAnswer: "模型错误地声称官方确认。",
      reasoning: ["只检索到了百鸽卡片文本。"],
      usedCards: ["谜式密码大师·紧缩位压缩员"],
      usedEvidence: [{ id: "card-text-72444406", type: "official_qa", title: "谜式密码大师·紧缩位压缩员 的卡片文本" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "high",
    }),
  });

  assert.equal(answer.answerLevel, "rule_analysis");
  assert.ok(answer.riskFlags.includes("official_confirmed_requires_direct_evidence"));
  assert.ok(answer.usedEvidence.some((item) => item.type === "baige_card_text"));
  assert.ok(!answer.usedEvidence.some((item) => item.type === "official_qa"));
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}
