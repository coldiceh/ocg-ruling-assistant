import { createHash } from "node:crypto";

import {
  LEGACY_LUA_SEMANTIC_AUTHORITY,
  LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
  canonicalLegacyLuaSha256,
  createLegacyLuaSemanticPacket,
  finalizeLegacyLuaSemanticResource,
  normalizeLegacyLuaPasscode,
  normalizeLegacyLuaUnknownReasons,
} from "./legacyLuaSemanticPacket.mjs";

export const LEGACY_LUA_REQUIRED_CAPABILITIES = Object.freeze([
  "compatibility/legacy-lua-effect-enumeration/v1",
  "compatibility/legacy-lua-semantic-discovery/v1",
  "movement/return-to-hand-legality/v1",
  "operation/dependency-expansion/v1",
]);

export const LEGACY_LUA_REQUIRED_ARTIFACT_VERSIONS = Object.freeze({
  luaApiSemanticsRegistryVersion: "ocg-lua-api-semantics-registry/v2",
  operationDependencyGraphVersion: "ocg-operation-dependency-graph/v1",
  legacyLuaActivationPlanVersion: "ocg-legacy-lua-activation-plan/v2",
  legacyLuaCompileResultVersion: "ocg-legacy-lua-compile-result/v2",
  legacyLuaEffectCandidateSetVersion:
    "ocg-legacy-lua-effect-candidate-set/v1",
  activationLegalityScenarioVersion: "ocg-activation-legality-scenario/v1",
  legacyLuaCandidateAnalysisVersion:
    "ocg-legacy-lua-candidate-analysis/v2",
});

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const CAPABILITY_STATUS = new Set(["PARTIAL", "SUPPORTED"]);
const EFFECT_CANDIDATES_HTTP_SCHEMA =
  "ocg-legacy-lua-http-effect-candidates/v1";
const EFFECT_CANDIDATES_HTTP_AUTHORITY = "LEGACY_DISCOVERY_ONLY";

/**
 * Represents a source-resolution failure without pretending that a source
 * document, content hash, version, or retrieval timestamp was obtained. The
 * passcode-only locator keeps the failure deterministic and attributable to
 * the requested card while the resource remains explicitly TYPED_UNKNOWN.
 */
export function createUnresolvedLegacyLuaSourceResource({
  passcode,
  code = "LEGACY_LUA_SOURCE_UNAVAILABLE",
  message = "legacy Lua source is unavailable",
  details = {},
} = {}) {
  const normalizedPasscode = normalizeLegacyLuaPasscode(passcode);
  if (normalizedPasscode === null) {
    throw clientError(
      "LEGACY_LUA_PASSCODE_INVALID",
      "unresolved legacy Lua source requires a non-zero uint32 passcode",
    );
  }
  const safe = safeDetails(details);
  return unknownResource({
    resourceBinding: {
      sourceDocumentId: null,
      sourceContentSha256: null,
      documentVersion: null,
      locator: `legacy-lua-passcode:${normalizedPasscode}`,
      retrievedAt: null,
    },
    code,
    message,
    details: isPlainObject(safe)
      ? { ...safe, passcode: normalizedPasscode }
      : { passcode: normalizedPasscode, cause: safe },
  });
}

/**
 * Runs the versioned legacy-discovery facade for one pinned Lua resource.
 * Every failure is converted to a typed UNKNOWN resource. Nothing returned by
 * this function can confirm an official ruling.
 */
