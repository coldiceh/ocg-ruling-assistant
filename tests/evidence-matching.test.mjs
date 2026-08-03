import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQaForSubQuestion,
  retrieveEvidenceByFormalQuery,
} from "../backend/engine.mjs";
import { normalizeFormalRulingQuery } from "../backend/formalQuery.mjs";
import { searchOfficialQaEvidence } from "../backend/officialQaMatcher.mjs";

const detectedCards = [{
  id: "card-a",
  name: "测试卡A",
  aliases: ["测试卡A", "Test Card A"],
  effectText: "①：测试效果。②：测试效果。",
}];

const qa = {
  temporary: makeQa(
    "qa-temporary",
    "「测试卡A」②效果处理时，可以把对象直到结束阶段除外并在之后返回吗？",
    ["处理时", "暂时除外", "对象", "返回"]
  ),
  activationLocation: makeQa(
    "qa-activation-location",
    "「测试卡A」②效果是在墓地发动还是在场上发动？",
    ["墓地发动", "场上发动", "发动位置"]
  ),
  sendToGy: makeQa(
    "qa-send-gy",
    "「测试卡A」②被战斗破坏后是否送去墓地？送墓时点是什么？",
    ["战斗破坏", "送去墓地", "送墓时点"]
  ),
  activation: makeQa(
    "qa-activation",
    "什么条件下可以发动「测试卡A」②效果？诱发时点是什么？",
    ["可以发动", "发动条件", "诱发时点"]
  ),
  returnToDeck: makeQa(
    "qa-return-deck",
    "「测试卡A」②效果处理后是否回到卡组？",
    ["处理后", "回到卡组"]
  ),
};

const cases = [
  {
    name: "temporary_banish only accepts temporary-banish handling",
    subQuestion: makeSubQuestion(
      "temporary_banish",
      "能用测试卡A的②效果除外该怪兽吗？",
      "can_temporarily_banish"
    ),
    direct: qa.temporary,
    rejected: [qa.activation, qa.activationLocation, qa.sendToGy],
  },
  {
    name: "activation_location only accepts activation location",
    subQuestion: makeSubQuestion(
      "activation_location",
      "测试卡A的②效果是在墓地发动还是在场上发动？",
      "effect_activates_in_graveyard_or_field"
    ),
    direct: qa.activationLocation,
    rejected: [qa.temporary, qa.sendToGy, qa.returnToDeck],
  },
  {
    name: "send_to_gy only accepts battle-destruction graveyard handling",
    subQuestion: makeSubQuestion(
      "send_to_gy",
      "测试卡A被战破后还会送墓吗？",
      "will_still_be_sent_to_graveyard_by_battle"
    ),
    direct: qa.sendToGy,
    rejected: [qa.activation, qa.temporary],
  },
  {
    name: "activation_condition only accepts activation conditions and timing",
    subQuestion: makeSubQuestion(
      "activation_condition",
      "测试卡A的②效果这个时候能发动吗？",
      "can_activate"
    ),
    direct: qa.activation,
    rejected: [qa.temporary, qa.sendToGy, qa.returnToDeck],
  },
];

for (const evidenceCase of cases) {
  test(evidenceCase.name, () => {
    const direct = classifyQaForSubQuestion(evidenceCase.subQuestion, evidenceCase.direct);
    assert.equal(direct.match, "direct");
    assert.ok(direct.reason);
    assert.ok(direct.matchedQuestionType);

    for (const rejectedQa of evidenceCase.rejected) {
      const result = classifyQaForSubQuestion(evidenceCase.subQuestion, rejectedQa);
      assert.equal(result.match, "rejected", `${rejectedQa.id} must be rejected`);
      assert.match(result.reason, /mismatch|conflict|not_covered/u);
    }

    const evidence = retrieveEvidenceByFormalQuery(
      buildFormalQuery(evidenceCase.subQuestion),
      detectedCards,
      { records: [evidenceCase.direct, ...evidenceCase.rejected] }
    );
    const bucket = evidence.bySubQuestion[0];
    assert.deepEqual(bucket.rulingEvidence.map((item) => item.evidenceId), [evidenceCase.direct.id]);
    for (const rejectedQa of evidenceCase.rejected) {
      assert.ok(bucket.rejectedEvidence.some((item) => item.evidenceId === rejectedQa.id && item.rejectedReason));
    }
  });
}

