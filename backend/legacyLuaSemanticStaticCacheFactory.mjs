import {
  canonicalLegacyLuaSha256,
  createLegacyLuaSemanticPacket,
  createLegacyLuaUnknownPacket,
  finalizeLegacyLuaSemanticResource,
  normalizeLegacyLuaPasscode,
  validateLegacyLuaSemanticResource,
} from "./legacyLuaSemanticPacket.mjs";

export const PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA =
  "ocg-assistant-precomputed-legacy-lua-cache/v1";

const CACHE_PHASE = "LEGACY_LUA_PRECOMPUTED_CACHE";
const MAX_INPUT_IDENTITIES = 64;
const MAX_ALIASES_PER_IDENTITY = 32;

/**
 * Validates the reusable part of an offline cache. Source and selection are
 * retained as JSON audit metadata, while every resource crosses the same
 * content-addressed validation boundary as a live engine resource.
 */
export function validatePrecomputedLegacyLuaSemanticCache(value) {
  if (!isPlainObject(value)) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      "precomputed legacy Lua cache must be a plain object",
    );
  }
  if (value.schemaVersion !== PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `unsupported precomputed legacy Lua cache schema: ${String(value.schemaVersion || "")}`,
    );
  }
  if (value.cacheContentSha256 !== undefined) {
    const { cacheContentSha256, ...content } = value;
    if (!/^[a-f0-9]{64}$/u.test(String(cacheContentSha256 || ""))
        || canonicalLegacyLuaSha256(content) !== cacheContentSha256) {
      throw cacheError(
        "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
        "precomputed legacy Lua cache content hash is invalid",
      );
    }
  }
  const generatedAt = normalizeTimestamp(value.generatedAt);
  if (!Array.isArray(value.entries)) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      "precomputed legacy Lua cache entries must be an array",
    );
  }

  const entries = value.entries.map((entry, index) =>
    validateCacheEntry(entry, index)
  );
  const duplicateResourceIds = duplicates(
    entries.map((entry) => entry.resource.resourceId),
  );
  if (duplicateResourceIds.length > 0) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      "precomputed cache resources must have unique resourceId values",
      { duplicateResourceIds },
    );
  }

  return deepFreeze({
    schemaVersion: PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA,
    generatedAt,
    source: cloneJsonMetadata(value.source, "cache source"),
    selection: cloneJsonMetadata(value.selection, "cache selection"),
    cacheContentSha256: value.cacheContentSha256 || null,
    entries,
  });
}

/**
 * Creates a no-I/O packet factory backed by validated, precomputed resources.
 * Explicit passcodes and stable CIDs are strong identities. Exact normalized
 * aliases are a fallback only; fuzzy matching is intentionally unsupported.
 *
 * The returned value is always the existing non-authoritative packet schema.
 * In particular, cached candidateVerdict values remain discovery hints and can
 * never become the packet's formal verdict.
 */
