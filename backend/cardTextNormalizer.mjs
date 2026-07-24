import { splitCardTextSections, tagEffectText } from "./cardTextSections.mjs";

export const CARD_TEXT_IR_VERSION = "1.0";

const ACTIVATION_MARKER = /(?:可以发动|才能发动|可发动|発動できる|発動する|you can activate|can be activated)/iu;
const CONTINUOUS_MARKER = /(?:只要|期间|持续|繼續|一直|限り|公開し続け|し続ける|must keep|while .*face-up|as long as)/iu;
const HAND_WORD = /(?:手牌|手卡|手札|hand)/iu;
const PUBLIC_WORD = /(?:公开|公開|展示|出示|给对方观看|給對方觀看|给对手看|相手に見せ|reveal|show)/iu;
const OPPONENT_WORD = /(?:对方|對方|对手|相手|opponent)/iu;
const CONTROLLER_WORD = /(?:自己|自身|自分|your|controller)/iu;
const BOTH_PLAYERS_WORD = /(?:双方|双方玩家|彼此|お互い|両方のプレイヤー|both players)/iu;

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
  const activationMatch = ACTIVATION_MARKER.exec(rawText);
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
  if (section === "summonConditions") return "summon_condition";
  if (activationIndex >= 0) return "activated";
  if (CONTINUOUS_MARKER.test(text) || /(?:不会|不能|不受|効果を受けない|instead|代わりに|作为代替)/iu.test(text)) {
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
  if (/(?:舍弃|丢弃|捨て|discard).{0,24}(?:手牌|手卡|手札|card)/iu.test(text)
    || /(?:手牌|手卡|手札).{0,24}(?:舍弃|丢弃|捨て|discard)/iu.test(text)) {
    costs.push({
      type: "discard_from_hand",
      actor: "controller",
      timing: "activation",
      text,
    });
  }
  if (/(?:解放|リリース|tribute)/iu.test(text)) {
    costs.push({ type: "tribute", actor: "controller", timing: "activation", text });
  }
  if (/(?:除外|banish)/iu.test(text)) {
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
  if (/(?:不受.{0,24}效果影响|効果を受けない|unaffected by)/iu.test(value)) {
    semantics.push({
      type: "effect_immunity",
      affected: "source",
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
  const fragments = cleanText(text)
    .split(/[，,；;。]+/u)
    .map(cleanText)
    .filter(Boolean);
  if (fragments.length < 2) return fragments.map((fragment) => ({ connector: firstConnector, text: fragment }));
  return fragments.map((fragment, index) => ({
    connector: index === 0 ? firstConnector : "THEN",
    text: fragment,
  }));
}

function classifyResolutionOperation(text) {
  const value = cleanText(text);
  const rules = [
    ["fusion_summon", /(?:融合召唤|融合召喚|fusion summon)/iu],
    ["special_summon", /(?:特殊召唤|特殊召喚|special summon)/iu],
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
  return { type, text: value };
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
