import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  clearGeminiRuleQaAssetsCacheForTests,
  loadGeminiRuleQaAssets,
} from "../backend/geminiRuleQaAssets.mjs";
import { buildGeminiRuleQaAssets } from "../scripts/build-gemini-rule-qa-assets.mjs";

const DATA_REVISION = "d".repeat(64);

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "gemini-rule-qa-"));
  const rulings = {
    schemaVersion: 1,
    records: [
      { id: "qa-1", recordType: "qa", cardIds: ["17"], text: "alpha", official: true },
      { id: "faq-1", recordType: "card-faq", cardIds: ["29"], text: "beta", sourceTier: "S0" },
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
  return dataDir;
}

test("builder emits compressed byte-bound assets and loader reuses one immutable process snapshot", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const dataDir = await fixture();
  const firstBuild = await buildGeminiRuleQaAssets({ dataDir });
  const secondBuild = await buildGeminiRuleQaAssets({ dataDir });
  const [first, second] = await Promise.all([
    loadGeminiRuleQaAssets({ dataDir }),
    loadGeminiRuleQaAssets({ dataDir }),
  ]);

  assert.equal(firstBuild.indexSource, "rebuilt");
  assert.equal(secondBuild.indexSource, "existing_bundle");
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

  const manifestText = await readFile(join(dataDir, "gemini-rule-qa-v1", "manifest.json"), "utf8");
  assert.match(manifestText, /"encoding": "gzip"/u);
  assert.doesNotMatch(manifestText, /evidence-vectors|\.f32/u);
});

test("loader rejects a mechanically changed compressed asset", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const dataDir = await fixture();
  await buildGeminiRuleQaAssets({ dataDir });
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

test("release build and sync workflow regenerate and include the same-version assets", async () => {
  const [workflow, vercel, packageJson] = await Promise.all([
    readFile(new URL("../.github/workflows/sync-data.yml", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(workflow, /pnpm build:gemini-rule-qa/u);
  assert.match(workflow, /tests\/gemini-rule-qa-assets\.test\.mjs/u);
  assert.match(vercel, /pnpm run build:gemini-rule-qa/u);
  assert.match(vercel, /data\/gemini-rule-qa-v1\/\*\*/u);
  assert.equal(JSON.parse(packageJson).scripts["build:gemini-rule-qa"],
    "node scripts/build-gemini-rule-qa-assets.mjs");
});
