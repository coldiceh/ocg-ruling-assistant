import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEvidenceFreshness } from "../backend/evidenceFreshness.mjs";

const now = new Date("2026-06-28T12:00:00Z");
const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();

test("a successful sync within two days is fresh", () => {
  const result = evaluateEvidenceFreshness({ snapshotMeta: { lastSuccessfulSyncAt: daysAgo(1) }, now });
  assert.equal(result.freshness, "fresh");
  assert.equal(result.safetyPenalty, 0);
});
test("two to seven days is stale with a warning", () => {
  const result = evaluateEvidenceFreshness({ snapshotMeta: { lastSuccessfulSyncAt: daysAgo(4) }, now });
  assert.equal(result.freshness, "stale");
  assert.equal(result.safetyPenalty, 1);
  assert.ok(result.warnings.length);
});
test("older than seven days applies a safety penalty", () => {
  assert.equal(evaluateEvidenceFreshness({ snapshotMeta: { lastSuccessfulSyncAt: daysAgo(8) }, now }).safetyPenalty, 1);
});
test("failed sync without a successful snapshot is unknown", () => {
  const result = evaluateEvidenceFreshness({ snapshotMeta: { syncFailureCount: 1 }, now });
  assert.equal(result.freshness, "unknown");
  assert.equal(result.safetyPenalty, 2);
});
test("conflict evidence blocks confirmation", () => {
  const result = evaluateEvidenceFreshness({ snapshotMeta: { lastSuccessfulSyncAt: daysAgo(1) }, evidenceList: [{ id: "x", status: "conflict" }], now });
  assert.equal(result.freshness, "conflict");
  assert.equal(result.safetyPenalty, 2);
});
