import assert from "node:assert/strict";
import test from "node:test";
import { hashOcgRuleRecords, validateOcgRuleSnapshot } from "../scripts/sync-ocg-rule.mjs";

function records(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `ocg-rule:test-${index}`,
    recordType: "rule-doc",
    title: `Rule ${index}`,
    docname: `test-${index}`,
    sourceUrl: `https://example.test/${index}`,
    keywords: ["规则"],
    text: `Rule text ${index}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

test("OCG Rule snapshot guard rejects abnormal shrink before write", () => {
  assert.throws(() => validateOcgRuleSnapshot({
    targets: records(39),
    records: records(10),
    failures: Array.from({ length: 29 }, () => ({ error: "fetch_failed" })),
    previousRecords: records(39),
  }), /snapshot_shrank_abnormally|success_ratio_below_minimum/u);
});

test("OCG Rule snapshot guard accepts a healthy partial refresh", () => {
  const result = validateOcgRuleSnapshot({
    targets: records(39),
    records: records(38),
    failures: [{ error: "one_page_failed" }],
    previousRecords: records(39),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.recordCount, 38);
  assert.ok(result.successRatio > 0.9);
});

test("OCG Rule snapshot guard rejects duplicate ids", () => {
  const current = records(12);
  current[11] = { ...current[11], id: current[0].id };
  assert.throws(() => validateOcgRuleSnapshot({ targets: records(12), records: current }), /duplicate_or_missing_record_ids/u);
});

test("OCG Rule content hash ignores order and timestamps but changes with text", () => {
  const source = records(12);
  const reordered = [...source].reverse().map((item) => ({ ...item, updatedAt: "2027-01-01T00:00:00.000Z" }));
  assert.equal(hashOcgRuleRecords(source), hashOcgRuleRecords(reordered));
  assert.notEqual(hashOcgRuleRecords(source), hashOcgRuleRecords(source.map((item, index) => index ? item : { ...item, text: "changed" })));
});
