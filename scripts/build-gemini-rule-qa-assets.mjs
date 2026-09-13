import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

import { createQaSnapshot } from "../backend/geminiQaTools.mjs";
import {
  GEMINI_RULE_QA_ASSET_DIRECTORY,
  GEMINI_RULE_QA_ASSET_SCHEMA_VERSION,
  GEMINI_RULE_QA_MANIFEST_FILE,
} from "../backend/geminiRuleQaAssets.mjs";

const compressGzip = promisify(gzip);
const decompressGzip = promisify(gunzip);
const QA_TYPES = new Set(["qa", "card-faq"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function parseRecords(bytes, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`gemini_rule_qa_${sourceName}_json_invalid`, { cause: error });
  }
  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(records)) throw new Error(`gemini_rule_qa_${sourceName}_records_invalid`);
  return records;
}

async function readExistingIndex(outputDir, qaRevision) {
  try {
    const manifest = JSON.parse(await readFile(join(outputDir, GEMINI_RULE_QA_MANIFEST_FILE), "utf8"));
    if (manifest?.qaRevision !== qaRevision
        || manifest?.assets?.qaLexicalIndex?.file !== "qa-lexical-index.bm25.gz") return null;
    const compressed = await readFile(join(outputDir, manifest.assets.qaLexicalIndex.file));
    if (compressed.byteLength !== manifest.assets.qaLexicalIndex.bytes
        || sha256(compressed) !== manifest.assets.qaLexicalIndex.sha256) return null;
    return await decompressGzip(compressed);
  } catch {
    return null;
  }
}

async function selectReusableIndex({ outputDir, reuseIndexPath, qaRevision }) {
  if (reuseIndexPath) {
    if (!resolve(reuseIndexPath).toLowerCase().endsWith(`${qaRevision}.bm25`.toLowerCase())) {
      throw new Error("gemini_rule_qa_reuse_index_revision_invalid");
    }
    return { bytes: await readFile(resolve(reuseIndexPath)), source: "explicit" };
  }
  const existing = await readExistingIndex(outputDir, qaRevision);
  return existing ? { bytes: existing, source: "existing_bundle" } : null;
}

