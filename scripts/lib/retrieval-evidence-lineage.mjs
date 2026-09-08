import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { extractRagCards } from "../../backend/ragCardExtractor.mjs";
import {
  loadRagData,
  retrieveRagEvidence,
} from "../../backend/ragEvidenceRetriever.mjs";
import { getTrustedRagDataRevision } from "../../backend/ragDataRevisionManifest.mjs";
import { buildRagRulingPromptBundle } from "../../backend/ragRulingPrompt.mjs";

export const PUBLIC_RAG_LINEAGE_MODE =
  "PRIVATE_RAG_LOCAL_OFFLINE_OBSERVATION_REPLAY";

export const PUBLIC_RAG_LINEAGE_BOUNDARIES = Object.freeze({
  OBSERVED: "OBSERVED",
  SOURCE_REQUEST_LIMIT: "SOURCE_REQUEST_LIMIT",
  UNOBSERVABLE_PRE_LIMIT: "UNOBSERVABLE_PRE_LIMIT",
});

const CAPTURE_CASE_STATUSES = new Set([
  "captured_for_manual_review",
  "captured_official_qa_exact_direct",
]);

const TRUSTED_IDENTITY_REPLAY_KIND = "trusted-current-card-identity-replay";
const TRUSTED_IDENTITY_REPLAY_SCHEMA_VERSION = 2;
const TRUSTED_IDENTITY_REPLAY_CLASSIFICATIONS = Object.freeze([
  "OLD_UNTRUSTED_EXTRA_IDENTITY",
  "CURRENT_RESOLVER_MISS",
  "PROVENANCE_ONLY_GAP",
  "CONTENT_OR_VERSION_MISMATCH",
]);
const TRUSTED_IDENTITY_REPLAY_CLASSIFICATION_SET = new Set(
  TRUSTED_IDENTITY_REPLAY_CLASSIFICATIONS,
);
const TRUSTED_IDENTITY_REPLAY_BINDING_INVALID =
  "trusted_identity_replay_regression_binding_invalid";
const TRUSTED_IDENTITY_REPLAY_CONFIRMED_IDENTITY_REGRESSION =
  "trusted_identity_replay_confirmed_identity_regression";
const TRUSTED_IDENTITY_REPLAY_RESOLUTION_SOURCES = new Set([
  "query",
  "external_identity_verification",
]);
const TRUSTED_IDENTITY_REPLAY_VERIFICATION_STATUSES = new Set([
  "verified_same_identity",
  "verified_external_replacement",
  "verified_external_resolution",
]);
const TRUSTED_REPLAY_CASE_ATTESTATIONS = new WeakSet();
const TRUSTED_FROZEN_RESOLUTION_ATTESTATIONS = new WeakSet();
const TRUSTED_FROZEN_CARD_ATTESTATIONS = new WeakSet();

const RETRIEVER_BUCKETS = Object.freeze([
  "cardTexts",
  "userProvidedCardTexts",
  "officialQaDirectCandidates",
  "officialQaRelated",
  "provisionalOfficialResponses",
  "faqRelated",
  "rawRelatedEvidence",
  "rulebookCandidates",
]);

const SNAPSHOT_ITEM_FIELDS = Object.freeze([
  ["returnedItems", "returnedIds", "returnedRefs"],
  ["beforeItems", "beforeIds", "beforeRefs"],
  ["afterItems", "afterIds", "afterRefs"],
]);

