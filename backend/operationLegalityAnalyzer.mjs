export const OPERATION_LEGALITY_STATUSES = Object.freeze([
  "legal",
  "illegal",
  "conditional",
  "unknown",
]);

export function validateOperationLegalityModelOutput(raw, evidenceCandidates = [], {
  requiredConstraintEvidence = [],
} = {}) {
  const parsed = parseModelObject(raw);
  if (!parsed) {
    return emptyOperationLegality(
      ["evidence_grounding_invalid_json"],
      requiredConstraintEvidence,
    );
  }

  const evidenceById = new Map((evidenceCandidates || [])
    .filter((item) => item?.id && item?.text)
    .map((item) => [String(item.id), item]));
  const warnings = [];
  const constraintReviews = normalizeConstraintReviews(
    parsed.constraintReviews,
    evidenceById,
    warnings,
  );
  const sourceChecks = Array.isArray(parsed.operationChecks) ? parsed.operationChecks
    : Array.isArray(parsed.operations) ? parsed.operations
      : [];
  let checks = sourceChecks.slice(0, 20).map((item, index) => normalizeCheck(item, index, evidenceById, warnings));
  const reviewBlockingChecks = constraintReviews
    .filter((review) => isResolvedConstraintReview(review) && review.relevance === "applies" && review.consequence === "blocks")
    .map((review, index) => constraintReviewToCheck(review, checks.length + index));
  checks = uniqueBy([...checks, ...reviewBlockingChecks], checkKey);

  const requiredConstraints = uniqueBy(
    (requiredConstraintEvidence || [])
      .map((item) => evidenceById.get(String(item?.id || "")))
      .filter(Boolean),
    (item) => item.id,
  );
  const resolvedConstraintIds = new Set(constraintReviews
    .filter(isResolvedConstraintReview)
    .map((review) => review.evidenceId));
  const hasBlockingChecksBeforeCoverage = checks.some((check) => check.status === "illegal" && check.citations.length > 0);
  const unresolvedConstraintEvidence = !hasBlockingChecksBeforeCoverage
    ? requiredConstraints.filter((item) => !resolvedConstraintIds.has(String(item.id)))
    : [];
  if (unresolvedConstraintEvidence.length) {
    const missingLabel = unresolvedConstraintEvidence.map((item) => item.title || item.id).join("、").slice(0, 600);
    warnings.push(`operation_constraint_review_missing:${unresolvedConstraintEvidence.map((item) => item.id).join(",")}`);
    checks = checks.map((check) => {
      if (check.status !== "legal" && check.status !== "conditional") return check;
      return {
        ...check,
        status: "unknown",
        conclusion: check.conclusion
          ? `${check.conclusion}（该肯定结论未完成限制性规则核对，不能采用。）`
          : "该肯定结论未完成限制性规则核对，不能采用。",
        missingFacts: [...new Set([
          ...(check.missingFacts || []),
          `尚未核对限制性规则：${missingLabel}`,
        ])],
      };
    });
  }
  const groundedChecks = checks.filter((check) => check.citations.length > 0);
  const blockingChecks = groundedChecks.filter((check) => check.status === "illegal");
  const matchedRuleEvidence = uniqueBy(
    groundedChecks.flatMap((check) => check.citations.map((citation) => evidenceById.get(citation.id)).filter(Boolean)),
    (item) => item.id,
  );
  const evidence = groundedChecks.map(operationCheckEvidence);
  const firstBlocking = blockingChecks[0];

  return {
    checks,
    evidence,
    matchedRuleEvidence,
    matchedEvidence: matchedRuleEvidence,
    hasChecks: checks.length > 0,
    hasGroundedChecks: groundedChecks.length > 0,
    hasBlockingCheck: blockingChecks.length > 0,
    blockers: blockingChecks.map((check) => ({
      id: `operation_illegal:${check.operationId}`,
      explanation: check.conclusion,
      evidenceIds: check.citations.map((citation) => citation.id),
    })),
    shortAnswer: firstBlocking?.conclusion
      || (unresolvedConstraintEvidence.length
        ? "检索到尚未完成适用性核对的限制性规则，不能确认该操作可以发动或处理。"
        : cleanText(parsed.overallConclusion)),
    reasoning: buildReasoning(checks),
    constraintReviews,
    priorityConstraintEvidence: requiredConstraints,
    unresolvedConstraintEvidence,
    hasUnresolvedConstraints: unresolvedConstraintEvidence.length > 0,
    warnings: [...new Set(warnings)],
    modelExtracted: true,
  };
}

