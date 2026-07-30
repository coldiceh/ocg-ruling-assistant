export const PUBLIC_RULING_PROVIDER = "deepseek";
export const FINAL_RULING_PROVIDER = "openai";

export const ADMIN_MODEL_LAB_STAGES = Object.freeze({
  EVIDENCE_PREPARATION: "evidence_preparation",
  FINAL_RULING: "final_ruling",
});

export const OPENAI_REASONING_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const OPENAI_REASONING_MODES = Object.freeze([
  "standard",
  "pro",
]);

const OPENAI_MODEL_IDS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

const DEEPSEEK_MODEL_IDS = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
]);

const OPENAI_MODEL_DETAILS = Object.freeze({
  "gpt-5.6-sol": {
    displayName: "GPT-5.6 Sol",
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  "gpt-5.6-terra": {
    displayName: "GPT-5.6 Terra",
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  "gpt-5.6-luna": {
    displayName: "GPT-5.6 Luna",
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
});

const CAPABILITY_TABLE = {
  "gpt-5.6": openAiCapability("gpt-5.6", "gpt-5.6-sol", {
    ...OPENAI_MODEL_DETAILS["gpt-5.6-sol"],
    displayName: "GPT-5.6 (Sol alias)",
    alias: true,
  }),
  ...Object.fromEntries(OPENAI_MODEL_IDS.map((modelId) => [
    modelId,
    openAiCapability(modelId, modelId, OPENAI_MODEL_DETAILS[modelId]),
  ])),
  "deepseek-v4-flash": deepSeekCapability("deepseek-v4-flash", "DeepSeek V4 Flash"),
  "deepseek-v4-pro": deepSeekCapability("deepseek-v4-pro", "DeepSeek V4 Pro"),
};

export const ADMIN_MODEL_CAPABILITY_TABLE = deepFreeze(CAPABILITY_TABLE);

export const DEFAULT_ADMIN_MODEL_LAB_CONFIG = deepFreeze({
  enabled: false,
  openAiEnabled: false,
  publicRulingProvider: PUBLIC_RULING_PROVIDER,
  finalRulingProvider: FINAL_RULING_PROVIDER,
  preparationProvider: "deepseek",
  defaultFinalModel: "gpt-5.6-terra",
  defaultReasoningEffort: "low",
  defaultReasoningMode: "standard",
  limitsEnabled: false,
  limits: {
    maxRuntimeMs: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    maxRunCostUsd: null,
    dailyBudgetUsd: null,
    monthlyBudgetUsd: null,
    maxConcurrency: null,
  },
});

export class UnsupportedModelSelectionError extends Error {
  constructor(message, { code = "unsupported_model_selection", field, value } = {}) {
    super(message);
    this.name = "UnsupportedModelSelectionError";
    this.code = code;
    this.field = field;
    this.value = value;
  }
}

export function readAdminModelLabConfig(env = globalThis.process?.env || {}) {
  return deepFreeze({
    ...DEFAULT_ADMIN_MODEL_LAB_CONFIG,
    enabled: readBoolean(env.ADMIN_MODEL_LAB_ENABLED, false),
    openAiEnabled: readBoolean(env.ADMIN_OPENAI_ENABLED, false),
    limitsEnabled: readBoolean(env.ADMIN_MODEL_LAB_LIMITS_ENABLED, false),
    limits: {
      maxRuntimeMs: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_MAX_RUNTIME_MS),
      maxInputTokens: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_MAX_INPUT_TOKENS),
      maxOutputTokens: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_MAX_OUTPUT_TOKENS),
      maxRunCostUsd: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_MAX_RUN_COST_USD),
      dailyBudgetUsd: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_DAILY_BUDGET_USD),
      monthlyBudgetUsd: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_MONTHLY_BUDGET_USD),
      maxConcurrency: readNullableNonNegativeNumber(env.ADMIN_MODEL_LAB_MAX_CONCURRENCY),
    },
  });
}

export function getAdminModelCapability(modelId) {
  const requested = String(modelId || "").trim();
  const capability = ADMIN_MODEL_CAPABILITY_TABLE[requested];
  if (!capability) {
    throw new UnsupportedModelSelectionError(`Model is not in the server allowlist: ${requested || "(empty)"}`, {
      code: "model_not_allowlisted",
      field: "model",
      value: requested,
    });
  }
  return capability;
}

