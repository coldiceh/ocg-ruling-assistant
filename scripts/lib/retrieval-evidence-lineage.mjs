import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { extractRagCards } from "../../backend/ragCardExtractor.mjs";
import {
  loadRagData,
  retrieveRagEvidence,
} from "../../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../../backend/ragRulingPrompt.mjs";

export const PUBLIC_RAG_LINEAGE_MODE = "PUBLIC_RAG_LOCAL_OFFLINE_REPLAY_FROZEN_OUTPUTS_BLOCKED_FETCH";
export const PUBLIC_RAG_LINEAGE_STATUSES = Object.freeze({
  DATA_SOURCE_MISSING: "DATA_SOURCE_MISSING",
  CARD_IDENTITY_SCOPE_MISSING: "CARD_IDENTITY_SCOPE_MISSING",
  NOT_RECALLED: "NOT_RECALLED",
  RETRIEVAL_LIMITED: "RETRIEVAL_LIMITED",
  PROMPT_REFERENCE_OMITTED: "PROMPT_REFERENCE_OMITTED",
  PROMPT_PARSE_ERROR: "PROMPT_PARSE_ERROR",
  PROMPT_ALLOWED_IDS_MISMATCH: "PROMPT_ALLOWED_IDS_MISMATCH",
  PROMPT_COMPACTION_OMITTED: "PROMPT_COMPACTION_OMITTED",
  MODEL_VISIBLE_EXCERPTED: "MODEL_VISIBLE_EXCERPTED",
  MODEL_VISIBLE_FULL: "MODEL_VISIBLE_FULL",
});

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
const PROMPT_BUCKETS = Object.freeze(RETRIEVER_BUCKETS.filter((bucket) => bucket !== "rulebookCandidates"));
const DEFAULT_EXPANDED_LIMIT = 256;

export function normalizePublicRagReplayCases(cases = []) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new TypeError("public RAG lineage replay requires at least one case");
  }
  const seen = new Set();
  return Object.freeze(cases.map((rawCase, index) => {
    const item = rawCase && typeof rawCase === "object" ? rawCase : {};
    const id = requiredString(item.id, `cases[${index}].id`);
    const question = requiredString(item.question, `cases[${index}].question`);
    if (seen.has(id)) throw new TypeError(`duplicate public RAG replay case: ${id}`);
    seen.add(id);
    const expectedEvidenceIds = normalizeStrings(item.expectedEvidenceIds);
    if (!expectedEvidenceIds.length) {
      throw new TypeError(`cases[${index}].expectedEvidenceIds must be non-empty`);
    }
    return Object.freeze({
      id,
      question,
      expectedCardIds: Object.freeze(normalizeStrings(item.expectedCardIds)),
      expectedEvidenceIds: Object.freeze(expectedEvidenceIds),
      modelCardNameCandidates: Object.freeze(normalizeObjects(item.modelCardNameCandidates)),
      modelRuleSearchQueries: Object.freeze(normalizeObjects(item.modelRuleSearchQueries)),
      modelRuleCandidateAssessments: Object.freeze(normalizeObjects(item.modelRuleCandidateAssessments)),
      frozenResolvedCards: Object.freeze(normalizeObjects(item.frozenResolvedCards)),
      frozenUnresolvedMentions: Object.freeze(normalizeObjects(item.frozenUnresolvedMentions)),
      frozenAmbiguousMentions: Object.freeze(normalizeObjects(item.frozenAmbiguousMentions)),
    });
  }));
}

export async function loadFrozenPublicRagReplayCases({
  datasetPath,
  generationsDir,
  expectations,
} = {}) {
  const normalizedExpectations = normalizeExpectations(expectations);
  const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
  const datasetCases = new Map((dataset?.cases || []).map((item) => [String(item?.id || ""), item]));
  const cases = [];
  for (const expectation of normalizedExpectations) {
    const datasetCase = datasetCases.get(expectation.id);
    if (!datasetCase) throw new TypeError(`frozen dataset case not found: ${expectation.id}`);
    const generation = JSON.parse(await readFile(join(generationsDir, `${expectation.id}.json`), "utf8"));
    const response = parseCandidateResponse(generation?.candidateResponseText, expectation.id);
    cases.push({
      id: expectation.id,
      question: datasetCase.question,
      expectedCardIds: expectation.expectedCardIds,
      expectedEvidenceIds: expectation.expectedEvidenceIds,
      modelCardNameCandidates: response?.debug?.modelCardNameCandidates || [],
      modelRuleSearchQueries: response?.debug?.modelRuleSearchQueries || [],
      modelRuleCandidateAssessments: response?.debug?.modelRuleCandidateAssessments || [],
      frozenResolvedCards: response?.resolvedCards || [],
      frozenUnresolvedMentions: response?.debug?.unresolvedMentions || [],
      frozenAmbiguousMentions: response?.debug?.ambiguousMentions || [],
    });
  }
  return normalizePublicRagReplayCases(cases);
}

