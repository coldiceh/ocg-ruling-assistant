const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_KEY_PREFIX = "admin-final-budget:v1";
const MAX_TIMEOUT_MS = 30_000;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const MONEY_SCALE = 1_000_000;

const PROVIDER_POOLS = Object.freeze({
  deepseek: "deepseek",
  relay: "relay",
  glm: "glm",
  kimi: "kimi",
  openai: "openai",
});

const RESERVE_SCRIPT = String.raw`
-- ADMIN_FINAL_BUDGET_RESERVE_V1
local field = ARGV[1]
local reserve = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local existing = redis.call('HGET', KEYS[1], field)
local used = tonumber(redis.call('HGET', KEYS[1], 'usedMicros') or '0')
if existing then
  local separator = string.find(existing, '|', 1, true)
  local state = separator and string.sub(existing, 1, separator - 1) or existing
  local amount = separator and tonumber(string.sub(existing, separator + 1)) or 0
  return {'EXISTING', state, tostring(amount), tostring(used)}
end
if used + reserve > limit then
  return {'REJECTED', tostring(used), tostring(limit), tostring(reserve)}
end
used = used + reserve
redis.call('HSET', KEYS[1], 'usedMicros', tostring(used), field, 'R|' .. tostring(reserve))
redis.call('EXPIRE', KEYS[1], ttl)
return {'RESERVED', tostring(reserve), tostring(used), tostring(limit)}
`;

const SETTLE_SCRIPT = String.raw`
-- ADMIN_FINAL_BUDGET_SETTLE_V1
local field = ARGV[1]
local actual = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local existing = redis.call('HGET', KEYS[1], field)
local used = tonumber(redis.call('HGET', KEYS[1], 'usedMicros') or '0')
if not existing then
  return {'MISSING', tostring(used)}
end
local separator = string.find(existing, '|', 1, true)
local state = separator and string.sub(existing, 1, separator - 1) or existing
local amount = separator and tonumber(string.sub(existing, separator + 1)) or 0
if state == 'S' then
  return {'EXISTING', state, tostring(amount), tostring(used)}
end
if state == 'X' then
  return {'RELEASED', tostring(used)}
end
if state ~= 'R' then
  return {'INVALID', state, tostring(used)}
end
used = math.max(0, used - amount + actual)
redis.call('HSET', KEYS[1], 'usedMicros', tostring(used), field, 'S|' .. tostring(actual))
redis.call('EXPIRE', KEYS[1], ttl)
return {'SETTLED', tostring(amount), tostring(actual), tostring(used)}
`;

const RELEASE_SCRIPT = String.raw`
-- ADMIN_FINAL_BUDGET_RELEASE_V1
local field = ARGV[1]
local ttl = tonumber(ARGV[2])
local existing = redis.call('HGET', KEYS[1], field)
local used = tonumber(redis.call('HGET', KEYS[1], 'usedMicros') or '0')
if not existing then
  return {'MISSING', tostring(used)}
end
local separator = string.find(existing, '|', 1, true)
local state = separator and string.sub(existing, 1, separator - 1) or existing
local amount = separator and tonumber(string.sub(existing, separator + 1)) or 0
if state == 'X' then
  return {'EXISTING', state, tostring(amount), tostring(used)}
end
if state == 'S' then
  return {'SETTLED', tostring(amount), tostring(used)}
end
if state ~= 'R' then
  return {'INVALID', state, tostring(used)}
end
used = math.max(0, used - amount)
redis.call('HSET', KEYS[1], 'usedMicros', tostring(used), field, 'X|0')
redis.call('EXPIRE', KEYS[1], ttl)
return {'RELEASED', tostring(amount), tostring(used)}
`;

/**
 * Creates the production ledger over the same Upstash/Vercel KV REST
 * credentials used by the admin run store. Each mutation is one Redis Lua
 * transaction; process-local preflight arithmetic is never authoritative.
 */
