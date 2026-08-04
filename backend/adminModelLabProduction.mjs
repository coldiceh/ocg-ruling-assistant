import {
  ADMIN_MODEL_LAB_STAGES,
} from "./adminModelLabConfig.mjs";
import {
  evaluateAdminLabResult,
  loadAdminLabEvaluationCorpus,
} from "./adminLabEvaluation.mjs";
import {
  createConfiguredAdminLabRecordStore,
  createMemoryAdminLabRecordStore,
  exportAdminLabRecordsCsv,
  exportAdminLabRecordsJson,
} from "./adminLabRecordStore.mjs";
import { createAdminModelLabService } from "./adminModelLabService.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "./legacyLuaSemanticProduction.mjs";
import { createConfiguredAdminRunStorage } from "./adminRunRedisStorage.mjs";
import {
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "./adminRunStore.mjs";
import { callDeepSeekJsonTask } from "./ragModelClient.mjs";
import {
  CompatibleEvidencePreparationProvider,
  ExistingDeepSeekProvider,
  OpenAIResponsesProvider,
} from "./rulingModelProviders.mjs";

const EXPORT_PAGE_LIMIT = 100;
const HISTORY_REGISTRATION_CACHE_LIMIT = 512;
const HISTORY_FEATURES = Object.freeze([
  "history",
  "rating",
  "export",
  "evaluation",
]);

/**
 * Creates the production-only admin model lab service.
 *
 * All dependencies accepted here are server-side dependency-injection seams.
 * The HTTP route deliberately passes only process.env and fetch; request-body
 * values can never select storage, credentials, retrieval files, transports or
 * pricing configuration.
 */
export function createAdminModelLabProductionService({
  ...options
} = {}) {
  return createAdminModelLabComposedService({
    ...options,
    requirePersistentStores: true,
  });
}

/**
 * Creates an explicitly local-only model-lab composition.
 *
 * This is a code-level development seam, not an environment-controlled
 * production fallback. It refuses production/serverless environments and is
 * the only composition allowed to use process-local run/history stores.
 */
export function createAdminModelLabDevelopmentService(options = {}) {
  const env = options.env || globalThis.process?.env || {};
  if (
    String(env.NODE_ENV || "development").trim().toLowerCase() === "production"
    || readEnabled(env.VERCEL)
  ) {
    throw productionUnavailable("ephemeral development model lab is local-only");
  }
  const runStorage = options.runStorage || createMemoryAdminRunStorage();
  const runStore = options.runStore || createAdminRunStore({ storage: runStorage });
  const recordStore = options.recordStore || createMemoryAdminLabRecordStore();
  return createAdminModelLabComposedService({
    ...options,
    env,
    runStorage,
    runStore,
    recordStore,
    requirePersistentStores: false,
  });
}

function createAdminModelLabComposedService({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  runStorage,
  runStore,
  recordStore,
  deepSeekProvider,
  glmProvider,
  kimiProvider,
  preparationProviders,
  openAIProvider,
  legacyLuaSemanticPacketFactory,
  baseService,
  callDeepSeekJsonTaskImpl = callDeepSeekJsonTask,
  evaluationLoader = loadAdminLabEvaluationCorpus,
  requirePersistentStores,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("admin model lab production env must be an object");
  }
  if (typeof fetchImpl !== "function") {
    throw productionUnavailable("server fetch is unavailable");
  }
  if (!readEnabled(env.ADMIN_MODEL_LAB_ENABLED)) {
    throw productionUnavailable("ADMIN_MODEL_LAB_ENABLED is not enabled");
  }

  const resolvedRecordStore = recordStore || createConfiguredAdminLabRecordStore({
    env,
    fetchImpl,
  });
  assertRecordStore(resolvedRecordStore);
  if (requirePersistentStores) assertPersistentDependency(resolvedRecordStore, "record store");

  let resolvedBaseService = baseService;
  if (!resolvedBaseService) {
    if (requirePersistentStores && runStorage) assertPersistentDependency(runStorage, "run storage");
    if (requirePersistentStores && runStore) assertPersistentDependency(runStore, "run store");
    const resolvedRunStorage = runStorage || (
      runStore
        ? null
        : createConfiguredAdminRunStorage({
          env,
          fetchImpl,
        })
    );
    if (requirePersistentStores && resolvedRunStorage) {
      assertPersistentDependency(resolvedRunStorage, "run storage");
    }
    const resolvedRunStore = runStore || createAdminRunStore({
      storage: resolvedRunStorage,
    });
    if (requirePersistentStores) assertPersistentDependency(resolvedRunStore, "run store");
    const resolvedDeepSeekProvider = deepSeekProvider || new ExistingDeepSeekProvider({
      env,
      invoke: createDeepSeekEvidencePreparationInvoke({
        env: {
          ...env,
          DEEPSEEK_API_KEY: requiredServerSecret(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY"),
        },
        fetchImpl,
        callDeepSeekJsonTaskImpl,
      }),
    });
    const resolvedDeepSeekFinalProvider = hasServerSecret(env.DEEPSEEK_API_KEY)
      ? new CompatibleEvidencePreparationProvider({
          providerId: "deepseek",
          apiKey: env.DEEPSEEK_API_KEY,
          baseUrl: serverDeepSeekBaseUrl(env),
          fetchImpl,
          env,
        })
      : null;
    const resolvedGlmProvider = glmProvider || (
      hasServerSecret(env.GLM_API_KEY)
        ? new CompatibleEvidencePreparationProvider({
            providerId: "glm",
            apiKey: env.GLM_API_KEY,
            baseUrl: serverGlmBaseUrl(env),
            fetchImpl,
            env,
          })
        : null
    );
    const resolvedKimiProvider = kimiProvider || (
      hasServerSecret(env.KIMI_API_KEY)
        ? new CompatibleEvidencePreparationProvider({
            providerId: "kimi",
            apiKey: env.KIMI_API_KEY,
            baseUrl: serverKimiBaseUrl(env),
            fetchImpl,
            env,
          })
        : null
    );
    const resolvedOpenAIProvider = openAIProvider || (
      readEnabled(env.ADMIN_OPENAI_ENABLED) && hasServerSecret(env.OPENAI_API_KEY)
        ? new OpenAIResponsesProvider({
            apiKey: env.OPENAI_API_KEY,
            baseUrl: serverOpenAIBaseUrl(env),
            fetchImpl,
            env,
          })
        : null
    );
    const resolvedLegacyLuaSemanticPacketFactory =
      legacyLuaSemanticPacketFactory === undefined
        ? createConfiguredLegacyLuaSemanticPacketFactory({ env, fetchImpl })
        : legacyLuaSemanticPacketFactory;
    resolvedBaseService = createAdminModelLabService({
      runStore: resolvedRunStore,
      deepSeekProvider: resolvedDeepSeekProvider,
      preparationProviders: {
        ...(preparationProviders && typeof preparationProviders === "object"
          ? preparationProviders
          : {}),
      },
      openAIProvider: resolvedOpenAIProvider,
      finalRulingProviders: {
        ...(resolvedDeepSeekFinalProvider ? { deepseek: resolvedDeepSeekFinalProvider } : {}),
        ...(typeof resolvedGlmProvider?.create === "function" ? { glm: resolvedGlmProvider } : {}),
        ...(typeof resolvedKimiProvider?.create === "function" ? { kimi: resolvedKimiProvider } : {}),
      },
      legacyLuaSemanticPacketFactory:
        resolvedLegacyLuaSemanticPacketFactory,
      env,
    });
  }
  assertBaseService(resolvedBaseService);
  if (requirePersistentStores) assertPersistentBaseService(resolvedBaseService);
  if (typeof evaluationLoader !== "function") {
    throw new TypeError("evaluationLoader must be a function");
  }
  const confirmedHistoryRunIds = new Set();
  const historyRegistrationInFlight = new Map();

  async function capabilities(argument = {}) {
    const base = await resolvedBaseService.capabilities(argument);
    const unavailableReasons = { ...(base?.unavailableReasons || {}) };
    for (const feature of HISTORY_FEATURES) delete unavailableReasons[feature];
    return {
      ...cloneJson(base || {}),
      architecture: {
        ...(base?.architecture || {}),
        sharedEvidenceSnapshotFork: true,
      },
      features: {
        ...(base?.features || {}),
        forkRun: true,
        history: true,
        rating: true,
        export: true,
        evaluation: true,
      },
      unavailableReasons,
      persistence: {
        runStore: resolvedBaseService.persistence.runStore ? "persistent" : "ephemeral",
        runStoreKind: resolvedBaseService.persistence.runStoreKind || "unknown",
        runTtlSeconds: resolvedBaseService.persistence.runTtlSeconds ?? null,
        recordStore: resolvedRecordStore.persistent ? "persistent" : "ephemeral",
        recordStoreKind: resolvedRecordStore.kind || "unknown",
        recordTtlSeconds: resolvedRecordStore.ttlSeconds ?? null,
      },
    };
  }

  async function createRun(argument = {}) {
    const run = await resolvedBaseService.createRun(argument);
    const registration = await ensureRunHistoryRegistration(run);
    await persistTerminalRepairAudit(run);
    return attachHistoryRegistration(run, registration);
  }

  async function forkRun(argument = {}) {
    const run = await resolvedBaseService.forkRun(argument);
    const registration = await ensureRunHistoryRegistration(run);
    await persistTerminalRepairAudit(run);
    return attachHistoryRegistration(run, registration);
  }

  async function executeRun(argument = {}) {
    return reconcileRunBearingResult(
      await resolvedBaseService.executeRun(argument),
    );
  }

  async function getRun(argument = {}) {
    const run = await resolvedBaseService.getRun(argument);
    const registration = await ensureRunHistoryRegistration(run);
    await persistTerminalRepairAudit(run);
    return attachHistoryRegistration(run, registration);
  }

  async function pollRun(argument = {}) {
    const run = await resolvedBaseService.pollRun(argument);
    const registration = await ensureRunHistoryRegistration(run);
    await persistTerminalRepairAudit(run);
    return attachHistoryRegistration(run, registration);
  }

  async function cancelRun(argument = {}) {
    const run = await resolvedBaseService.cancelRun(argument);
    const registration = await ensureRunHistoryRegistration(run);
    await persistTerminalRepairAudit(run);
    return attachHistoryRegistration(run, registration);
  }

  async function replayEvents(argument = {}) {
    const replay = await resolvedBaseService.replayEvents(argument);
    const runId = String(argument?.runId || "").trim();
    if (runId && !historyRegistrationIsCached(runId)) {
      try {
        const run = await resolvedBaseService.getRun({
          runId,
          reconcile: false,
        });
        await ensureRunHistoryRegistration(run);
      } catch {
        // Event replay is authoritative even when best-effort history repair
        // cannot inspect or register the corresponding run.
      }
    }
    return replay;
  }

  async function reconcileRunBearingResult(value) {
    if (value?.run && typeof value.run === "object") {
      const registration = await ensureRunHistoryRegistration(value.run);
      await persistTerminalRepairAudit(value.run);
      if (registration.status === "registered") return value;
      return {
        ...cloneJson(value),
        run: attachHistoryRegistration(value.run, registration),
      };
    }
    if (value?.runId) {
      const registration = await ensureRunHistoryRegistration(value);
      await persistTerminalRepairAudit(value);
      return attachHistoryRegistration(value, registration);
    }
    return value;
  }

  async function ensureRunHistoryRegistration(run) {
    const runId = String(run?.runId || "").trim();
    if (!runId) {
      return historyRegistrationFailure(
        new TypeError("runId is required for history registration"),
      );
    }
    if (historyRegistrationIsCached(runId)) {
      return { status: "registered" };
    }
    let pending = historyRegistrationInFlight.get(runId);
    if (!pending) {
      pending = (async () => {
        try {
          await resolvedRecordStore.registerRun(historyRegistrationInput(run));
          rememberHistoryRegistration(runId);
          return { status: "registered" };
        } catch (error) {
          return historyRegistrationFailure(error);
        }
      })();
      historyRegistrationInFlight.set(runId, pending);
      void pending.finally(() => {
        if (historyRegistrationInFlight.get(runId) === pending) {
          historyRegistrationInFlight.delete(runId);
        }
      });
    }
    return pending;
  }

  async function persistTerminalRepairAudit(run) {
    if (!run?.execution?.repair) return null;
    if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(run.status || ""))) return null;
    const repairProvenance = {
      ...run.execution.repair,
      submission: run.execution.repairSubmission || null,
      outcome: repairOutcome(run),
    };
    try {
      return await resolvedRecordStore.saveRunRepairProvenance({
        runId: run.runId,
        repairProvenance,
      });
    } catch (error) {
      if (error?.code !== "admin_lab_record_not_found") throw error;
      await repairHistoryRegistrationByRunId(run.runId, { force: true });
      return resolvedRecordStore.saveRunRepairProvenance({
        runId: run.runId,
        repairProvenance,
      });
    }
  }

  function historyRegistrationIsCached(runId) {
    return resolvedRecordStore.ttlSeconds === null
      && confirmedHistoryRunIds.has(String(runId));
  }

  function rememberHistoryRegistration(runId) {
    if (resolvedRecordStore.ttlSeconds !== null) return;
    const id = String(runId);
    confirmedHistoryRunIds.delete(id);
    confirmedHistoryRunIds.add(id);
    while (confirmedHistoryRunIds.size > HISTORY_REGISTRATION_CACHE_LIMIT) {
      confirmedHistoryRunIds.delete(confirmedHistoryRunIds.values().next().value);
    }
  }

  async function listRuns({ limit, cursor } = {}) {
    const page = await resolvedRecordStore.listRuns(compactObject({
      limit,
      cursor,
    }));
    const entries = await Promise.all(
      page.records.map((record) => enrichHistoryRecord(record)),
    );
    for (const record of page.records) rememberHistoryRegistration(record.runId);
    return {
      ...page,
      records: entries,
      entries,
      runs: entries,
    };
  }

  async function saveRating({
    runId,
    rating,
    notes,
  } = {}) {
    await repairHistoryRegistrationByRunId(runId);
    try {
      return await resolvedRecordStore.saveHumanRating({
        runId,
        rating,
        note: notes,
      });
    } catch (error) {
      if (error?.code !== "admin_lab_record_not_found") throw error;
      await repairHistoryRegistrationByRunId(runId, { force: true });
      return resolvedRecordStore.saveHumanRating({
        runId,
        rating,
        note: notes,
      });
    }
  }

  async function exportRuns({
    runId = null,
    format = "json",
    cursor = null,
  } = {}) {
    const normalizedFormat = String(format || "json").trim().toLowerCase();
    if (!["json", "csv"].includes(normalizedFormat)) {
      throw new RangeError("admin model lab export format must be json or csv");
    }
    const records = runId
      ? [await getExportRecord(runId)]
      : await readAllRecords({ cursor });
    const content = normalizedFormat === "csv"
      ? exportAdminLabRecordsCsv(records)
      : exportAdminLabRecordsJson(records);
    return {
      format: normalizedFormat,
      contentType: normalizedFormat === "csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8",
      fileName: runId
        ? `ocg-model-lab-${safeFilePart(runId)}.${normalizedFormat}`
        : `ocg-model-lab-history.${normalizedFormat}`,
      count: records.length,
      content,
    };
  }

  async function getEvaluation({
    runId = null,
    evaluationId = null,
  } = {}) {
    const corpus = await evaluationLoader();
    const selectedCases = evaluationId
      ? corpus.cases.filter((item) => item.id === String(evaluationId))
      : corpus.cases;
    if (evaluationId && selectedCases.length === 0) {
      throw new RangeError("admin model lab evaluation case was not found");
    }
    const response = {
      schemaVersion: corpus.schemaVersion,
      fixtureName: corpus.fixtureName,
      purpose: corpus.purpose,
      humanTruth: false,
      cases: cloneJson(selectedCases),
    };
    if (!runId) return response;

    const run = await resolvedBaseService.getRun({
      runId,
      reconcile: true,
    });
    if (!run?.result) {
      return {
        ...response,
        runId: run?.runId || String(runId),
        runStatus: run?.status || null,
        assessments: [],
      };
    }
    const casesToAssess = evaluationId
      ? selectedCases
      : matchCasesToRun(selectedCases, run);
    return {
      ...response,
      runId: run.runId,
      runStatus: run.status,
      assessments: casesToAssess.map((testCase) => evaluateAdminLabResult({
        testCase,
        structuredResult: run.result,
        evidenceSnapshot: run.evidenceSnapshot,
      })),
    };
  }

  async function enrichHistoryRecord(record) {
    let run = null;
    try {
      run = await resolvedBaseService.getRun({
        runId: record.runId,
        reconcile: false,
      });
    } catch (error) {
      if (error?.code !== "admin_run_not_found") throw error;
    }
    const finalRuling = record.modelConfig?.finalRuling || {};
    return {
      ...cloneJson(record),
      question: record.questionSummary,
      status: run?.status || null,
      startedAt: run?.startedAt || null,
      endedAt: run?.endedAt || null,
      model: finalRuling.model || finalRuling.requestedModel || "",
      configuration: cloneJson(record.modelConfig || {}),
      repairProvenance: run?.execution?.repair
        ? cloneJson({
            ...run.execution.repair,
            submission: run.execution.repairSubmission || null,
            outcome: repairOutcome(run),
          })
        : (record.repairProvenance ? cloneJson(record.repairProvenance) : null),
    };
  }

  async function getExportRecord(runId) {
    let record = await resolvedRecordStore.getRun(runId);
    if (!record) {
      await repairHistoryRegistrationByRunId(runId, { force: true });
      record = await resolvedRecordStore.getRun(runId);
    }
    if (!record) {
      const error = new Error(`admin lab record not found: ${String(runId || "")}`);
      error.code = "admin_lab_record_not_found";
      throw error;
    }
    const humanRating = await resolvedRecordStore.getHumanRating(runId);
    return enrichExportRecord({
      ...record,
      humanRating,
    });
  }

  async function enrichExportRecord(record) {
    let run = null;
    try {
      run = await resolvedBaseService.getRun({
        runId: record.runId,
        reconcile: false,
      });
    } catch (error) {
      if (error?.code !== "admin_run_not_found") throw error;
    }
    const result = run?.result || null;
    return {
      ...cloneJson(record),
      status: run?.status || null,
      startedAt: run?.startedAt || null,
      endedAt: run?.endedAt || null,
      evidenceSnapshotId:
        result?.evidenceSnapshotId
        || run?.evidenceSnapshot?.snapshotId
        || record.evidenceSnapshotId
        || null,
      evidenceSnapshotSha256:
        run?.evidenceSnapshot?.contentSha256
        || record.evidenceSnapshotSha256
        || null,
      decisionPacketId:
        run?.evidenceSnapshot?.evidence?.evidenceDecisionPacket?.decisionPacketId
        || record.decisionPacketId
        || null,
      decisionPacketSha256:
        run?.evidenceSnapshot?.evidence?.evidenceDecisionPacket?.packetContentSha256
        || record.decisionPacketSha256
        || null,
      runMetadata: run?.metadata ? cloneJson(run.metadata) : null,
      forkProvenance: run?.metadata?.fork
        ? cloneJson(run.metadata.fork)
        : (record.forkProvenance ? cloneJson(record.forkProvenance) : null),
      repairProvenance: run?.execution?.repair
        ? cloneJson({
            ...run.execution.repair,
            submission: run.execution.repairSubmission || null,
            outcome: repairOutcome(run),
          })
        : (result?.repair
            ? cloneJson(result.repair)
            : (record.repairProvenance ? cloneJson(record.repairProvenance) : null)),
      result: result ? cloneJson(result) : null,
      metering: result?.metering ? cloneJson(result.metering) : null,
    };
  }

  async function readAllRecords({ cursor = null } = {}) {
    const records = [];
    const seenCursors = new Set();
    let nextCursor = cursor || null;
    do {
      const cursorKey = String(nextCursor || "");
      if (seenCursors.has(cursorKey)) {
        throw productionUnavailable("record pagination returned a repeated cursor");
      }
      seenCursors.add(cursorKey);
      const page = await resolvedRecordStore.listRuns(compactObject({
        cursor: nextCursor,
        limit: EXPORT_PAGE_LIMIT,
      }));
      records.push(...await Promise.all(
        page.records.map((record) => enrichExportRecord(record)),
      ));
      nextCursor = page.nextCursor || null;
    } while (nextCursor);
    return records;
  }

  async function repairHistoryRegistrationByRunId(runId, { force = false } = {}) {
    const id = String(runId || "").trim();
    if (!id) return;
    if (force) confirmedHistoryRunIds.delete(id);
    if (historyRegistrationIsCached(id)) return;
    try {
      const run = await resolvedBaseService.getRun({
        runId: id,
        reconcile: false,
      });
      await ensureRunHistoryRegistration(run);
    } catch {
      // The original history/rating/export operation retains its own stable
      // not-found or storage error after this best-effort repair attempt.
    }
  }

  return Object.freeze({
    capabilities,
    createRun,
    forkRun,
    executeRun,
    getRun,
    pollRun,
    cancelRun,
    replayEvents,
    listRuns,
    saveRating,
    exportRuns,
    getEvaluation,
  });
}

