import assert from "node:assert/strict";
import test from "node:test";

import { answerPublicRulingQuestion } from "../backend/publicAnswerService.mjs";
import {
  finalizePublicAnswer,
  preparePublicAnswer,
} from "../backend/publicPreparedAnswerService.mjs";

const AUDIT_ID = "audit-private-7b6e5d4c";
const PRIVATE_CONTEXT = Object.freeze({
  ip: "203.0.113.42",
  ipSource: "vercel",
  requestChannel: "web",
  privateMarker: "private-request-context-marker",
});
const ENV = Object.freeze({
  MODEL_PROVIDER: "mock",
  PUBLIC_RULING_MODEL_PROFILE: "official-astra-low",
  PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "false",
  RAG_EVIDENCE_PIPELINE: "rag_baseline",
});
const PAYLOAD = Object.freeze({
  question: "Synthetic lifecycle question",
  mode: "rag",
  rulingVersion: "latest",
  rulingModelProfile: "official-astra-low",
});
const CONTINUATION = Object.freeze({
  promptBundle: {
    prompt: "Synthetic evidence package",
    allowedEvidenceIds: [],
  },
  evidence: { records: [] },
  ruleQueryModel: { query: "synthetic" },
});
const PROFILE = Object.freeze({
  id: "official-astra-low",
  label: "Synthetic profile",
  provider: "openai",
  model: "gpt-6-astra",
  thinkingMode: "enabled",
  reasoningEffort: "low",
});

function auditRecord() {
  return { stored: true, entry: { id: AUDIT_ID } };
}

function preparedAnswer() {
  return {
    status: "evidence_prepared",
    rulingVersion: "latest",
    continuation: CONTINUATION,
    debug: {
      requestDiagnostics: {
        requestId: "public-request-diagnostic",
        durationMs: 17,
      },
    },
  };
}

function generatedAnswer(shortAnswer = "Synthetic public answer") {
  return {
    shortAnswer,
    rulingVersion: "latest",
    debug: { dryRun: true },
  };
}

function assertPrivateValuesAbsent(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(AUDIT_ID), false);
  assert.equal(serialized.includes(PRIVATE_CONTEXT.ip), false);
  assert.equal(serialized.includes(PRIVATE_CONTEXT.privateMarker), false);
  assert.equal(serialized.includes('"requestChannel"'), false);
}

test("answer service appends request identity and exposes auditId only in its private envelope", async () => {
  let appendInput;
  let rulingInput;
  const result = await answerPublicRulingQuestion({
    payload: PAYLOAD,
    env: ENV,
    requestContext: PRIVATE_CONTEXT,
    appendAudit: async (input) => {
      appendInput = input;
      return auditRecord();
    },
    updateAudit: async () => ({ updated: true }),
    answerRuling: async (input) => {
      rulingInput = input;
      return generatedAnswer();
    },
  });

  assert.equal(appendInput.question, PAYLOAD.question);
  assert.equal(appendInput.mode, "rag");
  assert.equal(appendInput.profileId, PROFILE.id);
  assert.strictEqual(appendInput.requestContext, PRIVATE_CONTEXT);
  assert.match(appendInput.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(result.auditId, AUDIT_ID);
  assert.equal(Object.hasOwn(result.answer, "auditId"), false);
  assert.equal(Object.hasOwn(rulingInput, "requestContext"), false);
  assertPrivateValuesAbsent(result.answer);
  assert.equal(JSON.stringify(rulingInput).includes(PRIVATE_CONTEXT.ip), false);
  assert.equal(JSON.stringify(rulingInput).includes(PRIVATE_CONTEXT.privateMarker), false);
  assert.equal(JSON.stringify(rulingInput).includes('"requestChannel"'), false);
});

test("risk-control early return marks the audit that was appended as blocked", async () => {
  const updates = [];
  const result = await answerPublicRulingQuestion({
    payload: PAYLOAD,
    env: {
      ...ENV,
      PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: "true",
      UPSTASH_REDIS_REST_URL: "https://redis.invalid",
      UPSTASH_REDIS_REST_TOKEN: "test-only-token",
    },
    requestContext: PRIVATE_CONTEXT,
    appendAudit: async () => auditRecord(),
    updateAudit: async (input) => updates.push(input),
    readRiskControl: async () => ({ active: true, remainingMinutes: 4 }),
    classifyScope: async () => assert.fail("an active lock must skip classification"),
    answerRuling: async () => assert.fail("an active lock must skip ruling generation"),
  });

  assert.equal(result.answer.answerLevel, "risk_control");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, AUDIT_ID);
  assert.equal(updates[0].patch.status, "blocked");
  assertPrivateValuesAbsent(result.answer);
});

