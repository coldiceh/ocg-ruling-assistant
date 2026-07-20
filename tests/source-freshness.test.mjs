import assert from "node:assert/strict";
import test from "node:test";
import { checkSourceFreshness } from "../scripts/check-source-freshness.mjs";
import { hashOcgRuleRecords } from "../scripts/sync-ocg-rule.mjs";

function fixture() {
  const records = [{ id: "ocg-rule:test", recordType: "rule-doc", title: "Rule", docname: "test", sourceUrl: "https://example.test", keywords: [], text: "Rule text" }];
  const contentHash = hashOcgRuleRecords(records);
  return {
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: "2026-07-20T10:00:00.000Z" },
    ocgCorpus: { generatedAt: "2026-07-20T10:30:00.000Z", sync: { status: "complete", recordCount: 1, contentHash }, records },
    evidenceIndex: { generatedAt: "2026-07-20T11:00:00.000Z", records: [{ evidenceId: "one" }] },
  };
}

test("source freshness accepts fresh sources and a newer evidence index", () => {
  assert.equal(checkSourceFreshness(fixture()).ok, true);
});

test("source freshness rejects stale sources", () => {
  const value = fixture();
  value.snapshotMeta.lastSuccessfulSyncAt = "2026-07-17T00:00:00.000Z";
  const result = checkSourceFreshness(value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.startsWith("ygoresources_stale")));
});

test("source freshness rejects OCG count or hash mismatches", () => {
  const value = fixture();
  value.ocgCorpus.sync.recordCount = 2;
  value.ocgCorpus.sync.contentHash = "wrong";
  const result = checkSourceFreshness(value);
  assert.ok(result.errors.includes("ocg_rule_record_count_mismatch"));
  assert.ok(result.errors.includes("ocg_rule_content_hash_mismatch"));
});

test("source freshness rejects an evidence index built before either source", () => {
  const value = fixture();
  value.evidenceIndex.generatedAt = "2026-07-20T09:00:00.000Z";
  assert.ok(checkSourceFreshness(value).errors.includes("evidence_index_older_than_source"));
});
