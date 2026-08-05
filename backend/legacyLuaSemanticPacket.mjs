import { createHash } from "node:crypto";

export const LEGACY_LUA_SEMANTIC_PACKET_SCHEMA =
  "ocg-assistant-lua-semantic-packet/v1";
export const LEGACY_LUA_SEMANTIC_RESOURCE_SCHEMA =
  "ocg-assistant-lua-semantic-resource/v1";
export const LEGACY_LUA_SEMANTIC_AUTHORITY = "LEGACY_COMPATIBILITY";
export const LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME =
  "ocg-legacy-lua-semantic-effect-identity/v1";

const PACKET_KIND = "LEGACY_LUA_SEMANTIC_PACKET";
const RESOURCE_KIND = "LEGACY_LUA_SEMANTIC_RESOURCE";
const SHA256 = /^[a-f0-9]{64}$/u;
const LEGACY_LUA_PASSCODE = /^[0-9]{1,10}$/u;
const MAX_LEGACY_LUA_PASSCODE = 0xffff_ffffn;
const STATUS = new Set(["READY", "TYPED_UNKNOWN"]);
const CANDIDATE_KINDS = new Set(["CANDIDATE", "TYPED_UNKNOWN"]);
const REQUIRED_ENGINE_ARTIFACTS = Object.freeze({
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

/**
 * Builds a frozen, content-addressed packet. Legacy artifacts remain an
 * independent discovery sidecar: neither candidateVerdict nor a successful
 * compilation can cross this boundary as an official ruling.
 */
export function createLegacyLuaSemanticPacket({
  resources = [],
  maxCandidates = Number.MAX_SAFE_INTEGER,
  maxSerializedBytes = null,
} = {}) {
  try {
    const normalizedResources = resources.map((resource) =>
      validateLegacyLuaSemanticResource(resource)
    );
    const duplicateResourceIds = duplicates(
      normalizedResources.map((resource) => resource.resourceId),
    );
    if (duplicateResourceIds.length) {
      throw contractError(
        "LEGACY_LUA_RESOURCE_DUPLICATE",
        "legacy Lua resources must have unique resourceId values",
        { duplicateResourceIds },
      );
    }
    const candidateLimit = normalizeCandidateLimit(maxCandidates);
    const byteLimit = normalizeByteLimit(maxSerializedBytes);
    return buildPacket({
      resources: normalizedResources,
      candidateLimit,
      byteLimit,
      additionalUnknownReasons: [],
    });
  } catch (error) {
    return createLegacyLuaUnknownPacket({
      code: error?.code || "LEGACY_LUA_PACKET_INPUT_INVALID",
      message: error instanceof Error ? error.message : String(error),
      details: jsonDetails(error?.details),
    });
  }
}

/**
 * Normalizes the uint32 card-code namespace used by c{code}.lua. Values below
 * eight digits keep the conventional zero-padded display form, while nine and
 * ten digit uint32 values remain unchanged. The engine strips display padding
 * again before resolving the locked script path.
 */
export function normalizeLegacyLuaPasscode(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!LEGACY_LUA_PASSCODE.test(text)) return null;
  const numeric = BigInt(text);
  if (numeric === 0n || numeric > MAX_LEGACY_LUA_PASSCODE) return null;
  const canonical = numeric.toString(10);
  return canonical.length < 8 ? canonical.padStart(8, "0") : canonical;
}

export function createLegacyLuaUnknownPacket({
  code = "LEGACY_LUA_PACKET_UNAVAILABLE",
  message = "legacy Lua semantic packet is unavailable",
  details = {},
} = {}) {
  const reason = normalizeUnknownReason({
    phase: "LEGACY_LUA_PACKET",
    code,
    message,
    details: jsonDetails(details),
    evidenceIds: [],
  });
  return buildPacket({
    resources: [],
    candidateLimit: Number.MAX_SAFE_INTEGER,
    byteLimit: null,
    additionalUnknownReasons: [reason],
  });
}

/**
 * Finalizes the resource artifact produced by the client. Invalid resource
 * material is intentionally rejected here; callers convert that rejection to
 * a TYPED_UNKNOWN resource before packet construction.
 */
export function finalizeLegacyLuaSemanticResource(value) {
  const source = canonicalizeJson(value);
  if (!isPlainObject(source)) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "legacy Lua semantic resource must be a plain object",
    );
  }
  const body = {
    schemaVersion: LEGACY_LUA_SEMANTIC_RESOURCE_SCHEMA,
    kind: RESOURCE_KIND,
    status: source.status,
    authority: LEGACY_LUA_SEMANTIC_AUTHORITY,
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    verdict: "UNKNOWN",
    resourceId: source.resourceId,
    resourceBinding: source.resourceBinding,
    engineBinding: source.engineBinding ?? null,
    registryBinding: source.registryBinding ?? null,
    candidateSetSha256: source.candidateSetSha256 ?? null,
    effectCandidates: source.effectCandidates || [],
    unknownReasons: source.unknownReasons || [],
  };
  const resourceSha256 = canonicalLegacyLuaSha256(body);
  return validateLegacyLuaSemanticResource({ ...body, resourceSha256 });
}

