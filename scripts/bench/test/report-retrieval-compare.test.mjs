import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRetrievalCompareReport,
  compareEvidence,
  median,
  percentile,
  tocCells,
} from "../report-retrieval-compare.mjs";
import { firstSentence, summarizePromptBundle, summarizeRuleToc } from "../lib/evidence-summary.mjs";

function bundle(rules, qa = [], faq = []) {
  return {
    prompt: `PROMPT ${rules.join(",")} ${qa.join(",")} ${faq.join(",")}`,
    promptPayload: { resolvedCards: [{ id: "c1", name: "卡" }] },
    modelEvidence: {
      cardTexts: [],
      rawRelatedEvidence: [
        ...rules.map((id) => ({ id, recordType: "rule-doc" })),
        ...qa.map((id) => ({ id, recordType: "qa" })),
        ...faq.map((id) => ({ id, recordType: "card-faq" })),
      ],
    },
    allowedEvidenceIds: [...rules, ...qa, ...faq],
  };
}

// Stage telemetry as written by geminiBoundedEvidenceProvider (bounded.ruleToc).
function ruleToc({ status = "selected", selected = [], admitted = selected, intoPack = admitted, elapsedMs = 2_400,
  officialListUsd = 0.0061, contractUsd = 0.012, error }) {
  return { status, ...(error ? { error } : {}), selectedUnitKeys: selected, selectedCount: selected.length,
    admittedUnitKeys: admitted, admittedCount: admitted.length, inBaselineWindowUnitKeys: [], inBaselineWindowCount: 0,
    inOtherLanesUnitKeys: [], inOtherLanesCount: 0, selectedIntoPackUnitKeys: intoPack,
    selectedIntoPackCount: intoPack.length, notAdmitted: [], elapsedMs, assetWaitMs: 3, inputTokens: 60_000,
    cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 20, contractUsd, officialListUsd, accountedUsd: contractUsd,
    tocUnits: 563, tocChars: 102_785, attempts: [{ status: "success" }] };
}

function result({ qid, arm, repeat = 1, status = "completed", answer = "结论。理由。", promptBundle, costUsd = 0.1,
  prepareMs = 10_000, finalizeMs = 2_000, toc = null, reference = "参考结论。" }) {
  const summary = promptBundle ? summarizePromptBundle(promptBundle) : null;
  return {
    job: { key: `${qid}__${arm}__r${repeat}`, qid, arm, repeat },
    status,
    referenceAnswer: reference,
    answer: status === "completed" ? { text: answer } : null,
    timingsMs: { wall: { prepare: prepareMs, finalize: finalizeMs, total: prepareMs + finalizeMs } },
    cost: { totalUsd: costUsd },
    evidence: promptBundle ? { dataRevision: "rev-1", finalPromptSha256: summary.promptSha256, summary } : null,
    prepared: promptBundle ? { continuation: { promptBundle, ruleQueryModel: { bounded: toc ? { ruleToc: toc } : {} } } } : null,
    error: status === "completed" ? null : { message: "provider timeout",
      boundedRetrieval: toc ? { ruleToc: toc } : null },
  };
}

const manifest = {
  runId: "fixture-run", mode: "real", arms: ["baseline", "toc"], armFlag: "RULE_TOC_ADMIT_ENABLED",
  armValues: { baseline: "false", toc: "true" }, profile: "official-astra-low", ledgerMode: "memory",
  liveOfficialQa: "(unset: production default on)", git: { commit: "abcdef1234567890", dirty: false },
  set: { setId: "fixture-set", selectedQids: ["Q1", "Q2", "Q3"] }, budgetUsd: 5,
};
const checkpoint = { status: "completed", stopReason: null, budgetUsd: 5, spentUsd: 0.73 };

