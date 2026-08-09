import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  canonicalLegacyLuaSha256,
  normalizeLegacyLuaPasscode,
  validateLegacyLuaSemanticResource,
} from "../../backend/legacyLuaSemanticPacket.mjs";
import {
  comparePrecomputedLegacyLuaStableText,
  normalizePrecomputedLegacyLuaAlias,
  normalizePrecomputedLegacyLuaCid,
} from "../../backend/legacyLuaSemanticStaticCacheFactory.mjs";
import {
  precomputedLegacyLuaShardId,
  PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
} from "../../backend/legacyLuaSemanticStaticCacheV2.mjs";

export const PRECOMPUTED_LEGACY_LUA_IDENTITY_BATCH_SIZE = 32;
export const PRECOMPUTED_LEGACY_LUA_BUILD_PLAN_SCHEMA =
  "ocg-assistant-precomputed-legacy-lua-build-plan/v2";

const CALLBACK_SETTERS = Object.freeze([
  "SetCondition",
  "SetCost",
  "SetTarget",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SKIP_NEGATIVE_SKILL_RECORD = Symbol("SKIP_NEGATIVE_SKILL_RECORD");

/**
 * Derives a conservative lexical prefilter from the versioned registry. It is
 * allowed to keep false positives, but every emitted activation-legality API
 * name remains eligible so the prefilter cannot silently narrow to one card or
 * one previously observed operation.
 */
export function createRegistryDrivenLegacyLuaPrefilter(registry) {
  if (!registry || typeof registry !== "object" ||
      !Array.isArray(registry.luaApis)) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_REGISTRY_INVALID",
      "legacy Lua API registry must expose luaApis",
    );
  }
  const apiNames = [...new Set(registry.luaApis
    .filter((entry) => String(entry?.support || "").includes(
      "ACTIVATION_LEGALITY",
    ))
    .map((entry) => String(entry?.api || "").split(".").at(-1))
    .filter(Boolean))].sort();
  if (apiNames.length === 0) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_REGISTRY_INVALID",
      "legacy Lua API registry declares no activation-legality APIs",
    );
  }
  const descriptor = Object.freeze({
    policy: PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
    registrySha256: canonicalLegacyLuaSha256(registry),
    callbackSetters: [...CALLBACK_SETTERS],
    activationLegalityApiNames: apiNames,
  });
  return Object.freeze({
    descriptor,
    matches(source) {
      if (typeof source !== "string") return false;
      return CALLBACK_SETTERS.some((name) => source.includes(name)) &&
        apiNames.some((name) => source.includes(name));
    },
  });
}

export async function resolveLegacyLuaCardIdentityBatches({
  cards,
  resolveBatch,
  batchSize = PRECOMPUTED_LEGACY_LUA_IDENTITY_BATCH_SIZE,
} = {}) {
  if (!Array.isArray(cards) || typeof resolveBatch !== "function" ||
      batchSize !== PRECOMPUTED_LEGACY_LUA_IDENTITY_BATCH_SIZE) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_IDENTITY_INVALID",
      `identity resolution requires cards, a resolver, and fixed ${PRECOMPUTED_LEGACY_LUA_IDENTITY_BATCH_SIZE}-card batches`,
    );
  }
  // The synchronized corpus also contains Duel Links skills whose synthetic
  // CIDs are negative. That one explicit non-OCG shape cannot bind to c*.lua
  // and is skipped. Every other malformed corpus record fails closed.
  const normalizedCards = [];
  for (const card of cards) {
    const normalized = normalizeCardRecord(card);
    if (normalized !== SKIP_NEGATIVE_SKILL_RECORD) {
      normalizedCards.push(normalized);
    }
  }
  normalizedCards.sort((left, right) =>
    comparePrecomputedLegacyLuaStableText(left.cid, right.cid)
  );
  rejectDuplicates(normalizedCards.map((card) => card.cid),
    "card corpus contains duplicate stable CIDs");
  const resolved = [];
  for (let offset = 0; offset < normalizedCards.length; offset += batchSize) {
    const batch = normalizedCards.slice(offset, offset + batchSize);
    const requests = batch.map((card) => ({
      clientKey: `cid-${card.cid}`,
      names: card.aliases,
    }));
    const response = await resolveBatch(requests);
    if (!Array.isArray(response?.matches)) {
      throw buildError(
        "LEGACY_LUA_PRECOMPUTE_IDENTITY_INVALID",
        "identity resolver returned no matches array",
      );
    }
    const byClientKey = new Map(response.matches.map((match) => [
      match?.clientKey,
      match,
    ]));
    for (const card of batch) {
      const match = byClientKey.get(`cid-${card.cid}`) || null;
      const passcode = normalizeLegacyLuaPasscode(match?.passcode);
      resolved.push(Object.freeze({
        ...card,
        identityStatus: match?.status || "NOT_FOUND",
        passcode: match?.status === "RESOLVED" ? passcode : null,
      }));
    }
  }
  return Object.freeze(resolved);
}

