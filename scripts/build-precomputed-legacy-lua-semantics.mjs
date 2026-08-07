import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createLegacyLuaSemanticHttpFacade,
} from "../backend/legacyLuaSemanticHttpFacade.mjs";
import {
  collectLegacyLuaSemanticResource,
} from "../backend/legacyLuaSemanticClient.mjs";
import {
  canonicalLegacyLuaSha256,
  validateLegacyLuaSemanticResource,
} from "../backend/legacyLuaSemanticPacket.mjs";
import {
  createPrecomputedLegacyLuaCacheManifest,
  createPrecomputedLegacyLuaCacheShard,
  createPrecomputedLegacyLuaShardSummary,
  validatePrecomputedLegacyLuaCacheManifest,
  validatePrecomputedLegacyLuaCacheShard,
  PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
} from "../backend/legacyLuaSemanticStaticCacheV2.mjs";
import {
  canReusePrecomputedLegacyLuaEntry,
  createPrecomputedLegacyLuaBuildPlan,
  groupPrecomputedLegacyLuaPlanByShard,
  precomputedLegacyLuaPlanReport,
  resourceHasActivationLegalityChecks,
} from "./lib/precomputed-legacy-lua-cache-v2.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPILE_BATCH_SIZE = 16;

const options = parseArguments(process.argv.slice(2));
const engineRepository = path.resolve(
  options.engineRepository
    || process.env.OCG_ENGINE_REPOSITORY
    || path.resolve(repositoryRoot, "..", "游戏王游戏引擎"),
);
const runtimeConfigPath = options.runtimeConfig
  ? path.resolve(options.runtimeConfig)
  : await findNewestRuntimeConfig(engineRepository, options.profileId);
const outputDirectory = path.resolve(
  options.outputDirectory
    || path.join(repositoryRoot, "data", "legacy-lua-semantic-cache-v2"),
);
assertSafeOutputDirectory(outputDirectory);

const [runtimeConfig, cardCorpus] = await Promise.all([
  readJson(runtimeConfigPath),
  readJson(path.join(repositoryRoot, "data", "cards.json")),
]);
if (!Array.isArray(cardCorpus.records) || cardCorpus.records.length === 0) {
  throw new Error("data/cards.json contains no card records");
}

const serviceModuleUrl = pathToFileURL(
  path.join(engineRepository, "src", "service.mjs"),
).href;
const { createOcgEngineHttpService } = await import(serviceModuleUrl);
const service = createOcgEngineHttpService({
  controller: inertController(),
  runtime: {
    configPath: runtimeConfigPath,
    resourceBinding: runtimeConfig.resourceBinding,
    profile: { id: runtimeConfig.metadata?.profileId || options.profileId },
  },
  host: "127.0.0.1",
  port: 0,
});

try {
  const address = await service.listen();
  const engineUrl = `http://127.0.0.1:${address.port}`;
  const createFacade = () => createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: engineUrl },
    fetchImpl: globalThis.fetch,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxHttpResponseBytes,
  });
  const metadataFacade = createFacade();
  const registry = await metadataFacade.getLegacyLuaApiSemanticsRegistry();
  const plan = await createPrecomputedLegacyLuaBuildPlan({
    cards: cardCorpus.records,
    runtimeConfig,
    registry,
    resolveBatch: async (requests) =>
      createFacade().resolveLegacyLuaCardIdentities(requests),
  });
  const planReport = {
    ...precomputedLegacyLuaPlanReport(plan),
    runtime: runtimeMetadata(runtimeConfig, options.profileId),
    cardsCorpusSha256: canonicalLegacyLuaSha256(cardCorpus),
  };
  process.stdout.write(`${JSON.stringify(planReport, null, 2)}\n`);
  if (options.planOnly) {
    process.stdout.write("plan-only: no Lua resources were compiled and no cache files were written\n");
  } else {
    await buildCache({
      plan,
      planReport,
      registry,
      cardCorpus,
      runtimeConfig,
      outputDirectory,
      createFacade,
      reuse: options.reuse,
    });
  }
} finally {
  await service.close();
}

