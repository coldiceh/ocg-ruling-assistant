import assert from "node:assert/strict";
import test from "node:test";

import {
  createLuaAblationPublicReport,
  parseLuaAblationJudgeArgs,
  runLuaAblationSemanticJudge,
} from "../scripts/judge-lua-ablation.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

test("Lua judge CLI requires exactly both paired variants", () => {
  assert.throws(() => parseLuaAblationJudgeArgs([
    "--cases", "cases.json",
    "--bundle", "bundle.json",
    "--checkpoint", "card_text_only=a.json",
    "--references", "references.json",
    "--private-output", "private.json",
    "--public-output", "public.json",
  ]), /missing --checkpoint card_text_plus_lua/u);

  const options = parseLuaAblationJudgeArgs([
    "--cases", "cases.json",
    "--bundle", "bundle.json",
    "--checkpoint", "card_text_only=a.json",
    "--checkpoint", "card_text_plus_lua=b.json",
    "--references", "references.json",
    "--private-output", "private.json",
    "--public-output", "public.json",
  ]);
  assert.deepEqual([...options.checkpoints.keys()], ["card_text_only", "card_text_plus_lua"]);
});

test("public Lua report contains only anonymous aggregate judgments", () => {
  const candidates = new Map([
    ["card_text_only", { bundleSha256: SHA_A, byCase: new Map([["private-case", {}]]) }],
    ["card_text_plus_lua", { bundleSha256: SHA_A, byCase: new Map([["private-case", {}]]) }],
  ]);
  const report = createLuaAblationPublicReport({
    candidates,
    selectedCases: 1,
    privateResults: [
      { variant: "card_text_only", caseId: "private-case", judgment: { verdict: "incorrect", reason: "PRIVATE_REASON" } },
      { variant: "card_text_plus_lua", caseId: "private-case", judgment: { verdict: "correct", reason: "PRIVATE_REASON" } },
    ],
    generatedAt: "2026-08-13T00:00:00.000Z",
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.variants.card_text_only.strictAccuracy, 0);
  assert.equal(report.variants.card_text_plus_lua.strictAccuracy, 1);
  assert.equal(report.comparison.strictAccuracyDelta, 1);
  assert.doesNotMatch(serialized, /private-case|PRIVATE_REASON|question|reference|candidateAnswer/iu);
});

test("private references are not read until every candidate checkpoint passes the seal", async () => {
  const reads = [];
  const files = new Map([
    ["cases.json", JSON.stringify({ schemaVersion: 1, cases: [{ id: "case-a", question: "PRIVATE_QUESTION" }] })],
    ["bundle.json", "frozen-bundle"],
    ["a.json", JSON.stringify(checkpoint("card_text_only", { status: "running" }))],
    ["b.json", JSON.stringify(checkpoint("card_text_plus_lua"))],
    ["references.json", JSON.stringify({ schemaVersion: 1, goldens: [{ id: "case-a", expectedAnswer: "PRIVATE_REFERENCE" }] })],
  ]);
  await assert.rejects(() => runLuaAblationSemanticJudge({
    argv: [
      "--cases", "cases.json",
      "--bundle", "bundle.json",
      "--checkpoint", "card_text_only=a.json",
      "--checkpoint", "card_text_plus_lua=b.json",
      "--references", "references.json",
      "--private-output", "private.json",
      "--public-output", "public.json",
    ],
    readText: async (filePath) => {
      const name = filePath.replace(/^.*[\\/]/u, "");
      reads.push(name);
      return files.get(name);
    },
    buildBundleContract: () => bundleContract(),
  }), /checkpoint is not terminal/u);
  assert.deepEqual(reads, ["cases.json", "bundle.json", "a.json"]);
});

test("paired candidates are judged serially by fixed Sol high and only the aggregate is public", async () => {
  const reads = [];
  const writes = new Map();
  const requests = [];
  const files = new Map([
    ["cases.json", JSON.stringify({ schemaVersion: 1, cases: [{ id: "case-a", question: "PRIVATE_QUESTION" }] })],
    ["bundle.json", "frozen-bundle"],
    ["a.json", JSON.stringify(checkpoint("card_text_only"))],
    ["b.json", JSON.stringify(checkpoint("card_text_plus_lua"))],
    ["references.json", JSON.stringify({ schemaVersion: 1, goldens: [{ id: "case-a", expectedAnswer: "PRIVATE_REFERENCE" }] })],
  ]);
  const result = await runLuaAblationSemanticJudge({
    argv: [
      "--cases", "cases.json",
      "--bundle", "bundle.json",
      "--checkpoint", "card_text_only=a.json",
      "--checkpoint", "card_text_plus_lua=b.json",
      "--references", "references.json",
      "--private-output", "private.json",
      "--public-output", "public.json",
    ],
    env: { RELAY_API_KEY: "test-secret", RELAY_BASE_URL: "https://relay.invalid/v1" },
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === "content-type" ? "application/json" : null },
        text: async () => JSON.stringify({
          model: "gpt-5.6-sol",
          choices: [{
            message: { content: JSON.stringify({ verdict: "correct", reason: "PRIVATE_JUDGE_REASON" }) },
            finish_reason: "stop",
          }],
        }),
      };
    },
    readText: async (filePath) => {
      const name = filePath.replace(/^.*[\\/]/u, "");
      reads.push(name);
      return files.get(name);
    },
    buildBundleContract: () => bundleContract(),
    writeJson: async (filePath, value) => writes.set(filePath.replace(/^.*[\\/]/u, ""), value),
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    log: () => {},
  });

  assert.deepEqual(reads, ["cases.json", "bundle.json", "a.json", "b.json", "references.json"]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.reasoning_effort, "high");
    assert.match(JSON.stringify(request), /PRIVATE_QUESTION/u);
    assert.match(JSON.stringify(request), /PRIVATE_REFERENCE/u);
  }
  assert.equal(result.publicReport.summary.judgeFailed, 0);
  const publicText = JSON.stringify(writes.get("public.json"));
  assert.doesNotMatch(publicText, /case-a|PRIVATE_QUESTION|PRIVATE_REFERENCE|candidateAnswer|candidateSha256|rawOutput|PRIVATE_JUDGE_REASON/u);
  assert.match(JSON.stringify(writes.get("private.json")), /PRIVATE_JUDGE_REASON/u);
});

function checkpoint(variant, overrides = {}) {
  return {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "completed",
    bundleSha256: SHA_A,
    provider: "relay",
    model: "relay-gpt-5.6-sol",
    efforts: ["low"],
    reasoningMode: "pro",
    evidenceVariant: variant,
    caseIds: ["case-a"],
    concurrency: 1,
    retries: 0,
    plannedRequests: 1,
    results: [{
      caseId: "case-a",
      provider: "relay",
      model: "relay-gpt-5.6-sol",
      effort: "low",
      reasoningMode: "pro",
      evidenceVariant: variant,
      status: "completed_valid",
      snapshotId: "snapshot-a",
      snapshotSha256: SHA_B,
      finalInputSha256: variant === "card_text_only" ? SHA_B : SHA_C,
      submittedModel: "gpt-5.6-sol",
      reportedModel: "gpt-5.6-sol",
      rawOutput: "candidate",
    }],
    ...overrides,
  };
}

function bundleContract() {
  return {
    bundleSha256: SHA_A,
    byCase: new Map([["case-a", {
      snapshotId: "snapshot-a",
      snapshotSha256: SHA_B,
      inputSha256: {
        card_text_only: SHA_B,
        card_text_plus_lua: SHA_C,
      },
    }]]),
  };
}
