import { gunzipSync, gzipSync } from "node:zlib";

import { createMemoryAdminRunStorage } from "./adminRunStore.mjs";
import { parseAdminEvidenceSnapshot } from "./adminEvidenceSnapshot.mjs";

const DEFAULT_KEY_PREFIX = "admin-runs:v1";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const AMBIGUOUS_WRITE_ATTEMPTS = 3;
const MAX_TTL_SECONDS = 2_147_483_647;
const DEFAULT_RUN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SNAPSHOT_CACHE_ENTRIES = 4;
const SNAPSHOT_CANDIDATE_TTL_SECONDS = 300;
const EVIDENCE_SNAPSHOT_REFERENCE_TYPE = "admin_evidence_snapshot_reference";
const EVIDENCE_SNAPSHOT_GZIP_TYPE = "admin_evidence_snapshot_gzip";
const EVIDENCE_SNAPSHOT_GZIP_SCHEMA_VERSION = 1;
const EVIDENCE_SNAPSHOT_GZIP_ENCODING = "gzip+base64";
const DEFAULT_MAX_SNAPSHOT_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MIN_SNAPSHOT_BYTE_LIMIT = 1024;
const MAX_SNAPSHOT_BYTE_LIMIT = 256 * 1024 * 1024;

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
local function expireSupersededSnapshot()
  if KEYS[4] and KEYS[4] ~= "" and KEYS[4] ~= KEYS[3] then
    redis.call("EXPIRE", KEYS[4], ARGV[5])
  end
end

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
local nextRevision = expectedRevision + 1
local eventSequence = tonumber(event["sequence"])
if tostring(current["runId"]) ~= tostring(nextRun["runId"])
  or tostring(current["runId"]) ~= tostring(event["runId"])
  or tonumber(nextRun["revision"]) ~= nextRevision
  or tonumber(nextRun["lastSequence"]) ~= eventSequence then
  return "INVALID"
end

-- A Redis REST response can be lost after this transaction commits. Replaying
-- the exact same CAS must then be a read-only success, even if later events
-- have already advanced the run. Exact event bytes at the original sequence
-- distinguish our mutation from a different writer that won the same CAS.
if tonumber(current["revision"]) ~= expectedRevision then
  local existingEventRaw = redis.call("LINDEX", KEYS[2], eventSequence - 1)
  if tonumber(current["revision"]) >= nextRevision
    and tonumber(current["lastSequence"]) >= eventSequence
    and existingEventRaw == ARGV[3] then
    expireSupersededSnapshot()
    return "ALREADY_COMMITTED"
  end
  return "CONFLICT:" .. tostring(current["revision"])
end