async function buildCache({
  plan,
  planReport,
  registry,
  cardCorpus,
  runtimeConfig,
  outputDirectory,
  createFacade,
  reuse,
}) {
  await mkdir(path.join(outputDirectory, "shards"), { recursive: true });
  const generatedAt = new Date().toISOString();
  const bindingFacade = createFacade();
  const [engineVersions, capabilities] = await Promise.all([
    bindingFacade.getEngineVersions(),
    bindingFacade.getEngineCapabilities(),
  ]);
  const binding = {
    registrySha256: canonicalLegacyLuaSha256(registry),
    engineVersionsSha256: canonicalLegacyLuaSha256(engineVersions),
    capabilitiesSha256: canonicalLegacyLuaSha256(capabilities),
  };
  const previous = reuse
    ? await loadPreviousCache(outputDirectory)
    : null;
  const groups = groupPrecomputedLegacyLuaPlanByShard(plan);
  const summaries = [];
  const counters = {
    compiledResourceCount: 0,
    retainedResourceCount: 0,
    reusedResourceCount: 0,
    skippedByReason: { ...plan.skippedByReason },
  };

  for (const [shardId, plannedCards] of groups) {
    const previousEntries = await previousEntriesForShard({
      previous,
      outputDirectory,
      shardId,
    });
    const entriesByPasscode = new Map(previousEntries.map((entry) => [
      entry.passcode,
      entry,
    ]));
    const entries = [];
    const pending = [];
    for (const plannedCard of plannedCards) {
      const oldEntry = entriesByPasscode.get(plannedCard.passcode) || null;
      if (oldEntry && canReusePrecomputedLegacyLuaEntry({
        entry: oldEntry,
        plannedCard,
        ...binding,
      })) {
        entries.push({
          cid: plannedCard.cid,
          passcode: plannedCard.passcode,
          aliases: plannedCard.aliases,
          resource: oldEntry.resource,
        });
        counters.reusedResourceCount += 1;
      } else {
        pending.push(plannedCard);
      }
    }

    for (let offset = 0; offset < pending.length; offset += COMPILE_BATCH_SIZE) {
      const facade = createFacade();
      const batch = pending.slice(offset, offset + COMPILE_BATCH_SIZE);
      for (const plannedCard of batch) {
        let resource;
        try {
          const sourceDocument = await facade.resolveLegacyLuaSource(
            plannedCard.passcode,
          );
          const boundSourceDocument = {
            ...sourceDocument,
            sourceDocumentId: [
              "legacy-script",
              `cid-${plannedCard.cid}`,
              `passcode-${plannedCard.passcode}`,
              sourceDocument.contentHash.slice(0, 16),
            ].join(":"),
          };
          resource = validateLegacyLuaSemanticResource(
            await collectLegacyLuaSemanticResource({
              sourceDocument: boundSourceDocument,
              engine: facade,
            }),
          );
          counters.compiledResourceCount += 1;
        } catch {
          increment(counters.skippedByReason, "COMPILE_OR_TRANSPORT_FAILURE");
          continue;
        }
        if (!resourceHasActivationLegalityChecks(resource)) {
          increment(counters.skippedByReason,
            "NO_COMPILED_ACTIVATION_LEGALITY_CHECKS");
          continue;
        }
        entries.push({
          cid: plannedCard.cid,
          passcode: plannedCard.passcode,
          aliases: plannedCard.aliases,
          resource,
        });
      }
    }
    if (entries.length === 0) continue;
    const shard = createPrecomputedLegacyLuaCacheShard({
      shardId,
      generatedAt,
      entries,
    });
    const serialized = `${JSON.stringify(shard, null, 2)}\n`;
    const relativePath = `shards/${shardId}.json`;
    await writeFile(path.join(outputDirectory, "shards", `${shardId}.json`),
      serialized, "utf8");
    summaries.push(createPrecomputedLegacyLuaShardSummary({
      shard,
      path: relativePath,
      serializedBytes: Buffer.byteLength(serialized, "utf8"),
    }));
    counters.retainedResourceCount += entries.length;
    process.stdout.write(
      `shard ${shardId}: retained=${entries.length} compiled=${pending.length}\n`,
    );
  }

  const manifest = createPrecomputedLegacyLuaCacheManifest({
    generatedAt,
    source: runtimeMetadata(runtimeConfig, options.profileId),
    selection: {
      policy: PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
      corpus: "data/cards.json",
      cardsCorpusSha256: canonicalLegacyLuaSha256(cardCorpus),
      registrySha256: binding.registrySha256,
      planSha256: plan.planSha256,
      requestedCardCount: plan.requestedCardCount,
      resolvedIdentityCount: plan.resolvedIdentityCount,
      lockedScriptCount: plan.lockedScriptCount,
      registryPrefilteredCardCount: plan.registryPrefilteredCardCount,
      estimatedEffectCandidateCount: plan.estimatedEffectCandidateCount,
      compiledResourceCount: counters.compiledResourceCount,
      retainedResourceCount: counters.retainedResourceCount,
      reusedResourceCount: counters.reusedResourceCount,
      skippedByReason: sortedCountObject(counters.skippedByReason),
      planEstimation: planReport.estimatedCompileMs,
    },
    shardSummaries: summaries,
  });
  await writeFile(path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `wrote manifest with ${manifest.shards.length} shards and ${counters.retainedResourceCount} resources\n`,
  );
}

