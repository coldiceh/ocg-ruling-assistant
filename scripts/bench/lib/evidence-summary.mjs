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

// Display labels of the evidence pack sent to the final model, grouped for a
// report: rule atoms by source document and section title path (no text), Q&A
// by official number, card FAQ by record id. Identity fields only; the " ¶"
// permalink glyph of the rule pages is dropped for display.
const dropPilcrow = (value) => String(value ?? "").replace(/\s*¶\s*$/u, "").replace(/\s+/gu, " ").trim();

function recordOf(item) {
  try {
    const record = JSON.parse(item?.text ?? "null");
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

export function packedEvidenceLabels(promptBundle = {}) {
  const items = Array.isArray(promptBundle?.modelEvidence?.rawRelatedEvidence)
    ? promptBundle.modelEvidence.rawRelatedEvidence : [];
  const sections = new Map();
  const qa = [];
  const other = [];
  for (const item of items) {
    const id = String(item?.id ?? "");
    if (item?.recordType === "rule-doc") {
      const titlePath = Array.isArray(item.sourceSection?.titlePath) && item.sourceSection.titlePath.length
        ? item.sourceSection.titlePath : [item.title || ""];
      const label = `${item.sourceId || item.parentSourceId || "?"} › ${titlePath.map(dropPilcrow).filter(Boolean).join(" > ")}`;
      if (!sections.has(label)) sections.set(label, { label, atomIds: [], atoms: [] });
      const section = sections.get(label);
      section.atomIds.push(id);
      section.atoms.push(/:atom:(\d+)$/u.exec(id)?.[1] ?? id);
      continue;
    }
    const record = recordOf(item);
    if (item?.recordType === "qa") {
      const number = /^ygoresources-qa-(\d+)$/u.exec(String(record?.id || ""))?.[1]
        || /\/qa\/(\d+)(?:$|[?#])/u.exec(String(item.sourceUrl || ""))?.[1];
      qa.push({ id, label: number ? `QA#${number}` : `QA ${id.slice(0, 12)}` });
    } else if (item?.recordType === "card-faq") {
      qa.push({ id, label: `FAQ ${record?.id || dropPilcrow(item.title) || id.slice(0, 12)}` });
    } else {
      other.push({ id, label: `${item?.recordType || "other"} ${id.slice(0, 24)}` });
    }
  }
  // Atom numbers in source order within a section (display only).
  for (const section of sections.values()) {
    if (!section.atoms.every((atom) => /^\d+$/u.test(atom))) continue;
    const order = section.atoms.map((atom, index) => [Number(atom), index]).sort((left, right) => left[0] - right[0]);
    section.atoms = order.map(([, index]) => section.atoms[index]);
    section.atomIds = order.map(([, index]) => section.atomIds[index]);
  }
  return { ruleSections: [...sections.values()], qa, other };
}

