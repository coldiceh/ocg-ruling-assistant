import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTrustedRagDataRevision,
  buildRagDataRevisionManifest,
  computeRagDataRevision,
  createRagDataSourceDescriptor,
  getTrustedRagDataRevision,
  RAG_DATA_REVISION_SOURCE_FILES,
  resolveRagDataRevision,
  validateRagDataRevisionManifest,
} from "../backend/ragDataRevisionManifest.mjs";

function fixtureData() {
  return {
    cards: [{ id: "1", name: "合成测试卡", effectText: "①：可以发动。" }],
    records: [{ id: "rule-1", recordType: "rulebook", text: "合成规则正文。" }],
    qaRecords: [{ id: "qa-1", recordType: "qa", question: "可以发动吗？", answer: "可以。" }],
  };
}

function fixtureSources(overrides = {}) {
  return RAG_DATA_REVISION_SOURCE_FILES.map((path) => createRagDataSourceDescriptor(
    path,
    overrides[path] ?? `${path}:fixture-content`,
  ));
}

test("RAG revision manifest generation is deterministic and matches the legacy canonical digest", () => {
  const data = fixtureData();
  const sources = fixtureSources();
  const first = buildRagDataRevisionManifest({ data, sources });
  const second = buildRagDataRevisionManifest({ data: structuredClone(data), sources: [...sources].reverse() });

  assert.deepEqual(second, first);
  assert.equal(first.revision, computeRagDataRevision(data, ""));
  assert.equal(first.canonicalCorpusDigest, computeRagDataRevision(data, ""));
  assert.deepEqual(first.sources.map((item) => item.path), RAG_DATA_REVISION_SOURCE_FILES);
  assert.deepEqual(first.counts, { cards: 1, records: 1, qaRecords: 1 });
  assert.deepEqual(validateRagDataRevisionManifest(first, {
    data,
    sources,
    verifyCanonicalCorpus: true,
  }), { ok: true, reasons: [], revision: first.revision });
});

test("any source byte change invalidates a precompiled RAG revision manifest", () => {
  const data = fixtureData();
  const sources = fixtureSources();
  const manifest = buildRagDataRevisionManifest({ data, sources });
  const changedSources = fixtureSources({ "qa-index.json": "changed QA bytes" });
  const validation = validateRagDataRevisionManifest(manifest, { data, sources: changedSources });

  assert.equal(validation.ok, false);
  assert.ok(validation.reasons.includes("source_set_digest_mismatch"));
  assert.ok(validation.reasons.includes("source_descriptors_mismatch"));
});

test("source descriptors are stable across Windows and Linux line endings", () => {
  const lf = createRagDataSourceDescriptor("cards.json", "{\n  \"cards\": []\n}\n");
  const crlf = createRagDataSourceDescriptor("cards.json", "{\r\n  \"cards\": []\r\n}\r\n");
  const cr = createRagDataSourceDescriptor("cards.json", "{\r  \"cards\": []\r}\r");

  assert.deepEqual(crlf, lf);
  assert.deepEqual(cr, lf);
  assert.notDeepEqual(
    createRagDataSourceDescriptor("cards.json", "{\n  \"cards\": [1]\n}\n"),
    lf,
  );
});

test("the complete source-set manifest is invariant to checkout line endings", () => {
  const data = fixtureData();
  const lfSources = fixtureSources(Object.fromEntries(
    RAG_DATA_REVISION_SOURCE_FILES.map((path) => [path, `${path}\nfixture\n`]),
  ));
  const crlfSources = fixtureSources(Object.fromEntries(
    RAG_DATA_REVISION_SOURCE_FILES.map((path) => [path, `${path}\r\nfixture\r\n`]),
  ));

  assert.deepEqual(
    buildRagDataRevisionManifest({ data, sources: crlfSources }),
    buildRagDataRevisionManifest({ data, sources: lfSources }),
  );
});

test("only a trusted default snapshot can use the precompiled revision", () => {
  const data = fixtureData();
  const sources = fixtureSources();
  const manifest = buildRagDataRevisionManifest({ data, sources });
  const valid = validateRagDataRevisionManifest(manifest, { data, sources });

  assert.equal(getTrustedRagDataRevision(data), "");
  assert.equal(bindTrustedRagDataRevision(data, valid), true);
  assert.equal(getTrustedRagDataRevision(data), manifest.revision);
  assert.equal(resolveRagDataRevision(data, ""), manifest.revision);

  const configured = resolveRagDataRevision(data, "explicit-revision");
  assert.equal(configured, computeRagDataRevision(data, "explicit-revision"));
  assert.notEqual(configured, manifest.revision);

  const injected = structuredClone(data);
  assert.equal(getTrustedRagDataRevision(injected), "");
  assert.equal(resolveRagDataRevision(injected, ""), computeRagDataRevision(injected, ""));
});

test("missing or untrusted manifests fail closed to the legacy dynamic digest", () => {
  const data = fixtureData();
  const sources = fixtureSources();
  const missing = validateRagDataRevisionManifest(null, { data, sources });
  assert.equal(missing.ok, false);
  assert.equal(bindTrustedRagDataRevision(data, missing), false);
  assert.equal(resolveRagDataRevision(data, ""), computeRagDataRevision(data, ""));

  const manifest = buildRagDataRevisionManifest({ data, sources });
  const forged = { ...manifest, canonicalCorpusDigest: "0".repeat(64), revision: "0".repeat(64) };
  const forgedValidation = validateRagDataRevisionManifest(forged, {
    data,
    sources,
    verifyCanonicalCorpus: true,
  });
  assert.equal(forgedValidation.ok, false);
  assert.ok(forgedValidation.reasons.includes("canonical_corpus_digest_mismatch"));
});

test("a stale manifest cannot certify normalized data from changed source bytes", () => {
  const oldData = fixtureData();
  const oldSources = fixtureSources();
  const oldManifest = buildRagDataRevisionManifest({ data: oldData, sources: oldSources });
  const changedData = {
    ...fixtureData(),
    qaRecords: [{ id: "qa-1", recordType: "qa", question: "更新后可以发动吗？", answer: "不可以。" }],
  };
  const changedSources = fixtureSources({ "qa-index.json": "changed QA bytes" });
  const validation = validateRagDataRevisionManifest(oldManifest, {
    data: changedData,
    sources: changedSources,
    verifyCanonicalCorpus: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.reasons.includes("source_set_digest_mismatch"));
  assert.ok(validation.reasons.includes("canonical_corpus_digest_mismatch"));
  assert.equal(bindTrustedRagDataRevision(changedData, validation), false);
});
