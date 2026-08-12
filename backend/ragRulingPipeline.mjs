import { createHash } from "node:crypto";
import { requestOcgEngineSimulation } from "./ocgEngineClient.mjs";
import { autoEngineSimulationEnabled, buildBestEffortEngineScenario } from "./ocgScenarioPlanner.mjs";
import { runFormalEngineShadow } from "./formalEngineShadow.mjs";
import { createDefaultFormalScenarioDraftInvoker } from "./formalScenarioDraftModel.mjs";
import { normalizeCardText } from "./cardTextNormalizer.mjs";
import { extractRagCards, normalizeCardKey } from "./ragCardExtractor.mjs";
import { evidenceBucketsToList, loadRagData, retrieveRagEvidence } from "./ragEvidenceRetriever.mjs";
import {
  callCardNameExtractionModel,
  callOfficialQaApplicabilityModel,
  callRagModel,
  callRuleQueryExtractionModel,
} from "./ragModelClient.mjs";
import {
  buildRagRulingPromptBundle,
  RAG_ANSWER_LEVELS,
} from "./ragRulingPrompt.mjs";
import { analyzeEffectStateTransition } from "./effectStateReasoner.mjs";
import { hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import { runValidatedPublicRagFinal } from "./publicRagAnswerValidator.mjs";
import { compileRuleScenario } from "./ruleScenarioCompiler.mjs";
import {
  createLegacyLuaUnknownPacket,
  validateLegacyLuaSemanticPacket,
} from "./legacyLuaSemanticPacket.mjs";
import { buildSummonLegalityContext } from "./summonLegalityContext.mjs";
import { buildEffectApplicabilityContext } from "./effectApplicabilityContext.mjs";
import { resolveRagDataRevision } from "./ragDataRevisionManifest.mjs";

const defaultSnapshotRevisionCache = new WeakMap();

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
  rulebookModelInvoker,
  applicabilityModelInvoker,
  dryRun,
  fetchImpl,
  now,
  env = globalThis.process?.env || {},
  engineScenario,
  engineFetchImpl,
  formalScenarioDraft,
  formalScenarioDraftInvoker,
  formalScenarioDraftVerifier,
  formalExpectedScenarioDraftVerifierId,
  formalExpectedScenarioDraftVerifierVersion,
  formalProofVerifier,
  formalExpectedVersions,
  formalFetchImpl,
  formalScenarioDraftTimeoutMs,
  legacyLuaSemanticPacketFactory,
  thinkingMode,
  reasoningEffort,
  signal,
} = {}) {
  const pipelineStartedAt = Date.now();
  const timingsMs = {};
  const query = String(question || userQuery || "").trim();
  if (!query) return buildEmptyQuestionAnswer();

  const extractionStartedAt = Date.now();
  const dataStartedAt = Date.now();
  const usesCompleteDefaultSnapshot = !(cards || records || qaRecords);
  const data = await Promise.resolve(!usesCompleteDefaultSnapshot
    ? { cards: cards || [], records: records || [], qaRecords: qaRecords || [] }
    : loadRagData(dataDir));
  const dataRevision = buildRagDataRevision(data, env, {
    cacheByIdentity: usesCompleteDefaultSnapshot,
  });
  timingsMs.dataLoad = elapsedMs(dataStartedAt);

  const preflightStartedAt = Date.now();
  const maxCards = readNumber(env.RAG_MAX_CARDS, 6);
  const localCardResolution = extractRagCards(query, {
    cards: data.cards || [],
    maxCards,
  });
  // Card/rule extraction is evidence preparation.  A partial local reasoner
  // must never skip it or sign a public ruling on its own.
  timingsMs.deterministicPreflight = elapsedMs(preflightStartedAt);

  const auxiliaryExtractionStartedAt = Date.now();
  const [cardNameModel, ruleQueryModel] = await Promise.all([
    callCardNameExtractionModel({
      userQuery: query,
      dataRevision,
      env,
      modelInvoker: cardModelInvoker,
      fetchImpl,
      dryRun,
      now,
      signal,
    }),
    callRuleQueryExtractionModel({
      userQuery: query,
      dataRevision,
      env,
      modelInvoker: ruleModelInvoker,
      fetchImpl,
      dryRun,
      now,
      signal,
    }),
  ]);
  const cardResolution = (cardNameModel.candidates || []).length
    ? extractRagCards(query, {
        cards: data.cards || [],
        maxCards,
        modelCardNameCandidates: cardNameModel.candidates,
      })
    : localCardResolution;
  timingsMs.auxiliaryExtractionModels = elapsedMs(auxiliaryExtractionStartedAt);
  timingsMs.dataAndQueryExtraction = elapsedMs(extractionStartedAt);
  const retrievalStartedAt = Date.now();
  const retrievedEvidence = await retrieveRagEvidence({
    userQuery: query,
    cardResolution,
    dataDir,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    enableLiveOfficialQa: true,
    subsumptionCandidatePoolComplete: usesCompleteDefaultSnapshot,
    ruleSearchQueries: ruleQueryModel.queries || [],
    env,
    fetchImpl,
  });
  timingsMs.retrieval = elapsedMs(retrievalStartedAt);
  const effectiveCardResolution = reconcileCardResolution(cardResolution, retrievedEvidence);
  const officialQaApplicabilityStartedAt = Date.now();
  const officialQaApplicabilityPromise = callOfficialQaApplicabilityModel({
    userQuery: query,
    candidates: retrievedEvidence.officialQaRelated || [],
    resolvedCards: effectiveCardResolution.resolvedCards || [],
    dataRevision,
    env,
    modelInvoker: applicabilityModelInvoker,
    fetchImpl,
    now,
    dryRun,
    signal,
  });
  const explicitEngineScenario = engineScenario !== undefined && engineScenario !== null;
  const enginePlan = explicitEngineScenario
    ? {
        source: "explicit",
        bestEffort: false,
        warnings: [],
        planSummary: null,
        scenario: engineScenario,
      }
    : autoEngineSimulationEnabled(env)
      ? buildBestEffortEngineScenario({
          userQuery: query,
          cards: effectiveCardResolution.resolvedCards || [],
        })
      : {
          source: "disabled",
          bestEffort: false,
          warnings: ["automatic_engine_simulation_disabled"],
          planSummary: null,
          scenario: undefined,
        };
  const enginePromise = requestOcgEngineSimulation({
    engineScenario: enginePlan.scenario,
    env,
    fetchImpl: engineFetchImpl || fetchImpl || globalThis.fetch,
  });
  const effectiveFormalScenarioDraftInvoker = formalScenarioDraft || formalScenarioDraftInvoker
    ? formalScenarioDraftInvoker
    : createDefaultFormalScenarioDraftInvoker({
        env,
        fetchImpl: fetchImpl || globalThis.fetch,
        signal,
      });
  const formalShadowPromise = runFormalEngineShadow({
    userQuery: query,
    resolvedCards: effectiveCardResolution.resolvedCards || [],
    cardResolution: effectiveCardResolution,
    scenarioDraft: formalScenarioDraft,
    scenarioDraftInvoker: effectiveFormalScenarioDraftInvoker,
    scenarioDraftVerifier: formalScenarioDraftVerifier,
    expectedScenarioDraftVerifierId: formalExpectedScenarioDraftVerifierId,
    expectedScenarioDraftVerifierVersion: formalExpectedScenarioDraftVerifierVersion,
    env,
    fetchImpl: formalFetchImpl || engineFetchImpl || fetchImpl || globalThis.fetch,
    proofVerifier: formalProofVerifier,
    expectedVersions: formalExpectedVersions,
    scenarioDraftTimeoutMs: formalScenarioDraftTimeoutMs,
    dryRun,
    signal,
  });
  const legacyLuaSemanticPacketPromise = buildLegacyLuaSemanticPacket({
    factory: legacyLuaSemanticPacketFactory,
    userQuery: query,
    cardResolution: effectiveCardResolution,
    evidence: retrievedEvidence,
    env,
    fetchImpl: formalFetchImpl || engineFetchImpl || fetchImpl || globalThis.fetch,
    signal,
  });
  const reasoningCardTexts = attachUserQueryToCardTexts([
    ...(retrievedEvidence.cardTexts || []),
    ...(retrievedEvidence.userProvidedCardTexts || []),
  ], query);
  const cardSemanticFacts = buildCardSemanticFacts(reasoningCardTexts);
  const summonLegalityContext = buildSummonLegalityContext({
    userQuery: query,
    resolvedCards: effectiveCardResolution.resolvedCards || [],
    cardTexts: reasoningCardTexts,
  });
  const effectApplicabilityContext = buildEffectApplicabilityContext({
    userQuery: query,
    resolvedCards: effectiveCardResolution.resolvedCards || [],
    cardTexts: reasoningCardTexts,
  });
  const playerRoleBindings = buildPlayerRoleBindings({
    userQuery: query,
    cardTexts: reasoningCardTexts,
  });
  const officialQaApplicability = await officialQaApplicabilityPromise;
  timingsMs.officialQaApplicability = Number(
    officialQaApplicability.durationMs
      ?? elapsedMs(officialQaApplicabilityStartedAt),
  );
  const reviewedRetrievedEvidence = applyOfficialQaApplicabilityReview(
    retrievedEvidence,
    officialQaApplicability,
  );
  const corroboratingEvidence = dedupeEvidenceRefs([
    ...(reviewedRetrievedEvidence.officialQaDirectCandidates || []),
    ...(reviewedRetrievedEvidence.provisionalOfficialResponses || []),
    ...(reviewedRetrievedEvidence.officialQaRelated || []),
  ]);
  const localReasoningStartedAt = Date.now();
  const localRulebookGrounding = buildLocalRulebookGrounding({
    userQuery: query,
    cardTexts: reasoningCardTexts,
    evidence: reviewedRetrievedEvidence,
    env,
  });
  const locallyGroundedEvidence = attachRulebookGrounding(reviewedRetrievedEvidence, localRulebookGrounding);
  // The local executor is an evidence-discovery aid only.  It records movement
  // provenance and timing checkpoints that are easy to miss in prose (for
  // example, a summon procedure requesting a banish while a leave-field card
  // effect supplies the final banish cause).  It never signs the public ruling:
  // the final model must verify every claim against the raw card text and the
  // retrieved official material below.
  const localSemanticStateTransition = analyzeEffectStateTransition({
    userQuery: query,
    cardTexts: reasoningCardTexts,
    corroboratingEvidence,
    operationLegality: locallyGroundedEvidence.operationLegality,
    resolvedCards: effectiveCardResolution.resolvedCards || [],
  });
  const semanticAuthorityAssessment = null;
  // The local executor is deliberately demoted before it enters the evidence
  // packet. Some analyzers can produce a complete/authoritative result for
  // their own closed-world contract, but the public assistant still requires
  // the final model to judge the whole user question. Keeping the trajectory
  // while clearing authority lets it improve discovery without turning it into
  // a hidden validator or a second final-ruling engine.
  const semanticStateTransition = demoteSemanticTransitionForFinalModel(
    localSemanticStateTransition,
  );
  const localDecisionComplete = false;
  timingsMs.semanticStateExecution = elapsedMs(localReasoningStartedAt);
  timingsMs.localReasoning = elapsedMs(localReasoningStartedAt);

  const rulebookStartedAt = Date.now();
  // The old grounding model attempted to decide legality while preparing
  // evidence.  That duplicated the final judge and could bind player roles
  // incorrectly.  Retrieval candidates are now passed directly to the final
  // model, which performs the only ruling analysis.
  const rulebookGrounding = {
    ...localRulebookGrounding,
    warnings: ["rulebook_grounding_disabled_simple_pipeline"],
  };
  timingsMs.rulebookGrounding = elapsedMs(rulebookStartedAt);
  const groundedEvidence = attachRulebookGrounding(reviewedRetrievedEvidence, rulebookGrounding);
  const formalStartedAt = Date.now();
  const formalShadow = await formalShadowPromise;
  timingsMs.formalEngineAwait = elapsedMs(formalStartedAt);
  const legacyLuaStartedAt = Date.now();
  const legacyLuaSemanticPacket = await legacyLuaSemanticPacketPromise;
  timingsMs.legacyLuaSemanticPacketAwait = elapsedMs(legacyLuaStartedAt);
  const evidence = {
    ...groundedEvidence,
    semanticStateTransition,
    // Normalized operations remain explicitly non-authoritative candidates.
    // They give the final model a lossless description of card-text lifecycles,
    // while the prompt still requires verification against the raw card text.
    cardSemanticFacts,
    summonLegalityContext,
    effectApplicabilityContext,
    playerRoleBindings,
    legacyLuaSemanticPacket,
    formalEngineProofs: [],
    formalEngineStatus: summarizeFormalShadow(formalShadow),
  };
  const deterministicDecision = null;
  const promptBundle = buildRagRulingPromptBundle({
    userQuery: query,
    cardResolution: effectiveCardResolution,
    evidence,
    env,
  });
  const evidenceFingerprint = sha256Json(evidence);
  const finalPromptSha256 = sha256Text(promptBundle.prompt);
  const displayCards = dedupeCards([
    ...(effectiveCardResolution.resolvedCards || []),
    ...userProvidedCards(evidence.userProvidedCardTexts || []),
  ]);
  const finalModelStartedAt = Date.now();
  const finalModelEnv = env;
  const finalThinkingMode = thinkingMode;
  const modelResult = await runValidatedPublicRagFinal({
        originalPrompt: promptBundle.prompt,
        userQuery: query,
        evidence,
        // Only the strict singleton/complete-scene selector in the prompt
        // builder may cross this authority boundary. Near or ambiguous QA
        // candidates remain ordinary evidence and never reach this option.
        authoritativeOfficialDirect: promptBundle.authoritativeOfficialDirectId || false,
        resolvedCards: effectiveCardResolution.resolvedCards || [],
        invoke: ({ prompt, attemptKind }) => callRagModel({
          prompt,
          recoveryPrompt: attemptKind === "primary" ? promptBundle.recoveryPrompt : "",
          evidence,
          cardResolution: effectiveCardResolution,
          env: finalModelEnv,
          modelInvoker,
          dryRun,
          fetchImpl,
          now,
          thinkingMode: finalThinkingMode,
          reasoningEffort,
          signal,
        }),
      });
  timingsMs.finalModel = elapsedMs(finalModelStartedAt);
  const publicProviderFailure = sanitizePublicProviderFailure(modelResult.providerFailure);
  const publicGenerationAttempts = sanitizePublicGenerationAttempts(modelResult.generationAttempts);
  const modelAnswer = normalizeRagAnswer(modelResult.answer, {
    evidence,
    cardResolution: effectiveCardResolution,
    modelWarnings: modelResult.warnings || [],
    providerFailure: publicProviderFailure,
  });
  const normalized = modelAnswer;
  const engineStartedAt = Date.now();
  const engine = await enginePromise;
  timingsMs.engineAwait = elapsedMs(engineStartedAt);
  timingsMs.total = elapsedMs(pipelineStartedAt);
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
    formalQueryResults: normalized.formalQueryResults || evidence.formalEngineProofs.map((item) => ({
      queryId: item.queryId,
      predicate: item.predicate,
      claimText: item.claimText,
      verdict: item.verdict,
      trusted: item.trusted === true,
      unknownReasons: item.unknownReasons || [],
      versions: item.versions || {},
      proof: item.proof || null,
    })),
    engine: {
      requested: engine.requested,
      status: engine.status,
      scenarioSource: enginePlan.source,
      bestEffort: enginePlan.bestEffort,
      planningWarnings: enginePlan.warnings,
      planSummary: enginePlan.planSummary,
      ...(engine.error ? { error: engine.error } : {}),
    },
    engineSimulation: engine.simulation || null,
    formalEngine: summarizeFormalShadow(formalShadow),
    legacyLua: summarizeLegacyLuaForPublic(evidence.legacyLuaSemanticPacket, {
      requested: typeof legacyLuaSemanticPacketFactory === "function",
    }),
    debug: {
      mode: "rag_baseline",
      engineStatus: engine.status,
      engineTraceSha256: engine.simulation?.traceSha256 || null,
      retrievalCounts: {
        cardTexts: evidence.cardTexts.length,
        userProvidedCardTexts: evidence.userProvidedCardTexts.length,
        officialQaDirectCandidates: evidence.officialQaDirectCandidates.length,
        officialQaRelated: evidence.officialQaRelated.length,
        provisionalOfficialResponses: evidence.provisionalOfficialResponses?.length || 0,
        faqRelated: evidence.faqRelated.length,
        rawRelatedEvidence: evidence.rawRelatedEvidence.length,
        rulebookCandidates: evidence.rulebookCandidates?.length || 0,
        operationLegalityChecks: evidence.operationLegality?.checks?.length || 0,
        unresolvedOperationConstraints: evidence.operationLegality?.unresolvedConstraintEvidence?.length || 0,
        legacyLuaEffectCandidates: evidence.legacyLuaSemanticPacket?.effectCandidates?.length || 0,
        legacyLuaUnknownReasons: evidence.legacyLuaSemanticPacket?.unknownReasons?.length || 0,
      },
      unresolvedMentions: effectiveCardResolution.unresolvedMentions,
      ambiguousMentions: [...(effectiveCardResolution.ambiguousMentions || []), ...(evidence.baigeAmbiguousMentions || [])],
      modelCardNameCandidates: effectiveCardResolution.modelCardNameCandidates || [],
      cardNameModelUsed: cardNameModel.modelUsed,
      cardNameProviderUsed: cardNameModel.providerUsed,
      cardNameModelDryRun: cardNameModel.dryRun,
      cardNameModelTokenUsage: cardNameModel.tokenUsage || {},
      cardNameModelCostCny: cardNameModel.estimatedCostCny || 0,
      cardNameWarnings: cardNameModel.warnings || [],
      modelRuleSearchQueries: ruleQueryModel.queries || [],
      ruleQueryModelUsed: ruleQueryModel.modelUsed,
      ruleQueryProviderUsed: ruleQueryModel.providerUsed,
      ruleQueryModelDryRun: ruleQueryModel.dryRun,
      ruleQueryModelTokenUsage: ruleQueryModel.tokenUsage || {},
      ruleQueryModelCostCny: ruleQueryModel.estimatedCostCny || 0,
      ruleQueryWarnings: ruleQueryModel.warnings || [],
      rulebookGroundingModelUsed: rulebookGrounding.modelUsed,
      rulebookGroundingProviderUsed: rulebookGrounding.providerUsed,
      rulebookGroundingDryRun: rulebookGrounding.dryRun,
      rulebookGroundingWarnings: rulebookGrounding.warnings || [],
      rulebookGroundingTokenUsage: rulebookGrounding.tokenUsage || {},
      rulebookGroundingCostCny: rulebookGrounding.estimatedCostCny || 0,
      officialQaApplicabilityStatus: officialQaApplicability.status,
      officialQaApplicabilityModelUsed: officialQaApplicability.modelUsed,
      officialQaApplicabilityProviderUsed: officialQaApplicability.providerUsed,
      officialQaApplicabilityRequestedModel: officialQaApplicability.requestedModel || null,
      officialQaApplicabilityReturnedModel: officialQaApplicability.returnedModel || null,
      officialQaApplicabilityWarnings: officialQaApplicability.warnings || [],
      officialQaApplicabilityTokenUsage: officialQaApplicability.tokenUsage || {},
      officialQaApplicabilityCostCny: officialQaApplicability.estimatedCostCny || 0,
      officialQaApplicabilityCostUsd: officialQaApplicability.estimatedCostUsd || 0,
      officialQaApplicabilityBudgetStatus: officialQaApplicability.budgetStatus || null,
      officialQaApplicabilityRejectedCount:
        evidence.rejectedOfficialQaRelated?.length || 0,
      extractionCacheHits: {
        cardNameModel: cardNameModel.cacheHit === true,
        ruleQueryModel: ruleQueryModel.cacheHit === true,
        rulebookGroundingModel: rulebookGrounding.cacheHit === true,
        officialQaApplicabilityModel: officialQaApplicability.cacheHit === true,
      },
      extractionSingleflightHits: {
        cardNameModel: cardNameModel.singleflightHit === true,
        ruleQueryModel: ruleQueryModel.singleflightHit === true,
        rulebookGroundingModel: rulebookGrounding.singleflightHit === true,
        officialQaApplicabilityModel: officialQaApplicability.singleflightHit === true,
      },
      auxiliaryCacheHit: cardNameModel.cacheHit === true
        || ruleQueryModel.cacheHit === true
        || rulebookGrounding.cacheHit === true
        || officialQaApplicability.cacheHit === true,
      auxiliaryTokenUsage: sumUsageTelemetry([
        cardNameModel.tokenUsage,
        ruleQueryModel.tokenUsage,
        rulebookGrounding.tokenUsage,
        officialQaApplicability.tokenUsage,
      ]),
      auxiliaryEstimatedCostCny:
        (cardNameModel.estimatedCostCny || 0)
        + (ruleQueryModel.estimatedCostCny || 0)
        + (rulebookGrounding.estimatedCostCny || 0)
        + (officialQaApplicability.estimatedCostCny || 0),
      auxiliaryEstimatedCostUsd: officialQaApplicability.estimatedCostUsd || 0,
      retrievalWarnings: [...new Set([...(evidence.retrievalWarnings || []), ...(promptBundle.warnings || [])])],
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
      estimatedCostCny:
        (cardNameModel.estimatedCostCny || 0)
        + (ruleQueryModel.estimatedCostCny || 0)
        + (rulebookGrounding.estimatedCostCny || 0)
        + (officialQaApplicability.estimatedCostCny || 0)
        + (modelResult.estimatedCostCny || 0),
      estimatedCostUsd:
        (officialQaApplicability.estimatedCostUsd || 0)
        + (modelResult.estimatedCostUsd || 0),
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
      semanticStateTransition,
      semanticStateTransitionDiagnostic: semanticStateTransition
        ? null
        : summarizeSemanticStateDiagnostic(localSemanticStateTransition, semanticAuthorityAssessment),
      deterministicDecision: deterministicDecision?.kind || null,
      timingsMs,
    },
  };
}

