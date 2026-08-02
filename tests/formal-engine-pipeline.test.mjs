import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyFormalAnswerGate, runFormalEngineShadow } from "../backend/formalEngineShadow.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import {
  createDefaultFormalScenarioDraftInvoker,
  materializeFormalDraftSourceSpans,
} from "../backend/formalScenarioDraftModel.mjs";
import { planFormalScenario } from "../backend/formalScenarioPlanner.mjs";
import {
  makeCapabilities,
  makeFormalResult,
  materializeFixture,
  mockPublicProofVerifier,
  mockScenarioDraftCompletenessVerifier,
} from "./helpers/formal-engine-mock.mjs";

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
const mockDraftVerifierEnv = Object.freeze({
  RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_ID: "mock-scenario-draft-completeness-verifier",
  RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_VERSION: "mock-scenario-draft-completeness/v1",
});
const cards = input.resolvedCards.map((card) => ({
  ...card,
  id: card.cardId,
  name: names[card.cardId],
  aliases: [names[card.cardId]],
  effectText: `${names[card.cardId]} 的测试卡片文本。`,
}));

function makeDraftBindingCard({
  cardId = "card-a",
  snapshotId = "snapshot:v1",
  formalEffects,
} = {}) {
  return {
    cardId,
    name: `测试卡-${cardId}`,
    effectText: "测试用印刷文本。",
    formalDefinitionId: `definition:${cardId}`,
    formalDefinitionSnapshotId: snapshotId,
    formalDefinitionContentSha256: "a".repeat(64),
    formalEffects: formalEffects ?? [{
      effectId: `effect-${cardId}`,
      definitionEffectId: `definition-effect:${cardId}`,
      definitionEffectSha256: "b".repeat(64),
    }],
  };
}

function asModelScenarioDraft(materializedDraft) {
  const candidate = structuredClone(materializedDraft);
  const sourceText = String(materializedDraft.question?.text || "");
  for (const collectionName of ["cardInstances", "stateFacts", "eventHistory", "intents", "queries", "assumptions"]) {
    for (const item of candidate[collectionName] || []) {
      const { start, text } = item.sourceSpan;
      item.sourceQuote = text;
      const starts = [];
      let offset = 0;
      while (offset <= sourceText.length - text.length) {
        const index = sourceText.indexOf(text, offset);
        if (index < 0) break;
        starts.push(index);
        offset = index + 1;
      }
      if (starts.length > 1) item.sourceOccurrence = starts.indexOf(start);
      delete item.sourceSpan;
    }
  }
  return candidate;
}

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
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      OCG_ENGINE_URL: "http://formal.test",
    },
    formalScenarioDraft: draft,
    formalFetchImpl: formalFetchImpl || formalEndpointMock(verdicts, events),
    formalProofVerifier: mockPublicProofVerifier,
    formalScenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
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
  assert.deepEqual(answer.formalEngine.draftVerification, {
    valid: true,
    code: null,
    verifierId: "mock-scenario-draft-completeness-verifier",
    verifierVersion: "mock-scenario-draft-completeness/v1",
    expectedVerifierId: "mock-scenario-draft-completeness-verifier",
    expectedVerifierVersion: "mock-scenario-draft-completeness/v1",
  });
  assert.match(finalPrompt, /mock-scenario-draft-completeness-verifier/u);
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

