const QUESTION_MARKERS = /(?:是否|会不会|还会|能否|能用|可以|吗[？?]?|还是)/u;

export function buildEventTimelineFromFormalQuery(formalQuery, gameState = {}) {
  const query = formalQuery && typeof formalQuery === "object" ? formalQuery : {};
  const scenario = query.scenario || {};
  const segments = collectSegments(query);
  const entities = collectEntities(query, gameState, segments);
  const events = [];
  const pendingTransitions = [];
  const warnings = [];
  let sequence = 0;
  const addEvent = (event) => {
    const value = { id: `event_${++sequence}`, dependsOn: [], ...event };
    events.push(value);
    return value;
  };

  const damageStepEnd = segments.some(({ text }) => /(伤判结束阶段|伤害步骤结束阶段|伤害步骤结束时|ダメージステップ終了時|end of the Damage Step)/iu.test(text));
  const duringResolution = scenario.chainState === "during_resolution"
    || segments.some(({ text }) => /(效果处理时|效果处理过程中|处理时|during (?:effect )?resolution)/iu.test(text));
  const afterResolution = segments.some(({ text }) => /(效果处理后|效果处理完毕后|结算后|after (?:the )?(?:effect )?resolves)/iu.test(text));

  if (damageStepEnd) {
    const source = segments.find(({ text }) => /(伤判结束阶段|伤害步骤结束阶段|伤害步骤结束时)/u.test(text));
    addEvent({
      type: "damage_step_end",
      card: "unknown",
      cardId: "unknown",
      actor: "unknown",
      fromZone: "unknown",
      toZone: "unknown",
      timing: "damage_step_end",
      status: "completed",
      sourceText: source?.text || "unknown",
    });
  }

  for (const segment of segments) {
    if (/(发动.{0,24}效果的时候|发动.{0,24}效果时|效果.{0,12}发动的时候|activate.{0,20}effect)/iu.test(segment.text)) {
      const sourceEntity = findMentionedEntity(segment.text, entities);
      addEvent(baseEvent("effect_activation", sourceEntity, segment.text, damageStepEnd ? "damage_step_end" : "unknown", questionStatus(segment.text)));
    }
    if (/(效果处理时|效果处理过程中|处理时|during (?:effect )?resolution)/iu.test(segment.text)) {
      const sourceEntity = findMentionedEntity(segment.text, entities);
      addEvent(baseEvent("effect_resolution", sourceEntity, segment.text, "effect_resolution", questionStatus(segment.text)));
    }
  }

  for (const entity of entities) {
    const relevant = segments.filter(({ text }) => mentionsEntity(text, entity));
    const positiveDestroyed = relevant.filter(({ text }) => hasPositiveBattleDestruction(text, entity));
    const negativeDestroyed = relevant.filter(({ text }) => hasNegativeBattleDestruction(text, entity));
    const explicitSent = relevant.filter(({ text }) => hasCompletedSendToGraveyard(text, entity));
    const explicitBanished = relevant.filter(({ text }) => hasCompletedBanish(text, entity));
    const questionedBanish = relevant.filter(({ text }) => hasQuestionedBanish(text, entity));
    const explicitOnField = relevant.filter(({ text }) => hasExplicitOnField(text, entity));

    for (const segment of positiveDestroyed) {
      addEvent({
        ...baseEvent("battle_destroyed", entity, segment.text, inferTiming(segment.text, damageStepEnd), "completed"),
        actor: inferBattleActor(segment.text, entity, entities),
        fromZone: "monster_zone",
        toZone: "unknown",
      });
    }

    for (const segment of explicitSent) {
      const sourceEvent = addEvent({
        ...baseEvent("sent_to_graveyard", entity, segment.text, inferTiming(segment.text, damageStepEnd), "completed"),
        fromZone: "monster_zone",
        toZone: "graveyard",
      });
      pendingTransitions.push({
        card: entity.name,
        cardId: entity.cardId,
        fromZone: "monster_zone",
        toZone: "graveyard",
        reason: "battle_destruction_send_to_graveyard",
        status: "completed",
        sourceEventId: sourceEvent.id,
      });
    }

    for (const segment of explicitBanished) {
      const sourceEvent = addEvent({
        ...baseEvent("temporarily_banished", entity, segment.text, inferTiming(segment.text, damageStepEnd), "completed"),
        fromZone: "monster_zone",
        toZone: "banished",
      });
      pendingTransitions.push({
        card: entity.name,
        cardId: entity.cardId,
        fromZone: "monster_zone",
        toZone: "banished",
        reason: "explicit_banish",
        status: "completed",
        sourceEventId: sourceEvent.id,
      });
    }

    for (const segment of questionedBanish) {
      addEvent({
        ...baseEvent("temporarily_banished", entity, segment.text, inferTiming(segment.text, damageStepEnd), "questioned"),
        fromZone: "monster_zone",
        toZone: "banished",
      });
    }

    const hasCompletedDestination = explicitSent.length > 0 || explicitBanished.length > 0 || explicitOnField.length > 0;
    if (positiveDestroyed.length && !hasCompletedDestination) {
      const sourceText = positiveDestroyed[0].text;
      const pendingEvent = addEvent({
        ...baseEvent("pending_send_to_graveyard", entity, sourceText, inferTiming(sourceText, damageStepEnd), "pending"),
        fromZone: "monster_zone",
        toZone: "graveyard",
      });
      pendingTransitions.push({
        card: entity.name,
        cardId: entity.cardId,
        fromZone: "monster_zone",
        toZone: "graveyard",
        reason: "battle_destroyed_destination_not_confirmed",
        status: "pending",
        sourceEventId: pendingEvent.id,
      });
    }

    if (negativeDestroyed.length && explicitOnField.length === 0) {
      warnings.push(`${entity.name}:not_destroyed_without_explicit_zone`);
    }
  }

  for (const segment of segments) {
    if (!/(直到.{0,18}效果处理后除外|除外.{0,18}效果处理后.{0,8}(?:返回|回到)|效果处理后返回|until.{0,20}(?:resolves|resolution).{0,20}(?:return|banish))/iu.test(segment.text)) continue;
    const target = inferBanishTarget(segment.text, entities);
    const banishEvent = [...events].reverse().find((event) => event.type === "temporarily_banished" && sameCard(event.card, target?.name));
    const returnEvent = addEvent({
      ...baseEvent("returned_to_previous_zone", target, segment.text, "after_effect_resolution", "pending"),
      fromZone: "banished",
      toZone: "previous_zone",
      dependsOn: banishEvent ? [banishEvent.id] : [],
    });
    pendingTransitions.push({
      card: target?.name || "unknown",
      cardId: target?.cardId || "unknown",
      fromZone: "banished",
      toZone: "previous_zone",
      reason: "temporary_banish_return_after_resolution",
      status: "pending",
      sourceEventId: returnEvent.id,
    });
  }

  return {
    events: dedupeEvents(events),
    pendingTransitions: dedupeTransitions(pendingTransitions),
    timing: {
      currentWindow: damageStepEnd ? "damage_step_end" : duringResolution ? "effect_resolution" : afterResolution ? "after_effect_resolution" : "unknown",
      isDamageStepEnd: damageStepEnd,
      isDuringEffectResolution: duringResolution,
      isAfterEffectResolution: afterResolution,
      unknowns: damageStepEnd || duringResolution || afterResolution ? [] : ["currentWindow"],
    },
    warnings: [...new Set(warnings)],
  };
}

