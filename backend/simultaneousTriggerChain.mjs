import { normalizeCardText, findNormalizedSemantics } from "./cardTextNormalizer.mjs";
import { splitEffectTextBlocks } from "./cardEffectBlocks.mjs";
import { classifyTriggerWording } from "./triggerTimingRules.mjs";

export const TRIGGER_PRIORITY_TIERS = Object.freeze({
  TURN_PLAYER_MANDATORY_PUBLIC: 1,
  NON_TURN_PLAYER_MANDATORY_PUBLIC: 2,
  TURN_PLAYER_OPTIONAL_PUBLIC: 3,
  NON_TURN_PLAYER_OPTIONAL_PUBLIC: 4,
  TURN_PLAYER_MANDATORY_QUICK: 5,
  NON_TURN_PLAYER_MANDATORY_QUICK: 6,
  PRIORITY_RESPONSE: 7,
});

const PUBLIC_ZONES = new Set([
  "monster_zone",
  "spell_trap_zone",
  "field_zone",
  "graveyard",
  "banished",
  "extra_deck_face_up",
]);

const SPECIAL_SUMMON_TRIGGER = /(?:此卡|这张卡|這張卡|このカード|this card).{0,30}(?:特殊召唤|特殊召喚|special summoned).{0,24}(?:场合|場合|情况(?:下)?|情形(?:下)?|if|when).{0,24}(?:可以发动|可发动|発動できる|can be activated)/iu;
const EFFECT_BANISH_TRIGGER = /(?=[^。；;\n]{0,200}(?:(?:卡片|卡|カード)(?:的|の)?(?:效果|効果)|card effect))(?=[^。；;\n]{0,200}(?:怪兽|怪獸|モンスター|monster))(?=[^。；;\n]{0,200}(?:除外|banish))[^。；;\n]{0,200}(?:场合|場合|情况(?:下)?|情形(?:下)?|if|when)[^。；;\n]{0,40}(?:可以发动|可发动|発動できる|can be activated)/iu;
const SELF_LEAVE_FIELD_BANISH = /(?:(?:表侧|表側|face-up).{0,20})?(?:此卡|这张卡|這張卡|このカード|this card).{0,32}(?:离开场上|離開場上|フィールドから離れ|leaves the field).{0,32}(?:除外|banish)/iu;
const SIMULTANEOUS_TRIGGER_ORDER_QUERY = /(?:另(?:开|起)(?:一组|一个|条)?连锁|新(?:的)?连锁|同一时点|同时诱发|同时发动|连锁处理完毕后|连锁处理后|(?:C|连锁)\s*1.{0,80}(?:C|连锁)\s*2)/iu;
const TRIGGER_ACTIVATION_WORDING = /(?:发动|發動|発動|activate)/iu;
const GENERIC_PUBLIC_TRIGGER_PATTERNS = Object.freeze([
  {
    eventType: "synchro_summoned",
    pattern: /(?:此卡|这张卡|這張卡|このカード|this card).{0,24}(?:同步召唤|同调召唤|同調召喚|S召唤|S召喚|synchro summon)(?:成功|した|ed)?[^。；;\n]{0,40}(?:时|時|场合|場合|if|when)/iu,
  },
  {
    eventType: "flipped_face_up",
    pattern: /(?:此卡|这张卡|這張卡|このカード|this card).{0,24}(?:反转|反轉|翻开|翻開|リバース|flipped? face-up)[^。；;\n]{0,40}(?:时|時|场合|場合|情况下|if|when)/iu,
  },
  {
    eventType: "special_summoned",
    pattern: /(?:此卡|这张卡|這張卡|このカード|this card).{0,24}(?:特殊召唤|特殊召喚|special summoned?)(?:成功|した|ed)?[^。；;\n]{0,40}(?:时|時|场合|場合|if|when)/iu,
  },
  {
    eventType: "normal_summoned",
    pattern: /(?:此卡|这张卡|這張卡|このカード|this card).{0,24}(?:召唤|召喚|normal summoned?)(?:成功|した|ed)?[^。；;\n]{0,40}(?:时|時|场合|場合|if|when)/iu,
  },
]);

export function normalizeTriggerCandidate(input = {}, index = 0, turnPlayer = "self") {
  const controller = normalizePlayer(input.controller || input.player || "self");
  const sourceZone = normalizeZone(input.sourceZone || input.activationZone || input.zone);
  const inferredPublicAtActivation = isPublicActivationLocation({
      sourceZone,
      faceUp: input.faceUp,
      explicitPublicTriggerQueue: input.explicitPublicTriggerQueue,
    });
  const publicAtActivation = sourceZone === "hand" && input.explicitPublicTriggerQueue !== true
    ? false
    : typeof input.publicAtActivation === "boolean"
      ? input.publicAtActivation
      : inferredPublicAtActivation;
  const mandatory = input.mandatory === true || input.optional === false;
  const effectClass = String(input.effectClass || input.triggerClass || "trigger").toLowerCase();
  const tier = triggerPriorityTier({
    controller,
    turnPlayer,
    publicAtActivation,
    mandatory,
    effectClass,
  });
  return {
    ...input,
    id: String(input.id || `trigger-${index + 1}`),
    name: String(input.name || input.cardName || input.id || `诱发效果${index + 1}`),
    controller,
    sourceZone,
    publicAtActivation,
    mandatory,
    optional: !mandatory,
    effectClass,
    tier,
    eligible: input.eligible !== false,
    orderHint: finiteNumber(input.orderHint, index),
  };
}

export function isPublicActivationLocation({
  sourceZone,
  faceUp,
  explicitPublicTriggerQueue = false,
} = {}) {
  const zone = normalizeZone(sourceZone);
  // A revealed hand remains the hand as an activation location.  Do not move
  // its trigger into the public-zone ordering merely because its identity is
  // visible.  A caller may opt in only when direct ruling evidence explicitly
  // assigns that effect to the public trigger queue.
  if (zone === "hand") return explicitPublicTriggerQueue === true;
  if (zone === "deck" || zone === "extra_deck" || zone === "banished_face_down") return false;
  if (zone === "monster_zone" || zone === "spell_trap_zone" || zone === "field_zone") {
    return faceUp === true;
  }
  return PUBLIC_ZONES.has(zone);
}

