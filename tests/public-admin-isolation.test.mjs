import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import answerHandler from "../api/answer.js";
import { createAdminAuthHandler } from "../api/admin-auth.js";
import {
  createAdminSessionManager,
  createMemoryAdminSessionStore,
} from "../backend/adminSession.mjs";
import { createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";

test("admin query parameter cannot create an authenticated admin session", async () => {
  const origin = "https://admin.example.test";
  const env = {
    ADMIN_ALLOWED_ORIGIN: origin,
    ADMIN_SESSION_PASSWORD: "test-admin-password",
  };
  const handler = createAdminAuthHandler({
    manager: createAdminSessionManager({
      env,
      store: createMemoryAdminSessionStore(),
    }),
  });
  const response = createJsonResponse();

  await handler({
    method: "GET",
    url: "/api/admin-auth?admin=1&password=test-admin-password",
    headers: { origin },
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(response.payload.authenticated, false);
  assert.equal(response.payload.error, "admin_session_required");
  assert.equal(response.headers["set-cookie"], undefined);
});

test("public answer payload cannot select an admin-only provider or depend on OpenAI availability", async () => {
  const envKeys = [
    "MODEL_PROVIDER",
    "RAG_MODEL_PROVIDER",
    "RAG_CARD_MODEL_PROVIDER",
    "RAG_RULE_MODEL_PROVIDER",
    "RAG_RULEBOOK_MODEL_PROVIDER",
    "OPENAI_API_KEY",
    "QUERY_AUDIT_ENABLED",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let openAiCalls = 0;

  process.env.MODEL_PROVIDER = "mock";
  process.env.RAG_MODEL_PROVIDER = "mock";
  process.env.RAG_CARD_MODEL_PROVIDER = "mock";
  process.env.RAG_RULE_MODEL_PROVIDER = "mock";
  process.env.RAG_RULEBOOK_MODEL_PROVIDER = "mock";
  process.env.OPENAI_API_KEY = "unavailable-test-key";
  process.env.QUERY_AUDIT_ENABLED = "false";
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input || "");
    if (/openai/iu.test(url)) {
      openAiCalls += 1;
      throw new Error("simulated OpenAI outage");
    }
    return new Response(JSON.stringify({ result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = createJsonResponse();
    await answerHandler({
      method: "POST",
      url: "/api/answer?admin=1",
      headers: { origin: "https://public.example.test" },
      body: {
        question: "「宇宙耀变龙」的效果能否结算？",
        mode: "rag",
        provider: "openai",
        modelProvider: "openai",
        modelTier: "openai",
        admin: true,
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.mode, "rag_baseline");
    assert.equal(response.payload.debug.providerUsed, "mock");
    assert.equal(openAiCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("public model environment pins the selected final profile and keeps preparation on DeepSeek", () => {
  const publicEnv = createPublicAnswerModelEnv({
    MODEL_PROVIDER: "openai",
    RAG_MODEL_PROVIDER: "gemini",
    OPENAI_API_KEY: "server-admin-key",
    OPENAI_MODEL: "gpt-admin",
    OPENAI_BASE_URL: "https://openai.example.test",
    ADMIN_OPENAI_ENABLED: "true",
    ADMIN_OPENAI_BASE_URL: "https://admin-openai.example.test",
    ADMIN_MODEL_LAB_ENABLED: "true",
    GLM_API_KEY: "admin-glm-key",
    GLM_BASE_URL: "https://glm.example.test",
    KIMI_API_KEY: "admin-kimi-key",
    KIMI_BASE_URL: "https://kimi.example.test",
    DEEPSEEK_API_KEY: "public-deepseek-key",
  });

  assert.equal(publicEnv.MODEL_PROVIDER, "glm");
  assert.equal(publicEnv.RAG_MODEL_PROVIDER, "glm");
  assert.equal(publicEnv.RAG_MODEL, "glm-5.2");
  assert.equal(publicEnv.RAG_THINKING_MODE, "enabled");
  assert.equal(publicEnv.RAG_REASONING_EFFORT, "high");
  assert.equal(publicEnv.RAG_CARD_MODEL_PROVIDER, "deepseek");
  assert.equal(publicEnv.RAG_RULE_MODEL_PROVIDER, "deepseek");
  assert.equal(publicEnv.RAG_RULEBOOK_MODEL_PROVIDER, "deepseek");
  assert.equal(Object.keys(publicEnv).some((key) => /^(?:OPENAI_|ADMIN_|KIMI_)/iu.test(key)), false);
  assert.equal(publicEnv.GLM_API_KEY, "admin-glm-key");
  assert.equal(publicEnv.DEEPSEEK_API_KEY, "public-deepseek-key");

  const deepSeekEnv = createPublicAnswerModelEnv({
    GLM_API_KEY: "glm-key",
    DEEPSEEK_API_KEY: "deepseek-key",
  }, "deepseek-v4-flash-high");
  assert.equal(deepSeekEnv.RAG_MODEL_PROVIDER, "deepseek");
  assert.equal(deepSeekEnv.RAG_MODEL, "deepseek-v4-flash");
  assert.equal(deepSeekEnv.RAG_MODEL_TIER, "flash");

  const mockEnv = createPublicAnswerModelEnv({
    MODEL_PROVIDER: "mock",
    OPENAI_API_KEY: "server-admin-key",
  });
  assert.equal(mockEnv.MODEL_PROVIDER, "mock");
  assert.equal(mockEnv.RAG_MODEL_PROVIDER, "mock");
  assert.equal(mockEnv.OPENAI_API_KEY, undefined);
});

test("public legacy and fastjudge modes are rejected before any admin OpenAI call", async () => {
  const envKeys = [
    "MODEL_PROVIDER",
    "RAG_MODEL_PROVIDER",
    "RAG_CARD_MODEL_PROVIDER",
    "RAG_RULE_MODEL_PROVIDER",
    "RAG_RULEBOOK_MODEL_PROVIDER",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_PARSER_MODEL",
    "OPENAI_JUDGE_MODEL",
    "QUERY_AUDIT_ENABLED",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let openAiCalls = 0;

  for (const key of envKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = "admin-only-openai-key";
  process.env.OPENAI_MODEL = "gpt-admin-only";
  process.env.OPENAI_PARSER_MODEL = "gpt-admin-parser";
  process.env.OPENAI_JUDGE_MODEL = "gpt-admin-judge";
  process.env.QUERY_AUDIT_ENABLED = "false";
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input || "");
    if (/api\.openai\.com/iu.test(url)) openAiCalls += 1;
    return new Response(JSON.stringify({ result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    for (const mode of ["legacy", "fastjudge"]) {
      const response = createJsonResponse();
      await answerHandler({
        method: "POST",
        url: "/api/answer",
        headers: { origin: "https://public.example.test" },
        body: {
          question: "测试卡在这个场合是否可以发动？",
          mode,
        },
      }, response);
      assert.equal(response.statusCode, 400, mode);
      assert.equal(response.payload?.code, "unsupported_answer_mode", mode);
    }
    assert.equal(openAiCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("local Node public entry point applies the same public model boundary", async () => {
  const source = await readFile(new URL("../backend/server.mjs", import.meta.url), "utf8");
  assert.match(source, /createPublicAnswerModelEnv\(process\.env, profile\.id\)/u);
  assert.match(source, /resolvePublicRulingModelProfile\(payload\.rulingModelProfile\)/u);
  assert.match(source, /if \(mode !== "rag"\)[\s\S]*?unsupported_answer_mode/u);
  assert.match(source, /answerRagRulingQuestionForVersion\(\{[\s\S]*?env:\s*publicEnv,/u);
  assert.doesNotMatch(source, /payload\.(?:thinkingMode|reasoningEffort|modelTier)/u);
  assert.doesNotMatch(source, /answerQuestion\(payload|answerRulingQuestionFast/u);
});

function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
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
