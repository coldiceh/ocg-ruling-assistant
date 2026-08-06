import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminModelLabDevelopmentService,
  createAdminModelLabProductionService,
  createDeepSeekEvidencePreparationInvoke,
} from "../backend/adminModelLabProduction.mjs";
import { createAdminModelLabService } from "../backend/adminModelLabService.mjs";
import { createMemoryAdminFinalCallBudgetLedger } from "../backend/adminFinalCallBudgetLedger.mjs";
import { createMemoryAdminLabRecordStore } from "../backend/adminLabRecordStore.mjs";
import {
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "../backend/adminRunStore.mjs";
import {
  callDeepSeekJsonTask,
  getRagBudgetStatus,
  resetRagBudget,
} from "../backend/ragModelClient.mjs";

const ENABLED_ENV = Object.freeze({
  ADMIN_MODEL_LAB_ENABLED: "true",
  ADMIN_OPENAI_ENABLED: "true",
});

test("production model lab is disabled by default and never falls back to memory", () => {
  assert.throws(
    () => createAdminModelLabProductionService({
      env: {},
      fetchImpl: async () => {
        throw new Error("network must not run");
      },
      baseService: fakeBaseService(),
      recordStore: createMemoryAdminLabRecordStore(),
    }),
    (error) => error.code === "admin_model_lab_production_unavailable"
      && /ADMIN_MODEL_LAB_ENABLED/u.test(error.message),
  );
});

test("production composition registers runs and exposes persistent record capabilities", async () => {
  const recordStore = persistentRecordStore();
  const service = createAdminModelLabProductionService({
    env: ENABLED_ENV,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    baseService: fakeBaseService(),
    recordStore,
    evaluationLoader: async () => ({
      schemaVersion: "1",
      fixtureName: "fixture",
      purpose: "test",
      cases: [],
    }),
  });

  const capabilities = await service.capabilities();
  assert.equal(capabilities.features.history, true);
  assert.equal(capabilities.features.rating, true);
  assert.equal(capabilities.features.export, true);
  assert.equal(capabilities.features.evaluation, true);
  assert.equal(capabilities.features.forkRun, true);
  assert.equal(capabilities.architecture.sharedEvidenceSnapshotFork, true);
  assert.equal(capabilities.persistence.recordStore, "persistent");
  assert.equal(capabilities.persistence.runStore, "persistent");

  const run = await service.createRun({ body: { question: "测试问题" } });
  assert.equal(run.runId, "run-production-1");
  const fork = await service.forkRun({
    forkFromRunId: run.runId,
    body: { idempotencyKey: "production-fork-key-0001" },
  });
  assert.equal(fork.runId, run.runId);
  const history = await service.listRuns({ limit: 10 });
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].question, "测试问题");
  assert.equal(history.records[0].configuration.finalRuling.model, "gpt-5.6-terra");
  assert.equal(history.records[0].forkProvenance.sourceRunId, "source-production-1");
  assert.equal(history.records[0].repairProvenance.outcome, "succeeded");

  await service.saveRating({
    runId: run.runId,
    rating: "needs_review",
    notes: "等待真实模型测试",
  });
  const exported = await service.exportRuns({ runId: run.runId, format: "json" });
  assert.equal(exported.format, "json");
  assert.match(exported.content, /needs_review/u);
  const exportRecord = JSON.parse(exported.content).records[0];
  assert.equal(exportRecord.status, "SUCCEEDED");
  assert.equal(exportRecord.evidenceSnapshotId, "evidence-production-1");
  assert.equal(exportRecord.evidenceSnapshotSha256, "a".repeat(64));
  assert.equal(exportRecord.decisionPacketId, "decision_packet_production_1");
  assert.equal(exportRecord.decisionPacketSha256, "b".repeat(64));
  assert.equal(exportRecord.forkProvenance.sourceRunId, "source-production-1");
  assert.equal(exportRecord.modelConfig.finalRuling.model, "gpt-5.6-terra");
  assert.equal(exportRecord.result.finalRuling.conciseAnswer, "测试裁定。");
  assert.equal(exportRecord.metering.totals.usage.totalTokens, 180);
  assert.equal(exportRecord.repairProvenance.submission.requestId, "repair-production-1");

  const fullExport = await service.exportRuns({ format: "json" });
  assert.equal(JSON.parse(fullExport.content).records[0].result.validation.ok, true);
});

