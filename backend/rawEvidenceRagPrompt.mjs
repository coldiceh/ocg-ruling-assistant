import { getTrustedRawGenericRecordProvenance } from "./rawGenericDataStore.mjs";
import { rawGenericCorpusCardId } from "./rawGenericCardIdentity.mjs";

const ANSWER_LEVELS = Object.freeze([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
]);

const OUTPUT_EXAMPLE = Object.freeze({
  answerLevel: "rule_analysis",
  shortAnswer: "直接回答用户的问题。",
  reasoning: ["说明所依据的原始资料。", "说明这些资料如何适用于题面。"],
  usedCards: ["卡名"],
  usedEvidence: [{ id: "evidence-id", type: "card_text", title: "资料标题" }],
  missingInfo: [],
  riskFlags: [],
  confidenceSelfEstimate: "medium",
});

const EVIDENCE_BUCKETS = Object.freeze([
  "officialQaRelated",
  "provisionalOfficialResponses",
  "faqRelated",
  "cardTexts",
  "userProvidedCardTexts",
  "rawRelatedEvidence",
]);

const COMPACT_BUCKET_ORDER = Object.freeze([
  "userProvidedCardTexts",
  "cardTexts",
  "officialQaRelated",
  "provisionalOfficialResponses",
  "faqRelated",
  "rawRelatedEvidence",
]);

const DERIVED_RAW_RELATED_SOURCES = new Set([
  "rulebook_model_grounding",
  "qa_rule_model_grounding",
]);

export class RawEvidencePromptCapacityError extends Error {
  constructor({ path, maxPromptChars, minimumPromptChars }) {
    super(`raw evidence prompt exceeds configured capacity for ${path}`);
    this.name = "RawEvidencePromptCapacityError";
    this.code = "raw_evidence_prompt_capacity_exceeded";
    this.details = Object.freeze({ path, maxPromptChars, minimumPromptChars });
  }
}

/**
 * Builds the public prompt from a strict allowlist of raw retrieval records.
 * This module intentionally has no imports from the legacy semantic reasoners,
 * validators, question classifiers, Lua adapters, or ruling-intent helpers.
 */
export function buildRawEvidenceRagPrompt(input = {}) {
  return buildRawEvidenceRagPromptBundle(input).prompt;
}

export function buildRawEvidenceRagPromptBundle({
  userQuery = "",
  cardResolution = {},
  evidence = {},
  env = {},
  authoritativeOfficialDirect = false,
} = {}) {
  const limits = {
    maxCards: readPositiveNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readPositiveNumber(env.RAG_MAX_OFFICIAL_QA, 7),
    maxRelatedEvidence: readPositiveNumber(env.RAG_MAX_RELATED_EVIDENCE, 14),
    maxCardTextChars: readPositiveNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readPositiveNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    maxPromptChars: readPositiveNumber(env.RAG_MAX_PROMPT_CHARS, 60000),
    recoveryPromptChars: readPositiveNumber(env.RAG_RECOVERY_PROMPT_CHARS, 12000),
  };
  const warnings = [];
  const rawCards = summarizeRawCards(cardResolution.resolvedCards, limits.maxCards);
  const identityState = {
    resolvedCards: rawCards,
    unresolvedMentions: sanitizeMentionList(cardResolution.unresolvedMentions),
    ambiguousMentions: sanitizeMentionList(cardResolution.ambiguousMentions),
  };
  const direct = selectStrictOfficialDirectCandidate({
    candidates: evidence.officialQaDirectCandidates,
    userQuery,
    cardResolution,
    baigeAmbiguousMentions: evidence.baigeAmbiguousMentions,
    selector: authoritativeOfficialDirect,
  });

  if (direct) {
    const rawDirect = sanitizeRawEvidenceItem(direct, {
      bucket: "officialQaDirectCandidates",
      textLimit: limits.maxEvidenceTextChars,
    });
    const primary = fitOfficialDirectPrompt({
      userQuery,
      resolvedCards: rawCards,
      directEvidence: rawDirect,
      maxPromptChars: limits.maxPromptChars,
    });
    const recovery = fitOfficialDirectPrompt({
      userQuery,
      resolvedCards: rawCards,
      directEvidence: rawDirect,
      maxPromptChars: limits.recoveryPromptChars,
    });
    if (primary.compacted) warnings.push("raw_official_direct_prompt_compacted");
    return {
      prompt: primary.prompt,
      recoveryPrompt: recovery.prompt,
      warnings,
      promptChars: primary.prompt.length,
      promptTruncated: primary.compacted,
      authoritativeOfficialDirectId: String(rawDirect.id || ""),
      authoritativeOfficialDirect: direct,
      allowedEvidenceIds: rawDirect.id ? [String(rawDirect.id)] : [],
      allowedAnswerLevels: ["official_confirmed", "budget_limited"],
      rawEvidenceOnly: true,
    };
  }

  const rawEvidence = prepareRawEvidence(evidence, limits, warnings);
  const basePayload = {
    userQuery: String(userQuery || ""),
    ...identityState,
    evidence: rawEvidence,
    allowedEvidenceIds: rawEvidenceIds(rawEvidence),
  };
  const primary = fitRawEvidencePrompt(basePayload, limits.maxPromptChars);
  const recovery = fitRawEvidencePrompt(basePayload, limits.recoveryPromptChars);
  if (primary.compacted) warnings.push("raw_evidence_prompt_compacted");
  return {
    prompt: primary.prompt,
    recoveryPrompt: recovery.prompt,
    warnings,
    promptChars: primary.prompt.length,
    promptTruncated: primary.compacted,
    authoritativeOfficialDirectId: "",
    authoritativeOfficialDirect: null,
    allowedEvidenceIds: rawEvidenceIds(primary.payload?.evidence || rawEvidence),
    allowedAnswerLevels: ["rule_analysis", "low_confidence_analysis", "needs_more_info", "budget_limited"],
    rawEvidenceOnly: true,
  };
}

