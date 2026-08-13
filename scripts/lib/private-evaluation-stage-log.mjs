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

/**
 * Project a backend log into an anonymous, fixed-schema stage timeline.
 * Raw lines, trace IDs, unknown fields and parse failures are never returned.
 */
export function projectPrivateEvaluationStageLog(source) {
  const events = [];
  for (const line of String(source || "").split(/\r?\n/u)) {
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) continue;
    let value;
    try {
      value = JSON.parse(line.slice(jsonStart));
    } catch {
      continue;
    }
    if (value?.schemaVersion !== 1 || value?.kind !== "private_evaluation_stage") continue;
    if (!/^case-\d{3}$/u.test(String(value.traceId || ""))) continue;
    if (!ALLOWED_STAGES.has(value.stage) || !ALLOWED_EVENTS.has(value.event)) continue;
    const event = {
      schemaVersion: 1,
      kind: "private_evaluation_stage",
      stage: value.stage,
      event: value.event,
    };
    if (Number.isFinite(value.durationMs) && value.durationMs >= 0) {
      event.durationMs = Math.round(value.durationMs);
    }
    if (ALLOWED_FAILURE_KINDS.has(value.failureKind)) event.failureKind = value.failureKind;
    events.push(event);
  }
  return events;
}
