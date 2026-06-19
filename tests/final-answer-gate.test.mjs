import assert from "node:assert/strict";
import test from "node:test";
import {
  answerEachSubQuestion,
  extractVerdictFromEvidence,
  finalAnswerGate,
  mergeModelAnswer,
} from "../backend/engine.mjs";
import { validateFormalRulingQuery } from "../backend/formalQuery.mjs";

const subQuestion = {
  id: "q1",
  type: "activation_condition",
  card: "测试卡A",
  askedResult: "can_activate",
  sourceText: "测试卡A的②效果能发动吗？",
};

test("A. direct evidence without an explicit answer stays unknown", () => {
  const ambiguous = makeQa("qa-ambiguous", "请参照相关卡片说明。", "测试卡A的②效果能否发动？");
  const extracted = extractVerdictFromEvidence(subQuestion, [ambiguous]);
  assert.equal(extracted.verdict, "unknown");
  const answer = runAnswer({ direct: [ambiguous] });
  assert.equal(answer.status, "unknown");
  assert.equal(answer.verdict, "unknown");
});

test("B. explicit positive direct evidence confirms can", () => {
  const positive = makeQa("qa-can", "可以发动。", "测试卡A的②效果能否发动？");
  const extracted = extractVerdictFromEvidence(subQuestion, [positive]);
  assert.ok(["can", "yes"].includes(extracted.verdict));
  const answer = runAnswer({ direct: [positive] });
  assert.equal(answer.status, "confirmed");
  assert.ok(["can", "yes"].includes(answer.verdict));
  assert.deepEqual(answer.evidenceIds, ["qa-can"]);
});

test("C. explicit negative direct evidence confirms cannot", () => {
  const negative = makeQa("qa-cannot", "不可以发动。", "测试卡A的②效果能否发动？");
  const extracted = extractVerdictFromEvidence(subQuestion, [negative]);
  assert.ok(["cannot", "no"].includes(extracted.verdict));
  const answer = runAnswer({ direct: [negative] });
  assert.equal(answer.status, "confirmed");
  assert.ok(["cannot", "no"].includes(answer.verdict));
});

test("D. similar evidence can never confirm", () => {
  const similar = makeQa("qa-similar", "可以发动。", "测试卡B的②效果能否发动？", "测试卡B");
  const answer = runAnswer({ similar: [similar] });
  assert.ok(["inferred", "unknown"].includes(answer.status));
  assert.notEqual(answer.status, "confirmed");
});

test("E. card text alone stays unknown", () => {
  const answer = runAnswer({
    cardText: [{ evidenceId: "card-text:test-a", recordType: "card-text", conclusion: "②：满足条件才能发动。" }],
  });
  assert.equal(answer.status, "unknown");
  assert.equal(answer.verdict, "unknown");
});

test("F. parser warnings cap explicit direct evidence at inferred", () => {
  const positive = makeQa("qa-can-warning", "可以发动。", "测试卡A的②效果能否发动？");
  const answer = runAnswer({ direct: [positive], parserWarnings: ["defaulted_card:q1"] });
  assert.equal(answer.status, "inferred");
  assert.equal(answer.verdict, "can");
  assert.ok(answer.warnings.includes("parser_warnings_cap_status"));
});

test("G. AI explanation cannot override program status, verdict, or evidenceIds", () => {
  const programAnswer = {
    status: "confirmed",
    verdict: "can",
    evidenceIds: ["qa-can"],
    reason: "explicit_positive_answer",
    warnings: [],
  };
  const merged = mergeModelAnswer(
    {
      status: "confirmed",
      verdict: "cannot",
      evidenceIds: ["fake-evidence"],
      verdictTitle: "不可以发动",
      subAnswers: [{ status: "confirmed", verdict: "cannot" }],
      explanationText: "模型解释文本",
    },
    programAnswer
  );
  assert.equal(merged.status, "confirmed");
  assert.equal(merged.verdict, "can");
  assert.deepEqual(merged.evidenceIds, ["qa-can"]);
  assert.equal(merged.explanationText, "模型解释文本");
  assert.ok(merged.warnings.includes("model_status_or_verdict_ignored"));
});

