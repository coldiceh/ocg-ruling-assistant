import assert from "node:assert/strict";
import test from "node:test";

import {
  callCardNameExtractionModel,
  resolveCardExtractionProvider,
} from "../backend/ragModelClient.mjs";

const DEEPSEEK_ENV = Object.freeze({
  RAG_CARD_MODEL_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "synthetic-deepseek-key",
  DEEPSEEK_CARD_MODEL: "deepseek-card-extractor-test",
  API_DAILY_BUDGET_CNY: "10",
  API_BUDGET_TIMEZONE: "UTC",
});

test("explicit DeepSeek card-name extraction sends one non-thinking JSON request", async () => {
  const calls = [];
  const result = await callCardNameExtractionModel({
    userQuery: "测试龙的效果可以发动吗？",
    dataRevision: "deepseek-card-extraction-success-v1",
    env: DEEPSEEK_ENV,
    now: new Date("2051-02-01T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({
        id: "deepseek-card-response-1",
        model: "deepseek-card-extractor-test",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              cardNames: [{ name: "测试龙", originalText: "测试龙", confidence: "high" }],
            }),
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].body.model, "deepseek-card-extractor-test");
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].body.max_tokens, 800);
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(result.providerUsed, "deepseek");
  assert.equal(result.modelUsed, "deepseek-card-extractor-test");
  assert.deepEqual(result.candidates, [
    {
      name: "测试龙",
      originalText: "测试龙",
      confidence: "high",
      source: "model_card_name_extractor",
    },
  ]);
});

test("explicit DeepSeek card-name extraction does not retry a rejected JSON response format", async () => {
  const calls = [];
  const result = await callCardNameExtractionModel({
    userQuery: "测试龙",
    dataRevision: "deepseek-card-extraction-400-v1",
    env: DEEPSEEK_ENV,
    now: new Date("2051-02-02T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ error: { message: "response_format rejected" } }, 400);
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(result.providerUsed, "deepseek");
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((warning) => warning.startsWith("card_name_model_failed:")));
  assert.equal(result.warnings.includes("deepseek_response_format_fallback"), false);
});

test("explicit DeepSeek card-name extraction fails closed when its key is missing", () => {
  const resolution = resolveCardExtractionProvider({
    RAG_CARD_MODEL_PROVIDER: "deepseek",
  });

  assert.equal(resolution.provider, "mock");
  assert.ok(resolution.warnings.includes("deepseek_api_key_missing_card_name_model_disabled"));
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
