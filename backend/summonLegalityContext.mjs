import { collectEntityMentions } from "./scenarioEntityResolver.mjs";

const SYNCHRO_QUESTION = /(?:同调|同步|S召唤|S召喚|シンクロ|synchro).{0,24}(?:召唤|召喚|summon)|(?:召唤|召喚|summon).{0,24}(?:同调|同步|シンクロ|synchro)/iu;
const EXPLICIT_MATERIAL_SET = /(?:使用|用|以|将|把)(?:上述|以上|前述|这些|這些|这(?:几|些|[一二三四五六七八九十\d]+)(?:张|張|只|隻)?|該等|该等)[^。；;]{0,40}(?:作为|作為)?[^。；;]{0,16}(?:同调|同步|S召唤|S召喚|シンクロ|synchro)|(?:上述|以上|前述|这些|這些).{0,32}(?:作为|作為)?(?:同调|同步|S召唤|S召喚|シンクロ|synchro)(?:素材)?/iu;
const EXPLICIT_NO_RESTRICTIONS = /(?:(?:本|这|這|该|該)(?:回合|ターン)|this turn)?[^。；;]{0,12}(?:(?:未|尚未|并未|並未)(?:进入|進入|受到|适用|適用)(?:任何)?(?:自肃|自肅|誓约|誓約|特殊召唤限制|特殊召喚限制|召唤限制|召喚限制)|(?:没有|沒有|无|無|不存在)(?:任何)?(?:自肃|自肅|誓约|誓約|特殊召唤限制|特殊召喚限制|召唤限制|召喚限制)|(?:不受|未受到|没有受到|沒有受到)(?:任何)?(?:自肃|自肅|誓约|誓約|特殊召唤限制|特殊召喚限制|召唤限制|召喚限制)|no (?:summon )?(?:restriction|lock)s?)/iu;
const NUMBERED_EFFECT_START = /^(?:[①②③④⑤⑥⑦⑧⑨⑩]\s*[：:]?|\(?\d{1,2}\)?[.:：])/u;
const SYNCHRO_FORMULA_HINT = /(?:协调|協調|调整|調整|チューナー|tuner)/iu;
const MONSTER_TERM = /(?:怪兽|怪獸|モンスター|monsters?)/iu;
const HAND_MATERIAL_PERMISSION = /(?:以|要以|若以|如果以)?(?:场上|場上|フィールド)(?:的|の)?(?:此卡|这张卡|這張卡|このカード|this card)[^。；;]{0,32}(?:作为|作為|为|為|として|as)[^。；;]{0,16}(?:素材)[^。；;]{0,24}(?:同调|同步|シンクロ|synchro)[^。；;]{0,36}(?:手牌|手卡|手札|hand)[^。；;]{0,18}(?:1|１|一)(?:只|隻|体|體)?[^。；;]{0,12}(?:协调|協調|调整|調整|チューナー|tuner)[^。；;]{0,24}(?:也)?(?:作为|作為|当作|當作|として|as)[^。；;]{0,12}(?:素材)/giu;

