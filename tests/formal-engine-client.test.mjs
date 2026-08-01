import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requestFormalScenarioAnalysis } from "../backend/formalEngineClient.mjs";
import { capabilityManifestSha256, formalRequestSha256 } from "../backend/formalEngineSchemas.mjs";
import { planFormalScenario } from "../backend/formalScenarioPlanner.mjs";
import { makeCapabilities, makeFormalResult, materializeFixture, mockPublicProofVerifier } from "./helpers/formal-engine-mock.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/anonymous-equivalent.json", import.meta.url), "utf8"));
const fixtureInput = materializeFixture(fixture);
const scenario = planFormalScenario({
  scenarioDraft: fixtureInput.draft,
  userQuery: fixtureInput.question,
  resolvedCards: fixtureInput.resolvedCards,
}).scenario;

function endpointMock({ capabilityMutator, capabilityDigestMutator, resultMutator } = {}) {
  const calls = [];
  const capabilities = makeCapabilities(scenario.requiredCapabilities);
  capabilityMutator?.(capabilities);
  capabilities.capabilityManifestSha256 = capabilityManifestSha256(capabilities);
  capabilityDigestMutator?.(capabilities);
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/formal/v1/capabilities")) {
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (String(url).endsWith("/formal/v1/analyze-scenario")) {
      const submitted = JSON.parse(options.body).scenario;
      const result = makeFormalResult(submitted, capabilities, {
        "q1-summon-procedure": "TRUE",
        "q2-hand-trigger": "FALSE",
      });
      resultMutator?.(result);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  return { fetchImpl, calls };
}

test("formal client negotiates capabilities and accepts certified TRUE and FALSE only", async () => {
  const mock = endpointMock();
  const response = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790", OCG_ENGINE_TOKEN: "secret" },
    fetchImpl: mock.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(response.status, "completed");
  assert.deepEqual(response.formalResult.queryResults.map((item) => item.verdict), ["TRUE", "FALSE"]);
  assert.deepEqual(mock.calls.map((call) => new URL(call.url).pathname), ["/formal/v1/capabilities", "/formal/v1/analyze-scenario"]);
  assert.equal(mock.calls.every((call) => call.options.headers.authorization === "Bearer secret"), true);
  const submitted = JSON.parse(mock.calls[1].options.body);
  assert.deepEqual(submitted.bindings, {
    requestSha256: formalRequestSha256(scenario),
    capabilityManifestSha256: response.capabilities.capabilityManifestSha256,
    definitionSnapshotSha256: scenario.definitionSnapshot.manifestSha256,
  });
});

test("missing formal endpoint stays UNKNOWN and never falls back to legacy simulate", async () => {
  const calls = [];
  const response = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }), { status: 404 });
    },
  });
  assert.equal(response.status, "unknown");
  assert.equal(response.error.code, "ENGINE_FORMAL_API_UNAVAILABLE");
  assert.equal(response.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
  assert.equal(calls.some((url) => url.endsWith("/simulate")), false);
});

test("PARTIAL capability cannot authorize a definitive result", async () => {
  const mock = endpointMock({ capabilityMutator(capabilities) { capabilities.capabilities[0].status = "PARTIAL"; } });
  const response = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(response.status, "unknown");
  assert.equal(response.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(mock.calls.length, 1);
});

test("version mismatch is global but one proof-certificate failure downgrades only its query", async () => {
  const mismatched = endpointMock({ resultMutator(result) { result.engineVersion = "different-engine"; } });
  const mismatchResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: mismatched.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(mismatchResponse.status, "unknown");
  assert.equal(mismatchResponse.error.code, "FORMAL_VERSION_INCOMPATIBLE");

  const tampered = endpointMock({ resultMutator(result) {
    result.queryResults[0].proofCertificate.nodes[0].conclusion.verdict = "FALSE";
  } });
  const tamperResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: tampered.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(tamperResponse.status, "completed");
  assert.equal(tamperResponse.error, null);
  assert.deepEqual(tamperResponse.formalResult.queryResults.map((item) => item.verdict), ["UNKNOWN", "FALSE"]);
  assert.equal(tamperResponse.formalResult.queryResults[0].unknownReasons[0].code, "FORMAL_CERTIFICATE_INVALID");
});

test("boolean verifiers and mismatched receipts cannot authorize a verdict", async () => {
  const booleanVerifier = endpointMock();
  const booleanResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: booleanVerifier.fetchImpl,
    proofVerifier: () => true,
  });
  assert.equal(booleanResponse.status, "completed");
  assert.equal(booleanResponse.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
  assert.equal(booleanResponse.formalResult.queryResults[0].unknownReasons[0].code, "FORMAL_CERTIFICATE_INVALID");

  const looseVerifier = endpointMock();
  const looseResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: looseVerifier.fetchImpl,
    proofVerifier: () => ({ valid: true }),
  });
  assert.equal(looseResponse.status, "completed");
  assert.equal(looseResponse.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);

  const mismatchedReceipt = endpointMock({ resultMutator(result) {
    result.queryResults[0].certificateVerification.requestSha256 = "0".repeat(64);
  } });
  const mismatchResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: mismatchedReceipt.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(mismatchResponse.status, "completed");
  assert.deepEqual(mismatchResponse.formalResult.queryResults.map((item) => item.verdict), ["UNKNOWN", "FALSE"]);
  assert.equal(mismatchResponse.formalResult.queryResults[0].unknownReasons[0].code, "FORMAL_BINDING_MISMATCH");
});