function prepareRawEvidence(evidence, limits, warnings) {
  const result = {};
  for (const bucket of EVIDENCE_BUCKETS) {
    const downgradedDirectCandidates = bucket === "officialQaRelated"
      ? (Array.isArray(evidence?.officialQaDirectCandidates)
          ? evidence.officialQaDirectCandidates.map((item) => ({ item, downgradedDirectCandidate: true }))
          : [])
      : [];
    const ordinaryCandidates = (Array.isArray(evidence?.[bucket]) ? evidence[bucket] : [])
      .map((item) => ({ item, downgradedDirectCandidate: false }));
    const source = [...downgradedDirectCandidates, ...ordinaryCandidates]
      .filter(({ item }) => bucket !== "rawRelatedEvidence" || isRawRelatedRecord(item));
    if (downgradedDirectCandidates.length) {
      warnings.push(`raw_official_qa_candidates_downgraded:${downgradedDirectCandidates.length}`);
    }
    const perBucketLimit = bucket === "provisionalOfficialResponses"
      ? limits.maxOfficialQa
      : bucket === "cardTexts" || bucket === "userProvidedCardTexts"
        ? limits.maxCards
        : limits.maxRelatedEvidence;
    if (source.length > perBucketLimit) {
      warnings.push(`raw_${bucket}_limited:${source.length}->${perBucketLimit}`);
    }
    const textLimit = bucket === "cardTexts" || bucket === "userProvidedCardTexts"
      ? limits.maxCardTextChars
      : limits.maxEvidenceTextChars;
    result[bucket] = source
      .slice(0, perBucketLimit)
      .map(({ item, downgradedDirectCandidate }) => sanitizeRawEvidenceItem(item, {
        bucket,
        textLimit,
        downgradedDirectCandidate,
      }))
      .filter((item) => item.id || item.text || item.title);
  }
  return result;
}