export function buildSummonLegalityContext({
  userQuery = "",
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const query = String(userQuery || "").normalize("NFKC");
  if (!SYNCHRO_QUESTION.test(query)) return null;

  const cards = mergeCardFacts(resolvedCards, cardTexts);
  const mentions = collectEntityMentions(query, cards);
  const mentionedIds = new Set(mentions.map((mention) => mention.entityId));
  const mentionedCards = cards.filter((card) => mentionedIds.has(card.id));
  const targetSelection = selectSynchroTarget(query, mentionedCards, mentions);
  if (targetSelection.status !== "bound") {
    return partialContext(query, targetSelection.reason, {
      targetCandidates: targetSelection.candidates || [],
    });
  }

  const target = targetSelection.card;
  const formula = parseSynchroMaterialFormula(target.text, target);
  const proposedMaterialSetExplicit = EXPLICIT_MATERIAL_SET.test(query);
  const materialCards = mentionedCards
    .filter((card) => card.id !== target.id)
    .map((card) => materialFact(card, inferMentionZone(query, card, mentions)));
  const permissions = materialCards.flatMap((material) => (
    parseHandTunerPermissions(material.cardText).map((permission, index) => ({
      id: `${material.cardId}:synchro-hand-tuner:${index + 1}`,
      sourceCardId: material.cardId,
      sourceCardName: material.cardName,
      sourceRequiredAsMaterial: true,
      sourceRequiredZone: "monster_zone",
      summonKind: "synchro",
      grant: {
        zone: "hand",
        maximum: permission.maximum,
        selector: { tuner: true },
      },
      sourceText: permission.sourceText,
      sourceEvidenceIds: material.sourceEvidenceIds,
    }))
  ));
  const activePermissions = permissions.filter((permission) => (
    materialCards.some((material) => (
      material.cardId === permission.sourceCardId
      && material.zone === permission.sourceRequiredZone
    ))
  ));
  const restrictionAssessment = EXPLICIT_NO_RESTRICTIONS.test(query)
    ? { status: "explicit_none", activeRestrictions: [], source: "user_query" }
    : { status: "not_asserted", activeRestrictions: [], source: "unavailable" };
  const checks = buildChecks({
    formula,
    target,
    materials: materialCards,
    permissions,
    activePermissions,
    proposedMaterialSetExplicit,
    restrictionAssessment,
  });
  const missingFacts = missingFactsFor({
    formula,
    materials: materialCards,
    proposedMaterialSetExplicit,
    restrictionAssessment,
  });

  return {
    schema: "summon-legality-context/v1",
    status: missingFacts.length ? "partial" : "complete",
    authority: "normalizer_candidate_only",
    questionScope: "synchro_summon_legality",
    mustVerifyAgainstRawCardText: true,
    target: {
      cardId: target.id,
      cardName: target.name,
      summonKind: "synchro",
      sourceZone: "extra_deck",
      level: finiteNumber(target.level),
      attribute: normalizeAttribute(target.attribute),
      race: String(target.race || ""),
      properties: target.properties,
      printedRequirement: formula,
      sourceEvidenceIds: target.evidenceIds,
    },
    proposedMaterialSetExplicit,
    materials: materialCards.map(withoutPrivateCardText),
    alternateZonePermissions: permissions,
    activeAlternateZonePermissions: activePermissions.map((item) => item.id),
    restrictionAssessment,
    checks,
    missingFacts,
  };
}

function partialContext(query, reason, extra = {}) {
  return {
    schema: "summon-legality-context/v1",
    status: "partial",
    authority: "normalizer_candidate_only",
    questionScope: "synchro_summon_legality",
    mustVerifyAgainstRawCardText: true,
    reason,
    checks: [],
    missingFacts: [reason],
    ...extra,
  };
}

function mergeCardFacts(resolvedCards, cardTexts) {
  const records = new Map();
  for (const item of [...(cardTexts || []), ...(resolvedCards || [])]) {
    const rawId = String(item?.cardId || item?.cardIds?.[0] || item?.id || "");
    const id = rawId.replace(/^card-text-/u, "");
    const names = uniqueStrings([
      ...(item?.cards || []),
      ...(item?.aliases || []),
      item?.input,
      item?.matchedQuery,
      item?.name,
      item?.cnName,
      item?.jaName,
      item?.jpName,
      item?.enName,
    ]);
    const key = id || normalizeIdentity(names[0]);
    if (!key || !names.length) continue;
    const previous = records.get(key) || {};
    const properties = uniqueStrings([
      ...(previous.properties || []),
      ...(item?.properties || []),
      ...(item?.monsterProperties || []),
      ...(item?.raw?.properties || []),
      ...(item?.raw?.monsterProperties || []),
    ]);
    records.set(key, {
      ...previous,
      ...item,
      id: id || previous.id || key,
      name: item?.name || item?.cnName || previous.name || names[0],
      names: uniqueStrings([...(previous.names || []), ...names]),
      text: String(item?.effectText || item?.text || previous.text || ""),
      level: item?.level ?? previous.level ?? null,
      rank: item?.rank ?? previous.rank ?? null,
      link: item?.link ?? previous.link ?? null,
      attribute: item?.attribute ?? previous.attribute ?? "",
      race: item?.race ?? previous.race ?? "",
      properties,
      evidenceIds: uniqueStrings([
        ...(previous.evidenceIds || []),
        ...(item?.sourceEvidenceIds || []),
        /^card-text-/u.test(String(item?.id || "")) ? item.id : "",
      ]),
    });
  }
  return [...records.values()];
}

function selectSynchroTarget(query, cards, mentions) {
  const candidates = cards.filter(isSynchroCard).map((card) => {
    const cardMentions = mentions.filter((mention) => mention.entityId === card.id);
    const score = Math.max(0, ...cardMentions.map((mention) => {
      const before = query.slice(Math.max(0, mention.index - 56), mention.index);
      const after = query.slice(mention.end, mention.end + 40);
      let value = 1;
      if (/(?:额外卡组|額外卡組|额外牌组|額外牌組|EXデッキ|エクストラデッキ|extra deck)/iu.test(before)) value += 6;
      if (/(?:同调|同步|S召唤|S召喚|シンクロ|synchro).{0,24}(?:召唤|召喚|summon)[^。；;]{0,24}$/iu.test(before)) value += 5;
      if (/^(?:作为|作為)?[^。；;]{0,12}(?:进行|進行)?(?:同调|同步|S召唤|S召喚|シンクロ|synchro)/iu.test(after)) value += 4;
      return value;
    }));
    return { card, score };
  }).sort((left, right) => right.score - left.score || left.card.name.localeCompare(right.card.name));
  if (!candidates.length) return { status: "unresolved", reason: "synchro_target_unresolved", candidates: [] };
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return {
      status: "ambiguous",
      reason: "synchro_target_ambiguous",
      candidates: candidates.map(({ card }) => ({ cardId: card.id, cardName: card.name })),
    };
  }
  return { status: "bound", card: candidates[0].card };
}

