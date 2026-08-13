import { evidenceBucketsToList } from "./ragEvidenceRetriever.mjs";
import { extractRelevantOfficialQaAnswerExcerpt } from "./officialQaAnswerExtractor.mjs";

export const RAG_ANSWER_LEVELS = Object.freeze([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
  "budget_limited",
]);

const RAG_JSON_SHAPE_EXAMPLE = Object.freeze({
  answerLevel: "rule_analysis",
  shortAnswer: "根据现有资料可以给出分析，但不是官方直接裁定。",
  reasoning: ["核对题面和卡片原文。", "说明检索资料如何适用于本题。"],
  usedCards: ["示例卡名"],
  usedEvidence: [{ id: "card-text-example", type: "card_text", title: "示例卡名 的卡片文本" }],
  missingInfo: [],
  riskFlags: ["no_official_direct_qa"],
  confidenceSelfEstimate: "medium",
});

const EVIDENCE_BUCKET_ORDER = Object.freeze([
  "officialQaDirectCandidates",
  "userProvidedCardTexts",
  "cardTexts",
  "faqRelated",
  "officialQaRelated",
  "provisionalOfficialResponses",
  "rawRelatedEvidence",
]);

const GENERAL_INSTRUCTIONS = Object.freeze([
  "你是游戏王 OCG 规则分析助手。只依据用户原始问题、已解析卡片的原始卡文和所给检索资料回答，不得编造规则、卡文、资料或来源。",
  "先完整阅读用户问题，识别其中每一个子问题；逐个子问题给出直接结论，并说明结论所依据的题面事实、卡片原文和资料。不要漏答，也不要自行补造题面没有给出的状态。",
  "resolvedCards 是已经匹配成功的卡片；其中的 effectText 是原始卡文依据。只有 unresolvedMentions 或 ambiguousMentions 中仍存在的项目才算没有确定。",
  "严格区分证据层级：只有确实对应本题完整场景的 officialQaDirectCandidates 可以支持 official_confirmed；officialQaRelated、faqRelated、provisionalOfficialResponses、卡文和 rawRelatedEvidence 都只能作为相关资料或推导依据。",
  "相关资料不是本题原题时，必须比较它与题面的卡片、条件、位置、时点、对象、玩家和处理过程；只采用可迁移的部分，不得直接复制其结论或把它伪装成官方直接裁定。",
  "如果没有官方直接 Q&A，可以综合卡片原文、FAQ、官方相关 Q&A、用户提供文本和其他资料进行独立规则分析。资料足以推导时输出 rule_analysis，不要仅因没有官方原题就拒绝回答。",
  "如果决定结论所必需的事实确实缺失或资料相互冲突，明确列出缺失信息或条件分支；不得用常见场面、历史题目或猜测补齐，也不得虚构确定结论。",
  "不得根据卡名、题号、题型标签或历史答案套用预设结论。每次都从本次用户问题、原始卡文和本次证据重新推理。",
  "不得把 card_text、baige_card_text、user_provided_text、FAQ、rulebook、related evidence 或 rawRelatedEvidence 称为官方直接 Q&A。",
  "输出必须是单个 JSON 对象，不要 markdown、代码围栏或 JSON 外说明。字段必须包含 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
  "answerLevel 只能是 official_confirmed、rule_analysis、low_confidence_analysis、needs_more_info；budget_limited 仅供后端预算守卫使用，模型不要主动输出。",
  "shortAnswer 直接回答全部子问题；reasoning 是至少 2 条非空字符串，说明所依据的原文或资料以及它如何适用于题面。",
  "usedEvidence 只能引用 allowedEvidenceIds 中真实存在的 id，每项包含 id、type、title；没有实际引用时输出 []，不得自造 id。",
  "不确定之处写入 missingInfo 和 riskFlags；confidenceSelfEstimate 只是模型自评，不改变证据等级。",
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
  const limits = {
    maxCards: readNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readNumber(env.RAG_MAX_OFFICIAL_QA, 7),
    maxRelatedEvidence: readNumber(env.RAG_MAX_RELATED_EVIDENCE, 14),
    maxCardTextChars: readNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    maxPromptChars: readNumber(env.RAG_MAX_PROMPT_CHARS, 60000),
  };
  const authoritativeDirect = selectAuthoritativeOfficialDirectCandidate({
    candidates: evidence.officialQaDirectCandidates || [],
    cardResolution,
    baigeAmbiguousMentions: evidence.baigeAmbiguousMentions,
  });
  const evidencePayload = prepareEvidenceForPrompt(evidence, limits, warnings, {
    authoritativeDirectId: authoritativeDirect?.id || null,
  });
  const payload = {
    userQuery: String(userQuery || ""),
    resolvedCards: summarizeCards(cardResolution.resolvedCards || [], limits.maxCards),
    unresolvedMentions: cardResolution.unresolvedMentions || [],
    ambiguousMentions: cardResolution.ambiguousMentions || [],
    evidence: evidencePayload,
    allowedEvidenceIds: evidenceBucketsToList(evidencePayload)
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean),
  };

  if (authoritativeDirect) {
    warnings.push("official_direct_focused_prompt");
    const promptResult = buildOfficialDirectPrompt({
      userQuery: payload.userQuery,
      resolvedCards: payload.resolvedCards,
      directQa: authoritativeDirect,
      maxPromptChars: limits.maxPromptChars,
    });
    if (promptResult.truncated) warnings.push("official_direct_prompt_truncated");
    return {
      prompt: promptResult.prompt,
      recoveryPrompt: "",
      modelEvidence: evidencePayload,
      warnings,
      promptChars: promptResult.prompt.length,
      promptTruncated: promptResult.truncated,
      authoritativeOfficialDirectId: String(authoritativeDirect.id),
    };
  }

  let prompt = renderGeneralPrompt(payload);
  if (prompt.length > limits.maxPromptChars) {
    warnings.push("rag_prompt_compacted_to_max_chars");
    prompt = buildCompactRagPrompt({ payload, maxPromptChars: limits.maxPromptChars });
  }
  return {
    prompt,
    // Compatibility field only. Public generation is deliberately one-call,
    // so constructing a second model prompt here would be dead work and could
    // obscure the exact input used for evaluation.
    recoveryPrompt: "",
    modelEvidence: evidencePayload,
    warnings,
    promptChars: prompt.length,
    promptTruncated: warnings.some((warning) => warning.includes("truncated") || warning.includes("compacted")),
    authoritativeOfficialDirectId: null,
  };
}

