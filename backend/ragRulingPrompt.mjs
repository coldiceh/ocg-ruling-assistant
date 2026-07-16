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
    maxRelatedEvidence: readNumber(env.RAG_MAX_RELATED_EVIDENCE, 10),
    maxCardTextChars: readNumber(env.RAG_MAX_CARD_TEXT_CHARS, 2500),
    maxPromptChars: readNumber(env.RAG_MAX_PROMPT_CHARS, 42000),
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
    "资料来源包括：官方 Q&A、FAQ、卡片文本、百鸽卡片资料、用户提供卡片文本，以及其他相关资料。",
    "优先根据官方 Q&A direct candidates 回答；只有 officialQaDirectCandidates 中的资料可以支持 official_confirmed。",
    "资料来源必须区分：official_direct_qa、official_related_qa、faq_related、card_text、baige_card_text、user_provided_text、rulebook、raw_related。",
    "user_provided_text 是用户在问题中粘贴的卡片文本，不是官方 direct evidence；可以基于这些文本分析，但不得称为官方确认。",
    "百鸽卡片资料和普通卡片文本可以作为卡片文本 grounding，但不是官方 direct Q&A。",
    "如果没有官方直接 Q&A，允许根据卡片文本、百鸽卡片资料、用户提供文本、FAQ、官方相似案例和 rulebook 规则书资料进行分析。",
    "ruleSearchQueries 是后端为检索规则资料生成的查询词，只能作为检索线索；最终理由必须基于 evidence 中真实存在的资料、卡片文本和题目事实。",
    "resolvedCards 是本地资料或百鸽已经匹配成功的卡片；其中已有 cardType、attribute 或效果文本时，不得再把该卡写成‘未识别’或‘属性未确定’。只有 unresolvedMentions 中仍存在的项目才算未解析。",
    "operationChecks 是 Flash 证据判读模型对题目每一步操作所做的检查；候选依据可以是规则书、官方 Q&A 或卡片 FAQ。后端已经校验其中引用的 evidence id 和逐字引文，未通过校验的 legal/illegal/conditional 会被降为 unknown。",
    "对同一操作，operationChecks 中 citations 非空的 illegal 结论是强约束。legal 或 conditional 只有在 constraintAudit.hasUnresolvedConstraints=false 时才能作为强约束；status=unknown 不能作为肯定或否定依据。",
    "constraintAudit 列出后端优先核对的限制性规则。hasUnresolvedConstraints=true 时，不得回答‘可以发动/可以进行’；必须继续依据列出的规则核对，无法完成时只能给保守的不确定结论。",
    "hasUnresolvedConstraints=true 表示前置判读没有完成，不表示规则不适用。此时必须直接阅读 unresolvedConstraints.text，逐项比较规则条件与题目事实；若题目已明确满足阻断条件，应据此回答不能发动或不能进行，只有缺少必要事实时才保留不确定。",
    "一般 FAQ 只证明诱发条件或连锁窗口时，不能用它覆盖更具体的不能发动、不能选择、不能返回或无可适用卡规则。必须同时核对效果的所有必做处理。",
    "如果校验后的证据直接点名题目中的多张卡并描述同一场景，必须完整遵守该案例的全部处理步骤；不得只采用其发动或取对象结论后，再凭记忆改写后续处理。",
    "效果文本包含连续处理时，必须按文本和证据顺序说明每一步是否成功，并在前一步改变抗性、位置、素材或状态后重新判断下一步。",
    "不得因为效果发动源或对象在连锁处理中离开原位置，就未经证据把整条已经合法发动的效果判为不处理。必须分别核对：发动是否已经成立、每一项处理依赖什么对象或位置、某一项不能处理时其余项目是否继续，并引用覆盖该步骤的规则或 Q&A。",
    "对象在处理时不再存在，只能直接影响确实依赖该对象的处理；不要据此自动删除不以该对象为处理对象的支付、丢弃、返回或其他项目。具体是否继续仍以检索证据和原效果连接词为准。",
    "必须把‘能否取为对象’与‘效果是否影响该卡’作为两个独立判断；不受效果影响本身不等于不能成为对象，对象保护也不等于效果抗性。只引用真正约束该步骤的证据。",
    "涉及把发动无效并破坏时，必须区分魔法・陷阱卡的卡的发动与已在场卡片的效果发动，并按检索证据判断被破坏的卡是否仍视为场上的卡。",
    "较早步骤已经不合法时，结论应直接说明实际阻断原因，不要继续描述未发生的后续处理，也不要添加与当前场景无关的假设分支。",
    "相关 Q&A / FAQ 可以作为规则适用案例，但必须比较卡片、效果、时点、位置、素材数量和处理顺序；不是当前原题时不得升级为 official_confirmed。",
    "rawRelatedEvidence 中 source=rulebook_model_grounding 或 qa_rule_model_grounding 的资料是校验后的逐操作检查，不是官方 direct Q&A；其引文对应的原始证据也会作为独立 evidence 提供。",
    "涉及发动合法性、是否有可适用处理、次数限制、同一诱发条件再次满足时，要优先核对 rulebook、FAQ 和卡片文本；不要只凭常识猜测。",
    "只要有卡片文本 grounding，优先输出 rule_analysis；不要因为没有 template、没有 validator、没有官方 direct Q&A 就输出 needs_more_info。",
    "涉及“能否发动/能否适用/能否连锁”的问题时，必须先核对卡片文本中的发动条件、效果类别、对象要求、当前位置、表侧/里侧状态、当前连锁窗口和题目给出的场面事实。",
    "如果卡片文本要求特定事件、特定卡种、特定位置、特定对象或特定玩家状态，题目事实没有满足时，结论应说明不满足该条件；不得只因为卡名相关或存在相似 FAQ 就回答可以。",
    "不得自行推断隐藏的一回合一次、同名一回合一次或已适用过就不能再次发动；只有卡片文本或规则证据明确存在次数限制时，才按次数限制处理。",
    "题目已经明确当前时点或卡片当前位置时，不要补充与该场景无关的假设分支；只在缺少关键事实时才列 missingInfo。",
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
    "shortAnswer 只写直接结论，不要把完整推理塞进 shortAnswer。",
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

