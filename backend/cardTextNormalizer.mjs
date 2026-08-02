import { splitCardTextSections, tagEffectText } from "./cardTextSections.mjs";
import { extractPrintedNameReferences } from "./printedTextReferences.mjs";

export const CARD_TEXT_IR_VERSION = "1.3";

const ACTIVATION_MARKER = /(?:可以发动|才能发动|可发动|発動できる|発動する|you can activate|can be activated)/iu;
const CONTINUOUS_MARKER = /(?:只要|期间|持续|繼續|一直|限り|公開し続け|し続ける|must keep|while .*face-up|as long as)/iu;
const HAND_WORD = /(?:手牌|手卡|手札|hand)/iu;
const PUBLIC_WORD = /(?:公开|公開|展示|出示|给对方观看|給對方觀看|给对手看|相手に見せ|reveal|show)/iu;
const OPPONENT_WORD = /(?:对方|對方|对手|相手|opponent)/iu;
const CONTROLLER_WORD = /(?:自己|自身|自分|your|controller)/iu;
const BOTH_PLAYERS_WORD = /(?:双方|双方玩家|彼此|お互い|両方のプレイヤー|both players)/iu;
const PER_PLAYER_SAME_RACE_LIMIT = /(?:双方|雙方|お互い|each player).{0,48}(?:各|それぞれ|only|可有).{0,20}(?:1|１|一)(?:只|隻|体|體|枚)?.{0,28}(?:同种族|同種族|同じ種族|same Type).{0,28}(?:表侧|表側|face-up)/iu;
const PER_PLAYER_ONE_RACE_LIMIT = /(?:双方|雙方|お互い|each player).{0,48}(?:仅可有|只可有|只能有|only control).{0,20}(?:1|１|一)(?:种|種|type).{0,16}(?:种族|種族|Type)/iu;
const PER_PLAYER_ONE_ATTRIBUTE_LIMIT = /(?:双方|雙方|お互い|each player).{0,48}(?:仅可有|只可有|只能有|only control).{0,20}(?:1|１|一)(?:种|種|type).{0,16}(?:属性|Attribute)/iu;
const SUMMON_BOUND_DURATION = /(?:(?:以|用)?(?:此|这个|這個|该|該)效果特殊召唤的怪兽|この効果で特殊召喚した(?:モンスター|このカード)|(?:this card|monster(?:s)?) Special Summoned by this effect)/iu;
const ACTIVATION_LIMIT_ONLY = /(?:此卡名|这张卡名|このカード名|cards? with this name).{0,48}(?:[1１]回合|[1１]ターン|per turn).{0,36}(?:发动|發動|発動|activate).{0,16}(?:[1１](?:张|張)|[1１]枚|一次|1 time|once)/iu;
const SELF_FACE_UP_LEAVE_FIELD_BANISH = /(?:(?:表侧|表側)表示(?:的|の)?(?:此卡|这张卡|這張卡|このカード).{0,24}(?:离开|離開|離れる).{0,16}(?:场上|場上|フィールド).{0,32}(?:将其|將其|该卡|該卡|此卡|このカード)?[^。；;]{0,12}(?:除外|banish)|(?:if\s+)?this face-up card.{0,24}leave the field.{0,24}banish it)/iu;

export function normalizeCardText(card = {}) {
  const identity = normalizeCardIdentity(card);
  const parsed = splitCardTextSections({
    ...card,
    effectText: card.effectText || card.text || card.description || "",
  });
  const sourceEffects = primaryEffectEntries(parsed.sections);
  const effects = sourceEffects.map((entry, index) => normalizeEffectEntry(entry, {
    cardId: identity.cardId,
    index,
  }));

  return {
    schema: "ocg-card-text-ir",
    version: CARD_TEXT_IR_VERSION,
    identity,
    cardType: String(card.cardType || card.type || "unknown").toLowerCase(),
    isPendulum: parsed.isPendulum,
    // This is derived only from the card's database/printed text. Runtime name
    // or effect copying must never mutate it.
    printedNameReferences: extractPrintedNameReferences(
      card.effectText || card.text || card.description || "",
    ),
    effects,
    missingSections: [...parsed.missingSections],
  };
}

