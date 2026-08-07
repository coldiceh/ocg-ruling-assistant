import { createHash } from "node:crypto";
import { assertAdminEvidenceSnapshot } from "./adminEvidenceSnapshot.mjs";
import { normalizeCardKey } from "./ragCardExtractor.mjs";

const PARSED_CARD_TEXT_CATEGORY = "parsed_card_text";
const RESOLVED_CARD_TEXT_COLLECTION = "cardTextCandidates.resolved";
const USER_CARD_TEXT_COLLECTION = "evidenceBuckets.userProvidedCardTexts";
const MAX_ERROR_ITEMS = 12;
const MAX_ERROR_VALUE_CHARS = 120;

/**
 * Deterministically verifies that every card candidate discovered before the
 * final ruling call has one identity and one complete card-text body in the
 * model-visible Evidence Packet. This is a transport gate, not a ruling
 * engine: it never upgrades evidence into a verdict.
 */
export function inspectAdminFinalEvidenceReadiness(snapshot) {
  assertAdminEvidenceSnapshot(snapshot);
  const evidence = snapshot.evidence || {};
  const cardResolution = evidence.cardResolution || {};
  const closedCandidateScope = cardResolution.candidateScope === "provided_closed"
    && asArray(cardResolution.providedCardNameCandidates).length > 0;
  const candidates = collectCandidateSurfaces({
    cardResolution,
    preparation: evidence.preparation,
    closedCandidateScope,
  });
  const resolvedBindings = collectResolvedBindings(cardResolution.resolvedCards);
  const userProvidedBindings = collectUserProvidedBindings(
    cardResolution.userProvidedCardTexts,
    resolvedBindings,
  );
  const allBindings = [...resolvedBindings, ...userProvidedBindings];
  const evidenceDecisionPacket = evidence.evidenceDecisionPacket || {};
  const visibleItems = Array.isArray(
    evidenceDecisionPacket?.modelPacket?.evidenceItems,
  )
    ? evidenceDecisionPacket.modelPacket.evidenceItems
    : [];
  const includedManifest = Array.isArray(evidenceDecisionPacket?.includedManifest)
    ? evidenceDecisionPacket.includedManifest
    : [];
  const archiveOccurrences = Array.isArray(evidence.evidenceArchive?.occurrences)
    ? evidence.evidenceArchive.occurrences
    : [];

  const bindings = candidates.map((candidate) => inspectCandidateBinding({
    candidate,
    allBindings,
    visibleItems,
    includedManifest,
    archiveOccurrences,
  }));
  const explicitlyUnresolved = closedCandidateScope ? [] : collectFlaggedCandidates(
    cardResolution.unresolvedMentions,
    "unresolved_parser_mention",
  ).filter((candidate) => !isSatisfiedUserProvidedUnknown(candidate, bindings));
  const ambiguousCandidates = closedCandidateScope ? [] : collectFlaggedCandidates(
    cardResolution.ambiguousMentions,
    "ambiguous_parser_mention",
  );
  const omittedCandidates = closedCandidateScope ? [] : collectFlaggedCandidates(
    cardResolution.omittedResolvedCards,
    "omitted_resolved_card",
  );
  const unresolvedCandidates = mergeCandidateLists(
    bindings
      .filter((binding) => binding.bindingStatus === "UNRESOLVED")
      .map(candidateSummary),
    explicitlyUnresolved,
  );
  const nonUniqueCandidates = bindings
    .filter((binding) => binding.bindingStatus === "AMBIGUOUS")
    .map(candidateSummary);
  const missingVisibleCardTexts = bindings
    .filter((binding) => (
      binding.bindingStatus === "RESOLVED"
      && binding.visibleCardText === false
      && binding.visibleCardTextExcerpted === false
    ))
    .map(candidateSummary);
  const excerptedVisibleCardTexts = bindings
    .filter((binding) => (
      binding.bindingStatus === "RESOLVED"
      && binding.visibleCardTextExcerpted === true
    ))
    .map(candidateSummary);

  return deepFreezeJson({
    ready:
      unresolvedCandidates.length === 0
      && nonUniqueCandidates.length === 0
      && ambiguousCandidates.length === 0
      && omittedCandidates.length === 0
      && missingVisibleCardTexts.length === 0
      && excerptedVisibleCardTexts.length === 0,
    candidateCount: candidates.length,
    bindings,
    unresolvedCandidates,
    ambiguousCandidates: mergeCandidateLists(
      ambiguousCandidates,
      nonUniqueCandidates,
    ),
    omittedCandidates,
    missingVisibleCardTexts,
    excerptedVisibleCardTexts,
  });
}

