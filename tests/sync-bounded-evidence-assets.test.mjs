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
import { convertEvidenceGenerationRequest, createEvidenceGenerationTransport } from "../backend/evidenceGenerationTransport.mjs";
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


test("output-limit recovery reaches a verified release and retains the actual recovery-contract provenance", async (t) => {
  const source = await fixture(t);
  const rulePath = join(source.dataDir, "ocg-rule-corpus.json");
  const rules = JSON.parse(await readFile(rulePath, "utf8"));
  rules.records[0].text = "changed public rule requiring complete navigation";
  await writeFile(rulePath, JSON.stringify(rules));
  const caps = [];
  const cacheDir = join(source.directory, "recovery-cache");
  const dependencies = {
    budget: testBudget(),
    navigationTransportFactory: (contract) => {
      const transport = navigationTransport(contract, { calls: 0 });
      return {
        ...transport,
        validateResponse: (response) => createEvidenceGenerationTransport({ contract, env: {} }).validateResponse(response),
        invoke: async (body) => {
          caps.push(body.max_output_tokens);
          const response = await transport.invoke(body);
          return body.max_output_tokens === 2048
            ? { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
            : response;
        },
      };
    },
    embedBatch: async (texts) => ({
      embeddings: texts.map(() => ({ values: Array(EMBEDDING_DIMENSION).fill(0.25) })),
      usageMetadata: { promptTokenCount: texts.length },
    }),
  };
  const result = await runBoundedEvidenceAssetSync({
    dataDir: source.dataDir, outDir: join(source.directory, "recovery-stage"),
    cacheDir, execute: true, maxUsd: 5, env: {},
  }, dependencies);
  assert.equal(result.report.publishable, true);
  assert.deepEqual(caps, [2048, 8192]);
  const navigation = await readReleasedNavigation(result.outputDir);
  assert.ok(navigation.find((row) => row.sourceId === "rule-1").generator.generationContractSha256);
  const replay = await runBoundedEvidenceAssetSync({
    dataDir: source.dataDir, outDir: join(source.directory, "recovery-replay-stage"),
    cacheDir, execute: true, maxUsd: 5, env: {},
  }, { ...dependencies, navigationTransportFactory: () => { throw new Error("must_reuse_paid_recovery"); } });
  assert.equal(replay.report.publishable, true);
  assert.deepEqual(caps, [2048, 8192]);
});

test("unrecognized incomplete reason is retained in the failure artifact and cannot release assets", async (t) => {
  const source = await fixture(t);
  const rulePath = join(source.dataDir, "ocg-rule-corpus.json");
  const rules = JSON.parse(await readFile(rulePath, "utf8"));
  rules.records[0].text = "changed public failing rule";
  await writeFile(rulePath, JSON.stringify(rules));
  const outDir = join(source.directory, "diagnostic-stage");
  let calls = 0;
  await assert.rejects(runBoundedEvidenceAssetSync({
    dataDir: source.dataDir, outDir, cacheDir: join(source.directory, "diagnostic-cache"),
    execute: true, maxUsd: 5, env: {},
  }, {
    budget: testBudget(),
    navigationTransportFactory: (contract) => {
      const transport = navigationTransport(contract, { calls: 0 });
      return {
        ...transport,
        validateResponse: (response) => createEvidenceGenerationTransport({ contract, env: {} }).validateResponse(response),
        invoke: async (body) => {
          calls += 1;
          return { ...await transport.invoke(body), status: "incomplete", incomplete_details: { reason: "content_filter" } };
        },
      };
    },
    embedBatch: async () => { throw new Error("must_not_embed_incomplete_navigation"); },
  }), /evidence_generation_response_incomplete/u);
  assert.equal(calls, 1);
  const report = JSON.parse(await readFile(join(outDir, "bounded-evidence-sync-report.json"), "utf8"));
  assert.equal(report.publishable, false);
  assert.equal(report.responseDiagnostic.incompleteReason, "content_filter");
  await assert.rejects(readFile(join(outDir, "gemini-rule-qa-v1", "manifest.json")), /ENOENT/u);
});

async function changedCostFixture(t) {
  const source = await fixture(t);
  const path = join(source.dataDir, "ocg-rule-corpus.json");
  const rules = JSON.parse(await readFile(path, "utf8"));
  rules.records[0].text = "changed report-only fixture rule";
  await writeFile(path, JSON.stringify(rules));
  return source;
}
function costDependencies() {
  return {
    navigationTransportFactory: (contract) => navigationTransport(contract, { calls: 0 }),
    embedBatch: async (texts) => ({
      embeddings: texts.map(() => ({ values: Array(EMBEDDING_DIMENSION).fill(0.25) })),
      usageMetadata: { promptTokenCount: 100 },
    }),
  };
}
function costOptions(source, suffix) {
  return { dataDir: source.dataDir, outDir: join(source.directory, suffix),
    cacheDir: join(source.directory, "run-cost-cache"), execute: true,
    reportOnlyCost: true, env: {} };
}

test("report-only full sync needs no ledger or max-usd, reports both providers and replay costs zero", async (t) => {
  const source = await changedCostFixture(t);
  const first = await runBoundedEvidenceAssetSync(costOptions(source, "cost-first"), costDependencies());
  assert.equal(first.report.publishable, true);
  assert.equal(first.report.cost.requestsAttempted, 2);
  assert.equal(first.report.cost.byProvider.bai.knownCostUsd, 0.000044);
  assert.equal(first.report.cost.byProvider.gemini.knownCostUsd, 0.00002);
  assert.equal(first.report.cost.totalCostUsd, 0.000064);
  const replay = await runBoundedEvidenceAssetSync(costOptions(source, "cost-replay"), {
    navigationTransportFactory: () => { throw new Error("must_not_repeat_paid_navigation"); },
    embedBatch: async () => { throw new Error("must_not_repeat_paid_embeddings"); },
  });
  assert.equal(replay.report.publishable, true);
  assert.equal(replay.report.cost.requestsAttempted, 0);
  assert.equal(replay.report.cost.totalCostUsd, 0);
});

test("report-only cloud wiring receives reporter instead of requiring cumulative budget", async (t) => {
  const source = await changedCostFixture(t);
  const { createLocalEvidencePreprocessCache } = await import("../scripts/lib/evidence-preprocess-cache.mjs");
  const options = { ...costOptions(source, "cloud-cost"), cloud: true };
  let calls = 0;
  const result = await runBoundedEvidenceAssetSync(options, {
    ...costDependencies(),
    createCloudResources: async ({ reportOnlyCost, costReporter, env }) => {
      calls += 1;
      assert.equal(reportOnlyCost, true);
      assert.equal(costReporter.reportOnly, true);
      assert.equal(env.EVIDENCE_PREPROCESS_MAX_USD, undefined);
      return { budget: costReporter, cache: createLocalEvidencePreprocessCache({ cacheDir: options.cacheDir }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.report.cost.totalCostUsd, 0.000064);
});

test("report-only captures navigation usage even when saving the response fails", async (t) => {
  const source = await changedCostFixture(t);
  const { createLocalEvidencePreprocessCache } = await import("../scripts/lib/evidence-preprocess-cache.mjs");
  const options = costOptions(source, "cache-error-cost");
  const cache = createLocalEvidencePreprocessCache({ cacheDir: options.cacheDir });
  await assert.rejects(runBoundedEvidenceAssetSync(options, {
    ...costDependencies(), cache: { ...cache, saveNavigationProviderRaw: async () => { throw new Error("fixture_cache_write_failed"); } },
  }), /fixture_cache_write_failed/);
  const report = JSON.parse(await readFile(join(options.outDir, "run-cost.json"), "utf8"));
  assert.equal(report.outcome, "failed");
  assert.equal(report.requestsAttempted, 1);
  assert.equal(report.totalCostUsd, 0.000044);
});

test("provider exception gives unknown request cost, not a zero bill", async (t) => {
  const source = await changedCostFixture(t);
  const options = costOptions(source, "lost-response-cost");
  await assert.rejects(runBoundedEvidenceAssetSync(options, {
    ...costDependencies(),
    navigationTransportFactory: (contract) => ({ ...navigationTransport(contract, { calls: 0 }),
      invoke: async () => { throw new Error("fixture_connection_lost"); } }),
  }), /fixture_connection_lost/);
  const report = JSON.parse(await readFile(join(options.outDir, "run-cost.json"), "utf8"));
  assert.equal(report.outcome, "failed");
  assert.equal(report.unknownCostRequests, 1);
  assert.equal(report.totalCostUsd, null);
});

test("invalid embedding response still contributes its reported usage to failed-run cost", async (t) => {
  const source = await changedCostFixture(t);
  const options = costOptions(source, "bad-embedding-cost");
  await assert.rejects(runBoundedEvidenceAssetSync(options, {
    ...costDependencies(), embedBatch: async () => ({ embeddings: [], usageMetadata: { promptTokenCount: 100 } }),
  }), /embedding_response_count_invalid/);
  const report = JSON.parse(await readFile(join(options.outDir, "run-cost.json"), "utf8"));
  assert.equal(report.outcome, "failed");
  assert.equal(report.totalCostUsd, 0.000064);
});

test("report-only preserves one output recovery and counts each fresh response exactly once", async (t) => {
  const source = await changedCostFixture(t);
  const options = costOptions(source, "recovery-cost");
  const caps = [];
  const result = await runBoundedEvidenceAssetSync(options, {
    ...costDependencies(),
    navigationTransportFactory: (contract) => {
      const base = navigationTransport(contract, { calls: 0 });
      return { ...base,
        validateResponse: (r) => createEvidenceGenerationTransport({ contract, env: {} }).validateResponse(r),
        invoke: async (body) => {
          caps.push(body.max_output_tokens);
          const r = await base.invoke(body);
          return body.max_output_tokens === 2048
            ? { ...r, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } : r;
        },
      };
    },
  });
  assert.deepEqual(caps, [2048, 8192]);
  assert.equal(result.report.cost.requestsAttempted, 3);
  assert.equal(result.report.cost.totalCostUsd, 0.000108);
});

test("report-only rejects incomplete response, preserves known failed-call cost and does not embed", async (t) => {
  const source = await changedCostFixture(t);
  const options = costOptions(source, "incomplete-cost");
  await assert.rejects(runBoundedEvidenceAssetSync(options, {
    ...costDependencies(),
    navigationTransportFactory: (contract) => {
      const base = navigationTransport(contract, { calls: 0 });
      return { ...base,
        validateResponse: (r) => createEvidenceGenerationTransport({ contract, env: {} }).validateResponse(r),
        invoke: async (body) => ({ ...(await base.invoke(body)), status: "incomplete", incomplete_details: { reason: "unknown" } }),
      };
    },
    embedBatch: async () => { throw new Error("must_not_embed"); },
  }), /evidence_generation_response_incomplete/);
  const report = JSON.parse(await readFile(join(options.outDir, "bounded-evidence-sync-report.json"), "utf8"));
  assert.equal(report.publishable, false);
  assert.equal(report.cost.totalCostUsd, 0.000044);
  assert.equal(report.cost.requestsAttempted, 1);
});
