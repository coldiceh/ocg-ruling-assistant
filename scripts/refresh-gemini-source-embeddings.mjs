import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  createLocalEvidencePreprocessBudget,
  createLocalEvidencePreprocessCache,
  denseCacheKey,
  sha256,
  stableJson,
} from "./lib/evidence-preprocess-cache.mjs";
import { createCloudEvidencePreprocessResources } from "./lib/evidence-preprocess-cloud.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSION = 768;
export const EMBEDDING_PRICE_USD_PER_MILLION = 0.20;
export const EMBEDDING_MAX_INPUT_TOKENS = 8192;
export const EMBEDDING_INPUT_CONTRACT = Object.freeze({
  dimension: EMBEDDING_DIMENSION,
  documentTemplate: "title: ${unit.sourceSection.titlePath.join(' / ') || unit.title || 'none'} | text: ${unit.text}",
  model: EMBEDDING_MODEL,
  queryTemplate: "task: question answering | query: ${query}",
});
export const EMBEDDING_INPUT_CONTRACT_SHA256 = sha256(stableJson(EMBEDDING_INPUT_CONTRACT));

export function validateDenseInputs(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.rule) || !Array.isArray(value.qa)) {
    throw codedError("dense_inputs_invalid", 5);
  }
  return {
    schemaVersion: 1,
    rule: validateCollection(value.rule, "rule"),
    qa: validateCollection(value.qa, "qa"),
  };
}

function validateCollection(rows, sourceKind) {
  const ids = new Set();
  return rows.map((row) => {
    const common = row && row.sourceKind === sourceKind
      && typeof row.denseUnitId === "string" && row.denseUnitId && !ids.has(row.denseUnitId)
      && typeof row.sourceId === "string" && row.sourceId
      && /^[a-f0-9]{64}$/u.test(String(row.sourceCanonicalSha256 || ""))
      && typeof row.embeddingInput === "string" && row.embeddingInput
      && /^[a-f0-9]{64}$/u.test(String(row.embeddingInputSha256 || ""))
      && sha256(row.embeddingInput) === row.embeddingInputSha256;
    if (!common) throw codedError(`dense_input_binding_invalid:${sourceKind}`, 5);
    if (sourceKind === "rule") {
      if (row.offsetEncoding !== "utf16" || !Number.isInteger(row.start) || !Number.isInteger(row.end)
          || row.start < 0 || row.end <= row.start || !Array.isArray(row.readingUnitKeys)) {
        throw codedError(`dense_rule_locator_invalid:${row.denseUnitId}`, 5);
      }
    }
    ids.add(row.denseUnitId);
    return row;
  });
}

export async function planEmbeddingRefresh({ denseInputs, dataDir, cache }) {
  const plans = {};
  for (const kind of ["rule", "qa"]) {
    const oldIndex = await loadExistingVectorIndex(join(dataDir, `${kind}-embedding-v1`));
    const unique = uniqueInputs(denseInputs[kind]);
    const rows = [];
    for (const item of unique) {
      const key = denseCacheKey({
        embeddingModel: EMBEDDING_MODEL,
        dimension: EMBEDDING_DIMENSION,
        embeddingInputContractHash: EMBEDDING_INPUT_CONTRACT_SHA256,
        embeddingInputTextHash: item.embeddingInputSha256,
      });
      const oldEntry = oldIndex.entries.get(item.embeddingInputSha256) || null;
      const cached = oldEntry ? null : await cache.readResult("dense", key);
      const rawPointer = oldEntry || cached ? null : await cache.readResult("dense", key, "raw");
      rows.push({
        item,
        key,
        state: oldEntry ? "existing_vector" : cached ? "cache_hit" : rawPointer ? "raw_reusable" : "generation_miss",
        oldEntry,
        cached,
        rawPointer,
      });
    }
    plans[kind] = {
      kind,
      oldIndex,
      inputRows: denseInputs[kind],
      rows,
      orderedContentHashes: unique.map((row) => row.embeddingInputSha256),
    };
  }
  return plans;
}

