import assert from "node:assert/strict";
import test from "node:test";
import {
  CompatibleEvidencePreparationProvider,
  ExistingDeepSeekProvider,
  OpenAIResponsesProvider,
  createEvidencePreparationProviderRegistry,
  extractOpenAIResponseOutputText,
} from "../backend/rulingModelProviders.mjs";

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

test("OpenAI response JSON parsing stops promptly when the caller aborts", async () => {
  const controller = new AbortController();
  const abortReason = Object.assign(new Error("OpenAI response body deadline exceeded"), {
    code: "test_openai_response_body_timeout",
  });
  let markJsonStarted;
  const jsonStarted = new Promise((resolve) => { markJsonStarted = resolve; });
  const provider = new OpenAIResponsesProvider({
    apiKey: "server-secret",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json() {
        markJsonStarted();
        return new Promise(() => {});
      },
    }),
  });
  const pending = provider.create({
    model: "gpt-5.6-luna",
    input: "x",
    metadata: { runId: "run-json-abort", promptVersion: "v1" },
    signal: controller.signal,
  });
  await jsonStarted;
  controller.abort(abortReason);
  let watchdogTimer;
  const watchdog = new Promise((resolve, reject) => {
    watchdogTimer = setTimeout(
      () => reject(new Error("OpenAI response JSON abort did not settle")),
      500,
    );
    watchdogTimer.unref?.();
  });

  try {
    await assert.rejects(
      Promise.race([pending, watchdog]),
      (error) => error === abortReason,
    );
  } finally {
    clearTimeout(watchdogTimer);
  }
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

