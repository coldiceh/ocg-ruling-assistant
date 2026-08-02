import { normalizeCardText } from "./cardTextNormalizer.mjs";
import {
  ACTIVATION_RESPONSE_PREDICATES,
  evaluateActivationResponsePredicate,
  executeSpellTrapCardActivationProcedure,
} from "./spellTrapActivationProcedure.mjs";

/**
 * Compiles the generic interaction between a Spell/Trap Card activation
 * procedure and an effect whose response window is restricted by the zone in
 * which the opponent's card effect was activated.
 *
 * Card names are used only to bind question mentions to card definitions.
 * The ruling is selected by normalized permissions, response predicates and
 * the immutable ActivationEvent produced by the procedure executor.
 */
export function analyzeActivationEventStateTransition({
  userQuery = "",
  cardTexts = [],
  resolvedCards = [],
} = {}) {
  const query = String(userQuery || "");
  const definitions = buildDefinitions(cardTexts, resolvedCards);
  const mentioned = definitions.filter((definition) => locateMention(query, definition.names) >= 0);
  const sourceCandidates = mentioned
    .map((definition) => ({
      definition,
      permission: parseFromHandCardActivationPermission(definition.effectText),
    }))
    .filter((candidate) => candidate.permission);
  const responderCandidates = mentioned.flatMap((definition) => (
    (definition.ir.effects || []).flatMap((effect) => {
      const predicate = parseActivationResponsePredicate(effect.rawText);
      return predicate ? [{ definition, effect, predicate }] : [];
    })
  ));

  if (!sourceCandidates.length || !responderCandidates.length) return null;
  if (sourceCandidates.length !== 1 || responderCandidates.length !== 1) {
    return unknown("activation_event_source_or_responder_ambiguous", {
      sourceCandidateCount: sourceCandidates.length,
      responderCandidateCount: responderCandidates.length,
    });
  }

  const source = sourceCandidates[0];
  const responder = responderCandidates[0];
  if (!asksResponseLegality(query, responder.definition.names)) {
    return unknown("activation_response_question_not_explicit");
  }
  if (!activationFromHandExplicit(query, source.definition.names)) {
    return unknown("spell_trap_hand_origin_not_explicit");
  }
  const activatingPlayer = controllerNearMention(query, source.definition.names);
  const responderPlayer = controllerNearMention(query, responder.definition.names);
  if (!activatingPlayer || !responderPlayer || activatingPlayer === responderPlayer) {
    return unknown("activation_response_player_relation_unknown", {
      activatingPlayer,
      responderPlayer,
    });
  }
  if (!responderOnFieldExplicit(query, responder.definition.names)) {
    return unknown("activation_response_source_field_state_unknown");
  }
  if (responder.predicate.requiresNormalSummonedSource
      && !normalSummonedExplicit(query, responder.definition.names)) {
    return unknown("activation_response_normal_summon_state_unknown");
  }
  const fieldEmpty = controllerFieldEmptyExplicit(query, source.definition.names)
    || activationPermissionMethodExplicit(query, source.definition.names);
  if (!fieldEmpty) return unknown("activating_player_field_empty_state_unknown");

  const sourceInstanceId = `${source.definition.definitionId}#activation-source`;
  const responderInstanceId = `${responder.definition.definitionId}#response-source`;
  const procedure = executeSpellTrapCardActivationProcedure({
    gameState: {
      cards: [
        runtimeCard(source.definition, {
          instanceId: sourceInstanceId,
          controller: activatingPlayer,
          zone: "HAND",
          faceUp: false,
        }),
        runtimeCard(responder.definition, {
          instanceId: responderInstanceId,
          controller: responderPlayer,
          zone: "MONSTER_ZONE",
          faceUp: true,
          normalSummoned: responder.predicate.requiresNormalSummonedSource,
        }),
      ],
      fieldStateCompleteByPlayer: { [activatingPlayer]: true },
      spellTrapZoneHasCapacityByPlayer: { [activatingPlayer]: true },
    },
    declaration: {
      player: activatingPlayer,
      sourceInstanceId,
      sourceCardType: source.definition.cardType,
      effectId: firstActivatedEffectId(source.definition.ir) || "CARD_ACTIVATION_EFFECT",
      fieldEmpty: true,
      spellTrapZoneHasCapacity: true,
      fromHandPermission: {
        status: "CONFIRMED",
        allowed: true,
        requiresControllerFieldEmpty: source.permission.requiresControllerFieldEmpty,
        fieldEmpty: true,
      },
    },
  });
  if (procedure.status !== "ACTIVATED" || !procedure.activationEvent) {
    return unknown("spell_trap_activation_procedure_not_executed", { procedure });
  }
  const response = evaluateActivationResponsePredicate({
    activationEvent: procedure.activationEvent,
    predicate: responder.predicate,
    responderPlayer,
  });
  if (response.status !== "DECIDED") {
    return unknown("activation_response_predicate_not_decided", { procedure, response });
  }

  const sourceName = source.definition.name;
  const responderName = responder.definition.name;
  const zoneScope = responseZoneScopeLabel(responder.predicate.zones);
  const result = response.matches
    ? `可以连锁发动「${responderName}」的该效果。`
    : `不能连锁发动「${responderName}」的该效果。`;
  const placement = `从手牌发动「${sourceName}」时，先按魔法・陷阱卡的卡的发动手续将其表侧放到魔法与陷阱区域。`;
  const frozenEvent = `随后建立的发动事件中，最初区域是手牌，但实际发动区域已冻结为魔法与陷阱区域。`;
  const predicateConclusion = response.matches
    ? `该区域符合「${responderName}」要求的${zoneScope}发动条件。`
    : `该区域不符合「${responderName}」只对应${zoneScope}发动的条件；最初来自手牌不会改写实际发动区域。`;

  return {
    status: "resolved",
    complete: true,
    authoritative: true,
    conditional: false,
    activation: response.matches ? "legal" : "illegal",
    activationBasis: "immutable_activation_event_zone_predicate",
    resolution: response.matches ? "response_condition_met" : "response_condition_not_met",
    reason: response.reason,
    shortAnswer: `${result}${placement}${predicateConclusion}`,
    reasoning: [placement, frozenEvent, predicateConclusion],
    trace: [
      ...procedure.trace,
      {
        phase: "freeze_activation_event",
        event: procedure.activationEvent,
      },
      {
        phase: "evaluate_response_predicate",
        predicate: responder.predicate,
        result: response,
      },
    ],
    evidenceIds: evidenceForDefinitions(cardTexts, [source.definition, responder.definition]),
    activationEvidenceType: "activation_event_execution",
    program: {
      type: "compiled_activation_event_response",
      semanticSource: "card_text_ir_and_rule_procedure",
      sourcePermission: source.permission,
      responsePredicate: responder.predicate,
      activationEvent: procedure.activationEvent,
      responseDecision: response,
    },
  };
}