/**
 * The only production bridge into the existing DeepSeek client.
 *
 * It refuses any request whose capability flags would permit a final ruling or
 * escalation decision, then supplies server-owned env and fetch to the strict
 * JSON task. Neither field can be overridden by an admin HTTP request.
 */
export function createDeepSeekEvidencePreparationInvoke({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  callDeepSeekJsonTaskImpl = callDeepSeekJsonTask,
} = {}) {
  if (typeof fetchImpl !== "function") throw productionUnavailable("server fetch is unavailable");
  if (typeof callDeepSeekJsonTaskImpl !== "function") {
    throw new TypeError("callDeepSeekJsonTaskImpl must be a function");
  }
  return async function invokeEvidencePreparation(request = {}) {
    if (request.provider !== "deepseek") {
      throw providerBoundaryError("DeepSeek preparation provider mismatch");
    }
    if (request.purpose !== ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION) {
      throw providerBoundaryError("DeepSeek is restricted to evidence preparation");
    }
    if (
      request.canMakeFinalRuling !== false
      || request.canDecideEscalation !== false
    ) {
      throw providerBoundaryError("DeepSeek capability boundary was not explicitly disabled");
    }
    return callDeepSeekJsonTaskImpl({
      prompt: String(request.prompt || ""),
      modelName: String(request.modelName || ""),
      maxTokens: request.maxTokens,
      env,
      fetchImpl,
      temperature: 0,
      thinkingMode: request.thinkingMode,
      reasoningEffort: request.reasoningEffort,
      signal: request.signal,
    });
  };
}

