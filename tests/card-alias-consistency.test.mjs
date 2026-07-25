import assert from "node:assert/strict";
import test from "node:test";

import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { analyzeEffectStateTransition, attachUserQueryToCardTexts } from "../backend/effectStateReasoner.mjs";

const shortQuestion = "对方场上有一个b2b，导致我方场上的4+4变成了6+6。这个情况下假如我方额外只有8星同调而没有12星同调的话，可以发动异界共鸣吗";
const fullQuestion = "对方场上有一个《杀手级调整曲 B2B》，导致我方场上的2只四星怪兽变成了2只六星怪兽，这个情况下假如我方额外只有一只可以同调召唤的8星同调怪兽而没有12星同调怪兽的话，可以发动【异界共鸣-同调融合】吗";

test("unique short aliases and translated partial names resolve to the same cards as full names", async () => {
  const data = await loadRagData();
  const shortResolution = extractRagCards(shortQuestion, { cards: data.cards, maxCards: 8 });
  const fullResolution = extractRagCards(fullQuestion, { cards: data.cards, maxCards: 8 });
  const expectedIds = new Set(["19046", "22551"]);

  assert.deepEqual(new Set(shortResolution.resolvedCards.map((card) => String(card.id))), expectedIds);
  assert.deepEqual(new Set(fullResolution.resolvedCards.map((card) => String(card.id))), expectedIds);
  assert.deepEqual(shortResolution.unresolvedMentions, []);
  assert.deepEqual(fullResolution.unresolvedMentions, []);
});

test("passive alias scanning does not extract short card names from inside longer quoted names", async () => {
  const data = await loadRagData();
  const resolution = extractRagCards(
    "「道化の一座 ホワイトフェイス」の②の効果を発動した場合、「ラーの翼神竜－球体形」をアドバンス召喚できますか？",
    { cards: data.cards, maxCards: 8 },
  );
  const queryIds = resolution.resolvedCards
    .filter((card) => card.resolutionSource !== "card_text_reference")
    .map((card) => String(card.id));

  assert.deepEqual(new Set(queryIds), new Set(["22524", "11927"]));
  assert.ok(!resolution.resolvedCards.some((card) => String(card.id) === "4030"));
});

test("equivalent short and full questions retrieve the same governing FAQ without a network fallback", async () => {
  const data = await loadRagData();
  const results = [];

  for (const question of [shortQuestion, fullQuestion]) {
    let fetchCalls = 0;
    const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });
    const evidence = await retrieveRagEvidence({
      userQuery: question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("network fallback should not run");
      },
    });
    results.push({
      ids: evidence.retrievedCards.map((card) => String(card.id)).sort(),
      faqIds: evidence.faqRelated.map((item) => String(item.id)),
      fetchCalls,
    });
  }

  for (const result of results) {
    assert.deepEqual(result.ids, ["19046", "22551"]);
    assert.equal(result.fetchCalls, 0);
    assert.ok(result.faqIds.includes("card-faq-19046-1"));
    assert.ok(!result.faqIds.some((id) => id.startsWith("card-faq-10340-")));
  }
});

test("both original B2B phrasings run through the same post-cost state simulation", async () => {
  const data = await loadRagData();
  for (const question of [shortQuestion, fullQuestion]) {
    const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });
    const evidence = await retrieveRagEvidence({
      userQuery: question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
    });
    const transition = analyzeEffectStateTransition({
      userQuery: question,
      resolvedCards: cardResolution.resolvedCards,
      cardTexts: attachUserQueryToCardTexts(evidence.cardTexts, question),
    });

    assert.equal(transition.status, "resolved", JSON.stringify(transition.debug));
    assert.equal(transition.complete, true);
    assert.equal(transition.sourceDefinitionId, "19046");
    assert.match(transition.shortAnswer, /^可以发动/u);
    assert.match(transition.shortAnswer, /4\+4（合计8）/u);
    assert.match(transition.shortAnswer, /没有12星同步怪兽不影响/u);
  }
});

test("a shared short fragment is not resolved when it identifies multiple cards", () => {
  const cards = [
    { id: "a", name: "测试卡 A1B", aliases: ["Alpha A1B"] },
    { id: "b", name: "另一测试卡 A1B", aliases: ["Beta A1B"] },
  ];
  const resolution = extractRagCards("对方场上有一个A1B，这个效果如何处理？", { cards });

  assert.deepEqual(resolution.resolvedCards, []);
});

