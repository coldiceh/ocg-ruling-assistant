import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAdminFrozenDeepseekHandler } from "../api/admin-frozen-deepseek.js";
import {
  authorizeFrozenDeepseekExperimentRequest,
  createFrozenDeepseekExperimentService,
  FrozenDeepseekExperimentBridgeClient,
  normalizeFrozenDeepseekExperimentRequest,
} from "../backend/frozenDeepseekExperimentBridge.mjs";

const workflowUrl = new URL(
  "../.github/workflows/direct-deepseek-frozen-ten-case.yml",
  import.meta.url,
);

function requestBody(overrides = {}) {
  const instructions = overrides.instructions || "Return one JSON ruling.";
  const input = overrides.input || "Frozen final input.";
  return {
    schemaVersion: 1,
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    reasoningEffort: "none",
    instructions,
    input,
    maxOutputTokens: 8192,
    metadata: {
      runId: "frozen-case-1",
      promptVersion: "openai-ruling-v1",
    },
    bindings: {
      instructionsSha256: sha256(instructions),
      finalInputSha256: sha256(input),
    },
    ...overrides,
  };
}

function request({ body = requestBody(), authorization = "admin-secret", origin = "https://coldiceh.github.io" } = {}) {
  return {
    method: "POST",
    headers: {
      authorization: authorization ? `Bearer ${authorization}` : "",
      "content-type": "application/json",
      origin,
    },
    body,
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function completedProviderResponse(overrides = {}) {
  return {
    id: "deepseek-request-1",
    status: "completed",
    model: "deepseek-v4-flash",
    requested_model: "deepseek-v4-flash",
    submitted_model: "deepseek-v4-flash",
    reported_model: "deepseek-v4-flash",
    finish_reason: "stop",
    output_text: JSON.stringify({ verdict: "UNKNOWN" }),
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    provider: "deepseek",
    experimental: true,
    ...overrides,
  };
}

const serverEnv = {
  ADMIN_ALLOWED_ORIGIN: "https://coldiceh.github.io",
  ADMIN_SESSION_PASSWORD: "admin-secret",
  DEEPSEEK_API_KEY: "server-only-deepseek-key",
};

test("frozen DeepSeek bridge uses direct origin-bound Bearer auth without a session store", () => {
  assert.deepEqual(
    authorizeFrozenDeepseekExperimentRequest(request(), serverEnv),
    { ok: true, status: 200, origin: "https://coldiceh.github.io" },
  );
  assert.equal(
    authorizeFrozenDeepseekExperimentRequest(request({ authorization: "" }), serverEnv).status,
    401,
  );
  assert.equal(
    authorizeFrozenDeepseekExperimentRequest(request({ authorization: "wrong" }), serverEnv).status,
    403,
  );
  assert.equal(
    authorizeFrozenDeepseekExperimentRequest(request({ origin: "https://attacker.example" }), serverEnv).status,
    403,
  );
  assert.equal(
    authorizeFrozenDeepseekExperimentRequest(request(), {
      ADMIN_ALLOWED_ORIGIN: serverEnv.ADMIN_ALLOWED_ORIGIN,
    }).status,
    503,
  );
});

test("frozen DeepSeek bridge accepts only the four benchmark configurations and bound final input", () => {
  for (const [model, reasoningMode, reasoningEffort] of [
    ["deepseek-v4-flash", "standard", "none"],
    ["deepseek-v4-flash", "pro", "high"],
    ["deepseek-v4-pro", "standard", "none"],
    ["deepseek-v4-pro", "pro", "max"],
  ]) {
    const normalized = normalizeFrozenDeepseekExperimentRequest(requestBody({
      model,
      reasoningMode,
      reasoningEffort,
    }));
    assert.equal(normalized.model, model);
  }
  assert.throws(
    () => normalizeFrozenDeepseekExperimentRequest(requestBody({ reasoningEffort: "low" })),
    /not allowlisted/u,
  );
  assert.throws(
    () => normalizeFrozenDeepseekExperimentRequest({
      ...requestBody(),
      bindings: { ...requestBody().bindings, finalInputSha256: "0".repeat(64) },
    }),
    /does not match/u,
  );
  assert.throws(
    () => normalizeFrozenDeepseekExperimentRequest({ ...requestBody(), requests: [] }),
    /missing or unsupported fields/u,
  );
});

test("Vercel handler makes exactly one server-owned model call and never returns either secret", async () => {
  let calls = 0;
  const captured = [];
  const handler = createAdminFrozenDeepseekHandler({
    env: serverEnv,
    providerFactory({ apiKey }) {
      assert.equal(apiKey, "server-only-deepseek-key");
      return {
        async runRuling(value) {
          calls += 1;
          captured.push(value);
          return completedProviderResponse({
            serverInternalField: "must-not-cross-bridge",
          });
        },
      };
    },
  });
  const response = responseRecorder();
  await handler(request(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(calls, 1);
  assert.equal(captured[0].model, "deepseek-v4-flash");
  assert.equal(captured[0].reasoningMode, "standard");
  assert.equal(captured[0].reasoningEffort, "none");
  assert.equal(response.body.result.serverInternalField, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /server-only-deepseek-key|admin-secret/u);

  const invalidResponse = responseRecorder();
  await handler(request({ body: { ...requestBody(), unexpected: true } }), invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(calls, 1);

  const oversizedResponse = responseRecorder();
  const oversizedInput = "x".repeat(130 * 1024);
  await handler(request({ body: requestBody({ input: oversizedInput }) }), oversizedResponse);
  assert.equal(oversizedResponse.statusCode, 413);
  assert.equal(calls, 1);
});

test("bridge service fail-closes concurrent calls within one serverless instance", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const service = createFrozenDeepseekExperimentService({
    env: serverEnv,
    providerFactory: () => ({
      async runRuling() {
        await pending;
        return completedProviderResponse();
      },
    }),
  });

  const first = service.run(requestBody());
  await assert.rejects(
    () => service.run(requestBody()),
    (error) => error?.status === 429 && error?.code === "frozen_deepseek_concurrency_limit",
  );
  release();
  assert.equal((await first).status, "completed");
  assert.deepEqual(service.limits, {
    callsPerRequest: 1,
    concurrentCallsPerInstance: 1,
    timeoutMs: 285000,
  });
});

test("serial runner bridge client sends only its admin credential and returns a provider-shaped response", async () => {
  let calls = 0;
  const client = new FrozenDeepseekExperimentBridgeClient({
    bridgeUrl: "https://ocg-ruling-assistant.vercel.app/api/admin-frozen-deepseek",
    password: "workflow-admin-password",
    origin: "https://coldiceh.github.io",
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://ocg-ruling-assistant.vercel.app/api/admin-frozen-deepseek");
      assert.equal(options.headers.authorization, "Bearer workflow-admin-password");
      assert.equal(options.headers.origin, "https://coldiceh.github.io");
      assert.doesNotMatch(options.body, /DEEPSEEK_API_KEY|server-only/u);
      const body = JSON.parse(options.body);
      assert.equal(body.bindings.finalInputSha256, sha256(body.input));
      return new Response(JSON.stringify({
        ok: true,
        result: completedProviderResponse(),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.runRuling({
    model: "deepseek-v4-flash",
    reasoningMode: "standard",
    reasoningEffort: "none",
    instructions: "Return one JSON ruling.",
    input: "Frozen final input.",
    maxOutputTokens: 8192,
    metadata: { runId: "frozen-case-1", promptVersion: "openai-ruling-v1" },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "completed");
});

test("DeepSeek frozen workflow uses the Vercel bridge, checkpoints serially and has no provider key", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["ADMIN_MODEL_LAB_PASSWORD"]);
  assert.match(workflow, /ADMIN_MODEL_LAB_BASE_URL: https:\/\/ocg-ruling-assistant\.vercel\.app/u);
  assert.match(workflow, /ADMIN_MODEL_LAB_ORIGIN: https:\/\/coldiceh\.github\.io/u);
  assert.match(workflow, /--bridge-url "\$ADMIN_MODEL_LAB_BASE_URL\/api\/admin-frozen-deepseek"/u);
  assert.match(workflow, /--bridge-origin "\$ADMIN_MODEL_LAB_ORIGIN"/u);
  assert.match(workflow, /--max-calls 10/u);
  assert.match(workflow, /max-parallel: 1/u);
  assert.match(workflow, /artifacts\/deepseek-result-checkpoint\.json/u);
  assert.doesNotMatch(workflow, /DEEPSEEK_API_KEY|UPSTASH|KV_REST|REDIS|api\/admin-model-lab/iu);
});

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