test("export and rating repair a confirmed history record deleted after cache confirmation", async () => {
  const recordStore = deletablePersistentRecordStore();
  const service = createAdminModelLabProductionService({
    env: ENABLED_ENV,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    baseService: fakeBaseService(),
    recordStore,
  });
  const run = await service.createRun({ body: { question: "测试问题" } });
  assert.equal(recordStore.registrationCalls(), 1);

  recordStore.deleteRecord(run.runId);
  const exported = await service.exportRuns({ runId: run.runId, format: "json" });
  assert.equal(JSON.parse(exported.content).records[0].runId, run.runId);
  assert.equal(recordStore.registrationCalls(), 2);

  recordStore.deleteRecord(run.runId);
  const rating = await service.saveRating({
    runId: run.runId,
    rating: "correct",
    notes: "删除后重新登记",
  });
  assert.equal(rating.rating, "correct");
  assert.equal(recordStore.registrationCalls(), 3);
});

test("production creation returns the durable run and repairs history after a lost register response", async () => {
  const innerRecordStore = createMemoryAdminLabRecordStore();
  let registrationCalls = 0;
  const recordStore = Object.freeze({
    ...innerRecordStore,
    kind: "test-persistent-flaky",
    persistent: true,
    async registerRun(input) {
      registrationCalls += 1;
      const registered = await innerRecordStore.registerRun(input);
      if (registrationCalls === 1) {
        const error = new Error("simulated timeout containing server-secret");
        error.code = "admin_lab_record_redis_timeout";
        throw error;
      }
      return registered;
    },
  });
  const baseService = fakeBaseService();
  const originalCreateRun = baseService.createRun.bind(baseService);
  let createCalls = 0;
  baseService.createRun = async (...args) => {
    createCalls += 1;
    return originalCreateRun(...args);
  };
  const service = createAdminModelLabProductionService({
    env: ENABLED_ENV,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    baseService,
    recordStore,
    evaluationLoader: async () => ({
      schemaVersion: "1",
      fixtureName: "fixture",
      purpose: "test",
      cases: [],
    }),
  });

  const created = await service.createRun({ body: { question: "测试问题" } });
  assert.equal(created.runId, "run-production-1");
  assert.equal(created.historyRegistration.status, "pending");
  assert.equal(created.historyRegistration.retryable, true);
  assert.equal(
    created.historyRegistration.errorCode,
    "admin_lab_record_redis_timeout",
  );
  assert.equal(JSON.stringify(created).includes("server-secret"), false);
  assert.equal(createCalls, 1);
  assert.equal(registrationCalls, 1);

  const repaired = await service.getRun({
    runId: created.runId,
    reconcile: false,
  });
  assert.equal(Object.hasOwn(repaired, "historyRegistration"), false);
  assert.equal(createCalls, 1);
  assert.equal(registrationCalls, 2);
  const history = await service.listRuns({ limit: 10 });
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].runId, created.runId);
});

test("production composition accepts the real base service when its run store is persistent", async () => {
  const persistentRunStorage = Object.freeze({
    ...createMemoryAdminRunStorage(),
    kind: "test-persistent-run-storage",
    persistent: true,
  });
  const service = createAdminModelLabProductionService({
    env: ENABLED_ENV,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    recordStore: persistentRecordStore(),
    runStore: createAdminRunStore({ storage: persistentRunStorage }),
    deepSeekProvider: {},
    openAIProvider: {
      providerId: "openai",
      async create() {
        throw new Error("final provider must not run during createRun");
      },
    },
    evaluationLoader: async () => ({
      schemaVersion: "1",
      fixtureName: "fixture",
      purpose: "test",
      cases: [],
    }),
  });

  const capabilities = await service.capabilities();
  assert.equal(capabilities.persistence.runStore, "persistent");
  assert.equal(capabilities.persistence.runStoreKind, "test-persistent-run-storage");
});