local nextSequence = tonumber(current["lastSequence"]) + 1
if tonumber(nextRun["lastSequence"]) ~= nextSequence
  or eventSequence ~= nextSequence then
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
expireSupersededSnapshot()
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
  const snapshotLimits = normalizeSnapshotLimits({ env, options });
  const snapshotCache = new Map();
  const snapshotLoads = new Map();

  async function createRun({ run, event } = {}) {
    validateCommitPair(null, run, event);
    const runId = requiredString(run.runId, "runId");
    const detached = detachEvidenceSnapshot(run);
    const keys = redisKeys(keyPrefix, runId, detached.snapshot.snapshotId);
    const storedSnapshotRecord = await prepareRunEvidenceSnapshotRecord(
      keys.snapshot,
      detached,
    );
    const snapshot = detached.snapshot;
    const serializedRun = serializeJson(detached.run);
    const serializedEvent = serializeJson(event);
    const serializedSnapshot = serializeJson(storedSnapshotRecord);
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
        snapshotLimits,
        { storedRecord: true },
      );
      run.evidenceSnapshotId ||= run.evidenceSnapshot.snapshotId;
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
    const storedSnapshotRecord = await prepareRunEvidenceSnapshotRecord(
      keys.snapshot,
      detached,
    );
    const snapshot = detached.snapshot;
    const supersededSnapshotKey = detached.supersededSnapshotId
      ? redisKeys(keyPrefix, id, detached.supersededSnapshotId).snapshot
      : keys.snapshot;
    const command = [
      "EVAL",
      COMMIT_RUN_SCRIPT,
      "4",
      keys.run,
      keys.events,
      keys.snapshot,
      supersededSnapshotKey,
      String(revision),
      serializeJson(detached.run),
      serializeJson(event),
      ttlSeconds === null ? "" : String(ttlSeconds),
      String(SNAPSHOT_CANDIDATE_TTL_SECONDS),
    ];
    for (let attempt = 0; attempt < AMBIGUOUS_WRITE_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await redisCommand(config, fetchImpl, timeoutMs, command);
      } catch (error) {
        if (
          !isAmbiguousRedisWriteError(error)
          || attempt === AMBIGUOUS_WRITE_ATTEMPTS - 1
        ) throw error;
        continue;
      }
      if (result === "COMMITTED" || result === "ALREADY_COMMITTED") {
        cacheEvidenceSnapshot(keys.snapshot, snapshot);
        return;
      }
      if (result === "NOT_FOUND") throw runNotFound(id);
      if (String(result || "").startsWith("CONFLICT:")) throw revisionConflict();
      if (result === "MISSING_SNAPSHOT") throw storageCorrupt("commit transaction lost evidence snapshot");
      throw unexpectedScriptResult("commit", result);
    }
  }

  async function prepareEvidenceSnapshot(snapshotKey, snapshot) {
    const canonicalSnapshot = parseStoredEvidenceSnapshot(
      snapshot,
      snapshot?.snapshotId,
      snapshotLimits,
    );
    await prepareEvidenceSnapshotRecord(snapshotKey, canonicalSnapshot);
    return canonicalSnapshot;
  }

  async function prepareRunEvidenceSnapshotRecord(snapshotKey, detached) {
    if (!detached.reference) {
      return prepareEvidenceSnapshotRecord(snapshotKey, detached.snapshot);
    }
    const reference = await prepareEvidenceSnapshotReference(
      detached.reference,
      detached.snapshot,
    );
    const prepared = await prepareEvidenceSnapshotRecord(snapshotKey, reference, {
      allowConflict: true,
    });
    if (prepared) return reference;

    // Runs written before snapshot references were introduced can already have
    // a full fork-local snapshot at this key. Keep that immutable record valid
    // instead of trying to rewrite it in place.
    const existingRaw = await redisCommand(config, fetchImpl, timeoutMs, ["GET", snapshotKey]);
    if (existingRaw !== null && existingRaw !== undefined) {
      const existing = parseStoredJson(existingRaw, "evidence snapshot");
      if (!isEvidenceSnapshotReference(existing)) {
        const legacySnapshot = parseStoredEvidenceSnapshot(
          existing,
          detached.snapshot.snapshotId,
          snapshotLimits,
          { storedRecord: true },
        );
        if (serializeJson(legacySnapshot) === serializeJson(detached.snapshot)) {
          return legacySnapshot;
        }
      }
    }
    throw storageCorrupt("stored evidence snapshot conflicts with canonical snapshot identity");
  }

  async function prepareEvidenceSnapshotRecord(snapshotKey, record, {
    allowConflict = false,
  } = {}) {
    const storedRecord = encodeStoredEvidenceSnapshotRecord(record, snapshotLimits);
    const serializedSnapshot = serializeJson(storedRecord);
    const command = [
      "EVAL",
      PREPARE_SNAPSHOT_SCRIPT,
      "1",
      snapshotKey,
      serializedSnapshot,
      String(SNAPSHOT_CANDIDATE_TTL_SECONDS),
    ];
    for (let attempt = 0; attempt < AMBIGUOUS_WRITE_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await redisCommand(config, fetchImpl, timeoutMs, command);
      } catch (error) {
        if (
          !isAmbiguousRedisWriteError(error)
          || attempt === AMBIGUOUS_WRITE_ATTEMPTS - 1
        ) throw error;
        continue;
      }
      if (result === "STAGED" || result === "UNCHANGED") return storedRecord;
      if (result === "CONFLICT") {
        const equivalent = await readEquivalentStoredSnapshotRecord(snapshotKey, record);
        if (equivalent) return equivalent;
        if (allowConflict) return null;
        throw storageCorrupt("stored evidence snapshot conflicts with canonical snapshot identity");
      }
      throw storageCorrupt(`unexpected evidence snapshot prepare result: ${String(result)}`);
    }
  }

  async function readEquivalentStoredSnapshotRecord(snapshotKey, expectedRecord) {
    const existingRaw = await redisCommand(config, fetchImpl, timeoutMs, ["GET", snapshotKey]);
    if (existingRaw === null || existingRaw === undefined) return null;
    const existingRecord = parseStoredJson(existingRaw, "evidence snapshot");
    if (isEvidenceSnapshotReference(expectedRecord)) {
      if (!isEvidenceSnapshotReference(existingRecord)) return null;
      const expectedReference = parseEvidenceSnapshotReference(
        expectedRecord,
        expectedRecord.snapshotId,
      );
      const existingReference = parseEvidenceSnapshotReference(
        existingRecord,
        expectedRecord.snapshotId,
      );
      return serializeJson(existingReference) === serializeJson(expectedReference)
        ? existingRecord
        : null;
    }
    if (isEvidenceSnapshotReference(existingRecord)) return null;
    const expectedSnapshot = parseStoredEvidenceSnapshot(
      expectedRecord,
      expectedRecord?.snapshotId,
      snapshotLimits,
    );
    const existingSnapshot = parseStoredEvidenceSnapshot(
      existingRecord,
      expectedSnapshot.snapshotId,
      snapshotLimits,
      { storedRecord: true },
    );
    return serializeJson(existingSnapshot) === serializeJson(expectedSnapshot)
      ? existingRecord
      : null;
  }

  async function prepareEvidenceSnapshotReference(reference, snapshot) {
    const canonicalReference = parseEvidenceSnapshotReference(reference, snapshot?.snapshotId);
    let resolved = await resolveEvidenceSnapshotReference(canonicalReference, new Set());
    if (!resolved) {
      const targetKey = snapshotKeyForReference(canonicalReference);
      const canonicalSnapshot = await prepareEvidenceSnapshot(targetKey, snapshot);
      resolved = {
        key: targetKey,
        reference: canonicalReference,
        snapshot: canonicalSnapshot,
      };
    }
    const canonicalSnapshot = parseStoredEvidenceSnapshot(
      snapshot,
      canonicalReference.snapshotId,
      snapshotLimits,
    );
    if (serializeJson(resolved.snapshot) !== serializeJson(canonicalSnapshot)) {
      throw storageCorrupt("referenced evidence snapshot conflicts with the fork snapshot");
    }
    await keepEvidenceSnapshotAlive(resolved.key);
    return resolved.reference;
  }

  function snapshotKeyForReference(reference) {
    return redisKeys(
      keyPrefix,
      requiredString(reference.ownerRunId, "evidence snapshot reference ownerRunId"),
      requiredString(reference.snapshotId, "evidence snapshot reference snapshotId"),
    ).snapshot;
  }

  async function resolveEvidenceSnapshotReference(reference, visited) {
    const canonicalReference = parseEvidenceSnapshotReference(reference, reference?.snapshotId);
    const snapshotKey = snapshotKeyForReference(canonicalReference);
    if (visited.has(snapshotKey)) {
      throw storageCorrupt("stored evidence snapshot reference cycle detected");
    }
    visited.add(snapshotKey);
    try {
      const result = await redisCommand(config, fetchImpl, timeoutMs, ["GET", snapshotKey]);
      if (result === null || result === undefined) return null;
      const record = parseStoredJson(result, "evidence snapshot");
      if (isEvidenceSnapshotReference(record)) {
        const nextReference = parseEvidenceSnapshotReference(
          record,
          canonicalReference.snapshotId,
        );
        if (nextReference.contentSha256 !== canonicalReference.contentSha256) {
          throw storageCorrupt("stored evidence snapshot reference hash mismatch");
        }
        return resolveEvidenceSnapshotReference(nextReference, visited);
      }
      const resolvedSnapshot = parseStoredEvidenceSnapshot(
        record,
        canonicalReference.snapshotId,
        snapshotLimits,
        { storedRecord: true },
      );
      if (resolvedSnapshot.contentSha256 !== canonicalReference.contentSha256) {
        throw storageCorrupt("stored evidence snapshot reference hash mismatch");
      }
      return {
        key: snapshotKey,
        reference: canonicalReference,
        snapshot: resolvedSnapshot,
      };
    } finally {
      visited.delete(snapshotKey);
    }
  }

  async function keepEvidenceSnapshotAlive(snapshotKey) {
    // Refresh the shared target before the fork-local alias is committed. A
    // small grace period prevents the target from expiring in the narrow gap
    // before an equally-lived alias reaches its own TTL.
    const referencedSnapshotTtl = ttlSeconds === null
      ? null
      : Math.min(MAX_TTL_SECONDS, ttlSeconds + SNAPSHOT_CANDIDATE_TTL_SECONDS);
    const command = ttlSeconds === null
      ? ["PERSIST", snapshotKey]
      : ["EXPIRE", snapshotKey, String(referencedSnapshotTtl)];
    const result = await redisCommand(config, fetchImpl, timeoutMs, command);
    if (Number(result) === 1) return;
    if (
      ttlSeconds === null
      && Number(await redisCommand(config, fetchImpl, timeoutMs, ["EXISTS", snapshotKey])) === 1
    ) return;
    throw storageCorrupt("referenced evidence snapshot disappeared during fork creation");
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
      const record = parseStoredJson(snapshotResult, "evidence snapshot");
      const snapshot = isEvidenceSnapshotReference(record)
        ? (await resolveEvidenceSnapshotReference(
          parseEvidenceSnapshotReference(record, snapshotId),
          new Set([snapshotKey]),
        ))?.snapshot
        : parseStoredEvidenceSnapshot(
          record,
          snapshotId,
          snapshotLimits,
          { storedRecord: true },
        );
      if (!snapshot) throw storageCorrupt("stored run evidence snapshot is missing");
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
      snapshotLimits,
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
  const previousSnapshotId = String(detachedRun.evidenceSnapshotId || "").trim();
  delete detachedRun.evidenceSnapshot;
  detachedRun.evidenceSnapshotId = snapshotId;
  return {
    run: detachedRun,
    snapshot: cloneJson(canonicalSnapshot),
    reference: forkEvidenceSnapshotReference(run, canonicalSnapshot),
    supersededSnapshotId:
      run?.preparationFinalizedAt && previousSnapshotId && previousSnapshotId !== snapshotId
        ? previousSnapshotId
        : null,
  };
}

