import { analyzeDuelStateTransition } from "./duelStateReasoner.mjs";
import { analyzeOrderedResolutionCheckpoint } from "./orderedResolutionCheckpointReasoner.mjs";

export function analyzeEffectStateTransition({
  userQuery = "",
  cardTexts = [],
  corroboratingEvidence = [],
  operationLegality = null,
  resolvedCards = [],
} = {}) {
  const orderedResolutionCheckpoint = analyzeOrderedResolutionCheckpoint({
    userQuery: String(userQuery || ""),
    resolvedCards,
    cardTexts,
  });
  if (orderedResolutionCheckpoint) return orderedResolutionCheckpoint;
  const transition = analyzeDuelStateTransition({
    userQuery: String(userQuery || ""),
    resolvedCards,
    cardTexts,
    corroboratingEvidence,
  });
  const normalizedTransition = normalizeDestinationReplacementOutput(transition);
  if (normalizedTransition.status !== "resolved" || normalizedTransition.complete !== true) return normalizedTransition;

  const activationEvidence = findActivationEvidence(corroboratingEvidence, operationLegality, normalizedTransition);
  if (!activationEvidence) return normalizedTransition;
  return {
    ...normalizedTransition,
    activationEvidenceType: activationEvidence.sourceType,
    evidenceIds: unique([activationEvidence.id, ...(normalizedTransition.evidenceIds || [])]),
  };
}

// Render from generic movement records emitted by the state engine. Card names
// are display data only and never select a ruling branch.
export function normalizeDestinationReplacementOutput(transition = {}) {
  if (transition?.status !== "resolved" || transition?.complete !== true) return transition;

  const costStep = (transition.trace || []).find((step) => step.phase === "pay_activation_cost");
  const resolutionStep = [...(transition.trace || [])]
    .reverse()
    .find((step) => step.phase === "resolve_effect_operation" && step?.proof?.type === "fusion_summon");
  const costMoves = extractMovementRecords(costStep?.proof);
  const replacedCostMoves = costMoves.filter(movementWasReplaced);
  const materialMoves = Array.isArray(resolutionStep?.proof?.materialMoves)
    ? resolutionStep.proof.materialMoves
    : [];
  const suppressedEffectIds = unique(resolutionStep?.proof?.suppressedDestinationReplacementEffectIds || []);
  const replacedMaterialMoves = materialMoves.filter(movementWasReplaced);
  if (!resolutionStep || !materialMoves.length) return transition;
  if (!replacedCostMoves.length && !replacedMaterialMoves.length && !suppressedEffectIds.length) return transition;

  const cardNames = buildCardNameIndex(transition, resolutionStep?.proof);
  const sourceByEffectId = replacementSourceIndex(transition, costMoves);
  const carrierIds = unique(suppressedEffectIds.map((effectId) => sourceByEffectId.get(effectId)).filter(Boolean));
  const carrierMaterialIds = carrierIds.filter((instanceId) => (
    materialMoves.some((move) => String(move.instanceId) === String(instanceId))
  ));
  const costConclusion = replacedCostMoves.length
    ? describeReplacedCost(replacedCostMoves, cardNames)
    : "";
  const materialConclusion = materialMoves.length
    ? describeMaterialBatch({
      materialMoves,
      suppressedEffectIds,
      carrierMaterialIds,
      cardNames,
      fusionOutcome: resolutionStep?.proof,
    })
    : "";
  if (!costConclusion && !materialConclusion) return transition;

  const activationConclusion = transition.activation === "legal"
    ? transition.activationAssumption === "valid_fusion_material_configuration"
      ? "在能够支付 cost 且存在合法融合召唤组合的通常前提下，可以发动。"
      : "可以发动。"
    : "";
  const trace = (transition.trace || []).map((step) => {
    if (step === costStep && costConclusion) return { ...step, conclusion: costConclusion };
    if (step === resolutionStep && materialConclusion) return { ...step, conclusion: materialConclusion };
    return step;
  });
  const shortAnswer = [
    activationConclusion,
    costConclusion,
    materialConclusion,
  ].filter(Boolean).join("");

  return {
    ...transition,
    shortAnswer: shortAnswer || transition.shortAnswer,
    reasoning: trace.map((step) => step.conclusion).filter(Boolean),
    trace,
    destinationReplacementTimeline: {
      activationCost: costMoves.map((move) => serializeNamedMove(move, cardNames)),
      resolutionMaterialBatch: materialMoves.length ? {
        simultaneous: true,
        moves: materialMoves.map((move) => serializeNamedMove(move, cardNames)),
        suppressedReplacementEffectIds: suppressedEffectIds,
        carrierMaterialInstanceIds: carrierMaterialIds,
      } : null,
    },
  };
}

function extractMovementRecords(proof) {
  const records = Array.isArray(proof) ? proof : proof ? [proof] : [];
  return records.flatMap((record) => (
    Array.isArray(record?.moves) ? record.moves : record?.move ? [record.move] : []
  ));
}

