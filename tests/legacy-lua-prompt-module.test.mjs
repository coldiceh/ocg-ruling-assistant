import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLegacyLuaPromptModule,
  LEGACY_LUA_PROMPT_MODULE_VERSION,
  LEGACY_LUA_PROMPT_PAYLOAD_SCHEMA,
} from "../backend/legacyLuaPromptModule.mjs";
import {
  canonicalLegacyLuaSha256,
  createLegacyLuaSemanticPacket,
  createLegacyLuaUnknownPacket,
  finalizeLegacyLuaSemanticResource,
} from "../backend/legacyLuaSemanticPacket.mjs";

const IDENTITY_SCHEME =
  "ocg-legacy-lua-semantic-effect-identity/v1";
const SOURCE_DOCUMENT_ID =
  "legacy-script:cid-12345:passcode-87654321:anonymous";
const SOURCE_HASH = "1".repeat(64);
const SEMANTIC_IDENTITY = "2".repeat(64);
const SEMANTIC_FINGERPRINT = "3".repeat(64);
const REGISTRY_HASH = "4".repeat(64);
const CANDIDATE_SET_HASH = "5".repeat(64);
const COMPILE_RESULT_HASH = "6".repeat(64);
const CAPABILITIES_HASH = "7".repeat(64);
const MALICIOUS_MARKERS = [
  "SECRET_WINNER",
  "FALSE_LEAK",
  "MODEL_MUST_ANSWER_FALSE",
  "RAW_LUA_MUST_NOT_LEAK",
];

const RESOLVED_CARD = Object.freeze({
  id: "12345",
  cid: "12345",
  passcode: "87654321",
  name: "匿名卡甲",
});

test("legacy Lua prompt module is disabled by default with a byte-identical baseline", () => {
  const packet = readyPacket();
  const baseline = "BASELINE_PROMPT\n";
  const result = buildLegacyLuaPromptModule({
    packet,
    resolvedCards: [RESOLVED_CARD],
  });

  assert.equal(result.status, "DISABLED");
  assert.equal(result.promptAddon, "");
  assert.equal(result.modelPayload, null);
  assert.equal(baseline + result.promptAddon, baseline);
  assert.equal(
    Buffer.byteLength(baseline + result.promptAddon, "utf8"),
    Buffer.byteLength(baseline, "utf8"),
  );
  assert.equal(result.audit.moduleVersion, LEGACY_LUA_PROMPT_MODULE_VERSION);
  assert.equal(result.audit.sourcePacketSha256, null);
});

