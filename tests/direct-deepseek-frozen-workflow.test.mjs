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

const workflowUrl = new URL(
  "../.github/workflows/direct-deepseek-frozen-ten-case.yml",
  import.meta.url,
);

test("direct runner accepts DeepSeek provider, mode, and server-only credential", () => {
  const parsed = parseLocalRelayExperimentArgs([
    "--snapshots", "bundle.json",
    "--provider", "deepseek",
    "--model", "deepseek-v4-flash",
    "--reasoning-mode", "standard",
    "--effort", "none",
    "--output", "checkpoint.json",
    "--max-calls", "10",
  ]);
  const normalized = normalizeLocalRelayExperimentOptions(parsed, {
    DEEPSEEK_API_KEY: "server-secret",
  });
  assert.equal(normalized.providerId, "deepseek");
  assert.equal(normalized.model, "deepseek-v4-flash");
  assert.equal(normalized.reasoningMode, "standard");
  assert.deepEqual(normalized.efforts, ["none"]);
  assert.equal(normalized.apiKey, "server-secret");
  assert.equal(normalized.baseUrl, "");

  const bridged = normalizeLocalRelayExperimentOptions({
    ...parsed,
    bridgeUrl: "https://ocg-ruling-assistant.vercel.app/api/admin-frozen-deepseek",
    bridgeOrigin: "https://coldiceh.github.io",
  }, {
    ADMIN_MODEL_LAB_PASSWORD: "existing-admin-secret",
  });
  assert.equal(bridged.apiKey, "");
  assert.equal(
    bridged.bridgeUrl,
    "https://ocg-ruling-assistant.vercel.app/api/admin-frozen-deepseek",
  );
  assert.equal(bridged.bridgePassword, "existing-admin-secret");

  assert.throws(
    () => normalizeLocalRelayExperimentOptions(parsed, {}),
    /DEEPSEEK_API_KEY is required/u,
  );
  assert.throws(
    () => normalizeLocalRelayExperimentOptions({
      ...parsed,
      provider: "relay",
    }, { RELAY_API_KEY: "secret", RELAY_BASE_URL: "https://relay.example/v1" }),
    /does not match --model/u,
  );
  assert.throws(
    () => normalizeLocalRelayExperimentOptions({
      ...parsed,
      efforts: ["medium"],
    }, { DEEPSEEK_API_KEY: "secret" }),
    /unsupported DeepSeek --effort/u,
  );
});

test("direct DeepSeek runner is serial, checkpointed per case, and mode-bound", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepseek-frozen-direct-"));
  const bundlePath = path.join(directory, "bundle.json");
  const outputPath = path.join(directory, "checkpoint.json");
  const sources = ["case-a", "case-b"].map((caseId) => ({
    caseId,
    evidenceSnapshot: createAdminEvidenceSnapshot({
      question: `${caseId} question`,
      evidence: {
        questions: [{ questionId: "q1", text: `${caseId} question` }],
        providedFacts: [],
      },
      createdAt: "2026-08-10T00:00:00.000Z",
    }),
    executionProfile: {
      evidenceVariant: "full",
      questionIds: ["q1"],
      providedFacts: [],
      prompt: { version: "openai-ruling-v1", instructions: "Return JSON." },
      finalRuling: { maxOutputTokens: 1024 },
    },
  }));
  await writeFile(bundlePath, JSON.stringify({ sources }), "utf8");

  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const provider = {
    async runRuling(request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(request);
      await Promise.resolve();
      active -= 1;
      return {
        id: `deepseek-request-${calls.length}`,
        status: "completed",
        model: request.model,
        requested_model: request.model,
        submitted_model: request.model,
        reported_model: request.model,
        finish_reason: "stop",
        output_text: JSON.stringify({ verdict: "UNKNOWN" }),
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      };
    },
    validateCompletedResponse(response) {
      return {
        ok: true,
        errors: [],
        normalized: JSON.parse(response.output_text),
        hardValidity: { ok: true, errors: [] },
      };
    },
  };
  const options = {
    snapshots: bundlePath,
    output: outputPath,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    efforts: ["none"],
    maxCalls: 2,
  };
  const report = await runLocalRelayEffortExperiment({
    options,
    env: { DEEPSEEK_API_KEY: "must-not-be-written" },
    providerFactory: () => provider,
    log: () => {},
  });

  assert.equal(maximumActive, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => (
    call.model === "deepseek-v4-flash"
      && call.reasoningMode === "standard"
      && call.reasoningEffort === "none"
  )));
  assert.equal(report.provider, "deepseek");
  assert.equal(report.reasoningMode, "standard");
  assert.equal(report.concurrency, 1);
  assert.equal(report.retries, 0);
  assert.equal(report.results.length, 2);
  assert.ok(report.results.every((result) => (
    result.provider === "deepseek"
      && result.reasoningMode === "standard"
      && result.key.includes("::deepseek-v4-flash::standard::none")
  )));
  assert.doesNotMatch(await readFile(outputPath, "utf8"), /must-not-be-written/u);

  await assert.rejects(
    () => runLocalRelayEffortExperiment({
      options: { ...options, reasoningMode: "pro", efforts: ["high"] },
      env: { DEEPSEEK_API_KEY: "secret" },
      providerFactory: () => provider,
      log: () => {},
    }),
    /different reasoning mode/u,
  );
});

