import assert from "node:assert/strict";
import test from "node:test";
import { retrieveEvidenceByFormalQuery } from "../backend/engine.mjs";
import { normalizeFormalRulingQuery } from "../backend/formalQuery.mjs";

test("retrieval debug marks an empty candidate set as retrieval_empty", () => {
  const trace = retrieveTrace({ cards: [resolvedCard()], records: [] });

  assert.equal(trace.evidenceCoverageReason, "retrieval_empty");
  assert.deepEqual(trace.resolvedCardIds, ["card-a"]);
  assert.deepEqual(trace.rawCandidateEvidence, []);
});

test("retrieval debug marks candidates rejected by the matcher", () => {
  const trace = retrieveTrace({
    cards: [resolvedCard()],
    records: [{
      id: "qa-wrong-type",
      recordType: "card-faq",
      title: "发动位置 FAQ",
      question: "「测试卡A」的效果是在墓地发动还是在场上发动？",
      conclusion: "这个效果在墓地发动。",
      cards: ["测试卡A"],
      sources: [{ label: "fixture", detail: "qa-wrong-type" }],
    }],
  });

  assert.equal(trace.evidenceCoverageReason, "matcher_rejected_all");
  assert.deepEqual(trace.rawCandidateEvidence.map((item) => item.id), ["qa-wrong-type"]);
  assert.deepEqual(trace.classifiedEvidence.direct, []);
  assert.deepEqual(trace.classifiedEvidence.rejected, [{
    id: "qa-wrong-type",
    rejectedReason: "question_type_mismatch",
  }]);
});

test("retrieval debug distinguishes card text from Q&A evidence", () => {
  const trace = retrieveTrace({ cards: [{ ...resolvedCard(), effectText: "①：测试效果。" }], records: [] });

  assert.equal(trace.evidenceCoverageReason, "card_text_only");
  assert.deepEqual(trace.rawCandidateEvidence, []);
  assert.deepEqual(trace.classifiedEvidence.direct, []);
});

test("retrieval debug reports an alias match without a card id", () => {
  const trace = retrieveTrace({ cards: [{ name: "测试卡A", aliases: ["测试卡A"] }], records: [] });

  assert.equal(trace.evidenceCoverageReason, "alias_without_card_id");
  assert.deepEqual(trace.resolvedCardIds, []);
});

function retrieveTrace({ cards, records }) {
  const query = normalizeFormalRulingQuery({
    originalText: "能用测试卡A的效果除外该怪兽吗？",
    cards: [{ name: "测试卡A", role: "question_card", controller: "unknown", zone: "unknown" }],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [{
      id: "q1",
      type: "temporary_banish",
      card: "测试卡A",
      askedResult: "can_temporarily_banish",
      sourceText: "能用测试卡A的效果除外该怪兽吗？",
    }],
  });
  const evidence = retrieveEvidenceByFormalQuery(query, cards, { records });
  const trace = evidence.bySubQuestion[0].retrievalTrace;

  assert.deepEqual(Object.keys(trace), [
    "questionId",
    "sourceText",
    "type",
    "card",
    "resolvedCardIds",
    "scenarioCardIds",
    "searchQueries",
    "rawCandidateEvidence",
    "classifiedEvidence",
    "downgradedDirectEvidence",
    "evidenceCoverageReason",
  ]);
  return trace;
}

function resolvedCard() {
  return { id: "card-a", name: "测试卡A", aliases: ["测试卡A"] };
}
