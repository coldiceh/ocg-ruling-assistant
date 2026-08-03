const RECORD_SCHEMA_VERSION = 1;
const EXPORT_SCHEMA_VERSION = 4;
const DEFAULT_KEY_PREFIX = "admin-lab-records:v1";
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_RETENTION_ENTRIES = 10_000;
const RETENTION_PRUNE_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 1_800;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TTL_SECONDS = 2_147_483_647;
const MAX_QUESTION_SUMMARY_LENGTH = 500;
const MAX_RATING_NOTE_LENGTH = 4_000;

export const ADMIN_LAB_HUMAN_RATINGS = Object.freeze([
  "correct",
  "partially_correct",
  "incorrect",
  "needs_review",
]);

const HUMAN_RATING_SET = new Set(ADMIN_LAB_HUMAN_RATINGS);

const REGISTER_RUN_SCRIPT = `
-- admin-lab-record-register-v1
local existingRaw = redis.call("GET", KEYS[1])
if existingRaw then
  if existingRaw ~= ARGV[1] then
    return "CONFLICT"
  end
  redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
  local existingTtl = tonumber(ARGV[4])
  if existingTtl ~= nil and existingTtl > 0 then
    redis.call("EXPIRE", KEYS[1], existingTtl)
  end
  return "UNCHANGED"
end
local ok, record = pcall(cjson.decode, ARGV[1])
if not ok or tostring(record["runId"]) ~= tostring(ARGV[3]) then
  return "INVALID"
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
local ttl = tonumber(ARGV[4])
if ttl ~= nil and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return "REGISTERED"
`.trim();

const PRUNE_HISTORY_SCRIPT = `
-- admin-lab-record-prune-v1
local maxEntries = tonumber(ARGV[1])
if maxEntries == nil or maxEntries < 1 then
  return -1
end

local deleted = 0
for argumentIndex = 2, #ARGV do
  local runId = ARGV[argumentIndex]
  local reverseRank = redis.call("ZREVRANK", KEYS[1], runId)
  if reverseRank and reverseRank >= maxEntries then
    local keyOffset = 2 + ((argumentIndex - 2) * 3)
    redis.call("ZREM", KEYS[1], runId)
    redis.call("DEL", KEYS[keyOffset], KEYS[keyOffset + 1], KEYS[keyOffset + 2])
    deleted = deleted + 1
  end
end
return deleted
`.trim();

const SAVE_RATING_SCRIPT = `
-- admin-lab-record-rating-v1
if redis.call("EXISTS", KEYS[1]) == 0 then
  return "NOT_FOUND"
end
local ok, rating = pcall(cjson.decode, ARGV[1])
if not ok or tostring(rating["runId"]) ~= tostring(ARGV[2]) then
  return "INVALID"
end
redis.call("SET", KEYS[2], ARGV[1])
local ttl = tonumber(ARGV[3])
if ttl ~= nil and ttl > 0 then
  redis.call("EXPIRE", KEYS[2], ttl)
end
return "SAVED"
`.trim();

const SAVE_REPAIR_AUDIT_SCRIPT = `
-- admin-lab-record-save-repair-audit-v1
if redis.call("EXISTS", KEYS[1]) == 0 then
  return "NOT_FOUND"
end
local existingRaw = redis.call("GET", KEYS[2])
if existingRaw then
  if existingRaw == ARGV[1] then
    return "UNCHANGED"
  end
  return "CONFLICT"
end
redis.call("SET", KEYS[2], ARGV[1])
local auditTtl = tonumber(ARGV[2])
if auditTtl ~= nil and auditTtl > 0 then
  redis.call("EXPIRE", KEYS[2], auditTtl)
end
return "SAVED"
`.trim();

/**
 * Explicit process-local test double. Production callers should use
 * createConfiguredAdminLabRecordStore(), which fails closed without Redis.
 */
