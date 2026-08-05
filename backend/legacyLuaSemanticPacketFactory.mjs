import {
  collectLegacyLuaSemanticPacket,
} from "./legacyLuaSemanticClient.mjs";
import {
  createLegacyLuaUnknownPacket,
  normalizeLegacyLuaPasscode,
  serializeLegacyLuaSemanticPacket,
  validateLegacyLuaSemanticPacket,
} from "./legacyLuaSemanticPacket.mjs";
import {
  createLegacyLuaSemanticHttpFacade,
} from "./legacyLuaSemanticHttpFacade.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CARDS = 8;
const DEFAULT_MAX_CANDIDATES = 48;
const DEFAULT_MAX_PACKET_BYTES = 192 * 1024;
const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Creates the production packet factory. The WeakMap is intentionally scoped
 * to this composition instance: repeated consumers of the same run input share
 * one immutable promise, while different runs never share stale engine locks.
 */
export function createDefaultLegacyLuaSemanticPacketFactory({
  env: configuredEnv,
  fetchImpl: configuredFetch,
  timeoutMs: configuredTimeoutMs,
  maxCards: configuredMaxCards,
  maxCandidates: configuredMaxCandidates,
  maxSerializedBytes: configuredMaxBytes,
  maxHttpResponseBytes: configuredMaxHttpBytes,
  facadeFactory = createLegacyLuaSemanticHttpFacade,
  collectPacket = collectLegacyLuaSemanticPacket,
} = {}) {
  const runPromises = new WeakMap();
  return function legacyLuaSemanticPacketFactory(input = {}) {
    if (input && typeof input === "object") {
      const existing = runPromises.get(input);
      if (existing) return existing;
      const pending = generatePacket({
        input,
        configuredEnv,
        configuredFetch,
        configuredTimeoutMs,
        configuredMaxCards,
        configuredMaxCandidates,
        configuredMaxBytes,
        configuredMaxHttpBytes,
        facadeFactory,
        collectPacket,
      });
      runPromises.set(input, pending);
      return pending;
    }
    return generatePacket({
      input: {},
      configuredEnv,
      configuredFetch,
      configuredTimeoutMs,
      configuredMaxCards,
      configuredMaxCandidates,
      configuredMaxBytes,
      configuredMaxHttpBytes,
      facadeFactory,
      collectPacket,
    });
  };
}

/**
 * Reads only explicit password/passcode fields. In particular, local DB `id`
 * and `cardId` values are not accepted because they may be KONAMI CIDs rather
 * than the non-zero uint32 card password used by c{passcode}.lua.
 */
export function collectEffectiveLegacyLuaPasscodes(input = {}) {
  return collectLegacyLuaIdentityPlan(input).passcodes;
}

/**
 * Produces exact-name lookup requests only for cards that do not already carry
 * an explicit password. Names remain aliases of one resolved card; they are
 * never fuzzy-matched or promoted from a bare CID.
 */
export function collectEffectiveLegacyLuaCardIdentities(input = {}) {
  return collectLegacyLuaIdentityPlan(input).identityRequests;
}

