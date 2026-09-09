import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { endianness } from "node:os";

import {
  completeDenseQueue,
  roundRobinLexicalDense,
} from "./evidenceQueueOrder.mjs";

const HEX_64 = /^[a-f0-9]{64}$/u;
const DEFAULT_MANIFEST = "evidence-vector-index.json";
const DEFAULT_K = 256;

function check(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeShardPath(dataDir, file) {
  check(typeof file === "string" && file.length > 0 && path.basename(file) === file,
    "evidence_vector_shard_name_invalid");
  const resolvedRoot = path.resolve(dataDir);
  const resolved = path.resolve(resolvedRoot, file);
  check(path.dirname(resolved) === resolvedRoot, "evidence_vector_shard_path_invalid");
  return resolved;
}

function validateManifest(manifest, expectedDataRevision) {
  check(manifest?.schemaVersion === 1
    && manifest?.kind === "evidence-vector-index"
    && manifest?.encoding === "raw-little-endian-float32"
    && Number.isSafeInteger(manifest.dimension) && manifest.dimension > 0,
  "evidence_vector_manifest_invalid");
  check(typeof manifest.dataRevision === "string" && manifest.dataRevision.length > 0,
    "evidence_vector_data_revision_invalid");
  if (expectedDataRevision !== undefined) {
    check(manifest.dataRevision === expectedDataRevision, "evidence_vector_data_revision_changed");
  }
  check(manifest.model?.id && manifest.model?.revision
    && HEX_64.test(String(manifest.inputContractSha256 || ""))
    && Array.isArray(manifest.orderedContentHashes)
    && Array.isArray(manifest.entries)
    && Array.isArray(manifest.shards),
  "evidence_vector_contract_invalid");
  check(manifest.entries.length === manifest.orderedContentHashes.length,
    "evidence_vector_entry_count_invalid");
  check(manifest.uniqueContentCount === manifest.entries.length,
    "evidence_vector_unique_content_count_invalid");
  check(sha256(JSON.stringify(manifest.orderedContentHashes)) === manifest.orderedContentHashesSha256,
    "evidence_vector_content_order_changed");
  check(manifest.vectorByteLength === manifest.shards.reduce(
    (sum, shard) => sum + Number(shard?.byteLength || 0), 0,
  ), "evidence_vector_total_size_invalid");
  check(sha256(JSON.stringify(manifest.shards.map((shard) => ({
    index: shard.index,
    byteLength: shard.byteLength,
    sha256: shard.sha256,
  })))) === manifest.shardSetSha256, "evidence_vector_shard_set_changed");

  const seen = new Set();
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    check(entry?.textSha256 === manifest.orderedContentHashes[index]
      && HEX_64.test(String(entry.textSha256 || ""))
      && !seen.has(entry.textSha256)
      && Number.isSafeInteger(entry.shardIndex) && entry.shardIndex >= 0
      && Number.isSafeInteger(entry.rowIndex) && entry.rowIndex >= 0,
    "evidence_vector_entry_invalid");
    seen.add(entry.textSha256);
  }
  return manifest;
}

