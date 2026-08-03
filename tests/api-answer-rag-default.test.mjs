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
