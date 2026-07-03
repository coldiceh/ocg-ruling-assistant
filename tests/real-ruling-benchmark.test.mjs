import assert from "node:assert/strict";
import test from "node:test";
import { loadRealRulingCases, runRulingBenchmark } from "../backend/rulingBenchmark.mjs";

test("all real ruling fixtures satisfy structural safety expectations", async () => {
  const cases = await loadRealRulingCases();
  assert.ok(cases.length >= 12);
  const report = await runRulingBenchmark({ cases });
  assert.deepEqual(report.failedCases, []);
  assert.deepEqual(report.dangerousFailures, {
    unsafeConfirmed: 0,
    illegalChainEnteredResolution: 0,
    cardMisidentifiedWithoutWarning: 0,
    llmOverrideProgramVerdict: 0,
  });
  assert.equal(report.supportedCorrect + report.insufficientCount, report.totalCases);
  for (const item of report.cases) {
    assert.match(item.evaluation.explanation, /^(supported|insufficient):/u);
    for (const key of ["status", "verdict", "evidenceGrade", "cardIdentity", "blockers", "ruleTrace", "resolutionSteps", "warnings", "answer"]) {
      assert.ok(Object.hasOwn(item.answer, key), `${item.id}:${key}`);
    }
    assert.deepEqual(Object.keys(item.answer.answer), ["conclusion", "evidenceGrade", "keyReasoning", "process", "notes"]);
  }
});
