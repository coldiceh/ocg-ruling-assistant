import { requestOcgEngineSimulation } from "./ocgEngineClient.mjs";
import { autoEngineSimulationEnabled, buildBestEffortEngineScenario } from "./ocgScenarioPlanner.mjs";
import { applyFormalAnswerGate, runFormalEngineShadow } from "./formalEngineShadow.mjs";
import { createDefaultFormalScenarioDraftInvoker } from "./formalScenarioDraftModel.mjs";
import { normalizeCardText } from "./cardTextNormalizer.mjs";
import { extractRagCards, normalizeCardKey } from "./ragCardExtractor.mjs";
import { evidenceBucketsToList, loadRagData, retrieveRagEvidence } from "./ragEvidenceRetriever.mjs";
import {
  callCardNameExtractionModel,
  callRagModel,
  callRulebookGroundingModel,
  callRuleQueryExtractionModel,
} from "./ragModelClient.mjs";
import {
  buildRagRulingPromptBundle,
  RAG_ANSWER_LEVELS,
  selectAuthoritativeOfficialDirectCandidate,
} from "./ragRulingPrompt.mjs";
import { hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import { extractOfficialQaAnswer } from "./officialQaAnswerExtractor.mjs";
import { analyzeEffectStateTransition } from "./effectStateReasoner.mjs";

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
  const data = await Promise.resolve(cards || records || qaRecords
    ? { cards: cards || [], records: records || [], qaRecords: qaRecords || [] }
    : loadRagData(dataDir));
  timingsMs.dataLoad = elapsedMs(dataStartedAt);

  const preflightStartedAt = Date.now();
  const maxCards = readNumber(env.RAG_MAX_CARDS, 6);
  const localCardResolution = extractRagCards(query, {
    cards: data.cards || [],
    maxCards,
  });
  timingsMs.deterministicPreflight = elapsedMs(preflightStartedAt);

  const auxiliaryExtractionStartedAt = Date.now();
  const [cardNameModel, ruleQueryModel] = await Promise.all([
    callCardNameExtractionModel({
      userQuery: query,
      env,
      modelInvoker: cardModelInvoker,
      fetchImpl,
      dryRun,
      now,
      signal,
    }),
    callRuleQueryExtractionModel({
      userQuery: query,
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
    ruleSearchQueries: ruleQueryModel.queries || [],
    env,
    fetchImpl,
  });
  timingsMs.retrieval = elapsedMs(retrievalStartedAt);
  const effectiveCardResolution = reconcileCardResolution(cardResolution, retrievedEvidence);
  const authoritativeOfficialDirect = hasAuthoritativeOfficialDirect(retrievedEvidence, effectiveCardResolution);
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
  const reasoningCardTexts = attachUserQueryToCardTexts([
    ...(retrievedEvidence.cardTexts || []),
    ...(retrievedEvidence.userProvidedCardTexts || []),
  ], query);
  const corroboratingEvidence = dedupeEvidenceRefs([
    ...(retrievedEvidence.officialQaDirectCandidates || []),
    ...(retrievedEvidence.provisionalOfficialResponses || []),
    ...(retrievedEvidence.officialQaRelated || []),
  ]);
  const localReasoningStartedAt = Date.now();
  const localRulebookGrounding = buildLocalRulebookGrounding({
    userQuery: query,
    cardTexts: reasoningCardTexts,
    evidence: retrievedEvidence,
    env,
  });
  const locallyGroundedEvidence = attachRulebookGrounding(retrievedEvidence, localRulebookGrounding);
  const semanticStateStartedAt = Date.now();
  const localSemanticStateTransition = analyzeEffectStateTransition({
    userQuery: query,
    cardTexts: reasoningCardTexts,
    corroboratingEvidence,
    resolvedCards: effectiveCardResolution.resolvedCards || [],
  });
  timingsMs.semanticStateExecution = elapsedMs(semanticStateStartedAt);
  const trustedSemanticStateTransition = hasTrustedSemanticStateTransition({
    semanticStateTransition: localSemanticStateTransition,
    cardResolution: effectiveCardResolution,
    extraAmbiguousMentions: retrievedEvidence.baigeAmbiguousMentions,
  })
    ? localSemanticStateTransition
    : null;
  // An exact official answer remains the highest-priority contract. The local
  // executor is used as a production fast path only after the generic
  // authority boundary and complete card-identity checks both succeed.
  const localDecisionComplete = !authoritativeOfficialDirect
    && !modelInvoker
    && Boolean(trustedSemanticStateTransition);
  timingsMs.localReasoning = elapsedMs(localReasoningStartedAt);

  const rulebookStartedAt = Date.now();
  const rulebookGrounding = authoritativeOfficialDirect || localDecisionComplete
    ? localRulebookGrounding
    : await callRulebookGroundingModel({
        userQuery: query,
        cardTexts: reasoningCardTexts,
        ruleEvidence: retrievedEvidence.rulebookCandidates || [],
        qaEvidence: dedupeEvidenceRefs([
          ...(retrievedEvidence.officialQaDirectCandidates || []),
          ...(retrievedEvidence.officialQaRelated || []),
          ...(retrievedEvidence.provisionalOfficialResponses || []),
          ...(retrievedEvidence.faqRelated || []),
        ]),
        env,
        modelInvoker: rulebookModelInvoker,
        fetchImpl,
        dryRun,
        signal,
        now,
      });
  timingsMs.rulebookGrounding = elapsedMs(rulebookStartedAt);
  const groundedEvidence = attachRulebookGrounding(retrievedEvidence, rulebookGrounding);
  const semanticStateTransition = authoritativeOfficialDirect
    ? null
    : trustedSemanticStateTransition;
  const formalStartedAt = Date.now();
  const formalShadow = await formalShadowPromise;
  timingsMs.formalEngineAwait = elapsedMs(formalStartedAt);
  const evidence = {
    ...groundedEvidence,
    semanticStateTransition,
    cardSemanticFacts: buildCardSemanticFacts([
      ...(effectiveCardResolution.resolvedCards || []),
      ...semanticCardsFromEvidence(groundedEvidence.cardTexts || []),
      ...semanticCardsFromEvidence(groundedEvidence.userProvidedCardTexts || []),
    ]),
    formalEngineProofs: formalShadow.evidence || [],
    formalEngineStatus: summarizeFormalShadow(formalShadow),
  };
  const deterministicDecision = localDecisionComplete
    ? { kind: "state_transition", semanticStateTransition }
    : null;
  const promptBundle = deterministicDecision
    ? {
        prompt: "",
        recoveryPrompt: "",
        promptChars: 0,
        promptTruncated: false,
        warnings: ["final_model_skipped_trusted_semantic_state_transition"],
      }
    : buildRagRulingPromptBundle({
        userQuery: query,
        cardResolution: effectiveCardResolution,
        evidence,
        env,
      });
  const displayCards = dedupeCards([
    ...(effectiveCardResolution.resolvedCards || []),
    ...userProvidedCards(evidence.userProvidedCardTexts || []),
  ]);
  const finalModelStartedAt = Date.now();
  const modelResult = deterministicDecision
    ? buildTrustedSemanticModelResult(deterministicDecision)
    : await callRagModel({
        prompt: promptBundle.prompt,
        recoveryPrompt: promptBundle.recoveryPrompt,
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
      });
  timingsMs.finalModel = deterministicDecision ? 0 : elapsedMs(finalModelStartedAt);
  const modelAnswer = normalizeRagAnswer(modelResult.answer, { evidence, cardResolution: effectiveCardResolution, modelWarnings: modelResult.warnings || [] });
  const normalizedWithoutFormalGate = authoritativeOfficialDirect
    ? applyOfficialDirectAnswerContract(modelAnswer, evidence, effectiveCardResolution)
    : modelAnswer;
  const preserveTrustedSemanticAnswer = Boolean(deterministicDecision)
    && !hasTrustedFormalVerdict(evidence.formalEngineProofs);
  const normalized = attachFormalShadowRisk(
    applyFormalAnswerGate(normalizedWithoutFormalGate, evidence.formalEngineProofs, {
      preserveAuthoritativeAnswer: authoritativeOfficialDirect || preserveTrustedSemanticAnswer,
    }),
    formalShadow,
    { preserveAuthoritativeAnswer: authoritativeOfficialDirect || preserveTrustedSemanticAnswer },
  );
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
      },
      unresolvedMentions: effectiveCardResolution.unresolvedMentions,
      ambiguousMentions: [...(effectiveCardResolution.ambiguousMentions || []), ...(evidence.baigeAmbiguousMentions || [])],
      modelCardNameCandidates: effectiveCardResolution.modelCardNameCandidates || [],
      cardNameModelUsed: cardNameModel.modelUsed,
      cardNameProviderUsed: cardNameModel.providerUsed,
      cardNameModelDryRun: cardNameModel.dryRun,
      cardNameModelCostCny: cardNameModel.estimatedCostCny || 0,
      cardNameWarnings: cardNameModel.warnings || [],
      modelRuleSearchQueries: ruleQueryModel.queries || [],
      ruleQueryModelUsed: ruleQueryModel.modelUsed,
      ruleQueryProviderUsed: ruleQueryModel.providerUsed,
      ruleQueryModelDryRun: ruleQueryModel.dryRun,
      ruleQueryModelCostCny: ruleQueryModel.estimatedCostCny || 0,
      ruleQueryWarnings: ruleQueryModel.warnings || [],
      rulebookGroundingModelUsed: rulebookGrounding.modelUsed,
      rulebookGroundingProviderUsed: rulebookGrounding.providerUsed,
      rulebookGroundingDryRun: rulebookGrounding.dryRun,
      rulebookGroundingWarnings: rulebookGrounding.warnings || [],
      rulebookGroundingTokenUsage: rulebookGrounding.tokenUsage || {},
      rulebookGroundingCostCny: rulebookGrounding.estimatedCostCny || 0,
      retrievalWarnings: [...new Set([...(evidence.retrievalWarnings || []), ...(promptBundle.warnings || [])])],
      baigeSearchCount: evidence.debug?.baigeSearchCount || 0,
      baigeCacheHitCount: evidence.debug?.baigeCacheHitCount || 0,
      baigeWarnings: evidence.debug?.baigeWarnings || [],
      retrievalStageTimingsMs: evidence.debug?.timingsMs || {},
      providerUsed: modelResult.providerUsed || modelResult.provider,
      modelUsed: modelResult.modelUsed,
      modelName: modelResult.modelName,
      dryRun: modelResult.dryRun,
      tokenUsage: modelResult.tokenUsage || {},
      estimatedCostCny:
        (cardNameModel.estimatedCostCny || 0)
        + (ruleQueryModel.estimatedCostCny || 0)
        + (rulebookGrounding.estimatedCostCny || 0)
        + (modelResult.estimatedCostCny || 0),
      budgetStatus: modelResult.budgetStatus || null,
      generationConfig: modelResult.generationConfig || null,
      generationAttempts: modelResult.generationAttempts || [],
      promptChars: promptBundle.promptChars,
      promptTruncated: promptBundle.promptTruncated,
      semanticStateTransition,
      semanticStateTransitionDiagnostic: semanticStateTransition
        ? null
        : summarizeSemanticStateDiagnostic(localSemanticStateTransition),
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

function hasAuthoritativeOfficialDirect(evidence = {}, cardResolution = {}) {
  return Boolean(selectAuthoritativeOfficialDirectCandidate({
    candidates: evidence.officialQaDirectCandidates || [],
    cardResolution,
    baigeAmbiguousMentions: evidence.baigeAmbiguousMentions,
  }));
}

function applyOfficialDirectAnswerContract(answer, evidence = {}, cardResolution = {}) {
  const direct = evidence.officialQaDirectCandidates?.[0];
  if (!direct) return answer;
  const extracted = extractOfficialQaAnswer({
    ...direct,
    text: direct.fullText || direct.text,
  });
  const officialAnswerText = replaceOfficialCardPlaceholders(
    String(extracted.answerText || direct.answer || direct.officialText || "").trim(),
    cardResolution.resolvedCards || [],
  );
  const alreadyUsedDirect = (answer.usedEvidence || []).some((item) => String(item.id) === String(direct.id));
  const modelFailed = (answer.riskFlags || []).some((flag) => /(?:model_call_failed|model_json_parse_failed|deepseek_empty_content|model_output_not_json)/u.test(String(flag)));
  const modelCannotSafelySummarize = modelFailed
    || answer.answerLevel === "budget_limited"
    || answer.answerLevel === "needs_more_info"
    || !alreadyUsedDirect
    || primaryPolarityConflict(officialAnswerText, answer.shortAnswer)
    || officialConstraintLost(officialAnswerText, `${answer.shortAnswer || ""}\n${(answer.reasoning || []).join("\n")}`);
  const translatedSummary = modelCannotSafelySummarize ? "" : String(answer.shortAnswer || "").trim();
  const officialSourceLine = officialAnswerText ? `官方 Q&A 完整回答原文：${officialAnswerText}` : "";
  const shortAnswer = [translatedSummary, officialSourceLine].filter(Boolean).join("\n") || answer.shortAnswer;
  const officialAnswerReason = officialAnswerText
    ? `官方 Q&A 完整回答原文：${officialAnswerText}`
    : "";
  return {
    ...answer,
    answerLevel: "official_confirmed",
    shortAnswer,
    reasoning: cleanStringArray([
      officialAnswerReason,
      ...(answer.reasoning || []),
    ]),
    usedEvidence: dedupeEvidenceRefs([
      {
        id: direct.id,
        type: "official_qa",
        title: direct.title || direct.id,
        sourceUrl: direct.sourceUrl || "",
      },
      ...(answer.usedEvidence || []),
    ]),
    riskFlags: [...new Set([
      ...(answer.riskFlags || []),
      ...(!alreadyUsedDirect ? ["official_direct_evidence_enforced"] : []),
      ...(modelFailed ? ["official_direct_source_fallback_after_model_failure"] : []),
      ...(modelCannotSafelySummarize && !modelFailed ? ["official_direct_source_fallback_after_incomplete_summary"] : []),
    ])],
    confidenceSelfEstimate: "high",
  };
}

function replaceOfficialCardPlaceholders(text, cards = []) {
  const namesById = new Map();
  for (const card of cards || []) {
    const id = String(card.id || card.cardId || "").trim();
    const name = String(card.name || card.cnName || card.jaName || card.enName || "").trim();
    if (id && name && !namesById.has(id)) namesById.set(id, name);
  }
  return String(text || "").replace(/<<(\d+)>>/gu, (placeholder, id) => (
    namesById.has(id) ? `「${namesById.get(id)}」` : placeholder
  ));
}

function primaryPolarityConflict(officialText, modelText) {
  const official = primaryAnswerPolarity(officialText);
  const model = primaryAnswerPolarity(modelText);
  return official !== "unknown" && model !== "unknown" && official !== model;
}

function primaryAnswerPolarity(value) {
  const text = String(value || "").trim();
  if (/^(?:no\b|いいえ|不能|不可以|无法|不可|不得|できません|発動できません)/iu.test(text)) return "negative";
  if (/^(?:yes\b|はい|可以|能够|能(?:够)?发动|できます|発動できます)/iu.test(text)) return "positive";
  return "unknown";
}

function officialConstraintLost(officialText, modelText) {
  const official = String(officialText || "");
  const model = String(modelText || "");
  const sourceHasConstraint = /(?:cannot|can't|not be able|only|unless|except|however|if\b|when\b|できません|できない|ただし|場合|のみ|以外|不能|不可|不得|仅|只|如果|之后|本回合)/iu.test(official);
  if (!sourceHasConstraint) return false;
  return !/(?:不能|不可|不得|仅|只|如果|场合|条件|之后|本回合|除外|例外|cannot|can't|not be able|only|unless|except|however|if\b|when\b|できません|できない|ただし|場合|のみ|以外)/iu.test(model);
}

function hasTrustedSemanticStateTransition({
  semanticStateTransition,
  cardResolution = {},
  extraAmbiguousMentions = [],
} = {}) {
  if (!hasCompleteCardResolution(cardResolution, extraAmbiguousMentions)) return false;
  return semanticStateTransition?.status === "resolved"
    && semanticStateTransition?.complete === true
    && semanticStateTransition?.authoritative !== false
    && !(semanticStateTransition.authorityReasons || []).length;
}

function hasCompleteCardResolution(cardResolution = {}, extraAmbiguousMentions = []) {
  return !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length
    && !(extraAmbiguousMentions || []).length;
}

function buildTrustedSemanticModelResult(decision = {}) {
  const state = decision.semanticStateTransition || {};
  return {
    answer: {
      answerLevel: "rule_analysis",
      shortAnswer: String(state.shortAnswer || "").trim(),
      reasoning: cleanStringArray(state.reasoning || []),
      usedCards: [],
      usedEvidence: (state.evidenceIds || []).map((id) => ({
        id,
        type: "related",
        title: String(id),
      })),
      missingInfo: [],
      riskFlags: [
        "trusted_local_semantic_execution",
        "semantic_state_transition_applied",
        "final_model_skipped",
      ],
      confidenceSelfEstimate: "medium",
    },
    rawText: "",
    provider: "local",
    providerUsed: "local",
    modelName: "trusted-semantic-state-executor",
    modelUsed: "trusted-semantic-state-executor",
    dryRun: true,
    warnings: [],
    tokenUsage: {},
    estimatedCostCny: 0,
    budgetStatus: null,
    generationConfig: null,
    generationAttempts: [],
  };
}

function hasTrustedFormalVerdict(formalEvidence = []) {
  return (formalEvidence || []).some((item) => (
    item?.trusted === true && (item.verdict === "TRUE" || item.verdict === "FALSE")
  ));
}

function summarizeSemanticStateDiagnostic(transition) {
  if (!transition || typeof transition !== "object") return null;
  return {
    status: transition.status || null,
    complete: transition.complete === true,
    authoritative: transition.authoritative !== false,
    reason: transition.reason || transition.authorityReason || null,
    authorityReasons: cleanStringArray(transition.authorityReasons || []),
  };
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
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

export function normalizeRagAnswer(answer = {}, { evidence = {}, cardResolution = {}, modelWarnings = [] } = {}) {
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
  const riskFlags = new Set([...(answer.riskFlags || []), ...modelWarnings]);
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
