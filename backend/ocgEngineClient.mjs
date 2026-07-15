const SHA256 = /^[a-f0-9]{64}$/u;
const RESOURCE_FIELDS = ["lockId", "snapshotId", "manifestSha256", "coreSha256", "dbSetSha256", "scriptSetSha256", "patchSetSha256"];

function cleanBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/u, "");
  if (!text) return "";
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("OCG_ENGINE_URL must use http or https");
  return url.toString().replace(/\/+$/u, "");
}

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

function safeFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "OCG_ENGINE_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("engine returned invalid JSON");
  }
}

export async function requestOcgEngineSimulation({
  engineScenario,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  if (engineScenario === undefined || engineScenario === null) return { requested: false, status: "not_requested" };
  let baseUrl;
  try {
    baseUrl = cleanBaseUrl(env.OCG_ENGINE_URL);
  } catch (error) {
    return { requested: true, status: "unavailable", error: safeFailure(error) };
  }
  if (!baseUrl) {
    return { requested: true, status: "disabled", error: { code: "OCG_ENGINE_NOT_CONFIGURED", message: "OCG_ENGINE_URL is not configured" } };
  }
  if (typeof fetchImpl !== "function") {
    return { requested: true, status: "unavailable", error: { code: "OCG_ENGINE_FETCH_UNAVAILABLE", message: "fetch is unavailable" } };
  }

  const controller = new AbortController();
  const timeout = Number(timeoutMs || env.OCG_ENGINE_TIMEOUT_MS || 20_000);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeout) ? timeout : 20_000);
  timer.unref?.();
  try {
    const headers = { "content-type": "application/json" };
    if (env.OCG_ENGINE_TOKEN) headers.authorization = "Bearer " + env.OCG_ENGINE_TOKEN;
    const response = await fetchImpl(baseUrl + "/simulate", {
      method: "POST",
      headers,
      body: JSON.stringify({ scenario: engineScenario }),
      signal: controller.signal,
    });
    const payload = await parseResponse(response);
    if (!response.ok || payload.ok !== true) {
      const error = new Error(payload?.error?.message || "engine request failed with HTTP " + response.status);
      error.code = payload?.error?.code || "OCG_ENGINE_HTTP_ERROR";
      throw error;
    }
    return { requested: true, status: "completed", simulation: validateSimulation(payload.simulation) };
  } catch (error) {
    return { requested: true, status: "unavailable", error: safeFailure(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getOcgEngineHealth({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 3_000,
} = {}) {
  let baseUrl;
  try {
    baseUrl = cleanBaseUrl(env.OCG_ENGINE_URL);
  } catch (error) {
    return { ok: false, status: "unavailable", error: safeFailure(error) };
  }
  if (!baseUrl) return { ok: false, status: "disabled" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers = {};
    if (env.OCG_ENGINE_TOKEN) headers.authorization = "Bearer " + env.OCG_ENGINE_TOKEN;
    const response = await fetchImpl(baseUrl + "/health", { headers, signal: controller.signal });
    const payload = await parseResponse(response);
    return response.ok && payload.ok === true
      ? { ...payload, status: "ready" }
      : { ok: false, status: "unavailable", error: payload.error || { code: "OCG_ENGINE_HEALTH_FAILED" } };
  } catch (error) {
    return { ok: false, status: "unavailable", error: safeFailure(error) };
  } finally {
    clearTimeout(timer);
  }
}
