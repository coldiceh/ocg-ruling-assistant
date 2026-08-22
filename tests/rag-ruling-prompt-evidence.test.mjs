import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRagRulingPromptBundle,
  extractPromptAllowedEvidenceIds,
} from "../backend/ragRulingPrompt.mjs";

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

test("serialized evidence authorization accepts matching ordinary buckets and compact arrays", () => {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const bucketPayload = {
    evidence: {
      officialQaRelated: [{ id: "bucket-visible" }],
      rawRelatedEvidence: [{ id: "bucket-second" }],
    },
    allowedEvidenceIds: ["bucket-visible", "bucket-second"],
  };
  assert.deepEqual(
    extractPromptAllowedEvidenceIds(`ordinary instructions\n${marker}${JSON.stringify(bucketPayload)}`),
    ["bucket-visible", "bucket-second"],
  );

  const arrayPayload = {
    evidence: [{ id: "array-visible" }, { id: "array-second" }],
    allowedEvidenceIds: ["array-visible", "array-second"],
  };
  assert.deepEqual(
    extractPromptAllowedEvidenceIds(`compact instructions\n${JSON.stringify(arrayPayload)}`),
    ["array-visible", "array-second"],
  );
});

test("serialized evidence authorization does not recover a damaged ordinary envelope from its tail", () => {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const validTail = JSON.stringify({
    evidence: [{ id: "tail-visible" }],
    allowedEvidenceIds: ["tail-visible"],
  });
  const damaged = `ordinary instructions\n${marker}{"evidence":BROKEN\n${validTail}`;
  assert.deepEqual(extractPromptAllowedEvidenceIds(damaged, ["fallback-ghost"]), []);
});

test("serialized evidence authorization rejects ghost and visible-but-unallowed ids", () => {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const ordinaryPrompt = (payload) => `ordinary\n${marker}${JSON.stringify(payload)}`;
  assert.deepEqual(extractPromptAllowedEvidenceIds(ordinaryPrompt({
    evidence: { officialQaRelated: [{ id: "visible" }] },
    allowedEvidenceIds: ["visible", "ghost"],
  })), []);
  assert.deepEqual(extractPromptAllowedEvidenceIds(ordinaryPrompt({
    evidence: { officialQaRelated: [{ id: "visible" }, { id: "unallowed" }] },
    allowedEvidenceIds: ["visible"],
  })), []);
  assert.deepEqual(extractPromptAllowedEvidenceIds(ordinaryPrompt({
    allowedEvidenceIds: ["ghost"],
  })), []);
});

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
  assert.match(bundle.prompt, /分别枚举发动时的全部合法选项与处理时最终能执行的全部选项/u);
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
  const serialized = flattenPromptEvidence(parsePromptPayload(bundle.prompt).evidence)
    .find((item) => item.id === "official-reference-with-middle-context");
  assert.equal(serialized.answer, answer);
  assert.equal(
    bundle.warnings.includes("official_related_text_truncated:official-reference-with-middle-context"),
    false,
  );
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
    retrievalScore: 0.99 - index * 0.05,
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
        text: "CARD_EVIDENCE_MARKER ".repeat(40),
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
  assert.ok(retainedIds.has("official-reference-0"));
  assert.ok(
    officialQaRelated.some((item) => !retainedIds.has(item.id)),
    "lower-priority whole records should be removed before truncating the top official QA",
  );
  const topOfficial = evidenceItems.find((item) => item.id === "official-reference-0");
  assert.equal(topOfficial.answer, officialQaRelated[0].answer);
  assert.ok(evidenceItems.filter((item) => item.sourceAuthority === "community_reference").length < rawRelatedEvidence.length);
});