export function normalizePublicRagReplayCases(cases = []) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new TypeError("offline capture replay requires at least one case");
  }
  const seen = new Set();
  return Object.freeze(cases.map((rawCase, index) => {
    const item = rawCase && typeof rawCase === "object" ? rawCase : {};
    const id = requiredString(item.id, `cases[${index}].id`);
    const question = requiredString(item.question, `cases[${index}].question`);
    if (seen.has(id)) throw new TypeError(`duplicate offline replay case: ${id}`);
    seen.add(id);
    return Object.freeze({
      id,
      question,
      questionSha256: sha256(question),
      captureStatus: String(item.captureStatus || "captured_for_manual_review"),
      captureSnapshotSha256: String(item.captureSnapshotSha256 || ""),
      captureDataRevision: String(item.captureDataRevision || ""),
      modelCardNameCandidates: Object.freeze(normalizeObjects(item.modelCardNameCandidates)),
      modelRuleSearchQueries: Object.freeze(normalizeObjects(item.modelRuleSearchQueries)),
      modelRuleCandidateAssessments: Object.freeze(
        normalizeObjects(item.modelRuleCandidateAssessments),
      ),
      frozenResolvedCards: Object.freeze(normalizeObjects(item.frozenResolvedCards)),
      frozenUnresolvedMentions: Object.freeze(normalizeObjects(item.frozenUnresolvedMentions)),
      frozenAmbiguousMentions: Object.freeze(normalizeObjects(item.frozenAmbiguousMentions)),
    });
  }));
}

export function createFrozenCardResolutionReplayInput(replayCase) {
  if (!replayCase || typeof replayCase !== "object" || Array.isArray(replayCase)) {
    throw new TypeError("frozen replay case must be an object");
  }
  const value = Object.freeze({
    questionSha256: String(replayCase.questionSha256 || ""),
    dataRevision: String(replayCase.captureDataRevision || ""),
    resolvedCards: Object.freeze([...(replayCase.frozenResolvedCards || [])]),
    unresolvedMentions: Object.freeze([...(replayCase.frozenUnresolvedMentions || [])]),
    ambiguousMentions: Object.freeze([...(replayCase.frozenAmbiguousMentions || [])]),
  });
  if (TRUSTED_REPLAY_CASE_ATTESTATIONS.has(replayCase)) {
    TRUSTED_FROZEN_RESOLUTION_ATTESTATIONS.add(value);
  }
  return value;
}

export function hasTrustedFrozenCardResolutionAttestation(value) {
  return Boolean(value && TRUSTED_FROZEN_RESOLUTION_ATTESTATIONS.has(value));
}

export function attestTrustedFrozenResolvedCard(frozenResolution, sourceCard, {
  canonicalCard,
  resolutionSource,
} = {}) {
  const sourceIds = frozenReplayIdentityKeys(sourceCard);
  const canonicalIds = new Set(frozenReplayIdentityKeys(canonicalCard));
  const sourceResolution = String(sourceCard?.resolutionSource || "");
  const verification = String(sourceCard?.identityVerificationStatus || "");
  if (!hasTrustedFrozenCardResolutionAttestation(frozenResolution)
      || !Array.isArray(frozenResolution.resolvedCards)
      || !frozenResolution.resolvedCards.includes(sourceCard)
      || !canonicalCard
      || typeof canonicalCard !== "object"
      || Array.isArray(canonicalCard)
      || !sourceIds.some((id) => canonicalIds.has(id))
      || String(resolutionSource || "") !== "external_identity_verification"
      || !TRUSTED_IDENTITY_REPLAY_VERIFICATION_STATUSES.has(verification)
      || !(
        sourceResolution === "external_identity_verification"
        || (!sourceResolution && String(sourceCard?.source || "") === "baige")
      )) {
    throw new Error("trusted_frozen_card_attestation_invalid");
  }
  const normalizedCard = Object.freeze({
    ...canonicalCard,
    aliases: Object.freeze([...(Array.isArray(canonicalCard.aliases)
      ? canonicalCard.aliases : [])]),
    imageCandidates: Object.freeze([...(Array.isArray(canonicalCard.imageCandidates)
      ? canonicalCard.imageCandidates : [])]),
    input: String(sourceCard.input || ""),
    matchedQuery: String(sourceCard.matchedQuery || ""),
    source: String(sourceCard.source || ""),
    resolutionSource: "external_identity_verification",
    identityVerificationStatus: verification,
    identityMatchKind: String(sourceCard.identityMatchKind || ""),
    retrievalIdentityMatchKind: String(sourceCard.retrievalIdentityMatchKind || ""),
    requiresExternalIdentityVerification:
      sourceCard.requiresExternalIdentityVerification === true,
    identityCanonicalizationConflict: false,
  });
  TRUSTED_FROZEN_CARD_ATTESTATIONS.add(normalizedCard);
  return normalizedCard;
}

