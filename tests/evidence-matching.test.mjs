import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQaForSubQuestion,
  retrieveEvidenceByFormalQuery,
} from "../backend/engine.mjs";
import { normalizeFormalRulingQuery } from "../backend/formalQuery.mjs";

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