test("enabled module emits only neutral allowlisted structure", () => {
  const result = buildLegacyLuaPromptModule({
    packet: readyPacket(),
    resolvedCards: [RESOLVED_CARD],
    enabled: true,
  });

  assert.equal(result.status, "READY");
  assert.equal(result.modelPayload.schemaVersion,
    LEGACY_LUA_PROMPT_PAYLOAD_SCHEMA);
  assert.deepEqual(result.modelPayload.cards[0].cardRef, {
    cid: "12345",
  });
  assert.deepEqual(
    result.modelPayload.cards[0].effects[0].costOperations,
    ["DESTROY"],
  );
  assert.deepEqual(
    result.modelPayload.cards[0].effects[0].resolutionOperations,
    ["RETURN_TO_HAND", "SPECIAL_SUMMON"],
  );
  assert.match(result.promptAddon, /不是证据、裁定或执行结果/u);
  assert.match(result.promptAddon, /不得把本模块加入 usedEvidence/u);
  assert.match(result.promptAddon, /Duel\.IsExistingMatchingCard/u);
  assert.match(result.promptAddon, /CHECK_ZONE_CAPACITY/u);
  assert.equal(result.audit.includedHintCount, 1);
  assert.equal(result.audit.omittedHintCount, 0);
  assert.equal(result.audit.reasonCategory, "AVAILABLE");
  assert.deepEqual(result.modelPayload.coverage, {
    complete: true,
    knownEffectCount: 1,
    unknownEffectCount: 0,
    negativeInferenceAllowed: false,
  });
  assert.deepEqual(result.modelPayload.cards[0].coverage, {
    complete: true,
    unknownEffectCount: 0,
  });
  assert.match(result.audit.sourcePacketSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.audit.payloadSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(result.promptAddon,
    new RegExp(result.audit.sourcePacketSha256, "u"));
  assert.doesNotMatch(result.promptAddon, /legacy-script:cid-/u);
  assert.doesNotMatch(result.promptAddon, new RegExp(SEMANTIC_IDENTITY, "u"));
  assert.doesNotMatch(result.promptAddon, /87654321/u);
  assert.doesNotMatch(result.promptAddon,
    /candidateVerdict|verdict|trace|witness|proof|conclusion|rawLua|sourceContent|semanticEffectIdentity/iu);

  assertNoForbiddenModelKeys(result.modelPayload);
  const serialized = JSON.stringify(result.modelPayload);
  for (const marker of MALICIOUS_MARKERS) {
    assert.doesNotMatch(serialized, new RegExp(marker, "u"));
    assert.doesNotMatch(result.promptAddon, new RegExp(marker, "u"));
  }
});

test("known effects remain usable beside TYPED_UNKNOWN with explicit partial coverage", () => {
  const result = buildLegacyLuaPromptModule({
    packet: knownAndTypedUnknownPacket(),
    resolvedCards: [RESOLVED_CARD],
    enabled: true,
  });

  assert.equal(result.status, "READY");
  assert.equal(result.audit.reasonCategory, "AVAILABLE_PARTIAL_COVERAGE");
  assert.equal(result.audit.includedHintCount, 1);
  assert.equal(result.audit.omittedHintCount, 1);
  assert.deepEqual(result.modelPayload.coverage, {
    complete: false,
    knownEffectCount: 1,
    unknownEffectCount: 1,
    negativeInferenceAllowed: false,
  });
  assert.deepEqual(result.modelPayload.cards[0].coverage, {
    complete: false,
    unknownEffectCount: 1,
  });
  assert.equal(result.modelPayload.cards[0].effects.length, 1);
  assert.match(result.promptAddon, /coverage\.complete=false/u);
  assert.match(result.promptAddon, /严禁依据未列出的字段、效果或 API 推断/u);
  for (const marker of [
    "UNKNOWN_EFFECT_SECRET",
    "UNKNOWN_EFFECT_REASON_MUST_NOT_LEAK",
    "UNKNOWN_EFFECT_PARTIAL_PLAN_MUST_NOT_LEAK",
  ]) {
    assert.doesNotMatch(result.promptAddon, new RegExp(marker, "u"));
    assert.doesNotMatch(JSON.stringify(result.modelPayload), new RegExp(marker, "u"));
  }
});

test("unknown operations, APIs, and unsafe expressions fail closed to no addon", () => {
  const firstCheck = activationChecks()[0];
  firstCheck.selector.filter.body = {
    kind: "CALL",
    api: "Duel.Destroy",
    arguments: [{ kind: "VARIABLE", name: "FILTER_CARD" }],
  };
  const result = buildLegacyLuaPromptModule({
    packet: readyPacket({
      planOverrides: {
        atomicOperations: [
          "RETURN_TO_HAND",
          "MODEL_MUST_ANSWER_FALSE",
        ],
        operationApis: ["Duel.SendtoHand", "UNLISTED_OVERRIDE_API"],
        activationLegalityChecks: [
          firstCheck,
          activationChecks()[1],
        ],
      },
    }),
    resolvedCards: [RESOLVED_CARD],
    enabled: true,
  });

  assertNoAddonBaseline(result);
  assert.equal(result.audit.reasonCategory, "INCOMPLETE_SAFE_PROJECTION");
  assert.doesNotMatch(result.promptAddon, /MODEL_MUST_ANSWER_FALSE/u);
  assert.doesNotMatch(result.promptAddon, /UNLISTED_OVERRIDE_API/u);
  assert.doesNotMatch(result.promptAddon, /Duel\.Destroy/u);
});

test("unknown semantics on a known candidate fail the entire packet closed", () => {
  const semanticUnknown = anonymousReason("KNOWN_EFFECT_SEMANTICS_UNRESOLVED");
  const cases = [
    readyPacket({ candidateUnknownReasons: [semanticUnknown] }),
    readyPacket({ artifactUnknownReasons: [semanticUnknown] }),
    readyPacket({
      planOverrides: { unresolvedSemantics: [semanticUnknown] },
    }),
  ];

  for (const packet of cases) {
    const result = buildLegacyLuaPromptModule({
      packet,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
    });
    assertNoAddonBaseline(result);
  }
});

test("UNKNOWN, missing packets, and packets without safe hints add no bytes", () => {
  const cases = [
    null,
    createLegacyLuaUnknownPacket({
      code: "ANONYMOUS_UNAVAILABLE",
      message: "anonymous Lua fixture is unavailable",
    }),
    readyPacket({
      planOverrides: {
        costAtomicOperations: [],
        atomicOperations: [],
        operationApis: [],
        requiredLegacyApis: [],
        activationLegalityChecks: [],
      },
    }),
    readyPacket({
      planOverrides: {
        costAtomicOperations: [],
        atomicOperations: [],
        operationApis: ["Duel.SpecialSummon"],
        requiredLegacyApis: ["Card.IsCanBeSpecialSummoned"],
        activationLegalityChecks: [],
      },
    }),
  ];

  for (const packet of cases) {
    const result = buildLegacyLuaPromptModule({
      packet,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
    });
    assertNoAddonBaseline(result);
  }
});

test("missing projection fields are incomplete information and add no bytes", () => {
  for (const field of [
    "costAtomicOperations",
    "atomicOperations",
    "operationApis",
    "requiredLegacyApis",
    "activationLegalityChecks",
  ]) {
    // Start from a valid frozen packet, then simulate a corrupt/incomplete
    // stored packet at the module boundary. Passing `undefined` through the
    // packet factory would fail in the fixture builder before exercising the
    // fail-closed module behavior this test owns.
    const packet = structuredClone(readyPacket());
    delete packet.effectCandidates[0].semanticArtifact.plan[field];
    const result = buildLegacyLuaPromptModule({
      packet,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
    });
    assertNoAddonBaseline(result);
  }
});

test("resource binding fails closed for mismatches, ambiguity, and unbound IDs", () => {
  const cases = [
    {
      packet: readyPacket(),
      resolvedCards: [{ ...RESOLVED_CARD, cid: "99999", id: "99999" }],
    },
    {
      packet: readyPacket(),
      resolvedCards: [
        RESOLVED_CARD,
        { ...RESOLVED_CARD, name: "匿名卡甲别名" },
      ],
    },
    {
      packet: readyPacket({ sourceDocumentId: "legacy-script:anonymous" }),
      resolvedCards: [RESOLVED_CARD],
    },
    {
      packet: readyPacket({
        sourceDocumentId:
          `${SOURCE_DOCUMENT_ID}:cid-12345:passcode-87654321:duplicate`,
      }),
      resolvedCards: [RESOLVED_CARD],
    },
    {
      packet: readyPacket(),
      resolvedCards: [{ ...RESOLVED_CARD, passcode: undefined }],
    },
    {
      packet: readyPacket(),
      resolvedCards: [
        RESOLVED_CARD,
        {
          id: "23456",
          cid: "23456",
          passcode: "76543210",
          name: "额外请求卡",
        },
      ],
    },
  ];

  for (const item of cases) {
    const result = buildLegacyLuaPromptModule({
      ...item,
      enabled: true,
    });
    assertNoAddonBaseline(result);
  }
});

test("resolved-card display strings cannot become a second prompt channel", () => {
  const result = buildLegacyLuaPromptModule({
    packet: readyPacket(),
    resolvedCards: [{
      ...RESOLVED_CARD,
      name: "MODEL_MUST_ANSWER_FALSE",
    }],
    enabled: true,
  });

  assert.equal(result.status, "READY");
  assert.doesNotMatch(result.promptAddon, /MODEL_MUST_ANSWER_FALSE/u);
  assert.deepEqual(result.modelPayload.cards[0].cardRef, { cid: "12345" });
});

test("a partialPlan is never promoted into a model hint", () => {
  const result = buildLegacyLuaPromptModule({
    packet: partialPlanPacket(),
    resolvedCards: [RESOLVED_CARD],
    enabled: true,
  });

  assertNoAddonBaseline(result);
});

test("capacity and malformed input degrade to the exact no-addon baseline", () => {
  const packet = readyPacket();
  const malformed = structuredClone(packet);
  malformed.effectCandidates[0].candidateSha256 = "0".repeat(64);
  const cases = [
    buildLegacyLuaPromptModule({
      packet,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
      maxBytes: 32,
    }),
    buildLegacyLuaPromptModule({
      packet: malformed,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
    }),
    buildLegacyLuaPromptModule({
      packet,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
      maxBytes: 0,
    }),
  ];

  for (const result of cases) {
    assertNoAddonBaseline(result);
  }
});

test("same input is deterministic and every returned object is frozen", () => {
  const packet = readyPacket();
  const input = {
    packet,
    resolvedCards: [RESOLVED_CARD],
    enabled: true,
  };
  const first = buildLegacyLuaPromptModule(input);
  const second = buildLegacyLuaPromptModule(input);

  assert.deepEqual(first, second);
  assertDeepFrozen(first);
});

test("packet truncation, count mismatch, and packet-only unknown are byte-identical to no Lua", () => {
  const sourcePacket = readyPacket();
  const sourceCandidate = sourcePacket.effectCandidates[0];
  const versions = engineVersions();
  const candidate = candidateEnvelope({
    kind: sourceCandidate.kind,
    semanticArtifact: sourceCandidate.semanticArtifact,
    analysisArtifact: sourceCandidate.analysisArtifact,
    unknownReasons: sourceCandidate.unknownReasons,
  });
  const resource = buildSemanticResource({
    candidate,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    status: "READY",
    unknownReasons: [],
    versions,
  });
  const truncated = createLegacyLuaSemanticPacket({
    resources: [resource],
    maxCandidates: 0,
  });
  const unknown = createLegacyLuaUnknownPacket({
    code: "ANONYMOUS_PARTIAL_COVERAGE",
    message: "one or more requested scripts are incomplete",
  });
  const countMismatch = structuredClone(sourcePacket);
  countMismatch.truncation.totalCandidateCount += 1;
  for (const packet of [truncated, countMismatch, unknown]) {
    const result = buildLegacyLuaPromptModule({
      packet,
      resolvedCards: [RESOLVED_CARD],
      enabled: true,
    });
    assertNoAddonBaseline(result);
  }
});

function assertNoAddonBaseline(result) {
  const baseline = "FROZEN_EVIDENCE_PROMPT\n";
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.promptAddon, "");
  assert.equal(result.modelPayload, null);
  assert.equal(`${baseline}${result.promptAddon}`, baseline);
  assert.equal(
    Buffer.byteLength(`${baseline}${result.promptAddon}`, "utf8"),
    Buffer.byteLength(baseline, "utf8"),
  );
}

