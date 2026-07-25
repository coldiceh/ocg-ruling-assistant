const RULING_RECORD_TYPES = new Set([
  "qa",
  "card-faq",
  "official-database",
  "official-response",
  "ruling",
]);

const RULING_BODY_FIELDS = [
  "question",
  "answer",
  "conclusion",
  "content",
  "text",
  "steps",
];

const TRANSLATION_PLACEHOLDER_PATTERNS = [
  {
    code: "translation_mismatch_error",
    pattern: /\btranslation[\s_-]+mismatch(?:[\s_-]+error)?\b/iu,
  },
  {
    code: "translation_failure_placeholder",
    pattern: /\b(?:failed[\s_-]+to[\s_-]+translate|translation[\s_-]+(?:failed|failure|error|missing|unavailable|pending|not[\s_-]+available)|missing[\s_-]+translation|no[\s_-]+translation[\s_-]+available|untranslated[\s_-]+(?:text|content|placeholder))\b/iu,
  },
  {
    code: "translation_failure_placeholder",
    pattern: /(?:翻译|翻譯)(?:不匹配|失败|失敗|错误|錯誤|缺失|不可用|未完成|待补|待補)|(?:暂无|暫無|尚无|尚無|没有|沒有)(?:可用的?)?(?:翻译|翻譯)|翻訳(?:不一致|失敗|エラー|未完了|利用できません)/u,
  },
];

export function detectTranslationPlaceholder(value) {
  const text = normalizeText(value);
  if (!text) return null;
  for (const entry of TRANSLATION_PLACEHOLDER_PATTERNS) {
    const match = text.match(entry.pattern);
    if (match) return { code: entry.code, match: match[0] };
  }
  return null;
}

export function selectUsableLocalizedRulingText(localizations = {}, fields = [], {
  localeOrder = ["ja", "cn", "zh-CN", "en"],
} = {}) {
  if (!localizations || typeof localizations !== "object") return null;
  const requestedFields = [...new Set(
    (Array.isArray(fields) ? fields : [fields])
      .map((field) => String(field || "").trim())
      .filter(Boolean),
  )];
  const orderedLocales = [...new Set([
    ...localeOrder.map((locale) => String(locale || "").trim()).filter(Boolean),
    ...Object.keys(localizations),
  ])];

  for (const locale of orderedLocales) {
    const localized = localizations[locale];
    const candidates = typeof localized === "string"
      ? [{ field: "", value: localized }]
      : requestedFields.map((field) => ({ field, value: localized?.[field] }));
    for (const candidate of candidates) {
      const text = normalizeText(candidate.value);
      if (!text || detectTranslationPlaceholder(text)) continue;
      return {
        text,
        locale,
        field: candidate.field,
      };
    }
  }
  return null;
}

export function findRulingDataQualityIssues(records = []) {
  const issues = [];
  const sourceRecords = Array.isArray(records) ? records : [];
  for (let recordIndex = 0; recordIndex < sourceRecords.length; recordIndex += 1) {
    const record = sourceRecords[recordIndex];
    const recordType = String(record?.recordType || "").trim();
    if (!RULING_RECORD_TYPES.has(recordType)) continue;
    for (const field of RULING_BODY_FIELDS) {
      for (const { path, text } of collectText(record?.[field], field)) {
        const detected = detectTranslationPlaceholder(text);
        if (!detected) continue;
        issues.push({
          type: "translation_placeholder",
          code: detected.code,
          recordIndex,
          recordId: String(record?.id || ""),
          recordType,
          field: path,
          match: detected.match,
          preview: truncate(normalizeText(text).replace(/\s+/gu, " "), 160),
        });
      }
    }
  }
  return dedupeIssues(issues);
}

export function formatRulingDataQualityIssue(issue = {}) {
  const record = issue.recordId || "(unknown record)";
  const field = issue.field || "(unknown field)";
  const preview = issue.preview ? `: ${issue.preview}` : "";
  return `Ruling content quality failure [${issue.code || issue.type || "unknown"}] in ${record}.${field}${preview}`;
}

export function quarantineRulingData(records = [], previousRecords = []) {
  const current = Array.isArray(records) ? records : [];
  const previous = Array.isArray(previousRecords) ? previousRecords : [];
  const issues = findRulingDataQualityIssues(current);
  const unhealthyIndexes = new Set(issues.map((issue) => issue.recordIndex));
  const healthyPreviousById = new Map(
    previous
      .filter((record) => record?.id && findRulingDataQualityIssues([record]).length === 0)
      .map((record) => [String(record.id), record]),
  );
  const retainedPreviousIds = [];
  const droppedIds = [];
  const output = current.flatMap((record, recordIndex) => {
    const id = String(record?.id || "");
    if (!unhealthyIndexes.has(recordIndex)) return [record];
    const previousRecord = healthyPreviousById.get(id);
    if (previousRecord) {
      retainedPreviousIds.push(id);
      return [previousRecord];
    }
    droppedIds.push(id);
    return [];
  });

  return {
    records: output,
    issues,
    retainedPreviousIds: [...new Set(retainedPreviousIds)],
    droppedIds: [...new Set(droppedIds)],
  };
}

function collectText(value, path) {
  if (typeof value === "string") return [{ path, text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => collectText(item, `${path}[${index}]`));
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim();
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.recordId}:${issue.field}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
