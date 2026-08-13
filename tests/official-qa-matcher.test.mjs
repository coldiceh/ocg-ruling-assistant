import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOfficialQaQuestionType,
  extractOfficialQaSemanticConcepts,
  searchOfficialQaEvidence,
} from "../backend/officialQaMatcher.mjs";

test("multi-attacker battle questions rank a single-card official QA as branch evidence without making it direct", () => {
  const question = "我方里侧守备表示的「沉眠兽」被攻击。对方分别用攻击表示的「通常龙」与另一只怪兽攻击，各自能否由战斗或怪兽效果破坏「沉眠兽」？";
  const records = [{
    id: "qa-face-down-battle-branch",
    recordType: "qa",
    question: "通常怪兽攻击里侧守备表示的「<<100>>」时，伤害计算前翻开，这场战斗如何处理？",
    conclusion: "攻击怪兽改变表示形式后战斗结束，不进行伤害计算。",
    cardIds: ["100"],
  }, {
    id: "qa-unrelated-battle",
    recordType: "qa",
    question: "「<<900>>」进行直接攻击时如何处理？",
    conclusion: "进行伤害计算。",
    cardIds: ["900"],
  }];

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [
      { id: "100", name: "沉眠兽" },
      { id: "200", name: "通常龙" },
      { id: "300", name: "另一只怪兽" },
    ],
  });

  assert.equal(matches.questionType, "battle_resolution");
  assert.equal(matches.multiBranchQuery, true);
  assert.equal(matches.all[0]?.id, "qa-face-down-battle-branch");
  assert.equal(matches.all[0]?.branchRelevant, true);
  assert.deepEqual(matches.all[0]?.branchMatchedCardIds, ["100"]);
  assert.ok(matches.all[0]?.matchedBy.includes("multi_branch_related_evidence"));
  assert.notEqual(matches.all[0]?.matchLevel, "official_qa_exact");
  assert.equal(matches.all[0]?.authoritativeSceneMatch, false);
  assert.equal(matches.exact.some((item) => item.id === "qa-face-down-battle-branch"), false);
});

test("a face-down defense target is not mistaken for a defense-position attacker", () => {
  const text = "通常怪兽攻击里侧守备表示的怪兽时，这场战斗如何处理？";
  assert.equal(classifyOfficialQaQuestionType(text), "battle_resolution");
  const concepts = extractOfficialQaSemanticConcepts(text);
  assert.ok(concepts.includes("face_down_battle_target"));
  assert.equal(concepts.includes("defense_position_attack"), false);

  const actualDefenseAttacker = extractOfficialQaSemanticConcepts(
    "表侧守备表示的怪兽以守备表示的状态攻击时，如何进行伤害计算？",
  );
  assert.ok(actualDefenseAttacker.includes("defense_position_attack"));
});

test("shared applicability and resolution phrases map to resolution-result QA", () => {
  assert.equal(
    classifyOfficialQaQuestionType("この効果を適用できますか？"),
    "resolution_result",
  );
  assert.equal(
    classifyOfficialQaQuestionType("效果处理时应当怎么处理？"),
    "resolution_result",
  );
  assert.equal(
    classifyOfficialQaQuestionType("战斗・效果破坏时可以代替。 この効果を適用できますか？"),
    "resolution_result",
  );
});

test("multi-branch scope stays non-direct even when actor card extraction is incomplete", () => {
  const matches = searchOfficialQaEvidence({
    question: "分别用以上三只怪兽攻击里侧守备表示的「目标兽」，各自能否由战斗破坏？",
    records: [{
      id: "qa-single-branch-with-incomplete-actors",
      recordType: "qa",
      question: "通常怪兽攻击里侧守备表示的「<<100>>」时，这场战斗如何处理？",
      conclusion: "战斗结束。",
      cardIds: ["100"],
    }],
    // Simulate a preceding extractor finding the common target but missing the
    // three focal attackers. Multi-branch wording must still fail closed.
    resolvedCards: [{ id: "100", name: "目标兽" }],
  });

  assert.equal(matches.multiBranchQuery, true);
  assert.equal(matches.all[0]?.branchRelevant, true);
  assert.equal(matches.exact.length, 0);
});

