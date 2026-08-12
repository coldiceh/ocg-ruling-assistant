import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOfficialQaEffectPhrases,
  searchOfficialQaEvidence,
} from "../backend/officialQaMatcher.mjs";
import { projectOfficialQaQuestion } from "../backend/officialQaQuestionProjection.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { classifyMultiEntityDecisionScope } from "../backend/evidenceQuestionTypeClassifier.mjs";

test("rich and compact QA shapes share one question identity projection", () => {
  const title = "复合官方问题的省略标题…";
  const question = [
    "复合官方问题。",
    "(A)能否除外「<<1001>>」来特殊召唤「<<1002>>」？",
    "(B)能否除外「<<1003>>」来特殊召唤「<<1002>>」？",
  ].join("\n\n");
  const answer = "两种处理分别判断。答案中的示例「<<9999>>」不属于问题身份。";
  const rich = projectOfficialQaQuestion({
    title,
    question,
    answer,
    text: `${question}\n${answer}`,
  });
  const compact = projectOfficialQaQuestion({
    title,
    text: `${question}\n${title}\n${answer}`,
  });

  assert.deepEqual(new Set(rich.principalCardIds), new Set(["1001", "1002", "1003"]));
  assert.deepEqual(new Set(compact.principalCardIds), new Set(rich.principalCardIds));
  assert.equal(rich.principalCardIds.includes("9999"), false);
  assert.equal(compact.principalCardIds.includes("9999"), false);
  assert.equal(rich.branches.length, 2);
  assert.equal(compact.branches.length, 2);
  assert.ok(rich.branches.every((branch) => branch.startsWith("复合官方问题。")));
  assert.ok(compact.branches.every((branch) => branch.startsWith("复合官方问题。")));
});

test("one compatible branch of a compound QA remains related without becoming direct", () => {
  const query = [
    "自己场上有「匿名素材甲」，是否可以将其除外来特殊召唤「匿名终端乙」？",
    "如果可以特殊召唤，之后能否发动「匿名后续丙」的效果？",
  ].join("\n");
  const record = {
    id: "anonymous-compound-qa",
    recordType: "qa",
    title: "复合手续问题",
    question: [
      "(A)能否除外「<<1001>>」来特殊召唤「<<1002>>」？",
      "(B)能否除外「<<1004>>」来特殊召唤「<<1002>>」？",
    ].join("\n\n"),
    answer: "(A)可以。(B)另行判断。",
    cardIds: ["1001", "1002", "1004"],
  };
  const resolvedCards = [
    { id: "1001", name: "匿名素材甲", aliases: ["匿名素材甲"] },
    { id: "1002", name: "匿名终端乙", aliases: ["匿名终端乙"] },
    { id: "1003", name: "匿名后续丙", aliases: ["匿名后续丙"] },
  ];
  const matches = searchOfficialQaEvidence({
    question: query,
    records: [record],
    resolvedCards,
    limit: 5,
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].branchRelevant, true);
  assert.deepEqual(new Set(matches.all[0].branchMatchedCardIds), new Set(["1001", "1002"]));
  assert.equal(matches.all[0].matchLevel, "official_qa_near");
  assert.equal(matches.exact.length, 0);
});

test("broad question-side mechanism recall keeps analogies related without supplying identity", async () => {
  const cards = [
    { id: "1001", name: "匿名起点甲", aliases: ["匿名起点甲"], effectText: "破坏场上的卡。" },
    { id: "2002", name: "匿名无效乙", aliases: ["匿名无效乙"], effectText: "使发动无效并破坏。" },
    { id: "3003", name: "匿名响应丙", aliases: ["匿名响应丙"], effectText: "破坏场上的卡的效果发动时可以发动。" },
  ];
  const records = [{
    id: "anonymous-operation-analogy",
    recordType: "qa",
    title: "匿名响应卡的发动条件",
    question: "「<<4004>>」的破坏场上卡片的效果发动时，能否连锁发动「<<3003>>」？",
    answer: "卡的发动被无效并破坏时，不视为在场上破坏；仅效果发动被无效并破坏时则另行判断。",
    cardIds: ["3003", "4004"],
  }];
  const evidence = await retrieveRagEvidence({
    userQuery: "我方C1发动「匿名起点甲」，对方C2连锁「匿名无效乙」使发动无效并破坏，我方能否C3发动「匿名响应丙」？",
    cardResolution: {
      resolvedCards: cards.map((card) => ({ ...card, input: card.name, confidence: 1 })),
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records,
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "1",
    },
  });

  assert.ok(evidence.officialQaRelated.some(
    (item) => item.id === "anonymous-operation-analogy" && item.isDirect === false,
  ));
});

