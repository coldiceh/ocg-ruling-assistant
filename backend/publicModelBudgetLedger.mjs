const DEFAULT_DAILY_BUDGET_CNY = 10;
const DEFAULT_CHATGPT_DAILY_BUDGET_USD = 10;
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const LEDGER_TTL_SECONDS = 172800;
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_REDIS_TOTAL_TIMEOUT_MS = 2_500;
const LEGACY_BUDGET_RECONCILE_LUA = [
  "local current = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "local legacy = math.max(0, tonumber(redis.call('GET', KEYS[2]) or '0'))",
  "local watermark = math.max(0, tonumber(redis.call('GET', KEYS[3]) or '0'))",
  "local mode = ARGV[1]",
  "local cap = tonumber(ARGV[2]) or 0",
  "local ttl = tonumber(ARGV[3]) or 172800",
  "if mode == 'reset' then",
  "  current = 0",
  "elseif mode == 'relay_cap' then",
  "  if legacy > watermark and legacy > 0 then current = math.max(current, cap) end",
  "else",
  "  current = current + math.max(0, legacy - watermark)",
  "end",
  "watermark = math.max(watermark, legacy)",
  "redis.call('SET', KEYS[1], tostring(current), 'EX', ttl)",
  "redis.call('SET', KEYS[3], tostring(watermark), 'EX', ttl)",
  "return tostring(current)",
].join("\n");

export const PUBLIC_MODEL_BUDGET_BUCKETS = Object.freeze([
  Object.freeze({
    id: "evidence_preparation:deepseek",
    stage: "evidence_preparation",
    provider: "deepseek",
    label: "DeepSeek 资料准备",
    currency: "CNY",
    limitEnv: "API_EVIDENCE_DAILY_BUDGET_CNY",
  }),
  // Kept for same-day rolling-deployment status/reset compatibility. The raw
  // public model client cannot select GLM, but older instances may still have
  // written this v2/v3 bucket before the latest version was deployed.
  Object.freeze({
    id: "final_ruling:glm",
    stage: "final_ruling",
    provider: "glm",
    label: "GLM 最终裁定（兼容账本）",
    currency: "CNY",
    limitEnv: "API_GLM_FINAL_DAILY_BUDGET_CNY",
  }),
  Object.freeze({
    id: "final_ruling:deepseek",
    stage: "final_ruling",
    provider: "deepseek",
    label: "DeepSeek 最终裁定",
    currency: "CNY",
    limitEnv: "API_DEEPSEEK_FINAL_DAILY_BUDGET_CNY",
  }),
  Object.freeze({
    id: "final_ruling:relay",
    stage: "final_ruling",
    provider: "relay",
    label: "ChatGPT 最终裁定",
    currency: "USD",
    limitEnv: "API_CHATGPT_DAILY_BUDGET_USD",
  }),
]);

const memoryLedger = new Map();

