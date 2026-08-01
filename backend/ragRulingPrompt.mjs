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
    maxOfficialQa: readNumber(env.RAG_MAX_OFFICIAL_QA, 7),
    maxRelatedEvidence: readNumber(env.RAG_MAX_RELATED_EVIDENCE, 14),
    maxCardTextChars: readNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    maxPromptChars: readNumber(env.RAG_MAX_PROMPT_CHARS, 60000),
  };
  const evidencePayload = prepareEvidenceForPrompt(evidence, promptLimits, warnings);
  const payload = {
    userQuery: String(userQuery || ""),
    resolvedCards: summarizeCards(cardResolution.resolvedCards || [], promptLimits.maxCards),
    unresolvedMentions: cardResolution.unresolvedMentions || [],
    ambiguousMentions: cardResolution.ambiguousMentions || [],
    ruleSearchQueries: evidence.ruleSearchQueries || [],
    operationChecks: summarizeOperationChecks(evidence.operationLegality?.checks || []),
    constraintAudit: summarizeConstraintAudit(evidence.operationLegality),
    semanticStateTransition: summarizeSemanticStateTransition(evidence.semanticStateTransition),
    formalEngineStatus: evidence.formalEngineStatus || { mode: "off", status: "disabled" },
    evidence: {
      ...evidencePayload,
      retrievalWarnings: [...(evidence.retrievalWarnings || []), ...warnings],
    },
  };
  const rawDirectCandidates = evidence.officialQaDirectCandidates || [];
  const authoritativeDirect = selectAuthoritativeOfficialDirectCandidate({
    candidates: rawDirectCandidates,
    cardResolution,
    baigeAmbiguousMentions: evidence.baigeAmbiguousMentions,
  });
  if (authoritativeDirect && !(evidence.formalEngineProofs || []).length) {
    warnings.push("official_direct_focused_prompt");
    const promptResult = buildOfficialDirectPrompt({
      userQuery: payload.userQuery,
      resolvedCards: payload.resolvedCards,
      directQa: authoritativeDirect,
      maxPromptChars: promptLimits.maxPromptChars,
    });
    const recoveryResult = buildOfficialDirectPrompt({
      userQuery: payload.userQuery,
      resolvedCards: payload.resolvedCards,
      directQa: authoritativeDirect,
      maxPromptChars: readNumber(env.RAG_RECOVERY_PROMPT_CHARS, 12000),
    });
    if (promptResult.truncated) warnings.push("official_direct_prompt_truncated");
    return {
      prompt: promptResult.prompt,
      recoveryPrompt: recoveryResult.prompt,
      warnings,
      promptChars: promptResult.prompt.length,
      promptTruncated: promptResult.truncated,
    };
  }

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
  const recoveryPrompt = buildCompactRagPrompt({
    payload,
    maxPromptChars: readNumber(env.RAG_RECOVERY_PROMPT_CHARS, 12000),
  });

  let prompt = [
    "你是游戏王 OCG 规则分析助手。你要基于检索到的资料生成 RAG 裁定分析。",
    "资料来源包括：官方 Q&A、未在官方数据库确认的事务局回答截图、FAQ、卡片文本、百鸽卡片资料、用户提供卡片文本，以及其他相关资料。",
    "优先根据官方 Q&A direct candidates 回答；只有 officialQaDirectCandidates 中的资料可以支持 official_confirmed。",
    "资料来源必须区分：official_direct_qa、official_related_qa、official_response_screenshot、faq_related、card_text、baige_card_text、user_provided_text、rulebook、raw_related。",
    "provisionalOfficialResponses 是可追溯到事务局回答截图、但尚未在官方数据库找到 direct Q&A 的案例。它可以约束同场景的规则分析，但只能输出 rule_analysis，必须保留 provisional_official_response 风险标记，不得升级为 official_confirmed。",
    "user_provided_text 是用户在问题中粘贴的卡片文本，不是官方 direct evidence；可以基于这些文本分析，但不得称为官方确认。",
    "百鸽卡片资料和普通卡片文本可以作为卡片文本 grounding，但不是官方 direct Q&A。",
    "如果没有官方直接 Q&A，允许根据卡片文本、百鸽卡片资料、用户提供文本、FAQ、官方相似案例和 rulebook 规则书资料进行分析。",
    "ruleSearchQueries 是后端为检索规则资料生成的查询词，只能作为检索线索；最终理由必须基于 evidence 中真实存在的资料、卡片文本和题目事实。",
    "resolvedCards 是本地资料或百鸽已经匹配成功的卡片；其中已有 cardType、attribute 或效果文本时，不得再把该卡写成‘未识别’或‘属性未确定’。只有 unresolvedMentions 中仍存在的项目才算未解析。",
    "operationChecks 是 Flash 证据判读模型对题目每一步操作所做的检查；候选依据可以是规则书、官方 Q&A 或卡片 FAQ。后端已经校验其中引用的 evidence id 和逐字引文，未通过校验的 legal/illegal/conditional 会被降为 unknown。",
    "对同一操作，operationChecks 中 citations 非空的 illegal 结论是强约束。legal 或 conditional 只有在 constraintAudit.hasUnresolvedConstraints=false 时才能作为强约束；status=unknown 不能作为肯定或否定依据。",
    "constraintAudit 列出后端优先核对的限制性规则。hasUnresolvedConstraints=true 时，不得回答‘可以发动/可以进行’；必须继续依据列出的规则核对，无法完成时只能给保守的不确定结论。",
    "hasUnresolvedConstraints=true 表示前置判读没有完成，不表示规则不适用。此时必须直接阅读 unresolvedConstraints.text，逐项比较规则条件与题目事实；若题目已明确满足阻断条件，应据此回答不能发动或不能进行，只有缺少必要事实时才保留不确定。",
    "operationChecks、constraintAudit 和 semanticStateTransition 只属于证据整理或旧诊断信息，不是裁定证明；不得仅凭它们翻转官方资料、补造事实或签发最终结论。最终推理必须重新核对其逐字引文、卡文与题面事实。",
    "formalEngineProofs 来自版本协商、能力检查、完整执行检查和独立证明校验后的声明式规则内核。trusted=true 且 verdict=TRUE/FALSE 的逐查询结论是强约束，模型只能解释，不能翻转；verdict=UNKNOWN 只表示未获证明，绝不等于 FALSE，也不能单独支持‘不能’。",
    "分析任何操作时使用同一套通用执行顺序：从卡文和题面建立带来源的初始状态；分别检查手续或发动前提；执行手续、cost 与每个效果步骤并记录实际移动及归因；每次状态变化后重算持续效果；在检查点收集诱发候选并保留对方响应分支。禁止根据卡名、FAQ 编号、题面暗示答案或历史错题模板补造缺失事实。",
    "较早步骤已经不合法时，结论应直接说明实际阻断原因，不要继续描述未发生的后续处理，也不要添加与当前场景无关的假设分支。",
    "相关 Q&A / FAQ 可以作为规则适用案例，但必须比较卡片、效果、时点、位置、素材数量和处理顺序；不是当前原题时不得升级为 official_confirmed。",
    "rawRelatedEvidence 中 source=rulebook_model_grounding 或 qa_rule_model_grounding 的资料是校验后的逐操作检查，不是官方 direct Q&A；其引文对应的原始证据也会作为独立 evidence 提供。",
    "对每个子问题建立独立的前提清单、操作序列、状态快照和结论；任何前提没有题面 sourceSpan、卡文定义或可验证证据时，必须保留为 UNKNOWN/条件分支，不得用常见场面补齐。",
    "只要有卡片文本 grounding，优先输出 rule_analysis；不要因为没有 template、没有 validator、没有官方 direct Q&A 就输出 needs_more_info。",
    "所有条件、对象、位置、表示形式、次数、玩家、时点、移动目的地、移动归因和响应权都必须来自题面、已绑定卡文、可验证证据或形式证明；不得自行补造。",
    "题目已经明确当前时点或卡片当前位置时，不要补充与该场景无关的假设分支；只在缺少关键事实时才列 missingInfo。",
    "即使仍有卡名未解析，只要题目已经明确描述了要判断的通用操作，且规则书或 FAQ 直接覆盖该操作，就应先回答这部分规则结论；不要仅因卡名未匹配而把整个问题降为无法判断。",
    "如果缺少判断发动合法性所需的关键事实，应输出 low_confidence_analysis 或 needs_more_info，并在 missingInfo 里列出缺失事实。",
    "只有部分资料、卡文不足或场景关键事实缺失时，输出 low_confidence_analysis，并给出当前倾向、缺失信息和风险。",
    "没有 official direct 时，answerLevel 只能是 rule_analysis、low_confidence_analysis 或 needs_more_info。",
    "如果用户提供文本足够完整，不要仅因为本地数据库找不到该卡或缺少 official direct Q&A 就输出 needs_more_info。",
    "如果至少存在卡片文本、用户提供文本、FAQ、官方相似案例或相关资料，不要只回答 needs_more_info；应输出 rule_analysis 或 low_confidence_analysis，并明确不是官方确认。",
    "只有在完全没有可用卡片文本、相关资料，或问题缺少关键场景导致无法分析时，才输出 needs_more_info。",
    "信息不足时也不要只写“无法判断”；必须给出当前倾向、missingInfo 和 riskFlags。",
    "必须区分 answerLevel：official_confirmed、rule_analysis、low_confidence_analysis、needs_more_info。budget_limited 只由后端预算守卫使用，模型不要主动输出。",
    "不得把 card_text、baige_card_text、user_provided_text、rulebook、related evidence、FAQ 或 rawRelatedEvidence 伪装成 official direct。",
    "不得编造官方 Q&A、资料 id、卡片文本或规则出处。",
    "不确定时要把需要补充的信息写入 missingInfo，把风险写入 riskFlags。",
    "confidenceSelfEstimate 只是模型自评，不代表最终官方等级。",
    "输出必须是单个 JSON 对象，不要 markdown，不要代码围栏，不要 JSON 外说明。",
    "JSON 字段必须包含 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
    "shortAnswer 只写直接结论，不要把完整推理塞进 shortAnswer。若题目同时询问能否发动和后续如何处理，shortAnswer 必须同时写明发动结论与最终处理结果，不得只写“可以发动”。",
    "reasoning 必须是至少 2 条非空字符串组成的 JSON 数组；每条都要说明所依据的卡片文本、检索证据或规则，以及它如何适用于题目事实。",
    `允许的 answerLevel：${RAG_ANSWER_LEVELS.join(", ")}。`,
    "usedEvidence 只能引用下方 evidence 中真实存在的 id。",
    "示例结构如下，示例不是具体裁定：",
    JSON.stringify(example, null, 2),
    "本次检索上下文如下：",
    JSON.stringify(payload, null, 2),
    `可引用 evidence id 列表：${evidenceBucketsToList(evidencePayload).map((item) => item.id).join(", ") || "(none)"}`,
  ].join("\n");
  if (prompt.length > promptLimits.maxPromptChars) {
    warnings.push("rag_prompt_compacted_to_max_chars");
    prompt = buildCompactRagPrompt({ payload, maxPromptChars: promptLimits.maxPromptChars });
  }
  return {
    prompt,
    recoveryPrompt,
    warnings,
    promptChars: prompt.length,
    promptTruncated: warnings.some((warning) => warning.includes("truncated") || warning.includes("compacted")),
  };
}