test("severe multi-card identity mismatch needs question-side operation overlap", async () => {
  const cards = [
    { id: "7101", name: "匿名起点", aliases: ["匿名起点"], effectText: "破坏场上的卡。" },
    { id: "7102", name: "匿名无效", aliases: ["匿名无效"], effectText: "使发动无效并破坏。" },
    { id: "7103", name: "匿名响应", aliases: ["匿名响应"], effectText: "破坏场上的卡的效果发动时可以发动。" },
  ];
  const records = [{
    id: "anonymous-operation-overlap",
    recordType: "qa",
    question: "「<<7991>>」的破坏场上卡片的效果发动时，能否连锁发动「<<7103>>」？",
    answer: "核对卡的发动与效果发动。",
    cardIds: ["7103", "7991"],
  }, {
    id: "anonymous-identity-only-overlap",
    recordType: "qa",
    question: "同一时点「<<7992>>」与「<<7103>>」有多个效果时，应按什么顺序发动？",
    answer: "按一般顺序组成连锁。",
    cardIds: ["7103", "7992"],
  }];
  const evidence = await retrieveRagEvidence({
    userQuery: "我方C1发动「匿名起点」，对方C2连锁「匿名无效」使发动无效并破坏，我方能否C3发动「匿名响应」？",
    cardResolution: {
      resolvedCards: cards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records,
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.ok(evidence.officialQaRelated.some(
    (item) => item.id === "anonymous-operation-overlap" && item.isDirect === false,
  ));
  assert.equal(
    evidence.officialQaRelated.some((item) => item.id === "anonymous-identity-only-overlap"),
    false,
  );
});

test("card-text-derived operations cannot reintroduce a foreign multi-card scene", async () => {
  const cards = [
    {
      id: "7201",
      name: "匿名场上主体",
      aliases: ["匿名场上主体"],
      effectText: "此卡可以从手牌特殊召唤。",
    },
    {
      id: "7202",
      name: "匿名响应对象",
      aliases: ["匿名响应对象"],
      effectText: "以对手场上的怪兽为对象可以发动。使其效果无效。",
    },
    {
      id: "7203",
      name: "匿名手牌响应",
      aliases: ["匿名手牌响应"],
      effectText: "对方发动陷阱效果时可以发动。从手牌特殊召唤此卡。",
    },
  ];
  const records = [{
    id: "anonymous-foreign-trigger-order",
    recordType: "qa",
    question: [
      "发动「<<7991>>」并从墓地特殊召唤「<<7992>>」。",
      "此时「<<7202>>」「<<7993>>」「<<7994>>」的效果如何按同一时点组成连锁？",
    ].join(" "),
    answer: "按照另一组场面的诱发效果顺序组成连锁。",
    cardIds: ["7202", "7991", "7992", "7993", "7994"],
  }];
  const evidence = await retrieveRagEvidence({
    userQuery: [
      "对方场上只有「匿名场上主体」，我方以它为对象发动「匿名响应对象」。",
      "发动前场上没有其他卡，对方可以直接连锁发动手牌中「匿名手牌响应」的效果吗？",
    ].join(""),
    cardResolution: {
      resolvedCards: cards.map((card) => ({ ...card, input: card.name, confidence: 1 })),
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records,
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.equal(
    evidence.officialQaRelated.some((item) => item.id === records[0].id),
    false,
  );
  assert.equal(
    evidence.rawRelatedEvidence.some((item) => item.id === records[0].id),
    false,
  );
});

test("non-QA related records retain full-text lexical retrieval", async () => {
  const record = {
    id: "anonymous-non-qa-full-text",
    recordType: "related",
    title: "匿名补充资料",
    text: "正文独有的匿名机制短语用于说明处理顺序。",
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "请检索所提供的规则资料。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [record],
    qaRecords: [],
    ruleSearchQueries: [{ query: "正文独有的匿名机制短语" }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.ok(evidence.rawRelatedEvidence.some((item) => item.id === record.id));
});

test("structured mechanisms route related QA independently of source strings and reserve one result per mechanism", async () => {
  const publicHandRecords = Array.from({ length: 3 }, (_, index) => ({
    id: `anonymous-public-hand-${index}`,
    recordType: "qa",
    question: [
      "A card in my hand is continuously revealed.",
      "Effect A is Chain Link 1. Which revealed effect can be activated as Chain Link 2?",
    ].join(" "),
    answer: "The revealed card's effect can be activated as Chain Link 2.",
  }));
  const simultaneousRecord = {
    id: "anonymous-simultaneous-order",
    recordType: "qa",
    question: "When multiple effects can be activated at the same time, in what order do they form a Chain?",
    answer: [
      "Priority 1 effects that must be activated are placed first.",
      "Priority 2 optional effects of revealed cards follow.",
      "The player whose turn it currently is forms the Chain first.",
      "Priority 3 effects are checked afterwards.",
    ].join(" "),
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "请检索所提供的规则机制。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [...publicHandRecords, simultaneousRecord],
    qaRecords: [],
    ruleSearchQueries: [{
      query: "手札 持続的に公開 誘発効果 Chain Link 1 Chain Link 2 任意の順番",
      source: "arbitrary-source-a",
      mechanism: "deliberately-shared-caller-label",
    }, {
      query: "同一时点 多个诱发效果 按优先级组成连锁顺序 必须发动 公开选发 回合玩家",
      source: "arbitrary-source-b",
      mechanism: "deliberately-shared-caller-label",
    }],
    maxPerBucket: 2,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "2",
    },
  });

  const mechanisms = new Set(evidence.officialQaRelated.map(
    (item) => item.retrievalSignals?.mechanismAnalogue,
  ));
  const publicHandQuery = evidence.ruleSearchQueries.find(
    (item) => item.query.includes("持続的に公開"),
  );
  const simultaneousQuery = evidence.ruleSearchQueries.find(
    (item) => item.query.includes("同一时点"),
  );
  const publicHandEvidence = evidence.officialQaRelated.find(
    (item) => item.id.startsWith("anonymous-public-hand-"),
  );
  const simultaneousEvidence = evidence.officialQaRelated.find(
    (item) => item.id === "anonymous-simultaneous-order",
  );
  const mechanismSet = (item) => new Set([
    ...(item?.retrievalSignals?.mechanismAnalogues || []),
    item?.retrievalSignals?.mechanismAnalogue,
  ].filter(Boolean));

  assert.ok(publicHandQuery?.mechanism?.startsWith("semantic:"));
  assert.ok(simultaneousQuery?.mechanism?.startsWith("semantic:"));
  assert.notEqual(publicHandQuery.mechanism, simultaneousQuery.mechanism);
  assert.ok(publicHandEvidence);
  assert.ok(simultaneousEvidence);
  assert.equal(mechanismSet(publicHandEvidence).has(publicHandQuery.mechanism), true);
  assert.equal(mechanismSet(simultaneousEvidence).has(simultaneousQuery.mechanism), true);
  assert.equal(mechanisms.size, 2);
  assert.ok([...mechanisms].every((item) => item.startsWith("semantic:")));
  assert.equal(mechanisms.has("deliberately-shared-caller-label"), false);
  assert.ok(evidence.officialQaRelated.every((item) => item.isDirect === false));
  assert.equal(evidence.officialQaDirectCandidates.length, 0);
});

test("identity-scoped related QA precedes bounded mechanism analogues under anonymous remapping", async () => {
  const run = async ({ actorId, extraId, suffix }) => {
    const actorName = `匿名主体${suffix}`;
    const cards = [{
      id: actorId,
      name: actorName,
      aliases: [actorName],
      effectText: "两个诱发效果可能在同一时点发动。",
    }];
    const scopedId = `anonymous-scoped-${suffix}`;
    const records = [{
      id: scopedId,
      recordType: "qa",
      question: `「<<${actorId}>>」与「<<${extraId}>>」的效果在同一时点可以发动时，如何组成连锁？`,
      answer: "分别确认适用的发动顺序。",
      cardIds: [actorId, extraId],
    }, ...Array.from({ length: 3 }, (_, index) => ({
      id: `anonymous-mechanism-${suffix}-${index}`,
      recordType: "qa",
      question: "When multiple effects can be activated at the same time, in what order do they form a Chain?",
      answer: "Apply the general simultaneous-trigger ordering procedure.",
    }))];
    const evidence = await retrieveRagEvidence({
      userQuery: `「${actorName}」的多个效果在同一时点可以发动时，如何组成连锁？`,
      cardResolution: {
        resolvedCards: cards.map((card) => ({ ...card, input: card.name, confidence: 1 })),
        unresolvedMentions: [],
        ambiguousMentions: [],
        userProvidedCardTexts: [],
      },
      cards,
      records,
      qaRecords: [],
      ruleSearchQueries: [{
        query: "同一时点 多个诱发效果 按优先级组成连锁顺序 必须发动 公开选发 回合玩家",
        source: "anonymous-mechanism-query",
      }],
      maxPerBucket: 2,
      enableLiveOfficialQa: false,
      env: {
        RAG_LIVE_OFFICIAL_QA: "false",
        RAG_MAX_RELATED_EVIDENCE: "2",
      },
    });
    const [scoped, mechanism] = evidence.officialQaRelated;
    const scopedIdentityMatches = Number(
      (scoped?.matchedQuestionCardIds || []).length
        || scoped?.retrievalSignals?.matchedQuestionCardIdCount
        || 0,
    );
    return {
      relatedCount: evidence.officialQaRelated.length,
      scopedFirst: scoped?.id === scopedId,
      scopedIdentityMatches,
      mechanismRetained: String(mechanism?.id || "").startsWith(`anonymous-mechanism-${suffix}-`)
        && String(mechanism?.retrievalSignals?.mechanismAnalogue || "").startsWith("semantic:"),
      directFlags: evidence.officialQaRelated.map((item) => item.isDirect),
      directCount: evidence.officialQaDirectCandidates.length,
    };
  };

  const first = await run({ actorId: "5101", extraId: "5909", suffix: "甲" });
  const second = await run({ actorId: "7601", extraId: "8909", suffix: "乙" });
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    relatedCount: 2,
    scopedFirst: true,
    scopedIdentityMatches: 1,
    mechanismRetained: true,
    directFlags: [false, false],
    directCount: 0,
  });
});

test("bounded identity evidence preserves distinct question types before same-type score tails", async () => {
  const cardId = "5201";
  const cardName = "匿名类型主体";
  const ordinaryRecords = Array.from({ length: 8 }, (_, index) => ({
    id: `anonymous-ordinary-activation-${index}`,
    recordType: "qa",
    question: `「<<${cardId}>>」的效果发动时，能否发动另一个效果？`,
    answer: "分别确认发动条件。",
    cardIds: [cardId],
  }));
  const distinctRecord = {
    id: "anonymous-card-versus-effect-activation",
    recordType: "qa",
    question: `カードを発動した時と「<<${cardId}>>」の効果が発動した時では、処理に違いがありますか？`,
    answer: "分别确认卡的发动与效果发动。",
    cardIds: [cardId],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: `「${cardName}」的效果发动时，能否发动另一个效果？卡的发动与效果发动有何区别？`,
    cardResolution: {
      resolvedCards: [{ id: cardId, name: cardName, aliases: [cardName] }],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [{ id: cardId, name: cardName, aliases: [cardName] }],
    records: [...ordinaryRecords, distinctRecord],
    qaRecords: [],
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "3",
    },
  });

  assert.equal(evidence.officialQaRelated.length, 3);
  assert.ok(evidence.officialQaRelated.some(
    (item) => item.id === distinctRecord.id
      && item.questionType === "card_activation_vs_effect_activation"
      && item.isDirect === false,
  ));
});

test("identity-scoped discovery reaches past repetitive top twenty without growing final evidence", async () => {
  const run = async ({ cardId, cardName, suffix }) => {
    const repetitive = Array.from({ length: 40 }, (_, index) => ({
      id: `anonymous-repetitive-${suffix}-${String(index).padStart(2, "0")}`,
      recordType: "qa",
      question: `「<<${cardId}>>」的效果发动时，能否发动另一张卡？`,
      answer: `匿名回答 ${index}`,
      cardIds: [cardId],
    }));
    const structurallyDistinct = {
      id: `anonymous-distinct-${suffix}`,
      recordType: "qa",
      question: `カードを発動した時と「<<${cardId}>>」の効果が発動した時では、処理に違いがありますか？`,
      answer: "匿名不同结构回答",
      cardIds: [cardId],
    };
    const evidence = await retrieveRagEvidence({
      userQuery: `「${cardName}」参与的场景中，卡的发动与效果发动有何区别，能否发动响应效果？`,
      cardResolution: {
        resolvedCards: [{ id: cardId, name: cardName, aliases: [cardName] }],
        unresolvedMentions: [],
        ambiguousMentions: [],
        userProvidedCardTexts: [],
      },
      cards: [{ id: cardId, name: cardName, aliases: [cardName] }],
      records: [...repetitive, structurallyDistinct],
      qaRecords: [],
      maxPerBucket: 3,
      enableLiveOfficialQa: false,
      env: {
        RAG_LIVE_OFFICIAL_QA: "false",
        RAG_MAX_RELATED_EVIDENCE: "3",
      },
    });
    return {
      ids: evidence.officialQaRelated.map((item) => item.id.replace(`-${suffix}`, "-X")),
      count: evidence.officialQaRelated.length,
      distinctRetained: evidence.officialQaRelated.some(
        (item) => item.id === structurallyDistinct.id
          && item.questionType === "card_activation_vs_effect_activation"
          && item.isDirect === false,
      ),
      directCount: evidence.officialQaDirectCandidates.length,
    };
  };

  const first = await run({ cardId: "6101", cardName: "匿名主体甲", suffix: "a" });
  const second = await run({ cardId: "8701", cardName: "匿名主体乙", suffix: "b" });
  assert.equal(first.count, 3);
  assert.equal(first.distinctRetained, true);
  assert.equal(first.directCount, 0);
  assert.deepEqual(first, second);
});

test("mechanism discovery reserves question-side identity analogues without growing its budget", async () => {
  const currentCards = ["5301", "5302", "5303"].map((id) => ({
    id,
    name: `匿名当前卡${id}`,
    aliases: [`匿名当前卡${id}`],
  }));
  const globalRecords = Array.from({ length: 5 }, (_, index) => ({
    id: `anonymous-global-mechanism-${index}`,
    recordType: "qa",
    question: "If a card activation is negated and destroyed, is it destroyed on the field?",
    answer: "Check the activation procedure and location.",
  }));
  const identityRecords = ["5301", "5302"].map((id, index) => ({
    id: `anonymous-identity-mechanism-${index}`,
    recordType: "qa",
    question: `カードを発動した時に「<<${id}>>」の効果が発動し、そのカードを破壊する場合、フィールドで破壊されますか？`,
    answer: "Check the activation procedure and location.",
    cardIds: [id],
  }));
  const evidence = await retrieveRagEvidence({
    userQuery: "三张匿名当前卡参与连锁。请检索卡的发动被无效并破坏时的位置规则。",
    cardResolution: {
      resolvedCards: currentCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: currentCards,
    records: [...globalRecords, ...identityRecords],
    qaRecords: [],
    ruleSearchQueries: [{
      query: "卡的发动无效 效果发动无效 场上的卡 破坏",
      source: "anonymous-activation-location-rule-search-query",
    }],
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "3",
    },
  });

  assert.equal(evidence.officialQaRelated.length, 3);
  assert.equal(
    evidence.officialQaRelated.filter(
      (item) => item.id.startsWith("anonymous-identity-mechanism-"),
    ).length,
    2,
  );
  assert.ok(evidence.officialQaRelated.every((item) => item.isDirect === false));
});

test("activation-negation location analogies route by mechanism and query inference without direct authority", async () => {
  const record = {
    id: "anonymous-activation-location",
    recordType: "qa",
    question: [
      "When a Spell/Trap Card is activated, an effect that destroys a card on the field is chained.",
      "Can another effect that responds to that field destruction be activated?",
    ].join(" "),
    answer: [
      "The card activation is negated and the card is destroyed.",
      "It is not treated as destroyed on the field.",
      "If only the effect activation is negated, it is treated as destroyed on the field.",
    ].join(" "),
  };
  const run = async (ruleSearchQuery) => retrieveRagEvidence({
    userQuery: "请检索所提供的规则机制。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [record],
    qaRecords: [],
    ruleSearchQueries: [ruleSearchQuery],
    maxPerBucket: 2,
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });
  const explicit = await run({
    query: "card activation effect activation negate destroy on the field treated as",
    source: "arbitrary-source-c",
    mechanism: "caller-label-that-must-not-affect-retrieval",
  });
  const inferred = await run({
    query: "卡的发动无效并破坏后是否仍视为场上的卡；区分效果发动无效",
    source: "arbitrary-source-d",
  });
  const signature = (evidence) => ({
    relatedCount: evidence.officialQaRelated.length,
    relatedDirectFlags: evidence.officialQaRelated.map((item) => item.isDirect),
    directCount: evidence.officialQaDirectCandidates.length,
    hasQuestionSideMechanism: evidence.officialQaRelated.every(
      (item) => String(item.retrievalSignals?.mechanismAnalogue || "").startsWith("semantic:")
        && (item.retrievalSignals?.mechanismSignatureFeatures || []).length > 0,
    ),
  });

  assert.deepEqual(signature(explicit), signature(inferred));
  assert.deepEqual(signature(explicit), {
    relatedCount: 1,
    relatedDirectFlags: [false],
    directCount: 0,
    hasQuestionSideMechanism: true,
  });
  assert.ok(inferred.ruleSearchQueries.some(
    (item) => item.mechanism.startsWith("semantic:"),
  ));
});

test("answer polarity cannot change question-side mechanism recall", async () => {
  const question = "If a card activation is negated and the card is destroyed, where does that destruction occur?";
  const positiveRecord = {
    id: "anonymous-positive-predicate",
    recordType: "qa",
    question,
    answer: "It is treated as destroyed while it is on the field.",
  };
  const negativeRecord = {
    id: "anonymous-negative-predicate",
    recordType: "qa",
    question,
    answer: "It is not treated as destroyed while it is on the field.",
  };
  const run = async (record) => retrieveRagEvidence({
    userQuery: "请检索匿名规则关系。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [record],
    qaRecords: [],
    ruleSearchQueries: [{
      query: "卡的发动被无效并破坏后，将那张卡作为场上的卡被破坏处理。",
      source: "anonymous-polarity-probe",
    }],
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "3",
    },
  });

  const positive = await run(positiveRecord);
  const negative = await run(negativeRecord);
  const positiveAnalogue = positive.officialQaRelated.find(
    (item) => item.id === positiveRecord.id,
  );
  const positiveMechanism = positive.ruleSearchQueries.find(
    (item) => item.source === "anonymous-polarity-probe",
  )?.mechanism;
  const negativeMechanism = negative.ruleSearchQueries.find(
    (item) => item.source === "anonymous-polarity-probe",
  )?.mechanism;
  const negativeAnalogue = negative.officialQaRelated.find(
    (item) => item.id === negativeRecord.id,
  );

  assert.ok(positiveMechanism?.startsWith("semantic:"));
  assert.equal(negativeMechanism, positiveMechanism);
  assert.equal(positive.debug.officialMechanismAnalogueCount, 1);
  assert.equal(positiveAnalogue?.retrievalSignals?.mechanismAnalogue, positiveMechanism);
  assert.equal(positive.officialQaDirectCandidates.length, 0);
  assert.equal(negative.debug.officialMechanismAnalogueCount, 1);
  assert.equal(negativeAnalogue?.retrievalSignals?.mechanismAnalogue, negativeMechanism);
  assert.deepEqual(
    negativeAnalogue?.retrievalSignals?.mechanismSignatureFeatures,
    positiveAnalogue?.retrievalSignals?.mechanismSignatureFeatures,
  );
  assert.equal(negative.officialQaDirectCandidates.length, 0);
});

test("anonymous corpus growth and near-duplicates cannot displace exact mechanism representatives", async () => {
  const preciseOrdering = {
    id: "anonymous-precise-ordering",
    recordType: "qa",
    question: "When multiple optional trigger effects activate at the same time, in what order do the turn player and opponent build Chain Link 1 and Chain Link 2?",
    answer: "Apply the simultaneous-trigger ordering procedure.",
  };
  const preciseNegation = {
    id: "anonymous-precise-negation",
    recordType: "qa",
    question: "If a card activation is negated and that card is destroyed, is it treated as destroyed on the field?",
    answer: "Apply the activation-negation location rule.",
  };
  const noisyOrdering = Array.from({ length: 18 }, (_, index) => ({
    id: `anonymous-ordering-noise-${String(index).padStart(2, "0")}`,
    recordType: "qa",
    question: "When an optional effect can activate, can it form a Chain?",
    answer: "Check its activation conditions.",
  }));
  const multiLabelNoise = Array.from({ length: 9 }, (_, index) => ({
    id: `anonymous-multi-label-noise-${String(index).padStart(2, "0")}`,
    recordType: "qa",
    question: "When several effects activate, can an activation be negated and a card on the field be destroyed in the same Chain?",
    answer: "Check each operation separately.",
  }));
  const run = async (records) => retrieveRagEvidence({
    userQuery: "请检索两个匿名规则机制。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records,
    qaRecords: [],
    ruleSearchQueries: [{
      query: "同一时点多个选发诱发效果由回合玩家和对方按顺序组成C1、C2",
      source: "anonymous-ordering-query",
    }, {
      query: "卡的发动被无效并破坏后是否视为在场上被破坏",
      source: "anonymous-negation-query",
    }],
    maxPerBucket: 4,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "4",
    },
  });

  const baseline = await run([preciseOrdering, preciseNegation]);
  const expanded = await run([
    ...noisyOrdering,
    ...multiLabelNoise,
    preciseOrdering,
    preciseNegation,
  ]);
  const selectedIds = (evidence) => new Set(
    evidence.officialQaRelated.map((item) => item.id),
  );

  assert.equal(selectedIds(baseline).has(preciseOrdering.id), true);
  assert.equal(selectedIds(baseline).has(preciseNegation.id), true);
  assert.equal(selectedIds(expanded).has(preciseOrdering.id), true);
  assert.equal(selectedIds(expanded).has(preciseNegation.id), true);
  assert.equal(expanded.officialQaDirectCandidates.length, 0);
});

test("multi-identity best match leaves the next independent representative available", async () => {
  const cards = ["7101", "7102"].map((id) => ({
    id,
    name: `匿名独立主体${id}`,
    aliases: [`匿名独立主体${id}`],
  }));
  const records = [{
    id: "anonymous-shared-best",
    recordType: "qa",
    question: "「<<7101>>」与「<<7102>>」的效果在同一时点发动时，如何组成连锁？",
    answer: "按诱发效果顺序组成连锁。",
    cardIds: ["7101", "7102"],
  }, {
    id: "anonymous-independent-first",
    recordType: "qa",
    question: "「<<7101>>」的诱发效果在同一时点发动时如何排列？",
    answer: "按诱发效果顺序组成连锁。",
    cardIds: ["7101"],
  }, {
    id: "anonymous-independent-second",
    recordType: "qa",
    question: "「<<7102>>」的诱发效果在同一时点发动时如何排列？",
    answer: "按诱发效果顺序组成连锁。",
    cardIds: ["7102"],
  }];
  const evidence = await retrieveRagEvidence({
    userQuery: "两个匿名主体的诱发效果在同一时点发动时如何组成连锁？",
    cardResolution: {
      resolvedCards: cards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records,
    qaRecords: [],
    ruleSearchQueries: [{
      query: "同一时点多个诱发效果组成连锁顺序",
      source: "anonymous-shared-identity-query",
    }],
    maxPerBucket: 2,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "2",
    },
  });

  const ids = evidence.officialQaRelated.map((item) => item.id);
  assert.equal(ids.includes("anonymous-shared-best"), true);
  assert.equal(ids.some((id) => id.startsWith("anonymous-independent-")), true);
});

test("bounded global mechanism analogues retain a resolved question identity without becoming scoped", async () => {
  const card = { id: "7301", name: "匿名引用主体", aliases: ["匿名引用主体"] };
  const identityAnalogue = {
    id: "anonymous-global-identity-analogue",
    recordType: "qa",
    question: "「<<7301>>」的卡的发动被无效并破坏时，是否视为在场上被破坏？",
    answer: "按发动无效与破坏位置规则处理。",
    cardIds: ["7301"],
  };
  const globalNoise = Array.from({ length: 20 }, (_, index) => ({
    id: `anonymous-global-negation-noise-${index}`,
    recordType: "qa",
    question: "卡的发动被无效并破坏时，是否视为在场上被破坏？",
    answer: "按发动无效与破坏位置规则处理。",
  }));
  const evidence = await retrieveRagEvidence({
    userQuery: "匿名引用主体参与连锁，请检索发动无效后的破坏位置规则。",
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [card],
    records: [...globalNoise, identityAnalogue],
    qaRecords: [],
    ruleSearchQueries: [{
      query: "卡的发动被无效并破坏后是否视为在场上被破坏",
      source: "anonymous-global-identity-query",
    }],
    maxPerBucket: 4,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "4",
    },
  });

  const retained = evidence.officialQaRelated.find(
    (item) => item.id === identityAnalogue.id,
  );
  assert.ok(retained);
  assert.equal(retained.isDirect, false);
  assert.equal(evidence.officialQaRelated.length, 4);
});

