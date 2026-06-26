import assert from "node:assert/strict";
import test from "node:test";
import {
  UI_ACCEPTANCE_REAL_QUESTIONS,
  buildUiAcceptanceCaseResult,
  buildUiAcceptanceReport,
  runUiAcceptanceRealQuestions,
} from "../scripts/ui-acceptance-real-questions.mjs";

test("UI acceptance set contains 20 real questions", () => {
  assert.equal(UI_ACCEPTANCE_REAL_QUESTIONS.length, 20);
});

test("likelyAnswer is visible in ordinary UI and does not confirm the answer", () => {
  const result = buildUiAcceptanceCaseResult({ id: "likely", input: "测试问题" }, {
    mode: "unknown",
    subAnswers: [{
      questionId: "q1",
      sourceText: "能否处理这个场景？",
      status: "unknown",
      verdict: "unknown",
      officialAnswer: { status: "unknown", verdict: "unknown", evidenceIds: [], reason: "no_direct_evidence" },
      likelyAnswer: {
        status: "best_effort",
        verdict: "unknown",
        reasoning: "只能给出未确认处理参考。",
        disclaimer: "未确认裁定，不能替代官方 Q&A",
      },
    }],
  });
  assert.equal(result.acceptance, "pass");
  assert.match(result.visibleLikelyAnswer, /未确认分析/u);
  assert.match(result.visibleLikelyAnswer, /为什么不能确认/u);
  assert.match(result.visibleOfficialAnswer, /暂无直接裁定/u);
  assert.doesNotMatch(result.visibleOfficialAnswer, /已确认/u);
});

test("unresolvedCardPrompt is visible in ordinary UI", () => {
  const result = buildUiAcceptanceCaseResult({ id: "card", input: "卡通青眼究极龙能直接攻击吗？" }, {
    mode: "unknown",
    cardResolutionConfirmations: [{
      unresolvedCardName: "卡通青眼究极龙",
      candidateCards: [{ name: "青眼究极龙" }],
    }],
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      officialAnswer: { status: "unknown", verdict: "unknown", evidenceIds: [] },
      clarification: { question: "请确认你指的是哪张卡：卡通青眼究极龙？", options: ["青眼究极龙"] },
    }],
  });
  assert.equal(result.acceptance, "pass");
  assert.match(result.visibleClarification, /卡名需要确认/u);
  assert.match(result.visibleClarification, /卡通青眼究极龙/u);
});

test("provisionalAnswer is visible but never shown as confirmed", () => {
  const result = buildUiAcceptanceCaseResult({ id: "provisional", input: "事务局截图问题" }, {
    mode: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      officialAnswer: { status: "unknown", verdict: "unknown", evidenceIds: [] },
      provisionalAnswer: {
        sourceType: "official_response_screenshot",
        verdict: { activation: "can_activate", cost: "can_pay_cost", resolution: "does_not_perform_fusion_material_processing" },
      },
    }],
  });
  assert.equal(result.acceptance, "pass");
  assert.match(result.visibleProvisionalAnswer, /事务局回答截图/u);
  assert.match(result.visibleProvisionalAnswer, /官方 DB 未收录/u);
  assert.doesNotMatch(result.visibleOfficialAnswer, /已确认/u);
});

test("internal reason codes are not leaked in visible text", () => {
  const result = buildUiAcceptanceCaseResult({ id: "reason", input: "测试问题" }, {
    mode: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      reason: "similar_evidence:evidence_mentions_action_but_not_asked_result",
      officialAnswer: { status: "unknown", verdict: "unknown", evidenceIds: [], reason: "similar_evidence" },
      likelyAnswer: {
        status: "best_effort",
        verdict: "unknown",
        reasoning: "找到的是相似资料，不能确认。",
      },
    }],
  });
  assert.equal(result.reviewReasons.includes("internal_reason_leak"), false);
  assert.doesNotMatch(result.userFacingSummary, /similar_evidence|evidence_mentions_action_but_not_asked_result/u);
});

test("unknown with likelyAnswer is not counted as useless", () => {
  const result = buildUiAcceptanceCaseResult({ id: "useful", input: "测试问题" }, {
    mode: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      officialAnswer: { status: "unknown", verdict: "unknown", evidenceIds: [] },
      likelyAnswer: { status: "best_effort", verdict: "unknown", reasoning: "未确认参考。" },
    }],
  });
  const report = buildUiAcceptanceReport([result]);
  assert.equal(report.uselessVisibleAnswerCount, 0);
});

test("confirmed answer shows visible evidence", () => {
  const result = buildUiAcceptanceCaseResult({ id: "confirmed", input: "测试问题" }, {
    mode: "confirmed",
    subAnswers: [{
      questionId: "q1",
      status: "confirmed",
      verdict: "can",
      evidenceIds: ["qa-1"],
      officialAnswer: { status: "confirmed", verdict: "can", evidenceIds: ["qa-1"] },
    }],
  });
  assert.equal(result.acceptance, "pass");
  assert.match(result.visibleOfficialAnswer, /官方确认：已确认/u);
  assert.deepEqual(result.visibleEvidence, ["依据：qa-1"]);
});

test("UI acceptance does not modify final gate results", async () => {
  const report = await runUiAcceptanceRealQuestions({
    cases: [{ id: "gate", input: "测试问题" }],
    answers: {
      gate: {
        mode: "unknown",
        subAnswers: [{
          questionId: "q1",
          status: "unknown",
          verdict: "unknown",
          officialAnswer: { status: "unknown", verdict: "unknown", evidenceIds: [] },
          likelyAnswer: { status: "best_effort", verdict: "can", reasoning: "未确认参考。" },
        }],
      },
    },
  });
  assert.equal(report.mistakenConfirmedCount, 0);
  assert.equal(report.cases[0].visibleOfficialAnswer, "官方确认：暂无直接裁定。");
});
