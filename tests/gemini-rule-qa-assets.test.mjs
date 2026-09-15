import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import test from "node:test";

import {
  clearGeminiRuleQaAssetsCacheForTests,
  getLoadedGeminiEvidenceReleaseInfo,
  loadGeminiRuleQaAssets,
} from "../backend/geminiRuleQaAssets.mjs";
import { buildGeminiRuleQaAssets } from "../scripts/build-gemini-rule-qa-assets.mjs";
import { buildRuleContext } from "../backend/geminiRuleContext.mjs";
import { ruleEmbeddingText } from "../backend/geminiRuleDenseSearch.mjs";

const DATA_REVISION = "d".repeat(64);
const ungzip = promisify(gunzip);

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "gemini-rule-qa-"));
  const rulings = {
    schemaVersion: 1,
    records: [
      { id: "qa-1", recordType: "qa", cardIds: ["17"], text: "alpha", official: true },
      { id: "faq-1", recordType: "card-faq", cardIds: ["29"], conclusion: "first\n\nsecond", sourceTier: "S0" },
      { id: "other-1", recordType: "rule-doc", text: "not a QA" },
    ],
  };
  const qaIndex = {
    schemaVersion: 1,
    records: [
      { id: "qa-history", recordType: "qa", cardIds: ["31"], text: "historical alpha", sourceName: "YGOResources DB" },
      rulings.records[1],
    ],
  };
  const rules = {
    schemaVersion: 1,
    records: [
      { id: "rule-1", recordType: "rule-doc", text: "rule body", sourceAuthority: "community_reference" },
    ],
  };
  await Promise.all([
    writeFile(join(dataDir, "rulings.json"), JSON.stringify(rulings)),
    writeFile(join(dataDir, "qa-index.json"), JSON.stringify(qaIndex)),
    writeFile(join(dataDir, "ocg-rule-corpus.json"), JSON.stringify(rules)),
    writeFile(join(dataDir, "rag-data-revision-manifest.json"), JSON.stringify({ revision: DATA_REVISION })),
  ]);
  for (const directory of ["rule-embedding-v1", "qa-embedding-v1"]) {
    await mkdir(join(dataDir, directory));
    await writeFile(join(dataDir, directory, "evidence-vector-index.json"), JSON.stringify({
      schemaVersion: 1, dataRevision: `${directory}-${DATA_REVISION}`,
    }));
  }
  return dataDir;
}

async function buildAll(dataDir) {
  await buildGeminiRuleQaAssets({ dataDir, stage: "canonical" });
  const hash = value => createHash("sha256").update(value).digest("hex");
  const rules = JSON.parse(await readFile(join(dataDir, "ocg-rule-corpus.json"), "utf8")).records;
  const ruleHashes = [...new Set([...buildRuleContext(rules).units.values()].map(unit => hash(ruleEmbeddingText(unit))))];
  const qaIndex = JSON.parse(await readFile(join(dataDir, "qa-index.json"), "utf8")).records;
  const rulings = JSON.parse(await readFile(join(dataDir, "rulings.json"), "utf8")).records;
  const byId = new Map(qaIndex.filter(record => ["qa", "card-faq"].includes(record.recordType)).map(record => [record.id, record]));
  for (const record of rulings.filter(record => ["qa", "card-faq"].includes(record.recordType))) byId.set(record.id, record);
  const qaHashes = [...new Set([...byId.values()].filter(record => record.recordType === "qa")
    .map(record => hash(ruleEmbeddingText({ title: record.title, text: JSON.stringify(record) }))))];
  for (const [directory, hashes] of [["rule-embedding-v1", ruleHashes], ["qa-embedding-v1", qaHashes]]) {
    const manifestPath = join(dataDir, directory, "evidence-vector-index.json");
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    current.orderedContentHashes = hashes;
    current.entries = hashes.map((textSha256, rowIndex) => ({ textSha256, shardIndex: 0, rowIndex }));
    await writeFile(manifestPath, JSON.stringify(current));
  }
  return buildGeminiRuleQaAssets({ dataDir, stage: "release" });
}