test("foreign question identities cannot consume resolved-identity reserve slots", async () => {
  const card = { id: "7401", name: "匿名当前主体", aliases: ["匿名当前主体"] };
  const current = {
    id: "anonymous-current-identity-analogue",
    recordType: "qa",
    question: "「<<7401>>」的卡的发动被无效并破坏时是否视为在场上被破坏？",
    answer: "按发动无效规则处理。",
    cardIds: ["7401"],
  };
  const foreign = Array.from({ length: 12 }, (_, index) => ({
    id: `anonymous-foreign-identity-${index}`,
    recordType: "qa",
    question: `「<<${7500 + index}>>」的卡的发动被无效并破坏时是否视为在场上被破坏？`,
    answer: "按发动无效规则处理。",
    cardIds: [String(7500 + index)],
  }));
  const evidence = await retrieveRagEvidence({
    userQuery: "匿名当前主体参与连锁，请检索发动无效后的破坏位置规则。",
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [card],
    records: [...foreign, current],
    qaRecords: [],
    ruleSearchQueries: [{
      query: "卡的发动被无效并破坏后是否视为在场上被破坏",
      source: "anonymous-foreign-identity-query",
    }],
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "3" },
  });

  assert.equal(evidence.officialQaRelated.some((item) => item.id === current.id), true);
  assert.equal(evidence.officialQaRelated.length, 3);
});

