export const MODEL_RULING_SCHEMA_VERSION = "1.0";

export const MODEL_RULING_VERDICT_VALUES = Object.freeze([
  "TRUE",
  "FALSE",
  "CONDITIONAL",
  "UNKNOWN",
]);

export const MODEL_RULING_EVIDENCE_RELATIONS = Object.freeze([
  "DIRECTLY_ENTAILS",
  "DEFINES_TERM",
  "SUPPORTS_STEP",
  "ANALOGOUS_RULING",
  "PARTIAL_SUPPORT",
  "CONTRADICTS",
  "IRRELEVANT",
]);

const MODEL_RULING_EVIDENCE_RELATION_SET = new Set(MODEL_RULING_EVIDENCE_RELATIONS);
const MODEL_RULING_EVIDENCE_RELATION_ALIASES = new Map([
  ["DIRECT_ENTAILS", "DIRECTLY_ENTAILS"],
  ["DIRECT_ENTAILMENT", "DIRECTLY_ENTAILS"],
  ["ENTAILS_DIRECTLY", "DIRECTLY_ENTAILS"],
  ["TERM_DEFINITION", "DEFINES_TERM"],
  ["DEFINES_THE_TERM", "DEFINES_TERM"],
  ["STEP_SUPPORT", "SUPPORTS_STEP"],
  ["SUPPORTS_REASONING_STEP", "SUPPORTS_STEP"],
  ["ANALOGICAL_RULING", "ANALOGOUS_RULING"],
  ["RULING_BY_ANALOGY", "ANALOGOUS_RULING"],
  ["PARTIALLY_SUPPORTS", "PARTIAL_SUPPORT"],
  ["SUPPORTS_PARTIALLY", "PARTIAL_SUPPORT"],
  ["CONTRADICTS_CLAIM", "CONTRADICTS"],
  ["CONFLICTS_WITH_CLAIM", "CONTRADICTS"],
  ["NOT_RELEVANT", "IRRELEVANT"],
  ["UNRELATED_TO_CLAIM", "IRRELEVANT"],
  ["直接蕴含", "DIRECTLY_ENTAILS"],
  ["定义术语", "DEFINES_TERM"],
  ["支持步骤", "SUPPORTS_STEP"],
  ["类比裁定", "ANALOGOUS_RULING"],
  ["部分支持", "PARTIAL_SUPPORT"],
  ["矛盾", "CONTRADICTS"],
  ["无关", "IRRELEVANT"],
]);

export const MODEL_RULING_INFERENCE_TYPES = Object.freeze([
  "DIRECT_OFFICIAL",
  "CARD_TEXT",
  "OFFICIAL_RULE_DERIVATION",
  "ANALOGY",
  "MODEL_SYNTHESIS",
]);

export const MODEL_RULING_CONFIDENCE_LEVELS = Object.freeze([
  "LOW",
  "MEDIUM",
  "HIGH",
]);

export const MODEL_RULING_COUNTER_CHECK_TYPES = Object.freeze([
  "COST_EFFECT_PROCEDURE",
  "ACTIVATION_VS_EFFECT_NEGATION",
  "EVENT_ATTRIBUTION",
  "PRINTED_TEXT_VS_RUNTIME",
  "EFFECT_LIFETIME",
  "RESOLUTION_ORDER",
  "FACE_UP_VS_FACE_DOWN",
  "MONSTER_VS_MONSTER_CARD",
  "OPTIONAL_BRANCH",
  "CHOICE_OWNER",
  "DAMAGE_STEP",
  "EVIDENCE_ENTAILMENT",
  "MISSING_FACT",
]);

const CRITICAL_COUNTER_CHECK_TYPES = new Set([
  "EVIDENCE_ENTAILMENT",
  "MISSING_FACT",
  "RESOLUTION_ORDER",
]);

const verdictSchema = strictObject({
  questionId: nonEmptyString(),
  value: {
    type: "string",
    enum: [...MODEL_RULING_VERDICT_VALUES],
    description: "Answer to the user question as phrased: TRUE=yes, FALSE=no, CONDITIONAL=branch-dependent, UNKNOWN=not decidable from the supplied facts and evidence.",
  },
  conclusion: nonEmptyString(),
  conditions: stringArray(),
});

const claimSchema = strictObject({
  questionId: nonEmptyString(),
  claimId: nonEmptyString(),
  proposition: nonEmptyString(),
  status: {
    type: "string",
    enum: [...MODEL_RULING_VERDICT_VALUES],
    description: "Truth value of proposition itself, independent of verdict.value. A correct proposition such as 'the effect cannot be activated' has status TRUE even when the answer verdict is FALSE. A CONDITIONAL verdict must be supported by decisive branch propositions with status TRUE or FALSE; UNKNOWN or CONDITIONAL claims cannot provide that decisive support.",
  },
  decisive: { type: "boolean" },
  evidenceIds: stringArray(),
  inferenceType: { type: "string", enum: [...MODEL_RULING_INFERENCE_TYPES] },
});

const timelineSchema = strictObject({
  order: { type: "integer", minimum: 1 },
  action: nonEmptyString(),
  result: nonEmptyString(),
  evidenceIds: stringArray(),
});

const assumptionSchema = strictObject({
  statement: nonEmptyString(),
  decisive: { type: "boolean" },
});

const evidenceUsageSchema = strictObject({
  evidenceId: nonEmptyString(),
  relation: { type: "string", enum: [...MODEL_RULING_EVIDENCE_RELATIONS] },
  supportedClaimIds: stringArray(),
});

const counterCheckSchema = strictObject({
  type: { type: "string", enum: [...MODEL_RULING_COUNTER_CHECK_TYPES] },
  passed: { type: "boolean" },
  note: { type: "string" },
});

const unresolvedSchema = strictObject({
  questionId: nonEmptyString(),
  code: nonEmptyString(),
  decisive: { type: "boolean" },
  explanation: nonEmptyString(),
});

const confidenceSchema = strictObject({
  level: { type: "string", enum: [...MODEL_RULING_CONFIDENCE_LEVELS] },
  reasons: stringArray(),
});

export const MODEL_RULING_RESULT_JSON_SCHEMA = deepFreeze(strictObject({
  schemaVersion: { type: "string", enum: [MODEL_RULING_SCHEMA_VERSION] },
  verdicts: {
    type: "array",
    minItems: 1,
    items: verdictSchema,
  },
  conciseAnswer: nonEmptyString(),
  claims: {
    type: "array",
    items: claimSchema,
  },
  timeline: {
    type: "array",
    items: timelineSchema,
  },
  assumptions: {
    type: "array",
    items: assumptionSchema,
  },
  evidenceUsage: {
    type: "array",
    items: evidenceUsageSchema,
  },
  counterChecks: {
    type: "array",
    items: counterCheckSchema,
  },
  unresolved: {
    type: "array",
    items: unresolvedSchema,
  },
  confidence: confidenceSchema,
}));

export function validateModelRulingResult(result, {
  evidenceSnapshot,
  modelVisibleEvidencePacket,
  expectedQuestionIds,
  providedFacts = [],
} = {}) {
  const hardErrors = [];
  const semanticIssues = [];
  validateSchemaShape(result, hardErrors);
  if (hardErrors.length > 0) return validationFailure(hardErrors);

  if (!evidenceSnapshot || typeof evidenceSnapshot !== "object") {
    hardErrors.push("Evidence Snapshot is required for semantic validation");
  }
  if (!Array.isArray(expectedQuestionIds) || expectedQuestionIds.length === 0) {
    hardErrors.push("expectedQuestionIds is required for complete question coverage validation");
  }
  const validatesAgainstModelVisiblePacket = modelVisibleEvidencePacket !== undefined;
  if (validatesAgainstModelVisiblePacket
    && (!isPlainObject(modelVisibleEvidencePacket)
      || !Array.isArray(modelVisibleEvidencePacket.evidenceItems))) {
    hardErrors.push("modelVisibleEvidencePacket.evidenceItems is required for model-visible evidence validation");
  }
  const evidenceIndex = validatesAgainstModelVisiblePacket
    ? buildModelVisibleEvidenceIndex(modelVisibleEvidencePacket)
    : buildEvidenceIndex(evidenceSnapshot);
  const evidenceReferenceScope = validatesAgainstModelVisiblePacket
    ? "model-visible Evidence Packet"
    : "Evidence Snapshot";
  const claimsById = uniqueIndex(result.claims, "claimId", "claims", hardErrors);
  const verdictsByQuestion = uniqueIndex(result.verdicts, "questionId", "verdicts", hardErrors);
  const usageByEvidence = uniqueIndex(result.evidenceUsage, "evidenceId", "evidenceUsage", hardErrors);

  validateQuestionCoverage(verdictsByQuestion, expectedQuestionIds, hardErrors);
  validateEvidenceReferences(result, evidenceIndex, hardErrors, evidenceReferenceScope);
  validateEvidenceUsage(result, claimsById, usageByEvidence, evidenceIndex, hardErrors);
  validateClaims(result, claimsById, usageByEvidence, evidenceIndex, hardErrors);
  validateQuestionScopedReasoning(
    result,
    verdictsByQuestion,
    expectedQuestionIds,
    evidenceIndex,
    hardErrors,
  );
  validateUnknownAndConditional(
    result,
    evidenceSnapshot,
    modelVisibleEvidencePacket,
    providedFacts,
    expectedQuestionIds,
    hardErrors,
    semanticIssues,
  );
  validateDecisiveAssumptions(result, providedFacts, semanticIssues);
  validateTimeline(result.timeline, hardErrors, semanticIssues);
  validateAnswerConsistency(result, semanticIssues);
  validateCounterChecks(result, hardErrors);

  return layeredValidationResult(result, { hardErrors, semanticIssues });
}

