import { createHash } from "node:crypto";

import {
  FORMAL_AUTHORITY_SCOPE,
  FORMAL_SCENARIO_CONTRACT,
  FORMAL_SCENARIO_DRAFT_CONTRACT,
  FORMAL_SOURCE_SPAN_ENCODING,
  FormalContractError,
  definitionSnapshotSha256,
  deriveFormalRequiredCapabilities,
  validateFormalScenario,
  validateFormalMissingStateFacts,
  validateSourceSpan,
} from "./formalEngineSchemas.mjs";

const QUERY_PREDICATES = new Set([
  "PROCEDURE_AVAILABLE",
  "TRIGGER_CAN_ACTIVATE",
  "CHAIN_ORDER_VALID",
  "EVENT_ATTRIBUTION",
]);

const CARD_NAME_WRAPPERS = new Map([
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ["‘", "’"],
  ["\"", "\""],
  ["《", "》"],
  ["〈", "〉"],
  ["【", "】"],
  ["[", "]"],
]);
const EFFECT_ANAPHOR_PATTERN = /(?:该|此|这个|那个|上述|前述|其)(?:卡|怪兽)?(?:的)?效果|(?:この|その|あの|当該)効果|\b(?:this|that|the same|said) effect\b/iu;

export function planFormalScenario({ scenarioDraft, userQuery, resolvedCards = [] } = {}) {
  const draft = scenarioDraft && typeof scenarioDraft === "object" ? scenarioDraft : {};
  const sourceText = String(userQuery ?? draft.question?.text ?? "");
  try {
    if (draft.contractVersion !== FORMAL_SCENARIO_DRAFT_CONTRACT) {
      throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", "unsupported formal scenario draft contract");
    }
    if (!sourceText || (draft.question?.text !== undefined && draft.question.text !== sourceText)) {
      throw new FormalContractError("FORMAL_SOURCE_TEXT_MISMATCH", "scenario draft must bind the exact user query");
    }
    if (draft.sourceSpanEncoding !== FORMAL_SOURCE_SPAN_ENCODING) {
      throw new FormalContractError("FORMAL_SOURCE_SPAN_INVALID", "scenario draft must use UTF-16 half-open source spans");
    }
    const missingStateFacts = validateFormalMissingStateFacts(draft.missingStateFacts);
    if (missingStateFacts.length) {
      const assumedFacts = new Set((draft.assumptions || []).map((item) => String(item?.assumesFactId || "")));
      const uncovered = missingStateFacts.filter((factId) => !assumedFacts.has(factId));
      if ((draft.mode || "STRICT") === "STRICT" || uncovered.length) {
        throw new FormalContractError("MISSING_STATE_FACT", "formal scenario is missing required state facts", {
          missingStateFacts,
          uncovered,
        });
      }
    }
    const cardMentionIndex = buildCardMentionIndex(resolvedCards, sourceText);
    const { cardInstances, definitionSnapshot } = bindCardInstances(
      draft.cardInstances,
      resolvedCards,
      sourceText,
      cardMentionIndex,
    );
    const stateFacts = bindInputArray(draft.stateFacts, sourceText, "factId");
    const eventHistory = bindInputArray(draft.eventHistory, sourceText, "eventId");
    const intents = bindIntents(draft.intents, sourceText);
    const queries = bindQueries(draft.queries, sourceText);
    const assumptions = bindSourceArray(draft.assumptions, sourceText, "assumptionId");
    validateExplicitEffectBindings({
      sourceText,
      cardMentionIndex,
      cardInstances,
      eventHistory,
      intents,
      queries,
    });
    validateReferencedCardMentions({
      cardMentionIndex,
      cardInstances,
      stateFacts,
      eventHistory,
      intents,
      queries,
    });
    const requiredCapabilities = collectCapabilities(draft, intents, queries, stateFacts, eventHistory);
    const scenario = {
      contractVersion: FORMAL_SCENARIO_CONTRACT,
      scenarioId: String(draft.scenarioId || deterministicScenarioId(sourceText, draft)),
      sourceSpanEncoding: FORMAL_SOURCE_SPAN_ENCODING,
      authorityScope: FORMAL_AUTHORITY_SCOPE,
      mode: draft.mode || "STRICT",
      question: { text: sourceText },
      turn: cloneJson(draft.turn),
      cardInstances,
      definitionSnapshot,
      stateFacts,
      eventHistory,
      intents,
      queries,
      assumptions,
      requiredCapabilities,
      branchPolicy: {
        preserveUnspecifiedResponses: true,
        ...(cloneJson(draft.branchPolicy) || {}),
      },
    };
    validateFormalScenario(scenario);
    return { kind: "READY", scenario, unknownReasons: [] };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      kind: "UNKNOWN",
      scenario: null,
      unknownReasons: [{ code: normalized.code, message: normalized.message, details: normalized.details }],
    };
  }
}

