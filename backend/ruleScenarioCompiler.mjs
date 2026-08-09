import { findNormalizedSemantics, normalizeCardText } from "./cardTextNormalizer.mjs";
import { analyzeSimultaneousTriggerScenario } from "./simultaneousTriggerChain.mjs";

const MANDATORY_FIELD_SPELL_TRAP_RETURN = /将(?:双方)?场上的魔法[・·]?陷阱卡(?:全部)?(?:放回|返回|回到)(?:持有者的)?(?:手牌|手卡|卡组|牌组)/u;
const DESTRUCTION_THREAT = "(?:被(?:战斗|戰鬥|戦闘)[・·]?(?:效果|効果)?破坏|被(?:效果|効果)破坏|要被(?:战斗|戰鬥|戦闘)?[・·]?(?:效果|効果)?破坏|(?:戦闘[・·]?効果|戦闘|効果)で破壊される場合|破壊される場合)";
const REPLACEMENT_WORDING = "(?:作为代替|作為代替|代わりに)";
const DESTROY_ANOTHER_REPLACEMENT = new RegExp(
  DESTRUCTION_THREAT + ".{0,100}?" + REPLACEMENT_WORDING + ".{0,100}?(?:破坏|破壊|送去墓地|墓地へ送|除外|解放|リリース)",
  "su",
);
const STATE_CHANGE_REPLACEMENT = new RegExp(
  "(?:" + DESTRUCTION_THREAT + ".{0,100}?" + REPLACEMENT_WORDING
    + ".{0,100}?(?:攻击力|攻擊力|攻撃力).{0,24}?(?:下降|降低|下げ|下が)"
    + "|(?:攻击力|攻擊力|攻撃力).{0,24}?(?:下降|降低|下げ|下が).{0,100}?" + REPLACEMENT_WORDING + ")",
  "su",
);
const DESTROY_THEN_SPECIAL_SUMMON = /(?:破坏|破壊)[^。；;\n]{0,140}(?:特殊召唤|特殊召喚)/u;
const ACTIVATION_WORD = "(?:发动|發動|発動|activate)";

