import {
  createDefaultLegacyLuaSemanticPacketFactory,
} from "./legacyLuaSemanticPacketFactory.mjs";
import {
  createLegacyLuaUnknownPacket,
  mergeLegacyLuaSemanticPackets,
} from "./legacyLuaSemanticPacket.mjs";
import {
  createPrecomputedLegacyLuaSemanticPacketFactory,
} from "./legacyLuaSemanticStaticCacheFactory.mjs";
import {
  createShardedPrecomputedLegacyLuaSemanticPacketFactory,
} from "./legacyLuaSemanticStaticCacheV2.mjs";
import {
  createBundledLegacyLuaShardLoader,
  loadBundledLegacyLuaSemanticManifest,
} from "./legacyLuaSemanticStaticCacheV2Data.mjs";

let bundledStaticFactory;

/**
 * Production composition gate. Absence of OCG_ENGINE_URL returns null before a
 * facade or fetch can be created, so an undeployed engine never causes an
 * accidental network request.
 */
export function createConfiguredLegacyLuaSemanticPacketFactory({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  precomputedManifest = undefined,
  precomputedShardLoader = undefined,
  precomputedCache = undefined,
  precomputedFactory = createPrecomputedLegacyLuaSemanticPacketFactory,
  shardedPrecomputedFactory =
    createShardedPrecomputedLegacyLuaSemanticPacketFactory,
  packetMerger = mergeLegacyLuaSemanticPackets,
  ...options
} = {}) {
  const staticFactory = configuredStaticFactory({
    manifest: precomputedManifest,
    loadShard: precomputedShardLoader,
    cache: precomputedCache,
    legacyFactory: precomputedFactory,
    shardedFactory: shardedPrecomputedFactory,
    options,
  });
  const liveFactory = String(env?.OCG_ENGINE_URL || "").trim()
    ? createDefaultLegacyLuaSemanticPacketFactory({
        env,
        fetchImpl,
        ...options,
      })
    : null;
  if (!staticFactory) return liveFactory;
  if (!liveFactory) return staticFactory;

  return async function cachedThenLiveLegacyLuaFactory(input = {}) {
    const cached = await staticFactory(input);
    const cachedCandidates = Array.isArray(cached?.effectCandidates)
      ? cached.effectCandidates
      : [];
    const coverageIncomplete = packetHasUnknownReason(
      cached,
      "LEGACY_LUA_PRECOMPUTED_COVERAGE_INCOMPLETE",
    );
    if (cachedCandidates.length > 0 && !coverageIncomplete) return cached;

    let live;
    try {
      live = await liveFactory(input);
    } catch (error) {
      live = createLegacyLuaUnknownPacket({
        code: "LEGACY_LUA_LIVE_FALLBACK_FAILED",
        message: "live legacy Lua fallback failed",
        details: {
          causeCode: typeof error?.code === "string" ? error.code : null,
          retryable: true,
        },
      });
    }
    if (cachedCandidates.length === 0) return live;
    if (packetHasCompleteResources(live)) {
      return live;
    }
    return packetMerger({
      packets: [cached, live],
      maxCandidates: options.maxCandidates,
      maxSerializedBytes: options.maxSerializedBytes,
    });
  };
}

function packetHasUnknownReason(packet, code) {
  return Array.isArray(packet?.unknownReasons) && packet.unknownReasons.some(
    (reason) => reason?.code === code,
  );
}

function packetHasCompleteResources(packet) {
  return Array.isArray(packet?.resources) && packet.resources.length > 0
    && packet.resources.every((resource) => resource?.status === "READY");
}

function configuredStaticFactory({
  manifest,
  loadShard,
  cache,
  legacyFactory,
  shardedFactory,
  options,
}) {
  // `precomputedCache` remains an explicit test/compatibility injection for the
  // reusable v1 in-memory factory. Production no longer loads the old bundled
  // single-file PoC cache.
  if (cache === null) return null;
  if (cache !== undefined) {
    return legacyFactory({
      cache,
      maxCandidates: options.maxCandidates,
      maxSerializedBytes: options.maxSerializedBytes,
    });
  }

  if (manifest === null) return null;
  if (manifest !== undefined) {
    return shardedFactory({
      manifest,
      loadShard,
      maxCandidates: options.maxCandidates,
      maxSerializedBytes: options.maxSerializedBytes,
    });
  }
  if (bundledStaticFactory === undefined) {
    const bundledManifest = loadBundledLegacyLuaSemanticManifest();
    bundledStaticFactory = bundledManifest
      ? shardedFactory({
          manifest: bundledManifest,
          loadShard: createBundledLegacyLuaShardLoader(),
          maxCandidates: options.maxCandidates,
          maxSerializedBytes: options.maxSerializedBytes,
        })
      : null;
  }
  return bundledStaticFactory;
}
