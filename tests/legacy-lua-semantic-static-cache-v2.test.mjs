import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeLegacyLuaSemanticResource,
  validateLegacyLuaSemanticPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";
import {
  createPrecomputedLegacyLuaCacheManifest,
  createPrecomputedLegacyLuaCacheShard,
  createPrecomputedLegacyLuaShardSummary,
  createShardedPrecomputedLegacyLuaSemanticPacketFactory,
  precomputedLegacyLuaShardId,
  PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
  validatePrecomputedLegacyLuaCacheManifest,
  validatePrecomputedLegacyLuaCacheShard,
} from "../backend/legacyLuaSemanticStaticCacheV2.mjs";
import {
  resolveLegacyLuaCardIdentityBatches,
} from "../scripts/lib/precomputed-legacy-lua-cache-v2.mjs";

const GENERATED_AT = "2026-08-07T00:00:00.000Z";

test("full-cache identity planning skips non-OCG corpus records without aborting", async () => {
  const requests = [];
  const resolved = await resolveLegacyLuaCardIdentityBatches({
    cards: [
      { id: "21779", name: "绚岚之达象", aliases: ["絢嵐たるエルダム"] },
      {
        id: "-75",
        type: "skill",
        cardType: "skill",
        name: "Ancient Fusion",
        aliases: ["Ancient Fusion"],
      },
    ],
    async resolveBatch(batch) {
      requests.push(...batch);
      return {
        matches: batch.map((item) => ({
          clientKey: item.clientKey,
          status: "RESOLVED",
          passcode: "12345678",
        })),
      };
    },
  });

  assert.deepEqual(requests.map((item) => item.clientKey), ["cid-21779"]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].cid, "21779");
});

test("full-cache identity planning fails closed for malformed non-skill records", async () => {
  const invalidRecords = [
    {
      label: "invalid positive CID",
      card: { id: "not-a-cid", type: "monster", aliases: ["Broken"] },
    },
    {
      label: "negative non-skill CID",
      card: { id: "-76", type: "monster", aliases: ["Broken"] },
    },
    {
      label: "missing exact alias",
      card: { id: "21779", type: "monster" },
    },
    {
      label: "conflicting negative skill type",
      card: {
        id: "-75",
        type: "skill",
        cardType: "monster",
        aliases: ["Broken"],
      },
    },
    { label: "damaged null record", card: null },
  ];

  for (const { label, card } of invalidRecords) {
    let resolverCalled = false;
    await assert.rejects(
      resolveLegacyLuaCardIdentityBatches({
        cards: [card],
        async resolveBatch() {
          resolverCalled = true;
          return { matches: [] };
        },
      }),
      (error) =>
        error?.code === "LEGACY_LUA_PRECOMPUTE_CARD_CORPUS_INVALID",
      label,
    );
    assert.equal(resolverCalled, false, `${label} must fail before resolution`);
  }
});

test("v2 lazy factory loads only shards selected by CID, passcode, or exact alias", async () => {
  const fixture = makeFixture();
  const loaded = [];
  const factory = createShardedPrecomputedLegacyLuaSemanticPacketFactory({
    manifest: fixture.manifest,
    async loadShard(descriptor) {
      loaded.push(descriptor.shardId);
      return fixture.shards.get(descriptor.shardId);
    },
  });

  const byCid = await factory({ cards: [{ cid: fixture.alpha.cid }] });
  assert.deepEqual(byCid.resources.map((item) => item.resourceId),
    [fixture.alpha.resource.resourceId]);
  assert.deepEqual(loaded, [fixture.alpha.shardId]);

  const byPasscode = await factory({
    cards: [{ passcode: fixture.beta.passcode }],
  });
  assert.deepEqual(byPasscode.resources.map((item) => item.resourceId),
    [fixture.beta.resource.resourceId]);
  assert.deepEqual(new Set(loaded),
    new Set([fixture.alpha.shardId, fixture.beta.shardId]));

  const beforeAlias = loaded.length;
  const byAlias = await factory({ cards: [{ name: "  ＡＬＰＨＡ   CARD " }] });
  assert.deepEqual(byAlias.resources.map((item) => item.resourceId),
    [fixture.alpha.resource.resourceId]);
  assert.equal(loaded.length, beforeAlias, "loaded shard promises must be memoized");
  for (const packet of [byCid, byPasscode, byAlias]) {
    validateLegacyLuaSemanticPacket(packet);
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.canConfirmOfficialRuling, false);
  }
});