function buildLocalRulebookGrounding({
  userQuery: _userQuery = "",
  cardTexts: _cardTexts = [],
  evidence: _evidence = {},
  env: _env = {},
} = {}) {
  return {
    operationLegality: null,
    rawText: "",
    providerUsed: "none",
    modelUsed: "none",
    dryRun: true,
    warnings: ["rulebook_grounding_skipped_for_authoritative_official_direct"],
    tokenUsage: {},
    estimatedCostCny: 0,
    budgetStatus: null,
  };
}

function summarizeSemanticStateDiagnostic(transition, authorityAssessment = null) {
  if (!transition || typeof transition !== "object") return null;
  return {
    status: transition.status || null,
    complete: transition.complete === true,
    authoritative: transition.authoritative === true,
    reason: transition.reason || transition.authorityReason || null,
    authorityReasons: cleanStringArray(transition.authorityReasons || []),
    authorityGateReasons: cleanStringArray(authorityAssessment?.reasons || []),
    queryCoverage: authorityAssessment?.queryCoverage || transition.queryCoverage || null,
    identityBinding: authorityAssessment?.identityBinding || null,
  };
}

export async function buildLegacyLuaSemanticPacket({
  factory,
  userQuery,
  cardResolution,
  evidence,
  env,
  fetchImpl,
  signal,
} = {}) {
  if (typeof factory !== "function") {
    return createLegacyLuaUnknownPacket({
      code: "LEGACY_LUA_PACKET_NOT_CONFIGURED",
      message: "legacy Lua semantic packet factory is not configured",
    });
  }
  const timeoutMs = Math.max(
    50,
    Math.min(10000, readNumber(env?.RAG_LEGACY_LUA_TIMEOUT_MS, 5000)),
  );
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `legacy Lua semantic packet timed out after ${timeoutMs}ms`,
        );
        error.code = "LEGACY_LUA_PACKET_TIMEOUT";
        reject(error);
      }, timeoutMs);
    });
    const packet = await Promise.race([
      Promise.resolve(factory({
        userQuery,
        cardResolution,
        evidence,
        env,
        fetchImpl,
        signal,
      })),
      timeout,
    ]);
    return validateLegacyLuaSemanticPacket(packet);
  } catch (error) {
    return createLegacyLuaUnknownPacket({
      code: error?.code || "LEGACY_LUA_PACKET_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function summarizeLegacyLuaForPublic(packet, { requested = false } = {}) {
  const resources = Array.isArray(packet?.resources) ? packet.resources : [];
  const candidates = (Array.isArray(packet?.effectCandidates)
    ? packet.effectCandidates
    : []).filter((candidate) => (
      candidate?.kind === "CANDIDATE"
      && typeof candidate?.semanticEffectIdentity === "string"
    ));
  const legalityChecks = candidates.flatMap((candidate) => (
    Array.isArray(candidate?.semanticArtifact?.plan?.activationLegalityChecks)
      ? candidate.semanticArtifact.plan.activationLegalityChecks
      : Array.isArray(candidate?.activationLegalityChecks)
        ? candidate.activationLegalityChecks
        : []
  ));
  const unknownReasonCodes = [...new Set([
    ...(Array.isArray(packet?.unknownReasons) ? packet.unknownReasons : []),
    ...resources.flatMap((resource) => (
      Array.isArray(resource?.unknownReasons) ? resource.unknownReasons : []
    )),
  ].map((reason) => String(reason?.code || reason || "").trim()).filter(Boolean))]
    .sort()
    .slice(0, 12);
  return {
    requested,
    status: candidates.length > 0 ? "analyzed" : requested ? "unavailable" : "disabled",
    authority: String(packet?.authority || "LEGACY_COMPATIBILITY"),
    resourceCount: resources.length,
    effectCandidateCount: candidates.length,
    activationLegalityCheckCount: legalityChecks.length,
    predicateApis: [...new Set(legalityChecks
      .map((check) => String(check?.predicateApi || "").trim())
      .filter(Boolean))].sort().slice(0, 12),
    atomicOperations: [...new Set(candidates.flatMap((candidate) => (
      Array.isArray(candidate?.semanticArtifact?.plan?.atomicOperations)
        ? candidate.semanticArtifact.plan.atomicOperations
        : Array.isArray(candidate?.atomicOperations)
          ? candidate.atomicOperations
          : []
    )).map(String))].sort().slice(0, 12),
    unknownReasonCodes,
    canConfirmOfficialRuling: false,
  };
}

function reconcileCardResolution(cardResolution = {}, evidence = {}) {
  const resolvedCards = dedupeCards([
    ...(evidence.retrievedCards || []),
    ...(cardResolution.resolvedCards || []),
  ]);
  const remainingUnresolved = Array.isArray(evidence.remainingUnresolvedMentions)
    ? evidence.remainingUnresolvedMentions
    : (cardResolution.unresolvedMentions || []).filter((mention) => !cardMatchesMention(mention, resolvedCards));
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
    const identityText = [card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])].filter(Boolean).join(" ");
    if (hasNumberedCardIdentityConflict(mention?.input, identityText)) return false;
    const inputKey = normalizeCardKey(card.input || card.matchedQuery);
    if (inputKey && inputKey === mentionKey) return true;
    const names = [card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])]
      .map(normalizeCardKey)
      .filter(Boolean);
    return names.some((name) => name === mentionKey || (mentionKey.length >= 3 && (name.includes(mentionKey) || mentionKey.includes(name))));
  });
}