export function deriveStateAtTiming(gameState = {}, eventTimeline = {}, timingQuery = {}) {
  const request = typeof timingQuery === "string" ? { card: timingQuery } : timingQuery || {};
  const card = String(request.card || "unknown");
  const entity = findEntity(card, gameState.entities || []);
  const events = (eventTimeline.events || []).filter((event) => matchesCard(event.card, card, entity?.name));
  const transitions = (eventTimeline.pendingTransitions || []).filter((item) => matchesCard(item.card, card, entity?.name));
  const completedBanish = events.find((event) => event.type === "temporarily_banished" && event.status === "completed");
  const completedSend = events.find((event) => event.type === "sent_to_graveyard" && event.status === "completed");
  const pendingSend = events.find((event) => event.type === "pending_send_to_graveyard" && event.status === "pending")
    || transitions.find((item) => item.toZone === "graveyard" && item.status === "pending");
  const battleDestroyed = entity?.wasDestroyedByBattle === false
    ? false
    : events.some((event) => event.type === "battle_destroyed" && event.status === "completed")
      ? true
      : entity?.wasDestroyedByBattle ?? null;

  let zoneStatus = "unknown";
  let transitionStatus = "unknown";
  let reason = "zone_state_not_confirmed";
  const unknowns = [];

  if (completedBanish) {
    zoneStatus = "banished";
    transitionStatus = "completed";
    reason = "completed_banish_event";
  } else if (completedSend) {
    zoneStatus = "in_graveyard";
    transitionStatus = "completed";
    reason = "completed_send_to_graveyard_event";
  } else if (entity?.remainsOnField === true || entity?.currentZone === "monster_zone" || entity?.currentZone === "field") {
    zoneStatus = "on_field";
    transitionStatus = "completed";
    reason = "explicitly_remains_on_field";
  } else if (pendingSend) {
    zoneStatus = "pending_send_to_graveyard";
    transitionStatus = "pending";
    reason = "battle_destroyed_send_to_graveyard_pending";
    unknowns.push("send_to_graveyard_completion", "banished_before_send", "remains_on_field");
  } else if (entity?.wasBanished === true || entity?.currentZone === "banished") {
    zoneStatus = "banished";
    transitionStatus = "completed";
    reason = "game_state_banished";
  } else if (entity?.wasSentToGraveyard === true || entity?.currentZone === "graveyard") {
    zoneStatus = "in_graveyard";
    transitionStatus = "completed";
    reason = "game_state_sent_to_graveyard";
  } else {
    unknowns.push("current_zone");
  }

  return {
    card: entity?.name || card,
    zoneStatus,
    battleDestroyedStatus: battleDestroyed === true ? "destroyed" : battleDestroyed === false ? "not_destroyed" : "unknown",
    transitionStatus,
    reason,
    unknowns: [...new Set(unknowns)],
  };
}

