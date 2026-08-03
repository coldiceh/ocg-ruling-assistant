export const DEFAULT_PUBLIC_RULING_MODEL_PROFILE = "glm-5.2-high";

export const PUBLIC_RULING_MODEL_PROFILES = Object.freeze({
  "glm-5.2-high": Object.freeze({
    id: "glm-5.2-high",
    label: "GLM 5.2 · 思考 high",
    provider: "glm",
    model: "glm-5.2",
    thinkingMode: "enabled",
    reasoningEffort: "high",
  }),
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
  if (profile?.provider === "glm") return Boolean(String(env.GLM_API_KEY || "").trim());
  if (profile?.provider === "deepseek") return Boolean(String(env.DEEPSEEK_API_KEY || "").trim());
  return false;
}

export function getPublicRulingModelCapabilities(env = {}) {
  return {
    defaultRulingModelProfile: DEFAULT_PUBLIC_RULING_MODEL_PROFILE,
    rulingModelProfiles: Object.values(PUBLIC_RULING_MODEL_PROFILES).map((profile) => ({
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      thinkingMode: profile.thinkingMode,
      reasoningEffort: profile.reasoningEffort,
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
