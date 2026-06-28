import { buildCardProfile, buildCardProfiles, selectRelevantCardSections } from "./cardProfile.mjs";
import { normalizeRulingSourceMetadata } from "./rulingVersioning.mjs";

const issueKeywords = {
  activation_legality: ["发动", "発動", "activate"],
  effect_resolution: ["效果处理", "处理时", "適用", "resolve"],
  copy_or_gain_effect: ["得到效果", "得到和", "复制", "同じ効果", "gain", "copy"],
  copied_effect_scope: ["发动手续", "效果外文本", "处理内容", "copy"],
  piercing_battle_damage: ["贯穿", "貫通", "守备力", "战斗伤害", "piercing"],
  unaffected_by_effect: ["不受效果", "不受怪兽效果", "効果を受けない", "unaffected"],
  continuous_effect_application: ["永续效果", "适用中", "立即适用", "continuous"],
  battle_damage_calculation: ["战斗伤害", "伤害计算", "戦闘ダメージ", "battle damage"],
  atk_def_modification: ["攻击力", "守备力", "攻撃力", "守備力", "ATK", "DEF"],
  simultaneous_processing: ["同时", "那之后", "然后", "同一时点", "then"],
  damage_step_timing: ["伤害步骤", "伤害计算", "ダメージステップ", "damage step"],
  attack_target_legality: ["直接攻击", "攻击对象", "只能攻击", "attack target"],
  pendulum_effect_scope: ["灵摆效果", "P效果", "ペンデュラム効果", "pendulum effect"],
  same_chain_cost_or_procedure: ["连锁", "再次展示", "费用", "コスト", "same chain"],
  once_per_turn_scope: ["1回合1次", "再次", "once per turn"],
};

export function resolveCardsForFastJudge(question, cards = []) {
  const text = String(question || "");
  const quoted = extractQuotedNames(text);
  const unresolvedCards = [];
  const blockedAliases = new Set();
  const resolved = new Map();

  for (const name of quoted) {
    const exact = findExactCard(name, cards);
    if (exact) {
      resolved.set(cardKey(exact), { ...exact, matched: name, resolution: "exact_quoted_name" });
      continue;
    }
    const candidates = rankCardCandidates(name, cards).slice(0, 5);
    if (!candidates.length && normalize(name).length <= 3) continue;
    unresolvedCards.push({
      unresolvedCardName: name,
      candidateCards: candidates.slice(0, 3).map((item) => ({ name: displayName(item.card), cardId: String(item.card.id || ""), reason: item.reason, score: item.score })),
    });
    for (const item of candidates) for (const alias of aliases(item.card)) blockedAliases.add(normalize(alias));
  }

  const masked = maskQuotedNames(text);
  const matches = [];
  for (const card of cards) {
    for (const alias of aliases(card).sort((left, right) => right.length - left.length)) {
      const normalizedAlias = normalize(alias);
      if (normalizedAlias.length < 3 || blockedAliases.has(normalizedAlias)) continue;
      const index = normalize(masked).indexOf(normalizedAlias);
      if (index >= 0) matches.push({ card, alias, length: normalizedAlias.length });
    }
  }
  matches.sort((left, right) => right.length - left.length);
  for (const item of matches) {
    const key = cardKey(item.card);
    if (!resolved.has(key)) resolved.set(key, { ...item.card, matched: item.alias, resolution: "exact_alias" });
  }

  return { resolvedCards: [...resolved.values()], unresolvedCards: dedupeUnresolved(unresolvedCards) };
}

