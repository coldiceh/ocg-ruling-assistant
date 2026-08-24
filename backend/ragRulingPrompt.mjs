import { evidenceBucketsToList } from "./ragEvidenceRetriever.mjs";
import { extractRelevantOfficialQaAnswerExcerpt } from "./officialQaAnswerExtractor.mjs";

export const RAG_ANSWER_LEVELS = Object.freeze([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
  "budget_limited",
]);

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

const PROMPT_SELECTION_METADATA = Symbol("promptSelectionMetadata");

const GENERIC_DECISION_CHECKLIST = Object.freeze([
  "activation_snapshot_legality_and_all_available_options",
  "resolution_snapshot_all_choice_directions_and_state_changes",
  "ordered_resolution_steps_dependencies_and_post_state",
  "effect_source_affected_entity_permissions_limits_and_remaining_attempts",
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
  "若同一效果在发动时要求存在可执行的后续选择，而处理途中状态又会改变，必须分别枚举发动时的全部合法选项与处理时最终能执行的全部选项。文本允许在多个实体、数值或方向之间选择时，必须逐一核对每个选择方向，不得只举一个可行例子。连续处理按卡文分句逐步执行：对每一步记录由哪个效果实际执行、是否完成以及完成后的状态，再检查下一步及其对前一步的依赖；不得仅因最终状态看似相同就认定原效果完成，也不得用尚未发生的后续状态倒推、省略发动条件，或在没有卡文或资料依据时因后一步失败而撤销已经完成的独立步骤。",
  "核对权限关系：允许、追加、禁止、免疫或替代分别授予或约束谁以及哪一种动作。检查不受影响或免疫时，必须同时核对效果的真实来源、效果类型和受影响实体；无论结果看似有利还是不利都使用同一检查，不得只凭结果倾向决定是否受影响。不能把只针对一种实体或动作的权限/限制扩张到另一种。",
  "遇到次数、攻击次数、追加权限或可再次执行次数，建立显式账本：初始权限、已经使用的次数、本次新增或替换的权限、剩余次数，并逐步核算；不得把已使用的次数重复计入。同一种动作同时受多个‘可以／再一次／最多N次’许可约束时，先依据原文和相关资料判断它们是分别设定上限、覆盖或明确追加；没有明确依据不得默认把许可次数相加。",
  "如果没有官方直接 Q&A，可以综合卡片原文、FAQ、官方相关 Q&A、用户提供文本和其他资料进行独立规则分析。资料足以推导时给出明确规则分析，不要仅因没有官方原题就拒绝回答。",
  "如果决定结论所必需的事实确实缺失或资料相互冲突，在正文中明确说明缺少什么并给出必要的条件分支；不得用常见场面、历史题目或猜测补齐，也不得虚构确定结论。输出前交叉核对结论、理由、缺失信息与各子问题，消除互相矛盾的前提、步骤和最终结论。",
  "decisionChecklist 是所有问题共用的内部自检维度，decisionPlan 是查询模型从本题生成的补充核对计划；两者都不是规则证据或预设答案。作答前仅在内部检查适用项，确认每个 subclaim/checkpoint 已由题面、卡文或所给资料处理；不要输出该检查过程，也不要因此编造缺失结论。",
  "不得根据卡名、题号、题型标签或历史答案套用预设结论。每次都从本次用户问题、原始卡文和本次证据重新推理。",
  "不得把 card_text、baige_card_text、user_provided_text、FAQ、rulebook、related evidence 或 rawRelatedEvidence 称为官方直接 Q&A。",
  "直接输出完整中文裁定正文，不要输出 JSON、代码围栏、字段名或程序状态。先明确回答全部子问题，再说明依据和处理过程。",
  "如需引用资料，只能引用 allowedEvidenceIds 中真实存在的 id 或对应标题；不得自造来源。",
  "存在不确定或资料不足时，在正文中直接说明具体缺口和条件分支，不要用格式化失败信息代替裁定。",
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
  const promptSafeEvidence = normalizePromptEvidenceSafety(evidence);
  const maxPromptChars = readNumber(env.RAG_MAX_PROMPT_CHARS, 36000);
  const hasReferenceCharLimit = Object.hasOwn(env, "RAG_MAX_PROMPT_REFERENCE_CHARS")
    && String(env.RAG_MAX_PROMPT_REFERENCE_CHARS || "").trim() !== "";
  const hasLegacyReferenceItemLimit = Object.hasOwn(env, "RAG_MAX_PROMPT_REFERENCE_ITEMS")
    && String(env.RAG_MAX_PROMPT_REFERENCE_ITEMS || "").trim() !== "";
  const limits = {
    maxCards: readNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readNumber(env.RAG_MAX_OFFICIAL_QA, 7),
    maxRelatedEvidence: readNumber(env.RAG_MAX_RELATED_EVIDENCE, 14),
    // The complete rendered prompt owns the ordinary production budget.  A
    // separate percentage of that budget can discard whole decisive records
    // even when the fixed prompt plus those records still fits.  Preserve only
    // an explicit compatibility override; otherwise the actual prompt fitter
    // measures the remaining capacity after the fixed envelope is rendered.
    maxReferenceChars: hasReferenceCharLimit
      ? readNumber(env.RAG_MAX_PROMPT_REFERENCE_CHARS, Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY,
    maxReferenceItems: hasLegacyReferenceItemLimit
      ? readNumber(env.RAG_MAX_PROMPT_REFERENCE_ITEMS, 64)
      : Number.POSITIVE_INFINITY,
    maxCardTextChars: readNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    maxPromptChars,
  };
  const authoritativeDirect = selectAuthoritativeOfficialDirectCandidate({
    candidates: promptSafeEvidence.officialQaDirectCandidates || [],
    cardResolution,
    baigeAmbiguousMentions: promptSafeEvidence.baigeAmbiguousMentions,
  });
  const focusCardIds = (cardResolution.resolvedCards || [])
    .map((card) => String(card?.id || card?.cardId || "").trim())
    .filter(Boolean);
  const evidencePayload = prepareEvidenceForPrompt(promptSafeEvidence, limits, warnings, {
    authoritativeDirectId: authoritativeDirect?.id || null,
    focusCardIds,
  });
  const ruleQueryPlanDiagnostics = buildRuleQueryPlanDiagnostics(promptSafeEvidence.ruleSearchQueries);
  const payload = {
    userQuery: String(userQuery || ""),
    resolvedCards: summarizeCards(cardResolution.resolvedCards || [], limits.maxCards),
    unresolvedMentions: cardResolution.unresolvedMentions || [],
    ambiguousMentions: cardResolution.ambiguousMentions || [],
    decisionChecklist: [...GENERIC_DECISION_CHECKLIST],
    decisionPlan: ruleQueryPlanDiagnostics.map(({ subclaim, checkpoint }) => ({
      subclaim,
      checkpoint,
    })),
    evidence: evidencePayload,
    allowedEvidenceIds: [...new Set(evidenceBucketsToList(evidencePayload)
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean))],
  };

  if (authoritativeDirect) {
    const allowedEvidenceIds = [String(authoritativeDirect.id)];
    warnings.push("official_direct_focused_prompt");
    const promptResult = buildOfficialDirectPrompt({
      userQuery: payload.userQuery,
      resolvedCards: payload.resolvedCards,
      decisionChecklist: payload.decisionChecklist,
      decisionPlan: payload.decisionPlan,
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

  let prompt = renderGeneralPrompt(restorePromptEvidenceBodies(payload));
  if (prompt.length > limits.maxPromptChars) {
    warnings.push("rag_prompt_compacted_to_max_chars");
    prompt = buildCompactRagPrompt({ payload, maxPromptChars: limits.maxPromptChars });
  }
  const allowedEvidenceIds = extractPromptAllowedEvidenceIds(prompt);
  appendSerializedEvidenceTruncationWarnings({
    prompt,
    evidencePayload,
    allowedEvidenceIds,
    warnings,
  });
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
    ruleQueryPlanDiagnostics,
    warnings,
    promptChars: prompt.length,
    // Repacking complete records into a smaller envelope is not itself text
    // truncation.  Per-record body loss is reported by
    // appendSerializedEvidenceTruncationWarnings; the frozen audit separately
    // verifies the complete user question, resolved card texts and required
    // evidence identities.
    promptTruncated: warnings.some((warning) => warning.includes("truncated")),
    authoritativeOfficialDirectId: null,
  };
}

export function extractPromptAllowedEvidenceIds(prompt) {
  const parsed = parseSerializedPromptPayload(prompt);
  if (!parsed
    || !Object.hasOwn(parsed, "evidence")
    || !Object.hasOwn(parsed, "allowedEvidenceIds")
    || !Array.isArray(parsed.allowedEvidenceIds)) return [];
  const actualIds = extractSerializedEvidenceIds(parsed.evidence);
  if (!actualIds) return [];
  const normalizedAllowed = parsed.allowedEvidenceIds
    .map((id) => String(id || "").trim());
  if (normalizedAllowed.some((id) => !id)) return [];
  const allowedIds = [...new Set(normalizedAllowed)];
  if (allowedIds.length !== normalizedAllowed.length
    || allowedIds.length !== actualIds.length
    || allowedIds.some((id) => !actualIds.includes(id))) return [];
  return allowedIds;
}

function parseSerializedPromptPayload(prompt) {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const source = String(prompt || "");
  const markerIndex = source.lastIndexOf(marker);
  const candidate = markerIndex >= 0
    ? source.slice(markerIndex + marker.length)
    : source.trimEnd().slice(source.trimEnd().lastIndexOf("\n") + 1);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A damaged ordinary envelope must not be replaced by a plausible tail.
    return null;
  }
}

function extractSerializedEvidenceIds(evidence) {
  const bucketValues = Array.isArray(evidence)
    ? [evidence]
    : evidence && typeof evidence === "object"
      ? Object.values(evidence)
      : null;
  if (!bucketValues || bucketValues.some((items) => !Array.isArray(items))) return null;
  const ids = [];
  for (const item of bucketValues.flat()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const id = String(item.id || "").trim();
    if (!id) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

function restorePromptEvidenceBodies(payload = {}) {
  const focusCardIds = (payload.resolvedCards || [])
    .map((card) => String(card?.id || "").trim())
    .filter(Boolean);
  const evidence = Object.fromEntries(EVIDENCE_BUCKET_ORDER.map((bucket) => [
    bucket,
    (payload.evidence?.[bucket] || []).map((item) => (
      restorePromptEvidenceBody(item, Number.POSITIVE_INFINITY, focusCardIds)
    )),
  ]));
  return { ...payload, evidence };
}

function appendSerializedEvidenceTruncationWarnings({
  prompt,
  evidencePayload = {},
  allowedEvidenceIds = [],
  warnings = [],
} = {}) {
  const parsed = parseSerializedPromptPayload(prompt);
  if (!parsed || typeof parsed !== "object") return;
  const allowed = new Set((allowedEvidenceIds || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
  const sourceById = new Map();
  for (const bucket of EVIDENCE_BUCKET_ORDER) {
    for (const item of evidencePayload?.[bucket] || []) {
      const id = String(item?.id || "").trim();
      if (id && !sourceById.has(id)) sourceById.set(id, item);
    }
  }
  for (const item of serializedPromptEvidenceItems(parsed)) {
    const id = String(item?.id || "").trim();
    if (!id || !allowed.has(id)) continue;
    const source = sourceById.get(id);
    if (!source || !serializedEvidenceBodyIsTruncated(source, item)) continue;
    const label = String(source?.[PROMPT_SELECTION_METADATA]?.warningLabel || "evidence");
    const warning = `${label}_text_truncated:${id}`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
}

function serializedPromptEvidenceItems(payload = {}) {
  if (Array.isArray(payload.evidence)) return payload.evidence;
  if (!payload.evidence || typeof payload.evidence !== "object") return [];
  return Object.values(payload.evidence).flatMap((items) => (
    Array.isArray(items) ? items : []
  ));
}

function serializedEvidenceBodyIsTruncated(sourceItem = {}, serializedItem = {}) {
  if (sourceItem?.retrievalContext?.textProvidedBy === "resolvedCards") return false;
  const source = promptEvidenceBodySource(sourceItem);
  const serialized = capturePromptEvidenceBody(serializedItem);
  const fields = ["question", "detailedScene", "answer"];
  if (evidenceTextAddsInformation(source.text, [
    source.question,
    source.detailedScene,
    source.answer,
  ])) fields.push("text");
  return fields.some((field) => source[field] && serialized[field].length < source[field].length);
}

function buildRuleQueryPlanDiagnostics(ruleSearchQueries = []) {
  const normalized = (Array.isArray(ruleSearchQueries) ? ruleSearchQueries : [])
    .map((item) => ({
      subclaim: String(item?.subclaim || "").replace(/\s+/gu, " ").trim().slice(0, 160),
      checkpoint: String(item?.checkpoint || "").trim(),
      confidence: String(item?.confidence || "").trim(),
      source: String(item?.source || "").trim(),
    }))
    .filter((item) => item.subclaim || item.checkpoint);
  const seen = new Set();
  return normalized.filter((item) => {
    const key = `${item.checkpoint}\u0000${item.subclaim}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
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
    "本次用户问题、卡片原文与检索资料如下：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function buildOfficialDirectPrompt({
  userQuery,
  resolvedCards = [],
  decisionChecklist = GENERIC_DECISION_CHECKLIST,
  decisionPlan = [],
  directQa = {},
  maxPromptChars,
} = {}) {
  const configuredMaxChars = Math.max(1, Number(maxPromptChars) || 12000);
  // A complete serialized envelope is mandatory. For unrealistically small
  // limits, exceeding the configured target is safer than slicing JSON or
  // dropping the official evidence identity.
  const maxChars = Math.max(600, configuredMaxChars);
  const instructions = [
    "你是游戏王 OCG 官方 Q&A 转述助手。检索器已经严格确认下面唯一的 officialQaDirectCandidate 对应用户完整问题。",
    "以该官方 Q&A 为裁定依据，完整回答用户的全部子问题；保留其中所有实质条件、例外、后续处理、次数和限制，不得添加原文没有说明的处理。",
    "decisionChecklist 和 decisionPlan 都不是证据；输出前仅在内部确认适用项均已由该官方 Q&A 处理，不要展示检查过程。",
    "resolvedCards 仅用于理解卡片身份和还原资料中的卡名占位符。",
    `正文中注明依据的官方 Q&A ID：${String(directQa.id || "")}。`,
    "直接输出完整中文裁定正文，不要输出 JSON、代码围栏或字段名。",
  ];
  const cards = resolvedCards.map((card) => ({ id: card.id, name: card.name, aliases: card.aliases || [] }));
  const sourceText = extractCompleteOfficialDirectAnswerText(directQa);
  const directSourceMetadata = promptSourceMetadata(directQa, "official_direct");
  const directFocusCardIds = cards.map((card) => String(card.id || "").trim()).filter(Boolean);
  const directQuestion = preserveEvidenceText(
    directQa.question || directQa.rawQuestion || "",
    Math.min(1200, Math.max(120, Math.floor(maxChars * 0.15))),
    directFocusCardIds,
  );
  const directDetailedScene = preserveEvidenceText(
    directQa.rawDetailedQuestion || directQa.detailedScene || directQa.detailedQuestion || "",
    Math.min(1800, Math.max(160, Math.floor(maxChars * 0.2))),
    directFocusCardIds,
  );
  const render = (lines, query, identities, text) => [
    ...lines,
    JSON.stringify({
      userQuery: query,
      resolvedCards: identities,
      decisionChecklist,
      decisionPlan,
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
    `直接输出完整中文正文，并注明官方 Q&A ID：${String(directQa.id || "")}。`,
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
    const minimal = ["完整转述给定唯一官方 Q&A；直接输出中文正文并注明其官方 Q&A ID。"];
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
      ["完整转述唯一官方 Q&A，直接输出中文正文并注明其官方 Q&A ID。"],
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

function extractCompleteOfficialDirectAnswerText(record = {}) {
  const structuredAnswer = extractRelevantOfficialQaAnswerExcerpt(record);
  const fullTextAnswer = extractRelevantOfficialQaAnswerExcerpt({
    ...record,
    answer: "",
    officialAnswer: "",
    conclusion: "",
  });
  return mergeComplementaryEvidenceText(structuredAnswer, fullTextAnswer);
}

function mergeComplementaryEvidenceText(primary, supplemental) {
  const primaryText = String(primary || "").trim();
  const supplementalText = String(supplemental || "").trim();
  if (!primaryText) return supplementalText;
  if (!supplementalText) return primaryText;
  const primaryKey = normalizeEvidenceComparisonText(primaryText);
  const supplementalKey = normalizeEvidenceComparisonText(supplementalText);
  if (supplementalKey.includes(primaryKey)) return supplementalText;
  if (primaryKey.includes(supplementalKey)) return primaryText;
  return `${primaryText}\n${supplementalText}`;
}

function normalizePromptEvidenceSafety(evidence = {}) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const relatedByIdentity = new Map();
  for (const bucket of EVIDENCE_BUCKET_ORDER) {
    for (const item of Array.isArray(source[bucket]) ? source[bucket] : []) {
      const id = String(item?.id || "").trim();
      if (!id) continue;
      const relatedOnly = promptEvidenceMustRemainRelated(item, bucket);
      relatedByIdentity.set(id, relatedByIdentity.get(id) === true || relatedOnly);
    }
  }
  return {
    ...source,
    ...Object.fromEntries(EVIDENCE_BUCKET_ORDER.map((bucket) => [
      bucket,
      (Array.isArray(source[bucket]) ? source[bucket] : []).map((item) => {
        const id = String(item?.id || "").trim();
        const relatedOnly = promptEvidenceMustRemainRelated(item, bucket)
          || (id && relatedByIdentity.get(id) === true);
        return relatedOnly ? forcePromptEvidenceRelatedOnly(item) : item;
      }),
    ])),
  };
}

function promptEvidenceMustRemainRelated(item = {}, bucket = "") {
  const scope = String(item?.retrievalContext?.scope || "");
  if (item?.retrievalContext?.relatedOnly === true || /cross[_ -]?card/iu.test(scope)) {
    return true;
  }
  if (bucket === "officialQaDirectCandidates") return false;
  return isOfficialQaOrFaqPromptItem(item);
}

function forcePromptEvidenceRelatedOnly(item = {}) {
  const matchLevel = item?.matchLevel === "official_qa_exact"
    ? "official_qa_near"
    : item?.matchLevel;
  return {
    ...item,
    type: item?.type === "official_qa" ? "related" : item?.type,
    isDirect: false,
    ...(matchLevel ? { matchLevel } : {}),
    retrievalContext: {
      ...(item?.retrievalContext || {}),
      relatedOnly: true,
    },
  };
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
  const relatedCandidates = [
    ...downgradedDirectCandidates,
    ...(Array.isArray(evidence.officialQaRelated) ? evidence.officialQaRelated : []),
  ];
  const prepared = {
    officialQaDirectCandidates: limitEvidence(focusedDirectCandidates, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_direct", warnings, focusCardIds),
    // Project every ordinary reference before applying the one shared reference
    // budget. Per-bucket slicing here would make a relevant item below the old
    // bucket cutoff impossible to recover in the unified selector.
    officialQaRelated: projectPromptEvidence(relatedCandidates, limits.maxEvidenceTextChars, "official_related", focusCardIds),
    provisionalOfficialResponses: projectPromptEvidence(evidence.provisionalOfficialResponses, limits.maxEvidenceTextChars, "official_response", focusCardIds),
    faqRelated: projectPromptEvidence(evidence.faqRelated, limits.maxEvidenceTextChars, "faq", focusCardIds),
    // Resolved cards already carry the complete effect text. Keep the evidence
    // identity so the final model can cite it, but omit only the duplicate text
    // body for cards already represented in resolvedCards.
    cardTexts: omitRepeatedResolvedCardText(limitEvidence(
      evidence.cardTexts,
      limits.maxCards,
      limits.maxCardTextChars,
      "card_text",
      warnings,
      focusCardIds,
    ), focusCardIds),
    userProvidedCardTexts: limitEvidence(evidence.userProvidedCardTexts, limits.maxCards, limits.maxCardTextChars, "user_text", warnings, focusCardIds),
    rawRelatedEvidence: projectPromptEvidence(evidence.rawRelatedEvidence, limits.maxEvidenceTextChars, "raw_related", focusCardIds),
  };
  if (authoritativeDirectId) return prepared;
  // Always pass through the identity-level selector so the same record cannot
  // reach the model twice through both a downgraded direct bucket and an
  // ordinary related bucket.  Infinite limits disable only the old budget;
  // they do not disable stable-ID deduplication.
  return limitPreparedReferenceEvidence(prepared, {
    maxChars: limits.maxReferenceChars,
    maxItems: limits.maxReferenceItems,
    focusCardIds,
  }, warnings);
}

function evidenceSharesFocusCard(item = {}, focusCardIds = []) {
  if (!focusCardIds.length) return false;
  const focus = new Set(focusCardIds.map(String));
  return (item.cardIds || []).map(String).some((id) => focus.has(id));
}

function omitRepeatedResolvedCardText(items = [], focusCardIds = []) {
  return (items || []).map((item) => evidenceSharesFocusCard(item, focusCardIds)
    ? {
        ...item,
        text: "",
        retrievalContext: {
          ...(item.retrievalContext || {}),
          textProvidedBy: "resolvedCards",
        },
      }
    : item);
}

function limitPreparedReferenceEvidence(prepared = {}, {
  maxChars = 16000,
  maxItems = Number.POSITIVE_INFINITY,
  focusCardIds = [],
} = {}, warnings = []) {
  const safeCharBudget = Math.max(1, Math.floor(Number(maxChars) || 16000));
  const requestedItemLimit = Number(maxItems);
  const safeItemLimit = Number.isFinite(requestedItemLimit)
    ? Math.max(1, Math.floor(requestedItemLimit || 1))
    : Number.MAX_SAFE_INTEGER;
  const referenceOnly = {
    ...prepared,
    cardTexts: [],
    userProvidedCardTexts: [],
  };
  // `selectCompactEvidenceEntries` already deduplicates stable evidence
  // identities. Do not infer equivalence from similar question or answer text:
  // distinct official records may deliberately document opposite outcomes.
  const ranked = selectCompactEvidenceEntries(referenceOnly, {
    limit: Number.POSITIVE_INFINITY,
  });
  const selected = [];
  let usedChars = 2;
  for (const entry of ranked) {
    if (selected.length >= safeItemLimit) break;
    // Charge the same complete body that the ordinary renderer restores, not
    // the earlier per-item projection. Otherwise a long decisive record looks
    // artificially cheap during preselection and forces a later prompt compact.
    const restoredItem = restorePromptEvidenceBody(
      entry.item,
      Number.POSITIVE_INFINITY,
      focusCardIds,
    );
    const serializedChars = JSON.stringify({ bucket: entry.bucket, ...restoredItem }).length
      + (selected.length ? 1 : 0);
    // Never replace the highest-priority reference with shorter lower-priority
    // material merely because it exceeds this preselection budget. The total
    // prompt compact/fitter owns the exceptional single-record case.
    if (selected.length > 0 && usedChars + serializedChars > safeCharBudget) continue;
    selected.push(entry);
    usedChars += serializedChars;
  }
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
  if (ranked.length > selected.length || usedChars > safeCharBudget) {
    warnings.push(`prompt_reference_chars_limited:${usedChars}/${safeCharBudget}:${ranked.length}->${selected.length}`);
  }
  if (Number.isFinite(requestedItemLimit) && ranked.length > safeItemLimit) {
    warnings.push(`prompt_reference_items_limited:${before}->${selected.length}`);
  }
  return result;
}

function downgradeOfficialDirectToRelated(item = {}) {
  return forcePromptEvidenceRelatedOnly({
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
  });
}

function limitEvidence(items = [], limit, textLimit, label, warnings, focusCardIds = []) {
  const source = Array.isArray(items) ? items : [];
  const bucket = promptBucketForLabel(label);
  const projected = projectPromptEvidence(source, textLimit, label, focusCardIds);
  const selected = selectPreferredEvidenceEntries(
    projected.map((item) => ({ bucket, item })),
    limit,
  ).map(({ item }) => item);
  if (projected.length > selected.length) {
    warnings.push(`${label}_evidence_limited:${projected.length}->${selected.length}`);
  }
  return selected;
}

function projectPromptEvidence(items = [], textLimit, label, focusCardIds = []) {
  const source = Array.isArray(items) ? items : [];
  return source.map((item, bucketIndex) => {
    const projectionWarnings = [];
    const sourceText = String(item.fullText || item.text || item.officialText || item.answer || "");
    const sourceMetadata = promptSourceMetadata(item, label);
    const structuredQa = buildStructuredOfficialQa(item, {
      textLimit,
      focusCardIds,
      label,
      warnings: projectionWarnings,
    });
    const result = {
      id: item.id,
      type: item.type,
      title: item.title,
      ...sourceMetadata,
      sourceUrl: item.sourceUrl || "",
      isDirect: item.isDirect === true,
      matchLevel: item.matchLevel || "",
      retrievalContext: promptRetrievalContext(item.retrievalContext),
      cards: item.cards || [],
      cardIds: item.cardIds || [],
      ...((item.matchedBy || []).length ? { matchedBy: item.matchedBy } : {}),
      ...((item.matchedQuestionCardIds || []).length
        ? { matchedQuestionCardIds: item.matchedQuestionCardIds }
        : {}),
    };
    if (structuredQa) Object.assign(result, structuredQa);
    else {
      if (sourceText.length > textLimit) projectionWarnings.push(`${label}_text_truncated:${item.id}`);
      result.text = preserveEvidenceText(sourceText, textLimit, focusCardIds);
    }
    const retrievalSignals = item?.retrievalSignals && typeof item.retrievalSignals === "object"
      ? item.retrievalSignals
      : {};
    const sourceBodyChars = canonicalEvidenceBodyChars(item);
    const projectedBodyChars = canonicalEvidenceBodyChars(result);
    result[PROMPT_SELECTION_METADATA] = {
      retrievalScore: normalizePromptRetrievalScore(item?.retrievalScore ?? item?.score),
      bucketRank: bucketIndex + 1,
      sourceBodyChars,
      projectedBodyChars,
      bodyCoverage: sourceBodyChars > 0 ? Math.min(1, projectedBodyChars / sourceBodyChars) : 0,
      bodyComplete: sourceBodyChars > 0 && projectedBodyChars >= sourceBodyChars,
      sourceBody: capturePromptEvidenceBody(item),
      warningLabel: label,
      projectionWarnings,
      strictQueryKeys: normalizePromptSelectionValues(
        [
          ...(retrievalSignals.strictRuleQueryKeys || []),
          ...(retrievalSignals.strictSupplementalRuleQueryKeys || []),
        ],
      ),
      strictSupplementalQueryKeys: normalizePromptSelectionValues(
        retrievalSignals.strictSupplementalRuleQueryKeys || [],
      ),
      mechanisms: normalizePromptSelectionValues(
        [
          ...(retrievalSignals.ruleQueryMechanisms || []),
          ...(retrievalSignals.supplementalRuleQueryMechanisms || []),
        ],
      ),
      modelPremise: String(
        retrievalSignals.modelCandidateAssessment?.premise
          || item?.retrievalContext?.modelCandidateAssessment?.premise
          || "",
      ).trim(),
      // Private selection signal only. It is derived entirely from the
      // official question/headline and the planner query, never the answer,
      // and the Symbol metadata is stripped from the serialized prompt.
      questionBranchHeadlineAnchored:
        retrievalSignals.questionBranchHeadlineAnchored === true,
    };
    return result;
  });
}

function promptBucketForLabel(label = "") {
  return ({
    official_direct: "officialQaDirectCandidates",
    official_related: "officialQaRelated",
    official_response: "provisionalOfficialResponses",
    faq: "faqRelated",
    card_text: "cardTexts",
    user_text: "userProvidedCardTexts",
    raw_related: "rawRelatedEvidence",
  })[label] || String(label || "rawRelatedEvidence");
}

function normalizePromptSelectionValues(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, 8);
}

function normalizePromptRetrievalScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function canonicalEvidenceBodyParts(item = {}) {
  const question = String(item?.question || item?.rawQuestion || "");
  const detailedScene = String(
    item?.rawDetailedQuestion
      || item?.detailedScene
      || item?.detailedQuestion
      || (item?.scenario && item.scenario !== question ? item.scenario : "")
      || "",
  );
  const answer = String(item?.answer || item?.officialAnswer || item?.conclusion || "");
  const fallbackText = String(item?.fullText || item?.text || item?.officialText || "");
  const structured = [question, detailedScene, answer].filter(Boolean);
  // Some official mirrors expose a short structured answer while keeping
  // decisive conditions or the complete answer only in text/fullText. Retain
  // that field whenever it contributes information beyond the structured
  // fields, but avoid paying twice for an exact duplicate.
  if (evidenceTextAddsInformation(fallbackText, structured)) structured.push(fallbackText);
  return structured.length ? structured : [fallbackText].filter(Boolean);
}

function evidenceTextAddsInformation(value, structuredParts = []) {
  const textKey = normalizeEvidenceComparisonText(value);
  if (!textKey) return false;
  const partKeys = (structuredParts || [])
    .map(normalizeEvidenceComparisonText)
    .filter(Boolean);
  if (!partKeys.length) return true;
  if (partKeys.some((part) => part.includes(textKey))) return false;

  // Mirrors commonly expose fullText as a mechanical concatenation of only a
  // subset of the structured fields (for example question + answer while a
  // separate detailedScene also exists). Match a finite permutation/subset of
  // those fields: each field may account for fallback text at most once, so an
  // extra repeated answer or any unmatched tail remains complementary.
  if (partKeys.length > 4) return true;
  const stateCount = 1 << partKeys.length;
  const offsets = new Uint32Array(stateCount);
  const reachableMasks = new Uint8Array(stateCount);
  reachableMasks[0] = 1;
  for (let mask = 1; mask < stateCount; mask += 1) {
    for (let index = 0; index < partKeys.length; index += 1) {
      if (mask & (1 << index)) offsets[mask] += partKeys[index].length;
    }
  }
  for (let mask = 0; mask < stateCount; mask += 1) {
    if (!reachableMasks[mask]) continue;
    const offset = offsets[mask];
    if (offset === textKey.length) return false;
    for (let index = 0; index < partKeys.length; index += 1) {
      const bit = 1 << index;
      if (mask & bit) continue;
      if (textKey.startsWith(partKeys[index], offset)) reachableMasks[mask | bit] = 1;
    }
  }
  return true;
}

function normalizeEvidenceComparisonText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .trim();
}

function canonicalEvidenceBodyChars(item = {}) {
  return canonicalEvidenceBodyParts(item).join("\n").length;
}

function capturePromptEvidenceBody(item = {}) {
  const question = String(item?.question || item?.rawQuestion || "");
  return Object.freeze({
    question,
    detailedScene: String(
      item?.rawDetailedQuestion
        || item?.detailedScene
        || item?.detailedQuestion
        || (item?.scenario && item.scenario !== question ? item.scenario : "")
        || "",
    ),
    answer: String(item?.answer || item?.officialAnswer || item?.conclusion || ""),
    text: String(item?.fullText || item?.text || item?.officialText || ""),
  });
}

function promptEvidenceBodySource(item = {}) {
  const sourceBody = item?.[PROMPT_SELECTION_METADATA]?.sourceBody;
  return sourceBody && typeof sourceBody === "object"
    ? sourceBody
    : capturePromptEvidenceBody(item);
}

function restorePromptEvidenceBody(item = {}, textLimit, focusCardIds = []) {
  if (item?.retrievalContext?.textProvidedBy === "resolvedCards") return { ...item };
  const result = { ...item };
  for (const key of ["question", "detailedScene", "answer", "text"]) delete result[key];
  return Object.assign(
    result,
    compactEvidenceTextFields(promptEvidenceBodySource(item), textLimit, focusCardIds),
  );
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
      || item.detailedScene
      || item.detailedQuestion
      || (item.scenario && item.scenario !== question ? item.scenario : "")
      || "",
  ).trim();
  const answer = String(item.answer || item.officialAnswer || item.conclusion || "").trim();
  const fallbackText = String(item.fullText || item.text || item.officialText || "").trim();
  const complementaryText = evidenceTextAddsInformation(fallbackText, [
    question,
    detailedScene,
    answer,
  ]) ? fallbackText : "";
  const fields = [
    { key: "question", value: question, weight: 0.28 },
    { key: "detailedScene", value: detailedScene, weight: 0.32 },
    { key: "answer", value: answer, weight: 0.4 },
    ...(complementaryText
      ? [{ key: "text", value: complementaryText, weight: 0.4 }]
      : []),
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
  if (truncated) warnings.push(`${label}_text_truncated:${item.id}`);
  return result;
}

function allocateStructuredTextBudgets(fields, textLimit) {
  if (!Number.isFinite(Number(textLimit))) {
    return fields.map((field) => Math.max(1, field.value.length));
  }
  const available = Math.max(fields.length, Math.floor(Number(textLimit) || fields.length));
  const lengths = fields.map((field) => Math.max(1, field.value.length));
  const budgets = fields.map(() => 1);
  let remaining = available - budgets.length;

  // Weighted water filling: once a short field reaches its actual length, its
  // unused share is redistributed among the still-truncated fields. This keeps
  // the general question/scene/answer weights without wasting most of the
  // budget when the question is short and the answer is long.
  while (remaining > 0) {
    const active = fields
      .map((field, index) => ({
        index,
        capacity: lengths[index] - budgets[index],
        weight: Math.max(0.0001, Number(field.weight) || 1),
      }))
      .filter(({ capacity }) => capacity > 0);
    if (!active.length) break;
    const weightTotal = active.reduce((sum, field) => sum + field.weight, 0);
    const roundRemaining = remaining;
    let spent = 0;
    for (const field of active) {
      const proportional = Math.floor(roundRemaining * (field.weight / weightTotal));
      const addition = Math.min(field.capacity, proportional, remaining - spent);
      if (addition <= 0) continue;
      budgets[field.index] += addition;
      spent += addition;
    }
    if (spent === 0) {
      const next = [...active].sort((left, right) => (
        right.weight - left.weight || left.index - right.index
      ))[0];
      budgets[next.index] += 1;
      spent = 1;
    }
    remaining -= spent;
  }
  return budgets;
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
  const focusCardIds = (payload.resolvedCards || [])
    .map((card) => String(card?.id || "").trim())
    .filter(Boolean);
  const prioritizedEntries = selectCompactEvidenceEntries(payload.evidence || {}, {
    resolvedCards: payload.resolvedCards || [],
    limit: Number.POSITIVE_INFINITY,
  });
  const variants = buildCompactPromptVariants(payload);
  let bestWholeAttempt = null;
  let emergencyWholeAttempt = null;
  let smallestBaseAttempt = null;
  for (const variant of variants) {
    const attempt = packWholeEvidenceEntries({
      entries: prioritizedEntries,
      variant,
      focusCardIds,
      maxChars,
    });
    if (attempt.prompt && (attempt.selectedCount > 0 || prioritizedEntries.length === 0)) {
      if (variant.emergencyOnly === true) {
        emergencyWholeAttempt = { attempt, variant };
      } else if (!bestWholeAttempt || attempt.selectedCount > bestWholeAttempt.attempt.selectedCount) {
        bestWholeAttempt = { attempt, variant };
      }
    }
    if (attempt.baseFits) smallestBaseAttempt = { attempt, variant };
  }
  if (bestWholeAttempt) return bestWholeAttempt.attempt.prompt;
  if (emergencyWholeAttempt) return emergencyWholeAttempt.attempt.prompt;

  // Whole high-priority records are tried under every complete envelope first.
  // Only a single top-ranked record that cannot fit even by itself is excerpted.
  const fallback = smallestBaseAttempt || {
    variant: variants.at(-1),
    attempt: { prompt: "", baseFits: false },
  };
  if (prioritizedEntries.length) {
    const fitted = fitSingleEvidenceEntry({
      entry: prioritizedEntries[0],
      variant: fallback.variant,
      focusCardIds,
      maxChars,
    });
    if (fitted) return fitted;
  }
  if (fallback.attempt.prompt) return fallback.attempt.prompt;
  return fallback.variant.render(buildPackedPromptPayload(fallback.variant.basePayload, [], fallback.variant.mode));
}

function buildCompactPromptVariants(payload = {}) {
  const emptyEvidence = Object.fromEntries(EVIDENCE_BUCKET_ORDER.map((bucket) => [bucket, []]));
  return [{
    mode: "buckets",
    basePayload: {
      ...payload,
      evidence: emptyEvidence,
      allowedEvidenceIds: [],
    },
    render: renderGeneralPrompt,
  }, {
    mode: "array",
    basePayload: {
      userQuery: String(payload.userQuery || ""),
      resolvedCards: (payload.resolvedCards || []).map((card) => ({
        ...card,
        effectText: String(card.effectText || ""),
      })),
      unresolvedMentions: (payload.unresolvedMentions || []).slice(0, 8),
      ambiguousMentions: (payload.ambiguousMentions || []).slice(0, 8),
      decisionChecklist: (payload.decisionChecklist || []).slice(0, 4),
      decisionPlan: (payload.decisionPlan || []).slice(0, 8),
      evidence: [],
      allowedEvidenceIds: [],
    },
    render: (compactPayload) => [
      "仅依据用户问题、卡片原文和所给资料，逐个子问题推理；不得编造。先在内部逐项核对 decisionChecklist 和 decisionPlan，但不得把它们当证据或输出检查过程。只有完整对应本题的 official direct Q&A 才能称为官方直接裁定，相关资料与卡文只能支持分析。",
      "直接输出完整中文裁定正文，不要 JSON、代码围栏或字段名；引用资料时只能使用 allowedEvidenceIds 中真实存在的 id。",
      JSON.stringify(compactPayload),
    ].join("\n"),
  }, {
    mode: "array",
    emergencyOnly: true,
    basePayload: {
      userQuery: preserveTextEnds(payload.userQuery, 80),
      resolvedCards: (payload.resolvedCards || []).slice(0, 1).map((card) => ({
        id: card.id,
        name: preserveTextEnds(card.name, 40),
        effectText: preserveTextEnds(card.effectText, 60),
      })),
      unresolvedMentions: [],
      ambiguousMentions: [],
      decisionChecklist: (payload.decisionChecklist || []).slice(0, 4),
      decisionPlan: (payload.decisionPlan || []).slice(0, 2),
      evidence: [],
      allowedEvidenceIds: [],
    },
    render: (smallestPayload) => [
      "仅依据下列资料直接输出完整中文裁定正文；不要输出 JSON 或字段名。先在内部逐项核对 decisionPlan，不得把它当证据或展示检查过程；引用资料时只能使用 allowedEvidenceIds 中真实存在的 id；不得编造。",
      JSON.stringify(smallestPayload),
    ].join("\n"),
  }];
}

function packWholeEvidenceEntries({ entries, variant, focusCardIds, maxChars }) {
  const fullEntries = entries.map(({ bucket, item }) => ({
    bucket,
    item: compactPromptEvidenceItem(item, Number.POSITIVE_INFINITY, focusCardIds),
  }));
  const emptyPrompt = variant.render(buildPackedPromptPayload(
    variant.basePayload,
    [],
    variant.mode,
  ));
  if (emptyPrompt.length > maxChars) {
    return { prompt: "", selectedCount: 0, baseFits: false };
  }

  let lower = 1;
  let upper = fullEntries.length;
  let bestPrompt = emptyPrompt;
  let bestCount = 0;
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2);
    const prompt = variant.render(buildPackedPromptPayload(
      variant.basePayload,
      fullEntries.slice(0, count),
      variant.mode,
    ));
    if (prompt.length <= maxChars) {
      bestPrompt = prompt;
      bestCount = count;
      lower = count + 1;
    } else {
      upper = count - 1;
    }
  }
  return {
    prompt: bestPrompt,
    selectedCount: bestCount,
    baseFits: true,
  };
}

function buildPackedPromptPayload(basePayload = {}, entries = [], mode = "buckets") {
  const ids = [...new Set(entries
    .map(({ item }) => String(item?.id || "").trim())
    .filter(Boolean))];
  if (mode === "array") {
    return {
      ...basePayload,
      evidence: entries.map(({ bucket, item }) => ({ bucket, ...item })),
      allowedEvidenceIds: ids,
    };
  }
  const evidence = Object.fromEntries(EVIDENCE_BUCKET_ORDER.map((bucket) => [bucket, []]));
  for (const { bucket, item } of entries) {
    if (!evidence[bucket]) evidence[bucket] = [];
    evidence[bucket].push(item);
  }
  return { ...basePayload, evidence, allowedEvidenceIds: ids };
}

function fitSingleEvidenceEntry({ entry, variant, focusCardIds, maxChars }) {
  const sourceChars = Math.max(
    1,
    Number(entry?.item?.[PROMPT_SELECTION_METADATA]?.sourceBodyChars)
      || canonicalEvidenceBodyChars(promptEvidenceBodySource(entry?.item)),
  );
  let lower = 1;
  let upper = sourceChars;
  let best = "";
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const projected = compactPromptEvidenceItem(entry.item, middle, focusCardIds);
    const prompt = variant.render(buildPackedPromptPayload(
      variant.basePayload,
      [{ bucket: entry.bucket, item: projected }],
      variant.mode,
    ));
    if (prompt.length <= maxChars) {
      best = prompt;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best;
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
  return selectPreferredEvidenceEntries(
    compactEvidencePriorityEntries(evidence, { resolvedCards }),
    limit,
  );
}

function selectPreferredEvidenceEntries(entries = [], limit = 1) {
  const requestedLimit = Number(limit);
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.floor(requestedLimit || 1))
    : Number.MAX_SAFE_INTEGER;
  const preferredByIdentity = new Map();
  const entriesByIdentity = new Map();
  for (const entry of entries) {
    const key = compactEvidenceEntryKey(entry);
    const identityEntries = entriesByIdentity.get(key) || [];
    identityEntries.push(entry);
    entriesByIdentity.set(key, identityEntries);
    const previous = preferredByIdentity.get(key);
    if (!previous || compareEvidenceProjection(entry, previous) < 0) {
      preferredByIdentity.set(key, entry);
    }
  }
  return [...preferredByIdentity.entries()]
    .map(([key, entry]) => mergePromptIdentitySafety(entry, entriesByIdentity.get(key)))
    .sort(compareEvidenceSelectionPriority)
    .slice(0, safeLimit);
}

function mergePromptIdentitySafety(preferred = {}, identityEntries = []) {
  const relatedEntries = (identityEntries || []).filter(({ item }) => (
    item?.retrievalContext?.relatedOnly === true
  ));
  if (!relatedEntries.length) return preferred;
  const crossCardScope = relatedEntries
    .map(({ item }) => String(item?.retrievalContext?.scope || ""))
    .find((scope) => /cross[_ -]?card/iu.test(scope));
  return {
    ...preferred,
    item: forcePromptEvidenceRelatedOnly({
      ...preferred.item,
      retrievalContext: {
        ...(preferred.item?.retrievalContext || {}),
        ...(crossCardScope ? { scope: crossCardScope } : {}),
        relatedOnly: true,
      },
    }),
  };
}

function compareEvidenceProjection(left = {}, right = {}) {
  const leftMetadata = left?.item?.[PROMPT_SELECTION_METADATA] || {};
  const rightMetadata = right?.item?.[PROMPT_SELECTION_METADATA] || {};
  return Number(rightMetadata.projectedBodyChars || 0) - Number(leftMetadata.projectedBodyChars || 0)
    || Number(rightMetadata.bodyCoverage || 0) - Number(leftMetadata.bodyCoverage || 0)
    || Number(rightMetadata.bodyComplete === true) - Number(leftMetadata.bodyComplete === true)
    || compareEvidenceSelectionPriority(left, right)
    || evidenceProjectionStableKey(left).localeCompare(evidenceProjectionStableKey(right));
}

function compareEvidenceSelectionPriority(left = {}, right = {}) {
  const leftMetadata = left?.item?.[PROMPT_SELECTION_METADATA] || {};
  const rightMetadata = right?.item?.[PROMPT_SELECTION_METADATA] || {};
  return evidenceFactLayerRank(right) - evidenceFactLayerRank(left)
    || Number(rightMetadata.questionBranchHeadlineAnchored === true)
      - Number(leftMetadata.questionBranchHeadlineAnchored === true)
    || Number(rightMetadata.retrievalScore || 0) - Number(leftMetadata.retrievalScore || 0)
    || evidenceAuthorityRank(right?.item) - evidenceAuthorityRank(left?.item)
    || Number(rightMetadata.projectedBodyChars || 0) - Number(leftMetadata.projectedBodyChars || 0)
    || Number(rightMetadata.bodyCoverage || 0) - Number(leftMetadata.bodyCoverage || 0)
    || Number(rightMetadata.bodyComplete === true) - Number(leftMetadata.bodyComplete === true)
    || compactEvidenceEntryKey(left).localeCompare(compactEvidenceEntryKey(right));
}

function isOfficialQaOrFaqPromptItem(item = {}) {
  return ["qa", "card-faq", "official-database"].includes(String(item?.recordType || ""))
    && (
      item?.official === true
      || ["official_database", "official_reference"].includes(item?.sourceAuthority)
      || /official|yugioh.*database|konami/iu.test(String(item?.source || ""))
    );
}

function evidenceProjectionStableKey({ bucket, item } = {}) {
  return [
    String(bucket || ""),
    String(item?.recordType || ""),
    String(item?.title || ""),
    ...canonicalEvidenceBodyParts(item),
  ].join("\u0000");
}

function evidenceFactLayerRank({ bucket } = {}) {
  return CARD_TEXT_BUCKETS.includes(bucket) ? 2 : 1;
}

function evidenceAuthorityRank(item = {}) {
  if (item?.sourceAuthority === "official_database") return 4;
  if (["official_reference", "card_text_mirror"].includes(item?.sourceAuthority) || item?.official === true) return 3;
  if (item?.sourceAuthority === "user_provided_text") return 2;
  if (item?.sourceAuthority === "community_reference") return 1;
  return 0;
}

function promptRetrievalContext(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...(source.scope ? { scope: String(source.scope) } : {}),
    ...(typeof source.relatedOnly === "boolean" ? { relatedOnly: source.relatedOnly } : {}),
    ...(source.textProvidedBy ? { textProvidedBy: String(source.textProvidedBy) } : {}),
  };
}

function compactEvidenceEntryKey({ bucket, item } = {}) {
  const id = String(item?.id || "").trim();
  if (id) return `id:${id}`;
  const bodyFingerprint = compactCardTextFingerprint(item)
    || canonicalEvidenceBodyParts(item)
      .join("\n")
      .normalize("NFKC")
      .replace(/\s+/gu, "")
      .trim();
  return `${String(bucket || "")}:${bodyFingerprint || evidenceProjectionStableKey({ bucket, item })}`;
}

function dedupeCompactCardTextEntries(entries = [], resolvedCards = []) {
  const seen = (resolvedCards || [])
    .map((card) => ({
      fingerprint: compactCardTextFingerprint({ text: card?.effectText || card?.text || "" }),
      identities: compactCardIdentityKeys(card),
    }))
    .filter((item) => item.fingerprint && item.identities.size);
  return [...entries].sort(compareEvidenceSelectionPriority).filter(({ item }) => {
    const fingerprint = compactCardTextFingerprint(item);
    if (!fingerprint && item?.retrievalContext?.textProvidedBy === "resolvedCards") {
      return false;
    }
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
  const result = {
    id: item.id,
    type: item.type,
    title: item.title,
    official: item.official === true,
    recordType: item.recordType || "",
    source: item.source || "",
    sourceTier: item.sourceTier || "",
    sourceAuthority: item.sourceAuthority || "other_reference",
    retrievalContext: promptRetrievalContext(item.retrievalContext),
    ...compactEvidenceTextFields(promptEvidenceBodySource(item), textLimit, focusCardIds),
    sourceUrl: item.sourceUrl || "",
    isDirect: item.isDirect === true,
    matchLevel: item.matchLevel || "",
  };
  const previousMetadata = item?.[PROMPT_SELECTION_METADATA] || {};
  const sourceBodyChars = Number(previousMetadata.sourceBodyChars)
    || canonicalEvidenceBodyChars(item);
  const projectedBodyChars = canonicalEvidenceBodyChars(result);
  result[PROMPT_SELECTION_METADATA] = {
    ...previousMetadata,
    sourceBodyChars,
    projectedBodyChars,
    bodyCoverage: sourceBodyChars > 0 ? Math.min(1, projectedBodyChars / sourceBodyChars) : 0,
    bodyComplete: sourceBodyChars > 0 && projectedBodyChars >= sourceBodyChars,
    strictQueryKeys: previousMetadata.strictQueryKeys || [],
    strictSupplementalQueryKeys: previousMetadata.strictSupplementalQueryKeys || [],
    mechanisms: previousMetadata.mechanisms || [],
    modelPremise: previousMetadata.modelPremise || "",
    questionBranchHeadlineAnchored:
      previousMetadata.questionBranchHeadlineAnchored === true,
  };
  return result;
}

function compactEvidenceTextFields(item = {}, textLimit, focusCardIds = []) {
  const question = String(item.question || "");
  const detailedScene = String(item.detailedScene || "");
  const answer = String(item.answer || "");
  const fallbackText = String(item.text || "");
  const complementaryText = evidenceTextAddsInformation(fallbackText, [
    question,
    detailedScene,
    answer,
  ]) ? fallbackText : "";
  const structuredFields = [
    { key: "question", value: question, weight: 0.28 },
    { key: "detailedScene", value: detailedScene, weight: 0.32 },
    { key: "answer", value: answer, weight: 0.4 },
    ...(complementaryText
      ? [{ key: "text", value: complementaryText, weight: 0.4 }]
      : []),
  ].filter((field) => field.value);
  if (!structuredFields.length) {
    return { text: preserveEvidenceText(fallbackText, textLimit, focusCardIds) };
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
