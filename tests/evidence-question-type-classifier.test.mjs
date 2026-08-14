import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEvidenceQuestionTypes,
  classifyEvidenceScenarioPremises,
  compareEvidenceScenarioPremises,
} from "../backend/evidenceQuestionTypeClassifier.mjs";

test("Japanese damage-step activation question detects activation and damage-step timing", () => {
  const result = classifyEvidenceQuestionTypes("ダメージステップでも発動できますか？");
  assert.ok(result.questionTypes.includes("activation_condition"));
  assert.ok(result.questionTypes.includes("damage_step_activation"));
  assert.ok(result.timing.includes("damage_step"));
  assert.equal(result.polarity, "can");
});

test("Japanese effect applicability phrase detects effect_applicability", () => {
  const result = classifyEvidenceQuestionTypes("この効果を適用できますか？");
  assert.ok(result.questionTypes.includes("effect_applicability"));
  assert.ok(result.actions.includes("apply"));
});

test("Japanese banish phrase detects temporary_banish", () => {
  const result = classifyEvidenceQuestionTypes("このモンスターを除外できますか？");
  assert.ok(result.questionTypes.includes("temporary_banish"));
  assert.ok(result.questionTypes.includes("banish_applicability"));
  assert.ok(result.actions.includes("banish"));
});

test("English damage-step activation phrase detects activation and timing", () => {
  const result = classifyEvidenceQuestionTypes("This effect can be activated during the Damage Step.");
  assert.ok(result.questionTypes.includes("activation_condition"));
  assert.ok(result.questionTypes.includes("damage_step_activation"));
  assert.ok(result.timing.includes("damage_step"));
  assert.equal(result.polarity, "can");
});

test("activation-location phrases detect activation_location", () => {
  const japanese = classifyEvidenceQuestionTypes("戦闘で破壊され墓地へ送られた場合には墓地で発動できます。除外状態で発動できます。");
  assert.ok(japanese.questionTypes.includes("activation_location"));
  assert.ok(japanese.zones.includes("graveyard"));
  assert.ok(japanese.zones.includes("banished"));

  const english = classifyEvidenceQuestionTypes("This effect can be activated in the Graveyard or while banished.");
  assert.ok(english.questionTypes.includes("activation_location"));
});

test("Chinese effect-applicability banish phrase detects temporary banish and applicability", () => {
  const result = classifyEvidenceQuestionTypes("可以适用这个效果把怪兽一时除外吗？");
  assert.ok(result.questionTypes.includes("temporary_banish"));
  assert.ok(result.questionTypes.includes("effect_applicability"));
  assert.ok(result.actions.includes("banish"));
  assert.ok(result.actions.includes("apply"));
});

test("Chinese resolution-outcome variants detect resolution handling", () => {
  for (const text of [
    "处理会怎样？",
    "处理结果会如何？",
    "结算会怎么进行？",
    "之后怎样处理？",
  ]) {
    const result = classifyEvidenceQuestionTypes(text);
    assert.ok(result.questionTypes.includes("resolution_handling"), text);
  }
});

test("negative activation phrases keep cannot polarity", () => {
  for (const text of ["発動できません", "cannot be activated", "不能发动"]) {
    const result = classifyEvidenceQuestionTypes(text);
    assert.ok(result.questionTypes.includes("activation_condition"));
    assert.equal(result.polarity, "cannot");
  }
});

test("battle outcome wording detects battle resolution without requiring a fixed phrase order", () => {
  const result = classifyEvidenceQuestionTypes(
    "分别用两只怪兽攻击里侧守备表示的怪兽，各自能否由战斗或怪兽效果破坏它？",
  );
  assert.ok(result.questionTypes.includes("battle_resolution"));
  assert.ok(result.questionTypes.includes("face_down_flip_before_damage_calculation"));
  assert.ok(result.actions.includes("attack"));
});

test("position changes during battle request an attack-continuation recheck", () => {
  const result = classifyEvidenceQuestionTypes(
    "攻击怪兽在伤害计算前变成守备表示后，这次攻击能否继续？",
  );
  assert.ok(result.questionTypes.includes("battle_resolution"));
  assert.ok(result.questionTypes.includes("attack_continuation_after_position_change"));
  assert.ok(result.timing.includes("before_damage_calculation"));
});

test("activated-effect negation remains distinct from continuous effects", () => {
  const result = classifyEvidenceQuestionTypes(
    "无效守备表示怪兽发动的效果，是否也会使其永续效果无效？",
  );
  assert.ok(result.questionTypes.includes("activated_vs_continuous_effect"));
});