export function selectAuthoritativeOfficialDirectCandidate({
  candidates = [],
  cardResolution = {},
  baigeAmbiguousMentions = [],
} = {}) {
  if (candidates.length !== 1) return null;
  const [candidate] = candidates;
  const completeIdentity = !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length
    && !(baigeAmbiguousMentions || []).length;
  const exactQuestionCardSet = candidate?.questionCardIdCoverage === 1
    && candidate?.questionCardIdCount > 0
    && candidate?.questionCardIdCount === (candidate?.matchedQuestionCardIds || []).length;
  const sceneProvenanceComplete = candidate?.authoritativeSceneMatchReason === "raw_or_normalized_query"
    || (candidate?.authoritativeSceneMatchReason === "unique_structured_scene"
      && candidate?.candidatePoolComplete === true);
  return candidate?.isDirect === true
    && candidate?.matchLevel === "official_qa_exact"
    && candidate?.type === "official_qa"
    && candidate?.authoritativeSceneMatch === true
    && sceneProvenanceComplete
    && exactQuestionCardSet
    && completeIdentity
    && Boolean(candidate?.id)
    && Boolean(candidate?.fullText || candidate?.text || candidate?.answer || candidate?.officialText)
    ? candidate
    : null;
}

function buildOfficialDirectPrompt({
  userQuery,
  resolvedCards = [],
  directQa = {},
  maxPromptChars,
} = {}) {
  const maxChars = Math.max(600, Number(maxPromptChars) || 12000);
  const instructions = [
    "你是游戏王 OCG 官方 Q&A 转述助手。检索器已经确认下方唯一 officialQaDirectCandidate 与用户问题精确对应。",
    "以该官方 Q&A 为最高且唯一的裁定依据，用中文完整回答；不要再用卡片文本、相似 FAQ 或常见场面改写官方结论。",
    "必须保留官方回答中的每个实质条件、例外、后续处理、次数或同回合限制；不能只写第一句结论。",
    "不要添加官方回答没有说明的处理。resolvedCards 只用于把 <<数字ID>> 等占位符还原为卡名。",
    `usedEvidence 必须包含 id=${String(directQa.id || "")}，type 必须为 official_qa。`,
    "answerLevel 必须为 official_confirmed；shortAnswer 直接给出完整结论，reasoning 至少两条并说明官方回答如何适用于本题。",
    "输出单个 JSON 对象，字段为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate；不要输出 JSON 以外内容。",
  ];
  const cardIdentities = (resolvedCards || []).map((card) => ({
    id: card.id,
    name: card.name,
    aliases: card.aliases || [],
  }));
  const render = ({ instructionLines, query, cards, text }) => [
    ...instructionLines,
    JSON.stringify({
      userQuery: query,
      resolvedCards: cards,
      officialQaDirectCandidate: {
        id: directQa.id,
        type: "official_qa",
        title: directQa.title || "",
        text,
        sourceUrl: directQa.sourceUrl || "",
      },
    }),
  ].join("\n");
  const sourceText = String(directQa.fullText || directQa.text || directQa.officialText || "");
  const fullPrompt = render({
    instructionLines: instructions,
    query: String(userQuery || ""),
    cards: cardIdentities,
    text: sourceText,
  });
  if (fullPrompt.length <= maxChars) return { prompt: fullPrompt, truncated: false };

  const compactInstructions = [
    "唯一精确官方Q&A如下。用中文完整转述全部条件、括号、例外、后续处理和限制，不得增删结论。",
    `输出规定字段的单个JSON；answerLevel=official_confirmed，usedEvidence必须含official_qa:${String(directQa.id || "")}。`,
  ];
  const compactCards = cardIdentities.slice(0, 6).map((card) => ({ id: card.id, name: card.name }));
  const compactQuery = String(userQuery || "").slice(0, 300);
  const fixedPrompt = render({
    instructionLines: compactInstructions,
    query: compactQuery,
    cards: compactCards,
    text: "",
  });
  const textBudget = Math.max(80, maxChars - fixedPrompt.length - 8);
  let prompt = render({
    instructionLines: compactInstructions,
    query: compactQuery,
    cards: compactCards,
    text: preserveTextEnds(sourceText, textBudget),
  });
  if (prompt.length > maxChars) {
    const minimalInstructions = ["完整转述唯一官方Q&A，保留全部限制；输出JSON并引用给定official_qa id。"];
    const minimalFixed = render({
      instructionLines: minimalInstructions,
      query: String(userQuery || "").slice(0, 80),
      cards: [],
      text: "",
    });
    prompt = render({
      instructionLines: minimalInstructions,
      query: String(userQuery || "").slice(0, 80),
      cards: [],
      text: preserveTextEnds(sourceText, Math.max(40, maxChars - minimalFixed.length - 8)),
    });
  }
  return { prompt, truncated: true };
}