export async function runPublicRagEvidenceLineageAudit({
  cases,
  dataDir,
  env = {},
  expandedLimit = DEFAULT_EXPANDED_LIMIT,
  loadData = loadRagData,
  extractCards = extractRagCards,
  retrieveEvidence = retrieveRagEvidence,
  buildPrompt = buildRagRulingPromptBundle,
} = {}) {
  const normalizedCases = normalizePublicRagReplayCases(cases);
  const telemetry = {
    modelTransportHooksSupplied: 0,
    frozenRulePlanProviderCalls: 0,
    blockedNetworkAttempts: 0,
    baselineRetrievals: 0,
    expandedDiagnosticRetrievals: 0,
  };
  const unavailableFetch = async () => {
    telemetry.blockedNetworkAttempts += 1;
    return new Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };
  const data = await loadData(dataDir);
  const sourceIndex = buildSourceIndex(data);
  const reports = [];

  for (const replayCase of normalizedCases) {
    const extractedCardResolution = extractCards(replayCase.question, {
      cards: data?.cards || [],
      maxCards: positiveInteger(env.RAG_MAX_CARDS, 6),
      modelCardNameCandidates: replayCase.modelCardNameCandidates,
    });
    // A frozen production response may contain identities that were resolved by
    // Baige. Reuse those already-observed primary identities so this local-only
    // replay neither opens the network nor mistakes a blocked lookup for a
    // retrieval regression. Card-text dependency identities are still derived
    // by the real retriever and therefore are not injected here.
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
    const commonOptions = {
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
    };
    const baseline = await retrieveEvidence(commonOptions);
    telemetry.baselineRetrievals += 1;
    const effectiveCardResolution = baseline?.cardResolution || cardResolution;
    const promptBundle = buildPrompt({
      userQuery: replayCase.question,
      cardResolution: effectiveCardResolution,
      evidence: baseline,
      env,
    });
    const baselineIndex = buildBucketIndex(baseline, RETRIEVER_BUCKETS);
    const missingFromBaseline = replayCase.expectedEvidenceIds.filter((id) => !baselineIndex.has(id));
    let expanded = null;
    let expandedIndex = new Map();
    if (missingFromBaseline.length) {
      const safeExpandedLimit = Math.max(16, positiveInteger(expandedLimit, DEFAULT_EXPANDED_LIMIT));
      expanded = await retrieveEvidence({
        ...commonOptions,
        env: {
          ...commonOptions.env,
          RAG_MAX_OFFICIAL_QA: String(safeExpandedLimit),
          RAG_MAX_RELATED_EVIDENCE: String(safeExpandedLimit),
          RAG_MAX_RULEBOOK_CANDIDATES: String(safeExpandedLimit),
        },
      });
      telemetry.expandedDiagnosticRetrievals += 1;
      expandedIndex = buildBucketIndex(expanded, RETRIEVER_BUCKETS);
    }
    const preparedPromptIndex = buildBucketIndex(
      promptBundle?.modelEvidence || {},
      PROMPT_BUCKETS,
    );
    // modelEvidence is the pre-serialization selection. A compact prompt may
    // still omit an item or shorten its body afterwards, so visibility must be
    // measured from the exact JSON envelope sent to the final model.
    const serializedPrompt = inspectSerializedPromptEvidence(promptBundle?.prompt);
    const promptIndex = serializedPrompt.evidenceIndex;
    const bundleAllowedIds = new Set(normalizeStrings(promptBundle?.allowedEvidenceIds));
    const allowedIds = serializedPrompt.allowedEvidenceIds;
    const promptEvidenceIds = new Set(promptIndex.keys());
    const bundleAllowedIdsConsistent = serializedPrompt.parseStatus === "parsed"
      && serializedPrompt.allowedIdsPresent
      && setsEqual(bundleAllowedIds, allowedIds);
    const promptEvidenceAllowedIdsConsistent = serializedPrompt.parseStatus === "parsed"
      && serializedPrompt.allowedIdsPresent
      && setsEqual(allowedIds, promptEvidenceIds);
    const promptAllowedIdsConsistent = bundleAllowedIdsConsistent
      && promptEvidenceAllowedIdsConsistent;
    const resolvedCardIds = new Set((effectiveCardResolution?.resolvedCards || [])
      .map((card) => String(card?.id || card?.cardId || "").trim())
      .filter(Boolean));
    const missingExpectedCardIds = replayCase.expectedCardIds.filter((id) => !resolvedCardIds.has(id));
    const evidence = replayCase.expectedEvidenceIds.map((evidenceId) => classifyPublicRagEvidenceLineage({
      evidenceId,
      sourceIndex,
      baselineIndex,
      expandedIndex,
      preparedPromptIndex,
      promptIndex,
      allowedIds,
      promptParseStatus: serializedPrompt.parseStatus,
      promptAllowedIdsConsistent,
      missingExpectedCardIds,
      promptWarnings: promptBundle?.warnings || [],
      candidateStages: baseline?.debug?.candidateStages || {},
      expandedCandidateStages: expanded?.debug?.candidateStages || {},
    }));
    const integrityOk = serializedPrompt.parseStatus === "parsed"
      && promptAllowedIdsConsistent;
    reports.push(Object.freeze({
      id: replayCase.id,
      question: replayCase.question,
      expectedCardIds: replayCase.expectedCardIds,
      resolvedCardIds: Object.freeze([...resolvedCardIds]),
      missingExpectedCardIds: Object.freeze(missingExpectedCardIds),
      evidence: Object.freeze(evidence),
      baselineCounts: Object.freeze(bucketCounts(baseline, RETRIEVER_BUCKETS)),
      expandedCounts: Object.freeze(bucketCounts(expanded, RETRIEVER_BUCKETS)),
      retrievalWarnings: Object.freeze([...(baseline?.retrievalWarnings || [])]),
      ruleSearchQueries: Object.freeze([...(baseline?.ruleSearchQueries || [])]),
      candidateStages: Object.freeze({ ...(baseline?.debug?.candidateStages || {}) }),
      promptWarnings: Object.freeze([...(promptBundle?.warnings || [])]),
      promptChars: Number(promptBundle?.promptChars || 0),
      promptTruncated: promptBundle?.promptTruncated === true,
      allowedEvidenceIds: Object.freeze([...allowedIds]),
      bundleAllowedEvidenceIds: Object.freeze([...bundleAllowedIds]),
      promptParseStatus: serializedPrompt.parseStatus,
      promptKind: serializedPrompt.promptKind,
      promptAllowedIdsPresent: serializedPrompt.allowedIdsPresent,
      promptEvidenceAllowedIdsConsistent,
      promptAllowedIdsConsistent,
      integrityOk,
    }));
  }

  const statusCounts = {};
  for (const report of reports) {
    for (const item of report.evidence) {
      statusCounts[item.firstFailureOrVisibility] = (statusCounts[item.firstFailureOrVisibility] || 0) + 1;
    }
  }
  const integrityOk = reports.every((report) => report.integrityOk === true);
  return Object.freeze({
    mode: PUBLIC_RAG_LINEAGE_MODE,
    integrityOk,
    caseCount: reports.length,
    expectedEvidenceCount: reports.reduce((sum, report) => sum + report.evidence.length, 0),
    telemetry: Object.freeze({
      ...telemetry,
      noBlockedNetworkAttemptsObserved: telemetry.blockedNetworkAttempts === 0,
    }),
    statusCounts: Object.freeze(statusCounts),
    cases: Object.freeze(reports),
  });
}

