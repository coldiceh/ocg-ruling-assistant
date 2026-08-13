import { createHash } from "node:crypto";

import {
  loadRawGenericData,
  normalizeRawGenericInjectedData,
} from "./rawGenericDataStore.mjs";
import { resolveRawGenericCards } from "./rawGenericCardResolver.mjs";
import {
  resolveRawGenericCardIdentities,
  retrieveRawGenericEvidence,
} from "./rawGenericEvidenceRetriever.mjs";
import {
  callCardNameExtractionModel,
  callRagModel,
  callRuleQueryExtractionModel,
} from "./rawEvidenceModelClient.mjs";
import { resolveRagDataRevision } from "./ragDataRevisionManifest.mjs";
import {
  buildRawEvidenceRagPromptBundle,
  selectStrictOfficialDirectCandidate,
} from "./rawEvidenceRagPrompt.mjs";
import { runValidatedRawEvidenceFinal } from "./rawEvidenceAnswerValidator.mjs";

const defaultSnapshotRevisionCache = new WeakMap();

/**
 * Public RAG path: identify cards, retrieve raw sources, then ask one final
 * model to perform the ruling analysis. No local ruling reasoner, handwritten
 * question-type rule, Lua packet, simulator, formal shadow, semantic validator
 * or model repair pass participates in this path.
 */
