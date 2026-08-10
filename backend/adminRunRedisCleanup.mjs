import { createHash } from "node:crypto";

const DEFAULT_RUN_KEY_PREFIX = "admin-runs:v1";
const DEFAULT_HISTORY_KEY_PREFIX = "admin-lab-records:v1";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SCAN_COUNT = 200;
const DEFAULT_MAX_SCAN_KEYS = 20_000;
const DEFAULT_MAX_RUNS = 25;
const DEFAULT_MAX_DELETE_KEYS = 250;
const DEFAULT_MAX_KNOWN_BYTES = 128 * 1024 * 1024;
const MAX_QUESTION_SUMMARY_LENGTH = 500;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const SNAPSHOT_REFERENCE_TYPE = "admin_evidence_snapshot_reference";
const SNAPSHOT_GZIP_TYPE = "admin_evidence_snapshot_gzip";
const PLAN_INTERNALS = new WeakMap();

export const ADMIN_RUN_CLEANUP_CONFIRMATION =
  "DELETE TERMINAL ADMIN RUN DATA DURING MAINTENANCE";
export const ADMIN_RUN_WRITES_DISABLED_CONFIRMATION =
  "ADMIN MODEL LAB WRITES ARE DISABLED";

export const DEFAULT_ADMIN_RUN_CLEANUP_LIMITS = Object.freeze({
  maxRuns: DEFAULT_MAX_RUNS,
  maxKeys: DEFAULT_MAX_DELETE_KEYS,
  maxKnownBytes: DEFAULT_MAX_KNOWN_BYTES,
  maxScanKeys: DEFAULT_MAX_SCAN_KEYS,
});

const DELETE_RUN_SCRIPT = `
-- admin-run-cleanup-delete-v1
local currentRaw = redis.call("GET", KEYS[1])
if not currentRaw then
  return "NOT_FOUND"
end
if currentRaw ~= ARGV[1] then
  return "STATE_CHANGED"
end
local ok, state = pcall(cjson.decode, currentRaw)
if not ok
  or tostring(state["runId"]) ~= tostring(ARGV[2])
  or (tostring(state["status"]) ~= "SUCCEEDED"
    and tostring(state["status"]) ~= "FAILED"
    and tostring(state["status"]) ~= "CANCELLED") then
  return "INVALID_STATE"
end
for index = 1, #KEYS do
  if redis.call("EXISTS", KEYS[index]) ~= 1 then
    return "MISSING_KEY"
  end
end
local deleted = redis.call("DEL", unpack(KEYS))
return "DELETED:" .. tostring(deleted)
`.trim();

/**
 * Builds a deletion plan without issuing any Redis write command. The returned
 * object deliberately contains no raw key, run id, Redis endpoint, credential,
 * question, state, or Snapshot value. Execution material is kept in a WeakMap
 * and can only be consumed by executeAdminRunCleanup() in this process.
 */
