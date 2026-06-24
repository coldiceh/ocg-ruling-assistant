import assert from "node:assert/strict";
import test from "node:test";
import { retrieveEvidenceByFormalQuery } from "../backend/engine.mjs";
import { normalizeFormalRulingQuery } from "../backend/formalQuery.mjs";
import { classifyPrimaryNoDirectReason } from "../scripts/benchmark-report.mjs";

test("1. empty retrieval without card Q&A is data_missing_for_card", () => {
  assert.equal(classifyPrimaryNoDirectReason({
    trace: baseTrace({ rawCandidateEvidence: [] }),
    dataCoverage: { cardQaCount: 0, cardFaqCount: 0, hasAnyQaForCard: false },
  }), "data_missing_for_card");
});

test("2. empty retrieval with card Q&A is query_missed", () => {
  assert.equal(classifyPrimaryNoDirectReason({
    trace: baseTrace({ rawCandidateEvidence: [] }),
    dataCoverage: { cardQaCount: 2, cardFaqCount: 1, hasAnyQaForCard: true },
  }), "query_missed");
});

test("3. candidates answering different questions are classified explicitly", () => {
  assert.equal(classifyPrimaryNoDirectReason({
    trace: baseTrace({
      rawCandidateEvidence: [{ id: "qa-1", classification: "rejected", askedResultCoverage: "different_question", rank: 1 }],
      downgradedDirectEvidence: [{ id: "qa-1", reason: "different_question" }],
    }),
    dataCoverage: { hasAnyQaForCard: true },
  }), "all_candidates_different_question");
});

test("4. an explicit candidate below the visible top N is a ranking issue", () => {
  assert.equal(classifyPrimaryNoDirectReason({
    trace: baseTrace({
      rawCandidateEvidence: [{
        id: "qa-correct",
        classification: "similar",
        askedResultCoverage: "explicit",
        rank: 21,
      }],
    }),
    dataCoverage: { hasAnyQaForCard: true },
    topN: 20,
  }), "ranking_issue");
});

test("5. multilingual query expansion does not make unrelated evidence direct", () => {
  const card = {
    id: "test-card",
    cardId: "100",
    name: "测试卡",
    enName: "Test Card",
    jaName: "テストカード",
    aliases: ["Test Card", "テストカード"],
  };
  const unrelated = {
    id: "qa-unrelated",
    recordType: "qa",
    title: "其他卡的发动条件",
    cards: ["其他卡"],
    cardIds: ["200"],
    question: "Can the effect of Other Card be activated?",
    conclusion: "It can be activated.",
  };
  const formalQuery = normalizeFormalRulingQuery({
    originalText: "测试卡能否发动？",
    cards: [{ name: "测试卡", role: "question_card", controller: "unknown", zone: "unknown" }],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [{
      id: "q1",
      type: "activation_condition",
      card: "测试卡",
      askedResult: "can_activate",
      sourceText: "测试卡能否发动？",
    }],
  });
  const bucket = retrieveEvidenceByFormalQuery(formalQuery, [card], { records: [unrelated] }).bySubQuestion[0];

  assert.equal(bucket.rulingEvidence.length, 0);
  assert.ok(bucket.retrievalTrace.searchQueries.some((query) => /Test Card can activate/iu.test(query)));
  assert.ok(bucket.retrievalTrace.searchQueries.some((query) => /テストカード 発動条件/iu.test(query)));
});

function baseTrace(overrides = {}) {
  return {
    card: "测试卡",
    resolvedCardIds: ["100"],
    evidenceCoverageReason: "matcher_rejected_all",
    rawCandidateEvidence: [],
    downgradedDirectEvidence: [],
    ...overrides,
  };
}
