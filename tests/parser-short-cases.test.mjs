import assert from "node:assert/strict";
import test from "node:test";
import { parseFormalRulingQuery } from "../backend/openai.mjs";

const cases = [
  {
    question: "能用完美世界-卡通世界的效果除外该卡通怪兽吗？",
    type: "temporary_banish",
    card: "完美世界-卡通世界",
    candidates: [{ name: "完美世界-卡通世界", aliases: ["完美世界 卡通世界", "Perfect Toon World"] }],
  },
  {
    question: "卡通怪兽还会被战破送墓吗？",
    type: "send_to_gy",
    card: "referenced_toon_monster",
    candidates: [],
  },
  {
    question: "青眼暴君龙的效果是在墓地发动还是在场上发动？",
    type: "activation_location",
    card: "青眼暴君龙",
    candidates: [{ name: "青眼暴君龙", aliases: ["青眼暴君龍", "Blue-Eyes Tyrant Dragon"] }],
  },
  {
    question: "这个时候青眼暴君龙是否已经送墓了？",
    type: "location_change",
    card: "青眼暴君龙",
    candidates: [{ name: "青眼暴君龙", aliases: ["青眼暴君龍", "Blue-Eyes Tyrant Dragon"] }],
  },
  {
    question: "阿尔戈☆群星的②效果这个时候能发动吗？",
    type: "activation_condition",
    card: "阿尔戈☆群星",
    candidates: [{ name: "阿尔戈☆群星", aliases: ["阿尔戈群星"] }],
  },
];

for (const shortCase of cases) {
  test(`parser short case: ${shortCase.question}`, async () => {
    const query = await parseFormalRulingQuery(shortCase.question, shortCase.candidates, {});
    assert.equal(query.subQuestions.length, 1);
    assert.equal(query.subQuestions[0].type, shortCase.type);
    assert.equal(query.subQuestions[0].card, shortCase.card);
    assertCompleteSubQuestion(query.subQuestions[0]);
    assert.doesNotMatch(JSON.stringify(query), /parse_failed/u);
  });
}

test("rule-based fallback corrects wrong AI type and missing AI card", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.contents[0].parts[0].text);
    const sourceText = input.questionLines[0].sourceText;
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "STOP",
          content: {
            parts: [{
              text: JSON.stringify({
                originalText: input.originalText,
                scenario: { rawContext: input.scenario.rawContext },
                cards: [],
                subQuestions: [{
                  id: "q1",
                  type: "resolution_handling",
                  card: "unknown",
                  askedResult: "unknown",
                  sourceText,
                }],
              }),
            }],
          },
        }],
      }),
    };
  };

  try {
    for (const shortCase of cases) {
      const query = await parseFormalRulingQuery(shortCase.question, shortCase.candidates, {
        MODEL_PROVIDER: "gemini",
        GEMINI_API_KEY: "fixture-key",
        GEMINI_PARSER_MODEL: "fixture-model",
      });
      assert.equal(query.subQuestions[0].type, shortCase.type);
      assert.equal(query.subQuestions[0].card, shortCase.card);
      assertCompleteSubQuestion(query.subQuestions[0]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function assertCompleteSubQuestion(subQuestion) {
  for (const field of ["id", "type", "card", "askedResult", "sourceText"]) {
    assert.equal(typeof subQuestion[field], "string", `${field} must be a string`);
    assert.ok(subQuestion[field].length > 0, `${field} must not be empty`);
  }
}