export function selectAuthoritativeOfficialDirectCandidate({
  candidates = [],
  cardResolution = {},
  baigeAmbiguousMentions = [],
} = {}) {
  if (candidates.length !== 1) return null;
  const [candidate] = candidates;
  if ((candidate?.matchedBy || []).includes("multi_branch_related_evidence")) return null;
  const completeIdentity = !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length
    && !(baigeAmbiguousMentions || []).length;
  const exactQuestionCardSet = candidate?.questionCardIdCoverage === 1
    && candidate?.questionCardIdCount > 0
    && candidate?.questionCardIdCount === (candidate?.matchedQuestionCardIds || []).length;
  // Only a unique record matched from the raw/normalized user question is an
  // official direct answer. Structured-scene and semantic/card-subsumption
  // matches remain useful related evidence, but local heuristics must never
  // promote them into a focused answer route that bypasses the ordinary final
  // model comparison.
  const rawQuestionExact = candidate?.authoritativeSceneMatchReason === "raw_or_normalized_query";
  return candidate?.isDirect === true
    && candidate?.matchLevel === "official_qa_exact"
    && candidate?.type === "official_qa"
    && candidate?.authoritativeSceneMatch === true
    && rawQuestionExact
    && exactQuestionCardSet
    && completeIdentity
    && Boolean(candidate?.id)
    && Boolean(candidate?.fullText || candidate?.text || candidate?.answer || candidate?.officialText)
    ? candidate
    : null;
}

