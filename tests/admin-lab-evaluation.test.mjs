import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER,
  evaluateAdminLabCorpusResults,
  evaluateAdminLabResult,
  loadAdminLabEvaluationCorpus,
  validateEvaluationCase,
} from "../backend/adminLabEvaluation.mjs";

test("loads and freezes the eight-case structured evaluation corpus", async () => {
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
  assert.ok(corpus.cases.every((item) => item.expectedVerdict));
  assert.ok(corpus.cases.every((item) => item.expectedEvidenceIds.length > 0));
  assert.ok(corpus.cases.every((item) => Object.isFrozen(item.expectedAssertions)));
});

test("passes only when verdict, claim, ordered timeline, and visible packet evidence agree", () => {
  const result = evaluateAdminLabResult({
    testCase: strictCase(),
    structuredResult: correctRuling(),
    evidenceSnapshot: visiblePacket(),
  });

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.passed, true);
  assert.equal(result.humanTruth, false);
  assert.equal(result.disclaimer, ADMIN_LAB_AUTOMATED_ASSESSMENT_DISCLAIMER);
  assert.equal(result.expectedVerdict.referenceText, "可以发动，但处理时不进行融合召唤。");
  assert.equal(result.expectedVerdict.automaticallyCompared, false);
  assert.equal(result.summary.structuredAssertionCoverage, 1);
  assert.equal(result.summary.evidenceCoverage, 1);
  assert.equal(result.summary.cardEvidenceCoverage, 1);
  assert.ok(result.checks.structuredAssertions.every((item) => item.passed));
  assert.equal(result.checks.decisionPacket.available, true);
});

test("wrong structured verdict fails even when every legacy key phrase is present", () => {
  const ruling = correctRuling();
  ruling.verdicts[0].value = "FALSE";
  ruling.conciseAnswer = strictCase().expectedAnswerKeyPoints.join("。");
  const result = evaluateAdminLabResult({
    testCase: strictCase(),
    structuredResult: ruling,
    evidenceSnapshot: visiblePacket(),
  });

  assert.equal(result.summary.keyPointCoverage, 1);
  assert.equal(result.passed, false);
  assert.equal(
    result.checks.structuredAssertions.find((item) => item.assertionType === "verdict").passed,
    false,
  );
});

