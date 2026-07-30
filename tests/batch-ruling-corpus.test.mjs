import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBatchSummary,
  evaluateRulingAnswer,
  renderBatchMarkdownSummary,
  shouldFailBatchProcess,
} from "../scripts/batch-ruling-corpus.mjs";

test("batch evaluator reports card, direct QA, and simple verdict hits separately", () => {
  const evaluation = evaluateRulingAnswer({
    id: "simple-hit",
    question: "可以发动吗？",
    expectedCardIds: ["100", "200"],
    expectedQaId: "300",
    expectedAnswer: "発動できます。",
  }, {
    shortAnswer: "可以发动。",
    resolvedCards: [{ id: "100" }, { id: "200" }],
    usedEvidence: [{ id: "ygoresources-qa-300" }],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 1 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "pass");
  assert.equal(evaluation.cardResolution.status, "hit");
  assert.equal(evaluation.officialQa.status, "hit");
  assert.equal(evaluation.correctness.status, "pass");
});

test("batch evaluator fails independently on missing cards, missing QA, and a contradictory verdict", () => {
  const evaluation = evaluateRulingAnswer({
    id: "hard-miss",
    question: "可以发动吗？",
    expectedCardIds: ["100", "200"],
    expectedQaId: "300",
    expectedAnswer: "発動できません。",
  }, {
    shortAnswer: "可以发动。",
    resolvedCards: [{ id: "100" }],
    usedEvidence: [],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 0 },
      unresolvedMentions: [{ input: "未知卡" }],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "fail");
  assert.deepEqual(evaluation.cardResolution.missingCardIds, ["200"]);
  assert.equal(evaluation.officialQa.status, "miss");
  assert.equal(evaluation.correctness.reason, "verdict_contradiction");
});

test("complex official answers remain manual review even when the expected QA is cited", () => {
  const evaluation = evaluateRulingAnswer({
    id: "complex",
    question: "处理如何进行？",
    expectedQaId: "300",
    expectedAnswer: "発動できます。\n\nその後、素材を墓地へ送り、特別な処理を行います。処理時の状態によって一部を適用しません。",
  }, {
    shortAnswer: "可以发动，之后进行处理。",
    resolvedCards: [{ id: "100" }],
    usedEvidence: [{ id: "ygoresources-qa-300" }],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 1 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "needs_review");
  assert.equal(evaluation.correctness.status, "needs_review");
  assert.equal(evaluation.correctness.reason, "official_qa_grounded_but_completeness_requires_review");
});

test("batch summary exposes retrieval failures without conflating them with request failures", () => {
  const summary = buildBatchSummary([
    {
      runs: {
        online: {
          ok: true,
          evaluation: {
            overall: "fail",
            cardResolution: { status: "miss" },
            officialQa: { status: "not_found" },
          },
        },
        local: {
          ok: true,
          evaluation: {
            overall: "pass",
            cardResolution: { status: "hit" },
            officialQa: { status: "hit" },
          },
        },
      },
      comparison: { status: "diverged" },
    },
    {
      runs: {
        online: {
          ok: false,
          evaluation: { overall: "request_failed" },
        },
      },
      comparison: { status: "not_available" },
    },
  ]);

  assert.equal(summary.runs.online.completed, 2);
  assert.equal(summary.runs.online.requestFailed, 1);
  assert.equal(summary.runs.online.cardMiss, 1);
  assert.equal(summary.runs.online.officialQaNotFound, 1);
  assert.equal(summary.runs.local.pass, 1);
  assert.equal(summary.onlineLocalDiverged, 1);
});

test("transport failure policy keeps review and retrieval regressions neutral but rejects request failures", () => {
  const reviewOnly = {
    summary: {
      runs: {
        online: {
          completed: 3,
          requestFailed: 0,
          fail: 2,
          needsReview: 1,
        },
      },
    },
  };
  assert.equal(shouldFailBatchProcess(reviewOnly, "strict"), true);
  assert.equal(shouldFailBatchProcess(reviewOnly, "transport"), false);

  const requestFailure = structuredClone(reviewOnly);
  requestFailure.summary.runs.online.requestFailed = 1;
  assert.equal(shouldFailBatchProcess(requestFailure, "transport"), true);
  assert.throws(
    () => shouldFailBatchProcess(reviewOnly, "unknown"),
    /unsupported failure policy/u,
  );
  assert.match(renderBatchMarkdownSummary({
    inputPath: "data/test/example.json",
    summary: reviewOnly.summary,
  }), /Soft fail and needs review are report findings/u);
});

test("a local mock dry run cannot be reported as a real passing answer", () => {
  const evaluation = evaluateRulingAnswer({
    question: "可以发动吗？",
    expectedAnswer: "発動できます。",
  }, {
    shortAnswer: "可以发动。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      dryRun: true,
      providerUsed: "mock",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "dry_run");
  assert.equal(evaluation.execution.dryRun, true);
});

test("a deterministic local ruling is evaluated as a real answer even when no model was called", () => {
  const evaluation = evaluateRulingAnswer({
    question: "可以发动吗？",
    expectedAnswer: "不能发动。",
  }, {
    shortAnswer: "不能发动。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      dryRun: true,
      providerUsed: "local",
      modelUsed: "deterministic-ruling-reasoner",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "pass");
  assert.equal(evaluation.execution.rawDryRun, true);
  assert.equal(evaluation.execution.dryRun, false);
});

test("twitter fixture card names and officialFaqId are accepted with normalized aliases", () => {
  const evaluation = evaluateRulingAnswer({
    question: "この場合は発動できますか？",
    expectedCardNames: ["M・HERO ダーク・ロウ"],
    officialFaqId: "13330",
    expectedAnswerKeyPoints: ["可以发动", "作为融合素材"],
  }, {
    shortAnswer: "可以发动。处理时也可以将其作为融合素材。",
    resolvedCards: [{
      id: "11313",
      name: "假面－英雄 暗法",
      jaName: "M・HERO ダーク・ロウ",
    }],
    usedEvidence: [{ id: "ygoresources-qa-13330" }],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 1 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.cardResolution.status, "hit");
  assert.deepEqual(evaluation.cardResolution.missingCardNames, []);
  assert.equal(evaluation.officialQa.status, "hit");
  assert.equal(evaluation.correctness.status, "pass");
});

test("untranslated or omitted twitter answer key points request review instead of a false failure", () => {
  const evaluation = evaluateRulingAnswer({
    question: "処理はどうなりますか？",
    expectedAnswerKeyPoints: ["墓地へ送らず除外する"],
  }, {
    shortAnswer: "The card is banished instead of being sent to the Graveyard.",
    resolvedCards: [{ id: "1", name: "テストカード" }],
    usedEvidence: [],
    debug: {
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.correctness.status, "needs_review");
  assert.equal(evaluation.correctness.reason, "answer_key_points_need_cross_language_or_completeness_review");
  assert.equal(evaluation.overall, "needs_review");
});

test("negative activation and application phrases are not double-counted as positive verdicts", () => {
  const evaluation = evaluateRulingAnswer({
    question: "発動できますか？",
    expectedAnswer: "不可以发动，也不会适用。",
  }, {
    shortAnswer: "不可以发动，也不会适用。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.deepEqual(evaluation.correctness.expectedVerdicts, ["cannot_activate", "does_not_apply"]);
  assert.deepEqual(evaluation.correctness.actualVerdicts, ["cannot_activate", "does_not_apply"]);
});
