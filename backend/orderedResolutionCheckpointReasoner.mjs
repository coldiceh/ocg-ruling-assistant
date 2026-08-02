import { normalizeCardText } from "./cardTextNormalizer.mjs";
import { createEffectPrimitive } from "./effectPrimitives.mjs";
import { resolveEffectChain } from "./effectResolutionEngine.mjs";

/**
 * Compile effects whose resolution has the generic shape
 *
 *   tribute this card as activation cost
 *   -> Special Summon two specifically named monsters at the same time
 *   -> THEN optionally destroy one card on the field
 *   -> run the ordinary after-resolution field-limit checkpoint
 *
 * The compiler is intentionally driven only by normalized card-text IR and
 * typed duel-state facts. Card names are display/identity data and never pick
 * a ruling branch.
 */
export function analyzeOrderedResolutionCheckpoint({
  userQuery = "",
  cardTexts = [],
  resolvedCards = [],
} = {}) {
  const query = String(userQuery || "");
  const definitions = buildDefinitions(cardTexts, resolvedCards);
  const mentioned = definitions.filter((definition) => locateMention(query, definition.names) >= 0);
  const sourceCandidates = mentioned.flatMap((definition) => (
    (definition.ir.effects || [])
      .filter(isOrderedSummonDestroyEffect)
      .map((effect) => ({ definition, effect }))
  ));
  const limitCandidates = mentioned.flatMap((definition) => (
    (definition.ir.effects || []).flatMap((effect) => (
      (effect.continuous || [])
        .filter(isPerPlayerSameRaceLimit)
        .map((limit) => ({ definition, effect, limit }))
    ))
  ));

  // Do not capture unrelated questions merely because they mention a field
  // limit or an effect with an optional destruction clause. This compiler owns
  // the question only when both sides of its semantic contract are present.
  if (!sourceCandidates.length || !limitCandidates.length) return null;
  if (sourceCandidates.length !== 1 || limitCandidates.length !== 1) {
    return unknown("ordered_resolution_checkpoint_source_ambiguous", {
      sourceCandidateCount: sourceCandidates.length,
      limitCandidateCount: limitCandidates.length,
    });
  }
  if (!activationLegalityAsked(query)) {
    return unknown("ordered_resolution_checkpoint_activation_question_not_explicit");
  }

  const sourceCandidate = sourceCandidates[0];
  const limitCandidate = limitCandidates[0];
  const sourceController = controllerNearMention(query, sourceCandidate.definition.names);
  const limitController = controllerNearMention(query, limitCandidate.definition.names);
  if (!sourceController || !limitController) {
    return unknown("ordered_resolution_checkpoint_controller_unknown");
  }
  if (!fieldPresenceExplicit(query, sourceCandidate.definition.names)
      || !fieldPresenceExplicit(query, limitCandidate.definition.names)) {
    return unknown("ordered_resolution_checkpoint_field_presence_unknown");
  }

  const resolution = sourceCandidate.effect.resolution || [];
  const summonStep = resolution.find((step) => step.operation?.type === "special_summon");
  const destroyStep = resolution.find((step) => step.operation?.type === "destroy");
  const summon = summonStep?.operation || {};
  const destroy = destroyStep?.operation || {};
  const summonNames = unique(summon.names || (summon.name ? [summon.name] : []));
  const fromZones = unique(summon.fromZones || (summon.fromZone ? [summon.fromZone] : []));
  if (Number(summon.amount) !== 2
      || summonNames.length !== 2
      || summon.simultaneous !== true
      || !fromZones.includes("deck")
      || !fromZones.includes("graveyard")) {
    return unknown("ordered_resolution_checkpoint_summon_contract_incomplete", {
      summon,
    });
  }
  if (destroyStep.connector !== "THEN"
      || destroy.optional !== true
      || destroy.selector?.zone !== "field"
      || Number(destroy.selector?.amount) !== 1) {
    return unknown("ordered_resolution_checkpoint_destroy_contract_incomplete", {
      destroyStep,
    });
  }

  const outputDefinitions = summonNames.map((name) => resolveDefinitionByName(definitions, name));
  if (outputDefinitions.some((definition) => !definition)) {
    return unknown("ordered_resolution_checkpoint_output_definition_unresolved", { summonNames });
  }
  if (new Set(outputDefinitions.map((definition) => definition.definitionId)).size !== 2) {
    return unknown("ordered_resolution_checkpoint_output_definition_ambiguous", { summonNames });
  }
  const outputRaces = outputDefinitions.map((definition) => normalizeRace(definition.race));
  if (outputRaces.some((race) => !race)) {
    return unknown("ordered_resolution_checkpoint_output_race_unknown", { summonNames });
  }
  if (new Set(outputRaces).size !== 1) {
    return unknown("ordered_resolution_checkpoint_outputs_do_not_share_limited_group", {
      outputRaces,
    });
  }

  const sourceInstanceId = `${sourceCandidate.definition.definitionId}#effect-source`;
  const limitInstanceId = `${limitCandidate.definition.definitionId}#field-limit`;
  const outputInstanceIds = outputDefinitions.map((definition, index) => (
    `${definition.definitionId}#effect-output-${index + 1}`
  ));
  const baseCards = [
    runtimeCard(sourceCandidate.definition, {
      instanceId: sourceInstanceId,
      controller: sourceController,
      zone: "monster_zone",
      faceUp: true,
    }),
    runtimeCard(limitCandidate.definition, {
      instanceId: limitInstanceId,
      controller: limitController,
      zone: "spell_trap_zone",
      faceUp: true,
    }),
    runtimeCard(outputDefinitions[0], {
      instanceId: outputInstanceIds[0],
      controller: sourceController,
      zone: "deck",
      faceUp: false,
    }),
    runtimeCard(outputDefinitions[1], {
      instanceId: outputInstanceIds[1],
      controller: sourceController,
      zone: "graveyard",
      faceUp: false,
    }),
  ];
  const continuousEffect = {
    id: `${limitCandidate.effect.id}@${limitInstanceId}`,
    sourceCardId: limitInstanceId,
    sourceInstanceId: limitInstanceId,
    sourceDefinitionId: limitCandidate.definition.definitionId,
    sourceCardName: limitCandidate.definition.name,
    semanticSource: "card_text_ir",
    activeWhen: { zone: "spell_trap_zone", faceUp: true },
    fieldRestrictions: [{
      type: "max_face_up_monsters_per_race_per_player",
      maxCount: Number(limitCandidate.limit.maxCount) || 1,
    }],
  };

  const carrierBranch = simulateBranch({
    cards: baseCards,
    sourceCandidate,
    sourceInstanceId,
    outputInstanceIds,
    target: baseCards[1],
    continuousEffect,
    sourceController,
  });
  if (!carrierBranch.complete) {
    return unknown("ordered_resolution_checkpoint_carrier_branch_incomplete", carrierBranch);
  }
  const carrierCheckpoint = carrierBranch.linkResults[0]?.afterResolutionCheckpoint;
  const carrierOutputsRemain = outputInstanceIds.every((instanceId) => (
    zoneOf(carrierBranch.finalGameState, instanceId) === "monster_zone"
  ));
  const carrierDestroyed = zoneOf(carrierBranch.finalGameState, limitInstanceId) === "graveyard";
  if (!carrierDestroyed || !carrierOutputsRemain || carrierCheckpoint?.adjustments?.length) {
    return unknown("ordered_resolution_checkpoint_carrier_branch_unverified", { carrierBranch });
  }

  const asksOtherBranch = otherCardBranchAsked(query);
  let otherBranch = null;
  if (asksOtherBranch) {
    const otherTarget = {
      instanceId: "branch-other-field-card#1",
      cardId: "branch-other-field-card",
      definitionId: "branch-other-field-card",
      name: "其他场上卡片",
      controller: limitController,
      owner: limitController,
      zone: "spell_trap_zone",
      faceUp: true,
      cardKind: "spell_trap",
    };
    otherBranch = simulateBranch({
      cards: [...baseCards, otherTarget],
      sourceCandidate,
      sourceInstanceId,
      outputInstanceIds,
      target: otherTarget,
      continuousEffect,
      sourceController,
    });
    if (!otherBranch.complete) {
      return unknown("ordered_resolution_checkpoint_other_branch_incomplete", otherBranch);
    }
    const adjustment = otherBranch.linkResults[0]?.afterResolutionCheckpoint?.adjustments?.[0];
    if (zoneOf(otherBranch.finalGameState, limitInstanceId) !== "spell_trap_zone"
        || adjustment?.status !== "choice_required"
        || Number(adjustment.sendCount) !== 1
        || !sameMembers(adjustment.candidateInstanceIds, outputInstanceIds)) {
      return unknown("ordered_resolution_checkpoint_other_branch_unverified", { otherBranch });
    }
  }

  const sourceName = sourceCandidate.definition.name;
  const limitName = limitCandidate.definition.name;
  const outputNames = outputDefinitions.map((definition) => definition.name);
  const activationCostConclusion = `发动时先将「${sourceName}」自身解放作为 cost。`;
  const orderedResolutionConclusion = `效果处理时，先把「${outputNames[0]}」和「${outputNames[1]}」同时特殊召唤；之后才可以选择破坏场上1张卡。`;
  const carrierConclusion = `若破坏「${limitName}」，整个效果处理结束后的检查点中该限制已不再适用，两只怪兽都正常留在场上。`;
  const otherConclusion = asksOtherBranch
    ? `若破坏其他卡，「${limitName}」在效果处理完毕后仍适用，此时必须从「${outputNames[0]}」「${outputNames[1]}」中选择1只送去墓地。`
    : "";
  const evidenceIds = evidenceForDefinitions(cardTexts, [
    sourceCandidate.definition,
    limitCandidate.definition,
    ...outputDefinitions,
  ]);
  const carrierBranchSummary = summarizeBranch(carrierBranch, [
    limitInstanceId,
    ...outputInstanceIds,
  ]);
  const otherBranchSummary = otherBranch
    ? summarizeBranch(otherBranch, [limitInstanceId, ...outputInstanceIds])
    : null;

  return {
    status: "resolved",
    complete: true,
    authoritative: true,
    conditional: false,
    activation: "legal",
    activationBasis: "compiled_cost_operation_and_checkpoint",
    resolution: "ordered_resolution_with_after_effect_checkpoint",
    reason: "ordered_resolution_checkpoint_executed",
    shortAnswer: `可以发动。${orderedResolutionConclusion}${carrierConclusion}${otherConclusion}`,
    reasoning: [
      activationCostConclusion,
      orderedResolutionConclusion,
      "同种族数量限制的稳定化不插入同一个效果的两个处理步骤之间，而是在该效果完整处理后执行。",
      carrierConclusion,
      otherConclusion,
    ].filter(Boolean),
    trace: [
      {
        phase: "compile_ordered_effect",
        semanticSource: "card_text_ir",
        sourceDefinitionId: sourceCandidate.definition.definitionId,
        cost: "tribute_effect_source",
        resolutionOrder: ["simultaneous_special_summon", "optional_destroy", "field_limit_checkpoint"],
      },
      {
        phase: "execute_destroy_limit_carrier_branch",
        status: "verified",
        proof: carrierBranchSummary,
      },
      ...(otherBranch ? [{
        phase: "execute_destroy_other_card_branch",
        status: "verified",
        proof: otherBranchSummary,
      }] : []),
    ],
    evidenceIds,
    activationEvidenceType: "effect_program",
    program: {
      type: "compiled_ordered_resolution_checkpoint",
      semanticSource: "card_text_ir",
      sourceEffect: sourceCandidate.effect,
      continuousLimit: limitCandidate.limit,
      outputDefinitionIds: outputDefinitions.map((definition) => definition.definitionId),
      branches: {
        destroyLimitCarrier: carrierBranchSummary,
        ...(otherBranchSummary ? { destroyOtherCard: otherBranchSummary } : {}),
      },
    },
  };
}

