import assert from "node:assert/strict";
import test from "node:test";
import { classifyQaForSubQuestion } from "../backend/engine.mjs";

test("a matching temporary-banish Q&A fixture is accepted as direct evidence", () => {
  const subQuestion = {
    id: "q1",
    type: "temporary_banish",
    card: "完美世界-卡通世界",
    askedResult: "can_banish_that_toon_monster",
    sourceText: "能用完美世界-卡通世界的效果除外该卡通怪兽吗？",
  };
  const qa = {
    id: "qa-perfect-toon-world-temporary-banish",
    recordType: "card-faq",
    title: "完美世界-卡通世界的效果处理",
    question: "能用「完美世界-卡通世界」的效果，在效果处理时除外该卡通怪兽吗？",
    conclusion: "可以。在效果处理时，可以将该卡通怪兽暂时除外。",
    cards: ["完美世界-卡通世界"],
    keywords: ["效果处理时除外", "卡通怪兽", "暂时除外"],
    sources: [{ label: "fixture", detail: "qa-perfect-toon-world-temporary-banish" }],
  };

  const classification = classifyQaForSubQuestion(subQuestion, qa);

  assert.deepEqual(classification, {
    match: "direct",
    reason: "card_type_effect_semantics_and_scene_match",
    matchedQuestionType: "temporary_banish",
    answeredAskedResult: true,
    askedResultCoverage: "explicit",
    extractedVerdict: "can",
  });
});
