import assert from "node:assert/strict";
import test from "node:test";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

function syntheticCard(id, name, effectText) {
  return {
    id,
    cardId: id,
    name,
    cnName: name,
    aliases: [name],
    effectText,
    text: effectText,
  };
}

test("a cross-card official mechanism QA is retained as related-only evidence", async () => {
  const current = syntheticCard(
    "41001",
    "匿名耐性怪兽甲",
    "这张卡不受其他卡的效果影响。",
  );
  const scopedDecoys = Array.from({ length: 6 }, (_unused, index) => ({
    id: `qa-scoped-decoy-${index}`,
    recordType: "qa",
    question: `「<<41001>>」被召唤时可以发动另一效果吗？资料 ${index}`,
    rawDetailedQuestion: `「<<41001>>」被召唤时可以发动另一效果吗？资料 ${index}`,
    answer: "这是只涉及召唤时点的资料。",
    cardIds: ["41001"],
  }));
  const crossCardMechanism = {
    id: "qa-cross-card-mechanism",
    recordType: "qa",
    question: "不受其他卡效果影响的攻击怪兽进行攻击时，可以发动使那次攻击无效的效果吗？",
    rawDetailedQuestion: "「<<42001>>」不受其他卡效果影响并进行攻击。发动「<<42002>>」使那次攻击无效时，处理会怎样？",
    answer: "该官方问答分别说明发动是否合法以及处理是否适用。",
    cardIds: ["42001", "42002"],
  };

  const evidence = await retrieveRagEvidence({
    userQuery: "不受其他卡效果影响的「匿名耐性怪兽甲」攻击时，对方能否发动使攻击无效的效果，处理时会怎样？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [...scopedDecoys, crossCardMechanism],
    ruleSearchQueries: [{
      query: "不受卡片效果影响的攻击怪兽 使攻击无效 发动条件 效果处理",
      reason: "检索作用实体与发动/处理差异",
      confidence: "high",
    }],
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "6",
    },
  });

  const related = evidence.officialQaRelated.find((item) => item.id === crossCardMechanism.id);
  assert.ok(
    related,
    `the complete official QA pool should supply a matching cross-card mechanism: ${JSON.stringify({
      relatedIds: evidence.officialQaRelated.map((item) => item.id),
      warnings: evidence.retrievalWarnings,
      debug: evidence.debug,
    })}`,
  );
  assert.equal(related.official, true);
  assert.equal(related.type, "related");
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext.scope, "cross_card_official_mechanism");
  assert.equal(related.retrievalContext.relatedOnly, true);
  assert.ok(evidence.officialQaDirectCandidates.every((item) => item.id !== crossCardMechanism.id));
});

test("generic activation and resolution overlap remains related-only and cannot authorize a cross-card QA", async () => {
  const current = syntheticCard("51001", "匿名对象甲", "这张卡不受其他卡的效果影响。");
  const unrelated = {
    id: "qa-cross-card-generic-only",
    recordType: "qa",
    question: "某个效果发动并处理后，能否特殊召唤怪兽？",
    rawDetailedQuestion: "「<<52001>>」的效果发动并完成处理后，能否发动另一效果特殊召唤？",
    answer: "这是只涉及特殊召唤的资料。",
    cardIds: ["52001"],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "不受其他卡效果影响的「匿名对象甲」攻击时，能否发动使攻击无效的效果，处理时会怎样？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [unrelated],
    ruleSearchQueries: [{ query: "不受效果影响 攻击无效 发动 效果处理" }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "6" },
  });

  const related = evidence.officialQaRelated.find((item) => item.id === unrelated.id);
  assert.ok(related);
  assert.equal(related.type, "related");
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext.relatedOnly, true);
  assert.ok(evidence.officialQaDirectCandidates.every((item) => item.id !== unrelated.id));
});

