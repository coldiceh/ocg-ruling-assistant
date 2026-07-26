import assert from "node:assert/strict";
import test from "node:test";

import {
  retrieveLiveOfficialQa,
  selectRelevantQaIds,
} from "../backend/liveOfficialQaProvider.mjs";
import { searchOfficialQaEvidence } from "../backend/officialQaMatcher.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const propertyMetadata = Array.from({ length: 25 }, () => ({}));
propertyMetadata[4] = { en: "Effect" };
propertyMetadata[24] = { en: "Rock" };

function liveFetchFixture({ cardIds, qaId, question, answer }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/data/meta/mprop")) return jsonResponse(propertyMetadata);
    const cardMatch = String(url).match(/\/data\/card\/(\d+)$/u);
    if (cardMatch) {
      const id = cardMatch[1];
      return jsonResponse({
        cardData: {
          en: {
            id: Number(id),
            cardType: "monster",
            properties: id === "14741" ? [24, 4] : [4],
          },
        },
        qaIndex: [Number(qaId), Number(qaId) + 1 + cardIds.indexOf(id)],
      });
    }
    if (String(url).endsWith(`/data/qa/${qaId}`)) {
      return jsonResponse({
        cards: cardIds.map(Number),
        qaData: { ja: { id: Number(qaId), title: question, question, answer } },
      });
    }
    throw new Error(`unexpected_url:${url}`);
  };
  return { fetchImpl, calls };
}

test("shared card-QA intersection retrieves the unique official interaction and enriches monster race", async () => {
  const question = "自分または相手のモンスターゾーンに岩石族モンスターが存在し、発動する事はできますか？";
  const fixture = liveFetchFixture({
    cardIds: [13447, 14741],
    qaId: 22803,
    question: `「<<13447>>」の適用中、自分または相手のモンスターゾーンに岩石族モンスターが存在する場合、手札の「<<14741>>」のモンスター効果を発動する事はできますか？`,
    answer: "新たな岩石族モンスターを特殊召喚する効果となるため、発動できません。",
  });
  const cards = [
    { id: "13447", name: "物种配额", jaName: "センサー万別" },
    { id: "14741", name: "陨星巨灵", jaName: "原始生命態ニビル" },
  ];
  const result = await retrieveLiveOfficialQa({ resolvedCards: cards, fetchImpl: fixture.fetchImpl });

  assert.deepEqual(result.debug.ids, ["22803"]);
  assert.equal(result.debug.strategy, "all_resolved_card_intersection");
  assert.equal(result.records[0].sourceId, "22803");
  assert.equal(result.records[0].retrievalContext.uniqueExactCardIntersection, true);
  assert.equal(result.records[0].retrievalContext.candidatePoolComplete, true);
  assert.equal(result.cardMetadata.find((item) => item.id === "14741").race, "Rock");
  assert.equal(fixture.calls.filter((url) => url.includes("/data/qa/")).length, 1);

  const matches = searchOfficialQaEvidence({ question, records: result.records, resolvedCards: cards });
  assert.equal(matches.exact[0]?.record.sourceId, "22803");
  assert.equal(matches.exact[0]?.exactCardIdSet, true);
  assert.ok(matches.exact[0]?.matchedBy.includes("unique_exact_card_set"));
});

test("the Dark-Law-style activation wording is classified and promoted by an exact two-card set", async () => {
  const fixture = liveFetchFixture({
    cardIds: [7445, 11313],
    qaId: 13330,
    question: "相手フィールドに「<<11313>>」が存在する場合、自分は「<<7445>>」を発動する事はできますか？",
    answer: "発動できます。コストは除外され、効果処理でその永続効果の発生源自身を素材にする場合、素材は通常通り墓地へ送られます。",
  });
  const cards = [
    { id: "7445", name: "超融合" },
    { id: "11313", name: "影律英雄", jaName: "M・HERO ダーク・ロウ" },
  ];
  const result = await retrieveLiveOfficialQa({ resolvedCards: cards, fetchImpl: fixture.fetchImpl });
  const matches = searchOfficialQaEvidence({
    question: "对方场上存在M・HERO ダーク・ロウ时，自己能否发动超融合？如果可以，送墓改除外如何适用？",
    records: result.records,
    resolvedCards: cards,
  });

  assert.equal(matches.questionType, "can_activate");
  assert.equal(matches.exact[0]?.record.sourceId, "13330");
  assert.equal(matches.exact[0]?.cardIdCoverage, 1);
});