export function classifyPublicRagEvidenceLineage({
  evidenceId,
  sourceIndex = new Map(),
  baselineIndex = new Map(),
  expandedIndex = new Map(),
  preparedPromptIndex,
  promptIndex = new Map(),
  allowedIds = new Set(),
  promptParseStatus = "parsed",
  promptAllowedIdsConsistent = true,
  missingExpectedCardIds = [],
  promptWarnings = [],
  candidateStages = {},
  expandedCandidateStages = {},
} = {}) {
  const id = requiredString(evidenceId, "evidenceId");
  const source = sourceIndex.get(id) || [];
  const baseline = baselineIndex.get(id) || [];
  const expanded = expandedIndex.get(id) || [];
  const preparedPrompt = (preparedPromptIndex instanceof Map
    ? preparedPromptIndex
    : promptIndex).get(id) || [];
  const prompt = promptIndex.get(id) || [];
  const shared = {
    evidenceId: id,
    sourceLocations: compactLocations(source),
    baselineLocations: compactLocations(baseline),
    expandedLocations: compactLocations(expanded),
    preparedPromptLocations: compactLocations(preparedPrompt),
    promptLocations: compactLocations(prompt),
    candidateStageHits: findCandidateStageHits(candidateStages, id),
    expandedCandidateStageHits: findCandidateStageHits(expandedCandidateStages, id),
    candidateStageLocations: findCandidateStageLocations(candidateStages, id),
    expandedCandidateStageLocations: findCandidateStageLocations(expandedCandidateStages, id),
  };
  if (!source.length) return lineageResult(shared, PUBLIC_RAG_LINEAGE_STATUSES.DATA_SOURCE_MISSING);
  if (missingExpectedCardIds.length) {
    return lineageResult(shared, PUBLIC_RAG_LINEAGE_STATUSES.CARD_IDENTITY_SCOPE_MISSING, {
      missingExpectedCardIds: normalizeStrings(missingExpectedCardIds),
    });
  }
  if (!baseline.length) {
    const appearedOnlyInExpandedCandidates = shared.expandedCandidateStageHits.length > 0;
    return lineageResult(
      shared,
      expanded.length || appearedOnlyInExpandedCandidates
        ? PUBLIC_RAG_LINEAGE_STATUSES.RETRIEVAL_LIMITED
        : PUBLIC_RAG_LINEAGE_STATUSES.NOT_RECALLED,
    );
  }
  if (!preparedPrompt.length) {
    return lineageResult(shared, PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_REFERENCE_OMITTED);
  }
  if (promptParseStatus !== "parsed") {
    return lineageResult(shared, PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_PARSE_ERROR, {
      promptParseStatus,
    });
  }
  if (!promptAllowedIdsConsistent) {
    return lineageResult(shared, PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_ALLOWED_IDS_MISMATCH);
  }
  if (!prompt.length || !allowedIds.has(id)) {
    return lineageResult(shared, PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_COMPACTION_OMITTED);
  }
  const bodyLineage = analyzeEvidenceBodyLineage({
    id,
    baseline,
    preparedPrompt,
    prompt,
    promptWarnings,
  });
  return lineageResult(
    shared,
    bodyLineage.excerptStages.length
      ? PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED
      : PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL,
    bodyLineage,
  );
}

