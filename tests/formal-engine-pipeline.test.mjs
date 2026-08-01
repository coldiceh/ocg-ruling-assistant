import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyFormalAnswerGate } from "../backend/formalEngineShadow.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import { planFormalScenario } from "../backend/formalScenarioPlanner.mjs";
import { makeCapabilities, makeFormalResult, materializeFixture, mockPublicProofVerifier } from "./helpers/formal-engine-mock.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/real-three-card.json", import.meta.url), "utf8"));
const input = materializeFixture(fixture);
const plannedScenario = planFormalScenario({
  scenarioDraft: input.draft,
  userQuery: input.question,
  resolvedCards: input.resolvedCards,
}).scenario;
const names = {
  "real-card-chaos-magician": "混沌の黒魔術師",
  "real-card-perished-magician": "滅びの黒魔術師",
  "real-card-abyss-swordsoul": "深淵の相剣龍",
};
const cards = input.resolvedCards.map((card) => ({
  ...card,
  id: card.cardId,
  name: names[card.cardId],
  aliases: [names[card.cardId]],
  effectText: `${names[card.cardId]} 的测试卡片文本。`,
}));

function formalEndpointMock(verdicts, events) {
  let capabilities;
  return async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/formal/v1/capabilities") {
      const body = JSON.parse(options.body || "null");
      assert.equal(body, null);
      capabilities = makeCapabilities(plannedScenario.requiredCapabilities);
      events.push("formal-capabilities");
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (pathname === "/formal/v1/analyze-scenario") {
      const scenario = JSON.parse(options.body).scenario;
      const result = makeFormalResult(scenario, capabilities, verdicts);
      events.push("formal-analysis");
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    throw new Error(`unexpected formal URL: ${url}`);
  };
}

async function answerWithFormal(verdicts, {
  draft = input.draft,
  modelShortAnswer = "错误模型结论：两问都不能。",
  modelReasoning = ["错误地把召唤手续的除外当成最终移动归因。", "错误地把未证明当成不能。"],
  qaRecords = [],
  formalFetchImpl,
} = {}) {
  const events = [];
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords,
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      RAG_AUTO_ENGINE_SIMULATION: "false",
      OCG_ENGINE_URL: "http://formal.test",
    },
    formalScenarioDraft: draft,
    formalFetchImpl: formalFetchImpl || formalEndpointMock(verdicts, events),
    formalProofVerifier: mockPublicProofVerifier,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 404 }),
    modelInvoker: async ({ prompt }) => {
      events.push("final-model");
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: modelShortAnswer,
        reasoning: modelReasoning,
        usedCards: Object.values(names),
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "high",
      });
    },
  });
  return { answer, events, finalPrompt };
}

function exactOfficialQa(answer) {
  return {
    id: "ygoresources-qa-formal-gate",
    recordType: "qa",
    question: input.question,
    answer,
    text: `${input.question}\n${answer}`,
    cardIds: cards.map((card) => card.id),
    questionCardIds: cards.map((card) => card.id),
    sourceType: "official_qa",
    evidenceStatus: "current",
    sourceUrl: "https://example.test/official/formal-gate",
  };
}

test("verified formal claims enter the final prompt before the model and gate both query answers", async () => {
  const { answer, events, finalPrompt } = await answerWithFormal({
    "q1-summon-procedure": "TRUE",
    "q2-hand-trigger": "TRUE",
  });
  assert.deepEqual(events, ["formal-capabilities", "formal-analysis", "final-model"], JSON.stringify(answer.formalEngine));
  assert.match(finalPrompt, /formalEngineProofs/u);
  assert.match(finalPrompt, /q1-summon-procedure/u);
  assert.match(finalPrompt, /q2-hand-trigger/u);
  assert.match(answer.shortAnswer, /特殊召唤/u);
  assert.match(answer.shortAnswer, /深淵の相剣龍/u);
  assert.doesNotMatch(answer.shortAnswer, /两问都不能/u);
  assert.deepEqual(answer.formalEngine.queryResults.map((item) => item.verdict), ["TRUE", "TRUE"]);
  assert.equal(answer.formalEngine.queryResults.every((item) => item.certificateVerified), true);
});

test("formal UNKNOWN is preserved and cannot be rewritten as a definite negative", async () => {
  const { answer } = await answerWithFormal({
    "q1-summon-procedure": "TRUE",
    "q2-hand-trigger": "UNKNOWN",
  });
  assert.equal(answer.formalEngine.queryResults[1].verdict, "UNKNOWN");
  assert.doesNotMatch(answer.shortAnswer, /两问都不能|深淵の相剣龍.*(?:不可以发动|不能发动)/u);
  assert.match(answer.shortAnswer, /特殊召唤.*形式证明已通过校验/u);
  assert.match(answer.shortAnswer, /深淵の相剣龍.*未签发确定性证明\/UNKNOWN/u);
  assert.equal(answer.formalQueryResults.length, 2);
  assert.equal(answer.formalQueryResults.find((item) => item.queryId === "q2-hand-trigger").verdict, "UNKNOWN");
});

