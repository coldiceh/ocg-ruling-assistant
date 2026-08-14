import assert from "node:assert/strict";
import test from "node:test";

import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

function parsePromptPayload(prompt) {
  const fullMarker = "本次用户问题、卡片原文与检索资料如下：\n";
  const markerIndex = prompt.lastIndexOf(fullMarker);
  if (markerIndex >= 0) return JSON.parse(prompt.slice(markerIndex + fullMarker.length));
  const compactIndex = prompt.lastIndexOf('{"userQuery"');
  assert.ok(compactIndex >= 0, "prompt must retain a complete JSON evidence envelope");
  return JSON.parse(prompt.slice(compactIndex));
}

function flattenPromptEvidence(evidence) {
  if (Array.isArray(evidence)) return evidence;
  return Object.entries(evidence || {}).flatMap(([bucket, items]) => (
    (items || []).map((item) => ({ bucket, ...item }))
  ));
}

test("prompt preserves provenance and presents official QA as structured fields", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery: "匿名效果在所述状态下如何处理？",
    cardResolution: {
      resolvedCards: [{ id: "entity-alpha", name: "匿名对象", effectText: "执行一项处理。" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: "official-reference-alpha",
        type: "related",
        recordType: "qa",
        official: true,
        source: "official-database-mirror",
        sourceTier: "S0_OFFICIAL_DB_MIRROR",
        title: "匿名官方问答",
        question: "简短问题标题",
        rawDetailedQuestion: "完整场面说明与事件节点",
        answer: "官方回答正文",
      }],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [{
        id: "community-reference-alpha",
        type: "rulebook",
        recordType: "rule-doc",
        official: false,
        source: "ocg-rule",
        sourceTier: "S2_COMMUNITY_REFERENCE",
        title: "匿名社区整理",
        text: "社区辅助说明",
      }],
    },
  });

  const payload = parsePromptPayload(bundle.prompt);
  const officialQa = payload.evidence.officialQaRelated[0];
  assert.equal(officialQa.official, true);
  assert.equal(officialQa.recordType, "qa");
  assert.equal(officialQa.source, "official-database-mirror");
  assert.equal(officialQa.sourceTier, "S0_OFFICIAL_DB_MIRROR");
  assert.equal(officialQa.sourceAuthority, "official_database");
  assert.equal(officialQa.question, "简短问题标题");
  assert.equal(officialQa.detailedScene, "完整场面说明与事件节点");
  assert.equal(officialQa.answer, "官方回答正文");
  assert.equal(Object.hasOwn(officialQa, "text"), false);

  const community = payload.evidence.rawRelatedEvidence[0];
  assert.equal(community.official, false);
  assert.equal(community.recordType, "rule-doc");
  assert.equal(community.source, "ocg-rule");
  assert.equal(community.sourceAuthority, "community_reference");
  assert.match(bundle.prompt, /事件时间线/u);
  assert.match(bundle.prompt, /发动快照/u);
  assert.match(bundle.prompt, /处理快照/u);
  assert.match(bundle.prompt, /处理后快照/u);
  assert.match(bundle.prompt, /发动时的合法选项与处理时最终能执行的选项/u);
  assert.match(bundle.prompt, /效果来源与效果类型/u);
  assert.match(bundle.prompt, /实际受影响实体/u);
  assert.match(bundle.prompt, /核对权限关系/u);
  assert.match(bundle.prompt, /当前区域、类型/u);
  assert.match(bundle.prompt, /不得用尚未发生的后续状态倒推/u);
  assert.match(bundle.prompt, /显式账本/u);
});

test("an explicitly non-official QA-shaped record cannot become official through fallback metadata", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery: "匿名问题如何处理？",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [{
        id: "community-qa-without-tier",
        recordType: "qa",
        official: false,
        source: "community-mirror",
        question: "社区整理的问题",
        answer: "社区整理的回答",
      }],
    },
  });

  const payload = parsePromptPayload(bundle.prompt);
  const item = payload.evidence.rawRelatedEvidence[0];
  assert.equal(item.official, false);
  assert.equal(item.sourceTier, "S2_COMMUNITY_REFERENCE");
  assert.equal(item.sourceAuthority, "community_reference");
});

