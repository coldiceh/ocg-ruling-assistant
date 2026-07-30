import { createMemoryAdminRunStorage } from "./adminRunStore.mjs";
import { parseAdminEvidenceSnapshot } from "./adminEvidenceSnapshot.mjs";

const DEFAULT_KEY_PREFIX = "admin-runs:v1";
const DEFAULT_TIMEOUT_MS = 1_800;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TTL_SECONDS = 2_147_483_647;
const MAX_SNAPSHOT_CACHE_ENTRIES = 4;
const SNAPSHOT_CANDIDATE_TTL_SECONDS = 300;

const PREPARE_SNAPSHOT_SCRIPT = `
-- admin-run-snapshot-prepare-v1
local existingRaw = redis.call("GET", KEYS[1])
if existingRaw then
  if existingRaw == ARGV[1] then
    return "UNCHANGED"
  end
  return "CONFLICT"
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return "STAGED"
`.trim();

const CREATE_RUN_SCRIPT = `
-- admin-run-create-v1
local currentRunRaw = redis.call("GET", KEYS[1])
local currentEventCount = redis.call("LLEN", KEYS[2])
if currentRunRaw or currentEventCount > 0 then
  if currentRunRaw == ARGV[1]
    and currentEventCount == 1
    and redis.call("LINDEX", KEYS[2], 0) == ARGV[2] then
    if redis.call("EXISTS", KEYS[3]) ~= 1 then
      return "MISSING_SNAPSHOT"
    end
    local existingTtl = tonumber(ARGV[3])
    if existingTtl ~= nil and existingTtl > 0 then
      redis.call("EXPIRE", KEYS[1], existingTtl)
      redis.call("EXPIRE", KEYS[2], existingTtl)
      redis.call("EXPIRE", KEYS[3], existingTtl)
    else
      redis.call("PERSIST", KEYS[1])
      redis.call("PERSIST", KEYS[2])
      redis.call("PERSIST", KEYS[3])
    end
    return "ALREADY_CREATED"
  end
  return "EXISTS"
end
if redis.call("EXISTS", KEYS[3]) ~= 1 then
  return "MISSING_SNAPSHOT"
end

local runOk, run = pcall(cjson.decode, ARGV[1])
local eventOk, event = pcall(cjson.decode, ARGV[2])
if not runOk or not eventOk
  or tostring(run["runId"]) ~= tostring(event["runId"])
  or tonumber(run["revision"]) ~= 1
  or tonumber(run["lastSequence"]) ~= 1
  or tonumber(event["sequence"]) ~= 1 then
  return "INVALID"
end

redis.call("SET", KEYS[1], ARGV[1])
redis.call("RPUSH", KEYS[2], ARGV[2])
local ttl = tonumber(ARGV[3])
if ttl ~= nil and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
  redis.call("EXPIRE", KEYS[2], ttl)
  redis.call("EXPIRE", KEYS[3], ttl)
else
  redis.call("PERSIST", KEYS[1])
  redis.call("PERSIST", KEYS[2])
  redis.call("PERSIST", KEYS[3])
end
return "CREATED"
`.trim();