export function buildRulingContextPack({ question, resolvedCards = [], unresolvedCards = [], cardProfiles, issueFrames, snapshot = {} } = {}) {
  const profiles = cardProfiles || buildCardProfiles(resolvedCards);
  const frames = [...(issueFrames?.primaryIssueFrames || []), ...(issueFrames?.secondaryIssueFrames || [])];
  const relevantCardSections = profiles
    .flatMap((profile) => selectRelevantCardSections(profile, frames, question, 10))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map(({ score, ...entry }) => entry);
  const embeddedSections = extractEmbeddedCardSections(question, Math.max(0, 10 - relevantCardSections.length));
  relevantCardSections.push(...embeddedSections);

  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  const officialQaCandidates = rankRecords(records.filter((item) => item.recordType === "qa"), question, resolvedCards, frames).slice(0, 8);
  const faqCandidates = rankRecords(records.filter((item) => item.recordType === "card-faq"), question, resolvedCards, frames).slice(0, 8);
  const ruleSnippets = rankRecords(records.filter((item) => item.recordType === "rule-doc"), question, resolvedCards, frames)
    .slice(0, 8)
    .map((item) => ({ ...item, text: relevantExcerpt(item.text, frames, 1000) }));
  const knownAnalogies = rankRecords(records.filter((item) => ["qa", "card-faq"].includes(item.recordType)), question, [], frames)
    .filter((item) => !sameCardRecord(item, resolvedCards))
    .slice(0, 5);
  const counterEvidenceCandidates = [...officialQaCandidates, ...faqCandidates, ...knownAnalogies]
    .filter((item) => /不能|不可以|できません|cannot|does not|不适用|受けない/iu.test(item.text))
    .slice(0, 5);

  return {
    question: String(question || ""),
    normalizedScenario: normalizeScenario(question),
    resolvedCards: resolvedCards.map(summarizeCard),
    unresolvedCards,
    cardProfiles: profiles,
    userProvidedCardText: profiles.filter((profile) => profile.sourceMetadata?.sourceType === "user_provided_card_text").map((profile) => ({
      cardId: profile.cardId,
      cardName: profile.names.zh || profile.names.ja || profile.names.en,
      metadata: profile.sourceMetadata,
    })),
    relevantCardSections,
    issueFrames,
    officialQaCandidates,
    faqCandidates,
    ruleSnippets,
    knownAnalogies,
    counterEvidenceCandidates,
    limits: { cardSections: 10, officialQa: 8, faq: 8, ruleSnippets: 8, analogyRefs: 5 },
  };
}

export function buildTemporaryCardProfiles(question, unresolvedCards = [], now = new Date().toISOString()) {
  const texts = extractFullEffectTexts(question);
  if (!texts.length || !unresolvedCards.length) return [];
  return texts.slice(0, unresolvedCards.length).map((text, index) => {
    const unresolved = unresolvedCards[index] || unresolvedCards[0];
    const name = unresolved.unresolvedCardName;
    const asksPendulum = /灵摆效果|P效果|ペンデュラム効果|Pendulum Effect/iu.test(`${question}\n${text}`);
    const profile = buildCardProfile({
      id: `user-card-${stableKey(name)}`,
      name,
      cnName: name,
      aliases: [name],
      cardType: asksPendulum ? "Pendulum Monster" : "monster",
      isPendulum: asksPendulum,
      effectText: text,
    });
    profile.isTemporary = true;
    profile.sourceMetadata = normalizeRulingSourceMetadata({
      id: profile.cardId,
      recordType: "user-provided-card-text",
      sourceType: "user_provided_card_text",
      lastCheckedAt: now,
      locale: "zh",
      format: "unknown",
      ruleEra: "current",
      staleRisk: "possible",
    });
    return profile;
  });
}

