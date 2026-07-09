import assert from "node:assert/strict";
import test from "node:test";
import { extractQuotedMentions, extractRagCards, extractUserProvidedCardTextBlocks } from "../backend/ragCardExtractor.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { callCardNameExtractionModel, callRagModel, callRuleQueryExtractionModel, estimateDeepSeekCostCny, getRagBudgetStatus, resetRagBudget, resolveRagProvider } from "../backend/ragModelClient.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const cards = [
  {
    id: "100",
    name: "测试龙",
    cnName: "测试龙",
    jaName: "テスト・ドラゴン",
    enName: "Test Dragon",
    cardType: "monster",
    effectText: "①：自己主要阶段可以发动。抽1张卡。",
    aliases: ["测试龙", "Test Dragon", "テスト・ドラゴン"],
    sourceUrl: "https://example.test/card/100",
  },
];

const secondCard = {
  id: "200",
  name: "未收录测试卡",
  cnName: "未收录测试卡",
  jaName: "未収録テストカード",
  enName: "Unlisted Test Card",
  cardType: "monster",
  effectText: "①：对方怪兽攻击宣言时可以发动。那次攻击无效。",
  aliases: ["未收录测试卡", "未収録テストカード", "Unlisted Test Card"],
  sourceUrl: "https://example.test/card/200",
};

const dogmatikaCard = {
  id: "18176",
  name: "凶教导之天底 阿尔白・佐亚",
  cnName: "凶教导之天底 阿尔白・佐亚",
  jaName: "凶導の白き天底",
  enName: "Dogmatika Alba Zoa",
  cardType: "monster",
  effectText: "仪式/效果文本。",
  aliases: ["凶導の白き天底"],
};

const records = [
  {
    id: "faq-test-dragon-1",
    recordType: "card-faq",
    title: "测试龙 FAQ 1",
    cards: ["测试龙"],
    cardIds: ["100"],
    text: "【①の効果について】自己主要阶段可以发动的起动效果。",
    sourceUrl: "https://example.test/faq/100/1",
  },
  {
    id: "raw-chain-note",
    recordType: "related",
    title: "连锁处理资料",
    text: "连锁处理中对象离场时，需要按效果处理时的状态确认。",
  },
];

const qaRecords = [
  {
    id: "qa-related-test-dragon",
    recordType: "qa",
    title: "测试龙相似问答",
    question: "「测试龙」在主要阶段可以发动吗？",
    answer: "可以发动。",
    text: "「测试龙」在主要阶段可以发动吗？ 可以发动。",
    cards: ["测试龙"],
    cardIds: ["100"],
  },
];

test("rag_pipeline_returns_answer_with_mock_model", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords,
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以给出未确认分析。",
      reasoning: ["检索到了卡片文本和相关 FAQ。"],
      usedCards: ["测试龙"],
      usedEvidence: [{ id: "card-text-100", type: "card_text", title: "测试龙 的卡片文本" }],
      missingInfo: [],
      riskFlags: ["no_official_direct_qa"],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.equal(answer.mode, "rag_baseline");
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.match(answer.shortAnswer, /未确认分析/u);
  assert.equal(answer.debug.dryRun, false);
});

test("quoted_card_mentions_extract_all", () => {
  const resolution = extractRagCards("「测试龙」攻击宣言时，能否连锁「未知卡名」？", { cards, maxCards: 6 });
  const totalMentions = resolution.resolvedCards.length + resolution.unresolvedMentions.length + resolution.ambiguousMentions.length;
  assert.equal(totalMentions >= 2, true);
  assert.equal(resolution.resolvedCards[0].name, "测试龙");
  assert.equal(resolution.unresolvedMentions[0].input, "未知卡名");
});