test("builder emits compressed byte-bound assets and loader reuses one immutable process snapshot", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const dataDir = await fixture();
  const firstBuild = await buildAll(dataDir);
  for (const descriptor of Object.values(firstBuild.manifest.assets)) {
    if (descriptor.encoding !== "gzip") continue;
    const compressed = await readFile(join(dataDir, "gemini-rule-qa-v1", descriptor.file));
    assert.equal(compressed[9], 255, `${descriptor.file} must use the portable gzip OS header`);
  }
  const firstManifest = JSON.stringify(firstBuild.manifest);
  const canonicalMappingPath = join(dataDir, "gemini-rule-qa-v1", "structure-mapping.json.gz");
  const canonicalMappingBeforeReplay = await readFile(canonicalMappingPath);
  const secondBuild = await buildGeminiRuleQaAssets({ dataDir, stage: "release" });
  const canonicalMappingAfterReplay = await readFile(canonicalMappingPath);
  const [first, second] = await Promise.all([
    loadGeminiRuleQaAssets({ dataDir }),
    loadGeminiRuleQaAssets({ dataDir }),
  ]);

  assert.equal(firstBuild.indexSource, "canonical_stage");
  assert.equal(secondBuild.indexSource, "canonical_stage");
  assert.equal(JSON.stringify(secondBuild.manifest), firstManifest);
  assert.deepEqual(canonicalMappingAfterReplay, canonicalMappingBeforeReplay);
  assert.equal(secondBuild.manifest.assets.structureMapping.file, "structure-mapping.release.json.gz");
  assert.strictEqual(first, second);
  assert.equal(first.dataRevision, DATA_REVISION);
  assert.equal(first.qaRecords.length, 3);
  assert.deepEqual(new Set(first.qaRecords.map((record) => record.id)),
    new Set(["qa-history", "faq-1", "qa-1"]));
  assert.equal(first.rulesRecords.length, 1);
  assert.strictEqual(first.rulesRecords, first.ruleRecords);
  assert.ok(Object.isFrozen(first.qaRecords[0]));
  assert.ok(Object.isFrozen(first.rulesRecords[0]));
  const linked = first.createQaTools({ cardIds: ["29"], pageSize: 1 }).search({ queries: ["alpha"] });
  assert.equal(linked.items[0].record.id, "faq-1");
  assert.equal(linked.items[0].sourceTier, "S0");
  assert.equal(first.manifest.schemaVersion, 3);
  assert.equal(first.navigationRecords.every(record => record.navigationStatus === "not_generated_in_scope"), true);
  assert.notStrictEqual(first.qaUnits, first.structureMapping.qaUnits);
  assert.equal(Object.hasOwn(first.structureMapping.qaUnits[0], "item"), false);
  assert.equal(first.structureMapping.structureMappingRevision, first.structureMappingRevision);
  assert.equal(first.handleUnitKeys.get(linked.items[0].handle).length, 2);
  assert.ok(first.handleUnitKeys.get(linked.items[0].handle)
    .every(unitKey => first.qaUnitsByKey.get(unitKey).item.record.sourceExcerpt.parentHandle === linked.items[0].handle));
  assert.equal(getLoadedGeminiEvidenceReleaseInfo().bundleRevision, first.bundleRevision);

  const navigationInputs = JSON.parse((await ungzip(await readFile(join(dataDir,
    "gemini-rule-qa-v1", "navigation-inputs.json.gz")))).toString("utf8"));
  const ruleNavigation = navigationInputs.find(row => row.input.sourceKind === "rule");
  assert.equal(ruleNavigation.input.unitStructure.structureStatus, "unavailable");
  assert.deepEqual(ruleNavigation.input.unitStructure.blocks,
    [{ kind: "opaque", start: 0, end: "rule body".length }]);

  const manifestText = await readFile(join(dataDir, "gemini-rule-qa-v1", "manifest.json"), "utf8");
  assert.match(manifestText, /"encoding": "gzip"/u);
  assert.doesNotMatch(manifestText, /evidence-vectors|\.f32/u);
});

test("runtime loader does not require canonical-stage navigation or dense inputs", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const dataDir = await fixture();
  const release = await buildAll(dataDir);
  const assetDir = join(dataDir, "gemini-rule-qa-v1");
  await Promise.all(["navigation-inputs.json.gz", "dense-inputs.json.gz", "structure-mapping.json.gz"]
    .map(file => rm(join(assetDir, file))));
  const assets = await loadGeminiRuleQaAssets({ dataDir });
  assert.equal(assets.bundleRevision, release.manifest.bundleRevision);
  assert.equal(assets.structureMappingRevision, release.manifest.structureMappingRevision);
});

test("loader rejects a mechanically changed compressed asset", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const dataDir = await fixture();
  await buildAll(dataDir);
  const file = join(dataDir, "gemini-rule-qa-v1", "qa-records.json.gz");
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(
    loadGeminiRuleQaAssets({ dataDir }),
    /asset_compressed_binding_invalid/u,
  );
});

test("built production asset contains every current formal QA and FAQ source id", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const dataDir = new URL("../data/", import.meta.url);
  const [qaIndex, rulings, assets] = await Promise.all([
    readFile(new URL("qa-index.json", dataDir), "utf8").then(JSON.parse),
    readFile(new URL("rulings.json", dataDir), "utf8").then(JSON.parse),
    loadGeminiRuleQaAssets({ dataDir: fileURLToPath(dataDir) }),
  ]);
  const isQa = (record) => ["qa", "card-faq"].includes(String(record?.recordType || ""));
  const expectedIds = new Set([
    ...qaIndex.records.filter(isQa),
    ...rulings.records.filter(isQa),
  ].map((record) => String(record.id)));
  const assetIds = new Set(assets.qaRecords.map((record) => String(record.id)));
  assert.equal(assetIds.size, expectedIds.size);
  for (const id of expectedIds) assert.ok(assetIds.has(id), `missing formal source id ${id}`);
});

test("release build and sync workflow verify and include only the same-version runtime assets", async () => {
  const [workflow, vercel, packageJson] = await Promise.all([
    readFile(new URL("../.github/workflows/sync-data.yml", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(workflow, /pnpm build:gemini-rule-qa/u);
  assert.match(workflow, /tests\/gemini-rule-qa-assets\.test\.mjs/u);
  assert.match(vercel, /pnpm run build:vercel/u);
  assert.match(vercel, /gemini-rule-qa-v1\/\*\*/u);
  assert.match(vercel, /canonical-manifest\.json/u);
  assert.match(vercel, /navigation-inputs\.json\.gz/u);
  assert.match(vercel, /dense-inputs\.json\.gz/u);
  assert.match(vercel, /structure-mapping\.json\.gz/u);
  assert.equal(JSON.parse(packageJson).scripts["build:gemini-rule-qa"],
    "node scripts/build-gemini-rule-qa-assets.mjs");
});
