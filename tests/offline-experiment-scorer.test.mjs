import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertPaidExperimentReportGenerated,
  scoreOfflineExperimentReport,
  validateAssertionFixture,
} from "../scripts/lib/offline-experiment-scorer.mjs";
import {
  createExperimentResultBinding,
  hashExperimentRawOutput,
  serializeExperimentRawOutput,
} from "../scripts/lib/experiment-result-binding.mjs";
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

test("determinate fixtures reject CONDITIONAL and UNKNOWN verdicts even when every keyword appears", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const reports = ["CONDITIONAL", "UNKNOWN"].map((value) => succeededCase(
    "accel-synchro-trigger-window",
    {
      conciseAnswer: "原连锁处理完毕后另开连锁；纠罪巧恐怖为连锁1，黑蔷薇龙为连锁2，且没有错过时点。",
      verdicts: [{
        questionId: "q1",
        value,
        conclusion: "纠罪巧恐怖为连锁1，黑蔷薇龙为连锁2。",
        conditions: value === "CONDITIONAL" ? ["若未说明的条件成立"] : [],
      }],
    },
    value.toLowerCase(),
  ));

  const scored = scoreOfflineExperimentReport({ report: batchReport(reports), assertionFixture });
  assert.deepEqual(scored.results.map((item) => item.status), ["FAIL", "FAIL"]);
  for (const result of scored.results) {
    assert.equal(result.checks.find((item) => item.assertionId === "verdict-mode")?.passed, false);
  }
});

test("a fixture may explicitly allow an indeterminate verdict", () => {
  const assertionFixture = {
    schemaVersion: 1,
    goldens: [{
      id: "conditional-case",
      verdictMode: "any",
      assertions: [{
        id: "branch",
        description: "保留条件分支。",
        source: "all",
        allOf: [["分支A"]],
      }],
    }],
  };
  const report = batchReport([succeededCase("conditional-case", {
    conciseAnswer: "若满足条件则适用分支A。",
    verdicts: [{
      questionId: "q1",
      value: "CONDITIONAL",
      conclusion: "若满足条件则适用分支A。",
      conditions: ["满足条件"],
    }],
  })]);

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.equal(scored.results[0].status, "PASS");
});

