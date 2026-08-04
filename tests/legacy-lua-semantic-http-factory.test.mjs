import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LEGACY_LUA_HTTP_ENDPOINTS,
  createLegacyLuaSemanticHttpFacade,
} from "../backend/legacyLuaSemanticHttpFacade.mjs";
import {
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

test("passcode discovery accepts only explicit non-zero 8-digit passwords", () => {
  assert.deepEqual(collectEffectiveLegacyLuaPasscodes({
    cardResolution: {
      resolvedCards: [
        { id: "21385", cardId: "21385", passcode: "12345678" },
        { passcode: "07293697" },
        { passcode: "12345678" },
        { passcode: "00000000" },
        { passcode: "1234" },
        { id: "87654321" },
      ],
    },
    retrievedCards: [
      { password: "23456789" },
      { raw: { passcode: "34567890" } },
    ],
  }), ["07293697", "12345678", "23456789", "34567890"]);
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

test("HTTP facade preserves a bound TYPED_UNKNOWN partial result", async () => {
  const fixture = httpFixture();
  const facade = createLegacyLuaSemanticHttpFacade({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    requestJson: async ({ path, body }) => {
      const response = fixture.transport(path, body);
      if (path === LEGACY_LUA_HTTP_ENDPOINTS.effectCandidates) {
        response.payload.kind = "TYPED_UNKNOWN";
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

test("production gate is zero-network without OCG_ENGINE_URL and injects configured transport", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("network must not run in this unit test");
  };
  assert.equal(createConfiguredLegacyLuaSemanticPacketFactory({
    env: {},
    fetchImpl,
  }), null);
  assert.equal(fetchCalls, 0);

  let captured = null;
  const factory = createConfiguredLegacyLuaSemanticPacketFactory({
    env: { OCG_ENGINE_URL: "https://engine.example.test" },
    fetchImpl,
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
    transport(path) {
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
            passcodeMapping: "c{uint32-passcode}.lua",
            selectedScriptVerification: ["sha256", "size", "resourceBinding"],
          },
          endpoints,
        };
      } else if (path === LEGACY_LUA_HTTP_ENDPOINTS.source) {
        payload = {
          ...common,
          schemaVersion: "ocg-legacy-lua-http-source/v1",
          kind: "COMPLETED",
          operation: "RESOLVE_SOURCE",
          sourceBinding: lockedSourceBinding(source),
          result: source,
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
