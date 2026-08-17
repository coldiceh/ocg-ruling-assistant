import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_MODEL_LAB_STAGES,
  DEFAULT_ADMIN_MODEL_LAB_CONFIG,
  FINAL_RULING_PROVIDER,
  OPENAI_REASONING_EFFORTS,
  OPENAI_REASONING_MODES,
  PUBLIC_RULING_PROVIDER,
  getAdminModelProviderCapabilities,
  readAdminModelLabConfig,
  readNullableNonNegativeNumber,
  resolveAdminModelSelection,
} from "../backend/adminModelLabConfig.mjs";

test("public final-provider identity stays unchanged while preparation defaults to Relay", () => {
  assert.equal(PUBLIC_RULING_PROVIDER, "relay");
  assert.equal(FINAL_RULING_PROVIDER, "openai");
  assert.equal(DEFAULT_ADMIN_MODEL_LAB_CONFIG.publicRulingProvider, "relay");
  assert.equal(DEFAULT_ADMIN_MODEL_LAB_CONFIG.preparationProvider, "relay");
  assert.equal(DEFAULT_ADMIN_MODEL_LAB_CONFIG.defaultPreparationModel, "relay-gpt-5.6-sol");
  assert.equal(DEFAULT_ADMIN_MODEL_LAB_CONFIG.defaultPreparationReasoningEffort, "low");
  assert.equal(DEFAULT_ADMIN_MODEL_LAB_CONFIG.finalRulingProvider, "openai");
});

test("model lab limits default off and null is distinct from zero", () => {
  const defaults = readAdminModelLabConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.limitsEnabled, false);
  assert.equal(defaults.limits.maxRuntimeMs, null);
  assert.equal(defaults.limits.maxOutputTokens, null);

  const configured = readAdminModelLabConfig({
    ADMIN_MODEL_LAB_ENABLED: "true",
    ADMIN_MODEL_LAB_LIMITS_ENABLED: "true",
    ADMIN_MODEL_LAB_MAX_RUNTIME_MS: "0",
    ADMIN_MODEL_LAB_MAX_OUTPUT_TOKENS: "0",
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.limitsEnabled, true);
  assert.equal(configured.limits.maxRuntimeMs, 0);
  assert.equal(configured.limits.maxOutputTokens, 0);
  assert.notEqual(configured.limits.maxRuntimeMs, null);
  assert.equal(readNullableNonNegativeNumber(""), null);
  assert.equal(readNullableNonNegativeNumber("0"), 0);
  assert.throws(() => readNullableNonNegativeNumber("-1"), /non-negative/u);
});

test("GPT-5.6 alias is resolved server-side and all documented effort/mode choices are filtered", () => {
  const selection = resolveAdminModelSelection({
    provider: "openai",
    model: "gpt-5.6",
    reasoningEffort: "max",
    reasoningMode: "pro",
    stage: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
  });
  assert.equal(selection.requestedModel, "gpt-5.6");
  assert.equal(selection.model, "gpt-5.6-sol");
  assert.deepEqual(selection.capability.supportedReasoningEfforts, OPENAI_REASONING_EFFORTS);
  assert.deepEqual(selection.capability.supportedReasoningModes, OPENAI_REASONING_MODES);
});

test("arbitrary models and unsupported provider/model/stage combinations are rejected", () => {
  assert.throws(
    () => resolveAdminModelSelection({ provider: "openai", model: "gpt-made-up" }),
    (error) => error.code === "model_not_allowlisted",
  );
  assert.throws(
    () => resolveAdminModelSelection({ provider: "deepseek", model: "gpt-5.6-terra" }),
    (error) => error.code === "provider_model_mismatch",
  );
  assert.throws(
    () => resolveAdminModelSelection({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
    }),
    (error) => error.code === "model_stage_not_allowed",
  );
});