export function parseFromHandCardActivationPermission(text) {
  const value = clean(text);
  if (!value) return null;
  const fromHand = /(?:从|從)(?:自己)?(?:手牌|手卡|手札)(?:也)?(?:可以|可|能)?(?:发动|發動|発動)|(?:手牌|手卡|手札)(?:也)?(?:可以|可|能)(?:发动|發動)|(?:手札からも発動|activate (?:this card )?from (?:your )?hand)/iu.test(value);
  const fieldEmpty = /(?:(?:自己|自分|your)(?:的)?(?:场上|場上|フィールド|field).{0,28}(?:没有|沒有|不存在|存在しない|control no|no cards?)[^。；;]{0,20}(?:卡|カード|cards?)|(?:自己|自分|your).{0,16}(?:场上|場上|フィールド|field).{0,16}(?:卡|カード|cards?).{0,16}(?:没有|沒有|不存在|存在しない|control no))/iu.test(value);
  if (!fromHand || !fieldEmpty) return null;
  return {
    type: "spell_trap_card_activation_permission",
    originZone: "HAND",
    requiresControllerFieldEmpty: true,
    text: value,
  };
}

export function parseActivationResponsePredicate(text) {
  const value = clean(text);
  if (!value) return null;
  const opponent = /(?:对方|對方|对手|對手|相手|opponent)/iu.test(value);
  const activatesEffect = /(?:卡的效果|卡片效果|カードの効果|card(?:'s)? effect).{0,28}(?:发动|發動|発動|activat)|(?:发动|發動|発動|activat).{0,28}(?:卡的效果|卡片效果|カードの効果|card(?:'s)? effect)/iu.test(value);
  if (!opponent || !activatesEffect) return null;
  const zones = [];
  if (/(?:手牌|手卡|手札|hand)/iu.test(value)) zones.push("HAND");
  if (/(?:墓地|graveyard|GY)/iu.test(value)) zones.push("GRAVEYARD");
  if (/(?:除外状态|除外狀態|除外されている|banished)/iu.test(value)) zones.push("BANISHED");
  if (!zones.length) return null;
  return {
    type: ACTIVATION_RESPONSE_PREDICATES.CARD_EFFECT_ACTIVATED_FROM_ZONE,
    actorRelation: "OPPONENT",
    zones: unique(zones),
    requiresNormalSummonedSource: /(?:通常召唤|通常召喚|アドバンス召喚|Normal Summoned|Tribute Summoned)/iu.test(value),
    text: value,
  };
}

