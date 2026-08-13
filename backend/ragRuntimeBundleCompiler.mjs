import { constants as zlibConstants, brotliCompress } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRagDataRevisionManifest,
  createRagDataSourceDescriptor,
  RAG_DATA_REVISION_CANONICALIZATION_ABI,
  RAG_DATA_REVISION_SOURCE_FILES,
} from "./ragDataRevisionManifest.mjs";
import { compileRagCardAliasRuntimeIndex } from "./ragCardAliasRuntimeCompiler.mjs";
import {
  canonicalJsonBytes,
  loadRawGenericRuntimeBundle,
  RAG_RUNTIME_BUNDLE_ABI,
  RAG_RUNTIME_BUNDLE_COMPILER_ABI,
  RAG_RUNTIME_BUNDLE_DIRECTORY,
  RAG_RUNTIME_BUNDLE_MANIFEST_FILE,
  RAG_RUNTIME_BUNDLE_SCHEMA_VERSION,
  RAG_RUNTIME_AUXILIARY_ARTIFACTS,
  RAG_RUNTIME_CORPORA,
  recomputeBundleRevision,
  sha256,
} from "./rawGenericRuntimeBundle.mjs";

const compressBrotli = promisify(brotliCompress);
const DEFAULT_BROTLI_QUALITY = 5;

/**
 * Compile the exact normalized snapshot produced by the injected raw-source loader.
 * The loader is injectable so the production integration can call an explicit
 * raw-only entry point and avoid ever compiling a stale runtime bundle.
 */