async function generatePacket({
  input,
  configuredEnv,
  configuredFetch,
  configuredTimeoutMs,
  configuredMaxCards,
  configuredMaxCandidates,
  configuredMaxBytes,
  configuredMaxHttpBytes,
  facadeFactory,
  collectPacket,
}) {
  const env = configuredEnv || input.env || globalThis.process?.env || {};
  const fetchImpl = configuredFetch || input.fetchImpl || globalThis.fetch;
  const timeoutMs = boundedEnvInteger(
    configuredTimeoutMs ?? env.RAG_LEGACY_LUA_TIMEOUT_MS,
    50,
    10_000,
    DEFAULT_TIMEOUT_MS,
  );
  const maxCards = boundedEnvInteger(
    configuredMaxCards ?? env.RAG_LEGACY_LUA_MAX_CARDS,
    1,
    32,
    DEFAULT_MAX_CARDS,
  );
  const maxCandidates = boundedEnvInteger(
    configuredMaxCandidates ?? env.RAG_LEGACY_LUA_MAX_CANDIDATES,
    1,
    256,
    DEFAULT_MAX_CANDIDATES,
  );
  const maxSerializedBytes = boundedEnvInteger(
    input.maxSerializedBytes ?? configuredMaxBytes ??
      env.RAG_LEGACY_LUA_MAX_BYTES,
    1_024,
    2 * 1024 * 1024,
    DEFAULT_MAX_PACKET_BYTES,
  );
  const maxHttpResponseBytes = boundedEnvInteger(
    configuredMaxHttpBytes ?? env.RAG_LEGACY_LUA_MAX_HTTP_RESPONSE_BYTES,
    1_024,
    16 * 1024 * 1024,
    DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  );
  let explicitPasscodes;
  let identityRequests;
  try {
    const identityPlan = collectLegacyLuaIdentityPlan(input);
    explicitPasscodes = identityPlan.passcodes;
    identityRequests = identityPlan.identityRequests;
  } catch (error) {
    return createLegacyLuaUnknownPacket({
      code: error?.code || "LEGACY_LUA_CARD_IDENTITY_INVALID",
      message: error instanceof Error ? error.message : String(error),
      details: { retryable: false },
    });
  }
  if (explicitPasscodes.length === 0 && identityRequests.length === 0) {
    return createLegacyLuaUnknownPacket({
      code: "LEGACY_LUA_PASSCODE_UNAVAILABLE",
      message: "no verified uint32 card passcode is available for legacy Lua lookup",
      details: { retryable: false },
    });
  }
  if (explicitPasscodes.length + identityRequests.length > maxCards) {
    return createLegacyLuaUnknownPacket({
      code: "LEGACY_LUA_CARD_LIMIT_EXCEEDED",
      message: `legacy Lua lookup exceeds the ${maxCards}-card safety limit`,
      details: {
        cardCount: explicitPasscodes.length + identityRequests.length,
        maxCards,
        retryable: false,
      },
    });
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener?.("abort", forwardAbort, { once: true });
  const timeoutError = new Error(
    `legacy Lua semantic packet generation exceeded ${timeoutMs}ms`,
  );
  timeoutError.code = "LEGACY_LUA_PACKET_TIMEOUT";
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  timer.unref?.();

  try {
    const packet = await Promise.race([collect(), deadline]);
    const validated = validateLegacyLuaSemanticPacket(packet);
    const bytes = Buffer.byteLength(
      serializeLegacyLuaSemanticPacket(validated),
      "utf8",
    );
    if (bytes > maxSerializedBytes) {
      const error = new Error(
        `legacy Lua semantic packet exceeds ${maxSerializedBytes} UTF-8 bytes`,
      );
      error.code = "LEGACY_LUA_PACKET_TOO_LARGE";
      throw error;
    }
    return validated;
  } catch (error) {
    return createLegacyLuaUnknownPacket({
      code: error?.code || "LEGACY_LUA_PACKET_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      details: {
        retryable: isRetryable(error),
        ...(error?.details && typeof error.details === "object"
          ? { cause: jsonSafe(error.details) }
          : {}),
      },
    });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener?.("abort", forwardAbort);
  }

  async function collect() {
    const engine = facadeFactory({
      env,
      fetchImpl,
      signal: controller.signal,
      timeoutMs,
      maxResponseBytes: maxHttpResponseBytes,
    });
    const passcodes = new Set(explicitPasscodes);
    if (identityRequests.length > 0) {
      const identityResolution = await engine.resolveLegacyLuaCardIdentities(
        identityRequests,
      );
      const failures = identityResolution.matches.filter(
        (match) => match.status !== "RESOLVED",
      );
      if (failures.length > 0 ||
          identityResolution.matches.length !== identityRequests.length) {
        return createLegacyLuaUnknownPacket({
          code: "LEGACY_LUA_CARD_IDENTITY_UNRESOLVED",
          message: "one or more resolved card names could not be bound uniquely to a locked CDB passcode",
          details: {
            retryable: false,
            failures: failures.map((match) => ({
              clientKey: match.clientKey,
              status: match.status,
            })),
          },
        });
      }
      identityResolution.matches.forEach((match) => passcodes.add(match.passcode));
    }
    if (passcodes.size > maxCards) {
      return createLegacyLuaUnknownPacket({
        code: "LEGACY_LUA_CARD_LIMIT_EXCEEDED",
        message: `legacy Lua lookup exceeds the ${maxCards}-card safety limit`,
        details: { cardCount: passcodes.size, maxCards, retryable: false },
      });
    }
    const orderedPasscodes = [...passcodes].sort();
    const sourceResults = await Promise.allSettled(orderedPasscodes.map((passcode) =>
      engine.resolveLegacyLuaSource(passcode)
    ));
    const inputs = sourceResults.map((result, index) => {
      if (result.status === "fulfilled") {
        return { sourceDocument: result.value };
      }
      const error = result.reason;
      return {
        unresolvedSource: {
          passcode: orderedPasscodes[index],
          code: error?.code || "LEGACY_LUA_SOURCE_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
          details: {
            retryable: isRetryable(error),
            ...(error?.details && typeof error.details === "object"
              ? { cause: jsonSafe(error.details) }
              : {}),
          },
        },
      };
    });
    return collectPacket({
      inputs,
      engine,
      maxCandidates,
      maxSerializedBytes,
    });
  }
}

