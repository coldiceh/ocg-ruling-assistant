import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateOfficialRelatedEvidence,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";

const syntheticCards = ["甲", "乙", "丙"].map((label, index) => ({
  id: String(980_000_001 + index),
  name: `合成身份${label}`,
  aliases: [`合成身份${label}`],
}));

const [firstCard, secondCard, thirdCard] = syntheticCards;
const combinationRecordId = "synthetic-two-identity-combination";
const combinationRecord = {
  id: combinationRecordId,
  recordType: "qa",
  question: `「<<${firstCard.id}>>」的效果发动时，能否发动「<<${secondCard.id}>>」的效果？`,
  answer: "这条合成资料只说明两个身份共同出现的局部场景。",
  cardIds: [firstCard.id, secondCard.id],
  questionCardIds: [firstCard.id, secondCard.id],
  retrievalScore: 0.05,
};

const singleIdentityNoise = syntheticCards.flatMap((card) => (
  Array.from({ length: 24 }, (_, index) => ({
    id: `synthetic-single-identity-noise-${card.id}-${String(index).padStart(2, "0")}`,
    recordType: "qa",
    question: `「<<${card.id}>>」的效果发动时，能否发动该效果？之后该效果能否发动？`,
    answer: "这条合成噪声只覆盖一个问题身份。",
    cardIds: [card.id],
    questionCardIds: [card.id],
    retrievalScore: 0.99,
  }))
));

function deterministicShuffle(items) {
  const buckets = [[], [], [], [], []];
  items.forEach((item, index) => buckets[index % buckets.length].push(item));
  return buckets.reverse().flatMap((bucket) => bucket.reverse());
}

async function retrieve(records) {
  return retrieveRagEvidence({
    userQuery: [
      `「${firstCard.name}」的效果发动时，能否发动「${secondCard.name}」的效果？`,
      `之后「${thirdCard.name}」的效果能否发动？`,
    ].join("\n"),
    cardResolution: {
      resolvedCards: syntheticCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: syntheticCards,
    records,
    qaRecords: [],
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    subsumptionCandidatePoolComplete: true,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "3",
    },
  });
}

function assertCombinationRemainsRelated(evidence) {
  const retained = evidence.officialQaRelated.find(
    (item) => item.id === combinationRecordId,
  );
  assert.ok(retained, "the two-identity combination must survive the bounded related allocation");
  assert.deepEqual(
    new Set(retained.matchedQuestionCardIds),
    new Set([firstCard.id, secondCard.id]),
  );
  assert.equal(retained.isDirect, false);
  assert.notEqual(retained.matchLevel, "official_qa_exact");
  assert.equal(evidence.officialQaDirectCandidates.length, 0);
  assert.ok(evidence.officialQaRelated.every((item) => item.isDirect === false));
}

test("multi-identity related evidence survives single-identity corpus growth and input shuffling", async () => {
  const baseline = await retrieve([combinationRecord]);
  const expandedRecords = [combinationRecord, ...singleIdentityNoise];
  const expanded = await retrieve(expandedRecords);
  const shuffled = await retrieve(deterministicShuffle(expandedRecords));

  for (const evidence of [baseline, expanded, shuffled]) {
    assertCombinationRemainsRelated(evidence);
  }

  for (const evidence of [expanded, shuffled]) {
    const retained = evidence.officialQaRelated.find(
      (item) => item.id === combinationRecordId,
    );
    const retainedNoiseScores = evidence.officialQaRelated
      .filter((item) => item.id.startsWith("synthetic-single-identity-noise-"))
      .map((item) => item.retrievalScore);
    assert.ok(retainedNoiseScores.length > 0);
    assert.ok(Math.max(...retainedNoiseScores) > retained.retrievalScore);
  }
});

const mechanismAnchor = {
  id: "981000001",
  name: "合成机制锚点",
  aliases: ["合成机制锚点"],
};