export function buildBucketIndex(value, buckets = RETRIEVER_BUCKETS) {
  const index = new Map();
  for (const bucket of buckets) {
    const items = Array.isArray(value?.[bucket]) ? value[bucket] : [];
    items.forEach((item, rank) => {
      const id = String(item?.id || item?.evidenceId || item?.stableId || "").trim();
      if (!id) return;
      const locations = index.get(id) || [];
      locations.push({ bucket, rank: rank + 1, item });
      index.set(id, locations);
    });
  }
  return index;
}

export function buildSerializedPromptEvidenceIndex(prompt) {
  return inspectSerializedPromptEvidence(prompt).evidenceIndex;
}

export function inspectSerializedPromptEvidence(prompt) {
  const parsed = parseSerializedPromptPayload(prompt);
  if (parsed.status !== "parsed") {
    return failedSerializedPromptInspection(parsed.status);
  }
  const payload = parsed.payload;
  if (Object.hasOwn(payload, "officialQaDirectCandidate")) {
    const directCandidate = payload.officialQaDirectCandidate;
    const directIds = directCandidate && typeof directCandidate === "object"
      && !Array.isArray(directCandidate)
      ? normalizeStrings([
          directCandidate.id,
          directCandidate.evidenceId,
          directCandidate.stableId,
        ])
      : [];
    if (directIds.length !== 1) return failedSerializedPromptInspection("parse_error");
    const evidenceIndex = buildBucketIndex({
      officialQaDirectCandidates: [directCandidate],
    }, ["officialQaDirectCandidates"]);
    const [directId] = directIds;
    return Object.freeze({
      parseStatus: "parsed",
      promptKind: "official_direct",
      evidenceIndex,
      // The official-direct envelope intentionally predates the ordinary
      // allowedEvidenceIds field. Its sole certified candidate is the complete
      // allow-list, and is checked against the bundle separately.
      allowedEvidenceIds: new Set(directId ? [directId] : []),
      allowedIdsPresent: Boolean(directId),
    });
  }
  const hasEvidence = Object.hasOwn(payload, "evidence")
    && payload.evidence !== null
    && typeof payload.evidence === "object";
  const hasAllowedIds = Object.hasOwn(payload, "allowedEvidenceIds")
    && Array.isArray(payload.allowedEvidenceIds);
  if (!hasEvidence || !hasAllowedIds) {
    return failedSerializedPromptInspection("parse_error");
  }
  let evidenceIndex;
  if (Array.isArray(payload.evidence)) {
    const index = new Map();
    payload.evidence.forEach((item, rank) => {
      const id = String(item?.id || item?.evidenceId || item?.stableId || "").trim();
      if (!id) return;
      const locations = index.get(id) || [];
      locations.push({
        bucket: String(item?.bucket || "evidence"),
        rank: rank + 1,
        item,
      });
      index.set(id, locations);
    });
    evidenceIndex = index;
  } else {
    evidenceIndex = buildBucketIndex(payload.evidence || {}, PROMPT_BUCKETS);
  }
  return Object.freeze({
    parseStatus: "parsed",
    promptKind: Array.isArray(payload.evidence) ? "ordinary_array" : "ordinary_buckets",
    evidenceIndex,
    allowedEvidenceIds: new Set(normalizeStrings(payload.allowedEvidenceIds)),
    allowedIdsPresent: true,
  });
}