test("caller-authored formal evidence cannot inject authority or diagnostics", async () => {
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
  assert.deepEqual(answer.reasoning, official.reasoning);
  assert.equal(answer.formalQueryResults, undefined);
  assert.equal(answer.riskFlags.includes("formal_engine_evidence_rejected_unverified_origin"), true);
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

test("default draft extractor emits only a source-bound unverified candidate", async () => {
  const question = "😀自己场上存在「怪兽甲」，是否可以用其手续特殊召唤「怪兽乙」？";
  const calls = [];
  const controller = new AbortController();
  const candidate = {
    scenarioId: "generic-draft",
    turn: { activePlayer: "SELF", phase: "MAIN1" },
    cardInstances: [{
      instanceId: "card-a@0",
      objectEpoch: 0,
      cardId: "card-a",
      effectIds: ["procedure-a"],
      owner: "SELF",
      controller: "SELF",
      zone: "MONSTER_ZONE",
      position: "FACE_UP_ATTACK",
      sourceQuote: "「怪兽甲」",
    }],
    stateFacts: [{
      factId: "present-a",
      type: "CARD_PRESENT",
      provenance: "USER_OBSERVED",
      subjectInstanceId: "card-a@0",
      value: true,
      sourceQuote: "自己场上存在「怪兽甲」",
    }],
    eventHistory: [],
    intents: [{
      intentId: "summon-b",
      type: "TRY_SUMMON_PROCEDURE",
      actorInstanceId: "card-a@0",
      procedureId: "procedure-a",
      procedureInputInstanceIds: [],
      sourceQuote: "是否可以用其手续特殊召唤「怪兽乙」",
    }],
    queries: [{
      queryId: "q1",
      predicate: "PROCEDURE_AVAILABLE",
      intentId: "summon-b",
      sourceQuote: "是否可以用其手续特殊召唤「怪兽乙」",
    }],
    assumptions: [],
    missingStateFacts: [],
    requiredCapabilities: [],
  };
  const invoke = createDefaultFormalScenarioDraftInvoker({
    env: { DEEPSEEK_API_KEY: "test-key" },
    fetchImpl: async () => { throw new Error("network must be replaced by the task invoker"); },
    jsonTaskInvoker: async (request) => {
      calls.push(request);
      return { scenarioDraft: candidate, rawText: "must-not-enter-the-draft", usage: { completion_tokens: 1 } };
    },
  });
  const result = await invoke({
    userQuery: question,
    signal: controller.signal,
    cardResolution: { unresolvedMentions: [], ambiguousMentions: [], omittedCards: [] },
    resolvedCards: [{
      cardId: "card-a",
      name: "怪兽甲",
      effectText: "测试用印刷文本。",
      formalDefinitionId: "definition:card-a",
      formalDefinitionSnapshotId: "snapshot:v1",
      formalDefinitionContentSha256: "a".repeat(64),
      formalEffects: [{
        effectId: "procedure-a",
        definitionEffectId: "effect:card-a:procedure",
        definitionEffectSha256: "b".repeat(64),
      }],
    }],
  });

  assert.equal(result.draftProvenance, "MODEL_EXTRACTED_UNVERIFIED");
  assert.equal(result.scenarioDraft.cardInstances[0].sourceSpan.start, question.indexOf("「怪兽甲」"));
  assert.equal(result.scenarioDraft.cardInstances[0].sourceSpan.text, "「怪兽甲」");
  assert.equal(Object.hasOwn(result.scenarioDraft, "rawText"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trackPublicBudget, true);
  assert.equal(calls[0].signal.aborted, false);
  controller.abort("request-cancelled");
  assert.equal(calls[0].signal.aborted, true);
  assert.match(calls[0].prompt, /UTF16_CODE_UNIT_HALF_OPEN/u);
  assert.match(calls[0].prompt, /MODEL|formal engine alone/iu);
  assert.match(calls[0].prompt, /card-a/u);
  for (const field of ["banishedByCardEffect", "summonLegal", "triggerActivates", "verdict", "proofCertificate"]) {
    assert.match(calls[0].prompt, new RegExp(field, "u"));
  }
});

test("source-quote binding rejects an ambiguous occurrence instead of guessing", () => {
  assert.throws(
    () => materializeFormalDraftSourceSpans({
      cardInstances: [{ sourceQuote: "怪兽甲" }],
      stateFacts: [],
      eventHistory: [],
      intents: [],
      queries: [],
      assumptions: [],
    }, "怪兽甲与怪兽甲"),
    (error) => error.code === "FORMAL_SOURCE_SPAN_INVALID",
  );
});

test("default source binding rejects model-provided offsets", () => {
  assert.throws(
    () => materializeFormalDraftSourceSpans({
      cardInstances: [{
        sourceQuote: "怪兽甲",
        sourceSpan: { encoding: "UTF16_CODE_UNIT_HALF_OPEN", start: 0, end: 3, text: "怪兽甲" },
      }],
      stateFacts: [],
      eventHistory: [],
      intents: [],
      queries: [],
      assumptions: [],
    }, "怪兽甲"),
    (error) => error.code === "FORMAL_SOURCE_SPAN_INVALID" && /derived by the server/u.test(error.message),
  );
});

test("source-quote binding counts overlapping occurrences", () => {
  const draft = materializeFormalDraftSourceSpans({
    cardInstances: [{ sourceQuote: "aa", sourceOccurrence: 1 }],
    stateFacts: [],
    eventHistory: [],
    intents: [],
    queries: [],
    assumptions: [],
  }, "aaa");
  assert.equal(draft.cardInstances[0].sourceSpan.start, 1);
  assert.equal(draft.cardInstances[0].sourceSpan.end, 3);
});

test("default draft extractor rejects invalid formal bindings before any model call", async (t) => {
  const cases = [
    {
      name: "duplicate cardId",
      cards: [makeDraftBindingCard(), makeDraftBindingCard()],
      code: "FORMAL_DEFINITION_BINDING_MISSING",
    },
    {
      name: "inconsistent snapshots",
      cards: [
        makeDraftBindingCard({ cardId: "card-a", snapshotId: "snapshot:v1" }),
        makeDraftBindingCard({ cardId: "card-b", snapshotId: "snapshot:v2" }),
      ],
      code: "FORMAL_DEFINITION_SNAPSHOT_INVALID",
    },
    {
      name: "missing snapshot",
      cards: [makeDraftBindingCard({ snapshotId: "" })],
      code: "FORMAL_DEFINITION_SNAPSHOT_INVALID",
    },
    {
      name: "incomplete effect binding",
      cards: [makeDraftBindingCard({
        formalEffects: [{ effectId: "effect-a", definitionEffectId: "", definitionEffectSha256: "short" }],
      })],
      code: "FORMAL_DEFINITION_BINDING_MISSING",
    },
    {
      name: "missing effectId",
      cards: [makeDraftBindingCard({
        formalEffects: [{ definitionEffectId: "definition-effect:a", definitionEffectSha256: "b".repeat(64) }],
      })],
      code: "FORMAL_DEFINITION_BINDING_MISSING",
    },
    {
      name: "duplicate effectId",
      cards: [makeDraftBindingCard({
        formalEffects: [
          { effectId: "effect-a", definitionEffectId: "definition-effect:a:1", definitionEffectSha256: "b".repeat(64) },
          { effectId: "effect-a", definitionEffectId: "definition-effect:a:2", definitionEffectSha256: "c".repeat(64) },
        ],
      })],
      code: "FORMAL_DEFINITION_BINDING_MISSING",
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      let calls = 0;
      const invoke = createDefaultFormalScenarioDraftInvoker({
        env: { DEEPSEEK_API_KEY: "test-key" },
        jsonTaskInvoker: async () => { calls += 1; return {}; },
      });
      await assert.rejects(
        invoke({
          userQuery: "测试问题",
          resolvedCards: fixtureCase.cards,
          cardResolution: { unresolvedMentions: [], ambiguousMentions: [], omittedCards: [] },
        }),
        (error) => error.code === fixtureCase.code,
      );
      assert.equal(calls, 0);
    });
  }
});

test("default draft extractor without a server-side key fails closed before invoking a model", async () => {
  let calls = 0;
  const invoke = createDefaultFormalScenarioDraftInvoker({
    env: {},
    jsonTaskInvoker: async () => { calls += 1; return {}; },
  });
  await assert.rejects(
    invoke({ userQuery: "测试问题", resolvedCards: [] }),
    (error) => error.code === "FORMAL_SCENARIO_DRAFT_UNAVAILABLE",
  );
  assert.equal(calls, 0);
});

test("production default draft path probes capabilities before spending a model call and requires completeness verification", async () => {
  const events = [];
  let capabilities;
  const formalFetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/formal/v1/capabilities") {
      events.push("formal-capabilities");
      capabilities = makeCapabilities(plannedScenario.requiredCapabilities);
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (pathname === "/formal/v1/analyze-scenario") {
      events.push("formal-analysis");
      const scenario = JSON.parse(options.body).scenario;
      return new Response(JSON.stringify({
        ok: true,
        result: makeFormalResult(scenario, capabilities, {
          "q1-summon-procedure": "TRUE",
          "q2-hand-trigger": "TRUE",
        }),
      }), { status: 200 });
    }
    throw new Error(`unexpected formal URL: ${url}`);
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("/chat/completions")) {
      events.push("draft-model");
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ scenarioDraft: asModelScenarioDraft(input.draft) }) },
        }],
        usage: {},
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      DEEPSEEK_API_KEY: "draft-test-key",
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl,
    formalFetchImpl,
    formalProofVerifier: mockPublicProofVerifier,
    formalScenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    modelInvoker: async () => {
      events.push("final-model");
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "模型结论等待形式门禁。",
        reasoning: ["测试默认草案接线。"],
        usedCards: Object.values(names),
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.deepEqual(
    events,
    ["formal-capabilities", "draft-model", "formal-analysis", "final-model"],
    JSON.stringify({ formalEngine: answer.formalEngine, unresolvedMentions: answer.debug?.unresolvedMentions }),
  );
  assert.equal(answer.formalEngine.draftVerification.valid, true);
  assert.deepEqual(answer.formalEngine.queryResults.map((item) => item.verdict), ["TRUE", "TRUE"]);
});

