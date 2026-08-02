import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";
import { resolveEffectChain } from "../backend/effectResolutionEngine.mjs";
import { analyzeDuelStateTransition } from "../backend/duelStateReasoner.mjs";

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

const realSourceCard = {
  id: "23171",
  name: "破械式鬼シュマ",
  cardType: "monster",
  effectText: "このカード名の①②の効果はそれぞれ１ターンに１度しか使用できない。\n①：このカードが召喚した場合に発動できる。「破械式鬼シュマ」を除く、レベル４以下の「破械」モンスター１体をデッキから特殊召喚する。その後、自分フィールドのカード１枚を破壊する。このターン、自分は悪魔族モンスターしか特殊召喚できない。\n②：フィールドのこのカードが戦闘で破壊された場合に発動できる。手札からモンスター１体を特殊召喚する。",
};

const effectNegatorCard = {
  id: "12950",
  name: "灰流丽",
  cardType: "monster",
  effectText: "此卡名的效果1回合仅可使用1次。①：包含从牌组将怪兽特殊召唤的效果发动时，从手牌将此卡舍弃可以发动。将该效果无效。",
};

test("state reasoner answers the real negated-use/restriction question from normalized semantics", () => {
  const query = "「破械式鬼シュマ」召唤后发动①效果，对方连锁发动「灰流丽」将其效果无效。这个回合还能再次发动「破械式鬼シュマ」①吗？『这个回合自己只能特殊召唤恶魔族怪兽』还会适用吗？";
  const result = analyzeDuelStateTransition({
    userQuery: query,
    resolvedCards: [realSourceCard, effectNegatorCard],
    cardTexts: [realSourceCard, effectNegatorCard],
  });
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /不能再次发动/u);
  assert.match(result.shortAnswer, /限制都不进行、也不适用/u);
  assert.equal(result.program.negationKind, "effect");
  assert.equal(result.program.simulation.finalGameState.effectUsageLedger.length, 1);
  assert.equal(result.program.simulation.finalGameState.turnRestrictions.length, 0);
});

test("state reasoner reaches the same result after every card name is fictionalized", () => {
  const renamedSource = { ...realSourceCard, id: "fiction-100", name: "星海旅人 阿尔法" };
  const renamedNegator = { ...effectNegatorCard, id: "fiction-200", name: "暮色拦截者" };
  const query = "「星海旅人 阿尔法」召唤后发动①效果，对方连锁发动「暮色拦截者」将其效果无效。这个回合还能再次发动「星海旅人 阿尔法」①吗？『这个回合自己只能特殊召唤恶魔族怪兽』还会适用吗？";
  const result = analyzeDuelStateTransition({
    userQuery: query,
    resolvedCards: [renamedSource, renamedNegator],
    cardTexts: [renamedSource, renamedNegator],
  });
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /不能再次发动/u);
  assert.match(result.shortAnswer, /不适用/u);
});

test("restriction applicability accepts the synonymous predicate 'still constrains' after renaming", () => {
  const renamedSource = { ...realSourceCard, id: "constraint-alpha", name: "星潮领航员" };
  const renamedNegator = { ...effectNegatorCard, id: "constraint-beta", name: "暮光拦截者" };
  const result = analyzeDuelStateTransition({
    userQuery: "「星潮领航员」①的发动被连锁的「暮光拦截者」无效。请判断本回合能否再发动一次①；原处理会不会做；‘本回合只能特殊召唤恶魔族’是否还约束我方？",
    resolvedCards: [renamedSource, renamedNegator],
    cardTexts: [renamedSource, renamedNegator],
  });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /不能再次发动/u);
  assert.match(result.shortAnswer, /限制.*不适用/u);
});

test("state reasoner fails closed when the responding effect does not establish what was negated", () => {
  const unknownResponder = {
    ...effectNegatorCard,
    id: "fiction-unknown",
    name: "未知响应者",
    effectText: "①：对方的怪兽效果发动时，从手牌将此卡舍弃可以发动。进行尚未范式化的处理。",
  };
  const query = "「破械式鬼シュマ」召唤后发动①效果，对方连锁发动「未知响应者」。这个回合还能再次发动「破械式鬼シュマ」①吗？『这个回合自己只能特殊召唤恶魔族怪兽』还会适用吗？";
  const result = analyzeDuelStateTransition({
    userQuery: query,
    resolvedCards: [realSourceCard, unknownResponder],
    cardTexts: [realSourceCard, unknownResponder],
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "chain_negation_kind_not_compiled");
});
