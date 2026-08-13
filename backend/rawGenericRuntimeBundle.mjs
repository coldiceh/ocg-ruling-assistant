import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";

import {
  RAG_CARD_ALIAS_RUNTIME_INDEX_ABI,
  RAG_CARD_ALIAS_RUNTIME_INDEX_SCHEMA_VERSION,
} from "./ragCardAliasRuntimeContract.mjs";
import {
  bindTrustedRagDataRevision,
  RAG_DATA_REVISION_CANONICALIZATION_ABI,
  RAG_DATA_REVISION_COMPILER_ABI,
  RAG_DATA_REVISION_MANIFEST_FILE,
  RAG_DATA_REVISION_MANIFEST_SCHEMA_VERSION,
  RAG_DATA_REVISION_SOURCE_FILES,
  stableRagRevisionJson,
} from "./ragDataRevisionManifest.mjs";
import { registerCanonicalNormalizedRagData } from "./ragNormalizedDataRegistry.mjs";

export const RAG_RUNTIME_BUNDLE_SCHEMA_VERSION = 1;
export const RAG_RUNTIME_BUNDLE_COMPILER_ABI = "rag-runtime-bundle-compiler/v3";
export const RAG_RUNTIME_BUNDLE_ABI = "rag-runtime-bundle/v3";
export const RAG_RUNTIME_BUNDLE_DIRECTORY = "rag-runtime-v1";
export const RAG_RUNTIME_BUNDLE_MANIFEST_FILE = "manifest.json";

export const RAG_RUNTIME_CORPORA = Object.freeze([
  Object.freeze({ key: "cards", file: "cards.json.br" }),
  Object.freeze({ key: "records", file: "records.json.br" }),
  Object.freeze({ key: "qaRecords", file: "qa-records.json.br" }),
]);

export const RAG_RUNTIME_AUXILIARY_ARTIFACTS = Object.freeze([
  Object.freeze({
    key: "cardAliasIndex",
    file: "card-alias-index.json.br",
    countKey: "cards",
    schemaVersion: RAG_CARD_ALIAS_RUNTIME_INDEX_SCHEMA_VERSION,
    compilerAbi: RAG_CARD_ALIAS_RUNTIME_INDEX_ABI,
  }),
]);

const decompressBrotli = promisify(brotliDecompress);
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Public raw-only loader for a precompiled RAG snapshot.
 *
 * Every declared corpus and auxiliary artifact is authenticated and decoded.
 * Auxiliary values are deliberately not interpreted or hydrated: the public
 * resolver builds its own identity-only indexes from the verified card corpus.
 */
export async function loadRawGenericRuntimeBundle(options = {}) {
  const verified = await loadVerifiedRawGenericRuntimeBundle(options);
  return verified.ok ? finalizeVerifiedRawGenericRuntimeBundle(verified) : verified;
}

/**
 * Shared byte-verification core. The legacy wrapper consumes `artifacts` only
 * after this function has verified the same manifest, hashes and source binding
 * used by the raw-only public loader.
 */