test("a model-extracted draft without an independent completeness verifier stays UNKNOWN", async () => {
  const events = [];
  const formalFetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/formal/v1/capabilities") {
      events.push("formal-capabilities");
      return new Response(JSON.stringify(makeCapabilities(plannedScenario.requiredCapabilities)), { status: 200 });
    }
    events.push("unexpected-formal-analysis");
    throw new Error("unverified draft must not reach analysis");
  };
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      DEEPSEEK_API_KEY: "draft-test-key",
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/chat/completions")) {
        events.push("draft-model");
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ scenarioDraft: asModelScenarioDraft(input.draft) }) }, finish_reason: "stop" }],
          usage: {},
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    },
    formalFetchImpl,
    modelInvoker: async () => {
      events.push("final-model");
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "继续使用非形式资料分析。",
        reasoning: ["草案尚未通过完整性验证。"],
        usedCards: Object.values(names),
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.deepEqual(events, ["final-model"]);
  assert.equal(answer.formalEngine.status, "unknown");
  assert.equal(answer.formalEngine.stage, "draft-verification");
  assert.equal(answer.formalEngine.error.code, "FORMAL_SCENARIO_DRAFT_UNVERIFIED");
  assert.equal(answer.formalEngine.draftVerification.valid, false);
  assert.match(answer.shortAnswer, /继续使用非形式资料分析/u);
});

