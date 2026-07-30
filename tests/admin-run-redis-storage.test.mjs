import assert from "node:assert/strict";
import test from "node:test";
import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import { createAdminRunStore } from "../backend/adminRunStore.mjs";
import {
  createConfiguredAdminRunStorage,
  createRedisAdminRunStorage,
} from "../backend/adminRunRedisStorage.mjs";

const REDIS_ENV = Object.freeze({
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "anonymous-token",
});

test("configured storage requires persistence and memory needs mode plus code opt-in", () => {
  assert.throws(
    () => createConfiguredAdminRunStorage({ env: {}, fetchImpl: async () => null }),
    (error) => error?.code === "admin_run_storage_unavailable",
  );

  assert.throws(
    () => createConfiguredAdminRunStorage({ env: { ADMIN_RUN_STORAGE: "memory" } }),
    (error) => error?.code === "admin_run_memory_forbidden",
  );
  assert.throws(
    () => createConfiguredAdminRunStorage({ env: {}, allowMemoryStore: true }),
    (error) => error?.code === "admin_run_storage_unavailable",
  );
  const memory = createConfiguredAdminRunStorage({
    env: { ADMIN_RUN_STORAGE: "memory" },
    allowMemoryStore: true,
  });
  assert.equal(memory.kind, "memory");
  assert.equal(memory.persistent, false);

  const redis = createConfiguredAdminRunStorage({
    env: REDIS_ENV,
    fetchImpl: createMockRedisRest().fetchImpl,
  });
  assert.equal(redis.kind, "redis-rest");
  assert.equal(redis.persistent, true);
  assert.equal(redis.ttlSeconds, null);
});

test("Redis adapter persists state and ordered replay across store instances", async () => {
  const mock = createMockRedisRest();
  const storageA = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const storeA = createAdminRunStore({
    storage: storageA,
    runIdFactory: () => "persistent-run",
    now: increasingClock("2026-07-28T00:00:00.000Z"),
  });
  const snapshot = createAdminEvidenceSnapshot({
    question: "anonymous question",
    evidence: { items: [{ id: "anonymous-evidence" }] },
  });

  const created = await storeA.createRun({ evidenceSnapshot: snapshot });
  await storeA.startRun(created.runId);

  const storageB = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const storeB = createAdminRunStore({
    storage: storageB,
    now: increasingClock("2026-07-28T00:01:00.000Z"),
  });
  await Promise.all([
    storeA.appendEvent(created.runId, { payload: { worker: "a1" } }),
    storeB.appendEvent(created.runId, { payload: { worker: "b1" } }),
    storeA.appendEvent(created.runId, { payload: { worker: "a2" } }),
    storeB.appendEvent(created.runId, { payload: { worker: "b2" } }),
  ]);

  const persisted = await storeB.getRun(created.runId);
  assert.equal(persisted.lastSequence, 6);
  assert.equal(persisted.revision, 6);
  const replay = await storeB.replayEvents(created.runId, { afterSequence: 2 });
  assert.deepEqual(replay.events.map((event) => event.sequence), [3, 4, 5, 6]);
  assert.equal(replay.nextAfterSequence, 6);
  assert.equal(replay.hasMore, false);
  assert.ok(mock.commands.filter((command) => command[0] === "EVAL").length >= 6);
  assert.equal(
    [...mock.strings.keys()].filter((key) => String(key).includes(":snapshot:")).length,
    1,
  );
  assert.equal(
    mock.commands
      .filter((command) => (
        command[0] === "EVAL"
        && (
          command[1].includes("admin-run-create-v1")
          || command[1].includes("admin-run-commit-v1")
        )
      ))
      .some((command) => JSON.stringify(command).includes("anonymous-evidence")),
    false,
  );
  assert.equal(
    mock.commands.filter((command) => (
      command[0] === "GET" && String(command[1]).includes(":snapshot:")
    )).length,
    1,
  );
});