function forkEvidenceSnapshotReference(run, snapshot) {
  const fork = run?.metadata?.fork;
  if (!fork || typeof fork !== "object" || Array.isArray(fork)) return null;
  const sourceRunId = String(fork.sourceRunId || "").trim();
  if (!sourceRunId) return null;
  if (
    String(fork.sourceEvidenceSnapshotId || "") !== String(snapshot.snapshotId)
    || String(fork.sourceEvidenceSnapshotSha256 || "") !== String(snapshot.contentSha256)
  ) {
    throw storageCorrupt("fork metadata does not match its evidence snapshot");
  }
  return parseEvidenceSnapshotReference({
    recordType: EVIDENCE_SNAPSHOT_REFERENCE_TYPE,
    schemaVersion: 1,
    ownerRunId: sourceRunId,
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
  }, snapshot.snapshotId);
}

function isEvidenceSnapshotReference(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.recordType === EVIDENCE_SNAPSHOT_REFERENCE_TYPE,
  );
}

function parseEvidenceSnapshotReference(value, expectedSnapshotId) {
  if (!isEvidenceSnapshotReference(value) || value.schemaVersion !== 1) {
    throw storageCorrupt("stored evidence snapshot reference is invalid");
  }
  const ownerRunId = String(value.ownerRunId || "").trim();
  const snapshotId = String(value.snapshotId || "").trim();
  const contentSha256 = String(value.contentSha256 || "").trim().toLowerCase();
  if (!ownerRunId) {
    throw storageCorrupt("stored evidence snapshot reference owner is invalid");
  }
  if (
    snapshotId !== String(expectedSnapshotId || "")
    || snapshotId !== `evidence_${contentSha256.slice(0, 24)}`
  ) {
    throw storageCorrupt("stored evidence snapshot reference id mismatch");
  }
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    throw storageCorrupt("stored evidence snapshot reference hash is invalid");
  }
  return {
    recordType: EVIDENCE_SNAPSHOT_REFERENCE_TYPE,
    schemaVersion: 1,
    ownerRunId,
    snapshotId,
    contentSha256,
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
    value === undefined
    || String(value).trim() === ""
  ) {
    return DEFAULT_RUN_TTL_SECONDS;
  }
  if (
    value === null
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

function normalizeSnapshotLimits({ env, options }) {
  const maxUncompressedBytes = normalizeSnapshotByteLimit(
    options.maxSnapshotUncompressedBytes !== undefined
      ? options.maxSnapshotUncompressedBytes
      : env.ADMIN_RUN_SNAPSHOT_MAX_UNCOMPRESSED_BYTES,
    DEFAULT_MAX_SNAPSHOT_UNCOMPRESSED_BYTES,
    "ADMIN_RUN_SNAPSHOT_MAX_UNCOMPRESSED_BYTES",
  );
  const maxCompressedBytes = normalizeSnapshotByteLimit(
    options.maxSnapshotCompressedBytes !== undefined
      ? options.maxSnapshotCompressedBytes
      : env.ADMIN_RUN_SNAPSHOT_MAX_COMPRESSED_BYTES,
    DEFAULT_MAX_SNAPSHOT_COMPRESSED_BYTES,
    "ADMIN_RUN_SNAPSHOT_MAX_COMPRESSED_BYTES",
  );
  return Object.freeze({ maxUncompressedBytes, maxCompressedBytes });
}

function normalizeSnapshotByteLimit(value, fallback, name) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < MIN_SNAPSHOT_BYTE_LIMIT
    || number > MAX_SNAPSHOT_BYTE_LIMIT
  ) {
    throw new RangeError(
      `${name} must be between ${MIN_SNAPSHOT_BYTE_LIMIT} and ${MAX_SNAPSHOT_BYTE_LIMIT}`,
    );
  }
  return number;
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