export function createRedisAdminFinalCallBudgetLedger(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const redis = redisConfig(env, options);
  if (!redis.url || !redis.token || typeof fetchImpl !== "function") {
    throw budgetStorageUnavailable();
  }
  const policy = readPolicy(env, options);
  const timeoutMs = normalizeTimeoutMs(
    options.timeoutMs ?? env.ADMIN_FINAL_BUDGET_REDIS_TIMEOUT_MS,
  );
  const ttlSeconds = normalizeTtlSeconds(
    options.ttlSeconds ?? env.ADMIN_FINAL_BUDGET_TTL_SECONDS,
  );
  const keyPrefix = normalizeKeyPrefix(
    options.keyPrefix ?? env.ADMIN_FINAL_BUDGET_REDIS_KEY_PREFIX,
  );

  return Object.freeze({
    kind: "redis-admin-final-budget",
    persistent: true,
    async reserve(input = {}) {
      const request = normalizeReservation(input, policy);
      const result = await redisBudgetCommand({
        redis,
        fetchImpl,
        timeoutMs,
        command: [
          "EVAL",
          RESERVE_SCRIPT,
          "1",
          budgetKey(keyPrefix, request.pool, request.day),
          reservationField(request.reservationId),
          String(request.reserveMicros),
          String(request.limitMicros),
          String(ttlSeconds),
        ],
        operation: "reserve",
        reservationMayExist: true,
      });
      return parseReserveResult(result, request);
    },
    async settle(input = {}) {
      const request = normalizeSettlement(input, policy);
      const result = await redisBudgetCommand({
        redis,
        fetchImpl,
        timeoutMs,
        command: [
          "EVAL",
          SETTLE_SCRIPT,
          "1",
          budgetKey(keyPrefix, request.pool, request.day),
          reservationField(request.reservationId),
          String(request.actualMicros),
          String(ttlSeconds),
        ],
        operation: "settle",
        reservationMayExist: true,
      });
      return parseSettlementResult(result, request);
    },
    async release(input = {}) {
      const request = normalizeRelease(input, policy);
      const result = await redisBudgetCommand({
        redis,
        fetchImpl,
        timeoutMs,
        command: [
          "EVAL",
          RELEASE_SCRIPT,
          "1",
          budgetKey(keyPrefix, request.pool, request.day),
          reservationField(request.reservationId),
          String(ttlSeconds),
        ],
        operation: "release",
        reservationMayExist: true,
      });
      return parseReleaseResult(result, request);
    },
  });
}

export function createConfiguredAdminFinalCallBudgetLedger(options = {}) {
  return createRedisAdminFinalCallBudgetLedger(options);
}

/** Explicit test/development seam. Never selected from production env. */
export function createMemoryAdminFinalCallBudgetLedger(options = {}) {
  const env = options.env || {};
  const policy = readPolicy(env, options);
  const ledgers = new Map();

  function account(request) {
    const key = `${request.pool}:${request.day}`;
    if (!ledgers.has(key)) ledgers.set(key, { usedMicros: 0, reservations: new Map() });
    return ledgers.get(key);
  }

  return Object.freeze({
    kind: "memory-admin-final-budget",
    persistent: false,
    async reserve(input = {}) {
      const request = normalizeReservation(input, policy);
      const state = account(request);
      const existing = state.reservations.get(request.reservationId);
      if (existing) return reservationResult("existing", request, state, existing.amountMicros);
      if (state.usedMicros + request.reserveMicros > request.limitMicros) {
        throw budgetExceeded(request, state.usedMicros);
      }
      state.usedMicros += request.reserveMicros;
      state.reservations.set(request.reservationId, {
        state: "reserved",
        amountMicros: request.reserveMicros,
      });
      return reservationResult("reserved", request, state, request.reserveMicros);
    },
    async settle(input = {}) {
      const request = normalizeSettlement(input, policy);
      const state = account(request);
      const existing = state.reservations.get(request.reservationId);
      if (!existing) return settlementResult("missing", request, state, 0);
      if (existing.state === "settled") {
        return settlementResult("existing", request, state, existing.amountMicros);
      }
      if (existing.state === "released") {
        return settlementResult("released", request, state, 0);
      }
      state.usedMicros = Math.max(
        0,
        state.usedMicros - existing.amountMicros + request.actualMicros,
      );
      existing.state = "settled";
      existing.amountMicros = request.actualMicros;
      return settlementResult("settled", request, state, request.actualMicros);
    },
    async release(input = {}) {
      const request = normalizeRelease(input, policy);
      const state = account(request);
      const existing = state.reservations.get(request.reservationId);
      if (!existing) return releaseResult("missing", request, state);
      if (existing.state === "released") return releaseResult("existing", request, state);
      if (existing.state === "settled") return releaseResult("settled", request, state);
      state.usedMicros = Math.max(0, state.usedMicros - existing.amountMicros);
      existing.state = "released";
      existing.amountMicros = 0;
      return releaseResult("released", request, state);
    },
    async status({ provider, reservedAt } = {}) {
      const request = normalizeBase({
        provider,
        reservedAt,
        reservationId: "status",
      }, policy);
      const state = account(request);
      return Object.freeze({
        pool: request.pool,
        day: request.day,
        usedCny: fromMicros(state.usedMicros),
        dailyBudgetCny: fromMicros(request.limitMicros),
      });
    },
  });
}