export function parseAndValidateModelRulingResult(rawText, options = {}) {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return validationFailure(["model output must be a non-empty JSON string"]);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return validationFailure(["model output is not valid JSON"]);
  }
  const structuralNormalization = options.normalizeStructuralBindings === true
    ? normalizeModelRulingStructuralBindings(parsed, options)
    : { normalized: parsed, corrections: [] };
  const relationNormalization = options.normalizeEvidenceProvenance === true
    ? normalizeModelRulingEvidenceRelationTokens(structuralNormalization.normalized)
    : { normalized: structuralNormalization.normalized, corrections: [] };
  const strictValidation = validateModelRulingResult(relationNormalization.normalized, options);
  if (strictValidation.ok || options.normalizeEvidenceProvenance !== true) {
    return withStructuralCorrections(
      withProvenanceCorrections(strictValidation, relationNormalization.corrections),
      structuralNormalization.corrections,
    );
  }

  const provenance = normalizeModelRulingEvidenceProvenance(
    relationNormalization.normalized,
    options,
  );
  const corrections = [
    ...relationNormalization.corrections,
    ...provenance.corrections,
  ];
  if (provenance.corrections.length === 0) {
    return withStructuralCorrections(
      withProvenanceCorrections(strictValidation, corrections),
      structuralNormalization.corrections,
    );
  }
  const normalizedValidation = validateModelRulingResult(provenance.normalized, options);
  return withStructuralCorrections(
    withProvenanceCorrections(normalizedValidation, corrections),
    structuralNormalization.corrections,
  );
}

/**
 * Repairs only model-generated identifiers and redundant relation indexes.
 * It never changes the answer text, claims, evidence IDs, or evidence
 * relations. Unknown evidence and conflicting duplicate relations therefore
 * continue to fail normal semantic validation.
 */
export function normalizeModelRulingStructuralBindings(result, {
  expectedQuestionIds,
} = {}) {
  const normalized = cloneJson(result);
  const corrections = [];
  if (!isPlainObject(normalized)) return { normalized, corrections };

  normalizeDuplicateVerdictIds(normalized, expectedQuestionIds, corrections);
  normalizeEvidenceUsageIndex(normalized, corrections);
  bindClaimEvidenceUsage(normalized, corrections);
  return { normalized, corrections };
}

function normalizeDuplicateVerdictIds(result, expectedQuestionIds, corrections) {
  if (!Array.isArray(result.verdicts)) return;
  const expected = normalizedExpectedQuestionIds(expectedQuestionIds);
  const groups = new Map();
  for (const verdict of result.verdicts) {
    if (!isPlainObject(verdict) || !isNonEmptyString(verdict.questionId)) continue;
    const questionId = String(verdict.questionId);
    if (!resolveExpectedQuestionParent(questionId, expected)) continue;
    const values = groups.get(questionId) || [];
    values.push(verdict);
    groups.set(questionId, values);
  }
  for (const [questionId, verdicts] of groups.entries()) {
    if (verdicts.length < 2) continue;
    const unique = [];
    const seen = new Set();
    for (const verdict of verdicts) {
      const signature = JSON.stringify(verdict);
      if (seen.has(signature)) {
        const index = result.verdicts.indexOf(verdict);
        if (index >= 0) result.verdicts.splice(index, 1);
        corrections.push({
          kind: "duplicate_verdict_deduplicated",
          questionId,
        });
        continue;
      }
      seen.add(signature);
      unique.push(verdict);
    }
    if (unique.length < 2) continue;
    unique.forEach((verdict, index) => {
      const nextQuestionId = `${questionId}-part-${index + 1}`;
      corrections.push({
        kind: "duplicate_verdict_question_id_disambiguated",
        from: questionId,
        to: nextQuestionId,
      });
      verdict.questionId = nextQuestionId;
    });
  }
}

function normalizeEvidenceUsageIndex(result, corrections) {
  if (!Array.isArray(result.evidenceUsage)) return;
  const groups = new Map();
  for (const usage of result.evidenceUsage) {
    if (!isPlainObject(usage) || !isNonEmptyString(usage.evidenceId)) continue;
    const evidenceId = String(usage.evidenceId);
    const entries = groups.get(evidenceId) || [];
    entries.push(usage);
    groups.set(evidenceId, entries);
  }
  const replacements = new Map();
  for (const [evidenceId, entries] of groups.entries()) {
    if (entries.length < 2) continue;
    const relations = new Set(entries.map((entry) => entry.relation));
    if (relations.size !== 1) continue;
    const merged = cloneJson(entries[0]);
    merged.supportedClaimIds = dedupeStrings(
      entries.flatMap((entry) => (
        Array.isArray(entry.supportedClaimIds) ? entry.supportedClaimIds : []
      )),
    );
    replacements.set(evidenceId, merged);
    corrections.push({
      kind: "duplicate_evidence_usage_merged",
      evidenceId,
      duplicateCount: entries.length,
    });
  }
  if (replacements.size === 0) return;
  const emitted = new Set();
  result.evidenceUsage = result.evidenceUsage.flatMap((usage) => {
    const evidenceId = isPlainObject(usage) && isNonEmptyString(usage.evidenceId)
      ? String(usage.evidenceId)
      : "";
    if (!replacements.has(evidenceId)) return [usage];
    if (emitted.has(evidenceId)) return [];
    emitted.add(evidenceId);
    return [replacements.get(evidenceId)];
  });
}

function bindClaimEvidenceUsage(result, corrections) {
  if (!Array.isArray(result.claims) || !Array.isArray(result.evidenceUsage)) return;
  const usageByEvidence = new Map();
  const duplicateEvidence = new Set();
  for (const usage of result.evidenceUsage) {
    if (!isPlainObject(usage) || !isNonEmptyString(usage.evidenceId)) continue;
    const evidenceId = String(usage.evidenceId);
    if (usageByEvidence.has(evidenceId)) duplicateEvidence.add(evidenceId);
    else usageByEvidence.set(evidenceId, usage);
  }
  for (const evidenceId of duplicateEvidence) usageByEvidence.delete(evidenceId);
  for (const claim of result.claims) {
    if (!isPlainObject(claim) || !isNonEmptyString(claim.claimId)) continue;
    for (const evidenceIdValue of Array.isArray(claim.evidenceIds) ? claim.evidenceIds : []) {
      const evidenceId = String(evidenceIdValue);
      const usage = usageByEvidence.get(evidenceId);
      if (!usage || !Array.isArray(usage.supportedClaimIds)) continue;
      if (usage.supportedClaimIds.includes(String(claim.claimId))) continue;
      usage.supportedClaimIds.push(String(claim.claimId));
      usage.supportedClaimIds = dedupeStrings(usage.supportedClaimIds);
      corrections.push({
        kind: "evidence_usage_claim_binding_added",
        evidenceId,
        claimId: String(claim.claimId),
      });
    }
  }
}

/**
 * Accepts only mechanical spellings of the public enum and a deliberately
 * narrow list of semantically exact aliases. It never guesses from generic
 * values such as SUPPORTS or RELATED and never mutates the parsed result.
 */
function normalizeModelRulingEvidenceRelationTokens(result) {
  const normalized = cloneJson(result);
  const corrections = [];
  if (!isPlainObject(normalized) || !Array.isArray(normalized.evidenceUsage)) {
    return { normalized, corrections };
  }

  normalized.evidenceUsage.forEach((usage, index) => {
    if (!isPlainObject(usage) || typeof usage.relation !== "string") return;
    const token = normalizeEvidenceRelationToken(usage.relation);
    const canonical = MODEL_RULING_EVIDENCE_RELATION_SET.has(token)
      ? token
      : MODEL_RULING_EVIDENCE_RELATION_ALIASES.get(token);
    if (!canonical || usage.relation === canonical) return;
    corrections.push({
      kind: "evidence_relation_token_normalization",
      path: `evidenceUsage[${index}].relation`,
      evidenceId: isNonEmptyString(usage.evidenceId) ? String(usage.evidenceId) : null,
      from: usage.relation.slice(0, 160),
      to: canonical,
      reason: MODEL_RULING_EVIDENCE_RELATION_SET.has(token)
        ? "canonical lexical variant"
        : "approved exact alias",
    });
    usage.relation = canonical;
  });

  return { normalized, corrections };
}