function bindCardInstances(values, resolvedCards, sourceText, cardMentionIndex) {
  if (!Array.isArray(values) || !values.length) {
    throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", "formal draft requires card instances");
  }
  const cardsById = new Map();
  for (const card of resolvedCards || []) {
    const cardId = String(card?.cardId ?? card?.id ?? "").trim();
    if (!cardId) continue;
    const entries = cardsById.get(cardId) || [];
    entries.push(card);
    cardsById.set(cardId, entries);
  }
  const definitions = new Map();
  const snapshotIds = new Set();
  const cardInstances = values.map((instance, index) => {
    const cardId = String(instance?.cardId || "").trim();
    const candidates = cardsById.get(cardId) || [];
    if (candidates.length !== 1) {
      throw new FormalContractError(candidates.length ? "AMBIGUOUS_CARD_BINDING" : "CARD_BINDING_NOT_FOUND",
        "card instance must resolve to exactly one formal card definition", { cardId, candidateCount: candidates.length });
    }
    const card = candidates[0];
    const sourceSpan = validateSourceSpan(instance.sourceSpan, sourceText, "cardInstance.sourceSpan");
    assertCardMentionBinding(cardId, sourceSpan, cardMentionIndex, "card instance");
    const definitionId = String(card.formalDefinitionId ?? card.formal?.definitionId ?? card.definitionId ?? "").trim();
    if (!definitionId) throw new FormalContractError("FORMAL_DEFINITION_BINDING_MISSING", "resolved card lacks a formal definition", { cardId });
    const snapshotId = String(card.formalDefinitionSnapshotId ?? card.formalSnapshotId ?? card.formal?.snapshotId ?? "").trim();
    const contentSha256 = String(card.formalDefinitionContentSha256 ?? card.formalContentSha256 ?? card.formal?.contentSha256 ?? "").trim();
    if (!snapshotId || !contentSha256) {
      throw new FormalContractError("FORMAL_DEFINITION_BINDING_MISSING", "resolved card lacks a versioned formal definition snapshot binding", {
        cardId,
        snapshotIdPresent: Boolean(snapshotId),
        contentSha256Present: Boolean(contentSha256),
      });
    }
    snapshotIds.add(snapshotId);
    const effects = new Map();
    for (const effect of card.formalEffects || card.formal?.effects || card.effects || []) {
      const effectId = String(effect?.effectId ?? effect?.id ?? "").trim();
      if (!effectId) continue;
      const definitionEffectId = String(effect?.definitionEffectId ?? effect?.formalEffectId ?? "").trim();
      const effectContentSha256 = String(effect?.definitionEffectSha256 ?? effect?.formalEffectSha256 ?? effect?.contentSha256 ?? "").trim();
      if (!definitionEffectId || !effectContentSha256) {
        throw new FormalContractError("FORMAL_EFFECT_BINDING_MISSING", "resolved effect lacks a versioned formal definition binding", {
          cardId,
          effectId,
          definitionEffectIdPresent: Boolean(definitionEffectId),
          contentSha256Present: Boolean(effectContentSha256),
        });
      }
      const items = effects.get(effectId) || [];
      items.push({ effectId, definitionEffectId, contentSha256: effectContentSha256 });
      effects.set(effectId, items);
    }
    const definitionEffects = [...effects.values()].flat().map((effect) => ({ ...effect }))
      .sort((left, right) => left.effectId.localeCompare(right.effectId));
    const definition = { cardId, definitionId, contentSha256, effects: definitionEffects };
    const existingDefinition = definitions.get(cardId);
    if (existingDefinition && JSON.stringify(existingDefinition) !== JSON.stringify(definition)) {
      throw new FormalContractError("FORMAL_DEFINITION_SNAPSHOT_INVALID", "one cardId resolved to inconsistent definition content", { cardId });
    }
    definitions.set(cardId, definition);
    const requestedEffectIds = new Set();
    for (const effectIdValue of instance.effectIds || []) {
      const effectId = String(effectIdValue || "").trim();
      if (requestedEffectIds.has(effectId)) {
        throw new FormalContractError("AMBIGUOUS_EFFECT_BINDING", "card instance repeats one effect reference", { cardId, effectId });
      }
      requestedEffectIds.add(effectId);
      const matches = effects.get(effectId) || [];
      if (matches.length !== 1) {
        throw new FormalContractError(matches.length ? "AMBIGUOUS_EFFECT_BINDING" : "EFFECT_BINDING_NOT_FOUND",
          "effect reference must resolve to exactly one formal effect definition", { cardId, effectId, candidateCount: matches.length });
      }
    }
    // Every printed effect comes from the immutable definition. The draft may
    // reference effects, but it cannot hide an effect by omitting its id.
    const effectBindings = definitionEffects.map((effect) => ({ ...effect }));
    return {
      instanceId: requireDraftString(instance?.instanceId, "cardInstances[" + index + "].instanceId"),
      objectEpoch: instance.objectEpoch,
      owner: instance.owner,
      controller: instance.controller,
      zone: instance.zone,
      position: instance.position ?? null,
      definitionBinding: { cardId, definitionId, snapshotId, contentSha256 },
      effectBindings,
      sourceSpan,
    };
  });
  if (snapshotIds.size !== 1) {
    throw new FormalContractError("FORMAL_DEFINITION_SNAPSHOT_INVALID", "all formal definitions in one scenario must come from one immutable snapshot", {
      snapshotIds: [...snapshotIds].sort(),
    });
  }
  const definitionSnapshot = {
    snapshotId: [...snapshotIds][0],
    definitions: [...definitions.values()].sort((left, right) => left.cardId.localeCompare(right.cardId)),
  };
  definitionSnapshot.manifestSha256 = definitionSnapshotSha256(definitionSnapshot);
  return { cardInstances, definitionSnapshot };
}