const COMMIT_RUN_SCRIPT = `
-- admin-run-commit-v1
local currentRaw = redis.call("GET", KEYS[1])
if not currentRaw then
  return "NOT_FOUND"
end
if redis.call("EXISTS", KEYS[3]) ~= 1 then
  return "MISSING_SNAPSHOT"
end

local currentOk, current = pcall(cjson.decode, currentRaw)
local nextOk, nextRun = pcall(cjson.decode, ARGV[2])
local eventOk, event = pcall(cjson.decode, ARGV[3])
if not currentOk or not nextOk or not eventOk then
  return "INVALID"
end

local expectedRevision = tonumber(ARGV[1])
if tonumber(current["revision"]) ~= expectedRevision then
  return "CONFLICT:" .. tostring(current["revision"])
end

local nextRevision = expectedRevision + 1
local nextSequence = tonumber(current["lastSequence"]) + 1
if tostring(current["runId"]) ~= tostring(nextRun["runId"])
  or tostring(current["runId"]) ~= tostring(event["runId"])
  or tonumber(nextRun["revision"]) ~= nextRevision
  or tonumber(nextRun["lastSequence"]) ~= nextSequence
  or tonumber(event["sequence"]) ~= nextSequence then
  return "INVALID"
end

redis.call("SET", KEYS[1], ARGV[2])
redis.call("RPUSH", KEYS[2], ARGV[3])
local ttl = tonumber(ARGV[4])
if ttl ~= nil and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
  redis.call("EXPIRE", KEYS[2], ttl)
  redis.call("EXPIRE", KEYS[3], ttl)
else
  redis.call("PERSIST", KEYS[1])
  redis.call("PERSIST", KEYS[2])
  redis.call("PERSIST", KEYS[3])
end
return "COMMITTED"
`.trim();

const VERIFY_CREATED_RUN_SCRIPT = `
-- admin-run-create-verify-v1
local currentRunRaw = redis.call("GET", KEYS[1])
local firstEventRaw = redis.call("LINDEX", KEYS[2], 0)
local snapshotRaw = redis.call("GET", KEYS[3])
if not currentRunRaw or not firstEventRaw or not snapshotRaw then
  return "NOT_FOUND"
end
if firstEventRaw ~= ARGV[2] or snapshotRaw ~= ARGV[3] then
  return "MISMATCH"
end
if currentRunRaw == ARGV[1] then
  return "MATCH"
end
local currentOk, currentRun = pcall(cjson.decode, currentRunRaw)
local expectedOk, expectedRun = pcall(cjson.decode, ARGV[1])
if not currentOk or not expectedOk
  or tostring(currentRun["runId"]) ~= tostring(expectedRun["runId"])
  or tonumber(currentRun["revision"]) < tonumber(expectedRun["revision"])
  or tonumber(currentRun["lastSequence"]) < tonumber(expectedRun["lastSequence"]) then
  return "MISMATCH"
end
return "MATCH"
`.trim();

/**
 * Persistent admin-run adapter for the Upstash/Vercel KV Redis REST protocol.
 * State and its corresponding event are written in one Lua transaction. Both
 * keys use the same Redis Cluster hash tag so the transaction is cluster-safe.
 */