test("minimal prompt keeps the highest-ranked official evidence without role slots", () => {
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
    sourceAuthority: "official_database",
    retrievalScore: 0.7 - index * 0.01,
    title: `匿名同卡官方问答 ${index}`,
    question: `匿名问题 ${index}`,
    answer: `同卡官方资料 ${index} ${"说明".repeat(120)}`,
  }));
  const crossCardOfficialQa = {
    id: "cross-card-official-anchor",
    type: "related",
    recordType: "qa",
    official: true,
    sourceAuthority: "official_database",
    retrievalScore: 0.99,
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
    sourceAuthority: "official_database",
    retrievalScore: 0.98,
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
  assert.ok(
    retainedIds.has("official-faq-anchor"),
    `retained evidence: ${[...retainedIds].join(", ")}`,
  );
  assert.ok(retainedIds.has("cross-card-official-anchor"));
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

test("ordinary compact prompt keeps the complete question and card text while packing whole evidence", () => {
  const userQuery = [
    "QUERY_HEAD",
    "完整问题场景".repeat(420),
    "QUERY_TAIL",
  ].join(" ");
  const effectText = [
    "CARD_TEXT_HEAD",
    "完整卡片原文".repeat(420),
    "CARD_TEXT_TAIL",
  ].join(" ");
  const resolvedCards = [{
    id: "ordinary-compact-card-0",
    name: "匿名长卡文对象",
    effectText,
  }, ...Array.from({ length: 6 }, (_unused, index) => ({
    id: `ordinary-compact-card-${index + 1}`,
    name: `匿名附加对象 ${index + 1}`,
    effectText: `CARD_${index + 1}_HEAD ${"附加卡片原文".repeat(12)} CARD_${index + 1}_TAIL`,
  }))];
  assert.ok(userQuery.length > 1600);
  assert.ok(effectText.length > 1600);

  const officialQaRelated = Array.from({ length: 3 }, (_unused, index) => ({
    id: `ordinary-compact-official-${index}`,
    type: "related",
    recordType: "qa",
    official: true,
    sourceAuthority: "official_database",
    title: `匿名完整资料 ${index}`,
    question: `匿名完整问题 ${index}`,
    answer: `EVIDENCE_${index}_HEAD ${"完整证据正文".repeat(120)} EVIDENCE_${index}_TAIL`,
    retrievalScore: 0.99 - index * 0.01,
  }));
  const bundle = buildRagRulingPromptBundle({
    userQuery,
    cardResolution: {
      resolvedCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated,
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_PROMPT_CHARS: "12000",
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_CARDS: "7",
    },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  assert.ok(bundle.prompt.length <= 12000);
  const payload = parsePromptPayload(bundle.prompt);
  assert.ok(Array.isArray(payload.evidence), "fixture must use the normal compact envelope");
  assert.equal(payload.userQuery, userQuery);
  assert.equal(payload.resolvedCards.length, resolvedCards.length);
  assert.deepEqual(
    payload.resolvedCards.map((card) => card.effectText),
    resolvedCards.map((card) => card.effectText),
  );
  const serializedEvidence = flattenPromptEvidence(payload.evidence);
  assert.ok(serializedEvidence.length >= 2);
  for (const item of serializedEvidence) {
    assert.match(item.answer, /EVIDENCE_\d_HEAD/u);
    assert.match(item.answer, /EVIDENCE_\d_TAIL/u);
  }
});

test("only the emergency compact prompt may abbreviate the question and card text", () => {
  const userQuery = `EMERGENCY_QUERY_HEAD ${"超低预算问题".repeat(420)} EMERGENCY_QUERY_TAIL`;
  const effectText = `EMERGENCY_CARD_HEAD ${"超低预算卡文".repeat(420)} EMERGENCY_CARD_TAIL`;
  const bundle = buildRagRulingPromptBundle({
    userQuery,
    cardResolution: {
      resolvedCards: [{ id: "emergency-card", name: "匿名紧急对象", effectText }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: { RAG_MAX_PROMPT_CHARS: "1000" },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  const payload = parsePromptPayload(bundle.prompt);
  assert.ok(Array.isArray(payload.evidence));
  assert.equal(payload.userQuery.length, 80);
  assert.equal(payload.resolvedCards[0].effectText.length, 60);
  assert.match(payload.userQuery, /^EMERGENCY_QUERY_HEAD/u);
  assert.match(payload.userQuery, /EMERGENCY_QUERY_TAIL$/u);
  assert.match(payload.resolvedCards[0].effectText, /^EMERGENCY_CARD_HEAD/u);
  assert.match(payload.resolvedCards[0].effectText, /EMERGENCY_CARD_TAIL$/u);
});

test("the actual 36k prompt keeps the complete projected tail of the highest-priority official QA", () => {
  const completeAnswer = [
    "TOP_OFFICIAL_ANSWER_HEAD",
    "完整官方说明".repeat(420),
    "TOP_OFFICIAL_ANSWER_TAIL",
  ].join("\n");
  const topOfficial = {
    id: "top-ranked-official-reference",
    type: "related",
    recordType: "qa",
    official: true,
    sourceAuthority: "official_database",
    title: "最高相关官方问答",
    question: "完整问题场景是否允许所述处理？",
    detailedScene: "完整场面、区域、时点与玩家关系。",
    answer: completeAnswer,
    retrievalScore: 0.99,
  };
  const lowerPriority = Array.from({ length: 11 }, (_unused, index) => ({
    id: `lower-ranked-official-${index}`,
    type: "related",
    recordType: "qa",
    official: true,
    sourceAuthority: "official_database",
    title: `较低相关官方资料 ${index}`,
    question: `较低相关问题 ${index}`,
    answer: `LOWER_${index}_HEAD ${"较低相关正文".repeat(500)} LOWER_${index}_TAIL`,
    retrievalScore: 0.4 - index * 0.01,
  }));
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请依据最相关的完整官方问答分析匿名场面。",
    cardResolution: {
      resolvedCards: [{ id: "entity-dynamic-pack", name: "匿名对象", effectText: "执行一项处理。" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [topOfficial, ...lowerPriority],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_PROMPT_CHARS: "36000",
      RAG_MAX_EVIDENCE_TEXT_CHARS: "5000",
      RAG_MAX_PROMPT_REFERENCE_ITEMS: "12",
    },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  assert.ok(bundle.prompt.length <= 36000);
  const payload = parsePromptPayload(bundle.prompt);
  const evidenceItems = flattenPromptEvidence(payload.evidence);
  const retainedTop = evidenceItems.find((item) => item.id === topOfficial.id);
  assert.ok(retainedTop, "the top-ranked official record must remain visible");
  assert.equal(retainedTop.answer, completeAnswer);
  assert.match(retainedTop.answer, /TOP_OFFICIAL_ANSWER_TAIL/u);
  assert.ok(
    lowerPriority.some((item) => !evidenceItems.some((retained) => retained.id === item.id)),
    "lower-priority records must be removed before the top record is truncated",
  );

  const actualIds = [...new Set(evidenceItems.map((item) => String(item.id || "")).filter(Boolean))].sort();
  assert.deepEqual([...payload.allowedEvidenceIds].sort(), actualIds);
  assert.deepEqual([...bundle.allowedEvidenceIds].sort(), actualIds);
});

test("an official body above the projection limit is restored in full when the 36k prompt can hold it", () => {
  const shortAnswer = "SHORT_OFFICIAL_ANSWER";
  const completeFullText = [
    "RESTORED_OFFICIAL_HEAD",
    shortAnswer,
    "LONG_DECISIVE_DETAIL",
    "完整官方正文中段".repeat(520),
    "FULL_TAIL",
  ].join("\n");
  assert.ok(completeFullText.length > 2800);
  const evidenceId = "official-body-restored-after-selection";
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请核对这条匿名官方资料的完整处理。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: evidenceId,
        type: "related",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        title: "匿名完整官方资料",
        question: "匿名官方问题？",
        answer: shortAnswer,
        fullText: completeFullText,
        retrievalScore: 0.99,
      }],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_PROMPT_CHARS: "36000",
    },
  });

  assert.equal(bundle.modelEvidence.officialQaRelated[0].answer, shortAnswer);
  assert.ok(bundle.modelEvidence.officialQaRelated[0].text.length < completeFullText.length);
  const payload = parsePromptPayload(bundle.prompt);
  const serialized = flattenPromptEvidence(payload.evidence)
    .find((item) => item.id === evidenceId);
  assert.equal(serialized.answer, shortAnswer);
  assert.equal(serialized.text, completeFullText);
  assert.match(serialized.text, /LONG_DECISIVE_DETAIL/u);
  assert.match(serialized.text, /FULL_TAIL/u);
  assert.equal(bundle.allowedEvidenceIds.includes(evidenceId), true);
  assert.equal(bundle.warnings.some((warning) => warning.endsWith(`:${evidenceId}`)), false);
});

test("complementary text matching consumes each structured field at most once", () => {
  const evidenceId = "official-body-pure-structured-repeat";
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请核对这条匿名官方资料。",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: evidenceId,
        type: "related",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        question: "ＦＯＯ",
        detailedScene: "ＤＥＴＡＩＬ",
        answer: "ＢＡＲ",
        fullText: "F O O\nB A R",
        retrievalScore: 0.99,
      }, {
        id: "official-body-repeated-structured-part",
        type: "related",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        question: "ＦＯＯ",
        detailedScene: "ＤＥＴＡＩＬ",
        answer: "ＢＡＲ",
        fullText: "F O O\nB A R\nB A R",
        retrievalScore: 0.98,
      }],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_PROMPT_CHARS: "36000",
    },
  });

  const projected = bundle.modelEvidence.officialQaRelated[0];
  const serialized = flattenPromptEvidence(parsePromptPayload(bundle.prompt).evidence)
    .find((item) => item.id === evidenceId);
  assert.equal(Object.hasOwn(projected, "text"), false);
  assert.equal(Object.hasOwn(serialized, "text"), false);
  assert.equal(serialized.question, "ＦＯＯ");
  assert.equal(serialized.detailedScene, "ＤＥＴＡＩＬ");
  assert.equal(serialized.answer, "ＢＡＲ");
  assert.equal(bundle.warnings.some((warning) => warning.endsWith(`:${evidenceId}`)), false);

  const repeatedProjected = bundle.modelEvidence.officialQaRelated
    .find((item) => item.id === "official-body-repeated-structured-part");
  const repeatedSerialized = flattenPromptEvidence(parsePromptPayload(bundle.prompt).evidence)
    .find((item) => item.id === "official-body-repeated-structured-part");
  assert.equal(repeatedProjected.text, "F O O\nB A R\nB A R");
  assert.equal(repeatedSerialized.text, "F O O\nB A R\nB A R");
});