test("extracts_user_provided_card_text_block", () => {
  const blocks = extractUserProvidedCardTextBlocks("【未发售测试龙】\n①：自己主要阶段可以发动。抽1张卡。\n②：这张卡被送去墓地的场合可以发动。");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, "未发售测试龙");
  assert.match(blocks[0].text, /①：自己主要阶段/u);
  assert.match(blocks[0].text, /②：这张卡/u);
  assert.equal(blocks[0].source, "user_provided_text");
  assert.equal(blocks[0].official, false);
  const bundle = buildRagRulingPromptBundle({
    userQuery: "未发售测试龙如何处理？",
    evidence: {
      cardTexts: [],
      userProvidedCardTexts: [{
        id: "user-card-text-test",
        type: "user_provided_text",
        title: "未发售测试龙 的用户提供文本",
        cards: ["未发售测试龙"],
        text: blocks[0].text,
        source: "user_provided_text",
        official: false,
        isDirect: false,
      }],
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      retrievalWarnings: [],
    },
  });
  assert.match(bundle.prompt, /userProvidedCardTexts/u);
  assert.match(bundle.prompt, /不是官方 direct evidence/u);
});

test("quoted_mentions_all_preserved", () => {
  const mentions = extractQuotedMentions("【A卡】《B卡》「C卡」『D卡』[E卡]“F卡”\"G卡\"'H卡'");
  assert.deepEqual(mentions, ["A卡", "B卡", "C卡", "D卡", "E卡", "F卡", "G卡", "H卡"]);
});

test("unquoted_card_mentions_seed_retrieval_candidates", () => {
  const resolution = extractRagCards("对方发动了手卡破械童子童的效果，要将场上的破械神露天阙序破坏，对方的破械童子罗安能特殊召唤吗？", { cards: [], maxCards: 8 });
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械童子童"));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械神露天阙序"));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械童子罗安"));
});

test("traditional_unquoted_card_name_resolves_to_local_card", () => {
  const resolution = extractRagCards("对方发动破械雙王神來迎的效果。", {
    cards: [{
      id: "300",
      name: "破械双王神 来迎",
      cnName: "破械双王神 来迎",
      jaName: "破械雙王神ライゴウ",
      aliases: ["破械双王神 来迎", "破械雙王神ライゴウ"],
      effectText: "效果文本。",
    }],
    maxCards: 4,
  });
  assert.equal(resolution.resolvedCards[0].name, "破械双王神 来迎");
});

test("ocg_name_normalization_resolves_common_variants", () => {
  const resolution = extractRagCards("「凶导的白天底」攻击宣言时触发「测试龙」效果。", { cards: [...cards, dogmatikaCard], maxCards: 6 });
  assert.ok(resolution.resolvedCards.some((card) => card.name === "凶教导之天底 阿尔白・佐亚"));
  assert.ok(resolution.resolvedCards.some((card) => card.name === "测试龙"));
});

test("unresolved_new_card_with_text_can_be_analyzed", async () => {
  const question = "【未发售测试龙】\n①：对方怪兽攻击宣言时可以发动。那次攻击无效。\n此时这张卡的效果能否处理？";
  const answer = await answerRagRulingQuestion({
    question,
    cards: [],
    records: [],
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以基于用户提供文本给出未确认分析。",
      reasoning: ["题目中提供了完整效果文本。"],
      usedCards: ["未发售测试龙"],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.ok(answer.usedEvidence.some((item) => item.type === "user_provided_text"));
  assert.ok(answer.riskFlags.includes("user_provided_text_not_official"));
  assert.equal(answer.debug.retrievalCounts.userProvidedCardTexts, 1);
  assert.equal(answer.debug.unresolvedMentions[0].input, "未发售测试龙");
});

test("user_provided_text_not_official_confirmed", async () => {
  const answer = await answerRagRulingQuestion({
    question: "《未发售仪式怪兽》\n效果：①：这张卡特殊召唤成功的场合可以发动。对方场上的卡全部破坏。",
    cards: [],
    records: [],
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "official_confirmed",
      shortAnswer: "模型错误地声称官方确认。",
      reasoning: ["只有用户提供文本。"],
      usedCards: ["未发售仪式怪兽"],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "high",
    }),
  });
  assert.notEqual(answer.answerLevel, "official_confirmed");
  assert.ok(answer.riskFlags.includes("official_confirmed_requires_direct_evidence"));
  assert.ok(answer.riskFlags.includes("user_provided_text_not_official"));
  assert.ok(answer.usedEvidence.some((item) => item.type === "user_provided_text"));
});

