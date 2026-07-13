export const OPERATION_LEGALITY_STATUSES = Object.freeze([
  "legal",
  "illegal",
  "conditional",
  "unknown",
]);

export function validateOperationLegalityModelOutput(raw, ruleEvidence = []) {
  const parsed = parseModelObject(raw);
  if (!parsed) return emptyOperationLegality(["rulebook_grounding_invalid_json"]);

  const evidenceById = new Map((ruleEvidence || [])
    .filter((item) => item?.id && item?.text)
    .map((item) => [String(item.id), item]));
  const warnings = [];
  const sourceChecks = Array.isArray(parsed.operationChecks) ? parsed.operationChecks
    : Array.isArray(parsed.operations) ? parsed.operations
      : [];
  const checks = sourceChecks.slice(0, 20).map((item, index) => normalizeCheck(item, index, evidenceById, warnings));
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
    hasChecks: checks.length > 0,
    hasGroundedChecks: groundedChecks.length > 0,
    hasBlockingCheck: blockingChecks.length > 0,
    blockers: blockingChecks.map((check) => ({
      id: `operation_illegal:${check.operationId}`,
      explanation: check.conclusion,
      evidenceIds: check.citations.map((citation) => citation.id),
    })),
    shortAnswer: firstBlocking?.conclusion || cleanText(parsed.overallConclusion),
    reasoning: buildReasoning(checks),
    warnings: [...new Set(warnings)],
    modelExtracted: true,
  };
}

export function emptyOperationLegality(warnings = []) {
  return {
    checks: [],
    evidence: [],
    matchedRuleEvidence: [],
    hasChecks: false,
    hasGroundedChecks: false,
    hasBlockingCheck: false,
    blockers: [],
    shortAnswer: "",
    reasoning: [],
    warnings: [...new Set(warnings)],
    modelExtracted: false,
  };
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
    });
  }
  return result;
}

function operationCheckEvidence(check) {
  return {
    id: `operation-check-${check.operationId}`,
    type: "rulebook",
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
      ...check.citations.map((citation) => `规则书引文 [${citation.id}]：${citation.quote}${citation.application ? `\n适用说明：${citation.application}` : ""}`),
    ].filter(Boolean).join("\n"),
    sourceUrl: "",
    source: "rulebook_model_grounding",
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
