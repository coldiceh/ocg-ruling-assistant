export function classifyEvidenceQuestionTypes(input) {
  const text = normalizeEvidenceQuestionText(input);
  const questionTypes = new Set();
  const actions = new Set();
  const timing = new Set();
  const zones = new Set();
  const matchedPhrases = [];

  const addMatches = (patterns, target, value) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      target.add(value);
      matchedPhrases.push(match[0]);
    }
  };

  addMatches([
    /(?:発動できます|発動できません|发动条件|發動條件|発動条件|能否发动|可以发动|不能发动|can be activated|cannot be activated|can't be activated|activate this effect)/iu,
    /(?:can|cannot|can't).{0,18}activate/iu,
    /(?:发动|發動|発動).{0,12}(?:条件|でき|可以|不能|不可以)/iu,
  ], questionTypes, "activation_condition");

  addMatches([
    /(?:発動時|発動タイミング|发动时点|发动时机|诱发时点|誘発条件|activation timing|trigger timing)/iu,
  ], questionTypes, "activation_timing");

  addMatches([
    /(?:在哪里发动|哪里发动|墓地发动|场上发动|場上發動|除外状态发动|除外狀態發動|在墓地.{0,12}发动|在场上.{0,12}发动)/iu,
    /(?:(?:墓地|モンスターゾーン|除外状態|除外されている状態)で.{0,24}発動|発動.{0,24}(?:墓地|モンスターゾーン|除外状態))/iu,
    /(?:activated|activate).{0,32}(?:graveyard|monster zone|field|banished)|(?:graveyard|monster zone|field|banished).{0,32}(?:activated|activate)/iu,
  ], questionTypes, "activation_location");

  addMatches([
    /(?:ダメージステップ|ダメージ計算後|damage step|after damage calculation|伤害步骤|傷害步驟|伤害计算后|傷害計算後)/iu,
  ], questionTypes, "damage_step_activation");

  addMatches([
    /(?:除外できます|除外できません|一時的に除外|表側表示で除外|暂时除外|暫時除外|一时除外|一時除外|可以除外|不能除外|temporarily banish|banish)/iu,
  ], questionTypes, "temporary_banish");

  addMatches([
    /(?:除外できます|除外できません|可以除外|不能除外|can.{0,12}banish|cannot.{0,12}banish|can't.{0,12}banish)/iu,
  ], questionTypes, "banish_applicability");

  addMatches([
    /(?:適用できます|適用できません|この効果を適用|效果适用|效果適用|可以适用|可以適用|处理时|處理時|effect can be applied|apply this effect)/iu,
  ], questionTypes, "effect_applicability");

  addMatches([
    /(?:效果处理|效果處理|处理时|處理時|处理后|處理後|结算|結算|解決時|when resolving|when this effect resolves|effect resolution)/iu,
  ], questionTypes, "resolution_handling");

  addMatches([/(?:除外|banish)/iu], actions, "banish");
  addMatches([/(?:发动|發動|発動|activate)/iu], actions, "activate");
  addMatches([/(?:適用|适用|apply|applied)/iu], actions, "apply");
  addMatches([/(?:送墓|送去墓地|墓地へ送|sent to (?:the )?graveyard)/iu], actions, "send_to_graveyard");

  addMatches([/(?:ダメージステップ|damage step|伤害步骤|傷害步驟)/iu], timing, "damage_step");
  addMatches([/(?:ダメージ計算後|after damage calculation|伤害计算后|傷害計算後)/iu], timing, "after_damage_calculation");

  addMatches([/(?:墓地|graveyard|\bGY\b)/iu], zones, "graveyard");
  addMatches([/(?:モンスターゾーン|怪兽区|怪獸區|monster zone)/iu], zones, "monster_zone");
  addMatches([/(?:フィールド|场上|場上|field)/iu], zones, "field");
  addMatches([/(?:除外状態|除外状态|除外狀態|banished)/iu], zones, "banished");

  const polarity = detectEvidencePolarity(text);
  const confidence = matchedPhrases.length >= 2 ? "high" : matchedPhrases.length === 1 ? "medium" : "low";

  return {
    questionTypes: [...questionTypes],
    actions: [...actions],
    timing: [...timing],
    zones: [...zones],
    polarity,
    confidence,
    matchedPhrases: [...new Set(matchedPhrases)],
  };
}

export function normalizeEvidenceQuestionText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function detectEvidencePolarity(text) {
  if (/(?:できません|不能|不可以|cannot|can't|can not|not be activated|not be applied|not apply|cannot be activated|cannot be applied)/iu.test(text)) {
    return "cannot";
  }
  if (/(?:できます|できる|可以|能|can be activated|can be applied|can activate|can apply|can banish)/iu.test(text)) {
    return "can";
  }
  return "unknown";
}
