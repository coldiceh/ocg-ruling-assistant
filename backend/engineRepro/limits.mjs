// Separate daily budget bucket and per-minute rate counter for the engine-reproduction section.
// Upstash REST, same store as the rest of the site, own keys; never touches the answer ledger.

export function redisConfigFromEnv(env = {}) {
  for (const [url, token] of [
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["REDIS_REST_API_URL", "REDIS_REST_API_TOKEN"],
  ]) if (env[url] && env[token]) return { url: String(env[url]).trim(), token: String(env[token]).trim() };
  return null;
}

export async function redisCommand(env, fetchImpl, command, timeoutMs = 3000) {
  const redis = redisConfigFromEnv(env);
  if (!redis) throw Object.assign(new Error("engine_repro_store_not_configured"), { code: "engine_repro_store_not_configured" });
  const response = await fetchImpl(redis.url, {
    method: "POST",
    headers: { authorization: `Bearer ${redis.token}`, "content-type": "application/json" },
    body: JSON.stringify(command), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`engine_repro_store_http_${response?.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(String(payload.error));
  return payload?.result;
}

const dayKey = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);
const minuteKey = (nowMs) => new Date(nowMs).toISOString().slice(0, 16);

export function createEngineReproLimits({ env, fetchImpl = globalThis.fetch, now = Date.now, command = redisCommand }) {
  const limitUsd = Number(env.ENGINE_REPRO_DAILY_LIMIT_USD ?? 1);
  const perMinute = Math.max(1, Number(env.ENGINE_REPRO_MAX_PER_MINUTE ?? 6));
  const prefix = `engine-repro:v1:${String(env.PUBLIC_OPENAI_BUDGET_RUN_ID || "default").replace(/[^A-Za-z0-9_-]/gu, "")}`;
  return {
    // One count per reproduction attempt (not per model call).
    async admit() {
      const key = `${prefix}:rate:${minuteKey(now())}`;
      const count = Number(await command(env, fetchImpl, ["INCR", key]));
      if (count === 1) await command(env, fetchImpl, ["EXPIRE", key, "120"]);
      if (count > perMinute) throw Object.assign(new Error("engine_repro_rate_limited"), { code: "engine_repro_rate_limited" });
    },
    // Reserve the worst case before a paid call; refuse when the bucket would exceed its limit.
    async reserve(worstUsd) {
      const key = `${prefix}:budget:${dayKey(now())}`;
      const total = Number(await command(env, fetchImpl, ["INCRBYFLOAT", key, String(worstUsd)]));
      await command(env, fetchImpl, ["EXPIRE", key, "172800"]);
      if (!(total <= limitUsd)) {
        await command(env, fetchImpl, ["INCRBYFLOAT", key, String(-worstUsd)]);
        throw Object.assign(new Error("engine_repro_daily_budget_exceeded"), { code: "engine_repro_daily_budget_exceeded" });
      }
      return { key, reservedUsd: worstUsd };
    },
    async settle(reservation, actualUsd) {
      if (!reservation) return;
      const delta = (Number.isFinite(actualUsd) ? actualUsd : reservation.reservedUsd) - reservation.reservedUsd;
      if (delta) await command(env, fetchImpl, ["INCRBYFLOAT", reservation.key, String(delta)]);
    },
  };
}