function isSynchroCard(card) {
  return (card.properties || []).some((value) => /^(?:synchro|同步|同调|シンクロ)$/iu.test(String(value)))
    || Boolean(parseSynchroMaterialFormula(card.text, card));
}

function parseSynchroMaterialFormula(text, card = {}) {
  const line = String(text || "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item && !NUMBERED_EFFECT_START.test(item) && /[＋+]/u.test(item) && SYNCHRO_FORMULA_HINT.test(item));
  if (!line) return null;
  const slots = line.split(/\s*[＋+]\s*/u).map(parseMaterialSlot).filter(Boolean);
  if (slots.length < 2 || !slots.some((slot) => slot.selector.tuner === true)) return null;
  const targetLevel = finiteNumber(card.level);
  return {
    sourceText: line,
    slots,
    aggregate: {
      property: "level",
      operator: "sum_equals",
      value: targetLevel,
    },
  };
}

function parseMaterialSlot(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text || !MONSTER_TERM.test(text) && !SYNCHRO_FORMULA_HINT.test(text)) return null;
  const countMatch = text.match(/(\d+)\s*(?:只|隻|体|體|枚)?\s*(以上|或以上|及以上|or more)?/iu);
  const count = countMatch ? Number(countMatch[1]) : 1;
  const openEnded = Boolean(countMatch?.[2]);
  const nonTuner = /(?:协调|協調|调整|調整|チューナー|tuner)\s*(?:以外|之外|之外的|外|ではない|non[- ]?)/iu.test(text)
    || /non[- ]?tuner/iu.test(text);
  const tuner = SYNCHRO_FORMULA_HINT.test(text) && !nonTuner;
  return {
    minimum: count,
    maximum: openEnded ? null : count,
    selector: {
      ...(tuner ? { tuner: true } : {}),
      ...(nonTuner ? { tuner: false } : {}),
      ...(extractAttribute(text) ? { attribute: extractAttribute(text) } : {}),
      ...(extractRace(text) ? { race: extractRace(text) } : {}),
    },
    sourceText: value,
  };
}

function parseHandTunerPermissions(text) {
  const source = String(text || "").normalize("NFKC");
  const matches = [...source.matchAll(HAND_MATERIAL_PERMISSION)];
  return matches.map((match) => ({ maximum: 1, sourceText: match[0] }));
}

function materialFact(card, zone) {
  return {
    cardId: card.id,
    cardName: card.name,
    zone,
    level: finiteNumber(card.level),
    attribute: normalizeAttribute(card.attribute),
    race: String(card.race || ""),
    properties: card.properties,
    tuner: isTuner(card),
    sourceEvidenceIds: card.evidenceIds,
    cardText: card.text,
  };
}

