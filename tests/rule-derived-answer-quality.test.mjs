import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { answerEachSubQuestion, mergeModelAnswer } from "../backend/engine.mjs";
import { buildRuleAnalysisHints, buildRuleDerivedAnswer, validateRuleDerivedAnswer } from "../backend/ruleDerivedAnswer.mjs";
import { generateRuleDerivedAnswer } from "../backend/ruleDerivedModel.mjs";
import { RULE_DERIVED_GOLDEN_CASES, runProductAnswerQuality } from "../scripts/product-answer-quality.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";

test("phrase-matched golden cases do not manufacture rule-derived verdicts", async () => {
  const report = await runProductAnswerQuality();
  assert.equal(report.total, 3);
  assert.equal(report.ruleDerivedAnswerCount, 0);
  assert.equal(report.usefulRuleDerivedCount, 0);
  assert.equal(report.uselessRuleDerivedCount, 0);
  assert.equal(report.internalReasonLeakCount, 0);
  assert.equal(report.unsafeConfirmedCount, 0);
});

test("rule primitives remain analysis-only and expose no verdict fields", () => {
  const analysis = buildRuleAnalysisHints({
    originalQuestion: "同一张手卡在连锁中能否再次给对手观看来发动？",
    formalQuery: { originalText: "同一张手卡在连锁中能否再次给对手观看来发动？", subQuestions: [] },
    rejectedEvidence: [{ rejectedReason: "conflicting_direct_evidence" }],
  });
  assert.equal(analysis.status, "analysis_only");
  assert.ok(analysis.reasoningChecks.length >= 2);
  assert.equal(Object.hasOwn(analysis, "verdict"), false);
  assert.equal(Object.hasOwn(analysis, "shortAnswer"), false);
  assert.equal(Object.hasOwn(analysis, "confidence"), false);
  assert.equal(buildRuleDerivedAnswer({ originalQuestion: "可以发动吗？" }), null);
});

test("unresolved card names also block analysis hints", () => {
  const analysis = buildRuleAnalysisHints({
    originalQuestion: "卡通青眼究极龙能否直接攻击？",
    unresolvedCards: [{ unresolvedCardName: "卡通青眼究极龙", candidateCards: [{ name: "青眼究极龙" }] }],
  });
  assert.equal(analysis, null);
});

test("official direct evidence remains authoritative and rule-derived output does not confirm", () => {
  const qa = {
    id: "qa-direct",
    recordType: "qa",
    title: "发动条件 Q&A",
    question: "可以发动吗？",
    conclusion: "可以发动。",
    cards: ["测试卡"],
    questionTypes: ["activation_condition"],
    sourceType: "official_qa",
  };
  const formalQuery = {
    originalText: "测试卡可以发动吗？",
    cards: [{ name: "测试卡", role: "question_card" }],
    scenario: { rawContext: "" },
    subQuestions: [{ id: "q1", type: "activation_condition", card: "测试卡", askedResult: "can_activate", sourceText: "测试卡可以发动吗？" }],
  };
  const answer = answerEachSubQuestion(formalQuery, { bySubQuestion: [{
    subQuestionId: "q1",
    rulingEvidence: [{ ...qa, evidenceId: qa.id }],
    similarRulingEvidence: [],
    rejectedEvidence: [],
    cardTextEvidence: [],
  }] }, { records: [qa] })[0];
  assert.equal(answer.status, "confirmed");
  assert.equal(answer.officialAnswer.status, "confirmed");
  assert.equal(answer.ruleDerivedAnswer, undefined);
});

test("model adapter cannot mint an unverified rule-derived verdict or overwrite official fields", async () => {
  let modelCalled = false;
  const generated = await generateRuleDerivedAnswer({
    originalQuestion: "复制效果时是否复制额外发动方式和效果外文本？",
    officialAnswer: { status: "not_found", verdict: "unknown", evidenceIds: [] },
  }, { model: async () => { modelCalled = true; return { status: "confirmed", shortAnswer: "官方确认可以。" }; } });
  assert.equal(modelCalled, false);
  assert.equal(generated.answer, null);
  assert.equal(generated.provider, "disabled");
  assert.ok(generated.warnings.includes("unverified_rule_derived_verdict_disabled"));
  assert.equal(validateRuleDerivedAnswer({ status: "rule_derived", shortAnswer: "可以。" }).valid, false);

  const merged = mergeModelAnswer({
    explanationText: "模型解释",
    ruleDerivedAnswer: { status: "confirmed", verdict: "can" },
    status: "confirmed",
  }, { status: "unknown", verdict: "unknown", evidenceIds: [] });
  assert.equal(merged.status, "unknown");
  assert.equal(merged.ruleDerivedAnswer, undefined);
});

test("analysis-only hints are not presented as a ruling conclusion", async () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    officialAnswer: { status: "not_found", verdict: "unknown", evidenceIds: [] },
    reason: "no_direct_evidence",
  });
  assert.equal(summary.statusLabel, "资料不足");
  assert.equal(summary.ruleDerivedAnswerText, null);

  const [html, css] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /class="theme-night"/u);
  assert.match(html, /游戏王OCG规则助手/u);
  assert.match(html, />资料来源</u);
  assert.doesNotMatch(html, /OCG RULING TERMINAL|ANALYSIS CORE/u);
  for (const token of ["assets/bg-day.png", "assets/bg-night.png", "--surface", "--accent", "theme-night"]) {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});

test("golden case definitions are acceptance gist, not exact answer strings", () => {
  for (const item of RULE_DERIVED_GOLDEN_CASES) {
    assert.ok(item.requiredConcepts.length >= 4);
    assert.equal(Object.hasOwn(item, "exactAnswer"), false);
  }
});
