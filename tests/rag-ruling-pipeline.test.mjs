import assert from "node:assert/strict";
import test from "node:test";
import { extractQuotedMentions, extractRagCards, extractUserProvidedCardTextBlocks } from "../backend/ragCardExtractor.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { callRagModel, estimateDeepSeekCostCny, resolveRagProvider } from "../backend/ragModelClient.mjs";
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
  assert.equal(answer.debug.retrievalCounts.cardTexts > 0, true);
  assert.equal(typeof answer.debug.promptChars, "number");
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

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}
