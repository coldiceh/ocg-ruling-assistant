import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requestFormalScenarioAnalysis } from "../backend/formalEngineClient.mjs";
import {
  capabilityManifestSha256,
  formalRequestSha256,
} from "../backend/formalEngineSchemas.mjs";
import { planFormalScenario } from "../backend/formalScenarioPlanner.mjs";
import { requestOcgEngineSimulation } from "../backend/ocgEngineClient.mjs";
import {
  makeCapabilities,
  makeFormalResult,
  materializeFixture,
  mockPublicProofVerifier,
} from "./helpers/formal-engine-mock.mjs";

const realFixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/real-three-card.json", import.meta.url), "utf8"));
const anonymousFixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/anonymous-equivalent.json", import.meta.url), "utf8"));
const expectedAnswer = JSON.parse(await readFile(new URL("./fixtures/formal-engine/expected-three-card-answer.json", import.meta.url), "utf8"));
const anonymousInput = materializeFixture(anonymousFixture);
const anonymousScenario = planFormalScenario({
  scenarioDraft: anonymousInput.draft,
  userQuery: anonymousInput.question,
  resolvedCards: anonymousInput.resolvedCards,
}).scenario;

function formalEndpointMock({ capabilityMutator, resultMutator, verdicts } = {}) {
  const calls = [];
  const capabilities = makeCapabilities(anonymousScenario.requiredCapabilities);
  capabilityMutator?.(capabilities);
  capabilities.capabilityManifestSha256 = capabilityManifestSha256(capabilities);
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname === "/formal/v1/capabilities") {
        return new Response(JSON.stringify(capabilities), { status: 200 });
      }
      if (pathname === "/formal/v1/analyze-scenario") {
        const submitted = JSON.parse(options.body).scenario;
        const result = makeFormalResult(submitted, capabilities, verdicts || {
          "q1-summon-procedure": "TRUE",
          "q2-hand-trigger": "TRUE",
        });
        resultMutator?.(result);
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      throw new Error(`unexpected endpoint: ${pathname}`);
    },
  };
}

function planPrintedInputKind(property, value) {
  const fixture = structuredClone(anonymousFixture);
  fixture.resolvedCards[0].formalEffects = [];
  fixture.draft.cardInstances[0].effectIds = [];
  fixture.draft.stateFacts.push({
    factId: `printed-${property}`,
    type: "PRINTED_CARD_PROPERTY",
    provenance: "PRINTED_TEXT",
    definitionRef: { cardId: "card-a" },
    property,
    value,
    mention: "「怪兽甲」",
  });
  const input = materializeFixture(fixture);
  return planFormalScenario({
    scenarioDraft: input.draft,
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
  });
}

test("three-card answer snapshot is acceptance data, never an engine execution or proof", () => {
  assert.equal(expectedAnswer.artifactType, "acceptance_expectation");
  assert.equal(expectedAnswer.notAnEngineExecution, true);
  assert.deepEqual(
    expectedAnswer.expectedFormalVerdicts.map((item) => [item.queryId, item.verdict]),
    [["q1-summon-procedure", "TRUE"], ["q2-hand-trigger", "TRUE"]],
  );
  assert.equal(expectedAnswer.expectedTraceSemantics.length >= 8, true);
  assert.match(expectedAnswer.expectedChineseAnswer.shortAnswer, /混沌の黒魔術師.*滅びの黒魔術師.*深淵の相剣龍/u);
  assert.equal(expectedAnswer.expectedChineseAnswer.requiredPoints.some((item) => item.includes("手续本身不是效果")), true);
  assert.equal(expectedAnswer.acceptanceConditions.some((item) => item.includes("不能作为 formal_engine_proof")), true);
});

test("real and anonymous fixtures bind the procedure input and the leaving card effect without name logic", () => {
  for (const fixture of [realFixture, anonymousFixture]) {
    const input = materializeFixture(fixture);
    const planned = planFormalScenario({ scenarioDraft: input.draft, userQuery: input.question, resolvedCards: input.resolvedCards });
    assert.equal(planned.kind, "READY");
    assert.equal(planned.scenario.intents[0].procedureInputInstanceIds.length, 1);
    const inputInstance = planned.scenario.cardInstances.find(
      (item) => item.instanceId === planned.scenario.intents[0].procedureInputInstanceIds[0],
    );
    assert.equal(inputInstance.effectBindings.some((item) => item.effectId === "effect-3"), true);
  }
});