function preserveTextEnds(text, limit) {
  const source = String(text || "");
  if (source.length <= limit) return source;
  const headLength = Math.max(1, Math.ceil((limit - 1) * 0.6));
  const tailLength = Math.max(1, limit - headLength - 1);
  return `${source.slice(0, headLength)}…${source.slice(-tailLength)}`;
}

function summarizeCards(cards, limit) {
  return (cards || []).slice(0, limit).map((card) => ({
    id: card.id || card.cardId || "",
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: card.aliases || [],
    cardType: card.cardType || card.type || "",
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? card.rank ?? card.link ?? null,
    source: card.source || "",
    effectText: card.effectText || card.text || "",
  }));
}

function summarizeOperationChecks(checks) {
  return (checks || []).slice(0, 20).map((check) => ({
    operationId: check.operationId,
    step: check.step,
    action: check.action,
    legalityQuestion: check.legalityQuestion,
    status: check.status,
    conclusion: check.conclusion,
    reasoning: check.reasoning || [],
    citations: check.citations || [],
    missingFacts: check.missingFacts || [],
  }));
}

function summarizeConstraintAudit(operationLegality = {}) {
  return {
    hasBlockingCheck: operationLegality?.hasBlockingCheck === true,
    hasUnresolvedConstraints: operationLegality?.hasUnresolvedConstraints === true,
    priorityConstraints: (operationLegality?.priorityConstraintEvidence || []).slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      text: String(item.text || "").slice(0, 1800),
      sourceUrl: item.sourceUrl || "",
    })),
    unresolvedConstraints: (operationLegality?.unresolvedConstraintEvidence || []).slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      text: String(item.text || "").slice(0, 1800),
      sourceUrl: item.sourceUrl || "",
    })),
    reviews: (operationLegality?.constraintReviews || []).slice(0, 8).map((review) => ({
      evidenceId: review.evidenceId,
      relevance: review.relevance,
      consequence: review.consequence,
      conclusion: review.conclusion,
      grounded: review.grounded === true,
    })),
  };
}