export function validateLegacyLuaSemanticResource(value) {
  const resource = canonicalizeJson(value);
  assertExactKeys(resource, new Set([
    "schemaVersion",
    "kind",
    "status",
    "authority",
    "canConfirmOfficialRuling",
    "legacyAcceptedAsTruth",
    "verdict",
    "resourceId",
    "resourceBinding",
    "engineBinding",
    "registryBinding",
    "candidateSetSha256",
    "effectCandidates",
    "unknownReasons",
    "resourceSha256",
  ]), "legacy Lua semantic resource");
  equal(resource.schemaVersion, LEGACY_LUA_SEMANTIC_RESOURCE_SCHEMA,
    "resource.schemaVersion");
  equal(resource.kind, RESOURCE_KIND, "resource.kind");
  if (!STATUS.has(resource.status)) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "resource.status must be READY or TYPED_UNKNOWN",
    );
  }
  assertNonAuthoritativeBoundary(resource, "resource");
  nonEmptyString(resource.resourceId, "resource.resourceId");
  validateResourceBinding(resource.resourceBinding);
  if (resource.status === "READY") {
    for (const [key, item] of Object.entries(resource.resourceBinding)) {
      if (item === null) {
        throw contractError(
          "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
          `READY resource binding cannot omit ${key}`,
        );
      }
    }
    validateEngineBinding(resource.engineBinding);
    validateRegistryBinding(resource.registryBinding);
    digest(resource.candidateSetSha256, "resource.candidateSetSha256");
  } else {
    if (resource.engineBinding !== null) validateEngineBinding(resource.engineBinding);
    if (resource.registryBinding !== null) validateRegistryBinding(resource.registryBinding);
    if (resource.candidateSetSha256 !== null) {
      digest(resource.candidateSetSha256, "resource.candidateSetSha256");
    }
  }
  if (!Array.isArray(resource.effectCandidates)) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "resource.effectCandidates must be an array",
    );
  }
  const candidates = resource.effectCandidates.map((candidate) =>
    validateSemanticCandidate(candidate, resource)
  );
  if (resource.status === "READY" &&
      candidates.some((candidate) => candidate.kind !== "CANDIDATE")) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "READY resource cannot contain a TYPED_UNKNOWN candidate",
    );
  }
  assertStableCandidateOrder(candidates, resource.resourceId);
  const duplicateCandidateKeys = duplicates(candidates.map(candidateSortKey));
  if (duplicateCandidateKeys.length) {
    throw contractError(
      "LEGACY_LUA_CANDIDATE_DUPLICATE",
      "resource contains duplicate semantic effect candidates",
      { duplicateCandidateKeys },
    );
  }
  const unknownReasons = normalizeUnknownReasons(resource.unknownReasons);
  if (resource.status === "TYPED_UNKNOWN" && !unknownReasons.length) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "TYPED_UNKNOWN resource must explain why it is unknown",
    );
  }
  const body = {
    ...resource,
    effectCandidates: candidates,
    unknownReasons,
  };
  delete body.resourceSha256;
  const expectedHash = canonicalLegacyLuaSha256(body);
  equalDigest(resource.resourceSha256, expectedHash, "resource.resourceSha256");
  return deepFreeze({ ...body, resourceSha256: expectedHash });
}

export function validateLegacyLuaSemanticPacket(value) {
  const packet = canonicalizeJson(value);
  assertExactKeys(packet, new Set([
    "schemaVersion",
    "kind",
    "authority",
    "canConfirmOfficialRuling",
    "legacyAcceptedAsTruth",
    "verdict",
    "packetId",
    "packetSha256",
    "resources",
    "effectCandidates",
    "omittedCandidates",
    "truncation",
    "unknownReasons",
  ]), "legacy Lua semantic packet");
  equal(packet.schemaVersion, LEGACY_LUA_SEMANTIC_PACKET_SCHEMA,
    "packet.schemaVersion");
  equal(packet.kind, PACKET_KIND, "packet.kind");
  assertNonAuthoritativeBoundary(packet, "packet");
  if (!Array.isArray(packet.resources) ||
      !Array.isArray(packet.effectCandidates) ||
      !Array.isArray(packet.omittedCandidates)) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      "packet resources and candidate manifests must be arrays",
    );
  }
  const resources = packet.resources.map(validatePacketResourceSummary);
  assertSorted(resources, (item) => item.resourceId,
    "packet.resources must use stable resourceId order");
  if (duplicates(resources.map((item) => item.resourceId)).length) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_DUPLICATE",
      "packet contains duplicate resources",
    );
  }
  const resourcesById = new Map(resources.map((item) => [item.resourceId, item]));
  const included = packet.effectCandidates.map((entry) =>
    validatePacketCandidateEntry(entry, resourcesById)
  );
  const omitted = packet.omittedCandidates.map((entry) =>
    validateOmittedCandidate(entry, new Set(resourcesById.keys()))
  );
  assertSorted(included, packetCandidateSortKey,
    "packet.effectCandidates must use stable semantic identity order");
  assertSorted(omitted, packetCandidateSortKey,
    "packet.omittedCandidates must use stable semantic identity order");
  const allKeys = [
    ...included.map(packetCandidateSortKey),
    ...omitted.map(packetCandidateSortKey),
  ];
  if (duplicates(allKeys).length) {
    throw contractError(
      "LEGACY_LUA_CANDIDATE_DUPLICATE",
      "a candidate cannot be both included and omitted",
    );
  }
  const truncation = validateTruncation(packet.truncation, included, omitted);
  const boundCandidateCount = resources.reduce(
    (sum, resource) => sum + resource.candidateCount,
    0,
  );
  equal(truncation.totalCandidateCount, boundCandidateCount,
    "truncation.totalCandidateCount and resource candidate manifests");
  const unknownReasons = normalizeUnknownReasons(packet.unknownReasons);
  const body = {
    ...packet,
    resources,
    effectCandidates: included,
    omittedCandidates: omitted,
    truncation,
    unknownReasons,
  };
  delete body.packetId;
  delete body.packetSha256;
  const expectedHash = canonicalLegacyLuaSha256(body);
  equalDigest(packet.packetSha256, expectedHash, "packet.packetSha256");
  equal(packet.packetId, `legacy_lua_${expectedHash.slice(0, 24)}`,
    "packet.packetId");
  return deepFreeze({
    ...body,
    packetId: `legacy_lua_${expectedHash.slice(0, 24)}`,
    packetSha256: expectedHash,
  });
}

