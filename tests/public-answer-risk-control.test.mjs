import assert from "node:assert/strict";
import test from "node:test";

import {
  answerPublicRulingQuestion,
  shouldApplyPublicOfftopicRiskControl,
} from "../backend/publicAnswerService.mjs";

const PUBLIC_ENV = {
  MODEL_PROVIDER: "mock",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

test("an existing off-topic lock is returned before classification or ruling generation", async () => {
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
    classifyScope: async () => assert.fail("an active lock must skip classification"),
    answerOfficialExact: async () => null,
    answerRuling: async () => assert.fail("an active lock must skip the ruling model"),
  });

  assert.deepEqual(calls, [["audit", "这张卡的效果能发动吗？"]]);
  assert.equal(result.latency, null);
  assert.equal(result.answer.answerLevel, "risk_control");
  assert.match(result.answer.shortAnswer, /预计还需 9 分钟/u);
});

test("one high-confidence out-of-scope request activates the global lock", async () => {
  const calls = [];
  const result = await answerPublicRulingQuestion({
    payload: { question: "帮我写一篇旅游攻略。" },
    env: PUBLIC_ENV,
    appendAudit: async () => calls.push("audit"),
    readRiskControl: async () => ({ ok: true, active: false }),
    classifyScope: async () => ({ scope: "out_of_scope", confidence: "high" }),
    answerOfficialExact: async () => null,
    activateRiskControl: async () => {
      calls.push("activate");
      return {
        ok: true,
        active: true,
        triggered: true,
        remainingMinutes: 23,
      };
    },
    answerRuling: async () => assert.fail("a triggering request must skip ruling generation"),
  });

  assert.deepEqual(calls, ["audit", "activate"]);
  assert.equal(result.latency, null);
  assert.equal(result.answer.answerLevel, "risk_control");
  assert.match(result.answer.shortAnswer, /自动关闭 23 分钟/u);
});

test("uncertain classification and storage failure both fail open to the normal ruling path", async () => {
  for (const scenario of ["uncertain", "storage_failure"]) {
    let classifications = 0;
    let generations = 0;
    const result = await answerPublicRulingQuestion({
      payload: { question: "这张卡和那个效果如何处理？" },
      env: PUBLIC_ENV,
      appendAudit: async () => null,
      readRiskControl: async () => scenario === "uncertain"
        ? { ok: true, active: false }
        : { ok: false, active: false, failOpen: true },
      classifyScope: async () => {
        classifications += 1;
        return { scope: "uncertain", confidence: "low" };
      },
      answerOfficialExact: async (options) => {
        options.onOfficialQaExactTiming(12);
        return null;
      },
      activateRiskControl: async () => assert.fail("an uncertain decision must not lock"),
      answerRuling: async (options) => {
        assert.equal(options.officialQaExactAlreadyChecked, true);
        generations += 1;
        return { answerLevel: "rule_analysis", shortAnswer: "正常回答" };
      },
    });

    assert.equal(result.answer.shortAnswer, "正常回答");
    assert.equal(generations, 1);
    assert.equal(classifications, scenario === "uncertain" ? 1 : 0);
    assert.ok(Number.isFinite(result.latency.durationMs));
    assert.equal(result.answer.debug.timingsMs.officialQaExact, 12);
    assert.ok(Number.isFinite(result.answer.debug.timingsMs.total));
  }
});

test("an exact official Q&A bypasses risk classification and ruling generation", async () => {
  const exact = {
    mode: "rag_baseline",
    answerLevel: "official_confirmed",
    shortAnswer: "公式回答",
    debug: { route: "official_qa_exact_direct", providerUsed: "none", modelUsed: "none" },
  };
  const result = await answerPublicRulingQuestion({
    payload: { question: "公式データベースの質問原文" },
    env: PUBLIC_ENV,
    appendAudit: async () => null,
    answerOfficialExact: async (options) => {
      options.onOfficialQaExactTiming(7);
      return exact;
    },
    readRiskControl: async () => assert.fail("exact official Q&A must bypass the risk lock"),
    classifyScope: async () => assert.fail("exact official Q&A must bypass classification"),
    answerRuling: async () => assert.fail("exact official Q&A must bypass ruling generation"),
  });

  assert.equal(result.answer.shortAnswer, exact.shortAnswer);
  assert.equal(result.answer.debug.route, exact.debug.route);
  assert.equal(result.answer.debug.timingsMs.officialQaExact, 7);
  assert.ok(Number.isFinite(result.answer.debug.timingsMs.total));
  assert.equal(result.latency, null);
});

test("dry-run and server-owned private evaluation paths bypass public risk control", () => {
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
