import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/answer.js";
import {
  PUBLIC_ANSWER_QUESTION_LIMIT_CHARACTERS,
  PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES,
} from "../backend/publicAnswerService.mjs";

test("api_answer_defaults_to_rag_baseline", async () => {
  const previousProvider = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "mock";
  try {
    const response = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "「宇宙耀变龙」的效果能否结算？" },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.mode, "rag_baseline");
    assert.equal(response.payload.debug.providerUsed, "mock");
    assert.equal(response.payload.requestedRulingVersion, "latest");
    assert.equal(response.payload.effectiveRulingVersion, "latest");
    assert.equal(response.payload.rulingVersion, "latest");
  } finally {
    if (previousProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = previousProvider;
  }
});

test("api_answer reports the public raw-evidence path with engine disabled", async () => {
  const previousUrl = process.env.OCG_ENGINE_URL;
  const previousAuto = process.env.RAG_AUTO_ENGINE_SIMULATION;
  try {
    delete process.env.OCG_ENGINE_URL;
    delete process.env.RAG_AUTO_ENGINE_SIMULATION;
    const disabled = createJsonResponse();
    await handler({ method: "GET" }, disabled);
    assert.equal(disabled.payload.engineEnabled, false);
    assert.equal(disabled.payload.defaultRulingVersion, "latest");
    assert.deepEqual(disabled.payload.rulingVersions, [
      { id: "latest", label: "最新版", revision: null, legacyCompatibility: false },
    ]);

    process.env.OCG_ENGINE_URL = "https://engine.example.test";
    const enabled = createJsonResponse();
    await handler({ method: "GET" }, enabled);
    assert.equal(enabled.payload.engineEnabled, false);

    process.env.RAG_AUTO_ENGINE_SIMULATION = "false";
    const optedOut = createJsonResponse();
    await handler({ method: "GET" }, optedOut);
    assert.equal(optedOut.payload.engineEnabled, false);
  } finally {
    if (previousUrl === undefined) delete process.env.OCG_ENGINE_URL;
    else process.env.OCG_ENGINE_URL = previousUrl;
    if (previousAuto === undefined) delete process.env.RAG_AUTO_ENGINE_SIMULATION;
    else process.env.RAG_AUTO_ENGINE_SIMULATION = previousAuto;
  }
});

test("api_answer defaults to Sol low and keeps DeepSeek as an optional fallback", async () => {
  const restore = captureEnvironment([
    "GLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "RELAY_API_KEY",
    "RELAY_BASE_URL",
    "PUBLIC_RULING_MODEL_PROFILE",
  ]);
  try {
    delete process.env.PUBLIC_RULING_MODEL_PROFILE;
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.RELAY_API_KEY = "test-relay-key";
    process.env.RELAY_BASE_URL = "https://relay.example.test/v1";
    const info = createJsonResponse();
    await handler({ method: "GET" }, info);
    assert.equal(info.payload.defaultRulingModelProfile, "relay-gpt-5.6-sol-low");
    assert.deepEqual(info.payload.rulingModelProfiles.map((profile) => ({
      id: profile.id,
      available: profile.available,
    })), [
      { id: "relay-gpt-5.6-luna-low", available: true },
      { id: "relay-gpt-5.6-sol-low", available: true },
      { id: "deepseek-v4-flash-standard", available: true },
      { id: "deepseek-v4-flash-low", available: true },
      { id: "deepseek-v4-flash-high", available: true },
      { id: "deepseek-v4-flash-max", available: true },
    ]);
    const defaultProfile = info.payload.rulingModelProfiles.find(
      (profile) => profile.id === info.payload.defaultRulingModelProfile,
    );
    assert.equal(defaultProfile.provider, "relay");
    assert.equal(defaultProfile.model, "gpt-5.6-sol");
    assert.equal(defaultProfile.reasoningEffort, "low");
    assert.equal(defaultProfile.thirdParty, true);
    assert.equal(defaultProfile.modelIdentityVerified, false);
    assert.doesNotMatch(JSON.stringify(info.payload), /test-relay-key|relay\.example/u);
    assert.equal(info.payload.answerLatency.storage, "unconfigured");
    assert.deepEqual(info.payload.rulingModelProfiles.map((profile) => ({
      id: profile.id,
      status: profile.answerLatency?.status || "unavailable",
      averageMs: profile.answerLatency?.averageMs ?? null,
    })), [
      { id: "relay-gpt-5.6-luna-low", status: "unavailable", averageMs: null },
      { id: "relay-gpt-5.6-sol-low", status: "unavailable", averageMs: null },
      { id: "deepseek-v4-flash-standard", status: "unavailable", averageMs: null },
      { id: "deepseek-v4-flash-low", status: "unavailable", averageMs: null },
      { id: "deepseek-v4-flash-high", status: "unavailable", averageMs: null },
      { id: "deepseek-v4-flash-max", status: "unavailable", averageMs: null },
    ]);

    assert.equal(info.payload.rulingModelProfiles.some((profile) => profile.provider === "glm"), false);
    assert.equal(info.payload.rulingModelProfiles.some((profile) => profile.provider === "kimi"), false);

    const retiredGlm = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "问题", rulingModelProfile: "glm-5.2-high" },
    }, retiredGlm);
    assert.equal(retiredGlm.statusCode, 400);
    assert.equal(retiredGlm.payload.code, "invalid_ruling_model_profile");

    const invalid = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "问题", rulingModelProfile: "arbitrary-provider-model" },
    }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.payload.code, "invalid_ruling_model_profile");
  } finally {
    restore();
  }
});

