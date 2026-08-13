/**
 * Return whether a resolved card is authorized to address the synchronized
 * local corpus. External lookup results may supply useful non-authoritative
 * card text, but they cannot address local FAQ/Q&A records until a stable
 * identity has been uniquely bound to the local catalogue.
 */
export function isRawGenericCorpusBoundCard(card) {
  if (!card || typeof card !== "object") return false;
  const isExternalIdentity = card.resolutionSource === "baige_identity_lookup"
    || card.source === "baige"
    || card.provider === "baige";
  if (isExternalIdentity) {
    return card.canonicalLocalIdentity === true
      && Boolean(normalizeRawGenericCorpusCardId(card.id || card.cardId));
  }
  return Boolean(normalizeRawGenericCorpusCardId(card.id || card.cardId));
}

/**
 * Return the synchronized-corpus identity, or an empty string when the card
 * has not been authorized to address that corpus.
 */
export function rawGenericCorpusCardId(card) {
  return isRawGenericCorpusBoundCard(card)
    ? normalizeRawGenericCorpusCardId(card.id || card.cardId)
    : "";
}

export function normalizeRawGenericCorpusCardId(value) {
  return String(value ?? "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}
