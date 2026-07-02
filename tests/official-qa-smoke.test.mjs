import assert from "node:assert/strict";
import test from "node:test";
import { routeAnswer, selectOfficialQaRoute } from "../backend/answerRouter.mjs";
import { extractOfficialQaAnswer } from "../backend/officialQaAnswerExtractor.mjs";
import { searchOfficialQaEvidence, resolveEntitiesFromOfficialQaMatch } from "../backend/officialQaMatcher.mjs";
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

test("Fast Judge failure cannot override an official direct answer", async () => {
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
  assert.equal(answer.answerRoute, "official_qa_exact_match");
  assert.equal(answer.confirmationLevel, "official_confirmed");
  assert.equal(modelCalled, false);
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

test("related official evidence produces a conditional route rather than unable", () => {
  const answer = routeAnswer({
    conditionalAnswer: { answerType: "needs_clarification", verdict: "insufficient_for_single_verdict", shortAnswer: "如果对象仍合法则处理；否则不适用。" },
  });
  assert.equal(answer.answerRoute, "conditional_branch_answer");
  assert.notEqual(answer.answerType, "cannot_answer_safely");
});
