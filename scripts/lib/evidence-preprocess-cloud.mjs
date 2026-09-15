import {
  createRedisEvidencePreprocessBudget,
  createRedisEvidencePreprocessCache,
  initializeRedisEvidencePreprocessLedger,
  readRedisEvidencePreprocessLedger,
} from "./evidence-preprocess-cache.mjs";

export function createUpstashRedisCommand({ url, token, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = new URL(requiredText(url, "evidence_preprocess_redis_url_required"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || typeof fetchImpl !== "function") {
    throw new Error("evidence_preprocess_redis_configuration_invalid");
  }
  const bearer = requiredText(token, "evidence_preprocess_redis_token_required");
  return async (args) => {
    if (!Array.isArray(args) || !args.length) throw new Error("evidence_preprocess_redis_command_invalid");
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`evidence_preprocess_redis_http_${response.status}`);
    if (!payload || payload.error || !("result" in payload)) throw new Error("evidence_preprocess_redis_response_invalid");
    return payload.result;
  };
}

export async function createCloudEvidencePreprocessResources({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const { redis, authorizationId, ledgerKey, cacheNamespace } = cloudConfig(env);
  const maxUsd = Number(env.EVIDENCE_PREPROCESS_MAX_USD);
  if (!(maxUsd > 0)) throw new Error("evidence_preprocess_max_usd_required");
  const command = createUpstashRedisCommand({ ...redis, fetchImpl });
  await readRedisEvidencePreprocessLedger({ command, ledgerKey, authorizationId });
  return Object.freeze({
    command,
    cache: createRedisEvidencePreprocessCache({ command, namespace: cacheNamespace }),
    budget: createRedisEvidencePreprocessBudget({ command, ledgerKey, authorizationId, maxUsd }),
  });
}

export async function initializeCloudEvidencePreprocessLedger({
  env = process.env,
  ledger,
  fetchImpl = globalThis.fetch,
} = {}) {
  const { redis, authorizationId, ledgerKey } = cloudConfig(env);
  const command = createUpstashRedisCommand({ ...redis, fetchImpl });
  return initializeRedisEvidencePreprocessLedger({ command, ledgerKey, authorizationId, ledger });
}

function cloudConfig(env) {
  return {
    redis: redisConfig(env),
    authorizationId: requiredMatch(
      env.EVIDENCE_PREPROCESS_AUTHORIZATION_ID,
      /^[a-zA-Z0-9._-]{1,160}$/u,
      "evidence_preprocess_authorization_id_required",
    ),
    ledgerKey: requiredMatch(
      env.EVIDENCE_PREPROCESS_LEDGER_KEY,
      /^[a-zA-Z0-9:{}._-]{1,200}$/u,
      "evidence_preprocess_ledger_key_required",
    ),
    cacheNamespace: requiredMatch(
      env.EVIDENCE_PREPROCESS_CACHE_NAMESPACE,
      /^[a-zA-Z0-9._-]{1,160}$/u,
      "evidence_preprocess_cache_namespace_required",
    ),
  };
}

function redisConfig(env) {
  const pairs = [
    ["UPSTASH_BUDGET_KV_REST_API_URL", "UPSTASH_BUDGET_KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["REDIS_REST_API_URL", "REDIS_REST_API_TOKEN"],
  ];
  for (const [urlName, tokenName] of pairs) {
    if (String(env[urlName] || "").trim() && String(env[tokenName] || "").trim()) {
      return { url: env[urlName], token: env[tokenName] };
    }
  }
  throw new Error("evidence_preprocess_redis_credentials_required");
}

function requiredText(value, code) {
  const text = String(value || "").trim();
  if (!text) throw new Error(code);
  return text;
}

function requiredMatch(value, pattern, code) {
  const text = requiredText(value, code);
  if (!pattern.test(text)) throw new Error(code);
  return text;
}
