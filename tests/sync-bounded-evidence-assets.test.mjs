import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  buildDefaultNavigationRecords,
  buildGeminiRuleQaAssets,
} from "../scripts/build-gemini-rule-qa-assets.mjs";
import { convertEvidenceGenerationRequest } from "../backend/evidenceGenerationTransport.mjs";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_INPUT_CONTRACT,
  EMBEDDING_INPUT_CONTRACT_SHA256,
  EMBEDDING_MODEL,
} from "../scripts/refresh-gemini-source-embeddings.mjs";
import {
  planNavigationReuse,
  runBoundedEvidenceAssetSync,
} from "../scripts/sync-bounded-evidence-assets.mjs";
import { stableJson } from "../scripts/lib/evidence-preprocess-cache.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const DATA_REVISION = "d".repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "bounded-evidence-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, "data");
  await mkdir(dataDir, { recursive: true });
  await Promise.all([
    writeFile(join(dataDir, "rulings.json"), JSON.stringify({ records: [
      { id: "qa-1", recordType: "qa", title: "QA", cardIds: ["17"], text: "qa body", official: true },
    ] })),
    writeFile(join(dataDir, "qa-index.json"), JSON.stringify({ records: [] })),
    writeFile(join(dataDir, "ocg-rule-corpus.json"), JSON.stringify({ records: [
      { id: "rule-1", recordType: "rule-doc", title: "Rule", text: "rule body", sourceUrl: "https://example.test/rule-1", sourceRole: "active-rule" },
    ] })),
    writeFile(join(dataDir, "rag-data-revision-manifest.json"), JSON.stringify({ revision: DATA_REVISION })),
    writeFile(join(dataDir, "cards.json"), JSON.stringify({ records: [
      { id: "17", cnName: "测试卡", jaName: "テストカード", enName: "Test Card", sourceUrl: "https://example.test/card/17" },
    ] })),
  ]);

  const canonical = await buildGeminiRuleQaAssets({ dataDir, stage: "canonical" });
  const assetDir = canonical.outputDir;
  const navigationInputs = await readGzipJson(join(assetDir, "navigation-inputs.json.gz"));
  const denseInputs = await readGzipJson(join(assetDir, "dense-inputs.json.gz"));
  const navigationRecords = navigationInputs.flatMap((input) => input.input.sourceKind === "rule"
    ? [generatedNavigationRecord(input, "seed-generator")]
    : buildDefaultNavigationRecords([input]));
  const navigationPath = join(directory, "seed-navigation.json.gz");
  await writeFile(navigationPath, gzipSync(Buffer.from(JSON.stringify(navigationRecords), "utf8")));
  await Promise.all([
    writeVectorIndex(join(dataDir, "rule-embedding-v1"), denseInputs.rule),
    writeVectorIndex(join(dataDir, "qa-embedding-v1"), denseInputs.qa),
  ]);
  await buildGeminiRuleQaAssets({ dataDir, stage: "release", navigationPath });
  await buildGeminiRuleQaAssets({ dataDir, stage: "verify" });
  return { directory, dataDir, navigationInputs, navigationRecords };
}

function generatedNavigationRecord(input, providerId) {
  return {
    unitKey: input.unitKey,
    sourceId: input.sourceId,
    canonicalBodySha256: input.canonicalBodySha256,
    contextInputSha256: input.contextInputSha256,
    titlePath: [...input.input.titlePath],
    descriptionZh: `中文:${input.unitKey}`,
    descriptionJa: `日本語:${input.unitKey}`,
    searchQuestions: [
      { language: "zh", text: `问题:${input.unitKey}` },
      { language: "ja", text: `質問:${input.unitKey}` },
    ],
    navigationStatus: "generated",
    contextRefs: [...input.contextRefs],
    explicitRefs: [...input.explicitRefs],
    generator: { providerId, inputSha256: input.contextInputSha256 },
  };
}

