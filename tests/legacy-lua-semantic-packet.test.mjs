import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  collectLegacyLuaSemanticPacket,
  collectLegacyLuaSemanticResource,
} from "../backend/legacyLuaSemanticClient.mjs";
import {
  canonicalLegacyLuaSha256,
  createLegacyLuaSemanticPacket,
  parseLegacyLuaSemanticPacket,
  projectLegacyLuaSemanticPacketForModel,
  serializeLegacyLuaSemanticPacket,
  validateLegacyLuaSemanticPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";
import {
  createDefaultLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticPacketFactory.mjs";

const IDENTITY_SCHEME = "ocg-legacy-lua-semantic-effect-identity/v1";
const CONTENT = "return true\n";
const SOURCE_HASH = rawSha256(CONTENT);
const SOURCE_SPAN = Object.freeze({
  schemaVersion: "ocg-source-span/v1",
  sourceDocumentId: "legacy:test-resource",
  startOffset: 0,
  endOffset: 6,
  exactText: "return",
  textHash: rawSha256("return"),
  parserMethod: "MIGRATED_LEGACY",
  confidence: 1,
  verificationStatus: "CANDIDATE",
});

function sourceDocument(overrides = {}) {
  return {
    schemaVersion: "ocg-source-document/v1",
    sourceDocumentId: "legacy:test-resource",
    sourceType: "LEGACY_SCRIPT",
    authority: "LEGACY_COMPATIBILITY",
    rulesetVersion: "ocg-ruleset/2026-08-03-experimental",
    documentVersion: "fixture-script@0123456789abcdef",
    effectiveDate: "2026-08-03",
    language: "lua",
    content: CONTENT,
    contentHash: SOURCE_HASH,
    provenance: {
      locator: "fixture://legacy/test-resource.lua",
      retrievedAt: "2026-08-03T00:00:00.000Z",
      publisher: "TEST_FIXTURE",
    },
    ...overrides,
  };
}

function versions(overrides = {}) {
  return {
    engineVersion: "ocg-formal-engine/test",
    irVersion: "ocg-effect-ir/v1",
    rulesetVersion: "ocg-ruleset/2026-08-03-experimental",
    schemaVersion: "ocg-formal-engine/v1",
    compilerVersion: "ocg-card-compiler/v1",
    patternLibraryVersion: "ocg-pattern-library/v1",
    proofVerifierVersion: "ocg-proof-verifier/v1",
    artifacts: {
      luaApiSemanticsRegistryVersion: "ocg-lua-api-semantics-registry/v2",
      operationDependencyGraphVersion: "ocg-operation-dependency-graph/v1",
      legacyLuaActivationPlanVersion: "ocg-legacy-lua-activation-plan/v2",
      legacyLuaCompileResultVersion: "ocg-legacy-lua-compile-result/v2",
      legacyLuaEffectCandidateSetVersion:
        "ocg-legacy-lua-effect-candidate-set/v1",
      activationLegalityScenarioVersion: "ocg-activation-legality-scenario/v1",
      legacyLuaCandidateAnalysisVersion:
        "ocg-legacy-lua-candidate-analysis/v2",
    },
    ...overrides,
  };
}

function artifactVersions(engineVersions = versions()) {
  const { artifacts: _artifacts, ...result } = engineVersions;
  return result;
}

function registry(overrides = {}) {
  return {
    schemaVersion: "ocg-lua-api-semantics-registry/v2",
    registryId: "formal:test-legacy-lua-registry:v2",
    registryVersion: "2.0.0-test",
    authority: "LEGACY_DISCOVERY_ONLY",
    legacyAcceptedAsTruth: false,
    evaluationLogic: "STRONG_KLEENE_THREE_VALUED",
    luaApis: [],
    operationDependencyGraphs: {},
    compatibilityEvidence: {
      pinnedCoreRepository: "https://example.test/ygopro-core.git",
      pinnedCoreCommit: "a".repeat(40),
      pinnedCoreApiAbi: "ocgcore/test",
    },
    ...overrides,
  };
}

function capabilities() {
  return {
    schemaVersion: "ocg-capability-manifest/v1",
    capabilities: [
      descriptor("source/span-validation/v1", "SUPPORTED"),
      descriptor("operation/dependency-expansion/v1", "PARTIAL"),
      descriptor("compatibility/legacy-lua-semantic-discovery/v1", "PARTIAL", [
        "source/span-validation/v1",
        "operation/dependency-expansion/v1",
      ]),
      descriptor("compatibility/legacy-lua-effect-enumeration/v1", "PARTIAL", [
        "compatibility/legacy-lua-semantic-discovery/v1",
      ]),
      descriptor("movement/return-to-hand-legality/v1", "PARTIAL", [
        "operation/dependency-expansion/v1",
      ]),
    ],
  };
}

function descriptor(capabilityId, status, dependencies = []) {
  return {
    capabilityId,
    version: capabilityId.match(/\/v\d+$/u)[0].slice(1),
    status,
    dependencies,
  };
}

function plan(identity, { registryValue = registry(), engineVersions = versions() } = {}) {
  const registryHash = canonicalLegacyLuaSha256(registryValue);
  return {
    schemaVersion: "ocg-legacy-lua-activation-plan/v2",
    sourceDocumentId: "legacy:test-resource",
    sourceContentHash: SOURCE_HASH,
    verificationStatus: "LEGACY_DISCOVERY_ONLY",
    semanticEffectIdentity: identity,
    identityScheme: IDENTITY_SCHEME,
    semanticFingerprint: rawSha256("fingerprint:" + identity),
    apiSemanticsRegistryId: registryValue.registryId,
    apiSemanticsRegistryVersion: registryValue.registryVersion,
    apiSemanticsRegistryHash: registryHash,
    registrationSemantics: [],
    conditionProgram: { kind: "LITERAL", value: true },
    costProgram: { kind: "LITERAL", value: true },
    costExecutionProgram: { kind: "SEQUENCE", steps: [] },
    costOperationApis: [],
    costAtomicOperations: [],
    checkOnlyTargetProgram: { kind: "LITERAL", value: true },
    targetSelectionProgram: { kind: "SEQUENCE", steps: [] },
    operationProgram: { kind: "SEQUENCE", steps: [] },
    operationApis: [],
    atomicOperations: [],
    activationLegalityChecks: [],
    activationLegalityDependencies: [],
    requiredLegacyApis: [],
    requiredCapabilities: [
      "compatibility/legacy-lua-semantic-discovery/v1",
      "compatibility/legacy-lua-effect-enumeration/v1",
      "operation/dependency-expansion/v1",
    ],
    discoveredOperations: [],
    discoveredCostOperations: [],
    normalizations: [],
    sourceSpans: [structuredClone(SOURCE_SPAN)],
    unresolvedSemantics: [],
    versions: artifactVersions(engineVersions),
  };
}

function rawCandidate(identity, options = {}) {
  const candidatePlan = plan(identity, options);
  return {
    kind: "CANDIDATE",
    semanticEffectIdentity: identity,
    identityScheme: IDENTITY_SCHEME,
    plan: candidatePlan,
    sourceSpans: candidatePlan.sourceSpans,
    unknownReasons: [legacyReason()],
  };
}

function legacyReason() {
  return {
    phase: "LEGACY_DISCOVERY",
    code: "LEGACY_SOURCE_NON_AUTHORITATIVE",
    message: "legacy source is not official rules authority",
    evidenceIds: ["legacy:test-resource"],
  };
}

function mockEngine({
  identities = [rawSha256("effect-a")],
  engineVersions = versions(),
  registryValue = registry(),
  mutateCandidateSet,
  mutateCompile,
  mutateAnalysis,
  throwAt,
} = {}) {
  const candidates = identities.map((identity) =>
    rawCandidate(identity, { registryValue, engineVersions })
  );
  const calls = [];
  const engine = {
    getEngineVersions() {
      calls.push("versions");
      if (throwAt === "versions") throw new Error("version endpoint failed");
      return structuredClone(engineVersions);
    },
    getEngineCapabilities() {
      calls.push("capabilities");
      if (throwAt === "capabilities") throw new Error("capability endpoint failed");
      return capabilities();
    },
    getLegacyLuaApiSemanticsRegistry() {
      calls.push("registry");
      if (throwAt === "registry") throw new Error("registry endpoint failed");
      return structuredClone(registryValue);
    },
    enumerateLegacyLuaEffectCandidates() {
      calls.push("enumerate");
      if (throwAt === "enumerate") throw new Error("enumeration failed");
      const result = {
        schemaVersion: "ocg-legacy-lua-effect-candidate-set/v1",
        kind: "LEGACY_LUA_EFFECT_CANDIDATE_SET",
        verdict: "UNKNOWN",
        legacyAcceptedAsTruth: false,
        sourceDocumentId: "legacy:test-resource",
        sourceContentHash: SOURCE_HASH,
        candidates: structuredClone([...candidates].reverse()),
        unknownReasons: [legacyReason()],
        requiredCapabilities: [
          "compatibility/legacy-lua-semantic-discovery/v1",
          "compatibility/legacy-lua-effect-enumeration/v1",
          "operation/dependency-expansion/v1",
        ],
        versions: artifactVersions(engineVersions),
      };
      mutateCandidateSet?.(result);
      return result;
    },
    compileLegacyLuaActivationPlan(_source, selection) {
      calls.push("compile:" + selection.semanticEffectIdentity);
      if (throwAt === "compile") throw new Error("compile failed");
      const candidate = candidates.find((item) =>
        item.semanticEffectIdentity === selection.semanticEffectIdentity
      );
      const result = {
        schemaVersion: "ocg-legacy-lua-compile-result/v2",
        kind: "CANDIDATE",
        verdict: "UNKNOWN",
        plan: structuredClone(candidate.plan),
        unknownReasons: [legacyReason()],
        versions: artifactVersions(engineVersions),
      };
      mutateCompile?.(result);
      return result;
    },
    analyzeLegacyLuaActivation({ semanticEffectIdentity }) {
      calls.push("analyze:" + semanticEffectIdentity);
      if (throwAt === "analyze") throw new Error("analysis failed");
      const candidate = candidates.find((item) =>
        item.semanticEffectIdentity === semanticEffectIdentity
      );
      const result = {
        schemaVersion: "ocg-legacy-lua-candidate-analysis/v2",
        kind: "LEGACY_CANDIDATE_ANALYSIS",
        verdict: "UNKNOWN",
        candidateVerdict: "TRUE",
        legacyAcceptedAsTruth: false,
        semanticEffectIdentity,
        planFingerprint: candidate.plan.semanticFingerprint,
        apiSemanticsRegistryId: registryValue.registryId,
        apiSemanticsRegistryVersion: registryValue.registryVersion,
        apiSemanticsRegistryHash: canonicalLegacyLuaSha256(registryValue),
        legalCandidateCount: 1,
        witnessInstanceIds: ["anonymous-instance"],
        branches: [],
        structuredTrace: [],
        proof: null,
        unknownReasons: [legacyReason()],
        requiredCapabilities: candidate.plan.requiredCapabilities,
        versions: artifactVersions(engineVersions),
      };
      mutateAnalysis?.(result);
      return result;
    },
  };
  return { engine, calls };
}

test("client preserves every effect candidate and never promotes legacy output to authority", async () => {
  const identities = [
    rawSha256("effect-c"),
    rawSha256("effect-a"),
    rawSha256("effect-b"),
  ];
  const { engine, calls } = mockEngine({ identities });
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    scenario: { schemaVersion: "test-scenario/v1" },
    engine,
  });

  assert.equal(resource.status, "READY");
  assert.equal(resource.authority, "LEGACY_COMPATIBILITY");
  assert.equal(resource.canConfirmOfficialRuling, false);
  assert.equal(resource.legacyAcceptedAsTruth, false);
  assert.equal(resource.verdict, "UNKNOWN");
  assert.equal(resource.effectCandidates.length, 3);
  assert.deepEqual(
    resource.effectCandidates.map((item) => item.semanticEffectIdentity),
    [...identities].sort(),
  );
  assert.equal(
    resource.effectCandidates.every((item) =>
      item.verdict === "UNKNOWN" &&
      item.legacyAcceptedAsTruth === false &&
      item.analysisArtifact.candidateVerdict === "TRUE" &&
      item.analysisArtifact.verdict === "UNKNOWN"
    ),
    true,
  );
  assert.equal(
    calls.filter((call) => call.startsWith("compile:")).length,
    3,
  );
  assert.equal(
    calls.filter((call) => call.startsWith("analyze:")).length,
    3,
  );
});

