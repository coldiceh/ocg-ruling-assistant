import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeEffectRewriteAttribution,
  createDestructionEventFromResolution,
  createPendingResolutionFrame,
  evaluateDestroyedOtherThanExactEffect,
  rewritePendingResolution,
} from "../backend/effectRewriteAttribution.mjs";
import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";

function cards(names = { source: "痛觉化身", rewriter: "演算莲" }) {
  return [{
    id: "source-card",
    name: names.source,
    effectText: `③：结束阶段发动。自己场上的这张卡破坏。\n④：这张卡被③的效果以外破坏的场合才能发动。从卡组把1只怪兽特殊召唤。`,
    evidenceId: "source-text",
  }, {
    id: "rewriter-card",
    name: names.rewriter,
    effectText: `②：对方把怪兽的效果发动时，解放这张卡才能发动。把那个效果的处理改写为『场上1只怪兽破坏』。`,
    evidenceId: "rewriter-text",
  }];
}

function query(names = { source: "痛觉化身", rewriter: "演算莲" }) {
  return `对方结束阶段发动「${names.source}」的③效果，我方连锁发动「${names.rewriter}」的②效果，把那个效果处理改写为『场上1只怪兽破坏』。对方选择自己的「${names.source}」破坏。这算被自身③效果破坏吗，可以发动④效果吗？`;
}

test("rewrite revisions the effective program without mutating activated identity", () => {
  const original = createPendingResolutionFrame({
    sourceCardDefinitionId: "a",
    sourceCardInstanceId: "a-1",
    activatedEffectId: "a:3",
    activatedEffectNo: "3",
    operations: [{ type: "destroy_self" }],
  });
  const rewritten = rewritePendingResolution(original, {
    rewriterCardDefinitionId: "b",
    rewriterCardInstanceId: "b-1",
    rewriterEffectId: "b:2",
    rewriterEffectNo: "2",
    replacementOperations: [{ type: "destroy", target: "chosen" }],
  });
  assert.equal(rewritten.activatedEffect.id, "a:3");
  assert.equal(rewritten.cardSource.definitionId, "a");
  assert.equal(rewritten.effectiveProgram.revision, 1);
  assert.notEqual(rewritten.effectiveProgram.id, original.activatedProgramId);
  assert.equal(rewritten.rewrittenBy[0].effectId, "b:2");
});

test("destroyed by a rewritten program is not destruction by the exact original program", () => {
  const original = createPendingResolutionFrame({
    sourceCardDefinitionId: "a", sourceCardInstanceId: "a-1", activatedEffectId: "a:3", activatedEffectNo: "3",
  });
  const rewritten = rewritePendingResolution(original, {
    rewriterCardDefinitionId: "b", rewriterCardInstanceId: "b-1", rewriterEffectId: "b:2", rewriterEffectNo: "2",
    replacementOperations: [{ type: "destroy" }],
  });
  const event = createDestructionEventFromResolution(rewritten, { targetCardDefinitionId: "a", targetCardInstanceId: "a-1" });
  const check = evaluateDestroyedOtherThanExactEffect(event, { excludedActivatedEffectId: "a:3", excludedProgramId: original.activatedProgramId });
  assert.equal(check.triggerConditionSatisfied, true);
  assert.equal(event.rewrittenBy[0].effectId, "b:2");
});

test("unrewritten counterexample remains the exact original program", () => {
  const original = createPendingResolutionFrame({
    sourceCardDefinitionId: "a", sourceCardInstanceId: "a-1", activatedEffectId: "a:3", activatedEffectNo: "3",
  });
  const event = createDestructionEventFromResolution(original, { targetCardDefinitionId: "a", targetCardInstanceId: "a-1" });
  const check = evaluateDestroyedOtherThanExactEffect(event, { excludedActivatedEffectId: "a:3", excludedProgramId: original.activatedProgramId });
  assert.equal(check.isExactExcludedProgram, true);
  assert.equal(check.triggerConditionSatisfied, false);
});

