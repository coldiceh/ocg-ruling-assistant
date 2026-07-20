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

export function compileRuleScenario({ userQuery = "", cardTexts = [] } = {}) {
  const query = String(userQuery || "");
  const cards = (cardTexts || []).map((item, index) => ({
    id: String(item.id || item.evidenceId || "scenario-card-text-" + (index + 1)),
    title: String(item.title || (item.cards || [])[0] || "卡片文本"),
    names: [...(item.cards || []), item.title].filter(Boolean),
    cardType: String(item.cardType || item.type || ""),
    text: String(item.text || ""),
  }));

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

  return {
    mandatoryFieldSpellTrapReturn,
    currentChainSpellTrap,
    noOtherSpellTraps,
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
  };
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
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
