const TIMEOUT_HTTP_STATUSES = new Set([408, 504, 524]);
const ACCESS_DENIED_PATTERN = /(?:access(?:[_ -]?is)?[_ -]?denied|permission[_ -]?denied|forbidden|unauthori[sz]ed|无权访问|没有权限|权限不足|拒绝访问)/iu;
const TIMEOUT_PATTERN = /(?:timed[ _-]?out|timeout|etimedout|und_err_(?:headers|body)_timeout|超时)/iu;

export class RelayTransportError extends Error {
  constructor(message, {
    code = "relay_transport_error",
    status = null,
    failureKind = "provider_failure",
    outcomeKnown = false,
    responseBody = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RelayTransportError";
    this.code = code;
    this.status = status;
    this.failureKind = failureKind;
    this.outcomeKnown = outcomeKnown === true;
    this.budgetReservationMayExist = !this.outcomeKnown;
    this.budgetReservationReleaseSafe = this.outcomeKnown;
    this.responseBody = responseBody;
  }
}

export async function requestRelayChatCompletionSse({
  fetchImpl = globalThis.fetch,
  endpoint,
  apiKey,
  body = {},
  env = globalThis.process?.env || {},
  signal,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("relay stream transport requires fetch");
  const key = String(apiKey || "").trim();
  if (!key) throw new TypeError("relay stream transport requires a server-side API key");
  const url = normalizeEndpoint(endpoint);
  const requestBody = {
    ...(isPlainObject(body) ? body : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
  const timeoutMs = boundedInteger(env.RELAY_STREAM_TIMEOUT_MS, 270000, 1000, 270000);
  const maxBytes = boundedInteger(env.RELAY_STREAM_MAX_BYTES, 16 * 1024 * 1024, 1024, 32 * 1024 * 1024);
  const maxContentBytes = boundedInteger(env.RELAY_STREAM_MAX_CONTENT_BYTES, 1024 * 1024, 1024, 4 * 1024 * 1024);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener?.("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("relay stream timed out")), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await readResponsePayload(response);
      const outcomeKnown = isProvableRejection(response.status);
      const failureKind = classifyFailure({
        status: response.status,
        code: payload?.error?.code || payload?.error?.type,
        message: typeof payload?.error === "string" ? payload.error : payload?.error?.message,
      });
      throw new RelayTransportError(`relay HTTP ${response.status}`, {
        code: failureKind === "access_denied" ? "relay_http_access_denied"
          : failureKind === "timeout" ? "relay_http_timeout"
            : "relay_http_error",
        status: response.status,
        failureKind,
        outcomeKnown,
        responseBody: payload,
      });
    }
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      throw new RelayTransportError("relay stream returned an unsupported content type", {
        code: "relay_stream_content_type_invalid",
        status: response.status,
      });
    }
    return await readStream(response, {
      signal: controller.signal,
      maxBytes,
      maxContentBytes,
    });
  } catch (cause) {
    if (cause instanceof RelayTransportError) throw cause;
    const failureKind = isTimeout(cause) || isTimeout(controller.signal.reason)
      ? "timeout"
      : "provider_failure";
    throw new RelayTransportError(
      failureKind === "timeout"
        ? "relay stream timed out after submission"
        : "relay stream ended unexpectedly after submission",
      {
        code: failureKind === "timeout" ? "relay_stream_timeout" : "relay_stream_interrupted",
        status: response?.status ?? null,
        failureKind,
        outcomeKnown: false,
        cause,
      },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}

async function readStream(response, { signal, maxBytes, maxContentBytes }) {
  const reader = response.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") {
    throw new RelayTransportError("relay stream body is unavailable", {
      code: "relay_stream_body_unavailable",
      status: response?.status ?? null,
    });
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = {
    totalBytes: 0,
    contentBytes: 0,
    content: "",
    contentChunks: 0,
    completionChunks: 0,
    eventCount: 0,
    finishReason: "",
    model: "",
    id: "",
    systemFingerprint: "",
    usage: {},
    usageSeen: false,
    doneMarker: false,
  };
  const protocolError = (message, code = "relay_stream_protocol_error", cause) => (
    new RelayTransportError(message, {
      code,
      status: response?.status ?? null,
      failureKind: "provider_failure",
      outcomeKnown: false,
      cause,
    })
  );
  const processFrame = (rawFrame) => {
    const frame = String(rawFrame || "");
    if (!frame.trim()) return;
    if (state.doneMarker) {
      throw protocolError("relay stream contained data after [DONE]");
    }
    const dataLines = [];
    let eventName = "";
    for (const line of frame.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = (separator === -1 ? line : line.slice(0, separator)).trim();
      const rawValue = separator === -1 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "data") dataLines.push(value);
      else if (field === "event") eventName = value.trim().toLowerCase();
      else if (!["id", "retry"].includes(field)) {
        throw protocolError(`relay stream used unsupported SSE field ${field || "missing"}`);
      }
    }
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    if (data === "[DONE]") {
      state.doneMarker = true;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch (cause) {
      throw protocolError("relay stream contained malformed JSON", "relay_stream_json_invalid", cause);
    }
    if (!isPlainObject(payload)) {
      throw protocolError("relay stream chunk must be a JSON object");
    }
    const embeddedError = relayStreamEmbeddedError(payload, eventName);
    if (embeddedError) {
      const generatedBeforeError = state.completionChunks > 0
        || state.contentBytes > 0
        || state.usageSeen
        || relayChunkContainsCompletionOrUsage(payload);
      const releaseSafe = embeddedError.failureKind === "access_denied" && !generatedBeforeError;
      throw new RelayTransportError(
        embeddedError.failureKind === "access_denied"
          ? "relay upstream denied model access"
          : embeddedError.failureKind === "timeout"
            ? "relay upstream timed out during stream"
            : "relay upstream rejected the stream request",
        {
          code: embeddedError.failureKind === "access_denied"
            ? "relay_stream_access_denied"
            : embeddedError.failureKind === "timeout"
              ? "relay_stream_timeout"
              : "relay_stream_upstream_error",
          status: response?.status ?? null,
          failureKind: embeddedError.failureKind,
          outcomeKnown: releaseSafe,
        },
      );
    }
    state.eventCount += 1;
    if (state.eventCount > 250_000) {
      throw protocolError("relay stream exceeded the event limit");
    }
    state.id = mergeStableStreamIdentity(
      state.id,
      optionalBoundedString(payload.id, "relay stream id", 512, protocolError),
      "id",
      protocolError,
    );
    state.model = mergeStableStreamIdentity(
      state.model,
      optionalBoundedString(payload.model, "relay stream model", 256, protocolError),
      "model",
      protocolError,
    );
    state.systemFingerprint = mergeStableStreamIdentity(
      state.systemFingerprint,
      optionalBoundedString(
        payload.system_fingerprint,
        "relay stream system_fingerprint",
        512,
        protocolError,
      ),
      "system_fingerprint",
      protocolError,
    );
    if (payload.usage !== undefined && payload.usage !== null) {
      state.usage = sanitizeRelayStreamUsage(payload.usage, protocolError);
      state.usageSeen = true;
    }
    if (payload.choices === undefined) return;
    if (!Array.isArray(payload.choices) || payload.choices.length > 16) {
      throw protocolError("relay stream choices must be a bounded array");
    }
    for (const choice of payload.choices) {
      if (!isPlainObject(choice) || choice.index !== 0) {
        throw protocolError("relay stream must contain only choice index 0");
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.finishReason = mergeStableStreamIdentity(
          state.finishReason,
          optionalBoundedString(
            choice.finish_reason,
            "relay stream finish_reason",
            128,
            protocolError,
          ),
          "finish_reason",
          protocolError,
        );
      }
      const completion = choice.delta !== undefined && choice.delta !== null
        ? choice.delta
        : choice.message;
      if (completion === undefined || completion === null) continue;
      if (!isPlainObject(completion)) {
        throw protocolError(choice.delta !== undefined
          ? "relay stream delta must be an object"
          : "relay stream message must be an object");
      }
      state.completionChunks += 1;
      for (const reasoningField of ["reasoning_content", "reasoning"]) {
        const reasoning = completion[reasoningField];
        if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") {
          throw protocolError(`relay stream ${reasoningField} must be text when present`);
        }
        // Reasoning is intentionally validated but never returned or logged.
      }
      if ((Array.isArray(completion.tool_calls) && completion.tool_calls.length)
          || completion.function_call) {
        throw protocolError("relay final stream must not contain tool calls");
      }
      const delta = completion.content;
      if (delta === undefined || delta === null || delta === "") continue;
      if (typeof delta !== "string") {
        throw protocolError("relay stream content must be text");
      }
      state.contentBytes += encoder.encode(delta).byteLength;
      if (state.contentBytes > maxContentBytes) {
        throw protocolError(
          "relay content exceeded maximum byte size",
          "relay_stream_content_too_large",
        );
      }
      state.content += delta;
      state.contentChunks += 1;
    }
  };
  const processBufferedFrames = ({ flush = false } = {}) => {
    while (true) {
      const match = /\r?\n\r?\n/u.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      processFrame(frame);
    }
    if (flush && buffer.trim()) {
      processFrame(buffer);
      buffer = "";
    }
    if (encoder.encode(buffer).byteLength > Math.min(maxBytes, 2 * 1024 * 1024)) {
      throw protocolError("relay stream event exceeded maximum byte size", "relay_stream_event_too_large");
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error("relay stream aborted");
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw protocolError("relay stream yielded a non-byte chunk");
      }
      state.totalBytes += chunk.value.byteLength;
      if (state.totalBytes > maxBytes) {
        throw protocolError("relay stream exceeded maximum byte size", "relay_stream_too_large");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      processBufferedFrames();
    }
    buffer += decoder.decode();
    processBufferedFrames({ flush: true });
  } catch (cause) {
    if (cause instanceof RelayTransportError) throw cause;
    const failureKind = isTimeout(cause) || isTimeout(signal?.reason)
      ? "timeout"
      : "provider_failure";
    throw new RelayTransportError(
      failureKind === "timeout"
        ? "relay stream timed out after submission"
        : "relay stream ended unexpectedly after submission",
      {
        code: failureKind === "timeout" ? "relay_stream_timeout" : "relay_stream_interrupted",
        status: response?.status ?? null,
        failureKind,
        outcomeKnown: false,
        cause,
      },
    );
  } finally {
    try { reader.releaseLock?.(); } catch { /* Best-effort cleanup only. */ }
  }

  if (!state.doneMarker) {
    throw protocolError("relay stream closed without [DONE]", "relay_stream_incomplete");
  }
  if (!state.eventCount) {
    throw protocolError("relay stream completed without any JSON chunk", "relay_stream_empty");
  }
  if (!state.completionChunks) {
    throw protocolError(
      "relay stream completed without a supported completion payload",
      "relay_stream_completion_missing",
    );
  }
  if (!state.content.trim()) {
    throw protocolError(
      "relay stream completed without visible assistant content",
      "relay_stream_empty_content",
    );
  }
  return {
    ...(state.id ? { id: state.id } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.systemFingerprint
      ? { system_fingerprint: state.systemFingerprint }
      : {}),
    usage: state.usage,
    choices: [{
      index: 0,
      message: { role: "assistant", content: state.content },
      finish_reason: state.finishReason || null,
    }],
    stream_metrics: {
      totalBytes: state.totalBytes,
      contentBytes: state.contentBytes,
      doneMarker: state.doneMarker,
      eventCount: state.eventCount,
      contentChunkCount: state.contentChunks,
    },
  };
}

async function readResponsePayload(response) {
  try {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 1000) } }; }
  } catch {
    return null;
  }
}