export async function answerRagRulingQuestion({
  question,
  userQuery,
  dataDir,
  cards,
  records,
  qaRecords,
  modelInvoker,
  cardModelInvoker,
  ruleModelInvoker,
  dryRun,
  fetchImpl,
  now,
  env = globalThis.process?.env || {},
  thinkingMode,
  reasoningEffort,
  signal,
} = {}) {
  const pipelineStartedAt = Date.now();
  const timingsMs = {};
  const query = String(question || userQuery || "").trim();
  if (!query) return buildEmptyQuestionAnswer();

  const dataStartedAt = Date.now();
  const usesCompleteDefaultSnapshot = !(cards || records || qaRecords);
  const data = usesCompleteDefaultSnapshot
    ? await loadRawGenericData(dataDir)
    : normalizeRawGenericInjectedData({
        cards: cards || [],
        records: records || [],
        qaRecords: qaRecords || [],
      });
  const dataRevision = buildRagDataRevision(data, env, {
    cacheByIdentity: usesCompleteDefaultSnapshot,
  });
  timingsMs.dataLoad = elapsedMs(dataStartedAt);

  const preflightStartedAt = Date.now();
  const maxCards = readPositiveNumber(env.RAG_MAX_CARDS, 6);
  const localCardResolution = resolveRawGenericCards({
    userQuery: query,
    cards: data.cards || [],
    maxCards,
  });
  timingsMs.deterministicPreflight = elapsedMs(preflightStartedAt);

  const auxiliaryStartedAt = Date.now();
  const cardExtractionStartedAt = Date.now();
  const cardNameModel = await callCardNameExtractionModel({
    userQuery: query,
    dataRevision,
    env,
    modelInvoker: cardModelInvoker,
    fetchImpl,
    dryRun,
    now,
    signal,
  });
  timingsMs.cardNameExtraction = elapsedMs(cardExtractionStartedAt);
  const cardResolution = (cardNameModel.candidates || []).length
    ? resolveRawGenericCards({
        userQuery: query,
        cards: data.cards || [],
        maxCards,
        modelCardNameCandidates: cardNameModel.candidates,
      })
    : localCardResolution;

  const externalIdentityStartedAt = Date.now();
  const identityResolution = await resolveRawGenericCardIdentities({
    cardResolution,
    cards: data.cards || [],
    env,
    fetchImpl,
    maxCards,
  });
  const effectiveIdentityResolution = identityResolution.cardResolution;
  timingsMs.externalIdentityResolution = elapsedMs(externalIdentityStartedAt);

  // Rule-query extraction deliberately runs after local and external identity
  // resolution. It may
  // use only the question and verified catalogue text to produce lexical
  // searches; it never decides the ruling or supplies final-answer evidence.
  const ruleExtractionStartedAt = Date.now();
  const ruleQueryModel = await callRuleQueryExtractionModel({
    userQuery: query,
    resolvedCards: effectiveIdentityResolution.resolvedCards || [],
    dataRevision,
    env,
    modelInvoker: ruleModelInvoker,
    fetchImpl,
    dryRun,
    now,
    signal,
  });
  timingsMs.ruleQueryExtraction = elapsedMs(ruleExtractionStartedAt);
  timingsMs.auxiliaryExtractionModels = elapsedMs(auxiliaryStartedAt);

  const retrievalStartedAt = Date.now();
  const evidence = await retrieveRawGenericEvidence({
    userQuery: query,
    cardResolution: effectiveIdentityResolution,
    identityResolution,
    dataDir,
    data,
    ruleSearchQueries: ruleQueryModel.queries || [],
    env,
    fetchImpl,
  });
  timingsMs.retrieval = elapsedMs(retrievalStartedAt);
  const effectiveCardResolution = evidence.cardResolution || cardResolution;

  const authoritativeOfficialDirect = selectStrictOfficialDirectCandidate({
    candidates: evidence.officialQaDirectCandidates,
    userQuery: query,
    cardResolution: effectiveCardResolution,
    baigeAmbiguousMentions: evidence.baigeAmbiguousMentions,
    selector: true,
  });
  const promptBundle = buildRawEvidenceRagPromptBundle({
    userQuery: query,
    cardResolution: effectiveCardResolution,
    evidence,
    env,
    authoritativeOfficialDirect: authoritativeOfficialDirect || false,
  });
  const finalPromptSha256 = sha256Text(promptBundle.prompt);
  const evidenceFingerprint = sha256Json({
    allowedEvidenceIds: promptBundle.allowedEvidenceIds,
    finalPromptSha256,
  });

  const finalModelStartedAt = Date.now();
  const modelResult = await runValidatedRawEvidenceFinal({
    originalPrompt: promptBundle.prompt,
    allowedEvidenceIds: promptBundle.allowedEvidenceIds,
    allowedAnswerLevels: promptBundle.allowedAnswerLevels,
    invoke: ({ prompt }) => callRagModel({
      prompt,
      env,
      modelInvoker,
      dryRun,
      fetchImpl,
      now,
      thinkingMode,
      reasoningEffort,
      signal,
    }),
  });
  timingsMs.finalModel = elapsedMs(finalModelStartedAt);
  timingsMs.total = elapsedMs(pipelineStartedAt);

  const publicProviderFailure = sanitizeProviderFailure(modelResult.providerFailure);
  const publicGenerationAttempts = sanitizeGenerationAttempts(modelResult.generationAttempts);
  const normalized = bindAnswerEvidence(modelResult.answer, evidence, promptBundle.allowedEvidenceIds);
  const displayCards = dedupeCards([
    ...(effectiveCardResolution.resolvedCards || []),
    ...userProvidedCards(evidence.userProvidedCardTexts || []),
  ]).map(toPublicResolvedCard);
  const auxiliaryUsage = sumUsage([
    cardNameModel.tokenUsage,
    ruleQueryModel.tokenUsage,
  ]);
  const auxiliaryCostCny = Number(cardNameModel.estimatedCostCny || 0)
    + Number(ruleQueryModel.estimatedCostCny || 0);

  return {
    mode: "rag_baseline",
    answerLevel: normalized.answerLevel,
    shortAnswer: normalized.shortAnswer,
    reasoning: normalized.reasoning,
    usedEvidence: normalized.usedEvidence,
    resolvedCards: displayCards,
    missingInfo: normalized.missingInfo,
    riskFlags: normalized.riskFlags,
    confidenceSelfEstimate: normalized.confidenceSelfEstimate,
    formalQueryResults: [],
    engine: {
      requested: false,
      status: "disabled",
      scenarioSource: "disabled",
      bestEffort: false,
      planningWarnings: [],
      planSummary: null,
    },
    engineSimulation: null,
    formalEngine: { mode: "off", status: "disabled" },
    legacyLua: {
      requested: false,
      status: "disabled",
      canConfirmOfficialRuling: false,
    },
    debug: {
      mode: "rag_baseline",
      rawEvidenceOnly: true,
      retrievalMode: "raw_generic",
      engineStatus: "disabled",
      retrievalCounts: rawRetrievalCounts(evidence),
      unresolvedMentions: effectiveCardResolution.unresolvedMentions || [],
      ambiguousMentions: [
        ...(effectiveCardResolution.ambiguousMentions || []),
        ...(evidence.baigeAmbiguousMentions || []),
      ],
      modelCardNameCandidates: effectiveCardResolution.modelCardNameCandidates || [],
      cardNameModelUsed: cardNameModel.modelUsed,
      cardNameProviderUsed: cardNameModel.providerUsed,
      cardNameModelDryRun: cardNameModel.dryRun,
      cardNameModelTokenUsage: cardNameModel.tokenUsage || {},
      cardNameModelCostCny: cardNameModel.estimatedCostCny || 0,
      cardNameWarnings: cardNameModel.warnings || [],
      ruleQueryCount: (ruleQueryModel.queries || []).length,
      ruleQueryModelUsed: ruleQueryModel.modelUsed,
      ruleQueryProviderUsed: ruleQueryModel.providerUsed,
      ruleQueryModelDryRun: ruleQueryModel.dryRun,
      ruleQueryModelTokenUsage: ruleQueryModel.tokenUsage || {},
      ruleQueryModelCostCny: ruleQueryModel.estimatedCostCny || 0,
      ruleQueryWarnings: ruleQueryModel.warnings || [],
      extractionCacheHits: {
        cardNameModel: cardNameModel.cacheHit === true,
        ruleQueryModel: ruleQueryModel.cacheHit === true,
      },
      extractionSingleflightHits: {
        cardNameModel: cardNameModel.singleflightHit === true,
        ruleQueryModel: ruleQueryModel.singleflightHit === true,
      },
      auxiliaryCacheHit: cardNameModel.cacheHit === true || ruleQueryModel.cacheHit === true,
      auxiliaryTokenUsage: auxiliaryUsage,
      auxiliaryEstimatedCostCny: auxiliaryCostCny,
      auxiliaryEstimatedCostUsd: 0,
      retrievalWarnings: unique([
        ...(evidence.retrievalWarnings || []),
        ...(promptBundle.warnings || []),
      ]),
      baigeSearchCount: evidence.debug?.baigeSearchCount || 0,
      baigeCacheHitCount: evidence.debug?.baigeCacheHitCount || 0,
      baigeWarnings: evidence.debug?.baigeWarnings || [],
      retrievalStageTimingsMs: evidence.debug?.timingsMs || {},
      providerUsed: modelResult.providerUsed || modelResult.provider,
      modelUsed: modelResult.modelUsed,
      modelName: modelResult.modelName,
      requestedModel: String(modelResult.generationConfig?.requestModel || modelResult.modelName || "") || null,
      returnedModel: firstReturnedModel(publicGenerationAttempts),
      dryRun: modelResult.dryRun,
      tokenUsage: modelResult.tokenUsage || {},
      estimatedCostCny: auxiliaryCostCny + Number(modelResult.estimatedCostCny || 0),
      estimatedCostUsd: Number(modelResult.estimatedCostUsd || 0),
      budgetStatus: modelResult.budgetStatus || null,
      generationConfig: modelResult.generationConfig || null,
      generationAttempts: publicGenerationAttempts,
      providerFailure: publicProviderFailure,
      // Preferred name: this checks only the output contract and cited IDs.
      // Keep the historical key below for API/log consumer compatibility.
      finalOutputCheck: modelResult.publicFinalValidation || null,
      publicFinalValidation: modelResult.publicFinalValidation || null,
      promptChars: promptBundle.promptChars,
      dataRevision,
      evidenceFingerprint,
      finalPromptSha256,
      promptTruncated: promptBundle.promptTruncated,
      allowedEvidenceCount: promptBundle.allowedEvidenceIds.length,
      authoritativeOfficialDirectId: promptBundle.authoritativeOfficialDirectId || null,
      timingsMs,
    },
  };
}