test("rag_does_not_require_database_match_when_user_text_present", async () => {
  const answer = await answerRagRulingQuestion({
    question: "未收录新卡：\n①：自己主要阶段可以发动。从卡组把1张卡加入手卡。\n这个效果能否在主要阶段2发动？",
    cards: [],
    records: [],
    qaRecords: [],
    dryRun: true,
    env: {},
  });
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.ok(answer.resolvedCards.some((card) => card.name === "未收录新卡" && card.source === "user_provided_text"));
  assert.ok(answer.usedEvidence.some((item) => item.type === "user_provided_text"));
  assert.ok(!answer.riskFlags.includes("card_name_not_resolved"));
});

test("rag_pipeline_does_not_require_effect_template", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "low_confidence_analysis",
      shortAnswer: "没有模板也不会直接 insufficient。",
      reasoning: ["RAG baseline 只依赖检索资料。"],
      usedCards: ["测试龙"],
      usedEvidence: [{ id: "card-text-100", type: "card_text", title: "测试龙 的卡片文本" }],
      missingInfo: [],
      riskFlags: ["card_text_only"],
      confidenceSelfEstimate: "low",
    }),
  });
  assert.notEqual(answer.shortAnswer, "insufficient");
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.ok(answer.riskFlags.includes("low_confidence_upgraded_to_rule_analysis_with_card_text"));
});

test("rag_pipeline_includes_card_text_when_card_resolved", async () => {
  const answer = await answerRagRulingQuestion({
    question: "Test Dragon 的效果能发动吗？",
    cards,
    records,
    qaRecords: [],
    dryRun: true,
    env: {},
  });
  assert.equal(answer.resolvedCards[0].name, "测试龙");
  assert.ok(answer.usedEvidence.some((item) => item.id === "card-text-100"));
  assert.ok(answer.usedEvidence.some((item) => item.sourceUrl === "https://example.test/card/100"));
  assert.equal(answer.debug.retrievalCounts.cardTexts > 0, true);
  assert.equal(typeof answer.debug.promptChars, "number");
});

test("card_name_extractor_uses_dedicated_flash_model", async () => {
  const calls = [];
  const result = await callCardNameExtractionModel({
    userQuery: "测式龙的①效果可以发动吗？",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "deepseek-pro-test",
      DEEPSEEK_CARD_MODEL: "deepseek-flash-test",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ cardNames: [{ name: "测试龙", originalText: "测式龙", confidence: "high" }] }) } }],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      });
    },
  });
  assert.equal(result.providerUsed, "deepseek");
  assert.equal(result.modelUsed, "deepseek-flash-test");
  assert.equal(calls[0].body.model, "deepseek-flash-test");
  assert.equal(calls[0].body.max_tokens, 800);
  assert.deepEqual(result.candidates.map((item) => item.name), ["测试龙"]);
});

test("rule_query_extractor_uses_lightweight_model", async () => {
  const calls = [];
  const result = await callRuleQueryExtractionModel({
    userQuery: "场上只有正在处理的陷阱时，返回魔法陷阱的效果能否处理？",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "deepseek-pro-test",
      DEEPSEEK_CARD_MODEL: "deepseek-flash-test",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ ruleQueries: [{ query: "正在处理的通常陷阱 回到手卡", reason: "检索处理后区域", confidence: "high" }] }) } }],
        usage: { prompt_tokens: 25, completion_tokens: 8 },
      });
    },
  });
  assert.equal(result.providerUsed, "deepseek");
  assert.equal(result.modelUsed, "deepseek-flash-test");
  assert.equal(calls[0].body.model, "deepseek-flash-test");
  assert.deepEqual(result.queries.map((item) => item.query), ["正在处理的通常陷阱 回到手卡"]);
});