export function hasTrustedFrozenResolvedCardAttestation(card) {
  return Boolean(card && TRUSTED_FROZEN_CARD_ATTESTATIONS.has(card));
}

export async function loadFrozenPublicRagCaptureReplayCases({
  snapshotPath,
  caseIds = [],
  readFileImpl = readFile,
} = {}) {
  const path = requiredString(snapshotPath, "snapshotPath");
  const rawSnapshot = await readFileImpl(path, "utf8");
  const snapshot = JSON.parse(rawSnapshot);
  const trustedIdentityReplayAttested = enforceTrustedIdentityReplayRegressionGate(snapshot);
  if (snapshot?.kind !== "frozen_public_rag_evidence_capture"
      || snapshot?.status !== "complete") {
    throw new TypeError("snapshot must be a completed evidence-only capture");
  }
  if (Number(snapshot?.finalModelCallCount) !== 0) {
    throw new Error("evidence-only capture must have zero final-model calls");
  }
  const records = Array.isArray(snapshot?.cases) ? snapshot.cases : [];
  if (!records.length) throw new TypeError("capture snapshot contains no cases");
  const selectedIds = normalizeStrings(caseIds);
  const selectedSet = new Set(selectedIds);
  const seen = new Set();
  const cases = [];
  const captureSnapshotSha256 = sha256(rawSnapshot);
  const captureDataRevision = firstString([
    snapshot?.dataRevision,
    snapshot?.ragDataRevision,
    snapshot?.sourceDataRevision,
    snapshot?.metadata?.dataRevision,
    snapshot?.metadata?.ragDataRevision,
    snapshot?.retrievalDataRevision,
  ]);

  for (const [index, record] of records.entries()) {
    const id = requiredString(record?.id, `snapshot.cases[${index}].id`);
    if (seen.has(id)) throw new TypeError(`duplicate capture case: ${id}`);
    seen.add(id);
    if (selectedSet.size && !selectedSet.has(id)) continue;
    if (!CAPTURE_CASE_STATUSES.has(String(record?.status || ""))) {
      throw new Error(`${id} is not a completed manual-review capture case`);
    }
    const question = requiredString(record?.question, `${id}.question`);
    if (String(record?.questionSha256 || "") !== sha256(question)) {
      throw new Error(`${id} question hash mismatch`);
    }
    const trace = record?.manualReviewTrace;
    if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
      throw new Error(`${id} has no manual review trace`);
    }
    cases.push({
      id,
      question,
      captureStatus: record.status,
      captureSnapshotSha256,
      captureDataRevision: firstString([
        record?.dataRevision,
        record?.ragDataRevision,
        trace?.dataRevision,
        captureDataRevision,
      ]),
      modelCardNameCandidates: trace.modelCardNameCandidates,
      modelRuleSearchQueries: trace.modelRuleSearchQueries,
      modelRuleCandidateAssessments: trace.modelRuleCandidateAssessments,
      frozenResolvedCards: trace.resolvedCards,
      frozenUnresolvedMentions: trace.unresolvedMentions,
      frozenAmbiguousMentions: trace.ambiguousMentions,
    });
  }
  if (selectedSet.size) {
    const missing = selectedIds.filter((id) => !seen.has(id));
    if (missing.length) throw new TypeError("requested capture cases were not found");
  }
  const normalizedCases = normalizePublicRagReplayCases(cases);
  if (trustedIdentityReplayAttested) {
    for (const replayCase of normalizedCases) {
      TRUSTED_REPLAY_CASE_ATTESTATIONS.add(replayCase);
    }
  }
  return normalizedCases;
}

