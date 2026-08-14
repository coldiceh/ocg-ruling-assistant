import assert from "node:assert/strict";
import test from "node:test";

import { projectPrivateEvaluationStageLog } from "../scripts/lib/private-evaluation-stage-log.mjs";

test("private evaluation stage projection emits only the anonymous allowlist", () => {
  const source = [
    "server startup with private data",
    JSON.stringify({
      schemaVersion: 1,
      kind: "private_evaluation_stage",
      traceId: "case-001",
      stage: "relay",
      event: "relay_fail",
      durationMs: 240001.4,
      failureKind: "timeout",
      question: "must not escape",
      prompt: "must not escape",
      nested: { secret: "must not escape" },
    }),
  ].join("\n");

  assert.deepEqual(projectPrivateEvaluationStageLog(source), [{
    schemaVersion: 1,
    kind: "private_evaluation_stage",
    stage: "relay",
    event: "relay_fail",
    durationMs: 240001,
    failureKind: "timeout",
  }]);
});

test("private evaluation stage projection rejects malformed and unapproved records", () => {
  const source = [
    'prefix {"schemaVersion":1,"kind":"private_evaluation_stage"',
    JSON.stringify({ schemaVersion: 1, kind: "other", traceId: "case-001", stage: "relay", event: "start" }),
    JSON.stringify({ schemaVersion: 1, kind: "private_evaluation_stage", traceId: "secret-card-name", stage: "relay", event: "start" }),
    JSON.stringify({ schemaVersion: 1, kind: "private_evaluation_stage", traceId: "private-short", stage: "relay", event: "start" }),
    JSON.stringify({ schemaVersion: 1, kind: "private_evaluation_stage", traceId: `private-${"a".repeat(49)}`, stage: "relay", event: "start" }),
    JSON.stringify({ schemaVersion: 1, kind: "private_evaluation_stage", traceId: "private-UPPER01", stage: "relay", event: "start" }),
    JSON.stringify({ schemaVersion: 1, kind: "private_evaluation_stage", traceId: "case-001", stage: "secret", event: "start" }),
    JSON.stringify({ schemaVersion: 1, kind: "private_evaluation_stage", traceId: "case-001", stage: "relay", event: "secret" }),
  ].join("\n");

  assert.deepEqual(projectPrivateEvaluationStageLog(source), []);
});

test("private evaluation stage projection accepts opaque backend trace ids but never returns them", () => {
  const source = JSON.stringify({
    schemaVersion: 1,
    kind: "private_evaluation_stage",
    traceId: "private-safe01",
    stage: "retrieval",
    event: "end",
    durationMs: 42.6,
    question: "must not escape",
    prompt: "must not escape",
    response: "must not escape",
  });

  const events = projectPrivateEvaluationStageLog(source);
  assert.deepEqual(events, [{
    schemaVersion: 1,
    kind: "private_evaluation_stage",
    stage: "retrieval",
    event: "end",
    durationMs: 43,
  }]);
  assert.equal(Object.hasOwn(events[0], "traceId"), false);
  assert.doesNotMatch(JSON.stringify(events), /safe01|must not escape/u);
});