test("same card alone is never direct", () => {
  const subQuestion = makeSubQuestion("temporary_banish", "测试卡A的②效果能除外对象吗？", "can_temporarily_banish");
  const generic = makeQa("qa-same-card-only", "关于「测试卡A」②效果的其他问题。", ["测试卡A"]);
  const result = classifyQaForSubQuestion(subQuestion, generic);
  assert.notEqual(result.match, "direct");
});

test("matching semantics with a different card is similar, not direct", () => {
  const subQuestion = makeSubQuestion("send_to_gy", "测试卡A被战破后还会送墓吗？", "will_still_be_sent_to_graveyard_by_battle");
  const otherCardQa = {
    ...qa.sendToGy,
    id: "qa-other-card-send-gy",
    cards: ["测试卡B"],
    question: "「测试卡B」被战斗破坏后是否送去墓地？",
  };
  const result = classifyQaForSubQuestion(subQuestion, otherCardQa);
  assert.equal(result.match, "similar");
});

test("effect number and scene zone conflicts prevent direct", () => {
  const effectQuestion = makeSubQuestion("temporary_banish", "测试卡A的②效果能暂时除外对象吗？", "can_temporarily_banish");
  const wrongEffect = makeQa("qa-wrong-effect", "「测试卡A」①效果处理时把对象暂时除外。", ["①", "处理时", "暂时除外"]);
  assert.deepEqual(classifyQaForSubQuestion(effectQuestion, wrongEffect), {
    match: "rejected",
    reason: "effect_number_mismatch",
    matchedQuestionType: "temporary_banish",
    answeredAskedResult: false,
    askedResultCoverage: "different_card_or_context",
    extractedVerdict: "unknown",
  });

  const locationQuestion = makeSubQuestion(
    "activation_location",
    "测试卡A的②效果是在墓地发动还是在场上发动？",
    "effect_activates_in_graveyard_or_field"
  );
  const banishedLocation = makeQa("qa-banished-location", "「测试卡A」②效果只能在除外状态发动。", ["除外状态发动"]);
  const locationResult = classifyQaForSubQuestion(locationQuestion, banishedLocation);
  assert.equal(locationResult.match, "rejected");
  assert.equal(locationResult.reason, "scene_zone_conflict");
});

test("Q&A without askedResult coverage cannot be direct", () => {
  const subQuestion = makeSubQuestion("send_to_gy", "测试卡A被战破后还会送墓吗？", "will_still_be_sent_to_graveyard_by_battle");
  const vague = makeQa("qa-vague-gy", "「测试卡A」②效果与墓地有关。", ["墓地"]);
  const result = classifyQaForSubQuestion(subQuestion, vague);
  assert.notEqual(result.match, "direct");
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

function makeSubQuestion(type, sourceText, askedResult) {
  return { id: "q1", type, card: "测试卡A", effectNo: "②", askedResult, sourceText };
}

function makeQa(id, question, keywords) {
  return {
    id,
    recordType: "card-faq",
    title: `${id} FAQ`,
    question,
    cards: ["测试卡A"],
    keywords,
    conclusion: fixtureConclusion(keywords, question),
    sources: [{ label: "fixture", detail: id }],
  };
}

function fixtureConclusion(keywords, fallback) {
  const text = keywords.join(" ");
  if (/暂时除外|处理时/u.test(text)) return "可以。在效果处理时将对象暂时除外，之后返回。";
  if (/墓地发动|场上发动|除外状态发动/u.test(text)) {
    if (/除外状态发动/u.test(text)) return "这个效果在除外状态发动。";
    return "这个效果在墓地发动。";
  }
  if (/送去墓地|送墓时点/u.test(text)) return "会在战斗破坏后送去墓地。";
  if (/可以发动|发动条件|诱发时点/u.test(text)) return "满足该条件时可以发动。";
  if (/回到卡组/u.test(text)) return "效果处理后回到卡组。";
  return fallback;
}

function buildFormalQuery(subQuestion) {
  return normalizeFormalRulingQuery({
    originalText: subQuestion.sourceText,
    cards: [{ name: "测试卡A", role: "question_card", controller: "unknown", zone: "unknown" }],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [subQuestion],
  });
}