function buildCardMentionIndex(resolvedCards, sourceText) {
  const ownersBySpan = new Map();
  const mentions = [];
  const candidates = [];
  for (const card of resolvedCards || []) {
    const cardId = String(card?.cardId ?? card?.id ?? "").trim();
    if (!cardId) continue;
    for (const surface of collectCardNameSurfaces(card)) {
      for (const span of exactCardNameSpans(sourceText, surface)) {
        candidates.push({ ...span, cardId });
      }
    }
  }
  for (const candidate of candidates) {
    if (isContainedByLongerResolvedName(candidate, candidates)) continue;
    const key = sourceSpanKey(candidate);
    const owners = ownersBySpan.get(key) || new Set();
    owners.add(candidate.cardId);
    ownersBySpan.set(key, owners);
  }
  for (const [key, cardIds] of ownersBySpan) {
    const [start, end] = key.split(":").map(Number);
    mentions.push({ start, end, text: sourceText.slice(start, end), cardIds: new Set(cardIds) });
  }
  mentions.sort((left, right) => left.start - right.start || right.end - left.end);
  return { ownersBySpan, mentions };
}

function isContainedByLongerResolvedName(candidate, candidates) {
  const candidateLength = candidate.end - candidate.start;
  return candidates.some((other) => (
    other !== candidate
    && other.start <= candidate.start
    && other.end >= candidate.end
    && other.end - other.start > candidateLength
  ));
}