function withoutPrivateCardText(material) {
  const { cardText, ...publicFact } = material;
  return publicFact;
}

function inferMentionZone(query, card, mentions) {
  const mention = mentions.find((item) => item.entityId === card.id);
  if (!mention) return "unknown";
  const sentenceStart = Math.max(
    query.lastIndexOf("。", mention.index - 1),
    query.lastIndexOf("；", mention.index - 1),
    query.lastIndexOf(";", mention.index - 1),
    query.lastIndexOf("\n", mention.index - 1),
  ) + 1;
  const prefix = query.slice(sentenceStart, mention.index);
  const markers = [
    ["monster_zone", /(?:自己|我方|我的|己方)?(?:的)?(?:场上|場上|怪兽区域|怪獸區域|モンスターゾーン|field)/giu],
    ["hand", /(?:自己|我方|我的|己方)?(?:的)?(?:手牌|手卡|手札|hand)/giu],
    ["extra_deck", /(?:自己|我方|我的|己方)?(?:的)?(?:额外卡组|額外卡組|额外牌组|額外牌組|EXデッキ|エクストラデッキ|extra deck)/giu],
  ].flatMap(([zone, pattern]) => [...prefix.matchAll(pattern)].map((match) => ({ zone, index: match.index || 0 })));
  return markers.sort((left, right) => right.index - left.index)[0]?.zone || "unknown";
}

function buildChecks({ formula, target, materials, permissions, activePermissions, proposedMaterialSetExplicit, restrictionAssessment }) {
  const checks = [];
  checks.push({
    code: "printed_material_formula",
    status: formula ? "available" : "unknown",
    sourceText: formula?.sourceText || "",
  });
  checks.push({
    code: "proposed_material_set",
    status: proposedMaterialSetExplicit ? "explicit" : "unknown",
    materialCardIds: materials.map((item) => item.cardId),
  });

  const zonesKnown = materials.every((item) => item.zone !== "unknown");
  const handMaterials = materials.filter((item) => item.zone === "hand");
  const unauthorizedNonField = materials.filter((item) => !["monster_zone", "hand"].includes(item.zone));
  const capacity = activePermissions.reduce((sum, permission) => sum + Number(permission.grant.maximum || 0), 0);
  const handSelectorsSatisfied = handMaterials.every((item) => item.tuner === true);
  checks.push({
    code: "material_zones",
    status: zonesKnown && !unauthorizedNonField.length ? "satisfied" : zonesKnown ? "failed" : "unknown",
    unsupportedMaterialCardIds: unauthorizedNonField.map((item) => item.cardId),
  });
  checks.push({
    code: "hand_material_permission_capacity",
    status: !zonesKnown ? "unknown" : handMaterials.length <= capacity ? "satisfied" : "failed",
    required: handMaterials.length,
    available: capacity,
    activePermissionIds: activePermissions.map((item) => item.id),
    discoveredPermissionIds: permissions.map((item) => item.id),
  });
  checks.push({
    code: "hand_material_selectors",
    status: handMaterials.some((item) => item.tuner === null)
      ? "unknown"
      : handSelectorsSatisfied ? "satisfied" : "failed",
    rejectedMaterialCardIds: handMaterials.filter((item) => item.tuner === false).map((item) => item.cardId),
  });

  const targetLevel = finiteNumber(target.level);
  const levelsKnown = targetLevel !== null && materials.every((item) => item.level !== null);
  const actualLevel = levelsKnown ? materials.reduce((sum, item) => sum + item.level, 0) : null;
  checks.push({
    code: "synchro_level_sum",
    status: !levelsKnown ? "unknown" : actualLevel === targetLevel ? "satisfied" : "failed",
    expected: targetLevel,
    actual: actualLevel,
  });

  const formulaResult = formula && proposedMaterialSetExplicit
    ? evaluateFormulaAssignment(materials, formula.slots)
    : { status: "unknown", assignment: [] };
  checks.push({
    code: "material_formula_assignment",
    status: formulaResult.status,
    assignment: formulaResult.assignment,
  });
  checks.push({
    code: "active_summon_restrictions",
    status: restrictionAssessment.status === "explicit_none" ? "satisfied" : "unknown",
    assessment: restrictionAssessment.status,
  });
  return checks;
}