export function createPrecomputedLegacyLuaSemanticPacketFactory({
  cache,
  maxCandidates = Number.MAX_SAFE_INTEGER,
  maxSerializedBytes = null,
} = {}) {
  let prepared = null;
  let preparationError = null;
  try {
    const validatedCache = validatePrecomputedLegacyLuaSemanticCache(cache);
    prepared = {
      cache: validatedCache,
      indexes: buildIndexes(validatedCache.entries),
    };
  } catch (error) {
    preparationError = error;
  }

  return function precomputedLegacyLuaSemanticPacketFactory(input = {}) {
    if (preparationError) {
      return createLegacyLuaUnknownPacket({
        code: preparationError.code || "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
        message: preparationError instanceof Error
          ? preparationError.message
          : String(preparationError),
        details: {
          retryable: false,
          ...(isPlainObject(preparationError?.details)
            ? { cause: preparationError.details }
            : {}),
        },
      });
    }

    let identities;
    try {
      identities = collectPrecomputedLegacyLuaRequestedIdentities(input);
    } catch (error) {
      return createLegacyLuaUnknownPacket({
        code: error?.code || "LEGACY_LUA_PRECOMPUTED_IDENTITY_INVALID",
        message: error instanceof Error ? error.message : String(error),
        details: { retryable: false },
      });
    }
    if (identities.length === 0) {
      return createLegacyLuaUnknownPacket({
        code: "LEGACY_LUA_PRECOMPUTED_CACHE_MISS",
        message: "no exact card identity is available for precomputed legacy Lua lookup",
        details: {
          requestedIdentityCount: 0,
          cacheEntryCount: prepared.cache.entries.length,
          retryable: false,
        },
      });
    }

    const matches = [];
    const misses = [];
    for (const identity of identities) {
      const result = resolveIdentity(identity, prepared.indexes);
      if (result.status === "AMBIGUOUS") {
        return createLegacyLuaUnknownPacket({
          code: "LEGACY_LUA_PRECOMPUTED_IDENTITY_AMBIGUOUS",
          message: "one exact card identity maps to multiple precomputed legacy Lua resources",
          details: {
            identitySha256: canonicalLegacyLuaSha256(identity),
            matchedResourceIds: result.entryIndexes.map((index) =>
              prepared.cache.entries[index].resource.resourceId
            ).sort(),
            retryable: false,
          },
        });
      }
      if (result.status === "MISS") misses.push(identity);
      else matches.push({ identity, entryIndex: result.entryIndex });
    }

    if (matches.length === 0) {
      return createLegacyLuaUnknownPacket({
        code: "LEGACY_LUA_PRECOMPUTED_CACHE_MISS",
        message: "no precomputed legacy Lua resource matches the requested exact card identities",
        details: {
          requestedIdentityCount: identities.length,
          cacheEntryCount: prepared.cache.entries.length,
          unmatchedIdentitySha256s: misses.map((identity) =>
            canonicalLegacyLuaSha256(identity)
          ).sort(),
          retryable: false,
        },
      });
    }

    const matchedResources = [...new Set(matches.map((match) => match.entryIndex))]
      .map((index) => prepared.cache.entries[index].resource);
    if (misses.length > 0) {
      matchedResources.push(createIncompleteCoverageResource({
        cache: prepared.cache,
        matchedResourceIds: matchedResources.map((resource) => resource.resourceId),
        requestedIdentityCount: identities.length,
        matchedIdentityCount: matches.length,
        misses,
      }));
    }

    return createLegacyLuaSemanticPacket({
      resources: matchedResources,
      maxCandidates: input.maxCandidates ?? maxCandidates,
      maxSerializedBytes: input.maxSerializedBytes ?? maxSerializedBytes,
    });
  };
}

/** Exact comparison normalization shared by cache indexing and input lookup. */
export function normalizePrecomputedLegacyLuaAlias(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
  return normalized || null;
}

function validateCacheEntry(value, index) {
  if (!isPlainObject(value)) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `precomputed cache entry ${index} must be a plain object`,
    );
  }
  const cid = normalizePrecomputedLegacyLuaCid(value.cid);
  if (value.cid !== undefined && value.cid !== null && cid === null) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `precomputed cache entry ${index} has an invalid stable CID`,
    );
  }
  const passcode = normalizeLegacyLuaPasscode(value.passcode);
  if (value.passcode !== undefined && value.passcode !== null && passcode === null) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `precomputed cache entry ${index} has an invalid passcode`,
    );
  }
  if (!Array.isArray(value.aliases)) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `precomputed cache entry ${index} aliases must be an array`,
    );
  }
  const aliases = uniqueSorted(value.aliases.map((alias) => {
    const normalized = normalizePrecomputedLegacyLuaAlias(alias);
    if (normalized === null) {
      throw cacheError(
        "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
        `precomputed cache entry ${index} contains an invalid alias`,
      );
    }
    return normalized;
  }));
  if (cid === null && passcode === null && aliases.length === 0) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `precomputed cache entry ${index} has no usable exact identity`,
    );
  }
  let resource;
  try {
    resource = validateLegacyLuaSemanticResource(value.resource);
  } catch (error) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `precomputed cache entry ${index} contains an invalid semantic resource`,
      { resourceErrorCode: error?.code || "LEGACY_LUA_RESOURCE_SCHEMA_INVALID" },
    );
  }
  return deepFreeze({ cid, passcode, aliases, resource });
}

