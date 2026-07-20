import assert from "node:assert/strict";
import test from "node:test";
import { buildAliasIndex, extractQuotedMentions, extractRagCards, extractUserProvidedCardTextBlocks, normalizeCardKey } from "../backend/ragCardExtractor.mjs";
import { createLocalCardDataProvider } from "../backend/cardDataProvider.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { callCardNameExtractionModel, callRagModel, callRulebookGroundingModel, callRuleQueryExtractionModel, estimateDeepSeekCostCny, getRagBudgetStatus, resetRagBudget, resolveRagProvider } from "../backend/ragModelClient.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";

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

test("activation-only Albaz question keeps activation legal but blocks resolution after Ecclesia cost", async () => {
  const scenarioCards = [
    {
      id: "15245",
      name: "阿不思的落胤",
      aliases: ["阿不思的落胤", "阿尔白斯之落胤", "アルバスの落胤"],
      effectText: "舍弃1张手牌可以发动。使用自己或对方场上的怪兽作为融合素材进行融合召唤。",
    },
    {
      id: "15239",
      name: "教导之圣女 艾克利西亚",
      aliases: ["教导之圣女 艾克利西亚", "教导的圣女 艾克莉西亚"],
      effectText: "教导怪兽。",
    },
    {
      id: "22090",
      name: "吞喰圣痕之龙",
      aliases: ["吞喰圣痕之龙", "吞食圣痕之龙", "聖痕喰らいし竜"],
      effectText: "只要自己或对方的场上或墓地存在艾克利西亚怪兽，此卡不受此卡以外的效果影响。",
    },
    {
      id: "17069",
      name: "冰剑龙 幻冰龙",
      aliases: ["冰剑龙 幻冰龙", "氷剣竜ミラジェイド"],
      effectText: "阿不思的落胤＋融合・同步・超量・连接怪兽。",
    },
  ];
  const response = {
    id: "official-response-screenshot-albaz-ecclesia-stigmata",
    recordType: "official-response-screenshot",
    sourceType: "official_response_screenshot",
    displayStatus: "provisional_official_response",
    maxStatus: "unconfirmed",
    title: "阿不思的落胤与吞食圣痕之龙的处理",
    question: "把教导的圣女 艾克莉西亚作为 cost 送去墓地时，阿不思的落胤能否发动并融合召唤冰剑龙 幻冰龙？",
    answer: "可以发动，但处理什么也不进行。",
    text: "阿不思的落胤、教导的圣女 艾克莉西亚、吞食圣痕之龙、冰剑龙 幻冰龙。可以发动，但处理什么也不进行。",
    cards: ["阿不思的落胤", "教导的圣女 艾克莉西亚", "吞食圣痕之龙", "冰剑龙 幻冰龙"],
    officialText: "「阿不思的落胤」的效果可以发动，但处理什么也不进行。",
    explanation: "cost 支付后抗性开始适用，不能把吞食圣痕之龙作为融合素材。",
    officialVerdict: {
      activation: "can_activate",
      cost: "can_pay_cost",
      resolution: "does_not_perform_fusion_material_processing",
    },
  };
  const answer = await answerRagRulingQuestion({
    question: "对方场上存在的卡只有表侧表示的「吞食圣痕之龙」1只，双方墓地没有卡。我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西亚」作为Cost丢弃来发动「阿不思的落胤」的①效果吗？",
    cards: scenarioCards,
    records: [response],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({ operationChecks: [], constraintReviews: [] }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动并融合召唤冰剑龙 幻冰龙。",
      reasoning: ["错误地沿用了 cost 支付前的场面。", "错误地认为素材仍受效果影响。"],
      usedCards: scenarioCards.map((card) => card.name),
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.equal(answer.answerLevel, "rule_analysis");
  assert.match(answer.shortAnswer, /^可以发动/u);
  assert.match(answer.shortAnswer, /不会进行任何效果处理/u);
  assert.match(answer.shortAnswer, /因此不进行融合召唤。$/u);
  assert.equal(answer.debug.retrievalCounts.provisionalOfficialResponses, 1);
  assert.ok(answer.riskFlags.includes("provisional_official_response"));
  assert.ok(answer.riskFlags.includes("semantic_state_transition_applied"));
  assert.equal(answer.riskFlags.includes("answer_constrained_by_provisional_official_response"), false);
  assert.deepEqual(
    answer.debug.semanticStateTransition.trace.map((step) => step.phase),
    ["activation_check", "pay_activation_cost", "stabilize_continuous_effects", "resolve_effect_operation"],
  );
  assert.equal(answer.usedEvidence[0].type, "official_response_screenshot");
});

test("effect state reasoning is compiled from neutral card text rather than card names", () => {
  const result = analyzeEffectStateTransition({
    userQuery: "对方场上存在的卡只有表侧表示的「测试抗性龙」1只，双方墓地没有卡。我方召唤「测试融合者」时，可以将「测试圣女」作为Cost丢弃来发动「测试融合者」的效果吗？",
    cardTexts: [
      {
        id: "card-text-neutral-source",
        cards: ["测试融合者"],
        text: "这张卡召唤・特殊召唤的情况下，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
      },
      {
        id: "card-text-neutral-protected",
        cards: ["测试抗性龙"],
        text: "只要自己或对方的场上或墓地存在“测试圣女”怪兽，此卡不受此卡以外的效果影响。",
      },
    ],
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.activation, "legal");
  assert.equal(result.resolution, "not_performed");
  assert.equal(result.activationEvidenceType, "effect_program");
  assert.deepEqual(result.trace[0].proof.usableMaterials, ["测试融合者", "测试抗性龙"]);
  assert.deepEqual(result.trace[3].proof.usableMaterials, ["测试融合者"]);
  assert.deepEqual(
    result.trace.map((step) => step.phase),
    ["activation_check", "pay_activation_cost", "stabilize_continuous_effects", "resolve_effect_operation"],
  );
  assert.match(result.trace[2].conclusion, /测试圣女/u);
  assert.match(result.trace[3].conclusion, /测试抗性龙/u);
  assert.doesNotMatch(JSON.stringify(result), /阿不思|艾克利西亚|吞(?:食|喰)圣痕/u);
});

test("bundled provisional official responses are loaded into the default RAG data", async () => {
  const data = await loadRagData();
  const response = data.records.find((record) => record.id === "official-response-screenshot-albaz-quem-stigmata-001");
  assert.equal(response?.sourceType, "official_response_screenshot");
  assert.equal(response?.displayStatus, "provisional_official_response");
  assert.equal(response?.officialVerdict?.activation, "can_activate");
  assert.equal(response?.officialVerdict?.resolution, "does_not_perform_fusion_material_processing");
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

test("ocg_name_normalization_treats 喰 and 食 as the same character variant", () => {
  const localCards = [{ id: "variant-1", name: "吞喰测试之龙", aliases: ["吞喰测试之龙"] }];
  const resolution = extractRagCards("「吞食测试之龙」的效果可以发动吗？", { cards: localCards });

  assert.equal(normalizeCardKey("吞喰测试之龙"), normalizeCardKey("吞食测试之龙"));
  assert.equal(resolution.resolvedCards[0]?.id, "variant-1");
  assert.deepEqual(resolution.unresolvedMentions, []);
});

test("a unique one-character card-name difference resolves with high confidence", () => {
  const localCards = [{ id: "edit-1", name: "深渊测试魔龙", aliases: ["深渊测试魔龙"] }];
  const resolution = extractRagCards("「深渊测试魔凤」的效果可以发动吗？", { cards: localCards });
  const providerMatch = createLocalCardDataProvider({ cards: localCards }).searchCardByName("深渊测试魔凤", 2)[0];

  assert.equal(resolution.resolvedCards[0]?.id, "edit-1");
  assert.ok(resolution.resolvedCards[0]?.confidence >= 0.9);
  assert.equal(providerMatch?.id, "edit-1");
  assert.ok(providerMatch?.confidence >= 0.9);
});

test("multiple one-character card-name neighbours remain below automatic resolution confidence", () => {
  const localCards = [
    { id: "edit-a", name: "深渊测试魔龙", aliases: ["深渊测试魔龙"] },
    { id: "edit-b", name: "深渊测试魔王", aliases: ["深渊测试魔王"] },
  ];
  const resolution = extractRagCards("「深渊测试魔神」的效果可以发动吗？", { cards: localCards });
  const providerMatches = createLocalCardDataProvider({ cards: localCards }).searchCardByName("深渊测试魔神", 2);

  assert.equal(resolution.resolvedCards.length, 0);
  assert.equal(resolution.unresolvedMentions[0]?.input, "深渊测试魔神");
  assert.equal(providerMatches.length, 2);
  assert.ok(providerMatches.every((card) => card.confidence < 0.72));
});

test("card alias indexes and local providers are cached by source data objects", () => {
  const localCards = [{ id: "cache-1", name: "缓存测试龙", aliases: ["缓存测试龙"] }];
  const localRecords = [];
  const localQaRecords = [];

  assert.equal(buildAliasIndex(localCards), buildAliasIndex(localCards));
  assert.notEqual(buildAliasIndex(localCards), buildAliasIndex([...localCards]));
  assert.equal(
    createLocalCardDataProvider({ cards: localCards, records: localRecords, qaRecords: localQaRecords }),
    createLocalCardDataProvider({ cards: localCards, records: localRecords, qaRecords: localQaRecords }),
  );
  assert.notEqual(
    createLocalCardDataProvider({ cards: localCards, records: localRecords, qaRecords: localQaRecords }),
    createLocalCardDataProvider({ cards: [...localCards], records: localRecords, qaRecords: localQaRecords }),
  );
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
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash-test",
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
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash-test",
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

function thunderImpermanenceCards() {
  return [
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
  ];
}

const activatedSpellTrapReturnRule = {
  id: "rule-activated-normal-spell-trap-cannot-return",
  recordType: "rule-doc",
  title: "发动中的通常魔法陷阱不能返回手卡",
  text: "通常魔法・通常罠カードの発動にチェーンして、フィールドの魔法・罠カードを手札に戻す効果を発動する場合、発動中の通常魔法・通常罠カードはその処理で手札に戻せません。ほかに処理できる魔法・罠カードが存在しない場合、その戻す処理を必要とする効果は発動できません。",
  sourceUrl: "https://example.test/rule/activated-normal-spell-trap-return",
};

test("operation_legality_plans_rule_queries_without_rule_evidence_but_does_not_override", async () => {
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
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
  assert.equal(answer.debug.retrievalCounts.operationLegalityChecks, 0);
  assert.ok(answer.debug.retrievalWarnings.some((item) => item.includes("rule_search_queries_used")));
  assert.ok(!answer.riskFlags.includes("operation_legality_blocker_applied"));
});

test("rag_pipeline_applies_operation_legality_blocker_from_retrieved_rule_evidence", async () => {
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
    records: [activatedSpellTrapReturnRule],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "chain-wind-return",
        step: 1,
        action: "对方连锁发动天雷之双风神并试图把无限泡影返回手卡",
        legalityQuestion: "正在发动中的通常陷阱能否作为返回手卡处理的可适用卡",
        status: "illegal",
        conclusion: "不能发动。无限泡影正在发动中，不能作为返回手卡处理的可适用卡；题目又没有其他魔法陷阱。",
        reasoning: ["规则书明确排除了正在发动中的通常陷阱。"],
        citations: [{
          id: "rule-activated-normal-spell-trap-cannot-return#p1-1",
          quote: "発動中の通常魔法・通常罠カードはその処理で手札に戻せません。",
          application: "无限泡影是当前连锁中正在发动的通常陷阱。",
        }],
        missingFacts: [],
      }],
      overallConclusion: "不能发动。",
    }),
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
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.match(answer.shortAnswer, /无限泡影/u);
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.equal(answer.debug.retrievalCounts.operationLegalityChecks, 1);
  assert.ok(answer.usedEvidence.some((item) => item.type === "rulebook" && item.id.includes("operation-check")));
  assert.ok(answer.usedEvidence.some((item) => item.id === "rule-activated-normal-spell-trap-cannot-return#p1-1"));
  assert.ok(answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("generic_legal_grounding_is_overridden_by_combined_mandatory_operation_evidence", async () => {
  const genericFaq = {
    id: "card-faq-22130-generic-trigger",
    recordType: "card-faq",
    title: "天雷之双风神 一般发动条件",
    cardIds: ["22130"],
    cards: ["天雷之双风神 息那"],
    text: "对手发动魔法・陷阱・怪兽效果时，自己场上有风属性怪兽的场合，可以直接连锁发动。",
  };
  let groundingPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
    records: [activatedSpellTrapReturnRule],
    qaRecords: [genericFaq],
    rulebookModelInvoker: async ({ prompt }) => {
      groundingPrompt = prompt;
      return JSON.stringify({
        constraintReviews: [],
        operationChecks: [{
          operationId: "chain-wind-return",
          step: 1,
          action: "对方连锁发动天雷之双风神",
          status: "legal",
          conclusion: "一般发动条件已经满足，所以可以发动。",
          reasoning: ["只检查了风属性怪兽和对方发动魔陷。"],
          citations: [{
            id: genericFaq.id,
            quote: "自己场上有风属性怪兽的场合，可以直接连锁发动。",
          }],
        }],
        overallConclusion: "可以发动。",
      });
    },
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动。",
      reasoning: ["场上有风属性怪兽。", "对方发动了通常陷阱。"],
      usedCards: ["绚岚之达维", "无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: genericFaq.id, type: "faq", title: genericFaq.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(groundingPrompt, /priorityConstraintCandidates/u);
  assert.match(groundingPrompt, /rule-activated-normal-spell-trap-cannot-return#p1-1/u);
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.equal(answer.debug.retrievalCounts.unresolvedOperationConstraints, 0);
  assert.ok(answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("empty_rulebook_grounding_uses_combined_constraint_evidence_to_block_yes", async () => {
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
    records: [activatedSpellTrapReturnRule],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({
      constraintReviews: [],
      operationChecks: [],
      overallConclusion: "证据待核对。",
    }),
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "可以发动。",
        reasoning: ["只检查了一般诱发条件。"],
        usedCards: ["无限泡影", "天雷之双风神 息那"],
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.match(finalPrompt, /発動中の通常魔法・通常罠カードはその処理で手札に戻せません/u);
  assert.match(finalPrompt, /"hasBlockingCheck": true/u);
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.equal(answer.debug.retrievalCounts.unresolvedOperationConstraints, 0);
  assert.ok(answer.riskFlags.includes("operation_legality_blocker_applied"));
});
test("grounded_constraint_review_overrides_generic_trigger_faq", async () => {
  const genericFaq = {
    id: "card-faq-22130-generic-trigger-reviewed",
    recordType: "card-faq",
    title: "天雷之双风神 一般发动条件",
    cardIds: ["22130"],
    cards: ["天雷之双风神 息那"],
    text: "对手发动魔法・陷阱・怪兽效果时，自己场上有风属性怪兽的场合，可以直接连锁发动。",
  };
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
    records: [activatedSpellTrapReturnRule],
    qaRecords: [genericFaq],
    rulebookModelInvoker: async () => JSON.stringify({
      constraintReviews: [{
        evidenceId: "rule-activated-normal-spell-trap-cannot-return#p1-1",
        operationId: "chain-wind-return",
        action: "对方连锁发动天雷之双风神",
        relevance: "applies",
        consequence: "blocks",
        conclusion: "不能发动。无限泡影正在发动中且场上没有其他可返回的魔法陷阱。",
        quote: "ほかに処理できる魔法・罠カードが存在しない場合、その戻す処理を必要とする効果は発動できません。",
        application: "题目明确场上没有其他魔陷，正在发动的无限泡影也不能返回。",
      }],
      operationChecks: [{
        operationId: "generic-trigger",
        step: 1,
        action: "检查天雷之双风神的一般诱发条件",
        status: "legal",
        conclusion: "风属性怪兽和对方发动魔陷这两个一般条件满足。",
        citations: [{
          id: genericFaq.id,
          quote: "自己场上有风属性怪兽的场合，可以直接连锁发动。",
        }],
      }],
      overallConclusion: "一般诱发条件满足，但限制规则阻止本次发动。",
    }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动。",
      reasoning: ["一般诱发条件满足。", "可以直接连锁。"],
      usedCards: ["绚岚之达维", "无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: genericFaq.id, type: "faq", title: genericFaq.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /不能发动/u);
  assert.match(answer.shortAnswer, /没有其他/u);
  assert.equal(answer.debug.retrievalCounts.unresolvedOperationConstraints, 0);
  assert.ok(answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("focused_constraint_fallback_blocks_wrong_answer_after_primary_timeout", async () => {
  const tasks = [];
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
    records: [activatedSpellTrapReturnRule],
    qaRecords: [],
    rulebookModelInvoker: async ({ task }) => {
      tasks.push(task);
      if (task === "rulebook_grounding") {
        throw new Error("rulebook_grounding_model_timeout");
      }
      return JSON.stringify({
        constraintReviews: [{
          evidenceId: "rule-activated-normal-spell-trap-cannot-return#p1-1",
          operationId: "chain-wind-return-after-timeout",
          action: "对方连锁发动天雷之双风神并尝试将无限泡影返回手牌",
          relevance: "applies",
          consequence: "blocks",
          conclusion: "不能发动。无限泡影正在发动中且场上没有其他可返回的魔法陷阱。",
          quote: "ほかに処理できる魔法・罠カードが存在しない場合、その戻す処理を必要とする効果は発動できません。",
          application: "题目明确场上没有其他魔陷，正在发动的无限泡影不能返回手牌。",
        }],
        operationChecks: [],
        overallConclusion: "不能发动。",
      });
    },
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动并把无限泡影返回手卡。",
      reasoning: ["只检查了一般诱发条件。"],
      usedCards: ["无限泡影", "天雷之双风神 息那"],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.deepEqual(tasks, ["rulebook_grounding", "rulebook_constraint_repair"]);
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.doesNotMatch(answer.shortAnswer, /^可以发动/u);
  assert.equal(answer.debug.retrievalCounts.unresolvedOperationConstraints, 0);
  assert.ok(answer.debug.rulebookGroundingWarnings.includes("rulebook_grounding_focused_fallback_applied"));
  assert.ok(answer.debug.rulebookGroundingWarnings.includes("rulebook_grounding_primary_failed:rulebook_grounding_model_timeout"));
  assert.ok(answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("rulebook_grounding_rejects_unknown_ids_and_non_verbatim_quotes", async () => {
  const passage = {
    id: "ocg-rule:test#p4-6",
    type: "rulebook",
    title: "测试规则 · 段落 4-6",
    text: "正在处理的卡不能返回手卡。",
    sourceUrl: "https://example.test/rule",
  };
  const result = await callRulebookGroundingModel({
    userQuery: "这张卡能返回手卡吗？",
    ruleEvidence: [passage],
    modelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "operation-1",
        action: "返回手卡",
        status: "illegal",
        conclusion: "不能返回。",
        citations: [
          { id: "invented-rule-id", quote: "正在处理的卡不能返回手卡。" },
          { id: passage.id, quote: "模型自行改写、原文不存在的规则。" },
        ],
      }],
    }),
  });
  assert.equal(result.operationLegality.hasBlockingCheck, false);
  assert.equal(result.operationLegality.checks[0].status, "unknown");
  assert.ok(result.warnings.some((item) => item.includes("unknown_evidence")));
  assert.ok(result.warnings.some((item) => item.includes("quote_mismatch")));
});

test("rulebook_grounding_accepts_verbatim_passage_citation", async () => {
  const passage = {
    id: "ocg-rule:test#p4-6",
    type: "rulebook",
    title: "测试规则 · 段落 4-6",
    text: "正在处理的卡不能返回手卡。",
    sourceUrl: "https://example.test/rule",
  };
  const result = await callRulebookGroundingModel({
    userQuery: "这张卡能返回手卡吗？",
    ruleEvidence: [passage],
    modelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "operation-1",
        action: "返回手卡",
        status: "illegal",
        conclusion: "不能返回。",
        citations: [{ id: passage.id, quote: "正在处理的卡不能返回手卡。" }],
      }],
    }),
  });
  assert.equal(result.operationLegality.hasBlockingCheck, true);
  assert.equal(result.operationLegality.matchedRuleEvidence[0].id, passage.id);
});

test("qa_evidence_can_ground_operation_checks_without_rulebook", async () => {
  const faq = {
    id: "card-faq-10820-1",
    type: "faq",
    recordType: "card-faq",
    title: "超量叠光延迟 FAQ 1",
    text: "『那只怪兽的X素材全部取除』不是对怪兽适用的效果。即使是不受魔法效果影响的超量怪兽，其X素材也会全部取除。",
    sourceUrl: "https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=4&cid=10820&request_locale=ja",
  };
  let capturedPrompt = "";
  const result = await callRulebookGroundingModel({
    userQuery: "不受其他卡效果影响的怪兽能否成为超量叠光延迟的对象？",
    ruleEvidence: [],
    qaEvidence: [faq],
    modelInvoker: async ({ prompt }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        operationChecks: [{
          operationId: "remove-xyz-materials",
          action: "超量叠光延迟移除目标怪兽的全部X素材",
          status: "legal",
          conclusion: "可以正常移除X素材；该处理不属于对怪兽适用的效果。",
          citations: [{
            id: faq.id,
            quote: "不是对怪兽适用的效果",
            application: "怪兽的效果抗性不阻止移除其X素材。",
          }],
        }],
        overallConclusion: "可以发动并正常移除素材，再按失去抗性后的状态继续处理。",
      });
    },
  });

  assert.match(capturedPrompt, /evidenceCandidates/u);
  assert.match(capturedPrompt, /官方 Q&A 或卡片 FAQ/u);
  assert.match(capturedPrompt, /不受其他卡的效果影响.*不等于.*不能成为效果对象/u);
  assert.match(capturedPrompt, /卡的发动.*已在场卡片的效果发动/u);
  assert.equal(result.operationLegality.hasGroundedChecks, true);
  assert.equal(result.operationLegality.hasBlockingCheck, false);
  assert.equal(result.operationLegality.matchedRuleEvidence[0].id, faq.id);
  assert.equal(result.operationLegality.evidence[0].type, "operation_check");
});

test("empty_model_output_falls_back_to_qa_grounded_operation_answer", async () => {
  const scenarioCards = [
    {
      id: "10820",
      name: "超量叠光延迟",
      cnName: "超量叠光延迟",
      cardType: "通常魔法",
      effectText: "以持有X素材的对方场上1只X怪兽为对象才能发动。那只怪兽的X素材全部取除，那只怪兽回到额外卡组。",
      aliases: ["超量叠光延迟", "エクシーズ・オーバーディレイ"],
    },
    {
      id: "11296",
      name: "No.86 英豪冠军 击灭枪王",
      cnName: "No.86 英豪冠军 击灭枪王",
      cardType: "怪兽",
      effectText: "持有3个以上X素材的这张卡不受其他卡的效果影响。",
      aliases: ["NO.86 英豪冠军 击灭枪王", "No.86 H－C ロンゴミアント"],
    },
  ];
  const faqRecord = {
    id: "card-faq-10820-1",
    recordType: "card-faq",
    title: "超量叠光延迟 FAQ 1",
    cardIds: ["10820"],
    cards: ["超量叠光延迟"],
    text: "超量叠光延迟 FAQ 1 『那只怪兽的X素材全部取除』不是对怪兽适用的效果。即使是不受魔法效果影响的超量怪兽，其X素材也会全部取除。",
  };
  const answer = await answerRagRulingQuestion({
    question: "持有三个X素材的「NO.86 英豪冠军 击灭枪王」能否成为「超量叠光延迟」的对象？",
    cards: scenarioCards,
    records: [],
    qaRecords: [faqRecord],
    env: { RAG_MODEL_TIER: "flash" },
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "xyz-encore-target-and-resolve",
        action: "以持有三个X素材的No.86为对象发动超量叠光延迟并移除素材",
        status: "legal",
        conclusion: "可以发动。先移除全部X素材，该处理不受怪兽效果抗性阻止；失去素材后再继续处理。",
        citations: [{ id: faqRecord.id, quote: "不是对怪兽适用的效果" }],
      }],
      overallConclusion: "可以发动。先移除全部X素材，再按失去抗性后的状态继续处理。",
    }),
    modelInvoker: async () => "",
  });

  assert.match(answer.shortAnswer, /可以发动/u);
  assert.doesNotMatch(answer.shortAnswer, /没有可用的模型 JSON/u);
  assert.ok(answer.usedEvidence.some((item) => item.id === faqRecord.id && item.type === "faq"));
  assert.ok(answer.usedEvidence.some((item) => /yugioh-card\.com/u.test(item.sourceUrl)));
  assert.ok(answer.riskFlags.includes("final_model_failed_using_grounded_operation_analysis"));
});

test("exact_scenario_grounding_constrains_the_entire_effect_resolution", async () => {
  const cards = [
    {
      id: "10820",
      name: "超量叠光延迟",
      cnName: "超量叠光延迟",
      cardType: "通常魔法",
      effectText: "以持有X素材的对方场上1只X怪兽为对象才能发动。那只怪兽的X素材全部取除，那只怪兽回到额外卡组。",
      aliases: ["超量叠光延迟"],
    },
    {
      id: "11296",
      name: "No.86 英豪冠军 击灭枪王",
      cnName: "No.86 英豪冠军 击灭枪王",
      cardType: "怪兽",
      effectText: "持有3个以上X素材的这张卡不受其他卡的效果影响。",
      aliases: ["NO.86 英豪冠军 击灭枪王"],
    },
  ];
  const exactRule = {
    id: "ocg-rule:exact-xyz-encore",
    recordType: "rule-doc",
    title: "永续效果在处理途中不再适用",
    text: "以持有5个X素材的「 No.86 英豪冠军 击灭枪王 」为对象发动「 超量叠光延迟 」，由于去除X素材的效果不影响X怪兽，「 No.86 英豪冠军 击灭枪王 」的X素材全部取除，这个时点其永续效果立即不适用，结果正常适用「 超量叠光延迟 」的后续效果。",
    sourceUrl: "https://example.test/exact-xyz-encore",
  };
  const exactPassageId = `${exactRule.id}#p1-1`;
  const answer = await answerRagRulingQuestion({
    question: "拥有三个以上素材的【NO.86 英豪冠军 击灭枪王】是否可以被对方发动的【超量叠光延迟】取做效果对象？",
    cards,
    records: [exactRule],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "target-and-resolve",
        action: "以No.86为对象发动超量叠光延迟并完整处理",
        status: "legal",
        conclusion: "可以选择为对象；素材全部取除后抗性立即不再适用，后续效果正常处理。",
        citations: [{
          id: exactPassageId,
          quote: "X素材全部取除，这个时点其永续效果立即不适用，结果正常适用「 超量叠光延迟 」的后续效果",
        }],
      }],
      overallConclusion: "可以选择为对象。处理时取除全部X素材，枪王的抗性随即不再适用，因此枪王正常回到额外卡组。",
    }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以选择为对象并取除素材，但枪王不受后续效果影响，会留在场上。",
      reasoning: ["取除素材后不处理返回额外卡组。"],
      usedCards: ["超量叠光延迟", "No.86 英豪冠军 击灭枪王"],
      usedEvidence: [{ id: exactPassageId, type: "rulebook", title: exactRule.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /枪王正常回到额外卡组/u);
  assert.doesNotMatch(answer.shortAnswer, /留在场上/u);
  assert.ok(answer.riskFlags.includes("answer_constrained_by_exact_scenario_evidence"));
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

  assert.ok(evidence.ruleSearchQueries.some((item) => item.source === "derived_rule_search_query" && item.query.includes("翻倍机会")));
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

test("deepseek_empty_truncated_output_retries_with_compact_prompt", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "原始长提示词",
    recoveryPrompt: "紧凑恢复提示词",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      RAG_MAX_OUTPUT_TOKENS: "321",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return jsonResponse({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 100, completion_tokens: 321, total_tokens: 421 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(modelJson("恢复后的答案")) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages[0].content, "紧凑恢复提示词");
  assert.equal(calls[1].max_tokens, 4000);
  assert.equal(result.answer.shortAnswer, "恢复后的答案");
  assert.equal(result.tokenUsage.prompt_tokens, 140);
  assert.equal(result.tokenUsage.completion_tokens, 381);
  assert.ok(result.warnings.includes("deepseek_compact_recovery_succeeded"));
  assert.equal(result.warnings.some((warning) => warning.startsWith("deepseek_empty_content:")), false);
  assert.equal(result.warnings.includes("deepseek_output_truncated_by_token_limit"), false);
});
test("deepseek_provider_builds_request", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_FLASH_MODEL: "deepseek-test",
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

test("deepseek_final_generation_is_fixed_to_flash_model", async () => {
  const calls = [];
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_FLASH_MODEL: "deepseek-flash-tier",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelJson("Flash OK")) } }], usage: {} });
    },
  });
  assert.equal(calls[0].model, "deepseek-flash-tier");
  assert.equal(calls[0].max_tokens, 3600);
  assert.equal(calls[0].temperature, 0);
});

