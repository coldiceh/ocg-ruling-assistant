import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";
import { resolveEffectChain } from "../backend/effectResolutionEngine.mjs";

const source = {
  instanceId: "source#1",
  cardId: "fictional-source",
  definitionId: "fictional-source",
  name: "虚构发动源",
  controller: "self",
  owner: "self",
  zone: "monster_zone",
  faceUp: true,
  position: "attack",
};

const usePolicy = {
  id: "fictional-source:effect:1:once-per-turn-use",
  scopeKey: "fictional-source:effect:1",
  period: "turn",
  limit: 1,
  verb: "use",
  consumeAt: "accepted_activation",
};

function restrictionStep() {
  return {
    id: "turn-lock",
    connector: "INDEPENDENT",
    primitive: createEffectPrimitive("create_turn_restriction", {
      sourceEffectId: "fictional-source:effect:1",
      affectedPlayer: "effect_controller",
      duration: "turn",
      expiresAt: "end_of_turn",
      restriction: { type: "special_summon_filter", allowed: { race: "恶魔族" } },
    }),
  };
}

function link(overrides = {}) {
  return {
    id: "C1",
    order: 1,
    sourceCardId: source.instanceId,
    sourceInstanceId: source.instanceId,
    sourceDefinitionId: source.definitionId,
    sourceCardName: source.name,
    sourceExpectedZone: "monster_zone",
    usagePolicies: [usePolicy],
    sequence: [restrictionStep()],
    ...overrides,
  };
}

test("normalizer emits usagePolicy and turn restriction before generic Special Summon", () => {
  const normalized = normalizeCardText({
    id: "real-shape",
    effectText: "这个卡名的①效果1回合只能使用1次。①：这张卡召唤成功的场合才能发动。从卡组把1只怪兽特殊召唤，然后选场上1张卡破坏。这个回合，自己不是恶魔族怪兽不能特殊召唤。",
  });
  const effect = normalized.effects.find((item) => item.effectNo === "1");
  assert.equal(effect.usagePolicies[0].verb, "use");
  assert.equal(effect.usagePolicies[0].consumeAt, "accepted_activation");
  assert.deepEqual(effect.resolution.map((step) => step.operation.type), [
    "special_summon",
    "destroy",
    "create_turn_restriction",
  ]);
  assert.equal(effect.resolution[2].operation.restriction.allowed.race, "恶魔族");

  const activationLimited = normalizeCardText({
    id: "activation-limited",
    effectText: "这个卡名的①效果1回合只能发动1次。①：对方发动卡的效果时才能发动。那个发动无效。",
  });
  const activationPolicy = activationLimited.effects.find((item) => item.effectNo === "1").usagePolicies[0];
  assert.equal(activationPolicy.verb, "activate");
  assert.equal(activationPolicy.consumeAt, "activation_established");
});

test("the same semantics normalize after all names and races are fictionalized", () => {
  const normalized = normalizeCardText({
    id: "renamed-card",
    effectText: "このカード名の①の効果は１ターンに１度しか使用できない。①：このカードが召喚した場合に発動できる。デッキからモンスター１体を特殊召喚し、その後、フィールドのカード１枚を破壊する。このターン、自分は星砂族モンスターしか特殊召喚できない。",
  });
  const effect = normalized.effects.find((item) => item.effectNo === "1");
  assert.equal(effect.usagePolicies[0].scopeKey, "renamed-card:effect:1");
  assert.equal(effect.resolution.at(-1).operation.type, "create_turn_restriction");
  assert.equal(effect.resolution.at(-1).operation.restriction.allowed.race, "星砂族");
});

test("normal resolution creates the turn restriction and consumes use count", () => {
  const result = resolveEffectChain({ gameState: { cards: [source] }, chainLinks: [link()] });
  assert.equal(result.complete, true);
  assert.equal(result.linkResults[0].status, "resolved");
  assert.equal(result.finalGameState.effectUsageLedger.length, 1);
  assert.equal(result.finalGameState.turnRestrictions.length, 1);
  assert.equal(result.finalGameState.turnRestrictions[0].restriction.allowed.race, "恶魔族");
});

test("effect negation consumes both usage verbs but creates no resolution restriction", () => {
  for (const policy of [
    usePolicy,
    { ...usePolicy, verb: "activate", consumeAt: "activation_established" },
  ]) {
    const result = resolveEffectChain({
      gameState: { cards: [source] },
      chainLinks: [link({ usagePolicies: [policy], effectNegated: true, negatedBy: "negator#1" })],
    });
    assert.equal(result.complete, true);
    assert.equal(result.linkResults[0].status, "negated");
    assert.equal(result.finalGameState.effectUsageLedger.length, 1);
    assert.equal(result.finalGameState.turnRestrictions.length, 0);
  }
});

test("activation negation distinguishes 使用 from 发动", () => {
  const used = resolveEffectChain({
    gameState: { cards: [source] },
    chainLinks: [link({ activationNegated: true, negatedBy: "negator#1" })],
  });
  assert.equal(used.linkResults[0].status, "activation_negated");
  assert.equal(used.finalGameState.effectUsageLedger.length, 1);
  assert.equal(used.finalGameState.turnRestrictions.length, 0);

  const activated = resolveEffectChain({
    gameState: { cards: [source] },
    chainLinks: [link({
      activationNegated: true,
      negatedBy: "negator#1",
      usagePolicies: [{ ...usePolicy, verb: "activate", consumeAt: "activation_established" }],
    })],
  });
  assert.equal(activated.linkResults[0].status, "activation_negated");
  assert.equal(activated.finalGameState.effectUsageLedger.length, 0);
  assert.equal(activated.finalGameState.turnRestrictions.length, 0);
});

test("a consumed usage policy blocks another activation in the same turn", () => {
  const first = resolveEffectChain({ gameState: { cards: [source] }, chainLinks: [link({ effectNegated: true })] });
  const second = resolveEffectChain({ gameState: first.finalGameState, chainLinks: [link({ id: "C3", order: 3 })] });
  assert.equal(second.complete, false);
  assert.equal(second.incompleteReason, "effect_usage_limit_reached");
});
