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

const CARD_TEXT_BUCKETS = Object.freeze([
  "cardTexts",
  "userProvidedCardTexts",
]);

const OFFICIAL_REFERENCE_BUCKETS = Object.freeze([
  "officialQaDirectCandidates",
  "faqRelated",
  "officialQaRelated",
  "provisionalOfficialResponses",
]);

const GENERAL_INSTRUCTIONS = Object.freeze([
  "你是游戏王 OCG 规则分析助手。只依据用户原始问题、已解析卡片的原始卡文和所给检索资料回答，不得编造规则、卡文、资料或来源。",
  "先完整阅读用户问题，识别其中每一个子问题；逐个子问题给出直接结论，并说明结论所依据的题面事实、卡片原文和资料。不要漏答，也不要自行补造题面没有给出的状态。",
  "resolvedCards 是已经匹配成功的卡片；其中的 effectText 是原始卡文依据。只有 unresolvedMentions 或 ambiguousMentions 中仍存在的项目才算没有确定。",
  "严格区分证据层级：只有确实对应本题完整场景的 officialQaDirectCandidates 可以支持 official_confirmed；officialQaRelated、faqRelated、provisionalOfficialResponses、卡文和 rawRelatedEvidence 都只能作为相关资料或推导依据。",
  "每条资料中的 official、recordType、source、sourceTier 和 sourceAuthority 表示来源层级，不表示它必然适用于本题。official=true 只说明资料来自官方数据库或官方来源；仍须核对其问题场景后才能采用。community_reference（包括 ocg-rule 等社区整理）只能作为辅助；与适用于本题的官方 Q&A/FAQ 冲突时，以官方资料为准。",
  "相关资料不是本题原题时，必须比较它与题面的卡片、条件、位置、时点、对象、玩家和处理过程；只采用可迁移的部分，不得直接复制其结论或把它伪装成官方直接裁定。",
  "retrievalContext.relatedOnly=true 的资料（包括跨卡机制资料）始终只是相关证据；即使来源为官方，也不得据此提升为 official direct 或 official_confirmed。",
  "先建立事件时间线，并为每个实际相关步骤建立统一状态检查表：发动快照（发动/适用条件、cost、对象、区域、表示形式、当时作为何种卡处理）、处理快照（逆序处理到该连锁项时的当前区域、类型、属性/等级与正在适用的效果）以及处理后快照。引用相关 Q&A 前必须核对它描述的是同一阶段与事件节点，不得把相邻但不同的时点互换。",
  "先核对每个处理的效果来源与效果类型，再核对实际受影响实体：受到影响的是卡、怪兽、玩家、攻击、召唤还是其他处理。不得因为文本提到某实体就偷换效果来源、效果类型或受影响实体。",
  "若同一效果在发动时要求存在可执行的后续选择，而处理途中状态又会改变，必须分别说明发动时的合法选项与处理时最终能执行的选项。连续处理按卡文分句逐步执行：对每一步记录由哪个效果实际执行、是否完成以及完成后的状态，再检查下一步及其对前一步的依赖；不得仅因最终状态看似相同就认定原效果完成，也不得用尚未发生的后续状态倒推、省略发动条件，或在没有卡文或资料依据时因后一步失败而撤销已经完成的独立步骤。",
  "核对权限关系：允许、追加、禁止、免疫或替代分别授予或约束谁以及哪一种动作。检查不受影响或免疫时，必须同时核对效果的真实来源、效果类型和受影响实体；无论结果看似有利还是不利都使用同一检查，不得只凭结果倾向决定是否受影响。不能把只针对一种实体或动作的权限/限制扩张到另一种。",
  "遇到次数、攻击次数、追加权限或可再次执行次数，建立显式账本：初始权限、已经使用的次数、本次新增或替换的权限、剩余次数，并逐步核算；不得把已使用的次数重复计入。",
  "如果没有官方直接 Q&A，可以综合卡片原文、FAQ、官方相关 Q&A、用户提供文本和其他资料进行独立规则分析。资料足以推导时输出 rule_analysis，不要仅因没有官方原题就拒绝回答。",
  "如果决定结论所必需的事实确实缺失或资料相互冲突，明确列入 missingInfo 并给出必要的条件分支；不得用常见场面、历史题目或猜测补齐，也不得虚构确定结论。输出前交叉核对 shortAnswer、reasoning、missingInfo 与各子问题结论，消除互相矛盾的前提、步骤和最终结论。",
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
    maxReferenceItems: readNumber(env.RAG_MAX_PROMPT_REFERENCE_ITEMS, 12),
    maxCardTextChars: readNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    maxPromptChars: readNumber(env.RAG_MAX_PROMPT_CHARS, 36000),
  };
  const authoritativeDirect = selectAuthoritativeOfficialDirectCandidate({
    candidates: evidence.officialQaDirectCandidates || [],
    cardResolution,
    baigeAmbiguousMentions: evidence.baigeAmbiguousMentions,
  });
  const focusCardIds = (cardResolution.resolvedCards || [])
    .map((card) => String(card?.id || card?.cardId || "").trim())
    .filter(Boolean);
  const evidencePayload = prepareEvidenceForPrompt(evidence, limits, warnings, {
    authoritativeDirectId: authoritativeDirect?.id || null,
    focusCardIds,
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
    const allowedEvidenceIds = [String(authoritativeDirect.id)];
    const ruleQueryPlanDiagnostics = buildRuleQueryPlanDiagnostics(evidence.ruleSearchQueries);
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
      allowedEvidenceIds,
      evidenceSelectionDiagnostics: buildEvidenceSelectionDiagnostics(
        evidencePayload,
        allowedEvidenceIds,
      ),
      ruleQueryPlanDiagnostics,
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
  const allowedEvidenceIds = extractPromptAllowedEvidenceIds(prompt, payload.allowedEvidenceIds);
  return {
    prompt,
    // Compatibility field only. Public generation is deliberately one-call,
    // so constructing a second model prompt here would be dead work and could
    // obscure the exact input used for evaluation.
    recoveryPrompt: "",
    modelEvidence: evidencePayload,
    allowedEvidenceIds,
    evidenceSelectionDiagnostics: buildEvidenceSelectionDiagnostics(
      evidencePayload,
      allowedEvidenceIds,
    ),
    ruleQueryPlanDiagnostics: buildRuleQueryPlanDiagnostics(evidence.ruleSearchQueries),
    warnings,
    promptChars: prompt.length,
    promptTruncated: warnings.some((warning) => warning.includes("truncated") || warning.includes("compacted")),
    authoritativeOfficialDirectId: null,
  };
}

function extractPromptAllowedEvidenceIds(prompt, fallback = []) {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const source = String(prompt || "");
  const candidates = [];
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex >= 0) candidates.push(source.slice(markerIndex + marker.length));
  const finalLine = source.slice(source.lastIndexOf("\n") + 1);
  if (finalLine) candidates.push(finalLine);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed?.allowedEvidenceIds)) continue;
      return [...new Set(parsed.allowedEvidenceIds
        .map((id) => String(id || "").trim())
        .filter(Boolean))];
    } catch {
      // Try the next complete JSON envelope. Never infer ids from prompt text.
    }
  }
  return [...new Set((fallback || []).map((id) => String(id || "").trim()).filter(Boolean))];
}

