import { requestOcgEngineJson } from "./ocgEngineHttpClient.mjs";
import {
  FormalContractError,
  assertRequiredCapabilities,
  createUnknownFormalResult,
  formalRequestSha256,
  validateFormalCapabilities,
  validateFormalResult,
  validateFormalScenario,
} from "./formalEngineSchemas.mjs";

const CAPABILITIES_PATH = "/formal/v1/capabilities";
const ANALYZE_PATH = "/formal/v1/analyze-scenario";

export async function getFormalEngineCapabilities({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
  expectedVersions,
  signal,
} = {}) {
  const transport = await requestOcgEngineJson({
    path: CAPABILITIES_PATH,
    method: "GET",
    env,
    fetchImpl,
    timeoutMs,
    defaultTimeoutMs: 5_000,
    fetchUnavailableError: "ENGINE_FORMAL_API_UNAVAILABLE",
    signal,
  });
  if (transport.status !== "response") {
    return {
      status: "unknown",
      capabilities: null,
      error: unavailableError(transport.error, "formal capability endpoint is unavailable"),
    };
  }
  if (!transport.responseOk || transport.payload?.ok !== true) {
    return {
      status: "unknown",
      capabilities: null,
      error: endpointError(transport, "formal capability endpoint rejected the request"),
    };
  }
  try {
    const capabilities = validateFormalCapabilities(transport.payload, {
      expectedVersions: expectedVersions || expectedVersionsFromEnv(env),
    });
    return { status: "ready", capabilities, error: null };
  } catch (error) {
    return { status: "unknown", capabilities: null, error: normalizedError(error) };
  }
}

export async function requestFormalScenarioAnalysis({
  formalScenario,
  negotiatedCapabilities,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
  expectedVersions,
  proofVerifier,
  proofVerifierTimeoutMs,
  signal,
} = {}) {
  if (formalScenario === undefined || formalScenario === null) {
    return { requested: false, status: "not_requested", formalResult: null, capabilities: null };
  }
  let scenario;
  try {
    scenario = validateFormalScenario(formalScenario);
  } catch (error) {
    return unknownResponse(formalScenario, normalizedError(error), null);
  }

  const negotiation = negotiatedCapabilities
    ? validateNegotiatedCapabilities(negotiatedCapabilities, { env, expectedVersions })
    : await getFormalEngineCapabilities({ env, fetchImpl, timeoutMs, expectedVersions, signal });
  if (negotiation.status !== "ready") return unknownResponse(scenario, negotiation.error, null);
  try {
    assertRequiredCapabilities(negotiation.capabilities, scenario.requiredCapabilities);
  } catch (error) {
    return unknownResponse(scenario, normalizedError(error), negotiation.capabilities);
  }

  const transport = await requestOcgEngineJson({
    path: ANALYZE_PATH,
    method: "POST",
    body: {
      scenario,
      bindings: {
        requestSha256: formalRequestSha256(scenario),
        capabilityManifestSha256: negotiation.capabilities.capabilityManifestSha256,
        definitionSnapshotSha256: scenario.definitionSnapshot.manifestSha256,
      },
    },
    env,
    fetchImpl,
    timeoutMs,
    defaultTimeoutMs: 20_000,
    fetchUnavailableError: "ENGINE_FORMAL_API_UNAVAILABLE",
    signal,
  });
  if (transport.status !== "response") {
    return unknownResponse(scenario, unavailableError(transport.error, "formal analysis endpoint is unavailable"), negotiation.capabilities);
  }
  if (!transport.responseOk || transport.payload?.ok !== true || !transport.payload?.result) {
    return unknownResponse(scenario, endpointError(transport, "formal analysis endpoint rejected the request"), negotiation.capabilities);
  }
  try {
    const formalResult = await validateFormalResult(structuredClone(transport.payload.result), {
      scenario,
      capabilities: negotiation.capabilities,
      proofVerifier,
      proofVerifierSignal: signal,
      proofVerifierTimeoutMs: resolveProofVerifierTimeoutMs(proofVerifierTimeoutMs, env),
    });
    return {
      requested: true,
      status: "completed",
      formalResult,
      capabilities: negotiation.capabilities,
      error: null,
    };
  } catch (error) {
    return unknownResponse(scenario, normalizedError(error), negotiation.capabilities);
  }
}

function resolveProofVerifierTimeoutMs(value, env) {
  const requested = Number(value ?? env.OCG_FORMAL_PROOF_VERIFIER_TIMEOUT_MS ?? 5_000);
  return Number.isInteger(requested) && requested > 0 ? requested : 5_000;
}

function validateNegotiatedCapabilities(capabilities, { env, expectedVersions }) {
  try {
    return {
      status: "ready",
      capabilities: validateFormalCapabilities(capabilities, {
        expectedVersions: expectedVersions || expectedVersionsFromEnv(env),
      }),
      error: null,
    };
  } catch (error) {
    return { status: "unknown", capabilities: null, error: normalizedError(error) };
  }
}

function unknownResponse(scenario, error, capabilities) {
  const normalized = normalizedError(error);
  return {
    requested: true,
    status: "unknown",
    formalResult: createUnknownFormalResult({
      scenario,
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    }),
    capabilities,
    error: normalized,
  };
}

function expectedVersionsFromEnv(env) {
  return Object.fromEntries([
    ["engineVersion", env.OCG_FORMAL_EXPECTED_ENGINE_VERSION],
    ["IRVersion", env.OCG_FORMAL_EXPECTED_IR_VERSION],
    ["rulesetVersion", env.OCG_FORMAL_EXPECTED_RULESET_VERSION],
    ["schemaVersion", env.OCG_FORMAL_EXPECTED_SCHEMA_VERSION],
    ["proofVerifierVersion", env.OCG_FORMAL_EXPECTED_PROOF_VERIFIER_VERSION],
  ].filter(([, value]) => String(value || "").trim()).map(([key, value]) => [key, String(value).trim()]));
}

function unavailableError(error, fallbackMessage) {
  return {
    code: "ENGINE_FORMAL_API_UNAVAILABLE",
    message: error?.message || fallbackMessage,
    details: error?.code ? { transportCode: error.code } : {},
  };
}

function endpointError(transport, fallbackMessage) {
  const source = transport.payload?.error;
  const remoteCode = typeof source?.code === "string" ? source.code : "";
  return {
    code: remoteCode === "CAPABILITY_UNAVAILABLE" ? remoteCode : "ENGINE_FORMAL_API_UNAVAILABLE",
    message: source?.message || fallbackMessage,
    details: { httpStatus: transport.httpStatus, remoteCode: remoteCode || null },
  };
}

function normalizedError(error) {
  if (error instanceof FormalContractError) {
    return { code: error.code, message: error.message, details: error.details || {} };
  }
  if (error && typeof error === "object" && typeof error.code === "string") {
    return {
      code: error.code,
      message: typeof error.message === "string" ? error.message : String(error),
      details: error.details && typeof error.details === "object" ? error.details : {},
    };
  }
  return { code: "ENGINE_FORMAL_API_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), details: {} };
}

export const FORMAL_ENGINE_ENDPOINTS = Object.freeze({
  capabilities: CAPABILITIES_PATH,
  analyzeScenario: ANALYZE_PATH,
});