export function serializeLegacyLuaSemanticPacket(packet) {
  return canonicalLegacyLuaStringify(validateLegacyLuaSemanticPacket(packet));
}

/**
 * Produces the bounded model-facing projection. The frozen snapshot keeps the
 * complete artifacts for audit, while the final model receives only generic
 * operations, legality dependencies and an explicitly non-authoritative
 * candidate trace. Source code, ASTs and source spans are deliberately omitted.
 */
export function projectLegacyLuaSemanticPacketForModel(
  value,
  { maxCandidates = 16, maxChecksPerCandidate = 12 } = {},
) {
  const packet = validateLegacyLuaSemanticPacket(value);
  const candidateLimit = normalizeCandidateLimit(maxCandidates);
  const checkLimit = normalizeCandidateLimit(maxChecksPerCandidate);
  const effectCandidates = packet.effectCandidates
    .slice(0, candidateLimit)
    .map((candidate) => {
      const artifact = candidate.semanticArtifact || {};
      const plan = artifact.plan || artifact.partialPlan || {};
      const analysis = candidate.analysisArtifact || {};
      return {
        resourceId: candidate.resourceId,
        semanticEffectIdentity: candidate.semanticEffectIdentity,
        candidateSha256: candidate.candidateSha256,
        kind: candidate.kind,
        verdict: "UNKNOWN",
        candidateVerdict: ["TRUE", "FALSE", "UNKNOWN"].includes(
          analysis.candidateVerdict,
        ) ? analysis.candidateVerdict : "UNKNOWN",
        costAtomicOperations: modelStringList(plan.costAtomicOperations, 12),
        atomicOperations: modelStringList(plan.atomicOperations, 20),
        activationLegalityDependencies: modelStringList(
          plan.activationLegalityDependencies,
          24,
        ),
        activationLegalityChecks: (Array.isArray(plan.activationLegalityChecks)
          ? plan.activationLegalityChecks
          : []).slice(0, checkLimit).map((check) => ({
            callbackSlot: modelString(check?.callbackSlot),
            predicateApi: modelString(check?.predicateApi),
            atomicOperation: modelString(check?.atomicOperation),
            requiredMinimum: Number.isSafeInteger(check?.requiredMinimum)
              ? check.requiredMinimum
              : null,
            dependencyNodes: modelStringList(
              dependencyGraphEntries(check?.dependencyGraph).map((node) =>
                typeof node === "string"
                  ? node
                  : node?.name || node?.id || node?.dependency
              ),
              20,
            ),
          })),
        operationApis: modelStringList(plan.operationApis, 20),
        requiredLegacyApis: modelStringList(plan.requiredLegacyApis, 24),
        requiredCapabilities: modelStringList(plan.requiredCapabilities, 24),
        witnessInstanceIds: modelStringList(
          analysis.witnessInstanceIds,
          16,
        ),
        structuredTrace: (Array.isArray(analysis.structuredTrace)
          ? analysis.structuredTrace
          : []).slice(0, 16).map((entry) => ({
            instanceId: modelString(entry?.instanceId),
            check: modelString(entry?.check),
            result: modelString(entry?.result),
            reasonCode: modelString(entry?.reasonCode),
          })),
        unresolvedReasonCodes: modelReasonCodes(plan.unresolvedSemantics),
        unknownReasonCodes: modelReasonCodes(candidate.unknownReasons),
      };
    });
  const body = {
    schemaVersion: "ocg-assistant-lua-semantic-model-view/v1",
    sourcePacketId: packet.packetId,
    sourcePacketSha256: packet.packetSha256,
    authority: LEGACY_LUA_SEMANTIC_AUTHORITY,
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    verdict: "UNKNOWN",
    resources: packet.resources.map((resource) => ({
      resourceId: resource.resourceId,
      status: resource.status,
      resourceSha256: resource.resourceSha256,
      candidateCount: resource.candidateCount,
      sourceDocumentId: resource.resourceBinding.sourceDocumentId,
      sourceContentSha256: resource.resourceBinding.sourceContentSha256,
      unknownReasonCodes: modelReasonCodes(resource.unknownReasons),
    })),
    effectCandidates,
    omittedCandidateCount:
      packet.truncation.omittedCandidateCount +
      Math.max(0, packet.effectCandidates.length - effectCandidates.length),
    packetTruncation: packet.truncation,
    unknownReasonCodes: modelReasonCodes(packet.unknownReasons),
  };
  return deepFreeze({
    ...body,
    modelViewSha256: canonicalLegacyLuaSha256(body),
  });
}

