import { createHash } from "node:crypto";
import { extractRagCards, normalizeCardKey } from "./ragCardExtractor.mjs";
import {
  loadRagData,
  retrieveRagEvidence,
} from "./ragEvidenceRetriever.mjs";
import {
  callCardNameExtractionModel,
  callOfficialQaSemanticEquivalenceModel,
  callRagModel,
  callRuleQueryExtractionModel,
  isServerOwnedPrivateEvaluationEnv,
} from "./ragModelClient.mjs";
import { buildRagRulingPromptBundle } from "./ragRulingPrompt.mjs";
import { hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import { runValidatedPublicRagFinal } from "./publicRagAnswerValidator.mjs";
import { retrieveExactOfficialQaDirect } from "./officialQaExactDirect.mjs";
import {
  createOfficialQaSemanticEquivalenceVerifier,
  runOfficialQaSemanticDirectExperiment,
} from "./officialQaSemanticDirectExperiment.mjs";
import { resolveRagDataRevision } from "./ragDataRevisionManifest.mjs";
import {
  beginPrivateEvaluationStage,
  createPrivateEvaluationDiagnostics,
} from "./privateEvaluationDiagnostics.mjs";

const defaultSnapshotRevisionCache = new WeakMap();

const DISABLED_ENGINE = Object.freeze({
  requested: false,
  status: "disabled",
  scenarioSource: "disabled",
  bestEffort: false,
  planningWarnings: ["pure_llm_pipeline"],
  planSummary: null,
});

const DISABLED_FORMAL_ENGINE = Object.freeze({
  mode: "off",
  enabled: false,
  requested: false,
  status: "disabled",
});

const DISABLED_LEGACY_LUA = Object.freeze({
  requested: false,
  status: "disabled",
  authority: "DISABLED",
  resourceCount: 0,
  effectCandidateCount: 0,
  activationLegalityCheckCount: 0,
  predicateApis: [],
  atomicOperations: [],
  unknownReasonCodes: [],
  canConfirmOfficialRuling: false,
});

const DISABLED_AUXILIARY_STAGE = Object.freeze({
  status: "disabled",
  modelUsed: "none",
  providerUsed: "none",
  dryRun: true,
  warnings: ["pure_llm_pipeline"],
  tokenUsage: {},
  estimatedCostCny: 0,
  estimatedCostUsd: 0,
  budgetStatus: null,
  cacheHit: false,
  singleflightHit: false,
});

export async function answerRagRulingQuestion(options = {}) {
  const diagnostics = createPrivateEvaluationDiagnostics({
    env: options.env || globalThis.process?.env || {},
    traceId: options.privateEvaluationTraceId,
    write: options.privateEvaluationDiagnosticWrite,
  });
  const totalStage = beginPrivateEvaluationStage(diagnostics, "total");
  try {
    const answer = await answerRagRulingQuestionInternal({
      ...options,
      privateEvaluationDiagnostics: diagnostics,
    });
    totalStage.end();
    return answer;
  } catch (error) {
    totalStage.fail(error);
    throw error;
  }
}

async function answerRagRulingQuestionInternal({
  question,
  userQuery,
  dataDir,
  cards,
  records,
  qaRecords,
  modelInvoker,
  cardModelInvoker,
  ruleModelInvoker,
  semanticModelInvoker,
  dryRun,
  fetchImpl,
  now,
  env = globalThis.process?.env || {},
  thinkingMode,
  reasoningEffort,
  signal,
  privateEvaluationDiagnostics,
  officialQaDiscovery,
  officialQaExactCandidatePoolComplete = false,
  officialQaExactOnly = false,
  officialQaExactAlreadyChecked = false,
  onOfficialQaExactTiming,
} = {}) {
  const pipelineStartedAt = Date.now();
  const timingsMs = {};
  const query = String(question || userQuery || "").trim();
  if (!query) return buildEmptyQuestionAnswer();

  const dataStartedAt = Date.now();
  const dataStage = beginPrivateEvaluationStage(privateEvaluationDiagnostics, "data_load");
  const usesCompleteDefaultSnapshot = !(cards || records || qaRecords);
  let data;
  let dataRevision;
  try {
    data = await Promise.resolve(!usesCompleteDefaultSnapshot
      ? { cards: cards || [], records: records || [], qaRecords: qaRecords || [] }
      : loadRagData(dataDir));
    dataRevision = buildRagDataRevision(data, env, {
      cacheByIdentity: usesCompleteDefaultSnapshot,
    });
    dataStage.end();
  } catch (error) {
    dataStage.fail(error);
    throw error;
  }
  timingsMs.dataLoad = elapsedMs(dataStartedAt);

  if (!officialQaExactAlreadyChecked) {
    const exactStartedAt = Date.now();
    const exactMatch = await retrieveExactOfficialQaDirect({
      question: query,
      cards: data.cards || [],
      qaRecords: data.qaRecords || [],
      qaDiscovery: officialQaDiscovery,
      dataDir,
      candidatePoolComplete: officialQaExactCandidatePoolComplete,
      fetchImpl,
      env,
      signal,
    });
    timingsMs.officialQaExact = elapsedMs(exactStartedAt);
    if (typeof onOfficialQaExactTiming === "function") {
      onOfficialQaExactTiming(timingsMs.officialQaExact);
    }
    if (exactMatch.status === "matched") {
      timingsMs.total = elapsedMs(pipelineStartedAt);
      return buildOfficialQaExactDirectAnswer(exactMatch, timingsMs, dataRevision);
    }
  }
  if (officialQaExactOnly) return null;

  const extractionStartedAt = Date.now();
  const extractionStage = beginPrivateEvaluationStage(privateEvaluationDiagnostics, "extraction");
  const preflightStartedAt = Date.now();
  let cardNameModel;
  let ruleQueryModel;
  let cardResolution;
  try {
    const maxCards = readNumber(env.RAG_MAX_CARDS, 6);
    const localCardResolution = extractRagCards(query, {
      cards: data.cards || [],
      maxCards,
    });
    timingsMs.deterministicPreflight = elapsedMs(preflightStartedAt);

    const cardNameExtractionStartedAt = Date.now();
    cardNameModel = await callCardNameExtractionModel({
      userQuery: query,
      dataRevision,
      env,
      modelInvoker: cardModelInvoker,
      fetchImpl,
      dryRun,
      now,
      signal,
    });
    cardResolution = (cardNameModel.candidates || []).length
      ? extractRagCards(query, {
        cards: data.cards || [],
        maxCards,
        modelCardNameCandidates: cardNameModel.candidates,
      })
      : localCardResolution;
    timingsMs.cardNameExtraction = elapsedMs(cardNameExtractionStartedAt);
    // Compatibility aggregate for older diagnostics. This is not a UI stage:
    // card-name extraction and rule-query extraction are measured separately.
    timingsMs.auxiliaryExtractionModels = timingsMs.cardNameExtraction;
    extractionStage.end();
  } catch (error) {
    extractionStage.fail(error);
    throw error;
  }
  timingsMs.dataAndQueryExtraction = elapsedMs(extractionStartedAt);

  let officialQaSemanticFallbackReason = "";
  if (shouldEnableOfficialQaSemanticDirect(env)) {
    const semanticStartedAt = Date.now();
    let semanticModelResult = null;
    try {
      const semanticResult = await runOfficialQaSemanticDirectExperiment({
        userQuestion: query,
        records: data.qaRecords || [],
        resolvedCards: cardResolution.resolvedCards || [],
        cards: data.cards || [],
        verifier: createOfficialQaSemanticEquivalenceVerifier({
          model: "gpt-5.6-sol",
          reasoningEffort: "low",
          invoke: async ({ prompt }) => {
            semanticModelResult = await callOfficialQaSemanticEquivalenceModel({
              prompt,
              env,
              modelInvoker: semanticModelInvoker,
              fetchImpl,
              now,
              dryRun,
              signal,
            });
            if (semanticModelResult.status !== "completed" || !semanticModelResult.rawText) {
              throw new Error(semanticModelResult.warnings?.[0] || "semantic equivalence model unavailable");
            }
            return semanticModelResult.rawText;
          },
        }),
      });
      officialQaSemanticFallbackReason = String(semanticResult.reason || "");
      if (semanticResult.status === "matched") {
        timingsMs.officialQaSemantic = elapsedMs(semanticStartedAt);
        timingsMs.finalModelAndValidation = timingsMs.officialQaSemantic;
        timingsMs.finalModel = timingsMs.finalModelAndValidation;
        timingsMs.total = elapsedMs(pipelineStartedAt);
        return buildOfficialQaSemanticDirectAnswer({
          match: semanticResult,
          modelResult: semanticModelResult,
          resolvedCards: cardResolution.resolvedCards || [],
          timingsMs,
          dataRevision,
        });
      }
    } catch (error) {
      // Semantic direct is an optional fail-closed shortcut. Any unexpected
      // failure must leave the ordinary ruling path available.
      officialQaSemanticFallbackReason = `semantic_direct_failed:${String(error?.code || error?.name || "error")}`;
    } finally {
      timingsMs.officialQaSemantic ??= elapsedMs(semanticStartedAt);
    }
  }

  const retrievalStartedAt = Date.now();
  const retrievalStage = beginPrivateEvaluationStage(privateEvaluationDiagnostics, "retrieval");
  let retrievedEvidence;
  try {
    retrievedEvidence = await retrieveRagEvidence({
      userQuery: query,
      cardResolution,
      dataDir,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      enableLiveOfficialQa: true,
      subsumptionCandidatePoolComplete: usesCompleteDefaultSnapshot,
      ruleSearchQueryProvider: async ({
        resolvedCards,
        userProvidedCardTexts,
        candidateQuestions,
      }) => {
        const ruleQueryStartedAt = Date.now();
        ruleQueryModel = await callRuleQueryExtractionModel({
          userQuery: query,
          resolvedCards,
          userProvidedCardTexts,
          candidateQuestions,
          dataRevision,
          env,
          modelInvoker: ruleModelInvoker,
          fetchImpl,
          dryRun,
          now,
          signal,
        });
        timingsMs.ruleQueryExtraction = elapsedMs(ruleQueryStartedAt);
        timingsMs.auxiliaryExtractionModels =
          (timingsMs.cardNameExtraction || 0) + timingsMs.ruleQueryExtraction;
        return {
          queries: ruleQueryModel.queries || [],
          candidateAssessments: ruleQueryModel.candidateAssessments || [],
        };
      },
      env,
      fetchImpl,
      signal,
    });
    retrievalStage.end();
  } catch (error) {
    retrievalStage.fail(error);
    throw error;
  }
  timingsMs.retrieval = elapsedMs(retrievalStartedAt);
  timingsMs.cardTextRetrieval = readTimingMs(retrievedEvidence, "cardResolution");
  timingsMs.rulebookRetrieval = readTimingMs(retrievedEvidence, "rulebook");
  timingsMs.officialQaRetrieval = readTimingMs(retrievedEvidence, "officialQa");
  timingsMs.relatedEvidenceRetrieval = readTimingMs(retrievedEvidence, "relatedEvidence");

  const effectiveCardResolution = reconcileCardResolution(cardResolution, retrievedEvidence);

  // The public pure-LLM path ends evidence preparation here.  Retrieved card
  // text, FAQ, official Q&A and general rule records are passed through exactly
  // as returned by the retriever. No applicability classifier, handwritten
  // rule component, semantic executor, duel engine, formal engine or Lua
  // analysis may filter, strengthen or replace them before the final model.
  const evidence = retrievedEvidence;
  const promptStartedAt = Date.now();
  const promptStage = beginPrivateEvaluationStage(privateEvaluationDiagnostics, "prompt_build");
  let promptBundle;
  let evidenceFingerprint;
  let finalPromptSha256;
  let displayCards;
  try {
    promptBundle = buildRagRulingPromptBundle({
      userQuery: query,
      cardResolution: effectiveCardResolution,
      evidence,
      env,
    });
    evidenceFingerprint = sha256Json(evidence);
    finalPromptSha256 = sha256Text(promptBundle.prompt);
    displayCards = dedupeCards([
      ...(effectiveCardResolution.resolvedCards || []),
      ...userProvidedCards(evidence.userProvidedCardTexts || []),
    ]);
    promptStage.end();
  } catch (error) {
    promptStage.fail(error);
    throw error;
  }
  timingsMs.promptBuild = elapsedMs(promptStartedAt);

  const finalModelStartedAt = Date.now();
  const modelResult = await runValidatedPublicRagFinal({
    originalPrompt: promptBundle.prompt,
    // Citation cleanup must use the same downgraded/limited evidence envelope
    // that the final model actually saw. Looking at the broader retriever
    // object here could silently restore direct authority to a semantic-near
    // Q&A that the prompt deliberately classified as related.
    evidence: promptBundle.modelEvidence,
    authoritativeOfficialDirect: promptBundle.authoritativeOfficialDirectId || false,
    invoke: ({ prompt }) => callRagModel({
      prompt,
      // Recovery is deliberately disabled on the pure-LLM public path. The
      // final-answer gate owns one provider invocation and performs local-only
      // parsing/validation after it.
      recoveryPrompt: "",
      evidence,
      cardResolution: effectiveCardResolution,
      env,
      modelInvoker,
      dryRun,
      fetchImpl,
      now,
      thinkingMode,
      reasoningEffort,
      signal,
      privateEvaluationDiagnostics,
    }),
  });
  timingsMs.finalModelAndValidation = elapsedMs(finalModelStartedAt);
  timingsMs.finalModel = timingsMs.finalModelAndValidation;
  timingsMs.total = elapsedMs(pipelineStartedAt);

  const publicProviderFailure = sanitizePublicProviderFailure(modelResult.providerFailure);
  const publicGenerationAttempts = sanitizePublicGenerationAttempts(modelResult.generationAttempts);
  // runValidatedPublicRagFinal applies the display-only contract. The public
  // path preserves that single model's ruling apart from schema cleaning and
  // dropping references to evidence that was never supplied.
  const normalized = modelResult.answer;
  const auxiliaryTokenUsage = sumUsageTelemetry([
    cardNameModel.tokenUsage,
    ruleQueryModel.tokenUsage,
  ]);
  const auxiliaryEstimatedCostCny =
    (cardNameModel.estimatedCostCny || 0)
    + (ruleQueryModel.estimatedCostCny || 0);
  const auxiliaryEstimatedCostUsd =
    (cardNameModel.estimatedCostUsd || 0)
    + (ruleQueryModel.estimatedCostUsd || 0);

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
    engine: { ...DISABLED_ENGINE },
    engineSimulation: null,
    formalEngine: { ...DISABLED_FORMAL_ENGINE },
    legacyLua: { ...DISABLED_LEGACY_LUA },
    debug: {
      mode: "rag_baseline",
      route: "ordinary_rag",
      ...(officialQaSemanticFallbackReason
        ? { officialQaSemanticFallbackReason }
        : {}),
      engineStatus: "disabled",
      engineTraceSha256: null,
      retrievalCounts: {
        cardTexts: evidence.cardTexts?.length || 0,
        userProvidedCardTexts: evidence.userProvidedCardTexts?.length || 0,
        officialQaDirectCandidates: evidence.officialQaDirectCandidates?.length || 0,
        officialQaRelated: evidence.officialQaRelated?.length || 0,
        provisionalOfficialResponses: evidence.provisionalOfficialResponses?.length || 0,
        faqRelated: evidence.faqRelated?.length || 0,
        rawRelatedEvidence: evidence.rawRelatedEvidence?.length || 0,
        rulebookCandidates: evidence.rulebookCandidates?.length || 0,
        operationLegalityChecks: 0,
        unresolvedOperationConstraints: 0,
        legacyLuaEffectCandidates: 0,
        legacyLuaUnknownReasons: 0,
      },
      unresolvedMentions: effectiveCardResolution.unresolvedMentions,
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
      modelRuleSearchQueries: ruleQueryModel.queries || [],
      modelRuleCandidateAssessments: ruleQueryModel.candidateAssessments || [],
      ruleQueryModelUsed: ruleQueryModel.modelUsed,
      ruleQueryProviderUsed: ruleQueryModel.providerUsed,
      ruleQueryModelDryRun: ruleQueryModel.dryRun,
      ruleQueryModelTokenUsage: ruleQueryModel.tokenUsage || {},
      ruleQueryModelCostCny: ruleQueryModel.estimatedCostCny || 0,
      ruleQueryWarnings: ruleQueryModel.warnings || [],
      rulebookGroundingModelUsed: DISABLED_AUXILIARY_STAGE.modelUsed,
      rulebookGroundingProviderUsed: DISABLED_AUXILIARY_STAGE.providerUsed,
      rulebookGroundingDryRun: true,
      rulebookGroundingWarnings: DISABLED_AUXILIARY_STAGE.warnings,
      rulebookGroundingTokenUsage: {},
      rulebookGroundingCostCny: 0,
      officialQaApplicabilityStatus: DISABLED_AUXILIARY_STAGE.status,
      officialQaApplicabilityModelUsed: DISABLED_AUXILIARY_STAGE.modelUsed,
      officialQaApplicabilityProviderUsed: DISABLED_AUXILIARY_STAGE.providerUsed,
      officialQaApplicabilityRequestedModel: null,
      officialQaApplicabilityReturnedModel: null,
      officialQaApplicabilityWarnings: DISABLED_AUXILIARY_STAGE.warnings,
      officialQaApplicabilityTokenUsage: {},
      officialQaApplicabilityCostCny: 0,
      officialQaApplicabilityCostUsd: 0,
      officialQaApplicabilityBudgetStatus: null,
      officialQaApplicabilityRejectedCount: 0,
      extractionCacheHits: {
        cardNameModel: cardNameModel.cacheHit === true,
        ruleQueryModel: ruleQueryModel.cacheHit === true,
        rulebookGroundingModel: false,
        officialQaApplicabilityModel: false,
      },
      extractionSingleflightHits: {
        cardNameModel: cardNameModel.singleflightHit === true,
        ruleQueryModel: ruleQueryModel.singleflightHit === true,
        rulebookGroundingModel: false,
        officialQaApplicabilityModel: false,
      },
      auxiliaryCacheHit: cardNameModel.cacheHit === true || ruleQueryModel.cacheHit === true,
      auxiliaryTokenUsage,
      auxiliaryEstimatedCostCny,
      auxiliaryEstimatedCostUsd,
      retrievalWarnings: [...new Set([
        ...(evidence.retrievalWarnings || []),
        ...(promptBundle.warnings || []),
      ])],
      baigeSearchCount: evidence.debug?.baigeSearchCount || 0,
      baigeCacheHitCount: evidence.debug?.baigeCacheHitCount || 0,
      baigeWarnings: evidence.debug?.baigeWarnings || [],
      retrievalStageTimingsMs: evidence.debug?.timingsMs || {},
      providerUsed: modelResult.providerUsed || modelResult.provider,
      modelUsed: modelResult.modelUsed,
      modelName: modelResult.modelName,
      requestedModel: String(
        modelResult.generationConfig?.requestModel || modelResult.modelName || "",
      ) || null,
      returnedModel: firstReturnedModel(publicGenerationAttempts),
      dryRun: modelResult.dryRun,
      tokenUsage: modelResult.tokenUsage || {},
      estimatedCostCny: auxiliaryEstimatedCostCny + (modelResult.estimatedCostCny || 0),
      estimatedCostUsd: auxiliaryEstimatedCostUsd + (modelResult.estimatedCostUsd || 0),
      budgetStatus: modelResult.budgetStatus || null,
      generationConfig: modelResult.generationConfig || null,
      generationAttempts: publicGenerationAttempts,
      providerFailure: publicProviderFailure,
      publicFinalValidation: modelResult.publicFinalValidation || null,
      promptChars: promptBundle.promptChars,
      dataRevision,
      evidenceFingerprint,
      finalPromptSha256,
      promptTruncated: promptBundle.promptTruncated,
      selectedEvidenceDiagnostics: promptBundle.evidenceSelectionDiagnostics || [],
      ruleQueryPlanDiagnostics: promptBundle.ruleQueryPlanDiagnostics || [],
      ...(privateEvaluationDiagnostics?.enabled === true
        && isServerOwnedPrivateEvaluationEnv(env) ? {
        retrievalCandidateStages: evidence.debug?.candidateStages || {},
      } : {}),
      semanticStateTransition: null,
      semanticStateTransitionDiagnostic: null,
      deterministicDecision: null,
      timingsMs,
    },
  };
}

