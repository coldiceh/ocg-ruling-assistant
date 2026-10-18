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

// ---- production material and the engine-section judge ----
const { buildOfficialQaJudgeInput, officialQaQuestionFields, renderCardPlaceholders } = await import("../backend/officialQaCorrespondence.mjs");
const { OFFICIAL_QA_JUDGE, officialQaJudgeEnabled, officialQaJudgeSummary, runOfficialQaJudge, startOfficialQaJudge } =
  await import("../backend/engineRepro/officialQaJudge.mjs");

const qaRecord = (n, extra = {}) => ({ id: `ygoresources-qa-${n}`, recordType: "qa", title: `「<<7>>」の効果${n}は？`,
  rawQuestion: `「<<7>>」の効果${n}は？`, rawDetailedQuestion: `「<<7>>」と「<<8>>」の詳細${n}`,
  conclusion: `SECRET-CONCLUSION-${n}`, answer: `SECRET-ANSWER-${n}`, sourceUrl: `https://db.ygoresources.com/data/qa/${n}`, ...extra });
// Gemini-shaped prompt-visible refs: the complete source record travels as JSON in `text`.
const geminiItem = (handle, record) => ({ id: handle, type: record.recordType, title: record.title, text: JSON.stringify(record) });
const judgeCards = [
  { id: "7", cnName: "测试卡", jaName: "テストカード", effectText: "测试卡的效果" },
  { id: "8", cnName: "同名卡", jaName: "同名卡", effectText: "" },
  { id: "9", cnName: "", jaName: "日文名だけ", effectText: "" },
];

test("judge material: only official Q&A among the prompt-visible refs, question fields only, card names rendered", () => {
  const items = [
    geminiItem("h-qa-1", qaRecord(1)),
    geminiItem("h-faq", { id: "card-faq-7-1", recordType: "card-faq", title: "FAQ", question: "", conclusion: "SECRET-FAQ" }),
    { id: "rule-unit-1", type: "related", text: "规则正文 SECRET-RULE" },
    geminiItem("h-qa-1-again", qaRecord(1)),
    { id: "legacy-1", type: "official_qa", title: "旧式题面", question: "旧式问题", answer: "SECRET-LEGACY" },
    { id: "h-broken", type: "qa", text: "{not json" },
  ];
  const input = buildOfficialQaJudgeInput({ userQuery: "用户问题", evidenceItems: items, cards: judgeCards,
    resolvedCards: [{ id: "7" }, { id: "7" }] });
  assert.equal(input.schema, "official-qa-judge-input/v1");
  assert.deepEqual(input.candidates.map((c) => [c.id, c.handle]), [["ygoresources-qa-1", "h-qa-1"], ["legacy-1", "legacy-1"]]);
  const [first] = input.candidates;
  assert.equal(first.rawQuestion, "「テストカード／测试卡」の効果1は？");
  assert.equal(first.rawDetailedQuestion, "「テストカード／测试卡」と「同名卡」の詳細1");
  assert.equal(first.displayTitle, "「测试卡」の効果1は？");
  assert.equal(first.sourceUrl, "https://db.ygoresources.com/data/qa/1");
  assert.deepEqual(input.userCards, [{ id: "7", cnName: "测试卡", jaName: "テストカード", effectText: "测试卡的效果" }]);
  assert.ok(!JSON.stringify(input).includes("SECRET"), "no answer, FAQ or rule text in the material");
  const request = buildOfficialQaCorrespondenceRequest(input);
  assert.deepEqual(request.aliases, { Q1: "ygoresources-qa-1", Q2: "legacy-1" });
  assert.ok(!request.input.includes("h-qa-1") && !request.input.includes("displayTitle"), "handles and display fields stay local");
  assert.equal(buildOfficialQaJudgeInput({ userQuery: "q", evidenceItems: [items[1], items[2]], cards: judgeCards }), null);
  assert.equal(officialQaQuestionFields({ id: "x", type: "qa", text: JSON.stringify({ id: "y", recordType: "card-faq", question: "q" }) }), null);
});

test("card placeholders: judge style is 日文名／中文名 (one name when equal or missing); display style is the Chinese name", () => {
  const byId = new Map(judgeCards.map((card) => [card.id, card]));
  assert.equal(renderCardPlaceholders("<<7>>|<<8>>|<<9>>|<<404>>", byId), "テストカード／测试卡|同名卡|日文名だけ|<<404>>");
  assert.equal(renderCardPlaceholders("<<7>>|<<8>>|<<9>>|<<404>>", byId, { style: "display" }), "测试卡|同名卡|日文名だけ|<<404>>");
});

const judgeInput = () => buildOfficialQaJudgeInput({ userQuery: "用户问题", cards: judgeCards, resolvedCards: [{ id: "7" }],
  evidenceItems: [geminiItem("h1", qaRecord(1)), geminiItem("h2", qaRecord(2))] });
