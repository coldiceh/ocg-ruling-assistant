const DEFAULT_MAX_PASSAGES = 16;
const DEFAULT_MAX_PASSAGE_CHARS = 1400;
const RULE_RETRIEVAL_CONCEPT_GROUPS = Object.freeze([
  Object.freeze(["发动合法性", "判断时点", "发动条件"]),
  Object.freeze(["候选卡", "候选对象", "能适用的卡", "适用对象"]),
  Object.freeze(["适用顺序", "先后顺序", "处理顺序"]),
  Object.freeze(["组成连锁", "连锁顺序", "组链顺序"]),
]);

export function retrieveRulebookPassages({
  records = [],
  userQuery = "",
  ruleSearchQueries = [],
  maxPassages = DEFAULT_MAX_PASSAGES,
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const terms = buildWeightedTerms({ userQuery, ruleSearchQueries });
  const anchors = extractQuotedAnchors(userQuery);
  const reservedQueryGroups = buildReservedRuleQueryGroups(ruleSearchQueries, maxPassages);
  if (!terms.length) return [];

  const candidates = [];
  const reservedCandidates = new Map();
  for (const record of records || []) {
    if (!isRulebookRecord(record)) continue;
    const paragraphs = splitRulebookParagraphs(record.text);
    if (!paragraphs.length) continue;

    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index].text;
      const score = scoreParagraph(paragraph, record.title, terms, anchors);
      if (score > 0) {
        const passage = buildPassage(record, paragraphs, index, score, maxPassageChars);
        if (passage) candidates.push(passage);
      }
      for (const group of reservedQueryGroups) {
        const groupScore = Math.max(...group.views.map((view) => (
          scoreParagraph(paragraph, record.title, view.terms, view.anchors)
        )));
        if (groupScore <= 0) continue;
        const groupPassage = buildPassage(record, paragraphs, index, groupScore, maxPassageChars);
        const previous = reservedCandidates.get(group.key);
        if (groupPassage && (!previous || comparePassages(groupPassage, previous) < 0)) {
          reservedCandidates.set(group.key, groupPassage);
        }
      }
    }
  }

  const selected = [];
  const seen = new Set();
  const seenContent = new Set();
  const orderedCandidates = [
    ...reservedQueryGroups.map((group) => reservedCandidates.get(group.key)).filter(Boolean),
    ...candidates.sort(comparePassages),
  ];
  for (const candidate of orderedCandidates) {
    if (seen.has(candidate.id)) continue;
    const contentKey = normalizeKey(candidate.text);
    if (contentKey && seenContent.has(contentKey)) continue;
    if (selected.some((item) => coversCandidateMatch(item, candidate))) continue;
    seen.add(candidate.id);
    if (contentKey) seenContent.add(contentKey);
    selected.push(candidate);
    if (selected.length >= positiveInteger(maxPassages, DEFAULT_MAX_PASSAGES)) break;
  }
  return selected.map(({ matchParagraph: _matchParagraph, ...passage }) => passage);
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
  const hit = paragraphs[hitIndex];
  if (!hit?.text) return null;

  const listRange = findListAwareRange(paragraphs, hitIndex, limit);
  let start = listRange?.start ?? hitIndex;
  let end = listRange?.end ?? hitIndex;
  let text = joinRange(paragraphs, start, end);
  if (text.length <= limit) {
    while (start > 0 || end < paragraphs.length - 1) {
      if (end - start + 1 >= 5) break;
      const choices = [];
      if (start > 0) choices.push({ start: start - 1, end, side: "before" });
      if (end < paragraphs.length - 1) choices.push({ start, end: end + 1, side: "after" });
      choices.sort((left, right) => (
        joinRange(paragraphs, left.start, left.end).length - joinRange(paragraphs, right.start, right.end).length
        || (left.side === "before" ? -1 : 1)
      ));

      const next = choices.find((choice) => joinRange(paragraphs, choice.start, choice.end).length <= limit);
      if (!next) break;
      start = next.start;
      end = next.end;
      text = joinRange(paragraphs, start, end);
    }
  } else {
    text = truncateFocusedParagraph(text, limit);
  }

  const sourceId = String(record.id || record.evidenceId || record.stableId || "rulebook");
  const originalStart = paragraphs[start].originalIndex + 1;
  const originalEnd = paragraphs[end].originalIndex + 1;
  const retrievalScore = normalizeRulebookRelevance(score);
  return {
    matchParagraph: hit.originalIndex + 1,
    id: `${sourceId}#p${originalStart}-${originalEnd}`,
    type: "rulebook",
    recordType: "rulebook-passage",
    title: `${record.title || sourceId} · 段落 ${originalStart}-${originalEnd}`,
    text,
    sourceUrl: record.sourceUrl || record.officialUrl || "",
    source: "rulebook_passage_retriever",
    sourceName: record.sourceName || record.source || "rulebook_passage_retriever",
    sourceTier: record.sourceTier || "S2_COMMUNITY_REFERENCE",
    sourceAuthority: record.sourceAuthority || "community_reference",
    sourceRecordId: sourceId,
    paragraphStart: originalStart,
    paragraphEnd: originalEnd,
    // Keep a bounded score on the evidence object so a long rulebook page
    // cannot dominate a direct scene QA merely by repeating generic terms.
    // `rankingScore` retains the internal ordering signal.
    score: retrievalScore,
    retrievalScore,
    rankingScore: score,
    cardIds: [],
    cards: [],
    official: false,
    isDirect: false,
  };
}