export function triggerPriorityTier({
  controller = "self",
  turnPlayer = "self",
  publicAtActivation = false,
  mandatory = false,
  effectClass = "trigger",
} = {}) {
  const player = normalizePlayer(controller);
  const currentTurnPlayer = normalizePlayer(turnPlayer);
  const isTurnPlayer = player === currentTurnPlayer;
  if (/mandatory[_ -]?quick/u.test(String(effectClass))) {
    return isTurnPlayer
      ? TRIGGER_PRIORITY_TIERS.TURN_PLAYER_MANDATORY_QUICK
      : TRIGGER_PRIORITY_TIERS.NON_TURN_PLAYER_MANDATORY_QUICK;
  }
  if (!publicAtActivation) return TRIGGER_PRIORITY_TIERS.PRIORITY_RESPONSE;
  if (mandatory) {
    return isTurnPlayer
      ? TRIGGER_PRIORITY_TIERS.TURN_PLAYER_MANDATORY_PUBLIC
      : TRIGGER_PRIORITY_TIERS.NON_TURN_PLAYER_MANDATORY_PUBLIC;
  }
  return isTurnPlayer
    ? TRIGGER_PRIORITY_TIERS.TURN_PLAYER_OPTIONAL_PUBLIC
    : TRIGGER_PRIORITY_TIERS.NON_TURN_PLAYER_OPTIONAL_PUBLIC;
}

export function movementEventIsFaceUpBanishByCardEffect(event = {}) {
  const actualToZone = normalizeZone(
    event.actualToZone
      || event.toZone
      || event.destination
      || event.move?.actualToZone,
  );
  if (actualToZone !== "banished") return false;
  const faceUp = event.faceUpAfter
    ?? event.banishedFaceUp
    ?? event.faceUp
    ?? event.move?.banishedFaceUp;
  if (faceUp !== true) return false;
  const provenance = [
    event.effectiveCause,
    event.causeKind,
    event.sourceKind,
    event.eventSource,
    event.move?.effectiveCause,
    event.move?.causeKind,
    event.move?.eventSource,
    event.replacementCauseKind,
    event.replacementSourceKind,
    event.replacementAttribution?.causeKind,
    event.replacementAttribution?.sourceKind,
    event.replacement?.causeKind,
    event.replacement?.sourceKind,
    event.move?.replacementCauseKind,
    event.move?.replacementSourceKind,
    event.move?.replacementAttribution?.causeKind,
    event.move?.replacementAttribution?.sourceKind,
    ...(Array.isArray(event.provenance) ? event.provenance : []),
    ...(Array.isArray(event.move?.provenance) ? event.move.provenance : []),
  ].map(normalizeToken);
  return provenance.some((value) => [
    "card_effect",
    "effect",
    "applied_card_effect",
    "destination_replacement_card_effect",
  ].includes(value));
}

export function collectEligibleTriggerCandidates({
  events = [],
  candidates = [],
  triggerWindowId = "",
  turnPlayer = "self",
} = {}) {
  const windowEvents = (events || []).filter((event) => (
    !triggerWindowId
    || String(event?.triggerWindowId || "") === String(triggerWindowId)
  ));
  return (candidates || [])
    .map((candidate, index) => normalizeTriggerCandidate(candidate, index, turnPlayer))
    .map((candidate) => ({
      ...candidate,
      matchedEventIds: windowEvents
        .filter((event) => triggerCandidateMatchesEvent(candidate, event))
        .map((event) => String(event.id || event.eventId || event.type || "event")),
      matchedTriggerWindowIds: unique(windowEvents
        .filter((event) => triggerCandidateMatchesEvent(candidate, event))
        .map(eventTriggerWindowId)
        .filter(Boolean)),
    }))
    .filter((candidate) => (
      candidate.eligible
      && (
        !candidate.triggerEventTypes?.length
        || candidate.matchedEventIds.length > 0
      )
    ));
}