test("answer-only identities and keywords cannot change final related retrieval", async () => {
  const cards = [{
    id: "6201",
    name: "匿名查询主体",
    aliases: ["匿名查询主体"],
  }];
  const records = [{
    id: "anonymous-question-match",
    recordType: "qa",
    question: "「<<6201>>」的效果处理时，是否仍然适用？",
    answer: "完整答案标记 ALPHA；另举「<<6991>>」为例。",
    cardIds: ["6201", "6991"],
  }, {
    id: "anonymous-answer-only-match",
    recordType: "qa",
    question: "「<<6202>>」的攻击力如何计算？",
    answer: "答案才提到「<<6201>>」以及效果处理时是否仍然适用。",
    cardIds: ["6201", "6202"],
  }];
  const run = async (answers) => {
    const evidence = await retrieveRagEvidence({
      userQuery: "「匿名查询主体」的效果处理时是否仍然适用？",
      cardResolution: {
        resolvedCards: cards,
        unresolvedMentions: [],
        ambiguousMentions: [],
        userProvidedCardTexts: [],
      },
      cards,
      records: records.map((record, index) => ({ ...record, answer: answers[index] })),
      qaRecords: [],
      enableLiveOfficialQa: false,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
    });
    return {
      ids: evidence.officialQaRelated.map((item) => item.id),
      selected: evidence.officialQaRelated.find((item) => item.id === "anonymous-question-match"),
    };
  };

  const first = await run(records.map((record) => record.answer));
  const second = await run([
    "完整答案标记 BETA；与查询机制完全无关。",
    "答案改写为极性相反，并加入「<<6201>>」及效果处理关键词。",
  ]);
  assert.deepEqual(first.ids, second.ids);
  assert.ok(first.ids.includes("anonymous-question-match"));
  assert.equal(first.ids.includes("anonymous-answer-only-match"), false);
  assert.match(first.selected.answer, /完整答案标记 ALPHA/u);
});