export async function createPrecomputedLegacyLuaBuildPlan({
  cards,
  runtimeConfig,
  registry,
  resolveBatch,
  readLockedScript = (script) => readFile(script.path, "utf8"),
} = {}) {
  const prefilter = createRegistryDrivenLegacyLuaPrefilter(registry);
  const identities = await resolveLegacyLuaCardIdentityBatches({
    cards,
    resolveBatch,
  });
  const scripts = lockedScriptsByPasscode(runtimeConfig);
  const skippedByReason = Object.create(null);
  const unsupportedCorpusRecordCount = Math.max(0, cards.length - identities.length);
  if (unsupportedCorpusRecordCount > 0) {
    skippedByReason.CARD_CORPUS_IDENTITY_UNSUPPORTED = unsupportedCorpusRecordCount;
  }
  const eligible = [];
  let resolvedIdentityCount = 0;
  let lockedScriptCount = 0;
  let scannedScriptBytes = 0;
  let estimatedEffectCandidateCount = 0;
  const passcodeCids = new Map();
  for (const identity of identities) {
    if (identity.identityStatus !== "RESOLVED" || identity.passcode === null) {
      continue;
    }
    if (!passcodeCids.has(identity.passcode)) {
      passcodeCids.set(identity.passcode, new Set());
    }
    passcodeCids.get(identity.passcode).add(identity.cid);
  }
  const conflictingPasscodes = new Set([...passcodeCids]
    .filter(([, cids]) => cids.size > 1)
    .map(([passcode]) => passcode));

  for (const identity of identities) {
    if (identity.identityStatus !== "RESOLVED" || identity.passcode === null) {
      increment(skippedByReason, `IDENTITY_${identity.identityStatus}`);
      continue;
    }
    resolvedIdentityCount += 1;
    if (conflictingPasscodes.has(identity.passcode)) {
      increment(skippedByReason, "PASSCODE_CID_CONFLICT");
      continue;
    }
    const script = scripts.get(identity.passcode);
    if (!script) {
      increment(skippedByReason, "LOCKED_SCRIPT_NOT_FOUND");
      continue;
    }
    lockedScriptCount += 1;
    let source;
    try {
      source = String(await readLockedScript(script));
      validateLockedScript(source, script);
    } catch {
      increment(skippedByReason, "LOCKED_SCRIPT_INVALID");
      continue;
    }
    scannedScriptBytes += Buffer.byteLength(source, "utf8");
    if (!prefilter.matches(source)) {
      increment(skippedByReason, "REGISTRY_PREFILTER_NO_MATCH");
      continue;
    }
    const registrationCount = countEffectRegistrations(source);
    estimatedEffectCandidateCount += registrationCount;
    eligible.push(Object.freeze({
      cid: identity.cid,
      passcode: identity.passcode,
      aliases: identity.aliases,
      shardId: precomputedLegacyLuaShardId(identity.passcode),
      sourceContentSha256: script.sha256,
      scriptKey: script.key,
      scriptPath: script.path,
      scriptSize: script.size,
      registrationCount,
    }));
  }
  eligible.sort(comparePlannedCards);
  const content = {
    schemaVersion: PRECOMPUTED_LEGACY_LUA_BUILD_PLAN_SCHEMA,
    selectionPolicy: PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
    registrySha256: prefilter.descriptor.registrySha256,
    requestedCardCount: cards.length,
    resolvedIdentityCount,
    lockedScriptCount,
    registryPrefilteredCardCount: eligible.length,
    scannedScriptBytes,
    estimatedEffectCandidateCount,
    identityBatchCount: Math.ceil(
      identities.length / PRECOMPUTED_LEGACY_LUA_IDENTITY_BATCH_SIZE,
    ),
    skippedByReason: sortedCountObject(skippedByReason),
    cards: eligible,
  };
  return deepFreeze({
    ...content,
    planSha256: canonicalLegacyLuaSha256(content),
  });
}

