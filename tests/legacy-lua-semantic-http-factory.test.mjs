import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LEGACY_LUA_HTTP_ENDPOINTS,
  createLegacyLuaSemanticHttpFacade,
} from "../backend/legacyLuaSemanticHttpFacade.mjs";
import {
  collectEffectiveLegacyLuaCardIdentities,
  collectEffectiveLegacyLuaPasscodes,
  createDefaultLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticPacketFactory.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticProduction.mjs";
import {
  canonicalLegacyLuaSha256,
  createLegacyLuaUnknownPacket,
  validateLegacyLuaSemanticPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";

const RESOURCE_BINDING = Object.freeze({
  lockId: "1".repeat(64),
  snapshotId: "2".repeat(64),
  manifestSha256: "3".repeat(64),
  coreSha256: "4".repeat(64),
  dbSetSha256: "5".repeat(64),
  scriptSetSha256: "6".repeat(64),
  patchSetSha256: "7".repeat(64),
  apiAbi: "ocgcore/test",
});

test("passcode discovery accepts canonical non-zero uint32 passwords only", () => {
  assert.deepEqual(collectEffectiveLegacyLuaPasscodes({
    cardResolution: {
      resolvedCards: [
        { id: "21385", cardId: "21385", passcode: "12345678" },
        { passcode: "07293697" },
        { passcode: "12345678" },
        { passcode: "00000000" },
        { passcode: "1234" },
        { passcode: "123456789" },
        { passcode: "4294967295" },
        { passcode: "4294967296" },
        { id: "87654321" },
      ],
    },
    retrievedCards: [
      { password: "23456789" },
      { raw: { passcode: "34567890" } },
    ],
  }), [
    "00001234",
    "07293697",
    "12345678",
    "123456789",
    "23456789",
    "34567890",
    "4294967295",
  ]);
});

test("a nested numeric Baige password is not reinterpreted as a stable CID", () => {
  const input = {
    retrievedCards: [{
      cid: "4909",
      id: "4909",
      passcode: "05318639",
      name: "匿名卡A",
      raw: {
        cid: 4909,
        id: 5318639,
        raw: { id: 5318639 },
      },
    }],
  };
  assert.deepEqual(collectEffectiveLegacyLuaPasscodes(input), ["05318639"]);
  assert.deepEqual(collectEffectiveLegacyLuaCardIdentities(input), []);
});

test("cards without a password produce exact-name identity requests instead of treating CID as passcode", () => {
  assert.deepEqual(collectEffectiveLegacyLuaCardIdentities({
    cardResolution: {
      resolvedCards: [
        {
          id: "22130",
          name: "天雷之双风神 息那",
          jaName: "天雷ノ双風神 シーナ",
          aliases: ["天雷之双风神 息那"],
        },
        { name: "已有卡密", passcode: "12345678" },
      ],
    },
  }), [{
    clientKey: "resolved-card-1",
    names: ["天雷之双风神 息那", "天雷ノ双風神 シーナ"],
  }]);
});

test("identity planning merges low- and high-information duplicates without a redundant name lookup", () => {
  const input = {
    retrievedCards: [{
      id: "22130",
      name: "天雷之双风神 息那",
      jaName: "天雷ノ双風神 シーナ",
    }],
    cardResolution: {
      resolvedCards: [{
        cid: "22130",
        passcode: "12197223",
        name: "天雷之双风神 息那",
        aliases: ["天雷ノ双風神 シーナ"],
      }],
    },
  };
  assert.deepEqual(collectEffectiveLegacyLuaPasscodes(input), ["12197223"]);
  assert.deepEqual(collectEffectiveLegacyLuaCardIdentities(input), []);

  const aliasOnlyDuplicate = {
    retrievedCards: [{ name: "匿名精确别名" }],
    cardResolution: {
      resolvedCards: [{
        passcode: "12345678",
        aliases: ["匿名精确别名"],
      }],
    },
  };
  assert.deepEqual(
    collectEffectiveLegacyLuaCardIdentities(aliasOnlyDuplicate),
    [],
  );
});

test("identity planning rejects conflicting CID, passcode, and alias mappings", () => {
  for (const input of [
    {
      retrievedCards: [
        { cid: "22130", passcode: "12345678", name: "冲突卡" },
        { cid: "22130", passcode: "87654321", name: "冲突卡" },
      ],
    },
    {
      retrievedCards: [
        { cid: "22130", passcode: "12345678", name: "冲突卡A" },
        { cid: "22131", passcode: "12345678", name: "冲突卡B" },
      ],
    },
    {
      retrievedCards: [
        { passcode: "12345678", name: "歧义别名" },
        { passcode: "87654321", name: "歧义别名" },
      ],
    },
  ]) {
    assert.throws(
      () => collectEffectiveLegacyLuaCardIdentities(input),
      (error) => error.code === "LEGACY_LUA_CARD_IDENTITY_CONFLICT",
    );
  }
});

test("identity aliases fail closed instead of being coerced or truncated", async (t) => {
  await t.test("factory rejects 17 aliases as typed UNKNOWN", async () => {
    const factory = createDefaultLegacyLuaSemanticPacketFactory({
      facadeFactory: () => {
        throw new Error("invalid identity input must not contact the engine");
      },
    });
    const packet = await factory({
      cardResolution: {
        resolvedCards: [{
          aliases: Array.from({ length: 17 }, (_, index) => `alias-${index}`),
        }],
      },
    });
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.unknownReasons[0].code,
      "LEGACY_LUA_CARD_IDENTITY_INVALID");
  });

  for (const [label, names] of [
    ["17 names", Array.from({ length: 17 }, (_, index) => `name-${index}`)],
    ["non-string", ["valid", 123]],
    ["overlength", ["x".repeat(257)]],
  ]) {
    await t.test(label, async () => {
      const facade = createLegacyLuaSemanticHttpFacade({
        env: { OCG_ENGINE_URL: "https://engine.example.test" },
        requestJson: async () => {
          throw new Error("invalid identity input must not contact the engine");
        },
      });
      await assert.rejects(
        facade.resolveLegacyLuaCardIdentities([{
          clientKey: "invalid",
          names,
        }]),
        (error) => error.code === "LEGACY_LUA_CARD_IDENTITY_INVALID",
      );
    });
  }
});

test("HTTP facade pins capability, registry, source, and operation bindings", async () => {
  const fixture = httpFixture();
  const calls = [];
  const facade = createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    requestJson: async ({ path, method, body, maxResponseBytes }) => {
      calls.push({ path, method, body, maxResponseBytes });
      return fixture.transport(path, body);
    },
  });

  assert.deepEqual(await facade.getEngineVersions(), fixture.versions);
  assert.deepEqual(await facade.getEngineCapabilities(), fixture.capabilities);
  assert.deepEqual(
    await facade.getLegacyLuaApiSemanticsRegistry(),
    fixture.registry,
  );
  const sourceA = await facade.resolveLegacyLuaSource("07293697");
  const sourceB = await facade.resolveLegacyLuaSource("07293697");
  assert.deepEqual(sourceA, fixture.source);
  assert.deepEqual(sourceB, fixture.source);
  const candidateSet = await facade.enumerateLegacyLuaEffectCandidates(sourceA);
  assert.equal(candidateSet.kind, "LEGACY_LUA_EFFECT_CANDIDATE_SET");
  assert.equal(
    calls.filter((call) =>
      call.path === LEGACY_LUA_HTTP_ENDPOINTS.capabilities
    ).length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.path === LEGACY_LUA_HTTP_ENDPOINTS.source)
      .length,
    1,
  );
  assert.equal(
    calls.find((call) => call.path === LEGACY_LUA_HTTP_ENDPOINTS.source)
      .body.passcode,
    "07293697",
  );
  assert.equal(calls.every((call) => call.maxResponseBytes === 2 * 1024 * 1024),
    true);
});