function reconcileCardResolution(cardResolution = {}, evidence = {}) {
  const resolvedCards = dedupeCards([
    ...(evidence.retrievedCards || []),
    ...(cardResolution.resolvedCards || []),
  ]);
  const remainingUnresolved = Array.isArray(evidence.remainingUnresolvedMentions)
    ? evidence.remainingUnresolvedMentions
    : (cardResolution.unresolvedMentions || [])
        .filter((mention) => !cardMatchesMention(mention, resolvedCards));
  const ambiguousMentions = (cardResolution.ambiguousMentions || [])
    .filter((mention) => !cardMatchesMention(mention, resolvedCards));
  return {
    ...cardResolution,
    resolvedCards,
    unresolvedMentions: remainingUnresolved,
    ambiguousMentions,
  };
}

function cardMatchesMention(mention, cards) {
  const mentionKey = normalizeCardKey(mention?.input);
  if (!mentionKey) return false;
  return (cards || []).some((card) => {
    const identityText = [
      card.name,
      card.cnName,
      card.jaName,
      card.jpName,
      card.enName,
      ...(card.aliases || []),
    ].filter(Boolean).join(" ");
    if (hasNumberedCardIdentityConflict(mention?.input, identityText)) return false;
    const inputKey = normalizeCardKey(card.input || card.matchedQuery);
    if (inputKey && inputKey === mentionKey) return true;
    const names = [
      card.name,
      card.cnName,
      card.jaName,
      card.jpName,
      card.enName,
      ...(card.aliases || []),
    ].map(normalizeCardKey).filter(Boolean);
    return names.some((name) => (
      name === mentionKey
      || (mentionKey.length >= 3 && (name.includes(mentionKey) || mentionKey.includes(name)))
    ));
  });
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
    formalQueryResults: [],
    engine: { ...DISABLED_ENGINE },
    engineSimulation: null,
    formalEngine: { ...DISABLED_FORMAL_ENGINE },
    legacyLua: { ...DISABLED_LEGACY_LUA },
    debug: {
      retrievalCounts: {},
      providerUsed: "none",
      modelUsed: "none",
      dryRun: true,
      tokenUsage: {},
      estimatedCostCny: 0,
      estimatedCostUsd: 0,
      budgetStatus: null,
      semanticStateTransition: null,
      semanticStateTransitionDiagnostic: null,
    },
  };
}