function findListAwareRange(paragraphs, hitIndex, limit) {
  const firstCandidate = Math.max(0, hitIndex - 12);
  const lastCandidate = Math.min(paragraphs.length - 1, hitIndex + 2);
  for (let introIndex = lastCandidate; introIndex >= firstCandidate; introIndex -= 1) {
    if (!isListIntroduction(paragraphs[introIndex]?.text)) continue;

    let end = introIndex;
    let compactItems = 0;
    let trailingExplanations = 0;
    for (let index = introIndex + 1; index < paragraphs.length && index <= introIndex + 16; index += 1) {
      const text = paragraphs[index]?.text || "";
      if (isSectionBoundary(text)) break;
      if (isCompactListItem(text)) {
        compactItems += 1;
        trailingExplanations = 0;
        end = index;
        continue;
      }
      if (!compactItems || trailingExplanations >= 1) break;
      trailingExplanations += 1;
      end = index;
    }
    if (compactItems < 2) continue;

    const headingIndex = introIndex > 0 && isShortSectionHeading(paragraphs[introIndex - 1]?.text)
      ? introIndex - 1
      : introIndex;
    if (hitIndex < headingIndex || hitIndex > end) continue;
    if (joinRange(paragraphs, headingIndex, end).length > limit) continue;
    return { start: headingIndex, end };
  }
  return null;
}

function isListIntroduction(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 320) return false;
  return /(?:以下|如下|下列).{0,100}(?:顺序|次序|优先度|优先级|排列|组成连锁)/u.test(text)
    || /(?:顺序|次序|优先度|优先级).{0,100}(?:以下|如下|下列)/u.test(text);
}

function isCompactListItem(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 100 || isSectionBoundary(text)) return false;
  if (/^(?:[-*•●▪]|\d+[.、．)]|[一二三四五六七八九十]+[、．.)]|[①②③④⑤⑥⑦⑧⑨⑩])/u.test(text)) return true;
  return !/[。！？；]$/u.test(text) && !text.includes("\n");
}

function isShortSectionHeading(value) {
  const text = String(value || "").trim();
  return Boolean(text) && text.length <= 80 && /¶$/u.test(text);
}

function isSectionBoundary(value) {
  const text = String(value || "").trim();
  return isShortSectionHeading(text)
    || /^(?:备注|注|注意|例|示例|说明|补充|Q\s*&\s*A)\s*[:：]?$/iu.test(text);
}