export function parseLegacyLuaSemanticPacket(serialized) {
  try {
    const parsed = typeof serialized === "string"
      ? JSON.parse(serialized)
      : serialized;
    return validateLegacyLuaSemanticPacket(parsed);
  } catch (error) {
    return createLegacyLuaUnknownPacket({
      code: error?.code || "LEGACY_LUA_PACKET_PARSE_INVALID",
      message: error instanceof Error ? error.message : String(error),
      details: jsonDetails(error?.details),
    });
  }
}

export function canonicalLegacyLuaStringify(value) {
  return JSON.stringify(canonicalizeJson(value));
}

export function canonicalLegacyLuaSha256(value) {
  return createHash("sha256")
    .update(canonicalLegacyLuaStringify(value))
    .digest("hex");
}

export function normalizeLegacyLuaUnknownReasons(value) {
  return normalizeUnknownReasons(value);
}

function dependencyGraphEntries(value) {
  if (Array.isArray(value?.dependencies)) return value.dependencies;
  // v1 fixtures used `nodes`; retain it only as a compatibility fallback.
  return Array.isArray(value?.nodes) ? value.nodes : [];
}

function buildPacket({
  resources,
  candidateLimit,
  byteLimit,
  additionalUnknownReasons,
}) {
  const orderedResources = [...resources].sort((left, right) =>
    compareText(left.resourceId, right.resourceId)
  );
  const packetResources = orderedResources.map((resource) => {
    const summaryBody = {
      resourceId: resource.resourceId,
      status: resource.status,
      resourceSha256: resource.resourceSha256,
      resourceBinding: resource.resourceBinding,
      engineBinding: resource.engineBinding,
      registryBinding: resource.registryBinding,
      candidateSetSha256: resource.candidateSetSha256,
      candidateCount: resource.effectCandidates.length,
      unknownReasons: resource.unknownReasons,
    };
    return {
      ...summaryBody,
      bindingSha256: canonicalLegacyLuaSha256(summaryBody),
    };
  });
  const allCandidates = orderedResources
    .flatMap((resource) => resource.effectCandidates.map((candidate) => ({
      resourceId: resource.resourceId,
      ...candidate,
    })))
    .sort((left, right) => compareText(
      packetCandidateSortKey(left),
      packetCandidateSortKey(right),
    ));
  let included = allCandidates.slice(0, candidateLimit);
  let omitted = allCandidates.slice(candidateLimit).map((candidate) =>
    omission(candidate, "MAX_CANDIDATES")
  );
  const inheritedReasons = orderedResources.flatMap((resource) =>
    resource.unknownReasons
  );
  const unknownReasons = normalizeUnknownReasons([
    ...inheritedReasons,
    ...additionalUnknownReasons,
  ]);
  let content = packetContent({
    resources: packetResources,
    included,
    omitted,
    candidateLimit,
    byteLimit,
    budgetSatisfied: true,
    unknownReasons,
  });
  if (byteLimit !== null) {
    while (included.length && packetSerializedSize(content) > byteLimit) {
      const candidate = included.pop();
      omitted.push(omission(candidate, "MAX_SERIALIZED_BYTES"));
      omitted.sort((left, right) => compareText(
        packetCandidateSortKey(left),
        packetCandidateSortKey(right),
      ));
      content = packetContent({
        resources: packetResources,
        included,
        omitted,
        candidateLimit,
        byteLimit,
        budgetSatisfied: true,
        unknownReasons,
      });
    }
    const budgetSatisfied = packetSerializedSize(content) <= byteLimit;
    if (!budgetSatisfied) {
      content = packetContent({
        resources: packetResources,
        included,
        omitted,
        candidateLimit,
        byteLimit,
        budgetSatisfied: false,
        unknownReasons,
      });
    }
  }
  const packetSha256 = canonicalLegacyLuaSha256(content);
  return validateLegacyLuaSemanticPacket({
    ...content,
    packetId: `legacy_lua_${packetSha256.slice(0, 24)}`,
    packetSha256,
  });
}

function packetContent({
  resources,
  included,
  omitted,
  candidateLimit,
  byteLimit,
  budgetSatisfied,
  unknownReasons,
}) {
  return {
    schemaVersion: LEGACY_LUA_SEMANTIC_PACKET_SCHEMA,
    kind: PACKET_KIND,
    authority: LEGACY_LUA_SEMANTIC_AUTHORITY,
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    verdict: "UNKNOWN",
    resources,
    effectCandidates: included,
    omittedCandidates: omitted,
    truncation: {
      applied: omitted.length > 0,
      totalCandidateCount: included.length + omitted.length,
      includedCandidateCount: included.length,
      omittedCandidateCount: omitted.length,
      maxCandidates: candidateLimit === Number.MAX_SAFE_INTEGER
        ? null
        : candidateLimit,
      maxSerializedBytes: byteLimit,
      budgetSatisfied,
    },
    unknownReasons,
  };
}

