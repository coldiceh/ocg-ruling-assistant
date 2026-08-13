import test from "node:test";
import assert from "node:assert/strict";

import {
  beginPrivateEvaluationStage,
  classifyPrivateEvaluationFailure,
  createPrivateEvaluationDiagnostics,
  emitPrivateEvaluationDiagnostic,
} from "../backend/privateEvaluationDiagnostics.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

test("private evaluation diagnostics are entirely silent unless explicitly enabled", () => {
  const lines = [];
  const diagnostics = createPrivateEvaluationDiagnostics({
    env: {},
    traceId: "case-001",
    write: (line) => lines.push(line),
  });

  const stage = beginPrivateEvaluationStage(diagnostics, "retrieval");
  stage.end();
  emitPrivateEvaluationDiagnostic(diagnostics, {
    stage: "relay",
    event: "relay_dispatch",
  });

  assert.equal(diagnostics.enabled, false);
  assert.deepEqual(lines, []);
});

test("enabled diagnostics emit only the fixed JSONL allowlist", () => {
  const lines = [];
  const diagnostics = createPrivateEvaluationDiagnostics({
    env: { PRIVATE_EVALUATION_DIAGNOSTICS: "true" },
    traceId: "case-032",
    write: (line) => lines.push(line),
  });

  emitPrivateEvaluationDiagnostic(diagnostics, {
    stage: "relay",
    event: "relay_dispatch",
    durationMs: 12.4,
    failureKind: "provider",
    question: "must never be serialized",
    prompt: "must never be serialized",
    response: "must never be serialized",
    url: "https://secret.example",
    hash: "secret-hash",
  });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    schemaVersion: 1,
    kind: "private_evaluation_stage",
    traceId: "case-032",
    stage: "relay",
    event: "relay_dispatch",
    durationMs: 12,
    failureKind: "provider",
  });
});

test("errors and invalid trace ids cannot leak private evaluation text", () => {
  const lines = [];
  const diagnostics = createPrivateEvaluationDiagnostics({
    env: { PRIVATE_EVALUATION_DIAGNOSTICS: "TRUE" },
    traceId: "case-001 secret-card-name",
    createRandomTraceId: () => "private-safe01",
    write: (line) => lines.push(line),
  });
  const error = new Error("secret question, card name, URL and provider body");
  error.code = "ETIMEDOUT";

  const stage = beginPrivateEvaluationStage(diagnostics, "retrieval");
  stage.fail(error);
  stage.end();

  assert.equal(lines.length, 2);
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((item) => item.event), ["start", "fail"]);
  assert.equal(records[0].traceId, "private-safe01");
  assert.equal(records[1].failureKind, "timeout");
  const serialized = lines.join("\n");
  assert.doesNotMatch(serialized, /secret|card|url|provider body/iu);
  for (const record of records) {
    assert.deepEqual(
      Object.keys(record).sort(),
      (record.event === "start"
        ? ["event", "kind", "schemaVersion", "stage", "traceId"]
        : ["durationMs", "event", "failureKind", "kind", "schemaVersion", "stage", "traceId"]
      ).sort(),
    );
  }
});

test("unknown diagnostic stages and events are dropped rather than serialized", () => {
  const lines = [];
  const diagnostics = createPrivateEvaluationDiagnostics({
    env: { PRIVATE_EVALUATION_DIAGNOSTICS: "true" },
    createRandomTraceId: () => "private-safe02",
    write: (line) => lines.push(line),
  });

  emitPrivateEvaluationDiagnostic(diagnostics, { stage: "question", event: "end" });
  emitPrivateEvaluationDiagnostic(diagnostics, { stage: "retrieval", event: "private_text" });

  assert.deepEqual(lines, []);
});

test("timeout diagnostics follow generic timeout code families and nested causes", () => {
  for (const code of [
    "relay_stream_timeout",
    "final_ruling_provider_timeout",
    "UND_ERR_HEADERS_TIMEOUT",
  ]) {
    assert.equal(classifyPrivateEvaluationFailure(Object.assign(new Error("provider failed"), { code })), "timeout");
  }
  const nestedTimeout = Object.assign(new Error("outer abort"), {
    name: "AbortError",
    cause: Object.assign(new Error("inner provider deadline"), {
      code: "relay_stream_timeout",
    }),
  });
  assert.equal(classifyPrivateEvaluationFailure(nestedTimeout), "timeout");
  assert.equal(classifyPrivateEvaluationFailure(Object.assign(new Error("cancelled"), {
    name: "AbortError",
  })), "aborted");
});

test("pipeline diagnostics describe technical stages without serializing private inputs", async () => {
  const lines = [];
  const privateQuestion = [
    "【PRIVATE-QUESTION-NEVER-LOGGED】",
    "①：自己主要阶段可以发动。抽1张卡。",
    "这个效果可以发动吗？",
  ].join("\n");
  await answerRagRulingQuestion({
    question: privateQuestion,
    cards: [],
    records: [],
    qaRecords: [],
    dryRun: true,
    env: {
      PRIVATE_EVALUATION_DIAGNOSTICS: "true",
      RAG_DRY_RUN: "true",
    },
    fetchImpl: async () => new Response(JSON.stringify({ result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    privateEvaluationTraceId: "case-001",
    privateEvaluationDiagnosticWrite: (line) => lines.push(line),
  });

  const records = lines.map((line) => JSON.parse(line));
  for (const stage of ["data_load", "extraction", "retrieval", "prompt_build", "total"]) {
    assert.ok(records.some((item) => item.stage === stage && item.event === "start"));
    assert.ok(records.some((item) => item.stage === stage && item.event === "end"));
  }
  assert.equal(records.some((item) => item.event === "relay_dispatch"), false);
  assert.doesNotMatch(lines.join("\n"), /PRIVATE-QUESTION-NEVER-LOGGED/u);
});