test("capability manifests and recursive dependencies are validated before analysis", async () => {
  const missingDependency = endpointMock({ capabilityMutator(capabilities) {
    capabilities.capabilities[0].dependencies = ["dependency/not-negotiated/v1"];
  } });
  const dependencyResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: missingDependency.fetchImpl,
  });
  assert.equal(dependencyResponse.status, "unknown");
  assert.equal(dependencyResponse.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(missingDependency.calls.length, 1);

  const badManifest = endpointMock({ capabilityDigestMutator(capabilities) {
    capabilities.capabilityManifestSha256 = "f".repeat(64);
  } });
  const manifestResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: badManifest.fetchImpl,
  });
  assert.equal(manifestResponse.status, "unknown");
  assert.equal(manifestResponse.error.code, "FORMAL_CAPABILITY_MANIFEST_INVALID");
  assert.equal(badManifest.calls.length, 1);

  const transitivePartial = endpointMock({ capabilityMutator(capabilities) {
    capabilities.capabilities[0].dependencies = ["dependency/level-one/v1"];
    capabilities.capabilities.push({
      capabilityId: "dependency/level-one/v1",
      version: "v1",
      status: "SUPPORTED",
      dependencies: ["dependency/level-two/v1"],
    }, {
      capabilityId: "dependency/level-two/v1",
      version: "v1",
      status: "PARTIAL",
      dependencies: [],
    });
  } });
  const transitiveResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: transitivePartial.fetchImpl,
  });
  assert.equal(transitiveResponse.status, "unknown");
  assert.equal(transitiveResponse.error.code, "CAPABILITY_UNAVAILABLE");
});

test("direct client callers cannot under-declare semantic capabilities or use unversioned IDs", async () => {
  const underDeclared = structuredClone(scenario);
  underDeclared.requiredCapabilities = ["source/span-validation/v1"];
  let calls = 0;
  const underDeclaredResponse = await requestFormalScenarioAnalysis({
    formalScenario: underDeclared,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); },
  });
  assert.equal(underDeclaredResponse.status, "unknown");
  assert.equal(underDeclaredResponse.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(calls, 0);

  const unversioned = structuredClone(scenario);
  unversioned.requiredCapabilities.push("custom/unversioned");
  const unversionedResponse = await requestFormalScenarioAnalysis({ formalScenario: unversioned });
  assert.equal(unversionedResponse.status, "unknown");
  assert.equal(unversionedResponse.error.code, "FORMAL_CAPABILITY_SCHEMA_INVALID");

  const mismatchedVersion = endpointMock({ capabilityMutator(capabilities) {
    capabilities.capabilities[0].version = "v2";
  } });
  const versionResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: mismatchedVersion.fetchImpl,
  });
  assert.equal(versionResponse.status, "unknown");
  assert.equal(versionResponse.error.code, "FORMAL_CAPABILITY_SCHEMA_INVALID");
});

test("top-level artifact binding failures are global while q2 verifier failure stays local", async () => {
  const topLevelTamper = endpointMock({ resultMutator(result) {
    result.requestSha256 = "0".repeat(64);
  } });
  const globalResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: topLevelTamper.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(globalResponse.status, "unknown");
  assert.equal(globalResponse.error.code, "FORMAL_BINDING_MISMATCH");

  const localVerifierFailure = endpointMock();
  const localResponse = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: localVerifierFailure.fetchImpl,
    proofVerifier: (input) => {
      if (input.queryResult.queryId === "q2-hand-trigger") throw new Error("q2 verifier rejected proof");
      return mockPublicProofVerifier(input);
    },
  });
  assert.equal(localResponse.status, "completed");
  assert.deepEqual(localResponse.formalResult.queryResults.map((item) => item.verdict), ["TRUE", "UNKNOWN"]);
  assert.equal(localResponse.formalResult.queryResults[1].unknownReasons[0].code, "FORMAL_CERTIFICATE_INVALID");
});

test("offline and timeout failures stay UNKNOWN", async () => {
  const offline = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  assert.equal(offline.status, "unknown");
  assert.equal(offline.error.code, "ENGINE_FORMAL_API_UNAVAILABLE");

  const timeout = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    timeoutMs: 2,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
    }),
  });
  assert.equal(timeout.status, "unknown");
  assert.equal(timeout.error.code, "ENGINE_FORMAL_API_UNAVAILABLE");
});

test("engine UNKNOWN is preserved without demanding a proof certificate", async () => {
  const mock = endpointMock({ resultMutator(result) {
    result.queryResults = result.queryResults.map((item) => ({
      ...item,
      verdict: "UNKNOWN",
      witness: null,
      counterexample: null,
      proofCertificate: null,
      certificateVerification: null,
      unknownReasons: [{ code: "MISSING_STATE_FACT", message: "missing opponent response" }],
    }));
  } });
  const response = await requestFormalScenarioAnalysis({
    formalScenario: scenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(response.status, "completed");
  assert.equal(response.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
});

test("ABSTRACT_ASSUMPTIONS cannot retain TRUE or FALSE at the client boundary", async () => {
  const abstractScenario = structuredClone(scenario);
  abstractScenario.mode = "ABSTRACT_ASSUMPTIONS";
  abstractScenario.assumptions = [{
    assumptionId: "assume-spell-effect-used",
    type: "ASSUME_STATE_FACT",
    assumesFactId: "spell-effect-used-this-turn",
    sourceSpan: structuredClone(abstractScenario.stateFacts[0].sourceSpan),
  }];
  const mock = endpointMock();
  const response = await requestFormalScenarioAnalysis({
    formalScenario: abstractScenario,
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: mock.fetchImpl,
    proofVerifier: mockPublicProofVerifier,
  });
  assert.equal(response.status, "completed");
  assert.equal(response.formalResult.queryResults.every((item) => item.verdict === "UNKNOWN"), true);
  assert.equal(response.formalResult.queryResults.every((item) => item.unknownReasons[0].code === "FORMAL_AUTHORITY_MODE_UNSUPPORTED"), true);
});
