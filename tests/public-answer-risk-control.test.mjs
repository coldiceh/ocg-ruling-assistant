import assert from "node:assert/strict";
import test from "node:test";

import {
  answerPublicRulingQuestion,
  shouldClassifyPublicQuestion,
  shouldApplyPublicOfftopicRiskControl,
} from "../backend/publicAnswerService.mjs";

const PUBLIC_ENV = {
  MODEL_PROVIDER: "mock",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

test('local refusal records classifier metadata without activating a shared lock', async()=>{
  const result = await answerPublicRulingQuestion({payload:{question:'private fixture question'},env:PUBLIC_ENV,
    appendAudit:async()=>({}),readRiskControl:async()=>({ok:true,active:false}),
    classifyScope:async()=>({scope:'out_of_scope',confidence:'high',reasonCode:'not_ruling_question',model:'fixture-model',usage:{prompt_tokens:10}}),
    activateRiskControl:async()=>assert.fail('one question must not lock all users'),
    answerRuling:async()=>assert.fail('locked request must not invoke final'),
  });
  const diagnostic = result.answer.debug.requestDiagnostics;
  assert.equal(diagnostic.scope.model,'fixture-model');
  assert.equal(diagnostic.scope.usage.prompt_tokens,10);
  assert.match(diagnostic.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(diagnostic).includes('private fixture question'),false);
});

test("an existing off-topic lock returns before scope classification, card work or ruling generation", async () => {
  const calls = [];
  const result = await answerPublicRulingQuestion({
    payload: { question: "这张卡的效果能发动吗？" },
    env: PUBLIC_ENV,
    appendAudit: async ({ question }) => calls.push(["audit", question]),
    readRiskControl: async () => ({
      ok: true,
      active: true,
      remainingMinutes: 9,
    }),
    classifyScope: async () => { calls.push("scope"); return { scope: "in_scope" }; },
    answerOfficialExact: async () => assert.fail("an active lock must skip exact matching"),
    answerRuling: async () => assert.fail("an active lock must skip card extraction, retrieval, and the ruling model"),
  });

  assert.equal(calls.filter(value => value === "scope").length, 0);
  assert.deepEqual(calls.filter(Array.isArray), [["audit", "这张卡的效果能发动吗？"]]);
  assert.equal(result.latency, null);
  assert.equal(result.answer.answerLevel, "risk_control");
  assert.match(result.answer.shortAnswer, /预计还需 9 分钟/u);
});

test("a confirmed out-of-scope request is refused locally without activating a global lock", async () => {
  const calls = [];
  const result = await answerPublicRulingQuestion({
    payload: { question: "帮我写一篇旅游攻略。" },
    env: PUBLIC_ENV,
    appendAudit: async () => calls.push("audit"),
    readRiskControl: async () => ({ ok: true, active: false }),
    classifyScope: async () => ({ scope: "out_of_scope", confidence: "high" }),
    answerOfficialExact: async () => null,
    activateRiskControl: async () => assert.fail("one question must not lock all users"),
    answerRuling: async () => assert.fail("a triggering request must skip ruling generation"),
  });

  assert.deepEqual(calls, ["audit"]);
  assert.equal(result.latency, null);
  assert.equal(result.answer.answerLevel, "out_of_scope");
  assert.equal(result.answer.debug.requestDiagnostics.scope.scope, "out_of_scope");
  assert.doesNotMatch(result.answer.shortAnswer, /自动关闭|23 分钟/u);
});

// The user tightened the public contract: uncertainty must no longer continue
// into paid retrieval, and one-question rejection must not depend on Redis.
test("out-of-scope requests never enter retrieval regardless of confidence, risk flag, storage or channel", async () => {
  for (const confidence of [undefined, "low", "medium", "high"]) {
    for (const scenario of ["disabled", "unconfigured", "write_failure"]) {
      for (const prepareForContinuation of [false, true]) {
        const env = scenario === "unconfigured" ? { MODEL_PROVIDER: "mock" }
          : { ...PUBLIC_ENV, ...(scenario === "disabled" ? { PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "false" } : {}) };
        let classified = 0;
        const result = await answerPublicRulingQuestion({
          payload: { question: "Synthetic question",
            ...(prepareForContinuation ? { action: "prepare" } : {}) },
          requestContext: { requestChannel: "unknown" },
          env, prepareForContinuation,
          appendAudit: async () => null,
          classifyScope: async () => { classified++; return { scope: "out_of_scope", confidence }; },
          readRiskControl: async () => ({ ok: true, active: false }),
          activateRiskControl: async () => { throw new Error("synthetic storage failure"); },
          // Local snapshot preparation may start before the admission decision; it
          // makes no model request. Paid downstream work must still never start.
          preloadAssets: () => ({}),
          startCardExtraction: () => assert.fail("rejected non-cloud question must not start card extraction"),
          answerOfficialExact: async () => assert.fail("rejected question must not match official questions"),
          answerRuling: async () => assert.fail("rejected question must not enter paid downstream work"),
        });
        assert.equal(classified, 1);
        assert.equal(result.answer.answerLevel, "out_of_scope");
        assert.equal(result.answer.reason, "not_ruling_question");
        assert.equal(result.answer.debug.requestDiagnostics.scope.scope, "out_of_scope");
      }
    }
  }
});

test("uncertain, malformed or failed scope checks pause with 503 and no downstream work", async () => {
  for (const decision of [null, { scope: "uncertain" }, { scope: "unknown" }, { scope: "out_of_scope_typo" }, "throws"]) {
    for (const prepareForContinuation of [false, true]) {
      await assert.rejects(answerPublicRulingQuestion({
        payload: { question: "Synthetic question", ...(prepareForContinuation ? { action: "prepare" } : {}) },
        env: { MODEL_PROVIDER: "mock", PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "false" },
        prepareForContinuation,
        appendAudit: async () => null,
        classifyScope: async () => {
          if (decision === "throws") throw new Error("sensitive provider detail must not escape");
          return decision;
        },
        preloadAssets: () => ({}),
        startCardExtraction: () => assert.fail("uncertain non-cloud question must not start card extraction"),
        readRiskControl: async () => assert.fail("scope failure must not need Redis"),
        activateRiskControl: async () => assert.fail("uncertain question must not lock other users"),
        answerRuling: async () => assert.fail("uncertain question must not enter downstream work"),
      }), (error) => {
        assert.equal(error.code, "public_query_scope_unavailable");
        assert.equal(error.statusCode, 503);
        assert.equal(error.requestDiagnostics.scope.scope, "uncertain");
        assert.doesNotMatch(JSON.stringify(error.requestDiagnostics), /sensitive provider detail/u);
        return true;
      });
    }
  }
});

test("the real disabled or unconfigured classifier cannot silently admit a public question", async () => {
  for (const extra of [{}, { PUBLIC_QUERY_SCOPE_CLASSIFIER_ENABLED: "false", DEEPSEEK_API_KEY: "unused-synthetic-key" }]) {
    await assert.rejects(answerPublicRulingQuestion({
      payload: { question: "Synthetic question" },
      env: { MODEL_PROVIDER: "mock", PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "false", ...extra },
      appendAudit: async () => null,
      preloadAssets: () => ({}),
      startCardExtraction: () => assert.fail("unavailable classifier must not start card extraction"),
      answerRuling: async () => assert.fail("unavailable classifier must not invoke downstream"),
    }), { code: "public_query_scope_unavailable", statusCode: 503 });
  }
});

test("only an explicit in-scope result enters downstream after the availability check succeeds", async () => {
  const calls = [];
  const result = await answerPublicRulingQuestion({
    payload: { question: "Synthetic question" }, env: PUBLIC_ENV,
    appendAudit: async () => null,
    classifyScope: async () => { calls.push("scope"); return { scope: "in_scope", confidence: "low" }; },
    readRiskControl: async () => { calls.push("lock"); return { ok: true, active: false }; },
    preloadAssets: () => { calls.push("preload"); return {}; },
    answerRuling: async () => { calls.push("downstream"); return { shortAnswer: "Synthetic ruling" }; },
  });
  // Local preload starts right after the availability check so it overlaps
  // the scope decision; downstream still waits for the explicit in-scope result.
  assert.deepEqual(calls, ["lock", "preload", "scope", "downstream"]);
  assert.equal(result.answer.shortAnswer, "Synthetic ruling");
  assert.equal(result.answer.debug.requestDiagnostics.scope.scope, "in_scope");
});

test("configured shared-control read failures stop before scope classification or downstream work", async () => {
  for (const readRiskControl of [async () => ({ ok: false, active: false }), async () => { throw new Error("synthetic storage error"); }]) {
    await assert.rejects(answerPublicRulingQuestion({
      payload: { question: "Synthetic question" }, env: PUBLIC_ENV,
      appendAudit: async () => null, readRiskControl,
      classifyScope: async () => assert.fail("failed availability check must not spend on classification"),
      preloadAssets: () => assert.fail("failed availability check must not preload"),
      answerRuling: async () => assert.fail("failed availability check must not enter downstream"),
    }), { code: "public_request_rate_limit_unavailable", statusCode: 503 });
  }
});

test("dry-run and server-owned private evaluation paths bypass public risk control", () => {
  assert.equal(shouldClassifyPublicQuestion({ RAG_DRY_RUN: "true" }), false);
  assert.equal(shouldClassifyPublicQuestion({ PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "false" }), true);
  assert.equal(shouldApplyPublicOfftopicRiskControl({ RAG_DRY_RUN: "true" }), false);
  assert.equal(shouldApplyPublicOfftopicRiskControl({
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_RUN_ID: "run-1234567890abcdef",
    HOST: "127.0.0.1",
  }), false);
  assert.equal(shouldApplyPublicOfftopicRiskControl({}), true);
  assert.equal(shouldApplyPublicOfftopicRiskControl({
    PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "false",
  }), false);
});

const CLOUD_PUBLIC_ENV = {
  ...PUBLIC_ENV,
  MODEL_PROVIDER: "bai",
  BAI_API_KEY: "synthetic-bai-key",
  PUBLIC_RULING_MODEL_PROFILE: "bai-astra-low",
  RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
  CLOUD_BUDGET_RUN_ID: "overlap-test",
  CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "1",
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: "1",
};

test("cloud questions start card-name extraction in parallel with the scope decision and hand it to the pipeline", async () => {
  const calls = [];
  let extractionSignal = null;
  const result = await answerPublicRulingQuestion({
    payload: { question: "Synthetic question" }, env: CLOUD_PUBLIC_ENV,
    appendAudit: async () => null,
    readRiskControl: async () => { calls.push("lock"); return { ok: true, active: false }; },
    preloadAssets: () => { calls.push("preload"); return { data: Promise.resolve({ cards: [] }) }; },
    startCardExtraction: ({ question, env, preloadedAssets, signal }) => {
      calls.push("card-extraction-start");
      assert.equal(question, "Synthetic question");
      assert.equal(env.RAG_EVIDENCE_PIPELINE, "cloud_evidence_v1");
      assert.ok(preloadedAssets?.data);
      extractionSignal = signal;
      return Promise.resolve({ cardNameModel: { modelUsed: "fixture-card-model" } });
    },
    classifyScope: async () => { calls.push("scope"); return { scope: "in_scope", confidence: "high" }; },
    answerRuling: async (options) => {
      calls.push("downstream");
      const early = await options.preloadedCardNameExtraction;
      assert.equal(early.cardNameModel.modelUsed, "fixture-card-model");
      assert.ok(options.cloudBudget, "the pipeline must reuse the budget scope that accounted the early extraction");
      return { shortAnswer: "Synthetic ruling" };
    },
  });
  assert.deepEqual(calls, ["lock", "preload", "card-extraction-start", "scope", "downstream"]);
  assert.equal(extractionSignal.aborted, false);
  assert.equal(result.answer.shortAnswer, "Synthetic ruling");
});

test("a denied cloud question aborts the early card-name extraction and never reaches the pipeline", async () => {
  for (const decision of [{ scope: "out_of_scope", confidence: "high" }, { scope: "uncertain" }]) {
    let extractionSignal = null;
    const outcome = answerPublicRulingQuestion({
      payload: { question: "Synthetic question" }, env: CLOUD_PUBLIC_ENV,
      appendAudit: async () => null,
      readRiskControl: async () => ({ ok: true, active: false }),
      preloadAssets: () => ({ data: Promise.resolve({ cards: [] }) }),
      startCardExtraction: ({ signal }) => { extractionSignal = signal; return new Promise(() => {}); },
      classifyScope: async () => decision,
      answerRuling: async () => assert.fail("denied question must not enter the pipeline"),
    });
    if (decision.scope === "out_of_scope") {
      const result = await outcome;
      assert.equal(result.answer.answerLevel, "out_of_scope");
    } else {
      await assert.rejects(outcome, { code: "public_query_scope_unavailable", statusCode: 503 });
    }
    assert.equal(extractionSignal.aborted, true, `${decision.scope} must abort the early extraction`);
  }
});

test("PUBLIC_CARD_EXTRACTION_OVERLAP_SCOPE=off keeps card-name extraction inside the pipeline", async () => {
  let downstream = null;
  await answerPublicRulingQuestion({
    payload: { question: "Synthetic question" },
    env: { ...CLOUD_PUBLIC_ENV, PUBLIC_CARD_EXTRACTION_OVERLAP_SCOPE: "off" },
    appendAudit: async () => null,
    readRiskControl: async () => ({ ok: true, active: false }),
    preloadAssets: () => ({ data: Promise.resolve({ cards: [] }) }),
    startCardExtraction: () => assert.fail("overlap is disabled"),
    classifyScope: async () => ({ scope: "in_scope", confidence: "high" }),
    answerRuling: async (options) => { downstream = options; return { shortAnswer: "Synthetic ruling" }; },
  });
  assert.equal(downstream.preloadedCardNameExtraction, undefined);
  assert.ok(downstream.cloudBudget);
});