export function createRedisAdminRunStorage(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const config = redisConfig(env, options);
  if (!config.url || !config.token || typeof fetchImpl !== "function") {
    throw storageUnavailable();
  }

  const ttlSeconds = normalizeTtlSeconds(
    options.ttlSeconds !== undefined ? options.ttlSeconds : env.ADMIN_RUN_TTL_SECONDS,
  );
  const timeoutMs = normalizeTimeoutMs(
    options.timeoutMs !== undefined ? options.timeoutMs : env.ADMIN_RUN_REDIS_TIMEOUT_MS,
  );
  const keyPrefix = normalizeKeyPrefix(
    options.keyPrefix !== undefined ? options.keyPrefix : env.ADMIN_RUN_REDIS_KEY_PREFIX,
  );
  const snapshotCache = new Map();
  const snapshotLoads = new Map();

  async function createRun({ run, event } = {}) {
    validateCommitPair(null, run, event);
    const runId = requiredString(run.runId, "runId");
    const detached = detachEvidenceSnapshot(run);
    const keys = redisKeys(keyPrefix, runId, detached.snapshot.snapshotId);
    const snapshot = await prepareEvidenceSnapshot(keys.snapshot, detached.snapshot);
    const serializedRun = serializeJson(detached.run);
    const serializedEvent = serializeJson(event);
    const serializedSnapshot = serializeJson(snapshot);
    let result;
    try {
      result = await redisCommand(config, fetchImpl, timeoutMs, [
        "EVAL",
        CREATE_RUN_SCRIPT,
        "3",
        keys.run,
        keys.events,
        keys.snapshot,
        serializedRun,
        serializedEvent,
        ttlSeconds === null ? "" : String(ttlSeconds),
      ]);
    } catch (error) {
      if (
        isAmbiguousRedisWriteError(error)
        && await verifyCreatedRun(keys, {
          serializedRun,
          serializedEvent,
          serializedSnapshot,
        })
      ) {
        cacheEvidenceSnapshot(keys.snapshot, snapshot);
        return;
      }
      throw error;
    }
    if (result === "CREATED" || result === "ALREADY_CREATED") {
      cacheEvidenceSnapshot(keys.snapshot, snapshot);
      return;
    }
    if (result === "EXISTS") throw runExists(runId);
    if (result === "MISSING_SNAPSHOT") throw storageCorrupt("create transaction lost evidence snapshot");
    throw unexpectedScriptResult("create", result);
  }

  async function getRun(runId) {
    const id = requiredString(runId, "runId");
    const stateResult = await redisCommand(
      config,
      fetchImpl,
      timeoutMs,
      ["GET", redisKeys(keyPrefix, id).run],
    );
    if (stateResult === null || stateResult === undefined) return null;
    const run = parseStoredJson(stateResult, "run");
    if (String(run?.runId || "") !== id) throw storageCorrupt("stored run id mismatch");
    if (run.evidenceSnapshot && typeof run.evidenceSnapshot === "object") {
      run.evidenceSnapshot = parseStoredEvidenceSnapshot(
        run.evidenceSnapshot,
        run.evidenceSnapshotId || run.evidenceSnapshot.snapshotId,
      );
      return cloneJson(run);
    }
    const snapshotId = requiredString(run.evidenceSnapshotId, "stored evidenceSnapshotId");
    const snapshot = await loadEvidenceSnapshot(
      redisKeys(keyPrefix, id, snapshotId).snapshot,
      snapshotId,
    );
    run.evidenceSnapshot = snapshot;
    return cloneJson(run);
  }

  async function commitRun({
    runId,
    expectedRevision,
    run,
    event,
  } = {}) {
    const id = requiredString(runId, "runId");
    const revision = positiveInteger(expectedRevision, "expectedRevision");
    if (String(run?.runId || "") !== id) throw new Error("admin run id mismatch");
    validateCommitPair({ revision, lastSequence: revision, runId: id }, run, event, {
      checkCurrentSequence: false,
    });
    const detached = detachEvidenceSnapshot(run);
    const keys = redisKeys(keyPrefix, id, detached.snapshot.snapshotId);
    const snapshot = await prepareEvidenceSnapshot(keys.snapshot, detached.snapshot);
    const result = await redisCommand(config, fetchImpl, timeoutMs, [
      "EVAL",
      COMMIT_RUN_SCRIPT,
      "3",
      keys.run,
      keys.events,
      keys.snapshot,
      String(revision),
      serializeJson(detached.run),
      serializeJson(event),
      ttlSeconds === null ? "" : String(ttlSeconds),
    ]);
    if (result === "COMMITTED") {
      cacheEvidenceSnapshot(keys.snapshot, snapshot);
      return;
    }
    if (result === "NOT_FOUND") throw runNotFound(id);
    if (String(result || "").startsWith("CONFLICT:")) throw revisionConflict();
    if (result === "MISSING_SNAPSHOT") throw storageCorrupt("commit transaction lost evidence snapshot");
    throw unexpectedScriptResult("commit", result);
  }

  async function prepareEvidenceSnapshot(snapshotKey, snapshot) {
    const canonicalSnapshot = parseStoredEvidenceSnapshot(
      snapshot,
      snapshot?.snapshotId,
    );
    const serializedSnapshot = serializeJson(canonicalSnapshot);
    const result = await redisCommand(
      config,
      fetchImpl,
      timeoutMs,
      [
        "EVAL",
        PREPARE_SNAPSHOT_SCRIPT,
        "1",
        snapshotKey,
        serializedSnapshot,
        String(SNAPSHOT_CANDIDATE_TTL_SECONDS),
      ],
    );
    if (result === "STAGED" || result === "UNCHANGED") {
      return canonicalSnapshot;
    }
    if (result === "CONFLICT") {
      throw storageCorrupt("stored evidence snapshot conflicts with canonical snapshot identity");
    }
    throw storageCorrupt(`unexpected evidence snapshot prepare result: ${String(result)}`);
  }

  async function verifyCreatedRun(keys, {
    serializedRun,
    serializedEvent,
    serializedSnapshot,
  }) {
    try {
      const result = await redisCommand(config, fetchImpl, timeoutMs, [
        "EVAL",
        VERIFY_CREATED_RUN_SCRIPT,
        "3",
        keys.run,
        keys.events,
        keys.snapshot,
        serializedRun,
        serializedEvent,
        serializedSnapshot,
      ]);
      return result === "MATCH";
    } catch {
      return false;
    }
  }

  async function loadEvidenceSnapshot(snapshotKey, snapshotId) {
    if (snapshotCache.has(snapshotKey)) {
      const cached = snapshotCache.get(snapshotKey);
      snapshotCache.delete(snapshotKey);
      snapshotCache.set(snapshotKey, cached);
      return cloneJson(cached);
    }
    if (snapshotLoads.has(snapshotKey)) {
      return cloneJson(await snapshotLoads.get(snapshotKey));
    }
    const loading = (async () => {
      const snapshotResult = await redisCommand(
        config,
        fetchImpl,
        timeoutMs,
        ["GET", snapshotKey],
      );
      if (snapshotResult === null || snapshotResult === undefined) {
        throw storageCorrupt("stored run evidence snapshot is missing");
      }
      const snapshot = parseStoredEvidenceSnapshot(snapshotResult, snapshotId);
      cacheEvidenceSnapshot(snapshotKey, snapshot);
      return snapshot;
    })();
    snapshotLoads.set(snapshotKey, loading);
    try {
      return cloneJson(await loading);
    } finally {
      snapshotLoads.delete(snapshotKey);
    }
  }

  function cacheEvidenceSnapshot(snapshotKey, snapshot) {
    const canonicalSnapshot = parseStoredEvidenceSnapshot(
      snapshot,
      snapshot?.snapshotId,
    );
    snapshotCache.delete(snapshotKey);
    snapshotCache.set(snapshotKey, cloneJson(canonicalSnapshot));
    while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
      snapshotCache.delete(snapshotCache.keys().next().value);
    }
  }

  async function serverNow() {
    const result = await redisCommand(config, fetchImpl, timeoutMs, ["TIME"]);
    if (!Array.isArray(result) || result.length < 2) {
      throw storageCorrupt("Redis TIME returned an unexpected shape");
    }
    const seconds = Number(result[0]);
    const microseconds = Number(result[1]);
    if (
      !Number.isSafeInteger(seconds)
      || seconds < 0
      || !Number.isInteger(microseconds)
      || microseconds < 0
      || microseconds > 999_999
    ) {
      throw storageCorrupt("Redis TIME returned invalid values");
    }
    const milliseconds = (seconds * 1_000) + Math.floor(microseconds / 1_000);
    if (!Number.isSafeInteger(milliseconds)) {
      throw storageCorrupt("Redis TIME is outside the supported date range");
    }
    return new Date(milliseconds);
  }

  async function readEvents({
    runId,
    afterSequence = 0,
    limit = null,
  } = {}) {
    const id = requiredString(runId, "runId");
    const cursor = nonNegativeInteger(afterSequence ?? 0, "afterSequence");
    const normalizedLimit = limit === null || limit === undefined
      ? null
      : nonNegativeInteger(limit, "limit");
    if (normalizedLimit === 0) return [];

    // Sequence 1 is list index 0, so the first event after N is index N.
    const start = cursor;
    const stop = normalizedLimit === null ? -1 : start + normalizedLimit - 1;
    const result = await redisCommand(config, fetchImpl, timeoutMs, [
      "LRANGE",
      redisKeys(keyPrefix, id).events,
      String(start),
      String(stop),
    ]);
    if (!Array.isArray(result)) throw storageCorrupt("event list is not an array");
    const events = result.map((value) => parseStoredJson(value, "event"));
    for (let index = 0; index < events.length; index += 1) {
      const expectedSequence = cursor + index + 1;
      if (String(events[index]?.runId || "") !== id || events[index]?.sequence !== expectedSequence) {
        throw storageCorrupt("event sequence is not contiguous");
      }
    }
    return cloneJson(events);
  }

  return Object.freeze({
    kind: "redis-rest",
    persistent: true,
    ttlSeconds,
    createRun,
    getRun,
    commitRun,
    readEvents,
    serverNow,
  });
}