function bindAnswerEvidence(answer = {}, evidence = {}, allowedEvidenceIds = []) {
  const allowed = new Set((allowedEvidenceIds || []).map(String));
  const byId = new Map(rawEvidenceItems(evidence)
    .filter((item) => allowed.has(String(item?.id || "")))
    .map((item) => [String(item.id), item]));
  const usedEvidence = (Array.isArray(answer.usedEvidence) ? answer.usedEvidence : [])
    .map((item) => {
      const source = byId.get(String(item?.id || ""));
      if (!source) return null;
      return {
        id: String(source.id),
        type: String(source.type || source.recordType || item.type || "related"),
        title: String(source.title || item.title || source.id),
        sourceUrl: String(source.sourceUrl || ""),
      };
    })
    .filter(Boolean);
  return {
    answerLevel: String(answer.answerLevel || "needs_more_info"),
    shortAnswer: String(answer.shortAnswer || ""),
    reasoning: cleanStringArray(answer.reasoning),
    usedEvidence,
    missingInfo: cleanStringArray(answer.missingInfo),
    riskFlags: cleanStringArray(answer.riskFlags),
    confidenceSelfEstimate: ["low", "medium", "high"].includes(answer.confidenceSelfEstimate)
      ? answer.confidenceSelfEstimate
      : "low",
  };
}

