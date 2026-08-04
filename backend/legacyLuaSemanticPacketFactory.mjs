import {
  collectLegacyLuaSemanticPacket,
} from "./legacyLuaSemanticClient.mjs";
import {
  createLegacyLuaUnknownPacket,
  serializeLegacyLuaSemanticPacket,
  validateLegacyLuaSemanticPacket,
} from "./legacyLuaSemanticPacket.mjs";
import {
  createLegacyLuaSemanticHttpFacade,
} from "./legacyLuaSemanticHttpFacade.mjs";

const PASSCODE = /^\d{8}$/u;
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
 * than the 8-digit card password used by c{passcode}.lua.
 */
export function collectEffectiveLegacyLuaPasscodes(input = {}) {
  const cards = [
    ...(Array.isArray(input?.retrievedCards) ? input.retrievedCards : []),
    ...(Array.isArray(input?.evidence?.retrievedCards)
      ? input.evidence.retrievedCards
      : []),
    ...(Array.isArray(input?.cardResolution?.resolvedCards)
      ? input.cardResolution.resolvedCards
      : []),
  ];
  const passcodes = new Set();
  for (const card of cards) {
    for (const value of [
      card?.passcode,
      card?.password,
      card?.raw?.passcode,
      card?.raw?.password,
      card?.raw?.raw?.passcode,
      card?.raw?.raw?.password,
    ]) {
      const text = String(value ?? "").trim();
      if (PASSCODE.test(text) && Number(text) > 0) {
        passcodes.add(text);
        break;
      }
    }
  }
  return [...passcodes].sort();
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
  const passcodes = collectEffectiveLegacyLuaPasscodes(input);
  if (passcodes.length === 0) {
    return createLegacyLuaUnknownPacket({
      code: "LEGACY_LUA_PASSCODE_UNAVAILABLE",
      message: "no verified 8-digit card passcode is available for legacy Lua lookup",
      details: { retryable: false },
    });
  }
  if (passcodes.length > maxCards) {
    return createLegacyLuaUnknownPacket({
      code: "LEGACY_LUA_CARD_LIMIT_EXCEEDED",
      message: `legacy Lua lookup exceeds the ${maxCards}-card safety limit`,
      details: { cardCount: passcodes.length, maxCards, retryable: false },
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
    const sourceResults = await Promise.allSettled(passcodes.map((passcode) =>
      engine.resolveLegacyLuaSource(passcode)
    ));
    const inputs = sourceResults.map((result, index) => {
      if (result.status === "fulfilled") {
        return { sourceDocument: result.value };
      }
      const error = result.reason;
      return {
        unresolvedSource: {
          passcode: passcodes[index],
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