function encodeStoredEvidenceSnapshotRecord(value, limits) {
  if (isEvidenceSnapshotReference(value)) return parseEvidenceSnapshotReference(
    value,
    value.snapshotId,
  );
  const snapshot = parseStoredEvidenceSnapshot(value, value?.snapshotId, limits);
  const serialized = serializeJson(snapshot);
  const input = Buffer.from(serialized, "utf8");
  if (input.byteLength > limits.maxUncompressedBytes) {
    throw snapshotTooLarge("uncompressed", input.byteLength, limits.maxUncompressedBytes);
  }
  const compressed = deterministicGzip(input);
  if (compressed.byteLength > limits.maxCompressedBytes) {
    throw snapshotTooLarge("compressed", compressed.byteLength, limits.maxCompressedBytes);
  }
  return {
    recordType: EVIDENCE_SNAPSHOT_GZIP_TYPE,
    schemaVersion: EVIDENCE_SNAPSHOT_GZIP_SCHEMA_VERSION,
    encoding: EVIDENCE_SNAPSHOT_GZIP_ENCODING,
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
    uncompressedBytes: input.byteLength,
    compressedBytes: compressed.byteLength,
    payload: compressed.toString("base64"),
  };
}

function deterministicGzip(input) {
  const compressed = gzipSync(input, {
    level: 9,
    // Gzip headers must not depend on wall time. Node currently emits mtime=0
    // by default, but setting it explicitly documents and locks the invariant.
    mtime: 0,
  });
  // RFC 1952 byte 9 is only an informational originating-OS field. Normalizing
  // it prevents otherwise identical Windows and Linux encoders from producing
  // different immutable Redis bytes.
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  return compressed;
}