test("HTTP facade resolves and memoizes exact card names against the locked CDB", async () => {
  const fixture = httpFixture();
  const calls = [];
  const facade = createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    requestJson: async ({ path, body }) => {
      calls.push({ path, body });
      return fixture.transport(path, body);
    },
  });
  const request = [{
    clientKey: "card-1",
    names: ["天雷之双风神 息那", "天雷ノ双風神 シーナ"],
  }];

  const first = await facade.resolveLegacyLuaCardIdentities(request);
  const second = await facade.resolveLegacyLuaCardIdentities(request);
  assert.deepEqual(first, second);
  assert.equal(first.matches[0].status, "RESOLVED");
  assert.equal(first.matches[0].passcode, "12197223");
  assert.equal(calls.filter((call) =>
    call.path === LEGACY_LUA_HTTP_ENDPOINTS.cardIdentities).length, 1);
});

test("HTTP facade accepts stable 9 and 10 digit uint32 passcodes", async () => {
  const fixture = httpFixture();
  const calls = [];
  const facade = createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    requestJson: async ({ path, body }) => {
      calls.push({ path, body });
      return fixture.transport(path, body);
    },
  });

  const nine = await facade.resolveLegacyLuaSource("123456789");
  const ten = await facade.resolveLegacyLuaSource(4294967295);
  assert.equal(nine.passcode, "123456789");
  assert.equal(ten.passcode, "4294967295");
  assert.deepEqual(calls.filter((call) =>
    call.path === LEGACY_LUA_HTTP_ENDPOINTS.source).map((call) =>
    call.body.passcode), ["123456789", "4294967295"]);
  await assert.rejects(
    facade.resolveLegacyLuaSource("4294967296"),
    (error) => error.code === "LEGACY_LUA_PASSCODE_INVALID",
  );
});