function sanitizeRawEvidenceItem(item = {}, { bucket, textLimit, downgradedDirectCandidate = false }) {
  const rawText = String(
    item.fullText
      || item.text
      || item.officialText
      || item.answer
      || item.effectText
      || "",
  );
  const rawTitle = String(item.title || item.name || item.cardName || "");
  return removeEmpty({
    id: String(item.id || item.evidenceId || ""),
    type: String(item.type || item.recordType || sourceTypeForBucket(bucket)),
    bucket,
    title: selectCompletePassages(rawTitle, 180),
    text: selectCompletePassages(rawText, textLimit),
    sourceUrl: String(item.sourceUrl || ""),
    source: String(item.source || item.sourceId || ""),
    sourceName: String(item.sourceName || ""),
    sourceRecordId: String(item.sourceRecordId || ""),
    docname: String(item.docname || ""),
    paragraphStart: finiteOrNull(item.paragraphStart),
    paragraphEnd: finiteOrNull(item.paragraphEnd),
    authority: String(item.authority || ""),
    sourceType: String(item.sourceType || ""),
    sourceTier: String(item.sourceTier || ""),
    status: String(item.status || item.displayStatus || ""),
    official: item.official === true
      && Boolean(getTrustedRawGenericRecordProvenance(item)),
    relationToQuestion: downgradedDirectCandidate
      ? "related_unverified"
      : String(item.relationToQuestion || ""),
    automaticDirectAuthority: bucket === "officialQaDirectCandidates" && !downgradedDirectCandidate,
    retrievalDisposition: downgradedDirectCandidate ? "downgraded_to_related" : "",
    cardIds: sanitizeStringList(item.cardIds, 12),
    questionCardIds: sanitizeStringList(item.questionCardIds, 12),
    cards: sanitizeStringList(item.cards || item.cardNames, 12),
    cardType: String(item.cardType || ""),
    attribute: primitiveOrEmpty(item.attribute),
    race: primitiveOrEmpty(item.race),
    atk: finiteOrNull(item.atk),
    def: finiteOrNull(item.def),
    level: finiteOrNull(item.level),
  });
}

function summarizeRawCards(cards = [], limit = 6) {
  return (Array.isArray(cards) ? cards : []).slice(0, limit).map((card) => removeEmpty({
    id: String(card?.id || card?.cardId || ""),
    name: String(card?.name || card?.cnName || card?.jaName || card?.enName || ""),
    aliases: sanitizeStringList(card?.aliases, 16),
    cnName: String(card?.cnName || ""),
    jaName: String(card?.jaName || ""),
    enName: String(card?.enName || ""),
    cardType: String(card?.cardType || card?.type || ""),
    attribute: primitiveOrEmpty(card?.attribute),
    race: primitiveOrEmpty(card?.race),
    atk: finiteOrNull(card?.atk),
    def: finiteOrNull(card?.def),
    level: finiteOrNull(card?.level),
    rank: finiteOrNull(card?.rank),
    link: finiteOrNull(card?.link),
    properties: sanitizeStringList(card?.properties, 12),
    monsterProperties: sanitizeStringList(card?.monsterProperties, 12),
    source: String(card?.source || ""),
    sourceUrl: String(card?.sourceUrl || ""),
    effectText: String(card?.effectText || card?.text || ""),
  }));
}

function fitRawEvidencePrompt(basePayload, maxPromptChars) {
  const profiles = [
    { query: 8000, cards: 8, cardText: 3200, totalEvidence: 64, evidenceText: 2800 },
    { query: 2400, cards: 6, cardText: 1800, totalEvidence: 36, evidenceText: 1400 },
    { query: 1600, cards: 6, cardText: 1200, totalEvidence: 21, evidenceText: 900 },
    { query: 1000, cards: 4, cardText: 800, totalEvidence: 12, evidenceText: 600 },
    { query: 600, cards: 3, cardText: 480, totalEvidence: 7, evidenceText: 320 },
    { query: 300, cards: 2, cardText: 240, totalEvidence: 3, evidenceText: 180 },
  ];
  for (let index = 0; index < profiles.length; index += 1) {
    const payload = compactRawPayload(basePayload, profiles[index]);
    const prompt = renderRawEvidencePrompt(payload);
    if (prompt.length <= maxPromptChars) return { prompt, payload, compacted: index > 0 };
  }
  const payload = compactRawPayload(basePayload, {
    query: 120,
    cards: 1,
    cardText: 80,
    totalEvidence: 1,
    evidenceText: 80,
  });
  const prompt = renderMinimalRawEvidencePrompt(payload);
  if (prompt.length <= maxPromptChars) return { prompt, payload, compacted: true };
  throw new RawEvidencePromptCapacityError({
    path: "ordinary",
    maxPromptChars,
    minimumPromptChars: prompt.length,
  });
}

function compactRawPayload(basePayload, profile) {
  const evidence = takeEvidenceRoundRobin(
    basePayload.evidence,
    profile.totalEvidence,
    profile.evidenceText,
  );
  return {
    userQuery: String(basePayload.userQuery || ""),
    resolvedCards: (basePayload.resolvedCards || []).slice(0, profile.cards).map((card) => ({
      ...card,
      effectText: selectCompletePassages(card.effectText, profile.cardText),
    })),
    unresolvedMentions: (basePayload.unresolvedMentions || []).slice(0, 8),
    ambiguousMentions: (basePayload.ambiguousMentions || []).slice(0, 8),
    evidence,
    allowedEvidenceIds: rawEvidenceIds(evidence),
  };
}

