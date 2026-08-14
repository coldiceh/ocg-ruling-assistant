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
    /(?:(?:处理|處理|结算|結算)(?:结果|結果)?(?:会|會|将会|將會)?(?:怎样|怎樣|如何|怎么|怎麼)|(?:怎样|怎樣|如何|怎么|怎麼)(?:处理|處理|结算|結算))/iu,
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
  addMatches([/(?:手卡|手牌|手札|\bhand\b)/iu], zones, "hand");
  addMatches([/(?:卡组|牌组|卡組|牌組|デッキ|\bdeck\b)/iu], zones, "deck");
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
  const decisionQuestionCount = splitDecisionQuestionSentences(text)
    .filter((question) => isDecisionQuestionSentence(question))
    .length;
  const explicitLabelCount = (text.match(/(?:^|\n)\s*(?:\([A-ZＡ-Ｚ]\)|（[A-ZＡ-Ｚ]）)/gu) || []).length;
  const hierarchicalFollowUp = /(?:如果|若|假如|倘若|if).{0,120}(?:之后|以后|随后|那么|则|then|after(?:wards)?)/isu.test(text)
    && decisionQuestionCount >= 2;
  const multiEntity = /(?:两|兩|二|三|四|数|數|多)(?:只|张|張|个|個)?(?:怪兽|怪獸|卡片?|モンスター|カード).{0,36}(?:分别|分別|各自|逐一)/iu.test(text)
    || /(?:分别|分別|逐一)(?:用|以|让|讓|由)?[^，,。.!！?？;；\n]{0,48}(?:怪兽|怪獸|卡片?|モンスター|カード)/iu.test(text)
    || /(?:怪兽|怪獸|卡片?|モンスター|カード).{0,36}各自(?:能否|是否|可以|怎样|怎樣|如何|どう|でき)/iu.test(text)
    || /(?:それぞれ|各々)(?:の)?[^、。\n]{0,36}(?:モンスター|カード).{0,36}(?:どう|でき|場合)/iu.test(text)
    || /(?:each of (?:these|the)|the following|these)\s+(?:cards?|monsters?).{0,48}(?:can|whether|what happens|respectively)|(?:cards?|monsters?).{0,48}\brespectively\b/iu.test(text);
  const multiDecision = explicitLabelCount >= 2
    || decisionQuestionCount >= 2
    || hierarchicalFollowUp;
  const multiBranch = multiEntity || multiDecision;
  return {
    schema: "multi-entity-decision-scope/v1",
    multiBranch,
    multiDecision,
    multiEntity,
    requiresPerEntityCoverage: multiEntity,
  };
}

