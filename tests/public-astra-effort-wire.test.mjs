import assert from "node:assert/strict";
import test from "node:test";
import { callRagModel, createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";
import {
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from "../backend/publicRulingModelConfig.mjs";
import { answerPublicRulingQuestion } from "../backend/publicAnswerService.mjs";

const OFFICIAL_ENV = Object.freeze({
  BAI_API_KEY: "synthetic-bai-key",
  OCG_FINAL_OPENAI_API_KEY: "synthetic-official-key",
  PUBLIC_OPENAI_BUDGET_RUN_ID: "public-official-astra",
  PUBLIC_OPENAI_BUDGET_LIMIT_USD: "5",
  PUBLIC_OPENAI_BUDGET_INITIAL_USD: "0.6054225",
  UPSTASH_BUDGET_KV_REST_API_URL: "https://budget.example.invalid",
  UPSTASH_BUDGET_KV_REST_API_TOKEN: "synthetic-budget-token",
  RELAY_API_KEY: "synthetic-relay-key",
  RELAY_BASE_URL: "https://relay.example.invalid/v1",
});

test("public capabilities expose the exact allowlisted models and efforts", () => {
  const capabilities = getPublicRulingModelCapabilities(OFFICIAL_ENV);
  assert.equal(capabilities.defaultRulingModelProfile, "bai-astra-low");
  assert.equal(capabilities.rulingModelProfiles.length, 18);
  assert.equal(capabilities.rulingModelProfiles.find(({ id }) => id === "bai-astra-low").available, true);
  assert.equal(capabilities.rulingModelProfiles.some(({ provider }) => provider === "openai"), false);
  assert.equal(capabilities.rulingModelProfiles.find(({ id }) => id === "bai-astra-low").label, "GPT-6 Astra · 思考 low");
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    for (const model of ["gpt-5.6-sol", "gpt-6-astra"]) {
      const profile = resolvePublicRulingModelProfile(`relay-${model}-${effort}`);
      assert.equal(profile.model, model);
      assert.equal(profile.reasoningEffort, effort);
      assert.equal(profile.thinkingMode, "enabled");
    }
  }
  assert.throws(() => resolvePublicRulingModelProfile("relay-gpt-6-astra-ultra"), /Unsupported public ruling model profile/u);
});

test("public finalization sends one fixed official Chat Completions request and keeps provider keys isolated", async () => {
  const prompt = "Synthetic transport contract check. No ruling question or evidence.";
  const env = createPublicAnswerModelEnv({
    ...OFFICIAL_ENV,
    OPENAI_API_KEY: "admin-key-must-not-survive",
    RAG_MAX_OUTPUT_TOKENS: "99999",
    RELAY_MAX_COMPLETION_TOKENS: "32000",
  }, "official-astra-low");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OCG_FINAL_OPENAI_API_KEY, "synthetic-official-key");
  assert.equal(env.RELAY_API_KEY, undefined);
  assert.equal(env.RAG_CARD_MODEL_RELAY_API_KEY, "synthetic-relay-key");
  assert.equal(env.RAG_RULE_MODEL_RELAY_API_KEY, "synthetic-relay-key");

  const modelRequests = [];
  const budgetCommands = [];
  const result = await callRagModel({
    prompt,
    env,
    outputMode: "plain_text",
    fetchImpl: async (url, options) => {
      if (String(url) === "https://budget.example.invalid") {
        const command = JSON.parse(options.body);
        const isReserve = budgetCommands.length === 0;
        budgetCommands.push(command);
        return Response.json({ result: isReserve
          ? ["reserved", "0", "605422500"]
          : ["settled", "0", "605722500"] });
      }
      assert.equal(options.redirect, "error");
      modelRequests.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response([
        `data: ${JSON.stringify({
          id: "synthetic-official",
          model: "gpt-6-astra",
          choices: [{ index: 0, finish_reason: "stop", delta: { content: "Synthetic response." } }],
          usage: {
            prompt_tokens: 21_666,
            completion_tokens: 324,
            total_tokens: 21_990,
            prompt_tokens_details: { cache_write_tokens: 21_663 },
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });

  assert.equal(modelRequests.length, 1);
  assert.equal(modelRequests[0].url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(modelRequests[0].body, {
    model: "gpt-6-astra",
    messages: [{ role: "user", content: prompt }],
    reasoning_effort: "low",
    max_completion_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(budgetCommands.length, 2);
  assert.match(budgetCommands[0][3], /^ruling-cloud-budget:v1:public-official-astra:\d{4}-\d{2}-\d{2}$/u);
  assert.equal(result.providerUsed, "openai");
  assert.equal(result.modelUsed, "gpt-6-astra");
  assert.equal(result.estimatedCostUsd, 0.287018);
});

test("public body-like profile and effort values cannot change the b.ai default final request", () => {
  const env = createPublicAnswerModelEnv({
    ...OFFICIAL_ENV,
    RAG_MODEL: "arbitrary-model",
    RAG_REASONING_EFFORT: "max",
    RELAY_MODEL: "gpt-5.6-sol",
  }, undefined);
  assert.equal(env.RAG_MODEL_PROVIDER, "bai");
  assert.equal(env.RAG_MODEL, "gpt-6-astra");
  assert.equal(env.RAG_REASONING_EFFORT, "low");
});

test("the public service binds allowlisted profiles and ignores arbitrary provider parameters", async () => {
  let answerCalls = 0;
  await answerPublicRulingQuestion({
    payload: { question: "synthetic", rulingModelProfile: "relay-gpt-6-astra-xhigh", reasoningEffort: "low", model: "arbitrary-model" },
    env: OFFICIAL_ENV,
    appendAudit: async () => {},
    prepareForContinuation: true,
    answerRuling: async ({ env }) => {
      answerCalls += 1;
      assert.equal(env.RAG_MODEL_PROVIDER, "relay");
      assert.equal(env.RAG_MODEL, "gpt-6-astra");
      assert.equal(env.RAG_REASONING_EFFORT, "xhigh");
      return { ok: true };
    },
  });
  assert.equal(answerCalls, 1);

  await answerPublicRulingQuestion({
    payload: {
      question: "synthetic",
      rulingModelProfile: "official-astra-low",
      reasoningEffort: "max",
      provider: "relay",
      model: "gpt-5.6-sol",
    },
    env: OFFICIAL_ENV,
    appendAudit: async () => {},
    prepareForContinuation: true,
    answerRuling: async ({ env }) => {
      answerCalls += 1;
      assert.equal(env.RAG_MODEL_PROVIDER, "openai");
      assert.equal(env.RAG_MODEL, "gpt-6-astra");
      assert.equal(env.RAG_REASONING_EFFORT, "low");
      return { ok: true };
    },
  });
  assert.equal(answerCalls, 2);
});