function normalizeEvidenceRelationToken(value) {
  const camelSeparated = String(value)
    .normalize("NFKC")
    .trim()
    .replace(/([A-Z\d]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2");
  return camelSeparated.replace(/[\s-]+/gu, "_").toUpperCase();
}

function withProvenanceCorrections(validation, corrections) {
  return corrections.length > 0
    ? { ...validation, provenanceCorrections: corrections }
    : validation;
}

function withStructuralCorrections(validation, corrections) {
  return corrections.length > 0
    ? { ...validation, structuralCorrections: corrections }
    : validation;
}

/**
 * Deterministically downgrades only evidence provenance labels which claim a
 * stronger status than the frozen packet permits. It never changes verdicts,
 * propositions, timelines, citations, or answer text. Missing/fabricated
 * evidence remains untouched so the normal validator still fails closed.
 */
export function normalizeModelRulingEvidenceProvenance(result, {
  evidenceSnapshot,
  modelVisibleEvidencePacket,
} = {}) {
  const normalized = cloneJson(result);
  const corrections = [];
  if (!isPlainObject(normalized)) return { normalized, corrections };

  const evidenceIndex = modelVisibleEvidencePacket !== undefined
    ? buildModelVisibleEvidenceIndex(modelVisibleEvidencePacket)
    : buildEvidenceIndex(evidenceSnapshot);
  const usageByEvidence = new Map(
    (Array.isArray(normalized.evidenceUsage) ? normalized.evidenceUsage : [])
      .filter((usage) => isPlainObject(usage) && isNonEmptyString(usage.evidenceId))
      .map((usage) => [String(usage.evidenceId), usage]),
  );

  for (const usage of usageByEvidence.values()) {
    if (usage.relation !== "DIRECTLY_ENTAILS") continue;
    const evidence = evidenceIndex.get(String(usage.evidenceId));
    if (!evidence || isEligibleDirectOfficialEvidence(evidence)) continue;
    const nextRelation = conservativeEvidenceRelation(evidence);
    corrections.push({
      kind: "evidence_relation_downgrade",
      evidenceId: String(usage.evidenceId),
      from: usage.relation,
      to: nextRelation,
      reason: evidenceProvenanceReason(evidence),
    });
    usage.relation = nextRelation;
  }

  for (const claim of Array.isArray(normalized.claims) ? normalized.claims : []) {
    if (!isPlainObject(claim) || claim.inferenceType !== "DIRECT_OFFICIAL") continue;
    const citedEvidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    const citedEvidence = citedEvidenceIds
      .map((evidenceId) => evidenceIndex.get(String(evidenceId)))
      .filter(Boolean);
    const allDirect = citedEvidence.length > 0
      && citedEvidence.length === citedEvidenceIds.length
      && citedEvidence.every(isEligibleDirectOfficialEvidence)
      && citedEvidenceIds.every((evidenceId) => (
        usageByEvidence.get(String(evidenceId))?.relation === "DIRECTLY_ENTAILS"
      ));
    if (allDirect || citedEvidence.length === 0) continue;
    const nextInferenceType = conservativeInferenceType(citedEvidence);
    corrections.push({
      kind: "claim_inference_downgrade",
      claimId: String(claim.claimId || ""),
      from: claim.inferenceType,
      to: nextInferenceType,
      reason: "cited evidence is not eligible for a direct-official claim",
    });
    claim.inferenceType = nextInferenceType;
  }

  return { normalized, corrections };
}

function validateSchemaShape(result, errors) {
  if (!isPlainObject(result)) {
    errors.push("result must be an object");
    return;
  }
  assertExactKeys(result, MODEL_RULING_RESULT_JSON_SCHEMA.required, "result", errors);
  if (result.schemaVersion !== MODEL_RULING_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MODEL_RULING_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(result.conciseAnswer)) errors.push("conciseAnswer must be a non-empty string");
  validateObjectArray(result.verdicts, "verdicts", errors, (item, path) => {
    assertExactKeys(item, verdictSchema.required, path, errors);
    assertNonEmptyString(item.questionId, `${path}.questionId`, errors);
    assertEnum(item.value, MODEL_RULING_VERDICT_VALUES, `${path}.value`, errors);
    assertNonEmptyString(item.conclusion, `${path}.conclusion`, errors);
    assertStringArray(item.conditions, `${path}.conditions`, errors);
  }, { minItems: 1 });
  validateObjectArray(result.claims, "claims", errors, (item, path) => {
    assertExactKeys(
      item,
      claimSchema.required.filter((key) => key !== "questionId"),
      path,
      errors,
      ["questionId"],
    );
    if (item.questionId !== undefined) {
      assertNonEmptyString(item.questionId, `${path}.questionId`, errors);
    }
    assertNonEmptyString(item.claimId, `${path}.claimId`, errors);
    assertNonEmptyString(item.proposition, `${path}.proposition`, errors);
    assertEnum(item.status, MODEL_RULING_VERDICT_VALUES, `${path}.status`, errors);
    if (typeof item.decisive !== "boolean") errors.push(`${path}.decisive must be a boolean`);
    assertStringArray(item.evidenceIds, `${path}.evidenceIds`, errors);
    assertEnum(item.inferenceType, MODEL_RULING_INFERENCE_TYPES, `${path}.inferenceType`, errors);
  });
  validateObjectArray(result.timeline, "timeline", errors, (item, path) => {
    assertExactKeys(item, timelineSchema.required, path, errors);
    if (!Number.isInteger(item.order) || item.order < 1) errors.push(`${path}.order must be a positive integer`);
    assertNonEmptyString(item.action, `${path}.action`, errors);
    assertNonEmptyString(item.result, `${path}.result`, errors);
    assertStringArray(item.evidenceIds, `${path}.evidenceIds`, errors);
  });
  validateObjectArray(result.assumptions, "assumptions", errors, (item, path) => {
    assertExactKeys(item, assumptionSchema.required, path, errors);
    assertNonEmptyString(item.statement, `${path}.statement`, errors);
    if (typeof item.decisive !== "boolean") errors.push(`${path}.decisive must be a boolean`);
  });
  validateObjectArray(result.evidenceUsage, "evidenceUsage", errors, (item, path) => {
    assertExactKeys(item, evidenceUsageSchema.required, path, errors);
    assertNonEmptyString(item.evidenceId, `${path}.evidenceId`, errors);
    assertEnum(item.relation, MODEL_RULING_EVIDENCE_RELATIONS, `${path}.relation`, errors);
    assertStringArray(item.supportedClaimIds, `${path}.supportedClaimIds`, errors);
  });
  validateObjectArray(result.counterChecks, "counterChecks", errors, (item, path) => {
    assertExactKeys(item, counterCheckSchema.required, path, errors);
    assertEnum(item.type, MODEL_RULING_COUNTER_CHECK_TYPES, `${path}.type`, errors);
    if (typeof item.passed !== "boolean") errors.push(`${path}.passed must be a boolean`);
    if (typeof item.note !== "string") errors.push(`${path}.note must be a string`);
  });
  validateObjectArray(result.unresolved, "unresolved", errors, (item, path) => {
    assertExactKeys(
      item,
      unresolvedSchema.required.filter((key) => key !== "questionId"),
      path,
      errors,
      ["questionId"],
    );
    if (item.questionId !== undefined) {
      assertNonEmptyString(item.questionId, `${path}.questionId`, errors);
    }
    assertNonEmptyString(item.code, `${path}.code`, errors);
    if (typeof item.decisive !== "boolean") errors.push(`${path}.decisive must be a boolean`);
    assertNonEmptyString(item.explanation, `${path}.explanation`, errors);
  });
  if (!isPlainObject(result.confidence)) {
    errors.push("confidence must be an object");
  } else {
    assertExactKeys(result.confidence, confidenceSchema.required, "confidence", errors);
    assertEnum(result.confidence.level, MODEL_RULING_CONFIDENCE_LEVELS, "confidence.level", errors);
    assertStringArray(result.confidence.reasons, "confidence.reasons", errors);
  }
}

function validateQuestionCoverage(verdictsByQuestion, expectedQuestionIds, errors) {
  if (!Array.isArray(expectedQuestionIds)) return;
  const expected = normalizedExpectedQuestionIds(expectedQuestionIds);
  for (const questionId of expected) {
    const covered = [...verdictsByQuestion.keys()].some(
      (candidate) => resolveExpectedQuestionParent(candidate, expected) === questionId,
    );
    if (!covered) errors.push(`missing verdict for questionId: ${questionId}`);
  }
  for (const questionId of verdictsByQuestion.keys()) {
    if (!resolveExpectedQuestionParent(questionId, expected)) {
      errors.push(`unexpected verdict questionId: ${questionId}`);
    }
  }
}

function validateEvidenceReferences(result, evidenceIndex, errors, evidenceReferenceScope) {
  const references = [];
  for (const claim of result.claims) {
    for (const evidenceId of claim.evidenceIds) references.push(["claim", claim.claimId, evidenceId]);
  }
  for (const item of result.timeline) {
    for (const evidenceId of item.evidenceIds) references.push(["timeline", String(item.order), evidenceId]);
  }
  for (const item of result.evidenceUsage) references.push(["evidenceUsage", item.evidenceId, item.evidenceId]);

  for (const [kind, owner, evidenceId] of references) {
    if (!evidenceIndex.has(evidenceId)) {
      errors.push(`${kind} ${owner} references evidenceId not present in ${evidenceReferenceScope}: ${evidenceId}`);
    }
  }
}

function validateEvidenceUsage(result, claimsById, usageByEvidence, evidenceIndex, errors) {
  for (const usage of result.evidenceUsage) {
    for (const claimId of usage.supportedClaimIds) {
      if (!claimsById.has(claimId)) {
        errors.push(`evidenceUsage ${usage.evidenceId} references unknown claimId: ${claimId}`);
      }
    }
  }

  for (const claim of result.claims) {
    for (const evidenceId of claim.evidenceIds) {
      const usage = usageByEvidence.get(evidenceId);
      if (!usage) {
        errors.push(`claim ${claim.claimId} cites ${evidenceId} without evidenceUsage`);
        continue;
      }
      if (!usage.supportedClaimIds.includes(claim.claimId)) {
        errors.push(`evidenceUsage ${evidenceId} does not list claim ${claim.claimId}`);
      }
      if (claim.decisive && usage.relation === "IRRELEVANT") {
        errors.push(`IRRELEVANT evidence ${evidenceId} cannot support decisive claim ${claim.claimId}`);
      }
    }
  }

  for (const [evidenceId, usage] of usageByEvidence.entries()) {
    if (usage.relation === "DIRECTLY_ENTAILS") {
      const evidence = evidenceIndex.get(evidenceId);
      if (evidence?.bodyExcerpted === true) {
        errors.push(`excerpted evidence ${evidenceId} cannot DIRECTLY_ENTAIL`);
      }
      if (evidence && !isDirectOfficialEvidence(evidence)) {
        errors.push(`evidence ${evidenceId} is not direct official material and cannot DIRECTLY_ENTAIL`);
      }
    }
  }
}

function validateClaims(result, claimsById, usageByEvidence, evidenceIndex, errors) {
  for (const claim of claimsById.values()) {
    if (claim.decisive && claim.evidenceIds.length === 0) {
      errors.push(`decisive claim ${claim.claimId} must cite at least one evidenceId`);
    }
    if (claim.decisive && claim.evidenceIds.length > 0) {
      const hasSupportingRelation = claim.evidenceIds.some((evidenceId) => [
        "DIRECTLY_ENTAILS",
        "DEFINES_TERM",
        "SUPPORTS_STEP",
        "ANALOGOUS_RULING",
        "PARTIAL_SUPPORT",
      ].includes(usageByEvidence.get(evidenceId)?.relation));
      if (!hasSupportingRelation) {
        errors.push(`decisive claim ${claim.claimId} has no supporting evidence relation`);
      }
    }
    if (claim.inferenceType === "DIRECT_OFFICIAL") {
      if (claim.evidenceIds.length === 0) {
        errors.push(`DIRECT_OFFICIAL claim ${claim.claimId} must cite direct official evidence`);
      }
      for (const evidenceId of claim.evidenceIds) {
        const evidence = evidenceIndex.get(evidenceId);
        if (evidence?.bodyExcerpted === true) {
          errors.push(`DIRECT_OFFICIAL claim ${claim.claimId} cites excerpted evidence: ${evidenceId}`);
        }
        if (evidence && !isDirectOfficialEvidence(evidence)) {
          errors.push(`DIRECT_OFFICIAL claim ${claim.claimId} cites non-direct evidence: ${evidenceId}`);
        }
        const relation = usageByEvidence.get(evidenceId)?.relation;
        if (relation && relation !== "DIRECTLY_ENTAILS") {
          errors.push(`DIRECT_OFFICIAL claim ${claim.claimId} must use DIRECTLY_ENTAILS evidence`);
        }
      }
    }
  }

}

function validateQuestionScopedReasoning(
  result,
  verdictsByQuestion,
  expectedQuestionIds,
  evidenceIndex,
  errors,
) {
  const questionIds = questionIdUniverse(result, expectedQuestionIds);
  const expected = normalizedExpectedQuestionIds(expectedQuestionIds);
  const claimsByQuestion = scopedItemsByQuestion(
    result.claims,
    questionIds,
    "claim",
    errors,
  );
  const unresolvedByQuestion = scopedItemsByQuestion(
    result.unresolved,
    questionIds,
    "unresolved item",
    errors,
  );

  for (const [questionId, claims] of claimsByQuestion.entries()) {
    const isCoveredParent = expected.includes(questionId)
      && [...verdictsByQuestion.keys()].some(
        (candidate) => resolveExpectedQuestionParent(candidate, expected) === questionId,
      );
    if (!verdictsByQuestion.has(questionId) && !isCoveredParent) {
      errors.push(`claim references unknown questionId: ${questionId}`);
    }
  }
  for (const [questionId] of unresolvedByQuestion.entries()) {
    const isCoveredParent = expected.includes(questionId)
      && [...verdictsByQuestion.keys()].some(
        (candidate) => resolveExpectedQuestionParent(candidate, expected) === questionId,
      );
    if (!verdictsByQuestion.has(questionId) && !isCoveredParent) {
      errors.push(`unresolved item references unknown questionId: ${questionId}`);
    }
  }

  for (const verdict of result.verdicts) {
    const questionClaims = scopedItemsForVerdict(
      claimsByQuestion,
      verdict.questionId,
      expected,
    );
    const decisiveClaims = questionClaims.filter((claim) => claim.decisive);
    const decisiveUnknownClaims = decisiveClaims.filter((claim) => claim.status === "UNKNOWN");
    const decisiveUnresolved = scopedItemsForVerdict(
      unresolvedByQuestion,
      verdict.questionId,
      expected,
    )
      .filter((item) => item.decisive);

    if (verdict.value !== "UNKNOWN") {
      const supportedDecisiveClaims = decisiveClaims.filter((claim) => (
        claimStatusCanSupportVerdict(claim.status, verdict.value)
        && claim.evidenceIds.length > 0
        && claim.evidenceIds.some((evidenceId) => evidenceIndex.has(evidenceId))
      ));
      if (supportedDecisiveClaims.length === 0) {
        const requiredStatus = verdict.value === "CONDITIONAL"
          ? "TRUE or FALSE branch claim"
          : "TRUE claim";
        errors.push(
          `${verdict.value} verdict ${verdict.questionId} must have at least one decisive ${requiredStatus} with model-visible evidence`,
        );
      }
      if (decisiveUnknownClaims.length > 0) {
        errors.push(
          `${verdict.value} verdict ${verdict.questionId} cannot depend on a decisive UNKNOWN claim`,
        );
      }
      if (decisiveUnresolved.length > 0) {
        errors.push(
          `${verdict.value} verdict ${verdict.questionId} cannot retain a decisive unresolved item`,
        );
      }
    }
  }
}

function validateUnknownAndConditional(
  result,
  evidenceSnapshot,
  modelVisibleEvidencePacket,
  providedFacts,
  expectedQuestionIds,
  hardErrors,
  semanticIssues,
) {
  const evidenceCompleteness = assessEvidenceCompleteness(
    evidenceSnapshot,
    modelVisibleEvidencePacket,
  );
  const knownFacts = buildKnownFactContext({
    evidenceSnapshot,
    modelVisibleEvidencePacket,
    providedFacts,
  });
  const questionIds = questionIdUniverse(result, expectedQuestionIds);
  const expected = normalizedExpectedQuestionIds(expectedQuestionIds);
  const claimsByQuestion = scopedItemsByQuestion(result.claims, questionIds);
  const unresolvedByQuestion = scopedItemsByQuestion(result.unresolved, questionIds);
  for (const verdict of result.verdicts) {
    if (verdict.value === "CONDITIONAL" && verdict.conditions.length === 0) {
      hardErrors.push(`CONDITIONAL verdict ${verdict.questionId} must list conditions`);
    }
    if (verdict.value === "CONDITIONAL") {
      const vagueConditions = verdict.conditions.filter((condition) => !isSpecificBranchCondition(condition));
      if (vagueConditions.length > 0) {
        semanticIssues.push(`CONDITIONAL verdict ${verdict.questionId} must list concrete, checkable branch conditions`);
      }
    }
    if (verdict.value === "UNKNOWN") {
      const decisiveUnresolved = scopedItemsForVerdict(
        unresolvedByQuestion,
        verdict.questionId,
        expected,
      )
        .filter((item) => item.decisive);
      const hasDecisiveUnknown = scopedItemsForVerdict(
        claimsByQuestion,
        verdict.questionId,
        expected,
      )
        .some((claim) => claim.decisive && claim.status === "UNKNOWN")
        || decisiveUnresolved.length > 0;
      if (!hasDecisiveUnknown) {
        hardErrors.push(`UNKNOWN verdict ${verdict.questionId} must identify a decisive unresolved item`);
      }
      if (decisiveUnresolved.length === 0) {
        hardErrors.push(`UNKNOWN verdict ${verdict.questionId} must describe the decisive missing fact in unresolved`);
      } else if (decisiveUnresolved.some((item) => !isSpecificMissingFact(item))) {
        semanticIssues.push(`UNKNOWN verdict ${verdict.questionId} must name a concrete decisive missing fact, not generic insufficient information`);
      }
      const alreadyProvided = decisiveUnresolved.find(
        (item) => isClaimedMissingFactAlreadyProvided(item, knownFacts),
      );
      if (alreadyProvided) {
        semanticIssues.push(
          `UNKNOWN verdict ${verdict.questionId} claims a missing fact that is already present in the question, provided facts, or model-visible evidence: ${alreadyProvided.explanation}`,
        );
      }
      if (evidenceCompleteness.sufficientForAntiRefusal
        && decisiveUnresolved.some((item) => isRetrievalOnlyGap(item))) {
        semanticIssues.push(`UNKNOWN verdict ${verdict.questionId} cannot claim a generic retrieval or evidence gap when Evidence Snapshot completeness is sufficient`);
      }
    }
  }
}

function assessEvidenceCompleteness(snapshot, modelVisibleEvidencePacket) {
  const evidenceRoot = isPlainObject(snapshot?.evidence) ? snapshot.evidence : snapshot;
  const completeness = isPlainObject(evidenceRoot?.completeness)
    ? evidenceRoot.completeness
    : (isPlainObject(snapshot?.completeness) ? snapshot.completeness : null);
  if (!completeness) return { sufficientForAntiRefusal: false };

  const allCardsResolved = completeness.allCardNamesResolved === true
    || (
      hasOwn(completeness, "unresolvedMentionCount")
      && hasOwn(completeness, "ambiguousMentionCount")
      && completeness.unresolvedMentionCount === 0
      && completeness.ambiguousMentionCount === 0
    );
  const conflicts = arrayAt(evidenceRoot, "conflicts");
  const noConflicts = completeness.conflictCount === 0
    && (conflicts === null || conflicts.length === 0);
  const retrievalWarnings = arrayAt(evidenceRoot, "retrievalWarnings");
  const truncationWarnings = arrayAt(completeness, "retrievalTruncationWarnings");
  const noRetrievalCoverageFailures = retrievalWarnings !== null
    && retrievalWarnings.filter(isEvidenceCoverageRiskWarning).length === 0
    && truncationWarnings !== null
    && truncationWarnings.length === 0;
  const retrievalComplete = completeness.completeWithinRetrieverCandidateSet === true;
  const visibleEvidenceIndex = modelVisibleEvidencePacket !== undefined
    ? buildModelVisibleEvidenceIndex(modelVisibleEvidencePacket)
    : buildEvidenceIndex(snapshot);
  const hasRelevantRulingEvidence = [...visibleEvidenceIndex.values()]
    .some(isRelevantRulingEvidence);
  const visiblePacketHasCoverageRisk = hasModelVisibleCoverageRisk(
    modelVisibleEvidencePacket,
  );

  return {
    sufficientForAntiRefusal: allCardsResolved
      && noConflicts
      && noRetrievalCoverageFailures
      && retrievalComplete
      && hasRelevantRulingEvidence
      && !visiblePacketHasCoverageRisk,
  };
}

function hasModelVisibleCoverageRisk(packet) {
  if (!isPlainObject(packet)) return false;
  const completeness = isPlainObject(packet.completeness) ? packet.completeness : {};
  const omissionSummary = isPlainObject(packet.omissionSummary) ? packet.omissionSummary : {};
  const truncationSummary = isPlainObject(packet.truncationSummary) ? packet.truncationSummary : {};
  const sourceCoverage = normalizeMachineToken(completeness.sourceCoverage);
  return completeness.decisionPacketTruncated === true
    || Number(omissionSummary.omittedSubstanceCount || 0) > 0
    || Number(truncationSummary.excerptedSubstanceCount || 0) > 0
    || (packet.evidenceItems || []).some((item) => item?.bodyExcerpted === true)
    || sourceCoverage === "unknown"
    || completeness.decisiveMechanismCoverageComplete === false;
}

function isSpecificMissingFact(item) {
  const explanation = String(item?.explanation || "").trim();
  const code = normalizeMachineToken(item?.code);
  if (!explanation || GENERIC_UNRESOLVED_CODES.has(code)) return false;
  const normalized = normalizeComparableText(explanation);
  if (!normalized || GENERIC_MISSING_FACT_TEXTS.has(normalized)) return false;
  if (GENERIC_MISSING_FACT_PATTERNS.some((pattern) => pattern.test(explanation))) return false;

  const hasMissingMarker = /(?:未(?:说明|提供|给出|记载|明确|确定|确认|检索到)|没有(?:说明|提供|给出|明确)|缺少|缺失|未知|不明|需要(?:说明|提供|确认|确定|知道)|需(?:说明|提供|确认|确定|知道)|取决于|whether|which|what|who|where|when|not\s+(?:specified|provided|known)|missing)/iu
    .test(explanation);
  if (!hasMissingMarker) return false;

  const detail = missingFactDetail(explanation);
  return detail.length >= 4;
}

function missingFactDetail(explanation) {
  return String(explanation || "")
    .replace(/(?:当前|现有|所给|提供的|输入的|快照中的)/giu, "")
    .replace(/(?:资料|信息|证据|依据|数据|检索结果|决定性事实|具体事实|事实)/giu, "")
    .replace(/(?:未(?:说明|提供|给出|记载|明确|确定|确认|检索到)|没有(?:说明|提供|给出|明确)|缺少|缺失|未知|不明|无法(?:判断|确认|确定)|不能(?:判断|确认|确定)|需要(?:说明|提供|确认|确定|知道)|需(?:说明|提供|确认|确定|知道)|取决于)/giu, "")
    .replace(/(?:insufficient|information|evidence|data|unknown|undetermined|cannot\s+determine|not\s+(?:specified|provided|known)|missing|whether|which|what|who|where|when)/giu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function buildKnownFactContext({
  evidenceSnapshot,
  modelVisibleEvidencePacket,
  providedFacts,
}) {
  const questionTexts = [];
  const evidenceTexts = [];
  appendStringValues(questionTexts, providedFacts);
  appendStringValues(questionTexts, evidenceSnapshot?.question);
  appendStringValues(questionTexts, evidenceSnapshot?.questions);
  appendStringValues(questionTexts, evidenceSnapshot?.evidence?.questions);
  appendStringValues(questionTexts, evidenceSnapshot?.evidence?.providedFacts);

  if (modelVisibleEvidencePacket !== undefined) {
    for (const item of modelVisibleEvidencePacket?.evidenceItems || []) {
      appendStringValues(evidenceTexts, item?.body);
    }
  } else {
    collectKnownEvidenceText(evidenceSnapshot, evidenceTexts, new Set());
  }
  return {
    question: questionTexts.join("\n"),
    evidence: evidenceTexts.join("\n"),
  };
}

function appendStringValues(output, value) {
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => appendStringValues(output, item));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of ["text", "question", "statement", "value"]) {
    if (typeof value[key] === "string" && value[key].trim()) output.push(value[key]);
  }
}

function collectKnownEvidenceText(value, output, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectKnownEvidenceText(item, output, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && KNOWN_EVIDENCE_TEXT_FIELDS.has(normalizeMachineToken(key))) {
      if (child.trim()) output.push(child);
    } else if (child && typeof child === "object") {
      collectKnownEvidenceText(child, output, seen);
    }
  }
}

function isClaimedMissingFactAlreadyProvided(item, knownFacts) {
  const explanation = String(item?.explanation || "");
  const detail = normalizeComparableText(missingFactDetail(explanation));
  const question = normalizeComparableText(knownFacts.question);
  const evidence = normalizeComparableText(knownFacts.evidence);
  if (detail.length >= 4 && (question.includes(detail) || evidence.includes(detail))) {
    return true;
  }

  const quotedEntities = [...explanation.matchAll(/[「『【]([^」』】]{2,80})[」』】]/gu)]
    .map((match) => normalizeComparableText(match[1]))
    .filter(Boolean);
  const entityAppears = quotedEntities.length === 0
    || quotedEntities.every((entity) => question.includes(entity));
  if (!entityAppears) return false;
  return MISSING_GAME_STATE_FACTS.some(({ requested, supplied }) => (
    requested.test(explanation) && supplied.test(knownFacts.question)
  ));
}

function isEvidenceCoverageRiskWarning(value) {
  return /(?:truncated|limited|limit_exceeded|candidate_pool_incomplete|card_text_section_missing|resolved_card_text_not_found|retrieval_failed|retrieval_error|timeout|unavailable|not_resolved|unresolved|ambiguous)/iu
    .test(String(value || ""));
}

function isSpecificBranchCondition(condition) {
  const text = String(condition || "").trim();
  if (!text) return false;
  const normalized = normalizeComparableText(text);
  if (GENERIC_CONDITION_TEXTS.has(normalized)) return false;
  if (/(?:视情况而定|根据实际情况|取决于情况|资料充分|信息充分|证据充分|if\s+(?:applicable|possible)|depending\s+on\s+the\s+circumstances)/iu.test(text)) {
    return false;
  }
  return normalized.length >= 4;
}

function isRetrievalOnlyGap(item) {
  const combined = `${item?.code || ""} ${item?.explanation || ""}`;
  const mentionsRetrieval = /(?:资料|证据|依据|数据|检索|搜索|查询|FAQ|Q&A|数据库|快照|retriev|evidence|source|database)/iu.test(combined);
  const namesConcreteScenarioFact = /(?:表示形式|控制者|控制权|所在区域|位置|是否发动|是否适用|连锁|时点|回合玩家|对象|代价|素材|种族|属性|等级|阶级|连接值|攻击力|守备力|face[- ]?(?:up|down)|position|controller|zone|chain|timing|target|cost|material)/iu.test(combined);
  return mentionsRetrieval && !namesConcreteScenarioFact;
}

function isRelevantRulingEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return false;
  if (evidence.relevant === false || evidence.relevance === "IRRELEVANT" || evidence.relation === "IRRELEVANT") {
    return false;
  }
  const sourceType = normalizeMachineToken(
    evidence.sourceType || evidence.recordType || evidence.type || evidence.category || "",
  );
  if (/(?:card_?text|card_?faq|official_?qa|official_?database|official_?response|official_?rule|rulebook|rule_?passage|ruling)/u.test(sourceType)) {
    return true;
  }
  return Boolean(
    (evidence.cardNames || evidence.cardId || evidence.passcode)
    && (evidence.effectText || evidence.pendulumEffect || evidence.text),
  );
}