async function writeVectorIndex(directory, rows) {
  const hashes = [...new Set(rows.map((row) => row.embeddingInputSha256))];
  const bytes = Buffer.alloc(hashes.length * EMBEDDING_DIMENSION * Float32Array.BYTES_PER_ELEMENT);
  const shard = {
    index: 0,
    file: "evidence-vectors-000.f32",
    rowCount: hashes.length,
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
  const manifest = {
    schemaVersion: 1,
    kind: "evidence-vector-index",
    encoding: "raw-little-endian-float32",
    dataRevision: sha256(stableJson({
      kind: rows[0]?.sourceKind || (directory.includes("rule-") ? "rule" : "qa"),
      model: EMBEDDING_MODEL,
      dimension: EMBEDDING_DIMENSION,
      inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
      orderedContentHashes: hashes,
    })),
    model: { id: EMBEDDING_MODEL, revision: EMBEDDING_MODEL },
    dimension: EMBEDDING_DIMENSION,
    inputContract: EMBEDDING_INPUT_CONTRACT,
    inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
    orderedContentHashes: hashes,
    orderedContentHashesSha256: sha256(JSON.stringify(hashes)),
    uniqueContentCount: hashes.length,
    entries: hashes.map((textSha256, rowIndex) => ({ textSha256, shardIndex: 0, rowIndex })),
    shards: [shard],
    vectorByteLength: bytes.length,
    shardSetSha256: sha256(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: shard.sha256 }])),
  };
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, shard.file), bytes),
    writeFile(join(directory, "evidence-vector-index.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
}

function testBudget() {
  return {
    reserve: async () => {},
    settle: async () => {},
  };
}

function navigationTransport(contract, counter) {
  return {
    prepareRequest: (body) => convertEvidenceGenerationRequest(body, contract),
    invoke: async (body) => {
      counter.calls += 1;
      const unitText = JSON.parse(body.input.at(-1).content).unitText;
      assert.equal(typeof unitText, "string", "single-line fixture body is visible in the request");
      const input = { unitText };
      return {
        model: contract.modelId,
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            descriptionZh: `新中文:${input.unitText}`,
            descriptionJa: `新日本語:${input.unitText}`,
            searchQuestions: [
              { language: "zh", text: `新问题:${input.unitText}` },
              { language: "ja", text: `新質問:${input.unitText}` },
            ],
          }) }] }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
    },
    extractText: (response) => response.output[0].content[0].text,
    rawUsage: (response) => response.usage,
    validateResponse: () => true,
  };
}

async function readGzipJson(path) {
  return JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
}

async function readReleasedNavigation(outDir) {
  const assetDir = join(outDir, "gemini-rule-qa-v1");
  const manifest = JSON.parse(await readFile(join(assetDir, "manifest.json"), "utf8"));
  return readGzipJson(join(assetDir, manifest.assets.navigationRecords.file));
}

test("a previously generated non-rule row remains refreshable when its bound input changes", () => {
  const makeInput = (unitText) => {
    const input = { sourceKind: "qa", titlePath: ["QA"], unitText };
    return {
      unitKey: "qa:qa-1",
      sourceId: "qa:qa-1",
      canonicalBodySha256: sha256(unitText),
      contextInputSha256: sha256(stableJson(input)),
      contextRefs: [],
      explicitRefs: [],
      input,
    };
  };
  const oldInput = makeInput("old");
  const nextInput = makeInput("new");
  const oldRecord = generatedNavigationRecord(oldInput, "historical-generator");
  const plan = planNavigationReuse([nextInput], { inputs: [oldInput], records: [oldRecord] });

  assert.deepEqual(plan.generationInputs, [nextInput]);
  assert.equal(plan.placeholderRecords.length, 0);
});

test("unchanged inputs preserve paid navigation records and execute with zero API calls or credentials", async (t) => {
  const source = await fixture(t);
  const outDir = join(source.directory, "unchanged-stage");
  let calls = 0;
  const result = await runBoundedEvidenceAssetSync({
    dataDir: source.dataDir,
    outDir,
    cacheDir: join(source.directory, "cache"),
    execute: true,
    env: {},
  }, {
    navigationTransportFactory: () => { calls += 1; throw new Error("must_not_create_navigation_transport"); },
    embedBatch: async () => { calls += 1; throw new Error("must_not_embed"); },
    fetchImpl: async () => { calls += 1; throw new Error("must_not_fetch"); },
  });

  assert.equal(calls, 0);
  assert.equal(result.report.publishable, true);
  assert.equal(result.report.navigation.reusedRecords, source.navigationInputs.length);
  assert.equal(result.report.navigation.generatedRecords, 0);
  assert.deepEqual(await readReleasedNavigation(outDir), source.navigationRecords);
});

