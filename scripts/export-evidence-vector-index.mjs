import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEX_64 = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_SHARD_BYTES = 48_000_000;

function check(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function readNpyHeader(file) {
  const handle = fs.openSync(file, "r");
  try {
    const prefix = Buffer.alloc(12);
    check(fs.readSync(handle, prefix, 0, prefix.length, 0) === prefix.length,
      "evidence_vector_npy_prefix_invalid");
    check(prefix.subarray(0, 6).equals(Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])),
      "evidence_vector_npy_magic_invalid");
    const major = prefix[6];
    const headerLengthBytes = major === 1 ? 2 : 4;
    const headerLength = headerLengthBytes === 2 ? prefix.readUInt16LE(8) : prefix.readUInt32LE(8);
    const dataOffset = 8 + headerLengthBytes + headerLength;
    const header = Buffer.alloc(headerLength);
    check(fs.readSync(handle, header, 0, headerLength, 8 + headerLengthBytes) === headerLength,
      "evidence_vector_npy_header_invalid");
    const text = header.toString("ascii");
    const descriptor = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/u.exec(text)?.[1];
    const fortran = /['"]fortran_order['"]\s*:\s*(True|False)/u.exec(text)?.[1];
    const shapeText = /['"]shape['"]\s*:\s*\(([^)]+)\)/u.exec(text)?.[1];
    const shape = shapeText?.split(",").map((item) => item.trim()).filter(Boolean).map(Number);
    check(descriptor === "<f4" && fortran === "False"
      && shape?.length === 2 && shape.every(Number.isSafeInteger),
    "evidence_vector_npy_contract_invalid");
    return { handle, dataOffset, rows: shape[0], dimension: shape[1] };
  } catch (error) {
    fs.closeSync(handle);
    throw error;
  }
}

function orderedRequiredHashes(documents) {
  check(Array.isArray(documents) && documents.length > 0, "evidence_vector_documents_invalid");
  const seen = new Set();
  const ordered = [];
  for (const document of documents) {
    check(Array.isArray(document?.views) && document.views.length === 2,
      "evidence_vector_document_views_invalid");
    for (const view of document.views) {
      const textSha256 = String(view?.textSha256 || "");
      check(HEX_64.test(textSha256), "evidence_vector_text_hash_invalid");
      if (!seen.has(textSha256)) {
        seen.add(textSha256);
        ordered.push(textSha256);
      }
    }
  }
  return ordered;
}

export function exportEvidenceVectorIndex({
  documentsFile,
  sourceManifestFile,
  sourceVectorsFile,
  embeddingContractFile,
  dataRevision,
  outputDirectory,
  maxShardBytes = DEFAULT_MAX_SHARD_BYTES,
  expectedUniqueContentCount,
} = {}) {
  check(typeof dataRevision === "string" && dataRevision.length > 0,
    "evidence_vector_data_revision_required");
  check(Number.isSafeInteger(maxShardBytes) && maxShardBytes > 0 && maxShardBytes < 50_000_000,
    "evidence_vector_shard_limit_invalid");
  check(!fs.existsSync(outputDirectory), "evidence_vector_output_exists");

  const documentsValue = readJson(documentsFile);
  const documents = Array.isArray(documentsValue) ? documentsValue : documentsValue.documents;
  const orderedContentHashes = orderedRequiredHashes(documents);
  if (expectedUniqueContentCount !== undefined) {
    check(Number.isSafeInteger(expectedUniqueContentCount) && expectedUniqueContentCount > 0
      && orderedContentHashes.length === expectedUniqueContentCount,
    "evidence_vector_expected_content_count_changed");
  }
  const sourceManifest = readJson(sourceManifestFile);
  const sourceEntries = sourceManifest?.entries;
  check(sourceEntries && typeof sourceEntries === "object" && !Array.isArray(sourceEntries),
    "evidence_vector_source_manifest_invalid");
  const contract = readJson(embeddingContractFile);
  check(contract?.model?.id && contract?.model?.revision
    && contract?.inputContract?.vectorDtype === "float32"
    && contract?.inputContract?.similarity === "exact_cosine_matrix_max_two_views"
    && HEX_64.test(String(contract.inputContractSha256 || "")),
  "evidence_vector_embedding_contract_invalid");
  check(sourceManifest.scope?.modelId === contract.model.id
    && sourceManifest.scope?.modelRevision === contract.model.revision
    && sourceManifest.scope?.inputContractSha256 === contract.inputContractSha256
    && (contract.modelSnapshotSha256 === undefined
      || sourceManifest.scope?.modelSnapshotSha256 === contract.modelSnapshotSha256),
  "evidence_vector_source_scope_changed");

  const npy = readNpyHeader(sourceVectorsFile);
  if (sourceManifest.dtype !== "float32" || sourceManifest.dimension !== npy.dimension) {
    fs.closeSync(npy.handle);
    throw new Error("evidence_vector_source_dtype_or_dimension_changed");
  }
  const rowBytes = npy.dimension * Float32Array.BYTES_PER_ELEMENT;
  const rowsPerShard = Math.floor(maxShardBytes / rowBytes);
  check(rowsPerShard > 0, "evidence_vector_shard_too_small");
  fs.mkdirSync(outputDirectory, { recursive: false });
  const shards = [];
  const entries = [];
  try {
    for (let start = 0, shardIndex = 0; start < orderedContentHashes.length;
      start += rowsPerShard, shardIndex += 1) {
      const hashes = orderedContentHashes.slice(start, start + rowsPerShard);
      const bytes = Buffer.allocUnsafe(hashes.length * rowBytes);
      for (let rowIndex = 0; rowIndex < hashes.length; rowIndex += 1) {
        const textSha256 = hashes[rowIndex];
        const source = sourceEntries[textSha256];
        check(source && Number.isSafeInteger(source.row) && source.row >= 0 && source.row < npy.rows,
          "evidence_vector_source_row_missing");
        check(source.textSha256 === textSha256 && HEX_64.test(String(source.vectorSha256 || "")),
          "evidence_vector_source_binding_invalid");
        check(fs.readSync(npy.handle, bytes, rowIndex * rowBytes, rowBytes,
          npy.dataOffset + source.row * rowBytes) === rowBytes,
        "evidence_vector_source_row_read_failed");
        check(sha256(bytes.subarray(rowIndex * rowBytes, (rowIndex + 1) * rowBytes))
          === source.vectorSha256, "evidence_vector_source_row_hash_changed");
        entries.push({ textSha256, shardIndex, rowIndex });
      }
      const file = `evidence-vectors-${String(shardIndex).padStart(3, "0")}.f32`;
      fs.writeFileSync(path.join(outputDirectory, file), bytes, { flag: "wx" });
      shards.push({
        index: shardIndex,
        file,
        rowCount: hashes.length,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
  } finally {
    fs.closeSync(npy.handle);
  }

  const manifest = {
    schemaVersion: 1,
    kind: "evidence-vector-index",
    encoding: "raw-little-endian-float32",
    model: contract.model,
    ...(sourceManifest.scope.modelSnapshotSha256
      ? { modelSnapshotSha256: sourceManifest.scope.modelSnapshotSha256 } : {}),
    inputContract: contract.inputContract,
    inputContractSha256: contract.inputContractSha256,
    dataRevision,
    dimension: npy.dimension,
    documentCount: documents.length,
    uniqueContentCount: orderedContentHashes.length,
    orderedContentHashes,
    orderedContentHashesSha256: sha256(JSON.stringify(orderedContentHashes)),
    entries,
    shards,
    vectorByteLength: shards.reduce((sum, shard) => sum + shard.byteLength, 0),
    shardSetSha256: sha256(JSON.stringify(shards.map((shard) => ({
      index: shard.index,
      byteLength: shard.byteLength,
      sha256: shard.sha256,
    })))),
  };
  writeJson(path.join(outputDirectory, "evidence-vector-index.json"), manifest);
  return manifest;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    check(key?.startsWith("--") && argv[index + 1], "evidence_vector_cli_argument_invalid");
    parsed[key.slice(2)] = argv[index + 1];
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = exportEvidenceVectorIndex({
    documentsFile: args.documents,
    sourceManifestFile: args["source-manifest"],
    sourceVectorsFile: args["source-vectors"],
    embeddingContractFile: args["embedding-contract"],
    dataRevision: args["data-revision"],
    outputDirectory: args["output-dir"],
    ...(args["max-shard-bytes"] ? { maxShardBytes: Number(args["max-shard-bytes"]) } : {}),
    ...(args["expected-content-count"]
      ? { expectedUniqueContentCount: Number(args["expected-content-count"]) } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    status: "COMPLETE",
    documentCount: manifest.documentCount,
    uniqueContentCount: manifest.uniqueContentCount,
    shardCount: manifest.shards.length,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