/**
 * Selects persistent storage from deployment configuration. Memory storage is
 * available only through an explicit mode/option; missing Redis credentials do
 * not silently create a process-local run store.
 */
export function createConfiguredAdminRunStorage(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const requestedMode = String(options.mode ?? env.ADMIN_RUN_STORAGE ?? "redis")
    .trim()
    .toLowerCase();
  const allowMemoryStore = options.allowMemoryStore === true;

  if (requestedMode === "memory") {
    if (!allowMemoryStore) throw memoryStoreForbidden();
    return configuredMemoryStorage(options.memoryStorageFactory);
  }
  if (!["auto", "redis", "redis-rest", "upstash", "kv"].includes(requestedMode)) {
    throw new RangeError(`unsupported admin run storage mode: ${requestedMode || "(empty)"}`);
  }

  const config = redisConfig(env, options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (config.url && config.token && typeof fetchImpl === "function") {
    return createRedisAdminRunStorage({ ...options, env, fetchImpl });
  }
  throw storageUnavailable();
}

function configuredMemoryStorage(factory = createMemoryAdminRunStorage) {
  if (typeof factory !== "function") throw new TypeError("memoryStorageFactory must be a function");
  const storage = factory();
  for (const method of ["createRun", "getRun", "commitRun", "readEvents"]) {
    if (typeof storage?.[method] !== "function") {
      throw new TypeError(`admin run memory storage is missing ${method}()`);
    }
  }
  return Object.freeze({
    ...storage,
    kind: "memory",
    persistent: false,
    ttlSeconds: null,
  });
}

async function redisCommand(config, fetchImpl, timeoutMs, command) {
  const controller = new AbortController();
  const timeoutError = new Error("admin run Redis request timed out");
  timeoutError.code = "admin_run_redis_timeout";
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    const wrapped = new Error(`admin run Redis request failed: ${error?.message || "unknown error"}`);
    wrapped.code = "admin_run_redis_request_failed";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  if (!response?.ok) {
    const error = new Error(`admin run Redis HTTP ${response?.status || "error"}`);
    error.code = "admin_run_redis_http_error";
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw storageCorrupt("Redis response is not JSON");
  }
  if (payload?.error) {
    const error = new Error(`admin run Redis error: ${String(payload.error)}`);
    error.code = "admin_run_redis_error";
    throw error;
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

function redisKeys(prefix, runId, snapshotId = "") {
  const hashTag = encodeURIComponent(runId);
  return {
    run: `${prefix}:{${hashTag}}:state`,
    events: `${prefix}:{${hashTag}}:events`,
    snapshot: snapshotId
      ? `${prefix}:{${hashTag}}:snapshot:${encodeURIComponent(snapshotId)}`
      : "",
  };
}

function detachEvidenceSnapshot(run) {
  const snapshot = run?.evidenceSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("admin run evidenceSnapshot is required");
  }
  const canonicalSnapshot = parseAdminEvidenceSnapshot(snapshot);
  const snapshotId = requiredString(
    canonicalSnapshot.snapshotId,
    "evidenceSnapshot.snapshotId",
  );
  const detachedRun = cloneJson(run);
  delete detachedRun.evidenceSnapshot;
  detachedRun.evidenceSnapshotId = snapshotId;
  return {
    run: detachedRun,
    snapshot: cloneJson(canonicalSnapshot),
  };
}

function validateCommitPair(current, run, event, { checkCurrentSequence = true } = {}) {
  if (!run || typeof run !== "object" || !event || typeof event !== "object") {
    throw new TypeError("run and event are required");
  }
  const expectedRevision = current ? current.revision + 1 : 1;
  const expectedSequence = current && checkCurrentSequence ? current.lastSequence + 1 : run.lastSequence;
  if (
    run.revision !== expectedRevision
    || event.sequence !== expectedSequence
    || run.lastSequence !== expectedSequence
  ) {
    throw new Error("invalid admin run atomic commit");
  }
  if (String(run.runId) !== String(event.runId)) throw new Error("admin run/event id mismatch");
}

function normalizeTtlSeconds(value) {
  if (
    value === null
    || value === undefined
    || String(value).trim() === ""
    || /^(?:none|null|off|disabled)$/iu.test(String(value).trim())
  ) {
    return null;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_TTL_SECONDS) {
    throw new RangeError("ADMIN_RUN_TTL_SECONDS must be null or a positive integer");
  }
  return number;
}

function normalizeTimeoutMs(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_TIMEOUT_MS) {
    throw new RangeError(`admin run Redis timeout must be between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  return number;
}

function normalizeKeyPrefix(value) {
  const prefix = String(value || DEFAULT_KEY_PREFIX).trim() || DEFAULT_KEY_PREFIX;
  if (prefix.length > 160 || /[{}\r\n]/u.test(prefix)) {
    throw new TypeError("invalid admin run Redis key prefix");
  }
  return prefix;
}

function serializeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw new TypeError("admin run storage values must be JSON serializable");
  }
}

function parseStoredJson(value, kind) {
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw storageCorrupt(`stored ${kind} is invalid JSON`);
  }
}

function parseStoredEvidenceSnapshot(value, expectedSnapshotId) {
  let parsed = value;
  if (typeof value === "string") {
    parsed = parseStoredJson(value, "evidence snapshot");
  }
  let snapshot;
  try {
    snapshot = parseAdminEvidenceSnapshot(parsed);
  } catch {
    throw storageCorrupt("stored evidence snapshot failed its content integrity check");
  }
  if (String(snapshot.snapshotId) !== String(expectedSnapshotId || "")) {
    throw storageCorrupt("stored evidence snapshot id mismatch");
  }
  return cloneJson(snapshot);
}

function isAmbiguousRedisWriteError(error) {
  return new Set([
    "admin_run_redis_timeout",
    "admin_run_redis_request_failed",
    "admin_run_redis_http_error",
    "admin_run_storage_corrupt",
  ]).has(String(error?.code || ""));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return number;
}

function storageUnavailable() {
  const error = new Error("persistent admin run storage is not configured");
  error.code = "admin_run_storage_unavailable";
  return error;
}

function memoryStoreForbidden() {
  const error = new Error("memory admin run storage requires explicit local/test opt-in");
  error.code = "admin_run_memory_forbidden";
  return error;
}

function storageCorrupt(message) {
  const error = new Error(`admin run storage is corrupt: ${message}`);
  error.code = "admin_run_storage_corrupt";
  return error;
}

function runExists(runId) {
  const error = new Error(`admin run already exists: ${runId}`);
  error.code = "admin_run_exists";
  return error;
}

function runNotFound(runId) {
  const error = new Error(`admin run not found: ${runId}`);
  error.code = "admin_run_not_found";
  return error;
}

function revisionConflict() {
  const error = new Error("admin run revision conflict");
  error.code = "admin_run_revision_conflict";
  return error;
}

function unexpectedScriptResult(operation, result) {
  if (result === "INVALID") return storageCorrupt(`${operation} transaction rejected invalid data`);
  return storageCorrupt(`${operation} transaction returned ${String(result)}`);
}