test("HTTP facade requires exact-name capability and endpoint negotiation", async (t) => {
  for (const [label, mutate] of [
    ["lockedExactCardNames", (payload) => {
      payload.sourceResolution.lockedExactCardNames = false;
    }],
    ["cardIdentities endpoint", (payload) => {
      delete payload.endpoints.cardIdentities;
    }],
  ]) {
    await t.test(label, async () => {
      const fixture = httpFixture();
      const facade = createLegacyLuaSemanticHttpFacade({
        env: { OCG_ENGINE_URL: "https://engine.example.test" },
        requestJson: async ({ path, body }) => {
          const response = fixture.transport(path, body);
          if (path === LEGACY_LUA_HTTP_ENDPOINTS.capabilities) {
            mutate(response.payload);
          }
          return response;
        },
      });
      await assert.rejects(
        facade.getEngineVersions(),
        (error) => [
          "LEGACY_LUA_HTTP_BINDING_INVALID",
          "LEGACY_LUA_HTTP_SCHEMA_INVALID",
        ].includes(error.code),
      );
    });
  }
});

test("HTTP facade closes identity response binding, keys, and cardinality", async (t) => {
  const mutations = [
    ["scriptSetSha256", (result) => {
      result.scriptSetSha256 = "0".repeat(64);
    }],
    ["missing clientKey", (result) => {
      result.matches = [];
    }],
    ["extra clientKey", (result) => {
      result.matches.push({
        clientKey: "extra",
        status: "NOT_FOUND",
        passcode: null,
        candidates: [],
      });
    }],
    ["unexpected clientKey", (result) => {
      result.matches[0].clientKey = "unexpected";
    }],
    ["resolved without candidate", (result) => {
      result.matches[0].candidates = [];
    }],
    ["not found with candidate", (result) => {
      result.matches[0].status = "NOT_FOUND";
      result.matches[0].passcode = null;
    }],
    ["ambiguous with one candidate", (result) => {
      result.matches[0].status = "AMBIGUOUS";
      result.matches[0].passcode = null;
    }],
    ["candidate passcode mismatch", (result) => {
      result.matches[0].candidates[0].passcode = "87654321";
    }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const fixture = httpFixture();
      const facade = createLegacyLuaSemanticHttpFacade({
        env: { OCG_ENGINE_URL: "https://engine.example.test" },
        requestJson: async ({ path, body }) => {
          const response = fixture.transport(path, body);
          if (path === LEGACY_LUA_HTTP_ENDPOINTS.cardIdentities) {
            mutate(response.payload.result);
          }
          return response;
        },
      });
      await assert.rejects(
        facade.resolveLegacyLuaCardIdentities([{
          clientKey: "card-1",
          names: ["天雷ノ双風神 シーナ"],
        }]),
        (error) => [
          "LEGACY_LUA_HTTP_BINDING_INVALID",
          "LEGACY_LUA_HTTP_SCHEMA_INVALID",
        ].includes(error.code),
      );
    });
  }
});

test("HTTP facade preserves a bound TYPED_UNKNOWN partial result", async () => {
  const fixture = httpFixture();
  const facade = createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    requestJson: async ({ path, body }) => {
      const response = fixture.transport(path, body);
      if (path === LEGACY_LUA_HTTP_ENDPOINTS.effectCandidates) {
        response.payload.kind = "TYPED_UNKNOWN";
        response.payload.result.sourceContentHash = null;
        response.payload.unknownReasons = [{
          phase: "LEGACY_DISCOVERY",
          code: "STATIC_SUBSET_INCOMPLETE",
          message: "a partial candidate set is available",
          evidenceIds: [],
        }];
      }
      return response;
    },
  });
  const source = await facade.resolveLegacyLuaSource("07293697");
  const result = await facade.enumerateLegacyLuaEffectCandidates(source);
  assert.equal(result.kind, "LEGACY_LUA_EFFECT_CANDIDATE_SET");
  assert.equal(result.sourceContentHash, null);
  const envelope = await facade
    .enumerateLegacyLuaEffectCandidatesEnvelope(source);
  assert.equal(envelope.kind, "TYPED_UNKNOWN");
  assert.equal(envelope.verdict, "UNKNOWN");
  assert.equal(envelope.result.sourceContentHash, null);
  assert.equal(envelope.sourceBinding.sourceContentSha256, source.contentHash);
  assert.equal(envelope.unknownReasons[0].code, "STATIC_SUBSET_INCOMPLETE");

  const rejectingFacade = createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    requestJson: async ({ path, body }) => {
      const response = fixture.transport(path, body);
      if (path === LEGACY_LUA_HTTP_ENDPOINTS.effectCandidates) {
        response.payload.kind = "TYPED_UNKNOWN";
        response.payload.result = null;
        response.payload.unknownReasons = [{
          phase: "LEGACY_DISCOVERY",
          code: "NO_PARTIAL_RESULT",
          message: "no partial result is available",
          evidenceIds: [],
        }];
      }
      return response;
    },
  });
  const rejectingSource = await rejectingFacade.resolveLegacyLuaSource(
    "07293697",
  );
  await assert.rejects(
    rejectingFacade.enumerateLegacyLuaEffectCandidates(rejectingSource),
    (error) => error.code === "NO_PARTIAL_RESULT",
  );
});