export function normalizeCardIdentity(card = {}) {
  const names = unique([
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    card.input,
    card.matchedQuery,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
    ...(Array.isArray(card.cards) ? card.cards : []),
  ]);
  return {
    cardId: String(card.cardId || card.id || ""),
    canonicalName: String(card.name || card.cnName || card.jaName || card.enName || names[0] || ""),
    names,
  };
}

export function findNormalizedSemantics(normalizedCard, predicate) {
  const output = [];
  for (const effect of normalizedCard?.effects || []) {
    for (const semantic of [
      ...(effect.activation?.procedures || []),
      ...(effect.activation?.costs || []),
      ...(effect.activation?.targets || []),
      ...(effect.continuous || []),
      ...(effect.resolution || []).map((step) => step.operation),
    ]) {
      if (!semantic) continue;
      if (typeof predicate === "function" ? predicate(semantic, effect) : semantic.type === predicate) {
        output.push({ effect, semantic });
      }
    }
  }
  return output;
}

function normalizeEffectEntry(entry, { cardId, index }) {
  const rawText = cleanText(entry.text);
  const effectNo = normalizeEffectNo(entry.effectNo || extractEffectNo(rawText));
  const activationMatch = findActivationMatch(rawText);
  const activationIndex = activationMatch?.index ?? -1;
  const activationPrefix = activationIndex >= 0 ? rawText.slice(0, activationIndex) : "";
  const resolutionText = activationIndex >= 0
    ? rawText.slice(activationIndex + activationMatch[0].length)
    : rawText;
  const nature = classifyEffectNature(entry.section, rawText, activationIndex);

  return {
    id: `${cardId || "unresolved"}:${effectNo}:${index + 1}`,
    effectNo,
    section: entry.section,
    nature,
    rawText,
    tags: tagEffectText(rawText),
    activation: {
      markerFound: activationIndex >= 0,
      conditions: parseActivationConditions(activationPrefix),
      procedures: parseActivationProcedures(activationPrefix),
      costs: parseActivationCosts(activationPrefix),
      targets: parseTargets(activationPrefix),
    },
    continuous: nature === "continuous" ? parseContinuousSemantics(rawText) : [],
    resolution: nature === "activated" ? parseResolutionSteps(resolutionText) : [],
  };
}

function primaryEffectEntries(sections = {}) {
  const entries = [];
  for (const section of ["pendulumEffects", "monsterEffects", "spellTrapEffects", "summonConditions", "otherText"]) {
    for (const text of sections[section] || []) {
      entries.push({
        section,
        text,
        effectNo: extractEffectNo(text),
      });
    }
  }
  return dedupeBy(entries, (entry) => `${entry.section}:${cleanText(entry.text)}`);
}

function classifyEffectNature(section, text, activationIndex) {
  if (activationIndex >= 0) return "activated";
  if (section === "summonConditions") return "summon_condition";
  if (parseContinuousSemantics(text).length
      || CONTINUOUS_MARKER.test(text)
      || /(?:不会|不能|不受|効果を受けない|instead|代わりに|作为代替)/iu.test(text)) {
    return "continuous";
  }
  return "static";
}

function parseActivationConditions(prefix) {
  const text = cleanText(prefix);
  if (!text) return [];
  const conditions = [];
  const location = firstMatch(text, [
    ["hand", /(?:此卡|这张卡|このカード|this card).{0,24}(?:存在于|在|存在する)(?:手牌|手卡|手札|hand)/iu],
    ["graveyard", /(?:此卡|这张卡|このカード|this card).{0,24}(?:存在于|在|存在する)(?:墓地|graveyard)/iu],
    ["monster_zone", /(?:存在于|在|存在する)(?:怪兽区域|怪獸區域|モンスターゾーン|monster zone)/iu],
  ]);
  if (location) conditions.push({ type: "source_location", zone: location });
  if (/(?:场合|情况下|場合|時|when|if)/iu.test(text)) {
    conditions.push({ type: "event_or_state_condition", text });
  }
  return conditions;
}