export async function collectLegacyLuaSemanticResource({
  sourceDocument,
  scenario = null,
  engine,
  expectedVersions = {},
} = {}) {
  const fallbackBinding = safeResourceBinding(sourceDocument);
  try {
    const source = validateSourceDocument(sourceDocument);
    const facade = validateEngineFacade(engine, scenario !== null);
    const versions = await facade.getVersions();
    validateVersions(versions, expectedVersions);
    const capabilities = await facade.getCapabilities();
    validateCapabilities(capabilities);
    const registry = await facade.getRegistry();
    const registryBinding = validateRegistry(registry);
    const enumeration = unwrapCandidateEnumeration(
      await facade.enumerate(source),
      source,
    );
    const candidateSet = enumeration.candidateSet;
    validateCandidateSet(candidateSet, source, versions, {
      allowMissingSourceHash: enumeration.kind === "TYPED_UNKNOWN",
    });

    const sourceBinding = resourceBinding(source);
    const resourceId = resourceIdFor(sourceBinding);
    const resourceReasons = normalizeLegacyLuaUnknownReasons([
      ...(candidateSet.unknownReasons || []),
      ...enumeration.unknownReasons,
    ]);
    if (candidateSet.sourceContentHash === null) {
      if (enumeration.kind !== "TYPED_UNKNOWN" ||
          candidateSet.candidates.length !== 0) {
        throw clientError(
          "LEGACY_LUA_CANDIDATE_SET_INVALID",
          "an unbound candidate set may only be retained as an empty typed UNKNOWN",
        );
      }
      return finalizeLegacyLuaSemanticResource({
        status: "TYPED_UNKNOWN",
        resourceId,
        resourceBinding: sourceBinding,
        engineBinding: {
          versions,
          versionsSha256: canonicalLegacyLuaSha256(versions),
          capabilitiesSha256: canonicalLegacyLuaSha256(capabilities),
          requiredCapabilities: [...LEGACY_LUA_REQUIRED_CAPABILITIES].sort(),
        },
        registryBinding,
        candidateSetSha256: canonicalLegacyLuaSha256(candidateSet),
        effectCandidates: [],
        unknownReasons: resourceReasons,
      });
    }

    const effectCandidates = [];
    let partial = enumeration.kind === "TYPED_UNKNOWN";
    const ordered = [...candidateSet.candidates].sort((left, right) =>
      compareText(rawCandidateSortKey(left), rawCandidateSortKey(right))
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const rawCandidate = ordered[index];
      try {
        const candidate = await collectCandidate({
          source,
          rawCandidate,
          scenario,
          facade,
          versions,
          registryBinding,
        });
        if (candidate.kind === "TYPED_UNKNOWN") partial = true;
        effectCandidates.push(candidate);
      } catch (error) {
        partial = true;
        const candidate = invalidCandidate({
          rawCandidate,
          source,
          index,
          error,
        });
        effectCandidates.push(candidate);
        resourceReasons.push(...candidate.unknownReasons);
      }
    }
    effectCandidates.sort((left, right) =>
      compareText(candidateSortKey(left), candidateSortKey(right))
    );
    return finalizeLegacyLuaSemanticResource({
      status: partial ? "TYPED_UNKNOWN" : "READY",
      resourceId,
      resourceBinding: sourceBinding,
      engineBinding: {
        versions,
        versionsSha256: canonicalLegacyLuaSha256(versions),
        capabilitiesSha256: canonicalLegacyLuaSha256(capabilities),
        requiredCapabilities: [...LEGACY_LUA_REQUIRED_CAPABILITIES].sort(),
      },
      registryBinding,
      candidateSetSha256: canonicalLegacyLuaSha256(candidateSet),
      effectCandidates,
      unknownReasons: normalizeLegacyLuaUnknownReasons(resourceReasons),
    });
  } catch (error) {
    return unknownResource({
      resourceBinding: fallbackBinding,
      code: error?.code || "LEGACY_LUA_CLIENT_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      details: safeDetails(error?.details),
    });
  }
}

/**
 * Collects independently bound resources and then creates one deterministic
 * packet. Inputs are sorted before any facade call so their caller order never
 * selects or prioritizes an effect.
 */
export async function collectLegacyLuaSemanticPacket({
  inputs = [],
  engine,
  expectedVersions = {},
  maxCandidates,
  maxSerializedBytes,
} = {}) {
  try {
    if (!Array.isArray(inputs)) {
      throw clientError(
        "LEGACY_LUA_CLIENT_INPUT_INVALID",
        "legacy Lua inputs must be an array",
      );
    }
    const orderedInputs = [...inputs].sort((left, right) =>
      compareText(inputSortKey(left), inputSortKey(right))
    );
    const resources = [];
    for (const input of orderedInputs) {
      if (input?.unresolvedSource !== undefined) {
        resources.push(createUnresolvedLegacyLuaSourceResource(
          input.unresolvedSource,
        ));
        continue;
      }
      resources.push(await collectLegacyLuaSemanticResource({
        sourceDocument: input?.sourceDocument,
        scenario: input?.scenario ?? null,
        engine,
        expectedVersions,
      }));
    }
    return createLegacyLuaSemanticPacket({
      resources,
      ...(maxCandidates === undefined ? {} : { maxCandidates }),
      ...(maxSerializedBytes === undefined ? {} : { maxSerializedBytes }),
    });
  } catch (error) {
    return createLegacyLuaSemanticPacket({
      resources: [unknownResource({
        resourceBinding: safeResourceBinding(null),
        code: error?.code || "LEGACY_LUA_CLIENT_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        details: safeDetails(error?.details),
      })],
      ...(maxCandidates === undefined ? {} : { maxCandidates }),
      ...(maxSerializedBytes === undefined ? {} : { maxSerializedBytes }),
    });
  }
}

