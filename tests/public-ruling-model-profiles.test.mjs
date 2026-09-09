import assert from "node:assert/strict";
import test from "node:test";

import { callRagModel, createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";
import { getPublicRulingModelCapabilities } from "../backend/publicRulingModelConfig.mjs";

function responsePayload(model) {
  return new Response(JSON.stringify({
    id: "profile-test-response",
    model,
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          shortAnswer: "测试裁定",
          detailedSteps: [],
          usedEvidence: [],
          confidence: "medium",
        }),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("DeepSeek profile uses the explicitly configured model and effort without credential crossover", async () => {
  const calls = [];
  const env = createPublicAnswerModelEnv({
    DEEPSEEK_API_KEY: "deepseek-secret",
    PUBLIC_DEEPSEEK_MODEL: "deepseek-v4.1-flash",
    GLM_API_KEY: "glm-secret",
    OCG_FINAL_OPENAI_API_KEY: "openai-secret",
    API_DAILY_BUDGET_CNY: "10",
  }, "deepseek-v4.1-flash-high");
  const result = await callRagModel({
    prompt: "只输出 JSON",
    env,
    now: new Date("2041-01-01T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return responsePayload("deepseek-v4.1-flash");
    },
  });

  assert.equal(env.GLM_API_KEY, undefined);
  assert.equal(env.OCG_FINAL_OPENAI_API_KEY, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "deepseek-v4.1-flash");
  assert.deepEqual(calls[0].body.thinking, { type: "enabled" });
  assert.equal(calls[0].body.reasoning_effort, "high");
  assert.equal(calls[0].options.headers.authorization, "Bearer deepseek-secret");
  assert.equal(result.providerUsed, "deepseek");
  assert.equal(result.modelUsed, "deepseek-v4.1-flash");
  assert.equal(result.requestedModel, "deepseek-v4.1-flash");
  assert.equal(result.returnedModel, "deepseek-v4.1-flash");
  assert.equal(result.generationConfig.reasoningEffort, "high");
  assert.equal(result.generationAttempts[0].responseModel, "deepseek-v4.1-flash");
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:deepseek");
  assert.equal(result.budgetStatus.bucket.spentTodayCny > 0, true);
});

test("DeepSeek none disables thinking and omits reasoning effort", async () => {
  const calls = [];
  const env = createPublicAnswerModelEnv({
    DEEPSEEK_API_KEY: "deepseek-secret",
    API_DAILY_BUDGET_CNY: "10",
  }, "deepseek-v4.1-flash-none");
  await callRagModel({
    prompt: "只输出 JSON",
    env,
    now: new Date("2041-01-02T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ body: JSON.parse(options.body) });
      return responsePayload("deepseek-v4.1-flash-expires-on-0910");
    },
  });
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(calls[0].body, "reasoning_effort"), false);
  assert.equal(calls[0].body.model, "deepseek-v4.1-flash-expires-on-0910");
});

test("GLM profile keeps glm-5.3, enabled thinking and selected effort", async () => {
  const calls = [];
  const env = createPublicAnswerModelEnv({
    GLM_API_KEY: "glm-secret",
    GLM_MODEL: "glm-5.2",
    DEEPSEEK_API_KEY: "auxiliary-deepseek-secret",
    API_DAILY_BUDGET_CNY: "10",
  }, "glm-5.3-max");
  const result = await callRagModel({
    prompt: "只输出 JSON",
    env,
    now: new Date("2041-01-03T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return responsePayload("glm-5.3");
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "glm-5.3");
  assert.deepEqual(calls[0].body.thinking, { type: "enabled" });
  assert.equal(calls[0].body.reasoning_effort, "max");
  assert.equal(calls[0].options.headers.authorization, "Bearer glm-secret");
  assert.equal(result.providerUsed, "glm");
  assert.equal(result.modelUsed, "glm-5.3");
  assert.equal(result.requestedModel, "glm-5.3");
  assert.equal(result.returnedModel, "glm-5.3");
  assert.equal(result.generationAttempts[0].responseModel, "glm-5.3");
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:glm");
  assert.equal(result.budgetStatus.bucket.spentTodayCny > 0, true);
});

test("missing provider credentials remain unavailable", () => {
  const capabilities = getPublicRulingModelCapabilities({});
  for (const profile of capabilities.rulingModelProfiles) assert.equal(profile.available, false);
});
