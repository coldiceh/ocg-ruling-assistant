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

async function parseJsonResponse(response, {
  maxResponseBytes,
  onLimitExceeded,
} = {}) {
  const limit = normalizeResponseByteLimit(maxResponseBytes);
  if (limit !== null) {
    const declaredLength = readDeclaredContentLength(response);
    if (declaredLength !== null && declaredLength > BigInt(limit)) {
      const error = responseTooLargeError({
        limit,
        bytes: declaredLength.toString(),
        source: "content-length",
      });
      await cancelResponseBody(response?.body, error);
      onLimitExceeded?.(error);
      throw error;
    }
  }
  const text = limit === null
    ? await response.text()
    : await readResponseTextWithLimit(response, limit, onLimitExceeded);
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
  maxResponseBytes,
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
    const payload = await parseJsonResponse(response, {
      maxResponseBytes,
      onLimitExceeded: (error) => controller.abort(error),
    });
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

async function readResponseTextWithLimit(response, limit, onLimitExceeded) {
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    // Some tests and fetch-compatible adapters expose only text(). Keep those
    // adapters working, while still enforcing the limit immediately after the
    // only available read primitive completes.
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limit) {
      const error = responseTooLargeError({
        limit,
        bytes,
        source: "text-fallback",
      });
      onLimitExceeded?.(error);
      throw error;
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = toUint8Array(value);
      bytes += chunk.byteLength;
      if (bytes > limit) {
        const error = responseTooLargeError({
          limit,
          bytes,
          source: "response-stream",
        });
        try {
          await reader.cancel(error);
        } catch {
          // The size error remains authoritative even if cancellation races
          // with a remote close.
        }
        onLimitExceeded?.(error);
        throw error;
      }
      chunks.push(Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      ));
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Releasing an already-cancelled reader is best effort only.
    }
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function normalizeResponseByteLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readDeclaredContentLength(response) {
  const raw = response?.headers?.get?.("content-length");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/u.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

async function cancelResponseBody(body, error) {
  if (!body || typeof body.cancel !== "function") return;
  try {
    await body.cancel(error);
  } catch {
    // The size error remains authoritative even if cancellation races with a
    // remote close.
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new TextEncoder().encode(String(value ?? ""));
}

function responseTooLargeError({ limit, bytes, source }) {
  const error = new Error(
    `engine response exceeds ${limit} UTF-8 bytes`,
  );
  error.code = "OCG_ENGINE_RESPONSE_TOO_LARGE";
  error.details = { limit, bytes, source };
  return error;
}