test("rag_pipeline_uses_model_card_name_candidates_before_retrieval", async () => {
  const answer = await answerRagRulingQuestion({
    question: "测式龙的①效果可以发动吗？",
    cards,
    records,
    qaRecords: [],
    cardModelInvoker: async () => JSON.stringify({
      cardNames: [{ name: "测试龙", originalText: "测式龙", confidence: "high" }],
    }),
    modelInvoker: async () => JSON.stringify(modelJson("根据测试龙文本可以分析。")),
  });
  assert.ok(answer.resolvedCards.some((card) => card.name === "测试龙"));
  assert.ok(answer.debug.modelCardNameCandidates.some((item) => item.name === "测试龙"));
  assert.equal(answer.debug.cardNameModelUsed, "mock-card-extractor");
  assert.ok(answer.usedEvidence.some((item) => item.id === "card-text-100"));
});

test("rag_pipeline_uses_model_rule_queries_for_related_rules", async () => {
  const answer = await answerRagRulingQuestion({
    question: "场上只有正在处理的陷阱时，返回魔法陷阱的效果能否处理？",
    cards: [],
    records: [{
      id: "rule-activated-trap-location",
      recordType: "related",
      title: "处理中的陷阱和回到手卡",
      text: "正在处理的通常陷阱和处理完毕后已经送去墓地的通常陷阱，不应当作为场上卡片进行回到手卡处理。",
      sourceUrl: "https://example.test/rules/activated-trap-location",
    }],
    qaRecords: [],
    ruleModelInvoker: async () => JSON.stringify({
      ruleQueries: [{ query: "正在处理的通常陷阱 回到手卡", reason: "检索规则资料", confidence: "high" }],
    }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "low_confidence_analysis",
      shortAnswer: "根据相关规则资料，不能直接把该陷阱当作场上卡返回。",
      reasoning: ["规则检索命中了处理中的陷阱位置资料。"],
      usedCards: [],
      usedEvidence: [{ id: "rule-activated-trap-location", type: "related", title: "处理中的陷阱和回到手卡" }],
      missingInfo: [],
      riskFlags: ["no_official_direct_qa"],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.ok(answer.debug.modelRuleSearchQueries.some((item) => item.query.includes("通常陷阱")));
  assert.equal(answer.debug.retrievalCounts.rawRelatedEvidence > 0, true);
  assert.ok(answer.usedEvidence.some((item) => item.id === "rule-activated-trap-location"));
});

test("rag_pipeline_does_not_invent_rule_guard_evidence", async () => {
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: [
      {
        id: "13631",
        name: "无限泡影",
        cnName: "无限泡影",
        cardType: "通常陷阱",
        effectText: "以对方场上1只表侧表示怪兽为对象才能发动。那只怪兽的效果直到回合结束时无效。",
        aliases: ["无限泡影"],
      },
      {
        id: "22130",
        name: "天雷之双风神 息那",
        cnName: "天雷之双风神 息那",
        cardType: "怪兽",
        effectText: "自己场上存在风属性怪兽，且对手发动魔法・陷阱・怪兽的效果时可以发动。从手牌将此卡特殊召唤。然后，根据该对手的效果的种类，适用以下效果。●魔法・陷阱：将场上的魔法・陷阱卡全部放回手牌。",
        aliases: ["天雷之双风神"],
      },
    ],
    records: [],
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动并把无限泡影返回手卡。",
      reasoning: ["模型错误地把正在发动的通常陷阱当作可返回的场上魔陷。"],
      usedCards: ["无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: "card-text-13631", type: "card_text", title: "无限泡影 的卡片文本" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.equal(answer.shortAnswer, "可以发动并把无限泡影返回手卡。");
  assert.ok(!answer.usedEvidence.some((item) => item.type === "rule_principle" || item.id === "rule-principle-non-continuous-spell-trap-return"));
  assert.ok(!answer.riskFlags.includes("derived_rule_guard_applied"));
});

test("rulebook_context_snippet_enters_rag_context", async () => {
  const longRuleText = [
    "Contents\n\n Menu\n\n Skip to content\n\n 这里是很长的导航文本，不应该作为主要 evidence 进入 prompt。",
    "战斗阶段流程",
    "多次攻击的叠加",
    "相同攻击次数的效果不会叠加，不同次数效果叠加后，可以作最大次数的攻击。",
    "已经适用了『只再1次可以攻击』『只再1次可以继续攻击』『可以继续攻击』的效果的怪兽，已经是可以攻击2次的怪兽，不能再适用『可以作2次攻击』的效果。",
  ].join("\n\n");
  const evidence = await retrieveRagEvidence({
    userQuery: "翻倍机会无效了一次攻击后，能不能再叠加成攻击三次？",
    cards: [],
    records: [{
      id: "ocg-rule:c03/battle",
      recordType: "rule-doc",
      title: "战斗阶段流程",
      text: longRuleText,
      sourceUrl: "https://example.test/rule/battle",
      status: "current",
    }],
    qaRecords: [],
    ruleSearchQueries: [],
  });

  assert.ok(evidence.ruleSearchQueries.some((item) => item.query.includes("多次攻击的叠加")));
  assert.equal(evidence.rawRelatedEvidence[0].type, "rulebook");
  assert.match(evidence.rawRelatedEvidence[0].text, /相同攻击次数的效果不会叠加/u);
  assert.doesNotMatch(evidence.rawRelatedEvidence[0].text, /Skip to content/u);

  const bundle = buildRagRulingPromptBundle({ userQuery: "翻倍机会无效攻击后能攻击三次吗？", evidence });
  assert.match(bundle.prompt, /rulebook/u);
  assert.match(bundle.prompt, /相同攻击次数的效果不会叠加/u);
});

test("card_text_without_official_qa_can_answer_rule_analysis", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」在没有官方直接裁定时怎么处理？",
    cards,
    records: [],
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "needs_more_info",
      shortAnswer: "当前资料不足，无法给出可靠裁定分析。",
      reasoning: [],
      usedCards: [],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "low",
    }),
  });
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.match(answer.shortAnswer, /未命中官方直接|未确认分析/u);
  assert.ok(answer.riskFlags.includes("needs_more_info_upgraded_to_rule_analysis_with_card_text"));
  assert.ok(answer.usedEvidence.some((item) => item.type === "card_text"));
});