export function assertAdminFinalEvidenceReady(snapshot) {
  const inspection = inspectAdminFinalEvidenceReadiness(snapshot);
  if (inspection.ready) return inspection;

  const error = new Error(readinessErrorMessage(inspection));
  error.name = "AdminFinalEvidenceReadinessError";
  error.code = "admin_final_evidence_not_ready";
  error.status = 409;
  error.expose = true;
  error.publicMessage = error.message;
  error.details = boundedReadinessDetails(inspection);
  throw error;
}

function collectCandidateSurfaces({
  cardResolution = {},
  preparation = {},
  closedCandidateScope = false,
}) {
  const candidates = [];
  const add = (value, source) => {
    const surface = String(value || "").trim();
    const normalized = normalizeCardKey(surface);
    if (!surface || !normalized) return;
    candidates.push({ surface, normalized, source });
  };
  for (const card of asArray(cardResolution.resolvedCards)) {
    add(card?.input, "resolved_card_input");
    add(card?.name, "resolved_card_name");
    add(card?.cnName, "resolved_card_alias");
    add(card?.jaName, "resolved_card_alias");
    add(card?.jpName, "resolved_card_alias");
    add(card?.enName, "resolved_card_alias");
    for (const alias of asArray(card?.aliases)) add(alias, "resolved_card_alias");
  }
  for (const mention of asArray(cardResolution.providedCardNameCandidates)) {
    add(mention?.name ?? mention, "provided_card_name_candidate");
  }
  if (!closedCandidateScope) for (const mention of asArray(cardResolution.modelCardNameCandidates)) {
    add(mention?.name ?? mention, "resolved_model_candidate");
    if (typeof mention === "object") {
      add(mention?.originalText, "resolved_model_candidate_original_text");
    }
  }
  if (!closedCandidateScope) for (const mention of asArray(preparation?.extractedHints?.cardNameCandidates)) {
    add(mention?.name ?? mention, "preparation_model_candidate");
    if (typeof mention === "object") {
      add(mention?.originalText, "preparation_model_candidate_original_text");
    }
  }
  if (!closedCandidateScope) for (const mention of asArray(cardResolution.unresolvedMentions)) {
    add(mention?.input ?? mention, "unresolved_parser_mention");
  }
  if (!closedCandidateScope) for (const mention of asArray(cardResolution.ambiguousMentions)) {
    add(mention?.input ?? mention, "ambiguous_parser_mention");
  }
  if (!closedCandidateScope) for (const mention of asArray(cardResolution.omittedResolvedCards)) {
    add(mention?.input ?? mention, "omitted_resolved_card");
  }
  for (const item of asArray(cardResolution.userProvidedCardTexts)) {
    add(item?.name, "user_provided_card_text");
  }

  const byNormalized = new Map();
  for (const candidate of candidates) {
    const existing = byNormalized.get(candidate.normalized);
    if (!existing) {
      byNormalized.set(candidate.normalized, {
        candidate: candidate.surface,
        normalizedCandidate: candidate.normalized,
        sources: [candidate.source],
      });
      continue;
    }
    if (!existing.sources.includes(candidate.source)) existing.sources.push(candidate.source);
  }
  return [...byNormalized.values()]
    .map((candidate) => ({
      ...candidate,
      sources: candidate.sources.sort(),
    }))
    .sort((left, right) => left.normalizedCandidate.localeCompare(
      right.normalizedCandidate,
      "en",
    ));
}

function collectResolvedBindings(cards) {
  const byIdentity = new Map();
  for (const [index, card] of asArray(cards).entries()) {
    // An upstream resolver may retain an edit-distance candidate for audit
    // while explicitly marking that the queried surface was not verified.
    // Such a record must never become eligible merely because the surface was
    // also copied into aliases: the paid-call gate remains fail-closed.
    if (card?.identityVerificationStatus === "unverified") continue;
    const cardId = String(card?.id || card?.cardId || "").trim();
    const identity = cardId
      ? `id:${cardId}`
      : `name:${normalizeCardKey(card?.name || card?.input || "") || index}`;
    const surfaceKeys = cardSurfaceKeys(card);
    if (!surfaceKeys.size) continue;
    const existing = byIdentity.get(identity);
    if (existing) {
      for (const key of surfaceKeys) existing.surfaceKeys.add(key);
      continue;
    }
    byIdentity.set(identity, {
      bindingId: identity,
      source: "resolved_card",
      cardId: cardId || null,
      resolvedName: String(card?.name || card?.cnName || card?.input || "").trim() || null,
      surfaceKeys,
    });
  }
  return [...byIdentity.values()];
}

