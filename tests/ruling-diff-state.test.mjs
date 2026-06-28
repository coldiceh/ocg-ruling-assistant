import assert from "node:assert/strict";
import test from "node:test";
import { diffRulingSnapshot, normalizeEvidenceRecord } from "../backend/rulingDiffState.mjs";

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
