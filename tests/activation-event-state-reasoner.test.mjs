import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVATION_RESPONSE_PREDICATES,
  createEffectActivationEvent,
  evaluateActivationResponsePredicate,
} from "../backend/spellTrapActivationProcedure.mjs";
import {
  analyzeActivationEventStateTransition,
  parseActivationResponsePredicate,
  parseFromHandCardActivationPermission,
} from "../backend/activationEventStateReasoner.mjs";

function fixture(prefix = "测试", { includeFieldEmpty = true } = {}) {
  const names = {
    trap: `${prefix}均衡陷阱`,
    responder: `${prefix}区域监察者`,
  };
  const emptyFact = includeFieldEmpty ? "自己场上没有卡，" : "";
  return {
    names,
    userQuery: `对方场上存在通常召唤的「${names.responder}」。${emptyFact}自己在战斗阶段结束时从手牌发动「${names.trap}」。对方可以直接连锁发动「${names.responder}」的①效果吗？`,
    resolvedCards: [
      { id: `${prefix}-trap`, name: names.trap, aliases: [names.trap], cardType: "trap" },
      { id: `${prefix}-responder`, name: names.responder, aliases: [names.responder], cardType: "monster" },
    ],
    cardTexts: [
      {
        id: `${prefix}-trap-text`,
        cards: [names.trap],
        cardType: "trap",
        text: `自己场上不存在卡的情况下，此卡也可从手牌发动。①：战斗阶段结束时可以发动。进行某个处理。`,
      },
      {
        id: `${prefix}-responder-text`,
        cards: [names.responder],
        cardType: "monster",
        text: "①：此卡通常召唤的情况下，对方发动手牌・墓地・除外状态的卡的效果时可以发动。那个效果无效并破坏。",
      },
    ],
  };
}

test("card text compiles hand-activation permission and zone-scoped response predicate", () => {
  const input = fixture();
  const permission = parseFromHandCardActivationPermission(input.cardTexts[0].text);
  const predicate = parseActivationResponsePredicate(input.cardTexts[1].text);
  assert.equal(permission.type, "spell_trap_card_activation_permission");
  assert.equal(permission.requiresControllerFieldEmpty, true);
  assert.equal(predicate.type, ACTIVATION_RESPONSE_PREDICATES.CARD_EFFECT_ACTIVATED_FROM_ZONE);
  assert.deepEqual(predicate.zones, ["HAND", "GRAVEYARD", "BANISHED"]);
  assert.equal(predicate.actorRelation, "OPPONENT");
  assert.equal(predicate.requiresNormalSummonedSource, true);
});

test("a Trap activated from hand creates a field activation event and misses a hand-zone response", () => {
  const result = analyzeActivationEventStateTransition(fixture());
  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.activation, "illegal");
  assert.match(result.shortAnswer, /不能连锁发动/u);
  assert.match(result.shortAnswer, /先按.*卡的发动手续.*魔法与陷阱区域/u);
  assert.match(result.shortAnswer, /只对应手牌・墓地・除外状态中的卡的效果发动的条件/u);
  assert.equal(result.program.activationEvent.originZoneAtDeclaration, "HAND");
  assert.equal(result.program.activationEvent.activationZone, "SPELL_TRAP_ZONE");
  assert.equal(result.program.responseDecision.matches, false);
  assert.equal(result.program.responseDecision.originZoneIgnoredForResponse, true);
});

test("the high-level activation-event compiler is invariant under complete card renaming", () => {
  const first = analyzeActivationEventStateTransition(fixture("棱镜"));
  const second = analyzeActivationEventStateTransition(fixture("星河"));
  for (const result of [first, second]) {
    assert.equal(result.status, "resolved", JSON.stringify(result));
    assert.equal(result.program.type, "compiled_activation_event_response");
    assert.equal(result.program.responseDecision.matches, false);
    assert.equal(result.program.activationEvent.activationZone, "SPELL_TRAP_ZONE");
  }
  assert.doesNotMatch(JSON.stringify(first), /颉颃|天下独步|拮抗勝負/u);
});

test("the reported wording executes the same generic card-activation procedure", () => {
  const result = analyzeActivationEventStateTransition({
    userQuery: "对方场上通常召唤的「天下独步的大义贼（天下独歩の大義賊）」存在。自己场上没有卡，在战斗阶段结束时从手牌发动「颉颃胜负」。对方可以直接连锁发动「天下独步的大义贼（天下独歩の大義賊）」的①效果吗？",
    resolvedCards: [
      { id: "13293", name: "颉颃胜负", jaName: "拮抗勝負", cardType: "trap" },
      { id: "23349", name: "天下独步的大义贼", jaName: "天下独歩の大義賊", cardType: "monster" },
    ],
    cardTexts: [
      {
        id: "card-text-13293",
        cards: ["颉颃胜负", "拮抗勝負"],
        cardType: "trap",
        text: "自己场上不存在卡的情况下，此卡也可从手牌发动。①：对手场上的卡多于自己场上的卡的情况下，在战斗阶段结束时可以发动。对手将自身场上的卡以里侧表示除外。",
      },
      {
        id: "card-text-23349",
        cards: ["天下独步的大义贼", "天下独歩の大義賊"],
        cardType: "monster",
        text: "①：此卡通常召唤的情况下，对方发动手牌・墓地・除外状态的卡的效果时可以发动。那个效果无效并破坏。",
      },
    ],
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.activation, "illegal");
  assert.match(result.shortAnswer, /不能连锁发动「天下独步的大义贼」/u);
});

test("a monster effect really activated in the hand positively matches the same predicate", () => {
  const event = createEffectActivationEvent({
    player: "self",
    sourceInstanceId: "hand-monster#1",
    sourceDefinitionId: "hand-monster",
    sourceCardType: "monster",
    activationZone: "HAND",
    effectId: "hand-monster:1",
  });
  const decision = evaluateActivationResponsePredicate({
    activationEvent: event,
    responderPlayer: "opponent",
    predicate: {
      type: ACTIVATION_RESPONSE_PREDICATES.CARD_EFFECT_ACTIVATED_FROM_ZONE,
      actorRelation: "OPPONENT",
      zones: ["HAND", "GRAVEYARD", "BANISHED"],
    },
  });
  assert.equal(decision.status, "DECIDED");
  assert.equal(decision.matches, true);
});

test("missing the field-empty fact fails closed instead of assuming hand activation permission", () => {
  const result = analyzeActivationEventStateTransition(fixture("缺失", { includeFieldEmpty: false }));
  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.reason, "activating_player_field_empty_state_unknown");
});

