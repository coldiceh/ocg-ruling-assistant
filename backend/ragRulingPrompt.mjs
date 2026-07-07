import { evidenceBucketsToList } from "./ragEvidenceRetriever.mjs";

export const RAG_ANSWER_LEVELS = Object.freeze([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
]);

export function buildRagRulingPrompt({
  userQuery,
  cardResolution = {},
  evidence = {},
} = {}) {
  const payload = {
    userQuery: String(userQuery || ""),
    resolvedCards: summarizeCards(cardResolution.resolvedCards || []),
    unresolvedMentions: cardResolution.unresolvedMentions || [],
    ambiguousMentions: cardResolution.ambiguousMentions || [],
    evidence: {
      cardTexts: evidence.cardTexts || [],
      officialQaDirectCandidates: evidence.officialQaDirectCandidates || [],
      officialQaRelated: evidence.officialQaRelated || [],
      faqRelated: evidence.faqRelated || [],
      rawRelatedEvidence: evidence.rawRelatedEvidence || [],
      retrievalWarnings: evidence.retrievalWarnings || [],
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

  return [
    "你是游戏王 OCG 裁定分析助手。你要基于检索到的资料生成 RAG 裁定分析。",
    "优先根据官方 Q&A direct candidates 回答；只有 officialQaDirectCandidates 中的资料可以支持 official_confirmed。",
    "如果没有官方直接 Q&A，可以根据卡片文本、FAQ、官方相似案例和相关资料给裁定分析。",
    "必须区分 answerLevel：official_confirmed、rule_analysis、low_confidence_analysis、needs_more_info。",
    "不得把 related evidence、FAQ 或 rawRelatedEvidence 伪装成 official direct。",
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
    `可引用 evidence id 列表：${evidenceBucketsToList(evidence).map((item) => item.id).join(", ") || "(none)"}`,
  ].join("\n");
}

function summarizeCards(cards) {
  return (cards || []).map((card) => ({
    id: card.id || card.cardId || "",
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: card.aliases || [],
    cardType: card.cardType || "",
    effectText: card.effectText || "",
  }));
}