async function collectCandidate({
  source,
  rawCandidate,
  scenario,
  facade,
  versions,
  registryBinding,
}) {
  validateEngineCandidate(rawCandidate, source, registryBinding, versions);
  const semanticEffectIdentity = rawCandidate.semanticEffectIdentity ?? null;
  let compileResult = null;
  let analysis = null;
  const unknownReasons = [...(rawCandidate.unknownReasons || [])];
  let kind = rawCandidate.kind;

  if (semanticEffectIdentity !== null) {
    compileResult = await facade.compile(source, {
      semanticEffectIdentity,
    });
    validateCompileResult(
      compileResult,
      rawCandidate,
      source,
      registryBinding,
      versions,
    );
    unknownReasons.push(...(compileResult.unknownReasons || []));
    if (compileResult.kind === "TYPED_UNKNOWN") kind = "TYPED_UNKNOWN";
    if (scenario !== null) {
      analysis = await facade.analyze({
        sourceDocument: source,
        scenario,
        semanticEffectIdentity,
      });
      validateAnalysis(
        analysis,
        semanticEffectIdentity,
        registryBinding,
        versions,
      );
      unknownReasons.push(...(analysis.unknownReasons || []));
      if (analysis.candidateVerdict === "UNKNOWN") kind = "TYPED_UNKNOWN";
    }
  } else {
    kind = "TYPED_UNKNOWN";
    unknownReasons.push(reason({
      code: "LEGACY_LUA_EFFECT_IDENTITY_UNAVAILABLE",
      message: "legacy effect candidate has no stable semantic identity",
      evidenceIds: [source.sourceDocumentId],
    }));
  }

  const body = {
    kind,
    verdict: "UNKNOWN",
    legacyAcceptedAsTruth: false,
    semanticEffectIdentity,
    identityScheme: LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    semanticArtifactSha256: canonicalLegacyLuaSha256(rawCandidate),
    compileResultSha256: compileResult === null
      ? null
      : canonicalLegacyLuaSha256(compileResult),
    analysisArtifactSha256: analysis === null
      ? null
      : canonicalLegacyLuaSha256(analysis),
    semanticArtifact: rawCandidate,
    analysisArtifact: analysis,
    unknownReasons: normalizeLegacyLuaUnknownReasons(unknownReasons),
  };
  return {
    ...body,
    candidateSha256: canonicalLegacyLuaSha256(body),
  };
}

function invalidCandidate({ rawCandidate, source, index, error }) {
  const safeIdentity = validIdentity(rawCandidate?.semanticEffectIdentity)
    ? rawCandidate.semanticEffectIdentity
    : null;
  let semanticArtifact = null;
  let semanticArtifactSha256 = canonicalLegacyLuaSha256({
    sourceDocumentId: source.sourceDocumentId,
    sourceContentHash: source.contentHash,
    candidateIndex: index,
    invalid: true,
  });
  try {
    const candidateCopy = structuredClone(rawCandidate);
    semanticArtifactSha256 = canonicalLegacyLuaSha256(candidateCopy);
    // Invalid engine output is bound by hash but never passed to the model as
    // semantic evidence.
    semanticArtifact = null;
  } catch {
    // Keep the deterministic placeholder hash above.
  }
  const body = {
    kind: "TYPED_UNKNOWN",
    verdict: "UNKNOWN",
    legacyAcceptedAsTruth: false,
    semanticEffectIdentity: safeIdentity,
    identityScheme: LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    semanticArtifactSha256,
    compileResultSha256: null,
    analysisArtifactSha256: null,
    semanticArtifact,
    analysisArtifact: null,
    unknownReasons: normalizeLegacyLuaUnknownReasons([reason({
      code: error?.code || "LEGACY_LUA_CANDIDATE_INVALID",
      message: error instanceof Error ? error.message : String(error),
      evidenceIds: [source.sourceDocumentId],
      details: safeDetails(error?.details),
    })]),
  };
  return {
    ...body,
    candidateSha256: canonicalLegacyLuaSha256(body),
  };
}

function validateSourceDocument(value) {
  if (!isPlainObject(value)) {
    throw clientError(
      "LEGACY_LUA_SOURCE_INVALID",
      "sourceDocument must be a plain object",
    );
  }
  equal(value.schemaVersion, "ocg-source-document/v1",
    "sourceDocument.schemaVersion");
  equal(value.sourceType, "LEGACY_SCRIPT", "sourceDocument.sourceType");
  equal(value.authority, LEGACY_LUA_SEMANTIC_AUTHORITY,
    "sourceDocument.authority");
  nonEmptyString(value.sourceDocumentId, "sourceDocument.sourceDocumentId");
  nonEmptyString(value.documentVersion, "sourceDocument.documentVersion");
  equal(value.language, "lua", "sourceDocument.language");
  if (typeof value.content !== "string") {
    throw clientError(
      "LEGACY_LUA_SOURCE_INVALID",
      "sourceDocument.content must be a string",
    );
  }
  const sourceHash = createHash("sha256")
    .update(value.content)
    .digest("hex");
  equalDigest(value.contentHash, sourceHash, "sourceDocument.contentHash");
  if (!isPlainObject(value.provenance)) {
    throw clientError(
      "LEGACY_LUA_SOURCE_INVALID",
      "sourceDocument.provenance must be an object",
    );
  }
  nonEmptyString(value.provenance.locator,
    "sourceDocument.provenance.locator");
  validTimestamp(value.provenance.retrievedAt,
    "sourceDocument.provenance.retrievedAt");
  return structuredClone(value);
}