export async function planAdminRunCleanup(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const olderThanDays = requiredPositiveNumber(options.olderThanDays, "olderThanDays");
  const now = validDate(options.now ?? new Date(), "now");
  const cutoff = new Date(now.getTime() - (olderThanDays * 86_400_000));
  const limits = normalizeLimits(options.limits || options);
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000);
  const runPrefix = normalizePrefix(
    options.runKeyPrefix ?? env.ADMIN_RUN_REDIS_KEY_PREFIX,
    DEFAULT_RUN_KEY_PREFIX,
  );
  const historyPrefix = normalizePrefix(
    options.historyKeyPrefix ?? env.ADMIN_LAB_RECORD_REDIS_KEY_PREFIX,
    DEFAULT_HISTORY_KEY_PREFIX,
  );
  const runConnection = options.runConnection || configuredRunConnection(env);
  const historyConnection = options.historyConnection || configuredHistoryConnection(env);
  assertConnection(runConnection, "Admin Run Redis");
  assertConnection(historyConnection, "Admin Lab History Redis");
  const runRedis = commandClient(
    runConnection,
    fetchImpl,
    timeoutMs,
    "admin run cleanup",
    new Set(["SCAN", "TYPE", "GET", "MEMORY", "STRLEN"]),
  );
  const historyRedis = commandClient(
    historyConnection,
    fetchImpl,
    timeoutMs,
    "admin run cleanup history",
    new Set(["GET"]),
  );

  const discoveredKeys = await scanKeys(runRedis, `${escapeRedisGlob(runPrefix)}:*`, limits.maxScanKeys);
  const groups = new Map();
  const ignoredKeys = [];
  for (const key of discoveredKeys) {
    const parsed = parseAdminRunKey(key, runPrefix);
    if (!parsed) {
      ignoredKeys.push(key);
      continue;
    }
    let group = groups.get(parsed.runId);
    if (!group) {
      group = { runId: parsed.runId, state: null, events: null, snapshots: [] };
      groups.set(parsed.runId, group);
    }
    if (parsed.kind === "snapshot") group.snapshots.push(parsed);
    else if (group[parsed.kind]) group.duplicateKey = true;
    else group[parsed.kind] = parsed;
  }

  const allSnapshotRecords = new Map();
  const snapshotRawByKey = new Map();
  const globalBlockReasons = [];
  if (ignoredKeys.length) globalBlockReasons.push("unknown_admin_run_key");
  for (const group of groups.values()) {
    group.reasons = [];
    if (group.duplicateKey) group.reasons.push("duplicate_run_key");
    if (!group.state) group.reasons.push("state_key_missing");
    if (!group.events) group.reasons.push("events_key_missing");
    if (!group.snapshots.length) group.reasons.push("snapshot_key_missing");
    if (group.state) {
      const stateType = await runRedis(["TYPE", group.state.key]);
      if (String(stateType).toLowerCase() !== "string") {
        group.reasons.push("state_key_type_invalid");
      } else {
        const raw = await runRedis(["GET", group.state.key]);
        const parsed = parseRunState(raw, group.runId, now);
        if (!parsed.ok) group.reasons.push(parsed.reason);
        else {
          group.stateRaw = String(raw);
          group.runState = parsed.value;
        }
      }
    }
    if (group.events) {
      const eventsType = await runRedis(["TYPE", group.events.key]);
      if (String(eventsType).toLowerCase() !== "list") {
        group.reasons.push("events_key_type_invalid");
      }
    }
    for (const snapshotKey of group.snapshots) {
      const snapshotType = await runRedis(["TYPE", snapshotKey.key]);
      if (String(snapshotType).toLowerCase() !== "string") {
        group.reasons.push("snapshot_key_type_invalid");
        globalBlockReasons.push("snapshot_graph_incomplete");
        continue;
      }
      const raw = await runRedis(["GET", snapshotKey.key]);
      const parsed = parseSnapshotRecord(raw, snapshotKey);
      if (!parsed.ok) {
        group.reasons.push(parsed.reason);
        globalBlockReasons.push("snapshot_graph_incomplete");
        continue;
      }
      const record = { ...parsed.value, key: snapshotKey.key, sourceRunId: group.runId };
      allSnapshotRecords.set(snapshotKey.key, record);
      snapshotRawByKey.set(snapshotKey.key, String(raw));
    }
  }

  const preliminaryCandidates = new Set();
  for (const group of groups.values()) {
    const state = group.runState;
    if (!state) continue;
    if (!TERMINAL_STATUSES.has(state.status)) group.reasons.push("run_not_terminal");
    if (state.activeLease) group.reasons.push("active_execution_lease");
    if (state.endedAt.getTime() >= cutoff.getTime()
      || state.updatedAt.getTime() >= cutoff.getTime()) {
      group.reasons.push("run_not_older_than_threshold");
    }
    const currentSnapshotKey = snapshotKeyFor(
      runPrefix,
      group.runId,
      state.evidenceSnapshotId,
    );
    const currentSnapshotRecord = allSnapshotRecords.get(currentSnapshotKey);
    if (!currentSnapshotRecord) {
      group.reasons.push("current_snapshot_missing_or_invalid");
    } else if (currentSnapshotRecord.kind === "reference") {
      const resolved = protectReferenceChain(currentSnapshotRecord, {
        records: allSnapshotRecords,
        runPrefix,
        protectedKeys: new Set(),
      });
      if (!resolved.ok) {
        group.reasons.push(resolved.reason);
        globalBlockReasons.push(resolved.reason);
      }
    }
    if (group.reasons.length === 0) {
      const history = await loadHistoryRecord(historyRedis, historyPrefix, group.runId);
      if (!history.ok) group.reasons.push(history.reason);
      else {
        group.history = history.value;
        preliminaryCandidates.add(group.runId);
      }
    }
  }

  const protectedSnapshotKeys = new Set();
  if (!globalBlockReasons.length) {
    for (const record of allSnapshotRecords.values()) {
      if (record.kind !== "reference") continue;
      const resolved = protectReferenceChain(record, {
        records: allSnapshotRecords,
        runPrefix,
        protectedKeys: protectedSnapshotKeys,
      });
      if (!resolved.ok) globalBlockReasons.push(resolved.reason);
    }
  }

  const deletionCandidates = new Set();
  for (const runId of preliminaryCandidates) {
    const group = groups.get(runId);
    if (group.snapshots.some((snapshot) => protectedSnapshotKeys.has(snapshot.key))) {
      group.reasons.push("snapshot_referenced_by_existing_run");
      continue;
    }
    deletionCandidates.add(runId);
  }

  const candidateInternals = [];
  let knownBytes = 0;
  let unmeasuredKeyCount = 0;
  const terminalStatusCounts = Object.fromEntries(
    [...TERMINAL_STATUSES].map((status) => [status, 0]),
  );
  const historyRecordKindCounts = { current: 0, legacy: 0 };
  for (const runId of deletionCandidates) {
    const group = groups.get(runId);
    const keys = [group.state.key, group.events.key];
    for (const snapshot of group.snapshots) {
      if (!protectedSnapshotKeys.has(snapshot.key)) keys.push(snapshot.key);
    }
    const measurements = [];
    for (const key of keys) {
      const type = key === group.events.key ? "list" : "string";
      const measured = await measureKey(runRedis, key, type);
      measurements.push(measured);
      if (measured.bytes === null) unmeasuredKeyCount += 1;
      else knownBytes += measured.bytes;
    }
    const internal = {
      runId,
      expectedStateRaw: group.stateRaw,
      historyKey: group.history.key,
      expectedHistoryRaw: group.history.raw,
      keys,
    };
    candidateInternals.push(internal);
    terminalStatusCounts[group.runState.status] += 1;
    historyRecordKindCounts[group.history.kind] += 1;
  }

  const totals = {
    runCount: candidateInternals.length,
    keyCount: candidateInternals.reduce((sum, item) => sum + item.keys.length, 0),
    knownBytes,
    unmeasuredKeyCount,
    protectedSnapshotKeyCount: protectedSnapshotKeys.size,
  };
  if (totals.runCount > limits.maxRuns) globalBlockReasons.push("max_runs_exceeded");
  if (totals.keyCount > limits.maxKeys) globalBlockReasons.push("max_keys_exceeded");
  if (totals.knownBytes > limits.maxKnownBytes) {
    globalBlockReasons.push("max_known_bytes_exceeded");
  }
  const uniqueGlobalBlocks = [...new Set(globalBlockReasons)].sort();
  const namespaceKeyDigest = digestJson(discoveredKeys);
  const snapshotGraphDigest = digestSnapshotGraph(snapshotRawByKey);
  const planFingerprint = digestJson({
    schemaVersion: 1,
    olderThanDays,
    runEndpoint: runConnection.url,
    historyEndpoint: historyConnection.url,
    runPrefix,
    historyPrefix,
    limits,
    namespaceKeyDigest,
    snapshotGraphDigest,
    candidates: candidateInternals.map((candidate) => ({
      runId: candidate.runId,
      expectedStateRaw: candidate.expectedStateRaw,
      historyKey: candidate.historyKey,
      expectedHistoryRaw: candidate.expectedHistoryRaw,
      keys: candidate.keys,
    })),
  });
  const report = deepFreeze({
    schemaVersion: 1,
    mode: "dry_run",
    valuesExposed: false,
    secretsExposed: false,
    questionsExposed: false,
    generatedAt: now.toISOString(),
    olderThanDays,
    cutoffBefore: cutoff.toISOString(),
    planFingerprint,
    confirmationRequired: ADMIN_RUN_CLEANUP_CONFIRMATION,
    writesDisabledConfirmationRequired: ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
    writeQuiescence: {
      verifiedLock: false,
      mode: "operator_attested_external_stop",
      limitation:
        "Redis Cluster slots prevent this tool from atomically locking every Admin Run writer.",
      failClosedChecks: [
        "all snapshot reference targets are deferred to a later cleanup plan",
        "the namespace key set and complete snapshot graph are revalidated around every delete",
      ],
    },
    historyRetentionNotice:
      "Admin Lab History retains only a whitespace-normalized questionSummary of at most 500 characters.",
    namespaceIsolation: {
      adminRunOnly: true,
      historyReadOnly: true,
      queryAuditTouched: false,
      sessionTouched: false,
      budgetTouched: false,
      latencyTouched: false,
      feedbackTouched: false,
    },
    limits,
    scanned: {
      keyCount: discoveredKeys.length,
      runGroupCount: groups.size,
      ignoredKeyCount: ignoredKeys.length,
      snapshotRecordCount: allSnapshotRecords.size,
      protectedSnapshotKeyCount: protectedSnapshotKeys.size,
    },
    canExecute: uniqueGlobalBlocks.length === 0 && candidateInternals.length > 0,
    blockReasons: uniqueGlobalBlocks,
    totals,
    candidateSummary: {
      terminalStatusCounts,
      historyRecordKindCounts,
    },
    skipped: summarizeSkippedGroups(groups, deletionCandidates),
  });
  PLAN_INTERNALS.set(report, {
    runConnection,
    historyConnection,
    runPrefix,
    historyPrefix,
    timeoutMs,
    maxScanKeys: limits.maxScanKeys,
    namespaceKeys: discoveredKeys,
    namespaceKeyDigest,
    snapshotRawEntries: [...snapshotRawByKey.entries()],
    snapshotGraphDigest,
    candidates: candidateInternals,
  });
  return report;
}

