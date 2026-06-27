import assert from "node:assert/strict";
import test from "node:test";
import {
  MANUAL_PLAYTEST_CASES,
  buildManualPlaytestCaseResult,
  buildManualPlaytestReport,
  buildPlaytestFeedback,
} from "../scripts/manual-playtest-report.mjs";

test("manual playtest set contains 20 to 30 real questions", () => {
  assert.ok(MANUAL_PLAYTEST_CASES.length >= 20);
  assert.ok(MANUAL_PLAYTEST_CASES.length <= 30);
});

test("rule-derived and card-confirmation results count as useful without confirming", () => {
  const derived = buildManualPlaytestCaseResult({ id: "derived", input: "test" }, {
    mode: "unknown",
    subAnswers: [{
      status: "unknown",
      verdict: "unknown",
      officialAnswer: { status: "not_found", verdict: "unknown", evidenceIds: [] },
      ruleDerivedAnswer: {
        status: "rule_derived",
        shortAnswer: "按规则处理应继续。",
        reasoningSteps: [{ explanation: "第一步" }, { explanation: "第二步" }],
        notice: "没有完全同场景的直接 Q&A。",
      },
    }],
  });
  assert.equal(derived.hasUsefulAnswer, true);
  assert.equal(derived.visibleStatus, "规则推导结论");
  assert.equal(derived.flags.officialConfirmed, false);

  const unresolved = buildManualPlaytestCaseResult({ id: "card", input: "卡通青眼究极龙" }, {
    mode: "unknown",
    cardResolutionConfirmations: [{ unresolvedCardName: "卡通青眼究极龙", candidateCards: [{ name: "青眼究极龙" }] }],
    subAnswers: [],
  });
  assert.equal(unresolved.hasUsefulAnswer, true);
  assert.equal(unresolved.visibleStatus, "卡名需要确认");
});

test("unsafe or useless playtest cases generate review drafts", () => {
  const useless = buildManualPlaytestCaseResult({ id: "empty", input: "测试" }, {
    mode: "unknown",
    subAnswers: [{ status: "unknown", reason: "no_evidence" }],
  });
  const unsafe = buildManualPlaytestCaseResult({ id: "unsafe", input: "测试" }, {
    mode: "confirmed",
    subAnswers: [{ status: "confirmed", verdict: "can", evidenceIds: [] }],
  });
  const report = buildManualPlaytestReport([useless, unsafe]);
  assert.equal(report.uselessAnswerCount, 2);
  assert.equal(report.unsafeConfirmedCount, 1);
  const feedback = buildPlaytestFeedback(report);
  assert.equal(feedback.length, 2);
  assert.ok(feedback.some((item) => item.category === "missing_rule_concept"));
  assert.ok(feedback.some((item) => item.category === "unsafe_confirmed"));
});

test("internal reason codes are detected in visible output", () => {
  const item = buildManualPlaytestCaseResult({ id: "leak", input: "测试" }, {
    mode: "unknown",
    subAnswers: [{
      status: "unknown",
      clarification: { question: "no_direct_evidence" },
    }],
  });
  assert.equal(item.hasInternalCodeLeak, true);
  assert.match(item.reviewReason, /internal_reason_leak/u);
});