test("answer preparation envelope does not mark the audit complete before storage", async () => {
  const updates = [];
  const result = await answerPublicRulingQuestion({
    payload: PAYLOAD,
    env: ENV,
    requestContext: PRIVATE_CONTEXT,
    prepareForContinuation: true,
    appendAudit: async () => auditRecord(),
    updateAudit: async (input) => updates.push(input),
    answerRuling: async () => preparedAnswer(),
  });

  assert.equal(result.answer.status, "evidence_prepared");
  assert.equal(result.auditId, AUDIT_ID);
  assert.equal(updates.some(({ patch }) => patch.status === "completed"), false);
  assert.equal(updates.some(({ patch }) => patch.status === "prepared"), false);
});

test("answer audit append and update failures remain observational", async () => {
  for (const failurePoint of ["append", "update"]) {
    const result = await answerPublicRulingQuestion({
      payload: PAYLOAD,
      env: ENV,
      requestContext: PRIVATE_CONTEXT,
      appendAudit: async () => {
        if (failurePoint === "append") throw new Error("synthetic append failure");
        return auditRecord();
      },
      updateAudit: async () => {
        if (failurePoint === "update") throw new Error("synthetic update failure");
      },
      answerRuling: async () => generatedAnswer("Answer survives audit failure"),
    });

    assert.equal(result.answer.shortAnswer, "Answer survives audit failure");
    assertPrivateValuesAbsent(result.answer);
  }
});

test("prepare passes private context only to answer auditing and saves auditId server-side", async () => {
  let answerInput;
  let stored;
  const updates = [];
  const lifecycle = [];
  const result = await preparePublicAnswer({
    payload: PAYLOAD,
    env: ENV,
    requestContext: PRIVATE_CONTEXT,
    progress: { complete: () => ({ totalMs: 17, stageDurationsMs: {} }) },
    store: {
      create: async (input) => {
        lifecycle.push("store.create");
        stored = input;
        return "preparation-public-id";
      },
    },
    answerPublic: async (input) => {
      answerInput = input;
      return {
        answer: preparedAnswer(),
        auditId: AUDIT_ID,
        latency: { profileId: PROFILE.id },
      };
    },
    updateAudit: async (input) => {
      lifecycle.push(`audit.${input.patch.status}`);
      updates.push(input);
    },
    now: () => 100,
  });

  assert.strictEqual(answerInput.requestContext, PRIVATE_CONTEXT);
  assert.equal(answerInput.prepareForContinuation, true);
  assert.equal(stored.auditId, AUDIT_ID);
  assert.equal(stored.requestContext, undefined);
  assert.equal(stored.ip, undefined);
  assert.deepEqual(lifecycle, ["store.create", "audit.prepared"]);
  assert.deepEqual(updates.map(({ id, patch }) => [id, patch.status]), [[AUDIT_ID, "prepared"]]);
  assert.equal(result.preparationId, "preparation-public-id");
  assert.equal(Object.hasOwn(result, "auditId"), false);
  assert.equal(Object.hasOwn(result.evidencePackage, "auditId"), false);
  assertPrivateValuesAbsent(result);
});

test("prepare storage failure marks the private audit failed and preserves the storage error", async () => {
  const updates = [];
  const original = Object.assign(new Error("synthetic preparation storage failure"), {
    code: "answer_preparation_storage_unavailable",
  });

  await assert.rejects(preparePublicAnswer({
    payload: PAYLOAD,
    env: ENV,
    requestContext: PRIVATE_CONTEXT,
    progress: { complete: () => ({ totalMs: 17, stageDurationsMs: {} }) },
    store: { create: async () => { throw original; } },
    answerPublic: async () => ({
      answer: preparedAnswer(),
      auditId: AUDIT_ID,
      latency: { profileId: PROFILE.id },
    }),
    updateAudit: async (input) => updates.push(input),
  }), (error) => error === original);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, AUDIT_ID);
  assert.equal(updates[0].patch.status, "failed");
  assert.equal(updates[0].patch.errorCode, "answer_preparation_storage_unavailable");
  assert.equal(Object.hasOwn(updates[0].patch, "message"), false);
});