test("HTTP facade rejects tampered registry and source hashes", async (t) => {
  await t.test("registry digest", async () => {
    const fixture = httpFixture();
    const facade = createLegacyLuaSemanticHttpFacade({
      env: { OCG_ENGINE_URL: "https://engine.example.test" },
      requestJson: async ({ path, body }) => {
        const response = fixture.transport(path, body);
        if (path === LEGACY_LUA_HTTP_ENDPOINTS.capabilities) {
          response.payload.registryBinding.registrySha256 = "0".repeat(64);
        }
        return response;
      },
    });
    await assert.rejects(
      facade.getEngineVersions(),
      (error) => error.code === "LEGACY_LUA_HTTP_BINDING_INVALID",
    );
  });

  await t.test("source content", async () => {
    const fixture = httpFixture();
    const facade = createLegacyLuaSemanticHttpFacade({
      env: { OCG_ENGINE_URL: "https://engine.example.test" },
      requestJson: async ({ path, body }) => {
        const response = fixture.transport(path, body);
        if (path === LEGACY_LUA_HTTP_ENDPOINTS.source) {
          response.payload.result.content += "--tampered";
        }
        return response;
      },
    });
    await assert.rejects(
      facade.resolveLegacyLuaSource("07293697"),
      (error) => error.code === "LEGACY_LUA_HTTP_BINDING_INVALID",
    );
  });
});

test("HTTP facade closes every subsequent source binding field", async (t) => {
  const mutations = [
    ["mode", (binding) => { binding.mode = "LOCKED_PASSCODE"; }],
    ["locator", (binding) => { binding.locator = "tampered://source"; }],
    ["retrievedAt", (binding) => {
      binding.retrievedAt = "2026-08-05T00:00:00.000Z";
    }],
    ["script", (binding) => { binding.script = { sha256: "0".repeat(64) }; }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const fixture = httpFixture();
      const facade = createLegacyLuaSemanticHttpFacade({
        env: { OCG_ENGINE_URL: "https://engine.example.test" },
        requestJson: async ({ path, body }) => {
          const response = fixture.transport(path, body);
          if (path === LEGACY_LUA_HTTP_ENDPOINTS.effectCandidates) {
            mutate(response.payload.sourceBinding);
          }
          return response;
        },
      });
      const source = await facade.resolveLegacyLuaSource("07293697");
      await assert.rejects(
        facade.enumerateLegacyLuaEffectCandidates(source),
        (error) => error.code === "LEGACY_LUA_HTTP_BINDING_INVALID",
      );
    });
  }
});

test("default factory resolves each passcode once and memoizes one run", async () => {
  const sourceCalls = [];
  let collectCalls = 0;
  let observedOptions = null;
  const factory = createDefaultLegacyLuaSemanticPacketFactory({
    facadeFactory: () => ({
      async resolveLegacyLuaSource(passcode) {
        sourceCalls.push(passcode);
        return sourceDocument(passcode);
      },
    }),
    collectPacket: async (options) => {
      collectCalls += 1;
      observedOptions = options;
      return createLegacyLuaUnknownPacket({
        code: "TEST_PACKET",
        message: "test packet",
      });
    },
  });
  const input = {
    cardResolution: {
      resolvedCards: [
        { passcode: "87654321" },
        { passcode: "12345678" },
        { passcode: "12345678" },
      ],
    },
    maxSerializedBytes: 64 * 1024,
  };
  const first = factory(input);
  const second = factory(input);
  assert.equal(first, second);
  const packet = await first;
  validateLegacyLuaSemanticPacket(packet);
  assert.deepEqual(sourceCalls, ["12345678", "87654321"]);
  assert.equal(collectCalls, 1);
  assert.deepEqual(
    observedOptions.inputs.map((item) => item.sourceDocument.passcode),
    ["12345678", "87654321"],
  );
  assert.equal(observedOptions.maxCandidates, 48);
  assert.equal(observedOptions.maxSerializedBytes, 64 * 1024);
});