function assertBaseService(service) {
  for (const method of [
    "capabilities",
    "createRun",
    "forkRun",
    "executeRun",
    "getRun",
    "pollRun",
    "cancelRun",
    "replayEvents",
  ]) {
    if (typeof service?.[method] !== "function") {
      throw new TypeError(`admin model lab base service is missing ${method}()`);
    }
  }
}

function assertRecordStore(store) {
  for (const method of [
    "registerRun",
    "getRun",
    "listRuns",
    "saveHumanRating",
    "getHumanRating",
    "saveRunRepairProvenance",
  ]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`admin model lab record store is missing ${method}()`);
    }
  }
}

function assertPersistentDependency(value, label) {
  if (value?.persistent !== true) {
    throw productionUnavailable(`${label} must be persistent`);
  }
}

function assertPersistentBaseService(service) {
  if (service?.persistence?.runStore !== true) {
    throw productionUnavailable("base service run store must be persistent");
  }
}

function matchCasesToRun(cases, run) {
  const explicitId = String(
    run?.metadata?.evaluationId
    || run?.metadata?.testCaseId
    || "",
  ).trim();
  if (explicitId) return cases.filter((item) => item.id === explicitId);
  const question = normalizeComparableText(run?.evidenceSnapshot?.question);
  return cases.filter((item) => normalizeComparableText(item.question) === question);
}