test("DeepSeek V4 finals omit JSON Output while thinking and retain it without thinking", async () => {
  const calls = [];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "deepseek",
    apiKey: "deepseek-server-secret",
    fetchImpl: mockFetch(calls, {
      id: "deepseek-final-1",
      model: "deepseek-v4-pro",
      choices: [{ message: { content: [{ type: "text", content: JSON.stringify(makeStructuredResult()) }] } }],
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
  assert.equal(body.max_tokens, 64_000);
  assert.equal(Object.hasOwn(body, "response_format"), false);
  assert.match(body.messages[0].content, /仅展示字段结构/u);
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
  assert.equal(standardBody.max_tokens, 16_000);
  assert.deepEqual(standardBody.response_format, { type: "json_object" });
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

test("relay adapter sends one allowlisted Chat Completions request with the canonical upstream model", async () => {
  const calls = [];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: { RELAY_MAX_COMPLETION_TOKENS: "8192", RELAY_STREAM: "false" },
    fetchImpl: mockFetch(calls, {
      id: "relay-final-1",
      model: "gpt-5.6-terra",
      choices: [{ message: { content: JSON.stringify(makeStructuredResult()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  });
  const response = await provider.create({
    model: "relay-gpt-5.6-terra",
    reasoningEffort: "high",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-relay", promptVersion: "openai-ruling-v1" },
  });

  assert.equal(response.status, "completed");
  assert.equal(response.provider, "relay");
  assert.equal(response.requested_model, "relay-gpt-5.6-terra");
  assert.equal(response.submitted_model, "gpt-5.6-terra");
  assert.equal(response.reported_model, "gpt-5.6-terra");
  assert.equal(response.model_identity_verified, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example/v1/chat/completions");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gpt-5.6-terra");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.max_completion_tokens, 8192);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(body, "thinking"), false);
  assert.equal(JSON.stringify(response).includes("relay-server-secret"), false);
});

test("relay adapter rejects an HTTP 200 response whose self-reported model differs from the submitted model", async () => {
  const calls = [];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: { RELAY_STREAM: "false" },
    fetchImpl: mockFetch(calls, {
      id: "relay-mismatch-1",
      model: "gpt-5.6-terra",
      choices: [{ message: { content: JSON.stringify(makeStructuredResult()) } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    }),
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-luna",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-mismatch", promptVersion: "openai-ruling-v1" },
    }),
    (error) => {
      assert.equal(error.code, "relay_returned_model_mismatch");
      assert.equal(error.outcomeKnown, true);
      assert.equal(error.budgetReservationMayExist, true);
      assert.equal(error.requestedModel, "relay-gpt-5.6-luna");
      assert.equal(error.submittedModel, "gpt-5.6-luna");
      assert.equal(error.reportedModel, "gpt-5.6-terra");
      assert.equal(error.model, "gpt-5.6-terra");
      assert.equal(error.requestId, "relay-mismatch-1");
      assert.deepEqual(error.usage, {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      });
      return true;
    },
  );
  assert.equal(JSON.parse(calls[0].options.body).model, "gpt-5.6-luna");
});

test("relay adapter distinguishes a missing HTTP 200 model identity from a mismatch", async () => {
  const calls = [];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: { RELAY_STREAM: "false" },
    fetchImpl: mockFetch(calls, {
      id: "relay-missing-model-1",
      choices: [{ message: { content: JSON.stringify(makeStructuredResult()) } }],
    }),
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-missing", promptVersion: "openai-ruling-v1" },
    }),
    (error) => {
      assert.equal(error.code, "relay_returned_model_missing");
      assert.equal(error.outcomeKnown, true);
      assert.equal(error.budgetReservationMayExist, true);
      assert.equal(error.requestedModel, "relay-gpt-5.6-sol");
      assert.equal(error.submittedModel, "gpt-5.6-sol");
      assert.equal(error.reportedModel, null);
      assert.equal(error.model, null);
      assert.equal(error.requestId, "relay-missing-model-1");
      assert.equal(error.usage, null);
      return true;
    },
  );
});

test("relay adapter streams Chat Completions by default and discards reasoning deltas", async () => {
  const calls = [];
  const structured = JSON.stringify(makeStructuredResult());
  const midpoint = Math.floor(structured.length / 2);
  const clockValues = [0, 10, 20, 30, 80, 120];
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    clock: () => clockValues.shift(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return sseResponse([
        `data: ${JSON.stringify({
          id: "relay-stream-1",
          model: "gpt-5.6-sol",
          choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hidden reasoning" }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "relay-stream-1",
          model: "gpt-5.6-sol",
          choices: [{ index: 0, delta: { content: structured.slice(0, midpoint) }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "relay-stream-1",
          model: "gpt-5.6-sol",
          choices: [{ index: 0, delta: { content: structured.slice(midpoint) }, finish_reason: "stop" }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "relay-stream-1",
          model: "gpt-5.6-sol",
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    },
  });
  const response = await provider.create({
    model: "relay-gpt-5.6-sol",
    reasoningEffort: "high",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-relay-stream", promptVersion: "openai-ruling-v1" },
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(calls[0].options.headers.accept, "text/event-stream");
  assert.equal(response.id, "relay-stream-1");
  assert.equal(response.requested_model, "relay-gpt-5.6-sol");
  assert.equal(response.submitted_model, "gpt-5.6-sol");
  assert.equal(response.reported_model, "gpt-5.6-sol");
  assert.equal(response.output_text, structured);
  assert.equal(response.finish_reason, "stop");
  assert.equal(JSON.stringify(response).includes("hidden reasoning"), false);
  assert.deepEqual(response.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.deepEqual(response.stream_metrics, {
    schemaVersion: 1,
    transport: "sse",
    requestToResponseHeadersMs: 10,
    requestToFirstByteMs: 20,
    requestToFirstEventMs: 30,
    requestToFirstContentMs: 80,
    requestToCompleteMs: 120,
    networkChunkCount: 5,
    sseEventCount: 4,
    visibleContentChunkCount: 2,
    responseBytes: calls[0].options
      ? new TextEncoder().encode([
          `data: ${JSON.stringify({
            id: "relay-stream-1",
            model: "gpt-5.6-sol",
            choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hidden reasoning" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "relay-stream-1",
            model: "gpt-5.6-sol",
            choices: [{ index: 0, delta: { content: structured.slice(0, midpoint) }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "relay-stream-1",
            model: "gpt-5.6-sol",
            choices: [{ index: 0, delta: { content: structured.slice(midpoint) }, finish_reason: "stop" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "relay-stream-1",
            model: "gpt-5.6-sol",
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join("")).byteLength
      : 0,
    visibleContentBytes: new TextEncoder().encode(structured).byteLength,
    finishReason: "stop",
  });
  assert.equal(clockValues.length, 0);
});

test("relay stream treats error null as a normal completion field", async () => {
  const structured = JSON.stringify(makeStructuredResult());
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => sseResponse([
      `data: ${JSON.stringify({
        id: "relay-error-null",
        model: "gpt-5.6-sol",
        error: null,
        choices: [{ index: 0, delta: { content: structured }, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]),
  });

  const response = await provider.create({
    model: "relay-gpt-5.6-sol",
    reasoningEffort: "low",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-relay-error-null", promptVersion: "openai-ruling-v1" },
  });

  assert.equal(response.output_text, structured);
  assert.equal(response.finish_reason, "stop");
});

test("relay marks code, status or message pre-generation SSE access denial as safe to release", async () => {
  const frames = [
    'data: {"code":"group_access_denied","message":"request rejected"}\n\n',
    'data: {"status":403,"message":"request rejected"}\n\n',
    'event: error\ndata: {"message":"permission denied"}\n\n',
  ];
  for (const [index, frame] of frames.entries()) {
    const provider = new CompatibleEvidencePreparationProvider({
      providerId: "relay",
      apiKey: "relay-server-secret",
      baseUrl: "https://relay.example/v1",
      fetchImpl: async () => sseResponse([frame]),
    });

    await assert.rejects(
      provider.create({
        model: "relay-gpt-5.6-sol",
        reasoningEffort: "low",
        reasoningMode: "pro",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: `run-relay-access-denied-${index}`, promptVersion: "openai-ruling-v1" },
      }),
      (error) => {
        assert.equal(error.code, "relay_stream_access_denied");
        assert.equal(error.outcomeKnown, true);
        assert.equal(error.budgetReservationMayExist, false);
        assert.doesNotMatch(error.message, /group_access_denied|request rejected|permission denied/u);
        return true;
      },
    );
  }
});

test("relay retains a reservation when access denial follows a completion frame", async () => {
  const secretFinishReason = "internal-route-finish-reason";
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => sseResponse([
      `data: ${JSON.stringify({
        id: "relay-late-access-denial",
        model: "gpt-5.6-sol",
        choices: [{ index: 0, delta: { content: "{" }, finish_reason: secretFinishReason }],
      })}\n\n`,
      'event: error\ndata: {"error":{"message":"permission denied"}}\n\n',
    ]),
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "low",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-late-access-denied", promptVersion: "openai-ruling-v1" },
    }),
    (error) => {
      assert.equal(error.code, "relay_stream_access_denied");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationMayExist, true);
      assert.equal(error.streamMetrics.finishReason, "other");
      assert.doesNotMatch(JSON.stringify(error.streamMetrics), new RegExp(secretFinishReason, "u"));
      return true;
    },
  );
});

test("relay accepts a complete DONE stream without a nonstandard finish_reason", async () => {
  const structured = JSON.stringify(makeStructuredResult());
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => sseResponse([
      `data: ${JSON.stringify({
        id: "relay-stream-no-finish-reason",
        model: "gpt-5.6-luna",
        choices: [{ index: 0, delta: { content: structured }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "relay-stream-no-finish-reason",
        model: "gpt-5.6-luna",
        choices: [],
        usage: { total_tokens: 120 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]),
  });

  const response = await provider.create({
    model: "relay-gpt-5.6-luna",
    reasoningEffort: "high",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-relay-no-finish", promptVersion: "openai-ruling-v1" },
  });

  assert.equal(response.output_text, structured);
  assert.equal(response.finish_reason, null);
  assert.equal(response.stream_metrics.finishReason, null);
  assert.deepEqual(response.usage, { total_tokens: 120 });
});

test("relay stream interruption after a valid chunk remains outcome-unknown and non-retryable", async () => {
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => sseResponse([
      `data: ${JSON.stringify({
        id: "relay-stream-interrupted",
        model: "gpt-5.6-luna",
        choices: [{ index: 0, delta: { reasoning_content: "discard me" }, finish_reason: null }],
      })}\n\n`,
    ], { failAfterChunks: true }),
  });
  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-luna",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-interrupted", promptVersion: "openai-ruling-v1" },
    }),
    (error) => {
      assert.equal(error.code, "relay_stream_interrupted");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationMayExist, true);
      assert.equal(error.requestId, "relay-stream-interrupted");
      assert.equal(error.requestedModel, "relay-gpt-5.6-luna");
      assert.equal(error.submittedModel, "gpt-5.6-luna");
      assert.equal(error.reportedModel, "gpt-5.6-luna");
      assert.equal(error.streamMetrics.transport, "sse");
      assert.equal(error.streamMetrics.sseEventCount, 1);
      assert.equal(error.message.includes("discard me"), false);
      return true;
    },
  );
});

test("relay stream that reports usage but closes before DONE keeps safe usage and transport metrics", async () => {
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => sseResponse([
      `data: ${JSON.stringify({
        id: "relay-stream-usage-before-close",
        model: "gpt-5.6-sol",
        choices: [],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
      })}\n\n`,
    ]),
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-usage-incomplete", promptVersion: "openai-ruling-v1" },
    }),
    (error) => {
      assert.equal(error.code, "relay_stream_incomplete");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.requestId, "relay-stream-usage-before-close");
      assert.deepEqual(error.usage, {
        prompt_tokens: 200,
        completion_tokens: 40,
        total_tokens: 240,
      });
      assert.equal(error.streamMetrics.sseEventCount, 1);
      assert.equal(error.streamMetrics.finishReason, null);
      assert.equal(JSON.stringify(error.streamMetrics).includes("reasoning"), false);
      return true;
    },
  );
});

test("relay classifies the admin synchronous outer deadline as a stream timeout", async () => {
  const controller = new AbortController();
  const timeout = new Error("final ruling provider exceeded 290000ms");
  timeout.code = "final_ruling_provider_timeout";
  controller.abort(timeout);
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async (_url, options) => {
      throw options.signal.reason;
    },
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "medium",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-outer-timeout", promptVersion: "openai-ruling-v1" },
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.code, "relay_stream_timeout");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationMayExist, true);
      assert.equal(error.requestedModel, "relay-gpt-5.6-sol");
      assert.equal(error.submittedModel, "gpt-5.6-sol");
      return true;
    },
  );
});