test("each-player wording alone is not treated as a multi-card decision scope", () => {
  const matches = searchOfficialQaEvidence({
    question: "Each player can activate one effect during the Battle Phase. What happens after it resolves?",
    records: [],
    resolvedCards: [{ id: "100", name: "Card A" }, { id: "200", name: "Card B" }],
  });
  assert.equal(matches.multiBranchQuery, false);
});

test("a concise question can authoritatively match a unique longer official question whose card set is a superset", () => {
  const question = "融合召喚の素材にできないモンスターを墓地へ送って「キメラテック・フォートレス・ドラゴン」を特殊召喚できますか？";
  const records = [
    {
      id: "qa-semantic-superset",
      recordType: "qa",
      question: "「<<22559>>」の効果で特殊召喚したり「<<22169>>」「<<14530>>」「<<18001>>」などの効果が適用されたことにより、融合召喚の素材にできない状態のモンスターを、「<<7403>>」を特殊召喚する手順として墓地へ送ることはできますか？",
      conclusion: "いずれの状況でも墓地へ送って特殊召喚できます。この特殊召喚は融合召喚ではありません。",
      cardIds: ["22559", "22169", "14530", "18001", "7403"],
    },
    {
      id: "qa-semantic-distractor",
      recordType: "qa",
      question: "「<<7403>>」を特殊召喚する場合、墓地のカードを除外できますか？",
      conclusion: "できません。",
      cardIds: ["7403"],
    },
  ];

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [{ id: "7403", name: "キメラテック・フォートレス・ドラゴン" }],
    subsumptionCandidatePoolComplete: true,
  });
  const direct = matches.exact[0];

  assert.equal(direct?.id, "qa-semantic-superset");
  assert.equal(direct?.authoritativeSceneMatch, true);
  assert.equal(direct?.authoritativeSceneMatchReason, "unique_semantic_question_subsumption");
  assert.equal(direct?.semanticSubsumptionCertified, true);
  assert.equal(direct?.questionCardIdCoverage, 1);
  assert.equal(direct?.matchedQuestionCardIds.length, 1);
  assert.ok(direct?.questionCardIdCount > direct?.matchedQuestionCardIds.length);
  assert.ok(direct?.distinctiveQueryConcepts.length >= 3);
  assert.ok(direct?.distinctiveSemanticQueryCoverage >= 0.9);
  assert.ok(direct?.semanticQueryCoverage >= 0.9);
  assert.ok(direct?.semanticScore >= 0.72);
  assert.ok(direct?.semanticSubsumptionScoreMargin >= 0.1);
  assert.equal(direct?.semanticSubsumptionMetrics?.runnerUpScore, matches.all[1]?.score);
  assert.ok(direct?.matchedBy.includes("unique_semantic_question_subsumption"));

  const incompletePool = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [{ id: "7403", name: "キメラテック・フォートレス・ドラゴン" }],
  });
  assert.equal(incompletePool.exact.length, 0);
  assert.ok(incompletePool.all.every((item) => item.semanticSubsumptionCertified === false));
});

test("semantic question subsumption stays non-direct when two strong official candidates are tied", () => {
  const question = "融合召喚の素材にできないモンスターを墓地へ送って「対象機械竜」を特殊召喚できますか？";
  const records = ["a", "b"].map((suffix, index) => ({
    id: `qa-semantic-tied-${suffix}`,
    recordType: "qa",
    question: `「<<${index ? "3002" : "3001"}>>」の効果が適用され、融合召喚の素材にできないモンスターを、「<<3000>>」を特殊召喚する手順として墓地へ送ることはできますか？`,
    conclusion: "墓地へ送って特殊召喚できます。この特殊召喚は融合召喚ではありません。",
    cardIds: [String(index ? 3002 : 3001), "3000"],
  }));

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [{ id: "3000", name: "対象機械竜" }],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.exact.length, 0);
  assert.ok(matches.all.every((item) => item.semanticSubsumptionCertified === false));
});

test("semantic overlap cannot become direct when the queried card appears only outside the official question", () => {
  const question = "融合召喚の素材にできないモンスターを墓地へ送って「対象機械竜」を特殊召喚できますか？";
  const records = [
    {
      id: "qa-card-only-in-answer",
      recordType: "qa",
      question: "融合召喚の素材にできないモンスターを墓地へ送って、機械族モンスターを特殊召喚できますか？",
      conclusion: "「<<3100>>」にもこの処理を適用できます。",
      cardIds: ["3100"],
    },
    {
      id: "qa-card-question-distractor",
      recordType: "qa",
      question: "「<<3100>>」を特殊召喚できますか？",
      conclusion: "条件を満たした場合に特殊召喚できます。",
      cardIds: ["3100"],
    },
  ];

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [{ id: "3100", name: "対象機械竜" }],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.exact.length, 0);
  const semantic = matches.all.find((item) => item.id === "qa-card-only-in-answer");
  assert.equal(semantic?.questionCardIdCoverage, 0);
  assert.equal(semantic?.semanticSubsumptionCertified, false);
});