function movementWasReplaced(move = {}) {
  return Boolean(
    move.replacementEffectId
    || move.replacementId
    || (move.intendedToZone && move.actualToZone && move.intendedToZone !== move.actualToZone)
  );
}

function buildCardNameIndex(transition, fusionOutcome = {}) {
  const names = new Map();
  const cards = [
    ...(transition.program?.initialState?.cards || []),
    ...(transition.program?.finalState?.cards || []),
    ...(transition.trace || []).flatMap((step) => step.stateSnapshot?.cards || []),
  ];
  for (const card of cards) {
    const instanceId = String(card?.instanceId || card?.cardId || "");
    if (instanceId && card?.name) names.set(instanceId, String(card.name));
  }
  for (const material of fusionOutcome?.assignment || []) {
    if (material?.instanceId && material?.name) names.set(String(material.instanceId), String(material.name));
  }
  return names;
}

function replacementSourceIndex(transition, moves = []) {
  const sources = new Map();
  for (const move of moves) {
    if (move?.replacementEffectId && move?.replacementSourceInstanceId) {
      sources.set(String(move.replacementEffectId), String(move.replacementSourceInstanceId));
    }
  }
  for (const program of transition.program?.cardPrograms || []) {
    for (const effect of program?.continuousEffects || []) {
      const effectId = String(effect?.id || "");
      const sourceId = String(effect?.sourceInstanceId || effect?.sourceCardId || "");
      if (effectId && sourceId && !sources.has(effectId)) sources.set(effectId, sourceId);
    }
  }
  return sources;
}

function describeReplacedCost(moves, cardNames) {
  const descriptions = moves.map((move) => {
    const name = quotedCardName(cardNames.get(String(move.instanceId)) || "作为 cost 丢弃的卡");
    return `${name}原本应${movementVerb(move.intendedToZone)}，但支付 cost 时目的地替代效果仍在适用，因此实际${movementVerb(move.actualToZone)}`;
  });
  return `发动时，${descriptions.join("；")}。`;
}

function describeMaterialBatch({
  materialMoves,
  suppressedEffectIds,
  carrierMaterialIds,
  cardNames,
  fusionOutcome,
}) {
  const materialNames = materialMoves.map((move) => quotedCardName(
    cardNames.get(String(move.instanceId)) || "融合素材",
  ));
  const carrierNames = carrierMaterialIds.map((instanceId) => quotedCardName(
    cardNames.get(String(instanceId)) || "目的地替代效果的载体",
  ));
  const allFollowIntendedDestination = materialMoves.every((move) => (
    String(move.actualToZone || "") === String(move.intendedToZone || "")
  ));
  const oneActualZone = unique(materialMoves.map((move) => move.actualToZone));
  const destinationClause = allFollowIntendedDestination && oneActualZone.length === 1
    ? `这些素材均按原定去向${movementVerb(oneActualZone[0])}`
    : `实际移动结果为${materialMoves.map((move) => (
      `${quotedCardName(cardNames.get(String(move.instanceId)) || "融合素材")}${movementVerb(move.actualToZone)}`
    )).join("、")}`;
  const suppressionClause = suppressedEffectIds.length
    ? `${carrierNames.length ? carrierNames.join("、") : "目的地替代效果的载体自身"}也在这同一批离开其适用区域，所以该替代效果不适用于这一批素材移动；`
    : "";
  const summonedName = cardNames.get(String(fusionOutcome?.candidateInstanceId || "")) || "融合怪兽";
  const outcomeClause = fusionOutcome?.status === "performed"
    ? `之后进行融合召唤${quotedCardName(summonedName)}。`
    : "最终不进行融合召唤。";
  return `效果处理时，${materialNames.join("、")}作为同一批融合素材移动；${suppressionClause}${destinationClause}，${outcomeClause}`;
}

function serializeNamedMove(move, cardNames) {
  return {
    instanceId: String(move?.instanceId || ""),
    name: cardNames.get(String(move?.instanceId || "")) || "",
    fromZone: move?.fromZone || "",
    intendedToZone: move?.intendedToZone || "",
    actualToZone: move?.actualToZone || "",
    replacementEffectId: move?.replacementEffectId || "",
    replacementSourceInstanceId: move?.replacementSourceInstanceId || "",
  };
}

function quotedCardName(name) {
  return `「${String(name || "卡片")}」`;
}

function movementVerb(zone) {
  switch (String(zone || "")) {
    case "graveyard": return "送去墓地";
    case "banished": return "除外";
    case "hand": return "加入手牌";
    case "deck": return "回到卡组";
    case "extra_deck": return "回到额外卡组";
    case "monster_zone": return "移到怪兽区域";
    case "spell_trap_zone": return "移到魔法与陷阱区域";
    default: return `移到${String(zone || "指定区域")}`;
  }
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