test("evidence present only in the full snapshot cannot satisfy final-model coverage", () => {
  const snapshot = visiblePacket({ includeFaq: false });
  snapshot.evidence.evidenceArchive = {
    evidenceIndex: [{ evidenceId: "card-faq-a" }],
  };
  const result = evaluateAdminLabResult({
    testCase: strictCase(),
    structuredResult: correctRuling(),
    evidenceSnapshot: snapshot,
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks.evidenceCoverage[0].found, false);
  assert.match(result.checks.evidenceCoverage[0].explanation, /decision packet/u);
});

test("missing decision packet fails even if archive and resolved cards contain all ids", () => {
  const result = evaluateAdminLabResult({
    testCase: strictCase(),
    structuredResult: correctRuling(),
    evidenceSnapshot: {
      evidence: {
        evidenceArchive: { evidenceIndex: [{ evidenceId: "card-faq-a" }] },
        cards: [{ cardId: "21417" }],
      },
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.summary.packetAvailable, false);
  assert.equal(result.summary.evidenceCoverage, 0);
  assert.equal(result.summary.cardEvidenceCoverage, 0);
});

test("expected evidence rank is enforced against visible packet item order", () => {
  const testCase = strictCase();
  testCase.expectedEvidenceMaxRank = 2;
  const result = evaluateAdminLabResult({
    testCase,
    structuredResult: correctRuling(),
    evidenceSnapshot: visiblePacket(),
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks.evidenceCoverage[0].bestRank, 3);
  assert.equal(result.checks.evidenceCoverage[0].withinRank, false);
});

test("legacy substring probes are diagnostic-only and cannot veto structured truth", () => {
  const testCase = strictCase();
  testCase.expectedAnswerKeyPoints = ["完全不同的参考措辞"];
  testCase.mustNotInclude = ["错误说法"];
  const ruling = correctRuling();
  ruling.conciseAnswer = "结论成立；以下只是反例文字：错误说法。";
  const result = evaluateAdminLabResult({
    testCase,
    structuredResult: ruling,
    evidenceSnapshot: visiblePacket(),
  });

  assert.equal(result.summary.keyPointCoverage, 0);
  assert.equal(result.summary.forbiddenHitCount, 1);
  assert.equal(result.checks.keyPoints[0].gating, false);
  assert.equal(result.checks.forbiddenPhrases[0].gating, false);
  assert.equal(result.passed, true);
});

test("validation retains evidence expectations and rejects unsafe assertion shapes", () => {
  const normalized = validateEvaluationCase(strictCase());
  assert.deepEqual(normalized.expectedEvidenceIds, ["card-faq-a"]);
  assert.equal(normalized.expectedEvidenceMaxRank, 3);
  assert.equal(normalized.expectedAssertions.verdicts[0].value, "TRUE");

  assert.throws(
    () => validateEvaluationCase({ ...strictCase(), expectedAssertions: {} }),
    /expectedAssertions must contain/u,
  );
  assert.throws(
    () => validateEvaluationCase({ ...strictCase(), expectedEvidenceMaxRank: 0 }),
    /positive integer/u,
  );
  assert.throws(
    () => validateEvaluationCase({ ...strictCase(), expectedEvidenceIds: undefined }),
    /expectedEvidenceIds must be an array/u,
  );
});

test("suite reports missing results and never labels automation as human truth", () => {
  const testCase = strictCase();
  const report = evaluateAdminLabCorpusResults({
    corpus: {
      schemaVersion: 1,
      fixtureName: "small-suite",
      purpose: "unit test",
      cases: [testCase, { ...strictCase(), id: "missing-case" }],
    },
    resultsByCaseId: {
      [testCase.id]: {
        structuredResult: correctRuling(),
        evidenceSnapshot: visiblePacket(),
      },
    },
  });

  assert.equal(report.totalCount, 2);
  assert.equal(report.passedCount, 1);
  assert.equal(report.humanTruth, false);
  assert.equal(report.cases.filter((item) => item.missingResult).length, 1);
});

function strictCase() {
  return {
    id: "structured-evaluation-case",
    mechanisms: ["activation-legality", "sequential-resolution"],
    question: "可以发动这个效果吗，支付代价后效果处理时如何处理？",
    expectedCardIds: ["21417"],
    expectedEvidenceIds: ["card-faq-a"],
    expectedEvidenceMaxRank: 3,
    expectedVerdict: "可以发动，但处理时不进行融合召唤。",
    expectedAssertions: {
      verdicts: [{ questionId: "q1", value: "TRUE" }],
      claims: [{
        assertionId: "no-fusion-at-resolution",
        questionId: "q1",
        status: "TRUE",
        evidenceIdsAll: ["card-faq-a"],
        proposition: {
          allOf: [["处理时"], ["不进行", "不会进行"], ["融合召唤"]],
          noneOf: ["融合召唤成功"],
        },
      }],
      timelineOrder: [{
        assertionId: "cost-before-resolution",
        steps: [
          { action: { allOf: [["支付", "丢弃"], ["代价", "COST"]] } },
          { result: { allOf: [["不进行", "不会进行"], ["融合召唤"]] } },
        ],
      }],
    },
    expectedAnswerKeyPoints: ["可以发动", "不进行融合召唤"],
    mustNotInclude: ["融合召唤成功"],
  };
}
function correctRuling() {
  return {
    conciseAnswer: "可以发动；效果处理时不会进行融合召唤。",
    verdicts: [{
      questionId: "q1",
      value: "TRUE",
      conclusion: "发动合法，但处理不会完成融合召唤。",
      conditions: [],
    }],
    claims: [{
      questionId: "q1",
      claimId: "claim-1",
      proposition: "支付代价后状态改变，处理时不进行融合召唤。",
      status: "TRUE",
      decisive: true,
      evidenceIds: ["card-faq-a"],
      inferenceType: "TIMING",
    }],
    timeline: [
      { order: 1, action: "支付COST并丢弃手牌", result: "状态更新", evidenceIds: ["card-faq-a"] },
      { order: 2, action: "处理效果", result: "不进行融合召唤", evidenceIds: ["card-faq-a"] },
    ],
  };
}

function visiblePacket({ includeFaq = true } = {}) {
  const evidenceItems = [{
    packetItemId: "packet-card",
    evidenceId: "21417",
    evidenceIds: ["21417"],
    category: "parsed_card_text",
    body: "月光银狗卡片文本",
  }, {
    packetItemId: "packet-prior-faq",
    evidenceId: "card-faq-prior",
    evidenceIds: ["card-faq-prior"],
    category: "faq",
    body: "同类但非预期的先行 FAQ。",
  }];
  if (includeFaq) {
    evidenceItems.push({
      packetItemId: "packet-faq",
      evidenceId: "card-faq-a",
      evidenceIds: ["card-faq-a"],
      category: "faq",
      body: "处理时不进行融合召唤。",
    });
  }
  return {
    evidence: {
      evidenceDecisionPacket: {
        modelPacket: { evidenceItems },
      },
    },
  };
}
