import { requestOcgEngineJson, toOcgEngineFailure } from "./ocgEngineHttpClient.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const RESOURCE_FIELDS = ["lockId", "snapshotId", "manifestSha256", "coreSha256", "dbSetSha256", "scriptSetSha256", "patchSetSha256"];

function validateSimulation(value) {
  if (!value || typeof value !== "object") throw new Error("engine returned no simulation");
  if (value.sourceType !== "engine_simulation") throw new Error("engine returned an invalid source type");
  if (value.canConfirmOfficialRuling !== false) throw new Error("engine violated the non-official evidence contract");
  if (!value.resourceBinding || typeof value.resourceBinding !== "object") throw new Error("engine omitted its resource binding");
  for (const field of RESOURCE_FIELDS) {
    if (!SHA256.test(String(value.resourceBinding[field] || ""))) throw new Error("engine resource binding is invalid: " + field);
  }
  if (typeof value.resourceBinding.apiAbi !== "string" || !value.resourceBinding.apiAbi) throw new Error("engine resource binding is missing apiAbi");
  if (!SHA256.test(String(value.traceSha256 || ""))) throw new Error("engine trace digest is invalid");
  return value;
}

export async function requestOcgEngineSimulation({
  engineScenario,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  if (engineScenario === undefined || engineScenario === null) return { requested: false, status: "not_requested" };
  const fetchUnavailableError = new Error("fetch is unavailable");
  fetchUnavailableError.code = "OCG_ENGINE_FETCH_UNAVAILABLE";
  const transport = await requestOcgEngineJson({
    path: "/simulate",
    method: "POST",
    body: { scenario: engineScenario },
    env,
    fetchImpl,
    timeoutMs,
    defaultTimeoutMs: 20_000,
    fetchUnavailableError,
  });
  if (transport.status !== "response") {
    return { requested: true, status: transport.status, error: transport.error };
  }
  try {
    if (!transport.ok) {
      const error = new Error(transport.payload?.error?.message || "engine request failed with HTTP " + transport.httpStatus);
      error.code = transport.payload?.error?.code || "OCG_ENGINE_HTTP_ERROR";
      throw error;
    }
    return { requested: true, status: "completed", simulation: validateSimulation(transport.payload.simulation) };
  } catch (error) {
    return { requested: true, status: "unavailable", error: toOcgEngineFailure(error) };
  }
}

export async function getOcgEngineHealth({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 3_000,
} = {}) {
  const transport = await requestOcgEngineJson({
    path: "/health",
    env,
    fetchImpl,
    timeoutMs,
    defaultTimeoutMs: 3_000,
  });
  if (transport.status === "disabled") return { ok: false, status: "disabled" };
  if (transport.status !== "response") {
    return { ok: false, status: "unavailable", error: transport.error };
  }
  return transport.ok
    ? { ...transport.payload, status: "ready" }
    : { ok: false, status: "unavailable", error: transport.payload.error || { code: "OCG_ENGINE_HEALTH_FAILED" } };
}