export function buildSimultaneousTriggerChain({
  candidates = [],
  events = [],
  triggerWindowId = "",
  turnPlayer = "self",
  publicTriggerSelections,
  publicTriggerOrder,
  responseActions = [],
} = {}) {
  const currentTurnPlayer = normalizePlayer(turnPlayer);
  const windowResolution = resolveTriggerWindow({
    candidates,
    events,
    requestedTriggerWindowId: triggerWindowId,
    turnPlayer: currentTurnPlayer,
  });
  if (!windowResolution.complete) {
    return incompleteTriggerWindowPlan({
      turnPlayer: currentTurnPlayer,
      windowResolution,
    });
  }
  const effectiveTriggerWindowId = windowResolution.triggerWindowId;
  const eligible = collectEligibleTriggerCandidates({
    events,
    candidates,
    triggerWindowId: effectiveTriggerWindowId,
    turnPlayer: currentTurnPlayer,
  });
  const publicCandidates = eligible
    .filter((candidate) => candidate.tier <= TRIGGER_PRIORITY_TIERS.NON_TURN_PLAYER_MANDATORY_QUICK);
  const mandatoryPublic = publicCandidates.filter((candidate) => candidate.mandatory);
  const optionalPublic = publicCandidates.filter((candidate) => !candidate.mandatory);
  const selection = normalizePublicTriggerSelection(publicTriggerSelections, optionalPublic);
  const selectedOptionalPublic = optionalPublic.filter((candidate) => (
    selection.selectedIds.has(candidate.id)
  ));
  const publicQueueCandidates = [...mandatoryPublic, ...selectedOptionalPublic];
  const publicOrder = normalizePublicTriggerOrder(
    publicTriggerOrder,
    publicQueueCandidates,
    selection.orderById,
  );
  const publicQueue = publicQueueCandidates.sort((left, right) => (
    compareTriggerCandidatesWithExplicitOrder(left, right, publicOrder.orderById)
  ));
  const priorityQueue = eligible
    .filter((candidate) => candidate.tier === TRIGGER_PRIORITY_TIERS.PRIORITY_RESPONSE)
    .sort(compareTriggerCandidates);
  const chainLinks = [];
  const transcript = [
    ...selection.invalid.map((item) => ({
      type: "invalid_public_trigger_selection",
      ...item,
    })),
    ...publicOrder.invalid.map((item) => ({
      type: "invalid_public_trigger_order",
      ...item,
    })),
  ];
  if (optionalPublic.length && !selection.provided) {
    transcript.push({
      type: "await_public_trigger_selection",
      candidateIds: optionalPublic.map((candidate) => candidate.id),
    });
  }
  if (selection.provided) {
    for (const candidate of optionalPublic) {
      if (!selection.selectedIds.has(candidate.id)) {
        transcript.push({
          type: "decline_optional_trigger",
          player: candidate.controller,
          candidateId: candidate.id,
        });
      }
    }
  }
  for (const candidate of publicQueue) {
    chainLinks.push(toChainLink(candidate, chainLinks.length + 1, "simultaneous_public_trigger"));
    transcript.push({
      type: "announce_trigger",
      player: candidate.controller,
      candidateId: candidate.id,
      chainLink: `C${chainLinks.length}`,
      tier: candidate.tier,
    });
  }

  const lastPublicController = chainLinks.at(-1)?.controller || "";
  let priorityPlayer = lastPublicController
    ? opponentOf(lastPublicController)
    : currentTurnPlayer;
  let consecutivePasses = 0;
  let closed = false;
  const pending = new Map(priorityQueue.map((candidate) => [candidate.id, candidate]));

  if (chainLinks.length || pending.size) {
    transcript.push({
      type: "offer_response",
      player: priorityPlayer,
      afterChainLink: chainLinks.at(-1)?.id || null,
    });
  }

  for (const rawAction of responseActions || []) {
    if (closed) break;
    const action = normalizeResponseAction(rawAction);
    if (action.player !== priorityPlayer) {
      transcript.push({
        type: "invalid_response",
        player: action.player,
        expectedPlayer: priorityPlayer,
        reason: "response_priority_belongs_to_other_player",
      });
      continue;
    }
    if (action.type === "pass") {
      transcript.push({ type: "pass", player: action.player });
      consecutivePasses += 1;
      priorityPlayer = opponentOf(priorityPlayer);
      if (consecutivePasses >= 2) {
        closed = true;
        transcript.push({ type: "close_chain", reason: "both_players_passed" });
      } else {
        transcript.push({
          type: "offer_response",
          player: priorityPlayer,
          afterChainLink: chainLinks.at(-1)?.id || null,
        });
      }
      continue;
    }

    const candidate = pending.get(action.candidateId);
    if (!candidate || candidate.controller !== action.player) {
      transcript.push({
        type: "invalid_response",
        player: action.player,
        candidateId: action.candidateId,
        reason: candidate ? "candidate_controller_mismatch" : "trigger_candidate_not_pending",
      });
      continue;
    }
    pending.delete(candidate.id);
    chainLinks.push(toChainLink(candidate, chainLinks.length + 1, "priority_response_trigger"));
    transcript.push({
      type: "activate_trigger",
      player: candidate.controller,
      candidateId: candidate.id,
      chainLink: `C${chainLinks.length}`,
      tier: candidate.tier,
    });
    consecutivePasses = 0;
    priorityPlayer = opponentOf(candidate.controller);
    transcript.push({
      type: "offer_response",
      player: priorityPlayer,
      afterChainLink: chainLinks.at(-1)?.id || null,
    });
  }

  const requiresPublicTriggerSelection = optionalPublic.length > 0 && !selection.provided;
  const requiresPublicTriggerOrder = publicOrder.ambiguousTierGroups.length > 0;
  const publicQueueComplete = !requiresPublicTriggerSelection
    && !requiresPublicTriggerOrder
    && selection.invalid.length === 0
    && publicOrder.invalid.length === 0;
  const complete = publicQueueComplete;

  return {
    status: complete ? "resolved" : "unknown",
    verdict: complete ? "ORDERED" : "UNKNOWN",
    complete,
    reason: complete
      ? "simultaneous_trigger_queue_ordered"
      : requiresPublicTriggerSelection
        ? "optional_public_trigger_selection_witness_required"
        : requiresPublicTriggerOrder
          ? "same_tier_public_trigger_order_witness_required"
          : "public_trigger_queue_witness_invalid",
    triggerWindowId: String(effectiveTriggerWindowId || ""),
    triggerWindowResolution: windowResolution,
    turnPlayer: currentTurnPlayer,
    chainLinks,
    pendingPriorityTriggers: [...pending.values()],
    publicTriggerCount: publicQueue.length,
    mandatoryPublicTriggerCount: mandatoryPublic.length,
    optionalPublicTriggerCandidates: optionalPublic,
    selectedOptionalPublicTriggers: selectedOptionalPublic,
    requiresPublicTriggerSelection,
    requiresPublicTriggerOrder,
    ambiguousPublicOrderTierGroups: publicOrder.ambiguousTierGroups,
    publicQueueComplete,
    publicSelectionWitness: selection.provided
      ? {
        kind: "explicit_player_choice",
        selectedCandidateIds: [...selection.selectedIds],
        declinedCandidateIds: optionalPublic
          .filter((candidate) => !selection.selectedIds.has(candidate.id))
          .map((candidate) => candidate.id),
      }
      : null,
    privateTriggerCount: priorityQueue.length,
    priorityPlayer,
    requiresResponseConfirmation: Boolean(chainLinks.length && pending.size),
    closed,
    transcript,
  };
}

