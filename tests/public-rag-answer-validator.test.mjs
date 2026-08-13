import assert from "node:assert/strict";
import test from "node:test";

import {
  runValidatedPublicRagFinal,
  validatePublicRagFinalAnswer,
} from "../backend/publicRagAnswerValidator.mjs";

const evidence = {
  officialQaDirectCandidates: [{ id: "qa-direct", type: "official_qa", title: "匿名直接资料" }],
  faqRelated: [{ id: "faq-related", type: "faq", title: "匿名相关资料" }],
};

function answer(overrides = {}) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer: "这是模型给出的匿名结论。",
    reasoning: ["这是模型给出的匿名理由。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
    ...overrides,
  };
}

test("display adapter never judges ruling polarity or question-type coverage", () => {
  const first = validatePublicRagFinalAnswer(answer({ shortAnswer: "可以。" }), { evidence });
  const second = validatePublicRagFinalAnswer(answer({ shortAnswer: "不可以。" }), { evidence });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.checks.rulingSemantics, "not_evaluated");
  assert.equal(second.checks.rulingSemantics, "not_evaluated");
});

test("unknown citations are dropped instead of being invented or repaired", () => {
  const result = validatePublicRagFinalAnswer(answer({
    usedEvidence: [
      { id: "faq-related", title: "可用" },
      { id: "invented-id", title: "不可用" },
    ],
  }), { evidence });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer.usedEvidence.map((item) => item.id), ["faq-related"]);
  assert.ok(result.diagnosticWarnings.includes("unknown_evidence_reference_dropped"));
});

test("citation authority metadata is rebuilt from the server-side evidence ID", () => {
  const result = validatePublicRagFinalAnswer(answer({
    usedEvidence: [{ id: "faq-related", type: "official_qa", title: "伪造官方标题" }],
  }), { evidence });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer.usedEvidence, [{
    id: "faq-related",
    type: "faq",
    title: "匿名相关资料",
  }]);
});

test("official confirmation is only an authority label and requires a direct citation", () => {
  const missing = validatePublicRagFinalAnswer(answer({ answerLevel: "official_confirmed" }), { evidence });
  assert.equal(missing.answer.answerLevel, "rule_analysis");
  const cited = validatePublicRagFinalAnswer(answer({
    answerLevel: "official_confirmed",
    usedEvidence: [{ id: "qa-direct" }],
  }), { evidence, authoritativeOfficialDirect: "qa-direct" });
  assert.equal(cited.answer.answerLevel, "official_confirmed");
});

