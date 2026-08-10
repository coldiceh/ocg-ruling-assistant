import assert from "node:assert/strict";
import test from "node:test";
import { routeAnswer, selectOfficialQaRoute } from "../backend/answerRouter.mjs";
import {
  extractOfficialQaAnswer,
  extractRelevantOfficialQaAnswerExcerpt,
} from "../backend/officialQaAnswerExtractor.mjs";
import {
  classifyOfficialQaQuestionType,
  searchOfficialQaEvidence,
  resolveEntitiesFromOfficialQaMatch,
} from "../backend/officialQaMatcher.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

const fresh = { freshness: "fresh", safetyPenalty: 0 };

function qa({ id = "qa-1", question, answer, cardIds = ["1"], cards = ["测试卡"] }) {
  return { id, recordType: "qa", question, answer, text: `${question}\n${answer}`, cardIds, cards, evidenceStatus: "current", sourceType: "official_qa" };
}

test("official original Japanese question returns its official answer directly", () => {
  const question = "この効果はダメージステップでも発動できますか？";
  const matches = searchOfficialQaEvidence({ question, records: [qa({ question, answer: "はい、発動できます。" })] });
  const route = selectOfficialQaRoute({ matches, freshness: fresh });
  assert.equal(route.level, "official_qa_exact_match");
  assert.equal(route.answer.confirmationLevel, "official_confirmed");
  assert.match(route.answer.shortAnswer, /発動できます/u);
});

test("normalized punctuation and full-width variants still match official original", () => {
  const record = qa({ question: "「テスト・カード」の効果は、発動できますか？", answer: "はい、発動できます。" });
  const matches = searchOfficialQaEvidence({ question: "『テスト カード』の効果は発動できますか?", records: [record] });
  assert.equal(matches.exact[0].id, "qa-1");
});