function buildOfficialQaExactDirectAnswer(match, timingsMs, dataRevision) {
  return {
    mode: "rag_baseline",
    answerLevel: "official_confirmed",
    shortAnswer: match.officialAnswerJapanese,
    reasoning: ["以下内容为当前官方数据库的完整日文回答，未经裁定模型改写。"],
    usedEvidence: [{
      id: match.recordId,
      type: "official_qa",
      title: match.title,
      sourceUrl: match.sourceUrl,
    }],
    resolvedCards: match.resolvedCards || [],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "high",
    officialQuestionJapanese: match.officialQuestionJapanese,
    officialAnswerJapanese: match.officialAnswerJapanese,
    officialQaId: match.qaId,
    formalQueryResults: [],
    engine: { ...DISABLED_ENGINE },
    engineSimulation: null,
    formalEngine: { ...DISABLED_FORMAL_ENGINE },
    legacyLua: { ...DISABLED_LEGACY_LUA },
    debug: {
      mode: "official_qa_exact_direct",
      route: "official_qa_exact_direct",
      modelCalls: 0,
      providerUsed: "none",
      modelUsed: "none",
      dryRun: true,
      tokenUsage: {},
      estimatedCostCny: 0,
      estimatedCostUsd: 0,
      budgetStatus: null,
      retrievalCounts: { officialQaDirectCandidates: 1 },
      candidatePoolComplete: match.candidatePoolComplete,
      candidateQaIds: match.candidateQaIds,
      queryHash: match.queryHash,
      dataRevision,
      timingsMs,
      semanticStateTransition: null,
      semanticStateTransitionDiagnostic: null,
    },
  };
}