function isOrderedSummonDestroyEffect(effect = {}) {
  const tribute = (effect.activation?.costs || []).find((cost) => (
    cost.type === "tribute" && cost.subject === "effect_source"
  ));
  if (!tribute) return false;
  const resolution = effect.resolution || [];
  const summonIndex = resolution.findIndex((step) => step.operation?.type === "special_summon");
  const destroyIndex = resolution.findIndex((step) => step.operation?.type === "destroy");
  return effect.nature === "activated"
    && summonIndex >= 0
    && destroyIndex > summonIndex;
}

function isPerPlayerSameRaceLimit(semantic = {}) {
  return semantic.type === "field_count_limit"
    && semantic.scope === "per_player"
    && semantic.groupBy === "race"
    && Number(semantic.maxCount) === 1;
}

function simulateBranch({
  cards,
  sourceCandidate,
  sourceInstanceId,
  outputInstanceIds,
  target,
  continuousEffect,
  sourceController,
}) {
  return resolveEffectChain({
    gameState: { cards: clone(cards) },
    continuousEffects: [continuousEffect],
    chainLinks: [{
      id: "C1",
      order: 1,
      sourceCardId: sourceInstanceId,
      sourceInstanceId,
      sourceDefinitionId: sourceCandidate.definition.definitionId,
      sourceCardName: sourceCandidate.definition.name,
      sourceExpectedZone: "monster_zone",
      effectId: sourceCandidate.effect.id,
      effectCategory: "monster",
      activationPremise: "derived",
      activationCostSequence: [{
        id: "tribute-effect-source",
        connector: "INDEPENDENT",
        primitive: createEffectPrimitive("tribute_cards", {
          player: sourceController,
          cardInstanceIds: [sourceInstanceId],
          amount: 1,
          fromZone: "monster_zone",
        }),
      }],
      sequence: [
        {
          id: "special-summon-named-pair",
          connector: "INDEPENDENT",
          primitive: createEffectPrimitive("special_summon_cards", {
            cardInstanceIds: outputInstanceIds,
            controller: sourceController,
            destinationZone: "monster_zone",
            simultaneous: true,
          }),
        },
        {
          id: "optional-destroy-one-field-card",
          connector: "THEN",
          primitive: createEffectPrimitive("destroy_target", {
            targetInstanceId: target.instanceId,
            targetExpectedZone: target.zone,
            optional: true,
          }),
        },
      ],
      targets: [{
        cardId: target.instanceId,
        instanceId: target.instanceId,
        definitionId: target.definitionId,
        name: target.name,
        expectedZone: target.zone,
        validAtResolution: true,
      }],
    }],
  });
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
    if (matches.length === 1) consumed.add(matches[0].definitionId);
    const names = unique([...evidenceNames, ...(base.names || [])]);
    const definitionId = String(base.definitionId || item.definitionId || item.cardId || item.id || `card-text-${index + 1}`);
    const text = String(item.effectText || item.text || base.effectText || base.text || "");
    const card = {
      ...base,
      ...item,
      id: definitionId,
      cardId: definitionId,
      name: String(base.name || item.name || names[0] || definitionId),
      aliases: names,
      cardType: item.cardType || base.cardType || base.type || "unknown",
      effectText: text,
    };
    definitions.push({
      definitionId,
      name: card.name,
      names,
      race: String(base.race || item.race || ""),
      cardType: card.cardType,
      effectText: text,
      ir: normalizeCardText(card),
    });
  }
  for (const card of resolved) {
    if (consumed.has(card.definitionId)) continue;
    const text = String(card.effectText || card.text || "");
    definitions.push({
      definitionId: card.definitionId,
      name: String(card.name || card.names[0] || card.definitionId),
      names: card.names,
      race: String(card.race || ""),
      cardType: card.cardType || card.type || "unknown",
      effectText: text,
      ir: normalizeCardText({
        ...card,
        id: card.definitionId,
        aliases: card.names,
        effectText: text,
      }),
    });
  }
  return dedupeDefinitions(definitions);
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
    existing.race ||= definition.race;
    if (!existing.effectText && definition.effectText) {
      existing.effectText = definition.effectText;
      existing.ir = definition.ir;
    }
  }
  return output;
}

