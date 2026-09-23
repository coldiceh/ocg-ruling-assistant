import assert from "node:assert/strict";
import test from "node:test";

import {
  callCardIdentitySelectionModel,
  callCardNameExtractionModel,
  createPublicAnswerModelEnv,
  resolveCardExtractionProvider,
} from "../backend/ragModelClient.mjs";

import { createCloudRequestBudget, runCloudBudgetedQuestion, CLOUD_BUDGET_RESERVE } from "../backend/cloudRequestBudget.mjs";

const baseEnv = {
  BAI_CARD_ENABLED: "true",
  RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
  BAI_CARD_API_KEY: "card-only-secret",
  BAI_CARD_BASE_URL: "https://card.example.test/v1",
  RAG_CARD_MODEL_MAX_OUTPUT_TOKENS: "800",
  RAG_CARD_MODEL_TIMEOUT_MS: "5000",
  API_DAILY_BUDGET_CNY: "10",
  API_EVIDENCE_DAILY_BUDGET_CNY: "10",
};

function responseFor(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: "bai-card-test",
        model: "gpt-6-luna",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        ...overrides,
      };
    },
    async text() { return ""; },
  };
}

test("b.ai card transport uses the dedicated Luna Responses model without reasoning", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), authorization: options.headers.authorization });
    return responseFor({ cardNames: [{ name: "黑魔术师", originalText: "黑魔术师", confidence: "high" }] });
  };

  assert.equal(resolveCardExtractionProvider(baseEnv).provider, "bai");
  const result = await budgeted(callCardNameExtractionModel, {
    userQuery: "黑魔术师的效果是什么？",
    dataRevision: "bai-card-v1",
    env: baseEnv,
    fetchImpl,
  });

  assert.equal(result.providerUsed, "bai");
  assert.equal(result.modelUsed, "gpt-6-luna");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.costBasis, "provider_actual_unknown");
  assert.equal(result.actualCostKnown, false);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.estimatedCostCny, null);
  assert.deepEqual(result.candidates.map((item) => item.name), ["黑魔术师"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://card.example.test/v1/responses");
  assert.equal(requests[0].authorization, "Bearer card-only-secret");
  assert.equal(requests[0].body.model, "gpt-6-luna");
  assert.equal(requests[0].body.reasoning.effort, "none");
  assert.equal(requests[0].body.text.format.type, "json_object");
  assert.equal(requests[0].body.max_output_tokens, 800);
  assert.equal(requests[0].body.thinking, undefined);
  assert.equal(requests[0].body.max_tokens, undefined);
  assert.equal(result.tokenUsage.prompt_tokens, 12);
  assert.equal(result.tokenUsage.completion_tokens, 8);
  assert.ok(result.warnings.includes("bai_transport_channel:bai"));
  assert.ok(result.warnings.includes("bai_endpoint_host:card.example.test"));
});

test("the same b.ai transport serves ambiguity identity selection without changing its contract", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return responseFor({ selections: [{ mentionId: "m1", candidateId: "c1" }] });
  };
  const result = await budgeted(callCardIdentitySelectionModel, {
    userQuery: "那个黑魔术师",
    candidateSets: [{
      mentionId: "m1",
      mentionText: "黑魔术师",
      candidates: [{ candidateId: "c1", name: "黑魔术师", cardId: "46986414" }],
    }],
    dataRevision: "bai-card-identity-v1",
    env: baseEnv,
    fetchImpl,
  });

  assert.equal(result.providerUsed, "bai");
  assert.equal(result.modelUsed, "gpt-6-luna");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.costBasis, "provider_actual_unknown");
  assert.equal(result.actualCostKnown, false);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.estimatedCostCny, null);
  assert.deepEqual(result.selections, [{ mentionId: "m1", candidateId: "c1" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "gpt-6-luna");
  assert.equal(requests[0].body.reasoning.effort, "none");
  assert.ok(result.warnings.includes("bai_transport_channel:bai"));
});

