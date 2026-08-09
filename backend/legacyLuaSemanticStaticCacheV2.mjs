import {
  canonicalLegacyLuaSha256,
  createLegacyLuaUnknownPacket,
  normalizeLegacyLuaPasscode,
} from "./legacyLuaSemanticPacket.mjs";
import {
  comparePrecomputedLegacyLuaStableText,
  collectPrecomputedLegacyLuaRequestedIdentities,
  createPrecomputedLegacyLuaSemanticPacketFactory,
  normalizePrecomputedLegacyLuaAlias,
  normalizePrecomputedLegacyLuaCid,
  PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA,
  validatePrecomputedLegacyLuaSemanticCache,
} from "./legacyLuaSemanticStaticCacheFactory.mjs";

export const PRECOMPUTED_LEGACY_LUA_MANIFEST_SCHEMA =
  "ocg-assistant-precomputed-legacy-lua-cache-manifest/v2";
export const PRECOMPUTED_LEGACY_LUA_SHARD_SCHEMA =
  "ocg-assistant-precomputed-legacy-lua-cache-shard/v2";
export const PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY =
  "REGISTRY_DERIVED_ACTIVATION_LEGALITY/v1";
export const PRECOMPUTED_LEGACY_LUA_SHARD_STRATEGY =
  "SHA256_PASSCODE_PREFIX_2/v1";

const CACHE_PHASE = "LEGACY_LUA_PRECOMPUTED_CACHE";
const SHARD_ID = /^[a-f0-9]{2}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHARD_PATH = /^shards\/[a-f0-9]{2}\.json$/u;

export function precomputedLegacyLuaShardId(passcode) {
  const normalized = normalizeLegacyLuaPasscode(passcode);
  if (normalized === null) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_IDENTITY_INVALID",
      "shard selection requires a valid non-zero uint32 passcode",
    );
  }
  return canonicalLegacyLuaSha256(normalized).slice(0, 2);
}

export function createPrecomputedLegacyLuaCacheShard({
  shardId,
  generatedAt,
  entries = [],
} = {}) {
  const normalizedShardId = validateShardId(shardId);
  const timestamp = normalizeTimestamp(generatedAt);
  const cache = validatePrecomputedLegacyLuaSemanticCache({
    schemaVersion: PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA,
    generatedAt: timestamp,
    source: null,
    selection: null,
    entries,
  });
  const orderedEntries = [...cache.entries].sort(compareEntries);
  for (const entry of orderedEntries) {
    if (entry.passcode === null ||
        precomputedLegacyLuaShardId(entry.passcode) !== normalizedShardId) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
        `every shard ${normalizedShardId} entry must carry a passcode assigned to that shard`,
      );
    }
  }
  const content = {
    schemaVersion: PRECOMPUTED_LEGACY_LUA_SHARD_SCHEMA,
    shardId: normalizedShardId,
    generatedAt: timestamp,
    entries: orderedEntries,
  };
  return deepFreeze({
    ...content,
    shardContentSha256: canonicalLegacyLuaSha256(content),
  });
}

export function validatePrecomputedLegacyLuaCacheShard(
  value,
  { descriptor = null, manifestGeneratedAt = null } = {},
) {
  assertPlainObject(value, "precomputed legacy Lua shard");
  assertExactKeys(value, new Set([
    "schemaVersion",
    "shardId",
    "generatedAt",
    "entries",
    "shardContentSha256",
  ]), "precomputed legacy Lua shard");
  if (value.schemaVersion !== PRECOMPUTED_LEGACY_LUA_SHARD_SCHEMA) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
      "precomputed legacy Lua shard schema is unsupported",
    );
  }
  if (!SHA256.test(String(value.shardContentSha256 || ""))) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
      "precomputed legacy Lua shard content hash is invalid",
    );
  }
  const normalized = createPrecomputedLegacyLuaCacheShard(value);
  if (normalized.shardContentSha256 !== value.shardContentSha256) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
      "precomputed legacy Lua shard content does not match its hash",
    );
  }
  if (manifestGeneratedAt !== null &&
      normalized.generatedAt !== normalizeTimestamp(manifestGeneratedAt)) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
      "precomputed legacy Lua shard was generated for a different manifest",
    );
  }
  if (descriptor !== null) {
    const validatedDescriptor = validateShardDescriptor(descriptor);
    if (validatedDescriptor.shardId !== normalized.shardId ||
        validatedDescriptor.contentSha256 !== normalized.shardContentSha256 ||
        validatedDescriptor.entryCount !== normalized.entries.length) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
        "precomputed legacy Lua shard does not match its manifest descriptor",
      );
    }
  }
  return normalized;
}