const mechanismSubclaims = [
  {
    id: "synthetic-official-destruction-replacement",
    cardId: "981000101",
    query: "破坏被代替而没有被破坏时 特殊召唤处理如何进行",
    question: "怪兽的破坏被代替而没有被破坏时，之后的特殊召唤处理如何进行？",
  },
  {
    id: "synthetic-official-banish-return-deck",
    cardId: "981000102",
    query: "卡组中的卡被除外后 返回卡组处理如何进行",
    question: "卡组中的卡被除外后，返回卡组的处理如何进行？",
  },
  {
    id: "synthetic-official-negate-send-graveyard",
    cardId: "981000103",
    query: "效果的发动被无效后 送去墓地处理如何进行",
    question: "效果的发动被无效后，送去墓地的处理如何进行？",
  },
];

const mechanismOfficialRecords = mechanismSubclaims.map((item) => ({
  id: item.id,
  recordType: "qa",
  question: item.question,
  rawDetailedQuestion: `「<<${item.cardId}>>」${item.question}`,
  answer: "匿名官方资料仅说明对应的原子处理关系。",
  cardIds: [item.cardId],
  questionCardIds: [item.cardId],
}));

const scopedDecisiveRecord = {
  id: "synthetic-scoped-decisive-official",
  recordType: "qa",
  question: `「<<${mechanismAnchor.id}>>」有三个需要分别核对的效果处理结果。`,
  rawDetailedQuestion: `「<<${mechanismAnchor.id}>>」有三个需要分别核对的效果处理结果。`,
  answer: "这条同卡官方资料包含当前卡片本身的决定性适用前提。",
  cardIds: [mechanismAnchor.id],
  questionCardIds: [mechanismAnchor.id],
};

const scopedLexicalDecoys = Array.from({ length: 18 }, (_unused, index) => ({
  id: `synthetic-scoped-lexical-decoy-${String(index).padStart(2, "0")}`,
  recordType: "qa",
  question: `「<<${mechanismAnchor.id}>>」的效果处理后，后续效果处理如何进行？资料 ${index}`,
  rawDetailedQuestion: `「<<${mechanismAnchor.id}>>」的效果处理后，后续效果处理如何进行？资料 ${index}`,
  answer: "这条高词频资料不包含任何待核对的原子机制。",
  cardIds: [mechanismAnchor.id],
  questionCardIds: [mechanismAnchor.id],
  retrievalScore: 0.99,
}));

