import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";
import { createEvidenceGenerationTransport } from "../backend/evidenceGenerationTransport.mjs";

const contract = {
  status: "ready",
  providerId: "bai",
  modelId: "gpt-5.6-luna",
  maxBillableOutputTokens: 1024,
  reasoningConfig: { responses: { effort: "high" } },
  responseFormatConfig: { responses: { type: "json_object" } },
  transportContract: { protocol: "responses", endpoint: "/v1/responses" },
  countingContractVersion: "fixture-count-v1",
  capacityContract: { contextCountingContractVersion: "fixture-context-count-v1" },
  measurementContract: {
    status: "user_authorized_theoretical",
    basis: "user_authorized_theoretical",
    exact: false,
    estimator: { version: "fixture-estimator-v1" },
  },
};

const profiles = [
  ["deepseek-v4.1-flash-max", "deepseek"],
  ["glm-5.3-high", "glm"],
  ["bai-astra-low", "bai"],
  ["official-astra-low", "openai"],
];

for (const [profileId, provider] of profiles) {
  for (const dedicated of [false, true]) {
    test(`${profileId} can select evidence with ${dedicated ? "dedicated" : "shared"} B.AI credentials`, async () => {
      const source = {
        RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
        BAI_API_KEY: "shared-fixture-key",
        BAI_BASE_URL: "https://shared.example.invalid/v1",
        BAI_MODEL: "final-model-must-not-select-evidence",
        ...(dedicated ? {
          RAG_EVIDENCE_BAI_API_KEY: "evidence-fixture-key",
          RAG_EVIDENCE_BAI_BASE_URL: "https://evidence.example.invalid/v1",
        } : {}),
      };
      const env = createPublicAnswerModelEnv(source, profileId);
      const calls = [];
      const transport = createEvidenceGenerationTransport({
        contract,
        env,
        fetchImpl: async (url, options) => {
          calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
          return Response.json({ status: "completed", model: contract.modelId, output: [], usage: {} });
        },
      });
      const body = transport.prepareRequest({
        contents: [{ role: "user", parts: [{ text: "Return JSON for this transport fixture." }] }],
      });
      await transport.invoke(body, { measurement: measurement(body) });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://${dedicated ? "evidence" : "shared"}.example.invalid/v1/responses`);
      assert.equal(calls[0].headers.authorization, `Bearer ${dedicated ? "evidence" : "shared"}-fixture-key`);
      assert.equal(calls[0].body.model, "gpt-5.6-luna");
      assert.deepEqual(calls[0].body.reasoning, { effort: "high" });
      assert.equal(env.RAG_MODEL_PROVIDER, provider);
      assert.equal(env.PUBLIC_RULING_MODEL_PROFILE, profileId);
      if (provider !== "bai") {
        assert.equal(env.BAI_API_KEY, undefined);
        assert.equal(env.BAI_BASE_URL, undefined);
        assert.equal(env.BAI_MODEL, undefined);
      }
      assert.equal(source.BAI_API_KEY, "shared-fixture-key");
    });
  }
}

function measurement(body) {
  const serialized = JSON.stringify(body);
  return {
    providerId: contract.providerId,
    modelId: contract.modelId,
    generationContractSha256: hash(stableJson(contract)),
    requestSha256: hash(serialized),
    requestBodyBytes: Buffer.byteLength(serialized),
    inputTokensUpperBound: 100,
    contextInputTokensUpperBound: 100,
    countingContractVersion: contract.countingContractVersion,
    contextCountingContractVersion: contract.capacityContract.contextCountingContractVersion,
    exact: false,
    basis: "user_authorized_theoretical",
    inputTokenAllocationKind: "theoretical_estimate",
    estimatorVersion: contract.measurementContract.estimator.version,
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
