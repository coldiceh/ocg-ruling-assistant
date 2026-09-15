import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

import { createQaSnapshot } from "./geminiQaTools.mjs";
import { createFocusedQaView } from "./geminiFocusedQaView.mjs";

export const GEMINI_RULE_QA_ASSET_DIRECTORY = "gemini-rule-qa-v1";
export const GEMINI_RULE_QA_MANIFEST_FILE = "manifest.json";
export const GEMINI_RULE_QA_ASSET_SCHEMA_VERSION = 3;

const FILES = Object.freeze({
  qaRecords: "qa-records.json.gz",
  ruleRecords: "rule-records.json.gz",
  qaLexicalIndex: "qa-lexical-index.bm25.gz",
  structureMapping: "structure-mapping.release.json.gz",
  navigationInputs: "navigation-inputs.json.gz",
  denseInputs: "dense-inputs.json.gz",
  navigationRecords: "navigation-records.json.gz",
});
const SHA256 = /^[a-f0-9]{64}$/u;
const decompressGzip = promisify(gunzip);
const processSnapshots = new Map();
const processInitId = randomUUID();
let lastLoadedRelease = null;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function freezeTree(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("gemini_rule_qa_asset_cyclic_invalid");
  seen.add(value);
  for (const child of Object.values(value)) freezeTree(child, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function validateDescriptor(descriptor, expectedFile) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
      || descriptor.file !== expectedFile || descriptor.encoding !== "gzip"
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0
      || !Number.isSafeInteger(descriptor.canonicalBytes) || descriptor.canonicalBytes < 0
      || !SHA256.test(String(descriptor.sha256 || ""))
      || !SHA256.test(String(descriptor.canonicalSha256 || ""))) {
    throw new Error("gemini_rule_qa_asset_descriptor_invalid");
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || manifest.schemaVersion !== GEMINI_RULE_QA_ASSET_SCHEMA_VERSION
      || manifest.kind !== "gemini-rule-qa-assets"
      || !SHA256.test(String(manifest.dataRevision || ""))
      || !SHA256.test(String(manifest.qaRevision || ""))
      || !SHA256.test(String(manifest.ruleRevision || ""))
      || !SHA256.test(String(manifest.qaContentRevision || ""))
      || !SHA256.test(String(manifest.ruleContentRevision || ""))
      || !SHA256.test(String(manifest.structureMappingRevision || ""))
      || !SHA256.test(String(manifest.navigationRevision || ""))
      || typeof manifest.qaDenseRevision !== "string" || !manifest.qaDenseRevision
      || typeof manifest.ruleDenseRevision !== "string" || !manifest.ruleDenseRevision
      || !SHA256.test(String(manifest.bundleRevision || ""))
      || !Number.isSafeInteger(manifest.counts?.qaRecords) || manifest.counts.qaRecords < 0
      || !Number.isSafeInteger(manifest.counts?.ruleRecords) || manifest.counts.ruleRecords < 0) {
    throw new Error("gemini_rule_qa_manifest_invalid");
  }
  if (manifest.revisions?.qaContent !== manifest.qaContentRevision
      || manifest.revisions?.ruleContent !== manifest.ruleContentRevision
      || manifest.revisions?.structureMapping !== manifest.structureMappingRevision
      || manifest.revisions?.navigation !== manifest.navigationRevision
      || manifest.revisions?.qaDense !== manifest.qaDenseRevision
      || manifest.revisions?.ruleDense !== manifest.ruleDenseRevision
      || manifest.ruleRevision !== manifest.ruleContentRevision
      || manifest.sources?.ragDataRevision?.revision !== manifest.dataRevision
      || !SHA256.test(String(manifest.sources?.ragDataRevision?.sha256 || ""))) {
    throw new Error("gemini_rule_qa_manifest_source_binding_invalid");
  }
  const { bundleRevision: _ignored, ...revisionInput } = manifest;
  if (sha256(stableJson(revisionInput)) !== manifest.bundleRevision) {
    throw new Error("gemini_rule_qa_manifest_bundle_binding_invalid");
  }
  validateDescriptor(manifest.assets?.qaRecords, FILES.qaRecords);
  validateDescriptor(manifest.assets?.ruleRecords, FILES.ruleRecords);
  validateDescriptor(manifest.assets?.qaLexicalIndex, FILES.qaLexicalIndex);
  validateDescriptor(manifest.assets?.structureMapping, FILES.structureMapping);
  validateDescriptor(manifest.assets?.navigationInputs, FILES.navigationInputs);
  validateDescriptor(manifest.assets?.denseInputs, FILES.denseInputs);
  validateDescriptor(manifest.assets?.navigationRecords, FILES.navigationRecords);
  return manifest;
}

