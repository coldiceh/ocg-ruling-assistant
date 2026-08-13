import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildRagDataRevisionManifest,
  createRagDataSourceDescriptor,
  getTrustedRagDataRevision,
  RAG_DATA_REVISION_MANIFEST_FILE,
} from "../backend/ragDataRevisionManifest.mjs";
import {
  canonicalJsonBytes,
  loadRawGenericRuntimeBundle,
  recomputeBundleRevision,
  RAG_RUNTIME_AUXILIARY_ARTIFACTS,
  RAG_RUNTIME_BUNDLE_ABI,
  RAG_RUNTIME_BUNDLE_COMPILER_ABI,
  RAG_RUNTIME_BUNDLE_DIRECTORY,
  RAG_RUNTIME_BUNDLE_MANIFEST_FILE,
  RAG_RUNTIME_BUNDLE_SCHEMA_VERSION,
  RAG_RUNTIME_CORPORA,
  sha256,
} from "../backend/rawGenericRuntimeBundle.mjs";

test("raw-only runtime loader authenticates corpora without hydrating the legacy alias index", async () => {
  const fixture = await makeRuntimeFixture();
  try {
    const loaded = await loadRawGenericRuntimeBundle({ dataDir: fixture.dataDir });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.source, "rag_runtime_bundle");
    assert.deepEqual(loaded.data, fixture.data);
    assert.equal(loaded.dataRevision, fixture.revisionManifest.revision);
    assert.equal(getTrustedRagDataRevision(loaded.data), fixture.revisionManifest.revision);
    assert.equal(Object.hasOwn(loaded, "artifacts"), false);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("raw-only runtime loader fails closed on corpus or auxiliary artifact byte changes", async () => {
  for (const target of [RAG_RUNTIME_CORPORA[1].file, RAG_RUNTIME_AUXILIARY_ARTIFACTS[0].file]) {
    const fixture = await makeRuntimeFixture();
    try {
      const path = join(fixture.bundleDir, target);
      const bytes = await readFile(path);
      bytes[Math.floor(bytes.length / 2)] ^= 1;
      await writeFile(path, bytes);
      const loaded = await loadRawGenericRuntimeBundle({ dataDir: fixture.dataDir });
      assert.equal(loaded.ok, false);
      assert.equal(loaded.data, null);
      assert.match(loaded.reason, /^(?:corpus|artifact)_compressed_hash_mismatch$/u);
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  }
});

test("raw-only runtime loader rejects a stale source-revision binding", async () => {
  const fixture = await makeRuntimeFixture();
  try {
    const stale = {
      ...fixture.revisionManifest,
      revision: "0".repeat(64),
      canonicalCorpusDigest: "0".repeat(64),
    };
    await writeFile(
      join(fixture.dataDir, RAG_DATA_REVISION_MANIFEST_FILE),
      `${JSON.stringify(stale, null, 2)}\n`,
      "utf8",
    );
    const loaded = await loadRawGenericRuntimeBundle({ dataDir: fixture.dataDir });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.data, null);
    assert.equal(loaded.reason, "source_revision_binding_mismatch");
    assert.ok(loaded.reasons.includes("data_revision_mismatch"));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("raw-generic data loading closure cannot reach the legacy extractor or semantic components", async () => {
  const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "backend");
  const graph = await localImportClosure(backendDir, "rawGenericDataStore.mjs");
  const forbidden = [
    "ragRuntimeBundle.mjs",
    "ragCardExtractor.mjs",
    "ragEvidenceRetriever.mjs",
    "officialQaMatcher.mjs",
    "rulebookPassageRetriever.mjs",
    "operationLegalityAnalyzer.mjs",
    "ruleScenarioCompiler.mjs",
  ];
  for (const name of forbidden) {
    assert.equal(graph.has(name), false, `raw-generic data closure reached ${name}`);
  }
  assert.equal(graph.has("rawGenericRuntimeBundle.mjs"), true);
  assert.equal(graph.has("ragCardAliasRuntimeContract.mjs"), true);
});

test("runtime bundle compiler closure cannot reach legacy extraction or ruling semantics", async () => {
  const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "backend");
  const graph = await localImportClosure(backendDir, "ragRuntimeBundleCompiler.mjs");
  const forbidden = [
    "ragRuntimeBundle.mjs",
    "ragCardExtractor.mjs",
    "ragEvidenceRetriever.mjs",
    "officialQaMatcher.mjs",
    "rulebookPassageRetriever.mjs",
    "operationLegalityAnalyzer.mjs",
    "ruleScenarioCompiler.mjs",
    "legacyLuaSemanticClient.mjs",
    "legacyLuaSemanticProduction.mjs",
  ];
  for (const name of forbidden) {
    assert.equal(graph.has(name), false, `runtime bundle compiler closure reached ${name}`);
  }
  assert.equal(graph.has("ragCardAliasRuntimeCompiler.mjs"), true);
  assert.equal(graph.has("rawGenericRuntimeBundle.mjs"), true);
});

test("runtime bundle build and check scripts stay inside the neutral data boundary", async () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const graph = await projectImportClosure(projectRoot, [
    "scripts/build-rag-data-revision-manifest.mjs",
    "scripts/build-rag-runtime-bundle.mjs",
    "scripts/check-rag-runtime-bundle.mjs",
  ]);
  const forbidden = [
    "backend/ragEvidenceRetriever.mjs",
    "backend/ragCardExtractor.mjs",
    "backend/ragRuntimeBundle.mjs",
    "backend/officialQaMatcher.mjs",
    "backend/rulebookPassageRetriever.mjs",
    "backend/operationLegalityAnalyzer.mjs",
    "backend/ruleScenarioCompiler.mjs",
    "backend/legacyLuaSemanticClient.mjs",
    "backend/legacyLuaSemanticProduction.mjs",
  ];
  for (const path of forbidden) {
    assert.equal(graph.has(path), false, `runtime build/check scripts reached ${path}`);
  }
  assert.equal(graph.has("backend/rawGenericDataStore.mjs"), true);
  assert.equal(graph.has("backend/ragRuntimeBundleCompiler.mjs"), true);
  assert.equal(graph.has("backend/ragCardAliasRuntimeCompiler.mjs"), true);
});

async function makeRuntimeFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "raw-generic-runtime-"));
  const bundleDir = join(dataDir, RAG_RUNTIME_BUNDLE_DIRECTORY);
  await mkdir(bundleDir, { recursive: true });
  const data = {
    cards: [{ id: "101", name: "匿名卡", aliases: ["匿名卡"], effectText: "匿名卡文。" }],
    records: [{ id: "record-1", recordType: "rule-doc", text: "匿名资料。" }],
    qaRecords: [],
  };
  const sourcePayloads = new Map([
    ["cards.json", { records: data.cards }],
    ["rulings.json", { records: data.records }],
    ["qa-index.json", { records: [] }],
    ["evidence-index.json", { records: [] }],
    ["ocg-rule-corpus.json", { records: [] }],
    ["official-responses.json", { records: [] }],
  ]);
  const sourceEntries = [...sourcePayloads].map(([path, payload]) => {
    const raw = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    return {
      descriptor: createRagDataSourceDescriptor(path, raw),
      count: payload.records.length,
    };
  });
  const revisionManifest = buildRagDataRevisionManifest({
    data,
    sources: sourceEntries.map(({ descriptor }) => descriptor),
  });
  await writeFile(
    join(dataDir, RAG_DATA_REVISION_MANIFEST_FILE),
    `${JSON.stringify(revisionManifest, null, 2)}\n`,
    "utf8",
  );

  const corpora = {};
  for (const corpus of RAG_RUNTIME_CORPORA) {
    const descriptor = encodedDescriptor(corpus, data[corpus.key], data[corpus.key].length);
    corpora[corpus.key] = descriptor.metadata;
    await writeFile(join(bundleDir, corpus.file), descriptor.compressed);
  }
  const artifact = RAG_RUNTIME_AUXILIARY_ARTIFACTS[0];
  const opaqueAliasArtifact = {
    schemaVersion: artifact.schemaVersion,
    kind: "opaque-unused-artifact",
    compilerAbi: artifact.compilerAbi,
    cardCount: data.cards.length,
  };
  const encodedArtifact = encodedDescriptor(artifact, opaqueAliasArtifact, data.cards.length);
  await writeFile(join(bundleDir, artifact.file), encodedArtifact.compressed);

  const withoutRevision = {
    schemaVersion: RAG_RUNTIME_BUNDLE_SCHEMA_VERSION,
    kind: "rag-runtime-bundle",
    compilerAbi: RAG_RUNTIME_BUNDLE_COMPILER_ABI,
    runtimeAbi: RAG_RUNTIME_BUNDLE_ABI,
    canonicalizationAbi: revisionManifest.canonicalizationAbi,
    compression: { algorithm: "brotli", quality: 5 },
    dataRevision: revisionManifest.revision,
    sourceSetDigest: revisionManifest.sourceSetDigest,
    sources: sourceEntries.map(({ descriptor, count }) => ({ ...descriptor, count })),
    counts: {
      cards: data.cards.length,
      records: data.records.length,
      qaRecords: data.qaRecords.length,
    },
    corpora,
    artifacts: { cardAliasIndex: encodedArtifact.metadata },
  };
  const manifest = { ...withoutRevision, bundleRevision: recomputeBundleRevision(withoutRevision) };
  await writeFile(
    join(bundleDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { dataDir, bundleDir, data, revisionManifest, manifest };
}

function encodedDescriptor(definition, value, count) {
  const canonical = canonicalJsonBytes(value);
  const compressed = brotliCompressSync(canonical);
  return {
    compressed,
    metadata: {
      key: definition.key,
      file: definition.file,
      encoding: "br",
      ...(definition.schemaVersion ? { schemaVersion: definition.schemaVersion } : {}),
      ...(definition.compilerAbi ? { compilerAbi: definition.compilerAbi } : {}),
      bytes: compressed.byteLength,
      sha256: sha256(compressed),
      canonicalBytes: canonical.byteLength,
      canonicalSha256: sha256(canonical),
      count,
    },
  };
}

async function localImportClosure(backendDir, entryName) {
  const visited = new Set();
  const pending = [entryName];
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const source = await readFile(join(backendDir, name), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\(\s*)["'](\.\/[^"']+\.mjs)["']/gu)) {
      const child = match[1].slice(2);
      if (!visited.has(child)) pending.push(child);
    }
  }
  return visited;
}

async function projectImportClosure(projectRoot, entryPaths) {
  const visited = new Set();
  const pending = entryPaths.map((path) => resolve(projectRoot, path));
  while (pending.length) {
    const path = pending.pop();
    const projectPath = relative(projectRoot, path).replaceAll("\\", "/");
    if (visited.has(projectPath)) continue;
    visited.add(projectPath);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\(\s*)["'](\.\.?\/[^"']+\.mjs)["']/gu)) {
      const child = resolve(dirname(path), match[1]);
      const childProjectPath = relative(projectRoot, child).replaceAll("\\", "/");
      if (!childProjectPath.startsWith("../") && !visited.has(childProjectPath)) pending.push(child);
    }
  }
  return visited;
}