function prepareEvidenceForPrompt(evidence, limits, warnings) {
  return {
    officialQaDirectCandidates: limitEvidence(evidence.officialQaDirectCandidates, limits.maxOfficialQa, 2400, "official_direct", warnings),
    officialQaRelated: limitEvidence(evidence.officialQaRelated, limits.maxRelatedEvidence, 2200, "official_related", warnings),
    faqRelated: limitEvidence(evidence.faqRelated, limits.maxRelatedEvidence, 2000, "faq", warnings),
    cardTexts: limitEvidence(evidence.cardTexts, limits.maxCards, limits.maxCardTextChars, "card_text", warnings),
    userProvidedCardTexts: limitEvidence(evidence.userProvidedCardTexts, limits.maxCards, limits.maxCardTextChars, "user_provided_text", warnings),
    rawRelatedEvidence: limitEvidence(evidence.rawRelatedEvidence, limits.maxRelatedEvidence, 1500, "raw_related", warnings),
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
    retrievalWarnings: (payload.evidence?.retrievalWarnings || []).slice(0, 6),
  };
  const bucketOrder = [
    "officialQaDirectCandidates",
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
    evidence,
  };
  const render = (context) => [
    "你是游戏王 OCG 裁定分析助手。只依据所给证据回答，不得编造规则或来源。",
    "官方直接 Q&A 才能支持 official_confirmed；相关 Q&A、FAQ、规则书和卡文只能支持 rule_analysis 或 low_confidence_analysis。",
    "有逐字引文的 illegal operationChecks 是强约束；legal 只有在 constraintAudit 没有未核对限制时才能支持肯定结论。unknown 不能支持肯定或否定结论。",
    "constraintAudit.hasUnresolvedConstraints=true 时不得回答操作可以进行；一般发动条件不能覆盖更具体的限制规则。",
    "resolvedCards 是已匹配卡片，不得把其中已有的卡种或属性说成未确定。必须分别判断发动、取对象、效果适用和逐项处理；发动源或对象离开不等于整条效果自动不处理。",
    "不受效果影响不等于不能成为对象；魔法陷阱卡的卡的发动被无效与场上表侧卡的效果发动被无效必须分开判断。",
    "输出单个 JSON 对象，字段为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
    "shortAnswer 只写结论；reasoning 必须是至少 2 条非空字符串的数组，并逐条说明证据如何适用于题目。",
    JSON.stringify(context),
  ].join("\n");
  let prompt = render(compactPayload);
  if (prompt.length <= maxChars) return prompt;

  const evidenceIds = bucketOrder.flatMap((bucket) => evidence[bucket].map((item) => ({ id: item.id, type: item.type, title: item.title })));
  prompt = render({
    userQuery: String(payload.userQuery || "").slice(0, 160),
    resolvedCards: (payload.resolvedCards || []).slice(0, 4).map((card) => ({ id: card.id, name: card.name, cardType: card.cardType, attribute: card.attribute })),
    operationChecks: (payload.operationChecks || []).slice(0, 2).map((check) => ({ status: check.status, conclusion: String(check.conclusion || "").slice(0, 100) })),
    constraintAudit: payload.constraintAudit,
    evidenceIds: evidenceIds.slice(0, 10),
  });
  if (prompt.length <= maxChars) return prompt;

  return [
    "仅依据上下文输出裁定 JSON；不得编造证据。",
    JSON.stringify({ userQuery: String(payload.userQuery || "").slice(0, 80), evidenceIds: evidenceIds.slice(0, 5).map((item) => item.id) }),
  ].join("\n").slice(0, maxChars);
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