const REQUESTED_TARGET_DEFINITIONS = Object.freeze([
  Object.freeze({
    stage: "activation_legality",
    operation: "activate",
    patterns: Object.freeze([
      /(?:能否|是否(?:可以|能)?|可否|能不能|可不可以).{0,14}(?:发动|發動)/iu,
      /(?:可以|能否|是否(?:可以|能)?|可否|能不能|可不可以).{0,24}(?:直接)?(?:连锁|連鎖)?(?:发动|發動)[^。.!！?？;；\n]{0,72}(?:吗|嗎|么|？|\?)/iu,
      /(?:发动|發動)(?:这张卡|這張卡|此卡|该卡|該卡|这个效果|這個效果)?(?:吗|嗎|么|能否|是否可以|是否能|可以吗|可以嗎)/iu,
      /発動(?:する(?:事|こと)は)?(?:できますか|できませんか|できるでしょうか|可能ですか)/iu,
      /(?:can|could|may|cannot|can't).{0,32}\bactivat(?:e|ed)\b/iu,
    ]),
  }),
  Object.freeze({
    stage: "resolution_handling",
    operation: "resolve_effect",
    patterns: Object.freeze([
      /(?:处理|處理|结算|結算)(?:时|時|中|过程中|過程中)?(?:如何|怎么|怎麼|怎样|怎樣|是否(?:进行|進行|适用|適用|继续|繼續|生效)|能否(?:进行|進行|适用|適用|继续|繼續))/iu,
      /(?:如何|怎么|怎麼|怎样|怎樣).{0,16}(?:处理|處理|结算|結算|进行|進行)/iu,
      /(?:処理|解決)(?:を|は|が|時に|中に).{0,16}(?:行うことはできますか|できますか|できませんか|行いますか|どうな|どのように)/iu,
      /(?:what happens|how.{0,24}(?:resolve|resolution)|when.{0,24}(?:resolves|resolving))/iu,
    ]),
  }),
]);

const FACT_OPERATION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "activate", pattern: /发动|發動|発動|\bactivat(?:e|ed|ing)\b/iu }),
  Object.freeze({ id: "special_summon", pattern: /特殊召唤|特殊召喚|特殊召喚|special summon/iu }),
  Object.freeze({ id: "normal_summon", pattern: /通常召唤|通常召喚|normal summon/iu }),
  Object.freeze({ id: "destroy", pattern: /破坏|破壞|破壊|destroy/iu }),
  Object.freeze({ id: "banish", pattern: /除外|banish/iu }),
  Object.freeze({ id: "send_to_graveyard", pattern: /送(?:去|入)?墓地|墓地へ送|send.{0,12}graveyard/iu }),
  Object.freeze({ id: "add_to_hand", pattern: /加入手(?:卡|牌)|手札に加|add.{0,12}(?:hand)/iu }),
  Object.freeze({ id: "draw", pattern: /抽(?:卡|牌)|ドロー|\bdraw\b/iu }),
]);

const FACT_SCOPE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "both_players", pattern: /双方|雙方|彼此|お互い|both players|each player|neither player/iu }),
  Object.freeze({ id: "opponent", pattern: /对方|對方|对手|對手|相手|opponent/iu }),
  Object.freeze({ id: "self", pattern: /自己|自身|我方|自分|\byou\b|yourself/iu }),
]);

const ACTIVATION_SOURCE_ZONE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "hand",
    patterns: Object.freeze([
      /(?:这张卡|這張卡|该卡|該卡|此卡)?(?:从|從|自|在)(?:自己|自身|对方|對方|对手|對手)?(?:的)?(?:手卡|手牌).{0,28}(?:发动|發動)/iu,
      /(?:手札から|手札で).{0,32}発動/iu,
      /(?:activat(?:e|ed|ing)).{0,24}(?:from|in)(?: the)? hand|(?:from|in)(?: the)? hand.{0,24}activat(?:e|ed|ing)/iu,
    ]),
  }),
  Object.freeze({
    id: "graveyard",
    patterns: Object.freeze([
      /(?:这张卡|這張卡|该卡|該卡|此卡)(?:在|从|從)墓地.{0,28}(?:发动|發動)|(?:从|從|在)墓地.{0,28}(?:发动|發動)/iu,
      /(?:墓地から|墓地で).{0,32}発動/iu,
      /(?:activat(?:e|ed|ing)).{0,24}(?:from|in)(?: the)? graveyard|(?:from|in)(?: the)? graveyard.{0,24}activat(?:e|ed|ing)/iu,
    ]),
  }),
  Object.freeze({
    id: "banished",
    patterns: Object.freeze([
      /(?:这张卡|這張卡|该卡|該卡|此卡)(?:在|从|從)?(?:除外状态|除外狀態).{0,28}(?:发动|發動)|(?:在|从|從)(?:除外状态|除外狀態).{0,28}(?:发动|發動)/iu,
      /(?:除外状態から|除外状態で|除外されている状態で).{0,32}発動/iu,
      /(?:activat(?:e|ed|ing)).{0,24}(?:while|from|in).{0,8}banished|(?:while|from|in).{0,8}banished.{0,24}activat(?:e|ed|ing)/iu,
    ]),
  }),
  Object.freeze({
    id: "field",
    patterns: Object.freeze([
      /(?:这张卡|這張卡|该卡|該卡|此卡)(?:在|从|從)(?:场上|場上|怪兽区域|怪獸區域).{0,28}(?:发动|發動)/iu,
      /(?:このカード|そのカード|当該カード).{0,24}(?:フィールド|モンスターゾーン)(?:から|で).{0,24}発動/iu,
      /(?:this|that) card.{0,24}(?:on|from|in)(?: the)? (?:field|monster zone).{0,24}activat(?:e|ed|ing)|activat(?:e|ed|ing).{0,24}(?:this|that) card.{0,24}(?:on|from|in)(?: the)? (?:field|monster zone)/iu,
    ]),
  }),
]);

