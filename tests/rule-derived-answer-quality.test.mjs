import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { answerEachSubQuestion, mergeModelAnswer } from "../backend/engine.mjs";
import { buildRuleDerivedAnswer, validateRuleDerivedAnswer } from "../backend/ruleDerivedAnswer.mjs";
import { generateRuleDerivedAnswer } from "../backend/ruleDerivedModel.mjs";
import { RULE_DERIVED_GOLDEN_CASES, runProductAnswerQuality } from "../scripts/product-answer-quality.mjs";
import { buildUserFacingSubAnswerSummary } from "../src/uiPresentation.mjs";

test("three golden cases produce substantive rule-derived answers", async () => {
  const report = await runProductAnswerQuality();
  assert.equal(report.total, 3);
  assert.equal(report.ruleDerivedAnswerCount, 3);
  assert.equal(report.usefulRuleDerivedCount, 3);
  assert.equal(report.uselessRuleDerivedCount, 0);
  assert.equal(report.wrongCardResolutionCount, 0);
  assert.equal(report.internalReasonLeakCount, 0);
  assert.equal(report.unsafeConfirmedCount, 0);
  for (const item of report.cases) {
    assert.equal(item.missingConcepts.length, 0, `${item.id}: ${item.missingConcepts.join(", ")}`);
    assert.ok(item.ruleDerivedAnswer.reasoningSteps.length >= 2);
    assert.notEqual(item.ruleDerivedAnswer.verdict, "unknown");
    assert.doesNotMatch(item.summary, /^(?:资料不足|需要官方 Q&A|可以参考卡片文本)$/u);
  }
});

test("counter evidence lowers confidence and raises a risk flag", () => {
  const answer = buildRuleDerivedAnswer({
    originalQuestion: "同一张手卡在连锁中能否再次给对手观看来发动？",
    formalQuery: { originalText: "同一张手卡在连锁中能否再次给对手观看来发动？", subQuestions: [] },
    rejectedEvidence: [{ rejectedReason: "conflicting_direct_evidence" }],
  });
  assert.equal(answer.status, "rule_derived");
  assert.equal(answer.confidence, "low");
  assert.equal(answer.counterEvidenceFound, true);
  assert.ok(answer.riskFlags.includes("counter_evidence_found"));
});

test("unresolved card names block a rule conclusion", () => {
  const answer = buildRuleDerivedAnswer({
    originalQuestion: "卡通青眼究极龙能否直接攻击？",
    unresolvedCards: [{ unresolvedCardName: "卡通青眼究极龙", candidateCards: [{ name: "青眼究极龙" }] }],
  });
  assert.equal(answer, null);
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

test("model adapter validates isolated rule-derived output and cannot overwrite official fields", async () => {
  const fixture = buildRuleDerivedAnswer({
    originalQuestion: "复制效果时是否复制额外发动方式和效果外文本？",
    formalQuery: { originalText: "复制效果时是否复制额外发动方式和效果外文本？", subQuestions: [] },
  });
  assert.equal(validateRuleDerivedAnswer(fixture).valid, true);
  const generated = await generateRuleDerivedAnswer({
    originalQuestion: "复制效果时是否复制额外发动方式和效果外文本？",
    officialAnswer: { status: "not_found", verdict: "unknown", evidenceIds: [] },
  }, { model: async () => ({ ...fixture, status: "confirmed", shortAnswer: "官方确认可以。" }) });
  assert.equal(generated.answer.status, "rule_derived");
  assert.equal(generated.provider, "deterministic");
  assert.ok(generated.warnings.includes("model_rule_derived_invalid"));

  const merged = mergeModelAnswer({
    explanationText: "模型解释",
    ruleDerivedAnswer: { status: "confirmed", verdict: "can" },
    status: "confirmed",
  }, { status: "unknown", verdict: "unknown", evidenceIds: [], ruleDerivedAnswer: fixture });
  assert.equal(merged.status, "unknown");
  assert.equal(merged.ruleDerivedAnswer.status, "rule_derived");
});

test("UI presents rule-derived wording and terminal theme without internal codes", async () => {
  const answer = buildRuleDerivedAnswer({
    originalQuestion: "复制效果时是否复制额外发动方式和效果外文本？",
    formalQuery: { originalText: "复制效果时是否复制额外发动方式和效果外文本？", subQuestions: [] },
  });
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    officialAnswer: { status: "not_found", verdict: "unknown", evidenceIds: [] },
    ruleDerivedAnswer: answer,
    reason: "no_direct_evidence",
  });
  assert.equal(summary.statusLabel, "规则推导结论");
  assert.match(summary.ruleDerivedAnswerText, /效果处理|发动手续/u);
  assert.doesNotMatch(summary.ruleDerivedAnswerText, /no_direct_evidence/u);

  const [html, css] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /class="terminal-theme"/u);
  assert.match(html, /OCG RULING TERMINAL/u);
  assert.match(html, /SOURCE TRACE/u);
  for (const variable of ["--bg-0", "--panel", "--accent-cyan", "--accent-violet", "--glow-cyan"]) {
    assert.match(css, new RegExp(variable));
  }
});

test("golden case definitions are acceptance gist, not exact answer strings", () => {
  for (const item of RULE_DERIVED_GOLDEN_CASES) {
    assert.ok(item.requiredConcepts.length >= 4);
    assert.equal(Object.hasOwn(item, "exactAnswer"), false);
  }
});
