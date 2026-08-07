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
  reasoning: ["先核对卡片文本。", "再比对官方相似资料。"],
  usedCards: ["示例卡名"],
  usedEvidence: [{ id: "card-text-example", type: "card_text", title: "示例卡名 的卡片文本" }],
  missingInfo: [],
  riskFlags: ["no_official_direct_qa"],
  confidenceSelfEstimate: "medium",
});

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
    cardSemanticFacts: summarizeCardSemanticFacts(evidence.cardSemanticFacts),
    formalEngineStatus: evidence.formalEngineStatus || { mode: "off", status: "disabled" },
    legacyLuaSemanticPacket: summarizeLegacyLuaSemanticPacket(
      evidence.legacyLuaSemanticPacket,
    ),
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
  // The selector above is deliberately strict: it requires one exact official
  // candidate, complete card identities and a certified scene/card-set match.
  // Once those checks pass, always focus the final model on that Q&A instead of
  // allowing unrelated evidence to dilute the official answer.
  if (authoritativeDirect
    && !(evidence.formalEngineProofs || []).length) {
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
      authoritativeOfficialDirectId: String(authoritativeDirect.id),
    };
  }

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
    "operationChecks、constraintAudit 和 semanticStateTransition 即使存在也只是旧的证据整理诊断，不是裁定证明或强约束；最终结论必须由你重新阅读原始卡文、官方 Q&A、FAQ 与规则资料后独立得出。",
    "cardSemanticFacts 是卡文范式化器从已解析卡文抽取的候选操作，不是裁定证明；必须对照原始卡文复核。若候选为 create_lingering_restriction 且 expiration.mode=irreversible_on_first_condition_failure、reactivates=false，它表示已处理效果创建的限制实例在 activeWhile 首次不成立时永久终止，之后条件再次成立也不会自行恢复，只有重新适用原效果才能创建新实例。",
    "formalEngineProofs 来自版本协商、能力检查、完整执行检查和独立证明校验后的声明式规则内核。trusted=true 且 verdict=TRUE/FALSE 的逐查询结论是强约束，模型只能解释，不能翻转；verdict=UNKNOWN 只表示未获证明，绝不等于 FALSE，也不能单独支持‘不能’。",
    "legacyLuaSemanticPacket 是从锁定旧版 Lua 脚本静态编译出的非权威语义提示，只用于发现应检查的发动条件、移动能力、cost 与处理操作。它的正式 verdict 永远是 UNKNOWN；candidateVerdict 只描述旧脚本在完整输入下的候选行为，不能直接支持任何裁定、不能覆盖题面/卡文/官方资料，UNKNOWN 也绝不等于不能。",
    "使用 Lua 候选前先以 resourceId 绑定 resources：预计算 sourceDocumentId 内的 cid-<卡片CID>/passcode-<脚本密码> 只对应 resolvedCards 中 CID 相同的卡片，禁止把一张卡的检查套到另一张卡。",
    "legacyLuaSemanticPacket.activationLegalityChecks 是旧脚本在发动检查阶段实际执行的通用候选条件。必须对题设状态枚举能通过 predicateApi 的候选；若 requiredMinimum 无法达到，则该效果不能发动，不得误解为可以发动后空处理。候选卡的具体合法性仍必须用卡文或规则资料复核。",
    "selectorSummary 是 Lua 筛选器自动生成的有界布尔摘要；FILTER_ARGUMENT_n 依次绑定 filterArgumentExpressions[n-1]。先按题设的响应效果种类代入分支，再依据双方区域、filterExpression 与 predicateApi 计算候选，不能把另一分支的卡混入数量。",
    "分析任何操作时使用同一套通用执行顺序：从卡文和题面建立带来源的初始状态；分别检查手续或发动前提；执行手续、cost 与每个效果步骤并记录实际移动及归因；每次状态变化后重算持续效果；在检查点收集诱发候选并保留对方响应分支。禁止根据卡名、FAQ 编号、题面暗示答案或历史错题模板补造缺失事实。",
    "先绑定参与者角色：逐项写清每张卡的控制者、每个动作的执行者、‘自己/对方’分别指谁、被公开或被影响的是哪一方的手卡或场。相似 Q&A 若交换了控制者、动作主体或受影响玩家，只能作为相关资料，不能直接照搬结论。",
    "必须把发动合法性与效果处理分开：先以发动时状态检查全部必需对象、可执行后续召唤/处理及隐藏区域要求；发动合法后再逐步处理。若处理中条件变化导致后续步骤不能进行，要明确处理在哪一步结束，不得把处理时失败倒推成不能发动。",
    "卡文或官方资料明确列举适用类型时，默认按封闭集合解释；不得把未列举的仪式、融合、同调、超量、连接、解放、素材、cost、召唤手续等不同操作自行归为同类。只有另有原文明确扩张集合时才能扩张。",
    "效果要求在特殊召唤后继续进行融合、同调、超量、连接或其他召唤时，发动前先检查额外卡组是否至少存在一条在发动时可行的后续召唤路径；处理中再按实际新状态重算等级、属性、种族、区域与持续效果。若处理时已无可行路径，应说明前段已完成、后段不进行。",
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
    JSON.stringify(RAG_JSON_SHAPE_EXAMPLE, null, 2),
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
  const completeIdentity = !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length
    && !(baigeAmbiguousMentions || []).length;
  const exactQuestionCardSet = candidate?.questionCardIdCoverage === 1
    && candidate?.questionCardIdCount > 0
    && candidate?.questionCardIdCount === (candidate?.matchedQuestionCardIds || []).length;
  const certifiedQuestionSuperset = candidate?.authoritativeSceneMatchReason === "unique_semantic_question_subsumption"
    && candidate?.semanticSubsumptionCertified === true
    && candidate?.subsumptionCandidatePoolComplete === true
    && candidate?.questionCardIdCoverage === 1
    && (candidate?.matchedQuestionCardIds || []).length > 0
    && ((candidate?.matchedQuestionCardIds || []).length === 1
      || candidate?.questionCardIdCount === (candidate?.matchedQuestionCardIds || []).length);
  const certifiedQuestionCardSuperset = candidate?.authoritativeSceneMatchReason === "unique_question_card_subsumption"
    && candidate?.questionCardSubsumptionCertified === true
    && candidate?.subsumptionCandidatePoolComplete === true
    && candidate?.questionCardIdCoverage === 1
    && (candidate?.matchedQuestionCardIds || []).length >= 2
    && candidate?.questionCardIdCount === (candidate?.matchedQuestionCardIds || []).length;
  const sceneProvenanceComplete = candidate?.authoritativeSceneMatchReason === "raw_or_normalized_query"
    || (candidate?.authoritativeSceneMatchReason === "unique_structured_scene"
      && candidate?.candidatePoolComplete === true)
    || certifiedQuestionSuperset
    || certifiedQuestionCardSuperset;
  return candidate?.isDirect === true
    && candidate?.matchLevel === "official_qa_exact"
    && candidate?.type === "official_qa"
    && candidate?.authoritativeSceneMatch === true
    && sceneProvenanceComplete
    && (exactQuestionCardSet || certifiedQuestionSuperset || certifiedQuestionCardSuperset)
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
  const arrayFieldInstruction = "JSON字段类型：reasoning、usedCards、missingInfo、riskFlags必须是字符串数组；usedEvidence必须是对象数组，每项包含id、type、title；即使没有内容也输出[]。";
  const instructions = [
    "你是游戏王 OCG 官方 Q&A 转述助手。检索器已经确认下方唯一 officialQaDirectCandidate 与用户问题精确对应。",
    "以该官方 Q&A 为最高且唯一的裁定依据，用中文完整回答；不要再用卡片文本、相似 FAQ 或常见场面改写官方结论。",
    "必须保留官方回答中的每个实质条件、例外、后续处理、次数或同回合限制；不能只写第一句结论。",
    "不要添加官方回答没有说明的处理。resolvedCards 只用于把 <<数字ID>> 等占位符还原为卡名。",
    `usedEvidence 必须包含 id=${String(directQa.id || "")}，type 必须为 official_qa。`,
    "answerLevel 必须为 official_confirmed；shortAnswer 直接给出完整结论，reasoning 至少两条并说明官方回答如何适用于本题。",
    arrayFieldInstruction,
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
  const sourceText = extractRelevantOfficialQaAnswerExcerpt(directQa);
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
    arrayFieldInstruction,
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
    const minimalInstructions = [
      "完整转述唯一官方Q&A，保留全部限制；输出JSON并引用给定official_qa id。",
      arrayFieldInstruction,
    ];
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
    const text = String(item.fullText || item.text || item.officialText || item.answer || "");
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
      text: truncated ? preserveTextEnds(text, textLimit) : text,
      sourceUrl: item.sourceUrl || "",
      source: item.source || "",
      official: item.official === true,
      sourceType: item.sourceType || "",
      displayStatus: item.displayStatus || "",
      authoritativeSceneMatch: item.authoritativeSceneMatch === true,
      authoritativeSceneMatchReason: item.authoritativeSceneMatchReason || "",
      questionType: item.questionType || "unknown",
      subsumptionCandidatePoolComplete: item.subsumptionCandidatePoolComplete === true,
      semanticSubsumptionCertified: item.semanticSubsumptionCertified === true,
      semanticSubsumptionScoreMargin: Number(item.semanticSubsumptionScoreMargin || 0),
      semanticSubsumptionRunnerUpId: item.semanticSubsumptionRunnerUpId || "",
      semanticSubsumptionMetrics: item.semanticSubsumptionMetrics || null,
      questionCardSubsumptionCertified: item.questionCardSubsumptionCertified === true,
      questionCardSubsumptionMetrics: item.questionCardSubsumptionMetrics || null,
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
  // When the normal prompt is compacted, retain enough candidates to include
  // the full FAQ section of a matched card instead of only the first entries.
  const textLimit = maxChars >= 30000 ? 900 : maxChars >= 12000 ? 700 : maxChars >= 4000 ? 320 : 100;
  const totalEvidenceLimit = maxChars >= 30000 ? 42 : maxChars >= 12000 ? 21 : maxChars >= 4000 ? 7 : 3;
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
        text: preserveTextEnds(String(item.text || ""), textLimit),
        sourceUrl: item.sourceUrl || "",
      });
      evidenceCount += 1;
        added = true;
      }
    }
    if (!added) break;
  }
  const allowedEvidenceIds = [...new Set(
    bucketOrder.flatMap((bucket) => evidence[bucket].map((item) => String(item.id || "").trim())).filter(Boolean),
  )];
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
    cardSemanticFacts: (payload.cardSemanticFacts || []).slice(0, maxChars >= 12000 ? 12 : 5),
    formalEngineStatus: payload.formalEngineStatus,
    legacyLuaSemanticPacket: compactLegacyLuaSemanticPacket(
      payload.legacyLuaSemanticPacket,
      { candidateLimit: maxChars >= 12000 ? 10 : maxChars >= 4000 ? 5 : 2 },
    ),
    allowedEvidenceIds,
    evidence,
  };
  const render = (context) => [
    "你是游戏王 OCG 规则分析助手。只依据所给证据回答，不得编造规则或来源。",
    "官方直接 Q&A 才能支持 official_confirmed；相关 Q&A、FAQ、规则书和卡文只能支持 rule_analysis 或 low_confidence_analysis。",
    "operationChecks、constraintAudit 与 semanticStateTransition 是便宜模型/旧诊断整理出的待核对假设；只能帮助定位证据，不能替代最终推理。unknown 或未核对限制不能支持肯定或否定结论。",
    "cardSemanticFacts 是卡文范式化候选而非证明。create_lingering_restriction 的 irreversible_on_first_condition_failure/ reactivates=false 表示期限条件首次失效后该效果实例永久结束，条件后来恢复不会自动重启。必须对照原卡文复核。",
    "legacyLuaSemanticPacket 只是锁定旧脚本的非权威语义提示。只能据此发现要检查的条件和操作；正式 verdict 永远 UNKNOWN，candidateVerdict 不能直接支持结论、不能覆盖卡文或官方资料。",
    "使用 Lua 候选前先以 resourceId 绑定 resources；预计算 sourceDocumentId 的 cid-<卡片CID>/passcode-<脚本密码> 只可用于 resolvedCards 中 CID 相同的卡片，禁止跨卡套用。",
    "legacyLuaSemanticPacket.activationLegalityChecks 是旧脚本在发动检查阶段实际执行的通用候选条件。必须对题设状态枚举能通过 predicateApi 的候选；若 requiredMinimum 无法达到，则该效果不能发动，不得误解为可以发动后空处理。候选卡的具体合法性仍必须用卡文或规则资料复核。",
    "selectorSummary 是 Lua 筛选器生成的有界布尔摘要；FILTER_ARGUMENT_n 对应 filterArgumentExpressions[n-1]。先按响应效果种类代入分支，再根据区域、filterExpression 与 predicateApi 计算候选。",
    "按通用状态执行顺序判断手续或发动前提、手续或cost、每步状态更新、持续效果重算、逐项处理与诱发检查点；严格区分区域、移动归因、对象资格与效果抗性，同一步同时移动按原子批次处理。禁止按卡名或历史题模板补造事实。",
    "先绑定玩家角色：区分每张卡的控制者、动作执行者、受影响玩家与手牌所属者。交换了自己/对方或控制者的相似FAQ不能直接套用结论。",
    "发动合法性与效果处理必须分开。先按发动时状态检查必需对象和至少一条可行后续路径；支付cost后逐步更新状态并重算持续效果。处理中后续步骤变得不可行时，明确处理在哪一步结束，不得倒推为不能发动。",
    "卡文或官方资料明确列举类型时按封闭集合解释，不得把未列举的仪式、融合、同调、超量、连接、解放、素材、cost或召唤手续自行归入同类。",
    "formalEngineProofs 中 trusted=true 的 TRUE/FALSE 是逐查询强约束；UNKNOWN 不是 FALSE，不能据此回答不能。",
    "resolvedCards 是已匹配卡片，effectText 是其效果依据；不得把已有字段说成未确定。任何非 formal 的状态轨迹都必须由最终模型依据原始文本重新验证。",
    "输出单个 JSON 对象，字段为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
    "usedEvidence 每项的 id 必须非空，并从 allowedEvidenceIds 中逐字选择；没有实际引用时输出空数组，禁止输出空 id 或自造 id。",
    "shortAnswer 不超过300字；若题目同时询问能否发动和后续如何处理，必须同时写明发动结论与最终处理结果，不得只写“可以发动”。",
    "reasoning 为2至5条字符串，每条不超过240字；usedCards、usedEvidence 各不超过8项；missingInfo、riskFlags 各不超过6项。不要输出 JSON 以外内容。",
    "以下 JSON 仅展示字段结构，内容不是本题答案：",
    JSON.stringify(RAG_JSON_SHAPE_EXAMPLE),
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
    cardSemanticFacts: (payload.cardSemanticFacts || []).slice(0, 3),
    formalEngineStatus: payload.formalEngineStatus,
    legacyLuaSemanticPacket: compactLegacyLuaSemanticPacket(
      payload.legacyLuaSemanticPacket,
      { candidateLimit: 2 },
    ),
    allowedEvidenceIds: allowedEvidenceIds.slice(0, 10),
    evidenceIds: evidenceIds.slice(0, 10),
  });
  if (prompt.length <= maxChars) return prompt;

  const minimalPrompt = [
    "仅依据上下文输出规定字段的裁定 JSON；不得编造证据。usedEvidence 的 id 必须非空并逐字取自 allowedEvidenceIds；没有引用则为 []。",
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
      cardSemanticFacts: (payload.cardSemanticFacts || []).slice(0, 1),
      formalEngineStatus: payload.formalEngineStatus,
      legacyLuaSemanticPacket: compactLegacyLuaSemanticPacket(
        payload.legacyLuaSemanticPacket,
        { candidateLimit: 1 },
      ),
      allowedEvidenceIds: allowedEvidenceIds.slice(0, 3),
      evidenceIds: evidenceIds.slice(0, 3).map((item) => item.id),
    }),
  ].join("\n");
  return minimalPrompt.length <= maxChars
    ? minimalPrompt
    : minimalPrompt.slice(0, maxChars);
}