test("default factory uses locked exact-name identity lookup when no explicit passcode exists", async () => {
  const identityCalls = [];
  const sourceCalls = [];
  const factory = createDefaultLegacyLuaSemanticPacketFactory({
    facadeFactory: () => ({
      async resolveLegacyLuaCardIdentities(cards) {
        identityCalls.push(cards);
        return {
          schemaVersion: "ocg-locked-card-identity-resolution/v1",
          dbSetSha256: RESOURCE_BINDING.dbSetSha256,
          scriptSetSha256: RESOURCE_BINDING.scriptSetSha256,
          matches: cards.map((card) => ({
            clientKey: card.clientKey,
            status: "RESOLVED",
            passcode: "12197223",
            candidates: [{ passcode: "12197223" }],
          })),
        };
      },
      async resolveLegacyLuaSource(passcode) {
        sourceCalls.push(passcode);
        return sourceDocument(passcode);
      },
    }),
    collectPacket: async () => createLegacyLuaUnknownPacket({
      code: "LOCKED_NAME_LOOKUP_TEST",
      message: "locked exact-name lookup reached packet collection",
    }),
  });

  const packet = await factory({
    cardResolution: {
      resolvedCards: [{
        id: "22130",
        name: "天雷之双风神 息那",
        jaName: "天雷ノ双風神 シーナ",
      }],
    },
  });
  assert.equal(packet.unknownReasons[0].code, "LOCKED_NAME_LOOKUP_TEST");
  assert.equal(identityCalls.length, 1);
  assert.deepEqual(sourceCalls, ["12197223"]);
});

test("default factory does not let a duplicate low-information card block a verified passcode", async () => {
  const sourceCalls = [];
  let identityCalls = 0;
  const factory = createDefaultLegacyLuaSemanticPacketFactory({
    facadeFactory: () => ({
      async resolveLegacyLuaCardIdentities() {
        identityCalls += 1;
        throw new Error("duplicate identity lookup must not run");
      },
      async resolveLegacyLuaSource(passcode) {
        sourceCalls.push(passcode);
        return sourceDocument(passcode);
      },
    }),
    collectPacket: async () => createLegacyLuaUnknownPacket({
      code: "DEDUP_REACHED_COLLECTION",
      message: "deduplicated source reached packet collection",
    }),
  });
  const packet = await factory({
    retrievedCards: [{
      id: "22130",
      name: "天雷之双风神 息那",
    }],
    cardResolution: {
      resolvedCards: [{
        cid: "22130",
        passcode: "12197223",
        name: "天雷之双风神 息那",
      }],
    },
  });

  assert.equal(identityCalls, 0);
  assert.deepEqual(sourceCalls, ["12197223"]);
  assert.equal(packet.unknownReasons[0].code, "DEDUP_REACHED_COLLECTION");
});

test("default factory still blocks a genuinely different unresolved card", async () => {
  const identityCalls = [];
  let sourceCalls = 0;
  const factory = createDefaultLegacyLuaSemanticPacketFactory({
    facadeFactory: () => ({
      async resolveLegacyLuaCardIdentities(cards) {
        identityCalls.push(cards);
        return {
          matches: cards.map((card) => ({
            clientKey: card.clientKey,
            status: "NOT_FOUND",
            passcode: null,
            candidates: [],
          })),
        };
      },
      async resolveLegacyLuaSource() {
        sourceCalls += 1;
        throw new Error("unresolved identity must block source collection");
      },
    }),
  });
  const packet = await factory({
    retrievedCards: [
      { id: "22130", name: "天雷之双风神 息那" },
      { id: "22131", name: "真正不同的未知卡" },
    ],
    cardResolution: {
      resolvedCards: [{
        cid: "22130",
        passcode: "12197223",
        name: "天雷之双风神 息那",
      }],
    },
  });

  assert.equal(identityCalls.length, 1);
  assert.deepEqual(identityCalls[0].map((item) => item.names), [
    ["真正不同的未知卡"],
  ]);
  assert.equal(sourceCalls, 0);
  assert.equal(packet.verdict, "UNKNOWN");
  assert.equal(packet.unknownReasons[0].code,
    "LEGACY_LUA_CARD_IDENTITY_UNRESOLVED");
});

test("production gate is zero-network without OCG_ENGINE_URL and injects configured transport", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("network must not run in this unit test");
  };
  assert.equal(createConfiguredLegacyLuaSemanticPacketFactory({
    env: {},
    fetchImpl,
    precomputedCache: null,
  }), null);
  assert.equal(fetchCalls, 0);

  let captured = null;
  const factory = createConfiguredLegacyLuaSemanticPacketFactory({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    fetchImpl,
    precomputedCache: null,
    facadeFactory: (options) => {
      captured = options;
      return {
        async resolveLegacyLuaSource(passcode) {
          return sourceDocument(passcode);
        },
      };
    },
    collectPacket: async () => createLegacyLuaUnknownPacket({
      code: "CONFIGURED_FACTORY_TEST",
      message: "configured factory was injected",
    }),
  });
  assert.equal(typeof factory, "function");
  const packet = await factory({
    cardResolution: { resolvedCards: [{ passcode: "12345678" }] },
  });
  assert.equal(packet.unknownReasons[0].code, "CONFIGURED_FACTORY_TEST");
  assert.equal(captured.fetchImpl, fetchImpl);
  assert.equal(captured.env.OCG_ENGINE_URL,
    "https://engine.example.test");
  assert.equal(fetchCalls, 0);
});

