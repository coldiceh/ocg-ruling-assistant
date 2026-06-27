export const RULE_ERAS = Object.freeze([
  "pre_2011_ignition_priority",
  "post_2011_ocg_ignition_priority",
  "mr3",
  "mr4_link_initial",
  "mr2020_revision",
  "current",
]);

export const RULING_SOURCE_TYPES = Object.freeze([
  "official_qa",
  "card_faq",
  "rulebook",
  "rules_update",
  "official_response",
  "user_provided_card_text",
  "manual_note",
]);

const eraRank = new Map(RULE_ERAS.map((era, index) => [era, index]));

export function normalizeRulingSourceMetadata(source = {}, overrides = {}) {
  const text = [source.title, source.text, source.conclusion, source.source, source.sourceUrl].filter(Boolean).join(" ");
  const sourceType = validSourceType(overrides.sourceType || source.sourceType) || inferSourceType(source);
  const lastCheckedAt = normalizeDateValue(overrides.lastCheckedAt || source.lastCheckedAt || source.updatedAt || source.generatedAt);
  const format = normalizeFormat(overrides.format || source.format || inferFormat(text, sourceType));
  const ruleEra = normalizeRuleEra(overrides.ruleEra || source.ruleEra || inferRuleEra(text, sourceType, lastCheckedAt));
  const staleRisk = normalizeRisk(overrides.staleRisk || source.staleRisk || defaultStaleRisk(sourceType, lastCheckedAt));
  return {
    id: String(overrides.id || source.id || "unknown"),
    sourceType,
    effectiveFrom: normalizeDateValue(overrides.effectiveFrom || source.effectiveFrom),
    effectiveTo: normalizeDateValue(overrides.effectiveTo || source.effectiveTo),
    lastCheckedAt,
    locale: normalizeLocale(overrides.locale || source.locale || inferLocale(text)),
    format,
    ruleEra,
    staleRisk,
    supersededBy: unique(overrides.supersededBy || source.supersededBy || []),
  };
}

export function compareRuleEra(left, right) {
  return (eraRank.get(normalizeRuleEra(left)) ?? -1) - (eraRank.get(normalizeRuleEra(right)) ?? -1);
}

export function sourcePredatesRuleChange(metadata, change) {
  if (!metadata || !change) return false;
  if (metadata.supersededBy?.length) return true;
  if (metadata.effectiveTo && dateUpperBound(metadata.effectiveTo) < dateLowerBound(change.effectiveFrom)) return true;
  if (change.ruleEra && compareRuleEra(metadata.ruleEra, change.ruleEra) < 0) return true;
  if (metadata.effectiveFrom && dateUpperBound(metadata.effectiveFrom) < dateLowerBound(change.effectiveFrom) && metadata.ruleEra !== "current") return true;
  return false;
}

export function sourceIsCurrentForChange(metadata, change, targetFormat = "ocg") {
  if (!metadata || metadata.supersededBy?.length || metadata.effectiveTo) return false;
  if (metadata.format !== "unknown" && metadata.format !== targetFormat) return false;
  if (metadata.staleRisk === "high") return false;
  if (change?.ruleEra && compareRuleEra(metadata.ruleEra, change.ruleEra) >= 0) return true;
  if (metadata.ruleEra === "current") return true;
  return Boolean(metadata.lastCheckedAt && change?.effectiveFrom && dateLowerBound(metadata.lastCheckedAt) >= dateLowerBound(change.effectiveFrom));
}

function inferSourceType(source) {
  if (source.recordType === "card-faq") return "card_faq";
  if (source.recordType === "qa") return "official_qa";
  if (source.recordType === "rule-doc") return /修订|改订|revision|update/iu.test(source.title || "") ? "rules_update" : "rulebook";
  if (source.recordType === "official-response") return "official_response";
  if (source.recordType === "user-provided-card-text") return "user_provided_card_text";
  return "manual_note";
}

function inferRuleEra(text, sourceType, lastCheckedAt) {
  if (/2017|MR4|新大师规则|link initial/iu.test(text)) return "mr4_link_initial";
  if (/2020年4月|2020 revision|MR2020/iu.test(text)) return "mr2020_revision";
  if (/2011.*(?:以前|before)|起动效果.*优先权/iu.test(text)) return "pre_2011_ignition_priority";
  if (sourceType === "official_qa" || sourceType === "card_faq" || sourceType === "official_response") return lastCheckedAt ? "current" : "mr2020_revision";
  return "current";
}

function inferFormat(text, sourceType) {
  if (/Master Duel|大师决斗/iu.test(text)) return "master_duel";
  if (/\bTCG\b/iu.test(text)) return "tcg";
  if (/\bOCG\b|YGOResources|遊戯王カードデータベース/iu.test(text) || ["official_qa", "card_faq", "rulebook", "rules_update"].includes(sourceType)) return "ocg";
  return "unknown";
}

function inferLocale(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return "ocg-ja";
  if (/[A-Za-z]{4}/u.test(text) && !/[\u3400-\u9fff]/u.test(text)) return "tcg-en";
  return "zh";
}

function defaultStaleRisk(sourceType, lastCheckedAt) {
  if (sourceType === "user_provided_card_text" || sourceType === "manual_note") return "possible";
  return lastCheckedAt ? "none" : "possible";
}

function validSourceType(value) {
  return RULING_SOURCE_TYPES.includes(value) ? value : "";
}

function normalizeRuleEra(value) {
  return RULE_ERAS.includes(value) ? value : "current";
}

function normalizeRisk(value) {
  return ["none", "possible", "high"].includes(value) ? value : "possible";
}

function normalizeFormat(value) {
  return ["ocg", "tcg", "master_duel", "unknown"].includes(value) ? value : "unknown";
}

function normalizeLocale(value) {
  return ["ocg-ja", "tcg-en", "zh"].includes(value) ? value : "zh";
}

function normalizeDateValue(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}(?:-\d{2})?(?:-\d{2})?/u.test(text)) return text.slice(0, 10).replace(/-00(?:-00)?$/u, "");
  return null;
}

function dateLowerBound(value) {
  const parts = String(value || "").split("-").map(Number);
  return Date.UTC(parts[0] || 0, Math.max(0, (parts[1] || 1) - 1), parts[2] || 1);
}

function dateUpperBound(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length === 1) return Date.UTC(parts[0] || 0, 11, 31);
  if (parts.length === 2) return Date.UTC(parts[0] || 0, parts[1] || 1, 0);
  return Date.UTC(parts[0] || 0, Math.max(0, (parts[1] || 1) - 1), parts[2] || 1);
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}