export function adminFinalBudgetPool(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_POOLS[normalized] || null;
}

function readPolicy(env, options) {
  const timezone = String(
    options.timezone ?? env.ADMIN_FINAL_BUDGET_TIMEZONE ?? DEFAULT_TIMEZONE,
  ).trim() || DEFAULT_TIMEZONE;
  assertTimezone(timezone);
  const pools = {};
  for (const pool of Object.values(PROVIDER_POOLS)) {
    const upper = pool.toUpperCase();
    const dailyValue = options.pools?.[pool]?.dailyBudgetCny
      ?? env[`ADMIN_FINAL_BUDGET_${upper}_DAILY_CNY`];
    const reservationValue = options.pools?.[pool]?.reservationCny
      ?? env[`ADMIN_FINAL_BUDGET_${upper}_RESERVATION_CNY`];
    pools[pool] = {
      dailyBudgetMicros: optionalMoneyMicros(dailyValue, { allowZero: true }),
      reservationMicros: optionalMoneyMicros(reservationValue, { allowZero: false }),
    };
  }
  return Object.freeze({ timezone, pools: Object.freeze(pools) });
}

function normalizeReservation(input, policy) {
  const base = normalizeBase(input, policy);
  return {
    ...base,
    reserveMicros: base.poolPolicy.reservationMicros,
  };
}

function normalizeSettlement(input, policy) {
  const base = normalizeBase(input, policy);
  return {
    ...base,
    actualMicros: moneyMicros(input.actualCny, "actualCny", { allowZero: true }),
  };
}

function normalizeRelease(input, policy) {
  return normalizeBase(input, policy);
}

function normalizeBase(input, policy) {
  const provider = requiredText(input.provider, "provider").toLowerCase();
  const pool = adminFinalBudgetPool(provider);
  if (!pool) throw budgetUnconfigured(provider, "provider is not budgeted");
  const poolPolicy = policy.pools[pool];
  if (
    !Number.isSafeInteger(poolPolicy?.dailyBudgetMicros)
    || !Number.isSafeInteger(poolPolicy?.reservationMicros)
  ) {
    throw budgetUnconfigured(
      provider,
      `ADMIN_FINAL_BUDGET_${pool.toUpperCase()}_DAILY_CNY and _RESERVATION_CNY are required`,
    );
  }
  return {
    provider,
    pool,
    poolPolicy,
    reservationId: requiredText(input.reservationId, "reservationId"),
    day: budgetDay(policy.timezone, input.reservedAt),
    limitMicros: poolPolicy.dailyBudgetMicros,
  };
}