function collectCardNameSurfaces(card) {
  const values = [card?.input, card?.name, card?.cnName, card?.jaName, card?.enName, card?.aliases];
  const surfaces = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "string") return;
    const text = value.trim();
    if (text) surfaces.add(text);
  };
  for (const value of values) visit(value);
  return [...surfaces].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function exactCardNameSpans(sourceText, surface) {
  const spans = new Map();
  let offset = 0;
  while (offset <= sourceText.length - surface.length) {
    const start = sourceText.indexOf(surface, offset);
    if (start < 0) break;
    const end = start + surface.length;
    if (!isEmbeddedInsideDifferentQuotedName(sourceText, start, end, surface)) {
      spans.set(`${start}:${end}`, { start, end, text: surface });
      const opening = sourceText[start - 1];
      const closing = CARD_NAME_WRAPPERS.get(opening);
      if (closing && sourceText[end] === closing) {
        spans.set(`${start - 1}:${end + 1}`, {
          start: start - 1,
          end: end + 1,
          text: sourceText.slice(start - 1, end + 1),
        });
      }
    }
    offset = start + 1;
  }
  return [...spans.values()];
}

function isEmbeddedInsideDifferentQuotedName(sourceText, start, end, surface) {
  for (const [opening, closing] of CARD_NAME_WRAPPERS) {
    const openingIndex = sourceText.lastIndexOf(opening, start - 1);
    if (openingIndex < 0) continue;
    const priorClosing = sourceText.lastIndexOf(closing, start - 1);
    if (priorClosing > openingIndex) continue;
    const closingIndex = sourceText.indexOf(closing, end);
    if (closingIndex < 0) continue;
    if (sourceText.slice(openingIndex + opening.length, closingIndex) !== surface) return true;
  }
  return false;
}

function assertCardMentionBinding(cardId, sourceSpan, cardMentionIndex, label) {
  const owners = cardMentionIndex.ownersBySpan.get(sourceSpanKey(sourceSpan));
  if (!owners?.size) {
    throw new FormalContractError("FORMAL_CARD_MENTION_UNVERIFIED", label + " source span is not an exact resolved-card name mention", {
      cardId,
      sourceSpan,
    });
  }
  if (owners.size !== 1) {
    throw new FormalContractError("AMBIGUOUS_CARD_MENTION", label + " source span matches more than one resolved card", {
      cardId,
      candidateCardIds: [...owners].sort(),
      sourceSpan,
    });
  }
  if (!owners.has(cardId)) {
    throw new FormalContractError("FORMAL_CARD_MENTION_MISMATCH", label + " source span names a different resolved card", {
      cardId,
      mentionedCardId: [...owners][0],
      sourceSpan,
    });
  }
}

