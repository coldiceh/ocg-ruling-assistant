import assert from "node:assert/strict";
import test from "node:test";
import { validateActivation } from "../backend/activationLegalityGate.mjs";
import { resolvePrimitiveSequence } from "../backend/effectResolutionEngine.mjs";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";
import { runSafeChainPipeline } from "../backend/chainSafety.mjs";
import {
  createRestrictionTemplateRegistry,
  generateActiveRestriction,
} from "../backend/restrictionTemplates.mjs";
import { applyProgramVerdictPolicy } from "../backend/verdictPolicy.mjs";
import { buildProgramAnswerModel } from "../backend/judgeAnswerModel.mjs";
import { normalizeFormalRulingQuery, validateFormalRulingQuery } from "../backend/formalQuery.mjs";
import { answerRulingQuestionFast } from "../backend/fastJudgeEngine.mjs";

test("target lost skips only the target primitive and the non-target primitive continues", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { id: "discard", player: "self", amount: 1 }),
    createEffectPrimitive("place_target_as_continuous_trap", { id: "place", targetId: "target", targetExpectedZone: "monster_zone" }),
  ], {
    cards: [{ cardId: "target", name: "对象", zone: "graveyard" }],
    hands: { self: [{ cardId: "hand-1", name: "手卡" }] },
    graveyards: { self: [] },
    resolutionContext: { targets: [{ cardId: "target", expectedZone: "monster_zone" }] },
  });
  assert.equal(result.resolutionStatus, "partially_resolved");
  assert.equal(result.steps[0].status, "applied");
  assert.equal(result.steps[1].status, "skipped");
  assert.equal(result.gameState.hands.self.length, 0);
  assert.ok(result.ruleTrace.some((item) => item.event === "non_target_part_continued"));
  assert.ok(result.ruleTrace.some((item) => item.event === "target_lost_at_resolution"));
  assert.ok(result.ruleTrace.some((item) => item.event === "target_part_skipped"));
});

test("target lost causes a THEN-connected primitive to be skipped", () => {
  const result = resolvePrimitiveSequence([
    { id: "destroy", primitive: createEffectPrimitive("destroy_target", { targetId: "target", targetExpectedZone: "monster_zone" }) },
    { id: "draw", connector: "THEN", primitive: createEffectPrimitive("draw_cards", { player: "self", amount: 1 }) },
  ], {
    cards: [{ cardId: "target", zone: "graveyard" }],
    decks: { self: [{ cardId: "deck-1" }] },
    hands: { self: [] },
    resolutionContext: { targets: [{ cardId: "target", expectedZone: "monster_zone" }] },
  });
  assert.equal(result.resolutionStatus, "failed");
  assert.equal(result.steps[0].status, "skipped");
  assert.equal(result.steps[1].status, "skipped");
  assert.match(result.steps[1].reason, /requires_previous_success/u);
  assert.equal(result.gameState.hands.self.length, 0);
});

test("source moved allows source-independent processing but skips source-dependent processing", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { id: "independent", player: "self", amount: 1 }),
    createEffectPrimitive("special_summon_source", { id: "summon", sourceCardId: "source", sourceExpectedZone: "graveyard" }),
  ], {
    cards: [{ cardId: "source", name: "来源", zone: "banished" }],
    hands: { self: [{ cardId: "hand-1" }] },
    graveyards: { self: [] },
    resolutionContext: { source: { cardId: "source", expectedZone: "graveyard" } },
  });
  assert.equal(result.resolutionStatus, "partially_resolved");
  assert.equal(result.steps[0].status, "applied");
  assert.equal(result.steps[1].status, "skipped");
  assert.ok(result.ruleTrace.some((item) => item.event === "source_independent_part_continued"));
  assert.ok(result.ruleTrace.some((item) => item.event === "source_dependent_part_skipped"));
});

test("source-dependent summon fails when the source left its expected zone", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("special_summon_source", { sourceCardId: "source", sourceExpectedZone: "graveyard" }),
  ], {
    cards: [{ cardId: "source", zone: "banished" }],
    resolutionContext: { source: { cardId: "source", expectedZone: "graveyard" } },
  });
  assert.equal(result.resolutionStatus, "failed");
  assert.ok(result.ruleTrace.some((item) => item.event === "source_unavailable_at_resolution"));
});

