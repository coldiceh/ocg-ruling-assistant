import assert from "node:assert/strict";
import test from "node:test";

import { requestOcgEngineSimulation } from "../backend/ocgEngineClient.mjs";
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

test("ordinary RAG question automatically submits a best-effort engine scenario", async () => {
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

  assert.equal(submittedScenario.bestEffort, true);
  assert.ok(submittedScenario.setup.cards.some((card) => card.code === 12345678));
  assert.equal(result.engine.status, "completed");
  assert.equal(result.engine.bestEffort, true);
  assert.equal(result.engine.scenarioSource, "auto_best_effort");
  assert.equal(result.engineSimulation.canConfirmOfficialRuling, false);
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
  assert.equal(result.engine.status, "not_requested");
  assert.equal(result.engineSimulation, null);
  assert.equal(result.riskFlags.some((flag) => flag.startsWith("engine_")), false);
});