test("exact question aliases support related recall without granting direct authority", () => {
  const matches = searchOfficialQaEvidence({
    question: "匿名长名主体的效果适用中，匿名手续卡究竟能否正常发动？",
    records: [{
      id: "qa-question-alias-related-only",
      recordType: "qa",
      question: "匿名长名主体的效果适用中，匿名手续卡能否发动？",
      answer: "分别确认发动手续。",
    }],
    resolvedCards: [
      { id: "3151", name: "匿名长名主体", aliases: ["匿名长名主体"] },
      { id: "3152", name: "匿名手续卡", aliases: ["匿名手续卡"] },
    ],
  });

  const candidate = matches.all[0];
  assert.deepEqual(new Set(candidate?.matchedRelatedQuestionCardIds), new Set(["3151", "3152"]));
  assert.equal(candidate?.questionCardIdCoverage, 0);
  assert.equal(candidate?.relatedQuestionCardIdCoverage, 1);
  assert.ok(candidate?.matchedBy.includes("related_question_exact_alias"));
  assert.equal(matches.exact.length, 0);
});

test("question alias binding is ambiguity-safe and prefers the longest overlapping name", () => {
  const sharedAliasMatches = searchOfficialQaEvidence({
    question: "当前匿名共享名的效果究竟可以发动吗？",
    records: [{
      id: "qa-ambiguous-question-alias",
      recordType: "qa",
      question: "匿名共享名的效果可以发动吗？",
      answer: "分别确认卡片身份。",
    }],
    resolvedCards: [
      { id: "3161", name: "匿名主体甲", aliases: ["匿名共享名"] },
      { id: "3162", name: "匿名主体乙", aliases: ["匿名共享名"] },
    ],
  });
  assert.deepEqual(sharedAliasMatches.all[0]?.matchedRelatedQuestionCardIds, []);

  const overlappingMatches = searchOfficialQaEvidence({
    question: "当前匿名龙骑士的效果究竟可以发动吗？",
    records: [{
      id: "qa-overlapping-question-alias",
      recordType: "qa",
      question: "匿名龙骑士的效果可以发动吗？",
      answer: "确认完整卡名。",
    }],
    resolvedCards: [
      { id: "3171", name: "匿名龙", aliases: ["匿名龙"] },
      { id: "3172", name: "匿名龙骑士", aliases: ["匿名龙骑士"] },
    ],
  });
  assert.deepEqual(overlappingMatches.all[0]?.matchedRelatedQuestionCardIds, ["3172"]);
  assert.equal(overlappingMatches.exact.length, 0);
});

test("answer-only card names do not create question-side related identity", () => {
  const matches = searchOfficialQaEvidence({
    question: "当前手续能否发动？",
    records: [{
      id: "qa-answer-name-does-not-bind",
      recordType: "qa",
      question: "当前手续能否发动？",
      answer: "答案举例提到匿名答案卡。",
    }],
    resolvedCards: [{ id: "3181", name: "匿名答案卡", aliases: ["匿名答案卡"] }],
  });

  assert.deepEqual(matches.all[0]?.matchedRelatedQuestionCardIds, []);
  assert.equal(matches.all[0]?.relatedQuestionCardIdCoverage, 0);
  assert.equal(matches.exact.length, 0);
});

test("scene qualifier conflicts prevent semantic question subsumption certification", () => {
  const question = "ダメージステップに、融合召喚の素材にできないモンスターを墓地へ送って「対象機械竜」を特殊召喚できますか？";
  const records = [
    {
      id: "qa-conflicting-scene",
      recordType: "qa",
      question: "先攻1ターン目のタイミングに、融合召喚の素材にできないモンスターを、「<<3200>>」を特殊召喚する手順として墓地へ送ることはできますか？",
      conclusion: "墓地へ送って特殊召喚できます。",
      cardIds: ["3200"],
    },
    {
      id: "qa-scene-distractor",
      recordType: "qa",
      question: "「<<3200>>」を通常召喚できますか？",
      conclusion: "できません。",
      cardIds: ["3200"],
    },
  ];

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [{ id: "3200", name: "対象機械竜" }],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.exact.length, 0);
  const conflicting = matches.all.find((item) => item.id === "qa-conflicting-scene");
  assert.equal(conflicting?.sceneQualifiersCompatible, false);
  assert.equal(conflicting?.semanticSubsumptionCertified, false);
});