function summarizeCardSemanticFacts(facts = {}) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact === "object" && fact.operation)
    .slice(0, 24)
    .map((fact) => ({
      cardId: fact.cardId,
      cardName: fact.cardName,
      effectIndex: fact.effectIndex,
      stepIndex: fact.stepIndex,
      connector: fact.connector,
      operation: fact.operation,
      sourceText: String(fact.sourceText || "").slice(0, 1200),
      sourceEvidenceIds: fact.sourceEvidenceIds || [],
      authority: "normalizer_candidate_only",
    }));
}

function summarizeLegacyLuaSemanticPacket(packet) {
  if (!packet || typeof packet !== "object") {
    return {
      status: "unavailable",
      verdict: "UNKNOWN",
      canConfirmOfficialRuling: false,
      legacyAcceptedAsTruth: false,
      effectCandidates: [],
      unknownReasonCodes: ["LEGACY_LUA_PACKET_UNAVAILABLE"],
    };
  }
  const effectCandidates = Array.isArray(packet.effectCandidates)
    ? packet.effectCandidates.slice(0, 24).map(summarizeLegacyLuaCandidate)
    : [];
  return {
    status: effectCandidates.length ? "available" : "typed_unknown",
    schemaVersion: String(packet.schemaVersion || ""),
    packetId: String(packet.packetId || ""),
    packetSha256: String(packet.packetSha256 || ""),
    authority: String(packet.authority || ""),
    verdict: "UNKNOWN",
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    resources: (Array.isArray(packet.resources) ? packet.resources : [])
      .slice(0, 12)
      .map((resource) => ({
        resourceId: String(resource?.resourceId || ""),
        status: String(resource?.status || ""),
        candidateCount: Number(resource?.candidateCount || 0),
        sourceDocumentId: String(
          resource?.resourceBinding?.sourceDocumentId || "",
        ),
        sourceContentSha256: String(
          resource?.resourceBinding?.sourceContentSha256 || "",
        ),
        unknownReasonCodes: reasonCodes(resource?.unknownReasons),
      })),
    effectCandidates,
    omittedCandidateCount: Number(
      packet.truncation?.omittedCandidateCount ||
      (Array.isArray(packet.omittedCandidates)
        ? packet.omittedCandidates.length
        : 0),
    ),
    unknownReasonCodes: reasonCodes(packet.unknownReasons),
  };
}