test("one mechanically changed source regenerates only its navigation and vector inputs", async (t) => {
  const source = await fixture(t);
  const rulePath = join(source.dataDir, "ocg-rule-corpus.json");
  const rules = JSON.parse(await readFile(rulePath, "utf8"));
  rules.records[0].text = "changed rule body";
  await writeFile(rulePath, JSON.stringify(rules));
  const outDir = join(source.directory, "changed-stage");
  const navCounter = { calls: 0 };
  const embeddedBatches = [];
  const result = await runBoundedEvidenceAssetSync({
    dataDir: source.dataDir,
    outDir,
    cacheDir: join(source.directory, "changed-cache"),
    execute: true,
    maxUsd: 1,
    env: {},
  }, {
    budget: testBudget(),
    navigationTransportFactory: (contract) => navigationTransport(contract, navCounter),
    embedBatch: async (texts) => {
      embeddedBatches.push([...texts]);
      return {
        embeddings: texts.map(() => ({ values: Array(EMBEDDING_DIMENSION).fill(0.25) })),
        usageMetadata: { promptTokenCount: texts.length },
      };
    },
  });

  assert.equal(result.report.publishable, true);
  assert.equal(result.report.navigation.generationRequired, 1);
  assert.equal(result.report.navigation.generatedRecords, 1);
  assert.equal(navCounter.calls, 1);
  assert.equal(embeddedBatches.length, 1);
  assert.equal(embeddedBatches[0].length, 1);
  const released = await readReleasedNavigation(outDir);
  const unchangedOld = source.navigationRecords.find((row) => row.sourceId === "qa:qa-1");
  assert.deepEqual(released.find((row) => row.sourceId === "qa:qa-1"), unchangedOld);
  assert.equal(released.find((row) => row.sourceId === "rule-1").generator.providerId,
    "bai");
});

test("one added and one removed QA drops obsolete navigation and vectors while reusing unchanged sources", async (t) => {
  const source = await fixture(t);
  const oldQaIndex = JSON.parse(await readFile(join(source.dataDir,
    "qa-embedding-v1", "evidence-vector-index.json"), "utf8"));
  const rulingsPath = join(source.dataDir, "rulings.json");
  await writeFile(rulingsPath, JSON.stringify({ records: [
    { id: "qa-2", recordType: "qa", title: "QA 2", cardIds: ["17"], text: "new qa body", official: true },
  ] }));
  await writeFile(join(source.dataDir, "rag-data-revision-manifest.json"),
    JSON.stringify({ revision: "e".repeat(64) }));
  const outDir = join(source.directory, "add-remove-stage");
  const navCounter = { calls: 0 };
  const embeddedBatches = [];
  const result = await runBoundedEvidenceAssetSync({
    dataDir: source.dataDir,
    outDir,
    cacheDir: join(source.directory, "add-remove-cache"),
    execute: true,
    maxUsd: 1,
    env: {},
  }, {
    budget: testBudget(),
    navigationTransportFactory: (contract) => navigationTransport(contract, navCounter),
    embedBatch: async (texts) => {
      embeddedBatches.push([...texts]);
      return {
        embeddings: texts.map(() => ({ values: Array(EMBEDDING_DIMENSION).fill(0.5) })),
        usageMetadata: { promptTokenCount: texts.length },
      };
    },
  });

  assert.equal(result.report.publishable, true);
  assert.equal(result.report.navigation.newInputs, 1);
  assert.equal(result.report.navigation.changedInputs, 0);
  assert.equal(result.report.navigation.removedInputs, 1);
  assert.equal(result.report.navigation.reusedRecords, 1);
  assert.equal(result.report.navigation.generationRequired, 0);
  assert.equal(result.report.navigation.placeholderRecords, 1);
  assert.equal(navCounter.calls, 0);
  assert.deepEqual(embeddedBatches.map((batch) => batch.length), [1]);

  const released = await readReleasedNavigation(outDir);
  assert.equal(released.some((row) => row.sourceId === "qa:qa-1"), false);
  assert.equal(released.some((row) => row.sourceId === "qa:qa-2"), true);
  assert.equal(released.find((row) => row.sourceId === "qa:qa-2").navigationStatus,
    "not_generated_in_scope");
  assert.deepEqual(released.find((row) => row.sourceId === "rule-1"),
    source.navigationRecords.find((row) => row.sourceId === "rule-1"));
  const newQaIndex = JSON.parse(await readFile(join(outDir,
    "qa-embedding-v1", "evidence-vector-index.json"), "utf8"));
  assert.equal(newQaIndex.orderedContentHashes.length, 1);
  assert.equal(newQaIndex.orderedContentHashes.includes(oldQaIndex.orderedContentHashes[0]), false);
  assert.deepEqual(newQaIndex.entries.map((entry) => entry.textSha256),
    newQaIndex.orderedContentHashes);
});

