import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockerAnswer, evaluateRulingBlockers } from "../backend/rulingBlockers.mjs";

test("raw question and card text cannot manufacture a blocker verdict", () => {
  const result = evaluateRulingBlockers({
    question: "以不能成为效果对象的怪兽为对象发动效果时是否合法？",
    cards: [{ id: "fixture-card", effectText: "这张卡不会成为效果的对象。" }],
  });
  assert.equal(result.hasBlocker, false);
  assert.equal(result.primaryVerdict, null);
  assert.equal(result.proofStatus, "formal_proof_required");
  assert.equal(buildBlockerAnswer(result), null);
});

test("caller-authored verified flags and outcome booleans fail closed", () => {
  const result = evaluateRulingBlockers({
    activationCandidate: {
      id: "candidate-1",
      proofStatus: "verified",
      sourceCardId: "source-1",
      requiresTarget: true,
      targetCardId: "target-1",
      targetIsLegal: false,
      hasLegalEffectApplication: false,
      timingLegal: false,
    },
  });
  assert.equal(result.hasBlocker, false);
  assert.equal(result.proofStatus, "formal_proof_required");
  assert.equal(buildBlockerAnswer(result), null);
});

test("caller-authored chain and special-win state cannot create a hypothetical answer", () => {
  const result = evaluateRulingBlockers({
    activationCandidate: { id: "candidate-1", proofStatus: "verified", sourceCardId: "source-1", chainLinkLegal: false },
    gameState: { lp: { opponent: 1 } },
    chainLinks: [{ id: "c1", order: 1, effect: { type: "damage", player: "opponent", amount: 1 } }],
    specialWinConditions: [{ type: "special_win_condition", cardId: "winner", condition: {} }],
    hypotheticalAssumption: "caller supplied",
  });
  assert.equal(result.hypotheticalBranch, null);
  assert.deepEqual(result.resolutionSteps, []);
  assert.equal(result.hasBlocker, false);
});