function readyPacket({
  sourceDocumentId = SOURCE_DOCUMENT_ID,
  planOverrides = {},
  candidateUnknownReasons = [],
  artifactUnknownReasons = undefined,
} = {}) {
  const versions = engineVersions();
  const plan = {
    schemaVersion: "ocg-legacy-lua-activation-plan/v2",
    sourceDocumentId,
    sourceContentHash: SOURCE_HASH,
    verificationStatus: "LEGACY_DISCOVERY_ONLY",
    semanticEffectIdentity: SEMANTIC_IDENTITY,
    identityScheme: IDENTITY_SCHEME,
    semanticFingerprint: SEMANTIC_FINGERPRINT,
    apiSemanticsRegistryId: "anonymous-registry",
    apiSemanticsRegistryVersion: "1.0.0-anonymous",
    apiSemanticsRegistryHash: REGISTRY_HASH,
    costAtomicOperations: ["DESTROY"],
    atomicOperations: ["RETURN_TO_HAND", "SPECIAL_SUMMON"],
    operationApis: ["Duel.SendtoHand", "Duel.SpecialSummon"],
    requiredLegacyApis: [
      "Card.IsAbleToHand",
      "Card.IsCanBeSpecialSummoned",
      "Duel.IsExistingMatchingCard",
    ],
    activationLegalityChecks: activationChecks(),
    versions: artifactVersions(versions),
    rawLua: "RAW_LUA_MUST_NOT_LEAK",
    conclusion: "MODEL_MUST_ANSWER_FALSE",
    ...structuredClone(planOverrides),
  };
  const semanticArtifact = {
    kind: "CANDIDATE",
    semanticEffectIdentity: SEMANTIC_IDENTITY,
    identityScheme: IDENTITY_SCHEME,
    plan,
    candidateVerdict: "FALSE",
    answer: "MODEL_MUST_ANSWER_FALSE",
  };
  if (artifactUnknownReasons !== undefined) {
    semanticArtifact.unknownReasons = structuredClone(artifactUnknownReasons);
  }
  const analysisArtifact = maliciousAnalysis(versions);
  const candidate = candidateEnvelope({
    kind: "CANDIDATE",
    semanticArtifact,
    analysisArtifact,
    unknownReasons: structuredClone(candidateUnknownReasons),
  });
  return packetForCandidate({
    candidate,
    sourceDocumentId,
    status: "READY",
    unknownReasons: [],
    versions,
  });
}