export async function runPublicRagEvidenceLineageReplay({
  cases,
  dataDir,
  env = {},
  loadData = loadRagData,
  extractCards = extractRagCards,
  retrieveEvidence = retrieveRagEvidence,
  buildPrompt = buildRagRulingPromptBundle,
  getDataRevision = getTrustedRagDataRevision,
} = {}) {
  const normalizedCases = normalizePublicRagReplayCases(cases);
  const telemetry = {
    frozenRulePlanProviderCalls: 0,
    blockedNetworkAttempts: 0,
    retrievals: 0,
    productionFinalRulingModelCalls: 0,
    offlineEvidenceAuditModelCalls: 0,
  };
  const unavailableFetch = async () => {
    telemetry.blockedNetworkAttempts += 1;
    const error = new Error("offline lineage replay blocked a network attempt");
    error.code = "LINEAGE_NETWORK_BLOCKED";
    throw error;
  };
  const data = await loadData(dataDir);
  const localDataRevision = String(getDataRevision(data) || "");
  const privateBodies = {};
  const privateCases = [];
  const sanitizedCases = [];

  for (const replayCase of normalizedCases) {
    const rawEvents = [];
    const lineageTraceSink = (event) => { rawEvents.push(event); };
    const networkAttemptsBefore = telemetry.blockedNetworkAttempts;
    try {
      const extractedCardResolution = extractCards(replayCase.question, {
        cards: data?.cards || [],
        maxCards: positiveInteger(env.RAG_MAX_CARDS, 6),
        modelCardNameCandidates: replayCase.modelCardNameCandidates,
      });
      const frozenPrimaryCards = replayCase.frozenResolvedCards
        .filter((card) => card?.resolutionSource !== "card_text_reference");
      const cardResolution = frozenPrimaryCards.length
        ? {
            ...extractedCardResolution,
            resolvedCards: frozenPrimaryCards,
            unresolvedMentions: replayCase.frozenUnresolvedMentions,
            ambiguousMentions: replayCase.frozenAmbiguousMentions,
          }
        : extractedCardResolution;
      const evidence = await retrieveEvidence({
        userQuery: replayCase.question,
        cardResolution,
        dataDir,
        cards: data?.cards,
        records: data?.records,
        qaRecords: data?.qaRecords,
        enableLiveOfficialQa: false,
        subsumptionCandidatePoolComplete: true,
        ruleSearchQueryProvider: async () => {
          telemetry.frozenRulePlanProviderCalls += 1;
          return {
            queries: replayCase.modelRuleSearchQueries,
            candidateAssessments: replayCase.modelRuleCandidateAssessments,
          };
        },
        env: { ...env, RAG_LIVE_OFFICIAL_QA: "false" },
        fetchImpl: unavailableFetch,
        lineageTraceSink,
      });
      telemetry.retrievals += 1;
      const effectiveCardResolution = evidence?.cardResolution || cardResolution;
      const promptBundle = buildPrompt({
        userQuery: replayCase.question,
        cardResolution: effectiveCardResolution,
        evidence,
        env,
        lineageTraceSink,
      });
      const privateEvents = materializePrivateEvents(rawEvents, privateBodies);
      const sanitized = sanitizeLineageEvents(privateEvents);
      const networkAttemptCount = telemetry.blockedNetworkAttempts - networkAttemptsBefore;
      privateCases.push({
        id: replayCase.id,
        questionSha256: replayCase.questionSha256,
        captureSnapshotSha256: replayCase.captureSnapshotSha256,
        captureDataRevision: replayCase.captureDataRevision,
        localDataRevision,
        events: privateEvents,
      });
      sanitizedCases.push({
        id: replayCase.id,
        replayStatus: "OBSERVED",
        questionSha256: replayCase.questionSha256,
        captureSnapshotSha256: replayCase.captureSnapshotSha256,
        captureDataRevision: replayCase.captureDataRevision,
        localDataRevision,
        eventCount: sanitized.events.length,
        stageCounts: countBy(sanitized.events, (event) => event.stage),
        eventTypeCounts: countBy(sanitized.events, (event) => event.type),
        sourceRequestLimits: sanitized.events.filter((event) => (
          event.type === "SOURCE_REQUEST" || event.type === "SOURCE_RETURNED"
        )),
        boundaryCounts: countBy(sanitized.events, (event) => event.boundaryClassification),
        firstObservableCandidateLoss: sanitized.firstObservableCandidateLoss,
        events: sanitized.events,
        bucketCounts: bucketCounts(evidence, RETRIEVER_BUCKETS),
        promptByteLength: Buffer.byteLength(String(promptBundle?.prompt || ""), "utf8"),
        promptSha256: sha256(String(promptBundle?.prompt || "")),
        networkAttemptCount,
        productionFinalRulingModelCalls: 0,
        offlineEvidenceAuditModelCalls: 0,
      });
    } catch (error) {
      const privateEvents = materializePrivateEvents(rawEvents, privateBodies);
      const sanitized = sanitizeLineageEvents(privateEvents);
      privateCases.push({
        id: replayCase.id,
        questionSha256: replayCase.questionSha256,
        captureSnapshotSha256: replayCase.captureSnapshotSha256,
        captureDataRevision: replayCase.captureDataRevision,
        localDataRevision,
        failureCode: sanitizeFailureCode(error?.code),
        events: privateEvents,
      });
      sanitizedCases.push({
        id: replayCase.id,
        replayStatus: "REPLAY_FAILED",
        questionSha256: replayCase.questionSha256,
        captureSnapshotSha256: replayCase.captureSnapshotSha256,
        captureDataRevision: replayCase.captureDataRevision,
        localDataRevision,
        failureCode: sanitizeFailureCode(error?.code),
        eventCount: sanitized.events.length,
        stageCounts: countBy(sanitized.events, (event) => event.stage),
        eventTypeCounts: countBy(sanitized.events, (event) => event.type),
        sourceRequestLimits: sanitized.events.filter((event) => (
          event.type === "SOURCE_REQUEST" || event.type === "SOURCE_RETURNED"
        )),
        boundaryCounts: countBy(sanitized.events, (event) => event.boundaryClassification),
        firstObservableCandidateLoss: sanitized.firstObservableCandidateLoss,
        events: sanitized.events,
        networkAttemptCount: telemetry.blockedNetworkAttempts - networkAttemptsBefore,
        productionFinalRulingModelCalls: 0,
        offlineEvidenceAuditModelCalls: 0,
      });
    }
  }

  const privateBundle = {
    schemaVersion: 1,
    kind: "private_rag_lineage_observation_bundle",
    mode: PUBLIC_RAG_LINEAGE_MODE,
    localDataRevision,
    captureSnapshotSha256: normalizedCases[0]?.captureSnapshotSha256 || "",
    cases: privateCases,
    bodies: privateBodies,
    productionFinalRulingModelCalls: 0,
    offlineEvidenceAuditModelCalls: 0,
  };
  const report = {
    schemaVersion: 1,
    mode: PUBLIC_RAG_LINEAGE_MODE,
    caseCount: sanitizedCases.length,
    localDataRevision,
    captureSnapshotSha256: normalizedCases[0]?.captureSnapshotSha256 || "",
    telemetry: {
      ...telemetry,
      noNetworkAttemptObserved: telemetry.blockedNetworkAttempts === 0,
    },
    replayStatusCounts: countBy(sanitizedCases, (item) => item.replayStatus),
    cases: sanitizedCases,
  };
  return { report, privateBundle };
}

