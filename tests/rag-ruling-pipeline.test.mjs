import assert from "node:assert/strict";
import test from "node:test";
import { buildAliasIndex, extractQuotedMentions, extractRagCards, extractUnquotedCardMentionCandidates, extractUserProvidedCardTextBlocks, normalizeCardKey } from "../backend/ragCardExtractor.mjs";
import { createLocalCardDataProvider } from "../backend/cardDataProvider.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { callCardNameExtractionModel, callDeepSeekJsonTask, callOfficialQaApplicabilityModel, callRagModel, callRulebookGroundingModel, callRuleQueryExtractionModel, capPublicChatGptBudget, createPublicAnswerModelEnv, estimateDeepSeekCostCny, estimateGlmCostCny, getRagBudgetStatus, resetRagBudget, resolveRagProvider } from "../backend/ragModelClient.mjs";
import {
  answerRagRulingQuestion,
} from "../backend/ragRulingPipeline.mjs";
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

test("user-provided card text reaches the final model as raw evidence without a local verdict", async () => {
  let finalPrompt = "";
  await answerRagRulingQuestion({
    question: [
      "【匿名期限效果卡】",
      "①：可以发动。将1只怪兽特殊召唤。只要这个效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组仅可特殊召唤‘示例’怪兽。",
      "那只怪兽的控制权改变后，限制以后会自动恢复吗？",
    ].join("\n"),
    cards: [],
    records: [],
    qaRecords: [],
    env: { RAG_MODEL_PROVIDER: "mock", RAG_AUTO_ENGINE_SIMULATION: "false" },
    fetchImpl: async () => {
      throw new Error("anonymous user text must not trigger a remote card-name lookup");
    },
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "仅用于验证用户卡文作为原始证据进入最终提示。",
        reasoning: ["依据用户提供的匿名卡文分析。"],
        usedCards: ["匿名期限效果卡"],
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });
  assert.match(finalPrompt, /user-card-text-/u);
  assert.match(finalPrompt, /只要这个效果特殊召唤的怪兽/u);
  assert.doesNotMatch(finalPrompt, /create_lingering_restriction/u);
  assert.doesNotMatch(finalPrompt, /irreversible_on_first_condition_failure/u);
});

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

