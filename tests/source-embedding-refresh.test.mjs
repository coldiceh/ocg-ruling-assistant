import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_INPUT_CONTRACT,
  EMBEDDING_INPUT_CONTRACT_SHA256,
  EMBEDDING_MODEL,
  planEmbeddingRefresh,
  runEmbeddingRefresh,
  validateDenseInputs,
} from "../scripts/refresh-gemini-source-embeddings.mjs";
import { createLocalEvidencePreprocessCache, sha256 } from "../scripts/lib/evidence-preprocess-cache.mjs";

function embeddingInput(label) {
  return `title: ${label} | text: ${label} body`;
}

function rule(label) {
  const text = embeddingInput(label);
  return {
    sourceKind: "rule",
    denseUnitId: `rule:${label}`,
    sourceId: `source:${label}`,
    sourceCanonicalSha256: sha256(`${label}:source`),
    offsetEncoding: "utf16",
    start: 0,
    end: label.length + 5,
    embeddingInput: text,
    embeddingInputSha256: sha256(text),
    readingUnitKeys: [`unit:${label}`],
  };
}

function qa(label) {
  const text = embeddingInput(label);
  return {
    sourceKind: "qa",
    denseUnitId: `qa:${label}`,
    sourceId: `qa-source:${label}`,
    sourceCanonicalSha256: sha256(`${label}:source`),
    embeddingInput: text,
    embeddingInputSha256: sha256(text),
  };
}

function vector(value) {
  return Array.from({ length: EMBEDDING_DIMENSION }, () => value);
}

function vectorBytes(vectors) {
  const bytes = Buffer.alloc(vectors.length * EMBEDDING_DIMENSION * 4);
  vectors.forEach((row, rowIndex) => row.forEach((value, column) => bytes.writeFloatLE(value, (rowIndex * EMBEDDING_DIMENSION + column) * 4)));
  return bytes;
}

async function writeIndex(root, kind, rows, vectors) {
  const directory = join(root, `${kind}-embedding-v1`);
  await mkdir(directory, { recursive: true });
  const bytes = vectorBytes(vectors);
  const shard = { index: 0, file: "evidence-vectors-000.f32", rowCount: rows.length, byteLength: bytes.length, sha256: sha256(bytes) };
  const hashes = rows.map((row) => row.embeddingInputSha256);
  const manifest = {
    schemaVersion: 1,
    kind: "evidence-vector-index",
    encoding: "raw-little-endian-float32",
    dataRevision: sha256(`${kind}:old`),
    model: { id: EMBEDDING_MODEL, revision: EMBEDDING_MODEL },
    dimension: EMBEDDING_DIMENSION,
    inputContract: EMBEDDING_INPUT_CONTRACT,
    inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
    orderedContentHashes: hashes,
    orderedContentHashesSha256: sha256(JSON.stringify(hashes)),
    uniqueContentCount: rows.length,
    entries: rows.map((row, rowIndex) => ({ textSha256: row.embeddingInputSha256, shardIndex: 0, rowIndex })),
    shards: [shard],
    vectorByteLength: bytes.length,
    shardSetSha256: sha256(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: shard.sha256 }])),
  };
  await writeFile(join(directory, shard.file), bytes);
  await writeFile(join(directory, "evidence-vector-index.json"), JSON.stringify(manifest));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "embedding-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, "data");
  const outDir = join(directory, "staging");
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  return { directory, dataDir, outDir, cache };
}

test("input binding rejects changed embedding text and invalid rule offsets", () => {
  const good = rule("a");
  assert.throws(() => validateDenseInputs({ schemaVersion: 1, rule: [{ ...good, embeddingInput: "changed" }], qa: [] }), /binding_invalid/u);
  assert.throws(() => validateDenseInputs({ schemaVersion: 1, rule: [{ ...good, start: good.end }], qa: [] }), /locator_invalid/u);
});

