import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyLuaUnknownPacket } from "../backend/legacyLuaSemanticPacket.mjs";
import { buildLegacyLuaSemanticPacket } from "../backend/ragRulingPipeline.mjs";

test("public pipeline freezes a validated non-authoritative Lua packet", async () => {
  const expected = createLegacyLuaUnknownPacket({
    code: "TEST_TYPED_UNKNOWN",
    message: "test packet",
  });
  let calls = 0;
  const actual = await buildLegacyLuaSemanticPacket({
    factory: async ({ userQuery, cardResolution }) => {
      calls += 1;
      assert.equal(userQuery, "question");
      assert.deepEqual(cardResolution, { resolvedCards: [] });
      return expected;
    },
    userQuery: "question",
    cardResolution: { resolvedCards: [] },
    evidence: {},
    env: {},
  });

  assert.equal(calls, 1);
  assert.equal(actual.packetSha256, expected.packetSha256);
  assert.equal(actual.verdict, "UNKNOWN");
  assert.equal(actual.canConfirmOfficialRuling, false);
  assert.equal(actual.legacyAcceptedAsTruth, false);
});

test("missing packet factory fails closed as typed UNKNOWN", async () => {
  const packet = await buildLegacyLuaSemanticPacket({ env: {} });
  assert.equal(packet.verdict, "UNKNOWN");
  assert.deepEqual(
    packet.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PACKET_NOT_CONFIGURED"],
  );
});

test("packet timeout does not block the final ruling pipeline", async () => {
  const packet = await buildLegacyLuaSemanticPacket({
    factory: () => new Promise(() => {}),
    env: { RAG_LEGACY_LUA_TIMEOUT_MS: "50" },
  });
  assert.equal(packet.verdict, "UNKNOWN");
  assert.deepEqual(
    packet.unknownReasons.map((reason) => reason.code),
    ["LEGACY_LUA_PACKET_TIMEOUT"],
  );
});