function parseStoredEvidenceSnapshot(value, expectedSnapshotId, limits = {
  maxUncompressedBytes: DEFAULT_MAX_SNAPSHOT_UNCOMPRESSED_BYTES,
  maxCompressedBytes: DEFAULT_MAX_SNAPSHOT_COMPRESSED_BYTES,
}, { storedRecord = false } = {}) {
  let parsed = value;
  if (typeof value === "string") {
    const maximumStoredBytes = Math.max(
      limits.maxUncompressedBytes,
      Math.ceil(limits.maxCompressedBytes / 3) * 4 + 2048,
    );
    if (Buffer.byteLength(value, "utf8") > maximumStoredBytes) {
      throw storageCorrupt("stored evidence snapshot exceeds its configured byte limit");
    }
    parsed = parseStoredJson(value, "evidence snapshot");
  }
  if (isCompressedEvidenceSnapshotRecord(parsed)) {
    parsed = decodeCompressedEvidenceSnapshotRecord(parsed, expectedSnapshotId, limits);
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
  const serialized = serializeJson(snapshot);
  const canonicalBytes = Buffer.byteLength(serialized, "utf8");
  if (canonicalBytes > limits.maxUncompressedBytes) {
    if (storedRecord) {
      throw storageCorrupt(
        "stored evidence snapshot exceeds its configured uncompressed byte limit",
      );
    }
    throw snapshotTooLarge("uncompressed", canonicalBytes, limits.maxUncompressedBytes);
  }
  return JSON.parse(serialized);
}

function isCompressedEvidenceSnapshotRecord(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.recordType === EVIDENCE_SNAPSHOT_GZIP_TYPE,
  );
}

