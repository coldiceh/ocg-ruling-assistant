import { RULE_CHANGE_INDEX, findRuleChangesForIssueFrames } from "./ruleChangeIndex.mjs";
import { normalizeRulingSourceMetadata, sourceIsCurrentForChange, sourcePredatesRuleChange } from "./rulingVersioning.mjs";

export function checkStaleness({ issueFrames = [], evidence = [], ruleChangeIndex = RULE_CHANGE_INDEX, targetFormat = "ocg", targetDate = "current" } = {}) {
  const frames = normalizeFrames(issueFrames);
  const changes = findRuleChangesForIssueFrames(frames, ruleChangeIndex);
  const sources = flattenEvidence(evidence).map((item) => ({ item, metadata: normalizeRulingSourceMetadata(item.metadata || item) }));
  const staleEvidenceIds = new Set();
  const currentEvidenceIds = new Set();
  let staleRisk = "none";

  for (const { item, metadata } of sources) {
    if (metadata.staleRisk === "high" || metadata.supersededBy.length) {
      staleEvidenceIds.add(String(item.id || metadata.id));
      staleRisk = "high";
    } else if (metadata.staleRisk === "possible") {
      staleRisk = maxRisk(staleRisk, "possible");
    }
    for (const change of changes) {
      if (sourcePredatesRuleChange(metadata, change)) {
        staleEvidenceIds.add(String(item.id || metadata.id));
        staleRisk = "high";
      } else if (sourceIsCurrentForChange(metadata, change, targetFormat)) {
        currentEvidenceIds.add(String(item.id || metadata.id));
      }
    }
  }

  if (changes.length && !currentEvidenceIds.size) staleRisk = maxRisk(staleRisk, staleEvidenceIds.size ? "high" : "possible");
  else if (changes.length && currentEvidenceIds.size && staleEvidenceIds.size) staleRisk = "possible";
  const hasStaleRisk = staleRisk !== "none" || Boolean(changes.length && !currentEvidenceIds.size);
  const userFacingWarning = !changes.length
    ? ""
    : currentEvidenceIds.size
      ? "该问题涉及曾经变更过的规则类别，已按当前规则判断。"
      : "该问题涉及规则变更，但当前资料不足以确认现行处理。";
  return {
    hasStaleRisk,
    staleRisk,
    matchedRuleChanges: changes.map((change) => ({ ...change })),
    staleEvidenceIds: [...staleEvidenceIds],
    currentEvidenceIds: [...currentEvidenceIds],
    userFacingWarning,
    debug: {
      targetFormat,
      targetDate,
      checkedEvidence: sources.map(({ item, metadata }) => ({ id: item.id || metadata.id, metadata })),
    },
  };
}

function flattenEvidence(value) {
  if (Array.isArray(value)) return value.flatMap(flattenEvidence);
  if (!value || typeof value !== "object") return [];
  if (value.id || value.metadata) return [value];
  return Object.values(value).flatMap(flattenEvidence);
}

function normalizeFrames(value) {
  if (Array.isArray(value)) return value;
  return [...(value.primaryIssueFrames || []), ...(value.secondaryIssueFrames || [])];
}

function maxRisk(left, right) {
  const rank = { none: 0, possible: 1, high: 2 };
  return rank[right] > rank[left] ? right : left;
}
