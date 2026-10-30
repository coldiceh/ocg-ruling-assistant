import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { buildGeminiRuleQaAssets, DEFAULT_RULE_SOURCE_ALLOWLIST } from "../scripts/build-gemini-rule-qa-assets.mjs";
import { buildRuleContext, buildRuleNavigationContents } from "../backend/geminiRuleContext.mjs";
import { buildRuleSourceStructure, buildRuleStructureMapping } from "../backend/evidenceSourceStructure.mjs";
import { clearGeminiRuleQaAssetsCacheForTests, loadGeminiRuleQaAssets } from "../backend/geminiRuleQaAssets.mjs";
import { prepareBoundedEvidenceSnapshot } from "../backend/geminiBoundedEvidenceProvider.mjs";
import {
  applyRuleSourceAllowlist,
  loadRuleSourceAllowlist,
  readRulePublication,
  RULE_SOURCE_PUBLICATION_CONTRACT,
  validateRuleSourceAllowlist,
} from "../backend/ruleSourcePublication.mjs";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_INPUT_CONTRACT,
  EMBEDDING_INPUT_CONTRACT_SHA256,
  EMBEDDING_MODEL,
} from "../scripts/refresh-gemini-source-embeddings.mjs";
import { stableJson } from "../scripts/lib/evidence-preprocess-cache.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const DATA_REVISION = "e".repeat(64);
const SOURCE_ID = "konami:fixture-rulebook";

// One container with three titled sections. Only section "a" is listed.
function fixtureRecord() {
  const pieces = [["c", "Fixture container", ""], ["a", "Alpha rules", "alpha listed body"],
    ["b", "Beta rules", "beta withheld body"], ["d", "Delta rules", "delta withheld body"]];
  let text = "";
  const sections = [];
  for (const [id, title, body] of pieces) {
    const start = text.length;
    text += `${title}\n\n${body ? `${body}\n\n` : ""}`;
    sections.push({ id, title, level: id === "c" ? 1 : 2, parentId: id === "c" ? null : "c", start, end: text.length });
  }
  sections[0].end = text.length;
  return { id: SOURCE_ID, recordType: "rule-doc", title: "Fixture rulebook", sourceName: "Fixture",
    sourceUrl: "https://example.test/rulebook", sourceAuthority: "official_reference", official: true, text,
    structure: { schemaVersion: 1, canonicalSha256: sha256(text), sections } };
}

function allowlist(sources) {
  return { schemaVersion: 1, kind: "rule-source-section-allowlist", categories: { test: "测试" }, sources };
}

const LISTED = { sourceId: SOURCE_ID, mode: "sections", sections: [
  { sectionKey: "a", title: "Alpha rules", titlePath: ["Fixture container", "Alpha rules"], category: "test", reason: "fixture" },
] };

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function vectorIndex(directory, rows, kind) {
  const hashes = [...new Set(rows.map((row) => row.embeddingInputSha256))];
  const bytes = Buffer.alloc(hashes.length * EMBEDDING_DIMENSION * Float32Array.BYTES_PER_ELEMENT, 0);
  for (let row = 0; row < hashes.length; row += 1) bytes.writeFloatLE(1, row * EMBEDDING_DIMENSION * 4);
  const shard = { index: 0, file: "evidence-vectors-000.f32", rowCount: hashes.length, byteLength: bytes.length,
    sha256: sha256(bytes) };
  const manifest = { schemaVersion: 1, kind: "evidence-vector-index", encoding: "raw-little-endian-float32",
    dataRevision: sha256(stableJson({ kind, model: EMBEDDING_MODEL, dimension: EMBEDDING_DIMENSION,
      inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256, orderedContentHashes: hashes })),
    model: { id: EMBEDDING_MODEL, revision: EMBEDDING_MODEL }, dimension: EMBEDDING_DIMENSION,
    inputContract: EMBEDDING_INPUT_CONTRACT, inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
    orderedContentHashes: hashes, orderedContentHashesSha256: sha256(JSON.stringify(hashes)),
    uniqueContentCount: hashes.length,
    entries: hashes.map((textSha256, rowIndex) => ({ textSha256, shardIndex: 0, rowIndex })),
    shards: [shard], vectorByteLength: bytes.length,
    shardSetSha256: sha256(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: shard.sha256 }])) };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, shard.file), bytes);
  await writeFile(join(directory, "evidence-vector-index.json"), JSON.stringify(manifest));
}