test("final reasoner receives the Albaz evidence without a local answer override", async () => {
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
      cardType: "fusion",
      summonKinds: ["fusion"],
      effectText: "只要自己或对方的场上或墓地存在艾克利西亚怪兽，此卡不受此卡以外的效果影响。",
    },
    {
      id: "17069",
      name: "冰剑龙 幻冰龙",
      aliases: ["冰剑龙 幻冰龙", "氷剣竜ミラジェイド"],
      effectText: "“阿不思的落胤”＋融合・同步・超量・连接怪兽。",
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
    question: "我方额外卡组有「冰剑龙 幻冰龙」。对方场上存在的卡只有表侧表示的「吞食圣痕之龙」1只，双方墓地没有卡。我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西亚」作为Cost丢弃来发动「阿不思的落胤」的①效果吗？",
    cards: scenarioCards,
    records: [response],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({ operationChecks: [], constraintReviews: [] }),
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以发动，但是支付 cost 后吞喰圣痕之龙开始不受这次效果影响，因此处理时不进行融合召唤。",
      reasoning: ["发动前存在合法素材组合。", "支付 cost 后重新检查持续抗性，处理时已没有可用的完整素材组合。"],
      usedCards: scenarioCards.map((card) => card.name),
      usedEvidence: [{ id: response.id, type: "official_response_screenshot", title: response.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.equal(answer.answerLevel, "rule_analysis");
  assert.match(answer.shortAnswer, /^可以发动/u);
  assert.match(answer.shortAnswer, /支付 cost 后/u);
  assert.match(answer.shortAnswer, /不进行融合召唤。$/u);
  assert.equal(answer.debug.retrievalCounts.provisionalOfficialResponses, 1);
  assert.ok(!answer.riskFlags.includes("provisional_official_response"));
  assert.ok(!answer.riskFlags.includes("semantic_state_transition_applied"));
  assert.equal(answer.riskFlags.includes("answer_constrained_by_provisional_official_response"), false);
  assert.equal(answer.debug.semanticStateTransition, null);
  assert.equal(answer.usedEvidence[0].type, "official_response_screenshot");
});

test("effect state reasoning is compiled from neutral card text rather than card names", () => {
  const result = analyzeEffectStateTransition({
    userQuery: "我方额外卡组有「测试终端龙」。对方场上存在的卡只有表侧表示的「测试抗性龙」1只，双方墓地没有卡。我方召唤「测试融合者」时，可以将「测试圣女」作为Cost丢弃来发动「测试融合者」的效果吗？",
    cardTexts: [
      {
        id: "card-text-neutral-source",
        cards: ["测试融合者"],
        text: "这张卡召唤・特殊召唤的情况下，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
      },
      {
        id: "card-text-neutral-protected",
        cards: ["测试抗性龙"],
        cardType: "fusion",
        text: "只要自己或对方的场上或墓地存在“测试圣女”怪兽，此卡不受此卡以外的效果影响。",
      },
      {
        id: "card-text-neutral-saint",
        cards: ["测试圣女"],
        text: "测试圣女怪兽。",
      },
      {
        id: "card-text-neutral-target",
        cards: ["测试终端龙"],
        text: "“测试融合者”＋融合・同步・超量・连接怪兽",
      },
    ],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "legal");
  assert.equal(result.resolution, "not_performed");
  assert.equal(result.activationEvidenceType, "effect_program");
  assert.equal(result.trace[0].proof.usableMaterials.length, 2);
  assert.equal(result.trace[3].proof.usableMaterials.length, 1);
  assert.deepEqual(
    result.trace.map((step) => step.phase),
    ["activation_check", "pay_activation_cost", "stabilize_continuous_effects", "resolve_effect_operation"],
  );
  assert.match(result.trace[1].conclusion, /测试圣女/u);
  assert.match(result.trace[3].conclusion, /测试抗性龙/u);
  assert.doesNotMatch(JSON.stringify(result), /阿不思|艾克利西亚|吞(?:食|喰)圣痕/u);
});

test("activation evidence is attached only when it references the simulated source", () => {
  const input = {
    userQuery: "我方额外卡组有「证据终端龙」。对方场上只有「证据抗性龙」。我方召唤「证据融合者」时，将「证据圣女」作为Cost丢弃发动效果。",
    cardTexts: [{
      id: "card-text-evidence-source",
      cards: ["证据融合者"],
      text: "这张卡召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材进行融合召唤。",
    }, {
      id: "card-text-evidence-cost",
      cards: ["证据圣女"],
      text: "证据圣女怪兽。",
    }, {
      id: "card-text-evidence-protected",
      cards: ["证据抗性龙"],
      cardType: "fusion",
      text: "只要自己或对方的场上或墓地存在“证据圣女”怪兽，此卡不受此卡以外的效果影响。",
    }, {
      id: "card-text-evidence-target",
      cards: ["证据终端龙"],
      text: "“证据融合者”＋融合怪兽",
    }],
  };
  const unrelated = {
    id: "unrelated-activation-evidence",
    sourceType: "official_response_screenshot",
    cards: ["完全无关卡"],
    question: "完全无关卡可以发动吗？",
    officialVerdict: { activation: "can_activate" },
  };
  const related = {
    id: "related-activation-evidence",
    sourceType: "official_response_screenshot",
    cards: ["证据融合者"],
    question: "证据融合者可以发动吗？",
    officialVerdict: { activation: "can_activate" },
  };
  const withRelated = analyzeEffectStateTransition({
    ...input,
    corroboratingEvidence: [unrelated, related],
  });
  const unrelatedOnly = analyzeEffectStateTransition({
    ...input,
    corroboratingEvidence: [unrelated],
  });

  assert.equal(withRelated.status, "resolved", JSON.stringify(withRelated));
  assert.equal(withRelated.activationEvidenceType, "official_response_screenshot");
  assert.equal(withRelated.evidenceIds.includes("related-activation-evidence"), true);
  assert.equal(withRelated.evidenceIds.includes("unrelated-activation-evidence"), false);
  assert.equal(unrelatedOnly.activationEvidenceType, "effect_program");
  assert.equal(unrelatedOnly.evidenceIds.includes("unrelated-activation-evidence"), false);
});

test("effect state reasoning preserves a resolved cost card identity across zone changes", () => {
  const result = analyzeEffectStateTransition({
    userQuery: "我方额外卡组有「测试终端龙」。对方场上存在的卡只有表侧表示的「测试抗性龙」1只，双方墓地没有卡。我方召唤「测试融合者」时，可以将「测试圣女别译」作为Cost丢弃来发动效果吗？",
    cardTexts: [
      {
        id: "card-text-identity-source",
        cards: ["测试融合者"],
        text: "这张卡召唤・特殊召唤的情况下，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
      },
      {
        id: "card-text-identity-protected",
        cards: ["测试抗性龙"],
        cardType: "fusion",
        text: "只要自己或对方的场上或墓地存在“标准测试圣女”怪兽，此卡不受此卡以外的效果影响。",
      },
      {
        id: "card-text-identity-target",
        cards: ["测试终端龙"],
        text: "“测试融合者”＋融合・同步・超量・连接怪兽",
      },
    ],
    resolvedCards: [{
      input: "测试圣女别译",
      id: "resolved-test-saint",
      name: "标准测试圣女",
      aliases: ["标准测试圣女"],
    }],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "legal");
  assert.equal(result.resolution, "not_performed");
  assert.equal(result.program.finalState.entities.find((entity) => entity.zone === "graveyard")?.name, "标准测试圣女");
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
  assert.match(bundle.prompt, /不得把.*user_provided_text.*称为官方直接 Q&A/u);
});

test("rag prompts require the model to answer every user subquestion", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery: "这个效果可以发动吗，后续怎么处理？",
    cardResolution: { resolvedCards: cards },
    evidence: {
      cardTexts: [{ id: "card-text-summary", type: "card_text", title: "测试卡文本", text: "舍弃1张手牌可以发动。那之后，进行处理。" }],
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      retrievalWarnings: [],
    },
  });
  assert.match(bundle.prompt, /逐个子问题给出直接结论/u);
  assert.match(bundle.prompt, /不要漏答/u);
  assert.equal(bundle.recoveryPrompt, "");
});

test("quoted_mentions_all_preserved", () => {
  const mentions = extractQuotedMentions("【A卡】《B卡》「C卡」『D卡』[E卡]“F卡”\"G卡\"'H卡'");
  assert.deepEqual(mentions, ["A卡", "B卡", "C卡", "D卡", "E卡", "F卡", "G卡", "H卡"]);
});

test("temporal follow-up phrases are not treated as unquoted card names", () => {
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("原效果被改写。之后能否发动④效果？"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("控制权改变，随后是否还可以发动效果？"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("原效果处理。那之后能否发动④效果？"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("这只怪兽被破坏后，它的④能否发动？"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("将1只怪兽特殊召唤。"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("将2只怪兽特殊召唤。"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("将3张魔法卡送去墓地。"),
    [],
  );
  assert.deepEqual(
    extractUnquotedCardMentionCandidates("成功后双方各有哪些诱发效果可以发动，连锁顺序是什么？"),
    [],
  );
});

test("quoted effect and restriction clauses are not treated as card names", () => {
  const query = [
    "『本回合自己已经发动过魔法卡的效果』",
    "『自己不是「星群」怪兽不能从额外卡组特殊召唤』",
    "『这个回合自己只能特殊召唤恶魔族怪兽』",
    "《处理到不能处理为止》",
    "《对象丢失，不进行处理》",
  ].join("；");
  const localCards = [
    { id: "series-a", name: "星群先锋", aliases: ["星群先锋", "星群"] },
    { id: "series-b", name: "星群后卫", aliases: ["星群后卫", "星群"] },
  ];
  const resolution = extractRagCards(query, {
    cards: localCards,
    modelCardNameCandidates: [{ name: "星群", originalText: "星群", confidence: "high" }],
  });

  assert.deepEqual(extractQuotedMentions(query), []);
  assert.deepEqual(resolution.resolvedCards, []);
  assert.deepEqual(resolution.unresolvedMentions, []);
  assert.deepEqual(resolution.ambiguousMentions, []);
  assert.deepEqual(resolution.modelCardNameCandidates, []);
});

test("Japanese and English resolution propositions are not treated as card names", () => {
  const query = [
    "『対象が存在しないため処理できない』",
    "『処理できるところまで処理する』",
    "《the target is no longer present, so the effect cannot resolve》",
    "《process as far as possible》",
  ].join("；");
  const resolution = extractRagCards(query, { cards: [] });

  assert.deepEqual(extractQuotedMentions(query), []);
  assert.deepEqual(resolution.resolvedCards, []);
  assert.deepEqual(resolution.unresolvedMentions, []);
  assert.deepEqual(resolution.ambiguousMentions, []);
});

test("past-action grammar does not leave a generic card category as an unquoted name", () => {
  const query = "本回合自己已经发动过魔法卡的效果。";
  const resolution = extractRagCards(query, { cards: [] });

  assert.deepEqual(extractUnquotedCardMentionCandidates(query), []);
  assert.deepEqual(resolution.unresolvedMentions, []);
});

test("long card names, abbreviations, and localized parentheses remain quoted mentions", () => {
  const mentions = extractQuotedMentions("《不能停止的机械巨龙》、（跨语种测试长卡名）、(AB龙)");
  assert.deepEqual(mentions, ["不能停止的机械巨龙", "跨语种测试长卡名", "AB龙"]);
});

test("unquoted_card_mentions_seed_retrieval_candidates", () => {
  const resolution = extractRagCards("对方发动了手卡破械童子童的效果，要将场上的破械神露天阙序破坏，对方的破械童子罗安能特殊召唤吗？", { cards: [], maxCards: 8 });
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械童子童"));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械神露天阙序"));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械童子罗安"));
});

test("sentence-initial unquoted ruling subject becomes an external card lookup seed", () => {
  const question = "破械焰魔天可以用对方场上的混沌之三幻魔代破吗？是消耗混沌之三幻魔不会被破坏的次数吗？";
  const candidates = extractUnquotedCardMentionCandidates(question);
  const resolution = extractRagCards(question, { cards: [], maxCards: 8 });

  assert.ok(candidates.includes("破械焰魔天"));
  assert.ok(candidates.includes("混沌之三幻魔"));
  assert.ok(!candidates.some((item) => item.includes("代破")));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "破械焰魔天"));
  assert.ok(resolution.unresolvedMentions.some((item) => item.input === "混沌之三幻魔"));
});

test("ordinary sentence subjects are not promoted to unquoted card names", () => {
  const questions = [
    "双方卡组和手卡均不存在能被特殊召唤的怪兽，这种情况下可以发动吗？",
    "这个效果可以在伤害步骤发动吗？",
    "处理后能否发动诱发效果？",
    "召唤成功后这个效果可以发动吗？",
    "伤害步骤中这个效果可以发动吗？",
    "对方回合这个效果可以发动吗？",
    "效果无效状态下可以发动吗？",
    "没有其他魔法陷阱时可以发动吗？",
    "怪兽被战斗破坏的场合可以特殊召唤吗？",
    "炎属性怪兽可以用作融合素材吗？",
  ];

  for (const question of questions) {
    assert.deepEqual(extractUnquotedCardMentionCandidates(question), []);
  }
});

test("an unknown unquoted card name containing attack is not truncated", () => {
  assert.ok(extractUnquotedCardMentionCandidates("高速攻击战士可以发动吗？").includes("高速攻击战士"));
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

test("ocg_name_normalization binds Japanese glyph variants to a unique localized identity", () => {
  const localCards = [{
    id: "glyph-variant-1",
    name: "架空独歩の義賊",
    aliases: ["架空独歩の義賊"],
  }];
  const resolution = extractRagCards("「架空独步的义贼」①能否发动？", { cards: localCards });

  assert.equal(normalizeCardKey("架空独歩の義賊"), normalizeCardKey("架空独步的义贼"));
  assert.equal(resolution.resolvedCards[0]?.id, "glyph-variant-1");
  assert.deepEqual(resolution.unresolvedMentions, []);
});

test("glyph normalization collisions remain ambiguous instead of selecting a card", () => {
  const localCards = [{
    id: "glyph-collision-a",
    name: "架空独歩の義賊",
    aliases: ["架空独歩の義賊"],
  }, {
    id: "glyph-collision-b",
    name: "架空独步的义贼",
    aliases: ["架空独步的义贼"],
  }];
  const resolution = extractRagCards("「架空独步的义贼」①能否发动？", { cards: localCards });

  assert.equal(resolution.resolvedCards.length, 0);
  assert.equal(resolution.ambiguousMentions[0]?.candidateCards.length, 2);
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

test("a unique short localized spelling resolves, while an ungrounded short two-edit name fails closed", () => {
  const localCards = [
    { id: "localized-short", name: "尤贝尔", aliases: ["尤贝尔"], sourceUrl: "https://db.ygoresources.com/data/card/localized-short" },
    { id: "localized-two-edit", name: "纳祭魔鬼莲", aliases: ["纳祭魔鬼莲"], sourceUrl: "https://db.ygoresources.com/data/card/localized-two-edit" },
  ];
  const resolution = extractRagCards("「于贝尔」与「献祭魔界莲」的效果如何处理？", { cards: localCards });

  assert.deepEqual(new Set(resolution.resolvedCards.map((card) => card.id)), new Set(["localized-short"]));
  assert.ok(resolution.resolvedCards.every((card) => card.confidence >= 0.9));
  assert.deepEqual(resolution.unresolvedMentions.map((item) => item.input), ["献祭魔界莲"]);
});

test("multiple two-edit neighbours remain unresolved instead of guessing", () => {
  const localCards = [
    { id: "near-two-a", name: "纳祭魔鬼莲", aliases: ["纳祭魔鬼莲"] },
    { id: "near-two-b", name: "奉祭魔界花", aliases: ["奉祭魔界花"] },
  ];
  const resolution = extractRagCards("「献祭魔界莲」的效果如何处理？", { cards: localCards });

  assert.equal(resolution.resolvedCards.length, 0);
  assert.equal(resolution.unresolvedMentions[0]?.input, "献祭魔界莲");
});

test("extra-deck context resolves a legacy localized name only with unique material evidence", () => {
  const localCards = [
    {
      id: "context-source",
      name: "始源融合者",
      aliases: ["始源融合者"],
      effectText: "将包含此卡在内的场上怪兽作为融合素材进行融合召唤。",
    },
    {
      id: "context-target",
      name: "星铠龙 正式终焉",
      aliases: ["星铠龙 正式终焉"],
      effectText: "“始源融合者”＋融合怪兽",
    },
    {
      id: "context-unrelated",
      name: "星铠龙 无关守卫",
      aliases: ["星铠龙 无关守卫"],
      effectText: "这张卡召唤成功时可以发动。抽1张卡。",
    },
  ];
  const positive = extractRagCards(
    "我方额外卡组有「星铠龙 旧版幻影」，召唤「始源融合者」时发动其效果。",
    { cards: localCards },
  );
  const noExtraDeckContext = extractRagCards(
    "「星铠龙 旧版幻影」的效果可以发动吗？",
    { cards: localCards },
  );
  const noResolvedMaterial = extractRagCards(
    "我方额外卡组有「星铠龙 旧版幻影」。",
    { cards: localCards },
  );

  assert.equal(positive.resolvedCards.some((card) => card.id === "context-target"), true);
  assert.equal(positive.unresolvedMentions.some((item) => item.input === "星铠龙 旧版幻影"), false);
  assert.equal(noExtraDeckContext.resolvedCards.some((card) => card.id === "context-target"), false);
  assert.equal(noExtraDeckContext.unresolvedMentions.some((item) => item.input === "星铠龙 旧版幻影"), true);
  assert.equal(noResolvedMaterial.resolvedCards.some((card) => card.id === "context-target"), false);
  assert.equal(noResolvedMaterial.unresolvedMentions.some((item) => item.input === "星铠龙 旧版幻影"), true);
});

test("extra-deck contextual name resolution stays unresolved when material evidence is ambiguous", () => {
  const localCards = [
    {
      id: "ambiguous-source",
      name: "通用融合者",
      aliases: ["通用融合者"],
      effectText: "将包含此卡在内的场上怪兽作为融合素材进行融合召唤。",
    },
    {
      id: "ambiguous-target-a",
      name: "星铠龙 正式终焉",
      aliases: ["星铠龙 正式终焉"],
      effectText: "“通用融合者”＋融合怪兽",
    },
    {
      id: "ambiguous-target-b",
      name: "星铠龙 正式黎明",
      aliases: ["星铠龙 正式黎明"],
      effectText: "“通用融合者”＋同步怪兽",
    },
  ];
  const resolution = extractRagCards(
    "我方额外卡组有「星铠龙 旧版幻影」，召唤「通用融合者」时发动其效果。",
    { cards: localCards },
  );

  assert.equal(resolution.resolvedCards.some((card) => /^ambiguous-target-/u.test(card.id)), false);
  assert.equal(resolution.unresolvedMentions.some((item) => item.input === "星铠龙 旧版幻影"), true);
});

test("legacy state reasoning also keeps cost and operation inside the same effect block", () => {
  const result = analyzeEffectStateTransition({
    userQuery: "对方场上存在的卡只有表侧表示的「测试抗性龙」1只，双方墓地没有卡。我方召唤「分段融合者」时，可以将「测试圣女」作为Cost丢弃来发动效果吗？",
    cardTexts: [
      {
        id: "card-text-split-source",
        cards: ["分段融合者"],
        text: [
          "①：这张卡召唤的情况下，舍弃1张手牌可以发动。抽1张卡。",
          "②：将包含此卡在内的自己或对方场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
        ].join("\n"),
      },
      {
        id: "card-text-split-protected",
        cards: ["测试抗性龙"],
        text: "只要自己或对方的场上或墓地存在“测试圣女”怪兽，此卡不受此卡以外的效果影响。",
      },
      {
        id: "card-text-split-saint",
        cards: ["测试圣女"],
        text: "测试圣女怪兽。",
      },
    ],
  });

  assert.equal(result.status, "not_applicable", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.reason, "legacy_pattern_semantics_not_authoritative");
});

test("numbered identities require a token boundary and validate an explicit name suffix", () => {
  const numberedCards = [
    {
      id: "no41",
      name: "编号41 泥睡测试兽 原名",
      jaName: "No.41 泥睡テスト獣",
      aliases: ["编号41 泥睡测试兽 原名", "No.41 泥睡テスト獣"],
    },
    {
      id: "cno41",
      name: "混沌编号41 泥睡测试兽",
      jaName: "CNo.41 泥睡テスト獣",
      aliases: ["混沌编号41 泥睡测试兽", "CNo.41 泥睡テスト獣"],
    },
  ];

  const bareNo = extractRagCards("对方场上的no.41防守表示存在。", { cards: numberedCards });
  const bareCNo = extractRagCards("对方场上的CNo.41防守表示存在。", { cards: numberedCards });
  const compatibleVariant = extractRagCards("「No.41 泥睡测试兽 别名」的效果可以发动吗？", { cards: numberedCards });
  const wrongSuffix = extractRagCards("「No.41 青眼白龙」的效果可以发动吗？", { cards: numberedCards });
  const misleadingSharedPrefix = extractRagCards("「No.41 泥睡测试兽 青眼白龙」的效果可以发动吗？", { cards: numberedCards });
  const correctNameWithWrongTail = extractRagCards("「No.41 泥睡测试兽 原名 青眼白龙」的效果可以发动吗？", { cards: numberedCards });
  const barePlusWrongDetail = extractRagCards("No.41在场，另有「No.41 青眼白龙」的效果。", { cards: numberedCards });
  const embeddedLatinToken = extractRagCards("「Techno41」的效果可以发动吗？", { cards: numberedCards });
  const unknownBareNumber = extractRagCards("对方场上的CNo.42防守表示存在。", { cards: numberedCards });

  assert.deepEqual(bareNo.resolvedCards.map((card) => card.id), ["no41"]);
  assert.deepEqual(bareCNo.resolvedCards.map((card) => card.id), ["cno41"]);
  assert.deepEqual(compatibleVariant.resolvedCards.map((card) => card.id), ["no41"]);
  assert.equal(wrongSuffix.resolvedCards.some((card) => card.id === "no41"), false);
  assert.equal(wrongSuffix.unresolvedMentions.some((item) => item.input === "No.41 青眼白龙"), true);
  assert.equal(misleadingSharedPrefix.resolvedCards.some((card) => card.id === "no41"), false);
  assert.equal(misleadingSharedPrefix.unresolvedMentions.some((item) => item.input === "No.41 泥睡测试兽 青眼白龙"), true);
  assert.equal(correctNameWithWrongTail.resolvedCards.some((card) => card.id === "no41"), false);
  assert.equal(correctNameWithWrongTail.unresolvedMentions.some((item) => item.input === "No.41 泥睡测试兽 原名 青眼白龙"), true);
  assert.equal(barePlusWrongDetail.resolvedCards.some((card) => card.id === "no41"), true);
  assert.equal(barePlusWrongDetail.unresolvedMentions.some((item) => item.input === "No.41 青眼白龙"), true);
  assert.equal(embeddedLatinToken.resolvedCards.some((card) => card.id === "no41"), false);
  assert.equal(unknownBareNumber.unresolvedMentions.some((item) => item.input === "CNo.42"), true);
});

const contextualSeriesCards = [
  {
    id: "18730",
    name: "对击斗魂 狂恋博士",
    cnName: "对击斗魂 狂恋博士",
    jaName: "VS Dr.マッドラヴ",
    enName: "Vanquish Soul Dr. Mad Love",
    cardType: "monster",
    effectText: "在自己・对手回合中可以发动。将场上的1只守备力最低的怪兽放回手牌。",
    aliases: ["对击斗魂 狂恋博士", "VS Dr.マッドラヴ", "Vanquish Soul Dr. Mad Love"],
  },
  {
    id: "18732",
    name: "对击斗魂 龙帝瓦里乌斯",
    cnName: "对击斗魂 龙帝瓦里乌斯",
    jaName: "VS 龍帝ヴァリウス",
    enName: "Vanquish Soul Caesar Valius",
    cardType: "monster",
    effectText: "以自己场上的龙族以外的1只对击斗魂怪兽为对象可以发动。将该怪兽放回手牌，从手牌将此卡特殊召唤。",
    aliases: ["对击斗魂 龙帝瓦里乌斯", "VS 龍帝ヴァリウス", "Vanquish Soul Caesar Valius"],
  },
  {
    id: "18738",
    name: "对击斗魂 龙帝之枪",
    cnName: "对击斗魂 龙帝之枪",
    jaName: "VS 龍帝ノ槍",
    enName: "Vanquish Soul Calamity Caesar",
    cardType: "trap",
    effectText: "对手发动以自己场上的卡为对象的效果时可以发动。将该发动无效并破坏。",
    aliases: ["对击斗魂 龙帝之枪", "VS 龍帝ノ槍", "Vanquish Soul Calamity Caesar"],
  },
  {
    id: "20489",
    name: "原石龙 帝皇龙",
    cnName: "原石龙 帝皇龙",
    jaName: "原石竜インペリアル・ドラゴン",
    enName: "Primite Imperial Dragon",
    cardType: "monster",
    effectText: "向对手出示手牌的此卡可以发动。进行1只原石怪兽的召唤。",
    aliases: ["原石龙 帝皇龙", "原石竜インペリアル・ドラゴン", "Primite Imperial Dragon"],
  },
  {
    id: "other-series-doctor",
    name: "异界斗魂 狂魔博士",
    cnName: "异界斗魂 狂魔博士",
    jaName: "US Dr.マッドラヴ",
    cardType: "monster",
    effectText: "从手牌特殊召唤。",
    aliases: ["异界斗魂 狂魔博士", "US Dr.マッドラヴ"],
  },
];

test("cross-locale series aliases keep one-edit correction inside the named series", () => {
  const resolution = extractRagCards("「VS狂魔博士」的效果可以发动吗？", { cards: contextualSeriesCards });

  assert.equal(resolution.resolvedCards[0]?.id, "18730");
  assert.equal(resolution.resolvedCards.some((card) => card.id === "other-series-doctor"), false);
  assert.deepEqual(resolution.unresolvedMentions, []);
});

test("chain number plus zone and action extracts and contextually resolves an unquoted short card name", () => {
  const questions = [
    "当对手场上的no.41防守表示存在时，我c1发动场上vs狂魔博士的效果，c2手牌龙帝进行替换，连锁处理结算时，c1的博士效果还会生效弹走场上防御力最高的卡吗？",
    "当对手场上的【No.41 泥睡魔兽 睡梦貘】防守表示在场上存在。我方c1发动场上攻击表示的【VS狂魔博士】效果，C2从手牌发动【龙帝】替换效果，连锁逆算处理时，c1的博士效果还会生效弹走场上防御力最高的卡吗？",
  ];

  assert.ok(extractUnquotedCardMentionCandidates(questions[0]).includes("龙帝"));
  for (const question of questions) {
    const resolution = extractRagCards(question, { cards: contextualSeriesCards, maxCards: 8 });
    const resolvedIds = new Set(resolution.resolvedCards.map((card) => card.id));
    assert.equal(resolvedIds.has("18730"), true);
    assert.equal(resolvedIds.has("18732"), true);
    assert.equal(resolvedIds.has("18738"), false);
    assert.equal(resolution.unresolvedMentions.some((item) => item.input === "龙帝"), false);
    assert.equal(resolution.ambiguousMentions.some((item) => item.input === "龙帝"), false);
  }
});

test("contextual short-name resolution never combines mechanics from separate effect blocks", () => {
  const splitMechanicsCard = {
    id: "split-mechanics",
    name: "对击斗魂 龙帝伪装",
    cnName: "对击斗魂 龙帝伪装",
    jaName: "VS 龍帝フェイク",
    cardType: "monster",
    effectText: [
      "①：从手牌将此卡特殊召唤。",
      "②：将自己场上的1只怪兽放回手牌。",
    ].join("\n"),
    aliases: ["对击斗魂 龙帝伪装", "VS 龍帝フェイク"],
  };
  const resolution = extractRagCards(
    "「VS狂魔博士」在场，C2手牌龙帝进行替换。",
    { cards: [...contextualSeriesCards, splitMechanicsCard], maxCards: 8 },
  );

  assert.equal(resolution.resolvedCards.some((card) => card.id === "split-mechanics"), false);
  assert.equal(resolution.resolvedCards.some((card) => card.id === "18732"), true);
  const ambiguousIds = new Set(resolution.ambiguousMentions
    .find((item) => item.input === "龙帝")?.candidateCards.map((card) => card.id) || []);
  assert.equal(ambiguousIds.has("split-mechanics"), false);
});

test("an isolated short card name remains ambiguous instead of selecting the first matching card", () => {
  const resolution = extractRagCards("「龙帝」是什么卡？", { cards: contextualSeriesCards });
  const ambiguity = resolution.ambiguousMentions.find((item) => item.input === "龙帝");

  assert.equal(resolution.resolvedCards.length, 0);
  assert.deepEqual(ambiguity?.candidateCards.map((card) => card.id).sort(), ["18732", "18738"]);
});

test("short-name context uses the actual occurrence and excludes an enclosing full card name", () => {
  const resolution = extractRagCards(
    "对方场上的「对击斗魂 龙帝之枪」存在，我方C1发动「VS狂魔博士」的效果，C2手牌龙帝进行替换。",
    { cards: contextualSeriesCards, maxCards: 8 },
  );
  const resolvedIds = new Set(resolution.resolvedCards.map((card) => card.id));

  assert.equal(resolvedIds.has("18730"), true);
  assert.equal(resolvedIds.has("18732"), true);
  assert.equal(resolvedIds.has("18738"), true);
  assert.equal(resolution.ambiguousMentions.some((item) => item.input === "龙帝"), false);
});

test("the same short surface with conflicting clause contexts stays ambiguous", () => {
  const resolution = extractRagCards(
    "「VS狂魔博士」在场。C1场上龙帝发动并无效效果，C2手牌龙帝进行替换。",
    { cards: contextualSeriesCards, maxCards: 8 },
  );
  const ambiguity = resolution.ambiguousMentions.find((item) => item.input === "龙帝");

  assert.equal(resolution.resolvedCards.some((card) => card.id === "18732"), false);
  assert.equal(resolution.resolvedCards.some((card) => card.id === "18738"), false);
  assert.deepEqual(ambiguity?.candidateCards.map((card) => card.id).sort(), ["18732", "18738"]);
});

test("resolved cards beyond maxCards remain visible as explicit card-limit mentions", () => {
  const resolution = extractRagCards(
    "C1发动「VS狂魔博士」的效果，C2手牌龙帝进行替换。",
    { cards: contextualSeriesCards, maxCards: 1 },
  );
  const omitted = resolution.omittedResolvedCards.find((item) => item.input === "龙帝");

  assert.deepEqual(resolution.resolvedCards.map((card) => card.id), ["18730"]);
  assert.equal(resolution.unresolvedMentions.some((item) => item.reason === "resolved_card_limit_exceeded"), false);
  assert.equal(omitted?.reason, "resolved_card_limit_exceeded");
  assert.equal(omitted?.resolvedCardId, "18732");
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
  assert.match(answer.shortAnswer, /用户提供文本/u);
  assert.deepEqual(answer.usedEvidence, []);
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
  assert.deepEqual(answer.usedEvidence, []);
  assert.ok(
    answer.debug.publicFinalValidation.primary.diagnosticWarnings
      .includes("official_confirmation_without_direct_citation_downgraded"),
  );
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

test("rag pipeline preserves low confidence when no effect template proves the answer", async () => {
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
  assert.equal(answer.answerLevel, "low_confidence_analysis");
  assert.ok(!answer.riskFlags.includes("low_confidence_upgraded_to_rule_analysis_with_card_text"));
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

test("official QA applicability review uses Relay Sol low once and never sends candidate answers", async () => {
  const calls = [];
  const candidate = {
    id: "anonymous-related-applicability-a",
    type: "related",
    isDirect: false,
    question: "QUESTION_ONLY_MARKER：某公开区域效果在相同时点能否发动？",
    answer: "ANSWER_MUST_NOT_REACH_CLASSIFIER_MARKER",
    fullText: "FULL_TEXT_MUST_NOT_REACH_CLASSIFIER_MARKER",
    questionType: "activation_legality",
    matchedQuestionCardIds: ["71001"],
  };
  const result = await callOfficialQaApplicabilityModel({
    userQuery: "当前问题询问同一发动窗口中的发动资格。",
    candidates: [candidate],
    resolvedCards: [{ id: "71001", name: "匿名卡甲" }],
    dataRevision: "anonymous-applicability-relay-v1",
    env: {
      RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
      RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
      RELAY_EVIDENCE_APPLICABILITY_MODEL: "gpt-5.6-sol",
      RAG_EVIDENCE_APPLICABILITY_REASONING_EFFORT: "low",
    },
    modelInvoker: async (input) => {
      calls.push(input);
      return {
        assessments: [{
          id: candidate.id,
          verdict: "APPLICABLE",
          sharedConditions: ["相同发动窗口"],
          missingConditions: [],
          conflictingConditions: [],
          reason: "问题前提兼容。",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        requestModel: "gpt-5.6-sol",
        responseModel: "gpt-5.6-sol",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "relay");
  assert.equal(calls[0].modelName, "gpt-5.6-sol");
  assert.equal(calls[0].reasoningEffort, "low");
  assert.match(calls[0].prompt, /QUESTION_ONLY_MARKER/u);
  assert.doesNotMatch(calls[0].prompt, /ANSWER_MUST_NOT_REACH_CLASSIFIER_MARKER|FULL_TEXT_MUST_NOT_REACH_CLASSIFIER_MARKER/u);
  assert.equal(result.status, "completed");
  assert.equal(result.providerUsed, "relay");
  assert.equal(result.requestedModel, "gpt-5.6-sol");
  assert.equal(result.returnedModel, "gpt-5.6-sol");
  assert.equal(result.assessments[0].verdict, "APPLICABLE");
});

test("official QA applicability real adapter shares the Relay USD budget and sends low reasoning effort", async () => {
  const calls = [];
  const candidateId = "anonymous-related-relay-adapter-20480701";
  const now = new Date("2048-07-01T00:00:00.000Z");
  const env = {
    RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
    RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
    RELAY_EVIDENCE_APPLICABILITY_MODEL: "gpt-5.6-sol",
    RAG_EVIDENCE_APPLICABILITY_REASONING_EFFORT: "low",
    RAG_EVIDENCE_APPLICABILITY_MAX_OUTPUT_TOKENS: "256",
    RELAY_API_KEY: "relay-test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  await resetRagBudget({ env, now });
  const result = await callOfficialQaApplicabilityModel({
    userQuery: "这个匿名场景能否采用该相关问答？",
    candidates: [{
      id: candidateId,
      type: "related",
      isDirect: false,
      question: "匿名相关问答的场景前提。",
    }],
    dataRevision: "anonymous-relay-adapter-20480701",
    env,
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      const content = JSON.stringify({
        assessments: [{
          id: candidateId,
          verdict: "UNKNOWN",
          sharedConditions: [],
          missingConditions: ["需要额外场景事实"],
          conflictingConditions: [],
          reason: "不能仅凭候选问题确认。",
        }],
      });
      return new Response(`data: ${JSON.stringify({
        model: "gpt-5.6-sol",
        choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer relay-test-key");
  assert.equal(calls[0].body.model, "gpt-5.6-sol");
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.equal(result.status, "completed");
  assert.equal(result.returnedModel, "gpt-5.6-sol");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.estimatedCostUsd > 0, true);
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:relay");
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, result.estimatedCostUsd);
});

test("applicability cache hits do not charge twice and final Relay calls share the same USD ledger", async () => {
  const candidateId = "anonymous-related-shared-ledger-20480702";
  const now = new Date("2048-07-02T00:00:00.000Z");
  const env = {
    MODEL_PROVIDER: "relay",
    RAG_MODEL: "gpt-5.6-sol",
    RAG_REASONING_EFFORT: "low",
    RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
    RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
    RELAY_EVIDENCE_APPLICABILITY_MODEL: "gpt-5.6-sol",
    RAG_EVIDENCE_APPLICABILITY_REASONING_EFFORT: "low",
    RELAY_API_KEY: "relay-test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    API_BUDGET_TIMEZONE: "UTC",
  };
  await resetRagBudget({ env, now });
  let fetchCount = 0;
  const fetchImpl = async (_url, options) => {
    fetchCount += 1;
    const prompt = JSON.parse(options.body).messages[0].content;
    const content = prompt.includes("CANDIDATE_QUESTIONS_JSON")
      ? JSON.stringify({
          assessments: [{
            id: candidateId,
            verdict: "UNKNOWN",
            sharedConditions: [],
            missingConditions: ["需要更多事实"],
            conflictingConditions: [],
            reason: "资料不足。",
          }],
        })
      : JSON.stringify(modelJson("Shared Relay ledger OK"));
    return new Response(`data: ${JSON.stringify({
      model: "gpt-5.6-sol",
      choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const input = {
    userQuery: "共享预算与缓存测试。",
    candidates: [{ id: candidateId, type: "related", isDirect: false, question: "匿名候选问题。" }],
    dataRevision: "anonymous-shared-ledger-20480702",
    env,
    now,
    fetchImpl,
  };

  const first = await callOfficialQaApplicabilityModel(input);
  const cached = await callOfficialQaApplicabilityModel(input);
  const final = await callRagModel({ prompt: "输出最终裁定 JSON", env, now, fetchImpl });

  assert.equal(fetchCount, 2);
  assert.equal(first.cacheHit, false);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.estimatedCostUsd, 0);
  assert.equal(
    final.budgetStatus.bucket.spentTodayUsd,
    Number((first.estimatedCostUsd + final.estimatedCostUsd).toFixed(8)),
  );
});

test("public profiles hard-disable the independent applicability stage even if deployment config is stale", async () => {
  const candidateId = "anonymous-non-relay-final-applicability-20480703";
  const publicEnv = createPublicAnswerModelEnv({
    DEEPSEEK_API_KEY: "deepseek-final-key",
    RELAY_API_KEY: "relay-applicability-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    API_BUDGET_TIMEZONE: "UTC",
    RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
  }, "deepseek-v4-flash-low");
  const now = new Date("2048-07-03T00:00:00.000Z");
  await resetRagBudget({ env: publicEnv, now });
  let call = null;
  const result = await callOfficialQaApplicabilityModel({
    userQuery: "非 Relay 最终模型也应筛选相关问答。",
    candidates: [{ id: candidateId, type: "related", isDirect: false, question: "匿名候选问题。" }],
    dataRevision: "anonymous-non-relay-final-applicability-20480703",
    env: publicEnv,
    now,
    fetchImpl: async (url, options) => {
      call = { url, options };
      const content = JSON.stringify({
        assessments: [{
          id: candidateId,
          verdict: "UNKNOWN",
          sharedConditions: [],
          missingConditions: ["需要更多场景事实"],
          conflictingConditions: [],
          reason: "无法确认。",
        }],
      });
      return new Response(`data: ${JSON.stringify({
        model: "gpt-5.6-sol",
        choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  assert.equal(publicEnv.MODEL_PROVIDER, "deepseek");
  assert.equal(publicEnv.RELAY_API_KEY, undefined);
  assert.equal(publicEnv.RAG_EVIDENCE_APPLICABILITY_ENABLED, "false");
  assert.equal(call, null);
  assert.equal(result.status, "skipped");
  assert.equal(result.complete, false);
  assert.ok(result.warnings.includes("official_qa_applicability_disabled"));
});

test("public model environment keeps the independent reviewer off unless explicitly enabled", () => {
  const publicEnv = createPublicAnswerModelEnv({
    RELAY_API_KEY: "relay-final-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
  }, "relay-gpt-5.6-sol-low");

  assert.equal(publicEnv.MODEL_PROVIDER, "relay");
  assert.equal(publicEnv.RAG_EVIDENCE_APPLICABILITY_ENABLED, "false");
});

test("failed official QA applicability review passes every related candidate through", async () => {
  const candidates = [{
    id: "anonymous-related-passthrough",
    type: "related",
    isDirect: false,
    question: "某个效果在处理时是否适用？",
  }];
  const result = await callOfficialQaApplicabilityModel({
    userQuery: "当前问题需要比较这个处理前提。",
    candidates,
    dataRevision: "anonymous-applicability-failure-v1",
    env: {
      RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
      RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
    },
    modelInvoker: async () => {
      const error = new Error("synthetic relay failure");
      error.usage = { prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 };
      error.estimatedCostUsd = 9.99;
      throw error;
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.warnings.includes("official_qa_applicability_passthrough"));
  assert.equal(result.estimatedCostUsd, 0);
  assert.deepEqual(result.tokenUsage, {});
});

test("applicability review is disabled by default even when Relay transport is configured", async () => {
  let fetchCalled = false;
  const result = await callOfficialQaApplicabilityModel({
    userQuery: "禁用时保持候选。",
    candidates: [{
      id: "anonymous-related-disabled",
      type: "related",
      isDirect: false,
      question: "禁用分类器时不应发送这个问题。",
    }],
    env: {
      RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
      RELAY_API_KEY: "must-not-be-used",
      RELAY_BASE_URL: "https://relay.example.test/v1",
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("paid call must not run");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.status, "skipped");
  assert.ok(result.warnings.includes("official_qa_applicability_disabled"));
  assert.equal(result.estimatedCostUsd, 0);
});

test("an insecure applicability Relay endpoint fails before fetch or budget reservation", async () => {
  let fetchCalled = false;
  const result = await callOfficialQaApplicabilityModel({
    userQuery: "不安全端点不得发送。",
    candidates: [{
      id: "anonymous-related-insecure-endpoint",
      type: "related",
      isDirect: false,
      question: "匿名候选问题。",
    }],
    dataRevision: "anonymous-insecure-endpoint-v1",
    env: {
      RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
      RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
      RELAY_API_KEY: "must-not-be-used",
      RELAY_BASE_URL: "http://relay.example.test/v1",
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("insecure endpoint must not fetch");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.status, "failed");
  assert.equal(result.estimatedCostUsd, 0);
  assert.equal(result.budgetStatus, null);
  assert.ok(result.warnings.includes("official_qa_applicability_passthrough"));
});

test("official QA applicability cache reuses a complete batch without another model call", async () => {
  let calls = 0;
  const input = {
    userQuery: "匿名缓存问题 2040-06-01",
    candidates: [{
      id: "anonymous-related-cache-20400601",
      type: "related",
      isDirect: false,
      question: "缓存候选的前提是否适用于当前问题？",
    }],
    dataRevision: "anonymous-applicability-cache-20400601",
    env: {
      RAG_EVIDENCE_APPLICABILITY_ENABLED: "true",
      RAG_EVIDENCE_APPLICABILITY_PROVIDER: "relay",
      RELAY_EVIDENCE_APPLICABILITY_MODEL: "gpt-5.6-sol",
      RAG_EVIDENCE_APPLICABILITY_REASONING_EFFORT: "low",
    },
    modelInvoker: async () => {
      calls += 1;
      return {
        assessments: [{
          id: "anonymous-related-cache-20400601",
          verdict: "UNKNOWN",
          sharedConditions: [],
          missingConditions: ["缺少一个场景事实"],
          conflictingConditions: [],
          reason: "保留给最终模型核对。",
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      };
    },
  };
  const first = await callOfficialQaApplicabilityModel(input);
  const second = await callOfficialQaApplicabilityModel(input);

  assert.equal(calls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.tokenUsage, {});
  assert.equal(second.estimatedCostUsd, 0);
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

test("final reasoner uses retrieved restrictive evidence without a local blocker override", async () => {
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
      shortAnswer: "不能发动。无限泡影正在发动中，不能作为返回手卡处理的可适用卡，且题面没有其他魔法・陷阱卡。",
      reasoning: ["一般诱发条件满足，但必做的返回处理没有可适用卡。"],
      usedCards: ["无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: "rule-activated-normal-spell-trap-cannot-return#p1-1", type: "rulebook", title: "发动中的通常魔陷不能返回手卡" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.match(answer.shortAnswer, /无限泡影/u);
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.equal(answer.debug.retrievalCounts.operationLegalityChecks, 0);
  assert.ok(answer.usedEvidence.some((item) => item.id === "rule-activated-normal-spell-trap-cannot-return#p1-1"));
  assert.ok(!answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(!answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("final reasoner can reject a generic trigger answer after reading restrictive evidence", async () => {
  const genericFaq = {
    id: "card-faq-22130-generic-trigger",
    recordType: "card-faq",
    title: "天雷之双风神 一般发动条件",
    cardIds: ["22130"],
    cards: ["天雷之双风神 息那"],
    text: "对手发动魔法・陷阱・怪兽效果时，自己场上有风属性怪兽的场合，可以直接连锁发动。",
  };
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？",
    cards: thunderImpermanenceCards(),
    records: [activatedSpellTrapReturnRule],
    qaRecords: [genericFaq],
    rulebookModelInvoker: async () => {
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
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "不能发动。虽然一般诱发条件满足，但场上没有能完成必做返回处理的魔法・陷阱卡。",
      reasoning: ["正在发动的通常陷阱不能由这个处理返回手卡。"],
      usedCards: ["绚岚之达维", "无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: "rule-activated-normal-spell-trap-cannot-return#p1-1", type: "rulebook", title: "发动中的通常魔陷不能返回手卡" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.match(finalPrompt, /rule-activated-normal-spell-trap-cannot-return#p1-1/u);
  assert.match(finalPrompt, /発動中の通常魔法・通常罠カード/u);
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.ok(!answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(!answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("raw restrictive evidence remains visible when the preparation model is empty", async () => {
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
        shortAnswer: "不能发动。场上没有能完成必做返回处理的魔法・陷阱卡。",
        reasoning: ["最终模型直接核对了规则原文，而不是采用空的准备模型结论。"],
        usedCards: ["无限泡影", "天雷之双风神 息那"],
        usedEvidence: [{ id: "rule-activated-normal-spell-trap-cannot-return#p1-1", type: "rulebook", title: "发动中的通常魔陷不能返回手卡" }],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.match(finalPrompt, /発動中の通常魔法・通常罠カードはその処理で手札に戻せません/u);
  assert.doesNotMatch(finalPrompt, /hasBlockingCheck|hasUnresolvedConstraints/u);
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.ok(!answer.riskFlags.includes("operation_legality_blocker_applied"));
});
test("final reasoner reconciles a grounded restriction with a generic trigger FAQ", async () => {
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
      shortAnswer: "不能发动。一般诱发条件虽满足，但题面没有其他可返回的魔法・陷阱卡。",
      reasoning: ["正在发动中的无限泡影不能返回手卡，所以必做处理无法完成。"],
      usedCards: ["绚岚之达维", "无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: "rule-activated-normal-spell-trap-cannot-return#p1-1", type: "rulebook", title: "发动中的通常魔陷不能返回手卡" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /不能发动/u);
  assert.match(answer.shortAnswer, /没有其他/u);
  assert.ok(!answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(!answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("focused preparation fallback still leaves the final verdict to the final reasoner", async () => {
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
      shortAnswer: "不能发动。无限泡影正在发动中且没有其他可返回的魔法・陷阱卡。",
      reasoning: ["最终模型使用了 focused preparation 提供的逐字规则证据。"],
      usedCards: ["无限泡影", "天雷之双风神 息那"],
      usedEvidence: [{ id: "rule-activated-normal-spell-trap-cannot-return#p1-1", type: "rulebook", title: "发动中的通常魔陷不能返回手卡" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.deepEqual(tasks, []);
  assert.match(answer.shortAnswer, /不能发动/u);
  assert.doesNotMatch(answer.shortAnswer, /^可以发动/u);
  assert.ok(answer.debug.rulebookGroundingWarnings.includes("pure_llm_pipeline"));
  assert.ok(!answer.riskFlags.includes("operation_legality_blocker_applied"));
  assert.ok(!answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
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

test("empty final-model output degrades safely instead of using a prepared answer", async () => {
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

  assert.doesNotMatch(answer.shortAnswer, /可以发动/u);
  assert.match(answer.shortAnswer, /没有返回可展示的完整答案/u);
  assert.ok(!answer.riskFlags.includes("final_model_failed_using_grounded_operation_analysis"));
});

test("final reasoner uses exact scenario evidence for the entire effect resolution", async () => {
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
      shortAnswer: "可以选择为对象。处理时先取除全部X素材，抗性立即不再适用，因此枪王正常回到额外卡组。",
      reasoning: ["素材取除不是对怪兽适用的处理。", "失去素材后永续抗性不再适用，继续处理返回额外卡组。"],
      usedCards: ["超量叠光延迟", "No.86 英豪冠军 击灭枪王"],
      usedEvidence: [{ id: exactPassageId, type: "rulebook", title: exactRule.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /枪王正常回到额外卡组/u);
  assert.doesNotMatch(answer.shortAnswer, /留在场上/u);
  assert.ok(!answer.riskFlags.includes("answer_constrained_by_exact_scenario_evidence"));
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

test("card text cannot override a model's explicit needs-more-info result", async () => {
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
  assert.equal(answer.answerLevel, "needs_more_info");
  assert.match(answer.shortAnswer, /资料不足/u);
  assert.ok(!answer.riskFlags.includes("needs_more_info_upgraded_to_rule_analysis_with_card_text"));
  assert.deepEqual(answer.usedEvidence, []);
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

test("partial related evidence cannot override a model's explicit needs-more-info result", async () => {
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
  assert.equal(answer.answerLevel, "needs_more_info");
  assert.ok(!answer.riskFlags.includes("needs_more_info_downgraded_to_low_confidence_with_evidence"));
});

test("no evidence does not let local code replace the model's ruling", async () => {
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
  assert.equal(answer.answerLevel, "rule_analysis");
  assert.equal(answer.shortAnswer, "模型试图无资料分析。");
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
  assert.ok(
    answer.debug.publicFinalValidation.primary.diagnosticWarnings
      .includes("official_confirmation_without_direct_citation_downgraded"),
  );
  assert.equal(answer.usedEvidence[0].type, "related");
});

test("non-JSON model text remains visible as low-confidence output without a repair call", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试龙」可以发动①效果吗？",
    cards,
    records,
    qaRecords,
    modelInvoker: async () => "not JSON",
  });
  assert.equal(answer.answerLevel, "low_confidence_analysis");
  assert.equal(answer.shortAnswer, "not JSON");
  assert.ok(answer.riskFlags.includes("model_json_parse_failed"));
  assert.ok(answer.riskFlags.includes("model_output_not_json"));
  assert.equal(answer.debug.publicFinalValidation.callCount, 1);
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
          choices: [{ message: { content: "", reasoning_content: "内部推理已耗尽首轮输出额度" }, finish_reason: "length" }],
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
  assert.equal(calls[1].max_tokens, 4096);
  assert.deepEqual(calls[1].thinking, { type: "disabled" });
  assert.deepEqual(calls[1].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(calls[1], "reasoning_effort"), false);
  assert.equal(calls[1].temperature, 0);
  assert.equal(result.answer.shortAnswer, "恢复后的答案");
  assert.equal(result.tokenUsage.prompt_tokens, 140);
  assert.equal(result.tokenUsage.completion_tokens, 381);
  assert.ok(result.warnings.includes("deepseek_compact_recovery_succeeded"));
  assert.equal(result.warnings.some((warning) => warning.startsWith("deepseek_empty_content:")), false);
  assert.equal(result.warnings.includes("deepseek_output_truncated_by_token_limit"), false);
  assert.deepEqual(result.generationAttempts.map((item) => item.finishReason), ["length", "stop"]);
  assert.equal(result.generationAttempts[0].reasoningContentPresent, true);
  assert.equal(result.generationAttempts[0].reasoningContentChars > 0, true);
  assert.equal("reasoningContent" in result.generationAttempts[0], false);
  assert.deepEqual(result.generationAttempts.map((item) => item.thinkingMode), ["enabled", "disabled"]);
});

test("deepseek_thinking_invalid_json_retries_with_non_thinking_json_recovery", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "原始推理提示词",
    recoveryPrompt: "只整理为合法 RAG JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      RAG_MAX_OUTPUT_TOKENS: "500",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return jsonResponse({
          choices: [{ message: { content: "可以发动，但这是自然语言而不是 RAG JSON。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(modelJson("恢复后的结构化答案")) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].thinking, { type: "enabled" });
  assert.equal(Object.hasOwn(calls[0], "response_format"), false);
  assert.deepEqual(calls[1].thinking, { type: "disabled" });
  assert.deepEqual(calls[1].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(calls[1], "reasoning_effort"), false);
  assert.equal(calls[1].temperature, 0);
  assert.equal(result.answer.shortAnswer, "恢复后的结构化答案");
  assert.equal(result.tokenUsage.prompt_tokens, 110);
  assert.equal(result.tokenUsage.completion_tokens, 50);
  assert.ok(result.warnings.includes("deepseek_primary_invalid_json"));
  assert.ok(result.warnings.includes("deepseek_compact_recovery_attempted"));
  assert.ok(result.warnings.includes("deepseek_compact_recovery_succeeded"));
  assert.deepEqual(result.generationAttempts.map((item) => item.thinkingMode), ["enabled", "disabled"]);
});

test("deepseek valid JSON is deterministically normalized before public raw validation", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 RAG JSON",
    recoveryPrompt: "不应调用恢复",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              answerLevel: "rule_analysis",
              shortAnswer: "结构可确定性补全。",
              reasoning: "单条理由转换为数组。",
              usedEvidence: [null, { id: "" }],
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], "response_format"), false);
  assert.ok(result.warnings.includes("model_json_structure_normalized"));
  assert.deepEqual(JSON.parse(result.rawText), {
    answerLevel: "rule_analysis",
    shortAnswer: "结构可确定性补全。",
    reasoning: ["单条理由转换为数组。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "low",
  });
});

test("deepseek illegal answerLevel is never normalized into an accepted semantic core", async () => {
  const result = await callRagModel({
    prompt: "输出 RAG JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            answerLevel: "certain_yes",
            shortAnswer: "不得采用此结论。",
            reasoning: ["非法枚举不能被升级。"],
          }),
        },
        finish_reason: "stop",
      }],
      usage: {},
    }),
  });

  assert.equal(result.answer.answerLevel, "needs_more_info");
  assert.doesNotMatch(result.answer.shortAnswer, /不得采用此结论/u);
  assert.ok(result.warnings.includes("deepseek_primary_invalid_schema"));
  assert.ok(result.warnings.includes("model_json_invalid_schema"));
});

test("deepseek_compact_recovery_accepts_minimal_normalizable_json", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "原始长提示词",
    recoveryPrompt: "紧凑恢复提示词",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      RAG_MAX_OUTPUT_TOKENS: "500",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return jsonResponse({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 30, completion_tokens: 500, total_tokens: 530 },
        });
      }
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              answerLevel: "rule_analysis",
              shortAnswer: "恢复后的最小答案",
              reasoning: "紧凑恢复仍保留了结论依据。",
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.answer.shortAnswer, "恢复后的最小答案");
  assert.deepEqual(result.answer.reasoning, ["紧凑恢复仍保留了结论依据。"]);
  assert.deepEqual(result.answer.usedEvidence, []);
  assert.ok(result.warnings.includes("deepseek_compact_recovery_succeeded"));
  assert.ok(result.warnings.includes("model_json_structure_normalized"));
  assert.deepEqual(JSON.parse(result.rawText), {
    answerLevel: "rule_analysis",
    shortAnswer: "恢复后的最小答案",
    reasoning: ["紧凑恢复仍保留了结论依据。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "low",
  });
});

test("an aborted compact recovery is not dispatched and still records the completed primary response", async () => {
  const now = new Date("2026-08-01T03:00:00.000Z");
  const controller = new AbortController();
  const env = {
    MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  };
  await resetRagBudget({ env, now });
  let callCount = 0;
  const result = await callRagModel({
    prompt: "primary paid response",
    recoveryPrompt: "aborted recovery",
    env,
    now,
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      callCount += 1;
      assert.equal(options.signal, controller.signal);
      if (callCount === 1) {
        const message = {};
        Object.defineProperty(message, "content", {
          enumerable: true,
          get() {
            controller.abort(new DOMException("client disconnected", "AbortError"));
            return "";
          },
        });
        return jsonResponse({
          choices: [{ message, finish_reason: "length" }],
          usage: { prompt_tokens: 1_000, completion_tokens: 500 },
        });
      }
      throw controller.signal.reason;
    },
  });
  const status = await getRagBudgetStatus({ env, now });

  assert.equal(callCount, 1);
  assert.ok(result.warnings.some((warning) => warning.startsWith("deepseek_compact_recovery_call_failed:")));
  assert.equal(result.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"), false);
  assert.equal(result.estimatedCostCny, estimateDeepSeekCostCny({
    prompt_tokens: 1_000,
    completion_tokens: 500,
  }, env));
  assert.equal(status.spentTodayCny, result.estimatedCostCny);
});

test("deepseek_primary_and_compact_recovery_both_empty_fail_safely", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "原始长提示词",
    recoveryPrompt: "紧凑恢复提示词",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      RAG_MAX_OUTPUT_TOKENS: "500",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({
        choices: [{ message: { content: "", reasoning_content: "只产生了内部推理" }, finish_reason: "length" }],
        usage: { prompt_tokens: 30, completion_tokens: calls.length === 1 ? 500 : 4096, total_tokens: calls.length === 1 ? 530 : 4126 },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_tokens, 4096);
  assert.ok(result.warnings.includes("deepseek_compact_recovery_attempted"));
  assert.ok(result.warnings.includes("deepseek_compact_recovery_failed"));
  assert.ok(result.warnings.includes("deepseek_compact_recovery_empty"));
  assert.equal(result.warnings.includes("deepseek_compact_recovery_succeeded"), false);
  assert.ok(result.answer.riskFlags.includes("model_json_parse_failed"));
  assert.deepEqual(result.generationAttempts.map((item) => item.finishReason), ["length", "length"]);
  assert.equal(result.generationAttempts.every((item) => item.reasoningContentPresent), true);
});

test("deepseek_compact_recovery_rejects_incomplete_json_even_when_nonempty", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "原始长提示词",
    recoveryPrompt: "紧凑恢复提示词",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      RAG_MAX_OUTPUT_TOKENS: "500",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return jsonResponse({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 30, completion_tokens: 500, total_tokens: 530 },
        });
      }
      return jsonResponse({
        choices: [{
          message: { content: "{\"answerLevel\":\"rule_analysis\",\"shortAnswer\":\"这段残缺结果不得采用\",\"reasoning\":[" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(result.warnings.includes("deepseek_compact_recovery_failed"));
  assert.ok(result.warnings.includes("deepseek_compact_recovery_invalid_json"));
  assert.equal(result.warnings.includes("deepseek_compact_recovery_succeeded"), false);
  assert.doesNotMatch(result.answer.shortAnswer, /这段残缺结果不得采用/u);
});

test("deepseek thinking requests omit incompatible JSON response mode without retrying HTTP 400", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ error: { message: "bad request" } }, false, 400);
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].thinking, { type: "enabled" });
  assert.equal(Object.hasOwn(calls[0], "response_format"), false);
  assert.ok(result.warnings.includes("model_call_failed:deepseek 400"));
});

test("deepseek_provider_builds_request", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      RAG_MODEL_TIER: "flash",
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
  assert.equal(Object.hasOwn(calls[0].body, "response_format"), false);
  assert.equal(calls[0].body.max_tokens, 321);
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.thinking, { type: "enabled" });
  assert.equal(calls[0].body.reasoning_effort, "high");
  assert.equal(Object.hasOwn(calls[0].body, "temperature"), false);
});

test("deepseek response extraction accepts structured text content parts", async () => {
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async () => jsonResponse({
      choices: [{
        message: {
          content: [{ type: "text", content: JSON.stringify(modelJson("Structured content OK")) }],
        },
        finish_reason: "stop",
      }],
      usage: {},
    }),
  });

  assert.equal(result.answer.shortAnswer, "Structured content OK");
  assert.equal(result.warnings.some((warning) => warning.includes("empty_content")), false);
});

test("deepseek_final_generation_uses_configured_primary_model", async () => {
  const calls = [];
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "deepseek-pro-tier",
      DEEPSEEK_FLASH_MODEL: "deepseek-flash-tier",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelJson("Flash OK")) } }], usage: {} });
    },
  });
  assert.equal(calls[0].model, "deepseek-pro-tier");
  assert.equal(calls[0].max_tokens, 32000);
  assert.deepEqual(calls[0].thinking, { type: "enabled" });
  assert.equal(calls[0].reasoning_effort, "high");
  assert.equal(Object.hasOwn(calls[0], "temperature"), false);
});

test("deepseek_explicit_flash_tier_uses_flash_model_and_budget", async () => {
  const calls = [];
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "flash",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "deepseek-pro-tier",
      DEEPSEEK_FLASH_MODEL: "deepseek-flash-tier",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelJson("Flash OK")) } }], usage: {} });
    },
  });
  assert.equal(calls[0].model, "deepseek-flash-tier");
  assert.equal(calls[0].max_tokens, 32000);
  assert.deepEqual(calls[0].thinking, { type: "enabled" });
});

test("deepseek flash tier never falls through to a configured Pro model", async () => {
  let invokedModel = "";
  await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "flash",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    },
    modelInvoker: async ({ modelName }) => {
      invokedModel = modelName;
      return modelJson("Flash selection is isolated");
    },
  });
  assert.equal(invokedModel, "deepseek-v4-flash");
});

test("deepseek_flash_non-thinking_mode uses a smaller answer budget and no reasoning effort", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    thinkingMode: "disabled",
    reasoningEffort: "max",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "flash",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({
        id: "request-1",
        model: "deepseek-v4-flash",
        system_fingerprint: "fp-test",
        choices: [{ message: { content: JSON.stringify(modelJson("Flash no-think OK")) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 30,
          total_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      });
    },
  });
  assert.deepEqual(calls[0].thinking, { type: "disabled" });
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
  assert.equal(calls[0].max_tokens, 8000);
  assert.equal(calls[0].temperature, 0);
  assert.equal(Object.hasOwn(calls[0], "reasoning_effort"), false);
  assert.equal(result.generationConfig.thinkingMode, "disabled");
  assert.equal(result.generationAttempts[0].requestModel, "deepseek-v4-flash");
  assert.equal(result.generationAttempts[0].responseModel, "deepseek-v4-flash");
  assert.equal(result.generationAttempts[0].systemFingerprint, "fp-test");
  assert.equal(result.generationAttempts[0].usage.reasoning_tokens, 0);
});

test("deepseek flash thinking mode passes through the supported low effort", async () => {
  const result = await callRagModel({
    prompt: "输出 JSON",
    thinkingMode: "enabled",
    reasoningEffort: "low",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "flash",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.thinking, { type: "enabled" });
      assert.equal(body.reasoning_effort, "low");
      return jsonResponse({
        model: "deepseek-v4-flash",
        choices: [{
          message: { content: JSON.stringify(modelJson("Flash low OK")) },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      });
    },
  });
  assert.equal(result.generationConfig.thinkingMode, "enabled");
  assert.equal(result.generationConfig.reasoningEffort, "low");
});

test("deepseek flash low fails closed when the upstream rejects it without changing effort", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 JSON",
    thinkingMode: "enabled",
    reasoningEffort: "low",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "flash",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ error: { message: "low effort rejected" } }, false, 400);
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].thinking, { type: "enabled" });
  assert.equal(calls[0].reasoning_effort, "low");
  assert.equal(result.providerUsed, "deepseek");
  assert.equal(result.dryRun, false);
  assert.equal(result.answer.answerLevel, "needs_more_info");
  assert.ok(result.answer.riskFlags.includes("model_call_failed"));
  assert.ok(result.warnings.includes("model_call_failed:deepseek 400"));
  assert.equal(result.generationConfig.reasoningEffort, "low");
});

test("deepseek thinking mode accepts max effort and records reasoning usage without exposing content", async () => {
  const result = await callRagModel({
    prompt: "输出 JSON",
    thinkingMode: "enabled",
    reasoningEffort: "max",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "pro",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_PRO_MODEL: "deepseek-v4-pro",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.thinking, { type: "enabled" });
      assert.equal(body.reasoning_effort, "max");
      assert.equal(body.max_tokens, 32000);
      assert.equal(Object.hasOwn(body, "response_format"), false);
      assert.equal(Object.hasOwn(body, "temperature"), false);
      return jsonResponse({
        id: "request-2",
        model: "deepseek-v4-pro",
        choices: [{
          message: {
            reasoning_content: "private reasoning that must not enter debug",
            content: JSON.stringify(modelJson("Pro think OK")),
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 80,
          total_tokens: 120,
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      });
    },
  });
  assert.equal(result.generationConfig.thinkingMode, "enabled");
  assert.equal(result.generationConfig.reasoningEffort, "max");
  assert.equal(result.generationAttempts[0].reasoningContentPresent, true);
  assert.equal(result.generationAttempts[0].reasoningContentChars > 0, true);
  assert.equal(result.generationAttempts[0].usage.reasoning_tokens, 50);
  assert.equal("reasoningContent" in result.generationAttempts[0], false);
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

test("glm_high_provider_uses_the_public_chat_completions_endpoint_and_thinking_contract", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "输出 GLM JSON",
    env: {
      MODEL_PROVIDER: "glm",
      GLM_API_KEY: "test-glm-key",
      GLM_MODEL: "glm-5.2",
      RAG_THINKING_MODE: "enabled",
      RAG_REASONING_EFFORT: "high",
      RAG_MAX_OUTPUT_TOKENS: "456",
      API_DAILY_BUDGET_CNY: "10",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2038-02-01T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        id: "glm-public-1",
        model: "glm-5.2",
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify(modelJson("GLM high OK")) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-glm-key");
  assert.equal(calls[0].body.model, "glm-5.2");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "输出 GLM JSON" }]);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.deepEqual(calls[0].body.thinking, { type: "enabled" });
  assert.equal(calls[0].body.reasoning_effort, "high");
  assert.equal(calls[0].body.max_tokens, 456);
  assert.equal(calls[0].body.stream, false);
  assert.equal(result.providerUsed, "glm");
  assert.equal(result.modelUsed, "glm-5.2");
  assert.equal(result.generationConfig.reasoningEffort, "high");
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:glm");
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

test("public final-call reservations survive ambiguous dispatch failures and only refund explicit 400 rejection", async () => {
  const now = new Date("2026-08-01T00:10:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    RAG_MAX_OUTPUT_TOKENS: "100",
  };
  const cases = [
    {
      label: "abort after dispatch",
      retained: true,
      fetchImpl: async () => {
        const error = new Error("client aborted after dispatch");
        error.name = "AbortError";
        throw error;
      },
    },
    {
      label: "network failure after dispatch",
      retained: true,
      fetchImpl: async () => {
        throw new Error("socket reset after request write");
      },
    },
    {
      label: "HTTP 429",
      retained: true,
      fetchImpl: async () => jsonResponse({ error: { message: "rate limited" } }, false, 429),
    },
    {
      label: "HTTP 500",
      retained: true,
      fetchImpl: async () => jsonResponse({ error: { message: "upstream failed" } }, false, 500),
    },
    {
      label: "HTTP 200 malformed JSON",
      retained: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError("malformed upstream JSON");
        },
      }),
    },
    {
      label: "HTTP 400 explicit rejection",
      retained: false,
      fetchImpl: async () => jsonResponse({ error: { message: "invalid request" } }, false, 400),
    },
  ];

  for (const item of cases) {
    await resetRagBudget({ env, now });
    let fetchCount = 0;
    const result = await callRagModel({
      prompt: `预算分类 ${item.label}`,
      thinkingMode: "disabled",
      env,
      now,
      fetchImpl: async (...args) => {
        fetchCount += 1;
        return item.fetchImpl(...args);
      },
    });
    const status = await getRagBudgetStatus({ env, now });
    assert.equal(fetchCount, 1, item.label);
    assert.equal(status.spentTodayCny > 0, item.retained, item.label);
    assert.equal(
      result.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"),
      item.retained,
      item.label,
    );
  }
});

test("auxiliary-call reservations retain aborts but refund an explicit 400 rejection", async () => {
  const now = new Date("2026-08-01T00:20:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  };

  await resetRagBudget({ env, now });
  const aborted = await callCardNameExtractionModel({
    userQuery: "辅助调用派发后中止-20260801",
    env,
    now,
    fetchImpl: async () => {
      const error = new Error("auxiliary abort after dispatch");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.equal((await getRagBudgetStatus({ env, now })).spentTodayCny > 0, true);
  assert.ok(aborted.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"));

  await resetRagBudget({ env, now });
  const timedOut = await callCardNameExtractionModel({
    userQuery: "辅助调用派发后超时-20260801",
    env: { ...env, RAG_CARD_MODEL_TIMEOUT_MS: "1" },
    now,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.equal((await getRagBudgetStatus({ env, now })).spentTodayCny > 0, true);
  assert.ok(timedOut.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"));

  await resetRagBudget({ env, now });
  const rejected = await callCardNameExtractionModel({
    userQuery: "辅助调用明确拒绝-20260801",
    env,
    now,
    fetchImpl: async () => jsonResponse({ error: { message: "invalid request" } }, false, 400),
  });
  assert.equal((await getRagBudgetStatus({ env, now })).spentTodayCny, 0);
  assert.equal(rejected.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"), false);
});

test("DeepSeek compact recovery reserves both possible calls before any fetch", async () => {
  const now = new Date("2026-08-01T00:30:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "0.00015",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "0",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "1",
    RAG_MAX_OUTPUT_TOKENS: "100",
    RAG_RECOVERY_MAX_OUTPUT_TOKENS: "100",
  };
  await resetRagBudget({ env, now });
  let fetchCount = 0;
  const result = await callRagModel({
    prompt: "主请求",
    recoveryPrompt: "可能发生的第二次请求",
    thinkingMode: "disabled",
    env,
    now,
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({});
    },
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.equal(result.budgetStatus.limitEnforced, true);
});

test("persistent public budget requirement fails closed without Redis even in default soft mode", async () => {
  for (const persistenceEnv of [
    { VERCEL: "1" },
    { API_BUDGET_REQUIRE_PERSISTENT_STORAGE: "true" },
  ]) {
    let fetchCount = 0;
    const result = await callRagModel({
      prompt: "持久预算缺失时不得联网",
      thinkingMode: "disabled",
      env: {
        MODEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-deepseek-key",
        API_DAILY_BUDGET_CNY: "10",
        ...persistenceEnv,
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return jsonResponse({});
      },
    });
    assert.equal(fetchCount, 0);
    assert.equal(result.answer.answerLevel, "budget_limited");
    assert.equal(result.budgetStatus.budgetStorage, "unconfigured");
    assert.equal(result.budgetStatus.limitEnforced, true);
  }
});

test("public card-name and rule-query helpers cannot bypass the shared daily budget", async () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "0.000001",
    API_BUDGET_TIMEZONE: "UTC",
  };
  await resetRagBudget({ env, now });
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({});
  };

  const cardResult = await callCardNameExtractionModel({
    userQuery: "预算拦截卡名辅助模型-20260801",
    env,
    fetchImpl,
    now,
  });
  const ruleResult = await callRuleQueryExtractionModel({
    userQuery: "预算拦截规则词辅助模型-20260801",
    env,
    fetchImpl,
    now,
  });

  assert.equal(fetchCount, 0);
  assert.equal(cardResult.budgetStatus.limitEnforced, true);
  assert.equal(ruleResult.budgetStatus.limitEnforced, true);
  assert.ok(cardResult.warnings.includes("api_daily_budget_exceeded_card_name_model_skipped"));
  assert.ok(ruleResult.warnings.includes("api_daily_budget_exceeded_rule_query_model_skipped"));
});

test("public extraction helpers record their paid usage in the shared budget", async () => {
  const now = new Date("2026-08-01T01:00:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  };
  await resetRagBudget({ env, now });
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    const content = callCount === 1
      ? JSON.stringify({ cardNames: [{ name: "测试龙", originalText: "测试龙" }] })
      : JSON.stringify({ ruleQueries: [{ query: "发动条件" }] });
    return jsonResponse({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    });
  };

  const cardResult = await callCardNameExtractionModel({
    userQuery: "辅助模型计费卡名-20260801",
    env,
    fetchImpl,
    now,
  });
  const ruleResult = await callRuleQueryExtractionModel({
    userQuery: "辅助模型计费规则-20260801",
    env,
    fetchImpl,
    now,
  });
  const status = await getRagBudgetStatus({ env, now });

  assert.equal(callCount, 2);
  assert.equal(cardResult.estimatedCostCny, 0.002);
  assert.equal(ruleResult.estimatedCostCny, 0.002);
  assert.equal(status.spentTodayCny, 0.004);
});

test("private DeepSeek extractors share a run-scoped auxiliary budget without touching Redis or public ledgers", async () => {
  const now = new Date("2038-02-04T06:00:00.000Z");
  const redis = createRedisFetch();
  const env = {
    MODEL_PROVIDER: "relay",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_RUN_ID: "1234567890-1-abcdef1234567893",
    PRIVATE_EVALUATION_AUXILIARY_BUDGET_CNY: "0.001",
    HOST: "127.0.0.1",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "0",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "1",
    RAG_CARD_MODEL_MAX_OUTPUT_TOKENS: "600",
    RAG_RULE_MODEL_MAX_OUTPUT_TOKENS: "600",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  let providerCalls = 0;
  const fetchImpl = async (url) => {
    assert.notEqual(url, env.KV_REST_API_URL, "private auxiliary budget must never contact Redis");
    providerCalls += 1;
    return jsonResponse({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cardNames: [] }) } }],
    });
  };

  const cardResult = await callCardNameExtractionModel({
    userQuery: "private auxiliary first reservation-20380204",
    env,
    fetchImpl,
    now,
  });
  const ruleResult = await callRuleQueryExtractionModel({
    userQuery: "private auxiliary cumulative limit-20380204",
    env,
    fetchImpl,
    now,
  });

  assert.equal(providerCalls, 1);
  assert.equal(redis.commands.length, 0);
  assert.equal(cardResult.budgetStatus.privateEvaluation, true);
  assert.equal(cardResult.budgetStatus.privateEvaluationRunId, env.PRIVATE_EVALUATION_RUN_ID);
  assert.equal(cardResult.budgetStatus.budgetStorage, "private_evaluation_memory");
  assert.equal(cardResult.budgetStatus.bucket.id, "evidence_preparation:deepseek");
  assert.equal(cardResult.budgetStatus.bucket.dailyBudgetCny, 0.001);
  assert.equal(cardResult.budgetStatus.spentTodayCny, 0.0006);
  assert.equal(ruleResult.budgetStatus.privateEvaluation, true);
  assert.equal(ruleResult.budgetStatus.limitEnforced, true);
  assert.ok(ruleResult.warnings.includes("api_daily_budget_exceeded_rule_query_model_skipped"));
  const publicStatus = await getRagBudgetStatus({ env: { API_BUDGET_TIMEZONE: "UTC" }, now });
  assert.equal(publicStatus.spentTodayCny, 0);
  assert.equal(publicStatus.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny, 0);
});

test("private DeepSeek auxiliary isolation requires every server-owned gate", async () => {
  const now = new Date("2038-02-04T07:00:00.000Z");
  const base = {
    MODEL_PROVIDER: "relay",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_RUN_ID: "1234567890-1-abcdef1234567894",
    PRIVATE_EVALUATION_AUXILIARY_BUDGET_CNY: "10",
    HOST: "127.0.0.1",
    API_DAILY_BUDGET_CNY: "0.000001",
    API_BUDGET_TIMEZONE: "UTC",
  };
  for (const variant of [
    { PRIVATE_EVALUATION_MODE: "false" },
    { PRIVATE_EVALUATION_DIAGNOSTICS: "false" },
    { PRIVATE_EVALUATION_RUN_ID: "short" },
    { HOST: "0.0.0.0" },
    { VERCEL: "1" },
  ]) {
    const env = { ...base, ...variant };
    let providerCalls = 0;
    const result = await callCardNameExtractionModel({
      userQuery: `private auxiliary gate rejection ${JSON.stringify(variant)}`,
      env,
      now,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error("provider must not be called");
      },
    });
    assert.equal(providerCalls, 0);
    assert.notEqual(result.budgetStatus?.privateEvaluation, true);
    assert.ok(result.warnings.includes("api_daily_budget_exceeded_card_name_model_skipped"));
  }
});

test("pipeline cost summary includes both auxiliary extractors on the caller's budget day", async () => {
  const now = new Date("2032-03-04T05:06:07.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_MODEL_PROVIDER: "mock",
    RAG_LIVE_OFFICIAL_QA_ENABLED: "false",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  };
  await resetRagBudget({ env, now });

  const result = await answerRagRulingQuestion({
    question: "「测试龙」的效果可以发动吗？",
    cards,
    records: [],
    qaRecords: [],
    env,
    now,
    cardModelInvoker: async () => ({
      cardNames: [],
      usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    }),
    ruleModelInvoker: async () => ({
      ruleQueries: [],
      usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    }),
    modelInvoker: async () => JSON.stringify(modelJson("需要结合完整局面判断。")),
  });
  const status = await getRagBudgetStatus({ env, now });

  assert.equal(result.debug.cardNameModelCostCny, 0.002);
  assert.equal(result.debug.ruleQueryModelCostCny, 0.002);
  assert.equal(result.debug.estimatedCostCny, 0.004);
  assert.equal(status.spentTodayCny, 0.004);
});

test("complete public pipeline response removes relay group names and request ids", async () => {
  const now = new Date("2044-01-01T00:00:00.000Z");
  const env = {
    MODEL_PROVIDER: "relay",
    RAG_MODEL_PROVIDER: "relay",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_API_KEY: "relay-test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_CARD_MODEL_PROVIDER: "mock",
    RAG_RULE_MODEL_PROVIDER: "mock",
    RAG_RULEBOOK_MODEL_PROVIDER: "mock",
    RAG_LIVE_OFFICIAL_QA_ENABLED: "false",
    RAG_AUTO_ENGINE_SIMULATION: "false",
    API_DAILY_BUDGET_USD: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  await resetRagBudget({ env, now });
  const result = await answerRagRulingQuestion({
    question: "这个操作可以进行吗？",
    cards: [],
    records: [],
    qaRecords: [],
    env,
    now,
    cardModelInvoker: async () => ({ cardNames: [] }),
    ruleModelInvoker: async () => ({ ruleQueries: [] }),
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [],
      constraintReviews: [],
    }),
    fetchImpl: async () => jsonResponse({
      error: {
        message: "无权访问 private-routing-group (request id: sensitive-internal-id)",
        code: "private-routing-group:sensitive-internal-id",
      },
    }, false, 403),
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.answerLevel, "needs_more_info");
  assert.ok(result.riskFlags.includes("model_provider_call_failed"));
  assert.ok(result.riskFlags.includes("model_provider_access_denied"));
  assert.equal(result.debug.providerFailure.kind, "access_denied");
  assert.equal(result.debug.providerFailure.code, "model_provider_access_denied");
  assert.doesNotMatch(serialized, /private-routing-group|sensitive-internal-id/u);
});

test("public pipeline caches only identical-query extraction work and still invokes the final model every time", async () => {
  const now = new Date("2033-04-05T06:07:08.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_MODEL_PROVIDER: "mock",
    RAG_LIVE_OFFICIAL_QA_ENABLED: "false",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  await resetRagBudget({ env, now });

  let extractionCallCount = 0;
  let finalCallCount = 0;
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const prompt = String(body.messages?.[0]?.content || "");
    const isCardExtraction = prompt.includes("提取所有可能的卡名候选");
    const isRuleExtraction = prompt.includes("提取用于检索规则资料");
    if (isCardExtraction || isRuleExtraction) extractionCallCount += 1;
    const content = isCardExtraction
      ? JSON.stringify({ cardNames: [] })
      : JSON.stringify({ ruleQueries: [] });
    return jsonResponse({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  };
  const modelInvoker = async () => {
    finalCallCount += 1;
    return JSON.stringify(modelJson("需要结合完整局面判断。"));
  };
  const question = "匿名前置缓存回归场景-20330405：「测试龙」当前处理应如何继续？";
  const invoke = (currentQuestion, currentCards = cards) => answerRagRulingQuestion({
    question: currentQuestion,
    cards: currentCards,
    records: [],
    qaRecords: [],
    env,
    now,
    fetchImpl,
    modelInvoker,
  });

  const first = await invoke(question);
  assert.deepEqual(first.debug.extractionCacheHits, {
    cardNameModel: false,
    ruleQueryModel: false,
    rulebookGroundingModel: false,
    officialQaApplicabilityModel: false,
  });
  assert.equal(extractionCallCount, 2);
  assert.equal(finalCallCount, 1);
  assert.equal(first.debug.auxiliaryTokenUsage.prompt_tokens, 20);
  assert.equal(first.debug.auxiliaryTokenUsage.completion_tokens, 4);
  assert.equal(first.debug.auxiliaryEstimatedCostCny > 0, true);
  assert.match(first.debug.dataRevision, /^[a-f0-9]{64}$/u);
  assert.match(first.debug.evidenceFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(first.debug.finalPromptSha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.debug.requestedModel, "deepseek-v4-pro");
  assert.equal(first.debug.returnedModel, null);
  const budgetAfterFirst = await getRagBudgetStatus({ env, now });

  const second = await invoke(question);
  assert.deepEqual(second.debug.extractionCacheHits, {
    cardNameModel: true,
    ruleQueryModel: true,
    rulebookGroundingModel: false,
    officialQaApplicabilityModel: false,
  });
  assert.equal(extractionCallCount, 2);
  assert.equal(finalCallCount, 2);
  assert.deepEqual(second.debug.cardNameModelTokenUsage, {});
  assert.deepEqual(second.debug.ruleQueryModelTokenUsage, {});
  assert.deepEqual(second.debug.auxiliaryTokenUsage, {});
  assert.equal(second.debug.auxiliaryEstimatedCostCny, 0);
  assert.equal(second.debug.estimatedCostCny, 0);
  assert.equal(second.debug.auxiliaryCacheHit, true);
  const budgetAfterSecond = await getRagBudgetStatus({ env, now });
  assert.equal(budgetAfterSecond.spentTodayCny, budgetAfterFirst.spentTodayCny);
  assert.equal(
    budgetAfterSecond.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny,
    budgetAfterFirst.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny,
  );

  const changedData = await invoke(question, [
    ...cards,
    { id: "data-revision-card", name: "数据版本龙", aliases: ["数据版本龙"], effectText: "同步后新增的文本。" },
  ]);
  assert.deepEqual(changedData.debug.extractionCacheHits, {
    cardNameModel: false,
    ruleQueryModel: false,
    rulebookGroundingModel: false,
    officialQaApplicabilityModel: false,
  });
  assert.equal(extractionCallCount, 4);
  assert.notEqual(changedData.debug.dataRevision, first.debug.dataRevision);

  const changed = await invoke(`${question} 补充一个条件。`);
  assert.deepEqual(changed.debug.extractionCacheHits, {
    cardNameModel: false,
    ruleQueryModel: false,
    rulebookGroundingModel: false,
    officialQaApplicabilityModel: false,
  });
  assert.equal(extractionCallCount, 6);
  assert.equal(finalCallCount, 4);
});

test("identical signal-free auxiliary requests use bounded singleflight without duplicating usage or spend", async () => {
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2033-04-06T06:07:08.000Z");
  await resetRagBudget({ env, now });
  let fetchCount = 0;
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const fetchImpl = async () => {
    fetchCount += 1;
    await gate;
    return jsonResponse({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cardNames: [] }) } }],
      usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
    });
  };
  const input = {
    userQuery: "singleflight-card-extraction-20330406",
    dataRevision: "revision-a",
    env,
    now,
    fetchImpl,
  };
  const firstPromise = callCardNameExtractionModel(input);
  const secondPromise = callCardNameExtractionModel(input);
  releaseFetch();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(fetchCount, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(first.singleflightHit, false);
  assert.equal(first.tokenUsage.prompt_tokens, 40);
  assert.equal(first.estimatedCostCny > 0, true);
  assert.equal(second.cacheHit, false);
  assert.equal(second.singleflightHit, true);
  assert.deepEqual(second.tokenUsage, {});
  assert.equal(second.estimatedCostCny, 0);
  assert.equal(second.budgetStatus.estimatedThisCallCny, 0);
  assert.equal(second.budgetStatus.bucket.estimatedThisCallCny, 0);
});

test("auxiliary extraction caches only complete valid JSON, including explicit empty arrays", async () => {
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2033-04-08T06:07:08.000Z");
  await resetRagBudget({ env, now });
  const variants = [
    {
      label: "empty-content",
      content: "",
      finishReason: "stop",
      cacheable: false,
      warningReason: "empty_content",
    },
    {
      label: "invalid-json",
      content: "{not valid JSON",
      finishReason: "stop",
      cacheable: false,
      warningReason: "invalid_json",
    },
    {
      label: "truncated-valid-prefix",
      contentFor: (field) => JSON.stringify({ [field]: [] }),
      finishReason: "length",
      cacheable: false,
      warningReason: "truncated",
    },
    {
      label: "explicit-empty-array",
      contentFor: (field) => JSON.stringify({ [field]: [] }),
      finishReason: "stop",
      cacheable: true,
      warningReason: null,
    },
  ];
  const extractors = [
    {
      label: "card",
      field: "cardNames",
      invoke: callCardNameExtractionModel,
      resultField: "candidates",
      warningPrefix: "card_name_model_not_cached:",
    },
    {
      label: "rule",
      field: "ruleQueries",
      invoke: callRuleQueryExtractionModel,
      resultField: "queries",
      warningPrefix: "rule_query_model_not_cached:",
    },
  ];

  for (const extractor of extractors) {
    for (const variant of variants) {
      let fetchCount = 0;
      const fetchImpl = async () => {
        fetchCount += 1;
        const content = variant.contentFor
          ? variant.contentFor(extractor.field)
          : variant.content;
        return jsonResponse({
          choices: [{
            finish_reason: variant.finishReason,
            message: { content },
          }],
          usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
        });
      };
      const input = {
        userQuery: `aux-cache-${extractor.label}-${variant.label}-20330408`,
        dataRevision: "revision-cache-validity",
        env,
        now,
        fetchImpl,
      };
      const first = await extractor.invoke(input);
      const second = await extractor.invoke(input);

      assert.deepEqual(first[extractor.resultField], [], `${extractor.label}/${variant.label} first result`);
      assert.deepEqual(second[extractor.resultField], [], `${extractor.label}/${variant.label} second result`);
      assert.equal(first.cacheHit, false, `${extractor.label}/${variant.label} first cache flag`);
      assert.equal(
        fetchCount,
        variant.cacheable ? 1 : 2,
        `${extractor.label}/${variant.label} fetch count`,
      );
      assert.equal(
        second.cacheHit,
        variant.cacheable,
        `${extractor.label}/${variant.label} second cache flag`,
      );
      if (variant.warningReason) {
        assert.ok(
          first.warnings.includes(`${extractor.warningPrefix}${variant.warningReason}`),
          `${extractor.label}/${variant.label} warning`,
        );
      }
    }
  }
});

test("singleflight isolates caller aborts while charging one surviving shared request only once", async () => {
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  };
  const expectedSingleCharge = estimateDeepSeekCostCny({
    prompt_tokens: 40,
    completion_tokens: 5,
    total_tokens: 45,
  }, env);

  const runCase = async ({ label, abortLeader }) => {
    const now = new Date(abortLeader
      ? "2033-04-09T06:07:08.000Z"
      : "2033-04-10T06:07:08.000Z");
    await resetRagBudget({ env, now });
    let fetchCount = 0;
    let releaseFetch;
    const gate = new Promise((resolve) => { releaseFetch = resolve; });
    const fetchImpl = async () => {
      fetchCount += 1;
      await gate;
      return jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cardNames: [] }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      });
    };
    const controller = new AbortController();
    const baseInput = {
      userQuery: `singleflight-abort-${label}-20330409`,
      dataRevision: "revision-signal-safe",
      env,
      now,
      fetchImpl,
    };
    const leader = callCardNameExtractionModel({
      ...baseInput,
      ...(abortLeader ? { signal: controller.signal } : {}),
    });
    const follower = callCardNameExtractionModel({
      ...baseInput,
      ...(!abortLeader ? { signal: controller.signal } : {}),
    });
    controller.abort(`${label}_cancelled`);
    releaseFetch();
    const [leaderOutcome, followerOutcome] = await Promise.allSettled([leader, follower]);
    const aborted = abortLeader ? leaderOutcome : followerOutcome;
    const surviving = abortLeader ? followerOutcome : leaderOutcome;
    const status = await getRagBudgetStatus({ env, now });

    assert.equal(aborted.status, "rejected", `${label} aborted caller`);
    assert.equal(aborted.reason?.name, "AbortError", `${label} abort error type`);
    assert.equal(surviving.status, "fulfilled", `${label} surviving caller`);
    assert.deepEqual(surviving.value.candidates, [], `${label} surviving result`);
    assert.equal(fetchCount, 1, `${label} remote request count`);
    assert.equal(status.spentTodayCny, expectedSingleCharge, `${label} charged once`);
    if (abortLeader) {
      assert.equal(surviving.value.singleflightHit, true, `${label} follower reuse`);
      assert.equal(surviving.value.estimatedCostCny, 0, `${label} follower current-call cost`);
    } else {
      assert.equal(surviving.value.singleflightHit, false, `${label} leader owns request`);
      assert.equal(surviving.value.estimatedCostCny, expectedSingleCharge, `${label} leader cost`);
    }
  };

  await runCase({ label: "leader", abortLeader: true });
  await runCase({ label: "follower", abortLeader: false });
});

test("a pre-aborted auxiliary caller creates no flight, request, or budget charge", async () => {
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2033-04-11T06:07:08.000Z");
  await resetRagBudget({ env, now });
  const controller = new AbortController();
  controller.abort("cancelled_before_auxiliary_call");
  let fetchCount = 0;

  await assert.rejects(
    callCardNameExtractionModel({
      userQuery: "pre-aborted-auxiliary-20330411",
      dataRevision: "revision-pre-aborted",
      env,
      now,
      signal: controller.signal,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("pre-aborted caller must not fetch");
      },
    }),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );
  const status = await getRagBudgetStatus({ env, now });
  assert.equal(fetchCount, 0);
  assert.equal(status.spentTodayCny, 0);
});

test("a pre-aborted final call does not reserve budget or reach transport", async () => {
  const env = {
    MODEL_PROVIDER: "relay",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_API_KEY: "relay-test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2033-04-12T06:07:08.000Z");
  await resetRagBudget({ env, now });
  const before = await getRagBudgetStatus({ env, now });
  const controller = new AbortController();
  controller.abort("cancelled_before_final_call");
  let fetchCount = 0;

  await assert.rejects(
    callRagModel({
      prompt: "pre-aborted-final-20330412",
      env,
      now,
      signal: controller.signal,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("pre-aborted final call must not fetch");
      },
    }),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );
  const after = await getRagBudgetStatus({ env, now });
  assert.equal(fetchCount, 0);
  assert.equal(after.buckets.find((item) => item.id === "final_ruling:relay")?.spentTodayUsd,
    before.buckets.find((item) => item.id === "final_ruling:relay")?.spentTodayUsd);
});

test("cancellation during final budget preflight refunds both ledgers before transport", async () => {
  const now = new Date("2033-04-13T06:07:08.000Z");
  const redis = createRedisFetch();
  const controller = new AbortController();
  const env = {
    MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const before = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  let providerCalls = 0;
  let positiveReservations = 0;

  await assert.rejects(
    callRagModel({
      prompt: "cancel-during-final-preflight-20330413",
      env,
      now,
      signal: controller.signal,
      fetchImpl: async (url, options) => {
        if (url === "https://kv.example.test") {
          const command = JSON.parse(options.body || "[]");
          if (command[0] === "EVAL" && command[2] === "1" && Number(command[4]) > 0) {
            positiveReservations += 1;
            if (positiveReservations === 2) controller.abort("cancelled_during_final_preflight");
          }
          return redis.fetchImpl(url, options);
        }
        providerCalls += 1;
        throw new Error("cancelled final call must not reach provider");
      },
    }),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );

  const after = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  const increments = redis.commands.filter((command) => command[0] === "EVAL" && command[2] === "1");
  assert.equal(providerCalls, 0);
  assert.deepEqual(after, before);
  assert.equal(increments.filter((command) => Number(command[4]) > 0).length, 2);
  assert.equal(increments.filter((command) => Number(command[4]) < 0).length, 2);
});

test("cancellation during auxiliary budget preflight refunds before an injected invoker", async () => {
  const now = new Date("2033-04-14T06:07:08.000Z");
  const redis = createRedisFetch();
  const controller = new AbortController();
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const before = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  let invokerCalls = 0;
  let positiveReservations = 0;
  const result = await callCardNameExtractionModel({
    userQuery: "cancel-during-auxiliary-preflight-20330414",
    dataRevision: "revision-cancel-during-preflight",
    env,
    now,
    signal: controller.signal,
    modelInvoker: async () => {
      invokerCalls += 1;
      throw new Error("cancelled auxiliary call must not invoke model");
    },
    fetchImpl: async (url, options) => {
      const command = JSON.parse(options.body || "[]");
      if (command[0] === "EVAL" && command[2] === "1" && Number(command[4]) > 0) {
        positiveReservations += 1;
        if (positiveReservations === 2) controller.abort("cancelled_during_auxiliary_preflight");
      }
      return redis.fetchImpl(url, options);
    },
  });

  const after = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  const increments = redis.commands.filter((command) => command[0] === "EVAL" && command[2] === "1");
  assert.equal(invokerCalls, 0);
  assert.ok(result.warnings.some((item) => item.startsWith("card_name_model_failed:")));
  assert.deepEqual(after, before);
  assert.equal(increments.filter((command) => Number(command[4]) > 0).length, 2);
  assert.equal(increments.filter((command) => Number(command[4]) < 0).length, 2);
});

test("cancellation during DeepSeek JSON budget preflight refunds before provider dispatch", async () => {
  const now = new Date("2033-04-15T06:07:08.000Z");
  const redis = createRedisFetch();
  const controller = new AbortController();
  const env = {
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const before = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  let providerCalls = 0;
  let positiveReservations = 0;

  await assert.rejects(
    callDeepSeekJsonTask({
      prompt: "cancel-during-json-preflight-20330415",
      env,
      now,
      signal: controller.signal,
      trackPublicBudget: true,
      fetchImpl: async (url, options) => {
        if (url === "https://kv.example.test") {
          const command = JSON.parse(options.body || "[]");
          if (command[0] === "EVAL" && command[2] === "1" && Number(command[4]) > 0) {
            positiveReservations += 1;
            if (positiveReservations === 2) controller.abort("cancelled_during_json_preflight");
          }
          return redis.fetchImpl(url, options);
        }
        providerCalls += 1;
        throw new Error("cancelled JSON task must not reach provider");
      },
    }),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );

  const after = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  const increments = redis.commands.filter((command) => command[0] === "EVAL" && command[2] === "1");
  assert.equal(providerCalls, 0);
  assert.deepEqual(after, before);
  assert.equal(increments.filter((command) => Number(command[4]) > 0).length, 2);
  assert.equal(increments.filter((command) => Number(command[4]) < 0).length, 2);
});

test("cancellation during rulebook budget preflight refunds before parallel grounding calls", async () => {
  const now = new Date("2033-04-16T06:07:08.000Z");
  const redis = createRedisFetch();
  const controller = new AbortController();
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_FOCUSED_REPAIR_ENABLED: "false",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const before = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  let providerCalls = 0;
  let positiveReservations = 0;

  await assert.rejects(
    callRulebookGroundingModel({
      userQuery: "cancel-during-rulebook-preflight-20330416",
      ruleEvidence: [{
        id: "generic-rulebook-cancellation-evidence",
        type: "rulebook",
        title: "通用规则资料",
        text: "处理效果前必须确认适用条件。",
      }],
      dataRevision: "revision-rulebook-cancel-during-preflight",
      env,
      now,
      signal: controller.signal,
      fetchImpl: async (url, options) => {
        if (url === "https://kv.example.test") {
          const command = JSON.parse(options.body || "[]");
          if (command[0] === "EVAL" && command[2] === "1" && Number(command[4]) > 0) {
            positiveReservations += 1;
            if (positiveReservations === 2) controller.abort("cancelled_during_rulebook_preflight");
          }
          return redis.fetchImpl(url, options);
        }
        providerCalls += 1;
        throw new Error("cancelled rulebook task must not reach provider");
      },
    }),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );

  // The public caller rejects immediately; the shared singleflight owner then
  // observes that its last waiter left and performs the bounded rollback.
  await waitFor(() => redis.commands.filter(
    (command) => command[0] === "EVAL" && command[2] === "1" && Number(command[4]) < 0,
  ).length === 2);
  const after = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  const increments = redis.commands.filter((command) => command[0] === "EVAL" && command[2] === "1");
  assert.equal(providerCalls, 0);
  assert.deepEqual(after, before);
  assert.equal(increments.filter((command) => Number(command[4]) > 0).length, 2);
  assert.equal(increments.filter((command) => Number(command[4]) < 0).length, 2);
});

test("rulebook preparation cache hashes evidence content and revision while cache hits report zero current usage", async () => {
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_FOCUSED_REPAIR_ENABLED: "false",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2033-04-07T06:07:08.000Z");
  await resetRagBudget({ env, now });
  let fetchCount = 0;
  const passage = {
    id: "rulebook-cache-content-20330407",
    type: "rulebook",
    title: "缓存内容测试",
    text: "正在处理的卡不能返回手卡。",
    sourceUrl: "https://example.test/rulebook-cache",
  };
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          operationChecks: [{
            operationId: "return-active-card",
            action: "返回手卡",
            status: "illegal",
            conclusion: "不能返回。",
            citations: [{ id: passage.id, quote: "正在处理的卡不能返回手卡。" }],
          }],
        }) },
      }],
      usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
    });
  };
  const invoke = (ruleEvidence, dataRevision) => callRulebookGroundingModel({
    userQuery: "rulebook cache content scenario 20330407",
    ruleEvidence,
    dataRevision,
    env,
    now,
    fetchImpl,
  });

  const first = await invoke([passage], "revision-a");
  const budgetAfterFirst = await getRagBudgetStatus({ env, now });
  const second = await invoke([passage], "revision-a");
  const budgetAfterSecond = await getRagBudgetStatus({ env, now });
  const changedText = await invoke([{ ...passage, text: `${passage.text} 同步修订。` }], "revision-a");
  const changedRevision = await invoke([passage], "revision-b");

  assert.equal(fetchCount, 3);
  assert.equal(first.cacheHit, false);
  assert.equal(first.tokenUsage.prompt_tokens, 120);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.tokenUsage, {});
  assert.equal(second.estimatedCostCny, 0);
  assert.equal(second.budgetStatus.estimatedThisCallCny, 0);
  assert.equal(budgetAfterSecond.spentTodayCny, budgetAfterFirst.spentTodayCny);
  assert.equal(changedText.cacheHit, false);
  assert.equal(changedRevision.cacheHit, false);
  assert.notEqual(first.cacheMetadata.keySha256, changedText.cacheMetadata.keySha256);
  assert.notEqual(first.cacheMetadata.keySha256, changedRevision.cacheMetadata.keySha256);
});

test("rulebook response parsing failure retains the cost of the completed remote call", async () => {
  const now = new Date("2026-08-01T02:00:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    RAG_RULEBOOK_FOCUSED_REPAIR_ENABLED: "false",
  };
  await resetRagBudget({ env, now });
  const result = await callRulebookGroundingModel({
    userQuery: "远端返回后解析失败的预算回归-20260801",
    ruleEvidence: [{
      id: "budget-rulebook-invalid-json-20260801",
      title: "通用规则资料",
      text: "效果发动后，按照连锁顺序处理。",
    }],
    env,
    now,
    fetchImpl: async () => jsonResponse({
      choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
      usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    }),
  });
  const status = await getRagBudgetStatus({ env, now });

  assert.ok(result.warnings.includes("evidence_grounding_invalid_json"));
  assert.equal(result.estimatedCostCny, 0.002);
  assert.equal(status.spentTodayCny, 0.002);
});

test("one fulfilled and one ambiguously failed rulebook call retains the parallel reservation", async () => {
  const now = new Date("2033-04-17T06:07:08.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_RULEBOOK_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    RAG_RULEBOOK_MODEL_MAX_OUTPUT_TOKENS: "100",
    RAG_RULEBOOK_REPAIR_MAX_OUTPUT_TOKENS: "100",
  };
  await resetRagBudget({ env, now });
  let providerCalls = 0;
  const result = await callRulebookGroundingModel({
    userQuery: "发动效果时作为代价送去墓地后，只要该卡在场就不受效果影响的状态是否仍适用？",
    cardTexts: [{
      id: "card-text-generic-cost-transition",
      title: "通用效果文本",
      type: "card_text",
      text: "发动这个效果时，作为代价将1张卡送去墓地。只要该卡在场，另一只怪兽不受效果影响。",
    }],
    ruleEvidence: [{
      id: "rulebook-generic-cost-transition",
      title: "通用规则资料",
      type: "rulebook",
      text: "发动效果时先支付代价，再进行连锁确认。",
    }],
    dataRevision: "parallel-ambiguous-accounting-v1",
    env,
    now,
    fetchImpl: async () => {
      providerCalls += 1;
      if (providerCalls === 2) throw new Error("socket reset after request write");
      return jsonResponse({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({
            operationChecks: [{
              operationId: "cost-state-transition",
              action: "支付代价后确认状态",
              status: "legal",
              conclusion: "应按支付代价后的场面确认。",
              citations: [{
                id: "rulebook-generic-cost-transition",
                quote: "发动效果时先支付代价",
              }],
            }],
          }) },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  const status = await getRagBudgetStatus({ env, now });

  assert.equal(providerCalls, 2);
  assert.ok(result.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"));
  assert.equal(result.estimatedCostCny > estimateDeepSeekCostCny({
    prompt_tokens: 10,
    completion_tokens: 5,
  }, env), true);
  assert.equal(status.spentTodayCny, result.estimatedCostCny);
});

test("forced dry-run skips injected model invokers and live invokers receive the caller signal", async () => {
  let dryRunCalls = 0;
  const dryRunResult = await callRagModel({
    prompt: "dry-run must not invoke",
    dryRun: true,
    env: { MODEL_PROVIDER: "mock" },
    modelInvoker: async () => {
      dryRunCalls += 1;
      return JSON.stringify(modelJson("不应调用"));
    },
  });
  assert.equal(dryRunCalls, 0);
  assert.equal(dryRunResult.dryRun, true);

  const controller = new AbortController();
  let receivedSignal = null;
  await callRagModel({
    prompt: "signal passthrough",
    env: { MODEL_PROVIDER: "mock" },
    signal: controller.signal,
    modelInvoker: async (request) => {
      receivedSignal = request.signal;
      return JSON.stringify(modelJson("收到信号"));
    },
  });
  assert.equal(receivedSignal, controller.signal);
});

test("auxiliary model dry-runs skip injected invokers and forward signals when enabled", async () => {
  const ruleEvidence = [{ id: "aux-signal-rule", title: "规则资料", text: "效果按照连锁顺序处理。" }];
  let dryRunCalls = 0;
  const neverInvoke = async () => {
    dryRunCalls += 1;
    return "{}";
  };
  await Promise.all([
    callCardNameExtractionModel({ userQuery: "辅助卡名 dry-run", dryRun: true, modelInvoker: neverInvoke, env: { MODEL_PROVIDER: "mock" } }),
    callRuleQueryExtractionModel({ userQuery: "辅助规则 dry-run", dryRun: true, modelInvoker: neverInvoke, env: { MODEL_PROVIDER: "mock" } }),
    callRulebookGroundingModel({ userQuery: "辅助规则书 dry-run", ruleEvidence, dryRun: true, modelInvoker: neverInvoke, env: { MODEL_PROVIDER: "mock" } }),
  ]);
  assert.equal(dryRunCalls, 0);

  const controller = new AbortController();
  const receivedSignals = [];
  const captureSignal = async (request) => {
    receivedSignals.push(request.signal);
    if (request.task === "card_name_extraction") return JSON.stringify({ cardNames: [] });
    if (request.task === "rule_query_extraction") return JSON.stringify({ ruleQueries: [] });
    return JSON.stringify({ operationChecks: [], constraintReviews: [] });
  };
  await callCardNameExtractionModel({ userQuery: "辅助卡名 signal", signal: controller.signal, modelInvoker: captureSignal, env: { MODEL_PROVIDER: "mock" } });
  await callRuleQueryExtractionModel({ userQuery: "辅助规则 signal", signal: controller.signal, modelInvoker: captureSignal, env: { MODEL_PROVIDER: "mock" } });
  await callRulebookGroundingModel({ userQuery: "辅助规则书 signal", ruleEvidence, signal: controller.signal, modelInvoker: captureSignal, env: { MODEL_PROVIDER: "mock", RAG_RULEBOOK_FOCUSED_REPAIR_ENABLED: "false" } });
  assert.equal(receivedSignals.length, 3);
  assert.ok(receivedSignals.every((value) => value === controller.signal));
});

test("public JSON providers stop waiting for a stalled response body when the caller aborts", async () => {
  const providers = [
    {
      label: "deepseek",
      call: ({ controller, fetchImpl }) => callRagModel({
        prompt: "stalled-deepseek-body",
        env: {
          MODEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "test-deepseek-key",
          API_DAILY_BUDGET_CNY: "10",
        },
        signal: controller.signal,
        fetchImpl,
      }),
      readWarnings: (result) => result.warnings,
      directSignal: true,
    },
    {
      label: "glm",
      call: ({ controller, fetchImpl }) => callRagModel({
        prompt: "stalled-glm-body",
        env: {
          MODEL_PROVIDER: "glm",
          GLM_API_KEY: "test-glm-key",
          API_DAILY_BUDGET_CNY: "10",
        },
        signal: controller.signal,
        fetchImpl,
      }),
      readWarnings: (result) => result.warnings,
      directSignal: true,
    },
    {
      label: "gemini",
      call: ({ controller, fetchImpl }) => callCardNameExtractionModel({
        userQuery: "stalled-gemini-body",
        dataRevision: "stalled-gemini-body-v1",
        env: {
          MODEL_PROVIDER: "gemini",
          RAG_CARD_MODEL_PROVIDER: "gemini",
          GEMINI_API_KEY: "test-gemini-key",
          RAG_CARD_MODEL_TIMEOUT_MS: "5000",
          API_DAILY_BUDGET_CNY: "10",
        },
        signal: controller.signal,
        fetchImpl,
      }),
      readWarnings: (result) => result.warnings,
    },
  ];

  for (const provider of providers) {
    const controller = new AbortController();
    let bodyStarted = false;
    let requestSignal = null;
    const pending = provider.call({
      controller,
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        assert.equal(typeof requestSignal?.addEventListener, "function", provider.label);
        if (provider.directSignal) assert.equal(requestSignal, controller.signal, provider.label);
        return {
          ok: true,
          status: 200,
          json: async () => {
            bodyStarted = true;
            return new Promise(() => {});
          },
        };
      },
    });
    await waitFor(() => bodyStarted);
    const abortReason = new DOMException(`${provider.label} body cancelled`, "AbortError");
    controller.abort(abortReason);
    const outcome = Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`${provider.label}_body_abort_did_not_settle`)),
        250,
      )),
    ]);

    assert.equal(requestSignal?.aborted, true, provider.label);
    if (provider.label === "gemini") {
      await assert.rejects(outcome, (error) => error === abortReason);
      assert.equal(requestSignal.reason, "all_singleflight_waiters_aborted");
      continue;
    }
    const result = await outcome;
    assert.ok(
      provider.readWarnings(result).some((warning) => (
        warning.startsWith("model_call_failed:")
        || warning.startsWith("card_name_model_failed:")
      )),
      provider.label,
    );
  }
});

test("lightweight auxiliary timeout aborts both transport and a stalled JSON body", async () => {
  const runCase = async ({ label, bodyStalls }) => {
    let requestSignal = null;
    let bodyStarted = false;
    const result = await callCardNameExtractionModel({
      userQuery: `auxiliary-timeout-${label}-20400101`,
      dataRevision: `auxiliary-timeout-${label}`,
      env: {
        MODEL_PROVIDER: "deepseek",
        RAG_CARD_MODEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-deepseek-key",
        RAG_CARD_MODEL_TIMEOUT_MS: "5",
        API_DAILY_BUDGET_CNY: "10",
      },
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        if (!bodyStalls) return new Promise(() => {});
        return {
          ok: true,
          status: 200,
          json: async () => {
            bodyStarted = true;
            return new Promise(() => {});
          },
        };
      },
    });

    assert.equal(requestSignal?.aborted, true, label);
    assert.equal(requestSignal?.reason?.message, "card_name_model_timeout", label);
    assert.equal(bodyStarted, bodyStalls, label);
    assert.ok(result.warnings.includes("card_name_model_failed:card_name_model_timeout"), label);
    assert.ok(result.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"), label);
  };

  await runCase({ label: "transport", bodyStalls: false });
  await runCase({ label: "body", bodyStalls: true });
});

test("parallel rulebook timeouts abort each provider request independently", async () => {
  const signals = [];
  const result = await callRulebookGroundingModel({
    userQuery: "发动时支付代价后，对象离开墓地且场上的持续效果不再适用，后续特殊召唤处理应如何继续？",
    cardTexts: [{
      id: "generic-card-text-rulebook-timeout",
      type: "card_text",
      title: "匿名效果卡",
      text: "舍弃1张卡可以发动。以墓地1只怪兽为对象，将其特殊召唤。只要此卡存在场上，该怪兽不受其他效果影响。",
    }],
    ruleEvidence: [{
      id: "generic-state-transition-timeout",
      type: "rulebook",
      title: "通用规则",
      text: "发动时先支付代价并选择对象；处理时再确认对象是否仍在该区域。",
    }],
    dataRevision: "parallel-rulebook-timeout-v1",
    env: {
      MODEL_PROVIDER: "deepseek",
      RAG_RULEBOOK_MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      RAG_RULEBOOK_MODEL_TIMEOUT_MS: "5",
      RAG_RULEBOOK_REPAIR_TIMEOUT_MS: "8",
      API_DAILY_BUDGET_CNY: "10",
    },
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    },
  });

  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.deepEqual(
    new Set(signals.map((signal) => signal.reason?.message)),
    new Set([
      "rulebook_grounding_model_timeout",
      "rulebook_grounding_focused_repair_timeout",
    ]),
  );
  assert.ok(result.warnings.some((warning) => warning.includes("rulebook_grounding_primary_failed")));
  assert.ok(result.warnings.some((warning) => warning.includes("rulebook_grounding_focused_repair_failed")));
});

test("public DeepSeek budget also treats cached input as uncached", () => {
  const cost = estimateDeepSeekCostCny({
    prompt_tokens: 1000,
    completion_tokens: 500,
    prompt_cache_hit_tokens: 200,
    prompt_cache_miss_tokens: 800,
  }, {
    RAG_MODEL_TIER: "flash",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    DEEPSEEK_CACHE_HIT_INPUT_CNY_PER_MTOK: "0.02",
  });
  assert.equal(cost, 0.002);
});

test("usage_cost_estimation_uses_flash_prices", () => {
  const cost = estimateDeepSeekCostCny({
    prompt_tokens: 1000,
    completion_tokens: 500,
  }, {
    RAG_MODEL_TIER: "flash",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "3",
    DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "4",
  });
  assert.equal(cost, 0.005);
});

test("usage_cost_estimation_uses Pro prices when the Pro tier is selected", () => {
  const cost = estimateDeepSeekCostCny({
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  }, {
    RAG_MODEL_TIER: "pro",
    DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "3",
    DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "4",
    DEEPSEEK_PRO_INPUT_CNY_PER_MTOK: "8",
    DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK: "9",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  });
  assert.equal(cost, 17);
});

test("usage_cost_estimation_glm_defaults_to_8_input_and_28_output_cny_per_million", () => {
  const cost = estimateGlmCostCny({
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  });
  assert.equal(cost, 36);
});

test("daily budget meters evidence, GLM final, and DeepSeek final in independent buckets", async () => {
  const now = new Date("2038-02-02T00:00:00.000Z");
  const env = {
    API_DAILY_BUDGET_CNY: "10",
    API_EVIDENCE_DAILY_BUDGET_CNY: "0.01",
    API_GLM_FINAL_DAILY_BUDGET_CNY: "0.03",
    API_DEEPSEEK_FINAL_DAILY_BUDGET_CNY: "0.01",
    API_BUDGET_TIMEZONE: "UTC",
    RAG_MAX_OUTPUT_TOKENS: "1000",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    GLM_API_KEY: "test-glm-key",
  };
  await resetRagBudget({ env, now });

  const preparation = await callCardNameExtractionModel({
    userQuery: "三个分桶独立计量-资料准备-20380202",
    env: { ...env, RAG_CARD_MODEL_PROVIDER: "deepseek" },
    now,
    fetchImpl: async () => jsonResponse({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ cardNames: [] }) },
      }],
      usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
    }),
  });

  let glmFetchCount = 0;
  const callGlmFinal = () => callRagModel({
    prompt: "GLM bucket",
    env: {
      ...env,
      MODEL_PROVIDER: "glm",
      GLM_MODEL: "glm-5.2",
      RAG_THINKING_MODE: "enabled",
      RAG_REASONING_EFFORT: "high",
    },
    now,
    fetchImpl: async () => {
      glmFetchCount += 1;
      return jsonResponse({
        model: "glm-5.2",
        choices: [{ message: { content: JSON.stringify(modelJson("GLM bucket OK")) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
      });
    },
  });
  const glmFinal = await callGlmFinal();
  const blockedSecondGlm = await callGlmFinal();

  const deepSeekFinal = await callRagModel({
    prompt: "DeepSeek bucket",
    thinkingMode: "disabled",
    env: {
      ...env,
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "flash",
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
    },
    now,
    fetchImpl: async () => jsonResponse({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: JSON.stringify(modelJson("DeepSeek bucket OK")) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
    }),
  });
  const status = await getRagBudgetStatus({ env, now });

  assert.equal(glmFetchCount, 1, "the exhausted GLM bucket must block only the second GLM call");
  assert.equal(blockedSecondGlm.answer.answerLevel, "budget_limited");
  assert.equal(preparation.budgetStatus.bucket.id, "evidence_preparation:deepseek");
  assert.equal(glmFinal.budgetStatus.bucket.id, "final_ruling:glm");
  assert.equal(deepSeekFinal.budgetStatus.bucket.id, "final_ruling:deepseek");
  assert.equal(status.spentTodayCny, 0.026);
  assert.equal(status.remainingTodayCny, 9.974);
  assert.deepEqual(status.buckets.map((bucket) => ({
    id: bucket.id,
    spent: bucket.spentTodayCny,
    limit: bucket.dailyBudgetCny,
    remaining: bucket.remainingTodayCny,
  })), [
    { id: "evidence_preparation:deepseek", spent: 0.002, limit: 0.01, remaining: 0.008 },
    { id: "final_ruling:glm", spent: 0.022, limit: 0.03, remaining: 0.008 },
    { id: "final_ruling:deepseek", spent: 0.002, limit: 0.01, remaining: 0.008 },
    { id: "final_ruling:relay", spent: null, limit: null, remaining: null },
  ]);
});

test("legacy total daily budget remains a ceiling above a larger provider bucket", async () => {
  const now = new Date("2038-02-03T00:00:00.000Z");
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_MODEL_TIER: "flash",
    RAG_MAX_OUTPUT_TOKENS: "1000",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    API_DAILY_BUDGET_CNY: "0.001",
    API_DEEPSEEK_FINAL_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  await resetRagBudget({ env, now });
  let fetchCount = 0;
  const result = await callRagModel({
    prompt: "the total ceiling is smaller than this call",
    env,
    now,
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({});
    },
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.equal(result.budgetStatus.dailyBudgetCny, 0.001);
  assert.equal(result.budgetStatus.spentTodayCny, 0);
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:deepseek");
  assert.equal(result.budgetStatus.bucket.dailyBudgetCny, 10);
  assert.equal(result.budgetStatus.bucket.spentTodayCny, 0);
  assert.equal(result.budgetStatus.limitEnforced, true);
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
  status = await resetRagBudget({ env, fetchImpl: redis.fetchImpl, now: new Date("2026-07-09T00:00:00Z") });
  assert.equal(status.buckets.length, 4);
  const resetCommands = redis.commands.filter((command) => command[0] === "EVAL" && command[6] === "reset");
  assert.deepEqual(resetCommands.map((command) => command[3]).sort(), [
    "rag-api-budget:v3:2026-07-09:cny-total",
    "rag-api-budget:v3:2026-07-09:evidence_preparation:deepseek:cny",
    "rag-api-budget:v3:2026-07-09:final_ruling:deepseek:cny",
    "rag-api-budget:v3:2026-07-09:final_ruling:glm:cny",
  ]);
  assert.ok(resetCommands.every((command) => command[2] === "3" && command[8] === "172800"));
  const relayReset = redis.commands.find((command) => command[0] === "EVAL"
    && command[2] === "4"
    && command[3] === "rag-api-budget:v3:2026-07-09:final_ruling:relay:usd");
  assert.ok(relayReset);
  assert.equal(relayReset[6], "rag-api-budget:v3:2026-07-09:final_ruling:relay:manually-closed");
  assert.equal(relayReset[7], "172800");
});

test("budget_status_accepts_the_named_Upstash_budget_integration_aliases", async () => {
  const env = {
    VERCEL: "1",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    UPSTASH_BUDGET_KV_REST_API_URL: "https://budget-kv.example.test",
    UPSTASH_BUDGET_KV_REST_API_TOKEN: "budget-kv-token",
  };
  const redis = createRedisFetch({
    url: "https://budget-kv.example.test",
    token: "budget-kv-token",
  });
  const status = await getRagBudgetStatus({
    env,
    fetchImpl: redis.fetchImpl,
    now: new Date("2026-07-10T00:00:00Z"),
  });

  assert.equal(status.budgetStorage, "redis");
  assert.equal(status.budgetPersistent, true);
});

test("persistent budget increments and TTL use one atomic Redis command", async () => {
  const now = new Date("2049-07-02T00:00:00.000Z");
  const redis = createRedisFetch();
  const env = {
    MODEL_PROVIDER: "deepseek",
    RAG_MODEL_TIER: "flash",
    RAG_MAX_OUTPUT_TOKENS: "64",
    DEEPSEEK_API_KEY: "deepseek-test-key",
    DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const result = await callRagModel({
    prompt: "atomic budget ledger",
    env,
    now,
    fetchImpl: async (url, options) => {
      if (url === "https://kv.example.test") return redis.fetchImpl(url, options);
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      return jsonResponse({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: JSON.stringify(modelJson("Atomic budget OK")) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    },
  });

  const increments = redis.commands.filter(
    (command) => command[0] === "EVAL" && command[2] === "1",
  );
  assert.ok(increments.length >= 2);
  assert.ok(increments.every((command) => (
    command.length === 6
      && command[1].includes("INCRBYFLOAT")
      && command[1].includes("EXPIRE")
      && command[5] === "172800"
  )));
  assert.equal(redis.commands.some((command) => command[0] === "INCRBYFLOAT"), false);
  assert.equal(redis.commands.some((command) => command[0] === "EXPIRE"), false);
  assert.equal(result.budgetStatus.bucket.spentTodayCny, result.estimatedCostCny);
});

test("a stalled Redis budget backend fails closed within one total deadline", async () => {
  let providerFetchCount = 0;
  const startedAt = Date.now();
  const result = await callRagModel({
    prompt: "stalled budget backend",
    env: {
      VERCEL: "1",
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-test-key",
      API_BUDGET_TIMEZONE: "UTC",
      API_BUDGET_REDIS_TIMEOUT_MS: "20",
      API_BUDGET_REDIS_TOTAL_TIMEOUT_MS: "30",
      KV_REST_API_URL: "https://kv-stalled.example.test",
      KV_REST_API_TOKEN: "kv-token",
    },
    now: new Date("2049-07-03T00:00:00.000Z"),
    fetchImpl: async (url) => {
      if (url === "https://kv-stalled.example.test") return new Promise(() => {});
      providerFetchCount += 1;
      return jsonResponse({});
    },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(providerFetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.ok(elapsedMs < 500, `expected bounded Redis failure, got ${elapsedMs}ms`);
});

test("a successful over-limit reservation receives a fresh bounded rollback deadline", async () => {
  const redisUrl = "https://kv-rollback.example.test";
  const commands = [];
  let providerFetchCount = 0;
  let delayedReservationResult = false;
  const result = await callRagModel({
    prompt: "anonymous concurrent budget rollback",
    env: {
      VERCEL: "1",
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-test-key",
      API_DAILY_BUDGET_CNY: "100",
      API_BUDGET_TIMEZONE: "UTC",
      API_BUDGET_REDIS_TIMEOUT_MS: "200",
      API_BUDGET_REDIS_TOTAL_TIMEOUT_MS: "50",
      KV_REST_API_URL: redisUrl,
      KV_REST_API_TOKEN: "kv-token",
    },
    now: new Date("2049-07-04T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      if (url !== redisUrl) {
        providerFetchCount += 1;
        return jsonResponse({});
      }
      const command = JSON.parse(options.body);
      commands.push(command);
      if (command[0] === "GET") return jsonResponse({ result: "0" });
      if (command[0] === "EVAL" && command[2] === "3") {
        // The production ledger reconciles its legacy key before reserving.
        // Keep that migration neutral so this test reaches the reservation race.
        return jsonResponse({ result: "0" });
      }
      if (command[0] === "EVAL" && Number(command[4]) > 0) {
        return {
          ok: true,
          status: 200,
          async json() {
            const payload = {};
            Object.defineProperty(payload, "result", {
              get() {
                // Consume the original aggregate deadline only after Redis has
                // accepted the increment and returned a parseable response.
                const until = Date.now() + 80;
                while (Date.now() < until) {}
                delayedReservationResult = true;
                return "101";
              },
            });
            return payload;
          },
        };
      }
      if (command[0] === "EVAL" && Number(command[4]) < 0) {
        return jsonResponse({ result: "0" });
      }
      throw new Error(`unexpected Redis command: ${JSON.stringify(command)}`);
    },
  });

  const increments = commands.filter((command) => command[0] === "EVAL" && command[2] === "1");
  assert.equal(delayedReservationResult, true);
  assert.equal(providerFetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.equal(increments.length, 2);
  assert.ok(Number(increments[0][4]) > 0);
  assert.ok(Number(increments[1][4]) < 0);
});

test("budget storage fails closed instead of mixing a URL and token from different aliases", async () => {
  let fetchCount = 0;
  const status = await getRagBudgetStatus({
    env: {
      VERCEL: "1",
      API_DAILY_BUDGET_CNY: "10",
      API_BUDGET_TIMEZONE: "UTC",
      KV_REST_API_URL: "https://kv.example.test",
      UPSTASH_REDIS_REST_TOKEN: "token-from-another-alias",
    },
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("mixed credentials must not be used");
    },
    now: new Date("2026-07-10T00:00:00Z"),
  });

  assert.equal(fetchCount, 0);
  assert.equal(status.budgetStorage, "unconfigured");
  assert.equal(status.budgetPersistent, false);
  assert.equal(status.spentTodayCny, null);
});

test("budget storage fails closed when two complete aliases point at different databases", async () => {
  let fetchCount = 0;
  const result = await callRagModel({
    prompt: "conflicting redis aliases must block before model transport",
    env: {
      VERCEL: "1",
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      API_DAILY_BUDGET_CNY: "10",
      KV_REST_API_URL: "https://kv-a.example.test",
      KV_REST_API_TOKEN: "kv-a-token",
      UPSTASH_REDIS_REST_URL: "https://kv-b.example.test",
      UPSTASH_REDIS_REST_TOKEN: "kv-b-token",
    },
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("conflicting aliases must not be used");
    },
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.ok(result.warnings.includes("redis_alias_pairs_conflict"));
});

test("v3 currency ledgers conservatively migrate same-day legacy spend without treating CNY as USD", async () => {
  const env = {
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const redis = createRedisFetch();
  redis.store.set("rag-api-budget:2026-07-11", "4.001324");
  redis.store.set("rag-api-budget:v2:2026-07-11:final_ruling:relay", "4");
  const status = await getRagBudgetStatus({
    env,
    fetchImpl: redis.fetchImpl,
    now: new Date("2026-07-11T00:00:00Z"),
  });
  const relay = status.buckets.find((bucket) => bucket.id === "final_ruling:relay");

  assert.equal(status.spentTodayCny, 4.001324);
  assert.equal(relay.spentTodayUsd, 10);
  assert.equal(relay.dailyBudgetUsd, 10);
  assert.equal(relay.remainingTodayUsd, 0);
  assert.equal(redis.store.get("rag-api-budget:v3:2026-07-11:cny-total"), "4.001324");
  assert.equal(redis.store.get("rag-api-budget:v3:2026-07-11:final_ruling:relay:usd"), "10");

  const blocked = await callRagModel({
    prompt: "same-day migrated relay spend must remain blocked",
    env: {
      ...env,
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
    },
    fetchImpl: redis.fetchImpl,
    now: new Date("2026-07-11T00:00:00Z"),
  });
  assert.equal(blocked.answer.answerLevel, "budget_limited");
});

test("v3 budget reconciliation imports legacy writes that arrive after the first migration read", async () => {
  const date = "2033-04-11";
  const env = {
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const now = new Date(`${date}T06:07:08.000Z`);
  const redis = createRedisFetch();
  const legacyTotalKey = `rag-api-budget:${date}`;
  const legacyEvidenceKey = `rag-api-budget:v2:${date}:evidence_preparation:deepseek`;
  const legacyRelayKey = `rag-api-budget:v2:${date}:final_ruling:relay`;
  redis.store.set(legacyTotalKey, "2");
  redis.store.set(legacyEvidenceKey, "0.25");

  const first = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });
  assert.equal(first.spentTodayCny, 2);
  assert.equal(
    first.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny,
    0.25,
  );
  assert.equal(
    first.buckets.find((bucket) => bucket.id === "final_ruling:relay").spentTodayUsd,
    0,
  );

  // Simulate an old rolling-deployment instance writing v1/v2 after a newer
  // instance has already reconciled this day once.
  redis.store.set(legacyTotalKey, "3.5");
  redis.store.set(legacyEvidenceKey, "0.75");
  redis.store.set(legacyRelayKey, "0.01");
  const second = await getRagBudgetStatus({ env, fetchImpl: redis.fetchImpl, now });

  assert.equal(second.spentTodayCny, 3.5);
  assert.equal(
    second.buckets.find((bucket) => bucket.id === "evidence_preparation:deepseek").spentTodayCny,
    0.75,
  );
  assert.equal(
    second.buckets.find((bucket) => bucket.id === "final_ruling:relay").spentTodayUsd,
    10,
  );
  assert.equal(redis.store.get(`rag-api-budget:v3:${date}:cny-total`), "3.5");
  assert.equal(
    redis.store.get(`rag-api-budget:v3:${date}:evidence_preparation:deepseek:cny`),
    "0.75",
  );
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

test("configuring an engine does not change public card identity or trigger passcode hydration", async () => {
  const cid = "24680";
  const genericCard = {
    id: cid,
    cardId: cid,
    // Reproduce the legacy local-provider shape that copied a CID here. It
    // must never win over the verified Baige password.
    passcode: cid,
    name: "通用桥接测试卡",
    cnName: "通用桥接测试卡",
    cardType: "monster",
    effectText: "①：自己主要阶段可以发动。抽1张卡。",
    aliases: ["通用桥接测试卡"],
  };
  async function retrieveWithEnv(env) {
    const baigeQueries = [];
    const evidence = await retrieveRagEvidence({
      userQuery: "通用桥接测试卡的效果如何处理？",
      cardResolution: {
        resolvedCards: [genericCard],
        unresolvedMentions: [],
        ambiguousMentions: [],
        userProvidedCardTexts: [],
      },
      cards: [genericCard],
      records: [],
      qaRecords: [],
      env,
      fetchImpl: async (url) => {
        baigeQueries.push(new URL(url).searchParams.get("search"));
        return jsonResponse({ result: [] });
      },
    });
    return { evidence, baigeQueries };
  }

  const plain = await retrieveWithEnv({ RAG_LIVE_OFFICIAL_QA: "false" });
  const configured = await retrieveWithEnv({
    OCG_ENGINE_URL: "https://engine.example.test",
    RAG_AUTO_ENGINE_SIMULATION: "false",
    RAG_LIVE_OFFICIAL_QA: "false",
  });
  assert.deepEqual(plain.baigeQueries, []);
  assert.deepEqual(configured.baigeQueries, []);

  const publicIdentity = ({ id, cardId, passcode, name, effectText }) => ({
    id,
    cardId,
    passcode,
    name,
    effectText,
  });
  assert.deepEqual(
    configured.evidence.retrievedCards.map(publicIdentity),
    plain.evidence.retrievedCards.map(publicIdentity),
  );
  assert.equal(configured.evidence.retrievedCards.length, 1);
  assert.equal(configured.evidence.retrievedCards[0].id, cid);
  assert.equal(configured.evidence.retrievedCards[0].passcode, "");
});

test("owner cap stops only today's public ChatGPT bucket at the ten-dollar hard ceiling", async () => {
  const now = new Date("2038-02-04T00:00:00.000Z");
  const env = {
    API_BUDGET_TIMEZONE: "UTC",
    API_DAILY_BUDGET_CNY: "10",
    API_CHATGPT_DAILY_BUDGET_USD: "100",
  };
  await resetRagBudget({ env, now });

  const capped = await capPublicChatGptBudget({ env, now });
  const status = await getRagBudgetStatus({ env, now });
  const relay = status.buckets.find((bucket) => bucket.id === "final_ruling:relay");

  assert.equal(capped.action, "cap_public_chatgpt");
  assert.equal(relay.dailyBudgetUsd, 10);
  assert.equal(relay.spentTodayUsd, 10);
  assert.equal(relay.remainingTodayUsd, 0);
  assert.equal(relay.manuallyClosed, true);
  assert.equal(relay.limitEnforced, true);
  assert.equal(status.spentTodayCny, 0);
  assert.deepEqual(
    status.buckets
      .filter((bucket) => bucket.id !== "final_ruling:relay")
      .map((bucket) => bucket.spentTodayCny),
    [0, 0, 0],
  );

  let providerCalls = 0;
  const blocked = await callRagModel({
    prompt: "public calls stop after the owner cap",
    env: {
      ...env,
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "test-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
    },
    now,
    fetchImpl: async () => {
      providerCalls += 1;
      return relaySseResponse({});
    },
  });
  assert.equal(providerCalls, 0);
  assert.equal(blocked.answer.answerLevel, "budget_limited");
  assert.equal(
    blocked.answer.shortAnswer,
    "今日公开裁定额度已达到每日 10 美元上限，未调用模型。如需协助重置，作者b站账号「おmaginai」QAQ",
  );
});

test("paid loopback private evaluation uses an isolated finite memory budget", async () => {
  const now = new Date("2038-02-04T04:00:00.000Z");
  const runId = "1234567890-1-abcdef1234567890";
  const publicEnv = {
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
  };
  await resetRagBudget({ env: publicEnv, now });
  await capPublicChatGptBudget({ env: publicEnv, now });
  let providerCalls = 0;
  const result = await callRagModel({
    prompt: "isolated private evaluation budget",
    env: {
      ...publicEnv,
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "test-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
      PRIVATE_EVALUATION_MODE: "true",
      PRIVATE_EVALUATION_DIAGNOSTICS: "true",
      PRIVATE_EVALUATION_RUN_ID: runId,
      PRIVATE_EVALUATION_BUDGET_USD: "0.01",
      HOST: "127.0.0.1",
    },
    now,
    fetchImpl: async () => {
      providerCalls += 1;
      const content = JSON.stringify(modelJson("private evaluation completed"));
      return new Response(`data: ${JSON.stringify({
        model: "gpt-5.6-sol",
        choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const publicStatus = await getRagBudgetStatus({ env: publicEnv, now });
  const publicRelay = publicStatus.buckets.find((bucket) => bucket.id === "final_ruling:relay");

  assert.equal(providerCalls, 1);
  assert.equal(result.answer.shortAnswer, "private evaluation completed");
  assert.equal(result.budgetStatus.privateEvaluation, true);
  assert.equal(result.budgetStatus.privateEvaluationRunId, runId);
  assert.equal(result.budgetStatus.budgetStorage, "private_evaluation_memory");
  assert.equal(result.budgetStatus.bucket.dailyBudgetUsd, 0.01);
  assert.ok(result.warnings.includes("private_evaluation_budget_isolated"));
  assert.equal(publicRelay.spentTodayUsd, 10);
  assert.equal(publicRelay.manuallyClosed, true);
});

test("private evaluation budget gate fails closed to the public ledger unless every server-owned condition matches", async () => {
  const now = new Date("2038-02-04T05:00:00.000Z");
  const base = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_RUN_ID: "1234567890-1-abcdef1234567890",
    PRIVATE_EVALUATION_BUDGET_USD: "40",
    HOST: "127.0.0.1",
  };
  const variants = [
    { PRIVATE_EVALUATION_MODE: "false" },
    { PRIVATE_EVALUATION_DIAGNOSTICS: "false" },
    { PRIVATE_EVALUATION_RUN_ID: "short" },
    { HOST: "0.0.0.0" },
    { VERCEL: "1" },
  ];

  for (const variant of variants) {
    const env = { ...base, ...variant };
    await resetRagBudget({ env, now });
    await capPublicChatGptBudget({ env, now });
    let providerCalls = 0;
    const result = await callRagModel({
      prompt: `reject private budget gate ${JSON.stringify(variant)}`,
      env,
      now,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error("provider must not be called");
      },
    });
    assert.equal(providerCalls, 0);
    assert.equal(result.answer.answerLevel, "budget_limited");
    assert.notEqual(result.budgetStatus.privateEvaluation, true);
  }
});

test("private evaluation budget clamps oversized configuration and enforces one shared run ledger", async () => {
  let providerCalls = 0;
  const env = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_RUN_ID: "1234567890-1-abcdef1234567891",
    PRIVATE_EVALUATION_BUDGET_USD: "9999",
    HOST: "127.0.0.1",
  };
  const fetchImpl = async () => {
    providerCalls += 1;
    const content = JSON.stringify(modelJson("clamped private budget"));
    return new Response(`data: ${JSON.stringify({
      model: "gpt-5.6-sol",
      choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const first = await callRagModel({ prompt: "first private call", env, fetchImpl });
  const blocked = await callRagModel({
    prompt: "second private call",
    env: { ...env, PRIVATE_EVALUATION_BUDGET_USD: "0.000001" },
    fetchImpl,
  });

  assert.equal(providerCalls, 1);
  assert.equal(first.budgetStatus.bucket.dailyBudgetUsd, 50);
  assert.equal(first.budgetStatus.bucket.spentTodayUsd, first.estimatedCostUsd);
  assert.equal(blocked.answer.answerLevel, "budget_limited");
  assert.match(blocked.answer.shortAnswer, /私有评测额度.*0\.000001 美元硬上限/u);
  assert.equal(blocked.budgetStatus.privateEvaluation, true);
  assert.equal(blocked.budgetStatus.bucket.dailyBudgetUsd, 0.000001);
});

test("a definitely rejected private request releases its isolated reservation", async () => {
  const env = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_RUN_ID: "1234567890-1-abcdef1234567892",
    // Sol's conservative reservation includes the full 64-token output
    // envelope and is slightly above $0.001 at the checked-in price table.
    PRIVATE_EVALUATION_BUDGET_USD: "0.01",
    HOST: "127.0.0.1",
  };
  let calls = 0;
  const first = await callRagModel({
    prompt: "release private reservation",
    env,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const second = await callRagModel({
    prompt: "reuse released private reservation",
    env,
    fetchImpl: async () => {
      calls += 1;
      const content = JSON.stringify(modelJson("reservation was released"));
      return new Response(`data: ${JSON.stringify({
        model: "gpt-5.6-sol",
        choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  assert.equal(calls, 2);
  assert.equal(first.answer.answerLevel, "needs_more_info");
  assert.equal(first.budgetStatus.bucket.spentTodayUsd, 0);
  assert.equal(second.answer.shortAnswer, "reservation was released");
  assert.equal(second.budgetStatus.privateEvaluation, true);
});

test("persistent owner cap atomically closes only the public Relay USD bucket", async () => {
  const now = new Date("2038-02-05T00:00:00.000Z");
  const redis = createRedisFetch();
  const env = {
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "7.5",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  redis.store.set("rag-api-budget:v3:2038-02-05:cny-total", "2.5");
  redis.store.set("admin-final-budget:test-pool", "99");
  redis.store.set("rag-api-budget:v3:2038-02-05:final_ruling:relay:usd", "8.25");

  const capped = await capPublicChatGptBudget({ env, fetchImpl: redis.fetchImpl, now });

  assert.equal(redis.commands.length, 7);
  assert.deepEqual(redis.commands[0].slice(0, 1), ["EVAL"]);
  assert.match(String(redis.commands[0][1]), /math\.max\(current, limit\).*KEYS\[2\]/su);
  assert.deepEqual(redis.commands[0].slice(2), [
    "2",
    "rag-api-budget:v3:2038-02-05:final_ruling:relay:usd",
    "rag-api-budget:v3:2038-02-05:final_ruling:relay:manually-closed",
    "7.5",
    "172800",
  ]);
  assert.equal(redis.store.get("rag-api-budget:v3:2038-02-05:cny-total"), "2.5");
  assert.equal(redis.store.get("admin-final-budget:test-pool"), "99");
  const relay = capped.buckets.find((bucket) => bucket.id === "final_ruling:relay");
  assert.equal(relay.dailyBudgetUsd, 7.5);
  assert.equal(relay.spentTodayUsd, 8.25);
  assert.equal(relay.manuallyClosed, true);
  assert.equal(capped.buckets.length, 4);
});

test("persistent reset clears the Relay ledger and owner-close marker in one atomic command", async () => {
  const now = new Date("2038-02-05T12:00:00.000Z");
  const redis = createRedisFetch();
  const env = {
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const bucketKey = "rag-api-budget:v3:2038-02-05:final_ruling:relay:usd";
  const legacyKey = "rag-api-budget:v2:2038-02-05:final_ruling:relay";
  const watermarkKey = `${bucketKey}:legacy-watermark`;
  const closeKey = "rag-api-budget:v3:2038-02-05:final_ruling:relay:manually-closed";
  redis.store.set(bucketKey, "10");
  redis.store.set(legacyKey, "3");
  redis.store.set(watermarkKey, "1");
  redis.store.set(closeKey, "1");

  await resetRagBudget({ env, fetchImpl: redis.fetchImpl, now });

  const relayReset = redis.commands.find((command) => command[0] === "EVAL"
    && command[2] === "4"
    && command[3] === bucketKey);
  assert.ok(relayReset);
  assert.deepEqual(relayReset.slice(2), [
    "4",
    bucketKey,
    legacyKey,
    watermarkKey,
    closeKey,
    "172800",
  ]);
  assert.equal(redis.commands.some((command) => command[0] === "DEL" && command[1] === closeKey), false);
  assert.equal(redis.store.get(bucketKey), "0");
  assert.equal(redis.store.get(watermarkKey), "3");
  assert.equal(redis.store.has(closeKey), false);
});

test("an owner close between preflight reads and atomic reserve neither dispatches nor refunds an unmade reservation", async () => {
  const now = new Date("2038-02-05T18:00:00.000Z");
  const redis = createRedisFetch();
  const env = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const bucketKey = "rag-api-budget:v3:2038-02-05:final_ruling:relay:usd";
  const closeKey = "rag-api-budget:v3:2038-02-05:final_ruling:relay:manually-closed";
  redis.store.set(bucketKey, "0.1");
  let providerCalls = 0;
  let injectedClose = false;
  const fetchImpl = async (url, options = {}) => {
    if (url !== env.KV_REST_API_URL) {
      providerCalls += 1;
      throw new Error("provider must not be called after an owner close");
    }
    const command = JSON.parse(options.body || "[]");
    if (!injectedClose && command[0] === "GET" && command[1] === closeKey) {
      injectedClose = true;
      const response = jsonResponse({ result: null });
      redis.store.set(closeKey, "1");
      redis.store.set(bucketKey, "11");
      return response;
    }
    return redis.fetchImpl(url, options);
  };

  const blocked = await callRagModel({ prompt: "atomic close race", env, fetchImpl, now });

  assert.equal(injectedClose, true);
  assert.equal(providerCalls, 0);
  assert.equal(blocked.answer.answerLevel, "budget_limited");
  assert.equal(blocked.budgetStatus.bucket.manuallyClosed, true);
  assert.equal(redis.store.get(bucketKey), "11");
  assert.ok(redis.commands.some((command) => command[0] === "EVAL"
    && command[2] === "2"
    && String(command[1]).includes("return {'closed'")));
});

test("an in-flight public settlement cannot reopen an owner-closed ChatGPT day", async () => {
  const now = new Date("2038-02-06T00:00:00.000Z");
  const redis = createRedisFetch();
  const env = {
    API_BUDGET_TIMEZONE: "UTC",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    KV_REST_API_URL: "https://kv.example.test",
    KV_REST_API_TOKEN: "kv-token",
  };
  const bucketKey = "rag-api-budget:v3:2038-02-06:final_ruling:relay:usd";
  const closeKey = "rag-api-budget:v3:2038-02-06:final_ruling:relay:manually-closed";
  // Simulate a request that reserved before the owner closed the public pool,
  // then settled cheaply and refunded part of its reservation afterwards.
  redis.store.set(bucketKey, "0.2");
  await capPublicChatGptBudget({ env, fetchImpl: redis.fetchImpl, now });
  redis.store.set(bucketKey, "9.85");
  assert.equal(redis.store.get(closeKey), "1");

  let providerCalls = 0;
  const blocked = await callRagModel({
    prompt: "anonymous request after an in-flight settlement",
    env: {
      ...env,
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "test-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
    },
    now,
    fetchImpl: async (url, options) => {
      if (url === env.KV_REST_API_URL) return redis.fetchImpl(url, options);
      providerCalls += 1;
      throw new Error("provider must not be called after an owner close");
    },
  });
  assert.equal(providerCalls, 0);
  assert.equal(blocked.answer.answerLevel, "budget_limited");
  assert.equal(blocked.budgetStatus.bucket.limitEnforced, true);

  const reset = await resetRagBudget({ env, fetchImpl: redis.fetchImpl, now });
  const resetRelay = reset.buckets.find((bucket) => bucket.id === "final_ruling:relay");
  assert.equal(redis.store.has(closeKey), false);
  assert.equal(resetRelay.manuallyClosed, undefined);
  assert.equal(resetRelay.spentTodayUsd, 0);
});

test("public retrieval does not synthesize cross-card mechanism analogues", async () => {
  const lifecycleCard = {
    id: "lifecycle-current-card",
    name: "匿名期限卡",
    cnName: "匿名期限卡",
    effectText: "①：可以发动。将1只怪兽特殊召唤。只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上，自己从额外牌组仅可特殊召唤‘示例’怪兽。",
    aliases: ["匿名期限卡"],
  };
  const scopedNoise = {
    id: "qa-current-card-noise",
    recordType: "qa",
    title: "匿名期限卡的其他问答",
    question: "匿名期限卡被破坏时可以发动吗？",
    answer: "可以发动。",
    text: "匿名期限卡被破坏时可以发动吗？ 可以发动。",
    cardIds: ["lifecycle-current-card"],
    cards: ["匿名期限卡"],
  };
  const lifecycleAnalogue = {
    id: "qa-unrelated-lifecycle-analogue",
    recordType: "qa",
    title: "別のカードで特殊召喚したモンスターのコントロールが移った場合",
    question: "この効果で特殊召喚したモンスターは自分フィールドに存在する限り効果が適用されます。そのモンスターのコントロールが相手に移った場合、どうなりますか？",
    answer: "効果の適用はなくなります。その後、コントロールが再び自分に戻ったとしても、効果が再び適用される事はありません。",
    text: "この効果で特殊召喚したモンスターは自分フィールドに存在する限り効果が適用されます。そのモンスターのコントロールが相手に移った場合、効果の適用はなくなります。その後、コントロールが再び自分に戻ったとしても、効果が再び適用される事はありません。",
    cardIds: ["unrelated-card"],
    cards: ["別のカード"],
  };
  const ordinaryControlQa = {
    id: "qa-ordinary-control-change",
    recordType: "qa",
    title: "コントロールが移ったモンスターを対象にできますか？",
    question: "モンスターのコントロールが相手に移った場合、そのモンスターを対象にできますか？",
    answer: "対象にできます。",
    text: "モンスターのコントロールが相手に移った場合、そのモンスターを対象にできます。",
    cardIds: ["another-unrelated-card"],
  };

  const evidence = await retrieveRagEvidence({
    userQuery: "匿名期限卡的效果已经适用。这个效果特殊召唤的怪兽控制权转移后，只要在自己场上存在的限制还适用吗？之后控制权归还时会恢复适用吗？",
    cardResolution: {
      resolvedCards: [lifecycleCard],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [lifecycleCard],
    records: [],
    qaRecords: [scopedNoise, lifecycleAnalogue, ordinaryControlQa],
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.ok(evidence.ruleSearchQueries.every((item) => (
    !String(item.source || "").includes("effect_lifecycle")
    && !String(item.source || "").includes("compiled_scenario")
  )));
  assert.ok(!evidence.officialQaRelated.some((item) => item.id === lifecycleAnalogue.id));
  assert.ok(!evidence.officialQaDirectCandidates.some((item) => item.id === lifecycleAnalogue.id));
  assert.equal(evidence.debug.officialMechanismAnalogueCount, 0);
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
  assert.equal(bundle.promptTruncated, true);
  assert.doesNotMatch(bundle.prompt, /上下文因 RAG_MAX_PROMPT_CHARS 限制被截断/u);
  assert.match(bundle.prompt, /allowedEvidenceIds/u);
  assert.match(bundle.prompt, /card-text-long/u);
  assert.match(bundle.prompt, /usedEvidence 的 id 只能来自 allowedEvidenceIds/u);
});

test("public prompt retains card text, excludes semantic state output, and has no recovery prompt", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery: "这个效果可以发动吗，后续如何处理？",
    cardResolution: {
      resolvedCards: [{
        id: "recovery-card",
        name: "恢复测试龙",
        cardType: "monster",
        attribute: "WIND",
        race: "Dragon",
        atk: 2500,
        def: 2000,
        level: 8,
        rank: null,
        link: null,
        effectText: "EFFECT_TEXT_RECOVERY_MARKER：舍弃1张手牌发动，处理时再检查场面。",
      }],
    },
    evidence: {
      cardTexts: [],
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      retrievalWarnings: [],
      semanticStateTransition: {
        status: "resolved",
        complete: true,
        activation: { legal: true, conclusion: "发动合法" },
        resolution: { legal: false, conclusion: "处理时后续步骤失败" },
        trace: [{
          phase: "resolution",
          status: "blocked",
          conclusion: "SEMANTIC_STATE_RECOVERY_MARKER：支付代价后重新计算持续效果。",
          evidenceIds: ["rule-state-transition"],
        }],
        evidenceIds: ["rule-state-transition"],
      },
    },
    env: { RAG_RECOVERY_PROMPT_CHARS: "12000" },
  });

  assert.match(bundle.prompt, /EFFECT_TEXT_RECOVERY_MARKER/u);
  assert.equal(bundle.recoveryPrompt, "");
  assert.doesNotMatch(bundle.recoveryPrompt, /SEMANTIC_STATE_RECOVERY_MARKER/u);
  assert.doesNotMatch(bundle.recoveryPrompt, /semanticStateTransition/u);
  assert.match(bundle.prompt, /usedEvidence.*allowedEvidenceIds/u);
});

test("compacted_prompt_keeps_each_critical_evidence_bucket", () => {
  const longText = (marker) => `${marker} ${"证据内容".repeat(600)}`;
  const bundle = buildRagRulingPromptBundle({
    userQuery: "需要同时参考官方问答、卡文、规则书和FAQ的复杂问题",
    cardResolution: { resolvedCards: cards },
    evidence: {
      officialQaDirectCandidates: [
        { id: "direct-critical", type: "official_qa", title: "官方直答", text: longText("DIRECT_MARKER"), isDirect: true },
        { id: "direct-critical-2", type: "official_qa", title: "第二条官方直答", text: longText("DIRECT_MARKER_2"), isDirect: true },
      ],
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

test("unique exact official QA uses a focused complete-answer route", async () => {
  const officialCatalogue = Array.from({ length: 10 }, (_, index) => `「<<${95000 + index}>>」`).join(" ");
  const directCards = [
    {
      id: "91001",
      name: "规则神兽",
      aliases: ["规则神兽"],
      cardType: "怪兽",
      effectText: "此卡在规则上也视为“规则学”卡。无关卡文的特殊召唤限制。",
    },
    {
      id: "91002",
      name: "规则学都",
      aliases: ["规则学都"],
      cardType: "魔法",
      effectText: "宣言1只“规则学”怪兽的卡名才能发动。",
    },
  ];
  const directQa = {
    id: "ygoresources-qa-focused-route",
    recordType: "qa",
    question: "可以宣言「规则神兽」发动「规则学都」②效果吗？",
    answer: `可以宣言并发动，因为「<<91001>>」在规则上也视为“规则学”卡。（本回合不能再次宣言「<<91001>>」。） 以下卡片也适用相同裁定：${officialCatalogue}`,
    cardIds: ["91001", "91002"],
    questionCardIds: ["91001", "91002"],
    sourceUrl: "https://example.test/qa/focused-route",
  };
  let finalPrompt = "";
  let finalGeneration = null;
  let rulebookModelCalled = false;
  const answer = await answerRagRulingQuestion({
    question: directQa.question,
    cards: directCards,
    records: [],
    qaRecords: [directQa],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      RAG_AUTO_ENGINE_SIMULATION: "false",
      OCG_ENGINE_URL: "http://formal.test",
      MODEL_PROVIDER: "deepseek",
      RAG_MODEL_PROVIDER: "deepseek",
      RAG_MODEL_TIER: "pro",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_PRO_MODEL: "pro-test",
      DEEPSEEK_FLASH_MODEL: "flash-test",
      RAG_THINKING_MODE: "enabled",
      RAG_OFFICIAL_DIRECT_FOCUSED_PROMPT: "true",
    },
    rulebookModelInvoker: async () => {
      rulebookModelCalled = true;
      throw new Error("exact official QA must skip broad rulebook grounding");
    },
    modelInvoker: async ({ prompt, modelName, thinkingMode, maxTokens }) => {
      finalPrompt = prompt;
      finalGeneration = { modelName, thinkingMode, maxTokens };
      return JSON.stringify({
        answerLevel: "official_confirmed",
        shortAnswer: "可以宣言并发动；但本回合不能再次宣言「规则神兽」。",
        reasoning: ["官方问答确认可以发动，并给出了本回合的后续限制。"],
        usedCards: ["规则神兽", "规则学都"],
        usedEvidence: [{ id: directQa.id, type: "official_qa", title: "精确官方问答" }],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "high",
      });
    },
  });

  assert.equal(rulebookModelCalled, false);
  assert.deepEqual(finalGeneration, {
    modelName: "pro-test",
    thinkingMode: "enabled",
    maxTokens: 32000,
  });
  assert.match(finalPrompt, /本回合不能再次宣言/u);
  assert.doesNotMatch(finalPrompt, /无关卡文的特殊召唤限制/u);
  assert.equal(answer.answerLevel, "official_confirmed");
  assert.ok(answer.usedEvidence.some((item) => item.id === directQa.id && item.type === "official_qa"));
  assert.match(answer.shortAnswer, /本回合不能再次宣言/u);
  assert.doesNotMatch(answer.shortAnswer, /官方 Q&A 完整回答原文/u);
  assert.doesNotMatch(answer.shortAnswer, /<<91001>>|「「/u);
  assert.doesNotMatch(answer.shortAnswer, /<<95000>>/u);
  assert.ok(answer.reasoning.some((item) => /官方问答确认可以发动/u.test(item)));
  assert.ok(!answer.riskFlags.includes("official_direct_evidence_enforced"));
  assert.ok(answer.debug.retrievalWarnings.includes("official_direct_focused_prompt"));

  const contradicted = await answerRagRulingQuestion({
    question: directQa.question,
    cards: directCards,
    records: [],
    qaRecords: [directQa],
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
      answerLevel: "official_confirmed",
      shortAnswer: "不能发动。",
      reasoning: ["错误地把官方结论写反。"],
      usedCards: ["规则神兽", "规则学都"],
      usedEvidence: [{ id: directQa.id, type: "official_qa", title: "官方问答" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "high",
      });
    },
  });
  assert.equal(contradicted.shortAnswer, "不能发动。");
  assert.ok(!contradicted.riskFlags.includes("authoritative_official_direct_fallback_applied"));
});

test("focused official QA prompt preserves the full-source tail without invalid JSON slicing", () => {
  const sourceText = `问题？回答开头。${"中间内容".repeat(800)}（TAIL_MARKER：本回合不能再次宣言同名卡。）`;
  const bundle = buildRagRulingPromptBundle({
    userQuery: "可以发动这个效果吗？",
    cardResolution: {
      resolvedCards: [{ id: "92001", name: "长文本测试卡", aliases: ["长文本测试卡"] }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [{
        id: "ygoresources-qa-long-tail",
        type: "official_qa",
        title: "长官方回答",
        fullText: sourceText,
        text: `${sourceText.slice(0, 100)}…`,
        sourceUrl: "https://example.test/qa/long-tail",
        isDirect: true,
        matchLevel: "official_qa_exact",
        matchedQuestionCardIds: ["92001"],
        questionCardIdCoverage: 1,
        questionCardIdCount: 1,
        authoritativeSceneMatch: true,
        authoritativeSceneMatchReason: "raw_or_normalized_query",
      }],
      officialQaRelated: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
      retrievalWarnings: [],
    },
    env: { RAG_MAX_PROMPT_CHARS: "1800", RAG_OFFICIAL_DIRECT_FOCUSED_PROMPT: "true" },
  });

  assert.equal(bundle.prompt.length <= 1800, true);
  assert.equal(bundle.promptTruncated, true);
  assert.match(bundle.prompt, /TAIL_MARKER/u);
  assert.doesNotThrow(() => JSON.parse(bundle.prompt.split("\n").at(-1)));
});

test("focused official QA prompt keeps the ruling but omits a dense placeholder catalogue", () => {
  const catalogue = Array.from({ length: 20 }, (_, index) => `「<<${94000 + index}>>」①`).join("\n");
  const sourceText = [
    "この効果を発動できますか？",
    "発動できます。処理時には対象のカードを除外します。",
    "ただし、対象が存在しない場合には除外する処理を行いません。",
    "例として、以下のカードの効果についても同様です。",
    "モンスター効果",
    catalogue,
    "ENUMERATION_END",
  ].join("\n");
  const bundle = buildRagRulingPromptBundle({
    userQuery: "这个效果可以发动吗？",
    cardResolution: {
      resolvedCards: [{ id: "93001", name: "目录测试卡", aliases: ["目录测试卡"] }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [{
        id: "ygoresources-qa-placeholder-catalogue",
        type: "official_qa",
        title: "带穷举目录的官方回答",
        fullText: sourceText,
        text: sourceText,
        sourceUrl: "https://example.test/qa/placeholder-catalogue",
        isDirect: true,
        matchLevel: "official_qa_exact",
        matchedQuestionCardIds: ["93001"],
        questionCardIdCoverage: 1,
        questionCardIdCount: 1,
        authoritativeSceneMatch: true,
        authoritativeSceneMatchReason: "raw_or_normalized_query",
      }],
      officialQaRelated: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
      retrievalWarnings: [],
    },
    env: { RAG_MAX_PROMPT_CHARS: "12000", RAG_OFFICIAL_DIRECT_FOCUSED_PROMPT: "true" },
  });

  assert.ok(bundle.warnings.includes("official_direct_focused_prompt"));
  assert.match(bundle.prompt, /発動できます/u);
  assert.match(bundle.prompt, /対象が存在しない場合/u);
  assert.doesNotMatch(bundle.prompt, /<<94000>>/u);
  assert.doesNotMatch(bundle.prompt, /ENUMERATION_END/u);
  assert.match(bundle.prompt, /reasoning、usedCards、missingInfo、riskFlags 必须是字符串数组/u);
  assert.match(bundle.prompt, /usedEvidence 必须是对象数组/u);
  const payload = JSON.parse(bundle.prompt.split("\n").at(-1));
  assert.doesNotMatch(payload.officialQaDirectCandidate.text, /<<94000>>/u);
});

test("semantic or card-set subsumption remains related evidence instead of an official direct route", () => {
  const candidate = {
    id: "qa-semantic-superset",
    type: "official_qa",
    title: "列举多个例卡的官方长问题",
    fullText: "列举多个形成素材限制的例卡后，询问目标怪兽的特殊召唤手续。可以送去墓地并特殊召唤；这个特殊召唤不是融合召唤。",
    text: "可以送去墓地并特殊召唤。",
    isDirect: true,
    matchLevel: "official_qa_exact",
    matchedQuestionCardIds: ["7403"],
    questionCardIdCoverage: 1,
    questionCardIdCount: 8,
    authoritativeSceneMatch: true,
    authoritativeSceneMatchReason: "unique_semantic_question_subsumption",
    scenarioPremiseCompatibility: "compatible",
    subsumptionCandidatePoolComplete: true,
    semanticSubsumptionCertified: true,
    semanticSubsumptionScoreMargin: 0.2,
  };
  const cardResolution = {
    resolvedCards: [{ id: "7403", name: "嵌合要塞龙" }],
    unresolvedMentions: [],
    ambiguousMentions: [],
  };
  const evidence = {
    officialQaDirectCandidates: [candidate],
    officialQaRelated: [],
    faqRelated: [],
    cardTexts: [],
    userProvidedCardTexts: [],
    rawRelatedEvidence: [],
    retrievalWarnings: [],
  };

  const directEnv = { RAG_OFFICIAL_DIRECT_FOCUSED_PROMPT: "true" };
  const accepted = buildRagRulingPromptBundle({ userQuery: "能用不能作为融合素材的怪兽进行这次特殊召唤吗？", cardResolution, evidence, env: directEnv });
  assert.equal(accepted.warnings.includes("official_direct_focused_prompt"), false);
  assert.ok(accepted.warnings.includes("official_direct_candidates_downgraded_to_related:1"));
  const acceptedPayload = JSON.parse(accepted.prompt.split("本次用户问题、卡片原文与检索资料如下：\n").at(-1));
  assert.deepEqual(acceptedPayload.evidence.officialQaDirectCandidates, []);
  assert.equal(acceptedPayload.evidence.officialQaRelated.length, 1);
  assert.equal(acceptedPayload.evidence.officialQaRelated[0].id, candidate.id);
  assert.equal(acceptedPayload.evidence.officialQaRelated[0].type, "related");
  assert.equal(acceptedPayload.evidence.officialQaRelated[0].isDirect, false);
  assert.equal(acceptedPayload.evidence.officialQaRelated[0].matchLevel, "official_qa_near");
  assert.ok(acceptedPayload.allowedEvidenceIds.includes(candidate.id));

  const rejected = buildRagRulingPromptBundle({
    userQuery: "能用不能作为融合素材的怪兽进行这次特殊召唤吗？",
    cardResolution,
    evidence: {
      ...evidence,
      officialQaDirectCandidates: [{ ...candidate, semanticSubsumptionCertified: false }],
    },
    env: directEnv,
  });
  assert.equal(rejected.warnings.includes("official_direct_focused_prompt"), false);

  const incompletePoolRejected = buildRagRulingPromptBundle({
    userQuery: "能用不能作为融合素材的怪兽进行这次特殊召唤吗？",
    cardResolution,
    evidence: {
      ...evidence,
      officialQaDirectCandidates: [{ ...candidate, subsumptionCandidatePoolComplete: false }],
    },
    env: directEnv,
  });
  assert.equal(incompletePoolRejected.warnings.includes("official_direct_focused_prompt"), false);

  const multiCardAccepted = buildRagRulingPromptBundle({
    userQuery: "两张题面卡共同形成的场景如何处理？",
    cardResolution: {
      resolvedCards: [{ id: "7403", name: "目标卡" }, { id: "7404", name: "发动卡" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      ...evidence,
      officialQaDirectCandidates: [{
        ...candidate,
        matchedQuestionCardIds: ["7403", "7404"],
        questionCardIdCount: 2,
        authoritativeSceneMatchReason: "unique_question_card_subsumption",
        semanticSubsumptionCertified: false,
        questionCardSubsumptionCertified: true,
      }],
    },
    env: directEnv,
  });
  assert.equal(multiCardAccepted.warnings.includes("official_direct_focused_prompt"), false);

  const duplicateRelated = buildRagRulingPromptBundle({
    userQuery: "两张题面卡共同形成的场景如何处理？",
    cardResolution: {
      resolvedCards: [{ id: "7403", name: "目标卡" }, { id: "7404", name: "发动卡" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      ...evidence,
      officialQaDirectCandidates: [{
        ...candidate,
        matchedQuestionCardIds: ["7403", "7404"],
        questionCardIdCount: 2,
        authoritativeSceneMatchReason: "unique_question_card_subsumption",
        semanticSubsumptionCertified: false,
        questionCardSubsumptionCertified: true,
      }],
      officialQaRelated: [{
        ...candidate,
        type: "related",
        isDirect: false,
        matchLevel: "official_qa_near",
      }],
    },
    env: directEnv,
  });
  const duplicatePayload = JSON.parse(duplicateRelated.prompt.split("本次用户问题、卡片原文与检索资料如下：\n").at(-1));
  assert.equal(duplicatePayload.evidence.officialQaRelated.filter((item) => item.id === candidate.id).length, 1);

  const extraUnboundCardRejected = buildRagRulingPromptBundle({
    userQuery: "两张题面卡共同形成的场景如何处理？",
    cardResolution: {
      resolvedCards: [{ id: "7403", name: "目标卡" }, { id: "7404", name: "发动卡" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      ...evidence,
      officialQaDirectCandidates: [{
        ...candidate,
        matchedQuestionCardIds: ["7403", "7404"],
        questionCardIdCount: 3,
        authoritativeSceneMatchReason: "unique_question_card_subsumption",
        semanticSubsumptionCertified: false,
        questionCardSubsumptionCertified: true,
      }],
    },
    env: directEnv,
  });
  assert.equal(extraUnboundCardRejected.warnings.includes("official_direct_focused_prompt"), false);
});

test("non-exact or ambiguous official candidates do not enter the authoritative fast route", () => {
  const baseEvidence = {
    officialQaDirectCandidates: [{
      id: "qa-not-exact",
      type: "official_qa",
      title: "相似问答",
      fullText: "问题？可以发动。",
      text: "问题？可以发动。",
      isDirect: true,
      matchLevel: "official_qa_near",
    }],
    officialQaRelated: [],
    faqRelated: [],
    cardTexts: [],
    userProvidedCardTexts: [],
    rawRelatedEvidence: [],
    retrievalWarnings: [],
  };
  const nearBundle = buildRagRulingPromptBundle({
    userQuery: "问题",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: baseEvidence,
  });
  assert.equal(nearBundle.warnings.includes("official_direct_focused_prompt"), false);

  const ambiguousBundle = buildRagRulingPromptBundle({
    userQuery: "问题",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [{ input: "问题卡" }] },
    evidence: {
      ...baseEvidence,
      officialQaDirectCandidates: [{
        ...baseEvidence.officialQaDirectCandidates[0],
        id: "qa-exact-but-ambiguous",
        matchLevel: "official_qa_exact",
      }],
    },
  });
  assert.equal(ambiguousBundle.warnings.includes("official_direct_focused_prompt"), false);
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

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_met_before_timeout");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createRedisFetch({ url: expectedUrl = "https://kv.example.test", token: expectedToken = "kv-token" } = {}) {
  const store = new Map();
  const commands = [];
  return {
    commands,
    store,
    fetchImpl: async (url, options = {}) => {
      assert.equal(url, expectedUrl);
      assert.equal(String(options.headers?.authorization || ""), `Bearer ${expectedToken}`);
      const command = JSON.parse(options.body || "[]");
      commands.push(command);
      const [op, key, value] = command;
      if (op === "GET") return jsonResponse({ result: store.get(key) || null });
      if (op === "EVAL") {
        const keyCount = Number(command[2] || 0);
        if (keyCount === 1) {
          const currentKey = command[3];
          const amount = Number(command[4] || 0);
          const next = Math.max(0, Number(store.get(currentKey) || 0) + amount);
          store.set(currentKey, String(next));
          return jsonResponse({ result: String(next) });
        }
        if (keyCount === 2) {
          const currentKey = command[3];
          const closedKey = command[4];
          if (String(command[1]).includes("return {'closed'")) {
            const current = Number(store.get(currentKey) || 0);
            if (store.get(closedKey) === "1") {
              return jsonResponse({ result: ["closed", String(current)] });
            }
            const next = Math.max(0, current + Number(command[5] || 0));
            store.set(currentKey, String(next));
            return jsonResponse({ result: ["reserved", String(next)] });
          }
          const limit = Number(command[5] || 0);
          const next = Math.max(Number(store.get(currentKey) || 0), limit);
          store.set(currentKey, String(next));
          store.set(closedKey, "1");
          return jsonResponse({ result: String(next) });
        }
        if (keyCount === 4) {
          const currentKey = command[3];
          const legacyKey = command[4];
          const watermarkKey = command[5];
          const closedKey = command[6];
          const legacy = Math.max(0, Number(store.get(legacyKey) || 0));
          const watermark = Math.max(0, Number(store.get(watermarkKey) || 0));
          store.set(currentKey, "0");
          store.set(watermarkKey, String(Math.max(watermark, legacy)));
          store.delete(closedKey);
          return jsonResponse({ result: ["reset", "0"] });
        }
        assert.equal(keyCount, 3);
        const currentKey = command[3];
        const legacyKey = command[4];
        const watermarkKey = command[5];
        const mode = command[6];
        const cap = Number(command[7] || 0);
        let current = Math.max(0, Number(store.get(currentKey) || 0));
        const legacy = Math.max(0, Number(store.get(legacyKey) || 0));
        const watermark = Math.max(0, Number(store.get(watermarkKey) || 0));
        if (mode === "reset") {
          current = 0;
        } else if (mode === "relay_cap") {
          if (legacy > watermark && legacy > 0) current = Math.max(current, cap);
        } else {
          current += Math.max(0, legacy - watermark);
        }
        store.set(currentKey, String(current));
        store.set(watermarkKey, String(Math.max(watermark, legacy)));
        return jsonResponse({ result: String(current) });
      }
      if (op === "SET") {
        store.set(key, value);
        return jsonResponse({ result: "OK" });
      }
      if (op === "DEL") {
        const removed = store.delete(key);
        return jsonResponse({ result: removed ? 1 : 0 });
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


test("final reasoner uses inline-linked official QA for the Stardust chain", async () => {
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
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "我方C1发动「神鹰羽毛扫」，对手C2连锁「鲜花之女男爵」的无效并破坏效果，我方是否可以C3发动「星尘龙」？",
    cards: scenarioCards,
    records: [],
    qaRecords: [qaRecord],
    env: { RAG_MODEL_TIER: "flash" },
    rulebookModelInvoker: async () => {
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
    modelInvoker: async ({ prompt }) => {
      finalPrompt = prompt;
      return JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "不能在C3发动星尘龙。羽毛扫的卡的发动被无效后不再视为场上的卡，因此男爵的处理不属于破坏场上的卡。",
      reasoning: ["星尘龙要求直接连锁会破坏场上卡片的效果，本题不满足，因此不能在C3发动。", "官方Q&A明确该场景不满足。"],
      usedCards: ["神鹰羽毛扫", "鲜花之女男爵", "星尘龙"],
      usedEvidence: [{ id: qaRecord.id, type: "faq", title: qaRecord.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.match(finalPrompt, /ygoresources-qa-11290/u);
  assert.match(answer.shortAnswer, /不能(?:在C3)?发动星尘龙/u, JSON.stringify(answer.debug.publicFinalValidation));
  assert.doesNotMatch(answer.shortAnswer, /可以在C3发动/u);
  assert.match(answer.shortAnswer, /不再视为场上的卡/u);
  assert.ok(answer.usedEvidence.some((item) => item.id === qaRecord.id));
  assert.ok(!answer.riskFlags.includes("model_answer_overridden_by_operation_legality"));
});

test("final reasoner follows cited multi-card operation order", async () => {
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
      shortAnswer: "仍要将1只怪兽放回牌组，但墨迪乌斯已经被除外，之后不能再特殊召唤它。",
      reasoning: ["先处理卡文写在前面的回牌组。", "发动源离开原位置不会自动取消不依赖其位置的前段处理。"],
      usedCards: ["无垢者 墨迪乌斯", "渊兽 玛格纳姆特"],
      usedEvidence: [
        { id: "card-text-21419", type: "card_text", title: "无垢者 墨迪乌斯 的卡片文本" },
        { id: "card-text-17762", type: "card_text", title: "渊兽 玛格纳姆特 的卡片文本" },
      ],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /仍要将1只怪兽放回牌组/u);
  assert.match(answer.shortAnswer, /不能再特殊召唤/u);
  assert.ok(answer.reasoning.some((item) => /回牌组/u.test(item)));
  assert.ok(!answer.riskFlags.includes("answer_constrained_by_exact_scenario_evidence"));
  assert.ok(answer.usedEvidence.some((item) => item.id === "card-text-21419"));
  assert.ok(answer.usedEvidence.some((item) => item.id === "card-text-17762"));
});


test("final reasoner keeps target protection separate from unaffected status", async () => {
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
      shortAnswer: "不能发动，因为淘气精灵限制对手玩家把其链接端怪兽选为效果对象；不是因为枪王不受魔法效果影响。",
      reasoning: ["对象选择限制适用于对手玩家。", "不受效果影响与不能成为对象是两个不同检查。"],
      usedCards: ["No.86 英豪冠军 击灭枪王", "超量叠光延迟"],
      usedEvidence: [{ id: elfFaq.id, type: "faq", title: elfFaq.title }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.match(answer.shortAnswer, /淘气精灵限制对手玩家/u);
  assert.match(answer.shortAnswer, /不是因为枪王不受魔法效果影响/u);
  assert.match(answer.shortAnswer, /不是因为枪王不受魔法效果影响/u);
  assert.ok(answer.usedEvidence.some((item) => item.id === elfFaq.id));
});