function attachRulebookGrounding(evidence, groundingResult = {}) {
  const operationLegality = groundingResult.operationLegality;
  if (!operationLegality) return evidence;
  const rawRelatedEvidence = dedupeEvidenceRefs([
    ...(operationLegality.priorityConstraintEvidence || []),
    ...(operationLegality.evidence || []),
    ...(operationLegality.matchedRuleEvidence || []),
    ...(evidence.rawRelatedEvidence || []),
  ]);
  return {
    ...evidence,
    rawRelatedEvidence,
    operationLegality,
    retrievalWarnings: [...new Set([
      ...(evidence.retrievalWarnings || []),
      ...(groundingResult.warnings || []),
      ...(operationLegality.hasGroundedChecks ? [`rulebook_grounded_operation_checks:${operationLegality.checks.length}`] : []),
      ...(operationLegality.hasBlockingCheck ? ["operation_legality_blocker_applied"] : []),
    ])],
  };
}

export function applyOfficialQaApplicabilityReview(evidence = {}, review = {}) {
  // A partial batch is not a trustworthy filter: even individually valid
  // entries may have been produced beside omitted, duplicate, or malformed
  // assessments. Only a complete one-to-one batch may remove evidence.
  if (review.status !== "completed" || review.complete !== true) {
    return {
      ...evidence,
      officialQaApplicabilityReview: review,
      rejectedOfficialQaRelated: [],
    };
  }
  const assessmentById = new Map((review.assessments || []).map(
    (item) => [String(item.id || ""), item],
  ));
  const applicable = [];
  const unknown = [];
  const rejected = [];
  for (const item of evidence.officialQaRelated || []) {
    const assessment = assessmentById.get(String(item.id)) || {
      id: String(item.id),
      verdict: "UNKNOWN",
      sharedConditions: [],
      missingConditions: ["model_assessment_missing"],
      conflictingConditions: [],
      reason: "",
    };
    const reviewed = {
      ...item,
      // This metadata never alters direct-authority fields. It is only a
      // related-evidence selection result for the final model's prompt.
      applicabilityReview: assessment,
      isDirect: false,
      authoritativeSceneMatch: false,
      authoritativeSceneMatchReason: "",
    };
    if (assessment.verdict === "INAPPLICABLE") rejected.push(reviewed);
    else if (assessment.verdict === "APPLICABLE") applicable.push(reviewed);
    else unknown.push(reviewed);
  }
  return {
    ...evidence,
    officialQaRelated: [...applicable, ...unknown],
    rejectedOfficialQaRelated: rejected,
    officialQaApplicabilityReview: review,
  };
}

