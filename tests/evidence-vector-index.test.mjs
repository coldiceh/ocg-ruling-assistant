import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildEvidenceSurfaceK256,
  loadEvidenceVectorIndex,
  scoreEvidenceDocumentViews,
} from "../backend/evidenceVectorIndex.mjs";
import { exportEvidenceVectorIndex } from "../scripts/export-evidence-vector-index.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const REVISION = "revision-test";
const CONTRACT_HASH = "a".repeat(64);

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function writeNpy(file, rows) {
  const dimension = rows[0].length;
  const headerText = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows.length}, ${dimension}), }`;
  const headerLength = Math.ceil((10 + headerText.length + 1) / 16) * 16 - 10;
  const header = Buffer.from(`${headerText}${" ".repeat(headerLength - headerText.length - 1)}\n`, "ascii");
  const prefix = Buffer.alloc(10);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]).copy(prefix);
  prefix[6] = 1;
  prefix[7] = 0;
  prefix.writeUInt16LE(header.length, 8);
  const body = Buffer.alloc(rows.length * dimension * 4);
  rows.flat().forEach((value, index) => body.writeFloatLE(value, index * 4));
  fs.writeFileSync(file, Buffer.concat([prefix, header, body]));
}

test("exports only required content rows and preserves raw float32 bytes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-vector-index-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hashes = ["view-a", "view-b", "unused"].map(hash);
  const documentsFile = path.join(root, "documents.json");
  const sourceManifestFile = path.join(root, "source-manifest.json");
  const sourceVectorsFile = path.join(root, "source.npy");
  const contractFile = path.join(root, "contract.json");
  const outputDirectory = path.join(root, "output");
  writeJson(documentsFile, { documents: [{ views: [
    { textSha256: hashes[1] }, { textSha256: hashes[0] },
  ] }] });
  writeJson(sourceManifestFile, { scope: {
    modelId: "Qwen/Qwen3-Embedding-0.6B", modelRevision: "model-revision",
    inputContractSha256: CONTRACT_HASH,
  }, dimension: 2, dtype: "float32", entries: {
    [hashes[0]]: { row: 0, textSha256: hashes[0], vectorSha256: hash(Buffer.from(new Float32Array([1, 0]).buffer)) },
    [hashes[1]]: { row: 1, textSha256: hashes[1], vectorSha256: hash(Buffer.from(new Float32Array([0, 1]).buffer)) },
    [hashes[2]]: { row: 2, textSha256: hashes[2], vectorSha256: hash(Buffer.from(new Float32Array([-1, 0]).buffer)) },
  } });
  writeNpy(sourceVectorsFile, [[1, 0], [0, 1], [-1, 0]]);
  writeJson(contractFile, {
    model: { id: "Qwen/Qwen3-Embedding-0.6B", revision: "model-revision" },
    inputContract: { vectorDtype: "float32", similarity: "exact_cosine_matrix_max_two_views" },
    inputContractSha256: CONTRACT_HASH,
  });

  const manifest = exportEvidenceVectorIndex({
    documentsFile, sourceManifestFile, sourceVectorsFile, embeddingContractFile: contractFile,
    dataRevision: REVISION, outputDirectory, maxShardBytes: 12, expectedUniqueContentCount: 2,
  });
  assert.deepEqual(manifest.orderedContentHashes, [hashes[1], hashes[0]]);
  assert.equal(manifest.shards.length, 2);
  assert.equal(JSON.stringify(manifest).includes("unused"), false);
  assert.equal(JSON.stringify(manifest).includes(root), false);
  assert.deepEqual([...fs.readFileSync(path.join(outputDirectory, manifest.shards[0].file))],
    [...Buffer.from(new Float32Array([0, 1]).buffer)]);

  const index = await loadEvidenceVectorIndex({ dataDir: outputDirectory, dataRevision: REVISION });
  assert.equal(index.entries.has(hashes[2]), false);

  const differentContract = JSON.parse(fs.readFileSync(contractFile, "utf8"));
  differentContract.model.revision = "different-model-revision";
  writeJson(contractFile, differentContract);
  assert.throws(() => exportEvidenceVectorIndex({
    documentsFile, sourceManifestFile, sourceVectorsFile, embeddingContractFile: contractFile,
    dataRevision: REVISION, outputDirectory: path.join(root, "mismatched-output"),
  }), /evidence_vector_source_scope_changed/u);
  assert.equal(fs.existsSync(path.join(root, "mismatched-output")), false);
});

test("uses max of two exact-cosine views and existing deterministic fusion order", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-vector-score-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vectors = [[0, 1], [0.8, 0.6], [1, 0], [-1, 0]];
  const hashes = vectors.map((_, index) => hash(`view-${index}`));
  const bytes = Buffer.alloc(vectors.length * 8);
  vectors.flat().forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  fs.writeFileSync(path.join(root, "evidence-vectors-000.f32"), bytes);
  writeJson(path.join(root, "evidence-vector-index.json"), {
    schemaVersion: 1,
    kind: "evidence-vector-index",
    encoding: "raw-little-endian-float32",
    model: { id: "model", revision: "revision" },
    inputContractSha256: CONTRACT_HASH,
    dataRevision: REVISION,
    dimension: 2,
    orderedContentHashes: hashes,
    orderedContentHashesSha256: hash(JSON.stringify(hashes)),
    entries: hashes.map((textSha256, rowIndex) => ({ textSha256, shardIndex: 0, rowIndex })),
    shards: [{ index: 0, file: "evidence-vectors-000.f32", rowCount: 4,
      byteLength: bytes.length, sha256: hash(bytes) }],
    uniqueContentCount: 4,
    vectorByteLength: bytes.length,
    shardSetSha256: hash(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: hash(bytes) }])),
  });
  const index = await loadEvidenceVectorIndex({ dataDir: root, dataRevision: REVISION });
  const documents = [
    { views: [{ textSha256: hashes[0] }, { textSha256: hashes[1] }] },
    { views: [{ textSha256: hashes[2] }, { textSha256: hashes[3] }] },
  ];
  const scores = scoreEvidenceDocumentViews(index, { queryVector: [1, 0], documents });
  assert.deepEqual(scores, [Math.fround(0.8), 1]);

  const candidates = [{ binding: "a" }, { binding: "b" }];
  const result = buildEvidenceSurfaceK256({
    index,
    queryVector: [1, 0],
    documents,
    candidates,
    lexicalQueue: [candidates[0], candidates[1]],
    candidateLimit: 2,
  });
  assert.deepEqual(result.denseQueue.map((item) => item.binding), ["b", "a"]);
  assert.deepEqual(result.fusedQueue.map((item) => item.binding), ["a", "b"]);

  const tiedCandidates = [{ binding: "z" }, { binding: "a" }];
  const tied = buildEvidenceSurfaceK256({
    index,
    queryVector: [1, 0],
    documents: [documents[1], documents[1]],
    candidates: tiedCandidates,
    lexicalQueue: tiedCandidates,
    candidateLimit: 2,
  });
  assert.deepEqual(tied.denseQueue.map((item) => item.binding), ["a", "z"]);
});

test("accumulates float32 components without losing a small contribution to float32 rounding", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-vector-precision-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const values = new Float32Array([Math.SQRT1_2, 2 ** -30, -Math.SQRT1_2, 2 ** -30]);
  const bytes = Buffer.from(values.buffer);
  const textSha256 = hash("precision-view");
  const descriptor = { index: 0, file: "vectors.f32", rowCount: 1, byteLength: bytes.length, sha256: hash(bytes) };
  const manifest = {
    schemaVersion: 1, kind: "evidence-vector-index", encoding: "raw-little-endian-float32",
    model: { id: "model", revision: "revision" }, inputContractSha256: CONTRACT_HASH,
    dataRevision: REVISION, dimension: 4, uniqueContentCount: 1,
    orderedContentHashes: [textSha256], orderedContentHashesSha256: hash(JSON.stringify([textSha256])),
    entries: [{ textSha256, shardIndex: 0, rowIndex: 0 }], shards: [descriptor],
    vectorByteLength: bytes.length,
    shardSetSha256: hash(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: hash(bytes) }])),
  };
  fs.writeFileSync(path.join(root, "vectors.f32"), bytes);
  writeJson(path.join(root, "evidence-vector-index.json"), manifest);
  const index = await loadEvidenceVectorIndex({ dataDir: root });
  const query = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  const [score] = scoreEvidenceDocumentViews(index, { queryVector: query,
    documents: [{ views: [{ textSha256 }, { textSha256 }] }] });
  // Opposite first/third terms cancel exactly; two half-sized small terms remain.
  assert.equal(score, 2 ** -30);
  const legacy = values.reduce((sum, value, i) => Math.fround(sum + Math.fround(query[i] * value)), 0);
  assert.equal(legacy, 2 ** -31);

  bytes.writeFloatLE(Number.NaN, 0);
  fs.writeFileSync(path.join(root, "vectors.f32"), bytes);
  manifest.shards[0].sha256 = hash(bytes);
  manifest.shardSetSha256 = hash(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: hash(bytes) }]));
  writeJson(path.join(root, "evidence-vector-index.json"), manifest);
  await assert.rejects(loadEvidenceVectorIndex({ dataDir: root }), /evidence_document_vector_nonfinite/u);
});
