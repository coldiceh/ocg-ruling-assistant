// Mechanical summaries of a prepared evidence pack. Items are grouped by the
// source fields the packer already wrote (evidence group and recordType); no
// text is read or judged.
import { createHash } from "node:crypto";

// recordType values written by the packer (data/gemini-rule-qa-v1: rule
// atoms are "rule-doc", official Q&A "qa", card FAQ "card-faq").
const RECORD_TYPE_KINDS = Object.freeze({ "rule-doc": "rule", qa: "qa", "card-faq": "faq", faq: "faq" });

export function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// First sentence of an answer for the report table: Markdown markers
// (* # > ` and table pipes) are dropped for display only; it ends at the first
// 。！？!? or line break. The full answer stays in the result file.
export function firstSentence(text, maxChars = 160) {
  const plain = String(text || "").replace(/[*#>`|]/gu, "").trim();
  const lineEnd = plain.indexOf("\n");
  const firstLine = lineEnd >= 0 ? plain.slice(0, lineEnd) : plain;
  const match = /^.*?[。！？!?]/u.exec(firstLine);
  const sentence = (match ? match[0] : firstLine).trim();
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars)}…` : sentence;
}

export function evidenceItemKind(group, item = {}) {
  if (group === "rawRelatedEvidence") {
    const recordType = String(item.recordType || "");
    return RECORD_TYPE_KINDS[recordType] || (recordType ? `other:${recordType}` : "other");
  }
  if (group === "cardTexts" || group === "userProvidedCardTexts") return "card";
  return group;
}

export function summarizePromptBundle(promptBundle = {}) {
  const modelEvidence = promptBundle.modelEvidence && typeof promptBundle.modelEvidence === "object"
    ? promptBundle.modelEvidence : {};
  const sets = {};
  const add = (kind, id) => (sets[kind] ||= new Set()).add(id);
  for (const [group, items] of Object.entries(modelEvidence)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) add(evidenceItemKind(group, item), String(item?.id ?? item?.cardId ?? item?.name ?? ""));
  }
  // Card texts reach the final prompt through promptPayload.resolvedCards.
  const promptCards = Array.isArray(promptBundle.promptPayload?.resolvedCards)
    ? promptBundle.promptPayload.resolvedCards : [];
  for (const card of promptCards) add("card", String(card?.id ?? card?.name ?? ""));
  const byKind = Object.fromEntries(Object.entries(sets).map(([kind, ids]) => [kind, [...ids]]));
  return {
    promptChars: typeof promptBundle.prompt === "string" ? promptBundle.prompt.length : null,
    promptSha256: typeof promptBundle.prompt === "string" ? sha256Text(promptBundle.prompt) : null,
    allowedEvidenceIds: Array.isArray(promptBundle.allowedEvidenceIds) ? [...promptBundle.allowedEvidenceIds] : [],
    idsByKind: byKind,
    counts: Object.fromEntries(Object.entries(byKind).map(([kind, ids]) => [kind, ids.length])),
  };
}

function valueAtPath(root, dotted) {
  let value = root;
  for (const part of String(dotted).split(".").filter(Boolean)) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

// The rule-ToC stage (RULE_TOC_ADMIT_ENABLED) records its outcome here; the
// field set is the one written by backend/geminiBoundedEvidenceProvider.mjs.
export const RULE_TOC_SOURCE = "prepared.continuation.ruleQueryModel.bounded.ruleToc";
const RULE_TOC_KEY_LISTS = Object.freeze([
  ["selectedUnitKeys", "selectedCount"],
  ["admittedUnitKeys", "admittedCount"],
  ["inBaselineWindowUnitKeys", "inBaselineWindowCount"],
  ["inOtherLanesUnitKeys", "inOtherLanesCount"],
  ["selectedIntoPackUnitKeys", "selectedIntoPackCount"],
]);
const RULE_TOC_SCALARS = Object.freeze(["status", "error", "elapsedMs", "assetWaitMs", "inputTokens",
  "cachedInputTokens", "outputTokens", "reasoningTokens", "contractUsd", "officialListUsd", "accountedUsd",
  "tocUnits", "tocChars"]);

// The stage telemetry of one stored result: the prepared continuation, else
// the copy kept in a failed job's error record.
export function ruleTocOfResult(result) {
  return result?.prepared?.continuation?.ruleQueryModel?.bounded?.ruleToc
    ?? result?.evidence?.toc?.ruleToc
    ?? result?.error?.boundedRetrieval?.ruleToc
    ?? null;
}

// Flat view of the stage telemetry with every count present (counts are taken
// from the key lists when the stage did not write them, e.g. after a failure).
export function summarizeRuleToc(ruleToc) {
  if (!ruleToc || typeof ruleToc !== "object") return null;
  const summary = Object.fromEntries(RULE_TOC_SCALARS.map((key) => [key, ruleToc[key] ?? null]));
  for (const [list, count] of RULE_TOC_KEY_LISTS) {
    const keys = Array.isArray(ruleToc[list]) ? ruleToc[list] : null;
    summary[list] = keys;
    summary[count] = Number.isFinite(ruleToc[count]) ? ruleToc[count] : keys ? keys.length : null;
  }
  summary.notAdmitted = Array.isArray(ruleToc.notAdmitted) ? ruleToc.notAdmitted : null;
  summary.notAdmittedCount = summary.notAdmitted ? summary.notAdmitted.length : null;
  summary.attemptCount = Array.isArray(ruleToc.attempts) ? ruleToc.attempts.length : null;
  return summary;
}

/**
 * --toc-path override: reads string-id arrays (or {selectedIds|ids}) at the
 * given dot paths of {prepared, continuation, final}. Without it the runner
 * and report read RULE_TOC_SOURCE directly.
 */
export function findTocIds(roots, explicitPaths = []) {
  const found = [];
  for (const dotted of explicitPaths) {
    const value = valueAtPath(roots, dotted);
    const ids = stringArray(value) || stringArray(value?.selectedIds) || stringArray(value?.ids);
    if (ids) found.push({ path: dotted, ids });
  }
  return found;
}
