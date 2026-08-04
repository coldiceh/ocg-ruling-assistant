import { createHash } from "node:crypto";

import {
  canonicalLegacyLuaSha256,
} from "./legacyLuaSemanticPacket.mjs";
import { requestOcgEngineJson } from "./ocgEngineHttpClient.mjs";

export const LEGACY_LUA_HTTP_ENDPOINTS = Object.freeze({
  capabilities: "/formal/v1/legacy-lua/capabilities",
  source: "/formal/v1/legacy-lua/source",
  effectCandidates: "/formal/v1/legacy-lua/effect-candidates",
  compilePlan: "/formal/v1/legacy-lua/compile-plan",
  analyzeActivation: "/formal/v1/legacy-lua/analyze-activation",
});

export const LEGACY_LUA_HTTP_SCHEMAS = Object.freeze({
  capabilities: "ocg-legacy-lua-http-capabilities/v1",
  source: "ocg-legacy-lua-http-source/v1",
  effectCandidates: "ocg-legacy-lua-http-effect-candidates/v1",
  compilePlan: "ocg-legacy-lua-http-compile-plan/v1",
  analyzeActivation: "ocg-legacy-lua-http-analyze-activation/v1",
});

const SHA256 = /^[a-f0-9]{64}$/u;
const PASSCODE = /^\d{8}$/u;
const HTTP_AUTHORITY = "LEGACY_DISCOVERY_ONLY";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Adapts the versioned HTTP API to the in-process facade consumed by
 * collectLegacyLuaSemanticPacket. All negotiated bindings are pinned for the
 * lifetime of this facade. A changed engine, registry, capability manifest or
 * resource lock therefore fails closed instead of mixing artifacts.
 */
