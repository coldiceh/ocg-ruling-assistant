import assert from "node:assert/strict";
import test from "node:test";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

const CARD_ID_BASE = 880_000_000;
const QA_ID_BASE = 770_000;

const cards = [
  { name: "匿名防守者", effectText: "里侧守备表示存在，并在伤害计算前翻开。" },
  { name: "匿名攻击者甲", effectText: "可以攻击。" },
  { name: "匿名攻击者乙", effectText: "可以攻击。" },
  { name: "匿名攻击者丙", effectText: "可以攻击。" },
].map((card, index) => ({
  ...card,
  id: String(CARD_ID_BASE + index),
  aliases: [card.name],
  resolutionSource: "query",
}));

const qaIndexes = new Map(cards.map((card, cardIndex) => [
  card.id,
  Array.from({ length: 9 }, (_value, qaIndex) => String(QA_ID_BASE + cardIndex * 100 + qaIndex)),
]));

const branchActor = cards[2];
const branchQaId = qaIndexes.get(branchActor.id)[7];

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ownerOfQa(qaId) {
  return cards.find((card) => qaIndexes.get(card.id).includes(String(qaId)));
}

function createLiveQaFixture() {
  const fetchedQaIds = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/data/meta/mprop")) return jsonResponse([]);

    const cardMatch = value.match(/\/data\/card\/(\d+)$/u);
    if (cardMatch) {
      const cardId = cardMatch[1];
      assert.equal(qaIndexes.get(cardId)?.length, 9, `unexpected card index ${cardId}`);
      return jsonResponse({
        cardData: { en: { id: Number(cardId), cardType: "monster", properties: [] } },
        qaIndex: qaIndexes.get(cardId).map(Number),
      });
    }

    const qaMatch = value.match(/\/data\/qa\/(\d+)$/u);
    if (qaMatch) {
      const qaId = qaMatch[1];
      const owner = ownerOfQa(qaId);
      assert.ok(owner, `unexpected QA ${qaId}`);
      fetchedQaIds.push(qaId);

      if (qaId === branchQaId) {
        const question = `「<<${branchActor.id}>>」攻击里侧守备表示的怪兽时，是否能战斗破坏？`;
        return jsonResponse({
          cards: [Number(branchActor.id)],
          qaData: { ja: {
            title: question,
            question,
            answer: "伤害计算前翻开后，按当时适用的永续效果重新检查这一次战斗。",
          } },
        });
      }

      const question = `「<<${owner.id}>>」在主要阶段可以发动效果吗？`;
      return jsonResponse({
        cards: [Number(owner.id)],
        qaData: { ja: {
          title: question,
          question,
          answer: "满足卡片记载的条件时可以发动。",
        } },
      });
    }

    throw new Error(`unexpected_url:${value}`);
  };
  return { fetchImpl, fetchedQaIds };
}

test("default live discovery finds a deep branch QA without promoting or copying it", async () => {
  for (const card of cards) assert.equal(qaIndexes.get(card.id).length, 9);
  assert.equal(qaIndexes.get(branchActor.id).indexOf(branchQaId), 7);

  const fixture = createLiveQaFixture();
  const userQuery = [
    "对方分别用匿名攻击者甲、匿名攻击者乙、匿名攻击者丙攻击我方里侧守备表示的匿名防守者，",
    "这三只攻击怪兽各自是否能战斗破坏它？",
  ].join("");
  const evidence = await retrieveRagEvidence({
    userQuery,
    cardResolution: {
      resolvedCards: cards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records: [],
    qaRecords: [],
    env: { RAG_LIVE_OFFICIAL_QA: "true" },
    fetchImpl: fixture.fetchImpl,
  });

  assert.equal(evidence.debug.liveOfficialQa.strategy, "bounded_round_robin_card_union");
  assert.equal(evidence.debug.liveOfficialQa.candidatePoolSize, 36);
  assert.equal(evidence.debug.liveOfficialQa.fetchedQaCount, 36);
  assert.ok(evidence.debug.liveOfficialQa.ids.includes(branchQaId));
  assert.ok(fixture.fetchedQaIds.includes(branchQaId));

  assert.equal(evidence.officialQaDirectCandidates.length, 0);
  const branchEvidence = evidence.officialQaRelated.find(
    (item) => item.id === `ygoresources-qa-${branchQaId}`,
  );
  assert.ok(branchEvidence, "the eighth branch QA should survive semantic ranking into related evidence");
  assert.equal(branchEvidence.isDirect, false);
  assert.notEqual(branchEvidence.matchLevel, "official_qa_exact");
  assert.ok(branchEvidence.matchedBy.includes("multi_branch_related_evidence"));
  assert.deepEqual(branchEvidence.matchedQuestionCardIds, [branchActor.id]);
  assert.equal(branchEvidence.questionCardIdCoverage, 1 / cards.length);

  const otherActorIds = [cards[1].id, cards[3].id];
  assert.equal(
    otherActorIds.some((id) => branchEvidence.matchedQuestionCardIds.includes(id)),
    false,
  );
  assert.equal(
    otherActorIds.some((id) => branchEvidence.text.includes(cards.find((card) => card.id === id).name)),
    false,
  );
});