test("order/revision-only changes rebuild exact rows without an embedding call", async (t) => {
  const { dataDir, outDir, cache } = await fixture(t);
  const a = rule("a");
  const b = rule("b");
  const q = qa("q");
  await writeIndex(dataDir, "rule", [a, b], [vector(1), vector(2)]);
  await writeIndex(dataDir, "qa", [q], [vector(3)]);
  const denseInputs = validateDenseInputs({ schemaVersion: 1, rule: [b, a], qa: [q] });
  let calls = 0;
  const result = await runEmbeddingRefresh({
    denseInputs,
    dataDir,
    outDir,
    cache,
    execute: true,
    embedBatch: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(result.report.collections.rule.generationMisses, 0);
  const manifest = JSON.parse(await readFile(join(outDir, "rule-embedding-v1", "evidence-vector-index.json"), "utf8"));
  assert.deepEqual(manifest.orderedContentHashes, [b.embeddingInputSha256, a.embeddingInputSha256]);
  assert.notEqual(manifest.dataRevision, sha256("rule:old"));
  const bytes = await readFile(join(outDir, "rule-embedding-v1", "evidence-vectors-000.f32"));
  assert.equal(bytes.readFloatLE(0), 2);
  assert.equal(bytes.readFloatLE(EMBEDDING_DIMENSION * 4), 1);
});

test("dry-run reports only true hash misses and execute generates just those misses under the shared ledger", async (t) => {
  const { directory, dataDir, outDir, cache } = await fixture(t);
  const a = rule("a");
  const c = rule("c");
  const q = qa("q");
  await writeIndex(dataDir, "rule", [a], [vector(1)]);
  await writeIndex(dataDir, "qa", [q], [vector(3)]);
  const denseInputs = validateDenseInputs({ schemaVersion: 1, rule: [a, c], qa: [q] });
  const dry = await runEmbeddingRefresh({ denseInputs, dataDir, outDir, cache, execute: false });
  assert.equal(dry.report.collections.rule.existingVectorHits, 1);
  assert.equal(dry.report.collections.rule.generationMisses, 1);
  assert.equal(dry.report.collections.rule.inputTokenEstimate.upperBound, 8192);
  assert.ok(Math.abs(dry.report.collections.rule.conservativeQuoteUsd - 0.0016384) < 1e-12);

  const ledgerPath = join(directory, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    authorizationId: "fixture-only",
    limitUsd: 6,
    spentUsd: 4.3439,
    reservedUsd: 0,
    tickets: {},
  }));
  let calls = 0;
  await runEmbeddingRefresh({
    denseInputs,
    dataDir,
    outDir,
    cache,
    execute: true,
    maxUsd: 0.01,
    ledgerPath,
    embedBatch: async (texts, profile) => {
      calls += 1;
      assert.deepEqual(texts, [c.embeddingInput]);
      assert.deepEqual(profile, { model: EMBEDDING_MODEL, dimension: EMBEDDING_DIMENSION, autoTruncate: false, requestTicket: profile.requestTicket });
      return { embeddings: [{ values: vector(4) }], usageMetadata: { promptTokenCount: 7 } };
    },
  });
  assert.equal(calls, 1);
  const manifest = JSON.parse(await readFile(join(outDir, "rule-embedding-v1", "evidence-vector-index.json"), "utf8"));
  assert.deepEqual(manifest.orderedContentHashes, [a.embeddingInputSha256, c.embeddingInputSha256]);
  const bytes = await readFile(join(outDir, "rule-embedding-v1", "evidence-vectors-000.f32"));
  assert.equal(bytes.readFloatLE(0), 1);
  assert.equal(bytes.readFloatLE(EMBEDDING_DIMENSION * 4), 4);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.reservedUsd, 0);
  assert.ok(Math.abs(ledger.spentUsd - (4.3439 + 7 * 0.20 / 1_000_000)) < 1e-12);

  const replay = await planEmbeddingRefresh({ denseInputs, dataDir, cache });
  assert.equal(replay.rule.rows.find((row) => row.item.embeddingInputSha256 === c.embeddingInputSha256).state, "cache_hit");
});

test("busy dense claims stop before a provider call and release claims acquired by this worker", async (t) => {
  const { dataDir, outDir, cache: backing } = await fixture(t);
  const a = rule("a");
  const c = rule("c");
  const d = rule("d");
  const q = qa("q");
  await writeIndex(dataDir, "rule", [a], [vector(1)]);
  await writeIndex(dataDir, "qa", [q], [vector(3)]);
  const cache = {
    ...backing,
    claim: async (kind, key, ticket) => key === sha256([
      EMBEDDING_MODEL,
      EMBEDDING_DIMENSION,
      EMBEDDING_INPUT_CONTRACT_SHA256,
      d.embeddingInputSha256,
    ].join("\u0000")) ? { status: "busy" } : backing.claim(kind, key, ticket),
  };
  let calls = 0;
  await assert.rejects(runEmbeddingRefresh({
    denseInputs: validateDenseInputs({ schemaVersion: 1, rule: [a, c, d], qa: [q] }),
    dataDir,
    outDir,
    cache,
    execute: true,
    maxUsd: 0.01,
    ledgerPath: join(dataDir, "unused-ledger.json"),
    embedBatch: async () => { calls += 1; },
  }), (error) => error?.exitCode === 3 && /claim_busy/u.test(error.message));
  assert.equal(calls, 0);
  const cPlan = await planEmbeddingRefresh({
    denseInputs: validateDenseInputs({ schemaVersion: 1, rule: [a, c], qa: [q] }),
    dataDir,
    cache: backing,
  });
  const cRow = cPlan.rule.rows.find((row) => row.item.embeddingInputSha256 === c.embeddingInputSha256);
  assert.equal((await backing.claim("dense", cRow.key, "after-busy")).status, "claimed");
  await backing.releaseClaim("dense", cRow.key, "after-busy");
});