test("battle-phase end timing is not misclassified as damage-step battle resolution", () => {
  for (const text of [
    "战斗阶段结束时可以发动这个效果吗？",
    "Can this effect be activated at the end of the Battle Phase?",
    "バトルフェイズ終了時にこの効果を発動できますか？",
  ]) {
    const result = classifyEvidenceQuestionTypes(text);
    assert.ok(result.questionTypes.includes("activation_condition"));
    assert.ok(!result.questionTypes.includes("battle_resolution"));
  }

  assert.ok(classifyEvidenceQuestionTypes("Will this attack continue after its position changes?")
    .questionTypes.includes("battle_resolution"));
});

test("applicability frames do not equate an actor prohibition with an empty eligible-operand set", () => {
  const prohibited = "双方玩家都不能特殊召唤怪兽，这张卡能否发动？";
  const emptyCandidates = "双方手牌和牌组均不存在可以特殊召唤的怪兽，这张卡能否发动？";

  for (const [query, evidence] of [[prohibited, emptyCandidates], [emptyCandidates, prohibited]]) {
    const comparison = compareEvidenceScenarioPremises(query, evidence);
    assert.equal(comparison.compatibility, "mismatch");
    assert.ok(comparison.conflicts.some((item) => item.reason === "premise_not_equivalent"));
  }
});

test("the same high-confidence actor prohibition is equivalent across languages", () => {
  const comparison = compareEvidenceScenarioPremises(
    "双方玩家都不能特殊召唤怪兽，这张卡能否发动？",
    "お互いにモンスターを特殊召喚できない状況の場合、このカードを発動できますか?",
  );
  assert.equal(comparison.compatibility, "compatible");
});

test("the same empty-operand premise remains equivalent across word orders", () => {
  const comparison = compareEvidenceScenarioPremises(
    "双方手牌和牌组均不存在可以特殊召唤的怪兽，这张卡能否发动？",
    "双方手牌和牌组中可以被特殊召唤的怪兽都不存在，能否发动这张卡？",
  );
  assert.equal(comparison.compatibility, "compatible");

  const withEffectSource = classifyEvidenceScenarioPremises(
    "双方均不存在能被该效果特殊召唤的怪兽，这张卡能否发动？",
  );
  assert.ok(withEffectSource.scenarioFacts.some((fact) => (
    fact.operation === "special_summon"
    && fact.dimension === "operand_availability"
    && fact.state === "absent"
  )));
});

test("relative clauses and unavailable zones are not mistaken for an actor prohibition or an empty operand set", () => {
  const relativeClause = classifyEvidenceScenarioPremises("自己不能特殊召唤的怪兽不存在。处理时如何进行？");
  assert.equal(relativeClause.scenarioFacts.some((fact) => fact.dimension === "actor_permission"), false);
  assert.equal(relativeClause.scenarioFacts.some((fact) => fact.dimension === "operand_availability"), false);

  const noZone = classifyEvidenceScenarioPremises("没有可以进行特殊召唤的空闲怪兽区域时，能否发动这张卡？");
  assert.equal(noZone.scenarioFacts.some((fact) => fact.dimension === "zone_capacity"), true);
  assert.equal(noZone.scenarioFacts.some((fact) => fact.dimension === "operand_availability"), false);
});

test("cost payability is a separate applicability dimension", () => {
  const frame = classifyEvidenceScenarioPremises("自己没有足够的LP支付发动效果的cost时，能否发动？");
  assert.ok(frame.scenarioFacts.some((fact) => (
    fact.dimension === "cost_payability" && fact.state === "unpayable"
  )));
});

test("requested targets use full query-to-evidence coverage", () => {
  const activation = "这张卡能否发动？";
  const resolution = "这个效果处理时如何进行？";
  assert.equal(compareEvidenceScenarioPremises(activation, resolution).compatibility, "mismatch");
  assert.equal(compareEvidenceScenarioPremises(resolution, activation).compatibility, "mismatch");

  const combined = "这张卡能否发动？如果发动，效果处理时如何进行？";
  assert.equal(compareEvidenceScenarioPremises(combined, activation).compatibility, "partial");
  assert.equal(compareEvidenceScenarioPremises(activation, combined).compatibility, "compatible");
});

test("activation mentioned as prior context is not treated as an activation-legality target", () => {
  for (const text of [
    "这个效果发动后，处理是否进行？",
    "不能发动的卡，其效果处理时如何进行？",
  ]) {
    const frame = classifyEvidenceScenarioPremises(text);
    assert.deepEqual(frame.requestedTargets.map((target) => target.stage), ["resolution_handling"]);
  }
});

test("missing query premises are partial and extra evidence restrictions are conditional", () => {
  const plain = "这张卡能否发动？";
  const emptyCandidates = "双方手牌和牌组均不存在可以特殊召唤的怪兽，这张卡能否发动？";
  const prohibited = "双方玩家都不能特殊召唤怪兽，这张卡能否发动？";
  assert.equal(compareEvidenceScenarioPremises(emptyCandidates, plain).compatibility, "partial");
  assert.equal(compareEvidenceScenarioPremises(plain, prohibited).compatibility, "conditional");
});