export function createMemoryAdminLabRecordStore({
  now = () => new Date(),
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const retentionLimit = normalizeMaxEntries(maxEntries);
  const records = new Map();
  const ratings = new Map();
  const repairAudits = new Map();

  async function registerRun(input = {}) {
    const record = normalizeRunRecord(input, { now });
    if (records.has(record.runId)) {
      const existing = records.get(record.runId);
      if (!sameRunRecord(existing, record)) throw recordConflict(record.runId);
      return cloneJson(existing);
    }
    records.set(record.runId, cloneJson(record));
    pruneMemoryHistory();
    return cloneJson(record);
  }

  function pruneMemoryHistory() {
    if (records.size <= retentionLimit) return;
    const expired = [...records.values()]
      .sort(compareRunRecords)
      .slice(retentionLimit);
    for (const record of expired) {
      records.delete(record.runId);
      ratings.delete(record.runId);
      repairAudits.delete(record.runId);
    }
  }

  async function getRun(runId) {
    const id = normalizeRunId(runId);
    if (!records.has(id)) return null;
    return cloneJson(attachRepairAudit(records.get(id), repairAudits.get(id)));
  }

  async function listRuns(options = {}) {
    const pagination = normalizePagination(options);
    const ordered = [...records.values()].sort(compareRunRecords);
    const page = ordered.slice(pagination.offset, pagination.offset + pagination.limit);
    const nextOffset = pagination.offset + page.length;
    return {
      records: page.map((record) => attachRating(
        attachRepairAudit(record, repairAudits.get(record.runId)),
        ratings.get(record.runId),
      )),
      nextCursor: nextOffset < ordered.length ? encodeCursor(nextOffset) : null,
      count: page.length,
    };
  }

  async function saveHumanRating(input = {}) {
    const runId = normalizeRunId(input.runId);
    if (!records.has(runId)) throw recordNotFound(runId);
    const rating = normalizeHumanRating(input, { now });
    ratings.set(runId, cloneJson(rating));
    return cloneJson(rating);
  }

  async function getHumanRating(runId) {
    const id = normalizeRunId(runId);
    return ratings.has(id) ? cloneJson(ratings.get(id)) : null;
  }

  async function saveRunRepairProvenance(input = {}) {
    const runId = normalizeRunId(input.runId);
    if (!records.has(runId)) throw recordNotFound(runId);
    const repairProvenance = normalizeRepairProvenance(input.repairProvenance);
    if (!repairProvenance) throw new TypeError("repairProvenance is required");
    const existing = repairAudits.get(runId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(repairProvenance)) {
      throw recordConflict(runId);
    }
    repairAudits.set(runId, cloneJson(repairProvenance));
    return cloneJson(repairProvenance);
  }

  return Object.freeze({
    kind: "memory",
    persistent: false,
    ttlSeconds: null,
    maxEntries: retentionLimit,
    registerRun,
    getRun,
    listRuns,
    saveHumanRating,
    getHumanRating,
    saveRunRepairProvenance,
  });
}

/**
 * Upstash/Vercel KV Redis REST implementation.
 *
 * The current sorted-set index retains the newest configured number of records
 * (100 by default). Pruning removes each expired member and its exact current
 * record/rating/repair keys in one cluster-safe script. Legacy untagged keys
 * remain read-only compatible and are never deleted by current retention.
 * Record/rating TTL is disabled by default. Opting into TTL may leave stale
 * retained index members; listRuns filters missing records without deleting a
 * history entry as a side effect.
 */
export function createRedisAdminLabRecordStore(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const config = redisConfig(env, options);
  if (!config.url || !config.token || typeof fetchImpl !== "function") {
    throw storageUnavailable();
  }

  const keyPrefix = normalizeKeyPrefix(
    options.keyPrefix !== undefined
      ? options.keyPrefix
      : env.ADMIN_LAB_RECORD_REDIS_KEY_PREFIX,
  );
  const timeoutMs = normalizeTimeoutMs(
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : env.ADMIN_LAB_RECORD_REDIS_TIMEOUT_MS,
  );
  const ttlSeconds = normalizeTtlSeconds(
    options.ttlSeconds !== undefined
      ? options.ttlSeconds
      : env.ADMIN_LAB_RECORD_TTL_SECONDS,
  );
  const maxEntries = normalizeMaxEntries(
    options.maxEntries !== undefined
      ? options.maxEntries
      : env.ADMIN_LAB_RECORD_MAX_ENTRIES,
  );
  const now = options.now || (() => new Date());
  if (typeof now !== "function") throw new TypeError("now must be a function");

  async function registerRun(input = {}) {
    const record = normalizeRunRecord(input, { now });
    const keys = redisKeys(keyPrefix, record.runId);
    const result = await redisCommand(config, fetchImpl, timeoutMs, [
      "EVAL",
      REGISTER_RUN_SCRIPT,
      "2",
      keys.record,
      keys.index,
      serializeJson(record),
      String(Date.parse(record.createdAt)),
      record.runId,
      ttlSeconds === null ? "" : String(ttlSeconds),
    ]);
    if (result === "REGISTERED" || result === "UNCHANGED") {
      await pruneRedisHistory();
      return cloneJson(record);
    }
    if (result === "CONFLICT") throw recordConflict(record.runId);
    if (result === "INVALID") throw storageCorrupt("register transaction rejected invalid data");
    throw storageCorrupt(`unexpected register result: ${String(result)}`);
  }

  async function pruneRedisHistory() {
    const indexKey = redisKeys(keyPrefix, "_").index;
    for (;;) {
      const overflow = await redisCommand(config, fetchImpl, timeoutMs, [
        "ZREVRANGE",
        indexKey,
        String(maxEntries),
        String(maxEntries + RETENTION_PRUNE_BATCH_SIZE - 1),
      ]);
      if (!Array.isArray(overflow)) {
        throw storageCorrupt("history retention scan is not an array");
      }
      if (overflow.length === 0) return;

      const runIds = overflow.map(normalizeRunId);
      const exactKeys = runIds.flatMap((runId) => {
        const keys = redisKeys(keyPrefix, runId);
        return [keys.record, keys.rating, keys.repairAudit];
      });
      const result = await redisCommand(config, fetchImpl, timeoutMs, [
        "EVAL",
        PRUNE_HISTORY_SCRIPT,
        String(1 + exactKeys.length),
        indexKey,
        ...exactKeys,
        String(maxEntries),
        ...runIds,
      ]);
      if (!Number.isInteger(Number(result)) || Number(result) < 0) {
        throw storageCorrupt("history retention transaction returned an unexpected result");
      }
    }
  }

  async function getRun(runId) {
    const id = normalizeRunId(runId);
    const record = await readCompatibleRunRecord(id);
    if (!record) return null;
    const [rating, repairAudit] = await Promise.all([
      getHumanRating(id),
      getRunRepairProvenance(id),
    ]);
    return attachRating(attachRepairAudit(record, repairAudit), rating);
  }

  async function listRuns(options = {}) {
    const pagination = normalizePagination(options);
    const legacyMemberResult = await redisCommand(config, fetchImpl, timeoutMs, [
      "ZREVRANGE",
      legacyRedisKeys(keyPrefix, "_").index,
      "0",
      "-1",
    ]);
    if (!Array.isArray(legacyMemberResult)) {
      throw storageCorrupt("legacy history index is not an array");
    }
    if (legacyMemberResult.length > 0) {
      return listCompatibleRuns(pagination, legacyMemberResult);
    }

    const indexKey = redisKeys(keyPrefix, "_").index;
    const memberResult = await redisCommand(config, fetchImpl, timeoutMs, [
      "ZREVRANGE",
      indexKey,
      String(pagination.offset),
      String(pagination.offset + pagination.limit),
    ]);
    if (!Array.isArray(memberResult)) throw storageCorrupt("history index is not an array");
    const pageRunIds = memberResult
      .slice(0, pagination.limit)
      .map(normalizeRunId);
    const hasMore = memberResult.length > pagination.limit;
    if (pageRunIds.length === 0) {
      return { records: [], nextCursor: null, count: 0 };
    }

    const recordKeys = pageRunIds.map((runId) => redisKeys(keyPrefix, runId).record);
    const ratingKeys = pageRunIds.map((runId) => redisKeys(keyPrefix, runId).rating);
    const repairAuditKeys = pageRunIds.map((runId) => redisKeys(keyPrefix, runId).repairAudit);
    const values = await redisCommand(config, fetchImpl, timeoutMs, [
      "MGET",
      ...recordKeys,
      ...ratingKeys,
      ...repairAuditKeys,
    ]);
    if (!Array.isArray(values) || values.length !== pageRunIds.length * 3) {
      throw storageCorrupt("history MGET returned an unexpected shape");
    }

    const result = [];
    for (let index = 0; index < pageRunIds.length; index += 1) {
      const rawRecord = values[index];
      if (rawRecord === null || rawRecord === undefined) continue;
      const record = parseRunRecord(rawRecord, pageRunIds[index]);
      const rawRating = values[index + pageRunIds.length];
      const rating = rawRating === null || rawRating === undefined
        ? null
        : parseHumanRating(rawRating, pageRunIds[index]);
      const rawRepairAudit = values[index + (pageRunIds.length * 2)];
      const repairAudit = rawRepairAudit === null || rawRepairAudit === undefined
        ? null
        : parseRepairProvenance(rawRepairAudit, pageRunIds[index]);
      result.push(attachRating(attachRepairAudit(record, repairAudit), rating));
    }
    return {
      records: result,
      nextCursor: hasMore
        ? encodeCursor(pagination.offset + pagination.limit)
        : null,
      count: result.length,
    };
  }

  async function saveHumanRating(input = {}) {
    const rating = normalizeHumanRating(input, { now });
    let keys = redisKeys(keyPrefix, rating.runId);
    const currentRecord = await redisCommand(config, fetchImpl, timeoutMs, [
      "GET",
      keys.record,
    ]);
    if (currentRecord === null || currentRecord === undefined) {
      const legacyRaw = await redisCommand(config, fetchImpl, timeoutMs, [
        "GET",
        legacyRedisKeys(keyPrefix, rating.runId).record,
      ]);
      if (legacyRaw !== null && legacyRaw !== undefined) {
        await registerRun(parseRunRecord(legacyRaw, rating.runId));
        keys = redisKeys(keyPrefix, rating.runId);
      }
    }
    const result = await redisCommand(config, fetchImpl, timeoutMs, [
      "EVAL",
      SAVE_RATING_SCRIPT,
      "2",
      keys.record,
      keys.rating,
      serializeJson(rating),
      rating.runId,
      ttlSeconds === null ? "" : String(ttlSeconds),
    ]);
    if (result === "SAVED") return cloneJson(rating);
    if (result === "NOT_FOUND") throw recordNotFound(rating.runId);
    if (result === "INVALID") throw storageCorrupt("rating transaction rejected invalid data");
    throw storageCorrupt(`unexpected rating result: ${String(result)}`);
  }

  async function getHumanRating(runId) {
    const id = normalizeRunId(runId);
    let raw = await redisCommand(config, fetchImpl, timeoutMs, [
      "GET",
      redisKeys(keyPrefix, id).rating,
    ]);
    if (raw === null || raw === undefined) {
      raw = await redisCommand(config, fetchImpl, timeoutMs, [
        "GET",
        legacyRedisKeys(keyPrefix, id).rating,
      ]);
    }
    return raw === null || raw === undefined ? null : parseHumanRating(raw, id);
  }

  async function saveRunRepairProvenance(input = {}) {
    const runId = normalizeRunId(input.runId);
    const repairProvenance = normalizeRepairProvenance(input.repairProvenance);
    if (!repairProvenance) throw new TypeError("repairProvenance is required");
    const keys = redisKeys(keyPrefix, runId);
    const serialized = serializeJson(repairProvenance);
    const result = await redisCommand(config, fetchImpl, timeoutMs, [
      "EVAL",
      SAVE_REPAIR_AUDIT_SCRIPT,
      "2",
      keys.record,
      keys.repairAudit,
      serialized,
      ttlSeconds === null ? "" : String(ttlSeconds),
    ]);
    if (result === "SAVED" || result === "UNCHANGED") return cloneJson(repairProvenance);
    if (result === "NOT_FOUND") throw recordNotFound(runId);
    if (result === "CONFLICT") throw recordConflict(runId);
    throw storageCorrupt(`unexpected repair audit result: ${String(result)}`);
  }

  async function getRunRepairProvenance(runId) {
    const id = normalizeRunId(runId);
    const raw = await redisCommand(config, fetchImpl, timeoutMs, [
      "GET",
      redisKeys(keyPrefix, id).repairAudit,
    ]);
    return raw === null || raw === undefined ? null : parseRepairProvenance(raw, id);
  }

  async function readCompatibleRunRecord(runId) {
    let raw = await redisCommand(config, fetchImpl, timeoutMs, [
      "GET",
      redisKeys(keyPrefix, runId).record,
    ]);
    if (raw === null || raw === undefined) {
      raw = await redisCommand(config, fetchImpl, timeoutMs, [
        "GET",
        legacyRedisKeys(keyPrefix, runId).record,
      ]);
    }
    return raw === null || raw === undefined ? null : parseRunRecord(raw, runId);
  }

  async function listCompatibleRuns(pagination, legacyMemberResult) {
    const currentMemberResult = await redisCommand(config, fetchImpl, timeoutMs, [
      "ZREVRANGE",
      redisKeys(keyPrefix, "_").index,
      "0",
      "-1",
    ]);
    if (!Array.isArray(currentMemberResult)) {
      throw storageCorrupt("history index is not an array");
    }
    const runIds = [...new Set([
      ...currentMemberResult.map(normalizeRunId),
      ...legacyMemberResult.map(normalizeRunId),
    ])];
    const records = [];
    for (let offset = 0; offset < runIds.length; offset += 16) {
      const batch = runIds.slice(offset, offset + 16);
      const loaded = await Promise.all(batch.map(async (runId) => {
        const record = await readCompatibleRunRecord(runId);
        if (!record) return null;
        const [rating, repairAudit] = await Promise.all([
          getHumanRating(runId),
          getRunRepairProvenance(runId),
        ]);
        return attachRating(attachRepairAudit(record, repairAudit), rating);
      }));
      records.push(...loaded.filter(Boolean));
    }
    records.sort(compareRunRecords);
    const page = records.slice(
      pagination.offset,
      pagination.offset + pagination.limit,
    );
    const nextOffset = pagination.offset + page.length;
    return {
      records: page,
      nextCursor: nextOffset < records.length ? encodeCursor(nextOffset) : null,
      count: page.length,
    };
  }

  return Object.freeze({
    kind: "redis-rest",
    persistent: true,
    ttlSeconds,
    maxEntries,
    registerRun,
    getRun,
    listRuns,
    saveHumanRating,
    getHumanRating,
    saveRunRepairProvenance,
  });
}

/**
 * Production-safe selector. Memory mode must be opted into in code as well as
 * configuration so a deployment typo cannot silently lose history.
 */
export function createConfiguredAdminLabRecordStore(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  const mode = String(
    options.mode ?? env.ADMIN_LAB_RECORD_STORAGE ?? "redis",
  ).trim().toLowerCase();

  if (mode === "memory") {
    if (options.allowMemoryStore !== true) throw memoryStoreForbidden();
    return createMemoryAdminLabRecordStore(options);
  }
  if (!["redis", "redis-rest", "upstash", "kv", "auto"].includes(mode)) {
    throw new RangeError(`unsupported admin lab record storage mode: ${mode || "(empty)"}`);
  }
  return createRedisAdminLabRecordStore({ ...options, env });
}

/**
 * Safe JSON download payload. Only the record schema's public fields survive;
 * credentials or other caller-added properties are never copied.
 */
export function exportAdminLabRecordsJson(records, {
  exportedAt = new Date(),
} = {}) {
  const safeRecords = normalizeExportRecords(records);
  return JSON.stringify({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportType: "admin_model_lab_history",
    exportedAt: normalizeDate(exportedAt, "exportedAt"),
    records: safeRecords,
  }, null, 2);
}

/**
 * Spreadsheet-safe UTF-8 CSV. Formula-like cells are prefixed with an
 * apostrophe before RFC 4180 quoting.
 */
export function exportAdminLabRecordsCsv(records) {
  const safeRecords = normalizeExportRecords(records);
  const headers = [
    "runId",
    "createdAt",
    "questionSummary",
    "preparationProvider",
    "preparationModel",
    "finalProvider",
    "finalModel",
    "reasoningEffort",
    "reasoningMode",
    "promptVersion",
    "status",
    "startedAt",
    "endedAt",
    "evidenceSnapshotId",
    "evidenceSnapshotSha256",
    "decisionPacketId",
    "decisionPacketSha256",
    "forkSourceRunId",
    "forkRootSourceRunId",
    "sourceEvidenceSnapshotId",
    "sourceEvidenceSnapshotSha256",
    "sourceDecisionPacketId",
    "sourceDecisionPacketSha256",
    "repairAttempted",
    "repairOutcome",
    "repairInitialRequestId",
    "repairRequestId",
    "repairValidationErrorsJson",
    "resultJson",
    "meteringJson",
    "humanRating",
    "ratingNote",
    "ratingUpdatedAt",
  ];
  const rows = safeRecords.map((record) => {
    const preparation = record.modelConfig.preparation || {};
    const finalRuling = record.modelConfig.finalRuling || {};
    const prompt = record.modelConfig.prompt || {};
    const fork = record.forkProvenance || {};
    const repair = record.repairProvenance || record.result?.repair || {};
    return [
      record.runId,
      record.createdAt,
      record.questionSummary,
      preparation.provider || "",
      preparation.model || "",
      finalRuling.provider || "",
      finalRuling.model || finalRuling.requestedModel || "",
      finalRuling.reasoningEffort || "",
      finalRuling.reasoningMode || "",
      prompt.version || "",
      record.status || "",
      record.startedAt || "",
      record.endedAt || "",
      record.evidenceSnapshotId || "",
      record.evidenceSnapshotSha256 || "",
      record.decisionPacketId || "",
      record.decisionPacketSha256 || "",
      fork.sourceRunId || "",
      fork.rootSourceRunId || "",
      fork.sourceEvidenceSnapshotId || "",
      fork.sourceEvidenceSnapshotSha256 || "",
      fork.sourceDecisionPacketId || "",
      fork.sourceDecisionPacketSha256 || "",
      repair.attempted === true ? "true" : "",
      repair.outcome || "",
      repair.initialAttempt?.requestId || repair.attempts?.[0]?.requestId || "",
      repair.submission?.requestId || repair.attempts?.[1]?.requestId || "",
      repair.validationErrors ? JSON.stringify(repair.validationErrors) : "",
      record.result ? JSON.stringify(record.result) : "",
      record.metering ? JSON.stringify(record.metering) : "",
      record.humanRating?.rating || "",
      record.humanRating?.note || "",
      record.humanRating?.updatedAt || "",
    ];
  });
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

function normalizeRunRecord(input, { now }) {
  const runId = normalizeRunId(input.runId);
  const createdAt = normalizeDate(input.createdAt ?? now(), "createdAt");
  const questionSource = input.questionSummary ?? input.question;
  const questionSummary = summarizeQuestion(questionSource);
  if (!questionSummary) throw new TypeError("question is required");
  return compactObject({
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId,
    createdAt,
    questionSummary,
    modelConfig: normalizeModelConfig(
      input.modelConfig ?? input.executionProfile ?? {},
    ),
    evidenceSnapshotId: optionalText(input.evidenceSnapshotId, 240),
    evidenceSnapshotSha256: normalizeSha256(input.evidenceSnapshotSha256),
    decisionPacketId: optionalText(input.decisionPacketId, 240),
    decisionPacketSha256: normalizeSha256(input.decisionPacketSha256),
    forkProvenance: normalizeForkProvenance(input.forkProvenance),
    repairProvenance: normalizeRepairProvenance(input.repairProvenance),
  });
}

function normalizeHumanRating(input, { now }) {
  const runId = normalizeRunId(input.runId);
  const rating = String(input.rating || "").trim().toLowerCase();
  if (!HUMAN_RATING_SET.has(rating)) {
    throw new RangeError(
      `rating must be one of: ${ADMIN_LAB_HUMAN_RATINGS.join(", ")}`,
    );
  }
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId,
    rating,
    note: String(input.note || "").trim().slice(0, MAX_RATING_NOTE_LENGTH),
    updatedAt: normalizeDate(input.updatedAt ?? now(), "updatedAt"),
  };
}

function normalizeModelConfig(value) {
  const source = isPlainObject(value) ? value : {};
  const preparationSource = isPlainObject(source.preparation)
    ? source.preparation
    : source;
  const finalSource = isPlainObject(source.finalRuling)
    ? source.finalRuling
    : source;
  const promptSource = isPlainObject(source.prompt) ? source.prompt : source;

  return compactObject({
    preparation: compactObject({
      provider: optionalText(
        preparationSource.provider ?? source.preparationProvider,
        80,
      ),
      model: optionalText(
        preparationSource.model ?? source.preparationModel,
        160,
      ),
    }),
    finalRuling: compactObject({
      provider: optionalText(
        finalSource.provider ?? source.finalProvider ?? source.provider,
        80,
      ),
      requestedModel: optionalText(
        finalSource.requestedModel ?? source.requestedModel,
        160,
      ),
      model: optionalText(
        finalSource.model ?? source.finalModel ?? source.model,
        160,
      ),
      reasoningEffort: optionalText(
        finalSource.reasoningEffort ?? source.reasoningEffort,
        40,
      ),
      reasoningMode: optionalText(
        finalSource.reasoningMode ?? source.reasoningMode,
        40,
      ),
      maxOutputTokens: optionalNonNegativeNumber(
        finalSource.maxOutputTokens ?? source.maxOutputTokens,
      ),
    }),
    prompt: compactObject({
      version: optionalText(
        promptSource.version ?? source.promptVersion,
        160,
      ),
      sha256: normalizeSha256(
        promptSource.sha256 ?? source.promptSha256,
      ),
    }),
  });
}

function normalizeForkProvenance(value) {
  if (!isPlainObject(value)) return undefined;
  return compactObject({
    schemaVersion: optionalNonNegativeNumber(value.schemaVersion),
    sourceRunId: optionalText(value.sourceRunId, 240),
    rootSourceRunId: optionalText(value.rootSourceRunId, 240),
    sourceEvidenceSnapshotId: optionalText(value.sourceEvidenceSnapshotId, 240),
    sourceEvidenceSnapshotSha256: normalizeSha256(value.sourceEvidenceSnapshotSha256),
    sourceDecisionPacketId: optionalText(value.sourceDecisionPacketId, 240),
    sourceDecisionPacketSha256: normalizeSha256(value.sourceDecisionPacketSha256),
    requestFingerprint: normalizeSha256(value.requestFingerprint),
    idempotencyKeySha256: normalizeSha256(value.idempotencyKeySha256),
  });
}

function normalizeRepairProvenance(value) {
  if (!isPlainObject(value)) return undefined;
  return sanitizeExportValue(compactObject({
    schemaVersion: optionalNonNegativeNumber(value.schemaVersion),
    attempted: value.attempted === true ? true : undefined,
    maxAttempts: optionalNonNegativeNumber(value.maxAttempts),
    outcome: optionalText(value.outcome, 120),
    requestedAt: normalizeOptionalDate(value.requestedAt, "repairProvenance.requestedAt"),
    validationErrors: Array.isArray(value.validationErrors)
      ? value.validationErrors.slice(0, 12).map((item) => String(item).slice(0, 320))
      : undefined,
    invariants: isPlainObject(value.invariants) ? value.invariants : undefined,
    initialAttempt: isPlainObject(value.initialAttempt) ? value.initialAttempt : undefined,
    submission: isPlainObject(value.submission) ? value.submission : undefined,
    attempts: Array.isArray(value.attempts) ? value.attempts.slice(0, 2) : undefined,
  }));
}

function normalizeExportRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  return records.map((input) => {
    const record = normalizeRunRecord({
      runId: input?.runId,
      createdAt: input?.createdAt,
      questionSummary: input?.questionSummary,
      modelConfig: input?.modelConfig,
      evidenceSnapshotId: input?.evidenceSnapshotId,
      evidenceSnapshotSha256: input?.evidenceSnapshotSha256,
      decisionPacketId: input?.decisionPacketId,
      decisionPacketSha256: input?.decisionPacketSha256,
      forkProvenance: input?.forkProvenance,
      repairProvenance: input?.repairProvenance,
    }, { now: () => new Date(0) });
    const rating = input?.humanRating === null || input?.humanRating === undefined
      ? null
      : normalizeHumanRating(input.humanRating, {
        now: () => new Date(0),
      });
    const result = normalizeExportResult(input?.result);
    const evidenceSnapshotId = optionalText(
      input?.evidenceSnapshotId ?? result?.evidenceSnapshotId,
      240,
    ) || null;
    return {
      ...attachRating(record, rating),
      status: optionalText(input?.status, 40) || null,
      startedAt: normalizeOptionalDate(input?.startedAt, "startedAt"),
      endedAt: normalizeOptionalDate(input?.endedAt, "endedAt"),
      evidenceSnapshotId,
      repairProvenance: normalizeRepairProvenance(
        input?.repairProvenance ?? result?.repair,
      ) || null,
      result,
      metering: sanitizeExportValue(input?.metering ?? result?.metering),
    };
  });
}

