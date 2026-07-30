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

test("public provider remains fixed to DeepSeek while GPT-5.6 owns final rulings", () => {
  assert.equal(PUBLIC_RULING_PROVIDER, "deepseek");
  assert.equal(FINAL_RULING_PROVIDER, "openai");
  assert.equal(DEFAULT_ADMIN_MODEL_LAB_CONFIG.publicRulingProvider, "deepseek");
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

test("DeepSeek capabilities explicitly prohibit final judgment and escalation decisions", () => {
  const selection = resolveAdminModelSelection({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "none",
    reasoningMode: "standard",
    stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
  });
  assert.equal(selection.capability.canMakeFinalRuling, false);
  assert.equal(selection.capability.canDecideEscalation, false);
  assert.deepEqual(selection.capability.allowedStages, ["evidence_preparation"]);
});

test("availability is computed server-side without exposing secrets", () => {
  const capabilities = getAdminModelProviderCapabilities({
    env: {
      ADMIN_OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "secret",
      DEEPSEEK_API_KEY: "secret",
    },
  });
  assert.equal(capabilities.providers.every((provider) => provider.models.every((model) => model.available)), true);
  assert.equal(JSON.stringify(capabilities).includes("secret"), false);
});