async function readBoundAsset(assetDir, descriptor) {
  const compressed = await readFile(join(assetDir, descriptor.file));
  if (compressed.byteLength !== descriptor.bytes || sha256(compressed) !== descriptor.sha256) {
    throw new Error("gemini_rule_qa_asset_compressed_binding_invalid");
  }
  let canonical;
  try {
    canonical = await decompressGzip(compressed);
  } catch (error) {
    throw new Error("gemini_rule_qa_asset_gzip_invalid", { cause: error });
  }
  if (canonical.byteLength !== descriptor.canonicalBytes
      || sha256(canonical) !== descriptor.canonicalSha256) {
    throw new Error("gemini_rule_qa_asset_canonical_binding_invalid");
  }
  return canonical;
}

async function readBoundJson(assetDir, descriptor) {
  const bytes = await readBoundAsset(assetDir, descriptor);
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error("gemini_rule_qa_asset_json_invalid", { cause: error });
  }
}

async function loadUncached(assetDir) {
  const manifestBytes = await readFile(join(assetDir, GEMINI_RULE_QA_MANIFEST_FILE));
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    if (String(error?.message || "").startsWith("gemini_rule_qa_")) throw error;
    throw new Error("gemini_rule_qa_manifest_invalid", { cause: error });
  }
  const qaRecords = await readBoundJson(assetDir, manifest.assets.qaRecords);
  const ruleRecords = await readBoundJson(assetDir, manifest.assets.ruleRecords);
  const structureMapping = await readBoundJson(assetDir, manifest.assets.structureMapping);
  const navigationRecords = await readBoundJson(assetDir, manifest.assets.navigationRecords);
  const lexicalIndexBytes = await readBoundAsset(assetDir, manifest.assets.qaLexicalIndex);
  if (!Array.isArray(qaRecords) || qaRecords.length !== manifest.counts.qaRecords
      || !Array.isArray(ruleRecords) || ruleRecords.length !== manifest.counts.ruleRecords
      || !Array.isArray(navigationRecords) || navigationRecords.length !== manifest.counts.navigationRecords
      || !structureMapping || structureMapping.structureMappingRevision !== manifest.structureMappingRevision
      || sha256(stableJson(navigationRecords)) !== manifest.navigationRevision) {
    throw new Error("gemini_rule_qa_asset_count_invalid");
  }
  const { structureMappingRevision: _mappingRevision, ...mappingBody } = structureMapping;
  if (sha256(stableJson(mappingBody)) !== manifest.structureMappingRevision) {
    throw new Error("gemini_rule_qa_structure_mapping_binding_invalid");
  }
  const expectedNavigation = [
    ...(structureMapping.sources || []).flatMap(source => source.readingUnits.map(unit => ({
      unitKey: unit.unitKey, sourceId: unit.sourceId, canonicalBodySha256: unit.sourceCanonicalSha256,
    }))),
    ...(structureMapping.qaUnits || []).map(unit => ({ unitKey: unit.unitKey,
      sourceId: unit.sourceId, canonicalBodySha256: unit.canonicalBodySha256 })),
  ];
  const statuses = new Set(["generated", "unavailable_after_attempt", "not_generated_in_scope", "blocked_before_attempt"]);
  if (expectedNavigation.length !== navigationRecords.length || navigationRecords.some((record, index) => {
    const expected = expectedNavigation[index];
    return !expected || record.unitKey !== expected.unitKey || record.sourceId !== expected.sourceId
      || record.canonicalBodySha256 !== expected.canonicalBodySha256
      || !statuses.has(record.navigationStatus);
  })) throw new Error("gemini_rule_qa_navigation_binding_invalid");

  const qaSnapshot = createQaSnapshot({
    records: qaRecords,
    qaRevision: manifest.qaRevision,
    lexicalIndexBytes,
    recordsOwned: true,
    lexicalIndexBytesOwned: true,
    qaUnits: structureMapping.qaUnits,
    navigationRecords,
  });
  const focusedQa = createFocusedQaView({ qaRevision: manifest.qaRevision,
    items: [...qaSnapshot.qaUnitsByKey.values()] });
  const focusedByHandle = new Map(focusedQa.items.map((item) => [item.handle, item]));
  const frozenNavigationRecords = freezeTree(navigationRecords);
  const navigationByUnit = new Map(frozenNavigationRecords.map((record) => [record.unitKey, record]));
  const qaUnits = freezeTree((structureMapping.qaUnits || []).map((unit) => {
    const item = focusedByHandle.get(unit.handle || unit.parentHandle);
    if (!item) throw new Error("gemini_rule_qa_unit_item_binding_invalid");
    return { ...unit, handle: unit.handle || item.handle,
      parentHandle: unit.parentHandle || item.handle, item,
      navigation: navigationByUnit.get(unit.unitKey) || null };
  }));
  const frozenMapping = freezeTree(structureMapping);
  const handleUnitKeys = new Map();
  for (const unit of frozenMapping.qaUnits) {
    if (!handleUnitKeys.has(unit.parentHandle)) handleUnitKeys.set(unit.parentHandle, []);
    handleUnitKeys.get(unit.parentHandle).push(unit.unitKey);
  }
  for (const [handle, keys] of handleUnitKeys) handleUnitKeys.set(handle, Object.freeze(keys));
  const frozenRuleRecords = freezeTree(ruleRecords);
  const stableManifest = freezeTree(manifest);
  return Object.freeze({
    dataRevision: manifest.dataRevision,
    qaRevision: manifest.qaRevision,
    ruleRevision: manifest.ruleRevision,
    qaContentRevision: manifest.qaContentRevision,
    ruleContentRevision: manifest.ruleContentRevision,
    structureMappingRevision: manifest.structureMappingRevision,
    navigationRevision: manifest.navigationRevision,
    qaDenseRevision: manifest.qaDenseRevision,
    ruleDenseRevision: manifest.ruleDenseRevision,
    bundleRevision: manifest.bundleRevision,
    qaRecords: qaSnapshot.records,
    rulesRecords: frozenRuleRecords,
    ruleRecords: frozenRuleRecords,
    navigationRecords: frozenNavigationRecords,
    navigationRecordsByUnit: navigationByUnit,
    structureMapping: frozenMapping,
    qaUnits,
    qaUnitsByKey: new Map(qaUnits.map((unit) => [unit.unitKey, unit])),
    handleUnitKeys,
    manifest: stableManifest,
    createQaTools: (options = {}) => qaSnapshot.createQaTools(options),
  });
}

