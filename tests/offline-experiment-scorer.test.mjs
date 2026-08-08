import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertPaidExperimentReportGenerated,
  scoreOfflineExperimentReport,
  validateAssertionFixture,
} from "../scripts/lib/offline-experiment-scorer.mjs";
import { scoreAdminModelExperimentFiles } from "../scripts/score-admin-model-experiment.mjs";

const fixtureUrl = new URL("./fixtures/admin-evidence-dry-run-goldens.json", import.meta.url);

test("scores a successful Sol result PASS and a timed-out result INCONCLUSIVE without artifact files", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const successfulReport = batchReport([succeededCase("double-tempest-impermanence", {
    conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
  })]);
  const failedReport = batchReport([{
    caseId: "unchained-replacement",
    results: [{
      status: "FAILED",
      requestedModel: "relay-gpt-5.6-sol",
      configuration: { reasoningMode: "pro", reasoningEffort: "high", evidenceVariant: "full" },
    }],
  }]);

  const success = scoreOfflineExperimentReport({ report: successfulReport, assertionFixture });
  assert.deepEqual(success.counts, { PASS: 1, FAIL: 0, INCONCLUSIVE: 0 });
  assert.equal(success.results[0].structuredResultSource, "validatedStructuredResult");
  assert.deepEqual(success.results[0].missingConclusions, []);
  assert.ok(success.results[0].checks.every((item) => item.passed));

  const failed = scoreOfflineExperimentReport({ report: failedReport, assertionFixture });
  assert.deepEqual(failed.counts, { PASS: 0, FAIL: 0, INCONCLUSIVE: 1 });
  assert.match(failed.results[0].reason, /FAILED/u);
});

test("generic assertion fixture scores all four current required outcomes", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = batchReport([
    succeededCase("double-tempest-impermanence", {
      conciseAnswer: "不能发动。发动中的无限泡影不能返回手牌，且没有合法的返手候选。",
    }, "none"),
    succeededCase("unchained-replacement", {
      conciseAnswer: "神龙不能再次适用③效果代替破坏，篁不能特殊召唤。",
    }, "low"),
    succeededCase("accel-synchro-trigger-window", {
      conciseAnswer: "原连锁结束后另开连锁：纠罪巧恐怖为C1，黑蔷薇龙为C2，花龙没有错过时点。",
    }, "medium"),
    succeededCase("lost-target-continue-resolution", {
      conciseAnswer: "谜式密码大师仍需丢弃1张手牌；墨迪乌斯仍处理让自己手牌或场上的1只怪兽回到卡组。",
    }, "high"),
  ]);

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.counts, { PASS: 4, FAIL: 0, INCONCLUSIVE: 0 });
  assert.equal(scored.allPassed, true);
  assert.equal(scored.results.every((item) => item.status === "PASS"), true);
});

test("current model aliases pass while an explicitly unresolved chain order fails", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = batchReport([
    succeededCase("accel-synchro-trigger-window", {
      conciseAnswer: "原连锁处理完毕后另开连锁，纠罪巧的强制反转效果为连锁1，黑蔷薇龙为连锁2；没有错过时点。",
    }, "low"),
    succeededCase("accel-synchro-trigger-window", {
      conciseAnswer: "另开连锁，但无法确认一定是纠罪巧恐怖连锁1、黑蔷薇龙连锁2；黑蔷薇龙没有错过时点。",
    }, "medium"),
    succeededCase("lost-target-continue-resolution", {
      conciseAnswer: "《谜码圣手・封元》的对象离场后仍丢弃1张手牌；墨迪乌斯离开墓地后仍要让1只怪兽回卡组。",
    }, "low"),
    succeededCase("double-tempest-impermanence", {
      conciseAnswer: "不可以发动。无限泡影不能回到手牌，因此息那没有满足发动所需的必做处理条件。",
    }, "low"),
    succeededCase("accel-synchro-trigger-window", {
      conciseAnswer: "原连锁处理完毕后，纠罪巧为连锁1，黑蔷薇龙为连锁2；未错过时点。",
    }, "low"),
    succeededCase("lost-target-continue-resolution", {
      conciseAnswer: "《谜码圣手・封元》仍要弃1张手卡；墨迪乌斯仍要把1只怪兽返回牌组。",
    }, "low"),
  ]);

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.results.map((item) => item.status), [
    "PASS", "FAIL", "PASS", "PASS", "PASS", "PASS",
  ]);
  assert.deepEqual(scored.counts, { PASS: 5, FAIL: 1, INCONCLUSIVE: 0 });
});

test("missing a necessary conclusion is FAIL with a concrete description", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = batchReport([succeededCase("unchained-replacement", {
    conciseAnswer: "神龙不能再次适用③效果代替破坏。",
  })]);

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.equal(scored.results[0].status, "FAIL");
  assert.deepEqual(scored.results[0].missingConclusions, [{
    assertionId: "kamura-not-special-summoned",
    description: "明确结论：破械冥官·篁不能特殊召唤。",
  }]);
});