function evaluateFormulaAssignment(materials, slots) {
  if (!materials.length || !slots?.length) return { status: "unknown", assignment: [] };
  const attributeRequired = slots.some((slot) => Boolean(slot?.selector?.attribute));
  if (materials.some((material) => material.tuner === null)
      || (attributeRequired && materials.some((material) => !material.attribute))) {
    return { status: "unknown", assignment: [] };
  }
  const counts = slots.map(() => 0);
  const assignment = [];
  const search = (materialIndex) => {
    if (materialIndex >= materials.length) {
      return slots.every((slot, index) => (
        counts[index] >= slot.minimum
        && (slot.maximum === null || counts[index] <= slot.maximum)
      ));
    }
    const material = materials[materialIndex];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      if (slot.maximum !== null && counts[slotIndex] >= slot.maximum) continue;
      if (!matchesMaterialSelector(material, slot.selector)) continue;
      counts[slotIndex] += 1;
      assignment.push({ cardId: material.cardId, slotIndex });
      if (search(materialIndex + 1)) return true;
      assignment.pop();
      counts[slotIndex] -= 1;
    }
    return false;
  };
  return search(0)
    ? { status: "satisfied", assignment: [...assignment] }
    : { status: "failed", assignment: [] };
}

function matchesMaterialSelector(material, selector = {}) {
  if (selector.tuner !== undefined && material.tuner !== selector.tuner) return false;
  if (selector.attribute && material.attribute !== selector.attribute) return false;
  if (selector.race && normalizeIdentity(material.race) !== normalizeIdentity(selector.race)) return false;
  return true;
}

function missingFactsFor({ formula, materials, proposedMaterialSetExplicit, restrictionAssessment }) {
  const missing = [];
  if (!formula) missing.push("synchro_target_printed_material_formula");
  if (formula?.aggregate?.value === null) missing.push("synchro_target_level");
  if (!proposedMaterialSetExplicit) missing.push("proposed_material_set_not_explicit");
  const attributeRequired = formula?.slots?.some((slot) => Boolean(slot?.selector?.attribute));
  for (const material of materials) {
    if (material.zone === "unknown") missing.push(`material_zone:${material.cardId}`);
    if (material.level === null) missing.push(`material_level:${material.cardId}`);
    if (material.tuner === null) missing.push(`material_tuner_property:${material.cardId}`);
    if (attributeRequired && !material.attribute) missing.push(`material_attribute:${material.cardId}`);
  }
  if (restrictionAssessment.status !== "explicit_none") missing.push("active_summon_restrictions_not_asserted");
  return uniqueStrings(missing);
}

function isTuner(card) {
  const properties = (card.properties || []).map(String);
  if (properties.some((value) => /^(?:Tuner|协调|協調|调整|調整|チューナー)$/iu.test(value))) return true;
  if (properties.length) return false;
  return /(?:协调|協調|调整|調整|チューナー|\btuner\b)/iu.test(String(card.text || "")) ? true : null;
}

function extractAttribute(value) {
  const match = String(value || "").match(/(光|暗|闇|炎|水|风|風|地|神)(?:属性|屬性)|\b(LIGHT|DARK|FIRE|WATER|WIND|EARTH|DIVINE)\b/iu);
  return normalizeAttribute(match?.[1] || match?.[2] || "");
}

function normalizeAttribute(value) {
  const key = normalizeIdentity(value).replace(/(?:属性|屬性)$/u, "");
  const aliases = new Map([
    ["light", "light"], ["光", "light"],
    ["dark", "dark"], ["暗", "dark"], ["闇", "dark"],
    ["fire", "fire"], ["炎", "fire"],
    ["water", "water"], ["水", "water"],
    ["wind", "wind"], ["风", "wind"], ["風", "wind"],
    ["earth", "earth"], ["地", "earth"],
    ["divine", "divine"], ["神", "divine"],
  ]);
  return aliases.get(key) || key;
}

function extractRace(value) {
  return String(value || "").match(/([\p{Script=Han}]{1,10}族)(?:怪兽|怪獸)?|\b([A-Za-z -]+?)(?:-Type)? monsters?\b/iu)?.[1] || "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeIdentity(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}