export async function loadVerifiedRawGenericRuntimeBundle({
  dataDir,
  bundleDir,
  sourceRevisionManifest,
} = {}) {
  if (!dataDir) return runtimeBundleFallback("data_dir_missing");
  const resolvedBundleDir = bundleDir || join(dataDir, RAG_RUNTIME_BUNDLE_DIRECTORY);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(resolvedBundleDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE), "utf8"));
  } catch (error) {
    return runtimeBundleFallback(classifyReadFailure(error, "bundle_manifest"));
  }

  const manifestValidation = validateRagRuntimeBundleManifest(manifest);
  if (!manifestValidation.ok) {
    return runtimeBundleFallback(manifestValidation.reason, manifestValidation.reasons);
  }

  let revisionManifest = sourceRevisionManifest;
  if (!revisionManifest) {
    try {
      revisionManifest = JSON.parse(await readFile(join(dataDir, RAG_DATA_REVISION_MANIFEST_FILE), "utf8"));
    } catch (error) {
      return runtimeBundleFallback(classifyReadFailure(error, "source_revision_manifest"));
    }
  }
  const sourceBinding = validateSourceRevisionBinding(manifest, revisionManifest);
  if (!sourceBinding.ok) {
    return runtimeBundleFallback(sourceBinding.reason, sourceBinding.reasons);
  }

  const decoded = {};
  for (const corpus of RAG_RUNTIME_CORPORA) {
    const loaded = await readVerifiedBundleValue({
      resolvedBundleDir,
      descriptor: manifest.corpora[corpus.key],
      category: "corpus",
      key: corpus.key,
      expectArray: true,
    });
    if (!loaded.ok) return runtimeBundleFallback(loaded.reason, loaded.reasons);
    if (loaded.value.length !== manifest.corpora[corpus.key].count
      || loaded.value.length !== manifest.counts[corpus.key]) {
      return runtimeBundleFallback("corpus_count_mismatch", [corpus.key]);
    }
    decoded[corpus.key] = loaded.value;
  }

  const artifacts = {};
  for (const artifact of RAG_RUNTIME_AUXILIARY_ARTIFACTS) {
    const loaded = await readVerifiedBundleValue({
      resolvedBundleDir,
      descriptor: manifest.artifacts[artifact.key],
      category: "artifact",
      key: artifact.key,
      expectArray: false,
    });
    if (!loaded.ok) return runtimeBundleFallback(loaded.reason, loaded.reasons);
    artifacts[artifact.key] = loaded.value;
  }

  return Object.freeze({
    ok: true,
    source: "rag_runtime_bundle",
    reason: "",
    reasons: Object.freeze([]),
    data: {
      cards: decoded.cards,
      records: decoded.records,
      qaRecords: decoded.qaRecords,
    },
    artifacts: Object.freeze(artifacts),
    dataRevision: manifest.dataRevision,
    bundleRevision: manifest.bundleRevision,
    manifest,
  });
}

export function finalizeVerifiedRawGenericRuntimeBundle(verified) {
  if (verified?.ok !== true || !verified.data) return verified;
  registerCanonicalNormalizedRagData(verified.data);
  bindTrustedRagDataRevision(verified.data, { ok: true, revision: verified.dataRevision });
  return Object.freeze({
    ok: true,
    source: verified.source,
    reason: "",
    reasons: Object.freeze([]),
    data: verified.data,
    dataRevision: verified.dataRevision,
    bundleRevision: verified.bundleRevision,
    manifest: verified.manifest,
  });
}

