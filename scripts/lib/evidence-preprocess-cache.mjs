import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const NAV_PREFIX = "evidence-preprocess:nav:";
const DENSE_PREFIX = "evidence-preprocess:dense:";
const REDIS_LEDGER_VERSION = 1;

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function navigationCacheKey({ contract, promptContractSha256, contextInputSha256 }) {
  const fields = [
    contract?.providerId,
    contract?.modelId,
    contract?.apiContractVersion,
    contract?.generationContractSha256,
    promptContractSha256,
    contextInputSha256,
  ].map((value) => String(value || ""));
  if (fields.some((value) => !value)) throw new Error("navigation_cache_key_binding_incomplete");
  return sha256(fields.join("\u0000"));
}

export function denseCacheKey({ embeddingModel, dimension, embeddingInputContractHash, embeddingInputTextHash }) {
  const fields = [embeddingModel, dimension, embeddingInputContractHash, embeddingInputTextHash].map((value) => String(value || ""));
  if (fields.some((value) => !value)) throw new Error("dense_cache_key_binding_incomplete");
  return sha256(fields.join("\u0000"));
}

export function createLocalEvidencePreprocessCache({ cacheDir, ownerId = randomUUID() }) {
  if (!cacheDir) throw new Error("evidence_preprocess_cache_dir_required");
  const navDir = join(cacheDir, "nav");
  const denseDir = join(cacheDir, "dense");
  const claimDir = join(cacheDir, "claims");

  const resultPath = (kind, key, variant = "result") => join(
    kind === "nav" ? navDir : denseDir,
    `${key}.${safeName(variant)}.json`,
  );
  const claimPath = (kind, key) => join(claimDir, `${safeName(kind)}-${key}.json`);
  const readResult = async (kind, key, variant = "result") => readJson(resultPath(kind, key, variant));
  const claim = async (kind, key, ticket) => {
    await mkdir(claimDir, { recursive: true });
    const path = claimPath(kind, key);
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${JSON.stringify({ kind, key, ownerId, ticket, claimedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      await handle.close();
      return { status: "claimed", ownerId, ticket };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return { status: "busy", claim: await readJson(path) };
    }
  };
  const releaseClaim = async (kind, key, ticket) => {
    const path = claimPath(kind, key);
    const claimed = await readJson(path);
    if (claimed?.ownerId !== ownerId || claimed?.ticket !== ticket) throw new Error("evidence_preprocess_claim_owner_mismatch");
    await rm(path, { force: true });
  };
  const writeRaw = async (kind, key, { ticket, value }) => {
    const path = claimPath(kind, key);
    const claimed = ticket ? await readJson(path) : null;
    if (ticket && (claimed?.ownerId !== ownerId || claimed?.ticket !== ticket)) {
      throw new Error("evidence_preprocess_claim_owner_mismatch");
    }
    const result = await writeImmutableJson(resultPath(kind, key, "raw"), assertCacheRow(value, key));
    if (ticket) {
      await rm(path, { force: true });
    }
    return result;
  };
  const writeResult = (kind, key, { variant = "result", value }) => writeImmutableJson(resultPath(kind, key, variant), assertCacheRow(value, key));

  return Object.freeze({
    kind: "local-evidence-preprocess-cache",
    ownerId,
    navKey: (key) => `${NAV_PREFIX}${key}`,
    denseKey: (key) => `${DENSE_PREFIX}${key}`,
    readResult,
    readResultBatch: (kind, keys, variant = "result") => Promise.all(keys.map(key => readResult(kind, key, variant))),
    claim,
    releaseClaim,
    writeRaw,
    writeResult,
    async readNavigation(key, normalizerVersion) {
      const raw = await readResult("nav", key, "raw-attempt-1")
        || await readResult("nav", key, "raw-attempt-0")
        || await readResult("nav", key, "raw");
      const providerRaw = await readResult("nav", key, "provider-raw-attempt-1")
        || await readResult("nav", key, "provider-raw-attempt-0");
      const normalized = normalizerVersion
        ? await readResult("nav", key, `normalized-${safeName(normalizerVersion)}`)
        : null;
      return { raw, providerRaw, normalized };
    },
    async readNavigationBatch(keys, normalizerVersion) {
      return Promise.all(keys.map(async (key) => {
        const raw = await readResult("nav", key, "raw-attempt-1")
          || await readResult("nav", key, "raw-attempt-0")
          || await readResult("nav", key, "raw");
        const providerRaw = await readResult("nav", key, "provider-raw-attempt-1")
          || await readResult("nav", key, "provider-raw-attempt-0");
        const normalized = normalizerVersion
          ? await readResult("nav", key, `normalized-${safeName(normalizerVersion)}`)
          : null;
        return { raw, providerRaw, normalized };
      }));
    },
    async claimNavigation(key, ticket) {
      return claim("nav", key, ticket);
    },
    async releaseNavigationClaim(key, ticket) {
      return releaseClaim("nav", key, ticket);
    },
    async saveNavigationRaw(key, row) {
      return writeResult("nav", key, { variant: `raw-attempt-${Number(row?.attempt || 0)}`, value: row });
    },
    async saveNavigationProviderRaw(key, row) {
      return writeResult("nav", key, { variant: `provider-raw-attempt-${Number(row?.attempt || 0)}`, value: row });
    },
    async saveNavigationNormalized(key, normalizerVersion, row) {
      return writeResult("nav", key, { variant: `normalized-${safeName(normalizerVersion)}`, value: row });
    },
    async saveDense(key, row) {
      return writeResult("dense", key, { value: row });
    },
    claimDense: (key, ticket) => claim("dense", key, ticket),
    releaseDenseClaim: (key, ticket) => releaseClaim("dense", key, ticket),
  });
}

const CLAIM_SCRIPT = `
local complete = redis.call('GET', KEYS[1])
if complete then return {'COMPLETE', complete} end
local raw = redis.call('GET', KEYS[2])
if raw then return {'RAW', raw} end
local claimed = redis.call('SET', KEYS[3], ARGV[1], 'NX')
if claimed then return {'CLAIMED', ARGV[1]} end
return {'BUSY', redis.call('GET', KEYS[3]) or ''}
`;

const SAVE_SCRIPT = `
local claim = redis.call('GET', KEYS[2])
if claim ~= ARGV[1] then return {'OWNER_MISMATCH'} end
local existing = redis.call('GET', KEYS[1])
if existing and existing ~= ARGV[2] then return {'CONFLICT'} end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('DEL', KEYS[2])
return {'SAVED'}
`;

const SAVE_DERIVED_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if not raw then return {'RAW_MISSING'} end
local existing = redis.call('GET', KEYS[1])
if existing and existing ~= ARGV[1] then return {'CONFLICT'} end
redis.call('SET', KEYS[1], ARGV[1])
return {'SAVED'}
`;

const RELEASE_SCRIPT = `
local claim = redis.call('GET', KEYS[1])
if claim ~= ARGV[1] then return {'OWNER_MISMATCH'} end
redis.call('DEL', KEYS[1])
return {'RELEASED'}
`;

const ADOPT_CLAIM_SCRIPT = `
local claim = redis.call('GET', KEYS[1])
if claim ~= ARGV[1] then return {'BUSY', claim or ''} end
redis.call('SET', KEYS[1], ARGV[2])
return {'ADOPTED', ARGV[2]}
`;

const NAVIGATION_CLAIM_SCRIPT = `
local normalized = redis.call('GET', KEYS[1])
if normalized then return {'COMPLETE', normalized} end
local raw = redis.call('GET', KEYS[2]) or redis.call('GET', KEYS[3]) or redis.call('GET', KEYS[4])
if raw then return {'RAW', raw} end
local provider = redis.call('GET', KEYS[5]) or redis.call('GET', KEYS[6])
if provider then return {'PROVIDER_RAW', provider} end
local claimed = redis.call('SET', KEYS[7], ARGV[1], 'NX')
if claimed then return {'CLAIMED', ARGV[1]} end
return {'BUSY', redis.call('GET', KEYS[7]) or ''}
`;

/** Redis persistence adapter. The caller supplies the already-authorized
 * Redis command function; this module never reads credentials or opens Redis.
 */
export function createRedisEvidencePreprocessCache({
  command,
  ownerId = randomUUID(),
  namespace = "v1",
  navigationNormalizerVersion = "navigation-output-v1",
}) {
  if (typeof command !== "function") throw new Error("evidence_preprocess_redis_command_required");
  const key = (kind, inputKey, suffix = "result") => `evidence-preprocess:${kind}:{${inputKey}}:${namespace}:${suffix}`;
  const navigationResultKeys = (inputKey, normalizerVersion) => [
    key("nav", inputKey, "raw-attempt-1"),
    key("nav", inputKey, "raw-attempt-0"),
    key("nav", inputKey, "raw"),
    key("nav", inputKey, "provider-raw-attempt-1"),
    key("nav", inputKey, "provider-raw-attempt-0"),
    key("nav", inputKey, `normalized-${safeName(normalizerVersion)}`),
  ];
  const decodeNavigationValues = (values) => ({
    raw: parseMaybeJson(values[0]) || parseMaybeJson(values[1]) || parseMaybeJson(values[2]),
    providerRaw: parseMaybeJson(values[3]) || parseMaybeJson(values[4]),
    normalized: parseMaybeJson(values[5]),
  });
  const assertNavigationValues = (values, expectedLength) => {
    if (!Array.isArray(values) || values.length !== expectedLength) {
      throw new Error("evidence_preprocess_redis_invalid_response");
    }
    return values;
  };
  const operate = async (kind, inputKey, ticket, value, suffix = "result") => {
    const resultKey = key(kind, inputKey, suffix);
    const claimKey = key(kind, inputKey, "claim");
    if (value === undefined) {
      const rawKey = key(kind, inputKey, "raw");
      const result = await command(["EVAL", CLAIM_SCRIPT, "3", resultKey, rawKey, claimKey, JSON.stringify({ ownerId, ticket })]);
      return decodeRedisResult(result, inputKey);
    }
    const result = await command(["EVAL", SAVE_SCRIPT, "2", resultKey, claimKey, JSON.stringify({ ownerId, ticket }), stableJson(value)]);
    const status = String(result?.[0] || result || "").toLowerCase();
    if (status === "saved") return { status };
    throw new Error(`evidence_preprocess_redis_${status || "invalid_response"}`);
  };
  const saveDerived = async (kind, inputKey, value) => {
    const result = await command(["EVAL", SAVE_DERIVED_SCRIPT, "2", key(kind, inputKey), key(kind, inputKey, "raw"), stableJson(value)]);
    const status = String(result?.[0] || result || "").toLowerCase();
    if (status === "saved") return { status };
    throw new Error(`evidence_preprocess_redis_${status || "invalid_response"}`);
  };
  const writeImmutable = async (kind, inputKey, variant, value) => {
    const result = await command([
      "EVAL",
      WRITE_IMMUTABLE_SCRIPT,
      "1",
      key(kind, inputKey, variant),
      stableJson(assertCacheRow(value, inputKey)),
    ]);
    const status = String(result?.[0] || result || "").toLowerCase();
    if (status === "written" || status === "existing") return { status };
    throw new Error(`evidence_preprocess_redis_${status || "invalid_response"}`);
  };
  const releaseClaim = async (kind, inputKey, ticket) => {
    const result = await command(["EVAL", RELEASE_SCRIPT, "1", key(kind, inputKey, "claim"), JSON.stringify({ ownerId, ticket })]);
    const status = String(result?.[0] || result || "").toLowerCase();
    if (status === "released") return { status };
    throw new Error(`evidence_preprocess_redis_${status || "invalid_response"}`);
  };
  const adoptClaim = async (kind, inputKey, ticket, expectedClaim) => {
    if (!expectedClaim || expectedClaim.ticket !== ticket) throw new Error("evidence_preprocess_claim_adoption_invalid");
    const nextClaim = { ownerId, ticket };
    const result = await command([
      "EVAL", ADOPT_CLAIM_SCRIPT, "1", key(kind, inputKey, "claim"),
      stableJson(expectedClaim), stableJson(nextClaim),
    ]);
    const status = String(result?.[0] || result || "").toLowerCase();
    if (status === "adopted") return { status, inputKey };
    if (status === "busy") return { status, inputKey, claim: parseMaybeJson(result?.[1]) };
    throw new Error("evidence_preprocess_redis_invalid_response");
  };
  return Object.freeze({
    kind: "redis-evidence-preprocess-cache",
    ownerId,
    navKey: (inputKey) => `${NAV_PREFIX}${inputKey}`,
    denseKey: (inputKey) => `${DENSE_PREFIX}${inputKey}`,
    readResult: async (kind, inputKey, variant = "result") => parseMaybeJson(await command(["GET", key(kind, inputKey, variant)])),
    async readResultBatch(kind, inputKeys, variant = "result") {
      if (!inputKeys.length) return [];
      const values = await command(["MGET", ...inputKeys.map(inputKey => key(kind, inputKey, variant))]);
      if (!Array.isArray(values) || values.length !== inputKeys.length) throw new Error("evidence_preprocess_redis_invalid_response");
      return values.map(parseMaybeJson);
    },
    claim: (kind, inputKey, ticket) => operate(kind, inputKey, ticket),
    adoptClaim,
    releaseClaim,
    writeRaw: (kind, inputKey, { ticket, value }) => operate(kind, inputKey, ticket, value, "raw"),
    writeResult: (kind, inputKey, { variant = "result", value }) => (
      variant === "result" ? saveDerived(kind, inputKey, value) : writeImmutable(kind, inputKey, variant, value)
    ),
    async readNavigation(inputKey, normalizerVersion) {
      const values = assertNavigationValues(
        await command(["MGET", ...navigationResultKeys(inputKey, normalizerVersion)]), 6,
      );
      return decodeNavigationValues(values);
    },
    async readNavigationBatch(inputKeys, normalizerVersion) {
      if (!inputKeys.length) return [];
      const keys = inputKeys.flatMap((inputKey) => navigationResultKeys(inputKey, normalizerVersion));
      const values = assertNavigationValues(await command(["MGET", ...keys]), keys.length);
      return inputKeys.map((_, index) => decodeNavigationValues(values.slice(index * 6, index * 6 + 6)));
    },
    claimNavigation: async (inputKey, ticket) => decodeRedisResult(await command([
      "EVAL", NAVIGATION_CLAIM_SCRIPT, "7",
      key("nav", inputKey, `normalized-${safeName(navigationNormalizerVersion)}`),
      key("nav", inputKey, "raw-attempt-1"),
      key("nav", inputKey, "raw-attempt-0"),
      key("nav", inputKey, "raw"),
      key("nav", inputKey, "provider-raw-attempt-1"),
      key("nav", inputKey, "provider-raw-attempt-0"),
      key("nav", inputKey, "claim"),
      JSON.stringify({ ownerId, ticket }),
    ]), inputKey),
    releaseNavigationClaim: (inputKey, ticket) => releaseClaim("nav", inputKey, ticket),
    saveNavigationRaw: (inputKey, row) => writeImmutable("nav", inputKey, `raw-attempt-${Number(row?.attempt || 0)}`, row),
    saveNavigationProviderRaw: (inputKey, row) => writeImmutable("nav", inputKey, `provider-raw-attempt-${Number(row?.attempt || 0)}`, row),
    saveNavigationNormalized: (inputKey, normalizerVersion, row) => writeImmutable(
      "nav", inputKey, `normalized-${safeName(normalizerVersion)}`, row,
    ),
    claimDense: (inputKey, ticket) => operate("dense", inputKey, ticket),
    releaseDenseClaim: (inputKey, ticket) => releaseClaim("dense", inputKey, ticket),
    saveDense: (inputKey, row) => saveDerived("dense", inputKey, row),
  });
}

const WRITE_IMMUTABLE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  if existing == ARGV[1] then return {'EXISTING'} end
  return {'CONFLICT'}
end
redis.call('SET', KEYS[1], ARGV[1])
return {'WRITTEN'}
`;

const LEDGER_INITIALIZE_SCRIPT = `
-- EVIDENCE_PREPROCESS_LEDGER_INITIALIZE
local existing = redis.call('GET', KEYS[1])
if existing then return {'EXISTING', existing} end
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then return {'INITIALIZED', ARGV[1]} end
return {'EXISTING', redis.call('GET', KEYS[1]) or ''}
`;

const LEDGER_RESERVE_SCRIPT = `
-- EVIDENCE_PREPROCESS_LEDGER_RESERVE
local raw = redis.call('GET', KEYS[1])
if not raw then return {'MISSING'} end
local ledger = cjson.decode(raw)
if ledger.cloudPreprocessAuthorizationId ~= ARGV[1]
    or tonumber(ledger.cloudPreprocessLedgerVersion) ~= ${REDIS_LEDGER_VERSION} then
  return {'AUTHORIZATION_MISMATCH'}
end
ledger.tickets = ledger.tickets or {}
local old = ledger.tickets[ARGV[2]]
if old then return {'EXISTING', cjson.encode(old)} end
local amount = tonumber(ARGV[3])
local maxUsd = tonumber(ARGV[4])
local stageSpent = tonumber(ledger.stageSpentUsd or 0)
local stageReserved = tonumber(ledger.stageReservedUsd or 0)
local remainingStage = maxUsd - stageSpent - stageReserved
local remainingLedger = tonumber(ledger.limitUsd) - tonumber(ledger.spentUsd) - tonumber(ledger.reservedUsd)
if amount > remainingStage or amount > remainingLedger then return {'BLOCKED'} end
local ticket = {state='reserved', reservedUsd=amount}
ledger.reservedUsd = tonumber(ledger.reservedUsd) + amount
ledger.stageReservedUsd = stageReserved + amount
ledger.tickets[ARGV[2]] = ticket
redis.call('SET', KEYS[1], cjson.encode(ledger))
return {'RESERVED', cjson.encode(ticket)}
`;

const LEDGER_SETTLE_SCRIPT = `
-- EVIDENCE_PREPROCESS_LEDGER_SETTLE
local raw = redis.call('GET', KEYS[1])
if not raw then return {'MISSING'} end
local ledger = cjson.decode(raw)
if ledger.cloudPreprocessAuthorizationId ~= ARGV[1]
    or tonumber(ledger.cloudPreprocessLedgerVersion) ~= ${REDIS_LEDGER_VERSION} then
  return {'AUTHORIZATION_MISMATCH'}
end
local row = ledger.tickets and ledger.tickets[ARGV[2]] or nil
if not row then return {'TICKET_MISSING'} end
local spent = tonumber(ARGV[3])
if row.state == 'settled' then
  if tonumber(row.spentUsd) == spent then return {'SETTLED', cjson.encode(row)} end
  return {'CONFLICT'}
end
if row.state ~= 'reserved' or spent > tonumber(row.reservedUsd) then return {'CONFLICT'} end
ledger.reservedUsd = tonumber(ledger.reservedUsd) - tonumber(row.reservedUsd)
ledger.stageReservedUsd = tonumber(ledger.stageReservedUsd or 0) - tonumber(row.reservedUsd)
ledger.spentUsd = tonumber(ledger.spentUsd) + spent
ledger.stageSpentUsd = tonumber(ledger.stageSpentUsd or 0) + spent
row.state = 'settled'
row.spentUsd = spent
ledger.tickets[ARGV[2]] = row
redis.call('SET', KEYS[1], cjson.encode(ledger))
return {'SETTLED', cjson.encode(row)}
`;

export function createLocalEvidencePreprocessBudget({ ledgerPath, maxUsd }) {
  if (!ledgerPath || !(maxUsd > 0)) throw new Error("evidence_preprocess_budget_configuration_incomplete");
  return Object.freeze({
    kind: "local-evidence-preprocess-budget",
    reserve: ({ ticket, amountUsd }) => reserveLocalPreprocessBudget({ ledgerPath, ticket, amountUsd, maxUsd }),
    settle: ({ ticket, spentUsd }) => settleLocalPreprocessBudget({ ledgerPath, ticket, spentUsd }),
  });
}

export async function initializeRedisEvidencePreprocessLedger({ command, ledgerKey, authorizationId, ledger }) {
  assertRedisLedgerConfig({ command, ledgerKey, authorizationId });
  const bootstrap = structuredClone(validateLedger(ledger));
  bootstrap.cloudPreprocessLedgerVersion = REDIS_LEDGER_VERSION;
  bootstrap.cloudPreprocessAuthorizationId = authorizationId;
  const result = await command(["EVAL", LEDGER_INITIALIZE_SCRIPT, "1", ledgerKey, stableJson(bootstrap)]);
  const status = String(result?.[0] || "").toLowerCase();
  if (status !== "initialized" && status !== "existing") throw new Error("evidence_preprocess_redis_ledger_initialize_failed");
  const current = parseMaybeJson(result?.[1]);
  validateRedisLedger(current, authorizationId);
  return { status, ledger: current };
}

export async function readRedisEvidencePreprocessLedger({ command, ledgerKey, authorizationId }) {
  assertRedisLedgerConfig({ command, ledgerKey, authorizationId });
  const current = parseMaybeJson(await command(["GET", ledgerKey]));
  if (!current) throw new Error("evidence_preprocess_redis_ledger_missing");
  validateRedisLedger(current, authorizationId);
  return current;
}

export function createRedisEvidencePreprocessBudget({ command, ledgerKey, authorizationId, maxUsd }) {
  assertRedisLedgerConfig({ command, ledgerKey, authorizationId });
  if (!(maxUsd > 0)) throw new Error("evidence_preprocess_budget_configuration_incomplete");
  return Object.freeze({
    kind: "redis-evidence-preprocess-budget",
    async reserve({ ticket, amountUsd }) {
      if (!ticket || !Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("evidence_preprocess_reservation_invalid");
      const result = await command([
        "EVAL", LEDGER_RESERVE_SCRIPT, "1", ledgerKey,
        authorizationId, ticket, String(amountUsd), String(maxUsd),
      ]);
      const status = String(result?.[0] || "").toLowerCase();
      if (status === "reserved" || status === "existing") return parseMaybeJson(result?.[1]);
      if (status === "blocked") {
        const error = new Error("evidence_preprocess_budget_exceeded");
        error.code = "evidence_preprocess_budget_exceeded";
        throw error;
      }
      throw new Error(`evidence_preprocess_redis_ledger_${status || "invalid_response"}`);
    },
    async settle({ ticket, spentUsd }) {
      if (!ticket || !Number.isFinite(spentUsd) || spentUsd < 0) throw new Error("evidence_preprocess_settlement_invalid");
      const result = await command([
        "EVAL", LEDGER_SETTLE_SCRIPT, "1", ledgerKey,
        authorizationId, ticket, String(spentUsd),
      ]);
      const status = String(result?.[0] || "").toLowerCase();
      if (status === "settled") return parseMaybeJson(result?.[1]);
      throw new Error(`evidence_preprocess_redis_ledger_${status || "invalid_response"}`);
    },
  });
}

export async function withAtomicLedger(ledgerPath, mutate) {
  if (!ledgerPath) throw new Error("evidence_preprocess_ledger_required");
  const lockPath = `${ledgerPath}.lock`;
  await mkdir(dirname(ledgerPath), { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 25 && !handle; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 24) throw new Error("evidence_preprocess_ledger_locked");
      await delay(10);
    }
  }
  try {
    const current = JSON.parse(await readFile(ledgerPath, "utf8"));
    validateLedger(current);
    const next = await mutate(structuredClone(current));
    validateLedger(next);
    await writeJsonAtomic(ledgerPath, next);
    return next;
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true });
  }
}