function buildOfficialQaSemanticDirectAnswer({
  match,
  modelResult,
  resolvedCards,
  timingsMs,
  dataRevision,
}) {
  return {
    mode: "rag_baseline",
    answerLevel: "official_confirmed",
    shortAnswer: match.officialAnswerJapanese,
    reasoning: ["以下内容为当前官方数据库的完整日文回答；模型仅验证问题语义等价，未读取或改写官方答案。"],
    usedEvidence: [{
      id: match.recordId,
      type: "official_qa",
      title: `官方 Q&A ${match.qaId}`,
      sourceUrl: match.sourceUrl,
    }],
    resolvedCards,
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "high",
    officialQuestionJapanese: match.officialQuestionJapanese,
    officialAnswerJapanese: match.officialAnswerJapanese,
    officialQaId: match.qaId,
    formalQueryResults: [],
    engine: { ...DISABLED_ENGINE },
    engineSimulation: null,
    formalEngine: { ...DISABLED_FORMAL_ENGINE },
    legacyLua: { ...DISABLED_LEGACY_LUA },
    debug: {
      mode: "official_qa_semantic_direct",
      route: "official_qa_semantic_direct",
      experimental: true,
      providerUsed: modelResult?.providerUsed || "relay",
      modelUsed: modelResult?.modelUsed || "gpt-5.6-sol",
      reasoningEffort: "low",
      dryRun: false,
      tokenUsage: modelResult?.tokenUsage || {},
      estimatedCostCny: 0,
      estimatedCostUsd: Number(modelResult?.estimatedCostUsd || 0),
      budgetStatus: modelResult?.budgetStatus || null,
      retrievalCounts: { officialQaDirectCandidates: 1 },
      candidateQaIds: match.candidateQaIds,
      semanticEquivalence: match.verification,
      modelCalls: 1,
      dataRevision,
      timingsMs,
      semanticStateTransition: null,
      semanticStateTransitionDiagnostic: null,
    },
  };
}

