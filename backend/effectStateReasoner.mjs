export function analyzeEffectStateTransition({
  userQuery = "",
  cardTexts = [],
  corroboratingEvidence = [],
  operationLegality = null,
  resolvedCards = [],
} = {}) {
  const query = String(userQuery || "");
  const cards = (cardTexts || []).map(compileCardProgram).filter(Boolean);
  const source = cards.find((card) => card.costs.length && card.operations.some((item) => item.type === "fusion_summon"));
  const protectedCard = cards.find((card) => card.continuousEffects.some((item) => item.modifier === "unaffected_by_other_effects"));
  const costCardName = extractCostCardName(query);
  const costCardIdentity = resolveCardIdentity(costCardName, resolvedCards);
  const activationEvidence = findActivationEvidence(corroboratingEvidence, operationLegality);

  if (!source || !protectedCard || !costCardName) return unresolved("semantic_roles_incomplete");
  if (!opponentFieldHasOnly(query, protectedCard.names)) return unresolved("opponent_material_set_not_closed");
  if (!graveyardsInitiallyEmpty(query)) return unresolved("initial_graveyard_state_not_closed");

  const cost = source.costs.find((item) => item.type === "move" && item.from === "hand" && item.to === "graveyard");
  const fusion = source.operations.find((item) => item.type === "fusion_summon");
  if (!cost || !fusion) return unresolved("effect_program_incomplete");
  const initialState = stabilizeContinuousEffects(buildInitialState({ source, protectedCard, costCardIdentity }), cards);
  const activationPreview = executeEffectOperation(initialState, fusion, { source });
  const triggerSatisfied = source.triggers.some((item) => item.event === "summoned") && summonEventDescribed(query, source.names);
  const costCanBePaid = initialState.entities.some((entity) => entity.zone === "hand" && entityMatchesName(entity, costCardName));
  const activationLegal = Boolean(activationEvidence) || (triggerSatisfied && costCanBePaid && activationPreview.status === "performable");
  if (!activationLegal) return unresolved("activation_legality_not_grounded");

  const afterCost = applyStateOperation(initialState, {
    ...cost,
    card: costCardName,
  });
  if (!afterCost.applied) return unresolved("cost_operation_failed");
  const resolvedState = stabilizeContinuousEffects(afterCost.state, cards);
  const immunityCarrier = resolvedState.entities.find((entity) => (
    entity.modifiers.some((modifier) => modifier.type === "unaffected_by_other_effects")
  ));
  if (!immunityCarrier) return unresolved("post_cost_continuous_effect_not_established");
  const immunityModifier = immunityCarrier.modifiers.find((modifier) => modifier.type === "unaffected_by_other_effects");
  const resolutionResult = executeEffectOperation(resolvedState, fusion, { source });
  if (resolutionResult.status !== "not_performed") return unresolved("effect_operation_remains_performable");

  const citations = unique([
    activationEvidence?.id,
    source.id,
    protectedCard.id,
  ]);
  const trace = [
    {
      phase: "activation_check",
      state: "S0",
      status: "legal",
      conclusion: "在支付 cost 前检查：诱发条件成立、手牌中存在可支付的卡，且此时场上有足够的可用融合素材，因此发动合法。",
      evidenceIds: unique([activationEvidence?.id, source.id]),
      stateSnapshot: serializeState(initialState),
      proof: {
        triggerSatisfied,
        costCanBePaid,
        preCostOperationStatus: activationPreview.status,
        usableMaterials: activationPreview.usableMaterials,
      },
    },
    {
      phase: "pay_activation_cost",
      state: "S0_to_S1",
      status: "applied",
      operation: { type: "move", card: costCardName, from: "hand", to: "graveyard" },
      conclusion: `作为 cost，将「${costCardName}」从手牌送入墓地。`,
      evidenceIds: [source.id],
      stateSnapshot: serializeState(afterCost.state),
    },
    {
      phase: "stabilize_continuous_effects",
      state: "S1",
      status: "applied",
      operation: { type: "recompute_continuous_effects", until: "fixed_point" },
      conclusion: `墓地出现符合“${immunityModifier.conditionValue}”条件的怪兽后，「${immunityCarrier.name}」立即开始不受自身以外的效果影响。`,
      evidenceIds: [protectedCard.id],
      stateSnapshot: serializeState(resolvedState),
      proof: { iterations: resolvedState.stabilizationIterations },
    },
    {
      phase: "resolve_effect_operation",
      state: "S1",
      status: "not_performed",
      operation: fusion,
      conclusion: `处理融合操作时，「${immunityCarrier.name}」被“不受其他效果影响”过滤，剩余可用素材不足，因此不进行融合召唤。`,
      evidenceIds: unique([source.id, protectedCard.id]),
      stateSnapshot: serializeState(resolvedState),
      proof: resolutionResult,
    },
  ];

  return {
    status: "resolved",
    complete: true,
    activation: "legal",
    resolution: "not_performed",
    shortAnswer: "可以发动，但是不会进行任何效果处理；因此不进行融合召唤。",
    reasoning: trace.map((item) => item.conclusion),
    trace,
    evidenceIds: citations,
    activationEvidenceType: activationEvidence?.sourceType || activationEvidence?.type || "effect_program",
    program: {
      sourceCard: source.name,
      triggers: source.triggers,
      costs: source.costs,
      operations: source.operations,
      continuousEffects: protectedCard.continuousEffects.map((item) => ({ card: protectedCard.name, ...item })),
      initialState: serializeState(initialState),
      finalState: serializeState(resolvedState),
    },
  };
}