async function retrieveMechanismCoverage(records, relatedLimit = 3) {
  return retrieveRagEvidence({
    userQuery: [
      `「${mechanismAnchor.name}」有三个需要分别核对的效果处理结果：`,
      ...mechanismSubclaims.map((item) => item.question),
    ].join("\n"),
    cardResolution: {
      resolvedCards: [mechanismAnchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [mechanismAnchor],
    records,
    qaRecords: [],
    ruleSearchQueries: mechanismSubclaims.map((item) => ({
      query: item.query,
      reason: "匿名结构化子问题",
    })),
    maxPerBucket: 3,
    enableLiveOfficialQa: false,
    subsumptionCandidatePoolComplete: true,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: String(relatedLimit),
    },
  });
}

function assertBoundedMechanismCoverage(evidence) {
  const expectedIds = new Set(mechanismOfficialRecords.map((item) => item.id));
  const scopedIds = new Set([
    scopedDecisiveRecord,
    ...scopedLexicalDecoys,
  ].map((item) => item.id));
  const related = evidence.officialQaRelated;
  assert.ok(evidence.officialQaRelated.length <= 3);
  const crossCardRelated = related.filter(
    (item) => item.retrievalContext.scope === "cross_card_official_mechanism",
  );
  const scopedRelated = related.filter(
    (item) => item.retrievalContext.scope !== "cross_card_official_mechanism",
  );
  // The allocator cannot infer that one synthetic answer is "decisive":
  // answer text is deliberately excluded from retrieval ranking.  Its actual
  // contract is to retain at least one independently ranked same-card source
  // while reserving bounded slots for cross-card mechanism sources.
  assert.ok(scopedRelated.some((item) => scopedIds.has(item.id)));
  assert.ok(crossCardRelated.length <= 2);
  assert.ok(crossCardRelated.some((item) => expectedIds.has(item.id)));
  assert.ok(crossCardRelated.every((item) => item.retrievalContext.relatedOnly === true));
  assert.ok(evidence.officialQaRelated.every((item) => item.isDirect === false));
  assert.ok(evidence.officialQaDirectCandidates.every(
    (item) => !expectedIds.has(item.id),
  ));
}

test("structured subclaims use the bounded cross-card reserve without evicting scoped official evidence", async () => {
  const records = [
    scopedDecisiveRecord,
    ...scopedLexicalDecoys,
    ...mechanismOfficialRecords,
  ];
  const baseline = await retrieveMechanismCoverage(records);
  const shuffled = await retrieveMechanismCoverage(deterministicShuffle(records));

  assertBoundedMechanismCoverage(baseline);
  assertBoundedMechanismCoverage(shuffled);
  assert.deepEqual(
    shuffled.officialQaRelated.map((item) => item.id),
    baseline.officialQaRelated.map((item) => item.id),
  );
});

test("a one-item related budget keeps scoped official evidence instead of a supplemental analogy", async () => {
  const evidence = await retrieveMechanismCoverage([
    scopedDecisiveRecord,
    ...mechanismOfficialRecords,
  ], 1);

  assert.deepEqual(
    evidence.officialQaRelated.map((item) => item.id),
    [scopedDecisiveRecord.id],
  );
});

test("a strict supplemental candidate survives a bounded head of non-strict records", async () => {
  const query = "② 破坏被代替而没有被破坏 之后能否特殊召唤";
  const lexicalHeads = Array.from({ length: 3 }, (_unused, index) => ({
    id: `synthetic-non-strict-head-${index}`,
    recordType: "qa",
    question: `②能否特殊召唤？资料 ${index}`,
    rawDetailedQuestion: `「<<98200010${index}>>」②能否特殊召唤？资料 ${index}`,
    answer: "这条资料只有一般性的处理措辞。",
    cardIds: [`98200010${index}`],
    questionCardIds: [`98200010${index}`],
  }));
  const strictFourth = {
    id: "synthetic-strict-candidate-below-head",
    recordType: "qa",
    question: "③的破坏被代替而没有被破坏时，之后能否特殊召唤？",
    rawDetailedQuestion: "「<<982000201>>」③的破坏被代替而没有被破坏时，之后能否特殊召唤？",
    answer: "这条资料包含完整的原子机制关系。",
    cardIds: ["982000201"],
    questionCardIds: ["982000201"],
  };
  const evidence = await retrieveRagEvidence({
    // The user-facing question alone only supplies the generic summon type.
    // The supplemental query introduces the complete operation relation.
    userQuery: `「${mechanismAnchor.name}」的②能否特殊召唤？`,
    cardResolution: {
      resolvedCards: [mechanismAnchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [mechanismAnchor],
    records: [...lexicalHeads, strictFourth],
    qaRecords: [],
    ruleSearchQueries: [{ query, reason: "匿名结构化子问题" }],
    maxPerBucket: 4,
    enableLiveOfficialQa: false,
    subsumptionCandidatePoolComplete: true,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "4",
    },
  });

  const retained = evidence.officialQaRelated.find((item) => item.id === strictFourth.id);
  assert.ok(retained);
  assert.ok(Number(retained.retrievalSignals?.supplementalRuleQueryBestRank || 0) > 0);
  assert.equal(retained.retrievalSignals?.strictSupplementalRuleQueryKeys?.length, 1);
  assert.equal(retained.retrievalContext.relatedOnly, true);
  assert.equal(retained.isDirect, false);
  // Non-strict candidates may remain as related-only context; handwritten
  // mechanism gates must not delete them or grant them direct authority.
  assert.ok(evidence.officialQaRelated
    .filter((item) => lexicalHeads.some((head) => head.id === item.id))
    .every((item) => item.retrievalContext.relatedOnly === true && item.isDirect === false));
});

test("same-identity scoped evidence retains two distinct strict branches under noise and shuffling", async () => {
  const anchor = {
    id: "983000001",
    name: "匿名同身份分支锚点",
    aliases: ["匿名同身份分支锚点"],
    effectText: "这张卡包含多个需要分别核对的处理分支。",
  };
  const strictRecords = [{
    id: "card-faq-anonymous-scoped-branch-a",
    question: "破坏被代替而没有被破坏时，之后能否特殊召唤？",
    query: "破坏被代替 没有被破坏 特殊召唤",
  }, {
    id: "card-faq-anonymous-scoped-branch-b",
    question: "卡组中的卡被除外后，之后能否返回卡组？",
    query: "卡组中的卡 被除外 返回卡组",
  }].map((item) => ({
    ...item,
    recordType: "card-faq",
    title: item.question,
    text: item.question,
    answer: "匿名官方资料正文。",
    cardIds: [anchor.id],
    cards: [anchor.name],
  }));
  const noise = Array.from({ length: 20 }, (_unused, index) => ({
    id: `card-faq-anonymous-scoped-noise-${String(index).padStart(2, "0")}`,
    recordType: "card-faq",
    title: `效果发动后能否处理？资料 ${index}`,
    question: `效果发动后能否处理？资料 ${index}`,
    text: `效果发动后能否处理？资料 ${index}`,
    answer: "匿名普通资料。",
    cardIds: [anchor.id],
    cards: [anchor.name],
    retrievalScore: 0.99,
  }));
  const retrieveBranches = (records) => retrieveRagEvidence({
    userQuery: `「${anchor.name}」有两个需要分别核对的处理分支。`,
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: records,
    ruleSearchQueries: strictRecords.map((item) => ({
      query: item.query,
      source: "model_rule_query_extractor",
    })),
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "2" },
  });

  const baseline = await retrieveBranches([...noise, ...strictRecords]);
  const shuffled = await retrieveBranches(deterministicShuffle([...noise, ...strictRecords]));
  const expectedIds = strictRecords.map((item) => item.id).sort();
  for (const evidence of [baseline, shuffled]) {
    // card-faq records intentionally remain in the FAQ bucket; this verifies
    // branch coverage without duplicating them into officialQaRelated.
    assert.deepEqual(evidence.faqRelated.map((item) => item.id).sort(), expectedIds);
    assert.ok(evidence.faqRelated.every((item) => (
      item.isDirect === false
      && (item.retrievalSignals?.strictSupplementalRuleQueryKeys || []).length > 0
    )));
    assert.ok(new Set(evidence.faqRelated.flatMap((item) => (
      item.retrievalSignals?.strictSupplementalRuleQueryKeys || []
    ))).size >= 2);
  }
});

function allocatorMetamorphicFixture({
  idPrefix,
  cardId,
  cardName,
  queryPrefix,
  reorder = false,
} = {}) {
  const mechanisms = {
    first: `${queryPrefix}-a|semantic:operation:destroy|operation:replacement|operation:special-summon`,
    second: `${queryPrefix}-b|semantic:operation:banish|operation:return-deck`,
    third: `${queryPrefix}-c|semantic:operation:negate|operation:send-graveyard`,
  };
  const candidate = ({ role, id, queryKey = "", scoped = false, score = 0 }) => ({
    id: `${idPrefix}-${id}`,
    role,
    type: "related",
    recordType: "qa",
    question: scoped
      ? `「<<${cardId}>>」匿名机制问题。`
      : `「<<${Number(cardId) + 1000 + id.length}>>」匿名类比问题。`,
    text: `anonymous evidence ${role}`,
    cardIds: scoped ? [cardId] : [String(Number(cardId) + 1000 + id.length)],
    questionCardIds: scoped ? [cardId] : [String(Number(cardId) + 1000 + id.length)],
    retrievalScore: score,
    retrievalSignals: queryKey ? {
      ruleQueryKeys: [queryKey],
      strictRuleQueryKeys: [queryKey],
      ruleQueryRanks: { [queryKey]: 1 },
    } : {},
    retrievalContext: scoped ? {} : { scope: "cross_card_official_mechanism" },
  });
  const records = [
    candidate({ role: "same-scene-first", id: "scoped-a", queryKey: mechanisms.first, scoped: true, score: 0.1 }),
    candidate({ role: "same-scene-second", id: "scoped-b", queryKey: mechanisms.second, scoped: true, score: 0.2 }),
    candidate({ role: "third-checkpoint", id: "cross-c", queryKey: mechanisms.third, score: 0.3 }),
    candidate({ role: "ranked-fallback", id: "scoped-head", scoped: true, score: 0.99 }),
    candidate({ role: "redundant-analogy", id: "cross-a", queryKey: mechanisms.first, score: 1 }),
    ...Array.from({ length: 12 }, (_unused, index) => candidate({
      role: `same-mechanism-noise-${index}`,
      id: `noise-${index}`,
      queryKey: mechanisms.first,
      score: 1 + index,
    })),
  ];
  return {
    candidates: reorder ? deterministicShuffle(records) : records,
    resolvedCards: [{ id: cardId, name: cardName, aliases: [cardName] }],
    queryKeys: Object.values(mechanisms),
  };
}

test("anonymous query-key coverage is invariant under candidate reorder, identity rewrite, synonym rewrite, and same-mechanism noise", () => {
  const variants = [
    allocatorMetamorphicFixture({
      idPrefix: "fixture-one",
      cardId: "984000001",
      cardName: "匿名锚点甲",
      queryPrefix: "first wording",
    }),
    allocatorMetamorphicFixture({
      idPrefix: "randomized-fixture-two",
      cardId: "984009991",
      cardName: "完全改名后的锚点",
      queryPrefix: "synonymous rewrite",
      reorder: true,
    }),
  ];
  const allocations = variants.map((fixture) => allocateOfficialRelatedEvidence({
    scopedCandidates: fixture.candidates.filter((item) => (
      item.retrievalContext.scope !== "cross_card_official_mechanism"
    )),
    crossCardCandidates: fixture.candidates.filter((item) => (
      item.retrievalContext.scope === "cross_card_official_mechanism"
    )),
    limit: 4,
    resolvedCards: fixture.resolvedCards,
    supplementalRuleQueryKeys: fixture.queryKeys,
  }));
  const expectedRoles = [
    "ranked-fallback",
    "same-scene-first",
    "same-scene-second",
    "third-checkpoint",
  ].sort();
  for (const allocation of allocations) {
    assert.deepEqual(allocation.map((item) => item.role).sort(), expectedRoles);
    assert.ok(!allocation.some((item) => (
      item.role === "redundant-analogy" || item.role.startsWith("same-mechanism-noise-")
    )));
  }
});

test("same canonical card and query key do not merge distinct official-question premises", () => {
  const cardId = "984100001";
  const queryKey = "anonymous branch|semantic:operation:destroy|operation:special-summon";
  const scopedPremise = (id, role, question, score) => ({
    id,
    role,
    type: "related",
    recordType: "qa",
    question: `「<<${cardId}>>」${question}`,
    text: `anonymous evidence ${role}`,
    cardIds: [cardId],
    questionCardIds: [cardId],
    retrievalScore: score,
    retrievalSignals: {
      ruleQueryKeys: [queryKey],
      strictRuleQueryKeys: [queryKey],
      ruleQueryRanks: { [queryKey]: 1 },
    },
  });
  const firstPremise = scopedPremise(
    "anonymous-distinct-premise-a",
    "premise-a",
    "被破坏的怪兽仍在场上时，之后能否特殊召唤？",
    0.9,
  );
  const secondPremise = scopedPremise(
    "anonymous-distinct-premise-b",
    "premise-b",
    "破坏已被代替且怪兽没有被破坏时，之后能否特殊召唤？",
    0.8,
  );
  const analogy = {
    ...scopedPremise(
      "anonymous-cross-card-padding",
      "analogy",
      "其他卡的相似处理。",
      1,
    ),
    cardIds: ["984100999"],
    questionCardIds: ["984100999"],
    retrievalContext: { scope: "cross_card_official_mechanism" },
  };
  const selected = allocateOfficialRelatedEvidence({
    scopedCandidates: [secondPremise, firstPremise],
    crossCardCandidates: [analogy],
    limit: 2,
    resolvedCards: [{ id: cardId, name: "匿名前提锚点" }],
    supplementalRuleQueryKeys: [queryKey],
  });

  assert.deepEqual(selected.map((item) => item.role).sort(), ["premise-a", "premise-b"]);
});

function metadataScopedHeadFixture({
  resolved = true,
  reorder = false,
  recordType = "qa",
  metadataScore = 0.99,
} = {}) {
  const anchor = {
    id: "984200001",
    name: "匿名元数据锚点",
    aliases: ["匿名元数据锚点"],
  };
  const queryKeys = Array.from({ length: 4 }, (_unused, index) => (
    `anonymous-branch-${index}|semantic:operation:${index}`
  ));
  const coverage = queryKeys.map((queryKey, index) => {
    const premiseId = String(984_201_001 + index);
    return {
      id: `anonymous-question-coverage-${index}`,
      role: `coverage-${index}`,
      type: "related",
      recordType: "qa",
      question: `「<<${anchor.id}>>」与「<<${premiseId}>>」的匿名问题前提 ${index}。`,
      text: `anonymous question coverage ${index}`,
      cardIds: [anchor.id, premiseId],
      questionCardIds: [anchor.id, premiseId],
      matchedQuestionCardIds: [anchor.id],
      retrievalScore: 0.5 - index * 0.01,
      retrievalSignals: {
        ruleQueryKeys: [queryKey],
        strictRuleQueryKeys: [queryKey],
        ruleQueryRanks: { [queryKey]: 1 },
      },
    };
  });
  const metadataHead = {
    id: "anonymous-confirmed-metadata-scoped-head",
    role: "metadata-scoped-head",
    type: "related",
    isDirect: false,
    recordType,
    question: "不含当前身份的问题侧匿名官方记录。",
    text: "anonymous metadata scoped official evidence",
    cardIds: [anchor.id],
    matchedRelatedMetadataCardIds: [anchor.id],
    retrievalScore: metadataScore,
    retrievalContext: { relatedOnly: true },
  };
  const scopedCandidates = [metadataHead, ...coverage];
  return {
    anchor,
    metadataHead,
    coverage,
    queryKeys,
    scopedCandidates: reorder ? deterministicShuffle(scopedCandidates) : scopedCandidates,
    resolvedCards: resolved ? [anchor] : [],
  };
}

test("confirmed metadata-scoped official head survives a full anonymous coverage budget", () => {
  const fixture = metadataScopedHeadFixture();
  const selected = allocateOfficialRelatedEvidence({
    scopedCandidates: fixture.scopedCandidates,
    crossCardCandidates: [],
    limit: 4,
    resolvedCards: fixture.resolvedCards,
    supplementalRuleQueryKeys: fixture.queryKeys,
  });

  assert.equal(selected.length, 4);
  assert.ok(selected.some((item) => item.id === fixture.metadataHead.id));
  assert.ok(selected.some((item) => (
    item.role.startsWith("coverage-")
    && item.retrievalSignals.strictRuleQueryKeys.length === 1
  )));
  const retained = selected.find((item) => item.id === fixture.metadataHead.id);
  assert.equal(retained.type, "related");
  assert.equal(retained.isDirect, false);
  assert.equal(retained.retrievalContext.relatedOnly, true);
});

test("metadata-scoped head allocation is reorder-stable and keeps the cross-card ceiling", () => {
  const baseline = metadataScopedHeadFixture();
  const shuffled = metadataScopedHeadFixture({ reorder: true });
  const crossCard = Array.from({ length: 8 }, (_unused, index) => ({
    id: `anonymous-cross-card-${index}`,
    role: `cross-card-${index}`,
    type: "related",
    recordType: "qa",
    question: `匿名类比问题 ${index}。`,
    text: `anonymous cross-card evidence ${index}`,
    retrievalScore: 0.8 - index * 0.01,
    retrievalSignals: {
      modelCandidateAssessment: { relevance: "high", premise: "partial" },
    },
    retrievalContext: {
      scope: "cross_card_official_mechanism",
      relatedOnly: true,
    },
  }));
  const allocate = (fixture) => allocateOfficialRelatedEvidence({
    scopedCandidates: fixture.scopedCandidates,
    crossCardCandidates: crossCard,
    limit: 12,
    resolvedCards: fixture.resolvedCards,
    supplementalRuleQueryKeys: fixture.queryKeys,
  });
  const first = allocate(baseline);
  const second = allocate(shuffled);

  assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));
  for (const selected of [first, second]) {
    assert.ok(selected.length <= 12);
    assert.ok(selected.some((item) => item.id === baseline.metadataHead.id));
    assert.equal(selected.filter((item) => (
      item.retrievalContext?.scope === "cross_card_official_mechanism"
    )).length, 5);
  }
});