test("an unavailable formal capability endpoint prevents any paid draft-model call", async () => {
  let draftCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      DEEPSEEK_API_KEY: "must-not-be-used",
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/chat/completions")) draftCalls += 1;
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    },
    formalFetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 404 }),
    formalProofVerifier: mockPublicProofVerifier,
    formalScenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "继续使用现有资料。",
      reasoning: ["正式内核当前不可用。"],
      usedCards: Object.values(names),
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.equal(draftCalls, 0);
  assert.equal(answer.formalEngine.stage, "capabilities");
  assert.equal(answer.formalEngine.error.code, "ENGINE_FORMAL_API_UNAVAILABLE");
});

test("a non-resolving scenario-draft invoker times out as UNKNOWN and the final model still answers", async () => {
  const events = [];
  let draftSignal;
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      OCG_ENGINE_URL: "http://formal.test",
    },
    formalFetchImpl: formalEndpointMock({}, events),
    formalScenarioDraftTimeoutMs: 15,
    formalScenarioDraftInvoker: ({ signal }) => {
      events.push("draft-invoker");
      draftSignal = signal;
      return new Promise(() => {});
    },
    formalScenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    formalProofVerifier: mockPublicProofVerifier,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 404 }),
    modelInvoker: async () => {
      events.push("final-model");
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "形式草案超时后仍继续非形式分析。",
        reasoning: ["形式分支的超时不会阻断最终回答。"],
        usedCards: Object.values(names),
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.deepEqual(events, ["formal-capabilities", "draft-invoker", "final-model"]);
  assert.equal(draftSignal.aborted, true);
  assert.equal(answer.formalEngine.status, "unknown");
  assert.equal(answer.formalEngine.stage, "draft");
  assert.equal(answer.formalEngine.error.code, "FORMAL_SCENARIO_DRAFT_TIMEOUT");
  assert.match(answer.shortAnswer, /仍继续非形式分析/u);
});

test("caller cancellation aborts a non-resolving scenario-draft invoker as typed UNKNOWN", async () => {
  const events = [];
  const controller = new AbortController();
  let draftSignal;
  let markDraftStarted;
  const draftStarted = new Promise((resolve) => { markDraftStarted = resolve; });
  const pending = runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", ...mockDraftVerifierEnv, OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: formalEndpointMock({}, events),
    scenarioDraftTimeoutMs: 1_000,
    scenarioDraftInvoker: ({ signal }) => {
      draftSignal = signal;
      markDraftStarted();
      return new Promise(() => {});
    },
    scenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    proofVerifier: mockPublicProofVerifier,
    signal: controller.signal,
  });
  await draftStarted;
  controller.abort("test-request-cancelled");
  const shadow = await pending;

  assert.deepEqual(events, ["formal-capabilities"]);
  assert.equal(draftSignal.aborted, true);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "draft");
  assert.equal(shadow.error.code, "FORMAL_SCENARIO_DRAFT_ABORTED");
});