test("assertion groups must co-occur in conciseAnswer or one determinate verdict conclusion", () => {
  const assertionFixture = {
    schemaVersion: 1,
    goldens: [{
      id: "single-surface",
      assertions: [{
        id: "cooccurrence",
        description: "两个词必须出现在同一个确定结论中。",
        source: "all",
        allOf: [["alpha"], ["beta"]],
      }],
    }],
  };
  const split = succeededCase("single-surface", {
    conciseAnswer: "alpha",
    verdicts: [{
      questionId: "q1",
      value: "TRUE",
      conclusion: "gamma",
      conditions: ["beta"],
    }],
    claims: [{ proposition: "beta" }],
    timeline: [{ action: "beta", result: "" }],
  }, "low");
  const together = succeededCase("single-surface", {
    conciseAnswer: "short answer",
    verdicts: [{
      questionId: "q1",
      value: "TRUE",
      conclusion: "alpha beta",
      conditions: [],
    }],
  }, "medium");

  const scored = scoreOfflineExperimentReport({ report: batchReport([split, together]), assertionFixture });
  assert.deepEqual(scored.results.map((item) => item.status), ["FAIL", "PASS"]);
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
    plannedRequests: 1,
    results: [{
      key: "double-tempest:sol:low:full",
      requestId: "request-123",
      finalInputSha256: "input-sha-123",
      caseId: "double-tempest-impermanence",
      model: "relay-gpt-5.6-sol",
      effort: "low",
      reasoningMode: "pro",
      evidenceVariant: "full",
      status: "completed_valid",
      reportedModel: "gpt-5.6-sol",
      rawOutput: "{\"conciseAnswer\":\"不能发动。\"}",
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
  assert.deepEqual(scored.results[0].sourceBinding, {
    status: "bound",
    resultKey: "double-tempest:sol:low:full",
    requestId: "request-123",
    finalInputSha256: "input-sha-123",
    rawOutputSha256: sha256("{\"conciseAnswer\":\"不能发动。\"}"),
    unavailableReasons: [],
  });

  for (const invalid of [undefined, 0, 1.5, "1"]) {
    const invalidReport = structuredClone(report);
    if (invalid === undefined) delete invalidReport.plannedRequests;
    else invalidReport.plannedRequests = invalid;
    assert.throws(
      () => assertPaidExperimentReportGenerated(invalidReport),
      /plannedRequests must be a positive integer/u,
    );
  }
  const truncated = structuredClone(report);
  truncated.plannedRequests = 2;
  assert.throws(
    () => assertPaidExperimentReportGenerated(truncated),
    /does not contain every planned result/u,
  );
});

test("direct Relay terminal outcomes retain exact source bindings across three execution states", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const base = {
    caseId: "double-tempest-impermanence",
    model: "relay-gpt-5.6-sol",
    reasoningMode: "pro",
    evidenceVariant: "full",
    requestId: null,
  };
  const validRaw = "{\"conciseAnswer\":\"不能发动。无限泡影不能返回手牌，场上没有合法候选。\"}";
  const report = {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "completed",
    plannedRequests: 3,
    results: [
      {
        ...base,
        key: "direct-valid",
        effort: "low",
        status: "completed_valid",
        finalInputSha256: "input-valid",
        rawOutput: validRaw,
        validatedResult: {
          ok: true,
          normalized: {
            conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
          },
        },
      },
      {
        ...base,
        key: "direct-invalid",
        effort: "medium",
        status: "completed_invalid",
        finalInputSha256: "input-invalid",
        rawOutput: "not valid structured output",
      },
      {
        ...base,
        key: "direct-rejected",
        effort: "high",
        status: "error_rejected",
        finalInputSha256: "input-rejected",
        rawOutput: null,
      },
    ],
  };

  assertPaidExperimentReportGenerated(report);
  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.results.map((item) => item.status), [
    "PASS",
    "INCONCLUSIVE",
    "INCONCLUSIVE",
  ]);
  assert.deepEqual(scored.results.map((item) => item.sourceBinding.status), [
    "bound",
    "bound",
    "bound",
  ]);
  assert.deepEqual(scored.results.map((item) => item.sourceBinding.rawOutputSha256), [
    sha256(validRaw),
    sha256("not valid structured output"),
    sha256("null"),
  ]);
});

test("source bindings hash exact string and JSON-stringified object outputs", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const stringOutput = "  exact model output\r\nwith whitespace  ";
  const objectOutput = { conciseAnswer: "不同输出", nested: { order: 1 } };
  const reports = [
    succeededCase("double-tempest-impermanence", {
      conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
    }, "low", {
      key: "same-logical-identity",
      requestId: "request-string",
      finalInputSha256: "input-string",
      rawOutput: stringOutput,
    }),
    succeededCase("double-tempest-impermanence", {
      conciseAnswer: "可以发动。",
    }, "low", {
      key: "same-logical-identity",
      requestId: "request-object",
      finalInputSha256: "input-object",
      rawOutput: objectOutput,
    }),
  ];

  const scored = scoreOfflineExperimentReport({ report: batchReport(reports), assertionFixture });
  assert.deepEqual(scored.results.map((item) => item.status), ["PASS", "FAIL"]);
  assert.equal(serializeExperimentRawOutput(stringOutput), stringOutput);
  assert.equal(serializeExperimentRawOutput(objectOutput), JSON.stringify(objectOutput));
  assert.throws(() => serializeExperimentRawOutput(undefined), /not JSON serializable/u);
  assert.equal(hashExperimentRawOutput(stringOutput), sha256(stringOutput));
  assert.equal(hashExperimentRawOutput(objectOutput), sha256(JSON.stringify(objectOutput)));
  assert.throws(() => hashExperimentRawOutput(undefined), /not JSON serializable/u);
  assert.notEqual(
    scored.results[0].sourceBinding.rawOutputSha256,
    scored.results[1].sourceBinding.rawOutputSha256,
  );
  assert.deepEqual(scored.results[0].sourceBinding, {
    status: "bound",
    resultKey: "same-logical-identity",
    requestId: "request-string",
    finalInputSha256: "input-string",
    rawOutputSha256: sha256(stringOutput),
    unavailableReasons: [],
  });
  assert.deepEqual(scored.results[1].sourceBinding, {
    status: "bound",
    resultKey: "same-logical-identity",
    requestId: "request-object",
    finalInputSha256: "input-object",
    rawOutputSha256: sha256(JSON.stringify(objectOutput)),
    unavailableReasons: [],
  });
});

