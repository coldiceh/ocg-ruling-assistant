import { stableQaSelection } from "./lib/sync-input-stability.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { buildRuleContext } from "../backend/geminiRuleContext.mjs";
import { ruleEmbeddingText } from "../backend/geminiRuleDenseSearch.mjs";
import { createQaSnapshot } from "../backend/geminiQaTools.mjs";
import { createFocusedQaView } from "../backend/geminiFocusedQaView.mjs";
import { createNavigationSearch } from "../backend/evidenceNavigationSearch.mjs";
import { buildRuleStructureMapping, makeQaSourceUnits, sourceSha256, stableJson,
  SOURCE_STRUCTURE_MAPPING_CONTRACT } from "../backend/evidenceSourceStructure.mjs";
import { GEMINI_RULE_QA_ASSET_DIRECTORY, GEMINI_RULE_QA_ASSET_SCHEMA_VERSION,
  GEMINI_RULE_QA_MANIFEST_FILE, loadGeminiRuleQaAssets } from "../backend/geminiRuleQaAssets.mjs";

const gz = promisify(gzip), ungz = promisify(gunzip);
const QA_TYPES = new Set(["qa", "card-faq"]);
const EXCLUDED_RULE_ROLES = new Set(["toc", "table-of-contents", "site-info", "rule-test"]);
const CANONICAL_MANIFEST = "canonical-manifest.json";
const FILES = { qaRecords: "qa-records.json.gz", ruleRecords: "rule-records.json.gz",
  qaLexicalIndex: "qa-lexical-index.bm25.gz", structureMapping: "structure-mapping.json.gz",
  releaseStructureMapping: "structure-mapping.release.json.gz",
  navigationInputs: "navigation-inputs.json.gz", denseInputs: "dense-inputs.json.gz",
  navigationRecords: "navigation-records.json.gz",
  navigationLexicalIndex: "navigation-lexical-index.bm25.gz" };
const sha256 = value => createHash("sha256").update(value).digest("hex");

function parseRecords(bytes, name) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error(`gemini_rule_qa_${name}_json_invalid`, { cause: error });
  }
  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(records)) throw new Error(`gemini_rule_qa_${name}_records_invalid`);
  return records;
}
function descriptor(file, compressed, canonical) {
  return { file, encoding: "gzip", bytes: compressed.byteLength, sha256: sha256(compressed),
    canonicalBytes: canonical.byteLength, canonicalSha256: sha256(canonical) };
}
async function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes); await rename(temporary, file);
}
async function writeAsset(dir, file, value, binary = false) {
  const canonical = binary ? Buffer.from(value) : Buffer.from(JSON.stringify(value), "utf8");
  const compressed = await gz(canonical, { level: 9, mtime: 0 });
  compressed[9] = 255;
  await atomicWrite(join(dir, file), compressed);
  return descriptor(file, compressed, canonical);
}
async function readAsset(dir, desc) {
  const compressed = await readFile(join(dir, desc.file));
  if (compressed.byteLength !== desc.bytes || sha256(compressed) !== desc.sha256) {
    throw new Error("gemini_rule_qa_canonical_asset_binding_invalid");
  }
  const canonical = await ungz(compressed);
  if (canonical.byteLength !== desc.canonicalBytes || sha256(canonical) !== desc.canonicalSha256) {
    throw new Error("gemini_rule_qa_canonical_asset_binding_invalid");
  }
  return JSON.parse(canonical.toString("utf8"));
}
async function previousQaRecords(sourceDir) {
  const directory = join(sourceDir, GEMINI_RULE_QA_ASSET_DIRECTORY);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, CANONICAL_MANIFEST), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const { canonicalRevision, ...body } = manifest;
  if (manifest.kind !== "gemini-rule-qa-canonical-stage" || sha256(stableJson(body)) !== canonicalRevision) {
    throw new Error("gemini_previous_qa_manifest_invalid");
  }
  if (manifest.assets?.qaRecords?.file !== FILES.qaRecords) throw new Error("gemini_previous_qa_descriptor_invalid");
  return readAsset(directory, manifest.assets.qaRecords);
}

