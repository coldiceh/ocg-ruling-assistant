import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  buildFinalRulingInput,
  createAdminModelLabService,
} from "../../backend/adminModelLabService.mjs";
import {
  assertAdminEvidenceSnapshot,
  createAdminEvidenceSnapshot,
} from "../../backend/adminEvidenceSnapshot.mjs";
import {
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "../../backend/adminRunStore.mjs";
import { createMemoryAdminFinalCallBudgetLedger } from "../../backend/adminFinalCallBudgetLedger.mjs";
import { extractRagCards, normalizeCardKey } from "../../backend/ragCardExtractor.mjs";
import { loadRagData, retrieveRagEvidence } from "../../backend/ragEvidenceRetriever.mjs";
import {
  createLegacyLuaUnknownPacket,
  serializeLegacyLuaSemanticPacket,
} from "../../backend/legacyLuaSemanticPacket.mjs";

export const ADMIN_EVIDENCE_DRY_RUN_SCHEMA_VERSION = 1;
export const ADMIN_DRY_RUN_PAID_GATE_BLOCKED = "admin_dry_run_paid_gate_blocked";

export class AdminDryRunPaidGateBlockedError extends Error {
  constructor(details) {
    super("local evidence is incomplete; paid final-model transport is blocked");
    this.name = "AdminDryRunPaidGateBlockedError";
    this.code = ADMIN_DRY_RUN_PAID_GATE_BLOCKED;
    this.outcomeKnown = true;
    this.details = details;
  }
}

export async function readAdminEvidenceDryRunCases(pathOrUrl) {
  const parsed = JSON.parse(await readFile(pathOrUrl, "utf8"));
  return normalizeAdminEvidenceDryRunCases(parsed);
}

export function normalizeAdminEvidenceDryRunCases(value) {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowedRootKeys = new Set(["schemaVersion", "cases"]);
  assertOnlyKeys(root, allowedRootKeys, "cases fixture");
  if (root.schemaVersion !== ADMIN_EVIDENCE_DRY_RUN_SCHEMA_VERSION) {
    throw new TypeError("unsupported admin evidence dry-run cases schemaVersion");
  }
  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    throw new TypeError("admin evidence dry-run cases must be a non-empty array");
  }
  const ids = new Set();
  const questions = new Set();
  const cases = root.cases.map((item, index) => {
    const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    assertOnlyKeys(source, new Set(["id", "question", "candidateCards"]), `cases[${index}]`);
    const id = requiredString(source.id, `cases[${index}].id`);
    const question = requiredString(source.question, `cases[${index}].question`);
    const candidateCards = normalizeStringList(source.candidateCards);
    if (candidateCards.length === 0) {
      throw new TypeError(`cases[${index}].candidateCards must be non-empty`);
    }
    if (ids.has(id)) throw new TypeError(`duplicate dry-run case id: ${id}`);
    if (questions.has(question)) throw new TypeError(`duplicate dry-run question: ${id}`);
    ids.add(id);
    questions.add(question);
    return deepFreeze({ id, question, candidateCards });
  });
  return deepFreeze({
    schemaVersion: ADMIN_EVIDENCE_DRY_RUN_SCHEMA_VERSION,
    cases,
  });
}

/**
 * Runs the real local evidence-preparation path with only injected providers.
 * No process environment credentials, network transport, or golden answers are
 * read. The final provider is a local paid-boundary sentinel: it captures the
 * exact request input, validates visible card text, and either blocks or returns
 * a synthetic queued response without contacting an upstream model.
 */
