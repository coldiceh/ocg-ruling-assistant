const MANDATORY_FIELD_SPELL_TRAP_RETURN = /将(?:双方)?场上的魔法[・·]?陷阱卡(?:全部)?(?:放回|返回|回到)(?:持有者的)?(?:手牌|手卡|卡组|牌组)/u;
const DESTRUCTION_REPLACEMENT = /(?:被战斗[・·]?效果破坏|被战斗破坏|被效果破坏|要被(?:战斗[・·]?效果)?破坏).{0,80}?(?:作为代替|作為代替|代替.{0,10}(?:破坏|破壊)|代わりに).{0,80}?(?:破坏|破壊|送去墓地|除外|解放)/su;

export function compileRuleScenario({ userQuery = "", cardTexts = [] } = {}) {
  const query = String(userQuery || "");
  const cards = (cardTexts || []).map((item) => ({
    names: [...(item.cards || []), item.title].filter(Boolean),
    cardType: String(item.cardType || item.type || ""),
    text: String(item.text || ""),
  }));
  const mandatoryFieldSpellTrapReturn = cards.some((item) => MANDATORY_FIELD_SPELL_TRAP_RETURN.test(item.text));
  const destructionReplacement = cards.some((item) => DESTRUCTION_REPLACEMENT.test(item.text));
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
  const bothPlayerRoles = /(?:我方|自己|自分)/u.test(query) && /(?:对方|对手|相手)/u.test(query);
  const sameDestructionEvent = /(?:双方|两只|两张|彼此).{0,36}(?:都|将|要|会).{0,24}(?:被)?(?:战斗[・·]?效果)?(?:破坏|送去墓地)/su.test(query)
    || /(?:攻击力相同|同攻击力|相杀).{0,36}(?:战斗|攻击|破坏)/su.test(query);
  const turnPlayerKnown = /(?:我方|自己|对方|对手)(?:的)?回合|轮到(?:我|我方|自己|对方|对手)|turn player/iu.test(query);

  return {
    mandatoryFieldSpellTrapReturn,
    currentChainSpellTrap,
    noOtherSpellTraps,
    destructionReplacement,
    bothPlayerRoles,
    sameDestructionEvent,
    turnPlayerKnown,
    simultaneousDestructionReplacement: destructionReplacement && bothPlayerRoles && sameDestructionEvent,
  };
}

function nameMentioned(query, value) {
  const haystack = normalize(value ? query : "");
  const needle = normalize(value);
  return needle.length >= 2 && haystack.includes(needle);
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
