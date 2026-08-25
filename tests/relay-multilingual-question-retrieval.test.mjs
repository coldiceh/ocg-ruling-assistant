import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  allocateOfficialRelatedEvidence,
  loadRagData,
  reserveRankedHeadAndSupplementalCoverage,
  reserveUncoveredCrossCardBranches,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import {
  normalizeRuleSearchQueryText,
  selectOfficialQaSearchBranch,
  splitRuleSearchQueryBranches,
} from "../backend/ruleSearchQueryText.mjs";

const japaneseQuestion = "通常罠カードの発動にチェーンして、発動中のその罠カードを対象とし、持ち主の手札に戻す効果を発動できますか";

function parsePromptPayload(prompt) {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const source = String(prompt || "");
  const markerIndex = source.lastIndexOf(marker);
  const json = markerIndex >= 0
    ? source.slice(markerIndex + marker.length)
    : source.trimEnd().slice(source.trimEnd().lastIndexOf("\n") + 1);
  return JSON.parse(json);
}

function promptEvidenceById(payload = {}) {
  const items = Array.isArray(payload.evidence)
    ? payload.evidence
    : Object.values(payload.evidence || {}).flatMap((value) => (
      Array.isArray(value) ? value : []
    ));
  return new Map(items.map((item) => [String(item.id), item]));
}

function assertCompleteSourceEvidenceBody(evidenceId, source, serialized) {
  const sourceQuestion = String(source.question || source.rawQuestion || "").trim();
  const sourceDetailedScene = String(
    source.rawDetailedQuestion || source.detailedScene || source.detailedQuestion || "",
  ).trim();
  const sourceAnswer = String(source.answer || source.officialAnswer || source.conclusion || "").trim();
  const structuredFields = Object.entries({
    question: sourceQuestion,
    detailedScene: sourceDetailedScene,
    answer: sourceAnswer,
  }).filter(([, value]) => value);
  for (const [field, expected] of structuredFields) {
    assert.equal(
      String(serialized[field] ?? ""),
      String(expected),
      `${evidenceId}.${field} must be source-equal and untruncated: ${JSON.stringify(serialized)}`,
    );
  }
  if (structuredFields.length) return;
  const sourceText = String(source.text || source.fullText || source.officialText || "").trim();
  const serializedBody = [
    serialized.question,
    serialized.detailedScene,
    serialized.answer,
    serialized.text,
  ].map((value) => String(value || "")).filter(Boolean).join("\n");
  for (const line of [...new Set(sourceText.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))]) {
    assert.ok(serializedBody.includes(line), `${evidenceId} must preserve source line: ${line}`);
  }
}

function card(id, name) {
  return {
    id,
    cardId: id,
    name,
    cnName: name,
    aliases: [name],
    effectText: "这张卡的处理需要查询相关官方问题。",
    text: "这张卡的处理需要查询相关官方问题。",
  };
}

function qa(id, question, cardId, overrides = {}) {
  return {
    id,
    recordType: "qa",
    title: question,
    question,
    rawQuestion: question,
    rawDetailedQuestion: question,
    answer: "官方回答正文。",
    text: `${question}\n官方回答正文。`,
    cardIds: [cardId],
    ...overrides,
  };
}

function multilingualQuery() {
  return [
    "能否连锁通常陷阱卡的发动，以正在发动的该陷阱卡为对象，发动将那张卡返回持有者手牌的效果",
    japaneseQuestion,
    "Can an effect be chained to a Normal Trap Card activation by targeting that resolving Trap and returning it to its owner's hand",
  ].join(" | ");
}

test("multilingual query normalization bounds each language branch independently", () => {
  const long = "甲".repeat(240);
  const normalized = normalizeRuleSearchQueryText(`${long}｜${japaneseQuestion}\nEnglish question`);
  const branches = splitRuleSearchQueryBranches(normalized);

  assert.equal(branches.length, 3);
  assert.equal(branches[0].length, 160);
  assert.equal(branches[1], japaneseQuestion);
  assert.equal(branches[2], "English question");
  assert.equal(selectOfficialQaSearchBranch(normalized), japaneseQuestion);

  const chineseWithJapaneseCardName = [
    "中文问题中提到日文卡名エルシャドール・ミドラーシュ时能否发动",
    "相手フィールドにモンスターが存在する場合、この効果を発動できますか",
  ].join(" | ");
  assert.equal(
    selectOfficialQaSearchBranch(chineseWithJapaneseCardName),
    "相手フィールドにモンスターが存在する場合、この効果を発動できますか",
  );
});

test("Relay Japanese question branch retrieves a cross-card official QA as related-only", async () => {
  const anchor = card("87001", "虚构检索锚点");
  const target = qa("qa-question-branch-target", japaneseQuestion, "87002");
  const decoys = Array.from({ length: 8 }, (_unused, index) => qa(
    `qa-question-branch-decoy-${index}`,
    `墓地のカード${index}を除外できますか`,
    String(87100 + index),
  ));

  const evidence = await retrieveRagEvidence({
    userQuery: "「虚构检索锚点」在这个连锁中能否处理？",
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: [target, ...decoys],
    ruleSearchQueries: [{
      subclaim: "确认连锁发动是否合法",
      checkpoint: "operation_legality",
      query: multilingualQuery(),
      source: "model_rule_query_extractor",
    }],
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "4",
    },
  });

  const retrieved = evidence.officialQaRelated.find((item) => item.id === target.id);
  assert.ok(retrieved);
  assert.equal(retrieved.isDirect, false);
  assert.equal(retrieved.retrievalContext?.relatedOnly, true);
  assert.notEqual(retrieved.retrievalSignals?.questionBranchMultilingualMechanismFallback, true);
  assert.ok(evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds.includes(target.id));
});

