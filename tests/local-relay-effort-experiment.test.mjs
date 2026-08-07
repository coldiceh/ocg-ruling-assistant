import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  normalizeLocalRelayExperimentOptions,
  parseLocalRelayExperimentArgs,
  runLocalRelayEffortExperiment,
} from "../scripts/local-relay-effort-experiment.mjs";

test("local relay CLI accepts repeatable effort flags and validates secrets", () => {
  const parsed = parseLocalRelayExperimentArgs([
    "--snapshots", "bundle.json",
    "--model", "relay-gpt-5.6-sol",
    "--effort", "low",
    "--effort", "high",
    "--output", "report.json",
    "--timeout-ms", "600000",
  ]);
  assert.deepEqual(parsed.efforts, ["low", "high"]);
  const options = normalizeLocalRelayExperimentOptions(parsed, {
    RELAY_API_KEY: "server-secret",
    RELAY_BASE_URL: "https://relay.example/v1",
  });
  assert.equal(options.timeoutMs, 600000);
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
