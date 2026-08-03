import assert from "node:assert/strict";
import test from "node:test";
import {
  CompatibleEvidencePreparationProvider,
  ExistingDeepSeekProvider,
  OpenAIResponsesProvider,
  createEvidencePreparationProviderRegistry,
  extractOpenAIResponseOutputText,
} from "../backend/rulingModelProviders.mjs";
import { MODEL_RULING_COUNTER_CHECK_TYPES } from "../backend/modelRulingSchema.mjs";

test("OpenAI create uses background, store=false, strict schema and allowlisted selection", async () => {
  const calls = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: mockFetch(calls, { id: "resp_1", status: "queued" }),
  });
  const response = await provider.create({
    model: "gpt-5.6",
    reasoningEffort: "max",
    reasoningMode: "pro",
    instructions: "Use the supplied evidence.",
    input: "question and evidence",
    maxOutputTokens: 1800,
    metadata: {
      runId: "run-1",
      promptVersion: "openai-ruling-v1",
    },
    background: false,
    store: true,
  });

  assert.equal(response.id, "resp_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.background, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "max", mode: "pro" });
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "model_ruling_result");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(body.max_output_tokens, 1800);
  assert.equal(calls[0].options.headers.authorization, "Bearer server-secret");
});

test("OpenAI provider rejects arbitrary frontend model and unsupported parameters before fetch", async () => {
  const calls = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: mockFetch(calls, {}),
  });
  await assert.rejects(
    provider.create({
      model: "gpt-5.6-sol-injected",
      input: "x",
      metadata: { runId: "run", promptVersion: "v1" },
    }),
    (error) => error.code === "model_not_allowlisted",
  );
  await assert.rejects(
    provider.create({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      input: "x",
      metadata: { runId: "run", promptVersion: "v1" },
    }),
    (error) => error.code === "reasoning_effort_not_supported",
  );
  await assert.rejects(
    provider.create({
      model: "gpt-5.6-sol",
      input: "x",
      metadata: {},
    }),
    /metadata\.runId/u,
  );
  assert.equal(calls.length, 0);
});

test("OpenAI retrieve and cancel use the documented background endpoints", async () => {
  const calls = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ id: "resp_abc", status: options.method === "GET" ? "in_progress" : "cancelled" });
    },
  });

  assert.equal((await provider.retrieve("resp_abc")).status, "in_progress");
  assert.equal((await provider.cancel("resp_abc")).status, "cancelled");
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ["https://api.openai.com/v1/responses/resp_abc", "GET"],
    ["https://api.openai.com/v1/responses/resp_abc/cancel", "POST"],
  ]);
  await assert.rejects(provider.retrieve("../secret"), /valid OpenAI response ID/u);
});

test("OpenAI errors preserve useful status/code without exposing request secrets", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: async () => jsonResponse({
      error: {
        code: "model_not_found",
        message: "The requested model is unavailable.",
      },
    }, 404),
  });
  await assert.rejects(
    provider.create({
      model: "gpt-5.6-luna",
      input: "x",
      metadata: { runId: "run", promptVersion: "v1" },
    }),
    (error) => error.code === "model_not_found"
      && error.status === 404
      && error.outcomeKnown === true
      && !error.message.includes("server-secret"),
  );
});

test("OpenAI transport failures explicitly report an unknown submit outcome", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: async () => {
      throw new Error("socket closed after write");
    },
  });
  await assert.rejects(
    provider.create({
      model: "gpt-5.6-luna",
      input: "x",
      metadata: { runId: "run", promptVersion: "v1" },
    }),
    (error) => error.code === "openai_network_error"
      && error.status === null
      && error.outcomeKnown === false
      && !error.message.includes("server-secret"),
  );
});