export function validateRagRuntimeBundleManifest(manifest) {
  const reasons = [];
  if (!isPlainObject(manifest)) return invalid("bundle_manifest_invalid", ["not_an_object"]);
  if (manifest.schemaVersion !== RAG_RUNTIME_BUNDLE_SCHEMA_VERSION) reasons.push("schema_version_mismatch");
  if (manifest.kind !== "rag-runtime-bundle") reasons.push("kind_mismatch");
  if (manifest.compilerAbi !== RAG_RUNTIME_BUNDLE_COMPILER_ABI) reasons.push("compiler_abi_mismatch");
  if (manifest.runtimeAbi !== RAG_RUNTIME_BUNDLE_ABI) reasons.push("runtime_abi_mismatch");
  if (manifest.canonicalizationAbi !== RAG_DATA_REVISION_CANONICALIZATION_ABI) {
    reasons.push("canonicalization_abi_mismatch");
  }
  if (!isPlainObject(manifest.compression)
    || manifest.compression.algorithm !== "brotli"
    || !Number.isInteger(manifest.compression.quality)
    || manifest.compression.quality < 0
    || manifest.compression.quality > 11) {
    reasons.push("compression_descriptor_invalid");
  }
  if (!SHA256.test(String(manifest.dataRevision || ""))) reasons.push("data_revision_invalid");
  if (!SHA256.test(String(manifest.sourceSetDigest || ""))) reasons.push("source_set_digest_invalid");
  if (!SHA256.test(String(manifest.bundleRevision || ""))) reasons.push("bundle_revision_invalid");

  const sources = normalizeRuntimeSources(manifest.sources, reasons);
  if (!isPlainObject(manifest.counts)) {
    reasons.push("counts_invalid");
  }
  if (!isPlainObject(manifest.corpora)) {
    reasons.push("corpora_invalid");
  } else {
    const corpusKeys = Object.keys(manifest.corpora).sort();
    const expectedKeys = RAG_RUNTIME_CORPORA.map(({ key }) => key).sort();
    if (JSON.stringify(corpusKeys) !== JSON.stringify(expectedKeys)) reasons.push("corpus_set_mismatch");
    for (const corpus of RAG_RUNTIME_CORPORA) {
      validateCorpusDescriptor(manifest.corpora[corpus.key], corpus, manifest.counts, reasons);
    }
  }
  if (!isPlainObject(manifest.artifacts)) {
    reasons.push("artifacts_invalid");
  } else {
    const artifactKeys = Object.keys(manifest.artifacts).sort();
    const expectedKeys = RAG_RUNTIME_AUXILIARY_ARTIFACTS.map(({ key }) => key).sort();
    if (JSON.stringify(artifactKeys) !== JSON.stringify(expectedKeys)) reasons.push("artifact_set_mismatch");
    for (const artifact of RAG_RUNTIME_AUXILIARY_ARTIFACTS) {
      validateAuxiliaryArtifactDescriptor(manifest.artifacts[artifact.key], artifact, manifest.counts, reasons);
    }
  }

  if (sources.length === RAG_DATA_REVISION_SOURCE_FILES.length
    && sha256(stableRagRevisionJson(sources.map(sourceRevisionProjection))) !== manifest.sourceSetDigest) {
    reasons.push("source_set_digest_mismatch");
  }
  if (recomputeBundleRevision(manifest) !== manifest.bundleRevision) reasons.push("bundle_revision_mismatch");
  return reasons.length
    ? invalid("bundle_manifest_invalid", reasons)
    : Object.freeze({ ok: true, reason: "", reasons: Object.freeze([]) });
}

export function validateSourceRevisionBinding(bundleManifest, revisionManifest) {
  const reasons = [];
  if (!isPlainObject(revisionManifest)) return invalid("source_revision_manifest_invalid", ["not_an_object"]);
  if (revisionManifest.schemaVersion !== RAG_DATA_REVISION_MANIFEST_SCHEMA_VERSION) reasons.push("schema_version_mismatch");
  if (revisionManifest.kind !== "rag-data-revision-manifest") reasons.push("kind_mismatch");
  if (revisionManifest.compilerAbi !== RAG_DATA_REVISION_COMPILER_ABI) reasons.push("compiler_abi_mismatch");
  if (revisionManifest.canonicalizationAbi !== RAG_DATA_REVISION_CANONICALIZATION_ABI) {
    reasons.push("canonicalization_abi_mismatch");
  }
  if (!SHA256.test(String(revisionManifest.revision || ""))) reasons.push("revision_invalid");
  if (!SHA256.test(String(revisionManifest.canonicalCorpusDigest || ""))) {
    reasons.push("canonical_corpus_digest_invalid");
  }
  if (revisionManifest.revision !== revisionManifest.canonicalCorpusDigest) reasons.push("revision_digest_mismatch");
  if (!SHA256.test(String(revisionManifest.sourceSetDigest || ""))) reasons.push("source_set_digest_invalid");
  if (revisionManifest.revision !== bundleManifest.dataRevision) reasons.push("data_revision_mismatch");
  if (revisionManifest.sourceSetDigest !== bundleManifest.sourceSetDigest) reasons.push("source_set_digest_mismatch");
  const revisionSources = Array.isArray(revisionManifest.sources) ? revisionManifest.sources : [];
  const bundleSources = Array.isArray(bundleManifest.sources) ? bundleManifest.sources : [];
  if (stableRagRevisionJson(revisionSources) !== stableRagRevisionJson(bundleSources.map(sourceRevisionProjection))) {
    reasons.push("source_descriptors_mismatch");
  }
  if (sha256(stableRagRevisionJson(revisionSources)) !== revisionManifest.sourceSetDigest) {
    reasons.push("source_set_digest_recomputed_mismatch");
  }
  if (stableRagRevisionJson(revisionManifest.counts) !== stableRagRevisionJson(bundleManifest.counts)) {
    reasons.push("record_counts_mismatch");
  }
  return reasons.length
    ? invalid("source_revision_binding_mismatch", reasons)
    : Object.freeze({ ok: true, reason: "", reasons: Object.freeze([]) });
}

