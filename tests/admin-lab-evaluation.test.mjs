import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
  evaluateAdminLabCorpusResults,
  evaluateAdminLabResult,
  loadAdminLabEvaluationCorpus,
} from "../backend/adminLabEvaluation.mjs";

test("loads the frozen eight-case corpus locally without a model or network", async () => {
  let readCount = 0;
  const corpus = await loadAdminLabEvaluationCorpus({
    readFileImpl: async (url, encoding) => {
      readCount += 1;
      assert.equal(url.protocol, "file:");
      assert.equal(encoding, "utf8");
      const { readFile } = await import("node:fs/promises");
      return readFile(url, encoding);
    },
  });
  assert.equal(readCount, 1);
  assert.equal(corpus.cases.length, 8);
  assert.equal(Object.isFrozen(corpus), true);
});

test("assessment explains key-point, forbidden-phrase, and card-evidence checks", async () => {
  const corpus = await loadAdminLabEvaluationCorpus();
  const testCase = corpus.cases.find(
    (item) => item.id === "silver-hound-control-change-ends-lingering-restriction",
  );
  const result = evaluateAdminLabResult({
    testCase,
    structuredResult: {
      conciseAnswer: [
        "控制权转移时立即不再适用。",
        "控制权归还后不会恢复适用。",
      ].join(""),
      verdicts: [{
        conclusion: "只要以此效果特殊召唤的怪兽在自己场上存在属于持续条件。",
        conditions: [],
      }],
      claims: [],
      timeline: [],
    },
    evidenceSnapshot: {
      evidence: {
        cards: [{ cardId: "21417", cardName: "月光银狗" }],
      },
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.humanTruth, false);
  assert.equal(result.disclaimer, ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER);
  assert.equal(result.summary.keyPointCoverage, 1);
  assert.equal(result.summary.forbiddenHitCount, 0);
  assert.equal(result.summary.cardEvidenceCoverage, 1);
  assert.ok(result.checks.keyPoints.every((item) => item.explanation));
  assert.ok(result.checks.cardEvidence.every((item) => item.explanation));
});

test("forbidden answer and missing card evidence fail with visible reasons", async () => {
  const corpus = await loadAdminLabEvaluationCorpus();
  const testCase = corpus.cases.find(
    (item) => item.id === "copied-effect-is-not-printed-name-reference",
  );
  const result = evaluateAdminLabResult({
    testCase,
    structuredResult: {
      finalRuling: {
        conciseAnswer: "复制效果后视为卡面记载有光之黄金柜。",
        verdicts: [],
        claims: [],
        timeline: [],
      },
    },
    evidenceSnapshot: {
      evidence: {
        cardTexts: [{ cardId: "13077" }],
      },
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.summary.forbiddenHitCount, 1);
  assert.deepEqual(
    result.checks.cardEvidence.filter((item) => !item.found).map((item) => item.cardId),
    ["19842", "19892"],
  );
  assert.match(
    result.checks.forbiddenPhrases.find((item) => item.present).explanation,
    /禁止/u,
  );
});

test("suite reports missing results and never labels automation as human truth", async () => {
  const corpus = await loadAdminLabEvaluationCorpus();
  const firstCase = corpus.cases[0];
  const report = evaluateAdminLabCorpusResults({
    corpus,
    resultsByCaseId: {
      [firstCase.id]: {
        structuredResult: {
          conciseAnswer: firstCase.expectedAnswerKeyPoints.join("。"),
          verdicts: [],
          claims: [],
          timeline: [],
        },
        evidenceSnapshot: {
          evidence: {
            items: firstCase.expectedCardIds.map((cardId) => ({
              sourceType: "card_text",
              cardId,
            })),
          },
        },
      },
    },
  });

  assert.equal(report.totalCount, 8);
  assert.equal(report.passedCount, 1);
  assert.equal(report.humanTruth, false);
  assert.equal(report.cases.filter((item) => item.missingResult).length, 7);
});
