import assert from "node:assert/strict";
import test from "node:test";
import { queryAuditAnswerPatch, queryAuditFailurePatch } from "../backend/publicQueryAudit.mjs";
import { listQueryAudits, updateQueryAudit } from "../backend/queryAuditStore.mjs";

const env = { UPSTASH_REDIS_REST_URL: "https://redis.example.test", UPSTASH_REDIS_REST_TOKEN: "synthetic-key" };
const scope = { scope: "in_scope", reasonCode: "ruling_question", prompt: "private-prompt-marker", usage: { private: "private-usage-marker" } };

test("audit patches include only controlled scope summaries and failure stages", () => {
  const success = queryAuditAnswerPatch({ shortAnswer: "Synthetic answer", debug: { requestDiagnostics: { scope } } });
  assert.equal(success.scopeResult, "in_scope");
  assert.equal(success.scopeReason, "ruling_question");
  assert.equal(success.errorStage, undefined);
  const blocked = queryAuditAnswerPatch({ answerLevel: "out_of_scope", debug: { requestDiagnostics: {
    scope: { ...scope, scope: "out_of_scope", reasonCode: "not_ruling_question" },
  } } }, { status: "blocked" });
  assert.equal(blocked.scopeResult, "out_of_scope");
  assert.equal(blocked.scopeReason, "not_ruling_question");
  assert.equal(blocked.errorStage, "scope");

  for (const [code, errorStage] of [
    ["public_query_scope_unavailable", "scope"], ["public_request_rate_limited", "request_admission"],
    ["public_request_rate_limit_unavailable", "request_admission"], ["public_service_paused", "request_admission"],
    ["decisions_http_error", "evidence_selection"], ["decisions_http_504", "evidence_selection"],
    ["answer_preparation_scope_unverified", "scope"], ["answer_preparation_missing", "preparation"],
    ["model_provider_timeout", "generation"],
  ]) {
    const patch = queryAuditFailurePatch({ code, message: "private-error-marker", requestDiagnostics: { scope } });
    assert.equal(patch.errorStage, errorStage, code);
    assert.equal(patch.scopeResult, "in_scope");
    assert.equal(patch.scopeReason, "ruling_question");
    assert.doesNotMatch(JSON.stringify(patch), /private-/);
  }
  assert.doesNotMatch(JSON.stringify(success), /private-/);
});

test("audit rejects arbitrary diagnostic text even when it resembles a machine field", () => {
  const patch = queryAuditFailurePatch({ code: "unknown_error", stage: "private_stage", requestDiagnostics: {
    scope: { scope: "private_scope", reasonCode: "private_reason" },
  } });
  assert.equal(patch.scopeResult, undefined);
  assert.equal(patch.scopeReason, undefined);
  assert.equal(patch.errorStage, undefined);
  const confirmedStage = queryAuditFailurePatch({ code: "unknown_error", stage: "preparation" });
  assert.equal(confirmedStage.errorStage, "preparation");
});

test("safe diagnostics survive Redis update and list while nested diagnostics stay private", async () => {
  const entry = { id: "audit-1", question: "Synthetic question", createdAt: "2026-10-08T00:00:00.000Z" };
  let persisted;
  const fetchImpl = async (_url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === "EVAL") {
      persisted = JSON.parse(command[5]);
      Object.assign(entry, persisted);
      return Response.json({ result: JSON.stringify(entry) });
    }
    return Response.json({ result: [JSON.stringify({ ...entry, requestDiagnostics: { prompt: "private-prompt-marker" } })] });
  };
  const patch = { scopeResult: "uncertain", scopeReason: "classifier_timeout", errorStage: "scope", requestDiagnostics: { prompt: "private-prompt-marker" } };
  const updated = await updateQueryAudit({ id: entry.id, patch, env, fetchImpl });
  assert.deepEqual(persisted, { scopeResult: "uncertain", scopeReason: "classifier_timeout", errorStage: "scope" });
  const listed = await listQueryAudits({ env, fetchImpl });
  for (const record of [updated.entry, listed.entries[0]]) {
    assert.equal(record.scopeResult, patch.scopeResult);
    assert.equal(record.scopeReason, patch.scopeReason);
    assert.equal(record.errorStage, patch.errorStage);
    assert.doesNotMatch(JSON.stringify(record), /private-prompt-marker|requestDiagnostics/);
  }
});

test("storage rejects unknown diagnostic values from update and old records", async () => {
  const entry = { id: "audit-1", question: "Synthetic", createdAt: "2026-10-08T00:00:00.000Z" };
  let persisted;
  const unsafe = { scopeResult: "private_scope", scopeReason: "private_reason", errorStage: "private_stage" };
  const fetchImpl = async (_url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === "EVAL") {
      persisted = JSON.parse(command[5]);
      return Response.json({ result: JSON.stringify({ ...entry, ...unsafe }) });
    }
    return Response.json({ result: [JSON.stringify({ ...entry, ...unsafe })] });
  };
  const updated = await updateQueryAudit({ id: entry.id, patch: unsafe, env, fetchImpl });
  const listed = await listQueryAudits({ env, fetchImpl });
  assert.deepEqual(persisted, {});
  assert.doesNotMatch(JSON.stringify([updated.entry, listed.entries]), /private_/);
});
