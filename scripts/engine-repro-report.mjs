#!/usr/bin/env node
// Report for an engine-reproduction batch: node scripts/engine-repro-report.mjs RUN_DIR [QUESTION_SET]
// Metrics are reported separately and never merged into one "accuracy". Synthetic questions are reported apart.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
const records = readdirSync(join(runDir, "results")).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(runDir, "results", f), "utf8")));
const groups = { "真实/官方（H+A）": records.filter((r) => r.source !== "synthetic"), "synthetic（S）": records.filter((r) => r.source === "synthetic") };
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const ledgerRows = readFileSync(join(runDir, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const firstPaid = new Map();
for (const row of ledgerRows) if (!row.cacheHit && row.bodyHash && !firstPaid.has(row.bodyHash)) firstPaid.set(row.bodyHash, row);
// cost and latency of the calls this configuration actually used, counted once each (cache hits cost nothing again)
const paidOf = (c) => firstPaid.get(c.bodyHash) || null;
const md = [];
const out = { generatedAt: new Date().toISOString(), groups: {} };

function row(r) {
  if (r.error) return `| ${r.qid} | ${r.source} | 错误 | ${r.error.code || ""} ${r.error.message.slice(0, 60)} | | | | | | |`;
  const m = r.metrics;
  const paid = m.modelCalls.map(paidOf).filter(Boolean);
  const stages = m.modelCalls.map((c) => c.stage).join(" ");
  const planMs = sum(m.modelCalls.filter((c) => c.stage === "plan" || c.stage === "repair").map((c) => paidOf(c)?.ms));
  return `| ${r.qid} | ${r.source} | ${r.summary.status} | ${r.summary.reasonCodes.join(", ")} | ${r.summary.flags.join(", ")} | ${m.plannerCalls} | ${stages} | ${sum(m.modelCalls.map((c) => c.input))}/${sum(m.modelCalls.map((c) => c.output))} | $${sum(paid.map((c) => c.costUsd)).toFixed(4)} | ${(planMs / 1000).toFixed(1)} s | ${m.engineMs} ms |`;
}

for (const [name, rs] of Object.entries(groups)) {
  if (!rs.length) continue;
  const ok = rs.filter((r) => !r.error);
  const byStatus = {};
  for (const r of ok) byStatus[r.summary.status] = (byStatus[r.summary.status] || 0) + 1;
  const engineRoute = ok.filter((r) => r.plannerCalled && r.plan?.applicability === "applicable");
  const reproduced = engineRoute.filter((r) => r.summary.status === "已复现");
  const na = ok.filter((r) => r.summary.status === "不适用");
  const failed = ok.filter((r) => ["未复现", "部分复现"].includes(r.summary.status));
  const dist = (xs) => { const d = {}; for (const r of xs) for (const c of r.summary.reasonCodes) d[c] = (d[c] || 0) + 1; return d; };
  const g = { total: rs.length, errors: rs.length - ok.length, byStatus,
    engineRoute: engineRoute.length, reproduced: reproduced.length,
    successRate: engineRoute.length ? reproduced.length / engineRoute.length : null,
    coverage: { applicable: engineRoute.length, total: ok.length }, notApplicableByReason: dist(na), notReproducedByReason: dist(failed) };
  out.groups[name] = g;
  md.push(`## ${name}`, "",
    `- 状态分布：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join("，")}${g.errors ? `，运行错误 ${g.errors}` : ""}`,
    `- 复现成功率（分母 = 计划模型判 applicable、进入引擎路线的题）：${reproduced.length}/${engineRoute.length}`,
    `- 覆盖率（applicable / 总题）：${engineRoute.length}/${ok.length}`,
    `- 不适用按 reason_code：${JSON.stringify(g.notApplicableByReason)}`,
    `- 未复现/部分复现原因：${JSON.stringify(g.notReproducedByReason)}`, "",
    "| 题 | 来源 | 状态 | 原因 | 标记 | 计划调用 | 模型调用 | token 入/出 | 费用 | 计划耗时 | 引擎耗时 |", "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rs.map(row), "");
  md.push("### 四类状态样例", "");
  for (const st of ["已复现", "部分复现", "未复现", "不适用", "未进入"]) {
    const xs = ok.filter((r) => r.summary.status === st);
    md.push(`- ${st}：${xs.length ? xs.map((r) => r.qid).join("、") : "（无）"}`);
  }
  md.push("");
  md.push("### 全部“不适用”判断", "");
  for (const r of na) {
    md.push(`- **${r.qid}** ${r.summary.reasonCodes.join(",")}${r.plan?.archetype_name ? `（字段：${r.plan.archetype_name}${r.archetypeVerified === false ? "，未核实" : ""}）` : ""}：题面「${r.text.replace(/\n/g, " ")}」`,
      `  - 依据：${r.plan?.quoted_span ? `「${r.plan.quoted_span}」` : (r.preStatus?.detail || "")}`);
  }
  md.push("");
}
// Latency of the reproduction itself (planner calls + engine), per question; the main answer is
// not part of a batch, so the race against it is measured only on the integrated path.
const latency = [];
for (const r of records) {
  if (r.error || !r.metrics) continue;
  const calls = (stage) => r.metrics.modelCalls.filter((c) => c.stage === stage).map((c) => ({ ...c, paid: paidOf(c) }));
  const fmt = (cs) => cs.map((c) => `${((c.paid?.ms ?? c.ms) / 1000).toFixed(1)} s / ${c.output ?? "?"} tok`).join("；") || "—";
  const plan = calls("plan");
  const repair = calls("repair");
  const totalMs = sum([...plan, ...repair].map((c) => c.paid?.ms ?? c.ms)) + (r.metrics.engineMs || 0);
  latency.push({ qid: r.qid, totalMs });
  md.push(`| ${r.qid} | ${fmt(plan)} | ${fmt(repair)} | ${r.metrics.engineMs} ms | ${(totalMs / 1000).toFixed(1)} s |`);
}
if (latency.length) {
  const sorted = latency.map((x) => x.totalMs).sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
  const table = md.splice(md.length - latency.length, latency.length);
  md.push("## 复现耗时（计划 + 修复 + 引擎，模型耗时取首次付费调用）", "",
    `- 中位 ${(pick(0.5) / 1000).toFixed(1)} s，P90 ${(pick(0.9) / 1000).toFixed(1)} s，最大 ${(sorted.at(-1) / 1000).toFixed(1)} s（${latency.find((x) => x.totalMs === sorted.at(-1)).qid}）`, "",
    "| 题 | 计划（耗时 / 输出 token） | 修复 | 引擎 | 合计 |", "|---|---|---|---|---|", ...table, "");
  out.latency = { medianMs: pick(0.5), p90Ms: pick(0.9), maxMs: sorted.at(-1), perQuestion: latency };
}
const ledger = ledgerRows;
const paid = ledger.filter((l) => !l.cacheHit && !l.mock);
md.push("## 费用与调用（ledger，含所有实验轮次）", "", `- 付费调用 ${paid.length} 次，输入 ${sum(paid.map((l) => l.usage?.input_tokens))} token，输出 ${sum(paid.map((l) => l.usage?.output_tokens))} token（含推理 ${sum(paid.map((l) => l.usage?.output_tokens_details?.reasoning_tokens))}），按官方单价约 $${sum(paid.map((l) => l.costUsd)).toFixed(4)}；缓存命中 ${ledger.filter((l) => l.cacheHit).length} 次。`);
out.ledger = { paidCalls: paid.length, costUsd: sum(paid.map((l) => l.costUsd)) };
writeFileSync(join(runDir, "report.md"), md.join("\n") + "\n");
writeFileSync(join(runDir, "report.json"), JSON.stringify(out, null, 1));
console.log(md.join("\n"));