export function normalizeRagAnswer(answer = {}, {
  evidence = {},
  cardResolution = {},
  modelWarnings = [],
  providerFailure = null,
} = {}) {
  const availableEvidence = evidenceBucketsToList(evidence);
  const userTextEvidence = evidence.userProvidedCardTexts || [];
  const availableCards = [
    ...(cardResolution.resolvedCards || []),
    ...(evidence.fuzzyResolvedCards || []),
    ...(evidence.baigeResolvedCards || []),
    ...userProvidedCards(userTextEvidence),
  ];
  const evidenceById = new Map(availableEvidence.map((item) => [String(item.id), item]));
  const directIds = new Set((evidence.officialQaDirectCandidates || []).map((item) => String(item.id)));
  const hasCardTextGrounding = Boolean((evidence.cardTexts || []).length || userTextEvidence.length);
  const hasAnyEvidence = availableEvidence.length > 0;
  const publicModelWarningFlags = (modelWarnings || []).flatMap(publicRiskFlagsForModelWarning);
  const riskFlags = new Set([
    ...(answer.riskFlags || []),
    ...publicModelWarningFlags,
    ...publicRiskFlagsForProviderFailure(providerFailure),
  ]);
  if (userTextEvidence.length) riskFlags.add("user_provided_text_not_official");
  let answerLevel = RAG_ANSWER_LEVELS.includes(answer.answerLevel) ? answer.answerLevel : "low_confidence_analysis";

  const usedEvidence = (answer.usedEvidence || [])
    .map((item) => {
      const source = evidenceById.get(String(item.id));
      if (!source) {
        riskFlags.add(`dropped_unknown_evidence:${item.id}`);
        return null;
      }
      return {
        id: source.id,
        type: outputEvidenceType(source, directIds),
        title: item.title || source.title,
        sourceUrl: source.sourceUrl || "",
      };
    })
    .filter(Boolean);

  for (const grounded of evidence.operationLegality?.matchedRuleEvidence || []) {
    if (!grounded?.id || usedEvidence.some((item) => String(item.id) === String(grounded.id))) continue;
    usedEvidence.push({
      id: grounded.id,
      type: outputEvidenceType(grounded, directIds),
      title: grounded.title || grounded.id,
      sourceUrl: grounded.sourceUrl || "",
    });
  }

  if (!usedEvidence.length && hasAnyEvidence) {
    const fallbackEvidence = selectFallbackEvidence(evidence, availableEvidence);
    usedEvidence.push({
      id: fallbackEvidence.id,
      type: outputEvidenceType(fallbackEvidence, directIds),
      title: fallbackEvidence.title,
      sourceUrl: fallbackEvidence.sourceUrl || "",
    });
    riskFlags.add("model_omitted_used_evidence");
  }
  if (answerLevel === "official_confirmed" && !usedEvidence.some((item) => directIds.has(String(item.id)))) {
    answerLevel = hasCardTextGrounding ? "rule_analysis" : "low_confidence_analysis";
    riskFlags.add("official_confirmed_requires_direct_evidence");
  }
  // Evidence availability cannot silently strengthen the model's own
  // uncertainty assessment.  Card text or a related record may be useful
  // context, but it is not itself a proof that the missing semantic step has
  // been covered.  Keep NEEDS_MORE_INFO and LOW_CONFIDENCE exactly as issued;
  // only an exact official binding or a verified formal claim may raise the
  // authority of the answer elsewhere in the pipeline.
  if (!hasAnyEvidence && answerLevel !== "budget_limited") {
    answerLevel = "needs_more_info";
    riskFlags.add("no_retrieved_evidence");
  }
  if (!availableCards.length) riskFlags.add("card_name_not_resolved");
  const shortAnswer = readableShortAnswer(answer.shortAnswer, answerLevel);

  return {
    answerLevel,
    shortAnswer,
    reasoning: cleanStringArray(answer.reasoning).length ? cleanStringArray(answer.reasoning) : ["基于当前检索资料生成 RAG baseline 分析。"],
    usedEvidence,
    missingInfo: cleanStringArray(answer.missingInfo),
    riskFlags: [...riskFlags].filter(Boolean),
    confidenceSelfEstimate: ["low", "medium", "high"].includes(answer.confidenceSelfEstimate) ? answer.confidenceSelfEstimate : "low",
  };
}

