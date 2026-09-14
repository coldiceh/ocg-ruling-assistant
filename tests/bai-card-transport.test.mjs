import assert from "node:assert/strict";
import test from "node:test";

import {
  callCardIdentitySelectionModel,
  callCardNameExtractionModel,
  createPublicAnswerModelEnv,
  resolveCardExtractionProvider,
} from "../backend/ragModelClient.mjs";

const baseEnv = {
  BAI_CARD_ENABLED: "true",
  BAI_CARD_API_KEY: "card-only-secret",
  BAI_CARD_BASE_URL: "https://card.example.test/v1",
  RAG_CARD_MODEL_MAX_OUTPUT_TOKENS: "800",
  RAG_CARD_MODEL_TIMEOUT_MS: "5000",
  API_DAILY_BUDGET_CNY: "10",
  API_EVIDENCE_DAILY_BUDGET_CNY: "10",
};

function responseFor(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: "bai-card-test",
        model: "deepseek-v4.1-flash",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(body) },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      };
    },
    async text() { return ""; },
  };
}

test("b.ai card transport uses the dedicated DeepSeek model and disabled thinking", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), authorization: options.headers.authorization });
    return responseFor({ cardNames: [{ name: "黑魔术师", originalText: "黑魔术师", confidence: "high" }] });
  };

  assert.equal(resolveCardExtractionProvider(baseEnv).provider, "bai");
  const result = await callCardNameExtractionModel({
    userQuery: "黑魔术师的效果是什么？",
    dataRevision: "bai-card-v1",
    env: baseEnv,
    fetchImpl,
  });

  assert.equal(result.providerUsed, "bai");
  assert.equal(result.modelUsed, "deepseek-v4.1-flash");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.costBasis, "provider_actual_unknown");
  assert.equal(result.actualCostKnown, false);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.estimatedCostCny, null);
  assert.deepEqual(result.candidates.map((item) => item.name), ["黑魔术师"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://card.example.test/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer card-only-secret");
  assert.equal(requests[0].body.model, "deepseek-v4.1-flash");
  assert.equal(requests[0].body.thinking.type, "disabled");
  assert.equal(requests[0].body.response_format.type, "json_object");
  assert.ok(result.warnings.includes("bai_transport_channel:bai"));
  assert.ok(result.warnings.includes("bai_endpoint_host:card.example.test"));
});

test("the same b.ai transport serves ambiguity identity selection without changing its contract", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return responseFor({ selections: [{ mentionId: "m1", candidateId: "c1" }] });
  };
  const result = await callCardIdentitySelectionModel({
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
  assert.equal(result.modelUsed, "deepseek-v4.1-flash");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.costBasis, "provider_actual_unknown");
  assert.equal(result.actualCostKnown, false);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.estimatedCostCny, null);
  assert.deepEqual(result.selections, [{ mentionId: "m1", candidateId: "c1" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "deepseek-v4.1-flash");
  assert.equal(requests[0].body.thinking.type, "disabled");
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
  assert.equal(env.BAI_CARD_MODEL, "deepseek-v4.1-flash");
  assert.equal(env.BAI_CARD_THINKING_MODE, "disabled");
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
  const result = await callCardNameExtractionModel({
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
  assert.equal(requests[0].body.model, "deepseek-v4.1-flash");
});

test("a final-provider b.ai setting alone does not enable card extraction", () => {
  assert.equal(resolveCardExtractionProvider({
    RAG_MODEL_PROVIDER: "bai",
    BAI_API_KEY: "final-bai-secret",
  }).provider, "mock");
});
