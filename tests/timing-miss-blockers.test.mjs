import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";
import { buildTimingMissBlockerAnswer, evaluateTimingMissBlocker } from "../backend/timingMissBlockers.mjs";
import { buildTriggerTimingAnalysis } from "../backend/triggerTimingRules.mjs";

const sequence = [
  { id: "event_1", type: "sent_to_graveyard", order: 1 },
  { id: "event_2", type: "damage_inflicted", order: 2 },
];

test("raw timing wording and inferred event order stay non-authoritative", () => {
  const analysis = buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡送去墓地时，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sequence });
  const result = evaluateTimingMissBlocker(analysis);
  assert.equal(result.hasBlocker, true);
  assert.equal(buildTimingMissBlockerAnswer(result).verdict, "insufficient_info");
});

test("caller self-reported structured timing facts cannot reject an optional-when trigger", () => {
  const analysis = { ...buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡送去墓地时，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sequence }), structuredProof: true };
  assert.equal(buildTimingMissBlockerAnswer(evaluateTimingMissBlocker(analysis)).verdict, "insufficient_info");
});

test("Fast Judge does not sign an inferred timing verdict", async () => {
  let modelCalled = false;
  const answer = await answerRulingQuestionFast({
    question: "测试诱发龙的效果处理时先将测试诱发龙送去墓地，然后给与对方500伤害。送墓不是最后发生的事件，这个效果能发动吗？",
    snapshot: {
      cards: [{ id: "timing-1", name: "测试诱发龙", aliases: ["测试诱发龙"], cardType: "monster", effectText: "当这张卡送去墓地时，可以发动。" }],
      records: [],
      snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
    },
    modelInvoker: async () => {
      modelCalled = true;
      return { answerType: "direct_official", verdict: "can_activate", confirmationLevel: "confirmed" };
    },
  });
  assert.equal(modelCalled, false);
  assert.equal(answer.verdict, "insufficient_info");
  assert.notEqual(answer.confirmationLevel, "rule_derived");
  assert.notEqual(answer.confirmationLevel, "official_confirmed");
  assert.equal(answer.triggerTimingAnalysis.reasonCode, "optional_when_trigger_missed_timing");
});

test("no_internal_reason_leak_for_new_modules", async () => {
  const analysis = { ...buildTriggerTimingAnalysis({ triggerCandidate: { effectText: "当这张卡送去墓地时，可以发动。", triggerEventType: "sent_to_graveyard" }, eventSequence: sequence }), structuredProof: true };
  const answer = buildTimingMissBlockerAnswer(evaluateTimingMissBlocker(analysis));
  const visible = [answer.shortAnswer, ...answer.judgeReasoning.map((item) => item.text), ...answer.requiredFacts].join("\n");
  assert.doesNotMatch(visible, /optional_when_trigger_missed_timing|insufficient_event_sequence|unknown_trigger_wording/u);
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /damage\.reasonCode|timing\.reasonCode/u);
});
