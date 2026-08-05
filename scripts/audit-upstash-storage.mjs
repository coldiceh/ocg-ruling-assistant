import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_SCAN_COUNT = 200;
const DEFAULT_MAX_KEYS = 20_000;
const MAX_SCAN_ITERATIONS = 100_000;
const TOP_KEY_COUNT = 20;

export const READ_ONLY_REDIS_COMMANDS = Object.freeze([
  "SCAN",
  "TYPE",
  "PTTL",
  "MEMORY",
  "STRLEN",
]);
const READ_ONLY_REDIS_COMMAND_SET = new Set(READ_ONLY_REDIS_COMMANDS);

/**
 * Audits every Redis endpoint selected by the application's current storage
 * configuration. It never reads values and the command gate below makes write
 * commands impossible even if a future caller supplies an unexpected command.
 */
export async function auditConfiguredUpstashStorage({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = new Date(),
  maxKeys = DEFAULT_MAX_KEYS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const targets = configuredAuditTargets(env);
  if (targets.length === 0) {
    const error = new Error("No configured Redis REST endpoint was found.");
    error.code = "upstash_audit_storage_unconfigured";
    throw error;
  }
  const reports = [];
  for (let index = 0; index < targets.length; index += 1) {
    reports.push(await auditRedisTarget({
      ...targets[index],
      fetchImpl,
      maxKeys,
      targetId: `target_${index + 1}`,
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    auditMode: "read_only_metadata",
    commandsAllowed: READ_ONLY_REDIS_COMMANDS,
    valuesRead: false,
    secretsIncluded: false,
    auditedAt: validDate(now).toISOString(),
    targetCount: reports.length,
    targets: reports,
    totals: sumReports(reports),
  });
}

export async function auditRedisTarget({
  connection,
  descriptors,
  fetchImpl = globalThis.fetch,
  maxKeys = DEFAULT_MAX_KEYS,
  targetId = "target_1",
} = {}) {
  assertConnection(connection);
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new TypeError("at least one audit descriptor is required");
  }
  const keyLimit = positiveInteger(maxKeys, "maxKeys");
  const discovered = new Map();
  for (const descriptor of descriptors) {
    const normalized = normalizeDescriptor(descriptor);
    await scanKeys(connection, normalized.pattern, fetchImpl, (key) => {
      if (!discovered.has(key)) discovered.set(key, normalized);
      if (discovered.size > keyLimit) {
        const error = new Error(`Redis audit exceeded the ${keyLimit} key safety limit.`);
        error.code = "upstash_audit_key_limit_exceeded";
        throw error;
      }
    });
  }

  let memoryUsageSupported = true;
  const entries = [];
  for (const [key, descriptor] of discovered) {
    const type = String(await redisReadCommand(
      connection,
      fetchImpl,
      ["TYPE", key],
    ) || "none").toLowerCase();
    if (type === "none") continue;
    const pttlMs = normalizePttl(await redisReadCommand(
      connection,
      fetchImpl,
      ["PTTL", key],
    ));
    let bytes = null;
    let measurement = "unavailable";
    if (memoryUsageSupported) {
      try {
        const measured = await redisReadCommand(
          connection,
          fetchImpl,
          ["MEMORY", "USAGE", key, "SAMPLES", "5"],
        );
        bytes = nonNegativeIntegerOrNull(measured);
        measurement = bytes === null ? "unavailable" : "memory_usage";
      } catch {
        memoryUsageSupported = false;
      }
    }
    if (bytes === null && type === "string") {
      bytes = nonNegativeIntegerOrNull(await redisReadCommand(
        connection,
        fetchImpl,
        ["STRLEN", key],
      ));
      measurement = bytes === null ? "unavailable" : "string_length";
    }
    entries.push({
      namespace: classifyKey(descriptor, key),
      keyFingerprint: fingerprint(key),
      type,
      pttlMs,
      bytes,
      measurement,
    });
  }
  entries.sort((left, right) => (
    numberOrNegativeOne(right.bytes) - numberOrNegativeOne(left.bytes)
    || left.keyFingerprint.localeCompare(right.keyFingerprint, "en")
  ));
  const namespaces = summarizeNamespaces(entries);
  return Object.freeze({
    targetId: String(targetId),
    endpointDisclosed: false,
    credentialDisclosed: false,
    namespaceCount: namespaces.length,
    namespaces,
    totals: summarizeEntries(entries),
    largestKeys: entries.slice(0, TOP_KEY_COUNT),
    memoryUsageSupported,
  });
}

export function configuredAuditTargets(env = {}) {
  const generic = redisConnection(env, [], []);
  const adminRun = redisConnection(
    env,
    ["ADMIN_RUN_REDIS_REST_URL"],
    ["ADMIN_RUN_REDIS_REST_TOKEN"],
  );
  const adminLab = redisConnection(
    env,
    ["ADMIN_LAB_RECORD_REDIS_REST_URL"],
    ["ADMIN_LAB_RECORD_REDIS_REST_TOKEN"],
  );
  const latency = redisConnection(
    env,
    ["PUBLIC_ANSWER_LATENCY_REDIS_REST_URL"],
    ["PUBLIC_ANSWER_LATENCY_REDIS_REST_TOKEN"],
  );
  const grouped = new Map();
  addTarget(grouped, generic, [
    exactDescriptor("query_audit", env.QUERY_AUDIT_REDIS_KEY || "rag-query-audit:v1"),
    prefixDescriptor("admin_session", env.ADMIN_SESSION_REDIS_PREFIX || "ocg-admin:v1"),
    prefixDescriptor("public_budget", "rag-api-budget"),
  ]);
  addTarget(grouped, adminRun, [
    prefixDescriptor("admin_runs", env.ADMIN_RUN_REDIS_KEY_PREFIX || "admin-runs:v1", {
      classify: classifyAdminRunKey,
    }),
    prefixDescriptor(
      "admin_final_budget",
      env.ADMIN_FINAL_BUDGET_REDIS_KEY_PREFIX || "admin-final-budget:v1",
    ),
  ]);
  const labPrefix = String(
    env.ADMIN_LAB_RECORD_REDIS_KEY_PREFIX || "admin-lab-records:v1",
  ).trim() || "admin-lab-records:v1";
  addTarget(grouped, adminLab, [
    prefixDescriptor("admin_lab_history", `{${labPrefix}}`),
    prefixDescriptor("admin_lab_history_legacy", labPrefix),
  ]);
  addTarget(grouped, latency, [
    prefixDescriptor(
      "public_answer_latency",
      env.PUBLIC_ANSWER_LATENCY_REDIS_KEY_PREFIX || "rag-public-answer-latency:v1",
    ),
  ]);
  return [...grouped.values()].map((target) => ({
    connection: target.connection,
    descriptors: [...target.descriptors.values()],
  }));
}

function addTarget(grouped, connection, descriptors) {
  if (!connection) return;
  const identity = `${connection.url}\u0000${connection.token}`;
  let target = grouped.get(identity);
  if (!target) {
    target = { connection, descriptors: new Map() };
    grouped.set(identity, target);
  }
  for (const descriptor of descriptors) {
    target.descriptors.set(`${descriptor.namespace}\u0000${descriptor.pattern}`, descriptor);
  }
}

function redisConnection(env, urlNames, tokenNames) {
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

function exactDescriptor(namespace, key) {
  const normalized = String(key || "").trim();
  if (!normalized) throw new TypeError("audit key must not be empty");
  return { namespace, pattern: escapeRedisGlob(normalized), exactKey: normalized };
}

function prefixDescriptor(namespace, prefix, { classify = null } = {}) {
  const normalized = String(prefix || "").trim().replace(/:+$/u, "");
  if (!normalized) throw new TypeError("audit prefix must not be empty");
  return {
    namespace,
    pattern: `${escapeRedisGlob(normalized)}:*`,
    prefix: `${normalized}:`,
    classify,
  };
}

function normalizeDescriptor(value) {
  if (!value || typeof value !== "object") throw new TypeError("invalid audit descriptor");
  const namespace = String(value.namespace || "").trim();
  const pattern = String(value.pattern || "").trim();
  if (!namespace || !pattern) throw new TypeError("invalid audit descriptor");
  return { ...value, namespace, pattern };
}

async function scanKeys(connection, pattern, fetchImpl, visitKey) {
  if (typeof visitKey !== "function") throw new TypeError("visitKey is required");
  let cursor = "0";
  let iterations = 0;
  do {
    const result = await redisReadCommand(connection, fetchImpl, [
      "SCAN",
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      String(DEFAULT_SCAN_COUNT),
    ]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw auditProtocolError("SCAN returned an unexpected shape");
    }
    cursor = String(result[0]);
    for (const key of result[1]) {
      const text = String(key || "");
      if (text) visitKey(text);
    }
    iterations += 1;
    if (iterations > MAX_SCAN_ITERATIONS) throw auditProtocolError("SCAN did not terminate");
  } while (cursor !== "0");
}

async function redisReadCommand(connection, fetchImpl, command) {
  const operation = String(command?.[0] || "").toUpperCase();
  if (!READ_ONLY_REDIS_COMMAND_SET.has(operation)) {
    const error = new Error(`Redis audit rejected non-read-only command: ${operation || "(empty)"}`);
    error.code = "upstash_audit_write_command_rejected";
    throw error;
  }
  const response = await fetchImpl(connection.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response?.ok) throw auditProtocolError(`Redis HTTP ${response?.status || "error"}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw auditProtocolError("Redis response was not JSON");
  }
  if (payload?.error) throw auditProtocolError("Redis rejected a read-only audit command");
  return payload?.result;
}

function classifyKey(descriptor, key) {
  if (typeof descriptor.classify === "function") {
    return descriptor.classify(key, descriptor.namespace);
  }
  return descriptor.namespace;
}

function classifyAdminRunKey(key, fallback) {
  if (/:snapshot:/u.test(key)) return "admin_runs.snapshot";
  if (/:events$/u.test(key)) return "admin_runs.events";
  if (/:state$/u.test(key)) return "admin_runs.state";
  return fallback;
}

function summarizeNamespaces(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.namespace)) grouped.set(entry.namespace, []);
    grouped.get(entry.namespace).push(entry);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([namespace, values]) => ({ namespace, ...summarizeEntries(values) }));
}

function summarizeEntries(entries) {
  const known = entries.filter((entry) => entry.bytes !== null);
  return {
    keyCount: entries.length,
    knownBytes: known.reduce((total, entry) => total + entry.bytes, 0),
    measuredKeyCount: known.length,
    unmeasuredKeyCount: entries.length - known.length,
    expiringKeyCount: entries.filter((entry) => entry.pttlMs > 0).length,
    persistentKeyCount: entries.filter((entry) => entry.pttlMs === -1).length,
    missingOrUnknownTtlKeyCount: entries.filter((entry) => ![-1].includes(entry.pttlMs) && entry.pttlMs <= 0).length,
  };
}

function sumReports(reports) {
  return reports.reduce((total, report) => ({
    keyCount: total.keyCount + report.totals.keyCount,
    knownBytes: total.knownBytes + report.totals.knownBytes,
    measuredKeyCount: total.measuredKeyCount + report.totals.measuredKeyCount,
    unmeasuredKeyCount: total.unmeasuredKeyCount + report.totals.unmeasuredKeyCount,
    expiringKeyCount: total.expiringKeyCount + report.totals.expiringKeyCount,
    persistentKeyCount: total.persistentKeyCount + report.totals.persistentKeyCount,
    missingOrUnknownTtlKeyCount:
      total.missingOrUnknownTtlKeyCount + report.totals.missingOrUnknownTtlKeyCount,
  }), {
    keyCount: 0,
    knownBytes: 0,
    measuredKeyCount: 0,
    unmeasuredKeyCount: 0,
    expiringKeyCount: 0,
    persistentKeyCount: 0,
    missingOrUnknownTtlKeyCount: 0,
  });
}

function normalizePttl(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : -2;
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function numberOrNegativeOne(value) {
  return value === null ? -1 : value;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return number;
}

function assertConnection(connection) {
  if (!connection?.url || !connection?.token) {
    throw new TypeError("a Redis REST connection is required");
  }
}

function escapeRedisGlob(value) {
  return String(value).replace(/([*?\[\]\\])/gu, "\\$1");
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date;
}

function auditProtocolError(message) {
  const error = new Error(`Upstash storage audit failed: ${message}`);
  error.code = "upstash_audit_protocol_error";
  return error;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write([
      "Usage: pnpm run audit:upstash-storage",
      "",
      "Performs a read-only metadata audit. It never reads Redis values and",
      "never issues mutation commands. Output contains key fingerprints only.",
      "",
    ].join("\n"));
    return;
  }
  const report = await auditConfiguredUpstashStorage();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