export function emptyOperationLegality(warnings = [], requiredConstraintEvidence = []) {
  const unresolvedConstraintEvidence = uniqueBy(
    (requiredConstraintEvidence || []).filter((item) => item?.id && item?.text),
    (item) => String(item.id),
  );
  return {
    checks: [],
    evidence: [],
    matchedRuleEvidence: [],
    matchedEvidence: [],
    hasChecks: false,
    hasGroundedChecks: false,
    hasBlockingCheck: false,
    blockers: [],
    shortAnswer: "",
    reasoning: [],
    constraintReviews: [],
    priorityConstraintEvidence: unresolvedConstraintEvidence,
    unresolvedConstraintEvidence,
    hasUnresolvedConstraints: unresolvedConstraintEvidence.length > 0,
    warnings: [...new Set(warnings)],
    modelExtracted: false,
  };
}

function normalizeConstraintReviews(value, evidenceById, warnings) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, 12).map((item, index) => {
    const evidenceId = cleanText(item?.evidenceId || item?.id);
    const citations = normalizeCitations([{
      id: evidenceId,
      quote: item?.quote || item?.excerpt,
      application: item?.application || item?.reason,
    }], evidenceById, `constraint-review-${index + 1}`, warnings);
    return {
      evidenceId,
      operationId: cleanText(item?.operationId || `constraint-operation-${index + 1}`).slice(0, 80),
      action: cleanText(item?.action || item?.operation || "核对限制性规则").slice(0, 240),
      relevance: normalizeConstraintRelevance(item?.relevance || item?.applicability || item?.applies),
      consequence: normalizeConstraintConsequence(item?.consequence || item?.effect || item?.result),
      conclusion: cleanText(item?.conclusion || item?.answer || item?.application).slice(0, 500),
      reasoning: cleanStringArray(item?.reasoning || item?.reasons || item?.application, 6, 500),
      citation: citations[0] || null,
      grounded: citations.length > 0,
    };
  }).filter((review) => review.evidenceId);
}

function constraintReviewToCheck(review, index) {
  return {
    operationId: review.operationId || `constraint-operation-${index + 1}`,
    step: index + 1,
    action: review.action,
    legalityQuestion: "该限制性规则是否阻止题目中的操作",
    status: "illegal",
    conclusion: review.conclusion || "检索到的限制性规则适用于当前场景，因此该操作不合法。",
    reasoning: review.reasoning.length
      ? review.reasoning
      : [review.citation?.application || "限制性规则适用于题目给出的操作和场面事实。"].filter(Boolean),
    citations: review.citation ? [review.citation] : [],
    missingFacts: [],
  };
}

function isResolvedConstraintReview(review) {
  if (!review?.grounded) return false;
  const application = cleanText(review.citation?.application);
  const explanation = cleanText([
    application,
    review.conclusion,
    ...(review.reasoning || []),
  ].filter(Boolean).join(" "));
  if (application.length < 8 || explanation.length < 12) return false;
  if (review.relevance === "not_applicable") return review.consequence === "none";
  return review.relevance === "applies" && ["blocks", "none"].includes(review.consequence);
}

function checkKey(check) {
  return [
    check.operationId,
    check.status,
    ...(check.citations || []).map((citation) => citation.id),
  ].join("\u0000");
}

function normalizeConstraintRelevance(value) {
  if (value === true) return "applies";
  if (value === false) return "not_applicable";
  const normalized = String(value || "").trim().toLowerCase();
  if (["applies", "applicable", "relevant", "yes"].includes(normalized)) return "applies";
  if (["not_applicable", "not-applicable", "irrelevant", "no"].includes(normalized)) return "not_applicable";
  return "uncertain";
}

function normalizeConstraintConsequence(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["blocks", "block", "illegal", "prevents", "prohibits"].includes(normalized)) return "blocks";
  if (["limits", "limit", "conditional", "restricts"].includes(normalized)) return "limits";
  if (["none", "no_effect", "does_not_block", "not_blocking"].includes(normalized)) return "none";
  return "uncertain";
}

