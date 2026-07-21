// Frozen software snapshot from Git revision 58060bdc6.
import { requestOcgEngineSimulation } from "../../ocgEngineClient.mjs";
import { autoEngineSimulationEnabled, buildBestEffortEngineScenario } from "../../ocgScenarioPlanner.mjs";
import { extractRagCards, normalizeCardKey } from "./ragCardExtractor.mjs";
import { evidenceBucketsToList, loadRagData, retrieveRagEvidence } from "./ragEvidenceRetriever.mjs";
import {
  callCardNameExtractionModel,
  callRagModel,
  callRulebookGroundingModel,
  callRuleQueryExtractionModel,
} from "../../ragModelClient.mjs";
import { buildRagRulingPromptBundle, RAG_ANSWER_LEVELS } from "../../ragRulingPrompt.mjs";
import { analyzeEffectStateTransition, attachUserQueryToCardTexts } from "./effectStateReasoner.mjs";
import { hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import { analyzeDeterministicOperationLegality } from "../../operationLegalityAnalyzer.mjs";

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
} = {}) {
  const pipelineStartedAt = Date.now();
  const timingsMs = {};
  const query = String(question || userQuery || "").trim();
  if (!query) return buildEmptyQuestionAnswer();

  const extractionStartedAt = Date.now();
  const dataPromise = Promise.resolve(cards || records || qaRecords
    ? { cards: cards || [], records: records || [], qaRecords: qaRecords || [] }
    : loadRagData(dataDir));
  const cardNameModelPromise = callCardNameExtractionModel({
    userQuery: query,
    env,
    modelInvoker: cardModelInvoker,
    fetchImpl,
  });
  const ruleQueryModelPromise = callRuleQueryExtractionModel({
    userQuery: query,
    env,
    modelInvoker: ruleModelInvoker,
    fetchImpl,
  });
  const [data, cardNameModel, ruleQueryModel] = await Promise.all([
    dataPromise,
    cardNameModelPromise,
    ruleQueryModelPromise,
  ]);
  timingsMs.dataAndQueryExtraction = elapsedMs(extractionStartedAt);
  const cardResolution = extractRagCards(query, {
    cards: data.cards || [],
    maxCards: readNumber(env.RAG_MAX_CARDS, 6),
    modelCardNameCandidates: cardNameModel.candidates || [],
  });
  const retrievalStartedAt = Date.now();
  const retrievedEvidence = await retrieveRagEvidence({
    userQuery: query,
    cardResolution,
    dataDir,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    ruleSearchQueries: ruleQueryModel.queries || [],
    env,
    fetchImpl,
  });
  timingsMs.retrieval = elapsedMs(retrievalStartedAt);
  const effectiveCardResolution = reconcileCardResolution(cardResolution, retrievedEvidence);
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
  const localSemanticStateTransition = analyzeEffectStateTransition({
    userQuery: query,
    cardTexts: reasoningCardTexts,
    corroboratingEvidence,
    operationLegality: locallyGroundedEvidence.operationLegality,
    resolvedCards: effectiveCardResolution.resolvedCards,
  });
  const localDecisionComplete = !rulebookModelInvoker && hasCompleteDeterministicRuling({
    semanticStateTransition: localSemanticStateTransition,
    operationLegality: locallyGroundedEvidence.operationLegality,
  });
  timingsMs.localReasoning = elapsedMs(localReasoningStartedAt);

  const rulebookStartedAt = Date.now();
  const rulebookGrounding = localDecisionComplete
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
        now,
      });
  timingsMs.rulebookGrounding = elapsedMs(rulebookStartedAt);
  const groundedEvidence = attachRulebookGrounding(retrievedEvidence, rulebookGrounding);
  const semanticStateTransition = localDecisionComplete
    ? localSemanticStateTransition
    : analyzeEffectStateTransition({
        userQuery: query,
        cardTexts: reasoningCardTexts,
        corroboratingEvidence,
        operationLegality: groundedEvidence.operationLegality,
        resolvedCards: effectiveCardResolution.resolvedCards,
  });
  const evidence = { ...groundedEvidence, semanticStateTransition };
  const deterministicDecision = modelInvoker ? null : selectDeterministicDecision(evidence);
  const promptBundle = deterministicDecision
    ? {
        prompt: "",
        recoveryPrompt: "",
        promptChars: 0,
        promptTruncated: false,
        warnings: ["final_model_skipped_deterministic_ruling"],
      }
    : buildRagRulingPromptBundle({ userQuery: query, cardResolution: effectiveCardResolution, evidence, env });
  const displayCards = dedupeCards([
    ...(effectiveCardResolution.resolvedCards || []),
    ...userProvidedCards(evidence.userProvidedCardTexts || []),
  ]);
  const finalModelStartedAt = Date.now();
  const modelResult = deterministicDecision
    ? buildDeterministicModelResult(deterministicDecision)
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
      });
  timingsMs.finalModel = elapsedMs(finalModelStartedAt);
  const modelAnswer = normalizeRagAnswer(modelResult.answer, { evidence, cardResolution: effectiveCardResolution, modelWarnings: modelResult.warnings || [] });
  const groundedFallback = applyGroundedOperationFallback(modelAnswer, evidence);
  const evidenceConstrained = applyExactScenarioGrounding(groundedFallback, evidence, query);
  const operationConstrained = applyOperationLegalityOverride(evidenceConstrained, evidence);
  const constraintGuarded = applyUnresolvedConstraintGuard(operationConstrained, evidence);
  const normalized = applySemanticStateConstraint(constraintGuarded, evidence);
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
      cardNameWarnings: cardNameModel.warnings || [],
      modelRuleSearchQueries: ruleQueryModel.queries || [],
      ruleQueryModelUsed: ruleQueryModel.modelUsed,
      ruleQueryProviderUsed: ruleQueryModel.providerUsed,
      ruleQueryModelDryRun: ruleQueryModel.dryRun,
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
      estimatedCostCny: (modelResult.estimatedCostCny || 0) + (rulebookGrounding.estimatedCostCny || 0),
      budgetStatus: modelResult.budgetStatus || null,
      promptChars: promptBundle.promptChars,
      promptTruncated: promptBundle.promptTruncated,
      semanticStateTransition,
      deterministicDecision: deterministicDecision?.kind || null,
      timingsMs,
    },
  };
}

