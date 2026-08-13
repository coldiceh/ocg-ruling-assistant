import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDestinationReplacementOutput } from "../backend/effectStateReasoner.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

function replacementTimelineFixture() {
  const effectId = "rift-destination-replacement";
  const materialMoves = [
    {
      instanceId: "carrier#1",
      fromZone: "monster_zone",
      intendedToZone: "graveyard",
      actualToZone: "graveyard",
      cause: "fusion_material",
    },
    {
      instanceId: "material#1",
      fromZone: "monster_zone",
      intendedToZone: "graveyard",
      actualToZone: "graveyard",
      cause: "fusion_material",
    },
  ];
  return {
    status: "resolved",
    complete: true,
    activation: "legal",
    resolution: "performed",
    shortAnswer: "可以发动，cost进入墓地并进行融合召唤。",
    reasoning: ["旧的固定目的地表述。"],
    program: {
      initialState: {
        cards: [
          { instanceId: "cost#1", name: "曙光手牌", zone: "hand" },
          { instanceId: "carrier#1", name: "裂隙守卫", zone: "monster_zone" },
          { instanceId: "material#1", name: "余烬素材", zone: "monster_zone" },
          { instanceId: "fusion#1", name: "辉光融合体", zone: "extra_deck" },
        ],
      },
      finalState: {
        cards: [
          { instanceId: "cost#1", name: "曙光手牌", zone: "banished" },
          { instanceId: "carrier#1", name: "裂隙守卫", zone: "graveyard" },
          { instanceId: "material#1", name: "余烬素材", zone: "graveyard" },
          { instanceId: "fusion#1", name: "辉光融合体", zone: "monster_zone" },
        ],
      },
      cardPrograms: [{
        definitionId: "carrier",
        continuousEffects: [{ id: effectId, sourceInstanceId: "carrier#1" }],
      }],
    },
    trace: [
      { phase: "activation_check", status: "legal", conclusion: "发动条件满足。" },
      {
        phase: "pay_activation_cost",
        status: "applied",
        conclusion: "作为 cost 送入墓地。",
        proof: [{
          type: "discard_from_hand",
          moves: [{
            instanceId: "cost#1",
            fromZone: "hand",
            intendedToZone: "graveyard",
            actualToZone: "banished",
            replacementEffectId: effectId,
            replacementSourceInstanceId: "carrier#1",
          }],
        }],
      },
      {
        phase: "resolve_effect_operation",
        status: "performed",
        conclusion: "进行融合召唤。",
        proof: {
          type: "fusion_summon",
          status: "performed",
          candidateInstanceId: "fusion#1",
          assignment: [
            { instanceId: "carrier#1", name: "裂隙守卫" },
            { instanceId: "material#1", name: "余烬素材" },
          ],
          materialMoves,
          suppressedDestinationReplacementEffectIds: [effectId],
        },
      },
    ],
  };
}

test("generic output separates replaced activation cost from the simultaneous material batch", () => {
  const result = normalizeDestinationReplacementOutput(replacementTimelineFixture());

  assert.match(result.shortAnswer, /^可以发动/u);
  assert.match(result.shortAnswer, /曙光手牌.*原本应送去墓地.*实际除外/u);
  assert.match(result.shortAnswer, /同一批融合素材移动/u);
  assert.match(result.shortAnswer, /裂隙守卫.*同一批离开/u);
  assert.match(result.shortAnswer, /这些素材均按原定去向送去墓地/u);
  assert.match(result.shortAnswer, /进行融合召唤「辉光融合体」/u);
  assert.doesNotMatch(result.shortAnswer, /曙光手牌.*进入墓地/u);
  assert.equal(result.destinationReplacementTimeline.activationCost[0].actualToZone, "banished");
  assert.equal(result.destinationReplacementTimeline.resolutionMaterialBatch.simultaneous, true);
  assert.deepEqual(
    result.destinationReplacementTimeline.resolutionMaterialBatch.moves.map((move) => move.actualToZone),
    ["graveyard", "graveyard"],
  );
});

test("public prompts keep raw card evidence without a handwritten state-execution procedure", () => {
  const card = {
    id: "anonymous-fusion-spell",
    name: "匿名融合术",
    effectText: "舍弃1张手牌发动。将自己场上的怪兽作为融合素材进行融合召唤。",
  };
  const bundle = buildRagRulingPromptBundle({
    userQuery: "这个效果能否发动，代价与同批素材分别去哪里？",
    cardResolution: { resolvedCards: [card] },
    evidence: {
      cardTexts: [{
        id: "card-text-anonymous-fusion-spell",
        type: "card_text",
        title: "匿名融合术 的卡片文本",
        cards: [card.name],
        text: card.effectText,
      }],
    },
  });

  for (const prompt of [bundle.prompt, bundle.recoveryPrompt]) {
    assert.match(prompt, /代价与同批素材分别去哪里/u);
    assert.match(prompt, /card-text-anonymous-fusion-spell/u);
    assert.match(prompt, /舍弃1张手牌发动/u);
    assert.doesNotMatch(prompt, /通用(?:状态)?执行顺序/u);
    assert.doesNotMatch(prompt, /持续效果重算|重算持续效果/u);
    assert.doesNotMatch(prompt, /诱发检查点|收集诱发候选/u);
    assert.doesNotMatch(prompt, /移动归因|实际移动及归因/u);
  }
});