async function fixture(t, sources = [LISTED]) {
  const directory = await mkdtemp(join(tmpdir(), "rule-source-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, "data");
  await mkdir(dataDir);
  await Promise.all([
    writeJson(join(dataDir, "rulings.json"), { records: [
      { id: "qa-1", recordType: "qa", title: "QA", cardIds: ["17"], text: "qa body", official: true }] }),
    writeJson(join(dataDir, "qa-index.json"), { records: [] }),
    writeJson(join(dataDir, "ocg-rule-corpus.json"), { records: [
      { id: "ocg-rule:fixture", recordType: "rule-doc", title: "Community rule", text: "community rule body",
        sourceUrl: "https://example.test/rule", sourceRole: "active-rule" },
      fixtureRecord()] }),
    writeJson(join(dataDir, "rag-data-revision-manifest.json"), { revision: DATA_REVISION }),
    writeJson(join(dataDir, "cards.json"), { records: [{ id: "17", cnName: "测试卡", jaName: "テスト", enName: "Test",
      sourceUrl: "https://example.test/card/17" }] }),
  ]);
  const allowlistPath = await writeJson(join(directory, "allowlist.json"), allowlist(sources));
  return { directory, dataDir, allowlistPath };
}

async function release({ dataDir, allowlistPath }) {
  const canonical = await buildGeminiRuleQaAssets({ dataDir, stage: "canonical", ruleSourceAllowlistPath: allowlistPath });
  const assetDir = canonical.outputDir;
  const dense = JSON.parse(gunzipSync(await readFile(join(assetDir, "dense-inputs.json.gz"))).toString("utf8"));
  await vectorIndex(join(dataDir, "rule-embedding-v1"), dense.rule, "rule");
  await vectorIndex(join(dataDir, "qa-embedding-v1"), dense.qa, "qa");
  await buildGeminiRuleQaAssets({ dataDir, stage: "release", ruleSourceAllowlistPath: allowlistPath });
  await buildGeminiRuleQaAssets({ dataDir, stage: "verify", ruleSourceAllowlistPath: allowlistPath });
  clearGeminiRuleQaAssetsCacheForTests();
  return { canonical, dense, assets: await loadGeminiRuleQaAssets({ dataDir }) };
}

test("allowlist loading fails closed when missing, unreadable or empty", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rule-source-allowlist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(loadRuleSourceAllowlist(join(directory, "absent.json")), /^Error: rule_source_allowlist_missing$/u);
  await writeFile(join(directory, "broken.json"), "{");
  await assert.rejects(loadRuleSourceAllowlist(join(directory, "broken.json")), /rule_source_allowlist_json_invalid/u);
  assert.throws(() => validateRuleSourceAllowlist(allowlist([])), /rule_source_allowlist_empty/u);
  assert.throws(() => validateRuleSourceAllowlist({ ...allowlist([LISTED]), kind: "other" }),
    /rule_source_allowlist_invalid/u);
  assert.throws(() => validateRuleSourceAllowlist(allowlist([{ ...LISTED, sections: [] }])),
    /rule_source_allowlist_sections_empty/u);
  assert.throws(() => validateRuleSourceAllowlist(allowlist([{ sourceId: SOURCE_ID, mode: "withhold", sections: LISTED.sections,
    reason: "x" }])), /rule_source_allowlist_withhold_sections_invalid/u);
  assert.throws(() => validateRuleSourceAllowlist(allowlist([{ sourceId: SOURCE_ID, mode: "withhold" }])),
    /rule_source_allowlist_reason_missing/u);
  assert.throws(() => validateRuleSourceAllowlist(allowlist([{ ...LISTED, sections: [...LISTED.sections, LISTED.sections[0]] }])),
    /rule_source_allowlist_section_duplicate/u);
  assert.throws(() => validateRuleSourceAllowlist(allowlist([{ ...LISTED,
    sections: [{ ...LISTED.sections[0], category: "unknown" }] }])), /rule_source_allowlist_section_invalid/u);
  const path = await writeJson(join(directory, "ok.json"), allowlist([LISTED]));
  const loaded = await loadRuleSourceAllowlist(path);
  assert.equal(loaded.sha256, sha256(await readFile(path)));
  assert.deepEqual(validateRuleSourceAllowlist(loaded.allowlist), loaded.allowlist);
});

test("allowlist identities bind to the source structure by id, title and title path", () => {
  const record = fixtureRecord();
  const other = { id: "ocg-rule:fixture", recordType: "rule-doc", text: "body" };
  const applied = applyRuleSourceAllowlist([other, record], allowlist([LISTED,
    { sourceId: "konami:absent", mode: "withhold", reason: "absent" }]));
  assert.strictEqual(applied.records[0], other);
  assert.deepEqual(applied.records[1].publication, { contract: RULE_SOURCE_PUBLICATION_CONTRACT, mode: "sections",
    publishedSectionKeys: ["a"] });
  assert.equal(Object.hasOwn(record, "publication"), false);
  assert.deepEqual(applied.absentSourceIds, ["konami:absent"]);
  assert.throws(() => applyRuleSourceAllowlist([record], allowlist([{ sourceId: "konami:other", mode: "withhold", reason: "x" }])),
    /rule_source_allowlist_entry_missing:konami:fixture-rulebook/u);
  const section = LISTED.sections[0];
  for (const [change, code] of [[{ sectionKey: "zz" }, /section_unknown/u], [{ title: "Alpha" }, /title_mismatch/u],
    [{ titlePath: ["Alpha rules"] }, /title_path_mismatch/u]]) {
    assert.throws(() => applyRuleSourceAllowlist([record], allowlist([{ ...LISTED, sections: [{ ...section, ...change }] }])), code);
  }
  assert.throws(() => readRulePublication({ ...record, publication: { contract: RULE_SOURCE_PUBLICATION_CONTRACT,
    mode: "sections", publishedSectionKeys: ["missing"] } }), /rule_source_publication_section_unknown/u);
  assert.throws(() => readRulePublication({ ...record, publication: { contract: RULE_SOURCE_PUBLICATION_CONTRACT,
    mode: "sections", publishedSectionKeys: [] } }), /rule_source_publication_mode_invalid/u);
});

test("listed sections keep the identities of the complete source structure", () => {
  const record = fixtureRecord();
  const [published] = applyRuleSourceAllowlist([record], allowlist([LISTED])).records;
  const complete = buildRuleSourceStructure(record);
  const partial = buildRuleSourceStructure(published);
  const listed = complete.readingUnits.filter((unit) => unit.sectionKey === "a");
  assert.equal(complete.readingUnits.length, 3);
  assert.deepEqual(partial.readingUnits, listed);
  assert.deepEqual(partial.atoms, complete.atoms.filter((atom) => listed[0].atomKeys.includes(atom.atomKey)));
  assert.deepEqual(partial.sections.map((section) => section.sectionKey), ["c", "a"]);
  assert.ok(partial.blocks.every((block) => block.start >= listed[0].start && block.end <= listed[0].end));
  assert.deepEqual(partial.publication.publishedSectionKeys, ["a"]);

  const fullContext = buildRuleContext([record]);
  const context = buildRuleContext([published], { structureMapping: buildRuleStructureMapping([published]) });
  assert.ok(fullContext.units.size > context.units.size);
  for (const [id, unit] of context.units) {
    assert.deepEqual(unit, fullContext.units.get(id));
    assert.equal(unit.sourceSection.sourceSectionKey, "a");
  }
  assert.doesNotMatch(context.prefix, /beta withheld|delta withheld|Beta rules|Delta rules/u);
  assert.deepEqual([...context.sections.values()].map((section) => section.title), ["Fixture container", "Alpha rules"]);
  assert.throws(() => buildRuleContext([published], { structureMapping: buildRuleStructureMapping([record]) }),
    /gemini_rule_structure_mapping_publication_invalid/u);
});

test("withheld sections reach no search lane, dense row, navigation record or table of contents", async (t) => {
  const paths = await fixture(t);
  const { canonical, dense, assets } = await release(paths);
  const keyFor = (section) => `${SOURCE_ID}:reading:${section}:1`;
  assert.deepEqual(canonical.manifest.ruleSourcePublication.sources, [{ sourceId: SOURCE_ID, mode: "sections",
    publishedSections: 1, sourceSections: 4, publishedSectionKeys: ["a"],
    publishedReadingUnitKeys: [keyFor("a")], publishedReadingUnits: 1, sourceReadingUnits: 3 }]);
  assert.equal(assets.manifest.ruleSourcePublication.allowlist.sha256, sha256(await readFile(paths.allowlistPath)));
  assert.ok(dense.rule.every((row) => !/beta|delta/u.test(row.embeddingInput)));
  assert.ok(dense.rule.some((row) => /alpha listed body/u.test(row.embeddingInput)));
  assert.ok(assets.navigationRecords.some((record) => record.unitKey === keyFor("a")));
  assert.ok(assets.navigationRecords.every((record) => ![keyFor("b"), keyFor("d")].includes(record.unitKey)));
  assert.ok(assets.navigationRecords.every((record) => !/Beta rules|Delta rules/u.test(JSON.stringify(record.titlePath))));
  assert.equal(assets.rulesRecords.find((record) => record.id === SOURCE_ID).text, fixtureRecord().text,
    "the published record keeps the complete canonical text");

  const { snapshot } = prepareBoundedEvidenceSnapshot(assets);
  const ruleKeys = [...snapshot.rules.readingUnits.keys()];
  assert.deepEqual(ruleKeys.filter((key) => key.startsWith(SOURCE_ID)), [keyFor("a")]);
  for (const query of ["beta withheld body", "delta withheld body", "Beta rules"]) {
    const hits = snapshot.ruleSearch.search([query]);
    assert.ok(hits.every((unit) => !/beta|delta|Beta|Delta/u.test(unit.text)), query);
    assert.ok(hits.flatMap((unit) => snapshot.rules.denseMapping.get(unit.id) || [])
      .every((key) => !key.includes(":reading:b:") && !key.includes(":reading:d:")), query);
    const navigation = snapshot.navigationSearch.searchBySourceKind(query, { sourceKinds: ["rule"], limit: 32 });
    assert.ok(navigation.rule.every((hit) => ![keyFor("b"), keyFor("d")].includes(hit.unitKey)), query);
  }
  assert.ok(snapshot.ruleSearch.search(["alpha listed body"]).some((unit) => /alpha listed body/u.test(unit.text)));
  const toc = buildRuleNavigationContents({ rules: snapshot.rules, userQuery: "q", cardResolution: { resolvedCards: [] },
    retrievedEvidence: {} })[1].parts[0].text;
  assert.match(toc, /Alpha rules/u);
  assert.doesNotMatch(toc, /Beta rules|Delta rules/u);
});

test("a withheld source publishes nothing while other rule sources stay complete", async (t) => {
  const paths = await fixture(t, [{ sourceId: SOURCE_ID, mode: "withhold", reason: "fixture" }]);
  const { assets } = await release(paths);
  const { snapshot } = prepareBoundedEvidenceSnapshot(assets);
  assert.equal([...snapshot.rules.readingUnits.keys()].filter((key) => key.startsWith(SOURCE_ID)).length, 0);
  assert.equal([...snapshot.rules.units.values()].filter((unit) => unit.sourceId === SOURCE_ID).length, 0);
  assert.ok([...snapshot.rules.readingUnits.keys()].some((key) => key.startsWith("ocg-rule:fixture")));
  assert.doesNotMatch(snapshot.rules.prefix, /Fixture rulebook|alpha listed/u);
  assert.equal(assets.manifest.ruleSourcePublication.sources[0].publishedReadingUnits, 0);
});

test("a missing allowlist, an ungoverned official source or a later allowlist edit stops the build", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage: "canonical",
    ruleSourceAllowlistPath: join(paths.directory, "absent.json") }), /rule_source_allowlist_missing/u);
  const unrelated = await writeJson(join(paths.directory, "unrelated.json"),
    allowlist([{ sourceId: "konami:other", mode: "withhold", reason: "x" }]));
  await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage: "canonical",
    ruleSourceAllowlistPath: unrelated }), /rule_source_allowlist_entry_missing/u);

  await release(paths);
  const edited = allowlist([{ ...LISTED, sections: [{ ...LISTED.sections[0], reason: "edited" }] }]);
  await writeJson(paths.allowlistPath, edited);
  await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage: "verify",
    ruleSourceAllowlistPath: paths.allowlistPath }), /gemini_rule_qa_publication_binding_invalid/u);
  await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage: "release",
    ruleSourceAllowlistPath: paths.allowlistPath }), /gemini_rule_qa_publication_changed_after_canonical/u);
});

