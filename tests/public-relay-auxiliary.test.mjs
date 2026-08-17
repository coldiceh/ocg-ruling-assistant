import assert from "node:assert/strict";
import test from "node:test";

import {
  callCardNameExtractionModel,
  callRelayJsonTask,
  callRuleQueryExtractionModel,
  createPublicAnswerModelEnv,
  resolveCardExtractionProvider,
  resolveRagProvider,
  resolveRuleQueryExtractionProvider,
} from "../backend/ragModelClient.mjs";

const RELAY_ENV = Object.freeze({
  RELAY_API_KEY: "relay-test-key",
  RELAY_BASE_URL: "https://relay.example.test/v1",
  API_CHATGPT_DAILY_BUDGET_USD: "10",
  API_BUDGET_TIMEZONE: "UTC",
});

test("Relay JSON tasks are strict, single-request Sol low calls charged to the public USD bucket", async () => {
  const calls = [];
  const result = await callRelayJsonTask({
    prompt: "只输出 JSON 对象",
    modelName: "deepseek-v4-flash",
    maxTokens: 192,
    env: RELAY_ENV,
    now: new Date("2051-01-01T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return relaySseResponse({ ok: true }, {
        prompt_tokens: 24,
        completion_tokens: 8,
        total_tokens: 32,
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].body.model, "gpt-5.6-sol");
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(calls[0].body.max_completion_tokens, 192);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(result.ok, true);
  assert.equal(result.reasoningEffort, "low");
  assert.ok(result.warnings.includes("relay_auxiliary_model_invalid_defaulted_sol"));
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd > 0, true);
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:relay");
});

