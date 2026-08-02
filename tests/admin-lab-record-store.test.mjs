import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_LAB_HUMAN_RATINGS,
  createConfiguredAdminLabRecordStore,
  createMemoryAdminLabRecordStore,
  createRedisAdminLabRecordStore,
  exportAdminLabRecordsCsv,
  exportAdminLabRecordsJson,
} from "../backend/adminLabRecordStore.mjs";

const REDIS_ENV = Object.freeze({
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
});

test("configured record storage fails closed and memory is an explicit test opt-in", () => {
  assert.throws(
    () => createConfiguredAdminLabRecordStore({ env: {}, fetchImpl: null }),
    (error) => error?.code === "admin_lab_record_storage_unavailable",
  );
  assert.throws(
    () => createConfiguredAdminLabRecordStore({
      env: { ADMIN_LAB_RECORD_STORAGE: "memory" },
    }),
    (error) => error?.code === "admin_lab_record_memory_forbidden",
  );
  const memory = createConfiguredAdminLabRecordStore({
    env: { ADMIN_LAB_RECORD_STORAGE: "memory" },
    allowMemoryStore: true,
  });
  assert.equal(memory.kind, "memory");
  assert.equal(memory.persistent, false);
});

test("memory history is paginated without a 100-run retention cap and strips secrets", async () => {
  const store = createMemoryAdminLabRecordStore();
  for (let index = 0; index < 135; index += 1) {
    await store.registerRun({
      runId: `run-${String(index).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 6, 28, 0, 0, index)),
      question: `  问题 ${index}\n带有空白  `,
      modelConfig: {
        preparation: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          apiKey: "must-not-survive",
        },
        finalRuling: {
          provider: "openai",
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
          reasoningMode: "standard",
        },
        prompt: {
          version: "openai-ruling-v1",
          instructions: "must-not-survive",
        },
        password: "must-not-survive",
      },
    });
  }

  const seen = [];
  let cursor = null;
  do {
    const page = await store.listRuns({ cursor, limit: 30 });
    seen.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);

  assert.equal(seen.length, 135);
  assert.equal(seen[0].runId, "run-134");
  assert.equal(seen.at(-1).runId, "run-000");
  assert.equal(seen[0].questionSummary, "问题 134 带有空白");
  assert.equal(JSON.stringify(seen).includes("must-not-survive"), false);
});

test("memory registration is idempotent for the same run and rejects conflicting reuse", async () => {
  const store = createMemoryAdminLabRecordStore();
  const input = {
    runId: "idempotent-memory-run",
    createdAt: "2026-07-28T00:30:00.000Z",
    question: "相同运行只能登记一次",
    modelConfig: {
      provider: "openai",
      model: "gpt-5.6-terra",
    },
  };

  const first = await store.registerRun(input);
  const repeated = await store.registerRun(structuredClone(input));
  assert.deepEqual(repeated, first);
  assert.equal((await store.listRuns()).records.length, 1);

  await assert.rejects(
    store.registerRun({
      ...input,
      question: "同一个 runId 的另一份内容",
    }),
    (error) => error?.code === "admin_lab_record_conflict",
  );
});

test("human rating uses a closed enum and later saves update note and timestamp", async () => {
  const clockValues = [
    new Date("2026-07-28T01:00:00.000Z"),
    new Date("2026-07-28T01:01:00.000Z"),
    new Date("2026-07-28T01:02:00.000Z"),
  ];
  const store = createMemoryAdminLabRecordStore({
    now: () => clockValues.shift(),
  });
  await store.registerRun({ runId: "rating-run", question: "测试人工评分" });

  assert.deepEqual(ADMIN_LAB_HUMAN_RATINGS, [
    "correct",
    "partially_correct",
    "incorrect",
    "needs_review",
  ]);
  await assert.rejects(
    store.saveHumanRating({ runId: "rating-run", rating: "probably" }),
    /rating must be one of/u,
  );

  await store.saveHumanRating({
    runId: "rating-run",
    rating: "needs_review",
    note: "需要专家复核",
  });
  const updated = await store.saveHumanRating({
    runId: "rating-run",
    rating: "correct",
    note: "已核对官方 FAQ",
  });
  assert.equal(updated.rating, "correct");
  assert.equal(updated.note, "已核对官方 FAQ");
  assert.equal(updated.updatedAt, "2026-07-28T01:02:00.000Z");
  assert.deepEqual(await store.getHumanRating("rating-run"), updated);
  assert.equal((await store.listRuns()).records[0].humanRating.rating, "correct");
});

test("Redis history persists index and ratings with no default trim or TTL", async () => {
  const redis = createMockRedisRest();
  const storeA = createRedisAdminLabRecordStore({
    env: REDIS_ENV,
    fetchImpl: redis.fetchImpl,
  });
  assert.equal(storeA.ttlSeconds, null);
  await storeA.registerRun({
    runId: "redis-old",
    createdAt: "2026-07-28T02:00:00.000Z",
    question: "旧问题",
    executionProfile: {
      preparation: { provider: "deepseek", model: "deepseek-v4-flash" },
      finalRuling: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        apiKey: "never-store-this",
      },
    },
  });
  await storeA.registerRun({
    runId: "redis-new",
    createdAt: "2026-07-28T03:00:00.000Z",
    question: "新问题",
    modelConfig: { model: "gpt-5.6-sol", provider: "openai" },
  });
  await storeA.saveHumanRating({
    runId: "redis-new",
    rating: "partially_correct",
    note: "遗漏一个处理步骤",
    updatedAt: "2026-07-28T03:05:00.000Z",
  });
  const repairProvenance = {
    schemaVersion: 1,
    attempted: true,
    outcome: "succeeded",
    validationErrors: ["claim reference missing"],
    initialAttempt: { requestId: "redis-primary-request" },
    submission: { state: "SUBMITTED", requestId: "redis-repair-request" },
  };
  await storeA.saveRunRepairProvenance({
    runId: "redis-new",
    repairProvenance,
  });
  await storeA.saveRunRepairProvenance({
    runId: "redis-new",
    repairProvenance,
  });

  const storeB = createRedisAdminLabRecordStore({
    env: REDIS_ENV,
    fetchImpl: redis.fetchImpl,
  });
  const first = await storeB.listRuns({ limit: 1 });
  assert.equal(first.records[0].runId, "redis-new");
  assert.equal(first.records[0].humanRating.rating, "partially_correct");
  assert.equal(first.records[0].repairProvenance.submission.requestId, "redis-repair-request");
  assert.ok(first.nextCursor);
  const second = await storeB.listRuns({ cursor: first.nextCursor, limit: 1 });
  assert.equal(second.records[0].runId, "redis-old");
  assert.equal(second.nextCursor, null);
  assert.equal((await storeB.getRun("redis-old")).questionSummary, "旧问题");
  assert.equal((await storeB.getRun("redis-new")).repairProvenance.outcome, "succeeded");

  assert.equal(redis.commands.some((command) => command[0] === "LTRIM"), false);
  assert.equal(redis.commands.some((command) => command[0] === "EXPIRE"), false);
  assert.equal(JSON.stringify(redis.commands).includes("never-store-this"), false);
});

test("Redis registration recovers idempotently when the first response is lost after commit", async () => {
  const redis = createMockRedisRest();
  let loseFirstRegisterResponse = true;
  const fetchImpl = async (url, options) => {
    const command = JSON.parse(options.body);
    const response = await redis.fetchImpl(url, options);
    if (
      loseFirstRegisterResponse
      && command[0] === "EVAL"
      && command[1].includes("admin-lab-record-register-v1")
    ) {
      loseFirstRegisterResponse = false;
      throw new Error("simulated connection loss after Redis committed");
    }
    return response;
  };
  const store = createRedisAdminLabRecordStore({
    env: REDIS_ENV,
    fetchImpl,
  });
  const input = {
    runId: "redis-lost-response",
    createdAt: "2026-07-28T03:30:00.000Z",
    question: "响应丢失后不应创建重复记录",
    modelConfig: { provider: "openai", model: "gpt-5.6-terra" },
  };

  await assert.rejects(
    store.registerRun(input),
    (error) => error?.code === "admin_lab_record_redis_request_failed",
  );
  const recovered = await store.registerRun(structuredClone(input));
  assert.equal(recovered.runId, input.runId);
  const page = await store.listRuns();
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].runId, input.runId);

  await assert.rejects(
    store.registerRun({
      ...input,
      question: "同一个 runId 的冲突内容",
    }),
    (error) => error?.code === "admin_lab_record_conflict",
  );
});

test("Redis history multi-key commands keep register, rating, and MGET keys in one cluster slot", async () => {
  const redis = createMockRedisRest();
  const keyPrefix = "history-slot-test";
  const store = createRedisAdminLabRecordStore({
    env: REDIS_ENV,
    fetchImpl: redis.fetchImpl,
    keyPrefix,
  });
  await store.registerRun({
    runId: "slot-run",
    createdAt: "2026-07-28T04:00:00.000Z",
    question: "验证 Redis Cluster 槽位",
  });
  await store.saveHumanRating({
    runId: "slot-run",
    rating: "correct",
  });
  await store.listRuns();

  const multiKeyCommands = redis.commands.filter((command) => (
    command[0] === "MGET"
    || (
      command[0] === "EVAL"
      && (
        command[1].includes("admin-lab-record-register-v1")
        || command[1].includes("admin-lab-record-rating-v1")
      )
    )
  ));
  assert.equal(multiKeyCommands.length, 3);
  const allKeys = [];
  for (const command of multiKeyCommands) {
    const keys = command[0] === "EVAL"
      ? command.slice(3, 3 + Number(command[2]))
      : command.slice(1);
    assert.ok(keys.length >= 2);
    assert.equal(new Set(keys.map(redisClusterHashTag)).size, 1);
    allKeys.push(...keys);
  }
  assert.deepEqual([...new Set(allKeys.map(redisClusterHashTag))], [keyPrefix]);
});

test("Redis history upgrade keeps legacy records and ratings visible with ordered deduplication", async () => {
  const redis = createMockRedisRest();
  const keyPrefix = "history-upgrade-test";
  redis.seedLegacy(keyPrefix, {
    record: {
      schemaVersion: 1,
      runId: "legacy-only",
      createdAt: "2026-07-28T02:00:00.000Z",
      questionSummary: "旧键中的问题",
      modelConfig: {},
    },
    rating: {
      schemaVersion: 1,
      runId: "legacy-only",
      rating: "correct",
      note: "旧键评分",
      updatedAt: "2026-07-28T02:05:00.000Z",
    },
  });
  redis.seedLegacy(keyPrefix, {
    record: {
      schemaVersion: 1,
      runId: "duplicate-run",
      createdAt: "2026-07-28T01:00:00.000Z",
      questionSummary: "应被新键覆盖",
      modelConfig: {},
    },
  });
  const store = createRedisAdminLabRecordStore({
    env: REDIS_ENV,
    fetchImpl: redis.fetchImpl,
    keyPrefix,
  });
  await store.registerRun({
    runId: "new-only",
    createdAt: "2026-07-28T03:00:00.000Z",
    question: "新键问题",
  });
  await store.registerRun({
    runId: "duplicate-run",
    createdAt: "2026-07-28T04:00:00.000Z",
    question: "新键优先",
  });

  const first = await store.listRuns({ limit: 2 });
  const second = await store.listRuns({ cursor: first.nextCursor, limit: 2 });
  const records = [...first.records, ...second.records];
  assert.deepEqual(records.map((record) => record.runId), [
    "duplicate-run",
    "new-only",
    "legacy-only",
  ]);
  assert.equal(records[0].questionSummary, "新键优先");
  assert.equal(records[2].humanRating.rating, "correct");
  assert.equal((await store.getRun("legacy-only")).humanRating.note, "旧键评分");

  await store.saveHumanRating({
    runId: "legacy-only",
    rating: "needs_review",
    note: "升级后评分",
  });
  assert.equal((await store.getHumanRating("legacy-only")).rating, "needs_review");
  assert.equal((await store.listRuns({ limit: 10 })).records.length, 3);
});

test("JSON and CSV exports whitelist fields and neutralize spreadsheet formulas", async () => {
  const store = createMemoryAdminLabRecordStore();
  await store.registerRun({
    runId: "export-run",
    createdAt: "2026-07-28T04:00:00.000Z",
    question: "=HYPERLINK(\"https://example.invalid\")",
    modelConfig: {
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "secret-key",
    },
    evidenceSnapshotId: "evidence_export_1",
    evidenceSnapshotSha256: "a".repeat(64),
    decisionPacketId: "decision_packet_export_1",
    decisionPacketSha256: "b".repeat(64),
    forkProvenance: {
      schemaVersion: 1,
      sourceRunId: "source-run-1",
      rootSourceRunId: "root-run-1",
      sourceEvidenceSnapshotId: "evidence_export_1",
      sourceEvidenceSnapshotSha256: "a".repeat(64),
      sourceDecisionPacketId: "decision_packet_export_1",
      sourceDecisionPacketSha256: "b".repeat(64),
      requestFingerprint: "c".repeat(64),
      idempotencyKeySha256: "d".repeat(64),
      password: "must-not-survive",
    },
  });
  await store.saveHumanRating({
    runId: "export-run",
    rating: "incorrect",
    note: "+SUM(1,1)",
    updatedAt: "2026-07-28T04:05:00.000Z",
  });
  const records = (await store.listRuns()).records;
  const enrichedRecords = [{
    ...records[0],
    status: "SUCCEEDED",
    startedAt: "2026-07-28T04:00:01.000Z",
    endedAt: "2026-07-28T04:00:03.000Z",
    evidenceSnapshotId: "evidence_export_1",
    repairProvenance: {
      schemaVersion: 1,
      attempted: true,
      outcome: "succeeded",
      validationErrors: ["missing evidenceId"],
      initialAttempt: { requestId: "primary-request", usage: { totalTokens: 111 } },
      submission: { requestId: "repair-request", state: "SUBMITTED" },
    },
    result: {
      schemaVersion: 1,
      evidenceSnapshotId: "evidence_export_1",
      finalRuling: { conciseAnswer: "可以发动。" },
      provider: {
        providerId: "openai",
        model: "gpt-5.6-luna",
        apiKey: "nested-secret",
      },
      metering: {
        totals: {
          usage: { totalTokens: 321 },
          cost: { totalCostUsd: 0.0123 },
        },
      },
      repair: {
        attempted: true,
        outcome: "succeeded",
        attempts: [
          { requestId: "primary-request" },
          { requestId: "repair-request" },
        ],
      },
      callerAddedSecret: "must-not-survive",
    },
    metering: {
      totals: {
        usage: { totalTokens: 321 },
        cost: { totalCostUsd: 0.0123 },
      },
      authorization: "Bearer must-not-survive",
    },
  }];
  const json = exportAdminLabRecordsJson(enrichedRecords, {
    exportedAt: "2026-07-28T05:00:00.000Z",
  });
  const csv = exportAdminLabRecordsCsv(enrichedRecords);
  const parsed = JSON.parse(json);

  assert.equal(json.includes("secret-key"), false);
  assert.equal(json.includes("nested-secret"), false);
  assert.equal(json.includes("must-not-survive"), false);
  assert.equal(parsed.schemaVersion, 4);
  assert.equal(parsed.records[0].humanRating.rating, "incorrect");
  assert.equal(parsed.records[0].status, "SUCCEEDED");
  assert.equal(parsed.records[0].evidenceSnapshotId, "evidence_export_1");
  assert.equal(parsed.records[0].evidenceSnapshotSha256, "a".repeat(64));
  assert.equal(parsed.records[0].decisionPacketId, "decision_packet_export_1");
  assert.equal(parsed.records[0].decisionPacketSha256, "b".repeat(64));
  assert.equal(parsed.records[0].forkProvenance.sourceRunId, "source-run-1");
  assert.equal(parsed.records[0].forkProvenance.sourceDecisionPacketSha256, "b".repeat(64));
  assert.equal(Object.hasOwn(parsed.records[0].forkProvenance, "password"), false);
  assert.equal(parsed.records[0].result.finalRuling.conciseAnswer, "可以发动。");
  assert.equal(parsed.records[0].metering.totals.usage.totalTokens, 321);
  assert.equal(parsed.records[0].repairProvenance.outcome, "succeeded");
  assert.equal(parsed.records[0].result.repair.attempts.length, 2);
  assert.match(csv, /evidence_export_1/u);
  assert.match(csv, /source-run-1/u);
  assert.match(csv, new RegExp("a{64}", "u"));
  assert.match(csv, new RegExp("b{64}", "u"));
  assert.match(csv, /totalTokens/u);
  assert.match(csv, /primary-request/u);
  assert.match(csv, /repair-request/u);
  assert.match(csv, /"'=HYPERLINK/u);
  assert.match(csv, /"'\+SUM\(1,1\)"/u);
});

function createMockRedisRest() {
  const strings = new Map();
  const sortedSets = new Map();
  const commands = [];

  const fetchImpl = async (_url, options = {}) => {
    const command = JSON.parse(options.body);
    commands.push(structuredClone(command));
    let result;

    if (command[0] === "EVAL") {
      const script = command[1];
      if (script.includes("admin-lab-record-register-v1")) {
        const recordKey = command[3];
        const indexKey = command[4];
        const record = JSON.parse(command[5]);
        if (strings.has(recordKey)) {
          if (strings.get(recordKey) !== command[5]) {
            result = "CONFLICT";
          } else {
            const index = sortedSets.get(indexKey) || new Map();
            index.set(command[7], Number(command[6]));
            sortedSets.set(indexKey, index);
            result = "UNCHANGED";
          }
        } else if (record.runId !== command[7]) {
          result = "INVALID";
        } else {
          strings.set(recordKey, command[5]);
          const index = sortedSets.get(indexKey) || new Map();
          index.set(command[7], Number(command[6]));
          sortedSets.set(indexKey, index);
          result = "REGISTERED";
        }
      } else if (script.includes("admin-lab-record-rating-v1")) {
        const recordKey = command[3];
        const ratingKey = command[4];
        const rating = JSON.parse(command[5]);
        if (!strings.has(recordKey)) {
          result = "NOT_FOUND";
        } else if (rating.runId !== command[6]) {
          result = "INVALID";
        } else {
          strings.set(ratingKey, command[5]);
          result = "SAVED";
        }
      } else if (script.includes("admin-lab-record-save-repair-audit-v1")) {
        const recordKey = command[3];
        const repairKey = command[4];
        if (!strings.has(recordKey)) {
          result = "NOT_FOUND";
        } else if (strings.has(repairKey) && strings.get(repairKey) !== command[5]) {
          result = "CONFLICT";
        } else if (strings.has(repairKey)) {
          result = "UNCHANGED";
        } else {
          strings.set(repairKey, command[5]);
          result = "SAVED";
        }
      } else {
        throw new Error("unexpected Lua script");
      }
    } else if (command[0] === "GET") {
      result = strings.get(command[1]) ?? null;
    } else if (command[0] === "MGET") {
      result = command.slice(1).map((key) => strings.get(key) ?? null);
    } else if (command[0] === "ZREVRANGE") {
      const index = sortedSets.get(command[1]) || new Map();
      const ordered = [...index.entries()]
        .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
        .map(([member]) => member);
      const stop = Number(command[3]);
      result = ordered.slice(Number(command[2]), stop < 0 ? undefined : stop + 1);
    } else {
      throw new Error(`unexpected Redis command: ${command[0]}`);
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ result }),
    };
  };

  return {
    commands,
    fetchImpl,
    seedLegacy(prefix, { record, rating = null }) {
      const encodedRunId = encodeURIComponent(record.runId);
      strings.set(`${prefix}:run:${encodedRunId}`, JSON.stringify(record));
      if (rating) {
        strings.set(`${prefix}:rating:${encodedRunId}`, JSON.stringify(rating));
      }
      const index = sortedSets.get(`${prefix}:created`) || new Map();
      index.set(record.runId, Date.parse(record.createdAt));
      sortedSets.set(`${prefix}:created`, index);
    },
  };
}

function redisClusterHashTag(key) {
  const match = /\{([^{}]+)\}/u.exec(String(key || ""));
  return match?.[1] || String(key || "");
}
