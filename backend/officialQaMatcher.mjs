const QUESTION_TYPES = [
  ["who_can_activate", /(?:谁(?:可以|能)?.*发动|由谁发动)|誰が.*発動|who (?:can|may) activate|which player.*activate/iu],
  ["card_activation_vs_effect_activation", /卡的发动.*效果发动|效果发动.*卡的发动|カードの発動.*効果の発動|card activation.*effect activation/iu],
  ["copy_effect_procedure", /复制.*效果|复制.*发动手续|同じ効果.*発動|copy.*effect|copied effect/iu],
  ["target_legality", /能否.*(?:取|选择).*对象|不能成为.*对象|対象に.*(?:できます|できません)|can(?:not)? target|legal target/iu],
  ["timing_window", /时点|伤害步骤|伤害计算|错过时点|タイミング|ダメージステップ|timing|damage step/iu],
  ["continuous_effect_during_resolution", /效果处理中.*(?:永续|持续|自坏)|処理中.*永続|continuous effect.*resol/iu],
  ["resolution_result", /如何处理|怎么处理|处理后|效果处理|どう処理|resolution|resolve/iu],
  ["can_activate", /能否发动|可以发动|不能发动|発動できますか|発動できません|can(?:not)? (?:be )?activate/iu],
];

const EFFECT_PHRASES = [
  ["who_can_activate", /谁可以发动|谁能发动|由谁发动|誰が.*発動|who can activate/iu],
  ["control_change", /控制权|コントロール|control/iu],
  ["after_chain_resolution", /连锁处理后|チェーン処理後|after (?:the )?chain resolves/iu],
  ["copy_effect", /复制效果|同じ効果|copy.*effect/iu],
  ["target", /取对象|选择对象|対象|target/iu],
  ["card_activation", /卡的发动|カードの発動|card activation/iu],
  ["effect_activation", /效果发动|効果の発動|effect activation/iu],
  ["during_resolution", /效果处理中|処理中|during resolution/iu],
  ["damage_step", /伤害步骤|ダメージステップ|damage step/iu],
  ["miss_timing", /错过时点|タイミングを逃|miss.*timing/iu],
  ["summon_response", /召唤成功时点|召喚成功時|summon response/iu],
];

export function normalizeOfficialQaQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』【】“”"'`]/gu, "")
    .replace(/[：:・·･－—–_\-]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]]/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

export function classifyOfficialQaQuestionType(value) {
  const text = String(value || "");
  return QUESTION_TYPES.find(([, pattern]) => pattern.test(text))?.[0] || "unknown";
}