test("production composition uses precomputed evidence before live fallback", async () => {
  let liveCalls = 0;
  const cachedPacket = Object.freeze({
    effectCandidates: Object.freeze([{ fixture: true }]),
  });
  const cachedFactory = () => cachedPacket;
  const factory = createConfiguredLegacyLuaSemanticPacketFactory({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    precomputedCache: { entries: [] },
    precomputedFactory: () => cachedFactory,
    facadeFactory: () => ({
      async resolveLegacyLuaSource() {
        liveCalls += 1;
        throw new Error("live fallback must not run on a static hit");
      },
    }),
  });
  const packet = await factory({
    cardResolution: { resolvedCards: [{ passcode: "12345678" }] },
  });
  assert.equal(packet, cachedPacket);
  assert.equal(liveCalls, 0);
});

test("production composition does not treat a partial static hit as complete", async () => {
  let sourceCalls = 0;
  let mergedPackets = null;
  const cachedPacket = Object.freeze({
    effectCandidates: Object.freeze([{ fixture: "static" }]),
    unknownReasons: Object.freeze([Object.freeze({
      code: "LEGACY_LUA_PRECOMPUTED_COVERAGE_INCOMPLETE",
    })]),
  });
  const livePacket = createLegacyLuaUnknownPacket({
    code: "LIVE_PARTIAL_FIXTURE",
    message: "live side remains partial",
  });
  const mergedPacket = Object.freeze({ fixture: "merged" });
  const factory = createConfiguredLegacyLuaSemanticPacketFactory({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    precomputedCache: { entries: [] },
    precomputedFactory: () => () => cachedPacket,
    facadeFactory: () => ({
      async resolveLegacyLuaSource(passcode) {
        sourceCalls += 1;
        return sourceDocument(passcode);
      },
    }),
    collectPacket: async () => livePacket,
    packetMerger(options) {
      mergedPackets = options.packets;
      return mergedPacket;
    },
  });

  const packet = await factory({
    cardResolution: { resolvedCards: [{ passcode: "12345678" }] },
  });
  assert.equal(sourceCalls, 1);
  assert.deepEqual(mergedPackets, [cachedPacket, livePacket]);
  assert.equal(packet, mergedPacket);
});

test("production composition uses the v2 manifest and lazy shard loader by default", async () => {
  const manifest = { schemaVersion: "fixture-v2-manifest" };
  const loadShard = async () => ({ schemaVersion: "fixture-v2-shard" });
  const cachedPacket = Object.freeze({
    effectCandidates: Object.freeze([{ fixture: "v2" }]),
  });
  let captured = null;
  const factory = createConfiguredLegacyLuaSemanticPacketFactory({
    env: {},
    precomputedManifest: manifest,
    precomputedShardLoader: loadShard,
    shardedPrecomputedFactory(options) {
      captured = options;
      return async () => cachedPacket;
    },
  });

  assert.equal(typeof factory, "function");
  assert.equal(await factory({ cards: [{ cid: "1001" }] }), cachedPacket);
  assert.equal(captured.manifest, manifest);
  assert.equal(captured.loadShard, loadShard);
});

test("production composition falls through a static miss to the live factory", async () => {
  let sourceCalls = 0;
  const factory = createConfiguredLegacyLuaSemanticPacketFactory({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    precomputedCache: { entries: [] },
    precomputedFactory: () => () => createLegacyLuaUnknownPacket({
      code: "STATIC_MISS",
      message: "static miss",
    }),
    facadeFactory: () => ({
      async resolveLegacyLuaSource(passcode) {
        sourceCalls += 1;
        return sourceDocument(passcode);
      },
    }),
    collectPacket: async () => createLegacyLuaUnknownPacket({
      code: "LIVE_FALLBACK",
      message: "live fallback",
    }),
  });
  const packet = await factory({
    cardResolution: { resolvedCards: [{ passcode: "12345678" }] },
  });
  assert.equal(packet.unknownReasons[0].code, "LIVE_FALLBACK");
  assert.equal(sourceCalls, 1);
});

