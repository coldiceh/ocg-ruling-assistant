const DEFAULT_MAX_PASSAGES = 16;
const DEFAULT_MAX_PASSAGE_CHARS = 1400;

export function retrieveRulebookPassages({
  records = [],
  userQuery = "",
  ruleSearchQueries = [],
  maxPassages = DEFAULT_MAX_PASSAGES,
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const terms = buildWeightedTerms({ userQuery, ruleSearchQueries });
  const anchors = extractQuotedAnchors(userQuery);
  if (!terms.length) return [];

  const candidates = [];
  for (const record of records || []) {
    if (!isRulebookRecord(record)) continue;
    const paragraphs = splitRulebookParagraphs(record.text);
    if (!paragraphs.length) continue;

    for (let index = 0; index < paragraphs.length; index += 1) {
      const score = scoreParagraph(paragraphs[index].text, record.title, terms, anchors);
      if (score <= 0) continue;
      const passage = buildPassage(record, paragraphs, index, score, maxPassageChars);
      if (passage) candidates.push(passage);
    }
  }

  const selected = [];
  const seen = new Set();
  const seenContent = new Set();
  for (const candidate of candidates.sort(comparePassages)) {
    if (seen.has(candidate.id)) continue;
    const contentKey = normalizeKey(candidate.text);
    if (contentKey && seenContent.has(contentKey)) continue;
    if (selected.some((item) => overlaps(item, candidate))) continue;
    seen.add(candidate.id);
    if (contentKey) seenContent.add(contentKey);
    selected.push(candidate);
    if (selected.length >= positiveInteger(maxPassages, DEFAULT_MAX_PASSAGES)) break;
  }
  return selected;
}

export function isRulebookRecord(record = {}) {
  const id = String(record.id || record.evidenceId || record.stableId || "");
  return record.recordType === "rule-doc"
    || record.sourceId === "ocg-rule"
    || id.startsWith("ocg-rule:");
}

function splitRulebookParagraphs(value) {
  return String(value || "")
    .split(/\n{2,}/u)
    .map((text, originalIndex) => ({ text: text.trim(), originalIndex }))
    .filter((item) => item.text && !isNavigationParagraph(item.text));
}

function buildPassage(record, paragraphs, hitIndex, score, maxPassageChars) {
  const limit = positiveInteger(maxPassageChars, DEFAULT_MAX_PASSAGE_CHARS);
  let start = Math.max(0, hitIndex - 1);
  let end = Math.min(paragraphs.length - 1, hitIndex + 1);
  let text = joinRange(paragraphs, start, end);

  while (text.length < limit * 0.72 && (start > 0 || end < paragraphs.length - 1)) {
    const previous = start > 0 ? paragraphs[start - 1].text : "";
    const next = end < paragraphs.length - 1 ? paragraphs[end + 1].text : "";
    if (previous && (!next || previous.length <= next.length)) start -= 1;
    else if (next) end += 1;
    else break;
    const expanded = joinRange(paragraphs, start, end);
    if (expanded.length > limit * 1.25) break;
    text = expanded;
  }

  if (!text) return null;
  if (text.length > limit) text = `${text.slice(0, Math.max(0, limit - 1))}…`;
  const sourceId = String(record.id || record.evidenceId || record.stableId || "rulebook");
  const originalStart = paragraphs[start].originalIndex + 1;
  const originalEnd = paragraphs[end].originalIndex + 1;
  return {
    id: `${sourceId}#p${originalStart}-${originalEnd}`,
    type: "rulebook",
    recordType: "rulebook-passage",
    title: `${record.title || sourceId} · 段落 ${originalStart}-${originalEnd}`,
    text,
    sourceUrl: record.sourceUrl || record.officialUrl || "",
    source: "rulebook_passage_retriever",
    sourceRecordId: sourceId,
    paragraphStart: originalStart,
    paragraphEnd: originalEnd,
    score,
    cardIds: [],
    cards: [],
    official: false,
    isDirect: false,
  };
}

function buildWeightedTerms({ userQuery, ruleSearchQueries }) {
  const weighted = new Map();
  addTerms(weighted, userQuery, 0.7);
  for (const query of ruleSearchQueries || []) {
    const confidence = String(query?.confidence || "medium").toLowerCase();
    const weight = confidence === "high" ? 3 : confidence === "low" ? 1 : 2;
    addTerms(weighted, query?.query || query, weight);
    addTerms(weighted, query?.reason || "", weight * 0.35);
  }
  return [...weighted.entries()]
    .map(([term, weight]) => ({ term, key: normalizeKey(term), weight }))
    .filter((item) => item.key.length >= 2)
    .sort((left, right) => right.weight - left.weight || right.key.length - left.key.length)
    .slice(0, 180);
}

function addTerms(target, value, baseWeight) {
  const segments = String(value || "")
    .normalize("NFKC")
    .split(/[\s，,。.!！?？;；、:：()（）\[\]【】「」『』《》/]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);

  for (const segment of segments) {
    addWeightedTerm(target, segment, baseWeight);
    const key = normalizeKey(segment);
    if (!/[\u3400-\u9fff]/u.test(key) || key.length <= 6) continue;
    for (let size = 2; size <= Math.min(5, key.length); size += 1) {
      for (let index = 0; index <= key.length - size; index += 1) {
        addWeightedTerm(target, key.slice(index, index + size), baseWeight * (size / 18));
      }
    }
  }
}

function addWeightedTerm(target, term, weight) {
  const key = normalizeKey(term);
  if (key.length < 2 || isLowSignalTerm(key)) return;
  target.set(key, Math.max(target.get(key) || 0, weight));
}

function scoreParagraph(paragraph, title, terms, anchors = []) {
  const paragraphKey = normalizeKey(paragraph);
  const titleKey = normalizeKey(title);
  let score = 0;
  let strongMatches = 0;
  for (const term of terms) {
    if (paragraphKey.includes(term.key)) {
      const lengthBoost = Math.min(3, Math.max(0.5, term.key.length / 4));
      score += term.weight * lengthBoost;
      if (term.key.length >= 4 && term.weight >= 1) strongMatches += 1;
    } else if (titleKey.includes(term.key)) {
      score += term.weight * 0.25;
    }
  }
  const matchedAnchors = anchors.filter((anchor) => paragraphKey.includes(anchor));
  for (const anchor of matchedAnchors) {
    score += 8 + Math.min(8, anchor.length / 2);
  }
  if (matchedAnchors.length >= 2) score += matchedAnchors.length * 6;
  if (!strongMatches && score < 1.5) return 0;
  return Math.round(score * 1000) / 1000;
}

function extractQuotedAnchors(value) {
  const source = String(value || "");
  const anchors = [];
  const patterns = [
    /「([^」]+)」/gu,
    /『([^』]+)』/gu,
    /《([^》]+)》/gu,
    /【([^】]+)】/gu,
    /\[([^\]]+)\]/gu,
    /“([^”]+)”/gu,
    /"([^"]+)"/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const key = normalizeKey(match[1]);
      if (key.length >= 2 && key.length <= 100) anchors.push(key);
    }
  }
  return [...new Set(anchors)];
}

function comparePassages(left, right) {
  return right.score - left.score
    || String(left.sourceRecordId).localeCompare(String(right.sourceRecordId))
    || left.paragraphStart - right.paragraphStart;
}

function overlaps(left, right) {
  if (left.sourceRecordId !== right.sourceRecordId) return false;
  return left.paragraphStart <= right.paragraphEnd && right.paragraphStart <= left.paragraphEnd;
}

function joinRange(paragraphs, start, end) {
  return paragraphs.slice(start, end + 1).map((item) => item.text).join("\n\n");
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}①②③④⑤⑥⑦⑧⑨]+/gu, "");
}

function isLowSignalTerm(value) {
  return /^(?:是否|能否|可以|怎么|如何|什么|这个|那个|效果|卡片|问题|玩家|自己|对方|场上)$/u.test(value);
}

function isNavigationParagraph(value) {
  const text = String(value || "").trim();
  if (/^(?:contents|menu|skip to content|toggle .*|expand|light mode|dark mode|auto light.*|hide navigation.*|hide table.*|back to top|view this page|ocg rule)$/iu.test(text)) return true;
  return text.length < 120 && /(toggle|navigation sidebar|table of contents|规则修订|toggle navigation)/iu.test(text);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