export async function runEmbeddingRefresh({
  denseInputs,
  dataDir,
  outDir,
  cache,
  execute = false,
  maxUsd = null,
  ledgerPath = null,
  budget = null,
  embedBatch,
  batchSize = 100,
} = {}) {
  const plans = await planEmbeddingRefresh({ denseInputs, dataDir, cache });
  const resolvedBudget = budget || (ledgerPath
    ? createLocalEvidencePreprocessBudget({ ledgerPath, maxUsd: maxUsd > 0 ? maxUsd : Number.MAX_VALUE })
    : null);
  const report = {
    schemaVersion: 1,
    mode: execute ? "execute" : "dry-run",
    model: EMBEDDING_MODEL,
    dimension: EMBEDDING_DIMENSION,
    inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
    collections: {},
  };
  for (const kind of ["rule", "qa"]) {
    const plan = plans[kind];
    const misses = plan.rows.filter((row) => row.state === "generation_miss");
    report.collections[kind] = {
      denseUnitCount: plan.inputRows.length,
      uniqueInputCount: plan.rows.length,
      existingVectorHits: plan.rows.filter((row) => row.state === "existing_vector").length,
      persistentCacheHits: plan.rows.filter((row) => row.state === "cache_hit").length,
      reusableRawResponses: plan.rows.filter((row) => row.state === "raw_reusable").length,
      generationMisses: misses.length,
      inputChars: misses.reduce((sum, row) => sum + row.item.embeddingInput.length, 0),
      inputBytes: misses.reduce((sum, row) => sum + Buffer.byteLength(row.item.embeddingInput, "utf8"), 0),
      inputTokenEstimate: { status: "conservative_model_limit", upperBound: misses.length * EMBEDDING_MAX_INPUT_TOKENS },
      conservativeQuoteUsd: misses.length * EMBEDDING_MAX_INPUT_TOKENS * EMBEDDING_PRICE_USD_PER_MILLION / 1_000_000,
    };
  }
  if (!execute) return { report, plans };
  if (!outDir) throw codedError("embedding_output_dir_required", 2);
  const totalMisses = Object.values(plans).reduce((sum, plan) => sum + plan.rows.filter((row) => row.state === "generation_miss").length, 0);
  const reusableRaw = Object.values(plans).some((plan) => plan.rows.some((row) => row.state === "raw_reusable"));
  if ((totalMisses && (typeof embedBatch !== "function" || !(maxUsd > 0)))
      || ((totalMisses || reusableRaw) && !resolvedBudget)) {
    throw codedError("embedding_execute_configuration_incomplete", 2);
  }

  for (const kind of ["rule", "qa"]) {
    for (const row of plans[kind].rows.filter((candidate) => candidate.state === "raw_reusable")) {
      await materializeDenseRaw({ row, cache, budget: resolvedBudget });
    }
    await fillEmbeddingMisses({ plan: plans[kind], cache, embedBatch, budget: resolvedBudget, batchSize });
    await assembleEmbeddingIndex({ plan: plans[kind], destination: join(outDir, `${kind}-embedding-v1`) });
  }
  return { report, plans, exitCode: 0 };
}

