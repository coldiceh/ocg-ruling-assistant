import assert from "node:assert/strict";
import test from "node:test";
import {
  auditConfiguredUpstashStorage,
  auditRedisTarget,
  configuredAuditTargets,
  READ_ONLY_REDIS_COMMANDS,
} from "../scripts/audit-upstash-storage.mjs";

const AUDIT_ENV = Object.freeze({
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "never-print-this-token",
});

test("Upstash audit uses metadata-only commands and redacts keys, endpoint, and credentials", async () => {
  const keys = [
    "admin-runs:v1:{run-one}:state",
    "admin-runs:v1:{run-one}:events",
    "admin-runs:v1:{run-one}:snapshot:evidence_1",
    "rag-query-audit:v1",
  ];
  const mock = createAuditRedisMock({
    keys,
    types: new Map([
      [keys[0], "string"],
      [keys[1], "list"],
      [keys[2], "string"],
      [keys[3], "list"],
    ]),
    pttls: new Map(keys.map((key) => [key, 86_400_000])),
    memory: new Map([
      [keys[0], 1_024],
      [keys[1], 2_048],
      [keys[2], 5_000_000],
      [keys[3], 16_384],
    ]),
  });

  const report = await auditConfiguredUpstashStorage({
    env: AUDIT_ENV,
    fetchImpl: mock.fetchImpl,
    now: "2026-08-06T00:00:00.000Z",
  });
  assert.equal(report.auditMode, "read_only_metadata");
  assert.equal(report.valuesRead, false);
  assert.equal(report.totals.keyCount, 4);
  assert.equal(report.totals.knownBytes, 5_019_456);
  const namespaces = report.targets[0].namespaces;
  assert.equal(
    namespaces.find((item) => item.namespace === "admin_runs.snapshot")?.knownBytes,
    5_000_000,
  );
  assert.equal(
    mock.commands.every((command) => READ_ONLY_REDIS_COMMANDS.includes(command[0])),
    true,
  );
  assert.equal(mock.commands.some((command) => ["GET", "MGET", "LRANGE", "DEL", "SET"].includes(command[0])), false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(AUDIT_ENV.UPSTASH_REDIS_REST_TOKEN), false);
  assert.equal(serialized.includes(AUDIT_ENV.UPSTASH_REDIS_REST_URL), false);
  assert.equal(keys.some((key) => serialized.includes(key)), false);
});

test("Upstash audit falls back to STRLEN only for strings when MEMORY USAGE is unavailable", async () => {
  const keys = [
    "admin-runs:v1:{run-two}:snapshot:evidence_2",
    "admin-runs:v1:{run-two}:events",
  ];
  const mock = createAuditRedisMock({
    keys,
    types: new Map([[keys[0], "string"], [keys[1], "list"]]),
    pttls: new Map([[keys[0], -1], [keys[1], -1]]),
    stringLengths: new Map([[keys[0], 900_000]]),
    memoryUnavailable: true,
  });
  const [target] = configuredAuditTargets(AUDIT_ENV);
  const report = await auditRedisTarget({
    ...target,
    fetchImpl: mock.fetchImpl,
    maxKeys: 100,
  });

  assert.equal(report.memoryUsageSupported, false);
  assert.equal(report.totals.keyCount, 2);
  assert.equal(report.totals.knownBytes, 900_000);
  assert.equal(report.totals.unmeasuredKeyCount, 1);
  assert.equal(mock.commands.filter((command) => command[0] === "STRLEN").length, 1);
  assert.equal(mock.commands.some((command) => command[0] === "GET"), false);
});

test("Upstash audit aborts at its key safety limit without issuing writes", async () => {
  const keys = [
    "admin-runs:v1:{one}:state",
    "admin-runs:v1:{two}:state",
  ];
  const mock = createAuditRedisMock({ keys });
  const [target] = configuredAuditTargets(AUDIT_ENV);
  await assert.rejects(
    auditRedisTarget({ ...target, fetchImpl: mock.fetchImpl, maxKeys: 1 }),
    (error) => error?.code === "upstash_audit_key_limit_exceeded",
  );
  assert.equal(mock.commands.every((command) => command[0] === "SCAN"), true);
});

test("Upstash audit enforces its key limit before requesting another SCAN page", async () => {
  const mock = createAuditRedisMock({
    scanPages: [
      ["next-page", [
        "admin-runs:v1:{one}:state",
        "admin-runs:v1:{two}:state",
      ]],
      ["0", ["admin-runs:v1:{three}:state"]],
    ],
  });
  const [target] = configuredAuditTargets(AUDIT_ENV);
  await assert.rejects(
    auditRedisTarget({ ...target, fetchImpl: mock.fetchImpl, maxKeys: 1 }),
    (error) => error?.code === "upstash_audit_key_limit_exceeded",
  );
  assert.equal(mock.commands.length, 1);
  assert.equal(mock.commands[0][0], "SCAN");
});

function createAuditRedisMock({
  keys = [],
  types = new Map(),
  pttls = new Map(),
  memory = new Map(),
  stringLengths = new Map(),
  memoryUnavailable = false,
  scanPages = null,
} = {}) {
  const commands = [];
  const fetchImpl = async (_url, options = {}) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    let result;
    let error = null;
    if (command[0] === "SCAN") {
      if (Array.isArray(scanPages)) {
        result = scanPages[Math.min(
          commands.filter((item) => item[0] === "SCAN").length - 1,
          scanPages.length - 1,
        )];
      } else {
        const pattern = command[3];
        result = ["0", keys.filter((key) => redisGlobMatches(pattern, key))];
      }
    } else if (command[0] === "TYPE") {
      result = types.get(command[1]) || "string";
    } else if (command[0] === "PTTL") {
      result = pttls.get(command[1]) ?? -1;
    } else if (command[0] === "MEMORY") {
      if (memoryUnavailable) error = "unknown command";
      else result = memory.get(command[2]) ?? 64;
    } else if (command[0] === "STRLEN") {
      result = stringLengths.get(command[1]) ?? 0;
    } else {
      throw new Error(`unexpected command ${command[0]}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => error ? { error } : { result },
    };
  };
  return { commands, fetchImpl };
}

function redisGlobMatches(pattern, value) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) {
      source += escapeRegex(pattern[index + 1]);
      index += 1;
    } else if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`^${source}$`, "u").test(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