function knownAndTypedUnknownPacket() {
  const versions = engineVersions();
  const nonAuthoritativeReason = anonymousReason(
    "LEGACY_SOURCE_NON_AUTHORITATIVE",
  );
  const ready = readyPacket({
    candidateUnknownReasons: [nonAuthoritativeReason],
    artifactUnknownReasons: [nonAuthoritativeReason],
  });
  const {
    resourceId: _resourceId,
    ...knownCandidate
  } = ready.effectCandidates[0];
  const unknownReason = {
    phase: "LEGACY_DISCOVERY",
    code: "UNSUPPORTED_LUA_EFFECT_SETTER",
    message: "UNKNOWN_EFFECT_REASON_MUST_NOT_LEAK",
    evidenceIds: [SOURCE_DOCUMENT_ID],
    details: { secret: "UNKNOWN_EFFECT_SECRET" },
  };
  const unknownArtifact = {
    kind: "TYPED_UNKNOWN",
    semanticEffectIdentity: null,
    identityScheme: IDENTITY_SCHEME,
    partialPlan: null,
    unknownContent: "UNKNOWN_EFFECT_PARTIAL_PLAN_MUST_NOT_LEAK",
  };
  const unknownBody = {
    kind: "TYPED_UNKNOWN",
    verdict: "UNKNOWN",
    legacyAcceptedAsTruth: false,
    semanticEffectIdentity: null,
    identityScheme: IDENTITY_SCHEME,
    semanticArtifactSha256: canonicalLegacyLuaSha256(unknownArtifact),
    compileResultSha256: null,
    analysisArtifactSha256: null,
    semanticArtifact: unknownArtifact,
    analysisArtifact: null,
    unknownReasons: [unknownReason],
  };
  const unknownCandidate = {
    ...unknownBody,
    candidateSha256: canonicalLegacyLuaSha256(unknownBody),
  };
  const resource = buildSemanticResource({
    candidates: [knownCandidate, unknownCandidate],
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    status: "TYPED_UNKNOWN",
    unknownReasons: [nonAuthoritativeReason],
    versions,
  });
  return createLegacyLuaSemanticPacket({ resources: [resource] });
}