async function fillEmbeddingMisses({ plan, cache, embedBatch, budget, batchSize }) {
  const misses = plan.rows.filter((row) => row.state === "generation_miss");
  for (let offset = 0; offset < misses.length; offset += batchSize) {
    const candidates = misses.slice(offset, offset + batchSize);
    const requestKey = sha256(stableJson({
      kind: plan.kind,
      model: EMBEDDING_MODEL,
      dimension: EMBEDDING_DIMENSION,
      inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
      inputHashes: candidates.map((row) => row.item.embeddingInputSha256),
    }));
    const requestTicket = `dense-${plan.kind}-${requestKey}`;
    const claimed = [];
    const unresolved = [];
    for (const row of candidates) {
      const claim = await cache.claim("dense", row.key, requestTicket);
      if (claim.status === "claimed") {
        claimed.push(row);
        continue;
      }
      const completed = claim.status === "complete" ? claim.value : await cache.readResult("dense", row.key);
      if (completed) {
        validateVector(completed.vector);
        row.cached = completed;
        row.state = "cache_hit";
      } else {
        unresolved.push({ row, claim });
      }
    }
    let batchRaw = await cache.readResult("dense-batch", requestKey, "raw");
    if (batchRaw && unresolved.length && typeof cache.adoptClaim === "function") {
      for (let index = unresolved.length - 1; index >= 0; index -= 1) {
        const pending = unresolved[index];
        if (pending.claim?.claim?.ticket !== requestTicket) continue;
        const adopted = await cache.adoptClaim("dense", pending.row.key, requestTicket, pending.claim.claim);
        if (adopted.status === "adopted") {
          claimed.push(pending.row);
          unresolved.splice(index, 1);
        }
      }
    }
    if (unresolved.length) {
      for (const row of claimed) await cache.releaseClaim?.("dense", row.key, requestTicket);
      throw codedError(`embedding_cache_claim_busy:${unresolved.length}`, 3);
    }
    if (!claimed.length) continue;
    let batchClaimOwned = false;
    if (!batchRaw) {
      const batchClaim = await cache.claim("dense-batch", requestKey, requestTicket);
      if (batchClaim.status === "claimed") batchClaimOwned = true;
      else if (batchClaim.status === "raw_reusable") batchRaw = batchClaim.value;
      else if (batchClaim.status !== "claimed") {
        batchRaw = await cache.readResult("dense-batch", requestKey, "raw");
        if (!batchRaw) {
          for (const row of claimed) await cache.releaseClaim?.("dense", row.key, requestTicket);
          throw codedError("embedding_batch_raw_claim_busy", 3);
        }
      }
    }
    if (batchRaw) {
      for (const row of claimed) {
        const vectorIndex = batchRaw.inputHashes?.indexOf(row.item.embeddingInputSha256);
        if (!Number.isInteger(vectorIndex) || vectorIndex < 0) throw codedError("embedding_raw_batch_binding_invalid", 5);
        await cache.writeRaw("dense", row.key, { ticket: requestTicket, value: makeDenseRawPointer(row, batchRaw, vectorIndex) });
        row.rawPointer = await cache.readResult("dense", row.key, "raw");
        row.state = "raw_reusable";
        await materializeDenseRaw({ row, cache, budget });
      }
      continue;
    }
    const reserve = claimed.length * EMBEDDING_MAX_INPUT_TOKENS * EMBEDDING_PRICE_USD_PER_MILLION / 1_000_000;
    try {
      await budget.reserve({ ticket: requestTicket, amountUsd: reserve });
    } catch (error) {
      for (const row of claimed) await cache.releaseClaim("dense", row.key, requestTicket);
      if (batchClaimOwned) await cache.releaseClaim("dense-batch", requestKey, requestTicket);
      throw error;
    }
    const raw = await embedBatch(claimed.map((row) => row.item.embeddingInput), {
      model: EMBEDDING_MODEL,
      dimension: EMBEDDING_DIMENSION,
      autoTruncate: false,
      requestTicket,
    });
    const vectors = raw?.embeddings?.map((embedding) => embedding?.values);
    const tokens = raw?.usageMetadata?.promptTokenCount;
    const spentUsd = Number.isSafeInteger(tokens) && tokens >= 0
      ? tokens * EMBEDDING_PRICE_USD_PER_MILLION / 1_000_000
      : null;
    batchRaw = {
      schemaVersion: 1,
      kind: "dense-batch-raw",
      key: requestKey,
      requestTicket,
      inputHashes: claimed.map((row) => row.item.embeddingInputSha256),
      rawResponse: raw,
      reservedUsd: reserve,
      spentUsd,
    };
    await cache.writeRaw("dense-batch", requestKey, { ticket: requestTicket, value: batchRaw });
    for (let index = 0; index < claimed.length; index += 1) {
      await cache.writeRaw("dense", claimed[index].key, {
        ticket: requestTicket,
        value: makeDenseRawPointer(claimed[index], batchRaw, index),
      });
    }
    if (!Array.isArray(vectors) || vectors.length !== claimed.length) throw new Error("embedding_response_count_invalid");
    for (let index = 0; index < claimed.length; index += 1) {
      validateVector(vectors[index]);
      const row = claimed[index];
      const value = {
        schemaVersion: 1,
        kind: "dense",
        key: row.key,
        inputKey: row.item.embeddingInputSha256,
        requestTicket,
        vector: vectors[index],
      };
      await cache.writeResult("dense", row.key, { value });
      row.cached = value;
      row.state = "cache_hit";
    }
    if (spentUsd !== null) await budget.settle({ ticket: requestTicket, spentUsd });
  }
}