function validateEngineFacade(engine, needsAnalysis) {
  if (!engine || typeof engine !== "object") {
    throw clientError(
      "LEGACY_LUA_ENGINE_UNAVAILABLE",
      "legacy Lua engine facade is not configured",
    );
  }
  const getVersions = bindFunction(engine, "getEngineVersions");
  const getCapabilities = bindFirstFunction(engine, [
    "getEngineCapabilities",
    "getCapabilities",
  ]);
  const getRegistry = bindFunction(engine,
    "getLegacyLuaApiSemanticsRegistry");
  const enumerate = bindFirstFunction(engine, [
    "enumerateLegacyLuaEffectCandidatesEnvelope",
    "enumerateLegacyLuaEffectCandidates",
  ]);
  const compile = bindFirstFunction(engine, [
    "compileLegacyLuaActivationPlanV2",
    "compileLegacyLuaActivationPlan",
  ]);
  const analyze = needsAnalysis
    ? bindFirstFunction(engine, [
      "analyzeLegacyLuaActivationV2",
      "analyzeLegacyLuaActivation",
    ])
    : null;
  return { getVersions, getCapabilities, getRegistry, enumerate, compile, analyze };
}

function validateVersions(value, expectedVersions) {
  if (!isPlainObject(value) || !isPlainObject(value.artifacts)) {
    throw clientError(
      "LEGACY_LUA_ENGINE_VERSION_INVALID",
      "engine version manifest is missing artifact versions",
    );
  }
  for (const key of [
    "engineVersion",
    "irVersion",
    "rulesetVersion",
    "schemaVersion",
    "compilerVersion",
    "patternLibraryVersion",
    "proofVerifierVersion",
  ]) nonEmptyString(value[key], `versions.${key}`);
  for (const [name, expected] of Object.entries(
    LEGACY_LUA_REQUIRED_ARTIFACT_VERSIONS,
  )) {
    equal(value.artifacts[name], expected, `versions.artifacts.${name}`);
  }
  for (const [name, expected] of Object.entries(expectedVersions || {})) {
    if (expected === undefined || expected === null || expected === "") continue;
    const actual = name.startsWith("artifacts.")
      ? value.artifacts[name.slice("artifacts.".length)]
      : value[name];
    equal(actual, expected, `versions.${name}`);
  }
}

function validateCapabilities(value) {
  if (!isPlainObject(value) || !Array.isArray(value.capabilities)) {
    throw clientError(
      "LEGACY_LUA_CAPABILITY_INVALID",
      "engine capability manifest is invalid",
    );
  }
  const byId = new Map();
  for (const descriptor of value.capabilities) {
    if (!isPlainObject(descriptor)) continue;
    nonEmptyString(descriptor.capabilityId, "capabilityId");
    if (!/\/v\d+$/u.test(descriptor.capabilityId)) {
      throw clientError(
        "LEGACY_LUA_CAPABILITY_INVALID",
        "capability ID must end in /vN",
      );
    }
    if (!CAPABILITY_STATUS.has(descriptor.status) &&
        descriptor.status !== "NOT_STARTED") {
      throw clientError(
        "LEGACY_LUA_CAPABILITY_INVALID",
        "capability status is invalid",
      );
    }
    if (!Array.isArray(descriptor.dependencies)) {
      throw clientError(
        "LEGACY_LUA_CAPABILITY_INVALID",
        "capability dependencies must be an array",
      );
    }
    if (byId.has(descriptor.capabilityId)) {
      throw clientError(
        "LEGACY_LUA_CAPABILITY_INVALID",
        "capability IDs must be unique",
      );
    }
    byId.set(descriptor.capabilityId, descriptor);
  }
  const visit = (capabilityId, stack = new Set()) => {
    const descriptor = byId.get(capabilityId);
    if (!descriptor || !CAPABILITY_STATUS.has(descriptor.status)) {
      throw clientError(
        "LEGACY_LUA_CAPABILITY_UNAVAILABLE",
        `required capability is unavailable: ${capabilityId}`,
      );
    }
    if (stack.has(capabilityId)) {
      throw clientError(
        "LEGACY_LUA_CAPABILITY_INVALID",
        "capability graph contains a cycle",
      );
    }
    const next = new Set(stack);
    next.add(capabilityId);
    for (const dependency of descriptor.dependencies) visit(dependency, next);
  };
  for (const capabilityId of LEGACY_LUA_REQUIRED_CAPABILITIES) {
    visit(capabilityId);
  }
}