test("complete Japanese question text rescues a related-only candidate below classifier heads", async () => {
  const anchor = card("87301", "虚构灵摆检索锚点");
  const targetQuestion = [
    "ペンデュラムモンスターの魔法カードとしての発動を無効にした場合、",
    "そのカードは墓地へ送られますか？",
  ].join("");
  const target = qa("qa-question-text-fallback-target", "短い公式見出し", "87302", {
    rawDetailedQuestion: targetQuestion,
    rawQuestion: targetQuestion,
    question: targetQuestion,
    answer: "公式回答本文。",
    text: `${targetQuestion}\n公式回答本文。`,
  });
  const wrongOperation = qa(
    "qa-question-text-wrong-operation",
    "ペンデュラムモンスターの魔法カードとしての発動を無効にした場合、その後に特殊召喚できますか？",
    "87303",
  );
  const genericDecoys = Array.from({ length: 24 }, (_unused, index) => qa(
    `qa-question-text-generic-${index}`,
    `魔法カードの効果処理時にモンスターカード${index}を特殊召喚できますか？`,
    String(87400 + index),
  ));
  const relayQuestion = [
    "灵摆怪兽作为魔法卡的发动被无效时，那张卡会送去墓地吗",
    "ペンデュラムモンスターの魔法カードとしての発動が無効になった場合、そのカードは墓地へ送られますか",
    "When a Pendulum Monster activation as a Spell Card is negated, is that card sent to the Graveyard",
  ].join(" | ");

  const evidence = await retrieveRagEvidence({
    userQuery: "「虚构灵摆检索锚点」相关处理如何？",
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: [wrongOperation, ...genericDecoys, target],
    ruleSearchQueries: [{
      subclaim: "确认发动无效后的卡片去向",
      checkpoint: "resolution_snapshot",
      query: relayQuestion,
      source: "model_rule_query_extractor",
    }],
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "4",
    },
  });

  const candidateIds = evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds;
  const retrieved = evidence.officialQaRelated.find((item) => item.id === target.id);
  assert.ok(candidateIds.includes(target.id));
  assert.ok(retrieved);
  assert.equal(retrieved.isDirect, false);
  assert.equal(retrieved.retrievalContext?.relatedOnly, true);
  const targetRank = candidateIds.indexOf(target.id);
  const wrongRank = candidateIds.indexOf(wrongOperation.id);
  assert.ok(
    wrongRank < 0 || targetRank < wrongRank,
    JSON.stringify({ candidateIds, targetRank, wrongRank }),
  );

  const promptBundle = buildRagRulingPromptBundle({
    userQuery: "「虚构灵摆检索锚点」相关处理如何？",
    cardResolution: evidence.cardResolution,
    evidence,
    env: {
      RAG_MAX_PROMPT_REFERENCE_CHARS: "900",
      RAG_MAX_PROMPT_CHARS: "12000",
    },
  });
  assert.ok(promptBundle.allowedEvidenceIds.includes(target.id));
  assert.ok(!promptBundle.allowedEvidenceIds.includes(wrongOperation.id));
  assert.equal(promptBundle.promptTruncated, false);
});