export function precomputedLegacyLuaPlanReport(plan) {
  if (plan?.schemaVersion !== PRECOMPUTED_LEGACY_LUA_BUILD_PLAN_SCHEMA) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_PLAN_INVALID",
      "precomputed legacy Lua plan schema is invalid",
    );
  }
  const lowerMs = Math.round(plan.estimatedEffectCandidateCount * 25.761865);
  const upperMs = Math.round(plan.estimatedEffectCandidateCount * 54.245984);
  return deepFreeze({
    schemaVersion: "ocg-assistant-precomputed-legacy-lua-plan-report/v2",
    planSha256: plan.planSha256,
    selectionPolicy: plan.selectionPolicy,
    requestedCardCount: plan.requestedCardCount,
    resolvedIdentityCount: plan.resolvedIdentityCount,
    lockedScriptCount: plan.lockedScriptCount,
    registryPrefilteredCardCount: plan.registryPrefilteredCardCount,
    identityBatchCount: plan.identityBatchCount,
    scannedScriptBytes: plan.scannedScriptBytes,
    estimatedEffectCandidateCount: plan.estimatedEffectCandidateCount,
    estimatedCompileMs: { lower: lowerMs, upper: upperMs },
    estimationBasis: {
      benchmarkSuite: "formal-lua-legality-discovery/v2",
      lowerMeanMsPerCandidate: 25.761865,
      upperMeanMsPerCandidate: 54.245984,
      excludes: [
        "identity-resolution",
        "HTTP-and-serialization",
        "unsupported-script-variance",
      ],
    },
    skippedByReason: plan.skippedByReason,
  });
}

export function resourceHasActivationLegalityChecks(value) {
  let resource;
  try {
    resource = validateLegacyLuaSemanticResource(value);
  } catch {
    return false;
  }
  return resource.effectCandidates.some((candidate) => {
    const artifact = candidate.semanticArtifact || {};
    const plan = artifact.plan || artifact.partialPlan || {};
    return Array.isArray(plan.activationLegalityChecks) &&
      plan.activationLegalityChecks.length > 0;
  });
}

export function canReusePrecomputedLegacyLuaEntry({
  entry,
  plannedCard,
  registrySha256,
  engineVersionsSha256,
  capabilitiesSha256,
} = {}) {
  let resource;
  try {
    resource = validateLegacyLuaSemanticResource(entry?.resource);
  } catch {
    return false;
  }
  return String(entry?.cid || "") === String(plannedCard?.cid || "") &&
    normalizeLegacyLuaPasscode(entry?.passcode) === plannedCard?.passcode &&
    resource.resourceBinding.sourceContentSha256 ===
      plannedCard?.sourceContentSha256 &&
    resource.registryBinding?.registrySha256 === registrySha256 &&
    resource.engineBinding?.versionsSha256 === engineVersionsSha256 &&
    resource.engineBinding?.capabilitiesSha256 === capabilitiesSha256 &&
    resourceHasActivationLegalityChecks(resource);
}

export function groupPrecomputedLegacyLuaPlanByShard(plan) {
  const groups = new Map();
  for (const card of plan.cards || []) {
    if (!groups.has(card.shardId)) groups.set(card.shardId, []);
    groups.get(card.shardId).push(card);
  }
  for (const cards of groups.values()) cards.sort(comparePlannedCards);
  return new Map([...groups.entries()].sort(([left], [right]) =>
    comparePrecomputedLegacyLuaStableText(left, right)
  ));
}