function parseActivationProcedures(prefix) {
  const text = cleanText(prefix);
  const procedures = [];
  if (HAND_WORD.test(text) && PUBLIC_WORD.test(text) && OPPONENT_WORD.test(text)) {
    procedures.push({
      type: "reveal_hand",
      actor: "controller",
      handOwner: "controller",
      viewer: "opponent",
      scope: /(?:全部|全て|entire|all)/iu.test(text) ? "all" : "specified",
      timing: "activation",
      repeatableWhenAlreadyPublic: false,
      text,
    });
  }
  return procedures;
}

function parseActivationCosts(prefix) {
  const text = cleanText(prefix);
  const costs = [];
  const lp = text.match(/(?:支付|払(?:い|って|う)|pay)\s*([０-９\d,，]+)\s*LP/iu);
  if (lp) {
    costs.push({
      type: "pay_lp",
      actor: "controller",
      amount: parseNumber(lp[1]),
      timing: "activation",
      text: lp[0],
    });
  }
  const discard = text.match(/(?:舍弃|丢弃|捨て|discard)\s*([０-９\d一二三两兩]*)\s*(?:张|張|枚)?\s*(?:手牌|手卡|手札|card)/iu)
    || text.match(/(?:手牌|手卡|手札)\s*(?:中的|中の)?\s*([０-９\d一二三两兩]*)\s*(?:张|張|枚)?[^。；;]{0,20}(?:舍弃|丢弃|捨て|discard)/iu);
  if (discard) {
    costs.push({
      type: "discard_from_hand",
      actor: "controller",
      amount: parseCount(discard[1], 1),
      timing: "activation",
      text,
    });
  }
  const fieldMaterialSend = (
    /(?:自己|自分|your)[^。；;]{0,32}(?:场上|場上|フィールド|field)/iu.test(text)
    && /(?:协调|協調|调整|調整|チューナー|tuner)/iu.test(text)
    && /(?:协调以外|協調以外|调整以外|調整以外|チューナー以外|non[- ]?tuner)/iu.test(text)
    && (
      /(?:送去|送往|送至|送入|送る|send)[^。；;]{0,16}(?:墓地|graveyard)/iu.test(text)
      || /(?:墓地|graveyard)[^。；;]{0,12}(?:へ)?(?:送って|送る|send)/iu.test(text)
    )
  );
  if (fieldMaterialSend) {
    costs.push({
      type: "send_field_monsters_to_graveyard",
      actor: "controller",
      amount: 2,
      fromZone: "monster_zone",
      toZone: "graveyard",
      faceUp: /(?:表侧|表側|face-up)/iu.test(text),
      requiredRoles: ["tuner", "non_tuner"],
      timing: "activation",
      text,
    });
  }
  if (/(?:解放|リリース|tribute)/iu.test(text)) {
    costs.push({ type: "tribute", actor: "controller", timing: "activation", text });
  }
  if (/(?:从|從|将|將|把|このカードを|banish)\s*[^。；;]{0,60}(?:除外|banish)[^。；;]{0,24}(?:作为|作為)?(?:cost|代价|代價|コスト|可以发动|才能发动|発動できる|to activate)/iu.test(text)
      || /(?:除外|banish)[^。；;]{0,12}(?:作为|作為|as)\s*(?:cost|代价|代價|コスト)/iu.test(text)) {
    costs.push({ type: "banish_as_cost", actor: "controller", timing: "activation", text });
  }
  return costs;
}

function parseTargets(prefix) {
  const text = cleanText(prefix);
  if (!/(?:为对象|為對象|対象として|target)/iu.test(text)) return [];
  return [{
    type: "select_target",
    actor: "controller",
    timing: "activation",
    text,
  }];
}

