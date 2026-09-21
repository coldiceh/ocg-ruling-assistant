import { setTimeout as delay } from "node:timers/promises";

export function embeddingHttpDiagnostic(response, raw, now = Date.now()) {
  const details = Array.isArray(raw?.error?.details) ? raw.error.details : [];
  const retry = details.find(d => String(d?.["@type"] || "").endsWith("google.rpc.RetryInfo"));
  const seconds = typeof retry?.retryDelay === "string" && /^\d+(?:\.\d+)?s$/.test(retry.retryDelay)
    ? Number(retry.retryDelay.slice(0, -1)) : 0;
  const header = response.headers?.get?.("retry-after");
  const headerMs = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
    : header ? Math.max(0, Date.parse(header) - now) : 0;
  const quota = details.find(d => String(d?.["@type"] || "").endsWith("google.rpc.QuotaFailure"));
  const quotas = (Array.isArray(quota?.violations) ? quota.violations : []).map(v => ({
    quotaMetric: String(v.quotaMetric || ""), quotaId: String(v.quotaId || ""),
  }));
  return { httpStatus: response.status, status: String(raw?.error?.status || ""),
    retryAfterMs: Math.max(seconds * 1000, Number.isFinite(headerMs) ? headerMs : 0),
    quotas, dailyQuota: quotas.some(q => /per.?day|daily/i.test(q.quotaMetric + q.quotaId)) };
}

export function createRetryingGeminiEmbeddingTransport({ apiKey, fetchImpl = globalThis.fetch,
  sleep = delay, now = Date.now, random = Math.random, minIntervalMs = 4000,
  maxRetries = 6, maxRetryWaitMs = 600000, timeoutMs = 120000,
  onRetry = () => {},
} = {}) {
  if (!apiKey) throw new Error("gemini_embedding_api_key_required");
  let lastStart = null;
  return async (texts, profile) => {
    const body = JSON.stringify({ requests: texts.map(text => ({
      model: `models/${profile.model}`, content: { parts: [{ text }] },
      embedContentConfig: { outputDimensionality: profile.dimension, autoTruncate: profile.autoTruncate },
    })) });
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      if (lastStart !== null) {
        const remaining = minIntervalMs - (now() - lastStart);
        if (remaining > 0) await sleep(remaining);
      }
      lastStart = now();
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:batchEmbedContents`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body, signal: AbortSignal.timeout(timeoutMs),
      });
      // A broken response body after HTTP 200 remains an unknown submitted request.
      const raw = await response.json().catch(error => {
        if (response.ok) throw error;
        return null;
      });
      if (response.ok) return raw;
      const diagnostic = embeddingHttpDiagnostic(response, raw, now());
      const rejected = response.status === 429;
      const pause = Math.max(diagnostic.retryAfterMs,
        Math.min(60000, 2000 * 2 ** attempt) + Math.floor(random() * 1000));
      if (rejected && !diagnostic.dailyQuota && attempt < maxRetries && waited + pause <= maxRetryWaitMs) {
        onRetry({ attempt: attempt + 1, waitMs: pause, ...diagnostic });
        await profile.onRejectedAttempt?.(diagnostic);
        await sleep(pause); waited += pause;
        continue;
      }
      const error = Object.assign(new Error(`gemini_embedding_http_${response.status}`), {
        exitCode: 4, responseDiagnostic: diagnostic, requestRejected: rejected,
      });
      if (rejected) await profile.onRejectedAttempt?.(diagnostic);
      throw error;
    }
  };
}