function makeDenseRawPointer(row, batchRaw, vectorIndex) {
  return {
    schemaVersion: 1,
    kind: "dense-raw-pointer",
    key: row.key,
    inputKey: row.item.embeddingInputSha256,
    requestTicket: batchRaw.requestTicket,
    batchKey: batchRaw.key,
    vectorIndex,
  };
}

async function materializeDenseRaw({ row, cache, budget }) {
  const pointer = row.rawPointer;
  if (pointer?.kind !== "dense-raw-pointer" || pointer.key !== row.key
      || pointer.inputKey !== row.item.embeddingInputSha256
      || !/^[a-f0-9]{64}$/u.test(String(pointer.batchKey || ""))
      || !Number.isInteger(pointer.vectorIndex) || pointer.vectorIndex < 0) {
    throw codedError("embedding_raw_pointer_invalid", 5);
  }
  const batch = await cache.readResult("dense-batch", pointer.batchKey, "raw");
  const vectors = batch?.rawResponse?.embeddings?.map((embedding) => embedding?.values);
  if (batch?.kind !== "dense-batch-raw" || batch.key !== pointer.batchKey
      || batch.requestTicket !== pointer.requestTicket || !Array.isArray(batch.inputHashes)
      || batch.inputHashes[pointer.vectorIndex] !== row.item.embeddingInputSha256
      || !Array.isArray(vectors) || vectors.length !== batch.inputHashes.length
      || (batch.spentUsd !== null && (!Number.isFinite(batch.spentUsd) || batch.spentUsd < 0))
      || !Number.isFinite(batch.reservedUsd) || batch.reservedUsd <= 0
      || (batch.spentUsd !== null && batch.spentUsd > batch.reservedUsd)) {
    throw codedError("embedding_raw_batch_binding_invalid", 5);
  }
  const vector = vectors[pointer.vectorIndex];
  validateVector(vector);
  if (batch.spentUsd !== null) {
    if (!budget) throw codedError("embedding_raw_replay_ledger_required", 2);
    await budget.settle({ ticket: batch.requestTicket, spentUsd: batch.spentUsd });
  }
  const value = {
    schemaVersion: 1,
    kind: "dense",
    key: row.key,
    inputKey: row.item.embeddingInputSha256,
    requestTicket: batch.requestTicket,
    vector,
  };
  await cache.writeResult("dense", row.key, { value });
  row.cached = value;
  row.state = "cache_hit";
}