function collectInputCards(input = {}) {
  return [
    ...(Array.isArray(input?.retrievedCards) ? input.retrievedCards : []),
    ...(Array.isArray(input?.evidence?.retrievedCards)
      ? input.evidence.retrievedCards
      : []),
    ...(Array.isArray(input?.cardResolution?.resolvedCards)
      ? input.cardResolution.resolvedCards
      : []),
  ];
}

function collectLegacyLuaIdentityPlan(input = {}) {
  const records = collectInputCards(input).map(normalizeIdentityRecord);
  const cidGroups = new Map();
  const aliasToCids = new Map();
  const aliasToPasscodes = new Map();
  const passcodeToCids = new Map();

  for (const record of records) {
    if (record.passcode !== null) {
      for (const alias of record.normalizedNames) {
        addIdentityRelation(aliasToPasscodes, alias, record.passcode);
      }
    }
    if (record.cid === null) continue;
    let group = cidGroups.get(record.cid);
    if (!group) {
      group = {
        cid: record.cid,
        names: [],
        normalizedNames: new Set(),
        passcodes: new Set(),
      };
      cidGroups.set(record.cid, group);
    }
    mergeIdentityNames(group, record.names);
    if (record.passcode !== null) group.passcodes.add(record.passcode);
    for (const alias of record.normalizedNames) {
      addIdentityRelation(aliasToCids, alias, record.cid);
    }
  }

  rejectAmbiguousRelations(aliasToCids,
    "one exact card alias is attached to multiple stable CIDs");
  rejectAmbiguousRelations(aliasToPasscodes,
    "one exact card alias is attached to multiple explicit passcodes");

  for (const group of cidGroups.values()) {
    if (group.passcodes.size > 1) {
      throw identityConflictError(
        `stable CID ${group.cid} is attached to multiple passcodes`,
      );
    }
    if (group.passcodes.size === 1) {
      const passcode = [...group.passcodes][0];
      addIdentityRelation(passcodeToCids, passcode, group.cid);
    }
  }
  rejectAmbiguousRelations(passcodeToCids,
    "one explicit passcode is attached to multiple stable CIDs");

  // A stable CID without a password may inherit one only from an exact alias
  // that has a unique explicit-password mapping elsewhere in the same frozen
  // input. Nothing fuzzy is joined and a conflicting alias set is rejected.
  for (const group of cidGroups.values()) {
    const explicitMatches = relationValuesForAliases(
      aliasToPasscodes,
      group.normalizedNames,
    );
    if (explicitMatches.size > 1) {
      throw identityConflictError(
        `stable CID ${group.cid} aliases resolve to multiple passcodes`,
      );
    }
    const existing = group.passcodes.size === 1
      ? [...group.passcodes][0]
      : null;
    const matched = explicitMatches.size === 1
      ? [...explicitMatches][0]
      : null;
    if (existing !== null && matched !== null && existing !== matched) {
      throw identityConflictError(
        `stable CID ${group.cid} conflicts with its exact-alias passcode`,
      );
    }
    const resolvedPasscode = existing ?? matched;
    if (resolvedPasscode === null) continue;
    group.passcodes = new Set([resolvedPasscode]);
    addIdentityRelation(passcodeToCids, resolvedPasscode, group.cid);
  }
  rejectAmbiguousRelations(passcodeToCids,
    "one explicit passcode is attached to multiple stable CIDs");

  // Propagate the verified CID/passcode association to all exact aliases so a
  // lower-information duplicate without a CID does not trigger a second
  // exact-name lookup.
  for (const group of cidGroups.values()) {
    if (group.passcodes.size !== 1) continue;
    const passcode = [...group.passcodes][0];
    for (const alias of group.normalizedNames) {
      addIdentityRelation(aliasToPasscodes, alias, passcode);
    }
  }
  rejectAmbiguousRelations(aliasToPasscodes,
    "one exact card alias is attached to multiple explicit passcodes");

  const passcodes = new Set(records
    .map((record) => record.passcode)
    .filter((passcode) => passcode !== null));
  const pendingIdentityNames = [];
  for (const group of cidGroups.values()) {
    if (group.passcodes.size === 1) {
      passcodes.add([...group.passcodes][0]);
    } else if (group.names.length > 0) {
      pendingIdentityNames.push(group.names);
    }
  }
  for (const record of records) {
    if (record.cid !== null || record.passcode !== null ||
        record.names.length === 0) continue;
    const matches = relationValuesForAliases(
      aliasToPasscodes,
      record.normalizedNames,
    );
    if (matches.size > 1) {
      throw identityConflictError(
        "a card without CID has aliases mapped to multiple explicit passcodes",
      );
    }
    if (matches.size === 1) continue;
    pendingIdentityNames.push(record.names);
  }

  const uniqueRequests = new Map();
  for (const names of pendingIdentityNames) {
    const key = names.map(normalizeExactIdentityName).sort().join("\u0000");
    if (!uniqueRequests.has(key)) uniqueRequests.set(key, [...names]);
  }
  const identityRequests = [...uniqueRequests.values()].map((names, index) => ({
    clientKey: `resolved-card-${index + 1}`,
    names,
  }));
  return {
    passcodes: [...passcodes].sort(),
    identityRequests,
  };
}

