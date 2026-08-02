export function toOcgEngineFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "OCG_ENGINE_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function resolveOcgEngineBaseUrl({
  env = globalThis.process?.env || {},
  baseUrl = env.OCG_ENGINE_URL,
} = {}) {
  const text = String(baseUrl || "").trim().replace(/\/+$/u, "");
  if (!text) return "";
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("OCG_ENGINE_URL must use http or https");
  }
  return url.toString().replace(/\/+$/u, "");
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("engine returned invalid JSON");
  }
}

function resolveTimeout({ timeoutMs, env, defaultTimeoutMs }) {
  const fallback = Number.isFinite(Number(defaultTimeoutMs)) ? Number(defaultTimeoutMs) : 20_000;
  const requested = Number(timeoutMs || env.OCG_ENGINE_TIMEOUT_MS || fallback);
  return Number.isFinite(requested) ? requested : fallback;
}

export async function requestOcgEngineJson({
  path,
  method = "GET",
  body,
  headers: suppliedHeaders,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
  defaultTimeoutMs = 20_000,
  fetchUnavailableError,
  signal,
} = {}) {
  let baseUrl;
  try {
    baseUrl = resolveOcgEngineBaseUrl({ env });
  } catch (error) {
    return { status: "unavailable", error: toOcgEngineFailure(error) };
  }
  if (!baseUrl) {
    return {
      status: "disabled",
      error: { code: "OCG_ENGINE_NOT_CONFIGURED", message: "OCG_ENGINE_URL is not configured" },
    };
  }
  if (typeof fetchImpl !== "function") {
    const error = fetchUnavailableError || new TypeError("fetchImpl is not a function");
    return { status: "unavailable", error: toOcgEngineFailure(error) };
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return {
      status: "unavailable",
      error: { code: "OCG_ENGINE_PATH_INVALID", message: "engine request path must start with one slash" },
    };
  }

  const controller = new AbortController();
  const timeout = resolveTimeout({ timeoutMs, env, defaultTimeoutMs });
  const timer = setTimeout(() => controller.abort(), timeout);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  timer.unref?.();
  try {
    const headers = { ...(suppliedHeaders || {}) };
    if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    if (env.OCG_ENGINE_TOKEN) headers.authorization = "Bearer " + env.OCG_ENGINE_TOKEN;
    const response = await fetchImpl(baseUrl + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = await parseJsonResponse(response);
    return {
      status: "response",
      ok: response.ok && payload?.ok === true,
      responseOk: response.ok,
      httpStatus: response.status,
      payload,
    };
  } catch (error) {
    return { status: "unavailable", error: toOcgEngineFailure(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}
