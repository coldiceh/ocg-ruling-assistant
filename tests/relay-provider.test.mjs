import assert from "node:assert/strict";
import test from "node:test";

import {
  callRagModel,
  createPublicAnswerModelEnv,
  resolveRagProvider,
} from "../backend/ragModelClient.mjs";
import {
  getPublicRulingModelCapabilities,
  publicRulingModelProfileAvailable,
} from "../backend/publicRulingModelConfig.mjs";

const RELAY_PROFILE_ID = "relay-gpt-5.6-sol-high";

test("relay is not registered as a public ruling profile", () => {
  const capabilities = getPublicRulingModelCapabilities({
    RELAY_API_KEY: "relay-issued-key",
    PUBLIC_RELAY_ENABLED: "true",
  });
  assert.deepEqual(
    capabilities.rulingModelProfiles.map((profile) => profile.id),
    ["deepseek-v4-flash-high"],
  );
  assert.equal(capabilities.rulingModelProfiles.some((profile) => profile.provider === "relay"), false);
  assert.throws(
    () => publicRulingModelProfileAvailable(RELAY_PROFILE_ID, {
      RELAY_API_KEY: "relay-issued-key",
      PUBLIC_RELAY_ENABLED: "true",
    }),
    /Unsupported public ruling model profile/u,
  );
});

test("server rejects a retired relay profile as the public default", () => {
  assert.throws(
    () => getPublicRulingModelCapabilities({
      PUBLIC_RULING_MODEL_PROFILE: RELAY_PROFILE_ID,
      RELAY_API_KEY: "relay-issued-key",
      PUBLIC_RELAY_ENABLED: "true",
    }),
    /Unsupported public ruling model profile/u,
  );
});

test("public answer environment rejects relay even when relay credentials exist", () => {
  assert.throws(
    () => createPublicAnswerModelEnv({
      OPENAI_API_KEY: "official-key-must-not-be-used",
      RELAY_API_KEY: "relay-issued-key",
      PUBLIC_RELAY_ENABLED: "true",
      DEEPSEEK_API_KEY: "evidence-key",
    }, RELAY_PROFILE_ID),
    /Unsupported public ruling model profile/u,
  );

  const nonRelayEnv = createPublicAnswerModelEnv({
    GLM_API_KEY: "glm-key",
    RELAY_API_KEY: "relay-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
  });
  assert.equal(nonRelayEnv.RELAY_API_KEY, undefined);
  assert.equal(nonRelayEnv.RELAY_BASE_URL, undefined);
});

test("relay final ruling uses one synchronous Chat Completions request with the relay-only contract", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "只输出裁定 JSON",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RAG_REASONING_EFFORT: "high",
      RELAY_MAX_COMPLETION_TOKENS: "512",
      RELAY_ESTIMATED_CNY_PER_CALL: "0.25",
      API_DAILY_BUDGET_CNY: "10",
      API_BUDGET_TIMEZONE: "Pacific/Kiritimati",
    },
    now: new Date("2039-01-01T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        id: "relay-response-1",
        model: "gpt-5.6-sol",
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify(modelJson("Relay JSON OK")) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer relay-issued-key");
  assert.deepEqual(calls[0].body, {
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "只输出裁定 JSON" }],
    stream: false,
    response_format: { type: "json_object" },
    reasoning_effort: "high",
    max_completion_tokens: 512,
  });
  assert.equal(Object.hasOwn(calls[0].body, "tools"), false);
  assert.equal(Object.hasOwn(calls[0].body, "background"), false);
  assert.equal(Object.hasOwn(calls[0].body, "store"), false);
  assert.equal(Object.hasOwn(calls[0].body, "thinking"), false);
  assert.equal(result.providerUsed, "relay");
  assert.equal(result.modelUsed, "gpt-5.6-sol");
  assert.equal(result.answer.shortAnswer, "Relay JSON OK");
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:relay");
  assert.equal(result.estimatedCostCny, 0.25);
  assert.ok(result.warnings.includes("third_party_relay_model_identity_unverified"));
});

test("relay uses a conservative one-call default against the existing daily budget", async () => {
  const env = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2040-01-01T00:00:00.000Z");
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({
      model: "gpt-5.6-sol",
      choices: [{ message: { content: JSON.stringify(modelJson("Budgeted relay OK")) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  };

  const first = await callRagModel({ prompt: "第一次", env, now, fetchImpl });
  const second = await callRagModel({ prompt: "第二次", env, now, fetchImpl });

  assert.equal(fetchCount, 1);
  assert.equal(first.estimatedCostCny, 10);
  assert.equal(first.budgetStatus.bucket.id, "final_ruling:relay");
  assert.equal(second.answer.answerLevel, "budget_limited");
});

test("relay rejects an insecure endpoint before fetch and never falls back to an OpenAI key", async () => {
  assert.deepEqual(resolveRagProvider({
    MODEL_PROVIDER: "relay",
    OPENAI_API_KEY: "official-key",
  }), {
    provider: "mock",
    requested: "relay",
    warnings: ["relay_api_key_missing_using_mock"],
  });

  let fetchCount = 0;
  const result = await callRagModel({
    prompt: "输出 JSON",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "http://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      API_DAILY_BUDGET_CNY: "20",
      API_BUDGET_TIMEZONE: "Etc/GMT+12",
    },
    now: new Date("2039-01-02T00:00:00.000Z"),
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({});
    },
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.providerUsed, "relay");
  assert.equal(result.answer.answerLevel, "needs_more_info");
  assert.ok(result.warnings.some((warning) => /RELAY_BASE_URL must use HTTPS/u.test(warning)));
});

function modelJson(shortAnswer) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer,
    reasoning: ["基于冻结证据进行分析。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