test("relay stream abort race settles when reader and cancellation ignore the signal", async () => {
  const controller = new AbortController();
  const timeout = new Error("final ruling provider exceeded 25ms");
  timeout.code = "final_ruling_provider_timeout";
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader() {
          return {
            read() {
              readCalls += 1;
              return new Promise(() => {});
            },
            cancel() {
              cancelCalls += 1;
              return new Promise(() => {});
            },
            releaseLock() {
              releaseCalls += 1;
            },
          };
        },
      },
    }),
  });
  const abortTimer = setTimeout(() => controller.abort(timeout), 25);
  const watchdog = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay stream abort race did not settle")), 500);
    timer.unref?.();
  });

  await assert.rejects(
    Promise.race([
      provider.create({
        model: "relay-gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "pro",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: "run-relay-stuck-reader", promptVersion: "openai-ruling-v1" },
        signal: controller.signal,
      }),
      watchdog,
    ]),
    (error) => {
      assert.equal(error.code, "relay_stream_timeout");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationMayExist, true);
      return true;
    },
  );
  clearTimeout(abortTimer);
  assert.equal(readCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("relay stream abort race classifies a non-timeout parent cancellation as interrupted", async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader() {
          return {
            read: () => new Promise(() => {}),
            cancel() {
              cancelCalls += 1;
              return new Promise(() => {});
            },
            releaseLock() {},
          };
        },
      },
    }),
  });
  const abortTimer = setTimeout(
    () => controller.abort(new DOMException("client disconnected", "AbortError")),
    25,
  );
  const watchdog = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay stream cancellation did not settle")), 500);
    timer.unref?.();
  });

  await assert.rejects(
    Promise.race([
      provider.create({
        model: "relay-gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "pro",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: "run-relay-stuck-reader-abort", promptVersion: "openai-ruling-v1" },
        signal: controller.signal,
      }),
      watchdog,
    ]),
    (error) => {
      assert.equal(error.code, "relay_stream_interrupted");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationMayExist, true);
      return true;
    },
  );
  clearTimeout(abortTimer);
  assert.equal(cancelCalls, 1);
});