test("missing proof verification fails before capabilities or paid draft extraction", async () => {
  let modelCalls = 0;
  let formalCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      DEEPSEEK_API_KEY: "must-not-be-used",
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/chat/completions")) modelCalls += 1;
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    },
    formalFetchImpl: async () => { formalCalls += 1; throw new Error("must not call the engine"); },
    formalScenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    modelInvoker: async () => JSON.stringify({
      answerLevel: "rule_analysis",
      shortAnswer: "继续使用非形式资料。",
      reasoning: ["正式证明验证器尚未配置。"],
      usedCards: Object.values(names),
      usedEvidence: [],
      missingInfo: [],
      riskFlags: [],
      confidenceSelfEstimate: "medium",
    }),
  });

  assert.equal(modelCalls, 0);
  assert.equal(formalCalls, 0);
  assert.equal(answer.formalEngine.stage, "proof-verification");
  assert.equal(answer.formalEngine.error.code, "FORMAL_PROOF_VERIFIER_UNAVAILABLE");
});

test("dry-run never calls formal capabilities or the paid draft extractor", async () => {
  let modelCalls = 0;
  let formalCalls = 0;
  let draftInvokerCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    dryRun: true,
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "false",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      DEEPSEEK_API_KEY: "must-not-be-used",
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/chat/completions")) modelCalls += 1;
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    },
    formalFetchImpl: async () => { formalCalls += 1; throw new Error("dry-run must not call the engine"); },
    formalScenarioDraftInvoker: async () => {
      draftInvokerCalls += 1;
      return { scenarioDraft: asModelScenarioDraft(input.draft) };
    },
    formalScenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    formalProofVerifier: mockPublicProofVerifier,
  });

  assert.equal(modelCalls, 0);
  assert.equal(formalCalls, 0);
  assert.equal(draftInvokerCalls, 0);
  assert.equal(answer.formalEngine.stage, "draft");
  assert.equal(answer.formalEngine.error.code, "FORMAL_SCENARIO_DRAFT_DRY_RUN");
});

test("scenario-draft verification rejects a caller mutation after hashes are bound", async () => {
  const mutableDraft = structuredClone(input.draft);
  const events = [];
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    scenarioDraft: mutableDraft,
    env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", ...mockDraftVerifierEnv, OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: formalEndpointMock({
      "q1-summon-procedure": "TRUE",
      "q2-hand-trigger": "TRUE",
    }, events),
    proofVerifier: mockPublicProofVerifier,
    scenarioDraftVerifier: ({ draft, scenario, draftSha256, scenarioSha256, questionSha256 }) => {
      assert.equal(Object.isFrozen(draft), true);
      assert.equal(Object.isFrozen(scenario), true);
      mutableDraft.turn.phase = "END";
      return {
        valid: true,
        verifierId: "malicious-verifier",
        verifierVersion: "test/v1",
        draftSha256,
        scenarioSha256,
        questionSha256,
      };
    },
  });

  assert.deepEqual(events, ["formal-capabilities"]);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "draft-verification");
  assert.equal(shadow.error.code, "FORMAL_SCENARIO_DRAFT_VERIFICATION_MISMATCH");
});

test("scenario-draft verifier identity must be configured before capabilities or paid extraction", async () => {
  let formalCalls = 0;
  let draftCalls = 0;
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: async () => {
      formalCalls += 1;
      throw new Error("identity preflight must run before formal transport");
    },
    scenarioDraftInvoker: async () => {
      draftCalls += 1;
      return input.draft;
    },
    scenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    proofVerifier: mockPublicProofVerifier,
  });

  assert.equal(formalCalls, 0);
  assert.equal(draftCalls, 0);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "draft-verification");
  assert.equal(shadow.error.code, "FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_UNCONFIGURED");
  assert.equal(shadow.draftVerification.verifierId, null);
  assert.equal(shadow.draftVerification.verifierVersion, null);
});

