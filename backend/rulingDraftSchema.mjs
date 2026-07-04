export const RULING_DRAFT_ANSWER_TYPES = Object.freeze([
  "can_activate",
  "cannot_activate",
  "who_can_activate",
  "resolution_result",
  "target_legality",
  "timing_window",
  "card_activation_vs_effect_activation",
  "unknown",
]);

export const RULING_DRAFT_CLAIM_TYPES = Object.freeze([
  "activation_legality",
  "target_legality",
  "timing",
  "chain_resolution",
  "controller",
  "zone_state",
  "card_text",
  "official_evidence",
  "engine_observation",
  "card_activation",
  "effect_activation",
  "cost",
  "condition",
  "resolution_dependency",
  "other",
]);

const CONFIDENCE_SELF_ESTIMATES = new Set(["low", "medium", "high"]);
const FORBIDDEN_FINAL_FIELDS = new Set([
  "finalVerdict",
  "finalLevel",
  "confirmationLevel",
  "safetyLevel",
  "officialConfirmed",
  "official_confirmed",
  "verdict",
  "answerSource",
  "evidenceLevel",
]);
const DEFAULT_ARRAY_FIELDS = [
  "reasoningSteps",
  "claims",
  "usedEvidenceIds",
  "missingFacts",
  "assumptions",
  "riskFlags",
];

export function normalizeRulingDraft(draft) {
  if (!isPlainObject(draft)) return draft;
  const normalized = { ...draft };
  for (const field of DEFAULT_ARRAY_FIELDS) {
    if (normalized[field] === undefined) normalized[field] = [];
    else if (Array.isArray(normalized[field])) normalized[field] = normalized[field].map(cloneEntry);
  }
  return normalized;
}

export function validateRulingDraft(draft) {
  if (!isPlainObject(draft)) {
    return { ok: false, errors: ["rulingDraft must be an object"] };
  }

  const normalized = normalizeRulingDraft(draft);
  const errors = [];
  collectForbiddenFields(normalized, "rulingDraft", errors);

  if (!RULING_DRAFT_ANSWER_TYPES.includes(normalized.answerType)) {
    errors.push("answerType must be a supported ruling draft answer type");
  }
  if (!isNonEmptyString(normalized.mainConclusion)) {
    errors.push("mainConclusion must be a non-empty string");
  }
  if (!CONFIDENCE_SELF_ESTIMATES.has(normalized.confidenceSelfEstimate)) {
    errors.push("confidenceSelfEstimate must be low, medium, or high");
  }

  validateReasoningSteps(normalized.reasoningSteps, errors);
  validateClaims(normalized.claims, errors);
  for (const field of ["usedEvidenceIds", "missingFacts", "assumptions", "riskFlags"]) {
    if (!Array.isArray(normalized[field])) errors.push(`${field} must be an array`);
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, errors: [], normalized };
}

function validateReasoningSteps(steps, errors) {
  if (!Array.isArray(steps)) {
    errors.push("reasoningSteps must be an array");
    return;
  }
  for (const [index, item] of steps.entries()) {
    const path = `reasoningSteps[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof item.step !== "number" || !Number.isFinite(item.step)) errors.push(`${path}.step must be a number`);
    if (!isNonEmptyString(item.text)) errors.push(`${path}.text must be a non-empty string`);
    if (!Array.isArray(item.dependsOn)) errors.push(`${path}.dependsOn must be an array`);
  }
}

function validateClaims(claims, errors) {
  if (!Array.isArray(claims)) {
    errors.push("claims must be an array");
    return;
  }
  for (const [index, claim] of claims.entries()) {
    const path = `claims[${index}]`;
    if (!isPlainObject(claim)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    for (const field of ["id", "subject", "predicate", "object", "timing"]) {
      if (!isNonEmptyString(claim[field])) errors.push(`${path}.${field} must be a non-empty string`);
    }
    if (!RULING_DRAFT_CLAIM_TYPES.includes(claim.type)) errors.push(`${path}.type must be a supported ruling draft claim type`);
    if (claim.source !== "llm_draft") errors.push(`${path}.source must be llm_draft`);
    if (claim.requiresValidation !== true) errors.push(`${path}.requiresValidation must be true`);
  }
}

function collectForbiddenFields(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenFields(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FINAL_FIELDS.has(key)) errors.push(`${path}.${key} is a forbidden final-decision field`);
    collectForbiddenFields(child, `${path}.${key}`, errors);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneEntry(value) {
  if (Array.isArray(value)) return value.map(cloneEntry);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneEntry(child)]));
  return value;
}
