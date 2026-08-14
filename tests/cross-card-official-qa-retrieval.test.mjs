import assert from "node:assert/strict";
import test from "node:test";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

function syntheticCard(id, name, effectText) {
  return {
    id,
    cardId: id,
    name,
    cnName: name,
    aliases: [name],
    effectText,
    text: effectText,
  };
}

test("a cross-card official mechanism QA is retained as related-only evidence", async () => {
  const current = syntheticCard(
    "41001",
    "匿名耐性怪兽甲",
    "这张卡不受其他卡的效果影响。",
  );
  const scopedDecoys = Array.from({ length: 6 }, (_unused, index) => ({
    id: `qa-scoped-decoy-${index}`,
    recordType: "qa",
    question: `「<<41001>>」被召唤时可以发动另一效果吗？资料 ${index}`,
    rawDetailedQuestion: `「<<41001>>」被召唤时可以发动另一效果吗？资料 ${index}`,
    answer: "这是只涉及召唤时点的资料。",
    cardIds: ["41001"],
  }));
  const crossCardMechanism = {
    id: "qa-cross-card-mechanism",
    recordType: "qa",
    question: "不受其他卡效果影响的攻击怪兽进行攻击时，可以发动使那次攻击无效的效果吗？",
    rawDetailedQuestion: "「<<42001>>」不受其他卡效果影响并进行攻击。发动「<<42002>>」使那次攻击无效时，处理会怎样？",
    answer: "该官方问答分别说明发动是否合法以及处理是否适用。",
    cardIds: ["42001", "42002"],
  };

  const evidence = await retrieveRagEvidence({
    userQuery: "不受其他卡效果影响的「匿名耐性怪兽甲」攻击时，对方能否发动使攻击无效的效果，处理时会怎样？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [...scopedDecoys, crossCardMechanism],
    ruleSearchQueries: [{
      query: "不受卡片效果影响的攻击怪兽 使攻击无效 发动条件 效果处理",
      reason: "检索作用实体与发动/处理差异",
      confidence: "high",
    }],
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "6",
    },
  });

  const related = evidence.officialQaRelated.find((item) => item.id === crossCardMechanism.id);
  assert.ok(related, "the complete official QA pool should supply a matching cross-card mechanism");
  assert.equal(related.official, true);
  assert.equal(related.type, "related");
  assert.equal(related.isDirect, false);
  assert.equal(related.retrievalContext.scope, "cross_card_official_mechanism");
  assert.equal(related.retrievalContext.relatedOnly, true);
  assert.ok(evidence.officialQaDirectCandidates.every((item) => item.id !== crossCardMechanism.id));
});

test("generic activation and resolution words cannot authorize an unrelated cross-card QA", async () => {
  const current = syntheticCard("51001", "匿名对象甲", "这张卡不受其他卡的效果影响。");
  const unrelated = {
    id: "qa-cross-card-generic-only",
    recordType: "qa",
    question: "某个效果发动并处理后，能否特殊召唤怪兽？",
    rawDetailedQuestion: "「<<52001>>」的效果发动并完成处理后，能否发动另一效果特殊召唤？",
    answer: "这是只涉及特殊召唤的资料。",
    cardIds: ["52001"],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "不受其他卡效果影响的「匿名对象甲」攻击时，能否发动使攻击无效的效果，处理时会怎样？",
    cardResolution: {
      resolvedCards: [current],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [current],
    records: [],
    qaRecords: [unrelated],
    ruleSearchQueries: [{ query: "不受效果影响 攻击无效 发动 效果处理" }],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false", RAG_MAX_RELATED_EVIDENCE: "6" },
  });

  assert.ok(evidence.officialQaRelated.every((item) => item.id !== unrelated.id));
  assert.ok(evidence.officialQaDirectCandidates.every((item) => item.id !== unrelated.id));
});

test("retriever provenance survives the real prompt boundary without promoting community QA", async () => {
  const current = syntheticCard("61001", "匿名对象乙", "这张卡的效果处理后进行一次操作。");
  const communityQa = {
    id: "community-qa-shaped-reference",
    recordType: "qa",
    official: false,
    source: "ocg-rule-community",
    sourceTier: "S2_COMMUNITY_REFERENCE",
    question: "「<<61001>>」的效果发动并处理后如何继续？",
    rawDetailedQuestion: "「<<61001>>」的效果发动并处理后如何继续？",
    answer: "这是社区整理的辅助说明。",
    cardIds: ["61001"],
  };
  const cardResolution = {
    resolvedCards: [current],
    unresolvedMentions: [],
    ambiguousMentions: [],
    userProvidedCardTexts: [],
  };
  const evidence = await retrieveRagEvidence({
    userQuery: "「匿名对象乙」的效果发动并处理后如何继续？",
    cardResolution,
    cards: [current],
    records: [communityQa],
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.ok(evidence.officialQaRelated.every((item) => item.id !== communityQa.id));
  const retrieved = evidence.rawRelatedEvidence.find((item) => item.id === communityQa.id);
  assert.ok(retrieved);
  assert.equal(retrieved.official, false);
  assert.equal(retrieved.sourceAuthority, "community_reference");

  const bundle = buildRagRulingPromptBundle({
    userQuery: "「匿名对象乙」的效果发动并处理后如何继续？",
    cardResolution,
    evidence,
  });
  const promptItem = bundle.modelEvidence.rawRelatedEvidence.find(
    (item) => item.id === communityQa.id,
  );
  assert.ok(promptItem);
  assert.equal(promptItem.official, false);
  assert.equal(promptItem.source, "ocg-rule-community");
  assert.equal(promptItem.sourceTier, "S2_COMMUNITY_REFERENCE");
  assert.equal(promptItem.sourceAuthority, "community_reference");
});

test("deterministic multilingual expansion preserves phase distinctions", async () => {
  const evidence = await retrieveRagEvidence({
    userQuery: "伤害步骤结束时和伤害计算后的状态是否相同？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [],
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.match(evidence.ruleSearchQueries[0].query, /ダメージステップ終了時/u);
  assert.match(evidence.ruleSearchQueries[0].query, /ダメージ計算後/u);
});
