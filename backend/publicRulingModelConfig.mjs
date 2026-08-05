export const DEFAULT_PUBLIC_RULING_MODEL_PROFILE = "deepseek-v4-flash-high";
// The third-party relay endpoint is deployment-specific and intentionally has
// no repository default. Keep the historical export name for internal imports.
export const DEFAULT_PUBLIC_RELAY_BASE_URL = "";
export const DEFAULT_PUBLIC_RELAY_MODEL = "gpt-5.6-sol";

export const PUBLIC_RULING_MODEL_PROFILES = Object.freeze({
  "deepseek-v4-flash-high": Object.freeze({
    id: "deepseek-v4-flash-high",
    label: "DeepSeek V4 Flash · 思考 high",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingMode: "enabled",
    reasoningEffort: "high",
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