export async function buildRagRuntimeBundle({
  dataDir,
  outputDir,
  loadNormalizedData,
  brotliQuality = DEFAULT_BROTLI_QUALITY,
} = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const resolvedOutputDir = outputDir || join(dataDir, RAG_RUNTIME_BUNDLE_DIRECTORY);
  if (typeof loadNormalizedData !== "function") throw new TypeError("loadNormalizedData must be a function");
  if (!Number.isInteger(brotliQuality) || brotliQuality < 0 || brotliQuality > 11) {
    throw new RangeError("brotliQuality must be an integer between 0 and 11");
  }

  const rawSources = await readRagRuntimeSources(dataDir);
  const data = await loadNormalizedData(dataDir);
  validateNormalizedData(data);
  const revisionManifest = buildRagDataRevisionManifest({
    data,
    sources: rawSources.map(({ descriptor }) => descriptor),
  });

  const corpora = {};
  const artifactBytes = new Map();
  for (const corpus of RAG_RUNTIME_CORPORA) {
    const canonicalBytes = canonicalJsonBytes(data[corpus.key]);
    const compressed = await compressBrotli(canonicalBytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: canonicalBytes.byteLength,
      },
    });
    artifactBytes.set(corpus.file, compressed);
    corpora[corpus.key] = Object.freeze({
      key: corpus.key,
      file: corpus.file,
      encoding: "br",
      bytes: compressed.byteLength,
      sha256: sha256(compressed),
      canonicalBytes: canonicalBytes.byteLength,
      canonicalSha256: sha256(canonicalBytes),
      count: data[corpus.key].length,
    });
  }

  const artifacts = {};
  const aliasSnapshot = compileRagCardAliasRuntimeIndex(data.cards);
  for (const artifact of RAG_RUNTIME_AUXILIARY_ARTIFACTS) {
    const value = artifact.key === "cardAliasIndex" ? aliasSnapshot : null;
    if (!value) throw new TypeError(`unsupported RAG runtime artifact: ${artifact.key}`);
    const canonicalBytes = canonicalJsonBytes(value);
    const compressed = await compressBrotli(canonicalBytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: canonicalBytes.byteLength,
      },
    });
    artifactBytes.set(artifact.file, compressed);
    artifacts[artifact.key] = Object.freeze({
      key: artifact.key,
      file: artifact.file,
      encoding: "br",
      schemaVersion: artifact.schemaVersion,
      compilerAbi: artifact.compilerAbi,
      bytes: compressed.byteLength,
      sha256: sha256(compressed),
      canonicalBytes: canonicalBytes.byteLength,
      canonicalSha256: sha256(canonicalBytes),
      count: data[artifact.countKey].length,
    });
  }

  const manifestWithoutRevision = {
    schemaVersion: RAG_RUNTIME_BUNDLE_SCHEMA_VERSION,
    kind: "rag-runtime-bundle",
    compilerAbi: RAG_RUNTIME_BUNDLE_COMPILER_ABI,
    runtimeAbi: RAG_RUNTIME_BUNDLE_ABI,
    canonicalizationAbi: RAG_DATA_REVISION_CANONICALIZATION_ABI,
    compression: Object.freeze({ algorithm: "brotli", quality: brotliQuality }),
    dataRevision: revisionManifest.revision,
    sourceSetDigest: revisionManifest.sourceSetDigest,
    sources: rawSources.map(({ descriptor, count }) => Object.freeze({ ...descriptor, count })),
    counts: Object.freeze({
      cards: data.cards.length,
      records: data.records.length,
      qaRecords: data.qaRecords.length,
    }),
    corpora: Object.freeze(corpora),
    artifacts: Object.freeze(artifacts),
  };
  const manifest = Object.freeze({
    ...manifestWithoutRevision,
    bundleRevision: recomputeBundleRevision(manifestWithoutRevision),
  });

  await mkdir(resolvedOutputDir, { recursive: true });
  for (const corpus of RAG_RUNTIME_CORPORA) {
    await writeFile(join(resolvedOutputDir, corpus.file), artifactBytes.get(corpus.file));
  }
  for (const artifact of RAG_RUNTIME_AUXILIARY_ARTIFACTS) {
    await writeFile(join(resolvedOutputDir, artifact.file), artifactBytes.get(artifact.file));
  }
  // Commit marker is written last. A process interrupted above leaves a bundle
  // that the runtime loader rejects instead of mixing old and new corpora.
  await writeFile(
    join(resolvedOutputDir, RAG_RUNTIME_BUNDLE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return Object.freeze({ manifest, revisionManifest, outputDir: resolvedOutputDir });
}

export async function checkRagRuntimeBundle({
  dataDir,
  bundleDir,
  loadNormalizedData,
} = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const resolvedBundleDir = bundleDir || join(dataDir, RAG_RUNTIME_BUNDLE_DIRECTORY);
  if (typeof loadNormalizedData !== "function") throw new TypeError("loadNormalizedData must be a function");
  const rawSources = await readRagRuntimeSources(dataDir);
  const expectedData = await loadNormalizedData(dataDir);
  validateNormalizedData(expectedData);
  const sourceRevisionManifest = buildRagDataRevisionManifest({
    data: expectedData,
    sources: rawSources.map(({ descriptor }) => descriptor),
  });
  const loaded = await loadRawGenericRuntimeBundle({
    dataDir,
    bundleDir: resolvedBundleDir,
    sourceRevisionManifest,
  });
  if (!loaded.ok) return loaded;

  const mismatches = [];
  for (const corpus of RAG_RUNTIME_CORPORA) {
    const expectedBytes = canonicalJsonBytes(expectedData[corpus.key]);
    const descriptor = loaded.manifest.corpora[corpus.key];
    if (expectedData[corpus.key].length !== loaded.data[corpus.key].length) {
      mismatches.push(`${corpus.key}:count`);
    }
    if (sha256(expectedBytes) !== descriptor.canonicalSha256) {
      mismatches.push(`${corpus.key}:canonical_hash`);
    }
  }
  const expectedAliasBytes = canonicalJsonBytes(compileRagCardAliasRuntimeIndex(expectedData.cards));
  const aliasDescriptor = loaded.manifest.artifacts.cardAliasIndex;
  if (aliasDescriptor.count !== expectedData.cards.length) mismatches.push("cardAliasIndex:count");
  if (sha256(expectedAliasBytes) !== aliasDescriptor.canonicalSha256) {
    mismatches.push("cardAliasIndex:canonical_hash");
  }
  if (mismatches.length) {
    return Object.freeze({
      ok: false,
      source: "legacy_raw_fallback_required",
      reason: "runtime_bundle_not_equivalent",
      reasons: Object.freeze(mismatches),
      data: null,
    });
  }
  return Object.freeze({
    ...loaded,
    equivalent: true,
  });
}

export async function readRagRuntimeSources(dataDir) {
  return await Promise.all(RAG_DATA_REVISION_SOURCE_FILES.map(async (path) => {
    const raw = await readFile(join(dataDir, path));
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new Error(`invalid JSON in RAG source ${path}`, { cause: error });
    }
    return Object.freeze({
      path,
      descriptor: createRagDataSourceDescriptor(path, raw),
      count: sourceRecordCount(payload),
    });
  }));
}

function sourceRecordCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  for (const key of ["records", "cards", "entries", "officialResponses"]) {
    if (Array.isArray(payload?.[key])) return payload[key].length;
  }
  return 0;
}

function validateNormalizedData(data) {
  for (const key of ["cards", "records", "qaRecords"]) {
    if (!Array.isArray(data?.[key])) throw new TypeError(`normalized RAG data.${key} must be an array`);
  }
}
