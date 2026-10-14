import assert from "node:assert/strict";
import test from "node:test";

import {
  callCardIdentitySelectionModel,
  callCardNameExtractionModel,
  createPublicAnswerModelEnv,
  resolveCardExtractionProvider,
} from "../backend/ragModelClient.mjs";

import { createCloudRequestBudget, runCloudBudgetedQuestion, CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE } from "../backend/cloudRequestBudget.mjs";

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

// 2026-10-12 规则变更: card extraction and candidate selection default to Luna low;
// the RAG_CARD_BAI_*_REASONING_EFFORT variables can restore none.
test("b.ai card transport uses the dedicated Luna Responses model with low reasoning by default", async () => {
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
  assert.equal(requests[0].body.reasoning.effort, "low");
  assert.equal(requests[0].body.text.format.type, "json_object");
  // An explicit RAG_CARD_MODEL_MAX_OUTPUT_TOKENS still wins over the 1200 low default.
  assert.equal(requests[0].body.max_output_tokens, 800);
  assert.equal(requests[0].body.thinking, undefined);
  assert.equal(requests[0].body.max_tokens, undefined);
  assert.equal(result.tokenUsage.prompt_tokens, 12);
  assert.equal(result.tokenUsage.completion_tokens, 8);
  assert.ok(result.warnings.includes("bai_transport_channel:bai"));
  assert.ok(result.warnings.includes("bai_endpoint_host:card.example.test"));
});

test("the same b.ai transport serves ambiguity identity selection with low reasoning by default", async () => {
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
  assert.equal(requests[0].body.reasoning.effort, "low");
  assert.equal(requests[0].body.max_output_tokens, 1600);
  assert.match(requests[0].body.input, /必须返回 null/u);
  assert.ok(result.warnings.includes("bai_transport_channel:bai"));
});

test("card extraction and selection can be returned to Luna none by configuration", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return responseFor(String(body.input).includes("候选集") ? { selections: [] }
      : { cardNames: [{ name: "黑魔术师", originalText: "黑魔术师", confidence: "high" }] });
  };
  const env = { ...baseEnv, RAG_CARD_BAI_EXTRACTION_REASONING_EFFORT: "none", RAG_CARD_BAI_SELECTION_REASONING_EFFORT: "none" };
  await budgeted(callCardNameExtractionModel, { userQuery: "黑魔术师的效果？", dataRevision: "bai-card-none", env, fetchImpl });
  await budgeted(callCardIdentitySelectionModel, { userQuery: "那个黑魔术师", dataRevision: "bai-card-none",
    candidateSets: [{ mentionId: "m1", mentionText: "黑魔术师", candidates: [{ candidateId: "c1", name: "黑魔术师" }] }],
    env, fetchImpl });
  assert.deepEqual(requests.map((body) => [body.reasoning.effort, body.max_output_tokens]), [["none", 800], ["none", 800]]);
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

// 2026-10-14: b.ai's Luna route hung (card names timed out at 60 s), so the
// same card request can be served by the official OpenAI API instead.
const officialSourceEnv = {
  ...baseEnv,
  RAG_CARD_LUNA_CHANNEL: "official",
  OPENAI_DECISIONS_API_KEY: "official-evidence-secret",
  BAI_API_KEY: "final-bai-secret",
  PUBLIC_OPENAI_BUDGET_RUN_ID: "official-card-test",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "redis-secret",
};

function officialNetwork(body, responseModel = "gpt-6-luna") {
  const calls = { openai: [], bai: [], ledger: [] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://redis.example.test")) {
      const args = JSON.parse(options.body);
      calls.ledger.push(args);
      const settle = args[1] === CLOUD_BUDGET_SETTLE;
      return new Response(JSON.stringify({ result: [settle ? "settled" : "reserved"] }), { status: 200 });
    }
    const record = { url: target, body: JSON.parse(options.body), authorization: options.headers.authorization,
      redirect: options.redirect };
    if (target.startsWith("https://api.openai.com/")) calls.openai.push(record); else calls.bai.push(record);
    return responseFor(body, { model: responseModel });
  };
  return { calls, fetchImpl };
}

