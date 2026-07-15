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

const ecclesiaRawCard = {
  cid: 22144,
  id: 78397661,
  cn_name: "黑龙之艾克莉西亚",
  jp_name: "黒き竜のエクレシア",
  en_name: "Ecclesia and the Dark Dragon",
  text: {
    types: "[怪兽|效果|同调] 魔法师/光\n[★8] 2500/2500",
    desc: "调整＋调整以外的怪兽1只以上\n这个卡名的①②的效果1回合各能使用1次。",
  },
  data: { type: 8225, atk: 2500, def: 2500, level: 8, race: 2, attribute: 4 },
};

const sacredGarunixRawCard = {
  cid: 19000,
  id: 66431519,
  cn_name: "圣炎王 大鹏不死鸟",
  jp_name: "聖炎王 ガルドニクス",
  en_name: "Sacred Fire King Garunix",
  text: {
    types: "[怪兽|效果] 鸟兽/炎\n[★8] 2700/1700",
    desc: "这个卡名的①②的效果1回合各能使用1次。\n①：自己的炎属性怪兽被破坏的场合才能发动。这张卡从手卡特殊召唤。",
  },
  data: { type: 33, atk: 2700, def: 1700, level: 8, race: 8192, attribute: 4 },
};

const dalviRawCard = {
  cid: 22199,
  id: 16384883,
  cn_name: "绚岚之达维",
  jp_name: "絢嵐たるエルダム",
  en_name: "Radiant Typhoon Eldam",
  text: {
    types: "[怪兽|效果] 兽/风\n[★3] 1300/800",
    desc: "自己墓地有『旋风』存在的场合或者对方场上没有魔法・陷阱卡存在的场合，这张卡可以从手卡特殊召唤。",
  },
  data: { type: 33, atk: 1300, def: 800, level: 3, race: 16384, attribute: 8 },
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
  assert.equal(result.results[0].attribute, "水");
  assert.equal(result.results[0].race, "电子界族");
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

test("baige_common_translation_variant_can_match_card_name", async () => {
  clearBaigeSearchCache();
  const result = await searchCards("黑龙埃克利西亚", {
    fetchImpl: async () => jsonResponse({ result: [ecclesiaRawCard], next: 0 }),
  });

  assert.equal(result.results[0].name, "黑龙之艾克莉西亚");
  assert.ok(result.results[0].confidence >= 0.9);
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

test("parenthesized_card_mentions_are_preserved", () => {
  const resolution = extractRagCards("发动（炎王的孤岛）破坏（炎王神兽 麒麟），检索（圣炎王 大鹏不死鸟）。", { cards: [] });

  assert.deepEqual(resolution.resolvedCards, []);
  assert.deepEqual(resolution.unresolvedMentions.map((item) => item.input), ["炎王的孤岛", "炎王神兽 麒麟", "圣炎王 大鹏不死鸟"]);
});

test("model_card_name_candidates_are_preserved_without_name_signal_filter", () => {
  const resolution = extractRagCards("三一人攻击无效后可以用翻倍机会吗？", {
    cards: [],
    modelCardNameCandidates: [
      { name: "幻影英雄三一人", originalText: "三一人", confidence: "medium" },
      { name: "翻倍机会", originalText: "翻倍机会", confidence: "high" },
    ],
  });

  assert.deepEqual(resolution.unresolvedMentions.map((item) => item.input), ["幻影英雄三一人", "翻倍机会"]);
  assert.equal(resolution.unresolvedMentions[0].source, "model_card_name_extractor");
});

test("baige_search_uses_model_original_text_as_fallback_query", async () => {
  clearBaigeSearchCache();
  const question = "检索圣炎王 大鹏不死鸟的情况。";
  const cardResolution = extractRagCards(question, {
    cards: [],
    modelCardNameCandidates: [
      { name: "炎王神 大鹏不死鸟", originalText: "圣炎王 大鹏不死鸟", confidence: "medium" },
    ],
  });
  const calls = [];
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards: [],
    records: [],
    qaRecords: [],
    fetchImpl: async (url) => {
      calls.push(decodeURIComponent(String(url)).replace(/\+/gu, " "));
      return calls[calls.length - 1].includes("圣炎王 大鹏不死鸟")
        ? jsonResponse({ result: [sacredGarunixRawCard], next: 0 })
        : jsonResponse({ result: [], next: 0 });
    },
  });

  assert.ok(calls.some((url) => url.includes("炎王神 大鹏不死鸟")));
  assert.ok(calls.some((url) => url.includes("圣炎王 大鹏不死鸟")));
  assert.equal(evidence.baigeResolvedCards[0].name, "圣炎王 大鹏不死鸟");
});

test("unquoted_card_mention_stops_before_gameplay_suffix", () => {
  const resolution = extractRagCards("墓地的黑龙埃克利西亚一张里侧魔陷发动2效果，C2那张魔陷发动了。", { cards: [] });

  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "黑龙埃克利西亚"));
  assert.ok(!resolution.unresolvedMentions.some((item) => item.input.includes("一张里侧魔陷")));
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

test("baige_resolved_card_metadata_replaces_the_unresolved_prompt_mention", async () => {
  clearBaigeSearchCache();
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "「绚岚之达维」是什么属性？",
    cards: [],
    records: [],
    qaRecords: [],
    fetchImpl: async () => jsonResponse({ result: [dalviRawCard], next: 0 }),
    rulebookModelInvoker: async () => JSON.stringify({ operationChecks: [], overallConclusion: "卡片资料已找到。" }),
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "绚岚之达维是风属性怪兽。",
        reasoning: ["百鸽卡片资料标明其为风属性。"],
        usedCards: ["绚岚之达维"],
        usedEvidence: [{ id: "card-text-16384883", type: "baige_card_text", title: "绚岚之达维 的卡片文本" }],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.equal(answer.resolvedCards[0].name, "绚岚之达维");
  assert.equal(answer.resolvedCards[0].attribute, "风");
  assert.equal(answer.debug.unresolvedMentions.length, 0);
  assert.match(finalPrompt, /"attribute": "风"/u);
  assert.match(finalPrompt, /"unresolvedMentions": \[\]/u);
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}
