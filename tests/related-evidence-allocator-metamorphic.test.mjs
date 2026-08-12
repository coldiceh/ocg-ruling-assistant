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
