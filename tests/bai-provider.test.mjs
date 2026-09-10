import assert from "node:assert/strict";
import test from "node:test";

import {
  callBaiJsonTask,
  callRagModel,
  createPublicAnswerModelEnv,
  getRagBudgetStatus,
  resolveRuleQueryExtractionProvider,
} from "../backend/ragModelClient.mjs";
import {
  DEFAULT_PUBLIC_BAI_BASE_URL,
  DEFAULT_PUBLIC_RULING_MODEL_PROFILE,
  publicRulingModelProfileAvailable,
  resolvePublicRulingModelProfile,
} from "../backend/publicRulingModelConfig.mjs";
import { runCloudBudgetedQuestion } from "../backend/cloudRequestBudget.mjs";

const BAI_ENV = Object.freeze({
  BAI_API_KEY: "synthetic-bai-key",
  BAI_BASE_URL: "https://bai.example.invalid/v1",
});

test("b.ai Astra low is the third-party public default and keeps credentials isolated", () => {
  assert.equal(DEFAULT_PUBLIC_RULING_MODEL_PROFILE, "bai-astra-low");
  assert.equal(DEFAULT_PUBLIC_BAI_BASE_URL, "https://api.b.ai/v1");
  const profile = resolvePublicRulingModelProfile("bai-astra-low");
  assert.deepEqual({
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    thirdParty: profile.thirdParty,
    modelIdentityVerified: profile.modelIdentityVerified,
  }, {
    provider: "bai",
    model: "gpt-6-astra",
    reasoningEffort: "low",
    thirdParty: true,
    modelIdentityVerified: false,
  });
  assert.equal(publicRulingModelProfileAvailable(profile, { BAI_API_KEY: "key" }), true);
  assert.equal(publicRulingModelProfileAvailable(profile, {
    BAI_API_KEY: "key",
    BAI_BASE_URL: "http://api.b.ai/v1",
  }), false);

  const env = createPublicAnswerModelEnv({
    ...BAI_ENV,
    OCG_FINAL_OPENAI_API_KEY: "official-key-must-not-survive",
    RELAY_API_KEY: "relay-key-must-not-be-final",
    RELAY_BASE_URL: "https://relay.example.invalid/v1",
  }, profile.id);
  assert.equal(env.RAG_MODEL_PROVIDER, "bai");
  assert.equal(env.RAG_MODEL, "gpt-6-astra");
  assert.equal(env.RAG_REASONING_EFFORT, "low");
  assert.equal(env.BAI_API_KEY, "synthetic-bai-key");
  assert.equal(env.RELAY_API_KEY, undefined);
  assert.equal(env.OCG_FINAL_OPENAI_API_KEY, undefined);
  assert.equal(env.RAG_RULE_MODEL_RELAY_API_KEY, "relay-key-must-not-be-final");

  const relayEnv = createPublicAnswerModelEnv({
    ...BAI_ENV,
    RELAY_API_KEY: "relay-key",
    RELAY_BASE_URL: "https://relay.example.invalid/v1",
  }, "relay-gpt-5.6-sol-low");
  assert.equal(relayEnv.BAI_API_KEY, undefined);
  assert.equal(relayEnv.BAI_BASE_URL, undefined);
});

test("cloud evidence keeps both auxiliary DeepSeek calls on the verified 4.1 model", () => {
  const defaultEnv = createPublicAnswerModelEnv({
    ...BAI_ENV,
    DEEPSEEK_API_KEY: "synthetic-deepseek-key",
    RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
    CLOUD_EVIDENCE_AUXILIARY_PROVIDER: "deepseek",
  }, "bai-astra-low");
  assert.equal(defaultEnv.RAG_CARD_MODEL_PROVIDER, "deepseek");
  assert.equal(defaultEnv.RAG_RULE_MODEL_PROVIDER, "deepseek");
  assert.equal(defaultEnv.DEEPSEEK_CARD_MODEL, "deepseek-v4.1-flash-expires-on-0910");
  assert.equal(defaultEnv.DEEPSEEK_RULE_MODEL, "deepseek-v4.1-flash-expires-on-0910");
  assert.equal(resolveRuleQueryExtractionProvider(defaultEnv).provider, "deepseek");

  const overrideEnv = createPublicAnswerModelEnv({
    ...defaultEnv,
    DEEPSEEK_CARD_MODEL: "verified-card-model",
    DEEPSEEK_RULE_MODEL: "verified-rule-model",
  }, "bai-astra-low");
  assert.equal(overrideEnv.DEEPSEEK_CARD_MODEL, "verified-card-model");
  assert.equal(overrideEnv.DEEPSEEK_RULE_MODEL, "verified-rule-model");
});