function normalizeEndpoint(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { throw new TypeError("relay endpoint must be a valid HTTPS URL"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("relay endpoint must be a credential-free HTTPS URL");
  }
  return parsed.toString();
}

function classifyFailure({ status, code, message }) {
  const text = `${code || ""} ${message || ""}`;
  if ([401, 403].includes(Number(status)) || ACCESS_DENIED_PATTERN.test(text)) return "access_denied";
  if (TIMEOUT_HTTP_STATUSES.has(Number(status)) || TIMEOUT_PATTERN.test(text)) return "timeout";
  return "provider_failure";
}

function isProvableRejection(status) {
  const value = Number(status);
  return Number.isInteger(value)
    && value >= 400
    && value < 500
    && ![408, 409, 425, 429].includes(value);
}

function isTimeout(value) {
  const code = value instanceof Error ? value.code : value?.code;
  const message = value instanceof Error ? value.message : value;
  return TIMEOUT_PATTERN.test(`${String(code || "")} ${String(message || "")}`);
}

function relayStreamEmbeddedError(payload, eventName = "") {
  const type = String(payload?.type || "").trim().toLowerCase();
  const explicitError = payload?.error !== undefined && payload?.error !== null;
  const source = payload?.error ?? payload?.response?.error ?? payload;
  const message = typeof source === "string"
    ? source
    : String(source?.message || source?.code || type || eventName || "unknown upstream error");
  const code = typeof source === "object" && source !== null
    ? String(source.code || source.type || payload?.code || "")
    : String(payload?.code || "");
  const rawStatus = typeof source === "object" && source !== null
    ? source.status ?? source.status_code ?? payload?.status
    : payload?.status;
  const status = Number(rawStatus);
  const failureKind = classifyFailure({
    status: Number.isInteger(status) ? status : null,
    code,
    message,
  });
  const errorLike = eventName === "error"
    || type === "error"
    || type === "response.failed"
    || explicitError
    || failureKind !== "provider_failure";
  return errorLike ? { failureKind } : null;
}

function relayChunkContainsCompletionOrUsage(payload) {
  if (payload?.usage !== undefined && payload?.usage !== null) return true;
  return (Array.isArray(payload?.choices) ? payload.choices : []).some((choice) => (
    choice?.delta !== undefined && choice?.delta !== null
  ) || (
    choice?.message !== undefined && choice?.message !== null
  ));
}

function mergeStableStreamIdentity(previous, next, field, protocolError) {
  if (!next) return previous;
  if (previous && previous !== next) {
    throw protocolError(`relay stream changed ${field} between chunks`);
  }
  return previous || next;
}

function optionalBoundedString(value, field, maximumLength, protocolError) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw protocolError(`${field} must be non-empty text within ${maximumLength} characters`);
  }
  return value.trim();
}