test("real-shaped query resolves through analyzeEffectStateTransition", () => {
  const result = analyzeEffectStateTransition({ userQuery: query(), resolvedCards: cards(), cardTexts: cards() });
  assert.equal(result.status, "resolved");
  assert.equal(result.complete, true);
  assert.equal(result.authoritative, true);
  assert.match(result.shortAnswer, /不算.*自身的③.*可以发动④/u);
  assert.equal(result.program.rewrittenFrame.effectiveProgram.revision, 1);
});

test("full card renaming does not change the ruling", () => {
  const names = { source: "终末花兽", rewriter: "协议藤蔓" };
  const result = analyzeEffectRewriteAttribution({ userQuery: query(names), resolvedCards: cards(names), cardTexts: cards(names) });
  assert.equal(result.status, "resolved");
  assert.match(result.shortAnswer, /不算.*可以发动④/u);
});

test("postposed effect numbers, rewrite synonyms, and bound pronouns preserve attribution", () => {
  const names = { source: "终末花兽", rewriter: "协议藤蔓" };
  const paraphrase = `结束阶段「${names.source}」③发动，随后「${names.rewriter}」②连锁，把③的处理替换成破坏场上一只怪兽。若处理时选中并破坏发动③的那只「${names.source}」，这次破坏是否仍属于它原来的③？它的④能否发动？`;
  const result = analyzeEffectRewriteAttribution({
    userQuery: paraphrase,
    resolvedCards: cards(names),
    cardTexts: cards(names),
  });
  assert.equal(result.status, "resolved");
  assert.match(result.shortAnswer, /^不算被.*可以发动④/u);
  assert.equal(result.program.rewrittenFrame.effectiveProgram.revision, 1);
});

test("rewrite-like wording without a bound destroyed source instance fails closed", () => {
  const names = { source: "终末花兽", rewriter: "协议藤蔓" };
  const vague = `结束阶段「${names.source}」③发动，随后「${names.rewriter}」②连锁，把③的处理替换成破坏场上一只怪兽。处理时有一只怪兽被破坏，它的④能否发动？`;
  const result = analyzeEffectRewriteAttribution({
    userQuery: vague,
    resolvedCards: cards(names),
    cardTexts: cards(names),
  });
  assert.equal(result.status, "insufficient");
  assert.equal(result.complete, false);
  assert.equal(result.reason, "destroyed_target_instance_not_bound");
});

test("card-text evidence ids do not become duplicate card-definition identities", () => {
  const definitions = cards();
  const textEvidence = definitions.map((card) => ({
    id: `card-text-${card.id}`,
    cardIds: [card.id],
    cardNames: [card.name],
    name: card.name,
    effectText: card.effectText,
    evidenceId: `card-text-${card.id}`,
  }));
  const result = analyzeEffectRewriteAttribution({
    userQuery: query(),
    resolvedCards: definitions,
    cardTexts: textEvidence,
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.evidenceIds.sort(), ["card-text-rewriter-card", "card-text-source-card"]);
});

test("missing verified rewriter semantics fails closed", () => {
  const incomplete = cards();
  incomplete[1] = { ...incomplete[1], effectText: "②：对方把怪兽效果发动时才能发动。抽1张。" };
  const result = analyzeEffectRewriteAttribution({ userQuery: query(), resolvedCards: incomplete, cardTexts: incomplete });
  assert.equal(result.status, "insufficient");
  assert.equal(result.complete, false);
  assert.equal(result.reason, "verified_replacement_program_missing");
});

test("missing destroyed target binding fails closed", () => {
  const vague = query().replace("对方选择自己的「痛觉化身」破坏。", "之后有1只怪兽被破坏。");
  const result = analyzeEffectRewriteAttribution({ userQuery: vague, resolvedCards: cards(), cardTexts: cards() });
  assert.equal(result.status, "insufficient");
  assert.equal(result.reason, "destroyed_target_instance_not_bound");
});