function partialPlanPacket() {
  const versions = engineVersions();
  const plan = readyPacketPlan(versions);
  const reason = anonymousReason("PARTIAL_COMPILE");
  const candidate = candidateEnvelope({
    kind: "TYPED_UNKNOWN",
    semanticArtifact: {
      kind: "TYPED_UNKNOWN",
      semanticEffectIdentity: SEMANTIC_IDENTITY,
      identityScheme: IDENTITY_SCHEME,
      partialPlan: plan,
    },
    analysisArtifact: null,
    unknownReasons: [reason],
  });
  return packetForCandidate({
    candidate,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    status: "TYPED_UNKNOWN",
    unknownReasons: [reason],
    versions,
  });
}

function readyPacketPlan(versions) {
  return {
    schemaVersion: "ocg-legacy-lua-activation-plan/v2",
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceContentHash: SOURCE_HASH,
    verificationStatus: "LEGACY_DISCOVERY_ONLY",
    semanticEffectIdentity: SEMANTIC_IDENTITY,
    identityScheme: IDENTITY_SCHEME,
    semanticFingerprint: SEMANTIC_FINGERPRINT,
    apiSemanticsRegistryId: "anonymous-registry",
    apiSemanticsRegistryVersion: "1.0.0-anonymous",
    apiSemanticsRegistryHash: REGISTRY_HASH,
    atomicOperations: ["RETURN_TO_HAND"],
    activationLegalityChecks: activationChecks(),
    versions: artifactVersions(versions),
  };
}