function packetSerializedSize(content) {
  const hash = "0".repeat(64);
  const withEnvelope = {
    ...content,
    packetId: `legacy_lua_${hash.slice(0, 24)}`,
    packetSha256: hash,
  };
  return Buffer.byteLength(canonicalLegacyLuaStringify(withEnvelope), "utf8");
}

function validatePacketResourceSummary(value) {
  assertExactKeys(value, new Set([
    "resourceId",
    "status",
    "resourceSha256",
    "resourceBinding",
    "engineBinding",
    "registryBinding",
    "candidateSetSha256",
    "candidateCount",
    "unknownReasons",
    "bindingSha256",
  ]), "packet resource summary");
  nonEmptyString(value.resourceId, "packet resourceId");
  if (!STATUS.has(value.status)) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      "packet resource status is invalid",
    );
  }
  digest(value.resourceSha256, "packet resourceSha256");
  validateResourceBinding(value.resourceBinding);
  if (value.engineBinding !== null) validateEngineBinding(value.engineBinding);
  if (value.registryBinding !== null) validateRegistryBinding(value.registryBinding);
  if (value.candidateSetSha256 !== null) {
    digest(value.candidateSetSha256, "packet candidateSetSha256");
  }
  if (!Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      "packet resource candidateCount must be a non-negative integer",
    );
  }
  const summaryBody = {
    resourceId: value.resourceId,
    status: value.status,
    resourceSha256: value.resourceSha256,
    resourceBinding: value.resourceBinding,
    engineBinding: value.engineBinding,
    registryBinding: value.registryBinding,
    candidateSetSha256: value.candidateSetSha256,
    candidateCount: value.candidateCount,
    unknownReasons: normalizeUnknownReasons(value.unknownReasons),
  };
  equalDigest(value.bindingSha256, canonicalLegacyLuaSha256(summaryBody),
    "packet resource bindingSha256");
  return { ...summaryBody, bindingSha256: value.bindingSha256 };
}

function validatePacketCandidateEntry(value, resourcesById) {
  const resource = resourcesById.get(value?.resourceId);
  if (!resource) {
    throw contractError(
      "LEGACY_LUA_PACKET_BINDING_INVALID",
      "candidate references an unknown resource",
    );
  }
  const candidate = { ...value };
  delete candidate.resourceId;
  const validated = validateSemanticCandidate(candidate, resource);
  return { resourceId: value.resourceId, ...validated };
}

function validateOmittedCandidate(value, resourceIds) {
  assertExactKeys(value, new Set([
    "resourceId",
    "semanticEffectIdentity",
    "candidateSha256",
    "reason",
  ]), "omitted candidate");
  if (!resourceIds.has(value.resourceId)) {
    throw contractError(
      "LEGACY_LUA_PACKET_BINDING_INVALID",
      "omitted candidate references an unknown resource",
    );
  }
  nullableIdentity(value.semanticEffectIdentity, "omitted semanticEffectIdentity");
  digest(value.candidateSha256, "omitted candidateSha256");
  if (!new Set(["MAX_CANDIDATES", "MAX_SERIALIZED_BYTES"]).has(value.reason)) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      "omitted candidate reason is invalid",
    );
  }
  return value;
}

function validateTruncation(value, included, omitted) {
  assertExactKeys(value, new Set([
    "applied",
    "totalCandidateCount",
    "includedCandidateCount",
    "omittedCandidateCount",
    "maxCandidates",
    "maxSerializedBytes",
    "budgetSatisfied",
  ]), "packet truncation");
  if (typeof value.applied !== "boolean" ||
      typeof value.budgetSatisfied !== "boolean") {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      "truncation boolean fields are invalid",
    );
  }
  equal(value.applied, omitted.length > 0, "truncation.applied");
  equal(value.includedCandidateCount, included.length,
    "truncation.includedCandidateCount");
  equal(value.omittedCandidateCount, omitted.length,
    "truncation.omittedCandidateCount");
  equal(value.totalCandidateCount, included.length + omitted.length,
    "truncation.totalCandidateCount");
  if (value.maxCandidates !== null) normalizeCandidateLimit(value.maxCandidates);
  if (value.maxSerializedBytes !== null) normalizeByteLimit(value.maxSerializedBytes);
  return value;
}

