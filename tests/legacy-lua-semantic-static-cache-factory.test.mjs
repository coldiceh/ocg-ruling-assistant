import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrecomputedLegacyLuaSemanticPacketFactory,
  PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA,
  validatePrecomputedLegacyLuaSemanticCache,
} from "../backend/legacyLuaSemanticStaticCacheFactory.mjs";
import {
  finalizeLegacyLuaSemanticResource,
  serializeLegacyLuaSemanticPacket,
  validateLegacyLuaSemanticPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";

const GENERATED_AT = "2026-08-07T00:00:00.000Z";

test("static cache factory resolves explicit passcode, stable CID, and exact normalized alias", () => {
  const factory = createPrecomputedLegacyLuaSemanticPacketFactory({
    cache: makeCache([
      cacheEntry({
        cid: "1001",
        passcode: "123",
        aliases: ["Alpha\u3000Card"],
        resourceId: "legacy:alpha",
      }),
      cacheEntry({
        cid: "1002",
        passcode: "456",
        aliases: ["Beta Card"],
        resourceId: "legacy:beta",
      }),
    ]),
  });

  const byPasscode = factory({ retrievedCards: [{ passcode: 123 }] });
  const byCid = factory({ cardResolution: { resolvedCards: [{ cid: "1002" }] } });
  const byAlias = factory({ identities: [{ name: "  ＡＬＰＨＡ   CARD  " }] });

  for (const packet of [byPasscode, byCid, byAlias]) {
    validateLegacyLuaSemanticPacket(packet);
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.canConfirmOfficialRuling, false);
    assert.equal(packet.legacyAcceptedAsTruth, false);
  }
  assert.deepEqual(byPasscode.resources.map((item) => item.resourceId), ["legacy:alpha"]);
  assert.deepEqual(byCid.resources.map((item) => item.resourceId), ["legacy:beta"]);
  assert.deepEqual(byAlias.resources.map((item) => item.resourceId), ["legacy:alpha"]);
});

test("static cache lookup fails closed for alias and strong-identity ambiguity", () => {
  const factory = createPrecomputedLegacyLuaSemanticPacketFactory({
    cache: makeCache([
      cacheEntry({
        cid: "2001",
        passcode: "20000001",
        aliases: ["Shared Name"],
        resourceId: "legacy:first",
      }),
      cacheEntry({
        cid: "2002",
        passcode: "20000002",
        aliases: ["Shared Name"],
        resourceId: "legacy:second",
      }),
    ]),
  });

  const aliasAmbiguous = factory({ cards: [{ name: "shared name" }] });
  assert.equal(aliasAmbiguous.resources.length, 0);
  assert.deepEqual(
    aliasAmbiguous.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_IDENTITY_AMBIGUOUS"],
  );

  const strongIdentityConflict = factory({
    cards: [{ passcode: "20000001", cid: "2002" }],
  });
  assert.equal(strongIdentityConflict.resources.length, 0);
  assert.deepEqual(
    strongIdentityConflict.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_IDENTITY_AMBIGUOUS"],
  );
});

test("complete cache miss returns a typed UNKNOWN packet", () => {
  const factory = createPrecomputedLegacyLuaSemanticPacketFactory({
    cache: makeCache([cacheEntry({
      cid: "3001",
      passcode: "30000001",
      aliases: ["Known Card"],
      resourceId: "legacy:known",
    })]),
  });

  const packet = factory({ identities: [{ name: "Unknown Card" }] });
  validateLegacyLuaSemanticPacket(packet);
  assert.equal(packet.resources.length, 0);
  assert.equal(packet.verdict, "UNKNOWN");
  assert.deepEqual(
    packet.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_CACHE_MISS"],
  );
});

test("partial cache hit retains matched evidence and marks coverage incomplete", () => {
  const factory = createPrecomputedLegacyLuaSemanticPacketFactory({
    cache: makeCache([cacheEntry({
      cid: "4001",
      passcode: "40000001",
      aliases: ["Covered Card"],
      resourceId: "legacy:covered",
    })]),
  });

  const packet = factory({
    identities: [
      { passcode: "40000001" },
      { name: "Uncovered Card" },
      {},
    ],
  });
  validateLegacyLuaSemanticPacket(packet);
  assert.equal(packet.resources.some((item) => item.resourceId === "legacy:covered"), true);
  assert.equal(packet.resources.some((item) => item.status === "TYPED_UNKNOWN"), true);
  assert.equal(
    packet.unknownReasons.some((reason) =>
      reason.code === "LEGACY_LUA_PRECOMPUTED_COVERAGE_INCOMPLETE"
    ),
    true,
  );
  const coverageReason = packet.unknownReasons.find((reason) =>
    reason.code === "LEGACY_LUA_PRECOMPUTED_COVERAGE_INCOMPLETE"
  );
  assert.equal(coverageReason.details.requestedIdentityCount, 3);
  assert.equal(coverageReason.details.unmatchedIdentityCount, 2);
  assert.equal(packet.verdict, "UNKNOWN");
  assert.equal(packet.canConfirmOfficialRuling, false);
});

