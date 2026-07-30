const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function readRequestBody(request, {
  maxBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const byteLimit = Number(maxBytes);
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  return new Promise((resolve, reject) => {
    const declaredBytes = readDeclaredContentLength(request);
    if (declaredBytes !== null && declaredBytes > byteLimit) {
      pauseRequest(request);
      reject(bodyTooLargeError({
        declaredBytes,
        maxBytes: byteLimit,
      }));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const removeListener = (eventName, listener) => {
      if (typeof request?.off === "function") request.off(eventName, listener);
      else if (typeof request?.removeListener === "function") {
        request.removeListener(eventName, listener);
      }
    };
    const cleanup = () => {
      removeListener("data", onData);
      removeListener("end", onEnd);
      removeListener("error", onError);
      removeListener("aborted", onAborted);
    };
    const fail = (error, { pause = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      if (pause) pauseRequest(request);
      reject(error);
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > byteLimit) {
        fail(bodyTooLargeError({
          receivedBytes: totalBytes,
          maxBytes: byteLimit,
        }), { pause: true });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error) => {
      fail(error);
    };
    const onAborted = () => {
      const error = new Error("request body stream was aborted");
      error.code = "request_body_aborted";
      fail(error);
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function readDeclaredContentLength(request) {
  const headers = request?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("content-length")
    : headers?.["content-length"] ?? headers?.["Content-Length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}

function pauseRequest(request) {
  if (typeof request?.pause === "function") request.pause();
}

function bodyTooLargeError(details) {
  const error = new Error("request body exceeds the configured byte limit");
  error.code = "request_body_too_large";
  error.details = details;
  return error;
}