export function createLegacyLuaSemanticHttpFacade({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  requestJson = requestOcgEngineJson,
  now = Date.now,
} = {}) {
  const startedAt = Number(now());
  const totalTimeoutMs = boundedInteger(timeoutMs, 1, 60_000,
    DEFAULT_TIMEOUT_MS);
  const responseByteLimit = boundedInteger(
    maxResponseBytes,
    1_024,
    16 * 1024 * 1024,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  let negotiationPromise = null;
  const sourcePromises = new Map();

  const request = async ({ endpoint, method, body }) => {
    if (signal?.aborted) {
      throw httpError(
        "LEGACY_LUA_HTTP_ABORTED",
        "legacy Lua HTTP request was aborted",
      );
    }
    const elapsed = Math.max(0, Number(now()) - startedAt);
    const remainingMs = totalTimeoutMs - elapsed;
    if (remainingMs <= 0) {
      throw httpError(
        "LEGACY_LUA_HTTP_TIMEOUT",
        `legacy Lua HTTP deadline exceeded ${totalTimeoutMs}ms`,
      );
    }
    const transport = await requestJson({
      path: LEGACY_LUA_HTTP_ENDPOINTS[endpoint],
      method,
      ...(body === undefined ? {} : { body }),
      env,
      fetchImpl,
      timeoutMs: remainingMs,
      defaultTimeoutMs: remainingMs,
      signal,
      maxResponseBytes: responseByteLimit,
    });
    if (transport?.status !== "response") {
      const transportCode = transport?.error?.code || null;
      const code = transport?.status === "disabled"
        ? "LEGACY_LUA_HTTP_NOT_CONFIGURED"
        : transportCode === "OCG_ENGINE_RESPONSE_TOO_LARGE"
          ? "LEGACY_LUA_HTTP_RESPONSE_TOO_LARGE"
          : "LEGACY_LUA_HTTP_UNAVAILABLE";
      throw httpError(
        code,
        transport?.error?.message || "legacy Lua HTTP endpoint is unavailable",
        { transportCode, endpoint },
      );
    }
    if (!transport.responseOk || transport.payload?.ok !== true) {
      throw httpError(
        "LEGACY_LUA_HTTP_REJECTED",
        transport.payload?.error?.message ||
          "legacy Lua HTTP endpoint rejected the request",
        {
          endpoint,
          httpStatus: transport.httpStatus,
          remoteCode: transport.payload?.error?.code || null,
        },
      );
    }
    assertPayloadSize(transport.payload, responseByteLimit, endpoint);
    return structuredClone(transport.payload);
  };

  const negotiate = async () => {
    if (!negotiationPromise) {
      negotiationPromise = request({
        endpoint: "capabilities",
        method: "GET",
      }).then((payload) => validateCapabilitiesEnvelope(payload));
    }
    return negotiationPromise;
  };

  const invoke = async ({
    endpoint,
    operation,
    body,
    sourceDocument = null,
  }) => {
    const negotiated = await negotiate();
    const payload = await request({ endpoint, method: "POST", body });
    return validateOperationEnvelope(payload, {
      endpoint,
      operation,
      negotiated,
      sourceDocument,
    });
  };

  return Object.freeze({
    async getEngineVersions() {
      return structuredClone((await negotiate()).engineBinding.versions);
    },
    async getEngineCapabilities() {
      return structuredClone((await negotiate()).capabilityManifest);
    },
    async getLegacyLuaApiSemanticsRegistry() {
      return structuredClone((await negotiate()).apiSemanticsRegistry);
    },
    async resolveLegacyLuaSource(passcode) {
      const normalized = normalizeEightDigitPasscode(passcode);
      if (normalized === null) {
        throw httpError(
          "LEGACY_LUA_PASSCODE_INVALID",
          "legacy Lua source resolution requires a non-zero 8-digit passcode",
        );
      }
      if (!sourcePromises.has(normalized)) {
        sourcePromises.set(normalized, invoke({
          endpoint: "source",
          operation: "RESOLVE_SOURCE",
          body: { passcode: normalized },
        }).then((envelope) => validateResolvedSource(envelope, normalized)));
      }
      return sourcePromises.get(normalized);
    },
    async enumerateLegacyLuaEffectCandidates(sourceDocument) {
      const response = await invoke({
        endpoint: "effectCandidates",
        operation: "EFFECT_CANDIDATES",
        body: { sourceDocument },
        sourceDocument,
      });
      return structuredClone(response.result);
    },
    async compileLegacyLuaActivationPlan(sourceDocument, selection = {}) {
      const response = await invoke({
        endpoint: "compilePlan",
        operation: "COMPILE_PLAN",
        body: {
          sourceDocument,
          semanticEffectIdentity: selection.semanticEffectIdentity,
        },
        sourceDocument,
      });
      return structuredClone(response.result);
    },
    async analyzeLegacyLuaActivation({
      sourceDocument,
      scenario,
      semanticEffectIdentity,
    } = {}) {
      const response = await invoke({
        endpoint: "analyzeActivation",
        operation: "ANALYZE_ACTIVATION",
        body: { sourceDocument, scenario, semanticEffectIdentity },
        sourceDocument,
      });
      return structuredClone(response.result);
    },
  });
}

function validateCapabilitiesEnvelope(payload) {
  assertBaseEnvelope(payload, LEGACY_LUA_HTTP_SCHEMAS.capabilities);
  equal(payload.kind, "LEGACY_LUA_HTTP_CAPABILITIES", "capabilities.kind");
  assertResourceBinding(payload.resourceBinding);
  assertEngineBinding(payload.engineBinding);
  assertRegistryBinding(payload.registryBinding);
  plainObject(payload.capabilityManifest, "capabilityManifest");
  plainObject(payload.apiSemanticsRegistry, "apiSemanticsRegistry");
  equalDigest(
    payload.engineBinding.capabilityManifestSha256,
    canonicalLegacyLuaSha256(payload.capabilityManifest),
    "engineBinding.capabilityManifestSha256",
  );
  equalDigest(
    payload.registryBinding.registrySha256,
    canonicalLegacyLuaSha256(payload.apiSemanticsRegistry),
    "registryBinding.registrySha256",
  );
  equal(
    payload.apiSemanticsRegistry.schemaVersion,
    payload.registryBinding.schemaVersion,
    "registry schemaVersion",
  );
  equal(payload.apiSemanticsRegistry.registryId,
    payload.registryBinding.registryId, "registryId");
  equal(payload.apiSemanticsRegistry.registryVersion,
    payload.registryBinding.registryVersion, "registryVersion");
  equal(payload.apiSemanticsRegistry.authority,
    payload.registryBinding.authority, "registry authority");
  equal(payload.apiSemanticsRegistry.legacyAcceptedAsTruth, false,
    "registry legacyAcceptedAsTruth");
  plainObject(payload.sourceResolution, "sourceResolution");
  equal(payload.sourceResolution.lockedPasscode, true,
    "sourceResolution.lockedPasscode");
  validateEndpointManifest(payload.endpoints);
  return Object.freeze({
    resourceBinding: structuredClone(payload.resourceBinding),
    engineBinding: structuredClone(payload.engineBinding),
    registryBinding: structuredClone(payload.registryBinding),
    capabilityManifest: structuredClone(payload.capabilityManifest),
    apiSemanticsRegistry: structuredClone(payload.apiSemanticsRegistry),
  });
}

function validateOperationEnvelope(payload, {
  endpoint,
  operation,
  negotiated,
  sourceDocument,
}) {
  assertBaseEnvelope(payload, LEGACY_LUA_HTTP_SCHEMAS[endpoint]);
  if (!["COMPLETED", "TYPED_UNKNOWN"].includes(payload.kind)) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      `${endpoint}.kind must be COMPLETED or TYPED_UNKNOWN`,
    );
  }
  equal(payload.operation, operation, `${endpoint}.operation`);
  equalCanonical(payload.resourceBinding, negotiated.resourceBinding,
    `${endpoint}.resourceBinding`);
  equalCanonical(payload.engineBinding, negotiated.engineBinding,
    `${endpoint}.engineBinding`);
  equalCanonical(payload.registryBinding, negotiated.registryBinding,
    `${endpoint}.registryBinding`);
  if (!Array.isArray(payload.unknownReasons)) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      `${endpoint}.unknownReasons must be an array`,
    );
  }
  if (sourceDocument !== null) {
    assertSourceBinding(payload.sourceBinding, sourceDocument, endpoint);
  }
  if (payload.result === null) {
    const first = payload.unknownReasons[0];
    throw httpError(
      typeof first?.code === "string"
        ? first.code
        : "LEGACY_LUA_HTTP_TYPED_UNKNOWN",
      typeof first?.message === "string"
        ? first.message
        : `legacy Lua ${operation} returned typed UNKNOWN`,
      { endpoint, operation, remoteUnknownReasons: payload.unknownReasons },
    );
  }
  plainObject(payload.result, `${endpoint}.result`);
  if (payload.kind === "TYPED_UNKNOWN" && payload.unknownReasons.length === 0) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      `${endpoint} TYPED_UNKNOWN must explain why it is unknown`,
    );
  }
  return payload;
}

