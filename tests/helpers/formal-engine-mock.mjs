import {
  FORMAL_AUTHORITY_SCOPE,
  FORMAL_CAPABILITIES_CONTRACT,
  FORMAL_PROOF_CERTIFICATE_CONTRACT,
  FORMAL_RESULT_CONTRACT,
  FORMAL_SCENARIO_CONTRACT,
  FORMAL_SOURCE_SPAN_ENCODING,
  capabilityManifestSha256,
  canonicalSha256,
  formalInputSha256,
  formalQueryOutputSha256,
  formalRequestSha256,
  proofCertificateId,
} from "../../backend/formalEngineSchemas.mjs";

export const MOCK_FORMAL_VERSIONS = Object.freeze({
  engineVersion: "ocg-formal-engine/test",
  IRVersion: "ocg-effect-ir/test",
  rulesetVersion: "ocg-ruleset/test",
  schemaVersion: "ocg-formal-engine/v1",
  proofVerifierVersion: "ocg-proof-verifier/v1",
});

export function makeCapabilities(requiredCapabilities, overrides = {}) {
  const capabilities = {
    ok: true,
    contractVersion: FORMAL_CAPABILITIES_CONTRACT,
    scenarioContractVersion: FORMAL_SCENARIO_CONTRACT,
    resultContractVersion: FORMAL_RESULT_CONTRACT,
    sourceSpanEncoding: FORMAL_SOURCE_SPAN_ENCODING,
    authorityScope: FORMAL_AUTHORITY_SCOPE,
    proofCertificateVersion: FORMAL_PROOF_CERTIFICATE_CONTRACT,
    capabilityManifestId: "mock-capability-manifest/v1",
    versions: { ...MOCK_FORMAL_VERSIONS },
    capabilities: [...new Set(requiredCapabilities)].map((capabilityId) => ({
      capabilityId,
      version: String(capabilityId).match(/\/(v\d+)$/u)?.[1] || "unversioned",
      status: "SUPPORTED",
      dependencies: [],
    })),
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "capabilityManifestSha256")) {
    capabilities.capabilityManifestSha256 = capabilityManifestSha256(capabilities);
  }
  return capabilities;
}

export function makeFormalResult(scenario, capabilities, verdicts = {}) {
  const result = {
    contractVersion: FORMAL_RESULT_CONTRACT,
    scenarioId: scenario.scenarioId,
    requestSha256: formalRequestSha256(scenario),
    capabilityManifestSha256: capabilities.capabilityManifestSha256,
    definitionSnapshotSha256: scenario.definitionSnapshot.manifestSha256,
    queryResults: scenario.queries.map((query) => makeQueryResult(
      query.queryId,
      Object.hasOwn(verdicts, query.queryId) ? verdicts[query.queryId] : "UNKNOWN",
    )),
    branches: [{ branchId: "all-responses-preserved" }],
    structuredTrace: [{ event: "scenario-slice-complete" }],
    ...capabilities.versions,
    unresolvedSemantics: [],
    querySliceComplete: true,
    searchComplete: true,
    executionComplete: true,
  };
  for (const queryResult of result.queryResults) {
    if (queryResult.verdict !== "UNKNOWN") certifyQueryResult(queryResult, result, capabilities);
  }
  return result;
}

export function makeQueryResult(queryId, verdict) {
  if (verdict === "UNKNOWN") {
    return {
      queryId,
      verdict,
      witness: null,
      counterexample: null,
      proofCertificate: null,
      certificateVerification: null,
      unknownReasons: [{ code: "MISSING_STATE_FACT", message: "fixture intentionally unresolved" }],
    };
  }
  return {
    queryId,
    verdict,
    witness: verdict === "TRUE" ? { kind: "WITNESS" } : null,
    counterexample: verdict === "FALSE" ? { kind: "COUNTEREXAMPLE" } : null,
    proofCertificate: null,
    certificateVerification: null,
    unknownReasons: [],
  };
}

