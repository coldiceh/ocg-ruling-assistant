import { createHash } from "node:crypto";

import { ADMIN_EVIDENCE_CATEGORIES } from "./adminEvidenceArchive.mjs";

export const ADMIN_EVIDENCE_VARIANTS = Object.freeze([
  "full",
  "card_text_only",
  "without_lua",
]);

export const DEFAULT_ADMIN_EVIDENCE_VARIANT = "full";

const ADMIN_EVIDENCE_VARIANT_SET = new Set(ADMIN_EVIDENCE_VARIANTS);

/**
 * Strictly normalizes the admin-only model-visible evidence projection.
 *
 * The variant is deliberately independent of card names, passcodes and case
 * identifiers. It selects a generic projection over one immutable source
 * Evidence Snapshot; it never changes or regenerates that snapshot.
 */
export function normalizeAdminEvidenceVariant(
  value,
  fallback = DEFAULT_ADMIN_EVIDENCE_VARIANT,
) {
  const normalized = String(value ?? "").trim().toLowerCase() || String(fallback || "").trim().toLowerCase();
  if (!ADMIN_EVIDENCE_VARIANT_SET.has(normalized)) {
    const error = new RangeError(
      `evidenceVariant must be one of: ${ADMIN_EVIDENCE_VARIANTS.join(", ")}`,
    );
    error.code = "admin_evidence_variant_invalid";
    throw error;
  }
  return normalized;
}

/**
 * Returns the exact evidence packet that both the final model and semantic
 * validator are allowed to see for a variant.
 *
 * `full` and `without_lua` share the complete decision packet. Lua is a
 * separate packet and is removed by the final-input builder. `card_text_only`
 * rebuilds a minimal packet from complete card-text archive documents when
 * available, with a bounded-packet fallback for historical fixtures.
 */
export function projectAdminModelEvidencePacket({
  snapshot,
  modelPacket,
  evidenceVariant = DEFAULT_ADMIN_EVIDENCE_VARIANT,
} = {}) {
  const variant = normalizeAdminEvidenceVariant(evidenceVariant);
  if (variant !== "card_text_only") return modelPacket;

  const archiveItems = completeCardTextItemsFromArchive(snapshot?.evidence?.evidenceArchive);
  const fallbackItems = Array.isArray(modelPacket?.evidenceItems)
    ? modelPacket.evidenceItems.filter(isCardTextEvidence)
    : [];
  return {
    schemaVersion: Number(modelPacket?.schemaVersion) || 2,
    evidenceItems: archiveItems.length > 0 ? archiveItems : cloneJson(fallbackItems),
  };
}

export function adminEvidenceVariantIncludesLegacyLua(value) {
  return normalizeAdminEvidenceVariant(value) === "full";
}

export function hashAdminFinalInput(input) {
  return createHash("sha256").update(String(input), "utf8").digest("hex");
}

function completeCardTextItemsFromArchive(archive) {
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) return [];
  const documents = new Map(
    (Array.isArray(archive.documents) ? archive.documents : [])
      .filter((item) => item && typeof item === "object" && typeof item.bodyHash === "string")
      .map((item) => [item.bodyHash, item]),
  );
  const seenSubstances = new Set();
  const result = [];
  for (const occurrence of Array.isArray(archive.occurrences) ? archive.occurrences : []) {
    if (!isCardTextEvidence(occurrence)) continue;
    const document = documents.get(occurrence.bodyHash);
    const body = String(document?.text || "");
    if (!body) continue;
    const substanceKey = String(occurrence.substanceHash || occurrence.bodyHash || body);
    if (seenSubstances.has(substanceKey)) continue;
    seenSubstances.add(substanceKey);
    result.push(compactObject({
      packetItemId: `ablation_card_text_${sha256(substanceKey).slice(0, 20)}`,
      evidenceId: occurrence.evidenceId || `card_text:${sha256(body)}`,
      evidenceIdAliased: false,
      category: ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
      authority: occurrence.authority || null,
      direct: occurrence.direct === true,
      current: occurrence.current !== false,
      body,
      bodyExcerpted: false,
    }));
  }
  return result;
}

function isCardTextEvidence(value) {
  return String(value?.category || "").trim().toLowerCase()
    === ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