test("client preserves partial compile and UNKNOWN analysis artifacts", async () => {
  const { engine } = mockEngine({
    mutateCompile(result) {
      result.kind = "TYPED_UNKNOWN";
      result.partialPlan = result.plan;
      delete result.plan;
      result.unknownReasons = [{
        ...legacyReason(),
        code: "PARTIAL_COMPILE",
        message: "compile plan is partial",
      }];
    },
    mutateAnalysis(result) {
      result.candidateVerdict = "UNKNOWN";
      result.legalCandidateCount = 0;
      result.witnessInstanceIds = [];
      result.unknownReasons = [{
        ...legacyReason(),
        code: "SCENARIO_STATE_INCOMPLETE",
        message: "scenario state is incomplete",
      }];
    },
  });
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    scenario: { schemaVersion: "test-scenario/v1" },
    engine,
  });

  assert.equal(resource.status, "TYPED_UNKNOWN");
  assert.equal(resource.verdict, "UNKNOWN");
  assert.equal(resource.effectCandidates.length, 1);
  const candidate = resource.effectCandidates[0];
  assert.equal(candidate.kind, "TYPED_UNKNOWN");
  assert.notEqual(candidate.semanticArtifact, null);
  assert.notEqual(candidate.compileResultSha256, null);
  assert.equal(candidate.analysisArtifact.candidateVerdict, "UNKNOWN");
  assert.equal(candidate.analysisArtifact.verdict, "UNKNOWN");
  assert.ok(candidate.unknownReasons.some(
    (reason) => reason.code === "PARTIAL_COMPILE",
  ));
  assert.ok(candidate.unknownReasons.some(
    (reason) => reason.code === "SCENARIO_STATE_INCOMPLETE",
  ));
});

