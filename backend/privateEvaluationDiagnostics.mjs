import { randomInt } from "node:crypto";

const DIAGNOSTIC_KIND = "private_evaluation_stage";
const ALLOWED_STAGES = new Set([
  "data_load",
  "extraction",
  "retrieval",
  "prompt_build",
  "relay",
  "total",
]);
const ALLOWED_EVENTS = new Set([
  "start",
  "end",
  "fail",
  "relay_dispatch",
  "relay_complete",
  "relay_fail",
]);
const ALLOWED_FAILURE_KINDS = new Set([
  "aborted",
  "timeout",
  "network",
  "provider",
  "unexpected",
]);
const CASE_TRACE_ID = /^case-\d{3}$/u;

/**
 * Opt-in diagnostics for encrypted private-evaluation logs only.
 *
 * The writer receives a pre-serialized JSONL line. Callers cannot add fields:
 * the emitter below constructs every record from a fixed allowlist and never
 * accepts questions, card identities, evidence, URLs, prompts, responses,
 * hashes or error messages.
 */
export function createPrivateEvaluationDiagnostics({
  env = globalThis.process?.env || {},
  traceId,
  write = (line) => console.log(line),
  createRandomTraceId = defaultRandomTraceId,
} = {}) {
  if (!isEnabled(env.PRIVATE_EVALUATION_DIAGNOSTICS)) {
    return Object.freeze({ enabled: false });
  }
  const requestedTraceId = String(traceId || "").trim();
  const safeTraceId = CASE_TRACE_ID.test(requestedTraceId)
    ? requestedTraceId
    : normalizeRandomTraceId(createRandomTraceId());
  return Object.freeze({
    enabled: true,
    traceId: safeTraceId,
    write: typeof write === "function" ? write : () => {},
  });
}

export function emitPrivateEvaluationDiagnostic(context, {
  stage,
  event,
  durationMs,
  failureKind,
} = {}) {
  if (context?.enabled !== true) return;
  if (!ALLOWED_STAGES.has(stage) || !ALLOWED_EVENTS.has(event)) return;

  const record = {
    schemaVersion: 1,
    kind: DIAGNOSTIC_KIND,
    traceId: context.traceId,
    stage,
    event,
  };
  if (Number.isFinite(durationMs)) {
    record.durationMs = Math.max(0, Math.round(durationMs));
  }
  if (ALLOWED_FAILURE_KINDS.has(failureKind)) {
    record.failureKind = failureKind;
  }
  try {
    context.write(JSON.stringify(record));
  } catch {
    // Diagnostics must never change an answer or turn a successful evaluation
    // into a failure merely because stdout is unavailable.
  }
}

export function beginPrivateEvaluationStage(context, stage) {
  const startedAt = Date.now();
  let completed = false;
  emitPrivateEvaluationDiagnostic(context, { stage, event: "start" });
  return Object.freeze({
    end() {
      if (completed) return;
      completed = true;
      emitPrivateEvaluationDiagnostic(context, {
        stage,
        event: "end",
        durationMs: Date.now() - startedAt,
      });
    },
    fail(error) {
      if (completed) return;
      completed = true;
      emitPrivateEvaluationDiagnostic(context, {
        stage,
        event: "fail",
        durationMs: Date.now() - startedAt,
        failureKind: classifyPrivateEvaluationFailure(error),
      });
    },
  });
}

export function classifyPrivateEvaluationFailure(error) {
  const chain = errorCauseChain(error);
  if (chain.some(isTimeoutFailure)) return "timeout";
  if (chain.some((item) => {
    const name = String(item?.name || "").toLowerCase();
    const code = String(item?.code || "").toUpperCase();
    return name === "aborterror" || code === "ABORT_ERR";
  })) return "aborted";
  if (chain.some((item) => [
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
  ].includes(String(item?.code || "").toUpperCase()))) return "network";
  if (chain.some((item) => Number.isFinite(item?.status) || Number.isFinite(item?.statusCode))) {
    return "provider";
  }
  return "unexpected";
}

export function privateEvaluationFailureChain(error) {
  return errorCauseChain(error);
}

export function isPrivateEvaluationTimeout(error) {
  return errorCauseChain(error).some(isTimeoutFailure);
}

function errorCauseChain(error) {
  const chain = [];
  const visited = new Set();
  let current = error;
  while (current && (typeof current === "object" || typeof current === "function")
    && !visited.has(current) && chain.length < 8) {
    visited.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isTimeoutFailure(error) {
  const name = String(error?.name || "").trim().toLowerCase();
  const code = String(error?.code || "").trim().toLowerCase();
  const message = String(error?.message || "");
  return name === "timeouterror"
    || code === "etimedout"
    || code === "und_err_connect_timeout"
    || code === "und_err_headers_timeout"
    || code === "und_err_body_timeout"
    || /(?:^|[_-])timeout(?:$|[_-])/u.test(code)
    || /(?:timed out|timeout|exceeded\s+\d+ms|etimedout|und_err_(?:connect|headers|body)_timeout)/iu.test(message);
}

function normalizeRandomTraceId(value) {
  const normalized = String(value || "").trim();
  if (/^private-[a-z0-9-]{6,48}$/u.test(normalized)) return normalized;
  return defaultRandomTraceId();
}

function defaultRandomTraceId() {
  const part = () => randomInt(36 ** 5).toString(36).padStart(5, "0");
  return `private-${part()}-${part()}`;
}

function isEnabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}