function failedSerializedPromptInspection(parseStatus = "parse_error") {
  return Object.freeze({
    parseStatus,
    promptKind: "unknown",
    evidenceIndex: new Map(),
    allowedEvidenceIds: new Set(),
    allowedIdsPresent: false,
  });
}

function parseSerializedPromptPayload(prompt) {
  const source = String(prompt || "");
  if (!source.trim()) return { status: "empty", payload: null };
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return parseSerializedPromptPayloadCandidate(
      source.slice(markerIndex + marker.length).trim(),
    );
  }
  const finalLine = source.slice(source.lastIndexOf("\n") + 1).trim();
  return parseSerializedPromptPayloadCandidate(finalLine);
}

function parseSerializedPromptPayloadCandidate(candidate) {
  if (!candidate) return { status: "parse_error", payload: null };
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { status: "parsed", payload: parsed };
    }
  } catch {
    // Visibility is certified only by one complete JSON envelope.
  }
  return { status: "parse_error", payload: null };
}

function buildSourceIndex(data = {}) {
  const index = new Map();
  for (const [collection, value] of Object.entries(data || {})) {
    if (!Array.isArray(value)) continue;
    value.forEach((item, rank) => {
      const id = String(item?.id || item?.evidenceId || item?.stableId || "").trim();
      if (!id) return;
      const locations = index.get(id) || [];
      locations.push({ bucket: collection, rank: rank + 1, item });
      index.set(id, locations);
    });
  }
  return index;
}

function analyzeEvidenceBodyLineage({ id, baseline, preparedPrompt, prompt, promptWarnings }) {
  const chain = selectEvidenceVersionChain({ baseline, preparedPrompt, prompt });
  const baselineToPrepared = compareEvidenceBodyContent(
    chain.baseline?.item,
    chain.prepared?.item,
  );
  const preparedToSerialized = compareEvidenceBodyContent(
    chain.prepared?.item,
    chain.serialized?.item,
  );
  const transitions = [
    ["baseline_to_prepared", baselineToPrepared],
    ["prepared_to_serialized", preparedToSerialized],
  ];
  const excerptStages = transitions
    .filter(([, comparison]) => comparison.differences.length > 0)
    .map(([stage]) => stage);
  const bodyDifferences = transitions.flatMap(([stage, comparison]) => (
    comparison.differences.map((difference) => Object.freeze({ stage, ...difference }))
  ));
  const serializedWarningTypes = preparedToSerialized.differences.length > 0
    && evidenceItemContainsExcerptMarker(chain.serialized?.item)
    ? exactTruncationWarningTypes(promptWarnings, id)
    : [];
  if (serializedWarningTypes.length) excerptStages.push("serialized_warning_confirmed");
  return Object.freeze({
    excerptStages: Object.freeze([...new Set(excerptStages)]),
    bodyDifferences: Object.freeze(bodyDifferences),
    selectedVersionChain: Object.freeze({
      baseline: compactVersionLocation(chain.baseline),
      prepared: compactVersionLocation(chain.prepared),
      serialized: compactVersionLocation(chain.serialized),
    }),
    serializedWarningTypes: Object.freeze(serializedWarningTypes),
  });
}

function compactLocations(locations = []) {
  return Object.freeze(locations.map(({ bucket, rank, item }) => Object.freeze({
    bucket,
    rank,
    textChars: evidenceBodyCharCount(item),
    visibleTextChars: evidenceBodyCharCount(item),
    retrievalScore: Number.isFinite(Number(item?.retrievalScore ?? item?.score))
      ? Number(item?.retrievalScore ?? item?.score)
      : null,
  })));
}

