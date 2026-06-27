import assert from "node:assert/strict";
import test from "node:test";
import { validateJudgeAnswer } from "../backend/judgeAnswerValidator.mjs";

const contextPack = {
  mode: "duel",
  resolvedCards: [{ cardId: "1", name: "霸王眷龙 凶饿猛毒" }],
  unresolvedCards: [],
  relevantCardSections: [{ cardId: "1", cardName: "霸王眷龙 凶饿猛毒", text: "获得对象的卡名和效果，并给予贯穿伤害。" }],
  officialQaCandidates: [], faqCandidates: [], ruleSnippets: [], knownAnalogies: [],
};
const frames = { primaryIssueFrames: [{ id: "copy_or_gain_effect" }, { id: "piercing_battle_damage" }], secondaryIssueFrames: [] };

test("validator rejects unrelated material-stacking contamination", () => {
  const result = validateJudgeAnswer({
    question: "霸王眷龙 凶饿猛毒获得效果后是否给予贯穿伤害？",
    issueFrames: frames,
    contextPack,
    modelAnswer: {
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "霸王眷龙 凶饿猛毒会造成贯穿伤害，并进行素材叠放。",
      judgeReasoning: [{ text: "获得效果后处理贯穿伤害和超量素材。", basis: ["card_text"], refs: ["1"] }],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.offTopicTerms.includes("素材叠放"));
  assert.equal(result.fixedAnswer.answerType, "needs_clarification");
});

test("validator accepts a focused sourced judgment", () => {
  const result = validateJudgeAnswer({
    question: "霸王眷龙 凶饿猛毒获得效果后是否给予贯穿伤害？",
    issueFrames: frames,
    contextPack,
    modelAnswer: {
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "霸王眷龙 凶饿猛毒获得该效果后，按卡片文本处理贯穿战斗伤害。",
      judgeReasoning: [{ text: "获得效果与贯穿处理都记载在当前卡片文本中。", basis: ["card_text"], refs: ["1"] }],
    },
  });
  assert.equal(result.ok, true);
});