function rawEvidenceItems(evidence = {}) {
  return [
    ...(evidence.officialQaDirectCandidates || []),
    ...(evidence.officialQaRelated || []),
    ...(evidence.provisionalOfficialResponses || []),
    ...(evidence.faqRelated || []),
    ...(evidence.cardTexts || []),
    ...(evidence.userProvidedCardTexts || []),
    ...(evidence.rawRelatedEvidence || []),
  ];
}

function rawRetrievalCounts(evidence = {}) {
  return {
    cardTexts: evidence.cardTexts?.length || 0,
    userProvidedCardTexts: evidence.userProvidedCardTexts?.length || 0,
    officialQaDirectCandidates: evidence.officialQaDirectCandidates?.length || 0,
    officialQaRelated: evidence.officialQaRelated?.length || 0,
    provisionalOfficialResponses: evidence.provisionalOfficialResponses?.length || 0,
    faqRelated: evidence.faqRelated?.length || 0,
    rawRelatedEvidence: evidence.rawRelatedEvidence?.length || 0,
  };
}

function buildRagDataRevision(data, env, { cacheByIdentity = false } = {}) {
  if (cacheByIdentity && data && typeof data === "object") {
    const cached = defaultSnapshotRevisionCache.get(data);
    if (cached) return cached;
  }
  const revision = resolveRagDataRevision(data, env.RAG_DATA_REVISION);
  if (cacheByIdentity && data && typeof data === "object") {
    defaultSnapshotRevisionCache.set(data, revision);
  }
  return revision;
}

function sanitizeProviderFailure(value) {
  if (!value || typeof value !== "object") return null;
  const kind = ["access_denied", "timeout", "provider_failure"].includes(value.kind)
    ? value.kind
    : "provider_failure";
  const status = Number(value.status);
  return {
    schemaVersion: 1,
    kind,
    provider: machineIdentifier(value.provider, 64),
    code: machineIdentifier(value.code, 96),
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    requestedModel: machineIdentifier(value.requestedModel, 256),
    reportedModel: machineIdentifier(value.reportedModel, 256),
    finishReason: machineIdentifier(value.finishReason, 64),
  };
}

function sanitizeGenerationAttempts(values = []) {
  return (Array.isArray(values) ? values : []).slice(0, 4).map((value) => ({
    attempt: machineIdentifier(value?.attempt, 64),
    publicAttemptKind: machineIdentifier(value?.publicAttemptKind, 64),
    requestModel: machineIdentifier(value?.requestModel, 256),
    responseModel: machineIdentifier(value?.responseModel, 256),
    finishReason: machineIdentifier(value?.finishReason, 64),
    contentChars: nonNegativeNumber(value?.contentChars),
    reasoningContentPresent: value?.reasoningContentPresent === true,
    reasoningContentChars: nonNegativeNumber(value?.reasoningContentChars),
    usage: numericRecord(value?.usage),
    providerFailure: sanitizeProviderFailure(value?.providerFailure),
  }));
}