function normalizeExportResult(value) {
  if (!isPlainObject(value)) return null;
  const allowedKeys = [
    "schemaVersion",
    "evidenceSnapshotId",
    "finalRuling",
    "validation",
    "provider",
    "usage",
    "cost",
    "metering",
    "metrics",
    "latency",
    "prompt",
    "repair",
  ];
  const result = {};
  for (const key of allowedKeys) {
    if (value[key] === undefined) continue;
    result[key] = sanitizeExportValue(value[key]);
  }
  if (result.evidenceSnapshotId !== undefined) {
    result.evidenceSnapshotId =
      optionalText(result.evidenceSnapshotId, 240) || null;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function sanitizeExportValue(value, {
  depth = 0,
  seen = new WeakSet(),
} = {}) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (depth > 32) return null;
  if (typeof value !== "object") return null;
  if (seen.has(value)) throw new TypeError("export data must not contain cycles");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitizeExportValue(item, {
      depth: depth + 1,
      seen,
    }));
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveExportKey(key)) continue;
      result[key] = sanitizeExportValue(item, {
        depth: depth + 1,
        seen,
      });
    }
  }
  seen.delete(value);
  return result;
}

function isSensitiveExportKey(value) {
  return /^(?:api[-_]?key|authorization|cookie|password|secret|token|access[-_]?token|refresh[-_]?token|session[-_]?token|csrf[-_]?token|headers|requestHeaders|responseHeaders)$/iu
    .test(String(value || ""));
}