export function createPrecomputedLegacyLuaShardSummary({
  shard,
  path,
  serializedBytes,
} = {}) {
  const normalized = validatePrecomputedLegacyLuaCacheShard(shard);
  const shardPath = validateShardPath(path, normalized.shardId);
  if (!Number.isSafeInteger(serializedBytes) || serializedBytes <= 0) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "shard serializedBytes must be a positive safe integer",
    );
  }
  return deepFreeze({
    descriptor: {
      shardId: normalized.shardId,
      path: shardPath,
      entryCount: normalized.entries.length,
      contentSha256: normalized.shardContentSha256,
      serializedBytes,
    },
    identities: normalized.entries.map((entry) => ({
      cid: entry.cid,
      passcode: entry.passcode,
      aliases: entry.aliases,
    })),
  });
}

export function createPrecomputedLegacyLuaCacheManifest({
  generatedAt,
  source,
  selection,
  shardSummaries = [],
} = {}) {
  const timestamp = normalizeTimestamp(generatedAt);
  validateSelection(selection);
  if (!Array.isArray(shardSummaries)) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "manifest shard summaries must be an array",
    );
  }
  const summaries = shardSummaries.map(validateShardSummary)
    .sort((left, right) => comparePrecomputedLegacyLuaStableText(
      left.descriptor.shardId,
      right.descriptor.shardId,
    ));
  rejectDuplicates(
    summaries.map((summary) => summary.descriptor.shardId),
    "manifest contains duplicate shard IDs",
  );
  rejectDuplicates(
    summaries.map((summary) => summary.descriptor.path),
    "manifest contains duplicate shard paths",
  );
  const indexes = {
    cids: Object.create(null),
    passcodes: Object.create(null),
    aliases: Object.create(null),
  };
  for (const summary of summaries) {
    const shardId = summary.descriptor.shardId;
    for (const identity of summary.identities) {
      addIndexValue(indexes.cids, identity.cid, shardId);
      addIndexValue(indexes.passcodes, identity.passcode, shardId);
      identity.aliases.forEach((alias) =>
        addIndexValue(indexes.aliases, alias, shardId)
      );
    }
  }
  normalizeIndexValues(indexes);
  const content = {
    schemaVersion: PRECOMPUTED_LEGACY_LUA_MANIFEST_SCHEMA,
    generatedAt: timestamp,
    source: cloneJson(source),
    selection: cloneJson(selection),
    shardStrategy: {
      id: PRECOMPUTED_LEGACY_LUA_SHARD_STRATEGY,
      prefixLength: 2,
    },
    indexes,
    shards: summaries.map((summary) => summary.descriptor),
  };
  return validatePrecomputedLegacyLuaCacheManifest({
    ...content,
    manifestContentSha256: canonicalLegacyLuaSha256(content),
  });
}