test("report rows keep answers verbatim, show evidence diffs and leave both judgment columns empty", () => {
  const results = [
    result({ qid: "Q1", arm: "baseline", answer: "**可以发动。**处理时不适用。", promptBundle: bundle(["r1", "r2"], ["q1"]) }),
    result({ qid: "Q1", arm: "toc", answer: "不能发动|原因见下。", promptBundle: bundle(["r2", "r3", "r4"], ["q1"], ["f1"]),
      toc: ruleToc({ selected: ["u3", "u9"], admitted: ["u3"], intoPack: ["u3"] }), costUsd: 0.13, prepareMs: 12_000 }),
    result({ qid: "Q2", arm: "baseline", promptBundle: bundle(["r1"]) }),
    result({ qid: "Q2", arm: "toc", promptBundle: bundle(["r1"]),
      toc: ruleToc({ status: "empty", selected: [], elapsedMs: 1_500, officialListUsd: 0.0049, contractUsd: 0.01 }) }),
    result({ qid: "Q3", arm: "baseline", promptBundle: bundle(["r5"]), costUsd: 0.2 }),
    result({ qid: "Q3", arm: "toc", status: "failed",
      toc: { status: "timeout", error: "rule_toc_timeout", selectedUnitKeys: [], elapsedMs: 30_000, attempts: [] } }),
  ];
  const report = buildRetrievalCompareReport({ manifest, checkpoint, results });
  const rows = report.split("\n").filter((line) => /^\| Q\d/u.test(line));
  assert.equal(rows.length, 3);
  const q1 = rows[0].split(" | ");
  assert.equal(q1[0], "| Q1");
  assert.equal(q1[1], "参考结论。");
  assert.equal(q1[2], "可以发动。");
  assert.equal(q1[3], "不能发动原因见下。"); // table pipes are display-only Markdown
  assert.equal(q1[4], "规则 +2/−1（2→3）；QA/FAQ +1/−0");
  assert.deepEqual(q1.slice(5, 11), ["selected", "2", "1", "1", "2.4", "$0.0061"]);
  assert.equal(q1[11], "$0.1000 · 10.0+2.0s");
  assert.equal(q1[12], "$0.1300 · 12.0+2.0s");
  assert.deepEqual(rows[1].split(" | ").slice(5, 11), ["empty", "0", "0", "0", "1.5", "$0.0049"]);
  assert.deepEqual(rows[2].split(" | ").slice(5, 11), ["timeout（rule_toc_timeout）", "0", "–", "–", "30.0", "–"]);
  assert.ok(rows.every((row) => row.endsWith("|  |  |")), "judgment columns must stay empty");
  assert.match(rows[1], /规则 \+0\/−0（1→1）；相同/u);
  assert.match(rows[2], /（failed：provider timeout）/u);
  assert.match(report, /两臂都完成的题 2 道；证据编号集合不同 1 道/u);
  assert.match(report, /ToC 阶段（toc 臂 3 个任务）：状态 selected 1、empty 1、timeout 1；费用合计 officialListUsd \$0\.0110（contractUsd \$0\.0220/u);
  assert.match(report, /选中单元进入最终包的题数：1 \/ 2/u);
  assert.match(report, /\| baseline \| 3\/3 \| \$0\.4000 \| \$0\.1333 \|/u);
  assert.match(report, /\| toc \| 2\/3 \| \$0\.2300 \|/u);
  assert.match(report, /- \*\*Q1\*\* rule：新增 `r3`、`r4`；减少 `r1`。faq：新增 `f1`；减少 无/u);
  assert.match(report, /未完成任务 1 个：Q3__toc__r1（failed）/u);
  assert.doesNotMatch(report, /正确|错误|通过率|准确率/u);
});

test("repeats are labelled per run and mock runs carry a warning", () => {
  const results = [1, 2].flatMap((repeat) => ["baseline", "toc"].map((arm) => result({ qid: "S1", arm, repeat,
    reference: "", promptBundle: bundle(["r1"]) })));
  const report = buildRetrievalCompareReport({ manifest: { ...manifest, mode: "mock",
    set: { setId: "stability", selectedQids: ["S1"] } }, checkpoint, results });
  assert.match(report, /MOCK 运行/u);
  assert.match(report, /\| S1 #1 \| （空） \|/u);
  assert.match(report, /\| S1 #2 \| （空） \|/u);
});

test("statistics and helpers are mechanical", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([], 0.95), null);
  assert.equal(firstSentence("**结论：可以。**\n理由"), "结论：可以。");
  assert.equal(firstSentence("没有句号的一行\n第二行"), "没有句号的一行");
  assert.equal(compareEvidence(result({ qid: "Q", arm: "baseline", status: "failed" }), null), null);
  const summary = summarizePromptBundle(bundle(["r1"], ["q1"], ["f1"]));
  assert.deepEqual(summary.counts, { rule: 1, qa: 1, faq: 1, card: 1 });
});

test("ToC columns read bounded.ruleToc, mark --toc-path overrides and survive a missing stage record", () => {
  const promptBundle = bundle(["r1", "r2"]);
  const overridden = result({ qid: "Q1", arm: "toc", promptBundle, toc: ruleToc({ selected: ["u1"] }) });
  overridden.evidence.toc = { override: { selectedIds: ["r1", "r7", "r9"], inFinalPack: ["r1"] } };
  assert.deepEqual(tocCells(overridden), ["selected", "3*", "1", "1*", "2.4", "$0.0061"]);
  assert.deepEqual(tocCells(result({ qid: "Q1", arm: "toc", promptBundle })), ["无记录", "–", "–", "–", "–", "–"]);
  const partial = summarizeRuleToc({ status: "failed", selectedUnitKeys: ["a", "b"], error: "rule_toc_output_invalid" });
  assert.equal(partial.selectedCount, 2);
  assert.equal(partial.admittedCount, null);
  const report = buildRetrievalCompareReport({ manifest: { ...manifest, tocPaths: ["continuation.x.ids"],
    set: { setId: "s", selectedQids: ["Q1"] } }, checkpoint, results: [overridden] });
  assert.match(report, /带 \* 的选中\/进最终包数来自 --toc-path 覆盖：continuation\.x\.ids/u);
  assert.equal(stripToc(buildRetrievalCompareReport({ manifest: { ...manifest, arms: ["baseline"] }, checkpoint,
    results: [result({ qid: "Q1", arm: "baseline", promptBundle })] })).includes("ToC 状态"), false);
});

function stripToc(text) {
  return text.split("\n").filter((line) => line.startsWith("| 题号")).join("\n");
}