export async function reserveLocalPreprocessBudget({ ledgerPath, ticket, amountUsd, maxUsd }) {
  if (!ticket || !Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new Error("evidence_preprocess_reservation_invalid");
  }
  let reservation;
  await withAtomicLedger(ledgerPath, (ledger) => {
    if (ledger.tickets?.[ticket]) {
      reservation = ledger.tickets[ticket];
      return ledger;
    }
    const remainingStage = maxUsd - Number(ledger.stageSpentUsd || 0) - Number(ledger.stageReservedUsd || 0);
    const remainingLedger = Number(ledger.limitUsd) - Number(ledger.spentUsd) - Number(ledger.reservedUsd);
    if (amountUsd > remainingStage || amountUsd > remainingLedger) {
      const error = new Error("evidence_preprocess_budget_exceeded");
      error.code = "evidence_preprocess_budget_exceeded";
      throw error;
    }
    ledger.reservedUsd += amountUsd;
    ledger.stageReservedUsd = Number(ledger.stageReservedUsd || 0) + amountUsd;
    ledger.tickets = ledger.tickets || {};
    ledger.tickets[ticket] = { state: "reserved", reservedUsd: amountUsd };
    reservation = ledger.tickets[ticket];
    return ledger;
  });
  return reservation;
}

export async function settleLocalPreprocessBudget({ ledgerPath, ticket, spentUsd }) {
  if (!ticket || !Number.isFinite(spentUsd) || spentUsd < 0) throw new Error("evidence_preprocess_settlement_invalid");
  let settled;
  await withAtomicLedger(ledgerPath, (ledger) => {
    const row = ledger.tickets?.[ticket];
    if (!row) throw new Error("evidence_preprocess_ticket_missing");
    if (row.state === "settled") {
      if (row.spentUsd !== spentUsd) throw new Error("evidence_preprocess_ticket_conflict");
      settled = row;
      return ledger;
    }
    if (row.state !== "reserved" || spentUsd > row.reservedUsd) throw new Error("evidence_preprocess_ticket_conflict");
    ledger.reservedUsd = Number((ledger.reservedUsd - row.reservedUsd).toFixed(12));
    ledger.stageReservedUsd = Number((Number(ledger.stageReservedUsd || 0) - row.reservedUsd).toFixed(12));
    ledger.spentUsd += spentUsd;
    ledger.stageSpentUsd = Number(ledger.stageSpentUsd || 0) + spentUsd;
    row.state = "settled";
    row.spentUsd = spentUsd;
    settled = row;
    return ledger;
  });
  return settled;
}