function validateSemanticCandidate(value, resource) {
  assertExactKeys(value, new Set([
    "kind",
    "verdict",
    "legacyAcceptedAsTruth",
    "semanticEffectIdentity",
    "identityScheme",
    "candidateSha256",
    "semanticArtifactSha256",
    "compileResultSha256",
    "analysisArtifactSha256",
    "semanticArtifact",
    "analysisArtifact",
    "unknownReasons",
  ]), "legacy Lua semantic candidate");
  if (!CANDIDATE_KINDS.has(value.kind)) {
    throw contractError(
      "LEGACY_LUA_CANDIDATE_SCHEMA_INVALID",
      "candidate.kind must be CANDIDATE or TYPED_UNKNOWN",
    );
  }
  equal(value.verdict, "UNKNOWN", "candidate.verdict");
  equal(value.legacyAcceptedAsTruth, false,
    "candidate.legacyAcceptedAsTruth");
  nullableIdentity(value.semanticEffectIdentity,
    "candidate.semanticEffectIdentity");
  equal(value.identityScheme, LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    "candidate.identityScheme");
  if (value.semanticArtifact !== null) {
    const artifact = canonicalizeJson(value.semanticArtifact);
    equalDigest(value.semanticArtifactSha256,
      canonicalLegacyLuaSha256(artifact), "candidate.semanticArtifactSha256");
    validateEngineCandidateArtifact(artifact, value, resource);
  } else if (value.semanticArtifactSha256 !== null) {
    digest(value.semanticArtifactSha256, "candidate.semanticArtifactSha256");
  }
  if (value.kind === "CANDIDATE") {
    if (value.semanticEffectIdentity === null || value.semanticArtifact === null ||
        value.compileResultSha256 === null) {
      throw contractError(
        "LEGACY_LUA_CANDIDATE_SCHEMA_INVALID",
        "CANDIDATE requires a stable identity, semantic artifact, and compile result binding",
      );
    }
  }
  if (value.compileResultSha256 !== null) {
    digest(value.compileResultSha256, "candidate.compileResultSha256");
  }
  if (value.analysisArtifact !== null) {
    const analysis = canonicalizeJson(value.analysisArtifact);
    equalDigest(value.analysisArtifactSha256,
      canonicalLegacyLuaSha256(analysis), "candidate.analysisArtifactSha256");
    validateCandidateAnalysis(analysis, value, resource);
  } else if (value.analysisArtifactSha256 !== null) {
    digest(value.analysisArtifactSha256, "candidate.analysisArtifactSha256");
  }
  const unknownReasons = normalizeUnknownReasons(value.unknownReasons);
  if (value.kind === "TYPED_UNKNOWN" && !unknownReasons.length) {
    throw contractError(
      "LEGACY_LUA_CANDIDATE_SCHEMA_INVALID",
      "TYPED_UNKNOWN candidate must explain why it is unknown",
    );
  }
  const body = {
    ...value,
    unknownReasons,
  };
  delete body.candidateSha256;
  equalDigest(value.candidateSha256, canonicalLegacyLuaSha256(body),
    "candidate.candidateSha256");
  return { ...body, candidateSha256: value.candidateSha256 };
}

function validateEngineCandidateArtifact(artifact, candidate, resource) {
  if (!CANDIDATE_KINDS.has(artifact.kind)) {
    throw contractError(
      "LEGACY_LUA_ENGINE_ARTIFACT_INVALID",
      "engine candidate kind is invalid",
    );
  }
  if (candidate.kind === "CANDIDATE") {
    equal(artifact.kind, "CANDIDATE", "engine candidate kind");
  }
  nullableIdentity(artifact.semanticEffectIdentity,
    "engine candidate semanticEffectIdentity");
  equal(artifact.semanticEffectIdentity, candidate.semanticEffectIdentity,
    "engine candidate semanticEffectIdentity");
  equal(artifact.identityScheme, LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    "engine candidate identityScheme");
  const plan = artifact.plan ?? artifact.partialPlan ?? null;
  if (plan !== null) validateLegacyPlan(plan, candidate, resource);
}

function validateLegacyPlan(plan, candidate, resource) {
  if (!isPlainObject(plan)) {
    throw contractError(
      "LEGACY_LUA_ENGINE_ARTIFACT_INVALID",
      "legacy activation plan must be an object",
    );
  }
  equal(plan.schemaVersion, "ocg-legacy-lua-activation-plan/v2",
    "legacy plan schemaVersion");
  equal(plan.verificationStatus, "LEGACY_DISCOVERY_ONLY",
    "legacy plan verificationStatus");
  equal(plan.semanticEffectIdentity, candidate.semanticEffectIdentity,
    "legacy plan semanticEffectIdentity");
  equal(plan.identityScheme, LEGACY_LUA_SEMANTIC_IDENTITY_SCHEME,
    "legacy plan identityScheme");
  digest(plan.sourceContentHash, "legacy plan sourceContentHash");
  digest(plan.semanticFingerprint, "legacy plan semanticFingerprint");
  digest(plan.apiSemanticsRegistryHash,
    "legacy plan apiSemanticsRegistryHash");
  if (resource) {
    equal(plan.sourceDocumentId,
      resource.resourceBinding.sourceDocumentId,
      "legacy plan sourceDocumentId");
    equal(plan.sourceContentHash,
      resource.resourceBinding.sourceContentSha256,
      "legacy plan sourceContentHash");
    if (resource.registryBinding) {
      equal(plan.apiSemanticsRegistryId,
        resource.registryBinding.registryId,
        "legacy plan registryId");
      equal(plan.apiSemanticsRegistryVersion,
        resource.registryBinding.registryVersion,
        "legacy plan registryVersion");
      equal(plan.apiSemanticsRegistryHash,
        resource.registryBinding.registrySha256,
        "legacy plan registryHash");
    }
    if (resource.engineBinding) {
      validateArtifactVersionSubset(
        plan.versions,
        resource.engineBinding.versions,
        "legacy plan versions",
      );
    }
  }
}