test("model projection keeps generic dependencies but drops source and AST payload", async () => {
  const { engine } = mockEngine();
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    scenario: { schemaVersion: "test-scenario/v1" },
    engine,
  });
  const packet = createLegacyLuaSemanticPacket({ resources: [resource] });
  const view = projectLegacyLuaSemanticPacketForModel(packet);
  const serializedPacket = serializeLegacyLuaSemanticPacket(packet);
  const serializedView = JSON.stringify(view);

  assert.equal(view.schemaVersion,
    "ocg-assistant-lua-semantic-model-view/v1");
  assert.equal(view.sourcePacketSha256, packet.packetSha256);
  assert.equal(view.verdict, "UNKNOWN");
  assert.equal(view.canConfirmOfficialRuling, false);
  assert.equal(view.legacyAcceptedAsTruth, false);
  assert.equal(view.effectCandidates.length, 1);
  assert.deepEqual(
    view.effectCandidates[0].requiredCapabilities,
    [...resource.effectCandidates[0].semanticArtifact.plan.requiredCapabilities]
      .sort(),
  );
  assert.ok(Buffer.byteLength(serializedView) < Buffer.byteLength(serializedPacket));
  assert.doesNotMatch(serializedView, /sourceSpans|exactText|conditionProgram/u);
});

