import { hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import {
  compareEvidenceScenarioPremises,
  classifyEvidenceQuestionTypes,
  classifyMultiEntityDecisionScope,
} from "./evidenceQuestionTypeClassifier.mjs";
import {
  extractInlineOfficialCardIds,
  projectOfficialQaQuestion,
} from "./officialQaQuestionProjection.mjs";

const officialQaRecordFeatureCache = new WeakMap();

const QUESTION_TYPES = [
  ["who_can_activate", /(?:谁(?:可以|能)?.*发动|由谁发动)|誰が.*発動|who (?:can|may) activate|which player.*activate/iu],
  ["card_activation_vs_effect_activation", /卡的发动.*效果发动|效果发动.*卡的发动|カード(?:の発動|を発動).*(?:効果の発動|効果が発動)|(?:効果の発動|効果が発動).*カード(?:の発動|を発動)|card activation.*effect activation/iu],
  ["copy_effect_procedure", /复制.*效果|复制.*发动手续|同じ効果.*発動|copy.*effect|copied effect/iu],
  ["declaration_legality", /(?:能否|是否(?:可以|能)?|可不可以|能不能|可以|能).{0,40}(?:宣言|声明)|(?:宣言|声明).{0,50}(?:できますか|できる|可以|能|発動)|(?:can|may).{0,50}\bdeclare\b|\bdeclare\b.{0,50}(?:can|may)/iu],
  ["target_legality", /能否.*(?:取|选择).*对象|不能成为.*对象|対象に.*(?:できます|できません)|can(?:not)? target|legal target/iu],
  ["timing_window", /时点|伤害步骤|伤害计算|错过时点|タイミング|ダメージステップ|timing|damage step/iu],
  ["continuous_effect_during_resolution", /效果处理中.*(?:永续|持续|自坏)|処理中.*永続|continuous effect.*resol/iu],
  ["can_activate", /(?:能否|是否(?:可以|能)?|可不可以|能不能|可以|不能|能).{0,12}(?:发动|连锁)|発動(?:する(?:事|こと)は)?(?:でき|出来)ますか|発動できません|can(?:not)?\b.{0,80}\bactivate/iu],
  ["action_legality", /(?:できますか|できませんか|可能ですか)|(?:能否|是否(?:可以|能)?|可不可以|能不能).{0,30}(?:召唤|送去|作为|进行|处理)|\bcan (?:i|you|a player|that|this)\b|\bis it possible\b/iu],
  ["resolution_result", /如何处理|怎么处理|处理后|效果处理|(?:还|仍然?|是否).{0,16}(?:适用|生效)|恢复适用|重新适用|どう処理|どうなりますか|処理はどうな|再び適用|what happens|resolution|resolve|still appl|appl(?:y|ies) again/iu],
];

const EFFECT_PHRASES = [
  ["who_can_activate", /谁可以发动|谁能发动|由谁发动|誰が.*発動|who can activate/iu],
  ["control_change", /控制权|コントロール|control/iu],
  ["after_chain_resolution", /连锁处理后|チェーン処理後|after (?:the )?chain resolves/iu],
  ["copy_effect", /复制效果|同じ効果|copy.*effect/iu],
  ["target", /取对象|选择对象|対象|target/iu],
  ["card_activation", /卡的发动|カード(?:の発動|を発動)|card activation/iu],
  ["effect_activation", /效果发动|効果(?:の発動|が発動)|effect activation/iu],
  ["during_resolution", /效果处理中|処理中|during resolution/iu],
  ["damage_step", /伤害步骤|ダメージステップ|damage step/iu],
  ["face_down_battle", /(?:里侧|裡側|裏側|face[- ]?down).{0,28}(?:守备|守備|defen[cs]e).{0,48}(?:被攻击|被攻擊|攻击|攻擊|攻撃され|attacked)|(?:攻击|攻擊|攻撃|attack).{0,48}(?:里侧|裡側|裏側|face[- ]?down).{0,28}(?:守备|守備|defen[cs]e)/iu],
  ["before_damage_calculation", /伤害计算前|傷害計算前|ダメージ計算前|before damage calculation/iu],
  ["defense_position_attack", /(?:守备表示|守備表示)(?:的|之|の|で|のまま)?[^，,。.!！?？;；\n]{0,36}(?:怪兽|怪獸|モンスター)?[^，,。.!！?？;；\n]{0,20}(?:攻击|攻擊|攻撃)|(?:monster|card).{0,24}(?:in|while in) (?:face-up )?defen[cs]e position.{0,24}(?:attacks?|declare)|attacks?.{0,16}while in (?:face-up )?defen[cs]e position/iu],
  ["continuous_effect", /永续效果|永續效果|持续效果|持續效果|永続効果|continuous effect/iu],
  ["activated_effect", /发动的效果|發動的效果|発動した効果|activated effect/iu],
  ["damage_calculation", /伤害计算|傷害計算|ダメージ計算|damage calculation/iu],
  ["battle_end", /战斗结束|戰鬥結束|戦闘は終了|攻撃は終了|battle ends?|attack ends?/iu],
  ["miss_timing", /错过时点|タイミングを逃|miss.*timing/iu],
  ["summon_response", /召唤成功时点|召喚成功時|summon response/iu],
];

const SEMANTIC_CONCEPTS = [
  ["activation", /発動|发动|activate|activation/iu],
  ["resolution", /処理|处理|解決|resolve|resolution|what happens|どうな/iu],
  ["chain", /チェーン|连锁|chain/iu],
  ["effect", /効果|效果|effect/iu],
  ["monster_effect", /モンスター.{0,12}効果|怪兽.{0,12}效果|monster effect/iu],
  ["special_summon", /特殊召喚|特殊召唤|special summon/iu],
  ["fusion_summon", /融合召喚|融合召唤|fusion summon/iu],
  ["fusion_material", /融合(?:召喚|召唤)?.{0,8}素材|fusion material|material for a fusion summon/iu],
  ["material_prohibited", /素材にできない|不能.{0,12}(?:作为|用作).{0,8}素材|cannot be used as material/iu],
  ["send_graveyard", /墓地.{0,16}送|送.{0,16}墓地|send.{0,30}graveyard|sent.{0,30}graveyard/iu],
  ["tribute_summon", /アドバンス召喚|上级召唤|tribute summon/iu],
  ["control_change", /コントロール|控制权|gain.{0,16}control|control of/iu],
  ["temporary_banish", /一時的.{0,16}除外|暂时.{0,16}除外|temporar.{0,24}banish|banish.{0,40}return.{0,20}(?:field|zone)/iu],
  ["negate_activation", /発動.{0,24}無効|发动.{0,24}无效|negate.{0,24}activation/iu],
  ["negate", /無効|无效|無效|negat/iu],
  ["return_deck", /デッキ.{0,24}戻|卡组.{0,24}(?:回到|返回)|shuffle.{0,30}deck|return.{0,30}deck/iu],
  ["discard", /捨て|丢弃|discard/iu],
  ["first_turn", /先攻.{0,12}(?:1|１)ターン|先攻第一回合|first turn.{0,20}(?:going first|of the duel)?/iu],
  ["simultaneous_summon", /同時.{0,16}特殊召喚|同时.{0,16}特殊召唤|simultaneous.{0,20}special summon/iu],
  ["declare_card_name", /宣言|声明|\bdeclare\b/iu],
  ["draw", /ドロー|抽卡|抽牌|\bdraw\b/iu],
  ["banish", /除外|banish/iu],
  ["destroy", /破壊|破坏|destroy/iu],
  ["battle", /戦闘|战斗|battle/iu],
  ["attack", /攻撃|攻击|attack/iu],
  ["face_down_battle_target", /(?:里侧|裡側|裏側|face[- ]?down).{0,28}(?:守备|守備|defen[cs]e).{0,48}(?:被攻击|被攻擊|攻击|攻擊|攻撃され|attacked)|(?:攻击|攻擊|攻撃|attack).{0,48}(?:里侧|裡側|裏側|face[- ]?down).{0,28}(?:守备|守備|defen[cs]e)/iu],
  ["flip_before_damage_calculation", /(?:伤害计算前|傷害計算前|ダメージ計算前|before damage calculation).{0,36}(?:翻开|翻開|反转|反轉|リバース|表侧|表側|flip)|(?:翻开|翻開|反转|反轉|リバース|flip).{0,36}(?:伤害计算前|傷害計算前|ダメージ計算前|before damage calculation)/iu],
  ["defense_position_attack", /(?:守备表示|守備表示)(?:的|之|の|で|のまま)?[^，,。.!！?？;；\n]{0,36}(?:怪兽|怪獸|モンスター)?[^，,。.!！?？;；\n]{0,20}(?:攻击|攻擊|攻撃)|(?:monster|card).{0,24}(?:in|while in) (?:face-up )?defen[cs]e position.{0,24}(?:attacks?|declare)|attacks?.{0,16}while in (?:face-up )?defen[cs]e position/iu],
  ["attack_continuation", /(?:攻击|攻擊|攻撃|attack).{0,36}(?:继续|繼續|続行|終了|continue|end)|(?:继续|繼續|続行|continue).{0,24}(?:攻击|攻擊|攻撃|attack)/iu],
  ["damage_calculation", /伤害计算|傷害計算|ダメージ計算|damage calculation/iu],
  ["battle_end", /战斗结束|戰鬥結束|戦闘は終了|攻撃は終了|battle ends?|attack ends?/iu],
  ["continuous_effect", /永续效果|永續效果|持续效果|持續效果|永続効果|continuous effect/iu],
  ["activated_effect", /发动的效果|發動的效果|発動した効果|activated effect/iu],
  ["effect_negation", /效果.{0,16}无效|效果.{0,16}無效|効果.{0,16}無効|negat.{0,20}effect/iu],
  ["reveal_show", /見せ|展示|给对方观看|公開|公开|reveal|show.{0,20}(?:hand|card)/iu],
  ["change_position", /表示形式|表示形態|表示状态|战斗表示形式|battle position|change.{0,20}position/iu],
  ["unaffected", /受けない|不受.{0,16}效果|unaffected/iu],
  ["replacement", /代わり|代替|instead/iu],
  ["race_identity", /(?:族|種族|race|type)\b/iu],
  ["monster_zone", /モンスターゾーン|怪兽区域|怪獸區域|monster zone/iu],
  ["field_presence", /フィールド|场上|場上|\bfield\b/iu],
  ["continuous_applying", /適用中|适用中|適用され|正在适用|while.{0,30}(?:appl|in effect)|is applying/iu],
  ["own_field_duration", /自分(?:の)?(?:フィールド|モンスターゾーン).{0,30}存在する限り|只要.{0,36}(?:自己|我方).{0,12}(?:场上|怪兽区域).{0,16}存在|(?:自己|我方).{0,12}(?:场上|怪兽区域).{0,24}(?:存在期间|存在的期间)|while.{0,40}(?:your|its owner's).{0,20}(?:field|monster zone)/iu],
  ["control_return", /コントロール.{0,40}再び自分に戻|控制权.{0,40}(?:归还|回到|返回).{0,12}(?:自己|我方)|control.{0,40}(?:returns?|returned).{0,24}(?:you|owner|original)/iu],
  ["condition_reactivation", /再び適用|恢复适用|恢復適用|重新适用|再次适用|重新生效|再次生效|re-?appl|appl(?:y|ies).{0,12}again/iu],
];

const GENERIC_SEMANTIC_CONCEPTS = new Set([
  "activation",
  "resolution",
  "chain",
  "effect",
  "monster_effect",
]);

const OPERATION_CONCEPT_FAMILIES = new Map([
  ["negate", "negate"],
  ["negate_activation", "negate"],
  ["effect_negation", "negate"],
  ["special_summon", "special_summon"],
  ["fusion_summon", "fusion_summon"],
  ["fusion_material", "fusion_material"],
  ["material_prohibited", "material_prohibited"],
  ["send_graveyard", "send_graveyard"],
  ["tribute_summon", "tribute_summon"],
  ["control_change", "control_change"],
  ["temporary_banish", "banish"],
  ["return_deck", "return_deck"],
  ["discard", "discard"],
  ["declare_card_name", "declare_card_name"],
  ["draw", "draw"],
  ["banish", "banish"],
  ["destroy", "destroy"],
  ["attack", "attack"],
  ["change_position", "change_position"],
  ["replacement", "replacement"],
]);

const SCENE_QUALIFIER_CONCEPTS = new Set([
  "damage_step",
  "damage_calculation",
  "first_turn",
  "temporary_banish",
  "simultaneous_summon",
  "face_down_battle_target",
  "defense_position_attack",
]);

const SCENE_QUALIFIER_PHRASES = new Set([
  "after_chain_resolution",
  "during_resolution",
  "damage_step",
  "before_damage_calculation",
  "damage_calculation",
  "miss_timing",
  "summon_response",
]);

const PLAYER_ROLE_SCORE_PENALTY = 0.28;
// Role mismatches are a hard demotion signal, so keep this recognizer
// deliberately conservative.  Relative English pronouns (especially
// "your opponent") and quoted card text require a discourse model rather
// than a regex; leaving them UNKNOWN is safer than reversing a ruling.
const SELF_PLAYER_ROLE_SOURCE = String.raw`(?:我方|己方|自己|自分|本方|我)`;
const OPPONENT_PLAYER_ROLE_SOURCE = String.raw`(?:对方|對方|敌方|敵方|对手|對手|相手)`;
const PLAYER_ACTION_PATTERNS = Object.freeze([
  ["activate", /发动|發動|発動|\bactivate|activation\b/iu],
  ["summon", /召唤|召喚|\bsummon/iu],
  ["discard", /丢弃|捨て|舍弃|捨棄|\bdiscard/iu],
  ["destroy", /破坏|破壊|\bdestroy/iu],
  ["banish", /除外|\bbanish/iu],
  ["target", /作为对象|作為對象|取对象|取對象|対象|\btarget/iu],
]);

export function normalizeOfficialQaQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』【】“”"'`]/gu, "")
    .replace(/[：:・·･－—–_\-]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]]/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

export function classifyOfficialQaQuestionType(value) {
  const text = String(value || "");
  const sharedTypes = new Set(classifyEvidenceQuestionTypes(text).questionTypes);
  // An explicit applicability question remains a resolution-result question,
  // even if its premise mentions battle. Generic "how is this battle handled"
  // wording keeps the more specific battle category. A question that asks both
  // whether an effect can be activated and what happens afterwards keeps its
  // activation type so an added resolution sub-question cannot make otherwise
  // identical official candidates appear incompatible.
  if (sharedTypes.has("effect_applicability")) {
    return "resolution_result";
  }
  if (sharedTypes.has("battle_resolution")) {
    return "battle_resolution";
  }
  if (
    sharedTypes.has("resolution_handling")
    && !sharedTypes.has("activation_condition")
  ) {
    return "resolution_result";
  }
  return QUESTION_TYPES.find(([, pattern]) => pattern.test(text))?.[0] || "unknown";
}

export function extractOfficialQaEffectPhrases(value) {
  const text = String(value || "");
  return EFFECT_PHRASES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

export function extractOfficialQaSemanticConcepts(value) {
  const text = String(value || "");
  return SEMANTIC_CONCEPTS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

export function searchOfficialQaEvidence({
  question,
  records = [],
  resolvedCards = [],
  limit = 20,
  subsumptionCandidatePoolComplete = false,
} = {}) {
  const query = String(question || "").trim();
  const normalizedQuery = normalizeOfficialQaQuery(query);
  const normalizedQuerySkeleton = normalizeOfficialQaSkeleton(query);
  const queryType = classifyOfficialQaQuestionType(query);
  const queryPhrases = extractOfficialQaEffectPhrases(query);
  const queryConcepts = extractOfficialQaSemanticConcepts(query);
  const queryMatchingConcepts = normalizeSemanticConceptsForMatching(queryConcepts);
  const multiBranchQuery = classifyMultiEntityDecisionScope(query).multiBranch;
  const resolvedIds = new Set((resolvedCards || []).map((card) => normalizeId(card.id || card.cardId)).filter(Boolean));
  const resolvedNames = new Set((resolvedCards || []).flatMap(cardAliases).map(normalizeOfficialQaQuery).filter(Boolean));
  const queryPlayerRoleSignature = extractPlayerRoleSignature(query, {
    cards: resolvedCards,
  });

  const scored = (records || [])
    .filter((record) => ["qa", "card-faq", "official-database"].includes(record.recordType))
    .map((record) => scoreRecord({
      record,
      query,
      normalizedQuery,
      normalizedQuerySkeleton,
      queryType,
      queryPhrases,
      queryConcepts,
      multiBranchQuery,
      resolvedIds,
      resolvedNames,
      resolvedCards,
      queryPlayerRoleSignature,
      subsumptionCandidatePoolComplete,
    }))
    .filter((item) => item && item.score >= 0.2);
  markAuthoritativeSceneMatches(scored);
  promoteUniqueExactCardSet(scored, queryType, resolvedIds);
  promoteUniqueQuestionCardMatch(scored, resolvedIds, queryType);
  scored.sort(compareOfficialQaMatches);
  promoteUniqueSemanticMatch(scored, resolvedIds, queryType);
  const ranked = retainMultiBranchCoverage(scored, Math.max(limit, 1), resolvedIds);

  const exact = ranked.filter((item) => item.matchLevel === "official_qa_exact");
  const near = ranked.filter((item) => item.matchLevel === "official_qa_near");
  const related = ranked.filter((item) => item.matchLevel === "official_related");
  return {
    rawQuery: query,
    normalizedQuery,
    questionType: queryType,
    effectPhrases: queryPhrases,
    semanticConcepts: queryConcepts,
    semanticMatchingConcepts: queryMatchingConcepts,
    multiBranchQuery,
    playerRoleSignature: queryPlayerRoleSignature,
    exact,
    near,
    related,
    all: ranked,
    searchPaths: ["raw_query_search", "normalized_query_search", "card_set_search", "effect_phrase_search", "fallback_alias_search"],
  };
}

export function resolveEntitiesFromOfficialQaMatch({ resolution = {}, matches, cards = [] } = {}) {
  const resolved = new Map((resolution.resolvedCards || []).map((card) => [cardKey(card), card]));
  const unresolved = [...(resolution.unresolvedCards || [])];
  const top = matches?.exact?.[0] || matches?.near?.find((item) => item.score >= 0.78) || null;
  if (!top) return buildEntityResolution(resolved, unresolved, false);

  const topFeatures = officialQaRecordFeatures(top.record);
  const evidenceIds = topFeatures.recordIds;
  const evidenceText = topFeatures.normalizedRecordText;
  let resolvedByOfficialQaMatch = false;
  const remaining = [];
  for (const mention of unresolved) {
    const candidate = (mention.candidateCards || []).find((item) => evidenceIds.has(normalizeId(item.cardId || item.id)))
      || (mention.candidateCards || []).find((item) => evidenceText.includes(normalizeOfficialQaQuery(item.name)));
    let selected = candidate && findCard(candidate.cardId || candidate.id, cards);
    if (!selected && top.matchLevel === "official_qa_exact" && evidenceIds.size === 1) selected = findCard([...evidenceIds][0], cards);
    if (!selected) {
      remaining.push(mention);
      continue;
    }
    resolved.set(cardKey(selected), { ...selected, matched: mention.unresolvedCardName, resolution: "official_qa_match" });
    resolvedByOfficialQaMatch = true;
  }
  return buildEntityResolution(resolved, remaining, resolvedByOfficialQaMatch);
}

function scoreRecord({
  record,
  query,
  normalizedQuery,
  normalizedQuerySkeleton,
  queryType,
  queryPhrases,
  queryConcepts,
  multiBranchQuery,
  resolvedIds,
  resolvedNames,
  resolvedCards,
  queryPlayerRoleSignature,
  subsumptionCandidatePoolComplete,
}) {
  const {
    questionText,
    scenarioQuestionText,
    normalizedRecordQuestionVariants,
    normalizedRecordPrincipalQuestionVariants,
    normalizedRecordQuestionSkeletonVariants,
    normalizedRecordText,
    evidenceType,
    evidencePhrases,
    evidenceConcepts,
    questionBranches,
    recordIds,
    recordQuestionIds,
    recordRelatedMetadataIds,
    recordIdentityText,
    questionIdentityText,
  } = officialQaRecordFeatures(record);
  // Source-level card metadata may rank or retrieve an official Q&A only
  // after the source exposes a bounded question surface. A legacy blob with no
  // question/title boundary may be answer text or an example; admitting it
  // would reinterpret answer-side material as a question. This check reuses
  // the cached projection above instead of parsing the record a second time.
  if (isScenarioOfficialQaRecord(record) && !questionText) return null;
  const evidencePlayerRoleSignature = extractPlayerRoleSignature(
    recordPlayerRoleContext(record, questionText),
    { cards: resolvedCards },
  );
  const evidenceMultiBranchQuery = classifyMultiEntityDecisionScope(scenarioQuestionText).multiBranch;
  const scenarioPremiseComparison = compareEvidenceScenarioPremises(query, scenarioQuestionText);
  const scenarioPremiseAuthorityCompatible = scenarioPremiseComparison.compatibility === "compatible";
  const scenarioPremiseRawExactCompatible = scenarioPremiseAuthorityCompatible
    || scenarioPremiseComparison.compatibility === "unknown";
  const playerRoleComparison = comparePlayerRoleSignatures(
    queryPlayerRoleSignature,
    evidencePlayerRoleSignature,
  );
  const typeCompatible = questionTypeCompatible(queryType, evidenceType);
  const exactNormalized = normalizedQuery.length >= 8
    && normalizedRecordQuestionVariants.includes(normalizedQuery);
  const exactPrincipalNormalized = normalizedQuery.length >= 8
    && normalizedRecordPrincipalQuestionVariants.includes(normalizedQuery);
  const exactSkeleton = normalizedQuerySkeleton.length >= 8
    && normalizedRecordQuestionSkeletonVariants.includes(normalizedQuerySkeleton);
  const containment = Math.max(...normalizedRecordQuestionVariants.map(
    (surface) => containmentScore(normalizedQuery, surface || normalizedRecordText),
  ));
  const similarity = Math.max(...normalizedRecordQuestionVariants.map(
    (surface) => diceSimilarity(normalizedQuery, surface || normalizedRecordText.slice(0, normalizedQuery.length * 2)),
  ));
  const skeletonContainment = Math.max(...normalizedRecordQuestionSkeletonVariants.map(
    (surface) => containmentScore(normalizedQuerySkeleton, surface),
  ));
  const skeletonSimilarity = Math.max(...normalizedRecordQuestionSkeletonVariants.map(
    (surface) => diceSimilarity(normalizedQuerySkeleton, surface),
  ));
  const phraseHits = queryPhrases.filter((phrase) => evidencePhrases.includes(phrase));
  const queryMatchingConcepts = normalizeSemanticConceptsForMatching(queryConcepts);
  const evidenceMatchingConcepts = normalizeSemanticConceptsForMatching(evidenceConcepts);
  const semanticHits = queryMatchingConcepts.filter((concept) => evidenceMatchingConcepts.includes(concept));
  const semanticScore = setDiceSimilarity(queryMatchingConcepts, evidenceMatchingConcepts);
  const semanticQueryCoverage = queryMatchingConcepts.length
    ? semanticHits.length / queryMatchingConcepts.length
    : 0;
  const distinctiveQueryConcepts = queryMatchingConcepts
    .filter((concept) => !GENERIC_SEMANTIC_CONCEPTS.has(concept));
  const distinctiveSemanticHits = distinctiveQueryConcepts
    .filter((concept) => evidenceMatchingConcepts.includes(concept));
  const distinctiveSemanticQueryCoverage = distinctiveQueryConcepts.length
    ? distinctiveSemanticHits.length / distinctiveQueryConcepts.length
    : 0;
  const queryOperationFamilies = extractOperationFamilies(queryConcepts);
  const questionOperationFamilies = extractOperationFamilies(evidenceConcepts);
  const matchedQuestionOperationFamilies = queryOperationFamilies.filter(
    (family) => questionOperationFamilies.includes(family),
  );
  // Candidate eligibility and ranking are question-side only. The official
  // answer becomes visible after retrieval, but must never create a mechanism
  // match that the official question itself does not contain.
  const matchedOperationFamilies = matchedQuestionOperationFamilies;
  const operationSemanticQueryCoverage = queryOperationFamilies.length
    ? matchedOperationFamilies.length / queryOperationFamilies.length
    : 0;
  const distinctiveOperationSemanticQueryCoverage = operationSemanticQueryCoverage;
  const queryEffectNumbers = extractEffectNumbers(query);
  const evidenceEffectNumbers = extractEffectNumbers(scenarioQuestionText);
  const effectNumberCompatible = !queryEffectNumbers.length
    || !evidenceEffectNumbers.length
    || queryEffectNumbers.some((number) => evidenceEffectNumbers.includes(number));
  const querySceneQualifiers = extractSceneQualifiers(queryConcepts, queryPhrases);
  const evidenceSceneQualifiers = extractSceneQualifiers(evidenceConcepts, evidencePhrases);
  const sceneQualifiersCompatible = sameStringSet(querySceneQualifiers, evidenceSceneQualifiers);
  // Keep direct authority and related discovery on separate identity rails.
  // Structured question ids (including <<CID>>) may participate in exact-scene
  // checks. Exact names in the official question and source metadata are useful
  // only for related recall; neither can promote a record to a direct ruling.
  const questionAliasCardIds = matchQuestionSideCardAliases(
    questionIdentityText,
    resolvedCards,
  );
  const relatedQuestionCardIds = new Set([
    ...recordQuestionIds,
    ...questionAliasCardIds,
  ]);
  const relatedIdentityCardIds = new Set([
    ...relatedQuestionCardIds,
    ...recordRelatedMetadataIds,
  ]);
  const matchedRecordCardIds = [...resolvedIds].filter((id) => recordIds.has(id));
  const matchedQuestionCardIds = [...resolvedIds].filter((id) => recordQuestionIds.has(id));
  const matchedRelatedQuestionCardIds = [...resolvedIds]
    .filter((id) => relatedQuestionCardIds.has(id));
  const matchedRelatedMetadataCardIds = [...resolvedIds]
    .filter((id) => recordRelatedMetadataIds.has(id));
  const matchedRelatedCardIds = [...resolvedIds]
    .filter((id) => relatedIdentityCardIds.has(id));
  const matchedCardIds = [...new Set([
    ...matchedRecordCardIds,
    ...matchedRelatedCardIds,
  ])];
  const cardIdMatch = matchedCardIds.length > 0;
  const cardIdCoverage = resolvedIds.size ? matchedCardIds.length / resolvedIds.size : 0;
  const questionCardIdCoverage = resolvedIds.size ? matchedQuestionCardIds.length / resolvedIds.size : 0;
  const relatedQuestionCardIdCoverage = resolvedIds.size
    ? matchedRelatedQuestionCardIds.length / resolvedIds.size
    : 0;
  const relatedCardIdCoverage = resolvedIds.size
    ? matchedRelatedCardIds.length / resolvedIds.size
    : 0;
  const exactQuestionCardIdSet = resolvedIds.size > 0
    && recordQuestionIds.size === resolvedIds.size
    && matchedQuestionCardIds.length === resolvedIds.size;
  const queryIdentityContainedInOneBranch = resolvedIds.size > 0
    && questionBranches.some((branch) => (
      [...resolvedIds].every((id) => branch.cardIds.has(id))
    ));
  const exactQuestionBranchIdSet = queryIdentityContainedInOneBranch
    && questionBranches.some((branch) => (
      branch.cardIds.size === resolvedIds.size
      && [...resolvedIds].every((id) => branch.cardIds.has(id))
    ));
  const exactResolvedCardIdSet = resolvedIds.size >= 2
    && recordIds.size === resolvedIds.size
    && matchedCardIds.length === resolvedIds.size;
  const supportingCardIds = new Set((record?.retrievalContext?.supportingCardIds || []).map(String));
  const exactRetrievedCardSubset = !isScenarioOfficialQaRecord(record)
    && supportingCardIds.size >= 2
    && supportingCardIds.size === resolvedIds.size
    && [...supportingCardIds].every((id) => recordIds.has(id) && resolvedIds.has(id))
    && [...resolvedIds].every((id) => supportingCardIds.has(id));
  const exactCardIdSet = exactResolvedCardIdSet || exactRetrievedCardSubset;
  const cardNameMatch = [...resolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, recordIdentityText) && normalizedRecordText.includes(name));
  const questionCardNameMatch = [...resolvedNames].some((name) => (
    name.length >= 3
    && !hasNumberedCardIdentityConflict(name, questionText)
    && normalizedRecordPrincipalQuestionVariants.some((surface) => surface.includes(name))
  ));
  const cardMatch = cardIdMatch || cardNameMatch;
  // Branch scope is established only by identities in the official question.
  // Cards that appear solely in an answer/example remain retrieval signals and
  // must never be treated as a covered decision branch.
  const relatedQuestionBranches = questionBranches.map((branch) => ({
    ...branch,
    relatedCardIds: new Set([
      ...branch.cardIds,
      ...matchQuestionSideCardAliases(branch.text, resolvedCards),
    ]),
  }));
  const supportingBranch = selectSupportingQuestionBranch({
    branches: relatedQuestionBranches,
    query,
    queryType,
    queryConcepts,
    queryPhrases,
    resolvedIds,
    resolvedCards,
    queryPlayerRoleSignature,
    requireFullQueryIdentity: !multiBranchQuery && resolvedIds.size > 1,
  });
  const branchMatchedCardIds = supportingBranch?.matchedCardIds
    || [...new Set(matchedRelatedQuestionCardIds)];
  const fullQuestionExact = exactPrincipalNormalized && exactQuestionCardIdSet;
  const evidenceHasMultipleBranches = evidenceMultiBranchQuery || questionBranches.length > 1;
  const branchRelevant = (multiBranchQuery || evidenceHasMultipleBranches)
    && Boolean(supportingBranch)
    && !fullQuestionExact
    && branchMatchedCardIds.length > 0
    && supportingBranch.typeCompatible
    && supportingBranch.playerRoleComparison.compatibility !== "mismatch"
    && supportingBranch.scenarioPremiseComparison.compatibility !== "mismatch"
    && (supportingBranch.phraseHits.length > 0 || supportingBranch.semanticHits.length >= 2);
  const relatedPlayerRoleComparison = branchRelevant
    ? supportingBranch.playerRoleComparison
    : playerRoleComparison;
  const relatedScenarioPremiseComparison = branchRelevant
    ? supportingBranch.scenarioPremiseComparison
    : scenarioPremiseComparison;
  const identityCompatibleForExact = !resolvedIds.size
    || (recordQuestionIds.size > 0
      ? questionCardIdCoverage === 1
      : relatedQuestionCardIdCoverage === 1);
  // Replacing quoted names with a generic "card" token is useful for ranking
  // differently translated versions of the same question, but it cannot prove
  // that the cards are the same. Only the original wording may establish a raw
  // exact match, and any structured card identity present on both sides must
  // agree completely.
  const rawExact = identityCompatibleForExact && exactPrincipalNormalized;
  const rawSceneMatch = rawExact
    && typeCompatible
    && playerRoleComparison.compatibility !== "mismatch"
    && scenarioPremiseRawExactCompatible;
  const structuredSceneMatch = exactQuestionBranchIdSet
    && queryType !== "unknown"
    && evidenceType === queryType
    && distinctiveQueryConcepts.length > 0
    && distinctiveSemanticHits.length > 0
    && effectNumberCompatible
    && sceneQualifiersCompatible
    && playerRoleComparison.compatibility !== "mismatch"
    && scenarioPremiseAuthorityCompatible;
  const lexicalScore = Math.max(similarity, containment, skeletonSimilarity, skeletonContainment);
  let score = Math.max(lexicalScore, semanticScore * 0.72);
  if (typeCompatible && queryType !== "unknown") score += 0.16;
  if (cardMatch) score += 0.17;
  if (resolvedIds.size >= 2 && cardIdCoverage === 1) score += 0.24;
  if (resolvedIds.size >= 2 && questionCardIdCoverage === 1) score += 0.2;
  if (relatedQuestionCardIdCoverage > questionCardIdCoverage) {
    score += relatedQuestionCardIdCoverage * 0.12;
  }
  if (exactCardIdSet) score += 0.12;
  score += Math.min(0.18, phraseHits.length * 0.06);
  if (branchRelevant) score += 0.14;
  if (relatedPlayerRoleComparison.compatibility === "mismatch") {
    score = Math.max(cardMatch ? 0.2 : 0, score - PLAYER_ROLE_SCORE_PENALTY);
  }
  score = Math.min(1, Number(score.toFixed(4)));

  let matchLevel = "official_related";
  if (rawSceneMatch && !branchRelevant) {
    matchLevel = "official_qa_exact";
  }
  else if (typeCompatible && (score >= 0.68 || (cardMatch && phraseHits.length && score >= 0.56))) matchLevel = "official_qa_near";
  if (branchRelevant && matchLevel === "official_related") matchLevel = "official_qa_near";
  if (relatedPlayerRoleComparison.compatibility === "mismatch") matchLevel = "official_related";
  if (relatedScenarioPremiseComparison.compatibility === "mismatch") matchLevel = "official_related";
  if (!["compatible", "unknown"].includes(scenarioPremiseComparison.compatibility)
      && matchLevel === "official_qa_exact") matchLevel = "official_related";
  return {
    id: String(record.id || "unknown"),
    record,
    matchLevel,
    score,
    questionType: evidenceType,
    typeCompatible,
    cardMatch,
    matchedCardIds,
    matchedQuestionCardIds,
    matchedRelatedQuestionCardIds,
    matchedRelatedMetadataCardIds,
    matchedRelatedCardIds,
    branchRelevant,
    branchMatchedCardIds,
    supportingQuestionBranchIndex: supportingBranch?.branchIndex ?? null,
    supportingQuestionBranchCardIds: supportingBranch
      ? [...(supportingBranch.relatedCardIds || supportingBranch.cardIds)]
      : [],
    supportingQuestionBranchUnmatchedCardIds: supportingBranch
      ? [...supportingBranch.unmatchedCardIds]
      : [],
    supportingQuestionBranchIdentityComplete: Boolean(
      supportingBranch
      && supportingBranch.matchedCardIds.length > 0
      && supportingBranch.unmatchedCardIds.length === 0
    ),
    supportingQuestionBranchTypeCompatible: supportingBranch?.typeCompatible === true,
    supportingQuestionBranchPlayerRoleCompatibility:
      supportingBranch?.playerRoleComparison.compatibility || "unknown",
    supportingQuestionBranchScenarioPremiseCompatibility:
      supportingBranch?.scenarioPremiseComparison.compatibility || "unknown",
    multiBranchQuery,
    evidenceMultiBranchQuery,
    cardIdCoverage,
    questionCardIdCoverage,
    relatedQuestionCardIdCoverage,
    relatedCardIdCoverage,
    questionCardIdCount: recordQuestionIds.size,
    relatedQuestionCardIdCount: relatedQuestionCardIds.size,
    exactQuestionCardIdSet,
    exactQuestionBranchIdSet,
    queryIdentityContainedInOneBranch,
    exactCardIdSet,
    identityCompatibleForExact,
    lexicalScore,
    semanticScore,
    semanticQueryCoverage,
    semanticHits,
    distinctiveQueryConcepts,
    distinctiveSemanticHits,
    distinctiveSemanticQueryCoverage,
    operationSemanticHits: matchedOperationFamilies,
    operationSemanticQueryCoverage,
    distinctiveOperationSemanticHits: matchedOperationFamilies,
    distinctiveOperationSemanticQueryCoverage,
    matchedQuestionOperationFamilies,
    matchedOperationFamilies,
    queryEffectNumbers,
    evidenceEffectNumbers,
    effectNumberCompatible,
    querySceneQualifiers,
    evidenceSceneQualifiers,
    sceneQualifiersCompatible,
    playerRoleCompatibility: relatedPlayerRoleComparison.compatibility,
    playerRoleMismatches: relatedPlayerRoleComparison.mismatches,
    playerRoleComparableDimensions: relatedPlayerRoleComparison.comparableDimensions,
    scenarioPremiseCompatibility: relatedScenarioPremiseComparison.compatibility,
    scenarioPremiseConflicts: relatedScenarioPremiseComparison.conflicts,
    queryScenarioPremises: scenarioPremiseComparison.queryPremises,
    evidenceScenarioPremises: scenarioPremiseComparison.evidencePremises,
    queryOnlyScenarioPremises: scenarioPremiseComparison.queryOnlyPremises,
    evidenceOnlyScenarioPremises: scenarioPremiseComparison.evidenceOnlyPremises,
    queryApplicabilityFrame: scenarioPremiseComparison.queryFrame,
    evidenceApplicabilityFrame: scenarioPremiseComparison.evidenceFrame,
    requestedTargetCoverage: scenarioPremiseComparison.targetCoverage,
    scenarioFactCoverage: scenarioPremiseComparison.factCoverage,
    queryPlayerRoleSignature,
    evidencePlayerRoleSignature,
    rawSceneMatch,
    structuredSceneMatch,
    authoritativeSceneMatch: false,
    authoritativeSceneMatchReason: "",
    resolvedCardIdCount: resolvedIds.size,
    semanticSubsumptionCertified: false,
    semanticSubsumptionScoreMargin: null,
    semanticSubsumptionRunnerUpId: "",
    semanticSubsumptionMetrics: null,
    questionCardSubsumptionCertified: false,
    questionCardSubsumptionMetrics: null,
    candidatePoolComplete: record?.retrievalContext?.candidatePoolComplete === true,
    subsumptionCandidatePoolComplete: subsumptionCandidatePoolComplete === true,
    matchedBy: [
      rawExact && "raw_or_normalized_query",
      exactSkeleton && "card_name_agnostic_skeleton",
      cardIdMatch && "card_id",
      cardNameMatch && "card_name",
      questionAliasCardIds.size && "related_question_exact_alias",
      matchedRelatedMetadataCardIds.length && "related_source_metadata_card_id",
      typeCompatible && "question_type",
      phraseHits.length && "effect_phrase",
      branchRelevant && "multi_branch_related_evidence",
      playerRoleComparison.compatibility === "mismatch" && "player_role_mismatch",
      scenarioPremiseComparison.compatibility === "mismatch" && "scenario_premise_mismatch",
      scenarioPremiseComparison.compatibility === "partial" && "scenario_premise_partial",
      scenarioPremiseComparison.compatibility === "conditional" && "scenario_premise_conditional",
    ].filter(Boolean),
    matchedPhrases: phraseHits,
    questionText,
  };
}

/**
 * Rank scene evidence by the identities and operations stated in the question
 * portion of the source before considering broad lexical similarity.
 *
 * This intentionally does not alter matchLevel. A source can therefore be the
 * best supporting QA without being promoted to DIRECT_OFFICIAL. In particular,
 * a long FAQ that merely lists a card in an example cannot outrank a question
 * that names several of the same cards and the same effect number/scene.
 */
function compareOfficialQaMatches(left, right) {
  return Number(right.matchLevel === "official_qa_exact")
      - Number(left.matchLevel === "official_qa_exact")
    || Number(left.playerRoleCompatibility === "mismatch")
      - Number(right.playerRoleCompatibility === "mismatch")
    || scenarioPremiseCompatibilityRank(right.scenarioPremiseCompatibility)
      - scenarioPremiseCompatibilityRank(left.scenarioPremiseCompatibility)
    || Number(right.authoritativeSceneMatch) - Number(left.authoritativeSceneMatch)
    || right.questionCardIdCoverage - left.questionCardIdCoverage
    || right.matchedQuestionCardIds.length - left.matchedQuestionCardIds.length
    || right.relatedQuestionCardIdCoverage - left.relatedQuestionCardIdCoverage
    || right.matchedRelatedCardIds.length - left.matchedRelatedCardIds.length
    || Number(right.exactCardIdSet) - Number(left.exactCardIdSet)
    || Number(right.branchRelevant) - Number(left.branchRelevant)
    || Number(right.effectNumberCompatible) - Number(left.effectNumberCompatible)
    || Number(right.sceneQualifiersCompatible) - Number(left.sceneQualifiersCompatible)
    || right.distinctiveSemanticQueryCoverage - left.distinctiveSemanticQueryCoverage
    || right.semanticQueryCoverage - left.semanticQueryCoverage
    || Number(right.typeCompatible) - Number(left.typeCompatible)
    || right.score - left.score
    || right.lexicalScore - left.lexicalScore
    || String(left.record.id).localeCompare(String(right.record.id));
}

function markAuthoritativeSceneMatches(items) {
  const structuredMatches = items.filter((item) => (
    item.structuredSceneMatch
    && item.candidatePoolComplete
    && item.playerRoleCompatibility !== "mismatch"
    && item.scenarioPremiseCompatibility === "compatible"
  ));
  for (const item of items) {
    if (item.playerRoleCompatibility === "mismatch"
        || !["compatible", "unknown"].includes(item.scenarioPremiseCompatibility)
        || item.branchRelevant) continue;
    if (item.rawSceneMatch) {
      item.authoritativeSceneMatch = true;
      item.authoritativeSceneMatchReason = "raw_or_normalized_query";
      continue;
    }
    if (item.scenarioPremiseCompatibility === "compatible"
        && item.structuredSceneMatch && item.candidatePoolComplete && structuredMatches.length === 1) {
      item.authoritativeSceneMatch = true;
      item.authoritativeSceneMatchReason = "unique_structured_scene";
    }
  }
}

function extractEffectNumbers(value) {
  const text = String(value || "").normalize("NFKC");
  const numbers = [
    ...[...text.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/gu)].map((match) => String("①②③④⑤⑥⑦⑧⑨⑩".indexOf(match[0]) + 1)),
    ...[...text.matchAll(/(?:第\s*)?([1-9]|10)\s*(?:个|個|つ目)?(?:的|の)?\s*(?:効果|效果|effect)/giu)].map((match) => String(Number(match[1]))),
    ...[...text.matchAll(/\b(?:the\s+)?(first|second|third|fourth|fifth)\s+effect\b/giu)].map((match) => ({
      first: "1",
      second: "2",
      third: "3",
      fourth: "4",
      fifth: "5",
    })[match[1].toLowerCase()]),
  ].filter(Boolean);
  return [...new Set(numbers)];
}

function extractSceneQualifiers(concepts, phrases) {
  return [...new Set([
    ...(concepts || []).filter((concept) => SCENE_QUALIFIER_CONCEPTS.has(concept)),
    ...(phrases || []).filter((phrase) => SCENE_QUALIFIER_PHRASES.has(phrase)),
  ])].sort();
}

function sameStringSet(left, right) {
  if ((left || []).length !== (right || []).length) return false;
  const rightSet = new Set(right || []);
  return (left || []).every((item) => rightSet.has(item));
}

function questionTypeCompatible(queryType, evidenceType) {
  if (queryType === "unknown" || evidenceType === "unknown") return queryType === evidenceType;
  if (queryType === evidenceType) return true;
  const activation = new Set([
    "can_activate",
    "timing_window",
    "card_activation_vs_effect_activation",
  ]);
  if (activation.has(queryType) && activation.has(evidenceType)) return true;
  const legality = new Set(["action_legality", "can_activate", "target_legality", "timing_window"]);
  return legality.has(queryType) && legality.has(evidenceType);
}

function retainMultiBranchCoverage(items, limit, resolvedIds) {
  const head = items.slice(0, limit);
  if ((resolvedIds || new Set()).size < 2) return head;

  const represented = new Set(
    head.filter((item) => item.branchRelevant)
      .flatMap((item) => item.branchMatchedCardIds || []),
  );
  const additions = [];
  const addedItems = new Set();
  for (const item of items.slice(limit)) {
    if (!item.branchRelevant) continue;
    const uncovered = (item.branchMatchedCardIds || []).filter((id) => !represented.has(id));
    if (!uncovered.length || addedItems.has(item)) continue;
    additions.push(item);
    addedItems.add(item);
    uncovered.forEach((id) => represented.add(id));
    if (represented.size >= resolvedIds.size || additions.length >= limit) break;
  }
  if (!additions.length) return head;

  // Keep the matcher bounded.  Branch representatives remain supporting
  // evidence only; replacing the weakest tail cannot promote their authority
  // level and lets the retriever reserve them explicitly per branch later.
  return [...head.slice(0, Math.max(0, limit - additions.length)), ...additions];
}

function recordPlayerRoleContext(record = {}, questionText = "") {
  const explicitScenario = [
    record.question,
    record.rawQuestion,
    record.rawDetailedQuestion,
    record.scenario,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (explicitScenario.length) return [...new Set(explicitScenario)].join("\n");
  // Do not infer the source scenario from an answer or quoted card text.  The
  // relative 自分/相手 inside those passages is scoped to the quoted card's
  // controller and cannot safely be compared with the user's player roles.
  return String(questionText || "");
}

function extractPlayerRoleSignature(text, { cards = [] } = {}) {
  const source = String(text || "");
  const actionActors = extractActionActors(source);
  const cardControllers = extractCardControllers(source, cards);

  return {
    actionActors,
    cardControllers,
  };
}

function extractActionActors(text) {
  const result = new Map(PLAYER_ACTION_PATTERNS.map(([action]) => [action, new Set()]));
  for (const clause of splitPlayerRoleClauses(text)) {
    const roles = explicitPlayerRoles(clause);
    if (roles.length !== 1) continue;
    for (const [action, pattern] of PLAYER_ACTION_PATTERNS) {
      if (pattern.test(clause)) result.get(action).add(roles[0]);
    }
  }
  return Object.fromEntries(
    [...result.entries()]
      .filter(([, players]) => players.size)
      .map(([action, players]) => [action, [...players].sort()]),
  );
}

function extractCardControllers(text, cards = []) {
  const bindings = [];
  for (const card of cards || []) {
    const players = new Set();
    for (const token of playerRoleCardTokens(card)) {
      const escapedToken = escapeRegExp(token);
      for (const [role, roleSource] of [
        ["self", SELF_PLAYER_ROLE_SOURCE],
        ["opponent", OPPONENT_PLAYER_ROLE_SOURCE],
      ]) {
        const patterns = [
          new RegExp(`${roleSource}.{0,14}(?:场上|場上|フィールド|墓地|手卡|手牌|手札|控制|コントロール)(?:的|の)?[^，,。.!！?？;；\\n]{0,10}${escapedToken}`, "iu"),
          new RegExp(`${roleSource}.{0,12}${escapedToken}.{0,18}(?:适用中|適用中|存在|控制|コントロール|发动|發動|発動|activate)`, "iu"),
          new RegExp(`${roleSource}.{0,12}(?:发动|發動|発動|activate)[^，,。.!！?？;；\\n]{0,12}${escapedToken}`, "iu"),
          new RegExp(`${escapedToken}.{0,12}(?:由)?${roleSource}.{0,10}(?:控制|コントロール|发动|發動|発動|activate)`, "iu"),
        ];
        if (patterns.some((pattern) => pattern.test(text))) players.add(role);
      }
    }
    if (!players.size) continue;
    bindings.push({
      cardKey: playerRoleCardKey(card),
      cardId: normalizeId(card.id || card.cardId),
      cardName: String(card.name || card.cnName || card.jaName || card.enName || ""),
      players: [...players].sort(),
    });
  }
  return bindings.sort((left, right) => left.cardKey.localeCompare(right.cardKey));
}

function comparePlayerRoleSignatures(query = {}, evidence = {}) {
  const mismatches = [];
  const comparableDimensions = [];
  const queryActions = query.actionActors || {};
  const evidenceActions = evidence.actionActors || {};
  for (const action of [...new Set([...Object.keys(queryActions), ...Object.keys(evidenceActions)])].sort()) {
    comparePlayerRoleSets({
      dimension: "action_actor",
      qualifier: action,
      queryPlayers: queryActions[action],
      evidencePlayers: evidenceActions[action],
      mismatches,
      comparableDimensions,
    });
  }
  const queryControllers = new Map((query.cardControllers || []).map((item) => [item.cardKey, item]));
  const evidenceControllers = new Map((evidence.cardControllers || []).map((item) => [item.cardKey, item]));
  for (const [cardKey, queryBinding] of queryControllers) {
    const evidenceBinding = evidenceControllers.get(cardKey);
    if (!evidenceBinding) continue;
    comparePlayerRoleSets({
      dimension: "card_controller",
      qualifier: cardKey,
      cardId: queryBinding.cardId || evidenceBinding.cardId || "",
      cardName: queryBinding.cardName || evidenceBinding.cardName || "",
      queryPlayers: queryBinding.players,
      evidencePlayers: evidenceBinding.players,
      mismatches,
      comparableDimensions,
    });
  }

  return {
    compatibility: mismatches.length ? "mismatch" : comparableDimensions.length ? "compatible" : "unknown",
    mismatches,
    comparableDimensions: [...new Set(comparableDimensions)],
  };
}

function comparePlayerRoleSets({
  dimension,
  qualifier = "",
  cardId = "",
  cardName = "",
  queryPlayers = [],
  evidencePlayers = [],
  mismatches,
  comparableDimensions,
}) {
  const querySet = new Set(queryPlayers || []);
  const evidenceSet = new Set(evidencePlayers || []);
  if (!querySet.size || !evidenceSet.size) return;
  const key = [dimension, qualifier].filter(Boolean).join(":");
  comparableDimensions.push(key);
  if ([...querySet].some((player) => evidenceSet.has(player))) return;
  mismatches.push({
    dimension,
    ...(qualifier ? { qualifier } : {}),
    ...(cardId ? { cardId } : {}),
    ...(cardName ? { cardName } : {}),
    queryPlayers: [...querySet].sort(),
    evidencePlayers: [...evidenceSet].sort(),
  });
}

function splitPlayerRoleClauses(value) {
  return String(value || "").split(/[，,。.!！?？;；\n]+/u).map((item) => item.trim()).filter(Boolean);
}

function explicitPlayerRoles(value) {
  return [
    new RegExp(SELF_PLAYER_ROLE_SOURCE, "iu").test(value) ? "self" : "",
    new RegExp(OPPONENT_PLAYER_ROLE_SOURCE, "iu").test(value) ? "opponent" : "",
  ].filter(Boolean);
}

function playerRoleCardTokens(card = {}) {
  return [...new Set([
    card.input,
    card.matchedQuery,
    card.name,
    card.cnName,
    card.jaName,
    card.enName,
    ...(card.aliases || []),
    normalizeId(card.id || card.cardId) ? `<<${normalizeId(card.id || card.cardId)}>>` : "",
  ].map((item) => String(item || "").trim()).filter((item) => item.length >= 2))];
}

function playerRoleCardKey(card = {}) {
  return normalizeId(card.id || card.cardId)
    || normalizeOfficialQaQuery(card.name || card.cnName || card.jaName || card.enName);
}

function recordText(record = {}) {
  if (record.text) return String(record.text);
  const answer = record.answer || record.conclusion || "";
  return [record.question, answer, record.officialText, record.title].filter(Boolean).join("\n");
}

function promoteUniqueExactCardSet(items, queryType, resolvedIds) {
  if (resolvedIds.size < 2 || queryType === "unknown") return;
  const candidates = items.filter((item) => {
    if (item.playerRoleCompatibility === "mismatch"
        || item.scenarioPremiseCompatibility !== "compatible"
        || item.branchRelevant
        || !item.exactCardIdSet
        || !item.typeCompatible
        || item.questionType !== queryType) return false;
    const retrievalContext = item.record?.retrievalContext || {};
    const uniqueLiveIntersection = retrievalContext.uniqueExactCardIntersection === true
      && Number(retrievalContext.intersectionCandidatePoolSize ?? retrievalContext.candidatePoolSize) === 1
      && (retrievalContext.intersectionCandidatePoolComplete ?? retrievalContext.candidatePoolComplete) === true;
    return uniqueLiveIntersection || item.lexicalScore >= 0.45;
  });
  if (candidates.length !== 1) return;
  const [candidate] = candidates;
  if (!candidate.authoritativeSceneMatch) return;
  candidate.matchLevel = "official_qa_exact";
  candidate.score = Math.max(candidate.score, 0.92);
  candidate.matchedBy = [...new Set([...candidate.matchedBy, "unique_exact_card_set"])];
}

function promoteUniqueQuestionCardMatch(items, resolvedIds, queryType) {
  if (resolvedIds.size < 2 || queryType === "unknown") return;
  const subsumptionCandidates = items.filter((item) => (
    item.playerRoleCompatibility !== "mismatch"
    && item.scenarioPremiseCompatibility === "compatible"
    &&
    item.subsumptionCandidatePoolComplete
    && item.typeCompatible
    && item.questionType === queryType
    && item.questionCardIdCoverage === 1
    && item.queryIdentityContainedInOneBranch
    && item.matchedQuestionCardIds.length === resolvedIds.size
    && item.questionCardIdCount === item.matchedQuestionCardIds.length
    && item.effectNumberCompatible
    && item.sceneQualifiersCompatible
    && item.semanticQueryCoverage >= 0.8
    && item.semanticScore >= 0.6
    && item.score >= 0.88
    && (item.distinctiveSemanticHits.length >= 1 || item.lexicalScore >= 0.5)
  ));
  if (subsumptionCandidates.length === 1) {
    const [candidate] = subsumptionCandidates;
    // A compound source branch may completely cover the query and therefore
    // must count as a competing interpretation. It still cannot itself cross
    // the direct-authority boundary: only an unbranched unique candidate may
    // be promoted.
    if (!candidate.branchRelevant && candidate.matchLevel !== "official_qa_exact") {
      candidate.authoritativeSceneMatch = true;
      candidate.authoritativeSceneMatchReason = "unique_question_card_subsumption";
      candidate.questionCardSubsumptionCertified = true;
      candidate.questionCardSubsumptionMetrics = {
        resolvedCardIdCount: resolvedIds.size,
        matchedQuestionCardIdCount: candidate.matchedQuestionCardIds.length,
        questionCardIdCount: candidate.questionCardIdCount,
        questionCardIdCoverage: candidate.questionCardIdCoverage,
        distinctiveSemanticHitCount: candidate.distinctiveSemanticHits.length,
        semanticQueryCoverage: candidate.semanticQueryCoverage,
        semanticScore: candidate.semanticScore,
        lexicalScore: candidate.lexicalScore,
        score: candidate.score,
        eligibleCandidateCount: subsumptionCandidates.length,
        evaluatedCandidateCount: items.length,
      };
      candidate.matchLevel = "official_qa_exact";
      candidate.score = Math.max(candidate.score, 0.94);
      candidate.matchedBy = [...new Set([...candidate.matchedBy, "unique_question_card_subsumption"])];
      return;
    }
  }
  const candidates = items.filter((item) => (
    item.playerRoleCompatibility !== "mismatch"
    && item.scenarioPremiseCompatibility === "compatible"
    &&
    item.typeCompatible
    && item.questionType === queryType
    && item.questionCardIdCoverage === 1
    && item.semanticHits.length >= 1
    && item.semanticQueryCoverage >= 0.5
    && item.semanticScore >= 0.4
  ));
  if (candidates.length !== 1) return;
  const [candidate] = candidates;
  if (candidate.branchRelevant || !candidate.authoritativeSceneMatch) return;
  candidate.matchLevel = "official_qa_exact";
  candidate.score = Math.max(candidate.score, 0.94);
  candidate.matchedBy = [...new Set([...candidate.matchedBy, "unique_question_card_set"])];
}

function promoteUniqueSemanticMatch(items, resolvedIds, queryType) {
  const [top, second] = items;
  if (!top
      || !top.typeCompatible
      || top.branchRelevant
      || top.matchLevel === "official_qa_exact"
      || (resolvedIds.size > 0 && !top.queryIdentityContainedInOneBranch)
      || top.playerRoleCompatibility === "mismatch"
      || top.scenarioPremiseCompatibility !== "compatible") return;
  const generalSemanticSignature = top.semanticHits.length >= 3
    && top.semanticQueryCoverage >= 0.8
    && top.semanticScore >= 0.72;
  const uniqueResolvedCardOperation = resolvedIds.size >= 2
    && top.cardIdCoverage === 1
    && top.questionType === queryType
    && top.semanticHits.length >= 1
    && top.semanticQueryCoverage >= 0.9
    && top.semanticScore >= 0.5;
  if ((!generalSemanticSignature && !uniqueResolvedCardOperation) || top.score < 0.78) return;
  if (resolvedIds.size && !top.identityCompatibleForExact) return;
  const margin = top.score - Number(second?.score || 0);
  const semanticSubsumptionCandidateCount = items.filter((item) => (
    item.playerRoleCompatibility !== "mismatch"
    && item.scenarioPremiseCompatibility === "compatible"
    && item.subsumptionCandidatePoolComplete
    && resolvedIds.size >= 1
    && queryType !== "unknown"
    && item.questionType === queryType
    && item.questionCardIdCoverage === 1
    && item.queryIdentityContainedInOneBranch
    && item.matchedQuestionCardIds.length === resolvedIds.size
    && (resolvedIds.size === 1 || item.questionCardIdCount === item.matchedQuestionCardIds.length)
    && item.effectNumberCompatible
    && item.sceneQualifiersCompatible
    && item.distinctiveQueryConcepts.length >= 3
    && item.distinctiveSemanticHits.length >= 3
    && item.distinctiveSemanticQueryCoverage >= 0.9
    && item.semanticQueryCoverage >= 0.9
    && item.semanticScore >= 0.72
    && item.score >= 0.85
  )).length;
  const semanticQuestionSubsumption = Boolean(second)
    && semanticSubsumptionCandidateCount === 1
    && top.subsumptionCandidatePoolComplete
    && resolvedIds.size >= 1
    && queryType !== "unknown"
    && top.questionType === queryType
    && top.questionCardIdCoverage === 1
    && top.queryIdentityContainedInOneBranch
    && top.matchedQuestionCardIds.length === resolvedIds.size
    && (resolvedIds.size === 1 || top.questionCardIdCount === top.matchedQuestionCardIds.length)
    && top.effectNumberCompatible
    && top.sceneQualifiersCompatible
    && top.distinctiveQueryConcepts.length >= 3
    && top.distinctiveSemanticHits.length >= 3
    && top.distinctiveSemanticQueryCoverage >= 0.9
    && top.semanticQueryCoverage >= 0.9
    && top.semanticScore >= 0.72
    && top.score >= 0.85
    && margin >= 0.1;

  if (semanticQuestionSubsumption) {
    top.authoritativeSceneMatch = true;
    top.authoritativeSceneMatchReason = "unique_semantic_question_subsumption";
    top.semanticSubsumptionCertified = true;
    top.semanticSubsumptionScoreMargin = Number(margin.toFixed(4));
    top.semanticSubsumptionRunnerUpId = String(second.id || second.record?.id || "");
    top.semanticSubsumptionMetrics = {
      resolvedCardIdCount: resolvedIds.size,
      matchedQuestionCardIdCount: top.matchedQuestionCardIds.length,
      questionCardIdCount: top.questionCardIdCount,
      questionCardIdCoverage: top.questionCardIdCoverage,
      distinctiveQueryConceptCount: top.distinctiveQueryConcepts.length,
      distinctiveSemanticHitCount: top.distinctiveSemanticHits.length,
      distinctiveSemanticQueryCoverage: top.distinctiveSemanticQueryCoverage,
      semanticQueryCoverage: top.semanticQueryCoverage,
      semanticScore: top.semanticScore,
      score: top.score,
      runnerUpScore: second.score,
      scoreMargin: Number(margin.toFixed(4)),
    };
    top.matchLevel = "official_qa_exact";
    top.matchedBy = [...new Set([...top.matchedBy, "unique_semantic_question_subsumption"])];
    return;
  }

  if (!top.authoritativeSceneMatch) return;
  if (second && margin < 0.08) return;
  top.matchLevel = "official_qa_exact";
  top.matchedBy = [...new Set([...top.matchedBy, "unique_semantic_signature"])];
}

function officialQaRecordFeatures(record = {}) {
  if (record && typeof record === "object") {
    const cached = officialQaRecordFeatureCache.get(record);
    if (cached) return cached;
  }
  const projection = projectOfficialQaQuestion(record);
  const questionText = projection.questionText;
  const questionSurfaces = projection.surfaces;
  const scenarioQuestionText = projection.scenarioText;
  const fullText = recordText(record);
  const scenarioQa = isScenarioOfficialQaRecord(record);
  const identityText = scenarioQa
    ? [...new Set([
        projection.principalText,
        projection.scenarioText,
        ...projection.surfaces,
      ].map((value) => String(value || "").trim()).filter(Boolean))].join("\n")
    : fullText;
  const questionNameKey = normalizeOfficialQaQuery(identityText);
  const questionNames = [record.cardName, ...(record.cards || []), ...(record.cardNames || [])]
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = normalizeOfficialQaQuery(value);
      return key && key.length >= 2 && questionNameKey.includes(key);
    });
  const normalizedRecordQuestionVariants = questionSurfaces
    .map(normalizeOfficialQaQuery)
    .filter(Boolean);
  const normalizedRecordPrincipalQuestionVariants = projection.principalSurfaces
    .map(normalizeOfficialQaQuery)
    .filter(Boolean);
  const normalizedRecordQuestionSkeletonVariants = questionSurfaces
    .map(normalizeOfficialQaSkeleton)
    .filter(Boolean);
  const questionEvidenceText = questionSurfaces.join("\n");
  const recordRelatedMetadataIds = new Set([
    record.cardId,
    ...(record.metadataCardIds || record.cardIds || []),
    ...(record.cards || []).filter((value) => /^\d+$/u.test(String(value || "").trim())),
  ].map(normalizeId).filter(Boolean));
  const features = {
    questionText,
    scenarioQuestionText,
    normalizedRecordQuestion: normalizedRecordQuestionVariants[0] || "",
    normalizedRecordQuestionVariants: normalizedRecordQuestionVariants.length
      ? normalizedRecordQuestionVariants
      : [""],
    normalizedRecordPrincipalQuestionVariants: normalizedRecordPrincipalQuestionVariants.length
      ? normalizedRecordPrincipalQuestionVariants
      : [""],
    normalizedRecordQuestionSkeleton: normalizedRecordQuestionSkeletonVariants[0] || "",
    normalizedRecordQuestionSkeletonVariants: normalizedRecordQuestionSkeletonVariants.length
      ? normalizedRecordQuestionSkeletonVariants
      : [""],
    normalizedRecordText: normalizeOfficialQaQuery(identityText),
    evidenceType: classifyOfficialQaQuestionType(scenarioQuestionText || questionText),
    evidencePhrases: extractOfficialQaEffectPhrases(questionEvidenceText),
    evidenceConcepts: extractOfficialQaSemanticConcepts(questionEvidenceText),
    questionBranches: projection.branches.map((branch, branchIndex) => ({
      branchIndex,
      text: branch,
      cardIds: new Set([
        ...extractInlineOfficialCardIds(branch),
        ...(projection.branches.length === 1 ? projection.principalCardIds : []),
      ].map(normalizeId).filter(Boolean)),
      questionType: classifyOfficialQaQuestionType(branch),
      phrases: extractOfficialQaEffectPhrases(branch),
      concepts: extractOfficialQaSemanticConcepts(branch),
    })),
    recordIds: new Set((scenarioQa
      ? projection.principalCardIds
      : [
          record.cardId,
          ...(record.cardIds || []),
          ...(record.cards || []).filter((value) => /^\d+$/u.test(String(value || "").trim())),
          ...extractInlineCardIds(fullText),
        ]
    ).map(normalizeId).filter(Boolean)),
    recordQuestionIds: new Set([
      ...projection.principalCardIds,
    ].map(normalizeId).filter(Boolean)),
    // Source-level card metadata is allowed to retrieve a related Q&A even
    // when a broad official question names no particular card. It is never
    // folded into recordQuestionIds and therefore cannot grant direct status.
    recordRelatedMetadataIds,
    recordIdentityText: [identityText, ...questionNames].filter(Boolean).join(" "),
    questionIdentityText: scenarioQa ? identityText : questionText,
  };
  if (record && typeof record === "object") officialQaRecordFeatureCache.set(record, features);
  return features;
}

function normalizeOfficialQaSkeleton(value) {
  return normalizeOfficialQaQuery(
    String(value || "")
      .replace(/「[^」\r\n]{1,100}」/gu, " card ")
      .replace(/<<\s*\d{1,10}\s*>>/gu, " card "),
  );
}

function extractInlineCardIds(value) {
  return [...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)]
    .map((match) => match[1]);
}