test("partial card-index failure preserves evidence without unconditional exact promotion", async () => {
  const cards = [
    { id: "100", name: "卡片100" },
    { id: "200", name: "卡片200" },
    { id: "300", name: "附带卡300" },
  ];
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/data/meta/mprop")) return jsonResponse(propertyMetadata);
    if (value.endsWith("/data/card/300")) throw new Error("temporary_index_failure");
    if (/\/data\/card\/(?:100|200)$/u.test(value)) {
      return jsonResponse({ cardData: { en: { cardType: "monster", properties: [4] } }, qaIndex: [500] });
    }
    if (value.endsWith("/data/qa/500")) {
      return jsonResponse({
        cards: [100, 200],
        qaData: { ja: {
          question: "「<<100>>」と「<<200>>」が存在する場合、この効果を発動できますか？",
          answer: "回答",
        } },
      });
    }
    throw new Error(`unexpected_url:${url}`);
  };
  const result = await retrieveLiveOfficialQa({ resolvedCards: cards, fetchImpl });

  assert.equal(result.records[0]?.sourceId, "500");
  assert.equal(result.debug.availableCardIndexCount, 2);
  assert.ok(result.warnings.includes("live_card_qa_index_partial"));
  assert.equal(result.records[0]?.retrievalContext.uniqueExactCardIntersection, false);

  const matches = searchOfficialQaEvidence({
    question: "这个效果在伤害步骤可以发动吗？",
    records: result.records,
    resolvedCards: cards,
  });
  assert.equal(matches.exact.length, 0);
});