function resolveCardIdentity(mention, resolvedCards = []) {
  const normalizedMention = normalizeName(mention);
  const resolved = (resolvedCards || []).find((card) => (
    [card?.input, card?.matchedQuery]
      .filter(Boolean)
      .some((value) => normalizeName(value) === normalizedMention)
  ));
  const names = unique([
    mention,
    resolved?.input,
    resolved?.name,
    resolved?.cnName,
    resolved?.jaName,
    resolved?.enName,
    ...(resolved?.aliases || []),
  ].filter(Boolean));
  return {
    name: String(resolved?.name || resolved?.cnName || mention || ""),
    names: names.length ? names : [String(mention || "")].filter(Boolean),
    cardId: String(resolved?.id || resolved?.cardId || ""),
  };
}

function entityMatchesName(entity, fragment) {
  return unique([entity?.name, ...(entity?.aliases || [])].filter(Boolean))
    .some((name) => fuzzyContains(name, fragment) || fuzzyContains(fragment, name));
}

function buildInitialState({ source, protectedCard, costCardIdentity }) {
  return {
    entities: [
      { id: `entity:${source.id}`, name: source.name, aliases: source.names, controller: "self", zone: "own_field", modifiers: [] },
      { id: `entity:${protectedCard.id}`, name: protectedCard.name, aliases: protectedCard.names, controller: "opponent", zone: "opponent_field", modifiers: [] },
      {
        id: `entity:cost:${costCardIdentity.cardId || normalizeName(costCardIdentity.name)}`,
        name: costCardIdentity.name,
        aliases: costCardIdentity.names,
        controller: "self",
        zone: "hand",
        modifiers: [],
      },
    ],
    stabilizationIterations: 0,
  };
}

function applyStateOperation(state, operation) {
  if (operation.type !== "move") return { applied: false, state };
  const entities = state.entities.map((entity) => ({ ...entity, modifiers: [...(entity.modifiers || [])] }));
  const entity = entities.find((item) => item.zone === operation.from && entityMatchesName(item, operation.card));
  if (!entity) return { applied: false, state };
  entity.zone = operation.to;
  return { applied: true, state: { ...state, entities } };
}

function stabilizeContinuousEffects(state, programs) {
  let current = {
    ...state,
    entities: state.entities.map((entity) => ({ ...entity, modifiers: [] })),
    stabilizationIterations: 0,
  };
  for (let iteration = 1; iteration <= 8; iteration += 1) {
    const nextModifiers = new Map(current.entities.map((entity) => [entity.id, []]));
    for (const program of programs) {
      const carrier = current.entities.find((entity) => program.names.some((name) => entityMatchesName(entity, name)));
      if (!carrier) continue;
      for (const effect of program.continuousEffects) {
        if (!continuousConditionSatisfied(effect, current)) continue;
        nextModifiers.get(carrier.id).push({
          type: effect.modifier,
          sourceEvidenceId: program.id,
          condition: effect.condition,
          conditionValue: effect.archetype,
        });
      }
    }
    const changed = current.entities.some((entity) => modifierKey(entity.modifiers) !== modifierKey(nextModifiers.get(entity.id)));
    current = {
      ...current,
      entities: current.entities.map((entity) => ({ ...entity, modifiers: nextModifiers.get(entity.id) || [] })),
      stabilizationIterations: iteration,
    };
    if (!changed) break;
  }
  return current;
}

