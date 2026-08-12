import assert from "node:assert/strict";
import test from "node:test";

import {
  callRagModel,
  createPublicAnswerModelEnv,
  getRagBudgetStatus,
  resolveRagProvider,
} from "../backend/ragModelClient.mjs";
import {
  getPublicRulingModelCapabilities,
  publicRulingModelProfileAvailable,
} from "../backend/publicRulingModelConfig.mjs";

const RELAY_PROFILE_ID = "relay-gpt-5.6-luna-low";
const DEFAULT_RELAY_PROFILE_ID = "relay-gpt-5.6-sol-low";

test("public Luna relay profile requires both a key and an HTTPS endpoint", () => {
  const unavailable = getPublicRulingModelCapabilities({
    RELAY_API_KEY: "relay-issued-key",
  });
  assert.deepEqual(
    unavailable.rulingModelProfiles.map((profile) => [profile.id, profile.available]),
    [
      [RELAY_PROFILE_ID, false],
      ["relay-gpt-5.6-sol-low", false],
      ["deepseek-v4-flash-standard", false],
      ["deepseek-v4-flash-low", false],
      ["deepseek-v4-flash-high", false],
      ["deepseek-v4-flash-max", false],
    ],
  );
  assert.equal(publicRulingModelProfileAvailable(RELAY_PROFILE_ID, {
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "http://relay.example.test/v1",
  }), false);
  assert.equal(publicRulingModelProfileAvailable(RELAY_PROFILE_ID, {
    RELAY_BASE_URL: "https://relay.example.test/v1",
  }), false);
  for (const invalidBaseUrl of [
    "https://user:pass@relay.example.test/v1",
    "https://relay.example.test/v1?tenant=public",
    "https://relay.example.test/v1#fragment",
  ]) {
    assert.equal(publicRulingModelProfileAvailable(RELAY_PROFILE_ID, {
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: invalidBaseUrl,
    }), false);
  }
  assert.equal(publicRulingModelProfileAvailable(RELAY_PROFILE_ID, {
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1/chat/completions/",
  }), true);

  const configured = getPublicRulingModelCapabilities({
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    DEEPSEEK_API_KEY: "deepseek-key",
  });
  assert.equal(configured.defaultRulingModelProfile, DEFAULT_RELAY_PROFILE_ID);
  assert.deepEqual(configured.rulingModelProfiles.map((profile) => ({
    id: profile.id,
    available: profile.available,
    model: profile.model,
    thinkingMode: profile.thinkingMode,
    reasoningEffort: profile.reasoningEffort,
    transport: profile.transport,
  })), [
    {
      id: RELAY_PROFILE_ID,
      available: true,
      model: "gpt-5.6-luna",
      thinkingMode: "enabled",
      reasoningEffort: "low",
      transport: "chat_completions_sse",
    },
    {
      id: "relay-gpt-5.6-sol-low",
      available: true,
      model: "gpt-5.6-sol",
      thinkingMode: "enabled",
      reasoningEffort: "low",
      transport: "chat_completions_sse",
    },
    {
      id: "deepseek-v4-flash-standard",
      available: true,
      model: "deepseek-v4-flash",
      thinkingMode: "disabled",
      reasoningEffort: null,
      transport: "chat_completions",
    },
    {
      id: "deepseek-v4-flash-low",
      available: true,
      model: "deepseek-v4-flash",
      thinkingMode: "enabled",
      reasoningEffort: "low",
      transport: "chat_completions",
    },
    {
      id: "deepseek-v4-flash-high",
      available: true,
      model: "deepseek-v4-flash",
      thinkingMode: "enabled",
      reasoningEffort: "high",
      transport: "chat_completions",
    },
    {
      id: "deepseek-v4-flash-max",
      available: true,
      model: "deepseek-v4-flash",
      thinkingMode: "enabled",
      reasoningEffort: "max",
      transport: "chat_completions",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(configured), /relay-issued-key|relay\.example/u);
});

test("server accepts Luna low as the explicit public default", () => {
  const capabilities = getPublicRulingModelCapabilities({
    PUBLIC_RULING_MODEL_PROFILE: RELAY_PROFILE_ID,
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
  });
  assert.equal(capabilities.defaultRulingModelProfile, RELAY_PROFILE_ID);
  assert.equal(capabilities.rulingModelProfiles[0].available, true);
});

test("public answer environment isolates final Relay secrets while retaining internal applicability transport", () => {
  const relayEnv = createPublicAnswerModelEnv({
    OPENAI_API_KEY: "official-key-must-not-be-used",
    ADMIN_MODEL_LAB_PASSWORD: "admin-secret",
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    DEEPSEEK_API_KEY: "evidence-key",
  }, RELAY_PROFILE_ID);
  assert.equal(relayEnv.MODEL_PROVIDER, "relay");
  assert.equal(relayEnv.RAG_MODEL_PROVIDER, "relay");
  assert.equal(relayEnv.RAG_MODEL, "gpt-5.6-luna");
  assert.equal(relayEnv.RAG_REASONING_EFFORT, "low");
  assert.equal(relayEnv.RELAY_API_KEY, "relay-issued-key");
  assert.equal(relayEnv.RELAY_BASE_URL, "https://relay.example.test/v1");
  assert.equal(relayEnv.OPENAI_API_KEY, undefined);
  assert.equal(relayEnv.ADMIN_MODEL_LAB_PASSWORD, undefined);
  assert.equal(relayEnv.DEEPSEEK_API_KEY, "evidence-key");

  const nonRelayEnv = createPublicAnswerModelEnv({
    GLM_API_KEY: "glm-key",
    RELAY_API_KEY: "relay-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    DEEPSEEK_API_KEY: "deepseek-key",
  }, "deepseek-v4-flash-high");
  assert.equal(nonRelayEnv.RELAY_API_KEY, undefined);
  assert.equal(nonRelayEnv.RELAY_BASE_URL, undefined);
  assert.equal(nonRelayEnv.RAG_EVIDENCE_APPLICABILITY_RELAY_API_KEY, "relay-key");
  assert.equal(
    nonRelayEnv.RAG_EVIDENCE_APPLICABILITY_RELAY_BASE_URL,
    "https://relay.example.test/v1",
  );

  const standardEnv = createPublicAnswerModelEnv({ DEEPSEEK_API_KEY: "deepseek-key" }, "deepseek-v4-flash-standard");
  assert.equal(standardEnv.RAG_THINKING_MODE, "disabled");
  assert.equal(standardEnv.RAG_REASONING_EFFORT, null);

  const lowEnv = createPublicAnswerModelEnv({ DEEPSEEK_API_KEY: "deepseek-key" }, "deepseek-v4-flash-low");
  assert.equal(lowEnv.RAG_THINKING_MODE, "enabled");
  assert.equal(lowEnv.RAG_REASONING_EFFORT, "low");
});

test("relay final ruling uses one SSE Chat Completions request with the relay-only contract", async () => {
  const calls = [];
  const result = await callRagModel({
    prompt: "只输出裁定 JSON",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1/",
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
      return relaySseResponse({
        id: "relay-response-1",
        model: "gpt-5.6-sol",
        choices: [{
          index: 0,
          finish_reason: "stop",
          delta: { content: JSON.stringify(modelJson("Relay JSON OK")) },
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer relay-issued-key");
  assert.deepEqual(calls[0].body, {
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "只输出裁定 JSON" }],
    response_format: { type: "json_object" },
    reasoning_effort: "high",
    max_completion_tokens: 512,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(calls[0].options.headers.accept, "text/event-stream");
  assert.equal(Object.hasOwn(calls[0].body, "tools"), false);
  assert.equal(Object.hasOwn(calls[0].body, "background"), false);
  assert.equal(Object.hasOwn(calls[0].body, "store"), false);
  assert.equal(Object.hasOwn(calls[0].body, "thinking"), false);
  assert.equal(result.providerUsed, "relay");
  assert.equal(result.modelUsed, "gpt-5.6-sol");
  assert.equal(result.answer.shortAnswer, "Relay JSON OK");
  assert.equal(result.generationAttempts[0].finishReason, "stop");
  assert.equal(result.generationAttempts[0].usage.prompt_tokens, 100);
  assert.equal(result.generationAttempts[0].usage.completion_tokens, 50);
  assert.equal(result.budgetStatus.bucket.id, "final_ruling:relay");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd, 0.002);
  assert.equal(result.budgetStatus.spentTodayCny, 0);
  assert.equal(result.budgetStatus.bucket.currency, "USD");
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, 0.002);
  assert.equal(result.budgetStatus.bucket.dailyBudgetUsd, 10);
  assert.ok(result.warnings.includes("third_party_relay_model_identity_unverified"));
});

test("relay HTTP access denial is retained as a structured provider failure", async () => {
  const result = await callRagModel({
    prompt: "access denial must not become not JSON",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-01T00:00:00.000Z"),
    fetchImpl: async () => jsonResponse({
      error: { message: "无权访问 internal group", code: "group_access_denied" },
    }, 403),
  });

  assert.equal(result.rawText, "");
  assert.equal(result.providerFailure.kind, "access_denied");
  assert.equal(result.providerFailure.status, 403);
  assert.equal(result.providerFailure.code, "model_provider_access_denied");
  assert.equal(result.providerFailure.requestedModel, "gpt-5.6-sol");
  assert.equal(result.generationAttempts[0].providerFailure.kind, "access_denied");
  assert.equal(result.estimatedCostUsd, 0);
  assert.doesNotMatch(JSON.stringify(result), /internal group|group_access_denied/u);
});

test("relay rejects an embedded SSE error instead of returning empty assistant content", async () => {
  const result = await callRagModel({
    prompt: "embedded error must fail closed",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-02T00:00:00.000Z"),
    fetchImpl: async () => new Response(
      'event: error\ndata: {"error":{"message":"permission denied"}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  assert.equal(result.rawText, "");
  assert.equal(result.providerFailure.kind, "access_denied");
  assert.equal(result.providerFailure.code, "model_provider_access_denied");
  assert.equal(result.estimatedCostUsd, 0);
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, 0);
  assert.equal(result.warnings.includes("model_call_failed:model_provider_access_denied"), true);
  assert.doesNotMatch(JSON.stringify(result), /permission denied/u);
});

test("relay rejects unknown SSE events that never contain a completion payload", async () => {
  const result = await callRagModel({
    prompt: "unknown events must not become an empty completion",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-03T00:00:00.000Z"),
    fetchImpl: async () => new Response(
      'data: {"type":"response.created","response":{"id":"r1"}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  assert.equal(result.rawText, "");
  assert.equal(result.providerFailure.kind, "provider_failure");
  assert.equal(result.providerFailure.code, "model_provider_failure");
});

test("relay accepts ordinary SSE completion frames that include error null", async () => {
  const result = await callRagModel({
    prompt: "error null compatibility",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-05T00:00:00.000Z"),
    fetchImpl: async () => relaySseResponse({
      id: "error-null-frame",
      model: "gpt-5.6-sol",
      error: null,
      choices: [{
        index: 0,
        finish_reason: "stop",
        delta: { content: JSON.stringify(modelJson("error null OK")) },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }),
  });

  assert.equal(result.answer.shortAnswer, "error null OK");
  assert.equal(result.providerFailure, undefined);
});

test("relay classifies code-only pre-generation SSE access denial and releases its budget", async () => {
  const result = await callRagModel({
    prompt: "code-only access denial",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-06T00:00:00.000Z"),
    fetchImpl: async () => new Response(
      'data: {"message":"request rejected","code":"group_access_denied"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  assert.equal(result.providerFailure.kind, "access_denied");
  assert.equal(result.providerFailure.code, "model_provider_access_denied");
  assert.equal(result.estimatedCostUsd, 0);
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, 0);
  assert.doesNotMatch(JSON.stringify(result), /group_access_denied|request rejected/u);
});

test("relay retains budget after completion begins even if a later SSE frame denies access", async () => {
  const secretFinishReason = "internal-route-finish-reason";
  const result = await callRagModel({
    prompt: "late access denial",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-07T00:00:00.000Z"),
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({
        model: "gpt-5.6-sol",
        choices: [{ index: 0, finish_reason: secretFinishReason, delta: { content: "{" } }],
      })}\n\n`,
      'event: error\ndata: {"error":{"message":"permission denied"}}\n\n',
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });

  assert.equal(result.providerFailure.kind, "access_denied");
  assert.equal(result.providerFailure.finishReason, "other");
  assert.equal(result.estimatedCostUsd > 0, true);
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, result.estimatedCostUsd);
  assert.ok(result.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretFinishReason, "u"));
});

test("relay classifies HTTP timeout statuses and transport timeout codes without releasing budget", async () => {
  const baseEnv = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    API_BUDGET_TIMEZONE: "UTC",
  };
  for (const [index, status] of [408, 504, 524].entries()) {
    const result = await callRagModel({
      prompt: `HTTP ${status}`,
      env: baseEnv,
      now: new Date(`2043-02-0${index + 1}T00:00:00.000Z`),
      fetchImpl: async () => jsonResponse({ error: { message: "request failed" } }, status),
    });
    assert.equal(result.providerFailure.kind, "timeout");
    assert.equal(result.providerFailure.code, "model_provider_timeout");
    assert.equal(result.estimatedCostUsd > 0, true);
    assert.equal(result.budgetStatus.bucket.spentTodayUsd, result.estimatedCostUsd);
  }

  for (const [index, errorCode] of ["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].entries()) {
    const result = await callRagModel({
      prompt: errorCode,
      env: baseEnv,
      now: new Date(`2043-03-0${index + 1}T00:00:00.000Z`),
      fetchImpl: async () => {
        const error = new Error("request failed");
        error.code = errorCode;
        throw error;
      },
    });
    assert.equal(result.providerFailure.kind, "timeout");
    assert.equal(result.providerFailure.code, "model_provider_timeout");
    assert.equal(result.estimatedCostUsd > 0, true);
    assert.equal(result.budgetStatus.bucket.spentTodayUsd, result.estimatedCostUsd);
  }
});

test("relay accepts a single SSE Chat Completions message frame", async () => {
  const result = await callRagModel({
    prompt: "single frame compatibility",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2043-01-04T00:00:00.000Z"),
    fetchImpl: async () => relaySseResponse({
      id: "single-message-frame",
      model: "gpt-5.6-sol",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(modelJson("single frame OK")) },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }),
  });

  assert.equal(result.answer.shortAnswer, "single frame OK");
  assert.equal(result.generationAttempts[0].responseModel, "gpt-5.6-sol");
});

test("relay normalizes Responses-style usage without discounting public all-uncached pricing", async () => {
  const result = await callRagModel({
    prompt: "Responses usage normalization",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "128",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2042-01-01T00:00:00.000Z"),
    fetchImpl: async () => relaySseResponse({
      id: "relay-responses-usage",
      model: "gpt-5.6-sol",
      choices: [{
        index: 0,
        finish_reason: "stop",
        delta: { content: JSON.stringify(modelJson("Responses usage OK")) },
      }],
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        total_tokens: 280,
        input_tokens_details: { cached_tokens: 50 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    }),
  });

  assert.deepEqual(result.tokenUsage, {
    prompt_tokens: 200,
    completion_tokens: 80,
    total_tokens: 280,
    reasoning_tokens: 30,
    prompt_cache_hit_tokens: 50,
    prompt_cache_miss_tokens: 150,
    cache_write_tokens: 0,
  });
  assert.equal(result.generationAttempts[0].requestModel, "gpt-5.6-sol");
  assert.equal(result.generationAttempts[0].responseModel, "gpt-5.6-sol");
  assert.equal(result.generationAttempts[0].usage.prompt_tokens, 200);
  assert.equal(result.estimatedCostUsd, 0.0034);
});

test("public relay keeps the returned-model mismatch warning with an SSE response", async () => {
  const result = await callRagModel({
    prompt: "只输出裁定 JSON",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1/chat/completions/",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "128",
      RELAY_ESTIMATED_CNY_PER_CALL: "0.01",
      API_DAILY_BUDGET_CNY: "10",
      API_BUDGET_TIMEZONE: "Etc/GMT-14",
    },
    now: new Date("2041-01-01T00:00:00.000Z"),
    fetchImpl: async (url) => {
      assert.equal(url, "https://relay.example.test/v1/chat/completions");
      return relaySseResponse({
        id: "relay-response-mismatch",
        model: "gpt-5.6-terra",
        choices: [{
          index: 0,
          finish_reason: "stop",
          delta: { content: JSON.stringify(modelJson("Mismatch warning OK")) },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });

  assert.equal(result.answer.shortAnswer, "Mismatch warning OK");
  assert.ok(result.warnings.includes("relay_response_model_mismatch"));
});

test("relay default estimate allows multiple calls without exhausting the daily budget", async () => {
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
    return relaySseResponse({
      model: "gpt-5.6-sol",
      choices: [{
        index: 0,
        finish_reason: "stop",
        delta: { content: JSON.stringify(modelJson("Budgeted relay OK")) },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  };

  const first = await callRagModel({ prompt: "第一次", env, now, fetchImpl });
  const second = await callRagModel({ prompt: "第二次", env, now, fetchImpl });

  assert.equal(fetchCount, 2);
  assert.equal(first.estimatedCostCny, 0);
  assert.equal(first.estimatedCostUsd, 0.00035);
  assert.equal(first.budgetStatus.bucket.id, "final_ruling:relay");
  assert.equal(second.estimatedCostCny, 0);
  assert.equal(second.estimatedCostUsd, 0.00035);
  assert.equal(second.budgetStatus.spentTodayCny, 0);
  assert.equal(second.budgetStatus.bucket.spentTodayUsd, 0.0007);
  assert.notEqual(second.answer.answerLevel, "budget_limited");
});

test("relay keeps a conservative USD reservation when usage is omitted", async () => {
  const result = await callRagModel({
    prompt: "x",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2040-01-02T00:00:00.000Z"),
    fetchImpl: async () => relaySseResponse({
      model: "gpt-5.6-sol",
      choices: [{
        index: 0,
        finish_reason: "stop",
        delta: { content: JSON.stringify(modelJson("Usage omitted")) },
      }],
    }),
  });

  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd, 0.001925);
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, 0.001925);
});

test("relay retains its full USD reservation when usage has only a total without input/output", async () => {
  const result = await callRagModel({
    prompt: "x",
    env: {
      MODEL_PROVIDER: "relay",
      RELAY_API_KEY: "relay-issued-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
      RAG_MODEL: "gpt-5.6-sol",
      RELAY_MAX_COMPLETION_TOKENS: "64",
      API_BUDGET_TIMEZONE: "UTC",
    },
    now: new Date("2040-01-06T01:00:00.000Z"),
    fetchImpl: async () => relaySseResponse({
      model: "gpt-5.6-sol",
      choices: [{
        index: 0,
        finish_reason: "stop",
        delta: { content: JSON.stringify(modelJson("Usage has total only")) },
      }],
      usage: { total_tokens: 1 },
    }),
  });

  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd, 0.001925);
  assert.equal(result.budgetStatus.bucket.spentTodayUsd, 0.001925);
  assert.ok(result.warnings.includes("provider_usage_incomplete_reservation_retained"));
});

test("public ChatGPT USD pool is hard-capped at ten dollars independently of CNY", async () => {
  let fetchCount = 0;
  const env = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "400000",
    API_CHATGPT_DAILY_BUDGET_USD: "100",
    API_DAILY_BUDGET_CNY: "0.000001",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const now = new Date("2040-01-03T00:00:00.000Z");
  const result = await callRagModel({
    prompt: "must be blocked before transport",
    env,
    now,
    fetchImpl: async () => {
      fetchCount += 1;
      return relaySseResponse({});
    },
  });
  const status = await getRagBudgetStatus({ env, now });
  const chatGpt = status.buckets.find((bucket) => bucket.id === "final_ruling:relay");

  assert.equal(fetchCount, 0);
  assert.equal(result.answer.answerLevel, "budget_limited");
  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd > 10, true);
  assert.equal(chatGpt.dailyBudgetUsd, 10);
  assert.equal(status.dailyBudgetCny, 0.000001);
  assert.equal(status.spentTodayCny, 0);
});

test("relay failure paths retain or release only the USD reservation", async () => {
  const baseEnv = {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "relay-issued-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RELAY_MAX_COMPLETION_TOKENS: "64",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
  };
  const ambiguous = await callRagModel({
    prompt: "ambiguous dispatch",
    env: baseEnv,
    now: new Date("2040-01-04T00:00:00.000Z"),
    fetchImpl: async () => {
      throw new TypeError("network outcome unknown");
    },
  });
  const rejected = await callRagModel({
    prompt: "explicit rejection",
    env: baseEnv,
    now: new Date("2040-01-05T00:00:00.000Z"),
    fetchImpl: async () => jsonResponse({ error: "bad request" }, 400),
  });

  assert.equal(ambiguous.estimatedCostCny, 0);
  assert.equal(ambiguous.estimatedCostUsd > 0, true);
  assert.equal(ambiguous.budgetStatus.spentTodayCny, 0);
  assert.equal(ambiguous.budgetStatus.bucket.spentTodayUsd, ambiguous.estimatedCostUsd);
  assert.ok(ambiguous.warnings.includes("budget_reservation_retained_after_ambiguous_remote_failure"));
  assert.equal(rejected.estimatedCostCny, 0);
  assert.equal(rejected.estimatedCostUsd, 0);
  assert.equal(rejected.budgetStatus.spentTodayCny, 0);
  assert.equal(rejected.budgetStatus.bucket.spentTodayUsd, 0);
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
  assert.equal(result.providerFailure.code, "model_provider_failure");
  assert.ok(result.warnings.includes("model_call_failed:model_provider_failure"));
  assert.doesNotMatch(JSON.stringify(result), /RELAY_BASE_URL must use HTTPS/u);
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

function relaySseResponse(chunk) {
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