function decodeCompressedEvidenceSnapshotRecord(record, expectedSnapshotId, limits) {
  const fail = () => storageCorrupt(
    "compressed evidence snapshot failed its content integrity check",
  );
  try {
    if (
      record.schemaVersion !== EVIDENCE_SNAPSHOT_GZIP_SCHEMA_VERSION
      || record.encoding !== EVIDENCE_SNAPSHOT_GZIP_ENCODING
      || String(record.snapshotId || "") !== String(expectedSnapshotId || "")
      || !/^[a-f0-9]{64}$/u.test(String(record.contentSha256 || ""))
    ) throw fail();
    const uncompressedBytes = strictPositiveInteger(record.uncompressedBytes);
    const compressedBytes = strictPositiveInteger(record.compressedBytes);
    if (
      uncompressedBytes > limits.maxUncompressedBytes
      || compressedBytes > limits.maxCompressedBytes
    ) throw fail();
    const payload = String(record.payload || "");
    if (
      payload.length === 0
      || payload.length > Math.ceil(limits.maxCompressedBytes / 3) * 4 + 4
      || !isCanonicalBase64(payload)
    ) throw fail();
    const compressed = Buffer.from(payload, "base64");
    if (compressed.byteLength !== compressedBytes) throw fail();
    const uncompressed = gunzipSync(compressed, {
      maxOutputLength: limits.maxUncompressedBytes,
    });
    if (uncompressed.byteLength !== uncompressedBytes) throw fail();
    const decoded = parseStoredJson(uncompressed.toString("utf8"), "compressed evidence snapshot");
    if (
      String(decoded.snapshotId || "") !== String(record.snapshotId)
      || String(decoded.contentSha256 || "") !== String(record.contentSha256)
    ) throw fail();
    return decoded;
  } catch (error) {
    if (error?.code === "admin_run_storage_corrupt") throw error;
    throw fail();
  }
}

function strictPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : NaN;
}

function isCanonicalBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function snapshotTooLarge(kind, actual, maximum) {
  const error = new RangeError(
    `admin run evidence snapshot ${kind} size ${actual} exceeds ${maximum} bytes`,
  );
  error.code = "admin_run_snapshot_too_large";
  return error;
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
