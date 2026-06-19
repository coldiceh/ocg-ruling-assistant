import assert from "node:assert/strict";
import test from "node:test";
import { buildEventTimelineFromFormalQuery } from "../backend/eventTimeline.mjs";
import { buildGameStateFromFormalQuery } from "../backend/gameState.mjs";
import { buildSubQuestionDependencyGraph } from "../backend/subQuestionDependencies.mjs";
import { applyTransitionRules } from "../backend/transitionRules.mjs";

test("A. a pending graveyard transition does not confirm already sent", () => {
  const formalQuery = makeQuery([q("q4", "location_change", "青眼暴君龙", "这个时候青眼暴君龙是否已经送墓？")]);
  const result = run(formalQuery, [answer("q4", "unknown", "unknown")]);
  const state = result.derivedStates.find((item) => item.questionId === "q4");
  assert.equal(state.zoneStatus, "pending_send_to_graveyard");
  assert.notEqual(state.status, "confirmed");
});

test("B. an unknown banish verdict leaves the send question unresolved", () => {
  const formalQuery = dependencyQuery();
  const result = run(formalQuery, [answer("q1", "unknown", "unknown"), answer("q2", "unknown", "unknown")]);
  assert.ok(result.unresolvedDependencies.some((item) => item.questionId === "q2" && item.dependsOnQuestionId === "q1"));
});

test("C. a confirmed temporary banish path cannot confirm the later send outcome without a transition rule", () => {
  const formalQuery = dependencyQuery();
  const q1 = answer("q1", "confirmed", "can", ["ygoresources-qa-temp"]);
  q1.transitionFacts = ["temporary_banish_until_after_resolution"];
  const result = run(formalQuery, [q1, answer("q2", "unknown", "unknown")]);
  const state = result.derivedStates.find((item) => item.questionId === "q2");
  assert.notEqual(state.status, "confirmed");
  assert.ok(state.warnings.includes("pending_send_after_temporary_banish_unresolved"));
});

test("D. a confirmed cannot-banish verdict preserves the pending transition", () => {
  const formalQuery = dependencyQuery();
  const result = run(formalQuery, [
    answer("q1", "confirmed", "cannot", ["ygoresources-qa-no"]),
    answer("q2", "unknown", "unknown"),
  ]);
  const state = result.derivedStates.find((item) => item.questionId === "q2");
  assert.equal(state.zoneStatus, "pending_send_to_graveyard");
  assert.equal(state.transitionStatus, "pending");
  assert.notEqual(state.status, "confirmed");
});

test("E. a heuristic transition rule cannot output confirmed", () => {
  const formalQuery = dependencyQuery();
  const result = run(formalQuery, [], [{
    ruleId: "heuristic-fixture",
    description: "heuristic fixture",
    sourceType: "heuristic",
    sourceIds: ["heuristic-1"],
    maxStatus: "confirmed",
    requestedStatus: "confirmed",
    appliesToQuestionId: "q2",
    outputState: { zoneStatus: "in_graveyard", transitionStatus: "completed" },
  }]);
  assert.equal(result.derivedStates.find((item) => item.questionId === "q2").status, "inferred");
});

test("F. an official Q&A rule with evidence may output confirmed", () => {
  const formalQuery = dependencyQuery();
  const result = run(formalQuery, [], [{
    ruleId: "official-fixture",
    description: "official fixture",
    sourceType: "official_qa",
    sourceIds: ["qa-official-1"],
    maxStatus: "confirmed",
    requestedStatus: "confirmed",
    appliesToQuestionId: "q2",
    outputState: { zoneStatus: "in_graveyard", transitionStatus: "completed" },
  }]);
  const state = result.derivedStates.find((item) => item.questionId === "q2");
  assert.equal(state.status, "confirmed");
  assert.deepEqual(state.evidenceIds, ["qa-official-1"]);
});

function run(formalQuery, subQuestionAnswers, transitionRuleSources = []) {
  const gameState = buildGameStateFromFormalQuery(formalQuery);
  const eventTimeline = buildEventTimelineFromFormalQuery(formalQuery, gameState);
  const dependencyGraph = buildSubQuestionDependencyGraph(formalQuery, eventTimeline);
  return applyTransitionRules({ formalQuery, gameState, eventTimeline, dependencyGraph, subQuestionAnswers, transitionRuleSources });
}

function dependencyQuery() {
  return makeQuery([
    q("q1", "temporary_banish", "完美世界-卡通世界", "能用完美世界-卡通世界的效果除外该卡通怪兽吗？"),
    q("q2", "send_to_gy", "referenced_toon_monster", "该卡通怪兽还会不会送墓？"),
  ]);
}

function makeQuery(subQuestions) {
  return {
    originalText: subQuestions.map((item) => item.sourceText).join("\n"),
    cards: [{ name: "青眼暴君龙" }, { name: "完美世界-卡通世界" }],
    scenario: { rawContext: "青眼暴君龙和卡通怪兽被战破的时候", events: [] },
    subQuestions,
  };
}

function q(id, type, card, sourceText) {
  return { id, type, card, askedResult: "unknown", sourceText };
}

function answer(questionId, status, verdict, evidenceIds = []) {
  return { questionId, status, verdict, evidenceIds };
}