test("relay total signal also bounds a non-2xx response body that ignores abort", async () => {
  const controller = new AbortController();
  const timeout = new Error("final ruling provider exceeded 25ms");
  timeout.code = "final_ruling_provider_timeout";
  let cancelCalls = 0;
  let releaseCalls = 0;
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => ({
      ok: false,
      status: 504,
      headers: { get: () => "text/html" },
      body: {
        getReader() {
          return {
            read: () => new Promise(() => {}),
            cancel() {
              cancelCalls += 1;
              return new Promise(() => {});
            },
            releaseLock() {
              releaseCalls += 1;
            },
          };
        },
      },
    }),
  });
  const abortTimer = setTimeout(() => controller.abort(timeout), 25);
  const watchdog = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay error-body abort race did not settle")), 500);
    timer.unref?.();
  });

  await assert.rejects(
    Promise.race([
      provider.create({
        model: "relay-gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "pro",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: "run-relay-stuck-error-body", promptVersion: "openai-ruling-v1" },
        signal: controller.signal,
      }),
      watchdog,
    ]),
    (error) => {
      assert.equal(error.code, "relay_stream_timeout");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationMayExist, true);
      return true;
    },
  );
  clearTimeout(abortTimer);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("relay classifies transport timeout codes without requiring an abort signal", async () => {
  for (const code of ["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
    const provider = new CompatibleEvidencePreparationProvider({
      providerId: "relay",
      apiKey: "relay-server-secret",
      baseUrl: "https://relay.example/v1",
      fetchImpl: async () => {
        const error = new Error("request failed");
        error.code = code;
        throw error;
      },
    });

    await assert.rejects(
      provider.create({
        model: "relay-gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "pro",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: `run-relay-${code}`, promptVersion: "openai-ruling-v1" },
      }),
      (error) => {
        assert.equal(error.code, "relay_stream_timeout");
        assert.equal(error.outcomeKnown, false);
        assert.equal(error.budgetReservationMayExist, true);
        return true;
      },
    );
  }
});

test("relay classifies HTTP 408, 504 and 524 as timeout while retaining reservations", async () => {
  for (const status of [408, 504, 524]) {
    const provider = new CompatibleEvidencePreparationProvider({
      providerId: "relay",
      apiKey: "relay-server-secret",
      baseUrl: "https://relay.example/v1",
      fetchImpl: async () => jsonResponse({ error: { message: "request failed" } }, status),
    });

    await assert.rejects(
      provider.create({
        model: "relay-gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "pro",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: `run-relay-http-${status}`, promptVersion: "openai-ruling-v1" },
      }),
      (error) => {
        assert.equal(error.code, "relay_http_timeout");
        assert.equal(error.outcomeKnown, false);
        assert.equal(error.budgetReservationMayExist, true);
        return true;
      },
    );
  }
});

test("relay rejects a stream deadline that leaves no room below the admin outer guard", async () => {
  let transportCalls = 0;
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: { RELAY_STREAM_TIMEOUT_MS: "280001" },
    fetchImpl: async () => {
      transportCalls += 1;
      throw new Error("transport must not be reached");
    },
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-timeout-bound", promptVersion: "openai-ruling-v1" },
    }),
    /RELAY_STREAM_TIMEOUT_MS must be between 1000 and 280000/u,
  );
  assert.equal(transportCalls, 0);
});