export async function loadEvidenceVectorIndex({
  dataDir,
  manifestFile = DEFAULT_MANIFEST,
  dataRevision,
  readFileImpl = readFile,
} = {}) {
  check(typeof dataDir === "string" && dataDir.length > 0, "evidence_vector_data_dir_required");
  check(endianness() === "LE", "evidence_vector_runtime_endianness_unsupported");
  check(path.basename(manifestFile) === manifestFile, "evidence_vector_manifest_name_invalid");
  check(typeof readFileImpl === "function", "evidence_vector_read_file_invalid");
  const manifestPath = path.resolve(dataDir, manifestFile);
  const manifest = validateManifest(
    JSON.parse(await readFileImpl(manifestPath, "utf8")),
    dataRevision,
  );
  const rowBytes = manifest.dimension * Float32Array.BYTES_PER_ELEMENT;
  const shards = await Promise.all(manifest.shards.map(async (descriptor, index) => {
    check(descriptor?.index === index
      && Number.isSafeInteger(descriptor.rowCount) && descriptor.rowCount > 0
      && Number.isSafeInteger(descriptor.byteLength)
      && descriptor.byteLength === descriptor.rowCount * rowBytes
      && HEX_64.test(String(descriptor.sha256 || "")),
    "evidence_vector_shard_descriptor_invalid");
    const bytes = await readFileImpl(safeShardPath(dataDir, descriptor.file));
    check(bytes.byteLength === descriptor.byteLength, "evidence_vector_shard_size_changed");
    check(sha256(bytes) === descriptor.sha256, "evidence_vector_shard_hash_changed");
    // A view shares the existing allocation, so the index keeps one vector copy.
    // readFile Buffers are aligned on supported Node runtimes; copy only if needed.
    const alignedBytes = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
      ? bytes : Uint8Array.from(bytes);
    const values = new Float32Array(alignedBytes.buffer, alignedBytes.byteOffset,
      alignedBytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
    for (let component = 0; component < values.length; component += 1) {
      check(Number.isFinite(values[component]), "evidence_document_vector_nonfinite");
    }
    return values;
  }));
  for (const entry of manifest.entries) {
    const descriptor = manifest.shards[entry.shardIndex];
    check(descriptor && entry.rowIndex < descriptor.rowCount,
      "evidence_vector_entry_row_invalid");
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.textSha256, entry]));
  return Object.freeze({ manifestPath, manifest, entries, shards: Object.freeze(shards) });
}

function normalizedQueryVector(value, dimension) {
  check(Array.isArray(value) || ArrayBuffer.isView(value), "evidence_query_vector_invalid");
  check(value.length === dimension, "evidence_query_vector_dimension_invalid");
  const vector = value instanceof Float32Array ? value : Float32Array.from(value);
  let normSquared = 0;
  for (const component of vector) {
    check(Number.isFinite(component), "evidence_query_vector_nonfinite");
    normSquared += component * component;
  }
  check(Math.abs(Math.sqrt(normSquared) - 1) <= 1e-4,
    "evidence_query_vector_not_normalized");
  return vector;
}

function dotFloat32(query, values, componentOffset) {
  let sum = 0;
  for (let index = 0; index < query.length; index += 1) {
    // Float32 components, float64 accumulator. This avoids repeated float32
    // rounding and can change near-tied scores; the ranking rule stays unchanged.
    sum += query[index] * values[componentOffset + index];
  }
  return sum;
}

function scoreView(index, query, textSha256) {
  const entry = index.entries.get(textSha256);
  check(entry, "evidence_document_vector_missing");
  const shard = index.shards[entry.shardIndex];
  const componentOffset = entry.rowIndex * index.manifest.dimension;
  return dotFloat32(query, shard, componentOffset);
}

export function scoreEvidenceDocumentViews(index, { queryVector, documents } = {}) {
  check(index?.manifest && index?.entries instanceof Map && Array.isArray(documents),
    "evidence_vector_score_input_invalid");
  const query = normalizedQueryVector(queryVector, index.manifest.dimension);
  return Object.freeze(documents.map((document) => {
    check(Array.isArray(document?.views) && document.views.length === 2,
      "evidence_document_views_invalid");
    const scores = document.views.map((view) => {
      check(HEX_64.test(String(view?.textSha256 || "")), "evidence_document_view_hash_invalid");
      return scoreView(index, query, view.textSha256);
    });
    return Math.max(scores[0], scores[1]);
  }));
}

export function buildEvidenceSurfaceK256({
  index,
  queryVector,
  documents,
  candidates,
  lexicalQueue,
  candidateLimit = DEFAULT_K,
} = {}) {
  check(Array.isArray(candidates) && Array.isArray(lexicalQueue)
    && candidates.length === documents?.length
    && lexicalQueue.length === candidates.length,
  "evidence_surface_candidate_scope_invalid");
  const candidateBindings = new Set(candidates.map((candidate) => candidate?.binding));
  check(candidateBindings.size === candidates.length
    && lexicalQueue.every((candidate) => candidateBindings.has(candidate?.binding)),
  "evidence_surface_candidate_binding_invalid");
  const scores = scoreEvidenceDocumentViews(index, { queryVector, documents });
  const denseQueue = completeDenseQueue(candidates, scores);
  const fusedQueue = roundRobinLexicalDense(lexicalQueue, denseQueue, candidateLimit);
  return Object.freeze({ scores, denseQueue, fusedQueue });
}