test("Redis snapshot reads reject tampered content that retains the stored snapshot id", async () => {
  const mock = createMockRedisRest();
  const storageA = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const storeA = createAdminRunStore({
    storage: storageA,
    runIdFactory: () => "tampered-snapshot-run",
    now: increasingClock("2026-07-28T01:00:00.000Z"),
  });
  await storeA.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({
      question: "original",
      evidence: { item: "trusted" },
    }),
  });
  const snapshotKey = [...mock.strings.keys()]
    .find((key) => String(key).includes(":snapshot:"));
  const tampered = JSON.parse(mock.strings.get(snapshotKey));
  tampered.evidence.item = "tampered";
  mock.strings.set(snapshotKey, JSON.stringify(tampered));

  const storageB = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  await assert.rejects(
    storageB.getRun("tampered-snapshot-run"),
    (error) => error?.code === "admin_run_storage_corrupt"
      && /integrity/u.test(error.message),
  );
});

test("Redis snapshot identity rejects two canonical objects with the same content id", async () => {
  const mock = createMockRedisRest();
  const storageA = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const storeA = createAdminRunStore({
    storage: storageA,
    runIdFactory: () => "snapshot-identity-run",
    now: increasingClock("2026-07-28T01:30:00.000Z"),
  });
  const firstSnapshot = createAdminEvidenceSnapshot({
    question: "same content",
    evidence: { value: 1 },
    createdAt: "2026-07-28T01:30:00.000Z",
  });
  const secondSnapshot = createAdminEvidenceSnapshot({
    question: "same content",
    evidence: { value: 1 },
    createdAt: "2026-07-28T01:31:00.000Z",
  });
  assert.equal(secondSnapshot.snapshotId, firstSnapshot.snapshotId);
  const created = await storeA.createRun({ evidenceSnapshot: firstSnapshot });
  const current = await storageA.getRun(created.runId);
  await assert.rejects(
    storageA.commitRun({
      runId: created.runId,
      expectedRevision: 1,
      run: {
        ...current,
        evidenceSnapshot: secondSnapshot,
        revision: 2,
        lastSequence: 2,
      },
      event: {
        runId: created.runId,
        sequence: 2,
        type: "RUN_EVENT",
        timestamp: "2026-07-28T01:31:00.000Z",
        status: current.status,
        payload: {},
      },
    }),
    (error) => error?.code === "admin_run_storage_corrupt"
      && /canonical snapshot identity/u.test(error.message),
  );
});

test("Redis create recovers when the transaction commits but its response is lost", async () => {
  const mock = createMockRedisRest();
  let loseCreateResponse = true;
  const fetchImpl = async (url, options) => {
    const command = JSON.parse(options.body);
    const response = await mock.fetchImpl(url, options);
    if (
      loseCreateResponse
      && command[0] === "EVAL"
      && command[1].includes("admin-run-create-v1")
    ) {
      loseCreateResponse = false;
      throw new Error("simulated connection loss after create commit");
    }
    return response;
  };
  const storage = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl });
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "lost-create-response-run",
    now: increasingClock("2026-07-28T01:45:00.000Z"),
  });
  const created = await store.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({ question: "recover create" }),
  });

  assert.equal(created.runId, "lost-create-response-run");
  await storage.createRun({
    run: created,
    event: {
      runId: created.runId,
      sequence: 1,
      type: "RUN_CREATED",
      timestamp: created.createdAt,
      status: created.status,
      payload: {
        evidenceSnapshotId: created.evidenceSnapshot.snapshotId,
      },
    },
  });
  assert.equal((mock.lists.get([...mock.lists.keys()][0]) || []).length, 1);
  assert.equal(
    mock.commands.some((command) => (
      command[0] === "EVAL"
      && command[1].includes("admin-run-create-verify-v1")
    )),
    true,
  );
});

