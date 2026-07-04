import assert from "node:assert/strict";
import test from "node:test";
import { buildRulingDraftPrompt } from "../backend/rulingDraftPrompt.mjs";
import {
  normalizeRulingDraft,
  validateRulingDraft,
} from "../backend/rulingDraftSchema.mjs";

function validDraft(overrides = {}) {
  return {
    answerType: "can_activate",
    mainConclusion: "倾向于可以发动，但该结论仍需验证。",
    confidenceSelfEstimate: "medium",
    reasoningSteps: [{ step: 1, text: "先检查发动条件。", dependsOn: ["claim-1"] }],
    claims: [{
      id: "claim-1",
      type: "activation_legality",
      subject: "相关效果",
      predicate: "满足",
      object: "发动条件",
      timing: "当前时点",
      source: "llm_draft",
      requiresValidation: true,
    }],
    usedEvidenceIds: ["qa-1"],
    missingFacts: [],
    assumptions: ["场面描述完整"],
    riskFlags: ["尚未经过 validator"],
    ...overrides,
  };
}

test("valid_ruling_draft_passes", () => {
  const result = validateRulingDraft(validDraft());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.claims[0].requiresValidation, true);
});

test("missing_required_fields_fail", () => {
  for (const field of ["answerType", "mainConclusion", "confidenceSelfEstimate"]) {
    const draft = validDraft();
    delete draft[field];
    const result = validateRulingDraft(draft);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((error) => error.includes(field)), field);
  }
});

test("invalid_answer_type_fails", () => {
  const result = validateRulingDraft(validDraft({ answerType: "official_answer" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("answerType")));
});

test("invalid_confidence_fails", () => {
  const result = validateRulingDraft(validDraft({ confidenceSelfEstimate: "official" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("confidenceSelfEstimate")));
});

test("forbidden_final_verdict_fields_fail", () => {
  for (const field of [
    "finalVerdict",
    "finalLevel",
    "confirmationLevel",
    "safetyLevel",
    "officialConfirmed",
    "official_confirmed",
    "verdict",
    "answerSource",
    "evidenceLevel",
  ]) {
    const result = validateRulingDraft(validDraft({ [field]: "forbidden" }));
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((error) => error.includes(field)), field);
  }
});

test("claim_requires_validation_true", () => {
  const draft = validDraft();
  draft.claims[0].requiresValidation = false;
  const result = validateRulingDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("requiresValidation")));
});

test("claim_source_must_be_llm_draft", () => {
  const draft = validDraft();
  draft.claims[0].source = "official_qa";
  const result = validateRulingDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("source")));
});

test("invalid_claim_type_fails", () => {
  const draft = validDraft();
  draft.claims[0].type = "final_decision";
  const result = validateRulingDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("claims[0].type")));
});

test("prompt_contains_safety_constraints", () => {
  const prompt = buildRulingDraftPrompt({
    userQuery: "测试问题",
    officialEvidence: [{ id: "qa-1", text: "测试资料" }],
  });
  for (const required of [
    "JSON",
    "rulingDraft",
    "official_confirmed",
    "finalVerdict",
    "finalLevel",
    "confirmationLevel",
    "safetyLevel",
    "verdict",
    "answerSource",
    "evidenceLevel",
    "claims",
    "missingFacts",
    "assumptions",
    "riskFlags",
    "不得自造 evidenceIds",
  ]) {
    assert.match(prompt, new RegExp(required), required);
  }
  assert.match(prompt, /不是最终裁定/u);
  assert.match(prompt, /只能引用输入资料中明确提供的 id/u);
});

test("normalized_defaults_arrays", () => {
  const input = {
    answerType: "unknown",
    mainConclusion: "现有信息只能形成待验证的倾向。",
    confidenceSelfEstimate: "low",
  };
  const normalized = normalizeRulingDraft(input);
  const result = validateRulingDraft(input);
  for (const field of ["reasoningSteps", "claims", "usedEvidenceIds", "missingFacts", "assumptions", "riskFlags"]) {
    assert.deepEqual(normalized[field], [], field);
    assert.deepEqual(result.normalized[field], [], field);
  }
  assert.equal(result.ok, true);
  assert.notEqual(normalized, input);
});

test("forbidden fields are rejected when nested", () => {
  const draft = validDraft();
  draft.claims[0].verdict = "can_activate";
  const result = validateRulingDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("claims[0].verdict")));
});
