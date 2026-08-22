import assert from "node:assert/strict";
import test from "node:test";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import {
  normalizeRuleSearchQueryText,
  selectOfficialQaSearchBranch,
  splitRuleSearchQueryBranches,
} from "../backend/ruleSearchQueryText.mjs";

const japaneseQuestion = "通常罠カードの発動にチェーンして、発動中のその罠カードを対象とし、持ち主の手札に戻す効果を発動できますか";

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
  assert.ok(wrongRank < 0 || targetRank < wrongRank);
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