export function shouldEnableOfficialQaSemanticDirect(env = globalThis.process?.env || {}) {
  const explicit = String(env.OFFICIAL_QA_SEMANTIC_DIRECT_ENABLED || "").trim();
  if (/^(?:0|false|no|off)$/iu.test(explicit)) return false;
  if (/^(?:1|true|yes|on)$/iu.test(explicit)) return true;
  return ["preview", "production"].includes(
    String(env.VERCEL_ENV || "").trim().toLowerCase(),
  );
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function readTimingMs(evidence, key) {
  const value = Number(evidence?.debug?.timingsMs?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function dedupeCards(cards) {
  const map = new Map();
  for (const card of cards || []) {
    const key = String(card.id || card.cardId || card.name || card.input || "").trim();
    if (!key || map.has(key)) continue;
    map.set(key, card);
  }
  return [...map.values()];
}

function userProvidedCards(items) {
  return (items || []).map((item) => ({
    id: item.id || "",
    cardId: "",
    name: (item.cards || [])[0] || item.name || "",
    cnName: (item.cards || [])[0] || item.name || "",
    jaName: "",
    enName: "",
    cardType: "用户提供文本",
    effectText: item.text || "",
    source: "user_provided_text",
    sourceLabel: "用户提供文本",
    official: false,
    aliases: (item.cards || []).filter(Boolean),
  })).filter((card) => card.name && card.effectText);
}

function sanitizePublicProviderFailure(value) {
  const kind = normalizePublicProviderFailureKind(value?.kind);
  if (!kind) return null;
  const status = Number(value?.status);
  return {
    schemaVersion: 1,
    kind,
    provider: publicMachineIdentifier(value?.provider, 64),
    code: kind === "access_denied"
      ? "model_provider_access_denied"
      : kind === "timeout"
        ? "model_provider_timeout"
        : "model_provider_error",
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    requestedModel: publicMachineIdentifier(value?.requestedModel, 256),
    reportedModel: publicMachineIdentifier(value?.reportedModel, 256),
    finishReason: publicFinishReason(value?.finishReason),
  };
}

function sanitizePublicGenerationAttempts(values = []) {
  return (Array.isArray(values) ? values : []).slice(0, 8).map((value) => ({
    attempt: publicMachineIdentifier(value?.attempt, 64),
    publicAttemptKind: publicMachineIdentifier(value?.publicAttemptKind, 64),
    requestModel: publicMachineIdentifier(value?.requestModel, 256),
    responseModel: publicMachineIdentifier(value?.responseModel, 256),
    systemFingerprint: publicMachineIdentifier(value?.systemFingerprint, 256),
    thinkingMode: publicMachineIdentifier(value?.thinkingMode, 64),
    reasoningEffort: value?.reasoningEffort == null
      ? null
      : publicMachineIdentifier(value.reasoningEffort, 64),
    maxOutputTokens: publicNonNegativeNumber(value?.maxOutputTokens),
    responseFormat: publicMachineIdentifier(value?.responseFormat, 64),
    finishReason: publicFinishReason(value?.finishReason),
    contentChars: publicNonNegativeNumber(value?.contentChars) || 0,
    reasoningContentPresent: value?.reasoningContentPresent === true,
    reasoningContentChars: publicNonNegativeNumber(value?.reasoningContentChars) || 0,
    usage: publicNumericRecord(value?.usage),
    providerFailure: sanitizePublicProviderFailure(value?.providerFailure),
    streamMetrics: sanitizePublicStreamMetrics(value?.streamMetrics),
  }));
}

function sanitizePublicStreamMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    schemaVersion: 1,
    transport: "sse",
    requestToResponseHeadersMs: publicNonNegativeNumber(value.requestToResponseHeadersMs),
    requestToFirstByteMs: publicNonNegativeNumber(value.requestToFirstByteMs),
    requestToFirstEventMs: publicNonNegativeNumber(value.requestToFirstEventMs),
    requestToFirstContentMs: publicNonNegativeNumber(value.requestToFirstContentMs),
    requestToCompleteMs: publicNonNegativeNumber(value.requestToCompleteMs),
    networkChunkCount: publicNonNegativeNumber(value.networkChunkCount) || 0,
    sseEventCount: publicNonNegativeNumber(value.sseEventCount) || 0,
    visibleContentChunkCount: publicNonNegativeNumber(value.visibleContentChunkCount) || 0,
    responseBytes: publicNonNegativeNumber(value.responseBytes) || 0,
    visibleContentBytes: publicNonNegativeNumber(value.visibleContentBytes) || 0,
    finishReason: publicFinishReason(value.finishReason) || null,
  };
}

function normalizePublicProviderFailureKind(value) {
  const kind = String(value || "").trim();
  return ["access_denied", "timeout", "provider_failure"].includes(kind) ? kind : "";
}

function publicFinishReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  return [
    "stop",
    "length",
    "max_tokens",
    "token_limit",
    "content_filter",
    "tool_calls",
    "function_call",
    "timeout",
    "cancelled",
    "canceled",
    "incomplete",
    "error",
  ].includes(reason) ? reason : "";
}

function publicMachineIdentifier(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(text)) return "";
  return text;
}

function publicNonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function publicNumericRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => /^[A-Za-z0-9_]+$/u.test(key) && Number.isFinite(Number(item)))
    .slice(0, 32)
    .map(([key, item]) => [key, Number(item)]));
}

function buildRagDataRevision(data = {}, env = {}, { cacheByIdentity = false } = {}) {
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

function sha256Json(value) {
  return sha256Text(stableDiagnosticJson(value));
}

function sha256Text(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stableDiagnosticJson(value, seen = new WeakSet()) {
  if (value === undefined) return '"[undefined]"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((item) => stableDiagnosticJson(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${stableDiagnosticJson(value[key], seen)}`
      )).join(",")}}`;
  seen.delete(value);
  return serialized;
}

function sumUsageTelemetry(items = []) {
  const total = {};
  for (const item of items || []) {
    for (const [key, value] of Object.entries(item || {})) {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      total[key] = (total[key] || 0) + number;
    }
  }
  return total;
}

function firstReturnedModel(attempts = []) {
  const model = (attempts || [])
    .map((attempt) => String(attempt?.responseModel || "").trim())
    .find(Boolean);
  return model || null;
}
