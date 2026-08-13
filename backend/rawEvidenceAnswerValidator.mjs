const ANSWER_LEVELS = new Set([
  "official_confirmed",
  "rule_analysis",
  "low_confidence_analysis",
  "needs_more_info",
  "budget_limited",
]);

const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);

/**
 * Validate only the transport/schema boundary of a public RAG answer.
 *
 * Deliberately absent here: answer-polarity regexes, question-coverage
 * heuristics, operation-legality packets, local rule templates, Lua/formal
 * conclusions and any other mechanism that attempts to decide the ruling.
 */
export function validateRawEvidenceFinalAnswer(answer = {}, {
  rawText = "",
  modelWarnings = [],
  providerFailure = null,
  allowedEvidenceIds = [],
  allowedAnswerLevels = [...ANSWER_LEVELS],
} = {}) {
  const errors = [];
  const adaptation = adaptDisplayAnswer(answer, { allowedEvidenceIds, allowedAnswerLevels });
  const adaptedAnswer = adaptation.answer;
  const providerFailureKind = classifyProviderFailure(providerFailure, modelWarnings);

  if (providerFailureKind) {
    errors.push(providerFailureKind === "access_denied"
      ? "model provider access denied before returning a usable answer"
      : providerFailureKind === "timeout"
        ? "model provider timed out before returning a usable answer"
        : "model provider failed before returning a usable answer");
  }

  if (hasUnusableModelOutputWarning(modelWarnings)) {
    errors.push("model output could not be parsed as the required JSON contract");
  }

  if (!adaptedAnswer) {
    errors.push("final answer has no readable shortAnswer");
    return validationResult(errors, providerFailureKind, adaptation.diagnosticWarnings, null);
  }

  return validationResult(
    errors,
    providerFailureKind,
    adaptation.diagnosticWarnings,
    adaptedAnswer,
  );
}

/**
 * Invoke the final model exactly once and preserve the result shape consumed
 * by ragRulingPipeline. Invalid non-authoritative output becomes a neutral
 * technical failure, never a locally invented ruling.
 */
export async function runValidatedRawEvidenceFinal({
  invoke,
  originalPrompt = "",
  allowedEvidenceIds = [],
  allowedAnswerLevels = [...ANSWER_LEVELS],
} = {}) {
  if (typeof invoke !== "function") throw new TypeError("invoke is required");
  const startedAt = Date.now();
  const result = await invoke({ prompt: originalPrompt, attemptKind: "primary" });
  const latencyMs = elapsedMs(startedAt);
  const validation = validateRawEvidenceFinalAnswer(result?.answer, {
    rawText: result?.rawText,
    modelWarnings: result?.warnings,
    providerFailure: result?.providerFailure,
    allowedEvidenceIds,
    allowedAnswerLevels,
  });

  const answer = validation.ok
    ? validation.answer
    : buildNeutralFailureAnswer(validation);
  const outcome = validation.ok
    ? "primary_valid"
    : "primary_invalid_no_ruling";
  const nestedAttempts = Array.isArray(result?.generationAttempts) && result.generationAttempts.length
    ? result.generationAttempts
    : [{ attempt: "provider_call" }];

  return {
    ...result,
    answer,
    generationAttempts: nestedAttempts.map((attempt) => ({
      ...attempt,
      publicAttemptKind: "primary",
    })),
    warnings: unique([
      ...(result?.warnings || []),
      ...(!validation.ok ? ["raw_evidence_final_validation_failed"] : []),
    ]),
    publicFinalValidation: {
      schemaVersion: 2,
      mode: "raw_evidence_only",
      outcome,
      callCount: 1,
      repairAttempted: false,
      maxRepairAttempts: 0,
      primary: {
        ok: validation.ok,
        providerFailureKind: validation.providerFailureKind || null,
        errors: validation.errors,
        diagnosticWarnings: validation.diagnosticWarnings,
        checks: {
          outputContract: validation.ok,
          evidenceReferences: !validation.errors.some((error) => error.includes("usedEvidence")),
          officialDirectFallback: false,
        },
        candidate: summarizeCandidate(validation.answer || result?.answer),
        latencyMs,
      },
      repair: null,
      totalLatencyMs: latencyMs,
    },
  };
}

function validationResult(errors, providerFailureKind, diagnosticWarnings = [], answer = null) {
  return {
    ok: errors.length === 0,
    providerFailureKind,
    errors: unique(errors).slice(0, 24),
    diagnosticWarnings: unique(diagnosticWarnings).slice(0, 24),
    answer,
  };
}

function hasUnusableModelOutputWarning(warnings = []) {
  return (Array.isArray(warnings) ? warnings : []).some((warning) => (
    /^(?:model_json_invalid_schema|model_json_parse_failed(?::|$))/u
      .test(String(warning || ""))
  ));
}

