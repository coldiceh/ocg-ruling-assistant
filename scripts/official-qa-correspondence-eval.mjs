#!/usr/bin/env node
// Offline evaluation of the official-Q&A correspondence judge (backend/officialQaCorrespondence.mjs)
// on a frozen test set. Official OpenAI Responses API through engineRepro's createModelRunner:
// file cache keyed by (case id, request hash), cost ledger, hard budget cap. The API key is read
// from a file and never printed. Gold labels never enter a request.
//
//   node scripts/official-qa-correspondence-eval.mjs --testset T.json --out DIR --key-file K \
//     [--efforts low,high] [--budget 0.5] [--max-output 6000] [--concurrency 4] [--mock gold|exact|not]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModelRunner, worstCaseCostUsd } from "../backend/engineRepro/modelCalls.mjs";
import { buildOfficialQaCorrespondenceRequest, parseOfficialQaCorrespondenceOutput } from "../backend/officialQaCorrespondence.mjs";

export const MODEL = "gpt-6-luna";

// Only these three fields may reach a request; gold labels, gists and reasons never do.
export function requestFields(testCase) {
  return { userQuery: testCase.userQuery, userCards: testCase.userCards, candidates: testCase.candidates };
}

function mockModel(strategy, testset) {
  const byCase = new Map(testset.cases.map((c) => [c.caseId, c]));
  return async ({ qid, body }) => {
    const caseId = qid.split("@")[0];
    const testCase = byCase.get(caseId);
    const aliases = buildOfficialQaCorrespondenceRequest(requestFields(testCase)).aliases;
    const verdictFor = (id) => strategy === "gold" ? testCase.gold[id].label : strategy === "exact" ? "EXACT" : "NOT";
    const text = JSON.stringify({ assessments: Object.entries(aliases).map(([alias, id]) => ({
      id: alias, verdict: verdictFor(id), differences: [], reason: "mock" })) });
    return { status: "completed", model: body.model, output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 0, output_tokens: 0 } };
  };
}