function validateDecisiveAssumptions(result, providedFacts, semanticIssues) {
  if (!Array.isArray(providedFacts) || providedFacts.length === 0) return;
  const normalizedFacts = providedFacts.map(normalizeComparableText);
  for (const assumption of result.assumptions) {
    if (!assumption.decisive) continue;
    const normalizedAssumption = normalizeComparableText(assumption.statement);
    const supported = normalizedFacts.some((fact) => fact.includes(normalizedAssumption)
      || normalizedAssumption.includes(fact));
    if (!supported) {
      semanticIssues.push(`decisive assumption is not present in provided facts: ${assumption.statement}`);
    }
  }
}

function validateTimeline(timeline, hardErrors, semanticIssues) {
  const orders = new Set();
  for (const item of timeline) {
    if (orders.has(item.order)) hardErrors.push(`timeline order must be unique: ${item.order}`);
    orders.add(item.order);
    const kinds = detectOperationKinds(item.action);
    if (kinds.size > 1) {
      semanticIssues.push(`timeline operation ${item.order} is classified as mutually exclusive kinds: ${[...kinds].join(", ")}`);
    }
  }
  const sorted = [...orders].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index] !== index + 1) {
      hardErrors.push("timeline order must be contiguous and start at 1");
      break;
    }
  }
  validateExplicitChainResolutionOrder(timeline, semanticIssues);
}