function parseReserveResult(result, request) {
  const values = resultArray(result, "reserve");
  if (values[0] === "REJECTED") throw budgetExceeded(request, Number(values[1]));
  if (values[0] === "RESERVED") {
    return reservationResult("reserved", request, { usedMicros: Number(values[2]) }, Number(values[1]));
  }
  if (values[0] === "EXISTING" && ["R", "S"].includes(values[1])) {
    return reservationResult("existing", request, { usedMicros: Number(values[3]) }, Number(values[2]));
  }
  if (values[0] === "EXISTING" && values[1] === "X") {
    throw budgetStateConflict("released reservation cannot be reused");
  }
  throw budgetStateConflict(`unexpected reserve result: ${values.join(":")}`);
}

function parseSettlementResult(result, request) {
  const values = resultArray(result, "settle");
  if (values[0] === "SETTLED") {
    return settlementResult("settled", request, { usedMicros: Number(values[3]) }, Number(values[2]));
  }
  if (values[0] === "EXISTING" && values[1] === "S") {
    return settlementResult("existing", request, { usedMicros: Number(values[3]) }, Number(values[2]));
  }
  if (values[0] === "MISSING") {
    return settlementResult("missing", request, { usedMicros: Number(values[1]) }, 0);
  }
  if (values[0] === "RELEASED") {
    return settlementResult("released", request, { usedMicros: Number(values[1]) }, 0);
  }
  throw budgetStateConflict(`unexpected settle result: ${values.join(":")}`);
}

function parseReleaseResult(result, request) {
  const values = resultArray(result, "release");
  if (values[0] === "RELEASED") {
    return releaseResult("released", request, { usedMicros: Number(values[2]) });
  }
  if (values[0] === "EXISTING" && values[1] === "X") {
    return releaseResult("existing", request, { usedMicros: Number(values[3]) });
  }
  if (values[0] === "SETTLED") {
    return releaseResult("settled", request, { usedMicros: Number(values[2]) });
  }
  if (values[0] === "MISSING") {
    return releaseResult("missing", request, { usedMicros: Number(values[1]) });
  }
  throw budgetStateConflict(`unexpected release result: ${values.join(":")}`);
}

function reservationResult(status, request, account, amountMicros) {
  return Object.freeze({
    status,
    reservationId: request.reservationId,
    provider: request.provider,
    pool: request.pool,
    day: request.day,
    reservedCny: fromMicros(amountMicros),
    usedCny: fromMicros(account.usedMicros),
    dailyBudgetCny: fromMicros(request.limitMicros),
  });
}

function settlementResult(status, request, account, amountMicros) {
  return Object.freeze({
    status,
    reservationId: request.reservationId,
    provider: request.provider,
    pool: request.pool,
    day: request.day,
    settledCny: fromMicros(amountMicros),
    usedCny: fromMicros(account.usedMicros),
  });
}

function releaseResult(status, request, account) {
  return Object.freeze({
    status,
    reservationId: request.reservationId,
    provider: request.provider,
    pool: request.pool,
    day: request.day,
    usedCny: fromMicros(account.usedMicros),
  });
}

