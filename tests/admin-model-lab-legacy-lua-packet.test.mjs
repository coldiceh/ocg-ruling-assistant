import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminModelLabService,
} from "../backend/adminModelLabService.mjs";
import {
  createMemoryAdminFinalCallBudgetLedger,
} from "../backend/adminFinalCallBudgetLedger.mjs";
import {
  createLegacyLuaUnknownPacket,
  projectLegacyLuaSemanticPacketForModel,
  serializeLegacyLuaSemanticPacket,
  validateLegacyLuaSemanticPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";
import {
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "../backend/adminRunStore.mjs";
import { MODEL_RULING_COUNTER_CHECK_TYPES } from "../backend/modelRulingSchema.mjs";

test("model-lab freezes one non-authoritative Lua packet and reuses its exact bytes for every fork", async () => {
  let packetCalls = 0;
  const packet = createLegacyLuaUnknownPacket({
    code: "TEST_DISCOVERY_ONLY",
    message: "test-side legacy discovery packet",
    details: { expectedCheck: "RETURN_TO_HAND" },
  });
  const fixture = makeService({
    legacyLuaSemanticPacketFactory: async (input) => {
      packetCalls += 1;
      assert.equal(input.question, "匿名规则问题");
      assert.equal(input.cardResolution.resolvedCards[0].id, "card-a");
      assert.equal(input.cardResolution.resolvedCards[0].passcode, undefined);
      assert.equal(input.retrievedCards[0].passcode, "12345678");
      assert.equal(input.maxSerializedBytes, 192 * 1024);
      assert.equal(input.signal.aborted, false);
      return packet;
    },
  });

  const created = await fixture.service.createRun({
    body: finalModelBody("匿名规则问题"),
  });
  const sourceExecution = await fixture.service.executeRun({ runId: created.runId });
  const source = sourceExecution.run;
  assert.equal(source.status, "SUCCEEDED", JSON.stringify(source.error));
  assert.equal(packetCalls, 1);

  const frozenPacket = source.evidenceSnapshot.evidence.legacyLuaSemanticPacket;
  validateLegacyLuaSemanticPacket(frozenPacket);
  assert.equal(frozenPacket.authority, "LEGACY_COMPATIBILITY");
  assert.equal(frozenPacket.canConfirmOfficialRuling, false);
  assert.equal(frozenPacket.legacyAcceptedAsTruth, false);
  assert.equal(frozenPacket.verdict, "UNKNOWN");
  assert.equal(Object.isFrozen(frozenPacket), true);
  assert.equal(serializeLegacyLuaSemanticPacket(frozenPacket), serializeLegacyLuaSemanticPacket(packet));
  assert.doesNotMatch(
    JSON.stringify(source.evidenceSnapshot.evidence.evidenceDecisionPacket),
    new RegExp(frozenPacket.packetId, "u"),
  );

  const sourceInput = JSON.parse(fixture.providerCalls[0].input.split("\n").at(-1));
  assert.deepEqual(
    sourceInput.legacyLuaSemanticPacket,
    projectLegacyLuaSemanticPacketForModel(frozenPacket),
  );
  assert.equal(
    Object.hasOwn(sourceInput.legacyLuaSemanticPacket, "sourceDocuments"),
    false,
  );
  assert.match(fixture.providerCalls[0].input, /candidateVerdict 不能直接支持结论/u);
  assert.match(fixture.providerCalls[0].input, /不能加入 evidenceIds/u);

  const fork = await fixture.service.forkRun({
    forkFromRunId: source.runId,
    body: {
      idempotencyKey: "legacy-lua-frozen-fork-0001",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
      reasoningMode: "pro",
    },
  });
  assert.deepEqual(fork.evidenceSnapshot, source.evidenceSnapshot);
  assert.equal(fork.evidenceSnapshot.contentSha256, source.evidenceSnapshot.contentSha256);
  assert.equal(
    fork.metadata.fork.sourceLegacyLuaSemanticPacketSha256,
    frozenPacket.packetSha256,
  );
  await fixture.service.executeRun({ runId: fork.runId });

  assert.equal(packetCalls, 1, "a frozen-evidence fork must never call the Lua collector");
  assert.equal(fixture.providerCalls.length, 2);
  assert.equal(fixture.providerCalls[0].input, fixture.providerCalls[1].input);
  const forkInput = JSON.parse(fixture.providerCalls[1].input.split("\n").at(-1));
  assert.deepEqual(
    forkInput.legacyLuaSemanticPacket,
    projectLegacyLuaSemanticPacketForModel(frozenPacket),
  );
});

test("model-lab freezes typed UNKNOWN when Lua collection is unsupported", async () => {
  const fixture = makeService();
  const created = await fixture.service.createRun({ body: finalModelBody("不支持的 Lua 问题") });
  const execution = await fixture.service.executeRun({ runId: created.runId });
  const packet = execution.run.evidenceSnapshot.evidence.legacyLuaSemanticPacket;

  validateLegacyLuaSemanticPacket(packet);
  assert.equal(packet.verdict, "UNKNOWN");
  assert.equal(
    packet.unknownReasons.some((reason) => reason.code === "LEGACY_LUA_SEMANTIC_UNSUPPORTED"),
    true,
  );
});

test("model-lab times out a non-resolving Lua collector as typed UNKNOWN without failing the ruling run", async () => {
  let collectorSignal = null;
  const fixture = makeService({
    legacyLuaSemanticTimeoutMs: 10,
    legacyLuaSemanticPacketFactory: async ({ signal }) => {
      collectorSignal = signal;
      return new Promise(() => {});
    },
  });
  const created = await fixture.service.createRun({ body: finalModelBody("超时的 Lua 问题") });
  const execution = await fixture.service.executeRun({ runId: created.runId });
  const packet = execution.run.evidenceSnapshot.evidence.legacyLuaSemanticPacket;

  assert.equal(execution.run.status, "SUCCEEDED", JSON.stringify(execution.run.error));
  validateLegacyLuaSemanticPacket(packet);
  assert.equal(collectorSignal.aborted, true);
  assert.equal(
    packet.unknownReasons.some((reason) => reason.code === "LEGACY_LUA_SEMANTIC_TIMEOUT"),
    true,
  );
});

test("model-lab rejects an oversized Lua packet before final-input serialization", async () => {
  let observedLimit = null;
  const fixture = makeService({
    legacyLuaSemanticMaxBytes: 1_024,
    legacyLuaSemanticPacketFactory: async ({ maxSerializedBytes }) => {
      observedLimit = maxSerializedBytes;
      return createLegacyLuaUnknownPacket({
        code: "OVERSIZED_TEST_PACKET",
        message: "x".repeat(4_096),
      });
    },
  });
  const created = await fixture.service.createRun({ body: finalModelBody("超大 Lua 包问题") });
  const execution = await fixture.service.executeRun({ runId: created.runId });
  const packet = execution.run.evidenceSnapshot.evidence.legacyLuaSemanticPacket;

  assert.equal(execution.run.status, "SUCCEEDED", JSON.stringify(execution.run.error));
  assert.equal(observedLimit, 1_024);
  validateLegacyLuaSemanticPacket(packet);
  assert.equal(
    packet.unknownReasons.some(
      (reason) => reason.code === "LEGACY_LUA_SEMANTIC_PACKET_TOO_LARGE",
    ),
    true,
  );
  assert.equal(
    Buffer.byteLength(serializeLegacyLuaSemanticPacket(packet), "utf8") < 1_024,
    true,
  );
});

function makeService({
  legacyLuaSemanticPacketFactory = null,
  legacyLuaSemanticTimeoutMs = 100,
  legacyLuaSemanticMaxBytes,
} = {}) {
  const providerCalls = [];
  const runStore = createAdminRunStore({
    storage: createMemoryAdminRunStorage(),
  });
  const service = createAdminModelLabService({
    runStore,
    finalCallBudgetLedger: createMemoryAdminFinalCallBudgetLedger({
      timezone: "UTC",
      pools: {
        deepseek: { dailyBudgetCny: 1_000, reservationCny: 10 },
      },
    }),
    env: {
      ADMIN_MODEL_LAB_ENABLED: "true",
      DEEPSEEK_API_KEY: "server-only-test-key",
      ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "test-deepseek-v4",
      ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2026-08-06",
      ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "1",
      ADMIN_MODEL_LAB_DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "2",
      ADMIN_MODEL_LAB_DEEPSEEK_PRO_INPUT_CNY_PER_MTOK: "3",
      ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK: "6",
    },
    finalRulingProviders: {
      deepseek: {
        providerId: "deepseek",
        async create(request) {
          providerCalls.push(request);
          return {
            id: `deepseek-test-${providerCalls.length}`,
            status: "completed",
            model: request.model,
            output_text: JSON.stringify(structuredRuling()),
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          };
        },
      },
    },
    loadData: async () => ({
      cards: [{ id: "card-a", name: "匿名卡A", text: "匿名效果全文" }],
      records: [],
      qaRecords: [{ id: "qa-direct", text: "可以处理。" }],
    }),
    extractCards: () => ({
      resolvedCards: [{ id: "card-a", name: "匿名卡A", text: "匿名效果全文" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
      omittedResolvedCards: [],
      userProvidedCardTexts: [],
    }),
    retrieveEvidence: async () => ({
      cardTexts: [{
        id: "card-text-a",
        type: "card_text",
        sourceType: "card_text",
        text: "匿名效果全文",
      }],
      userProvidedCardTexts: [],
      officialQaDirectCandidates: [{
        id: "qa-direct",
        type: "official_qa",
        sourceType: "official_qa",
        text: "可以处理。",
        isDirect: true,
        current: true,
      }],
      officialQaRelated: [],
      provisionalOfficialResponses: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      rulebookCandidates: [],
      retrievedCards: [{
        id: "card-a",
        passcode: "12345678",
        name: "匿名卡A",
      }],
      remainingUnresolvedMentions: [],
      fuzzyResolvedCards: [],
      baigeResolvedCards: [],
      baigeAmbiguousMentions: [],
      ruleSearchQueries: [],
      retrievalWarnings: [],
    }),
    promptLoader: async () => "只依据冻结资料输出严格 JSON。",
    legacyLuaSemanticPacketFactory,
    legacyLuaSemanticTimeoutMs,
    legacyLuaSemanticMaxBytes,
  });
  return { service, providerCalls };
}

function finalModelBody(question) {
  return {
    question,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "none",
    reasoningMode: "standard",
  };
}

function structuredRuling() {
  return {
    schemaVersion: "1.0",
    verdicts: [{
      questionId: "q1",
      value: "TRUE",
      conclusion: "可以处理。",
      conditions: [],
    }],
    conciseAnswer: "可以处理。",
    claims: [{
      claimId: "claim-1",
      proposition: "该操作可以处理。",
      status: "TRUE",
      decisive: true,
      evidenceIds: ["qa-direct"],
      inferenceType: "DIRECT_OFFICIAL",
    }],
    timeline: [{
      order: 1,
      action: "检查处理",
      result: "可以处理。",
      evidenceIds: ["qa-direct"],
    }],
    assumptions: [],
    evidenceUsage: [{
      evidenceId: "qa-direct",
      relation: "DIRECTLY_ENTAILS",
      supportedClaimIds: ["claim-1"],
    }],
    counterChecks: MODEL_RULING_COUNTER_CHECK_TYPES.map((type) => ({
      type,
      passed: true,
      note: "",
    })),
    unresolved: [],
    confidence: {
      level: "HIGH",
      reasons: ["存在直接证据。"],
    },
  };
}
