import assert from "node:assert/strict";
import test from "node:test";
import { createResolutionGameState, resolveChainWithCheckpoints } from "../backend/afterResolutionCheckpoint.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";
import { buildBlockerAnswer, evaluateRulingBlockers } from "../backend/rulingBlockers.mjs";

const question = "在我方的结束阶段，我方场上有1只没有素材的【混沌No.88 机关傀儡-灾厄狮子】，对方基本分2500。对方C1发动【雷破】以灾厄狮子为对象，我方C2发动【隐居者的猛毒药】给与对方800伤害。请问在猛毒药的效果处理后会立刻胜利吗，C1的雷破还会处理吗？";
const disasterLeo = { id: "11016", name: "混沌No.88 机关傀儡-灾厄狮子", cardType: "monster", effectText: "在自己的结束阶段，对手的LP为２０００以下，且此卡没有超量素材的情况下，自己获得决斗胜利。双方不可将场上的此卡作为效果的对象。" };
const poison = { id: "5607", name: "隐居者的猛毒药", cardType: "spell", effectText: "给予对方800伤害。" };

function resolveHypothetical() {
  return resolveChainWithCheckpoints({
    initialGameState: createResolutionGameState({
      lp: { opponent: 2500 },
      phase: "END_PHASE",
      chainPosition: "C2",
      cards: [{ id: "11016", name: disasterLeo.name, controller: "self", faceUp: true, onField: true, materialCount: 0, zone: "monster_zone" }],
    }),
    chainLinks: [
      { id: "C1", order: 1, sourceCardName: "雷破", effect: { type: "destroy", targetCardId: "11016" } },
      { id: "C2", order: 2, sourceCardName: poison.name, effect: { type: "damage", player: "opponent", amount: 800 } },
    ],
    cards: [disasterLeo, poison],
  });
}

test("target_illegal_blocker: protected target makes C1 activation illegal", () => {
  const result = evaluateRulingBlockers({ question, cards: [disasterLeo, poison] });
  assert.equal(result.normalRuling.verdict, "activation_illegal");
  assert.ok(result.blockers.some((item) => item.id === "target_protection_prevents_activation"));
});

test("illegal_premise_with_hypothetical_branch: both ruling layers remain explicit", () => {
  const answer = buildBlockerAnswer(evaluateRulingBlockers({ question, cards: [disasterLeo, poison] }));
  assert.equal(answer.normalRuling.confirmationLevel, "rule_derived");
  assert.equal(answer.hypotheticalBranch.confirmationLevel, "conditional");
  assert.match(answer.hypotheticalBranch.assumption, /对象保护被无效/u);
});

test("chain_reverse_resolution_with_damage: C2 resolves first and updates LP 2500 to 1700", () => {
  const result = resolveHypothetical();
  assert.equal(result.chainLinks[0].id, "C2");
  assert.equal(result.chainLinks[0].status, "resolved");
  assert.deepEqual(result.chainLinks[0].stateChange.lp, { player: "opponent", before: 2500, after: 1700, amount: 800 });
});

test("after_resolution_checkpoint_special_win: C2 checkpoint finds the terminal special victory", () => {
  const result = resolveHypothetical();
  assert.equal(result.checkpoints[0].timing, "after_resolution_checkpoint");
  assert.equal(result.checkpoints[0].checks.specialWinConditions[0].status, "met");
  assert.equal(result.checkpoints[0].terminalVerdict.type, "special_win");
  assert.equal(result.checkpoints[0].terminalVerdict.startsChain, false);
  assert.equal(result.checkpoints[0].gameState.lp.opponent, 1700);
  assert.equal(result.checkpoints[0].gameState.phase, "END_PHASE");
  assert.equal(result.checkpoints[0].gameState.currentChainPosition, "C2");
  assert.equal(result.checkpoints[0].gameState.cards[0].faceUp, true);
  assert.equal(result.checkpoints[0].gameState.cards[0].materialCount, 0);
});

test("terminal_stops_remaining_chain_links: C1 is not processed after the duel ends", () => {
  const result = resolveHypothetical();
  const c1 = result.chainLinks.find((item) => item.id === "C1");
  assert.equal(c1.status, "not_processed");
  assert.equal(c1.reason, "duel_already_ended");
  assert.equal(result.finalGameState.duelEnded, true);
});

test("no_unsafe_confirmed: rule-derived blocker answer never becomes official confirmed", async () => {
  const answer = await answerRulingQuestionFast({
    question,
    snapshot: {
      cards: [disasterLeo, poison],
      records: [],
      snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: new Date().toISOString() },
    },
    modelInvoker: async () => { throw new Error("blocker path must not call the model"); },
  });
  assert.equal(answer.answerType, "rule_judgment");
  assert.equal(answer.confirmationLevel, "rule_derived");
  assert.notEqual(answer.statusChip, "OFFICIAL");
  assert.equal(answer.normalRuling.confirmationLevel, "rule_derived");
  assert.equal(answer.hypotheticalBranch.confirmationLevel, "conditional");
  assert.equal(answer.sourceSummary.officialQaRefs.length, 0);
});
