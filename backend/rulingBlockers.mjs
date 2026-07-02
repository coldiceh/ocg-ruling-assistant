import { createResolutionGameState, resolveChainWithCheckpoints } from "./afterResolutionCheckpoint.mjs";
import { extractSpecialWinConditions } from "./specialWinConditions.mjs";

export const RULING_BLOCKER_IDS = Object.freeze([
  "target_protection_prevents_activation",
  "chain_activated_normal_spell_trap_cannot_return_to_hand_or_deck",
  "no_applicable_card_for_mandatory_return_effect",
  "immediate_special_win_condition_ends_duel",
]);

export function evaluateRulingBlockers({ question = "", cards = [] } = {}) {
  const text = String(question || "");
  const profiles = uniqueCards(cards);
  const targetProtected = profiles.find((card) => /不可.*作为效果的对象|不能成为.*效果.*对象|効果の対象にできない|cannot be targeted/iu.test(card.effectText || card.text || ""));
  const specialWinner = profiles.find((card) => /获得决斗胜利|デュエルに勝利|win the duel/iu.test(card.effectText || card.text || ""));
  const targetsProtectedCard = targetProtected && /为对象|取对象|対象/iu.test(text);

  if (targetsProtectedCard) {
    const blockers = [blocker("target_protection_prevents_activation", "发动必须选择对象，但目标卡不能成为效果对象。", targetProtected)];
    const answer = {
      primaryVerdict: "original_chain_illegal",
      reason: `正常情况下，发动卡不能以${displayName(targetProtected)}为对象，因此原连锁不合法。`,
      hypotheticalBranch: null,
      resolutionSteps: [],
      finalJudgeSummary: [
        `正常情况：不能以${displayName(targetProtected)}为对象发动，题述连锁不成立。`,
      ],
      confirmationLevel: "rule_derived",
      normalRuling: {
        verdict: "activation_illegal",
        reason: `不能以${displayName(targetProtected)}为对象发动，因此${/C1/iu.test(text) ? "C1" : "该"}发动非法，题述连锁不成立。`,
        confirmationLevel: "rule_derived",
        evidenceIds: targetProtected.id ? [String(targetProtected.id)] : [],
      },
      afterResolutionCheckpoints: [],
      finalGameState: null,
      terminalVerdict: null,
    };
    if (specialWinner) {
      const scenario = buildHypotheticalChainScenario(text, specialWinner, targetProtected, profiles);
      const resolved = scenario ? resolveChainWithCheckpoints({
        initialGameState: scenario.initialGameState,
        chainLinks: scenario.chainLinks,
        cards: profiles,
        specialWinConditions: extractSpecialWinConditions(profiles),
      }) : null;
      if (resolved?.terminalVerdict?.type === "special_win") {
        blockers.push(blocker("immediate_special_win_condition_ends_duel", "卡片规定的特殊胜利条件满足时立即结束决斗，不开连锁。", specialWinner));
        answer.hypotheticalBranch = {
          assumption: `假设${displayName(targetProtected)}的对象保护被无效，原发动可以合法取对象。`,
          verdict: "immediate_special_win",
          confirmationLevel: "conditional",
          resolutionSteps: resolved.resolutionSteps,
          chainLinks: resolved.chainLinks,
          checkpoints: resolved.checkpoints,
          terminalVerdict: resolved.terminalVerdict,
        };
        answer.resolutionSteps = resolved.resolutionSteps;
        answer.afterResolutionCheckpoints = resolved.checkpoints;
        answer.finalGameState = resolved.finalGameState;
        answer.terminalVerdict = resolved.terminalVerdict;
        answer.finalJudgeSummary.push(`假设情况：C2处理后特殊胜利条件立即满足，决斗结束，C1不再处理。`);
      }
    }
    return { hasBlocker: true, blockers, ...answer };
  }

  const returner = profiles.find((card) => /魔法.{0,3}陷阱卡?全部放回手牌|魔法・罠カードを全て持ち主の手札に戻す/iu.test(card.effectText || card.text || ""));
  const activatedNormal = profiles.find((card) => isNormalSpellTrap(card) && mentionsCard(text, card) && /发动|発動|activate/iu.test(text));
  const noOtherBackrow = /没有其他魔陷|没有其它魔陷|不存在其他魔法.{0,3}陷阱|no other spell.*trap/iu.test(text);
  if (returner && activatedNormal && noOtherBackrow) {
    const blockers = [
      blocker("chain_activated_normal_spell_trap_cannot_return_to_hand_or_deck", "发动后处于连锁中的通常魔法/陷阱不能返回手牌或卡组。", activatedNormal),
      blocker("no_applicable_card_for_mandatory_return_effect", "必须执行的返回处理没有可适用的魔法/陷阱。", returner),
    ];
    return {
      hasBlocker: true,
      blockers,
      primaryVerdict: "cannot_activate",
      reason: `不能发动。正在发动中的${displayName(activatedNormal)}不能返回手牌，且场上没有其他可返回的魔法/陷阱，因此${displayName(returner)}要求的处理没有可适用卡。`,
      hypotheticalBranch: null,
      resolutionSteps: [],
      finalJudgeSummary: [`正常情况：${displayName(returner)}不能发动。`, `理由：对应通常陷阱仍在连锁中，且没有其他可执行返回处理的魔法/陷阱。`],
      confirmationLevel: "rule_derived",
      normalRuling: {
        verdict: "cannot_activate",
        reason: `正在发动中的${displayName(activatedNormal)}不能返回手牌，且没有其他可执行返回处理的魔法/陷阱。`,
        confirmationLevel: "rule_derived",
        evidenceIds: blockers.flatMap((item) => item.evidenceIds),
      },
    };
  }
  return { hasBlocker: false, blockers: [], primaryVerdict: null, reason: "", hypotheticalBranch: null, resolutionSteps: [], finalJudgeSummary: [] };
}