async function redisBudgetCommand({
  redis,
  fetchImpl,
  timeoutMs,
  command,
  operation,
  reservationMayExist,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(redis.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${redis.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
  } catch (cause) {
    throw budgetStorageError(operation, cause, { reservationMayExist });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    throw budgetStorageError(operation, new Error(`Redis HTTP ${response?.status || "error"}`), {
      reservationMayExist,
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw budgetStorageError(operation, cause, { reservationMayExist });
  }
  if (payload?.error) {
    throw budgetStorageError(operation, new Error(String(payload.error)), {
      reservationMayExist,
    });
  }
  return payload?.result;
}

function redisConfig(env, options) {
  return {
    url: String(
      options.url
      || env.ADMIN_RUN_REDIS_REST_URL
      || env.UPSTASH_REDIS_REST_URL
      || env.KV_REST_API_URL
      || env.REDIS_REST_API_URL
      || "",
    ).trim(),
    token: String(
      options.token
      || env.ADMIN_RUN_REDIS_REST_TOKEN
      || env.UPSTASH_REDIS_REST_TOKEN
      || env.KV_REST_API_TOKEN
      || env.REDIS_REST_API_TOKEN
      || "",
    ).trim(),
  };
}

function budgetKey(prefix, pool, day) {
  return `${prefix}:{${encodeURIComponent(pool)}}:${day}`;
}

function reservationField(reservationId) {
  return `reservation:${encodeURIComponent(reservationId)}`;
}

function budgetDay(timezone, value) {
  const date = value === undefined || value === null || value === ""
    ? new Date()
    : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("reservedAt must be a valid date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new RangeError(`invalid ADMIN_FINAL_BUDGET_TIMEZONE: ${timezone}`);
  }
}

function optionalMoneyMicros(value, options) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return moneyMicros(value, "budget", options);
}

function moneyMicros(value, field, { allowZero = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0)) {
    throw new RangeError(`${field} must be ${allowZero ? "a non-negative" : "a positive"} CNY amount`);
  }
  const micros = Math.round(amount * MONEY_SCALE);
  if (!Number.isSafeInteger(micros) || (!allowZero && micros < 1)) {
    throw new RangeError(`${field} exceeds the supported precision or range`);
  }
  return micros;
}

function fromMicros(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) / MONEY_SCALE : null;
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_TIMEOUT_MS;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_TIMEOUT_MS) {
    throw new RangeError(`ADMIN_FINAL_BUDGET_REDIS_TIMEOUT_MS must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return number;
}

function normalizeTtlSeconds(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_TTL_SECONDS;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_TTL_SECONDS) {
    throw new RangeError("ADMIN_FINAL_BUDGET_TTL_SECONDS must be a positive integer");
  }
  return number;
}

function normalizeKeyPrefix(value) {
  const prefix = String(value || DEFAULT_KEY_PREFIX).trim() || DEFAULT_KEY_PREFIX;
  if (prefix.length > 160 || /[{}\r\n]/u.test(prefix)) {
    throw new TypeError("invalid ADMIN_FINAL_BUDGET_REDIS_KEY_PREFIX");
  }
  return prefix;
}

function resultArray(result, operation) {
  if (!Array.isArray(result)) throw budgetStateConflict(`${operation} result is not an array`);
  return result.map((value) => String(value));
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} is required`);
  if (text.length > 512 || /[\r\n]/u.test(text)) throw new TypeError(`${field} is invalid`);
  return text;
}

function budgetExceeded(request, usedMicros) {
  const error = new Error(`admin final-call daily budget exceeded for ${request.pool}`);
  error.code = "admin_final_budget_exceeded";
  error.outcomeKnown = true;
  error.budgetReservationMayExist = false;
  error.details = {
    pool: request.pool,
    day: request.day,
    usedCny: fromMicros(usedMicros),
    reservationCny: fromMicros(request.reserveMicros),
    dailyBudgetCny: fromMicros(request.limitMicros),
  };
  return error;
}

function budgetUnconfigured(provider, reason) {
  const error = new Error(`admin final-call budget is not configured for ${provider}: ${reason}`);
  error.code = "admin_final_budget_unconfigured";
  error.outcomeKnown = true;
  error.budgetReservationMayExist = false;
  return error;
}

function budgetStorageUnavailable() {
  const error = new Error("persistent admin final-call budget storage is not configured");
  error.code = "admin_final_budget_storage_unavailable";
  error.outcomeKnown = true;
  error.budgetReservationMayExist = false;
  return error;
}

function budgetStorageError(operation, cause, { reservationMayExist }) {
  const error = new Error(`admin final-call budget ${operation} failed: ${cause?.message || cause}`);
  error.code = "admin_final_budget_storage_unavailable";
  error.outcomeKnown = true;
  error.budgetReservationMayExist = reservationMayExist === true;
  error.cause = cause;
  return error;
}

function budgetStateConflict(message) {
  const error = new Error(`admin final-call budget state conflict: ${message}`);
  error.code = "admin_final_budget_state_conflict";
  error.outcomeKnown = true;
  error.budgetReservationMayExist = true;
  return error;
}
