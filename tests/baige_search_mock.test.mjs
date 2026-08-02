import assert from "node:assert/strict";
import test from "node:test";
import { clearBaigeSearchCache, searchCards } from "../backend/baigeCardProvider.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import { canonicalizeNumberedCardPrefixes, hasNumberedCardIdentityConflict } from "../backend/numberedCardIdentity.mjs";

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

const mindScanRawCard = {
  cid: 25000,
  id: 34298391,
  cn_name: "看透心灵之眼",
  sc_name: "心灵透视眼",
  jp_name: "心を見通す眼",
  en_name: "Mind Scan",
  text: {
    types: "[魔法|永续]",
    desc: "自己场上或墓地存在指定系列卡期间，对方必须持续公开全部手牌。",
  },
  data: { type: 131074 },
};

const redLotusRawCard = {
  cid: 8515,
  id: 43262273,
  cn_name: "红莲之指名者",
  sc_name: "红莲指名者",
  md_name: "红莲的指名者",
  nwbbs_n: "红莲之指名者",
  cnocg_n: "红莲的指名者",
  jp_name: "紅蓮の指名者",
  en_name: "Appointer of the Red Lotus",
  text: {
    types: "[陷阱]",
    desc: "①：支付2000基本分，把手卡全部给对方观看才能发动。把对方手卡确认，从那之中选1张直到下次的对方结束阶段除外。",
  },
  data: { type: 4 },
  weight: 50,
};

const numberedRawCards = [
  { cid: 10659, id: 49456901, cn_name: "混沌No.104 假面魔蹈士 黑影", text: { desc: "旧卡干扰项。" } },
  { cid: 23364, id: 101306042, cn_name: "No.104 假面魔蹈士 闪光·杠然", text: { desc: "新卡文本。" } },
  { cid: 10684, id: 55888045, cn_name: "混沌No.106 熔岩掌 巨手·红掌", text: { desc: "新卡文本。" } },
];

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
  assert.ok(result.results[0].confidence >= 0.8);
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

test("model_card_name_candidates_keep_the_user_surface_as_identity_and_the_expansion_as_search_text", () => {
  const resolution = extractRagCards("三一人攻击无效后可以用翻倍机会吗？", {
    cards: [],
    modelCardNameCandidates: [
      { name: "幻影英雄三一人", originalText: "三一人", confidence: "medium" },
      { name: "翻倍机会", originalText: "翻倍机会", confidence: "high" },
    ],
  });

  assert.deepEqual(resolution.unresolvedMentions.map((item) => item.input), ["三一人", "翻倍机会"]);
  assert.equal(resolution.unresolvedMentions[0].source, "model_card_name_extractor");
  assert.deepEqual(resolution.unresolvedMentions[0].searchTexts, ["幻影英雄三一人"]);
});

test("model card-name extraction cannot add a card that has no surface in the user question", async () => {
  const data = await loadRagData();
  const resolution = extractRagCards(
    "相手のモンスター効果にチェーンして「リビングデッドの呼び声」で「インスペクト・ボーダー」を特殊召喚した場合、どうなりますか？",
    {
      cards: data.cards,
      modelCardNameCandidates: [
        { name: "威光魔人", originalText: "威光魔人", confidence: "high" },
        { name: "リビングデッドの呼び声", originalText: "リビングデッドの呼び声", confidence: "high" },
        { name: "インスペクト・ボーダー", originalText: "インスペクト・ボーダー", confidence: "high" },
      ],
    },
  );

  assert.ok(!resolution.resolvedCards.some((card) => String(card.id) === "11063"));
  assert.deepEqual(
    new Set(resolution.resolvedCards.filter((card) => card.resolutionSource === "query").map((card) => String(card.id))),
    new Set(["4989", "13405"]),
  );
});

test("baige_search_uses_the_user_surface_before_a_model_expansion", async () => {
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

  assert.ok(calls.some((url) => url.includes("圣炎王 大鹏不死鸟")));
  assert.ok(!calls.some((url) => url.includes("炎王神 大鹏不死鸟")));
  assert.equal(evidence.baigeResolvedCards[0].name, "圣炎王 大鹏不死鸟");
});