function buildIndexes(entries) {
  const passcodes = new Map();
  const cids = new Map();
  const aliases = new Map();
  entries.forEach((entry, index) => {
    addIndexValue(passcodes, entry.passcode, index);
    addIndexValue(cids, entry.cid, index);
    entry.aliases.forEach((alias) => addIndexValue(aliases, alias, index));
  });
  return deepFreeze({ passcodes, cids, aliases });
}

function addIndexValue(index, key, value) {
  if (key === null) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(value);
}

function resolveIdentity(identity, indexes) {
  const strongMatches = [];
  for (const [key, index] of [
    [identity.passcode, indexes.passcodes],
    [identity.cid, indexes.cids],
  ]) {
    if (key === null || !index.has(key)) continue;
    const values = [...index.get(key)].sort((left, right) => left - right);
    if (values.length > 1) {
      return { status: "AMBIGUOUS", entryIndexes: values };
    }
    strongMatches.push(values[0]);
  }
  const uniqueStrongMatches = [...new Set(strongMatches)];
  if (uniqueStrongMatches.length > 1) {
    return { status: "AMBIGUOUS", entryIndexes: uniqueStrongMatches.sort() };
  }
  if (uniqueStrongMatches.length === 1) {
    return { status: "MATCH", entryIndex: uniqueStrongMatches[0] };
  }

  const aliasMatches = [];
  for (const alias of identity.aliases) {
    if (!indexes.aliases.has(alias)) continue;
    const values = [...indexes.aliases.get(alias)].sort((left, right) => left - right);
    if (values.length > 1) {
      return { status: "AMBIGUOUS", entryIndexes: values };
    }
    aliasMatches.push(values[0]);
  }
  const uniqueAliasMatches = [...new Set(aliasMatches)];
  if (uniqueAliasMatches.length > 1) {
    return { status: "AMBIGUOUS", entryIndexes: uniqueAliasMatches.sort() };
  }
  return uniqueAliasMatches.length === 1
    ? { status: "MATCH", entryIndex: uniqueAliasMatches[0] }
    : { status: "MISS" };
}