test("rag_preserves_card_dossier_data", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」和「未收录测试卡」如何互动？",
    cards: [...cards, secondCard],
    records: [],
    qaRecords: [],
    dryRun: true,
    env: {},
  });
  assert.equal(answer.resolvedCards.length >= 2, true);
  assert.ok(answer.resolvedCards.some((card) => card.name === "测试龙" && card.id === "100" && card.effectText));
  assert.ok(answer.resolvedCards.some((card) => card.name === "未收录测试卡" && card.sourceUrl));
});

test("rag_pipeline_raw_query_fallback", async () => {
  const answer = await answerRagRulingQuestion({
    question: "对象离场时连锁处理中怎么处理？",
    cards,
    records,
    qaRecords: [],
    dryRun: true,
    env: {},
  });
  assert.equal(answer.resolvedCards.length, 0);
  assert.equal(answer.debug.retrievalCounts.rawRelatedEvidence > 0, true);
  assert.ok(answer.debug.retrievalWarnings.includes("card_name_not_resolved_raw_query_fallback_used"));
});

test("partial_related_evidence_only_stays_low_confidence", async () => {
  const answer = await answerRagRulingQuestion({
    question: "对象离场时连锁处理中怎么处理？",
    cards: [],
    records,
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "needs_more_info",
      shortAnswer: "当前资料不足，无法给出可靠裁定分析。",
      reasoning: [],
      usedCards: [],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "low",
    }),
  });
  assert.equal(answer.answerLevel, "low_confidence_analysis");
  assert.ok(answer.riskFlags.includes("needs_more_info_downgraded_to_low_confidence_with_evidence"));
});

