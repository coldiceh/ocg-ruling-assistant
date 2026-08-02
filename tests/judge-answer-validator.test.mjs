import assert from "node:assert/strict";
import test from "node:test";
import { validateJudgeAnswer } from "../backend/judgeAnswerValidator.mjs";

const contextPack = {
  mode: "duel",
  resolvedCards: [{ cardId: "1", name: "霸王眷龙 凶饿猛毒" }],
  unresolvedCards: [],
  relevantCardSections: [{ cardId: "1", cardName: "霸王眷龙 凶饿猛毒", text: "获得对象的卡名和效果，并给予贯穿伤害。" }],
  officialQaCandidates: [], faqCandidates: [], ruleSnippets: [], knownAnalogies: [],
  cardEntityUniverse: ["霸王眷龙 凶饿猛毒", "天霆号 阿宙斯"],
};
const frames = { primaryIssueFrames: [{ id: "copy_or_gain_effect" }, { id: "piercing_battle_damage" }], secondaryIssueFrames: [] };

test("validator rejects a card entity outside the parsed and evidence entity sets", () => {
  const result = validateJudgeAnswer({
    question: "霸王眷龙 凶饿猛毒获得效果后是否给予贯穿伤害？",
    issueFrames: frames,
    contextPack,
    modelAnswer: {
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "霸王眷龙 凶饿猛毒会造成贯穿伤害，之后由天霆号 阿宙斯处理。",
      judgeReasoning: [{ text: "获得效果后处理贯穿伤害。", basis: ["card_text"], refs: ["1"] }],
      cardEntities: ["霸王眷龙 凶饿猛毒", "天霆号 阿宙斯"],
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.unsupportedCardEntities, ["天霆号 阿宙斯"]);
  assert.equal(result.rejectedReason, "unsupported_card_entity");
  assert.equal(result.fixedAnswer.answerType, "needs_clarification");
});

test("validator does not infer card contamination from a fixed topic word list", () => {
  const result = validateJudgeAnswer({
    question: "霸王眷龙 凶饿猛毒获得效果后是否给予贯穿伤害？",
    issueFrames: frames,
    contextPack: { ...contextPack, cardEntityUniverse: [] },
    modelAnswer: {
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "霸王眷龙 凶饿猛毒获得效果后处理贯穿伤害；素材叠放与本结论无关。",
      judgeReasoning: [{ text: "当前结论只依据获得效果与贯穿处理。", basis: ["card_text"], refs: ["1"] }],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics.offTopicTerms, []);
  assert.equal(result.diagnostics.entityGroundingStatus, "unavailable");
});

test("validator accepts a card entity that is grounded by structured evidence metadata", () => {
  const result = validateJudgeAnswer({
    question: "霸王眷龙 凶饿猛毒获得效果后是否给予贯穿伤害？",
    issueFrames: frames,
    contextPack: {
      ...contextPack,
      officialQaCandidates: [{ id: "qa-entity", cards: ["天霆号 阿宙斯"], text: "关联裁定证据。" }],
    },
    modelAnswer: {
      answerType: "rule_judgment",
      verdict: "damage_occurs",
      shortAnswer: "霸王眷龙 凶饿猛毒获得效果后处理贯穿伤害；证据同时记载天霆号 阿宙斯。",
      judgeReasoning: [{ text: "获得效果后处理贯穿伤害。", basis: ["official_qa"], refs: ["qa-entity"] }],
      cardEntities: ["霸王眷龙 凶饿猛毒", "天霆号 阿宙斯"],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics.unsupportedCardEntities, []);
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
