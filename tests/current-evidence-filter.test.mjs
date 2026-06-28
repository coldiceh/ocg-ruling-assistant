import assert from "node:assert/strict";
import test from "node:test";
import { canEvidenceSupportOfficial, filterCurrentEvidence } from "../backend/currentEvidenceFilter.mjs";

test("only the latest current version of a stable id is used", () => {
  const result = filterCurrentEvidence([{ id: "qa-1", recordType: "qa", text: "new" }], { evidenceIndex: [
    { evidenceId: "old", stableId: "qa-1", status: "superseded", textHash: "old" },
    { evidenceId: "new", stableId: "qa-1", status: "current", textHash: "new", sourceTier: "S0_OFFICIAL_DB_MIRROR" },
  ], sourceFreshness: "fresh" });
  assert.equal(result.currentEvidence.length, 1);
  assert.equal(result.currentEvidence[0].evidenceId, "new");
});
test("removed, superseded, parse-failed and conflict entries are blocked", () => {
  for (const status of ["removed", "superseded", "parse_failed", "conflict"]) assert.equal(filterCurrentEvidence([{ id: status, evidenceStatus: status }]).currentEvidence.length, 0);
});
test("S3 and S4 evidence cannot support official confirmation", () => {
  assert.equal(canEvidenceSupportOfficial({ evidenceStatus: "current", sourceTier: "S3_EXPERT" }, "fresh"), false);
  assert.equal(canEvidenceSupportOfficial({ evidenceStatus: "current", sourceTier: "S4_MODEL" }, "fresh"), false);
});
test("unknown freshness cannot support official confirmation", () => {
  assert.equal(canEvidenceSupportOfficial({ evidenceStatus: "current", sourceTier: "S0_OFFICIAL_DB_MIRROR" }, "unknown"), false);
});