test("compact whole-entry packing retains a short answer and its complementary full text", () => {
  const evidenceId = "compact-whole-complementary-body";
  const shortAnswer = "SHORT_WHOLE_ANSWER";
  const completeFullText = [
    "WHOLE_FULL_HEAD",
    shortAnswer,
    "LONG_DECISIVE_DETAIL",
    "完整互补正文".repeat(240),
    "FULL_TAIL",
  ].join("\n");
  const topOfficial = {
    id: evidenceId,
    type: "related",
    recordType: "qa",
    official: true,
    sourceAuthority: "official_database",
    question: "最高相关问题？",
    answer: shortAnswer,
    fullText: completeFullText,
    retrievalScore: 0.99,
  };
  const lowerPriority = Array.from({ length: 8 }, (_unused, index) => ({
    id: `compact-whole-distractor-${index}`,
    type: "related",
    recordType: "qa",
    official: true,
    sourceAuthority: "official_database",
    question: `次要问题 ${index}`,
    answer: `次要答案 ${index} ${"次要正文".repeat(420)}`,
    retrievalScore: 0.2 - index * 0.01,
  }));
  const topOnly = buildRagRulingPromptBundle({
    userQuery: "请依据最高相关的完整官方资料判断。",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [topOfficial],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_PROMPT_CHARS: "100000",
    },
  });
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请依据最高相关的完整官方资料判断。",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [topOfficial, ...lowerPriority],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_PROMPT_CHARS: String(topOnly.prompt.length + 32),
      RAG_MAX_PROMPT_REFERENCE_ITEMS: "9",
    },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  const serialized = flattenPromptEvidence(parsePromptPayload(bundle.prompt).evidence)
    .find((item) => item.id === evidenceId);
  assert.equal(serialized.answer, shortAnswer);
  assert.equal(serialized.text, completeFullText);
  assert.match(serialized.text, /LONG_DECISIVE_DETAIL/u);
  assert.match(serialized.text, /FULL_TAIL/u);
  assert.equal(bundle.warnings.some((warning) => warning.endsWith(`:${evidenceId}`)), false);
});

