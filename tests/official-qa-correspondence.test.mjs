import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOfficialQaCorrespondenceRequest,
  candidateQuestionView,
  parseOfficialQaCorrespondenceOutput,
} from "../backend/officialQaCorrespondence.mjs";
import { requestFields, runEvaluation } from "../scripts/official-qa-correspondence-eval.mjs";

const candidates = [
  { id: "ygoresources-qa-1", title: "题目一", rawQuestion: "题目一", rawDetailedQuestion: "详细一", conclusion: "SECRET-ANSWER-ONE" },
  { id: "card-faq-9-1", recordType: "card-faq", conclusion: "SECRET-FAQ" },
  { id: "ygoresources-qa-2", question: "题目二", answer: "SECRET-ANSWER-TWO", text: "SECRET-TEXT" },
];

test("the request carries question fields only, never an official answer", () => {
  const request = buildOfficialQaCorrespondenceRequest({ userQuery: "用户问题", userCards: [{ cnName: "卡", effectText: "效果" }], candidates });
  for (const secret of ["SECRET-ANSWER-ONE", "SECRET-FAQ", "SECRET-ANSWER-TWO", "SECRET-TEXT"]) {
    assert.ok(!request.input.includes(secret), `${secret} must not reach the model`);
  }
  assert.ok(request.input.includes("详细一") && request.input.includes("题目二"));
  assert.deepEqual(candidateQuestionView(candidates[0]), { 问题: "题目一", 详细场景: "详细一" });
});

test("candidates without their own question are not sent; aliases follow the sent order", () => {
  const request = buildOfficialQaCorrespondenceRequest({ userQuery: "q", candidates });
  assert.deepEqual(request.aliases, { Q1: "ygoresources-qa-1", Q2: "ygoresources-qa-2" });
  assert.deepEqual(request.skippedCandidateIds, ["card-faq-9-1"]);
});

test("strict parse: exactly one known verdict per alias, anything else fails closed", () => {
  const aliases = { Q1: "a", Q2: "b" };
  const ok = parseOfficialQaCorrespondenceOutput(JSON.stringify({ assessments: [
    { id: "Q2", verdict: "not", reason: "r2" }, { id: "Q1", verdict: "EXACT", differences: [], reason: "r1" }] }), aliases);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.assessments.map((a) => [a.id, a.verdict]), [["a", "EXACT"], ["b", "NOT"]]);
  const cases = [
    ["not json", "output_not_json"],
    [JSON.stringify({}), "assessments_missing"],
    [JSON.stringify({ assessments: [{ id: "Q1", verdict: "EXACT" }, { id: "Q3", verdict: "NOT" }] }), "unknown_alias:Q3"],
    [JSON.stringify({ assessments: [{ id: "Q1", verdict: "EXACT" }, { id: "Q1", verdict: "NOT" }] }), "duplicate_alias:Q1"],
    [JSON.stringify({ assessments: [{ id: "Q1", verdict: "MAYBE" }, { id: "Q2", verdict: "NOT" }] }), "invalid_verdict:Q1"],
    [JSON.stringify({ assessments: [{ id: "Q1", verdict: "EXACT" }] }), "missing_alias:Q2"],
  ];
  for (const [text, error] of cases) assert.deepEqual(parseOfficialQaCorrespondenceOutput(text, aliases), { ok: false, error });
});

const testset = { cases: [
  { caseId: "T01a", userQuery: "问题A", userCards: [], candidates: [candidates[0], candidates[2]],
    gold: { "ygoresources-qa-1": { label: "EXACT", reason: "同" }, "ygoresources-qa-2": { label: "NOT", reason: "异" } } },
  { caseId: "T01b", userQuery: "问题B", userCards: [], candidates: [candidates[0]],
    gold: { "ygoresources-qa-1": { label: "PARTIAL", reason: "条件不同" } } },
] };

test("gold labels and reasons never reach a request", () => {
  const request = buildOfficialQaCorrespondenceRequest(requestFields({ ...testset.cases[1], gold: { x: { label: "EXACT", reason: "GOLD-REASON" } } }));
  assert.ok(!request.input.includes("GOLD-REASON") && !request.input.includes("PARTIAL"));
});

test("mock evaluation end to end: gold mock is perfect, all-EXACT mock exposes false EXACT, cache is reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corr-eval-"));
  const perfect = await runEvaluation({ testset, outDir: join(dir, "gold"), efforts: ["low"], mock: "gold" });
  assert.deepEqual(perfect.summary.low.exact, { predicted: 1, truePositive: 1, gold: 1, precision: 1, recall: 1 });
  const exactAll = await runEvaluation({ testset, outDir: join(dir, "exact"), efforts: ["low", "high"], mock: "exact" });
  assert.equal(exactAll.summary.low.exact.predicted, 3);
  assert.equal(exactAll.summary.low.falseExact.length, 2);
  assert.ok(existsSync(join(dir, "exact", "report.md")) && readFileSync(join(dir, "exact", "report.md"), "utf8").includes("误判为正好对应"));
  const again = await runEvaluation({ testset, outDir: join(dir, "exact"), efforts: ["low"], mock: "exact" });
  assert.ok(again.results.every((row) => row.cacheHit === true));
});

test("no key and no mock: nothing is sent and every job reports the missing key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corr-eval-"));
  let fetched = 0;
  const run = await runEvaluation({ testset, outDir: dir, efforts: ["low"], fetchImpl: async () => { fetched += 1; } });
  assert.equal(fetched, 0);
  assert.ok(run.results.every((row) => row.ok === false && row.error === "call_failed:no_api_key"));
});
