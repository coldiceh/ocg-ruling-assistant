import assert from "node:assert/strict";
import test from "node:test";
import { answerEachSubQuestion, retrieveEvidenceByFormalQuery } from "../backend/engine.mjs";
import {
  preprocessFormalQuestion,
  validateFormalRulingQuery,
} from "../backend/formalQuery.mjs";
import { parseFormalRulingQuery, parseFormalRulingQueryDetailed } from "../backend/openai.mjs";

const goldenQuestion = `被青眼暴君龙战破的卡通怪兽在伤判结束阶段发动盖放墓地陷阱卡效果的时候：
能用 完美世界-卡通世界 的效果除外该卡通怪兽吗？
卡通怪兽还会被战破送墓吗？
如果 青眼暴君龙 被战破的时候，这个效果是在墓地发动还是在场上发动？
这个时候 青眼暴君龙 是否已经送墓了吗？`;

const cardCandidates = [
  {
    name: "青眼暴君龙",
    aliases: ["青眼暴君龍", "Blue-Eyes Tyrant Dragon"],
  },
  {
    name: "完美世界 卡通世界",
    aliases: ["完美世界-卡通世界", "完美世界 卡通世界", "Perfect Toon World"],
  },
];

test("golden case keeps context separate and produces four complete subQuestions", async () => {
  const preprocessing = preprocessFormalQuestion(goldenQuestion);
  assert.deepEqual(preprocessing.contextLines, ["被青眼暴君龙战破的卡通怪兽在伤判结束阶段发动盖放墓地陷阱卡效果的时候："]);
  assert.equal(preprocessing.questionLines.length, 4);
  assert.ok(preprocessing.questionLines.every((line) => !line.startsWith("被青眼暴君龙战破")));

  const query = await parseFormalRulingQuery(goldenQuestion, cardCandidates, {});
  assert.equal(query.scenario.rawContext, preprocessing.contextLines[0]);
  assert.equal(query.subQuestions.length, 4);
  assert.deepEqual(query.subQuestions.map((item) => item.id), ["q1", "q2", "q3", "q4"]);

  for (const subQuestion of query.subQuestions) {
    for (const field of ["id", "type", "card", "askedResult", "sourceText"]) {
      assert.equal(typeof subQuestion[field], "string", `${subQuestion.id}.${field} must be a string`);
      assert.ok(subQuestion[field].length > 0, `${subQuestion.id}.${field} must not be empty`);
    }
  }

  assert.ok(["temporary_banish", "resolution_handling"].includes(query.subQuestions[0].type));
  assert.equal(query.subQuestions[0].card, "完美世界 卡通世界");
  assert.equal(query.subQuestions[0].askedResult, "can_banish_that_toon_monster");

  assert.ok(["send_to_gy", "location_change"].includes(query.subQuestions[1].type));
  assert.equal(query.subQuestions[1].card, "referenced_toon_monster");
  assert.equal(query.subQuestions[1].askedResult, "will_still_be_sent_to_graveyard_by_battle");

  assert.ok(["activation_location", "timing"].includes(query.subQuestions[2].type));
  assert.equal(query.subQuestions[2].card, "青眼暴君龙");
  assert.equal(query.subQuestions[2].askedResult, "effect_activates_in_graveyard_or_field");

  assert.equal(query.subQuestions[3].type, "location_change");
  assert.equal(query.subQuestions[3].card, "青眼暴君龙");
  assert.equal(query.subQuestions[3].askedResult, "is_already_sent_to_graveyard_at_that_timing");
  assert.deepEqual(validateFormalRulingQuery(query), { valid: true, errors: [] });

  const evidence = retrieveEvidenceByFormalQuery(query, cardCandidates, { records: [] });
  const answers = answerEachSubQuestion(query, evidence, { records: [] }, validateFormalRulingQuery(query));
  assert.ok(answers.every((answer) => answer.status !== "parse_failed"));
});

test("normalization uses unknown defaults instead of omitting required subQuestion fields", async () => {
  const query = await parseFormalRulingQuery("这张卡是否会发生变化？", [], {});
  assert.equal(query.subQuestions.length, 1);
  assert.equal(query.subQuestions[0].type, "unknown");
  assert.equal(query.subQuestions[0].card, "unknown");
  assert.notEqual(query.subQuestions[0].askedResult, "");
  assert.equal(query.subQuestions[0].sourceText, "这张卡是否会发生变化？");
  assert.equal(validateFormalRulingQuery(query).valid, true);
});

test("truncated Gemini output returns model_output_truncated instead of entering evidence", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }],
      }),
    };
  };

  try {
    const result = await parseFormalRulingQueryDetailed(goldenQuestion, cardCandidates, {
      MODEL_PROVIDER: "gemini",
      GEMINI_API_KEY: "fixture-key",
      GEMINI_PARSER_MODEL: "fixture-model",
    });
    assert.equal(result.parseFailed, "model_output_truncated");
    assert.ok(result.parserWarnings.includes("model_output_truncated"));
    assert.equal(result.preprocessing.questionLines.length, 4);
    assert.ok(requestBody.generationConfig.maxOutputTokens >= 4096);
    assert.deepEqual(
      JSON.parse(requestBody.contents[0].parts[0].text).questionLines.map((item) => item.id),
      ["q1", "q2", "q3", "q4"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model omissions are filled by deterministic fallback and reported as warnings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{
            text: JSON.stringify({
              originalText: goldenQuestion,
              scenario: { rawContext: "" },
              cards: [],
              reasoning: "must be discarded",
              evidence: [{ id: "must-not-survive" }],
              subQuestions: [{ id: "q1", sourceText: "能用 完美世界-卡通世界 的效果除外该卡通怪兽吗？" }],
            }),
          }],
        },
      }],
    }),
  });

  try {
    const result = await parseFormalRulingQueryDetailed(goldenQuestion, cardCandidates, {
      MODEL_PROVIDER: "gemini",
      GEMINI_API_KEY: "fixture-key",
      GEMINI_PARSER_MODEL: "fixture-model",
    });
    assert.equal(result.parseFailed, null);
    assert.equal(result.query.subQuestions.length, 4);
    assert.equal(result.query.subQuestions[0].type, "temporary_banish");
    assert.equal(result.query.subQuestions[0].card, "完美世界 卡通世界");
    assert.ok(result.parserWarnings.includes("model_subquestion_count_ignored"));
    assert.ok(result.parserWarnings.includes("defaulted_type:q1"));
    assert.ok(result.query.subQuestions.every((item) => item.id && item.type && item.card && item.askedResult && item.sourceText));
    assert.equal("reasoning" in result.rawFormalQuery, false);
    assert.equal("evidence" in result.rawFormalQuery, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("context-only input is the empty-query parse_failed case", async () => {
  const result = await parseFormalRulingQueryDetailed("青眼暴君龙目前在自己墓地。", cardCandidates, {});
  assert.equal(result.parseFailed, "empty_formal_query");
  assert.deepEqual(result.query.subQuestions, []);
  assert.deepEqual(result.preprocessing.questionLines, []);
});

test("completely invalid model JSON returns model_output_invalid_json", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"broken":' }] } }],
    }),
  });
  try {
    const result = await parseFormalRulingQueryDetailed("青眼暴君龙能否发动？", cardCandidates, {
      MODEL_PROVIDER: "gemini",
      GEMINI_API_KEY: "fixture-key",
      GEMINI_PARSER_MODEL: "fixture-model",
    });
    assert.equal(result.parseFailed, "model_output_invalid_json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