/**
 * Extracts decision-stage and scenario-premise families from a question.
 *
 * These are comparison labels only.  They never decide a ruling.  In
 * particular, a player being prohibited from performing an action is not the
 * same premise as the relevant candidate set being empty.
 */
export function classifyEvidenceScenarioPremises(value) {
  const text = normalizeEvidenceQuestionText(value);
  const requestedTargets = extractRequestedTargets(text);
  const scenarioFacts = dedupeFrames(
    [...extractScenarioFacts(text), ...extractContextFacts(text)],
    (fact) => `${fact.operation}:${fact.dimension}:${fact.state}:${fact.scope}`,
  );
  const premises = [
    ...requestedTargets.map((target) => `target:${target.stage}:${target.operation}`),
    ...scenarioFacts.map((fact) => (
      `fact:${fact.operation}:${fact.dimension}:${fact.state}:${fact.scope}`
    )),
  ];
  return {
    schema: "evidence-applicability-frame/v2",
    requestedTargets,
    scenarioFacts,
    premises: [...new Set(premises)],
    matchedPhrases: [...new Set([
      ...requestedTargets.map((target) => target.text),
      ...scenarioFacts.map((fact) => fact.text),
    ])],
  };
}

export function compareEvidenceScenarioPremises(queryValue, evidenceValue) {
  const query = typeof queryValue === "string"
    ? classifyEvidenceScenarioPremises(queryValue)
    : queryValue || classifyEvidenceScenarioPremises("");
  const evidence = typeof evidenceValue === "string"
    ? classifyEvidenceScenarioPremises(evidenceValue)
    : evidenceValue || classifyEvidenceScenarioPremises("");
  const targetComparison = compareRequestedTargets(
    query.requestedTargets || [],
    evidence.requestedTargets || [],
  );
  const factComparison = compareScenarioFacts(
    query.scenarioFacts || [],
    evidence.scenarioFacts || [],
  );
  const conflicts = [...targetComparison.conflicts, ...factComparison.conflicts];
  const querySet = new Set(query.premises || []);
  const evidenceSet = new Set(evidence.premises || []);
  const queryOnlyPremises = [...querySet].filter((premise) => !evidenceSet.has(premise));
  const evidenceOnlyPremises = [...evidenceSet].filter((premise) => !querySet.has(premise));
  const hasAnyFrame = querySet.size > 0 || evidenceSet.size > 0;
  const compatibility = conflicts.length
    ? "mismatch"
    : targetComparison.missingQueryTargets.length || factComparison.missingQueryFacts.length
      ? "partial"
      : factComparison.extraEvidenceFacts.length
      ? "conditional"
      : hasAnyFrame
        ? "compatible"
        : "unknown";
  return {
    schema: "evidence-applicability-comparison/v2",
    compatibility,
    conflicts,
    queryPremises: [...querySet],
    evidencePremises: [...evidenceSet],
    queryOnlyPremises,
    evidenceOnlyPremises,
    queryFrame: query,
    evidenceFrame: evidence,
    targetCoverage: targetComparison,
    factCoverage: factComparison,
  };
}

