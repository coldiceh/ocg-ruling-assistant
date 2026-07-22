import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDuelStateTransition } from "../backend/duelStateReasoner.mjs";

const quotaText = "①：只要此卡存在于魔法与陷阱区域，双方场上各只可有１只同种族怪兽以表侧表示存在。双方玩家自身场上有２只以上同种族怪兽存在的情况下，必须将怪兽送至墓地，直至同种族怪兽只有１只为止。";
const meteorText = "①：可以发动。将自己・对方场上的表侧表示怪兽尽可能解放，从手牌将此卡特殊召唤。然后，将1只“陨星衍生物”（岩石族・光・星11）特殊召唤至对手场上。";

function genericCards() {
  return [{
    id: "quota",
    name: "物种配额",
    cardType: "trap",
    effectText: quotaText,
  }, {
    id: "meteor",
    name: "陨星巨灵",
    cardType: "monster",
    race: "岩石族",
    effectText: meteorText,
  }];
}

test("generic preflight blocks a mandatory opponent summon under a per-player race limit", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "对方怪兽区域存在表侧表示的岩石族怪兽，并且「物种配额」的效果正在适用。自己可以发动手牌中的「陨星巨灵」的效果吗？",
    resolvedCards: genericCards(),
  });

  assert.equal(result.status, "resolved", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.activation, "cannot_activate");
  assert.equal(result.resolution, "not_started");
  assert.match(result.shortAnswer, /不能发动/u);
  assert.match(result.shortAnswer, /不能先假定效果处理中的解放/u);
  const preflight = result.program.compiledChainLinks[0].activationPreconditions[0];
  assert.equal(preflight.reason, "mandatory_special_summon_conflicts_with_active_per_player_race_limit");
  assert.equal(preflight.conflicts[0].player, "opponent");
});

test("an either-side race fact is definite when mandatory outputs summon that race to both players", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "自己或对方的怪兽区域存在表侧表示的岩石族怪兽，并且「物种配额」效果正在适用。自己能发动手牌中的「陨星巨灵」效果吗？",
    resolvedCards: genericCards(),
  });

  assert.equal(result.activation, "cannot_activate", JSON.stringify(result));
  const conflict = result.program.compiledChainLinks[0].activationPreconditions[0].conflicts[0];
  assert.equal(conflict.player, "either");
  assert.deepEqual(new Set(conflict.outputIds), new Set(["special-summon-effect-source", "special-summon-generated-monster"]));
});

test("real card texts use the same generic activation preflight without card-name rules", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "自己或对方的怪兽区域存在表侧表示的岩石族怪兽，并且「千察万别」的以下效果正在适用。自己可以发动手牌中的「原始生命态 尼比鲁」的怪兽效果吗？",
    resolvedCards: [{
      id: "13447",
      name: "千察万别",
      cardType: "trap",
      effectText: quotaText,
    }, {
      id: "14741",
      name: "原始生命态 尼比鲁",
      cardType: "monster",
      race: "Rock",
      effectText: "此卡名的效果1回合仅可使用1次。\n①：在对手召唤・特殊召唤过5只以上怪兽的自己・对手回合的主要阶段可以发动。将自己・对手场上的表侧表示怪兽尽可能地解放，从手牌将此卡特殊召唤。然后，将1只“原始生命态衍生物”（岩石族・光・星11・攻/守？）特殊召唤至对手场上。",
    }],
  });

  assert.equal(result.activation, "cannot_activate", JSON.stringify(result));
  assert.doesNotMatch(result.shortAnswer, /可以发动/u);
});

test("the restriction preflight does not invent a conflict for a different existing race", () => {
  const result = analyzeDuelStateTransition({
    userQuery: "对方怪兽区域存在表侧表示的龙族怪兽，并且「物种配额」效果正在适用。自己能发动手牌中的「陨星巨灵」效果吗？",
    resolvedCards: genericCards(),
  });

  assert.notEqual(result.activation, "cannot_activate");
});
