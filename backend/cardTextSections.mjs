const numberedEffectPattern = /(?:^|\n)\s*([①②③④⑤⑥⑦⑧⑨⑩]|\(?\d{1,2}\)?[.:：])\s*/gu;

export function splitCardTextSections(card = {}) {
  const cardType = String(card.cardType || card.type || "unknown").toLowerCase();
  const explicitPendulum = firstText(card.pendulumEffects, card.pendulumEffectText, card.pendulumEffect, card.pendulumText);
  const explicitMonster = firstText(card.monsterEffects, card.monsterEffectText, card.monsterEffect, card.monsterText);
  const explicitSpellTrap = firstText(card.spellTrapEffects, card.spellTrapEffectText);
  const combined = cleanText(card.effectText || card.text || card.description || "");
  const marked = splitMarkedPendulumText(combined);
  const isPendulum = Boolean(
    card.isPendulum
    || card.pendulumScale != null
    || /pendulum|灵摆|靈擺|ペンデュラム|\bP怪兽\b|\bPモンスター\b/iu.test(cardType)
    || explicitPendulum
    || marked.pendulum
  );
  const pendulumText = cleanText(explicitPendulum || marked.pendulum);
  const mainText = cleanText(explicitMonster || marked.monster || combined);
  const sections = {
    monsterEffects: [],
    pendulumEffects: [],
    spellTrapEffects: [],
    summonConditions: [],
    continuousText: [],
    conditionText: [],
    otherText: [],
  };

  if (pendulumText) sections.pendulumEffects = splitEffectParagraphs(pendulumText);
  if (/spell|trap|魔法|陷阱|罠/iu.test(cardType)) {
    sections.spellTrapEffects = splitEffectParagraphs(explicitSpellTrap || mainText);
  } else {
    const classified = classifyMonsterText(mainText);
    sections.monsterEffects = classified.effects;
    sections.summonConditions = classified.summonConditions;
    sections.otherText.push(...classified.otherText);
  }

  const allEffects = [
    ...sections.monsterEffects,
    ...sections.pendulumEffects,
    ...sections.spellTrapEffects,
  ];
  sections.continuousText = allEffects.filter((text) => isContinuousText(text));
  sections.conditionText = allEffects.filter((text) => isConditionText(text));
  sections.otherText = dedupe(sections.otherText);

  const missingSections = [];
  if (isPendulum && !sections.pendulumEffects.length) missingSections.push("pendulumEffects");
  if (!/spell|trap|魔法|陷阱|罠/iu.test(cardType) && !sections.monsterEffects.length) missingSections.push("monsterEffects");
  if (/spell|trap|魔法|陷阱|罠/iu.test(cardType) && !sections.spellTrapEffects.length) missingSections.push("spellTrapEffects");

  return {
    isPendulum,
    sections,
    effectIndex: buildEffectIndex(sections),
    missingSections,
  };
}

export function buildEffectIndex(sections = {}) {
  const index = [];
  for (const section of ["pendulumEffects", "monsterEffects", "spellTrapEffects", "summonConditions", "continuousText", "conditionText", "otherText"]) {
    for (const text of sections[section] || []) {
      index.push({
        effectNo: extractEffectNo(text),
        section,
        text,
        tags: tagEffectText(text),
      });
    }
  }
  return dedupeObjects(index, (item) => `${item.section}:${item.effectNo}:${item.text}`);
}

export function tagEffectText(text) {
  const value = cleanText(text);
  const tags = [];
  const rules = [
    ["activation", /发动|発動|activate/iu],
    ["copy_or_gain_effect", /得到.*(?:卡名|效果)|获得.*(?:卡名|效果)|复制.*效果|同じ効果|gain.*effect|copy.*effect/iu],
    ["piercing_battle_damage", /贯穿|貫通|守备力.*战斗伤害|守備力.*戦闘ダメージ|piercing/iu],
    ["unaffected_by_effect", /不受.*效果影响|効果を受けない|unaffected by/iu],
    ["continuous", /只要|期间|適用|上升|下降|不受|不能|不会|while.*face-up/iu],
    ["battle", /攻击|守备|战斗伤害|ダメージ|battle|attack/iu],
    ["damage_step", /伤害步骤|伤害计算|ダメージステップ|ダメージ計算|damage step|damage calculation/iu],
    ["once_per_turn", /1回合1次|１ターンに１度|once per turn/iu],
    ["pendulum", /灵摆|靈擺|ペンデュラム|pendulum/iu],
  ];
  for (const [tag, pattern] of rules) if (pattern.test(value)) tags.push(tag);
  return tags;
}