function certifyQueryResult(queryResult, result, capabilities) {
  const inputHash = formalInputSha256({
    requestSha256: result.requestSha256,
    capabilityManifestSha256: result.capabilityManifestSha256,
    definitionSnapshotSha256: result.definitionSnapshotSha256,
  });
  const outputHash = formalQueryOutputSha256(result, queryResult);
  const certificate = {
    schemaVersion: FORMAL_PROOF_CERTIFICATE_CONTRACT,
    proofKind: "QUERY_VERDICT",
    verdict: queryResult.verdict,
    rootNodeId: "root:" + queryResult.queryId,
    nodes: [{
      nodeId: "root:" + queryResult.queryId,
      conclusion: { queryId: queryResult.queryId, verdict: queryResult.verdict },
    }],
    inputHash,
    outputHash,
    versions: { ...capabilities.versions },
  };
  certificate.certificateId = proofCertificateId(certificate);
  queryResult.proofCertificate = certificate;
  queryResult.certificateVerification = {
    valid: true,
    verifierVersion: capabilities.versions.proofVerifierVersion,
    certificateId: certificate.certificateId,
    certificateSha256: canonicalSha256(certificate),
    queryId: queryResult.queryId,
    verdict: queryResult.verdict,
    requestSha256: result.requestSha256,
    outputSha256: outputHash,
    capabilityManifestSha256: result.capabilityManifestSha256,
    definitionSnapshotSha256: result.definitionSnapshotSha256,
  };
}

export function sourceSpanFor(question, mention) {
  const start = question.indexOf(mention);
  if (start < 0) throw new Error("fixture mention not found: " + mention);
  return { encoding: FORMAL_SOURCE_SPAN_ENCODING, start, end: start + mention.length, text: mention };
}

export function mockPublicProofVerifier({ certificate, queryResult, capabilities, resultBindings }) {
  return {
    valid: true,
    certificateId: certificate.certificateId,
    certificateSha256: canonicalSha256(certificate),
    queryId: queryResult.queryId,
    verdict: queryResult.verdict,
    verifierVersion: capabilities.versions.proofVerifierVersion,
    requestSha256: resultBindings.requestSha256,
    outputSha256: resultBindings.outputSha256,
    capabilityManifestSha256: resultBindings.capabilityManifestSha256,
    definitionSnapshotSha256: resultBindings.definitionSnapshotSha256,
  };
}

export function mockScenarioDraftCompletenessVerifier({ draftSha256, scenarioSha256, questionSha256 }) {
  return {
    valid: true,
    verifierId: "mock-scenario-draft-completeness-verifier",
    verifierVersion: "mock-scenario-draft-completeness/v1",
    draftSha256,
    scenarioSha256,
    questionSha256,
  };
}

export function materializeFixture(fixture) {
  const draft = structuredClone(fixture.draft);
  const resolvedCards = structuredClone(fixture.resolvedCards);
  draft.question = { text: fixture.question };
  for (const instance of draft.cardInstances || []) {
    const card = resolvedCards.find((candidate) => String(candidate?.cardId ?? candidate?.id) === String(instance?.cardId));
    const surface = unwrapFixtureCardMention(instance?.mention);
    if (!card || !surface) continue;
    card.input ||= surface;
    card.name ||= surface;
    card.aliases = [...new Set([...(Array.isArray(card.aliases) ? card.aliases : []), surface])];
  }
  for (const collection of [draft.cardInstances, draft.stateFacts, draft.eventHistory, draft.intents, draft.queries, draft.assumptions]) {
    for (const item of collection) {
      item.sourceSpan = sourceSpanFor(fixture.question, item.mention);
      delete item.mention;
    }
  }
  return { question: fixture.question, draft, resolvedCards };
}

function unwrapFixtureCardMention(value) {
  const text = String(value || "");
  const wrappers = new Map([["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"], ["\"", "\""], ["《", "》"], ["〈", "〉"], ["【", "】"], ["[", "]"]]);
  return wrappers.get(text[0]) === text.at(-1) ? text.slice(1, -1) : text;
}
