import assert from "node:assert/strict";
import test from "node:test";

import {
  autoEngineSimulationEnabled,
  buildBestEffortEngineScenario,
} from "../backend/ocgScenarioPlanner.mjs";

const cards = [
  {
    input: "冰剑龙 幻冰龙",
    name: "冰剑龙 镜翠幻种",
    passcode: "11111111",
    cardType: "monster",
    aliases: ["冰剑龙 幻冰龙"],
  },
  {
    input: "教导的圣女 艾克莉西亚",
    name: "教导之圣女 艾克利西亚",
    passcode: "22222222",
    cardType: "monster",
  },
  {
    input: "阿不思的落胤",
    name: "阿尔白斯之落胤",
    passcode: "33333333",
    cardType: "monster",
  },
  {
    input: "吞食圣痕之龙",
    name: "吞喰圣痕之龙",
    passcode: "44444444",
    cardType: "monster",
  },
];

test("best_effort_engine_scenario_places_cards_and_plans_albaz_flow", () => {
  const question = [
    "我方额外卡组有冰剑龙 幻冰龙，手牌有教导的圣女 艾克莉西亚和阿不思的落胤各1张。",
    "对方场上只有表侧表示的吞食圣痕之龙1只。",
    "我召唤阿不思的落胤后，可以舍弃教导的圣女 艾克莉西亚发动效果并融合召唤冰剑龙 幻冰龙吗？",
  ].join("");
  const result = buildBestEffortEngineScenario({ userQuery: question, cards });

  assert.equal(result.source, "auto_best_effort");
  assert.equal(result.scenario.bestEffort, true);
  assert.equal(result.planSummary.cardCount, 4);
  assert.equal(result.planSummary.cards.find((card) => card.code === 11111111).location, "extra_deck");
  assert.equal(result.planSummary.cards.find((card) => card.code === 22222222).location, "hand");
  assert.equal(result.planSummary.cards.find((card) => card.code === 33333333).location, "hand");
  assert.equal(result.planSummary.cards.find((card) => card.code === 44444444).team, 1);
  assert.equal(result.planSummary.cards.find((card) => card.code === 44444444).location, "monster_zone");
  assert.deepEqual(result.scenario.responses[0], {
    encoding: "idle_command",
    action: "summon",
    cardCode: 33333333,
  });
  assert.ok(result.scenario.responses.some((response) =>
    response.encoding === "card_selection" && response.cardCodes?.includes(22222222)
  ));
});

test("best_effort_engine_scenario_distinguishes_effect_source_target_and_opponent_chain", () => {
  const question = "对方场上有绚岚之达维，我方以绚岚之达维为对象发动无限泡影，对方能不能发动天雷之双风神的效果？";
  const result = buildBestEffortEngineScenario({
    userQuery: question,
    cards: [
      { input: "绚岚之达维", name: "绚岚之达维", passcode: "55555555", cardType: "monster" },
      { input: "无限泡影", name: "无限泡影", passcode: "66666666", cardType: "trap" },
      { input: "天雷之双风神", name: "天雷之双风神 息那", passcode: "77777777", cardType: "monster" },
    ],
  });

  assert.equal(result.scenario.responses[0].cardCode, 66666666);
  assert.ok(result.scenario.responses.some((response) =>
    response.encoding === "card_selection" && response.cardCodes?.[0] === 55555555
  ));
  assert.ok(result.scenario.responses.some((response) =>
    response.encoding === "chain" && response.cardCode === 77777777
  ));
});

test("automatic_engine_simulation_can_be_disabled", () => {
  assert.equal(autoEngineSimulationEnabled({}), false);
  assert.equal(autoEngineSimulationEnabled({ OCG_ENGINE_URL: "http://127.0.0.1:8790" }), true);
  assert.equal(autoEngineSimulationEnabled({
    OCG_ENGINE_URL: "http://127.0.0.1:8790",
    RAG_AUTO_ENGINE_SIMULATION: "false",
  }), false);
});