function normalizeCheck(item, index, evidenceById, warnings) {
  const operationId = cleanText(item?.operationId || item?.id || `operation-${index + 1}`).slice(0, 80);
  const requestedStatus = normalizeStatus(item?.status || item?.legality);
  const citations = normalizeCitations(item?.citations || item?.evidence || item?.ruleEvidence, evidenceById, operationId, warnings);
  let status = requestedStatus;
  if (["legal", "illegal", "conditional"].includes(status) && citations.length === 0) {
    warnings.push(`rulebook_grounding_missing_valid_citation:${operationId}`);
    status = "unknown";
  }
  return {
    operationId,
    step: positiveInteger(item?.step, index + 1),
    action: cleanText(item?.action || item?.operation || item?.description).slice(0, 240),
    legalityQuestion: cleanText(item?.legalityQuestion || item?.question).slice(0, 240),
    status,
    conclusion: cleanText(item?.conclusion || item?.answer).slice(0, 500),
    reasoning: cleanStringArray(item?.reasoning || item?.reasons, 8, 500),
    citations,
    missingFacts: cleanStringArray(item?.missingFacts || item?.missingInfo, 8, 240),
  };
}

function normalizeCitations(value, evidenceById, operationId, warnings) {
  const source = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const item of source.slice(0, 8)) {
    const id = cleanText(typeof item === "string" ? item : item?.id || item?.evidenceId);
    const quote = cleanText(typeof item === "string" ? "" : item?.quote || item?.excerpt);
    const evidence = evidenceById.get(id);
    if (!evidence) {
      if (id) warnings.push(`rulebook_grounding_unknown_evidence:${operationId}:${id}`);
      continue;
    }
    if (quote.length < 4 || !containsNormalizedQuote(evidence.text, quote)) {
      warnings.push(`rulebook_grounding_quote_mismatch:${operationId}:${id}`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      quote: quote.slice(0, 500),
      application: cleanText(item?.application || item?.reason).slice(0, 500),
      type: cleanText(evidence.type || evidence.recordType || "related"),
      title: cleanText(evidence.title || id),
      sourceUrl: cleanText(evidence.sourceUrl || ""),
    });
  }
  return result;
}

function operationCheckEvidence(check) {
  const citationTypes = new Set(check.citations.map((citation) => citation.type).filter(Boolean));
  const isRulebookOnly = citationTypes.size > 0 && [...citationTypes].every((type) => type === "rulebook");
  return {
    id: `operation-check-${check.operationId}`,
    type: isRulebookOnly ? "rulebook" : "operation_check",
    recordType: "operation-legality-check",
    title: `操作合法性检查：${check.action || check.operationId}`,
    cardIds: [],
    cards: [],
    text: [
      `步骤 ${check.step}：${check.action || check.operationId}`,
      check.legalityQuestion ? `要验证的问题：${check.legalityQuestion}` : "",
      `判定：${check.status}`,
      check.conclusion ? `结论：${check.conclusion}` : "",
      ...check.reasoning.map((reason) => `理由：${reason}`),
      ...check.citations.map((citation) => `证据引文 [${citation.id}]：${citation.quote}${citation.application ? `\n适用说明：${citation.application}` : ""}`),
    ].filter(Boolean).join("\n"),
    sourceUrl: "",
    source: isRulebookOnly ? "rulebook_model_grounding" : "qa_rule_model_grounding",
    official: false,
    isDirect: false,
    operationLegality: {
      status: check.status,
      operationId: check.operationId,
      ruleEvidenceIds: check.citations.map((citation) => citation.id),
    },
  };
}

function buildReasoning(checks) {
  return checks.slice(0, 12).flatMap((check) => [
    `步骤 ${check.step}「${check.action || check.operationId}」：${check.conclusion || (check.status === "unknown" ? "规则书证据不足，不能确定。" : check.status)}`,
    ...check.reasoning,
  ]).slice(0, 16);
}

function normalizeStatus(value) {
  const status = String(value || "unknown").trim().toLowerCase();
  if (["legal", "allowed", "valid", "can"].includes(status)) return "legal";
  if (["illegal", "blocked", "invalid", "cannot", "can_not"].includes(status)) return "illegal";
  if (["conditional", "limited", "depends"].includes(status)) return "conditional";
  return "unknown";
}

function containsNormalizedQuote(text, quote) {
  const haystack = normalizeQuote(text);
  const needle = normalizeQuote(quote);
  return needle.length >= 4 && haystack.includes(needle);
}

function normalizeQuote(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function parseModelObject(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function cleanStringArray(value, limit, maxChars) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return source.map(cleanText).filter(Boolean).map((item) => item.slice(0, maxChars)).slice(0, limit);
}

function cleanText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function uniqueBy(values, getKey) {
  const map = new Map();
  for (const item of values || []) {
    const key = getKey(item);
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return [...map.values()];
}