function buildLocalRulebookGrounding({
  userQuery = "",
  cardTexts = [],
  evidence = {},
  env = {},
} = {}) {
  const ruleEvidence = dedupeEvidenceRefs([
    ...(evidence.rulebookCandidates || []),
    ...(evidence.rawRelatedEvidence || []),
    ...(evidence.officialQaDirectCandidates || []),
    ...(evidence.officialQaRelated || []),
    ...(evidence.provisionalOfficialResponses || []),
    ...(evidence.faqRelated || []),
  ]);
  const operationLegality = analyzeDeterministicOperationLegality({
    userQuery,
    cardTexts,
    ruleEvidence,
  });
  return {
    operationLegality,
    rawText: "",
    providerUsed: "local",
    modelUsed: "deterministic-rule-reasoner",
    dryRun: true,
    warnings: [...new Set([
      "rulebook_grounding_model_skipped_local_precheck",
      ...(operationLegality.warnings || []),
    ])],
    tokenUsage: {},
    estimatedCostCny: 0,
    budgetStatus: null,
  };
}

function hasCompleteDeterministicRuling({
  semanticStateTransition,
  operationLegality,
} = {}) {
  if (operationLegality?.hasBlockingCheck && !operationLegality?.hasUnresolvedConstraints) return true;
  if (semanticStateTransition?.status === "resolved" && semanticStateTransition?.complete === true) return true;
  return operationLegality?.complete === true
    && operationLegality?.hasGroundedChecks === true
    && operationLegality?.hasUnresolvedConstraints !== true
    && Boolean(operationLegality?.shortAnswer);
}