export async function assembleEmbeddingIndex({ plan, destination }) {
  const rowBytes = EMBEDDING_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
  const bytes = Buffer.alloc(plan.rows.length * rowBytes);
  const oldShards = new Map();
  for (let rowIndex = 0; rowIndex < plan.rows.length; rowIndex += 1) {
    const row = plan.rows[rowIndex];
    let vectorBytes;
    if (row.oldEntry) {
      const descriptor = plan.oldIndex.manifest.shards[row.oldEntry.shardIndex];
      if (!oldShards.has(row.oldEntry.shardIndex)) {
        oldShards.set(row.oldEntry.shardIndex, await readVerifiedShard(plan.oldIndex.directory, descriptor));
      }
      const shard = oldShards.get(row.oldEntry.shardIndex);
      const start = row.oldEntry.rowIndex * rowBytes;
      vectorBytes = shard.subarray(start, start + rowBytes);
    } else {
      validateVector(row.cached?.vector);
      vectorBytes = vectorToBytes(row.cached.vector);
    }
    vectorBytes.copy(bytes, rowIndex * rowBytes);
  }
  const dataRevision = sha256(stableJson({
    kind: plan.kind,
    model: EMBEDDING_MODEL,
    dimension: EMBEDDING_DIMENSION,
    inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
    orderedContentHashes: plan.orderedContentHashes,
  }));
  const shard = {
    index: 0,
    file: "evidence-vectors-000.f32",
    rowCount: plan.rows.length,
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
  const manifest = {
    schemaVersion: 1,
    kind: "evidence-vector-index",
    encoding: "raw-little-endian-float32",
    dataRevision,
    model: { id: EMBEDDING_MODEL, revision: EMBEDDING_MODEL },
    dimension: EMBEDDING_DIMENSION,
    inputContract: EMBEDDING_INPUT_CONTRACT,
    inputContractSha256: EMBEDDING_INPUT_CONTRACT_SHA256,
    orderedContentHashes: plan.orderedContentHashes,
    orderedContentHashesSha256: sha256(JSON.stringify(plan.orderedContentHashes)),
    uniqueContentCount: plan.rows.length,
    entries: plan.rows.map((row, rowIndex) => ({ textSha256: row.item.embeddingInputSha256, shardIndex: 0, rowIndex })),
    shards: [shard],
    vectorByteLength: bytes.length,
    shardSetSha256: sha256(JSON.stringify([{ index: 0, byteLength: bytes.length, sha256: shard.sha256 }])),
  };
  await mkdir(destination, { recursive: true });
  await writeImmutable(join(destination, shard.file), bytes);
  await writeImmutable(join(destination, "evidence-vector-index.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return manifest;
}

async function loadExistingVectorIndex(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "evidence-vector-index.json"), "utf8"));
  if (manifest?.schemaVersion !== 1 || manifest.kind !== "evidence-vector-index"
      || manifest.encoding !== "raw-little-endian-float32"
      || manifest.model?.id !== EMBEDDING_MODEL || manifest.model?.revision !== EMBEDDING_MODEL
      || manifest.dimension !== EMBEDDING_DIMENSION
      || manifest.inputContractSha256 !== EMBEDDING_INPUT_CONTRACT_SHA256
      || stableJson(manifest.inputContract) !== stableJson(EMBEDDING_INPUT_CONTRACT)
      || !Array.isArray(manifest.orderedContentHashes)
      || !Array.isArray(manifest.entries) || !Array.isArray(manifest.shards)
      || manifest.uniqueContentCount !== manifest.entries.length
      || manifest.entries.length !== manifest.orderedContentHashes.length
      || manifest.orderedContentHashesSha256 !== sha256(JSON.stringify(manifest.orderedContentHashes))) {
    throw codedError("existing_embedding_contract_mismatch", 5);
  }
  const rowBytes = EMBEDDING_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
  const shardIndices = new Set();
  let totalRows = 0;
  let totalBytes = 0;
  for (const descriptor of manifest.shards) {
    if (!Number.isInteger(descriptor?.index) || descriptor.index < 0 || shardIndices.has(descriptor.index)
        || typeof descriptor.file !== "string" || !descriptor.file || dirname(descriptor.file) !== "."
        || !Number.isInteger(descriptor.rowCount) || descriptor.rowCount < 0
        || descriptor.byteLength !== descriptor.rowCount * rowBytes
        || !/^[a-f0-9]{64}$/u.test(String(descriptor.sha256 || ""))) {
      throw codedError("existing_embedding_shard_invalid", 5);
    }
    shardIndices.add(descriptor.index);
    totalRows += descriptor.rowCount;
    totalBytes += descriptor.byteLength;
    await readVerifiedShard(directory, descriptor);
  }
  if (totalRows !== manifest.entries.length || totalBytes !== manifest.vectorByteLength
      || manifest.shardSetSha256 !== sha256(JSON.stringify(manifest.shards.map(({ index, byteLength, sha256: hash }) => ({ index, byteLength, sha256: hash }))))) {
    throw codedError("existing_embedding_shard_set_invalid", 5);
  }
  const entries = new Map();
  const coordinates = new Set();
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    const descriptor = manifest.shards.find((item) => item.index === entry?.shardIndex);
    const coordinate = `${entry?.shardIndex}:${entry?.rowIndex}`;
    if (!/^[a-f0-9]{64}$/u.test(String(entry?.textSha256 || "")) || entries.has(entry.textSha256)
        || manifest.orderedContentHashes[index] !== entry.textSha256
        || !descriptor || !Number.isInteger(entry.rowIndex) || entry.rowIndex < 0 || entry.rowIndex >= descriptor.rowCount
        || coordinates.has(coordinate)) {
      throw codedError("existing_embedding_entry_invalid", 5);
    }
    coordinates.add(coordinate);
    entries.set(entry.textSha256, entry);
  }
  return { directory, manifest, entries };
}

