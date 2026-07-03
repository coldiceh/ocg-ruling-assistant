import assert from "node:assert/strict";
import test from "node:test";
import { matchesRestriction } from "../backend/activeRestrictions.mjs";
import { validateActivation } from "../backend/activationLegalityGate.mjs";
import { evaluateCardIdentityGate } from "../backend/cardIdentityGate.mjs";
import { runSafeChainPipeline, simulateResolutionTrace } from "../backend/chainSafety.mjs";
import { resolveCardsForFastJudge } from "../backend/rulingContextPack.mjs";
import { buildExplanationModelInput, normalizeExplanationDraft } from "../backend/judgeAnswerModel.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

test("card identity ambiguity preserves candidates and blocks confirmation", () => {
  const result = evaluateCardIdentityGate({ unresolvedCards: [{ unresolvedCardName: "绚岚之达维", candidateCards: [
    { name: "绚岚之达维", cardId: "a", score: 0.61 },
    { name: "绚岚之达维亚", cardId: "b", score: 0.59 },
  ] }] });
  assert.equal(result.status, "needs_card_confirmation");
  assert.equal(result.uncertainCards[0].rawText, "绚岚之达维");
  assert.equal(result.uncertainCards[0].candidates.length, 2);
  assert.equal(result.uncertainCards[0].reason, "ambiguous_or_low_confidence");
});

test("a non-unique exact alias is not silently resolved", () => {
  const result = resolveCardsForFastJudge("发动『同名俗称』的效果", [
    { id: "1", name: "正式卡A", aliases: ["同名俗称"] },
    { id: "2", name: "正式卡B", aliases: ["同名俗称"] },
  ]);
  assert.equal(result.resolvedCards.length, 0);
  assert.equal(result.unresolvedCards[0].reason, "ambiguous_or_low_confidence");
  assert.equal(result.unresolvedCards[0].candidateCards.length, 2);
});

test("all first-stage activation blocker categories are structurally available", () => {
  const result = validateActivation({
    sourceCard: "未确认卡",
    cardIdentityStatus: "uncertain",
    effectNumberRequired: true,
    effectNumber: "unknown",
    requiresTarget: true,
    targetIsLegal: false,
    requiresLegalEffectApplication: true,
    hasLegalEffectApplication: false,
    timingLegal: false,
    attemptsToReturnCurrentlyResolvingCard: true,
    chainLinkLegal: false,
  });
  const codes = new Set(result.blockers.map((item) => item.code));
  for (const code of [
    "activation.card_identity_uncertain",
    "activation.effect_number_uncertain",
    "activation.no_legal_target",
    "activation.no_legal_effect_application",
    "activation.invalid_phase_or_timing",
    "activation.currently_resolving_card_cannot_be_returned_if_rule_applies",
    "activation.illegal_chain_link",
  ]) assert.ok(codes.has(code), code);
});

test("configured model contract is explanation-only and rejects decisive prose", () => {
  const input = buildExplanationModelInput({ question: "测试问题" });
  assert.deepEqual(input.schema, { explanationDraft: "string" });
  assert.equal("verdict" in input.schema, false);
  const result = normalizeExplanationDraft({ explanationDraft: "结论是这张卡可以发动。" });
  assert.equal(result.explanationDraft, "");
  assert.equal(result.rejectedDecisiveDraft, true);
});

test("active restriction registry generically blocks a matching activation", () => {
  const effect = { sourceCard: "测试融合怪兽", effectType: "monster_effect", activationLocation: "monster_zone", monsterSummonedFrom: "extra_deck", monsterType: "fusion" };
  const restriction = { sourceCard: "持续限制来源", duration: "this_turn", restrictionType: "cannot_activate", appliesTo: {
    effectType: "monster_effect", activationLocation: ["monster_zone", "graveyard"], monsterSummonedFrom: "extra_deck", monsterTypeNot: "synchro",
  } };
  assert.equal(matchesRestriction(effect, {}, restriction), true);
  const result = validateActivation(effect, { activeRestrictions: [restriction] });
  assert.equal(result.canActivate, false);
  assert.ok(result.blockers.some((item) => item.code === "activation.forbidden_by_active_restriction"));
});

test("illegal activation does not enter resolution", () => {
  const restriction = { sourceCard: "限制卡", restrictionType: "cannot_activate", appliesTo: { effectType: "monster_effect", activationLocation: "monster_zone" } };
  const result = runSafeChainPipeline({ gameState: { activeRestrictions: [restriction] }, chainLinks: [
    { id: "C1", order: 1, effect: { effectType: "spell_effect", activationLocation: "spell_trap_zone" } },
    { id: "C2", order: 2, effect: { effectType: "monster_effect", activationLocation: "monster_zone" } },
  ] });
  assert.equal(result.status, "illegal_question");
  assert.equal(result.verdict, "cannot_activate");
  assert.equal(result.canResolve, false);
  assert.equal(result.resolutionTrace.length, 0);
  assert.deepEqual(result.validatedLinks.map((item) => item.id), ["C1"]);
  assert.ok(result.ruleTrace.some((item) => item.chainLink === "C2" && item.result === "blocked"));
});

test("fast judge structured chain endpoint stops before model and resolution", async () => {
  let modelCalled = false;
  const answer = await answerRulingQuestionFast({
    question: "对方声称连锁发动怪兽效果。",
    snapshot: { cards: [], records: [] },
    gameState: { activeRestrictions: [{ sourceCard: "限制来源", restrictionType: "cannot_activate", appliesTo: { effectType: "monster_effect" } }] },
    chainLinks: [{ id: "C2", effect: { effectType: "monster_effect" } }],
    modelInvoker: async () => { modelCalled = true; return null; },
  });
  assert.equal(answer.status, "illegal_question");
  assert.equal(answer.verdict, "cannot_activate");
  assert.equal(answer.resolutionSteps.length, 0);
  assert.ok(answer.blockers.some((item) => item.code === "activation.forbidden_by_active_restriction"));
  assert.ok(answer.ruleTrace.some((item) => item.step === "validate_activation" && item.result === "blocked"));
  assert.equal(modelCalled, false);
});

test("currently resolving normal trap is rejected by the activation gate", () => {
  const result = validateActivation({ sourceCard: "返回效果", requiresLegalEffectApplication: true, hasLegalEffectApplication: false, attemptsToReturnCurrentlyResolvingCard: true, returnTarget: "发动中的通常陷阱" });
  assert.equal(result.canActivate, false);
  assert.ok(result.blockers.some((item) => item.code === "activation.currently_resolving_card_cannot_be_returned_if_rule_applies"));
  assert.ok(result.blockers.some((item) => item.code === "activation.no_legal_effect_application"));
});

test("target loss can produce partial resolution trace", () => {
  const result = simulateResolutionTrace({ chainLinks: [{ id: "C1", effect: { targetAvailableAtResolution: false, nonTargetOperations: ["draw_one"] } }] });
  assert.ok(result.ruleTrace.some((item) => item.event === "target_lost" && item.result === "partial_resolution"));
  assert.ok(result.ruleTrace.some((item) => item.event === "effect_resolution" && item.result === "resolved"));
});

test("source moved before resolution is recorded without inventing a verdict", () => {
  const result = simulateResolutionTrace({ chainLinks: [{ id: "C2", effect: { sourceAvailableAtResolution: false, requiresSourceAtResolution: true } }] });
  assert.deepEqual(result.ruleTrace, [{ step: "resolve_chain_link", chainLink: "C2", event: "source_unavailable", result: "cannot_apply" }]);
});