test("Redis commit performs revision CAS and atomically appends one event", async () => {
  const mock = createMockRedisRest();
  const storage = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "cas-run",
    now: increasingClock("2026-07-28T02:00:00.000Z"),
  });
  const created = await store.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({ evidence: { anonymous: true } }),
  });
  const current = await storage.getRun(created.runId);
  const next = {
    ...current,
    revision: 2,
    lastSequence: 2,
    updatedAt: "2026-07-28T02:00:01.000Z",
  };
  const event = {
    runId: created.runId,
    sequence: 2,
    type: "RUN_EVENT",
    timestamp: "2026-07-28T02:00:01.000Z",
    status: current.status,
    payload: {},
  };

  await storage.commitRun({
    runId: created.runId,
    expectedRevision: 1,
    run: next,
    event,
  });
  await assert.rejects(
    storage.commitRun({
      runId: created.runId,
      expectedRevision: 1,
      run: next,
      event,
    }),
    (error) => error?.code === "admin_run_revision_conflict",
  );
  assert.deepEqual(
    (await storage.readEvents({ runId: created.runId })).map((item) => item.sequence),
    [1, 2],
  );
});

test("a snapshot staged by a losing CAS remains temporary instead of becoming an orphan", async () => {
  const mock = createMockRedisRest();
  const storage = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const store = createAdminRunStore({
    storage,
    runIdFactory: () => "snapshot-cas-loser",
    now: increasingClock("2026-07-28T02:30:00.000Z"),
  });
  const created = await store.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({ evidence: { version: 1 } }),
  });
  const stale = await storage.getRun(created.runId);
  await store.appendEvent(created.runId, { payload: { winner: true } });
  const losingSnapshot = createAdminEvidenceSnapshot({ evidence: { version: 2 } });

  await assert.rejects(
    storage.commitRun({
      runId: created.runId,
      expectedRevision: 1,
      run: {
        ...stale,
        evidenceSnapshot: losingSnapshot,
        revision: 2,
        lastSequence: 2,
      },
      event: {
        runId: created.runId,
        sequence: 2,
        type: "RUN_EVENT",
        timestamp: "2026-07-28T02:30:01.000Z",
        status: stale.status,
        payload: { loser: true },
      },
    }),
    (error) => error?.code === "admin_run_revision_conflict",
  );
  const losingKey = [...mock.strings.keys()]
    .find((key) => String(key).endsWith(encodeURIComponent(losingSnapshot.snapshotId)));
  assert.equal(mock.expiries.get(losingKey), 300);
});

test("persistent leases use Redis TIME across instances instead of application host clocks", async () => {
  const mock = createMockRedisRest();
  mock.setServerTime("2026-07-28T03:00:00.000Z");
  const storageA = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const storageB = createRedisAdminRunStorage({ env: REDIS_ENV, fetchImpl: mock.fetchImpl });
  const storeA = createAdminRunStore({
    storage: storageA,
    runIdFactory: () => "server-clock-lease-run",
    executionTokenFactory: () => "server-clock-token-a",
  });
  const storeB = createAdminRunStore({
    storage: storageB,
    executionTokenFactory: () => "server-clock-token-b",
  });
  const created = await storeA.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({ question: "server time" }),
  });
  const firstLease = await storeA.acquireExecutionLease(created.runId, {
    ownerId: "worker-a",
    leaseMs: 1_000,
  });
  assert.equal(firstLease.executionEpoch, 1);

  mock.advanceServerTime(500);
  await assert.rejects(
    storeB.acquireExecutionLease(created.runId, {
      ownerId: "worker-b",
      leaseMs: 1_000,
    }),
    (error) => error?.code === "admin_run_execution_lease_active",
  );
  mock.advanceServerTime(501);
  const secondLease = await storeB.acquireExecutionLease(created.runId, {
    ownerId: "worker-b",
    leaseMs: 1_000,
  });
  assert.equal(secondLease.executionEpoch, 2);
  assert.ok(mock.commands.filter((command) => command[0] === "TIME").length >= 4);
});