export function validatePrecomputedLegacyLuaCacheManifest(value) {
  assertPlainObject(value, "precomputed legacy Lua manifest");
  assertExactKeys(value, new Set([
    "schemaVersion",
    "generatedAt",
    "source",
    "selection",
    "shardStrategy",
    "indexes",
    "shards",
    "manifestContentSha256",
  ]), "precomputed legacy Lua manifest");
  if (value.schemaVersion !== PRECOMPUTED_LEGACY_LUA_MANIFEST_SCHEMA) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "precomputed legacy Lua manifest schema is unsupported",
    );
  }
  const generatedAt = normalizeTimestamp(value.generatedAt);
  validateSelection(value.selection);
  assertPlainObject(value.shardStrategy, "manifest shardStrategy");
  assertExactKeys(value.shardStrategy, new Set(["id", "prefixLength"]),
    "manifest shardStrategy");
  if (value.shardStrategy.id !== PRECOMPUTED_LEGACY_LUA_SHARD_STRATEGY ||
      value.shardStrategy.prefixLength !== 2) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "precomputed legacy Lua shard strategy is unsupported",
    );
  }
  if (!Array.isArray(value.shards)) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "manifest shards must be an array",
    );
  }
  const shards = value.shards.map(validateShardDescriptor);
  assertSorted(shards.map((item) => item.shardId),
    "manifest shards must use stable shardId order");
  rejectDuplicates(shards.map((item) => item.shardId),
    "manifest contains duplicate shard IDs");
  rejectDuplicates(shards.map((item) => item.path),
    "manifest contains duplicate shard paths");
  const shardIds = new Set(shards.map((item) => item.shardId));
  const indexes = validateIndexes(value.indexes, shardIds);
  const content = {
    schemaVersion: PRECOMPUTED_LEGACY_LUA_MANIFEST_SCHEMA,
    generatedAt,
    source: cloneJson(value.source),
    selection: cloneJson(value.selection),
    shardStrategy: {
      id: PRECOMPUTED_LEGACY_LUA_SHARD_STRATEGY,
      prefixLength: 2,
    },
    indexes,
    shards,
  };
  const expectedHash = canonicalLegacyLuaSha256(content);
  if (!SHA256.test(String(value.manifestContentSha256 || "")) ||
      value.manifestContentSha256 !== expectedHash) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "precomputed legacy Lua manifest content hash is invalid",
    );
  }
  return deepFreeze({
    ...content,
    manifestContentSha256: expectedHash,
  });
}

/**
 * Loads only the shards named by explicit identities in the current question.
 * Loaded entries still pass through the v1 resource validator and packet
 * factory, preserving its ambiguity handling, partial-coverage marker and
 * non-authoritative verdict boundary.
 */
export function createShardedPrecomputedLegacyLuaSemanticPacketFactory({
  manifest,
  loadShard,
  maxCandidates = Number.MAX_SAFE_INTEGER,
  maxSerializedBytes = null,
} = {}) {
  let validatedManifest = null;
  let configurationError = null;
  try {
    validatedManifest = validatePrecomputedLegacyLuaCacheManifest(manifest);
    if (typeof loadShard !== "function") {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        "sharded precomputed cache requires a shard loader",
      );
    }
  } catch (error) {
    configurationError = error;
  }
  const shardPromises = new Map();

  return async function shardedPrecomputedLegacyLuaFactory(input = {}) {
    if (configurationError) return unknownFromError(configurationError);
    let identities;
    try {
      identities = collectPrecomputedLegacyLuaRequestedIdentities(input);
    } catch (error) {
      return unknownFromError(error);
    }
    const shardIds = selectShardIds(identities, validatedManifest.indexes);
    const descriptors = new Map(validatedManifest.shards.map((item) => [
      item.shardId,
      item,
    ]));
    let shards;
    try {
      shards = await Promise.all(shardIds.map(async (shardId) => {
        if (!shardPromises.has(shardId)) {
          const descriptor = descriptors.get(shardId);
          shardPromises.set(shardId, Promise.resolve(loadShard(descriptor))
            .then((value) => validatePrecomputedLegacyLuaCacheShard(value, {
              descriptor,
              manifestGeneratedAt: validatedManifest.generatedAt,
            }))
            .catch((error) => {
              shardPromises.delete(shardId);
              throw error;
            }));
        }
        return shardPromises.get(shardId);
      }));
    } catch (error) {
      return createLegacyLuaUnknownPacket({
        code: error?.code || "LEGACY_LUA_PRECOMPUTED_SHARD_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        details: { retryable: false },
      });
    }
    const cache = {
      schemaVersion: PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA,
      generatedAt: validatedManifest.generatedAt,
      source: validatedManifest.source,
      selection: validatedManifest.selection,
      entries: shards.flatMap((shard) => shard.entries),
    };
    return createPrecomputedLegacyLuaSemanticPacketFactory({
      cache,
      maxCandidates,
      maxSerializedBytes,
    })(input);
  };
}

