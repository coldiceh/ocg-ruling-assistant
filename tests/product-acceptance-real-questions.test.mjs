import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_ACCEPTANCE_REAL_QUESTIONS,
  runProductAcceptanceRealQuestions,
} from "../scripts/product-acceptance-real-questions.mjs";

test("product acceptance real questions all produce useful safe answers", async () => {
  const report = await runProductAcceptanceRealQuestions();
  assert.equal(report.total, PRODUCT_ACCEPTANCE_REAL_QUESTIONS.length);
  assert.equal(report.usefulAnswerCount, 3);
  assert.equal(report.uselessAnswerCount, 0);
  assert.equal(report.unsafeConfirmedCount, 0);
  assert.equal(report.internalReasonLeakCount, 0);
  assert.equal(report.wrongCardResolutionCount, 0);
  assert.ok(report.likelyAnswerCount >= 2);
  assert.ok(report.unresolvedCardPromptCount >= 2);
});

test("transaction rollback copy-effect question exposes the real issue instead of only saying insufficient data", async () => {
  const report = await runProductAcceptanceRealQuestions({
    cases: [PRODUCT_ACCEPTANCE_REAL_QUESTIONS.find((item) => item.id === "transaction-rollback-copy-extra-text")],
  });
  const item = report.cases[0];
  const sub = item.subAnswers[0];
  assert.equal(item.officialAnswer.status, "not_found");
  assert.equal(sub.status, "unknown");
  assert.ok(item.resolvedCards.some((card) => card.name === "事务回滚"));
  assert.ok(item.unresolvedCardNames.includes("随心捏军费"));
  assert.ok(sub.detectedQuestionTypes.includes("copy_effect"));
  assert.ok(sub.detectedQuestionTypes.includes("activation_procedure"));
  assert.ok(sub.detectedQuestionTypes.includes("effect_text_scope"));
  assert.equal(item.likelyAnswer.status, "best_effort");
  assert.match(item.likelyAnswer.issueSummary, /复制效果|额外发动方式|效果外文本/u);
  assert.match(item.likelyAnswer.possibleHandling, /效果处理内容/u);
  assert.match(item.likelyAnswer.possibleHandling, /发动手续|发动条件|发动方式/u);
  assert.match(item.likelyAnswer.whyNotConfirmed, /不能|未确认|direct evidence|confirmed/u);
  assert.doesNotMatch(item.userFacingSummary, /no_direct_evidence|card_text_only|similar_evidence/u);
  assert.notEqual(item.userFacingSummary, "资料不足");
});

test("toon blue-eyes ultimate is not silently resolved as blue-eyes ultimate dragon", async () => {
  const report = await runProductAcceptanceRealQuestions({
    cases: [PRODUCT_ACCEPTANCE_REAL_QUESTIONS.find((item) => item.id === "toon-blue-eyes-ultimate-direct-attack")],
  });
  const item = report.cases[0];
  assert.equal(item.wrongCardResolutionSuspected, false);
  assert.ok(item.unresolvedCardNames.includes("卡通青眼究极龙"));
  assert.ok(item.unresolvedCardPrompt.length >= 1);
  assert.equal(item.resolvedCards.some((card) => card.name === "青眼究极龙"), false);
  assert.ok(item.clarification?.question || item.likelyAnswer);
  assert.equal(item.unsafeConfirmed, false);
});

test("illusion of chaos reveal question gives concept analysis or card-name clarification", async () => {
  const report = await runProductAcceptanceRealQuestions({
    cases: [PRODUCT_ACCEPTANCE_REAL_QUESTIONS.find((item) => item.id === "illusion-of-chaos-reveal-same-card-chain")],
  });
  const item = report.cases[0];
  assert.equal(item.officialAnswer.status, "not_found");
  assert.ok(item.unresolvedCardNames.includes("黑魔术的护符"));
  assert.ok(item.unresolvedCardNames.includes("混沌之幻想魔术师"));
  assert.equal(item.likelyAnswer.status, "best_effort");
  assert.match(item.likelyAnswer.issueSummary, /同一张手卡|再次/u);
  assert.match(item.likelyAnswer.possibleHandling, /C1|同一连锁|再次/u);
  assert.match(item.likelyAnswer.neededEvidence, /直接裁定|direct evidence|官方/u);
  assert.doesNotMatch(item.userFacingSummary, /conflicting_direct_evidence|no_direct_evidence|card_text_only/u);
});

test("likely answers do not change final status or create unsafe confirmed output", async () => {
  const report = await runProductAcceptanceRealQuestions();
  for (const item of report.cases) {
    for (const sub of item.subAnswers) {
      if (sub.likelyAnswer) {
        assert.notEqual(sub.officialAnswer?.status, "confirmed");
        assert.notEqual(sub.likelyAnswer.status, "confirmed");
      }
    }
  }
  assert.equal(report.officialConfirmedCount, 0);
  assert.equal(report.unsafeConfirmedCount, 0);
});