function rankRecords(records, question, resolvedCards, frames) {
  const cardIds = new Set(resolvedCards.map((item) => normalizeId(item.id || item.cardId)).filter(Boolean));
  const names = new Set(resolvedCards.flatMap(aliases).map(normalize).filter(Boolean));
  const keywords = [...new Set(frames.flatMap((frame) => issueKeywords[frame.id] || []))];
  const questionTokens = tokenize(question);
  return records
    .map((record) => {
      const text = recordText(record);
      const normalizedText = normalize(text);
      const recordIds = new Set([record.cardId, ...(record.cardIds || [])].map(normalizeId).filter(Boolean));
      const recordNames = new Set((record.cards || []).map(normalize).filter(Boolean));
      const idMatch = [...cardIds].some((id) => recordIds.has(id));
      const nameMatch = [...names].some((name) => recordNames.has(name) || normalizedText.includes(name));
      const keywordHits = keywords.filter((keyword) => normalizedText.includes(normalize(keyword)));
      const tokenHits = questionTokens.filter((token) => token.length >= 2 && normalizedText.includes(token)).slice(0, 8);
      const score = (idMatch ? 100 : 0) + (nameMatch ? 55 : 0) + keywordHits.length * 12 + tokenHits.length * 2;
      return {
        id: String(record.id || "unknown"),
        source: record.sources?.[0]?.label || record.recordType || "unknown",
        recordType: record.recordType,
        title: String(record.title || ""),
        cardIds: [...recordIds],
        cards: record.cards || [],
        score,
        matchedBy: [idMatch && "card_id", nameMatch && "card_name", keywordHits.length && "issue_frame", tokenHits.length && "question_phrase"].filter(Boolean),
        text: trimText(text, 1800),
        sourceUrl: record.sourceUrl || record.sources?.[0]?.detail || "",
        metadata: normalizeRulingSourceMetadata(record),
        record,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function extractFullEffectTexts(question) {
  const result = [];
  for (const match of String(question || "").matchAll(/[『“"]([^』”"]{12,1400})[』”"]/gu)) {
    const text = clean(match[1]);
    if (/[①②③④⑤⑥⑦⑧⑨⑩]|发动|效果|発動|効果|activate|effect/iu.test(text)) result.push(text);
  }
  return result;
}

function extractEmbeddedCardSections(question, limit) {
  if (limit <= 0) return [];
  const sections = [];
  for (const match of String(question || "").matchAll(/[『“"]([^』”"]{12,900})[』”"]/gu)) {
    sections.push({
      effectNo: "unknown",
      section: "otherText",
      text: clean(match[1]),
      tags: ["embedded_question_card_text"],
      cardId: "",
      cardName: "题目内嵌效果文本",
    });
    if (sections.length >= limit) break;
  }
  return sections;
}

function extractQuotedNames(text) {
  const result = [];
  for (const match of String(text || "").matchAll(/[「『“"【]([^」』”"】\n]{2,80})[」』”】]/gu)) {
    const name = clean(match[1]);
    if (name.length <= 40 && !/[。；;：:].{12,}/u.test(name)) result.push(name);
  }
  return [...new Set(result)];
}

function maskQuotedNames(text) {
  return String(text || "").replace(/[「『“"【]([^」』”"】\n]{2,80})[」』”】]/gu, (full, inner) => (clean(inner).length <= 40 ? " " : full));
}

function findExactCard(name, cards) {
  const key = normalize(name);
  return cards.find((card) => aliases(card).some((alias) => normalize(alias) === key)) || null;
}

function rankCardCandidates(name, cards) {
  const key = normalize(name);
  return cards
    .map((card) => {
      let score = 0;
      let bestAlias = "";
      for (const alias of aliases(card)) {
        const candidate = normalize(alias);
        const candidateScore = similarity(key, candidate);
        if (candidateScore > score) {
          score = candidateScore;
          bestAlias = alias;
        }
      }
      return { card, score: Number(score.toFixed(3)), reason: key.includes(normalize(bestAlias)) ? "shorter contained alias, requires confirmation" : "approximate alias, requires confirmation" };
    })
    .filter((item) => item.score >= 0.42)
    .sort((left, right) => right.score - left.score);
}

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.92;
  const a = bigrams(left);
  const b = bigrams(right);
  const overlap = [...a].filter((item) => b.has(item)).length;
  return (2 * overlap) / Math.max(1, a.size + b.size);
}

function bigrams(value) {
  const set = new Set();
  for (let index = 0; index < value.length - 1; index += 1) set.add(value.slice(index, index + 2));
  return set;
}

function relevantExcerpt(text, frames, maxLength) {
  const value = clean(text);
  const keywords = frames.flatMap((frame) => issueKeywords[frame.id] || []);
  const index = keywords.map((keyword) => value.search(new RegExp(escapeRegExp(keyword), "iu"))).filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? 0;
  return trimText(value.slice(Math.max(0, index - 180)), maxLength);
}

function sameCardRecord(item, cards) {
  const ids = new Set(cards.map((card) => normalizeId(card.id)).filter(Boolean));
  return (item.cardIds || []).some((id) => ids.has(normalizeId(id)));
}

function recordText(record) {
  return clean([record.title, record.question, record.conclusion, record.text, record.officialText, record.evidenceText].filter(Boolean).join("\n"));
}

function normalizeScenario(question) {
  return clean(question).replace(/[？?]+$/u, "");
}

function summarizeCard(card) {
  return {
    cardId: String(card.id || card.cardId || ""),
    name: displayName(card),
    names: { zh: card.cnName || card.name || "", ja: card.jaName || "", en: card.enName || "" },
    matched: card.matched || "",
  };
}

function aliases(card) {
  return [...new Set([card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].map(clean).filter(Boolean))];
}

function displayName(card) {
  return String(card.cnName || card.name || card.jaName || card.enName || "unknown");
}

function cardKey(card) {
  return normalizeId(card.id || card.cardId) || normalize(displayName(card));
}

function normalizeId(value) {
  const digits = String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
  return digits;
}

function tokenize(text) {
  return [...new Set(normalize(text).split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2))];
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[\s·・_－—–-]+/gu, "");
}

function clean(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function trimText(value, maxLength) {
  const text = clean(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function dedupeUnresolved(items) {
  const map = new Map();
  for (const item of items) if (!map.has(normalize(item.unresolvedCardName))) map.set(normalize(item.unresolvedCardName), item);
  return [...map.values()];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stableKey(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
