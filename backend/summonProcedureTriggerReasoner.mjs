import { normalizeCardText, findNormalizedSemantics } from "./cardTextNormalizer.mjs";
import { compileResolvedCardPrograms } from "./duelStateReasoner.mjs";
import { resolveMoveBatch, wasBanishedByCardEffect } from "./effectResolutionEngine.mjs";
import { analyzeSimultaneousTriggerScenario } from "./simultaneousTriggerChain.mjs";
import { resolveOrdinalEntityReferences } from "./scenarioEntityResolver.mjs";

export function analyzeSummonProcedureTriggerTransition({
  userQuery = "",
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const query = String(userQuery || "");
  const cards = mergeCardFacts(resolvedCards, cardTexts);
  const procedureCards = cards.flatMap((card) => (
    findNormalizedSemantics(card.ir, "special_summon_procedure")
      .map(({ semantic }) => ({ card, procedure: semantic }))
  )).filter(({ card }) => mentionedWith(query, card.names, /(?:额外|額外|EX|エクストラ).{0,24}(?:特殊召唤|特殊召喚)|(?:特殊召唤|特殊召喚).{0,24}(?:额外|額外|EX|エクストラ)/iu));
  if (procedureCards.length !== 1) return null;
  const [{ card: summonCard, procedure }] = procedureCards;
  const movement = procedure.requiredMovements?.[0];
  if (!movement || movement.operation !== "banish" || movement.causeKind !== "summon_procedure") {
    return unknown("summon_procedure_movement_ir_incomplete");
  }
  const ordinalMaterials = resolveOrdinalEntityReferences({
    query,
    entities: cards,
    actionPattern: /(?:除外|banish)/iu,
  });
  if (ordinalMaterials.ambiguous) return unknown("summon_procedure_material_reference_ambiguous", { ordinalMaterials });
  const materialCandidates = cards.filter((card) => (
    card.id !== summonCard.id
    && (
      mentionedWith(query, card.names, /(?:除外|banish)/iu)
      || ordinalMaterials.entityIds.includes(card.id)
    )
  ));
  const handCandidates = cards.filter((card) => (
    card.id !== summonCard.id
    && mentionedWith(query, card.names, /(?:手牌|手卡|手札|hand)/iu)
    && hasEffectBanishTrigger(card)
  ));
  if (materialCandidates.length !== 1 || handCandidates.length !== 1) {
    return unknown("summon_procedure_roles_ambiguous_or_missing");
  }
  const [materialCard] = materialCandidates;
  const [handCard] = handCandidates;

  const premise = inspectPremises({ query, procedure, movement, materialCard, summonCard, handCard });
  if (premise.status === "unknown") return unknown(premise.reason, { premise });
  if (premise.status === "illegal") {
    return {
      status: "resolved",
      complete: true,
      authoritative: true,
      authorityReasons: [],
      activation: "illegal",
      resolution: "not_performed",
      reason: premise.reason,
      shortAnswer: `不能按该召唤手续特殊召唤「${summonCard.name}」；${premise.conclusion}`,
      reasoning: [premise.conclusion],
      trace: [{ phase: "summon_procedure_preflight", status: "illegal", proof: premise }],
      evidenceIds: evidenceIds([summonCard, materialCard, handCard]),
      activationEvidenceType: "summon_condition_ir",
    };
  }

  const sourceInstance = instance(materialCard, "monster_zone", true, premise.ownership.material.player);
  const summonInstance = instance(summonCard, "extra_deck", false, premise.ownership.extraDeck.player);
  const handInstance = instance(handCard, "hand", false, premise.ownership.hand.player);
  const gameState = {
    cards: [sourceInstance, summonInstance, handInstance],
    graveyards: { self: [], opponent: [] },
    banished: { self: [], opponent: [] },
  };
  const initialStateSnapshot = clone(gameState);
  const programs = compileResolvedCardPrograms(resolvedCards, cardTexts);
  const sourceProgram = programs.find((program) => (
    String(program.definitionId) === materialCard.id
    || program.names?.some((name) => materialCard.names.some((other) => normalizeIdentity(name) === normalizeIdentity(other)))
  ));
  const continuousEffects = (sourceProgram?.continuousEffects || []).map((effect) => ({
    ...effect,
    sourceInstanceId: sourceInstance.instanceId,
  }));
  const materialMoveResult = resolveMoveBatch(gameState, [{
    card: sourceInstance,
    intendedToZone: "banished",
    destinationPlayer: "self",
    originalCause: "special_summon_procedure_banish",
    originalCauseKind: "summon_procedure",
  }], {
    stage: "special_summon_procedure",
    continuousEffects,
  });
  if (materialMoveResult.status !== "applied" || materialMoveResult.moves.length !== 1) {
    return unknown(materialMoveResult.reason || "summon_procedure_material_move_failed");
  }
  const [materialMove] = materialMoveResult.moves;
  const postMaterialState = materialMoveResult.gameState;
  const summonMoveResult = resolveMoveBatch(postMaterialState, [{
    card: summonInstance,
    intendedToZone: "monster_zone",
    destinationPlayer: "self",
    originalCause: "special_summon_procedure",
    originalCauseKind: "summon_procedure",
    extra: { controller: "self", faceUp: true, summoned: true, position: "attack" },
  }], { stage: "special_summon_procedure", continuousEffects });
  if (summonMoveResult.status !== "applied") return unknown(summonMoveResult.reason || "summon_procedure_summon_move_failed");

  const effectBanish = wasBanishedByCardEffect(materialMove);
  const movementEvents = [{
    id: `special-summoned:${summonCard.id}`,
    type: "special_summoned",
    subjectDefinitionId: summonCard.id,
    faceUpAfter: true,
    triggerWindowId: "post_special_summon",
  }, {
    id: `procedure-material-move:${materialCard.id}`,
    type: "card_banished",
    subjectDefinitionId: materialCard.id,
    actualToZone: materialMove.actualToZone,
    faceUpAfter: true,
    finalDestinationCauseKind: materialMove.finalDestinationCauseKind,
    originalCauseKind: materialMove.originalCauseKind,
    replacementEffectId: materialMove.replacementEffectId,
    replacementApplications: materialMove.replacementApplications,
    move: materialMove,
    triggerWindowId: "post_special_summon",
  }];
  const normalizedCardTexts = cards.map(toScenarioCardText);
  const publicId = `public-special-summon-trigger:${summonCard.id}`;
  const privateId = `private-effect-banish-trigger:${handCard.id}`;
  const triggerScenario = effectBanish
    ? analyzeSimultaneousTriggerScenario({
      userQuery: query,
      cardTexts: normalizedCardTexts,
      movementEvents,
      branchWitness: {
        publicTriggerSelections: [publicId],
        responseActions: [
          { player: "opponent", type: "pass" },
          { player: "self", type: "activate", candidateId: privateId },
        ],
      },
    })
    : null;
  if (effectBanish && triggerScenario?.complete !== true) {
    return unknown(triggerScenario?.reason || "simultaneous_trigger_chain_not_verified", { triggerScenario });
  }

  const replacementText = effectBanish
    ? `「${materialCard.name}」虽作为不入连锁召唤手续被除外，但其离场目的地替代是卡的效果，最终属于被卡的效果表侧除外。`
    : `「${materialCard.name}」仅由不入连锁的召唤手续除外，不属于被卡的效果除外。`;
  const shortAnswer = effectBanish
    ? `可以将「${materialCard.name}」除外，从额外卡组特殊召唤「${summonCard.name}」。若两个诱发效果都要发动，必须先声明场上公开信息的「${summonCard.name}」诱发效果为C1；把响应机会交给对方，对方不连锁时，才可将手牌「${handCard.name}」的诱发效果连锁为C2。`
    : `可以按该手续特殊召唤「${summonCard.name}」，但「${handCard.name}」不能因这次除外发动；这次最终除外并非由卡的效果造成。`;
  return {
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "legal",
    resolution: "special_summon_performed",
    shortAnswer,
    reasoning: [
      `召唤手续的回合历史条件与被除外怪兽选择条件均已满足，因此该特殊召唤可以进行。`,
      replacementText,
      effectBanish
        ? "公开区域的选发诱发效果先组成连锁；每次发动后优先权交给对方，手牌诱发并非可与公开诱发任意自排。"
        : "手牌诱发要求怪兽被卡的效果表侧除外，本次事件不满足该条件。",
    ],
    trace: [
      { phase: "summon_procedure_preflight", status: "legal", proof: premise },
      { phase: "execute_summon_procedure_material_move", status: "applied", proof: materialMove },
      { phase: "special_summon", status: "performed", proof: summonMoveResult.moves[0] },
      { phase: "collect_and_order_trigger_candidates", status: effectBanish ? "verified" : "hand_trigger_ineligible", proof: triggerScenario },
    ],
    evidenceIds: evidenceIds([summonCard, materialCard, handCard]),
    activationEvidenceType: "summon_condition_ir",
    movementEvents,
    simultaneousTriggerChain: triggerScenario,
    program: {
      summonProcedure: procedure,
      initialState: initialStateSnapshot,
      finalState: clone(summonMoveResult.gameState),
    },
  };
}

function inspectPremises({ query, procedure, movement, materialCard, summonCard, handCard }) {
  if (!mentionedWith(query, materialCard.names, /(?:场上|場上|field)/iu)
      || !mentionedWith(query, materialCard.names, /(?:表侧|表側|face-up)/iu)) {
    return { status: "unknown", reason: "procedure_material_field_state_unknown" };
  }
  const ownership = {
    material: inferEntityZoneOwner(query, materialCard, "monster_zone"),
    hand: inferEntityZoneOwner(query, handCard, "hand"),
    extraDeck: inferEntityZoneOwner(query, summonCard, "extra_deck"),
  };
  if (Object.values(ownership).some((claim) => claim.player === "unknown")) {
    return { status: "unknown", reason: "summon_procedure_zone_ownership_unknown", ownership };
  }
  if (ownership.material.player !== "self") {
    return {
      status: "illegal",
      reason: "procedure_material_controller_mismatch",
      conclusion: "该召唤手续要求除外自己场上的怪兽，题面所述怪兽由对方控制，不能作为该手续的怪兽。",
      ownership,
    };
  }
  if (ownership.extraDeck.player !== "self") {
    return {
      status: "illegal",
      reason: "procedure_summon_card_owner_mismatch",
      conclusion: "该召唤手续只能从进行手续者自己的额外卡组特殊召唤，题面的额外卡组归属不符合要求。",
      ownership,
    };
  }
  if (ownership.hand.player !== "self") {
    return { status: "unknown", reason: "hand_trigger_controller_mismatch", ownership };
  }
  for (const condition of procedure.historyConditions || []) {
    if (condition.type !== "spell_card_effect_activated_this_turn") {
      return { status: "unknown", reason: "summon_procedure_history_condition_unsupported" };
    }
    if (/(?:没有|未|尚未|并未|沒有)[^。；;]{0,20}(?:发动|發動|発動).{0,20}(?:魔法卡|魔法カード|Spell)/iu.test(query)) {
      return { status: "illegal", reason: "spell_effect_not_activated_this_turn", conclusion: "本回合没有发动过魔法卡的效果，不满足召唤手续的回合条件。" };
    }
    if (!/(?:本回合|这个回合|這個回合|このターン|this turn)[^。；;]{0,36}(?:已经|已|曾|already)?[^。；;]{0,16}(?:发动|發動|発動|activat)[^。；;]{0,20}(?:魔法卡|魔法カード|Spell)|(?:魔法卡|魔法カード|Spell)[^。；;]{0,20}(?:效果|効果|effect)[^。；;]{0,20}(?:本回合|这个回合|this turn)/iu.test(query)) {
      return { status: "unknown", reason: "spell_effect_turn_history_unknown" };
    }
  }
  const selectorResult = matchesSelector(materialCard, movement.selector || {});
  if (selectorResult === null) return { status: "unknown", reason: "procedure_material_properties_unknown" };
  if (!selectorResult) return { status: "illegal", reason: "procedure_material_selector_mismatch", conclusion: "被选择怪兽的等级、种族或属性不符合召唤手续。" };
  return { status: "legal", reason: "all_summon_procedure_premises_verified", ownership };
}

function matchesSelector(card, selector) {
  const level = finiteNumber(card.level ?? card.rank);
  const race = normalizeProperty(card.race);
  const attribute = normalizeProperty(card.attribute);
  if (selector.minimumLevel !== undefined && level === null) return null;
  if (selector.race && !race) return null;
  if (selector.attribute && !attribute) return null;
  if (selector.minimumLevel !== undefined && level < Number(selector.minimumLevel)) return false;
  if (selector.race && race !== normalizeProperty(selector.race)) return false;
  if (selector.attribute && attribute !== normalizeProperty(selector.attribute)) return false;
  return true;
}

function hasEffectBanishTrigger(card) {
  return (card.ir.effects || []).some((effect) => (
    effect.nature === "activated"
    && /(?=[^。；;]{0,180}(?:卡|カード|card).{0,12}(?:效果|効果|effect))(?=[^。；;]{0,180}(?:怪兽|怪獸|モンスター|monster))(?=[^。；;]{0,180}(?:除外|banish))/iu.test(effect.rawText)
  ));
}

function mergeCardFacts(resolvedCards, cardTexts) {
  const map = new Map();
  for (const item of [...(resolvedCards || []), ...(cardTexts || [])]) {
    const id = String(item.cardId || item.cardIds?.[0] || item.id || "").replace(/^card-text-/u, "");
    const names = unique([...(item.cards || []), item.input, item.name, item.cnName, item.jaName, item.jpName, item.enName, ...(item.aliases || [])]);
    const key = id || normalizeIdentity(names[0]);
    if (!key || !names.length) continue;
    const existing = map.get(key) || {};
    const merged = {
      ...existing,
      ...item,
      id: id || existing.id || key,
      name: item.name || existing.name || names[0],
      names: unique([...(existing.names || []), ...names]),
      text: String(item.effectText || item.text || existing.text || ""),
      level: item.level ?? item.rank ?? existing.level ?? existing.rank ?? null,
      race: item.race || existing.race || "",
      attribute: item.attribute || existing.attribute || "",
      evidenceIds: unique([...(existing.evidenceIds || []), item.id, ...(item.cardIds || [])]),
    };
    merged.ir = normalizeCardText({ ...merged, effectText: merged.text, aliases: merged.names });
    map.set(key, merged);
  }
  return [...map.values()].filter((card) => card.text);
}

function instance(card, zone, faceUp, player) {
  return {
    instanceId: `${card.id}#1`,
    definitionId: card.id,
    name: card.name,
    owner: player,
    controller: player,
    zone,
    faceUp,
    level: card.level,
    race: card.race,
    attribute: card.attribute,
  };
}

function toScenarioCardText(card) {
  return {
    id: card.id,
    cardId: card.id,
    title: card.name,
    name: card.name,
    cards: card.names,
    cardType: card.cardType || card.type || "monster",
    text: card.text,
  };
}

function mentionedWith(query, names, pattern) {
  return String(query || "").split(/[，,。；;！？?\n]+/u).some((clause) => (
    pattern.test(clause) && names.some((name) => normalizeIdentity(clause).includes(normalizeIdentity(name)))
  ));
}

function inferEntityZoneOwner(query, card, zone) {
  const zonePattern = zoneMentionPattern(zone);
  const ownerPatterns = explicitOwnerPatterns(zone);
  if (!zonePattern || !ownerPatterns) return { player: "unknown", basis: "unsupported_zone" };
  const contexts = String(query || "").split(/[。；;！？?\n]+/u).filter((clause) => (
    zonePattern.test(clause)
    && card.names.some((name) => normalizeIdentity(clause).includes(normalizeIdentity(name)))
  ));
  if (!contexts.length) return { player: "unknown", basis: "zone_and_entity_not_colocated" };
  const explicit = new Set();
  for (const context of contexts) {
    if (ownerPatterns.self.test(context)) explicit.add("self");
    if (ownerPatterns.opponent.test(context)) explicit.add("opponent");
  }
  if (explicit.size > 1) return { player: "unknown", basis: "contradictory_explicit_owners", contexts };
  if (explicit.size === 1) return { player: [...explicit][0], basis: "explicit_zone_owner", contexts };
  // In an OCG question, an unqualified action performed by the questioner
  // ("场上", "手牌", "从额外卡组") is the questioner's own zone.  We only
  // apply that discourse default after proving that the card and zone occur
  // together, and an explicit opposing owner always wins above.
  return { player: "self", basis: "questioner_unqualified_zone", contexts };
}

function zoneMentionPattern(zone) {
  if (zone === "monster_zone") return /(?:场上|場上|フィールド|field)/iu;
  if (zone === "hand") return /(?:手牌|手卡|手札|hand)/iu;
  if (zone === "extra_deck") return /(?:额外卡组|額外卡組|额外牌组|額外牌組|EXデッキ|エクストラデッキ|Extra Deck)/iu;
  return null;
}

function explicitOwnerPatterns(zone) {
  if (zone === "monster_zone") {
    return {
      self: /(?:自己|我方|己方|自分|my|our|your)(?:的|の)?\s*(?:场上|場上|フィールド|field)/iu,
      opponent: /(?:对方|對方|对手|相手|opponent(?:'s)?)(?:的|の)?\s*(?:场上|場上|フィールド|field)/iu,
    };
  }
  if (zone === "hand") {
    return {
      self: /(?:自己|我方|己方|自分|my|our|your)(?:的|の)?\s*(?:手牌|手卡|手札|hand)/iu,
      opponent: /(?:对方|對方|对手|相手|opponent(?:'s)?)(?:的|の)?\s*(?:手牌|手卡|手札|hand)/iu,
    };
  }
  if (zone === "extra_deck") {
    return {
      self: /(?:自己|我方|己方|自分|my|our|your)(?:的|の)?\s*(?:额外卡组|額外卡組|额外牌组|額外牌組|EXデッキ|エクストラデッキ|Extra Deck)/iu,
      opponent: /(?:对方|對方|对手|相手|opponent(?:'s)?)(?:的|の)?\s*(?:额外卡组|額外卡組|额外牌组|額外牌組|EXデッキ|エクストラデッキ|Extra Deck)/iu,
    };
  }
  return null;
}

function normalizeIdentity(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeProperty(value) {
  const key = normalizeIdentity(value).replace(/(?:属性|族|type)$/iu, "");
  const aliases = new Map([
    ["dark", "暗"], ["闇", "暗"],
    ["light", "光"],
    ["fire", "炎"],
    ["water", "水"],
    ["wind", "风"], ["風", "风"],
    ["earth", "地"],
    ["spellcaster", "魔法师"], ["魔法使い", "魔法师"],
  ]);
  return aliases.get(key) || key;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function evidenceIds(cards) {
  return unique(cards.flatMap((card) => card.evidenceIds || [`card-text-${card.id}`]));
}

function unknown(reason, extra = {}) {
  return { status: "not_applicable", complete: false, reason, ...extra };
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