export function analyzeSimultaneousTriggerScenario({
  userQuery = "",
  cardTexts = [],
  movementEvents = [],
  turnPlayer = "self",
  allowSyntheticEvents = false,
  branchWitness = null,
} = {}) {
  const query = String(userQuery || "");
  const cards = normalizeScenarioCards(cardTexts);
  const specialSummonTriggerCards = cards.filter((card) => (
    SPECIAL_SUMMON_TRIGGER.test(card.text)
    && cardMentionedInSpecialSummonClause(query, card.names)
  ));
  const privateBanishTriggerCards = cards.filter((card) => (
    EFFECT_BANISH_TRIGGER.test(card.text)
    && cardMentionedInHandClause(query, card.names)
  ));
  if (!specialSummonTriggerCards.length || !privateBanishTriggerCards.length) {
    const genericPublicScenario = analyzeGenericPublicTriggerScenario({
      query,
      cards,
      events: Array.isArray(movementEvents) ? movementEvents : [],
      turnPlayer,
      branchWitness,
    });
    if (genericPublicScenario.recognized) return genericPublicScenario;
    return {
      recognized: false,
      complete: false,
      reason: "simultaneous_public_and_private_trigger_candidates_not_both_found",
      candidates: [],
      events: [],
    };
  }

  const sourceReplacementCards = cards.filter((card) => (
    cardMentionedInBanishClause(query, card.names)
    && (
      SELF_LEAVE_FIELD_BANISH.test(card.text)
      || findNormalizedSemantics(
        card.normalizedText,
        (semantic) => semantic.type === "destination_replacement"
          && semantic.affected === "source"
          && semantic.replacementZone === "banished",
      ).length > 0
    )
  ));
  const explicitEvents = Array.isArray(movementEvents) ? movementEvents : [];
  const syntheticEvents = allowSyntheticEvents
    ? [
      ...specialSummonTriggerCards
        .filter((card) => !explicitEvents.some((event) => eventMatchesSpecialSummonCard(event, card.id)))
        .map((card) => ({
      id: `special-summoned:${card.id}`,
      type: "special_summoned",
      subjectDefinitionId: card.id,
      faceUpAfter: true,
      triggerWindowId: "post_special_summon",
      synthetic: true,
      inferenceMode: "heuristic",
    })),
      ...(sourceReplacementCards.length && !explicitEvents.some(movementEventIsFaceUpBanishByCardEffect)
      ? sourceReplacementCards.map((card) => ({
        id: `face-up-effect-banish:${card.id}`,
        type: "card_banished",
        subjectDefinitionId: card.id,
        actualToZone: "banished",
        faceUpAfter: true,
        effectiveCause: "card_effect",
        provenance: ["summon_procedure", "destination_replacement_card_effect"],
        triggerWindowId: "post_special_summon",
        synthetic: true,
        inferenceMode: "heuristic",
      }))
      : []),
    ]
    : [];
  const scenarioEvents = [...explicitEvents, ...syntheticEvents];
  const candidates = [
    ...specialSummonTriggerCards.map((card) => ({
      id: `public-special-summon-trigger:${card.id}`,
      name: card.title,
      controller: "self",
      sourceZone: "monster_zone",
      faceUp: scenarioEvents.some((event) => (
        eventMatchesSpecialSummonCard(event, card.id)
        && readExplicitFaceUp(event) === true
      )),
      optional: true,
      triggerEventTypes: ["special_summoned"],
      subjectDefinitionId: card.id,
    })),
    ...privateBanishTriggerCards.map((card) => ({
      id: `private-effect-banish-trigger:${card.id}`,
      name: card.title,
      controller: "self",
      sourceZone: "hand",
      handPublic: false,
      optional: true,
      triggerEventTypes: ["face_up_banished_by_card_effect"],
    })),
  ];
  const witnessProvided = Boolean(branchWitness && typeof branchWitness === "object");
  const plan = buildSimultaneousTriggerChain({
    candidates,
    events: scenarioEvents,
    triggerWindowId: "post_special_summon",
    turnPlayer,
    publicTriggerSelections: witnessProvided
      ? branchWitness.publicTriggerSelections
      : undefined,
    publicTriggerOrder: witnessProvided
      ? branchWitness.publicTriggerOrder
      : undefined,
    responseActions: witnessProvided
      ? branchWitness.responseActions
      : [],
  });
  const effectBanishConfirmed = explicitEvents.some(movementEventIsFaceUpBanishByCardEffect);
  const hasExplicitSpecialSummon = specialSummonTriggerCards.some((card) => (
    explicitEvents.some((event) => (
      eventMatchesSpecialSummonCard(event, card.id)
      && readExplicitFaceUp(event) === true
    ))
  ));
  const publicLink = plan.chainLinks.find((link) => (
    link.source === "simultaneous_public_trigger"
  ));
  const privateLink = plan.chainLinks.find((link) => (
    link.source === "priority_response_trigger"
  ));
  const opponentPassRecorded = plan.transcript.some((entry) => (
    entry.type === "pass"
    && entry.player === opponentOf(publicLink?.controller || "self")
  ));
  const invalidWitnessAction = plan.transcript.some((entry) => (
    entry.type === "invalid_response"
    || entry.type === "invalid_public_trigger_selection"
    || entry.type === "invalid_public_trigger_order"
  ));
  const witnessValidated = Boolean(
    witnessProvided
    && publicLink
    && privateLink
    && opponentPassRecorded
    && !invalidWitnessAction
    && plan.publicQueueComplete
  );
  const trustedEventsComplete = syntheticEvents.length === 0
    && explicitEvents.length > 0
    && hasExplicitSpecialSummon
    && effectBanishConfirmed;
  const complete = trustedEventsComplete && witnessValidated;
  const eventMode = syntheticEvents.length
    ? "heuristic_synthetic"
    : explicitEvents.length
      ? "explicit"
      : "missing";
  return {
    recognized: true,
    mode: "public_private",
    status: complete ? "resolved" : "unknown",
    complete,
    reason: complete
      ? "explicit_events_and_existential_branch_witness_verified"
      : eventMode === "missing"
        ? "movement_events_required_for_trusted_trigger_analysis"
        : eventMode === "heuristic_synthetic"
          ? "synthetic_events_are_heuristic_and_cannot_complete_proof"
          : !witnessProvided
            ? "explicit_branch_witness_required"
            : "branch_witness_not_verified",
    eventMode,
    inference: syntheticEvents.length
      ? {
        kind: "heuristic",
        complete: false,
        warning: "synthetic events are candidates only and cannot prove the ruling",
      }
      : null,
    effectBanishConfirmed,
    syntheticEffectBanishCandidate: syntheticEvents.some(movementEventIsFaceUpBanishByCardEffect),
    sourceReplacementCards,
    specialSummonTriggerCards,
    privateBanishTriggerCards,
    candidates,
    events: scenarioEvents,
    explicitEvents,
    syntheticEvents,
    plan,
    witness: witnessProvided
      ? {
        kind: "existential_witness",
        supplied: true,
        validated: witnessValidated,
        publicTriggerSelections: branchWitness.publicTriggerSelections ?? null,
        publicTriggerOrder: branchWitness.publicTriggerOrder ?? null,
        responseActions: branchWitness.responseActions ?? [],
      }
      : null,
    exampleAfterOpponentPass: witnessProvided ? plan : null,
    conclusion: witnessValidated
      ? `存在以下已验证选择分支：自己选择发动公开区域的「${publicLink.name}」诱发效果；把连锁响应机会交给对方。对方不发动效果、响应机会回到自己后，可以从手牌连锁发动「${privateLink.name}」的诱发效果。`
      : "",
  };
}