export function compileRuleScenario({
  userQuery = "",
  cardTexts = [],
  movementEvents = [],
  branchWitness = null,
} = {}) {
  const query = String(userQuery || "");
  const cards = (cardTexts || []).map((item, index) => {
    const id = String(item.id || item.evidenceId || "scenario-card-text-" + (index + 1));
    const names = [...(item.cards || []), item.title].filter(Boolean);
    const cardType = String(item.cardType || item.type || "");
    const text = String(item.text || "");
    const normalizedText = normalizeCardText({
      ...item,
      id: item.cardId || item.cardIds?.[0] || id,
      cardId: item.cardId || item.cardIds?.[0] || "",
      name: names[0] || item.title || "卡片文本",
      aliases: names,
      cardType,
      effectText: text,
    });
    return {
      id,
      identityIds: [...new Set([
        item.id,
        item.evidenceId,
        item.cardId,
        ...(Array.isArray(item.cardIds) ? item.cardIds : []),
      ].map((value) => String(value || "")).filter(Boolean))],
      title: String(item.title || (item.cards || [])[0] || "卡片文本"),
      names,
      cardType,
      text,
      normalizedText,
    };
  });

  const mandatoryFieldSpellTrapReturn = cards.some((item) => MANDATORY_FIELD_SPELL_TRAP_RETURN.test(item.text));
  const activationMentioned = /(?:发动|發動|発動|activate)/iu.test(query);
  const explicitSpellTrapActivation = /(?:发动|發動|発動).{0,36}(?:魔法|陷阱|罠)|(?:魔法|陷阱|罠).{0,36}(?:发动|發動|発動)/su.test(query);
  const mentionedSpellTrapProfile = cards.some((item) => (
    /(?:spell|trap|魔法|陷阱|罠)/iu.test(item.cardType)
    && item.names.some((name) => nameMentioned(query, name))
  ));
  const currentChainSpellTrap = activationMentioned && (explicitSpellTrapActivation || mentionedSpellTrapProfile);
  const noOtherSpellTraps = /(?:没有|不存在|并无|无).{0,16}其他.{0,16}(?:魔法|陷阱|魔陷|后场)/su.test(query)
    || /(?:后场|魔法[・·]?陷阱区域|魔陷区).{0,36}(?:只有|仅有|只存在).{0,36}(?:刚刚|正在|已)?发动/su.test(query)
    || /(?:场上|后场).{0,24}(?:只有|仅有|只存在).{0,24}(?:这张|该|刚刚|正在).{0,12}(?:魔法|陷阱|发动)/su.test(query);

  const continuousHandRevealCards = cards
    .map((item) => ({
      ...item,
      revealedHandSide: normalizedHandVisibilitySide(item.normalizedText),
    }))
    .filter((item) => item.revealedHandSide);
  const continuousOwnHandRevealCards = continuousHandRevealCards.filter((item) => (
    item.revealedHandSide === "controller" || item.revealedHandSide === "both"
  ));
  const continuousOpponentHandRevealCards = continuousHandRevealCards.filter((item) => (
    item.revealedHandSide === "opponent" || item.revealedHandSide === "both"
  ));
  const revealOwnHandActivationCards = cards
    .map((item) => ({
      ...item,
      revealActivationProcedures: findNormalizedSemantics(
        item.normalizedText,
        (semantic) => semantic.type === "reveal_hand"
          && semantic.timing === "activation"
          && semantic.handOwner === "controller",
      ).map(({ semantic }) => semantic),
    }))
    .filter((item) => (
      item.revealActivationProcedures.length > 0
      && item.names.some((name) => nameMentioned(query, name))
    ));
  const selfHandExplicitlyPublic = /(?:我方|自己|本方)(?:的)?(?:手牌|手卡).{0,20}(?:已经|已|持续|全部)?(?:公开|展示)/su.test(query);
  const opponentHandExplicitlyPublic = /(?:对方|對方|对手|相手)(?:的)?(?:手牌|手卡|手札).{0,20}(?:已经|已|持续|全部)?(?:公开|公開|展示)/su.test(query);
  const handVisibilityFacts = inferHandVisibilityFacts(query, continuousHandRevealCards);
  if (selfHandExplicitlyPublic) handVisibilityFacts.selfHandPublic = true;
  if (opponentHandExplicitlyPublic) handVisibilityFacts.opponentHandPublic = true;
  const selfHandContinuouslyPublic = selfHandExplicitlyPublic || handVisibilityFacts.selfHandPublic;
  const opponentHandContinuouslyPublic = opponentHandExplicitlyPublic || handVisibilityFacts.opponentHandPublic;
  const revealActivationOperations = buildRevealActivationOperations(query, revealOwnHandActivationCards);
  const blockedRevealActivationOperations = revealActivationOperations
    .filter((operation) => (
      operation.actor === "self"
        ? selfHandContinuouslyPublic
        : operation.actor === "opponent"
          ? opponentHandContinuouslyPublic
          : false
    ))
    .map((operation) => ({
      ...operation,
      publicSourceId: handVisibilityFacts.sources.find((source) => (
        (source.affectedSides || []).includes(operation.actor)
      ))?.id || "",
    }));
  const revealOwnHandActivationRequired = revealActivationOperations.some((operation) => operation.actor === "self");

  const replacementEffects = cards
    .map((item) => ({
      ...item,
      replacementKind: DESTROY_ANOTHER_REPLACEMENT.test(item.text)
        ? "destroy_another"
        : STATE_CHANGE_REPLACEMENT.test(item.text)
          ? "state_change"
          : "",
    }))
    .filter((item) => item.replacementKind);
  const destructionDependentFollowUps = cards.filter((item) => DESTROY_THEN_SPECIAL_SUMMON.test(item.text));
  const queryDescribesStateChangeReplacement = /(?:作为|作為).{0,20}(?:被)?破坏.{0,12}(?:的)?(?:替代|代替).{0,40}(?:攻击力|攻擊力|攻撃力).{0,16}(?:下降|降低)|(?:攻击力|攻擊力|攻撃力).{0,16}(?:下降|降低).{0,40}(?:替代|代替)/su.test(query);
  const bothReplacementKinds = replacementEffects.some((item) => item.replacementKind === "destroy_another")
    && (replacementEffects.some((item) => item.replacementKind === "state_change") || queryDescribesStateChangeReplacement);

  const bothPlayerRoles = /(?:我方|自己|自分)/u.test(query) && /(?:对方|对手|相手)/u.test(query);
  const sameDestructionEvent = /(?:双方|两只|两张|彼此).{0,36}(?:都|将|要|会).{0,24}(?:被)?(?:战斗[・·]?效果)?(?:破坏|送去墓地)/su.test(query)
    || /(?:攻击力相同|同攻击力|相杀).{0,36}(?:战斗|攻击|破坏)/su.test(query)
    || replacementMakesOtherCarrierDestructionCandidate(query);
  const turnPlayerSide = inferTurnPlayerSide(query, cards);
  const turnPlayerKnown = Boolean(turnPlayerSide);
  const firstReplacementRemovesNonTurnCarrier = turnPlayerKnown
    && replacementRemovesOtherSideCarrier(query, turnPlayerSide);
  const simultaneousDestructionReplacement = bothPlayerRoles
    && sameDestructionEvent
    && (replacementEffects.length >= 1 || bothReplacementKinds);
  const replacementSequenceComplete = simultaneousDestructionReplacement
    && turnPlayerKnown
    && firstReplacementRemovesNonTurnCarrier;
  const simultaneousTriggerChain = analyzeSimultaneousTriggerScenario({
    userQuery: query,
    cardTexts,
    movementEvents,
    turnPlayer: turnPlayerSide || "self",
    branchWitness,
  });

  return {
    mandatoryFieldSpellTrapReturn,
    currentChainSpellTrap,
    noOtherSpellTraps,
    selfHandContinuouslyPublic,
    opponentHandContinuouslyPublic,
    revealOwnHandActivationRequired,
    publicHandRevealProcedureBlocked: blockedRevealActivationOperations.length > 0,
    handVisibilityFacts,
    continuousHandRevealCards,
    continuousOwnHandRevealCards,
    continuousOpponentHandRevealCards,
    revealOwnHandActivationCards,
    revealActivationOperations,
    blockedRevealActivationOperations,
    destructionReplacement: replacementEffects.length > 0 || queryDescribesStateChangeReplacement,
    bothPlayerRoles,
    sameDestructionEvent,
    turnPlayerKnown,
    turnPlayerSide,
    firstReplacementRemovesNonTurnCarrier,
    replacementEffects,
    destructionDependentFollowUps,
    simultaneousDestructionReplacement,
    replacementSequenceComplete,
    originalDestructionReplaced: replacementSequenceComplete,
    nonTurnReplacementCarrierDestroyed: replacementSequenceComplete,
    dependentSpecialSummonNotPerformed: replacementSequenceComplete && destructionDependentFollowUps.length > 0,
    simultaneousTriggerChain,
    simultaneousPublicPrivateTriggers: simultaneousTriggerChain.mode === "public_private",
  };
}

