import crypto from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const COMPRESSED_EVIDENCE_INDEX_FILE = "evidence-index.json.gz";
const LOGICAL_EVIDENCE_INDEX_FILE = "evidence-index.json";

export function ragDataPhysicalFileName(logicalName) {
  return logicalName === LOGICAL_EVIDENCE_INDEX_FILE
    ? COMPRESSED_EVIDENCE_INDEX_FILE
    : logicalName;
}

export async function readRagDataSourceBytes(dataDir, logicalName) {
  if (logicalName !== LOGICAL_EVIDENCE_INDEX_FILE) {
    return await readFile(join(dataDir, logicalName));
  }
  const compressedPath = join(dataDir, COMPRESSED_EVIDENCE_INDEX_FILE);
  let compressed;
  try {
    compressed = await readFile(compressedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Migration-only fallback. Once gzip exists, even a corrupt gzip must fail
    // instead of silently selecting the old representation.
    return await readFile(join(dataDir, LOGICAL_EVIDENCE_INDEX_FILE));
  }
  try {
    return await decompress(compressed);
  } catch (cause) {
    const error = new Error("rag_data_evidence_index_gzip_invalid", { cause });
    error.code = "RAG_DATA_SOURCE_GZIP_INVALID";
    throw error;
  }
}

export async function readRagDataSourceJson(dataDir, logicalName) {
  const bytes = await readRagDataSourceBytes(dataDir, logicalName);
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
}

export async function readOptionalRagDataSourceJson(dataDir, logicalName, fallback) {
  try {
    return await readRagDataSourceJson(dataDir, logicalName);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeEvidenceIndexJson(dataDir, value) {
  const original = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  JSON.parse(original.toString("utf8"));
  const compressed = await compress(original, { level: 9 });
  const roundTrip = await decompress(compressed);
  if (!roundTrip.equals(original)
      || sha256(roundTrip) !== sha256(original)) {
    throw new Error("rag_data_evidence_index_gzip_roundtrip_invalid");
  }
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = join(dataDir,
    `.${COMPRESSED_EVIDENCE_INDEX_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporaryPath, compressed, { flag: "wx" });
  const persisted = await readFile(temporaryPath);
  const persistedRoundTrip = await decompress(persisted);
  if (!persistedRoundTrip.equals(original)
      || sha256(persistedRoundTrip) !== sha256(original)) {
    throw new Error("rag_data_evidence_index_gzip_persisted_roundtrip_invalid");
  }
  JSON.parse(persistedRoundTrip.toString("utf8"));
  const outputPath = join(dataDir, COMPRESSED_EVIDENCE_INDEX_FILE);
  // rename is the only switch. If it fails, the old target and verified temp
  // remain available; this function deliberately does not clean the temp.
  await rename(temporaryPath, outputPath);
  try {
    await unlink(join(dataDir, LOGICAL_EVIDENCE_INDEX_FILE));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({
    logicalName: LOGICAL_EVIDENCE_INDEX_FILE,
    physicalName: COMPRESSED_EVIDENCE_INDEX_FILE,
    bytes: original.length,
    compressedBytes: compressed.length,
    sha256: sha256(original),
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