test("production composition exposes an explicitly persistent final-call budget ledger", async () => {
  const persistentRunStorage = Object.freeze({
    ...createMemoryAdminRunStorage(),
    kind: "test-persistent-run-storage",
    persistent: true,
  });
  const service = createAdminModelLabProductionService({
    env: ENABLED_ENV,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    recordStore: persistentRecordStore(),
    runStore: createAdminRunStore({ storage: persistentRunStorage }),
    finalCallBudgetLedger: persistentBudgetLedger(),
    deepSeekProvider: {},
    openAIProvider: {
      providerId: "openai",
      async create() {
        throw new Error("final provider must not run during capability inspection");
      },
    },
  });

  const capabilities = await service.capabilities();
  assert.equal(capabilities.architecture.finalCallBudget.configured, true);
  assert.equal(capabilities.architecture.finalCallBudget.persistent, true);
  assert.equal(
    capabilities.architecture.finalCallBudget.storageKind,
    "test-persistent-final-budget",
  );
  assert.deepEqual(capabilities.architecture.finalCallBudget.pools, []);
});

test("production without a budget ledger fails closed before final provider transport", async () => {
  const persistentRunStorage = Object.freeze({
    ...createMemoryAdminRunStorage(),
    kind: "test-persistent-run-storage",
    persistent: true,
  });
  let providerCreateCalls = 0;
  const baseService = createAdminModelLabService({
    runStore: createAdminRunStore({ storage: persistentRunStorage }),
    finalCallBudgetLedger: null,
    env: {
      ...ENABLED_ENV,
      OPENAI_API_KEY: "server-only-test-key",
    },
    openAIProvider: {
      providerId: "openai",
      async create() {
        providerCreateCalls += 1;
        throw new Error("provider transport must be blocked by the missing budget ledger");
      },
    },
    loadData: async () => ({ cards: [], records: [], qaRecords: [] }),
    extractCards: () => ({
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      omittedResolvedCards: [],
      userProvidedCardTexts: [],
    }),
    retrieveEvidence: async () => ({
      cardTexts: [],
      userProvidedCardTexts: [],
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      provisionalOfficialResponses: [],
      faqRelated: [],
      rawRelatedEvidence: [],
      rulebookCandidates: [],
      retrievedCards: [],
      remainingUnresolvedMentions: [],
      fuzzyResolvedCards: [],
      baigeResolvedCards: [],
      baigeAmbiguousMentions: [],
      ruleSearchQueries: [],
      retrievalWarnings: [],
    }),
    promptLoader: async () => "只依据冻结证据输出严格 JSON。",
  });
  const service = createAdminModelLabProductionService({
    env: ENABLED_ENV,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    baseService,
    recordStore: persistentRecordStore(),
  });
  const created = await service.createRun({ body: { question: "匿名预算门禁问题" } });

  const execution = await service.executeRun({ runId: created.runId });

  assert.equal(execution.run.status, "FAILED");
  assert.equal(execution.run.error.code, "admin_final_budget_storage_unavailable");
  assert.equal(providerCreateCalls, 0);
});