function validateExplicitChainResolutionOrder(timeline, errors) {
  let previousChainLink = null;
  for (const item of [...timeline].sort((left, right) => left.order - right.order)) {
    const text = `${item.action}\n${item.result}`.normalize("NFKC");
    if (/(?:另开|另起|新(?:的)?|下一(?:组|条)?)(?:连锁|chain)/iu.test(text)) {
      previousChainLink = null;
    }
    for (const chainLink of extractExplicitResolvedChainLinks(text)) {
      if (previousChainLink !== null && chainLink > previousChainLink) {
        errors.push(
          `timeline resolves chain links in forward order: C${previousChainLink} before C${chainLink}`,
        );
        return;
      }
      previousChainLink = chainLink;
    }
  }
}

function extractExplicitResolvedChainLinks(value) {
  const matches = [];
  const patterns = [
    /(?:连锁|chain|c)\s*([1-9]\d*)[^。；;\n]{0,24}?(?:处理|结算|解決|resolve(?:d|s|ing)?)/giu,
    /(?:处理|结算|解決|resolve(?:d|s|ing)?)[^。；;\n]{0,24}?(?:连锁|chain|c)\s*([1-9]\d*)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of String(value || "").matchAll(pattern)) {
      const nearby = String(value || "").slice(
        Math.max(0, (match.index ?? 0) - 8),
        (match.index ?? 0) + match[0].length + 12,
      );
      if (/(?:处理|結算|结算|解決|resolve|resolution).{0,4}(?:顺序|順序|先后|先後|order)/iu.test(nearby)) {
        continue;
      }
      const chainLink = Number(match[1]);
      if (Number.isInteger(chainLink) && chainLink > 0) {
        matches.push({ index: match.index ?? 0, chainLink });
      }
    }
  }
  matches.sort((left, right) => left.index - right.index);
  return matches
    .map((item) => item.chainLink)
    .filter((chainLink, index, all) => index === 0 || chainLink !== all[index - 1]);
}