function continuousConditionSatisfied(effect, state) {
  if (effect.condition !== "archetype_card_exists") return false;
  return state.entities.some((entity) => (
    effect.zones.includes(genericZone(entity.zone))
    && entityMatchesName(entity, effect.archetype)
  ));
}

function executeEffectOperation(state, operation, { source }) {
  if (operation.type !== "fusion_summon") return { status: "unsupported_operation", usableMaterials: [], excludedMaterials: [] };
  const sourceEntity = state.entities.find((entity) => source.names.some((name) => entityMatchesName(entity, name)));
  const fieldEntities = state.entities.filter((entity) => genericZone(entity.zone) === "field");
  const excludedMaterials = [];
  const usable = fieldEntities.filter((entity) => {
    if (operation.excludesOtherOwnMonsters && entity.controller === "self" && entity.id !== sourceEntity?.id) {
      excludedMaterials.push({ name: entity.name, reason: "other_own_monster_excluded_by_effect" });
      return false;
    }
    if (entity.id !== sourceEntity?.id && entity.modifiers.some((modifier) => modifier.type === "unaffected_by_other_effects")) {
      excludedMaterials.push({ name: entity.name, reason: "unaffected_by_resolving_effect" });
      return false;
    }
    return true;
  });
  const sourceIncluded = !operation.includesEffectSource || usable.some((entity) => entity.id === sourceEntity?.id);
  const performable = sourceIncluded && usable.length >= (operation.minimumMaterials || 2);
  return {
    status: performable ? "performable" : "not_performed",
    usableMaterials: usable.map((entity) => entity.name),
    excludedMaterials,
    minimumMaterials: operation.minimumMaterials || 2,
    sourceIncluded,
  };
}

function genericZone(zone) {
  if (/field$/u.test(String(zone || ""))) return "field";
  return String(zone || "");
}

function modifierKey(modifiers = []) {
  return (modifiers || []).map((item) => `${item.type}:${item.sourceEvidenceId}`).sort().join("|");
}

function serializeState(state) {
  return {
    entities: state.entities.map((entity) => ({
      name: entity.name,
      controller: entity.controller,
      zone: entity.zone,
      modifiers: (entity.modifiers || []).map((item) => item.type),
    })),
    stabilizationIterations: state.stabilizationIterations || 0,
  };
}

function summonEventDescribed(query, names) {
  return /(?:召唤|召喚|特殊召唤|特殊召喚)/u.test(String(query || ""))
    && names.some((name) => fuzzyContains(query, name));
}

function compileCardProgram(evidence = {}) {
  const text = String(evidence.text || "");
  const names = unique([...(evidence.cards || []), stripEvidenceTitle(evidence.title)]).filter(Boolean);
  if (!evidence.id || !text || !names.length) return null;
  const costs = [];
  const operations = [];
  const continuousEffects = [];
  const triggers = [];

  if (/(?:召唤|召喚|特殊召唤|特殊召喚).{0,30}(?:情况下|场合|場合)/u.test(text)) {
    triggers.push({ type: "event", event: "summoned" });
  }

  if (/(?:舍弃|丢弃|捨てる?)\s*1张手牌.{0,12}(?:可以发动|発動できる)/iu.test(text)) {
    costs.push({ type: "move", selector: "one_hand_card", from: "hand", to: "graveyard" });
  }
  if (/作为融合素材.{0,30}融合召唤|融合素材.{0,30}融合召喚/iu.test(text)) {
    operations.push({
      type: "fusion_summon",
      materialZones: ["own_field", "opponent_field"],
      includesEffectSource: /包含此卡在内|このカードを含む/iu.test(text),
      excludesOtherOwnMonsters: /不可将自己场上其他的怪兽作为融合素材|自分フィールドの他のモンスターを融合素材にできない/iu.test(text),
      minimumMaterials: 2,
    });
  }
  for (const line of text.split(/\n+/u)) {
    const condition = extractContinuousArchetypeCondition(line);
    if (!condition || !/不受此卡以外的效果影响|このカード以外の効果を受けない|unaffected by other card effects/iu.test(line)) continue;
    continuousEffects.push({
      type: "continuous_modifier",
      condition: "archetype_card_exists",
      archetype: condition,
      zones: ["field", "graveyard"],
      modifier: "unaffected_by_other_effects",
    });
  }
  return {
    id: String(evidence.id),
    name: names[0],
    names,
    text,
    mentioned: names.some((name) => fuzzyContains(String(evidence._userQuery || ""), name)),
    costs,
    triggers,
    operations,
    continuousEffects,
  };
}