test("answer-side operation words cannot create matcher coverage", () => {
  const baseRecord = {
    recordType: "qa",
    question: "「<<2051>>」的效果发动时，能否发动「<<2052>>」的效果？",
    cardIds: ["2051", "2052"],
  };
  const resolvedCards = [
    { id: "2051", name: "匿名发动甲", aliases: ["匿名发动甲"] },
    { id: "2052", name: "匿名响应乙", aliases: ["匿名响应乙"] },
  ];
  const run = (answer) => searchOfficialQaEvidence({
    question: "「匿名发动甲」的效果发动并破坏卡时，能否发动「匿名响应乙」的效果？",
    records: [{ ...baseRecord, id: `anonymous-${answer.length}`, answer }],
    resolvedCards,
    limit: 5,
  }).all[0];

  const answerMentionsDestruction = run("那个效果会破坏场上的卡。 ");
  const answerDoesNotMentionDestruction = run("那个效果正常处理。 ");

  assert.deepEqual(
    answerMentionsDestruction.matchedOperationFamilies,
    answerDoesNotMentionDestruction.matchedOperationFamilies,
  );
  assert.equal(answerMentionsDestruction.matchedOperationFamilies.includes("destroy"), false);
  assert.equal(answerMentionsDestruction.operationSemanticQueryCoverage, 0);
});

test("a question mark and card id in the answer cannot contaminate compact question identity", () => {
  const title = "匿名紧凑问题的省略标题…";
  const projection = projectOfficialQaQuestion({
    title,
    text: [
      "能否发动「<<1101>>」的效果？",
      title,
      "如果答案示例改为「<<9909>>」呢？仍按问题中的场景判断。",
    ].join("\n"),
  });

  assert.deepEqual(projection.principalCardIds, ["1101"]);
  assert.match(projection.answerText, /<<9909>>/u);
});

