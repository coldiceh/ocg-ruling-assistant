import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  buildEvidenceInputMeasurement,
  generationContractSha256,
  loadEvidenceGenerationContract,
} from "../backend/evidenceGenerationContract.mjs";
import { createEvidenceGenerationTransport } from "../backend/evidenceGenerationTransport.mjs";
import {
  GEMINI_RULE_QA_ASSET_DIRECTORY,
  GEMINI_RULE_QA_MANIFEST_FILE,
} from "../backend/geminiRuleQaAssets.mjs";
import {
  buildDefaultNavigationRecords,
  buildGeminiRuleQaAssets,
} from "./build-gemini-rule-qa-assets.mjs";
import {
  runNavigationPreparation,
  validateNavigationInputs,
} from "./prepare-evidence-navigation.mjs";
import {
  createGeminiEmbeddingTransport,
  runEmbeddingRefresh,
  validateDenseInputs,
} from "./refresh-gemini-source-embeddings.mjs";
import {
  createLocalEvidencePreprocessBudget,
  createLocalEvidencePreprocessCache,
  stableJson,
} from "./lib/evidence-preprocess-cache.mjs";
import { createCloudEvidencePreprocessResources } from "./lib/evidence-preprocess-cloud.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const CANONICAL_MANIFEST = "canonical-manifest.json";
const REPORT_FILE = "bounded-evidence-sync-report.json";
const DEFAULT_GENERATION_PROFILE = join(
  rootDir,
  "config",
  "evidence-generation",
  "bai-gpt-5.6-luna-medium-theoretical.json",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function runBoundedEvidenceAssetSync(options = {}, dependencies = {}) {
  const normalized = normalizeOptions(options);
  await assertFreshOutputDirectory(normalized.outDir);
  const assetDir = join(normalized.outDir, GEMINI_RULE_QA_ASSET_DIRECTORY);
  const reportPath = join(normalized.outDir, REPORT_FILE);
  const report = {
    schemaVersion: 1,
    kind: "bounded-evidence-asset-sync",
    mode: normalized.execute ? "execute" : "dry-run",
    publishable: false,
    outputDirectories: {
      assets: GEMINI_RULE_QA_ASSET_DIRECTORY,
      ruleVectors: "rule-embedding-v1",
      qaVectors: "qa-embedding-v1",
    },
  };

  try {
    const builder = dependencies.buildGeminiRuleQaAssets || buildGeminiRuleQaAssets;
    const canonical = await builder({
      dataDir: normalized.dataDir,
      outputDir: assetDir,
      stage: "canonical",
    });
    const canonicalManifest = canonical.manifest;
    const [navigationInputs, denseInputs] = await Promise.all([
      readBoundJsonAsset(assetDir, canonicalManifest.assets.navigationInputs)
        .then(validateNavigationInputs),
      readBoundJsonAsset(assetDir, canonicalManifest.assets.denseInputs)
        .then(validateDenseInputs),
    ]);
    const previous = await loadPreviousNavigation(normalized.dataDir);
    const navigationPlan = planNavigationReuse(navigationInputs, previous);
    report.canonicalRevision = canonicalManifest.canonicalRevision;
    report.navigation = {
      inputCount: navigationInputs.length,
      reusedRecords: navigationPlan.reusedCount,
      generationRequired: navigationPlan.generationInputs.length,
      placeholderRecords: navigationPlan.placeholderRecords.length,
      newInputs: navigationPlan.newCount,
      changedInputs: navigationPlan.changedCount,
      removedInputs: navigationPlan.removedCount,
      generatedRecords: 0,
      mechanicalReuseInvariant: "stable-json-full-input-row-and-bound-record-identity-v1",
    };

    const preliminaryCache = dependencies.cache || createLocalEvidencePreprocessCache({
      cacheDir: normalized.cacheDir,
    });
    const embeddingDry = await runEmbeddingRefresh({
      denseInputs,
      dataDir: normalized.dataDir,
      cache: preliminaryCache,
      execute: false,
    });
    report.embeddings = embeddingDry.report;

    let navigationContract = null;
    let ruleNavigationContract = null;
    let navigationDry = null;
    if (navigationPlan.generationInputs.length) {
      navigationContract = loadEvidenceGenerationContract("navigation", {
        profileUrl: pathToFileURL(normalized.generationProfile),
      });
      ruleNavigationContract = normalized.ruleGenerationProfile
        ? loadEvidenceGenerationContract("navigation", {
          profileUrl: pathToFileURL(normalized.ruleGenerationProfile),
        })
        : null;
      navigationDry = await dryNavigation({
        inputs: navigationPlan.generationInputs,
        cache: preliminaryCache,
        contract: navigationContract,
        ruleGenerationContract: ruleNavigationContract,
      });
      report.navigation.cacheReadyRecords = generatedRecordCount(navigationDry.records);
      report.navigation.preparation = navigationDry.report;
    }

    if (!normalized.execute) {
      report.status = "dry_run_complete";
      await writeJsonAtomic(reportPath, report);
      return { report, reportPath, outputDir: normalized.outDir };
    }

    const preliminaryNeedsNavigationWork = navigationDry
      ? generatedRecordCount(navigationDry.records) !== navigationPlan.generationInputs.length
      : false;
    const preliminaryNeedsEmbeddingWork = embeddingNeedsBudget(embeddingDry);
    let cache = preliminaryCache;
    let budget = dependencies.budget || null;
    if (preliminaryNeedsNavigationWork || preliminaryNeedsEmbeddingWork) {
      if (!(normalized.maxUsd > 0)) throw codedError("bounded_sync_max_usd_required_for_changes", 2);
      if (dependencies.budget) {
        cache = dependencies.cache || preliminaryCache;
      } else if (normalized.cloud) {
        const cloudFactory = dependencies.createCloudResources || createCloudEvidencePreprocessResources;
        const cloud = await cloudFactory({
          env: { ...normalized.env, EVIDENCE_PREPROCESS_MAX_USD: String(normalized.maxUsd) },
          fetchImpl: dependencies.fetchImpl || globalThis.fetch,
        });
        cache = cloud.cache;
        budget = cloud.budget;
      } else {
        if (!normalized.ledgerPath) throw codedError("bounded_sync_local_ledger_required_for_changes", 2);
        budget ||= createLocalEvidencePreprocessBudget({
          ledgerPath: normalized.ledgerPath,
          maxUsd: normalized.maxUsd,
        });
      }
    }

    let changedRecords = navigationDry?.records || [];
    if (navigationPlan.generationInputs.length) {
      const currentDry = cache === preliminaryCache
        ? navigationDry
        : await dryNavigation({
          inputs: navigationPlan.generationInputs,
          cache,
          contract: navigationContract,
          ruleGenerationContract: ruleNavigationContract,
        });
      changedRecords = currentDry.records;
      if (generatedRecordCount(changedRecords) !== navigationPlan.generationInputs.length) {
        if (!budget) throw codedError("bounded_sync_navigation_budget_required", 2);
        const transportFactory = dependencies.navigationTransportFactory
          || ((contract) => createEvidenceGenerationTransport({
            contract,
            env: normalized.env,
            fetchImpl: dependencies.fetchImpl || globalThis.fetch,
          }));
        const transports = new Map();
        const transportFor = (contract) => {
          const key = generationContractSha256(contract);
          if (!transports.has(key)) transports.set(key, transportFactory(contract));
          return transports.get(key);
        };
        const generated = await runNavigationPreparation({
          inputs: navigationPlan.generationInputs,
          cache,
          contract: navigationContract,
          ruleGenerationContract: ruleNavigationContract,
          execute: true,
          maxUsd: normalized.maxUsd,
          budget,
          coverageScope: { selectedUnitKeys: navigationPlan.generationInputs.map((row) => row.unitKey) },
          measureInput: ({ body, contract }) => {
            const transport = transportFor(contract);
            return buildEvidenceInputMeasurement({
              body,
              contract,
              countTokens: transport.countTokens
                ? (requestBody) => transport.countTokens(requestBody)
                : undefined,
            });
          },
          generateContent: (body, contract, invokeOptions) => transportFor(contract).invoke(body, invokeOptions),
          prepareRequest: (body, contract) => transportFor(contract).prepareRequest(body),
          extractText: (response, contract) => transportFor(contract).extractText(response),
          rawUsage: (response, contract) => transportFor(contract).rawUsage(response),
          validateResponse: (response, contract) => transportFor(contract).validateResponse(response),
        });
        if (!generated.report.complete) throw codedError("bounded_sync_navigation_incomplete", 4);
        changedRecords = generated.records;
      }
    }
    if (generatedRecordCount(changedRecords) !== navigationPlan.generationInputs.length) {
      throw codedError("bounded_sync_navigation_records_incomplete", 4);
    }
    const navigationRecords = mergeNavigationRecords(navigationInputs, navigationPlan, changedRecords);
    const navigationPath = join(normalized.outDir, "navigation-records.json.gz");
    await writeGzipJsonAtomic(navigationPath, navigationRecords);
    report.navigation.generatedRecords = changedRecords.length;

    let embedBatch = dependencies.embedBatch;
    const embedding = await runEmbeddingRefresh({
      denseInputs,
      dataDir: normalized.dataDir,
      outDir: normalized.outDir,
      cache,
      execute: true,
      maxUsd: normalized.maxUsd,
      budget,
      batchSize: normalized.batchSize,
      embedBatch: (...args) => {
        embedBatch ||= createGeminiEmbeddingTransport({
          apiKey: normalized.env.GEMINI_RULE_QA_API_KEY || normalized.env.GEMINI_API_KEY,
          fetchImpl: dependencies.fetchImpl || globalThis.fetch,
        });
        return embedBatch(...args);
      },
    });
    report.embeddings = embedding.report;

    const released = await builder({
      dataDir: normalized.dataDir,
      outputDir: assetDir,
      stage: "release",
      navigationPath,
      ruleDenseDir: join(normalized.outDir, "rule-embedding-v1"),
      qaDenseDir: join(normalized.outDir, "qa-embedding-v1"),
    });
    const verified = await builder({
      dataDir: normalized.dataDir,
      outputDir: assetDir,
      stage: "verify",
    });
    if (verified.manifest.bundleRevision !== released.manifest.bundleRevision) {
      throw codedError("bounded_sync_release_verify_revision_mismatch", 5);
    }
    report.status = "ready_to_publish";
    report.publishable = true;
    report.bundleRevision = verified.manifest.bundleRevision;
    await writeJsonAtomic(reportPath, report);
    return { report, reportPath, outputDir: normalized.outDir, manifest: verified.manifest };
  } catch (error) {
    report.status = "failed";
    report.error = error?.message || String(error);
    await writeJsonAtomic(reportPath, report).catch(() => {});
    throw error;
  }
}

export function planNavigationReuse(inputs, previous) {
  const oldInputs = new Map((previous?.inputs || []).map((row) => [row.unitKey, row]));
  const oldRecords = new Map((previous?.records || []).map((row) => [row.unitKey, row]));
  const reusedByUnitKey = new Map();
  const generationInputs = [];
  const placeholderInputs = [];
  let newCount = 0;
  let changedCount = 0;
  for (const input of inputs) {
    const oldInput = oldInputs.get(input.unitKey);
    const oldRecord = oldRecords.get(input.unitKey);
    const oldRecordBound = oldInput && isNavigationRecordBoundToInput(oldRecord, oldInput);
    if (oldInput && stableJson(oldInput) === stableJson(input)
        && oldRecordBound) {
      reusedByUnitKey.set(input.unitKey, oldRecord);
    } else {
      const sourceKind = String(input.input?.sourceKind || "");
      const refreshPreviouslyGenerated = oldRecordBound
        && oldRecord.navigationStatus === "generated"
        && String(oldInput.input?.sourceKind || "") === sourceKind;
      if (sourceKind === "rule" || refreshPreviouslyGenerated) generationInputs.push(input);
      else placeholderInputs.push(input);
      if (oldInput) changedCount += 1;
      else newCount += 1;
    }
  }
  const currentKeys = new Set(inputs.map((row) => row.unitKey));
  const removedCount = [...oldInputs.keys()].filter((unitKey) => !currentKeys.has(unitKey)).length;
  return {
    reusedByUnitKey,
    reusedCount: reusedByUnitKey.size,
    generationInputs,
    placeholderRecords: buildDefaultNavigationRecords(placeholderInputs),
    newCount,
    changedCount,
    removedCount,
  };
}

function mergeNavigationRecords(inputs, plan, changedRecords) {
  const generatedByUnitKey = new Map([
    ...plan.placeholderRecords,
    ...changedRecords,
  ].map((row) => [row.unitKey, row]));
  return inputs.map((input) => {
    const record = plan.reusedByUnitKey.get(input.unitKey) || generatedByUnitKey.get(input.unitKey);
    if (!isNavigationRecordBoundToInput(record, input)) {
      throw codedError(`bounded_sync_navigation_binding_invalid:${input.unitKey}`, 5);
    }
    return record;
  });
}

function isNavigationRecordBoundToInput(record, input) {
  const statuses = new Set([
    "generated",
    "unavailable_after_attempt",
    "not_generated_in_scope",
    "blocked_before_attempt",
  ]);
  const generatorBinding = record?.navigationStatus === "generated"
    ? record.generator && typeof record.generator === "object"
    : record?.generator == null;
  const optionalSourceKindBinding = !Object.hasOwn(record || {}, "sourceKind")
    || record.sourceKind === input.input?.sourceKind;
  return statuses.has(record?.navigationStatus)
    && generatorBinding
    && optionalSourceKindBinding
    && record.unitKey === input.unitKey
    && record.sourceId === input.sourceId
    && record.canonicalBodySha256 === input.canonicalBodySha256
    && record.contextInputSha256 === input.contextInputSha256
    && stableJson(record.titlePath) === stableJson(input.input?.titlePath || [])
    && stableJson(record.contextRefs) === stableJson(input.contextRefs)
    && stableJson(record.explicitRefs) === stableJson(input.explicitRefs);
}

function generatedRecordCount(records) {
  return records.filter((record) => record?.navigationStatus === "generated" && record.generator).length;
}

async function dryNavigation({ inputs, cache, contract, ruleGenerationContract }) {
  return runNavigationPreparation({
    inputs,
    cache,
    contract,
    ruleGenerationContract,
    execute: false,
    coverageScope: { selectedUnitKeys: inputs.map((row) => row.unitKey) },
  });
}

function embeddingNeedsBudget(result) {
  return Object.values(result.report.collections).some((collection) => (
    collection.generationMisses > 0 || collection.reusableRawResponses > 0
  ));
}

async function loadPreviousNavigation(dataDir) {
  const assetDir = join(dataDir, GEMINI_RULE_QA_ASSET_DIRECTORY);
  const canonicalPath = join(assetDir, CANONICAL_MANIFEST);
  const releasePath = join(assetDir, GEMINI_RULE_QA_MANIFEST_FILE);
  const [hasCanonical, hasRelease] = await Promise.all([exists(canonicalPath), exists(releasePath)]);
  if (!hasCanonical && !hasRelease) return { inputs: [], records: [] };
  if (!hasCanonical || !hasRelease) throw codedError("bounded_sync_previous_assets_incomplete", 5);
  const [canonical, release] = await Promise.all([readJson(canonicalPath), readJson(releasePath)]);
  const { canonicalRevision, ...canonicalBody } = canonical;
  if (canonical.kind !== "gemini-rule-qa-canonical-stage"
      || canonicalRevision !== sha256(stableJson(canonicalBody))) {
    throw codedError("bounded_sync_previous_canonical_binding_invalid", 5);
  }
  const { bundleRevision, ...releaseBody } = release;
  if (release.kind !== "gemini-rule-qa-assets"
      || bundleRevision !== sha256(stableJson(releaseBody))) {
    throw codedError("bounded_sync_previous_release_binding_invalid", 5);
  }
  const [inputs, records] = await Promise.all([
    readBoundJsonAsset(assetDir, canonical.assets.navigationInputs).then(validateNavigationInputs),
    readBoundJsonAsset(assetDir, release.assets.navigationRecords),
  ]);
  if (!Array.isArray(records) || records.length !== inputs.length
      || records.some((record, index) => record.unitKey !== inputs[index].unitKey)) {
    throw codedError("bounded_sync_previous_navigation_order_invalid", 5);
  }
  return { inputs, records };
}

async function readBoundJsonAsset(directory, descriptor) {
  if (!descriptor || descriptor.encoding !== "gzip" || typeof descriptor.file !== "string") {
    throw codedError("bounded_sync_asset_descriptor_invalid", 5);
  }
  const compressed = await readFile(join(directory, descriptor.file));
  if (compressed.byteLength !== descriptor.bytes || sha256(compressed) !== descriptor.sha256) {
    throw codedError("bounded_sync_asset_compressed_binding_invalid", 5);
  }
  const canonical = gunzipSync(compressed);
  if (canonical.byteLength !== descriptor.canonicalBytes
      || sha256(canonical) !== descriptor.canonicalSha256) {
    throw codedError("bounded_sync_asset_canonical_binding_invalid", 5);
  }
  return JSON.parse(canonical.toString("utf8"));
}

function normalizeOptions(options) {
  const dataDir = resolve(options.dataDir || join(rootDir, "data"));
  const outDir = options.outDir ? resolve(options.outDir) : "";
  if (!outDir) throw codedError("bounded_sync_out_dir_required", 2);
  if (isWithin(dataDir, outDir)) throw codedError("bounded_sync_staging_must_not_overwrite_data_dir", 2);
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw codedError("bounded_sync_batch_size_invalid", 2);
  }
  return {
    dataDir,
    outDir,
    cacheDir: resolve(options.cacheDir || join(rootDir, ".cache", "evidence-preprocess")),
    generationProfile: resolve(options.generationProfile || DEFAULT_GENERATION_PROFILE),
    ruleGenerationProfile: options.ruleGenerationProfile
      ? resolve(options.ruleGenerationProfile)
      : null,
    ledgerPath: options.ledgerPath ? resolve(options.ledgerPath) : null,
    cloud: Boolean(options.cloud),
    execute: Boolean(options.execute),
    maxUsd: Number(options.maxUsd),
    batchSize,
    env: options.env || process.env,
  };
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function parseArguments(argv) {
  const options = {};
  const take = (index) => {
    if (!argv[index + 1]) throw codedError(`missing_value:${argv[index]}`, 2);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir") options.dataDir = take(index++);
    else if (argument === "--out-dir") options.outDir = take(index++);
    else if (argument === "--cache-dir") options.cacheDir = take(index++);
    else if (argument === "--generation-profile") options.generationProfile = take(index++);
    else if (argument === "--rule-generation-profile") options.ruleGenerationProfile = take(index++);
    else if (argument === "--ledger") options.ledgerPath = take(index++);
    else if (argument === "--max-usd") options.maxUsd = Number(take(index++));
    else if (argument === "--batch-size") options.batchSize = Number(take(index++));
    else if (argument === "--cloud") options.cloud = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--dry-run") options.execute = false;
    else throw codedError(`unknown_argument:${argument}`, 2);
  }
  return options;
}

async function assertFreshOutputDirectory(path) {
  if (await exists(path)) throw codedError("bounded_sync_output_dir_must_be_new", 2);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeGzipJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const compressed = gzipSync(Buffer.from(JSON.stringify(value), "utf8"), { level: 9, mtime: 0 });
  compressed[9] = 255;
  await writeFile(temporary, compressed);
  await rename(temporary, path);
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function codedError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBoundedEvidenceAssetSync(parseArguments(process.argv.slice(2)), { fetchImpl: globalThis.fetch })
    .then((result) => process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`))
    .catch((error) => {
      console.error(error?.message || String(error));
      process.exitCode = error?.exitCode || 1;
    });
}