test("relay keeps the Vercel stream deadline at or below 270 seconds", async () => {
  let transportCalls = 0;
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: { VERCEL: "1", RELAY_STREAM_TIMEOUT_MS: "270001" },
    fetchImpl: async () => {
      transportCalls += 1;
      throw new Error("transport must not be reached");
    },
  });

  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-vercel-timeout-bound", promptVersion: "openai-ruling-v1" },
    }),
    /RELAY_STREAM_TIMEOUT_MS must be between 1000 and 270000/u,
  );
  assert.equal(transportCalls, 0);
});

test("relay permits an explicitly extended deadline only for a local direct experiment", async () => {
  const calls = [];
  const structured = JSON.stringify(makeStructuredResult());
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: {
      RELAY_STREAM_TIMEOUT_MS: "900000",
      RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS: "900000",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return sseResponse([
        `data: ${JSON.stringify({
          id: "relay-local-long-window",
          model: "gpt-5.6-sol",
          choices: [{ index: 0, delta: { content: structured }, finish_reason: "stop" }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "relay-local-long-window",
          model: "gpt-5.6-sol",
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    },
  });

  const response = await provider.create({
    model: "relay-gpt-5.6-sol",
    reasoningEffort: "high",
    reasoningMode: "pro",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-relay-local-long-window", promptVersion: "openai-ruling-v1" },
  });

  assert.equal(calls.length, 1);
  assert.equal(response.output_text, structured);

  const vercelProvider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    env: {
      VERCEL: "1",
      RELAY_STREAM_TIMEOUT_MS: "900000",
      RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS: "900000",
    },
    fetchImpl: async () => {
      throw new Error("transport must not be reached");
    },
  });
  await assert.rejects(
    vercelProvider.create({
      model: "relay-gpt-5.6-sol",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-relay-vercel-long-window", promptVersion: "openai-ruling-v1" },
    }),
    /RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS is local-only/u,
  );
});

test("relay non-JSON HTTP errors persist only a bounded redacted summary", async () => {
  const tail = "DO_NOT_PERSIST_HTML_TAIL";
  const html = `<html><head><title>524: A timeout occurred</title></head><body>Client IP 203.0.113.42 ${"x".repeat(200_000)}${tail}</body></html>`;
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "relay",
    apiKey: "relay-server-secret",
    baseUrl: "https://relay.example/v1",
    fetchImpl: async () => textResponse(html, 524, "text/html"),
  });
  await assert.rejects(
    provider.create({
      model: "relay-gpt-5.6-terra",
      input: "匿名问题与冻结证据",
      metadata: { runId: "run-relay-html", promptVersion: "openai-ruling-v1" },
    }),
    (error) => {
      assert.equal(error.code, "relay_http_timeout");
      assert.equal(error.status, 524);
      assert.equal(error.outcomeKnown, false);
      assert.ok(error.message.length <= 1_000);
      assert.match(error.message, /HTTP 524/u);
      assert.doesNotMatch(error.message, /203\.0\.113\.42/u);
      assert.doesNotMatch(error.message, new RegExp(tail, "u"));
      assert.ok(JSON.stringify(error.responseBody).length < 2_000);
      return true;
    },
  );
});

test("empty compatible final reports bounded diagnostics without exposing reasoning content", async () => {
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "deepseek",
    apiKey: "deepseek-server-secret",
    fetchImpl: mockFetch([], {
      choices: [{
        finish_reason: "stop",
        message: { content: "", reasoning_content: "private reasoning" },
      }],
      usage: {
        completion_tokens: 11,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }),
  });

  await assert.rejects(
    provider.create({
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      reasoningMode: "pro",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-empty", promptVersion: "openai-ruling-v1" },
    }),
    (error) => (
      error.code === "deepseek_empty_final_ruling"
      && error.outcomeKnown === true
      && error.budgetReservationMayExist === true
      && error.model === "deepseek-v4-flash"
      && error.usage?.completion_tokens === 11
      && /finish_reason=stop/u.test(error.message)
      && /reasoning_chars=17/u.test(error.message)
      && /reasoning_tokens=10/u.test(error.message)
      && !error.message.includes("private reasoning")
    ),
  );
});

test("compatible transport distinguishes provable 4xx rejection from potentially billed failures", async () => {
  for (const status of [408, 429, 500, 503]) {
    const provider = new CompatibleEvidencePreparationProvider({
      providerId: "deepseek",
      apiKey: "deepseek-server-secret",
      fetchImpl: async () => jsonResponse({
        error: { code: `status_${status}`, message: `ambiguous ${status}` },
      }, status),
    });
    await assert.rejects(
      provider.create({
        model: "deepseek-v4-flash",
        reasoningEffort: "none",
        reasoningMode: "standard",
        input: "匿名问题与冻结证据",
        instructions: "只输出 JSON。",
        metadata: { runId: `run-${status}`, promptVersion: "openai-ruling-v1" },
      }),
      (error) => error.status === status && error.outcomeKnown === false,
    );
  }

  let rejectedFinalCalls = 0;
  const rejected = new CompatibleEvidencePreparationProvider({
    providerId: "deepseek",
    apiKey: "deepseek-server-secret",
    fetchImpl: async () => {
      rejectedFinalCalls += 1;
      return jsonResponse({
        error: { code: "invalid_request", message: "invalid request" },
      }, 400);
    },
  });
  await assert.rejects(
    rejected.create({
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
      reasoningMode: "standard",
      input: "匿名问题与冻结证据",
      instructions: "只输出 JSON。",
      metadata: { runId: "run-400", promptVersion: "openai-ruling-v1" },
    }),
    (error) => error.status === 400 && error.outcomeKnown === true,
  );
  assert.equal(rejectedFinalCalls, 1);
});

test("compatible response JSON parsing stops promptly when the caller aborts", async () => {
  const controller = new AbortController();
  const abortReason = Object.assign(new Error("compatible response body deadline exceeded"), {
    code: "test_compatible_response_body_timeout",
  });
  let markJsonStarted;
  const jsonStarted = new Promise((resolve) => { markJsonStarted = resolve; });
  const provider = new CompatibleEvidencePreparationProvider({
    providerId: "deepseek",
    apiKey: "deepseek-server-secret",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json() {
        markJsonStarted();
        return new Promise(() => {});
      },
    }),
  });
  const pending = provider.create({
    model: "deepseek-v4-flash",
    reasoningEffort: "none",
    reasoningMode: "standard",
    input: "匿名问题与冻结证据",
    instructions: "只输出 JSON。",
    metadata: { runId: "run-compatible-json-abort", promptVersion: "openai-ruling-v1" },
    signal: controller.signal,
  });
  await jsonStarted;
  controller.abort(abortReason);
  let watchdogTimer;
  const watchdog = new Promise((resolve, reject) => {
    watchdogTimer = setTimeout(
      () => reject(new Error("compatible response JSON abort did not settle")),
      500,
    );
    watchdogTimer.unref?.();
  });

  try {
    await assert.rejects(
      Promise.race([pending, watchdog]),
      (error) => error === abortReason,
    );
  } finally {
    clearTimeout(watchdogTimer);
  }
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
  assert.equal(k3Body.max_completion_tokens, 64_000);
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
  const relay = { providerId: "relay", async prepareEvidence() {} };
  const registry = createEvidencePreparationProviderRegistry({ providers: { glm, relay } });
  assert.equal(registry.get("glm"), glm);
  assert.equal(registry.get("relay"), relay);
  assert.deepEqual(registry.listProviderIds(), ["glm", "relay"]);
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

function sseResponse(chunks, { failAfterChunks = false } = {}) {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "text/event-stream" : null },
    body: {
      getReader() {
        return {
          async read() {
            if (index < encoded.length) return { done: false, value: encoded[index++] };
            if (failAfterChunks) throw new Error("socket closed");
            return { done: true, value: undefined };
          },
          releaseLock() {},
        };
      },
    },
  };
}

function textResponse(text, status, contentType) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === "content-type" ? contentType : null },
    text: async () => text,
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
    counterChecks: [],
    unresolved: [],
    confidence: { level: "HIGH", reasons: ["直接官方资料"] },
  };
}