function assertBaseEnvelope(value, schemaVersion) {
  plainObject(value, "legacy Lua HTTP envelope");
  equal(value.ok, true, "envelope.ok");
  equal(value.schemaVersion, schemaVersion, "envelope.schemaVersion");
  equal(value.authority, HTTP_AUTHORITY, "envelope.authority");
  equal(value.canConfirmOfficialRuling, false,
    "envelope.canConfirmOfficialRuling");
  equal(value.legacyAcceptedAsTruth, false,
    "envelope.legacyAcceptedAsTruth");
  equal(value.verdict, "UNKNOWN", "envelope.verdict");
}

function assertResourceBinding(value) {
  plainObject(value, "resourceBinding");
  for (const field of [
    "lockId",
    "snapshotId",
    "manifestSha256",
    "coreSha256",
    "dbSetSha256",
    "scriptSetSha256",
    "patchSetSha256",
  ]) digest(value[field], `resourceBinding.${field}`);
  nonEmptyString(value.apiAbi, "resourceBinding.apiAbi");
}

function assertEngineBinding(value) {
  plainObject(value, "engineBinding");
  plainObject(value.versions, "engineBinding.versions");
  equalDigest(value.versionsSha256,
    canonicalLegacyLuaSha256(value.versions), "engineBinding.versionsSha256");
  digest(value.capabilityManifestSha256,
    "engineBinding.capabilityManifestSha256");
  if (!Array.isArray(value.requiredCapabilities)) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      "engineBinding.requiredCapabilities must be an array",
    );
  }
}

function assertRegistryBinding(value) {
  plainObject(value, "registryBinding");
  nonEmptyString(value.schemaVersion, "registryBinding.schemaVersion");
  nonEmptyString(value.registryId, "registryBinding.registryId");
  nonEmptyString(value.registryVersion, "registryBinding.registryVersion");
  digest(value.registrySha256, "registryBinding.registrySha256");
  equal(value.authority, HTTP_AUTHORITY, "registryBinding.authority");
  equal(value.legacyAcceptedAsTruth, false,
    "registryBinding.legacyAcceptedAsTruth");
  nonEmptyString(value.pinnedCoreRepository,
    "registryBinding.pinnedCoreRepository");
  if (!/^[a-f0-9]{40}$/u.test(value.pinnedCoreCommit || "")) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      "registryBinding.pinnedCoreCommit must be a full lowercase commit",
    );
  }
  nonEmptyString(value.pinnedCoreApiAbi,
    "registryBinding.pinnedCoreApiAbi");
}

function assertSourceBinding(value, sourceDocument, endpoint, {
  mode = "SOURCE_DOCUMENT",
  script = null,
} = {}) {
  plainObject(value, `${endpoint}.sourceBinding`);
  equal(value.sourceDocumentId, sourceDocument?.sourceDocumentId,
    `${endpoint}.sourceBinding.sourceDocumentId`);
  equalDigest(value.sourceContentSha256, sourceDocument?.contentHash,
    `${endpoint}.sourceBinding.sourceContentSha256`);
  equal(value.documentVersion, sourceDocument?.documentVersion,
    `${endpoint}.sourceBinding.documentVersion`);
  equal(value.locator, sourceDocument?.provenance?.locator,
    `${endpoint}.sourceBinding.locator`);
  equal(value.retrievedAt, sourceDocument?.provenance?.retrievedAt,
    `${endpoint}.sourceBinding.retrievedAt`);
  equal(value.mode, mode, `${endpoint}.sourceBinding.mode`);
  if (script === null) {
    equal(value.script, null, `${endpoint}.sourceBinding.script`);
  } else {
    plainObject(value.script, `${endpoint}.sourceBinding.script`);
  }
}

