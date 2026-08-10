export const DEFAULT_PUBLIC_RULING_MODEL_PROFILE = "relay-gpt-5.6-sol-low";
// The third-party relay endpoint is deployment-specific and intentionally has
// no repository default. Keep the historical export name for internal imports.
export const DEFAULT_PUBLIC_RELAY_BASE_URL = "";
export const DEFAULT_PUBLIC_RELAY_MODEL = "gpt-5.6-sol";

export const PUBLIC_RULING_MODEL_PROFILES = Object.freeze({
  "relay-gpt-5.6-luna-low": Object.freeze({
    id: "relay-gpt-5.6-luna-low",
    label: "GPT-5.6 Luna · 思考 low",
    provider: "relay",
    model: "gpt-5.6-luna",
    thinkingMode: "enabled",
    reasoningEffort: "low",
    transport: "chat_completions_sse",
    thirdParty: true,
    modelIdentityVerified: false,
  }),
  "relay-gpt-5.6-sol-low": Object.freeze({
    id: "relay-gpt-5.6-sol-low",
    label: "GPT-5.6 Sol · 思考 low",
    provider: "relay",
    model: "gpt-5.6-sol",
    thinkingMode: "enabled",
    reasoningEffort: "low",
    transport: "chat_completions_sse",
    thirdParty: true,
    modelIdentityVerified: false,
  }),
  "deepseek-v4-flash-standard": Object.freeze({
    id: "deepseek-v4-flash-standard",
    label: "DeepSeek V4 Flash · standard（实验性）",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingMode: "disabled",
    reasoningEffort: null,
  }),
  "deepseek-v4-flash-low": Object.freeze({
    id: "deepseek-v4-flash-low",
    label: "DeepSeek V4 Flash · 思考 low（实验性）",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingMode: "enabled",
    reasoningEffort: "low",
  }),
  "deepseek-v4-flash-high": Object.freeze({
    id: "deepseek-v4-flash-high",
    label: "DeepSeek V4 Flash · 思考 high（实验性）",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingMode: "enabled",
    reasoningEffort: "high",
  }),
  "deepseek-v4-flash-max": Object.freeze({
    id: "deepseek-v4-flash-max",
    label: "DeepSeek V4 Flash · 思考 max（实验性）",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingMode: "enabled",
    reasoningEffort: "max",
  }),
});

export class PublicRulingModelProfileError extends Error {
  constructor(message, { code = "invalid_ruling_model_profile", statusCode = 400 } = {}) {
    super(message);
    this.name = "PublicRulingModelProfileError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function resolvePublicRulingModelProfile(value) {
  const id = String(value || DEFAULT_PUBLIC_RULING_MODEL_PROFILE).trim().toLowerCase();
  const profile = PUBLIC_RULING_MODEL_PROFILES[id];
  if (!profile) {
    throw new PublicRulingModelProfileError(`Unsupported public ruling model profile: ${id || "(empty)"}`);
  }
  return profile;
}

export function publicRulingModelProfileAvailable(profileOrId, env = {}) {
  const profile = typeof profileOrId === "string"
    ? resolvePublicRulingModelProfile(profileOrId)
    : profileOrId;
  if (profile?.provider === "deepseek") return Boolean(String(env.DEEPSEEK_API_KEY || "").trim());
  if (profile?.provider === "relay") {
    const apiKey = String(env.RELAY_API_KEY || "").trim();
    const baseUrl = String(env.RELAY_BASE_URL || "").trim();
    if (!apiKey || !baseUrl) return false;
    try {
      const parsed = new URL(baseUrl);
      return parsed.protocol === "https:"
        && Boolean(parsed.hostname)
        && !parsed.username
        && !parsed.password
        && !parsed.search
        && !parsed.hash;
    } catch {
      return false;
    }
  }
  return false;
}

export function getPublicRulingModelCapabilities(env = {}) {
  const defaultProfile = resolvePublicRulingModelProfile(env.PUBLIC_RULING_MODEL_PROFILE);
  return {
    defaultRulingModelProfile: defaultProfile.id,
    rulingModelProfiles: Object.values(PUBLIC_RULING_MODEL_PROFILES).map((profile) => ({
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      thinkingMode: profile.thinkingMode,
      reasoningEffort: profile.reasoningEffort,
      transport: profile.transport || "chat_completions",
      ...(profile.thirdParty === true ? { thirdParty: true } : {}),
      ...(profile.modelIdentityVerified === false ? { modelIdentityVerified: false } : {}),
      available: publicRulingModelProfileAvailable(profile, env),
    })),
  };
}

export function assertPublicRulingModelProfileAvailable(profileOrId, env = {}) {
  const profile = typeof profileOrId === "string"
    ? resolvePublicRulingModelProfile(profileOrId)
    : profileOrId;
  const explicitMock = [env.MODEL_PROVIDER, env.RAG_MODEL_PROVIDER]
    .some((value) => String(value || "").trim().toLowerCase() === "mock");
  if (explicitMock || publicRulingModelProfileAvailable(profile, env)) return profile;
  throw new PublicRulingModelProfileError(`${profile.label} is not configured on the server`, {
    code: "ruling_model_profile_unavailable",
    statusCode: 503,
  });
}