function normalizedHandVisibilitySide(normalizedText) {
  const affected = new Set(findNormalizedSemantics(
    normalizedText,
    (semantic) => semantic.type === "hand_visibility"
      && semantic.visibility === "public"
      && semantic.duration === "continuous",
  ).map(({ semantic }) => semantic.affected));
  if (affected.has("both") || (affected.has("controller") && affected.has("opponent"))) return "both";
  if (affected.has("opponent")) return "opponent";
  if (affected.has("controller")) return "controller";
  return "";
}

function inferHandVisibilityFacts(query, cards) {
  const facts = {
    selfHandPublic: false,
    opponentHandPublic: false,
    sources: [],
  };
  for (const card of cards) {
    const relation = inferContinuousEffectRelation(query, card);
    if (!relation) continue;
    const affectedSides = [];

    if (relation === "self_affected") {
      facts.selfHandPublic = true;
      affectedSides.push("self");
    } else if (relation === "opponent_affected") {
      facts.opponentHandPublic = true;
      affectedSides.push("opponent");
    } else if (relation === "self_controls") {
      if (card.revealedHandSide === "controller" || card.revealedHandSide === "both") {
        facts.selfHandPublic = true;
        affectedSides.push("self");
      }
      if (card.revealedHandSide === "opponent" || card.revealedHandSide === "both") {
        facts.opponentHandPublic = true;
        affectedSides.push("opponent");
      }
    } else if (relation === "opponent_controls") {
      if (card.revealedHandSide === "opponent" || card.revealedHandSide === "both") {
        facts.selfHandPublic = true;
        affectedSides.push("self");
      }
      if (card.revealedHandSide === "controller" || card.revealedHandSide === "both") {
        facts.opponentHandPublic = true;
        affectedSides.push("opponent");
      }
    }

    facts.sources.push({
      id: card.id,
      title: card.title,
      relation,
      revealedHandSide: card.revealedHandSide,
      affectedSides,
    });
  }
  return facts;
}