function buildDefinitions(cardTexts, resolvedCards) {
  const resolved = (resolvedCards || []).map((card, index) => ({
    ...card,
    definitionId: String(card.definitionId || card.id || card.cardId || `resolved-${index + 1}`),
    names: identityNames(card),
  }));
  const definitions = [];
  const consumed = new Set();
  for (const [index, item] of (cardTexts || []).entries()) {
    const evidenceNames = identityNames(item);
    const matches = resolved.filter((candidate) => namesOverlap(evidenceNames, candidate.names));
    const base = matches.length === 1 ? matches[0] : {};
    if (matches.length === 1) consumed.add(base.definitionId);
    const names = unique([...evidenceNames, ...(base.names || [])]);
    const definitionId = String(base.definitionId || item.definitionId || item.cardId || item.id || `card-text-${index + 1}`);
    const effectText = String(item.effectText || item.text || base.effectText || base.text || "");
    const card = {
      ...base,
      ...item,
      id: definitionId,
      cardId: definitionId,
      name: String(base.name || item.name || names[0] || definitionId),
      aliases: names,
      cardType: item.cardType || base.cardType || base.type || "unknown",
      effectText,
    };
    definitions.push(definitionFromCard(card, definitionId, names));
  }
  for (const card of resolved) {
    if (consumed.has(card.definitionId)) continue;
    definitions.push(definitionFromCard({
      ...card,
      id: card.definitionId,
      aliases: card.names,
      effectText: card.effectText || card.text || "",
    }, card.definitionId, card.names));
  }
  return dedupeDefinitions(definitions);
}

function definitionFromCard(card, definitionId, names) {
  const effectText = String(card.effectText || card.text || "");
  return {
    definitionId,
    name: String(card.name || names[0] || definitionId),
    names: unique(names),
    cardType: card.cardType || card.type || "unknown",
    effectText,
    ir: normalizeCardText({ ...card, id: definitionId, effectText }),
  };
}

function dedupeDefinitions(definitions) {
  const output = [];
  for (const definition of definitions) {
    const existing = output.find((candidate) => candidate.definitionId === definition.definitionId);
    if (!existing) {
      output.push(definition);
      continue;
    }
    existing.names = unique([...existing.names, ...definition.names]);
    if (!existing.effectText && definition.effectText) Object.assign(existing, definition);
  }
  return output;
}

function runtimeCard(definition, overrides) {
  return {
    instanceId: overrides.instanceId,
    cardId: definition.definitionId,
    definitionId: definition.definitionId,
    name: definition.name,
    controller: overrides.controller,
    owner: overrides.controller,
    zone: overrides.zone,
    faceUp: overrides.faceUp,
    normalSummoned: overrides.normalSummoned === true,
    cardType: definition.cardType,
  };
}

function firstActivatedEffectId(ir) {
  return (ir.effects || []).find((effect) => effect.nature === "activated")?.id || "";
}

function activationFromHandExplicit(query, names) {
  const context = contextAroundMention(query, names, 80);
  return /(?:从|從)(?:自己|对方|對方)?(?:的)?(?:手牌|手卡|手札).{0,36}(?:发动|發動|発動|activate)|(?:手牌|手卡|手札).{0,18}(?:的|中)?[^。；;]{0,28}(?:发动|發動|発動|activate)/iu.test(context);
}

function activationPermissionMethodExplicit(query, names) {
  const context = contextAroundMention(query, names, 120);
  return /(?:以|用|通过|通過|按照|按).{0,24}(?:自己|自分|your).{0,20}(?:场上|場上|field).{0,24}(?:没有|沒有|不存在|存在しない|no).{0,28}(?:从|從).{0,12}(?:手牌|手卡|手札|hand).{0,12}(?:发动|發動|発動|activate)/iu.test(context);
}

function controllerFieldEmptyExplicit(query, names) {
  const controller = controllerNearMention(query, names);
  if (!controller) return false;
  const player = controller === "self" ? /(?:我方|自己)/u : /(?:对方|對方|对手|對手|相手)/u;
  const clauses = String(query).split(/[。；;!?！？\n]+/u);
  return clauses.some((clause) => (
    player.test(clause)
    && /(?:场上|場上|field).{0,20}(?:没有|沒有|不存在|no).{0,12}(?:卡|cards?)/iu.test(clause)
  ));
}

