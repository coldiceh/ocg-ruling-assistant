import assert from "node:assert/strict";
import test from "node:test";

import { searchOfficialQaEvidence } from "../backend/officialQaMatcher.mjs";
import { projectOfficialQaQuestion } from "../backend/officialQaQuestionProjection.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { classifyMultiEntityDecisionScope } from "../backend/evidenceQuestionTypeClassifier.mjs";

test("rich and compact QA shapes share one question identity projection", () => {
  const title = "复合官方问题的省略标题…";
  const question = [
    "复合官方问题。",
    "(A)能否除外「<<1001>>」来特殊召唤「<<1002>>」？",
    "(B)能否除外「<<1003>>」来特殊召唤「<<1002>>」？",
  ].join("\n\n");
  const answer = "两种处理分别判断。答案中的示例「<<9999>>」不属于问题身份。";
  const rich = projectOfficialQaQuestion({
    title,
    question,
    answer,
    text: `${question}\n${answer}`,
  });
  const compact = projectOfficialQaQuestion({
    title,
    text: `${question}\n${title}\n${answer}`,
  });

  assert.deepEqual(new Set(rich.principalCardIds), new Set(["1001", "1002", "1003"]));
  assert.deepEqual(new Set(compact.principalCardIds), new Set(rich.principalCardIds));
  assert.equal(rich.principalCardIds.includes("9999"), false);
  assert.equal(compact.principalCardIds.includes("9999"), false);
  assert.equal(rich.branches.length, 2);
  assert.equal(compact.branches.length, 2);
  assert.ok(rich.branches.every((branch) => branch.startsWith("复合官方问题。")));
  assert.ok(compact.branches.every((branch) => branch.startsWith("复合官方问题。")));
});

test("one compatible branch of a compound QA remains related without becoming direct", () => {
  const query = [
    "自己场上有「匿名素材甲」，是否可以将其除外来特殊召唤「匿名终端乙」？",
    "如果可以特殊召唤，之后能否发动「匿名后续丙」的效果？",
  ].join("\n");
  const record = {
    id: "anonymous-compound-qa",
    recordType: "qa",
    title: "复合手续问题",
    question: [
      "(A)能否除外「<<1001>>」来特殊召唤「<<1002>>」？",
      "(B)能否除外「<<1004>>」来特殊召唤「<<1002>>」？",
    ].join("\n\n"),
    answer: "(A)可以。(B)另行判断。",
    cardIds: ["1001", "1002", "1004"],
  };
  const resolvedCards = [
    { id: "1001", name: "匿名素材甲", aliases: ["匿名素材甲"] },
    { id: "1002", name: "匿名终端乙", aliases: ["匿名终端乙"] },
    { id: "1003", name: "匿名后续丙", aliases: ["匿名后续丙"] },
  ];
  const matches = searchOfficialQaEvidence({
    question: query,
    records: [record],
    resolvedCards,
    limit: 5,
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].branchRelevant, true);
  assert.deepEqual(new Set(matches.all[0].branchMatchedCardIds), new Set(["1001", "1002"]));
  assert.equal(matches.all[0].matchLevel, "official_qa_near");
  assert.equal(matches.exact.length, 0);
});