test("no_evidence_still_needs_more_info", async () => {
  const answer = await answerRagRulingQuestion({
    question: "完全没有资料的问题如何处理？",
    cards: [],
    records: [],
    qaRecords: [],
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "模型试图无资料分析。",
      reasoning: ["没有资料。"],
      usedCards: [],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.equal(answer.answerLevel, "needs_more_info");
  assert.ok(answer.riskFlags.includes("no_retrieved_evidence"));
});

test("rag_pipeline_distinguishes_related_from_official", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords,
    modelInvoker: async () => JSON.stringify({
      answerLevel: "official_confirmed",
      shortAnswer: "模型试图把相关资料说成官方确认。",
      reasoning: ["但没有 official direct evidence。"],
      usedCards: ["测试龙"],
      usedEvidence: [{ id: "qa-related-test-dragon", type: "related", title: "测试龙相似问答" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "high",
    }),
  });
  assert.notEqual(answer.answerLevel, "official_confirmed");
  assert.ok(answer.riskFlags.includes("official_confirmed_requires_direct_evidence"));
  assert.equal(answer.usedEvidence[0].type, "related");
});

test("model_json_parse_failure_degrades_safely", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords,
    modelInvoker: async () => "not JSON",
  });
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.match(answer.shortAnswer, /not JSON/u);
  assert.ok(answer.riskFlags.some((item) => item.startsWith("model_json_parse_failed")));
});

test("model_natural_language_output_is_wrapped_as_low_confidence", async () => {
  const result = await callRagModel({
    prompt: "输出裁定分析",
    env: {},
    modelInvoker: async () => "没有官方直接资料，但根据卡片文本只能给出未确认分析：该效果是否成功结算取决于处理时攻击是否仍可被无效。",
  });
  assert.equal(result.answer.answerLevel, "low_confidence_analysis");
  assert.ok(result.answer.riskFlags.includes("model_json_parse_failed"));
  assert.ok(result.warnings.includes("model_natural_language_wrapped"));
});

test("model_truncated_json_output_is_repaired_without_raw_json_answer", async () => {
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {},
    modelInvoker: async () => "{\"answerLevel\":\"rule_analysis\",\"shortAnswer\":\"根据卡片文本可以继续分析，但不是官方确认。\",\"reasoning\":[\"已读取卡片文本。\",\"没有官方直接 Q&A。\"],\"usedCards\":[\"测试龙\"],\"usedEvidence\":[{\"id\":\"card-text-100\",\"type\":\"card_text\"",
  });
  assert.equal(result.answer.answerLevel, "rule_analysis");
  assert.equal(result.answer.shortAnswer, "根据卡片文本可以继续分析，但不是官方确认。");
  assert.doesNotMatch(result.answer.shortAnswer, /^\s*\{/u);
  assert.ok(result.answer.reasoning.length >= 2);
  assert.ok(result.answer.riskFlags.includes("model_json_repaired"));
  assert.ok(result.warnings.includes("model_json_repaired"));
});

test("broken_json_without_short_answer_does_not_display_raw_json", async () => {
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {},
    modelInvoker: async () => "{\"answerLevel\":\"rule_analysis\",\"usedEvidence\":[",
  });
  assert.equal(result.answer.answerLevel, "rule_analysis");
  assert.doesNotMatch(result.answer.shortAnswer, /^\s*\{/u);
});

test("no_api_key_uses_mock", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords: [],
    env: {},
  });
  assert.equal(answer.debug.dryRun, true);
  assert.equal(answer.debug.providerUsed, "mock");
  assert.equal(answer.debug.modelUsed, "mock-rag");
  assert.ok(answer.shortAnswer);
});

test("deepseek_provider_builds_request", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-test",
      RAG_MAX_OUTPUT_TOKENS: "321",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(modelJson("DeepSeek OK")) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    },
  });
  assert.equal(result.providerUsed, "deepseek");
  assert.equal(result.dryRun, false);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].body.model, "deepseek-test");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "输出 JSON" }]);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(calls[0].body.max_tokens, 321);
  assert.equal(calls[0].body.stream, false);
});