function takeEvidenceRoundRobin(evidence = {}, totalLimit, textLimit) {
  const result = Object.fromEntries(EVIDENCE_BUCKETS.map((bucket) => [bucket, []]));
  let count = 0;
  for (let index = 0; count < totalLimit; index += 1) {
    let added = false;
    for (const bucket of COMPACT_BUCKET_ORDER) {
      const item = evidence?.[bucket]?.[index];
      if (!item || count >= totalLimit) continue;
      result[bucket].push({
        ...item,
        text: selectCompletePassages(item.text, textLimit),
      });
      count += 1;
      added = true;
    }
    if (!added) break;
  }
  return result;
}

function renderRawEvidencePrompt(payload) {
  return [
    "你是游戏王 OCG 规则分析助手。只根据用户题面和下方原始资料回答，不得编造规则、卡文、裁定或来源。",
    "当前是普通分析路径，没有任何经过严格授权、可直接确认本题结论的官方 Q&A。officialQaRelated 中的官方资料（包括被降级的检索候选）都只能按实际覆盖范围辅助分析，不能自动视为本题直接裁定。",
    "不得因为资料标题、卡名、题面暗示或历史题目猜答案。相似 FAQ/Q&A 只能支持其文字实际覆盖的条件与处理，不得把相似场景扩大成对本题其余条件的直接证明；资料未覆盖的事实保持不确定。",
    "把用户明确提出的每个子问题分别作答，不要省略任何分支。对每个相关子问题分别核对：(1) 发动或适用条件检查时是否合法；(2) 连锁处理或效果处理时是否适用、成功以及处理到哪一步；(3) 剩余处理、后续处理或另开连锁的结果。不得用处理时成功与否反推发动是否合法，也不得因能发动就假定处理一定成功。",
    "每个结论都要区分依据层级：资料直接覆盖、由已确认卡文与通用规则资料推导、或仍不确定。不要把推导写成官方直接裁定。",
    "unresolvedMentions 或 ambiguousMentions 只影响确实依赖该身份的子问题；若其他子问题可由已确认卡文或资料独立回答，仍须回答它们。只有全部关键子问题都因缺失信息无法判断时，才整体使用 needs_more_info。",
    "先直接给出各子问题的结论，再简要说明依据。不要添加题面没有给出的场面、步骤或卡片身份。",
    "本路径不得输出 official_confirmed；只能使用 rule_analysis、low_confidence_analysis 或 needs_more_info。",
    "输出单个 JSON 对象，不要 markdown 或 JSON 外文字。字段必须为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。",
    `answerLevel 只能是：${ANSWER_LEVELS.join(", ")}。`,
    "usedEvidence 只能逐字引用 allowedEvidenceIds 中存在的 id；没有实际引用时输出空数组。不得引用任何未出现在上下文中的派生结论。",
    "以下 JSON 仅展示输出结构，不是本题答案：",
    JSON.stringify(OUTPUT_EXAMPLE),
    "本次原始检索上下文：",
    JSON.stringify(payload),
  ].join("\n");
}

function renderMinimalRawEvidencePrompt(payload) {
  return [
    "只依据下方用户题面和原始资料回答游戏王 OCG 问题；不得编造。逐子问题回答，并分别核对发动是否合法、处理时是否适用或成功、以及剩余后续处理，不能混为同一结论。",
    "标明结论是资料直证、由卡文和通用规则推导、还是不确定。相似FAQ不得扩大覆盖；一个未解析名称只阻断依赖它的子问题，不能让可独立回答的部分一起拒答。",
    "这是不含严格授权官方直接Q&A的普通分析路径；相关官方资料不自动确认本题结论。不得用official_confirmed，只能用rule_analysis、low_confidence_analysis或needs_more_info。",
    "只输出JSON：answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。usedEvidence id只能取allowedEvidenceIds。",
    JSON.stringify(payload),
  ].join("\n");
}