function extractContinuousArchetypeCondition(line) {
  const text = String(line || "");
  if (!/(?:场上|場上)[^。]{0,32}(?:或|または|もしくは)[^。]{0,12}(?:墓地|墓地に)/u.test(text)) return "";
  const quoted = text.match(/(?:存在|いる|ある)[^。]{0,8}?[“「『]([^”」』]+)[”」』]\s*怪兽/iu);
  if (quoted?.[1]) return quoted[1].trim();
  const bare = text.match(/(?:存在|いる|ある)\s*([^。；;，,]{2,40}?)\s*怪兽/iu);
  return bare?.[1]?.replace(/^[“「『]|[”」』]$/gu, "").trim() || "";
}

function findActivationEvidence(items = [], operationLegality = null) {
  for (const item of items || []) {
    const verdict = item?.officialVerdict ?? item?.verdict;
    if (verdict && typeof verdict === "object" && verdict.activation === "can_activate") {
      return { id: String(item.id || ""), sourceType: item.sourceType || item.type || "related" };
    }
  }
  const check = (operationLegality?.checks || []).find((item) => (
    item.status === "legal" && /发动|發動|発動|activate/iu.test(`${item.action || ""} ${item.legalityQuestion || ""} ${item.conclusion || ""}`)
  ));
  return check ? { id: `operation-check-${check.operationId}`, sourceType: "operation_check" } : null;
}

function extractCostCardName(query) {
  const patterns = [
    /(?:将|將|把)\s*[「『【“]([^」』】”]+)[」』】”]\s*(?:作为|作為)\s*(?:cost|コスト|代价|代價)/iu,
    /(?:舍弃|丢弃|捨てる?)\s*[「『【“]([^」』】”]+)[」』】”]/iu,
  ];
  for (const pattern of patterns) {
    const match = String(query || "").match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function opponentFieldHasOnly(query, names) {
  const text = String(query || "");
  const saysOnly = /对方场上.{0,28}(?:只有|仅有|只存在|存在的卡只有)/u.test(text)
    || /对方场上存在的卡只有/u.test(text);
  return saysOnly && names.some((name) => fuzzyContains(text, name));
}

function graveyardsInitiallyEmpty(query) {
  return /双方墓地.{0,10}(?:没有卡|没有|不存在|为空|是空的)/u.test(String(query || ""));
}

function stripEvidenceTitle(value) {
  return String(value || "")
    .replace(/\s*(?:的卡片文本|のカードテキスト|card text)$/iu, "")
    .trim();
}

function fuzzyContains(container, fragment) {
  const haystack = normalizeName(container);
  const needle = normalizeName(fragment);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;
  if (needle.length < 4) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (editDistanceAtMostOne(haystack.slice(index, index + needle.length), needle)) return true;
  }
  return false;
}

function editDistanceAtMostOne(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let first = left;
  let second = right;
  if (first.length > second.length) [first, second] = [second, first];
  let edits = 0;
  for (let i = 0, j = 0; i < first.length || j < second.length;) {
    if (first[i] === second[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (first.length === second.length) { i += 1; j += 1; }
    else j += 1;
  }
  return true;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』【】“”"'\s·・－ー_.:：-]+/gu, "");
}

function unresolved(reason) {
  return { status: "not_applicable", complete: false, reason, trace: [], evidenceIds: [] };
}

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function attachUserQueryToCardTexts(cardTexts = [], userQuery = "") {
  return (cardTexts || []).map((item) => ({ ...item, _userQuery: String(userQuery || "") }));
}