test("model_reasoning_string_is_preserved", async () => {
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: { MODEL_PROVIDER: "mock" },
    modelInvoker: async () => ({
      answerLevel: "rule_analysis",
      shortAnswer: "不能发动。",
      reasoning: "卡片文本要求存在合法对象；当前场面没有合法对象。",
      usedCards: [],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.deepEqual(result.answer.reasoning, ["卡片文本要求存在合法对象；当前场面没有合法对象。"]);
  assert.doesNotMatch(result.answer.reasoning.join(" "), /RAG baseline/u);
});

test("reasoning_is_recovered_or_explicitly_marked_missing", async () => {
  const recovered = await callRagModel({
    prompt: "输出 JSON",
    env: { MODEL_PROVIDER: "mock" },
    modelInvoker: async () => ({
      answerLevel: "rule_analysis",
      shortAnswer: "不能。该效果只能直接连锁符合条件的发动。",
      usedEvidence: [],
      riskFlags: [],
    }),
  });
  assert.match(recovered.answer.reasoning.join(" "), /只能直接连锁/u);
  assert.ok(recovered.answer.riskFlags.includes("model_reasoning_recovered_from_short_answer"));

  const missing = await callRagModel({
    prompt: "输出 JSON",
    env: { MODEL_PROVIDER: "mock" },
    modelInvoker: async () => ({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动。",
      usedEvidence: [],
      riskFlags: [],
    }),
  });
  assert.match(missing.answer.reasoning.join(" "), /没有提供可核对的理由/u);
  assert.ok(missing.answer.riskFlags.includes("model_reasoning_missing"));
  assert.doesNotMatch(missing.answer.reasoning.join(" "), /RAG baseline/u);
});

test("gemini_provider_builds_request", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_FLASH_MODEL: "gemini-test",
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

test("usage_cost_estimation_uses_flash_prices", () => {
  const cost = estimateDeepSeekCostCny({
    prompt_tokens: 1000,
    completion_tokens: 500,
  }, {
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "3",
    DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "4",
  });
  assert.equal(cost, 0.005);
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
      DEEPSEEK_FLASH_MODEL: "deepseek-test",
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

test("budget_status_requires_persistent_storage_on_vercel", async () => {
  const status = await getRagBudgetStatus({
    env: {
      VERCEL: "1",
      API_DAILY_BUDGET_CNY: "10",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2026-07-09T00:00:00Z"),
  });
  assert.equal(status.budgetStorage, "unconfigured");
  assert.equal(status.budgetPersistent, false);
  assert.equal(status.spentTodayCny, null);
  assert.match(status.storageWarning, /持久化预算存储/u);
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
  assert.ok(evidence.rawRelatedEvidence.some((item) => item.id.startsWith("rule-spell-trap-return#p") && item.type === "rulebook"));
  assert.ok(evidence.rulebookCandidates.some((item) => /発動中の通常魔法/u.test(item.text)));
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
  assert.ok(bundle.warnings.some((warning) => warning.includes("compacted")));
  assert.doesNotMatch(bundle.prompt, /上下文因 RAG_MAX_PROMPT_CHARS 限制被截断/u);
});

test("compacted_prompt_keeps_each_critical_evidence_bucket", () => {
  const longText = (marker) => `${marker} ${"证据内容".repeat(600)}`;
  const bundle = buildRagRulingPromptBundle({
    userQuery: "需要同时参考官方问答、卡文、规则书和FAQ的复杂问题",
    cardResolution: { resolvedCards: cards },
    evidence: {
      officialQaDirectCandidates: [{ id: "direct-critical", type: "official_qa", title: "官方直答", text: longText("DIRECT_MARKER"), isDirect: true }],
      userProvidedCardTexts: [{ id: "user-critical", type: "user_provided_text", title: "用户卡文", text: longText("USER_MARKER") }],
      cardTexts: [{ id: "card-critical", type: "card_text", title: "卡片文本", text: longText("CARD_MARKER") }],
      rawRelatedEvidence: [{ id: "rule-critical", type: "rulebook", title: "规则书", text: longText("RULE_MARKER") }],
      faqRelated: [{ id: "faq-critical", type: "faq", title: "卡片FAQ", text: longText("FAQ_MARKER") }],
      officialQaRelated: [{ id: "related-critical", type: "related", title: "相似问答", text: longText("RELATED_MARKER") }],
      retrievalWarnings: [],
    },
    env: { RAG_MAX_PROMPT_CHARS: "8000" },
  });

  assert.ok(bundle.warnings.some((warning) => warning.includes("compacted")));
  assert.match(bundle.prompt, /DIRECT_MARKER/u);
  assert.match(bundle.prompt, /USER_MARKER/u);
  assert.match(bundle.prompt, /CARD_MARKER/u);
  assert.match(bundle.prompt, /RULE_MARKER/u);
  assert.match(bundle.prompt, /FAQ_MARKER/u);
  assert.match(bundle.prompt, /RELATED_MARKER/u);
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
      DEEPSEEK_FLASH_MODEL: "deepseek-test",
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


test("stardust_chain_uses_inline_linked_official_qa_and_blocks_wrong_model_answer", async () => {
  const scenarioCards = [
    {
      id: "4678",
      name: "神鹰羽毛扫",
      cnName: "神鹰羽毛扫",
      cardType: "通常魔法",
      effectText: "将对手场上的魔法・陷阱卡全部破坏。",
      aliases: ["神鹰羽毛扫"],
      sourceUrl: "https://example.test/card/4678",
    },
    {
      id: "16386",
      name: "鲜花之女男爵",
      cnName: "鲜花之女男爵",
      cardType: "怪兽",
      effectText: "魔法・陷阱・怪兽的效果发动时可以发动。将该发动无效并破坏。",
      aliases: ["鲜花之女男爵"],
      sourceUrl: "https://example.test/card/16386",
    },
    {
      id: "7734",
      name: "星尘龙",
      cnName: "星尘龙",
      cardType: "怪兽",
      effectText: "破坏场上的卡之效果发动时，解放此卡可以发动。将该发动无效并破坏。",
      aliases: ["星尘龙"],
      sourceUrl: "https://example.test/card/7734",
    },
  ];
  const qaRecord = {
    id: "ygoresources-qa-11290",
    recordType: "qa",
    title: "卡的发动被无效并破坏时能否连锁星尘龙",
    cardIds: ["5494", "6053"],
    cards: ["无关的旧索引值"],
    text: "对魔法・陷阱卡的卡的发动连锁发动<<15105>>的无效并破坏效果时，能否再连锁发动<<7734>>？\n不能。魔法・陷阱卡的卡的发动被无效后，不再视为场上的卡。因此该破坏不视为破坏场上的卡。",
    sourceUrl: "https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=11290&request_locale=ja",
  };
  let groundingPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "我方C1发动「神鹰羽毛扫」，对手C2连锁「鲜花之女男爵」的无效并破坏效果，我方是否可以C3发动「星尘龙」？",
    cards: scenarioCards,
    records: [],
    qaRecords: [qaRecord],
    env: { RAG_MODEL_TIER: "flash" },
    rulebookModelInvoker: async ({ prompt }) => {
      groundingPrompt = prompt;
      return JSON.stringify({
        operationChecks: [{
          operationId: "chain-stardust",
          step: 3,
          action: "以星尘龙连锁鲜花之女男爵的无效并破坏效果",
          status: "illegal",
          conclusion: "不能发动星尘龙；羽毛扫的卡的发动被无效后不再视为场上的卡，男爵的处理不属于破坏场上的卡。",
          reasoning: ["星尘龙要求直接连锁会破坏场上卡片的效果，本场景不满足。"],
          citations: [{
            id: qaRecord.id,
            quote: "魔法・陷阱卡的卡的发动被无效后，不再视为场上的卡。",
          }],
        }],
        overallConclusion: "不能在C3发动星尘龙。",
      });
    },
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以在C3发动星尘龙。",
      reasoning: ["鲜花之女男爵会破坏羽毛扫。", "星尘龙可以对应破坏效果。"],
      usedCards: ["神鹰羽毛扫", "鲜花之女男爵", "星尘龙"],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(groundingPrompt, /ygoresources-qa-11290/u);
  assert.match(answer.shortAnswer, /不能发动星尘龙/u);
  assert.doesNotMatch(answer.shortAnswer, /可以在C3发动/u);
  assert.ok(answer.reasoning.some((item) => /不再视为场上的卡/u.test(item)));
  assert.ok(answer.usedEvidence.some((item) => item.id === qaRecord.id));
  assert.ok(answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("fully_cited_multi_card_operation_analysis_constrains_partial_resolution", async () => {
  const mediusText = "此卡存在于墓地的情况下可以发动。从自己手牌・场上（表侧表示）将1只怪兽放回牌组，将此卡特殊召唤。";
  const bystialText = "以自己或对手墓地的1只光・暗属性怪兽为对象可以发动。将该怪兽除外，从手牌将此卡特殊召唤。";
  const answer = await answerRagRulingQuestion({
    question: "C1发动《无垢者 墨迪乌斯》的②效果，C2发动《渊兽 玛格纳姆特》将其除外。C1处理时还要将1只怪兽放回牌组吗？",
    cards: [
      {
        id: "21419",
        name: "无垢者 墨迪乌斯",
        cnName: "无垢者 墨迪乌斯",
        cardType: "怪兽",
        effectText: mediusText,
        aliases: ["无垢者 墨迪乌斯"],
      },
      {
        id: "17762",
        name: "渊兽 玛格纳姆特",
        cnName: "渊兽 玛格纳姆特",
        cardType: "怪兽",
        effectText: bystialText,
        aliases: ["渊兽 玛格纳姆特"],
      },
    ],
    records: [],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [
        {
          operationId: "resolve-bystial",
          step: 1,
          action: "玛格纳姆特除外墓地的墨迪乌斯并特殊召唤",
          status: "legal",
          conclusion: "C2先将墨迪乌斯除外，并在除外成功后特殊召唤玛格纳姆特。",
          reasoning: ["按C2卡片文本依次处理。"],
          citations: [{
            id: "card-text-17762",
            quote: "将该怪兽除外，从手牌将此卡特殊召唤",
            application: "C2使墨迪乌斯在C1处理前离开墓地。",
          }],
        },
        {
          operationId: "resolve-medius",
          step: 2,
          action: "处理已经发动的墨迪乌斯②效果",
          status: "legal",
          conclusion: "仍要从手牌或表侧场上将1只怪兽放回牌组；墨迪乌斯已不在墓地，之后不能将其特殊召唤。",
          reasoning: ["回牌组处理写在特殊召唤之前，且不要求墨迪乌斯仍在墓地。"],
          citations: [{
            id: "card-text-21419",
            quote: "从自己手牌・场上（表侧表示）将1只怪兽放回牌组，将此卡特殊召唤",
            application: "先进行回牌组处理，再尝试特殊召唤此卡。",
          }],
        },
      ],
      overallConclusion: "仍要将1只怪兽放回牌组，但不能再特殊召唤已被除外的墨迪乌斯。",
    }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "不需要。墨迪乌斯离开墓地后整个效果不处理。",
      reasoning: ["效果处理时发动源不在原位置。"],
      usedCards: ["无垢者 墨迪乌斯", "渊兽 玛格纳姆特"],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /仍要将1只怪兽放回牌组/u);
  assert.match(answer.shortAnswer, /不能再特殊召唤/u);
  assert.ok(answer.reasoning.some((item) => /回牌组处理/u.test(item)));
  assert.ok(answer.riskFlags.includes("answer_constrained_by_exact_scenario_evidence"));
  assert.ok(answer.usedEvidence.some((item) => item.id === "card-text-21419"));
  assert.ok(answer.usedEvidence.some((item) => item.id === "card-text-17762"));
});


test("target_protection_and_unaffected_status_are_checked_separately", async () => {
  const scenarioCards = [
    {
      id: "17451",
      name: "电光闪灵・精灵",
      cnName: "电光闪灵・精灵",
      cardType: "连接怪兽",
      effectText: "对手不能将此卡链接端的怪兽作为效果对象。",
      aliases: ["卫星闪灵 淘气精灵", "电光闪灵・精灵"],
      sourceUrl: "https://example.test/card/17451",
    },
    {
      id: "11296",
      name: "No.86 英豪冠军 击灭枪王",
      cnName: "No.86 英豪冠军 击灭枪王",
      cardType: "超量怪兽",
      effectText: "持有3个以上X素材的此卡不受其他卡的效果影响。",
      aliases: ["NO.86 英豪冠军 击灭枪王"],
      sourceUrl: "https://example.test/card/11296",
    },
    {
      id: "10820",
      name: "超量叠光延迟",
      cnName: "超量叠光延迟",
      cardType: "通常魔法",
      effectText: "以持有X素材的对手场上1只X怪兽为对象可以发动。将其X素材全部取除。",
      aliases: ["超量叠光延迟"],
      sourceUrl: "https://example.test/card/10820",
    },
  ];
  const elfFaq = {
    id: "card-faq-17451-1",
    recordType: "card-faq",
    title: "电光闪灵・精灵 FAQ 1",
    cardIds: ["17451"],
    cards: ["电光闪灵・精灵"],
    text: "相手プレイヤーに適用される効果です。（相手プレイヤーが、このカードのリンク先のモンスターを効果の対象に選択できなくなります。このカードのリンク先のモンスターに適用される効果ではありません。）",
  };
  const encoreFaq = {
    id: "card-faq-10820-1",
    recordType: "card-faq",
    title: "超量叠光延迟 FAQ 1",
    cardIds: ["10820"],
    cards: ["超量叠光延迟"],
    text: "『そのモンスターのX素材を全て取り除き』はモンスターに適用する効果ではありません。（魔法カードの効果を受けないエクシーズモンスターのエクシーズ素材も全て取り除かれます。）",
  };
  const answer = await answerRagRulingQuestion({
    question: "在「卫星闪灵 淘气精灵」链接端，拥有三个以上素材的「NO.86 英豪冠军 击灭枪王」是否可以被对方发动的「超量叠光延迟」取做效果对象？",
    cards: scenarioCards,
    records: [],
    qaRecords: [elfFaq, encoreFaq],
    env: { RAG_MODEL_TIER: "flash" },
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "choose-target",
        step: 1,
        action: "对方以链接端的枪王为对象发动超量叠光延迟",
        status: "illegal",
        conclusion: "不能发动；淘气精灵限制对手玩家把链接端怪兽选为效果对象。",
        reasoning: ["阻断原因是对手玩家受到对象选择限制，不是枪王的不受效果影响。"],
        citations: [{
          id: elfFaq.id,
          quote: "相手プレイヤーが、このカードのリンク先のモンスターを効果の対象に選択できなくなります",
        }],
      }],
      overallConclusion: "不能以该枪王为对象发动超量叠光延迟。",
    }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "不能发动，因为枪王不受魔法效果影响。",
      reasoning: ["枪王不受效果，所以不能成为效果对象。", "超量叠光延迟无法适用。"],
      usedCards: ["No.86 英豪冠军 击灭枪王", "超量叠光延迟"],
      usedEvidence: [{ id: encoreFaq.id, type: "faq", title: encoreFaq.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /淘气精灵限制对手玩家/u);
  assert.doesNotMatch(answer.shortAnswer, /枪王不受魔法效果影响/u);
  assert.ok(answer.reasoning.some((item) => /不是枪王的不受效果影响/u.test(item)));
  assert.ok(answer.usedEvidence.some((item) => item.id === elfFaq.id));
});
