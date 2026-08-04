import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/answer.js";
import { PREVIOUS_RULING_WARNING } from "../backend/rulingVersionRegistry.mjs";

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

test("api_answer_reports_engine_availability_from_backend_configuration", async () => {
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
      {
        id: "previous",
        label: "上一版（兼容）",
        revision: "4de792b8a",
        legacyCompatibility: true,
        warning: PREVIOUS_RULING_WARNING,
      },
    ]);

    process.env.OCG_ENGINE_URL = "https://engine.example.test";
    const enabled = createJsonResponse();
    await handler({ method: "GET" }, enabled);
    assert.equal(enabled.payload.engineEnabled, true);

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

test("api_answer_exposes only the two public ruling profiles and rejects unknown profiles", async () => {
  const previousGlm = process.env.GLM_API_KEY;
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const info = createJsonResponse();
    await handler({ method: "GET" }, info);
    assert.equal(info.payload.defaultRulingModelProfile, "glm-5.2-high");
    assert.deepEqual(info.payload.rulingModelProfiles.map((profile) => ({
      id: profile.id,
      available: profile.available,
    })), [
      { id: "glm-5.2-high", available: true },
      { id: "deepseek-v4-flash-high", available: true },
    ]);
    assert.equal(info.payload.answerLatency.storage, "unconfigured");
    assert.deepEqual(info.payload.rulingModelProfiles.map((profile) => ({
      id: profile.id,
      status: profile.answerLatency.status,
      averageMs: profile.answerLatency.averageMs,
    })), [
      { id: "glm-5.2-high", status: "unavailable", averageMs: null },
      { id: "deepseek-v4-flash-high", status: "unavailable", averageMs: null },
    ]);

    const invalid = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "问题", rulingModelProfile: "arbitrary-provider-model" },
    }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.payload.code, "invalid_ruling_model_profile");
  } finally {
    if (previousGlm === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = previousGlm;
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
  }
});

test("api_answer GET returns real rolling latency for each available profile", async () => {
  const restore = captureEnvironment([
    "GLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_URL",
    "PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN",
  ]);
  const originalFetch = globalThis.fetch;
  const requestedProfiles = [];
  const timestamp = Date.now();
  try {
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_URL = "https://latency.example.test";
    process.env.PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN = "test-token";
    globalThis.fetch = async (_url, options) => {
      const command = JSON.parse(options.body);
      assert.equal(command[0], "LRANGE");
      requestedProfiles.push(command[1].split(":").at(-1));
      return redisJsonResponse(command[1].endsWith(":glm-5.2-high")
        ? [`${timestamp}:60000`, `${timestamp - 10}:90000`]
        : [`${timestamp}:30000`]);
    };

    const response = createJsonResponse();
    await handler({ method: "GET" }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedProfiles.sort(), ["deepseek-v4-flash-high", "glm-5.2-high"]);
    assert.equal(response.payload.answerLatency.storage, "redis");
    assert.deepEqual(response.payload.rulingModelProfiles.map((profile) => ({
      id: profile.id,
      status: profile.answerLatency.status,
      averageMs: profile.answerLatency.averageMs,
      sampleCount: profile.answerLatency.sampleCount,
    })), [
      { id: "glm-5.2-high", status: "available", averageMs: 75000, sampleCount: 2 },
      { id: "deepseek-v4-flash-high", status: "available", averageMs: 30000, sampleCount: 1 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
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
      body: { question: "", rulingModelProfile: "glm-5.2-high" },
    }, response).finally(() => {
      handlerSettled = true;
    });

    await waitFor(() => response.payload !== null && typeof releaseRedis === "function");
    assert.equal(response.statusCode, 200);
    assert.equal(handlerSettled, false);
    assert.equal(latencyCommand[0], "EVAL");
    assert.match(latencyCommand[3], /rag-public-answer-latency:v1:glm-5\.2-high/u);

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

test("api_answer_dispatches_previous_and_rejects_invalid_ruling_versions", async () => {
  const previousProvider = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "mock";
  try {
    const previous = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "", rulingVersion: "previous" },
    }, previous);
    assert.equal(previous.statusCode, 200);
    assert.equal(previous.payload.requestedRulingVersion, "previous");
    assert.equal(previous.payload.effectiveRulingVersion, "previous");
    assert.equal(previous.payload.rulingVersion, "previous");
    assert.equal(previous.payload.legacyCompatibility, true);
    assert.deepEqual(previous.payload.versionWarnings, [PREVIOUS_RULING_WARNING]);

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
    body: { question: "", mode: "legacy", rulingVersion: "previous" },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "unsupported_answer_mode");
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
