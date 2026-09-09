export const DEFAULT_PUBLIC_RULING_MODEL_PROFILE = "official-astra-low";
export const DEFAULT_PUBLIC_RELAY_BASE_URL = "";
export const DEFAULT_PUBLIC_RELAY_MODEL = "gpt-6-astra";

export const PUBLIC_RULING_MODEL_PROFILES = Object.freeze({
  "official-astra-low": Object.freeze({
    id: "official-astra-low",
    label: "官方 GPT-6 Astra · 思考 low",
    provider: "openai",
    model: "gpt-6-astra",
    thinkingMode: "enabled",
    reasoningEffort: "low",
    transport: "chat_completions_sse",
    thirdParty: false,
    modelIdentityVerified: true,
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
  if (profile?.provider !== "openai") return false;
  return Boolean(
    String(env.OCG_FINAL_OPENAI_API_KEY || "").trim()
    && String(env.PUBLIC_OPENAI_BUDGET_RUN_ID || "").trim()
    && String(env.PUBLIC_OPENAI_BUDGET_LIMIT_USD || "").trim()
    && String(env.PUBLIC_OPENAI_BUDGET_INITIAL_USD || "").trim()
    && configuredBudgetStoreAvailable(env),
  );
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
      transport: profile.transport,
      thirdParty: profile.thirdParty,
      modelIdentityVerified: profile.modelIdentityVerified,
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

function configuredBudgetStoreAvailable(env = {}) {
  return [
    ["UPSTASH_BUDGET_KV_REST_API_URL", "UPSTASH_BUDGET_KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["REDIS_REST_API_URL", "REDIS_REST_API_TOKEN"],
  ].some(([url, token]) => String(env[url] || "").trim() && String(env[token] || "").trim());
}
