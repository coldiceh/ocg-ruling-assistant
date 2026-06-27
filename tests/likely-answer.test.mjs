import assert from "node:assert/strict";
import test from "node:test";
import {
  answerEachSubQuestion,
  buildCardNameConfirmationRequests,
  mergeModelAnswer,
} from "../backend/engine.mjs";
import { buildLikelyAnswer } from "../backend/likelyAnswer.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";
import { buildSmokeReport } from "../scripts/smoke-real-questions.mjs";

test("no direct evidence can produce a likelyAnswer while final status remains unknown", () => {
  const formalQuery = formal({
    type: "temporary_banish",
    card: "完美世界-卡通世界",
    askedResult: "can_banish_that_toon_monster",
  });
  const answer = answerEachSubQuestion(formalQuery, {
    bySubQuestion: [{
      subQuestionId: "q1",
      cardTextEvidence: [{ evidenceId: "card-text:23161", conclusion: "可以把卡通怪兽除外到效果处理后。" }],
      rulingEvidence: [],
      similarRulingEvidence: [],
      rejectedEvidence: [],
    }],
  }, { records: [] })[0];
  assert.equal(answer.status, "unknown");
  assert.equal(answer.officialAnswer.status, "not_found");
  assert.equal(answer.likelyAnswer.status, "best_effort");
  assert.match(answer.likelyAnswer.disclaimer, /未确认裁定/);
});

test("likelyAnswer does not increase confirmed counters", () => {
  const report = buildSmokeReport([{
    id: "likely-only",
    finalStatus: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      reason: "no_direct_evidence",
      evidenceIds: [],
      directEvidenceCount: 0,
      extractedVerdict: "unknown",
      likelyAnswer: { status: "best_effort", verdict: "unknown", reasoning: "未确认。", basis: ["card_text"], riskFlags: [] },
      presentation: { reason: "找到的资料与本题相关，但没有直接回答当前问题。" },
    }],
  }]);
  assert.equal(report.confirmed, 0);
  assert.equal(report.officialConfirmedCount, 0);
  assert.equal(report.likelyAnswerCount, 1);
  assert.equal(report.unsafeConfirmedCount, 0);
});

test("long unresolved card name does not silently degrade to a shorter contained card", () => {
  const shortCard = {
    id: "2390",
    name: "青眼究极龙",
    cnName: "青眼究极龙",
    aliases: ["青眼究极龙"],
  };
  const issues = buildCardNameConfirmationRequests(
    "卡通青眼究极龙可以发动效果吗？",
    [{ ...shortCard, matched: "青眼究极龙" }],
    [shortCard]
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].unresolvedCardName, "卡通青眼究极龙");
  assert.equal(issues[0].candidateCards[0].name, "青眼究极龙");
});

test("user-facing summary does not expose internal reason codes", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
    reason: "similar_evidence:evidence_mentions_action_but_not_asked_result",
  });
  assert.doesNotMatch(summary.reason, /similar_evidence|evidence_mentions_action_but_not_asked_result/u);
  assert.match(summary.reason, /没有直接回答当前问题/);
});

test("conflicting evidence likelyAnswer carries risk flags", () => {
  const likely = buildLikelyAnswer({
    subQuestion: { type: "activation_condition", sourceText: "能否发动？" },
    rejectedEvidence: [{ rejectedReason: "conflicting_direct_evidence" }],
  });
  assert.equal(likely.status, "best_effort");
  assert.ok(likely.riskFlags.includes("conflicting_evidence"));
});

test("card unresolved likelyAnswer does not generate a ruling conclusion", () => {
  const likely = buildLikelyAnswer({
    subQuestion: { type: "activation_condition", sourceText: "卡通青眼究极龙能发动吗？" },
    cardResolutionIssue: {
      unresolvedCardName: "卡通青眼究极龙",
      candidateCards: [{ name: "青眼究极龙" }],
    },
  });
  assert.equal(likely.status, "not_available");
  assert.equal(likely.verdict, "unknown");
  assert.ok(likely.riskFlags.includes("card_name_unresolved"));
});

test("provisional screenshot is exposed as provisional, not confirmed", () => {
  const likely = buildLikelyAnswer({
    subQuestion: { type: "activation_condition", sourceText: "能否发动？" },
    provisionalAnswer: {
      verdict: { activation: "can_activate" },
      explanation: "事务局截图显示可以发动，但 DB 未收录。",
    },
  });
  assert.equal(likely.status, "provisional");
  assert.deepEqual(likely.basis, ["official_response_screenshot"]);
});

test("official direct evidence keeps officialAnswer ahead of likelyAnswer", () => {
  const qa = {
    id: "qa-can",
    recordType: "qa",
    title: "三战之才 Q&A",
    question: "对方在自己的主要阶段把怪兽的效果发动的场合，可以发动三战之才吗？",
    conclusion: "可以发动。",
    cards: ["三战之才"],
    cardIds: ["15296"],
    questionTypes: ["activation_condition"],
    sourceType: "official_qa",
  };
  const answer = answerEachSubQuestion(formal({
    type: "activation_condition",
    card: "三战之才",
    askedResult: "can_activate",
  }), {
    bySubQuestion: [{
      subQuestionId: "q1",
      rulingEvidence: [{ ...qa, evidenceId: qa.id }],
      similarRulingEvidence: [],
      rejectedEvidence: [],
      cardTextEvidence: [],
    }],
  }, { records: [qa] })[0];
  assert.equal(answer.status, "confirmed");
  assert.equal(answer.officialAnswer.status, "confirmed");
  assert.equal(answer.likelyAnswer, undefined);
});

test("AI explanation cannot turn likelyAnswer into confirmed", () => {
  const program = {
    status: "unknown",
    verdict: "unknown",
    evidenceIds: [],
    likelyAnswer: { status: "best_effort", verdict: "can" },
  };
  const merged = mergeModelAnswer({
    explanationText: "模型解释",
    status: "confirmed",
    verdict: "can",
    likelyAnswer: { status: "confirmed", verdict: "can" },
  }, program);
  assert.equal(merged.status, "unknown");
  assert.equal(merged.verdict, "unknown");
  assert.equal(merged.likelyAnswer.status, "best_effort");
  assert.ok(merged.warnings.includes("model_status_or_verdict_ignored"));
});

function formal({ type, card, askedResult }) {
  return {
    originalText: "测试问题",
    cards: [{ name: card, role: "question_card" }],
    scenario: { rawContext: "" },
    subQuestions: [{
      id: "q1",
      type,
      card,
      askedResult,
      sourceText: "测试问题",
    }],
  };
}