function validateAnswerConsistency(result, semanticIssues) {
  if (result.verdicts.length === 1) {
    const verdict = result.verdicts[0];
    const polarity = detectAnswerPolarity(result.conciseAnswer)
      || detectAnswerPolarity(verdict.conclusion);
    if (verdict.value === "TRUE" && polarity === "negative") {
      semanticIssues.push("TRUE verdict contradicts conciseAnswer");
    }
    if (verdict.value === "FALSE" && polarity === "positive") {
      semanticIssues.push("FALSE verdict contradicts conciseAnswer");
    }
  }
  const combined = `${result.conciseAnswer}\n${result.claims.map((claim) => claim.proposition).join("\n")}`;
  if (/(?:未找到|没找到|未检索到|没有检索到).{0,30}(?:FAQ|Q&A|裁定).{0,30}(?:所以|因此|故).{0,20}(?:不能|不可以|不得)/iu.test(combined)) {
    semanticIssues.push("absence of a retrieved FAQ cannot prove a negative ruling");
  }
  if (/(?:系统|模型|资料库).{0,20}(?:不知道|未知|未实现).{0,30}(?:所以|因此|故).{0,20}(?:不能|不可以|不得)/iu.test(combined)) {
    semanticIssues.push("system UNKNOWN cannot be converted into a rule-level prohibition");
  }
}

function validateCounterChecks(result, errors) {
  const { counterChecks } = result;
  const seen = new Set();
  for (const check of counterChecks) {
    if (seen.has(check.type)) errors.push(`counterChecks contains duplicate type: ${check.type}`);
    seen.add(check.type);
  }
  for (const requiredType of MODEL_RULING_COUNTER_CHECK_TYPES) {
    if (!seen.has(requiredType)) errors.push(`counterChecks is missing required type: ${requiredType}`);
  }
  const hasDeterminateVerdict = result.verdicts.some((verdict) => verdict.value !== "UNKNOWN");
  if (hasDeterminateVerdict) {
    for (const check of counterChecks) {
      if (CRITICAL_COUNTER_CHECK_TYPES.has(check.type) && check.passed === false) {
        errors.push(
          `determinate verdict cannot pass with failed critical counterCheck: ${check.type}`,
        );
      }
    }
  }
}

function buildEvidenceIndex(snapshot) {
  const index = new Map();
  if (!snapshot) return index;
  collectEvidence(snapshot, index, new Set());
  return index;
}

function buildModelVisibleEvidenceIndex(packet) {
  const index = new Map();
  if (!isPlainObject(packet) || !Array.isArray(packet.evidenceItems)) return index;
  for (const evidence of packet.evidenceItems) {
    if (!isPlainObject(evidence) || !looksLikeEvidenceRecord(evidence)) continue;
    const evidenceIds = [
      evidence.evidenceId,
      ...(Array.isArray(evidence.evidenceIds) ? evidence.evidenceIds : []),
    ];
    for (const evidenceId of evidenceIds) {
      const normalizedId = stringOrEmpty(evidenceId);
      if (normalizedId) index.set(normalizedId, evidence);
    }
  }
  return index;
}