test("production composition rejects every ephemeral storage injection and memory env mode", () => {
  const ephemeralRecordStore = createMemoryAdminLabRecordStore();
  assert.throws(
    () => createAdminModelLabProductionService({
      env: ENABLED_ENV,
      fetchImpl: async () => null,
      baseService: fakeBaseService(),
      recordStore: ephemeralRecordStore,
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /record store must be persistent/u.test(error.message),
  );

  const durableRecordStore = persistentRecordStore();
  assert.throws(
    () => createAdminModelLabProductionService({
      env: { ...ENABLED_ENV, ADMIN_RUN_STORAGE: "memory" },
      fetchImpl: async () => null,
      recordStore: durableRecordStore,
    }),
    (error) => error?.code === "admin_run_memory_forbidden",
  );
  assert.throws(
    () => createAdminModelLabProductionService({
      env: { ...ENABLED_ENV, ADMIN_LAB_RECORD_STORAGE: "memory" },
      fetchImpl: async () => null,
    }),
    (error) => error?.code === "admin_lab_record_memory_forbidden",
  );
  assert.throws(
    () => createAdminModelLabProductionService({
      env: ENABLED_ENV,
      fetchImpl: async () => null,
      recordStore: durableRecordStore,
      runStorage: createMemoryAdminRunStorage(),
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /run storage must be persistent/u.test(error.message),
  );
  assert.throws(
    () => createAdminModelLabProductionService({
      env: ENABLED_ENV,
      fetchImpl: async () => null,
      recordStore: durableRecordStore,
      runStore: createAdminRunStore({ storage: createMemoryAdminRunStorage() }),
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /run store must be persistent/u.test(error.message),
  );
  assert.throws(
    () => createAdminModelLabProductionService({
      env: ENABLED_ENV,
      fetchImpl: async () => null,
      recordStore: durableRecordStore,
      baseService: fakeBaseService({ persistent: false }),
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /base service run store must be persistent/u.test(error.message),
  );
  const ephemeralBudgetBaseService = fakeBaseService();
  ephemeralBudgetBaseService.persistence.finalCallBudgetConfigured = true;
  ephemeralBudgetBaseService.persistence.finalCallBudgetPersistent = false;
  ephemeralBudgetBaseService.persistence.finalCallBudgetKind = "memory-admin-final-budget";
  assert.throws(
    () => createAdminModelLabProductionService({
      env: ENABLED_ENV,
      fetchImpl: async () => null,
      recordStore: durableRecordStore,
      baseService: ephemeralBudgetBaseService,
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /base service final-call budget ledger must be persistent/u.test(error.message),
  );
  assert.throws(
    () => createAdminModelLabProductionService({
      env: ENABLED_ENV,
      fetchImpl: async () => null,
      recordStore: durableRecordStore,
      runStore: createAdminRunStore({
        storage: Object.freeze({
          ...createMemoryAdminRunStorage(),
          kind: "test-persistent-run-storage",
          persistent: true,
        }),
      }),
      finalCallBudgetLedger: createMemoryAdminFinalCallBudgetLedger({
        pools: {
          openai: { dailyBudgetCny: 10, reservationCny: 10 },
        },
      }),
      deepSeekProvider: {},
      openAIProvider: {},
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /final-call budget ledger must be persistent/u.test(error.message),
  );
});

test("explicit local development composition works without Redis but is forbidden in production", async () => {
  const service = createAdminModelLabDevelopmentService({
    env: {
      ...ENABLED_ENV,
      NODE_ENV: "development",
      ADMIN_FINAL_BUDGET_OPENAI_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_OPENAI_RESERVATION_CNY: "10",
    },
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    deepSeekProvider: {},
    openAIProvider: {
      providerId: "openai",
      async create() {
        throw new Error("final provider must not run during createRun");
      },
    },
    evaluationLoader: async () => ({
      schemaVersion: "1",
      fixtureName: "fixture",
      purpose: "test",
      cases: [],
    }),
  });

  const capabilities = await service.capabilities();
  assert.equal(capabilities.persistence.runStore, "ephemeral");
  assert.equal(capabilities.persistence.recordStore, "ephemeral");
  assert.equal(capabilities.architecture.finalCallBudget.configured, true);
  assert.equal(capabilities.architecture.finalCallBudget.persistent, false);
  assert.equal(
    capabilities.architecture.finalCallBudget.storageKind,
    "memory-admin-final-budget",
  );
  assert.ok(Array.isArray(capabilities.architecture.finalCallBudget.pools));
  assert.equal(
    capabilities.architecture.finalCallBudget.pools
      .find((pool) => pool.pool === "openai")?.available,
    true,
  );
  const run = await service.createRun({ body: { question: "本地开发问题" } });
  assert.equal(run.status, "QUEUED");
  assert.equal((await service.listRuns({ limit: 10 })).records.length, 1);

  assert.throws(
    () => createAdminModelLabDevelopmentService({
      env: {
        ...ENABLED_ENV,
        NODE_ENV: "production",
      },
      fetchImpl: async () => null,
      deepSeekProvider: {},
      openAIProvider: {},
    }),
    (error) => error?.code === "admin_model_lab_production_unavailable"
      && /local-only/u.test(error.message),
  );
});

test("composition keeps DeepSeek Flash as preparation and exposes configured experimental finals", async () => {
  const service = createAdminModelLabDevelopmentService({
    env: {
      ADMIN_MODEL_LAB_ENABLED: "true",
      NODE_ENV: "development",
      DEEPSEEK_API_KEY: "server-deepseek-secret",
      GLM_API_KEY: "server-glm-secret",
      KIMI_API_KEY: "server-kimi-secret",
      RELAY_API_KEY: "server-relay-secret",
      RELAY_BASE_URL: "https://relay.example/v1",
      ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY: "2",
      ADMIN_FINAL_BUDGET_GLM_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_GLM_RESERVATION_CNY: "2",
      ADMIN_FINAL_BUDGET_KIMI_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_KIMI_RESERVATION_CNY: "2",
      ADMIN_FINAL_BUDGET_RELAY_SOL_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_RELAY_SOL_RESERVATION_CNY: "5",
      ADMIN_FINAL_BUDGET_RELAY_TERRA_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_RELAY_TERRA_RESERVATION_CNY: "5",
      ADMIN_FINAL_BUDGET_RELAY_LUNA_DAILY_CNY: "10",
      ADMIN_FINAL_BUDGET_RELAY_LUNA_RESERVATION_CNY: "5",
    },
    fetchImpl: async () => {
      throw new Error("network must not run while reading capabilities");
    },
    deepSeekProvider: { async prepareEvidence() {} },
  });
  const capabilities = await service.capabilities();
  assert.deepEqual(capabilities.architecture.preparationProviders, ["deepseek"]);
  assert.deepEqual(
    [...capabilities.architecture.finalRulingProviders].sort(),
    ["deepseek", "glm", "kimi", "relay"],
  );
  assert.equal(capabilities.architecture.finalRulingProvider, "deepseek");
  assert.equal(capabilities.providers.providers.find((item) => item.providerId === "glm").available, true);
  assert.equal(capabilities.providers.providers.find((item) => item.providerId === "kimi").available, true);
  assert.equal(capabilities.providers.providers.find((item) => item.providerId === "relay").available, true);
  assert.equal(capabilities.providers.providers.find((item) => item.providerId === "openai").available, false);
  const queued = await service.createRun({ body: { question: "仅国产模型的实验问题" } });
  assert.equal(queued.executionProfile.preparation.provider, "deepseek");
  assert.equal(queued.executionProfile.finalRuling.provider, "deepseek");
  assert.equal(queued.executionProfile.finalRuling.model, "deepseek-v4-flash");
  assert.equal(JSON.stringify(capabilities).includes("server-glm-secret"), false);
  assert.equal(JSON.stringify(capabilities).includes("server-kimi-secret"), false);
  assert.equal(JSON.stringify(capabilities).includes("server-relay-secret"), false);
});

test("DeepSeek bridge accepts evidence preparation only and keeps server-owned transport", async () => {
  const calls = [];
  const serverEnv = {
    DEEPSEEK_API_KEY: "server-only",
  };
  const serverFetch = async () => {
    throw new Error("injected JSON task should own this test");
  };
  const invoke = createDeepSeekEvidencePreparationInvoke({
    env: serverEnv,
    fetchImpl: serverFetch,
    callDeepSeekJsonTaskImpl: async (request) => {
      calls.push(request);
      return { cardNameCandidates: [{ name: "测试卡" }] };
    },
  });
  const controller = new AbortController();

  const result = await invoke({
    provider: "deepseek",
    purpose: "evidence_preparation",
    canMakeFinalRuling: false,
    canDecideEscalation: false,
    prompt: "只整理证据",
    modelName: "deepseek-v4-flash",
    thinkingMode: "enabled",
    reasoningEffort: "max",
    signal: controller.signal,
  });
  assert.equal(result.cardNameCandidates[0].name, "测试卡");
  assert.equal(calls[0].env, serverEnv);
  assert.equal(calls[0].fetchImpl, serverFetch);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].thinkingMode, "enabled");
  assert.equal(calls[0].reasoningEffort, "max");

  await assert.rejects(
    invoke({
      provider: "deepseek",
      purpose: "final_ruling",
      canMakeFinalRuling: true,
      canDecideEscalation: true,
      prompt: "越权请求",
    }),
    (error) => error.code === "deepseek_evidence_preparation_boundary_violation",
  );
});

test("DeepSeek JSON task returns strict structured hints and metered usage", async () => {
  const calls = [];
  const result = await callDeepSeekJsonTask({
    prompt: "提取卡名和规则检索词",
    modelName: "deepseek-v4-flash",
    maxTokens: 900,
    env: {
      DEEPSEEK_API_KEY: "server-secret",
      DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              cardNameCandidates: [{ name: "测试卡", originalText: "测试卡" }],
              ruleSearchQueries: [{ query: "发动条件" }],
              unresolvedNotes: [],
              conflicts: [],
            }),
          },
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 40,
          prompt_cache_hit_tokens: 20,
          prompt_cache_miss_tokens: 100,
        },
      });
    },
  });

  assert.equal(result.cardNameCandidates[0].name, "测试卡");
  assert.equal(result.usage.prompt_tokens, 120);
  assert.equal(result.usage.completion_tokens, 40);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://deepseek.example/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer server-secret");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.max_tokens, 900);

  await callDeepSeekJsonTask({
    prompt: "不设置应用层输出上限",
    env: {
      DEEPSEEK_API_KEY: "server-secret",
      DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ ruleSearchQueries: [] }) },
        }],
        usage: {},
      });
    },
  });
  assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body), "max_tokens"), false);

  await assert.rejects(
    callDeepSeekJsonTask({
      prompt: "x",
      env: {},
      fetchImpl: async () => {
        throw new Error("must not call");
      },
    }),
    (error) => error.code === "deepseek_not_configured",
  );
});