test("long official QA keeps the resolved-card context window instead of only its ends", () => {
  const answer = [
    "ANSWER_HEAD",
    "前段说明".repeat(160),
    "<<entity-alpha>> FOCUSED_CONTEXT_MARKER",
    "后段说明".repeat(160),
    "ANSWER_TAIL",
  ].join(" ");
  const bundle = buildRagRulingPromptBundle({
    userQuery: "匿名对象是否属于官方回答列举的范围？",
    cardResolution: {
      resolvedCards: [{ id: "entity-alpha", name: "匿名对象", effectText: "执行一项处理。" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: "official-reference-with-middle-context",
        type: "related",
        recordType: "qa",
        official: true,
        question: "某类对象是否适用同一处理？",
        answer,
      }],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: { RAG_MAX_EVIDENCE_TEXT_CHARS: "280" },
  });

  const retained = bundle.modelEvidence.officialQaRelated[0].answer;
  assert.match(retained, /ANSWER_HEAD/u);
  assert.match(retained, /<<entity-alpha>> FOCUSED_CONTEXT_MARKER/u);
  assert.match(retained, /ANSWER_TAIL/u);
  assert.ok(bundle.warnings.includes("official_related_text_truncated:official-reference-with-middle-context"));
});

test("compact prompt spends evidence slots on card text and official references before community material", () => {
  const officialQaRelated = Array.from({ length: 6 }, (_unused, index) => ({
    id: `official-reference-${index}`,
    type: "related",
    recordType: "qa",
    official: true,
    source: "official-database-mirror",
    title: `匿名官方问答 ${index}`,
    question: `匿名问题 ${index}`,
    answer: `OFFICIAL_MARKER_${index} ${"官方说明".repeat(180)}`,
  }));
  const rawRelatedEvidence = Array.from({ length: 14 }, (_unused, index) => ({
    id: `community-reference-${index}`,
    type: "rulebook",
    recordType: "rule-doc",
    official: false,
    source: "ocg-rule",
    title: `匿名社区资料 ${index}`,
    text: `COMMUNITY_MARKER_${index} ${"社区说明".repeat(180)}`,
  }));
  const bundle = buildRagRulingPromptBundle({
    userQuery: "需要综合多条资料分析匿名场面。",
    cardResolution: {
      resolvedCards: [{ id: "entity-beta", name: "匿名对象", effectText: "CARD_TEXT_MARKER ".repeat(100) }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated,
      faqRelated: [],
      cardTexts: [{
        id: "card-text-anchor",
        type: "card_text",
        recordType: "card-text",
        title: "匿名对象卡文",
        text: "CARD_EVIDENCE_MARKER ".repeat(100),
      }],
      userProvidedCardTexts: [],
      rawRelatedEvidence,
    },
    env: { RAG_MAX_PROMPT_CHARS: "5000" },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  const payload = parsePromptPayload(bundle.prompt);
  const evidenceItems = flattenPromptEvidence(payload.evidence);
  const retainedIds = new Set(evidenceItems.map((item) => item.id));
  assert.ok(retainedIds.has("card-text-anchor"));
  for (const item of officialQaRelated) assert.ok(retainedIds.has(item.id));
  assert.ok(evidenceItems.filter((item) => item.sourceAuthority === "community_reference").length < rawRelatedEvidence.length);
});

test("minimal prompt reserves FAQ and related-only cross-card official QA under saturated card-text buckets", () => {
  const resolvedCards = Array.from({ length: 6 }, (_unused, index) => ({
    id: `entity-${index}`,
    name: `匿名对象 ${index}`,
    effectText: `DUPLICATE_EFFECT_${index} ${"卡片原文".repeat(80)}`,
  }));
  const duplicateCardTexts = resolvedCards.map((card) => ({
    id: `card-text-duplicate-${card.id}`,
    type: "card_text",
    recordType: "card-text",
    title: `${card.name} 的卡片文本`,
    cardIds: [card.id],
    cards: [card.name],
    text: card.effectText,
  }));
  const duplicateUserTexts = resolvedCards.map((card) => ({
    id: `user-text-duplicate-${card.id}`,
    type: "user_provided_text",
    recordType: "user-provided-card-text",
    title: `${card.name} 的用户文本`,
    cards: [card.name],
    text: card.effectText,
  }));
  const scopedOfficialQa = Array.from({ length: 6 }, (_unused, index) => ({
    id: `scoped-official-${index}`,
    type: "related",
    recordType: "qa",
    official: true,
    title: `匿名同卡官方问答 ${index}`,
    question: `匿名问题 ${index}`,
    answer: `同卡官方资料 ${index} ${"说明".repeat(120)}`,
  }));
  const crossCardOfficialQa = {
    id: "cross-card-official-anchor",
    type: "related",
    recordType: "qa",
    official: true,
    isDirect: false,
    title: "匿名跨卡机制官方问答",
    question: "另一个匿名对象是否适用相同机制？",
    answer: [
      "CROSS_HEAD",
      "前段".repeat(140),
      "<<entity-0>> SECOND_COMPRESSION_FOCUS",
      "后段".repeat(140),
      "CROSS_TAIL",
    ].join(" "),
    retrievalContext: {
      scope: "cross_card_official_mechanism",
      relatedOnly: true,
    },
  };
  const faqRelated = [{
    id: "official-faq-anchor",
    type: "related",
    recordType: "card-faq",
    official: true,
    title: "匿名官方 FAQ",
    question: "匿名 FAQ 问题",
    answer: `FAQ_ANCHOR ${"官方说明".repeat(120)}`,
  }];
  const rawRelatedEvidence = Array.from({ length: 14 }, (_unused, index) => ({
    id: `community-crowding-${index}`,
    type: "rulebook",
    recordType: "rule-doc",
    official: false,
    source: "community-reference",
    title: `匿名社区资料 ${index}`,
    text: `COMMUNITY_CROWDING_${index} ${"社区说明".repeat(160)}`,
  }));

  const bundle = buildRagRulingPromptBundle({
    userQuery: `需要同时核对多张匿名对象、官方 FAQ 与跨卡机制资料。${"场面描述".repeat(180)}`,
    cardResolution: {
      resolvedCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [...scopedOfficialQa, crossCardOfficialQa],
      faqRelated,
      cardTexts: duplicateCardTexts,
      userProvidedCardTexts: duplicateUserTexts,
      rawRelatedEvidence,
    },
    env: { RAG_MAX_PROMPT_CHARS: "4000" },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  const payload = parsePromptPayload(bundle.prompt);
  assert.ok(Array.isArray(payload.evidence), "the fixture must exercise secondary minimal compression");
  const evidenceItems = flattenPromptEvidence(payload.evidence);
  const retainedIds = new Set(evidenceItems.map((item) => item.id));
  assert.ok(retainedIds.has("official-faq-anchor"));
  assert.ok(retainedIds.has("cross-card-official-anchor"));
  assert.ok(scopedOfficialQa.some((item) => retainedIds.has(item.id)));
  assert.equal(
    evidenceItems.some((item) => String(item.id || "").includes("text-duplicate")),
    false,
    "card texts already present in resolvedCards must not consume compact evidence slots",
  );

  const crossCard = evidenceItems.find((item) => item.id === "cross-card-official-anchor");
  assert.equal(crossCard.isDirect, false);
  assert.equal(crossCard.retrievalContext.scope, "cross_card_official_mechanism");
  assert.equal(crossCard.retrievalContext.relatedOnly, true);
  assert.match(JSON.stringify(crossCard), /<<entity-0>>/u);
  assert.ok(payload.allowedEvidenceIds.includes("cross-card-official-anchor"));
});
