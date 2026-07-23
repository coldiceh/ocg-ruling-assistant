// Frozen software snapshot from Git revision 4d95ecc96.
import { createDestinationReplacement, createEffectPrimitive } from "./effectPrimitives.mjs";
import { evaluateFusionOperation, resolveEffectChain } from "./effectResolutionEngine.mjs";
import { splitEffectTextBlocks } from "./cardEffectBlocks.mjs";

const RETURN_TO_HAND = /(?:放回|返回|回到).{0,12}(?:手牌|手卡|手札)|(?:手牌|手卡|手札).{0,12}(?:放回|返回|回到)|return.{0,20}(?:to )?(?:the )?hand/isu;
const LOWEST_DEFENSE = /(?:守备力|守備力|防御力|防禦力).{0,8}(?:最低|最小|一番低)|lowest\s+DEF/iu;
const SPECIAL_SUMMON_SOURCE_FROM_HAND = /(?:从|從)手(?:牌|卡)将?此卡特殊召唤|手札からこのカードを特殊召喚|Special Summon this card from your hand/iu;
const FORCE_FACE_UP_MONSTERS_TO_DEFENSE = /场上的表侧表示怪兽变为守备表示|場上的表側表示怪獸變為守備表示|フィールドの表側表示モンスターは守備表示にな|face-up monsters on the field.{0,24}Defense Position/iu;
const NEGATE_DEFENSE_ACTIVATIONS = /守备表示怪兽发动的效果无效|守備表示怪獸發動的效果無效|守備表示モンスターが発動した効果は無効|activated effects? of monsters?.{0,32}Defense Position.{0,24}negat/iu;
const DEFENSE_CARRIER_CONDITION = /此卡以守备表示存在于怪兽区域|此卡以守備表示存在於怪獸區域|このカードがモンスターゾーンに守備表示で存在|this card is in Defense Position in the Monster Zone/iu;
const SUMMON_TRIGGER = /(?:召唤|召喚|特殊召唤|特殊召喚).{0,30}(?:情况下|场合|場合)|(?:if|when) this card is (?:Normal or Special )?Summoned/iu;
const SELF_SUMMON_TRIGGER = /(?:此卡|这张卡|這張卡).{0,12}(?:召唤|召喚|特殊召唤|特殊召喚).{0,18}(?:时|時|情况下|場下|场合|場合)|このカード.{0,12}(?:召喚|特殊召喚).{0,18}(?:時|場合)|(?:if|when) this card is (?:Normal or Special )?Summoned/iu;
const DISCARD_ONE_HAND_COST = /(?:舍弃|丢弃|捨てる?)\s*1张手牌.{0,12}(?:可以发动|発動できる)|discard 1 card.{0,20}(?:activate|;)/iu;
const FUSION_OPERATION = /作为融合素材.{0,30}融合召唤|融合素材.{0,30}融合召喚|Fusion Summon.{0,50}(?:materials?|using)/iu;
const UNAFFECTED_BY_OTHER_EFFECTS = /不受此卡以外的效果影响|このカード以外の効果を受けない|unaffected by other card effects/iu;
const SELF_IN_MONSTER_ZONE = /(?:此卡|这张卡|這張卡|このカード|this card).{0,24}(?:怪兽区域|怪獸區域|モンスターゾーン|Monster Zone)/iu;
const PER_PLAYER_SAME_RACE_LIMIT = /(?:双方|雙方|お互い|each player).{0,36}(?:各|それぞれ|only).{0,18}(?:1|１|一)(?:只|隻|体|體|枚)?.{0,24}(?:同种族|同種族|同じ種族|same Type).{0,24}(?:表侧|表側|face-up)/iu;
const OPPONENT_GRAVE_TO_BANISHED = /(?:被送(?:往|去|至).{0,8}(?:对手|對手|对方|對方)墓地的卡.{0,18}(?:不去墓地|不会去墓地|不进入墓地).{0,12}除外|相手の墓地へ送られるカード.{0,24}墓地へは行かず除外|cards?.{0,24}sent to your opponent(?:'s)? (?:GY|Graveyard).{0,24}banish)/iu;

export function analyzeDuelStateTransition({
  userQuery = "",
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const query = String(userQuery || "");
  const programs = compileResolvedCardPrograms(resolvedCards, cardTexts);
  const compiled = compileQuestionScenario({ query, programs });
  if (!compiled.complete) return notApplicable(compiled.reason, compiled);

  const simulation = resolveEffectChain({
    gameState: compiled.gameState,
    chainLinks: compiled.chainLinks,
    continuousEffects: compiled.continuousEffects,
  });
  if (!simulation.complete) {
    const illegalMandatorySummon = renderIllegalMandatorySummonActivation({
      programs,
      compiled,
      simulation,
      cardTexts,
    });
    if (illegalMandatorySummon) return illegalMandatorySummon;
    return notApplicable("compiled_chain_not_complete", { compiled, simulation });
  }

  const firstLink = [...simulation.linkResults].sort((left, right) => left.order - right.order)[0];
  const firstPreparedLink = simulation.preparedChainLinks.find((link) => link.id === firstLink?.id);
  if (!firstLink || !firstPreparedLink) return notApplicable("questioned_chain_link_not_compiled", { compiled, simulation });
  const activationResult = simulation.activationResults.find((item) => item.id === firstPreparedLink.id);
  const activationBasis = firstPreparedLink.activationPremise === "declared_legal"
    ? "declared_legal"
    : "derived_from_simulation";
  const fusionOutcome = firstLink.primitiveResult?.outcomes?.find((item) => item.type === "fusion_summon");
  if (fusionOutcome) {
    return renderFusionTransition({
      query,
      programs,
      compiled,
      simulation,
      firstLink,
      firstPreparedLink,
      activationResult,
      activationBasis,
      cardTexts,
      fusionOutcome,
    });
  }
  if (activationBasis !== "declared_legal") return notApplicable("activation_legality_not_declared", { compiled, simulation });

  const firstSource = programByDefinitionId(programs, firstPreparedLink.sourceDefinitionId);
  const negatorInstance = instanceById(compiled.gameState.cards, firstLink.negatedBy);
  const negator = programByDefinitionId(programs, negatorInstance?.definitionId);
  const laterLinks = [...simulation.linkResults].filter((item) => item.order > firstLink.order).sort((a, b) => b.order - a.order);
  const laterSummary = laterLinks
    .map((item) => summarizeResolvedLink(item, simulation.preparedChainLinks, compiled.gameState.cards, programs))
    .filter(Boolean);
  const stabilization = simulation.trace.find((item) => (
    item.phase === "stabilize_continuous_effects"
    && String(item.cardId) === String(firstPreparedLink.sourceInstanceId)
    && item.operation === "set_position"
    && item.after
  ));
  const effect = firstSource?.activatedEffects.find((item) => item.id === firstPreparedLink.effectId);
  const evidenceIds = unique(programs
    .filter((program) => compiled.referencedDefinitionIds.includes(program.definitionId))
    .map((program) => evidenceIdFor(program, cardTexts)));
  const correction = effect?.selectionRule === "lowest_defense" && /(?:守备力|防御力|守備力|防禦力).{0,8}(?:最高|最大)/u.test(query)
    ? firstLink.status === "negated"
      ? "题述的“守备力最高”与卡文不一致：该处理实际选择守备力最低的怪兽；不过本题该处理被无效，不会选择任何怪兽。"
      : "题述的“守备力最高”与卡文不一致：该处理实际选择守备力最低的怪兽。"
    : "";
  const sourceName = firstSource?.name || firstLink.sourceCardName || "C1发动源";
  const negatorName = negator?.name || "持续效果来源";
  const stabilizerInstance = instanceById(compiled.gameState.cards, stabilization?.sourceCardId);
  const stabilizer = programByDefinitionId(programs, stabilizerInstance?.definitionId);
  const stabilizerName = stabilizer?.name || stabilizerInstance?.name || "持续效果来源";
  const activationConclusion = `按题设已满足展示等发动手续，C${firstLink.order}可以发动。`;
  const stabilizationConclusion = stabilization
    ? stabilization.before === "unknown"
      ? `进入发动窗口前，「${stabilizerName}」的持续效果先将「${sourceName}」的表示形式确定为${positionLabel(stabilization.after)}。`
      : `进入发动窗口前，「${stabilizerName}」的持续效果先将「${sourceName}」从${positionLabel(stabilization.before)}变为${positionLabel(stabilization.after)}。`
    : firstLink.activationSnapshot?.sourcePosition && firstLink.activationSnapshot.sourcePosition !== "unknown"
      ? `进入发动窗口前持续效果已经稳定，「${sourceName}」处于${positionLabel(firstLink.activationSnapshot.sourcePosition)}。`
      : "";

  if (firstLink.status !== "negated") {
    const resolutionConclusion = firstLink.status === "resolved"
      ? `C${firstLink.order}按卡片文本完成效果处理。`
      : `C${firstLink.order}的处理结果为${firstLink.status}。`;
    return {
      status: "resolved",
      complete: true,
      activation: "assumed_legal",
      activationBasis,
      resolution: firstLink.status,
      shortAnswer: [stabilizationConclusion, activationConclusion, laterSummary.join(""), resolutionConclusion, correction].filter(Boolean).join(""),
      reasoning: [
        `${activationConclusion}这里的发动合法性是题设声明的前提，不由最终是否被无效反推。`,
        ...laterSummary,
        resolutionConclusion,
        correction,
      ].filter(Boolean),
      trace: [...(compiled.stateInferences || []), declaredActivationTrace(firstPreparedLink), ...simulation.trace],
      evidenceIds,
      activationEvidenceType: "declared_legal_premise",
      program: serializeCompiledSimulation(programs, compiled, simulation),
    };
  }

  const shortParts = [
    stabilizationConclusion,
    activationConclusion,
    laterSummary.join(""),
    `C${firstLink.order}「${sourceName}」处理时，发动时快照满足「${negatorName}」持续效果的无效条件，因此该效果被无效，不进行这个连锁项的效果处理。`,
    correction,
  ].filter(Boolean);
  const reasoning = [
    `${activationConclusion}这里的发动合法性是题设声明的前提，不由后续无效与否反推。`,
    stabilizationConclusion,
    `C${firstLink.order}入连锁时冻结发动快照：发动源区域为${zoneLabel(firstLink.activationSnapshot?.sourceZone)}，表示形式为${positionLabel(firstLink.activationSnapshot?.sourcePosition)}。之后发动源离场不会改写这个快照。`,
    ...laterSummary,
    `轮到C${firstLink.order}处理时重新检查持续效果来源；「${negatorName}」仍满足其适用条件，且发动时快照命中其无效范围，因此C${firstLink.order}不执行效果处理。`,
    correction,
  ].filter(Boolean);

  return {
    status: "resolved",
    complete: true,
    activation: "assumed_legal",
    activationBasis,
    resolution: "negated",
    shortAnswer: shortParts.join(""),
    reasoning,
    trace: [...(compiled.stateInferences || []), declaredActivationTrace(firstPreparedLink), ...simulation.trace],
    evidenceIds,
    activationEvidenceType: "declared_legal_premise",
    program: serializeCompiledSimulation(programs, compiled, simulation),
  };
}

function renderFusionTransition({
  programs,
  compiled,
  simulation,
  firstLink,
  firstPreparedLink,
  activationResult,
  activationBasis,
  cardTexts,
  fusionOutcome,
}) {
  const source = programByDefinitionId(programs, firstPreparedLink.sourceDefinitionId);
  const fusionPrimitive = firstPreparedLink.sequence
    .map((item) => item.primitive || item)
    .find((primitive) => primitive.type === "fusion_summon");
  const preCostEvaluation = evaluateFusionOperation(compiled.gameState, fusionPrimitive);
  if (preCostEvaluation.status !== "performable") {
    return notApplicable("fusion_pre_cost_evaluation_not_reproducible", { compiled, simulation, preCostEvaluation });
  }
  const costStage = activationResult?.stageResults?.find((item) => item.stage === "pay_activation_cost")?.result;
  const hasActivationCost = Boolean(firstPreparedLink.activationCostSequence?.length);
  if (hasActivationCost && !costStage) {
    return notApplicable("fusion_activation_cost_trace_missing", { compiled, simulation });
  }
  const discardChanges = (costStage?.stateChanges || []).filter((item) => item.type === "discard_from_hand");
  const discardedIds = discardChanges.flatMap((item) => item.cardIds || []);
  const discardedCards = discardedIds.map((instanceId) => (
    instanceById(costStage?.gameState?.cards, instanceId)
      || instanceById(compiled.gameState.cards, instanceId)
  )).filter(Boolean);
  if (hasActivationCost && !discardedCards.length) {
    return notApplicable("fusion_activation_cost_trace_missing", { compiled, simulation });
  }
  const postCostState = costStage?.gameState || compiled.gameState;
  const excluded = fusionOutcome.excludedMaterials?.find((item) => item.reason === "unaffected_by_resolving_effect");
  const protectedCard = instanceById(simulation.finalGameState.cards, excluded?.instanceId)
    || instanceById(compiled.gameState.cards, excluded?.instanceId);
  const modifierTrace = (costStage?.ruleTrace || []).find((item) => (
    item.phase === "stabilize_continuous_effects"
    && item.operation === "derive_modifiers"
    && String(item.cardId) === String(protectedCard?.instanceId)
    && (item.after || []).some((modifier) => modifier.type === "unaffected_by_other_effects")
  ));

  const evidenceIds = unique(programs
    .filter((program) => compiled.referencedDefinitionIds.includes(program.definitionId))
    .flatMap((program) => program.evidenceIds?.length ? program.evidenceIds : [evidenceIdFor(program, cardTexts)]));
  const sourceName = source?.name || firstPreparedLink.sourceCardName || "发动源";
  const costNames = discardedCards.map((card) => card.name || "作为费用丢弃的卡");
  const costLabel = costNames.join("、");
  const protectedName = protectedCard?.name || excluded?.name || "";
  const trace = [
    {
      phase: "activation_check",
      state: "S0",
      status: "legal",
      conclusion: `支付 cost 前，用同一个融合素材匹配器检查：包含「${sourceName}」在内存在完整的合法素材组合，因此可以发动。`,
      stateSnapshot: serializeDuelState(compiled.gameState),
      proof: preCostEvaluation,
    },
  ];
  if (hasActivationCost) {
    trace.push({
      phase: "pay_activation_cost",
      state: "S0_to_S1",
      status: "applied",
      conclusion: `作为 cost，将「${costLabel}」从手牌送入墓地。`,
      stateSnapshot: serializeDuelState(postCostState),
      proof: discardChanges,
    });
  }
  if (modifierTrace && protectedName) {
    trace.push({
      phase: "stabilize_continuous_effects",
      state: "S1",
      status: "applied",
      conclusion: `cost 支付后立即重算持续效果；「${protectedName}」开始不受自身以外的效果影响。`,
      stateSnapshot: serializeDuelState(postCostState),
      proof: modifierTrace,
    });
  }

  if (fusionOutcome.status === "performed") {
    const summonedCard = instanceById(simulation.finalGameState.cards, fusionOutcome.candidateInstanceId)
      || instanceById(compiled.gameState.cards, fusionOutcome.candidateInstanceId);
    const materialNames = (fusionOutcome.assignment || []).map((item) => item.name || (
      instanceById(compiled.gameState.cards, item.instanceId)?.name
    )).filter(Boolean);
    const summonedName = summonedCard?.name || "融合怪兽";
    trace.push({
      phase: "resolve_effect_operation",
      state: hasActivationCost ? "S1" : "S0",
      status: "performed",
      conclusion: `处理融合操作时再次运行同一素材匹配器；以「${materialNames.join("」「")}」作为素材，融合召唤「${summonedName}」。`,
      stateSnapshot: serializeDuelState(simulation.finalGameState),
      proof: fusionOutcome,
    });
    const costClause = hasActivationCost ? `「${costLabel}」作为 cost 进入墓地后，` : "";
    const exclusionClause = protectedName
      ? `「${protectedName}」不受这次效果影响而不能作为素材，但仍有另一组完整的合法素材，`
      : "";
    return {
      status: "resolved",
      complete: true,
      activation: "legal",
      activationBasis,
      resolution: "performed",
      shortAnswer: `可以发动；${costClause}${exclusionClause}处理时进行融合召唤「${summonedName}」。`,
      reasoning: trace.map((item) => item.conclusion),
      trace,
      evidenceIds,
      activationEvidenceType: "effect_program",
      program: serializeCompiledSimulation(programs, compiled, simulation),
    };
  }

  if (fusionOutcome.status !== "not_performed") {
    return notApplicable("fusion_outcome_not_supported", { compiled, simulation, fusionOutcome });
  }
  const immunityEstablished = Boolean(protectedCard && modifierTrace);
  trace.push({
      phase: "resolve_effect_operation",
      state: hasActivationCost ? "S1" : "S0",
      status: "not_performed",
      conclusion: immunityEstablished
        ? `处理融合操作时再次运行同一素材匹配器；「${protectedName}」因不受该效果影响而不能作为素材，已知素材无法完成素材式，因此不进行融合召唤。`
        : "处理融合操作时再次运行同一素材匹配器；当前已知素材无法完成素材式，因此不进行融合召唤。",
      stateSnapshot: serializeDuelState(simulation.finalGameState),
      proof: fusionOutcome,
  });
  const costClause = hasActivationCost ? `「${costLabel}」作为 cost 进入墓地后，` : "";
  const reasonClause = immunityEstablished
    ? `「${protectedName}」开始不受这次效果影响，处理时不能再作为融合素材，`
    : "处理时已不存在完整的合法素材组合，";
  return {
    status: "resolved",
    complete: true,
    activation: "legal",
    activationBasis,
    resolution: "not_performed",
    shortAnswer: `可以发动，但是不会进行任何效果处理；${costClause}${reasonClause}因此不进行融合召唤。`,
    reasoning: trace.map((item) => item.conclusion),
    trace,
    evidenceIds,
    activationEvidenceType: "effect_program",
    program: serializeCompiledSimulation(programs, compiled, simulation),
  };
}

export function compileResolvedCardPrograms(resolvedCards = [], cardTexts = []) {
  const definitions = new Map();
  for (const card of mergeDefinitionSources(resolvedCards, cardTexts)) {
    const definitionId = String(card.definitionId || card.id || card.cardId || "");
    if (!definitionId || definitions.has(definitionId)) continue;
    const text = String(card.effectText || card.text || "");
    const names = unique(card.names || [
      card.input,
      card.matchedQuery,
      card.name,
      card.cnName,
      card.jaName,
      card.enName,
      ...(card.aliases || []),
    ]);
    const activatedEffects = [];
    const continuousEffects = [];
    const effectCategoryInference = inferEffectCategory(card.cardType, text);
    const effectCategory = effectCategoryInference.category;
    const monsterOnlyCompileIncomplete = effectCategory === "monster"
      ? {}
      : { compileIncompleteReason: "effect_source_category_not_supported" };
    const effectBlocks = splitEffectTextBlocks(text);
    const sharedRestrictionText = effectBlocks
      .filter((block) => block.kind === "preamble")
      .map((block) => block.text)
      .join("\n");

    for (const block of effectBlocks) {
      const blockText = block.text;
      if (block.kind === "preamble") continue;
      if (LOWEST_DEFENSE.test(blockText) && RETURN_TO_HAND.test(blockText)) {
        activatedEffects.push({
          id: `${definitionId}:${block.id}:return-lowest-defense`,
          effectBlockId: block.id,
           activationZone: "monster_zone",
           effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          ...monsterOnlyCompileIncomplete,
          actionTags: ["return_to_hand", "defense_value"],
          selectionRule: "lowest_defense",
          sharedRestrictionText,
          activationRequirementText: activationRequirement(blockText),
          sequence: [{
            id: "return-lowest-defense",
            connector: "INDEPENDENT",
            primitive: createEffectPrimitive("return_lowest_defense_monster_to_hand"),
          }],
        });
      }

      if (RETURN_TO_HAND.test(blockText) && SPECIAL_SUMMON_SOURCE_FROM_HAND.test(blockText)) {
        activatedEffects.push({
          id: `${definitionId}:${block.id}:swap-field-target-with-source`,
          effectBlockId: block.id,
           activationZone: "hand",
           effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          ...monsterOnlyCompileIncomplete,
          actionTags: ["return_to_hand", "special_summon", "swap"],
          sharedRestrictionText,
          activationRequirementText: activationRequirement(blockText),
          targetSelector: { controller: "same_as_source", zone: "monster_zone", excludeSource: true },
          sequence: [
            {
              id: "return-target-to-hand",
              connector: "INDEPENDENT",
              primitive: createEffectPrimitive("return_target_to_hand", { targetExpectedZone: "monster_zone" }),
            },
            {
              id: "special-summon-source",
              connector: "THEN",
              primitive: createEffectPrimitive("special_summon_source", {
                sourceExpectedZone: "hand",
                destinationZone: "monster_zone",
              }),
            },
          ],
        });
      }

      if (FUSION_OPERATION.test(blockText)) {
        const hasSummonTrigger = SUMMON_TRIGGER.test(blockText);
        const hasDiscardCost = DISCARD_ONE_HAND_COST.test(blockText);
        const materialPool = parseFusionMaterialPool(blockText);
        activatedEffects.push({
          id: `${definitionId}:${block.id}:fusion-summon`,
          effectBlockId: block.id,
          activationZones: fusionActivationZones(effectCategory),
          effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          ...(effectCategory === "unknown" ? { compileIncompleteReason: "effect_source_category_not_supported" } : {}),
          actionTags: ["fusion_summon"],
          sharedRestrictionText,
          activationRequirementText: activationRequirement(blockText),
          ...(!materialPool ? { compileIncompleteReason: "fusion_material_pool_not_compiled" } : {}),
          trigger: hasSummonTrigger ? { type: "source_event", event: "summoned" } : null,
          costSpec: hasDiscardCost ? { type: "discard_from_hand", amount: 1, player: "self" } : null,
          fusionSpec: {
            interaction: "effect_affecting",
            sourceMustBeMaterial: /包含此卡在内|このカードを含む|including this card/iu.test(blockText),
            excludeOtherOwnMonsters: /不可将自己场上其他的怪兽作为融合素材|自分フィールドの他のモンスターを融合素材にできない|cannot use other monsters you control/iu.test(blockText),
            materialPool,
          },
        });
      }

      const mandatorySpecialSummonOutputs = parseMandatorySpecialSummonOutputs(blockText, card.race);
      if (mandatorySpecialSummonOutputs.length >= 2) {
        activatedEffects.push({
          id: `${definitionId}:${block.id}:mandatory-special-summons`,
          effectBlockId: block.id,
          activationZone: SPECIAL_SUMMON_SOURCE_FROM_HAND.test(blockText) ? "hand" : "monster_zone",
          effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          ...monsterOnlyCompileIncomplete,
          actionTags: ["special_summon", "mandatory_multi_player_summon"],
          sharedRestrictionText,
          activationRequirementText: activationRequirement(blockText),
          mandatorySpecialSummonOutputs,
          analysisScope: "activation_only",
          sequence: [],
        });
      }

      const constraints = [];
      const resolutionModifiers = [];
      if (FORCE_FACE_UP_MONSTERS_TO_DEFENSE.test(blockText)) {
        constraints.push({
          type: "set_position",
          selector: { zone: "monster_zone", faceUp: true, cardKind: "monster" },
          position: "defense",
        });
      }
      if (NEGATE_DEFENSE_ACTIVATIONS.test(blockText)) {
        resolutionModifiers.push({
          type: "negate_activated_effect",
          effectCategory: "monster",
          sourcePositionAtActivation: "defense",
          sourceSelector: {
            zoneAtActivation: "monster_zone",
            faceUpAtActivation: true,
            positionAtActivation: "defense",
          },
        });
      }
      if (constraints.length || resolutionModifiers.length) {
        continuousEffects.push({
          id: `${definitionId}:${block.id}:continuous-position-program`,
          definitionCardId: definitionId,
          sourceDefinitionId: definitionId,
          sourceCardName: card.name || card.cnName || names[0] || "unknown",
           effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          ...monsterOnlyCompileIncomplete,
          activeWhen: {
            zone: "monster_zone",
            faceUp: true,
            ...(DEFENSE_CARRIER_CONDITION.test(blockText) ? { position: "defense" } : {}),
          },
          constraints,
          resolutionModifiers,
        });
      }

      if (PER_PLAYER_SAME_RACE_LIMIT.test(blockText)) {
        const activeZone = effectCategory === "monster" ? "monster_zone" : "spell_trap_zone";
        continuousEffects.push({
          id: `${definitionId}:${block.id}:per-player-race-limit`,
          definitionCardId: definitionId,
          sourceDefinitionId: definitionId,
          sourceCardName: card.name || card.cnName || names[0] || "unknown",
          effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          activeWhen: { zone: activeZone, faceUp: true },
          fieldRestrictions: [{
            type: "max_face_up_monsters_per_race_per_player",
            maxCount: 1,
          }],
        });
      }

      if (OPPONENT_GRAVE_TO_BANISHED.test(blockText)) {
        continuousEffects.push({
          id: [definitionId, block.id, "opponent-grave-destination-replacement"].join(":"),
          definitionCardId: definitionId,
          sourceDefinitionId: definitionId,
          sourceCardName: card.name || card.cnName || names[0] || "unknown",
          effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          activeWhen: {
            zone: SELF_IN_MONSTER_ZONE.test(blockText) || effectCategory === "monster"
              ? "monster_zone"
              : "spell_trap_zone",
            faceUp: true,
          },
          destinationReplacements: [createDestinationReplacement({
            id: "opponent-grave-to-banished",
            intendedToZone: "graveyard",
            replacementToZone: "banished",
            destinationPlayerRelation: "opponent_of_source_controller",
          })],
        });
      }

      if (UNAFFECTED_BY_OTHER_EFFECTS.test(blockText)) {
        const parsedCondition = parseContinuousExistsCondition(blockText);
        const conditionRequired = /只要|只要有|存在.{0,36}(?:不受|unaffected)|as long as|while/iu.test(blockText);
        continuousEffects.push({
          id: `${definitionId}:${block.id}:conditional-unaffected`,
          definitionCardId: definitionId,
          sourceDefinitionId: definitionId,
          sourceCardName: card.name || card.cnName || names[0] || "unknown",
           effectCategory,
          effectCategoryBasis: effectCategoryInference.basis,
          ...monsterOnlyCompileIncomplete,
          activeWhen: { zone: "monster_zone", faceUp: true },
          stateConditions: parsedCondition ? [parsedCondition] : [],
          ...(!parsedCondition && conditionRequired
            ? { compileIncompleteReason: "continuous_condition_not_compiled" }
            : {}),
          grantedModifiers: [{
            type: "unaffected_by_other_effects",
            recipient: "source",
            exceptEffectSource: "self",
          }],
        });
      }
    }

    const summonKinds = inferSummonKinds(card.cardType, text);
    definitions.set(definitionId, {
      definitionId,
      name: card.name || card.cnName || names[0] || "unknown",
      names,
      input: String(card.input || ""),
      cardType: String(card.cardType || ""),
      race: String(card.race || ""),
      effectCategory,
      effectCategoryBasis: effectCategoryInference.basis,
      summonKinds,
      defense: Number.isFinite(Number(card.defense ?? card.def)) ? Number(card.defense ?? card.def) : undefined,
      effectText: text,
      effectBlocks,
      sharedRestrictionText,
      materialRecipeRaw: summonKinds.includes("fusion") ? parseMaterialRecipe(text) : null,
      evidenceIds: unique(card.evidenceIds || []),
      activatedEffects,
      continuousEffects,
    });
  }
  const programs = [...definitions.values()].filter((program) => program.definitionId && program.names.length);
  for (const program of programs) {
    if (program.materialRecipeRaw) {
      const materialRecipe = bindMaterialRecipe(program.materialRecipeRaw, programs);
      if (materialRecipe.complete) {
        program.materialRecipe = materialRecipe.recipe;
        program.summonKinds = unique([...(program.summonKinds || []), "fusion"]);
      }
      else program.compileIncompleteReason = materialRecipe.reason;
    }
    for (const effect of program.continuousEffects) {
      for (const condition of effect.stateConditions || []) {
        const definitionIds = resolveDefinitionReference(condition.definitionReferenceText, programs);
        if (definitionIds.length === 1) {
          condition.selector.definitionIds = definitionIds;
        } else {
          effect.compileIncompleteReason = definitionIds.length
            ? "continuous_condition_definition_ambiguous"
            : "continuous_condition_definition_unresolved";
        }
      }
    }
  }
  return programs;
}

function parseMandatorySpecialSummonOutputs(text, sourceRace = "") {
  const value = String(text || "");
  if (!SPECIAL_SUMMON_SOURCE_FROM_HAND.test(value)) return [];
  const outputs = [{
    id: "special-summon-effect-source",
    subject: "effect_source",
    playerRelation: "same_as_source_controller",
    race: String(sourceRace || ""),
    mandatory: true,
  }];
  const connector = value.search(/然后|之後|之后|その後|then/iu);
  if (connector < 0) return outputs;
  const later = value.slice(connector);
  const opponentSummon = /(?:特殊召唤|特殊召喚).{0,20}(?:至|到|给|給)?(?:对方|對方|对手|對手|相手).{0,12}(?:场上|場上|フィールド)|(?:对方|對方|对手|對手|相手).{0,18}(?:场上|場上|フィールド).{0,18}(?:特殊召唤|特殊召喚)|Special Summon.{0,80}(?:opponent'?s field|opponent's side)/iu.test(later);
  if (!opponentSummon) return outputs;
  const tokenName = later.match(/[“「『"]([^”」』"]{2,50})[”」』"]/u)?.[1] || "生成的怪兽";
  outputs.push({
    id: "special-summon-generated-monster",
    subject: "generated_monster",
    name: tokenName,
    playerRelation: "opponent_of_source_controller",
    race: extractRaceFromText(later),
    mandatory: true,
  });
  return outputs;
}

function evaluateMandatorySpecialSummonRestrictions({ query, source, outputs, gameCards, continuousEffects }) {
  const restrictions = [];
  for (const effect of continuousEffects || []) {
    if (!effect.fieldRestrictions?.length) continue;
    const carrier = instanceById(gameCards, effect.sourceInstanceId || effect.sourceCardId);
    if (!carrier) continue;
    const activeWhen = effect.activeWhen || {};
    if (activeWhen.zone && carrier.zone !== activeWhen.zone) continue;
    if (typeof activeWhen.faceUp === "boolean" && carrier.faceUp !== activeWhen.faceUp) continue;
    for (const restriction of effect.fieldRestrictions) restrictions.push({ effect, carrier, restriction });
  }
  if (!restrictions.length) return null;

  const sourceController = normalizePlayer(source.controller);
  if (!sourceController) {
    return {
      type: "mandatory_special_summon_restriction",
      status: "unknown",
      reason: "mandatory_special_summon_controller_unknown",
    };
  }
  const resolvedOutputs = (outputs || []).map((output) => ({
    ...output,
    player: resolveOutputPlayer(output.playerRelation, sourceController),
    raceKey: normalizeRaceKey(output.race),
  }));
  if (resolvedOutputs.some((output) => !output.player || !output.raceKey)) {
    return {
      type: "mandatory_special_summon_restriction",
      status: "unknown",
      reason: "mandatory_special_summon_output_identity_unknown",
      outputs: resolvedOutputs,
    };
  }

  const facts = [
    ...extractFaceUpRaceFacts(query),
    ...(gameCards || [])
      .filter((card) => card.zone === "monster_zone" && card.faceUp === true && normalizeRaceKey(card.race))
      .map((card) => ({
        player: normalizePlayer(card.controller),
        race: String(card.race || ""),
        raceKey: normalizeRaceKey(card.race),
        count: 1,
        source: "named_field_card",
      })),
  ];
  const conflicts = [];
  for (const { effect, carrier, restriction } of restrictions) {
    if (restriction.type !== "max_face_up_monsters_per_race_per_player") continue;
    const maxCount = Number.isInteger(restriction.maxCount) ? restriction.maxCount : 1;
    for (const fact of facts) {
      const matchingOutputs = resolvedOutputs.filter((output) => output.raceKey === fact.raceKey);
      if (!matchingOutputs.length || Number(fact.count || 1) < maxCount) continue;
      const matchingPlayers = new Set(matchingOutputs.map((output) => output.player));
      const definitelyConflicts = fact.player === "either"
        ? matchingPlayers.has("self") && matchingPlayers.has("opponent")
        : fact.player === "both"
          ? matchingPlayers.size > 0
          : matchingPlayers.has(fact.player);
      if (!definitelyConflicts) continue;
      conflicts.push({
        restrictionEffectId: effect.id,
        restrictionSourceInstanceId: carrier.instanceId,
        restrictionSourceName: carrier.name,
        player: fact.player,
        race: fact.race,
        raceKey: fact.raceKey,
        existingCount: Number(fact.count || 1),
        maxCount,
        outputIds: matchingOutputs.map((output) => output.id),
      });
    }
  }
  if (!conflicts.length) {
    return {
      type: "mandatory_special_summon_restriction",
      status: "legal",
      satisfied: true,
      reason: "mandatory_special_summon_outputs_do_not_conflict_with_known_limits",
      outputs: resolvedOutputs,
    };
  }
  return {
    type: "mandatory_special_summon_restriction",
    status: "illegal",
    satisfied: false,
    reason: "mandatory_special_summon_conflicts_with_active_per_player_race_limit",
    evaluationPoint: "before_cost",
    outputs: resolvedOutputs,
    conflicts,
  };
}

function extractFaceUpRaceFacts(query) {
  const facts = [];
  const text = String(query || "");
  const playerPattern = /(?:自己|我方|自分)(?:或|或者|・|\/)(?:对方|對方|对手|對手|相手)|(?:对方|對方|对手|對手|相手)(?:或|或者|・|\/)(?:自己|我方|自分)|双方|雙方|お互い|自己|我方|自分|对方|對方|对手|對手|相手/gu;
  for (const match of text.matchAll(playerPattern)) {
    const segment = text.slice(match.index, Math.min(text.length, match.index + 120)).split(/[。；;\n]/u)[0];
    if (!/(?:怪兽区域|怪獸區域|怪兽区|怪獸區|モンスターゾーン|场上|場上|フィールド)/iu.test(segment)) continue;
    if (!/(?:表侧表示|表側表示|face-up)/iu.test(segment)) continue;
    const race = extractRaceFromText(segment);
    const raceKey = normalizeRaceKey(race);
    if (!raceKey) continue;
    facts.push({
      player: playerScopeFromText(match[0]),
      race,
      raceKey,
      count: 1,
      source: "question_explicit_face_up_race_presence",
      text: segment,
    });
  }
  return facts;
}

function extractRaceFromText(value) {
  const match = String(value || "").match(/(兽战士族|獸戰士族|獣戦士族|鸟兽族|鳥獸族|鳥獣族|海龙族|海龍族|海竜族|幻龙族|幻龍族|幻竜族|电子界族|電子界族|サイバース族|念动力族|念動力族|サイキック族|魔法师族|魔法師族|魔法使い族|爬虫类族|爬蟲類族|爬虫類族|幻神兽族|幻神獸族|幻神獣族|幻想魔族|创造神族|創造神族|岩石族|龙族|龍族|ドラゴン族|战士族|戰士族|戦士族|机械族|機械族|恶魔族|惡魔族|悪魔族|天使族|水族|不死族|アンデット族|植物族|昆虫族|昆蟲族|恐龙族|恐龍族|恐竜族|炎族|雷族|兽族|獸族|獣族|鱼族|魚族|Beast-Warrior|Winged Beast|Sea Serpent|Divine-Beast|Creator God|Spellcaster|Machine|Psychic|Cyberse|Reptile|Dinosaur|Illusion|Warrior|Dragon|Zombie|Thunder|Insect|Plant|Fiend|Fairy|Aqua|Pyro|Wyrm|Beast|Rock|Fish)/iu);
  return match?.[1] || "";
}

function normalizeRaceKey(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/族$/u, "")
    .trim();
  const aliases = {
    岩石: "rock", 龙: "dragon", 龍: "dragon", 战士: "warrior", 戰士: "warrior",
    魔法师: "spellcaster", 魔法師: "spellcaster", 机械: "machine", 機械: "machine",
    恶魔: "fiend", 惡魔: "fiend", 天使: "fairy", 水: "aqua", 不死: "zombie",
    念动力: "psychic", 念動力: "psychic", 电子界: "cyberse", 電子界: "cyberse",
    爬虫类: "reptile", 爬蟲類: "reptile", 植物: "plant", 昆虫: "insect", 昆蟲: "insect",
    恐龙: "dinosaur", 恐龍: "dinosaur", 炎: "pyro", 雷: "thunder", 幻龙: "wyrm", 幻龍: "wyrm",
    兽战士: "beast-warrior", 獸戰士: "beast-warrior", 兽: "beast", 獸: "beast",
    鸟兽: "winged beast", 鳥獸: "winged beast", 鳥獣: "winged beast",
    海龙: "sea serpent", 海龍: "sea serpent", 海竜: "sea serpent", 幻竜: "wyrm",
    鱼: "fish", 魚: "fish", 幻想魔: "illusion",
    幻神兽: "divine-beast", 幻神獸: "divine-beast", 幻神獣: "divine-beast",
    创造神: "creator god", 創造神: "creator god",
  };
  return aliases[normalized] || normalized;
}

function resolveOutputPlayer(relation, sourceController) {
  if (relation === "same_as_source_controller") return sourceController;
  if (relation === "opponent_of_source_controller") return sourceController === "self" ? "opponent" : "self";
  return normalizePlayer(relation);
}

function normalizePlayer(value) {
  if (value === "self" || value === "opponent") return value;
  return "";
}

function playerScopeFromText(value) {
  const text = String(value || "");
  const hasSelf = /自己|我方|自分/u.test(text);
  const hasOpponent = /对方|對方|对手|對手|相手/u.test(text);
  if (/双方|雙方|お互い/u.test(text)) return "both";
  if (hasSelf && hasOpponent) return "either";
  if (hasSelf) return "self";
  if (hasOpponent) return "opponent";
  return "either";
}

function renderIllegalMandatorySummonActivation({ programs, compiled, simulation, cardTexts }) {
  const activationResult = (simulation.activationResults || []).find((item) => (
    item.status === "illegal"
    && item.reason === "mandatory_special_summon_conflicts_with_active_per_player_race_limit"
  ));
  if (!activationResult) return null;
  const link = (compiled.chainLinks || []).find((item) => item.id === activationResult.id);
  const preflight = link?.activationPreconditions?.find((item) => item.type === "mandatory_special_summon_restriction");
  if (!link || !preflight?.conflicts?.length) return null;
  const source = programByDefinitionId(programs, link.sourceDefinitionId);
  const conflict = preflight.conflicts[0];
  const race = conflict.race || preflight.outputs?.[0]?.race || "相同种族";
  const restrictionName = conflict.restrictionSourceName || "该持续限制";
  const ownOutput = preflight.outputs.find((output) => output.player === "self");
  const opponentOutput = preflight.outputs.find((output) => output.player === "opponent");
  const summonDescription = [
    ownOutput && `把作为${ownOutput.race || race}怪兽的自身特殊召唤到自己场上`,
    opponentOutput && `把作为${opponentOutput.race || race}怪兽的「${opponentOutput.name || "生成的怪兽"}」特殊召唤到对方场上`,
  ].filter(Boolean).join("，并且");
  const sourceName = source?.name || link.sourceCardName || "该卡";
  const shortAnswer = `不能发动。「${sourceName}」的效果必须${summonDescription}；「${restrictionName}」正在适用且发动时自己或对方的怪兽区域已有表侧${race}怪兽，因此至少一次必做特殊召唤违反同种族数量限制。不能先假定效果处理中的解放会清空场面，再反推发动合法。`;
  const evidenceIds = unique(programs
    .filter((program) => compiled.referencedDefinitionIds.includes(program.definitionId))
    .map((program) => evidenceIdFor(program, cardTexts)));
  return {
    status: "resolved",
    complete: true,
    activation: "cannot_activate",
    activationBasis: "derived_from_activation_preflight",
    resolution: "not_started",
    shortAnswer,
    reasoning: [
      `发动前先展开全部必做输出：${summonDescription}。`,
      `再按目的玩家分别检查「${restrictionName}」的同种族表侧数量上限；已知场面与至少一个必做输出冲突。`,
      "发动合法性使用发动时状态检查，效果尚未开始处理，所以不能把前段解放后的假想状态用于放宽发动条件。",
    ],
    trace: [
      ...(compiled.stateInferences || []),
      ...(simulation.trace || []),
      { phase: "activation_preflight", status: "illegal", proof: preflight, conclusion: shortAnswer },
    ],
    evidenceIds,
    activationEvidenceType: "effect_program",
    program: serializeCompiledSimulation(programs, compiled, simulation),
  };
}

function mergeDefinitionSources(resolvedCards, cardTexts) {
  const merged = [];
  for (const card of resolvedCards || []) {
    const definitionId = String(card?.id || card?.cardId || "");
    if (!definitionId) continue;
    merged.push({
      ...card,
      definitionId,
      names: unique([
        card.input,
        card.matchedQuery,
        card.name,
        card.cnName,
        card.jaName,
        card.enName,
        ...(card.aliases || []),
      ]),
      evidenceIds: unique([card.sourceEvidenceId, `card-text-${definitionId}`]),
    });
  }

  for (const evidence of cardTexts || []) {
    const names = unique([...(evidence.cards || []), stripCardTextTitle(evidence.title)]);
    if (!names.length || !String(evidence.text || "").trim()) continue;
    const numericId = String(evidence.id || "").match(/(?:^|card-text-)(\d{3,})$/u)?.[1] || "";
    const existing = merged.find((candidate) => (
      (numericId && candidate.definitionId === numericId)
      || candidate.names.some((name) => names.some((other) => normalize(name) === normalize(other)))
    ));
    if (existing) {
      existing.names = unique([...existing.names, ...names]);
      if (!String(existing.effectText || existing.text || "").trim()) {
        existing.effectText = String(evidence.text || "");
      }
      if (!String(existing.cardType || "").trim() && String(evidence.cardType || "").trim()) {
        existing.cardType = evidence.cardType;
      }
      existing.evidenceIds = unique([...(existing.evidenceIds || []), evidence.id]);
      continue;
    }
    merged.push({
      definitionId: numericId || String(evidence.id || `evidence-${merged.length + 1}`),
      id: numericId || String(evidence.id || ""),
      name: names[0],
      names,
      effectText: String(evidence.text || ""),
      cardType: evidence.cardType || "",
      evidenceIds: unique([evidence.id]),
    });
  }
  return merged;
}

function stripCardTextTitle(value) {
  return String(value || "")
    .replace(/\s*(?:的卡片文本|のカードテキスト|card text)$/iu, "")
    .trim();
}

function extractContinuousDefinitionCondition(text) {
  const value = String(text || "");
  if (!/(?:场上|場上|フィールド).{0,36}(?:墓地|墓地に|Graveyard)/iu.test(value)) return "";
  const quoted = value.match(/(?:存在|有|いる|ある).{0,8}[“「『]([^”」』]+)[”」』]\s*怪兽/iu);
  if (quoted?.[1]) return quoted[1].trim();
  const bare = value.match(/(?:存在|有)\s*([^。；;，,\n]{2,40}?)\s*怪兽/iu);
  return bare?.[1]?.trim() || "";
}

function parseContinuousExistsCondition(text) {
  const value = String(text || "");
  const definitionReferenceText = extractContinuousDefinitionCondition(value);
  if (!definitionReferenceText) return null;
  const zones = [];
  if (/(?:场上|場上|フィールド|field)/iu.test(value)) zones.push("monster_zone");
  if (/(?:墓地|Graveyard)/iu.test(value)) zones.push("graveyard");
  const controllers = [];
  if (/(?:自己|自分|your).{0,8}(?:或|・|和|或者|and|or).{0,8}(?:对手|对方|相手|opponent)|双方|either player/iu.test(value)) {
    controllers.push("self", "opponent");
  } else if (/(?:对手|对方|相手|opponent)/iu.test(value)) {
    controllers.push("opponent");
  } else if (/(?:自己|自分|your)/iu.test(value)) {
    controllers.push("self");
  }
  if (!zones.length || !controllers.length) return null;
  return {
    type: "exists",
    definitionReferenceText,
    selector: { definitionIds: [], zones: unique(zones), controllers: unique(controllers) },
    minCount: 1,
  };
}

function parseFusionMaterialPool(text) {
  const value = String(text || "");
  if (/(?:自己|自分|your).{0,8}(?:・|或|和|或者|and|or).{0,8}(?:对手|对方|相手|opponent).{0,16}(?:场上|場上|フィールド|field)|双方场上|双方場上|either player's field/iu.test(value)) {
    return { zones: ["monster_zone"], controllers: ["self", "opponent"], controllerPerspective: "effect_source" };
  }
  const zones = [];
  if (/(?:手牌|手卡|手札|hand).{0,12}(?:场上|場上|フィールド|field)|(?:场上|場上|フィールド|field).{0,12}(?:手牌|手卡|手札|hand)/iu.test(value)) {
    zones.push("hand", "monster_zone");
  } else if (/(?:场上|場上|フィールド|field)/iu.test(value)) {
    zones.push("monster_zone");
  }
  if (!zones.length) return null;
  if (/(?:对手|对方|相手|opponent)/iu.test(value) && !/(?:自己|自分|your)/iu.test(value)) {
    return { zones, controllers: ["opponent"], controllerPerspective: "effect_source" };
  }
  if (/(?:自己|自分|your)/iu.test(value)) {
    return { zones, controllers: ["self"], controllerPerspective: "effect_source" };
  }
  return null;
}

function instantiateRelativeMaterialPool(materialPool, sourceController) {
  if (!materialPool || materialPool.controllerPerspective !== "effect_source") {
    return { complete: true, value: materialPool };
  }
  const controllers = unique(materialPool.controllers || []).map(normalize);
  const completeDomain = controllers.includes("self") && controllers.includes("opponent");
  if (completeDomain) {
    return {
      complete: true,
      value: { ...materialPool, controllers: ["self", "opponent"], resolvedControllerPerspective: sourceController },
    };
  }
  const resolvedControllers = [];
  for (const controller of controllers) {
    const resolved = resolveRelativePlayer(controller, sourceController);
    if (!resolved) return { complete: false, reason: "fusion_material_controller_perspective_unknown" };
    resolvedControllers.push(resolved);
  }
  return {
    complete: true,
    value: {
      ...materialPool,
      controllers: unique(resolvedControllers),
      resolvedControllerPerspective: sourceController,
    },
  };
}

function resolveRelativePlayer(relativePlayer, sourceController) {
  const source = normalize(sourceController);
  if (source !== "self" && source !== "opponent") return "";
  const relative = normalize(relativePlayer || "self");
  if (relative === "self") return source;
  if (relative === "opponent") return source === "self" ? "opponent" : "self";
  return "";
}

function parseMaterialRecipe(text) {
  const segments = printedMaterialFormulaSegments(text);
  if (segments.length !== 2 || classifyPrintedMaterialFormula(segments) !== "fusion") return null;
  const summonKinds = [];
  const second = segments[1];
  if (/融合|Fusion/iu.test(second)) summonKinds.push("fusion");
  if (/同步|同调|シンクロ|Synchro/iu.test(second)) summonKinds.push("synchro");
  if (/超量|エクシーズ|Xyz/iu.test(second)) summonKinds.push("xyz");
  if (/连接|連接|リンク|Link/iu.test(second)) summonKinds.push("link");
  if (!summonKinds.length) return null;
  const referenceText = segments[0]
    .replace(/^[「『【“]|[」』】”]$/gu, "")
    .trim();
  if (!referenceText) return null;
  return {
    slots: [
      { id: "named-material", definitionReferenceText: referenceText },
      { id: "summon-kind-material", summonKinds },
    ],
  };
}

function inferSummonKinds(cardType, text) {
  const explicitKinds = [];
  const explicitType = String(cardType || "");
  if (/融合|Fusion/iu.test(explicitType)) explicitKinds.push("fusion");
  if (/同步|同调|シンクロ|Synchro/iu.test(explicitType)) explicitKinds.push("synchro");
  if (/超量|エクシーズ|Xyz/iu.test(explicitType)) explicitKinds.push("xyz");
  if (/连接|連接|リンク|Link/iu.test(explicitType)) explicitKinds.push("link");
  if (explicitKinds.length) return unique(explicitKinds);
  const inferred = classifyPrintedMaterialFormula(printedMaterialFormulaSegments(text));
  return inferred ? [inferred] : [];
}

function printedMaterialFormulaSegments(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (!firstLine || /^[①②③④⑤⑥⑦⑧⑨⑩]|^\d+\s*[.:：．、)）]/u.test(firstLine)) return [];
  const separator = firstLine.includes("＋") ? /\s*＋\s*/u : /\s+\+\s+/u;
  const segments = firstLine.split(separator).map((part) => part.trim()).filter(Boolean);
  return segments.length >= 2 ? segments : [];
}

function classifyPrintedMaterialFormula(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return "";
  const joined = segments.join("＋");
  if (/(?:调整|調整|チューナー|tuner)/iu.test(joined)
      && /(?:调整以外|調整以外|チューナー以外|non[- ]?tuner)/iu.test(joined)) {
    return "synchro";
  }
  return segments.every(looksLikeFusionMaterialTerm) ? "fusion" : "";
}

function looksLikeFusionMaterialTerm(segment) {
  const value = String(segment || "")
    .trim()
    .replace(/[。．.!！?？；;：:]+$/gu, "")
    .trim();
  if (/^[「『【“].+[」』】”]$/u.test(value)) return true;
  return /(?:怪兽|怪獸|モンスター|monsters?)(?:\s*\d+\s*(?:只|隻|体|體|枚)?(?:以上|或以上|or more)?)?$/iu.test(value);
}

function bindMaterialRecipe(rawRecipe, programs) {
  const slots = [];
  for (const slot of rawRecipe?.slots || []) {
    if (slot.definitionReferenceText) {
      const definitionIds = resolveDefinitionReference(slot.definitionReferenceText, programs);
      if (definitionIds.length !== 1) {
        return {
          complete: false,
          reason: definitionIds.length ? "fusion_material_definition_ambiguous" : "fusion_material_definition_unresolved",
        };
      }
      slots.push({ id: slot.id, predicate: { definitionIds } });
      continue;
    }
    if (slot.summonKinds?.length) {
      slots.push({ id: slot.id, predicate: { summonKinds: [...slot.summonKinds] } });
      continue;
    }
    return { complete: false, reason: "fusion_material_slot_unsupported" };
  }
  return slots.length >= 2
    ? { complete: true, recipe: { slots } }
    : { complete: false, reason: "fusion_material_recipe_incomplete" };
}

function resolveDefinitionReference(referenceText, programs) {
  const reference = String(referenceText || "").trim();
  if (!reference) return [];
  return unique((programs || [])
    .filter((program) => program.names.some((name) => fuzzyContains(name, reference) || fuzzyContains(reference, name)))
    .map((program) => program.definitionId));
}

function activationRequirement(blockText) {
  const text = String(blockText || "");
  const marker = text.search(/(?:可以发动|能发动|発動できる|activate this effect)/iu);
  return marker >= 0 ? text.slice(0, marker + 8).trim() : "";
}

function compileQuestionScenario({ query, programs }) {
  const stateInferences = [];
  const mentionedPrograms = programs
    .map((program) => ({ program, mention: locateCardMention(query, program) }))
    .filter((item) => item.mention.index >= 0);
  const costMention = extractCostCardMention(query);
  const costPrograms = costMention
    ? programs.filter((program) => program.names.some((name) => fuzzyContains(name, costMention) || fuzzyContains(costMention, name)))
    : [];
  if (costMention && costPrograms.length !== 1) {
    return incomplete(costPrograms.length ? "activation_cost_definition_ambiguous" : "activation_cost_definition_unresolved");
  }
  const costProgram = costPrograms[0] || null;
  const gameCards = mentionedPrograms.flatMap(({ program, mention }) => {
    const count = inferDeclaredInstanceCount(query, mention);
    return Array.from({ length: count }, (_, index) => (
      buildInitialCardState(query, program, mention, index + 1, count, program === costProgram
        ? { zone: "hand" }
        : {})
    ));
  });
  const continuousEffects = mentionedPrograms.flatMap(({ program }) => (
    gameCards
      .filter((card) => card.definitionId === program.definitionId)
      .flatMap((instance) => program.continuousEffects.map((effect) => {
        const resolvedEffect = resolveEffectCategoryFromInstance(effect, instance);
        return {
          ...resolvedEffect,
          id: `${effect.id}@${instance.instanceId}`,
          sourceCardId: instance.instanceId,
          sourceInstanceId: instance.instanceId,
          sourceDefinitionId: program.definitionId,
        };
      }))
  ));
  const unresolvedContinuous = continuousEffects
    .find((effect) => effect.compileIncompleteReason);
  if (unresolvedContinuous) return incomplete(unresolvedContinuous.compileIncompleteReason);
  const chainLinks = [];

  for (const { program, mention } of mentionedPrograms) {
    const explicitOrder = inferChainOrder(query, mention.index);
    const fusionEffectPresent = program.activatedEffects.some((effect) => effect.actionTags.includes("fusion_summon"));
    const activationPreflightPresent = program.activatedEffects.some((effect) => effect.mandatorySpecialSummonOutputs?.length);
    const implicitOrder = !explicitOrder && (fusionEffectPresent || activationPreflightPresent) && effectActivationAsked(query, mention) ? 1 : 0;
    const order = explicitOrder || implicitOrder;
    if (!order || !program.activatedEffects.length) continue;
    let effect = chooseActivatedEffect(query, mention, program.activatedEffects);
    if (!effect) continue;
    const contextualSourceCandidates = gameCards.filter((card) => (
      card.definitionId === program.definitionId
      && effectAllowsActivationZone(effect, card.zone)
    ));
    if (contextualSourceCandidates.length === 1) {
      effect = resolveEffectCategoryFromInstance(effect, contextualSourceCandidates[0]);
    }
    if (effect.compileIncompleteReason) return incomplete(effect.compileIncompleteReason);
    if (!effect.fusionSpec && !effect.mandatorySpecialSummonOutputs?.length && activationLegalityExplicitlyAsked(query, mention)) {
      return incomplete("activation_legality_not_compiled");
    }
    if (costMention && !effect.costSpec) return incomplete("declared_cost_not_part_of_selected_effect");
    const sourceCandidates = gameCards.filter((card) => (
      card.definitionId === program.definitionId
      && effectAllowsActivationZone(effect, card.zone)
    ));
    if (sourceCandidates.length !== 1) {
      return incomplete(
        sourceCandidates.length > 1 ? "ambiguous_chain_source_instance" : "compiled_chain_source_not_identified",
        {
          referencedDefinitionIds: unique(gameCards.map((card) => card.definitionId)),
          candidateInstanceIds: sourceCandidates.map((card) => card.instanceId),
          sourceStates: gameCards.filter((card) => card.definitionId === program.definitionId),
          sourceDefinitionId: program.definitionId,
          chainOrder: order,
        },
      );
    }
    const [source] = sourceCandidates;
    if (!effect.fusionSpec && source.zone === "monster_zone" && source.faceUp === null) {
      source.faceUp = true;
      stateInferences.push({
        phase: "compile_state_inference",
        cardId: source.instanceId,
        sourceInstanceId: source.instanceId,
        sourceDefinitionId: source.definitionId,
        field: "faceUp",
        before: null,
        after: true,
        reason: "declared_legal_field_monster_activation",
        conclusion: `题设已声明「${source.name}」在怪兽区域发动怪兽效果，因此发动时按表侧表示记录。`,
      });
    }
    const target = effect.targetSelector
      ? chooseEffectTarget(gameCards, source, effect.targetSelector)
      : null;
    if (effect.targetSelector && !target) {
      return incomplete("compiled_effect_target_not_identified", {
        referencedDefinitionIds: unique(gameCards.map((card) => card.definitionId)),
      });
    }
    let sequence = (effect.sequence || []).map((item) => ({
      ...item,
      primitive: {
        ...item.primitive,
        ...(target ? {
          targetId: target.instanceId,
          targetName: target.name,
          targetDefinitionId: target.definitionId,
        } : {}),
        sourceCardId: source.instanceId,
        sourceInstanceId: source.instanceId,
        sourceDefinitionId: source.definitionId,
        sourceCardName: source.name,
      },
    }));
    let activationCostSequence = [];
    const activationPreconditions = [];
    if (effect.mandatorySpecialSummonOutputs?.length) {
      const preflight = evaluateMandatorySpecialSummonRestrictions({
        query,
        source,
        outputs: effect.mandatorySpecialSummonOutputs,
        gameCards,
        continuousEffects,
      });
      if (preflight) activationPreconditions.push(preflight);
    }
    if (effect.fusionSpec) {
      const materialPool = instantiateRelativeMaterialPool(effect.fusionSpec.materialPool, source.controller);
      if (!materialPool.complete) return incomplete(materialPool.reason);
      const instantiatedFusionSpec = {
        ...effect.fusionSpec,
        materialPool: materialPool.value,
      };
      const availableFusionCandidates = gameCards
        .filter((card) => card.zone === "extra_deck" && card.materialRecipe);
      const explicitlyRequestedDefinitions = new Set(mentionedPrograms
        .filter(({ program: candidateProgram }) => (
          candidateProgram.materialRecipe
          && fusionSummonGoalMentionsProgram(query, candidateProgram)
        ))
        .map(({ program: candidateProgram }) => candidateProgram.definitionId));
      const candidateInstanceIds = availableFusionCandidates
        .filter((card) => (
          !explicitlyRequestedDefinitions.size
          || explicitlyRequestedDefinitions.has(card.definitionId)
        ))
        .map((card) => card.instanceId);
      if (!candidateInstanceIds.length) {
        return incomplete(
          explicitlyRequestedDefinitions.size
            ? "requested_fusion_candidate_or_material_recipe_unknown"
            : "fusion_candidate_or_material_recipe_unknown",
          {
          referencedDefinitionIds: unique(gameCards.map((card) => card.definitionId)),
          fusionCandidatePrograms: programs.filter((program) => program.materialRecipeRaw || program.compileIncompleteReason).map((program) => ({
            definitionId: program.definitionId,
            materialRecipeRaw: program.materialRecipeRaw,
            materialRecipe: program.materialRecipe,
            compileIncompleteReason: program.compileIncompleteReason,
          })),
          },
        );
      }
      const fusionPrimitive = createEffectPrimitive("fusion_summon", {
        ...instantiatedFusionSpec,
        sourceCardId: source.instanceId,
        sourceInstanceId: source.instanceId,
        sourceDefinitionId: source.definitionId,
        sourceCardName: source.name,
        candidateInstanceIds,
      });
      sequence = [{ id: "fusion-summon", connector: "INDEPENDENT", primitive: fusionPrimitive }];
      activationPreconditions.push({
        type: "operation_performable",
        evaluationPoint: "before_cost",
        primitive: fusionPrimitive,
        reason: "fusion_operation_not_performable_before_cost",
      });
      if (effect.trigger) {
        const triggerSatisfied = summonEventDescribed(query, mention);
        activationPreconditions.push({
          type: "event_occurred",
          event: effect.trigger.event,
          sourceInstanceId: source.instanceId,
          satisfied: triggerSatisfied,
          reason: triggerSatisfied ? "summon_event_described" : "summon_event_not_established",
        });
      }
      if (effect.costSpec) {
        const costPlayer = resolveRelativePlayer(effect.costSpec.player, source.controller);
        if (!costPlayer) return incomplete("activation_cost_controller_unknown");
        const costCards = gameCards.filter((card) => (
          card.definitionId === costProgram?.definitionId
          && card.zone === "hand"
          && (normalize(card.controller) === "unknown" || card.controller === costPlayer)
        ));
        if (costCards.length !== 1) {
          return incomplete(
            costCards.length ? "activation_cost_instance_ambiguous" : "activation_cost_instance_not_identified",
            {
              sourceController: source.controller,
              costPlayer,
              costStates: gameCards.filter((card) => card.definitionId === costProgram?.definitionId),
            },
          );
        }
        if (normalize(costCards[0].controller) === "unknown") {
          const previousOwner = costCards[0].owner;
          costCards[0].controller = costPlayer;
          if (normalize(previousOwner) === "unknown") costCards[0].owner = costPlayer;
          stateInferences.push({
            phase: "compile_state_inference",
            cardId: costCards[0].instanceId,
            sourceInstanceId: costCards[0].instanceId,
            sourceDefinitionId: costCards[0].definitionId,
            field: "controller",
            before: "unknown",
            after: costPlayer,
            reason: "effect_controller_pays_own_activation_cost",
            conclusion: `「${costCards[0].name}」作为发动 cost，归入该效果发动者的手牌。`,
          });
        }
        activationCostSequence = [{
          id: "discard-activation-cost",
          connector: "INDEPENDENT",
          primitive: createEffectPrimitive("discard_from_hand", {
            player: costPlayer,
            amount: effect.costSpec.amount,
            cardIds: [costCards[0].instanceId],
            cardInstanceIds: [costCards[0].instanceId],
          }),
        }];
      }
    }
    chainLinks.push({
      id: `C${order}`,
      order,
      sourceCardId: source.instanceId,
      sourceInstanceId: source.instanceId,
      sourceDefinitionId: source.definitionId,
      sourceCardName: source.name,
      sourceExpectedZone: source.zone,
      effectId: effect.id,
      effectCategory: effect.effectCategory,
      activationPremise: effect.fusionSpec || effect.mandatorySpecialSummonOutputs?.length ? "derived" : "declared_legal",
      activationPremiseText: effect.fusionSpec || effect.mandatorySpecialSummonOutputs?.length
        ? "由事件、费用与发动前操作可行性共同验证。"
        : "题设已声明该连锁项发动；展示、费用、对象等发动手续按题设视为已满足。",
      activationCostSequence,
      activationPreconditions,
      sequence,
      targets: target ? [{
        cardId: target.instanceId,
        instanceId: target.instanceId,
        definitionId: target.definitionId,
        name: target.name,
        expectedZone: target.zone,
        validAtResolution: true,
      }] : [],
    });
  }

  const declaredOrders = unique([...query.matchAll(/(?:^|[^a-z])(?:c|cl|chain)\s*(\d+)/giu)].map((match) => match[1]));
  const chainOrders = new Set(chainLinks.map((link) => String(link.order)));
  if (!chainLinks.length) {
    return incomplete(declaredOrders.length ? "declared_chain_link_not_compiled" : "declared_or_implicit_chain_link_not_found", {
      referencedDefinitionIds: unique(gameCards.map((card) => card.definitionId)),
      programSummaries: mentionedPrograms.map(({ program, mention }) => ({
        definitionId: program.definitionId,
        mention,
        activatedEffects: program.activatedEffects.map((effect) => ({ id: effect.id, actionTags: effect.actionTags })),
        effectText: program.effectText,
      })),
    });
  }
  if (declaredOrders.some((order) => !chainOrders.has(order))) {
    return incomplete("declared_chain_link_not_compiled", {
      referencedDefinitionIds: unique(gameCards.map((card) => card.definitionId)),
      declaredOrders,
      chainLinks,
    });
  }

  return {
    complete: true,
    gameState: { cards: gameCards },
    chainLinks,
    continuousEffects,
    stateInferences,
    referencedDefinitionIds: unique(gameCards.map((card) => card.definitionId)),
    referencedInstanceIds: gameCards.map((card) => card.instanceId),
  };
}

function resolveEffectCategoryFromInstance(effect, instance) {
  if (effect?.compileIncompleteReason !== "effect_source_category_not_supported"
      || instance?.effectCategory !== "monster") {
    return effect;
  }
  const { compileIncompleteReason: _ignored, ...resolved } = effect;
  return {
    ...resolved,
    effectCategory: "monster",
    effectCategoryBasis: instance.effectCategoryBasis || "question_monster_structure",
  };
}

function buildInitialCardState(query, program, mention, ordinal = 1, instanceCount = 1, overrides = {}) {
  const mentionIndex = Math.max(0, Number(mention.index || 0));
  const nearby = localWindow(query, mentionIndex, mention.surface.length, 48, 40);
  const explicitlyInExtraDeck = program.materialRecipe
    && programHasExplicitExtraDeckMention(query, program);
  const zone = overrides.zone
    || (explicitlyInExtraDeck ? "extra_deck" : inferZone(nearby.before, nearby.after, program));
  const controller = overrides.controller || inferController(nearby.before, nearby.after);
  const position = overrides.position || inferPosition(localWindow(query, mentionIndex, mention.surface.length, 16, 20));
  const fieldCard = zone === "monster_zone" || zone === "spell_trap_zone";
  const restrictionApplying = program.continuousEffects.some((effect) => effect.fieldRestrictions?.length)
    && /(?:效果)?.{0,8}(?:正在)?(?:适用|適用|applying)/iu.test(nearby.full);
  const contextualEffectCategory = inferContextualEffectCategory({
    query,
    program,
    mention,
    position,
  });
  const unaffected = /不受.{0,12}(?:怪兽|怪獸|此卡|该卡|這張卡)?.{0,8}效果影响|不受怪獸效果影響|unaffected by monster effects/iu.test(nearby.full);
  const cannotChangeToDefense = /连接怪兽|連接怪獸|リンクモンスター|Link Monster/iu.test(`${program.cardType}\n${program.effectText}`);
  const instanceId = `${program.definitionId}#${ordinal}`;
  return {
    cardId: instanceId,
    instanceId,
    definitionId: program.definitionId,
    instanceOrdinal: ordinal,
    sameDefinitionInstanceCount: instanceCount,
    name: program.name,
    controller: controller || "unknown",
    owner: overrides.owner || controller || "unknown",
    zone,
    onField: fieldCard,
    faceUp: overrides.faceUp ?? (restrictionApplying ? true : inferFaceUp(fieldCard, nearby.full, position)),
    position: zone === "monster_zone" ? (position || "unknown") : "none",
    effectCategory: contextualEffectCategory.category,
    effectCategoryBasis: contextualEffectCategory.basis,
    canChangeToDefense: !cannotChangeToDefense,
    unaffectedByMonsterEffects: unaffected,
    ...(program.race ? { race: program.race } : {}),
    ...(Number.isFinite(program.defense) ? { defense: program.defense } : {}),
    ...(program.materialRecipe ? { materialRecipe: program.materialRecipe } : {}),
    ...(program.summonKinds?.length ? { summonKinds: [...program.summonKinds] } : {}),
  };
}

function extractCostCardMention(query) {
  const patterns = [
    /(?:将|將|把)\s*[「『【“]([^」』】”]+)[」』】”]\s*(?:作为|作為)\s*(?:cost|コスト|代价|代價)/iu,
    /(?:舍弃|丢弃|捨てる?)\s*[「『【“]([^」』】”]+)[」』】”]/iu,
  ];
  for (const pattern of patterns) {
    const match = String(query || "").match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function effectActivationAsked(query, mention) {
  const context = localWindow(query, mention.index, mention.surface.length, 48, 80).full;
  return /(?:发动|發動|発動|activate)/iu.test(context);
}

function activationLegalityExplicitlyAsked(query, mention) {
  const context = localWindow(query, mention.index, mention.surface.length, 72, 88).full;
  return /(?:能否|能不能|能不能够|是否(?:可以|能够|能)?|可否|可不可以|可以不可以|还(?:能|可以)|仍(?:能|可以)).{0,18}(?:发动|發動|発動|activate)/iu.test(context)
    || /(?:发动|發動|発動|activate).{0,18}(?:可以吗|可以嗎|能吗|能嗎|是否合法|是否可以)/iu.test(context)
    || /(?:发动|發動|発動|activate)(?:这个|這個|该|該|其)?(?:效果)?\s*(?:吗|嗎|嘛|么|麼|[?？])/iu.test(context);
}

function summonEventDescribed(query, mention) {
  if (!mention || mention.index < 0 || !mention.surface) return false;
  const context = localWindow(query, mention.index, mention.surface.length, 28, 36);
  const summonImmediatelyBefore = /(?:召唤|召喚|特殊召唤|特殊召喚|Normal Summon|Special Summon)\s*[「『【“"]?\s*$/iu
    .test(context.before);
  const summonImmediatelyAfter = /^[」』】”"]?\s*(?:被)?(?:召唤|召喚|特殊召唤|特殊召喚)(?:成功)?|^[」』】”"]?\s*(?:を)?(?:召喚|特殊召喚)(?:した|された)|^[」』】”"]?\s+(?:is|was)\s+(?:Normal |Special )?Summoned/iu
    .test(context.after);
  return summonImmediatelyBefore || summonImmediatelyAfter;
}

function inferContextualEffectCategory({ query, program, mention, position } = {}) {
  if (program?.effectCategory && program.effectCategory !== "unknown") {
    return {
      category: program.effectCategory,
      basis: program.effectCategoryBasis || "compiled_card_semantics",
    };
  }
  if (!mention || mention.index < 0 || !mention.surface) {
    return {
      category: "unknown",
      basis: program?.effectCategoryBasis || "missing_card_type_without_monster_structure",
    };
  }
  if (summonEventDescribed(query, mention)) {
    return { category: "monster", basis: "question_explicit_source_summon_event" };
  }
  if (position === "attack" || position === "defense") {
    return { category: "monster", basis: "question_explicit_monster_position" };
  }

  const context = localWindow(query, mention.index, mention.surface.length, 32, 32);
  if (/(?:怪兽区域|怪獸區域|怪兽区|怪獸區|Monster Zone)\s*(?:的)?\s*[「『【“"]?\s*$/iu.test(context.before)
      || /^[」』】”"]?\s*(?:在|于|於)?\s*(?:怪兽区域|怪獸區域|怪兽区|怪獸區|Monster Zone)/iu.test(context.after)) {
    return { category: "monster", basis: "question_explicit_monster_zone" };
  }
  if (/^[」』】”"]?\s*(?:(?:仅|僅|只)\s*)?(?:\d+|[一二两兩三四五六七八九十])?\s*只(?:\s|[，。；、,.!?！？]|$)/u.test(context.after)) {
    return { category: "monster", basis: "question_monster_counter" };
  }
  return {
    category: "unknown",
    basis: program?.effectCategoryBasis || "missing_card_type_without_monster_structure",
  };
}

function fusionSummonGoalMentionsProgram(query, program) {
  const text = String(query || "").normalize("NFKC");
  const lowerText = text.toLowerCase();
  for (const surface of unique(program?.names || []).sort((left, right) => right.length - left.length)) {
    const candidate = String(surface || "").normalize("NFKC");
    if (candidate.length < 2) continue;
    const needle = candidate.toLowerCase();
    let cursor = 0;
    while (cursor <= lowerText.length - needle.length) {
      const index = lowerText.indexOf(needle, cursor);
      if (index < 0) break;
      const before = text.slice(Math.max(0, index - 28), index);
      const after = text.slice(index + candidate.length, index + candidate.length + 28);
      const followsFusionVerb = /(?:融合召唤|融合召喚|Fusion Summon)\s*[「『【“"]?\s*$/iu.test(before);
      const precedesFusionVerb = /^[」』】”"]?\s*(?:来|进行|作|を)?\s*(?:融合召唤|融合召喚|Fusion Summon)/iu.test(after);
      if (followsFusionVerb || precedesFusionVerb) return true;
      cursor = Math.max(index + candidate.length, index + 1);
    }
  }
  return false;
}

function programHasExplicitExtraDeckMention(query, program) {
  const text = String(query || "").normalize("NFKC");
  const lowerText = text.toLowerCase();
  for (const surface of unique(program?.names || []).sort((left, right) => right.length - left.length)) {
    const candidate = String(surface || "").normalize("NFKC");
    if (candidate.length < 2) continue;
    const needle = candidate.toLowerCase();
    let cursor = 0;
    while (cursor <= lowerText.length - needle.length) {
      const index = lowerText.indexOf(needle, cursor);
      if (index < 0) break;
      const before = text.slice(Math.max(0, index - 40), index);
      if (/(?:额外卡组|額外卡組|额外牌组|額外牌組|EX(?:tra)? Deck)[^，。；;]{0,28}$/iu.test(before)) {
        return true;
      }
      cursor = Math.max(index + candidate.length, index + 1);
    }
  }
  return false;
}

function inferDeclaredInstanceCount(query, mention) {
  const before = String(query || "").slice(Math.max(0, mention.index - 48), mention.index);
  const match = before.match(/([2-9]|[二两兩三四五六七八九])\s*(?:只|隻|张|張|体|體)[^，。；;]{0,18}[「『【“"]?$/u);
  if (!match) return 1;
  return smallCount(match[1]);
}

function smallCount(value) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 2 && number <= 9) return number;
  return ({ 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })[value] || 1;
}

function chooseEffectTarget(cards, source, selector) {
  if (
    selector.controller === "same_as_source"
    && (!source.controller || normalize(source.controller) === "unknown")
  ) {
    return null;
  }
  const candidates = cards.filter((card) => {
    if (selector.excludeSource && card.instanceId === source.instanceId) return false;
    if (selector.zone && card.zone !== selector.zone) return false;
    if (selector.controller === "same_as_source" && card.controller !== source.controller) return false;
    return true;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function chooseActivatedEffect(query, mention, effects) {
  if (effects.length === 1) return effects[0];
  const context = localWindow(query, mention.index, mention.surface.length, 36, 56).full;
  const scored = effects.map((effect) => {
    let score = 0;
    if (effect.actionTags.includes("swap") && /替换|替換|交换|交換|换下|換下/u.test(context)) score += 5;
    if (effect.actionTags.includes("fusion_summon") && /融合|素材/u.test(context)) score += 5;
    if (effect.actionTags.includes("return_to_hand") && /弹|彈|回手|放回|返回|守备力|守備力|防御力|防禦力/u.test(context)) score += 3;
    if (effect.actionTags.includes("special_summon") && /特殊召唤|特殊召喚|特召/u.test(context)) score += 2;
    return { effect, score };
  }).sort((left, right) => right.score - left.score);
  return scored[0].score > scored[1].score ? scored[0].effect : null;
}

function locateCardMention(query, program) {
  const surfaces = unique([program.input, ...program.names])
    .filter((value) => value.length >= 2)
    .sort((left, right) => right.length - left.length);
  const normalizedQuery = String(query || "").normalize("NFKC");
  const lowerQuery = normalizedQuery.toLowerCase();
  const occurrences = [];
  for (const surface of surfaces) {
    const candidate = String(surface).normalize("NFKC");
    const needle = candidate.toLowerCase();
    let cursor = 0;
    while (cursor <= lowerQuery.length - needle.length) {
      const index = lowerQuery.indexOf(needle, cursor);
      if (index < 0) break;
      const context = localWindow(normalizedQuery, index, candidate.length, 56, 72);
      let score = candidate.length / 100;
      if (/(?:召唤|召喚|特殊召唤|特殊召喚)\s*[「『【“"]?\s*$/u.test(context.before)) score += 12;
      if (/(?:^|[^a-z])(?:c|cl|chain)\s*\d+[^，。；;]{0,24}$/iu.test(context.before)) score += 10;
      if (/(?:发动|發動|発動|activate)/iu.test(context.full)) score += 6;
      if (/(?:额外卡组|額外卡組|手牌|手卡|手札|场上|場上|怪兽区|怪獸區|墓地)/u.test(context.before.slice(-24))) score += 3;
      occurrences.push({ index, surface: candidate, score });
      cursor = Math.max(index + candidate.length, index + 1);
    }
  }
  if (!occurrences.length) return { index: -1, surface: "" };
  return occurrences.sort((left, right) => right.score - left.score || left.index - right.index)[0];
}

function inferChainOrder(query, mentionIndex) {
  const before = String(query || "").slice(Math.max(0, mentionIndex - 64), mentionIndex);
  const matches = [...before.matchAll(/(?:^|[^a-z])(?:c|cl|chain)\s*(\d+)/giu)];
  return matches.length ? Number(matches.at(-1)[1]) : 0;
}

function fusionActivationZones(effectCategory) {
  if (effectCategory === "monster") return ["monster_zone"];
  if (effectCategory === "spell") return ["hand", "spell_trap_zone"];
  if (effectCategory === "trap") return ["spell_trap_zone"];
  return [];
}

function effectAllowsActivationZone(effect, zone) {
  const allowedZones = effect.activationZones || (effect.activationZone ? [effect.activationZone] : []);
  return !allowedZones.length || allowedZones.includes(zone);
}

function inferZone(before, after, program) {
  const text = `${before}${after}`;
  if (/(?:召唤|召喚|特殊召唤|特殊召喚)\s*[「『【“"]?\s*$/u.test(before)) return "monster_zone";
  const applyingRestriction = program.continuousEffects.find((effect) => effect.fieldRestrictions?.length);
  if (applyingRestriction && /(?:效果)?.{0,10}(?:正在)?(?:适用|適用|applying)/iu.test(text)) {
    return applyingRestriction.activeWhen?.zone || "unknown";
  }
  const markers = [
    ["extra_deck", /额外卡组|額外卡組|EX卡组|EX牌组|エクストラデッキ/gu],
    ["hand", /手牌|手卡|手札/gu],
    ["graveyard", /墓地/gu],
    ["banished", /除外区|除外區|除外/gu],
    ["spell_trap_zone", /魔法(?:与|與|＆|&)?陷阱(?:区域|區域|区|區)|魔法・陷阱区域|魔法＆罠ゾーン/gu],
    ["monster_zone", /场上|場上|怪兽区|怪獸區|怪兽区域|怪獸區域/gu],
  ];
  let latest = { zone: "", index: -1 };
  for (const [zone, pattern] of markers) {
    for (const match of before.matchAll(pattern)) {
      if ((match.index ?? -1) > latest.index) latest = { zone, index: match.index ?? -1 };
    }
  }
  if (latest.zone) return latest.zone;
  const activationZones = unique(program.activatedEffects.flatMap((effect) => (
    effect.activationZones || (effect.activationZone ? [effect.activationZone] : [])
  )));
  if (activationZones.length === 1) return activationZones[0];
  if (activationZones.includes("hand")) return "hand";
  return "unknown";
}

function inferController(before, after) {
  const beforeLocal = before.match(/(?:我方|自己|我|对方|對方|对手|對手)[^，,。；;]{0,32}$/u)?.[0] || "";
  const beforeLocalTokens = [...beforeLocal.matchAll(/我方|自己|我|对方|對方|对手|對手/gu)];
  const beforeLocalController = controllerFromToken(beforeLocalTokens.at(-1)?.[0]);
  if (beforeLocalController) return beforeLocalController;

  const afterLocal = after.match(/^[」』】”"]?\s*(?:已|正|仍)?\s*(?:在|于|於|位于|位於)?\s*(我方|自己|我|对方|對方|对手|對手)(?:的)?(?:场上|場上|怪兽区|怪獸區|手牌|手卡|手札|墓地|额外卡组|額外卡組)/u);
  const afterLocalController = controllerFromToken(afterLocal?.[1]);
  if (afterLocalController) return afterLocalController;

  const beforeSelf = Math.max(before.lastIndexOf("我方"), before.lastIndexOf("自己"), before.lastIndexOf("我"));
  const beforeOpponent = Math.max(before.lastIndexOf("对方"), before.lastIndexOf("對方"), before.lastIndexOf("对手"), before.lastIndexOf("對手"));
  if (beforeSelf >= 0 || beforeOpponent >= 0) return beforeSelf > beforeOpponent ? "self" : "opponent";

  const afterSelf = firstNonNegative(after.indexOf("我方"), after.indexOf("自己"), after.indexOf("我"));
  const afterOpponent = firstNonNegative(after.indexOf("对方"), after.indexOf("對方"), after.indexOf("对手"), after.indexOf("對手"));
  if (afterSelf < 0 && afterOpponent < 0) return "";
  if (afterSelf < 0) return "opponent";
  if (afterOpponent < 0) return "self";
  return afterSelf < afterOpponent ? "self" : "opponent";
}

function controllerFromToken(token) {
  if (/^(?:我方|自己|我)$/u.test(String(token || ""))) return "self";
  if (/^(?:对方|對方|对手|對手)$/u.test(String(token || ""))) return "opponent";
  return "";
}

function firstNonNegative(...values) {
  const available = values.filter((value) => value >= 0);
  return available.length ? Math.min(...available) : -1;
}

function inferPosition(window) {
  const before = String(window?.before || "").slice(-14);
  const after = String(window?.after || "").slice(0, 14);
  if (/(?:守备表示|守備表示|防守表示)(?:的)?[「『【“"]?\s*$/u.test(before)
      || /^[」』】”"]?\s*(?:守备表示|守備表示|防守表示)/u.test(after)) return "defense";
  if (/(?:攻击表示|攻擊表示|攻撃表示)(?:的)?[「『【“"]?\s*$/u.test(before)
      || /^[」』】”"]?\s*(?:攻击表示|攻擊表示|攻撃表示)/u.test(after)) return "attack";
  return "";
}

function inferFaceUp(fieldCard, nearbyText, position) {
  if (!fieldCard) return false;
  const text = String(nearbyText || "");
  if (/(?:里侧|裏側|盖放|蓋放|face-down)/iu.test(text)) return false;
  if (/(?:表侧|表側|face-up)/iu.test(text)) return true;
  if (position === "attack" || position === "defense") return true;
  if (/(?:召唤|召喚|特殊召唤|特殊召喚|Normal Summon|Special Summon)/iu.test(text)) return true;
  return null;
}

function inferEffectCategory(cardType, effectText = "") {
  const value = String(cardType || "").normalize("NFKC");
  if (/(?:怪兽|怪獸|モンスター|monster|fusion|synchro|xyz|link|ritual|pendulum|融合|同调|同步|超量|连接|連接|仪式|儀式|灵摆|靈擺)/iu.test(value)) {
    return { category: "monster", basis: "explicit_card_type" };
  }
  if (/(?:魔法|魔法カード|spell)/iu.test(value)) {
    return { category: "spell", basis: "explicit_card_type" };
  }
  if (/(?:陷阱|罠|trap)/iu.test(value)) {
    return { category: "trap", basis: "explicit_card_type" };
  }
  if (value.trim()) return { category: "unknown", basis: "unrecognized_card_type" };

  const text = String(effectText || "").normalize("NFKC");
  if (SELF_SUMMON_TRIGGER.test(text)) {
    return { category: "monster", basis: "effect_text_source_summon_trigger" };
  }
  if (SPECIAL_SUMMON_SOURCE_FROM_HAND.test(text)) {
    return { category: "monster", basis: "effect_text_special_summon_self" };
  }
  if (SELF_IN_MONSTER_ZONE.test(text)) {
    return { category: "monster", basis: "effect_text_self_in_monster_zone" };
  }
  return { category: "unknown", basis: "missing_card_type_without_monster_structure" };
}

function localWindow(query, index, surfaceLength, beforeLength, afterLength) {
  const text = String(query || "");
  const before = text.slice(Math.max(0, index - beforeLength), index);
  const after = text.slice(index + surfaceLength, index + surfaceLength + afterLength);
  return { before, after, full: `${before}${text.slice(index, index + surfaceLength)}${after}` };
}

function summarizeResolvedLink(result, preparedLinks, instances, programs) {
  if (!result || result.status === "negated") return "";
  const prepared = (preparedLinks || []).find((link) => link.id === result.id);
  const source = programByDefinitionId(programs, prepared?.sourceDefinitionId);
  const changes = result.primitiveResult?.stateChanges || [];
  const returned = changes.find((item) => item.type === "return_target_to_hand");
  const summoned = changes.find((item) => item.type === "special_summon_source");
  if (returned && summoned) {
    const target = instanceById(instances, returned.cardId);
    return `C${result.order}「${source?.name || result.sourceCardName}」先处理：将「${target?.name || "对象怪兽"}」返回手牌，再从手牌特殊召唤自身。`;
  }
  return `C${result.order}「${source?.name || result.sourceCardName}」先完成处理。`;
}

function evidenceIdFor(program, cardTexts) {
  const direct = (cardTexts || []).find((item) => String(item.id || "").includes(program.definitionId));
  if (direct?.id) return String(direct.id);
  const byName = (cardTexts || []).find((item) => (
    [...(item.cards || []), item.title].filter(Boolean).some((name) => program.names.some((alias) => normalize(name).includes(normalize(alias))))
  ));
  return String(byName?.id || `card-text-${program.definitionId}`);
}

function serializeProgram(program) {
  return {
    definitionId: program.definitionId,
    name: program.name,
    names: program.names,
    cardType: program.cardType,
    race: program.race,
    effectCategory: program.effectCategory,
    effectCategoryBasis: program.effectCategoryBasis,
    sharedRestrictionText: program.sharedRestrictionText,
    materialRecipe: program.materialRecipe,
    activatedEffects: program.activatedEffects,
    continuousEffects: program.continuousEffects,
  };
}

function programByDefinitionId(programs, definitionId) {
  return programs.find((program) => String(program.definitionId) === String(definitionId));
}

function instanceById(instances, instanceId) {
  return (instances || []).find((instance) => String(instance.instanceId || instance.cardId) === String(instanceId));
}

function declaredActivationTrace(link) {
  return {
    phase: "activation_declaration",
    chainLink: link.id,
    status: "declared_legal",
    sourceInstanceId: link.sourceInstanceId,
    sourceDefinitionId: link.sourceDefinitionId,
    conclusion: `按题设已满足展示等发动手续，${link.id}可以发动；该前提不由最终处理结果反推。`,
  };
}

function serializeCompiledSimulation(programs, compiled, simulation) {
  const activationLinks = simulation.preparedChainLinks?.length
    ? simulation.preparedChainLinks
    : compiled.chainLinks || [];
  return {
    type: "compiled_duel_state_simulation",
    identityModel: "definition_id_and_instance_id_separated",
    cardPrograms: programs
      .filter((program) => compiled.referencedDefinitionIds.includes(program.definitionId))
      .map(serializeProgram),
    initialState: serializeDuelState(compiled.gameState),
    activationPremises: activationLinks.map((link) => ({
      chainLink: link.id,
      status: link.activationPremise,
      sourceInstanceId: link.sourceInstanceId,
      sourceDefinitionId: link.sourceDefinitionId,
    })),
    preparedChainLinks: simulation.preparedChainLinks,
    compiledChainLinks: compiled.chainLinks,
    finalState: serializeDuelState(simulation.finalGameState),
    stateSnapshots: simulation.stateSnapshots,
    stateInferences: compiled.stateInferences || [],
  };
}

function serializeDuelState(state = {}) {
  const cards = JSON.parse(JSON.stringify(state.cards || []));
  return {
    ...JSON.parse(JSON.stringify(state || {})),
    cards,
    entities: cards.map((card) => ({
      id: card.instanceId || card.cardId,
      instanceId: card.instanceId || card.cardId,
      definitionId: card.definitionId,
      name: card.name,
      controller: card.controller,
      zone: card.zone,
      race: card.race,
      modifiers: (card.derivedModifiers || []).map((modifier) => modifier.type),
    })),
  };
}

function positionLabel(value) {
  if (value === "attack") return "攻击表示";
  if (value === "defense") return "守备表示";
  return "未稳定的表示形式";
}

function zoneLabel(value) {
  if (value === "monster_zone") return "怪兽区域";
  if (value === "hand") return "手牌";
  return value || "未知区域";
}

function incomplete(reason, extra = {}) {
  return { complete: false, reason, ...extra };
}

function notApplicable(reason, debug = {}) {
  return { status: "not_applicable", complete: false, reason, trace: [], evidenceIds: [], debug };
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function fuzzyContains(container, fragment) {
  const haystack = normalize(container);
  const needle = normalize(fragment);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;
  if (needle.length < 4) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (editDistanceAtMostOne(haystack.slice(index, index + needle.length), needle)) return true;
  }
  return false;
}

function editDistanceAtMostOne(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let first = left;
  let second = right;
  if (first.length > second.length) [first, second] = [second, first];
  let edits = 0;
  for (let firstIndex = 0, secondIndex = 0; firstIndex < first.length || secondIndex < second.length;) {
    if (first[firstIndex] === second[secondIndex]) {
      firstIndex += 1;
      secondIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (first.length === second.length) firstIndex += 1;
    secondIndex += 1;
  }
  return true;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}
