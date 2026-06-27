import assert from "node:assert/strict";
import test from "node:test";
import { checkStaleness } from "../backend/stalenessGuard.mjs";

test("old ignition-priority evidence is high stale risk", () => {
  const result = checkStaleness({
    issueFrames: ["activation_legality", "ignition_effect"],
    evidence: [{ id: "old-priority", metadata: { id: "old-priority", sourceType: "rulebook", format: "ocg", ruleEra: "pre_2011_ignition_priority", staleRisk: "none" } }],
  });
  assert.equal(result.staleRisk, "high");
  assert.ok(result.staleEvidenceIds.includes("old-priority"));
  assert.ok(result.matchedRuleChanges.some((item) => item.id === "ignition_priority_removed_ocg_2011"));
});

test("MR4 extra-deck zone evidence cannot stand as the current rule", () => {
  const result = checkStaleness({
    issueFrames: ["extra_deck_summon_zone", "fusion_summon"],
    evidence: [{ id: "mr4-zone", metadata: { id: "mr4-zone", sourceType: "rulebook", format: "ocg", ruleEra: "mr4_link_initial", staleRisk: "none" } }],
  });
  assert.equal(result.staleRisk, "high");
  assert.ok(result.staleEvidenceIds.includes("mr4-zone"));
  assert.match(result.userFacingWarning, /现行处理/u);
});

test("trigger location change and trap monster occupancy trigger rule-change checks", () => {
  const trigger = checkStaleness({ issueFrames: ["trigger_effect", "location_change_before_activation"], evidence: [] });
  const trap = checkStaleness({ issueFrames: ["trap_monster", "zone_occupancy"], evidence: [] });
  assert.ok(trigger.matchedRuleChanges.some((item) => item.id === "trigger_effect_location_change_update"));
  assert.ok(trap.matchedRuleChanges.some((item) => item.id === "trap_monster_zone_update"));
  assert.equal(trigger.staleRisk, "possible");
  assert.equal(trap.staleRisk, "possible");
});

test("current checked source mitigates older candidates", () => {
  const result = checkStaleness({
    issueFrames: ["extra_deck_summon_zone", "fusion_summon"],
    evidence: [
      { id: "old", metadata: { id: "old", sourceType: "rulebook", format: "ocg", ruleEra: "mr4_link_initial", staleRisk: "none" } },
      { id: "current", metadata: { id: "current", sourceType: "rules_update", format: "ocg", ruleEra: "current", lastCheckedAt: "2026-06-27", staleRisk: "none" } },
    ],
  });
  assert.ok(result.currentEvidenceIds.includes("current"));
  assert.match(result.userFacingWarning, /已按当前规则判断/u);
  assert.notEqual(result.staleRisk, "high");
});