function analyzeGenericPublicTriggerScenario({
  query,
  cards,
  events,
  turnPlayer,
  branchWitness,
} = {}) {
  if (!SIMULTANEOUS_TRIGGER_ORDER_QUERY.test(String(query || ""))) {
    return { recognized: false, complete: false };
  }
  const discovery = discoverGenericPublicTriggerCandidates({ query, cards, events });
  if (discovery.candidates.length < 2) {
    return {
      recognized: discovery.candidates.length > 0,
      mode: "generic_public_triggers",
      status: "unknown",
      complete: false,
      reason: "at_least_two_public_trigger_candidates_required",
      candidates: discovery.candidates,
      events,
      unresolved: [
        ...discovery.unresolved,
        {
          code: "PUBLIC_TRIGGER_CANDIDATES_INCOMPLETE",
          detail: "需要确认同一诱发时点中至少两个公开区域诱发效果及各自效果文本。",
        },
      ],
    };
  }

  const witnessProvided = Boolean(branchWitness && typeof branchWitness === "object");
  const plan = buildSimultaneousTriggerChain({
    candidates: discovery.candidates,
    events,
    triggerWindowId: witnessProvided
      ? String(branchWitness.triggerWindowId || "")
      : "",
    turnPlayer,
    publicTriggerSelections: witnessProvided
      ? branchWitness.publicTriggerSelections
      : undefined,
    publicTriggerOrder: witnessProvided
      ? branchWitness.publicTriggerOrder
      : undefined,
    responseActions: witnessProvided
      ? branchWitness.responseActions || []
      : [],
  });
  const complete = discovery.unresolved.length === 0
    && events.length > 0
    && plan.complete === true;
  const reason = complete
    ? "generic_public_trigger_queue_verified"
    : discovery.unresolved.length
      ? "public_trigger_candidate_facts_incomplete"
      : !events.length
        ? "explicit_trigger_events_required"
        : plan.reason;

  return {
    recognized: true,
    mode: "generic_public_triggers",
    status: complete ? "resolved" : "unknown",
    complete,
    reason,
    eventMode: events.length ? "explicit" : "missing",
    candidates: discovery.candidates,
    events,
    plan,
    unresolved: [
      ...discovery.unresolved,
      ...(plan.complete ? [] : [{
        code: plan.reason || "PUBLIC_TRIGGER_QUEUE_UNKNOWN",
        detail: describePlanUnknown(plan),
      }]),
    ],
    witness: witnessProvided
      ? {
        kind: "player_choice_witness",
        supplied: true,
        validated: complete,
        triggerWindowId: branchWitness.triggerWindowId || null,
        publicTriggerSelections: branchWitness.publicTriggerSelections ?? null,
        publicTriggerOrder: branchWitness.publicTriggerOrder ?? null,
      }
      : null,
    conclusion: complete
      ? plan.chainLinks.map((link) => `${link.id}「${link.name}」`).join("，")
      : "",
  };
}

function discoverGenericPublicTriggerCandidates({ query, cards, events } = {}) {
  const candidates = [];
  const unresolved = [];
  for (const card of cards || []) {
    if (!card.names.some((name) => normalizedIncludes(query, name))) continue;
    for (const block of splitEffectTextBlocks(card.text)) {
      if (!TRIGGER_ACTIVATION_WORDING.test(block.text)) continue;
      const eventType = inferGenericPublicTriggerEventType(block.text);
      const triggerWording = classifyTriggerWording(block.text);
      if (!eventType || triggerWording === "unknown") continue;

      const matchingEvents = (events || []).filter((event) => (
        eventTypeMatches(event, eventType)
        && eventSubjectMatchesCard(event, card.id)
      ));
      const controller = readExplicitController(card, matchingEvents, query);
      const sourceZone = readPublicSourceZone(card, matchingEvents, eventType);
      const faceUp = readPublicFaceUp(card, matchingEvents, query);
      const id = `public-trigger:${card.id}:${block.id}`;
      const missing = [];
      if (!controller) missing.push("controller");
      if (!sourceZone) missing.push("source_zone");
      if (sourceZone && !isPublicActivationLocation({ sourceZone, faceUp })) {
        missing.push("public_activation_location");
      }
      if (!matchingEvents.length) missing.push("matching_trigger_event");
      if (missing.length) {
        unresolved.push({
          code: "PUBLIC_TRIGGER_CANDIDATE_FACTS_MISSING",
          candidateId: id,
          cardId: card.id,
          missing,
          detail: `「${card.title}」缺少：${missing.join(", ")}。`,
        });
      }
      candidates.push({
        id,
        name: card.title,
        controller: controller || "self",
        sourceZone: sourceZone || "unknown",
        faceUp,
        mandatory: triggerWording.startsWith("mandatory_"),
        optional: triggerWording.startsWith("optional_"),
        triggerWording,
        triggerEventTypes: [eventType],
        subjectDefinitionId: card.id,
        subjectBound: true,
        effectText: block.text,
        effectBlockId: block.id,
        discoveryComplete: missing.length === 0,
      });
    }
  }
  return { candidates, unresolved };
}

