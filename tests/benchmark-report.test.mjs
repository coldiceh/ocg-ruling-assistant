import assert from "node:assert/strict";
import test from "node:test";
import { buildBenchmarkReport, classifyPrimaryUnknownReason } from "../scripts/benchmark-report.mjs";

test("1. parser warnings classify an unknown as parser_warning", () => {
  assert.equal(classifyPrimaryUnknownReason({
    answer: { parserWarnings: ["fallback_used"] },
    subAnswer: { status: "unknown", card: "测试卡" },
    trace: { resolvedCardIds: ["1"], rawCandidateEvidence: [] },
  }), "parser_warning");
});

test("2. direct evidence with an unknown verdict classifies as verdict_extraction_unknown", () => {
  assert.equal(classifyPrimaryUnknownReason({
    answer: {},
    subAnswer: { status: "unknown", card: "测试卡" },
    trace: {
      resolvedCardIds: ["1"],
      rawCandidateEvidence: [{ id: "qa-1" }],
      directEvidence: [{ id: "qa-1" }],
      similarEvidence: [],
      extractedVerdict: "unknown",
    },
  }), "verdict_extraction_unknown");
});

test("3. an unresolved subQuestion dependency classifies as unresolved_dependency", () => {
  assert.equal(classifyPrimaryUnknownReason({
    answer: {},
    subAnswer: { status: "unknown", card: "unknown", unresolvedDependencies: ["q1"] },
    trace: {},
  }), "unresolved_dependency");
});

test("4. a missing condition branch state classifies as condition_branch_missing_state", () => {
  assert.equal(classifyPrimaryUnknownReason({
    answer: {},
    subAnswer: { status: "unknown", card: "unknown" },
    trace: { branchSelector: { status: "missing_state" } },
  }), "condition_branch_missing_state");
});

test("5. an empty raw candidate list classifies as retrieval_empty", () => {
  assert.equal(classifyPrimaryUnknownReason({
    answer: {},
    subAnswer: { status: "unknown", card: "测试卡" },
    trace: { resolvedCardIds: ["1"], rawCandidateEvidence: [], directEvidence: [], similarEvidence: [] },
  }), "retrieval_empty");
});

test("6. a structurally safe report has zero unsafe confirmed results", () => {
  const report = buildBenchmarkReport([{
    benchmarkCase: { id: "safe-unknown", question: "测试卡能否发动？", expectedSafety: "may_confirm" },
    answer: {
      mode: "unknown",
      parserWarnings: [],
      subAnswers: [{
        questionId: "q1",
        sourceText: "测试卡能否发动？",
        type: "activation_condition",
        card: "测试卡",
        status: "unknown",
        verdict: "unknown",
        reason: "no_evidence",
        evidenceIds: [],
        dependencies: [],
        unresolvedDependencies: [],
      }],
      parserDebug: {
        evidenceTrace: [{
          questionId: "q1",
          resolvedCardIds: ["1"],
          rawCandidateEvidence: [],
          directEvidence: [],
          similarEvidence: [],
          rejectedEvidence: [],
          extractedVerdict: "unknown",
        }],
        transitionRules: { ruleApplications: [], derivedStates: [] },
      },
    },
  }]);
  assert.equal(report.unsafeConfirmedCount, 0);
  assert.equal(report.missingReasonCount, 0);
  assert.equal(report.unknownReasons.retrieval_empty, 1);
});