function classifyMonsterText(text) {
  const paragraphs = splitEffectParagraphs(text);
  const effects = [];
  const summonConditions = [];
  const otherText = [];
  for (const paragraph of paragraphs) {
    if (isSummonCondition(paragraph)) summonConditions.push(paragraph);
    else if (extractEffectNo(paragraph) !== "unknown" || /发动|适用|不受|攻击|效果|贯穿|貫通|战斗伤害|戦闘ダメージ|発動|効果|activate|effect|battle damage|piercing/iu.test(paragraph)) effects.push(paragraph);
    else otherText.push(paragraph);
  }
  return { effects, summonConditions, otherText };
}

function splitEffectParagraphs(text) {
  const value = cleanText(text);
  if (!value) return [];
  const matches = [...value.matchAll(numberedEffectPattern)];
  if (!matches.length) return value.split(/\n+/u).map(cleanText).filter(Boolean);
  const result = [];
  if (matches[0].index > 0) result.push(cleanText(value.slice(0, matches[0].index)));
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + (matches[index][0].startsWith("\n") ? 1 : 0);
    const end = matches[index + 1]?.index ?? value.length;
    result.push(cleanText(value.slice(start, end)));
  }
  return result.filter(Boolean);
}

function splitMarkedPendulumText(text) {
  const value = cleanText(text);
  const marker = /(?:【(?:灵摆|靈擺|P|Pendulum|ペンデュラム)(?:效果|効果| Effect)?】|\[(?:灵摆|靈擺|P|Pendulum|ペンデュラム)(?:效果|効果| Effect)?\]|(?:^|\n)\s*(?:灵摆效果|靈擺效果|P效果|P効果|Pendulum Effect|ペンデュラム効果)\s*[:：]?)/iu;
  const monsterMarker = /(?:【|\[)?(?:怪兽|怪獸|Monster)(?:效果|効果| Effect)?(?:】|\])?\s*[:：]?/iu;
  const pendulumMatch = marker.exec(value);
  if (!pendulumMatch) return { pendulum: "", monster: value };
  const afterPendulum = pendulumMatch.index + pendulumMatch[0].length;
  const rest = value.slice(afterPendulum);
  const monsterMatch = monsterMarker.exec(rest);
  if (!monsterMatch) return { pendulum: rest, monster: "" };
  return {
    pendulum: rest.slice(0, monsterMatch.index),
    monster: rest.slice(monsterMatch.index + monsterMatch[0].length),
  };
}

function extractEffectNo(text) {
  const match = cleanText(text).match(/^\s*([①②③④⑤⑥⑦⑧⑨⑩]|\(?\d{1,2}\)?)[.:：]?/u);
  return match ? match[1] : "unknown";
}

function isSummonCondition(text) {
  return /(?:怪兽|モンスター).*[×＋+]|仅可.*特殊召唤|只能.*召唤|特殊召唤.*方法|must.*summon|can only be.*summon/iu.test(text);
}

function isContinuousText(text) {
  return /只要|期间|不受.*效果|不会被|不能|攻击力.*(?:上升|下降)|守备力.*(?:上升|下降)|効果を受けない|while.*face-up|unaffected by/iu.test(text);
}

function isConditionText(text) {
  return /场合.*发动|时.*发动|才能发动|場合.*発動|時.*発動|if .*activate|when .*activate/iu.test(text);
}

function firstText(...values) {
  for (const value of values.flat()) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function cleanText(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").trim();
}

function dedupe(items) {
  return [...new Set(items.map(cleanText).filter(Boolean))];
}

function dedupeObjects(items, keyFn) {
  const map = new Map();
  for (const item of items) if (!map.has(keyFn(item))) map.set(keyFn(item), item);
  return [...map.values()];
}