test("metadata-only candidates gain no reserved slot without confirmed identity or for FAQ records", () => {
  const wrongResolvedIdentity = metadataScopedHeadFixture({ metadataScore: -1 });
  wrongResolvedIdentity.resolvedCards = [{
    id: "984299999",
    name: "匿名不相交身份",
    aliases: ["匿名不相交身份"],
  }];
  for (const fixture of [
    metadataScopedHeadFixture({ resolved: false }),
    metadataScopedHeadFixture({ recordType: "card-faq" }),
    wrongResolvedIdentity,
  ]) {
    const selected = allocateOfficialRelatedEvidence({
      scopedCandidates: fixture.scopedCandidates,
      crossCardCandidates: [],
      limit: 4,
      resolvedCards: fixture.resolvedCards,
      supplementalRuleQueryKeys: fixture.queryKeys,
    });
    assert.equal(selected.length, 4);
    assert.ok(!selected.some((item) => item.id === fixture.metadataHead.id));
  }
});

test("a bounded Planner scenario head outranks scattered same-branch semantic hits", () => {
  const candidate = (id, headlineLongestRun, headlineDistinctiveSemanticHitCount, {
    scenarioSurfaceHead = false,
  } = {}) => ({
    id,
    type: "related",
    isDirect: false,
    recordType: "qa",
    question: `匿名官方问题 ${id}`,
    text: `anonymous official evidence ${id}`,
    retrievalScore: 0.5,
    retrievalSignals: {
      questionBranchHeadlineAnchored: true,
      ...(scenarioSurfaceHead ? { questionBranchScenarioSurfaceHead: true } : {}),
      questionBranchHeadlineLongestRun: headlineLongestRun,
      questionBranchHeadlineDistinctiveSemanticHitCount: headlineDistinctiveSemanticHitCount,
    },
    retrievalContext: {
      scope: "cross_card_official_mechanism",
      relatedOnly: true,
    },
  });
  const completeScenario = candidate("anonymous-contiguous-scenario", 11, 2, {
    scenarioSurfaceHead: true,
  });
  const scatteredNeighbour = candidate("anonymous-scattered-neighbour", 10, 5);

  for (const crossCardCandidates of [
    [scatteredNeighbour, completeScenario],
    [completeScenario, scatteredNeighbour],
  ]) {
    const selected = allocateOfficialRelatedEvidence({
      scopedCandidates: [],
      crossCardCandidates,
      limit: 1,
      resolvedCards: [{ id: "984300001", name: "匿名排序锚点" }],
      supplementalRuleQueryKeys: [],
    });

    assert.deepEqual(selected.map((item) => item.id), [completeScenario.id]);
    assert.equal(selected[0].retrievalContext.relatedOnly, true);
    assert.equal(selected[0].isDirect, false);
  }
});
