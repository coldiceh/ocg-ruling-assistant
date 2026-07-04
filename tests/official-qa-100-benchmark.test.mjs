import assert from "node:assert/strict";
import test from "node:test";
import {
  loadOfficialQa100Benchmark,
  runOfficialQa100Benchmark,
  validateOfficialQa100Benchmark,
} from "../backend/officialQa100Benchmark.mjs";

test("official QA benchmark contains the required 100-case distribution", async () => {
  const benchmark = await loadOfficialQa100Benchmark();
  const validation = validateOfficialQa100Benchmark(benchmark);
  assert.deepEqual(validation.distribution, {
    official_exact: 20,
    official_near_exact: 10,
    official_similar: 20,
    template_supported: 20,
    conditional_fallback: 20,
    insufficient: 10,
  });
  for (const requiredText of ["七音服", "事务回滚", "彼岸怪兽", "虚空之黑魔导师", "三战之才"]) {
    assert.ok(benchmark.cases.some((item) => item.userQuery.includes(requiredText)), requiredText);
  }
});

test("all 100 official QA first cases meet route and safety expectations", async () => {
  const report = await runOfficialQa100Benchmark();
  assert.equal(report.totalCases, 100);
  assert.deepEqual(report.failedCases, []);
  assert.deepEqual(report.dangerousFailures, {
    unsafeConfirmed: 0,
    officialScopeMismatchUsedAsDirect: 0,
    wrongCardResolvedWithoutWarning: 0,
    llmOverrideProgramVerdict: 0,
    relatedEvidenceUsedAsOfficialDirect: 0,
  });
});