function resolveDefinitionByName(definitions, printedName) {
  const key = normalizeIdentity(printedName);
  const exact = definitions.filter((definition) => (
    definition.names.some((name) => normalizeIdentity(name) === key)
  ));
  return exact.length === 1 ? exact[0] : null;
}

function runtimeCard(definition, overrides) {
  const controller = overrides.controller;
  return {
    instanceId: overrides.instanceId,
    cardId: definition.definitionId,
    definitionId: definition.definitionId,
    name: definition.name,
    controller,
    owner: controller,
    zone: overrides.zone,
    onField: ["monster_zone", "spell_trap_zone"].includes(overrides.zone),
    faceUp: overrides.faceUp,
    cardKind: /monster/iu.test(String(definition.cardType || "")) ? "monster" : "spell_trap",
    ...(definition.race ? { race: definition.race } : {}),
  };
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

function controllerNearMention(query, names) {
  const index = locateMention(query, names);
  if (index < 0) return "";
  const before = query.slice(Math.max(0, index - 52), index);
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

function fieldPresenceExplicit(query, names) {
  const index = locateMention(query, names);
  if (index < 0) return false;
  const context = query.slice(Math.max(0, index - 48), index + 48);
  return /(?:场上|場上|怪兽区域|怪獸區域|魔法与陷阱区域|魔法與陷阱區域|field|zone).{0,32}[「『【“"]?[^。；;]{0,28}$/iu.test(context.slice(0, 64))
    || /(?:存在|在场|在場|face-up|表侧|表側)/iu.test(context);
}

function activationLegalityAsked(query) {
  return /(?:可以|能否|能不能|是否(?:可以|能够|能)?|可否|可不可以|can).{0,24}(?:发动|發動|発動|activate)|(?:发动|發動|発動|activate).{0,24}(?:吗|嗎|是否|can|[?？])/iu.test(query);
}

function otherCardBranchAsked(query) {
  return /(?:破坏|破壊|destroy)[^。；;]{0,18}(?:其他|其它|别的|別の|another|other)[^。；;]{0,12}(?:卡|card)|(?:其他|其它|别的|別の|another|other)[^。；;]{0,18}(?:卡|card)[^。；;]{0,12}(?:破坏|破壊|destroy)/iu.test(query);
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

function namesOverlap(left, right) {
  const rightKeys = new Set(unique(right).map(normalizeIdentity).filter(Boolean));
  return unique(left).some((name) => rightKeys.has(normalizeIdentity(name)));
}

function normalizeIdentity(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』【】“”"'・·･＝=－—–_\-\s，,。.!！?？;；、()（）\[\]{}]/gu, "");
}

function normalizeRace(value) {
  return normalizeIdentity(value).replace(/族$/u, "");
}

function zoneOf(simulation, instanceId) {
  const state = simulation?.finalGameState || simulation || {};
  return state.cards?.find((card) => card.instanceId === instanceId)?.zone || "";
}

function summarizeBranch(simulation, trackedInstanceIds) {
  const link = simulation.linkResults?.[0] || {};
  const checkpoint = link.afterResolutionCheckpoint || {};
  return {
    complete: simulation.complete === true,
    activationStatus: simulation.activationResults?.[0]?.status || "unknown",
    resolutionStatus: link.status || "unknown",
    operationOrder: (link.primitiveResult?.steps || []).map((step) => step.primitive),
    finalZones: Object.fromEntries((trackedInstanceIds || []).map((instanceId) => [
      instanceId,
      zoneOf(simulation, instanceId),
    ])),
    afterResolutionCheckpoint: {
      complete: checkpoint.complete === true,
      reason: checkpoint.reason || "",
      adjustments: clone(checkpoint.adjustments || []),
      trace: clone(checkpoint.trace || []),
    },
  };
}

function sameMembers(left, right) {
  return JSON.stringify(unique(left).sort()) === JSON.stringify(unique(right).sort());
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
    authorityReason: "ordered_resolution_checkpoint_unverified",
    authorityReasons: [reason],
    shortAnswer: "顺序处理或效果处理后检查点所需的范式化状态不足，当前不能形成权威结论。",
    reasoning: ["缺失的卡片身份、区域、种族、处理顺序或选择分支不能用猜测补全。"],
    trace: [],
    evidenceIds: [],
    debug,
  };
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