test("a strict mechanism match survives an incidental multi-card identity mismatch only as related evidence", async () => {
  const first = syntheticCard("51501", "虚构构件甲", "这张卡将被破坏时，可以适用代替处理。");
  const second = syntheticCard("51502", "虚构构件乙", "处理后可以特殊召唤一只怪兽。");
  const mechanismAnalogue = {
    id: "qa-fictional-mechanism-analogue",
    recordType: "qa",
    question: "「<<51501>>」将被破坏时，由「<<51999>>」代替破坏而没有被破坏，之后能否特殊召唤？",
    rawDetailedQuestion: "「<<51501>>」将被破坏时，由「<<51999>>」代替破坏而没有被破坏，之后能否特殊召唤？",
    answer: "官方资料正文。",
    cardIds: ["51501", "51999"],
  };
  const genericDecoy = {
    id: "qa-fictional-generic-decoy",
    recordType: "qa",
    question: "「<<51501>>」与「<<51998>>」的效果发动并处理后，能否发动另一个效果？",
    rawDetailedQuestion: "「<<51501>>」与「<<51998>>」的效果发动并处理后，能否发动另一个效果？",
    answer: "只包含泛化的发动与处理用语。",
    cardIds: ["51501", "51998"],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "「虚构构件甲」将被破坏时由「虚构构件乙」代替破坏，之后能否特殊召唤？",
    cardResolution: {
      resolvedCards: [first, second],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [first, second],
    records: [],
    qaRecords: [genericDecoy, mechanismAnalogue],
    ruleSearchQueries: [{
      query: "破坏代替 没有被破坏 特殊召唤 发动条件",
      reason: "检索相同操作关系",
    }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  const related = evidence.officialQaRelated.find(
    (item) => item.id === mechanismAnalogue.id,
  );
  assert.ok(related);
  assert.equal(related.type, "related");
  assert.equal(related.isDirect, false);
  assert.ok(evidence.officialQaDirectCandidates.every(
    (item) => item.id !== mechanismAnalogue.id,
  ));
  const genericRelated = evidence.officialQaRelated.find((item) => item.id === genericDecoy.id);
  assert.ok(genericRelated);
  assert.equal(genericRelated.isDirect, false);
  assert.ok(
    evidence.officialQaRelated.indexOf(related)
      < evidence.officialQaRelated.indexOf(genericRelated),
  );
});

test("strict mechanism overlap can retrieve a multilingual official cross-card QA", async () => {
  const current = syntheticCard("53001", "匿名耐性怪兽乙", "这张卡不受其他卡的效果影响。");
  const multilingualMechanism = {
    id: "qa-cross-card-multilingual-mechanism",
    recordType: "qa",
    question: "他のカードの効果を受けない攻撃モンスターの攻撃を無効にする効果は発動できますか？",
    rawDetailedQuestion: "「<<53002>>」が攻撃する時、その攻撃を無効にする効果を発動できますか？",
    answer: "公式回答本文。",
    cardIds: ["53002"],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "不受其他卡效果影响的「匿名耐性怪兽乙」攻击时，能否发动使攻击无效的效果？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [multilingualMechanism],
    ruleSearchQueries: [{ query: "不受效果影响 攻击无效 发动条件" }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "6" },
  });

  const related = evidence.officialQaRelated.find(
    (item) => item.id === multilingualMechanism.id,
  );
  assert.ok(related);
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext.relatedOnly, true);
});

test("strict official card FAQs use the bounded cross-card reserve without becoming direct", async () => {
  const current = syntheticCard(
    "54001",
    "虚构基准构件",
    "这张卡将被破坏时，可以适用代替处理，之后可以特殊召唤。",
  );
  const scopedTail = {
    id: "qa-fictional-scoped-tail",
    recordType: "qa",
    question: "「<<54001>>」召唤时能否抽一张卡？",
    rawDetailedQuestion: "「<<54001>>」召唤时能否抽一张卡？",
    answer: "与提问机制不同的同卡资料。",
    cardIds: ["54001"],
  };
  const crossCardFaqs = Array.from({ length: 4 }, (_unused, index) => {
    const question = `某怪兽将被破坏时适用代替处理而没有被破坏，之后能否特殊召唤？资料 ${index}`;
    return {
      id: `card-faq-fictional-cross-${index}`,
      recordType: "card-faq",
      title: question,
      text: question,
      question,
      answer: "官方卡片 FAQ 正文。",
      cardIds: [String(54101 + index)],
    };
  });
  const evidence = await retrieveRagEvidence({
    userQuery: "「虚构基准构件」将被破坏时适用代替处理而没有被破坏，之后能否特殊召唤？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [scopedTail, ...crossCardFaqs],
    ruleSearchQueries: [{
      query: "破坏代替 没有被破坏 特殊召唤 发动条件",
      reason: "检索相同操作关系",
    }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  assert.equal(evidence.officialQaRelated.length, 4);
  const crossCardRelated = evidence.officialQaRelated.filter(
    (item) => item.retrievalContext.scope === "cross_card_official_mechanism",
  );
  assert.equal(crossCardRelated.length, 3);
  assert.ok(crossCardRelated.some((item) => item.recordType === "card-faq"));
  assert.ok(crossCardRelated.every((item) => (
    item.type === "related"
    && item.isDirect === false
    && item.retrievalContext.relatedOnly === true
  )));
  assert.ok(evidence.officialQaDirectCandidates.every(
    (item) => !crossCardFaqs.some((faq) => faq.id === item.id),
  ));
});

test("card FAQ identity keeps explicit ownership and ignores body or answer mentions", async () => {
  const current = syntheticCard("54501", "匿名归属目标", "这张卡的处理需要查询 FAQ。");
  const other = syntheticCard("54502", "匿名正文来源", "这张卡会提及其他卡片。");
  const ownedFaq = {
    id: "card-faq-anonymous-owned",
    recordType: "card-faq",
    title: "匿名归属目标 FAQ",
    text: "这份 FAQ 明确属于当前卡片。",
    answer: "按 FAQ 正文处理。",
    cardIds: [current.id],
    cards: [current.name],
  };
  const mentionOnlyFaq = {
    id: "card-faq-anonymous-mention-only",
    recordType: "card-faq",
    title: "匿名正文来源 FAQ",
    text: `正文仅举例提到「${current.name}」与「<<${current.id}>>」。`,
    answer: `答案再次提到「<<${current.id}>>」，但不改变 FAQ 归属。`,
    cardIds: [other.id],
    cards: [other.name],
  };

  const evidence = await retrieveRagEvidence({
    userQuery: `「${current.name}」的 FAQ 如何处理？`,
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current, other],
    records: [],
    qaRecords: [ownedFaq, mentionOnlyFaq],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  const faqById = new Map(evidence.faqRelated.map((item) => [item.id, item]));
  assert.ok(faqById.has(ownedFaq.id));
  assert.ok(!faqById.has(mentionOnlyFaq.id));
  assert.deepEqual(faqById.get(ownedFaq.id).cardIds, [current.id]);
});

test("card FAQ question mentions remain cross-card related-only", async () => {
  const current = syntheticCard("54601", "匿名问题目标", "这张卡可能涉及破坏代替。");
  const owner = syntheticCard("54602", "匿名 FAQ 归属", "这张卡拥有对应 FAQ。");
  const crossCardFaq = {
    id: "card-faq-anonymous-cross-card",
    recordType: "card-faq",
    title: "破坏被代替后的处理",
    question: `「<<${current.id}>>」将被破坏时适用代替处理而没有被破坏，之后能否特殊召唤？`,
    rawQuestion: `「<<${current.id}>>」将被破坏时适用代替处理而没有被破坏，之后能否特殊召唤？`,
    rawDetailedQuestion: `「<<${current.id}>>」将被破坏时适用代替处理而没有被破坏，之后能否特殊召唤？`,
    answer: `可以参照处理；答案提到「<<${current.id}>>」不改变归属。`,
    cardIds: [owner.id],
    cards: [owner.name],
  };

  const evidence = await retrieveRagEvidence({
    userQuery: `「${current.name}」将被破坏时适用代替处理而没有被破坏，之后能否特殊召唤？`,
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current, owner],
    records: [],
    qaRecords: [crossCardFaq],
    ruleSearchQueries: [{ query: "破坏代替 没有被破坏 特殊召唤 发动条件" }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  assert.ok(!evidence.faqRelated.some((item) => item.id === crossCardFaq.id));
  const related = evidence.officialQaRelated.find((item) => item.id === crossCardFaq.id);
  assert.ok(related);
  assert.deepEqual(related.cardIds, [owner.id]);
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext.scope, "cross_card_official_mechanism");
  assert.equal(related.retrievalContext.relatedOnly, true);
});

test("independent supplemental queries preserve distinct strict mechanisms over generic decoys", async () => {
  const current = syntheticCard("55001", "虚构查询锚点", "这张卡的处理会改变当前状态。");
  const replacement = {
    id: "qa-fictional-replacement-head",
    recordType: "qa",
    question: "怪兽的破坏被代替而没有被破坏时，能否进行特殊召唤？",
    rawDetailedQuestion: "「<<55101>>」的破坏被代替而没有被破坏时，能否进行特殊召唤？",
    answer: "第一种机制的官方资料。",
    cardIds: ["55101"],
  };
  const movement = {
    id: "qa-fictional-movement-head",
    recordType: "qa",
    question: "卡组中的卡被除外后，能否进行返回卡组的操作？",
    rawDetailedQuestion: "「<<55201>>」是卡组中的卡，被除外后能否进行返回卡组的操作？",
    answer: "第二种机制的官方资料。",
    cardIds: ["55201"],
  };
  const genericDecoys = Array.from({ length: 8 }, (_unused, index) => ({
    id: `qa-fictional-supplemental-decoy-${index}`,
    recordType: "qa",
    question: `某效果发动并处理后，能否发动另一个效果？资料 ${index}`,
    rawDetailedQuestion: `「<<553${index + 10}>>」的效果发动并处理后，能否发动另一个效果？`,
    answer: "只包含泛化的发动与处理用语。",
    cardIds: [`553${index + 10}`],
  }));
  const evidence = await retrieveRagEvidence({
    userQuery: "「虚构查询锚点」涉及两个待核对操作：破坏被代替后能否进行特殊召唤，以及卡组中的卡被除外后能否进行返回卡组的操作？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [...genericDecoys, replacement, movement],
    ruleSearchQueries: [
      { query: "破坏代替 没有被破坏 特殊召唤 能否进行" },
      { query: "卡组中的卡 除外 返回卡组 能否进行" },
    ],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "2" },
  });

  const relatedIds = new Set(evidence.officialQaRelated.map((item) => item.id));
  assert.ok(relatedIds.has(replacement.id));
  assert.ok(relatedIds.has(movement.id));
  assert.ok(genericDecoys.every((item) => !relatedIds.has(item.id)));
  assert.ok(evidence.officialQaRelated.every((item) => (
    item.isDirect === false && item.retrievalContext.relatedOnly === true
  )));
});

test("query-independent record features preserve repeated retrieval output", async () => {
  const current = syntheticCard("56001", "虚构缓存锚点", "这张卡的处理会改变当前状态。");
  const qaRecords = [
    {
      id: "qa-fictional-cache-replacement",
      recordType: "qa",
      question: "怪兽的破坏被代替而没有被破坏时，能否进行特殊召唤？",
      rawDetailedQuestion: "「<<56101>>」的破坏被代替而没有被破坏时，能否进行特殊召唤？",
      answer: "第一种机制的官方资料。",
      cardIds: ["56101"],
    },
    {
      id: "qa-fictional-cache-movement",
      recordType: "qa",
      question: "卡组中的卡被除外后，能否进行返回卡组的操作？",
      rawDetailedQuestion: "「<<56201>>」是卡组中的卡，被除外后能否进行返回卡组的操作？",
      answer: "第二种机制的官方资料。",
      cardIds: ["56201"],
    },
  ];
  const options = {
    userQuery: "「虚构缓存锚点」涉及两个待核对操作：破坏被代替后能否进行特殊召唤，以及卡组中的卡被除外后能否进行返回卡组的操作？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords,
    ruleSearchQueries: [
      { query: "破坏代替 没有被破坏 特殊召唤 能否进行" },
      { query: "卡组中的卡 除外 返回卡组 能否进行" },
    ],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "2" },
  };

  const first = await retrieveRagEvidence(options);
  const second = await retrieveRagEvidence(options);
  const comparable = (evidence) => evidence.officialQaRelated.map((item) => ({
    id: item.id,
    type: item.type,
    recordType: item.recordType,
    retrievalScore: item.retrievalScore,
    retrievalSignals: item.retrievalSignals,
    retrievalContext: item.retrievalContext,
    isDirect: item.isDirect,
  }));

  assert.equal(first.officialQaRelated.length, 2);
  assert.deepEqual(comparable(second), comparable(first));
});

test("retriever provenance survives the real prompt boundary without promoting community QA", async () => {
  const current = syntheticCard("61001", "匿名对象乙", "这张卡的效果处理后进行一次操作。");
  const communityQa = {
    id: "community-qa-shaped-reference",
    recordType: "qa",
    official: false,
    source: "ocg-rule-community",
    sourceTier: "S2_COMMUNITY_REFERENCE",
    question: "「<<61001>>」的效果发动并处理后如何继续？",
    rawDetailedQuestion: "「<<61001>>」的效果发动并处理后如何继续？",
    answer: "这是社区整理的辅助说明。",
    cardIds: ["61001"],
  };
  const cardResolution = {
    resolvedCards: [current],
    unresolvedMentions: [],
    ambiguousMentions: [],
    userProvidedCardTexts: [],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "「匿名对象乙」的效果发动并处理后如何继续？",
    cardResolution,
    cards: [current],
    records: [communityQa],
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.ok(evidence.officialQaRelated.every((item) => item.id !== communityQa.id));
  const retrieved = evidence.rawRelatedEvidence.find((item) => item.id === communityQa.id);
  assert.ok(retrieved);
  assert.equal(retrieved.official, false);
  assert.equal(retrieved.sourceAuthority, "community_reference");

  const bundle = buildRagRulingPromptBundle({
    userQuery: "「匿名对象乙」的效果发动并处理后如何继续？",
    cardResolution,
    evidence,
  });
  const promptItem = bundle.modelEvidence.rawRelatedEvidence.find(
    (item) => item.id === communityQa.id,
  );
  assert.ok(promptItem);
  assert.equal(promptItem.official, false);
  assert.equal(promptItem.source, "ocg-rule-community");
  assert.equal(promptItem.sourceTier, "S2_COMMUNITY_REFERENCE");
  assert.equal(promptItem.sourceAuthority, "community_reference");
});

test("deterministic multilingual expansion preserves phase distinctions", async () => {
  const evidence = await retrieveRagEvidence({
    userQuery: "伤害步骤结束时和伤害计算后的状态是否相同？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [],
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.match(evidence.ruleSearchQueries[0].query, /ダメージステップ終了時/u);
  assert.match(evidence.ruleSearchQueries[0].query, /ダメージ計算後/u);
});