test("a card-name-agnostic question skeleton cannot directly match a different card", () => {
  const record = qa({
    question: "「测试甲卡」的效果可以发动吗？",
    answer: "可以发动。",
    cardIds: ["101"],
    cards: ["测试甲卡"],
  });
  const matches = searchOfficialQaEvidence({
    question: "「测试乙卡」的效果可以发动吗？",
    records: [record],
    resolvedCards: [{ id: "202", name: "测试乙卡" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.ok(matches.all[0]?.matchedBy.includes("card_name_agnostic_skeleton"));
  assert.equal(matches.all[0]?.identityCompatibleForExact, false);
});

test("mixed Japanese card name and Chinese question can use a near official case", () => {
  const record = qa({ question: "「S：Pリトルナイト」のコントロールが移った場合、誰が効果を発動できますか？", answer: "その時点で自分がコントロールしているので、自分が発動できます。", cards: ["S：Pリトルナイト"] });
  const matches = searchOfficialQaEvidence({ question: "S：Pリトルナイト的控制权在连锁处理后转移，谁可以发动效果？", records: [record], resolvedCards: [{ id: "1", name: "S：Pリトルナイト" }] });
  assert.ok(matches.near.length || matches.exact.length);
  const route = selectOfficialQaRoute({ matches, freshness: fresh });
  assert.ok(["official_qa_near_case_match", "official_qa_exact_match"].includes(route.level));
});

test("who_can_activate is rendered with a player subject, not a card subject", () => {
  const question = "控制权转移后，谁可以发动这个效果？";
  const matches = searchOfficialQaEvidence({ question, records: [qa({ question, answer: "在该时点由自己控制，因此自己可以发动这个效果。" })] });
  const answer = selectOfficialQaRoute({ matches, freshness: fresh }).answer;
  assert.equal(answer.verdict, "self_can_activate");
  assert.match(answer.shortAnswer, /由自己发动/u);
  assert.doesNotMatch(answer.shortAnswer, /测试卡：可以发动/u);
});

test("official extractor preserves explicit answer instead of replacing it with card text", () => {
  const extracted = extractOfficialQaAnswer(qa({ question: "这张卡能发动吗？", answer: "不可以发动。" }), { questionType: "can_activate" });
  assert.equal(extracted.verdict, "cannot_activate");
  assert.equal(extracted.answerText, "不可以发动。");
});

test("official extractor removes a repeated truncated title between the question and answer", () => {
  const question = "不能作为融合召唤素材的怪兽可以用于这个特殊召唤手续吗?";
  const title = "不能作为融合召唤素材的怪兽可以用于这个特殊召唤手续吗…";
  const extracted = extractOfficialQaAnswer({
    title,
    text: `${question} ${title} 可以送去墓地并特殊召唤。这次特殊召唤不是融合召唤。`,
  });

  assert.equal(extracted.answerText, "可以送去墓地并特殊召唤。这次特殊召唤不是融合召唤。");
});

test("official answer excerpt removes a dense following-card catalogue but keeps the ruling", () => {
  const catalogue = Array.from({ length: 16 }, (_, index) => `「<<${23000 + index}>>」①`).join("\n");
  const answer = [
    "可以发动。",
    "处理时仍会进行特殊召唤。",
    "但是，处理时对象已经不在场上的场合不进行后续处理。",
    "例として、以下のカードの効果も同様に処理します。",
    "モンスター効果",
    catalogue,
    "CATALOGUE_END",
  ].join("\n");

  const excerpt = extractRelevantOfficialQaAnswerExcerpt({ answer });

  assert.match(excerpt, /可以发动/u);
  assert.match(excerpt, /对象已经不在场上的场合不进行后续处理/u);
  assert.match(excerpt, /以下のカードの効果も同様/u);
  assert.doesNotMatch(excerpt, /<<23000>>/u);
  assert.doesNotMatch(excerpt, /CATALOGUE_END/u);
});

test("official answer excerpt keeps an ordinary long prose tail and its final exception", () => {
  const answer = `可以发动。${"这是普通的说明文字。".repeat(240)}最后的例外：本回合不能再次发动。`;

  const excerpt = extractRelevantOfficialQaAnswerExcerpt({ answer });

  assert.equal(excerpt, answer);
  assert.match(excerpt, /最后的例外：本回合不能再次发动/u);
});

test("Fast Judge requires canonical identity binding before an official direct answer", async () => {
  let modelCalled = false;
  const question = "这张测试卡能发动吗？";
  const answer = await answerRulingQuestionFast({
    question,
    snapshot: {
      cards: [],
      records: [qa({ question, answer: "可以发动。" })],
      snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
    },
    modelInvoker: async () => { modelCalled = true; return null; },
  });
  assert.notEqual(answer.answerType, "direct_official");
  assert.equal(modelCalled, true);
});

test("scope mismatch stays related and cannot become direct", () => {
  const record = qa({ question: "连接召唤成功时，交织绵羊的效果可以发动吗？", answer: "可以发动。", cards: ["交织绵羊"] });
  const matches = searchOfficialQaEvidence({ question: "效果处理中墓地变化时，彼岸怪兽的自坏永续效果会插入处理吗？", records: [record] });
  assert.equal(matches.exact.length, 0);
  assert.equal(matches.near.length, 0);
});

test("raw Q&A match can disambiguate an unresolved card candidate", () => {
  const question = "「测试卡别称」能发动吗？";
  const record = qa({ question, answer: "可以发动。", cardIds: ["88"], cards: ["测试正式卡"] });
  const matches = searchOfficialQaEvidence({ question, records: [record] });
  const entity = resolveEntitiesFromOfficialQaMatch({
    resolution: { resolvedCards: [], unresolvedCards: [{ unresolvedCardName: "测试卡别称", candidateCards: [{ name: "测试正式卡", cardId: "88" }] }] },
    matches,
    cards: [{ id: "88", name: "测试正式卡", aliases: ["测试正式卡"] }],
  });
  assert.equal(entity.resolvedByOfficialQaMatch, true);
  assert.equal(entity.resolvedCards[0].id, "88");
});

test("near official case is conditional, never official confirmed", () => {
  const record = qa({ question: "控制权转移后，谁可以发动这个效果？", answer: "当时的控制者可以发动。" });
  const matches = searchOfficialQaEvidence({ question: "连锁处理后控制权已经转移，这个诱发效果由谁发动？", records: [record], resolvedCards: [{ id: "1", name: "测试卡" }] });
  const route = selectOfficialQaRoute({ matches, freshness: fresh });
  assert.equal(route.level, "official_qa_near_case_match");
  assert.equal(route.answer.confirmationLevel, "conditional_official_case");
});

test("an otherwise similar official Q&A with the opposite activation actor stays related", () => {
  const matches = searchOfficialQaEvidence({
    question: "我方可以发动『测试响应卡』的效果吗？",
    records: [qa({
      question: "对方可以发动『测试响应卡』的效果吗？",
      answer: "可以发动。",
      cardIds: ["91"],
      cards: ["测试响应卡"],
    })],
    resolvedCards: [{ id: "91", name: "测试响应卡" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.equal(matches.near.length, 0);
  assert.equal(matches.all[0]?.matchLevel, "official_related");
  assert.equal(matches.all[0]?.playerRoleCompatibility, "mismatch");
  assert.ok(matches.all[0]?.playerRoleMismatches.some((item) => (
    item.dimension === "action_actor" && item.qualifier === "activate"
  )));
  assert.equal(matches.all[0]?.authoritativeSceneMatch, false);
});

test("an otherwise similar official Q&A with the opposite card controller stays related", () => {
  const resolvedCards = [
    { id: "92", name: "测试持续卡" },
    { id: "93", name: "测试动作卡" },
  ];
  const matches = searchOfficialQaEvidence({
    question: "我方场上的『测试持续卡』适用中，『测试动作卡』可以发动吗？",
    records: [qa({
      question: "对方场上的『测试持续卡』适用中，『测试动作卡』可以发动吗？",
      answer: "不能发动。",
      cardIds: ["92", "93"],
      cards: ["测试持续卡", "测试动作卡"],
    })],
    resolvedCards,
  });

  assert.equal(matches.exact.length, 0);
  assert.equal(matches.all[0]?.matchLevel, "official_related");
  assert.equal(matches.all[0]?.playerRoleCompatibility, "mismatch");
  assert.ok(matches.all[0]?.playerRoleMismatches.some((item) => (
    item.dimension === "card_controller" && item.cardId === "92"
  )));
});

test("relative roles found only in an answer or quoted card text cannot hard-demote a Q&A", () => {
  const matches = searchOfficialQaEvidence({
    question: "『测试手续卡』可以发动吗？",
    records: [{
      id: "qa-relative-role-answer-only",
      recordType: "qa",
      title: "『测试手续卡』的发动手续",
      text: [
        "『测试手续卡』的发动手续",
        "参考卡文写有『对方必须公开手牌』，回答中也可能写有『自己确认对方手牌』。",
      ].join("\n"),
      cardIds: ["94"],
      cards: ["测试手续卡"],
    }],
    resolvedCards: [{ id: "94", name: "测试手续卡" }],
  });

  assert.notEqual(matches.all[0]?.playerRoleCompatibility, "mismatch");
  assert.deepEqual(matches.all[0]?.playerRoleMismatches, []);
});

test("related official evidence produces a conditional route rather than unable", () => {
  const answer = routeAnswer({
    conditionalAnswer: { answerType: "needs_clarification", verdict: "insufficient_for_single_verdict", shortAnswer: "如果对象仍合法则处理；否则不适用。" },
  });
  assert.equal(answer.answerRoute, "conditional_branch_answer");
  assert.notEqual(answer.answerType, "cannot_answer_safely");
});

test("plain Chinese '能发动' wording is classified as an activation question", () => {
  assert.equal(classifyOfficialQaQuestionType("我方能发动这张卡吗？"), "can_activate");
});

test("a card-name translation difference remains near until role identity is proven", () => {
  const matches = searchOfficialQaEvidence({
    question: "「译名乙」在先攻第1回合可以发动吗？",
    records: [qa({
      question: "「正式名甲」在先攻第1回合可以发动吗？",
      answer: "可以发动。",
      cardIds: ["100"],
      cards: ["正式名甲"],
    })],
    resolvedCards: [{ id: "100", name: "译名乙" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.equal(matches.all[0]?.record.id, "qa-1");
  assert.ok(matches.all[0]?.matchedBy.includes("card_name_agnostic_skeleton"));
});

test("the unique QA whose question contains every queried card wins over answer-only example mentions", () => {
  const records = [
    {
      id: "qa-target",
      recordType: "qa",
      cardIds: ["100", "200", "300"],
      questionCardIds: ["100", "200"],
      question: "卡片100适用中，能发动卡片200吗？",
      answer: "可以。",
    },
    {
      id: "qa-answer-only",
      recordType: "qa",
      cardIds: ["100", "200", "300"],
      questionCardIds: ["100", "300"],
      question: "卡片100适用中，能发动卡片300吗？",
      answer: "卡片200也属于其他示例。",
    },
  ];
  const matches = searchOfficialQaEvidence({
    question: "卡片100适用中，我方能发动卡片200吗？",
    records,
    resolvedCards: [{ id: "100", name: "卡片100" }, { id: "200", name: "卡片200" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.equal(matches.all[0]?.record.id, "qa-target");
});

test("a unique cross-language card-name declaration scene remains near until its role graph is proven", () => {
  const matches = searchOfficialQaEvidence({
    question: "「测试怪兽」と宣言して「测试学都」②の効果を発動できますか？",
    records: [{
      id: "qa-cross-language-scene",
      recordType: "qa",
      cardIds: ["100", "200"],
      questionCardIds: ["100", "200"],
      question: "When activating <<200>>'s effect, can I declare the card name of <<100>>?",
      answer: "Yes. You cannot declare that same card name again this turn.",
    }],
    resolvedCards: [{ id: "100", name: "测试怪兽" }, { id: "200", name: "测试学都" }],
  });

  assert.equal(matches.exact.length, 0);
  assert.equal(matches.all[0]?.authoritativeSceneMatch, false);
  assert.deepEqual(matches.all[0]?.distinctiveSemanticHits, ["declare_card_name"]);
});

test("an exact card set with a different operation is not authoritative", () => {
  const matches = searchOfficialQaEvidence({
    question: "「测试怪兽」と宣言して「测试学都」②の効果を発動できますか？",
    records: [{
      id: "qa-different-operation",
      recordType: "qa",
      cardIds: ["100", "200"],
      questionCardIds: ["100", "200"],
      question: "Can <<100>> be Special Summoned while the effect of <<200>> is applying?",
      answer: "Yes.",
    }],
    resolvedCards: [{ id: "100", name: "测试怪兽" }, { id: "200", name: "测试学都" }],
  });

  assert.equal(matches.all[0]?.authoritativeSceneMatch, false);
});

test("conflicting effect numbers prevent an authoritative scene match", () => {
  const matches = searchOfficialQaEvidence({
    question: "可以宣言「测试怪兽」发动「测试学都」②效果吗？",
    records: [{
      id: "qa-wrong-effect-number",
      recordType: "qa",
      cardIds: ["100", "200"],
      questionCardIds: ["100", "200"],
      question: "可以宣言「测试怪兽」发动「测试学都」①效果吗？",
      answer: "可以。",
    }],
    resolvedCards: [{ id: "100", name: "测试怪兽" }, { id: "200", name: "测试学都" }],
  });

  assert.equal(matches.all[0]?.effectNumberCompatible, false);
  assert.equal(matches.all[0]?.authoritativeSceneMatch, false);
});

test("two same-card same-operation scenes remain non-authoritative", () => {
  const records = ["a", "b"].map((suffix) => ({
    id: `qa-declare-${suffix}`,
    recordType: "qa",
    cardIds: ["100", "200"],
    questionCardIds: ["100", "200"],
    question: `When activating <<200>>'s effect, can I declare the card name of <<100>>? ${suffix}`,
    answer: "Yes.",
  }));
  const matches = searchOfficialQaEvidence({
    question: "「测试怪兽」と宣言して「测试学都」②の効果を発動できますか？",
    records,
    resolvedCards: [{ id: "100", name: "测试怪兽" }, { id: "200", name: "测试学都" }],
  });

  assert.ok(matches.all.every((item) => item.authoritativeSceneMatch === false));
});