function selectDeterministicDecision(evidence = {}) {
  const operationLegality = evidence.operationLegality;
  if (operationLegality?.hasBlockingCheck && !operationLegality?.hasUnresolvedConstraints) {
    return { kind: "operation_blocker", operationLegality };
  }
  const semanticStateTransition = evidence.semanticStateTransition;
  if (semanticStateTransition?.status === "resolved" && semanticStateTransition?.complete === true) {
    return { kind: "state_transition", semanticStateTransition };
  }
  if (operationLegality?.complete === true
      && operationLegality?.hasGroundedChecks === true
      && operationLegality?.hasUnresolvedConstraints !== true
      && operationLegality?.shortAnswer) {
    return { kind: "operation_sequence", operationLegality };
  }
  return null;
}

function buildDeterministicModelResult(decision) {
  const state = decision?.semanticStateTransition;
  const operation = decision?.operationLegality;
  const usedEvidence = state
    ? (state.evidenceIds || []).map((id) => ({ id, type: "related", title: String(id) }))
    : (operation?.matchedRuleEvidence || []).map((item) => ({
        id: item.id,
        type: item.type || item.recordType || "rulebook",
        title: item.title || item.id,
      }));
  const shortAnswer = state?.shortAnswer
    || operation?.shortAnswer
    || operation?.checks?.find((item) => item.status !== "unknown")?.conclusion
    || "已根据当前状态与适用规则完成处理。";
  return {
    answer: {
      answerLevel: "rule_analysis",
      shortAnswer,
      reasoning: state?.reasoning || operation?.reasoning || [],
      usedCards: [],
      usedEvidence,
      missingInfo: [],
      riskFlags: [
        "deterministic_ruling_applied",
        "final_model_skipped",
      ],
      confidenceSelfEstimate: "medium",
    },
    rawText: "",
    provider: "local",
    providerUsed: "local",
    modelName: "deterministic-ruling-reasoner",
    modelUsed: "deterministic-ruling-reasoner",
    dryRun: true,
    warnings: [],
    tokenUsage: {},
    estimatedCostCny: 0,
    budgetStatus: null,
  };
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function reconcileCardResolution(cardResolution = {}, evidence = {}) {
  const resolvedCards = dedupeCards([
    ...(evidence.retrievedCards || []),
    ...(evidence.baigeResolvedCards || []),
    ...(evidence.fuzzyResolvedCards || []),
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

function applyOperationLegalityOverride(answer, evidence = {}) {
  const operation = evidence.operationLegality;
  if (!operation?.hasBlockingCheck) return answer;
  const operationEvidence = (operation.evidence || [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    }));
  const matchedRuleEvidence = (operation.matchedRuleEvidence || [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    }));
  const usedEvidence = dedupeEvidenceRefs([
    ...operationEvidence,
    ...matchedRuleEvidence,
    ...(answer.usedEvidence || []),
  ]);
  const reasoning = cleanStringArray([
    ...(operation.reasoning || []),
  ]);
  const modelContradicted = isAffirmativeOperationAnswer(answer.shortAnswer);
  return {
    ...answer,
    answerLevel: "rule_analysis",
    shortAnswer: operation.shortAnswer || answer.shortAnswer,
    reasoning: reasoning.length ? reasoning : answer.reasoning,
    usedEvidence,
    missingInfo: [],
    riskFlags: [
      ...new Set([
        ...(answer.riskFlags || []),
        "operation_legality_blocker_applied",
        ...(modelContradicted ? ["model_answer_overridden_by_operation_legality"] : []),
      ]),
    ],
    confidenceSelfEstimate: answer.confidenceSelfEstimate === "high" ? "medium" : answer.confidenceSelfEstimate,
  };
}

function applyUnresolvedConstraintGuard(answer, evidence = {}) {
  const operation = evidence.operationLegality;
  if (!operation?.hasUnresolvedConstraints || operation.hasBlockingCheck) return answer;
  if (!isAffirmativeOperationAnswer(answer.shortAnswer)) return answer;

  const unresolved = operation.unresolvedConstraintEvidence || [];
  const unresolvedEvidence = unresolved.map((item) => ({
    id: item.id,
    type: outputEvidenceType(item, new Set()),
    title: item.title,
    sourceUrl: item.sourceUrl || "",
  }));
  const labels = unresolved.map((item) => item.title || item.id).filter(Boolean).slice(0, 4);
  return {
    ...answer,
    answerLevel: "low_confidence_analysis",
    shortAnswer: "当前不能确认该操作可以发动：检索到可能限制该操作的规则，但其适用性尚未完成核对。",
    reasoning: cleanStringArray([
      `尚未完成核对的限制性资料：${labels.join("、") || "相关规则资料"}。`,
      "在这些限制规则被逐项判定为适用或不适用前，不能仅凭一般发动条件给出肯定结论。",
      ...(answer.reasoning || []),
    ]),
    usedEvidence: dedupeEvidenceRefs([
      ...unresolvedEvidence,
      ...(answer.usedEvidence || []),
    ]),
    missingInfo: [...new Set([...(answer.missingInfo || []), "需要完成限制性规则与当前场景的适用性核对。"])],
    riskFlags: [...new Set([...(answer.riskFlags || []), "unresolved_restrictive_evidence_blocked_positive_answer"])],
    confidenceSelfEstimate: "low",
  };
}

function isAffirmativeOperationAnswer(value) {
  const text = String(value || "").normalize("NFKC");
  if (/(?:不能|不可|不可以|无法|不得|不应|不成立|can\s*not|cannot|can't|not allowed|must not)/iu.test(text)) return false;
  return /(?:可以|能够|能发动|可发动|可以发动|can activate|can be activated|is allowed)/iu.test(text);
}

function applyExactScenarioGrounding(answer, evidence = {}, userQuery = "") {
  const operation = evidence.operationLegality;
  const checks = operation?.checks || [];
  if (!operation?.hasGroundedChecks || !operation.shortAnswer || !checks.length) return answer;
  if (checks.some((check) => check.status === "unknown" || !(check.citations || []).length)) return answer;

  const anchors = extractScenarioAnchors(userQuery);
  if (!anchors.length) return answer;
  const requiredMatches = Math.min(2, anchors.length);
  const exactEvidence = (operation.matchedRuleEvidence || []).filter((item) => {
    const text = normalizeScenarioKey([
      item?.title,
      ...(item?.cards || []),
      item?.text,
    ].filter(Boolean).join(" "));
    return anchors.some((anchor) => text.includes(anchor));
  });
  const coveredAnchors = anchors.filter((anchor) => exactEvidence.some((item) => normalizeScenarioKey([
    item?.title,
    ...(item?.cards || []),
    item?.text,
  ].filter(Boolean).join(" ")).includes(anchor)));
  if (coveredAnchors.length < requiredMatches) return answer;

  const usedEvidence = dedupeEvidenceRefs([
    ...exactEvidence.map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    })),
    ...(operation.evidence || []).map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    })),
    ...(answer.usedEvidence || []),
  ]);
  const reasoning = cleanStringArray(operation.reasoning || []);
  return {
    ...answer,
    answerLevel: answer.answerLevel === "official_confirmed" ? answer.answerLevel : "rule_analysis",
    shortAnswer: operation.shortAnswer,
    reasoning: reasoning.length ? reasoning : answer.reasoning,
    usedEvidence,
    missingInfo: [],
    riskFlags: [...new Set([...(answer.riskFlags || []), "answer_constrained_by_exact_scenario_evidence"])],
    confidenceSelfEstimate: answer.confidenceSelfEstimate === "low" ? "low" : "medium",
  };
}