function summarizeLegacyLuaCandidate(candidate = {}) {
  const artifact = candidate.semanticArtifact || {};
  const plan = artifact.plan || artifact.partialPlan || {};
  const analysis = candidate.analysisArtifact || {};
  return {
    resourceId: String(candidate.resourceId || ""),
    semanticEffectIdentity: String(candidate.semanticEffectIdentity || ""),
    kind: String(candidate.kind || "TYPED_UNKNOWN"),
    verdict: "UNKNOWN",
    candidateVerdict: ["TRUE", "FALSE", "UNKNOWN"].includes(
      analysis.candidateVerdict,
    ) ? analysis.candidateVerdict : "UNKNOWN",
    costAtomicOperations: stringList(plan.costAtomicOperations, 10),
    atomicOperations: stringList(plan.atomicOperations, 16),
    activationLegalityDependencies: stringList(
      plan.activationLegalityDependencies,
      20,
    ),
    activationLegalityChecks: (Array.isArray(plan.activationLegalityChecks)
      ? plan.activationLegalityChecks
      : []).slice(0, 12).map((check) => ({
        callbackSlot: String(check?.callbackSlot || ""),
        predicateApi: String(check?.predicateApi || ""),
        atomicOperation: String(check?.atomicOperation || ""),
        requiredMinimum: Number.isSafeInteger(check?.requiredMinimum)
          ? check.requiredMinimum
          : null,
        dependencyNodes: stringList(
          legacyLuaDependencyEntries(check?.dependencyGraph).map((node) =>
            typeof node === "string"
              ? node
              : node?.name || node?.id || node?.dependency
          ),
          16,
        ),
      })),
    operationApis: stringList(plan.operationApis, 16),
    requiredLegacyApis: stringList(plan.requiredLegacyApis, 20),
    unresolvedSemantics: reasonCodes(plan.unresolvedSemantics),
    unknownReasonCodes: reasonCodes(candidate.unknownReasons),
  };
}

