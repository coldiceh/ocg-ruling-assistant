import { createHash } from "node:crypto";

export const ADMIN_EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Creates a content-addressed, JSON-only evidence snapshot.
 *
 * The input is copied before it is frozen, so later mutations of the source
 * objects cannot change what a run observed.
 */
export function createAdminEvidenceSnapshot({
  question = "",
  evidence = {},
  dataVersions = {},
  metadata = {},
  createdAt = new Date(),
} = {}) {
  const content = canonicalizeJson({
    question: String(question || ""),
    evidence,
    dataVersions,
    metadata,
  });
  const contentSha256 = hashCanonicalContent(content);
  return deepFreeze({
    schemaVersion: ADMIN_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `evidence_${contentSha256.slice(0, 24)}`,
    contentSha256,
    createdAt: toIsoString(createdAt),
    ...content,
  });
}

export const createEvidenceSnapshot = createAdminEvidenceSnapshot;

export function serializeAdminEvidenceSnapshot(snapshot) {
  assertAdminEvidenceSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

export function parseAdminEvidenceSnapshot(serialized) {
  const parsed = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("evidence snapshot must be an object");
  }
  if (parsed.schemaVersion !== ADMIN_EVIDENCE_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError("unsupported evidence snapshot schema version");
  }
  const content = canonicalizeJson({
    question: String(parsed.question || ""),
    evidence: parsed.evidence ?? {},
    dataVersions: parsed.dataVersions ?? {},
    metadata: parsed.metadata ?? {},
  });
  const expectedHash = hashCanonicalContent(content);
  const expectedId = `evidence_${expectedHash.slice(0, 24)}`;
  if (String(parsed.contentSha256 || "") !== expectedHash || String(parsed.snapshotId || "") !== expectedId) {
    throw new Error("evidence snapshot integrity check failed");
  }
  return deepFreeze({
    schemaVersion: ADMIN_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: expectedId,
    contentSha256: expectedHash,
    createdAt: toIsoString(parsed.createdAt),
    ...content,
  });
}

export const parseEvidenceSnapshot = parseAdminEvidenceSnapshot;

export function isAdminEvidenceSnapshot(value) {
  try {
    assertAdminEvidenceSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

export function assertAdminEvidenceSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("evidence snapshot is required");
  }
  if (value.schemaVersion !== ADMIN_EVIDENCE_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError("unsupported evidence snapshot schema version");
  }
  const content = canonicalizeJson({
    question: String(value.question || ""),
    evidence: value.evidence ?? {},
    dataVersions: value.dataVersions ?? {},
    metadata: value.metadata ?? {},
  });
  const expectedHash = hashCanonicalContent(content);
  if (String(value.contentSha256 || "") !== expectedHash) {
    throw new Error("evidence snapshot content hash mismatch");
  }
  if (String(value.snapshotId || "") !== `evidence_${expectedHash.slice(0, 24)}`) {
    throw new Error("evidence snapshot id mismatch");
  }
  toIsoString(value.createdAt);
  return value;
}

function hashCanonicalContent(content) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function canonicalizeJson(value, seen = new Set(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`non-JSON value at ${path}`);
  if (seen.has(value)) throw new TypeError(`cyclic value at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalizeJson(item, seen, `${path}[${index}]`));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`non-plain object at ${path}`);
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key], seen, `${path}.${key}`)]),
    );
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("invalid evidence snapshot timestamp");
  return date.toISOString();
}
