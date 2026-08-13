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

test("display-shape defects are adapted locally without semantic repair", async () => {
  let calls = 0;
  const result = await runValidatedRawEvidenceFinal({
    originalPrompt: "anonymous",
    allowedEvidenceIds: ["raw-1"],
    allowedAnswerLevels: ["rule_analysis", "low_confidence_analysis", "needs_more_info"],
    invoke: async () => {
      calls += 1;
      return {
        answer: {
          answerLevel: "official_confirmed",
          shortAnswer: "保留模型首轮给出的匿名结论。",
          reasoning: "单个理由字符串。",
          usedEvidence: [{ id: "compressed-away" }, { id: "raw-1", title: "匿名原始资料" }],
        },
        rawText: "",
        warnings: ["model_natural_language_wrapped"],
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.publicFinalValidation.outcome, "primary_valid");
  assert.equal(result.publicFinalValidation.callCount, 1);
  assert.equal(result.publicFinalValidation.repairAttempted, false);
  assert.equal(result.answer.shortAnswer, "保留模型首轮给出的匿名结论。");
  assert.equal(result.answer.answerLevel, "low_confidence_analysis");
  assert.deepEqual(result.answer.reasoning, ["单个理由字符串。"]);
  assert.deepEqual(result.answer.usedEvidence.map((item) => item.id), ["raw-1"]);
  assert.deepEqual(result.answer.usedCards, []);
  assert.ok(result.publicFinalValidation.primary.diagnosticWarnings.includes(
    "model_output_adapted:unavailable_citation_dropped",
  ));
});

test("schema adapter drops ids absent from the final prompt", () => {
  const result = validateRawEvidenceFinalAnswer(makeAnswer({
    usedEvidence: [{ id: "compressed-away" }],
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer.usedEvidence, []);
  assert.ok(result.diagnosticWarnings.includes("model_output_adapted:unavailable_citation_dropped"));
});

test("non-official answer level is normalized to an allowed ordinary level", () => {
  const ordinary = validateRawEvidenceFinalAnswer(makeAnswer({
    answerLevel: "official_confirmed",
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
    allowedAnswerLevels: ["rule_analysis", "low_confidence_analysis", "needs_more_info", "budget_limited"],
  });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.answer.answerLevel, "low_confidence_analysis");
  assert.ok(ordinary.diagnosticWarnings.includes("model_output_adapted:answer_level_normalized"));

  const direct = validateRawEvidenceFinalAnswer(makeAnswer({
    answerLevel: "official_confirmed",
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
    allowedAnswerLevels: ["official_confirmed"],
  });
  assert.equal(direct.ok, true);
});

test("missing citations preserve readable analysis but never create official authority", () => {
  for (const answerLevel of ["rule_analysis", "low_confidence_analysis"]) {
    const result = validateRawEvidenceFinalAnswer(makeAnswer({
      answerLevel,
      usedEvidence: [],
    }), {
      rawText: "{}",
      allowedEvidenceIds: ["raw-1"],
      allowedAnswerLevels: [answerLevel],
    });
    assert.equal(result.ok, true);
    assert.equal(result.answer.shortAnswer, "模型独立给出的匿名结论。");
  }
  const unsupportedOfficial = validateRawEvidenceFinalAnswer(makeAnswer({
    answerLevel: "official_confirmed",
    usedEvidence: [],
  }), {
    rawText: "{}",
    allowedEvidenceIds: ["raw-1"],
    allowedAnswerLevels: ["official_confirmed"],
  });
  assert.equal(unsupportedOfficial.ok, true);
  assert.equal(unsupportedOfficial.answer.answerLevel, "low_confidence_analysis");
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

test("missing or invalid levels cannot be upgraded by an official-only allowlist", () => {
  for (const answerLevel of [undefined, "invented_level", "rule_analysis"]) {
    const result = validateRawEvidenceFinalAnswer(makeAnswer({
      answerLevel,
      usedEvidence: [{ id: "raw-1" }],
    }), {
      rawText: "{}",
      allowedEvidenceIds: ["raw-1"],
      allowedAnswerLevels: ["official_confirmed", "budget_limited"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.answer.answerLevel, "low_confidence_analysis");
  }
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
  assert.equal(result.publicFinalValidation.outcome, "primary_valid");
  assert.equal(result.publicFinalValidation.primary.checks.officialDirectFallback, false);
  assert.notEqual(result.answer.answerLevel, "official_confirmed");
  assert.equal(result.answer.shortAnswer, "格式错误");
  assert.doesNotMatch(result.answer.shortAnswer, /可以处理/u);
});