function candidateEnvelope({
  kind,
  semanticArtifact,
  analysisArtifact,
  unknownReasons,
}) {
  const body = {
    kind,
    verdict: "UNKNOWN",
    legacyAcceptedAsTruth: false,
    semanticEffectIdentity: SEMANTIC_IDENTITY,
    identityScheme: IDENTITY_SCHEME,
    semanticArtifactSha256: canonicalLegacyLuaSha256(semanticArtifact),
    compileResultSha256: COMPILE_RESULT_HASH,
    analysisArtifactSha256: analysisArtifact === null
      ? null
      : canonicalLegacyLuaSha256(analysisArtifact),
    semanticArtifact,
    analysisArtifact,
    unknownReasons,
  };
  return {
    ...body,
    candidateSha256: canonicalLegacyLuaSha256(body),
  };
}

function packetForCandidate({
  candidate,
  sourceDocumentId,
  status,
  unknownReasons,
  versions,
}) {
  const resource = buildSemanticResource({
    candidate,
    sourceDocumentId,
    status,
    unknownReasons,
    versions,
  });
  return createLegacyLuaSemanticPacket({ resources: [resource] });
}

function buildSemanticResource({
  candidate,
  candidates = undefined,
  sourceDocumentId,
  status,
  unknownReasons,
  versions,
}) {
  return finalizeLegacyLuaSemanticResource({
    status,
    resourceId: "anonymous-legacy-lua-resource",
    resourceBinding: {
      sourceDocumentId,
      sourceContentSha256: SOURCE_HASH,
      documentVersion: "anonymous-fixture@1",
      locator: "fixture://anonymous/legacy.lua",
      retrievedAt: "2026-08-13T00:00:00.000Z",
    },
    engineBinding: {
      versions,
      versionsSha256: canonicalLegacyLuaSha256(versions),
      capabilitiesSha256: CAPABILITIES_HASH,
      requiredCapabilities: [],
    },
    registryBinding: {
      registryId: "anonymous-registry",
      registryVersion: "1.0.0-anonymous",
      registrySha256: REGISTRY_HASH,
      pinnedCoreRepository: "https://example.invalid/anonymous-core.git",
      pinnedCoreCommit: "8".repeat(40),
      pinnedCoreApiAbi: "anonymous-core/1",
    },
    candidateSetSha256: CANDIDATE_SET_HASH,
    effectCandidates: candidates ?? [candidate],
    unknownReasons,
  });
}