export function sanitizeLineageEvents(privateEvents = []) {
  const aliasById = new Map();
  const aliasFor = (value) => {
    const id = String(value || "");
    if (!aliasById.has(id)) {
      aliasById.set(id, `E${String(aliasById.size + 1).padStart(4, "0")}`);
    }
    return aliasById.get(id);
  };
  const sanitized = privateEvents.map((event, index) => {
    const returned = sanitizeRefs(event.returnedRefs, aliasFor);
    const before = sanitizeRefs(event.beforeRefs, aliasFor);
    const after = sanitizeRefs(event.afterRefs, aliasFor);
    const requestLimit = positiveIntegerOrNull(event.requestLimit);
    const returnedCount = nonNegativeIntegerOrNull(event.returnedCount);
    const boundaryClassification = event.type === "SOURCE_RETURNED"
      && requestLimit !== null && returnedCount !== null && returnedCount >= requestLimit
      ? PUBLIC_RAG_LINEAGE_BOUNDARIES.SOURCE_REQUEST_LIMIT
      : event.preLimitObservable === false
        ? PUBLIC_RAG_LINEAGE_BOUNDARIES.UNOBSERVABLE_PRE_LIMIT
        : PUBLIC_RAG_LINEAGE_BOUNDARIES.OBSERVED;
    return {
      sequence: index + 1,
      type: String(event.type || "UNKNOWN"),
      stage: String(event.stage || "unknown"),
      channel: String(event.channel || ""),
      requestLimit,
      requestCharLimit: positiveIntegerOrNull(event.requestCharLimit),
      requestLimitProvenance: String(event.requestLimitProvenance || "UNRECORDED"),
      preLimitObservable: typeof event.preLimitObservable === "boolean"
        ? event.preLimitObservable
        : null,
      returnedCount,
      beforeCount: nonNegativeIntegerOrNull(event.beforeCount),
      afterCount: nonNegativeIntegerOrNull(event.afterCount),
      returned,
      before,
      after,
      compacted: typeof event.compacted === "boolean" ? event.compacted : null,
      preCompactPromptChars: nonNegativeIntegerOrNull(event.preCompactPromptChars),
      observedPromptChars: nonNegativeIntegerOrNull(event.observedPromptChars),
      boundaryClassification,
      ...(event.limits && typeof event.limits === "object"
        ? { limits: sanitizeNumericObject(event.limits) }
        : {}),
    };
  });
  return {
    events: sanitized,
    firstObservableCandidateLoss: firstObservableCandidateLoss(sanitized),
  };
}