/**
 * Loads one immutable QA/rule bundle per process. The returned createQaTools
 * function creates request-scoped card associations while reusing the installed
 * BM25 index and frozen source records.
 */
export async function loadGeminiRuleQaAssets({ dataDir, assetDir } = {}) {
  const directory = resolve(assetDir || join(dataDir || "data", GEMINI_RULE_QA_ASSET_DIRECTORY));
  const manifestPreview = JSON.parse(await readFile(join(directory, GEMINI_RULE_QA_MANIFEST_FILE), "utf8"));
  const key = `${directory}\0${String(manifestPreview?.bundleRevision || "")}`;
  if (!processSnapshots.has(key)) {
    const startedAt = performance.now();
    const loading = loadUncached(directory).then((assets) => {
      if (assets.bundleRevision !== manifestPreview.bundleRevision) {
        throw new Error("gemini_rule_qa_manifest_changed_during_load");
      }
      const descriptors = ["qaRecords", "ruleRecords", "qaLexicalIndex", "structureMapping", "navigationRecords"]
        .map(key => assets.manifest.assets[key]);
      lastLoadedRelease = Object.freeze({ assetSchemaVersion: assets.manifest.schemaVersion,
        bundleRevision: assets.bundleRevision, dataRevision: assets.dataRevision,
        navigationRevision: assets.navigationRevision,
        structureMappingRevision: assets.structureMappingRevision,
        ruleDenseRevision: assets.ruleDenseRevision, qaDenseRevision: assets.qaDenseRevision,
        loadedAt: new Date().toISOString(), loadMs: performance.now() - startedAt,
        compressedBytes: descriptors.reduce((sum, value) => sum + value.bytes, 0),
        canonicalBytes: descriptors.reduce((sum, value) => sum + value.canonicalBytes, 0),
        processInitId, rssBytes: process.memoryUsage().rss });
      return assets;
    }).catch((error) => {
      processSnapshots.delete(key);
      throw error;
    });
    processSnapshots.set(key, loading);
  }
  return processSnapshots.get(key);
}

export function getLoadedGeminiEvidenceReleaseInfo() { return lastLoadedRelease; }

export function clearGeminiRuleQaAssetsCacheForTests() {
  processSnapshots.clear();
  lastLoadedRelease = null;
}