function extractRequestedTargets(text) {
  if (classifyEvidenceQuestionTypes(text).questionTypes.includes("battle_resolution")) return [];
  const targets = [];
  for (const definition of REQUESTED_TARGET_DEFINITIONS) {
    for (const pattern of definition.patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      targets.push({
        stage: definition.stage,
        operation: definition.operation,
        span: [match.index, match.index + match[0].length],
        text: match[0],
        confidence: "high",
      });
      break;
    }
  }
  for (const clause of splitApplicabilityClauses(text)) {
    if (!isLegalityQuestionClause(clause.text)) continue;
    if (targets.some((target) => (
      target.stage === "resolution_handling"
      && spansOverlap(target.span, [clause.offset, clause.offset + clause.text.length])
    ))) continue;
    if (targets.some((target) => (
      target.operation === "activate"
      && spansOverlap(target.span, [clause.offset, clause.offset + clause.text.length])
    ))) continue;
    for (const operation of FACT_OPERATION_DEFINITIONS) {
      if (operation.id === "activate" || !operation.pattern.test(clause.text)) continue;
      targets.push({
        stage: "action_legality",
        operation: operation.id,
        span: [clause.offset, clause.offset + clause.text.length],
        text: clause.text,
        confidence: "high",
      });
    }
  }
  return dedupeFrames(targets, (target) => `${target.stage}:${target.operation}`);
}

function extractScenarioFacts(text) {
  const facts = [];
  for (const clause of splitApplicabilityClauses(text)) {
    const scope = detectFactScope(clause.text);
    const operandAbsence = matchOperandAbsence(clause.text);
    const zoneCapacity = matchZoneCapacity(clause.text);
    const costPayability = matchCostPayability(clause.text);
    const permissionProhibition = matchActorPermissionProhibition(clause.text, {
      operandAbsence: Boolean(operandAbsence),
    });
    if (permissionProhibition) {
      for (const operation of operationsForScenarioFact(permissionProhibition, {
        dimension: "actor_permission", clause, fullText: text,
      })) {
        facts.push(buildScenarioFact({
          operation: operation.id,
          dimension: "actor_permission",
          state: "prohibited",
          scope,
          clause,
          match: permissionProhibition,
        }));
      }
    }
    if (operandAbsence) {
      for (const operation of operationsForScenarioFact(operandAbsence, {
        dimension: "operand_availability", clause, fullText: text,
      })) {
        facts.push(buildScenarioFact({
          operation: operation.id,
          dimension: "operand_availability",
          state: "absent",
          scope,
          clause,
          match: operandAbsence,
        }));
      }
    }
    if (zoneCapacity) {
      for (const operation of operationsForScenarioFact(zoneCapacity, {
        dimension: "zone_capacity", clause, fullText: text,
      })) {
        facts.push(buildScenarioFact({
          operation: operation.id,
          dimension: "zone_capacity",
          state: "unavailable",
          scope,
          clause,
          match: zoneCapacity,
        }));
      }
    }
    if (costPayability) {
      for (const operation of operationsForScenarioFact(costPayability, {
        dimension: "cost_payability", clause, fullText: text,
      })) {
        facts.push(buildScenarioFact({
          operation: operation.id,
          dimension: "cost_payability",
          state: "unpayable",
          scope,
          clause,
          match: costPayability,
        }));
      }
    }
  }
  return dedupeFrames(
    facts,
    (fact) => `${fact.operation}:${fact.dimension}:${fact.state}:${fact.scope}`,
  );
}

function extractContextFacts(text) {
  const features = classifyEvidenceQuestionTypes(text);
  const zoneStates = extractActivationSourceZones(text);
  return [
    ...zoneStates.map((state) => ({
      operation: "question_context",
      dimension: "zone_context",
      state,
      scope: "unspecified",
      span: [0, text.length],
      text: state,
      confidence: "high",
    })),
    ...(features.timing || []).map((state) => ({
      operation: "question_context",
      dimension: "timing_context",
      state,
      scope: "unspecified",
      span: [0, text.length],
      text: state,
      confidence: "high",
    })),
  ];
}