function validateRegistry(value) {
  if (!isPlainObject(value)) {
    throw clientError(
      "LEGACY_LUA_REGISTRY_INVALID",
      "legacy Lua semantics registry is invalid",
    );
  }
  equal(value.schemaVersion, "ocg-lua-api-semantics-registry/v2",
    "registry.schemaVersion");
  equal(value.authority, "LEGACY_DISCOVERY_ONLY", "registry.authority");
  equal(value.legacyAcceptedAsTruth, false,
    "registry.legacyAcceptedAsTruth");
  nonEmptyString(value.registryId, "registry.registryId");
  nonEmptyString(value.registryVersion, "registry.registryVersion");
  if (!isPlainObject(value.compatibilityEvidence)) {
    throw clientError(
      "LEGACY_LUA_REGISTRY_INVALID",
      "registry compatibilityEvidence is missing",
    );
  }
  const compatibility = value.compatibilityEvidence;
  nonEmptyString(compatibility.pinnedCoreRepository,
    "registry pinnedCoreRepository");
  if (!GIT_COMMIT.test(compatibility.pinnedCoreCommit)) {
    throw clientError(
      "LEGACY_LUA_REGISTRY_INVALID",
      "registry pinnedCoreCommit must be a full lowercase Git commit",
    );
  }
  nonEmptyString(compatibility.pinnedCoreApiAbi,
    "registry pinnedCoreApiAbi");
  return {
    registryId: value.registryId,
    registryVersion: value.registryVersion,
    registrySha256: canonicalLegacyLuaSha256(value),
    pinnedCoreRepository: compatibility.pinnedCoreRepository,
    pinnedCoreCommit: compatibility.pinnedCoreCommit,
    pinnedCoreApiAbi: compatibility.pinnedCoreApiAbi,
  };
}

function validateCandidateSet(value, source, versions, {
  allowMissingSourceHash = false,
} = {}) {
  if (!isPlainObject(value)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_SET_INVALID",
      "legacy Lua candidate set is invalid",
    );
  }
  equal(value.schemaVersion, "ocg-legacy-lua-effect-candidate-set/v1",
    "candidateSet.schemaVersion");
  equal(value.kind, "LEGACY_LUA_EFFECT_CANDIDATE_SET",
    "candidateSet.kind");
  equal(value.verdict, "UNKNOWN", "candidateSet.verdict");
  equal(value.legacyAcceptedAsTruth, false,
    "candidateSet.legacyAcceptedAsTruth");
  equal(value.sourceDocumentId, source.sourceDocumentId,
    "candidateSet.sourceDocumentId");
  if (value.sourceContentHash === null && allowMissingSourceHash) {
    // A transport envelope that was independently bound to this exact source
    // may carry an empty typed-UNKNOWN artifact whose redundant inner hash is
    // null. It remains unusable as candidate evidence and is handled above as
    // a zero-candidate TYPED_UNKNOWN resource.
  } else {
    equal(value.sourceContentHash, source.contentHash,
      "candidateSet.sourceContentHash");
  }
  if (!Array.isArray(value.candidates) ||
      !Array.isArray(value.unknownReasons) ||
      !Array.isArray(value.requiredCapabilities)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_SET_INVALID",
      "candidate set arrays are missing",
    );
  }
  validateArtifactVersions(value.versions, versions, "candidateSet.versions");
  const keys = value.candidates.map(rawCandidateSortKey);
  if (new Set(keys).size !== keys.length) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_SET_INVALID",
      "candidate set contains duplicate semantic identities",
    );
  }
}

function unwrapCandidateEnumeration(value, source) {
  if (value?.schemaVersion !== EFFECT_CANDIDATES_HTTP_SCHEMA) {
    return {
      kind: "COMPLETED",
      candidateSet: value,
      unknownReasons: [],
    };
  }
  if (!isPlainObject(value) || value.operation !== "EFFECT_CANDIDATES" ||
      !new Set(["COMPLETED", "TYPED_UNKNOWN"]).has(value.kind)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_SET_INVALID",
      "legacy Lua effect-candidate envelope is invalid",
    );
  }
  equal(value.authority, EFFECT_CANDIDATES_HTTP_AUTHORITY,
    "effectCandidatesEnvelope.authority");
  equal(value.canConfirmOfficialRuling, false,
    "effectCandidatesEnvelope.canConfirmOfficialRuling");
  equal(value.legacyAcceptedAsTruth, false,
    "effectCandidatesEnvelope.legacyAcceptedAsTruth");
  equal(value.verdict, "UNKNOWN", "effectCandidatesEnvelope.verdict");
  if (!Array.isArray(value.unknownReasons) ||
      (value.kind === "TYPED_UNKNOWN" && value.unknownReasons.length === 0)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_SET_INVALID",
      "typed UNKNOWN effect-candidate envelope must retain its reasons",
    );
  }
  validateCandidateEnvelopeSourceBinding(value.sourceBinding, source);
  if (!isPlainObject(value.result)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_SET_INVALID",
      "effect-candidate envelope result must be an object",
    );
  }
  return {
    kind: value.kind,
    candidateSet: value.result,
    unknownReasons: value.unknownReasons,
  };
}

