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
  });
  const promptBundle = buildRagRulingPromptBundle({ userQuery: query, cardResolution, evidence, env });
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
    resolvedCards: cardResolution.resolvedCards,
    missingInfo: normalized.missingInfo,
    riskFlags: normalized.riskFlags,
    confidenceSelfEstimate: normalized.confidenceSelfEstimate,
    debug: {
      mode: "rag_baseline",
      retrievalCounts: {
        cardTexts: evidence.cardTexts.length,
        officialQaDirectCandidates: evidence.officialQaDirectCandidates.length,
        officialQaRelated: evidence.officialQaRelated.length,
        faqRelated: evidence.faqRelated.length,
        rawRelatedEvidence: evidence.rawRelatedEvidence.length,
      },
      unresolvedMentions: cardResolution.unresolvedMentions,
      ambiguousMentions: cardResolution.ambiguousMentions,
      retrievalWarnings: [...new Set([...(evidence.retrievalWarnings || []), ...(promptBundle.warnings || [])])],
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
  const evidenceById = new Map(availableEvidence.map((item) => [String(item.id), item]));
  const directIds = new Set((evidence.officialQaDirectCandidates || []).map((item) => String(item.id)));
  const riskFlags = new Set([...(answer.riskFlags || []), ...modelWarnings]);
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

  if (answerLevel === "official_confirmed" && !usedEvidence.some((item) => directIds.has(String(item.id)))) {
    answerLevel = usedEvidence.length ? "rule_analysis" : "low_confidence_analysis";
    riskFlags.add("official_confirmed_requires_direct_evidence");
  }
  if (!usedEvidence.length && availableEvidence.length) {
    const fallbackEvidence = availableEvidence[0];
    usedEvidence.push({
      id: fallbackEvidence.id,
      type: outputEvidenceType(fallbackEvidence, directIds),
      title: fallbackEvidence.title,
    });
    riskFlags.add("model_omitted_used_evidence");
  }
  if (!availableEvidence.length && answerLevel !== "budget_limited") {
    answerLevel = "needs_more_info";
    riskFlags.add("no_retrieved_evidence");
  }
  if (!(cardResolution.resolvedCards || []).length) riskFlags.add("card_name_not_resolved");

  return {
    answerLevel,
    shortAnswer: String(answer.shortAnswer || "当前资料不足，无法给出可靠裁定分析。").trim(),
    reasoning: cleanStringArray(answer.reasoning).length ? cleanStringArray(answer.reasoning) : ["基于当前检索资料生成 RAG baseline 分析。"],
    usedEvidence,
    missingInfo: cleanStringArray(answer.missingInfo),
    riskFlags: [...riskFlags].filter(Boolean),
    confidenceSelfEstimate: ["low", "medium", "high"].includes(answer.confidenceSelfEstimate) ? answer.confidenceSelfEstimate : "low",
  };
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
  if (source.type === "faq") return "faq";
  return "related";
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