test("finalize updates the saved audit with completed answer metadata", async () => {
  const updates = [];
  let finalizerInput;
  const times = [200, 235];
  const result = await finalizePublicAnswer({
    preparation: {
      auditId: AUDIT_ID,
      profileId: PROFILE.id,
      pipeline: "rag_baseline",
      continuation: CONTINUATION,
      rulingVersion: "latest",
      startedAt: 100,
      preparedAt: 120,
      progress: { totalMs: 20 },
      requestDiagnostics: { requestId: "public-request-diagnostic" },
      requestContext: PRIVATE_CONTEXT,
    },
    env: ENV,
    now: () => times.shift(),
    selectProfile: async () => ({ profile: PROFILE, fallbackFrom: null }),
    finalize: async (input) => {
      finalizerInput = input;
      return generatedAnswer("Final synthetic answer");
    },
    addGeneration: async (answer) => ({
      ...answer,
      generation: { model: "synthetic-model", reasoningEffort: "high" },
    }),
    updateAudit: async (input) => updates.push(input),
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, AUDIT_ID);
  assert.equal(updates[0].patch.status, "completed");
  assert.equal(updates[0].patch.answer, result.answer.shortAnswer);
  assert.equal(updates[0].patch.model, "synthetic-model");
  assert.equal(updates[0].patch.reasoningEffort, "high");
  assert.equal(updates[0].patch.latencyMs, 55);
  assert.equal(Object.hasOwn(finalizerInput, "requestContext"), false);
  assert.equal(JSON.stringify(finalizerInput).includes(PRIVATE_CONTEXT.ip), false);
  assert.equal(Object.hasOwn(result.answer, "auditId"), false);
  assertPrivateValuesAbsent(result.answer);
});

test("finalize failure records only a bounded error code", async () => {
  const updates = [];
  const original = Object.assign(new Error(`supplier failed for ${PRIVATE_CONTEXT.ip}`), {
    code: "supplier_timeout",
  });
  const preparation = {
    auditId: AUDIT_ID,
    profileId: PROFILE.id,
    pipeline: "rag_baseline",
    continuation: CONTINUATION,
    rulingVersion: "latest",
    progress: { totalMs: 20 },
  };

  await assert.rejects(finalizePublicAnswer({
    preparation,
    env: ENV,
    selectProfile: async () => ({ profile: PROFILE, fallbackFrom: null }),
    finalize: async () => { throw original; },
    updateAudit: async (input) => updates.push(input),
  }), (error) => error === original);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, AUDIT_ID);
  assert.equal(updates[0].patch.status, "failed");
  assert.equal(updates[0].patch.errorCode, "supplier_timeout");
  assert.equal(Object.hasOwn(updates[0].patch, "message"), false);
  assert.equal(JSON.stringify(updates[0].patch).includes(PRIVATE_CONTEXT.ip), false);
});

test("audit update failure cannot replace a successful final answer", async () => {
  const result = await finalizePublicAnswer({
    preparation: {
      auditId: AUDIT_ID,
      profileId: PROFILE.id,
      pipeline: "rag_baseline",
      continuation: CONTINUATION,
      rulingVersion: "latest",
      progress: { totalMs: 20 },
    },
    env: ENV,
    selectProfile: async () => ({ profile: PROFILE, fallbackFrom: null }),
    finalize: async () => generatedAnswer("Successful final answer"),
    addGeneration: async (answer) => ({
      ...answer,
      generation: { model: "synthetic-model", reasoningEffort: "low" },
    }),
    updateAudit: async () => { throw new Error("synthetic audit update failure"); },
  });

  assert.equal(result.answer.shortAnswer, "Successful final answer");
});

test("audit update failure cannot replace the original finalization error", async () => {
  const original = Object.assign(new Error("original finalization failure"), {
    code: "original_failure",
  });
  await assert.rejects(finalizePublicAnswer({
    preparation: {
      auditId: AUDIT_ID,
      profileId: PROFILE.id,
      pipeline: "rag_baseline",
      continuation: CONTINUATION,
      rulingVersion: "latest",
      progress: { totalMs: 20 },
    },
    env: ENV,
    selectProfile: async () => ({ profile: PROFILE, fallbackFrom: null }),
    finalize: async () => { throw original; },
    updateAudit: async () => { throw new Error("synthetic audit update failure"); },
  }), (error) => error === original);
});

test("legacy preparation without auditId stays compatible and skips audit updates", async () => {
  let updateCalls = 0;
  const result = await finalizePublicAnswer({
    preparation: {
      profileId: PROFILE.id,
      pipeline: "rag_baseline",
      continuation: CONTINUATION,
      rulingVersion: "latest",
      progress: { totalMs: 20 },
    },
    env: ENV,
    selectProfile: async () => ({ profile: PROFILE, fallbackFrom: null }),
    finalize: async () => generatedAnswer("Legacy preparation answer"),
    addGeneration: async (answer) => ({
      ...answer,
      generation: { model: "synthetic-model", reasoningEffort: "low" },
    }),
    updateAudit: async () => { updateCalls += 1; },
  });

  assert.equal(result.answer.shortAnswer, "Legacy preparation answer");
  assert.equal(updateCalls, 0);
});
