#!/usr/bin/env node
// Builds a Markdown comparison from one run directory of
// run-retrieval-compare.mjs. It only lays out what the run recorded (evidence
// ids and titles, answers, cost, time); it makes no correctness judgment. The
// judgment columns are left empty for the user. A run that stopped at the
// evidence pack (the default) gets the evidence-comparison layout; a run with
// --with-final gets the answer table.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { firstSentence, packedEvidenceLabels, ruleTocOfResult, summarizePromptBundle,
  summarizeRuleToc } from "./lib/evidence-summary.mjs";
import { loadRun } from "./lib/run-files.mjs";
import { COST_STAGES, COST_STAGE_LABELS } from "./lib/stage-costs.mjs";

function cell(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>").trim();
}

function seconds(ms) {
  return Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "–";
}

function usd(value, digits = 4) {
  return Number.isFinite(value) ? `$${value.toFixed(digits)}` : "–";
}

// Nearest-rank percentile on the sorted sample; median averages the middle pair.
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function triple(values) {
  return `${seconds(mean(values))} / ${seconds(median(values))} / ${seconds(percentile(values, 0.95))}`;
}

// Arms in run order. Older manifests record a single flag (armFlag/armValues).
function runArms(manifest) {
  return [...(manifest.arms || [])];
}

function baseArmOf(arms) {
  return arms.includes("baseline") ? "baseline" : arms[0];
}

export function armHasToc(manifest, arm) {
  if (manifest.armConfigs?.[arm]) return manifest.armConfigs[arm].RULE_TOC_ADMIT_ENABLED === "true";
  return manifest.armFlag === "RULE_TOC_ADMIT_ENABLED" && manifest.armValues?.[arm] === "true";
}

function armDescription(manifest, arm) {
  const config = manifest.armConfigs?.[arm];
  if (!config) return `${manifest.armFlag}=${manifest.armValues?.[arm]}`;
  const planning = manifest.armPlanning?.[arm];
  return `导航 ${config.RULE_NAVIGATION_PARTITION}、规划 ${planning ? `${planning.model} ${planning.reasoningEffort}`
    : config.EVIDENCE_PLANNING_PROFILE}、ToC ${config.RULE_TOC_ADMIT_ENABLED === "true" ? "开" : "关"}`;
}

function idsOfKind(result, kind) {
  return new Set(result?.evidence?.summary?.idsByKind?.[kind] || []);
}

