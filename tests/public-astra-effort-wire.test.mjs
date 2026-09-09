import assert from "node:assert/strict";
import test from "node:test";
import { callRagModel, createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";
import {
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from "../backend/publicRulingModelConfig.mjs";
import { answerPublicRulingQuestion } from "../backend/publicAnswerService.mjs";

const OFFICIAL_ENV = Object.freeze({
  OCG_FINAL_OPENAI_API_KEY: "synthetic-official-key",
  PUBLIC_OPENAI_BUDGET_RUN_ID: "public-official-astra",
  PUBLIC_OPENAI_BUDGET_LIMIT_USD: "5",
  PUBLIC_OPENAI_BUDGET_INITIAL_USD: "0.6054225",
  UPSTASH_BUDGET_KV_REST_API_URL: "https://budget.example.invalid",
  UPSTASH_BUDGET_KV_REST_API_TOKEN: "synthetic-budget-token",
  RELAY_API_KEY: "synthetic-relay-key",
  RELAY_BASE_URL: "https://relay.example.invalid/v1",
});

test("public capabilities expose only official Astra low and reject every legacy effort profile", () => {
  const capabilities = getPublicRulingModelCapabilities(OFFICIAL_ENV);
  assert.equal(capabilities.defaultRulingModelProfile, "official-astra-low");
  assert.deepEqual(capabilities.rulingModelProfiles.map(({ id, provider, reasoningEffort, available }) => ({
    id, provider, reasoningEffort, available,
  })), [{
    id: "official-astra-low",
    provider: "openai",
    reasoningEffort: "low",
    available: true,
  }]);
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.throws(
      () => resolvePublicRulingModelProfile(`relay-gpt-6-astra-${effort}`),
      /Unsupported public ruling model profile/u,
    );
  }
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
  assert.equal(budgetCommands[0][3], "ruling-cloud-budget:v1:public-official-astra");
  assert.equal(result.providerUsed, "openai");
  assert.equal(result.modelUsed, "gpt-6-astra");
  assert.equal(result.estimatedCostUsd, 0.287018);
});

test("public body-like profile and effort values cannot change the official final request", () => {
  const env = createPublicAnswerModelEnv({
    ...OFFICIAL_ENV,
    RAG_MODEL: "arbitrary-model",
    RAG_REASONING_EFFORT: "max",
    RELAY_MODEL: "gpt-5.6-sol",
  }, undefined);
  assert.equal(env.RAG_MODEL_PROVIDER, "openai");
  assert.equal(env.RAG_MODEL, "gpt-6-astra");
  assert.equal(env.RAG_REASONING_EFFORT, "low");
});

test("the public service rejects legacy profiles and ignores arbitrary provider parameters", async () => {
  let answerCalls = 0;
  await assert.rejects(
    answerPublicRulingQuestion({
      payload: { question: "synthetic", rulingModelProfile: "relay-gpt-6-astra-low" },
      env: OFFICIAL_ENV,
      appendAudit: async () => {},
      answerRuling: async () => { answerCalls += 1; },
    }),
    (error) => error?.code === "invalid_ruling_model_profile",
  );
  assert.equal(answerCalls, 0);

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
    answerRuling: async ({ env }) => {
      answerCalls += 1;
      assert.equal(env.RAG_MODEL_PROVIDER, "openai");
      assert.equal(env.RAG_MODEL, "gpt-6-astra");
      assert.equal(env.RAG_REASONING_EFFORT, "low");
      return { ok: true };
    },
  });
  assert.equal(answerCalls, 1);
});