function selectEvidenceVersionChain({ baseline = [], preparedPrompt = [], prompt = [] } = {}) {
  // Selection must never minimize observed loss: doing so would let a short
  // baseline duplicate pair with the same short prepared record and hide the
  // complete same-identity source. First choose the richest baseline body among
  // identities that actually reach the prepared stage. Then bind prepared and
  // serialized locations by identity, bucket and stable rank only.
  const baselineLocation = [...(baseline || [])].sort((left, right) => (
    compareBaselineVersionLocations(left, right, preparedPrompt)
  ))[0];
  const preparedLocation = [...(preparedPrompt || [])].sort((left, right) => (
    comparePreparedVersionLocations(left, right, baselineLocation, prompt)
  ))[0];
  const serializedLocation = [...(prompt || [])].sort((left, right) => (
    compareSerializedVersionLocations(left, right, preparedLocation)
  ))[0];
  return {
    baseline: baselineLocation,
    prepared: preparedLocation,
    serialized: serializedLocation,
  };
}

function compareBaselineVersionLocations(left = {}, right = {}, preparedLocations = []) {
  const leftCorrespondence = bestVersionCorrespondenceScore(left, preparedLocations);
  const rightCorrespondence = bestVersionCorrespondenceScore(right, preparedLocations);
  return compareEvidenceLocationCompleteness(left, right)
    || rightCorrespondence - leftCorrespondence
    || evidenceLocationStableKey(left).localeCompare(evidenceLocationStableKey(right));
}

function comparePreparedVersionLocations(left = {}, right = {}, baselineLocation = {}, promptLocations = []) {
  return evidenceVersionCorrespondenceScore(baselineLocation, right)
      - evidenceVersionCorrespondenceScore(baselineLocation, left)
    || bestVersionCorrespondenceScore(right, promptLocations)
      - bestVersionCorrespondenceScore(left, promptLocations)
    || compareEvidenceLocationCompleteness(left, right)
    || evidenceLocationStableKey(left).localeCompare(evidenceLocationStableKey(right));
}

function compareSerializedVersionLocations(left = {}, right = {}, preparedLocation = {}) {
  return evidenceVersionCorrespondenceScore(preparedLocation, right)
      - evidenceVersionCorrespondenceScore(preparedLocation, left)
    || Math.abs(Number(left?.rank || 0) - Number(preparedLocation?.rank || 0))
      - Math.abs(Number(right?.rank || 0) - Number(preparedLocation?.rank || 0))
    || Number(left?.rank || 0) - Number(right?.rank || 0)
    || evidenceLocationStableKey(left).localeCompare(evidenceLocationStableKey(right));
}

function bestVersionCorrespondenceScore(location = {}, candidates = []) {
  return Math.max(0, ...(candidates || []).map((candidate) => (
    evidenceVersionCorrespondenceScore(location, candidate)
  )));
}

function compareEvidenceLocationCompleteness(left = {}, right = {}) {
  const leftProfile = evidenceBodyCompletenessProfile(left?.item);
  const rightProfile = evidenceBodyCompletenessProfile(right?.item);
  for (let index = 0; index < leftProfile.length; index += 1) {
    if (leftProfile[index] !== rightProfile[index]) return rightProfile[index] - leftProfile[index];
  }
  return 0;
}

function evidenceBodyCompletenessProfile(item = {}) {
  const fields = canonicalEvidenceBodyFields(item);
  const uniqueFallbackChars = fields.fallbackText
    && !fallbackTextCoveredByStructuredFields(fields.fallbackText, {
      question: fields.question,
      detailedScene: fields.detailedScene,
      answer: fields.answer,
      fallbackText: "",
    })
    ? fields.fallbackText.length
    : 0;
  return [
    fields.answer.length + uniqueFallbackChars,
    fields.answer.length,
    uniqueFallbackChars,
    fields.detailedScene.length,
    fields.question.length,
  ];
}

function evidenceLocationStableKey(location = {}) {
  return [
    String(location?.bucket || ""),
    String(location?.rank || ""),
    evidenceVersionStableKey(location?.item),
  ].join("\u0000");
}

function evidenceVersionKeysMatch(left = {}, right = {}) {
  const leftKey = evidenceVersionStableKey(left);
  const rightKey = evidenceVersionStableKey(right);
  return versionIdentityHasContent(left) && versionIdentityHasContent(right) && leftKey === rightKey;
}