test("the official Luna card channel sends the unchanged request to OpenAI with a card-only key and the official ledger", async () => {
  const env = createPublicAnswerModelEnv(officialSourceEnv, "bai-astra-low");
  assert.equal(env.RAG_CARD_LUNA_CHANNEL, "official");
  assert.equal(env.RAG_CARD_OPENAI_API_KEY, "official-evidence-secret");
  assert.equal(env.OPENAI_DECISIONS_API_KEY, undefined, "the final provider never receives OPENAI_* values");
  assert.equal(env.BAI_API_KEY, "final-bai-secret", "the b.ai final profile keeps its own credential");

  const extraction = { cardNames: [{ name: "黑魔术师", originalText: "黑魔术师", confidence: "high" }] };
  const official = officialNetwork(extraction, "gpt-6-luna-2026-09-30");
  const result = await callCardNameExtractionModel({ userQuery: "黑魔术师的效果是什么？",
    dataRevision: "official-luna-card-v1", env, fetchImpl: official.fetchImpl });

  assert.equal(official.calls.bai.length, 0, "no request may reach b.ai");
  assert.equal(official.calls.openai.length, 1);
  const [request] = official.calls.openai;
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.authorization, "Bearer official-evidence-secret");
  assert.equal(request.redirect, "error");

  // The wire body is byte-for-byte the b.ai body for the same configuration.
  const bai = officialNetwork(extraction);
  await budgeted(callCardNameExtractionModel, { userQuery: "黑魔术师的效果是什么？",
    dataRevision: "official-luna-card-v1-bai", env: baseEnv, fetchImpl: bai.fetchImpl });
  assert.deepEqual(request.body, bai.calls.bai[0].body);

  assert.equal(result.providerUsed, "openai");
  assert.equal(result.modelUsed, "gpt-6-luna");
  assert.deepEqual(result.candidates.map((item) => item.name), ["黑魔术师"]);
  assert.ok(result.warnings.includes("luna_card_channel:official"));
  assert.ok(result.warnings.includes("luna_card_endpoint_host:api.openai.com"));
  assert.ok(result.warnings.includes("luna_card_returned_model:gpt-6-luna-2026-09-30"));
  assert.ok(!result.warnings.some((warning) => warning.startsWith("bai_")));

  const reserve = official.calls.ledger.find((args) => args[1] === CLOUD_BUDGET_RESERVE);
  assert.ok(reserve, "the call reserves in the official daily ledger before dispatch");
  assert.match(reserve[3], /^ruling-cloud-budget:v1:official-card-test:/u);
  const ticket = JSON.parse(reserve.find((arg) => typeof arg === "string" && arg.includes('"pricingBasis"')));
  assert.equal(ticket.provider, "openai");
  assert.equal(ticket.model, "gpt-6-luna");
  assert.equal(ticket.pricingBasis, "openai_gpt6_luna_context_tiered_20261014");
  const settle = official.calls.ledger.find((args) => args[1] === CLOUD_BUDGET_SETTLE);
  const settled = JSON.parse(settle.at(-1));
  assert.equal(settled.returnedModel, "gpt-6-luna-2026-09-30");
  assert.equal(settled.theoreticalNano, Math.round((12 * 0.10 + 8 * 0.50) / 1_000_000 * 1e9));
});

test("the official Luna card channel also serves card identity selection", async () => {
  const env = createPublicAnswerModelEnv(officialSourceEnv, "deepseek-v4.1-flash-none");
  const official = officialNetwork({ selections: [{ mentionId: "m1", candidateId: "c1" }] });
  const result = await callCardIdentitySelectionModel({ userQuery: "那个黑魔术师",
    candidateSets: [{ mentionId: "m1", mentionText: "黑魔术师",
      candidates: [{ candidateId: "c1", name: "黑魔术师", cardId: "46986414" }] }],
    dataRevision: "official-luna-identity-v1", env, fetchImpl: official.fetchImpl });
  assert.equal(official.calls.bai.length, 0);
  assert.equal(official.calls.openai.length, 1);
  assert.equal(official.calls.openai[0].body.max_output_tokens, 1600);
  assert.equal(result.providerUsed, "openai");
  assert.deepEqual(result.selections, [{ mentionId: "m1", candidateId: "c1" }]);
  assert.ok(result.warnings.includes("luna_card_channel:official"));
});

test("the official Luna card channel needs its own official key and prefers the dedicated one", () => {
  const withoutKey = { BAI_CARD_ENABLED: "true", BAI_CARD_API_KEY: "card-only-secret", RAG_CARD_LUNA_CHANNEL: "official" };
  const missing = resolveCardExtractionProvider(withoutKey);
  assert.equal(missing.provider, "mock");
  assert.ok(missing.warnings.includes("official_luna_card_api_key_missing_card_name_model_disabled"));
  assert.equal(resolveCardExtractionProvider({ ...withoutKey, OPENAI_DECISIONS_API_KEY: "k" }).provider, "bai");

  const env = createPublicAnswerModelEnv({ ...officialSourceEnv, OCG_CARD_OPENAI_API_KEY: "dedicated-card-secret" },
    "bai-astra-low");
  assert.equal(env.RAG_CARD_OPENAI_API_KEY, "dedicated-card-secret");
  assert.equal(env.OCG_CARD_OPENAI_API_KEY, undefined);
});

test("without the official channel no official key is copied for card calls", () => {
  const { RAG_CARD_LUNA_CHANNEL, ...source } = officialSourceEnv;
  const env = createPublicAnswerModelEnv({ ...source, OCG_CARD_OPENAI_API_KEY: "dedicated-card-secret" }, "bai-astra-low");
  assert.equal(RAG_CARD_LUNA_CHANNEL, "official");
  assert.equal(env.RAG_CARD_LUNA_CHANNEL, undefined);
  assert.equal(env.RAG_CARD_OPENAI_API_KEY, undefined);
  assert.equal(env.OCG_CARD_OPENAI_API_KEY, undefined);
});