test("conflicting direct evidence returns unknown with a conflict warning", () => {
  const positive = makeQa("qa-conflict-can", "可以发动。", "测试卡A的②效果能否发动？");
  const negative = makeQa("qa-conflict-cannot", "不可以发动。", "测试卡A的②效果能否发动？");
  const extracted = extractVerdictFromEvidence(subQuestion, [positive, negative]);
  assert.equal(extracted.verdict, "unknown");
  assert.match(extracted.reason, /conflict/u);
  const answer = runAnswer({ direct: [positive, negative] });
  assert.equal(answer.status, "unknown");
  assert.ok(answer.warnings.includes("conflicting_direct_evidence"));
});

test("confirmed is rejected when evidence IDs are missing or not direct", () => {
  const programAnswer = {
    status: "confirmed",
    verdict: "can",
    evidenceIds: ["qa-missing"],
    reason: "explicit_evidence_answer:can",
    warnings: [],
  };
  const missing = finalAnswerGate(programAnswer, { rulingEvidence: [{ evidenceId: "qa-direct" }] }, {
    validEvidenceIds: new Set(["qa-direct"]),
  });
  assert.equal(missing.status, "unknown");
  assert.equal(missing.verdict, "unknown");
  assert.ok(missing.warnings.includes("evidence_id_not_found"));

  const notDirect = finalAnswerGate(
    { ...programAnswer, evidenceIds: ["qa-similar"] },
    { rulingEvidence: [{ evidenceId: "qa-direct" }], similarRulingEvidence: [{ evidenceId: "qa-similar" }] },
    { validEvidenceIds: new Set(["qa-direct", "qa-similar"]) }
  );
  assert.equal(notDirect.status, "unknown");
  assert.ok(notDirect.warnings.includes("evidence_not_direct"));
});

test("conditional activation locations stay unknown until the scene selects a branch", () => {
  const locationQuestion = {
    id: "q-location",
    type: "activation_location",
    card: "青眼暴君龙",
    askedResult: "effect_activates_in_graveyard_or_field",
    sourceText: "青眼暴君龙被战破时是在墓地发动还是在场上发动？",
  };
  const conditionalFaq = makeQa(
    "faq-conditional-location",
    "このカードが戦闘で破壊されなかった場合にはモンスターゾーンで、戦闘で破壊され墓地へ送られた場合には墓地で、表側で除外された場合には除外状態で発動できます。",
    locationQuestion.sourceText,
    "青眼暴君龙"
  );
  const extracted = extractVerdictFromEvidence(locationQuestion, [conditionalFaq]);
  assert.equal(extracted.verdict, "unknown");
  assert.match(extracted.reason, /no_explicit_answer|requires_scene|missing_state/u);
});

function runAnswer({ direct = [], similar = [], cardText = [], parserWarnings = [] }) {
  const formalQuery = {
    originalText: subQuestion.sourceText,
    cards: [{ name: "测试卡A", role: "question_card", controller: "unknown", zone: "unknown", effectNo: "unknown" }],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [subQuestion],
  };
  const evidence = {
    bySubQuestion: [{
      subQuestionId: "q1",
      rulingEvidence: direct,
      similarRulingEvidence: similar,
      cardTextEvidence: cardText,
      rejectedEvidence: [],
    }],
    rulingEvidence: direct,
    similarRulingEvidence: similar,
    cardTextEvidence: cardText,
    rejectedEvidence: [],
  };
  const records = [...direct, ...similar].map((item) => ({ ...item, id: item.evidenceId || item.id }));
  return answerEachSubQuestion(
    formalQuery,
    evidence,
    { records },
    validateFormalRulingQuery(formalQuery),
    { parserWarnings }
  )[0];
}

function makeQa(id, conclusion, question, card = "测试卡A") {
  return {
    id,
    evidenceId: id,
    recordType: "card-faq",
    title: `${id} FAQ`,
    question,
    cards: [card],
    keywords: ["发动条件", "②"],
    conclusion,
    sources: [{ label: "fixture", detail: id }],
  };
}