function normalizeComparableText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function requiredServerSecret(value, name) {
  const result = String(value || "").trim();
  if (!result) throw productionUnavailable(`${name} is not configured`);
  return result;
}

function readEnabled(value) {
  return /^(?:1|true|yes|on|enabled)$/iu.test(String(value ?? "").trim());
}

function serverOpenAIBaseUrl(env) {
  return String(
    env.ADMIN_OPENAI_BASE_URL
    || env.OPENAI_BASE_URL
    || "https://api.openai.com/v1",
  ).trim();
}

function serverDeepSeekBaseUrl(env) {
  return String(
    env.ADMIN_DEEPSEEK_BASE_URL
    || env.DEEPSEEK_BASE_URL
    || "https://api.deepseek.com",
  ).trim();
}

function serverGlmBaseUrl(env) {
  return String(
    env.ADMIN_GLM_BASE_URL
    || env.GLM_BASE_URL
    || "https://open.bigmodel.cn/api/paas/v4",
  ).trim();
}

function serverKimiBaseUrl(env) {
  return String(
    env.ADMIN_KIMI_BASE_URL
    || env.KIMI_BASE_URL
    || "https://api.moonshot.cn/v1",
  ).trim();
}

function hasServerSecret(value) {
  return typeof value === "string" && value.trim() !== "";
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => (
      item !== undefined
      && item !== null
      && item !== ""
    )),
  );
}