export function extractOfficialQaEffectPhrases(value) {
  const text = String(value || "");
  return EFFECT_PHRASES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

export function searchOfficialQaEvidence({ question, records = [], resolvedCards = [], limit = 20 } = {}) {
  const query = String(question || "").trim();
  const normalizedQuery = normalizeOfficialQaQuery(query);
  const queryType = classifyOfficialQaQuestionType(query);
  const queryPhrases = extractOfficialQaEffectPhrases(query);
  const resolvedIds = new Set((resolvedCards || []).map((card) => normalizeId(card.id || card.cardId)).filter(Boolean));
  const resolvedNames = new Set((resolvedCards || []).flatMap(cardAliases).map(normalizeOfficialQaQuery).filter(Boolean));

  const ranked = (records || [])
    .filter((record) => ["qa", "card-faq", "official-database"].includes(record.recordType))
    .map((record) => scoreRecord({ record, query, normalizedQuery, queryType, queryPhrases, resolvedIds, resolvedNames }))
    .filter((item) => item.score >= 0.2)
    .sort((left, right) => right.score - left.score || String(left.record.id).localeCompare(String(right.record.id)))
    .slice(0, Math.max(limit, 1));

  const exact = ranked.filter((item) => item.matchLevel === "official_qa_exact");
  const near = ranked.filter((item) => item.matchLevel === "official_qa_near");
  const related = ranked.filter((item) => item.matchLevel === "official_related");
  return {
    rawQuery: query,
    normalizedQuery,
    questionType: queryType,
    effectPhrases: queryPhrases,
    exact,
    near,
    related,
    all: ranked,
    searchPaths: ["raw_query_search", "normalized_query_search", "card_set_search", "effect_phrase_search", "fallback_alias_search"],
  };
}

export function resolveEntitiesFromOfficialQaMatch({ resolution = {}, matches, cards = [] } = {}) {
  const resolved = new Map((resolution.resolvedCards || []).map((card) => [cardKey(card), card]));
  const unresolved = [...(resolution.unresolvedCards || [])];
  const top = matches?.exact?.[0] || matches?.near?.find((item) => item.score >= 0.78) || null;
  if (!top) return buildEntityResolution(resolved, unresolved, false);

  const evidenceIds = new Set([top.record.cardId, ...(top.record.cardIds || []), ...(top.record.cards || [])].map(normalizeId).filter(Boolean));
  const evidenceText = normalizeOfficialQaQuery(recordText(top.record));
  let resolvedByOfficialQaMatch = false;
  const remaining = [];
  for (const mention of unresolved) {
    const candidate = (mention.candidateCards || []).find((item) => evidenceIds.has(normalizeId(item.cardId || item.id)))
      || (mention.candidateCards || []).find((item) => evidenceText.includes(normalizeOfficialQaQuery(item.name)));
    let selected = candidate && findCard(candidate.cardId || candidate.id, cards);
    if (!selected && top.matchLevel === "official_qa_exact" && evidenceIds.size === 1) selected = findCard([...evidenceIds][0], cards);
    if (!selected) {
      remaining.push(mention);
      continue;
    }
    resolved.set(cardKey(selected), { ...selected, matched: mention.unresolvedCardName, resolution: "official_qa_match" });
    resolvedByOfficialQaMatch = true;
  }
  return buildEntityResolution(resolved, remaining, resolvedByOfficialQaMatch);
}

function scoreRecord({ record, normalizedQuery, queryType, queryPhrases, resolvedIds, resolvedNames }) {
  const questionText = recordQuestionText(record);
  const normalizedRecordQuestion = normalizeOfficialQaQuery(questionText);
  const normalizedRecordText = normalizeOfficialQaQuery(recordText(record));
  const evidenceType = classifyOfficialQaQuestionType(questionText || recordText(record));
  const evidencePhrases = extractOfficialQaEffectPhrases(recordText(record));
  const typeCompatible = questionTypeCompatible(queryType, evidenceType);
  const exactNormalized = normalizedQuery.length >= 8 && normalizedRecordQuestion === normalizedQuery;
  const containment = containmentScore(normalizedQuery, normalizedRecordQuestion || normalizedRecordText);
  const similarity = diceSimilarity(normalizedQuery, normalizedRecordQuestion || normalizedRecordText.slice(0, normalizedQuery.length * 2));
  const phraseHits = queryPhrases.filter((phrase) => evidencePhrases.includes(phrase));
  const recordIds = new Set([record.cardId, ...(record.cardIds || []), ...(record.cards || [])].map(normalizeId).filter(Boolean));
  const cardIdMatch = [...resolvedIds].some((id) => recordIds.has(id));
  const cardNameMatch = [...resolvedNames].some((name) => name.length >= 3 && normalizedRecordText.includes(name));
  const cardMatch = cardIdMatch || cardNameMatch;
  const rawExact = exactNormalized || (containment >= 0.9 && similarity >= 0.86);
  let score = Math.max(similarity, containment);
  if (typeCompatible && queryType !== "unknown") score += 0.16;
  if (cardMatch) score += 0.17;
  score += Math.min(0.18, phraseHits.length * 0.06);
  score = Math.min(1, Number(score.toFixed(4)));

  let matchLevel = "official_related";
  if (rawExact && typeCompatible) matchLevel = "official_qa_exact";
  else if (typeCompatible && (score >= 0.68 || (cardMatch && phraseHits.length && score >= 0.56))) matchLevel = "official_qa_near";
  return {
    id: String(record.id || "unknown"),
    record,
    matchLevel,
    score,
    questionType: evidenceType,
    typeCompatible,
    cardMatch,
    matchedBy: [rawExact && "raw_or_normalized_query", cardIdMatch && "card_id", cardNameMatch && "card_name", typeCompatible && "question_type", phraseHits.length && "effect_phrase"].filter(Boolean),
    matchedPhrases: phraseHits,
    questionText,
  };
}

function questionTypeCompatible(queryType, evidenceType) {
  if (queryType === "unknown" || evidenceType === "unknown") return queryType === evidenceType;
  if (queryType === evidenceType) return true;
  const activation = new Set(["can_activate", "timing_window"]);
  return activation.has(queryType) && activation.has(evidenceType);
}

function recordQuestionText(record = {}) {
  if (record.question) return String(record.question);
  const text = String(record.text || "");
  const marker = Math.max(text.indexOf("?"), text.indexOf("？"));
  if (marker >= 0) return text.slice(0, marker + 1).replace(String(record.title || ""), "").trim() || String(record.title || "");
  return String(record.title || "");
}

function recordText(record = {}) {
  return [record.title, record.question, record.answer, record.conclusion, record.text, record.officialText].filter(Boolean).join("\n");
}

function containmentScore(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (!left.includes(right) && !right.includes(left)) return 0;
  return Math.min(left.length, right.length) / Math.max(left.length, right.length);
}

function diceSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = bigrams(left);
  const b = bigrams(right);
  const overlap = [...a].filter((item) => b.has(item)).length;
  return (2 * overlap) / Math.max(1, a.size + b.size);
}

function bigrams(value) {
  const result = new Set();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function buildEntityResolution(resolved, unresolved, resolvedByOfficialQaMatch) {
  return {
    resolvedCards: [...resolved.values()],
    unresolvedMentions: unresolved,
    ambiguousMentions: unresolved.filter((item) => (item.candidateCards || []).length > 1),
    resolvedByOfficialQaMatch,
    confidence: resolvedByOfficialQaMatch ? 0.92 : unresolved.length ? 0.45 : 1,
  };
}

function findCard(id, cards) {
  const key = normalizeId(id);
  return (cards || []).find((card) => normalizeId(card.id || card.cardId) === key) || null;
}

function cardAliases(card = {}) {
  return [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
}

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}

function cardKey(card = {}) {
  return normalizeId(card.id || card.cardId) || normalizeOfficialQaQuery(card.cnName || card.name || card.jaName || card.enName);
}
