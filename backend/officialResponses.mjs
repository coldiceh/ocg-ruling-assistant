export const OFFICIAL_EVIDENCE_SOURCE_TYPES = Object.freeze([
  "official_qa",
  "card_faq",
  "official_database",
  "official_database_card_page",
  "official_response",
  "official_response_screenshot",
  "official_response_unverified",
  "pending_adjustment",
]);

const OFFICIAL_RESPONSE_SOURCE_TYPES = new Set([
  "official_response",
  "official_response_screenshot",
  "official_response_unverified",
  "pending_adjustment",
]);

const OFFICIAL_RESPONSE_DISPLAY_STATUSES = new Set([
  "official_database_confirmed",
  "official_response_confirmed",
  "provisional_official_response",
  "pending_adjustment",
  "unknown",
]);

export function normalizeOfficialResponses(payloadOrRecords = []) {
  const records = Array.isArray(payloadOrRecords)
    ? payloadOrRecords
    : payloadOrRecords?.records || payloadOrRecords?.officialResponses || [];
  return records
    .map(normalizeOfficialResponse)
    .filter(Boolean);
}

export function normalizeOfficialResponse(record) {
  if (!record || typeof record !== "object") return null;
  const sourceType = normalizeOfficialResponseSourceType(record.sourceType);
  if (!sourceType) return null;
  const id = String(record.id || record.responseId || "").trim();
  if (!id) return null;

  const traceable = sourceType === "official_response" && hasTraceableOfficialResponseSource(record);
  const provisional = sourceType === "official_response_screenshot";
  const maxStatus = normalizeOfficialResponseMaxStatus(record.maxStatus, sourceType, traceable);
  const displayStatus = normalizeOfficialResponseDisplayStatus(record.displayStatus, sourceType, traceable);
  const officialVerdict = sourceType === "pending_adjustment" ? "unknown" : (record.verdict ?? "unknown");
  const officialText = cleanText(record.officialText || record.evidenceText || "");
  const explanation = cleanText(record.explanation || "");
  const scenario = cleanText(record.scenario || "");

  return {
    id,
    recordType: traceable
      ? "official-response"
      : provisional
        ? "official-response-screenshot"
        : `official-response-${sourceType.replace(/^official_response_?/, "")}`,
    title: cleanText(record.title || id),
    question: scenario || cleanText(record.question || record.questionText || record.title || ""),
    conclusion: cleanText([
      officialText,
      explanation,
      verdictText(officialVerdict),
    ].filter(Boolean).join("\n")),
    cards: Array.isArray(record.cards) ? record.cards.map(String).filter(Boolean) : [],
    cardIds: Array.isArray(record.cardIds) ? record.cardIds.map(String).filter(Boolean) : [],
    keywords: [
      ...(Array.isArray(record.questionTypes) ? record.questionTypes : []),
      ...(Array.isArray(record.tags) ? record.tags : []),
    ].map(String).filter(Boolean),
    questionTypes: Array.isArray(record.questionTypes) ? record.questionTypes.map(String).filter(Boolean) : [],
    sourceType,
    sourceUrl: record.sourceUrl || "",
    sourceNote: record.sourceNote || "",
    officialText,
    evidenceText: cleanText(record.evidenceText || officialText),
    screenshotPath: record.screenshotPath || "",
    officialVerdict,
    explanation,
    scenario,
    maxStatus,
    displayStatus,
    traceable,
    updatedAt: String(record.updatedAt || record.collectedAt || ""),
    collectedAt: String(record.collectedAt || ""),
    responseId: String(record.responseId || ""),
    tags: Array.isArray(record.tags) ? record.tags.map(String).filter(Boolean) : [],
    watchOfficialDb: normalizeWatchOfficialDb(record.watchOfficialDb),
    sources: buildOfficialResponseSources(record, sourceType, traceable),
  };
}

