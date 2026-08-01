import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDuelStateTransition,
  compileResolvedCardPrograms,
} from "../backend/duelStateReasoner.mjs";
import { deriveRulePrimitiveResults } from "../backend/rulePrimitives.mjs";

function primitiveProjection(question) {
  return deriveRulePrimitiveResults({
    originalQuestion: question,
    cardTexts: [{
      id: "anonymous-atk-text",
      title: "匿名数值效果",
      conclusion: "失去生命值，那之后，攻击力变为当前攻击力的两倍。",
    }],
  }).map(({ primitive, result }) => ({
    id: primitive.id,
    concepts: result.concepts,
    verdictHint: result.verdictHint,
    shortAnswer: result.shortAnswer,
    steps: result.steps,
  }));
}

test("a claimed numeric answer in the question is not copied into rule-derived output", () => {
  const first = primitiveProjection("为什么最终攻击力应为9876而不是1234？");
  const second = primitiveProjection("为什么最终攻击力应为5555而不是2222？");

  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /9876|1234|5555|2222/u);
  assert.doesNotMatch(serialized, /final_atk_/u);
});

test("legacy pattern semantics are retained only as diagnostics and cannot compile authoritatively", () => {
  const [program] = compileResolvedCardPrograms([{
    id: "anonymous-legacy-operation",
    name: "匿名旧式处理",
    cardType: "spell",
    effectText: "将场上的怪兽作为融合素材进行融合召唤。",
  }]);
  const effect = program.activatedEffects
    .find((candidate) => candidate.semanticSources?.fusionSummon === "legacy_pattern");

  assert.ok(effect);
  assert.equal(effect.compileIncompleteReason, "legacy_pattern_semantics_not_authoritative");

  const result = analyzeDuelStateTransition({
    userQuery: "可以发动「匿名旧式处理」并完成处理吗？",
    resolvedCards: [{
      id: "anonymous-legacy-operation",
      name: "匿名旧式处理",
      cardType: "spell",
      effectText: "将场上的怪兽作为融合素材进行融合召唤。",
    }],
  });
  assert.equal(result.complete, false);
  assert.notEqual(result.authoritative, true);
});

function symbolicInput(claim) {
  return {
    userQuery: `对方场上存在「匿名去向载体」。自己可以发动「匿名融合操作」吗？发动时丢弃手牌，并将双方场上的怪兽作为素材。${claim}`,
    resolvedCards: [{
      id: "anonymous-fusion-operation",
      name: "匿名融合操作",
      cardType: "spell",
      effectText: "①：舍弃1张手牌可以发动。以自己・对手场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
    }, {
      id: "anonymous-destination-carrier",
      name: "匿名去向载体",
      cardType: "monster",
      effectText: "①：只要此卡存在于怪兽区域，对方的卡送去墓地的场合，不去墓地而除外。",
    }],
  };
}

test("anonymous equivalent claims cannot turn a fabricated material branch into a complete verdict", () => {
  const claimedYes = analyzeDuelStateTransition(symbolicInput("用户声称结论标记为甲。"));
  const claimedNo = analyzeDuelStateTransition(symbolicInput("用户声称结论标记为乙。"));

  for (const result of [claimedYes, claimedNo]) {
    assert.equal(result.status, "unknown");
    assert.equal(result.complete, false);
    assert.equal(result.authoritative, false);
    assert.equal(result.conditional, true);
    assert.ok(result.authorityReasons.includes("synthetic_entity_or_material"));
  }
  assert.deepEqual(claimedYes.authorityReasons, claimedNo.authorityReasons);
  assert.doesNotMatch(claimedYes.shortAnswer, /结论标记为甲/u);
  assert.doesNotMatch(claimedNo.shortAnswer, /结论标记为乙/u);
});