function safeFilePart(value) {
  return String(value || "run").replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 120) || "run";
}

function historyRegistrationInput(run) {
  const decisionPacket = run?.evidenceSnapshot?.evidence?.evidenceDecisionPacket;
  return {
    runId: run?.runId,
    createdAt: run?.createdAt,
    questionSummary: run?.evidenceSnapshot?.question,
    executionProfile: run?.executionProfile,
    evidenceSnapshotId: run?.evidenceSnapshot?.snapshotId,
    evidenceSnapshotSha256: run?.evidenceSnapshot?.contentSha256,
    decisionPacketId: decisionPacket?.decisionPacketId,
    decisionPacketSha256: decisionPacket?.packetContentSha256,
    forkProvenance: run?.metadata?.fork,
    repairProvenance: run?.execution?.repair
      ? {
          ...run.execution.repair,
          submission: run.execution.repairSubmission || null,
          outcome: repairOutcome(run),
        }
      : undefined,
  };
}

function repairOutcome(run) {
  if (!run?.execution?.repair) return null;
  if (run.status === "SUCCEEDED") return "succeeded";
  if (run.status === "FAILED") return "failed";
  if (run.status === "CANCELLED") return "cancelled";
  const state = String(run.execution?.repairSubmission?.state || "").toUpperCase();
  if (state === "OUTCOME_UNKNOWN") return "submission_outcome_unknown";
  if (state === "REJECTED") return "submission_rejected";
  return "in_progress";
}

function historyRegistrationFailure(error) {
  const rawCode = String(error?.code || "").trim();
  const errorCode = /^[A-Za-z0-9_]{1,100}$/u.test(rawCode)
    ? rawCode
    : "admin_lab_record_registration_failed";
  const retryable = !(
    error instanceof TypeError
    || error instanceof RangeError
    || errorCode === "admin_lab_record_conflict"
    || errorCode === "admin_lab_record_storage_corrupt"
  );
  return {
    status: retryable ? "pending" : "failed",
    retryable,
    retryOnNextAccess: retryable,
    errorCode,
  };
}

function attachHistoryRegistration(run, registration) {
  if (registration?.status === "registered") return run;
  return {
    ...cloneJson(run || {}),
    historyRegistration: cloneJson(registration || {
      status: "pending",
      retryable: true,
      retryOnNextAccess: true,
      errorCode: "admin_lab_record_registration_failed",
    }),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function providerBoundaryError(message) {
  const error = new Error(message);
  error.code = "deepseek_evidence_preparation_boundary_violation";
  return error;
}

function productionUnavailable(message) {
  const error = new Error(`admin model lab production service unavailable: ${message}`);
  error.code = "admin_model_lab_production_unavailable";
  return error;
}
