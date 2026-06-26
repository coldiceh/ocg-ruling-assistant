import assert from "node:assert/strict";
import test from "node:test";
import {
  createFeedbackCase,
  exportFeedbackRegressionDrafts,
  generateRegressionDraft,
} from "../backend/feedbackCases.mjs";
import { exportFeedbackRegressions } from "../scripts/export-feedback-regressions.mjs";

test("feedback case can be created", () => {
  const feedbackCase = createFeedbackCase(baseInput(), { now: "2026-06-26T00:00:00.000Z" });
  assert.match(feedbackCase.id, /^feedback-20260626-/);
  assert.equal(feedbackCase.originalQuestion, "青眼暴君龙的问题");
  assert.equal(feedbackCase.status, "new");
  assert.equal(feedbackCase.userFeedback.type, "wrong_verdict");
});

test("feedback does not mutate or change currentAnswer", () => {
  const input = baseInput({
    currentAnswer: {
      finalStatus: "unknown",
      finalVerdict: "unknown",
      reason: "no_direct_evidence",
      evidenceIds: [],
    },
  });
  const before = JSON.stringify(input.currentAnswer);
  const feedbackCase = createFeedbackCase(input, { now: "2026-06-26T00:00:00.000Z" });
  assert.equal(JSON.stringify(input.currentAnswer), before);
  assert.equal(feedbackCase.currentAnswer.finalStatus, "unknown");
  assert.equal(feedbackCase.currentAnswer.finalVerdict, "unknown");
});

test("should_be_unknown forbids confirmed", () => {
  const feedbackCase = createFeedbackCase(baseInput({
    userFeedback: {
      type: "should_be_unknown",
      comment: "这个不能确认。",
    },
  }));
  assert.deepEqual(feedbackCase.generatedRegressionDraft.forbiddenStatuses, ["confirmed"]);
  assert.equal(feedbackCase.generatedRegressionDraft.expectedStatus, "unknown");
});

test("should_be_confirmed requires direct official evidence in notes", () => {
  const feedbackCase = createFeedbackCase(baseInput({
    userFeedback: {
      type: "should_be_confirmed",
      comment: "这个应该确认。",
      expectedVerdict: "can",
    },
  }));
  assert.equal(feedbackCase.generatedRegressionDraft.expectedStatus, "confirmed");
  assert.match(feedbackCase.generatedRegressionDraft.notes, /requires direct official evidence before enabling/);
});

test("supporting source URL does not automatically confirm the current answer", () => {
  const feedbackCase = createFeedbackCase(baseInput({
    currentAnswer: {
      finalStatus: "unknown",
      finalVerdict: "unknown",
      reason: "no_direct_evidence",
      evidenceIds: [],
    },
    userFeedback: {
      type: "should_be_confirmed",
      comment: "官方链接在这里。",
      supportingSourceUrl: "https://www.db.yugioh-card.com/",
    },
  }));
  assert.equal(feedbackCase.currentAnswer.finalStatus, "unknown");
  assert.equal(feedbackCase.currentAnswer.finalVerdict, "unknown");
  assert.match(feedbackCase.generatedRegressionDraft.notes, /User supplied source URL/);
});

test("export-feedback-regressions outputs regression draft data", async () => {
  const feedbackCase = createFeedbackCase(baseInput(), { now: "2026-06-26T00:00:00.000Z" });
  const exported = await exportFeedbackRegressions({
    payload: { schemaVersion: 1, records: [feedbackCase] },
  });
  assert.equal(exported.total, 1);
  assert.equal(exported.drafts[0].id, feedbackCase.id);

  const markdown = exportFeedbackRegressionDrafts([feedbackCase], { format: "markdown" });
  assert.match(markdown, /Feedback Regression Drafts/);
  assert.match(markdown, new RegExp(feedbackCase.id));
});

test("AI explanation cannot use feedback to overwrite program verdict", () => {
  const feedbackCase = createFeedbackCase(baseInput({
    currentAnswer: {
      finalStatus: "confirmed",
      finalVerdict: "cannot",
      reason: "program verdict",
      evidenceIds: ["qa-1"],
      explanationText: "AI says can",
      verdict: "can",
    },
    userFeedback: {
      type: "other",
      comment: "模型解释和程序结论冲突。",
    },
  }));
  assert.equal(feedbackCase.currentAnswer.finalStatus, "confirmed");
  assert.equal(feedbackCase.currentAnswer.finalVerdict, "cannot");
  assert.equal("explanationText" in feedbackCase.currentAnswer, false);
});

test("manual draft generator keeps missing evidence conservative", () => {
  const feedbackCase = createFeedbackCase(baseInput({
    userFeedback: {
      type: "missing_evidence",
      comment: "缺少这条官方 Q&A。",
    },
  }));
  const draft = generateRegressionDraft(feedbackCase);
  assert.equal(draft.expectedStatus, undefined);
  assert.match(draft.notes, /Do not set expectedStatus to confirmed/);
});

function baseInput(overrides = {}) {
  return {
    originalQuestion: "青眼暴君龙的问题",
    formalQuery: {
      originalText: "青眼暴君龙的问题",
      cards: [{ name: "青眼暴君龙", role: "question_card" }],
      scenario: { rawContext: "" },
      subQuestions: [{
        id: "q1",
        type: "activation_location",
        card: "青眼暴君龙",
        askedResult: "effect_activates_in_graveyard_or_field",
        sourceText: "青眼暴君龙的问题",
      }],
    },
    currentAnswer: {
      finalStatus: "confirmed",
      finalVerdict: "activates_in_graveyard",
      reason: "condition_branch_selected",
      evidenceIds: ["card-faq-16842-3"],
    },
    userFeedback: {
      type: "wrong_verdict",
      comment: "这里不应该是墓地。",
      expectedVerdict: "activates_on_field",
    },
    ...overrides,
  };
}