test("PASS, FAIL, and INCONCLUSIVE scores always carry a source binding", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = batchReport([
    succeededCase("double-tempest-impermanence", {
      conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
    }, "low", {
      key: "pass-key",
      finalInputSha256: "pass-input",
      rawOutput: "pass",
    }),
    succeededCase("double-tempest-impermanence", {
      conciseAnswer: "可以发动。",
    }, "medium", {
      key: "fail-key",
      requestId: "fail-request",
      finalInputSha256: "fail-input",
      rawOutput: "fail",
    }),
    {
      caseId: "double-tempest-impermanence",
      results: [{
        status: "FAILED",
        requestedModel: "relay-gpt-5.6-sol",
        key: "inconclusive-key",
        requestId: null,
        finalInputSha256: "inconclusive-input",
        rawOutput: "inconclusive",
        configuration: {
          reasoningMode: "pro",
          reasoningEffort: "high",
          evidenceVariant: "full",
        },
      }],
    },
  ]);

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.results.map((item) => item.status), ["PASS", "FAIL", "INCONCLUSIVE"]);
  assert.deepEqual(
    scored.results.map((item) => item.sourceBinding.rawOutputSha256),
    ["pass", "fail", "inconclusive"].map(sha256),
  );
  assert.ok(scored.results.every((item) => item.sourceBinding.status === "bound"));
  assert.ok(scored.results.every((item) => item.sourceBinding.unavailableReasons.length === 0));
  assert.ok(scored.results.every((item) => (
    Object.hasOwn(item.sourceBinding, "resultKey")
    && Object.hasOwn(item.sourceBinding, "requestId")
    && Object.hasOwn(item.sourceBinding, "finalInputSha256")
  )));
});

test("legacy admin results stay scoreable but cannot masquerade as review-bound output", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const report = batchReport([succeededCase("double-tempest-impermanence", {
    conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
  })]);

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.equal(scored.results[0].status, "PASS");
  assert.deepEqual(scored.results[0].sourceBinding, {
    status: "unavailable",
    resultKey: null,
    requestId: null,
    finalInputSha256: null,
    rawOutputSha256: null,
    unavailableReasons: [
      "result_key_missing",
      "final_input_sha256_missing",
      "raw_output_missing",
    ],
  });
});

test("empty, missing, and unserializable raw outputs fail closed without a null digest", () => {
  const missing = createExperimentResultBinding({
    key: "missing-output",
    finalInputSha256: "input-missing",
  });
  const undefinedOutput = createExperimentResultBinding({
    key: "undefined-output",
    finalInputSha256: "input-undefined",
    rawOutput: undefined,
  });
  const circular = {};
  circular.self = circular;
  const unserializable = createExperimentResultBinding({
    key: "circular-output",
    finalInputSha256: "input-circular",
    rawOutput: circular,
  });
  const explicitNull = createExperimentResultBinding({
    key: "null-output",
    requestId: null,
    finalInputSha256: "input-null",
    rawOutput: null,
  });

  assert.equal(missing.status, "unavailable");
  assert.equal(missing.rawOutputSha256, null);
  assert.deepEqual(missing.unavailableReasons, ["raw_output_missing"]);
  assert.equal(undefinedOutput.status, "unavailable");
  assert.equal(undefinedOutput.rawOutputSha256, null);
  assert.deepEqual(undefinedOutput.unavailableReasons, ["raw_output_unserializable"]);
  assert.equal(unserializable.status, "unavailable");
  assert.equal(unserializable.rawOutputSha256, null);
  assert.deepEqual(unserializable.unavailableReasons, ["raw_output_unserializable"]);
  assert.equal(explicitNull.status, "bound");
  assert.equal(explicitNull.rawOutputSha256, sha256("null"));
});

