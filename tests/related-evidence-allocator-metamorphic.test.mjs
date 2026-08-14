import assert from "node:assert/strict";
import test from "node:test";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

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
  const related = evidence.officialQaRelated;
  const relatedIds = new Set(related.map((item) => item.id));
  assert.ok(relatedIds.has(scopedDecisiveRecord.id));
  assert.ok(evidence.officialQaRelated.length <= 3);
  const crossCardRelated = related.filter(
    (item) => item.retrievalContext.scope === "cross_card_official_mechanism",
  );
  assert.ok(crossCardRelated.length <= 1);
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

test("the first strict supplemental candidate survives below three higher-ranked non-strict records", async () => {
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
  assert.ok(Number(retained.retrievalSignals?.supplementalRuleQueryBestRank || 0) >= 4);
  assert.equal(retained.retrievalContext.relatedOnly, true);
  assert.equal(retained.isDirect, false);
  assert.ok(lexicalHeads.every((item) => (
    !evidence.officialQaRelated.some((evidenceItem) => evidenceItem.id === item.id)
  )));
});