function normalizeOptionalDate(value, name) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return normalizeDate(value, name);
}

function attachRating(record, rating) {
  return {
    ...cloneJson(record),
    humanRating: rating ? cloneJson(rating) : null,
  };
}

function attachRepairAudit(record, repairProvenance) {
  return repairProvenance
    ? { ...cloneJson(record), repairProvenance: cloneJson(repairProvenance) }
    : cloneJson(record);
}

function parseRunRecord(raw, expectedRunId) {
  const parsed = parseStoredJson(raw, "run record");
  let normalized;
  try {
    normalized = normalizeRunRecord(parsed, { now: () => new Date(0) });
  } catch {
    throw storageCorrupt("stored run record is invalid");
  }
  if (normalized.runId !== expectedRunId) {
    throw storageCorrupt("stored run record id mismatch");
  }
  return normalized;
}

function parseHumanRating(raw, expectedRunId) {
  const parsed = parseStoredJson(raw, "human rating");
  let normalized;
  try {
    normalized = normalizeHumanRating(parsed, { now: () => new Date(0) });
  } catch {
    throw storageCorrupt("stored human rating is invalid");
  }
  if (normalized.runId !== expectedRunId) {
    throw storageCorrupt("stored human rating id mismatch");
  }
  return normalized;
}

function parseRepairProvenance(raw) {
  const parsed = parseStoredJson(raw, "repair provenance");
  try {
    const normalized = normalizeRepairProvenance(parsed);
    if (!normalized) throw new TypeError("repair provenance is required");
    return normalized;
  } catch {
    throw storageCorrupt("stored repair provenance is invalid");
  }
}