function summarizeSemanticStateTransition(state = {}) {
  if (!state || state.status !== "resolved") return { status: state?.status || "not_applicable", complete: false };
  return {
    status: state.status,
    complete: state.complete === true,
    activation: state.activation,
    resolution: state.resolution,
    trace: (state.trace || []).slice(0, 12).map((step) => ({
      phase: step.phase,
      state: step.state,
      status: step.status,
      operation: step.operation || null,
      conclusion: step.conclusion,
      evidenceIds: step.evidenceIds || [],
      proof: step.proof || null,
      stateSnapshot: step.stateSnapshot || null,
    })),
    destinationReplacementTimeline: state.destinationReplacementTimeline || null,
    evidenceIds: state.evidenceIds || [],
  };
}

function prepareEvidenceForPrompt(evidence, limits, warnings) {
  return {
    officialQaDirectCandidates: limitEvidence(evidence.officialQaDirectCandidates, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_direct", warnings),
    officialQaRelated: limitEvidence(evidence.officialQaRelated, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "official_related", warnings),
    provisionalOfficialResponses: limitEvidence(evidence.provisionalOfficialResponses, limits.maxOfficialQa, limits.maxEvidenceTextChars, "official_response_screenshot", warnings),
    faqRelated: limitEvidence(evidence.faqRelated, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "faq", warnings),
    formalEngineProofs: limitEvidence(evidence.formalEngineProofs, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "formal_engine", warnings),
    cardTexts: limitEvidence(evidence.cardTexts, limits.maxCards, limits.maxCardTextChars, "card_text", warnings),
    userProvidedCardTexts: limitEvidence(evidence.userProvidedCardTexts, limits.maxCards, limits.maxCardTextChars, "user_provided_text", warnings),
    rawRelatedEvidence: limitEvidence(evidence.rawRelatedEvidence, limits.maxRelatedEvidence, limits.maxEvidenceTextChars, "raw_related", warnings),
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
      cardType: item.cardType || "",
      attribute: item.attribute ?? "",
      race: item.race ?? "",
      atk: item.atk ?? null,
      def: item.def ?? null,
      level: item.level ?? null,
      text: truncated ? `${text.slice(0, Math.max(0, textLimit - 1))}…` : text,
      sourceUrl: item.sourceUrl || "",
      source: item.source || "",
      official: item.official === true,
      sourceType: item.sourceType || "",
      displayStatus: item.displayStatus || "",
      officialVerdict: item.officialVerdict ?? "unknown",
      officialText: item.officialText || "",
      explanation: item.explanation || "",
      queryId: item.queryId || "",
      predicate: item.predicate || "",
      claimText: item.claimText || "",
      verdict: item.verdict || "",
      trusted: item.trusted === true,
      unknownReasons: item.unknownReasons || [],
      witness: item.witness || null,
      counterexample: item.counterexample || null,
      versions: item.versions || null,
      proof: item.proof || null,
      branches: item.branches || [],
      structuredTrace: item.structuredTrace || [],
    };
  });
}