export async function runAdminEvidenceSnapshotDryRun({
  cases: casesValue,
  casesPath,
  dataDir,
  onCaseArtifacts = null,
  loadData = loadRagData,
  extractCards = extractRagCards,
  retrieveEvidence = retrieveRagEvidence,
  legacyLuaSemanticPacketFactory = null,
  retrievalFetchImpl = null,
  enginePasscodeHydrationEnabled = false,
} = {}) {
  const fixture = casesValue
    ? normalizeAdminEvidenceDryRunCases(casesValue)
    : await readAdminEvidenceDryRunCases(casesPath);
  const caseByQuestion = new Map(fixture.cases.map((item) => [item.question, item]));
  const telemetryById = new Map(fixture.cases.map((item) => [item.id, createTelemetry()]));
  const runStore = createAdminRunStore({
    storage: createMemoryAdminRunStorage(),
    runIdFactory: (() => {
      let sequence = 0;
      return () => `local-evidence-dry-run-${++sequence}`;
    })(),
  });
  let activeCaseId = null;

  const telemetry = () => telemetryById.get(activeCaseId) || null;
  const timed = async (field, operation) => {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      const current = telemetry();
      if (current) current[field] += performance.now() - started;
    }
  };
  const timedSync = (field, operation) => {
    const started = performance.now();
    try {
      return operation();
    } finally {
      const current = telemetry();
      if (current) current[field] += performance.now() - started;
    }
  };

  const offlinePreparationProvider = {
    async prepareEvidence(request) {
      return timed("preparationProviderMs", async () => {
        const payload = parseJsonObject(request?.input);
        const definition = caseByQuestion.get(String(payload.question || ""));
        return {
          provider: "deepseek",
          model: "local-fixture-candidate-extractor",
          result: {
            cardNameCandidates: (definition?.candidateCards || []).map((name) => ({
              name,
              originalText: name,
            })),
            ruleSearchQueries: [],
            unresolvedNotes: [],
            conflicts: [],
          },
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      });
    },
  };

  const localPaidBoundaryProvider = {
    async create(request) {
      const current = telemetry();
      if (current) current.localFinalProviderCreateCount += 1;
      const started = performance.now();
      const finalInput = String(request?.input || "");
      const inputPacket = parseFinalRulingInput(finalInput);
      const definition = caseByQuestion.get(String(inputPacket.question || ""));
      const run = await runStore.getRun(String(request?.metadata?.runId || ""));
      const snapshot = assertAdminEvidenceSnapshot(run?.evidenceSnapshot);
      const inspection = inspectAdminEvidencePaidGate({
        snapshot,
        finalInput,
        candidateCards: definition?.candidateCards || [],
      });
      const elapsed = performance.now() - started;
      if (current) {
        current.finalInput = finalInput;
        current.finalInputSha256 = sha256(finalInput);
        current.gateInspection = inspection;
        current.localGateValidationMs += elapsed;
      }
      if (!inspection.ready) {
        throw new AdminDryRunPaidGateBlockedError({
          caseId: definition?.id || null,
          ...inspection,
        });
      }
      return {
        id: `local-dry-run-request-${request.metadata.runId}`,
        status: "queued",
        model: request.model,
      };
    },
  };

  const offlineEnv = offlineServiceEnvironment({ enginePasscodeHydrationEnabled });
  const dryRunBudgetLedger = createMemoryAdminFinalCallBudgetLedger({
    env: {
      ...offlineEnv,
      // This ledger gates injected local sentinels only. It has no credentials
      // or transport and cannot authorize a production provider call.
      ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY: "100",
      ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY: "1",
      ADMIN_FINAL_BUDGET_OPENAI_DAILY_CNY: "100",
      ADMIN_FINAL_BUDGET_OPENAI_RESERVATION_CNY: "1",
    },
  });
  const service = createAdminModelLabService({
    runStore,
    finalCallBudgetLedger: dryRunBudgetLedger,
    deepSeekProvider: offlinePreparationProvider,
    openAIProvider: localPaidBoundaryProvider,
    env: offlineEnv,
    dataDir,
    loadData: (...args) => timed("loadDataMs", () => loadData(...args)),
    extractCards: (...args) => timedSync("extractCardsMs", () => extractCards(...args)),
    retrieveEvidence: (...args) => timed("retrieveEvidenceMs", () => retrieveEvidence(...args)),
    createEvidenceSnapshot: (...args) => timedSync("snapshotBuildMs", () => (
      createAdminEvidenceSnapshot(...args)
    )),
    retrievalFetchImpl: async (url, init) => {
      const current = telemetry();
      if (current) {
        current.externalFetchAttemptCount += 1;
        current.externalFetchUrls.push(String(url));
      }
      if (typeof retrievalFetchImpl === "function") {
        if (current) current.externalFetchAllowedCount += 1;
        return retrievalFetchImpl(url, init);
      }
      if (current) current.externalFetchBlockedCount += 1;
      return new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
    legacyLuaSemanticPacketFactory: async (input) => timed("legacyLuaMs", async () => {
      if (typeof legacyLuaSemanticPacketFactory === "function") {
        return legacyLuaSemanticPacketFactory(input);
      }
      return createLegacyLuaUnknownPacket({
        code: "LOCAL_DRY_RUN_LUA_UNAVAILABLE",
        message: "local dry-run did not contact a live Lua engine",
        details: { retryable: false },
      });
    }),
  });

  const reports = [];
  for (const definition of fixture.cases) {
    activeCaseId = definition.id;
    const current = telemetry();
    const caseStarted = performance.now();
    const created = await service.createRun({
      body: {
        question: definition.question,
        label: definition.id,
        source: "local_evidence_snapshot_dry_run",
        provider: "openai",
        finalAttemptPolicy: "single",
      },
    });
    let execution;
    try {
      execution = await service.executeRun({ runId: created.runId });
    } catch (error) {
      if (error?.code !== "admin_final_evidence_not_ready") throw error;
      const failedRun = await runStore.getRun(created.runId);
      if (!failedRun?.evidenceSnapshot) throw error;
      // A readiness failure is the expected result for an incomplete offline
      // snapshot. Keep the failed, frozen run for diagnostics instead of
      // weakening the production pre-transport gate or invoking the sentinel.
      execution = { run: failedRun, providerRequest: null };
    }
    current.totalWallClockMs = performance.now() - caseStarted;
    const run = execution.run;
    const snapshot = assertAdminEvidenceSnapshot(run.evidenceSnapshot);
    const independentlySerializedInput = buildFinalRulingInput(snapshot);
    if (current.finalInput && current.finalInput !== independentlySerializedInput) {
      throw new Error(`captured final input changed after freezing evidence: ${definition.id}`);
    }
    const inspection = current.gateInspection || inspectAdminEvidencePaidGate({
      snapshot,
      finalInput: independentlySerializedInput,
      candidateCards: definition.candidateCards,
    });
    const report = createCaseReport({
      definition,
      run,
      snapshot,
      finalInput: current.finalInput || independentlySerializedInput,
      inspection,
      telemetry: current,
    });
    reports.push(report);
    if (typeof onCaseArtifacts === "function") {
      await onCaseArtifacts({
        definition,
        run,
        snapshot,
        finalInput: current.finalInput || independentlySerializedInput,
        report,
      });
    }
  }
  activeCaseId = null;

  return deepFreeze({
    schemaVersion: ADMIN_EVIDENCE_DRY_RUN_SCHEMA_VERSION,
    mode: typeof retrievalFetchImpl === "function"
      ? "ALLOWLISTED_EVIDENCE_NETWORK_ZERO_MODEL_COST"
      : "LOCAL_ONLY_ZERO_COST",
    legacyLuaMode: typeof legacyLuaSemanticPacketFactory === "function"
      ? "INJECTED_LOCAL_ENGINE"
      : "UNAVAILABLE",
    enginePasscodeHydrationEnabled:
      enginePasscodeHydrationEnabled === true,
    liveNetworkAllowed: typeof retrievalFetchImpl === "function",
    realProviderTransportCalls: 0,
    caseCount: reports.length,
    allSnapshotsFrozen: reports.every((item) => item.snapshot.frozen),
    allPaidTransportsPrevented: reports.every((item) => item.transport.realProviderCalls === 0),
    reports,
  });
}

export function inspectAdminEvidencePaidGate({ snapshot, finalInput, candidateCards }) {
  assertAdminEvidenceSnapshot(snapshot);
  const packet = parseFinalRulingInput(finalInput);
  if (packet.evidenceSnapshotId !== snapshot.snapshotId
    || packet.evidenceSnapshotSha256 !== snapshot.contentSha256) {
    throw new TypeError("final input is not bound to the supplied Evidence Snapshot");
  }
  const candidates = normalizeStringList(candidateCards);
  const resolvedCards = Array.isArray(snapshot.evidence?.cardResolution?.resolvedCards)
    ? snapshot.evidence.cardResolution.resolvedCards
    : [];
  const userProvided = Array.isArray(snapshot.evidence?.cardResolution?.userProvidedCardTexts)
    ? snapshot.evidence.cardResolution.userProvidedCardTexts
    : [];
  const visibleItems = Array.isArray(packet.evidenceDecisionPacket?.evidenceItems)
    ? packet.evidenceDecisionPacket.evidenceItems
    : [];
  const bindings = candidates.map((candidate) => inspectCandidateBinding({
    candidate,
    resolvedCards,
    userProvided,
    visibleItems,
  }));
  const unresolvedCandidates = bindings
    .filter((item) => item.bindingStatus !== "RESOLVED")
    .map((item) => item.candidate);
  const missingVisibleCardTexts = bindings
    .filter((item) => item.bindingStatus === "RESOLVED" && !item.visibleCardText)
    .map((item) => item.candidate);
  const incompleteVisibleCardTexts = bindings
    .filter((item) => item.bindingStatus === "RESOLVED" && item.visibleCardTextExcerpted)
    .map((item) => item.candidate);
  return deepFreeze({
    ready: unresolvedCandidates.length === 0
      && missingVisibleCardTexts.length === 0
      && incompleteVisibleCardTexts.length === 0,
    candidateCount: candidates.length,
    bindings,
    unresolvedCandidates,
    missingVisibleCardTexts,
    incompleteVisibleCardTexts,
  });
}

function inspectCandidateBinding({
  candidate,
  resolvedCards,
  userProvided,
  visibleItems,
}) {
  const key = normalizeCardKey(candidate);
  const matchingCards = resolvedCards.filter((card) => cardNameKeys(card).has(key));
  const matchingProvided = userProvided.filter((item) => (
    normalizeCardKey(item?.name) === key && String(item?.text || "").trim()
  ));
  if (matchingCards.length + matchingProvided.length !== 1) {
    return {
      candidate,
      bindingStatus: matchingCards.length + matchingProvided.length > 1
        ? "AMBIGUOUS"
        : "UNRESOLVED",
      cardId: null,
      resolvedName: null,
      source: null,
      visibleCardText: false,
      visibleCardTextExcerpted: false,
    };
  }
  if (matchingCards.length === 1) {
    const card = matchingCards[0];
    const cardId = String(card.id || card.cardId || "");
    const visible = visibleItems.find((item) => (
      item?.category === "parsed_card_text"
      && itemEvidenceIds(item).has(cardId)
      && String(item.body || "").trim()
    ));
    return {
      candidate,
      bindingStatus: "RESOLVED",
      cardId: cardId || null,
      resolvedName: card.name || card.cnName || card.input || candidate,
      source: "local_card_database",
      visibleCardText: Boolean(visible),
      visibleCardTextExcerpted: visible?.bodyExcerpted === true,
    };
  }
  const supplied = matchingProvided[0];
  const suppliedText = String(supplied.text || "").trim();
  const visible = visibleItems.find((item) => (
    item?.category === "parsed_card_text"
    && item?.bodyExcerpted !== true
    && String(item.body || "").trim() === suppliedText
  ));
  return {
    candidate,
    bindingStatus: "RESOLVED",
    cardId: null,
    resolvedName: supplied.name,
    source: "user_provided_card_text",
    visibleCardText: Boolean(visible),
    visibleCardTextExcerpted: false,
  };
}

function createCaseReport({ definition, run, snapshot, finalInput, inspection, telemetry }) {
  const archive = snapshot.evidence?.evidenceArchive || {};
  const occurrenceCategories = countBy(
    archive.occurrences || [],
    (item) => String(item?.category || "other"),
  );
  const legacyPacket = snapshot.evidence?.legacyLuaSemanticPacket || null;
  const legacyBytes = legacyPacket
    ? Buffer.byteLength(serializeLegacyLuaSemanticPacket(legacyPacket), "utf8")
    : 0;
  const stages = Array.isArray(run.stageTiming?.stages) ? run.stageTiming.stages : [];
  const stage = (id) => stages.find((item) => item.id === id) || null;
  const resolvedCards = (snapshot.evidence?.cardResolution?.resolvedCards || []).map((card) => ({
    id: String(card.id || card.cardId || "") || null,
    cid: String(card.cid || "") || null,
    passcode: String(card.passcode || card.password || "") || null,
    name: card.name || card.cnName || card.input || null,
    input: card.input || null,
    resolutionSource: card.resolutionSource || null,
    confidence: Number.isFinite(Number(card.confidence)) ? Number(card.confidence) : null,
    numberedIdentityNameMismatch: card.numberedIdentityNameMismatch === true,
  }));
  return {
    id: definition.id,
    resolvedCards,
    missing: {
      unresolvedCandidates: inspection.unresolvedCandidates,
      missingVisibleCardTexts: inspection.missingVisibleCardTexts,
      incompleteVisibleCardTexts: inspection.incompleteVisibleCardTexts,
    },
    candidateBindings: inspection.bindings,
    evidenceCounts: {
      faq: (occurrenceCategories.direct_official_qa || 0)
        + (occurrenceCategories.related_qa || 0),
      rules: occurrenceCategories.mechanism_rule || 0,
      visiblePacketItems:
        snapshot.evidence?.evidenceDecisionPacket?.modelPacket?.evidenceItems?.length || 0,
    },
    lua: {
      status: legacyLuaStatus(legacyPacket),
      verdict: legacyPacket?.verdict || "UNKNOWN",
      resourceCount: legacyPacket?.resources?.length || 0,
      candidateCount: legacyPacket?.effectCandidates?.length || 0,
      unknownReasonCodes: (legacyPacket?.unknownReasons || []).map((item) => item.code),
      unknownReasonMessages: (legacyPacket?.unknownReasons || []).map((item) => item.message),
      serializedBytes: legacyBytes,
    },
    snapshot: {
      id: snapshot.snapshotId,
      sha256: snapshot.contentSha256,
      bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
      frozen: Object.isFrozen(snapshot),
    },
    finalInput: {
      sha256: sha256(finalInput),
      bytes: Buffer.byteLength(finalInput, "utf8"),
    },
    timingsMs: {
      understand: durationOf(stage("understand")),
      cardNameResolution: durationOf(stage("extract_card_names")),
      cardTextRetrieval: durationOf(stage("retrieve_card_texts")),
      qaAndRuleRetrieval: durationOf(stage("retrieve_rulings_evidence")),
      luaSemantic: rounded(telemetry.legacyLuaMs),
      snapshotBuild: rounded(telemetry.snapshotBuildMs),
      finalInputAndPaidGate: durationOf(stage("generate_ruling")),
      localPaidGateValidation: rounded(telemetry.localGateValidationMs),
      preparationProvider: rounded(telemetry.preparationProviderMs),
      dataLoad: rounded(telemetry.loadDataMs),
      total: rounded(telemetry.totalWallClockMs),
    },
    paidGateBlocked: !inspection.ready,
    paidGateCode: inspection.ready ? null : ADMIN_DRY_RUN_PAID_GATE_BLOCKED,
    transport: {
      localFinalProviderCreateCount: telemetry.localFinalProviderCreateCount,
      realProviderCalls: 0,
      externalFetchAttemptCount: telemetry.externalFetchAttemptCount,
      externalFetchAllowedCount: telemetry.externalFetchAllowedCount,
      externalFetchBlockedCount: telemetry.externalFetchBlockedCount,
      allExternalFetchesIntercepted:
        telemetry.externalFetchAttemptCount === telemetry.externalFetchBlockedCount,
    },
  };
}

function createTelemetry() {
  return {
    loadDataMs: 0,
    extractCardsMs: 0,
    retrieveEvidenceMs: 0,
    snapshotBuildMs: 0,
    preparationProviderMs: 0,
    legacyLuaMs: 0,
    localGateValidationMs: 0,
    totalWallClockMs: 0,
    localFinalProviderCreateCount: 0,
    externalFetchAttemptCount: 0,
    externalFetchAllowedCount: 0,
    externalFetchBlockedCount: 0,
    externalFetchUrls: [],
    finalInput: "",
    finalInputSha256: null,
    gateInspection: null,
  };
}

function offlineServiceEnvironment({ enginePasscodeHydrationEnabled = false } = {}) {
  return {
    ADMIN_MODEL_LAB_ENABLED: "true",
    ADMIN_OPENAI_ENABLED: "true",
    ADMIN_MODEL_LAB_LIMITS_ENABLED: "false",
    ADMIN_MODEL_LAB_LIVE_OFFICIAL_QA: "false",
    RAG_LIVE_OFFICIAL_QA: "false",
    // The URL is only an internal feature signal consumed by the retriever.
    // The live Lua transport remains the separately injected, loopback-only
    // packet factory, so no URL or credential is introduced here.
    ...(enginePasscodeHydrationEnabled === true
      ? { OCG_ENGINE_URL: "http://127.0.0.1" }
      : {}),
    OPENAI_API_KEY: "offline-placeholder-never-transported",
    DEEPSEEK_API_KEY: "offline-placeholder-never-transported",
    // Offline sentinels still exercise the same pre-transport cost envelope.
    // Versioned test rates keep that calculation deterministic without making
    // any real provider request.
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION: "offline-test-deepseek-v4",
    ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE: "2026-08-06",
    ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK: "1",
    ADMIN_MODEL_LAB_DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK: "2",
    ADMIN_MODEL_LAB_DEEPSEEK_PRO_INPUT_CNY_PER_MTOK: "3",
    ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK: "6",
  };
}

function parseFinalRulingInput(input) {
  const line = String(input || "").split("\n").at(-1) || "";
  const parsed = parseJsonObject(line);
  if (parsed.schemaVersion !== 1 || !parsed.evidenceSnapshotId) {
    throw new TypeError("final ruling input does not contain a valid bounded snapshot packet");
  }
  return parsed;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cardNameKeys(card) {
  return new Set([
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.enName,
    ...(Array.isArray(card?.aliases) ? card.aliases : []),
  ].map(normalizeCardKey).filter(Boolean));
}

function itemEvidenceIds(item) {
  return new Set([
    item?.evidenceId,
    ...(Array.isArray(item?.evidenceIds) ? item.evidenceIds : []),
  ].map((value) => String(value || "")).filter(Boolean));
}

function legacyLuaStatus(packet) {
  if (!packet) return "UNAVAILABLE";
  if ((packet.effectCandidates || []).length > 0) return "ANALYZED";
  if ((packet.unknownReasons || []).length > 0) return "TYPED_UNKNOWN";
  return "EMPTY";
}

function countBy(values, keyOf) {
  const result = {};
  for (const value of values) {
    const key = keyOf(value);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function durationOf(stage) {
  return stage && Number.isFinite(Number(stage.durationMs))
    ? rounded(Number(stage.durationMs))
    : null;
}

function rounded(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function assertOnlyKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unsupported fields: ${extras.join(", ")}`);
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
