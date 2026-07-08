import { evidenceBucketsToList } from "./ragEvidenceRetriever.mjs";

export const RAG_ANSWER_LEVELS = Object.freeze([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
  "budget_limited",
]);

export function buildRagRulingPrompt({
  userQuery,
  cardResolution = {},
  evidence = {},
  env = {},
} = {}) {
  return buildRagRulingPromptBundle({ userQuery, cardResolution, evidence, env }).prompt;
}

export function buildRagRulingPromptBundle({
  userQuery,
  cardResolution = {},
  evidence = {},
  env = {},
} = {}) {
  const warnings = [];
  const promptLimits = {
    maxCards: readNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readNumber(env.RAG_MAX_OFFICIAL_QA, 5),
    maxRelatedEvidence: readNumber(env.RAG_MAX_RELATED_EVIDENCE, 8),
    maxCardTextChars: readNumber(env.RAG_MAX_CARD_TEXT_CHARS, 2500),
    maxPromptChars: readNumber(env.RAG_MAX_PROMPT_CHARS, 30000),
  };
  const evidencePayload = prepareEvidenceForPrompt(evidence, promptLimits, warnings);
  const payload = {
    userQuery: String(userQuery || ""),
    resolvedCards: summarizeCards(cardResolution.resolvedCards || [], promptLimits.maxCards),
    unresolvedMentions: cardResolution.unresolvedMentions || [],
    ambiguousMentions: cardResolution.ambiguousMentions || [],
    evidence: {
      ...evidencePayload,
      retrievalWarnings: [...(evidence.retrievalWarnings || []), ...warnings],
    },
  };

  const example = {
    answerLevel: "rule_analysis",
    shortAnswer: "根据现有资料可以给出分析，但不是官方直接裁定。",
    reasoning: ["先核对卡片文本。", "再比对官方相似资料。"],
    usedCards: ["示例卡名"],
    usedEvidence: [{ id: "card-text-example", type: "card_text", title: "示例卡名 的卡片文本" }],
    missingInfo: [],
    riskFlags: ["no_official_direct_qa"],
    confidenceSelfEstimate: "medium",
  };

  let prompt = [
    "你是游戏王 OCG 裁定分析助手。你要基于检索到的资料生成 RAG 裁定分析。",
    "优先根据官方 Q&A direct candidates 回答；只有 officialQaDirectCandidates 中的资料可以支持 official_confirmed。",
    "资料来源必须区分：official_direct_qa、official_related_qa、card_text、user_provided_text、faq_related、raw_related。",
    "user_provided_text 是用户在问题中粘贴的卡片文本，不是官方 direct evidence；可以基于这些文本分析，但不得称为官方确认。",
    "如果没有官方直接 Q&A，可以根据卡片文本、用户提供文本、FAQ、官方相似案例和相关资料给裁定分析。",
    "没有 official direct 时，answerLevel 只能是 rule_analysis、low_confidence_analysis 或 needs_more_info。",
    "如果用户提供文本足够完整，不要仅因为本地数据库找不到该卡或缺少 official direct Q&A 就输出 needs_more_info。",
    "如果至少存在卡片文本、用户提供文本、FAQ、官方相似案例或相关资料，不要只回答 needs_more_info；应输出 rule_analysis 或 low_confidence_analysis，并明确不是官方确认。",
    "只有在完全没有可用卡片文本、相关资料，或问题缺少关键场景导致无法分析时，才输出 needs_more_info。",
    "必须区分 answerLevel：official_confirmed、rule_analysis、low_confidence_analysis、needs_more_info。budget_limited 只由后端预算守卫使用，模型不要主动输出。",
    "不得把 user_provided_text、related evidence、FAQ 或 rawRelatedEvidence 伪装成 official direct。",
    "不得编造官方 Q&A、资料 id、卡片文本或规则出处。",
    "不确定时要把需要补充的信息写入 missingInfo，把风险写入 riskFlags。",
    "confidenceSelfEstimate 只是模型自评，不代表最终官方等级。",
    "输出必须是单个 JSON 对象，不要 markdown，不要代码围栏，不要 JSON 外说明。",
    "JSON 字段必须包含 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
    `允许的 answerLevel：${RAG_ANSWER_LEVELS.join(", ")}。`,
    "usedEvidence 只能引用下方 evidence 中真实存在的 id。",
    "示例结构如下，示例不是具体裁定：",
    JSON.stringify(example, null, 2),
    "本次检索上下文如下：",
    JSON.stringify(payload, null, 2),
    `可引用 evidence id 列表：${evidenceBucketsToList(evidencePayload).map((item) => item.id).join(", ") || "(none)"}`,
  ].join("\n");
  if (prompt.length > promptLimits.maxPromptChars) {
    warnings.push("rag_prompt_truncated_to_max_chars");
    const suffix = "\n\n[上下文因 RAG_MAX_PROMPT_CHARS 限制被截断。不要补造被截断的证据。]";
    prompt = `${prompt.slice(0, Math.max(0, promptLimits.maxPromptChars - suffix.length))}${suffix}`;
  }
  return {
    prompt,
    warnings,
    promptChars: prompt.length,
    promptTruncated: warnings.some((warning) => warning.includes("truncated")),
  };
}

function summarizeCards(cards, limit) {
  return (cards || []).slice(0, limit).map((card) => ({
    id: card.id || card.cardId || "",
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: card.aliases || [],
    cardType: card.cardType || "",
    effectText: card.effectText || "",
  }));
}

function prepareEvidenceForPrompt(evidence, limits, warnings) {
  return {
    officialQaDirectCandidates: limitEvidence(evidence.officialQaDirectCandidates, limits.maxOfficialQa, 1800, "official_direct", warnings),
    officialQaRelated: limitEvidence(evidence.officialQaRelated, limits.maxRelatedEvidence, 1600, "official_related", warnings),
    faqRelated: limitEvidence(evidence.faqRelated, limits.maxRelatedEvidence, 1600, "faq", warnings),
    cardTexts: limitEvidence(evidence.cardTexts, limits.maxCards, limits.maxCardTextChars, "card_text", warnings),
    userProvidedCardTexts: limitEvidence(evidence.userProvidedCardTexts, limits.maxCards, limits.maxCardTextChars, "user_provided_text", warnings),
    rawRelatedEvidence: limitEvidence(evidence.rawRelatedEvidence, limits.maxRelatedEvidence, 1200, "raw_related", warnings),
  };
}

function limitEvidence(items = [], limit, textLimit, label, warnings) {
  const source = Array.isArray(items) ? items : [];
  if (source.length > limit) warnings.push(`${label}_evidence_limited:${source.length}->${limit}`);
  return source.slice(0, limit).map((item) => {
    const text = String(item.text || "");
    const truncated = text.length > textLimit;
    if (truncated) warnings.push(`${label}_text_truncated:${item.id}`);
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      isDirect: Boolean(item.isDirect),
      matchLevel: item.matchLevel || "",
      cards: item.cards || [],
      cardIds: item.cardIds || [],
      text: truncated ? `${text.slice(0, Math.max(0, textLimit - 1))}…` : text,
      sourceUrl: item.sourceUrl || "",
      source: item.source || "",
      official: item.official === true,
    };
  });
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