export async function getPublicModelBudgetStatus({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = budgetConfig(env);
  let storage = resolveStorage(env);
  const totalKey = totalBudgetKey(config.timezone, now);
  if (storage.kind === "unconfigured") {
    return budgetStatus({
      config,
      storage: storage.kind,
      totalKey,
      totalSpent: null,
      buckets: PUBLIC_MODEL_BUDGET_BUCKETS.map((bucket) => bucketStatus({
        bucket,
        config: bucketConfig(bucket, env),
        spent: null,
      })),
      storageError: storage.error || "",
    });
  }

  let totalSpent;
  let buckets;
  try {
    const ioDeadline = createRedisDeadline(env);
    [totalSpent, buckets] = await Promise.all([
      readValue({ storage, key: totalKey, env, fetchImpl, ioDeadline }),
      Promise.all(PUBLIC_MODEL_BUDGET_BUCKETS.map(async (bucket) => {
        const configForBucket = bucketConfig(bucket, env);
        const spent = await readValue({
          storage,
          key: bucketBudgetKey(config.timezone, now, bucket, configForBucket.currency),
          env,
          fetchImpl,
          ioDeadline,
        });
        return bucketStatus({ bucket, config: configForBucket, spent });
      })),
    ]);
  } catch (error) {
    if (!canUseSoftMemoryFallback(config, env)) {
      storage = unavailableStorage(error);
      return budgetStatus({
        config,
        storage: storage.kind,
        totalKey,
        totalSpent: null,
        buckets: PUBLIC_MODEL_BUDGET_BUCKETS.map((bucket) => bucketStatus({
          bucket,
          config: bucketConfig(bucket, env),
          spent: null,
        })),
        storageError: storage.error,
      });
    }
    storage = { kind: "memory", warning: "redis_budget_unavailable_using_memory_soft_limit" };
    const ioDeadline = createRedisDeadline(env);
    [totalSpent, buckets] = await Promise.all([
      readValue({ storage, key: totalKey, env, fetchImpl, ioDeadline }),
      Promise.all(PUBLIC_MODEL_BUDGET_BUCKETS.map(async (bucket) => {
        const configForBucket = bucketConfig(bucket, env);
        const spent = await readValue({
          storage,
          key: bucketBudgetKey(config.timezone, now, bucket, configForBucket.currency),
          env,
          fetchImpl,
          ioDeadline,
        });
        return bucketStatus({ bucket, config: configForBucket, spent });
      })),
    ]);
  }
  return budgetStatus({ config, storage: storage.kind, totalKey, totalSpent, buckets });
}

export async function resetPublicModelBudget({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = budgetConfig(env);
  const storage = resolveStorage(env);
  if (storage.kind === "unconfigured") {
    return getPublicModelBudgetStatus({ env, fetchImpl, now });
  }
  const ioDeadline = createRedisDeadline(env);
  await Promise.all([
    setValue({
      storage,
      key: totalBudgetKey(config.timezone, now),
      value: 0,
      env,
      fetchImpl,
      ioDeadline,
    }),
    ...PUBLIC_MODEL_BUDGET_BUCKETS.map((bucket) => {
      const configForBucket = bucketConfig(bucket, env);
      return setValue({
        storage,
        key: bucketBudgetKey(config.timezone, now, bucket, configForBucket.currency),
        value: 0,
        env,
        fetchImpl,
        ioDeadline,
      });
    }),
  ]);
  return getPublicModelBudgetStatus({ env, fetchImpl, now });
}

export async function reservePublicModelBudget({
  provider,
  stage,
  estimatedAmount = 0,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
  trackSpend = true,
} = {}) {
  const config = budgetConfig(env);
  const bucket = resolveBucket(stage, provider);
  const configForBucket = bucketConfig(bucket, env);
  let storage = resolveStorage(env);
  const amount = roundAmount(Math.max(0, Number(estimatedAmount) || 0));
  const totalKey = totalBudgetKey(config.timezone, now);
  const bucketKey = bucketBudgetKey(config.timezone, now, bucket, configForBucket.currency);
  let base = {
    config,
    bucket,
    bucketConfig: configForBucket,
    storage,
    totalKey,
    bucketKey,
    reservedAmount: 0,
    estimatedAmount: amount,
    warnings: storageWarnings(storage),
  };

  if (storage.kind === "unconfigured") {
    return {
      ...base,
      blocked: trackSpend,
      status: budgetStatusForReservation(base, {
        totalSpent: null,
        bucketSpent: null,
        blocked: trackSpend,
      }),
    };
  }
  if (!trackSpend) {
    return {
      ...base,
      blocked: false,
      status: budgetStatusForReservation(base, {
        totalSpent: 0,
        bucketSpent: 0,
        blocked: false,
      }),
    };
  }
  const ioDeadline = createRedisDeadline(env);
  let current;
  try {
    current = await readBoth({
      storage,
      totalKey,
      bucketKey,
      env,
      fetchImpl,
      ioDeadline,
    });
  } catch (error) {
    if (!canUseSoftMemoryFallback(config, env)) {
      storage = unavailableStorage(error);
      base = {
        ...base,
        storage,
        warnings: unique([...base.warnings, storage.error]),
      };
      return {
        ...base,
        blocked: trackSpend,
        status: budgetStatusForReservation(base, {
          totalSpent: null,
          bucketSpent: null,
          blocked: trackSpend,
        }),
      };
    }
    storage = { kind: "memory", warning: "redis_budget_unavailable_using_memory_soft_limit" };
    base = {
      ...base,
      storage,
      warnings: unique([...base.warnings, storage.warning]),
    };
    current = await readBoth({
      storage,
      totalKey,
      bucketKey,
      env,
      fetchImpl,
      ioDeadline,
    });
  }
  if (amount === 0) {
    const [totalSpent, bucketSpent] = current;
    return {
      ...base,
      blocked: false,
      status: budgetStatusForReservation(base, {
        totalSpent,
        bucketSpent,
        blocked: false,
      }),
    };
  }

  const limits = {
    global: configForBucket.currency === "CNY" ? config.dailyBudgetCny : null,
    bucket: configForBucket.dailyBudget,
  };
  let reservation;
  try {
    reservation = storage.kind === "redis"
      ? await reserveRedis({
          storage,
          totalKey,
          bucketKey,
          amount,
          limits,
          currency: configForBucket.currency,
          env,
          fetchImpl,
          ioDeadline,
        })
      : reserveMemory({
          totalKey,
          bucketKey,
          amount,
          limits,
          currency: configForBucket.currency,
        });
  } catch (error) {
    if (!canUseSoftMemoryFallback(config, env)) {
      storage = unavailableStorage(error);
      base = {
        ...base,
        storage,
        warnings: unique([...base.warnings, storage.error]),
      };
      return {
        ...base,
        blocked: true,
        status: budgetStatusForReservation(base, {
          totalSpent: null,
          bucketSpent: null,
          blocked: true,
        }),
      };
    }
    storage = { kind: "memory", warning: "redis_budget_unavailable_using_memory_soft_limit" };
    base = {
      ...base,
      storage,
      warnings: unique([...base.warnings, storage.warning]),
    };
    reservation = reserveMemory({
      totalKey,
      bucketKey,
      amount,
      limits,
      currency: configForBucket.currency,
    });
  }
  return {
    ...base,
    blocked: reservation.blocked,
    reservedAmount: reservation.blocked ? 0 : amount,
    status: budgetStatusForReservation(base, {
      totalSpent: reservation.totalSpent,
      bucketSpent: reservation.bucketSpent,
      blocked: reservation.blocked,
    }),
  };
}

export async function settlePublicModelBudget({
  reservation,
  actualAmount = 0,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!reservation?.bucket || !reservation?.storage) return null;
  const actual = roundAmount(Math.max(0, Number(actualAmount) || 0));
  const delta = roundAmount(actual - Number(reservation.reservedAmount || 0));
  const appliesToTotal = reservation.bucketConfig?.currency === "CNY";
  const ioDeadline = createRedisDeadline(env);
  if (reservation.storage.kind !== "unconfigured" && delta !== 0) {
    if (appliesToTotal) {
      await addValue({
        storage: reservation.storage,
        key: reservation.totalKey,
        amount: delta,
        env,
        fetchImpl,
        ioDeadline,
      });
    }
    await addValue({
      storage: reservation.storage,
      key: reservation.bucketKey,
      amount: delta,
      env,
      fetchImpl,
      ioDeadline,
    });
  }
  const [totalSpent, bucketSpent] = reservation.storage.kind === "unconfigured"
    ? [null, null]
    : await readBoth({
        storage: reservation.storage,
        totalKey: reservation.totalKey,
        bucketKey: reservation.bucketKey,
        env,
        fetchImpl,
        ioDeadline,
      });
  return budgetStatusForReservation(reservation, {
    totalSpent,
    bucketSpent,
    blocked: false,
    actualAmount: actual,
  });
}

export async function releasePublicModelBudgetReservation({
  reservation,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!reservation?.reservedAmount || reservation.storage?.kind === "unconfigured") {
    return reservation?.status || null;
  }
  const amount = -Math.abs(Number(reservation.reservedAmount));
  const ioDeadline = createRedisDeadline(env);
  if (reservation.bucketConfig?.currency === "CNY") {
    await addValue({
      storage: reservation.storage,
      key: reservation.totalKey,
      amount,
      env,
      fetchImpl,
      ioDeadline,
    });
  }
  await addValue({
    storage: reservation.storage,
    key: reservation.bucketKey,
    amount,
    env,
    fetchImpl,
    ioDeadline,
  });
  const [totalSpent, bucketSpent] = await readBoth({
    storage: reservation.storage,
    totalKey: reservation.totalKey,
    bucketKey: reservation.bucketKey,
    env,
    fetchImpl,
    ioDeadline,
  });
  return budgetStatusForReservation(reservation, {
    totalSpent,
    bucketSpent,
    blocked: false,
    actualAmount: 0,
  });
}

function resolveBucket(stage, provider) {
  const id = `${String(stage || "").trim().toLowerCase()}:${String(provider || "").trim().toLowerCase()}`;
  const bucket = PUBLIC_MODEL_BUDGET_BUCKETS.find((item) => item.id === id);
  if (!bucket) throw new TypeError(`Unsupported public model budget bucket: ${id}`);
  return bucket;
}

function budgetConfig(env) {
  const requestedMode = String(env.API_BUDGET_MODE || "").trim().toLowerCase();
  return {
    dailyBudgetCny: finiteNumber(env.API_DAILY_BUDGET_CNY, DEFAULT_DAILY_BUDGET_CNY),
    timezone: String(env.API_BUDGET_TIMEZONE || DEFAULT_TIMEZONE),
    mode: ["soft", "hard"].includes(requestedMode) ? requestedMode : "soft",
  };
}

function bucketConfig(bucket, env) {
  if (bucket.currency === "USD") {
    const raw = String(env[bucket.limitEnv] ?? "").trim();
    const parsed = raw === "" ? DEFAULT_CHATGPT_DAILY_BUDGET_USD : Number(raw);
    const configured = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_CHATGPT_DAILY_BUDGET_USD;
    return {
      currency: "USD",
      dailyBudget: Math.min(
        Math.max(configured, Number.EPSILON),
        DEFAULT_CHATGPT_DAILY_BUDGET_USD,
      ),
    };
  }
  const raw = String(env[bucket.limitEnv] ?? "").trim();
  const configured = raw === "" ? null : Number(raw);
  return {
    currency: "CNY",
    dailyBudget: Number.isFinite(configured) && configured >= 0 ? configured : null,
  };
}

function resolveStorage(env) {
  const pairs = [
    ["UPSTASH_BUDGET_KV_REST_API_URL", "UPSTASH_BUDGET_KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["REDIS_REST_API_URL", "REDIS_REST_API_TOKEN"],
  ].map(([urlName, tokenName]) => ({
    urlName,
    tokenName,
    url: String(env[urlName] || "").trim(),
    token: String(env[tokenName] || "").trim(),
  }));
  const partial = pairs.filter((pair) => Boolean(pair.url) !== Boolean(pair.token));
  const complete = pairs.filter((pair) => pair.url && pair.token);
  if (partial.length || new Set(complete.map((pair) => `${pair.url}\u0000${pair.token}`)).size > 1) {
    return { kind: "unconfigured", error: "redis_alias_configuration_invalid" };
  }
  if (complete.length) return { kind: "redis", url: complete[0].url, token: complete[0].token };
  if (isEnabled(env.VERCEL) || isEnabled(env.API_BUDGET_REQUIRE_PERSISTENT_STORAGE)) {
    return { kind: "unconfigured", error: "persistent_storage_required" };
  }
  return { kind: "memory" };
}

function requiresPersistentStorage(env) {
  return isEnabled(env.VERCEL) || isEnabled(env.API_BUDGET_REQUIRE_PERSISTENT_STORAGE);
}

function canUseSoftMemoryFallback(config, env) {
  return config?.mode === "soft" && !requiresPersistentStorage(env);
}

function unavailableStorage(error) {
  const message = String(error?.message || error || "");
  return {
    kind: "unavailable",
    // Never expose the Redis URL, vendor body or another infrastructure detail
    // through the public budget endpoint.
    error: /timeout|timed out|aborted/iu.test(message)
      ? "budget_storage_timeout"
      : "budget_storage_unavailable",
  };
}

function reserveMemory({ totalKey, bucketKey, amount, limits, currency }) {
  const totalSpent = Number(memoryLedger.get(totalKey) || 0);
  const bucketSpent = Number(memoryLedger.get(bucketKey) || 0);
  const blocked = exceeds(totalSpent, amount, limits.global)
    || exceeds(bucketSpent, amount, limits.bucket);
  if (blocked) return { blocked, totalSpent, bucketSpent };
  const nextTotal = currency === "CNY" ? roundAmount(totalSpent + amount) : totalSpent;
  const nextBucket = roundAmount(bucketSpent + amount);
  if (currency === "CNY") memoryLedger.set(totalKey, nextTotal);
  memoryLedger.set(bucketKey, nextBucket);
  return { blocked: false, totalSpent: nextTotal, bucketSpent: nextBucket };
}

async function reserveRedis({
  storage,
  totalKey,
  bucketKey,
  amount,
  limits,
  currency,
  env,
  fetchImpl,
  ioDeadline,
}) {
  const script = [
    "local total = math.max(0, tonumber(redis.call('GET', KEYS[1]) or '0'))",
    "local bucket = math.max(0, tonumber(redis.call('GET', KEYS[2]) or '0'))",
    "local amount = math.max(0, tonumber(ARGV[1]) or 0)",
    "local total_limit = tonumber(ARGV[2]) or -1",
    "local bucket_limit = tonumber(ARGV[3]) or -1",
    "local count_total = ARGV[4] == '1'",
    "local blocked = (count_total and total_limit > 0 and total + amount > total_limit) or (bucket_limit > 0 and bucket + amount > bucket_limit)",
    "if blocked then return {1, tostring(total), tostring(bucket)} end",
    "if count_total then total = tonumber(redis.call('INCRBYFLOAT', KEYS[1], amount) or total); redis.call('EXPIRE', KEYS[1], ARGV[5]) end",
    "bucket = tonumber(redis.call('INCRBYFLOAT', KEYS[2], amount) or bucket)",
    "redis.call('EXPIRE', KEYS[2], ARGV[5])",
    "return {0, tostring(total), tostring(bucket)}",
  ].join("\n");
  const result = await redisCommand({
    storage,
    command: [
      "EVAL",
      script,
      "2",
      totalKey,
      bucketKey,
      String(amount),
      limits.global === null ? "-1" : String(limits.global),
      limits.bucket === null ? "-1" : String(limits.bucket),
      currency === "CNY" ? "1" : "0",
      String(LEDGER_TTL_SECONDS),
    ],
    env,
    fetchImpl,
    ioDeadline,
  });
  return {
    blocked: Number(result?.[0]) === 1,
    totalSpent: Number(result?.[1] || 0),
    bucketSpent: Number(result?.[2] || 0),
  };
}

async function readBoth({ storage, totalKey, bucketKey, env, fetchImpl, ioDeadline }) {
  return Promise.all([
    readValue({ storage, key: totalKey, env, fetchImpl, ioDeadline }),
    readValue({ storage, key: bucketKey, env, fetchImpl, ioDeadline }),
  ]);
}

async function readValue({ storage, key, env, fetchImpl, ioDeadline }) {
  const migration = legacyBudgetMigration(key);
  if (storage.kind === "memory") {
    return migration
      ? reconcileLegacyMemoryValue(key, migration)
      : Number(memoryLedger.get(key) || 0);
  }
  if (migration) {
    return reconcileLegacyRedisValue({
      storage,
      key,
      migration,
      env,
      fetchImpl,
      ioDeadline,
    });
  }
  const result = await redisCommand({ storage, command: ["GET", key], env, fetchImpl, ioDeadline });
  return Number(result || 0) || 0;
}

async function reconcileLegacyRedisValue({
  storage,
  key,
  migration,
  env,
  fetchImpl,
  ioDeadline,
  reset = false,
}) {
  const result = await redisCommand({
    storage,
    command: [
      "EVAL",
      LEGACY_BUDGET_RECONCILE_LUA,
      "3",
      key,
      migration.legacyKey,
      legacyWatermarkKey(key),
      reset ? "reset" : migration.mode,
      String(DEFAULT_CHATGPT_DAILY_BUDGET_USD),
      String(LEDGER_TTL_SECONDS),
    ],
    env,
    fetchImpl,
    ioDeadline,
  });
  return Number(result || 0) || 0;
}

function reconcileLegacyMemoryValue(key, migration, { reset = false } = {}) {
  const watermarkKey = legacyWatermarkKey(key);
  let current = Math.max(0, Number(memoryLedger.get(key) || 0));
  const legacy = Math.max(0, Number(memoryLedger.get(migration.legacyKey) || 0));
  const watermark = Math.max(0, Number(memoryLedger.get(watermarkKey) || 0));
  if (reset) {
    current = 0;
  } else if (migration.mode === "relay_cap") {
    if (legacy > watermark && legacy > 0) {
      current = Math.max(current, DEFAULT_CHATGPT_DAILY_BUDGET_USD);
    }
  } else {
    current += Math.max(0, legacy - watermark);
  }
  memoryLedger.set(key, current);
  memoryLedger.set(watermarkKey, Math.max(watermark, legacy));
  return current;
}

function legacyBudgetMigration(key) {
  const total = String(key || "").match(/^rag-api-budget:v3:(\d{4}-\d{2}-\d{2}):cny-total$/u);
  if (total) {
    return {
      legacyKey: `rag-api-budget:${total[1]}`,
      mode: "delta",
    };
  }
  const bucket = String(key || "").match(
    /^rag-api-budget:v3:(\d{4}-\d{2}-\d{2}):(.+):(cny|usd)$/u,
  );
  if (!bucket) return null;
  const [, date, bucketId, currency] = bucket;
  return {
    legacyKey: `rag-api-budget:v2:${date}:${bucketId}`,
    // Legacy Relay values were recorded in CNY. They cannot be converted into
    // the new USD pool without inventing an exchange rate, so any positive
    // same-day legacy Relay spend conservatively consumes the full $10 pool.
    mode: currency === "usd" ? "relay_cap" : "delta",
  };
}

function legacyWatermarkKey(key) {
  return `${key}:legacy-watermark`;
}

async function addValue({ storage, key, amount, env, fetchImpl, ioDeadline }) {
  if (!Number.isFinite(Number(amount)) || Number(amount) === 0) {
    return readValue({ storage, key, env, fetchImpl, ioDeadline });
  }
  if (storage.kind === "memory") {
    const next = Math.max(0, roundAmount(Number(memoryLedger.get(key) || 0) + Number(amount)));
    memoryLedger.set(key, next);
    return next;
  }
  const script = [
    "local next = tonumber(redis.call('INCRBYFLOAT', KEYS[1], ARGV[1]) or '0')",
    "if next < 0 then next = 0; redis.call('SET', KEYS[1], '0') end",
    "redis.call('EXPIRE', KEYS[1], ARGV[2])",
    "return tostring(next)",
  ].join("\n");
  const result = await redisCommand({
    storage,
    command: ["EVAL", script, "1", key, String(amount), String(LEDGER_TTL_SECONDS)],
    env,
    fetchImpl,
    ioDeadline,
  });
  return Number(result || 0) || 0;
}

async function setValue({ storage, key, value, env, fetchImpl, ioDeadline }) {
  const next = Math.max(0, Number(value) || 0);
  const migration = legacyBudgetMigration(key);
  if (migration && next === 0) {
    if (storage.kind === "memory") {
      return reconcileLegacyMemoryValue(key, migration, { reset: true });
    }
    return reconcileLegacyRedisValue({
      storage,
      key,
      migration,
      env,
      fetchImpl,
      ioDeadline,
      reset: true,
    });
  }
  if (storage.kind === "memory") {
    memoryLedger.set(key, next);
    return next;
  }
  await redisCommand({
    storage,
    command: ["SET", key, String(next), "EX", String(LEDGER_TTL_SECONDS)],
    env,
    fetchImpl,
    ioDeadline,
  });
  return next;
}

async function redisCommand({ storage, command, env, fetchImpl, ioDeadline }) {
  if (typeof fetchImpl !== "function") throw new TypeError("budget storage requires fetch");
  const timeoutMs = redisRemainingMs(
    ioDeadline,
    positiveInteger(env.API_BUDGET_REDIS_TIMEOUT_MS, DEFAULT_REDIS_COMMAND_TIMEOUT_MS),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("budget_redis_timeout")), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(storage.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${storage.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`redis ${response.status}`);
    return (await response.json())?.result;
  } finally {
    clearTimeout(timer);
  }
}

function createRedisDeadline(env = {}) {
  const totalTimeoutMs = positiveInteger(
    env.API_BUDGET_REDIS_TOTAL_TIMEOUT_MS,
    DEFAULT_REDIS_TOTAL_TIMEOUT_MS,
  );
  return { expiresAt: Date.now() + totalTimeoutMs };
}

function redisRemainingMs(ioDeadline, commandTimeoutMs) {
  if (!ioDeadline?.expiresAt) return commandTimeoutMs;
  const remaining = Math.floor(ioDeadline.expiresAt - Date.now());
  if (remaining <= 0) throw new Error("budget_redis_total_timeout");
  return Math.max(1, Math.min(commandTimeoutMs, remaining));
}

function budgetStatusForReservation(reservation, {
  totalSpent,
  bucketSpent,
  blocked,
  actualAmount = reservation.estimatedAmount,
}) {
  const currentBucket = bucketStatus({
    bucket: reservation.bucket,
    config: reservation.bucketConfig,
    spent: bucketSpent,
    estimated: actualAmount,
    blocked,
  });
  return {
    ...budgetStatus({
      config: reservation.config,
      storage: reservation.storage.kind,
      totalKey: reservation.totalKey,
      totalSpent,
      buckets: [currentBucket],
      storageError: reservation.storage?.error || "",
    }),
    estimatedThisCallCny: reservation.bucketConfig.currency === "CNY"
      ? roundAmount(actualAmount)
      : 0,
    limitEnforced: blocked,
    bucket: currentBucket,
  };
}

function budgetStatus({ config, storage, totalKey, totalSpent, buckets, storageError = "" }) {
  return {
    schemaVersion: 3,
    currency: "CNY",
    dailyBudgetCny: config.dailyBudgetCny,
    spentTodayCny: totalSpent === null ? null : roundAmount(totalSpent),
    remainingTodayCny: totalSpent === null || config.dailyBudgetCny <= 0
      ? null
      : roundAmount(Math.max(0, config.dailyBudgetCny - totalSpent)),
    estimatedThisCallCny: 0,
    budgetMode: config.mode,
    budgetStorage: storage,
    budgetPersistent: storage === "redis",
    limitEnforced: false,
    dayKey: totalKey,
    timezone: config.timezone,
    buckets,
    ...(["unconfigured", "unavailable"].includes(storage)
      ? { storageWarning: "后端未启用持久化预算存储；公开付费调用已关闭。" }
      : {}),
    ...(storageError ? { storageError } : {}),
  };
}

function bucketStatus({ bucket, config, spent, estimated = 0, blocked = false }) {
  const currency = config.currency;
  const dailyBudget = config.dailyBudget;
  const roundedSpent = spent === null ? null : roundAmount(spent);
  const remaining = roundedSpent === null || dailyBudget === null
    ? null
    : roundAmount(Math.max(0, dailyBudget - roundedSpent));
  const result = {
    id: bucket.id,
    stage: bucket.stage,
    provider: bucket.provider,
    label: bucket.label,
    currency,
    dailyBudget,
    spentToday: roundedSpent,
    remainingToday: remaining,
    estimatedThisCall: roundAmount(estimated),
    limitEnforced: blocked,
  };
  if (currency === "USD") {
    Object.assign(result, {
      dailyBudgetUsd: dailyBudget,
      spentTodayUsd: roundedSpent,
      remainingTodayUsd: remaining,
      estimatedThisCallUsd: roundAmount(estimated),
      dailyBudgetCny: null,
      spentTodayCny: null,
      remainingTodayCny: null,
      estimatedThisCallCny: null,
    });
  } else {
    Object.assign(result, {
      dailyBudgetCny: dailyBudget,
      spentTodayCny: roundedSpent,
      remainingTodayCny: remaining,
      estimatedThisCallCny: roundAmount(estimated),
      dailyBudgetUsd: null,
      spentTodayUsd: null,
      remainingTodayUsd: null,
      estimatedThisCallUsd: null,
    });
  }
  return result;
}

function totalBudgetKey(timezone, now) {
  return `rag-api-budget:v3:${budgetDate(timezone, now)}:cny-total`;
}

function bucketBudgetKey(timezone, now, bucket, currency) {
  return `rag-api-budget:v3:${budgetDate(timezone, now)}:${bucket.id}:${currency.toLowerCase()}`;
}

function budgetDate(timezone, now) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function storageWarnings(storage) {
  if (storage.kind === "unconfigured") {
    return [storage.error || "persistent_budget_storage_missing_backend_kv_required"];
  }
  return storage.warning ? [storage.warning] : [];
}

function exceeds(spent, amount, limit) {
  return limit !== null && Number(limit) > 0 && Number(spent) + Number(amount) > Number(limit);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function roundAmount(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