test("ordinary-monster and Token counterexamples remain printed inputs and never become caller-authored attribution", () => {
  const ordinary = planPrintedInputKind("monsterKind", "NORMAL");
  const token = planPrintedInputKind("isToken", true);
  for (const [planned, property] of [[ordinary, "monsterKind"], [token, "isToken"]]) {
    assert.equal(planned.kind, "READY");
    const inputId = planned.scenario.intents[0].procedureInputInstanceIds[0];
    const inputInstance = planned.scenario.cardInstances.find((item) => item.instanceId === inputId);
    assert.deepEqual(inputInstance.effectBindings, []);
    assert.equal(planned.scenario.stateFacts.some((fact) => fact.property === property && fact.provenance === "PRINTED_TEXT"), true);
    assert.equal(planned.scenario.stateFacts.some((fact) => /ATTRIBUTION|BANISHED_BY_CARD_EFFECT/u.test(fact.type)), false);
  }
});

test("missing provenance and unresolved opponent priority fail closed instead of fixing a hand trigger", () => {
  const noProvenance = materializeFixture(anonymousFixture);
  delete noProvenance.draft.stateFacts[0].provenance;
  const provenanceResult = planFormalScenario({
    scenarioDraft: noProvenance.draft,
    userQuery: noProvenance.question,
    resolvedCards: noProvenance.resolvedCards,
  });
  assert.equal(provenanceResult.kind, "UNKNOWN");
  assert.equal(provenanceResult.unknownReasons[0].code, "FORMAL_RESPONSE_SCHEMA_INVALID");

  const opponentNotPassed = materializeFixture(anonymousFixture);
  opponentNotPassed.draft.missingStateFacts = ["opponent-priority-pass"];
  const priorityResult = planFormalScenario({
    scenarioDraft: opponentNotPassed.draft,
    userQuery: opponentNotPassed.question,
    resolvedCards: opponentNotPassed.resolvedCards,
  });
  assert.equal(priorityResult.kind, "UNKNOWN");
  assert.equal(priorityResult.unknownReasons[0].code, "MISSING_STATE_FACT");

  const collapsedBranches = materializeFixture(anonymousFixture);
  collapsedBranches.draft.branchPolicy.preserveUnspecifiedResponses = false;
  const branchResult = planFormalScenario({
    scenarioDraft: collapsedBranches.draft,
    userQuery: collapsedBranches.question,
    resolvedCards: collapsedBranches.resolvedCards,
  });
  assert.equal(branchResult.kind, "UNKNOWN");
  assert.equal(branchResult.unknownReasons[0].code, "FORMAL_SCENARIO_SCHEMA_INVALID");
});

test("formal scenario request objects are closed and reject runtime outcome injection before transport", async () => {
  const mutations = [
    ["scenario", (candidate) => { candidate.forceOutcome = "TRUE"; }],
    ["question", (candidate) => { candidate.question.forceOutcome = "TRUE"; }],
    ["cardInstance", (candidate) => { candidate.cardInstances[0].runtimeEffectOverrides = ["always-legal"]; }],
    ["definitionBinding", (candidate) => { candidate.cardInstances[0].definitionBinding.forceOutcome = "TRUE"; }],
    ["effectBinding", (candidate) => { candidate.cardInstances[0].effectBindings[0].runtimeEffectOverrides = []; }],
    ["definitionSnapshot", (candidate) => { candidate.definitionSnapshot.forceOutcome = "TRUE"; }],
    ["definition", (candidate) => { candidate.definitionSnapshot.definitions[0].runtimeEffectOverrides = []; }],
    ["definitionEffect", (candidate) => { candidate.definitionSnapshot.definitions[0].effects[0].forceOutcome = "TRUE"; }],
    ["sourceSpan", (candidate) => { candidate.cardInstances[0].sourceSpan.forceOutcome = "TRUE"; }],
  ];
  for (const [label, mutate] of mutations) {
    const candidate = structuredClone(anonymousScenario);
    mutate(candidate);
    let transportCalls = 0;
    const response = await requestFormalScenarioAnalysis({
      formalScenario: candidate,
      env: { OCG_ENGINE_URL: "http://formal.test" },
      fetchImpl: async () => {
        transportCalls += 1;
        throw new Error("closed request must be rejected before transport");
      },
    });
    assert.equal(response.status, "unknown", label);
    assert.equal(response.error.code, "UNTRUSTED_DERIVED_FACT", label);
    assert.equal(transportCalls, 0, label);
  }
});