export async function runEvaluation({ testset, outDir, efforts = ["low", "high"], budgetUsd = 0.5, maxOutputTokens = 6000,
  concurrency = 4, apiKey = null, mock = null, fetchImpl = globalThis.fetch, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const runner = createModelRunner({ outDir, apiKey, mock: mock ? mockModel(mock, testset) : null, budgetUsd, fetchImpl, log });
  const jobs = efforts.flatMap((effort) => testset.cases.map((testCase) => ({ effort, testCase })));
  const results = [];
  let reservedInFlight = 0;
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { effort, testCase } = jobs[next++];
      const request = buildOfficialQaCorrespondenceRequest(requestFields(testCase));
      const worst = worstCaseCostUsd(MODEL, `${request.instructions}\n${request.input}`, maxOutputTokens);
      // Outer reservation so parallel calls cannot jointly pass the runner's per-call budget check.
      if (!mock && runner.spentUsd() + reservedInFlight + worst > budgetUsd) {
        results.push({ caseId: testCase.caseId, effort, ok: false, error: "budget_cap_not_called" });
        continue;
      }
      reservedInFlight += mock ? 0 : worst;
      let row;
      try {
        const response = await runner.call({ qid: `${testCase.caseId}@${effort}`, stage: "judge", model: MODEL,
          instructions: request.instructions, input: request.input, reasoningEffort: effort, maxOutputTokens });
        const parsed = response.status === "completed"
          ? parseOfficialQaCorrespondenceOutput(response.outputText, request.aliases)
          : { ok: false, error: `response_${response.status || "unknown"}` };
        row = { caseId: testCase.caseId, effort, ok: parsed.ok, error: parsed.ok ? null : parsed.error,
          assessments: parsed.ok ? parsed.assessments : [], requestSha256: request.requestSha256,
          usage: response.usage, costUsd: response.costUsd, ms: response.ms, cacheHit: response.cacheHit,
          incomplete: response.incomplete || null, rawOutput: parsed.ok ? undefined : String(response.outputText || "").slice(0, 2000) };
      } catch (error) {
        row = { caseId: testCase.caseId, effort, ok: false, error: `call_failed:${error.code || error.message}` };
      } finally {
        reservedInFlight -= mock ? 0 : worst;
      }
      results.push(row);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  results.sort((a, b) => a.effort.localeCompare(b.effort) || a.caseId.localeCompare(b.caseId));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
  const summary = summarize(testset, results, efforts);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(join(outDir, "report.md"), renderReport(testset, results, summary));
  return { results, summary, spentUsd: runner.spentUsd() };
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function summarize(testset, results, efforts) {
  const byCase = new Map(testset.cases.map((c) => [c.caseId, c]));
  const out = {};
  for (const effort of efforts) {
    const rows = results.filter((r) => r.effort === effort);
    const confusion = {};
    const falseExact = [], missedExact = [];
    let tp = 0, predictedExact = 0, goldExact = 0;
    for (const row of rows) {
      const testCase = byCase.get(row.caseId);
      for (const [id, gold] of Object.entries(testCase.gold)) {
        if (gold.label === "EXACT") goldExact += 1;
        const assessment = row.ok ? row.assessments.find((a) => a.id === id) : null;
        const predicted = assessment ? assessment.verdict : "FAILED";
        confusion[`${gold.label}->${predicted}`] = (confusion[`${gold.label}->${predicted}`] || 0) + 1;
        if (predicted === "EXACT") {
          predictedExact += 1;
          if (gold.label === "EXACT") tp += 1;
          else falseExact.push({ caseId: row.caseId, candidateId: id, gold: gold.label, goldReason: gold.reason,
            modelReason: assessment.reason, modelDifferences: assessment.differences });
        } else if (gold.label === "EXACT") {
          missedExact.push({ caseId: row.caseId, candidateId: id, predicted, modelReason: assessment?.reason || row.error || "" });
        }
      }
    }
    const paid = rows.filter((r) => r.ok !== undefined && !r.cacheHit && Number.isFinite(r.costUsd));
    const ms = rows.filter((r) => Number.isFinite(r.ms) && !r.cacheHit).map((r) => r.ms);
    out[effort] = {
      calls: rows.length, failedCalls: rows.filter((r) => !r.ok).map((r) => ({ caseId: r.caseId, error: r.error })),
      exact: { predicted: predictedExact, truePositive: tp, gold: goldExact,
        precision: predictedExact ? tp / predictedExact : null, recall: goldExact ? tp / goldExact : null },
      falseExact, missedExact, confusion,
      costUsd: paid.reduce((sum, r) => sum + r.costUsd, 0),
      tokens: { input: rows.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0), output: rows.reduce((s, r) => s + (r.usage?.output_tokens || 0), 0),
        reasoning: rows.reduce((s, r) => s + (r.usage?.output_tokens_details?.reasoning_tokens || 0), 0) },
      latencyMs: { median: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: ms.length ? Math.max(...ms) : null },
    };
  }
  return out;
}

const LABEL_ZH = { EXACT: "正好对应", PARTIAL: "部分对应", NOT: "不对应", FAILED: "调用失败" };

function renderReport(testset, results, summary) {
  const lines = ["# 对应判断评测报告", "", `测试集：${testset.cases.length} 题；模型 ${MODEL}`, ""];
  for (const [effort, s] of Object.entries(summary)) {
    const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
    lines.push(`## ${effort}`, "",
      `- 判为正好对应 ${s.exact.predicted} 次，其中真的正好对应 ${s.exact.truePositive} 次（精确率 ${pct(s.exact.precision)}）`,
      `- 应判正好对应 ${s.exact.gold} 处，判出 ${s.exact.truePositive} 处（召回 ${pct(s.exact.recall)}）`,
      `- 调用失败 ${s.failedCalls.length} 次；费用 $${s.costUsd.toFixed(4)}；耗时中位数 ${s.latencyMs.median ?? "—"} ms，P95 ${s.latencyMs.p95 ?? "—"} ms`,
      `- token：输入 ${s.tokens.input}，输出 ${s.tokens.output}（其中推理 ${s.tokens.reasoning}）`, "");
    if (s.falseExact.length) {
      lines.push("**误判为正好对应**", "");
      for (const f of s.falseExact) lines.push(`- ${f.caseId} ${f.candidateId}：标准 ${LABEL_ZH[f.gold]}（${f.goldReason}）；模型理由：${f.modelReason}`);
      lines.push("");
    }
    if (s.missedExact.length) {
      lines.push("**漏判**", "");
      for (const m of s.missedExact) lines.push(`- ${m.caseId} ${m.candidateId}：判为 ${LABEL_ZH[m.predicted] || m.predicted}；${m.modelReason}`);
      lines.push("");
    }
    lines.push("混淆（标准->判定）：" + Object.entries(s.confusion).map(([k, v]) => `${k} ${v}`).join("，"), "");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = parseArgs(process.argv.slice(2));
  const testset = JSON.parse(readFileSync(args.testset, "utf8"));
  const apiKey = args["key-file"] ? readFileSync(args["key-file"], "utf8").trim() : null;
  const { summary, spentUsd } = await runEvaluation({
    testset, outDir: args.out, efforts: String(args.efforts || "low,high").split(","),
    budgetUsd: Number(args.budget || 0.5), maxOutputTokens: Number(args["max-output"] || 6000),
    concurrency: Number(args.concurrency || 4), apiKey, mock: typeof args.mock === "string" ? args.mock : null,
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify({ spentUsd, exact: Object.fromEntries(Object.entries(summary).map(([e, s]) => [e, s.exact])),
    failedCalls: Object.fromEntries(Object.entries(summary).map(([e, s]) => [e, s.failedCalls.length])) }));
}