test("the checked-in allowlist lists 30 uncovered rulebook sections and withholds the how-to page", async () => {
  const loaded = await loadRuleSourceAllowlist(DEFAULT_RULE_SOURCE_ALLOWLIST);
  const corpus = JSON.parse(await readFile(new URL("../data/ocg-rule-corpus.json", import.meta.url), "utf8")).records;
  const applied = applyRuleSourceAllowlist(corpus.filter((record) => record.recordType === "rule-doc"), loaded.allowlist);
  const rulebook = loaded.allowlist.sources.find((source) => source.sourceId === "konami:ocg-rulebook-20200401");
  const counts = {};
  for (const section of rulebook.sections) counts[section.category] = (counts[section.category] || 0) + 1;
  assert.deepEqual(counts, { "deck-construction-and-format": 19, "basic-procedure-and-terminology": 9, "synchro-basics": 2 });
  assert.deepEqual(applied.applied.map(({ sourceId, mode, publishedSections }) => ({ sourceId, mode, publishedSections })),
    [{ sourceId: "konami:ocg-howto", mode: "withhold", publishedSections: 0 },
      { sourceId: "konami:ocg-rulebook-20200401", mode: "sections", publishedSections: 30 }]);
  assert.deepEqual(applied.absentSourceIds, []);
});

