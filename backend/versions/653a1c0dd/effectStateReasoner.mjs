// Frozen software snapshot from Git revision 653a1c0dd.
import { analyzeDuelStateTransition } from "./duelStateReasoner.mjs";

export function analyzeEffectStateTransition({
  userQuery = "",
  cardTexts = [],
  corroboratingEvidence = [],
  operationLegality = null,
  resolvedCards = [],
} = {}) {
  const transition = analyzeDuelStateTransition({
    userQuery: String(userQuery || ""),
    resolvedCards,
    cardTexts,
  });
  if (transition.status !== "resolved" || transition.complete !== true) return transition;

  const activationEvidence = findActivationEvidence(corroboratingEvidence, operationLegality, transition);
  if (!activationEvidence) return transition;
  return {
    ...transition,
    activationEvidenceType: activationEvidence.sourceType,
    evidenceIds: unique([activationEvidence.id, ...(transition.evidenceIds || [])]),
  };
}

function findActivationEvidence(items = [], operationLegality = null, transition = {}) {
  const sourceNames = transitionSourceNames(transition);
  if (!sourceNames.length) return null;
  for (const item of items || []) {
    const verdict = item?.officialVerdict ?? item?.verdict;
    if (
      verdict
      && typeof verdict === "object"
      && verdict.activation === "can_activate"
      && evidenceReferencesSource(item, sourceNames)
    ) {
      return {
        id: String(item.id || ""),
        sourceType: item.sourceType || item.type || "related",
      };
    }
  }
  const check = (operationLegality?.checks || []).find((item) => (
    item.status === "legal"
    && /发动|發動|発動|activate/iu.test([item.action, item.legalityQuestion, item.conclusion].filter(Boolean).join(" "))
    && evidenceReferencesSource(item, sourceNames)
  ));
  return check
    ? { id: `operation-check-${check.operationId}`, sourceType: "operation_check" }
    : null;
}

function transitionSourceNames(transition = {}) {
  const premise = transition.program?.activationPremises?.[0];
  const source = (transition.program?.cardPrograms || []).find((program) => (
    String(program.definitionId) === String(premise?.sourceDefinitionId)
  ));
  return unique([source?.name, ...(source?.names || [])]);
}

function evidenceReferencesSource(item = {}, sourceNames = []) {
  const haystack = normalizeEvidenceText([
    ...(item.cards || []),
    ...(item.cardNames || []),
    item.question,
    item.scenario,
    item.title,
    item.text,
    item.action,
    item.legalityQuestion,
    item.conclusion,
  ].filter(Boolean).join(" "));
  return sourceNames.some((name) => {
    const key = normalizeEvidenceText(name);
    return key.length >= 3 && haystack.includes(key);
  });
}

function normalizeEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/喰/gu, "食")
    .replace(/[「」『』《》【】“”"'：:・·･．.－—–_\-\s，,。.!！?？;；、()（）\[\]{}]/gu, "");
}

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function attachUserQueryToCardTexts(cardTexts = [], userQuery = "") {
  return (cardTexts || []).map((item) => ({ ...item, _userQuery: String(userQuery || "") }));
}
