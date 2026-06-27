import assert from "node:assert/strict";
import test from "node:test";
import { RULE_CHANGE_INDEX, findRuleChangesForIssueFrames } from "../backend/ruleChangeIndex.mjs";
import { compareRuleEra, normalizeRulingSourceMetadata, sourcePredatesRuleChange } from "../backend/rulingVersioning.mjs";

test("ruling source metadata is normalized to the shared schema", () => {
  const metadata = normalizeRulingSourceMetadata({
    id: "faq-1",
    recordType: "card-faq",
    text: "日本語のFAQです。",
    lastCheckedAt: "2026-06-27T00:00:00Z",
  });
  assert.equal(metadata.sourceType, "card_faq");
  assert.equal(metadata.locale, "ocg-ja");
  assert.equal(metadata.format, "ocg");
  assert.equal(metadata.ruleEra, "current");
  assert.equal(metadata.staleRisk, "none");
});

test("pre-2011 ignition priority evidence predates the current OCG change", () => {
  const change = RULE_CHANGE_INDEX.find((item) => item.id === "ignition_priority_removed_ocg_2011");
  const metadata = normalizeRulingSourceMetadata({ id: "old-priority", sourceType: "rulebook", ruleEra: "pre_2011_ignition_priority", format: "ocg", staleRisk: "none" });
  assert.equal(sourcePredatesRuleChange(metadata, change), true);
  assert.ok(compareRuleEra(metadata.ruleEra, change.ruleEra) < 0);
});

test("partial rule-change dates preserve declared precision", () => {
  const triggerChange = RULE_CHANGE_INDEX.find((item) => item.id === "trigger_effect_location_change_update");
  assert.equal(triggerChange.effectiveFrom, "2021");
  assert.equal(triggerChange.precision, "year");
  assert.ok(findRuleChangesForIssueFrames(["trigger_effect"]).some((item) => item.id === triggerChange.id));
});