test("TTL is opt-in, applies to all persisted run keys, and zero is never a disabled sentinel", async () => {
  const noTtlMock = createMockRedisRest();
  const noTtlStorage = createRedisAdminRunStorage({
    env: REDIS_ENV,
    fetchImpl: noTtlMock.fetchImpl,
  });
  const noTtlStore = createAdminRunStore({
    storage: noTtlStorage,
    runIdFactory: () => "no-ttl-run",
  });
  await noTtlStore.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({ evidence: { anonymous: true } }),
  });
  assert.equal(noTtlStorage.ttlSeconds, null);
  assert.equal(noTtlMock.expiries.size, 0);
  assert.equal(
    noTtlMock.commands.find((command) => (
      command[0] === "EVAL"
      && command[1].includes("admin-run-create-v1")
    )).at(-1),
    "",
  );

  const ttlMock = createMockRedisRest();
  const ttlStorage = createRedisAdminRunStorage({
    env: { ...REDIS_ENV, ADMIN_RUN_TTL_SECONDS: "3600" },
    fetchImpl: ttlMock.fetchImpl,
  });
  const ttlStore = createAdminRunStore({
    storage: ttlStorage,
    runIdFactory: () => "ttl-run",
  });
  await ttlStore.createRun({
    evidenceSnapshot: createAdminEvidenceSnapshot({ evidence: { anonymous: true } }),
  });
  assert.equal(ttlStorage.ttlSeconds, 3600);
  assert.equal(ttlMock.expiries.size, 3);
  assert.deepEqual([...ttlMock.expiries.values()], [3600, 3600, 3600]);

  assert.throws(
    () => createRedisAdminRunStorage({
      env: { ...REDIS_ENV, ADMIN_RUN_TTL_SECONDS: "0" },
      fetchImpl: ttlMock.fetchImpl,
    }),
    /positive integer/u,
  );
});

function increasingClock(iso) {
  let value = Date.parse(iso);
  return () => new Date(value++);
}