test("answer text and questionless card FAQ cannot create a cross-card question hit", async () => {
  const anchor = card("87201", "另一个虚构锚点");
  const answerOnly = qa(
    "qa-answer-only-decoy",
    "全く別の公式質問ですか",
    "87202",
    { answer: japaneseQuestion, text: japaneseQuestion },
  );
  const questionlessFaq = {
    id: "card-faq-questionless-decoy",
    recordType: "card-faq",
    title: "虚构卡 FAQ 1",
    question: "虚构卡 FAQ 1",
    rawQuestion: "",
    rawDetailedQuestion: "",
    answer: japaneseQuestion,
    text: japaneseQuestion,
    cardIds: ["87203"],
    official: true,
  };
  const questionfulFaqAnswerDecoy = {
    id: "card-faq-answer-only-decoy",
    recordType: "card-faq",
    title: "虚构卡 FAQ 2",
    question: "墓地のカードを除外できますか？",
    rawQuestion: "墓地のカードを除外できますか？",
    rawDetailedQuestion: "墓地のカードを除外できますか？",
    answer: japaneseQuestion,
    text: `墓地のカードを除外できますか？ ${japaneseQuestion}`,
    cardIds: ["87204"],
    official: true,
  };

  const evidence = await retrieveRagEvidence({
    userQuery: "「另一个虚构锚点」如何处理？",
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: [answerOnly, questionlessFaq, questionfulFaqAnswerDecoy],
    ruleSearchQueries: [{ query: multilingualQuery(), source: "model_rule_query_extractor" }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  const ids = evidence.officialQaRelated.map((item) => item.id);
  assert.ok(!ids.includes(answerOnly.id));
  assert.ok(!ids.includes(questionlessFaq.id));
  assert.ok(!ids.includes(questionfulFaqAnswerDecoy.id));
});

test("a partial Planner plan leaves deterministic question branches to fill the fixed cross-card budget", async () => {
  const anchor = card("card-992001", "匿名补位锚点");
  const deterministicQuestion = "被除外的卡返回卡组时，是否作为从除外状态移动处理？";
  const target = qa(
    "qa-anonymous-deterministic-fill-target",
    deterministicQuestion,
    "card-992002",
  );
  const answerOnly = qa(
    "qa-anonymous-deterministic-answer-decoy",
    "与当前处理无关的官方问题？",
    "card-992003",
    { answer: deterministicQuestion, text: deterministicQuestion },
  );
  const questionlessFaq = {
    id: "card-faq-anonymous-deterministic-questionless-decoy",
    recordType: "card-faq",
    title: "匿名资料标题",
    question: "匿名资料标题",
    answer: deterministicQuestion,
    text: deterministicQuestion,
    cardIds: ["card-992004"],
    official: true,
  };
  const evidence = await retrieveRagEvidence({
    userQuery: `「${anchor.name}」涉及以下问题：${deterministicQuestion}`,
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: [answerOnly, questionlessFaq, target],
    ruleSearchQueries: [{
      subclaim: "核对另一条尚未覆盖的手牌分支",
      query: "手札のカードを公開できますか？",
      source: "model_rule_query_extractor",
    }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  const related = evidence.officialQaRelated.find((item) => item.id === target.id);
  assert.ok(evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds.includes(target.id));
  assert.ok(related);
  assert.equal(related.retrievalSignals?.questionBranchSearch, true);
  assert.equal(related.retrievalContext?.relatedOnly, true);
  assert.equal(related.isDirect, false);
  assert.ok(!evidence.officialQaRelated.some((item) => (
    item.id === answerOnly.id || item.id === questionlessFaq.id
  )));
});

test("supplemental mechanism retrieval keeps same-identity official QA scoped and related-only", async () => {
  const anchor = card("990001", "匿名同卡锚点");
  const scoped = qa(
    "qa-anonymous-scoped-supplemental",
    `「<<${anchor.id}>>」がフィールドに存在する場合、そのカードを持ち主の手札に戻すことができますか？`,
    anchor.id,
  );
  const evidence = await retrieveRagEvidence({
    userQuery: "「匿名同卡锚点」的相关处理是什么？",
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: [scoped],
    ruleSearchQueries: [{
      subclaim: "确认场上的卡能否返回持有者手牌",
      query: "场上的卡可以返回持有者手牌吗",
      source: "model_rule_query_extractor",
    }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  const related = evidence.officialQaRelated.find((item) => item.id === scoped.id);
  assert.ok(related);
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext?.relatedOnly, true);
  assert.notEqual(related.retrievalContext?.scope, "cross_card_official_mechanism");
  assert.ok((related.retrievalSignals?.strictSupplementalRuleQueryKeys || []).length > 0);
  assert.ok(evidence.debug.candidateStages.scopedOfficialRelatedCandidateIds.includes(scoped.id));
  assert.ok(!evidence.debug.candidateStages.allocatedCrossCardIds.includes(scoped.id));
  assert.ok(!evidence.officialQaDirectCandidates.some((item) => item.id === scoped.id));
});

test("scoped allocation canonicalizes aliases and preserves every bounded query branch", async () => {
  const left = card("990201", "匿名核心甲");
  const right = card("990202", "匿名核心乙");
  left.jaName = "匿名コア甲";
  left.aliases.push(left.jaName);
  right.jaName = "匿名コア乙";
  right.aliases.push(right.jaName);
  const multiPremiseOne = qa(
    "qa-anonymous-multi-premise-01",
    "「<<990301>>」の効果適用中に「<<990201>>匿名核心甲」や「<<990202>>匿名核心乙」を発動できますか？",
    left.id,
    {
      cardIds: [left.id, right.id, "990301"],
      cardNames: [left.name, right.name],
      questionCardIds: [left.id, right.id, "990301"],
    },
  );
  const multiPremiseTwo = qa(
    "qa-anonymous-multi-premise-02",
    "「<<990302>>」の効果適用中に「<<990201>>匿名コア甲」や「<<990202>>匿名コア乙」を発動できますか？",
    left.id,
    {
      cardIds: [left.id, right.id, "990302"],
      cardNames: [left.jaName, right.jaName],
      questionCardIds: [left.id, right.id, "990302"],
    },
  );
  const multiPremiseThree = qa(
    "qa-anonymous-multi-premise-03",
    "「<<990303>>」の効果適用中に「<<990201>>匿名核心甲」や「<<990202>>匿名コア乙」を発動できますか？",
    left.id,
    {
      cardIds: [left.id, right.id, "990303"],
      cardNames: [left.name, right.jaName],
      questionCardIds: [left.id, right.id, "990303"],
    },
  );
  const singleStrictOne = qa(
    "qa-anonymous-single-strict-one",
    "「<<990201>>」を墓地から除外できますか？",
    left.id,
    { questionCardIds: [left.id] },
  );
  const singleStrictTwo = qa(
    "qa-anonymous-single-strict-two",
    "「<<990202>>」を持ち主の手札に戻せますか？",
    right.id,
    { questionCardIds: [right.id] },
  );
  const evidence = await retrieveRagEvidence({
    userQuery: "匿名核心甲和匿名核心乙在两种不同限制适用中分别能否发动？",
    cardResolution: {
      resolvedCards: [left, right],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [left, right],
    records: [],
    qaRecords: [
      singleStrictOne,
      singleStrictTwo,
      multiPremiseThree,
      multiPremiseTwo,
      multiPremiseOne,
    ],
    ruleSearchQueries: [{
      subclaim: "确认墓地卡片能否除外",
      checkpoint: "affected_entity",
      query: "墓地からカードを除外できますか？",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认场上卡片能否返回手牌",
      checkpoint: "affected_entity",
      query: "フィールドのカードを持ち主の手札に戻せますか？",
      source: "model_rule_query_extractor",
    }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "3" },
  });

  const selectedIds = new Set(evidence.officialQaRelated.map((item) => item.id));
  const selectedMessage = JSON.stringify([...selectedIds]);
  assert.equal(
    [multiPremiseOne, multiPremiseTwo, multiPremiseThree]
      .filter((item) => selectedIds.has(item.id)).length,
    2,
    selectedMessage,
  );
  assert.equal(
    [...selectedIds].filter((id) => [singleStrictOne.id, singleStrictTwo.id].includes(id)).length,
    1,
  );
  assert.equal(evidence.officialQaRelated.length, 3);
  assert.ok(evidence.officialQaRelated.every((item) => item.retrievalContext?.relatedOnly === true));
  assert.ok(evidence.officialQaRelated.every((item) => item.isDirect === false));
});

test("a Chinese-only Planner branch keeps its bounded fallback when a Chinese phrase head also exists", async () => {
  const anchor = card("card-990101", "匿名跨语言锚点");
  const targetQuestion = "フィールドのカードを持ち主の手札に戻すことができますか？";
  const target = qa(
    "qa-anonymous-multilingual-target",
    targetQuestion,
    "card-990102",
  );
  const answerOnly = qa(
    "qa-anonymous-answer-only-decoy",
    "墓地のカードを除外できますか？",
    "card-990103",
    { answer: targetQuestion, text: `墓地のカードを除外できますか？\n${targetQuestion}` },
  );
  const genericOneFeature = qa(
    "qa-anonymous-generic-one-feature",
    "相手がターンを進めている場合の確認事項です。",
    "card-990107",
  );
  const sameLanguagePhraseHead = qa(
    "qa-anonymous-a-same-language-phrase-head",
    "对方场上的卡可以返回持有者手牌吗？",
    "card-990108",
  );
  const secondSameLanguagePhraseHead = qa(
    "qa-anonymous-b-same-language-phrase-head",
    "对方场上正在处理的卡能回到持有者手牌吗？",
    "card-990109",
  );
  const decoys = [
    qa("qa-anonymous-summon-decoy", "手札のモンスターを特殊召喚できますか？", "card-990104"),
    qa("qa-anonymous-destroy-decoy", "フィールドのカードを破壊できますか？", "card-990105"),
    qa("qa-anonymous-deck-decoy", "墓地のカードをデッキに戻せますか？", "card-990106"),
  ];
  const evidence = await retrieveRagEvidence({
    userQuery: "「匿名跨语言锚点」的相关处理是什么？",
    cardResolution: {
      resolvedCards: [anchor],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [anchor],
    records: [],
    qaRecords: [
      answerOnly,
      genericOneFeature,
      sameLanguagePhraseHead,
      secondSameLanguagePhraseHead,
      ...decoys,
      target,
    ],
    ruleSearchQueries: [{
      subclaim: "确认手牌怪兽的特殊召唤",
      checkpoint: "operation_legality",
      query: "手札のモンスターを特殊召喚できますか？",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认对方场上的卡能否返回持有者手牌",
      checkpoint: "affected_entity",
      query: "对方场上的卡可以返回持有者手牌吗",
      source: "model_rule_query_extractor",
    }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "4" },
  });

  const related = evidence.officialQaRelated.find((item) => item.id === target.id);
  assert.ok(evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds.includes(target.id));
  assert.ok(evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds.includes(
    sameLanguagePhraseHead.id,
  ));
  assert.ok(evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds.includes(
    secondSameLanguagePhraseHead.id,
  ));
  assert.ok(
    related,
    JSON.stringify(evidence.officialQaRelated.map((item) => item.id)),
  );
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext?.relatedOnly, true);
  assert.equal(related.retrievalContext?.scope, "cross_card_official_mechanism");
  assert.equal(related.retrievalSignals?.questionBranchSearch, true);
  assert.equal(related.retrievalSignals?.questionBranchMultilingualMechanismFallback, true);
  assert.ok(!evidence.officialQaRelated.some((item) => item.id === answerOnly.id));
  assert.ok(!evidence.debug.candidateStages.ruleQueryQuestionBranchCandidateIds.includes(
    genericOneFeature.id,
  ));
  assert.ok(!evidence.officialQaRelated.some((item) => item.id === genericOneFeature.id));
  assert.ok(!evidence.officialQaDirectCandidates.some((item) => item.id === target.id));
  assert.ok(evidence.officialQaRelated.filter((item) => (
    item.retrievalContext?.scope === "cross_card_official_mechanism"
  )).length <= 4);
});

test("four-slot coverage preserves the highest pure strict mechanism representative", () => {
  const questionBranch = (index) => ({
    id: `qa-anonymous-question-branch-${index}`,
    type: "related",
    text: `anonymous question branch ${index}`,
    retrievalSignals: {
      questionBranchSearch: true,
      strictSupplementalRuleQueryKeys: [`branch-${index}`],
    },
  });
  const pureStrict = (id, queryKey) => ({
    id,
    type: "related",
    text: `anonymous strict mechanism ${id}`,
    retrievalSignals: { strictSupplementalRuleQueryKeys: [queryKey] },
  });
  const highestPureStrict = pureStrict("qa-anonymous-pure-strict-high", "strict-high");
  const lowerPureStrict = pureStrict("qa-anonymous-pure-strict-low", "strict-low");
  const selected = reserveRankedHeadAndSupplementalCoverage([
    questionBranch(1),
    highestPureStrict,
    questionBranch(2),
    questionBranch(3),
    questionBranch(4),
    lowerPureStrict,
  ], 4, {
    queryKeys: ["branch-1", "branch-2", "branch-3", "branch-4"],
    strictOnly: true,
    preserveStrictMechanismRepresentative: true,
  }).slice(0, 4);

  assert.equal(selected.length, 4);
  assert.ok(selected.some((item) => item.id === highestPureStrict.id));
  assert.ok(!selected.some((item) => item.id === lowerPureStrict.id));
  assert.equal(selected.filter((item) => (
    item.retrievalSignals?.questionBranchSearch !== true
      && (item.retrievalSignals?.strictSupplementalRuleQueryKeys || []).length > 0
  )).length, 1);
});

test("cross-card allocation preserves a non-strict representative for every bounded query branch", () => {
  const candidate = (id, queryKey, rank, { strict = false } = {}) => ({
    id,
    type: "related",
    text: `anonymous evidence ${id}`,
    retrievalSignals: {
      ruleQueryKeys: [queryKey],
      ruleQueryRanks: { [queryKey]: rank },
      ...(strict ? { strictRuleQueryKeys: [queryKey] } : {}),
    },
  });
  const selected = reserveUncoveredCrossCardBranches([
    candidate("qa-anonymous-strict-1", "branch-1", 1, { strict: true }),
    candidate("qa-anonymous-strict-2", "branch-2", 1, { strict: true }),
    candidate("qa-anonymous-strict-3", "branch-3", 1, { strict: true }),
    candidate("qa-anonymous-branch-4-decoy", "branch-4", 2),
    candidate("qa-anonymous-branch-4-target", "branch-4", 1),
  ], 4, {
    queryKeys: ["branch-1", "branch-2", "branch-3", "branch-4"],
  });

  assert.deepEqual(selected.map((item) => item.id), [
    "qa-anonymous-strict-1",
    "qa-anonymous-strict-2",
    "qa-anonymous-strict-3",
    "qa-anonymous-branch-4-target",
  ]);
});

test("cross-card allocation keeps the ranked head beside four planner branches", () => {
  const head = {
    id: "qa-anonymous-ranked-head",
    type: "related",
    text: "anonymous highest-ranked official question",
    retrievalScore: 0.99,
  };
  const branch = (index) => ({
    id: `qa-anonymous-planner-branch-${index}`,
    type: "related",
    text: `anonymous planner branch ${index}`,
    retrievalSignals: {
      strictRuleQueryKeys: [`branch-${index}`],
      ruleQueryKeys: [`branch-${index}`],
      ruleQueryRanks: { [`branch-${index}`]: 1 },
    },
  });
  const selected = reserveUncoveredCrossCardBranches([
    head,
    branch(1),
    branch(2),
    branch(3),
    branch(4),
  ], 5, {
    queryKeys: ["branch-1", "branch-2", "branch-3", "branch-4"],
  });

  assert.deepEqual(selected.map((item) => item.id), [
    head.id,
    "qa-anonymous-planner-branch-1",
    "qa-anonymous-planner-branch-2",
    "qa-anonymous-planner-branch-3",
    "qa-anonymous-planner-branch-4",
  ]);
});

test("scoped allocation recognizes safe related-question identity matches", () => {
  const left = card("card-993001", "匿名身份甲");
  const right = card("card-993002", "匿名身份乙");
  const singleIdentity = (index) => ({
    id: `qa-anonymous-single-identity-${index}`,
    type: "related",
    text: `anonymous single identity ${index}`,
    matchedQuestionCardIds: [left.id],
  });
  const multiIdentity = {
    id: "qa-anonymous-related-question-multi-identity",
    type: "related",
    text: "anonymous related-question multi identity",
    matchedRelatedQuestionCardIds: [left.id, right.id],
  };
  const selected = allocateOfficialRelatedEvidence({
    scopedCandidates: [singleIdentity(1), singleIdentity(2), multiIdentity],
    crossCardCandidates: [],
    limit: 2,
    resolvedCards: [left, right],
  });

  assert.equal(selected.length, 2);
  assert.ok(selected.some((item) => item.id === multiIdentity.id));
});

test("scoped identity coverage ignores source-metadata-only card bindings", () => {
  const left = card("card-993101", "匿名身份甲");
  const right = card("card-993102", "匿名身份乙");
  const metadataOnly = {
    id: "qa-anonymous-metadata-only-multi-identity",
    type: "related",
    text: "anonymous metadata-only identity",
    matchedQuestionCardIds: [left.id],
    matchedRelatedMetadataCardIds: [right.id],
  };
  const genuineQuestionSide = {
    id: "qa-anonymous-question-side-multi-identity",
    type: "related",
    text: "anonymous question-side multi identity",
    matchedRelatedQuestionCardIds: [left.id, right.id],
  };
  const selected = allocateOfficialRelatedEvidence({
    scopedCandidates: [metadataOnly, genuineQuestionSide],
    crossCardCandidates: [],
    limit: 1,
    resolvedCards: [left, right],
  });

  assert.deepEqual(selected.map((item) => item.id), [genuineQuestionSide.id]);
});

test("unassessed cross-card padding does not consume a fixed reserve beside scoped evidence", () => {
  const focus = card("card-993201", "匿名焦点卡");
  const scopedCandidates = Array.from({ length: 5 }, (_, index) => ({
    id: `qa-anonymous-scoped-${index + 1}`,
    type: "related",
    text: `anonymous scoped ${index + 1}`,
    matchedQuestionCardIds: [focus.id],
  }));
  const crossCardCandidates = Array.from({ length: 5 }, (_, index) => ({
    id: `qa-anonymous-unassessed-cross-${index + 1}`,
    type: "related",
    text: `anonymous unassessed cross ${index + 1}`,
  }));
  const selected = allocateOfficialRelatedEvidence({
    scopedCandidates,
    crossCardCandidates,
    limit: 5,
    resolvedCards: [focus],
    supplementalRuleQueryKeys: ["branch-1", "branch-2", "branch-3", "branch-4"],
  });

  assert.equal(selected.filter((item) => item.id.includes("scoped")).length, 5);
  assert.equal(selected.filter((item) => item.id.includes("unassessed-cross")).length, 0);
});

test("scoped allocation does not discard a later multi-card premise variant", () => {
  const left = card("card-994001", "匿名身份甲");
  const right = card("card-994002", "匿名身份乙");
  const premise = (index, cardIds) => ({
    id: `qa-anonymous-premise-${index}`,
    type: "related",
    text: `anonymous premise ${index}`,
    questionCardIds: [...cardIds, `external-${index}`],
    retrievalSignals: {
      strictRuleQueryKeys: ["shared-anonymous-branch"],
    },
  });
  const selected = allocateOfficialRelatedEvidence({
    scopedCandidates: [
      premise(1, [left.id, right.id]),
      premise(2, [left.id, right.id]),
      premise(3, [left.id, right.id]),
      premise(4, [left.id]),
    ],
    crossCardCandidates: [],
    limit: 3,
    resolvedCards: [left, right],
  });

  assert.deepEqual(selected.map((item) => item.id), [
    "qa-anonymous-premise-1",
    "qa-anonymous-premise-2",
    "qa-anonymous-premise-3",
  ]);
});

test("current retrieval-only regressions keep canonical card text and decisive official questions visible", async () => {
  const data = await loadRagData(fileURLToPath(new URL("../data", import.meta.url)));
  const cardById = new Map(data.cards.map((item) => [String(item.id || item.cardId), item]));
  const qaById = new Map(data.qaRecords.map((item) => [String(item.id), item]));
  const retrievalEnv = { RAG_LIVE_OFFICIAL_QA: "false" };
  const promptEnv = {
    RAG_MAX_PROMPT_REFERENCE_CHARS: "14000",
    RAG_MAX_PROMPT_CHARS: "36000",
  };
  const identityQuestion = "请问一下如果对方 龙都 亚特兰蒂斯的降星效果适用中，我方使用我我我魔导士-我我我魔导的效果，以墓地里一只6星怪兽为对象，并适用“那之际，要作为多维素材的1只怪兽的等级视为与另1只怪兽相同的等级。”的效果，最终超量召唤的怪兽是阶级5还是阶级6";

  const identityEvidence = await retrieveRagEvidence({
    userQuery: identityQuestion,
    cardResolution: {
      resolvedCards: [{
        id: "38391684",
        cardId: "38391684",
        cid: "23380",
        name: "龙都 亚特兰蒂斯",
        aliases: ["龙都 亚特兰蒂斯"],
        effectText: "",
        text: "",
        source: "baige",
        externalSurfaceResolution: "unique_exact_primary_name",
      }, {
        id: "12908094",
        cardId: "12908094",
        cid: "22700",
        name: "我我我魔导士-我我我魔导",
        aliases: ["我我我魔导士-我我我魔导"],
        effectText: "",
        text: "",
        source: "baige",
        externalSurfaceResolution: "unique_exact_primary_name",
      }],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    enableLiveOfficialQa: false,
    env: retrievalEnv,
  });
  assert.deepEqual(
    identityEvidence.cardResolution.resolvedCards.map((item) => item.id),
    ["23380", "22700"],
  );
  assert.deepEqual(
    identityEvidence.cardTexts.map((item) => item.id),
    ["card-text-23380", "card-text-22700"],
  );
  assert.ok(identityEvidence.cardTexts.every((item) => item.text.length > 100));
  const identityPrompt = buildRagRulingPromptBundle({
    userQuery: identityQuestion,
    cardResolution: identityEvidence.cardResolution,
    evidence: identityEvidence,
    env: promptEnv,
  });
  assert.equal(identityPrompt.promptTruncated, false);
  const identityPayload = parsePromptPayload(identityPrompt.prompt);
  const identityCards = new Map(identityPayload.resolvedCards.map((item) => [String(item.id), item]));
  for (const id of ["23380", "22700"]) {
    assert.equal(
      identityCards.get(id)?.effectText,
      cardById.get(id)?.effectText,
      `${id} complete cards.json effect text must remain in the final prompt`,
    );
  }
  assert.match(
    identityCards.get("23380").effectText,
    /このカードを自分フィールドに表側表示で置く。$/u,
  );
  assert.match(
    identityCards.get("22700").effectText,
    /在此之际，要作为超量素材的1只怪兽的等级可视为与另1只怪兽的等级相同。$/u,
  );

  const cases = [{
    question: "对方场上有绚岚之达维，我方以达维为对象发动无限泡影，这时场上没有其他魔陷，对方能不能发动天雷之双风神？",
    cardIds: ["21779", "13631", "22130", "4909"],
    referenceCardIds: ["4909"],
    ruleQuestions: [{
      subclaim: "确认对手发动通常陷阱卡效果时，场上存在风属性怪兽的一方能否连锁发动手牌怪兽的诱发即时效果",
      checkpoint: "operation_legality",
      query: "通常陷阱发动时 手牌诱发即时效果 连锁 风属性怪兽 | 通常罠発動時 手札 誘発即時 チェーン | Trap activation hand Quick Effect",
      reason: "检索『无限泡影』发动后，对方响应其陷阱效果发动『天雷之双风神 息那』①效果的发动条件与连锁窗口",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认该手牌怪兽效果结算时，先从手牌特殊召唤自身是否为必须执行的处理步骤",
      checkpoint: "mandatory_step",
      query: "先特殊召唤自身 然后适用后续效果 必须处理 | 自身を特殊召喚 その後 適用 必須 | Special Summon itself then mandatory",
      reason: "卡文含有“然后”，需要分别确认特殊召唤步骤及其与后续处理的关系",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认响应陷阱效果发动时，后续处理所参照的效果种类，以及场上的魔法・陷阱卡全部返回手牌的处理范围",
      checkpoint: "affected_entity",
      query: "根据对手效果种类适用 陷阱 场上魔陷全部回手 | 効果種類により適用 罠 魔法罠を全て手札 | effect type all Spells Traps",
      reason: "检索强制分支如何按被响应的陷阱效果确定，以及处理时实际受影响的场上魔法・陷阱卡",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认正在连锁中发动且仍位于魔法・陷阱区域的通常陷阱卡，能否在先结算的效果中返回手牌，以及其后续结算如何判断对象状态",
      checkpoint: "resolution_snapshot",
      query: "连锁处理中 发动中的陷阱 返回手牌 对象状态 | チェーン処理中 発動中の罠 手札 対象 | resolving Trap returned target status",
      reason: "场上原本没有其他魔法・陷阱卡，但已发动的『无限泡影』在连锁处理中涉及当前位置及其自身结算时的对象快照",
      confidence: "high",
      source: "model_rule_query_extractor",
    }],
    expectedQaId: "ygoresources-qa-8129",
    requiredEvidenceIds: [
      "card-faq-22130-1",
      "ygoresources-qa-8129",
    ],
    expectedPromptSnippets: [
      "(A)(C)(D)発動できません。",
      "「<<4836>>」通常罠カード",
    ],
  }, {
    question: "灵摆怪贴到灵摆区域，其发动被无效；异次元竞技场适用时，那张灵摆怪兽送墓还是除外？",
    cardIds: ["9154"],
    ruleQuestions: [{
      subclaim: "确认将灵摆怪兽置于灵摆区域是否属于作为魔法卡的卡的发动、是否形成连锁，以及该发动能否被无效",
      checkpoint: "effect_source_type",
      query: "将灵摆怪兽置于灵摆区域时是否形成连锁，以及能否无效该发动 | ペンデュラムモンスターをペンデュラムゾーンに置く際にチェーンブロックは作られますか。また、それを無効にする事はできますか | Does placing a Pendulum Monster in the Pendulum Zone start a Chain, and can that activation be negated",
      reason: "先独立检索题面前置动作的规则性质，不能与发动无效后的去向混成一个查询",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认灵摆怪兽作为魔法卡在灵摆区域的发动被无效时，该卡随后送往墓地还是表侧加入额外卡组",
      checkpoint: "post_resolution",
      query: "灵摆怪兽作为魔法卡的发动被无效时会怎样处理 | ペンデュラムモンスターの魔法カードとしての発動を無効にした場合、どうなりますか | What happens when a Pendulum Monster's activation as a Spell Card is negated",
      reason: "独立检索发动无效后该卡的规则上去向，不与替代效果的适用范围混合",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认异次元竞技场对发动被无效、离开灵摆区域的灵摆怪兽卡是否满足“被送往墓地的怪兽”这一适用范围",
      checkpoint: "affected_entity",
      query: "被送往墓地的怪兽 灵摆魔法 发动无效 | 墓地へ送られるモンスター P魔法 発動無効 | monster sent to GY",
      reason: "检索除外替代效果所判断的实际受影响实体及其身份判定时点",
      confidence: "high",
      source: "model_rule_query_extractor",
    }],
    expectedQaId: "ygoresources-qa-13144",
    requiredEvidenceIds: [
      "card-faq-9154-1",
      "ygoresources-qa-13142",
      "ygoresources-qa-13144",
    ],
    excludedQaIds: ["ygoresources-qa-13146"],
    expectedPromptSnippets: [
      "発動が無効になり破壊されます",
      "エクストラデッキから「<<11135>>」を墓地へ送る事はありません。",
    ],
  }, {
    question: "对方不受卡片效果影响的怪兽攻击宣言我方怪兽时，我方能否除外墓地的神艺通常魔法来无效该次攻击？",
    cardIds: ["21469"],
    ruleQuestions: [{
      subclaim: "确认墓地通常魔法在己方怪兽成为攻击对象时，能否除外自身发动无效攻击的效果",
      checkpoint: "activation_snapshot",
      query: "墓地通常魔法除外自身发动无效攻击",
      reason: "核对发动条件",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认攻击怪兽不受卡片效果影响时，无效该次攻击的处理能否适用",
      checkpoint: "resolution_snapshot",
      query: "不受卡片效果影响的攻击怪兽能否被无效攻击",
      reason: "核对效果处理与不受影响状态",
      confidence: "high",
      source: "model_rule_query_extractor",
    }, {
      subclaim: "确认攻击无效处理未适用时，其后处理是否继续",
      checkpoint: "step_dependency",
      query: "攻击无效未适用时其后处理是否继续",
      reason: "核对连续处理依赖",
      confidence: "high",
      source: "model_rule_query_extractor",
    }],
    expectedQaId: "ygoresources-qa-7040",
    requiredEvidenceIds: [
      "card-faq-21469-1",
      "card-faq-21469-2",
      "ygoresources-qa-7040",
    ],
    expectedPromptSnippets: [
      "相手モンスターの攻撃を無効にする事はできず",
      "『その後バトルフェイズを終了する』処理も適用されません。",
    ],
  }];

  for (const fixture of cases) {
    const cardResolution = {
      resolvedCards: fixture.cardIds.map((id) => ({
        ...cardById.get(id),
        // The real case-018 pipeline discovers Mystical Space Typhoon only
        // from Eldam's card text. Preserve that evidence role in the frozen
        // replay so it cannot masquerade as a card named by the player and
        // flood card-scoped official-QA ranking.
        ...((fixture.referenceCardIds || []).includes(id)
          ? { resolutionSource: "card_text_reference" }
          : {}),
      })),
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    };
    assert.ok(cardResolution.resolvedCards.every(Boolean));
    const evidence = await retrieveRagEvidence({
      userQuery: fixture.question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      ruleSearchQueries: fixture.ruleQuestions,
      enableLiveOfficialQa: false,
      env: retrievalEnv,
    });
    assert.ok(
      evidence.debug.candidateStages.crossCardRankedPoolIds.includes(fixture.expectedQaId),
      `${fixture.expectedQaId} must enter the raw cross-card candidate pool: ${JSON.stringify({
        queries: evidence.debug.ruleSearchQueries,
        stages: evidence.debug.candidateStages,
      })}`,
    );
    assert.ok(
      evidence.debug.candidateStages.crossCardEvidenceCandidateIds.includes(fixture.expectedQaId),
      `${fixture.expectedQaId} must survive candidate conversion`,
    );
    const related = evidence.officialQaRelated.find((item) => item.id === fixture.expectedQaId);
    assert.ok(
      related,
      `${fixture.expectedQaId} must be allocated as official related evidence: ${JSON.stringify({
        allocated: evidence.debug.candidateStages.allocatedOfficialRelatedIds,
        crossCardPool: evidence.debug.candidateStages.crossCardRankedPoolIds,
        converted: evidence.debug.candidateStages.crossCardEvidenceCandidateIds,
      })}`,
    );
    assert.equal(related.retrievalContext?.relatedOnly, true);
    assert.equal(related.isDirect, false);
    assert.equal(related.retrievalSignals?.questionBranchSearch, true);
    assert.ok(!evidence.officialQaDirectCandidates.some((item) => item.id === fixture.expectedQaId));
    assert.ok(
      evidence.officialQaRelated.filter((item) => (
        item.retrievalContext?.scope === "cross_card_official_mechanism"
      )).length <= 5,
    );
    const promptBundle = buildRagRulingPromptBundle({
      userQuery: fixture.question,
      cardResolution: evidence.cardResolution,
      evidence,
      env: promptEnv,
    });
    assert.ok(
      promptBundle.allowedEvidenceIds.includes(fixture.expectedQaId),
      `${fixture.expectedQaId} must remain model-visible: ${JSON.stringify({
        allowed: promptBundle.allowedEvidenceIds,
        warnings: promptBundle.warnings,
        related: evidence.officialQaRelated.map((item) => ({
          id: item.id,
          score: item.retrievalScore,
          signals: item.retrievalSignals,
        })),
      })}`,
    );
    assert.equal(promptBundle.promptTruncated, false);
    assert.ok(promptBundle.promptChars <= Number(promptEnv.RAG_MAX_PROMPT_CHARS));
    const promptPayload = parsePromptPayload(promptBundle.prompt);
    const visibleEvidence = promptEvidenceById(promptPayload);
    for (const evidenceId of fixture.requiredEvidenceIds || []) {
      assert.ok(
        promptBundle.allowedEvidenceIds.includes(evidenceId),
        `${evidenceId} must be present in allowedEvidenceIds: ${JSON.stringify({
          allowed: promptBundle.allowedEvidenceIds,
          officialRelated: evidence.officialQaRelated.map((item) => item.id),
          faqRelated: evidence.faqRelated.map((item) => item.id),
          stages: evidence.debug.candidateStages,
          warnings: promptBundle.warnings,
        })}`,
      );
      const source = qaById.get(evidenceId);
      const serialized = visibleEvidence.get(evidenceId);
      assert.ok(source, `${evidenceId} must exist uniquely in qa-index.json`);
      assert.ok(serialized, `${evidenceId} must be serialized in the final prompt`);
      assertCompleteSourceEvidenceBody(evidenceId, source, serialized);
      if (source.sourceUrl) {
        assert.equal(
          Object.hasOwn(serialized, "sourceUrl"),
          false,
          `${evidenceId}.sourceUrl must stay out of the model-visible prompt`,
        );
        const diagnostic = promptBundle.evidenceSelectionDiagnostics.find(
          (item) => item.id === evidenceId,
        );
        assert.equal(
          diagnostic?.sourceUrl,
          source.sourceUrl,
          `${evidenceId}.sourceUrl must remain source-equal in diagnostics`,
        );
      }
    }
    for (const snippet of fixture.expectedPromptSnippets || []) {
      assert.ok(
        promptBundle.prompt.includes(snippet),
        `${fixture.expectedQaId} complete body marker must remain in the final prompt: ${snippet}`,
      );
    }
    for (const excludedQaId of fixture.excludedQaIds || []) {
      assert.ok(!promptBundle.allowedEvidenceIds.includes(excludedQaId));
      assert.ok(!visibleEvidence.has(excludedQaId));
      assert.ok(!promptBundle.prompt.includes(excludedQaId));
    }
  }
});

test("multi-card scoped allocation keeps a complete related-question identity record", async () => {
  const data = await loadRagData(fileURLToPath(new URL("../data", import.meta.url)));
  const cardById = new Map(data.cards.map((item) => [String(item.id || item.cardId), item]));
  const qaById = new Map(data.qaRecords.map((item) => [String(item.id), item]));
  const question = "名推理或怪兽之门是否只在完全不能特殊召唤时不能发动；仅限制特殊召唤某类怪兽时，能否继续发动并翻开卡组？";
  const cardIds = ["5530", "5576", "9139", "10695", "5980", "8087"];
  let candidateQuestionsSeen = [];
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: {
      resolvedCards: cardIds.map((id) => cardById.get(id)),
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    ruleSearchQueryProvider: async ({ candidateQuestions }) => {
      candidateQuestionsSeen = candidateQuestions;
      return {
        queries: [{
          subclaim: "确认不能特殊召唤怪兽时，是否可以发动会翻开卡组并要求特殊召唤怪兽的效果",
          checkpoint: "operation_legality",
          query: "不能特殊召唤怪兽时能否发动翻开卡组并特殊召唤的效果",
          source: "model_rule_query_extractor",
        }, {
          subclaim: "确认只禁止特殊召唤特定类别以外怪兽时，翻到的怪兽不符合限制会如何处理",
          checkpoint: "operation_legality",
          query: "存在种类限制时翻到不能特殊召唤的怪兽如何处理",
          source: "model_rule_query_extractor",
        }, {
          subclaim: "确认处理时翻到可通常召唤怪兽但当前不能特殊召唤时，翻开的卡如何处理",
          checkpoint: "resolution_snapshot",
          query: "翻到可通常召唤怪兽但不能特殊召唤时的后续处理",
          source: "model_rule_query_extractor",
        }],
        candidateAssessments: [{
          id: "ygoresources-qa-8186",
          relevance: "high",
          premise: "partial",
          difference: "官方问题覆盖完全不能特殊召唤这一分支。",
          source: "model_rule_query_soft_ranker",
        }],
      };
    },
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });
  const expectedQaId = "ygoresources-qa-8186";
  assert.ok(candidateQuestionsSeen.some((item) => item.id === expectedQaId));
  assert.ok(evidence.debug.candidateStages.scopedOfficialMatchIds.includes(expectedQaId));
  assert.ok(evidence.debug.candidateStages.scopedOfficialRelatedCandidateIds.includes(expectedQaId));
  assert.ok(
    evidence.officialQaRelated.some((item) => item.id === expectedQaId),
    JSON.stringify({
      allocated: evidence.debug.candidateStages.allocatedOfficialRelatedIds,
      scoped: evidence.debug.candidateStages.scopedOfficialRelatedCandidateIds,
    }),
  );
  const promptBundle = buildRagRulingPromptBundle({
    userQuery: question,
    cardResolution: evidence.cardResolution,
    evidence,
    env: {
      RAG_MAX_PROMPT_REFERENCE_CHARS: "14000",
      RAG_MAX_PROMPT_CHARS: "36000",
    },
  });
  assert.equal(promptBundle.promptTruncated, false);
  assert.ok(promptBundle.allowedEvidenceIds.includes(expectedQaId));
  const serialized = promptEvidenceById(parsePromptPayload(promptBundle.prompt)).get(expectedQaId);
  const source = qaById.get(expectedQaId);
  assert.ok(source);
  assert.ok(serialized);
  assertCompleteSourceEvidenceBody(expectedQaId, source, serialized);
});

test("default public retrieval keeps the complete governing official QA visible without truncation", async () => {
  const data = await loadRagData(fileURLToPath(new URL("../data", import.meta.url)));
  const qaById = new Map(data.qaRecords.map((item) => [String(item.id), item]));
  const question = "对方场上表侧表示存在「千查万别」，我方场上表侧表示存在「闪刀姬＝零露」。我方可以发动「闪刀姬＝零露」的②效果吗？效果处理时先做什么；如果最后破坏「千查万别」或破坏其他卡，场上的两只怪兽分别如何处理？";
  const expectedQaId = "ygoresources-qa-24189";
  const cardResolution = extractRagCards(question, {
    cards: data.cards,
    maxCards: 8,
  });
  const resolvedIds = new Set(cardResolution.resolvedCards.map((item) => String(item.id)));
  assert.ok(resolvedIds.has("13447"));
  assert.ok(resolvedIds.has("21460"));

  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });
  const stages = evidence.debug.candidateStages;
  assert.ok(stages.scopedOfficialMatchIds.includes(expectedQaId));
  assert.ok(stages.scopedOfficialRelatedCandidateIds.includes(expectedQaId));
  assert.ok(stages.allocatedOfficialRelatedIds.includes(expectedQaId));
  const related = evidence.officialQaRelated.find((item) => item.id === expectedQaId);
  assert.ok(related);
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext?.relatedOnly, true);
  assert.ok(!evidence.officialQaDirectCandidates.some((item) => item.id === expectedQaId));

  const promptBundle = buildRagRulingPromptBundle({
    userQuery: question,
    cardResolution: evidence.cardResolution,
    evidence,
  });
  assert.equal(promptBundle.promptTruncated, false);
  assert.ok(promptBundle.allowedEvidenceIds.includes(expectedQaId));
  assert.ok(promptBundle.modelEvidence.officialQaRelated.some((item) => item.id === expectedQaId));
  const source = qaById.get(expectedQaId);
  const serialized = promptEvidenceById(parsePromptPayload(promptBundle.prompt)).get(expectedQaId);
  assert.ok(source);
  assert.ok(serialized);
  assertCompleteSourceEvidenceBody(expectedQaId, source, serialized);
});