function parseContinuousSemantics(text) {
  const value = cleanText(text);
  const semantics = [];
  if (HAND_WORD.test(value) && PUBLIC_WORD.test(value) && CONTINUOUS_MARKER.test(value)) {
    semantics.push({
      type: "hand_visibility",
      affected: classifyAffectedPlayer(value),
      visibility: "public",
      duration: "continuous",
      text: value,
    });
  }
  if (/(?:送去|送往|送至|墓地へ送られる|sent to).{0,30}(?:墓地|graveyard).{0,40}(?:除外|banish)/iu.test(value)
    || /(?:不去墓地|墓地へは行かず|instead.{0,20}banish)/iu.test(value)) {
    semantics.push({
      type: "destination_replacement",
      intendedZone: "graveyard",
      replacementZone: "banished",
      affected: classifyAffectedPlayer(value),
      duration: "continuous",
      text: value,
    });
  }
  if (SELF_FACE_UP_LEAVE_FIELD_BANISH.test(value)) {
    semantics.push({
      type: "destination_replacement",
      event: "leave_field",
      whenLeavingField: true,
      affected: "source",
      affectedCardRelation: "source",
      fromZones: ["monster_zone", "spell_trap_zone", "field_zone", "pendulum_zone"],
      requiresFaceUp: true,
      replacementZone: "banished",
      appliesWhenSourceLeaves: true,
      effectCauseKind: "card_effect",
      duration: "self_leave_field",
      text: value,
    });
  }
  if (/(?:不受.{0,24}效果影响|効果を受けない|unaffected by)/iu.test(value)) {
    semantics.push({
      type: "effect_immunity",
      affected: "source",
      duration: "continuous",
      text: value,
    });
  }
  if (PER_PLAYER_SAME_RACE_LIMIT.test(value)) {
    semantics.push({
      type: "field_count_limit",
      affected: "both",
      scope: "per_player",
      zone: "monster_zone",
      faceUp: true,
      groupBy: "race",
      maxCount: 1,
      duration: "continuous",
      text: value,
    });
  }
  if (PER_PLAYER_ONE_RACE_LIMIT.test(value)) {
    semantics.push({
      type: "field_count_limit",
      affected: "both",
      scope: "per_player",
      zone: "monster_zone",
      faceUp: true,
      groupBy: "race",
      distinctGroups: true,
      maxCount: 1,
      duration: "continuous",
      text: value,
    });
  }
  if (PER_PLAYER_ONE_ATTRIBUTE_LIMIT.test(value)) {
    semantics.push({
      type: "field_count_limit",
      affected: "both",
      scope: "per_player",
      zone: "monster_zone",
      faceUp: true,
      groupBy: "attribute",
      distinctGroups: true,
      maxCount: 1,
      duration: "continuous",
      text: value,
    });
  }
  const levelIncrease = value.match(
    /(?:场上|場上|フィールド|field)[^。；;]{0,48}(?:(?:等级|等級|レベル|level)\s*([０-９\d]+)[^。；;]{0,24})?(?:怪兽|怪獸|モンスター|monsters?)[^。；;]{0,36}(?:等级|等級|レベル|level)(?:上升|上昇|提高|增加|アップ|gain(?:s)?)\s*([０-９\d]+)(?:星|级|級|つ)?/iu,
  );
  if (levelIncrease) {
    semantics.push({
      type: "numeric_value_modifier",
      property: "level",
      operation: "add",
      amount: parseNumber(levelIncrease[2]),
      affected: classifyAffectedPlayer(value),
      selector: {
        zone: "monster_zone",
        faceUp: /(?:表侧|表側|face-up)/iu.test(value) ? true : null,
        ...(parseNumber(levelIncrease[1]) !== null
          ? { printedValue: parseNumber(levelIncrease[1]) }
          : {}),
      },
      expiresWhenLeavingSelectorZone: true,
      duration: "continuous",
      text: value,
    });
  }
  return semantics;
}

