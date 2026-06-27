const frameDefinitions = [
  define("copy_or_gain_effect", /复制.*效果|得到.*(?:卡名|效果)|获得.*(?:卡名|效果)|变成和.*效果相同|同じ(?:カード名|効果)|copy.*effect|gain.*(?:name|effect)/iu, ["monsterEffects", "spellTrapEffects"], ["复制或获得效果的来源与对象"]),
  define("copied_effect_scope", /复制.*(?:范围|哪些|文本)|得到.*(?:原本|相同).*效果|效果外文本|发动手续|copy.*scope/iu, ["monsterEffects", "spellTrapEffects", "otherText"], ["被复制的是效果处理还是发动手续"]),
  define("piercing_battle_damage", /贯穿|貫通|攻击力超过.*守备力.*战斗伤害|守備力を超えた.*戦闘ダメージ|piercing/iu, ["monsterEffects", "continuousText"], ["攻击怪兽、守备力与贯穿效果的适用主体"]),
  define("unaffected_by_effect", /不受.*效果影响|不受.*怪兽效果|効果を受けない|unaffected by.*effect/iu, ["monsterEffects", "continuousText"], ["抗性的来源、范围和当前适用状态"]),
  define("continuous_effect_application", /只要.*存在|适用中|持续适用|直到.*为止|这个回合.*怪兽|永续效果|continuous effect|while.*face-up/iu, ["continuousText", "monsterEffects", "spellTrapEffects"], ["效果由哪张卡产生并影响谁"]),
  define("activation_legality", /能否发动|可以发动|能发动吗|不能发动|発動できます|発動できません|can(?:not)? be activated|activate this effect/iu, ["conditionText", "monsterEffects", "spellTrapEffects"], ["发动时点、区域、条件与费用"]),
  define("effect_resolution", /效果处理|处理时|如何处理|处理后|适用这个效果|resolution|resolve/iu, ["monsterEffects", "spellTrapEffects"], ["处理开始时和处理中的卡片状态"]),
  define("battle_damage_calculation", /战斗伤害|伤害是多少|受到.*伤害|damage calculation|battle damage/iu, ["monsterEffects", "continuousText"], ["攻击力、守备力和所有伤害变更效果"]),
  define("atk_def_modification", /攻击力|守备力|攻撃力|守備力|ATK|DEF/iu, ["monsterEffects", "continuousText"], ["当前攻击力与守备力"]),
  define("simultaneous_processing", /同时|那之后|并且|然后|同一时点|simultaneous|then/iu, ["monsterEffects", "spellTrapEffects"], ["各段处理是否同时以及前段是否成功"]),
  define("damage_step_timing", /伤害步骤|伤害计算前|伤害计算后|ダメージステップ|ダメージ計算|damage step|damage calculation/iu, ["conditionText", "monsterEffects", "spellTrapEffects"], ["伤害步骤中的准确窗口"]),
  define("attack_target_legality", /直接攻击|攻击对象|只能攻击|攻击目标|attack directly|attack target/iu, ["monsterEffects", "continuousText"], ["可攻击对象与限制效果的控制者"]),
  define("pendulum_effect_scope", /灵摆效果|灵摆区域|P效果|P区域|ペンデュラム効果|pendulum effect/iu, ["pendulumEffects"], ["灵摆效果全文与灵摆区域状态"]),
  define("same_chain_cost_or_procedure", /同一连锁|C\s*\d|再次.*(?:展示|支付|作为费用)|cost|コスト|发动手续|activation procedure/iu, ["conditionText", "monsterEffects", "spellTrapEffects"], ["同一连锁中已执行的手续或费用"]),
  define("once_per_turn_scope", /1回合1次|１ターンに１度|一回合一次|once per turn|再次发动|再次.*展示/iu, ["monsterEffects", "spellTrapEffects", "conditionText"], ["限制绑定卡名、效果还是单张卡"]),
];

const forbiddenUnlessTriggered = [
  { id: "xyz_material_attach", pattern: /超量|Xyz|XYZ|素材|叠放|重叠/iu },
  { id: "defense_position_attack", pattern: /守备表示攻击|守備表示で攻撃|attack in defense position/iu },
  { id: "no_41_chain", pattern: /No\.?\s*41|编号41|泥睡魔兽|バグースカ/iu },
];

export function detectIssueFrames({ question = "", cardProfiles = [], cardTexts = [] } = {}) {
  const questionText = clean(question);
  const profileEntries = (cardProfiles || []).flatMap((profile) => (profile.effectIndex || []).map((entry) => ({
    text: entry.text,
    cardId: profile.cardId,
    section: entry.section,
  })));
  const externalEntries = (cardTexts || []).map((text) => ({ text: clean(text), cardId: undefined, section: "otherText" }));
  const sources = [{ text: questionText, source: "question_text" }, ...profileEntries.map((item) => ({ ...item, source: "card_text" })), ...externalEntries.map((item) => ({ ...item, source: "card_text" }))];
  const primaryIssueFrames = [];
  const secondaryIssueFrames = [];

  for (const definition of frameDefinitions) {
    const triggeredBy = [];
    for (const source of sources) {
      const match = definition.pattern.exec(source.text);
      definition.pattern.lastIndex = 0;
      if (!match) continue;
      triggeredBy.push({
        source: source.source,
        textSpan: match[0],
        ...(source.cardId ? { cardId: source.cardId } : {}),
      });
    }
    if (!triggeredBy.length) continue;
    const questionTriggered = triggeredBy.some((item) => item.source === "question_text");
    const frame = {
      id: definition.id,
      confidence: questionTriggered ? "high" : "medium",
      triggeredBy: dedupeTriggers(triggeredBy),
      requiredCardSections: definition.requiredCardSections,
      requiredFacts: definition.requiredFacts,
    };
    (questionTriggered ? primaryIssueFrames : secondaryIssueFrames).push(frame);
  }

  const rejectedIssueFrames = forbiddenUnlessTriggered
    .filter((item) => !item.pattern.test(questionText) && !profileEntries.some((entry) => item.pattern.test(entry.text)))
    .map((item) => ({ id: item.id, reason: "not_triggered_by_question_or_relevant_card_text" }));

  return {
    primaryIssueFrames: prioritizeFrames(primaryIssueFrames),
    secondaryIssueFrames: prioritizeFrames(secondaryIssueFrames),
    rejectedIssueFrames,
  };
}

export function issueFrameIds(result = {}) {
  return [...(result.primaryIssueFrames || []), ...(result.secondaryIssueFrames || [])].map((frame) => frame.id);
}

function define(id, pattern, requiredCardSections, requiredFacts) {
  return { id, pattern, requiredCardSections, requiredFacts };
}

function prioritizeFrames(frames) {
  const priority = new Map(frameDefinitions.map((item, index) => [item.id, index]));
  return frames.sort((left, right) => (priority.get(left.id) ?? 99) - (priority.get(right.id) ?? 99));
}

function dedupeTriggers(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.source}:${item.cardId || ""}:${item.textSpan}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].slice(0, 8);
}

function clean(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}