test("baige_unique_ordered_subsequence_accepts_a_two_character_nickname", async () => {
  clearBaigeSearchCache();
  const result = await searchCards("红指", {
    fetchImpl: async () => jsonResponse({ result: [redLotusRawCard], next: 1 }),
  });

  assert.equal(result.results[0].name, "红莲之指名者");
  assert.ok(result.results[0].confidence >= 0.72);
  assert.equal(result.results[0].confidenceSource, "baige_unique_ordered_subsequence");
  assert.equal(result.results[0].providerResultCount, 1);
});

test("unquoted_colloquial_activation_subject_resolves_by_surface_before_a_wrong_model_guess", async () => {
  clearBaigeSearchCache();
  const question = "看透心灵之眼的①效果适用的情况下，红指还能发出来吗";
  const redReboot = {
    id: "23002292",
    name: "红色重启",
    aliases: ["红色重启", "レッド・リブート", "Red Reboot"],
    effectText: "从手卡发动的场合，支付一半基本分。",
  };
  const mindScan = {
    id: "34298391",
    name: "看透心灵之眼",
    aliases: ["看透心灵之眼", "心灵透视眼", "心を見通す眼"],
    effectText: "对方必须持续公开全部手牌。",
  };
  const cardResolution = extractRagCards(question, {
    cards: [mindScan, redReboot],
    modelCardNameCandidates: [
      { name: "看透心灵之眼", originalText: "看透心灵之眼", confidence: "high" },
      { name: "红色重启", originalText: "红指", confidence: "high" },
    ],
  });

  assert.ok(cardResolution.resolvedCards.some((card) => card.name === "看透心灵之眼"));
  assert.ok(!cardResolution.resolvedCards.some((card) => card.name === "红色重启"));
  assert.ok(cardResolution.unresolvedMentions.some((item) => item.input === "红指"));

  const calls = [];
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards: [mindScan, redReboot],
    records: [],
    qaRecords: [],
    fetchImpl: async (url) => {
      const decoded = decodeURIComponent(String(url)).replace(/\+/gu, " ");
      calls.push(decoded);
      return decoded.includes("红指")
        ? jsonResponse({ result: [redLotusRawCard], next: 1 })
        : jsonResponse({ result: [], next: 0 });
    },
  });

  assert.equal(evidence.baigeResolvedCards[0].name, "红莲之指名者");
  assert.ok(!evidence.retrievedCards.some((card) => card.name === "红色重启"));
  assert.ok(calls.some((url) => url.includes("红指")));
  assert.ok(!calls.some((url) => url.includes("红色重启")));
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