function applySemanticStateConstraint(answer, evidence = {}) {
  const state = evidence.semanticStateTransition;
  if (answer.answerLevel === "official_confirmed" || evidence.operationLegality?.hasBlockingCheck) return answer;
  if (state?.status !== "resolved" || state.complete !== true) return answer;
  const evidenceById = new Map(evidenceBucketsToList(evidence).map((item) => [String(item.id), item]));
  const stateEvidence = (state.evidenceIds || [])
    .map((id) => evidenceById.get(String(id)))
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    }));
  const provisional = state.activationEvidenceType === "official_response_screenshot";
  return {
    ...answer,
    answerLevel: "rule_analysis",
    shortAnswer: state.shortAnswer,
    reasoning: cleanStringArray(state.reasoning),
    usedEvidence: dedupeEvidenceRefs([
      ...stateEvidence,
      ...(answer.usedEvidence || []),
    ]),
    missingInfo: [],
    riskFlags: [...new Set([
      ...(answer.riskFlags || []),
      "semantic_state_transition_applied",
      ...(provisional ? ["provisional_official_response", "official_database_direct_qa_not_found"] : []),
    ])],
    confidenceSelfEstimate: "medium",
  };
}

function applyGroundedOperationFallback(answer, evidence = {}) {
  const operation = evidence.operationLegality;
  const modelFailed = (answer.riskFlags || []).some((flag) => /(?:model_call_failed|model_json_parse_failed|deepseek_empty_content|model_output_not_json)/u.test(String(flag)));
  if (!modelFailed || !operation?.hasGroundedChecks || !operation.shortAnswer) return answer;
  const usedEvidence = dedupeEvidenceRefs([
    ...(operation.evidence || []).map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    })),
    ...(operation.matchedRuleEvidence || []).map((item) => ({
      id: item.id,
      type: outputEvidenceType(item, new Set()),
      title: item.title,
      sourceUrl: item.sourceUrl || "",
    })),
    ...(answer.usedEvidence || []),
  ]);
  return {
    ...answer,
    answerLevel: "rule_analysis",
    shortAnswer: operation.shortAnswer,
    reasoning: cleanStringArray(operation.reasoning || []).length ? cleanStringArray(operation.reasoning) : answer.reasoning,
    usedEvidence,
    missingInfo: [],
    riskFlags: [...new Set([...(answer.riskFlags || []), "final_model_failed_using_grounded_operation_analysis"])],
    confidenceSelfEstimate: "medium",
  };
}