test("deepseek_model_tier_selects_flash_or_pro_model", async () => {
  const calls = [];
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_FLASH_MODEL: "deepseek-flash-tier",
      DEEPSEEK_PRO_MODEL: "deepseek-pro-tier",
      RAG_MODEL_TIER: "flash",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelJson("Flash OK")) } }], usage: {} });
    },
  });
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_FLASH_MODEL: "deepseek-flash-tier",
      DEEPSEEK_PRO_MODEL: "deepseek-pro-tier",
      RAG_MODEL_TIER: "pro",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelJson("Pro OK")) } }], usage: {} });
    },
  });
  assert.equal(calls[0].model, "deepseek-flash-tier");
  assert.equal(calls[1].model, "deepseek-pro-tier");
});

test("gemini_provider_builds_request", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_MODEL: "gemini-test",
      GEMINI_MAX_OUTPUT_TOKENS: "456",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(modelJson("Gemini OK")) }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12, totalTokenCount: 62 },
      });
    },
  });
  assert.equal(result.providerUsed, "gemini");
  assert.equal(result.dryRun, false);
  assert.match(calls[0].url, /models\/gemini-test:generateContent/u);
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 456);
  assert.equal(calls[0].body.contents[0].parts[0].text, "输出 JSON");
});

test("auto_provider_prefers_deepseek", () => {
  assert.equal(resolveRagProvider({ MODEL_PROVIDER: "auto", DEEPSEEK_API_KEY: "deepseek", GEMINI_API_KEY: "gemini" }).provider, "deepseek");
});

test("auto_provider_falls_back_to_gemini", () => {
  assert.equal(resolveRagProvider({ MODEL_PROVIDER: "auto", GEMINI_API_KEY: "gemini" }).provider, "gemini");
});

test("budget_soft_limit_blocks_call_when_exceeded", async () => {
  let fetchCount = 0;
  const result = await callRagModel({
    prompt: "很长的问题".repeat(1000),
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      API_DAILY_BUDGET_CNY: "0.000001",
      API_BUDGET_MODE: "soft",
      RAG_MAX_OUTPUT_TOKENS: "1500",
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({});
    },
  });
  assert.equal(fetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.equal(result.budgetStatus.limitEnforced, true);
  assert.equal(result.budgetStatus.budgetStorage, "memory");
});

test("usage_cost_estimation_deepseek", () => {
  const cost = estimateDeepSeekCostCny({
    prompt_tokens: 1000,
    completion_tokens: 500,
    prompt_cache_hit_tokens: 200,
    prompt_cache_miss_tokens: 800,
  }, {
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    DEEPSEEK_CACHE_HIT_INPUT_CNY_PER_MTOK: "0.02",
  });
  assert.equal(cost, 0.001804);
});

test("usage_cost_estimation_uses_model_tier_prices", () => {
  const cost = estimateDeepSeekCostCny({
    prompt_tokens: 1000,
    completion_tokens: 500,
  }, {
    RAG_MODEL_TIER: "pro",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    DEEPSEEK_PRO_INPUT_CNY_PER_MTOK: "8",
    DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK: "16",
  });
  assert.equal(cost, 0.016);
});

test("budget_status_can_be_reset", async () => {
  const env = { API_DAILY_BUDGET_CNY: "10", API_BUDGET_TIMEZONE: "UTC" };
  await resetRagBudget({ env, now: new Date("2026-07-09T00:00:00Z") });
  let status = await getRagBudgetStatus({ env, now: new Date("2026-07-09T00:00:00Z") });
  assert.equal(status.spentTodayCny, 0);
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      ...env,
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "deepseek-test",
      DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
      DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    },
    now: new Date("2026-07-09T00:00:00Z"),
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify(modelJson("Budget OK")) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
  });
  status = await getRagBudgetStatus({ env, now: new Date("2026-07-09T00:00:00Z") });
  assert.equal(status.spentTodayCny > 0, true);
  status = await resetRagBudget({ env, now: new Date("2026-07-09T00:00:00Z") });
  assert.equal(status.spentTodayCny, 0);
});