function buildRuleQueryPlanDiagnostics(ruleSearchQueries = []) {
  return (Array.isArray(ruleSearchQueries) ? ruleSearchQueries : [])
    .slice(0, 8)
    .map((item) => ({
      subclaim: String(item?.subclaim || "").replace(/\s+/gu, " ").trim().slice(0, 160),
      checkpoint: String(item?.checkpoint || "").trim(),
      confidence: String(item?.confidence || "").trim(),
      source: String(item?.source || "").trim(),
    }))
    .filter((item) => item.subclaim || item.checkpoint);
}

function buildEvidenceSelectionDiagnostics(evidencePayload = {}, allowedEvidenceIds = []) {
  const allowed = new Set((allowedEvidenceIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  const seen = new Set();
  const diagnostics = [];
  for (const bucket of EVIDENCE_BUCKET_ORDER) {
    for (const item of evidencePayload?.[bucket] || []) {
      const id = String(item?.id || "").trim();
      if (!id || !allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      const retrievalContext = item?.retrievalContext && typeof item.retrievalContext === "object"
        ? item.retrievalContext
        : {};
      diagnostics.push({
        id,
        type: String(item?.type || ""),
        bucket,
        sourceAuthority: String(item?.sourceAuthority || ""),
        isDirect: item?.isDirect === true,
        matchLevel: String(item?.matchLevel || ""),
        ...(retrievalContext.scope
          ? { retrievalScope: String(retrievalContext.scope) }
          : {}),
        ...(typeof retrievalContext.relatedOnly === "boolean"
          ? { relatedOnly: retrievalContext.relatedOnly }
          : {}),
        ...((item?.matchedBy || []).length
          ? { matchedBy: item.matchedBy.map((value) => String(value)).slice(0, 8) }
          : {}),
      });
    }
  }
  return diagnostics;
}

export function selectAuthoritativeOfficialDirectCandidate({
  candidates = [],
  cardResolution = {},
  baigeAmbiguousMentions = [],
} = {}) {
  if (candidates.length !== 1) return null;
  const [candidate] = candidates;
  if (candidate?.retrievalContext?.relatedOnly === true) return null;
  if ((candidate?.matchedBy || []).includes("multi_branch_related_evidence")) return null;
  const completeIdentity = !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length
    && !(baigeAmbiguousMentions || []).length;
  const hasStructuredQuestionIdentity = candidate?.questionCardIdCount > 0;
  const exactQuestionCardSet = hasStructuredQuestionIdentity
    ? candidate?.questionCardIdCoverage === 1
      && candidate?.questionCardIdCount === (candidate?.matchedQuestionCardIds || []).length
    : candidate?.relatedQuestionCardIdCoverage === 1
      && candidate?.relatedQuestionCardIdCount > 0
      && candidate?.relatedQuestionCardIdCount
        === (candidate?.matchedRelatedQuestionCardIds || []).length;
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
  const directSourceMetadata = promptSourceMetadata(directQa, "official_direct");
  const directFocusCardIds = cards.map((card) => String(card.id || "").trim()).filter(Boolean);
  const directQuestion = preserveEvidenceText(
    directQa.question || directQa.rawQuestion || "",
    Math.min(1200, Math.max(120, Math.floor(maxChars * 0.15))),
    directFocusCardIds,
  );
  const directDetailedScene = preserveEvidenceText(
    directQa.rawDetailedQuestion || directQa.detailedQuestion || "",
    Math.min(1800, Math.max(160, Math.floor(maxChars * 0.2))),
    directFocusCardIds,
  );
  const render = (lines, query, identities, text) => [
    ...lines,
    JSON.stringify({
      userQuery: query,
      resolvedCards: identities,
      officialQaDirectCandidate: {
        id: directQa.id,
        type: "official_qa",
        title: directQa.title || "",
        ...directSourceMetadata,
        question: directQuestion,
        detailedScene: directDetailedScene,
        answer: text,
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
  const renderCompact = (text) => render(
    compactInstructions,
    compactQuery,
    compactCards,
    text,
  );
  prompt = renderCompact(fitEvidenceTextToRenderedPrompt({
    sourceText,
    maxChars,
    renderWithText: renderCompact,
    minimumChars: 80,
  }));
  if (prompt.length > maxChars) {
    const minimal = ["完整转述给定唯一官方 Q&A；输出规定 JSON 并引用其 official_qa id。", arrayFields];
    const minimalQuery = preserveTextEnds(userQuery, 120);
    const renderMinimal = (text) => render(
      minimal,
      minimalQuery,
      [],
      text,
    );
    prompt = renderMinimal(fitEvidenceTextToRenderedPrompt({
      sourceText,
      maxChars,
      renderWithText: renderMinimal,
      minimumChars: 40,
    }));
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

function fitEvidenceTextToRenderedPrompt({
  sourceText,
  maxChars,
  renderWithText,
  minimumChars = 1,
} = {}) {
  const source = String(sourceText || "");
  if (!source) return "";
  const limit = Math.max(1, Number(maxChars) || 1);
  if (renderWithText(source).length <= limit) return source;

  // The excerpt is serialized twice in the compatibility envelope and JSON
  // escaping is content-dependent. Binary-search the actual rendered length
  // instead of estimating with a fixed divisor.
  let lower = 1;
  let upper = source.length;
  let best = "";
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = preserveTextEnds(source, middle);
    if (renderWithText(candidate).length <= limit) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best || preserveTextEnds(source, Math.min(
    source.length,
    Math.max(1, Number(minimumChars) || 1),
  ));
}

function prepareEvidenceForPrompt(
  evidence,
  limits,
  warnings,
  { authoritativeDirectId = null, focusCardIds = [] } = {},
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
  const prepared = {
    officialQaDirectCandidates: limitEvidence(focusedDirectCandidates, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_direct", warnings, focusCardIds),
    officialQaRelated: limitEvidence(relatedCandidates, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "official_related", warnings, focusCardIds),
    provisionalOfficialResponses: limitEvidence(evidence.provisionalOfficialResponses, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_response", warnings, focusCardIds),
    faqRelated: limitEvidence(evidence.faqRelated, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "faq", warnings, focusCardIds),
    // Resolved cards already carry the same complete effect text in the prompt.
    // Retain only additional card-text evidence whose identity is not already
    // represented there, avoiding a large duplicate copy for every card.
    cardTexts: limitEvidence(
      (evidence.cardTexts || []).filter((item) => !evidenceSharesFocusCard(item, focusCardIds)),
      limits.maxCards,
      limits.maxCardTextChars,
      "card_text",
      warnings,
      focusCardIds,
    ),
    userProvidedCardTexts: limitEvidence(evidence.userProvidedCardTexts, limits.maxCards, limits.maxCardTextChars, "user_text", warnings, focusCardIds),
    rawRelatedEvidence: limitEvidence(evidence.rawRelatedEvidence, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "raw_related", warnings, focusCardIds),
  };
  if (authoritativeDirectId) return prepared;
  return limitPreparedReferenceEvidence(prepared, limits.maxReferenceItems, warnings);
}

function evidenceSharesFocusCard(item = {}, focusCardIds = []) {
  if (!focusCardIds.length) return false;
  const focus = new Set(focusCardIds.map(String));
  return (item.cardIds || []).map(String).some((id) => focus.has(id));
}

function limitPreparedReferenceEvidence(prepared = {}, limit = 12, warnings = []) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 12));
  const referenceOnly = {
    ...prepared,
    cardTexts: [],
    userProvidedCardTexts: [],
  };
  const selected = selectCompactEvidenceEntries(referenceOnly, { limit: safeLimit });
  const result = {
    ...prepared,
    ...Object.fromEntries(
      OFFICIAL_REFERENCE_BUCKETS.concat("rawRelatedEvidence")
        .map((bucket) => [bucket, []]),
    ),
  };
  let before = 0;
  for (const bucket of OFFICIAL_REFERENCE_BUCKETS.concat("rawRelatedEvidence")) {
    before += (prepared[bucket] || []).length;
  }
  for (const { bucket, item } of selected) result[bucket].push(item);
  if (before > selected.length) {
    warnings.push(`prompt_reference_items_limited:${before}->${selected.length}`);
  }
  return result;
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

function limitEvidence(items = [], limit, textLimit, label, warnings, focusCardIds = []) {
  const source = Array.isArray(items) ? items : [];
  if (source.length > limit) warnings.push(`${label}_evidence_limited:${source.length}->${limit}`);
  return source.slice(0, limit).map((item) => {
    const sourceText = String(item.fullText || item.text || item.officialText || item.answer || "");
    const sourceMetadata = promptSourceMetadata(item, label);
    const structuredQa = buildStructuredOfficialQa(item, {
      textLimit,
      focusCardIds,
      label,
      warnings,
    });
    if (!structuredQa && sourceText.length > textLimit) {
      warnings.push(`${label}_text_truncated:${item.id}`);
    }
    const result = {
      id: item.id,
      type: item.type,
      title: item.title,
      ...sourceMetadata,
      sourceUrl: item.sourceUrl || "",
      isDirect: item.isDirect === true,
      matchLevel: item.matchLevel || "",
      retrievalContext: item.retrievalContext || {},
      cards: item.cards || [],
      cardIds: item.cardIds || [],
      ...((item.matchedBy || []).length ? { matchedBy: item.matchedBy } : {}),
      ...((item.matchedQuestionCardIds || []).length
        ? { matchedQuestionCardIds: item.matchedQuestionCardIds }
        : {}),
    };
    if (structuredQa) Object.assign(result, structuredQa);
    else result.text = preserveEvidenceText(sourceText, textLimit, focusCardIds);
    return result;
  });
}

function promptSourceMetadata(item = {}, label = "") {
  const recordType = String(item.recordType || inferPromptRecordType(item, label));
  const source = String(item.source || item.sourceName || item.sourceType || "");
  const declaredSourceAuthority = String(item.sourceAuthority || "").trim();
  const official = typeof item.official === "boolean"
    ? item.official
    : ["official_database", "official_reference"].includes(declaredSourceAuthority)
      ? true
      : declaredSourceAuthority
        ? false
        : isOfficialPromptEvidence(recordType, label);
  const sourceTier = String(item.sourceTier || inferPromptSourceTier({
    item,
    label,
    recordType,
    source,
    official,
  }));
  const sourceAuthority = declaredSourceAuthority || inferPromptSourceAuthority({
    item,
    label,
    recordType,
    source,
    sourceTier,
    official,
  });
  return {
    official,
    recordType,
    source,
    sourceTier,
    sourceAuthority,
  };
}

function inferPromptRecordType(item = {}, label = "") {
  if (["official_direct", "official_related", "official_response"].includes(label)) return "qa";
  if (label === "faq") return "card-faq";
  if (label === "card_text") return "card-text";
  if (label === "user_text") return "user-provided-card-text";
  if (String(item.type || "") === "rulebook") return "rule-doc";
  return String(item.type || "related");
}

function isOfficialPromptEvidence(recordType, label) {
  return ["qa", "card-faq", "official-database"].includes(recordType)
    || ["official_direct", "official_related", "official_response", "faq"].includes(label);
}

function inferPromptSourceTier({ label, recordType, source, official }) {
  if (recordType === "card-text" || label === "card_text") return "S1_CARD_TEXT";
  if (label === "user_text") return "USER_PROVIDED";
  if (recordType === "rule-doc" || /ocg[-_ ]?rule|community|社区|社群/iu.test(source)) return "S2_COMMUNITY_REFERENCE";
  if (!official) return "S3_OTHER_REFERENCE";
  if (["qa", "card-faq", "official-database"].includes(recordType)) return "S0_OFFICIAL_DB_MIRROR";
  if (label === "official_response") return "S0_OFFICIAL_RESPONSE";
  if (official) return "S0_OFFICIAL_REFERENCE";
  return "S3_OTHER_REFERENCE";
}

function inferPromptSourceAuthority({ label, recordType, source, sourceTier, official }) {
  if (recordType === "card-text" || label === "card_text") return "card_text_mirror";
  if (label === "user_text" || recordType === "user-provided-card-text") return "user_provided_text";
  if (recordType === "rule-doc" || /ocg[-_ ]?rule|community|社区|社群/iu.test(`${source} ${sourceTier}`)) {
    return "community_reference";
  }
  if (!official) return "other_reference";
  if (["qa", "card-faq", "official-database"].includes(recordType)
    || sourceTier === "S0_OFFICIAL_DB_MIRROR") {
    return "official_database";
  }
  if (label === "official_response" || /^S0_OFFICIAL/u.test(sourceTier) || official) {
    return "official_reference";
  }
  return "other_reference";
}

function buildStructuredOfficialQa(item = {}, {
  textLimit,
  focusCardIds,
  label,
  warnings,
} = {}) {
  const recordType = String(item.recordType || inferPromptRecordType(item, label));
  if (!["qa", "card-faq", "official-database"].includes(recordType)
    && !["official_direct", "official_related", "official_response", "faq"].includes(label)) {
    return null;
  }
  const question = String(item.question || item.rawQuestion || "").trim();
  const detailedScene = String(
    item.rawDetailedQuestion
      || item.detailedQuestion
      || (item.scenario && item.scenario !== question ? item.scenario : "")
      || "",
  ).trim();
  const answer = String(item.answer || item.officialAnswer || item.conclusion || "").trim();
  const fields = [
    { key: "question", value: question, weight: 0.28 },
    { key: "detailedScene", value: detailedScene, weight: 0.32 },
    { key: "answer", value: answer, weight: 0.4 },
  ].filter((field) => field.value);
  if (!fields.length) return null;

  const budgets = allocateStructuredTextBudgets(fields, textLimit);
  const result = {};
  let truncated = false;
  fields.forEach((field, index) => {
    const budget = budgets[index];
    if (field.value.length > budget) truncated = true;
    result[field.key] = preserveEvidenceText(field.value, budget, focusCardIds);
  });
  if (!answer) {
    const fallbackText = String(item.fullText || item.text || item.officialText || "");
    if (fallbackText) {
      const fallbackLimit = Math.max(1, Math.floor(Number(textLimit) * 0.4));
      if (fallbackText.length > fallbackLimit) truncated = true;
      result.text = preserveEvidenceText(fallbackText, fallbackLimit, focusCardIds);
    }
  }
  if (truncated) warnings.push(`${label}_text_truncated:${item.id}`);
  return result;
}

function allocateStructuredTextBudgets(fields, textLimit) {
  const available = Math.max(fields.length, Number(textLimit) || fields.length);
  const weightTotal = fields.reduce((sum, field) => sum + field.weight, 0) || fields.length;
  let remaining = available;
  return fields.map((field, index) => {
    if (index === fields.length - 1) return Math.max(1, remaining);
    const laterFields = fields.length - index - 1;
    const share = Math.max(1, Math.floor(available * (field.weight / weightTotal)));
    const budget = Math.min(share, Math.max(1, remaining - laterFields));
    remaining -= budget;
    return budget;
  });
}

function preserveEvidenceText(value, limit, focusCardIds = []) {
  const text = String(value || "");
  const max = Math.max(1, Number(limit) || 1);
  if (text.length <= max) return text;
  const matches = findFocusMatches(text, focusCardIds)
    .slice(0, Math.max(1, Math.min(4, Math.floor(max / 24))));
  if (!matches.length) return preserveTextEnds(text, max);

  // Secondary/minimal prompt compression can assign fewer than 48 characters
  // to one structured QA field. In that case, keeping the matching identity is
  // more useful than reverting to an ends-only excerpt that silently drops it.
  if (max < 24) return sliceAroundMatch(text, matches[0], max).slice(0, max);

  const separator = "\n…\n";
  const separatorCost = separator.length * (matches.length + 1);
  const available = max - separatorCost;
  if (available < matches.length + 2) return preserveTextEnds(text, max);
  const headLength = Math.max(1, Math.floor(available * 0.25));
  const tailLength = Math.max(1, Math.floor(available * 0.2));
  const focusTotal = Math.max(matches.length, available - headLength - tailLength);
  let remainingFocus = focusTotal;
  const focusSegments = matches.map((match, index) => {
    const remainingMatches = matches.length - index;
    const length = Math.max(1, Math.floor(remainingFocus / remainingMatches));
    remainingFocus -= length;
    return sliceAroundMatch(text, match, length);
  });
  return [
    text.slice(0, headLength),
    ...focusSegments,
    text.slice(-tailLength),
  ].join(separator);
}

function findFocusMatches(text, focusCardIds = []) {
  const matches = [];
  const seenPositions = new Set();
  for (const rawId of focusCardIds) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    const placeholder = `<<${id}>>`;
    let position = text.indexOf(placeholder);
    let length = placeholder.length;
    if (position < 0) {
      position = text.indexOf(id);
      length = id.length;
    }
    if (position < 0 || seenPositions.has(position)) continue;
    seenPositions.add(position);
    matches.push({ position, length });
  }
  return matches.sort((left, right) => left.position - right.position);
}

function sliceAroundMatch(text, match, limit) {
  const length = Math.max(match.length, Number(limit) || match.length);
  const before = Math.max(0, Math.floor((length - match.length) / 2));
  let start = Math.max(0, match.position - before);
  let end = Math.min(text.length, start + length);
  start = Math.max(0, end - length);
  return text.slice(start, end);
}

function buildCompactRagPrompt({ payload, maxPromptChars }) {
  const maxChars = Math.max(600, Number(maxPromptChars) || 12000);
  const evidenceLimit = maxChars >= 12000 ? 24 : maxChars >= 4000 ? 14 : 7;
  const textLimit = maxChars >= 12000 ? 900 : maxChars >= 4000 ? 360 : 140;
  const compactEvidence = Object.fromEntries(EVIDENCE_BUCKET_ORDER.map((bucket) => [bucket, []]));
  const focusCardIds = (payload.resolvedCards || [])
    .map((card) => String(card?.id || "").trim())
    .filter(Boolean);
  const prioritizedEntries = selectCompactEvidenceEntries(payload.evidence || {}, {
    resolvedCards: payload.resolvedCards || [],
    limit: evidenceLimit,
  });
  for (const { bucket, item } of prioritizedEntries) {
    compactEvidence[bucket].push(compactPromptEvidenceItem(item, textLimit, focusCardIds));
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

  const evidenceSummaries = selectCompactEvidenceEntries(compactEvidence, {
    resolvedCards: payload.resolvedCards || [],
    limit: 8,
  }).map(({ bucket, item }) => ({
      bucket,
      id: item.id,
      type: item.type,
      title: preserveTextEnds(item.title, 80),
      official: item.official === true,
      recordType: item.recordType || "",
      source: item.source || "",
      sourceTier: item.sourceTier || "",
      sourceAuthority: item.sourceAuthority || "other_reference",
      isDirect: item.isDirect === true,
      retrievalContext: item.retrievalContext || {},
      ...compactEvidenceTextFields(item, 100, focusCardIds),
    }));
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
    // The selector places the reserved cross-card official mechanism, FAQ and
    // scoped official QA first. Keep that minimum trio in the final envelope;
    // retaining one arbitrary item would erase distinct evidence roles.
    evidence: evidenceSummaries.slice(0, 3).map((item) => ({
      bucket: item.bucket,
      id: item.id,
      type: item.type,
      title: preserveTextEnds(item.title, 30),
      official: item.official === true,
      recordType: item.recordType || "",
      sourceAuthority: item.sourceAuthority || "other_reference",
      isDirect: item.isDirect === true,
      retrievalContext: item.retrievalContext || {},
      ...compactEvidenceTextFields(item, 40, focusCardIds),
    })),
    allowedEvidenceIds: evidenceSummaries.slice(0, 3)
      .map((item) => item.id)
      .filter(Boolean),
  };
  return [
    "仅依据下列完整 JSON 回答并输出规定 JSON；不得编造。",
    JSON.stringify(smallestPayload),
  ].join("\n");
}

function compactEvidencePriorityEntries(evidence = {}, { resolvedCards = [] } = {}) {
  const cardTextEntries = dedupeCompactCardTextEntries(
    interleavePromptBuckets(evidence, CARD_TEXT_BUCKETS),
    resolvedCards,
  );
  const officialEntries = interleavePromptBuckets(evidence, OFFICIAL_REFERENCE_BUCKETS);
  const rawEntries = (evidence.rawRelatedEvidence || []).map((item) => ({
    bucket: "rawRelatedEvidence",
    item,
  }));
  const officialRawEntries = rawEntries.filter(({ item }) => (
    item?.sourceAuthority === "official_database" || item?.sourceAuthority === "official_reference"
  ));
  const nonCommunityRawEntries = rawEntries.filter(({ item }) => (
    item?.sourceAuthority !== "official_database"
    && item?.sourceAuthority !== "official_reference"
    && item?.sourceAuthority !== "community_reference"
  ));
  const communityEntries = rawEntries.filter(({ item }) => item?.sourceAuthority === "community_reference");
  return [
    ...cardTextEntries,
    ...officialEntries,
    ...officialRawEntries,
    ...nonCommunityRawEntries,
    ...communityEntries,
  ];
}

function selectCompactEvidenceEntries(evidence = {}, {
  resolvedCards = [],
  limit = 1,
} = {}) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const candidates = compactEvidencePriorityEntries(evidence, { resolvedCards });
  const selected = [];
  const selectedKeys = new Set();
  const reserveFirst = (predicate) => {
    if (selected.length >= safeLimit) return;
    const entry = candidates.find((candidate) => (
      predicate(candidate) && !selectedKeys.has(compactEvidenceEntryKey(candidate))
    ));
    if (!entry) return;
    selected.push(entry);
    selectedKeys.add(compactEvidenceEntryKey(entry));
  };

  // Preserve one explicitly related-only cross-card official candidate when
  // available. It remains an analogy whose premises the final model must
  // compare; this reservation does not grant it direct-ruling authority.
  reserveFirst(isCrossCardOfficialMechanismEntry);
  // FAQ and official QA answer different questions. Give each an independent
  // floor before filling the remaining slots by the normal evidence ordering.
  reserveFirst(({ bucket }) => bucket === "faqRelated");
  reserveFirst((entry) => isOfficialQaEntry(entry) && !isCrossCardOfficialMechanismEntry(entry));

  for (const entry of candidates) {
    if (selected.length >= safeLimit) break;
    const key = compactEvidenceEntryKey(entry);
    if (selectedKeys.has(key)) continue;
    selected.push(entry);
    selectedKeys.add(key);
  }
  return selected;
}

function isCrossCardOfficialMechanismEntry({ item } = {}) {
  return item?.retrievalContext?.scope === "cross_card_official_mechanism"
    && item?.retrievalContext?.relatedOnly === true
    && item?.isDirect !== true
    && (item?.sourceAuthority === "official_database" || item?.official === true);
}

function isOfficialQaEntry({ bucket, item } = {}) {
  return [
    "officialQaDirectCandidates",
    "officialQaRelated",
    "provisionalOfficialResponses",
  ].includes(bucket)
    && (item?.sourceAuthority === "official_database"
      || item?.sourceAuthority === "official_reference"
      || item?.official === true);
}

function compactEvidenceEntryKey({ bucket, item } = {}) {
  const id = String(item?.id || "").trim();
  return id ? `id:${id}` : `${String(bucket || "")}:${compactCardTextFingerprint(item)}`;
}

function dedupeCompactCardTextEntries(entries = [], resolvedCards = []) {
  const seen = (resolvedCards || [])
    .map((card) => ({
      fingerprint: compactCardTextFingerprint({ text: card?.effectText || card?.text || "" }),
      identities: compactCardIdentityKeys(card),
    }))
    .filter((item) => item.fingerprint && item.identities.size);
  return entries.filter(({ item }) => {
    const fingerprint = compactCardTextFingerprint(item);
    if (!fingerprint) return true;
    const identities = compactCardIdentityKeys(item);
    const duplicate = identities.size && seen.some((previous) => (
      previous.fingerprint === fingerprint
      && setsIntersect(previous.identities, identities)
    ));
    if (duplicate) return false;
    if (identities.size) seen.push({ fingerprint, identities });
    return true;
  });
}

function compactCardIdentityKeys(item = {}) {
  const ids = [item?.id, item?.cardId, ...(item?.cardIds || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => `id:${value}`);
  const names = [
    item?.name,
    item?.cnName,
    item?.jaName,
    item?.enName,
    ...(item?.aliases || []),
    ...(item?.cards || []),
  ].map((value) => String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, "")
    .trim())
    .filter(Boolean)
    .map((value) => `name:${value}`);
  return new Set([...ids, ...names]);
}

function setsIntersect(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function compactCardTextFingerprint(item = {}) {
  return String(item?.text || item?.effectText || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .trim();
}

function interleavePromptBuckets(evidence, buckets) {
  const entries = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const bucket of buckets) {
      const item = evidence?.[bucket]?.[index];
      if (!item) continue;
      entries.push({ bucket, item });
      added = true;
    }
    if (!added) return entries;
  }
}

function compactPromptEvidenceItem(item = {}, textLimit, focusCardIds) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    official: item.official === true,
    recordType: item.recordType || "",
    source: item.source || "",
    sourceTier: item.sourceTier || "",
    sourceAuthority: item.sourceAuthority || "other_reference",
    retrievalContext: item.retrievalContext || {},
    ...compactEvidenceTextFields(item, textLimit, focusCardIds),
    sourceUrl: item.sourceUrl || "",
    isDirect: item.isDirect === true,
    matchLevel: item.matchLevel || "",
  };
}

function compactEvidenceTextFields(item = {}, textLimit, focusCardIds = []) {
  const structuredFields = [
    { key: "question", value: String(item.question || ""), weight: 0.28 },
    { key: "detailedScene", value: String(item.detailedScene || ""), weight: 0.32 },
    { key: "answer", value: String(item.answer || ""), weight: 0.4 },
  ].filter((field) => field.value);
  if (!structuredFields.length) {
    return { text: preserveEvidenceText(item.text, textLimit, focusCardIds) };
  }
  const budgets = allocateStructuredTextBudgets(structuredFields, textLimit);
  return Object.fromEntries(structuredFields.map((field, index) => [
    field.key,
    preserveEvidenceText(field.value, budgets[index], focusCardIds),
  ]));
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