function validateCandidateEnvelopeSourceBinding(value, source) {
  if (!isPlainObject(value)) {
    throw clientError(
      "LEGACY_LUA_BINDING_INVALID",
      "effect-candidate envelope sourceBinding is missing",
    );
  }
  equal(value.mode, "SOURCE_DOCUMENT",
    "effectCandidatesEnvelope.sourceBinding.mode");
  equal(value.script, null,
    "effectCandidatesEnvelope.sourceBinding.script");
  equal(value.sourceDocumentId, source.sourceDocumentId,
    "effectCandidatesEnvelope.sourceBinding.sourceDocumentId");
  equalDigest(value.sourceContentSha256, source.contentHash,
    "effectCandidatesEnvelope.sourceBinding.sourceContentSha256");
  equal(value.documentVersion, source.documentVersion,
    "effectCandidatesEnvelope.sourceBinding.documentVersion");
  equal(value.locator, source.provenance.locator,
    "effectCandidatesEnvelope.sourceBinding.locator");
  equal(
    new Date(value.retrievedAt).toISOString(),
    new Date(source.provenance.retrievedAt).toISOString(),
    "effectCandidatesEnvelope.sourceBinding.retrievedAt",
  );
}

function validateEngineCandidate(candidate, source, registryBinding, versions) {
  if (!isPlainObject(candidate) ||
      !new Set(["CANDIDATE", "TYPED_UNKNOWN"]).has(candidate.kind)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_INVALID",
      "legacy Lua candidate is invalid",
    );
  }
  if (candidate.semanticEffectIdentity !== null &&
      !validIdentity(candidate.semanticEffectIdentity)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_INVALID",
      "candidate semantic identity must be a SHA-256 digest or null",
    );
  }
  equal(candidate.identityScheme, LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    "candidate.identityScheme");
  if (!Array.isArray(candidate.unknownReasons)) {
    throw clientError(
      "LEGACY_LUA_CANDIDATE_INVALID",
      "candidate unknownReasons must be an array",
    );
  }
  const plan = candidate.plan ?? candidate.partialPlan ?? null;
  if (plan !== null) {
    validatePlan(plan, candidate.semanticEffectIdentity, source,
      registryBinding, versions);
    validateSourceSpans(plan.sourceSpans, source);
  }
}

function validateCompileResult(
  value,
  candidate,
  source,
  registryBinding,
  versions,
) {
  if (!isPlainObject(value)) {
    throw clientError(
      "LEGACY_LUA_COMPILE_RESULT_INVALID",
      "legacy Lua compile result is invalid",
    );
  }
  equal(value.schemaVersion, "ocg-legacy-lua-compile-result/v2",
    "compileResult.schemaVersion");
  equal(value.verdict, "UNKNOWN", "compileResult.verdict");
  if (!new Set(["CANDIDATE", "TYPED_UNKNOWN"]).has(value.kind)) {
    throw clientError(
      "LEGACY_LUA_COMPILE_RESULT_INVALID",
      "compileResult.kind is invalid",
    );
  }
  validateArtifactVersions(value.versions, versions, "compileResult.versions");
  const plan = value.plan ?? value.partialPlan ?? null;
  if (plan !== null) {
    validatePlan(plan, candidate.semanticEffectIdentity, source,
      registryBinding, versions);
    const enumeratedPlan = candidate.plan ?? candidate.partialPlan ?? null;
    if (enumeratedPlan !== null) {
      equal(
        canonicalLegacyLuaSha256(plan),
        canonicalLegacyLuaSha256(enumeratedPlan),
        "compiled plan and enumerated plan",
      );
    }
  }
}

