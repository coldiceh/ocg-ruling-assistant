import assert from "node:assert/strict";
import test from "node:test";

import {
  runValidatedRawEvidenceFinal,
  validateRawEvidenceFinalAnswer,
} from "../backend/rawEvidenceAnswerValidator.mjs";

function makeAnswer(overrides = {}) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer: "模型独立给出的匿名结论。",
    reasoning: ["模型阅读原始资料后作答。"],
    usedCards: ["匿名卡"],
    usedEvidence: [{ id: "raw-1", type: "card_text", title: "匿名卡文" }],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
    ...overrides,
  };
}

test("raw validator checks only transport, schema and frozen evidence ids", async () => {
  let calls = 0;
  const result = await runValidatedRawEvidenceFinal({
    originalPrompt: "anonymous",
    evidence: {
      cardTexts: [{ id: "raw-1", text: "原始卡文" }],
      operationLegality: { verdict: "相反的派生结论" },
      legacyLuaSemanticPacket: { candidateVerdict: "相反的 Lua 结论" },
    },
    allowedEvidenceIds: ["raw-1"],
    invoke: async () => {
      calls += 1;
      return { answer: makeAnswer(), rawText: JSON.stringify(makeAnswer()), warnings: [] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.answer.shortAnswer, "模型独立给出的匿名结论。");
  assert.equal(result.publicFinalValidation.outcome, "primary_valid");
  assert.equal(result.publicFinalValidation.callCount, 1);
  assert.equal(result.publicFinalValidation.repairAttempted, false);
  assert.equal(result.publicFinalValidation.repair, null);
});

test("wrapped invalid model output and unsent evidence ids fail without semantic repair", async () => {
  for (const fixture of [
    { answer: makeAnswer(), warnings: ["model_natural_language_wrapped"] },
    { answer: makeAnswer({ usedEvidence: [{ id: "not-sent" }] }), warnings: [] },
    { answer: { shortAnswer: "不完整" }, warnings: [] },
  ]) {
    let calls = 0;
    const result = await runValidatedRawEvidenceFinal({
      originalPrompt: "anonymous",
      evidence: { cardTexts: [{ id: "raw-1", text: "原始卡文" }] },
      allowedEvidenceIds: ["raw-1"],
      invoke: async () => {
        calls += 1;
        return { ...fixture, rawText: JSON.stringify(fixture.answer) };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.publicFinalValidation.outcome, "primary_invalid_no_ruling");
    assert.equal(result.publicFinalValidation.callCount, 1);
    assert.equal(result.publicFinalValidation.repairAttempted, false);
    assert.notEqual(result.answer.shortAnswer, fixture.answer.shortAnswer);
  }
});

test("schema validator does not accept ids absent from the final prompt", () => {
  const result = validateRawEvidenceFinalAnswer(makeAnswer({
    usedEvidence: [{ id: "compressed-away" }],
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("compressed-away")));
});

test("answer level is constrained by the prompt's evidence-authority path", () => {
  const ordinary = validateRawEvidenceFinalAnswer(makeAnswer({
    answerLevel: "official_confirmed",
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
    allowedAnswerLevels: ["rule_analysis", "low_confidence_analysis", "needs_more_info", "budget_limited"],
  });
  assert.equal(ordinary.ok, false);
  assert.ok(ordinary.errors.some((error) => error.includes("not allowed")));

  const direct = validateRawEvidenceFinalAnswer(makeAnswer({
    answerLevel: "official_confirmed",
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
    allowedAnswerLevels: ["official_confirmed"],
  });
  assert.equal(direct.ok, true);
});

test("determinate answers require at least one valid frozen evidence citation", () => {
  for (const answerLevel of ["official_confirmed", "rule_analysis", "low_confidence_analysis"]) {
    const result = validateRawEvidenceFinalAnswer(makeAnswer({
      answerLevel,
      usedEvidence: [],
    }), {
      rawText: "{}",
      allowedEvidenceIds: ["raw-1"],
      allowedAnswerLevels: [answerLevel],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("valid evidence citation")));
  }
  const needsMoreInfo = validateRawEvidenceFinalAnswer(makeAnswer({
    answerLevel: "needs_more_info",
    usedEvidence: [],
  }), {
    rawText: "{}",
    allowedEvidenceIds: [],
    allowedAnswerLevels: ["needs_more_info"],
  });
  assert.equal(needsMoreInfo.ok, true);
});

test("strict official evidence never bypasses the one final model call", async () => {
  let calls = 0;
  const result = await runValidatedRawEvidenceFinal({
    originalPrompt: "anonymous official prompt",
    evidence: {
      officialQaDirectCandidates: [{
        id: "official-direct",
        type: "official_qa",
        fullText: "匿名官方问答。可以处理。",
      }],
    },
    authoritativeOfficialDirect: "official-direct",
    allowedEvidenceIds: ["official-direct"],
    invoke: async () => {
      calls += 1;
      return { answer: { shortAnswer: "格式错误" }, rawText: "{}", warnings: [] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.publicFinalValidation.outcome, "primary_invalid_no_ruling");
  assert.equal(result.publicFinalValidation.primary.checks.officialDirectFallback, false);
  assert.notEqual(result.answer.answerLevel, "official_confirmed");
  assert.doesNotMatch(result.answer.shortAnswer, /可以处理/u);
});
