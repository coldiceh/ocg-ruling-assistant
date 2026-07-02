import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockerAnswer, evaluateRulingBlockers } from "../backend/rulingBlockers.mjs";

const disasterLeo = { id: "11016", name: "混沌No.88 机关傀儡-灾厄狮子", cardType: "monster", effectText: "在自己的结束阶段，对手的LP为２０００以下，且此卡没有超量素材的情况下，自己获得决斗胜利。双方不可将场上的此卡作为效果的对象。" };
const poison = { id: "5607", name: "隐居者的猛毒药", cardType: "spell", effectText: "给予对方800伤害。" };
const impermanence = { id: "13631", name: "无限泡影", cardType: "trap", effectText: "以对手场上的1只表侧表示怪兽为对象可以发动。" };
const thunder = { id: "22130", name: "天雷之双风神", cardType: "monster", effectText: "对手发动魔法・陷阱效果时可以发动。将场上的魔法・陷阱卡全部放回手牌。" };

test("target protection makes the original chain illegal and preserves a hypothetical branch", () => {
  const question = "在我方的结束阶段，我方场上有1只没有素材的【混沌No.88 机关傀儡-灾厄狮子】，对方基本分2500。对方c1发动【雷破】以灾厄狮子为对象，我方c2发动【隐居者的猛毒药】给与对方800伤害。";
  const result = evaluateRulingBlockers({ question, cards: [disasterLeo, poison] });
  assert.equal(result.primaryVerdict, "original_chain_illegal");
  assert.equal(result.hypotheticalBranch.verdict, "immediate_special_win");
  assert.match(result.resolutionSteps[0].action, /2500.*1700/u);
  assert.match(result.resolutionSteps.at(-1).action, /C1不再处理/u);
  assert.equal(result.resolutionSteps.at(-1).status, "not_processed");
  assert.equal(result.resolutionSteps.at(-1).reason, "duel_already_ended");
  assert.equal(result.afterResolutionCheckpoints[0].timing, "after_resolution_checkpoint");
  assert.match(buildBlockerAnswer(result).shortAnswer, /连锁不成立/u);
});
test("the immediate special win condition does not start a chain", () => {
  const result = evaluateRulingBlockers({ question: "我方结束阶段，对方基本分2500，我方场上有1只没有素材的灾厄狮子。对方C1发动雷破取灾厄狮子为对象，我方C2给与对方800伤害。", cards: [disasterLeo, poison] });
  assert.ok(result.resolutionSteps.some((item) => /不开连锁.*立即胜利/u.test(item.action)));
});
test("an activated normal trap cannot be returned and leaves no applicable mandatory return", () => {
  const question = "我方以怪兽为对象发动『无限泡影』，这个时候场上没有其他魔陷，对方能不能发动『天雷之双风神』的效果？";
  const result = evaluateRulingBlockers({ question, cards: [impermanence, thunder] });
  assert.equal(result.primaryVerdict, "cannot_activate");
  assert.ok(result.blockers.some((item) => item.id === "chain_activated_normal_spell_trap_cannot_return_to_hand_or_deck"));
  assert.ok(result.blockers.some((item) => item.id === "no_applicable_card_for_mandatory_return_effect"));
});