function validateReferencedCardMentions({
  cardMentionIndex,
  cardInstances,
  stateFacts,
  eventHistory,
  intents,
  queries,
}) {
  const instances = new Map(cardInstances.map((instance) => [instance.instanceId, instance]));
  const intentsById = new Map(intents.map((intent) => [intent.intentId, intent]));
  const eventsById = new Map(eventHistory.map((event) => [event.eventId, event]));
  const requireMention = (instanceId, sourceSpan, label) => {
    if (instanceId === undefined) return;
    const instance = instances.get(instanceId);
    if (!instance) {
      throw new FormalContractError("FORMAL_REFERENCE_INVALID", label + " references an unknown card instance", {
        instanceId,
      });
    }
    assertReferencedCardMention(
      instance.definitionBinding.cardId,
      sourceSpan,
      cardMentionIndex,
      label,
    );
  };

  for (const fact of stateFacts) {
    requireMention(fact.subjectInstanceId, fact.sourceSpan, `state fact ${fact.factId}`);
    if (fact.definitionRef?.cardId !== undefined) {
      assertReferencedCardMention(
        String(fact.definitionRef.cardId),
        fact.sourceSpan,
        cardMentionIndex,
        `state fact ${fact.factId}`,
      );
    }
  }
  for (const event of eventHistory) {
    requireMention(event.subjectInstanceId, event.sourceSpan, `event ${event.eventId}`);
  }
  for (const intent of intents) {
    requireMention(intent.actorInstanceId, intent.sourceSpan, `intent ${intent.intentId}`);
  }
  for (const query of queries) {
    if (query.subjectInstanceId !== undefined) {
      requireMention(query.subjectInstanceId, query.sourceSpan, `query ${query.queryId}`);
    } else if (query.predicate === "PROCEDURE_AVAILABLE") {
      const intent = intentsById.get(query.intentId);
      if (intent) requireMention(intent.actorInstanceId, query.sourceSpan, `query ${query.queryId}`);
    } else if (query.predicate === "EVENT_ATTRIBUTION") {
      const event = eventsById.get(query.eventId);
      if (event?.subjectInstanceId !== undefined) {
        requireMention(event.subjectInstanceId, query.sourceSpan, `query ${query.queryId}`);
      }
    } else if (query.predicate === "CHAIN_ORDER_VALID") {
      for (const candidate of query.chainCandidates || []) {
        requireMention(candidate.instanceId, query.sourceSpan, `query ${query.queryId}`);
      }
    }
  }
}

function assertReferencedCardMention(cardId, sourceSpan, cardMentionIndex, label) {
  const mentions = cardMentionIndex.mentions.filter((mention) => (
    mention.start >= sourceSpan.start && mention.end <= sourceSpan.end
  ));
  const exactTarget = mentions.find((mention) => mention.cardIds.size === 1 && mention.cardIds.has(cardId));
  if (exactTarget) return;
  const ambiguousTarget = mentions.find((mention) => mention.cardIds.has(cardId));
  if (ambiguousTarget) {
    throw new FormalContractError("AMBIGUOUS_CARD_MENTION", label + " source span does not identify the referenced card uniquely", {
      cardId,
      candidateCardIds: [...ambiguousTarget.cardIds].sort(),
      sourceSpan,
    });
  }
  if (mentions.length) {
    throw new FormalContractError("FORMAL_CARD_MENTION_MISMATCH", label + " source span does not mention the referenced card", {
      cardId,
      mentionedCardIds: [...new Set(mentions.flatMap((mention) => [...mention.cardIds]))].sort(),
      sourceSpan,
    });
  }
  throw new FormalContractError("FORMAL_CARD_MENTION_UNVERIFIED", label + " source span contains no exact resolved-card name mention", {
    cardId,
    sourceSpan,
  });
}