function finalizeMapping(ruleRecords, qaUnits) {
  const base = buildRuleStructureMapping(ruleRecords);
  const rules = buildRuleContext(ruleRecords, { ruleContentRevision: "canonical-stage", structureMapping: base });
  const denseLocators = [...rules.denseLocators.values()].map(locator => {
    const embeddingInput = ruleEmbeddingText(rules.units.get(locator.denseUnitId));
    return { ...locator, embeddingInput, embeddingInputSha256: sha256(embeddingInput) };
  });
  const denseMappings = [...rules.denseMapping].map(([denseUnitId, readingUnitKeys]) => ({
    vectorRow: null, denseUnitId, sourceSpans: [denseLocators.find(value => value.denseUnitId === denseUnitId)],
    readingUnitKeys, mappingContractHash: sha256(SOURCE_STRUCTURE_MAPPING_CONTRACT) }));
  const { structureMappingRevision: _old, ...rest } = base;
  const plain = { ...rest, qaUnits, denseLocators, denseMappings };
  return { ...plain, structureMappingRevision: sourceSha256(stableJson(plain)) };
}
function ruleNavInput(unit, source, byKey, refsByKey) {
  const contexts = unit.contextRefs.map(key => byKey.get(key)).filter(Boolean);
  const structure = selected => ({ encodingVersion: 1, structureStatus: source.structureStatus,
    blocks: source.blocks.filter(block => block.start >= selected.start && block.end <= selected.end)
      .map(block => ({ kind: block.kind, start: block.start - selected.start,
        end: block.end - selected.start })),
    tables: source.atoms.filter(atom => selected.atomKeys.includes(atom.atomKey) && atom.tableLayout)
      .map(atom => ({ start: atom.start - selected.start, end: atom.end - selected.start,
      rowCount: atom.tableLayout.rowCount, columnCount: atom.tableLayout.columnCount,
      cells: atom.tableLayout.cells.map(cell => ({ ...cell,
        start: cell.start - selected.start, end: cell.end - selected.start })) })) });
  const explicitLinkedTitles = unit.explicitRefs.flatMap(refKey => (
    refsByKey.get(refKey)?.targetReadingUnitKeys || []
  )).map(key => byKey.get(key)?.titlePath).filter(Boolean);
  const input = { sourceKind: "rule", titlePath: unit.titlePath, unitText: unit.text,
    unitStructure: structure(unit), structuralContextTexts: contexts.map(value => value.text),
    structuralContextStructures: contexts.map(structure), explicitLinkedTitles };
  return { unitKey: unit.unitKey, sourceId: unit.sourceId,
    canonicalBodySha256: unit.sourceCanonicalSha256, contextRefs: unit.contextRefs,
    explicitRefs: unit.explicitRefs, input, contextInputSha256: sha256(stableJson(input)) };
}
async function canonicalStage(sourceDir, destination) {
  const names = ["rulings.json", "qa-index.json", "ocg-rule-corpus.json", "rag-data-revision-manifest.json", "cards.json"];
  const bytes = await Promise.all(names.map(name => readFile(join(sourceDir, name))));
  const qaRecords = stableQaSelection(parseRecords(bytes[1], "qa_index"), parseRecords(bytes[0], "rulings"),
    await previousQaRecords(sourceDir), parseRecords(bytes[4], "cards"));
  // The catalog's id and each QA's cardIds use the same upstream card identity.
  // Supply explicit names as navigation context; do not rewrite the canonical QA
  // or its existing embedding input, and do not infer names from placeholder text.
  const referenceCardById = new Map(parseRecords(bytes[4], "cards").map(card => [String(card.id), {
    cardId: String(card.id), cnName: String(card.cnName || ""), jaName: String(card.jaName || ""),
    enName: String(card.enName || ""), sourceUrl: String(card.sourceUrl || ""),
  }]));
  const ruleRecords = parseRecords(bytes[2], "rules").filter(record => record?.recordType === "rule-doc"
    && !EXCLUDED_RULE_ROLES.has(String(record.sourceRole || "")));
  const qaContentRevision = sha256(stableJson(qaRecords));
  const qaRevision = qaContentRevision;
  const parentSnapshot = createQaSnapshot({ records: qaRecords, qaRevision });
  const focused = createFocusedQaView({ qaRevision, items: [...parentSnapshot.qaUnitsByKey.values()] });
  const qaUnits = makeQaSourceUnits(focused.items);
  const ruleContentRevision = sha256(stableJson(ruleRecords.map(record => ({ sourceId: record.id,
    canonicalBodySha256: sha256(record.text), sourceUrl: record.sourceUrl,
    sourceRole: record.sourceRole,
    ...(Object.hasOwn(record, "sourceAuthority") ? { sourceAuthority: record.sourceAuthority } : {}),
    ...(Object.hasOwn(record, "official") ? { official: record.official } : {}) }))));
  const structureMapping = finalizeMapping(ruleRecords, qaUnits.map(({ text: _text, ...unit }) => unit));
  const qaSnapshot = parentSnapshot;
  const readingByKey = new Map(structureMapping.sources.flatMap(source => source.readingUnits)
    .map(unit => [unit.unitKey, unit]));
  const refsByKey = new Map(structureMapping.explicitReferences.map(ref => [ref.refKey, ref]));
  const navigationInputs = [
    ...structureMapping.sources.flatMap(source => source.readingUnits
      .map(unit => ruleNavInput(unit, source, readingByKey, refsByKey))),
    ...qaUnits.map(unit => {
      const record = JSON.parse(unit.text);
      const referenceIds = [...new Set((Array.isArray(record.cardIds) ? record.cardIds : []).map(String))];
      const input = { sourceKind: unit.recordType === "card-faq" ? "faq" : "qa",
        titlePath: unit.titlePath, unitText: unit.text, unitStructure: { encodingVersion: 1, tables: [] },
        referenceCards: referenceIds.flatMap(id => referenceCardById.has(id) ? [referenceCardById.get(id)] : []),
        unresolvedReferenceCardIds: referenceIds.filter(id => !referenceCardById.has(id)),
        structuralContextTexts: [], structuralContextStructures: [], explicitLinkedTitles: [] };
      return { unitKey: unit.unitKey, sourceId: unit.sourceId,
        canonicalBodySha256: unit.canonicalBodySha256, contextRefs: [], explicitRefs: [],
        input, contextInputSha256: sha256(stableJson(input)) };
    }),
  ];
  const denseInputs = {
    schemaVersion: 1,
    rule: structureMapping.denseMappings.map(mapping => ({ sourceKind: "rule",
      denseUnitId: mapping.denseUnitId, ...mapping.sourceSpans[0],
      readingUnitKeys: mapping.readingUnitKeys })),
    qa: qaRecords.filter(record => record.recordType === "qa").map(record => {
      const embeddingInput = ruleEmbeddingText({ title: record.title, text: JSON.stringify(record) });
      return { sourceKind: "qa", denseUnitId: `qa:${record.id}`, sourceId: `qa:${record.id}`,
        sourceCanonicalSha256: sha256(JSON.stringify(record)), embeddingInput,
        embeddingInputSha256: sha256(embeddingInput) };
    }),
  };
  const dataRevision = String(JSON.parse(bytes[3].toString("utf8"))?.revision || "");
  if (!/^[a-f0-9]{64}$/u.test(dataRevision)) throw new Error("gemini_rule_qa_data_revision_invalid");
  await mkdir(destination, { recursive: true });
  const lexical = qaSnapshot.buildLexicalIndex();
  const built = await Promise.all([
    writeAsset(destination, FILES.qaRecords, qaRecords), writeAsset(destination, FILES.ruleRecords, ruleRecords),
    writeAsset(destination, FILES.qaLexicalIndex, lexical, true),
    writeAsset(destination, FILES.structureMapping, structureMapping),
    writeAsset(destination, FILES.navigationInputs, navigationInputs),
    writeAsset(destination, FILES.denseInputs, denseInputs),
  ]);
  const assetKeys = ["qaRecords", "ruleRecords", "qaLexicalIndex", "structureMapping", "navigationInputs", "denseInputs"];
  const assets = Object.fromEntries(assetKeys.map((key, index) => [key, built[index]]));
  const sourceDescriptors = Object.fromEntries(names.map((file, index) => [
    ["rulings", "qaIndex", "rules", "ragDataRevision", "cards"][index],
    { file, bytes: bytes[index].byteLength, sha256: sha256(bytes[index]),
      ...(index === 3 ? { revision: dataRevision } : {}) },
  ]));
  const body = { schemaVersion: GEMINI_RULE_QA_ASSET_SCHEMA_VERSION, kind: "gemini-rule-qa-canonical-stage",
    dataRevision, qaRevision, qaContentRevision, ruleContentRevision,
    structureMappingRevision: structureMapping.structureMappingRevision, sources: sourceDescriptors,
    counts: { qaRecords: qaRecords.length, ruleRecords: ruleRecords.length,
      sourceAtoms: structureMapping.sources.reduce((sum, source) => sum + source.atoms.length, 0),
      readingUnits: structureMapping.sources.reduce((sum, source) => sum + source.readingUnits.length, 0),
      navigationInputs: navigationInputs.length, ruleDenseInputs: denseInputs.rule.length,
      qaDenseInputs: denseInputs.qa.length }, assets };
  const manifest = { ...body, canonicalRevision: sha256(stableJson(body)) };
  await atomicWrite(join(destination, CANONICAL_MANIFEST), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { outputDir: destination, manifest, stage: "canonical", indexSource: "rebuilt" };
}
export function buildDefaultNavigationRecords(inputs = []) {
  return inputs.map(value => ({ unitKey: value.unitKey, sourceId: value.sourceId,
    sourceKind: value.input.sourceKind, canonicalBodySha256: value.canonicalBodySha256,
    contextInputSha256: value.contextInputSha256, titlePath: value.input.titlePath,
    descriptionZh: "", descriptionJa: "", searchQuestions: [],
    navigationStatus: "not_generated_in_scope", contextRefs: value.contextRefs,
    explicitRefs: value.explicitRefs, generator: null }));
}
async function navigationRecords(pathValue, inputs) {
  if (!pathValue) return buildDefaultNavigationRecords(inputs);
  const bytes = await readFile(resolve(pathValue));
  const parsed = JSON.parse((pathValue.endsWith(".gz") ? await ungz(bytes) : bytes).toString("utf8"));
  return Array.isArray(parsed) ? parsed : parsed.records;
}
async function denseManifest(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "evidence-vector-index.json"), "utf8"));
  if (manifest?.schemaVersion !== 1 || typeof manifest.dataRevision !== "string"
      || !Array.isArray(manifest.entries) || !Array.isArray(manifest.orderedContentHashes)) {
    throw new Error("gemini_rule_qa_dense_manifest_invalid");
  }
  return manifest;
}
async function releaseStage(sourceDir, destination, navigationPath, ruleDenseDir, qaDenseDir) {
  const canonical = JSON.parse(await readFile(join(destination, CANONICAL_MANIFEST), "utf8"));
  if (canonical.schemaVersion !== 3 || canonical.kind !== "gemini-rule-qa-canonical-stage") {
    throw new Error("gemini_rule_qa_canonical_manifest_invalid");
  }
  const { canonicalRevision, ...canonicalBody } = canonical;
  if (canonicalRevision !== sha256(stableJson(canonicalBody))) {
    throw new Error("gemini_rule_qa_canonical_manifest_binding_invalid");
  }
  for (const source of Object.values(canonical.sources)) {
    const current = await readFile(join(sourceDir, source.file));
    if (current.byteLength !== source.bytes || sha256(current) !== source.sha256) {
      throw new Error("gemini_rule_qa_source_changed_after_canonical");
    }
  }
  let [mapping, inputs] = await Promise.all([readAsset(destination, canonical.assets.structureMapping),
    readAsset(destination, canonical.assets.navigationInputs)]);
  if (mapping.structureMappingRevision !== canonical.structureMappingRevision) {
    throw new Error("gemini_rule_qa_structure_mapping_revision_invalid");
  }
  const navigation = await navigationRecords(navigationPath, inputs);
  if (!Array.isArray(navigation) || navigation.length !== inputs.length
      || navigation.some((record, index) => record.unitKey !== inputs[index].unitKey)) {
    throw new Error("gemini_rule_qa_navigation_order_invalid");
  }
  const navigationRevision = sha256(stableJson(navigation));
  const navigationSearch = createNavigationSearch(navigation, { navigationRevision });
  const [navAsset, navigationLexicalAsset] = await Promise.all([
    writeAsset(destination, FILES.navigationRecords, navigation),
    writeAsset(destination, FILES.navigationLexicalIndex, navigationSearch.buildLexicalIndex(), true),
  ]);
  const [ruleDense, qaDense] = await Promise.all([
    denseManifest(resolve(ruleDenseDir || join(sourceDir, "rule-embedding-v1"))),
    denseManifest(resolve(qaDenseDir || join(sourceDir, "qa-embedding-v1"))),
  ]);
  const orderedUnique = values => [...new Set(values)];
  const ruleInputHashes = orderedUnique(mapping.denseLocators.map(value => value.embeddingInputSha256));
  if (stableJson(ruleInputHashes) !== stableJson(ruleDense.orderedContentHashes)) {
    throw new Error("gemini_rule_qa_rule_dense_order_binding_invalid");
  }
  const qaRecords = await readAsset(destination, canonical.assets.qaRecords);
  const qaInputHashes = orderedUnique(qaRecords.filter(record => record.recordType === "qa")
    .map(record => sha256(ruleEmbeddingText({ title: record.title, text: JSON.stringify(record) }))));
  if (stableJson(qaInputHashes) !== stableJson(qaDense.orderedContentHashes)) {
    throw new Error("gemini_rule_qa_qa_dense_order_binding_invalid");
  }
  const ruleEntryByHash = new Map(ruleDense.entries.map(entry => [entry.textSha256, entry]));
  const denseMappings = mapping.denseMappings.map(value => {
    const inputHash = value.sourceSpans?.[0]?.embeddingInputSha256;
    const entry = ruleEntryByHash.get(inputHash);
    if (!entry) throw new Error("gemini_rule_qa_rule_dense_input_binding_invalid");
    return { ...value, vectorRow: { shardIndex: entry.shardIndex, rowIndex: entry.rowIndex } };
  });
  const { structureMappingRevision: _mappingRevision, ...mappingBody } = mapping;
  mapping = { ...mappingBody, denseMappings };
  mapping.structureMappingRevision = sha256(stableJson(mapping));
  const mappingAsset = await writeAsset(destination, FILES.releaseStructureMapping, mapping);
  const ruleDenseRevision = ruleDense.dataRevision, qaDenseRevision = qaDense.dataRevision;
  const revisions = { qaContent: canonical.qaContentRevision, ruleContent: canonical.ruleContentRevision,
    structureMapping: mapping.structureMappingRevision, navigation: navigationRevision,
    qaDense: qaDenseRevision, ruleDense: ruleDenseRevision };
  const body = { schemaVersion: 3, kind: "gemini-rule-qa-assets", dataRevision: canonical.dataRevision,
    qaRevision: canonical.qaRevision, ruleRevision: canonical.ruleContentRevision,
    qaContentRevision: canonical.qaContentRevision, ruleContentRevision: canonical.ruleContentRevision,
    structureMappingRevision: mapping.structureMappingRevision, navigationRevision,
    qaDenseRevision, ruleDenseRevision,
    contracts: { sourceAdapter: "source-structure-v1", canonicalBody: "canonical-body-v1",
      navigationPrompt: "navigation-v1", lexicalIndex: "context-navigation-v1" },
    revisions, sources: canonical.sources,
    counts: { ...canonical.counts, navigationRecords: navigation.length },
    assets: { ...canonical.assets, structureMapping: mappingAsset, navigationRecords: navAsset,
      navigationLexicalIndex: navigationLexicalAsset } };
  const manifest = { ...body, bundleRevision: sha256(stableJson(body)) };
  await atomicWrite(join(destination, GEMINI_RULE_QA_MANIFEST_FILE), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { outputDir: destination, manifest, stage: "release", indexSource: "canonical_stage" };
}
async function navigationIndexStage(destination) {
  const assets = await loadGeminiRuleQaAssets({ assetDir: destination });
  const navigationSearch = assets.navigationSearch || createNavigationSearch(assets.navigationRecords, {
    navigationRevision: assets.navigationRevision,
  });
  const navigationLexicalAsset = await writeAsset(destination, FILES.navigationLexicalIndex,
    navigationSearch.buildLexicalIndex(), true);
  const { bundleRevision: _oldBundleRevision, ...currentBody } = assets.manifest;
  const body = { ...currentBody, assets: { ...currentBody.assets,
    navigationLexicalIndex: navigationLexicalAsset } };
  const manifest = { ...body, bundleRevision: sha256(stableJson(body)) };
  await atomicWrite(join(destination, GEMINI_RULE_QA_MANIFEST_FILE),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { outputDir: destination, manifest, stage: "navigation-index", indexSource: "navigation_records" };
}
async function verifyStage(sourceDir, destination) {
  const module = await import("../backend/geminiRuleQaAssets.mjs");
  module.clearGeminiRuleQaAssetsCacheForTests();
  const assets = await module.loadGeminiRuleQaAssets({ assetDir: destination });
  const canonical = JSON.parse(await readFile(join(destination, CANONICAL_MANIFEST), "utf8"));
  const [inputs, denseInputs] = await Promise.all([
    readAsset(destination, canonical.assets.navigationInputs),
    readAsset(destination, canonical.assets.denseInputs),
  ]);
  if (!Array.isArray(inputs) || inputs.length !== assets.manifest.counts.navigationInputs
      || inputs.some((input, index) => input.unitKey !== assets.navigationRecords[index]?.unitKey
        || input.sourceId !== assets.navigationRecords[index]?.sourceId
        || input.canonicalBodySha256 !== assets.navigationRecords[index]?.canonicalBodySha256
        || input.contextInputSha256 !== assets.navigationRecords[index]?.contextInputSha256
        || sha256(stableJson(input.input)) !== input.contextInputSha256)) {
    throw new Error("gemini_rule_qa_navigation_input_binding_invalid");
  }
  if (denseInputs?.schemaVersion !== 1 || ![denseInputs.rule, denseInputs.qa].every(Array.isArray)
      || [...denseInputs.rule, ...denseInputs.qa].some(input => (
        typeof input.embeddingInput !== "string"
        || sha256(input.embeddingInput) !== input.embeddingInputSha256))) {
    throw new Error("gemini_rule_qa_dense_input_binding_invalid");
  }
  for (const descriptorValue of Object.values(assets.manifest.sources)) {
    const bytes = await readFile(join(sourceDir, descriptorValue.file));
    if (bytes.byteLength !== descriptorValue.bytes || sha256(bytes) !== descriptorValue.sha256) {
      throw new Error("gemini_rule_qa_source_binding_invalid");
    }
  }
  return { outputDir: destination, manifest: assets.manifest, stage: "verify", indexSource: "verified" };
}
export async function buildGeminiRuleQaAssets({ dataDir, outputDir, stage = "release", navigationPath,
  ruleDenseDir, qaDenseDir } = {}) {
  const sourceDir = resolve(dataDir || "data");
  const destination = resolve(outputDir || join(sourceDir, GEMINI_RULE_QA_ASSET_DIRECTORY));
  if (stage === "canonical") return canonicalStage(sourceDir, destination);
  if (stage === "release") return releaseStage(sourceDir, destination, navigationPath, ruleDenseDir, qaDenseDir);
  if (stage === "navigation-index") return navigationIndexStage(destination);
  if (stage === "verify") return verifyStage(sourceDir, destination);
  throw new Error("gemini_rule_qa_stage_invalid");
}
function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? "" : process.argv[index + 1]; }
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = await buildGeminiRuleQaAssets({ stage: argument("--stage") || "release",
    dataDir: resolve(argument("--data-dir") || join(root, "data")),
    outputDir: resolve(argument("--output-dir") || join(root, "data", GEMINI_RULE_QA_ASSET_DIRECTORY)),
    navigationPath: argument("--navigation") || undefined,
    ruleDenseDir: argument("--rule-dense-dir") || undefined,
    qaDenseDir: argument("--qa-dense-dir") || undefined });
  process.stdout.write(`${JSON.stringify({ ok: true, stage: result.stage, outputDir: result.outputDir,
    bundleRevision: result.manifest.bundleRevision, canonicalRevision: result.manifest.canonicalRevision,
    counts: result.manifest.counts })}\n`);
}