export function collectPrecomputedLegacyLuaRequestedIdentities(input) {
  const records = [
    ...(Array.isArray(input?.identities) ? input.identities : []),
    ...(Array.isArray(input?.cards) ? input.cards : []),
    ...(Array.isArray(input?.retrievedCards) ? input.retrievedCards : []),
    ...(Array.isArray(input?.evidence?.retrievedCards)
      ? input.evidence.retrievedCards
      : []),
    ...(Array.isArray(input?.cardResolution?.resolvedCards)
      ? input.cardResolution.resolvedCards
      : []),
  ];
  if (records.length > MAX_INPUT_IDENTITIES) {
    throw identityError(
      `precomputed legacy Lua lookup exceeds ${MAX_INPUT_IDENTITIES} identity records`,
    );
  }
  const byKey = new Map();
  for (const record of records) {
    const identity = normalizeInputIdentity(record);
    const key = JSON.stringify(identity);
    if (!byKey.has(key)) byKey.set(key, identity);
  }
  return [...byKey.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function normalizeInputIdentity(card) {
  if (!isPlainObject(card)) {
    throw identityError("precomputed legacy Lua card identities must be objects");
  }
  const passcodes = uniqueSorted([
    card.passcode,
    card.password,
    card.raw?.passcode,
    card.raw?.password,
    card.raw?.raw?.passcode,
    card.raw?.raw?.password,
  ].map(normalizeLegacyLuaPasscode).filter(Boolean));
  if (passcodes.length > 1) {
    throw identityError("one card identity contains conflicting explicit passcodes");
  }
  const sourceUrlCid = String(card.sourceUrl || card.ygoResourcesUrl || "")
    .match(/\/data\/card\/(\d{1,10})(?:$|[/?#])/u)?.[1];
  const cids = uniqueSorted([
    card.cid,
    sourceUrlCid,
    card.id,
    card.cardId,
    card.raw?.cid,
    card.raw?.raw?.cid,
  ].map(normalizePrecomputedLegacyLuaCid).filter(Boolean));
  if (cids.length > 1) {
    throw identityError("one card identity contains conflicting stable CIDs");
  }
  if (card.aliases !== undefined && !Array.isArray(card.aliases)) {
    throw identityError("card identity aliases must be an array");
  }
  const rawAliases = [
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
    card.raw?.name,
    card.raw?.cnName,
    card.raw?.jaName,
    card.raw?.jpName,
    card.raw?.enName,
  ].filter((value) => value !== undefined && value !== null);
  if (rawAliases.some((alias) => typeof alias !== "string")) {
    throw identityError("card identity aliases must be strings");
  }
  const aliases = uniqueSorted(rawAliases
    .map(normalizePrecomputedLegacyLuaAlias)
    .filter(Boolean));
  if (aliases.length > MAX_ALIASES_PER_IDENTITY) {
    throw identityError(
      `one card identity exceeds ${MAX_ALIASES_PER_IDENTITY} exact aliases`,
    );
  }
  const identity = {
    passcode: passcodes[0] || null,
    cid: cids[0] || null,
    aliases,
  };
  // A supplied but unresolved record is still a requested card. Retaining an
  // empty exact identity makes it an explicit cache miss, so another matched
  // record cannot accidentally make partial coverage look complete.
  return deepFreeze(identity);
}

function createIncompleteCoverageResource({
  cache,
  matchedResourceIds,
  requestedIdentityCount,
  matchedIdentityCount,
  misses,
}) {
  const details = {
    cacheSchemaVersion: cache.schemaVersion,
    cacheGeneratedAt: cache.generatedAt,
    requestedIdentityCount,
    matchedIdentityCount,
    unmatchedIdentityCount: misses.length,
    unmatchedIdentitySha256s: misses.map((identity) =>
      canonicalLegacyLuaSha256(identity)
    ).sort(),
    retryable: false,
  };
  const suffix = canonicalLegacyLuaSha256(details).slice(0, 24);
  let resourceId = `precomputed-cache:coverage-incomplete:${suffix}`;
  const occupied = new Set(matchedResourceIds);
  while (occupied.has(resourceId)) resourceId += ":unknown";
  return finalizeLegacyLuaSemanticResource({
    status: "TYPED_UNKNOWN",
    resourceId,
    resourceBinding: {
      sourceDocumentId: null,
      sourceContentSha256: null,
      documentVersion: cache.schemaVersion,
      locator: null,
      retrievedAt: cache.generatedAt,
    },
    engineBinding: null,
    registryBinding: null,
    candidateSetSha256: null,
    effectCandidates: [],
    unknownReasons: [{
      phase: CACHE_PHASE,
      code: "LEGACY_LUA_PRECOMPUTED_COVERAGE_INCOMPLETE",
      message: "precomputed legacy Lua resources cover only part of the requested exact card identities",
      evidenceIds: [],
      details,
    }],
  });
}

export function normalizePrecomputedLegacyLuaCid(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d+$/u.test(text)) return null;
  const canonical = BigInt(text).toString(10);
  return /^[1-9]\d{2,6}$/u.test(canonical) ? canonical : null;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim() ||
      !Number.isFinite(new Date(value).getTime())) {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      "precomputed legacy Lua cache generatedAt must be an ISO-compatible timestamp",
    );
  }
  return new Date(value).toISOString();
}

function cloneJsonMetadata(value, label) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw cacheError(
      "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
      `${label} must be JSON serializable`,
    );
  }
}

function cacheError(code, message, details = undefined) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function identityError(message) {
  return cacheError("LEGACY_LUA_PRECOMPUTED_IDENTITY_INVALID", message);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) =>
    String(left).localeCompare(String(right))
  );
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  values.forEach((value) => {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  });
  return [...repeated].sort();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    value.forEach((entryValue, entryKey) => {
      deepFreeze(entryKey, seen);
      deepFreeze(entryValue, seen);
    });
  } else if (value instanceof Set) {
    value.forEach((entry) => deepFreeze(entry, seen));
  } else {
    Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  }
  return Object.freeze(value);
}