async function loadPreviousCache(outputDirectory) {
  try {
    const manifest = validatePrecomputedLegacyLuaCacheManifest(
      await readJson(path.join(outputDirectory, "manifest.json")),
    );
    if (manifest.selection.policy !== PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY) {
      return null;
    }
    return { manifest, shards: new Map() };
  } catch {
    return null;
  }
}

async function previousEntriesForShard({ previous, outputDirectory, shardId }) {
  if (!previous) return [];
  const descriptor = previous.manifest.shards.find((item) =>
    item.shardId === shardId
  );
  if (!descriptor) return [];
  if (!previous.shards.has(shardId)) {
    previous.shards.set(shardId, readJson(path.join(
      outputDirectory,
      ...descriptor.path.split("/"),
    )).then((value) => validatePrecomputedLegacyLuaCacheShard(value, {
      descriptor,
      manifestGeneratedAt: previous.manifest.generatedAt,
    })).catch(() => null));
  }
  const shard = await previous.shards.get(shardId);
  return shard?.entries || [];
}

function runtimeMetadata(runtimeConfig, profileId) {
  return {
    profileId: runtimeConfig.metadata?.profileId || profileId,
    sourceId: runtimeConfig.metadata?.sourceId || null,
    snapshotCreatedAt: runtimeConfig.metadata?.snapshotCreatedAt || null,
    lockId: runtimeConfig.resourceBinding?.lockId || null,
    snapshotId: runtimeConfig.resourceBinding?.snapshotId || null,
    manifestSha256: runtimeConfig.resourceBinding?.manifestSha256 || null,
    scriptSetSha256: runtimeConfig.resourceBinding?.scriptSetSha256 || null,
  };
}

async function findNewestRuntimeConfig(engineRoot, profileId) {
  const runtimeRoot = path.join(engineRoot, "var", "runtime");
  const candidates = [];
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(runtimeRoot, entry.name, "host-config.json");
    try {
      const config = await readJson(configPath);
      if (config.metadata?.profileId !== profileId) continue;
      candidates.push({
        configPath,
        createdAt: Date.parse(config.metadata?.snapshotCreatedAt || "") || 0,
      });
    } catch {
      // Ignore incomplete runtime directories; an explicit path remains usable.
    }
  }
  candidates.sort((left, right) => (
    right.createdAt - left.createdAt ||
    right.configPath.localeCompare(left.configPath)
  ));
  if (!candidates[0]) {
    throw new Error(`No ${profileId} runtime config found below ${runtimeRoot}`);
  }
  return candidates[0].configPath;
}

function parseArguments(argv) {
  const parsed = {
    engineRepository: "",
    runtimeConfig: "",
    outputDirectory: "",
    profileId: "ygopro",
    timeoutMs: 60_000,
    maxHttpResponseBytes: 16 * 1024 * 1024,
    planOnly: false,
    reuse: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--engine-repo") {
      parsed.engineRepository = requiredValue(argument, value), index += 1;
    } else if (argument === "--runtime-config") {
      parsed.runtimeConfig = requiredValue(argument, value), index += 1;
    } else if (argument === "--output-dir") {
      parsed.outputDirectory = requiredValue(argument, value), index += 1;
    } else if (argument === "--profile") {
      parsed.profileId = requiredValue(argument, value), index += 1;
    } else if (argument === "--plan-only") {
      parsed.planOnly = true;
    } else if (argument === "--no-reuse") {
      parsed.reuse = false;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function requiredValue(argument, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function assertSafeOutputDirectory(value) {
  const expectedRoot = path.resolve(repositoryRoot, "data");
  const relative = path.relative(expectedRoot, value);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("legacy Lua cache output directory must be below repository data/");
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function sortedCountObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function inertController() {
  return {
    client: { poisoned: false },
    hello: {
      protocolVersion: 1,
      hostVersion: "precompute-only",
      capabilities: [],
    },
    async close() {},
  };
}