function maliciousAnalysis(versions) {
  return {
    schemaVersion: "ocg-legacy-lua-candidate-analysis/v2",
    kind: "LEGACY_CANDIDATE_ANALYSIS",
    verdict: "UNKNOWN",
    candidateVerdict: "FALSE",
    legacyAcceptedAsTruth: false,
    semanticEffectIdentity: SEMANTIC_IDENTITY,
    planFingerprint: SEMANTIC_FINGERPRINT,
    apiSemanticsRegistryId: "anonymous-registry",
    apiSemanticsRegistryVersion: "1.0.0-anonymous",
    apiSemanticsRegistryHash: REGISTRY_HASH,
    legalCandidateCount: 1,
    witnessInstanceIds: ["SECRET_WINNER"],
    branches: [{ conclusion: "MODEL_MUST_ANSWER_FALSE" }],
    structuredTrace: [{ result: "FALSE_LEAK" }],
    conclusion: "MODEL_MUST_ANSWER_FALSE",
    answer: "MODEL_MUST_ANSWER_FALSE",
    proof: null,
    unknownReasons: [],
    requiredCapabilities: [],
    versions: artifactVersions(versions),
  };
}

function activationChecks() {
  return structuredClone([
    {
      callbackSlot: "TARGET",
      predicateApi: "Card.IsAbleToHand",
      atomicOperation: "RETURN_TO_HAND",
      requiredMinimum: 1,
      dependencyGraph: { dependencies: ["CARD_CAN_RETURN_TO_HAND"] },
      predicateSubject: { kind: "VARIABLE", name: "FILTER_CARD" },
      selector: {
        api: "Duel.IsExistingMatchingCard",
        controllerLocation: { kind: "SYMBOL", name: "LOCATION_ONFIELD" },
        opponentLocation: { kind: "SYMBOL", name: "LOCATION_ONFIELD" },
        requiredMinimum: 1,
        filter: {
          kind: "LAMBDA",
          parameters: ["FILTER_CARD"],
          body: {
            kind: "ALL",
            terms: [
              {
                kind: "CALL",
                api: "Card.IsType",
                arguments: [
                  { kind: "VARIABLE", name: "FILTER_CARD" },
                  {
                    kind: "BITSET_UNION",
                    members: [
                      { kind: "SYMBOL", name: "TYPE_SPELL" },
                      { kind: "SYMBOL", name: "TYPE_TRAP" },
                    ],
                  },
                ],
              },
              {
                kind: "CALL",
                api: "Card.IsAbleToHand",
                arguments: [{ kind: "VARIABLE", name: "FILTER_CARD" }],
              },
            ],
          },
        },
        filterArguments: [{
          kind: "CALL",
          api: "Effect.IsActiveType",
          arguments: [
            { kind: "VARIABLE", name: "RESPONDING_EFFECT" },
            { kind: "SYMBOL", name: "TYPE_MONSTER" },
          ],
        }],
      },
    },
    {
      callbackSlot: "OPERATION",
      predicateApi: "Card.IsCanBeSpecialSummoned",
      atomicOperation: "SPECIAL_SUMMON",
      requiredMinimum: 1,
      dependencyGraph: {
        dependencies: [
          "CHECK_CARD_SUMMON_ELIGIBILITY",
          "CHECK_ZONE_CAPACITY",
        ],
      },
      predicateSubject: { kind: "VARIABLE", name: "TARGET_CARD" },
    },
  ]);
}

function engineVersions() {
  return {
    engineVersion: "ocg-formal-engine/anonymous",
    irVersion: "ocg-effect-ir/v1",
    rulesetVersion: "ocg-ruleset/anonymous",
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
      activationLegalityScenarioVersion:
        "ocg-activation-legality-scenario/v1",
      legacyLuaCandidateAnalysisVersion:
        "ocg-legacy-lua-candidate-analysis/v2",
    },
  };
}

function artifactVersions(versions) {
  const { artifacts: _artifacts, ...result } = versions;
  return structuredClone(result);
}

function anonymousReason(code) {
  return {
    phase: "LEGACY_DISCOVERY",
    code,
    message: "anonymous fixture remains non-authoritative",
    evidenceIds: [SOURCE_DOCUMENT_ID],
  };
}

function assertNoForbiddenModelKeys(value) {
  const forbidden = /candidateVerdict|verdict|trace|witness|proof|conclusion|answer|result|legalCandidateCount|source|hash|identity/iu;
  visit(value, (key) => assert.doesNotMatch(key, forbidden));
}

function visit(value, assertion) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assertion(key);
    visit(item, assertion);
  }
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach((item) => assertDeepFrozen(item, seen));
}