test("public isolation keeps card-only b.ai settings while rule extraction stays on the configured auxiliary provider", () => {
  const env = createPublicAnswerModelEnv({
    BAI_CARD_ENABLED: "true",
    BAI_CARD_API_KEY: "card-only-secret",
    BAI_CARD_BASE_URL: "https://card.example.test/v1",
    BAI_API_KEY: "final-bai-secret",
    RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
    CLOUD_EVIDENCE_AUXILIARY_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "deepseek-secret",
  }, "deepseek-v4.1-flash-none");

  assert.equal(env.RAG_CARD_MODEL_PROVIDER, "bai");
  assert.equal(env.RAG_RULE_MODEL_PROVIDER, "deepseek");
  assert.equal(env.BAI_CARD_API_KEY, "card-only-secret");
  assert.equal(env.BAI_CARD_MODEL, "gpt-6-luna");
  assert.equal(env.BAI_CARD_REASONING_EFFORT, "none");
  assert.equal(env.BAI_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, "deepseek-secret");
});

test("formal b.ai key can be reused by the explicit card branch", async () => {
  const env = {
    ...baseEnv,
    BAI_CARD_API_KEY: "",
    BAI_API_KEY: "final-bai-secret",
  };
  assert.equal(resolveCardExtractionProvider(env).provider, "bai");
  const requests = [];
  const publicEnv = createPublicAnswerModelEnv({
    BAI_CARD_ENABLED: "true",
    BAI_API_KEY: "final-bai-secret",
    BAI_CARD_BASE_URL: "https://card.example.test/v1",
    RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
    CLOUD_EVIDENCE_AUXILIARY_PROVIDER: "deepseek",
  }, "bai-astra-low");
  assert.equal(publicEnv.RAG_CARD_MODEL_PROVIDER, "bai");
  assert.equal(publicEnv.BAI_CARD_API_KEY, "final-bai-secret");
  assert.equal(publicEnv.BAI_API_KEY, "final-bai-secret");
  const result = await budgeted(callCardNameExtractionModel, {
    userQuery: "复用正式 B.AI key",
    dataRevision: "bai-card-formal-key-v1",
    env: publicEnv,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body), authorization: options.headers.authorization });
      return responseFor({ cardNames: [] });
    },
  });
  assert.equal(result.providerUsed, "bai");
  assert.equal(requests[0].authorization, "Bearer final-bai-secret");
  assert.equal(requests[0].body.model, "gpt-6-luna");
});

test("a final-provider b.ai setting alone does not enable card extraction", () => {
  assert.equal(resolveCardExtractionProvider({
    RAG_MODEL_PROVIDER: "bai",
    BAI_API_KEY: "final-bai-secret",
  }).provider, "mock");
});

async function budgeted(operation, args) {
  const env = { ...args.env, CLOUD_BUDGET_RUN_ID: "card-transport-test",
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "1", CLOUD_BUDGET_THEORETICAL_LIMIT_USD: "1" };
  const budget = createCloudRequestBudget({ env, command: async (args) =>
    [args[1] === CLOUD_BUDGET_RESERVE ? "reserved" : "settled"] });
  const result = await runCloudBudgetedQuestion({ env, budget }, () => operation({ ...args, env }));
  assert.equal(result.debug.cloudCosts.calls.length, 1);
  assert.equal(result.debug.cloudCosts.calls[0].provider, "bai");
  assert.equal(result.debug.cloudCosts.calls[0].stage, "evidence_preparation");
  assert.equal(result.debug.cloudCosts.calls[0].model, "gpt-6-luna");
  return result;
}

test("incomplete Responses output is charged but cannot become a cached card result", async () => {
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await budgeted(callCardNameExtractionModel, {
      userQuery: "incomplete response fixture", dataRevision: "incomplete-card-v1", env: baseEnv,
      fetchImpl: async () => {
        calls += 1;
        return responseFor({ cardNames: [{ name: "黑魔术师" }] }, {
          status: "incomplete", incomplete_details: { reason: "content_filter" },
        });
      },
    });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.warnings.some((value) => value.includes("bai_card_response_incomplete")));
    assert.equal(result.debug.cloudCosts.calls[0].status, "usage_settled");
  }
  assert.equal(calls, 2);
});