function sanitizeRelayStreamUsage(value, protocolError) {
  if (!isPlainObject(value)) throw protocolError("relay stream usage must be an object");
  const result = {};
  for (const field of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "cache_write_tokens",
  ]) {
    if (value[field] === undefined) continue;
    if (!Number.isFinite(value[field]) || value[field] < 0) {
      throw protocolError(`relay stream usage.${field} must be a non-negative number`);
    }
    result[field] = value[field];
  }
  for (const [field, allowed] of Object.entries({
    prompt_tokens_details: [
      "cached_tokens",
      "cache_read_input_tokens",
      "cache_write_input_tokens",
      "cache_write_tokens",
    ],
    completion_tokens_details: ["reasoning_tokens"],
    input_tokens_details: [
      "cached_tokens",
      "cache_read_input_tokens",
      "cache_write_input_tokens",
      "cache_write_tokens",
    ],
    output_tokens_details: ["reasoning_tokens"],
  })) {
    if (value[field] === undefined || value[field] === null) continue;
    if (!isPlainObject(value[field])) {
      throw protocolError(`relay stream usage.${field} must be an object`);
    }
    const details = {};
    for (const detail of allowed) {
      if (value[field][detail] === undefined) continue;
      if (!Number.isFinite(value[field][detail]) || value[field][detail] < 0) {
        throw protocolError(`relay stream usage.${field}.${detail} must be a non-negative number`);
      }
      details[detail] = value[field][detail];
    }
    result[field] = details;
  }
  return result;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`relay stream limit must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