test("DeepSeek final-ruling metadata remains available while Relay replaces evidence preparation", () => {
  assert.throws(
    () => resolveAdminModelSelection({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
    }),
    (error) => error.code === "model_stage_not_allowed",
  );
  const selection = resolveAdminModelSelection({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "none",
    reasoningMode: "standard",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(selection.capability.canMakeFinalRuling, false);
  assert.equal(selection.capability.canDecideEscalation, false);
  assert.deepEqual(selection.capability.allowedStages, ["experimental_final_ruling"]);
  assert.equal(selection.capability.canMakeExperimentalRuling, true);
  assert.deepEqual(selection.capability.supportedReasoningEfforts, ["none", "low", "high", "max"]);
  assert.equal(selection.capability.preferredComparisonReasoningEffort, "low");
  assert.deepEqual(selection.capability.supportedReasoningModes, ["standard", "pro"]);
  const thinkingSelection = resolveAdminModelSelection({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max",
    reasoningMode: "pro",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(thinkingSelection.reasoningEffort, "max");
  assert.equal(thinkingSelection.reasoningMode, "pro");
  assert.throws(
    () => resolveAdminModelSelection({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
    }),
    (error) => error.code === "reasoning_effort_requires_thinking",
  );
});

test("availability is computed server-side without exposing secrets", () => {
  const capabilities = getAdminModelProviderCapabilities({
    env: {
      ADMIN_OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "secret",
      DEEPSEEK_API_KEY: "secret",
    },
  });
  assert.equal(capabilities.providers.find((provider) => provider.providerId === "openai").available, true);
  const deepSeek = capabilities.providers.find((provider) => provider.providerId === "deepseek");
  assert.equal(deepSeek.available, true);
  assert.equal(deepSeek.models.some((model) => model.allowedStages.includes("evidence_preparation")), false);
  assert.equal(capabilities.providers.find((provider) => provider.providerId === "glm").available, false);
  assert.equal(capabilities.providers.find((provider) => provider.providerId === "kimi").available, false);
  assert.equal(JSON.stringify(capabilities).includes("secret"), false);
});

test("GLM and Kimi are allowlisted only for experimental final rulings with model-specific thinking", () => {
  const glm = resolveAdminModelSelection({
    provider: "glm",
    model: "glm-5.2",
    reasoningEffort: "high",
    reasoningMode: "pro",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(glm.capability.canMakeFinalRuling, false);
  assert.equal(glm.capability.canDecideEscalation, false);

  const kimiK2 = resolveAdminModelSelection({
    provider: "kimi",
    model: "kimi-k2.6",
    reasoningEffort: "none",
    reasoningMode: "standard",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(kimiK2.capability.thinkingControl, "optional");

  const kimiK3 = resolveAdminModelSelection({
    provider: "kimi",
    model: "kimi-k3",
    reasoningEffort: "max",
    reasoningMode: "pro",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(kimiK3.capability.thinkingControl, "always_on");
  assert.deepEqual(kimiK3.capability.supportedReasoningEfforts, ["low", "high", "max"]);
  assert.equal(kimiK3.capability.defaultReasoningEffort, "max");
  assert.deepEqual(
    resolveAdminModelSelection({
      provider: "kimi",
      model: "kimi-k3",
      stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
    }),
    kimiK3,
  );
  const defaultGlm = resolveAdminModelSelection({
    provider: "glm",
    model: "glm-5.2",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(defaultGlm.reasoningEffort, "max");
  assert.equal(defaultGlm.reasoningMode, "pro");
  assert.throws(
    () => resolveAdminModelSelection({
      provider: "kimi",
      model: "kimi-k3",
      reasoningEffort: "max",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
    }),
    (error) => error.code === "reasoning_mode_not_supported",
  );
  assert.throws(
    () => resolveAdminModelSelection({
      provider: "glm",
      model: "glm-5.2",
      reasoningEffort: "none",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
    }),
    (error) => error.code === "model_stage_not_allowed",
  );
});

test("GLM and Kimi availability uses server keys and never returns them", () => {
  const capabilities = getAdminModelProviderCapabilities({
    env: {
      GLM_API_KEY: "glm-secret",
      KIMI_API_KEY: "kimi-secret",
    },
  });
  assert.equal(capabilities.providers.find((provider) => provider.providerId === "glm").available, true);
  assert.equal(capabilities.providers.find((provider) => provider.providerId === "kimi").available, true);
  assert.equal(JSON.stringify(capabilities).includes("glm-secret"), false);
  assert.equal(JSON.stringify(capabilities).includes("kimi-secret"), false);
});

test("third-party relay exposes distinct experimental Sol Terra and Luna aliases", () => {
  const preparation = resolveAdminModelSelection({
    provider: "relay",
    model: "relay-gpt-5.6-sol",
    reasoningEffort: "low",
    reasoningMode: "pro",
    stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
  });
  assert.equal(preparation.model, "gpt-5.6-sol");
  assert.equal(preparation.reasoningEffort, "low");

  const selection = resolveAdminModelSelection({
    provider: "relay",
    model: "relay-gpt-5.6-terra",
    reasoningEffort: "high",
    reasoningMode: "pro",
    stage: ADMIN_MODEL_LAB_STAGES.EXPERIMENTAL_FINAL_RULING,
  });
  assert.equal(selection.requestedModel, "relay-gpt-5.6-terra");
  assert.equal(selection.model, "gpt-5.6-terra");
  assert.equal(selection.capability.thirdParty, true);
  assert.equal(selection.capability.modelIdentityVerified, false);
  assert.equal(selection.capability.canMakeFinalRuling, false);

  const capabilities = getAdminModelProviderCapabilities({
    env: {
      RELAY_API_KEY: "relay-secret",
      RELAY_BASE_URL: "https://relay.example/v1",
    },
  });
  const relay = capabilities.providers.find((provider) => provider.providerId === "relay");
  assert.equal(relay.available, true);
  assert.deepEqual(
    relay.models.map((model) => model.modelId),
    ["relay-gpt-5.6-sol", "relay-gpt-5.6-terra", "relay-gpt-5.6-luna"],
  );
  assert.equal(JSON.stringify(capabilities).includes("relay-secret"), false);
  assert.equal(
    getAdminModelProviderCapabilities({
      env: { RELAY_API_KEY: "secret" },
    }).providers.find((provider) => provider.providerId === "relay").available,
    false,
  );
  assert.equal(
    getAdminModelProviderCapabilities({
      env: { RELAY_API_KEY: "secret", RELAY_BASE_URL: "http://relay.example/v1" },
    }).providers.find((provider) => provider.providerId === "relay").available,
    false,
  );
});
