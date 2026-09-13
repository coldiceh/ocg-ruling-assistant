import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPublicQueryScopePrompt,
  classifyPublicQueryScope,
  publicQueryScopeClassifierStatus,
  shouldTriggerPublicQueryRisk,
} from "../backend/publicQueryScopeClassifier.mjs";

test("public scope classifier uses the B.AI DeepSeek 4.1 Flash contract", async () => {
  const calls = [];
  const env = {
    BAI_API_KEY: "test-bai-key",
    PUBLIC_QUERY_SCOPE_TIMEOUT_MS: "1500",
    PUBLIC_QUERY_SCOPE_MAX_OUTPUT_TOKENS: "96",
  };
  const question = "一个明确的非裁定请求";

  assert.deepEqual(publicQueryScopeClassifierStatus(env), {
    enabled: true,
    reason: "configured",
    provider: "bai",
    model: "deepseek-v4.1-flash",
    thinkingMode: "disabled",
    reasoningEffort: null,
  });

  const result = await classifyPublicQueryScope({
    question,
    env,
    fetchImpl: () => {
      throw new Error("fetch must not be called by the injected mechanical test");
    },
    invoke: async (options) => {
      calls.push(options);
      return {
        scope: "out_of_scope",
        confidence: "high",
        reasonCode: "not_ruling_question",
        usage: { inputTokens: 12, outputTokens: 8 },
        estimatedCostCny: 0,
        estimatedCostUsd: 0,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelName, "deepseek-v4.1-flash");
  assert.equal(calls[0].thinkingMode, "disabled");
  assert.equal(calls[0].reasoningEffort, null);
  assert.equal(calls[0].stage, "evidence_preparation");
  assert.equal(calls[0].maxTokens, 96);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].prompt, buildPublicQueryScopePrompt(question));
  assert.match(calls[0].prompt, /scope 只能是 in_scope、out_of_scope、uncertain/u);

  assert.equal(result.provider, "bai");
  assert.equal(result.model, "deepseek-v4.1-flash");
  assert.equal(result.thinkingMode, "disabled");
  assert.equal(result.reasoningEffort, null);
  assert.equal(result.scope, "out_of_scope");
  assert.equal(result.confidence, "high");
  assert.equal(shouldTriggerPublicQueryRisk(result), true);
});

test("the B.AI classifier requires BAI_API_KEY and preserves fail-open behavior", async () => {
  assert.deepEqual(publicQueryScopeClassifierStatus({}), {
    enabled: false,
    reason: "bai_not_configured",
  });

  let calls = 0;
  const result = await classifyPublicQueryScope({
    question: "任意输入",
    env: {},
    invoke: async () => {
      calls += 1;
      return { scope: "out_of_scope", confidence: "high" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.scope, "uncertain");
  assert.equal(result.reasonCode, "bai_not_configured");
  assert.equal(shouldTriggerPublicQueryRisk(result), false);
});