test("packet hashing is stable and rejects caller-reordered candidate artifacts fail-closed", async () => {
  const first = mockEngine({
    identities: [rawSha256("effect-z"), rawSha256("effect-a")],
  });
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    engine: first.engine,
  });
  const reversed = structuredClone(resource);
  reversed.effectCandidates.reverse();
  // A resource is independently content-addressed, so re-finalizing caller
  // order is intentionally not allowed. Packet construction receives the
  // canonical resource both times and caller resource order cannot matter.
  const packetA = createLegacyLuaSemanticPacket({ resources: [resource] });
  const packetB = createLegacyLuaSemanticPacket({ resources: [resource] });
  assert.equal(packetA.packetSha256, packetB.packetSha256);
  assert.equal(serializeLegacyLuaSemanticPacket(packetA),
    serializeLegacyLuaSemanticPacket(packetB));
  const rejected = createLegacyLuaSemanticPacket({ resources: [reversed] });
  assert.equal(rejected.verdict, "UNKNOWN");
  assert.equal(rejected.resources.length, 0);
  assert.equal(
    rejected.unknownReasons.some((item) => item.code === "LEGACY_LUA_ORDER_INVALID"),
    true,
  );
  assert.deepEqual(
    packetA.effectCandidates.map((item) => item.semanticEffectIdentity),
    [rawSha256("effect-a"), rawSha256("effect-z")].sort(),
  );
});

