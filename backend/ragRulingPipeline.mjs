import { requestOcgEngineSimulation } from "./ocgEngineClient.mjs";
import { autoEngineSimulationEnabled, buildBestEffortEngineScenario } from "./ocgScenarioPlanner.mjs";
import { extractRagCards, normalizeCardKey } from "./ragCardExtractor.mjs";
import { evidenceBucketsToList, loadRagData, retrieveRagEvidence } from "./ragEvidenceRetriever.mjs";
import { callCardNameExtractionModel, callRagModel, callRulebookGroundingModel, callRuleQueryExtractionModel } from "./ragModelClient.mjs";
import { buildRagRulingPromptBundle, RAG_ANSWER_LEVELS } from "./ragRulingPrompt.mjs";

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
  const query = String(question || userQuery || "").trim();
  if (!query) return buildEmptyQuestionAnswer();

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
  const cardResolution = extractRagCards(query, {
    cards: data.cards || [],
    maxCards: readNumber(env.RAG_MAX_CARDS, 6),
    modelCardNameCandidates: cardNameModel.candidates || [],
  });
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
  const rulebookGrounding = await callRulebookGroundingModel({
    userQuery: query,
    cardTexts: [...(retrievedEvidence.cardTexts || []), ...(retrievedEvidence.userProvidedCardTexts || [])],
    ruleEvidence: retrievedEvidence.rulebookCandidates || [],
    qaEvidence: dedupeEvidenceRefs([
      ...(retrievedEvidence.officialQaDirectCandidates || []),
      ...(retrievedEvidence.officialQaRelated || []),
      ...(retrievedEvidence.faqRelated || []),
    ]),
    env,
    modelInvoker: rulebookModelInvoker,
    fetchImpl,
    now,
  });
  const evidence = attachRulebookGrounding(retrievedEvidence, rulebookGrounding);
  const promptBundle = buildRagRulingPromptBundle({ userQuery: query, cardResolution: effectiveCardResolution, evidence, env });
  const displayCards = dedupeCards([
    ...(effectiveCardResolution.resolvedCards || []),
    ...userProvidedCards(evidence.userProvidedCardTexts || []),
  ]);
  const modelResult = await callRagModel({
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
  const modelAnswer = normalizeRagAnswer(modelResult.answer, { evidence, cardResolution: effectiveCardResolution, modelWarnings: modelResult.warnings || [] });
  const groundedFallback = applyGroundedOperationFallback(modelAnswer, evidence);
  const evidenceConstrained = applyExactScenarioGrounding(groundedFallback, evidence, query);
  const operationConstrained = applyOperationLegalityOverride(evidenceConstrained, evidence);
  const normalized = applyUnresolvedConstraintGuard(operationConstrained, evidence);
  const engine = await enginePromise;
  const engineRiskFlags = [
    ...(engine.status === "completed"
      ? ["engine_simulation_not_official_evidence"]
      : engine.requested ? ["engine_simulation_unavailable"] : []),
    ...(enginePlan.bestEffort ? ["engine_scenario_best_effort"] : []),
  ];

  return {
    mode: "rag_baseline",
    answerLevel: normalized.answerLevel,
    shortAnswer: normalized.shortAnswer,
    reasoning: normalized.reasoning,
    usedEvidence: normalized.usedEvidence,
    resolvedCards: displayCards,
    missingInfo: normalized.missingInfo,
    riskFlags: [...new Set([...normalized.riskFlags, ...engineRiskFlags])],
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
      providerUsed: modelResult.providerUsed || modelResult.provider,
      modelUsed: modelResult.modelUsed,
      modelName: modelResult.modelName,
      dryRun: modelResult.dryRun,
      tokenUsage: modelResult.tokenUsage || {},
      estimatedCostCny: (modelResult.estimatedCostCny || 0) + (rulebookGrounding.estimatedCostCny || 0),
      budgetStatus: modelResult.budgetStatus || null,
      promptChars: promptBundle.promptChars,
      promptTruncated: promptBundle.promptTruncated,
    },
  };
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