function fitOfficialDirectPrompt({ userQuery, resolvedCards, directEvidence, maxPromptChars }) {
  const profiles = [
    { query: 8000, cards: 8, cardText: 1600, evidenceText: 5000 },
    { query: 1600, cards: 6, cardText: 600, evidenceText: 2400 },
    { query: 800, cards: 4, cardText: 240, evidenceText: 1200 },
    { query: 300, cards: 2, cardText: 100, evidenceText: 500 },
  ];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const payload = {
      userQuery: String(userQuery || ""),
      resolvedCards: (resolvedCards || []).slice(0, profile.cards).map((card) => ({
        ...card,
        effectText: selectCompletePassages(card.effectText, profile.cardText),
      })),
      officialQaDirectCandidate: {
        ...directEvidence,
        text: selectCompletePassages(directEvidence.text, profile.evidenceText),
      },
      allowedEvidenceIds: directEvidence.id ? [directEvidence.id] : [],
    };
    const prompt = renderOfficialDirectPrompt(payload);
    if (prompt.length <= maxPromptChars) return { prompt, compacted: index > 0 };
  }
  const payload = {
    userQuery: String(userQuery || ""),
    resolvedCards: (resolvedCards || []).slice(0, 1).map((card) => ({
      ...card,
      effectText: selectCompletePassages(card.effectText, 80),
    })),
    officialQaDirectCandidate: {
      id: directEvidence.id,
      type: directEvidence.type,
      title: selectCompletePassages(directEvidence.title, 80),
      text: selectCompletePassages(directEvidence.text, 120),
    },
    allowedEvidenceIds: directEvidence.id ? [directEvidence.id] : [],
  };
  const prompt = renderOfficialDirectPrompt(payload);
  if (prompt.length <= maxPromptChars) return { prompt, compacted: true };
  throw new RawEvidencePromptCapacityError({
    path: "official_direct",
    maxPromptChars,
    minimumPromptChars: prompt.length,
  });
}

function renderOfficialDirectPrompt(payload) {
  return [
    "你是游戏王 OCG 官方 Q&A 转述助手。下方唯一 officialQaDirectCandidate 已由上游严格确认与本题场景完全一致。",
    "以该官方 Q&A 为最高依据完整回答用户的每个子问题；分别说明发动或适用是否合法、处理时是否成功、以及资料实际说明的剩余后续处理，不要把这些阶段混为一谈。",
    "官方资料没有说明的处理必须明确保持不确定，不得自行扩大该 Q&A 的覆盖范围，也不要被其他相似场景改写。",
    "只输出单个 JSON 对象，字段为 answerLevel、shortAnswer、reasoning、usedCards、usedEvidence、missingInfo、riskFlags、confidenceSelfEstimate。answerLevel 使用 official_confirmed。",
    "usedEvidence 只能引用 allowedEvidenceIds 中的 id。不要输出 markdown 或 JSON 外文字。",
    JSON.stringify(payload),
  ].join("\n");
}

export function selectStrictOfficialDirectCandidate({
  candidates = [],
  userQuery = "",
  cardResolution = {},
  baigeAmbiguousMentions = [],
  selector = true,
} = {}) {
  const source = Array.isArray(candidates) ? candidates : [];
  if (!selector) return null;
  let eligibleSource = source;
  if (selector && typeof selector === "object") {
    const selectedId = String(selector.id || selector.evidenceId || "");
    eligibleSource = source.filter((item) => item === selector || (
      selectedId && String(item?.id || item?.evidenceId || "") === selectedId
    ));
  }
  if (typeof selector === "string" && selector.trim()) {
    eligibleSource = source.filter((item) => (
      String(item?.id || item?.evidenceId || "") === selector.trim()
    ));
  }
  if (eligibleSource.length !== 1) return null;
  const [candidate] = eligibleSource;
  const completeIdentity = !(cardResolution.unresolvedMentions || []).length
    && !(cardResolution.ambiguousMentions || []).length
    && !(cardResolution.omittedResolvedCards || []).length
    && !(baigeAmbiguousMentions || []).length;
  if (!completeIdentity) return null;
  const resolvedCardIds = normalizeNumericIdSet(
    (cardResolution.resolvedCards || []).map(rawGenericCorpusCardId),
  );
  const questionCardIds = normalizeNumericIdSet(candidate?.questionCardIds);
  const exactQuestionCardSet = resolvedCardIds.length > 0
    && resolvedCardIds.length === (cardResolution.resolvedCards || []).length
    && equalStringSets(questionCardIds, resolvedCardIds);
  const exactNormalizedQuestion = Boolean(normalizeLiteralQuestion(userQuery))
    && normalizeLiteralQuestion(candidate?.question) === normalizeLiteralQuestion(userQuery);
  const status = String(candidate?.status || "").trim().toLowerCase();
  const activeOfficialRecord = candidate?.official === true
    && ["active", "confirmed", "current"].includes(status);
  return candidate?.isDirect === true
    && candidate?.matchLevel === "official_qa_exact"
    && candidate?.type === "official_qa"
    && exactNormalizedQuestion
    && exactQuestionCardSet
    && activeOfficialRecord
    && Boolean(getTrustedRawGenericRecordProvenance(candidate))
    && Boolean(candidate?.id)
    && Boolean(candidate?.fullText || candidate?.text || candidate?.answer || candidate?.officialText)
    ? candidate
    : null;
}