test("a newly indexed continuous effect feeds generic hand-visibility legality reasoning", async () => {
  clearBaigeSearchCache();
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "我方看透心灵之眼适用中，我方有手牌，我方能发动红莲的指名者吗？",
    cards: [{
      id: "8515",
      name: "红莲指名者",
      aliases: ["红莲指名者", "紅蓮の指名者"],
      effectText: "支付2000基本分，将手牌全部出示给对手可以发动。确认对方的手牌，从其中选1张除外。",
    }, {
      id: "34298391",
      name: "心灵透视眼",
      cnName: "心灵透视眼",
      jaName: "心を見通す眼",
      enName: "Mind Scan",
      aliases: ["心灵透视眼", "心を見通す眼", "Mind Scan"],
      effectText: "自己场上或墓地存在指定系列卡期间，对方必须持续公开全部手牌。",
    }],
    records: [{
      id: "card-faq-8515-1",
      recordType: "card-faq",
      type: "faq",
      title: "红莲指名者 FAQ",
      cardIds: ["8515"],
      cards: ["红莲指名者"],
      conclusion: "自己的手牌有1张以上已经因其他卡的效果公开时，不能发动。",
    }],
    qaRecords: [],
    fetchImpl: async (url) => (
      String(url).includes("ygocdb.com/api/")
        ? jsonResponse({ result: [mindScanRawCard], next: 0 })
        : jsonResponse({ result: [], next: 0 })
    ),
    env: {
      MODEL_PROVIDER: "mock",
      RAG_MODEL_PROVIDER: "mock",
      RAG_LIVE_OFFICIAL_QA: "0",
      OCG_ENGINE_ENABLED: "0",
    },
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "不能发动。自己的手牌已经因其他卡的效果公开时，不能再进行『将手牌全部出示给对手』这一发动手续。",
        reasoning: [
          "红莲指名者要求把自己的全部手牌出示给对手后才能发动。",
          "相关 FAQ 明确：自己的手牌已有1张以上因其他卡的效果公开时，不能发动。",
        ],
        usedCards: ["红莲指名者", "看透心灵之眼"],
        usedEvidence: [{ id: "card-faq-8515-1", type: "official_qa", title: "红莲指名者 FAQ" }],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "high",
      });
    },
  });

  assert.match(answer.shortAnswer, /^不能发动/u);
  assert.ok(answer.resolvedCards.some((card) => card.name === "看透心灵之眼"));
  assert.equal(answer.debug.unresolvedMentions.length, 0);
  assert.match(finalPrompt, /自己的手牌有1张以上已经因其他卡的效果公开时，不能发动/u);
  assert.match(finalPrompt, /将手牌全部出示给对手/u);
  assert.equal(answer.debug.deterministicDecision, null);
  assert.notEqual(answer.debug.modelUsed, "deterministic-ruling-reasoner");
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
test("baige_retries_generic_name_fragments_without_card_specific_rewrites", async () => {
  clearBaigeSearchCache();
  const calls = [];
  const result = await searchCards("黑龙 埃克利西亚", {
    fetchImpl: async (url) => {
      const searchQuery = new URL(String(url)).searchParams.get("search");
      calls.push(searchQuery);
      return searchQuery === "黑龙"
        ? jsonResponse({ result: [ecclesiaRawCard], next: 0 })
        : jsonResponse({ result: [], next: 0 });
    },
  });

  assert.ok(calls.length >= 2);
  assert.ok(calls.includes("黑龙"));
  assert.ok(!calls.some((query) => query.includes("艾克莉西娅")));
  assert.equal(result.results[0].name, "黑龙之艾克莉西亚");
  assert.match(result.warnings.join("\n"), /baige_fallback_query_used/u);
});

test("ordinary_fusion_monster_phrase_does_not_resolve_the_fusion_spell", async () => {
  const data = await loadRagData();
  const result = extractRagCards("墓地没有融合怪，对方发动一张可以发动的魔法卡。", {
    cards: data.cards,
  });

  assert.ok(!result.resolvedCards.some((card) => card.name === "融合"));
  assert.ok(!result.unresolvedMentions.some((item) => item.input === "融合"));
});

