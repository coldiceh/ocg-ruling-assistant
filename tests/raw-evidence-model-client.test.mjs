import assert from "node:assert/strict";
import test from "node:test";

import {
  callCardNameExtractionModel,
  callRagModel,
  callRuleQueryExtractionModel,
} from "../backend/rawEvidenceModelClient.mjs";
import {
  getPublicModelBudgetStatus,
  releasePublicModelBudgetReservation,
  reservePublicModelBudget,
  resetPublicModelBudget,
  settlePublicModelBudget,
} from "../backend/publicModelBudgetLedger.mjs";
import {
  RelayTransportError,
  requestRelayChatCompletionSse,
} from "../backend/relayChatCompletionSseTransport.mjs";

test("the injected final model is invoked exactly once and returns the neutral public shape", async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await callRagModel({
    prompt: "synthetic frozen evidence packet",
    env: { MODEL_PROVIDER: "mock" },
    signal: controller.signal,
    modelInvoker: async (request) => {
      calls.push(request);
      return JSON.stringify(finalAnswer("synthetic final answer"));
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "synthetic frozen evidence packet");
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(result.answer.shortAnswer, "synthetic final answer");
  assert.equal(result.answer.answerLevel, "rule_analysis");
  assert.equal(result.generationAttempts.length, 1);
  assert.equal(result.generationAttempts[0].attempt, "primary");
  assert.equal(result.estimatedCostCny, 0);
  assert.equal(result.estimatedCostUsd, 0);
  assert.deepEqual(result.tokenUsage, {});
});

test("the relay SSE transport sends one streaming request and assembles content and usage", async () => {
  const calls = [];
  const result = await requestRelayChatCompletionSse({
    endpoint: "https://relay.example.test/v1/chat/completions",
    apiKey: "server-only-key",
    body: {
      model: "synthetic-model",
      messages: [{ role: "user", content: "synthetic request" }],
      stream: false,
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return sseResponse([
        {
          id: "synthetic-response",
          model: "synthetic-model",
          error: null,
          choices: [{ index: 0, delta: { content: "first " }, finish_reason: null }],
        },
        {
          id: "synthetic-response",
          model: "synthetic-model",
          choices: [{ index: 0, delta: { content: "second" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        },
      ]);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer server-only-key");
  assert.equal(calls[0].options.headers.accept, "text/event-stream");
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.equal(result.choices[0].message.content, "first second");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.deepEqual(result.usage, {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  });
  assert.equal(result.stream_metrics.doneMarker, true);
});

test("relay failures distinguish a provable rejection from an ambiguous timeout", async () => {
  await assert.rejects(
    requestRelayChatCompletionSse({
      endpoint: "https://relay.example.test/v1/chat/completions",
      apiKey: "server-only-key",
      fetchImpl: async () => jsonResponse({ error: { message: "forbidden" } }, 403),
    }),
    (error) => {
      assert.equal(error instanceof RelayTransportError, true);
      assert.equal(error.code, "relay_http_access_denied");
      assert.equal(error.failureKind, "access_denied");
      assert.equal(error.outcomeKnown, true);
      assert.equal(error.budgetReservationReleaseSafe, true);
      return true;
    },
  );

  await assert.rejects(
    requestRelayChatCompletionSse({
      endpoint: "https://relay.example.test/v1/chat/completions",
      apiKey: "server-only-key",
      fetchImpl: async () => {
        throw new Error("UND_ERR_HEADERS_TIMEOUT");
      },
    }),
    (error) => {
      assert.equal(error instanceof RelayTransportError, true);
      assert.equal(error.code, "relay_stream_timeout");
      assert.equal(error.failureKind, "timeout");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationReleaseSafe, false);
      return true;
    },
  );
});

test("relay rejects an EOF without DONE but accepts a final unterminated DONE frame", async () => {
  const completion = {
    id: "synthetic-eof-response",
    model: "synthetic-model",
    choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
  };
  await assert.rejects(
    relayRequestWithRawStream(`data: ${JSON.stringify(completion)}\n\n`),
    (error) => {
      assert.equal(error.code, "relay_stream_incomplete");
      assert.equal(error.outcomeKnown, false);
      return true;
    },
  );

  const accepted = await relayRequestWithRawStream(
    `data: ${JSON.stringify(completion)}\n\ndata: [DONE]`,
  );
  assert.equal(accepted.choices[0].message.content, "complete");
  assert.equal(accepted.stream_metrics.doneMarker, true);
});

test("relay rejects data after DONE and embedded upstream error frames", async () => {
  const completion = {
    id: "synthetic-done-response",
    model: "synthetic-model",
    choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
  };
  await assert.rejects(
    relayRequestWithRawStream([
      `data: ${JSON.stringify(completion)}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ usage: { total_tokens: 1 }, choices: [] })}\n\n`,
    ].join("")),
    (error) => error.code === "relay_stream_protocol_error",
  );

  await assert.rejects(
    relayRequestWithRawStream(
      'event: error\ndata: {"error":{"message":"permission denied"}}\n\n',
    ),
    (error) => {
      assert.equal(error.code, "relay_stream_access_denied");
      assert.equal(error.failureKind, "access_denied");
      assert.equal(error.outcomeKnown, true);
      assert.equal(error.budgetReservationReleaseSafe, true);
      return true;
    },
  );

  await assert.rejects(
    relayRequestWithRawStream(
      'data: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n',
    ),
    (error) => {
      assert.equal(error.code, "relay_stream_upstream_error");
      assert.equal(error.outcomeKnown, false);
      return true;
    },
  );

  await assert.rejects(
    relayRequestWithRawStream([
      `data: ${JSON.stringify(completion)}\n\n`,
      'event: error\ndata: {"error":{"message":"permission denied"}}\n\n',
    ].join("")),
    (error) => {
      assert.equal(error.code, "relay_stream_access_denied");
      assert.equal(error.outcomeKnown, false);
      assert.equal(error.budgetReservationReleaseSafe, false);
      return true;
    },
  );
});

test("relay validates stable identity, bounded choice shape, and numeric usage", async () => {
  const completion = (overrides = {}) => ({
    id: "synthetic-protocol-response",
    model: "synthetic-model",
    choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
    ...overrides,
  });
  const invalidStreams = [
    [
      completion(),
      completion({ model: "changed-model", choices: [] }),
    ],
    [completion({ model: { unsafe: true } })],
    [completion({ choices: [{ index: 1, delta: { content: "complete" } }] })],
    [completion({ choices: "not-an-array" })],
    [completion({ usage: { prompt_tokens: -1 } })],
    [completion({ usage: { prompt_tokens_details: "not-an-object" } })],
  ];

  for (const [index, payloads] of invalidStreams.entries()) {
    const raw = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`;
    await assert.rejects(
      relayRequestWithRawStream(raw),
      (error) => {
        assert.equal(error instanceof RelayTransportError, true, `case ${index}`);
        assert.match(error.code, /^relay_stream_/u, `case ${index}`);
        assert.equal(error.outcomeKnown, false, `case ${index}`);
        return true;
      },
    );
  }
});

test("the live relay final path makes one request and reports uncached theoretical USD cost", async () => {
  const now = new Date("2042-01-01T00:00:00.000Z");
  const env = relayEnv();
  await resetPublicModelBudget({ env, now });
  let fetchCount = 0;
  const result = await callRagModel({
    prompt: "synthetic relay final prompt",
    env,
    now,
    fetchImpl: async () => {
      fetchCount += 1;
      return sseResponse([{
        id: "synthetic-final-response",
        model: "gpt-5.6-sol",
        choices: [{
          index: 0,
          delta: { content: JSON.stringify(finalAnswer("relay final answer")) },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 500,
          total_tokens: 1_500,
          prompt_tokens_details: { cached_tokens: 1_000 },
        },
      }]);
    },
  });

  assert.equal(fetchCount, 1);
  assert.equal(result.answer.shortAnswer, "relay final answer");
  assert.equal(result.providerUsed, "relay");
  assert.equal(result.modelUsed, "gpt-5.6-sol");
  assert.equal(result.costCurrency, "USD");
  assert.equal(result.estimatedCostUsd, 0.02);
  assert.equal(result.estimatedCostCny, 0);
  assert.deepEqual(result.tokenUsage, {
    prompt_tokens: 1_000,
    completion_tokens: 500,
    total_tokens: 1_500,
  });
  assert.equal(result.generationAttempts.length, 1);
});

test("DeepSeek auxiliary extractors send lexical-only JSON requests and normalize results", async () => {
  const now = new Date("2042-01-02T00:00:00.000Z");
  const env = deepSeekEnv();
  await resetPublicModelBudget({ env, now });
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const isCardRequest = body.messages[0].content.includes("cardNames");
    return jsonResponse({
      model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          content: JSON.stringify(isCardRequest
            ? {
                cardNames: [{
                  name: "Synthetic Entity Alpha",
                  originalText: "Entity Alpha",
                  confidence: "high",
                }],
              }
            : { ruleQueries: [{ query: "synthetic lexical phrase" }] }),
        },
      }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    });
  };

  const card = await callCardNameExtractionModel({
    userQuery: "input mentions Entity Alpha",
    dataRevision: "synthetic-revision-a",
    env,
    now,
    fetchImpl,
  });
  const rule = await callRuleQueryExtractionModel({
    userQuery: "input contains a synthetic lexical phrase",
    dataRevision: "synthetic-revision-a",
    env,
    now,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((body) => body.stream === false));
  assert.ok(calls.every((body) => body.response_format?.type === "json_object"));
  assert.deepEqual(card.candidates, [{
    name: "Synthetic Entity Alpha",
    originalText: "Entity Alpha",
    confidence: "high",
    source: "model_card_name_extractor",
  }]);
  assert.deepEqual(rule.queries, [{ query: "synthetic lexical phrase" }]);
  assert.equal(card.providerUsed, "deepseek");
  assert.equal(rule.providerUsed, "deepseek");
  assert.equal(card.estimatedCostCny > 0, true);
  assert.equal(rule.estimatedCostCny > 0, true);
});

test("identical auxiliary requests share one flight and then use the bounded cache", async () => {
  const env = deepSeekEnv({ RAG_EXTRACTION_CACHE_MAX_ENTRIES: "4" });
  const now = new Date("2042-01-03T00:00:00.000Z");
  let invocationCount = 0;
  const gate = deferred();
  const input = {
    userQuery: "synthetic cache and flight input 2042-01-03",
    dataRevision: "synthetic-revision-flight",
    env,
    now,
    modelInvoker: async () => {
      invocationCount += 1;
      await gate.promise;
      return JSON.stringify({
        cardNames: [{ name: "Synthetic Entity Beta", originalText: "Entity Beta" }],
      });
    },
  };

  const leader = callCardNameExtractionModel(input);
  const follower = callCardNameExtractionModel(input);
  gate.resolve();
  const [first, second] = await Promise.all([leader, follower]);
  assert.equal(invocationCount, 1);
  assert.deepEqual(second.candidates, first.candidates);

  const cached = await callCardNameExtractionModel({
    ...input,
    modelInvoker: async () => {
      throw new Error("cache hit must not invoke the model");
    },
  });
  assert.equal(invocationCount, 1);
  assert.deepEqual(cached.candidates, first.candidates);
  assert.ok(cached.warnings.includes("card_extraction_cache_hit"));
  assert.equal(cached.estimatedCostCny, 0);
});

test("budget reservations settle to actual spend and explicit release refunds the reservation", async () => {
  const env = deepSeekEnv({
    API_DAILY_BUDGET_CNY: "10",
    API_EVIDENCE_DAILY_BUDGET_CNY: "2",
  });
  const now = new Date("2042-01-04T00:00:00.000Z");
  await resetPublicModelBudget({ env, now });

  const settledReservation = await reservePublicModelBudget({
    provider: "deepseek",
    stage: "evidence_preparation",
    estimatedAmount: 1.2,
    env,
    now,
  });
  assert.equal(settledReservation.blocked, false);
  assert.equal(settledReservation.reservedAmount, 1.2);
  const settled = await settlePublicModelBudget({
    reservation: settledReservation,
    actualAmount: 0.4,
    env,
  });
  assert.equal(settled.spentTodayCny, 0.4);
  assert.equal(settled.bucket.spentTodayCny, 0.4);
  assert.equal(settled.bucket.estimatedThisCallCny, 0.4);

  const releasedReservation = await reservePublicModelBudget({
    provider: "deepseek",
    stage: "evidence_preparation",
    estimatedAmount: 0.3,
    env,
    now,
  });
  const released = await releasePublicModelBudgetReservation({
    reservation: releasedReservation,
    env,
  });
  assert.equal(released.spentTodayCny, 0.4);
  assert.equal(released.bucket.spentTodayCny, 0.4);
  assert.equal(released.bucket.estimatedThisCallCny, 0);
});

test("relay budget accounting is USD-only and does not consume the CNY aggregate", async () => {
  const env = relayEnv({ API_DAILY_BUDGET_CNY: "0.000001" });
  const now = new Date("2042-01-05T00:00:00.000Z");
  await resetPublicModelBudget({ env, now });
  const reservation = await reservePublicModelBudget({
    provider: "relay",
    stage: "final_ruling",
    estimatedAmount: 0.25,
    env,
    now,
  });
  assert.equal(reservation.blocked, false);
  assert.equal(reservation.status.spentTodayCny, 0);
  assert.equal(reservation.status.bucket.currency, "USD");
  assert.equal(reservation.status.bucket.spentTodayUsd, 0.25);
  const settled = await settlePublicModelBudget({
    reservation,
    actualAmount: 0.1,
    env,
  });
  assert.equal(settled.spentTodayCny, 0);
  assert.equal(settled.bucket.spentTodayUsd, 0.1);
  assert.equal(settled.bucket.spentTodayCny, null);
  const status = await getPublicModelBudgetStatus({ env, now });
  assert.equal(status.spentTodayCny, 0);
  assert.equal(
    status.buckets.find((bucket) => bucket.id === "final_ruling:relay").spentTodayUsd,
    0.1,
  );
});

test("pre-cancelled final and auxiliary calls never invoke a model or reserve spend", async () => {
  const env = deepSeekEnv();
  const now = new Date("2042-01-06T00:00:00.000Z");
  await resetPublicModelBudget({ env, now });
  const controller = new AbortController();
  controller.abort(new Error("synthetic request cancelled"));
  let invocationCount = 0;
  const modelInvoker = async () => {
    invocationCount += 1;
    return JSON.stringify({ cardNames: [] });
  };

  await assert.rejects(callRagModel({
    prompt: "cancelled final request",
    env,
    now,
    signal: controller.signal,
    modelInvoker,
  }), /synthetic request cancelled/u);
  await assert.rejects(callCardNameExtractionModel({
    userQuery: "cancelled auxiliary request",
    dataRevision: "synthetic-revision-cancelled",
    env,
    now,
    signal: controller.signal,
    modelInvoker,
  }), /synthetic request cancelled/u);

  assert.equal(invocationCount, 0);
  const status = await getPublicModelBudgetStatus({ env, now });
  assert.equal(status.spentTodayCny, 0);
});

test("an auxiliary timeout is bounded and preserves the ambiguous remote reservation", async () => {
  const env = deepSeekEnv({ RAG_CARD_MODEL_TIMEOUT_MS: "1" });
  const now = new Date("2042-01-07T00:00:00.000Z");
  await resetPublicModelBudget({ env, now });
  let fetchCount = 0;
  const result = await callCardNameExtractionModel({
    userQuery: "synthetic timeout input 2042-01-07",
    dataRevision: "synthetic-revision-timeout",
    env,
    now,
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      return await rejectWhenAborted(options.signal);
    },
  });

  assert.equal(fetchCount, 1);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.dryRun, false);
  assert.ok(result.warnings.some((warning) => (
    warning.startsWith("card_extraction_failed:") && /timeout/iu.test(warning)
  )));
  const status = await getPublicModelBudgetStatus({ env, now });
  assert.equal(status.spentTodayCny > 0, true);
});

function finalAnswer(shortAnswer) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer,
    reasoning: ["synthetic evidence-only reasoning"],
    usedCards: [],
    usedEvidence: [{ id: "synthetic-evidence-1", type: "related", title: "Synthetic evidence" }],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
  };
}

function deepSeekEnv(overrides = {}) {
  return {
    MODEL_PROVIDER: "deepseek",
    RAG_CARD_MODEL_PROVIDER: "deepseek",
    RAG_RULE_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "server-only-deepseek-key",
    DEEPSEEK_BASE_URL: "https://deepseek.example.test/v1",
    DEEPSEEK_CARD_MODEL: "deepseek-v4-flash",
    DEEPSEEK_RULE_MODEL: "deepseek-v4-flash",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
    ...overrides,
  };
}

function relayEnv(overrides = {}) {
  return {
    MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "server-only-relay-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    RAG_MODEL: "gpt-5.6-sol",
    RAG_REASONING_EFFORT: "low",
    RELAY_MAX_COMPLETION_TOKENS: "512",
    API_CHATGPT_DAILY_BUDGET_USD: "10",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events) {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(`${frames}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function relayRequestWithRawStream(raw) {
  return requestRelayChatCompletionSse({
    endpoint: "https://relay.example.test/v1/chat/completions",
    apiKey: "server-only-key",
    fetchImpl: async () => new Response(raw, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejectWhenAborted(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(
      signal?.reason instanceof Error ? signal.reason : new Error("synthetic timeout"),
    );
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener("abort", rejectAbort, { once: true });
  });
}