function renderGeneralPrompt(payload) {
  return [
    ...GENERAL_INSTRUCTIONS,
    `允许的 answerLevel：${RAG_ANSWER_LEVELS.join(", ")}。`,
    "以下 JSON 只展示字段结构，内容不是本题答案：",
    JSON.stringify(RAG_JSON_SHAPE_EXAMPLE),
    "本次用户问题、卡片原文与检索资料如下：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function buildOfficialDirectPrompt({
  userQuery,
  resolvedCards = [],
  directQa = {},
  maxPromptChars,
} = {}) {
  const configuredMaxChars = Math.max(1, Number(maxPromptChars) || 12000);
  // A complete serialized envelope is mandatory. For unrealistically small
  // limits, exceeding the configured target is safer than slicing JSON or
  // dropping the official evidence identity.
  const maxChars = Math.max(600, configuredMaxChars);
  const arrayFields = "reasoning、usedCards、missingInfo、riskFlags 必须是字符串数组；usedEvidence 必须是对象数组，每项含 id、type、title；无内容也输出 []。";
  const instructions = [
    "你是游戏王 OCG 官方 Q&A 转述助手。检索器已经严格确认下面唯一的 officialQaDirectCandidate 对应用户完整问题。",
    "以该官方 Q&A 为裁定依据，完整回答用户的全部子问题；保留其中所有实质条件、例外、后续处理、次数和限制，不得添加原文没有说明的处理。",
    "resolvedCards 仅用于理解卡片身份和还原资料中的卡名占位符。",
    `answerLevel 必须为 official_confirmed；usedEvidence 必须包含 id=${String(directQa.id || "")}、type=official_qa。`,
    arrayFields,
    "输出单个 JSON 对象，字段为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate；不要输出 JSON 外内容。",
  ];
  const cards = resolvedCards.map((card) => ({ id: card.id, name: card.name, aliases: card.aliases || [] }));
  const sourceText = extractRelevantOfficialQaAnswerExcerpt(directQa);
  const render = (lines, query, identities, text) => [
    ...lines,
    JSON.stringify({
      userQuery: query,
      resolvedCards: identities,
      officialQaDirectCandidate: {
        id: directQa.id,
        type: "official_qa",
        title: directQa.title || "",
        text,
        sourceUrl: directQa.sourceUrl || "",
      },
    }),
  ].join("\n");
  let prompt = render(instructions, String(userQuery || ""), cards, sourceText);
  if (prompt.length <= maxChars) return { prompt, truncated: false };
  const compactInstructions = [
    "完整转述唯一精确官方 Q&A，回答全部子问题并保留所有条件、例外、后续处理和限制，不得增删结论。",
    `输出规定字段的单个 JSON；answerLevel=official_confirmed，usedEvidence 必须引用 official_qa:${String(directQa.id || "")}。`,
    arrayFields,
  ];
  const compactCards = cards.slice(0, 6).map((card) => ({ id: card.id, name: card.name }));
  const compactQuery = preserveTextEnds(userQuery, 500);
  const fixed = render(compactInstructions, compactQuery, compactCards, "");
  prompt = render(
    compactInstructions,
    compactQuery,
    compactCards,
    preserveTextEnds(sourceText, Math.max(80, maxChars - fixed.length - 8)),
  );
  if (prompt.length > maxChars) {
    const minimal = ["完整转述给定唯一官方 Q&A；输出规定 JSON 并引用其 official_qa id。", arrayFields];
    const minimalFixed = render(minimal, preserveTextEnds(userQuery, 120), [], "");
    prompt = render(
      minimal,
      preserveTextEnds(userQuery, 120),
      [],
      preserveTextEnds(sourceText, Math.max(40, maxChars - minimalFixed.length - 8)),
    );
  }
  if (prompt.length > maxChars) {
    prompt = render(
      ["完整转述唯一官方 Q&A，输出规定 JSON 并引用其 official_qa id。"],
      preserveTextEnds(userQuery, 40),
      [],
      preserveTextEnds(sourceText, 40),
    );
  }
  return {
    prompt,
    truncated: true,
    exceedsConfiguredLimit: prompt.length > configuredMaxChars,
  };
}