/**
 * Applies an in-memory dry-run plan. A plan cannot be reconstructed from its
 * JSON report, and every run is revalidated against its exact state bytes and
 * exact History record immediately before its same-slot delete transaction.
 */
export async function executeAdminRunCleanup(plan, {
  execute = false,
  confirmation = "",
  writesDisabledConfirmation = "",
  approvalFingerprint = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (execute !== true) throw cleanupRefused("--execute is required");
  if (confirmation !== ADMIN_RUN_CLEANUP_CONFIRMATION) {
    throw cleanupRefused("the exact cleanup confirmation phrase is required");
  }
  if (writesDisabledConfirmation !== ADMIN_RUN_WRITES_DISABLED_CONFIRMATION) {
    throw cleanupRefused("the exact writes-disabled confirmation phrase is required");
  }
  const internal = PLAN_INTERNALS.get(plan);
  if (!internal) throw cleanupRefused("cleanup plan is not an executable in-process dry-run plan");
  if (!/^[a-f0-9]{64}$/u.test(String(approvalFingerprint || ""))) {
    throw cleanupRefused("the exact dry-run plan fingerprint is required");
  }
  if (approvalFingerprint !== plan.planFingerprint) {
    throw cleanupRefused("the approved dry-run plan fingerprint does not match");
  }
  if (!plan.canExecute || plan.blockReasons.length) {
    throw cleanupRefused("cleanup plan is blocked");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const runRedis = commandClient(
    internal.runConnection,
    fetchImpl,
    internal.timeoutMs,
    "admin run cleanup",
    new Set(["SCAN", "GET", "EVAL"]),
  );
  const historyRedis = commandClient(
    internal.historyConnection,
    fetchImpl,
    internal.timeoutMs,
    "admin run cleanup history",
    new Set(["GET"]),
  );
  let expectedNamespaceKeys = [...internal.namespaceKeys];
  let expectedSnapshotRaw = new Map(internal.snapshotRawEntries);
  await assertNamespaceAndSnapshotGraphUnchanged(runRedis, {
    runPrefix: internal.runPrefix,
    maxScanKeys: internal.maxScanKeys,
    expectedNamespaceKeys,
    expectedSnapshotRaw,
  });
  const deleted = [];
  for (const candidate of internal.candidates) {
    await assertNamespaceAndSnapshotGraphUnchanged(runRedis, {
      runPrefix: internal.runPrefix,
      maxScanKeys: internal.maxScanKeys,
      expectedNamespaceKeys,
      expectedSnapshotRaw,
    });
    assertCandidateDeletionScope(candidate, internal.runPrefix);
    const historyRaw = await historyRedis(["GET", candidate.historyKey]);
    if (String(historyRaw ?? "") !== candidate.expectedHistoryRaw) {
      throw cleanupConflict("history_record_changed");
    }
    assertSameRedisSlot(candidate.keys);
    const result = String(await runRedis([
      "EVAL",
      DELETE_RUN_SCRIPT,
      String(candidate.keys.length),
      ...candidate.keys,
      candidate.expectedStateRaw,
      candidate.runId,
    ]) || "");
    const deletedMatch = /^DELETED:(\d+)$/u.exec(result);
    if (!deletedMatch) {
      throw cleanupConflict(result.toLowerCase() || "unexpected_delete_result");
    }
    if (Number(deletedMatch[1]) !== candidate.keys.length) {
      throw cleanupConflict("deleted_key_count_mismatch");
    }
    const remainingState = await runRedis(["GET", candidate.keys[0]]);
    if (remainingState !== null && remainingState !== undefined) {
      throw cleanupConflict("state_key_still_exists");
    }
    const preservedHistory = await historyRedis(["GET", candidate.historyKey]);
    if (String(preservedHistory ?? "") !== candidate.expectedHistoryRaw) {
      throw cleanupConflict("history_record_not_preserved");
    }
    const deletedKeys = new Set(candidate.keys);
    expectedNamespaceKeys = expectedNamespaceKeys.filter((key) => !deletedKeys.has(key));
    expectedSnapshotRaw = new Map(
      [...expectedSnapshotRaw].filter(([key]) => !deletedKeys.has(key)),
    );
    await assertNamespaceAndSnapshotGraphUnchanged(runRedis, {
      runPrefix: internal.runPrefix,
      maxScanKeys: internal.maxScanKeys,
      expectedNamespaceKeys,
      expectedSnapshotRaw,
    });
    deleted.push(candidate.keys.length);
  }
  return deepFreeze({
    schemaVersion: 1,
    mode: "executed",
    executedAt: new Date().toISOString(),
    confirmationAccepted: true,
    writesDisabledConfirmationAccepted: true,
    writeQuiescence: plan.writeQuiescence,
    questionsExposed: false,
    historyRetentionNotice: plan.historyRetentionNotice,
    deletedRunCount: deleted.length,
    deletedKeyCount: deleted.reduce((sum, keyCount) => sum + keyCount, 0),
  });
}

export function configuredAdminRunCleanupConnections(env = {}) {
  return Object.freeze({
    runConnection: configuredRunConnection(env),
    historyConnection: configuredHistoryConnection(env),
  });
}

function configuredRunConnection(env) {
  return connectionFromEnv(env, ["ADMIN_RUN_REDIS_REST_URL"], ["ADMIN_RUN_REDIS_REST_TOKEN"]);
}

function configuredHistoryConnection(env) {
  return connectionFromEnv(
    env,
    ["ADMIN_LAB_RECORD_REDIS_REST_URL"],
    ["ADMIN_LAB_RECORD_REDIS_REST_TOKEN"],
  );
}

function connectionFromEnv(env, urlNames, tokenNames) {
  const url = firstConfigured(env, [
    ...urlNames,
    "UPSTASH_REDIS_REST_URL",
    "KV_REST_API_URL",
    "REDIS_REST_API_URL",
  ]);
  const token = firstConfigured(env, [
    ...tokenNames,
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_TOKEN",
    "REDIS_REST_API_TOKEN",
  ]);
  return url && token ? Object.freeze({ url, token }) : null;
}

function firstConfigured(env, names) {
  for (const name of names) {
    const value = String(env?.[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function assertConnection(value, label) {
  if (!value || typeof value !== "object"
    || !String(value.url || "").trim()
    || !String(value.token || "").trim()) {
    const error = new Error(`${label} is not configured`);
    error.code = "admin_run_cleanup_storage_unconfigured";
    throw error;
  }
}

function commandClient(connection, fetchImpl, timeoutMs, label, allowedCommands) {
  assertConnection(connection, label);
  return async (command) => {
    const operation = String(command?.[0] || "").toUpperCase();
    if (!(allowedCommands instanceof Set) || !allowedCommands.has(operation)) {
      throw cleanupRefused(`Redis command is outside the ${label} allowlist`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(connection.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
    } catch {
      const error = new Error(`${label} Redis request failed`);
      error.code = "admin_run_cleanup_redis_request_failed";
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) {
      const error = new Error(`${label} Redis HTTP request failed`);
      error.code = "admin_run_cleanup_redis_http_error";
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw cleanupCorrupt("Redis response was not JSON");
    }
    if (payload?.error) {
      const error = cleanupCorrupt("Redis rejected the cleanup command");
      error.code = "admin_run_cleanup_redis_command_rejected";
      throw error;
    }
    return payload?.result;
  };
}

async function scanKeys(redis, pattern, maxKeys) {
  const found = new Set();
  let cursor = "0";
  let iterations = 0;
  do {
    const result = await redis([
      "SCAN",
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      String(DEFAULT_SCAN_COUNT),
    ]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw cleanupCorrupt("SCAN returned an unexpected shape");
    }
    cursor = String(result[0]);
    for (const key of result[1]) {
      const text = String(key || "");
      if (!text) continue;
      found.add(text);
      if (found.size > maxKeys) throw cleanupLimit("max_scan_keys_exceeded");
    }
    iterations += 1;
    if (iterations > 100_000) throw cleanupCorrupt("SCAN did not terminate");
  } while (cursor !== "0");
  return [...found].sort((left, right) => left.localeCompare(right, "en"));
}

async function assertNamespaceAndSnapshotGraphUnchanged(redis, {
  runPrefix,
  maxScanKeys,
  expectedNamespaceKeys,
  expectedSnapshotRaw,
}) {
  const currentKeys = await scanKeys(
    redis,
    `${escapeRedisGlob(runPrefix)}:*`,
    maxScanKeys,
  );
  if (digestJson(currentKeys) !== digestJson(expectedNamespaceKeys)) {
    throw cleanupConflict("admin_run_namespace_changed");
  }
  const currentSnapshotRaw = new Map();
  for (const key of currentKeys) {
    const parsed = parseAdminRunKey(key, runPrefix);
    if (parsed?.kind !== "snapshot") continue;
    const raw = await redis(["GET", key]);
    if (raw === null || raw === undefined) {
      throw cleanupConflict("snapshot_graph_changed");
    }
    currentSnapshotRaw.set(key, String(raw));
  }
  if (digestSnapshotGraph(currentSnapshotRaw) !== digestSnapshotGraph(expectedSnapshotRaw)) {
    throw cleanupConflict("snapshot_graph_changed");
  }
}

function parseAdminRunKey(key, prefix) {
  const match = new RegExp(
    `^${escapeRegExp(prefix)}:\\{([^{}]+)\\}:(state|events|snapshot:(.+))$`,
    "u",
  ).exec(String(key));
  if (!match) return null;
  let runId;
  try {
    runId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!validRunId(runId) || encodeURIComponent(runId) !== match[1]) return null;
  if (match[2] === "state" || match[2] === "events") {
    return { key: String(key), kind: match[2], runId };
  }
  let snapshotId;
  try {
    snapshotId = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  if (!snapshotId || encodeURIComponent(snapshotId) !== match[3]) return null;
  return { key: String(key), kind: "snapshot", runId, snapshotId };
}

function assertCandidateDeletionScope(candidate, runPrefix) {
  if (!candidate || !validRunId(candidate.runId)
    || !Array.isArray(candidate.keys) || candidate.keys.length < 2
    || new Set(candidate.keys).size !== candidate.keys.length) {
    throw cleanupRefused("cleanup candidate has an invalid deletion scope");
  }
  const parsed = candidate.keys.map((key) => parseAdminRunKey(key, runPrefix));
  if (parsed.some((item) => !item || item.runId !== candidate.runId)) {
    throw cleanupRefused("cleanup candidate escaped the Admin Run namespace");
  }
  const stateCount = parsed.filter((item) => item.kind === "state").length;
  const eventsCount = parsed.filter((item) => item.kind === "events").length;
  if (parsed[0]?.kind !== "state" || stateCount !== 1 || eventsCount !== 1
    || parsed.some((item) => !["state", "events", "snapshot"].includes(item.kind))) {
    throw cleanupRefused("cleanup candidate is not an exact state/events/snapshot set");
  }
}

function summarizeSkippedGroups(groups, preliminaryCandidates) {
  const skipped = [...groups.values()].filter(
    (group) => !preliminaryCandidates.has(group.runId),
  );
  const reasonCounts = {};
  for (const group of skipped) {
    for (const reason of new Set(group.reasons)) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  return {
    runCount: skipped.length,
    reasonCounts: Object.fromEntries(
      Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
  };
}

function parseRunState(raw, expectedRunId, now) {
  const parsed = parseJsonObject(raw);
  if (!parsed
    || parsed.schemaVersion !== 1
    || parsed.runId !== expectedRunId
    || !Number.isSafeInteger(parsed.revision)
    || parsed.revision < 1
    || !Number.isSafeInteger(parsed.lastSequence)
    || parsed.lastSequence !== parsed.revision
    || typeof parsed.status !== "string"
    || !parsed.execution
    || typeof parsed.execution !== "object"
    || Array.isArray(parsed.execution)
    || typeof parsed.evidenceSnapshotId !== "string"
    || !/^evidence_[a-f0-9]{24}$/u.test(parsed.evidenceSnapshotId)) {
    return { ok: false, reason: "run_state_invalid" };
  }
  const endedAt = strictIsoDate(parsed.endedAt);
  const updatedAt = strictIsoDate(parsed.updatedAt);
  if (!endedAt || !updatedAt) return { ok: false, reason: "run_state_invalid" };
  const lease = parsed.execution.lease;
  let activeLease = false;
  if (lease !== null && lease !== undefined) {
    if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
      return { ok: false, reason: "run_state_invalid" };
    }
    const expiresAt = strictIsoDate(lease.expiresAt);
    if (!expiresAt) return { ok: false, reason: "run_state_invalid" };
    activeLease = expiresAt.getTime() > now.getTime();
  }
  return {
    ok: true,
    value: {
      status: parsed.status,
      endedAt,
      updatedAt,
      activeLease,
      evidenceSnapshotId: parsed.evidenceSnapshotId,
    },
  };
}

function parseSnapshotRecord(raw, parsedKey) {
  const record = parseJsonObject(raw);
  if (!record) return { ok: false, reason: "snapshot_record_invalid" };
  if (record.recordType === SNAPSHOT_REFERENCE_TYPE) {
    const ownerRunId = String(record.ownerRunId || "");
    const snapshotId = String(record.snapshotId || "");
    const hash = String(record.contentSha256 || "").toLowerCase();
    if (record.schemaVersion !== 1
      || !validRunId(ownerRunId)
      || snapshotId !== parsedKey.snapshotId
      || snapshotId !== `evidence_${hash.slice(0, 24)}`
      || !/^[a-f0-9]{64}$/u.test(hash)) {
      return { ok: false, reason: "snapshot_reference_invalid" };
    }
    return { ok: true, value: { kind: "reference", ownerRunId, snapshotId } };
  }
  const snapshotId = String(record.snapshotId || "");
  const hash = String(record.contentSha256 || "").toLowerCase();
  if (snapshotId !== parsedKey.snapshotId
    || snapshotId !== `evidence_${hash.slice(0, 24)}`
    || !/^[a-f0-9]{64}$/u.test(hash)) {
    return { ok: false, reason: "snapshot_record_invalid" };
  }
  if (record.recordType === SNAPSHOT_GZIP_TYPE) {
    if (record.schemaVersion !== 1
      || record.encoding !== "gzip+base64"
      || !Number.isSafeInteger(record.uncompressedBytes)
      || record.uncompressedBytes < 1
      || !Number.isSafeInteger(record.compressedBytes)
      || record.compressedBytes < 1
      || typeof record.payload !== "string"
      || !record.payload) {
      return { ok: false, reason: "snapshot_record_invalid" };
    }
  } else if (record.schemaVersion !== 1 || typeof record.question !== "string") {
    return { ok: false, reason: "snapshot_record_invalid" };
  }
  return { ok: true, value: { kind: "full", snapshotId } };
}

function protectReferenceChain(first, { records, runPrefix, protectedKeys }) {
  let current = first;
  const visited = new Set();
  while (current?.kind === "reference") {
    const targetKey = snapshotKeyFor(
      runPrefix,
      current.ownerRunId,
      current.snapshotId,
    );
    if (visited.has(targetKey)) return { ok: false, reason: "snapshot_reference_cycle" };
    visited.add(targetKey);
    protectedKeys.add(targetKey);
    current = records.get(targetKey);
    if (!current) return { ok: false, reason: "snapshot_reference_target_missing" };
  }
  return current?.kind === "full"
    ? { ok: true }
    : { ok: false, reason: "snapshot_reference_target_invalid" };
}

async function loadHistoryRecord(redis, prefix, runId) {
  const encoded = encodeURIComponent(runId);
  const candidates = [
    { kind: "current", key: `{${prefix}}:run:${encoded}` },
    { kind: "legacy", key: `${prefix}:run:${encoded}` },
  ];
  for (const candidate of candidates) {
    const raw = await redis(["GET", candidate.key]);
    if (raw === null || raw === undefined) continue;
    const record = parseJsonObject(raw);
    const questionSummary = String(record?.questionSummary || "");
    if (!record
      || record.schemaVersion !== 1
      || record.runId !== runId
      || !questionSummary.trim()
      || questionSummary.length > MAX_QUESTION_SUMMARY_LENGTH) {
      return { ok: false, reason: "history_record_invalid" };
    }
    return {
      ok: true,
      value: { ...candidate, raw: String(raw) },
    };
  }
  return { ok: false, reason: "history_question_summary_missing" };
}

async function measureKey(redis, key, type) {
  try {
    const result = Number(await redis(["MEMORY", "USAGE", key, "SAMPLES", "5"]));
    if (Number.isSafeInteger(result) && result >= 0) return { bytes: result };
  } catch (error) {
    if (error?.code !== "admin_run_cleanup_redis_command_rejected") throw error;
    // Upstash plans without MEMORY USAGE still support STRLEN for strings.
  }
  if (type === "string") {
    const result = Number(await redis(["STRLEN", key]));
    if (Number.isSafeInteger(result) && result >= 0) return { bytes: result };
  }
  return { bytes: null };
}

function snapshotKeyFor(prefix, runId, snapshotId) {
  return `${prefix}:{${encodeURIComponent(runId)}}:snapshot:${encodeURIComponent(snapshotId)}`;
}

function normalizeLimits(value) {
  return Object.freeze({
    maxRuns: boundedPositiveInteger(value.maxRuns, DEFAULT_MAX_RUNS, 10_000),
    maxKeys: boundedPositiveInteger(value.maxKeys, DEFAULT_MAX_DELETE_KEYS, 100_000),
    maxKnownBytes: boundedPositiveInteger(
      value.maxKnownBytes,
      DEFAULT_MAX_KNOWN_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
    maxScanKeys: boundedPositiveInteger(value.maxScanKeys, DEFAULT_MAX_SCAN_KEYS, 1_000_000),
  });
}

function boundedPositiveInteger(value, fallback, maximum) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new RangeError(`cleanup limit must be an integer between 1 and ${maximum}`);
  }
  return number;
}

function requiredPositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be an explicitly configured positive number`);
  }
  return number;
}

function normalizePrefix(value, fallback) {
  const prefix = String(value || fallback).trim() || fallback;
  if (prefix.length > 160 || /[{}\r\n]/u.test(prefix)) {
    throw new TypeError("invalid Redis key prefix");
  }
  return prefix;
}

function validRunId(value) {
  return Boolean(value)
    && value.length <= 200
    && !/[\u0000-\u001f{}\s]/u.test(value);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictIsoDate(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) return null;
  return date;
}

function validDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function assertSameRedisSlot(keys) {
  const slots = new Set(keys.map((key) => /^.*?\{([^{}]+)\}/u.exec(key)?.[1] || ""));
  if (slots.size !== 1 || slots.has("")) throw cleanupRefused("delete keys are not in one Redis slot");
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestSnapshotGraph(rawByKey) {
  return digestJson(
    [...rawByKey.entries()].sort(([left], [right]) => left.localeCompare(right, "en")),
  );
}

function escapeRedisGlob(value) {
  return String(value).replace(/([\\*?\[\]])/gu, "\\$1");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function cleanupRefused(message) {
  const error = new Error(`admin run cleanup refused: ${message}`);
  error.code = "admin_run_cleanup_refused";
  return error;
}

function cleanupConflict(reason) {
  const error = new Error(`admin run cleanup stopped: ${reason}`);
  error.code = "admin_run_cleanup_conflict";
  return error;
}

function cleanupCorrupt(message) {
  const error = new Error(`admin run cleanup storage is corrupt: ${message}`);
  error.code = "admin_run_cleanup_storage_corrupt";
  return error;
}

function cleanupLimit(reason) {
  const error = new Error(`admin run cleanup safety limit reached: ${reason}`);
  error.code = "admin_run_cleanup_limit_exceeded";
  return error;
}