function selectShardIds(identities, indexes) {
  const selected = new Set();
  for (const identity of identities) {
    const strong = new Set([
      ...indexLookup(indexes.passcodes, identity.passcode),
      ...indexLookup(indexes.cids, identity.cid),
    ]);
    if (strong.size > 0) {
      strong.forEach((shardId) => selected.add(shardId));
      continue;
    }
    for (const alias of identity.aliases) {
      indexLookup(indexes.aliases, alias).forEach((shardId) =>
        selected.add(shardId)
      );
    }
  }
  return [...selected].sort(comparePrecomputedLegacyLuaStableText);
}

function validateSelection(value) {
  assertPlainObject(value, "manifest selection");
  if (value.policy !== PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY ||
      value.corpus !== "data/cards.json") {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "manifest selection must use the registry-derived full-card-corpus policy",
    );
  }
  for (const forbidden of ["caseIds", "evaluationCaseIds", "expectedCardIds"]) {
    if (Object.hasOwn(value, forbidden)) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        `manifest selection must not contain ${forbidden}`,
      );
    }
  }
}

function validateShardSummary(value) {
  assertPlainObject(value, "shard summary");
  assertExactKeys(value, new Set(["descriptor", "identities"]),
    "shard summary");
  const descriptor = validateShardDescriptor(value.descriptor);
  if (!Array.isArray(value.identities) ||
      value.identities.length !== descriptor.entryCount) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "shard summary identity count must match its descriptor",
    );
  }
  const identities = value.identities.map((identity) => {
    assertPlainObject(identity, "shard identity");
    const cid = normalizePrecomputedLegacyLuaCid(identity.cid);
    const passcode = normalizeLegacyLuaPasscode(identity.passcode);
    if (passcode === null || precomputedLegacyLuaShardId(passcode) !== descriptor.shardId) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        "shard identity passcode does not match its shard",
      );
    }
    if (!Array.isArray(identity.aliases)) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        "shard identity aliases must be an array",
      );
    }
    const aliases = [...new Set(identity.aliases.map((alias) => {
      const normalized = normalizePrecomputedLegacyLuaAlias(alias);
      if (normalized === null) {
        throw contractError(
          "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
          "shard identity contains an invalid alias",
        );
      }
      return normalized;
    }))].sort(comparePrecomputedLegacyLuaStableText);
    return { cid, passcode, aliases };
  });
  return { descriptor, identities };
}

function validateShardDescriptor(value) {
  assertPlainObject(value, "manifest shard descriptor");
  assertExactKeys(value, new Set([
    "shardId",
    "path",
    "entryCount",
    "contentSha256",
    "serializedBytes",
  ]), "manifest shard descriptor");
  const shardId = validateShardId(value.shardId);
  const path = validateShardPath(value.path, shardId);
  if (!Number.isSafeInteger(value.entryCount) || value.entryCount < 0 ||
      !Number.isSafeInteger(value.serializedBytes) || value.serializedBytes <= 0 ||
      !SHA256.test(String(value.contentSha256 || ""))) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "manifest shard descriptor counts or hash are invalid",
    );
  }
  return {
    shardId,
    path,
    entryCount: value.entryCount,
    contentSha256: value.contentSha256,
    serializedBytes: value.serializedBytes,
  };
}