function parseResolutionSteps(text) {
  const clauses = splitResolutionClauses(text);
  return clauses.map((clause, index) => ({
    id: `operation_${index + 1}`,
    connector: clause.connector,
    operation: classifyResolutionOperation(clause.text),
  }));
}

function splitResolutionClauses(text) {
  const value = cleanText(text).replace(/^[，,。；;：:\s]+/u, "");
  if (!value) return [];
  const connectorPattern = /(?:然后|之后|那之后|并且|同时|若如此|and if you do|then|after that|also|その後|さらに)/giu;
  const matches = [...value.matchAll(connectorPattern)];
  if (!matches.length) return splitImplicitResolutionClauses(value, "INDEPENDENT");
  const output = [];
  let start = 0;
  let connector = "INDEPENDENT";
  for (const match of matches) {
    const before = cleanText(value.slice(start, match.index));
    if (before) output.push(...splitImplicitResolutionClauses(before, connector));
    connector = normalizeConnector(match[0]);
    start = Number(match.index) + match[0].length;
  }
  const tail = cleanText(value.slice(start));
  if (tail) output.push(...splitImplicitResolutionClauses(tail, connector));
  return output;
}

function splitImplicitResolutionClauses(text, firstConnector) {
  const rawFragments = cleanText(text)
    .split(/[，,；;。]+/u)
    .map(cleanText)
    .filter(Boolean);
  const fragments = [];
  for (const fragment of rawFragments) {
    const previous = fragments.at(-1);
    if (previous
        && SUMMON_BOUND_DURATION.test(previous)
        && /(?:仅可|只可|只能|不可|不能|しか|only|cannot).{0,48}(?:特殊召唤|特殊召喚|Special Summon)/iu.test(fragment)) {
      fragments[fragments.length - 1] = `${previous}，${fragment}`;
    } else {
      fragments.push(fragment);
    }
  }
  if (fragments.length < 2) return fragments.map((fragment) => ({ connector: firstConnector, text: fragment }));
  return fragments.map((fragment, index) => ({
    connector: index === 0 ? firstConnector : "THEN",
    text: fragment,
  }));
}