test("old vector reuse rejects a shard whose bytes no longer match its manifest", async (t) => {
  const { dataDir, cache } = await fixture(t);
  const a = rule("a");
  const q = qa("q");
  await writeIndex(dataDir, "rule", [a], [vector(1)]);
  await writeIndex(dataDir, "qa", [q], [vector(3)]);
  const shardPath = join(dataDir, "rule-embedding-v1", "evidence-vectors-000.f32");
  const bytes = await readFile(shardPath);
  bytes[0] ^= 0xff;
  await writeFile(shardPath, bytes);
  await assert.rejects(planEmbeddingRefresh({
    denseInputs: validateDenseInputs({ schemaVersion: 1, rule: [a], qa: [q] }),
    dataDir,
    cache,
  }), /embedding_shard_binding_invalid/u);
});

test("a saved batch response is replayed per input after interruption without another embedding call", async (t) => {
  const { directory, dataDir, outDir, cache: backing } = await fixture(t);
  const a = rule("a");
  const c = rule("c");
  const q = qa("q");
  await writeIndex(dataDir, "rule", [a], [vector(1)]);
  await writeIndex(dataDir, "qa", [q], [vector(3)]);
  const denseInputs = validateDenseInputs({ schemaVersion: 1, rule: [a, c], qa: [q] });
  const ledgerPath = join(directory, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    authorizationId: "fixture-only",
    limitUsd: 6,
    spentUsd: 4.3439,
    reservedUsd: 0,
    tickets: {},
  }));
  let interruptOnce = true;
  const interruptedCache = {
    ...backing,
    writeResult: async (...args) => {
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error("fixture_interruption_after_raw");
      }
      return backing.writeResult(...args);
    },
  };
  let calls = 0;
  await assert.rejects(runEmbeddingRefresh({
    denseInputs,
    dataDir,
    outDir,
    cache: interruptedCache,
    execute: true,
    maxUsd: 0.01,
    ledgerPath,
    embedBatch: async () => {
      calls += 1;
      return { embeddings: [{ values: vector(4) }], usageMetadata: { promptTokenCount: 7 } };
    },
  }), /fixture_interruption_after_raw/u);
  assert.equal(calls, 1);
  const interruptedLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.ok(interruptedLedger.reservedUsd > 0);
  assert.equal(interruptedLedger.spentUsd, 4.3439);

  await runEmbeddingRefresh({ denseInputs, dataDir, outDir, cache: backing, execute: true, ledgerPath });
  assert.equal(calls, 1);
  const settledLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(settledLedger.reservedUsd, 0);
  assert.ok(settledLedger.spentUsd > 4.3439);
  const manifest = JSON.parse(await readFile(join(outDir, "rule-embedding-v1", "evidence-vector-index.json"), "utf8"));
  assert.deepEqual(manifest.orderedContentHashes, [a.embeddingInputSha256, c.embeddingInputSha256]);
});

test("missing embedding usage keeps the reservation while the saved vector remains reusable", async (t) => {
  const { directory, dataDir, outDir, cache } = await fixture(t);
  const a = rule("a");
  const c = rule("c");
  const q = qa("q");
  await writeIndex(dataDir, "rule", [a], [vector(1)]);
  await writeIndex(dataDir, "qa", [q], [vector(3)]);
  const denseInputs = validateDenseInputs({ schemaVersion: 1, rule: [a, c], qa: [q] });
  const ledgerPath = join(directory, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    authorizationId: "fixture-only",
    limitUsd: 6,
    spentUsd: 4.3439,
    reservedUsd: 0,
    tickets: {},
  }));
  await runEmbeddingRefresh({
    denseInputs,
    dataDir,
    outDir,
    cache,
    execute: true,
    maxUsd: 0.01,
    ledgerPath,
    embedBatch: async () => ({ embeddings: [{ values: vector(4) }] }),
  });
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.spentUsd, 4.3439);
  assert.ok(ledger.reservedUsd > 0);
  const replay = await planEmbeddingRefresh({ denseInputs, dataDir, cache });
  assert.equal(replay.rule.rows.find((row) => row.item.embeddingInputSha256 === c.embeddingInputSha256).state, "cache_hit");
});