function normalizePagination({ cursor = null, limit = DEFAULT_PAGE_LIMIT } = {}) {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return { offset: decodeCursor(cursor), limit: parsedLimit };
}

function encodeCursor(offset) {
  return Buffer.from(`v1:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  let decoded;
  try {
    decoded = Buffer.from(String(value), "base64url").toString("utf8");
  } catch {
    throw new TypeError("invalid history cursor");
  }
  const match = /^v1:(\d+)$/u.exec(decoded);
  if (!match) throw new TypeError("invalid history cursor");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("invalid history cursor");
  return offset;
}

function redisKeys(prefix, runId) {
  const encodedRunId = encodeURIComponent(runId);
  // Redis Cluster hashes only the text inside the first {...} pair. The
  // normalized prefix cannot contain braces, so using it as the tag keeps
  // every record/index/rating key for this history namespace in one slot.
  const slotPrefix = `{${prefix}}`;
  return {
    index: `${slotPrefix}:created`,
    record: `${slotPrefix}:run:${encodedRunId}`,
    rating: `${slotPrefix}:rating:${encodedRunId}`,
    repairAudit: `${slotPrefix}:repair:${encodedRunId}`,
  };
}

function legacyRedisKeys(prefix, runId) {
  const encodedRunId = encodeURIComponent(runId);
  return {
    index: `${prefix}:created`,
    record: `${prefix}:run:${encodedRunId}`,
    rating: `${prefix}:rating:${encodedRunId}`,
  };
}

async function redisCommand(config, fetchImpl, timeoutMs, command) {
  const controller = new AbortController();
  const timeoutError = new Error("admin lab record Redis request timed out");
  timeoutError.code = "admin_lab_record_redis_timeout";
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
    const wrapped = new Error(
      `admin lab record Redis request failed: ${error?.message || "unknown error"}`,
    );
    wrapped.code = "admin_lab_record_redis_request_failed";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    const error = new Error(
      `admin lab record Redis HTTP ${response?.status || "error"}`,
    );
    error.code = "admin_lab_record_redis_http_error";
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw storageCorrupt("Redis response is not JSON");
  }
  if (payload?.error) {
    const error = new Error(`admin lab record Redis error: ${String(payload.error)}`);
    error.code = "admin_lab_record_redis_error";
    throw error;
  }
  return payload?.result;
}

function redisConfig(env, options) {
  return {
    url: String(
      options.url
      || env.ADMIN_LAB_RECORD_REDIS_REST_URL
      || env.UPSTASH_REDIS_REST_URL
      || env.KV_REST_API_URL
      || env.REDIS_REST_API_URL
      || "",
    ).trim(),
    token: String(
      options.token
      || env.ADMIN_LAB_RECORD_REDIS_REST_TOKEN
      || env.UPSTASH_REDIS_REST_TOKEN
      || env.KV_REST_API_TOKEN
      || env.REDIS_REST_API_TOKEN
      || "",
    ).trim(),
  };
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
    throw new RangeError("ADMIN_LAB_RECORD_TTL_SECONDS must be null or a positive integer");
  }
  return number;
}

function normalizeMaxEntries(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_MAX_ENTRIES;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_RETENTION_ENTRIES) {
    throw new RangeError(
      `ADMIN_LAB_RECORD_MAX_ENTRIES must be between 1 and ${MAX_RETENTION_ENTRIES}`,
    );
  }
  return number;
}

function normalizeTimeoutMs(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_TIMEOUT_MS) {
    throw new RangeError(`Redis timeout must be between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  return number;
}

function normalizeKeyPrefix(value) {
  const prefix = String(value || DEFAULT_KEY_PREFIX).trim() || DEFAULT_KEY_PREFIX;
  if (prefix.length > 160 || /[{}\r\n]/u.test(prefix)) {
    throw new TypeError("invalid admin lab record Redis key prefix");
  }
  return prefix;
}

function normalizeRunId(value) {
  const runId = String(value || "").trim();
  if (
    !runId
    || runId.length > 200
    || /[\u0000-\u001f{}\s]/u.test(runId)
  ) {
    throw new TypeError("invalid runId");
  }
  return runId;
}

function summarizeQuestion(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_QUESTION_SUMMARY_LENGTH);
}