function validateAnalysis(
  value,
  semanticEffectIdentity,
  registryBinding,
  versions,
) {
  if (!isPlainObject(value)) {
    throw clientError(
      "LEGACY_LUA_ANALYSIS_INVALID",
      "legacy Lua candidate analysis is invalid",
    );
  }
  equal(value.schemaVersion, "ocg-legacy-lua-candidate-analysis/v2",
    "analysis.schemaVersion");
  equal(value.kind, "LEGACY_CANDIDATE_ANALYSIS", "analysis.kind");
  equal(value.verdict, "UNKNOWN", "analysis.verdict");
  equal(value.legacyAcceptedAsTruth, false,
    "analysis.legacyAcceptedAsTruth");
  equal(value.proof, null, "analysis.proof");
  equal(value.semanticEffectIdentity, semanticEffectIdentity,
    "analysis.semanticEffectIdentity");
  if (!new Set(["TRUE", "FALSE", "UNKNOWN"]).has(
    value.candidateVerdict,
  )) {
    throw clientError(
      "LEGACY_LUA_ANALYSIS_INVALID",
      "analysis.candidateVerdict is invalid",
    );
  }
  equal(value.apiSemanticsRegistryId, registryBinding.registryId,
    "analysis.registryId");
  equal(value.apiSemanticsRegistryVersion, registryBinding.registryVersion,
    "analysis.registryVersion");
  equal(value.apiSemanticsRegistryHash, registryBinding.registrySha256,
    "analysis.registryHash");
  validateArtifactVersions(value.versions, versions, "analysis.versions");
}

function validatePlan(
  plan,
  semanticEffectIdentity,
  source,
  registryBinding,
  versions,
) {
  if (!isPlainObject(plan)) {
    throw clientError(
      "LEGACY_LUA_PLAN_INVALID",
      "legacy Lua activation plan is invalid",
    );
  }
  equal(plan.schemaVersion, "ocg-legacy-lua-activation-plan/v2",
    "plan.schemaVersion");
  equal(plan.verificationStatus, "LEGACY_DISCOVERY_ONLY",
    "plan.verificationStatus");
  equal(plan.semanticEffectIdentity, semanticEffectIdentity,
    "plan.semanticEffectIdentity");
  equal(plan.identityScheme, LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    "plan.identityScheme");
  equal(plan.sourceDocumentId, source.sourceDocumentId,
    "plan.sourceDocumentId");
  equal(plan.sourceContentHash, source.contentHash,
    "plan.sourceContentHash");
  equal(plan.apiSemanticsRegistryId, registryBinding.registryId,
    "plan.registryId");
  equal(plan.apiSemanticsRegistryVersion, registryBinding.registryVersion,
    "plan.registryVersion");
  equal(plan.apiSemanticsRegistryHash, registryBinding.registrySha256,
    "plan.registryHash");
  digest(plan.semanticFingerprint, "plan.semanticFingerprint");
  if (!Array.isArray(plan.unresolvedSemantics) ||
      !Array.isArray(plan.requiredCapabilities) ||
      !Array.isArray(plan.sourceSpans)) {
    throw clientError(
      "LEGACY_LUA_PLAN_INVALID",
      "legacy plan arrays are missing",
    );
  }
  validateArtifactVersions(plan.versions, versions, "plan.versions");
}

function validateSourceSpans(spans, source) {
  for (const span of spans) {
    if (!isPlainObject(span)) {
      throw clientError(
        "LEGACY_LUA_SOURCE_SPAN_INVALID",
        "legacy Lua source span is invalid",
      );
    }
    equal(span.schemaVersion, "ocg-source-span/v1",
      "sourceSpan.schemaVersion");
    equal(span.sourceDocumentId, source.sourceDocumentId,
      "sourceSpan.sourceDocumentId");
    if (!Number.isSafeInteger(span.startOffset) ||
        !Number.isSafeInteger(span.endOffset) ||
        span.startOffset < 0 || span.endOffset <= span.startOffset ||
        span.endOffset > source.content.length) {
      throw clientError(
        "LEGACY_LUA_SOURCE_SPAN_INVALID",
        "legacy Lua source span is outside its source document",
      );
    }
    const exact = source.content.slice(span.startOffset, span.endOffset);
    equal(span.exactText, exact, "sourceSpan.exactText");
    equalDigest(
      span.textHash,
      createHash("sha256").update(exact).digest("hex"),
      "sourceSpan.textHash",
    );
  }
}

function validateArtifactVersions(actual, expected, label) {
  if (!isPlainObject(actual)) {
    throw clientError(
      "LEGACY_LUA_ENGINE_VERSION_INVALID",
      `${label} must be an object`,
    );
  }
  for (const key of [
    "engineVersion",
    "irVersion",
    "rulesetVersion",
    "schemaVersion",
    "compilerVersion",
    "patternLibraryVersion",
    "proofVerifierVersion",
  ]) equal(actual[key], expected[key], `${label}.${key}`);
}

function unknownResource({ resourceBinding, code, message, details }) {
  const binding = normalizeFallbackBinding(resourceBinding);
  return finalizeLegacyLuaSemanticResource({
    status: "TYPED_UNKNOWN",
    resourceId: resourceIdFor(binding),
    resourceBinding: binding,
    engineBinding: null,
    registryBinding: null,
    candidateSetSha256: null,
    effectCandidates: [],
    unknownReasons: [reason({ code, message, details })],
  });
}