test("resolved cards preserve normalized structured fields for downstream state reasoning", () => {
  const cards = [{
    id: "fictional-1",
    name: "架空语义龙",
    aliases: ["Fictional Semantic Dragon"],
    type: "monster",
    cardType: "monster",
    race: "Dragon",
    attribute: "light",
    attack: 2500,
    defense: 2000,
    level: 8,
    propertyIds: ["21", "4"],
    properties: ["Dragon", "Effect"],
    monsterPropertyIds: ["21", "4"],
    monsterProperties: ["Dragon", "Effect"],
  }];
  const resolution = extractRagCards("发动「架空语义龙」的效果。", { cards });
  const [resolved] = resolution.resolvedCards;

  assert.equal(resolved.type, "monster");
  assert.equal(resolved.race, "Dragon");
  assert.equal(resolved.attribute, "light");
  assert.equal(resolved.attack, 2500);
  assert.equal(resolved.defense, 2000);
  assert.equal(resolved.level, 8);
  assert.deepEqual(resolved.monsterProperties, ["Dragon", "Effect"]);
});

test("quoted card roles exclude dynamic names, archetype labels, and quoted effect clauses", async () => {
  const data = await loadRagData();
  const cases = [
    {
      question: "「妖精の王子様」として扱われている「閃刀姫」リンクモンスターが相手の効果でフィールドから離れた場合、または戦闘で破壊された場合、「閃刀姫－レイ」の②の効果は発動できますか？",
      expectedId: "13670",
      excludedMentions: ["妖精の王子様", "閃刀姫"],
      modelCandidates: ["妖精の王子様", "閃刀姫", "閃刀姫－レイ"],
    },
    {
      question: "表側表示の「方界」と名のついたモンスターがデッキに戻った場合、墓地の「方界合神」の効果を発動できますか？",
      expectedId: "12528",
      excludedMentions: ["方界"],
      modelCandidates: ["方界", "方界合神"],
    },
    {
      question: "手札の「灰流うらら」の効果の発動にチェーンして『その発動を無効にし、そのカードを持ち主のデッキに戻す』効果を発動した場合、処理はどうなりますか？",
      expectedId: "12950",
      excludedMentions: ["その発動を無効にし、そのカードを持ち主のデッキに戻す"],
    },
  ];

  for (const item of cases) {
    const resolution = extractRagCards(item.question, {
      cards: data.cards,
      maxCards: 8,
      modelCardNameCandidates: item.modelCandidates || [],
    });
    assert.ok(resolution.resolvedCards.some((card) => String(card.id) === item.expectedId));
    const unresolvedInputs = resolution.unresolvedMentions.map((mention) => mention.input);
    const ambiguousInputs = resolution.ambiguousMentions.map((mention) => mention.input);
    for (const excludedMention of item.excludedMentions) {
      assert.ok(!unresolvedInputs.includes(excludedMention));
      assert.ok(!ambiguousInputs.includes(excludedMention));
    }
  }
});

test("exact card dependencies named by a resolved card's own text are expanded one hop", async () => {
  const data = await loadRagData();
  const cases = [
    {
      question: "「滅びの爆裂疾風弾」を先攻1ターン目に発動する事はできますか？",
      expectedIds: new Set(["5979", "4007"]),
    },
    {
      question: "リンク先にモンスターが特殊召喚された際に発動した「サイバース・ウィッチ」のモンスター効果の処理時に、自分のデッキに手札に加えられるカードのいずれかが存在しなくなっている場合、処理はどうなりますか？",
      expectedIds: new Set(["13751", "13767"]),
    },
  ];

  for (const item of cases) {
    const resolution = extractRagCards(item.question, { cards: data.cards, maxCards: 8 });
    assert.deepEqual(new Set(resolution.resolvedCards.map((card) => String(card.id))), item.expectedIds);
    const referencedCards = resolution.resolvedCards.filter((card) => (
      !item.question.normalize("NFKC").includes(String(card.input || "").normalize("NFKC"))
    ));
    assert.ok(referencedCards.length >= 1);
    assert.ok(referencedCards.every((card) => card.resolutionSource === "card_text_reference"));
    assert.deepEqual(resolution.unresolvedMentions, []);
    assert.deepEqual(resolution.ambiguousMentions, []);
  }
});

test("unquoted active-effect carrier syntax extracts arbitrary names but rejects ordinary game phrases", () => {
  const reported = extractRagCards("我方看透心灵之眼适用中，对方发动怪兽效果。", { cards: [] });
  const fictional = extractRagCards("对方寂静回声的效果生效中，但场上没有其他卡。", { cards: [] });
  const ordinary = extractRagCards("我方效果适用中，场上怪兽的攻击力不变。", { cards: [] });

  assert.ok(reported.unresolvedMentions.some((mention) => mention.input === "看透心灵之眼"));
  assert.ok(fictional.unresolvedMentions.some((mention) => mention.input === "寂静回声"));
  assert.ok(!ordinary.unresolvedMentions.some((mention) => ["效果", "怪兽效果", "场上怪兽"].includes(mention.input)));
});