function responderOnFieldExplicit(query, names) {
  const context = contextAroundMention(query, names, 72);
  return /(?:场上|場上|怪兽区域|怪獸區域|モンスターゾーン|field|Monster Zone).{0,50}[「『【“"]?[^。；;]*$/iu.test(context.slice(0, 90))
    || /(?:存在|在场|在場|表侧|表側|face-up)/iu.test(context);
}

function normalSummonedExplicit(query, names) {
  return /(?:通常召唤|通常召喚|Normal Summoned|Tribute Summoned)/iu.test(contextAroundMention(query, names, 72));
}

function asksResponseLegality(query, names) {
  const context = contextAroundMention(query, names, 110);
  return /(?:可以|能否|能不能|是否(?:可以|能够|能)?|可否|can).{0,30}(?:连锁|連鎖|チェーン|chain).{0,30}(?:发动|發動|発動|activate)|(?:连锁|連鎖|チェーン|chain).{0,30}(?:发动|發動|発動|activate).{0,20}(?:吗|嗎|是否|can|[?？])/iu.test(context);
}

function controllerNearMention(query, names) {
  const rawIndex = locateRawMention(query, names);
  if (rawIndex < 0) return "";
  const before = String(query).slice(Math.max(0, rawIndex - 90), rawIndex);
  const clause = before.slice(Math.max(
    before.lastIndexOf("。"),
    before.lastIndexOf("；"),
    before.lastIndexOf(";"),
    before.lastIndexOf("？"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
  ) + 1);
  const tokens = [...clause.matchAll(/我方|自己|对方|對方|对手|對手|相手|opponent|my|your/giu)];
  const token = String(tokens.at(-1)?.[0] || "").toLowerCase();
  if (/对方|對方|对手|對手|相手|opponent/u.test(token)) return "opponent";
  if (/我方|自己|my|your/u.test(token)) return "self";
  return "";
}

function contextAroundMention(query, names, radius) {
  const index = locateRawMention(query, names);
  if (index < 0) return "";
  return String(query).slice(Math.max(0, index - radius), index + radius);
}

function locateRawMention(query, names) {
  let best = -1;
  for (const name of unique(names).sort((left, right) => right.length - left.length)) {
    const index = String(query).indexOf(name);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function locateMention(query, names) {
  const haystack = normalizeIdentity(query);
  let best = -1;
  for (const name of unique(names).sort((left, right) => right.length - left.length)) {
    const needle = normalizeIdentity(name);
    if (needle.length < 2) continue;
    const index = haystack.indexOf(needle);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function identityNames(card = {}) {
  return unique([
    ...(Array.isArray(card.cards) ? card.cards : []),
    ...(Array.isArray(card.cardNames) ? card.cardNames : []),
    card.input,
    card.matchedQuery,
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
  ]);
}

function evidenceForDefinitions(cardTexts, definitions) {
  const ids = [];
  for (const item of cardTexts || []) {
    const itemNames = identityNames(item);
    if (!definitions.some((definition) => namesOverlap(itemNames, definition.names))) continue;
    const id = String(item.id || item.evidenceId || item.cardId || "");
    if (id) ids.push(id);
  }
  return unique(ids);
}

function namesOverlap(left, right) {
  const rightKeys = new Set(unique(right).map(normalizeIdentity).filter(Boolean));
  return unique(left).some((name) => rightKeys.has(normalizeIdentity(name)));
}

function responseZoneScopeLabel(zones) {
  const labels = { HAND: "手牌", GRAVEYARD: "墓地", BANISHED: "除外状态" };
  return unique(zones).map((zone) => labels[zone] || zone).join("・") + "中的卡的效果";
}

function normalizeIdentity(value) {
  return clean(value).toLowerCase().replace(/[「」『』【】“”"'・·･＝=－—–_\-\s，,。.!！?？;；、()（）\[\]{}]/gu, "");
}

function clean(value) {
  return String(value || "").normalize("NFKC").trim();
}

function unknown(reason, debug = {}) {
  return {
    status: "unknown",
    complete: false,
    authoritative: false,
    conditional: false,
    activation: "unknown",
    resolution: "unknown",
    reason,
    authorityReason: "activation_event_execution_unverified",
    authorityReasons: [reason],
    shortAnswer: "发动区域或响应条件所需的范式化状态不足，当前不能形成权威结论。",
    reasoning: ["缺失的卡片身份、发动手续、区域或玩家关系不能用猜测补全。"],
    trace: [],
    evidenceIds: [],
    debug,
  };
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}