test("validated structured result is preferred over a conflicting matrix summary", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const item = succeededCase("double-tempest-impermanence", {
    conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
  }).results[0];
  item.conciseAnswer = "可以发动。";
  const scored = scoreOfflineExperimentReport({
    report: batchReport([{ caseId: "double-tempest-impermanence", results: [item] }]),
    assertionFixture,
  });
  assert.equal(scored.results[0].status, "PASS");
  assert.equal(scored.results[0].structuredResultSource, "validatedStructuredResult");
});

test("scores the local single-process checkpoint format after transport completion", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "completed",
    results: [{
      caseId: "double-tempest-impermanence",
      model: "relay-gpt-5.6-sol",
      effort: "low",
      reasoningMode: "pro",
      evidenceVariant: "full",
      status: "completed_valid",
      reportedModel: "gpt-5.6-sol",
      validatedResult: {
        ok: true,
        normalized: {
          conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
        },
      },
    }],
  };

  assertPaidExperimentReportGenerated(report);
  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.counts, { PASS: 1, FAIL: 0, INCONCLUSIVE: 0 });
  assert.equal(scored.results[0].reasoningEffort, "low");
  assert.equal(scored.results[0].structuredResultSource, "validatedStructuredResult");
});

test("local Relay rawOutput is mapped to the same four-case assertion fixture", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "completed",
    plannedRequests: 1,
    results: [{
      caseId: "unchained-replacement",
      model: "relay-gpt-5.6-sol",
      effort: "medium",
      reasoningMode: "pro",
      evidenceVariant: "full",
      status: "completed_valid",
      rawOutput: JSON.stringify({
        conciseAnswer: "神龙不能再次适用③效果代替破坏，破械冥官·篁不能特殊召唤。",
      }),
    }],
  };
  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.counts, { PASS: 1, FAIL: 0, INCONCLUSIVE: 0 });
  assert.equal(scored.results[0].structuredResultSource, "validatedStructuredResult");
  assert.equal(scored.results[0].reasoningEffort, "medium");
});

test("goldens are read only after a terminal generated report is loaded", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = batchReport([succeededCase("double-tempest-impermanence", {
    conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
  })]);
  const reads = [];
  await scoreAdminModelExperimentFiles({
    reportFile: "paid-report.json",
    assertionsFile: "goldens.json",
    async readFileImpl(pathname) {
      reads.push(String(pathname));
      return JSON.stringify(pathname === "paid-report.json" ? report : assertionFixture);
    },
  });
  assert.deepEqual(reads, ["paid-report.json", "goldens.json"]);

  const rejectedReads = [];
  await assert.rejects(
    scoreAdminModelExperimentFiles({
      reportFile: "empty-report.json",
      assertionsFile: "goldens.json",
      async readFileImpl(pathname) {
        rejectedReads.push(String(pathname));
        return JSON.stringify({ schemaVersion: 1, reports: [] });
      },
    }),
    /contains no generated model results/u,
  );
  assert.deepEqual(rejectedReads, ["empty-report.json"]);

  const runningReads = [];
  await assert.rejects(
    scoreAdminModelExperimentFiles({
      reportFile: "running-local-checkpoint.json",
      assertionsFile: "goldens.json",
      async readFileImpl(pathname) {
        runningReads.push(String(pathname));
        return JSON.stringify({
          runner: "local-relay-effort-experiment/v1",
          status: "in_progress",
          plannedRequests: 1,
          results: [{ caseId: "anonymous", status: "running" }],
        });
      },
    }),
    /checkpoint is not completed/u,
  );
  assert.deepEqual(runningReads, ["running-local-checkpoint.json"]);
});

test("scorer implementation contains no four-case identities and fixture validation fails closed", async () => {
  const source = await readFile(
    new URL("../scripts/lib/offline-experiment-scorer.mjs", import.meta.url),
    "utf8",
  );
  for (const token of [
    "double-tempest-impermanence",
    "unchained-replacement",
    "天雷之双风神",
    "破械冥官",
    "黑蔷薇龙",
    "谜式密码大师",
  ]) {
    assert.equal(source.includes(token), false);
  }
  assert.throws(
    () => validateAssertionFixture({ schemaVersion: 1, goldens: [{ id: "x" }] }),
    /assertions must be a non-empty array/u,
  );
  assert.throws(
    () => assertPaidExperimentReportGenerated({ reports: [{ caseId: "x", results: [{ status: "RUNNING" }] }] }),
    /not terminal/u,
  );
});

function succeededCase(caseId, validatedStructuredResult, reasoningEffort = "high") {
  return {
    caseId,
    results: [{
      runId: `run-${caseId}-${reasoningEffort}`,
      status: "SUCCEEDED",
      requestedModel: "relay-gpt-5.6-sol",
      returnedModel: "gpt-5.6-sol",
      configuration: {
        model: "relay-gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort,
        evidenceVariant: "full",
      },
      validatedStructuredResult,
      conciseAnswer: validatedStructuredResult.conciseAnswer,
      verdicts: validatedStructuredResult.verdicts || [],
      timeline: validatedStructuredResult.timeline || [],
    }],
  };
}

function batchReport(reports) {
  return { schemaVersion: 1, reports };
}
