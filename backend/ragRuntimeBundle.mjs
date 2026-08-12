import { createHash } from "node:crypto";
import { brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  hydrateRagCardAliasRuntimeIndex,
  RAG_CARD_ALIAS_RUNTIME_INDEX_ABI,
  RAG_CARD_ALIAS_RUNTIME_INDEX_SCHEMA_VERSION,
} from "./ragCardExtractor.mjs";

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
 * Load one precompiled snapshot or return a fail-closed fallback signal.
 * No corpus array is returned unless every artifact and its source binding pass.
 */
export async function loadRagRuntimeBundle({
  dataDir,
  bundleDir,
  sourceRevisionManifest,
} = {}) {
  if (!dataDir) return fallback("data_dir_missing");
  const resolvedBundleDir = bundleDir || join(dataDir, RAG_RUNTIME_BUNDLE_DIRECTORY);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(resolvedBundleDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE), "utf8"));
  } catch (error) {
    return fallback(classifyReadFailure(error, "bundle_manifest"));
  }

  const manifestValidation = validateRagRuntimeBundleManifest(manifest);
  if (!manifestValidation.ok) return fallback(manifestValidation.reason, manifestValidation.reasons);

  let revisionManifest = sourceRevisionManifest;
  if (!revisionManifest) {
    try {
      revisionManifest = JSON.parse(await readFile(join(dataDir, RAG_DATA_REVISION_MANIFEST_FILE), "utf8"));
    } catch (error) {
      return fallback(classifyReadFailure(error, "source_revision_manifest"));
    }
  }
  const sourceBinding = validateSourceRevisionBinding(manifest, revisionManifest);
  if (!sourceBinding.ok) return fallback(sourceBinding.reason, sourceBinding.reasons);

  const decoded = {};
  for (const corpus of RAG_RUNTIME_CORPORA) {
    const descriptor = manifest.corpora[corpus.key];
    let compressed;
    try {
      compressed = await readFile(join(resolvedBundleDir, descriptor.file));
    } catch (error) {
      return fallback(classifyReadFailure(error, `corpus_${corpus.key}`));
    }
    if (compressed.byteLength !== descriptor.bytes) {
      return fallback("corpus_compressed_size_mismatch", [corpus.key]);
    }
    if (sha256(compressed) !== descriptor.sha256) {
      return fallback("corpus_compressed_hash_mismatch", [corpus.key]);
    }

    let canonicalBytes;
    try {
      canonicalBytes = await decompressBrotli(compressed);
    } catch {
      return fallback("corpus_brotli_decode_failed", [corpus.key]);
    }
    if (canonicalBytes.byteLength !== descriptor.canonicalBytes) {
      return fallback("corpus_canonical_size_mismatch", [corpus.key]);
    }
    if (sha256(canonicalBytes) !== descriptor.canonicalSha256) {
      return fallback("corpus_canonical_hash_mismatch", [corpus.key]);
    }

    let value;
    try {
      value = JSON.parse(canonicalBytes.toString("utf8"));
    } catch {
      return fallback("corpus_json_invalid", [corpus.key]);
    }
    if (!Array.isArray(value)) return fallback("corpus_not_an_array", [corpus.key]);
    if (value.length !== descriptor.count || value.length !== manifest.counts[corpus.key]) {
      return fallback("corpus_count_mismatch", [corpus.key]);
    }
    decoded[corpus.key] = value;
  }

  const decodedArtifacts = {};
  for (const artifact of RAG_RUNTIME_AUXILIARY_ARTIFACTS) {
    const descriptor = manifest.artifacts[artifact.key];
    let compressed;
    try {
      compressed = await readFile(join(resolvedBundleDir, descriptor.file));
    } catch (error) {
      return fallback(classifyReadFailure(error, `artifact_${artifact.key}`));
    }
    if (compressed.byteLength !== descriptor.bytes) {
      return fallback("artifact_compressed_size_mismatch", [artifact.key]);
    }
    if (sha256(compressed) !== descriptor.sha256) {
      return fallback("artifact_compressed_hash_mismatch", [artifact.key]);
    }
    let canonicalBytes;
    try {
      canonicalBytes = await decompressBrotli(compressed);
    } catch {
      return fallback("artifact_brotli_decode_failed", [artifact.key]);
    }
    if (canonicalBytes.byteLength !== descriptor.canonicalBytes) {
      return fallback("artifact_canonical_size_mismatch", [artifact.key]);
    }
    if (sha256(canonicalBytes) !== descriptor.canonicalSha256) {
      return fallback("artifact_canonical_hash_mismatch", [artifact.key]);
    }
    try {
      decodedArtifacts[artifact.key] = JSON.parse(canonicalBytes.toString("utf8"));
    } catch {
      return fallback("artifact_json_invalid", [artifact.key]);
    }
  }

  const data = {
    cards: decoded.cards,
    records: decoded.records,
    qaRecords: decoded.qaRecords,
  };
  if (!hydrateRagCardAliasRuntimeIndex(data.cards, decodedArtifacts.cardAliasIndex)) {
    return fallback("card_alias_index_hydration_failed", ["cardAliasIndex"]);
  }
  // Registration happens only after every corpus and auxiliary artifact ABI,
  // hash, count, identity and source binding has passed. It prevents the
  // injected-data path from applying the production normalizer a second time.
  registerCanonicalNormalizedRagData(data);
  bindTrustedRagDataRevision(data, { ok: true, revision: manifest.dataRevision });
  return Object.freeze({
    ok: true,
    source: "rag_runtime_bundle",
    reason: "",
    reasons: Object.freeze([]),
    data,
    dataRevision: manifest.dataRevision,
    bundleRevision: manifest.bundleRevision,
    manifest,
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
  if (revisionManifest.revision !== revisionManifest.canonicalCorpusDigest) {
    reasons.push("revision_digest_mismatch");
  }
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
  // Preserve object insertion order from the production normalizer. Several
  // downstream prompts embed evidence with JSON.stringify, so sorting object
  // keys here would keep values deep-equal while silently changing the exact
  // final model input. Source ordering is deterministic and the manifest binds
  // these byte-exact serialized corpora with SHA-256.
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function stableJsonStringify(value) {
  return serializeJson(value, new WeakSet(), false);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  for (const field of ["bytes", "canonicalBytes", "count"]) {
    if (!Number.isSafeInteger(descriptor[field]) || descriptor[field] < 0) {
      reasons.push(`corpus_${expected.key}_${field}_invalid`);
    }
  }
  if (!SHA256.test(String(descriptor.sha256 || ""))) reasons.push(`corpus_${expected.key}_hash_invalid`);
  if (!SHA256.test(String(descriptor.canonicalSha256 || ""))) {
    reasons.push(`corpus_${expected.key}_canonical_hash_invalid`);
  }
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
  for (const field of ["bytes", "canonicalBytes", "count"]) {
    if (!Number.isSafeInteger(descriptor[field]) || descriptor[field] < 0) {
      reasons.push(`artifact_${expected.key}_${field}_invalid`);
    }
  }
  if (!SHA256.test(String(descriptor.sha256 || ""))) reasons.push(`artifact_${expected.key}_hash_invalid`);
  if (!SHA256.test(String(descriptor.canonicalSha256 || ""))) {
    reasons.push(`artifact_${expected.key}_canonical_hash_invalid`);
  }
  if (!Number.isSafeInteger(counts?.[expected.countKey]) || counts[expected.countKey] < 0) {
    reasons.push(`count_${expected.countKey}_invalid`);
  } else if (descriptor.count !== counts[expected.countKey]) {
    reasons.push(`artifact_${expected.key}_count_mismatch`);
  }
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

function fallback(reason, details = []) {
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

function invalid(reason, reasons) {
  return Object.freeze({ ok: false, reason, reasons: Object.freeze([...new Set(reasons)]) });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