function normalizeIdentityRecord(card = {}) {
  const names = identityNames(card);
  return {
    cid: stableCardCid(card),
    passcode: explicitPasscode(card),
    names,
    normalizedNames: new Set(names.map(normalizeExactIdentityName)),
  };
}

function identityNames(card = {}) {
  if (card?.aliases !== undefined && !Array.isArray(card.aliases)) {
    throw identityInputError("card identity aliases must be an array");
  }
  const rawNames = [
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...(Array.isArray(card?.aliases) ? card.aliases : []),
    card?.raw?.name,
    card?.raw?.cnName,
    card?.raw?.jaName,
    card?.raw?.jpName,
    card?.raw?.enName,
  ];
  if (rawNames.some((name) => name !== undefined && name !== null &&
      typeof name !== "string")) {
    throw identityInputError("card identity names must be strings");
  }
  const present = rawNames
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim());
  if (present.length > 16) {
    throw identityInputError(
      "each card identity request may contain at most 16 names",
    );
  }
  const names = [];
  const normalized = new Set();
  for (const name of present) {
    if (name.length > 256) {
      throw identityInputError(
        "card identity names may contain at most 256 characters",
      );
    }
    const key = normalizeExactIdentityName(name);
    if (!normalized.has(key)) {
      normalized.add(key);
      names.push(name);
    }
  }
  return names;
}

function stableCardCid(card = {}) {
  const sourceUrlCid = String(card.sourceUrl || card.ygoResourcesUrl || "")
    .match(/\/data\/card\/(\d{1,7})(?:$|[/?#])/u)?.[1];
  const candidates = new Set([
    card?.cid,
    sourceUrlCid,
    card?.id,
    card?.cardId,
    card?.raw?.cid,
    card?.raw?.raw?.cid,
  ].map(normalizeStableCid).filter(Boolean));
  if (candidates.size > 1) {
    throw identityConflictError(
      "one card record contains conflicting stable CIDs",
    );
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function normalizeStableCid(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) return "";
  const normalized = String(Number(text));
  return /^[1-9]\d{2,6}$/u.test(normalized) ? normalized : "";
}

function mergeIdentityNames(target, names) {
  for (const name of names) {
    const normalized = normalizeExactIdentityName(name);
    if (!target.normalizedNames.has(normalized)) {
      target.normalizedNames.add(normalized);
      target.names.push(name);
    }
  }
  if (target.names.length > 16) {
    throw identityInputError(
      "merged card identity request exceeds the 16-name safety limit",
    );
  }
}

function addIdentityRelation(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function rejectAmbiguousRelations(map, message) {
  if ([...map.values()].some((values) => values.size > 1)) {
    throw identityConflictError(message);
  }
}

function relationValuesForAliases(map, aliases) {
  const values = new Set();
  for (const alias of aliases) {
    for (const value of map.get(alias) || []) values.add(value);
  }
  return values;
}

function explicitPasscode(card) {
  const passcodes = new Set();
  for (const value of [
    card?.passcode,
    card?.password,
    card?.raw?.passcode,
    card?.raw?.password,
    card?.raw?.raw?.passcode,
    card?.raw?.raw?.password,
  ]) {
    const passcode = normalizeLegacyLuaPasscode(value);
    if (passcode !== null && !isShortCidAlias(card, passcode)) {
      passcodes.add(passcode);
    }
  }
  if (passcodes.size > 1) {
    throw identityConflictError(
      "one card record contains conflicting explicit passcodes",
    );
  }
  return passcodes.size === 1 ? [...passcodes][0] : null;
}

function isShortCidAlias(card, passcode) {
  const cid = stableCardCid(card);
  return cid !== null && BigInt(cid) === BigInt(passcode);
}

function normalizeExactIdentityName(value) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
}

function identityInputError(message) {
  const error = new TypeError(message);
  error.code = "LEGACY_LUA_CARD_IDENTITY_INVALID";
  return error;
}

function identityConflictError(message) {
  const error = new TypeError(message);
  error.code = "LEGACY_LUA_CARD_IDENTITY_CONFLICT";
  return error;
}

function boundedEnvInteger(value, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function isRetryable(error) {
  return /(?:TIMEOUT|UNAVAILABLE|ABORTED|NOT_CONFIGURED)$/u.test(
    String(error?.code || ""),
  );
}

function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { unavailable: true };
  }
}