function validateLedger(ledger) {
  const recognizedEnvelope = ledger?.schemaVersion === 1
    ? typeof ledger.authorizationId === "string" && Boolean(ledger.authorizationId)
    : typeof ledger?.startedAt === "string" && Boolean(ledger.startedAt)
      && typeof ledger.decision === "string" && Boolean(ledger.decision) && Array.isArray(ledger.rows);
  if (!recognizedEnvelope || !Number.isFinite(ledger.limitUsd) || ledger.limitUsd <= 0
      || !Number.isFinite(ledger.spentUsd) || ledger.spentUsd < 0
      || !Number.isFinite(ledger.reservedUsd) || ledger.reservedUsd < 0
      || (ledger.tickets !== undefined && (!ledger.tickets || typeof ledger.tickets !== "object" || Array.isArray(ledger.tickets)))
      || (ledger.stageSpentUsd !== undefined && (!Number.isFinite(ledger.stageSpentUsd) || ledger.stageSpentUsd < 0))
      || (ledger.stageReservedUsd !== undefined && (!Number.isFinite(ledger.stageReservedUsd) || ledger.stageReservedUsd < 0))
      || ledger.spentUsd + ledger.reservedUsd > ledger.limitUsd + 1e-9) {
    throw new Error("evidence_preprocess_ledger_invalid");
  }
  return ledger;
}

