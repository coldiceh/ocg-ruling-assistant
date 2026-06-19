import assert from "node:assert/strict";
import test from "node:test";
import { selectBranchForSubQuestion } from "../backend/branchSelector.mjs";
import { extractConditionBranchesFromEvidence } from "../backend/conditionBranches.mjs";
import { buildGameStateFromFormalQuery } from "../backend/gameState.mjs";
import { answerEachSubQuestion } from "../backend/engine.mjs";

const faq = {
  id: "card-faq-16842-3",
  conclusion: "このカードが戦闘で破壊されなかった場合にはモンスターゾーンで、戦闘で破壊され墓地へ送られた場合には墓地で、戦闘で破壊され表側で除外された場合には除外状態で発動できます。",
};
const subQuestion = {
  id: "q3",
  type: "activation_location",
  card: "青眼暴君龙",
  askedResult: "effect_activates_in_graveyard_or_field",
  sourceText: "青眼暴君龙被战破时是在墓地发动还是在场上发动？",
};
const extracted = extractConditionBranchesFromEvidence(faq);

test("A. extracts three conditional activation-location branches", () => {
  assert.equal(extracted.branches.length, 3);
  assert.deepEqual(extracted.branches.map((branch) => branch.verdict), [
    "activates_on_field",
    "activates_in_graveyard",
    "activates_while_banished",
  ]);
});

test("B. not destroyed and remaining in the monster zone selects field activation", () => {
  const selected = selectBranchForSubQuestion(subQuestion, extracted, state({
    wasDestroyedByBattle: false,
    wasSentToGraveyard: false,
    wasBanished: false,
    remainsOnField: true,
    currentZone: "monster_zone",
  }));
  assert.equal(selected.status, "selected");
  assert.equal(selected.verdict, "activates_on_field");
});

test("C. destroyed by battle and sent to the graveyard selects graveyard activation", () => {
  const selected = selectBranchForSubQuestion(subQuestion, extracted, state({
    wasDestroyedByBattle: true,
    wasSentToGraveyard: true,
    wasBanished: false,
    remainsOnField: false,
    currentZone: "graveyard",
  }));
  assert.equal(selected.status, "selected");
  assert.equal(selected.verdict, "activates_in_graveyard");
});

test("D. destroyed by battle and banished selects banished activation", () => {
  const selected = selectBranchForSubQuestion(subQuestion, extracted, state({
    wasDestroyedByBattle: true,
    wasSentToGraveyard: false,
    wasBanished: true,
    remainsOnField: false,
    currentZone: "banished",
  }));
  assert.equal(selected.status, "selected");
  assert.equal(selected.verdict, "activates_while_banished");
});

test("E. battle destruction without destination reports missing state", () => {
  const selected = selectBranchForSubQuestion(subQuestion, extracted, state({
    wasDestroyedByBattle: true,
    wasSentToGraveyard: null,
    wasBanished: null,
    remainsOnField: null,
    currentZone: "unknown",
  }));
  assert.ok(["missing_state", "ambiguous"].includes(selected.status));
  assert.equal(selected.verdict, "unknown");
  assert.ok(selected.missingConditions.includes("sent_to_graveyard"));
  assert.ok(selected.missingConditions.includes("banished"));
});

test("F. scenario battle destruction contradicts battle-indestructible card text", () => {
  const formalQuery = {
    originalText: subQuestion.sourceText,
    cards: [{ name: "青眼暴君龙", role: "question_card" }],
    resolvedCards: [{ name: "青眼暴君龙", effectText: "这张卡不会被战斗破坏。" }],
    scenario: { rawContext: "青眼暴君龙被战破。", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [subQuestion],
  };
  const gameState = buildGameStateFromFormalQuery(formalQuery);
  const selected = selectBranchForSubQuestion(subQuestion, extracted, gameState);
  assert.ok(gameState.contradictions.length > 0);
  assert.equal(selected.status, "contradiction");
  assert.equal(selected.verdict, "unknown");

  const qa = {
    ...faq,
    recordType: "card-faq",
    title: "青眼暴君龙 FAQ 3",
    question: "青眼暴君龙的效果在哪里发动？",
    cards: ["青眼暴君龙"],
    keywords: ["墓地发动", "场上发动", "除外状态发动"],
  };
  const evidence = {
    bySubQuestion: [{
      subQuestionId: "q3",
      rulingEvidence: [{ ...qa, evidenceId: qa.id }],
      similarRulingEvidence: [],
      cardTextEvidence: [],
      rejectedEvidence: [],
    }],
  };
  const [answer] = answerEachSubQuestion(formalQuery, evidence, { records: [qa] }, undefined, { gameState });
  assert.notEqual(answer.status, "confirmed");
  assert.equal(answer.verdict, "unknown");
  assert.ok(answer.warnings.includes("condition_branch_contradiction"));
});

test("game state recognizes damage-step-end timing", () => {
  const gameState = buildGameStateFromFormalQuery({
    originalText: "",
    cards: [{ name: "青眼暴君龙" }],
    scenario: { rawContext: "伤害步骤结束阶段，青眼暴君龙被战破。", events: [] },
    subQuestions: [],
  });
  assert.equal(gameState.timing.step, "timing_damage_step_end");
  assert.equal(gameState.timing.isEndOfDamageStep, true);
});

function state(entity) {
  return {
    entities: [{ name: "青眼暴君龙", cardId: "16842", statusKnown: true, ...entity }],
    timing: {},
    assumptions: [],
    contradictions: [],
    unknowns: [],
  };
}
