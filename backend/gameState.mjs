export function buildGameStateFromFormalQuery(formalQuery) {
  const query = formalQuery && typeof formalQuery === "object" ? formalQuery : {};
  const scenario = query.scenario || {};
  const cards = mergeEntityCards([...(query.cards || []), ...(query.resolvedCards || [])]);
  const textParts = [
    scenario.rawContext,
    ...(query.subQuestions || []).map((item) => item.sourceText),
    ...(scenario.events || []).map((event) => `${event.card || ""} ${event.action || ""} ${event.fromZone || ""} ${event.toZone || ""}`),
  ].filter(Boolean);
  const fullText = textParts.join("\n");
  const assumptions = [];
  const contradictions = [];
  const unknowns = [];
  const entities = cards.map((card) => buildEntityState(card, textParts, scenario.events || [], assumptions, contradictions, unknowns));
  const damageStepEnd = /(伤判结束阶段|伤害步骤结束阶段|伤害步骤结束时|ダメージステップ終了時|end of the Damage Step)/iu.test(fullText);
  const afterDamageCalculation = damageStepEnd || /(伤害计算后|ダメージ計算後|after damage calculation)/iu.test(fullText);

  return {
    entities,
    timing: {
      phase: scenario.phase || "unknown",
      step: damageStepEnd ? "timing_damage_step_end" : afterDamageCalculation ? "after_damage_calculation" : "unknown",
      chainState: scenario.chainState || "unknown",
      isDuringResolution: scenario.chainState === "during_resolution" || /(效果处理时|处理过程中|during resolution)/iu.test(fullText),
      isAfterDamageCalculation: afterDamageCalculation,
      isEndOfDamageStep: damageStepEnd,
    },
    assumptions,
    contradictions,
    unknowns,
  };
}

