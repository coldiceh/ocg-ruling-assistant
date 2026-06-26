import assert from "node:assert/strict";
import test from "node:test";
import { answerQuestion, mergeModelAnswer } from "../backend/engine.mjs";
import { BENCHMARK_CASES as benchmarkCases, buildBenchmarkReport } from "../scripts/benchmark-report.mjs";

test("real ruling benchmark keeps every structured answer inside safety gates", async (t) => {
  const report = {
    totalCases: benchmarkCases.length,
    confirmedCount: 0,
    inferredCount: 0,
    unknownCount: 0,
    unsafeConfirmedCount: 0,
    missingReasonCount: 0,
    totalSubQuestions: 0,
    subQuestionStatusCounts: { confirmed: 0, inferred: 0, unknown: 0, parse_failed: 0 },
  };
  const unsafeConfirmed = new Set();
  const missingReasons = new Set();
  const caseResults = [];

  for (const benchmarkCase of benchmarkCases) {
    await t.test(benchmarkCase.id, async () => {
      const answer = await answerQuestion(
        { question: benchmarkCase.question },
        { useModel: false, onDemandSync: false }
      );
      assert.notEqual(answer.status, "data_source_missing", `${benchmarkCase.id}: benchmark data is unavailable`);
      caseResults.push({ benchmarkCase, answer });

      if (answer.mode === "confirmed") report.confirmedCount += 1;
      else if (answer.mode === "inferred") report.inferredCount += 1;
      else report.unknownCount += 1;

      const traces = new Map((answer.parserDebug?.evidenceTrace || []).map((item) => [item.questionId, item]));
      const parserWarnings = answer.parserWarnings || answer.parserDebug?.parserWarnings || [];
      report.totalSubQuestions += answer.subAnswers.length;

      for (const subAnswer of answer.subAnswers) {
        const questionId = String(subAnswer.questionId || subAnswer.id);
        const trace = traces.get(questionId) || {};
        const key = `${benchmarkCase.id}:${questionId}`;
        report.subQuestionStatusCounts[subAnswer.status] = (report.subQuestionStatusCounts[subAnswer.status] || 0) + 1;

        if (subAnswer.status === "confirmed") {
          if (!(trace.directEvidence || []).length) unsafeConfirmed.add(`${key}:directEvidence_missing`);
          if (!(subAnswer.evidenceIds || []).length) unsafeConfirmed.add(`${key}:evidenceIds_missing`);
          if (!trace.extractedVerdict || trace.extractedVerdict === "unknown") unsafeConfirmed.add(`${key}:verdict_unknown`);
          if (parserWarnings.length) unsafeConfirmed.add(`${key}:parser_warning_present`);
          if ((subAnswer.unresolvedDependencies || []).length) unsafeConfirmed.add(`${key}:unresolved_dependency_present`);
          if (subAnswer.provisionalAnswer) unsafeConfirmed.add(`${key}:provisional_answer_confirmed`);
        }
        if (subAnswer.conditionalAnswer && subAnswer.status !== "unknown") {
          unsafeConfirmed.add(`${key}:conditional_answer_raised_status`);
        }

        if (subAnswer.status === "unknown" && !String(subAnswer.reason || "").trim()) {
          missingReasons.add(key);
        }

        const hostileModelAnswer = mergeModelAnswer({
          status: subAnswer.status === "confirmed" ? "unknown" : "confirmed",
          verdict: oppositeVerdict(subAnswer.verdict),
          evidenceIds: ["model-fabricated-evidence"],
          explanationText: "模型尝试覆盖程序结论。",
        }, subAnswer);
        assert.equal(hostileModelAnswer.status, subAnswer.status, `${key}: AI changed program status`);
        assert.equal(hostileModelAnswer.verdict, subAnswer.verdict, `${key}: AI changed program verdict`);
        assert.deepEqual(hostileModelAnswer.evidenceIds, subAnswer.evidenceIds, `${key}: AI changed evidence IDs`);
      }

      for (const application of answer.parserDebug?.transitionRules?.ruleApplications || []) {
        if (["heuristic", "official_database_card_page", "official_response_screenshot", "official_response_unverified", "pending_adjustment"].includes(application.ruleSource?.sourceType)
          && application.outputStatus === "confirmed") {
          unsafeConfirmed.add(`${benchmarkCase.id}:${application.appliedToQuestionId}:unsafe_rule_source`);
        }
      }
      for (const state of answer.parserDebug?.transitionRules?.derivedStates || []) {
        if (["heuristic", "official_database_card_page", "official_response_screenshot", "official_response_unverified", "pending_adjustment"].includes(state.ruleSource?.sourceType) && state.status === "confirmed") {
          unsafeConfirmed.add(`${benchmarkCase.id}:${state.questionId}:unsafe_derived_state`);
        }
      }
    });
  }

  report.unsafeConfirmedCount = unsafeConfirmed.size;
  report.missingReasonCount = missingReasons.size;
  const detailedReport = buildBenchmarkReport(caseResults);
  console.log(`BENCHMARK_REPORT ${JSON.stringify(detailedReport)}`);
  assert.equal(detailedReport.unsafeConfirmedCount, report.unsafeConfirmedCount);
  assert.equal(detailedReport.missingReasonCount, report.missingReasonCount);
  assert.deepEqual([...unsafeConfirmed], [], `unsafe confirmed results:\n${[...unsafeConfirmed].join("\n")}`);
  assert.deepEqual([...missingReasons], [], `unknown results without reason:\n${[...missingReasons].join("\n")}`);
  assert.equal(report.confirmedCount + report.inferredCount + report.unknownCount, report.totalCases);
});

function oppositeVerdict(verdict) {
  const opposites = {
    can: "cannot",
    cannot: "can",
    yes: "no",
    no: "yes",
    activates_on_field: "activates_in_graveyard",
    activates_in_graveyard: "activates_on_field",
    sent_to_graveyard: "not_sent_to_graveyard",
    not_sent_to_graveyard: "sent_to_graveyard",
  };
  return opposites[verdict] || "can";
}