function normalizeLiteralQuestion(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[，,。.!！?？;；:：、()（）\[\]{}]/gu, "")
    .trim();
}

function normalizeNumericIdSet(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, ""))
    .filter(Boolean))]
    .sort();
}

function equalStringSets(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isRawRelatedRecord(item = {}) {
  const source = String(item.source || item.sourceId || "").toLowerCase();
  return !DERIVED_RAW_RELATED_SOURCES.has(source);
}

function rawEvidenceIds(evidence = {}) {
  return [...new Set(EVIDENCE_BUCKETS.flatMap((bucket) => (
    (evidence?.[bucket] || []).map((item) => String(item?.id || "").trim())
  )).filter(Boolean))];
}

function sanitizeMentionList(items = []) {
  return (Array.isArray(items) ? items : []).slice(0, 12).map((item) => {
    if (typeof item === "string") return item;
    const candidateCards = Array.isArray(item?.candidateCards)
      ? item.candidateCards
      : Array.isArray(item?.candidates)
        ? item.candidates
        : [];
    return removeEmpty({
      input: String(item?.input || item?.mention || item?.name || ""),
      reason: String(item?.reason || ""),
      candidateCards: sanitizeStringList(candidateCards.map((candidate) => (
        candidate?.name || candidate?.cnName || candidate?.jaName || candidate
      )), 8),
    });
  });
}

function sourceTypeForBucket(bucket) {
  const types = {
    officialQaDirectCandidates: "official_direct_qa",
    officialQaRelated: "official_related_qa",
    provisionalOfficialResponses: "official_response_screenshot",
    faqRelated: "faq_related",
    cardTexts: "card_text",
    userProvidedCardTexts: "user_provided_text",
    rawRelatedEvidence: "raw_related",
  };
  return types[bucket] || "raw_related";
}

function selectCompletePassages(value, maxChars) {
  const text = String(value || "");
  const limit = Math.max(1, Number(maxChars) || 1);
  if (text.length <= limit) return text;
  const units = completeTextUnits(text);
  // A single overlong unit cannot be shortened without inventing a fragment.
  // Leave it complete and let the enclosing prompt capacity gate fail closed.
  if (units.length <= 1) return text;
  const omission = "\n[… omitted complete passages …]\n";
  const selected = new Set();
  let used = 0;
  for (const index of [0, units.length - 1]) {
    if (selected.has(index)) continue;
    const separatorCost = selected.size ? omission.length : 0;
    if (used + separatorCost + units[index].length > limit) continue;
    selected.add(index);
    used += separatorCost + units[index].length;
  }
  for (let index = 1; index < units.length - 1; index += 1) {
    const separatorCost = selected.size ? omission.length : 0;
    if (used + separatorCost + units[index].length > limit) continue;
    selected.add(index);
    used += separatorCost + units[index].length;
  }
  if (!selected.size) {
    return units.reduce((shortest, unit) => unit.length < shortest.length ? unit : shortest);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => units[index])
    .join(omission);
}

function completeTextUnits(value) {
  const paragraphs = String(value || "")
    .split(/(?:\r?\n){2,}/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const units = [];
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^。！？!?；;\r\n]+(?:[。！？!?；;]+|$)/gu) || [];
    if (sentences.length > 1) units.push(...sentences.map((item) => item.trim()).filter(Boolean));
    else units.push(paragraph);
  }
  return units.length ? units : [String(value || "")];
}

function sanitizeStringList(items, limit) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function primitiveOrEmpty(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? value : "";
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function removeEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === "" || value === null || value === undefined) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