function descriptor(file, compressed, canonical) {
  return Object.freeze({
    file,
    encoding: "gzip",
    bytes: compressed.byteLength,
    sha256: sha256(compressed),
    canonicalBytes: canonical.byteLength,
    canonicalSha256: sha256(canonical),
  });
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

/** Build only mechanical, byte-bound QA/rule assets; no model or embedding call occurs. */
export async function buildGeminiRuleQaAssets({
  dataDir,
  outputDir,
  reuseIndexPath,
} = {}) {
  const sourceDir = resolve(dataDir || "data");
  const destination = resolve(outputDir || join(sourceDir, GEMINI_RULE_QA_ASSET_DIRECTORY));
  const rulingsPath = join(sourceDir, "rulings.json");
  const qaIndexPath = join(sourceDir, "qa-index.json");
  const rulesPath = join(sourceDir, "ocg-rule-corpus.json");
  const revisionPath = join(sourceDir, "rag-data-revision-manifest.json");
  const [rulingsBytes, qaIndexBytes, rulesBytes, revisionBytes] = await Promise.all([
    readFile(rulingsPath),
    readFile(qaIndexPath),
    readFile(rulesPath),
    readFile(revisionPath),
  ]);
  const qaSources = [
    { file: "qa-index.json", bytes: qaIndexBytes.byteLength, sha256: sha256(qaIndexBytes) },
    { file: "rulings.json", bytes: rulingsBytes.byteLength, sha256: sha256(rulingsBytes) },
  ];
  const qaRevision = sha256(stableJson(qaSources));
  const ruleRevision = sha256(rulesBytes);
  let revisionManifest;
  try {
    revisionManifest = JSON.parse(revisionBytes.toString("utf8"));
  } catch (error) {
    throw new Error("gemini_rule_qa_data_revision_manifest_invalid", { cause: error });
  }
  const dataRevision = String(revisionManifest?.revision || "");
  if (!/^[a-f0-9]{64}$/u.test(dataRevision)) {
    throw new Error("gemini_rule_qa_data_revision_invalid");
  }
  const qaRecords = [];
  const qaIds = new Set();
  for (const record of parseRecords(qaIndexBytes, "qa_index")) {
    if (!QA_TYPES.has(String(record?.recordType || ""))) continue;
    const id = String(record?.id || "").trim();
    if (!id || qaIds.has(id)) throw new Error("gemini_rule_qa_qa_index_identity_invalid");
    qaIds.add(id);
    qaRecords.push(record);
  }
  for (const record of parseRecords(rulingsBytes, "rulings")) {
    if (!QA_TYPES.has(String(record?.recordType || ""))) continue;
    const id = String(record?.id || "").trim();
    if (!id) throw new Error("gemini_rule_qa_rulings_identity_invalid");
    if (qaIds.has(id)) continue;
    qaIds.add(id);
    qaRecords.push(record);
  }
  const ruleRecords = parseRecords(rulesBytes, "rules")
    .filter((record) => String(record?.recordType || "") === "rule-doc");
  const qaSnapshot = createQaSnapshot({ records: qaRecords, qaRevision });
  const reusable = await selectReusableIndex({ outputDir: destination, reuseIndexPath, qaRevision });
  let lexicalIndexBytes;
  let indexSource = "rebuilt";
  if (reusable) {
    qaSnapshot.installLexicalIndex(reusable.bytes);
    lexicalIndexBytes = reusable.bytes;
    indexSource = reusable.source;
  } else {
    lexicalIndexBytes = qaSnapshot.buildLexicalIndex();
  }

  const qaCanonical = Buffer.from(JSON.stringify(qaSnapshot.records), "utf8");
  const ruleCanonical = Buffer.from(JSON.stringify(ruleRecords), "utf8");
  const [qaCompressed, ruleCompressed, indexCompressed] = await Promise.all([
    compressGzip(qaCanonical, { level: 9, mtime: 0 }),
    compressGzip(ruleCanonical, { level: 9, mtime: 0 }),
    compressGzip(lexicalIndexBytes, { level: 9, mtime: 0 }),
  ]);
  const assets = {
    qaRecords: descriptor("qa-records.json.gz", qaCompressed, qaCanonical),
    ruleRecords: descriptor("rule-records.json.gz", ruleCompressed, ruleCanonical),
    qaLexicalIndex: descriptor("qa-lexical-index.bm25.gz", indexCompressed, lexicalIndexBytes),
  };
  const manifestWithoutRevision = {
    schemaVersion: GEMINI_RULE_QA_ASSET_SCHEMA_VERSION,
    kind: "gemini-rule-qa-assets",
    dataRevision,
    qaRevision,
    ruleRevision,
    sources: {
      qaIndex: qaSources[0],
      rulings: qaSources[1],
      rules: { file: "ocg-rule-corpus.json", bytes: rulesBytes.byteLength, sha256: ruleRevision },
      ragDataRevision: {
        file: "rag-data-revision-manifest.json",
        bytes: revisionBytes.byteLength,
        sha256: sha256(revisionBytes),
        revision: dataRevision,
      },
    },
    counts: { qaRecords: qaSnapshot.snapshotSize, ruleRecords: ruleRecords.length },
    assets,
  };
  const manifest = {
    ...manifestWithoutRevision,
    bundleRevision: sha256(stableJson(manifestWithoutRevision)),
  };

  await mkdir(destination, { recursive: true });
  await Promise.all([
    atomicWrite(join(destination, assets.qaRecords.file), qaCompressed),
    atomicWrite(join(destination, assets.ruleRecords.file), ruleCompressed),
    atomicWrite(join(destination, assets.qaLexicalIndex.file), indexCompressed),
  ]);
  await atomicWrite(
    join(destination, GEMINI_RULE_QA_MANIFEST_FILE),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  return Object.freeze({ outputDir: destination, manifest, indexSource });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = await buildGeminiRuleQaAssets({
    dataDir: resolve(argument("--data-dir") || join(projectRoot, "data")),
    outputDir: resolve(argument("--output-dir") || join(projectRoot, "data", GEMINI_RULE_QA_ASSET_DIRECTORY)),
    reuseIndexPath: argument("--reuse-index") || undefined,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputDir: result.outputDir,
    qaRevision: result.manifest.qaRevision,
    ruleRevision: result.manifest.ruleRevision,
    dataRevision: result.manifest.dataRevision,
    bundleRevision: result.manifest.bundleRevision,
    counts: result.manifest.counts,
    assets: Object.fromEntries(Object.entries(result.manifest.assets).map(([key, value]) => [key, {
      compressedBytes: value.bytes,
      canonicalBytes: value.canonicalBytes,
    }])),
    indexSource: result.indexSource,
  })}\n`);
}
