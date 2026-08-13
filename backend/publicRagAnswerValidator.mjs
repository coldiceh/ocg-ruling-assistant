const ANSWER_LEVELS = new Set([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
  "budget_limited",
]);

const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);

/**
 * Display-contract adapter for the public final model.
 *
 * This module deliberately does not judge a Yu-Gi-Oh! ruling. It contains no
 * polarity regexes, question-type coverage checks, operation legality rules,
 * semantic/formal gates, or answer-repair call. It only makes one model result
 * safe to render and prevents citations to evidence that was not supplied.
 */
export function validatePublicRagFinalAnswer(answer = {}, {
  modelWarnings = [],
  providerFailure = null,
  evidence = {},
  authoritativeOfficialDirect = false,
} = {}) {
  const errors = [];
  const diagnosticWarnings = [];
  const providerFailureKind = classifyProviderFailure(providerFailure, modelWarnings);
  if (providerFailureKind) {
    errors.push(`model_provider_${providerFailureKind}`);
  }
  if (hasUnusableOutputWarning(modelWarnings, answer)) {
    errors.push("model_output_not_parseable");
  }

  const adapted = adaptAnswer(answer, {
    evidence,
    authoritativeOfficialDirect,
    diagnosticWarnings,
  });
  if (!adapted) errors.push("model_answer_missing_short_answer");

  return {
    ok: errors.length === 0,
    providerFailureKind,
    errors: unique(errors),
    diagnosticWarnings: unique(diagnosticWarnings),
    answer: adapted,
    checks: {
      displayContract: Boolean(adapted),
      evidenceReferences: !diagnosticWarnings.includes("unknown_evidence_reference_dropped"),
      rulingSemantics: "not_evaluated",
    },
  };
}

/**
 * Invoke the final semantic model exactly once. A malformed or failed result
 * becomes a neutral technical error; local code never manufactures a ruling.
 */