function adaptDisplayAnswer(value, { allowedEvidenceIds = [], allowedAnswerLevels = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { answer: null, diagnosticWarnings: [] };
  }
  const shortAnswer = typeof value.shortAnswer === "string" ? value.shortAnswer.trim() : "";
  if (!shortAnswer) return { answer: null, diagnosticWarnings: [] };

  const diagnosticWarnings = [];
  const reasoning = normalizeStringArray(value.reasoning, "reasoning", diagnosticWarnings);
  const usedCards = normalizeStringArray(value.usedCards, "usedCards", diagnosticWarnings);
  const missingInfo = normalizeStringArray(value.missingInfo, "missingInfo", diagnosticWarnings);
  const riskFlags = normalizeStringArray(value.riskFlags, "riskFlags", diagnosticWarnings);
  const allowedIds = new Set((Array.isArray(allowedEvidenceIds) ? allowedEvidenceIds : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean));
  const usedEvidence = [];
  if (!Array.isArray(value.usedEvidence)) {
    diagnosticWarnings.push("model_output_adapted:missing_or_invalid_usedEvidence");
  } else {
    for (const item of value.usedEvidence) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        diagnosticWarnings.push("model_output_adapted:invalid_citation_dropped");
        continue;
      }
      const id = String(item.id || "").trim();
      if (!id || !allowedIds.has(id)) {
        diagnosticWarnings.push("model_output_adapted:unavailable_citation_dropped");
        continue;
      }
      usedEvidence.push({
        id,
        type: String(item.type || "related").trim(),
        title: String(item.title || "").trim(),
      });
      if (usedEvidence.length >= 12) break;
    }
  }

  const configuredLevels = unique((Array.isArray(allowedAnswerLevels) ? allowedAnswerLevels : [])
    .map((item) => String(item || "").trim())
    .filter((item) => ANSWER_LEVELS.has(item)));
  const requestedLevel = String(value.answerLevel || "").trim();
  let answerLevel = configuredLevels.includes(requestedLevel)
    ? requestedLevel
    : safeFallbackAnswerLevel(requestedLevel);
  const officialOnlyPath = configuredLevels.includes("official_confirmed")
    && !configuredLevels.some((level) => [
      "rule_analysis",
      "low_confidence_analysis",
      "needs_more_info",
    ].includes(level));
  const hasDirectCitation = officialOnlyPath
    && usedEvidence.some((item) => allowedIds.has(item.id));
  if (answerLevel === "official_confirmed" && !hasDirectCitation) {
    answerLevel = "low_confidence_analysis";
    diagnosticWarnings.push("model_output_adapted:official_confirmation_missing_direct_citation");
  }
  if (answerLevel !== requestedLevel) diagnosticWarnings.push("model_output_adapted:answer_level_normalized");

  const confidence = CONFIDENCE_LEVELS.has(String(value.confidenceSelfEstimate || ""))
    ? String(value.confidenceSelfEstimate)
    : "low";
  if (confidence !== value.confidenceSelfEstimate) {
    diagnosticWarnings.push("model_output_adapted:confidence_defaulted_low");
  }
  return {
    answer: {
      answerLevel,
      shortAnswer,
      reasoning,
      usedCards,
      usedEvidence,
      missingInfo,
      riskFlags,
      confidenceSelfEstimate: confidence,
    },
    diagnosticWarnings,
  };
}

function normalizeStringArray(value, field, diagnosticWarnings) {
  if (typeof value === "string") {
    diagnosticWarnings.push(`model_output_adapted:${field}_string_to_array`);
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    diagnosticWarnings.push(`model_output_adapted:missing_or_invalid_${field}`);
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12);
}

function safeFallbackAnswerLevel(requestedLevel) {
  // Schema adaptation may preserve or lower authority, but must never infer a
  // stronger authority level merely because it is present in an allowlist.
  if (requestedLevel === "needs_more_info" || requestedLevel === "budget_limited") {
    return requestedLevel;
  }
  return "low_confidence_analysis";
}

function buildNeutralFailureAnswer(validation) {
  const providerMessage = validation.providerFailureKind === "timeout"
    ? "模型服务本次响应超时，未生成可展示的裁定。"
    : validation.providerFailureKind === "access_denied"
      ? "模型服务拒绝了本次请求，未生成可展示的裁定。"
      : validation.providerFailureKind
        ? "模型服务本次调用失败，未生成可展示的裁定。"
        : "模型输出格式不完整，未生成可展示的裁定。";
  return {
    answerLevel: "needs_more_info",
    shortAnswer: providerMessage,
    reasoning: ["系统没有使用本地规则模板、正则或派生语义补造“可以／不可以”的结论，请重试本次请求。"],
    usedCards: [],
    usedEvidence: [],
    missingInfo: [],
    riskFlags: unique([
      "model_output_not_displayable",
      ...validation.errors.map((error) => `output_contract:${String(error).slice(0, 240)}`),
    ]),
    confidenceSelfEstimate: "low",
  };
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

function classifyProviderFailure(providerFailure, warnings = []) {
  const structured = String(providerFailure?.kind || "").trim();
  if (["access_denied", "timeout", "provider_failure"].includes(structured)) return structured;
  const text = (warnings || []).map(String).filter((item) => /^model_call_failed:/u.test(item)).join("\n");
  if (!text) return "";
  if (/(?:access denied|permission denied|forbidden|unauthori[sz]ed|无权访问|权限不足|\bHTTP\s*(?:401|403)\b)/iu.test(text)) {
    return "access_denied";
  }
  if (/(?:timed out|timeout|ETIMEDOUT|UND_ERR_[A-Z_]*TIMEOUT|超时|\bHTTP\s*(?:408|504|524)\b)/iu.test(text)) {
    return "timeout";
  }
  return "provider_failure";
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}