test("answer mechanism semantics can support an operation analogy but cannot supply identity", async () => {
  const cards = [
    { id: "1001", name: "匿名起点甲", aliases: ["匿名起点甲"], effectText: "破坏场上的卡。" },
    { id: "2002", name: "匿名无效乙", aliases: ["匿名无效乙"], effectText: "使发动无效并破坏。" },
    { id: "3003", name: "匿名响应丙", aliases: ["匿名响应丙"], effectText: "破坏场上的卡的效果发动时可以发动。" },
  ];
  const records = [{
    id: "anonymous-operation-analogy",
    recordType: "qa",
    title: "匿名响应卡的发动条件",
    question: "「<<4004>>」的破坏场上卡片的效果发动时，能否连锁发动「<<3003>>」？",
    answer: "卡的发动被无效并破坏时，不视为在场上破坏；仅效果发动被无效并破坏时则另行判断。",
    cardIds: ["3003", "4004"],
  }, {
    id: "anonymous-incidental-overlap",
    recordType: "qa",
    title: "只有卡片身份偶然重合",
    question: "「<<5005>>」的效果发动时，能否连锁发动「<<3003>>」？",
    answer: "处理时破坏场上一张卡。",
    cardIds: ["3003", "5005"],
  }];
  const evidence = await retrieveRagEvidence({
    userQuery: "我方C1发动「匿名起点甲」，对方C2连锁「匿名无效乙」使发动无效并破坏，我方能否C3发动「匿名响应丙」？",
    cardResolution: {
      resolvedCards: cards.map((card) => ({ ...card, input: card.name, confidence: 1 })),
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records,
    qaRecords: [],
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });

  assert.ok(evidence.officialQaRelated.some(
    (item) => item.id === "anonymous-operation-analogy" && item.isDirect === false,
  ));
  assert.equal(evidence.officialQaRelated.some(
    (item) => item.id === "anonymous-incidental-overlap",
  ), false);
});

test("a question mark and card id in the answer cannot contaminate compact question identity", () => {
  const title = "匿名紧凑问题的省略标题…";
  const projection = projectOfficialQaQuestion({
    title,
    text: [
      "能否发动「<<1101>>」的效果？",
      title,
      "如果答案示例改为「<<9909>>」呢？仍按问题中的场景判断。",
    ].join("\n"),
  });

  assert.deepEqual(projection.principalCardIds, ["1101"]);
  assert.match(projection.answerText, /<<9909>>/u);
});

test("negation aliases count as one operation family instead of independent evidence", () => {
  const matches = searchOfficialQaEvidence({
    question: "对方发动「匿名无效甲」使发动无效时，是否还能发动？",
    records: [{
      id: "anonymous-negation-alias",
      recordType: "qa",
      title: "匿名无效手续",
      question: "「<<2101>>」使卡的发动无效时，能否发动「<<2102>>」？",
      answer: "仅判断该次无效处理。",
      cardIds: ["2101", "2102"],
    }],
    resolvedCards: [
      { id: "2101", name: "匿名无效甲", aliases: ["匿名无效甲"] },
      { id: "2102", name: "匿名响应乙", aliases: ["匿名响应乙"] },
    ],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.deepEqual(matches.all[0].matchedOperationFamilies, ["negate"]);
  assert.deepEqual(matches.all[0].distinctiveOperationSemanticHits, ["negate"]);
  assert.equal(
    matches.semanticMatchingConcepts.filter(
      (concept) => ["negate", "negate_activation", "effect_negation"].includes(concept),
    ).length,
    1,
  );
});

test("all operation aliases share one semantic counting unit", () => {
  const negation = searchOfficialQaEvidence({
    question: "这个效果的发动无效时如何处理？",
    records: [],
  }).semanticMatchingConcepts;
  const banishing = searchOfficialQaEvidence({
    question: "将该卡暂时除外，之后回到场上时如何处理？",
    records: [],
  }).semanticMatchingConcepts;

  assert.equal(
    negation.filter((concept) => concept === "negate").length,
    1,
  );
  assert.equal(
    banishing.filter((concept) => concept === "banish").length,
    1,
  );
});

test("answer-only timing phrases cannot complete direct scene authority", () => {
  const matches = searchOfficialQaEvidence({
    question: "伤害计算时能否发动「匿名时点卡」？",
    records: [{
      id: "anonymous-answer-only-timing",
      recordType: "qa",
      title: "匿名效果能否发动",
      question: "能否发动「<<2301>>」的效果？",
      answer: "答案中的示例发生在伤害计算时。",
      cardIds: ["2301"],
    }],
    resolvedCards: [{ id: "2301", name: "匿名时点卡", aliases: ["匿名时点卡"] }],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].sceneQualifiersCompatible, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("an unbounded legacy body cannot be reinterpreted as question-side semantics", () => {
  const matches = searchOfficialQaEvidence({
    question: "「匿名甲」的发动被无效并破坏时，「匿名乙」能否继续处理？",
    records: [{
      id: "anonymous-unbounded-legacy-body",
      recordType: "qa",
      text: "答案侧说明发动被无效并破坏后的处理，并举出「<<2401>>」与「<<2402>>」作为示例。",
      cardIds: ["2401", "2402"],
    }],
    resolvedCards: [
      { id: "2401", name: "匿名甲", aliases: ["匿名甲"] },
      { id: "2402", name: "匿名乙", aliases: ["匿名乙"] },
    ],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].questionType, "unknown");
  assert.deepEqual(matches.all[0].semanticHits, []);
  assert.deepEqual(matches.all[0].matchedPhrases, []);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("identities from separate branches cannot be combined into a synthetic supporting branch", () => {
  const matches = searchOfficialQaEvidence({
    question: [
      "「匿名分支甲」的破坏效果发动时，",
      "能否连锁发动「匿名分支丁」使该发动无效并破坏？",
    ].join(""),
    records: [{
      id: "anonymous-disjoint-branches",
      recordType: "qa",
      title: "两个互不相同的匿名分支",
      question: [
        "(A)「<<3101>>」的破坏效果发动时，能否连锁发动其他效果？",
        "(B)其他效果发动时，能否连锁发动「<<3104>>」使该发动无效并破坏？",
      ].join("\n\n"),
      answer: "两个分支分别判断。",
      cardIds: ["3101", "3104"],
    }],
    resolvedCards: [
      { id: "3101", name: "匿名分支甲", aliases: ["匿名分支甲"] },
      { id: "3104", name: "匿名分支丁", aliases: ["匿名分支丁"] },
    ],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].exactQuestionCardIdSet, true);
  assert.equal(matches.all[0].queryIdentityContainedInOneBranch, false);
  assert.equal(matches.all[0].exactQuestionBranchIdSet, false);
  assert.equal(matches.all[0].branchRelevant, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("an exact full compound question stays direct rather than being reduced to one branch", () => {
  const question = [
    "(A)能否除外「<<4101>>」来特殊召唤「<<4102>>」？",
    "(B)能否除外「<<4103>>」来特殊召唤「<<4102>>」？",
  ].join("\n\n");
  const matches = searchOfficialQaEvidence({
    question,
    records: [{
      id: "anonymous-full-compound",
      recordType: "qa",
      title: "完整匿名复合问题",
      question,
      answer: "两个分支分别判断。",
      cardIds: ["4101", "4102", "4103"],
    }],
    resolvedCards: ["4101", "4102", "4103"].map((id) => ({
      id,
      name: `匿名卡${id}`,
      aliases: [`匿名卡${id}`],
    })),
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].branchRelevant, false);
  assert.equal(matches.exact.length, 1);
});

test("branch matching is invariant under anonymous name and id remapping", () => {
  const run = ({ materialId, terminalId, unrelatedId, suffix }) => {
    const materialName = `匿名素材${suffix}`;
    const terminalName = `匿名终端${suffix}`;
    const followUpName = `匿名后续${suffix}`;
    return searchOfficialQaEvidence({
      question: [
        `自己场上有「${materialName}」，是否可以将其除外来特殊召唤「${terminalName}」？`,
        `如果可以特殊召唤，之后能否发动「${followUpName}」的效果？`,
      ].join("\n"),
      records: [{
        id: `anonymous-remap-${suffix}`,
        recordType: "qa",
        title: `匿名映射${suffix}`,
        question: [
          `(A)能否除外「<<${materialId}>>」来特殊召唤「<<${terminalId}>>」？`,
          `(B)能否除外「<<${unrelatedId}>>」来特殊召唤「<<${terminalId}>>」？`,
        ].join("\n\n"),
        answer: "两个分支分别判断。",
        cardIds: [materialId, terminalId, unrelatedId],
      }],
      resolvedCards: [
        { id: materialId, name: materialName, aliases: [materialName] },
        { id: terminalId, name: terminalName, aliases: [terminalName] },
        { id: String(Number(unrelatedId) + 1), name: followUpName, aliases: [followUpName] },
      ],
      limit: 5,
    });
  };

  const first = run({ materialId: "5101", terminalId: "5102", unrelatedId: "5104", suffix: "甲" });
  const second = run({ materialId: "8107", terminalId: "8209", unrelatedId: "8401", suffix: "乙" });
  const signature = (matches) => ({
    branchRelevant: matches.all[0].branchRelevant,
    matchLevel: matches.all[0].matchLevel,
    matchedIdentityCount: matches.all[0].branchMatchedCardIds.length,
    authoritativeSceneMatch: matches.all[0].authoritativeSceneMatch,
    authoritativeSceneMatchReason: matches.all[0].authoritativeSceneMatchReason,
    exactCount: matches.exact.length,
  });

  assert.deepEqual(signature(first), signature(second));
  assert.deepEqual(signature(first), {
    branchRelevant: true,
    matchLevel: "official_qa_near",
    matchedIdentityCount: 2,
    authoritativeSceneMatch: false,
    authoritativeSceneMatchReason: "",
    exactCount: 0,
  });
});

test("multiple decisions about one card do not require multiple-entity coverage", () => {
  const scope = classifyMultiEntityDecisionScope(
    "「匿名同一卡」的第一个效果能否发动？如果可以，之后第二个效果能否发动？",
  );

  assert.equal(scope.multiBranch, true);
  assert.equal(scope.multiDecision, true);
  assert.equal(scope.multiEntity, false);
  assert.equal(scope.requiresPerEntityCoverage, false);
});

test("a hierarchical follow-up asking which effects and chain order is a second decision", () => {
  const scope = classifyMultiEntityDecisionScope([
    "是否可以执行记述的特殊召唤？",
    "如果可以特殊召唤，之后可以发动哪些效果，连锁如何组成？",
  ].join(""));

  assert.equal(scope.multiBranch, true);
  assert.equal(scope.multiDecision, true);
  assert.equal(scope.requiresPerEntityCoverage, false);
});

test("a natural title phrase inside a question is not treated as an answer boundary", () => {
  const title = "匿名术语构成的较长标题";
  const projection = projectOfficialQaQuestion({
    title,
    text: `题目中自然提到${title}，并询问「<<6101>>」能否发动？`,
  });

  assert.deepEqual(projection.principalCardIds, ["6101"]);
  assert.equal(projection.answerText, "");
});

test("a shortened title cannot impersonate the complete compound question", () => {
  const title = "两张匿名卡分别能否发动各自效果的省略标题…";
  const matches = searchOfficialQaEvidence({
    question: title,
    records: [{
      id: "anonymous-title-only",
      recordType: "qa",
      title,
      question: [
        "(A)在第一个场景中，能否发动「<<7101>>」的效果？",
        "(B)在另一个场景中，能否发动「<<7102>>」的效果？",
      ].join("\n\n"),
      answer: "两个场景分别判断。",
      cardIds: ["7101", "7102"],
    }],
    resolvedCards: ["7101", "7102"].map((id) => ({
      id,
      name: `匿名卡${id}`,
      aliases: [`匿名卡${id}`],
    })),
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].rawSceneMatch, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});

test("an identity mentioned only in the answer cannot authorize a direct match", () => {
  const question = "在当前场景中能否发动这个效果？";
  const matches = searchOfficialQaEvidence({
    question,
    records: [{
      id: "anonymous-answer-only-identity",
      recordType: "qa",
      title: question,
      question,
      answer: "答案示例提到「<<7201>>」，但问题正文没有该身份。",
      cardIds: ["7201"],
    }],
    resolvedCards: [{ id: "7201", name: "匿名答案卡", aliases: ["匿名答案卡"] }],
    limit: 5,
  });

  assert.equal(matches.all.length, 1);
  assert.equal(matches.all[0].identityCompatibleForExact, false);
  assert.equal(matches.all[0].rawSceneMatch, false);
  assert.equal(matches.all[0].authoritativeSceneMatch, false);
  assert.equal(matches.exact.length, 0);
});