test("ambiguous HTTP failures are outcome-unknown while provable 4xx rejection is known", async () => {
  for (const status of [408, 429, 500, 503]) {
    const provider = new OpenAIResponsesProvider({
      apiKey: "server-secret",
      fetchImpl: async () => jsonResponse({
        error: {
          code: `status_${status}`,
          message: `ambiguous ${status}`,
        },
      }, status),
    });
    await assert.rejects(
      provider.create({
        model: "gpt-5.6-luna",
        input: "x",
        metadata: { runId: "run", promptVersion: "v1" },
      }),
      (error) => error.status === status && error.outcomeKnown === false,
    );
  }

  const rejected = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: async () => jsonResponse({
      error: { code: "invalid_request", message: "invalid request" },
    }, 400),
  });
  await assert.rejects(
    rejected.create({
      model: "gpt-5.6-luna",
      input: "x",
      metadata: { runId: "run", promptVersion: "v1" },
    }),
    (error) => error.status === 400 && error.outcomeKnown === true,
  );
});

test("completed OpenAI output is extracted and validated without loose JSON repair", () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: mockFetch([], {}),
  });
  const structured = makeStructuredResult();
  const response = {
    id: "resp_1",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(structured) }],
      },
    ],
  };
  assert.equal(extractOpenAIResponseOutputText(response), JSON.stringify(structured));
  const validation = provider.validateCompletedResponse(response, {
    evidenceSnapshot: {
      selectedEvidence: [{ id: "faq-1", sourceType: "card_faq", text: "可以发动。" }],
    },
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("existing DeepSeek adapter remains evidence-only while Flash is the fixed preparation model", async () => {
  const invocations = [];
  const controller = new AbortController();
  const provider = new ExistingDeepSeekProvider({
    invoke: async (request) => {
      invocations.push(request);
      return { organizedEvidenceIds: ["faq-1"] };
    },
  });
  const prepared = await provider.prepareEvidence({
    model: "deepseek-v4-flash",
    input: { evidence: ["faq-1"] },
    metadata: { runId: "run-1" },
    signal: controller.signal,
  });
  assert.equal(prepared.canMakeFinalRuling, false);
  assert.equal(prepared.canDecideEscalation, false);
  assert.equal(invocations[0].purpose, "evidence_preparation");
  assert.equal(invocations[0].canMakeFinalRuling, false);
  assert.equal(invocations[0].signal, controller.signal);
  await assert.rejects(
    provider.runRuling({ input: "question" }),
    (error) => error.code === "deepseek_final_ruling_forbidden",
  );
});

test("DeepSeek V4 experimental finals send both the thinking toggle and effort", async () => {
  const calls = [];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "deepseek",
    apiKey: "deepseek-server-secret",
    fetchImpl: mockFetch(calls, {
      id: "deepseek-final-1",
      model: "deepseek-v4-pro",
      choices: [{ message: { content: JSON.stringify(makeStructuredResult()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  });
  await provider.create({
    model: "deepseek-v4-pro",
    reasoningEffort: "max",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-deepseek", promptVersion: "openai-ruling-v1" },
  });

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
  assert.equal((await provider.create({
    model: "deepseek-v4-flash",
    reasoningEffort: "none",
    reasoningMode: "standard",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-deepseek-standard", promptVersion: "openai-ruling-v1" },
  })).request_id_source, "upstream");
  const standardBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(standardBody.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(standardBody, "reasoning_effort"), false);
});

test("GLM compatible adapter emits an experimental final JSON result with filtered thinking controls", async () => {
  const calls = [];
  const controller = new AbortController();
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "glm",
    apiKey: "glm-server-secret",
    baseUrl: "https://glm.example/v4",
    fetchImpl: mockFetch(calls, {
      id: "glm-final-1",
      model: "glm-5.2",
      choices: [{ message: { content: JSON.stringify(makeStructuredResult()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  });
  const response = await provider.create({
    model: "glm-5.2",
    reasoningEffort: "high",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-1", promptVersion: "openai-ruling-v1" },
    maxOutputTokens: 700,
    signal: controller.signal,
  });
  assert.equal(response.status, "completed");
  assert.equal(response.experimental, true);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.max_tokens, 700);
  assert.equal(calls[0].options.headers.authorization, "Bearer glm-server-secret");
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(JSON.stringify(response).includes("glm-server-secret"), false);
});

test("Kimi K2.6 supports optional thinking while K3 uses its always-on reasoning effort", async () => {
  const calls = [];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "kimi",
    apiKey: "kimi-server-secret",
    fetchImpl: mockFetch(calls, {
      choices: [{ message: { content: "{}" } }],
      usage: {},
    }),
  });
  await provider.create({
    model: "kimi-k2.6",
    reasoningEffort: "none",
    reasoningMode: "standard",
    input: "final",
    instructions: "JSON only",
    metadata: { runId: "run-k2", promptVersion: "openai-ruling-v1" },
    maxOutputTokens: 800,
  });
  await provider.create({
    model: "kimi-k3",
    reasoningEffort: "max",
    reasoningMode: "pro",
    input: "final",
    instructions: "JSON only",
    metadata: { runId: "run-k3", promptVersion: "openai-ruling-v1" },
  });
  const k2Body = JSON.parse(calls[0].options.body);
  const k3Body = JSON.parse(calls[1].options.body);
  assert.deepEqual(k2Body.thinking, { type: "disabled" });
  assert.equal(k2Body.max_completion_tokens, 800);
  assert.equal(Object.hasOwn(k3Body, "thinking"), false);
  assert.equal(k3Body.reasoning_effort, "max");
  assert.match(calls[0].url, /^https:\/\/api\.moonshot\.cn\/v1\//u);
  await assert.rejects(
    provider.create({
      model: "kimi-k3",
      reasoningEffort: "max",
      reasoningMode: "standard",
      input: "final",
      instructions: "JSON only",
      metadata: { runId: "run-invalid", promptVersion: "openai-ruling-v1" },
    }),
    (error) => error.code === "reasoning_mode_not_supported",
  );
});

test("preparation registry rejects final or arbitrary providers and dispatches only known adapters", () => {
  const glm = { providerId: "glm", async prepareEvidence() {} };
  const registry = createEvidencePreparationProviderRegistry({ providers: { glm } });
  assert.equal(registry.get("glm"), glm);
  assert.deepEqual(registry.listProviderIds(), ["glm"]);
  assert.throws(
    () => createEvidencePreparationProviderRegistry({
      providers: { openai: { providerId: "openai", async prepareEvidence() {} } },
    }),
    /Unsupported evidence preparation provider/u,
  );
  assert.throws(
    () => createEvidencePreparationProviderRegistry({
      providers: { glm: { providerId: "kimi", async prepareEvidence() {} } },
    }),
    /key mismatch/u,
  );
});

test("compatible preparation providers require credential-safe HTTPS base URLs", () => {
  const options = {
    providerId: "glm",
    apiKey: "server-secret",
    fetchImpl: async () => jsonResponse({}),
  };
  assert.throws(
    () => new CompatibleEvidencePreparationProvider({
      ...options,
      baseUrl: "http://glm.example/v4",
    }),
    /must use HTTPS/u,
  );
  assert.throws(
    () => new CompatibleEvidencePreparationProvider({
      ...options,
      baseUrl: "https://user:password@glm.example/v4",
    }),
    /must not contain userinfo/u,
  );
});

function mockFetch(calls, payload, status = 200) {
  return async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(payload, status);
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => "application/json",
    },
    json: async () => payload,
  };
}

function makeStructuredResult() {
  return {
    schemaVersion: "1.0",
    verdicts: [{ questionId: "q1", value: "TRUE", conclusion: "可以发动。", conditions: [] }],
    conciseAnswer: "可以发动。",
    claims: [{
      claimId: "c1",
      proposition: "满足发动条件。",
      status: "TRUE",
      decisive: true,
      evidenceIds: ["faq-1"],
      inferenceType: "DIRECT_OFFICIAL",
    }],
    timeline: [{ order: 1, action: "效果处理", result: "处理完成。", evidenceIds: ["faq-1"] }],
    assumptions: [],
    evidenceUsage: [{
      evidenceId: "faq-1",
      relation: "DIRECTLY_ENTAILS",
      supportedClaimIds: ["c1"],
    }],
    counterChecks: MODEL_RULING_COUNTER_CHECK_TYPES.map((type) => ({ type, passed: true, note: "" })),
    unresolved: [],
    confidence: { level: "HIGH", reasons: ["直接官方资料"] },
  };
}
