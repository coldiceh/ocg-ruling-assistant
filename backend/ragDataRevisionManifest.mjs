import { createHash } from "node:crypto";

export const RAG_DATA_REVISION_MANIFEST_SCHEMA_VERSION = 1;
export const RAG_DATA_REVISION_COMPILER_ABI = "rag-data-revision-compiler/v1";
export const RAG_DATA_REVISION_CANONICALIZATION_ABI = "rag-data-revision-canonical-json/v1";
export const RAG_DATA_REVISION_MANIFEST_FILE = "rag-data-revision-manifest.json";
export const RAG_DATA_REVISION_SOURCE_FILES = Object.freeze([
  "cards.json",
  "rulings.json",
  "qa-index.json",
  "evidence-index.json",
  "ocg-rule-corpus.json",
  "official-responses.json",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const trustedRevisionBySnapshot = new WeakMap();

export function createRagDataSourceDescriptor(path, rawContent) {
  const content = Buffer.isBuffer(rawContent)
    ? rawContent
    : Buffer.from(String(rawContent ?? ""), "utf8");
  return Object.freeze({
    path: String(path || ""),
    bytes: content.byteLength,
    sha256: sha256(content),
  });
}

export function computeRagDataRevision(data = {}, configuredRevision = "") {
  return sha256(stableRagRevisionJson({
    configuredRevision: String(configuredRevision || ""),
    cards: data.cards || [],
    records: data.records || [],
    qaRecords: data.qaRecords || [],
  }));
}

export function buildRagDataRevisionManifest({ data = {}, sources = [] } = {}) {
  const normalizedSources = normalizeSourceDescriptors(sources);
  const canonicalCorpusDigest = computeRagDataRevision(data, "");
  return Object.freeze({
    schemaVersion: RAG_DATA_REVISION_MANIFEST_SCHEMA_VERSION,
    kind: "rag-data-revision-manifest",
    compilerAbi: RAG_DATA_REVISION_COMPILER_ABI,
    canonicalizationAbi: RAG_DATA_REVISION_CANONICALIZATION_ABI,
    revision: canonicalCorpusDigest,
    canonicalCorpusDigest,
    sourceSetDigest: sha256(stableRagRevisionJson(normalizedSources)),
    counts: Object.freeze({
      cards: arrayLength(data.cards),
      records: arrayLength(data.records),
      qaRecords: arrayLength(data.qaRecords),
    }),
    sources: Object.freeze(normalizedSources),
  });
}

export function validateRagDataRevisionManifest(manifest, {
  data,
  sources = [],
  verifyCanonicalCorpus = false,
} = {}) {
  const reasons = [];
  if (!isPlainObject(manifest)) return invalid(["manifest_not_an_object"]);
  if (manifest.schemaVersion !== RAG_DATA_REVISION_MANIFEST_SCHEMA_VERSION) reasons.push("schema_version_mismatch");
  if (manifest.kind !== "rag-data-revision-manifest") reasons.push("kind_mismatch");
  if (manifest.compilerAbi !== RAG_DATA_REVISION_COMPILER_ABI) reasons.push("compiler_abi_mismatch");
  if (manifest.canonicalizationAbi !== RAG_DATA_REVISION_CANONICALIZATION_ABI) reasons.push("canonicalization_abi_mismatch");
  if (!SHA256.test(String(manifest.revision || ""))) reasons.push("revision_invalid");
  if (!SHA256.test(String(manifest.canonicalCorpusDigest || ""))) reasons.push("canonical_corpus_digest_invalid");
  if (manifest.revision !== manifest.canonicalCorpusDigest) reasons.push("revision_digest_mismatch");

  let normalizedSources = [];
  try {
    normalizedSources = normalizeSourceDescriptors(sources);
  } catch {
    reasons.push("runtime_source_descriptors_invalid");
  }
  let manifestSources = [];
  try {
    manifestSources = normalizeSourceDescriptors(manifest.sources);
  } catch {
    reasons.push("manifest_source_descriptors_invalid");
  }
  const sourceSetDigest = sha256(stableRagRevisionJson(normalizedSources));
  if (!SHA256.test(String(manifest.sourceSetDigest || ""))) reasons.push("source_set_digest_invalid");
  if (manifest.sourceSetDigest !== sourceSetDigest) reasons.push("source_set_digest_mismatch");
  if (stableRagRevisionJson(manifestSources) !== stableRagRevisionJson(normalizedSources)) {
    reasons.push("source_descriptors_mismatch");
  }

  if (!isPlainObject(manifest.counts)) {
    reasons.push("counts_invalid");
  } else if (data) {
    const expectedCounts = {
      cards: arrayLength(data.cards),
      records: arrayLength(data.records),
      qaRecords: arrayLength(data.qaRecords),
    };
    if (stableRagRevisionJson(manifest.counts) !== stableRagRevisionJson(expectedCounts)) {
      reasons.push("record_counts_mismatch");
    }
  }
  if (verifyCanonicalCorpus && data) {
    const actualDigest = computeRagDataRevision(data, "");
    if (actualDigest !== manifest.canonicalCorpusDigest) reasons.push("canonical_corpus_digest_mismatch");
  }
  return reasons.length ? invalid(reasons) : Object.freeze({
    ok: true,
    reasons: Object.freeze([]),
    revision: manifest.canonicalCorpusDigest,
  });
}

export function bindTrustedRagDataRevision(data, validation) {
  if (!data || typeof data !== "object" || validation?.ok !== true || !SHA256.test(String(validation.revision || ""))) {
    return false;
  }
  trustedRevisionBySnapshot.set(data, validation.revision);
  return true;
}

export function getTrustedRagDataRevision(data) {
  if (!data || typeof data !== "object") return "";
  return trustedRevisionBySnapshot.get(data) || "";
}

export function resolveRagDataRevision(data = {}, configuredRevision = "") {
  const configured = String(configuredRevision || "");
  if (!configured) {
    const trusted = getTrustedRagDataRevision(data);
    if (trusted) return trusted;
  }
  return computeRagDataRevision(data, configured);
}

export function stableRagRevisionJson(value, seen = new WeakSet()) {
  if (value === undefined) return '"[undefined]"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((item) => stableRagRevisionJson(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${stableRagRevisionJson(value[key], seen)}`
      )).join(",")}}`;
  seen.delete(value);
  return serialized;
}

function normalizeSourceDescriptors(sources) {
  if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
  const byPath = new Map();
  for (const source of sources) {
    const path = String(source?.path || "");
    const bytes = Number(source?.bytes);
    const digest = String(source?.sha256 || "").toLowerCase();
    if (!RAG_DATA_REVISION_SOURCE_FILES.includes(path)
      || !Number.isSafeInteger(bytes) || bytes < 0
      || !SHA256.test(digest)
      || byPath.has(path)) {
      throw new TypeError("invalid RAG data source descriptor");
    }
    byPath.set(path, Object.freeze({ path, bytes, sha256: digest }));
  }
  if (byPath.size !== RAG_DATA_REVISION_SOURCE_FILES.length) {
    throw new TypeError("incomplete RAG data source descriptor set");
  }
  return RAG_DATA_REVISION_SOURCE_FILES.map((path) => byPath.get(path));
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(reasons) {
  return Object.freeze({ ok: false, reasons: Object.freeze([...new Set(reasons)]), revision: "" });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