function assertRedisLedgerConfig({ command, ledgerKey, authorizationId }) {
  if (typeof command !== "function") throw new Error("evidence_preprocess_redis_command_required");
  if (!/^[a-zA-Z0-9:{}._-]{1,200}$/u.test(String(ledgerKey || ""))) {
    throw new Error("evidence_preprocess_redis_ledger_key_invalid");
  }
  if (!/^[a-zA-Z0-9._-]{1,160}$/u.test(String(authorizationId || ""))) {
    throw new Error("evidence_preprocess_redis_authorization_id_invalid");
  }
}

function validateRedisLedger(ledger, authorizationId) {
  validateLedger(ledger);
  if (ledger.cloudPreprocessLedgerVersion !== REDIS_LEDGER_VERSION
      || ledger.cloudPreprocessAuthorizationId !== authorizationId) {
    throw new Error("evidence_preprocess_redis_ledger_authorization_mismatch");
  }
  return ledger;
}

function assertCacheRow(row, key) {
  if (!row || row.key !== key || typeof row.kind !== "string" || !row.kind) throw new Error("evidence_preprocess_cache_row_binding_error");
  return row;
}

async function writeImmutableJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(serialized, "utf8");
    await handle.close();
    return { status: "written", path };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (stableJson(JSON.parse(existing)) !== stableJson(value)) throw new Error("evidence_preprocess_cache_row_conflict");
    return { status: "existing", path };
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function safeName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function decodeRedisResult(result, inputKey) {
  const status = String(result?.[0] || result || "").toLowerCase();
  if (status === "claimed") return { status, inputKey };
  if (status === "busy") return { status, inputKey, claim: parseMaybeJson(result?.[1]) };
  if (status === "complete") return { status, inputKey, value: parseMaybeJson(result?.[1]) };
  if (status === "raw") return { status: "raw_reusable", inputKey, value: parseMaybeJson(result?.[1]) };
  if (status === "provider_raw") return { status: "provider_raw_reusable", inputKey, value: parseMaybeJson(result?.[1]) };
  throw new Error("evidence_preprocess_redis_invalid_response");
}

function parseMaybeJson(value) {
  try { return JSON.parse(String(value || "")); } catch { return value ?? null; }
}