test("canonical and release bind the allowlist path, count and every section identity", async (t) => {
  const paths = await fixture(t);
  const { canonical, assets } = await release(paths);
  assert.deepEqual(canonical.manifest.ruleSourcePublication, assets.manifest.ruleSourcePublication);
  assert.deepEqual(canonical.manifest.ruleSourcePublication.allowlist, {
    file: "allowlist.json", path: "allowlist.json", bytes: (await readFile(paths.allowlistPath)).length,
    sha256: sha256(await readFile(paths.allowlistPath)), sectionCount: 1,
    sources: [{ sourceId: SOURCE_ID, mode: "sections", sectionKeys: ["a"] }],
  });
  for (const stage of ["release", "verify"]) {
    await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage,
      ruleSourceAllowlistPath: join(paths.directory, "missing.json") }), /rule_source_allowlist_missing/u);
  }
  await writeJson(paths.allowlistPath, allowlist([{ ...LISTED, sections: [] }]));
  for (const stage of ["release", "verify"]) {
    await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage,
      ruleSourceAllowlistPath: paths.allowlistPath }), /rule_source_allowlist_sections_empty/u);
  }
});

// Build a fully coherent but wrong release, then replace BOTH policy bindings
// with the approved one and rehash the manifests. Checking hashes or counts
// alone cannot catch this; the verifier must consult the full source again.
for (const [name, sections] of [
  ["extra hidden unit", [...LISTED.sections,
    { sectionKey: "b", title: "Beta rules", titlePath: ["Fixture container", "Beta rules"], category: "test", reason: "test" }]],
  ["same-count substituted unit", [
    { sectionKey: "b", title: "Beta rules", titlePath: ["Fixture container", "Beta rules"], category: "test", reason: "test" }]],
  ["missing listed unit", null],
]) {
  test(`release and verify reject consistently rehashed assets with ${name}`, async (t) => {
    const paths = await fixture(t);
    const approved = (await release(paths)).canonical.manifest.ruleSourcePublication;
    const alternate = await writeJson(join(paths.directory, "alternate.json"), allowlist([
      sections ? { ...LISTED, sections } : { sourceId: SOURCE_ID, mode: "withhold", reason: "test" },
    ]));
    await release({ ...paths, allowlistPath: alternate });
    for (const [file, revision] of [["canonical-manifest.json", "canonicalRevision"], ["manifest.json", "bundleRevision"]]) {
      const path = join(paths.dataDir, "gemini-rule-qa-v1", file);
      const body = JSON.parse(await readFile(path, "utf8"));
      delete body[revision];
      body.ruleSourcePublication = approved;
      await writeJson(path, { ...body, [revision]: sha256(stableJson(body)) });
    }
    for (const stage of ["release", "verify"]) {
      await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage,
        ruleSourceAllowlistPath: paths.allowlistPath }), /gemini_rule_qa_publication_records_invalid/u);
    }
  });
}