test("wrong scenario-draft verifier ID or version stays UNKNOWN and never reaches analysis", async () => {
  for (const mismatch of [
    { verifierId: "unexpected-verifier", verifierVersion: "mock-scenario-draft-completeness/v1" },
    { verifierId: "mock-scenario-draft-completeness-verifier", verifierVersion: "unexpected/v2" },
  ]) {
    const events = [];
    const shadow = await runFormalEngineShadow({
      userQuery: input.question,
      resolvedCards: input.resolvedCards,
      scenarioDraft: input.draft,
      env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", OCG_ENGINE_URL: "http://formal.test" },
      expectedScenarioDraftVerifierId: "mock-scenario-draft-completeness-verifier",
      expectedScenarioDraftVerifierVersion: "mock-scenario-draft-completeness/v1",
      fetchImpl: formalEndpointMock({}, events),
      proofVerifier: mockPublicProofVerifier,
      scenarioDraftVerifier: ({ draftSha256, scenarioSha256, questionSha256 }) => ({
        valid: true,
        ...mismatch,
        draftSha256,
        scenarioSha256,
        questionSha256,
      }),
    });

    assert.deepEqual(events, ["formal-capabilities"]);
    assert.equal(shadow.status, "unknown");
    assert.equal(shadow.stage, "draft-verification");
    assert.equal(shadow.error.code, "FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_MISMATCH");
    assert.equal(shadow.draftVerification.verifierId, mismatch.verifierId);
    assert.equal(shadow.draftVerification.verifierVersion, mismatch.verifierVersion);
    assert.equal(shadow.evidence.length, 0);
  }
});

test("a non-resolving scenario-draft verifier times out with typed UNKNOWN", async () => {
  const events = [];
  let verifierSignal;
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    scenarioDraft: input.draft,
    env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", ...mockDraftVerifierEnv, OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: formalEndpointMock({}, events),
    proofVerifier: mockPublicProofVerifier,
    scenarioDraftVerifierTimeoutMs: 15,
    scenarioDraftVerifier: (_payload, options) => {
      verifierSignal = options.signal;
      return new Promise(() => {});
    },
  });

  assert.deepEqual(events, ["formal-capabilities"]);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "draft-verification");
  assert.equal(shadow.error.code, "FORMAL_SCENARIO_DRAFT_VERIFIER_TIMEOUT");
  assert.equal(verifierSignal.aborted, true);
});

test("caller cancellation aborts scenario-draft verification with typed UNKNOWN", async () => {
  const events = [];
  const controller = new AbortController();
  let verifierSignal;
  let markVerifierStarted;
  const verifierStarted = new Promise((resolve) => { markVerifierStarted = resolve; });
  const pending = runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    scenarioDraft: input.draft,
    env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", ...mockDraftVerifierEnv, OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: formalEndpointMock({}, events),
    proofVerifier: mockPublicProofVerifier,
    scenarioDraftVerifierTimeoutMs: 1_000,
    signal: controller.signal,
    scenarioDraftVerifier: (_payload, options) => {
      verifierSignal = options.signal;
      markVerifierStarted();
      return new Promise(() => {});
    },
  });
  await verifierStarted;
  controller.abort("test-request-cancelled");
  const shadow = await pending;

  assert.deepEqual(events, ["formal-capabilities"]);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "draft-verification");
  assert.equal(shadow.error.code, "FORMAL_SCENARIO_DRAFT_VERIFIER_ABORTED");
  assert.equal(verifierSignal.aborted, true);
});

test("validated formal evidence is deeply immutable after branding", async () => {
  const events = [];
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    scenarioDraft: input.draft,
    env: { RAG_FORMAL_ENGINE_MODE: "formal-shadow", ...mockDraftVerifierEnv, OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: formalEndpointMock({
      "q1-summon-procedure": "TRUE",
      "q2-hand-trigger": "TRUE",
    }, events),
    proofVerifier: mockPublicProofVerifier,
    scenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
  });
  const first = shadow.evidence[0];
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.proof), true);
  assert.equal(Object.isFrozen(first.draftVerification), true);
  assert.equal(first.draftVerification.verifierId, "mock-scenario-draft-completeness-verifier");
  assert.equal(first.draftVerification.verifierVersion, "mock-scenario-draft-completeness/v1");
  assert.throws(() => { first.verdict = "FALSE"; }, TypeError);
  assert.throws(() => { first.proof.verified = false; }, TypeError);
  assert.throws(() => { first.draftVerification.verifierId = "forged"; }, TypeError);
  const gated = applyFormalAnswerGate({ shortAnswer: "模型称不可以。", reasoning: [], riskFlags: [] }, shadow.evidence);
  assert.match(gated.shortAnswer, /可以/u);
});