export function buildBlockerAnswer(result) {
  if (!result?.hasBlocker) return null;
  return {
    answerType: "rule_judgment",
    verdict: result.primaryVerdict,
    shortAnswer: result.finalJudgeSummary.join(" "),
    judgeReasoning: result.blockers.slice(0, 3).map((item) => ({ text: item.reason, basis: ["card_text", "rule_blocker"], refs: item.evidenceIds })),
    requiredFacts: [],
    assumptions: result.hypotheticalBranch ? [result.hypotheticalBranch.assumption] : [],
    possibleCounterCases: [],
    confidence: "medium",
    blockers: result.blockers,
    primaryVerdict: result.primaryVerdict,
    hypotheticalBranch: result.hypotheticalBranch,
    resolutionSteps: result.resolutionSteps,
    finalJudgeSummary: result.finalJudgeSummary,
    confirmationLevel: result.confirmationLevel || "rule_derived",
    normalRuling: result.normalRuling || null,
    afterResolutionCheckpoints: result.afterResolutionCheckpoints || [],
    finalGameState: result.finalGameState || null,
    terminalVerdict: result.terminalVerdict || null,
  };
}

function buildHypotheticalChainScenario(question, winner, target, cards) {
  const normalized = String(question || "").normalize("NFKC");
  const lp = Number(question.match(/(?:基本分|LP)\s*(\d{3,5})/iu)?.[1] || 0);
  const damageCard = cards.find((card) => /(?:给予|给与)(?:对手|对方)\s*[８8]００|相手に\s*[８8]００|800\s*(?:伤害|damage)/iu.test(card.effectText || card.text || ""));
  const damage = Number(normalized.match(/(?:给予|给与).*?(\d{3,5})\s*伤害/iu)?.[1] || (damageCard ? 800 : 0));
  if (!lp || !damage || !/C1|c1/iu.test(normalized) || !/C2|c2/iu.test(normalized)) return null;
  const endPhase = /结束阶段|エンドフェイズ|end phase/iu.test(normalized);
  const noMaterials = /没有素材|没有超量素材|素材为0|no materials/iu.test(normalized);
  const onField = /场上有|场上存在|フィールドに存在|on the field/iu.test(normalized);
  const initialGameState = createResolutionGameState({
    lp: { opponent: lp },
    phase: endPhase ? "END_PHASE" : "UNKNOWN",
    chainPosition: "C2",
    cards: [{
      cardId: String(winner.id || winner.cardId || ""),
      name: displayName(winner),
      controller: "self",
      faceUp: onField ? true : null,
      onField: onField ? true : null,
      materialCount: noMaterials ? 0 : null,
      zone: onField ? "monster_zone" : "unknown",
    }],
  });
  return {
    initialGameState,
    chainLinks: [
      { id: "C1", order: 1, sourceCardName: extractChainSourceName(normalized, "C1") || "取对象效果", effect: { type: "destroy", targetCardId: String(target.id || target.cardId || "") } },
      { id: "C2", order: 2, sourceCardName: damageCard ? displayName(damageCard) : extractChainSourceName(normalized, "C2") || "伤害效果", effect: { type: "damage", player: "opponent", amount: damage } },
    ],
  };
}

function extractChainSourceName(text, chainId) {
  const escaped = chainId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const bracketed = String(text || "").match(new RegExp(`${escaped}\\s*发动[【「『]([^】」』]{2,40})[】」』]`, "iu"));
  if (bracketed) return bracketed[1];
  return String(text || "").match(new RegExp(`${escaped}\\s*发动([^\\s，。]{2,24}?)(?:以|取|为|给与|给予)`, "iu"))?.[1] || "";
}

function blocker(id, reason, card) {
  return { id, reason, evidenceIds: card?.id ? [String(card.id)] : [], sourceType: "card_text", maxStatus: "rule_judgment" };
}

function uniqueCards(cards) {
  const map = new Map();
  for (const card of cards || []) if (card?.id || card?.name) map.set(String(card.id || card.name), card);
  return [...map.values()];
}

function displayName(card) { return card?.cnName || card?.name || card?.jaName || "相关卡"; }
function mentionsCard(text, card) { return [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean).some((name) => text.includes(name) || text.includes(String(name).split(/\s+/u)[0])); }
function isNormalSpellTrap(card) { return /spell|trap|魔法|陷阱|罠/iu.test(card.cardType || "") && !/永续|continuous|场地|field|装备|equip/iu.test(card.cardType || ""); }
