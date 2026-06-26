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