function truncateFocusedParagraph(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const marker = "\n…\n";
  if (limit <= marker.length + 20) return text.slice(0, limit);
  const available = limit - marker.length;
  const headLength = Math.ceil(available * 0.55);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function buildWeightedTerms({ userQuery, ruleSearchQueries }) {
  const weighted = new Map();
  addTerms(weighted, userQuery, 0.7);
  for (const query of ruleSearchQueries || []) {
    const confidence = String(query?.confidence || "medium").toLowerCase();
    const baseWeight = confidence === "high" ? 3 : confidence === "low" ? 1 : 2;
    const weight = baseWeight * ruleQuerySourceMultiplier(query?.source);
    addTerms(weighted, query?.query || query, weight);
  }
  return [...weighted.entries()]
    .map(([term, weight]) => ({ term, key: normalizeKey(term), weight }))
    .filter((item) => item.key.length >= 2)
    .sort((left, right) => right.weight - left.weight || right.key.length - left.key.length)
    .slice(0, 180);
}

function buildReservedRuleQueryGroups(ruleSearchQueries, maxPassages) {
  const groups = new Map();
  for (const query of ruleSearchQueries || []) {
    const source = String(query?.source || "").trim().toLowerCase();
    const confidence = String(query?.confidence || "medium").trim().toLowerCase();
    const text = String(query?.query || query || "").trim();
    const key = normalizeKey(text);
    if (confidence !== "high"
        || !source.endsWith("_rule_search_query")
        || source.startsWith("model_")
        || source === "card_text_derived_rule_search_query"
        || !key
        || groups.has(key)) continue;
    const seenViews = new Set();
    const views = [text, buildCoreRuleQueryView(text)]
      .filter(Boolean)
      .map((view) => {
        const viewKey = normalizeKey(view);
        if (!viewKey || seenViews.has(viewKey)) return null;
        seenViews.add(viewKey);
        return {
          terms: buildWeightedTerms({
            userQuery: "",
            // Source eligibility is checked above. Once eligible, normalized
            // query views share one reservation without changing the selected
            // passage's source authority.
            ruleSearchQueries: [{ query: view, confidence: "high" }],
          }),
          anchors: extractQuotedAnchors(view),
        };
      })
      .filter((view) => view && (view.terms.length || view.anchors.length));
    if (!views.length) continue;
    groups.set(key, { key, views });
  }
  return [...groups.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, positiveInteger(maxPassages, DEFAULT_MAX_PASSAGES));
}

function buildCoreRuleQueryView(value) {
  const qualifier = /^(?:必发|必發|必须发动|必須発動|必ず発動|公开选发|公開選発|任意|选发|選發|公開|公开|回合玩家|非回合玩家|ターンプレイヤー|对方|對方|相手)$/iu;
  const concreteChainLink = /^(?:(?:连锁|連鎖|チェーン|chain(?:link)?)?[cCＣ]?)\d+$/iu;
  const tokens = String(value || "")
    .normalize("NFKC")
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter((item) => item && !qualifier.test(item) && !concreteChainLink.test(item));
  return tokens.length >= 2 ? tokens.join(" ") : "";
}

function addTerms(target, value, baseWeight) {
  const sourceText = String(value || "").normalize("NFKC");
  const segments = sourceText
    .split(/[\s，,。.!！?？;；、:：()（）\[\]【】「」『』《》/]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);

  if (/(?:连锁|連鎖|チェーン|\bchain\b)/iu.test(sourceText)
      && /(?:处理|處理|结算|結算|解決|resolve)/iu.test(sourceText)) {
    for (const concept of ["连锁处理", "连锁结算", "结算连锁", "处理连锁"]) {
      addWeightedTerm(target, concept, baseWeight * 0.7);
    }
  }

  for (const segment of segments) {
    addWeightedTerm(target, segment, baseWeight);
    const key = normalizeKey(segment);
    for (const group of RULE_RETRIEVAL_CONCEPT_GROUPS) {
      const normalizedGroup = group.map(normalizeKey);
      if (!normalizedGroup.some((concept) => key.includes(concept))) continue;
      for (const concept of normalizedGroup) {
        addWeightedTerm(target, concept, baseWeight * 0.55);
      }
    }
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
  const sectionHeading = String(paragraph || "").split(/\r?\n/u)[0]?.trim() || "";
  const sectionHeadingKey = sectionHeading.length <= 120 && /¶$/u.test(sectionHeading)
    ? normalizeKey(sectionHeading)
    : "";
  let score = 0;
  let strongMatches = 0;
  for (const term of terms) {
    if (paragraphKey.includes(term.key)) {
      const lengthBoost = Math.min(3, Math.max(0.5, term.key.length / 4));
      score += term.weight * lengthBoost;
      if (sectionHeadingKey.includes(term.key)) score += term.weight * lengthBoost * 1.5;
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
  return (right.rankingScore ?? right.score) - (left.rankingScore ?? left.score)
    || String(left.sourceRecordId).localeCompare(String(right.sourceRecordId))
    || left.paragraphStart - right.paragraphStart;
}

function ruleQuerySourceMultiplier(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "card_text_derived_rule_search_query") return 0.75;
  if (source === "mechanism_rule_search_query") return 1.35;
  if (source === "derived_rule_search_query") return 1.15;
  // All deterministic, scenario-specific query families receive the same
  // structural boost. New mechanisms do not need to be added to a whitelist.
  if (source.endsWith("_rule_search_query")
      && !source.startsWith("model_")
      && source !== "card_text_derived_rule_search_query") return 1.75;
  // Printed-card queries remain useful, but a repeated card name or generic
  // effect word must not outweigh a scenario-specific mechanism query.
  return 1;
}

function normalizeRulebookRelevance(score) {
  const number = Number(score);
  if (!Number.isFinite(number) || number <= 0) return 0;
  // Rulebook passages and QA records feed the same final evidence selector, so
  // their bounded relevance scores must occupy comparable ranges. A strong
  // multi-term passage match (roughly 5-8 raw points) should compete with a
  // moderately related QA, while the minimum accepted match remains low.
  return Number((1 - Math.exp(-number / 8)).toFixed(4));
}

function coversCandidateMatch(selected, candidate) {
  if (selected.sourceRecordId !== candidate.sourceRecordId) return false;
  return selected.paragraphStart <= candidate.matchParagraph
    && candidate.matchParagraph <= selected.paragraphEnd;
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