function extractScenarioAnchors(value) {
  const source = String(value || "");
  const anchors = [];
  const patterns = [
    /「([^」]+)」/gu,
    /『([^』]+)』/gu,
    /《([^》]+)》/gu,
    /【([^】]+)】/gu,
    /\[([^\]]+)\]/gu,
    /“([^”]+)”/gu,
    /"([^"]+)"/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const key = normalizeScenarioKey(match[1]);
      if (key.length >= 2 && key.length <= 100) anchors.push(key);
    }
  }
  return [...new Set(anchors)];
}

function normalizeScenarioKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
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
  if (answerLevel === "needs_more_info" && hasCardTextGrounding) {
    answerLevel = "rule_analysis";
    riskFlags.add("needs_more_info_upgraded_to_rule_analysis_with_card_text");
  } else if (answerLevel === "needs_more_info" && hasAnyEvidence) {
    answerLevel = "low_confidence_analysis";
    riskFlags.add("needs_more_info_downgraded_to_low_confidence_with_evidence");
  } else if (answerLevel === "low_confidence_analysis" && hasCardTextGrounding) {
    answerLevel = "rule_analysis";
    riskFlags.add("low_confidence_upgraded_to_rule_analysis_with_card_text");
  }
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
  if (source.type === "faq") return "faq";
  return "related";
}

function selectFallbackEvidence(evidence, availableEvidence) {
  return evidence.officialQaDirectCandidates?.[0]
    || evidence.operationLegality?.matchedRuleEvidence?.[0]
    || evidence.faqRelated?.[0]
    || evidence.officialQaRelated?.[0]
    || evidence.rawRelatedEvidence?.[0]
    || evidence.cardTexts?.[0]
    || evidence.userProvidedCardTexts?.[0]
    || availableEvidence[0];
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