function firstReturnedModel(attempts = []) {
  return attempts.map((attempt) => String(attempt?.responseModel || "").trim()).find(Boolean) || null;
}

function userProvidedCards(items) {
  return (items || []).map((item) => ({
    id: item.id || "",
    cardId: "",
    name: (item.cards || [])[0] || item.name || "",
    cnName: (item.cards || [])[0] || item.name || "",
    cardType: "用户提供文本",
    effectText: item.text || "",
    source: "user_provided_text",
    sourceLabel: "用户提供文本",
    official: false,
    aliases: (item.cards || []).filter(Boolean),
  })).filter((card) => card.name && card.effectText);
}

function dedupeCards(cards = []) {
  const result = new Map();
  for (const card of cards) {
    const key = String(card?.id || card?.cardId || card?.name || card?.input || "").trim();
    if (key && !result.has(key)) result.set(key, card);
  }
  return [...result.values()];
}

function toPublicResolvedCard(card = {}) {
  return Object.fromEntries(Object.entries({
    id: String(card.id || card.cardId || ""),
    cardId: String(card.cardId || card.id || ""),
    passcode: String(card.passcode || card.password || ""),
    cid: card.cid === undefined || card.cid === null ? "" : String(card.cid),
    name: String(card.name || card.cnName || card.jaName || card.enName || ""),
    cnName: String(card.cnName || ""),
    jaName: String(card.jaName || card.jpName || ""),
    jpName: String(card.jpName || card.jaName || ""),
    enName: String(card.enName || ""),
    aliases: cleanStringArray(card.aliases),
    cardType: String(card.cardType || card.type || ""),
    type: String(card.type || card.cardType || ""),
    effectText: String(card.effectText || card.text || ""),
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: finiteOrNull(card.atk),
    def: finiteOrNull(card.def),
    level: finiteOrNull(card.level),
    rank: finiteOrNull(card.rank),
    link: finiteOrNull(card.link),
    properties: cleanStringArray(card.properties),
    monsterProperties: cleanStringArray(card.monsterProperties),
    source: String(card.source || ""),
    sourceLabel: String(card.sourceLabel || ""),
    sourceUrl: String(card.sourceUrl || ""),
    official: card.official === true,
    imageUrl: String(card.imageUrl || ""),
    imageCandidates: cleanStringArray(card.imageCandidates),
  }).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

function finiteOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumUsage(items = []) {
  const result = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item || {})) {
      const number = Number(value);
      if (Number.isFinite(number)) result[key] = (result[key] || 0) + number;
    }
  }
  return result;
}

function numericRecord(value) {
  return Object.fromEntries(Object.entries(value || {}).flatMap(([key, item]) => {
    const number = Number(item);
    return Number.isFinite(number) && number >= 0 ? [[key, number]] : [];
  }));
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function machineIdentifier(value, maxChars) {
  return String(value || "").replace(/[^A-Za-z0-9._:/-]/gu, "").slice(0, maxChars);
}

function cleanStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function buildEmptyQuestionAnswer() {
  return {
    mode: "rag_baseline",
    answerLevel: "needs_more_info",
    shortAnswer: "请输入需要分析的裁定问题。",
    reasoning: [],
    usedEvidence: [],
    resolvedCards: [],
    missingInfo: ["需要输入问题。"],
    riskFlags: ["empty_question"],
    confidenceSelfEstimate: "low",
    engine: { requested: false, status: "disabled" },
    engineSimulation: null,
    formalEngine: { mode: "off", status: "disabled" },
    legacyLua: { requested: false, status: "disabled", canConfirmOfficialRuling: false },
    debug: {
      rawEvidenceOnly: true,
      retrievalCounts: {},
      providerUsed: "none",
      modelUsed: "none",
      dryRun: true,
      tokenUsage: {},
      estimatedCostCny: 0,
      estimatedCostUsd: 0,
      budgetStatus: null,
    },
  };
}