test("DeepSeek response-format fallback keeps the caller AbortSignal", async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await callDeepSeekJsonTask({
    prompt: "只返回 JSON",
    signal: controller.signal,
    env: {
      DEEPSEEK_API_KEY: "server-secret",
      DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse({ error: { message: "response_format unsupported" } }, 400);
      return jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ok: true }) } }],
        usage: {},
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body), "response_format"), false);
});

test("DeepSeek JSON task records paid usage before rejecting invalid JSON", async () => {
  const now = new Date("2026-07-31T00:00:00.000Z");
  const env = {
    DEEPSEEK_API_KEY: "server-secret",
    DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
    API_DAILY_BUDGET_CNY: "10",
    API_BUDGET_TIMEZONE: "UTC",
    DEEPSEEK_INPUT_CNY_PER_MTOK: "1",
    DEEPSEEK_OUTPUT_CNY_PER_MTOK: "2",
  };
  await resetRagBudget({ env, now });

  await assert.rejects(
    callDeepSeekJsonTask({
      prompt: "返回严格 JSON",
      env,
      now,
      trackPublicBudget: true,
      fetchImpl: async () => jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
      }),
    }),
  );

  const status = await getRagBudgetStatus({ env, now });
  assert.equal(status.spentTodayCny, 0.002);
});