function inferGenericPublicTriggerEventType(value) {
  const text = String(value || "");
  for (const item of GENERIC_PUBLIC_TRIGGER_PATTERNS) {
    if (item.pattern.test(text)) return item.eventType;
  }
  const patterns = [
    ["destroyed", /(?:此卡|这张卡|這張卡|このカード|this card).{0,30}(?:被)?(?:战斗|戰鬥|戦闘|效果|効果|effect)?[・·]?(?:破坏|破壊|destroyed)[^。；;\n]{0,40}(?:时|時|场合|場合|if|when)/iu],
    ["sent_to_graveyard", /(?:此卡|这张卡|這張卡|このカード|this card).{0,30}(?:送去墓地|墓地へ送|sent to the graveyard)[^。；;\n]{0,40}(?:时|時|场合|場合|if|when)/iu],
    ["banished", /(?:此卡|这张卡|這張卡|このカード|this card).{0,30}(?:除外|banished)[^。；;\n]{0,40}(?:时|時|场合|場合|if|when)/iu],
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function readExplicitController(card, matchingEvents, query) {
  const direct = normalizeExplicitPlayer(card.controller || card.player);
  if (direct) return direct;
  for (const event of matchingEvents || []) {
    const fromEvent = normalizeExplicitPlayer(event.controller || event.player || event.subject?.controller);
    if (fromEvent) return fromEvent;
  }
  const clauses = String(query || "").split(/[，,。；;！？?\n]+/u);
  for (const clause of clauses) {
    if (!card.names.some((name) => normalizedIncludes(clause, name))) continue;
    if (/(?:对方|對方|对手|相手|opponent)/iu.test(clause)) return "opponent";
    if (/(?:我方|自己|本方|自分|my|I )/iu.test(clause)) return "self";
  }
  return "";
}

function readPublicSourceZone(card, matchingEvents, eventType) {
  const direct = normalizeZone(card.sourceZone || card.activationZone || card.zone);
  if (direct !== "unknown") return direct;
  for (const event of matchingEvents || []) {
    const destination = normalizeZone(
      event.actualToZone
        || event.toZone
        || event.destination
        || event.move?.actualToZone,
    );
    if (destination !== "unknown") return destination;
  }
  if (["synchro_summoned", "special_summoned", "normal_summoned"].includes(eventType)) {
    return "monster_zone";
  }
  if (/(?:spell|trap|魔法|陷阱|罠)/iu.test(card.cardType || card.type || "")) {
    return "spell_trap_zone";
  }
  return "";
}

function readPublicFaceUp(card, matchingEvents, query) {
  if (typeof card.faceUp === "boolean") return card.faceUp;
  for (const event of matchingEvents || []) {
    const faceUp = readExplicitFaceUp(event);
    if (typeof faceUp === "boolean") return faceUp;
  }
  const clauses = String(query || "").split(/[，,。；;！？?\n]+/u);
  return clauses.some((clause) => (
    card.names.some((name) => normalizedIncludes(clause, name))
    && /(?:表侧|表側|face-up)/iu.test(clause)
  )) || undefined;
}

function eventTypeMatches(event, expectedType) {
  return String(event?.type || event?.eventType || "") === String(expectedType || "");
}

function eventSubjectMatchesCard(event, cardId) {
  const actual = String(
    event?.subjectDefinitionId
      || event?.definitionId
      || event?.subject?.definitionId
      || "",
  );
  return Boolean(actual) && actual === String(cardId || "");
}

function describePlanUnknown(plan = {}) {
  if (plan.reason === "different_trigger_windows_require_separate_chains") {
    return "检测到不同诱发时点，不能把这些效果合并到同一连锁。";
  }
  if (plan.requiresPublicTriggerSelection) return "需要玩家明确选择哪些公开区域选发诱发效果发动。";
  if (plan.requiresPublicTriggerOrder) return "同一优先层存在多个效果，需要该玩家提供发动顺序。";
  return "同时诱发连锁尚缺少可验证的玩家选择或事件窗口信息。";
}

export function isPublicThenPrivateTriggerRule(value) {
  const text = String(value || "");
  const hasPublicOrdering = /同一时点.{0,40}诱发.{0,80}公开情报.{0,40}选发/su.test(text)
    || /回合玩家的公开情报的选发的诱发类效果/su.test(text);
  const hasPrivateOrdering = /从手卡发动的诱发效果.{0,40}顺序是\s*7/su.test(text)
    || /手卡.{0,24}非公开.{0,60}诱发.{0,60}(?:顺序|优先权)/su.test(text);
  const hasResponseTransfer = /优先权发生转移.{0,100}把优先权转移给对方/su.test(text)
    || /发动时.{0,40}必须确认.{0,30}(?:对方|另一方).{0,20}(?:连锁|响应)/su.test(text);
  return hasPublicOrdering || hasPrivateOrdering || hasResponseTransfer;
}

export function selectPublicThenPrivateTriggerQuotes(items = []) {
  const result = [];
  for (const item of items || []) {
    const chunks = String(item?.text || "")
      .split(/\n+|(?<=[。！？.!?])\s*/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const publicOrder = chunks.find((value) => /回合玩家的公开情报的选发的诱发类效果/u.test(value));
    const privateOrder = chunks.find((value) => /从手卡发动的诱发效果.{0,40}顺序是\s*7/u.test(value));
    const responseTransfer = chunks.find((value) => /优先权发生转移.{0,100}把优先权转移给对方/u.test(value));
    for (const quote of [publicOrder, privateOrder, responseTransfer].filter(Boolean)) {
      if (result.some((entry) => entry.quote === quote)) continue;
      result.push({ item, quote });
    }
  }
  return result.slice(0, 3);
}

function triggerCandidateMatchesEvent(candidate, event = {}) {
  const types = candidate.triggerEventTypes || [];
  if (!types.length) return true;
  return types.some((type) => {
    if (type === "face_up_banished_by_card_effect") {
      return movementEventIsFaceUpBanishByCardEffect(event);
    }
    if (type === "special_summoned") {
      if (!/^(?:special_summoned|special_summon)$/u.test(String(event.type || event.eventType || ""))) return false;
      const expected = String(candidate.subjectInstanceId || candidate.subjectDefinitionId || "");
      if (!expected) return true;
      const actual = String(
        event.subjectInstanceId
          || event.subjectDefinitionId
          || event.instanceId
          || event.definitionId
          || "",
      );
      return actual === expected;
    }
    if (String(event.type || event.eventType || "") !== String(type)) return false;
    if (candidate.subjectBound !== true) return true;
    const expected = String(candidate.subjectInstanceId || candidate.subjectDefinitionId || "");
    if (!expected) return false;
    const actual = String(
      event.subjectInstanceId
        || event.subjectDefinitionId
        || event.instanceId
        || event.definitionId
        || event.subject?.instanceId
        || event.subject?.definitionId
        || "",
    );
    return Boolean(actual) && actual === expected;
  });
}

function resolveTriggerWindow({
  candidates = [],
  events = [],
  requestedTriggerWindowId = "",
  turnPlayer = "self",
} = {}) {
  const requested = String(requestedTriggerWindowId || "");
  const normalizedCandidates = (candidates || []).map((candidate, index) => (
    normalizeTriggerCandidate(candidate, index, turnPlayer)
  ));
  const matchedEvents = (events || []).filter((event) => (
    normalizedCandidates.some((candidate) => triggerCandidateMatchesEvent(candidate, event))
  ));
  const matchedWindowIds = unique(matchedEvents.map(eventTriggerWindowId).filter(Boolean));
  const unscopedMatchedEventIds = matchedEvents
    .filter((event) => !eventTriggerWindowId(event))
    .map((event) => String(event.id || event.eventId || event.type || "event"));

  if (requested) {
    const requestedExists = (events || []).some((event) => eventTriggerWindowId(event) === requested);
    if (events.length && !requestedExists) {
      return {
        complete: false,
        reason: "requested_trigger_window_not_found",
        triggerWindowId: requested,
        matchedTriggerWindowIds: matchedWindowIds,
        unscopedMatchedEventIds,
      };
    }
    return {
      complete: true,
      reason: "explicit_trigger_window_selected",
      triggerWindowId: requested,
      matchedTriggerWindowIds: matchedWindowIds,
      unscopedMatchedEventIds,
    };
  }

  if (matchedWindowIds.length > 1 || (matchedWindowIds.length && unscopedMatchedEventIds.length)) {
    return {
      complete: false,
      reason: "different_trigger_windows_require_separate_chains",
      triggerWindowId: "",
      matchedTriggerWindowIds: matchedWindowIds,
      unscopedMatchedEventIds,
    };
  }
  if (!matchedWindowIds.length && matchedEvents.length > 1) {
    return {
      complete: false,
      reason: "trigger_window_identity_missing",
      triggerWindowId: "",
      matchedTriggerWindowIds: [],
      unscopedMatchedEventIds,
    };
  }
  return {
    complete: true,
    reason: matchedWindowIds.length
      ? "single_trigger_window_inferred"
      : "no_window_conflict_detected",
    triggerWindowId: matchedWindowIds[0] || "",
    matchedTriggerWindowIds: matchedWindowIds,
    unscopedMatchedEventIds,
  };
}

function incompleteTriggerWindowPlan({ turnPlayer, windowResolution } = {}) {
  return {
    status: "unknown",
    verdict: "UNKNOWN",
    complete: false,
    reason: windowResolution.reason,
    triggerWindowId: String(windowResolution.triggerWindowId || ""),
    triggerWindowResolution: windowResolution,
    turnPlayer,
    chainLinks: [],
    pendingPriorityTriggers: [],
    publicTriggerCount: 0,
    mandatoryPublicTriggerCount: 0,
    optionalPublicTriggerCandidates: [],
    selectedOptionalPublicTriggers: [],
    requiresPublicTriggerSelection: false,
    requiresPublicTriggerOrder: false,
    ambiguousPublicOrderTierGroups: [],
    publicQueueComplete: false,
    publicSelectionWitness: null,
    privateTriggerCount: 0,
    priorityPlayer: turnPlayer,
    requiresResponseConfirmation: false,
    closed: false,
    transcript: [{
      type: "await_trigger_window_selection",
      reason: windowResolution.reason,
      candidateWindowIds: windowResolution.matchedTriggerWindowIds,
      unscopedMatchedEventIds: windowResolution.unscopedMatchedEventIds,
    }],
  };
}

function eventTriggerWindowId(event = {}) {
  return String(
    event.triggerWindowId
      || event.eventWindowId
      || event.timingWindowId
      || event.simultaneousGroupId
      || "",
  );
}

function compareTriggerCandidates(left, right) {
  return left.tier - right.tier
    || left.orderHint - right.orderHint
    || left.id.localeCompare(right.id);
}

function compareTriggerCandidatesWithExplicitOrder(left, right, explicitOrderById) {
  const tierDifference = left.tier - right.tier;
  if (tierDifference) return tierDifference;
  const leftOrder = explicitOrderById.get(left.id);
  const rightOrder = explicitOrderById.get(right.id);
  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return leftOrder - rightOrder;
  if (Number.isFinite(leftOrder)) return -1;
  if (Number.isFinite(rightOrder)) return 1;
  return compareTriggerCandidates(left, right);
}

function normalizePublicTriggerSelection(input, optionalCandidates) {
  const provided = Array.isArray(input)
    || Boolean(input && typeof input === "object");
  const candidateById = new Map(optionalCandidates.map((candidate) => [candidate.id, candidate]));
  const records = flattenPlayerCandidateInput(input);
  const selectedIds = new Set();
  const orderById = new Map();
  const invalid = [];
  for (const [index, record] of records.entries()) {
    const candidate = candidateById.get(record.candidateId);
    if (!candidate) {
      invalid.push({
        candidateId: record.candidateId,
        reason: "candidate_is_not_an_eligible_optional_public_trigger",
      });
      continue;
    }
    if (record.player && normalizePlayer(record.player) !== candidate.controller) {
      invalid.push({
        candidateId: record.candidateId,
        player: normalizePlayer(record.player),
        expectedPlayer: candidate.controller,
        reason: "candidate_controller_mismatch",
      });
      continue;
    }
    if (!selectedIds.has(candidate.id)) {
      selectedIds.add(candidate.id);
      orderById.set(candidate.id, index);
    }
  }
  return { provided, selectedIds, orderById, invalid };
}

function normalizePublicTriggerOrder(input, candidates, fallbackOrderById) {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const records = flattenPlayerCandidateInput(input);
  const orderById = new Map(fallbackOrderById);
  const invalid = [];
  for (const [index, record] of records.entries()) {
    const candidate = candidateById.get(record.candidateId);
    if (!candidate) {
      invalid.push({
        candidateId: record.candidateId,
        reason: "ordered_candidate_is_not_in_public_trigger_queue",
      });
      continue;
    }
    if (record.player && normalizePlayer(record.player) !== candidate.controller) {
      invalid.push({
        candidateId: record.candidateId,
        player: normalizePlayer(record.player),
        expectedPlayer: candidate.controller,
        reason: "ordered_candidate_controller_mismatch",
      });
      continue;
    }
    orderById.set(candidate.id, index);
  }
  const tierGroups = new Map();
  for (const candidate of candidates) {
    const group = tierGroups.get(candidate.tier) || [];
    group.push(candidate);
    tierGroups.set(candidate.tier, group);
  }
  const ambiguousTierGroups = [...tierGroups.entries()]
    .filter(([, group]) => (
      group.length > 1
      && !group.every((candidate) => orderById.has(candidate.id))
    ))
    .map(([tier, group]) => ({
      tier,
      controller: group[0]?.controller || "",
      candidateIds: group.map((candidate) => candidate.id),
    }));
  return { orderById, invalid, ambiguousTierGroups };
}

function flattenPlayerCandidateInput(input) {
  if (Array.isArray(input)) {
    return input.flatMap((item) => normalizePlayerCandidateRecord(item));
  }
  if (!input || typeof input !== "object") return [];
  if (
    Array.isArray(input.candidateIds)
    || Array.isArray(input.orderedCandidateIds)
    || input.candidateId
  ) {
    return normalizePlayerCandidateRecord(input);
  }
  return Object.entries(input).flatMap(([player, candidateIds]) => (
    (Array.isArray(candidateIds) ? candidateIds : [])
      .map((candidateId) => ({ player, candidateId: String(candidateId || "") }))
  ));
}

function normalizePlayerCandidateRecord(input) {
  if (typeof input === "string" || typeof input === "number") {
    return [{ player: "", candidateId: String(input) }];
  }
  if (!input || typeof input !== "object") return [];
  const player = input.player || input.controller || "";
  const candidateIds = input.orderedCandidateIds
    || input.candidateIds
    || (input.candidateId || input.id ? [input.candidateId || input.id] : []);
  return (Array.isArray(candidateIds) ? candidateIds : [])
    .map((candidateId) => ({ player, candidateId: String(candidateId || "") }));
}

function toChainLink(candidate, order, source) {
  return {
    id: `C${order}`,
    order,
    candidateId: candidate.id,
    name: candidate.name,
    controller: candidate.controller,
    sourceZone: candidate.sourceZone,
    publicAtActivation: candidate.publicAtActivation,
    tier: candidate.tier,
    source,
  };
}

function normalizeResponseAction(input = {}) {
  return {
    type: String(input.type || input.action || "").toLowerCase() === "pass" ? "pass" : "activate",
    player: normalizePlayer(input.player || input.controller),
    candidateId: String(input.candidateId || input.effectId || input.id || ""),
  };
}

function eventMatchesSpecialSummonCard(event, definitionId) {
  if (!/^(?:special_summoned|special_summon)$/u.test(String(event?.type || event?.eventType || ""))) {
    return false;
  }
  return String(
    event?.subjectDefinitionId
      || event?.definitionId
      || event?.subject?.definitionId
      || "",
  ) === String(definitionId || "");
}

function readExplicitFaceUp(event = {}) {
  return event.faceUpAfter
    ?? event.faceUp
    ?? event.position?.faceUp
    ?? event.subject?.faceUp;
}

function normalizeScenarioCards(cardTexts) {
  return (cardTexts || []).filter((item) => item?.text).map((item, index) => {
    const id = String(item.cardId || item.cardIds?.[0] || item.id || `card-${index + 1}`);
    const names = unique([
      ...(item.cards || []),
      item.title,
      item.name,
      item.cnName,
      item.jaName,
      item.enName,
    ]);
    return {
      ...item,
      id,
      title: String(names[0] || id),
      names,
      text: String(item.text || ""),
      normalizedText: normalizeCardText({
        ...item,
        id,
        name: names[0] || id,
        aliases: names,
        effectText: item.text,
      }),
    };
  });
}

function cardMentionedInSpecialSummonClause(query, names) {
  return clauseMentionsCardAnd(query, names, /(?:特殊召唤|特殊召喚|special summon)/iu);
}

function cardMentionedInHandClause(query, names) {
  return clauseMentionsCardAnd(query, names, /(?:手牌|手卡|手札|hand)/iu);
}

function cardMentionedInBanishClause(query, names) {
  return clauseMentionsCardAnd(query, names, /(?:除外|banish)/iu);
}

function clauseMentionsCardAnd(query, names, predicate) {
  const clauses = String(query || "").split(/[，,。；;！？?\n]+/u);
  return clauses.some((clause) => (
    predicate.test(clause)
    && (names || []).some((name) => normalizedIncludes(clause, name))
  ));
}

function normalizedIncludes(haystack, needle) {
  const left = normalizeIdentity(haystack);
  const right = normalizeIdentity(needle);
  return right.length >= 2 && left.includes(right);
}

function normalizeIdentity(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeZone(value) {
  const zone = String(value || "").trim().toLowerCase();
  const aliases = {
    field: "monster_zone",
    monster: "monster_zone",
    mz: "monster_zone",
    spell_trap: "spell_trap_zone",
    spelltrap: "spell_trap_zone",
    gy: "graveyard",
    grave: "graveyard",
    banish: "banished",
    removed: "banished",
    extra: "extra_deck",
  };
  return aliases[zone] || zone || "unknown";
}

function normalizePlayer(value) {
  const player = String(value || "").trim().toLowerCase();
  if (["opponent", "other", "non_turn_player", "对方", "对手"].includes(player)) return "opponent";
  return "self";
}

function normalizeExplicitPlayer(value) {
  const player = String(value || "").trim().toLowerCase();
  if (["self", "turn_player", "我方", "自己", "本方"].includes(player)) return "self";
  if (["opponent", "other", "non_turn_player", "对方", "对手"].includes(player)) return "opponent";
  return "";
}

function opponentOf(player) {
  return normalizePlayer(player) === "self" ? "opponent" : "self";
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}