test("compact single-entry fitting counts and warns on a truncated complementary full text", () => {
  const evidenceId = "compact-single-complementary-body";
  const shortAnswer = "SHORT_SINGLE_ANSWER";
  const completeFullText = [
    "LONG_DECISIVE_DETAIL",
    shortAnswer,
    "必须参与单条预算计算的完整正文".repeat(520),
    "FULL_TAIL",
  ].join("\n");
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请核对这条过长的官方资料。",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: evidenceId,
        type: "related",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        question: "过长资料问题？",
        answer: shortAnswer,
        fullText: completeFullText,
        retrievalScore: 0.99,
      }],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_PROMPT_CHARS: "1800",
    },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  const payload = parsePromptPayload(bundle.prompt);
  assert.ok(Array.isArray(payload.evidence));
  const serialized = flattenPromptEvidence(payload.evidence)
    .find((item) => item.id === evidenceId);
  assert.equal(serialized.answer, shortAnswer);
  assert.ok(serialized.text.length < completeFullText.length);
  assert.match(serialized.text, /LONG_DECISIVE_DETAIL/u);
  assert.match(serialized.text, /FULL_TAIL/u);
  assert.ok(bundle.warnings.includes(`official_related_text_truncated:${evidenceId}`));
});

test("compact single-entry fitting uses the complete source length beyond the 2800 projection", () => {
  const evidenceId = "compact-single-complete-source-budget";
  const shortAnswer = "SHORT_LARGE_SINGLE_ANSWER";
  const completeFullText = [
    "LARGE_SINGLE_FULL_HEAD",
    shortAnswer,
    "LONG_DECISIVE_DETAIL",
    "必须利用三万六千字提示预算的完整正文".repeat(2600),
    "LARGE_SINGLE_FULL_TAIL",
  ].join("\n");
  assert.ok(completeFullText.length > 36000);
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请在实际提示预算内尽量完整保留这条官方资料。",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: evidenceId,
        type: "related",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        question: "超长资料问题？",
        answer: shortAnswer,
        fullText: completeFullText,
        retrievalScore: 0.99,
      }],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
      RAG_MAX_PROMPT_CHARS: "36000",
    },
  });

  assert.ok(bundle.prompt.length <= 36000);
  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  const projected = bundle.modelEvidence.officialQaRelated[0];
  assert.ok(projected.text.length < 2800);
  const serialized = flattenPromptEvidence(parsePromptPayload(bundle.prompt).evidence)
    .find((item) => item.id === evidenceId);
  assert.equal(serialized.answer, shortAnswer);
  assert.ok(serialized.text.length > 10000);
  assert.ok(serialized.text.length < completeFullText.length);
  assert.match(serialized.text, /LARGE_SINGLE_FULL_HEAD/u);
  assert.match(serialized.text, /LONG_DECISIVE_DETAIL/u);
  assert.match(serialized.text, /LARGE_SINGLE_FULL_TAIL/u);
  assert.ok(bundle.warnings.includes(`official_related_text_truncated:${evidenceId}`));
});