test("missing passcode, card limit, and unavailable endpoint are typed UNKNOWN", async (t) => {
  await t.test("missing passcode does not contact engine", async () => {
    let constructed = false;
    const factory = createDefaultLegacyLuaSemanticPacketFactory({
      facadeFactory: () => {
        constructed = true;
        throw new Error("must not be reached");
      },
    });
    const packet = await factory({
      cardResolution: { resolvedCards: [{ id: "12345678" }] },
    });
    assert.equal(constructed, false);
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.unknownReasons[0].code,
      "LEGACY_LUA_PASSCODE_UNAVAILABLE");
  });

  await t.test("card limit is not silently truncated", async () => {
    const factory = createDefaultLegacyLuaSemanticPacketFactory({ maxCards: 1 });
    const packet = await factory({
      cardResolution: {
        resolvedCards: [
          { passcode: "12345678" },
          { passcode: "87654321" },
        ],
      },
    });
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.unknownReasons[0].code,
      "LEGACY_LUA_CARD_LIMIT_EXCEEDED");
  });

  await t.test("transport failure", async () => {
    const factory = createDefaultLegacyLuaSemanticPacketFactory({
      facadeFactory: () => ({
        async resolveLegacyLuaSource() {
          const error = new Error("connection refused");
          error.code = "LEGACY_LUA_HTTP_UNAVAILABLE";
          throw error;
        },
      }),
    });
    const packet = await factory({
      cardResolution: { resolvedCards: [{ passcode: "12345678" }] },
    });
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.unknownReasons[0].code,
      "LEGACY_LUA_HTTP_UNAVAILABLE");
    assert.equal(packet.unknownReasons[0].details.retryable, true);
  });

  await t.test("hard deadline settles even when a dependency ignores abort", async () => {
    const factory = createDefaultLegacyLuaSemanticPacketFactory({
      timeoutMs: 50,
      facadeFactory: () => ({
        resolveLegacyLuaSource: async () => new Promise(() => {}),
      }),
    });
    const startedAt = Date.now();
    const packet = await factory({
      cardResolution: { resolvedCards: [{ passcode: "12345678" }] },
    });
    assert.equal(packet.verdict, "UNKNOWN");
    assert.equal(packet.unknownReasons[0].code,
      "LEGACY_LUA_PACKET_TIMEOUT");
    assert.equal(Date.now() - startedAt < 500, true);
  });
});

function httpFixture() {
  const versions = {
    engineVersion: "ocg-formal-engine/test",
    irVersion: "ocg-effect-ir/v1",
    rulesetVersion: "ocg-ruleset/test",
    schemaVersion: "ocg-formal-engine/v1",
    compilerVersion: "ocg-card-compiler/v1",
    patternLibraryVersion: "ocg-pattern-library/v1",
    proofVerifierVersion: "ocg-proof-verifier/v1",
    artifacts: {},
  };
  const capabilities = {
    schemaVersion: "ocg-capability-manifest/v1",
    capabilities: [],
  };
  const registry = {
    schemaVersion: "ocg-lua-api-semantics-registry/v2",
    registryId: "formal:test-registry:v2",
    registryVersion: "2.0.0-test",
    authority: "LEGACY_DISCOVERY_ONLY",
    legacyAcceptedAsTruth: false,
    compatibilityEvidence: {
      pinnedCoreRepository: "https://example.test/core.git",
      pinnedCoreCommit: "a".repeat(40),
      pinnedCoreApiAbi: "ocgcore/test",
    },
    luaApis: [],
    operationDependencyGraphs: {},
  };
  const source = sourceDocument("07293697");
  const engineBinding = {
    versions,
    versionsSha256: canonicalLegacyLuaSha256(versions),
    capabilityManifestSha256: canonicalLegacyLuaSha256(capabilities),
    requiredCapabilities: [],
  };
  const registryBinding = {
    schemaVersion: registry.schemaVersion,
    registryId: registry.registryId,
    registryVersion: registry.registryVersion,
    registrySha256: canonicalLegacyLuaSha256(registry),
    authority: "LEGACY_DISCOVERY_ONLY",
    legacyAcceptedAsTruth: false,
    pinnedCoreRepository: registry.compatibilityEvidence.pinnedCoreRepository,
    pinnedCoreCommit: registry.compatibilityEvidence.pinnedCoreCommit,
    pinnedCoreApiAbi: registry.compatibilityEvidence.pinnedCoreApiAbi,
  };
  const endpoints = {
    cardIdentities: endpoint("cardIdentities"),
    source: endpoint("source"),
    effectCandidates: endpoint("effectCandidates"),
    compilePlan: endpoint("compilePlan"),
    analyzeActivation: endpoint("analyzeActivation"),
  };
  const common = {
    ok: true,
    authority: "LEGACY_DISCOVERY_ONLY",
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    verdict: "UNKNOWN",
    resourceBinding: RESOURCE_BINDING,
    engineBinding,
    registryBinding,
  };
  return {
    versions,
    capabilities,
    registry,
    source,
    transport(path, body) {
      let payload;
      if (path === LEGACY_LUA_HTTP_ENDPOINTS.capabilities) {
        payload = {
          ...common,
          schemaVersion: "ocg-legacy-lua-http-capabilities/v1",
          kind: "LEGACY_LUA_HTTP_CAPABILITIES",
          capabilityManifest: capabilities,
          apiSemanticsRegistry: registry,
          sourceResolution: {
            sourceDocument: true,
            lockedPasscode: true,
            lockedExactCardNames: true,
            passcodeMapping: "c{uint32-passcode}.lua",
            selectedScriptVerification: ["sha256", "size", "resourceBinding"],
          },
          endpoints,
        };
      } else if (path === LEGACY_LUA_HTTP_ENDPOINTS.cardIdentities) {
        payload = {
          ...common,
          schemaVersion: "ocg-legacy-lua-http-card-identities/v1",
          kind: "COMPLETED",
          operation: "RESOLVE_CARD_IDENTITIES",
          sourceBinding: null,
          result: {
            schemaVersion: "ocg-locked-card-identity-resolution/v1",
            dbSetSha256: RESOURCE_BINDING.dbSetSha256,
            scriptSetSha256: RESOURCE_BINDING.scriptSetSha256,
            matches: [{
              clientKey: "card-1",
              status: "RESOLVED",
              passcode: "12197223",
              candidates: [{
                passcode: "12197223",
                matchedNames: ["天雷ノ双風神 シーナ"],
                queryNames: ["天雷ノ双風神 シーナ"],
              }],
            }],
          },
          unknownReasons: [],
        };
      } else if (path === LEGACY_LUA_HTTP_ENDPOINTS.source) {
        const resolvedSource = body?.passcode
          ? sourceDocument(body.passcode)
          : source;
        payload = {
          ...common,
          schemaVersion: "ocg-legacy-lua-http-source/v1",
          kind: "COMPLETED",
          operation: "RESOLVE_SOURCE",
          sourceBinding: lockedSourceBinding(resolvedSource),
          result: resolvedSource,
          unknownReasons: [],
        };
      } else if (path === LEGACY_LUA_HTTP_ENDPOINTS.effectCandidates) {
        payload = {
          ...common,
          schemaVersion: "ocg-legacy-lua-http-effect-candidates/v1",
          kind: "COMPLETED",
          operation: "EFFECT_CANDIDATES",
          sourceBinding: directSourceBinding(source),
          result: {
            kind: "LEGACY_LUA_EFFECT_CANDIDATE_SET",
            candidates: [{}],
          },
          unknownReasons: [],
        };
      } else {
        throw new Error(`unexpected path ${path}`);
      }
      return {
        status: "response",
        ok: true,
        responseOk: true,
        httpStatus: 200,
        payload: structuredClone(payload),
      };
    },
  };
}