test("v2 lazy factory preserves miss, partial coverage, and cross-shard ambiguity", async () => {
  const fixture = makeFixture({ sharedAlias: true });
  const loaded = [];
  const factory = createShardedPrecomputedLegacyLuaSemanticPacketFactory({
    manifest: fixture.manifest,
    async loadShard(descriptor) {
      loaded.push(descriptor.shardId);
      return fixture.shards.get(descriptor.shardId);
    },
  });

  const miss = await factory({ cards: [{ name: "not indexed" }] });
  assert.equal(loaded.length, 0);
  assert.deepEqual(miss.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_CACHE_MISS"]);

  const partial = await factory({
    cards: [{ cid: fixture.alpha.cid }, { name: "not indexed" }],
  });
  assert.equal(partial.resources.some((item) =>
    item.resourceId === fixture.alpha.resource.resourceId), true);
  assert.equal(partial.unknownReasons.some((reason) =>
    reason.code === "LEGACY_LUA_PRECOMPUTED_COVERAGE_INCOMPLETE"), true);

  const ambiguous = await factory({ cards: [{ name: "shared alias" }] });
  assert.equal(ambiguous.resources.length, 0);
  assert.deepEqual(ambiguous.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_IDENTITY_AMBIGUOUS"]);
});

test("v2 manifest and shards are stable, content-addressed, and reject tampering", () => {
  const fixture = makeFixture();
  validatePrecomputedLegacyLuaCacheManifest(fixture.manifest);
  for (const shard of fixture.shards.values()) {
    validatePrecomputedLegacyLuaCacheShard(shard);
  }

  const firstId = fixture.alpha.shardId;
  const entries = fixture.shards.get(firstId).entries;
  const same = createPrecomputedLegacyLuaCacheShard({
    shardId: firstId,
    generatedAt: GENERATED_AT,
    entries: [...entries].reverse(),
  });
  assert.equal(same.shardContentSha256,
    fixture.shards.get(firstId).shardContentSha256);

  const tamperedManifest = structuredClone(fixture.manifest);
  tamperedManifest.selection.retainedResourceCount = 999;
  assert.throws(
    () => validatePrecomputedLegacyLuaCacheManifest(tamperedManifest),
    (error) => error?.code === "LEGACY_LUA_PRECOMPUTED_MANIFEST_INVALID",
  );

  const tamperedShard = structuredClone(fixture.shards.get(firstId));
  tamperedShard.entries[0].aliases.push("tampered alias");
  assert.throws(
    () => validatePrecomputedLegacyLuaCacheShard(tamperedShard),
    (error) => error?.code === "LEGACY_LUA_PRECOMPUTED_SHARD_INVALID",
  );
});

test("invalid loaded shard fails closed instead of falling back to unverified data", async () => {
  const fixture = makeFixture();
  const factory = createShardedPrecomputedLegacyLuaSemanticPacketFactory({
    manifest: fixture.manifest,
    async loadShard(descriptor) {
      const shard = structuredClone(fixture.shards.get(descriptor.shardId));
      shard.entries[0].cid = "9999";
      return shard;
    },
  });
  const packet = await factory({ cards: [{ cid: fixture.alpha.cid }] });
  assert.equal(packet.resources.length, 0);
  assert.equal(packet.verdict, "UNKNOWN");
  assert.deepEqual(packet.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PRECOMPUTED_SHARD_INVALID"]);
});

function makeFixture({ sharedAlias = false } = {}) {
  const passcodes = distinctShardPasscodes();
  const alpha = makeEntry({
    cid: "1001",
    passcode: passcodes[0],
    aliases: ["Alpha Card", ...(sharedAlias ? ["Shared Alias"] : [])],
    resourceId: "legacy:fixture-alpha",
  });
  const beta = makeEntry({
    cid: "1002",
    passcode: passcodes[1],
    aliases: ["Beta Card", ...(sharedAlias ? ["Shared Alias"] : [])],
    resourceId: "legacy:fixture-beta",
  });
  const shards = new Map();
  for (const entry of [alpha, beta]) {
    const shard = createPrecomputedLegacyLuaCacheShard({
      shardId: entry.shardId,
      generatedAt: GENERATED_AT,
      entries: [entry],
    });
    shards.set(entry.shardId, shard);
  }
  const summaries = [...shards].map(([shardId, shard]) =>
    createPrecomputedLegacyLuaShardSummary({
      shard,
      path: `shards/${shardId}.json`,
      serializedBytes: Buffer.byteLength(JSON.stringify(shard), "utf8"),
    })
  );
  const manifest = createPrecomputedLegacyLuaCacheManifest({
    generatedAt: GENERATED_AT,
    source: { profileId: "fixture", scriptSetSha256: "a".repeat(64) },
    selection: {
      policy: PRECOMPUTED_LEGACY_LUA_SELECTION_POLICY,
      corpus: "data/cards.json",
      retainedResourceCount: 2,
    },
    shardSummaries: summaries,
  });
  return { alpha, beta, shards, manifest };
}

function makeEntry({ cid, passcode, aliases, resourceId }) {
  return {
    cid,
    passcode,
    aliases,
    shardId: precomputedLegacyLuaShardId(passcode),
    resource: unknownResource(resourceId),
  };
}

function unknownResource(resourceId) {
  return finalizeLegacyLuaSemanticResource({
    status: "TYPED_UNKNOWN",
    resourceId,
    resourceBinding: {
      sourceDocumentId: resourceId,
      sourceContentSha256: "b".repeat(64),
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
      message: "fixture remains discovery-only",
      evidenceIds: [resourceId],
    }],
  });
}

function distinctShardPasscodes() {
  const first = "10000001";
  for (let number = 10_000_002; number < 10_001_000; number += 1) {
    const second = String(number);
    if (precomputedLegacyLuaShardId(first) !==
        precomputedLegacyLuaShardId(second)) {
      return [first, second];
    }
  }
  throw new Error("fixture could not find distinct shard passcodes");
}