function buildRevealActivationOperations(query, cards) {
  return cards.map((card) => {
    const actor = inferCardActivationActor(query, card);
    const procedure = card.revealActivationProcedures?.[0] || null;
    return {
      id: `reveal-own-hand-activation:${card.id}`,
      actor,
      displayedHandSide: actor,
      viewerSide: actor === "self" ? "opponent" : actor === "opponent" ? "self" : "unknown",
      cardId: card.id,
      cardTitle: card.title,
      card,
      requiresOwnHandReveal: true,
      normalizedProcedure: procedure,
    };
  }).filter((operation) => operation.actor !== "unknown");
}

function inferCardActivationActor(query, card) {
  const clauses = String(query || "")
    .split(/[，,。；;！？?\n]+/u)
    .map((value) => value.trim())
    .filter((value) => (
      new RegExp(ACTIVATION_WORD, "iu").test(value)
      && card.names.some((name) => nameMentioned(value, name))
    ));
  for (const clause of clauses) {
    const activationIndex = clause.search(new RegExp(ACTIVATION_WORD, "iu"));
    if (activationIndex < 0) continue;
    const actors = [...clause.matchAll(/(?:我方|自己|本方|自分|对方|對方|对手|相手)/gu)];
    const preceding = actors.filter((match) => Number(match.index) <= activationIndex).at(-1);
    const selected = preceding || actors[0];
    if (!selected) continue;
    return /^(?:我方|自己|本方|自分)$/u.test(selected[0]) ? "self" : "opponent";
  }
  return "unknown";
}