export async function runValidatedPublicRagFinal({
  invoke,
  originalPrompt = "",
  evidence = {},
  authoritativeOfficialDirect = false,
} = {}) {
  if (typeof invoke !== "function") throw new TypeError("invoke is required");
  const startedAt = Date.now();
  const primary = await invoke({ prompt: originalPrompt, attemptKind: "primary" });
  const validation = validatePublicRagFinalAnswer(primary?.answer, {
    modelWarnings: primary?.warnings,
    providerFailure: primary?.providerFailure,
    evidence,
    authoritativeOfficialDirect,
  });
  const answer = validation.ok
    ? validation.answer
    : buildNeutralTechnicalFailure(validation.providerFailureKind, validation.errors);
  const outcome = validation.ok ? "primary_valid" : "primary_invalid_no_ruling";
  const attempts = Array.isArray(primary?.generationAttempts) && primary.generationAttempts.length
    ? primary.generationAttempts
    : [{ attempt: "provider_call" }];

  return {
    ...primary,
    answer,
    warnings: unique([
      ...(primary?.warnings || []),
      ...validation.diagnosticWarnings,
      ...(!validation.ok ? ["public_final_output_not_displayable"] : []),
    ]),
    generationAttempts: attempts.map((attempt) => ({
      ...attempt,
      publicAttemptKind: "primary",
    })),
    publicFinalValidation: {
      schemaVersion: 3,
      mode: "display_contract_only",
      outcome,
      callCount: 1,
      repairAttempted: false,
      maxRepairAttempts: 0,
      primary: {
        ok: validation.ok,
        providerFailureKind: validation.providerFailureKind || null,
        errors: validation.errors,
        diagnosticWarnings: validation.diagnosticWarnings,
        checks: validation.checks,
        candidate: summarizeCandidate(validation.answer || primary?.answer),
      },
      repair: null,
      totalLatencyMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

function adaptAnswer(value, {
  evidence,
  authoritativeOfficialDirect,
  diagnosticWarnings,
}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const shortAnswer = String(value.shortAnswer || "").trim();
  if (!shortAnswer) return null;

  const evidenceById = availableEvidenceById(evidence);
  const directIds = new Set((evidence?.officialQaDirectCandidates || [])
    .map((item) => String(item?.id || "").trim())
    .filter(Boolean));
  const usedEvidence = [];
  const usedEvidenceIds = new Set();
  for (const item of Array.isArray(value.usedEvidence) ? value.usedEvidence : []) {
    const id = String(item?.id || "").trim();
    const source = evidenceById.get(id);
    if (!source) {
      diagnosticWarnings.push("unknown_evidence_reference_dropped");
      continue;
    }
    if (usedEvidenceIds.has(id)) {
      diagnosticWarnings.push("duplicate_evidence_reference_dropped");
      continue;
    }
    usedEvidenceIds.add(id);
    usedEvidence.push({
      id,
      // The model selects an evidence ID; authority metadata always comes from
      // the server-side source bound to that ID. This is reference-integrity
      // cleanup only and never evaluates the ruling itself.
      type: String(source.type || "related").trim(),
      title: String(source.title || id).trim(),
      ...(source.sourceUrl ? { sourceUrl: String(source.sourceUrl) } : {}),
    });
    if (usedEvidence.length >= 12) break;
  }

  let answerLevel = ANSWER_LEVELS.has(String(value.answerLevel || ""))
    ? String(value.answerLevel)
    : "low_confidence_analysis";
  if (!ANSWER_LEVELS.has(String(value.answerLevel || ""))) {
    diagnosticWarnings.push("answer_level_normalized");
  }
  const selectedDirectId = typeof authoritativeOfficialDirect === "string"
    ? authoritativeOfficialDirect
    : "";
  const hasDirectCitation = Boolean(selectedDirectId)
    && directIds.has(selectedDirectId)
    && usedEvidence.some((item) => item.id === selectedDirectId);
  if (answerLevel === "official_confirmed" && !hasDirectCitation) {
    answerLevel = "rule_analysis";
    diagnosticWarnings.push("official_confirmation_without_direct_citation_downgraded");
  }

  const confidence = CONFIDENCE_LEVELS.has(String(value.confidenceSelfEstimate || ""))
    ? String(value.confidenceSelfEstimate)
    : "low";
  if (confidence !== value.confidenceSelfEstimate) {
    diagnosticWarnings.push("confidence_defaulted_low");
  }

  return {
    answerLevel,
    shortAnswer,
    reasoning: stringArray(value.reasoning, "reasoning", diagnosticWarnings),
    usedCards: stringArray(value.usedCards, "usedCards", diagnosticWarnings),
    usedEvidence,
    missingInfo: stringArray(value.missingInfo, "missingInfo", diagnosticWarnings),
    riskFlags: stringArray(value.riskFlags, "riskFlags", diagnosticWarnings),
    confidenceSelfEstimate: confidence,
  };
}

function stringArray(value, field, warnings) {
  if (typeof value === "string") {
    warnings.push(`${field}_string_normalized_to_array`);
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${field}_missing_defaulted_empty`);
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 24);
}

function availableEvidenceById(evidence = {}) {
  const buckets = [
    "officialQaDirectCandidates",
    "officialQaRelated",
    "provisionalOfficialResponses",
    "faqRelated",
    "cardTexts",
    "userProvidedCardTexts",
    "rawRelatedEvidence",
  ];
  const result = new Map();
  for (const bucket of buckets) {
    for (const item of Array.isArray(evidence?.[bucket]) ? evidence[bucket] : []) {
      const id = String(item?.id || "").trim();
      if (id && !result.has(id)) result.set(id, item);
    }
  }
  return result;
}

function buildNeutralTechnicalFailure(kind, errors) {
  const shortAnswer = kind === "timeout"
    ? "模型服务本次响应超时，未生成可展示的裁定。"
    : kind === "access_denied"
      ? "模型服务拒绝了本次请求，未生成可展示的裁定。"
      : kind === "provider_failure"
        ? "模型服务本次调用失败，未生成可展示的裁定。"
        : "模型没有返回可展示的完整答案，请重试。";
  return {
    answerLevel: "needs_more_info",
    shortAnswer,
    reasoning: [],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: unique([
      "model_output_not_displayable",
      ...(kind ? ["model_provider_call_failed"] : []),
      ...(kind === "access_denied" ? ["model_provider_access_denied"] : []),
      ...(kind === "timeout" ? ["model_provider_timeout"] : []),
      ...(errors || []).map((error) => `display_contract:${error}`),
    ]),
    confidenceSelfEstimate: "low",
  };
}

function classifyProviderFailure(failure, warnings = []) {
  const structured = String(failure?.kind || "").trim();
  if (["access_denied", "timeout", "provider_failure"].includes(structured)) return structured;
  const text = (Array.isArray(warnings) ? warnings : []).map(String).join("\n");
  if (!/model_call_failed/iu.test(text)) return "";
  if (/(?:access denied|forbidden|unauthori[sz]ed|权限不足|无权访问|HTTP\s*(?:401|403))/iu.test(text)) {
    return "access_denied";
  }
  if (/(?:timed out|timeout|ETIMEDOUT|超时|HTTP\s*(?:408|504|524))/iu.test(text)) {
    return "timeout";
  }
  return "provider_failure";
}

function hasUnusableOutputWarning(warnings = [], answer = null) {
  // ragModelClient can safely wrap a plain natural-language response into the
  // public contract without another model call. In that case the parse warning
  // describes the original wire format, not an unusable displayed answer.
  const wrappedNaturalLanguage = (Array.isArray(warnings) ? warnings : [])
    .some((warning) => String(warning || "") === "model_natural_language_wrapped");
  if (wrappedNaturalLanguage && String(answer?.shortAnswer || "").trim()) {
    return false;
  }
  return (Array.isArray(warnings) ? warnings : []).some((warning) => (
    /^(?:model_json_parse_failed|model_json_invalid_schema)(?::|$)/u.test(String(warning || ""))
  ));
}

function summarizeCandidate(answer = {}) {
  return {
    shortAnswer: String(answer?.shortAnswer || "").slice(0, 1200),
    reasoning: (Array.isArray(answer?.reasoning) ? answer.reasoning : [])
      .map((item) => String(item || "").slice(0, 600))
      .filter(Boolean)
      .slice(0, 5),
  };
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}