test("callBaiJsonTask sends one fixed Astra low JSON Chat Completions request", async () => {
  const calls = [];
  const result = await callBaiJsonTask({
    prompt: "Classify only the supplied scope and return JSON.",
    model: "gpt-6-astra",
    reasoningEffort: "low",
    maxOutputTokens: 700,
    env: BAI_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return baiSseResponse({
        id: "bai-json-1",
        model: "gpt-6-astra",
        content: JSON.stringify({ scope: "allowed" }),
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bai.example.invalid/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer synthetic-bai-key");
  assert.deepEqual(calls[0].body, {
    model: "gpt-6-astra",
    messages: [{ role: "user", content: "Classify only the supplied scope and return JSON." }],
    response_format: { type: "json_object" },
    reasoning_effort: "low",
    max_completion_tokens: 700,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(result.scope, "allowed");
  assert.equal(result.providerUsed, "bai");
  assert.equal(result.requestedModel, "gpt-6-astra");
  assert.equal(result.reasoningEffort, "low");
  assert.equal(result.costBasis, "official_theoretical");
  assert.equal(result.estimatedCostUsd, 0.0007);
});

test("callBaiJsonTask keeps theoretical cost unknown when provider usage is absent", async () => {
  const result = await callBaiJsonTask({
    prompt: "Return one JSON object.",
    env: BAI_ENV,
    fetchImpl: async () => baiSseResponse({
      id: "bai-json-no-usage",
      model: "gpt-6-astra",
      content: JSON.stringify({ scope: "uncertain" }),
      usage: null,
    }),
  });
  assert.equal(result.estimatedCostUsd, null);
  assert.ok(result.warnings.includes("provider_usage_incomplete_cost_unknown"));
});

test("public b.ai finalization reuses the saved plain-text prompt with Astra low", async () => {
  const prompt = "Frozen final prompt supplied byte-for-byte.";
  const env = createPublicAnswerModelEnv(BAI_ENV, "bai-astra-low");
  const calls = [];
  const result = await callRagModel({
    prompt,
    env,
    outputMode: "plain_text",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return baiSseResponse({
        id: "bai-final-1",
        model: "gpt-6-astra",
        content: "Synthetic final answer.",
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bai.example.invalid/v1/chat/completions");
  assert.deepEqual(calls[0].body, {
    model: "gpt-6-astra",
    messages: [{ role: "user", content: prompt }],
    reasoning_effort: "low",
    max_completion_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(result.answer.shortAnswer, "Synthetic final answer.");
  assert.equal(result.providerUsed, "bai");
  assert.equal(result.modelUsed, "gpt-6-astra");
  assert.equal(result.costBasis, "official_theoretical");
  assert.equal(result.estimatedCostUsd, 0.0007);
});

test("public b.ai dispatch joins the active cloud budget context", async () => {
  let budgetedBody = null;
  let dispatches = 0;
  const budget = {
    async bai({ body, invoke }) {
      budgetedBody = body;
      return invoke();
    },
    snapshot() {
      return { calls: [{ provider: "bai", costBasis: "official_theoretical" }] };
    },
  };
  const env = createPublicAnswerModelEnv({
    ...BAI_ENV,
    RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
  }, "bai-astra-low");
  const result = await runCloudBudgetedQuestion({ env, budget }, () => callRagModel({
    prompt: "Frozen budgeted prompt.",
    env,
    outputMode: "plain_text",
    fetchImpl: async () => {
      dispatches += 1;
      return baiSseResponse({
        id: "bai-budgeted-1",
        model: "gpt-6-astra",
        content: "Budgeted response.",
      });
    },
  }));

  assert.equal(dispatches, 1);
  assert.equal(budgetedBody.model, "gpt-6-astra");
  assert.equal(budgetedBody.reasoning_effort, "low");
  assert.equal(result.debug.cloudCosts.calls[0].provider, "bai");
});

test("public budget status separates settled b.ai use from the shared allowance", async () => {
  const env = {
    RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
    CLOUD_BUDGET_PERIOD: "daily",
    CLOUD_BUDGET_RUN_ID: "bai-status-test",
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "10",
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: "5",
    API_DAILY_BUDGET_CNY: "10",
    UPSTASH_REDIS_REST_URL: "https://budget.example.invalid",
    UPSTASH_REDIS_REST_TOKEN: "synthetic-token",
  };
  const fetchImpl = async (_url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === "HGETALL") {
      return Response.json({ result: [
        "actualNano", "300000000",
        "theoreticalNano", "700000000",
        "bai-settled", JSON.stringify({
          provider: "bai",
          status: "usage_settled",
          theoreticalNano: 200000000,
        }),
        "bai-reserved", JSON.stringify({
          provider: "bai",
          status: "reserved",
          theoreticalNano: 100000000,
        }),
        "deepseek-settled", JSON.stringify({
          provider: "deepseek",
          status: "usage_settled",
          actualNano: 300000000,
        }),
        "relay-settled", JSON.stringify({
          provider: "relay",
          status: "usage_settled",
          theoreticalNano: 400000000,
        }),
      ] });
    }
    return Response.json({ result: command[0] === "GET" ? null : "0" });
  };
  const status = await getRagBudgetStatus({ env, fetchImpl });
  const preparation = status.buckets.find((item) => item.id === "evidence_preparation:deepseek");
  const bai = status.buckets.find((item) => item.id === "final_ruling:bai");
  assert.equal(preparation.spentTodayCny, 0.3);
  assert.equal(bai.spentTodayUsd, 0.2);
  assert.equal(bai.reservedTodayUsd, 0.1);
  assert.equal(bai.sharedAccountedUsd, 0.7);
  assert.equal(bai.remainingTodayUsd, 4.3);
  assert.equal(bai.costBasis, "official_theoretical");
  assert.equal(bai.sharedPoolLabel, "与既有调用共享理论美元限额");
});

function baiSseResponse({
  id,
  model,
  content,
  usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
}) {
  return new Response([
    `data: ${JSON.stringify({
      id,
      model,
      choices: [{ index: 0, finish_reason: "stop", delta: { content } }],
      ...(usage ? { usage } : {}),
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