function readableShortAnswer(shortAnswer, answerLevel) {
  const text = String(shortAnswer || "").trim();
  if (text && !/^当前资料不足，无法给出可靠裁定分析。?$/u.test(text)) return text;
  if (answerLevel === "low_confidence_analysis") return "未命中官方直接 Q&A；下面只能基于已检索到的卡片文本和相关资料给出低置信分析。";
  if (answerLevel === "rule_analysis") return "未命中官方直接 Q&A；下面基于卡片文本、FAQ 和相关资料给出未确认分析。";
  return text || "当前资料不足，无法给出可靠裁定分析。";
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
    debug: {
      retrievalCounts: {},
      providerUsed: "none",
      modelUsed: "none",
      dryRun: true,
      tokenUsage: {},
      estimatedCostCny: 0,
      budgetStatus: null,
    },
  };
}

function outputEvidenceType(source, directIds) {
  if (directIds.has(String(source.id))) return "official_qa";
  if (source.type === "card_text") return "card_text";
  if (source.type === "baige_card_text") return "baige_card_text";
  if (source.type === "user_provided_text") return "user_provided_text";
  if (source.type === "rulebook") return "rulebook";
  if (source.type === "official_response_screenshot") return "official_response_screenshot";
  if (source.type === "operation_check") return "operation_check";
  if (source.type === "formal_engine_proof") return "formal_engine_proof";
  if (source.type === "faq") return "faq";
  return "related";
}

