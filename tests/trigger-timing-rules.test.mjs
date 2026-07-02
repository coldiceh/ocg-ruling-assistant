import assert from "node:assert/strict";
import test from "node:test";
import { buildTriggerTimingAnalysis, classifyTriggerWording, getLastEvent, isEventLastThing } from "../backend/triggerTimingRules.mjs";

const sentThenDamage = [
  { id: "event_1", type: "sent_to_graveyard", order: 1, timing: "during_resolution" },
  { id: "event_2", type: "damage_inflicted", order: 2, timing: "during_resolution" },
];

test("optional_when_misses_timing_if_not_last_event", () => {
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡送去墓地时，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sentThenDamage });
  assert.equal(analysis.triggerType, "optional_when");
  assert.equal(analysis.isTriggerEventLastThing, false);
  assert.equal(analysis.verdict, "cannot_activate");
  assert.equal(analysis.reasonCode, "optional_when_trigger_missed_timing");
});

test("optional_when_can_activate_if_trigger_event_is_last", () => {
  const sequence = [{ id: "event_1", type: "sent_to_graveyard", order: 1 }];
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡送去墓地时，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sequence });
  assert.equal(analysis.isTriggerEventLastThing, true);
  assert.equal(analysis.verdict, "continue_activation_check");
  assert.equal(analysis.reasonCode, "optional_when_trigger_event_is_last");
});

test("optional_if_not_blocked_by_last_event_rule", () => {
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "如果这张卡送去墓地的场合，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sentThenDamage });
  assert.equal(analysis.triggerType, "optional_if");
  assert.notEqual(analysis.reasonCode, "optional_when_trigger_missed_timing");
  assert.equal(analysis.verdict, "continue_activation_check");
});

test("mandatory_trigger_not_optional_timing_miss", () => {
  const simultaneous = [
    { id: "event_1", type: "destroyed", order: 1, simultaneousGroupId: "g1" },
    { id: "event_2", type: "sent_to_graveyard", order: 1, simultaneousGroupId: "g1" },
  ];
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡被破坏时，发动这个效果。", triggerEventType: "destroyed" }, eventSequence: simultaneous });
  assert.equal(analysis.triggerType, "mandatory_when");
  assert.equal(analysis.reasonCode, "requires_segoc_analysis");
  assert.notEqual(analysis.reasonCode, "optional_when_trigger_missed_timing");
});

test("unknown_trigger_wording_requires_text", () => {
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "处理这张卡。" }, eventSequence: sentThenDamage });
  assert.equal(analysis.triggerType, "unknown");
  assert.equal(analysis.verdict, "insufficient_info");
  assert.ok(analysis.missingInfo.some((item) => /官方效果文本|诱发措辞/u.test(item)));
});

test("event sequence helpers preserve simultaneous last events", () => {
  const sequence = [
    { id: "event_1", type: "destroyed", order: 1 },
    { id: "event_2", type: "sent_to_graveyard", order: 2, simultaneousGroupId: "g2" },
    { id: "event_3", type: "card_left_field", order: 2, simultaneousGroupId: "g2" },
  ];
  assert.equal(getLastEvent(sequence).order, 2);
  assert.equal(isEventLastThing("sent_to_graveyard", sequence), true);
});

test("no_unsafe_confirmed_timing_miss", () => {
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡送去墓地时，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sentThenDamage });
  assert.equal(analysis.confirmationLevel, "rule_derived");
  assert.deepEqual(analysis.evidenceIds, []);
});

test("classify trigger wording distinguishes optional and mandatory forms", () => {
  assert.equal(classifyTriggerWording("当这张卡送去墓地时，可以发动。"), "optional_when");
  assert.equal(classifyTriggerWording("如果这张卡送去墓地的场合，可以发动。"), "optional_if");
  assert.equal(classifyTriggerWording("当这张卡被破坏时，发动这个效果。"), "mandatory_when");
});