test("deterministic truncation accounts for every omitted effect by identity and hash", async () => {
  const identities = [
    rawSha256("effect-1"),
    rawSha256("effect-2"),
    rawSha256("effect-3"),
  ];
  const { engine } = mockEngine({ identities });
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    engine,
  });
  const first = createLegacyLuaSemanticPacket({
    resources: [resource],
    maxCandidates: 1,
  });
  const second = createLegacyLuaSemanticPacket({
    resources: [resource],
    maxCandidates: 1,
  });

  assert.equal(first.packetSha256, second.packetSha256);
  assert.equal(first.truncation.totalCandidateCount, 3);
  assert.equal(first.truncation.includedCandidateCount, 1);
  assert.equal(first.truncation.omittedCandidateCount, 2);
  assert.deepEqual(
    new Set([
      ...first.effectCandidates.map((item) => item.candidateSha256),
      ...first.omittedCandidates.map((item) => item.candidateSha256),
    ]),
    new Set(resource.effectCandidates.map((item) => item.candidateSha256)),
  );
  assert.equal(
    first.omittedCandidates.every((item) =>
      item.reason === "MAX_CANDIDATES" &&
      identities.includes(item.semanticEffectIdentity)
    ),
    true,
  );
});

test("serialized byte limit removes complete candidates instead of cutting semantic JSON", async () => {
  const { engine } = mockEngine({
    identities: [rawSha256("effect-a"), rawSha256("effect-b")],
  });
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    engine,
  });
  const full = createLegacyLuaSemanticPacket({ resources: [resource] });
  const limit = Buffer.byteLength(serializeLegacyLuaSemanticPacket(full), "utf8") - 1;
  const limited = createLegacyLuaSemanticPacket({
    resources: [resource],
    maxSerializedBytes: limit,
  });
  assert.equal(limited.truncation.applied, true);
  assert.equal(limited.truncation.totalCandidateCount, 2);
  assert.equal(limited.effectCandidates.length < 2, true);
  assert.equal(
    limited.effectCandidates.every((item) => item.semanticArtifact !== null),
    true,
  );
});

test("source, registry, version, and official-authority violations fail closed", async (t) => {
  await t.test("source hash mismatch", async () => {
    const { engine, calls } = mockEngine();
    const resource = await collectLegacyLuaSemanticResource({
      sourceDocument: sourceDocument({ contentHash: "0".repeat(64) }),
      engine,
    });
    assert.equal(resource.status, "TYPED_UNKNOWN");
    assert.equal(resource.verdict, "UNKNOWN");
    assert.equal(calls.length, 0);
  });

  await t.test("registry hash mismatch in plan", async () => {
    const { engine } = mockEngine({
      mutateCandidateSet(result) {
        result.candidates[0].plan.apiSemanticsRegistryHash = "0".repeat(64);
      },
    });
    const resource = await collectLegacyLuaSemanticResource({
      sourceDocument: sourceDocument(),
      engine,
    });
    assert.equal(resource.status, "TYPED_UNKNOWN");
    assert.equal(resource.effectCandidates[0].kind, "TYPED_UNKNOWN");
    assert.equal(resource.effectCandidates[0].semanticArtifact, null);
  });

  await t.test("artifact version mismatch", async () => {
    const { engine, calls } = mockEngine({
      engineVersions: versions({
        artifacts: {
          ...versions().artifacts,
          legacyLuaActivationPlanVersion:
            "ocg-legacy-lua-activation-plan/v1",
        },
      }),
    });
    const resource = await collectLegacyLuaSemanticResource({
      sourceDocument: sourceDocument(),
      engine,
    });
    assert.equal(resource.status, "TYPED_UNKNOWN");
    assert.equal(calls.includes("enumerate"), false);
  });

  await t.test("analysis attempts to claim a formal verdict", async () => {
    const { engine } = mockEngine({
      mutateAnalysis(result) { result.verdict = "TRUE"; },
    });
    const resource = await collectLegacyLuaSemanticResource({
      sourceDocument: sourceDocument(),
      scenario: { schemaVersion: "test-scenario/v1" },
      engine,
    });
    assert.equal(resource.status, "TYPED_UNKNOWN");
    assert.equal(resource.effectCandidates[0].kind, "TYPED_UNKNOWN");
    assert.equal(resource.effectCandidates[0].analysisArtifact, null);
    assert.equal(resource.verdict, "UNKNOWN");
  });
});

test("transport or engine exceptions become typed UNKNOWN packets", async () => {
  const { engine } = mockEngine({ throwAt: "enumerate" });
  const packet = await collectLegacyLuaSemanticPacket({
    inputs: [{ sourceDocument: sourceDocument() }],
    engine,
  });
  assert.equal(packet.verdict, "UNKNOWN");
  assert.equal(packet.canConfirmOfficialRuling, false);
  assert.equal(packet.resources.length, 1);
  assert.equal(packet.resources[0].status, "TYPED_UNKNOWN");
  assert.equal(packet.effectCandidates.length, 0);
});