function selectFallbackEvidence(evidence, availableEvidence) {
  return evidence.officialQaDirectCandidates?.[0]
    || evidence.formalEngineProofs?.find((item) => item.trusted)
    || evidence.operationLegality?.matchedRuleEvidence?.[0]
    || evidence.faqRelated?.[0]
    || evidence.officialQaRelated?.[0]
    || evidence.rawRelatedEvidence?.[0]
    || evidence.cardTexts?.[0]
    || evidence.userProvidedCardTexts?.[0]
    || availableEvidence[0];
}

function attachFormalShadowRisk(answer, formalShadow, { preserveAuthoritativeAnswer = false } = {}) {
  if (!formalShadow?.enabled || formalShadow.status !== "unknown") return answer;
  const errorCode = formalShadow.error?.code || formalShadow.analysis?.error?.code
    || formalShadow.analysis?.formalResult?.queryResults?.[0]?.unknownReasons?.[0]?.code
    || "FORMAL_UNKNOWN";
  const riskAttached = {
    ...answer,
    riskFlags: [...new Set([...(answer?.riskFlags || []), `formal_engine_unknown:${errorCode}`])],
  };
  const diagnostic = preserveAuthoritativeAnswer
    ? `形式规则内核本次未签发确定性证明（${errorCode}）；该诊断不覆盖已经命中的官方直接依据。`
    : `形式规则内核本次未签发确定性证明（${errorCode}）；这不等于“不能”，当前答案仅依据其他资料。`;
  const existingReasoning = cleanStringArray(answer?.reasoning || []);
  const reasoning = existingReasoning.some((item) => /形式规则内核.*未签发确定性证明/u.test(item))
    ? existingReasoning
    : cleanStringArray([...existingReasoning, diagnostic]);
  return {
    ...riskAttached,
    reasoning,
  };
}