function collectEvidence(value, index, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectEvidence(item, index, seen));
    return;
  }
  const evidenceId = stringOrEmpty(value.evidenceId || value.id);
  if (evidenceId && looksLikeEvidenceRecord(value)) index.set(evidenceId, value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "raw" || key === "debug") continue;
    collectEvidence(child, index, seen);
  }
}

function looksLikeEvidenceRecord(value) {
  return Boolean(value.sourceType || value.recordType || value.type || value.conclusion
    || value.question || value.answer || value.text || value.body || value.content
    || value.category || value.authority || value.url || value.sourceUrl);
}

function isDirectOfficialEvidence(evidence) {
  const sourceType = String(
    evidence?.sourceType
      || evidence?.recordType
      || evidence?.type
      || evidence?.category
      || "",
  ).toLowerCase();
  return [
    "official_qa",
    "card_faq",
    "official_database",
    "official_response",
    "direct_official_qa",
  ].includes(sourceType)
    && (!evidence?.authority || evidence.authority === "official")
    && evidence?.current !== false
    && evidence?.stale !== true
    && evidence?.superseded !== true
    && evidence?.direct !== false
    && evidence?.isDirect !== false;
}

function isEligibleDirectOfficialEvidence(evidence) {
  return evidence?.bodyExcerpted !== true && isDirectOfficialEvidence(evidence);
}

function conservativeEvidenceRelation(evidence) {
  const category = normalizeMachineToken(
    evidence?.category || evidence?.sourceType || evidence?.recordType || evidence?.type,
  );
  if (/(?:parsed_)?card_text|resolved_card/u.test(category)) return "SUPPORTS_STEP";
  if (evidence?.authority === "official" || /qa|faq|ruling|official/u.test(category)) {
    return "ANALOGOUS_RULING";
  }
  return "PARTIAL_SUPPORT";
}

function conservativeInferenceType(evidenceItems) {
  const categories = evidenceItems.map((evidence) => normalizeMachineToken(
    evidence?.category || evidence?.sourceType || evidence?.recordType || evidence?.type,
  ));
  if (categories.length > 0
    && categories.every((category) => /(?:parsed_)?card_text|resolved_card/u.test(category))) {
    return "CARD_TEXT";
  }
  if (evidenceItems.some((evidence, index) => (
    evidence?.authority === "official" || /qa|faq|ruling|official/u.test(categories[index])
  ))) {
    return "OFFICIAL_RULE_DERIVATION";
  }
  return "MODEL_SYNTHESIS";
}

function evidenceProvenanceReason(evidence) {
  if (evidence?.bodyExcerpted === true) return "evidence body is excerpted";
  if (evidence?.direct === false || evidence?.isDirect === false) {
    return "evidence packet marks the item as non-direct";
  }
  if (evidence?.current === false || evidence?.stale === true || evidence?.superseded === true) {
    return "evidence is not current";
  }
  return "evidence category is not direct official material";
}

function detectOperationKinds(text) {
  const source = String(text || "");
  const matches = new Set();
  const groups = [
    ["ACTIVATION_COST", /(?:ACTIVATION_COST|发动代价|發動代價|発動コスト)/iu],
    ["EFFECT_RESOLUTION", /(?:EFFECT_RESOLUTION|效果处理|效果處理|効果処理)/iu],
    ["SUMMON_PROCEDURE", /(?:SUMMON_PROCEDURE|召唤手续|召喚手續|特殊召唤手续|特殊召喚手續|召喚手順)/iu],
    ["RULE_PROCEDURE", /(?:RULE_PROCEDURE|规则处理|規則處理|ルール処理)/iu],
    ["CARD_ACTIVATION", /(?:CARD_ACTIVATION|卡的发动|卡片发动|カードの発動)/iu],
    ["EFFECT_ACTIVATION", /(?:EFFECT_ACTIVATION|效果发动|効果の発動)/iu],
  ];
  for (const [kind, pattern] of groups) {
    if (pattern.test(source)) matches.add(kind);
  }
  return matches;
}

function detectAnswerPolarity(text) {
  const source = String(text || "").normalize("NFKC");
  const candidates = [];
  for (const [polarity, patterns] of ANSWER_POLARITY_PATTERNS) {
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (match) candidates.push({ polarity, index: match.index, length: match[0].length });
    }
  }
  candidates.sort((left, right) => left.index - right.index || right.length - left.length);
  return candidates[0]?.polarity || "";
}

function questionIdUniverse(result, expectedQuestionIds) {
  const expected = normalizedExpectedQuestionIds(expectedQuestionIds);
  const source = expected.length > 0
    ? [...expected, ...result.verdicts.map((verdict) => verdict.questionId)]
    : result.verdicts.map((verdict) => verdict.questionId);
  return [...new Set(source.map(String))];
}

function normalizedExpectedQuestionIds(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter(isNonEmptyString)
      .map(String),
  )];
}

function resolveExpectedQuestionParent(questionId, expectedQuestionIds) {
  const candidate = String(questionId || "");
  const expected = normalizedExpectedQuestionIds(expectedQuestionIds);
  if (expected.includes(candidate)) return candidate;
  const parents = expected.filter((parent) => isQuestionSubId(candidate, parent));
  return parents.length === 1 ? parents[0] : null;
}

function isQuestionSubId(candidate, parent) {
  if (!candidate.startsWith(parent) || candidate === parent) return false;
  const suffix = candidate.slice(parent.length);
  return /^(?:[A-Za-z]+(?:[._:-][A-Za-z0-9]+)*|[._:-][A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*)$/u.test(suffix);
}

function scopedItemsForVerdict(itemsByQuestion, verdictQuestionId, expectedQuestionIds) {
  const direct = itemsByQuestion.get(verdictQuestionId) || [];
  const parent = resolveExpectedQuestionParent(verdictQuestionId, expectedQuestionIds);
  if (!parent || parent === verdictQuestionId) return direct;
  return [...direct, ...(itemsByQuestion.get(parent) || [])];
}

function claimStatusCanSupportVerdict(claimStatus, verdictValue) {
  if (verdictValue === "TRUE" || verdictValue === "FALSE") {
    return claimStatus === "TRUE";
  }
  return verdictValue === "CONDITIONAL"
    && (claimStatus === "TRUE" || claimStatus === "FALSE");
}

function scopedItemsByQuestion(items, questionIds, kind = "", errors = null) {
  const scoped = new Map(questionIds.map((questionId) => [questionId, []]));
  for (const item of items) {
    let questionId = isNonEmptyString(item.questionId) ? String(item.questionId) : "";
    if (!questionId && questionIds.length === 1) questionId = questionIds[0];
    if (!questionId) {
      if (errors) {
        errors.push(
          `${kind} ${item.claimId || item.code || ""} must include questionId when multiple questions are present`.trim(),
        );
      }
      continue;
    }
    if (!scoped.has(questionId)) scoped.set(questionId, []);
    scoped.get(questionId).push(item);
  }
  return scoped;
}

function uniqueIndex(items, key, path, errors) {
  const index = new Map();
  for (const [position, item] of items.entries()) {
    const id = String(item[key]);
    if (index.has(id)) errors.push(`${path}[${position}].${key} must be unique: ${id}`);
    index.set(id, item);
  }
  return index;
}

function dedupeStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

function validateObjectArray(value, path, errors, validateItem, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length < minItems) errors.push(`${path} must contain at least ${minItems} item(s)`);
  value.forEach((item, index) => {
    if (!isPlainObject(item)) errors.push(`${path}[${index}] must be an object`);
    else validateItem(item, `${path}[${index}]`);
  });
}

function assertExactKeys(value, expectedKeys, path, errors, optionalKeys = []) {
  if (!isPlainObject(value)) return;
  const expected = new Set([...expectedKeys, ...optionalKeys]);
  for (const key of expectedKeys) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function assertNonEmptyString(value, path, errors) {
  if (!isNonEmptyString(value)) errors.push(`${path} must be a non-empty string`);
}

function assertStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    errors.push(`${path} must be an array of non-empty strings`);
  }
}

function assertEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) errors.push(`${path} must be one of: ${allowed.join(", ")}`);
}

