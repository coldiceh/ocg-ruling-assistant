import assert from "node:assert/strict";
import test from "node:test";
import { getPublicAnswerModelInfo } from "../backend/publicAnswerService.mjs";
import {
  createPublicAnswerModelEnv,
  modelNameForCardExtractionProvider,
  resolveCardExtractionProvider,
} from "../backend/ragModelClient.mjs";

test("public capability reports the card extraction model selected by the runtime resolver", async () => {
  for (const { sourceEnv, expectedProvider, expectedModel } of [{
    expectedProvider: "deepseek",
    expectedModel: "configured-deepseek-card",
    sourceEnv: {
      PUBLIC_RULING_MODEL_PROFILE: "relay-gpt-5.6-sol-low",
      RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
      DEEPSEEK_API_KEY: "synthetic-deepseek-key",
      DEEPSEEK_CARD_MODEL: "configured-deepseek-card",
      RELAY_API_KEY: "synthetic-relay-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
    },
  }, {
    expectedProvider: "relay",
    expectedModel: "gpt-5.6-sol",
    sourceEnv: {
      PUBLIC_RULING_MODEL_PROFILE: "relay-gpt-5.6-sol-low",
      RELAY_API_KEY: "synthetic-relay-key",
      RELAY_BASE_URL: "https://relay.example.test/v1",
    },
  }]) {
    const runtimeEnv = createPublicAnswerModelEnv(sourceEnv);
    const provider = resolveCardExtractionProvider(runtimeEnv).provider;
    const resolvedModel = modelNameForCardExtractionProvider(provider, runtimeEnv);
    const capability = await getPublicAnswerModelInfo({ env: sourceEnv });

    assert.equal(provider, expectedProvider);
    assert.equal(resolvedModel, expectedModel);
    assert.equal(capability.cardNameProvider, provider);
    assert.deepEqual(capability.cardNameModels, [resolvedModel]);
  }
});