test("source failures are isolated per passcode without discarding valid candidates", async (t) => {
  const cases = [
    {
      name: "typed source UNKNOWN",
      code: "LOCKED_SCRIPT_NOT_FOUND",
      message: "locked script was not found",
      details: { upstreamKind: "TYPED_UNKNOWN" },
      retryable: false,
    },
    {
      name: "source transport failure",
      code: "LEGACY_LUA_HTTP_UNAVAILABLE",
      message: "connection refused",
      details: { endpoint: "/v1/legacy-lua/source" },
      retryable: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { engine } = mockEngine();
      const factory = createDefaultLegacyLuaSemanticPacketFactory({
        facadeFactory: () => ({
          ...engine,
          async resolveLegacyLuaSource(passcode) {
            if (passcode === "12345678") return sourceDocument();
            const error = new Error(scenario.message);
            error.code = scenario.code;
            error.details = scenario.details;
            throw error;
          },
        }),
      });

      const packet = await factory({
        cardResolution: {
          resolvedCards: [
            { passcode: "12345678" },
            { passcode: "87654321" },
          ],
        },
      });

      validateLegacyLuaSemanticPacket(packet);
      assert.equal(packet.resources.length, 2);
      assert.equal(packet.effectCandidates.length, 1);
      assert.equal(packet.effectCandidates[0].kind, "CANDIDATE");

      const ready = packet.resources.find((resource) =>
        resource.status === "READY"
      );
      const unresolved = packet.resources.find((resource) =>
        resource.resourceBinding.locator ===
          "legacy-lua-passcode:87654321"
      );
      assert.ok(ready);
      assert.equal(ready.candidateCount, 1);
      assert.equal(packet.effectCandidates[0].resourceId, ready.resourceId);
      assert.ok(unresolved);
      assert.equal(unresolved.status, "TYPED_UNKNOWN");
      assert.equal(unresolved.candidateCount, 0);
      assert.equal(unresolved.resourceBinding.sourceDocumentId, null);
      assert.equal(unresolved.resourceBinding.sourceContentSha256, null);
      assert.equal(unresolved.resourceBinding.documentVersion, null);
      assert.equal(unresolved.resourceBinding.retrievedAt, null);
      assert.equal(unresolved.unknownReasons.length, 1);
      assert.equal(unresolved.unknownReasons[0].code, scenario.code);
      assert.equal(unresolved.unknownReasons[0].details.passcode, "87654321");
      assert.equal(unresolved.unknownReasons[0].details.retryable,
        scenario.retryable);
      assert.deepEqual(unresolved.unknownReasons[0].details.cause,
        scenario.details);
    });
  }
});

test("packet parsing rejects authority escalation, changed hashes, and altered candidate semantics", async () => {
  const { engine } = mockEngine();
  const resource = await collectLegacyLuaSemanticResource({
    sourceDocument: sourceDocument(),
    engine,
  });
  const packet = createLegacyLuaSemanticPacket({ resources: [resource] });
  assert.equal(parseLegacyLuaSemanticPacket(
    serializeLegacyLuaSemanticPacket(packet),
  ).packetSha256, packet.packetSha256);

  const escalated = structuredClone(packet);
  escalated.canConfirmOfficialRuling = true;
  assert.throws(() => validateLegacyLuaSemanticPacket(escalated));
  const parsedEscalation = parseLegacyLuaSemanticPacket(
    JSON.stringify(escalated),
  );
  assert.equal(parsedEscalation.verdict, "UNKNOWN");
  assert.equal(parsedEscalation.resources.length, 0);
  assert.equal(parsedEscalation.canConfirmOfficialRuling, false);

  const changedRegistry = structuredClone(packet);
  changedRegistry.resources[0].registryBinding.registrySha256 = "0".repeat(64);
  assert.throws(() => validateLegacyLuaSemanticPacket(changedRegistry));

  const changedCandidate = structuredClone(packet);
  changedCandidate.effectCandidates[0].semanticArtifact.plan.atomicOperations = [
    "DESTROY",
  ];
  assert.throws(() => validateLegacyLuaSemanticPacket(changedCandidate));
  assert.equal(
    parseLegacyLuaSemanticPacket("{not valid json").verdict,
    "UNKNOWN",
  );
});

function rawSha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