function validateCandidateAnalysis(analysis, candidate, resource) {
  equal(analysis.schemaVersion, "ocg-legacy-lua-candidate-analysis/v2",
    "candidate analysis schemaVersion");
  equal(analysis.kind, "LEGACY_CANDIDATE_ANALYSIS",
    "candidate analysis kind");
  equal(analysis.verdict, "UNKNOWN", "candidate analysis verdict");
  equal(analysis.legacyAcceptedAsTruth, false,
    "candidate analysis legacyAcceptedAsTruth");
  equal(analysis.proof, null, "candidate analysis proof");
  if (!new Set(["TRUE", "FALSE", "UNKNOWN"]).has(
    analysis.candidateVerdict,
  )) {
    throw contractError(
      "LEGACY_LUA_ENGINE_ARTIFACT_INVALID",
      "candidate analysis candidateVerdict is invalid",
    );
  }
  equal(analysis.semanticEffectIdentity, candidate.semanticEffectIdentity,
    "candidate analysis semanticEffectIdentity");
  if (analysis.planFingerprint !== null) {
    digest(analysis.planFingerprint, "candidate analysis planFingerprint");
  }
  digest(analysis.apiSemanticsRegistryHash,
    "candidate analysis registryHash");
  if (resource?.registryBinding) {
    equal(analysis.apiSemanticsRegistryId,
      resource.registryBinding.registryId,
      "candidate analysis registryId");
    equal(analysis.apiSemanticsRegistryVersion,
      resource.registryBinding.registryVersion,
      "candidate analysis registryVersion");
    equal(analysis.apiSemanticsRegistryHash,
      resource.registryBinding.registrySha256,
      "candidate analysis registryHash");
  }
  if (resource?.engineBinding) {
    validateArtifactVersionSubset(
      analysis.versions,
      resource.engineBinding.versions,
      "candidate analysis versions",
    );
  }
}

function validateResourceBinding(value) {
  assertExactKeys(value, new Set([
    "sourceDocumentId",
    "sourceContentSha256",
    "documentVersion",
    "locator",
    "retrievedAt",
  ]), "resource binding");
  nullableString(value.sourceDocumentId, "resource sourceDocumentId");
  if (value.sourceContentSha256 !== null) {
    digest(value.sourceContentSha256, "resource sourceContentSha256");
  }
  nullableString(value.documentVersion, "resource documentVersion");
  nullableString(value.locator, "resource locator");
  if (value.retrievedAt !== null) {
    const time = new Date(value.retrievedAt).getTime();
    if (!Number.isFinite(time)) {
      throw contractError(
        "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
        "resource retrievedAt must be an ISO-compatible timestamp",
      );
    }
  }
}

function validateEngineBinding(value) {
  assertExactKeys(value, new Set([
    "versions",
    "versionsSha256",
    "capabilitiesSha256",
    "requiredCapabilities",
  ]), "engine binding");
  if (!isPlainObject(value.versions)) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "engine versions must be an object",
    );
  }
  if (!isPlainObject(value.versions.artifacts)) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "engine versions must bind artifact versions",
    );
  }
  for (const [name, expected] of Object.entries(REQUIRED_ENGINE_ARTIFACTS)) {
    equal(value.versions.artifacts[name], expected,
      `engine versions.artifacts.${name}`);
  }
  equalDigest(value.versionsSha256,
    canonicalLegacyLuaSha256(value.versions), "engine versionsSha256");
  digest(value.capabilitiesSha256, "engine capabilitiesSha256");
  if (!Array.isArray(value.requiredCapabilities) ||
      value.requiredCapabilities.some((item) =>
        typeof item !== "string" || !/\/v\d+$/u.test(item)
      )) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "engine requiredCapabilities must contain versioned capability IDs",
    );
  }
  assertSorted(value.requiredCapabilities, (item) => item,
    "engine requiredCapabilities must be sorted");
}

function validateRegistryBinding(value) {
  assertExactKeys(value, new Set([
    "registryId",
    "registryVersion",
    "registrySha256",
    "pinnedCoreRepository",
    "pinnedCoreCommit",
    "pinnedCoreApiAbi",
  ]), "registry binding");
  nonEmptyString(value.registryId, "registryId");
  nonEmptyString(value.registryVersion, "registryVersion");
  digest(value.registrySha256, "registrySha256");
  nonEmptyString(value.pinnedCoreRepository, "pinnedCoreRepository");
  if (!/^[a-f0-9]{40}$/u.test(value.pinnedCoreCommit)) {
    throw contractError(
      "LEGACY_LUA_RESOURCE_SCHEMA_INVALID",
      "pinnedCoreCommit must be a full lowercase Git commit",
    );
  }
  nonEmptyString(value.pinnedCoreApiAbi, "pinnedCoreApiAbi");
}

function omission(candidate, reason) {
  return {
    resourceId: candidate.resourceId,
    semanticEffectIdentity: candidate.semanticEffectIdentity,
    candidateSha256: candidate.candidateSha256,
    reason,
  };
}

function normalizeUnknownReasons(value) {
  if (!Array.isArray(value)) {
    throw contractError(
      "LEGACY_LUA_UNKNOWN_REASON_INVALID",
      "unknownReasons must be an array",
    );
  }
  const reasons = value.map(normalizeUnknownReason);
  const byHash = new Map(reasons.map((reason) => [
    canonicalLegacyLuaSha256(reason),
    reason,
  ]));
  return [...byHash.values()].sort((left, right) => compareText(
    unknownReasonSortKey(left),
    unknownReasonSortKey(right),
  ));
}

