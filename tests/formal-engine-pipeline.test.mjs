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

test("public answer path ignores formal configuration and invokers", async () => {
  let finalModelCalls = 0;
  let formalTransportCalls = 0;
  let draftInvokerCalls = 0;
  let draftVerifierCalls = 0;
  let proofVerifierCalls = 0;

  const answer = await answerRagRulingQuestion({
    question: input.question,
    cards,
    records: [],
    qaRecords: [],
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      RAG_AUTO_ENGINE_SIMULATION: "true",
      RAG_CARD_EXTRACTOR_ENABLED: "false",
      RAG_RULE_QUERY_EXTRACTOR_ENABLED: "false",
      RAG_RULEBOOK_GROUNDING_ENABLED: "false",
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 404 }),
    formalScenarioDraft: input.draft,
    formalFetchImpl: async () => {
      formalTransportCalls += 1;
      throw new Error("public path must not call formal transport");
    },
    formalScenarioDraftInvoker: async () => {
      draftInvokerCalls += 1;
      return { scenarioDraft: input.draft };
    },
    formalScenarioDraftVerifier: () => {
      draftVerifierCalls += 1;
      return { valid: true };
    },
    formalProofVerifier: () => {
      proofVerifierCalls += 1;
      return { verified: true };
    },
    modelInvoker: async () => {
      finalModelCalls += 1;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "最终模型根据检索证据独立回答。",
        reasoning: ["公开链路只使用原始检索证据和一次最终模型调用。"],
        usedCards: Object.values(names),
        usedEvidence: [],
        missingInfo: [],
        riskFlags: [],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.equal(finalModelCalls, 1);
  assert.equal(formalTransportCalls, 0);
  assert.equal(draftInvokerCalls, 0);
  assert.equal(draftVerifierCalls, 0);
  assert.equal(proofVerifierCalls, 0);
  assert.deepEqual(answer.formalEngine, {
    mode: "off",
    enabled: false,
    requested: false,
    status: "disabled",
  });
  assert.deepEqual(answer.formalQueryResults, []);
  assert.match(answer.shortAnswer, /最终模型/u);
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

test("missing proof verifier fails before capabilities or paid draft extraction", async () => {
  let capabilityCalls = 0;
  let draftCalls = 0;
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async () => {
      capabilityCalls += 1;
      throw new Error("proof preflight must run before capabilities");
    },
    scenarioDraftInvoker: async () => {
      draftCalls += 1;
      return { scenarioDraft: input.draft };
    },
    scenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
  });

  assert.equal(capabilityCalls, 0);
  assert.equal(draftCalls, 0);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "proof-verification");
  assert.equal(shadow.error.code, "FORMAL_PROOF_VERIFIER_UNAVAILABLE");
});

test("unavailable capability endpoint prevents paid scenario-draft extraction", async () => {
  let capabilityCalls = 0;
  let draftCalls = 0;
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl: async () => {
      capabilityCalls += 1;
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    },
    scenarioDraftInvoker: async () => {
      draftCalls += 1;
      return { scenarioDraft: input.draft };
    },
    scenarioDraftVerifier: mockScenarioDraftCompletenessVerifier,
    proofVerifier: mockPublicProofVerifier,
  });

  assert.equal(capabilityCalls, 1);
  assert.equal(draftCalls, 0);
  assert.equal(shadow.status, "unknown");
  assert.equal(shadow.stage, "capabilities");
  assert.equal(shadow.error.code, "ENGINE_FORMAL_API_UNAVAILABLE");
  assert.deepEqual(shadow.evidence, []);
});

test("successful shadow runs capability, draft, draft verification, analysis, and proof verification in order", async () => {
  const events = [];
  let capabilities;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/formal/v1/capabilities") {
      events.push("capability");
      capabilities = makeCapabilities(plannedScenario.requiredCapabilities);
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (pathname === "/formal/v1/analyze-scenario") {
      events.push("analysis");
      const scenario = JSON.parse(options.body).scenario;
      const result = makeFormalResult(scenario, capabilities, {
        "q1-summon-procedure": "TRUE",
        "q2-hand-trigger": "TRUE",
      });
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    throw new Error(`unexpected formal URL: ${url}`);
  };
  const shadow = await runFormalEngineShadow({
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
    env: {
      RAG_FORMAL_ENGINE_MODE: "formal-shadow",
      ...mockDraftVerifierEnv,
      OCG_ENGINE_URL: "http://formal.test",
    },
    fetchImpl,
    scenarioDraftInvoker: async () => {
      events.push("draft");
      return { scenarioDraft: input.draft };
    },
    scenarioDraftVerifier: (payload) => {
      events.push("draft-verify");
      return mockScenarioDraftCompletenessVerifier(payload);
    },
    proofVerifier: (payload) => {
      events.push(`proof-verify:${payload.queryResult.queryId}`);
      return mockPublicProofVerifier(payload);
    },
  });

  assert.deepEqual(events, [
    "capability",
    "draft",
    "draft-verify",
    "analysis",
    "proof-verify:q1-summon-procedure",
    "proof-verify:q2-hand-trigger",
  ]);
  assert.equal(shadow.status, "completed");
  assert.equal(shadow.stage, "analysis");
  assert.equal(shadow.draftVerification.valid, true);
  assert.equal(shadow.analysis.formalResult.queryResults.length, 2);
  assert.equal(
    shadow.analysis.formalResult.queryResults.every(
      (item) => item.certificateVerification?.valid === true,
    ),
    true,
  );
  assert.equal(shadow.evidence.length, 2);
  assert.equal(shadow.evidence.every((item) => item.trusted === true), true);
  assert.equal(shadow.evidence.every((item) => item.proof?.verified === true), true);
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
