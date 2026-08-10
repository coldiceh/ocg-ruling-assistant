import {
  extractEffectProtectionSemantics,
  findNormalizedSemantics,
  normalizeCardText,
} from "./cardTextNormalizer.mjs";
import { collectEntityMentions } from "./scenarioEntityResolver.mjs";

const APPLICABILITY_QUESTION = /(?:不受|免疫|不适用|不適用|适用|適用|影响|影響|无效|無效|破坏|破壞|装备|裝備|装備|affected|unaffected|apply|applies|destroy|equip|効果を受けない|適用され)/iu;
const EQUIP_RELATION = /(?:装备|裝備|装備|equip)/iu;
const ACTIVATION_NEARBY = /(?:发动|發動|発動|activate|使用|use)/iu;

// This context is deliberately a dependency checklist, not a ruling engine.
// In particular, a property granted by an effect is never allowed to justify
// that same source effect applying: source applicability is always evaluated
// first, against only the recipient's independently existing protections.
export function buildEffectApplicabilityContext({
  userQuery = "",
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const query = String(userQuery || "").normalize("NFKC");
  if (!APPLICABILITY_QUESTION.test(query)) return null;

  const cards = mergeCardFacts(resolvedCards, cardTexts);
  const mentions = collectEntityMentions(query, cards);
  const mentionedIds = new Set(mentions.map((mention) => mention.entityId));
  const analyzedCards = cards.map(analyzeCard);
  const grantSources = analyzedCards.filter((card) => (
    mentionedIds.has(card.id) && card.grantedProtections.length > 0
  ));
  if (!grantSources.length) return null;

  const relationships = grantSources.flatMap((source) => source.grantedProtections.map((grant, index) => (
    buildRelationship({
      query,
      mentions,
      cards: analyzedCards,
      mentionedIds,
      source,
      grant,
      grantIndex: index,
    })
  )));
  const missingFacts = uniqueStrings(relationships.flatMap((item) => item.missingFacts));

  return {
    schema: "effect-applicability-context/v1",
    status: relationships.length > 0 && missingFacts.length === 0 ? "complete" : "partial",
    authority: "normalizer_candidate_only",
    questionScope: "effect_applicability_dependency",
    canDecideFinalRuling: false,
    mustVerifyAgainstRawCardText: true,
    outcome: "not_evaluated",
    relationships,
    safeguards: {
      acyclicDependencyOrder: true,
      sourceIdentityUsesPrintedTypeAndRuntimeRole: true,
      grantedPropertyCannotBootstrapItsOwnSource: true,
      currentRoleDoesNotRewritePrintedCardType: true,
    },
    missingFacts,
  };
}

function buildRelationship({
  query,
  mentions,
  cards,
  mentionedIds,
  source,
  grant,
  grantIndex,
}) {
  const relationshipId = `effect-applicability:${source.id}:${grant.effectId}:${grantIndex + 1}`;
  const recipientBinding = bindRecipient({ query, mentions, cards, mentionedIds, source, grant });
  const recipient = recipientBinding.card || null;
  const incomingBinding = bindIncomingEffect({
    query,
    mentions,
    cards,
    mentionedIds,
    excludedIds: new Set([source.id, recipient?.id].filter(Boolean)),
  });
  const incoming = incomingBinding.card || null;
  const existingProtections = recipient?.selfProtections || [];
  const sourceType = source.printedCardType;
  const incomingType = incoming?.printedCardType || "unknown";
  const sourceBlockers = existingProtections
    .filter((protection) => typeSetCanInclude(protection.effectSourceTypes, sourceType))
    .map((protection) => ({
      protectionId: protection.id,
      overlapType: sourceType,
      assessment: "type_overlap_only_requires_condition_and_role_verification",
    }));
  const incomingBlocks = typeSetCanInclude(grant.effectSourceTypes, incomingType)
    ? [{
        grantedProtectionId: grant.id,
        overlapType: incomingType,
        assessment: "type_overlap_only_requires_source_applicability_verification",
      }]
    : [];
  const nodeIds = {
    baseline: `${relationshipId}:recipient_baseline_protections`,
    sourceApplicability: `${relationshipId}:source_effect_applicability`,
    grantActivation: `${relationshipId}:granted_property_activation`,
    incomingApplicability: `${relationshipId}:incoming_effect_applicability`,
  };
  const missingFacts = uniqueStrings([
    ...(sourceType === "unknown" ? ["source_printed_card_type_unresolved"] : []),
    ...(recipient ? [] : [recipientBinding.reason || "effect_recipient_unresolved"]),
    ...(incoming ? [] : [incomingBinding.reason || "incoming_effect_source_unresolved"]),
  ]);

  return {
    id: relationshipId,
    sourceEffect: {
      cardId: source.id,
      cardName: source.name,
      effectId: grant.effectId,
      printedCardType: sourceType,
      currentRole: inferCurrentRole(query, source, grant),
      effectClassificationMustBeVerified: true,
      sourceText: grant.sourceText,
      sourceEvidenceIds: source.evidenceIds,
    },
    recipient: recipient
      ? {
          cardId: recipient.id,
          cardName: recipient.name,
          binding: recipientBinding.binding,
          existingProtections,
          sourceEffectBlockerCandidates: sourceBlockers,
          sourceEvidenceIds: recipient.evidenceIds,
        }
      : {
          cardId: null,
          cardName: "",
          binding: recipientBinding.binding,
          existingProtections: [],
          sourceEffectBlockerCandidates: [],
          candidates: recipientBinding.candidates,
        },
    grantedProperty: {
      id: grant.id,
      type: "effect_protection",
      protection: grant.protection,
      effectSourceTypes: grant.effectSourceTypes,
      effectSourceController: grant.effectSourceController,
      recipientSelector: grant.affected,
      activeOnlyIfSourceEffectApplies: true,
      sourceText: grant.sourceText,
    },
    incomingEffect: incoming
      ? {
          cardId: incoming.id,
          cardName: incoming.name,
          printedCardType: incomingType,
          currentRole: inferIncomingRole(query, incoming),
          binding: incomingBinding.binding,
          grantedPropertyBlockCandidates: incomingBlocks,
          sourceEvidenceIds: incoming.evidenceIds,
        }
      : {
          cardId: null,
          cardName: "",
          printedCardType: "unknown",
          currentRole: "unknown",
          binding: incomingBinding.binding,
          grantedPropertyBlockCandidates: [],
          candidates: incomingBinding.candidates,
        },
    dependencyGraph: {
      acyclic: true,
      nodes: [
        { id: nodeIds.baseline, kind: "recipient_existing_protections", outcome: "requires_verification" },
        { id: nodeIds.sourceApplicability, kind: "source_effect_applicability", outcome: "requires_verification" },
        { id: nodeIds.grantActivation, kind: "granted_property_activation", outcome: "not_evaluated" },
        { id: nodeIds.incomingApplicability, kind: "incoming_effect_applicability", outcome: "not_evaluated" },
      ],
      edges: [
        { from: nodeIds.baseline, to: nodeIds.sourceApplicability, relation: "may_gate" },
        { from: nodeIds.sourceApplicability, to: nodeIds.grantActivation, relation: "required_precondition" },
        { from: nodeIds.grantActivation, to: nodeIds.incomingApplicability, relation: "may_gate" },
      ],
      evaluationOrder: [
        nodeIds.baseline,
        nodeIds.sourceApplicability,
        nodeIds.grantActivation,
        nodeIds.incomingApplicability,
      ],
      forbiddenEdges: [{
        from: nodeIds.grantActivation,
        to: nodeIds.sourceApplicability,
        reason: "granted_property_cannot_bootstrap_source_applicability",
      }],
    },
    missingFacts,
  };
}

function analyzeCard(card) {
  let normalized = null;
  try {
    normalized = normalizeCardText({
      id: card.id,
      name: card.name,
      aliases: card.names,
      cardType: card.cardType,
      effectText: card.text,
    });
  } catch {
    normalized = null;
  }
  const normalizedProtections = findNormalizedSemantics(normalized, "effect_immunity").map(({ effect, semantic }, index) => ({
    id: `${card.id}:${effect.id}:effect-protection:${index + 1}`,
    effectId: effect.id,
    affected: semantic.affected || "source",
    protection: semantic.protection || "unaffected",
    effectSourceTypes: uniqueStrings(semantic.effectSourceTypes || []),
    effectSourceController: semantic.effectSourceController || "any",
    conditionText: semantic.conditionText || semantic.text || effect.rawText || "",
    sourceText: semantic.text || effect.rawText || "",
  }));
  const rawProtections = extractEffectProtectionSemantics(card.text).map((semantic, index) => ({
    id: `${card.id}:raw-text:effect-protection:${index + 1}`,
    effectId: `${card.id}:raw-text`,
    affected: semantic.affected || "source",
    protection: semantic.protection || "unaffected",
    effectSourceTypes: uniqueStrings(semantic.effectSourceTypes || []),
    effectSourceController: semantic.effectSourceController || "any",
    conditionText: semantic.conditionText || semantic.text || "",
    sourceText: semantic.text || "",
  }));
  const protections = dedupeProtections([...normalizedProtections, ...rawProtections]);
  return {
    ...card,
    printedCardType: normalizePrintedCardType(card.cardType, card.properties),
    selfProtections: protections.filter((item) => item.affected === "source"),
    grantedProtections: protections.filter((item) => item.affected !== "source"),
  };
}

function dedupeProtections(values) {
  const output = new Map();
  for (const value of values || []) {
    const key = JSON.stringify([
      value.affected,
      value.protection,
      value.effectSourceTypes,
      value.effectSourceController,
      normalizeIdentity(value.sourceText),
    ]);
    if (!output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

function bindRecipient({ query, mentions, cards, mentionedIds, source, grant }) {
  const candidates = cards.filter((card) => (
    card.id !== source.id
    && mentionedIds.has(card.id)
    && (card.printedCardType === "monster" || card.selfProtections.length > 0)
  ));
  if (grant.affected === "equipped_monster") {
    const nearEquip = candidates.filter((card) => hasEquipRelation(query, mentions, source.id, card.id));
    if (nearEquip.length === 1) return { card: nearEquip[0], binding: "explicit_equip_relation", candidates: [] };
    if (nearEquip.length > 1) return candidateBinding("effect_recipient_ambiguous", nearEquip, "ambiguous_equip_relation");
  }
  const protectedCandidates = candidates.filter((card) => card.selfProtections.length > 0);
  if (protectedCandidates.length === 1) {
    return { card: protectedCandidates[0], binding: "unique_mentioned_protected_recipient", candidates: [] };
  }
  if (candidates.length === 1) return { card: candidates[0], binding: "unique_mentioned_recipient", candidates: [] };
  return candidateBinding(
    candidates.length ? "effect_recipient_ambiguous" : "effect_recipient_unresolved",
    candidates,
    candidates.length ? "ambiguous" : "unresolved",
  );
}

function bindIncomingEffect({ query, mentions, cards, mentionedIds, excludedIds }) {
  const candidates = cards.filter((card) => (
    mentionedIds.has(card.id)
    && !excludedIds.has(card.id)
    && card.printedCardType !== "unknown"
  ));
  const activated = candidates.filter((card) => mentionHasNearbyPattern(query, mentions, card.id, ACTIVATION_NEARBY));
  if (activated.length === 1) return { card: activated[0], binding: "explicit_activation_relation", candidates: [] };
  if (activated.length > 1) return candidateBinding("incoming_effect_source_ambiguous", activated, "ambiguous_activation_relation");
  if (candidates.length === 1) return { card: candidates[0], binding: "unique_remaining_mentioned_card", candidates: [] };
  return candidateBinding(
    candidates.length ? "incoming_effect_source_ambiguous" : "incoming_effect_source_unresolved",
    candidates,
    candidates.length ? "ambiguous" : "unresolved",
  );
}

function hasEquipRelation(query, mentions, sourceId, recipientId) {
  const sourceMentions = mentions.filter((item) => item.entityId === sourceId);
  const recipientMentions = mentions.filter((item) => item.entityId === recipientId);
  return sourceMentions.some((source) => recipientMentions.some((recipient) => {
    const start = Math.min(source.index, recipient.index);
    const end = Math.max(source.end, recipient.end);
    return end - start <= 96 && EQUIP_RELATION.test(query.slice(start, end));
  }));
}

function mentionHasNearbyPattern(query, mentions, cardId, pattern) {
  return mentions.filter((item) => item.entityId === cardId).some((mention) => {
    const local = query.slice(Math.max(0, mention.index - 28), Math.min(query.length, mention.end + 28));
    return pattern.test(local);
  });
}

function inferCurrentRole(query, source, grant) {
  if (grant.affected === "equipped_monster" || EQUIP_RELATION.test(query)) {
    return source.printedCardType === "unknown" ? "equip_card" : `${source.printedCardType}_as_equip`;
  }
  if (["spell", "trap"].includes(source.printedCardType)) return `${source.printedCardType}_continuous`;
  if (source.printedCardType === "monster") return "monster_effect_source";
  return "unknown";
}

function inferIncomingRole(query, card) {
  return mentionHasNearbyPattern(query, collectEntityMentions(query, [card]), card.id, ACTIVATION_NEARBY)
    ? "activated_effect_source"
    : "effect_source";
}

function mergeCardFacts(resolvedCards, cardTexts) {
  const records = new Map();
  for (const item of [...(cardTexts || []), ...(resolvedCards || [])]) {
    const id = normalizeCardId(item);
    const names = uniqueStrings([
      ...(item?.cards || []),
      ...(item?.aliases || []),
      item?.input,
      item?.matchedQuery,
      item?.name,
      item?.cnName,
      item?.jaName,
      item?.jpName,
      item?.enName,
      item?.title,
    ]);
    const key = id || normalizeIdentity(names[0]);
    if (!key || !names.length) continue;
    const previous = records.get(key) || {};
    const nextText = String(item?.effectText || item?.text || "").trim();
    records.set(key, {
      ...previous,
      ...item,
      id: id || previous.id || key,
      name: item?.name || item?.cnName || previous.name || names[0],
      names: uniqueStrings([...(previous.names || []), ...names]),
      cardType: item?.cardType || item?.type || previous.cardType || "",
      properties: uniqueStrings([
        ...(previous.properties || []),
        ...(item?.properties || []),
        ...(item?.monsterProperties || []),
      ]),
      text: nextText || previous.text || "",
      evidenceIds: uniqueStrings([
        ...(previous.evidenceIds || []),
        ...(item?.sourceEvidenceIds || []),
        /^card-text-/u.test(String(item?.id || "")) ? item.id : "",
      ]),
    });
  }
  return [...records.values()].filter((card) => card.text);
}

function normalizeCardId(item) {
  const raw = String(item?.cardId || item?.cardIds?.[0] || item?.id || "");
  return raw.replace(/^card-text-/u, "");
}

function normalizePrintedCardType(value, properties = []) {
  const text = [value, ...(properties || [])].join(" ").normalize("NFKC").toLowerCase();
  if (/(?:trap|陷阱|罠)/iu.test(text)) return "trap";
  if (/(?:spell|magic|魔法)/iu.test(text)) return "spell";
  if (/(?:monster|怪兽|怪獸|モンスター)/iu.test(text)) return "monster";
  return "unknown";
}

function typeSetCanInclude(types, candidate) {
  if (!candidate || candidate === "unknown") return false;
  return (types || []).includes("all") || (types || []).includes(candidate);
}

function candidateBinding(reason, cards, binding) {
  return {
    card: null,
    reason,
    binding,
    candidates: cards.map((card) => ({ cardId: card.id, cardName: card.name })),
  };
}

function normalizeIdentity(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}