function prepareEvidenceForPrompt(
  evidence,
  limits,
  warnings,
  { authoritativeDirectId = null } = {},
) {
  const directCandidates = Array.isArray(evidence.officialQaDirectCandidates)
    ? evidence.officialQaDirectCandidates
    : [];
  const focusedDirectCandidates = authoritativeDirectId ? directCandidates : [];
  const downgradedDirectCandidates = authoritativeDirectId
    ? []
    : directCandidates.map(downgradeOfficialDirectToRelated);
  if (downgradedDirectCandidates.length) {
    warnings.push(`official_direct_candidates_downgraded_to_related:${downgradedDirectCandidates.length}`);
  }
  const relatedCandidates = dedupePromptEvidence([
    ...downgradedDirectCandidates,
    ...(Array.isArray(evidence.officialQaRelated) ? evidence.officialQaRelated : []),
  ]);
  return {
    officialQaDirectCandidates: limitEvidence(focusedDirectCandidates, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_direct", warnings),
    officialQaRelated: limitEvidence(relatedCandidates, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "official_related", warnings),
    provisionalOfficialResponses: limitEvidence(evidence.provisionalOfficialResponses, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_response", warnings),
    faqRelated: limitEvidence(evidence.faqRelated, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "faq", warnings),
    cardTexts: limitEvidence(evidence.cardTexts, limits.maxCards, limits.maxCardTextChars, "card_text", warnings),
    userProvidedCardTexts: limitEvidence(evidence.userProvidedCardTexts, limits.maxCards, limits.maxCardTextChars, "user_text", warnings),
    rawRelatedEvidence: limitEvidence(evidence.rawRelatedEvidence, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "raw_related", warnings),
  };
}

function downgradeOfficialDirectToRelated(item = {}) {
  return {
    ...item,
    type: "related",
    isDirect: false,
    matchLevel: "official_qa_near",
    // Matching diagnostics may explain ranking, but direct-authority labels do
    // not belong in the ordinary evidence envelope seen by the final model.
    matchedBy: (item.matchedBy || []).filter((value) => ![
      "raw_or_normalized_query",
      "unique_structured_scene",
      "unique_semantic_question_subsumption",
      "unique_question_card_subsumption",
    ].includes(value)),
  };
}

function dedupePromptEvidence(items = []) {
  const seenIds = new Set();
  return items.filter((item) => {
    const id = String(item?.id || "").trim();
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
}

function limitEvidence(items = [], limit, textLimit, label, warnings) {
  const source = Array.isArray(items) ? items : [];
  if (source.length > limit) warnings.push(`${label}_evidence_limited:${source.length}->${limit}`);
  return source.slice(0, limit).map((item) => {
    const text = String(item.fullText || item.text || item.officialText || item.answer || "");
    if (text.length > textLimit) warnings.push(`${label}_text_truncated:${item.id}`);
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      text: preserveTextEnds(text, textLimit),
      sourceUrl: item.sourceUrl || "",
      source: item.source || "",
      isDirect: item.isDirect === true,
      matchLevel: item.matchLevel || "",
      cards: item.cards || [],
      cardIds: item.cardIds || [],
      ...((item.matchedBy || []).length ? { matchedBy: item.matchedBy } : {}),
      ...((item.matchedQuestionCardIds || []).length
        ? { matchedQuestionCardIds: item.matchedQuestionCardIds }
        : {}),
    };
  });
}

function buildCompactRagPrompt({ payload, maxPromptChars }) {
  const maxChars = Math.max(600, Number(maxPromptChars) || 12000);
  const evidenceLimit = maxChars >= 12000 ? 24 : maxChars >= 4000 ? 14 : 7;
  const textLimit = maxChars >= 12000 ? 900 : maxChars >= 4000 ? 360 : 140;
  const compactEvidence = Object.fromEntries(EVIDENCE_BUCKET_ORDER.map((bucket) => [bucket, []]));
  let count = 0;
  for (let index = 0; count < evidenceLimit; index += 1) {
    let added = false;
    for (const bucket of EVIDENCE_BUCKET_ORDER) {
      const item = payload.evidence?.[bucket]?.[index];
      if (!item || count >= evidenceLimit) continue;
      compactEvidence[bucket].push({
        id: item.id,
        type: item.type,
        title: item.title,
        text: preserveTextEnds(item.text, textLimit),
        sourceUrl: item.sourceUrl || "",
        isDirect: item.isDirect === true,
        matchLevel: item.matchLevel || "",
      });
      count += 1;
      added = true;
    }
    if (!added) break;
  }
  const compactPayload = {
    userQuery: preserveTextEnds(payload.userQuery, maxChars >= 4000 ? 1600 : 500),
    resolvedCards: (payload.resolvedCards || []).slice(0, 6).map((card) => ({
      ...card,
      effectText: preserveTextEnds(card.effectText, maxChars >= 12000 ? 1600 : maxChars >= 4000 ? 700 : 220),
    })),
    unresolvedMentions: (payload.unresolvedMentions || []).slice(0, 8),
    ambiguousMentions: (payload.ambiguousMentions || []).slice(0, 8),
    evidence: compactEvidence,
    allowedEvidenceIds: EVIDENCE_BUCKET_ORDER
      .flatMap((bucket) => compactEvidence[bucket].map((item) => String(item.id || "").trim()))
      .filter(Boolean),
  };
  let prompt = renderGeneralPrompt(compactPayload);
  if (prompt.length <= maxChars) return prompt;

  const evidenceSummaries = EVIDENCE_BUCKET_ORDER.flatMap((bucket) =>
    compactEvidence[bucket].map((item) => ({
      bucket,
      id: item.id,
      type: item.type,
      title: preserveTextEnds(item.title, 80),
      text: preserveTextEnds(item.text, 100),
    }))
  ).slice(0, 8);
  const minimalPayload = {
    userQuery: preserveTextEnds(payload.userQuery, 260),
    resolvedCards: (payload.resolvedCards || []).slice(0, 3).map((card) => ({
      id: card.id,
      name: card.name,
      effectText: preserveTextEnds(card.effectText, 140),
    })),
    unresolvedMentions: (payload.unresolvedMentions || []).slice(0, 3),
    ambiguousMentions: (payload.ambiguousMentions || []).slice(0, 3),
    evidence: evidenceSummaries,
    allowedEvidenceIds: evidenceSummaries.map((item) => item.id).filter(Boolean),
  };
  prompt = [
    "仅依据用户问题、卡片原文和所给资料，逐个子问题推理并输出规定 JSON；不得编造。只有完整对应本题的 official direct Q&A 才可标为 official_confirmed，相关资料与卡文只能支持分析。",
    "字段：answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。usedEvidence 的 id 只能来自 allowedEvidenceIds。",
    JSON.stringify(minimalPayload),
  ].join("\n");
  if (prompt.length <= maxChars) return prompt;

  // Never cut a serialized JSON value in half. The smallest fallback keeps a
  // complete question/card/evidence identity envelope; exceeding an
  // unrealistically small configured limit is safer than sending invalid JSON
  // whose tail the model could hallucinate.
  const smallestPayload = {
    userQuery: preserveTextEnds(payload.userQuery, 80),
    resolvedCards: (payload.resolvedCards || []).slice(0, 1).map((card) => ({
      id: card.id,
      name: preserveTextEnds(card.name, 40),
      effectText: preserveTextEnds(card.effectText, 60),
    })),
    unresolvedMentions: [],
    ambiguousMentions: [],
    evidence: evidenceSummaries.slice(0, 1).map((item) => ({
      bucket: item.bucket,
      id: item.id,
      type: item.type,
      title: preserveTextEnds(item.title, 30),
      text: preserveTextEnds(item.text, 40),
    })),
    allowedEvidenceIds: evidenceSummaries.slice(0, 1)
      .map((item) => item.id)
      .filter(Boolean),
  };
  return [
    "仅依据下列完整 JSON 回答并输出规定 JSON；不得编造。",
    JSON.stringify(smallestPayload),
  ].join("\n");
}

function summarizeCards(cards, limit) {
  return cards.slice(0, limit).map((card) => ({
    id: card.id || card.cardId || "",
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: card.aliases || [],
    cardType: card.cardType || card.type || "",
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? null,
    rank: card.rank ?? null,
    link: card.link ?? null,
    properties: card.properties || [],
    monsterProperties: card.monsterProperties || [],
    source: card.source || "",
    effectText: card.effectText || card.text || "",
  }));
}

function preserveTextEnds(value, limit) {
  const text = String(value || "");
  const max = Math.max(1, Number(limit) || 1);
  if (text.length <= max) return text;
  const head = Math.max(1, Math.ceil((max - 1) * 0.6));
  const tail = Math.max(1, max - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