function inferContinuousEffectRelation(query, card) {
  const names = card.names.filter(Boolean).sort((left, right) => right.length - left.length);
  for (const name of names) {
    if (!nameMentioned(query, name)) continue;
    const escaped = escapeRegExp(String(name));
    const applies = "(?:效果)?(?:适用中|適用中|正在适用|正在適用|生效中)";
    if (new RegExp("(?:我方|自己|本方).{0,18}(?:控制|操控|场上(?:存在|有)?|場上(?:存在|有)?|发动|發動|使用|持有).{0,18}" + escaped, "su").test(query)
      || new RegExp("(?:我方|自己|本方)(?:的|场上的|場上的)" + escaped, "su").test(query)) {
      return "self_controls";
    }
    if (new RegExp("(?:对方|對方|对手).{0,18}(?:控制|操控|场上(?:存在|有)?|場上(?:存在|有)?|发动|發動|使用|持有).{0,18}" + escaped, "su").test(query)
      || new RegExp("(?:对方|對方|对手)(?:的|场上的|場上的)" + escaped, "su").test(query)) {
      return "opponent_controls";
    }
    if (new RegExp("(?:我方|自己|本方).{0,12}" + escaped + ".{0,12}" + applies, "su").test(query)
      || new RegExp("(?:我方|自己|本方).{0,12}(?:受到|受|处于|處於).{0,12}" + escaped + ".{0,12}" + applies, "su").test(query)) {
      return "self_affected";
    }
    if (new RegExp("(?:对方|對方|对手).{0,12}" + escaped + ".{0,12}" + applies, "su").test(query)
      || new RegExp("(?:对方|對方|对手).{0,12}(?:受到|受|处于|處於).{0,12}" + escaped + ".{0,12}" + applies, "su").test(query)) {
      return "opponent_affected";
    }
  }
  return "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferTurnPlayerSide(query, cards) {
  if (/(?:我方|自己)(?:的)?回合|轮到(?:我|我方|自己)/u.test(query)) return "self";
  if (/(?:对方|对手)(?:的)?回合|轮到(?:对方|对手)/u.test(query)) return "opponent";

  const ignitionLikeEffect = cards.some((item) => (
    DESTROY_THEN_SPECIAL_SUMMON.test(item.text)
    && /(?:自己主要阶段|自分メインフェイズ|从手牌|从手卡|手札から)/u.test(item.text)
  ));
  if (ignitionLikeEffect && actorActivatesFromHand(query, /(?:对方|对手)/u)) return "opponent";
  if (ignitionLikeEffect && actorActivatesFromHand(query, /(?:我方|自己)/u)) return "self";
  return "";
}

function actorActivatesFromHand(query, actorPattern) {
  const actor = actorPattern.source;
  return new RegExp(actor + ".{0,24}(?:(?:发动|發動|発動).{0,40}(?:手卡|手牌|手札)|(?:手卡|手牌|手札).{0,40}(?:发动|發動|発動)).{0,40}(?:效果|効果)", "su").test(query);
}

function replacementMakesOtherCarrierDestructionCandidate(query) {
  return /(?:对方|对手|我方|自己).{0,100}(?:选择|选|适用|使用).{0,80}(?:代替|替代).{0,100}(?:破坏|破壊).{0,80}(?:我方|自己|对方|对手)/su.test(query)
    || /(?:作为|作為).{0,30}(?:破坏|破壊).{0,12}(?:的)?(?:代替|替代).{0,100}(?:将|把)?.{0,80}(?:我方|自己|对方|对手).{0,80}(?:破坏|破壊)/su.test(query);
}

function replacementRemovesOtherSideCarrier(query, turnPlayerSide) {
  const acting = turnPlayerSide === "self" ? "(?:我方|自己)" : "(?:对方|对手)";
  const other = turnPlayerSide === "self" ? "(?:对方|对手)" : "(?:我方|自己)";
  const appliesReplacement = "(?:先.{0,12})?(?:选择|选|适用|使用).{0,60}(?:代替|替代|效果)";
  const removal = "(?:破坏|破壊|送去墓地|除外|解放)";
  return new RegExp(acting + ".{0,60}" + appliesReplacement + ".{0,100}(?:" + removal + ".{0,40}" + other + "|" + other + ".{0,60}" + removal + ")", "su").test(query)
    || new RegExp(acting + ".{0,80}(?:作为|作為).{0,30}代替.{0,80}(?:将|把)?" + other + ".{0,60}" + removal, "su").test(query);
}

function nameMentioned(query, value) {
  const haystack = normalize(value ? query : "");
  const needle = normalize(value);
  return needle.length >= 2 && haystack.includes(needle);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[の之的]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