test("budget_status_uses_kv_rest_aliases_for_persistent_storage", async () => {
  const env = {
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const redis = createRedisFetch();
  let status = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now: new Date("2026-07-09T00:00:00Z") });
  assert.equal(status.budgetStorage, "redis");
  await resetRagBudget({ env, fetchImpl: redis.fetchImpl, now: new Date("2026-07-09T00:00:00Z") });
  assert.deepEqual(redis.commands.at(-1), ["SET", "rag-api-budget:2026-07-09", "0", "EX", "172800"]);
});

test("card_text_derived_rule_queries_enter_rulebook_retrieval", async () => {
  const windCard = {
    id: "wind-test",
    name: "测试风神",
    cnName: "测试风神",
    effectText: "①：对方把魔法·陷阱·怪兽的效果发动时可以发动。这张卡从手卡特殊召唤。那之后，场上的魔法·陷阱卡全部回到手卡。",
    aliases: ["测试风神"],
  };
  const ruleRecord = {
    id: "rule-spell-trap-return",
    recordType: "rule-doc",
    sourceId: "ocg-rule",
    title: "发动中的通常魔法陷阱返回规则",
    text: "通常魔法・通常罠カードの発動にチェーンして、フィールドの魔法・罠カードを手札に戻す効果を発動する場合、発動中の通常魔法・通常罠はその処理で手札に戻せません。ほかに処理できる魔法・罠カードが存在しない場合、発動できない場合があります。",
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "对方发动通常陷阱时，我方能连锁发动测试风神吗？",
    cardResolution: {
      resolvedCards: [windCard],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [windCard],
    records: [ruleRecord],
    qaRecords: [],
  });

  assert.ok(evidence.ruleSearchQueries.some((item) => item.source === "card_text_derived_rule_search_query"));
  assert.ok(evidence.rawRelatedEvidence.some((item) => item.id === "rule-spell-trap-return" && item.type === "rulebook"));
});

test("rag_prompt_truncates_context", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery: "测试问题",
    cardResolution: { resolvedCards: cards },
    evidence: {
      cardTexts: [{ id: "card-text-long", type: "card_text", title: "长文本", text: "长".repeat(5000) }],
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      retrievalWarnings: [],
    },
    env: {
      RAG_MAX_CARD_TEXT_CHARS: "100",
      RAG_MAX_PROMPT_CHARS: "1400",
    },
  });
  assert.equal(bundle.prompt.length <= 1400, true);
  assert.ok(bundle.warnings.some((warning) => warning.includes("truncated")));
});

test("secrets_not_returned_in_debug", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords: [],
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "secret-key-that-must-not-leak",
      DEEPSEEK_MODEL: "deepseek-test",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify(modelJson("真实模型返回")) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
  assert.doesNotMatch(JSON.stringify(answer.debug), /secret-key-that-must-not-leak/u);
  assert.equal(answer.debug.providerUsed, "deepseek");
  assert.equal(answer.debug.dryRun, false);
});

function modelJson(shortAnswer) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer,
    reasoning: ["模型返回 JSON。"],
    usedCards: ["测试龙"],
    usedEvidence: [{ id: "card-text-100", type: "card_text", title: "测试龙 的卡片文本" }],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
  };
}

function createRedisFetch() {
  const store = new Map();
  const commands = [];
  return {
    commands,
    fetchImpl: async (url, options = {}) => {
      assert.equal(url, "https://kv.example.test");
      assert.match(String(options.headers?.authorization || ""), /Bearer kv-token/u);
      const command = JSON.parse(options.body || "[]");
      commands.push(command);
      const [op, key, value] = command;
      if (op === "GET") return jsonResponse({ result: store.get(key) || null });
      if (op === "SET") {
        store.set(key, value);
        return jsonResponse({ result: "OK" });
      }
      if (op === "INCRBYFLOAT") {
        const next = Number(store.get(key) || 0) + Number(value || 0);
        store.set(key, String(next));
        return jsonResponse({ result: String(next) });
      }
      if (op === "EXPIRE") return jsonResponse({ result: 1 });
      return jsonResponse({ result: null });
    },
  };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}
