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
    answerRuling: async () => assert.fail("an active lock must skip the ruling model"),
  });

  assert.deepEqual(calls, [["audit", "这张卡的效果能发动吗？"]]);
  assert.equal(result.latency, null);
  assert.equal(result.answer.answerLevel, "risk_control");
  assert.match(result.answer.shortAnswer, /9 分钟后再提交问题/u);
});

test("one high-confidence out-of-scope request activates the global lock", async () => {
  const calls = [];
  const result = await answerPublicRulingQuestion({
    payload: { question: "帮我写一篇旅游攻略。" },
    env: PUBLIC_ENV,
    appendAudit: async () => calls.push("audit"),
    readRiskControl: async () => ({ ok: true, active: false }),
    classifyScope: async () => ({ scope: "out_of_scope", confidence: "high" }),
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
      activateRiskControl: async () => assert.fail("an uncertain decision must not lock"),
      answerRuling: async () => {
        generations += 1;
        return { answerLevel: "rule_analysis", shortAnswer: "正常回答" };
      },
    });

    assert.equal(result.answer.shortAnswer, "正常回答");
    assert.equal(generations, 1);
    assert.equal(classifications, scenario === "uncertain" ? 1 : 0);
    assert.ok(Number.isFinite(result.latency.durationMs));
  }
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