test("cache and request order do not change merged packet bytes", () => {
  const alpha = cacheEntry({
    cid: "5001",
    passcode: "50000001",
    aliases: ["Alpha"],
    resourceId: "legacy:stable-alpha",
  });
  const beta = cacheEntry({
    cid: "5002",
    passcode: "50000002",
    aliases: ["Beta"],
    resourceId: "legacy:stable-beta",
  });
  const firstFactory = createPrecomputedLegacyLuaSemanticPacketFactory({
    cache: makeCache([alpha, beta]),
    maxCandidates: 7,
    maxSerializedBytes: 128 * 1024,
  });
  const secondFactory = createPrecomputedLegacyLuaSemanticPacketFactory({
    cache: makeCache([beta, alpha]),
    maxCandidates: 7,
    maxSerializedBytes: 128 * 1024,
  });

  const first = firstFactory({
    identities: [{ passcode: "50000002" }, { passcode: "50000001" }],
  });
  const second = secondFactory({
    identities: [{ passcode: "50000001" }, { passcode: "50000002" }],
  });
  assert.equal(first.packetSha256, second.packetSha256);
  assert.equal(
    serializeLegacyLuaSemanticPacket(first),
    serializeLegacyLuaSemanticPacket(second),
  );
  assert.equal(first.truncation.maxCandidates, 7);
  assert.equal(first.truncation.maxSerializedBytes, 128 * 1024);
});

test("invalid cached resource is rejected before lookup", () => {
  const entry = cacheEntry({
    cid: "6001",
    passcode: "60000001",
    aliases: ["Tampered"],
    resourceId: "legacy:tampered",
  });
  entry.resource.verdict = "TRUE";
  const cache = makeCache([entry]);
  assert.throws(
    () => validatePrecomputedLegacyLuaSemanticCache(cache),
    (error) => error?.code === "LEGACY_LUA_PRECOMPUTED_CACHE_INVALID",
  );

  const packet = createPrecomputedLegacyLuaSemanticPacketFactory({ cache })({
    identities: [{ passcode: "60000001" }],
  });
  assert.equal(packet.verdict, "UNKNOWN");
  assert.equal(packet.resources.length, 0);
  assert.deepEqual(
    packet.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_CACHE_INVALID"],
  );
});

function makeCache(entries) {
  return {
    schemaVersion: PRECOMPUTED_LEGACY_LUA_CACHE_SCHEMA,
    generatedAt: GENERATED_AT,
    source: {
      profileId: "fixture",
      sourceId: null,
      snapshotCreatedAt: GENERATED_AT,
      lockId: "a".repeat(64),
      snapshotId: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      scriptSetSha256: "d".repeat(64),
    },
    selection: {
      corpus: "fixture",
      caseIds: [],
      requestedCardCount: entries.length,
      compiledCardCount: entries.length,
      skipped: [],
    },
    entries,
  };
}

function cacheEntry({ cid, passcode, aliases, resourceId }) {
  return {
    cid,
    passcode,
    aliases,
    resource: structuredClone(unknownResource(resourceId)),
  };
}

function unknownResource(resourceId) {
  return finalizeLegacyLuaSemanticResource({
    status: "TYPED_UNKNOWN",
    resourceId,
    resourceBinding: {
      sourceDocumentId: resourceId,
      sourceContentSha256: "e".repeat(64),
      documentVersion: "fixture@1",
      locator: `fixture://${resourceId}`,
      retrievedAt: GENERATED_AT,
    },
    engineBinding: null,
    registryBinding: null,
    candidateSetSha256: null,
    effectCandidates: [],
    unknownReasons: [{
      phase: "LEGACY_DISCOVERY",
      code: "FIXTURE_NON_AUTHORITATIVE",
      message: "fixture remains discovery-only evidence",
      evidenceIds: [resourceId],
    }],
  });
}