test("api_answer rejects a retired relay server default instead of silently falling back", async () => {
  const restore = captureEnvironment([
    "MODEL_PROVIDER",
    "PUBLIC_RULING_MODEL_PROFILE",
  ]);
  process.env.MODEL_PROVIDER = "mock";
  process.env.PUBLIC_RULING_MODEL_PROFILE = "relay-gpt-5.6-sol-high";
  try {
    const response = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "测试服务器默认裁定模型。" },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.code, "invalid_ruling_model_profile");
  } finally {
    restore();
  }
});

test("api_answer GET returns real rolling latency for each available profile", async () => {
  const restore = captureEnvironment([
    "GLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "RELAY_API_KEY",
    "RELAY_BASE_URL",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_URL",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN",
  ]);
  const originalFetch = globalThis.fetch;
  const requestedProfiles = [];
  const timestamp = Date.now();
  try {
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.RELAY_API_KEY = "test-relay-key";
    process.env.RELAY_BASE_URL = "https://relay.example.test/v1";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_URL = "https://latency.example.test";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN = "test-token";
    globalThis.fetch = async (_url, options) => {
      const command = JSON.parse(options.body);
      assert.equal(command[0], "LRANGE");
      requestedProfiles.push(command[1].split(":").at(-1));
      return redisJsonResponse([`${timestamp}:30000`]);
    };

    const response = createJsonResponse();
    await handler({ method: "GET" }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedProfiles, [
      "relay-gpt-5.6-luna-low",
      "relay-gpt-5.6-sol-low",
      "deepseek-v4-flash-standard",
      "deepseek-v4-flash-low",
      "deepseek-v4-flash-high",
      "deepseek-v4-flash-max",
    ]);
    assert.equal(response.payload.answerLatency.storage, "redis");
    assert.deepEqual(response.payload.rulingModelProfiles.map((profile) => ({
      id: profile.id,
      status: profile.answerLatency?.status || "unavailable",
      averageMs: profile.answerLatency?.averageMs ?? null,
      sampleCount: profile.answerLatency?.sampleCount || 0,
    })), [
      { id: "relay-gpt-5.6-luna-low", status: "available", averageMs: 30000, sampleCount: 1 },
      { id: "relay-gpt-5.6-sol-low", status: "available", averageMs: 30000, sampleCount: 1 },
      { id: "deepseek-v4-flash-standard", status: "available", averageMs: 30000, sampleCount: 1 },
      { id: "deepseek-v4-flash-low", status: "available", averageMs: 30000, sampleCount: 1 },
      { id: "deepseek-v4-flash-high", status: "available", averageMs: 30000, sampleCount: 1 },
      { id: "deepseek-v4-flash-max", status: "available", averageMs: 30000, sampleCount: 1 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("api_answer rejects retired public relay settings even when the relay key is present", async () => {
  const restore = captureEnvironment([
    "PUBLIC_RULING_MODEL_PROFILE",
    "PUBLIC_RELAY_ENABLED",
    "RELAY_API_KEY",
    "GLM_API_KEY",
    "DEEPSEEK_API_KEY",
  ]);
  try {
    process.env.PUBLIC_RULING_MODEL_PROFILE = "relay-gpt-5.6-sol-high";
    process.env.PUBLIC_RELAY_ENABLED = "true";
    process.env.RELAY_API_KEY = "test-relay-key";
    delete process.env.GLM_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    await assert.rejects(
      () => handler({ method: "GET" }, createJsonResponse()),
      /Unsupported public ruling model profile/u,
    );

    const response = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "问题", rulingModelProfile: "relay-gpt-5.6-sol-high" },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.code, "invalid_ruling_model_profile");
  } finally {
    restore();
  }
});

test("api_answer sends a successful answer before best-effort latency storage finishes", async () => {
  const restore = captureEnvironment([
    "MODEL_PROVIDER",
    "QUERY_AUDIT_ENABLED",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_URL",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN",
  ]);
  const originalFetch = globalThis.fetch;
  let releaseRedis;
  let latencyCommand = null;
  let handlerSettled = false;
  try {
    process.env.MODEL_PROVIDER = "mock";
    process.env.QUERY_AUDIT_ENABLED = "false";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_URL = "https://latency.example.test";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN = "test-token";
    globalThis.fetch = async (_url, options) => {
      latencyCommand = JSON.parse(options.body);
      return new Promise((resolve) => {
        releaseRedis = () => resolve(redisJsonResponse([]));
      });
    };

    const response = createJsonResponse();
    const handlerPromise = handler({
      method: "POST",
      body: { question: "测试延迟记录。", rulingModelProfile: "deepseek-v4-flash-high" },
    }, response).finally(() => {
      handlerSettled = true;
    });

    await waitFor(() => response.payload !== null && typeof releaseRedis === "function");
    assert.equal(response.statusCode, 200);
    assert.equal(handlerSettled, false);
    assert.equal(latencyCommand[0], "EVAL");
    assert.match(latencyCommand[3], /rag-public-answer-latency:v1:deepseek-v4-flash-high/u);

    releaseRedis();
    await handlerPromise;
    assert.equal(handlerSettled, true);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("api_answer never records latency for a failed public request", async () => {
  const restore = captureEnvironment([
    "MODEL_PROVIDER",
    "QUERY_AUDIT_ENABLED",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_URL",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN",
  ]);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    process.env.MODEL_PROVIDER = "mock";
    process.env.QUERY_AUDIT_ENABLED = "false";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_URL = "https://latency.example.test";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN = "test-token";
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return redisJsonResponse([]);
    };

    const response = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "问题", mode: "legacy" },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("api_answer rejects removed and invalid ruling versions", async () => {
  const previousProvider = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "mock";
  try {
    const previous = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "测试旧版本。", rulingVersion: "previous" },
    }, previous);
    assert.equal(previous.statusCode, 400);
    assert.equal(previous.payload.code, "invalid_ruling_version");

    const invalid = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "问题", rulingVersion: "archived" },
    }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.payload.code, "invalid_ruling_version");
  } finally {
    if (previousProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = previousProvider;
  }
});

test("legacy answer modes are no longer exposed by the public API", async () => {
  const response = createJsonResponse();
  await handler({
    method: "POST",
    body: { question: "测试旧模式。", mode: "legacy", rulingVersion: "previous" },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "unsupported_answer_mode");
});

test("api_answer rejects empty and malformed JSON bodies with 400", async () => {
  for (const body of [undefined, "", "{not-json", {}, { question: "   " }]) {
    const response = createJsonResponse();
    await handler({ method: "POST", body }, response);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.match(response.payload.code, /^(?:empty_request_body|invalid_json|invalid_question)$/u);
  }
});

test("api_answer applies the same byte and question limits to parsed Vercel bodies", async () => {
  const oversizedByHeader = createJsonResponse();
  await handler({
    method: "POST",
    headers: { "content-length": String(PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES + 1) },
    body: { question: "问题" },
  }, oversizedByHeader);
  assert.equal(oversizedByHeader.statusCode, 413);
  assert.equal(oversizedByHeader.payload.code, "request_body_too_large");

  const oversizedQuestion = createJsonResponse();
  await handler({
    method: "POST",
    body: { question: "问".repeat(PUBLIC_ANSWER_QUESTION_LIMIT_CHARACTERS + 1) },
  }, oversizedQuestion);
  assert.equal(oversizedQuestion.statusCode, 413);
  assert.equal(oversizedQuestion.payload.code, "question_too_long");
});

function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

function redisJsonResponse(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
  };
}

function captureEnvironment(keys) {
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitFor(predicate, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
}