export function cardAliases(card) {
  const names = [
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...(Array.isArray(card?.aliases) ? card.aliases : []),
  ].filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  const byNormalized = new Map();
  for (const name of names) {
    const normalized = normalizePrecomputedLegacyLuaAlias(name);
    if (normalized !== null && !byNormalized.has(normalized)) {
      byNormalized.set(normalized, name);
    }
  }
  return [...byNormalized.values()];
}

function normalizeCardRecord(card) {
  if (isExplicitNegativeSkillRecord(card)) {
    return SKIP_NEGATIVE_SKILL_RECORD;
  }
  const cid = normalizePrecomputedLegacyLuaCid(card?.id ?? card?.cid);
  const aliases = cardAliases(card);
  if (cid === null || aliases.length === 0) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_CARD_CORPUS_INVALID",
      "every non-skill card corpus record requires a stable CID and an exact alias",
    );
  }
  return Object.freeze({ cid, aliases, card });
}

function isExplicitNegativeSkillRecord(card) {
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    return false;
  }
  const rawCid = card.id ?? card.cid;
  const negativeCid = typeof rawCid === "number"
    ? Number.isSafeInteger(rawCid) && rawCid < 0
    : typeof rawCid === "string" && /^-\d+$/u.test(rawCid.trim()) &&
      BigInt(rawCid.trim()) < 0n;
  if (!negativeCid) return false;
  const declaredTypes = [card.type, card.cardType]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value).trim().toLowerCase());
  return declaredTypes.length > 0 && declaredTypes.every((value) =>
    value === "skill"
  );
}

function lockedScriptsByPasscode(runtimeConfig) {
  if (!Array.isArray(runtimeConfig?.scripts)) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_RUNTIME_INVALID",
      "locked runtime config must expose scripts",
    );
  }
  const result = new Map();
  for (const script of runtimeConfig.scripts) {
    const match = String(script?.key || "").match(/^c(\d{1,10})\.lua$/u);
    const passcode = normalizeLegacyLuaPasscode(match?.[1]);
    if (passcode === null) continue;
    if (result.has(passcode)) {
      throw buildError(
        "LEGACY_LUA_PRECOMPUTE_RUNTIME_INVALID",
        `locked runtime contains duplicate script passcode ${passcode}`,
      );
    }
    if (typeof script.path !== "string" || !SHA256.test(String(script.sha256)) ||
        !Number.isSafeInteger(script.size) || script.size < 0) {
      throw buildError(
        "LEGACY_LUA_PRECOMPUTE_RUNTIME_INVALID",
        "locked runtime script binding is invalid",
      );
    }
    result.set(passcode, Object.freeze({
      key: script.key,
      path: script.path,
      sha256: script.sha256,
      size: script.size,
    }));
  }
  return result;
}

function validateLockedScript(source, script) {
  const bytes = Buffer.byteLength(source, "utf8");
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (bytes !== script.size || sha256 !== script.sha256) {
    throw buildError(
      "LEGACY_LUA_PRECOMPUTE_SOURCE_INVALID",
      "locked Lua source does not match its runtime size and digest",
    );
  }
}

function countEffectRegistrations(source) {
  return source.match(/RegisterEffect\s*\(/gu)?.length || 0;
}

function comparePlannedCards(left, right) {
  return comparePrecomputedLegacyLuaStableText(left.shardId, right.shardId) ||
    comparePrecomputedLegacyLuaStableText(left.passcode, right.passcode) ||
    comparePrecomputedLegacyLuaStableText(left.cid, right.cid);
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function sortedCountObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    comparePrecomputedLegacyLuaStableText(left, right)
  ));
}

function rejectDuplicates(values, message) {
  if (new Set(values).size !== values.length) {
    throw buildError("LEGACY_LUA_PRECOMPUTE_CARD_CORPUS_INVALID", message);
  }
}

function buildError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}