test("a unique longer official question can cover the exact multi-card identity set with few mechanism terms", () => {
  const question = "「场上限制兽」存在时，用「复活陷阱」把怪兽特殊召唤的场合，那只怪兽的效果可以发动吗？";
  const records = [
    {
      id: "qa-question-card-superset",
      recordType: "qa",
      question: "「<<4100>>」在怪兽区域存在的状况，以「<<4200>>」的效果把怪兽特殊召唤的场合，那只特殊召唤的怪兽效果可以发动吗？",
      conclusion: "特殊召唤成功后，按照正在适用的效果处理。",
      cardIds: ["4100", "4200"],
    },
    {
      id: "qa-question-card-distractor",
      recordType: "qa",
      question: "「<<4100>>」存在时，可以发动「<<4200>>」并把墓地的魔法卡加入手卡吗？",
      conclusion: "不能加入手卡。",
      cardIds: ["4100", "4200"],
    },
  ];

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [
      { id: "4100", name: "场上限制兽" },
      { id: "4200", name: "复活陷阱" },
    ],
    subsumptionCandidatePoolComplete: true,
  });
  const direct = matches.exact[0];

  assert.equal(direct?.id, "qa-question-card-superset");
  assert.equal(direct?.authoritativeSceneMatch, true);
  assert.equal(direct?.authoritativeSceneMatchReason, "unique_question_card_subsumption");
  assert.equal(direct?.questionCardSubsumptionCertified, true);
  assert.equal(direct?.questionCardIdCoverage, 1);
  assert.equal(direct?.matchedQuestionCardIds.length, 2);
  assert.equal(direct?.questionCardIdCount, direct?.matchedQuestionCardIds.length);
  assert.ok(direct?.semanticQueryCoverage >= 0.8);
  assert.ok(direct?.semanticScore >= 0.6);
  assert.ok(direct?.questionCardSubsumptionMetrics?.score >= 0.88);
  assert.equal(direct?.questionCardSubsumptionMetrics?.eligibleCandidateCount, 1);
  assert.equal(direct?.questionCardSubsumptionMetrics?.evaluatedCandidateCount, matches.all.length);
  assert.ok(direct?.matchedBy.includes("unique_question_card_subsumption"));

  const incompletePool = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [
      { id: "4100", name: "场上限制兽" },
      { id: "4200", name: "复活陷阱" },
    ],
  });
  assert.equal(incompletePool.exact.length, 0);
  assert.ok(incompletePool.all.every((item) => item.questionCardSubsumptionCertified === false));
});

test("question-card subsumption rejects an official question with an extra unbound card", () => {
  const matches = searchOfficialQaEvidence({
    question: "「场上限制兽」存在时，用「复活陷阱」把怪兽特殊召唤并破坏1张卡后除外的场合，送去墓地的怪兽效果可以发动吗？",
    records: [
      {
        id: "qa-question-card-extra-unbound",
        recordType: "qa",
        question: "「<<4310>>」存在时，以「<<4320>>」的效果把「<<4330>>」特殊召唤并破坏1张卡后除外的场合，送去墓地的怪兽效果可以发动吗？",
        conclusion: "条件に従って処理します。",
        cardIds: ["4310", "4320", "4330"],
      },
      {
        id: "qa-question-card-extra-distractor",
        recordType: "qa",
        question: "「<<4310>>」存在时，可以发动效果把魔法卡加入手卡吗？",
        conclusion: "加入手卡できません。",
        cardIds: ["4310"],
      },
    ],
    resolvedCards: [
      { id: "4310", name: "场上限制兽" },
      { id: "4320", name: "复活陷阱" },
    ],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.exact.length, 0);
  assert.ok(matches.all.every((item) => item.questionCardSubsumptionCertified === false));
});

test("question-card subsumption stays non-direct when two candidates cover the complete multi-card question", () => {
  const question = "「场上限制兽」存在时，用「复活陷阱」把怪兽特殊召唤的场合，那只怪兽的效果可以发动吗？";
  const records = ["a", "b"].map((suffix, index) => ({
    id: `qa-question-card-tied-${suffix}`,
    recordType: "qa",
    question: `「<<4400>>」存在时，以「<<4500>>」的效果把怪兽特殊召唤的场合，那只怪兽的效果可以发动吗？${index ? "此后怎样处理？" : ""}`,
    conclusion: "条件に従って処理します。",
    cardIds: ["4400", "4500"],
  }));

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [
      { id: "4400", name: "场上限制兽" },
      { id: "4500", name: "复活陷阱" },
    ],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.exact.length, 0);
  assert.ok(matches.all.every((item) => item.questionCardSubsumptionCertified === false));
});