function extractActivationSourceZones(text) {
  const scenarioText = maskQuotedEffectDescriptions(text);
  return ACTIVATION_SOURCE_ZONE_DEFINITIONS
    .filter((definition) => definition.patterns.some((pattern) => pattern.test(scenarioText)))
    .map((definition) => definition.id);
}

function maskQuotedEffectDescriptions(text) {
  return String(text || "").replace(/『[^』]*』/gu, " ");
}

function splitApplicabilityClauses(text) {
  const clauses = [];
  const pattern = /[^，,、。.!！?？;；\n]+[，,、。.!！?？;；\n]?/gu;
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim();
    if (!value) continue;
    clauses.push({ text: value, offset: match.index });
  }
  return clauses;
}

function splitDecisionQuestionSentences(text) {
  return [...String(text || "").matchAll(/[^?？]*(?:[?？]|$)/gu)]
    .map((match) => match[0].trim())
    .filter((value) => value.length >= 4 && /[?？]$/u.test(value));
}

function isDecisionQuestionSentence(text) {
  if (isLegalityQuestionClause(text)) return true;
  return /(?:可以|能).{0,48}(?:发动|發動|召唤|召喚|特殊召唤|特殊召喚|适用|適用|处理|處理)(?:哪些|什么|什麼|何种|何種|吗|嗎)/iu.test(text)
    || /(?:连锁|連鎖|处理|處理|结算|結算|チェーン|処理).{0,32}(?:如何|怎么|怎麼|怎样|怎樣|どのよう|どう|how|what happens)/iu.test(text)
    || /(?:如何|怎么|怎麼|怎样|怎樣|どのよう|どう|how|what happens).{0,32}(?:组成|組成|构成|構成|形成|处理|處理|结算|結算)?(?:连锁|連鎖|チェーン|chain)/iu.test(text);
}

function detectFactScope(text) {
  return FACT_SCOPE_DEFINITIONS.find((definition) => definition.pattern.test(text))?.id || "unspecified";
}