export function resolveAdminModelSelection({
  model,
  reasoningEffort = "low",
  reasoningMode = "standard",
  stage = ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
  provider,
} = {}) {
  const capability = getAdminModelCapability(model);
  const requestedProvider = provider === undefined || provider === null
    ? capability.providerId
    : String(provider).trim().toLowerCase();

  if (requestedProvider !== capability.providerId) {
    throw new UnsupportedModelSelectionError(
      `Model ${capability.modelId} belongs to ${capability.providerId}, not ${requestedProvider}`,
      { code: "provider_model_mismatch", field: "provider", value: requestedProvider },
    );
  }
  if (!capability.allowedStages.includes(stage)) {
    throw new UnsupportedModelSelectionError(
      `${capability.providerId} model ${capability.modelId} cannot be used for ${stage}`,
      { code: "model_stage_not_allowed", field: "stage", value: stage },
    );
  }
  if (!capability.supportedReasoningEfforts.includes(reasoningEffort)) {
    throw new UnsupportedModelSelectionError(
      `Unsupported reasoning effort for ${capability.modelId}: ${reasoningEffort}`,
      { code: "reasoning_effort_not_supported", field: "reasoningEffort", value: reasoningEffort },
    );
  }
  if (!capability.supportedReasoningModes.includes(reasoningMode)) {
    throw new UnsupportedModelSelectionError(
      `Unsupported reasoning mode for ${capability.modelId}: ${reasoningMode}`,
      { code: "reasoning_mode_not_supported", field: "reasoningMode", value: reasoningMode },
    );
  }

  return deepFreeze({
    requestedModel: capability.modelId,
    model: capability.canonicalModelId,
    provider: capability.providerId,
    reasoningEffort,
    reasoningMode,
    stage,
    capability,
  });
}

export function getAdminModelProviderCapabilities({
  env = globalThis.process?.env || {},
} = {}) {
  const openAiAvailable = readBoolean(env.ADMIN_OPENAI_ENABLED, false) && Boolean(env.OPENAI_API_KEY);
  const deepSeekAvailable = Boolean(env.DEEPSEEK_API_KEY);
  const models = Object.values(ADMIN_MODEL_CAPABILITY_TABLE).map((entry) => ({
    ...entry,
    available: entry.providerId === "openai" ? openAiAvailable : deepSeekAvailable,
  }));

  return deepFreeze({
    publicRulingProvider: PUBLIC_RULING_PROVIDER,
    finalRulingProvider: FINAL_RULING_PROVIDER,
    providers: [
      {
        providerId: "openai",
        role: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
        models: models.filter((entry) => entry.providerId === "openai"),
      },
      {
        providerId: "deepseek",
        role: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
        models: models.filter((entry) => entry.providerId === "deepseek"),
      },
    ],
  });
}

export function readNullableNonNegativeNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`Expected a non-negative number or null, received: ${value}`);
  }
  return parsed;
}

function openAiCapability(modelId, canonicalModelId, details) {
  return {
    providerId: "openai",
    modelId,
    canonicalModelId,
    displayName: details.displayName,
    alias: details.alias === true,
    allowedStages: [ADMIN_MODEL_LAB_STAGES.FINAL_RULING],
    supportedReasoningEfforts: [...OPENAI_REASONING_EFFORTS],
    supportedReasoningModes: [...OPENAI_REASONING_MODES],
    supportsStructuredOutputs: true,
    structuredOutputMode: "json_schema",
    supportsBackground: true,
    supportsRetrieve: true,
    supportsCancel: true,
    supportsStoreFalse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    contextWindowTokens: details.contextWindowTokens,
    maxOutputTokens: details.maxOutputTokens,
    canMakeFinalRuling: true,
    canDecideEscalation: false,
  };
}

function deepSeekCapability(modelId, displayName) {
  return {
    providerId: "deepseek",
    modelId,
    canonicalModelId: modelId,
    displayName,
    alias: false,
    allowedStages: [ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION],
    supportedReasoningEfforts: ["none"],
    supportedReasoningModes: ["standard"],
    supportsStructuredOutputs: false,
    structuredOutputMode: "json_object",
    supportsBackground: false,
    supportsRetrieve: false,
    supportsCancel: false,
    supportsStoreFalse: false,
    supportsStreaming: false,
    supportsPromptCaching: false,
    contextWindowTokens: null,
    maxOutputTokens: null,
    canMakeFinalRuling: false,
    canDecideEscalation: false,
  };
}

function readBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return /^(?:1|true|yes|on)$/iu.test(String(value).trim());
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const ADMIN_OPENAI_MODEL_IDS = OPENAI_MODEL_IDS;
export const ADMIN_DEEPSEEK_MODEL_IDS = DEEPSEEK_MODEL_IDS;