test("release and verify reject a vector index that drops a published row", async (t) => {
  const paths = await fixture(t);
  await release(paths);
  const path = join(paths.dataDir, "rule-embedding-v1", "evidence-vector-index.json");
  const index = JSON.parse(await readFile(path, "utf8"));
  index.entries.pop();
  await writeJson(path, index);
  for (const stage of ["release", "verify"]) {
    await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage,
      ruleSourceAllowlistPath: paths.allowlistPath }), /gemini_rule_qa_rule_dense_order_binding_invalid/u);
  }
});

test("verify checks the canonical manifest hash, including its policy section count", async (t) => {
  const paths = await fixture(t);
  await release(paths);
  const path = join(paths.dataDir, "gemini-rule-qa-v1", "canonical-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.ruleSourcePublication.allowlist.sectionCount++;
  await writeJson(path, manifest);
  await assert.rejects(buildGeminiRuleQaAssets({ dataDir: paths.dataDir, stage: "verify",
    ruleSourceAllowlistPath: paths.allowlistPath }), /gemini_rule_qa_canonical_manifest_binding_invalid/u);
});

test("published production assets contain only the listed official rulebook sections", async () => {
  clearGeminiRuleQaAssetsCacheForTests();
  const [assets, loaded] = await Promise.all([
    loadGeminiRuleQaAssets({ dataDir: fileURLToPath(new URL("../data/", import.meta.url)) }),
    loadRuleSourceAllowlist(DEFAULT_RULE_SOURCE_ALLOWLIST),
  ]);
  assert.equal(assets.manifest.ruleSourcePublication.allowlist.sha256, loaded.sha256);
  const listed = new Set(loaded.allowlist.sources.flatMap((source) => source.sections.map((section) => section.sectionKey)));
  const konami = assets.structureMapping.sources.filter((source) => source.sourceId.startsWith("konami:"));
  assert.deepEqual(konami.map((source) => [source.sourceId, source.publication.mode]),
    [["konami:ocg-howto", "withhold"], ["konami:ocg-rulebook-20200401", "sections"]]);
  const units = konami.flatMap((source) => source.readingUnits);
  assert.ok(units.length > 0);
  assert.ok(units.every((unit) => unit.sourceId === "konami:ocg-rulebook-20200401" && listed.has(unit.sectionKey)));
  const unitKeys = new Set(units.map((unit) => unit.unitKey));
  const konamiNavigation = assets.navigationRecords.filter((record) => record.sourceId.startsWith("konami:"));
  assert.deepEqual(new Set(konamiNavigation.map((record) => record.unitKey)), unitKeys);
  const { snapshot } = prepareBoundedEvidenceSnapshot(assets);
  const konamiParagraphs = [...snapshot.rules.units.values()].filter((unit) => unit.sourceId.startsWith("konami:"));
  assert.ok(konamiParagraphs.every((unit) => listed.has(unit.sourceSection?.sourceSectionKey)));
  assert.deepEqual([...snapshot.rules.readingUnits.keys()].filter((key) => key.startsWith("konami:")), [...unitKeys]);
});