export function recomputeBundleRevision(manifest) {
  if (!manifest || typeof manifest !== "object") return "";
  const { bundleRevision: _ignored, ...revisionInput } = manifest;
  return sha256(stableRagRevisionJson(revisionInput));
}

export function canonicalJsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function stableJsonStringify(value) {
  return serializeJson(value, new WeakSet(), false);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function runtimeBundleFallback(reason, details = []) {
  return Object.freeze({
    ok: false,
    source: "legacy_raw_fallback_required",
    reason,
    reasons: Object.freeze(Array.isArray(details) ? details : [String(details)]),
    data: null,
    dataRevision: "",
    bundleRevision: "",
    manifest: null,
  });
}

async function readVerifiedBundleValue({ resolvedBundleDir, descriptor, category, key, expectArray }) {
  let compressed;
  try {
    compressed = await readFile(join(resolvedBundleDir, descriptor.file));
  } catch (error) {
    return invalid(classifyReadFailure(error, `${category}_${key}`), [key]);
  }
  if (compressed.byteLength !== descriptor.bytes) {
    return invalid(`${category}_compressed_size_mismatch`, [key]);
  }
  if (sha256(compressed) !== descriptor.sha256) {
    return invalid(`${category}_compressed_hash_mismatch`, [key]);
  }

  let canonicalBytes;
  try {
    canonicalBytes = await decompressBrotli(compressed);
  } catch {
    return invalid(`${category}_brotli_decode_failed`, [key]);
  }
  if (canonicalBytes.byteLength !== descriptor.canonicalBytes) {
    return invalid(`${category}_canonical_size_mismatch`, [key]);
  }
  if (sha256(canonicalBytes) !== descriptor.canonicalSha256) {
    return invalid(`${category}_canonical_hash_mismatch`, [key]);
  }

  let value;
  try {
    value = JSON.parse(canonicalBytes.toString("utf8"));
  } catch {
    return invalid(`${category}_json_invalid`, [key]);
  }
  if (expectArray && !Array.isArray(value)) return invalid(`${category}_not_an_array`, [key]);
  return Object.freeze({ ok: true, value });
}

function serializeJson(value, seen, arrayMember) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (type === "bigint") throw new TypeError("BigInt cannot be serialized as JSON");
  if (["undefined", "function", "symbol"].includes(type)) return arrayMember ? "null" : undefined;
  if (typeof value?.toJSON === "function") return serializeJson(value.toJSON(), seen, arrayMember);
  if (seen.has(value)) throw new TypeError("Converting circular structure to JSON");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${Array.from(value, (item) => serializeJson(item, seen, true)).join(",")}]`;
  } else {
    const fields = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = serializeJson(value[key], seen, false);
      if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`);
    }
    result = `{${fields.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function validateCorpusDescriptor(descriptor, expected, counts, reasons) {
  if (!isPlainObject(descriptor)) {
    reasons.push(`corpus_${expected.key}_invalid`);
    return;
  }
  if (descriptor.key !== expected.key) reasons.push(`corpus_${expected.key}_key_mismatch`);
  if (descriptor.file !== expected.file) reasons.push(`corpus_${expected.key}_file_mismatch`);
  if (descriptor.encoding !== "br") reasons.push(`corpus_${expected.key}_encoding_mismatch`);
  validateByteDescriptor(descriptor, `corpus_${expected.key}`, reasons);
  if (!Number.isSafeInteger(counts?.[expected.key]) || counts[expected.key] < 0) {
    reasons.push(`count_${expected.key}_invalid`);
  } else if (descriptor.count !== counts[expected.key]) {
    reasons.push(`count_${expected.key}_mismatch`);
  }
}

function validateAuxiliaryArtifactDescriptor(descriptor, expected, counts, reasons) {
  if (!isPlainObject(descriptor)) {
    reasons.push(`artifact_${expected.key}_invalid`);
    return;
  }
  if (descriptor.key !== expected.key) reasons.push(`artifact_${expected.key}_key_mismatch`);
  if (descriptor.file !== expected.file) reasons.push(`artifact_${expected.key}_file_mismatch`);
  if (descriptor.encoding !== "br") reasons.push(`artifact_${expected.key}_encoding_mismatch`);
  if (descriptor.schemaVersion !== expected.schemaVersion) {
    reasons.push(`artifact_${expected.key}_schema_version_mismatch`);
  }
  if (descriptor.compilerAbi !== expected.compilerAbi) reasons.push(`artifact_${expected.key}_compiler_abi_mismatch`);
  validateByteDescriptor(descriptor, `artifact_${expected.key}`, reasons);
  if (!Number.isSafeInteger(counts?.[expected.countKey]) || counts[expected.countKey] < 0) {
    reasons.push(`count_${expected.countKey}_invalid`);
  } else if (descriptor.count !== counts[expected.countKey]) {
    reasons.push(`artifact_${expected.key}_count_mismatch`);
  }
}

function validateByteDescriptor(descriptor, prefix, reasons) {
  for (const field of ["bytes", "canonicalBytes", "count"]) {
    if (!Number.isSafeInteger(descriptor[field]) || descriptor[field] < 0) {
      reasons.push(`${prefix}_${field}_invalid`);
    }
  }
  if (!SHA256.test(String(descriptor.sha256 || ""))) reasons.push(`${prefix}_hash_invalid`);
  if (!SHA256.test(String(descriptor.canonicalSha256 || ""))) reasons.push(`${prefix}_canonical_hash_invalid`);
}

function normalizeRuntimeSources(value, reasons) {
  if (!Array.isArray(value)) {
    reasons.push("sources_invalid");
    return [];
  }
  const byPath = new Map();
  for (const source of value) {
    const path = String(source?.path || "");
    if (!RAG_DATA_REVISION_SOURCE_FILES.includes(path)
      || byPath.has(path)
      || !Number.isSafeInteger(source?.bytes) || source.bytes < 0
      || !Number.isSafeInteger(source?.count) || source.count < 0
      || !SHA256.test(String(source?.sha256 || ""))) {
      reasons.push("source_descriptor_invalid");
      continue;
    }
    byPath.set(path, source);
  }
  if (byPath.size !== RAG_DATA_REVISION_SOURCE_FILES.length) reasons.push("source_descriptor_set_incomplete");
  return RAG_DATA_REVISION_SOURCE_FILES.map((path) => byPath.get(path)).filter(Boolean);
}

function sourceRevisionProjection(source) {
  return { path: source.path, bytes: source.bytes, sha256: source.sha256 };
}

function classifyReadFailure(error, prefix) {
  return error?.code === "ENOENT" ? `${prefix}_missing` : `${prefix}_unreadable`;
}

function invalid(reason, reasons) {
  return Object.freeze({ ok: false, reason, reasons: Object.freeze([...new Set(reasons)]) });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
