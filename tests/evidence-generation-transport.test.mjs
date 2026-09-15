import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  convertEvidenceGenerationRequest,
  createEvidenceGenerationTransport,
  DEFAULT_BAI_GENERATION_BASE_URL,
} from "../backend/evidenceGenerationTransport.mjs";

const contract = {
  status: "ready",
  providerId: "bai",
  modelId: "gpt-5.6-luna",
  maxBillableOutputTokens: 1024,
  reasoningConfig: { responses: { effort: "low" } },
  transportContract: { protocol: "responses", endpoint: "/v1/responses" },
  countingContractVersion: "fixture-count-v1",
  capacityContract: { contextCountingContractVersion: "fixture-context-count-v1" },
};

function semanticBody() {
  return {
    systemInstruction: { parts: [{ text: "system" }] },
    contents: [{ role: "user", parts: [{ text: "first" }, { text: "second" }] }],
    generationConfig: { maxOutputTokens: 1024 },
  };
}

function measurement(body) {
  const serialized = JSON.stringify(body);
  return {
    providerId: contract.providerId,
    modelId: contract.modelId,
    generationContractSha256: createHash("sha256").update(stableJson(contract)).digest("hex"),
    requestSha256: createHash("sha256").update(serialized).digest("hex"),
    requestBodyBytes: Buffer.byteLength(serialized),
    inputTokensUpperBound: 100,
    contextInputTokensUpperBound: 100,
    countingContractVersion: contract.countingContractVersion,
    contextCountingContractVersion: contract.capacityContract.contextCountingContractVersion,
    basis: "provider_count",
  };
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

test("B.AI conversion preserves system/user text and freezes the Responses output budget", () => {
  const body = convertEvidenceGenerationRequest(semanticBody(), contract);
  assert.deepEqual(body, {
    model: "gpt-5.6-luna",
    instructions: "system",
    input: [{ role: "user", content: "first\n\nsecond" }],
    stream: false,
    max_output_tokens: 1024,
    reasoning: { effort: "low" },
  });
});

test("B.AI transport remains unavailable while its measurement profile is incomplete", () => {
  assert.throws(() => createEvidenceGenerationTransport({
    contract: { ...contract, status: "incomplete" },
    env: {},
  }), /contract_incomplete/u);
});

test("DeepSeek V4.1 uses the exact B.AI model id without alias routing", () => {
  const deepSeek = {
    ...contract,
    modelId: "DeepSeek-V4.1-Flash",
    reasoningConfig: { responses: { effort: "low" } },
  };
  assert.equal(convertEvidenceGenerationRequest(semanticBody(), deepSeek).model, "DeepSeek-V4.1-Flash");
});

test("B.AI transport blocks an unmeasured request before reading a key or calling fetch", async () => {
  let calls = 0;
  const transport = createEvidenceGenerationTransport({
    contract,
    env: {},
    fetchImpl: async () => { calls += 1; },
  });
  const body = transport.prepareRequest(semanticBody());
  await assert.rejects(transport.invoke(body), /unmeasured_request_blocked/u);
  assert.equal(calls, 0);
});

test("B.AI transport sends one measured Responses request and never substitutes the requested model", async () => {
  const calls = [];
  const transport = createEvidenceGenerationTransport({
    contract,
    env: { BAI_API_KEY: "fixture-key", BAI_BASE_URL: DEFAULT_BAI_GENERATION_BASE_URL },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed",
          model: "gpt-5.6-luna",
          output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 15 },
        }),
      };
    },
  });
  const body = transport.prepareRequest(semanticBody());
  const raw = await transport.invoke(body, { measurement: measurement(body) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.b.ai/v1/responses");
  assert.equal(JSON.parse(calls[0].options.body).model, "gpt-5.6-luna");
  assert.equal(transport.extractText(raw), "{\"ok\":true}");
  assert.deepEqual(transport.rawUsage(raw), raw.usage);
  assert.equal(transport.validateResponse(raw), true);
  assert.throws(() => transport.validateResponse({ ...raw, model: "another-model" }), /response_model_mismatch/u);
});