function createMockRedisRest() {
  const strings = new Map();
  const lists = new Map();
  const expiries = new Map();
  const commands = [];
  let serverTimeMs = Date.parse("2026-07-28T00:00:00.000Z");

  const fetchImpl = async (_url, options = {}) => {
    const command = JSON.parse(options.body);
    commands.push(structuredClone(command));
    let result;

    if (command[0] === "EVAL") {
      const script = command[1];
      if (script.includes("admin-run-snapshot-prepare-v1")) {
        const snapshotKey = command[3];
        const snapshotRaw = command[4];
        if (strings.has(snapshotKey)) {
          result = strings.get(snapshotKey) === snapshotRaw
            ? "UNCHANGED"
            : "CONFLICT";
        } else {
          strings.set(snapshotKey, snapshotRaw);
          expiries.set(snapshotKey, Number(command[5]));
          result = "STAGED";
        }
      } else {
        const runKey = command[3];
        const eventKey = command[4];
        const snapshotKey = command[5];
        if (script.includes("admin-run-create-verify-v1")) {
          const currentRaw = strings.get(runKey);
          const firstEventRaw = (lists.get(eventKey) || [])[0];
          const snapshotRaw = strings.get(snapshotKey);
          if (!currentRaw || !firstEventRaw || !snapshotRaw) {
            result = "NOT_FOUND";
          } else if (firstEventRaw !== command[7] || snapshotRaw !== command[8]) {
            result = "MISMATCH";
          } else if (currentRaw === command[6]) {
            result = "MATCH";
          } else {
            const current = JSON.parse(currentRaw);
            const expected = JSON.parse(command[6]);
            result = current.runId === expected.runId
              && current.revision >= expected.revision
              && current.lastSequence >= expected.lastSequence
              ? "MATCH"
              : "MISMATCH";
          }
        } else if (script.includes("admin-run-create-v1")) {
          const currentRaw = strings.get(runKey);
          const currentEvents = lists.get(eventKey) || [];
          if (currentRaw || currentEvents.length > 0) {
            if (
              currentRaw === command[6]
              && currentEvents.length === 1
              && currentEvents[0] === command[7]
            ) {
              if (!strings.has(snapshotKey)) {
                result = "MISSING_SNAPSHOT";
              } else {
                applyMockTtl([runKey, eventKey, snapshotKey], command[8], expiries);
                result = "ALREADY_CREATED";
              }
            } else {
              result = "EXISTS";
            }
          } else if (!strings.has(snapshotKey)) {
            result = "MISSING_SNAPSHOT";
          } else {
          const run = JSON.parse(command[6]);
          const event = JSON.parse(command[7]);
          if (
            run.runId !== event.runId
            || run.revision !== 1
            || run.lastSequence !== 1
            || event.sequence !== 1
          ) {
            result = "INVALID";
          } else {
            strings.set(runKey, command[6]);
            lists.set(eventKey, [command[7]]);
            applyMockTtl([runKey, eventKey, snapshotKey], command[8], expiries);
            result = "CREATED";
          }
        }
        } else if (script.includes("admin-run-commit-v1")) {
          const currentRaw = strings.get(runKey);
          if (!currentRaw) {
            result = "NOT_FOUND";
          } else if (!strings.has(snapshotKey)) {
            result = "MISSING_SNAPSHOT";
          } else {
            const current = JSON.parse(currentRaw);
            const expectedRevision = Number(command[6]);
            const next = JSON.parse(command[7]);
            const event = JSON.parse(command[8]);
            if (current.revision !== expectedRevision) {
              result = `CONFLICT:${current.revision}`;
            } else if (
              current.runId !== next.runId
              || current.runId !== event.runId
              || next.revision !== expectedRevision + 1
              || next.lastSequence !== current.lastSequence + 1
              || event.sequence !== current.lastSequence + 1
            ) {
              result = "INVALID";
            } else {
              strings.set(runKey, command[7]);
              lists.get(eventKey).push(command[8]);
              applyMockTtl([runKey, eventKey, snapshotKey], command[9], expiries);
              result = "COMMITTED";
            }
          }
        } else {
          throw new Error("unexpected Lua script");
        }
      }
    } else if (command[0] === "GET") {
      result = strings.get(command[1]) ?? null;
    } else if (command[0] === "EXISTS") {
      result = strings.has(command[1]) ? 1 : 0;
    } else if (command[0] === "SET") {
      const key = command[1];
      const value = command[2];
      const onlyIfMissing = command.includes("NX");
      if (onlyIfMissing && strings.has(key)) {
        result = null;
      } else {
        strings.set(key, value);
        const expiryIndex = command.indexOf("EX");
        if (expiryIndex >= 0) expiries.set(key, Number(command[expiryIndex + 1]));
        result = "OK";
      }
    } else if (command[0] === "LRANGE") {
      const source = lists.get(command[1]) || [];
      const start = Number(command[2]);
      const requestedStop = Number(command[3]);
      const stop = requestedStop < 0 ? source.length - 1 : requestedStop;
      result = start > stop ? [] : source.slice(start, stop + 1);
    } else if (command[0] === "TIME") {
      const seconds = Math.floor(serverTimeMs / 1_000);
      const microseconds = (serverTimeMs - (seconds * 1_000)) * 1_000;
      result = [String(seconds), String(microseconds)];
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
    expiries,
    fetchImpl,
    lists,
    strings,
    setServerTime(value) {
      serverTimeMs = Date.parse(value);
    },
    advanceServerTime(milliseconds) {
      serverTimeMs += Number(milliseconds);
    },
  };
}

function applyMockTtl(keys, value, expiries) {
  if (String(value || "") === "") {
    for (const key of keys) expiries.delete(key);
    return;
  }
  const ttl = Number(value);
  for (const key of keys) expiries.set(key, ttl);
}
