import assert from "node:assert/strict";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRagData } from "../backend/ragEvidenceRetriever.mjs";
import {
  buildRagRuntimeBundle,
  checkRagRuntimeBundle,
} from "../backend/ragRuntimeBundleCompiler.mjs";
import {
  canonicalJsonBytes,
  loadRagRuntimeBundle,
  recomputeBundleRevision,
  RAG_RUNTIME_AUXILIARY_ARTIFACTS,
  RAG_RUNTIME_BUNDLE_MANIFEST_FILE,
  RAG_RUNTIME_CORPORA,
  sha256,
} from "../backend/ragRuntimeBundle.mjs";

test("runtime loader reports a missing data directory without evaluating an invalid default path", async () => {
  const loaded = await loadRagRuntimeBundle();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, "data_dir_missing");
  assert.equal(loaded.data, null);
});

test("runtime bundle is byte-exact deterministic and preserves all legacy normalized corpora", async () => {
  const fixture = await createFixture();
  try {
    const outputA = join(fixture.dataDir, "runtime-a");
    const outputB = join(fixture.dataDir, "runtime-b");
    const first = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir: outputA,
      loadNormalizedData: loadRagData,
    });
    const second = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir: outputB,
      loadNormalizedData: loadRagData,
    });

    assert.deepEqual(second.manifest, first.manifest);
    assert.equal(
      await readFile(join(outputB, RAG_RUNTIME_BUNDLE_MANIFEST_FILE), "utf8"),
      await readFile(join(outputA, RAG_RUNTIME_BUNDLE_MANIFEST_FILE), "utf8"),
    );
    for (const corpus of RAG_RUNTIME_CORPORA) {
      assert.deepEqual(
        await readFile(join(outputB, corpus.file)),
        await readFile(join(outputA, corpus.file)),
      );
    }
    for (const artifact of RAG_RUNTIME_AUXILIARY_ARTIFACTS) {
      assert.deepEqual(
        await readFile(join(outputB, artifact.file)),
        await readFile(join(outputA, artifact.file)),
      );
    }

    const loaded = await loadRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputA,
      sourceRevisionManifest: first.revisionManifest,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.source, "rag_runtime_bundle");
    const legacy = await loadRagData(fixture.dataDir);
    assert.deepEqual(loaded.data.cards, legacy.cards);
    assert.deepEqual(loaded.data.records, legacy.records);
    assert.deepEqual(loaded.data.qaRecords, legacy.qaRecords);
    for (const corpus of RAG_RUNTIME_CORPORA) {
      assert.equal(
        loaded.manifest.corpora[corpus.key].canonicalSha256,
        sha256(canonicalJsonBytes(legacy[corpus.key])),
      );
    }

    const checked = await checkRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputA,
      loadNormalizedData: loadRagData,
    });
    assert.equal(checked.ok, true);
    assert.equal(checked.equivalent, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime bundle returns an all-or-nothing fallback signal when one corpus hash is bad", async () => {
  const fixture = await createFixture();
  try {
    const outputDir = join(fixture.dataDir, "runtime-bad-hash");
    const built = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir,
      loadNormalizedData: loadRagData,
    });
    const artifactPath = join(outputDir, RAG_RUNTIME_CORPORA[1].file);
    const artifact = await readFile(artifactPath);
    artifact[Math.floor(artifact.length / 2)] ^= 1;
    await writeFile(artifactPath, artifact);

    const loaded = await loadRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputDir,
      sourceRevisionManifest: built.revisionManifest,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.source, "legacy_raw_fallback_required");
    assert.equal(loaded.reason, "corpus_compressed_hash_mismatch");
    assert.deepEqual(loaded.reasons, ["records"]);
    assert.equal(loaded.data, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime bundle returns an all-or-nothing fallback signal when the alias artifact hash is bad", async () => {
  const fixture = await createFixture();
  try {
    const outputDir = join(fixture.dataDir, "runtime-bad-alias-hash");
    const built = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir,
      loadNormalizedData: loadRagData,
    });
    const artifactPath = join(outputDir, RAG_RUNTIME_AUXILIARY_ARTIFACTS[0].file);
    const artifact = await readFile(artifactPath);
    artifact[Math.floor(artifact.length / 2)] ^= 1;
    await writeFile(artifactPath, artifact);

    const loaded = await loadRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputDir,
      sourceRevisionManifest: built.revisionManifest,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, "artifact_compressed_hash_mismatch");
    assert.deepEqual(loaded.reasons, ["cardAliasIndex"]);
    assert.equal(loaded.data, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime bundle rejects an alias artifact ABI mismatch in its manifest", async () => {
  const fixture = await createFixture();
  try {
    const outputDir = join(fixture.dataDir, "runtime-bad-alias-abi");
    const built = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir,
      loadNormalizedData: loadRagData,
    });
    const manifestPath = join(outputDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts.cardAliasIndex.compilerAbi = "rag-card-alias-runtime-index/unsupported";
    manifest.bundleRevision = recomputeBundleRevision(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const loaded = await loadRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputDir,
      sourceRevisionManifest: built.revisionManifest,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, "bundle_manifest_invalid");
    assert.ok(loaded.reasons.includes("artifact_cardAliasIndex_compiler_abi_mismatch"));
    assert.equal(loaded.data, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime bundle fails closed when a correctly hashed alias artifact binds the wrong card identity", async () => {
  const fixture = await createFixture();
  try {
    const outputDir = join(fixture.dataDir, "runtime-bad-alias-identity");
    const built = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir,
      loadNormalizedData: loadRagData,
    });
    const artifactDefinition = RAG_RUNTIME_AUXILIARY_ARTIFACTS[0];
    const artifactPath = join(outputDir, artifactDefinition.file);
    const snapshot = JSON.parse(brotliDecompressSync(await readFile(artifactPath)).toString("utf8"));
    snapshot.cardIdentities[0] = "wrong-card-identity";
    const canonicalBytes = canonicalJsonBytes(snapshot);
    const compressed = brotliCompressSync(canonicalBytes);
    await writeFile(artifactPath, compressed);

    const manifestPath = join(outputDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    Object.assign(manifest.artifacts.cardAliasIndex, {
      bytes: compressed.byteLength,
      sha256: sha256(compressed),
      canonicalBytes: canonicalBytes.byteLength,
      canonicalSha256: sha256(canonicalBytes),
    });
    manifest.bundleRevision = recomputeBundleRevision(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const loaded = await loadRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputDir,
      sourceRevisionManifest: built.revisionManifest,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, "card_alias_index_hydration_failed");
    assert.deepEqual(loaded.reasons, ["cardAliasIndex"]);
    assert.equal(loaded.data, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime bundle rejects an unknown ABI before exposing any corpus", async () => {
  const fixture = await createFixture();
  try {
    const outputDir = join(fixture.dataDir, "runtime-bad-abi");
    const built = await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir,
      loadNormalizedData: loadRagData,
    });
    const manifestPath = join(outputDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.runtimeAbi = "rag-runtime-bundle/unsupported";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const loaded = await loadRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputDir,
      sourceRevisionManifest: built.revisionManifest,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.source, "legacy_raw_fallback_required");
    assert.equal(loaded.reason, "bundle_manifest_invalid");
    assert.ok(loaded.reasons.includes("runtime_abi_mismatch"));
    assert.equal(loaded.data, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime bundle source binding invalidates when raw synchronized data changes", async () => {
  const fixture = await createFixture();
  try {
    const outputDir = join(fixture.dataDir, "runtime-stale-source");
    await buildRagRuntimeBundle({
      dataDir: fixture.dataDir,
      outputDir,
      loadNormalizedData: loadRagData,
    });
    const cardPayload = JSON.parse(await readFile(join(fixture.dataDir, "cards.json"), "utf8"));
    cardPayload.records.push({ id: "30003", name: "合成更新卡", effectText: "同步后新增。" });
    await writeJson(join(fixture.dataDir, "cards.json"), cardPayload);

    const checked = await checkRagRuntimeBundle({
      dataDir: fixture.dataDir,
      bundleDir: outputDir,
      // A fresh loader is used because the production raw loader intentionally
      // caches one immutable snapshot per data directory.
      loadNormalizedData: async (dataDir) => loadFixtureLegacyDataFresh(dataDir),
    });
    assert.equal(checked.ok, false);
    assert.equal(checked.source, "legacy_raw_fallback_required");
    assert.equal(checked.reason, "source_revision_binding_mismatch");
    assert.equal(checked.data, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "rag-runtime-bundle-"));
  const dataDir = join(root, "data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
  await Promise.all([
    writeJson(join(dataDir, "cards.json"), {
      records: [
        { id: 30001, name: "合成甲", cnName: "合成甲", aliases: ["甲别名"], effectText: "①：可以发动。" },
        { id: 30002, name: "合成乙", jaName: "合成乙", effectText: "②：进行处理。" },
      ],
    }),
    writeJson(join(dataDir, "rulings.json"), {
      records: [{ id: "rule-synthetic-1", title: "合成规则", text: "规则正文。", cards: ["合成甲"] }],
    }),
    writeJson(join(dataDir, "qa-index.json"), {
      records: [{ id: "qa-synthetic-1", recordType: "qa", question: "可以发动吗？", answer: "可以。", cardIds: ["30001"] }],
    }),
    writeJson(join(dataDir, "evidence-index.json"), {
      records: [
        { id: "evidence-synthetic-1", recordType: "faq", title: "合成说明", text: "补充正文。" },
        { id: "rulebook-duplicate", sourceId: "ocg-rule", stableId: "ocg-rule:fixture", text: "旧重复规则。" },
      ],
    }),
    writeJson(join(dataDir, "ocg-rule-corpus.json"), {
      records: [{ id: "rulebook-synthetic-1", sourceId: "ocg-rule", stableId: "ocg-rule:fixture", text: "规则书正文。" }],
    }),
    writeJson(join(dataDir, "official-responses.json"), {
      records: [{
        id: "response-synthetic-1",
        sourceType: "official_response_screenshot",
        title: "合成回复",
        scenario: "合成场景。",
        officialText: "按所述处理。",
        cards: ["合成乙"],
      }],
    }),
  ]);
  return { root, dataDir };
}

// Only used to make the stale-source test independent from loadRagData's
// single-flight cache. It mirrors the fixture's deliberately simple shape;
// corpus-equivalence itself is tested against the real legacy loader above.
async function loadFixtureLegacyDataFresh(dataDir) {
  const cards = JSON.parse(await readFile(join(dataDir, "cards.json"), "utf8")).records;
  const baseline = await loadRagData(dataDir);
  return {
    cards: cards.map((card) => ({
      ...card,
      id: String(card.id || card.cardId || ""),
      cardId: String(card.cardId || card.id || ""),
      name: card.name || card.cnName || card.jaName || card.enName || "",
      aliases: [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean),
    })),
    records: baseline.records,
    qaRecords: baseline.qaRecords,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
