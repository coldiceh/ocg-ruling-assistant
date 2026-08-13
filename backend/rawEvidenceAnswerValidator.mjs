const REQUIRED_FIELDS = [
  "answerLevel",
  "shortAnswer",
  "reasoning",
  "usedCards",
  "usedEvidence",
  "missingInfo",
  "riskFlags",
  "confidenceSelfEstimate",
];

const ARRAY_FIELDS = [
  "reasoning",
  "usedCards",
  "usedEvidence",
  "missingInfo",
  "riskFlags",
];

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

  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    errors.push("final answer must be an object");
    return validationResult(errors, providerFailureKind);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(answer, field)) errors.push(`final answer is missing required field: ${field}`);
  }
  for (const field of ARRAY_FIELDS) {
    if (Object.hasOwn(answer, field) && !Array.isArray(answer[field])) {
      errors.push(`${field} must be an array`);
    }
  }
  if (!String(answer.shortAnswer || "").trim()) errors.push("shortAnswer must be non-empty");
  if (!Array.isArray(answer.reasoning)
      || !answer.reasoning.length
      || answer.reasoning.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push("reasoning must contain only non-empty strings");
  }
  const configuredAnswerLevels = new Set(
    (Array.isArray(allowedAnswerLevels) ? allowedAnswerLevels : [])
      .map((value) => String(value || "").trim())
      .filter((value) => ANSWER_LEVELS.has(value)),
  );
  const answerLevel = String(answer.answerLevel || "");
  if (!ANSWER_LEVELS.has(answerLevel)) errors.push("answerLevel is invalid");
  else if (!configuredAnswerLevels.has(answerLevel)) {
    errors.push(`answerLevel is not allowed for this evidence-authority path: ${answerLevel}`);
  }
  if (!CONFIDENCE_LEVELS.has(String(answer.confidenceSelfEstimate || ""))) {
    errors.push("confidenceSelfEstimate is invalid");
  }

  const availableEvidenceIds = new Set(
    (Array.isArray(allowedEvidenceIds) ? allowedEvidenceIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  let validEvidenceCitationCount = 0;
  for (const item of Array.isArray(answer.usedEvidence) ? answer.usedEvidence : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("usedEvidence entries must be objects");
      continue;
    }
    const id = String(item.id || "").trim();
    if (!id) errors.push("usedEvidence contains an empty evidence id");
    else if (!availableEvidenceIds.has(id)) errors.push(`usedEvidence references unavailable evidence: ${id}`);
    else validEvidenceCitationCount += 1;
  }
  if (["official_confirmed", "rule_analysis", "low_confidence_analysis"].includes(answerLevel)
    && validEvidenceCitationCount === 0) {
    errors.push(`${answerLevel} requires at least one valid evidence citation`);
  }

  // The provider client may parse a fenced or otherwise recoverable JSON
  // object locally. That is not a second semantic model call and should not
  // reject an otherwise valid structured answer. An entirely empty payload is
  // still a transport failure when no parsed answer exists.
  if (!String(rawText || "").trim() && !String(answer.shortAnswer || "").trim()) {
    errors.push("model output is empty");
  }

  return validationResult(errors, providerFailureKind);
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
    ? result.answer
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
        diagnosticWarnings: [],
        checks: {
          outputContract: validation.ok,
          evidenceReferences: !validation.errors.some((error) => error.includes("usedEvidence")),
          officialDirectFallback: false,
        },
        candidate: summarizeCandidate(result?.answer),
        latencyMs,
      },
      repair: null,
      totalLatencyMs: latencyMs,
    },
  };
}

function validationResult(errors, providerFailureKind) {
  return {
    ok: errors.length === 0,
    providerFailureKind,
    errors: unique(errors).slice(0, 24),
    diagnosticWarnings: [],
  };
}

function hasUnusableModelOutputWarning(warnings = []) {
  return (Array.isArray(warnings) ? warnings : []).some((warning) => (
    /^(?:model_json_invalid_schema|model_json_parse_failed(?::|$)|model_natural_language_wrapped$)/u
      .test(String(warning || ""))
  ));
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