function collectUserProvidedBindings(items, resolvedBindings) {
  const bindings = [];
  const seen = new Set();
  for (const [index, item] of asArray(items).entries()) {
    const name = String(item?.name || "").trim();
    const text = String(item?.text || "").trim();
    const key = normalizeCardKey(name);
    if (!key || !text) continue;
    // A supplied transcription of an already resolved database card is
    // auxiliary evidence for that same identity, not a second card identity.
    if (resolvedBindings.some((binding) => binding.surfaceKeys.has(key))) continue;
    const identity = `user:${key}:${index}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    bindings.push({
      bindingId: identity,
      source: "user_provided_card_text",
      cardId: null,
      resolvedName: name,
      suppliedText: text,
      surfaceKeys: new Set([key]),
    });
  }
  return bindings;
}

function inspectCandidateBinding({
  candidate,
  allBindings,
  visibleItems,
  includedManifest,
  archiveOccurrences,
}) {
  const matches = allBindings.filter((binding) => (
    binding.surfaceKeys.has(candidate.normalizedCandidate)
  ));
  if (matches.length !== 1) {
    return {
      ...candidate,
      bindingStatus: matches.length > 1 ? "AMBIGUOUS" : "UNRESOLVED",
      matchCount: matches.length,
      cardId: null,
      resolvedName: null,
      source: null,
      visibleCardText: false,
      visibleCardTextExcerpted: false,
      visibleEvidenceId: null,
    };
  }

  const match = matches[0];
  const visible = inspectVisibleCardText({
    binding: match,
    visibleItems,
    includedManifest,
    archiveOccurrences,
  });
  return {
    ...candidate,
    bindingStatus: "RESOLVED",
    matchCount: 1,
    cardId: match.cardId,
    resolvedName: match.resolvedName,
    source: match.source,
    visibleCardText: visible.complete,
    visibleCardTextExcerpted: visible.excerpted,
    visibleEvidenceId: visible.evidenceId,
  };
}

function inspectVisibleCardText({
  binding,
  visibleItems,
  includedManifest,
  archiveOccurrences,
}) {
  const expectedIds = expectedEvidenceIds(binding);
  const expectedOccurrences = archiveOccurrences.filter((occurrence) => (
    occurrence?.category === PARSED_CARD_TEXT_CATEGORY
    && expectedCollectionFor(binding).test(String(occurrence?.collection || ""))
    && expectedIds.has(String(occurrence?.evidenceId || ""))
    && String(occurrence?.bodyHash || "")
  ));
  if (expectedOccurrences.length === 0) {
    return { complete: false, excerpted: false, evidenceId: null };
  }
  const expectedBodyHashes = new Set(
    expectedOccurrences.map((occurrence) => String(occurrence.bodyHash)),
  );
  const expectedSubstanceHashes = new Set(
    expectedOccurrences.map((occurrence) => String(occurrence.substanceHash)),
  );
  const expectedOccurrenceIds = new Set(
    expectedOccurrences.map((occurrence) => String(occurrence.occurrenceId)),
  );
  const manifestsByPacketItemId = uniqueManifestIndex(includedManifest);
  const matchingItems = visibleItems.flatMap((item) => {
    if (
      item?.category !== PARSED_CARD_TEXT_CATEGORY
      || !String(item?.body || "").trim()
    ) return [];
    const packetItemId = String(item?.packetItemId || "");
    const manifest = manifestsByPacketItemId.get(packetItemId);
    if (!packetItemId || !manifest) return [];
    const manifestSubstanceHash = String(manifest.substanceHash || "");
    if (
      !expectedSubstanceHashes.has(manifestSubstanceHash)
      || packetItemId !== `packet_item_${manifestSubstanceHash.slice(0, 20)}`
      || !expectedBodyHashes.has(String(manifest.bodyHash || ""))
      || !intersects(itemEvidenceIds(manifest), expectedIds)
      || !intersects(stringSet(manifest.occurrenceIds), expectedOccurrenceIds)
      || !visibleEvidenceIdBelongsToManifest(item, manifest)
    ) return [];
    if (
      item?.bodyExcerpted !== true
      && sha256(String(item.body)) !== String(manifest.bodyHash || "")
    ) return [];
    return [{ item, manifest }];
  });
  const complete = matchingItems.find(({ item }) => item?.bodyExcerpted !== true);
  if (complete) {
    return {
      complete: true,
      excerpted: false,
      evidenceId: firstMatchingValue(itemEvidenceIds(complete.manifest), expectedIds),
    };
  }
  const excerpted = matchingItems.find(({ item }) => item?.bodyExcerpted === true);
  return {
    complete: false,
    excerpted: Boolean(excerpted),
    evidenceId: excerpted
      ? firstMatchingValue(itemEvidenceIds(excerpted.manifest), expectedIds)
      : null,
  };
}

function uniqueManifestIndex(entries) {
  const index = new Map();
  const duplicates = new Set();
  for (const entry of asArray(entries)) {
    const packetItemId = String(entry?.packetItemId || "");
    if (!packetItemId) continue;
    if (index.has(packetItemId)) {
      duplicates.add(packetItemId);
      continue;
    }
    index.set(packetItemId, entry);
  }
  for (const packetItemId of duplicates) index.set(packetItemId, null);
  return index;
}

function visibleEvidenceIdBelongsToManifest(item, manifest) {
  const visibleEvidenceId = String(item?.evidenceId || "");
  if (!visibleEvidenceId) return false;
  const manifestEvidenceIds = itemEvidenceIds(manifest);
  if (manifestEvidenceIds.has(visibleEvidenceId)) return true;
  if (item?.evidenceIdAliased !== true) return false;
  return [...manifestEvidenceIds].some(
    (evidenceId) => `sha256:${sha256(evidenceId)}` === visibleEvidenceId,
  );
}

function expectedEvidenceIds(binding) {
  if (binding.source === "user_provided_card_text") {
    return new Set([`user-card-text-${normalizeCardKey(binding.resolvedName)}`]);
  }
  const id = String(binding.cardId || "").trim();
  if (!id) return new Set();
  return new Set([id, `card-text-${id}`]);
}

function expectedCollectionFor(binding) {
  return binding.source === "user_provided_card_text"
    ? new RegExp(`^${escapeRegExp(USER_CARD_TEXT_COLLECTION)}$`, "u")
    : new RegExp(`^${escapeRegExp(RESOLVED_CARD_TEXT_COLLECTION)}$`, "u");
}

function collectFlaggedCandidates(items, source) {
  return mergeCandidateLists(asArray(items).map((item) => ({
    candidate: String(item?.input ?? item ?? "").trim(),
    normalizedCandidate: normalizeCardKey(item?.input ?? item ?? ""),
    sources: [source],
  })).filter((item) => item.normalizedCandidate));
}

function isSatisfiedUserProvidedUnknown(candidate, bindings) {
  const binding = bindings.find((item) => (
    item.normalizedCandidate === candidate.normalizedCandidate
  ));
  return binding?.bindingStatus === "RESOLVED"
    && binding.source === "user_provided_card_text"
    && binding.visibleCardText === true;
}

function candidateSummary(binding) {
  return {
    candidate: binding.candidate,
    normalizedCandidate: binding.normalizedCandidate,
    sources: asArray(binding.sources),
  };
}

function mergeCandidateLists(...lists) {
  const byKey = new Map();
  for (const item of lists.flat()) {
    const key = String(item?.normalizedCandidate || "");
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        candidate: String(item.candidate || ""),
        normalizedCandidate: key,
        sources: [...new Set(asArray(item.sources).map(String))].sort(),
      });
      continue;
    }
    existing.sources = [...new Set([
      ...existing.sources,
      ...asArray(item.sources).map(String),
    ])].sort();
  }
  return [...byKey.values()].sort((left, right) => (
    left.normalizedCandidate.localeCompare(right.normalizedCandidate, "en")
  ));
}

function cardSurfaceKeys(card) {
  return new Set([
    card?.input,
    card?.matchedQuery,
    card?.matchedAlias,
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...asArray(card?.aliases),
  ].map(normalizeCardKey).filter(Boolean));
}

function itemEvidenceIds(item) {
  return new Set([
    item?.evidenceId,
    ...asArray(item?.evidenceIds),
  ].map((value) => String(value || "")).filter(Boolean));
}

function stringSet(values) {
  return new Set(asArray(values).map((value) => String(value || "")).filter(Boolean));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function firstMatchingValue(left, right) {
  for (const value of left) if (right.has(value)) return value;
  return null;
}

function readinessErrorMessage(inspection) {
  const details = boundedReadinessDetails(inspection);
  const reasons = Object.entries(details)
    .filter(([key, value]) => key !== "candidateCount" && Array.isArray(value) && value.length)
    .map(([key, value]) => `${key}=${value.join(",")}`);
  return [
    "Admin final evidence is not ready for a paid model call",
    ...reasons,
  ].join(": ");
}

function boundedReadinessDetails(inspection) {
  return {
    candidateCount: inspection.candidateCount,
    unresolvedCandidates: boundedCandidateNames(inspection.unresolvedCandidates),
    ambiguousCandidates: boundedCandidateNames(inspection.ambiguousCandidates),
    omittedCandidates: boundedCandidateNames(inspection.omittedCandidates),
    missingVisibleCardTexts: boundedCandidateNames(inspection.missingVisibleCardTexts),
    excerptedVisibleCardTexts: boundedCandidateNames(inspection.excerptedVisibleCardTexts),
  };
}

function boundedCandidateNames(items) {
  return asArray(items).slice(0, MAX_ERROR_ITEMS).map((item) => (
    String(item?.candidate || "").slice(0, MAX_ERROR_VALUE_CHARS)
  ));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}