test("focused official direct prompt retains complementary full text beside a short answer", () => {
  const evidenceId = "official-direct-complementary-body";
  const cardId = "direct-body-card";
  const shortAnswer = "SHORT_DIRECT_ANSWER";
  const directQuestion = "DIRECT_QUESTION?";
  const completeFullText = [
    directQuestion,
    shortAnswer,
    "LONG_DECISIVE_DETAIL",
    "官方直达完整正文".repeat(360),
    "FULL_TAIL",
  ].join("\n");
  const bundle = buildRagRulingPromptBundle({
    userQuery: directQuestion,
    cardResolution: {
      resolvedCards: [{ id: cardId, name: "匿名直达卡" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [{
        id: evidenceId,
        type: "official_qa",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        question: directQuestion,
        answer: shortAnswer,
        fullText: completeFullText,
        isDirect: true,
        matchLevel: "official_qa_exact",
        authoritativeSceneMatch: true,
        authoritativeSceneMatchReason: "raw_or_normalized_query",
        questionCardIdCoverage: 1,
        questionCardIdCount: 1,
        matchedQuestionCardIds: [cardId],
      }],
      officialQaRelated: [],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: { RAG_MAX_PROMPT_CHARS: "36000" },
  });

  const payload = parsePromptPayload(bundle.prompt);
  const direct = payload.officialQaDirectCandidate;
  assert.match(direct.answer, /SHORT_DIRECT_ANSWER/u);
  assert.match(direct.answer, /LONG_DECISIVE_DETAIL/u);
  assert.match(direct.answer, /FULL_TAIL/u);
  assert.equal(bundle.authoritativeOfficialDirectId, evidenceId);
  assert.equal(bundle.warnings.includes("official_direct_prompt_truncated"), false);
});

test("a projected candidate dropped by final packing cannot emit an item truncation warning", () => {
  const retainedId = "packed-visible-official";
  const droppedId = "packed-dropped-official";
  const longBody = (marker) => `${marker}_HEAD ${"匿名官方长正文".repeat(150)} ${marker}_TAIL`;
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请依据最优先的匿名官方资料进行判断。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [
        {
          id: retainedId,
          type: "related",
          recordType: "qa",
          official: true,
          sourceAuthority: "official_database",
          question: "优先官方问题？",
          answer: longBody("VISIBLE"),
          retrievalScore: 0.99,
        },
        {
          id: droppedId,
          type: "related",
          recordType: "qa",
          official: true,
          sourceAuthority: "official_database",
          question: "次要官方问题？",
          answer: longBody("DROPPED"),
          retrievalScore: 0.2,
        },
      ],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: {
      RAG_MAX_EVIDENCE_TEXT_CHARS: "160",
      RAG_MAX_PROMPT_REFERENCE_ITEMS: "2",
      RAG_MAX_PROMPT_CHARS: "2200",
    },
  });

  assert.equal(bundle.modelEvidence.officialQaRelated.length, 2);
  assert.equal(bundle.allowedEvidenceIds.includes(retainedId), true);
  assert.equal(bundle.allowedEvidenceIds.includes(droppedId), false);
  assert.equal(bundle.warnings.some((warning) => warning.endsWith(`:${droppedId}`)), false);
});

test("retrieval-only lexical profiles never enter model evidence or the final prompt", () => {
  const secret = "PRIVATE_LEXICAL_PROFILE_SENTINEL";
  const bundle = buildRagRulingPromptBundle({
    userQuery: "请依据相关官方问题判断这个匿名处理。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: "official-private-profile",
        type: "related",
        recordType: "qa",
        official: true,
        sourceAuthority: "official_database",
        question: "匿名官方问题？",
        answer: "匿名官方答案。",
        retrievalScore: 0.99,
        retrievalSignals: {
          ruleBranchLexicalQualified: true,
          ruleBranchLexicalProfiles: [{
            queryKey: secret,
            normalizedUnits: [secret],
            grams: [secret],
          }],
        },
      }],
      provisionalOfficialResponses: [],
      faqRelated: [],
      cardTexts: [],
      userProvidedCardTexts: [],
      rawRelatedEvidence: [],
    },
    env: { RAG_MAX_PROMPT_CHARS: "12000" },
  });

  assert.doesNotMatch(bundle.prompt, new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(bundle.modelEvidence), new RegExp(secret, "u"));
});