function resourceBinding(source) {
  return {
    sourceDocumentId: source.sourceDocumentId,
    sourceContentSha256: source.contentHash,
    documentVersion: source.documentVersion,
    locator: source.provenance.locator,
    retrievedAt: new Date(source.provenance.retrievedAt).toISOString(),
  };
}

function safeResourceBinding(value) {
  try {
    const contentHash = typeof value?.content === "string"
      ? createHash("sha256").update(value.content).digest("hex")
      : null;
    return normalizeFallbackBinding({
      sourceDocumentId: safeString(value?.sourceDocumentId),
      sourceContentSha256: SHA256.test(value?.contentHash)
        ? value.contentHash
        : contentHash,
      documentVersion: safeString(value?.documentVersion),
      locator: safeString(value?.provenance?.locator),
      retrievedAt: safeTimestamp(value?.provenance?.retrievedAt),
    });
  } catch {
    return normalizeFallbackBinding({});
  }
}

function normalizeFallbackBinding(value) {
  return {
    sourceDocumentId: safeString(value?.sourceDocumentId),
    sourceContentSha256: SHA256.test(value?.sourceContentSha256)
      ? value.sourceContentSha256
      : null,
    documentVersion: safeString(value?.documentVersion),
    locator: safeString(value?.locator),
    retrievedAt: safeTimestamp(value?.retrievedAt),
  };
}

function resourceIdFor(binding) {
  const digestValue = canonicalLegacyLuaSha256(binding);
  return `legacy_lua_resource_${digestValue.slice(0, 24)}`;
}

function reason({
  code,
  message,
  evidenceIds = [],
  details,
}) {
  return {
    phase: "LEGACY_LUA_DISCOVERY",
    code: String(code || "LEGACY_LUA_UNKNOWN"),
    message: String(message || "legacy Lua semantics are unknown"),
    evidenceIds: [...new Set(evidenceIds.map(String))].sort(),
    ...(details === undefined ? {} : { details: safeDetails(details) }),
  };
}

function rawCandidateSortKey(candidate) {
  if (validIdentity(candidate?.semanticEffectIdentity)) {
    return `identity:${candidate.semanticEffectIdentity}`;
  }
  try {
    return `~unknown:${canonicalLegacyLuaSha256(candidate)}`;
  } catch {
    return "~unknown:unserializable";
  }
}

function candidateSortKey(candidate) {
  return candidate.semanticEffectIdentity === null
    ? `~unknown:${candidate.candidateSha256}`
    : `identity:${candidate.semanticEffectIdentity}`;
}

function inputSortKey(input) {
  const unresolvedPasscode = normalizeLegacyLuaPasscode(
    input?.unresolvedSource?.passcode,
  );
  if (unresolvedPasscode !== null) {
    return `~unresolved\u0000${unresolvedPasscode}`;
  }
  const binding = safeResourceBinding(input?.sourceDocument);
  return [
    binding.sourceDocumentId || "~unknown",
    binding.sourceContentSha256 || canonicalLegacyLuaSha256(binding),
  ].join("\u0000");
}

function bindFunction(object, name) {
  if (typeof object[name] !== "function") {
    throw clientError(
      "LEGACY_LUA_ENGINE_UNAVAILABLE",
      `engine facade is missing ${name}`,
    );
  }
  return object[name].bind(object);
}

function bindFirstFunction(object, names) {
  const name = names.find((candidate) => typeof object[candidate] === "function");
  if (!name) {
    throw clientError(
      "LEGACY_LUA_ENGINE_UNAVAILABLE",
      `engine facade is missing ${names.join(" or ")}`,
    );
  }
  return object[name].bind(object);
}

function validIdentity(value) {
  return typeof value === "string" && SHA256.test(value);
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw clientError(
      "LEGACY_LUA_BINDING_INVALID",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
}

function equalDigest(actual, expected, label) {
  digest(actual, label);
  equal(actual, expected, label);
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw clientError(
      "LEGACY_LUA_BINDING_INVALID",
      `${label} is incompatible`,
      { expected, actual },
    );
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw clientError(
      "LEGACY_LUA_SCHEMA_INVALID",
      `${label} must be a non-empty string`,
    );
  }
}

function validTimestamp(value, label) {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw clientError(
      "LEGACY_LUA_SCHEMA_INVALID",
      `${label} must be an ISO-compatible timestamp`,
    );
  }
}

function safeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function safeDetails(value) {
  try {
    return value === undefined ? {} : JSON.parse(JSON.stringify(value));
  } catch {
    return { unavailable: true };
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  const first = String(left);
  const second = String(right);
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function clientError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "LegacyLuaSemanticClientError";
  error.code = code;
  error.details = details;
  return error;
}