test("changed dry-run reports mechanical misses and existing estimates without credentials or API calls", async (t) => {
  const source = await fixture(t);
  const rulePath = join(source.dataDir, "ocg-rule-corpus.json");
  const rules = JSON.parse(await readFile(rulePath, "utf8"));
  rules.records[0].text = "changed dry-run rule body";
  await writeFile(rulePath, JSON.stringify(rules));
  const outDir = join(source.directory, "dry-stage");
  let calls = 0;
  const result = await runBoundedEvidenceAssetSync({
    dataDir: source.dataDir,
    outDir,
    cacheDir: join(source.directory, "dry-cache"),
    execute: false,
    env: {},
  }, {
    navigationTransportFactory: () => { calls += 1; throw new Error("must_not_create_transport"); },
    embedBatch: async () => { calls += 1; throw new Error("must_not_embed"); },
    fetchImpl: async () => { calls += 1; throw new Error("must_not_fetch"); },
  });

  assert.equal(calls, 0);
  assert.equal(result.report.publishable, false);
  assert.equal(result.report.navigation.newInputs, 0);
  assert.equal(result.report.navigation.changedInputs, 1);
  assert.equal(result.report.navigation.preparation.generationMisses, 1);
  assert.equal(result.report.navigation.preparation.estimatedGenerationCostUsd.status,
    "provider_measurement_required");
  assert.ok(result.report.embeddings.collections.rule.conservativeQuoteUsd > 0);
  await assert.rejects(readFile(join(outDir, "gemini-rule-qa-v1", "manifest.json")), /ENOENT/u);
});

test("navigation failure leaves canonical staging but no publishable release", async (t) => {
  const source = await fixture(t);
  const rulePath = join(source.dataDir, "ocg-rule-corpus.json");
  const rules = JSON.parse(await readFile(rulePath, "utf8"));
  rules.records[0].text = "changed and failing rule body";
  await writeFile(rulePath, JSON.stringify(rules));
  const outDir = join(source.directory, "failed-stage");

  await assert.rejects(runBoundedEvidenceAssetSync({
    dataDir: source.dataDir,
    outDir,
    cacheDir: join(source.directory, "failed-cache"),
    execute: true,
    maxUsd: 1,
    env: {},
  }, {
    budget: testBudget(),
    navigationTransportFactory: (contract) => ({
      ...navigationTransport(contract, { calls: 0 }),
      invoke: async () => { throw new Error("provider_failed"); },
    }),
    embedBatch: async () => { throw new Error("must_not_embed_after_navigation_failure"); },
  }), /provider_failed/u);

  await assert.rejects(readFile(join(outDir, "gemini-rule-qa-v1", "manifest.json")), /ENOENT/u);
  const report = JSON.parse(await readFile(join(outDir, "bounded-evidence-sync-report.json"), "utf8"));
  assert.equal(report.publishable, false);
  assert.equal(report.status, "failed");
  assert.match(report.error, /provider_failed/u);
});