test("Relay JSON tasks never retry or repair malformed JSON", async () => {
  let calls = 0;
  await assert.rejects(
    callRelayJsonTask({
      prompt: "返回格式错误的内容",
      maxTokens: 64,
      env: RELAY_ENV,
      now: new Date("2051-01-02T00:00:00.000Z"),
      fetchImpl: async () => {
        calls += 1;
        return relaySseRaw("not-json");
      },
    }),
    (error) => {
      assert.equal(error?.code, "relay_json_task_invalid_json");
      assert.doesNotMatch(String(error?.message || ""), /DeepSeek/iu);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("public card-name extraction uses Relay Sol low even when a DeepSeek key remains configured", async () => {
  const publicEnv = createPublicAnswerModelEnv({
    ...RELAY_ENV,
    DEEPSEEK_API_KEY: "leftover-deepseek-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  }, "relay-gpt-5.6-sol-low");
  const calls = [];
  const result = await callCardNameExtractionModel({
    userQuery: "测试龙的效果可以发动吗？",
    dataRevision: "relay-card-extraction-v1",
    env: publicEnv,
    now: new Date("2051-01-03T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      assert.doesNotMatch(String(url), /api\.deepseek\.com/iu);
      return relaySseResponse({
        cardNames: [{ name: "测试龙", originalText: "测试龙", confidence: "high" }],
      }, {
        prompt_tokens: 30,
        completion_tokens: 12,
        total_tokens: 42,
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].body.model, "gpt-5.6-sol");
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(result.providerUsed, "relay");
  assert.equal(result.modelUsed, "gpt-5.6-sol");
  assert.deepEqual(result.candidates.map((item) => item.name), ["测试龙"]);
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd > 0, true);
});

test("a DeepSeek key alone cannot dispatch public card-name extraction", async () => {
  const publicEnv = createPublicAnswerModelEnv({
    DEEPSEEK_API_KEY: "leftover-deepseek-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  }, "relay-gpt-5.6-sol-low");
  let calls = 0;
  const result = await callCardNameExtractionModel({
    userQuery: "测试龙的效果可以发动吗？",
    dataRevision: "relay-card-no-deepseek-fallback-v1",
    env: publicEnv,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not dispatch");
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.providerUsed, "mock");
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.includes("relay_configuration_missing_card_name_model_disabled"));
});

test("legacy explicit DeepSeek auxiliary settings redirect to Relay and never reach DeepSeek", async () => {
  const calls = [];
  const env = {
    ...RELAY_ENV,
    DEEPSEEK_API_KEY: "leftover-deepseek-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    assert.doesNotMatch(String(url), /deepseek/iu);
    return relaySseResponse({
      cardNames: [{ name: "测试龙", originalText: "测试龙", confidence: "high" }],
      queries: ["测试规则"],
    });
  };
  const card = await callCardNameExtractionModel({
    userQuery: "测试龙的效果可以发动吗？",
    dataRevision: "legacy-deepseek-card-redirect-v1",
    env,
    fetchImpl,
  });
  const rule = await callRuleQueryExtractionModel({
    userQuery: "测试龙的效果可以发动吗？",
    dataRevision: "legacy-deepseek-rule-redirect-v1",
    env,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(card.providerUsed, "relay");
  assert.equal(rule.providerUsed, "relay");
  assert.ok(card.warnings.includes("deepseek_card_name_model_disabled_redirected_to_relay"));
  assert.ok(rule.warnings.includes("deepseek_rule_query_model_disabled_redirected_to_relay"));
  assert.ok(calls.every((call) => call.body.model === "gpt-5.6-sol"));
});

test("legacy explicit DeepSeek auxiliary settings fail closed without Relay", async () => {
  let calls = 0;
  const env = {
    DEEPSEEK_API_KEY: "leftover-deepseek-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
  };
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not dispatch");
  };
  const card = await callCardNameExtractionModel({
    userQuery: "测试龙",
    dataRevision: "legacy-deepseek-card-disabled-v1",
    env,
    fetchImpl,
  });
  const rule = await callRuleQueryExtractionModel({
    userQuery: "测试龙",
    dataRevision: "legacy-deepseek-rule-disabled-v1",
    env,
    fetchImpl,
  });

  assert.equal(calls, 0);
  assert.equal(card.providerUsed, "mock");
  assert.equal(rule.providerUsed, "mock");
});

test("auto auxiliary provider selection ignores a leftover DeepSeek key", () => {
  const withoutRelay = {
    DEEPSEEK_API_KEY: "deepseek-final-only-key",
    RAG_CARD_MODEL_PROVIDER: "auto",
    RAG_RULE_MODEL_PROVIDER: "auto",
  };
  assert.equal(resolveCardExtractionProvider(withoutRelay).provider, "mock");
  assert.equal(resolveRuleQueryExtractionProvider(withoutRelay).provider, "mock");

  const withRelay = {
    ...withoutRelay,
    RELAY_API_KEY: "relay-auxiliary-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
  };
  assert.equal(resolveCardExtractionProvider(withRelay).provider, "relay");
  assert.equal(resolveRuleQueryExtractionProvider(withRelay).provider, "relay");
});

test("a DeepSeek final profile retains dedicated Relay credentials for formal drafts", () => {
  const publicEnv = createPublicAnswerModelEnv({
    RELAY_API_KEY: "relay-test-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    DEEPSEEK_API_KEY: "deepseek-final-key",
  }, "deepseek-v4-flash-low");

  assert.equal(publicEnv.RELAY_API_KEY, undefined);
  assert.equal(publicEnv.DEEPSEEK_API_KEY, "deepseek-final-key");
  assert.equal(publicEnv.RAG_MODEL_PROVIDER, "deepseek");
  assert.equal(resolveRagProvider(publicEnv).provider, "deepseek");
  assert.equal(resolveCardExtractionProvider(publicEnv).provider, "relay");
  assert.equal(resolveRuleQueryExtractionProvider(publicEnv).provider, "relay");
  assert.equal(publicEnv.RAG_FORMAL_SCENARIO_DRAFT_RELAY_API_KEY, "relay-test-key");
  assert.equal(publicEnv.RAG_FORMAL_SCENARIO_DRAFT_RELAY_BASE_URL, "https://relay.example.test/v1");
});

function relaySseResponse(payload, usage = {}) {
  return relaySseRaw(JSON.stringify(payload), usage);
}

function relaySseRaw(content, usage = {
  prompt_tokens: 8,
  completion_tokens: 4,
  total_tokens: 12,
}) {
  return new Response([
    `data: ${JSON.stringify({
      model: "gpt-5.6-sol",
      choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
      usage,
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