function fakeBaseService({ persistent = true } = {}) {
  const run = {
    runId: "run-production-1",
    createdAt: "2026-07-28T00:00:00.000Z",
    status: "SUCCEEDED",
    startedAt: "2026-07-28T00:00:01.000Z",
    endedAt: "2026-07-28T00:00:03.000Z",
    evidenceSnapshot: {
      question: "测试问题",
      snapshotId: "evidence-production-1",
      contentSha256: "a".repeat(64),
      evidence: {
        evidenceDecisionPacket: {
          decisionPacketId: "decision_packet_production_1",
          packetContentSha256: "b".repeat(64),
        },
      },
    },
    metadata: {
      fork: {
        schemaVersion: 1,
        sourceRunId: "source-production-1",
        rootSourceRunId: "source-production-1",
        sourceEvidenceSnapshotId: "evidence-production-1",
        sourceEvidenceSnapshotSha256: "a".repeat(64),
        sourceDecisionPacketId: "decision_packet_production_1",
        sourceDecisionPacketSha256: "b".repeat(64),
        requestFingerprint: "c".repeat(64),
        idempotencyKeySha256: "d".repeat(64),
      },
    },
    executionProfile: {
      finalRuling: {
        provider: "openai",
        model: "gpt-5.6-terra",
      },
    },
    execution: {
      repair: {
        schemaVersion: 1,
        attempted: true,
        requestedAt: "2026-07-28T00:00:02.000Z",
        validationErrors: ["missing evidenceId"],
        initialAttempt: { requestId: "primary-production-1" },
        invariants: {
          evidenceSnapshotId: "evidence-production-1",
          evidenceSnapshotSha256: "a".repeat(64),
          decisionPacketId: "decision_packet_production_1",
          decisionPacketSha256: "b".repeat(64),
          promptSha256: "c".repeat(64),
        },
      },
      repairSubmission: {
        state: "SUBMITTED",
        requestId: "repair-production-1",
      },
    },
    result: {
      schemaVersion: 1,
      evidenceSnapshotId: "evidence-production-1",
      finalRuling: {
        conciseAnswer: "测试裁定。",
      },
      validation: {
        ok: true,
        errors: [],
      },
      repair: {
        schemaVersion: 1,
        attempted: true,
        outcome: "succeeded",
        attempts: [
          { requestId: "primary-production-1" },
          { requestId: "repair-production-1" },
        ],
      },
      metering: {
        totals: {
          usage: {
            totalTokens: 180,
          },
          cost: {
            totalCostUsd: 0.01,
          },
        },
      },
    },
  };
  return {
    persistence: {
      runStore: persistent,
      runStoreKind: persistent ? "redis-rest" : "memory",
      runTtlSeconds: null,
    },
    async capabilities() {
      return {
        features: {
          history: false,
          rating: false,
          export: false,
          evaluation: false,
        },
        unavailableReasons: {
          history: "missing",
          rating: "missing",
          export: "missing",
          evaluation: "missing",
        },
      };
    },
    async createRun() {
      return structuredClone(run);
    },
    async forkRun() {
      return structuredClone(run);
    },
    async executeRun() {
      return { run: structuredClone(run), providerRequest: null };
    },
    async getRun() {
      return structuredClone(run);
    },
    async pollRun() {
      return structuredClone(run);
    },
    async cancelRun() {
      return structuredClone(run);
    },
    async replayEvents() {
      return { events: [], nextAfterSequence: 0, status: run.status, terminal: false };
    },
  };
}

