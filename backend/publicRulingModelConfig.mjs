export const DEFAULT_PUBLIC_RULING_MODEL_PROFILE = "official-astra-low";
export const DEFAULT_PUBLIC_RELAY_BASE_URL = "";
export const DEFAULT_PUBLIC_RELAY_MODEL = "gpt-6-astra";
export const DEFAULT_PUBLIC_DEEPSEEK_MODEL = "deepseek-v4.1-flash-expires-on-0910";
export const DEFAULT_PUBLIC_GLM_MODEL = "glm-5.3";

function profile({ id, label, provider, model, thinkingMode, reasoningEffort, transport, thirdParty, modelIdentityVerified }) {
  return Object.freeze({ id, label, provider, model, thinkingMode, reasoningEffort, transport, thirdParty, modelIdentityVerified });
}

const profiles = [
  profile({ id: "official-astra-low", label: "官方 GPT-6 Astra · 思考 low", provider: "openai", model: "gpt-6-astra", thinkingMode: "enabled", reasoningEffort: "low", transport: "chat_completions_sse", thirdParty: false, modelIdentityVerified: true }),
  ...["low", "medium", "high", "xhigh", "max"].flatMap((reasoningEffort) => [
    profile({ id: `relay-gpt-5.6-sol-${reasoningEffort}`, label: `中转 GPT-5.6 Sol · 思考 ${reasoningEffort}`, provider: "relay", model: "gpt-5.6-sol", thinkingMode: "enabled", reasoningEffort, transport: "chat_completions_sse", thirdParty: true, modelIdentityVerified: false }),
    profile({ id: `relay-gpt-6-astra-${reasoningEffort}`, label: `中转 GPT-6 Astra · 思考 ${reasoningEffort}`, provider: "relay", model: "gpt-6-astra", thinkingMode: "enabled", reasoningEffort, transport: "chat_completions_sse", thirdParty: true, modelIdentityVerified: false }),
  ]),
  ...[["none", "disabled", null], ["low", "enabled", "low"], ["high", "enabled", "high"], ["max", "enabled", "max"]]
    .map(([suffix, thinkingMode, reasoningEffort]) => profile({ id: `deepseek-v4.1-flash-${suffix}`, label: `DeepSeek V4.1 Flash 测试版 · 思考 ${suffix}`, provider: "deepseek", model: DEFAULT_PUBLIC_DEEPSEEK_MODEL, thinkingMode, reasoningEffort, transport: "chat_completions", thirdParty: true, modelIdentityVerified: false })),
  ...[["low", "enabled", "low"], ["high", "enabled", "high"], ["max", "enabled", "max"]]
    .map(([suffix, thinkingMode, reasoningEffort]) => profile({ id: `glm-5.3-${suffix}`, label: `GLM-5.3 · 思考 ${suffix}`, provider: "glm", model: DEFAULT_PUBLIC_GLM_MODEL, thinkingMode, reasoningEffort, transport: "chat_completions", thirdParty: true, modelIdentityVerified: true })),
];

export const PUBLIC_RULING_MODEL_PROFILES = Object.freeze(Object.fromEntries(profiles.map((item) => [item.id, item])));

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
  const selected = PUBLIC_RULING_MODEL_PROFILES[id];
  if (!selected) throw new PublicRulingModelProfileError(`Unsupported public ruling model profile: ${id || "(empty)"}`);
  return selected;
}

export function configuredPublicRulingModelProfile(profileOrId, env = {}) {
  const selected = typeof profileOrId === "string" ? resolvePublicRulingModelProfile(profileOrId) : profileOrId;
  if (selected?.provider !== "deepseek") return selected;
  const configuredModel = String(env.PUBLIC_DEEPSEEK_MODEL || "").trim();
  return configuredModel ? {
    ...selected,
    label: selected.label.replace(" 测试版", ""),
    model: configuredModel,
  } : selected;
}

export function publicRulingModelProfileAvailable(profileOrId, env = {}) {
  const selected = configuredPublicRulingModelProfile(profileOrId, env);
  if (selected?.provider === "openai") {
    return Boolean(String(env.OCG_FINAL_OPENAI_API_KEY || "").trim()
      && String(env.PUBLIC_OPENAI_BUDGET_RUN_ID || "").trim()
      && String(env.PUBLIC_OPENAI_BUDGET_LIMIT_USD || "").trim()
      && String(env.PUBLIC_OPENAI_BUDGET_INITIAL_USD || "").trim()
      && configuredBudgetStoreAvailable(env));
  }
  if (selected?.provider === "relay") return Boolean(String(env.RELAY_API_KEY || "").trim() && validHttpsRelayBaseUrl(env.RELAY_BASE_URL));
  if (selected?.provider === "deepseek") return Boolean(String(env.DEEPSEEK_API_KEY || "").trim());
  if (selected?.provider === "glm") return Boolean(String(env.GLM_API_KEY || "").trim());
  return false;
}

export function getPublicRulingModelCapabilities(env = {}) {
  const defaultProfile = resolvePublicRulingModelProfile(env.PUBLIC_RULING_MODEL_PROFILE);
  return {
    defaultRulingModelProfile: defaultProfile.id,
    rulingModelProfiles: Object.values(PUBLIC_RULING_MODEL_PROFILES).map((item) => {
      const selected = configuredPublicRulingModelProfile(item, env);
      return { ...selected, available: publicRulingModelProfileAvailable(selected, env) };
    }),
  };
}

export function assertPublicRulingModelProfileAvailable(profileOrId, env = {}) {
  const selected = configuredPublicRulingModelProfile(profileOrId, env);
  const explicitMock = [env.MODEL_PROVIDER, env.RAG_MODEL_PROVIDER].some((value) => String(value || "").trim().toLowerCase() === "mock");
  if (explicitMock || publicRulingModelProfileAvailable(selected, env)) return selected;
  throw new PublicRulingModelProfileError(`${selected.label} is not configured on the server`, { code: "ruling_model_profile_unavailable", statusCode: 503 });
}

function validHttpsRelayBaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function configuredBudgetStoreAvailable(env = {}) {
  return [["UPSTASH_BUDGET_KV_REST_API_URL", "UPSTASH_BUDGET_KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], ["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["REDIS_REST_API_URL", "REDIS_REST_API_TOKEN"]]
    .some(([url, token]) => String(env[url] || "").trim() && String(env[token] || "").trim());
}
