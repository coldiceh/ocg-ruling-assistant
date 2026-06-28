import assert from "node:assert/strict";
import test from "node:test";
import { filterCurrentEvidence } from "../backend/currentEvidenceFilter.mjs";
import { diffRulingSnapshot, normalizeEvidenceRecord } from "../backend/rulingDiffState.mjs";

test("latest database text wins while the old version remains historical", () => {
  const previous = normalizeEvidenceRecord({ id: "faq-1", recordType: "card-faq", text: "不能发动", status: "current" }, { now: "2026-06-20" });
  const diff = diffRulingSnapshot({ previousEvidence: [previous], currentEvidence: [{ id: "faq-1", recordType: "card-faq", text: "可以发动" }], now: "2026-06-28" });
  const filtered = filterCurrentEvidence([{ id: "faq-1", recordType: "card-faq", text: "可以发动" }], { evidenceIndex: diff.records, sourceFreshness: "fresh" });
  assert.equal(filtered.currentEvidence.length, 1);
  assert.match(filtered.currentEvidence[0].text, /可以发动/u);
  assert.equal(diff.records.some((item) => item.status === "superseded"), true);
});
test("removed history cannot enter direct candidates", () => {
  assert.equal(filterCurrentEvidence([{ id: "qa-old", recordType: "qa", text: "可以", evidenceStatus: "removed" }]).directEligibleEvidence.length, 0);
});