test("DeepSeek frozen workflow runs the four exact configurations one at a time", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /confirm_paid_run:/u);
  const configurationInput = workflow.match(/configuration:([\s\S]*?)confirm_paid_run:/u)?.[1] || "";
  for (const option of ["all-four", "flash-standard", "flash-pro", "pro-standard", "pro-pro"]) {
    assert.match(configurationInput, new RegExp(`^\\s+- ${option}$`, "mu"));
  }
  assert.match(workflow, /fromJSON\(needs\.select-configurations\.outputs\.matrix\)/u);
  assert.match(workflow, /max-parallel: 1/u);
  assert.match(workflow, /fail-fast: false/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /run-id: "31309665167"/u);
  assert.match(workflow, /name: direct-relay-relay-gpt-5\.6-sol-31309665167/u);
  assert.match(workflow, /bc83754cf0b38a5a83817bb9935cd7687b404595fb36f51827a2e9fa29233090/u);

  const expectedConfigurations = [
    ["flash-standard", "deepseek-v4-flash", "standard", "none"],
    ["flash-pro", "deepseek-v4-flash", "pro", "high"],
    ["pro-standard", "deepseek-v4-pro", "standard", "none"],
    ["pro-pro", "deepseek-v4-pro", "pro", "max"],
  ];
  for (const [configuration, model, mode, effort] of expectedConfigurations) {
    assert.ok(workflow.includes(JSON.stringify({
      configuration,
      model,
      reasoning_mode: mode,
      reasoning_effort: effort,
    })));
  }
  assert.equal((workflow.match(/"configuration":"(?:flash-standard|flash-pro|pro-standard|pro-pro)/gu) || []).length, 4);
  assert.equal((workflow.match(/node scripts\/local-relay-effort-experiment\.mjs/gu) || []).length, 1);
  assert.match(workflow, /--provider deepseek/u);
  assert.match(workflow, /--reasoning-mode "\$DEEPSEEK_REASONING_MODE"/u);
  assert.match(workflow, /--effort "\$DEEPSEEK_REASONING_EFFORT"/u);
  assert.match(workflow, /--timeout-ms 300000/u);
  assert.match(workflow, /--max-calls 10/u);
  assert.doesNotMatch(workflow, /--retries|recover-running-as-outcome-unknown|for\s+attempt/iu);
});

test("DeepSeek frozen workflow bypasses Upstash and reuses only its existing admin credential", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["ADMIN_MODEL_LAB_PASSWORD"]);
  assert.equal((workflow.match(/secrets\.ADMIN_MODEL_LAB_PASSWORD/gu) || []).length, 2);
  assert.match(workflow, /ADMIN_MODEL_LAB_PASSWORD GitHub Actions secret is not configured; no request was sent/u);
  assert.match(workflow, /--bridge-url "\$ADMIN_MODEL_LAB_BASE_URL\/api\/admin-frozen-deepseek"/u);
  assert.doesNotMatch(
    workflow,
    /UPSTASH|KV_REST|REDIS|api\/admin-model-lab|DEEPSEEK_API_KEY|RELAY_API_KEY/iu,
  );
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /artifacts\/deepseek-result-checkpoint\.json/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
});