function collectSegments(query) {
  const scenario = query.scenario || {};
  return [
    { text: String(scenario.rawContext || ""), source: "scenario" },
    ...(query.subQuestions || []).map((item) => ({ text: String(item.sourceText || ""), source: item.id || "subQuestion" })),
    ...(scenario.events || []).map((item, index) => ({
      text: [item.card, item.action, item.fromZone, item.toZone].filter(Boolean).join(" "),
      source: `scenario_event_${index + 1}`,
    })),
  ].filter((item) => item.text.trim());
}

function collectEntities(query, gameState, segments) {
  const values = [...(gameState.entities || [])];
  for (const card of [...(query.cards || []), ...(query.resolvedCards || [])]) {
    if (!card?.name || card.name === "unknown") continue;
    if (!values.some((item) => sameCard(item.name, card.name))) {
      values.push({ name: card.name, cardId: String(card.cardId || card.liveId || card.id || "unknown") });
    }
  }
  if (segments.some(({ text }) => /(?:该)?卡通怪兽/u.test(text)) && !values.some((item) => item.name === "referenced_toon_monster")) {
    values.push({ name: "referenced_toon_monster", cardId: "unknown", aliases: ["卡通怪兽", "该卡通怪兽"] });
  }
  return values;
}

function baseEvent(type, entity, sourceText, timing, status) {
  return {
    type,
    card: entity?.name || "unknown",
    cardId: entity?.cardId || "unknown",
    actor: "unknown",
    fromZone: "unknown",
    toZone: "unknown",
    timing,
    status,
    sourceText,
  };
}

function hasPositiveBattleDestruction(text, entity) {
  if (hasNegativeBattleDestruction(text, entity)) return false;
  const subject = entityPattern(entity);
  if (entity.name === "referenced_toon_monster") {
    return /(?:被[^，。；\n]{0,24}战破的(?:该)?卡通怪兽|(?:该)?卡通怪兽.{0,18}(?:被战破|被战斗破坏))/u.test(text);
  }
  return new RegExp(`${subject}.{0,30}(?:被战破|被战斗破坏|战斗中被破坏)`, "iu").test(text);
}

function hasNegativeBattleDestruction(text, entity) {
  const subject = entityPattern(entity);
  return new RegExp(`${subject}.{0,24}(?:没有|未)(?:被)?(?:战破|战斗破坏)|${subject}.{0,24}(?:不会|不能)被战斗破坏`, "iu").test(text);
}