test("local Relay rawOutput is never scored without a successful normalized validation", async () => {
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
  assert.deepEqual(scored.counts, { PASS: 0, FAIL: 0, INCONCLUSIVE: 1 });
  assert.equal(scored.results[0].structuredResultSource, null);
  assert.equal(scored.results[0].reasoningEffort, "medium");
});

test("every completed_invalid local result is INCONCLUSIVE even if raw or normalized output looks correct", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const normalized = {
    conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
  };
  const variants = [
    { validatedResult: null },
    { validatedResult: { ok: false, errors: ["invalid"] } },
    { validatedResult: { ok: true, errors: [], normalized } },
  ];
  const report = {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "completed",
    plannedRequests: variants.length,
    results: variants.map((variant, index) => ({
      caseId: "double-tempest-impermanence",
      model: "relay-gpt-5.6-sol",
      effort: ["low", "medium", "high"][index],
      status: "completed_invalid",
      rawOutput: JSON.stringify(normalized),
      ...variant,
    })),
  };

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.counts, { PASS: 0, FAIL: 0, INCONCLUSIVE: 3 });
  assert.ok(scored.results.every((item) => item.structuredResultSource === null));
  assert.ok(scored.results.every((item) => /completed_invalid/u.test(item.reason)));
});

test("completed_valid requires hard validity and a normalized object while semantic issues remain scoreable", async () => {
  const assertionFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const normalized = {
    conciseAnswer: "不能发动。无限泡影不能返回手牌，场上没有合法候选。",
  };
  const report = {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "completed",
    plannedRequests: 4,
    results: [
      { effort: "low", validatedResult: null },
      { effort: "medium", validatedResult: { ok: true } },
      { effort: "high", validatedResult: { ok: false, normalized } },
      {
        effort: "xhigh",
        validatedResult: {
          ok: false,
          errors: ["semantic review required"],
          normalized,
          hardValidity: { ok: true, errors: [] },
          semanticAssessment: {
            evaluated: true,
            ok: false,
            issues: ["semantic review required"],
          },
        },
      },
    ].map((item) => ({
      caseId: "double-tempest-impermanence",
      model: "relay-gpt-5.6-sol",
      status: "completed_valid",
      rawOutput: JSON.stringify(normalized),
      ...item,
    })),
  };

  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  assert.deepEqual(scored.counts, { PASS: 1, FAIL: 0, INCONCLUSIVE: 3 });
  assert.ok(scored.results.slice(0, 3).every(
    (item) => /结构化校验|normalized/u.test(item.reason),
  ));
  assert.equal(scored.results[3].status, "PASS");
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
  const defaultMode = validateAssertionFixture({
    schemaVersion: 1,
    goldens: [{
      id: "x",
      assertions: [{ id: "a", description: "a", allOf: [["a"]] }],
    }],
  });
  assert.equal(defaultMode.get("x").verdictMode, "determinate");
  assert.throws(
    () => validateAssertionFixture({
      schemaVersion: 1,
      goldens: [{
        id: "x",
        verdictMode: "sometimes",
        assertions: [{ id: "a", description: "a", allOf: [["a"]] }],
      }],
    }),
    /verdictMode must be determinate or any/u,
  );
  assert.throws(
    () => assertPaidExperimentReportGenerated({ reports: [{ caseId: "x", results: [{ status: "RUNNING" }] }] }),
    /not terminal/u,
  );
});

function succeededCase(caseId, validatedStructuredResult, reasoningEffort = "high", source = {}) {
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
      ...source,
    }],
  };
}

function batchReport(reports) {
  return { schemaVersion: 1, reports };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