function matchActorPermissionProhibition(text, { operandAbsence = false } = {}) {
  if (/(?:不能|无法|無法|できない|cannot).{0,10}(?:特殊召唤|特殊召喚|特殊召喚|special summon).{0,4}(?:的|できない)?(?:怪兽|怪獸|モンスター|cards?).{0,16}(?:不存在|没有|沒有|いない|does not exist)/iu.test(text)) {
    return null;
  }
  if (operandAbsence && /(?:不能|无法|無法|できない|cannot).{0,10}(?:特殊召唤|特殊召喚|特殊召喚|special summon).{0,4}(?:的|できない)?(?:怪兽|怪獸|モンスター|cards?)/iu.test(text)) {
    return null;
  }
  return [
    /(?:双方|雙方|彼此|自己|自身|我方|对方|對方|对手|對手|玩家).{0,32}(?:不能|不可|不可以|无法|無法|禁止).{0,16}(?:进行|進行)?(?:怪兽|怪獸)?(?:特殊召唤|特殊召喚)/iu,
    /(?:双方|雙方|彼此|自己|自身|我方|对方|對方|对手|對手|玩家).{0,40}(?:特殊召唤|特殊召喚)(?!的?(?:怪兽|怪獸)).{0,12}(?:不能|不可|不可以|无法|無法|禁止)/iu,
    /(?:お互い|自分|相手|プレイヤー).{0,40}(?:特殊召喚)(?!できないモンスター).{0,16}(?:できない|行えない|禁止)/iu,
    /(?:both players?|each player|you|your opponent|a player).{0,40}(?:cannot|can't|may not|is prohibited from).{0,16}special summon/iu,
    /neither player.{0,24}(?:can|may).{0,12}special summon/iu,
  ].map((pattern) => text.match(pattern)).find(Boolean) || null;
}

function matchOperandAbsence(text) {
  const match = [
    /(?:没有|沒有|不存在|均无|均無|都没有|都沒有|找不到).{0,72}(?<!不)(?:能够|能|可以|可|适合|適合)(?:被[^，,、。.!！?？;；\n]{0,36})?(?:特殊召唤|特殊召喚).{0,18}(?:的)?(?:怪兽|怪獸|卡片?)/iu,
    /(?<!不)(?:能够|能|可以|可)(?:被[^，,、。.!！?？;；\n]{0,36})?(?:特殊召唤|特殊召喚).{0,18}(?:的)?(?:怪兽|怪獸|卡片?).{0,32}(?:没有|沒有|不存在|均无|均無|都不存在)/iu,
    /(?:特殊召喚可能|特殊召喚できる).{0,40}(?:モンスター|カード).{0,24}(?:存在しない|いない)/iu,
    /(?:no|without any).{0,32}(?:eligible|valid|that can be).{0,24}(?:special summoned|special summon)/iu,
  ].map((pattern) => text.match(pattern)).find(Boolean) || null;
  if (!match) return null;
  const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
  if (/^(?:的)?(?:区域|區域|ゾーン|zone)/iu.test(tail)) return null;
  return match;
}

function matchZoneCapacity(text) {
  return [
    /(?:没有|沒有|不存在|无|無).{0,20}(?:可用|空闲|空閒|空置).{0,12}(?:区域|區域|怪兽区|怪獸區)/iu,
    /(?:使用可能|空いている).{0,16}(?:ゾーン).{0,16}(?:存在しない|ない)/iu,
    /(?:no|without).{0,16}(?:available|open|free).{0,12}(?:zone|monster zone)/iu,
  ].map((pattern) => text.match(pattern)).find(Boolean) || null;
}

function matchCostPayability(text) {
  return [
    /(?:没有|沒有|不足|无法|無法|不能).{0,24}(?:支付|払う).{0,16}(?:cost|代价|代價|lp|生命值|基本分)/iu,
    /(?:cost|代价|代價).{0,16}(?:无法|無法|不能|支付不了|払えない)/iu,
    /(?:cost|代价|代價).{0,8}(?:无法|無法|不能).{0,8}(?:支付|払|pay)/iu,
    /(?:cannot|can't|unable to).{0,16}(?:pay|afford).{0,12}(?:the )?cost/iu,
  ].map((pattern) => text.match(pattern)).find(Boolean) || null;
}

function buildScenarioFact({ operation, dimension, state, scope, clause, match }) {
  return {
    operation,
    dimension,
    state,
    scope,
    span: [clause.offset + match.index, clause.offset + match.index + match[0].length],
    text: match[0],
    confidence: "high",
  };
}

function compareRequestedTargets(queryTargets, evidenceTargets) {
  const evidenceKeys = new Set(evidenceTargets.map(targetKey));
  const queryKeys = new Set(queryTargets.map(targetKey));
  const missingQueryTargets = queryTargets.filter((target) => !evidenceKeys.has(targetKey(target)));
  const extraEvidenceTargets = evidenceTargets.filter((target) => !queryKeys.has(targetKey(target)));
  const coveredQueryTargetCount = queryTargets.length - missingQueryTargets.length;
  const conflicts = queryTargets.length && evidenceTargets.length
    && missingQueryTargets.length && coveredQueryTargetCount === 0
    ? [{
      family: "requested_target",
      reason: "target_not_covered",
      queryTargets: queryTargets.map(targetKey),
      evidenceTargets: evidenceTargets.map(targetKey),
    }]
    : [];
  return { missingQueryTargets, extraEvidenceTargets, conflicts };
}

function operationsForScenarioFact(match, { dimension, clause, fullText }) {
  const direct = FACT_OPERATION_DEFINITIONS.filter((definition) => definition.pattern.test(match[0]));
  if (direct.length) return direct;
  const clauseOperations = FACT_OPERATION_DEFINITIONS.filter(
    (definition) => definition.pattern.test(clause.text),
  );
  if (clauseOperations.length === 1) return clauseOperations;
  const windowStart = Math.max(0, clause.offset - 24);
  const windowEnd = Math.min(fullText.length, clause.offset + clause.text.length + 72);
  const nearby = FACT_OPERATION_DEFINITIONS.filter(
    (definition) => definition.pattern.test(fullText.slice(windowStart, windowEnd)),
  );
  if (dimension === "zone_capacity") {
    const summon = nearby.filter((operation) => ["special_summon", "normal_summon"].includes(operation.id));
    if (summon.length === 1) return summon;
  }
  if (dimension === "cost_payability") {
    const activation = nearby.find((operation) => operation.id === "activate");
    if (activation) return [activation];
  }
  return nearby.length === 1 ? nearby : [];
}

function isLegalityQuestionClause(text) {
  if (/(?:能否|是否(?:可以|能)?|可否|能不能|できますか|できませんか|可能ですか)/iu.test(text)) {
    return true;
  }
  const englishModal = text.match(/\b(?:can|could|may)\b/iu);
  if (!englishModal) return false;
  // In English a modal in the middle of a declarative premise (for example,
  // "Neither player can Special Summon") describes the scene; it does not ask
  // whether that action is legal.  Accept an explicit question mark, modal
  // inversion, or a whether-clause, and otherwise leave the clause as a fact.
  return /[?？]/u.test(text)
    || /^\s*(?:can|could|may)\b/iu.test(text)
    || /\bwhether\b.{0,48}\b(?:can|could|may)\b/iu.test(text);
}

function spansOverlap(left, right) {
  return left[0] < right[1] && right[0] < left[1];
}

function compareScenarioFacts(queryFacts, evidenceFacts) {
  const matchedEvidence = new Set();
  const missingQueryFacts = [];
  const conflicts = [];
  for (const queryFact of queryFacts) {
    const exactIndex = evidenceFacts.findIndex((evidenceFact, index) => (
      !matchedEvidence.has(index) && factsEquivalent(queryFact, evidenceFact)
    ));
    if (exactIndex >= 0) {
      matchedEvidence.add(exactIndex);
      continue;
    }
    const conflictingFacts = evidenceFacts.filter((fact) => (
      factsShareConflictFamily(queryFact, fact)
    ));
    if (conflictingFacts.length) {
      conflicts.push({
        family: "scenario_fact",
        reason: "premise_not_equivalent",
        queryFact: factKey(queryFact),
        evidenceFacts: conflictingFacts.map(factKey),
      });
      continue;
    }
    missingQueryFacts.push(queryFact);
  }
  const extraEvidenceFacts = evidenceFacts.filter((_fact, index) => !matchedEvidence.has(index));
  return { missingQueryFacts, extraEvidenceFacts, conflicts };
}

function factsEquivalent(left, right) {
  return left.operation === right.operation
    && left.dimension === right.dimension
    && left.state === right.state
    && left.scope === right.scope;
}

function factsShareConflictFamily(left, right) {
  if (left.operation !== right.operation) return false;
  if (left.dimension === right.dimension) return true;
  const legalityDimensions = new Set([
    "actor_permission",
    "operand_availability",
    "zone_capacity",
    "cost_payability",
  ]);
  return legalityDimensions.has(left.dimension) && legalityDimensions.has(right.dimension);
}

function targetKey(target) {
  return `${target.stage}:${target.operation}`;
}

function factKey(fact) {
  return `${fact.operation}:${fact.dimension}:${fact.state}:${fact.scope}`;
}

function dedupeFrames(items, getKey) {
  const result = new Map();
  for (const item of items) if (!result.has(getKey(item))) result.set(getKey(item), item);
  return [...result.values()];
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