test("incomplete execution or search downgrades definitive engine output to UNKNOWN, never FALSE", async () => {
  for (const field of ["executionComplete", "searchComplete", "querySliceComplete"]) {
    const mock = formalEndpointMock({ resultMutator(result) { result[field] = false; } });
    const response = await requestFormalScenarioAnalysis({
      formalScenario: anonymousScenario,
      env: { OCG_ENGINE_URL: "http://formal.test" },
      fetchImpl: mock.fetchImpl,
      proofVerifier: mockPublicProofVerifier,
    });
    assert.equal(response.status, "completed");
    assert.equal(response.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
    assert.equal(response.formalResult.queryResults.every(
      (item) => item.unknownReasons[0].code === "FORMAL_EXECUTION_INCOMPLETE",
    ), true);
  }
});

test("currentName and copiedEffects cannot change printed definition bindings or the formal request", () => {
  const baseline = materializeFixture(anonymousFixture);
  const mutated = materializeFixture(anonymousFixture);
  mutated.draft.cardInstances[0].currentName = "runtime-name-that-is-not-printed-text";
  mutated.draft.cardInstances[0].copiedEffects = ["runtime-copy-that-is-not-a-definition-binding"];
  const baselinePlan = planFormalScenario({ scenarioDraft: baseline.draft, userQuery: baseline.question, resolvedCards: baseline.resolvedCards });
  const mutatedPlan = planFormalScenario({ scenarioDraft: mutated.draft, userQuery: mutated.question, resolvedCards: mutated.resolvedCards });
  assert.equal(baselinePlan.kind, "READY");
  assert.equal(mutatedPlan.kind, "READY");
  assert.deepEqual(mutatedPlan.scenario.definitionSnapshot, baselinePlan.scenario.definitionSnapshot);
  assert.deepEqual(mutatedPlan.scenario.cardInstances[0].effectBindings, baselinePlan.scenario.cardInstances[0].effectBindings);
  assert.equal(formalRequestSha256(mutatedPlan.scenario), formalRequestSha256(baselinePlan.scenario));
});

test("initiatingOperation or attribution trace changes invalidate old query certificates", async () => {
  const mock = formalEndpointMock({ resultMutator(result) {
    result.structuredTrace = [{
      event: "zone-change",
      initiatingOperation: "changed-operation",
      attributions: ["procedure-request", "leave-field-destination-effect"],
    }];
  } });
  const response = await requestFormalScenarioAnalysis({
    formalScenario: anonymousScenario,
    env: { OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: mock.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(response.status, "completed");
  assert.equal(response.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
  assert.equal(response.formalResult.queryResults.every(
    (item) => item.unknownReasons[0].code === "FORMAL_BINDING_MISMATCH",
  ), true);
});

test("removing one required capability yields UNKNOWN before analyze-scenario", async () => {
  const removed = anonymousScenario.requiredCapabilities[0];
  const mock = formalEndpointMock({ capabilityMutator(capabilities) {
    capabilities.capabilities = capabilities.capabilities.filter((item) => item.capabilityId !== removed);
  } });
  const response = await requestFormalScenarioAnalysis({
    formalScenario: anonymousScenario,
    env: { OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(response.status, "unknown");
  assert.equal(response.error.code, "CAPABILITY_UNAVAILABLE");
  assert.deepEqual(mock.calls, ["/formal/v1/capabilities"]);
  assert.equal(response.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
});

test("legacy simulate may conflict with formal proof but remains a separate non-authoritative channel", async () => {
  const capabilities = makeCapabilities(anonymousScenario.requiredCapabilities);
  const paths = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    paths.push(pathname);
    if (pathname === "/formal/v1/capabilities") {
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (pathname === "/formal/v1/analyze-scenario") {
      const submitted = JSON.parse(options.body).scenario;
      const result = makeFormalResult(submitted, capabilities, {
        "q1-summon-procedure": "TRUE",
        "q2-hand-trigger": "TRUE",
      });
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    if (pathname === "/simulate") {
      return new Response(JSON.stringify({
        ok: true,
        simulation: {
          sourceType: "engine_simulation",
          canConfirmOfficialRuling: false,
          reportedVerdict: "FALSE",
          resourceBinding: {
            lockId: "1".repeat(64), snapshotId: "2".repeat(64), manifestSha256: "3".repeat(64),
            coreSha256: "4".repeat(64), dbSetSha256: "5".repeat(64), scriptSetSha256: "6".repeat(64),
            patchSetSha256: "7".repeat(64), apiAbi: "ocgcore/test",
          },
          traceSha256: "8".repeat(64),
        },
      }), { status: 200 });
    }
    throw new Error(`unexpected endpoint: ${pathname}`);
  };
  const legacy = await requestOcgEngineSimulation({
    engineScenario: { seed: "conflicting-legacy-observation" },
    env: { OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl,
  });
  const formal = await requestFormalScenarioAnalysis({
    formalScenario: anonymousScenario,
    env: { OCG_ENGINE_URL: "http://formal.test" },
    fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(legacy.status, "completed");
  assert.equal(legacy.simulation.reportedVerdict, "FALSE");
  assert.equal(legacy.simulation.canConfirmOfficialRuling, false);
  assert.equal(formal.status, "completed");
  assert.deepEqual(formal.formalResult.queryResults.map((item) => item.verdict), ["TRUE", "TRUE"]);
  assert.deepEqual(paths, ["/simulate", "/formal/v1/capabilities", "/formal/v1/analyze-scenario"]);
});
