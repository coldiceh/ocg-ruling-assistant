import assert from "node:assert/strict";
import test from "node:test";
import {
  ExistingDeepSeekProvider,
  OpenAIResponsesProvider,
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

test("DeepSeek adapter can prepare evidence but can never issue the final ruling", async () => {
  const invocations = [];
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
  });
  assert.equal(prepared.canMakeFinalRuling, false);
  assert.equal(prepared.canDecideEscalation, false);
  assert.equal(invocations[0].purpose, "evidence_preparation");
  assert.equal(invocations[0].canMakeFinalRuling, false);
  await assert.rejects(
    provider.runRuling({ input: "question" }),
    (error) => error.code === "deepseek_final_ruling_forbidden",
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
