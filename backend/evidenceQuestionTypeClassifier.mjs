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

  addMatches([
    /(?:战斗|戰鬥|攻击|攻擊).{0,36}(?:如何处理|如何處理|怎么处理|怎麼處理|怎样处理|怎樣處理|是否继续|是否繼續|能否继续|能否繼續|战斗破坏|戰鬥破壞|伤害计算|傷害計算)/iu,
    /(?:能否|是否|可以|能不能|不能).{0,24}(?:战斗破坏|戰鬥破壞|继续攻击|繼續攻擊|进行伤害计算|進行傷害計算)/iu,
    /(?:由|被)?(?:战斗|戰鬥|戦闘|battle).{0,28}(?:破坏|破壞|破壊|destroy)|(?:破坏|破壞|破壊|destroy).{0,28}(?:战斗|戰鬥|戦闘|battle)/iu,
    /(?:这次|這次|该次|該次|此次|本次)(?:战斗|戰鬥|攻击|攻擊).{0,20}(?:是否|会否|會否|会不会|會不會)?(?:结束|結束)/iu,
    /(?:戦闘|攻撃).{0,28}(?:どうな|続行|破壊)|(?:この|その|当該)(?:戦闘|攻撃).{0,20}終了|戦闘で破壊されますか|ダメージ計算.{0,18}(?:行い|行われ|しません)/iu,
    /(?:what happens to|how is).{0,24}(?:battle|attack)|(?:battle|attack).{0,36}(?:continue|destroyed|damage calculation)|(?:does|will|would|can)\s+(?:(?:the|this|that)\s+)?(?:battle|attack).{0,16}(?:end|continue)/iu,
  ], questionTypes, "battle_resolution");

  addMatches([
    /(?:里侧|裡側|裏側|face[- ]?down).{0,24}(?:守备|守備|defen[cs]e).{0,44}(?:被攻击|被攻擊|攻击|攻擊|攻撃され|attacked)/iu,
    /(?:攻击|攻擊|攻撃|attack).{0,44}(?:里侧|裡側|裏側|face[- ]?down).{0,24}(?:守备|守備|defen[cs]e)/iu,
    /(?:伤害计算前|傷害計算前|ダメージ計算前|before damage calculation).{0,32}(?:翻开|翻開|反转|反轉|リバース|表侧|表側|flip)/iu,
  ], questionTypes, "face_down_flip_before_damage_calculation");

  addMatches([
    /(?:攻击怪兽|攻擊怪獸|攻撃モンスター|attacking monster).{0,36}(?:变成|變成|成为|成為|変更|change).{0,20}(?:守备|守備|defen[cs]e).{0,32}(?:继续|繼續|続行|終了|continue|end)/iu,
    /(?:表示形式|表示形態|战斗表示形式|戰鬥表示形式|battle position).{0,36}(?:改变|改變|変更|change).{0,36}(?:攻击|攻擊|攻撃|attack).{0,20}(?:继续|繼續|続行|終了|continue|end)/iu,
  ], questionTypes, "attack_continuation_after_position_change");

  addMatches([
    /(?:翻开|翻開|反转|反轉|リバース|flip).{0,36}(?:永续效果|永續效果|持续效果|持續效果|永続効果|continuous effect).{0,24}(?:适用|適用|重算|重新检查|重新檢查|apply|recheck)/iu,
    /(?:永续效果|永續效果|持续效果|持續效果|永続効果|continuous effect).{0,36}(?:翻开|翻開|反转|反轉|リバース|flip|状态变化|狀態變化|state change).{0,24}(?:适用|適用|重算|apply|recheck)/iu,
  ], questionTypes, "continuous_effect_recheck");

  addMatches([
    /(?:发动的效果|發動的效果|発動した効果|activated effects?).{0,44}(?:永续效果|永續效果|持续效果|持續效果|永続効果|continuous effects?)/iu,
    /(?:永续效果|永續效果|持续效果|持續效果|永続効果|continuous effects?).{0,44}(?:发动的效果|發動的效果|発動した効果|activated effects?)/iu,
  ], questionTypes, "activated_vs_continuous_effect");

  addMatches([/(?:除外|banish)/iu], actions, "banish");
  addMatches([/(?:发动|發動|発動|activate)/iu], actions, "activate");
  addMatches([/(?:適用|适用|apply|applied)/iu], actions, "apply");
  addMatches([/(?:送墓|送去墓地|墓地へ送|sent to (?:the )?graveyard)/iu], actions, "send_to_graveyard");
  addMatches([/(?:攻击|攻擊|攻撃|attack)/iu], actions, "attack");
  addMatches([/(?:战斗破坏|戰鬥破壞|戦闘で破壊|destroyed by battle)/iu], actions, "battle_destroy");
  addMatches([/(?:表示形式|表示形態|战斗表示形式|戰鬥表示形式|battle position)/iu], actions, "change_position");
  addMatches([/(?:翻开|翻開|反转|反轉|リバース|flip face[- ]?up)/iu], actions, "flip_face_up");

  addMatches([/(?:ダメージステップ|damage step|伤害步骤|傷害步驟)/iu], timing, "damage_step");
  addMatches([/(?:ダメージ計算後|after damage calculation|伤害计算后|傷害計算後)/iu], timing, "after_damage_calculation");
  addMatches([/(?:ダメージステップ開始時|伤害步骤开始时|傷害步驟開始時|start of (?:the )?damage step)/iu], timing, "start_of_damage_step");
  addMatches([/(?:ダメージ計算前|伤害计算前|傷害計算前|before damage calculation)/iu], timing, "before_damage_calculation");
  addMatches([/(?:ダメージ計算|伤害计算|傷害計算|damage calculation)/iu], timing, "damage_calculation");

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

export function classifyMultiEntityDecisionScope(value) {
  const text = String(value || "").normalize("NFKC");
  const multiBranch = /(?:两|兩|二|三|四|数|數|多)(?:只|张|張|个|個)?(?:怪兽|怪獸|卡片?|モンスター|カード).{0,36}(?:分别|分別|各自|逐一)/iu.test(text)
    || /(?:分别|分別|逐一)(?:用|以|让|讓|由)?[^，,。.!！?？;；\n]{0,48}(?:怪兽|怪獸|卡片?|モンスター|カード)/iu.test(text)
    || /(?:怪兽|怪獸|卡片?|モンスター|カード).{0,36}各自(?:能否|是否|可以|怎样|怎樣|如何|どう|でき)/iu.test(text)
    || /(?:それぞれ|各々)(?:の)?[^、。\n]{0,36}(?:モンスター|カード).{0,36}(?:どう|でき|場合)/iu.test(text)
    || /(?:each of (?:these|the)|the following|these)\s+(?:cards?|monsters?).{0,48}(?:can|whether|what happens|respectively)|(?:cards?|monsters?).{0,48}\brespectively\b/iu.test(text);
  return {
    schema: "multi-entity-decision-scope/v1",
    multiBranch,
    requiresPerEntityCoverage: multiBranch,
  };
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
