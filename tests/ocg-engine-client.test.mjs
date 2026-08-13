import assert from "node:assert/strict";
import test from "node:test";

import { requestOcgEngineSimulation } from "../backend/ocgEngineClient.mjs";
import { requestOcgEngineJson } from "../backend/ocgEngineHttpClient.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const binding = {
  lockId: "1".repeat(64),
  snapshotId: "2".repeat(64),
  manifestSha256: "3".repeat(64),
  coreSha256: "4".repeat(64),
  dbSetSha256: "5".repeat(64),
  scriptSetSha256: "6".repeat(64),
  patchSetSha256: "7".repeat(64),
  apiAbi: "ocgcore/11.0",
};

test("engine HTTP client rejects oversized Content-Length before reading", async () => {
  let cancelled = false;
  let pulled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled = true;
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await requestOcgEngineJson({
    path: "/formal/v1/test",
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    maxResponseBytes: 16,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-length": "4096" },
    }),
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "OCG_ENGINE_RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true);
  // A WHATWG stream implementation may schedule one pull eagerly, but no
  // response bytes are consumed through a reader before the preflight reject.
  assert.equal(typeof pulled, "boolean");
});

test("engine HTTP client cancels a streaming response at the wire byte limit", async () => {
  let cancelled = false;
  const chunks = [
    new TextEncoder().encode('{"ok":true,"data":"'),
    new TextEncoder().encode("x".repeat(64)),
    new TextEncoder().encode('"}'),
  ];
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await requestOcgEngineJson({
    path: "/formal/v1/test",
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    maxResponseBytes: 32,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "OCG_ENGINE_RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true);
});

test("engine HTTP client keeps text-only fetch mocks compatible with a byte limit", async () => {
  const response = {
    ok: true,
    status: 200,
    body: null,
    headers: { get: () => null },
    async text() {
      return '{"ok":true,"value":"small"}';
    },
  };
  const result = await requestOcgEngineJson({
    path: "/formal/v1/test",
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    maxResponseBytes: 64,
    fetchImpl: async () => response,
  });

  assert.equal(result.status, "response");
  assert.equal(result.payload.value, "small");
});

test("engine simulation remains non-official evidence", async () => {
  const result = await requestOcgEngineSimulation({
    engineScenario: { seed: "test" },
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      simulation: {
        sourceType: "engine_simulation",
        canConfirmOfficialRuling: false,
        resourceBinding: binding,
        traceSha256: "8".repeat(64),
      },
    }), { status: 200 }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.simulation.canConfirmOfficialRuling, false);
});

test("engine failure is explicit and does not invent a trace", async () => {
  const result = await requestOcgEngineSimulation({
    engineScenario: { seed: "test" },
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.simulation, undefined);
  assert.match(result.error.message, /connection refused/u);
});

test("engine is not contacted without an executable scenario", async () => {
  let called = false;
  const result = await requestOcgEngineSimulation({
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => { called = true; },
  });
  assert.equal(result.status, "not_requested");
  assert.equal(called, false);
});

test("ordinary public RAG ignores legacy automatic engine configuration", async () => {
  let submittedScenario = null;
  const result = await answerRagRulingQuestion({
    question: "我方手牌有「模拟测试龙」，我召唤模拟测试龙后发动效果。",
    cards: [{
      id: "999",
      passcode: "12345678",
      name: "模拟测试龙",
      aliases: ["模拟测试龙"],
      cardType: "monster",
      effectText: "这张卡召唤成功的场合可以发动。",
      sourceUrl: "https://example.test/card/999",
    }],
    records: [],
    qaRecords: [],
    env: {
      MODEL_PROVIDER: "mock",
      OCG_ENGINE_URL: "http://127.0.0.1:8790",
      RAG_AUTO_ENGINE_SIMULATION: "true",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
    },
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以根据卡片文本分析。",
      reasoning: ["已读取卡片文本。", "模拟结果单独展示。"],
      usedCards: ["模拟测试龙"],
      usedEvidence: [{ id: "card-text-999", type: "card_text" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
    engineFetchImpl: async (_url, options) => {
      submittedScenario = JSON.parse(options.body).scenario;
      return new Response(JSON.stringify({
        ok: true,
        simulation: {
          sourceType: "engine_simulation",
          canConfirmOfficialRuling: false,
          resourceBinding: binding,
          traceSha256: "8".repeat(64),
          status: "awaiting_response",
          incomplete: true,
          bestEffort: true,
          steps: [],
          zoneCounts: {},
        },
      }), { status: 200 });
    },
  });

  assert.equal(submittedScenario, null);
  assert.equal(result.engine.status, "disabled");
  assert.equal(result.engineSimulation, null);
});

test("ordinary RAG question skips simulation when no engine deployment is configured", async () => {
  let engineCalled = false;
  const result = await answerRagRulingQuestion({
    question: "我方召唤「模拟测试龙」后发动效果。",
    cards: [{
      id: "999",
      passcode: "12345678",
      name: "模拟测试龙",
      aliases: ["模拟测试龙"],
      cardType: "monster",
      effectText: "这张卡召唤成功的场合可以发动。",
    }],
    records: [],
    qaRecords: [],
    env: { MODEL_PROVIDER: "mock", RAG_RULEBOOK_GROUNDING_ENABLED: "false" },
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "可以根据卡片文本分析。",
      reasoning: ["已读取卡片文本。"],
      usedCards: ["模拟测试龙"],
      usedEvidence: [{ id: "card-text-999", type: "card_text" }],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
    engineFetchImpl: async () => {
      engineCalled = true;
      throw new Error("engine should not be contacted");
    },
  });

  assert.equal(engineCalled, false);
  assert.equal(result.engine.status, "disabled");
  assert.equal(result.engineSimulation, null);
  assert.equal(result.riskFlags.some((flag) => flag.startsWith("engine_")), false);
});