test("a near-match candidate cannot regain direct authority during citation cleanup", () => {
  const validation = validatePublicRagFinalAnswer({
    answerLevel: "official_confirmed",
    shortAnswer: "候选答案。",
    reasoning: ["引用了相关资料。"],
    usedCards: [],
    usedEvidence: [{ id: "near-qa" }],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "high",
  }, {
    evidence: {
      officialQaDirectCandidates: [],
      officialQaRelated: [{
        id: "near-qa",
        type: "related",
        title: "语义近似问答",
        text: "相关资料。",
        isDirect: false,
      }],
    },
    authoritativeOfficialDirect: false,
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.answer.answerLevel, "rule_analysis");
  assert.equal(validation.answer.usedEvidence[0].type, "related");
  assert.ok(validation.diagnosticWarnings.includes(
    "official_confirmation_without_direct_citation_downgraded",
  ));
});

test("the final semantic model is invoked exactly once with no repair call", async () => {
  let calls = 0;
  const result = await runValidatedPublicRagFinal({
    originalPrompt: "匿名提示",
    evidence,
    invoke: async ({ prompt, attemptKind }) => {
      calls += 1;
      assert.equal(prompt, "匿名提示");
      assert.equal(attemptKind, "primary");
      return { answer: answer(), warnings: [] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.publicFinalValidation.outcome, "primary_valid");
  assert.equal(result.publicFinalValidation.callCount, 1);
  assert.equal(result.publicFinalValidation.repairAttempted, false);
});

test("provider failures become neutral technical errors rather than local rulings", async () => {
  let calls = 0;
  const result = await runValidatedPublicRagFinal({
    originalPrompt: "匿名提示",
    evidence,
    invoke: async () => {
      calls += 1;
      return {
        answer: answer({ shortAnswer: "不应展示的回退裁定。" }),
        providerFailure: { kind: "timeout" },
        warnings: ["model_call_failed:timeout"],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.answer.answerLevel, "needs_more_info");
  assert.match(result.answer.shortAnswer, /超时/u);
  assert.equal(result.answer.usedEvidence.length, 0);
  assert.equal(result.publicFinalValidation.outcome, "primary_invalid_no_ruling");
});

test("string fields are normalized locally without another model request", () => {
  const result = validatePublicRagFinalAnswer(answer({
    reasoning: "匿名理由",
    usedCards: "匿名卡",
    missingInfo: "匿名缺失信息",
  }), { evidence });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer.reasoning, ["匿名理由"]);
  assert.deepEqual(result.answer.usedCards, ["匿名卡"]);
  assert.deepEqual(result.answer.missingInfo, ["匿名缺失信息"]);
});

test("a safely wrapped natural-language answer remains displayable", () => {
  const result = validatePublicRagFinalAnswer(answer({
    answerLevel: "low_confidence_analysis",
    shortAnswer: "模型直接返回的自然语言结论。",
    riskFlags: ["model_output_not_json"],
  }), {
    evidence,
    modelWarnings: [
      "model_json_parse_failed:unexpected token",
      "model_natural_language_wrapped",
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.answer.shortAnswer, "模型直接返回的自然语言结论。");
});

test("missing answer objects and empty short answers fail to a neutral technical response", async () => {
  const invalidCandidates = [
    null,
    {},
    [],
    answer({ shortAnswer: "   " }),
  ];

  for (const candidate of invalidCandidates) {
    const validation = validatePublicRagFinalAnswer(candidate, { evidence });
    assert.equal(validation.ok, false);
    assert.equal(validation.answer, null);
    assert.ok(validation.errors.includes("model_answer_missing_short_answer"));

    const result = await runValidatedPublicRagFinal({
      originalPrompt: "匿名提示",
      evidence,
      invoke: async () => ({ answer: candidate, warnings: [] }),
    });
    assert.equal(result.answer.answerLevel, "needs_more_info");
    assert.match(result.answer.shortAnswer, /没有返回可展示的完整答案/u);
    assert.deepEqual(result.answer.reasoning, []);
    assert.deepEqual(result.answer.usedEvidence, []);
    assert.ok(result.answer.riskFlags.includes("model_output_not_displayable"));
    assert.equal(result.publicFinalValidation.outcome, "primary_invalid_no_ruling");
  }
});

test("structured provider failures classify access denial and generic failure", async () => {
  const cases = [
    {
      kind: "access_denied",
      answerPattern: /拒绝/u,
      expectedFlag: "model_provider_access_denied",
    },
    {
      kind: "provider_failure",
      answerPattern: /调用失败/u,
      expectedFlag: null,
    },
  ];

  for (const item of cases) {
    const result = await runValidatedPublicRagFinal({
      originalPrompt: "匿名提示",
      evidence,
      invoke: async () => ({
        answer: answer({ shortAnswer: "不得保留的模型裁定。" }),
        providerFailure: { kind: item.kind },
        warnings: [],
      }),
    });
    assert.equal(result.publicFinalValidation.primary.providerFailureKind, item.kind);
    assert.equal(result.answer.answerLevel, "needs_more_info");
    assert.match(result.answer.shortAnswer, item.answerPattern);
    assert.ok(result.answer.riskFlags.includes("model_provider_call_failed"));
    if (item.expectedFlag) {
      assert.ok(result.answer.riskFlags.includes(item.expectedFlag));
    } else {
      assert.equal(result.answer.riskFlags.includes("model_provider_access_denied"), false);
      assert.equal(result.answer.riskFlags.includes("model_provider_timeout"), false);
    }
  }
});

test("legacy provider warning text classifies 401, 403, timeout, and generic failures", () => {
  const cases = [
    ["model_call_failed:HTTP 401 Unauthorized", "access_denied"],
    ["model_call_failed:HTTP 403 Forbidden", "access_denied"],
    ["model_call_failed:ETIMEDOUT while waiting", "timeout"],
    ["model_call_failed:HTTP 504 Gateway Timeout", "timeout"],
    ["model_call_failed:connection reset", "provider_failure"],
  ];

  for (const [warning, expectedKind] of cases) {
    const result = validatePublicRagFinalAnswer(answer(), {
      evidence,
      modelWarnings: [warning],
    });
    assert.equal(result.ok, false, warning);
    assert.equal(result.providerFailureKind, expectedKind, warning);
    assert.ok(result.errors.includes(`model_provider_${expectedKind}`), warning);
  }
});

test("invalid scalar enums and missing arrays are normalized locally", () => {
  const result = validatePublicRagFinalAnswer({
    answerLevel: "invented_level",
    shortAnswer: "仍可展示的匿名结论。",
    confidenceSelfEstimate: "certain",
  }, { evidence });

  assert.equal(result.ok, true);
  assert.equal(result.answer.answerLevel, "low_confidence_analysis");
  assert.equal(result.answer.confidenceSelfEstimate, "low");
  assert.deepEqual(result.answer.reasoning, []);
  assert.deepEqual(result.answer.usedCards, []);
  assert.deepEqual(result.answer.usedEvidence, []);
  assert.deepEqual(result.answer.missingInfo, []);
  assert.deepEqual(result.answer.riskFlags, []);
  assert.ok(result.diagnosticWarnings.includes("answer_level_normalized"));
  assert.ok(result.diagnosticWarnings.includes("confidence_defaulted_low"));
  for (const field of ["reasoning", "usedCards", "missingInfo", "riskFlags"]) {
    assert.ok(
      result.diagnosticWarnings.includes(`${field}_missing_defaulted_empty`),
      field,
    );
  }
});

test("citations are deduplicated by ID before enforcing the twelve-item limit", () => {
  const manyEvidence = {
    faqRelated: Array.from({ length: 14 }, (_unused, index) => ({
      id: `faq-${index}`,
      type: "faq",
      title: `匿名资料 ${index}`,
    })),
  };
  const result = validatePublicRagFinalAnswer(answer({
    usedEvidence: [
      { id: "faq-0" },
      { id: "faq-0" },
      ...Array.from({ length: 13 }, (_unused, index) => ({ id: `faq-${index + 1}` })),
    ],
  }), { evidence: manyEvidence });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.answer.usedEvidence.map((item) => item.id),
    Array.from({ length: 12 }, (_unused, index) => `faq-${index}`),
  );
  assert.equal(new Set(result.answer.usedEvidence.map((item) => item.id)).size, 12);
});

test("all provider attempts are relabeled primary and repair audit stays disabled", async () => {
  const result = await runValidatedPublicRagFinal({
    originalPrompt: "匿名提示",
    evidence,
    invoke: async () => ({
      answer: answer(),
      warnings: [],
      generationAttempts: [
        { attempt: "first", publicAttemptKind: "repair", providerAttempt: 1 },
        { attempt: "second", publicAttemptKind: "legacy", providerAttempt: 2 },
      ],
    }),
  });

  assert.deepEqual(
    result.generationAttempts.map((item) => item.publicAttemptKind),
    ["primary", "primary"],
  );
  assert.deepEqual(
    result.generationAttempts.map((item) => item.providerAttempt),
    [1, 2],
  );
  assert.equal(result.publicFinalValidation.callCount, 1);
  assert.equal(result.publicFinalValidation.repairAttempted, false);
  assert.equal(result.publicFinalValidation.maxRepairAttempts, 0);
  assert.equal(result.publicFinalValidation.repair, null);
});