test("card-set promotion stays conservative when two compatible QAs share the same exact card set", () => {
  const records = ["a", "b"].map((suffix, index) => ({
    id: `qa-${suffix}`,
    recordType: "qa",
    cardIds: [100, 200],
    question: `「卡片100」「卡片200」の効果を発動する事はできますか？${index ? "別条件" : ""}`,
    answer: "回答",
  }));
  const matches = searchOfficialQaEvidence({
    question: "卡片100和卡片200同时存在时，是否可以发动效果？",
    records,
    resolvedCards: [{ id: "100", name: "卡片100" }, { id: "200", name: "卡片200" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.ok(matches.all.every((item) => !item.matchedBy.includes("unique_exact_card_set")));
});

test("an unrelated single QA is not promoted only because its card set is exact", () => {
  const matches = searchOfficialQaEvidence({
    question: "这个效果在伤害步骤可以发动吗？",
    records: [{
      id: "qa-unrelated",
      recordType: "qa",
      cardIds: [100, 200],
      question: "「卡片100」「卡片200」が存在する場合、第三张卡的效果可以发动吗？",
      answer: "回答",
    }],
    resolvedCards: [{ id: "100", name: "卡片100" }, { id: "200", name: "卡片200" }],
  });

  assert.equal(matches.exact.length, 0);
});

test("a unique broad official QA can govern two listed example cards", () => {
  const matches = searchOfficialQaEvidence({
    question: "卡片100的持续效果适用中，可以发动卡片200吗？",
    records: [{
      id: "qa-broad-examples",
      recordType: "qa",
      cardIds: [100, 200, 300, 400],
      question: "Can the effect be activated while the continuous effect is applying?",
      answer: "Cards <<100>>, <<200>>, <<300>>, and <<400>> follow this ruling.",
    }],
    resolvedCards: [{ id: "100", name: "卡片100" }, { id: "200", name: "卡片200" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.equal(matches.all[0]?.record.id, "qa-broad-examples");
});

test("two broad QAs listing the same cards remain ambiguous", () => {
  const records = ["a", "b"].map((suffix) => ({
    id: `qa-broad-${suffix}`,
    recordType: "qa",
    cardIds: [100, 200, 300],
    question: "Can the effect be activated while the continuous effect is applying?",
    answer: "Answer",
  }));
  const matches = searchOfficialQaEvidence({
    question: "卡片100的持续效果适用中，可以发动卡片200吗？",
    records,
    resolvedCards: [{ id: "100", name: "卡片100" }, { id: "200", name: "卡片200" }],
  });

  assert.equal(matches.exact.length, 0);
});

test("card-text dependency expansion does not pollute the queried card identity set", async () => {
  const cards = [
    { id: "100", name: "卡片100", effectText: "效果100" },
    { id: "200", name: "卡片200", effectText: "效果200" },
    { id: "300", name: "卡文依赖300", effectText: "效果300" },
  ];
  const evidence = await retrieveRagEvidence({
    userQuery: "卡片100存在时，可以发动卡片200吗？",
    cardResolution: {
      resolvedCards: [
        { ...cards[0], resolutionSource: "query" },
        { ...cards[1], resolutionSource: "query" },
        { ...cards[2], resolutionSource: "card_text_reference" },
      ],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records: [],
    qaRecords: [{
      id: "qa-query-pair",
      recordType: "qa",
      cardIds: ["100", "200"],
      question: "卡片100存在时，可以发动卡片200吗？",
      answer: "可以发动。",
    }],
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.equal(evidence.officialQaDirectCandidates[0]?.id, "qa-query-pair");
  assert.ok(evidence.retrievalWarnings.includes("qa_identity_excludes_card_text_references:1"));
});

test("a unique exact alias canonicalizes an external passcode only for QA identity matching", async () => {
  const externalCard = {
    id: "87654321",
    cardId: "87654321",
    name: "公开手牌效果",
    aliases: ["公开手牌效果"],
    resolutionSource: "query",
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "公开手牌效果适用中，我方能发动展示手续卡吗？",
    cardResolution: {
      resolvedCards: [
        externalCard,
        { id: "200", name: "展示手续卡", aliases: ["展示手续卡"], resolutionSource: "query" },
      ],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [
      { id: "12345", name: "公开手牌效果", aliases: ["公开手牌效果"], effectText: "双方手牌公开。" },
      { id: "200", name: "展示手续卡", aliases: ["展示手续卡"], effectText: "给对方观看手牌并发动。" },
    ],
    records: [],
    qaRecords: [{
      id: "qa-broad-reveal-procedure",
      recordType: "qa",
      cardIds: ["12345", "200", "300"],
      question: "手牌已经公开时，能发动需要展示手牌作为手续的效果吗？",
      answer: "不能发动。公开手牌效果与展示手续卡均适用此规则。",
    }],
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.equal(externalCard.id, "87654321");
  assert.equal(evidence.officialQaDirectCandidates.length, 0);
  assert.ok(evidence.officialQaRelated.some((item) => item.id === "qa-broad-reveal-procedure"));
  assert.ok(evidence.retrievalWarnings.includes("qa_identity_canonicalized:87654321->12345"));
});

test("QA selection prioritizes full intersection and remains bounded", () => {
  const selected = selectRelevantQaIds([
    { cardId: "1", qaIds: [90, 91, 92, 93] },
    { cardId: "2", qaIds: [93, 91, 94] },
    { cardId: "3", qaIds: [95, 91, 93] },
  ], 1);
  assert.deepEqual(selected.ids, ["91"]);
  assert.equal(selected.candidatePoolSize, 2);
});
