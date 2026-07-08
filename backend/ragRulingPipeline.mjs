import { extractRagCards } from "./ragCardExtractor.mjs";
import { evidenceBucketsToList, loadRagData, retrieveRagEvidence } from "./ragEvidenceRetriever.mjs";
import { callRagModel } from "./ragModelClient.mjs";
import { buildRagRulingPromptBundle, RAG_ANSWER_LEVELS } from "./ragRulingPrompt.mjs";

export async function answerRagRulingQuestion({
  question,
  userQuery,
  dataDir,
  cards,
  records,
  qaRecords,
  modelInvoker,
  dryRun,
  fetchImpl,
  now,
  env = globalThis.process?.env || {},
} = {}) {
  const query = String(question || userQuery || "").trim();
  if (!query) return buildEmptyQuestionAnswer();

  const data = cards || records || qaRecords ? { cards: cards || [], records: records || [], qaRecords: qaRecords || [] } : await loadRagData(dataDir);
  const cardResolution = extractRagCards(query, { cards: data.cards || [], maxCards: readNumber(env.RAG_MAX_CARDS, 6) });
  const evidence = await retrieveRagEvidence({
    userQuery: query,
    cardResolution,
    dataDir,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    env,
    fetchImpl,
  });
  const promptBundle = buildRagRulingPromptBundle({ userQuery: query, cardResolution, evidence, env });
  const displayCards = dedupeCards([
    ...(cardResolution.resolvedCards || []),
    ...(evidence.fuzzyResolvedCards || []),
    ...(evidence.baigeResolvedCards || []),
    ...userProvidedCards(evidence.userProvidedCardTexts || []),
  ]);
  const modelResult = await callRagModel({
    prompt: promptBundle.prompt,
    evidence,
    cardResolution,
    env,
    modelInvoker,
    dryRun,
    fetchImpl,
    now,
  });
  const normalized = normalizeRagAnswer(modelResult.answer, { evidence, cardResolution, modelWarnings: modelResult.warnings || [] });

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
    debug: {
      mode: "rag_baseline",
      retrievalCounts: {
        cardTexts: evidence.cardTexts.length,
        userProvidedCardTexts: evidence.userProvidedCardTexts.length,
        officialQaDirectCandidates: evidence.officialQaDirectCandidates.length,
        officialQaRelated: evidence.officialQaRelated.length,
        faqRelated: evidence.faqRelated.length,
        rawRelatedEvidence: evidence.rawRelatedEvidence.length,
      },
      unresolvedMentions: cardResolution.unresolvedMentions,
      ambiguousMentions: [...(cardResolution.ambiguousMentions || []), ...(evidence.baigeAmbiguousMentions || [])],
      retrievalWarnings: [...new Set([...(evidence.retrievalWarnings || []), ...(promptBundle.warnings || [])])],
      baigeSearchCount: evidence.debug?.baigeSearchCount || 0,
      baigeCacheHitCount: evidence.debug?.baigeCacheHitCount || 0,
      baigeWarnings: evidence.debug?.baigeWarnings || [],
      providerUsed: modelResult.providerUsed || modelResult.provider,
      modelUsed: modelResult.modelUsed,
      modelName: modelResult.modelName,
      dryRun: modelResult.dryRun,
      tokenUsage: modelResult.tokenUsage || {},
      estimatedCostCny: modelResult.estimatedCostCny || 0,
      budgetStatus: modelResult.budgetStatus || null,
      promptChars: promptBundle.promptChars,
      promptTruncated: promptBundle.promptTruncated,
    },
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
      };
    })
    .filter(Boolean);

  if (!usedEvidence.length && hasAnyEvidence) {
    const fallbackEvidence = selectFallbackEvidence(evidence, availableEvidence);
    usedEvidence.push({
      id: fallbackEvidence.id,
      type: outputEvidenceType(fallbackEvidence, directIds),
      title: fallbackEvidence.title,
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
  if (source.type === "faq") return "faq";
  return "related";
}

function selectFallbackEvidence(evidence, availableEvidence) {
  return evidence.officialQaDirectCandidates?.[0]
    || evidence.cardTexts?.[0]
    || evidence.userProvidedCardTexts?.[0]
    || evidence.faqRelated?.[0]
    || evidence.officialQaRelated?.[0]
    || evidence.rawRelatedEvidence?.[0]
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