function compactLegacyLuaSemanticPacket(packet, { candidateLimit = 5 } = {}) {
  if (!packet || typeof packet !== "object") return packet || null;
  return {
    status: packet.status || "typed_unknown",
    packetId: packet.packetId || "",
    packetSha256: packet.packetSha256 || "",
    authority: packet.authority || "LEGACY_COMPATIBILITY",
    verdict: "UNKNOWN",
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    effectCandidates: (packet.effectCandidates || [])
      .slice(0, candidateLimit)
      .map((candidate) => ({
        resourceId: candidate.resourceId,
        semanticEffectIdentity: candidate.semanticEffectIdentity,
        kind: candidate.kind,
        verdict: "UNKNOWN",
        candidateVerdict: candidate.candidateVerdict || "UNKNOWN",
        costAtomicOperations: candidate.costAtomicOperations || [],
        atomicOperations: candidate.atomicOperations || [],
        activationLegalityDependencies:
          candidate.activationLegalityDependencies || [],
        activationLegalityChecks: candidate.activationLegalityChecks || [],
        unknownReasonCodes: candidate.unknownReasonCodes || [],
      })),
    omittedCandidateCount: Number(packet.omittedCandidateCount || 0),
    unknownReasonCodes: packet.unknownReasonCodes || [],
  };
}

function reasonCodes(reasons) {
  return [...new Set((Array.isArray(reasons) ? reasons : [])
    .map((reason) => String(reason?.code || "").trim())
    .filter(Boolean))]
    .sort()
    .slice(0, 24);
}

function legacyLuaDependencyEntries(value) {
  if (Array.isArray(value?.dependencies)) return value.dependencies;
  return Array.isArray(value?.nodes) ? value.nodes : [];
}

function stringList(values, limit) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))]
    .sort()
    .slice(0, limit);
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