function materializePrivateEvents(events = [], bodyMap = {}) {
  return events.map((event, index) => {
    const materialized = {
      ...event,
      sequence: index + 1,
    };
    for (const [itemsField, idsField, refsField] of SNAPSHOT_ITEM_FIELDS) {
      const items = Array.isArray(materialized[itemsField]) ? materialized[itemsField] : null;
      if (!items) continue;
      const ids = Array.isArray(materialized[idsField]) ? materialized[idsField] : [];
      materialized[refsField] = items.map((item, itemIndex) => {
        const normalizedBody = normalizeJsonBody(item);
        const bodySha256 = sha256(canonicalJson(normalizedBody));
        if (!Object.hasOwn(bodyMap, bodySha256)) bodyMap[bodySha256] = normalizedBody;
        return {
          id: String(ids[itemIndex] || `unidentified:${itemIndex + 1}`),
          bodySha256,
        };
      });
      delete materialized[itemsField];
    }
    return materialized;
  });
}

function sanitizeRefs(refs, aliasFor) {
  return (Array.isArray(refs) ? refs : []).map((ref) => ({
    alias: aliasFor(ref?.id),
    identitySha256: sha256(String(ref?.id || "")),
    bodySha256: String(ref?.bodySha256 || ""),
  }));
}

function firstObservableCandidateLoss(events = []) {
  for (const event of events) {
    if (!event.before.length || event.beforeCount === null || event.afterCount === null) continue;
    const afterAliases = new Set(event.after.map((item) => item.alias));
    const lost = event.before.filter((item) => !afterAliases.has(item.alias));
    if (!lost.length) continue;
    return {
      sequence: event.sequence,
      type: event.type,
      stage: event.stage,
      channel: event.channel,
      beforeCount: event.beforeCount,
      afterCount: event.afterCount,
      lostCount: lost.length,
      lost,
    };
  }
  return null;
}

function normalizeJsonBody(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sanitizeNumericObject(value = {}) {
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => Number.isFinite(Number(item)))
    .map(([key, item]) => [key, Number(item)]));
}

function bucketCounts(value, buckets) {
  return Object.fromEntries((buckets || []).map((bucket) => [
    bucket,
    Array.isArray(value?.[bucket]) ? value[bucket].length : 0,
  ]));
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items || []) {
    const key = String(selector(item) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function normalizeObjects(values) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => Object.freeze({ ...item }));
}