function endpoint(name) {
  const schemas = {
    cardIdentities: "ocg-legacy-lua-http-card-identities/v1",
    source: "ocg-legacy-lua-http-source/v1",
    effectCandidates: "ocg-legacy-lua-http-effect-candidates/v1",
    compilePlan: "ocg-legacy-lua-http-compile-plan/v1",
    analyzeActivation: "ocg-legacy-lua-http-analyze-activation/v1",
  };
  return {
    path: LEGACY_LUA_HTTP_ENDPOINTS[name],
    method: "POST",
    responseSchemaVersion: schemas[name],
  };
}

function sourceDocument(passcode) {
  const content = `-- ${passcode}\nreturn true\n`;
  return {
    schemaVersion: "ocg-source-document/v1",
    sourceDocumentId: `legacy:test:${passcode}`,
    sourceType: "LEGACY_SCRIPT",
    authority: "LEGACY_COMPATIBILITY",
    rulesetVersion: "ocg-ruleset/test",
    documentVersion: "6".repeat(64),
    effectiveDate: "2026-08-04",
    language: "lua",
    content,
    contentHash: rawSha256(content),
    provenance: {
      locator: `resource-lock://test/scripts/c${Number(passcode)}.lua`,
      retrievedAt: "2026-08-04T00:00:00.000Z",
      publisher: "TEST",
    },
    passcode,
  };
}

function directSourceBinding(source) {
  return {
    mode: "SOURCE_DOCUMENT",
    sourceDocumentId: source.sourceDocumentId,
    sourceContentSha256: source.contentHash,
    documentVersion: source.documentVersion,
    locator: source.provenance.locator,
    retrievedAt: source.provenance.retrievedAt,
    script: null,
  };
}

function lockedSourceBinding(source) {
  return {
    ...directSourceBinding(source),
    mode: "LOCKED_PASSCODE",
    script: {
      passcode: String(Number(source.passcode)),
      fileName: `c${Number(source.passcode)}.lua`,
      key: null,
      resourcePath: null,
      sha256: source.contentHash,
      size: Buffer.byteLength(source.content),
      scriptSetSha256: RESOURCE_BINDING.scriptSetSha256,
      lockId: RESOURCE_BINDING.lockId,
      snapshotId: RESOURCE_BINDING.snapshotId,
    },
  };
}

function rawSha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