function summarizeFormalShadow(formalShadow) {
  if (!formalShadow) return { mode: "off", enabled: false, status: "disabled" };
  const result = formalShadow.analysis?.formalResult;
  const capabilities = formalShadow.analysis?.capabilities;
  return {
    mode: formalShadow.mode,
    enabled: formalShadow.enabled === true,
    stage: formalShadow.stage,
    requested: formalShadow.requested === true,
    status: formalShadow.status,
    planningStatus: formalShadow.plan?.kind || null,
    scenarioId: formalShadow.plan?.scenario?.scenarioId || result?.scenarioId || null,
    queryResults: (result?.queryResults || []).map((item) => ({
      queryId: item.queryId,
      verdict: item.verdict,
      unknownReasons: (item.unknownReasons || []).map((reason) => ({
        code: String(reason?.code || reason || "FORMAL_UNKNOWN"),
      })),
      certificateVerified: item.certificateVerification?.valid === true,
    })),
    versions: result ? {
      engineVersion: result.engineVersion,
      IRVersion: result.IRVersion,
      rulesetVersion: result.rulesetVersion,
      schemaVersion: result.schemaVersion,
      proofVerifierVersion: result.proofVerifierVersion,
    } : capabilities?.versions || null,
    draftVerification: formalShadow.draftVerification ? {
      valid: formalShadow.draftVerification.valid === true,
      code: formalShadow.draftVerification.code || null,
      verifierId: formalShadow.draftVerification.verifierId || null,
      verifierVersion: formalShadow.draftVerification.verifierVersion || null,
      expectedVerifierId: formalShadow.draftVerification.expectedVerifierId || null,
      expectedVerifierVersion: formalShadow.draftVerification.expectedVerifierVersion || null,
    } : null,
    error: publicFormalError(formalShadow.error || formalShadow.analysis?.error, formalShadow.stage),
  };
}

function publicFormalError(error, fallbackStage) {
  if (!error || typeof error !== "object") return null;
  return {
    code: String(error.code || "FORMAL_UNKNOWN"),
    stage: String(error.stage || fallbackStage || "unknown"),
  };
}

function cleanStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function attachUserQueryToCardTexts(cardTexts = [], userQuery = "") {
  return (cardTexts || []).map((item) => ({
    ...item,
    _userQuery: String(userQuery || ""),
  }));
}

export function buildCardSemanticFacts(cards = []) {
  const factsByKey = new Map();
  for (const card of cards || []) {
    const effectText = String(card?.effectText || card?.text || "").trim();
    if (!effectText) continue;
    let normalized;
    try {
      normalized = normalizeCardText({
        id: card.id || card.cardId || card.name,
        name: card.name || card.cnName || card.jaName || card.enName || "",
        cardType: card.cardType || card.type || "",
        effectText,
      });
    } catch {
      continue;
    }
    for (const [effectIndex, effect] of (normalized.effects || []).entries()) {
      for (const [stepIndex, step] of (effect.resolution || []).entries()) {
        const operation = step?.operation;
        if (!operation || operation.type === "unknown") continue;
        const fact = {
          cardId: String(card.cardId || card.id || ""),
          cardName: String(card.name || card.cnName || card.title || ""),
          effectIndex,
          stepIndex,
          connector: step.connector || "INDEPENDENT",
          operation,
          sourceText: String(operation.text || effect.rawText || effectText).slice(0, 1200),
          sourceEvidenceIds: uniqueStrings(card.sourceEvidenceIds || []),
          authority: "normalizer_candidate_only",
        };
        const key = JSON.stringify([
          normalizeCardKey(fact.cardName) || fact.cardId,
          normalizeCardKey(fact.sourceText),
          fact.operation,
        ]);
        const existing = factsByKey.get(key);
        if (existing) {
          existing.sourceEvidenceIds = uniqueStrings([
            ...existing.sourceEvidenceIds,
            ...fact.sourceEvidenceIds,
          ]);
        } else {
          factsByKey.set(key, fact);
        }
      }
    }
  }
  return [...factsByKey.values()].slice(0, 24);
}