function firstString(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeIntegerOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} must be non-empty`);
  return text;
}

function sanitizeFailureCode(value) {
  const text = String(value || "").trim();
  return new Set([
    "ABORT_ERR",
    "LINEAGE_NETWORK_BLOCKED",
    "RAG_DATA_UNAVAILABLE",
    "RAG_RUNTIME_BUNDLE_REQUIRED",
    "evidence_prompt_budget_exceeded",
  ]).has(text) ? text : "REPLAY_ERROR";
}

function enforceTrustedIdentityReplayRegressionGate(snapshot) {
  const replay = snapshot?.identityReplay;
  if (!replay || replay?.kind !== TRUSTED_IDENTITY_REPLAY_KIND) return false;

  const bindingInvalid = () => {
    throw codedError(TRUSTED_IDENTITY_REPLAY_BINDING_INVALID);
  };
  const records = Array.isArray(snapshot?.cases) ? snapshot.cases : null;
  const replayDataRevision = String(replay?.dataRevision || "");
  const snapshotDataRevision = String(snapshot?.dataRevision || "");
  const invariantSha256 = String(replay?.invariantSha256 || "");
  if (Number(replay?.schemaVersion) !== TRUSTED_IDENTITY_REPLAY_SCHEMA_VERSION
      || !records
      || records.length === 0
      || Number(replay?.caseCount) !== records.length
      || !replayDataRevision
      || replayDataRevision !== snapshotDataRevision
      || !isSha256(invariantSha256)) {
    bindingInvalid();
  }

  const { invariantSha256: _ignoredInvariant, ...identityCore } = replay;
  const expectedInvariantSha256 = sha256(JSON.stringify({
    ...identityCore,
    cases: records.map((record) => record?.identityReplay),
  }));
  if (invariantSha256 !== expectedInvariantSha256) bindingInvalid();

  const classificationCounts = Object.fromEntries(
    TRUSTED_IDENTITY_REPLAY_CLASSIFICATIONS.map((classification) => [classification, 0]),
  );
  const comparisonKeys = new Set();
  let confirmedIdentityRegression = false;
  let confirmedIdentityCount = 0;
  let ambiguousIdentityCount = 0;
  let unresolvedIdentityCount = 0;

  for (const record of records) {
    const caseReplay = record?.identityReplay;
    const question = String(record?.question || "");
    const questionSha256 = String(record?.questionSha256 || "");
    const recordDataRevision = String(record?.dataRevision || "");
    const trace = record?.manualReviewTrace;
    const traceDataRevision = String(trace?.dataRevision || "");
    const statuses = caseReplay?.statuses;
    const confirmedStatuses = Array.isArray(statuses?.confirmed) ? statuses.confirmed : null;
    const ambiguousStatuses = Array.isArray(statuses?.ambiguous) ? statuses.ambiguous : null;
    const unresolvedStatuses = Array.isArray(statuses?.unresolved) ? statuses.unresolved : null;
    const traceResolvedCards = Array.isArray(trace?.resolvedCards) ? trace.resolvedCards : null;
    if (Number(caseReplay?.schemaVersion) !== TRUSTED_IDENTITY_REPLAY_SCHEMA_VERSION
        || !question
        || !isSha256(questionSha256)
        || sha256(question) !== questionSha256
        || String(caseReplay?.questionSha256 || "") !== questionSha256
        || String(caseReplay?.dataRevision || "") !== replayDataRevision
        || recordDataRevision !== replayDataRevision
        || traceDataRevision !== replayDataRevision
        || !traceResolvedCards
        || !confirmedStatuses
        || !ambiguousStatuses
        || !unresolvedStatuses
        || traceResolvedCards.length !== confirmedStatuses.length
        || !Array.isArray(caseReplay?.comparison)) {
      bindingInvalid();
    }

    const confirmedByCanonicalId = new Map();
    for (const statusRecord of confirmedStatuses) {
      const canonicalCardId = String(statusRecord?.canonicalCardId || "").trim();
      if (!canonicalCardId || confirmedByCanonicalId.has(canonicalCardId)) bindingInvalid();
      confirmedByCanonicalId.set(canonicalCardId, statusRecord);
    }
    for (const traceCard of traceResolvedCards) {
      const canonicalCardId = String(traceCard?.id || traceCard?.cardId || "").trim();
      const statusRecord = confirmedByCanonicalId.get(canonicalCardId);
      const verificationStatus = String(traceCard?.identityVerificationStatus || "");
      const verificationAllowed = TRUSTED_IDENTITY_REPLAY_VERIFICATION_STATUSES.has(
        verificationStatus,
      );
      const explicitResolutionSource = String(traceCard?.resolutionSource || "");
      const resolutionSource = explicitResolutionSource
        || (String(traceCard?.source || "") === "baige" && verificationAllowed
          ? "external_identity_verification"
          : "");
      const verification = statusRecord?.verification;
      const requiresVerification = traceCard?.requiresExternalIdentityVerification === true
        || traceCard?.identityMatchKind === "edit_distance"
        || traceCard?.retrievalIdentityMatchKind === "local_fuzzy";
      const expectedVerificationResult = requiresVerification ? "verified" : "not_required";
      if (!statusRecord
          || statusRecord?.status !== "confirmed"
          || String(statusRecord?.resolutionSource || "") !== resolutionSource
          || String(statusRecord?.identityVerificationStatus || "") !== verificationStatus
          || !TRUSTED_IDENTITY_REPLAY_RESOLUTION_SOURCES.has(resolutionSource)
          || (resolutionSource === "external_identity_verification" && !verificationAllowed)
          || (requiresVerification && !verificationAllowed)
          || !verification
          || verification?.trustedResolutionSource !== true
          || verification?.requiresExternalIdentityVerification !== requiresVerification
          || verification?.externalIdentityVerified !== verificationAllowed
          || traceCard?.identityCanonicalizationConflict === true
          || verification?.identityCanonicalizationConflict !== false
          || verification?.blockedByPendingIdentity !== false
          || verification?.authorityUnlockAllowed !== true
          || String(verification?.result || "") !== expectedVerificationResult) {
        bindingInvalid();
      }
      confirmedByCanonicalId.delete(canonicalCardId);
    }
    if (confirmedByCanonicalId.size !== 0) bindingInvalid();
    confirmedIdentityCount += confirmedStatuses.length;
    ambiguousIdentityCount += ambiguousStatuses.length;
    unresolvedIdentityCount += unresolvedStatuses.length;

    for (const comparison of caseReplay.comparison) {
      const comparisonQuestionSha256 = String(comparison?.questionSha256 || "");
      const comparisonDataRevision = String(comparison?.dataRevision || "");
      const canonicalIdentityFingerprint = String(
        comparison?.canonicalIdentityFingerprint || "",
      );
      const classification = String(comparison?.classification || "");
      if (comparisonQuestionSha256 !== questionSha256
          || comparisonDataRevision !== replayDataRevision
          || !isSha256(canonicalIdentityFingerprint)
          || !TRUSTED_IDENTITY_REPLAY_CLASSIFICATION_SET.has(classification)) {
        bindingInvalid();
      }
      const comparisonKey = [
        comparisonQuestionSha256,
        comparisonDataRevision,
        canonicalIdentityFingerprint,
      ].join(":");
      if (comparisonKeys.has(comparisonKey)) bindingInvalid();
      comparisonKeys.add(comparisonKey);
      classificationCounts[classification] += 1;
      if (classification === "CURRENT_RESOLVER_MISS") {
        confirmedIdentityRegression = true;
      }
    }
  }

  const recordedCounts = replay?.classificationCounts;
  if (!recordedCounts || typeof recordedCounts !== "object" || Array.isArray(recordedCounts)
      || Object.keys(recordedCounts).length !== TRUSTED_IDENTITY_REPLAY_CLASSIFICATIONS.length
      || TRUSTED_IDENTITY_REPLAY_CLASSIFICATIONS.some((classification) => (
        Number(recordedCounts[classification]) !== classificationCounts[classification]
      ))) {
    bindingInvalid();
  }
  if (Number(replay?.confirmedIdentityCount) !== confirmedIdentityCount
      || Number(replay?.ambiguousIdentityCount) !== ambiguousIdentityCount
      || Number(replay?.unresolvedIdentityCount) !== unresolvedIdentityCount) {
    bindingInvalid();
  }

  if (confirmedIdentityRegression) {
    throw codedError(TRUSTED_IDENTITY_REPLAY_CONFIRMED_IDENTITY_REGRESSION);
  }
  return true;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function frozenReplayIdentityKeys(card = {}) {
  return [...new Set([
    card?.id,
    card?.cardId,
    card?.cid,
    card?.passcode,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}