function validateExplicitEffectBindings({ sourceText, cardMentionIndex, cardInstances, eventHistory, intents, queries }) {
  const instances = new Map(cardInstances.map((instance) => [instance.instanceId, instance]));
  const intentsById = new Map(intents.map((intent) => [intent.intentId, intent]));
  const eventsById = new Map(eventHistory.map((event) => [event.eventId, event]));

  for (const event of eventHistory) {
    const references = event.effectId === undefined ? [] : [{ instanceId: event.subjectInstanceId, effectId: event.effectId }];
    validateEffectMentionSpan({
      label: `event ${event.eventId}`,
      sourceSpan: event.sourceSpan,
      references,
      requireExplicit: references.length > 0,
      sourceText,
      cardMentionIndex,
      instances,
    });
  }

  for (const intent of intents) {
    const references = [{ instanceId: intent.actorInstanceId, effectId: intent.procedureId }];
    validateEffectMentionSpan({
      label: `intent ${intent.intentId}`,
      sourceSpan: intent.sourceSpan,
      references,
      requireExplicit: numberedEffectId(intent.procedureId) !== null,
      sourceText,
      cardMentionIndex,
      instances,
    });
  }

  for (const query of queries) {
    let references = [];
    let requireExplicit = false;
    if (query.predicate === "TRIGGER_CAN_ACTIVATE") {
      references = [{ instanceId: query.subjectInstanceId, effectId: query.effectId }];
      requireExplicit = true;
    } else if (query.predicate === "CHAIN_ORDER_VALID") {
      references = query.chainCandidates || [];
      requireExplicit = true;
    } else if (query.predicate === "PROCEDURE_AVAILABLE") {
      const intent = intentsById.get(query.intentId);
      if (intent) references = [{ instanceId: intent.actorInstanceId, effectId: intent.procedureId }];
    } else if (query.predicate === "EVENT_ATTRIBUTION") {
      const event = eventsById.get(query.eventId);
      if (event?.effectId !== undefined) references = [{ instanceId: event.subjectInstanceId, effectId: event.effectId }];
    }
    validateEffectMentionSpan({
      label: `query ${query.queryId}`,
      sourceSpan: query.sourceSpan,
      references,
      requireExplicit,
      sourceText,
      cardMentionIndex,
      instances,
    });
  }
}

function validateEffectMentionSpan({
  label,
  sourceSpan,
  references,
  requireExplicit,
  sourceText,
  cardMentionIndex,
  instances,
}) {
  const markers = extractNumberedEffectMarkers(sourceText, sourceSpan);
  const hasAnaphor = EFFECT_ANAPHOR_PATTERN.test(sourceSpan.text);
  if (!markers.length) {
    if (requireExplicit || hasAnaphor) {
      throw new FormalContractError("FORMAL_EFFECT_MENTION_UNVERIFIED", label + " does not contain a uniquely attributable numbered effect mention", {
        referencedEffectIds: references.map((item) => item.effectId),
        anaphoric: hasAnaphor,
        sourceSpan,
      });
    }
    return;
  }
  if (!references.length) {
    throw new FormalContractError("FORMAL_EFFECT_MENTION_UNVERIFIED", label + " contains a numbered effect but no formal effect reference", {
      effectIds: markers.map((marker) => marker.effectId),
      sourceSpan,
    });
  }

  const actualBindings = markers.map((marker) => {
    const cardId = cardIdForEffectMarker(marker, sourceSpan, cardMentionIndex);
    return `${cardId}\u0000${marker.effectId}`;
  });
  const expectedBindings = references.map((reference) => {
    const instance = instances.get(reference.instanceId);
    if (!instance) {
      throw new FormalContractError("FORMAL_REFERENCE_INVALID", label + " references an unknown card instance", {
        instanceId: reference.instanceId,
      });
    }
    return `${instance.definitionBinding.cardId}\u0000${String(reference.effectId || "")}`;
  });
  if (actualBindings.length !== expectedBindings.length
      || actualBindings.some((binding, index) => binding !== expectedBindings[index])) {
    throw new FormalContractError("FORMAL_EFFECT_MENTION_MISMATCH", label + " effect reference does not match the card name and number in the user query", {
      actualBindings,
      expectedBindings,
      sourceSpan,
    });
  }
}

function extractNumberedEffectMarkers(sourceText, sourceSpan) {
  const markers = [];
  for (let offset = sourceSpan.start; offset < sourceSpan.end; offset += 1) {
    const ordinal = circledEffectOrdinal(sourceText[offset]);
    if (ordinal === null) continue;
    markers.push({ start: offset, end: offset + 1, effectId: `effect-${ordinal}` });
  }
  return markers;
}

function circledEffectOrdinal(character) {
  if (!character) return null;
  const codePoint = character.codePointAt(0);
  return codePoint >= 0x2460 && codePoint <= 0x2473 ? codePoint - 0x245f : null;
}

