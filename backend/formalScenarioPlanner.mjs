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
  validateSourceSpan,
} from "./formalEngineSchemas.mjs";

const QUERY_PREDICATES = new Set([
  "PROCEDURE_AVAILABLE",
  "TRIGGER_CAN_ACTIVATE",
  "CHAIN_ORDER_VALID",
  "EVENT_ATTRIBUTION",
]);

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
    if (Array.isArray(draft.missingStateFacts) && draft.missingStateFacts.length) {
      const missingStateFacts = draft.missingStateFacts.map(String);
      const assumedFacts = new Set((draft.assumptions || []).map((item) => String(item?.assumesFactId || "")));
      const uncovered = missingStateFacts.filter((factId) => !assumedFacts.has(factId));
      if ((draft.mode || "STRICT") === "STRICT" || uncovered.length) {
        throw new FormalContractError("MISSING_STATE_FACT", "formal scenario is missing required state facts", {
          missingStateFacts,
          uncovered,
        });
      }
    }
    const { cardInstances, definitionSnapshot } = bindCardInstances(draft.cardInstances, resolvedCards, sourceText);
    const stateFacts = bindInputArray(draft.stateFacts, sourceText, "factId");
    const eventHistory = bindInputArray(draft.eventHistory, sourceText, "eventId");
    const intents = bindIntents(draft.intents, sourceText);
    const queries = bindQueries(draft.queries, sourceText);
    const assumptions = bindSourceArray(draft.assumptions, sourceText, "assumptionId");
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

function bindCardInstances(values, resolvedCards, sourceText) {
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
    const effectBindings = (instance.effectIds || []).map((effectIdValue) => {
      const effectId = String(effectIdValue || "").trim();
      const matches = effects.get(effectId) || [];
      if (matches.length !== 1) {
        throw new FormalContractError(matches.length ? "AMBIGUOUS_EFFECT_BINDING" : "EFFECT_BINDING_NOT_FOUND",
          "effect reference must resolve to exactly one formal effect definition", { cardId, effectId, candidateCount: matches.length });
      }
      return { ...matches[0] };
    });
    return {
      instanceId: requireDraftString(instance?.instanceId, "cardInstances[" + index + "].instanceId"),
      objectEpoch: instance.objectEpoch,
      owner: instance.owner,
      controller: instance.controller,
      zone: instance.zone,
      position: instance.position ?? null,
      definitionBinding: { cardId, definitionId, snapshotId, contentSha256 },
      effectBindings,
      sourceSpan: validateSourceSpan(instance.sourceSpan, sourceText, "cardInstance.sourceSpan"),
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