function containmentScore(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (!left.includes(right) && !right.includes(left)) return 0;
  return Math.min(left.length, right.length) / Math.max(left.length, right.length);
}

function diceSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = bigrams(left);
  const b = bigrams(right);
  const overlap = [...a].filter((item) => b.has(item)).length;
  return (2 * overlap) / Math.max(1, a.size + b.size);
}

function setDiceSimilarity(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((item) => b.has(item)).length;
  return (2 * overlap) / (a.size + b.size);
}

function bigrams(value) {
  const result = new Set();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function isScenarioOfficialQaRecord(record = {}) {
  return record.recordType === "qa" || record.recordType === "official-database";
}

function selectSupportingQuestionBranch({
  branches = [],
  query,
  queryType,
  queryConcepts = [],
  queryPhrases = [],
  resolvedIds,
  resolvedCards = [],
  queryPlayerRoleSignature,
  requireFullQueryIdentity = false,
} = {}) {
  const queryMatchingConcepts = normalizeSemanticConceptsForMatching(queryConcepts);
  const candidates = (branches || []).map((branch) => {
    const relatedCardIds = branch.relatedCardIds || branch.cardIds;
    const matchedCardIds = [...resolvedIds].filter((id) => relatedCardIds.has(id));
    const unmatchedCardIds = [...relatedCardIds].filter((id) => !resolvedIds.has(id));
    const typeCompatible = questionTypeCompatible(queryType, branch.questionType);
    const branchMatchingConcepts = normalizeSemanticConceptsForMatching(branch.concepts);
    const semanticHits = queryMatchingConcepts
      .filter((concept) => branchMatchingConcepts.includes(concept));
    const phraseHits = queryPhrases.filter((phrase) => branch.phrases.includes(phrase));
    const scenarioPremiseComparison = compareEvidenceScenarioPremises(query, branch.text);
    const playerRoleComparison = comparePlayerRoleSignatures(
      queryPlayerRoleSignature,
      extractPlayerRoleSignature(branch.text, { cards: resolvedCards }),
    );
    const identityCoverage = resolvedIds.size ? matchedCardIds.length / resolvedIds.size : 0;
    const semanticCoverage = queryMatchingConcepts.length
      ? semanticHits.length / queryMatchingConcepts.length
      : 0;
    const score = (matchedCardIds.length * 10)
      + (identityCoverage * 4)
      + (semanticHits.length * 2)
      + semanticCoverage
      + Number(typeCompatible)
      + scenarioPremiseCompatibilityRank(scenarioPremiseComparison.compatibility)
      - Number(playerRoleComparison.compatibility === "mismatch") * 20
      - Number(scenarioPremiseComparison.compatibility === "mismatch") * 20;
    return {
      ...branch,
      relatedCardIds,
      matchedCardIds,
      unmatchedCardIds,
      typeCompatible,
      semanticHits,
      phraseHits,
      scenarioPremiseComparison,
      playerRoleComparison,
      score,
    };
  }).filter((candidate) => (
    candidate.matchedCardIds.length > 0
    && (!requireFullQueryIdentity || candidate.matchedCardIds.length === resolvedIds.size)
    && candidate.unmatchedCardIds.length === 0
    && candidate.typeCompatible
    && candidate.playerRoleComparison.compatibility !== "mismatch"
    && candidate.scenarioPremiseComparison.compatibility !== "mismatch"
    && (candidate.phraseHits.length > 0 || candidate.semanticHits.length >= 2)
  ));
  const ranked = candidates.sort((left, right) => right.score - left.score);
  const top = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  if (!top || !runnerUp) return top;
  const topIdentity = [...top.cardIds].sort().join(",");
  const runnerUpIdentity = [...runnerUp.cardIds].sort().join(",");
  // If two different official branches are equally supported, choosing the
  // first one would make source ordering decide applicability. Fail closed and
  // keep the record only as ordinary related material.
  if (Math.abs(top.score - runnerUp.score) < 0.001
      && topIdentity !== runnerUpIdentity) return null;
  return top;
}

function extractOperationFamilies(concepts = []) {
  return [...new Set((concepts || [])
    .map((concept) => OPERATION_CONCEPT_FAMILIES.get(concept))
    .filter(Boolean))];
}

function normalizeSemanticConceptsForMatching(concepts = []) {
  return [...new Set((concepts || []).map(
    (concept) => OPERATION_CONCEPT_FAMILIES.get(concept) || concept,
  ))];
}

function scenarioPremiseCompatibilityRank(value) {
  return ({ compatible: 4, conditional: 3, partial: 2, unknown: 1, mismatch: 0 })[value] ?? 0;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildEntityResolution(resolved, unresolved, resolvedByOfficialQaMatch) {
  return {
    resolvedCards: [...resolved.values()],
    unresolvedMentions: unresolved,
    ambiguousMentions: unresolved.filter((item) => (item.candidateCards || []).length > 1),
    resolvedByOfficialQaMatch,
    confidence: resolvedByOfficialQaMatch ? 0.92 : unresolved.length ? 0.45 : 1,
  };
}

function findCard(id, cards) {
  const key = normalizeId(id);
  return (cards || []).find((card) => normalizeId(card.id || card.cardId) === key) || null;
}

function cardAliases(card = {}) {
  return [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
}

/**
 * Bind only exact aliases that occur in the projected official question.
 *
 * The binding is deliberately local to the already resolved query cards. An
 * alias shared by multiple cards is ambiguous and binds none of them. Longer
 * overlapping names claim their span before shorter names, so a short card
 * name embedded in a longer exact card name cannot create a second identity.
 * The result is a related-retrieval signal only.
 */
function matchQuestionSideCardAliases(value, cards = []) {
  const text = normalizeOfficialQaQuery(value);
  if (!text) return new Set();

  const ownersByAlias = new Map();
  for (const card of cards || []) {
    const id = normalizeId(card.id || card.cardId);
    if (!id) continue;
    for (const alias of cardAliases(card)) {
      const key = normalizeOfficialQaQuery(alias);
      if (key.length < 2) continue;
      const owners = ownersByAlias.get(key) || new Set();
      owners.add(id);
      ownersByAlias.set(key, owners);
    }
  }

  const occurrences = [];
  for (const [alias, owners] of ownersByAlias) {
    let offset = 0;
    while (offset < text.length) {
      const start = text.indexOf(alias, offset);
      if (start < 0) break;
      occurrences.push({
        start,
        end: start + alias.length,
        length: alias.length,
        owners: new Set(owners),
      });
      offset = start + Math.max(1, alias.length);
    }
  }
  occurrences.sort((left, right) => (
    right.length - left.length
    || left.start - right.start
    || left.end - right.end
  ));

  const selected = [];
  for (const occurrence of occurrences) {
    const overlapping = selected.filter((item) => spansOverlap(item, occurrence));
    if (!overlapping.length) {
      selected.push(occurrence);
      continue;
    }
    const longest = Math.max(...overlapping.map((item) => item.length));
    if (longest > occurrence.length) continue;
    // Equal-length overlapping surfaces disagreeing on identity are ambiguous.
    for (const item of overlapping) {
      for (const owner of occurrence.owners) item.owners.add(owner);
    }
  }

  return new Set(selected
    .filter((item) => item.owners.size === 1)
    .map((item) => [...item.owners][0]));
}

function spansOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}

function cardKey(card = {}) {
  return normalizeId(card.id || card.cardId) || normalizeOfficialQaQuery(card.cnName || card.name || card.jaName || card.enName);
}