function numberedEffectId(effectId) {
  const match = /^effect-([1-9]\d*)$/u.exec(String(effectId || ""));
  return match ? Number(match[1]) : null;
}

function cardIdForEffectMarker(marker, sourceSpan, cardMentionIndex) {
  const preceding = cardMentionIndex.mentions
    .filter((mention) => mention.start >= sourceSpan.start && mention.end <= marker.start)
    .sort((left, right) => (marker.start - left.end) - (marker.start - right.end) || right.start - left.start);
  if (!preceding.length) {
    throw new FormalContractError("FORMAL_EFFECT_MENTION_UNVERIFIED", "numbered effect mention has no preceding exact card-name mention", {
      marker,
      sourceSpan,
    });
  }
  const nearestDistance = marker.start - preceding[0].end;
  const nearest = preceding.filter((mention) => marker.start - mention.end === nearestDistance);
  const cardIds = new Set(nearest.flatMap((mention) => [...mention.cardIds]));
  if (cardIds.size !== 1) {
    throw new FormalContractError("AMBIGUOUS_EFFECT_MENTION", "numbered effect mention cannot be attributed to exactly one resolved card", {
      marker,
      candidateCardIds: [...cardIds].sort(),
      sourceSpan,
    });
  }
  return [...cardIds][0];
}

function sourceSpanKey(span) {
  return `${span.start}:${span.end}`;
}

function bindInputArray(values, sourceText, idField) {
  if (!Array.isArray(values)) throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", idField + " collection must be an array");
  return values.map((value) => ({
    ...cloneJson(value),
    [idField]: String(value?.[idField] || ""),
    provenance: String(value?.provenance || ""),
    sourceSpan: validateSourceSpan(value?.sourceSpan, sourceText, idField + ".sourceSpan"),
  }));
}

function bindSourceArray(values, sourceText, idField) {
  if (!Array.isArray(values)) throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", idField + " collection must be an array");
  return values.map((value) => ({
    ...cloneJson(value),
    [idField]: String(value?.[idField] || ""),
    sourceSpan: validateSourceSpan(value?.sourceSpan, sourceText, idField + ".sourceSpan"),
  }));
}

function bindIntents(values, sourceText) {
  if (!Array.isArray(values)) throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", "intents must be an array");
  return values.map((value) => ({
    ...cloneJson(value),
    sourceSpan: validateSourceSpan(value?.sourceSpan, sourceText, "intent.sourceSpan"),
  }));
}

function bindQueries(values, sourceText) {
  if (!Array.isArray(values)) throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", "queries must be an array");
  return values.map((value) => {
    if (!QUERY_PREDICATES.has(value?.predicate)) {
      throw new FormalContractError("CAPABILITY_UNAVAILABLE", "unsupported formal query predicate", { predicate: value?.predicate });
    }
    return {
      ...cloneJson(value),
      sourceSpan: validateSourceSpan(value?.sourceSpan, sourceText, "query.sourceSpan"),
    };
  });
}

function collectCapabilities(draft, intents, queries, stateFacts, eventHistory) {
  const result = new Set(deriveFormalRequiredCapabilities({ intents, queries, stateFacts, eventHistory }));
  for (const capabilityId of draft.requiredCapabilities || []) result.add(String(capabilityId));
  return [...result].sort();
}

function deterministicScenarioId(sourceText, draft) {
  const stable = JSON.stringify({ sourceText, draft });
  return "formal-scenario:" + createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function cloneJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function normalizeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "FORMAL_SCENARIO_SCHEMA_INVALID",
    message: error instanceof Error ? error.message : String(error),
    details: error?.details && typeof error.details === "object" ? error.details : {},
  };
}

function requireDraftString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new FormalContractError("FORMAL_SCENARIO_SCHEMA_INVALID", label + " must be a non-empty string");
  return text;
}