async function readVerifiedShard(directory, descriptor) {
  if (!descriptor || dirname(descriptor.file) !== ".") throw codedError("embedding_shard_path_invalid", 5);
  const bytes = await readFile(join(directory, descriptor.file));
  if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) {
    throw codedError("embedding_shard_binding_invalid", 5);
  }
  return bytes;
}

function uniqueInputs(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.embeddingInputSha256)) return false;
    seen.add(row.embeddingInputSha256);
    return true;
  });
}

function validateVector(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding_vector_invalid");
  }
}

function vectorToBytes(vector) {
  const bytes = Buffer.alloc(EMBEDDING_DIMENSION * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

async function writeImmutable(path, bytes) {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error("embedding_output_conflict");
  }
}

async function readDenseInputs(path) {
  const bytes = await readFile(path);
  return validateDenseInputs(JSON.parse(path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8")));
}

function parseArguments(argv) {
  const options = {
    dataDir: join(rootDir, "data"),
    cacheDir: join(rootDir, ".cache", "evidence-preprocess"),
    outDir: null,
    mode: "dry-run",
    batchSize: 100,
  };
  const take = (index) => {
    if (!argv[index + 1]) throw codedError(`missing_value:${argv[index]}`, 2);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") options.dataDir = resolve(take(index++));
    else if (arg === "--cache-dir") options.cacheDir = resolve(take(index++));
    else if (arg === "--out-dir") options.outDir = resolve(take(index++));
    else if (arg === "--inputs") options.inputs = resolve(take(index++));
    else if (arg === "--ledger") options.ledger = resolve(take(index++));
    else if (arg === "--max-usd") options.maxUsd = Number(take(index++));
    else if (arg === "--cloud") options.cloud = true;
    else if (arg === "--batch-size") options.batchSize = Number(take(index++));
    else if (arg === "--dry-run") options.mode = "dry-run";
    else if (arg === "--execute") options.mode = "execute";
    else throw codedError(`unknown_argument:${arg}`, 2);
  }
  if (!options.outDir || !Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
    throw codedError("embedding_arguments_invalid", 2);
  }
  if (resolve(options.dataDir) === resolve(options.outDir)) throw codedError("embedding_staging_must_not_overwrite_data_dir", 2);
  if (options.mode === "execute" && (!(options.maxUsd > 0) || (!options.ledger && !options.cloud)
      || (options.ledger && options.cloud))) throw codedError("execute_budget_arguments_missing", 2);
  options.inputs ||= join(options.outDir, "dense-inputs.json.gz");
  return options;
}

export function createGeminiEmbeddingTransport({ apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw codedError("gemini_embedding_api_key_required", 2);
  return async (texts, profile) => {
    const body = {
      requests: texts.map((text) => ({
        model: `models/${profile.model}`,
        content: { parts: [{ text }] },
        embedContentConfig: { outputDimensionality: profile.dimension, autoTruncate: profile.autoTruncate },
      })),
    };
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:batchEmbedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const raw = await response.json();
    if (!response.ok) throw codedError(`gemini_embedding_http_${response.status}`, 4);
    return raw;
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const denseInputs = await readDenseInputs(options.inputs);
  const execute = options.mode === "execute";
  const cloud = execute && options.cloud
    ? await createCloudEvidencePreprocessResources({ env: { ...process.env, EVIDENCE_PREPROCESS_MAX_USD: String(options.maxUsd) } })
    : null;
  const cache = cloud?.cache || createLocalEvidencePreprocessCache({ cacheDir: options.cacheDir });
  let transport;
  const embedBatch = execute ? (...args) => {
    transport ||= createGeminiEmbeddingTransport({ apiKey: process.env.GEMINI_RULE_QA_API_KEY || process.env.GEMINI_API_KEY });
    return transport(...args);
  } : undefined;
  const result = await runEmbeddingRefresh({
    denseInputs,
    dataDir: options.dataDir,
    outDir: options.outDir,
    cache,
    execute,
    maxUsd: options.maxUsd,
    ledgerPath: options.ledger,
    budget: cloud?.budget,
    embedBatch,
    batchSize: options.batchSize,
  });
  const reportPath = join(options.outDir, "embedding-refresh-report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  await rename(temporary, reportPath);
  console.log(JSON.stringify(result.report, null, 2));
}

function codedError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = error?.exitCode || 1;
  });
}