function validateResolvedSource(envelope, requestedPasscode) {
  const sourceDocument = envelope.result;
  plainObject(sourceDocument, "source.result");
  equal(sourceDocument.schemaVersion, "ocg-source-document/v1",
    "source.result.schemaVersion");
  equal(sourceDocument.sourceType, "LEGACY_SCRIPT",
    "source.result.sourceType");
  equal(sourceDocument.authority, "LEGACY_COMPATIBILITY",
    "source.result.authority");
  equal(sourceDocument.language, "lua", "source.result.language");
  nonEmptyString(sourceDocument.sourceDocumentId,
    "source.result.sourceDocumentId");
  nonEmptyString(sourceDocument.documentVersion,
    "source.result.documentVersion");
  if (typeof sourceDocument.content !== "string") {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      "source.result.content must be a string",
    );
  }
  equalDigest(
    sourceDocument.contentHash,
    rawSha256(sourceDocument.content),
    "source.result.contentHash",
  );
  plainObject(sourceDocument.provenance, "source.result.provenance");
  nonEmptyString(sourceDocument.provenance.locator,
    "source.result.provenance.locator");
  if (!Number.isFinite(new Date(sourceDocument.provenance.retrievedAt).getTime())) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      "source.result.provenance.retrievedAt must be a timestamp",
    );
  }
  assertSourceBinding(envelope.sourceBinding, sourceDocument, "source", {
    mode: "LOCKED_PASSCODE",
    script: "LOCKED_SCRIPT",
  });
  const boundPasscode = String(envelope.sourceBinding.script.passcode ?? "");
  if (Number(boundPasscode) !== Number(requestedPasscode)) {
    throw httpError(
      "LEGACY_LUA_HTTP_BINDING_INVALID",
      "source binding passcode does not match the requested passcode",
      { actual: boundPasscode, expected: requestedPasscode },
    );
  }
  equalDigest(
    envelope.sourceBinding.script.sha256,
    sourceDocument.contentHash,
    "source.sourceBinding.script.sha256",
  );
  return structuredClone(sourceDocument);
}

function validateEndpointManifest(value) {
  plainObject(value, "endpoints");
  const expected = [
    ["source", "POST", "source"],
    ["effectCandidates", "POST", "effectCandidates"],
    ["compilePlan", "POST", "compilePlan"],
    ["analyzeActivation", "POST", "analyzeActivation"],
  ];
  for (const [name, method, schemaName] of expected) {
    plainObject(value[name], `endpoints.${name}`);
    equal(value[name].path, LEGACY_LUA_HTTP_ENDPOINTS[name],
      `endpoints.${name}.path`);
    equal(value[name].method, method, `endpoints.${name}.method`);
    equal(value[name].responseSchemaVersion,
      LEGACY_LUA_HTTP_SCHEMAS[schemaName],
      `endpoints.${name}.responseSchemaVersion`);
  }
}

function normalizeEightDigitPasscode(value) {
  const text = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value).padStart(8, "0")
      : "";
  return PASSCODE.test(text) && Number(text) > 0 ? text : null;
}

function assertPayloadSize(value, limit, endpoint) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      `${endpoint} returned non-JSON data`,
    );
  }
  if (bytes > limit) {
    throw httpError(
      "LEGACY_LUA_HTTP_RESPONSE_TOO_LARGE",
      `${endpoint} response exceeds ${limit} UTF-8 bytes`,
      { endpoint, bytes, limit },
    );
  }
}

function equalCanonical(actual, expected, label) {
  equal(
    canonicalLegacyLuaSha256(actual),
    canonicalLegacyLuaSha256(expected),
    label,
  );
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      `${label} must be a plain object`,
    );
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(
      "LEGACY_LUA_HTTP_SCHEMA_INVALID",
      `${label} must be a non-empty string`,
    );
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw httpError(
      "LEGACY_LUA_HTTP_BINDING_INVALID",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
}

function equalDigest(actual, expected, label) {
  digest(actual, label);
  digest(expected, `${label}.expected`);
  equal(actual, expected, label);
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw httpError(
      "LEGACY_LUA_HTTP_BINDING_INVALID",
      `${label} is incompatible`,
      { actual, expected },
    );
  }
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function rawSha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function httpError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "LegacyLuaSemanticHttpError";
  error.code = code;
  error.details = details;
  return error;
}