function buildCompactRagPrompt({ payload, maxPromptChars }) {
  const maxChars = Math.max(600, Number(maxPromptChars) || 30000);
  const textLimit = maxChars >= 30000 ? 1400 : maxChars >= 12000 ? 900 : maxChars >= 4000 ? 360 : 100;
  const totalEvidenceLimit = maxChars >= 30000 ? 20 : maxChars >= 12000 ? 14 : maxChars >= 4000 ? 7 : 3;
  const evidence = {
    officialQaDirectCandidates: [],
    officialQaRelated: [],
    faqRelated: [],
    cardTexts: [],
    userProvidedCardTexts: [],
    rawRelatedEvidence: [],
    formalEngineProofs: [],
    retrievalWarnings: (payload.evidence?.retrievalWarnings || []).slice(0, 6),
  };
  const bucketOrder = [
    "officialQaDirectCandidates",
    "formalEngineProofs",
    "userProvidedCardTexts",
    "cardTexts",
    "rawRelatedEvidence",
    "faqRelated",
    "officialQaRelated",
  ];
  let evidenceCount = 0;
  for (let index = 0; evidenceCount < totalEvidenceLimit; index += 1) {
    let added = false;
    for (const bucket of bucketOrder) {
      const item = (payload.evidence?.[bucket] || [])[index];
      if (item && evidenceCount < totalEvidenceLimit) {
      evidence[bucket].push({
        id: item.id,
        type: item.type,
        title: item.title,
        isDirect: Boolean(item.isDirect),
        text: String(item.text || "").slice(0, textLimit),
        sourceUrl: item.sourceUrl || "",
      });
      evidenceCount += 1;
        added = true;
      }
    }
    if (!added) break;
  }
  const compactPayload = {
    userQuery: String(payload.userQuery || "").slice(0, maxChars >= 4000 ? 1000 : 260),
    resolvedCards: (payload.resolvedCards || []).slice(0, 6).map((card) => ({
      id: card.id,
      name: card.name,
      cardType: card.cardType,
      attribute: card.attribute,
      race: card.race,
      source: card.source,
      effectText: truncatePromptText(
        card.effectText,
        maxChars >= 12000 ? 1200 : maxChars >= 4000 ? 600 : 180,
      ),
    })),
    unresolvedMentions: (payload.unresolvedMentions || []).slice(0, 6),
    operationChecks: (payload.operationChecks || []).slice(0, maxChars >= 4000 ? 8 : 2).map((check) => ({
      operationId: check.operationId,
      action: check.action,
      status: check.status,
      conclusion: String(check.conclusion || "").slice(0, textLimit),
      citations: (check.citations || []).slice(0, 3).map((citation) => ({
        id: citation.id,
        quote: String(citation.quote || "").slice(0, textLimit),
      })),
    })),
    constraintAudit: payload.constraintAudit,
    semanticStateTransition: compactSemanticStateTransition(payload.semanticStateTransition, {
      textLimit,
      traceLimit: maxChars >= 12000 ? 8 : maxChars >= 4000 ? 5 : 2,
    }),
    formalEngineStatus: payload.formalEngineStatus,
    evidence,
  };
  const render = (context) => [
    "你是游戏王 OCG 规则分析助手。只依据所给证据回答，不得编造规则或来源。",
    "官方直接 Q&A 才能支持 official_confirmed；相关 Q&A、FAQ、规则书和卡文只能支持 rule_analysis 或 low_confidence_analysis。",
    "operationChecks、constraintAudit 与 semanticStateTransition 是便宜模型/旧诊断整理出的待核对假设；只能帮助定位证据，不能替代最终推理。unknown 或未核对限制不能支持肯定或否定结论。",
    "按通用状态执行顺序判断手续或发动前提、手续或cost、每步状态更新、持续效果重算、逐项处理与诱发检查点；严格区分区域、移动归因、对象资格与效果抗性，同一步同时移动按原子批次处理。禁止按卡名或历史题模板补造事实。",
    "formalEngineProofs 中 trusted=true 的 TRUE/FALSE 是逐查询强约束；UNKNOWN 不是 FALSE，不能据此回答不能。",
    "resolvedCards 是已匹配卡片，effectText 是其效果依据；不得把已有字段说成未确定。任何非 formal 的状态轨迹都必须由最终模型依据原始文本重新验证。",
    "输出单个 JSON 对象，字段为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
    "shortAnswer 不超过300字；若题目同时询问能否发动和后续如何处理，必须同时写明发动结论与最终处理结果，不得只写“可以发动”。",
    "reasoning 为2至5条字符串，每条不超过240字；usedCards、usedEvidence 各不超过8项；missingInfo、riskFlags 各不超过6项。不要输出 JSON 以外内容。",
    JSON.stringify(context),
  ].join("\n");
  let prompt = render(compactPayload);
  if (prompt.length <= maxChars) return prompt;

  const evidenceIds = bucketOrder.flatMap((bucket) => evidence[bucket].map((item) => ({ id: item.id, type: item.type, title: item.title })));
  prompt = render({
    userQuery: String(payload.userQuery || "").slice(0, 160),
    resolvedCards: (payload.resolvedCards || []).slice(0, 4).map((card) => ({
      id: card.id,
      name: card.name,
      cardType: card.cardType,
      attribute: card.attribute,
      effectText: truncatePromptText(card.effectText, 240),
    })),
    operationChecks: (payload.operationChecks || []).slice(0, 2).map((check) => ({ status: check.status, conclusion: String(check.conclusion || "").slice(0, 100) })),
    constraintAudit: payload.constraintAudit,
    semanticStateTransition: compactSemanticStateTransition(payload.semanticStateTransition, {
      textLimit: 160,
      traceLimit: 3,
    }),
    formalEngineStatus: payload.formalEngineStatus,
    evidenceIds: evidenceIds.slice(0, 10),
  });
  if (prompt.length <= maxChars) return prompt;

  const minimalPrompt = [
    "仅依据上下文输出裁定 JSON；不得编造证据。",
    JSON.stringify({
      userQuery: String(payload.userQuery || "").slice(0, 80),
      resolvedCards: (payload.resolvedCards || []).slice(0, 2).map((card) => ({
        id: card.id,
        name: card.name,
        effectText: truncatePromptText(card.effectText, 80),
      })),
      semanticStateTransition: compactSemanticStateTransition(payload.semanticStateTransition, {
        textLimit: 80,
        traceLimit: 1,
      }),
      formalEngineStatus: payload.formalEngineStatus,
      evidenceIds: evidenceIds.slice(0, 3).map((item) => item.id),
    }),
  ].join("\n");
  return minimalPrompt.length <= maxChars
    ? minimalPrompt
    : minimalPrompt.slice(0, maxChars);
}