function persistentRecordStore() {
  return Object.freeze({
    ...createMemoryAdminLabRecordStore(),
    kind: "test-persistent",
    persistent: true,
  });
}

function persistentBudgetLedger() {
  return Object.freeze({
    kind: "test-persistent-final-budget",
    persistent: true,
    async reserve() {
      return { status: "reserved" };
    },
    async settle() {
      return { status: "settled" };
    },
    async release() {
      return { status: "released" };
    },
  });
}

function deletablePersistentRecordStore() {
  const inner = createMemoryAdminLabRecordStore();
  const deletedRunIds = new Set();
  let registerCalls = 0;
  return Object.freeze({
    ...inner,
    kind: "test-persistent-deletable",
    persistent: true,
    async registerRun(input) {
      registerCalls += 1;
      const record = await inner.registerRun(input);
      deletedRunIds.delete(record.runId);
      return record;
    },
    async getRun(runId) {
      if (deletedRunIds.has(String(runId))) return null;
      return inner.getRun(runId);
    },
    async saveHumanRating(input) {
      if (deletedRunIds.has(String(input?.runId))) {
        const error = new Error(`admin lab record not found: ${String(input?.runId || "")}`);
        error.code = "admin_lab_record_not_found";
        throw error;
      }
      return inner.saveHumanRating(input);
    },
    deleteRecord(runId) {
      deletedRunIds.add(String(runId));
    },
    registrationCalls() {
      return registerCalls;
    },
  });
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