function strictObject(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function nonEmptyString() {
  return { type: "string", minLength: 1 };
}

function stringArray() {
  return {
    type: "array",
    items: nonEmptyString(),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOrEmpty(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function normalizeMachineToken(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function normalizeComparableText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function arrayAt(value, key) {
  return hasOwn(value, key) && Array.isArray(value[key]) ? value[key] : null;
}

const GENERIC_UNRESOLVED_CODES = new Set([
  "unknown",
  "missing_info",
  "missing_information",
  "insufficient_info",
  "insufficient_information",
  "insufficient_evidence",
  "data_insufficient",
  "retrieval_insufficient",
  "need_more_info",
]);

const GENERIC_MISSING_FACT_TEXTS = new Set([
  "资料不足",
  "信息不足",
  "证据不足",
  "依据不足",
  "数据不足",
  "资料不完整",
  "信息不完整",
  "缺少决定性事实",
  "缺少具体事实",
  "无法判断",
  "无法确定",
  "不能判断",
  "不能确定",
  "需要更多资料",
  "需要更多信息",
  "insufficientinformation",
  "insufficientevidence",
  "cannotdetermine",
  "unknown",
]);

const GENERIC_MISSING_FACT_PATTERNS = [
  /^(?:当前|现有|所给|提供的|输入的)?(?:资料|信息|证据|依据|数据)(?:仍然|还|并不)?(?:不足|不充分|不完整|缺失|不够)[，。；;\s]*(?:因此|所以)?(?:无法|不能)?(?:判断|确定|回答)?[。.!！\s]*$/iu,
  /^(?:无法|不能)(?:根据|从)?(?:当前|现有|所给|提供的|输入的)?(?:资料|信息|证据|依据|数据)?(?:作出)?(?:判断|确定|回答)[。.!！\s]*$/iu,
  /^(?:还|仍)?需要(?:更多|补充)?(?:资料|信息|证据|依据|数据)[。.!！\s]*$/iu,
  /^(?:缺少|未提供|未说明)(?:决定性|关键|具体)?(?:资料|信息|证据|依据|数据|事实)[。.!！\s]*$/iu,
  /^(?:insufficient|incomplete|missing)\s+(?:information|evidence|data)(?:\s+to\s+(?:decide|determine|answer))?[.!\s]*$/iu,
];

const GENERIC_CONDITION_TEXTS = new Set([
  "视情况而定",
  "根据实际情况",
  "取决于具体情况",
  "资料充分时",
  "信息充分时",
  "证据充分时",
  "满足条件时",
  "条件允许时",
  "dependingonthecircumstances",
  "ifapplicable",
  "ifpossible",
]);

const KNOWN_EVIDENCE_TEXT_FIELDS = new Set([
  "answer",
  "body",
  "card_text",
  "cardtext",
  "conclusion",
  "content",
  "effect_text",
  "effecttext",
  "explanation",
  "full_text",
  "fulltext",
  "official_text",
  "officialtext",
  "printed_text",
  "printedtext",
  "question",
  "ruling",
  "scenario",
  "text",
]);

const MISSING_GAME_STATE_FACTS = Object.freeze([
  {
    requested: /(?:表示形式|表示状态|攻击表示|守备表示|表侧|里侧|face[- ]?(?:up|down)|attack position|defen[cs]e position)/iu,
    supplied: /(?:(?:表侧|里侧).{0,8}(?:攻击|守备)表示|攻击表示|守备表示|face[- ]?(?:up|down)|attack position|defen[cs]e position)/iu,
  },
  {
    requested: /(?:控制者|控制权|由谁控制|controller|control of)/iu,
    supplied: /(?:我方|自己|对方|对手).{0,12}(?:场上|控制|怪兽区域)|(?:控制权|controller|control of).{0,20}(?:自己|对方|opponent)/iu,
  },
  {
    requested: /(?:所在区域|位于|位置|zone|location)/iu,
    supplied: /(?:手牌|手卡|场上|怪兽区域|魔法与陷阱区域|墓地|除外|卡组|额外卡组|hand|field|graveyard|banished|deck|extra deck)/iu,
  },
  {
    requested: /(?:回合玩家|谁的回合|自己回合|对方回合|turn player|whose turn)/iu,
    supplied: /(?:自己|我方|对方|对手).{0,4}回合|回合玩家|turn player|(?:my|your|opponent'?s) turn/iu,
  },
  {
    requested: /(?:连锁序号|连锁位置|连锁几|chain link|chain position|C[1-9])/iu,
    supplied: /(?:连锁|C|chain(?: link)?)[ 　]*(?:1|2|3|4|5|一|二|三|四|五)/iu,
  },
  {
    requested: /(?:效果编号|第几个效果|①|②|③|④|⑤|effect number)/iu,
    supplied: /(?:①|②|③|④|⑤|第[一二三四五1-5]个?效果|effect [1-5])/iu,
  },
  {
    requested: /(?:种族|race)/iu,
    supplied: /(?:龙族|魔法师族|战士族|恶魔族|岩石族|机械族|天使族|不死族|race)/iu,
  },
  {
    requested: /(?:属性|attribute)/iu,
    supplied: /(?:光属性|暗属性|地属性|水属性|炎属性|风属性|神属性|attribute)/iu,
  },
  {
    requested: /(?:等级|阶级|连接值|link值|level|rank|link rating)/iu,
    supplied: /(?:等级|阶级|连接值|link值|level|rank|link rating)[ 　:]*(?:[0-9一二三四五六七八九十]|X)/iu,
  },
  {
    requested: /(?:是否|有没有|有无|未说明).{0,8}(?:已经|已|曾经)?(?:发动|發動)|(?:activation|effect).{0,12}(?:already|previously).{0,6}activated/iu,
    supplied: /(?:(?<!是否)(?<!有无)(?:已经|已).{0,8}(?:发动|發動)|(?:此前|本回合).{0,8}(?:发动|發動)|(?:发动|發動)(?:成功|完毕|完畢|过|過)|(?:already|previously).{0,8}activated)/iu,
  },
  {
    requested: /(?:是否|有没有|有无|未说明).{0,8}(?:已经|已)?(?:支付|付出|丢弃|丟棄|解放|取除).{0,8}(?:代价|代價|cost)?|(?:cost|代价|代價).{0,12}(?:paid|支付|付出)/iu,
    supplied: /(?:(?<!是否)(?<!有无)(?:已经|已).{0,8}(?:支付|付出|丢弃|丟棄|解放|取除)|作为.{0,4}(?:cost|代价|代價).{0,8}(?:丢弃|丟棄|解放|取除|支付)|(?:cost|代价|代價).{0,8}(?:已经|已|was|has been).{0,6}(?:paid|支付|付出))/iu,
  },
  {
    requested: /(?:是否|有没有|有无|未说明).{0,8}(?:已经|已)?(?:选择|選擇|选定|選定|取对象|取對象)|(?:选择|選擇).{0,8}(?:对象|對象|哪张|哪張)|target.{0,12}(?:chosen|selected)/iu,
    supplied: /(?:(?<!是否)(?<!有无)(?:已经|已).{0,8}(?:选择|選擇|选定|選定|取对象|取對象)|(?:选择|選擇)了|以.{1,40}(?:为对象|為對象)|target.{0,12}(?:was|has been).{0,6}(?:chosen|selected))/iu,
  },
]);

const ANSWER_POLARITY_PATTERNS = Object.freeze([
  ["negative", [
    /(?:不可以|不能|不得|无法)(?:发动|發動|适用|適用|处理|處理|进行|進行|召唤|召喚|选择|選擇|使用|支付|成为|成為|作为|作為|连锁|連鎖|宣言|攻击|攻擊|返回|送去|除外|破坏|破壞|解放)/iu,
    /(?:不会|不會|不再)(?:发动|發動|适用|適用|处理|處理|进行|進行|召唤|召喚|恢复|恢復)/iu,
    /\b(?:false|cannot|can't|may not|does not apply)\b/iu,
    /^(?:否|不行)(?:[，。；;！!\s]|$)/iu,
  ]],
  ["positive", [
    /(?:可以|能够|能夠|允许|允許)(?:发动|發動|适用|適用|处理|處理|进行|進行|召唤|召喚|选择|選擇|使用|支付|成为|成為|作为|作為|连锁|連鎖|宣言|攻击|攻擊|返回|送去|除外|破坏|破壞|解放)/iu,
    /(?:会|會)(?:发动|發動|适用|適用|处理|處理|进行|進行|召唤|召喚|恢复|恢復)/iu,
    /\b(?:true|can|may|applies)\b/iu,
    /^(?:是|可以|能)(?:[，。；;！!\s]|$)/iu,
  ]],
]);

function layeredValidationResult(result, { hardErrors = [], semanticIssues = [] } = {}) {
  const normalizedHardErrors = [...new Set(hardErrors)];
  const normalizedSemanticIssues = [...new Set(semanticIssues)];
  const hardOk = normalizedHardErrors.length === 0;
  const semanticOk = normalizedSemanticIssues.length === 0;
  return {
    ok: hardOk && semanticOk,
    errors: [...normalizedHardErrors, ...normalizedSemanticIssues],
    ...(hardOk ? { normalized: cloneJson(result) } : {}),
    hardValidity: {
      ok: hardOk,
      errors: normalizedHardErrors,
    },
    semanticAssessment: {
      evaluated: true,
      ok: semanticOk,
      issues: normalizedSemanticIssues,
    },
  };
}

function validationFailure(errors) {
  const normalizedErrors = [...new Set(errors)];
  return {
    ok: false,
    errors: normalizedErrors,
    hardValidity: {
      ok: false,
      errors: normalizedErrors,
    },
    semanticAssessment: {
      evaluated: false,
      ok: false,
      issues: [],
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