function versionIdentityHasContent(item = {}) {
  return [
    item?.recordType,
    item?.sourceUrl,
    item?.source,
    item?.title,
    canonicalEvidenceBodyFields(item).question,
  ].some((value) => String(value || "").trim());
}

function evidenceVersionCorrespondenceScore(leftLocation = {}, rightLocation = {}) {
  const left = leftLocation?.item || {};
  const right = rightLocation?.item || {};
  const leftBody = canonicalEvidenceBodyFields(left);
  const rightBody = canonicalEvidenceBodyFields(right);
  let score = evidenceVersionKeysMatch(left, right) ? 24 : 0;
  if (sameNonEmpty(left?.sourceUrl, right?.sourceUrl)) score += 12;
  if (sameNonEmpty(leftBody.question, rightBody.question)) score += 10;
  if (sameNonEmpty(leftBody.detailedScene, rightBody.detailedScene)) score += 6;
  if (sameNonEmpty(left?.recordType, right?.recordType)) score += 4;
  if (sameNonEmpty(left?.title, right?.title)) score += 3;
  if (sameNonEmpty(left?.source, right?.source)) score += 2;
  if (sameNonEmpty(leftLocation?.bucket, rightLocation?.bucket)) score += 1;
  return score;
}

function sameNonEmpty(left, right) {
  const normalizedLeft = normalizeEvidenceBodyText(left);
  const normalizedRight = normalizeEvidenceBodyText(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function compareEvidenceBodyContent(beforeItem = {}, afterItem = {}) {
  const before = canonicalEvidenceBodyFields(beforeItem);
  const after = canonicalEvidenceBodyFields(afterItem);
  const differences = [];
  let lostChars = 0;
  for (const field of ["question", "detailedScene", "answer", "fallbackText"]) {
    const beforeValue = before[field];
    if (!beforeValue || evidenceFieldContentAvailable(field, beforeValue, after)) continue;
    const afterValue = comparisonValueForField(field, after);
    differences.push(describeEvidenceBodyDifference(field, beforeValue, afterValue));
    lostChars += Math.max(0, beforeValue.length - afterValue.length);
  }
  return Object.freeze({
    differences: Object.freeze(differences),
    lostChars,
  });
}

function evidenceFieldContentAvailable(field, beforeValue, after = {}) {
  const direct = after[field];
  if (direct === beforeValue) return true;
  if (field === "fallbackText" && fallbackTextCoveredByStructuredFields(beforeValue, after)) {
    return true;
  }
  const alternatives = field === "fallbackText"
    ? [after.fallbackText, [after.question, after.detailedScene, after.answer].filter(Boolean).join("\n")]
    : [direct, after.fallbackText];
  return alternatives.some((candidate) => normalizedTextContainsWholeSegment(candidate, beforeValue));
}

function fallbackTextCoveredByStructuredFields(fallbackText, after = {}) {
  const segments = normalizeEvidenceBodyText(fallbackText)
    .split(/\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return true;
  const visibleFields = [after.question, after.detailedScene, after.answer, after.fallbackText]
    .filter(Boolean);
  return segments.every((segment) => visibleFields.some((field) => (
    normalizedTextContainsWholeSegment(field, segment)
  )));
}

function normalizedTextContainsWholeSegment(container, expected) {
  const normalizedContainer = normalizeEvidenceBodyText(container);
  const normalizedExpected = normalizeEvidenceBodyText(expected);
  if (!normalizedContainer || !normalizedExpected) return false;
  if (normalizedContainer === normalizedExpected) return true;
  return normalizedContainer.startsWith(`${normalizedExpected}\n`)
    || normalizedContainer.endsWith(`\n${normalizedExpected}`)
    || normalizedContainer.includes(`\n${normalizedExpected}\n`);
}

function comparisonValueForField(field, after = {}) {
  if (after[field]) return after[field];
  if (field === "fallbackText") {
    return [after.question, after.detailedScene, after.answer].filter(Boolean).join("\n");
  }
  return after.fallbackText || "";
}

function describeEvidenceBodyDifference(field, before, after) {
  const differenceAt = firstDifferentCharacterIndex(before, after);
  return Object.freeze({
    field,
    reason: after ? "content_changed_or_not_preserved" : "missing",
    beforeChars: before.length,
    afterChars: after.length,
    firstDifferenceAt: differenceAt,
    beforeExcerpt: evidenceDifferenceExcerpt(before, differenceAt),
    afterExcerpt: evidenceDifferenceExcerpt(after, differenceAt),
  });
}

function firstDifferentCharacterIndex(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : limit;
}

function evidenceDifferenceExcerpt(value, index, radius = 60) {
  const text = String(value || "");
  if (!text) return "";
  const center = Math.max(0, Number(index) || 0);
  const start = Math.max(0, center - radius);
  const end = Math.min(text.length, center + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function compactVersionLocation(location = {}) {
  const item = location?.item || {};
  const body = canonicalEvidenceBodyFields(item);
  return Object.freeze({
    bucket: String(location?.bucket || ""),
    rank: Number(location?.rank || 0),
    recordType: String(item?.recordType || ""),
    sourceUrl: String(item?.sourceUrl || ""),
    source: String(item?.source || ""),
    title: String(item?.title || ""),
    questionChars: body.question.length,
    detailedSceneChars: body.detailedScene.length,
    answerChars: body.answer.length,
    fallbackTextChars: body.fallbackText.length,
  });
}

function canonicalEvidenceBodyFields(item = {}) {
  return {
    question: normalizeEvidenceBodyText(item?.question || item?.rawQuestion || ""),
    detailedScene: normalizeEvidenceBodyText(
      item?.rawDetailedQuestion
        || item?.detailedScene
        || item?.detailedQuestion
        || "",
    ),
    answer: normalizeEvidenceBodyText(
      item?.answer || item?.officialAnswer || item?.conclusion || "",
    ),
    fallbackText: normalizeEvidenceBodyText(
      item?.fullText || item?.text || item?.officialText || "",
    ),
  };
}

function normalizeEvidenceBodyText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .trim();
}

function evidenceItemContainsExcerptMarker(item = {}) {
  const fields = canonicalEvidenceBodyFields(item);
  return Object.values(fields).some((value) => /(?:…|\.\.\.)/u.test(value));
}

function exactTruncationWarningTypes(warnings = [], evidenceId = "") {
  const id = String(evidenceId || "");
  const types = [];
  for (const warning of warnings || []) {
    const match = /^([\p{L}\p{N}_-]+_text_truncated):(.*)$/u.exec(String(warning));
    if (!match || match[2] !== id) continue;
    types.push(match[1]);
  }
  return [...new Set(types)];
}

function evidenceVersionStableKey(item = {}) {
  return [
    item?.recordType,
    item?.sourceUrl,
    item?.source,
    item?.title,
    canonicalEvidenceBodyFields(item).question,
  ].map((value) => String(value || "")).join("\u0000");
}

function evidenceBodyCharCount(item = {}) {
  const fields = canonicalEvidenceBodyFields(item);
  return [fields.question, fields.detailedScene, fields.answer, fields.fallbackText]
    .filter(Boolean)
    .join("\n")
    .length;
}

function findCandidateStageHits(candidateStages = {}, evidenceId) {
  return Object.freeze(findCandidateStageLocations(candidateStages, evidenceId)
    .map((item) => item.stage));
}

function findCandidateStageLocations(candidateStages = {}, evidenceId) {
  const hits = [];
  for (const [stage, ids] of Object.entries(candidateStages || {})) {
    const rank = normalizeStrings(ids).indexOf(evidenceId);
    if (rank >= 0) hits.push(Object.freeze({ stage, rank: rank + 1 }));
  }
  return Object.freeze(hits);
}

function bucketCounts(value, buckets) {
  return Object.fromEntries(buckets.map((bucket) => [
    bucket,
    Array.isArray(value?.[bucket]) ? value[bucket].length : 0,
  ]));
}

function lineageResult(shared, status, extra = {}) {
  return Object.freeze({
    ...shared,
    firstFailureOrVisibility: status,
    ...extra,
  });
}

function normalizeExpectations(value) {
  const source = Array.isArray(value)
    ? value
    : Object.entries(value || {}).map(([id, expectation]) => ({ id, ...expectation }));
  return source.map((item, index) => ({
    id: requiredString(item?.id, `expectations[${index}].id`),
    expectedCardIds: normalizeStrings(item?.expectedCardIds),
    expectedEvidenceIds: normalizeStrings(item?.expectedEvidenceIds),
  }));
}

function parseCandidateResponse(value, caseId) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch (error) {
    throw new TypeError(`invalid frozen candidateResponseText for ${caseId}: ${error.message}`);
  }
}

function normalizeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function normalizeObjects(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => value && typeof value === "object")
    .map((value) => Object.freeze({ ...value }));
}

function setsEqual(left = new Set(), right = new Set()) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}