function hasCompletedSendToGraveyard(text, entity) {
  if (QUESTION_MARKERS.test(text)) return false;
  const subject = entityPattern(entity);
  return new RegExp(`${subject}.{0,36}(?:被战斗破坏并送去墓地|被战破并送墓|已经送墓|已经送去墓地|送去墓地后|送墓后|并送去墓地)`, "iu").test(text);
}

function hasCompletedBanish(text, entity) {
  if (QUESTION_MARKERS.test(text)) return false;
  const subject = entityPattern(entity);
  return new RegExp(`${subject}.{0,36}(?:被战斗破坏并被除外|被战破并被除外|被战破并除外|已经被除外|被除外后)`, "iu").test(text);
}

function hasQuestionedBanish(text, entity) {
  if (!QUESTION_MARKERS.test(text) || !/(除外该|除外(?:这|那|该)?只|暂时除外|能用.{0,30}除外)/u.test(text)) return false;
  if (/除外(?:该)?卡通怪兽/u.test(text)) return entity.name === "referenced_toon_monster";
  if (entity.name === "referenced_toon_monster") return false;
  return mentionsEntity(text, entity) && /除外/u.test(text);
}

function hasExplicitOnField(text, entity) {
  if (QUESTION_MARKERS.test(text)) return false;
  const subject = entityPattern(entity);
  return new RegExp(`${subject}.{0,30}(?:仍在|留在|继续存在于)(?:怪兽区|场上)|${subject}.{0,24}没有被战斗破坏`, "iu").test(text);
}

function inferBanishTarget(text, entities) {
  if (/除外(?:该)?卡通怪兽/u.test(text)) return entities.find((item) => item.name === "referenced_toon_monster") || null;
  return findMentionedEntity(text, entities);
}

function inferBattleActor(text, target, entities) {
  const match = text.match(/被([^，。；\n]{1,24})战破的(?:该)?卡通怪兽/u);
  if (!match) return "unknown";
  const actor = findMentionedEntity(match[1], entities);
  return actor && !sameCard(actor.name, target.name) ? actor.name : match[1].trim();
}

function inferTiming(text, damageStepEnd) {
  if (/(伤判结束阶段|伤害步骤结束阶段|伤害步骤结束时)/u.test(text) || damageStepEnd) return "damage_step_end";
  if (/(效果处理时|处理时)/u.test(text)) return "effect_resolution";
  if (/(效果处理后|送墓后|送去墓地后)/u.test(text)) return "after_effect_resolution";
  return "unknown";
}

function questionStatus(text) {
  return QUESTION_MARKERS.test(text) ? "questioned" : "completed";
}

function findMentionedEntity(text, entities) {
  return entities
    .filter((item) => mentionsEntity(text, item))
    .sort((left, right) => mentionLength(text, right) - mentionLength(text, left))[0] || null;
}

function mentionLength(text, entity) {
  if (entity.name === "referenced_toon_monster") return /该卡通怪兽/u.test(text) ? 6 : 5;
  return Math.max(0, ...displayNames(entity).filter((name) => normalize(text).includes(normalize(name))).map((name) => normalize(name).length));
}

function findEntity(card, entities) {
  return entities.find((item) => matchesCard(item.name, card)) || null;
}

function mentionsEntity(text, entity) {
  if (entity.name === "referenced_toon_monster") return /(?:该)?卡通怪兽/u.test(text);
  return displayNames(entity).some((name) => normalize(text).includes(normalize(name)));
}

function entityPattern(entity) {
  if (entity.name === "referenced_toon_monster") return "(?:该)?卡通怪兽";
  return `(?:${displayNames(entity).map(escapeRegExp).join("|")})`;
}

function displayNames(entity) {
  return [...new Set([entity?.name, entity?.cnName, entity?.jaName, entity?.enName, ...(entity?.aliases || [])].filter(Boolean))];
}

function matchesCard(left, right, fallback) {
  const candidate = normalize(left);
  return [right, fallback].filter(Boolean).some((value) => {
    const wanted = normalize(value);
    return candidate && wanted && (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
  });
}

function sameCard(left, right) {
  return matchesCard(left, right);
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.type, normalize(event.card), event.status, normalize(event.sourceText)].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeTransitions(transitions) {
  const seen = new Set();
  return transitions.filter((item) => {
    const key = [normalize(item.card), item.fromZone, item.toZone, item.status, item.reason].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