const completed = (assessments, extra = {}) => async (request) => ({ status: "completed",
  outputText: JSON.stringify({ assessments }), usage: { input_tokens: 900, output_tokens: 120 }, costUsd: 0.00015, ...extra,
  request });

test("judge: one Luna low call with the evaluated request; EXACT ids come back with their display titles", async () => {
  const calls = [];
  const modelCall = async (request) => { calls.push(request); return completed([
    { id: "Q2", verdict: "EXACT", differences: [], reason: "同一情况" },
    { id: "Q1", verdict: "PARTIAL", differences: ["时点不同"], reason: "时点不同" }])(request); };
  const result = await runOfficialQaJudge({ input: judgeInput(), env: {}, modelCall });
  assert.equal(calls.length, 1);
  assert.deepEqual({ model: calls[0].model, effort: calls[0].reasoningEffort, maxOutput: calls[0].maxOutputTokens,
    timeoutMs: calls[0].timeoutMs }, { model: "gpt-6-luna", effort: "low", maxOutput: 6000, timeoutMs: 30000 });
  const expected = buildOfficialQaCorrespondenceRequest(judgeInput());
  assert.equal(calls[0].instructions, expected.instructions);
  assert.equal(calls[0].input, expected.input);
  assert.equal(result.status, "done");
  assert.deepEqual(result.exact, [{ id: "ygoresources-qa-2", title: "「测试卡」の効果2は？", handle: "h2" }]);
  assert.deepEqual(result.assessments.map((row) => [row.id, row.verdict]), [["ygoresources-qa-1", "PARTIAL"], ["ygoresources-qa-2", "EXACT"]]);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.costUsd, 0.00015);
  const summary = officialQaJudgeSummary(result);
  assert.deepEqual(summary.verdicts, { EXACT: 1, PARTIAL: 1, NOT: 0 });
  assert.deepEqual(summary.exact, [{ id: "ygoresources-qa-2", title: "「测试卡」の効果2は？" }]);
  assert.ok(!JSON.stringify(summary).includes("用户问题"), "the summary carries no request text");
  assert.deepEqual(OFFICIAL_QA_JUDGE, { model: "gpt-6-luna", effort: "low", maxOutput: 6000, timeoutMs: 30000 });
});

test("judge fails closed: no EXACT unless the response is completed and strictly valid", async () => {
  const valid = [{ id: "Q1", verdict: "EXACT" }, { id: "Q2", verdict: "EXACT" }];
  const outcomes = [
    [completed(valid, { status: "incomplete" }), "response_incomplete"],
    [completed([{ id: "Q1", verdict: "EXACT" }]), "missing_alias:Q2"],
    [completed([...valid, { id: "Q3", verdict: "EXACT" }]), "unknown_alias:Q3"],
    [async () => ({ status: "completed", outputText: "EXACT", usage: {} }), "output_not_json"],
    [async () => { throw Object.assign(new Error("over"), { code: "engine_repro_daily_budget_exceeded" }); }, "engine_repro_daily_budget_exceeded"],
    [async () => { throw new Error("openai_http_500"); }, "openai_http_500"],
  ];
  for (const [modelCall, error] of outcomes) {
    const result = await runOfficialQaJudge({ input: judgeInput(), env: {}, modelCall });
    assert.equal(result.status, "failed", error);
    assert.equal(result.error, error);
    assert.deepEqual(officialQaJudgeSummary(result).exact, []);
  }
});

test("judge: switch off or no candidates means no call; start returns null without material and never rejects", async () => {
  let called = 0;
  const modelCall = async () => { called += 1; return completed([])(); };
  for (const value of ["off", "false", "0", "NO"]) {
    assert.equal(officialQaJudgeEnabled({ ENGINE_REPRO_OFFICIAL_QA_JUDGE: value }), false);
    const result = await runOfficialQaJudge({ input: judgeInput(), env: { ENGINE_REPRO_OFFICIAL_QA_JUDGE: value }, modelCall });
    assert.deepEqual([result.status, result.reason], ["skipped", "disabled"]);
  }
  assert.equal(officialQaJudgeEnabled({}), true);
  const empty = await runOfficialQaJudge({ input: { userQuery: "q", candidates: [{ id: "x", conclusion: "only an answer" }] }, modelCall });
  assert.deepEqual([empty.status, empty.reason], ["skipped", "no_candidates"]);
  assert.equal(called, 0);
  assert.equal(startOfficialQaJudge({ input: null }), null);
  assert.equal(startOfficialQaJudge({ input: { candidates: [] } }), null);
  // without an injected call the real transport needs a key: no key, no request, a closed failure
  let fetched = 0;
  const started = startOfficialQaJudge({ input: judgeInput(), env: {}, fetchImpl: async () => { fetched += 1; },
    limits: { reserve: async () => ({}), settle: async () => {} } });
  const result = await started;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "engine_repro_not_configured");
  assert.equal(fetched, 0);
});