test("formal UNKNOWN symmetrically blocks a model's definite positive answer and preserves every query", async () => {
  const { answer } = await answerWithFormal({
    "q1-summon-procedure": "UNKNOWN",
    "q2-hand-trigger": "UNKNOWN",
  }, {
    modelShortAnswer: "错误模型结论：两问都可以。",
  });
  assert.doesNotMatch(answer.shortAnswer, /两问都可以/u);
  assert.equal(answer.shortAnswer.match(/未签发确定性证明\/UNKNOWN/gu)?.length, 2);
  assert.equal(answer.formalQueryResults.length, 2);
  assert.equal(answer.formalQueryResults.every((item) => item.verdict === "UNKNOWN"), true);
  assert.deepEqual(answer.formalQueryResults.map((item) => item.queryId), ["q1-summon-procedure", "q2-hand-trigger"]);
  assert.equal(new Set(answer.formalQueryResults.map((item) => item.queryId)).size, 2);
  assert.equal(answer.riskFlags.some((item) => item.startsWith("formal_engine_unknown_blocked_model_")), true);
  assert.equal(answer.confidenceSelfEstimate, "low");
});

test("UNKNOWN also blocks definitive claims hidden in model reasoning", async () => {
  const { answer } = await answerWithFormal({
    "q1-summon-procedure": "UNKNOWN",
    "q2-hand-trigger": "UNKNOWN",
  }, {
    modelShortAnswer: "目前仅能继续核对。",
    modelReasoning: ["其实两项都可以发动并正常处理。"],
  });
  assert.doesNotMatch(answer.reasoning.join("\n"), /其实两项都可以发动/u);
  assert.equal(answer.riskFlags.includes("formal_engine_unknown_blocked_model_positive"), true);
});

test("formal UNKNOWN never replaces an exact official answer and remains an explicit diagnostic", async () => {
  const official = {
    answerLevel: "official_confirmed",
    shortAnswer: "官方直接回答：可以依次处理这两个操作。",
    reasoning: ["官方直接依据已命中。"],
    confidenceSelfEstimate: "high",
    usedEvidence: [{ id: "official-direct", type: "official_qa" }],
    riskFlags: [],
  };
  const answer = applyFormalAnswerGate(official, [
    {
      queryId: "q1-summon-procedure",
      claimText: "第一问",
      verdict: "UNKNOWN",
      trusted: false,
      unknownReasons: [{ code: "MISSING_STATE_FACT" }],
    },
    {
      queryId: "q2-hand-trigger",
      claimText: "第二问",
      verdict: "UNKNOWN",
      trusted: false,
      unknownReasons: [{ code: "CAPABILITY_UNAVAILABLE" }],
    },
  ], { preserveAuthoritativeAnswer: true });

  assert.equal(answer.answerLevel, official.answerLevel);
  assert.equal(answer.shortAnswer, official.shortAnswer);
  assert.equal(answer.confidenceSelfEstimate, official.confidenceSelfEstimate);
  assert.equal(answer.reasoning.some((item) => /未签发确定性证明/u.test(item)), true);
  assert.deepEqual(answer.formalQueryResults.map((item) => item.queryId), ["q1-summon-procedure", "q2-hand-trigger"]);
  assert.equal(answer.riskFlags.some((item) => item.includes("blocked_model")), false);
});

test("formal transport errors preserve exact official answers and expose only code and stage", async () => {
  const secretMessage = "private endpoint message and internal details";
  const { answer } = await answerWithFormal({}, {
    formalFetchImpl: async () => {
      throw new Error(secretMessage);
    },
  });

  assert.equal(answer.reasoning.some((item) => /未签发确定性证明/u.test(item)), true);
  assert.deepEqual(Object.keys(answer.formalEngine.error).sort(), ["code", "stage"]);
  assert.doesNotMatch(JSON.stringify({
    formalEngine: answer.formalEngine,
    formalQueryResults: answer.formalQueryResults,
  }), new RegExp(secretMessage, "u"));
});

test("ABSTRACT_ASSUMPTIONS results remain UNKNOWN and never become authority", async () => {
  const draft = structuredClone(input.draft);
  draft.mode = "ABSTRACT_ASSUMPTIONS";
  draft.assumptions = [{
    assumptionId: "assume-spell-effect-used",
    type: "ASSUME_STATE_FACT",
    assumesFactId: "spell-effect-used-this-turn",
    sourceSpan: structuredClone(draft.stateFacts[0].sourceSpan),
  }];
  const { answer } = await answerWithFormal({
    "q1-summon-procedure": "TRUE",
    "q2-hand-trigger": "TRUE",
  }, { draft, modelShortAnswer: "错误模型结论：两问都可以。" });

  assert.equal(answer.formalQueryResults.length, 2);
  assert.equal(answer.formalQueryResults.every((item) => item.trusted === false && item.verdict === "UNKNOWN"), true);
  assert.equal(answer.shortAnswer.match(/未签发确定性证明\/UNKNOWN/gu)?.length, 2);
  assert.doesNotMatch(answer.shortAnswer, /形式证明已通过校验/u);
  assert.equal(answer.answerLevel, "low_confidence_analysis");
  assert.equal(answer.riskFlags.some((item) => item.startsWith("formal_engine_unknown:")), true);
});

test("formal shadow disabled leaves the public answer path available", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「测试卡」可以发动吗？",
    cards: [{ id: "test", name: "测试卡", aliases: ["测试卡"], effectText: "主要阶段可以发动。" }],
    records: [],
    qaRecords: [],
    env: { RAG_FORMAL_ENGINE_MODE: "off", RAG_AUTO_ENGINE_SIMULATION: "false" },
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "根据现有卡片文本继续分析。",
      reasoning: ["读取卡片文本。", "未使用形式内核。"],
      usedCards: ["测试卡"],
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });
  assert.equal(answer.formalEngine.status, "disabled");
  assert.match(answer.shortAnswer, /继续分析/u);
});