function normalizeDate(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date.toISOString();
}

function compareRunRecords(left, right) {
  const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return timeDelta || right.runId.localeCompare(left.runId);
}

function optionalText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function optionalNonNegativeNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeSha256(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : undefined;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .filter(([, item]) => !isPlainObject(item) || Object.keys(item).length > 0),
  );
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, "\"\"")}"`;
}

function parseStoredJson(value, label) {
  try {
    const parsed = JSON.parse(String(value));
    if (!isPlainObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw storageCorrupt(`${label} is invalid JSON`);
  }
}

function serializeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw new TypeError("admin lab records must be JSON serializable");
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameRunRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storageUnavailable() {
  const error = new Error("persistent admin lab record storage is not configured");
  error.code = "admin_lab_record_storage_unavailable";
  return error;
}

function memoryStoreForbidden() {
  const error = new Error("memory admin lab record storage requires explicit test opt-in");
  error.code = "admin_lab_record_memory_forbidden";
  return error;
}

function storageCorrupt(message) {
  const error = new Error(`admin lab record storage is corrupt: ${message}`);
  error.code = "admin_lab_record_storage_corrupt";
  return error;
}

function recordConflict(runId) {
  const error = new Error(`admin lab record conflicts with existing run: ${runId}`);
  error.code = "admin_lab_record_conflict";
  return error;
}

function recordNotFound(runId) {
  const error = new Error(`admin lab record not found: ${runId}`);
  error.code = "admin_lab_record_not_found";
  return error;
}