test("negation aliases count as one operation family instead of independent evidence", () => {
  const matches = searchOfficialQaEvidence({
    question: "对方发动「匿名无效甲」使发动无效时，是否还能发动？",
    records: [{
      id: "anonymous-negation-alias",
      recordType: "qa",
      title: "匿名无效手续",
      question: "「<<2101>>」使卡的发动无效时，能否发动「<<2102>>」？",
      answer: "仅判断该次无效处理。",
      cardIds: ["2101", "2102"],
    }],
    resolvedCards: [
      { id: "2101", name: "匿名无效甲", aliases: ["匿名无效甲"] },
      { id: "2102", name: "匿名响应乙", aliases: ["匿名响应乙"] },
    ],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.deepEqual(matches.all[0].matchedOperationFamilies, ["negate"]);
  assert.deepEqual(matches.all[0].distinctiveOperationSemanticHits, ["negate"]);
  assert.equal(
    matches.semanticMatchingConcepts.filter(
      (concept) => ["negate", "negate_activation", "effect_negation"].includes(concept),
    ).length,
    1,
  );
});

test("all operation aliases share one semantic counting unit", () => {
  const negation = searchOfficialQaEvidence({
    question: "这个效果的发动无效时如何处理？",
    records: [],
  }).semanticMatchingConcepts;
  const banishing = searchOfficialQaEvidence({
    question: "将该卡暂时除外，之后回到场上时如何处理？",
    records: [],
  }).semanticMatchingConcepts;

  assert.equal(
    negation.filter((concept) => concept === "negate").length,
    1,
  );
  assert.equal(
    banishing.filter((concept) => concept === "banish").length,
    1,
  );
});

test("Japanese activation noun and clause forms share question-side phrases", () => {
  assert.deepEqual(
    extractOfficialQaEffectPhrases("カードの発動にチェーンして効果の発動を無効にできますか？"),
    extractOfficialQaEffectPhrases("カードを発動した時にチェーンして効果が発動した時、無効にできますか？"),
  );
  assert.deepEqual(
    extractOfficialQaEffectPhrases("カードを発動した時にチェーンして効果が発動した時、無効にできますか？"),
    ["card_activation", "effect_activation"],
  );
});

test("Japanese card-versus-effect activation clauses remain related to activation-legality questions", () => {
  const match = searchOfficialQaEvidence({
    question: "「匿名破坏甲」的效果发动并破坏卡时，能否发动「匿名响应乙」？",
    records: [{
      id: "anonymous-japanese-activation-clauses",
      recordType: "qa",
      question: [
        "魔法・罠カードを発動した時にチェーンして「<<2061>>」の効果が発動した時、",
        "「<<2062>>」の効果は発動できますか？",
      ].join(""),
      answer: "各自の条件を確認します。",
      cardIds: ["2061", "2062"],
    }],
    resolvedCards: [
      { id: "2061", name: "匿名破坏甲", aliases: ["匿名破坏甲"] },
      { id: "2062", name: "匿名响应乙", aliases: ["匿名响应乙"] },
    ],
    limit: 5,
  }).all[0];

  assert.ok(match);
  assert.equal(match.questionType, "card_activation_vs_effect_activation");
  assert.equal(match.typeCompatible, true);
  assert.equal(match.authoritativeSceneMatch, false);
  assert.notEqual(match.matchLevel, "official_qa_exact");
});

test("answer-only timing phrases cannot complete direct scene authority", () => {
  const matches = searchOfficialQaEvidence({
    question: "伤害计算时能否发动「匿名时点卡」？",
    records: [{
      id: "anonymous-answer-only-timing",
      recordType: "qa",
      title: "匿名效果能否发动",
      question: "能否发动「<<2301>>」的效果？",
      answer: "答案中的示例发生在伤害计算时。",
      cardIds: ["2301"],
    }],
    resolvedCards: [{ id: "2301", name: "匿名时点卡", aliases: ["匿名时点卡"] }],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.ok(matches.all[0].querySceneQualifiers.includes("damage_calculation"));
  assert.equal(matches.all[0].evidenceSceneQualifiers.includes("damage_calculation"), false);
  assert.equal(matches.all[0].sceneQualifiersCompatible, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("an unbounded legacy body cannot be reinterpreted as question-side semantics", () => {
  const matches = searchOfficialQaEvidence({
    question: "「匿名甲」的发动被无效并破坏时，「匿名乙」能否继续处理？",
    records: [{
      id: "anonymous-unbounded-legacy-body",
      recordType: "qa",
      text: "答案侧说明发动被无效并破坏后的处理，并举出「<<2401>>」与「<<2402>>」作为示例。",
      cardIds: ["2401", "2402"],
    }],
    resolvedCards: [
      { id: "2401", name: "匿名甲", aliases: ["匿名甲"] },
      { id: "2402", name: "匿名乙", aliases: ["匿名乙"] },
    ],
    limit: 5,
  });

  assert.equal(matches.all.length, 0);
  assert.equal(matches.exact.length, 0);
});

test("identities from separate branches cannot be combined into a synthetic supporting branch", () => {
  const matches = searchOfficialQaEvidence({
    question: [
      "「匿名分支甲」的破坏效果发动时，",
      "能否连锁发动「匿名分支丁」使该发动无效并破坏？",
    ].join(""),
    records: [{
      id: "anonymous-disjoint-branches",
      recordType: "qa",
      title: "两个互不相同的匿名分支",
      question: [
        "(A)「<<3101>>」的破坏效果发动时，能否连锁发动其他效果？",
        "(B)其他效果发动时，能否连锁发动「<<3104>>」使该发动无效并破坏？",
      ].join("\n\n"),
      answer: "两个分支分别判断。",
      cardIds: ["3101", "3104"],
    }],
    resolvedCards: [
      { id: "3101", name: "匿名分支甲", aliases: ["匿名分支甲"] },
      { id: "3104", name: "匿名分支丁", aliases: ["匿名分支丁"] },
    ],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].exactQuestionCardIdSet, true);
  assert.equal(matches.all[0].queryIdentityContainedInOneBranch, false);
  assert.equal(matches.all[0].exactQuestionBranchIdSet, false);
  assert.equal(matches.all[0].branchRelevant, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("an exact full compound question stays direct rather than being reduced to one branch", () => {
  const question = [
    "(A)能否除外「<<4101>>」来特殊召唤「<<4102>>」？",
    "(B)能否除外「<<4103>>」来特殊召唤「<<4102>>」？",
  ].join("\n\n");
  const matches = searchOfficialQaEvidence({
    question,
    records: [{
      id: "anonymous-full-compound",
      recordType: "qa",
      title: "完整匿名复合问题",
      question,
      answer: "两个分支分别判断。",
      cardIds: ["4101", "4102", "4103"],
    }],
    resolvedCards: ["4101", "4102", "4103"].map((id) => ({
      id,
      name: `匿名卡${id}`,
      aliases: [`匿名卡${id}`],
    })),
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].branchRelevant, false);
  assert.equal(matches.exact.length, 1);
});

test("exact QA overflow is downgraded and isolated when the direct budget is one", async () => {
  const question = "在匿名手续中，能否发动这次效果？";
  const records = [{
    id: "anonymous-exact-budget-a",
    recordType: "qa",
    question,
    answer: "匿名结论一。",
  }, {
    id: "anonymous-exact-budget-b",
    recordType: "qa",
    question,
    answer: "匿名结论二。",
  }];
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records,
    qaRecords: [],
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_OFFICIAL_QA: "1",
      RAG_MAX_RELATED_EVIDENCE: "3",
    },
  });

  const directIds = new Set(evidence.officialQaDirectCandidates.map((item) => item.id));
  const relatedIds = new Set(evidence.officialQaRelated.map((item) => item.id));
  assert.equal(evidence.officialQaDirectCandidates.length, 1);
  assert.equal(evidence.officialQaRelated.length, 1);
  assert.deepEqual(
    new Set([...directIds, ...relatedIds]),
    new Set(records.map((record) => record.id)),
  );
  assert.ok([...directIds].every((id) => !relatedIds.has(id)));
  assert.ok(evidence.officialQaDirectCandidates.every((item) => (
    item.isDirect === true
    && item.matchLevel === "official_qa_exact"
    && item.authoritativeSceneMatch === true
  )));
  assert.ok(evidence.officialQaRelated.every((item) => (
    item.isDirect === false
    && item.matchLevel === "official_qa_near"
    && item.authoritativeSceneMatch === false
  )));
});

test("branch matching is invariant under anonymous name and id remapping", () => {
  const run = ({ materialId, terminalId, unrelatedId, suffix }) => {
    const materialName = `匿名素材${suffix}`;
    const terminalName = `匿名终端${suffix}`;
    const followUpName = `匿名后续${suffix}`;
    return searchOfficialQaEvidence({
      question: [
        `自己场上有「${materialName}」，是否可以将其除外来特殊召唤「${terminalName}」？`,
        `如果可以特殊召唤，之后能否发动「${followUpName}」的效果？`,
      ].join("\n"),
      records: [{
        id: `anonymous-remap-${suffix}`,
        recordType: "qa",
        title: `匿名映射${suffix}`,
        question: [
          `(A)能否除外「<<${materialId}>>」来特殊召唤「<<${terminalId}>>」？`,
          `(B)能否除外「<<${unrelatedId}>>」来特殊召唤「<<${terminalId}>>」？`,
        ].join("\n\n"),
        answer: "两个分支分别判断。",
        cardIds: [materialId, terminalId, unrelatedId],
      }],
      resolvedCards: [
        { id: materialId, name: materialName, aliases: [materialName] },
        { id: terminalId, name: terminalName, aliases: [terminalName] },
        { id: String(Number(unrelatedId) + 1), name: followUpName, aliases: [followUpName] },
      ],
      limit: 5,
    });
  };

  const first = run({ materialId: "5101", terminalId: "5102", unrelatedId: "5104", suffix: "甲" });
  const second = run({ materialId: "8107", terminalId: "8209", unrelatedId: "8401", suffix: "乙" });
  const signature = (matches) => ({
    branchRelevant: matches.all[0].branchRelevant,
    matchLevel: matches.all[0].matchLevel,
    matchedIdentityCount: matches.all[0].branchMatchedCardIds.length,
    authoritativeSceneMatch: matches.all[0].authoritativeSceneMatch,
    authoritativeSceneMatchReason: matches.all[0].authoritativeSceneMatchReason,
    exactCount: matches.exact.length,
  });

  assert.deepEqual(signature(first), signature(second));
  assert.deepEqual(signature(first), {
    branchRelevant: true,
    matchLevel: "official_qa_near",
    matchedIdentityCount: 2,
    authoritativeSceneMatch: false,
    authoritativeSceneMatchReason: "",
    exactCount: 0,
  });
});

test("a single decision selects branch B regardless of compound source order", () => {
  const targetMaterial = { id: "9102", name: "匿名目标素材" };
  const otherMaterial = { id: "9101", name: "匿名其他素材" };
  const terminal = { id: "9103", name: "匿名共同终端" };
  const resolvedCards = [targetMaterial, terminal].map((card) => ({
    ...card,
    aliases: [card.name],
  }));
  const targetBranch = `自己场上存在「<<${targetMaterial.id}>>」时，能否特殊召唤「<<${terminal.id}>>」？`;
  const otherBranch = `自己场上存在「<<${otherMaterial.id}>>」时，能否特殊召唤「<<${terminal.id}>>」？`;
  const run = (branches, id) => searchOfficialQaEvidence({
    question: `自己场上存在「${targetMaterial.name}」时，能否特殊召唤「${terminal.name}」？`,
    records: [{
      id,
      recordType: "qa",
      title: "匿名双分支手续",
      question: branches.map(
        (branch, index) => `(${String.fromCharCode(65 + index)})${branch}`,
      ).join("\n\n"),
      answer: "两个分支分别判断。",
      cardIds: [otherMaterial.id, targetMaterial.id, terminal.id],
    }],
    resolvedCards,
    limit: 5,
  });

  const targetSecond = run([otherBranch, targetBranch], "anonymous-target-second");
  const targetFirst = run([targetBranch, otherBranch], "anonymous-target-first");
  const signature = (matches) => ({
    queryIsCompound: matches.multiBranchQuery,
    branchRelevant: matches.all[0]?.branchRelevant,
    branchIndex: matches.all[0]?.supportingQuestionBranchIndex,
    branchCardIds: new Set(matches.all[0]?.supportingQuestionBranchCardIds || []),
    identityComplete: matches.all[0]?.supportingQuestionBranchIdentityComplete,
    exactCount: matches.exact.length,
  });

  assert.deepEqual(signature(targetSecond), {
    queryIsCompound: false,
    branchRelevant: true,
    branchIndex: 1,
    branchCardIds: new Set([targetMaterial.id, terminal.id]),
    identityComplete: true,
    exactCount: 0,
  });
  assert.deepEqual(signature(targetFirst), {
    ...signature(targetSecond),
    branchIndex: 0,
  });
});

test("equally supported compound branches fail closed instead of selecting by source order", () => {
  const cards = [{ id: "9201", name: "匿名并列素材甲" }, {
    id: "9202",
    name: "匿名并列素材乙",
  }, {
    id: "9203",
    name: "匿名并列终端",
  }].map((card) => ({ ...card, aliases: [card.name] }));
  const matches = searchOfficialQaEvidence({
    question: [
      `自己场上同时存在「${cards[0].name}」与「${cards[1].name}」时，`,
      `能否特殊召唤「${cards[2].name}」？`,
    ].join(""),
    records: [{
      id: "anonymous-equal-branches",
      recordType: "qa",
      title: "匿名并列分支",
      question: [
        `(A)自己场上存在「<<${cards[0].id}>>」时，能否特殊召唤「<<${cards[2].id}>>」？`,
        `(B)自己场上存在「<<${cards[1].id}>>」时，能否特殊召唤「<<${cards[2].id}>>」？`,
      ].join("\n\n"),
      answer: "两个分支分别判断。",
      cardIds: cards.map((card) => card.id),
    }],
    resolvedCards: cards,
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].supportingQuestionBranchIndex, null);
  assert.deepEqual(matches.all[0].supportingQuestionBranchCardIds, []);
  assert.equal(matches.all[0].supportingQuestionBranchIdentityComplete, false);
  assert.equal(matches.all[0].branchRelevant, false);
  assert.equal(matches.exact.length, 0);
});

test("a branch with a third unresolved identity is never identity-complete", () => {
  const resolvedCards = [{ id: "9301", name: "匿名已解析素材" }, {
    id: "9303",
    name: "匿名已解析终端",
  }].map((card) => ({ ...card, aliases: [card.name] }));
  const matches = searchOfficialQaEvidence({
    question: [
      `自己场上存在「${resolvedCards[0].name}」与「匿名未解析协作者」时，`,
      `能否特殊召唤「${resolvedCards[1].name}」？`,
    ].join(""),
    records: [{
      id: "anonymous-incomplete-branch-identity",
      recordType: "qa",
      title: "匿名三身份分支",
      question: [
        "(A)自己场上存在「<<9301>>」与「<<9302>>」时，能否特殊召唤「<<9303>>」？",
        "(B)自己场上存在「<<9304>>」时，能否特殊召唤「<<9303>>」？",
      ].join("\n\n"),
      answer: "两个分支分别判断。",
      cardIds: ["9301", "9302", "9303", "9304"],
    }],
    resolvedCards,
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.deepEqual(
    new Set(matches.all[0].matchedQuestionCardIds),
    new Set(resolvedCards.map((card) => card.id)),
  );
  assert.equal(matches.all[0].queryIdentityContainedInOneBranch, true);
  assert.equal(matches.all[0].exactQuestionBranchIdSet, false);
  assert.equal(matches.all[0].supportingQuestionBranchIndex, null);
  assert.deepEqual(matches.all[0].supportingQuestionBranchCardIds, []);
  assert.equal(matches.all[0].supportingQuestionBranchIdentityComplete, false);
  assert.equal(matches.all[0].branchRelevant, false);
  assert.equal(matches.exact.length, 0);
});

test("selected compound branch survives downstream identity filtering under remapping", async () => {
  const run = async ({ materialId, terminalId, otherBranchId, suffix }) => {
    const materialName = `匿名手续素材${suffix}`;
    const terminalName = `匿名手续终端${suffix}`;
    const followUpOneName = `匿名后续一${suffix}`;
    const followUpTwoName = `匿名后续二${suffix}`;
    const cards = [{ id: materialId, name: materialName }, {
      id: terminalId,
      name: terminalName,
    }, {
      id: `${materialId}7`,
      name: followUpOneName,
    }, {
      id: `${terminalId}8`,
      name: followUpTwoName,
    }].map((card) => ({
      ...card,
      aliases: [card.name],
      effectText: "匿名效果文本。",
    }));
    const query = [
      `自己场上存在「${materialName}」时，能否特殊召唤「${terminalName}」？`,
      `如果可以，之后「${followUpOneName}」与「${followUpTwoName}」的效果如何组成连锁？`,
    ].join("\n");
    const record = {
      id: `anonymous-compound-downstream-${suffix}`,
      recordType: "qa",
      title: "匿名复合手续",
      question: [
        `(A)自己场上存在「<<${materialId}>>」时，能否特殊召唤「<<${terminalId}>>」？`,
        `(B)自己场上存在「<<${otherBranchId}>>」时，能否特殊召唤「<<${terminalId}>>」？`,
      ].join("\n\n"),
      answer: "两个分支分别判断。",
      cardIds: [materialId, terminalId, otherBranchId],
    };
    return retrieveRagEvidence({
      userQuery: query,
      cardResolution: {
        resolvedCards: cards.map((card) => ({ ...card, input: card.name, confidence: 1 })),
        unresolvedMentions: [],
        ambiguousMentions: [],
        userProvidedCardTexts: [],
      },
      cards,
      records: [record],
      qaRecords: [],
      enableLiveOfficialQa: false,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
    });
  };
  const first = await run({ materialId: "7301", terminalId: "7302", otherBranchId: "7304", suffix: "甲" });
  const second = await run({ materialId: "8601", terminalId: "8702", otherBranchId: "8904", suffix: "乙" });
  const signature = (evidence) => ({
    relatedCount: evidence.officialQaRelated.length,
    directCount: evidence.officialQaDirectCandidates.length,
    branchRelevant: evidence.officialQaRelated[0]?.branchRelevant,
    branchMatchedCount: evidence.officialQaRelated[0]?.branchMatchedCardIds.length,
    selectedBranchCount: evidence.officialQaRelated[0]?.supportingQuestionBranchCardIds.length,
    selectedBranchUnmatchedCount: evidence.officialQaRelated[0]?.supportingQuestionBranchUnmatchedCardIds.length,
    matchLevel: evidence.officialQaRelated[0]?.matchLevel,
    isDirect: evidence.officialQaRelated[0]?.isDirect,
  });

  assert.deepEqual(signature(first), signature(second));
  assert.deepEqual(signature(first), {
    relatedCount: 1,
    directCount: 0,
    branchRelevant: true,
    branchMatchedCount: 2,
    selectedBranchCount: 2,
    selectedBranchUnmatchedCount: 0,
    matchLevel: "official_qa_near",
    isDirect: false,
  });
});

test("multiple decisions about one card do not require multiple-entity coverage", () => {
  const scope = classifyMultiEntityDecisionScope(
    "「匿名同一卡」的第一个效果能否发动？如果可以，之后第二个效果能否发动？",
  );

  assert.equal(scope.multiBranch, true);
  assert.equal(scope.multiDecision, true);
  assert.equal(scope.multiEntity, false);
  assert.equal(scope.requiresPerEntityCoverage, false);
});

test("a hierarchical follow-up asking which effects and chain order is a second decision", () => {
  const scope = classifyMultiEntityDecisionScope([
    "是否可以执行记述的特殊召唤？",
    "如果可以特殊召唤，之后可以发动哪些效果，连锁如何组成？",
  ].join(""));

  assert.equal(scope.multiBranch, true);
  assert.equal(scope.multiDecision, true);
  assert.equal(scope.requiresPerEntityCoverage, false);
});

test("a natural title phrase inside a question is not treated as an answer boundary", () => {
  const title = "匿名术语构成的较长标题";
  const projection = projectOfficialQaQuestion({
    title,
    text: `题目中自然提到${title}，并询问「<<6101>>」能否发动？`,
  });

  assert.deepEqual(projection.principalCardIds, ["6101"]);
  assert.equal(projection.answerText, "");
});

test("a shortened title cannot impersonate the complete compound question", () => {
  const title = "两张匿名卡分别能否发动各自效果的省略标题…";
  const matches = searchOfficialQaEvidence({
    question: title,
    records: [{
      id: "anonymous-title-only",
      recordType: "qa",
      title,
      question: [
        "(A)在第一个场景中，能否发动「<<7101>>」的效果？",
        "(B)在另一个场景中，能否发动「<<7102>>」的效果？",
      ].join("\n\n"),
      answer: "两个场景分别判断。",
      cardIds: ["7101", "7102"],
    }],
    resolvedCards: ["7101", "7102"].map((id) => ({
      id,
      name: `匿名卡${id}`,
      aliases: [`匿名卡${id}`],
    })),
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].rawSceneMatch, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("an identity mentioned only in the answer cannot authorize a direct match", () => {
  const question = "在当前场景中能否发动这个效果？";
  const matches = searchOfficialQaEvidence({
    question,
    records: [{
      id: "anonymous-answer-only-identity",
      recordType: "qa",
      title: question,
      question,
      answer: "答案示例提到「<<7201>>」，但问题正文没有该身份。",
      cardIds: ["7201"],
    }],
    resolvedCards: [{ id: "7201", name: "匿名答案卡", aliases: ["匿名答案卡"] }],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].identityCompatibleForExact, false);
  assert.equal(matches.all[0].rawSceneMatch, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});