export function isConfirmableOfficialResponse(record) {
  return record?.sourceType === "official_response" &&
    record?.traceable === true &&
    record?.maxStatus === "confirmed" &&
    record?.recordType === "official-response";
}

export function isProvisionalOfficialResponse(record) {
  return record?.sourceType === "official_response_screenshot" &&
    record?.maxStatus === "unconfirmed" &&
    record?.recordType === "official-response-screenshot";
}

export function buildProvisionalAnswerFromOfficialResponse(record) {
  if (!isProvisionalOfficialResponse(record)) return null;
  return {
    status: record.displayStatus || "provisional_official_response",
    sourceType: record.sourceType,
    evidenceIds: [record.id].filter(Boolean),
    verdict: record.officialVerdict ?? "unknown",
    explanation: record.explanation ||
      "根据事务局回答截图，最可能处理为：可以发动并支付 cost，但处理不进行。该回答目前未在官方数据库中找到直接 Q&A，因此不作为 confirmed。",
    displayStatus: record.displayStatus || "provisional_official_response",
    sourceNote: record.sourceNote || "",
    officialText: record.officialText || "",
    watchOfficialDb: Boolean(record.watchOfficialDb?.enabled),
    canRevalidate: Boolean(record.watchOfficialDb?.enabled),
    revalidationReason: record.watchOfficialDb?.enabled
      ? "official_database_direct_evidence_watch"
      : "watch_official_db_not_configured",
    watchOfficialDbConfig: record.watchOfficialDb || null,
  };
}

export function officialResponseMatchesSubQuestion(record, subQuestion) {
  if (!isProvisionalOfficialResponse(record) || !subQuestion) return false;
  const text = normalizeMatchText([
    record.title,
    record.question,
    record.conclusion,
    record.officialText,
    record.explanation,
    record.scenario,
    ...(record.keywords || []),
    ...(record.cards || []),
  ].filter(Boolean).join(" "));
  const sourceText = normalizeMatchText(`${subQuestion.sourceText || ""} ${subQuestion.askedResult || ""}`);
  const card = normalizeMatchText(subQuestion.card || "");
  const cardMatches = !card || card === "unknown"
    ? true
    : (record.cards || []).some((name) => {
        const key = normalizeMatchText(name);
        return key === card || key.includes(card) || card.includes(key);
      }) || text.includes(card);
  if (!cardMatches) return false;

  const questionTypes = new Set(record.questionTypes || []);
  const type = String(subQuestion.type || "unknown");
  const asksActivation = /(?:发动|發動|発動|activate)/iu.test(`${subQuestion.sourceText || ""} ${subQuestion.askedResult || ""}`);
  const asksCost = /(?:cost|コスト|代价|支付)/iu.test(`${subQuestion.sourceText || ""} ${subQuestion.askedResult || ""}`);
  const asksResolution = /(?:处理|処理|resolution|fusion|融合素材)/iu.test(`${subQuestion.sourceText || ""} ${subQuestion.askedResult || ""}`);
  const typeMatches = questionTypes.has(type) ||
    (type === "activation_condition" && questionTypes.has("cost")) ||
    (type === "resolution_handling" && (questionTypes.has("fusion_material") || questionTypes.has("cost"))) ||
    (type === "cost" && questionTypes.has("activation_condition")) ||
    (asksActivation && questionTypes.has("activation_condition")) ||
    (asksCost && questionTypes.has("cost")) ||
    (asksResolution && (questionTypes.has("resolution_handling") || questionTypes.has("fusion_material")));
  if (!typeMatches) return false;

  const actionTerms = actionTermsForSubQuestion(subQuestion);
  return actionTerms.length === 0 ||
    actionTerms.some((term) => text.includes(term)) ||
    actionTerms.some((term) => sourceText.includes(term));
}

export function hasTraceableOfficialResponseSource(record) {
  return Boolean(
    record?.sourceUrl ||
    record?.sourceNote ||
    record?.officialText ||
    record?.evidenceText ||
    record?.collectedAt ||
    record?.updatedAt ||
    record?.responseId
  );
}