function compactSemanticStateTransition(state = {}, { textLimit = 360, traceLimit = 5 } = {}) {
  if (!state || typeof state !== "object") return { status: "not_applicable", complete: false };
  return {
    status: state.status || "not_applicable",
    complete: state.complete === true,
    activation: compactPromptValue(state.activation, textLimit),
    resolution: compactPromptValue(state.resolution, textLimit),
    trace: (Array.isArray(state.trace) ? state.trace : []).slice(0, traceLimit).map((step) => ({
      phase: step?.phase,
      state: step?.state,
      status: step?.status,
      operation: compactPromptValue(step?.operation, Math.max(80, Math.floor(textLimit / 2))),
      conclusion: truncatePromptText(step?.conclusion, textLimit),
      evidenceIds: (step?.evidenceIds || []).slice(0, 6),
      proof: compactPromptValue(step?.proof, textLimit),
    })),
    destinationReplacementTimeline: compactPromptValue(
      state.destinationReplacementTimeline,
      Math.max(textLimit, textLimit * 2),
    ),
    evidenceIds: (state.evidenceIds || []).slice(0, 10),
  };
}

function compactPromptValue(value, maxChars) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return truncatePromptText(value, maxChars);
  if (typeof value !== "object") return value;
  const serialized = JSON.stringify(value);
  return serialized.length <= maxChars ? value : truncatePromptText(serialized, maxChars);
}

function truncatePromptText(value, maxChars) {
  const text = String(value || "");
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
