// Mechanical summaries of a prepared evidence pack. Items are grouped by the
// source fields the packer already wrote (evidence group and recordType); no
// text is read or judged.
import { createHash } from "node:crypto";

const QA_RECORD_TYPES = new Set(["qa", "faq"]);

export function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// First sentence of an answer for the report table (markdown emphasis
// characters removed; ends at the first 。！？!? or line break).
export function firstSentence(text, maxChars = 160) {
  const plain = String(text || "").replace(/[*#>`_|]/gu, "").trim();
  const lineEnd = plain.indexOf("\n");
  const firstLine = lineEnd >= 0 ? plain.slice(0, lineEnd) : plain;
  const match = /^.*?[。！？!?]/u.exec(firstLine);
  const sentence = (match ? match[0] : firstLine).trim();
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars)}…` : sentence;
}

export function evidenceItemKind(group, item = {}) {
  if (group === "rawRelatedEvidence") {
    const recordType = String(item.recordType || "");
    return QA_RECORD_TYPES.has(recordType) ? recordType : "rule";
  }
  if (group === "cardTexts" || group === "userProvidedCardTexts") return "card";
  return group;
}

export function summarizePromptBundle(promptBundle = {}) {
  const modelEvidence = promptBundle.modelEvidence && typeof promptBundle.modelEvidence === "object"
    ? promptBundle.modelEvidence : {};
  const byKind = {};
  for (const [group, items] of Object.entries(modelEvidence)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const kind = evidenceItemKind(group, item);
      const id = String(item?.id ?? item?.cardId ?? item?.name ?? "");
      (byKind[kind] ||= []).push(id);
    }
  }
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

/**
 * Locates the rule-ToC admitted unit ids in a job's prepared output. The ToC
 * stage lives on another branch, so the field is not known here: explicit
 * --toc-path values win; otherwise every telemetry key whose name contains
 * "toc" is visited and string-id arrays under it are collected. Large text
 * fields (prompt, evidence bodies) are not searched.
 */
export function findTocIds(roots, explicitPaths = [], { maxDepth = 8 } = {}) {
  const found = [];
  if (explicitPaths.length) {
    for (const dotted of explicitPaths) {
      const value = valueAtPath(roots, dotted);
      const ids = stringArray(value) || stringArray(value?.selectedIds) || stringArray(value?.ids);
      if (ids) found.push({ path: dotted, ids });
    }
    return found;
  }
  const seen = new WeakSet();
  const visit = (value, pathParts, underToc, depth) => {
    if (!value || typeof value !== "object" || depth > maxDepth || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (underToc && stringArray(value) && value.length) found.push({ path: pathParts.join("."), ids: value });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (["prompt", "promptPayload", "modelEvidence", "text", "body", "cardTexts"].includes(key)) continue;
      // "ruleToc", "tocAdmit", "rule_toc", "TOC" — not "protocol".
      const tocKey = /^toc|[^a-z]toc|Toc|TOC/u.test(key);
      visit(child, [...pathParts, key], underToc || tocKey, depth + 1);
    }
  };
  for (const [name, root] of Object.entries(roots)) visit(root, [name], false, 0);
  return found;
}

export const DEFAULT_TOC_SEARCH_ROOTS = Object.freeze([
  "continuation.ruleQueryModel",
  "continuation.evidence.debug",
  "continuation.timingsMs",
]);
