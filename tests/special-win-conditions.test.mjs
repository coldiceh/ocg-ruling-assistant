import assert from "node:assert/strict";
import test from "node:test";
import { createResolutionGameState } from "../backend/afterResolutionCheckpoint.mjs";
import { evaluateSpecialWinConditions, extractSpecialWinConditions } from "../backend/specialWinConditions.mjs";

const disasterLeo = {
  id: "11016",
  name: "混沌No.88 机关傀儡-灾厄狮子",
  effectText: "在自己的结束阶段，对手的LP为２０００以下，且此卡没有超量素材的情况下，自己获得决斗胜利。双方不可将场上的此卡作为效果的对象。",
};

test("special victory text becomes an extensible terminal non-chain condition", () => {
  const [condition] = extractSpecialWinConditions([disasterLeo]);
  assert.equal(condition.type, "special_win_condition");
  assert.equal(condition.condition.phase, "END_PHASE");
  assert.equal(condition.condition.materialCount, 0);
  assert.equal(condition.condition.opponentLpAtMost, 2000);
  assert.equal(condition.timing, "after_resolution_checkpoint");
  assert.equal(condition.startsChain, false);
  assert.equal(condition.terminal, true);
});

test("special victory is selected only when the checkpoint game state satisfies every condition", () => {
  const conditions = extractSpecialWinConditions([disasterLeo]);
  const gameState = createResolutionGameState({
    lp: { opponent: 1700 },
    phase: "END_PHASE",
    cards: [{ id: "11016", name: disasterLeo.name, controller: "self", faceUp: true, onField: true, materialCount: 0, zone: "monster_zone" }],
  });
  const result = evaluateSpecialWinConditions({ gameState, conditions });
  assert.equal(result.matched.status, "met");
  assert.equal(result.terminalVerdict.type, "special_win");
  assert.equal(result.terminalVerdict.startsChain, false);
});