function difference(left, right) {
  return [...left].filter((id) => !right.has(id));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

// Field names baseline/toc are kept for compatibility: left arm / right arm.
export function compareEvidence(baseline, toc) {
  if (baseline?.status !== "completed" || toc?.status !== "completed") return null;
  const kinds = new Set([...Object.keys(baseline.evidence?.summary?.idsByKind || {}),
    ...Object.keys(toc.evidence?.summary?.idsByKind || {})]);
  const byKind = {};
  for (const kind of kinds) {
    const left = idsOfKind(baseline, kind);
    const right = idsOfKind(toc, kind);
    byKind[kind] = { baseline: left.size, toc: right.size, added: difference(right, left), removed: difference(left, right) };
  }
  const allowedBaseline = new Set(baseline.evidence?.summary?.allowedEvidenceIds || []);
  const allowedToc = new Set(toc.evidence?.summary?.allowedEvidenceIds || []);
  return {
    byKind,
    evidenceIdsDiffer: !sameSet(allowedBaseline, allowedToc),
    promptDiffers: baseline.evidence?.finalPromptSha256 !== toc.evidence?.finalPromptSha256,
  };
}

function statusNote(result) {
  if (!result) return "（未运行）";
  if (result.status === "completed") return null;
  const message = result.error?.message ? `：${String(result.error.message).slice(0, 80)}` : "";
  return `（${result.status}${message}）`;
}

function answerCell(result) {
  return statusNote(result) || cell(firstSentence(result.answer?.text));
}

function ruleDiffCell(comparison) {
  if (!comparison) return "–";
  const rule = comparison.byKind.rule || { baseline: 0, toc: 0, added: [], removed: [] };
  const others = Object.entries(comparison.byKind).filter(([kind]) => kind !== "rule" && kind !== "card");
  const otherAdded = others.reduce((sum, [, entry]) => sum + entry.added.length, 0);
  const otherRemoved = others.reduce((sum, [, entry]) => sum + entry.removed.length, 0);
  const parts = [`规则 +${rule.added.length}/−${rule.removed.length}（${rule.baseline}→${rule.toc}）`];
  if (otherAdded || otherRemoved) parts.push(`QA/FAQ +${otherAdded}/−${otherRemoved}`);
  if (!comparison.evidenceIdsDiffer) parts.push(comparison.promptDiffers ? "编号相同，提示词不同" : "相同");
  return parts.join("；");
}

export const TOC_COLUMNS = Object.freeze(["ToC 状态", "ToC 选中", "ToC 入窗", "ToC 进最终包", "ToC 耗时 (s)",
  "ToC 费用 officialListUsd"]);

function count(value) {
  return Number.isFinite(value) ? String(value) : "–";
}

// Columns for one ToC-arm job, from the stage telemetry
// (ruleQueryModel.bounded.ruleToc). A --toc-path override replaces only the
// selected and in-pack counts and is marked with *.
export function tocCells(result) {
  if (!result) return TOC_COLUMNS.map(() => "–");
  const summary = summarizeRuleToc(ruleTocOfResult(result));
  const override = result.evidence?.toc?.override;
  if (!summary && !override) return ["无记录", "–", "–", "–", "–", "–"];
  return [
    cell(summary?.status || "–") + (summary?.error ? `（${cell(String(summary.error).slice(0, 40))}）` : ""),
    override ? `${override.selectedIds.length}*` : count(summary?.selectedCount),
    count(summary?.admittedCount),
    override ? `${override.inFinalPack.length}*` : count(summary?.selectedIntoPackCount),
    seconds(summary?.elapsedMs),
    usd(summary?.officialListUsd),
  ];
}

export function tocStageStats(results, arm = "toc") {
  const tocResults = results.filter((result) => result.job.arm === arm);
  const summaries = tocResults.map((result) => ({ result, summary: summarizeRuleToc(ruleTocOfResult(result)) }));
  const statuses = {};
  for (const { summary } of summaries) {
    const status = summary?.status || "无记录";
    statuses[status] = (statuses[status] || 0) + 1;
  }
  const withSummary = summaries.filter((entry) => entry.summary);
  const sum = (key) => {
    const values = withSummary.map((entry) => entry.summary[key]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const completed = summaries.filter((entry) => entry.result.status === "completed");
  const elapsed = withSummary.map((entry) => entry.summary.elapsedMs);
  return {
    jobs: tocResults.length,
    statuses,
    officialListUsd: sum("officialListUsd"),
    contractUsd: sum("contractUsd"),
    elapsed: { mean: mean(elapsed), median: median(elapsed), p95: percentile(elapsed, 0.95) },
    completed: completed.length,
    intoPack: completed.filter((entry) => (entry.summary?.selectedIntoPackCount || 0) > 0).length,
  };
}

function tocStatsLines(results, manifest, arms) {
  const lines = [];
  const tocArms = arms.filter((name) => armHasToc(manifest, name));
  for (const arm of tocArms) {
    const toc = tocStageStats(results, arm);
    const statusText = Object.entries(toc.statuses).map(([status, number]) => `${status} ${number}`).join("、") || "–";
    lines.push(`- ToC 阶段（${arm} 臂 ${toc.jobs} 个任务）：状态 ${statusText}；`
      + `费用合计 officialListUsd ${usd(toc.officialListUsd)}（contractUsd ${usd(toc.contractUsd)}，已含在 ${arm} 臂费用合计内）；`
      + `调用耗时 均值/中位/P95 ${seconds(toc.elapsed.mean)} / ${seconds(toc.elapsed.median)} / ${seconds(toc.elapsed.p95)} s。`);
    lines.push(`- 选中单元进入最终包的题数${tocArms.length > 1 ? `（${arm}）` : ""}：${toc.intoPack} / ${toc.completed}`
      + "（已完成任务中 selectedIntoPackCount > 0）。");
  }
  if (lines.length) {
    lines.push("- ToC 列取自 prepared.continuation.ruleQueryModel.bounded.ruleToc："
      + "选中 = selectedCount，入窗 = admittedCount（进入选证候选窗），进最终包 = selectedIntoPackCount。"
      + (manifest.tocPaths?.length ? ` 带 * 的选中/进最终包数来自 --toc-path 覆盖：${manifest.tocPaths.join("、")}。` : ""));
  }
  return lines;
}

function costTimeCell(result) {
  if (!result || result.status !== "completed") return "–";
  const wall = result.timingsMs?.wall || {};
  return `${usd(result.cost?.totalUsd)} · ${seconds(wall.prepare)}+${seconds(wall.finalize)}s`;
}

function armStats(results) {
  const completed = results.filter((result) => result.status === "completed");
  const totals = completed.map((result) => result.timingsMs?.wall?.total);
  const prepares = completed.map((result) => result.timingsMs?.wall?.prepare);
  const finalizes = completed.map((result) => result.timingsMs?.wall?.finalize);
  const costs = completed.map((result) => result.cost?.totalUsd);
  return {
    jobs: results.length,
    completed: completed.length,
    costUsd: costs.filter(Number.isFinite).reduce((sum, value) => sum + value, 0),
    meanCostUsd: mean(costs),
    time: {
      total: { mean: mean(totals), median: median(totals), p95: percentile(totals, 0.95) },
      prepare: { mean: mean(prepares), median: median(prepares), p95: percentile(prepares, 0.95) },
      finalize: { mean: mean(finalizes), median: median(finalizes), p95: percentile(finalizes, 0.95) },
    },
  };
}

// Evidence kinds are recomputed from the stored prompt bundle, so a report
// reflects the current classification without re-running paid jobs.
function withCurrentSummary(result) {
  const promptBundle = result?.prepared?.continuation?.promptBundle;
  if (!promptBundle || !result.evidence) return result;
  return { ...result, evidence: { ...result.evidence, summary: summarizePromptBundle(promptBundle) } };
}

function orderedRows(manifest, results) {
  const rows = new Map();
  for (const result of results) {
    const key = `${result.job.qid}#${result.job.repeat}`;
    if (!rows.has(key)) rows.set(key, { qid: result.job.qid, repeat: result.job.repeat, arms: {} });
    rows.get(key).arms[result.job.arm] = result;
  }
  const order = new Map((manifest.set.selectedQids || []).map((qid, index) => [qid, index]));
  return [...rows.values()].sort((left, right) => (order.get(left.qid) ?? 1e9) - (order.get(right.qid) ?? 1e9)
    || left.qid.localeCompare(right.qid) || left.repeat - right.repeat);
}

function headerLines(manifest, checkpoint, results, arms, title) {
  const lines = [`# ${title}：${cell(manifest.set.setId || manifest.set.file)}（${manifest.runId}）`, ""];
  if (manifest.mode === "mock") {
    lines.push("> **MOCK 运行**：回答、证据选择、token 和费用均为传输层假数据，只用于检查脚本与产物格式，不能用于判定。", "");
  }
  lines.push(`- 臂：${arms.map((arm) => `${arm}（${armDescription(manifest, arm)}）`).join("；")}`);
  lines.push(`- 模型配置 ${manifest.profile}；代码 ${String(manifest.git?.commit || "未知").slice(0, 12)}`
    + `${manifest.git?.dirty ? "（有未提交改动）" : ""}`);
  const revisions = [...new Set(results.map((result) => result.evidence?.dataRevision).filter(Boolean))];
  lines.push(`- 数据版本 dataRevision：${revisions.length ? revisions.map((value) => String(value).slice(0, 16)).join("、") : "–"}；`
    + `实时官方 Q&A：${manifest.liveOfficialQa}；账本：${manifest.ledgerMode}`);
  lines.push(`- 运行状态：${checkpoint?.status || "未知"}${checkpoint?.stopReason ? `（${checkpoint.stopReason}）` : ""}；`
    + `预算 ${usd(checkpoint?.budgetUsd ?? manifest.budgetUsd, 2)}，账本累计 ${usd(checkpoint?.spentUsd)}`);
  return lines;
}

function failureLines(results) {
  const lines = [];
  const failures = results.filter((result) => result.status !== "completed");
  if (failures.length) {
    lines.push(`- 未完成任务 ${failures.length} 个：${failures.map((result) => `${result.job.key}（${result.status}）`).join("、")}。`);
  }
  const integrity = results.filter((result) => result.integrity && !result.integrity.ok);
  if (integrity.length) {
    lines.push(`- 配置完整性检查未通过：${integrity.map((result) => `${result.job.key}: ${result.integrity.checks
      .filter((check) => !check.ok).map((check) => `${check.id}=${check.observed}`).join(",")}`).join("；")}。`);
  }
  return lines;
}

// --- Evidence comparison (runs that stop at the evidence pack) -------------

function evidenceView(result) {
  const promptBundle = result?.prepared?.continuation?.promptBundle;
  if (result?.status !== "completed" || !promptBundle) return null;
  const labels = packedEvidenceLabels(promptBundle);
  const atomLabel = new Map(labels.ruleSections.flatMap((section) => section.atomIds.map((id, index) => [id,
    { label: section.label, atom: section.atoms[index] }])));
  return { labels, atomLabel, qaLabel: new Map(labels.qa.map((item) => [item.id, item.label])) };
}

function sectionLines(sections) {
  return sections.map((section) => `${section.label} #${section.atoms.join(",")}`);
}

export function evidenceDiffCell(base, other) {
  if (!base || !other) return "–";
  const grouped = (ids, view) => {
    const sections = new Map();
    for (const id of ids) {
      const { label, atom } = view.atomLabel.get(id);
      if (!sections.has(label)) sections.set(label, []);
      sections.get(label).push(atom);
    }
    return [...sections].map(([label, atoms]) => `${label} #${atoms.join(",")}`);
  };
  const baseAtoms = new Set(base.atomLabel.keys());
  const otherAtoms = new Set(other.atomLabel.keys());
  const baseQa = new Set(base.qaLabel.values());
  const otherQa = new Set(other.qaLabel.values());
  const parts = [
    ...grouped(difference(otherAtoms, baseAtoms), other).map((label) => `+规则 ${label}`),
    ...grouped(difference(baseAtoms, otherAtoms), base).map((label) => `−规则 ${label}`),
    ...difference(otherQa, baseQa).map((label) => `+${label}`),
    ...difference(baseQa, otherQa).map((label) => `−${label}`),
  ];
  return parts.length ? parts.join("\n") : "相同";
}

function tocSummaryCell(result) {
  const summary = summarizeRuleToc(ruleTocOfResult(result));
  if (!summary) return "–";
  return `${summary.status || "–"}${summary.error ? `（${String(summary.error).slice(0, 40)}）` : ""} `
    + `选中 ${count(summary.selectedCount)} / 入窗 ${count(summary.admittedCount)} / 进包 ${count(summary.selectedIntoPackCount)}`;
}

function stageCostTotals(results) {
  const totals = Object.fromEntries(COST_STAGES.map((stage) => [stage, 0]));
  for (const result of results) {
    for (const stage of COST_STAGES) totals[stage] += result.cost?.byStage?.[stage]?.usd || 0;
  }
  return totals;
}

export function buildEvidenceCompareReport({ manifest, checkpoint, results: storedResults }) {
  const results = storedResults.map(withCurrentSummary);
  const arms = runArms(manifest);
  const base = baseArmOf(arms);
  const rows = orderedRows(manifest, results);
  const multipleRepeats = rows.some((row) => row.repeat > 1);
  const lines = headerLines(manifest, checkpoint, results, arms, "证据对比");
  lines.push("- 只到证据包（--prepare-only）：不调用最终作答模型，下面是最终模型将收到的证据。");
  lines.push(`- 规则按「sourceId › 标题路径 #atom 序号」列出，不贴正文；QA 为官方编号 QA#n，FAQ 为记录 id。增减相对 ${base} 臂。`);
  lines.push("- 「证据是否包含参考答案所需依据」由用户填写；本报告不做任何正误或充分性判断。", "");

  lines.push("## 逐题证据", "");
  for (const row of rows) {
    const anyResult = Object.values(row.arms)[0];
    lines.push(`### ${row.qid}${multipleRepeats ? ` #${row.repeat}` : ""}`, "");
    lines.push(`- 题面：${cell(anyResult?.question || "")}`);
    lines.push(`- 参考答案：${cell(String(anyResult?.referenceAnswer || "").trim() || "（空）")}`, "");
    lines.push(`| 臂 | 规则单元（sourceId › 标题路径 #atom） | QA/FAQ | 相对 ${base} 增减 | ToC | 准备 (s) | 费用 | 证据是否包含参考答案所需依据（用户填） |`,
      "|---|---|---|---|---|---|---|---|");
    const baseView = evidenceView(row.arms[base]);
    for (const arm of arms) {
      const result = row.arms[arm];
      const note = statusNote(result);
      const view = evidenceView(result);
      const rules = view ? cell(sectionLines(view.labels.ruleSections).join("\n")) || "（无）" : note;
      const qa = view ? cell([...view.labels.qa, ...view.labels.other].map((item) => item.label).join("、")) || "（无）" : "–";
      const diff = arm === base ? "（基线）" : cell(evidenceDiffCell(baseView, view));
      const toc = armHasToc(manifest, arm) && result ? cell(tocSummaryCell(result)) : "–";
      lines.push(`| ${arm} | ${rules} | ${qa} | ${diff} | ${toc} | ${seconds(result?.timingsMs?.wall?.prepare)} | `
        + `${result ? usd(result.cost?.totalUsd) : "–"} |  |`);
    }
    lines.push("");
  }

  lines.push("## 汇总（按臂）", "");
  const summaryHeader = ["臂", "完成/任务", "费用合计", "每题均值",
    ...COST_STAGES.filter((stage) => stage !== "final").map((stage) => COST_STAGE_LABELS[stage]),
    "准备 均值/中位/P95 (s)", "规划 均值/中位/P95 (s)", "选证 均值/中位/P95 (s)", "ToC 调用 均值/中位/P95 (s)",
    "串行合计 (min)"];
  lines.push(`| ${summaryHeader.join(" | ")} |`, `|${summaryHeader.map(() => "---").join("|")}|`);
  const armResults = Object.fromEntries(arms.map((arm) => [arm, results.filter((result) => result.job.arm === arm)]));
  let serialMs = 0;
  for (const arm of arms) {
    const stats = armStats(armResults[arm]);
    const completed = armResults[arm].filter((result) => result.status === "completed");
    const totals = stageCostTotals(completed);
    const stage = (key) => completed.map((result) => result.timingsMs?.stages?.[key]);
    const armSerial = armResults[arm].reduce((sum, result) => sum + (result.timingsMs?.wall?.prepare || 0), 0);
    serialMs += armSerial;
    lines.push(`| ${arm} | ${stats.completed}/${stats.jobs} | ${usd(stats.costUsd)} | ${usd(stats.meanCostUsd)} | `
      + `${COST_STAGES.filter((key) => key !== "final").map((key) => usd(totals[key])).join(" | ")} | `
      + `${triple(stage("prepare"))} | ${triple(stage("planning"))} | ${triple(stage("selection"))} | `
      + `${armHasToc(manifest, arm) ? triple(stage("tocCall")) : "–"} | ${(armSerial / 60000).toFixed(1)} |`);
  }
  lines.push("");
  const completedCost = arms.reduce((sum, arm) => sum + armStats(armResults[arm]).costUsd, 0);
  lines.push(`- 总费用：已完成任务合计 ${usd(completedCost)}；账本累计（含失败/中断任务已发生的调用）${usd(checkpoint?.spentUsd)}。`
    + `各任务准备耗时串行合计 ${(serialMs / 60000).toFixed(1)} 分钟（并发运行时墙钟更短）。`);
  for (const arm of arms.filter((name) => name !== base)) {
    const pairs = rows.map((row) => compareEvidence(row.arms[base], row.arms[arm])).filter(Boolean);
    lines.push(`- ${arm} 相对 ${base}：两臂都完成 ${pairs.length} 题，证据编号集合不同 ${pairs.filter((pair) => pair.evidenceIdsDiffer).length} 题。`);
  }
  lines.push(...tocStatsLines(results, manifest, arms));
  lines.push(...failureLines(results));
  lines.push("- 费用为账本按供应商回报 usage 结算的理论费用（Luna/Gemini 用后端内置牌价）；分阶段按账本调用归类："
    + "卡名 = 卡名抽取与身份选择，规划 = 证据规划，向量 = Gemini 查询向量，选证 = Luna 选证，ToC = 规则目录调用。");
  lines.push("- 耗时为 runner 墙钟与管线自报：准备 = 卡名→检索→选证→组包；规划/选证/ToC 为各自模型调用（含一次格式重试）。"
    + "ToC 与规划、检索并行，只有比它们慢时才拉长准备时间。P95 用最近秩法。", "");
  return `${lines.join("\n")}\n`;
}

// --- Answer table (runs with --with-final) ---------------------------------

export function buildRetrievalCompareReport({ manifest, checkpoint, results: storedResults }) {
  if (manifest.prepareOnly === true) return buildEvidenceCompareReport({ manifest, checkpoint, results: storedResults });
  const results = storedResults.map(withCurrentSummary);
  const arms = runArms(manifest);
  const base = baseArmOf(arms);
  const others = arms.filter((arm) => arm !== base);
  const tocArms = arms.filter((arm) => armHasToc(manifest, arm));
  const ordered = orderedRows(manifest, results);
  const multipleRepeats = ordered.some((row) => row.repeat > 1);
  const lines = headerLines(manifest, checkpoint, results, arms, "检索方式对比");
  lines.push("- 判定列留空，由用户填写；本报告不做任何正误判断。", "");

  const tocHeader = (arm) => TOC_COLUMNS.map((column) => (tocArms.length > 1 ? `${arm} ${column}` : column));
  const header = ["题号", "参考答案", ...arms.map((arm) => `${arm} 回答首句`),
    ...others.map((arm) => `证据包差异（${arm} 相对 ${base}）`), ...tocArms.flatMap(tocHeader),
    ...arms.map((arm) => `${arm} 费用 · 准备+作答`), ...arms.map((arm) => `判定 ${arm}（用户填）`)];
  lines.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
  const comparisons = Object.fromEntries(others.map((arm) => [arm, []]));
  for (const row of ordered) {
    const anyResult = Object.values(row.arms)[0];
    const label = multipleRepeats ? `${row.qid} #${row.repeat}` : row.qid;
    const reference = String(anyResult?.referenceAnswer || "").trim() || "（空）";
    const cells = [label, cell(reference), ...arms.map((arm) => answerCell(row.arms[arm]))];
    for (const arm of others) {
      const comparison = compareEvidence(row.arms[base], row.arms[arm]);
      comparisons[arm].push(comparison);
      cells.push(ruleDiffCell(comparison));
    }
    for (const arm of tocArms) cells.push(...tocCells(row.arms[arm]));
    cells.push(...arms.map((arm) => costTimeCell(row.arms[arm])), ...arms.map(() => ""));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## 汇总", "");
  lines.push("| 臂 | 完成/任务 | 费用合计 | 每题均值 | 总耗时 均值/中位/P95 (s) | 准备 均值/中位/P95 (s) | 作答 均值/中位/P95 (s) |",
    "|---|---|---|---|---|---|---|");
  const statsByArm = {};
  for (const arm of arms) {
    const stats = armStats(results.filter((result) => result.job.arm === arm));
    statsByArm[arm] = stats;
    const tripleOf = (entry) => `${seconds(entry.mean)} / ${seconds(entry.median)} / ${seconds(entry.p95)}`;
    lines.push(`| ${arm} | ${stats.completed}/${stats.jobs} | ${usd(stats.costUsd)} | ${usd(stats.meanCostUsd)} | `
      + `${tripleOf(stats.time.total)} | ${tripleOf(stats.time.prepare)} | ${tripleOf(stats.time.finalize)} |`);
  }
  lines.push("");
  const completedCost = Object.values(statsByArm).reduce((sum, stats) => sum + stats.costUsd, 0);
  lines.push(`- 总费用：已完成任务合计 ${usd(completedCost)}；账本累计（含失败/中断任务已发生的调用）${usd(checkpoint?.spentUsd)}。`);
  for (const arm of others) {
    const pairs = comparisons[arm].filter(Boolean);
    const differ = pairs.filter((pair) => pair.evidenceIdsDiffer).length;
    const promptDiffer = pairs.filter((pair) => pair.promptDiffers).length;
    lines.push(arms.length === 2
      ? `- 两臂都完成的题 ${pairs.length} 道；证据编号集合不同 ${differ} 道；最终提示词哈希不同 ${promptDiffer} 道。`
      : `- ${arm} 相对 ${base}：两臂都完成的题 ${pairs.length} 道；证据编号集合不同 ${differ} 道；最终提示词哈希不同 ${promptDiffer} 道。`);
  }
  lines.push(...tocStatsLines(results, manifest, arms));
  lines.push(...failureLines(results));
  lines.push("- 耗时为 runner 墙钟：准备 = 卡名→检索→选证→组包，作答 = 最终模型；不含范围检查和 HTTP。P95 用最近秩法。", "");

  for (const arm of others) {
    const details = ordered.map((row, index) => ({ row, comparison: comparisons[arm][index] }))
      .filter((entry) => entry.comparison?.evidenceIdsDiffer);
    if (!details.length) continue;
    lines.push(`## 证据差异明细（${arm} 相对 ${base}）`, "");
    for (const { row, comparison } of details) {
      const label = multipleRepeats ? `${row.qid} #${row.repeat}` : row.qid;
      const parts = Object.entries(comparison.byKind)
        .filter(([, entry]) => entry.added.length || entry.removed.length)
        .map(([kind, entry]) => `${kind}：新增 ${entry.added.map((id) => `\`${id}\``).join("、") || "无"}；`
          + `减少 ${entry.removed.map((id) => `\`${id}\``).join("、") || "无"}`);
      lines.push(`- **${label}** ${parts.join("。")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--run" || argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 需要一个值`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`未知参数: ${argument}`);
  }
  if (!options.help && !options.run) throw new Error("缺少 --run <运行目录>");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/bench/report-retrieval-compare.mjs --run <运行目录> [--out <report.md>]\n默认写到 <运行目录>/report.md");
    return;
  }
  const runDir = path.resolve(options.run);
  const report = buildRetrievalCompareReport(await loadRun(runDir));
  const outFile = path.resolve(options.out || path.join(runDir, "report.md"));
  await writeFile(outFile, report, "utf8");
  console.log(`已写入 ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