function classifyResolutionOperation(text) {
  const value = cleanText(text);
  if (isSummonBoundExtraDeckRestriction(value)) {
    const allowedArchetype = value.match(
      /(?:仅可|只可|只能|しか)[^。；;]{0,36}[“「『"]([^”」』"]+)[”」』"][^。；;]{0,16}(?:怪兽|怪獸|モンスター)/iu,
    )?.[1] || "";
    return {
      type: "create_lingering_restriction",
      binding: "monsters_special_summoned_by_this_effect",
      activeWhile: {
        zone: "monster_zone",
        controller: "effect_controller",
        faceUp: /(?:表侧|表側|face-up)/iu.test(value),
      },
      expiration: {
        mode: "irreversible_on_first_condition_failure",
        reactivates: false,
      },
      restriction: {
        type: "extra_deck_special_summon_lock",
        ...(allowedArchetype ? { allowedArchetype } : {}),
      },
      text: value,
    };
  }
  const usesActivationCostCards = /(?:(?:这个|此|该|この|the)\s*(?:效果|効果|effect)[^。；;]{0,24})?(?:送去|送往|送至|送入|送られた|sent)[^。；;]{0,20}(?:墓地|graveyard)[^。；;]{0,40}(?:怪兽|怪獸|モンスター|monsters?)[^。；;]{0,32}(?:作为|作為|为|為|として|as)\s*(?:素材|material)/iu.test(value)
    || /(?:因|由|通过|通過|この|this)[^。；;]{0,24}(?:效果|効果|effect)[^。；;]{0,24}(?:送去|送往|送至|送入|送られた|sent)[^。；;]{0,20}(?:墓地|graveyard)[^。；;]{0,32}(?:素材|material)/iu.test(value)
    || /(?:墓地|graveyard)(?:中|的|に存在する|にいる)?\s*(?:该|該|那|その|those)?\s*[２2二两兩]\s*(?:只|隻|体|體)?\s*(?:怪兽|怪獸|モンスター|monsters?)[^。；;]{0,32}(?:作为|作為|为|為|として|as)\s*(?:素材|material)/iu.test(value);
  const referencedSummonKinds = unique([
    /(?:同步|同调|シンクロ|synchro)/iu.test(value) ? "synchro" : "",
    /(?:融合|fusion)/iu.test(value) ? "fusion" : "",
  ]);
  if (usesActivationCostCards && referencedSummonKinds.length) {
    return {
      type: "summon_using_activation_cost_cards",
      text: value,
      materialReference: "activation_cost_cards",
      materialStateAt: "resolution_current_state",
      summonKinds: referencedSummonKinds,
      fromZone: "extra_deck",
    };
  }
  const rules = [
    ["fusion_summon", /(?:融合召唤|融合召喚|fusion summon)/iu],
    ["special_summon", /(?:特殊召唤|特殊召喚|special summon)/iu],
    ["tribute", /(?:解放|リリース|tribute)/iu],
    ["destroy", /(?:破坏|破壊|destroy)/iu],
    ["banish", /(?:除外|banish)/iu],
    ["send_to_graveyard", /(?:送去墓地|送往墓地|送至墓地|墓地へ送|send .*graveyard)/iu],
    ["return_to_hand", /(?:返回|放回|回到).{0,20}(?:手牌|手卡)|手札に戻|return .*hand/iu],
    ["return_to_deck", /(?:返回|放回|回到).{0,20}(?:牌组|卡组)|デッキに戻|return .*deck/iu],
    ["draw", /(?:抽|ドロー|draw)\s*[０-９\d一二三两]*\s*(?:张|枚|card)?/iu],
    ["add_to_hand", /(?:加入手牌|加入手卡|手札に加|add .*hand)/iu],
    ["inspect_hand", /(?:确认|確認|查看|見る|look at).{0,24}(?:手牌|手卡|手札|hand)/iu],
    ["reveal", PUBLIC_WORD],
  ];
  const type = firstMatch(value, rules) || "unparsed_operation";
  if (type !== "special_summon") {
    return {
      type,
      text: value,
      ...(["destroy", "banish", "return_to_hand", "return_to_deck"].includes(type)
        ? { optional: /(?:可以|可|任意|できる|may|you can)/iu.test(value) }
        : {}),
    };
  }

  const sourceCard = /(?:此卡|这张卡|這張卡|このカード|this card)/iu.test(value);
  const generatedMonster = /(?:衍生物|代币|代幣|トークン|token)/iu.test(value);
  const alternativeOperation = /(?:加入|加到|add).{0,16}(?:手牌|手卡|手札|hand).{0,8}(?:或|或者|または|or).{0,8}(?:特殊召唤|特殊召喚|special summon)/iu.test(value);
  const quotedNameMatches = [...value.matchAll(/[“「『"]([^”」』"]{2,50})[”」』"]/gu)];
  const excludedNames = unique(quotedNameMatches
    .filter((match) => quotedReferenceIsExcluded(value, match))
    .map((match) => match[1]));
  const quotedNames = unique(quotedNameMatches
    .filter((match) => !quotedReferenceIsExcluded(value, match))
    .map((match) => match[1]));
  const quotedName = quotedNames[0] || "";
  const explicitAmountMatch = value.match(/([０-９\d一二三两兩]+)\s*(?:只|隻|体|體|枚)/u);
  const explicitAmount = explicitAmountMatch ? parseCount(explicitAmountMatch[1], 1) : null;
  const distributesPerNamedCard = /(?:各|それぞれ|each)\s*[０-９\d一二三两兩]+\s*(?:只|隻|体|體|枚)?/iu.test(value);
  return {
    type,
    text: value,
    mandatory: !alternativeOperation && !/(?:可以|可选择|任意|できる|may|you can)/iu.test(value),
    ...(alternativeOperation ? { choice: "one_of_multiple_operations" } : {}),
    subject: sourceCard ? "effect_source" : generatedMonster ? "generated_monster" : "selected_card",
    amount: distributesPerNamedCard && quotedNames.length > 1
      ? quotedNames.length * (explicitAmount ?? 1)
      : explicitAmount ?? Math.max(quotedNames.length, 1),
    fromZone: firstMatch(value, [
      ["extra_deck", /(?:从|從)\s*(?:额外卡组|額外卡組|额外牌组|額外牌組)|(?:エクストラデッキから)|(?:from\s+(?:the\s+|your\s+)?extra deck)/iu],
      ["hand", /(?:从|從)\s*(?:手牌|手卡)|(?:手札から)|(?:from\s+(?:the\s+|your\s+)?hand)/iu],
      ["graveyard", /(?:从|從)\s*(?:墓地)|(?:墓地から)|(?:from\s+(?:the\s+|your\s+)?(?:GY|graveyard))/iu],
      ["deck", /(?:从|從)\s*(?:牌组|牌組|卡组|卡組)|(?<!エクストラ)(?:デッキから)|(?:from\s+(?:the\s+|your\s+)?deck)/iu],
    ]) || "unknown",
    destinationPlayerRelation: /(?:至|到|给|給)?(?:对方|對方|对手|對手|相手).{0,16}(?:场上|場上|フィールド)|opponent'?s (?:field|side)/iu.test(value)
      ? "opponent_of_source_controller"
      : "same_as_source_controller",
    ...(quotedName ? { name: quotedName } : {}),
    ...(quotedNames.length ? { names: quotedNames } : {}),
    ...(excludedNames.length ? { excludedNames } : {}),
    ...(extractRaceLabel(value) ? { race: extractRaceLabel(value) } : {}),
  };
}

function quotedReferenceIsExcluded(value, match) {
  const start = Number(match.index) || 0;
  const end = start + String(match[0] || "").length;
  const before = value.slice(Math.max(0, start - 24), start);
  const after = value.slice(end, end + 16);
  return /^\s*(?:以外|を除く)/iu.test(after)
    || /(?:除外|排除|except|other\s+than)\s*$/iu.test(before);
}

function isSummonBoundExtraDeckRestriction(value) {
  return SUMMON_BOUND_DURATION.test(value)
    && CONTINUOUS_MARKER.test(value)
    && /(?:表侧|表側|face-up)/iu.test(value)
    && /(?:(?:自己|自分|your)[^。；;]{0,24}(?:场上|場上|フィールド|field)|(?:场上|場上|フィールド|field)[^。；;]{0,24}(?:自己|自分|your))/iu.test(value)
    && hasExtraDeckSpecialSummonLock(value);
}

function hasExtraDeckSpecialSummonLock(value) {
  const chineseController = /(?:自己|我方)(?!\s*(?:场上|場上))[^。；;]{0,60}?(?:仅可|僅可|只可|只能|不可|不能|不得)(?!\s*(?:被|让|讓|使|令|把|将|將))[^。；;]{0,32}(?:(?:从|從|自)\s*)?(?:(?:额外|額外)(?:卡组|卡組|牌组|牌組))[^。；;]{0,28}(?:特殊召唤|特殊召喚)(?!\s*的(?:怪兽|怪獸|卡))/iu;
  const chineseDeckFirst = /(?:自己|我方)(?!\s*(?:场上|場上))[^。；;]{0,28}(?:(?:从|從|自)\s*)?(?:(?:额外|額外)(?:卡组|卡組|牌组|牌組))[^。；;]{0,28}(?:仅可|僅可|只可|只能|不可|不能|不得)(?!\s*(?:被|让|讓|使|令))[^。；;]{0,28}(?:特殊召唤|特殊召喚)(?!\s*的(?:怪兽|怪獸|卡))/iu;
  const japanese = /自分(?:は|が)?[^。；;]{0,48}(?:(?:EX|エクストラ)デッキから[^。；;]{0,32}(?:しか[^。；;]{0,12}(?:特殊召喚できない|特殊召喚を行えない)|特殊召喚できない)|しか[^。；;]{0,32}(?:(?:EX|エクストラ)デッキから)?[^。；;]{0,16}(?:特殊召喚できない|特殊召喚を行えない))/iu;
  const english = /\b(?:you|the controller)\s+(?:can only|cannot|can't)\s+Special Summon[^.;]{0,72}\bfrom\s+(?:your\s+)?(?:Extra Deck)\b/iu;
  return chineseController.test(value)
    || chineseDeckFirst.test(value)
    || japanese.test(value)
    || english.test(value);
}

function classifyAffectedPlayer(text) {
  if (BOTH_PLAYERS_WORD.test(text)) return "both";
  if (OPPONENT_WORD.test(text)) return "opponent";
  if (CONTROLLER_WORD.test(text)) return "controller";
  return "unknown";
}

function normalizeConnector(value) {
  if (/若如此|and if you do/iu.test(value)) return "AND_IF_YOU_DO";
  if (/并且|同时|also/iu.test(value)) return "ALSO";
  return "THEN";
}

function findActivationMatch(text) {
  const value = String(text || "");
  const matcher = new RegExp(
    ACTIVATION_MARKER.source,
    ACTIVATION_MARKER.flags.includes("g") ? ACTIVATION_MARKER.flags : `${ACTIVATION_MARKER.flags}g`,
  );
  for (const match of value.matchAll(matcher)) {
    const index = Number(match.index || 0);
    const clauseStart = Math.max(
      value.lastIndexOf("。", index - 1),
      value.lastIndexOf("；", index - 1),
      value.lastIndexOf(";", index - 1),
      value.lastIndexOf("，", index - 1),
      value.lastIndexOf(",", index - 1),
      value.lastIndexOf("\n", index - 1),
    ) + 1;
    const local = value.slice(clauseStart, index + match[0].length + 24);
    if (ACTIVATION_LIMIT_ONLY.test(local)) continue;
    return match;
  }
  return null;
}

function extractEffectNo(text) {
  return cleanText(text).match(/^\s*([①②③④⑤⑥⑦⑧⑨⑩]|\(?\d{1,2}\)?)[.:：]?/u)?.[1] || "unknown";
}

function normalizeEffectNo(value) {
  const circled = "①②③④⑤⑥⑦⑧⑨⑩";
  const text = String(value || "unknown").replace(/[().:：]/gu, "");
  const circledIndex = circled.indexOf(text);
  return circledIndex >= 0 ? String(circledIndex + 1) : text || "unknown";
}

function parseNumber(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/[,，]/gu, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCount(value, fallback = null) {
  const normalized = String(value || "").normalize("NFKC").trim();
  if (!normalized) return fallback;
  const chinese = new Map([
    ["一", 1],
    ["二", 2],
    ["两", 2],
    ["兩", 2],
    ["三", 3],
  ]);
  if (chinese.has(normalized)) return chinese.get(normalized);
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractRaceLabel(text) {
  return String(text || "").match(
    /(岩石族|龙族|龍族|ドラゴン族|Dragon|魔法师族|魔法使い族|Spellcaster|战士族|戰士族|戦士族|Warrior|恶魔族|惡魔族|悪魔族|Fiend|机械族|機械族|Machine|不死族|アンデット族|Zombie|兽族|獸族|獣族|Beast|鸟兽族|鳥獸族|鳥獣族|Winged Beast|水族|Aqua|炎族|Pyro|雷族|Thunder|植物族|Plant|昆虫族|Insect|爬虫类族|爬蟲類族|爬虫類族|Reptile|鱼族|魚族|Fish|海龙族|海龍族|海竜族|Sea Serpent|念动力族|念動力族|サイキック族|Psychic|幻龙族|幻龍族|幻竜族|Wyrm|电子界族|電子界族|サイバース族|Cyberse|幻想魔族|Illusion|天使族|Fairy|恐龙族|恐龍族|恐竜族|Dinosaur)/iu,
  )?.[1] || "";
}

function firstMatch(text, rules) {
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function cleanText(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").trim();
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
