import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  normalizeLocalRelayExperimentOptions,
  normalizeSnapshotBundle,
  parseLocalRelayExperimentArgs,
  runLocalRelayEffortExperiment,
} from "../scripts/local-relay-effort-experiment.mjs";

test("local relay CLI accepts repeatable effort flags and validates secrets", () => {
  const parsed = parseLocalRelayExperimentArgs([
    "--snapshots", "bundle.json",
    "--model", "relay-gpt-5.6-sol",
    "--effort", "low",
    "--effort", "high",
    "--evidence-variant", "without_lua",
    "--case", "case-b",
    "--output", "report.json",
    "--timeout-ms", "600000",
    "--max-calls", "4",
  ]);
  assert.deepEqual(parsed.efforts, ["low", "high"]);
  const options = normalizeLocalRelayExperimentOptions(parsed, {
    RELAY_API_KEY: "server-secret",
    RELAY_BASE_URL: "https://relay.example/v1",
  });
  assert.equal(options.timeoutMs, 600000);
  assert.equal(options.maxCalls, 4);
  assert.equal(options.evidenceVariant, "without_lua");
  assert.deepEqual(options.caseIds, ["case-b"]);
  assert.equal(options.apiKey, "server-secret");
  assert.throws(
    () => normalizeLocalRelayExperimentOptions(parsed, { RELAY_BASE_URL: "https://relay.example/v1" }),
    /RELAY_API_KEY is required/u,
  );
});

test("local relay runner is serial, single-attempt, checkpointed and resumable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-effort-test-"));
  const bundlePath = path.join(directory, "bundle.json");
  const outputPath = path.join(directory, "checkpoint.json");
  const cases = ["case-a", "case-b"].map((caseId) => ({
    caseId,
    evidenceSnapshot: createAdminEvidenceSnapshot({
      question: `${caseId} question`,
      evidence: {
        questions: [{ questionId: "q1", text: `${caseId} question` }],
        providedFacts: [],
      },
      createdAt: "2026-08-08T00:00:00.000Z",
    }),
    executionProfile: {
      evidenceVariant: "full",
      questionIds: ["q1"],
      providedFacts: [],
      prompt: { version: "openai-ruling-v1", instructions: "Return JSON." },
      finalRuling: { reasoningMode: "pro", maxOutputTokens: 1024 },
    },
  }));
  await writeFile(bundlePath, JSON.stringify({
    schemaVersion: 1,
    kind: "admin-frozen-source-snapshot-bundle",
    sources: cases,
  }), "utf8");

  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const provider = {
    async runRuling(request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(request);
      await Promise.resolve();
      active -= 1;
      return {
        id: `request-${calls.length}`,
        status: "completed",
        model: request.model.replace(/^relay-/u, ""),
        requested_model: request.model,
        submitted_model: request.model.replace(/^relay-/u, ""),
        reported_model: request.model.replace(/^relay-/u, ""),
        finish_reason: "stop",
        output_text: JSON.stringify({ case: calls.length }),
        usage: { prompt_tokens: 10, completion_tokens: 3 },
        stream_metrics: { requestToFirstContentMs: 12, requestToCompleteMs: 20 },
      };
    },
    validateCompletedResponse(response) {
      return { ok: true, errors: [], normalized: JSON.parse(response.output_text) };
    },
  };
  const options = {
    snapshots: bundlePath,
    output: outputPath,
    model: "relay-gpt-5.6-sol",
    efforts: ["low", "high"],
    timeoutMs: "600000",
  };
  const env = {
    RELAY_API_KEY: "not-sent-to-output",
    RELAY_BASE_URL: "https://relay.example/v1",
  };
  const first = await runLocalRelayEffortExperiment({
    options,
    env,
    providerFactory: () => provider,
    log: () => {},
  });
  assert.equal(maximumActive, 1);
  assert.equal(calls.length, 4);
  assert.equal(first.status, "completed");
  assert.equal(first.results.length, 4);
  assert.ok(first.results.every((result) => result.status === "completed_valid"));
  assert.ok(first.results.every((result) => result.rawOutput && result.validatedResult.ok));
  assert.ok(first.results.every((result) => result.usage && result.sseTiming));
  const saved = await readFile(outputPath, "utf8");
  assert.equal(saved.includes("not-sent-to-output"), false);
  assert.equal(saved.includes("golden"), false);

  await runLocalRelayEffortExperiment({
    options,
    env,
    providerFactory: () => provider,
    log: () => {},
  });
  assert.equal(calls.length, 4, "resume must not repeat completed requests");
  assert.ok(calls.every((call) => call.reasoningMode === "pro"));
});

