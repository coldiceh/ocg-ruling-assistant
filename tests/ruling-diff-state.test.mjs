import assert from "node:assert/strict";
import test from "node:test";
import {
  diffRulingSnapshot,
  mergeRulingDetailsWithQaIndex,
  normalizeEvidenceRecord,
} from "../backend/rulingDiffState.mjs";

const old = normalizeEvidenceRecord({ id: "qa-1", recordType: "qa", question: "Q", answer: "旧回答", status: "current" }, { now: "2026-06-20T00:00:00Z" });
test("changed text supersedes the old version and creates a current version", () => {
  const result = diffRulingSnapshot({ previousEvidence: [old], currentEvidence: [{ id: "qa-1", recordType: "qa", question: "Q", answer: "新回答" }], now: "2026-06-28T00:00:00Z" });
  assert.equal(result.report.changedItems, 1);
  assert.equal(result.records.filter((item) => item.status === "superseded").length, 1);
  assert.equal(result.records.filter((item) => item.status === "current").length, 1);
});
test("disappearing evidence is retained as removed", () => {
  const result = diffRulingSnapshot({ previousEvidence: [old], currentEvidence: [], now: "2026-06-28T00:00:00Z" });
  assert.equal(result.records[0].status, "removed");
});
test("failed synchronization preserves the previous current database", () => {
  const result = diffRulingSnapshot({ previousEvidence: [old], currentEvidence: [], syncSucceeded: false });
  assert.equal(result.records[0].status, "current");
  assert.equal(result.report.sourceFreshness, "stale");
});
test("two new hashes for one stable id become conflict evidence", () => {
  const result = diffRulingSnapshot({ currentEvidence: [{ id: "qa-x", text: "可以" }, { id: "qa-x", text: "不可以" }] });
  assert.equal(result.report.conflictCount, 1);
  assert.ok(result.records.every((item) => item.status === "conflict"));
});

test("normalization preserves detailed official-question identity and hashes detailed changes", () => {
  const base = {
    id: "qa-synthetic-detail-hash",
    recordType: "qa",
    question: "简短标题",
    rawQuestion: "原始简短标题",
    rawDetailedQuestion: "「<<81001>>」存在时可以执行操作吗？",
    questionCardIds: ["81001", "81002", "81001"],
    answer: "可以执行。",
  };
  const first = normalizeEvidenceRecord(base, { now: "2026-08-11T00:00:00Z" });
  const changed = normalizeEvidenceRecord({
    ...base,
    rawDetailedQuestion: "「<<81001>>」不存在时可以执行操作吗？",
  }, { now: "2026-08-11T00:00:00Z" });

  assert.equal(first.rawQuestion, base.rawQuestion);
  assert.equal(first.rawDetailedQuestion, base.rawDetailedQuestion);
  assert.deepEqual(first.questionCardIds, ["81001", "81002"]);
  assert.notEqual(first.textHash, changed.textHash);

  const diff = diffRulingSnapshot({
    previousEvidence: [first],
    currentEvidence: [{ ...base, rawDetailedQuestion: changed.rawDetailedQuestion }],
    now: "2026-08-12T00:00:00Z",
  });
  assert.equal(diff.report.changedItems, 1);
});

test("bounded detail rotation keeps compact current QA in the version-diff input", () => {
  const merged = mergeRulingDetailsWithQaIndex([
    { id: "qa-current-detail", recordType: "qa", answer: "rich" },
    { id: "card-faq-current", recordType: "card-faq", answer: "faq" },
  ], [
    { id: "qa-current-detail", recordType: "qa", answer: "compact duplicate" },
    { id: "qa-long-tail", recordType: "qa", answer: "compact long tail" },
    { id: "card-faq-stale", recordType: "card-faq", answer: "must not survive" },
  ]);

  assert.deepEqual(merged.map((record) => record.id), [
    "qa-current-detail",
    "card-faq-current",
    "qa-long-tail",
  ]);
  assert.equal(merged[0].answer, "rich");
});

test("rich and compact forms of one structured QA have a stable version hash", () => {
  const rich = normalizeEvidenceRecord({
    id: "qa-structured-rotation",
    recordType: "qa",
    question: "简短问题",
    rawQuestion: "简短问题",
    rawDetailedQuestion: "完整条件下可以执行吗？",
    conclusion: "不能执行。",
  }, { now: "2026-08-11T00:00:00Z" });
  const compact = normalizeEvidenceRecord({
    id: "qa-structured-rotation",
    recordType: "qa",
    question: "简短问题",
    rawQuestion: "简短问题",
    rawDetailedQuestion: "完整条件下可以执行吗？",
    answer: "不能执行。",
    text: "简短问题\n完整条件下可以执行吗？\n重复标题\n不能执行。",
  }, { now: "2026-08-12T00:00:00Z" });

  assert.equal(rich.textHash, compact.textHash);
  const compactDiff = diffRulingSnapshot({
    previousEvidence: [rich],
    currentEvidence: [compact],
    now: "2026-08-12T00:00:00Z",
  });
  assert.equal(compactDiff.report.unchangedItems, 1);
  assert.equal(compactDiff.report.changedItems, 0);

  const richAgainDiff = diffRulingSnapshot({
    previousEvidence: compactDiff.records,
    currentEvidence: [rich],
    now: "2026-08-13T00:00:00Z",
  });
  assert.equal(richAgainDiff.report.unchangedItems, 1);
  assert.equal(richAgainDiff.report.changedItems, 0);
});