test("restriction template generation blocks activation before resolution", () => {
  const registry = createRestrictionTemplateRegistry([{
    cardId: "restrictor-1",
    effectNo: "1",
    sourceCard: "限制来源",
    createsRestriction: {
      duration: "this_turn",
      restrictionType: "cannot_activate",
      appliesTo: { effectType: "monster_effect", activationLocation: "monster_zone" },
    },
  }]);
  const restriction = generateActiveRestriction({ cardId: "restrictor-1", effectNo: "1" }, registry);
  const candidate = { effectType: "monster_effect", activationLocation: "monster_zone" };
  const activation = validateActivation(candidate, { activeRestrictions: [restriction] });
  assert.equal(activation.canActivate, false);
  assert.ok(activation.blockers.some((item) => item.code === "activation.forbidden_by_active_restriction"));
  const chain = runSafeChainPipeline({
    gameState: { activeRestrictions: [restriction] },
    chainLinks: [{ id: "C2", effect: candidate, primitiveSequence: [createEffectPrimitive("apply_damage", { player: "opponent", amount: 500 })] }],
  });
  assert.equal(chain.status, "illegal_question");
  assert.equal(chain.resolutionTrace.length, 0);
});

test("LLM explanation cannot override a primitive result", () => {
  const program = {
    status: "partially_resolved",
    verdict: "partially_resolved",
    evidenceGrade: "rule_derived",
    ruleTrace: [{ step: "resolve_primitive", event: "target_part_skipped", result: "skipped" }],
    warnings: [],
    shortAnswer: "对象部分不处理，独立部分继续。",
  };
  const protectedResult = applyProgramVerdictPolicy(program, "全部处理成功，所有 primitive fully resolved。");
  assert.equal(protectedResult.verdict, "partially_resolved");
  assert.equal(protectedResult.explanationDraft, "");
  assert.ok(protectedResult.warnings.includes("model_explanation_conflict_rejected"));
  const answerModel = buildProgramAnswerModel(protectedResult);
  assert.equal(answerModel.conclusion, program.shortAnswer);
  assert.equal(answerModel.evidenceGrade, "rule_derived");
  assert.match(answerModel.text, /^结论：/u);
  assert.match(answerModel.text, /依据等级：/u);
  assert.match(answerModel.text, /关键阻断 \/ 关键处理：/u);
  assert.match(answerModel.text, /处理过程：/u);
  assert.match(answerModel.text, /注意：/u);
});

test("unknown primitive state returns insufficient instead of guessing", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("draw_cards", { player: "self", amount: 1 }),
  ], {});
  assert.equal(result.resolutionStatus, "insufficient");
  assert.equal(result.steps[0].reason, "deck_or_hand_contents_unknown");
});

test("formal query preserves structured pipeline fields and rejects verdicts", () => {
  const query = normalizeFormalRulingQuery({
    originalText: "测试卡的效果如何处理？",
    cards: [{ name: "测试卡", role: "question_card", effectNo: "1", zone: "graveyard" }],
    scenario: { rawContext: "", chainState: "during_chain" },
    questionType: "resolution_handling",
    cardIdentities: [{ rawText: "测试卡", cardId: "1", status: "resolved", confidence: "high" }],
    chainLinks: [{
      id: "C1",
      sourceCardId: "1",
      effectNo: "1",
      sourceExpectedZone: "graveyard",
      targets: [{ cardId: "2", expectedZone: "monster_zone" }],
      primitiveSequence: [{ type: "destroy_target", targetId: "2" }],
    }],
    activeRestrictions: [],
    subQuestions: [{ id: "q1", type: "resolution_handling", card: "测试卡", askedResult: "resolution_result", sourceText: "测试卡的效果如何处理？" }],
  });
  assert.equal(query.questionType, "resolution_handling");
  assert.equal(query.chainLinks[0].primitiveSequence[0].primitive.type, "destroy_target");
  assert.equal(validateFormalRulingQuery(query).valid, true);
  assert.equal(validateFormalRulingQuery({ ...query, verdict: "resolved" }).valid, false);
});

test("fast judge returns the program primitive result before model generation", async () => {
  let modelCalled = false;
  const answer = await answerRulingQuestionFast({
    question: "处理结构化连锁。",
    snapshot: { cards: [], records: [] },
    gameState: { lp: { opponent: 1000 } },
    chainLinks: [{
      id: "C1",
      effect: { effectType: "spell_effect" },
      primitiveSequence: [createEffectPrimitive("apply_damage", { player: "opponent", amount: 500 })],
    }],
    modelInvoker: async () => { modelCalled = true; return null; },
  });
  assert.equal(answer.status, "resolved");
  assert.equal(answer.verdict, "resolved");
  assert.equal(answer.finalGameState.lp.opponent, 500);
  assert.equal(answer.answerModel.evidenceGrade, "rule_derived");
  assert.match(answer.answerModel.text, /结论：/u);
  assert.equal(modelCalled, false);
});