test("local relay runner filters cases and isolates ablation checkpoints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-ablation-test-"));
  const bundlePath = path.join(directory, "bundle.json");
  const outputPath = path.join(directory, "checkpoint.json");
  const sources = ["case-a", "case-b"].map((caseId) => {
    const evidenceSnapshot = createAdminEvidenceSnapshot({
      question: `${caseId} question`,
      evidence: {
        questions: [{ questionId: "q1", text: `${caseId} question` }],
        luaSemantics: [{ cardId: caseId, summary: "Lua-only evidence" }],
      },
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    return {
      caseId,
      evidenceSnapshot,
      executionProfile: {
        evidenceVariant: "full",
        questionIds: ["q1"],
        prompt: { instructions: "Return JSON." },
        finalRuling: { reasoningMode: "pro" },
      },
    };
  });
  await writeFile(bundlePath, JSON.stringify({ sources }), "utf8");
  const calls = [];
  const providerFactory = () => ({
    async runRuling(request) {
      calls.push(request);
      return {
        answer: { verdict: "UNKNOWN", explanation: "test" },
        requestedModel: "relay-gpt-5.6-sol",
        returnedModel: "relay-gpt-5.6-sol",
        finishReason: "stop",
        usage: {},
      };
    },
  });
  const env = { RELAY_API_KEY: "secret", RELAY_BASE_URL: "https://relay.example/v1" };
  const report = await runLocalRelayEffortExperiment({
    options: {
      snapshots: bundlePath,
      output: outputPath,
      model: "relay-gpt-5.6-sol",
      efforts: ["low"],
      evidenceVariant: "without_lua",
      caseIds: ["case-b"],
      maxCalls: 1,
    },
    env,
    providerFactory,
    log: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(report.results.length, 1);
  assert.deepEqual(report.caseIds, ["case-b"]);
  assert.equal(report.evidenceVariant, "without_lua");
  assert.match(report.results[0].key, /case-b.*without_lua/u);
  assert.doesNotMatch(JSON.stringify(calls[0].input), /Lua-only evidence/u);
  await assert.rejects(
    () => runLocalRelayEffortExperiment({
      options: {
        snapshots: bundlePath,
        output: outputPath,
        model: "relay-gpt-5.6-sol",
        efforts: ["low"],
        evidenceVariant: "full",
        caseIds: ["case-b"],
        maxCalls: 1,
      },
      env,
      providerFactory,
      log: () => {},
    }),
    /different evidence variant/u,
  );
});

test("local relay runner safely expands an existing effort checkpoint without repeating prior calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-effort-expand-test-"));
  const bundlePath = path.join(directory, "bundle.json");
  const outputPath = path.join(directory, "checkpoint.json");
  const snapshot = createAdminEvidenceSnapshot({
    question: "Q",
    evidence: { questions: [{ questionId: "q1", text: "Q" }] },
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  await writeFile(bundlePath, JSON.stringify({
    sources: [{
      caseId: "case-a",
      evidenceSnapshot: snapshot,
      executionProfile: {
        prompt: { instructions: "Return JSON." },
        questionIds: ["q1"],
        finalRuling: { reasoningMode: "pro" },
      },
    }],
  }), "utf8");
  const calls = [];
  const providerFactory = () => ({
    async runRuling(input) {
      calls.push(input.reasoningEffort);
      return {
        answer: { verdict: "UNKNOWN", explanation: "test" },
        requestedModel: "relay-gpt-5.6-sol",
        returnedModel: "relay-gpt-5.6-sol",
        finishReason: "stop",
        usage: {},
      };
    },
  });
  const common = {
    snapshots: bundlePath,
    output: outputPath,
    model: "relay-gpt-5.6-sol",
    maxCalls: 6,
  };
  const env = { RELAY_API_KEY: "secret", RELAY_BASE_URL: "https://relay.example/v1" };
  await runLocalRelayEffortExperiment({
    options: { ...common, efforts: ["none", "low", "medium"] },
    env,
    providerFactory,
    log: () => {},
  });
  const expanded = await runLocalRelayEffortExperiment({
    options: { ...common, efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
    env,
    providerFactory,
    log: () => {},
  });
  assert.deepEqual(calls, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(expanded.results.length, 6);
  assert.equal(expanded.plannedRequests, 6);
  assert.deepEqual(expanded.efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(expanded.status, "completed");
});

test("local relay runner rejects a plan above max-calls before provider construction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-effort-limit-test-"));
  const bundlePath = path.join(directory, "bundle.json");
  const outputPath = path.join(directory, "checkpoint.json");
  const snapshot = createAdminEvidenceSnapshot({
    question: "Q",
    evidence: { questions: [{ questionId: "q1", text: "Q" }] },
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  await writeFile(bundlePath, JSON.stringify({
    sources: [{
      caseId: "case-a",
      evidenceSnapshot: snapshot,
      executionProfile: {
        prompt: { instructions: "Return JSON." },
        questionIds: ["q1"],
        finalRuling: { reasoningMode: "pro" },
      },
    }],
  }), "utf8");
  let constructed = false;
  await assert.rejects(
    runLocalRelayEffortExperiment({
      options: {
        snapshots: bundlePath,
        output: outputPath,
        efforts: ["none", "low"],
        maxCalls: 1,
      },
      env: { RELAY_API_KEY: "secret", RELAY_BASE_URL: "https://relay.example/v1" },
      providerFactory: () => {
        constructed = true;
        throw new Error("must not construct");
      },
      log: () => {},
    }),
    /planned relay calls 2 exceed --max-calls 1/u,
  );
  assert.equal(constructed, false);
});

test("invalid frozen bundle is rejected before a Relay provider is constructed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-invalid-bundle-"));
  const bundlePath = path.join(directory, "bundle.json");
  const outputPath = path.join(directory, "checkpoint.json");
  const snapshot = createAdminEvidenceSnapshot({
    question: "anonymous",
    evidence: { questions: [{ questionId: "q1", text: "anonymous" }], providedFacts: [] },
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  await writeFile(bundlePath, JSON.stringify({
    schemaVersion: 1,
    sources: [{
      caseId: "invalid",
      evidenceSnapshot: snapshot,
      executionProfile: {
        evidenceSnapshotId: snapshot.snapshotId,
        evidenceVariant: "full",
        finalRulingInputSha256: "0".repeat(64),
        prompt: { instructions: "Return JSON." },
      },
    }],
  }));
  let providerFactoryCalls = 0;
  await assert.rejects(
    () => runLocalRelayEffortExperiment({
      options: {
        snapshots: bundlePath,
        output: outputPath,
        model: "relay-gpt-5.6-sol",
        efforts: ["low"],
      },
      env: {
        RELAY_API_KEY: "not-used",
        RELAY_BASE_URL: "https://relay.example/v1",
      },
      providerFactory() {
        providerFactoryCalls += 1;
        throw new Error("provider must not be constructed");
      },
    }),
    /final ruling input hash/u,
  );
  assert.equal(providerFactoryCalls, 0);
});

test("snapshot bundle normalizer rejects prompt hash mismatches", () => {
  const snapshot = createAdminEvidenceSnapshot({
    question: "anonymous",
    evidence: { questions: [{ questionId: "q1", text: "anonymous" }], providedFacts: [] },
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  assert.throws(
    () => normalizeSnapshotBundle({
      sources: [{
        caseId: "invalid-prompt",
        evidenceSnapshot: snapshot,
        executionProfile: {
          evidenceSnapshotId: snapshot.snapshotId,
          prompt: { instructions: "Return JSON.", sha256: "0".repeat(64) },
        },
      }],
    }),
    /prompt instructions fail/u,
  );
});

test("secure wrapper defaults the relay base URL and starts one Node process", async () => {
  const wrapper = await readFile(
    new URL("../scripts/run-local-relay-effort-experiment.ps1", import.meta.url),
    "utf8",
  );
  assert.match(wrapper, /Read-Host[^\n]+-AsSecureString/u);
  assert.match(wrapper, /https:\/\/api\.986310\.xyz\/v1/u);
  assert.equal((wrapper.match(/& \$node\b/gu) || []).length, 1);
  assert.match(wrapper, /npm_node_execpath/u);
  assert.match(wrapper, /finally/u);
  assert.doesNotMatch(wrapper, /start-local-relay|start-with-ocg-engine|Start-Process/u);
});
