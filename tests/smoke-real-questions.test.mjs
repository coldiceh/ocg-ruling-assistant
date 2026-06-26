import assert from "node:assert/strict";
import test from "node:test";
import { buildSmokeReport } from "../scripts/smoke-real-questions.mjs";

test("smoke report safety counters reject unsafe confirmed answers", () => {
  const report = buildSmokeReport([
    {
      id: "safe-confirmed",
      finalStatus: "confirmed",
      subAnswers: [{
        questionId: "q1",
        status: "confirmed",
        reason: "explicit",
        evidenceIds: ["qa-1"],
        directEvidenceCount: 1,
        extractedVerdict: "can",
      }],
    },
    {
      id: "safe-unknown",
      finalStatus: "unknown",
      conditionalAnswer: { clarificationQuestion: "请补充状态。" },
      subAnswers: [{
        questionId: "q1",
        status: "unknown",
        reason: "condition_branch_missing_state",
        evidenceIds: [],
        directEvidenceCount: 1,
        extractedVerdict: "unknown",
        conditionalAnswer: { clarificationQuestion: "请补充状态。" },
      }],
    },
    {
      id: "safe-provisional",
      finalStatus: "unknown",
      provisionalAnswer: { sourceType: "official_response_screenshot" },
      subAnswers: [{
        questionId: "q1",
        status: "unknown",
        reason: "provisional_official_response_available",
        evidenceIds: [],
        directEvidenceCount: 0,
        extractedVerdict: "unknown",
        provisionalAnswer: { sourceType: "official_response_screenshot" },
      }],
    },
  ]);

  assert.equal(report.total, 3);
  assert.equal(report.confirmed, 1);
  assert.equal(report.unknown, 2);
  assert.equal(report.provisionalAnswerCount, 1);
  assert.equal(report.conditionalAnswerCount, 1);
  assert.equal(report.clarificationQuestionCount, 1);
  assert.equal(report.officialConfirmedCount, 1);
  assert.equal(report.clarificationCount, 1);
  assert.equal(report.internalReasonLeakCount, 0);
  assert.equal(report.wrongCardResolutionCount, 0);
  assert.equal(report.unsafeConfirmedCount, 0);
  assert.equal(report.missingReasonCount, 0);
});

test("smoke report flags provisional or conditional status escalation", () => {
  const report = buildSmokeReport([
    {
      id: "unsafe",
      finalStatus: "confirmed",
      subAnswers: [{
        questionId: "q1",
        status: "confirmed",
        reason: "bad",
        evidenceIds: ["qa-1"],
        directEvidenceCount: 1,
        extractedVerdict: "can",
        provisionalAnswer: { sourceType: "official_response_screenshot" },
      }],
    },
    {
      id: "conditional-raised",
      finalStatus: "confirmed",
      subAnswers: [{
        questionId: "q1",
        status: "confirmed",
        reason: "bad",
        evidenceIds: ["faq-1"],
        directEvidenceCount: 1,
        extractedVerdict: "activates_on_field",
        conditionalAnswer: { clarificationQuestion: "请补充状态。" },
      }],
    },
  ]);

  assert.ok(report.unsafeConfirmed.includes("unsafe:q1:provisional_confirmed"));
  assert.ok(report.unsafeConfirmed.includes("conditional-raised:q1:conditional_raised_status"));
});

test("smoke report counts likely answers as useful unknowns without confirming them", () => {
  const report = buildSmokeReport([{
    id: "likely",
    finalStatus: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      reason: "no_direct_evidence",
      evidenceIds: [],
      directEvidenceCount: 0,
      extractedVerdict: "unknown",
      likelyAnswer: { status: "best_effort", verdict: "unknown", reasoning: "未确认。", basis: ["card_text"] },
      presentation: { reason: "找到的资料与本题相关，但没有直接回答当前问题。" },
    }],
    userFacingSummary: "可能处理（未确认）：未确认。",
  }]);

  assert.equal(report.confirmed, 0);
  assert.equal(report.likelyAnswerCount, 1);
  assert.equal(report.uselessUnknownCount, 0);
  assert.equal(report.internalReasonLeakCount, 0);
});

test("smoke report detects internal reason leaks in user-facing summaries", () => {
  const report = buildSmokeReport([{
    id: "leak",
    finalStatus: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      reason: "no_direct_evidence",
      evidenceIds: [],
      directEvidenceCount: 0,
      extractedVerdict: "unknown",
      presentation: { reason: "no_direct_evidence" },
    }],
    userFacingSummary: "资料不足：no_direct_evidence",
  }]);

  assert.equal(report.internalReasonLeakCount, 2);
});