test("albaz_activation_rechecks_continuous_effects_after_paying_cost", async () => {
  const data = await loadRagData();
  const question = [
    "我方额外卡组有【冰剑龙 幻冰龙】，手牌有【教导的圣女 艾克莉西亚】和【阿不思的落胤】各1张。",
    "对方场上只有表侧表示的【吞食圣痕之龙】1只，双方墓地没有卡。",
    "我召唤阿不思的落胤后，可以舍弃教导的圣女发动效果并融合召唤冰剑龙吗？",
  ].join("");
  let finalPrompt = "";

  const answer = await answerRagRulingQuestion({
    question,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    fetchImpl: async () => jsonResponse({ result: [], next: 0 }),
    cardModelInvoker: async () => JSON.stringify({
      cardNames: [
        { name: "冰剑龙 镜翠幻种", originalText: "冰剑龙 幻冰龙", confidence: "high" },
        { name: "教导之圣女 艾克利西亚", originalText: "教导的圣女 艾克莉西亚", confidence: "high" },
        { name: "阿尔白斯之落胤", originalText: "阿不思的落胤", confidence: "high" },
        { name: "吞喰圣痕之龙", originalText: "吞食圣痕之龙", confidence: "high" },
      ],
    }),
    ruleModelInvoker: async () => JSON.stringify({ queries: [] }),
    rulebookModelInvoker: async ({ prompt, task }) => {
      const marker = task === "rulebook_constraint_repair" ? "本次聚焦输入：\n" : "本次输入：\n";
      const payload = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
      const priorities = payload.priorityConstraintCandidates || [];
      const evidence = [...(payload.evidenceCandidates || []), ...(payload.cardTexts || [])];
      const albaz = evidence.find((item) => String(item.id).includes("15245"));
      const mirrorjade = evidence.find((item) => String(item.id).includes("17069"));
      const devourer = evidence.find((item) => String(item.id).includes("22090"));
      const citation = (item, application) => ({
        id: item.id,
        quote: String(item.text || "").slice(0, 140),
        application,
      });
      return JSON.stringify({
        constraintReviews: priorities.map((item, index) => ({
          evidenceId: item.id,
          operationId: "constraint-" + (index + 1),
          action: "核对限制性规则",
          relevance: "not_applicable",
          consequence: "none",
          conclusion: "该限制规则描述的操作或区域条件与题目当前步骤不同。",
          quote: String(item.text || "").slice(0, 140),
          application: "题目明确卡片所在区域和本次融合步骤；该候选的阻断条件没有在当前事实中成立。",
        })),
        operationChecks: [
          {
            operationId: "activate-albaz",
            step: 1,
            action: "召唤成功后舍弃1张手牌发动阿尔白斯之落胤",
            legalityQuestion: "发动条件与cost是否满足",
            status: "legal",
            conclusion: "可以发动并舍弃手牌中的艾克利西亚。",
            reasoning: ["落胤已召唤成功，手牌也有可舍弃的卡。"],
            citations: [citation(albaz, "卡片文本写明召唤成功后舍弃1张手牌发动。")],
            missingFacts: [],
          },
          {
            operationId: "check-devourer-immunity",
            step: 2,
            action: "核对吞喰圣痕之龙的抗性是否适用",
            legalityQuestion: "支付cost后艾克利西亚是否满足场上或墓地条件",
            status: "legal",
            conclusion: "支付cost后艾克利西亚进入墓地，吞喰圣痕之龙的抗性在处理前开始适用。",
            reasoning: ["支付cost造成的位置变化立即成立，持续效果按支付后的场面重新判断。"],
            citations: [citation(devourer, "抗性要求场上或墓地存在艾克利西亚；作为cost舍弃后，她已经在墓地。")],
            missingFacts: [],
          },
          {
            operationId: "fusion-summon-mirrorjade",
            step: 3,
            action: "处理阿尔白斯之落胤的融合召唤效果",
            legalityQuestion: "支付cost后的场面能否完成融合召唤",
            status: "conditional",
            conclusion: "吞喰圣痕之龙此时不受阿尔白斯之落胤的效果影响，不能用于该效果的融合素材处理，因此不进行融合召唤。",
            reasoning: ["卡种本来满足冰剑龙素材要求，但处理时新适用的抗性使阿尔白斯的效果不能使用该怪兽。"],
            citations: [
              citation(devourer, "艾克利西亚进入墓地后，此卡不受自身以外的效果影响。"),
              citation(mirrorjade, "冰剑龙的素材要求虽包含融合怪兽，但仍需由阿尔白斯的效果进行素材处理。"),
            ],
            missingFacts: [],
          },
        ],
        overallConclusion: "可以发动并舍弃手牌作为cost；处理时不进行融合召唤。",
      });
    },
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "可以发动。舍弃教导之圣女作为cost后，吞喰圣痕之龙的抗性开始适用，因此处理时不进行融合召唤。",
        reasoning: [
          "发动时可以舍弃手牌中的教导之圣女作为cost；支付后她立即进入墓地。",
          "教导之圣女进入墓地后，吞喰圣痕之龙的②在阿尔白斯效果处理前开始适用，使其不受阿尔白斯效果影响，因此不进行融合召唤。",
        ],
        usedCards: ["阿尔白斯之落胤", "教导之圣女 艾克利西亚", "吞喰圣痕之龙", "冰剑龙 镜翠幻种"],
        usedEvidence: [
          { id: "card-text-15245", type: "card_text", title: "阿尔白斯之落胤 的卡片文本" },
          { id: "card-text-22090", type: "card_text", title: "吞喰圣痕之龙 的卡片文本" },
          { id: "card-text-17069", type: "card_text", title: "冰剑龙 镜翠幻种 的卡片文本" },
        ],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.match(answer.shortAnswer, /^可以发动/u);
  assert.match(answer.shortAnswer, /不进行融合召唤/u);
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.equal(typeof answer.debug.promptTruncated, "boolean");
  assert.equal(answer.debug.retrievalCounts.unresolvedOperationConstraints, 0);
  assert.ok(!answer.riskFlags.includes("unresolved_restrictive_evidence_blocked_positive_answer"));
  assert.deepEqual(
    new Set(answer.resolvedCards.map((card) => card.id)),
    new Set(["15239", "15245", "17069", "22090"]),
  );
  assert.match(finalPrompt, /支付cost后艾克利西亚进入墓地/u);
  assert.match(finalPrompt, /按支付后的场面重新判断/u);
});

test("numbered card identity keeps No and CNo families distinct", () => {
  const question = "用场上的No.104 假面魔蹈士 闪光·杠然为素材超量召唤混沌No.106 熔岩掌 巨手·红掌，106发动除外对方卡组的效果。";
  const resolution = extractRagCards(question, { cards: [] });
  assert.deepEqual(resolution.unresolvedMentions.map((item) => item.input), [
    "No.104 假面魔蹈士 闪光·杠然",
    "混沌No.106 熔岩掌 巨手·红掌",
  ]);
  assert.equal(canonicalizeNumberedCardPrefixes("CNo.106 熔岩掌 巨手·红掌"), canonicalizeNumberedCardPrefixes("混沌No.106 熔岩掌 巨手·红掌"));
  assert.equal(hasNumberedCardIdentityConflict("No.104 假面魔蹈士 闪光·杠然", "混沌No.104 假面魔蹈士 黑影"), true);
});

test("numbered identity anchors localized variants without collapsing a different same-number form", async () => {
  const data = await loadRagData();
  const question = "场上的No.104 假面魔踏士 闪光·杖然发动效果。混沌No.106 熔岩掌 巨手·红掌也发动效果。";
  const resolution = extractRagCards(question, { cards: data.cards });

  assert.ok(resolution.resolvedCards.some((card) => (
    card.id === "10684"
    && card.resolutionSource === "numbered_identity_unique_localized_variant"
    && card.numberedIdentityNameMismatch === true
  )));
  assert.ok(!resolution.resolvedCards.some((card) => card.id === "10658" || card.id === "23364"));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input.includes("No.104")));

  clearBaigeSearchCache();
  const calls = [];
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: resolution,
    cards: data.cards,
    records: [],
    qaRecords: [],
    fetchImpl: async (url) => {
      const decoded = decodeURIComponent(String(url)).replace(/\+/gu, " ");
      calls.push(decoded);
      if (/No\.104 闪光 杖然/iu.test(decoded)) return jsonResponse({ result: [numberedRawCards[1]], next: 1 });
      if (/106/u.test(decoded)) return jsonResponse({ result: [numberedRawCards[2]], next: 1 });
      return jsonResponse({ result: [], next: 0 });
    },
  });

  assert.ok(calls.some((url) => /No\.104 闪光 杖然/iu.test(url)));
  assert.ok(evidence.baigeResolvedCards.some((card) => card.id === "101306042"));
  assert.ok(!evidence.retrievedCards.some((card) => card.id === "10658"));
});

test("baige rejects conflicting numbered families and keeps new card ids", async () => {
  for (const [query, expected] of [
    ["No.104 假面魔蹈士 闪光·杠然", { id: "101306042", cid: 23364 }],
    ["混沌No.106 熔岩掌 巨手·红掌", { id: "55888045", cid: 10684 }],
  ]) {
    clearBaigeSearchCache();
    const result = await searchCards(query, {
      fetchImpl: async () => jsonResponse({ result: numberedRawCards, next: 0 }),
    });
    assert.equal(result.results[0].id, expected.id);
    assert.equal(result.results[0].cid, expected.cid);
    assert.equal(result.results.some((card) => card.cid === 10659), false);
  }
});

test("baige keeps trying full numbered-name variants after a conflicting payload", async () => {
  clearBaigeSearchCache();
  let calls = 0;
  const result = await searchCards("混沌No.106 熔岩掌 巨手·红掌", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ result: [numberedRawCards[0]], next: 0 })
        : jsonResponse({ result: [numberedRawCards[2]], next: 0 });
    },
  });
  assert.ok(calls >= 2);
  assert.equal(result.results[0].cid, 10684);
  assert.match(result.warnings.join("\n"), /numbered_identity_conflict/u);
});