function semanticCardsFromEvidence(items = []) {
  return (items || []).map((item) => {
    const evidenceId = String(item?.id || "").trim();
    const directCardId = String(item?.cardId || item?.cardIds?.[0] || "").trim();
    const cardId = directCardId || evidenceId.match(/^card-text-(.+)$/u)?.[1] || "";
    return {
      id: cardId,
      cardId,
      name: item?.name || item?.cards?.[0] || item?.title || "",
      cardType: item?.cardType || item?.type || "",
      effectText: item?.text || item?.effectText || "",
      sourceEvidenceIds: evidenceId ? [evidenceId] : [],
    };
  }).filter((card) => String(card.effectText || "").trim());
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
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

function dedupeEvidenceRefs(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = String(item.id || "").trim();
    if (!key || map.has(key)) continue;
    map.set(key, item);
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

export function buildPlayerRoleBindings({ userQuery = "", cardTexts = [] } = {}) {
  let scenario;
  try {
    scenario = compileRuleScenario({ userQuery, cardTexts });
  } catch {
    return {
      schema: "player-role-bindings/v1",
      status: "unavailable",
      authority: "parser_candidate_only",
      handVisibility: [],
      activationProcedures: [],
      comparisons: [],
    };
  }

  const handVisibility = (scenario.handVisibilityFacts?.sources || [])
    .filter((source) => (source.affectedSides || []).length > 0)
    .map((source) => ({
      sourceEvidenceId: String(source.id || ""),
      sourceTitle: String(source.title || ""),
      effectCarrierRelation: source.relation || "unknown",
      printedAffectedRelation: source.revealedHandSide || "unknown",
      actuallyPublicHandOwners: uniqueStrings(source.affectedSides || []),
    }));
  const activationProcedures = (scenario.revealActivationOperations || []).map((operation) => ({
    operationId: String(operation.id || ""),
    sourceEvidenceId: String(operation.cardId || operation.card?.id || ""),
    sourceTitle: String(operation.cardTitle || operation.card?.title || ""),
    actor: operation.actor || "unknown",
    handOwnerRequiredByProcedure: operation.displayedHandSide || operation.actor || "unknown",
    viewer: operation.viewerSide || "unknown",
    procedure: "reveal_own_hand_at_activation",
  }));
  const publicHandOwners = new Set(handVisibility.flatMap((item) => item.actuallyPublicHandOwners));
  const comparisons = activationProcedures
    .filter((operation) => ["self", "opponent"].includes(operation.handOwnerRequiredByProcedure))
    .map((operation) => ({
      operationId: operation.operationId,
      requiredHandOwner: operation.handOwnerRequiredByProcedure,
      parsedPublicHandOwners: [...publicHandOwners],
      requiredHandIsAmongParsedPublicHands: publicHandOwners.has(operation.handOwnerRequiredByProcedure),
      scope: "only_explicitly_parsed_continuous_effects",
    }));

  return {
    schema: "player-role-bindings/v1",
    status: handVisibility.length || activationProcedures.length ? "parsed" : "not_applicable",
    authority: "parser_candidate_only",
    handVisibility,
    activationProcedures,
    comparisons,
  };
}

function publicRiskFlagsForModelWarning(value) {
  const warning = String(value || "").trim();
  if (!warning) return [];
  if (!warning.startsWith("model_call_failed:")) return [warning];
  const flags = ["model_provider_call_failed"];
  if (/(?:无权访问|没有权限|权限不足|拒绝访问|access denied|permission denied|forbidden|unauthori[sz]ed|model_provider_access_denied|\bHTTP\s*(?:401|403)\b)/iu.test(warning)) {
    flags.push("model_provider_access_denied");
  } else if (/(?:超时|timed out|timeout|ETIMEDOUT|UND_ERR_[A-Z_]*TIMEOUT|model_provider_timeout|\bHTTP\s*(?:408|504|524)\b)/iu.test(warning)) {
    flags.push("model_provider_timeout");
  }
  return flags;
}

function publicRiskFlagsForProviderFailure(value) {
  const kind = normalizePublicProviderFailureKind(value?.kind);
  if (!kind) return [];
  return [
    "model_provider_call_failed",
    ...(kind === "access_denied" ? ["model_provider_access_denied"] : []),
    ...(kind === "timeout" ? ["model_provider_timeout"] : []),
  ];
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

function demoteSemanticTransitionForFinalModel(state) {
  if (!state || typeof state !== "object") return null;
  return {
    ...state,
    // Keep the reasoner's pre-boundary result stable for diagnostics even when
    // a different analyzer supplied the winning transition.  Individual
    // reasoners may already have demoted themselves, so never overwrite a more
    // specific original value.
    originalStatus: state.originalStatus || state.status,
    originalComplete: state.originalComplete ?? state.complete,
    authoritative: false,
    authorityReason: "diagnostic_only_requires_final_model",
    authorityReasons: [...new Set([
      ...(state.authorityReasons || []),
      "diagnostic_only_requires_final_model",
    ])],
  };
}

function buildRagDataRevision(data = {}, env = {}, { cacheByIdentity = false } = {}) {
  if (cacheByIdentity && data && typeof data === "object") {
    const cached = defaultSnapshotRevisionCache.get(data);
    if (cached) return cached;
  }
  const revision = resolveRagDataRevision(data, env.RAG_DATA_REVISION);
  // loadRagData returns one immutable in-process snapshot. Reusing its digest
  // avoids serializing the full corpus for every question; injected data stays
  // uncached so in-place test/development edits still invalidate immediately.
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