export function isStructuredOfficialVerdict(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeOfficialResponseSourceType(value) {
  const sourceType = String(value || "").trim();
  return OFFICIAL_RESPONSE_SOURCE_TYPES.has(sourceType) ? sourceType : "";
}

function normalizeOfficialResponseMaxStatus(value, sourceType, traceable) {
  const requested = String(value || "").trim();
  if (sourceType === "official_response_screenshot") return "unconfirmed";
  if (sourceType === "pending_adjustment" || sourceType === "official_response_unverified") return "unknown";
  if (sourceType === "official_response" && traceable && requested !== "unknown" && requested !== "unconfirmed") return "confirmed";
  return "unknown";
}

function normalizeOfficialResponseDisplayStatus(value, sourceType, traceable) {
  const requested = String(value || "").trim();
  if (OFFICIAL_RESPONSE_DISPLAY_STATUSES.has(requested)) return requested;
  if (sourceType === "official_response_screenshot") return "provisional_official_response";
  if (sourceType === "pending_adjustment") return "pending_adjustment";
  if (sourceType === "official_response" && traceable) return "official_response_confirmed";
  return "unknown";
}

function normalizeWatchOfficialDb(value) {
  if (!value || typeof value !== "object") return null;
  return {
    enabled: value.enabled === true,
    cardIds: Array.isArray(value.cardIds) ? value.cardIds.map(String).filter(Boolean) : [],
    sourceUrls: Array.isArray(value.sourceUrls) ? value.sourceUrls.map(String).filter(Boolean) : [],
    queryTerms: Array.isArray(value.queryTerms) ? value.queryTerms.map(String).filter(Boolean) : [],
    expectedAskedResult: Array.isArray(value.expectedAskedResult) ? value.expectedAskedResult.map(String).filter(Boolean) : [],
    lastCheckedAt: String(value.lastCheckedAt || ""),
    lastResult: ["not_found", "found_direct_qa", "found_related_only"].includes(value.lastResult) ? value.lastResult : "",
  };
}

function buildOfficialResponseSources(record, sourceType, traceable) {
  const label = sourceType === "pending_adjustment"
    ? "调整中"
    : sourceType === "official_response_screenshot"
      ? "事务局回答截图"
    : sourceType === "official_response_unverified"
      ? "未验证官方回答转述"
      : "官方事务局回答";
  const detail = record.sourceUrl ||
    record.sourceNote ||
    record.responseId ||
    record.collectedAt ||
    record.updatedAt ||
    (traceable ? "可追溯官方回答" : "无法追溯来源");
  return [{ label, detail }];
}

function actionTermsForSubQuestion(subQuestion) {
  const terms = new Set();
  const type = String(subQuestion?.type || "");
  const askedResult = normalizeMatchText(subQuestion?.askedResult || "");
  if (type === "activation_condition" || /activate|发动|発動/u.test(askedResult)) {
    terms.add("发动");
    terms.add("発動");
    terms.add("activate");
  }
  if (type === "cost" || /cost|代价|コスト/u.test(askedResult)) {
    terms.add("cost");
    terms.add("コスト");
    terms.add("代价");
  }
  if (type === "resolution_handling" || /resolution|处理|処理/u.test(askedResult)) {
    terms.add("处理");
    terms.add("処理");
    terms.add("resolution");
  }
  if (/fusion|融合素材/u.test(askedResult) || String(subQuestion?.sourceText || "").includes("融合")) {
    terms.add("融合素材");
  }
  return [...terms].filter(Boolean).map(normalizeMatchText);
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』"'\s·・－ー_-]+/gu, "")
    .trim();
}

function verdictText(value) {
  if (!value || value === "unknown") return "";
  if (typeof value === "string") return value;
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
    .join("\n");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}