function normalizeUnknownReason(value) {
  if (!isPlainObject(value)) {
    throw contractError(
      "LEGACY_LUA_UNKNOWN_REASON_INVALID",
      "unknown reason must be an object",
    );
  }
  const phase = nonEmptyString(value.phase || "LEGACY_LUA_PACKET",
    "unknown reason phase");
  const code = nonEmptyString(value.code, "unknown reason code");
  const message = nonEmptyString(value.message, "unknown reason message");
  const evidenceIds = Array.isArray(value.evidenceIds)
    ? [...new Set(value.evidenceIds.map((item) => String(item)))].sort()
    : [];
  const reason = { phase, code, message, evidenceIds };
  if (value.details !== undefined) reason.details = canonicalizeJson(value.details);
  return reason;
}

function unknownReasonSortKey(reason) {
  return [
    reason.phase,
    reason.code,
    reason.message,
    canonicalLegacyLuaStringify(reason.evidenceIds),
    canonicalLegacyLuaStringify(reason.details ?? null),
  ].join("\u0000");
}

function assertNonAuthoritativeBoundary(value, label) {
  equal(value.authority, LEGACY_LUA_SEMANTIC_AUTHORITY,
    `${label}.authority`);
  equal(value.canConfirmOfficialRuling, false,
    `${label}.canConfirmOfficialRuling`);
  equal(value.legacyAcceptedAsTruth, false,
    `${label}.legacyAcceptedAsTruth`);
  equal(value.verdict, "UNKNOWN", `${label}.verdict`);
}

function assertStableCandidateOrder(candidates, resourceId) {
  assertSorted(candidates, candidateSortKey,
    `resource ${resourceId} candidates must use stable semantic identity order`);
}

function candidateSortKey(candidate) {
  return candidate.semanticEffectIdentity === null
    ? `~unknown:${candidate.candidateSha256}`
    : `identity:${candidate.semanticEffectIdentity}`;
}

function packetCandidateSortKey(candidate) {
  return `${candidate.resourceId}\u0000${candidateSortKey(candidate)}`;
}

function assertSorted(values, key, message) {
  const keys = values.map(key);
  const sorted = [...keys].sort((left, right) =>
    compareText(String(left), String(right))
  );
  if (keys.some((item, index) => item !== sorted[index])) {
    throw contractError("LEGACY_LUA_ORDER_INVALID", message);
  }
}

function normalizeCandidateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw contractError(
      "LEGACY_LUA_PACKET_LIMIT_INVALID",
      "maxCandidates must be a non-negative safe integer",
    );
  }
  return value;
}

function normalizeByteLimit(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw contractError(
      "LEGACY_LUA_PACKET_LIMIT_INVALID",
      "maxSerializedBytes must be a positive safe integer or null",
    );
  }
  return value;
}

function validateArtifactVersionSubset(actual, expected, label) {
  if (!isPlainObject(actual)) {
    throw contractError(
      "LEGACY_LUA_PACKET_BINDING_INVALID",
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

function nullableIdentity(value, label) {
  if (value === null) return null;
  digest(value, label);
  return value;
}

function nullableString(value, label) {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw contractError(
      "LEGACY_LUA_PACKET_BINDING_INVALID",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

function equalDigest(actual, expected, label) {
  digest(actual, label);
  equal(actual, expected, label);
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw contractError(
      "LEGACY_LUA_PACKET_BINDING_INVALID",
      `${label} is incompatible`,
      { expected, actual },
    );
  }
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      `${label} must be a plain object`,
    );
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    throw contractError(
      "LEGACY_LUA_PACKET_SCHEMA_INVALID",
      `${label} does not match its closed schema`,
      { unexpected, missing },
    );
  }
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

function compareText(left, right) {
  const first = String(left);
  const second = String(right);
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function modelString(value) {
  return typeof value === "string" ? value.slice(0, 240) : "";
}

function modelStringList(values, limit) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(modelString)
    .filter(Boolean))]
    .sort()
    .slice(0, limit);
}

function modelReasonCodes(reasons) {
  return modelStringList(
    (Array.isArray(reasons) ? reasons : []).map((reason) => reason?.code),
    24,
  );
}

function jsonDetails(value) {
  try {
    return canonicalizeJson(value ?? {});
  } catch {
    return { unavailable: true };
  }
}

function canonicalizeJson(value, seen = new Set(), path = "$") {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw contractError(
        "LEGACY_LUA_PACKET_CANONICALIZATION_FAILED",
        `non-finite number at ${path}`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw contractError(
      "LEGACY_LUA_PACKET_CANONICALIZATION_FAILED",
      `non-JSON value at ${path}`,
    );
  }
  if (seen.has(value)) {
    throw contractError(
      "LEGACY_LUA_PACKET_CANONICALIZATION_FAILED",
      `cyclic value at ${path}`,
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        canonicalizeJson(item, seen, `${path}[${index}]`)
      );
    }
    if (!isPlainObject(value)) {
      throw contractError(
        "LEGACY_LUA_PACKET_CANONICALIZATION_FAILED",
        `non-plain object at ${path}`,
      );
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalizeJson(value[key], seen, `${path}.${key}`),
    ]));
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contractError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "LegacyLuaSemanticContractError";
  error.code = code;
  error.details = details;
  return error;
}
