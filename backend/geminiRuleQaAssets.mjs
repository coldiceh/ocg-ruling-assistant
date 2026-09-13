import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

import { createQaSnapshot } from "./geminiQaTools.mjs";

export const GEMINI_RULE_QA_ASSET_DIRECTORY = "gemini-rule-qa-v1";
export const GEMINI_RULE_QA_MANIFEST_FILE = "manifest.json";
export const GEMINI_RULE_QA_ASSET_SCHEMA_VERSION = 1;

const FILES = Object.freeze({
  qaRecords: "qa-records.json.gz",
  ruleRecords: "rule-records.json.gz",
  qaLexicalIndex: "qa-lexical-index.bm25.gz",
});
const SHA256 = /^[a-f0-9]{64}$/u;
const decompressGzip = promisify(gunzip);
const processSnapshots = new Map();

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
      || !SHA256.test(String(manifest.bundleRevision || ""))
      || !Number.isSafeInteger(manifest.counts?.qaRecords) || manifest.counts.qaRecords < 0
      || !Number.isSafeInteger(manifest.counts?.ruleRecords) || manifest.counts.ruleRecords < 0) {
    throw new Error("gemini_rule_qa_manifest_invalid");
  }
  const qaSourceDescriptors = [manifest.sources?.qaIndex, manifest.sources?.rulings]
    .map((source) => ({ file: source?.file, bytes: source?.bytes, sha256: source?.sha256 }));
  if (sha256(stableJson(qaSourceDescriptors)) !== manifest.qaRevision
      || manifest.sources?.rules?.sha256 !== manifest.ruleRevision
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

async function loadUncached(assetDir) {
  const manifestBytes = await readFile(join(assetDir, GEMINI_RULE_QA_MANIFEST_FILE));
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    if (String(error?.message || "").startsWith("gemini_rule_qa_")) throw error;
    throw new Error("gemini_rule_qa_manifest_invalid", { cause: error });
  }
  const [qaBytes, ruleBytes, lexicalIndexBytes] = await Promise.all([
    readBoundAsset(assetDir, manifest.assets.qaRecords),
    readBoundAsset(assetDir, manifest.assets.ruleRecords),
    readBoundAsset(assetDir, manifest.assets.qaLexicalIndex),
  ]);
  let qaRecords;
  let ruleRecords;
  try {
    qaRecords = JSON.parse(qaBytes.toString("utf8"));
    ruleRecords = JSON.parse(ruleBytes.toString("utf8"));
  } catch (error) {
    throw new Error("gemini_rule_qa_asset_json_invalid", { cause: error });
  }
  if (!Array.isArray(qaRecords) || qaRecords.length !== manifest.counts.qaRecords
      || !Array.isArray(ruleRecords) || ruleRecords.length !== manifest.counts.ruleRecords) {
    throw new Error("gemini_rule_qa_asset_count_invalid");
  }

  const qaSnapshot = createQaSnapshot({
    records: qaRecords,
    qaRevision: manifest.qaRevision,
    lexicalIndexBytes,
  });
  const frozenRuleRecords = freezeTree(ruleRecords);
  const stableManifest = freezeTree(structuredClone(manifest));
  return Object.freeze({
    dataRevision: manifest.dataRevision,
    qaRevision: manifest.qaRevision,
    ruleRevision: manifest.ruleRevision,
    bundleRevision: manifest.bundleRevision,
    qaRecords: qaSnapshot.records,
    rulesRecords: frozenRuleRecords,
    ruleRecords: frozenRuleRecords,
    manifest: stableManifest,
    createQaTools: (options = {}) => qaSnapshot.createQaTools(options),
  });
}

/**
 * Loads one immutable QA/rule bundle per process. The returned createQaTools
 * function creates request-scoped card associations while reusing the installed
 * BM25 index and frozen source records.
 */
export function loadGeminiRuleQaAssets({ dataDir, assetDir } = {}) {
  const directory = resolve(assetDir || join(dataDir || "data", GEMINI_RULE_QA_ASSET_DIRECTORY));
  if (!processSnapshots.has(directory)) {
    const loading = loadUncached(directory).catch((error) => {
      processSnapshots.delete(directory);
      throw error;
    });
    processSnapshots.set(directory, loading);
  }
  return processSnapshots.get(directory);
}

export function clearGeminiRuleQaAssetsCacheForTests() {
  processSnapshots.clear();
}