test("resolution wording used as timing context does not become a resolution target", () => {
  for (const [text, expectedOperation] of [
    ["效果处理后能否发动这张卡？", "activate"],
    ["连锁处理时是否可以发动这张卡？", "activate"],
    ["效果结算后能否特殊召唤怪兽？", "special_summon"],
  ]) {
    const frame = classifyEvidenceScenarioPremises(text);
    assert.equal(frame.requestedTargets.some((target) => target.stage === "resolution_handling"), false);
    assert.ok(frame.requestedTargets.some((target) => target.operation === expectedOperation));
  }
});

test("English activation and neither-player prohibition produce the same generic frame", () => {
  const english = "Neither player can Special Summon monsters. Can this card be activated?";
  const frame = classifyEvidenceScenarioPremises(english);
  assert.ok(frame.requestedTargets.some((target) => (
    target.stage === "activation_legality" && target.operation === "activate"
  )));
  assert.equal(frame.requestedTargets.some((target) => (
    target.stage === "action_legality" && target.operation === "special_summon"
  )), false);
  assert.ok(frame.scenarioFacts.some((fact) => (
    fact.operation === "special_summon"
    && fact.dimension === "actor_permission"
    && fact.scope === "both_players"
  )));
  assert.equal(compareEvidenceScenarioPremises(
    english,
    "お互いにモンスターを特殊召喚できない状況の場合、このカードを発動できますか?",
  ).compatibility, "compatible");
});

test("a fact can bind to the single operation asked in the following clause", () => {
  const noZone = classifyEvidenceScenarioPremises("没有空闲怪兽区域，能否特殊召唤怪兽？");
  assert.ok(noZone.scenarioFacts.some((fact) => (
    fact.operation === "special_summon" && fact.dimension === "zone_capacity"
  )));

  const noCost = classifyEvidenceScenarioPremises("cost无法支付时，能否发动这张卡？");
  assert.ok(noCost.scenarioFacts.some((fact) => (
    fact.operation === "activate" && fact.dimension === "cost_payability"
  )));
});

test("different source zones cannot become compatible merely because the requested action matches", () => {
  const comparison = compareEvidenceScenarioPremises(
    "这张卡在墓地存在时能否发动？",
    "这张卡从手牌存在时能否发动？",
  );
  assert.equal(comparison.compatibility, "mismatch");
  assert.ok(comparison.conflicts.some((item) => item.reason === "premise_not_equivalent"));
});

test("activation focus ignores operations and alternative zones quoted inside the responding effect", () => {
  const query = "场上存在一只已通常召唤的响应怪兽。我方从手牌发动一张陷阱，对方可以直接连锁发动响应怪兽的①效果吗？";
  const evidence = "相手が、手札から「<<6100>>」を発動した時、チェーンして自分は「<<6200>>」の『1:相手が手札・墓地・除外状態のカードの効果を発動した時に発動できる。その効果を無効にし破壊する』効果を発動できますか?";

  const queryFrame = classifyEvidenceScenarioPremises(query);
  const evidenceFrame = classifyEvidenceScenarioPremises(evidence);
  const comparison = compareEvidenceScenarioPremises(queryFrame, evidenceFrame);

  assert.deepEqual(queryFrame.requestedTargets.map(targetKeyForTest), [
    "activation_legality:activate",
  ]);
  assert.deepEqual(evidenceFrame.requestedTargets.map(targetKeyForTest), [
    "activation_legality:activate",
  ]);
  assert.deepEqual(queryFrame.scenarioFacts.map(factKeyForTest), [
    "question_context:zone_context:hand:unspecified",
  ]);
  assert.deepEqual(evidenceFrame.scenarioFacts.map(factKeyForTest), [
    "question_context:zone_context:hand:unspecified",
  ]);
  assert.equal(comparison.compatibility, "compatible");
});

test("orthogonal activation-source and timing context are missing premises, not contradictions", () => {
  const sourceOnly = "这张卡从手牌发动时，能否发动它的效果？";
  const sourceAndTiming = "这张卡从手牌发动时，在伤害步骤能否发动它的效果？";

  const missingTiming = compareEvidenceScenarioPremises(sourceAndTiming, sourceOnly);
  assert.equal(missingTiming.compatibility, "partial");
  assert.equal(missingTiming.conflicts.length, 0);

  const extraTiming = compareEvidenceScenarioPremises(sourceOnly, sourceAndTiming);
  assert.equal(extraTiming.compatibility, "conditional");
  assert.equal(extraTiming.conflicts.length, 0);
});

function targetKeyForTest(target) {
  return `${target.stage}:${target.operation}`;
}

function factKeyForTest(fact) {
  return `${fact.operation}:${fact.dimension}:${fact.state}:${fact.scope}`;
}