function buildEntityState(card, textParts, events, assumptions, contradictions, unknowns) {
  const names = [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
  const name = card.name || names[0] || "unknown";
  const relevantParts = textParts.filter((part) => names.some((candidate) => normalize(part).includes(normalize(candidate))));
  const relevant = relevantParts.join("\n");
  const assertiveRelevant = relevantParts.filter((part) => !/(是否|会不会|还会|能否|吗[？?]?|还是)/u.test(part)).join("\n");
  const escapedNames = names.map(escapeRegExp).join("|");
  const subject = escapedNames ? `(?:${escapedNames})` : escapeRegExp(name);
  const destroyedNegative = new RegExp(`${subject}.{0,24}(?:没有|未)(?:被)?(?:战破|战斗破坏)|${subject}.{0,24}(?:不会|不能)被战斗破坏`, "iu").test(relevant);
  const destroyedPositive = new RegExp(`${subject}.{0,24}(?:被战破|被战斗破坏|战斗中被破坏)`, "iu").test(relevant);
  let wasDestroyedByBattle = destroyedNegative ? false : destroyedPositive ? true : null;

  const sentQuestion = new RegExp(`${subject}.{0,30}(?:是否已经|会不会|还会|是否会).{0,12}(?:送墓|送去墓地)|${subject}.{0,30}(?:送墓|送去墓地).{0,4}[吗？?]`, "iu").test(relevant);
  const sentNegative = new RegExp(`${subject}.{0,24}(?:没有|未|不会)(?:被)?(?:送墓|送去墓地)`, "iu").test(relevant);
  const sentPositive = new RegExp(`${subject}.{0,30}(?:被战斗破坏并送去墓地|被战破并送墓|已经送墓|已经送去墓地|送去墓地后|送墓后)`, "iu").test(assertiveRelevant);
  let wasSentToGraveyard = sentNegative ? false : sentPositive ? true : null;
  if (sentQuestion && !sentPositive && !sentNegative) wasSentToGraveyard = null;

  const banishedQuestion = new RegExp(`${subject}.{0,30}(?:是否|会不会|能否).{0,12}(?:被)?除外|${subject}.{0,24}除外.{0,4}[吗？?]`, "iu").test(relevant);
  const banishedNegative = new RegExp(`${subject}.{0,24}(?:没有|未|不会)(?:被)?除外`, "iu").test(relevant);
  const banishedPositive = new RegExp(`${subject}.{0,30}(?:被战斗破坏并被除外|被战破并除外|已经被除外|被除外后)`, "iu").test(assertiveRelevant);
  let wasBanished = banishedNegative ? false : banishedPositive ? true : null;
  if (banishedQuestion && !banishedPositive && !banishedNegative) wasBanished = null;

  const remainsNegative = new RegExp(`${subject}.{0,24}(?:不在|离开)(?:怪兽区|场上)`, "iu").test(relevant);
  const remainsPositive = new RegExp(`${subject}.{0,30}(?:仍在|留在|继续存在于)(?:怪兽区|场上)|${subject}.{0,24}没有被战斗破坏`, "iu").test(relevant);
  let remainsOnField = remainsNegative ? false : remainsPositive ? true : null;
  let currentZone = normalizeZone(card.zone);
  let previousZone = "unknown";

  for (const event of events) {
    if (!names.some((candidate) => normalize(event.card).includes(normalize(candidate)))) continue;
    previousZone = normalizeZone(event.fromZone) || previousZone;
    currentZone = normalizeZone(event.toZone) || currentZone;
    if (/战斗破坏|战破/iu.test(event.action || "")) wasDestroyedByBattle = true;
    if (currentZone === "graveyard") wasSentToGraveyard = true;
    if (currentZone === "banished") wasBanished = true;
  }

  if (wasSentToGraveyard === true) {
    currentZone = "graveyard";
    remainsOnField = false;
    if (wasBanished === null) {
      wasBanished = false;
      assumptions.push(`${name}:sent_to_graveyard_implies_not_banished`);
    }
  } else if (wasBanished === true) {
    currentZone = "banished";
    remainsOnField = false;
    if (wasSentToGraveyard === null) {
      wasSentToGraveyard = false;
      assumptions.push(`${name}:banished_implies_not_sent_to_graveyard`);
    }
  } else if (remainsOnField === true || wasDestroyedByBattle === false) {
    currentZone = "monster_zone";
    remainsOnField = true;
    if (wasSentToGraveyard === null) wasSentToGraveyard = false;
    if (wasBanished === null) wasBanished = false;
  }

  const effectText = String(card.effectText || card.text || "");
  if (wasDestroyedByBattle === true && /(?:不会|不能)被战斗破坏|戦闘では破壊されない|cannot be destroyed by battle/iu.test(effectText)) {
    contradictions.push(`${name}:scenario_destroyed_by_battle_but_card_text_prevents_battle_destruction`);
  }
  if (wasDestroyedByBattle === null) unknowns.push(`${name}.wasDestroyedByBattle`);
  if (wasSentToGraveyard === null) unknowns.push(`${name}.wasSentToGraveyard`);
  if (wasBanished === null) unknowns.push(`${name}.wasBanished`);
  if (remainsOnField === null) unknowns.push(`${name}.remainsOnField`);

  return {
    name,
    cardId: String(card.cardId || card.liveId || card.id || "unknown"),
    currentZone: currentZone || "unknown",
    previousZone,
    wasDestroyedByBattle,
    wasSentToGraveyard,
    wasBanished,
    remainsOnField,
    statusKnown: wasDestroyedByBattle !== null && (wasSentToGraveyard !== null || wasBanished !== null || remainsOnField !== null),
  };
}

function mergeEntityCards(cards) {
  const map = new Map();
  for (const card of cards) {
    const name = String(card?.name || "").trim();
    if (!name || name === "unknown") continue;
    const key = normalize(name);
    const existing = map.get(key);
    if (!existing) map.set(key, { ...card });
    else map.set(key, { ...existing, ...card, aliases: [...new Set([...(existing.aliases || []), ...(card.aliases || [])])] });
  }
  return [...map.values()];
}

function normalizeZone(value) {
  const text = normalize(value);
  if (!text || text === "unknown") return "unknown";
  if (/墓地|graveyard|\bgy\b/iu.test(text)) return "graveyard";
  if (/除外|banished/iu.test(text)) return "banished";
  if (/怪兽区|monsterzone/iu.test(text)) return "monster_zone";
  if (/场上|field/iu.test(text)) return "field";
  return String(value || "unknown");
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