test("question-card subsumption cannot certify an official question missing one queried card", () => {
  const question = "「场上限制兽」存在时，用「复活陷阱」把怪兽特殊召唤的场合，那只怪兽的效果可以发动吗？";
  const records = [
    {
      id: "qa-question-card-missing-one",
      recordType: "qa",
      question: "「<<4700>>」存在时，怪兽被特殊召唤的场合，那只怪兽的效果可以发动吗？",
      conclusion: "条件に従って処理します。",
      cardIds: ["4700"],
    },
    {
      id: "qa-question-card-other-half",
      recordType: "qa",
      question: "「<<4800>>」で怪兽を特殊召唤できますか？",
      conclusion: "特殊召唤できます。",
      cardIds: ["4800"],
    },
  ];

  const matches = searchOfficialQaEvidence({
    question,
    records,
    resolvedCards: [
      { id: "4700", name: "场上限制兽" },
      { id: "4800", name: "复活陷阱" },
    ],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.exact.length, 0);
  assert.ok(matches.all.every((item) => item.questionCardIdCoverage < 1));
  assert.ok(matches.all.every((item) => item.questionCardSubsumptionCertified === false));
});

test("an official question about actor permission cannot become direct evidence for operand availability", () => {
  const matches = searchOfficialQaEvidence({
    question: "双方手牌与牌组均不存在可以特殊召唤的怪兽时，能否发动「场景魔法」？",
    records: [{
      id: "qa-anonymous-permission-premise",
      recordType: "qa",
      question: "双方玩家都不能特殊召唤怪兽时，能否发动「<<5100>>」？",
      conclusion: "不能发动。",
      cardIds: ["5100"],
      questionCardIds: ["5100"],
    }],
    resolvedCards: [{ id: "5100", name: "场景魔法" }],
    subsumptionCandidatePoolComplete: true,
  });

  const candidate = matches.all[0];
  assert.equal(candidate?.scenarioPremiseCompatibility, "mismatch");
  assert.equal(candidate?.scenarioPremiseConflicts[0]?.reason, "premise_not_equivalent");
  assert.equal(candidate?.matchLevel, "official_related");
  assert.equal(matches.exact.length, 0);
});

test("an official question covering only activation is partial for an activation-and-resolution query", () => {
  const matches = searchOfficialQaEvidence({
    question: "「场景魔法」能否发动？如果发动，效果处理时如何进行？",
    records: [{
      id: "qa-anonymous-activation-only",
      recordType: "qa",
      question: "「<<5200>>」能否发动？",
      conclusion: "可以发动。",
      cardIds: ["5200"],
      questionCardIds: ["5200"],
    }],
    resolvedCards: [{ id: "5200", name: "场景魔法" }],
    subsumptionCandidatePoolComplete: true,
  });

  assert.equal(matches.all[0]?.scenarioPremiseCompatibility, "partial");
  assert.equal(matches.exact.length, 0);
});

test("a raw-identical official question remains direct when both applicability frames are otherwise unknown", () => {
  const question = "在这个公开状态下，这项操作是合法的吗？";
  const matches = searchOfficialQaEvidence({
    question,
    records: [{
      id: "qa-anonymous-raw-identical",
      recordType: "qa",
      question,
      conclusion: "合法。",
    }],
    resolvedCards: [],
  });

  assert.equal(matches.all[0]?.scenarioPremiseCompatibility, "unknown");
  assert.equal(matches.exact[0]?.id, "qa-anonymous-raw-identical");
});