function validateIndexes(value, shardIds) {
  assertPlainObject(value, "manifest indexes");
  assertExactKeys(value, new Set(["cids", "passcodes", "aliases"]),
    "manifest indexes");
  return {
    cids: validateIndex(value.cids, shardIds, (key) =>
      normalizePrecomputedLegacyLuaCid(key) === key),
    passcodes: validateIndex(value.passcodes, shardIds, (key) =>
      normalizeLegacyLuaPasscode(key) === key),
    aliases: validateIndex(value.aliases, shardIds, (key) =>
      normalizePrecomputedLegacyLuaAlias(key) === key),
  };
}

function validateIndex(value, shardIds, validKey) {
  assertPlainObject(value, "manifest identity index");
  const result = Object.create(null);
  for (const [key, rawShardIds] of Object.entries(value)) {
    if (!validKey(key) || !Array.isArray(rawShardIds) || rawShardIds.length === 0) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        "manifest identity index contains an invalid key or shard list",
      );
    }
    const normalized = [...new Set(rawShardIds)]
      .sort(comparePrecomputedLegacyLuaStableText);
    if (normalized.length !== rawShardIds.length ||
        normalized.some((item, index) => item !== rawShardIds[index] ||
          !shardIds.has(item))) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        "manifest identity index shard references must be unique, sorted, and declared",
      );
    }
    result[key] = normalized;
  }
  return result;
}

function addIndexValue(index, key, shardId) {
  if (key === null) return;
  if (!Object.hasOwn(index, key)) index[key] = [];
  index[key].push(shardId);
}

function normalizeIndexValues(indexes) {
  for (const index of Object.values(indexes)) {
    for (const key of Object.keys(index)) {
      index[key] = [...new Set(index[key])]
        .sort(comparePrecomputedLegacyLuaStableText);
    }
  }
}

function indexLookup(index, key) {
  return key !== null && Object.hasOwn(index, key) ? index[key] : [];
}

function validateShardId(value) {
  const text = String(value || "");
  if (!SHARD_ID.test(text)) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
      "precomputed legacy Lua shardId must be two lowercase hex characters",
    );
  }
  return text;
}

function validateShardPath(value, shardId) {
  const text = String(value || "").replace(/\\/gu, "/");
  if (!SHARD_PATH.test(text) || text !== `shards/${shardId}.json`) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "manifest shard paths must be canonical relative shard JSON paths",
    );
  }
  return text;
}

function compareEntries(left, right) {
  return comparePrecomputedLegacyLuaStableText(left.passcode, right.passcode) ||
    comparePrecomputedLegacyLuaStableText(left.cid, right.cid) ||
    comparePrecomputedLegacyLuaStableText(
      left.resource.resourceId,
      right.resource.resourceId,
    );
}

function normalizeTimestamp(value) {
  const time = typeof value === "string" ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(time)) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "precomputed cache timestamp must be ISO-compatible",
    );
  }
  return new Date(time).toISOString();
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      "precomputed cache metadata must be JSON serializable",
    );
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(
      "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
      `${label} must be a plain object`,
    );
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw contractError(
        "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
        `${label} is missing field ${key}`,
      );
    }
  }
}

function assertSorted(values, message) {
  const sorted = [...values].sort(comparePrecomputedLegacyLuaStableText);
  if (values.some((value, index) => value !== sorted[index])) {
    throw contractError("LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID", message);
  }
}

function rejectDuplicates(values, message) {
  if (new Set(values).size !== values.length) {
    throw contractError("LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID", message);
  }
}

function unknownFromError(error) {
  return createLegacyLuaUnknownPacket({
    code: error?.code || "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
    message: error instanceof Error ? error.message : String(error),
    details: { retryable: false },
  });
}

function contractError(code, message, details = undefined) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}
